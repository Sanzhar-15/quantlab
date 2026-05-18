# Phase 4.11 megaudit — Opus-A findings

Auditor angle: **round-trip invariants + cross-feature consistency**.
Repo: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`. Branch `feat/quantbook-engine` HEAD `f941195608b`.

## Method

Built 10 deep round-trip probes that go beyond `phase_4_11_corpus_probe`'s count-equivalence checks:

- `tests/opus_a_deep_probe.rs` — corpus-wide cell value, name, table, format-code, overlay, formula-text round-trips against all 177 fixtures + synthetic cross-feature workbook + UpdateOriginal Strict policy.
- `tests/opus_a_edge_cases.rs` — table sparse column ids, unicode, format codes with XML-special chars, name case round-trip, numeric precision, overlay on text/error/blank/formula cells, sheet-scoped names with cross-sheet targets, Strict-import with drawings, dropped_features vs feature_inventory completeness.
- `tests/opus_a_format_no_overlay.rs` — formats registered without overlay refs; overlay on unpopulated built-in format ids; empty workbook.
- `tests/opus_a_misc.rs` — sheet with only blank overlays followed by normal sheet; Strict UpdateOriginal output-file untouched; NewWorkbook with `Constant(Error)` name target.
- `tests/opus_a_cache_policy.rs` — `FormulaCachePolicy::SkipCache` round-trip; `RecomputeMode::Strict` on unknown function.
- `tests/opus_a_error_cell_probe.rs` — formula cells with Error cached values.
- `tests/opus_a_dup_fmt.rs` — two numFmtIds with same format code; LibreOffice's `numFmt 164="General"` round-trip.
- `tests/opus_a_text_edge.rs` — text with whitespace, XML-special chars, newlines, tabs, control chars, emoji; very long text; default 1900 date system.

Findings below are severity-ranked. "What looked right" follows.

---

## HIGH-1 — Formula cells with Error cached values round-trip to Text on re-import

**Severity**: HIGH (real silent corruption of cached cell values; impacts every workbook with `IFERROR`-style formulas that resolve to errors, and the entire `DVAR_DVARP_DSTDEV_DSTDEVP.xlsx`-class fixtures).

**Reproduction**:

```rust
// crates/ql-io-xlsx/tests/opus_a_error_cell_probe.rs
let mut wb = Workbook::new();
let s = wb.add_sheet("S1");
wb.put_at(s, 1, 0, Value::Error(ErrorValue::DivZero));
wb.put_formula(s, 1, 0, "1/0".to_string());
export_xlsx_path(&wb, ...);
let r = import_xlsx_path(...);
let back = r.workbook.sheet(s).unwrap().read(1, 0);
// orig: Error(DivZero); back: Text("#DIV/0!")
```

**Evidence — emitted OOXML for the formula+error case**:

```xml
<c r="A2" t="str"><f>1/0</f><v>#DIV/0!</v></c>
```

`t="str"` (string) — not `t="e"` (error). The sigil is unescaped text inside `<v>`, and calamine reads it back as `Data::String`.

**Root cause — `crates/ql-io-xlsx/src/write/umya_export.rs:191-208`**:

```rust
// only matches Number / Boolean; Error falls through
if cache_written && matches!(val, Value::Number(_) | Value::Boolean(_)) {
    fixes.push(CellFix { ... RemoveStrType });
}
// sigil-fix below only patches if cell already has t="e"
if let Value::Error(e) = val {
    if cache_written {
        fixes.push(CellFix { ... OverrideErrorSigil(e.sigil()) });
    }
}
```

The two issues compound:

1. The RemoveStrType branch doesn't include `Value::Error(_)`, so the formula's `t="str"` is never removed.
2. The `OverrideErrorSigil` pattern in `apply_cell_fixes_to_sheet_xml` (umya_export.rs:482) matches `<c r="..." t="e"><v>#VALUE!</v>` — but the cell still has `t="str"` from umya's writer, so the pattern doesn't match. The sigil substitution silently does nothing.

So the fix from the per-batch audit (W5-D-14.1 HIGH-6) only works for the **value-only** Error cell path (the `(None, val)` arm). The **formula+Error** arm is broken.

**Corpus blast radius**: 9400 / 92788 cells (10.1%) diverge across the corpus, almost all of them this exact pattern. Affected fixtures include `DVAR_DVARP_DSTDEV_DSTDEVP.xlsx`, `RRI.xlsx`, `SORT.xlsx`, `arithmetic.xlsx`, every fixture with `=NA()`, `=1/0`, etc.

**Suggested fix**: extend the `RemoveStrType` match to include `Value::Error(_)`, and emit `Value::Error(_)`-typed cells via umya's `set_error` path with the formula attached. Add a per-batch test that round-trips `=1/0` (cached `#DIV/0!`) and asserts the re-import yields `Error(DivZero)`, not `Text("#DIV/0!")`.

---

## HIGH-2 — `ExportMode::NewWorkbook` ignores `UnsupportedPolicy`

**Severity**: HIGH (Strict mode is a documented no-loss guarantee; NewWorkbook silently violates it).

**Reproduction** — `crates/ql-io-xlsx/tests/opus_a_deep_probe.rs::deep_strict_new_workbook`:

```rust
let mut wb = Workbook::new();
wb.add_sheet("S1");
wb.set_name("OkName", NamedTarget::Constant(Value::Number(7.0))).unwrap();
wb.set_name("Bad",   NamedTarget::Constant(Value::Error(ErrorValue::Ref))).unwrap();
wb.set_name("Empty", NamedTarget::Constant(Value::Blank)).unwrap();

let rep = export_xlsx_path(&wb, &reg, &tmp,
    XlsxExportOptions {
        mode: ExportMode::NewWorkbook,
        unsupported_policy: UnsupportedPolicy::Strict,
        ..Default::default()
    }).unwrap();
// rep.dropped_features = []
// re-imported workbook has only OKNAME — Bad and Empty silently gone.
```

**Root cause — `crates/ql-io-xlsx/src/lib.rs:305-317`**:

```rust
ExportMode::NewWorkbook => {
    let mut report =
        write::umya_export::export_new_workbook(workbook, out_path, options.formula_cache)?;
    // unsupported_policy is dropped on the floor.
    report.warnings.shrink_to_fit();
    Ok(report)
}
```

Only `options.formula_cache` flows in; `options.unsupported_policy` is unused.

Sub-bug **also** in `crates/ql-io-xlsx/src/write/umya_export.rs::render_named_target`: returns `None` for `Constant(Error)` and `Constant(Blank)`, dropping silently with no log to `dropped_features` or `warnings`. The Strict claim "every unsupported feature triggers `XlsxError::UnsupportedFeature`" (`options.rs:60-62`) is violated even under Permissive — the user has no idea the names were lost.

**Suggested fix**:

1. Thread `unsupported_policy` through `export_new_workbook`.
2. In `render_named_target`, push to `report.dropped_features` for the `Constant(Error)` / `Constant(Blank)` cases, then bail Strict.
3. Apply the same to the existing `_sheet = workbook.sheet(addr.sheet)?` branch (where the sheet doesn't exist).

---

## HIGH-3 — Sheet `state="hidden"` / `state="veryHidden"` is parsed but silently dropped on round-trip

**Severity**: HIGH (silent data integrity loss; user-saved hidden sheets become visible on round-trip; no warning, no inventory entry, no `dropped_features` record).

**Reproduction**: Take any xlsx with `<sheet state="hidden" .../>` or `state="veryHidden"`. Round-trip → all sheets are visible.

**Evidence — `crates/ql-io-xlsx/src/read/workbook_xml.rs:241-243`**:

```rust
state = match v.as_ref() {
    "hidden" => SheetState::Hidden,
    "veryHidden" => SheetState::VeryHidden,
    _ => SheetState::Visible,
};
```

`SheetMeta.state` is parsed but `WorkbookProperties::sheets[i].state` is never read after `parse_workbook_xml`. It does NOT flow to `Workbook::add_sheet` (no `state` param) and Quantbook's `Sheet` has no `state` field. On export, every sheet is emitted as visible. Confirmed by `grep` — `SheetState::Hidden | VeryHidden` is referenced only in the parser + test file.

**Compounding**: also lost via `ExportMode::UpdateOriginal` since `xl/workbook.xml` is "owned by shadow" — umya re-emits the file without `state` attrs.

**Recommendation**:

- Short-term (no engine change): add `WorkbookProperties.sheets[i].state` to `dropped_features` when not `Visible`, with a `Other("hidden-sheet-state")` kind. Document that hidden state is not preserved in Phase 4.11.
- Medium-term: add `Sheet::set_state` + `Sheet::state` to `ql-storage` and propagate at the import/export wiring.

---

## HIGH-4 — Custom format ids referenced by overlay but not declared on export

**Severity**: HIGH (produces a structurally inconsistent xlsx — `<c s="N">` references a cellXf whose `numFmtId` is a custom id (>= 164) but no `<numFmt>` entry declares it; Excel renders General; downstream tooling may flag the file as broken).

**Reproduction** — `crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs::libreoffice_general_at_custom_id_round_trip`:

LibreOffice xlsx contains:

```xml
<numFmt numFmtId="164" formatCode="General"/>
<cellXfs count="2">
  <xf numFmtId="0"/>
  <xf numFmtId="164" applyNumberFormat="1"/>
</cellXfs>
```

Plus a cell `<c r="A1" s="1"><v>1</v></c>`. After import:

- `formats().lookup(FormatId(164)) = None` — because `styles_import` treats the redundant General registration as a benign no-op (W5-D-14.1 HIGH-8 closure at `styles_import.rs:63-71`).
- BUT `sheet.format_overlay().get(0,0) = Some(FormatId(164))` — `cell_styles_xml.rs` populates the overlay from the cellXf `numFmtId` attribute even when the `numFmt` declaration was skipped.

On **export**, `collect_defined_names`-style logic in `umya_export.rs:287-297` filters `workbook.formats()` to `id.0 >= 164`. Since id 164 isn't in the table, no `<numFmt>` is emitted. But every cell with `format_overlay(0,0) = FormatId(164)` gets `<c s="N">` and the cellXf injection block at `umya_export.rs:780-789` emits `<xf numFmtId="164" applyNumberFormat="1"/>` — referencing an undefined numFmtId.

**Two-custom-ids-same-code variant** (`two_custom_ids_with_same_format_code`): a workbook with `numFmt 164="yyyy-mm-dd"` AND `numFmt 165="yyyy-mm-dd"` → after import only 164 registers (165 → StringCollision benign no-op); but cell `<c r="B1" s="2">` produces `format_overlay(0,1) = FormatId(165)`. On export, no `<numFmt numFmtId="165">` is written.

**Suggested fix**: in `cell_styles_xml.rs`'s consumer at `lib.rs:197-212`, validate that `formats().lookup(fid).is_some()` before populating the overlay; otherwise drop with a report entry. OR: rewrite to canonicalize the overlay to the existing-id-with-matching-code (resolve 165 → 164 in the LibreOffice case). The latter is more user-friendly but trickier.

---

## HIGH-5 — `FormulaCachePolicy::SkipCache` emits `<v/>` (empty value) instead of omitting the value element

**Severity**: HIGH (round-trip turns the cached-skip into `Value::Text("")`; consumer cannot distinguish "no cache" from "cached empty string"; defeats the purpose of SkipCache).

**Reproduction** — `crates/ql-io-xlsx/tests/opus_a_cache_policy.rs::skip_cache_round_trip_behavior`:

```rust
wb.put_formula(s, 0, 2, "A1+B1".to_string());
// no cached value
export_xlsx_path(..., XlsxExportOptions { formula_cache: SkipCache, ..});
```

Emitted XML:

```xml
<c r="C1" t="str"><f>A1+B1</f><v/></c>
```

Re-import yields `Value::Text("")` for that cell. Consumer cannot distinguish "no cache emitted" from "emitted an empty string cache".

**Root cause**: in `umya_export.rs:166-180`, when `formula_cache == SkipCache`, the code skips `apply_value_to_cell` but still calls `set_formula` and the umya writer emits `<v/>`. Combined with the `t="str"` umya default (which RemoveStrType-fix only patches for Number/Boolean — same root cause as HIGH-1), the cell ends up as text "".

**Suggested fix**: when SkipCache, post-process to strip the `<v/>` element entirely for the affected cells. Or use a different umya code path.

---

## HIGH-6 — `Strict` import error message picks "first" feature non-deterministically

**Severity**: MEDIUM-HIGH (output non-determinism — same input file produces different Strict-mode error messages on different runs, depending on HashMap iteration order; small but real CI flake risk).

**Evidence — `crates/ql-io-xlsx/src/lib.rs:228-244`**:

```rust
let (first_kind, _count) = report
    .feature_inventory
    .counts
    .iter()
    .next()
    .expect("inventory non-empty per is_clean() check");
return Err(XlsxError::UnsupportedFeature {
    feature: *first_kind, ...
});
```

`FeatureInventory.counts` is `HashMap<UnsupportedFeatureKind, usize>` — iteration order is unspecified. Two CI runs against the same fixture get different `feature` fields in the error.

In `opus_a_edge_cases::import_strict_with_drawings`, output was:
```
strict: Some("xlsx unsupported feature Drawings in workbook: ...")
```
But on a re-run could be `ConditionalFormatting`, `Comments`, `MergedCells`, or `PivotTables`.

**Suggested fix**: sort counts entries by `UnsupportedFeatureKind` discriminant (derive `Ord`) and pick the lowest. Or report ALL kinds in the error detail.

---

## MEDIUM-1 — `feature_inventory` under-counts what `UpdateOriginal` Strict drops

**Severity**: MEDIUM (user inspects `inventory={Drawings: 6, ...}` and assumes Strict export will fail with at most 6 drawing entries; reality: 14 drops are emitted under `Drawings` kind because charts + vmlDrawing + rels-files are folded in via `classify_part`).

**Evidence — `opus_a_edge_cases::dropped_features_vs_feature_inventory_completeness`**:

```
inventory:                  {Drawings: 6, Comments: 2, MergedCells: 1, CF: 1, PivotTables: 5}
dropped_features grouped:    {Drawings: 14, Other("printer-settings"): 1, PivotTables: 5, Comments: 2}
```

Drawings inventory: 6; drops: 14 (8-item gap). Difference: `xl/charts/`, `xl/charts/_rels/`, `xl/drawings/_rels/`, `xl/drawings/vmlDrawing*.vml` — these contribute to drops via `classify_part` (`update_original.rs:296-313`) but not to inventory (`feature_inventory.rs:36-44` checks only `xl/drawings/` prefix, not `xl/charts/` or vmlDrawing).

Also: `Other("printer-settings")` shows up in drops but isn't even tracked in inventory.

**Suggested fix**: extend `PATTERNS` in `feature_inventory.rs` to match the same prefixes used by `classify_part` — `xl/charts/`, `xl/printerSettings/`, etc. Or document the inventory as "lower-bound only".

---

## MEDIUM-2 — `RecomputeMode::Strict` does not catch evaluation errors like `#NAME?`

**Severity**: MEDIUM (documented behavior, but the public-API doc string says "on first failure abort the whole import", implying any error fails — users wanting strict will be surprised that an unknown-function formula evaluates to `Value::Error(Name)` which Strict considers success).

**Reproduction** — `opus_a_cache_policy::recompute_strict_on_unknown_function`:

```rust
wb.put_formula(s, 0, 1, "TOTALLY_UNKNOWN_FUNCTION(A1)".to_string());
let r = import_xlsx_path(&tmp, &registry,
    XlsxImportOptions { recompute: RecomputeMode::Strict, .. });
// r is Ok — Strict did not fail.
```

**Root cause** — by design in `WorkbookRuntime::recompute_all`, only structural failures (lex/parse/bind) populate `RecomputeFailure`; eval-time `Value::Error(_)` is "a normal cell value" (`workbook_runtime.rs:307-311`).

The Phase 4.11 doc string for `RecomputeMode::Strict` at `options.rs:36-38` says:

> "Recompute every formula; on first failure abort the whole import with an error. Useful for strict CI pipelines that require full engine support."

A user reading "full engine support" expects unknown-function to fail Strict. But internally Strict is structural-only.

**Suggested fix**: clarify the docstring. Add a second `RecomputeMode` variant that fails on `Value::Error(*)` results.

---

## MEDIUM-3 — `[Content_Types].xml` `<Default>` case-sensitivity asymmetry

**Severity**: LOW-MEDIUM (potential for duplicate `<Default Extension>` entries if the shadow + original disagree on extension casing).

**Evidence** — `crates/ql-io-xlsx/src/write/update_original.rs:399-437`:

```rust
let shadow_defaults: HashSet<String> = collect_default_extensions(shadow_xml);
// later:
let ext_lower = def.extension.to_ascii_lowercase();
if shadow_defaults.contains(&def.extension) || shadow_defaults.contains(&ext_lower) {
    continue;
}
```

`shadow_defaults` is built without normalization; the membership test only catches "exact match" OR "lowercase match". If shadow has `Default Extension="PNG"` and original has `Default Extension="png"`, the original gets re-emitted (matches `to_ascii_lowercase` of itself but not the shadow's `PNG`, and `shadow_defaults.contains("png")` is false since the set only has `PNG`).

Also: `preserved_exts` IS lowercased (line 421-427) — so the inclusion-test path is asymmetric.

**Suggested fix**: lowercase BOTH sides at collection time: `shadow_defaults: HashSet<String> = collect_default_extensions(shadow_xml).into_iter().map(|s| s.to_ascii_lowercase()).collect();`. Same for `iterate_defaults`.

---

## MEDIUM-4 — `UpdateOriginal` shadow overwrites `xl/workbook.xml`, dropping original's `<bookViews>`, `<calcPr>`, `<fileVersion>`, sheet `state` attrs, `definedNames` not in our engine, etc.

**Severity**: MEDIUM (silent fidelity loss for workbook-level metadata; no `dropped_features` entry).

`classify_part` at `update_original.rs:354-359` flags `xl/workbook.xml` as "owned by shadow" — silently dropping all its content. But the original may contain:

- `<workbookView>` with last-active-sheet, window size, scroll position.
- `<calcPr calcId="...">` settings the user customized.
- `<fileVersion>` metadata Excel reads for compatibility hints.
- Sheet `state="hidden|veryHidden"` attrs (HIGH-3).
- Defined names whose target text didn't parse into our subset and stored via `NamedTarget::Formula(raw)` — these DO get re-emitted, but if the parsing was lossy (e.g., quoted-sheet edge cases) the round-trip text may differ.

**Suggested fix**: in `UpdateOriginal` mode, surgically inject only the parts Quantbook owns into the original's `xl/workbook.xml` rather than overwriting it wholesale (similar to how `<definedNames>` is currently injected). Or document this as a known v2 deferred item.

---

## MEDIUM-5 — `feature_inventory` lists "presence" of CF/DV/hyperlinks/protection but doesn't enumerate per-instance locations

**Severity**: MEDIUM (the inventory is a single "1" count per kind; the user can't tell "which sheet has CF" or "how many DV rules"; the export drop fails on the first one but the inventory looks like "just one issue").

`feature_inventory.rs:69-83` does `content.contains("<conditionalFormatting")` — a single boolean per sheet (not even per-instance). The `XlsxImportReport.unsupported: Vec<UnsupportedFeature>` field exists but `scan_unsupported_features` never populates it. So a user gets `inventory={CF: 1}` but no detail.

**Suggested fix**: populate `report.unsupported` with one entry per detected element (could re-parse the sheet xml to find the `sqref` of each CF rule). At least make it `(kind, part_path)` so the user knows which file.

---

## MEDIUM-6 — Numeric constants in defined names round-trip through string formatting, losing exponent-form precision boundary

**Severity**: LOW-MEDIUM (specific to numbers exactly at the i64↔f64 boundary; the `format_number_literal` switch at 1e15 means `1e16` survives via `format!("{}", n)` which Rust prints as `10000000000000000`. Excel may interpret that as an integer constant; calamine reads it back as `Float(1e16)`. The actual i64 boundary at 1e15 is fine).

**Tested**: `opus_a_edge_cases::name_numeric_constant_precision` — `1e-15`, `1e16`, `3.141592653589793`, `-123456789012345`. All round-trip exactly. No actual divergence observed in these cases. Keeping as a flag.

---

## LOW-1 — `xfId="0"` references potentially-empty cellStyleXfs table

**Severity**: LOW (umya emits a default cellStyleXfs but our injected cellXfs blindly use `xfId="0"`; if umya ever changes and emits `cellStyleXfs count="0"`, we'd have dangling refs).

**Evidence** — `crates/ql-io-xlsx/src/write/umya_export.rs:779-789`. All injected `<xf>` entries use `xfId="0"` referencing slot 0 of `<cellStyleXfs>`. We rely on umya's default cellStyleXfs always emitting at least one entry. No assert / no test covering it.

**Suggested fix**: defensive — also inject a `<cellStyleXfs count="1">` block if missing, OR explicitly set `xfId="0"` only when we know cellStyleXfs has slot 0.

---

## LOW-2 — `iterate_simple_self_closing` doesn't handle single-quoted attribute values

**Severity**: LOW (OOXML spec allows both `attr="value"` and `attr='value'`; Excel emits double-quotes but other tools may emit single-quotes).

**Evidence** — `crates/ql-io-xlsx/src/write/update_original.rs:528-532`:

```rust
fn extract_attr_value(snippet: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = snippet.find(&needle)? + needle.len();
    ...
}
```

Hardcoded `attr=\"` — single-quote attributes silently skipped.

**Suggested fix**: also try `format!("{attr}='")` if the double-quote lookup misses.

---

## LOW-3 — `parse_a1_cell` in `cell_styles_xml.rs` and `names_import.rs` is duplicated

**Severity**: LOW (duplication: `cell_styles_xml.rs:80-104`, `names_import.rs:168-191`, and `tables_xml.rs:222-242` all parse A1 cell refs with subtly different return conventions — col bounds checks differ).

Not a correctness issue today (each handles its case correctly) but a maintenance hazard.

**Suggested fix**: factor into a shared `read::a1` module.

---

## LOW-4 — `UnsupportedFeatureKind::Other("...")` variants leak strings across the API surface

**Severity**: LOW. `dropped_features` uses `Other("query-tables")`, `Other("rich-data")`, etc.; consumers can't pattern-match on these. Multiple slightly different strings (`"slicers-and-timelines"`, `"printer-settings"`) make programmatic filtering brittle.

**Suggested fix**: convert `Other(&'static str)` to a proper enum or add explicit variants for the categories `classify_part` produces.

---

## What looked right (positive coverage)

Tested deeply and verified clean:

- **Cell values for non-Error types** — 83388 / 92788 (89.9%) of cell-value round-trips were correct across the 177-fixture corpus. Number / Boolean / Text preserved exactly.
- **Formula text** — 66979 / 66979 (100%) formulas round-tripped with byte-identical text across the corpus.
- **Names (workbook + sheet-scoped)** — 39 / 39 names across the corpus round-trip with no drops, no divergence (3 used `NamedTarget::Formula(raw)` fallback, which round-trips via raw-text passthrough).
- **Tables** — 11 / 11 tables across the corpus, full metadata (display_name, sheet, footprint, header/totals flags, columns with ids + totals_function) preserved including sparse column ids (5, 7, 12).
- **Custom format codes** — 99 / 99 custom format codes across the corpus round-trip with identical strings.
- **Per-cell format overlay** — 59387 / 59387 overlay entries across the corpus round-trip at the same (sheet, row, col) with the same FormatId AND matching format code strings.
- **Format codes with XML-special characters** — `#,##0 "& foo"`, `0;[<5]0.00`, `0.00 "x" 0.00` round-trip byte-identical through the `xml_attr_escape`/`unescape_value` boundary.
- **Unicode** — sheet names with Russian + emoji ("test 📊"), table column displays in Cyrillic, format codes with €/¥, defined names with Cyrillic chars (`TaxРейт`) all survive.
- **Date system** — both `Excel1900` (default, omits `date1904`) and `Excel1904` (injects `date1904="1"`) round-trip correctly.
- **Sparse table column ids** — 5, 7, 12 preserved (not renumbered to 1, 2, 3).
- **Sheet-scoped names with cross-sheet targets** — `'S2'!$A$1` from a name scoped to S1 correctly round-trips with sheet pointer to S1=1.
- **Mixed-case names canonicalize identically** — `MixedCaseName` → `MIXEDCASENAME` on both passes; lookups are case-insensitive.
- **Overlay on cells of all value kinds** — text+format, error+format, blank+format (style-only cell injection), formula+format — all preserved.
- **Strict + `UpdateOriginal` does NOT touch pre-existing output file on error** — confirmed via sentinel-file probe (W5-D-14.2.2 H-B claim holds).
- **Sheet-with-only-blank-overlay-cells followed by a normal sheet** — overlay alignment preserved (W5-D-15.1 Codex HIGH-3 closure verified).
- **Two-custom-format-ids-same-code** — import doesn't panic; both register-attempts handled; but see HIGH-4 for the residual overlay-references-undeclared-id issue.
- **LibreOffice's `numFmt 164="General"` redundant declaration** — doesn't error import (W5-D-14.1 HIGH-8 closure verified); but see HIGH-4.
- **Format codes registered WITHOUT any cell using them via overlay** — round-trip preserved via `<numFmts>` block even though `<cellXfs>` has no cell using them.
- **Long text** — 100 000-char strings round-trip via sharedStrings exactly.
- **Text with XML-special / control chars / multi-line / leading-trailing whitespace / emoji** — all round-trip byte-identical.
- **VBA preservation** — Permissive lists in `dropped_features`; Strict errors with `UnsupportedFeature::Macros` BEFORE the output file is written.
- **All 177 fixtures import + export + re-import** — no panics, no failures.

---

## Summary

10 unique findings beyond the per-batch audits:

- **5 HIGH**: Formula+Error round-trip corruption (10% corpus blast); NewWorkbook ignores `unsupported_policy`; Sheet `state="hidden"` lost; Custom format ids referenced by overlay but not declared on export; `SkipCache` emits `<v/>` instead of omitting.
- **6 MEDIUM**: Strict-import error non-determinism; feature_inventory under-counts drops; Strict-recompute docs don't match reality; Content_Types `<Default>` case asymmetry; UpdateOriginal drops bookViews/calcPr/fileVersion silently; feature_inventory has no per-instance detail.
- **4 LOW**: cellStyleXfs xfId dependency; single-quote attr parsing; A1 parser duplication; `Other(&'static str)` string-leakage.

The HIGH-1 Error-cell drift is the single most impactful finding — it silently corrupts 10% of cell values in the corpus and likely a larger fraction in real-world workbooks that lean on `IFERROR`/`#N/A`/`#DIV/0!` cached values.

The per-batch audits missed HIGH-1, HIGH-2, HIGH-3, HIGH-4, HIGH-5 because each batch tested its own slice (W5-D-14.1 tested value-only error cells; W5-D-15 tested overlay-only; W5-D-14b parsed sheet state; W5-D-14.2 closed `unsupported_policy` flow only in `UpdateOriginal`). The megaudit picks up the cross-cutting consequences.

## Notes for the consolidated megaudit doc

Probes written during this audit (not part of the regular test suite, all `#[ignore]`):

- `crates/ql-io-xlsx/tests/opus_a_deep_probe.rs`
- `crates/ql-io-xlsx/tests/opus_a_edge_cases.rs`
- `crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs`
- `crates/ql-io-xlsx/tests/opus_a_misc.rs`
- `crates/ql-io-xlsx/tests/opus_a_cache_policy.rs`
- `crates/ql-io-xlsx/tests/opus_a_error_cell_probe.rs`
- `crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs`
- `crates/ql-io-xlsx/tests/opus_a_text_edge.rs`

These can be kept as ignored test infrastructure for future round-trip regression checks, or removed after the consolidated megaudit. They take 3-4 minutes each to run against the full 177-fixture corpus.
