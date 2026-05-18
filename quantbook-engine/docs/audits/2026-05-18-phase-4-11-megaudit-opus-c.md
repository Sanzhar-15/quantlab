# Phase 4.11 megaudit — Opus-C findings (architecture / maintainability / v2 readiness)

Scope: architecture, module structure, technical debt, v2 upgrade-path, public API stability, documentation correctness, test architecture, cross-crate boundary discipline, build-time concerns. Out of scope (covered by other auditors): OOXML schema details (Codex), round-trip invariants (Opus-A), adversarial inputs (Opus-B), audit-trail integrity (self).

Repo: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`. Branch `feat/quantbook-engine` HEAD `f941195608b`. 14 source modules, 7385 total LOC in `crates/ql-io-xlsx/` (including 1531 LOC of tests).

---

## v2 readiness assessment (TL;DR)

**Phase 4.11 should ship.** v1 is structurally honest: features it can't preserve are surfaced via `dropped_features` rather than silently lost, and the v2 deferral set (rels-graph merge for sheet-anchored parts, sheet-inline-anchor merge, `xfId/cellStyleXfs` preservation) is well-defined and tracked. The current `PartAction` enum and the post-process zip walk in `umya_export::post_process_zip` are the right shape to extend.

However, v2 will be painful unless three architectural smells are paid down first: (a) a fast-growing **substring-XML-mutation post-process layer** (W5-D-14.1+) that is now load-bearing for date1904, definedNames, custom numFmts, cellXfs, tableParts, sheet rels, Content_Types overrides, and per-cell `s="N"` injection — see HIGH-2; (b) **`XlsxPreservation.known_parts` is dead** (declared `pub`, never populated, never read) — see HIGH-3; (c) **three independent A1 parsers** plus three different `Event::Start`/`Empty` patterns across XML modules — small but compounding (see MEDIUM-1, MEDIUM-2). None block shipping; all should land before the v2 rels-merge work because v2 will touch the same modules.

---

## HIGH

### HIGH-1 — Post-process substring-mutation is becoming the de facto export pipeline; not sustainable for v2

`write/umya_export.rs::post_process_zip` (function starts at L343) is the second pass over the umya-generated zip. As of W5-D-15.2 it patches eight different parts via string-find/replace:

- `xl/workbook.xml`: inject `date1904`, inject `<definedNames>`.
- `xl/styles.xml`: inject `<numFmts>`, replace `<cellXfs>`.
- `xl/worksheets/sheet{N}.xml`: per-cell `t="str"` removal, error sigil rewrite, `s="N"` injection, fresh `<c r="…" s="N"/>` element synthesis into the right `<row>`, inject `<tableParts>`.
- `xl/worksheets/_rels/sheet{N}.xml.rels`: inject `<Relationship>` entries.
- `xl/tables/table{N}.xml`: new parts from scratch.
- `[Content_Types].xml`: inject `<Override>`.
- Fresh sheet rels files generated from scratch when no umya rels exist.

There are 18 separate `text.find` / `text.replace` / `text.rfind` calls. Each mutation pattern has its own custom edge-case handling (self-closing vs long-form tag, ordering of `</tag>`-first-then-`/>`-fallback, etc.). Several have already shipped real bugs caught in audits:
- W5-D-14.2.3 M-1 closure (numFmts/definedNames/tableParts close-form ordering)
- W5-D-15.2 H-1/H-5 (`<c>` element synthesis for value-less styled cells)
- W5-D-15.1 H-2 (`cellXfs`/`<xf>` Start-vs-Empty event handling)

This works for v1, but v2 will require: merging the original's `<conditionalFormatting>`, `<dataValidations>`, `<mergeCells>`, `<hyperlinks>` INTO the shadow's worksheet xml; merging the original's sheet rels with the shadow's; merging the original's `<Override>` entries semantically. Each is a non-trivial XML-tree operation that substring-find/replace cannot do correctly (these elements have ordered siblings, nested children, and namespace-prefix variations).

**Recommendation:** introduce a typed `worksheet_xml_patch::Patcher` (or quick-xml stream-rewriter) BEFORE v2 starts. The current `post_process_zip` should become its first consumer. Otherwise v2 will either land another four `text.find` mutations (compounding the brittleness) or a parallel mini-parser will fork from the existing one.

**Severity:** HIGH because the v2 inline-anchor merge is the largest planned chunk of work and the current pattern doesn't scale. Not a ship-blocker; explicitly tracked at `write/update_original.rs:18-23`.

### HIGH-2 — `XlsxPreservation.known_parts` is dead code in the public API

`crates/ql-io-xlsx/src/model.rs:28`:
```rust
pub struct XlsxPreservation {
    pub original_bytes: Vec<u8>,
    pub known_parts: HashMap<String, Vec<u8>>,
}
```

Production code populates `known_parts` exactly ZERO times. The two construction sites in `lib.rs:279` and `lib.rs:368` both use `HashMap::new()`. The two test sites do likewise. NO read site exists anywhere in the crate — `grep -rn "preservation.known_parts" crates/ql-io-xlsx/` returns nothing.

The field is `pub`, so we've committed the shape to callers. The module doc at `model.rs:13-14` claims "the actual fields are filled in by the W5-D-14 implementation"; that never happened. Phase 4.11 instead reads `source.original_bytes` directly in `update_original.rs` and re-parses on demand.

**Action:** either (a) `#[deprecated]` the field for the 0.x → 1.0 window and remove it next major; or (b) actually populate it (the read pipeline could stash decompressed parts to avoid the re-parse in UpdateOriginal). My preference is (a): the re-parse is cheap, and an exposed-but-empty HashMap is a footgun for downstream callers who'll assume it carries data.

**Severity:** HIGH because it's already in the public API. Trapped now means breaking later.

### HIGH-3 — `XlsxError::Reconciliation` is declared but never constructed

`crates/ql-io-xlsx/src/error.rs:71-75` declares a `Reconciliation { message: String }` variant intended for "hybrid-reader disagreement between calamine and OOXML scanner". `grep -rn "Reconciliation" crates/ql-io-xlsx/src/` returns ONLY the declaration. The hybrid reader's reconciliation step described in `calamine_grid.rs:60-62` ("the OOXML view authoritative ... reconciliation step (W5-D-14 follow-up)") never landed; calamine's sheet order is now used unchanged (`convert.rs:33`).

The variant is dead. Either implement the reconciliation pass or remove the variant. With it present in `XlsxError`, callers writing exhaustive matches must handle a case that can never happen — a real maintainability tax.

**Severity:** HIGH because the public enum is a stability surface.

---

## MEDIUM

### MEDIUM-1 — Three independent A1 cell parsers + a separate column-letter emitter

- `read/cell_styles_xml.rs:80` — `fn parse_a1_cell(text: &str) -> Option<(RowId, ColId)>`
- `read/tables_xml.rs:223` — `fn parse_a1_cell(s: &str) -> Option<(RowId, ColId)>` (slightly different impl using `chars().collect()`)
- `read/names_import.rs:168` — `fn parse_abs_cell(text: &str) -> Option<(RowId, ColId)>` (strips `$` first)
- `write/umya_export.rs:55` — `fn cell_ref_a1(row, col) -> String` (emit) + `fn col_letter(col) -> String` (L993, duplicates the same algorithm) + `fn parse_row_number_from_ref` (L615, partial parser)

All three readers implement the same bijective base-26 letter → column conversion with subtle variations (cell_styles_xml uses `chars()`, tables_xml uses `Vec<char>`, names_import strips `$` first). The shared logic is six lines of code that could live in a single `crate::a1` module. Today, fixing a parser bug (e.g. unicode handling, overflow on XFD+ columns) requires identifying which module(s) are affected.

**Recommendation:** lift to `crates/ql-types/src/address.rs` or a new `crates/ql-io-xlsx/src/a1.rs`. `ql_types::Address` already exists; an `Address::parse_a1(&str)` constructor is the natural home.

### MEDIUM-2 — `Event::Start` vs `Event::Empty` handling is inconsistent across read modules

Each XML parser handles self-closing vs non-self-closing elements differently:

- `read/rels.rs:73`: `Event::Empty(e) | Event::Start(e) =>` (combined, both attribute-only)
- `read/tables_xml.rs:89`: `Event::Start(e) | Event::Empty(e) =>` (combined, both attribute-only)
- `read/cell_styles_xml.rs:40`: `Event::Start(e) | Event::Empty(e) =>` (combined)
- `read/workbook_xml.rs:125, 149`: SEPARATE `Empty` and `Start` arms — `<workbookPr>` and `<sheet>` handled in BOTH arms with copy-pasted attribute extraction
- `read/styles_xml.rs:115, 131`: SEPARATE arms (because of the stack-tracking requirement for `<xf>` inside `<cellXfs>` vs `<cellStyleXfs>`)

W5-D-15.1 H-2 closure caught a real bug here: `read/styles_xml.rs` previously only matched `<xf>` as `Event::Empty`, dropping LibreOffice's long-form `<xf>...</xf>` elements. The stack-element design works but the duplicated attribute parsing is fragile — `workbook_xml.rs` extracts the same `date1904`/`r:id`/etc. attributes in both arms.

**Recommendation:** standardize on `parse_*_attrs(e: &BytesStart)` helpers callable from both arms (the styles_xml/workbook_xml pattern). Encode the convention in a one-line `read/mod.rs` doc note.

### MEDIUM-3 — `umya_export.rs` is 1495 LOC; should split

The module mixes seven distinct concerns:

1. Cell iteration + value/formula application (L67-265)
2. `CellFix` post-process scheduling (L23-52, L160-264)
3. `post_process_zip` orchestration (L343-447)
4. Per-part XML mutators: `apply_cell_fixes_to_sheet_xml`, `inject_date1904_into_workbook_xml`, `inject_custom_formats_into_styles_xml`, `inject_cell_xfs_into_styles_xml`, `inject_defined_names_into_workbook_xml` (L459-1068)
5. `DefinedNameOut` collection + rendering (L832-1002)
6. Table export collection + rendering (L1087-1404)
7. XML escape utilities + col_letter (L1072-1085, L993)

A reasonable split would be:
- `write/umya_cells.rs` — concerns (1) + (2)
- `write/umya_post_process.rs` — concerns (3) + (4)
- `write/umya_names.rs` — concern (5)
- `write/umya_tables.rs` — concern (6)
- `write/xml_text.rs` — concern (7) plus the M-1 closing-tag-first idiom from `inject_custom_formats_into_styles_xml`/`inject_cell_xfs_into_styles_xml`/`inject_defined_names_into_workbook_xml`/`inject_table_parts_into_sheet_xml` (currently duplicated four times)

**Severity:** MEDIUM because v2 will add 2-3 more `inject_*` mutators (mergeCells, conditionalFormatting, dataValidations). The split helps before, not after.

### MEDIUM-4 — Doc claim about `rust_xlsxwriter` is stale

`lib.rs:25-27`:
> ## Write: `umya-spreadsheet` (`UpdateOriginal`) + later `rust_xlsxwriter` (`NewWorkbook`)

`Cargo.toml:19`:
> rust_xlsxwriter for `NewWorkbook` mode lands later.

`options.rs:111`:
> Matches `rust_xlsxwriter`'s default behavior.

In reality, `NewWorkbook` mode is now backed by umya-spreadsheet (`lib.rs:298-326`, `write/umya_export.rs`). `rust_xlsxwriter` is not a dependency and no module-stub references it. The original Phase 4.11 architecture had a 2-backend split; Phase 4.11 collapsed onto umya for both modes. The docs were not refreshed.

**Recommendation:** either reintroduce the `rust_xlsxwriter` backend (an actual product decision) or update the docs to reflect that umya is the single writer backend.

### MEDIUM-5 — Substring `iterate_simple_self_closing` in `update_original.rs` re-parses Content_Types

`update_original.rs:475-525` introduces a custom `iterate_simple_self_closing` parser for `[Content_Types].xml` `<Override>` / `<Default>` elements. The XML primitives (quick-xml) are already a dependency. The custom impl handles attribute-quote variants by `.find("\"")` and bounds boundaries with `.find("/>")`, with comments explicitly acknowledging "Conservative parser: doesn't handle nested elements or non-self-closing forms".

This is fine for v1 (Content_Types overrides ARE always self-closing per OOXML spec). But for v2 where we'll need to merge worksheet inline elements with namespaced children, the same shortcut won't work — the lesson should be captured before someone tries to reuse `iterate_simple_self_closing` on richer XML.

**Recommendation:** replace with a quick-xml-based `parse_content_types_overrides` returning `Vec<(part_name, raw_xml)>` so the code path is consistent with the rest of the read pipeline.

### MEDIUM-6 — `XlsxError::Engine(String)` is too lossy; loses context

`error.rs:84-85`:
```rust
#[error("xlsx engine integration error: {0}")]
Engine(String),
```

The single call site at `lib.rs:258-267` packs sheet/row/col/formula/reason into a single formatted string. A caller that wants to programmatically inspect strict-mode failures (e.g., to surface them in a UI) must regex-parse the string.

Plus the deeper issue: `Engine` is also the formula-recompute-failure variant (per its only construction site), but the name suggests a generic engine error. A more typed shape:

```rust
StrictRecomputeFailure {
    failure_count: usize,
    first: FormulaImportFailure,
}
```

would make caller-side handling structural and the error string would still be readable via `Display`.

### MEDIUM-7 — Module docs carry W5-D-XX commit tags that read as partial history

Every module starts with a `//! **W5-D-X.Y (audit HIGH-Z closure):**` reference. Examples:

- `read/cell_styles_xml.rs:3-5`: "W5-D-15 (Phase 4.11 XLSX-4-03 closure — per-cell format application)"
- `read/sheet_parts.rs:3-16`: "W5-D-14.1 (audit HIGH-9 closure)" — long explanation of what the PRIOR code did wrong, not what the current code DOES
- `read/styles_xml.rs:32-38`: still refers to W5-D-14d as the "current commit"

The W5-D-X tags are excellent for audit-trail reading but make the docs read as a changelog. A NEW reader of the module has to mentally peel back successive `**HIGH-N closure**` mentions to understand what the module's responsibility actually is. `read/sheet_parts.rs` is the clearest example — most of its module doc is about the prior wrong heuristic.

**Recommendation:** for each module, keep a one-paragraph "responsibility today" up top, then a "history" subsection underneath. The latter is essentially what we have now.

---

## LOW

### LOW-1 — `#[allow(dead_code)]` annotations indicate fields parsed but never read

Nine `#[allow(dead_code)]` annotations across:
- `read/styles_xml.rs:48, 62, 76` — `StyleIndex`, `NumFmtEntry`, `CellXf` fields (some used, some not — would benefit from precise per-field allows)
- `read/workbook_xml.rs:25, 41, 74` — `WorkbookProperties.sheets[].sheet_id`, `r_id`, `state` (sheet_id and state never consumed)
- `read/rels.rs:30` — entire `Relationship` struct (`rel_type` used, others gated)
- `read/tables_xml.rs:34` — `ParsedTable.id` field
- `write/update_original.rs:244` — `PartAction::OwnedByShadow` (never constructed)

`SheetMeta.state` (`Visible`/`Hidden`/`VeryHidden`) is parsed; sheet visibility never propagates into the workbook. If the engine adds `Sheet::visibility()` storage later, the import will need an update — currently the data is read and dropped.

**Severity:** LOW; field-level rather than crate-level concerns.

### LOW-2 — `cell_styles_xml.rs` doc-comment date is mid-batch

`read/cell_styles_xml.rs:3-5` claims "W5-D-15 (Phase 4.11 XLSX-4-03 closure — per-cell format application)", but the module was later modified in W5-D-15.1/W5-D-15.2 for LibreOffice compatibility. The header attribution is the original commit, not the most-recent author of behavior.

This is the same MEDIUM-7 pattern at higher granularity. Decision: either keep the docs as "first-landed" lineage (acceptable if consistent) or update each batch (also acceptable).

### LOW-3 — Test corpus probe is `#[ignore]`'d and tracks 177 fixtures — should be CI-tagged

`tests/phase_4_11_corpus_probe.rs` is the empirical basis for the megaudit (177-fixture round-trip). It's `#[ignore]` so it doesn't run in normal `cargo test`. The reasonable cadence is nightly or PR-on-xlsx-touch.

Today there's no scheduling mechanism. The CI signal "all 177 fixtures round-trip with counts-equivalent" would catch regressions like W5-D-15.1's empty-sheet misalignment in seconds.

**Recommendation:** add a Cargo feature `corpus-probe` or wire it into `--include-ignored` in CI on the `xlsx-` PR label.

### LOW-4 — Tests in `tests/calamine_smoke.rs` (28 of them) lack categorization

The 28 E2E tests are interleaved by feature (date1904, custom format, table, scoped name, UpdateOriginal, format overlay, etc.) with W5-D-X commit tags as their only grouping signal. A maintainer trying to find "all tests covering tables" has to grep by W5-D-14.2 in test names — fine for now, brittle as tests accumulate.

**Recommendation:** introduce `mod table_roundtrip { ... }` / `mod format_overlay { ... }` / `mod update_original { ... }` submodules inside the test file. No behavior change; pure organization.

### LOW-5 — Dep graph has 3 versions of `zip` (0.6.6 / 2.4.2 / 7.2.0) and 3 of `quick-xml` (0.36.2 / 0.37.5 / 0.39.4)

`cargo tree`-equivalent shows:
- `zip 0.6.6` (our pinning) — read pipeline + update_original
- `zip 2.4.2` (one of our other deps pulls it)
- `zip 7.2.0` (another transitive)
- `quick-xml 0.36.2` (ours)
- `quick-xml 0.37.5` (umya-spreadsheet's)
- `quick-xml 0.39.4` (another transitive)

Three implementations of zip + xml in the same binary. Build-time and binary-size cost is real. The `zip 0.6.6` pin is intentional (umya 2.2.0 wants compatibility), but `zip 7.2.0` is jarring — the major-version jump is recent and our other deps haven't aligned.

**Recommendation:** lock `zip` to one version in the workspace `[patch.crates-io]` table once Phase 4.11 ships; same for quick-xml. Low priority; not a correctness issue.

### LOW-6 — Test module count zero — all 60 unit tests live in `#[cfg(test)]` blocks at module bottoms

`grep -c "#\[test\]"` per module: every test is in a `mod tests { ... }` block at the bottom of the source file. No standalone test files inside `crates/ql-io-xlsx/src/`. This is idiomatic Rust; flagged ONLY because the auditor brief asked for "60 unit tests across the crate — coverage gaps?". None of the 14 read/write modules have zero tests; the smallest is `read/sheet_parts.rs` (2 tests for the rels-path derivation helper). Coverage is dense for parsers, lighter for orchestrators (`tables_import.rs` and `update_original.rs` rely on the E2E suite for coverage).

The orchestrator-level gap is real: `update_original.rs` has ZERO unit tests in its `#[cfg(test)]` block. Every assertion lives in `tests/calamine_smoke.rs` E2E. Acceptable today (the unit-testable pieces are the small substring parsers), but if the v2 rels-merge work adds branching logic, in-module tests will help.

### LOW-7 — Cross-crate boundary: ql-io-xlsx reaches only public types of ql-storage, ql-types, ql-functions — clean

Audit grep shows every `ql_storage::` / `ql_types::` / `ql_exec::` reference resolves to a published symbol (`Workbook`, `FormatId`, `FormatTable`, `NamedTarget`, `TableMetadata`, `TableColumn`, `TotalsFunction`, `SheetId`, `Value`, `DateSystem`, `MAX_ROW`, `MAX_COLUMN`, `WorkbookRuntime`, `FunctionRegistry`, `default_registry`). No `pub(crate)` reach-ins. Boundary discipline is good. No cycles. `ql-io-xlsx` is leaf-ish — only `ql-exec` (via the recompute pipeline) pulls in any heavy engine machinery.

### LOW-8 — `lib.rs` import body is doing too much

`pub fn import_xlsx_bytes` at `lib.rs:112-290` is 178 lines. It orchestrates 12 distinct phases (W5-D-14b Phase 0 → Phase 4) inline. While each phase is well-commented, the sequential dispatch is logic that doesn't belong at the public API layer — it should live in `read::pipeline::import` or similar so `lib.rs` reads as a thin facade.

**Recommendation:** extract a `read::pipeline` module mirroring the write side's `umya_export::export_new_workbook` + `post_process_zip` split. Defensible to leave as-is; the inline form is at least linear and well-annotated.

---

## Technical-debt severity ladder (sorted by impact-of-delay)

1. **`XlsxPreservation.known_parts` dead field** (HIGH-2) — public API drag; cheaper to fix before v1 ships than to deprecate later.
2. **Post-process substring-mutation layer** (HIGH-1) — every v2 inline-anchor merge will pay this cost; refactor before, not after.
3. **`XlsxError::Reconciliation` dead variant** (HIGH-3) — public enum stability concern; cheap to address now.
4. **`rust_xlsxwriter` doc claim** (MEDIUM-4) — caller-visible. Decision needed: actually add the backend, or remove the claim.
5. **A1 parser duplication** (MEDIUM-1) — purely internal; pay down opportunistically with any next address-handling change.
6. **`umya_export.rs` 1495-LOC monolith** (MEDIUM-3) — v2 will add 2-3 more `inject_*` mutators; better to split before that lands.
7. **Substring XML in `update_original.rs`** (MEDIUM-5) — works for v1, doesn't extend to richer XML in v2.
8. **Module docs as changelog** (MEDIUM-7 / LOW-2) — readability tax; refactor when touching the module.
9. **Test corpus probe not in CI** (LOW-3) — regression catch is a free win.
10. **Test file organization** (LOW-4) — only a nuisance as tests cross 50+.
11. **Dep duplication** (LOW-5) — binary-size only; not a correctness lever.

---

## Public API stability commitments

The crate has not yet committed to 1.0. **Before 1.0** the following are open for changes:

| Symbol | Recommendation |
|---|---|
| `XlsxImportResult` | Stable. Add `#[non_exhaustive]` so future report fields don't break callers. |
| `XlsxImportOptions` / `XlsxExportOptions` | Stable. `#[non_exhaustive]`. |
| `XlsxImportReport` / `XlsxExportReport` | Stable. `#[non_exhaustive]`. |
| `XlsxError` | **Refactor needed**: drop `Reconciliation` (dead) and split `Engine(String)` into `StrictRecomputeFailure { ... }` + a real generic engine variant. Mark `#[non_exhaustive]`. |
| `XlsxPreservation` | **Refactor needed**: drop `known_parts` field or populate it. Mark `#[non_exhaustive]`. |
| `FeatureInventory` | Stable. `#[non_exhaustive]`. |
| `UnsupportedFeatureKind` | Stable. `Other(&'static str)` is the catch-all. `#[non_exhaustive]`. |
| `RecomputeMode` / `UnsupportedPolicy` / `ExportMode` / `FormulaCachePolicy` | Stable. `#[non_exhaustive]`. |
| `FormulaImportFailure` / `UnsupportedFeature` / `XlsxWarning` | Stable. `#[non_exhaustive]`. |
| `import_xlsx_path` / `import_xlsx_bytes` / `export_xlsx_path` | Stable signatures. |

**Action item**: add `#[non_exhaustive]` to every pub struct/enum in this crate before tagging 0.2 or higher. This is one commit and prevents the most painful class of future SemVer breaks.

**Mark deprecated/internal**: nothing yet — all public types are intentional surface. Two are mis-shaped (`known_parts`, `Reconciliation`) and should change rather than gain `#[deprecated]`.

---

## Notes for parallel auditors

- HIGH-1 (post-process layer) overlaps with what Codex will see in OOXML schema land. My concern is **maintainability of the patcher**; Codex's concern will be **schema validity of the patched XML**. Both legitimate; the fixes converge.
- HIGH-2 / HIGH-3 (dead public API surface) are unlikely to surface in Opus-A's round-trip checks (the fields aren't read or written) or Opus-B's adversarial inputs (they don't take input). Lifting them here is the right home.
- MEDIUM-3 (umya_export size) overlaps with the test-organization recommendation Opus-A may surface. Different angle: I'm calling out the source module size; Opus-A is likely calling out test coverage shape.
- LOW-5 (dep duplication) is build-time only; not a v2 blocker.

---

## Relevant file paths

- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/lib.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/error.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/model.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/options.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/report.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/mod.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/cell_styles_xml.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/calamine_grid.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/sheet_parts.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/tables_xml.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/workbook_xml.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/names_import.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/rels.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/Cargo.toml`
