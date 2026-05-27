# inc.2c-10 xlsx import + ql-io-xlsx dependency inversion — parallel Codex + Opus audit synthesis (2026-05-27)

**Scope:** `WorkbookSession::import("xlsx")` + the `ql-exec ↔ ql-io-xlsx` cycle break (dependency
inversion via `XlsxRecomputer`/`EngineXlsxRecomputer`) + the ~90-call-site test migration.

**Method:** parallel **Codex (gpt-5.5, xhigh, read-only)** + a fresh-context **Opus** source reviewer.
Every finding re-verified at source by the orchestrator before action. The ~90 mechanical test edits were
delegated to a separate fresh-context Opus agent and reviewed at source.

## Findings + dispositions

| # | Sev | Source | Finding | Disposition |
|---|-----|--------|---------|-------------|
| 1 | **HIGH** | both | `push_xlsx_import_diagnostics` iterated only `report.{unsupported, warnings, formula_failures}`, but the scanner records the BULK of dropped-feature fidelity loss (conditional formatting, data validation, merged cells, hyperlinks, protection, comments, drawings, images, pivots, macros, external links, hidden sheets) into a SEPARATE field — `report.feature_inventory.counts` — which the helper never read. Under `UnsupportedPolicy::Permissive` (the import default) those features drop on the wire with ZERO diagnostic, contradicting the helper's own docstring + No-Fallbacks. | **FIXED.** Verified at source (`feature_inventory.rs` records to `inventory`, not `report.unsupported`; only the numfmt case populates `unsupported`). `push_xlsx_import_diagnostics` now also drains `feature_inventory.counts` (sorted for deterministic event order) as `Warning` diagnostics. + regression test `xlsx_import_surfaces_feature_inventory_as_diagnostics`. |
| 2 | MEDIUM | Codex | `import`'s recompute (via `EngineXlsxRecomputer` → `WorkbookRuntime::recompute_all`) runs OUTSIDE the session's `with_runtime` `FaultGuard`, so a recompute panic wouldn't mark the session `Faulted` (contract §8). | **Assessed NON-BUG; documented.** Unlike `open` (which recomputes `self.workbook` in place under the guard), `import`'s recompute runs on a LOCAL workbook inside `import_xlsx_bytes` (`self` only lends `&registry`), and `self` is replaced solely by the atomic `*self = from_workbook(..)` AFTER a successful parse+recompute. No step leaves `self` torn → a panic leaves `self` in its prior valid `Ready` state; a `FaultGuard` would WRONGLY fault a healthy session. Added a "Panic safety (§8)" doc note to `import`. |
| 3 | INFO | Codex | Module doc + `session-api.md` §3.1 still said `import` deferred. | **FIXED** (docs): module doc + §3.1 now say `import("xlsx")` is v1-real; `import("csv")` + `export` deferred. |

## Verified correct (both reviewers, cited at source)
- **No cycle:** `ql-io-xlsx/Cargo.toml` — `ql-exec` is dev-dep ONLY; `ql-exec/Cargo.toml` — `ql-io-xlsx` is a
  normal dep; ZERO production `ql_exec` uses remain in `ql-io-xlsx/src/**`; `recompute_loaded_workbook` fully
  deleted.
- **EngineXlsxRecomputer fidelity:** faithful move of the deleted helper (same `WorkbookRuntime::recompute_all`
  + identical `FormulaImportFailure` mapping; the dropped `Result` wrapper was always `Ok`).
- **import Option-1 + atomicity:** the `?` returns before `*self = ...` (parse failure → session untouched +
  usable, test-proven); registry `Arc::clone` before / restore after; epoch re-minted; "no double recompute"
  sound (importer returns the recomputed workbook).
- **Recompute dispatch No-Fallbacks:** BestEffort/Strict + `None` → loud `XlsxError::Engine`; Skip is the only
  mode ignoring the recomputer.
- **map_xlsx_err:** all 8 `XlsxError` variants mapped; foreign `#[non_exhaustive]` wildcard → loud
  `unmapped_xlsx_error`; classes sensible.
- **The 3 `None` src lib-test sites:** behavior-preserving — nonexistent file fails at `fs::read`, invalid
  bytes fail at zip/OOXML parse (both before recompute), umya roundtrip uses `RecomputeMode::Skip`.
- **Bloat:** documented as a tracked follow-up (`ql-exec/Cargo.toml` comment + integration-plan doc); both
  reviewers: acceptable for v1, feature-gate the writer before WASM/bindings (6.3).
- **~90 test edits:** spot-checked uniform; BestEffort-exercising tests pass `Some(..)`, not `None`.

## Verdict
Opus: SHIP-WITH-FIXES (H1). Codex: 1 HIGH + 1 MEDIUM + INFO. After fixes: **ql-exec lib 723/0 + e2e 21/0,
clippy clean; ql-io-xlsx green; workspace build green.** Shipped.

Raw transcripts: `.codex-6-1b-inc2c10-xlsx-import-audit.out` (Codex) + the Opus reviewer report (session log).
