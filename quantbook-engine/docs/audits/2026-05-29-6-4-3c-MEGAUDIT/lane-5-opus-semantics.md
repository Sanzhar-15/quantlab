# Lane 5 — Opus semantics / calc-graph / cross-cutting / persistence

Verdict: **SHIP-WITH-FIXES** · HIGH 1 · MED 2 · LOW 3 · 29 tool uses / 97.2k tokens. All 14 UDF lib tests pass.

## HIGH — Saved UDF values destroyed on every open/load (no worker at load)
`session.rs:1135-1142` (`open`) does `*self = Self::from_workbook_with_registry(wb, registry)` (resets `udf_worker: None`) then immediately `recompute_all` with the now-`None` worker → every `=MYUDF(...)` re-evaluates to `#CALC!`, overwriting the value `load_workbook` restored from disk; a spilled UDF region collapses to a single `#CALC!` anchor. `loader.rs::load_workbook_and_recompute` uses `WorkbookRuntime::new` (no worker channel at all). `import` follows the same replace-then-recompute pattern. Invisible data-loss on reopen until the host re-injects a worker AND `recalc_all`s. [Reconciliation: real, but no PRODUCT injection path exists at 6.4-3c — `set_udf_worker` isn't over napi — so it's reachable only by a Rust embedder; the correct fix (preserve/inject worker on open, gated by trusted-workspace) is the 6.4-3d worker-lifecycle surface. Disposition: PINNED by a test + documented as a 6.4-3d blocker, not code-fixed in 6.4-3c, because preserving a live worker across opening an untrusted workbook is a trust-boundary decision 6.4-3d owns.]

## MEDIUM — `#CALC!` conflates no-worker / Python-raised / worker-died
`map_udf_error` maps everything except `Timeout` → `#CALC!`, and no-worker also → `#CALC!`. "Forgot to attach a worker" vs "your Python raised" vs "worker died" are indistinguishable. The CellDiagnostic sink is deferred; flagging that the no-worker case is categorically a config error. Filed-forward to 6.4-3d (CellDiagnostic).

## MEDIUM — Aggregate recalc stall (per-call 30s under the session mutex)
Documented (Codex MED / Opus concurrency). Belongs to 6.4-3d (op-level budget).

## LOW findings
- **LOW** no persistence/snapshot/undo test coverage for UDFs (a round-trip test would have caught the HIGH). Filed.
- **LOW** no `unregister → recalc → #NAME?` test (register-side fanout is tested; unregister-side isn't).
- **LOW** cell-boundary UDF-guard exclusivity is construction-dependent (relies on `default_registry`'s boot assert), not structural. No wrong result today.

## Point verdicts
1. Dependency edges — CLEAN for `CellRef` + `AggregateNameRef` (named ranges via stripe); `=MYUDF(SEQUENCE(2,2))` deps correct. [Reconciliation: Codex-B separately found multi-cell LITERAL `RangeRef` args of a Reference-context UDF are NOT dep-tracked — a narrow gap this lane did not cover.]
2. Volatility — CLEAN (host-declared; recomputes when declared Volatile). [Reconciliation: Codex-B found the SESSION `mark_volatiles_dirty` bypasses fanout — FIXED this cycle.]
3. Spill — CLEAN (reuses the tested `write_spill` machinery). [Codex-B flagged spill-delta under-report = the tracked 6.1C H3, affects all arrays, inherited not UDF-specific.]
4. Persistence — the HIGH above.
5. Snapshot/delta/undo — CLEAN aside from the inherited H3.
6. Excel-compat of v1 cuts — CLEAN (all VISIBLE, never silent-wrong).
7. Substrate interaction — CLEAN (metadata volatility, eval-time `udf_handle`, `set_udf_worker` + in-flight txn handled by the CODEX-HIGH-2 fix).
