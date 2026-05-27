# xlsx import → WorkbookSession integration — refactor spec (SHIPPED inc.2c-10)

**Status:** ✅ SHIPPED 2026-05-27 (inc.2c-10) — chose **A2 (dependency inversion)** below. xlsx `import`
is live on `WorkbookSession`; `ql-io-xlsx` is now pure I/O. Parallel Codex+Opus audit clean after fixes.
This doc records the blocker + the executed fix; csv import + xlsx/csv export remain follow-ups.

> **Audit note (H1, both reviewers):** the dropped-feature diagnostics MUST drain
> `report.feature_inventory.counts` (the scanner's PRIMARY channel — CF/DV/merged-cells/comments/
> drawings/protection/hidden-sheets), NOT just `report.{unsupported, warnings, formula_failures}`.
> `push_xlsx_import_diagnostics` (`ql-exec/src/session.rs`) surfaces all four sources as `Warning`
> diagnostics; otherwise Permissive import would silently drop fidelity (No-Fallbacks violation).

## The blocker (verified at source)
`WorkbookSession::import` lives in **`ql-exec`** (`crates/ql-exec/src/session.rs`). The xlsx importer
`ql_io_xlsx::import_xlsx_bytes` lives in **`ql-io-xlsx`**, which **depends on `ql-exec`**
(`crates/ql-io-xlsx/Cargo.toml:33`) — its *only* use of `ql-exec` is the recompute phase:
`import_xlsx_bytes` → `read::convert::recompute_loaded_workbook` (`convert.rs:113-122`) →
`ql_exec::WorkbookRuntime::recompute_all`. So to call the importer from `WorkbookSession::import`,
`ql-exec` would need `ql-io-xlsx` as a dep → **`ql-exec → ql-io-xlsx → ql-exec` cycle** (Cargo forbids
it). `ql-io-xlsx` is currently a **leaf crate** (nothing depends on it — never wired into a consumer;
built standalone in Phase 4.11). Confirmed: recompute is the SOLE `ql-exec` use (grep clean otherwise).

## Target architecture (matches the established `.qbook` pattern)
The `.qbook` path already does it right: `ql_io::load_workbook` loads **raw** (no recompute);
`ql-exec::loader.rs::load_workbook_and_recompute` (and `WorkbookSession::open`, inc.2c-9) recompute.
**xlsx should match:** `ql-io-xlsx` becomes pure I/O (no `ql-exec` production dep); the engine layer
recomputes. Two ways to get there:

- **A1 — parse-only (purist).** Remove recompute from `ql-io-xlsx` entirely: drop `RecomputeMode`,
  `recompute_loaded_workbook`, and `report.formula_failures`; `import_xlsx_bytes` returns the raw-loaded
  workbook (Excel cached values + formula text) + report. `WorkbookSession::import` recomputes (exactly
  like `open`) and surfaces failures via its own `CellDiagnostic` events. **Cost:** removes tested,
  consumer-less functionality (Strict-recompute CI mode, formula_failures); reworks ~150 RecomputeMode/
  formula_failures/computed-value assertions across 11 test files. Highest churn.
- **A2 — dependency inversion (recommended).** Define `pub trait XlsxRecomputer { fn recompute_into(&self,
  wb: Workbook, registry: &FunctionRegistry, report: &mut XlsxImportReport) -> Workbook; }` in
  `ql-io-xlsx`. `import_xlsx_bytes`/`import_xlsx_path` take `recomputer: Option<&dyn XlsxRecomputer>`
  (Skip ⟺ `None`; BestEffort/Strict require `Some`, else loud `XlsxError::Engine`). The Strict-abort
  policy stays in `lib.rs` (inspect `report.formula_failures`). `recompute_loaded_workbook` is deleted;
  its logic moves into `ql-exec`'s trait impl. **Preserves all behavior + the report's fidelity tracking;
  smaller semantic churn** (assertions unchanged). Cost: ~90 test call-sites gain a `recomputer` arg.

**Recommendation: A2** — it's the textbook cycle fix, preserves tested functionality, and is lower-risk
than A1's deletion. (A1's "pure I/O" purity isn't worth deleting working, audited capability with no
consumer demand to remove it.)

## A2 execution steps
1. **`ql-io-xlsx/Cargo.toml`:** move `ql-exec` from `[dependencies]` to `[dev-dependencies]`
   (dev-deps may be cyclic — tests still recompute via the engine).
2. **`ql-io-xlsx/src/...`:** add the `XlsxRecomputer` trait (new small module or in `lib.rs`). Delete
   `read::convert::recompute_loaded_workbook` (move its body into the `ql-exec` impl, step 5). Thread a
   `recomputer: Option<&dyn XlsxRecomputer>` param through `import_xlsx_bytes` + `import_xlsx_path`;
   the Phase-3 dispatch (`lib.rs:351-373`) calls `recomputer.recompute_into(...)` for BestEffort/Strict
   (loud error if `None`), Strict-abort logic unchanged.
3. **`ql-io-xlsx/tests/*` (~90 call-sites, 11 files; `calamine_smoke.rs` 43 + `opus_a_phase_4_12_ide_proof.rs`
   17 dominate):** add a shared test recomputer (a `tests/common/` module impl'ing `XlsxRecomputer` over
   `ql_exec::WorkbookRuntime`, via the dev-dep) and pass `Some(&RECOMPUTER)` at each call. Build
   `cargo test -p ql-io-xlsx` green.
4. **`ql-exec/Cargo.toml`:** add `ql-io-xlsx = { path = "../ql-io-xlsx" }` (now acyclic). Verify
   `cargo metadata` / build has no cycle.
5. **`ql-exec/src/session.rs`:** add a `struct EngineXlsxRecomputer` impl `ql_io_xlsx::XlsxRecomputer`
   (the moved recompute logic: `WorkbookRuntime::new(&mut wb, reg).recompute_all()` → map
   `RecomputeFailure` → `ql_io_xlsx::FormulaImportFailure`). Implement `import(&mut self, bytes, "xlsx")`:
   `ensure_openable` → `import_xlsx_bytes(bytes, &self.registry, XlsxImportOptions::default(),
   Some(&EngineXlsxRecomputer))` (BestEffort default) `.map_err(map_xlsx_err)` → preserve registry →
   `*self = from_workbook(result.workbook)` → restore registry → surface `result.report` (`unsupported`
   + `warnings` as Warning `CellDiagnostic`; `formula_failures` as Warning with addr). NOTE: import
   already recomputed via the injected recomputer, so do NOT recompute again (unlike `open`). `"csv"` →
   `not_implemented` (still deferred — net-new, see below); unknown format → `BadArgument`.
   Add `map_xlsx_err(XlsxError) -> EngineError` (foreign `#[non_exhaustive]`; needs a wildcard):
   `Io`→Persistence/`xlsx_io`; `Zip`→Persistence/`xlsx_zip`; `Calamine`→Persistence/`xlsx_calamine`;
   `XmlParse`→Persistence/`xlsx_xml_parse`; `MalformedOoxml`→Persistence/`xlsx_malformed_ooxml`;
   `UnsupportedFeature`→Persistence/`xlsx_unsupported_feature`; `Export`→Internal/`xlsx_export`;
   `Engine`→Internal/`xlsx_engine`; `_`→Internal/`unmapped_xlsx_error`.
6. **Tests (`ql-exec` session mod):** round-trip via `ql_io_xlsx::export_xlsx_path` to build a fixture
   (no committed `.xlsx` fixtures exist) → read bytes → `import("xlsx")` → assert cells/values; malformed
   bytes → loud `Persistence`; unknown format → `BadArgument`; `"csv"` → `Capability`; epoch re-mint
   invalidates a prior delta token (like `open`).
7. **Docs:** session-api §3.1 import row REAL + Appendix A xlsx rows; impl-plan §0; MASTER-PLAN; memory.
8. **Audit:** parallel Codex (gpt-5.5 xhigh) + Opus, verify at source. Commit via the bridge with the
   blob-integrity check (commit-msg-file + `git commit -F`).

## CSV — separate, net-new (NOT in this refactor)
No csv importer/exporter exists anywhere in the tree. CSV is net-new (RFC 4180 parse, type inference,
quoting, multi-sheet semantics) — its own increment after xlsx import lands. Keep `import(_, "csv")` =
`not_implemented_in_v1_core`.

## Why this is a focused-session refactor, not a tail-of-session task
~90 mechanical test edits + a multi-crate public-API change + a fresh audit. Mechanical-edit-heavy
engine-core refactors are exactly where attention lapses cause subtle bugs; it deserves a fresh-context
session. inc.2c-9 (`.qbook` open/save) is shipped + clean and does not depend on this.
