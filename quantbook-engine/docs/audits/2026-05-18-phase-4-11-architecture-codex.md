# Phase 4.11 XLSX Import/Export Architecture - Codex Review

Date: 2026-05-18
Scope: `ql-io-xlsx` read/write architecture, first batch scope, risk profile.

## Executive recommendation

Use a hybrid reader from the first batch: `calamine` for grid cells, cached values, sheet iteration, and formula text, plus a small authoritative OOXML package scanner for workbook metadata, relationship mapping, sheet-scoped names, date system, tables, styles, and unsupported-feature inventory. Do not start with a pure calamine importer, because Quantbook's Phase 4.11 acceptance explicitly includes names, tables, formats, date systems, visible unsupported-feature errors, and round-trip survival. Also do not start with a full roll-own parser, because Quantbook's internal `Workbook` is a semantic sparse model, not an OOXML-shaped model; the full parser burden is mostly edge-case tax before the first user-visible XLSX loop exists.

Use `umya-spreadsheet` as the first writer backend for round-trip/update-original workflows, and keep the writer behind a backend boundary so a generated-workbook path can later use `rust_xlsxwriter` where appropriate. The important distinction is not cached formula values: current `rust_xlsxwriter` can store a formula result manually through `Formula::set_result()` / `Worksheet::set_formula_result()`. The real distinction is that `rust_xlsxwriter` is a strong generator, while Quantbook's first fidelity problem is preserving or updating an existing XLSX package without silently discarding user-owned workbook features.

For W5-D-14, choose a round-trip spine rather than minimal import or read-only-full. The first batch should prove this vertical loop: import common cells/formulas/cached values, recover date system and scoped names from OOXML, detect styles/tables/CF/DV even if not all are implemented, recompute through `WorkbookRuntime`, and export a minimal/generated workbook or update formula caches in the original workbook with a visible report. This catches write-side integration bugs early while avoiding a false sense of safety from an importer that silently drops the very metadata Phase 4.11 says must survive where supported.

## Context that should drive the decision

Phase 4.11 is not a generic XLSX library project. It sits between OOXML and Quantbook's `Workbook` / `WorkbookRuntime`. The native `.qbook/` v7 format is already the durable engine format; XLSX I/O is a boundary for import, exchange, and Excel compatibility.

The Quantbook model has first-class support for several XLSX concepts:

- `Workbook` has sheets, values, formulas, workbook names, sheet-scoped names, tables, sparse format overlays, `DateSystem`, `ReferenceMode`, and locale.
- Formula storage is canonical A1 + en-US. Phase 4.9 reference mode and locale are display/input transforms, so XLSX import should normalize Excel formulas into the canonical storage form and export in Excel's canonical English syntax.
- Phase 4.8 tables are semantic engine objects with stable column metadata, display/canonical names, header/totals flags, and resize/rename hooks.
- `WorkbookRuntime::set_formula` parses, binds, evaluates, writes computed values, records formula text, and handles spills. That is useful after import, but XLSX import also needs a raw-load path that can preserve formula text and cached values even if a formula is not yet supported by Quantbook's parser/binder/function set.

This means the loader should not be only a runtime command replayer. Import is a trust boundary and a fidelity boundary. It should build a `Workbook`, load raw formula text and cached values, register semantic metadata, then run an explicit recompute phase that can report unsupported formulas without discarding the source formula.

## Decision 1: read approach

Recommended approach: hybrid, with the split made explicit and tested.

`calamine` should own the common grid path: sheet names/order as seen by the reader, sparse cell values, formula ranges via `worksheet_formula`, and basic defined names only as fallback. This buys a battle-tested parser for shared strings, numbers, booleans, errors, formula cells, and sheet iteration. That is the fastest way to close XLSX-4-01 and to avoid spending the first week rediscovering ordinary worksheet parsing bugs.

The OOXML scanner should own package metadata and every feature where calamine's public model is too compressed for Quantbook: `xl/workbook.xml` workbook properties including `date1904`, sheet `sheetId`/`r:id`/state, `definedName localSheetId`, workbook relationships, worksheet relationships, table XML, `styles.xml`, and a feature inventory for conditional formatting, data validation, comments, drawings/images, external links, pivots, merged cells, protected sheets, and unsupported formula artifacts. In this design calamine is not the source of truth for metadata. It is the cell-grid backend.

The hybrid state-drift risk is real, so the first implementation should have reconciliation checks:

- Build `XlsxPackageIndex` from `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, and worksheet `.rels`.
- Map every worksheet by workbook order, `r:id`, part path, sheet name, `sheetId`, and visibility.
- Reconcile calamine sheet names/order with `workbook.xml`; mismatches are import errors, not best-effort guesses.
- Treat direct OOXML defined names as authoritative because calamine's `defined_names()` flattens scope.
- Treat direct table XML as authoritative for table ref, header/totals flags, column ids/names, totals metadata, and style ids. Calamine table data can be ignored or used only as a cross-check.
- Treat direct styles XML as authoritative for `numFmtId`, `cellXfs`, and the style-index to Quantbook `FormatId` map.
- Emit `XlsxImportReport` entries for every unsupported OOXML feature found. Silent drop should be a test failure for strict mode.

### Why not pure calamine?

Pure calamine is attractive only if the first milestone is "open sheets and values." That is too weak for Quantbook's 4.11 acceptance. The current crate stub says the phase is about semantic preservation for formulas, styles, names, tables, CF/DV, comments, and images, and the master plan calls out date systems, formats, names, tables, export, and visible unsupported-feature errors.

Formualizer is the cautionary reference. Its `backends/calamine.rs` is 1169 lines, not a thin adapter. It uses calamine for grid reads, but also opens the XLSX as a ZIP and scans `xl/workbook.xml` with `quick_xml` because calamine exposes defined names as `(name, formula_text)` and drops `localSheetId`. It also records calamine capabilities as missing styles, 1904 date system, merged cells, rich text, hyperlinks, data validations, and shared formulas. In other words, the serious calamine path already becomes hybrid as soon as scoped names and workbook properties matter.

### Why not roll-own first?

IronCalc proves roll-own can work, but it also shows the cost. Its import path is a full OOXML package reader: shared strings, workbook XML, relationships, styles, themes, worksheets, metadata, tables, comments, shared formulas, array formulas, dynamic array metadata, row/column dimensions, freeze panes, hidden states, and more. That matches IronCalc because its base model is much closer to OOXML: shared strings, worksheet cell structs, style tables, metadata, sheet views, comments, and formula value variants live directly in the model.

Quantbook is not shaped that way. It has a semantic workbook and graph runtime, not an OOXML DOM. A roll-own first pass would still need all the same package parsing, then substantial glue to compress OOXML into Quantbook concepts. It would surface many basic bugs early, but it would also push the first recompute/export loop later and leave a long tail of OOXML conformance bugs owned by this repo. Roll-own should remain a fallback/migration path behind our own `GridReader` and `PackageScanner` traits, not the starting point.

## Decision 2: write approach

Recommended approach: `umya-spreadsheet` first for round-trip/update-original, backend boundary from day one, generated-export backend optional later.

For Quantbook, the first writer should optimize for "take an XLSX users already have, import it, recompute with Quantbook, and write back an XLSX without gratuitously destroying metadata." `umya-spreadsheet` is a better first fit than `rust_xlsxwriter` for that because it can read and write existing workbook structures. Formualizer's `backends/umya.rs` is again not a thin wrapper, but it demonstrates the exact shape Quantbook needs: it reads workbook names and sheet-local names, reads tables, supplements umya by directly scanning table XML for `headerRowCount`, and has explicit `write_formula_caches_batch` / `set_formula_cached_value` helpers that preserve formula text while updating cached formula values.

`rust_xlsxwriter` is still valuable, but for a different lane. It is strong for new workbook generation and has clear formula behavior: it does not calculate formulas itself, stores a default result, sets recalc flags, and allows manually supplied formula results. That means it can write Quantbook's recomputed cache values. The missing piece for the primary Phase 4.11 round-trip story is preservation of an existing package: unsupported styles, drawings, comments, CF/DV, workbook views, and relationship parts would be regenerated or lost unless Quantbook models them all. Use it later if generated export quality/performance matters, not as the only first writer.

Do not roll-own the writer first. A custom writer is the only route to complete control, but Quantbook does not yet store enough OOXML detail to make complete control useful. Without an opaque preservation strategy, a roll-own writer would produce clean but lossy workbooks. With opaque preservation, it becomes a package patcher and XML rewriter, which is a larger project than needed for W5-D-14.

The writer API should separate two modes:

- `ExportMode::UpdateOriginal`: load or reuse original XLSX package, patch supported semantic edits and formula cached values, preserve unknown parts where the library allows it, and report any feature that may be dropped.
- `ExportMode::NewWorkbook`: generate a clean workbook from Quantbook state, including sheets, values, formulas, names, tables, and formats supported by the selected backend.

If `umya-spreadsheet` fails a required preservation test, mitigation should be targeted XML post-processing or a narrow package patcher for that feature, not an immediate full writer rewrite.

## Decision 3: first batch scope

Recommended W5-D-14 scope: round-trip spine with feature inventory. Among the three options, this is closest to "Round-trip slice", but it should include a mandatory OOXML manifest/report scaffold so unsupported metadata is detected from day one.

The first batch should include:

- Public `ql-io-xlsx` API and dependency wiring.
- Import from path and bytes.
- Sheets, cell values, formula strings, and formula cached values.
- Workbook date system from `workbookPr date1904`.
- Workbook and sheet-scoped defined names for cell/range targets; constants/formulas can be imported as report-backed best effort.
- A1 canonical formula handling: strip leading `=` on import for Quantbook storage; emit Excel English A1 formulas on export.
- Minimal style import for number formats: `styles.xml` `numFmts` + `cellXfs` -> Quantbook `FormatTable` / sparse overlay. Other style facets can be inventoried.
- Minimal table import from table XML: name/displayName, sheet, ref, header/totals flags, column ids/names, totals function where available.
- Recompute pass through `WorkbookRuntime` after raw load, producing an import/recompute report rather than aborting the whole file on one unsupported formula.
- Export path that can write formulas and cached values. Prefer update-original via umya for imported files; allow generated export if update-original is not ready.
- Unsupported feature detection for CF/DV/comments/drawings/images/hyperlinks/merged cells/protection/external links/pivots/macros. Strict mode should fail export if a feature would be lost.

This is not "full read side first." Read-only-full delays the writer until after the importer has already made assumptions that may not survive export. It is also not "minimal import." Minimal import would give quick demo value, but it would specifically hide the highest-risk areas: date1904, scoped names, table refs, style ids, and unsupported feature loss. The round-trip spine forces the team to find library/model mismatches while the design is still malleable.

Estimated shape: 1 week for the spine if tables/styles are minimal and CF/DV are detect-only; 2-4 weeks remains credible for the full Phase 4.11 acceptance set.

## Round-trip and Phase 5 CRDT implications

There are two valid product futures.

If Phase 5 makes `.qbook` the collaborative source of truth, XLSX becomes mostly an ingress/egress format. In that world, preserving every non-semantic Excel UI artifact is less important than importing calculations, tables, names, date semantics, and number formats correctly. This favors the hybrid reader and generated exports, with explicit warnings for unsupported Excel-only artifacts. Users import Excel once, collaborate in Quantbook, and export snapshots.

If Excel remains a live interchange format with repeated back-and-forth edits, fidelity loss compounds. Dropping a data validation or conditional format on the first export is not a cosmetic bug; it permanently damages a workbook another collaborator may still own in Excel. This future requires update-original export, opaque package preservation, and strict unsupported-feature policy. It also means the importer should store an `XlsxPreservation` handle or original package fingerprint for workbooks that came from XLSX.

The recommended architecture supports both without committing Phase 4.11 to a full OOXML clone. First-class semantic objects should become Quantbook/CRDT state: sheets, cells, formulas, names, tables, formats, date system. Non-modeled OOXML should be detected and either preserved opaquely in update-original mode or reported as unsupported in generated mode. That line keeps the CRDT clean while still respecting round-trip users.

## Engine integration notes

The fastest safe importer is not a list of runtime edits. Runtime APIs are user-operation APIs; they parse, bind, evaluate, emit oplog, and mutate spills. XLSX import should bulk-load storage state and then ask the runtime to recompute.

Suggested flow:

1. Parse package manifest and workbook metadata.
2. Create `Workbook` and sheets in workbook order. Set `DateSystem`; keep `ReferenceMode::A1` and `Locale::EnUs` for stored formulas.
3. Load cell cached values into sheet storage. Preserve error values as Quantbook errors where available.
4. Load formula strings into `Workbook::put_formula` without leading `=`, after validating bounds.
5. Load workbook and sheet-scoped names. For names that cannot be represented as `NamedTarget`, keep report entries and raw text if a preservation sidecar exists.
6. Load table metadata through `TableTable` using imported table ids/column ids where possible.
7. Load number formats and cell format overlays.
8. Run recompute. Successful formulas replace cached values with Quantbook results. Failed formulas keep imported cached values unless strict recompute mode says otherwise, and every failure is reported.

This prevents one unsupported Excel formula from destroying the user's ability to inspect or re-export the workbook. It also aligns with Phase 4.10's known strict-text divergences: import should be transparent about formulas Quantbook cannot evaluate exactly.

## Risk register

| Choice / risk | What it gets wrong | Likelihood | Impact | Mitigation |
|---|---|---:|---:|---|
| Pure calamine reader | Drops or flattens scope/date/tables/styles/CF/DV details; users discover data loss only after export. | High | High | Do not ship pure calamine as the architecture. Use calamine only for grid cells and formulas; direct OOXML for metadata and feature inventory. |
| Hybrid reader | Two sources of truth can drift on sheet order, names, table refs, dimensions, or formulas. | Medium | High | Build `XlsxPackageIndex`; reconcile calamine output against workbook XML; make direct XML authoritative for metadata; add golden tests with deliberately scoped names/tables/date1904. |
| Roll-own reader first | Long runway before common workbooks import; reimplements shared strings, formulas, worksheet edge cases, styles, rels. | Medium | High | Keep a narrow OOXML scanner now. Define backend traits so a future roll-own grid reader can replace calamine if needed. |
| Calamine stagnates | Public API gaps remain, or formula/table behavior changes. | Medium | Medium | Hide it behind `CalamineGridReader`; keep direct XML scanners independent; pin versions; add corpus tests so replacement cost is localized. |
| Umya writer drops package parts | Update-original round-trip may lose unsupported OOXML parts despite using a read/write library. | Medium | High | Start with destructive-loss tests. Strict export mode blocks when feature inventory includes unpreserved parts. Add targeted XML patch/preservation for high-value gaps. |
| Rust_xlsxwriter as only writer | Clean generated files, but original workbook artifacts are not preserved. | High for round-trip | High | Use it only for `NewWorkbook` mode or later. Do not make it the sole Phase 4.11 writer. |
| Roll-own writer first | Full control, but Quantbook lacks a full OOXML state model, so output is still lossy and expensive. | Medium | High | Defer. If needed, implement targeted package patcher for specific lost metadata before full serializer. |
| Import via `WorkbookRuntime::set_formula` only | Unsupported formula aborts or drops formula/cached value; op-log becomes noisy; import semantics differ from file-load semantics. | High | Medium | Raw-load formula text and cached values first; recompute as separate reported phase. |
| Formula locale/reference mismatch | XLSX formulas are stored in English A1; Quantbook display mode can be R1C1/localized. | Medium | Medium | Treat XLSX import/export as canonical A1 + EnUs. Use Phase 4.9 parser/printer only for UI transformations, not file storage. |
| Table mismatch | Excel table XML has header/totals/style/autofilter details beyond Quantbook's table model. | High | Medium | Import semantic core; report and optionally preserve extra table XML attributes; add tests for structured refs after import. |
| Date system loss | 1904 workbooks shift dates if not imported. | Medium | High | Parse `workbookPr date1904` from OOXML in batch one. Add 1900/1904 golden files. |
| Unsupported feature silence | CF/DV/comments/images/macros disappear without user awareness. | High unless designed | High | `UnsupportedFeature` inventory is part of import/export API. Strict mode fails; permissive mode reports. |

## Starter scaffolding

Recommended module layout:

```text
crates/ql-io-xlsx/src/
  lib.rs
  error.rs
  options.rs
  report.rs
  model.rs
  read/
    mod.rs
    calamine_grid.rs
    package.rs
    rels.rs
    workbook_xml.rs
    worksheet_xml.rs
    styles_xml.rs
    tables_xml.rs
    defined_names.rs
    convert.rs
  write/
    mod.rs
    umya_roundtrip.rs
    generated.rs
    formulas.rs
    styles.rs
  tests/
```

Public API sketch:

```rust
pub fn import_xlsx_path(
    path: impl AsRef<std::path::Path>,
    registry: &ql_functions::FunctionRegistry,
    options: XlsxImportOptions,
) -> Result<XlsxImportResult, XlsxError>;

pub fn import_xlsx_bytes(
    bytes: &[u8],
    registry: &ql_functions::FunctionRegistry,
    options: XlsxImportOptions,
) -> Result<XlsxImportResult, XlsxError>;

pub fn export_xlsx_path(
    workbook: &ql_storage::Workbook,
    registry: &ql_functions::FunctionRegistry,
    out: impl AsRef<std::path::Path>,
    options: XlsxExportOptions,
) -> Result<XlsxExportReport, XlsxError>;
```

Core types:

```rust
pub struct XlsxImportOptions {
    pub recompute: RecomputeMode,
    pub unsupported_policy: UnsupportedPolicy,
    pub preserve_package: bool,
}

pub struct XlsxImportResult {
    pub workbook: ql_storage::Workbook,
    pub report: XlsxImportReport,
    pub preservation: Option<XlsxPreservation>,
}

pub struct XlsxExportOptions {
    pub mode: ExportMode,
    pub unsupported_policy: UnsupportedPolicy,
    pub formula_cache: FormulaCachePolicy,
}

pub enum ExportMode {
    NewWorkbook,
    UpdateOriginal { source: XlsxPreservation },
}

pub struct XlsxImportReport {
    pub feature_inventory: FeatureInventory,
    pub unsupported: Vec<UnsupportedFeature>,
    pub formula_failures: Vec<FormulaImportFailure>,
    pub warnings: Vec<XlsxWarning>,
}
```

Internal boundaries:

- `CalamineGridReader`: returns sheets, sparse values, formula strings, cached values, and raw calamine metadata fallback.
- `XlsxPackageIndex`: returns workbook part paths, relationships, sheet mapping, content types, and raw package feature inventory.
- `WorkbookXmlReader`: returns date system, sheet visibility, workbook names, scoped names, calc settings.
- `StylesXmlReader`: returns `numFmtId` registrations and `xf` to Quantbook `FormatId` mappings.
- `TableXmlReader`: returns Quantbook table metadata plus an optional raw-table extras map.
- `WorkbookBuilder`: owns the storage-level import order and validation.
- `RecomputeRunner`: runs graph recompute and records failures without hiding imported cached values.
- `UmyaRoundTripWriter`: updates formulas/caches and supported metadata in an existing package.
- `GeneratedWriter`: emits new XLSX from Quantbook state; can be umya first and `rust_xlsxwriter` later.

## Test strategy for the first batch

Add golden XLSX fixtures that target the architecture risks, not just happy-path cells:

- Values and formulas with cached results.
- Workbook-scoped and sheet-scoped names with the same display name on different sheets.
- `date1904` workbook with date serials.
- Table with hidden header or totals row, column ids, and structured-reference formulas.
- Number formats: built-in date, custom date, text format, percent.
- Unsupported feature detector fixtures: conditional formatting, data validation, comments, drawing/image, hyperlink, merged cells.
- Formula failures: valid Excel formula unsupported by Quantbook, parse error, unknown external reference.
- Round-trip smoke: import, recompute, export, re-import, compare semantic workbook state and report expected unsupported loss.

The key assertion is not that every OOXML feature is implemented in batch one. The key assertion is that Quantbook never silently claims fidelity it does not have.

## Evidence from references checked

Local reference evidence:

- `docs/MASTER-PLAN.md:505-508` defines Phase 4.11 as workbook load, formulas, cached values, names, sheets, tables, formats, date systems, export, and visible unsupported-feature errors.
- `crates/ql-io-xlsx/src/lib.rs:1-11` is a stub but already names calamine read, deliberate writer choice, and semantic preservation for formulas/styles/names/tables/CF/DV/comments/images.
- `crates/ql-storage/src/workbook.rs` has first-class `DateSystem`, names, tables, formats, reference mode, locale, and formula text storage.
- `crates/ql-exec/src/workbook_runtime.rs` canonicalizes formula input through reference mode/locale and stores canonical formula text, so XLSX file formulas should remain A1 + EnUs internally.
- Formualizer `backends/calamine.rs` supplements calamine with ZIP + `quick_xml` scans for defined names because calamine drops `localSheetId`; its capability flags mark several needed features as unavailable through calamine.
- Formualizer `backends/umya.rs` supplements umya for table `headerRowCount` and implements formula cache update helpers while preserving formula text.
- IronCalc `xlsx/src/import/` is a full roll-own OOXML importer, including workbook rels, styles, tables, worksheets, shared formulas, dynamic array metadata, and comments. Its exporter expects the model to be evaluated before saving formula values. This is effective because IronCalc's model is much more OOXML-shaped than Quantbook's.

External API checks:

- Calamine `Reader` exposes worksheet ranges, worksheet formulas, sheet names, and flattened defined names: <https://docs.rs/calamine/latest/calamine/trait.Reader.html>
- Calamine `Table` exposes table name, sheet name, header names, and data range, but not the full table XML surface Quantbook needs for fidelity: <https://docs.rs/calamine/latest/calamine/struct.Table.html>
- `rust_xlsxwriter` formula docs state that the library does not calculate formulas, writes a default result/recalc flag, and allows a manually supplied formula result: <https://docs.rs/rust_xlsxwriter/latest/rust_xlsxwriter/struct.Formula.html>
- `umya-spreadsheet` current crate docs are here, but Formualizer's source is the stronger practical evidence for its read/write and formula-cache behavior: <https://docs.rs/crate/umya-spreadsheet/latest>
