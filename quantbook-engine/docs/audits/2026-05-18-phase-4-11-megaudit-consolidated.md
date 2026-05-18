# Phase 4.11 megaudit — consolidated findings (5-way parallel)

**Date:** 2026-05-18
**Phase scope:** 11 commits W5-D-14a → W5-D-15.2 (`c0a496e3627` →
`f941195608b`).
**Auditors:** Codex (schema + corpus), Opus-A (round-trip invariants),
Opus-B (defensive / adversarial), Opus-C (architecture / v2 readiness),
self (meta + audit-trail).

This is the consolidated view. Per-auditor docs are at
`docs/audits/2026-05-18-phase-4-11-megaudit-{codex,opus-a,opus-b,opus-c,self}.md`.

## Top-line numbers

- Raw findings: **22 HIGH + 31 MEDIUM + 23 LOW = 76** across 5 audits.
- After dedup: **20 unique HIGH + ~27 MEDIUM + ~20 LOW**.
- Empirical corpus: **177 / 177 fixtures pass counts-equivalent round-trip**.
- Opus-A deep probes (cell-value / formula-text / overlay-mapping
  identity) caught **10.1 % cell divergence** (9 400 / 92 788 cells)
  — almost entirely Error-cached formula cells.

## HIGH findings — consolidated (post-dedup), severity-ranked

### Tier 1 — IMMEDIATE FIX (correctness + security ship-blockers)

#### H-CONS-1: Formula cells with `Value::Error` cached values round-trip as `Text(sigil)` instead of `Error(_)`

- Original sources: Codex HIGH-2, Opus-A HIGH-1.
- File: `crates/ql-io-xlsx/src/write/umya_export.rs` (cell-walk match
  arms ~L165-200, `RemoveStrType` + `OverrideErrorSigil` scheduling).
- What's wrong: the `RemoveStrType` post-process fix only fires for
  `Value::Number | Value::Boolean` (gate at L165). For
  `Value::Error`, the fix doesn't schedule. umya emits `<c
  r="A1" t="str"><f>FORMULA</f><v>#VALUE!</v></c>`. The
  `OverrideErrorSigil` needle (`<c r="A1" t="e"><v>#VALUE!</v>`)
  fails to match because the cell type is `str` not `e`. On
  re-import, calamine sees a string cell containing the sigil → maps
  to `Value::Text("#VALUE!")`.
- Empirical impact: **9 400 / 92 788 cells (10.1 %) of the corpus
  diverge** on round-trip. Mostly Error-cached formula cells.
- Fix sketch: schedule `OverrideErrorSigil` first when `Value::Error`,
  then schedule a dedicated `ConvertFormulaErrorCell` post-process
  that rewrites `t="str"` → `t="e"` AND the value to the actual
  sigil. Or: don't write the cached value for Error formulas (skip
  `apply_value_to_cell`); umya then emits `t="str"` but our existing
  removal patches that.

#### H-CONS-2: Boolean formula caches emitted as untyped `TRUE`/`FALSE` (text-like) instead of `<v>1</v>` with `t="b"`

- Original source: Codex HIGH-1.
- File: `crates/ql-io-xlsx/src/write/umya_export.rs` (boolean-value
  path).
- What's wrong: when a formula caches a `Value::Boolean(true)`, umya
  emits `<c r="A1" t="str"><f>...</f><v>TRUE</v></c>`. On re-import,
  calamine reads as text "TRUE". Excel native expects
  `<c r="A1" t="b"><f>...</f><v>1</v></c>`.
- Fix sketch: extend the formula-cell branch in the cell-walk to
  schedule a `ConvertFormulaBoolCell` post-process when the cached
  value is `Boolean(_)`: rewrite `t="str"` → `t="b"` and `<v>TRUE</v>`
  → `<v>1</v>` (or `<v>0</v>`).

#### H-CONS-3: Style-only blank cells can produce out-of-order `<row>` elements

- Original source: Codex HIGH-3.
- File: `crates/ql-io-xlsx/src/write/umya_export.rs:insert_style_only_cell`
  (W5-D-15.2 commit `f941195608b` — REGRESSION I introduced).
- What's wrong: when a blank cell with format overlay falls into the
  "synthesize fresh `<row r="K"><c r="A1" s="N"/></row>`" path
  (case 2 of `insert_style_only_cell`), the new row is appended
  before `</sheetData>` without regard to row-number ordering. If
  row K is less than any existing row, the result is non-sorted
  `<row>` siblings. OOXML schema requires row order ascending.
- Fix sketch: locate the insertion point inside `<sheetData>` by
  scanning for the first `<row r="L">` where `L > K` and inject
  BEFORE that row. Fall through to before `</sheetData>` only if
  no such row exists.

#### H-CONS-4: `numFmtId="4294967295"` (u32::MAX) panics the importer

- Original source: Opus-B HIGH-1.
- File: `crates/ql-storage/src/format.rs:153` (`register_at`).
- Path: attacker-controlled u32 from `xl/styles.xml` flows through
  `styles_import.rs:59`. `FormatTable::register_at` executes
  `self.next_custom_id = id.0 + 1` unconditionally → panic on debug
  / silent wrap on release.
- Fix sketch: `checked_add` in `register_at` returning
  `FormatTableError::InvalidId` for overflow; reject at the import
  boundary (`styles_import.rs:47`) for ids ≥ some sane ceiling
  (e.g., `u16::MAX as u32` since Excel's legal numFmtId ceiling is
  ~32 767).

#### H-CONS-5: Path-traversal via `rels` `Target` attributes — SECURITY

- Original source: Opus-B HIGH-3.
- File: `crates/ql-io-xlsx/src/read/rels.rs:resolve_rel_target`.
- What's wrong: a malicious xlsx with `<Relationship Target="../../../etc/passwd"/>`
  in `xl/_rels/workbook.xml.rels` causes `resolve_rel_target` to
  walk out of the package root. Currently used downstream in
  `sheet_parts::build_sheet_part_paths` to lookup zip entries.
  The zip itself can't reach `/etc/passwd`, but the returned path
  is used in part-name comparisons + error messages — opens path-
  confusion-style attacks if any caller ever writes to disk
  using these paths.
- Fix sketch: reject relative paths that escape the package root
  (`..` segments count > parent depth). Surface as `MalformedOoxml`.

#### H-CONS-6: Out-of-bounds cell refs in `format_overlay` (silently stored, round-tripped to corrupted output)

- Original sources: Opus-B HIGH-2, self M-6 (W5-D-15.2 deferred).
- File: `crates/ql-io-xlsx/src/lib.rs:197-212` per-cell-style apply +
  `crates/ql-io-xlsx/src/read/cell_styles_xml.rs:80-104`.
- What's wrong: `parse_a1_cell` accepts arbitrary letter counts; no
  bounds-check against MAX_ROW=1_048_575 / MAX_COLUMN=16_383. Overlay
  HashMap stores `<c r="XFE1" s="1"/>` (col 16384, past MAX_COLUMN)
  silently. Round-trip preserves the entry; output xlsx is invalid.
- Fix sketch: bounds-check in `parse_a1_cell` itself; reject refs
  exceeding the grid. Surface as warning in `report.warnings`.

#### H-CONS-7: Concurrent exports to the SAME output path race (3 / 4 corrupt)

- Original source: Opus-B HIGH-6.
- File: `crates/ql-io-xlsx/src/write/update_original.rs`
  (`sibling_tmp_path` + the final `std::fs::write(output_path, out_buf)`).
- What's wrong: the shadow tmp path is now unique per-call (W5-D-14.2.1
  H-1 closure), but the FINAL `fs::write(output_path, out_buf)` is a
  non-atomic single write. Concurrent exports to the same destination
  result in interleaved writes / one-wins-others-lost without error.
- Empirical: 3 of 4 concurrent calls produce corrupt output, no error
  returned.
- Fix sketch: write to a temp file in the output's parent then
  atomically `rename` over the destination (POSIX `rename` is atomic
  in the same filesystem).

#### H-CONS-8: OOM oracle — attacker-controlled `String::with_capacity` allocation

- Original source: Opus-B HIGH-5.
- File: multiple — `read::package` / `read::workbook_xml` /
  `read::styles_xml` (allocates from zip-reported sizes).
- What's wrong: `XlsxPackage::read_part_string` does
  `String::with_capacity(entry.size() as usize)` before reading.
  Attacker provides a zip with a falsely-declared 4 GiB entry → the
  importer pre-allocates 4 GiB → OOM.
- Fix sketch: cap pre-allocation at a sane ceiling (e.g., 64 MiB);
  fall through to streaming read for larger entries. OR: don't
  pre-allocate at all — `String::new()` + read_to_string grows
  dynamically and gets bounded by actual decompressed size.

### Tier 2 — SHIP-BEFORE-PHASE-4.12 (correctness gaps with smaller blast radius)

#### H-CONS-9: NUL bytes / control characters in sheet names accepted

- Source: Opus-B HIGH-4.
- File: `crates/ql-io-xlsx/src/read/workbook_xml.rs::parse_sheet_attrs`.
- What's wrong: a sheet named `"Sheet\x00Foo"` imports cleanly, exports
  via umya which emits the NUL into the xlsx, then real Excel rejects
  with a repair dialog.
- Fix: validate sheet names against the same rules as
  `Workbook::validate_sheet_name` on import; reject or sanitize.

#### H-CONS-10: Zero-sheet workbook + Strict mode accepts silently

- Source: Opus-B HIGH-7.
- File: `crates/ql-io-xlsx/src/lib.rs::import_xlsx_bytes` (Strict
  policy enforcement).
- What's wrong: a workbook with no `<sheet>` elements still imports;
  `feature_inventory` stays clean → Strict doesn't fire. Result:
  a zero-sheet workbook (which Excel rejects on any meaningful
  operation).
- Fix: Strict-mode pre-check rejects zero-sheet workbooks with a
  typed error.

#### H-CONS-11: Unknown `r:id` on `<sheet>` silently drops the sheet from the workbook

- Source: Opus-B HIGH-8.
- File: `crates/ql-io-xlsx/src/read/sheet_parts.rs::build_sheet_part_paths`.
- What's wrong: when `workbook.xml` declares
  `<sheet name="..." r:id="rId99"/>` but `workbook.xml.rels` has no
  `rId99`, the lookup returns empty path; downstream silently skips
  the sheet. The user thinks their workbook imported when 1+ sheets
  were dropped.
- Fix: emit `XlsxWarning` for every unknown r:id; Strict mode escalates.

#### H-CONS-12: `ExportMode::NewWorkbook` ignores `UnsupportedPolicy`

- Source: Opus-A HIGH-2.
- File: `crates/ql-io-xlsx/src/lib.rs:305-317`.
- What's wrong: `export_xlsx_path` only forwards `formula_cache` for
  NewWorkbook mode. Names that drop silently
  (`render_named_target` returns None for Error/Blank constants),
  features Quantbook can't model — none reach a `dropped_features`
  entry, none trigger Strict.
- Fix: collect drops in NewWorkbook just like UpdateOriginal; surface
  in `dropped_features` (Permissive) / error (Strict).

#### H-CONS-13: `UpdateOriginal` Strict silently permits CF / DV / mergeCells / hyperlinks loss (inline-in-sheet features)

- Sources: self H-2, Opus-A MEDIUM-1.
- File: `crates/ql-io-xlsx/src/write/update_original.rs`.
- What's wrong: inline features in worksheet xml are clobbered by the
  shadow's worksheet xml. `classify_part` only sees standalone parts,
  so these never reach `dropped`. Strict policy never fires.
- Fix: pre-scan original's worksheet xml for inline-feature
  signatures (`<conditionalFormatting>`, `<dataValidations>`,
  `<mergeCells>`, `<hyperlinks>`, `<sheetProtection>`). Add to
  dropped with `UnsupportedFeatureKind::ConditionalFormatting` etc.

#### H-CONS-14: Sheet `state="hidden"` / `state="veryHidden"` parsed but silently dropped on round-trip

- Source: Opus-A HIGH-3.
- File: `crates/ql-io-xlsx/src/read/workbook_xml.rs::SheetState`
  parsed but never applied; storage layer has no `Sheet::state`.
- Fix: extend `Sheet` with a `state` field OR document this as a
  dropped feature in `dropped_features` on export (UpdateOriginal
  could preserve via partial workbook.xml merge — see MEDIUM-4 in
  Opus-A doc).

#### H-CONS-15: Custom format ids referenced by overlay but not declared in `<numFmts>` on export

- Source: Opus-A HIGH-4.
- File: `crates/ql-io-xlsx/src/write/umya_export.rs` (export-side
  `custom_formats` collection at ~L262-270 filters to `>= 164`).
- What's wrong: when a format is at a built-in id (e.g., LibreOffice
  fixtures register 164 as alias "General", or a 2nd custom id
  shares the same code as a different id), the overlay can reference
  a numFmtId that has no `<numFmt>` entry in `<numFmts>`. Excel
  treats undeclared numFmtIds as General.
- Fix: enumerate every FormatId referenced by any `format_overlay`
  entry; emit a `<numFmt>` for each whose id is ≥ FIRST_CUSTOM_FORMAT_ID
  AND whose code is non-empty.

#### H-CONS-16: `FormulaCachePolicy::SkipCache` emits `<v/>` instead of omitting

- Source: Opus-A HIGH-5.
- File: `crates/ql-io-xlsx/src/write/umya_export.rs` formula-cell
  branch (~L138-160).
- What's wrong: when `SkipCache` is set and value is non-blank, the
  code goes through the `cache_written = false` path but
  `cell.set_formula` may still emit `<v/>`. Re-import sees `<v/>` as
  empty text → maps to `Value::Text("")`. The formula's cached value
  is lost AND a phantom text value is introduced.
- Fix: when SkipCache, ensure NO `<v>` element is emitted (umya may
  need a post-process patch to strip empty `<v/>`).

#### H-CONS-17: `Strict` import error message picks "first" unsupported feature non-deterministically

- Source: Opus-A HIGH-6.
- File: `crates/ql-io-xlsx/src/lib.rs:195-208`.
- What's wrong: `report.feature_inventory.counts.iter().next()` —
  HashMap iteration. Two runs produce different error messages.
- Fix: sort by `UnsupportedFeatureKind` discriminant or
  alphabetical before picking the "first".

### Tier 3 — API hygiene + dead code

#### H-CONS-18: `XlsxPreservation.known_parts` is dead in the public API

- Sources: Opus-C HIGH-2, self M-3, Opus-B M-11.
- File: `crates/ql-io-xlsx/src/model.rs:25-28`.
- Fix: `#[deprecated]` or remove. Either way, document that
  UpdateOriginal re-reads from `original_bytes` (low cost).

#### H-CONS-19: `XlsxError::Reconciliation` variant declared but never constructed

- Source: Opus-C HIGH-3.
- File: `crates/ql-io-xlsx/src/error.rs:71-75`.
- Fix: remove the variant (technically a breaking change to an
  exhaustive match, but no caller can have matched on a
  never-constructed variant productively).

#### H-CONS-20: Documentation drift — multiple module docs reference shipped work as "deferred"

- Source: self H-1.
- File: `crates/ql-io-xlsx/src/write/umya_export.rs:1-15`,
  `crates/ql-io-xlsx/src/lib.rs:171-173`,
  `crates/ql-io-xlsx/src/read/styles_xml.rs:35-38`,
  `crates/ql-io-xlsx/src/write/mod.rs:8-11`.
- Fix: rewrite module docs to reflect post-W5-D-15.2 reality.

### Architectural (NOT shipping in this batch — v2 backlog)

#### H-CONS-21: Post-process substring-XML-mutation layer is becoming load-bearing; won't extend to v2 inline-anchor merges

- Source: Opus-C HIGH-1.
- v2 work — explicit deferral with rationale documented.

## MEDIUM findings — consolidated

Selected items worth tracking but not blocking ship:

- Codex MEDIUM-1 / W5-D-14.2.3 M-11 follow-up: R1C1-style sheet names
  not quoted in defined-name targets. `quote_sheet_name` covers
  cell-ref pattern but not R1C1.
- Opus-A MEDIUM-3: `[Content_Types].xml` `<Default>` case-sensitivity
  asymmetry.
- Opus-A MEDIUM-4: UpdateOriginal drops `<bookViews>`, `<calcPr>`,
  `<fileVersion>` from original workbook.xml.
- Opus-B M-1: `definedName localSheetId` parses to u32 then casts to
  SheetId (u16) — values ≥ 65536 silently truncate.
- Opus-B M-3: empty-string custom format code silently dropped.
- Opus-B M-9: `update_original` overwrites user's destination file
  when post-process fails AFTER `fs::write`.
- Opus-C MEDIUM-1: three independent A1 parsers across modules.
- Opus-C MEDIUM-2: `Event::Start` vs `Event::Empty` handling
  inconsistent across read modules.
- Opus-C MEDIUM-3: `umya_export.rs` is 1495 LOC; split.

## Closure strategy (proposed)

Ship in tight, focused batches per the audit-discipline rule:

| Batch | HIGHs closed | Scope |
|---|---|---|
| **W5-D-PM-1** (correctness) | H-CONS-1, 2, 3, 15, 16, 17 | Formula+Error cells → Error; Boolean caches; row order; format-id declaration; SkipCache; deterministic Strict |
| **W5-D-PM-2** (security + defense) | H-CONS-4, 5, 6, 8, 9 | u32 panic, path traversal, OOB refs, OOM oracle, NUL byte sheet names |
| **W5-D-PM-3** (Strict + policy completeness) | H-CONS-10, 11, 12, 13, 14 | zero-sheet Strict, unknown r:id, NewWorkbook policy, UpdateOriginal inline-feature Strict, sheet state |
| **W5-D-PM-4** (file durability) | H-CONS-7 | atomic write via tempfile + rename |
| **W5-D-PM-5** (API + docs hygiene) | H-CONS-18, 19, 20 | known_parts deprecation, Reconciliation removal, doc drift |
| **v2 deferred** | H-CONS-21 | Post-process substring layer → typed Patcher |

Each batch is one commit with its own per-batch audit cycle (Codex
+ separate-Opus + self). Expected total time: 5 closure commits.

## What looked right (cross-auditor consensus)

- Empirical 177/177 corpus pass on counts-equivalent baseline.
- Per-batch audit closures all verified by the megaudit auditors
  (no regressions of previously-closed items).
- W5-D-14.2.3 M-11 (`quote_sheet_name`) catches `A1`, `Sheet1`,
  `XFD1048576` (Codex confirmed empirically — only R1C1 missed).
- W5-D-15.1 H-3 (cellxfs roster determinism) verified across
  empirical probes.
- Test architecture: each closure has a corresponding test that
  ACTUALLY exercises the bug (self audit verified per-test review).
- Public API stability commitments: types in `pub use` blocks are
  the right ones modulo H-CONS-18 / H-CONS-19.

## Probes retained as regression artifacts

Opus-A left 8 probe files in `crates/ql-io-xlsx/tests/opus_a_*.rs`,
all `#[ignore]`'d, that exercise the audit cases empirically.
Closing self-audit M-4 (audit-probe regenerability gap).

`tests/phase_4_11_corpus_probe.rs` (megaudit prep) similarly
`#[ignore]`'d. Should run nightly per the audit-discipline rule
(M-2 follow-up — needs CI wiring).

## v2 backlog (forward to Phase 4.12 + later)

Per self-audit M-2: this backlog needs a tracked doc at
`docs/PHASE-4-11-V2-BACKLOG.md`. Items:

- Rels-graph merge in UpdateOriginal (for drawings/charts/comments/
  media/embeddings reachability).
- Sheet-inline-anchor merge (CF/DV/mergeCells/hyperlinks
  preservation under UpdateOriginal).
- Per-cell font/fill/border/alignment.
- Style inheritance via xfId / cellStyleXfs cascade.
- Custom-style-name preservation in tables (`tableStyleInfo`).
- Table-id stability across round-trips.
- Sheet-name `''`-escape edge case (Cow-based parse landed in
  W5-D-14.2.3 but extreme corners untested).
- Post-process substring layer → typed Patcher (H-CONS-21).
- A1 parser consolidation (Opus-C MEDIUM-1).
- Event handling consolidation (Opus-C MEDIUM-2).
- umya_export.rs split (Opus-C MEDIUM-3).
- CI wiring for corpus + opus_a deep probes.
