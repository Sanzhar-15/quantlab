# Phase 4.11 XLSX I/O Megaudit - Auditor 1 Findings

Scope: OOXML schema compliance, emitted bytes, real-world fixture corpus, and cross-feature interactions. I did not modify source code.

Environment limits:

- `cargo test -p ql-io-xlsx --test phase_4_11_corpus_probe -- --nocapture --include-ignored` could not run here. `/Users/sanzhar/.cargo/bin/cargo` delegates through the macOS bridge, and the bridge fails with `dial unix /opt/orbstack-guest/run/hcontrol.sock: connect: operation not permitted`.
- The requested `mac zsh -lc ...` bridge fails with the same OrbStack socket error.
- Linux Python has no `openpyxl`: `ModuleNotFoundError: No module named 'openpyxl'`.
- Linux LibreOffice exists (`LibreOffice 24.2.7.2`) but headless xlsx->xlsx conversion returned `RC=1`, emitted only `Warning: failed to launch javaldx`, and produced no output. I treat LibreOffice consumer compatibility as blocked/inconclusive, not as evidence of workbook corruption.

Scratch artifacts used for emitted-byte inspection:

- `/tmp/codex_quantbook_shaped_cross_feature.xlsx`: synthetic Quantbook-shaped XLSX exercising multiple sheets, workbook/sheet names, custom and built-in formats, table totals/custom totals function, formula caches, error cells, date1904, and blank style-only cells. This was generated only for XML-order inspection because the Rust exporter could not run in this sandbox.

## HIGH-1 - Boolean formula caches are emitted as untyped `TRUE`/`FALSE` values

References:

- `crates/ql-io-xlsx/src/write/umya_export.rs:160-197`
- `/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/umya-spreadsheet-2.2.0/src/structs/cell_value.rs:28-33`
- `/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/umya-spreadsheet-2.2.0/src/structs/cell.rs:467-528`

The exporter writes the cached value first, then calls `cell.set_formula(...)`. umya then reports every formula cell as `t="str"` regardless of the raw cached value. Quantbook schedules `RemoveStrType` for both numeric and boolean cached formulas:

- Numeric cached formula: removing `t="str"` leaves `<v>5</v>`, which is a valid default numeric cache.
- Boolean cached formula: removing `t="str"` leaves `<v>TRUE</v>` or `<v>FALSE</v>` with no `t="b"`. In OOXML, an omitted `t` is the default numeric cell type, so the cache payload is not the proper boolean encoding. The normal boolean serialization branch in umya would have written `t="b"` plus `<v>1</v>`/`<v>0</v>`, but that branch is bypassed for formulas because umya forces formula cells through `t="str"`.

Reproduction steps:

1. Create a workbook with `C1` formula `A1=B1`, cached value `Value::Boolean(true)`, and export with `FormulaCachePolicy::WriteRecomputed`.
2. Inspect `xl/worksheets/sheet1.xml`.
3. Current source path should produce a cell equivalent to `<c r="C1"><f>A1=B1</f><v>TRUE</v></c>`.
4. The emitted cache should instead be encoded as a boolean, e.g. `<c r="C1" t="b"><f>A1=B1</f><v>1</v></c>`, or the cache should be omitted rather than emitted as an invalid default-type payload.

Why this escaped current tests: `w5_d_14_1_round_trip_preserves_formula_with_cached_value` only covers a numeric cached formula (`crates/ql-io-xlsx/tests/calamine_smoke.rs:136-151`).

Suggestion: split formula-cache post-processing by cached value type. For booleans, rewrite `t="str"` to `t="b"` and normalize `<v>TRUE/FALSE</v>` to `<v>1/0</v>`.

## HIGH-2 - Formula cells with error caches remain string cells; the error-sigil patch does not match formula XML

References:

- `crates/ql-io-xlsx/src/write/umya_export.rs:160-207`
- `crates/ql-io-xlsx/src/write/umya_export.rs:478-484`
- `/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/umya-spreadsheet-2.2.0/src/structs/cell_value.rs:28-33`
- `/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/umya-spreadsheet-2.2.0/src/structs/cell.rs:467-528`

For formula cells with `Value::Error`, Quantbook applies the cached error, calls `set_formula`, and schedules `OverrideErrorSigil`. But umya serializes formula cells as `t="str"` and writes the formula before the value:

`<c r="A1" t="str"><f>1/0</f><v>#DIV/0!</v></c>`

The `OverrideErrorSigil` patch only matches a non-formula error cell shape:

`<c r="A1" t="e"><v>#VALUE!</v>`

That needle cannot match a formula cell containing `<f>...</f>` and `t="str"`. The result is not an OOXML error cache; it is a string formula result. Consumers can import it as text or display stale string metadata instead of an error result.

Reproduction steps:

1. Create a workbook with `A1` formula `1/0` and cached value `Value::Error(ErrorValue::Div0)`.
2. Export with `FormulaCachePolicy::WriteRecomputed`.
3. Inspect `xl/worksheets/sheet1.xml`.
4. Current source path should leave `t="str"` on the formula cell. The emitted cache should be `t="e"` with the real error sigil in `<v>`.

Suggestion: add a formula-error-specific post-process that rewrites the cell type to `t="e"` and patches the `<v>` content after the `<f>` element.

## HIGH-3 - Style-only blank cells can make `<row>` elements out of order

References:

- `crates/ql-io-xlsx/src/write/umya_export.rs:486-507`
- `crates/ql-io-xlsx/src/write/umya_export.rs:518-596`
- Existing test gap: `crates/ql-io-xlsx/tests/calamine_smoke.rs:1108-1145`

When a blank cell has a format overlay and no existing `<c>` tag, `SetStyle` calls `insert_style_only_cell`. If the target row does not already exist, the function appends a new `<row>` immediately before `</sheetData>`.

The implementation comment says this is intended to be row-sorted, then explicitly does the opposite:

- It says "insert into `<sheetData>` in row-sorted order".
- It inserts at the end of `sheetData`.
- It notes "Excel rejects out-of-order rows on save but tolerates them on open".

That is enough for a real emitted-byte issue. A sheet with a real value at `A10` and a blank format overlay at `A5` can serialize row 10 before row 5:

`<row r="10">...</row><row r="5"><c r="A5" s="..."/></row>`

Reproduction steps:

1. Create a workbook with `A10 = 1`.
2. Add a format overlay to blank `A5`.
3. Export.
4. Inspect `xl/worksheets/sheet1.xml` and verify row order.

Why this escaped current tests: `w5_d_15_2_blank_cell_with_format_overlay_round_trips` uses a workbook whose only content is the blank overlay, so appending at the end does not create an out-of-order row (`crates/ql-io-xlsx/tests/calamine_smoke.rs:1117-1130`).

Suggestion: insert newly synthesized rows before the first later `<row r="...">`, or build row/cell insertion through an XML tree rather than string append.

## MEDIUM-1 - `R1C1`-style sheet names are still not quoted in defined-name targets

References:

- `crates/ql-io-xlsx/src/write/umya_export.rs:900-920`
- `crates/ql-io-xlsx/src/write/umya_export.rs:948-990`

The W5-D-14.2.3 comment says cell-reference-shaped sheet names including `A1`, `R1C1`, and `XFD1048576` are quoted. The implementation only detects `^[A-Za-z]+\\d+$`, so it catches `A1`, `Sheet1`, and `XFD1048576`, but not `R1C1`.

The synthetic cross-feature workbook therefore contains this defined name:

`<definedName name="LOCALCELL" localSheetId="1">R1C1!$A$1</definedName>`

The intended safe target is:

`<definedName name="LOCALCELL" localSheetId="1">'R1C1'!$A$1</definedName>`

Fixture corpus evidence: direct scan of 177 fixtures found many A1-style names (`Sheet1`, `Chart1`, etc.) and no R1C1-style names, so the existing corpus does not exercise this corner.

Suggestion: extend `looks_like_cell_ref` to recognize `R\\d+C\\d+` case-insensitively, or conservatively quote any name that matches an A1- or R1C1-reference grammar.

## MEDIUM-2 - The `applyNumberFormat` import comment/default is spec-inaccurate; current behavior is compatibility-driven

References:

- `crates/ql-io-xlsx/src/read/styles_xml.rs:182-205`
- Microsoft ISO/IEC 29500 implementation notes: `https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/68362a4b-5589-4504-b566-e8154dce1de3`

The code now defaults missing `applyNumberFormat` to `true` and the comment says this is the OOXML schema default. That is not the safe spec claim. Microsoft documents that, for `xf` in `cellStyleXfs`, the default is false, and for `xf` in `cellXfs`, Excel ignores `applyNumberFormat` and uses `numFmtId`.

So the current Quantbook behavior may be the correct Excel/LibreOffice compatibility choice, but the rationale is wrong: it is not simply "the schema default is TRUE".

Corpus evidence from direct XML scan:

- `.references/ironcalc/xlsx/tests/libreoffice_888_example.xlsx`: 79 styled cells reference nonzero `numFmtId` xfs with no `applyNumberFormat`; custom numFmtIds 164-166 are present.
- `.references/ironcalc/xlsx/tests/calc_test_no_export/tables.xlsx`: 184 styled cells reference nonzero `numFmtId` xfs with no `applyNumberFormat`; the missing-attr xfs in the direct scan use built-in `numFmtId=43`, while the workbook also declares custom numFmts elsewhere.

This supports keeping Excel-compatible behavior for `cellXfs`, but the comment should be corrected so a future audit does not mistake a compatibility rule for a schema default. The exporter itself emits `applyNumberFormat="1"` for non-default roster entries (`crates/ql-io-xlsx/src/write/umya_export.rs:781-789`), so exported Quantbook styles are not relying on this disputed default.

Suggestion: document this as "Excel/LibreOffice cellXfs compatibility behavior" and consider distinguishing `cellStyleXfs` from `cellXfs` if the importer ever consumes both as applied cell formats.

## MEDIUM-3 - Custom table totals functions are emitted without the custom formula metadata

References:

- `crates/ql-storage/src/tables.rs:47-64`
- `crates/ql-io-xlsx/src/write/umya_export.rs:1181-1225`
- `crates/ql-io-xlsx/src/write/umya_export.rs:1227-1250`

`TotalsFunction::Custom` explicitly means a user-typed totals-row formula that does not match canonical totals functions. Export maps it to `totalsRowFunction="custom"`, but `render_table_xml` always self-closes `<tableColumn .../>` and never writes a `<totalsRowFormula>` child.

The synthetic cross-feature table emitted:

`<tableColumn id="3" name="Total" totalsRowFunction="custom"/>`

That is schema-parseable, but it does not carry the custom formula metadata implied by the model. The worksheet grid formula in the totals cell may still preserve the visible formula, but table-column metadata and consumer table UI can lose the custom formula association.

Corpus evidence: direct scan of the 177 fixtures found no existing table with `totalsRowFunction="custom"` missing `totalsRowFormula`, so the fixture corpus does not cover this edge.

Suggestion: if the model has access to the totals-row cell formula, emit `<totalsRowFormula>` inside the corresponding `tableColumn` when `TotalsFunction::Custom`.

## LOW-1 - `xfId="0"` is emitted even when no `<cellStyleXfs>` slot is present

References:

- `crates/ql-io-xlsx/src/write/umya_export.rs:776-789`

Quantbook replaces `<cellXfs>` with xfs that all carry `xfId="0"`. In the synthetic cross-feature workbook, `styles.xml` had no `<cellStyleXfs>` block, so `xfId="0"` is a dangling style-format reference:

`<cellXfs count="4"><xf ... xfId="0"/>...</cellXfs>`

This matches the earlier separate-Opus concern. I did not find direct evidence that schema validators or common consumers reject it; it is likely tolerated because many readers do not enforce this relationship. It remains worth pinning with a real Excel/openpyxl/LibreOffice check once the bridge is available.

Suggestion: either emit a minimal `<cellStyleXfs count="1"><xf .../></cellStyleXfs>` slot 0, or omit `xfId` where the schema/consumers allow it.

## LOW-2 - `<tableParts>` insertion is only schema-correct for Quantbook-owned fresh sheets

References:

- `crates/ql-io-xlsx/src/write/umya_export.rs:1253-1309`

`inject_table_parts_into_sheet_xml` inserts `<tableParts>` immediately before `</worksheet>`. For fresh Quantbook exports this is fine because there is no later `extLst`, controls, or other tail content. For a generic worksheet XML with `<extLst>`, this would place `<tableParts>` after `<extLst>`, which is not the CT_Worksheet child order.

I am ranking this LOW because Phase 4.11 export appears to write Quantbook-owned sheets through umya rather than preserving arbitrary original worksheet tail features. It is still a sharp edge in a generic string-injection helper.

Suggestion: if this helper is reused on preserved original worksheets, insert before the first tail element that must follow tableParts, especially `extLst`.

## What looked right

- `[Content_Types].xml`: the generated/synthetic package includes `Default` entries for `rels` and `xml`, and table parts are declared with explicit `/xl/tables/tableN.xml` `Override`s. Source injection is scoped to `[Content_Types].xml` when tables exist (`crates/ql-io-xlsx/src/write/umya_export.rs:390-391`).
- `workbook.xml`: date1904 injection into an existing umya `<workbookPr>` is order-correct for generated exports. umya writes `fileVersion` then `workbookPr`, and Quantbook only adds the `date1904="1"` attribute (`crates/ql-io-xlsx/src/write/umya_export.rs:627-648`). Defined names are injected after `</sheets>`, which matches CT_Workbook order before `calcPr`.
- `styles.xml`: custom `<numFmts>` are inserted as the first stylesheet child before `<fonts>` (`crates/ql-io-xlsx/src/write/umya_export.rs:679-706`, `720-755`). Quantbook's replacement `<cellXfs>` sits in the existing umya cellXfs position and exported non-default xfs explicitly set `applyNumberFormat="1"`.
- `worksheet.xml`: `<tableParts>` before `</worksheet>` is schema-correct for Quantbook-owned fresh worksheets without `extLst`.
- `table.xml`: required table attrs `id`, `name`, `displayName`, and `ref` are emitted. `autoFilter` excludes the totals row when `has_totals` is true (`crates/ql-io-xlsx/src/write/umya_export.rs:1130-1155`, `1200-1205`). The synthetic output had `table ref="A1:C4"` and `autoFilter ref="A1:C3"`, which is the expected footprint.
- Existing fixture scan found no table `autoFilter`/totals-row footprint mismatches and no worksheet tableParts-after-extLst violations in the 177 `.references/**/*.xlsx` files. The tableParts order check covered 10 worksheets containing `<tableParts>`.
- The exporter quotes A1-style sheet names such as `A1`, `Sheet1`, and `XFD1048576`; the missed case is specifically R1C1-style names.

## Corpus scan notes

Direct XML scan of 177 fixture workbooks:

```text
fixtures 177
missing applyNumberFormat nonzero xfs files 2
MISSAPPLY ('.references/ironcalc/xlsx/tests/libreoffice_888_example.xlsx', 3, 79, [(0, 164), (1, 164), (2, 164), (3, 164), (4, 165), (5, 166), (6, 166)])
MISSAPPLY ('.references/ironcalc/xlsx/tests/calc_test_no_export/tables.xlsx', 3, 184, [(6, 43), (7, 43), (13, 43), (16, 43), (17, 43), (18, 43), (23, 43), (24, 43)])
tables files 3 bad 0
worksheets with tableParts 10 bad_after_extLst []
```

Surprising-looking overlay/style counts in the corpus are mostly expected. Many fixtures have styled cells but no custom formats, because built-in number formats and non-number-format style attributes still create styled `<c s="...">` references. I did not flag those as Quantbook defects without a deeper semantic mismatch.
