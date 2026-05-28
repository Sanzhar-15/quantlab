# Lane D — Persistence (`.qbook`) · import/export (xlsx/csv) · op-log payload integrity · effective-extent cross-cutting (read-only)

You are auditing the **I/O round-trip correctness** of `WorkbookSession`: persistence (`.qbook` open/save), import/export (xlsx, csv), and the op-log payload integrity that backs them. **READ-ONLY** — verify at source; do not build/run/edit. Report findings as HIGH/MED/LOW/INFO with `file:line` anchors and a SHIP/REVISE verdict.

## Repo
- Engine worktree: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine` (branch `feat/quantbook-engine`).
- `rg` NOT installed → grep.

## Surface in scope
- Session-side persistence + I/O paths: `crates/ql-exec/src/session.rs` — find `open`, `save`, `import`, `export`. They were SHIPPED in inc.2c-9 (`.qbook` open/save, `2f92d84f3ed`), inc.2c-10 (xlsx import, `0e932da13a7`), inc.2c-11 (csv import/export, `54f51edfbc1`), inc.2c-12 (xlsx export + writer feature-gate, `eec9feb92bb`).
- `crates/ql-io/src/lib.rs` — `load_workbook_with_oplog`, `save_workbook_with_oplog`.
- `crates/ql-io-xlsx/src/lib.rs` + `src/import.rs` + `src/write/umya_export.rs` — the importer/exporter + the `XlsxRecomputer` trait + `EngineXlsxRecomputer` (the dependency-inversion).
- `crates/ql-io-csv/src/lib.rs` — the new pure-I/O leaf crate.
- `crates/ql-exec/src/xlsx_recompute.rs` — the engine-side `XlsxRecomputer` impl.
- `crates/ql-oplog/src/lib.rs` (or wherever the per-op payload `iter()` lives) — the validation hook (Codex HIGH from inc.2c-9 closed).
- `crates/ql-storage/src/sheet.rs` (or similar) — `Sheet::bounds` + `Sheet::put` (the conservative-bounds blank-inflation point that the cross-cutting tracker calls out).
- `crates/ql-io-xlsx/Cargo.toml` + `crates/ql-exec/Cargo.toml` — the `xlsx-write` feature-gate (inc.2c-12).
- Synthesis docs: `docs/audits/2026-05-27-inc2c{9,10,11,12}-*-audit/SYNTHESIS.md` — read each to know what was closed + what's tracked.

## Verify (with severity)

### D1 — `.qbook` `open` (inc.2c-9) — Option-1 adoption + payload validation
- `open(path)` reconstructs the workbook via `ql_io::load_workbook_with_oplog` and adopts it via `*self = from_workbook(loaded_wb)` (Option-1 LOCKED). Verify:
  - Fresh op-log (empty).
  - Fresh `UndoManager`.
  - `baseline = loaded_wb` (the Codex-HIGH-closing fix from inc.2c-7; required for correct undo of pre-loaded content).
  - Re-minted `epoch` (any pre-open `snapshot_delta` token reads as `EpochMismatch`).
  - Reset `state_seq`, `change_log`, `ops`, `events`, `txns`. Registry PRESERVED.
- Loaded op-log is FULLY validated (framing by `load_workbook_with_oplog` + per-op payloads by an explicit `iter()` loop — the Codex HIGH from the inc.2c-9 audit). Verify the per-op `iter()` validation is still in place + the synthesis at `docs/audits/2026-05-27-inc2c9-persist-audit/` describes the fix accurately.
- After validation, the loaded op-log is DISCARDED (Option-1 trade-off). Re-save writes only this session's edits — verify.
- `recompute` happens with the op-log DETACHED (saved computed values may be stale, mirrors `loader.rs::load_workbook_and_recompute`). Verify `with_runtime_no_oplog` is used.
- Gating: `ensure_openable` allows `New`/`Ready` (re-open replaces the doc). Document any escape that allows `open` in `Busy`/`Faulted`/`Closed`.

### D2 — `.qbook` `save` (inc.2c-9)
- `save(path)` writes `&self.workbook` + `&self.oplog` via `ql_io::save_workbook_with_oplog`.
- Atomicity: is the write atomic (write-to-temp + rename)? Or a partial-write window leaves a torn file? Read `save_workbook_with_oplog` source.
- Name derivation from path file-stem (no document-name metadata in v1). `None` → loud `BadArgument`. Verify.
- Gating: `ensure_readable`. Verify.
- Idempotency: repeated `save(path)` calls produce byte-identical output? (Tests for resave-stability were added in inc.2c-9; verify they exist.)

### D3 — `map_persistence_err` (inc.2c-9) — Appendix-A completeness
- `map_persistence_err` (in `session.rs`) maps the foreign `#[non_exhaustive]` `PersistenceError` to `EngineError`. Variants covered (per inc.2c-9 synthesis): `Persistence/qbook_error`, `session_oplog`, `qbook_unsupported_version`, `qbook_truncated_header`. Wildcard `_` → loud `Internal/unmapped_persistence_error` (No-Fallbacks).
- Verify: no Persistence variant is silently swallowed or downgraded.

### D4 — xlsx `import` (inc.2c-10) — dependency inversion correctness
- The `ql-exec ↔ ql-io-xlsx` cycle was broken via dependency inversion: `pub trait XlsxRecomputer` in `ql-io-xlsx`; `ql-exec → ql-io-xlsx` normal dep; `ql-io-xlsx → ql-exec` only `[dev-dependencies]`. Confirm in both `Cargo.toml`s.
- `import_xlsx_bytes(bytes, options, recomputer: Option<&dyn XlsxRecomputer>)` — BestEffort/Strict REQUIRE the recomputer (loud `XlsxError::Engine` if `None`); Skip ignores. Verify.
- `WorkbookSession::import("xlsx")` parses with `Some(&EngineXlsxRecomputer)` (recomputes during import) → Option-1 adoption (`*self = from_workbook`, registry preserved, epoch re-minted; NO second recompute) → `push_xlsx_import_diagnostics`. Verify.
- `push_xlsx_import_diagnostics` includes `feature_inventory.counts` (the Codex+Opus HIGH from inc.2c-10 — the PRIMARY dropped-feature channel). Verify the fix held.
- `map_xlsx_err` Appendix-A: `Io/Zip/Calamine/XmlParse/MalformedOoxml/UnsupportedFeature → Persistence`; `Export/Engine → Internal`; wildcard `_ → unmapped_xlsx_error`. Verify.
- The Codex MED from inc.2c-10 (recompute outside the FaultGuard): assessed NON-BUG (atomic self-replace; documented). Verify the doc still reflects this + the reasoning is sound.

### D5 — xlsx `export` (inc.2c-12) — in-memory bytes + feature-gate
- `export_xlsx_bytes(workbook, registry, options)` serialises to a `Vec<u8>` in memory (no tempfile) via umya's `write_writer<W: io::Write>`. Verify.
- The path exporter `export_xlsx_path` / `export_new_workbook` now delegates to the shared `export_new_workbook_to_bytes` core + one `atomic_write_to_path`. `post_process_zip(path,…)` became the bytes-in/bytes-out `post_process_bytes(Vec<u8>,…)`. The Codex+Opus inc.2c-12 audit verified `write_writer ≡ write` byte-equivalence at the umya source — verify the equivalence still holds (read umya's `writer::xlsx::write_writer` if accessible).
- `export_xlsx_bytes` is `NewWorkbook`-only (UpdateOriginal → loud `XlsxError::Export`). Verify.
- **Feature-gate** (closes the inc.2c-10 writer-leanness follow-up): ql-io-xlsx `umya-spreadsheet` is `optional`; `[features] default=["write"]`, `write=["dep:umya-spreadsheet"]` gates `mod write` + `export_xlsx_path` + `export_xlsx_bytes`. The READER (calamine/zip/quick-xml + `import_xlsx_*` + `XlsxRecomputer`) is ALWAYS compiled. Verify in `ql-io-xlsx/Cargo.toml`.
- `ql-exec` depends `default-features = false` + `[features] xlsx-write = ["ql-io-xlsx/write"]`; `export("xlsx")` is real behind `#[cfg(feature = "xlsx-write")]`, else honest `Capability/not_implemented_in_v1_core`. Verify in `ql-exec/Cargo.toml` + `session.rs`.
- A `ql-exec` `[dev-dependencies]` re-enables `write` for the inc.2c-10 import round-trip test fixture; workspace `resolver = "2"` keeps it out of the normal lib build. Verify in `Cargo.toml`s.
- **Tracked INFO from inc.2c-12** (folded into the cross-cutting tracker, see D7): a pre-existing HashMap-ordered fresh-sheet-rels emission in the xlsx exporter (`umya_export.rs` around `:424` area). Surface it again here.

### D6 — csv `import`/`export` (inc.2c-11) — pure-I/O leaf
- `ql-io-csv` deps: `csv = "=1.3.1"` + `ql-storage` + `ql-types` + `thiserror`. **NOT** `ql-exec`. Verify (true leaf, no cycle risk).
- `import_csv_bytes` — type inference: empty→Blank skipped; `TRUE`/`FALSE`→Boolean; finite f64→Number, `inf`/`nan`→text; leading `=`→**text** (injection-safe); BOM-stripped; UTF-8-strict; engine-limit guarded BEFORE `put_at` (never panics). Verify each rule.
- `import("csv")` = Option-1 adoption + NO recompute (CSV has no formulas). Verify.
- `export_csv_bytes(workbook, sheet_id, options)` — single LIVE sheet only; `sheet_display_order` minus `is_sheet_removed`; 0→empty, 1→serialise, >1→loud `BadArgument` (no silent drop). Verbatim/value-only; no formula-trigger escaping (faithful-export stance documented).
- `map_csv_err` Appendix-A: `Io/Parse → Persistence csv_io/csv_parse`; `ExceedsSheetLimits → BadArgument csv_exceeds_limits`; `SheetNotFound → Internal csv_sheet_not_found`; wildcard `_ → unmapped_csv_error`. Verify.

### D7 — Cross-cutting: storage-level effective-non-blank-value extent (TRACKED HIGH-value)
- The Codex inc.2c-11 HIGH (assessed consistent-with-siblings + documented + tracked): csv/xlsx/.qbook all iterate the **conservative `Sheet::bounds`**, which `Sheet::put` grows EVEN on a `Blank` write. A blank-inflated workbook (many cells written to then cleared) emits a giant rectangle on export. Triple-check at source:
  - csv: `export_csv_bytes` in `crates/ql-io-csv/src/lib.rs` (find the `for row in 0..bounds.row_extent` pattern).
  - xlsx: `umya_export.rs` ~`:424` area.
  - .qbook: `qbook_format.rs` ~`:1422` area.
- All three use the IDENTICAL pattern. Confirm.
- The cross-cutting fix proposal: a `Sheet::effective_bounds()` (or similar) that returns the smallest rectangle containing only non-blank cells. Or a per-call iterator that skips blanks. Or a normalize-on-`put(Blank)` pass that shrinks bounds. Which is right?
- Severity for 6.1C: blocking-on-exit or filed-as-tracked?
- Also: the inc.2c-12 INFO (HashMap-ordered fresh-sheet-rels emission in the xlsx exporter). Same locus. Fold into the same fix?

### D8 — Op-log payload integrity end-to-end
- The Codex HIGH from inc.2c-9 (sidecar payload-validation gap on `open`) is closed via the explicit `iter()` loop. Verify the loop walks EVERY op payload + fails loud on a corrupt one.
- What about an op-log written THIS session and then read on `open`? The payload should be valid by construction; the round-trip test exists (resave-stability) — verify.

### D9 — `OPLOG_SCHEMA_VERSION`
- inc.2c-6 added `Op::ClearValue` and **deliberately did NOT bump** `OPLOG_SCHEMA_VERSION` (additive variant). Is that the right call? An older reader sees an unknown variant — does it fail loud or silently skip?
- More broadly: every additive op variant has the same question. Document the policy.

## Output format
- Bullet list of findings (severity, `file:line`).
- D7 cross-cutting: a concrete fix proposal (the simplest sound one).
- SHIP / REVISE verdict.
- "Verified clean" list.

If you cannot ground a claim, mark it speculation/INFO.
