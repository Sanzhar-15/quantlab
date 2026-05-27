# inc.2c-11 — CSV import/export — parallel Codex + Opus audit synthesis (2026-05-27)

**Scope:** the new pure-I/O crate `ql-io-csv` (`import_csv_bytes`/`export_csv_bytes`) + the
`WorkbookSession::import("csv")`/`export("csv")` wiring + `map_csv_err`, in
`crates/ql-io-csv/src/lib.rs` and `crates/ql-exec/src/session.rs`. `export("xlsx")` stays honest
`not_implemented_in_v1_core` (inc.2c-12).

**Reviewers:** Codex (gpt-5.5, reasoning xhigh, read-only) + a fresh-context Opus source reviewer.
Every finding re-verified at source by the orchestrator before action.

## Findings + dispositions

### Codex HIGH / (Opus rated this area SHIP) — export rectangle uses conservative `Sheet::bounds`
`export_csv_bytes` iterates `0..row_extent × 0..col_extent` from `Sheet::bounds()`, and
`Sheet::put` (`crates/ql-storage/src/sheet.rs:174-184`) grows `bounds` **even on a `Value::Blank`
write** — so a workbook that has had a far cell *cleared* (`set_value(far, Blank)`, the inc.2c-6
path) carries an inflated used-range, and export would emit a giant all-blank rectangle.

**Verified at source + disposition — match the audited sibling pattern, document, track the
cross-cutting fix (NOT a CSV-local divergence).** The *identical* `for row in 0..bounds.row_extent {
for col in 0..bounds.col_extent { sheet.read(..) }}` pattern is used by the xlsx exporter
(`crates/ql-io-xlsx/src/write/umya_export.rs:424-426`) and the `.qbook` saver
(`crates/ql-io/src/qbook_format.rs:1422-1443`) — both shipped through prior Codex+Opus audits. So
this is a **pre-existing, codebase-wide property of the conservative `bounds` serialization
contract**, not a CSV bug. Fixing it only in CSV would diverge from the two sibling exporters,
duplicate non-trivial effective-extent logic, and leave the shared root unaddressed. The correct fix
is a **uniform storage-level effective-(non-blank-value)-extent API** adopted by all three
serializers — filed as a tracked cross-cutting follow-up. Documented in the `ql-io-csv` module docs
+ `export_csv_bytes` doc. Note: the common round-trip path is unaffected — a freshly *imported* CSV
skips blank fields, so its bounds track real data.

### Codex MEDIUM — CSV export does not escape formula-trigger text (`=1+1` → `=1+1`)
A consuming spreadsheet app opening the exported CSV could interpret `=…` as a formula (CSV
injection).

**Disposition — keep faithful/verbatim export; fix the doc claim's scope.** Silently prefixing `'`
(the OWASP mitigation) would mutate the user's data, break round-trip fidelity, and hide data — a
No-Fallbacks violation — and it is NOT what Excel/Google Sheets do on CSV export (they export
verbatim). CSV-injection mitigation is the consuming app's import responsibility. Fix applied: the
module-doc injection-safety claim is now scoped to **import** (import never interprets a field as a
formula), and an explicit "export is verbatim; opt-in sanitiser is a future extension" note was
added. No behavior change (faithful export is correct).

### Codex LOW — numeric inference is lexically lossy (`00123` → 123, `+44` → 44)
**Disposition — keep (Excel-consistent + documented); pinned with a test.** Excel's CSV import loses
leading zeros / `+` signs the same way; the "round-trip-exact" alternative over-rejects legitimate
numbers (`1.0` renders as `1`). Module docs already call this out; added
`import_numeric_inference_is_excel_like_and_lossy` to pin it.

### Opus I3 (INFO) — leading UTF-8 BOM not stripped → corrupts cell (0,0)
**Verified + FIXED.** The `csv` crate does not strip a leading `EF BB BF` (which Excel's "CSV UTF-8"
export emits), so it would prepend U+FEFF to the first field. `import_csv_bytes` now strips a leading
BOM before parsing; pinned by `import_strips_leading_utf8_bom`.

### Codex INFO / Opus L1+I1 — stale docs/comments
**FIXED.** session.rs module doc + `import`/`deferred_methods` comments updated to reflect csv
shipping; contract `session-api.md` §3.1 rows + Appendix A `CsvError` row added; impl-plan §0,
MASTER-PLAN, _active.md, memory synced.

## Independently confirmed by BOTH reviewers (verified at source)
- Row/column limit guards sit BEFORE `put_at` and are off-by-one correct (`idx > MAX` vs the storage
  `assert idx <= MAX`) — no panic reachable from arbitrary bytes.
- `import("csv")` adoption is atomic on failure: a parse error returns before `*self = from_workbook`,
  leaving the session untouched + usable (`ensure_openable` gates New/Ready).
- No-recompute on csv import is safe — only literal `Value`s are written (no formulas), so
  `from_workbook` leaves no Pending/dirty mis-report.
- `export("csv")` multi-sheet refusal correctly filters tombstoned sheets (`sheet_display_order`
  minus `is_sheet_removed`) and refuses loudly rather than dropping sheets.
- `ql-io-csv` is a genuine leaf (no normal dependency back to `ql-exec`).
- `map_csv_err` maps every variant explicitly + a loud `unmapped_csv_error` wildcard (No-Fallbacks).

## Tracked follow-ups
1. **(cross-cutting) Effective non-blank-value extent for all serializers.** Add a storage-level
   `Sheet` API for the true non-blank value bounding box; adopt it in csv + xlsx + `.qbook` export so
   a blank-inflated `bounds` cannot produce a giant output. Affects all three; do it once.
2. **(inc.2c-12) Feature-gate the xlsx WRITER** (umya + image/rav1e/exr/tiff) so `ql-exec`/WASM/
   bindings stay lean; needed alongside `export("xlsx")` + `export_xlsx_bytes`.
3. **(future) Opt-in CSV-export formula-trigger sanitiser** for callers that want OWASP-style
   escaping (default stays faithful).
