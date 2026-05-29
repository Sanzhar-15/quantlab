# MEGAUDIT Lane B (Codex) — Quantbook 6.4-3c: pathological inputs, deadline, worker lifecycle, graph

You are an adversarial auditor running the DESTRUCTIVE / EDGE-CASE / LIVENESS lane. A separate lane
covers line-by-line correctness; YOU hunt the cases the happy-path tests miss. FIND DEFECTS; rate
HIGH/MEDIUM/LOW; report at ~55% confidence.

## Working root & scope
`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`, branch
`feat/quantbook-engine`, code HEAD `a9ef3f252ca`. Increment: `git diff 88c0dc5836a..a9ef3f252ca`.
The UDF eval path: `scalar.rs` (`marshal_udf_args` / `dispatch_udf` / `map_udf_error` + the `None`
arm + the `eval_at_cell_boundary` UDF guard), worker threaded through `env.rs` / `workbook_runtime`
/ `session.rs` / `transaction.rs`, talking to `crates/ql-udf` (`ProcessWorker` / `MockWorker` /
codec). Read the actual files.

## Attack surfaces — be concrete, cite file:line

1. **Pathological grids / shapes.** A UDF returning: a 0×N or N×0 (degenerate) grid; an enormous grid
   (does it spill into occupied cells? overwrite formulas? unbounded memory?); a 1×1 vs the scalar
   path; a grid whose cells are themselves errors. Trace the cell-boundary `EvalResult::Array` →
   `write_spill` path: spill collision, spill over a UDF's own arg cells, spill bounds, `#SPILL!`.
2. **The 30s deadline math (`UDF_CALL_DEADLINE`).** It is PER-CALL on the synchronous recalc thread
   under the napi `Mutex`. Quantify the worst case: a `recalc_all` over N hung UDF cells. Is the
   deadline recomputed correctly per call (`Instant` math, overflow)? Can a UDF that returns JUST
   under 30s repeatedly wedge a workbook? Is there ANY cancellation between cells? Cross-lock /
   reentrancy deadlock with the worker process?
3. **Worker death / respawn DURING a multi-cell recompute.** `ProcessWorker` lazily respawns after a
   timeout-kill. If cell 1 times out (kills+respawns the worker) and cells 2..N also call it in the
   SAME recompute, what happens — correct results, cascading timeouts, a half-dead worker, a borrow
   held across respawn? The `RefCell<Box<dyn UdfWorker>>` is `borrow_mut`-ed in `dispatch_udf`; the
   respawn happens inside `worker.call` — any panic/poison? Drop semantics (the 6.4-3b detached
   reader thread) when the session drops mid-recompute?
4. **FaultGuard × panic × napi boundary.** If ANY new code panics (a double-borrow, an `unreachable!`,
   an arrow codec panic inside `worker.call`), does it seal the session Faulted, and does the panic
   cross the napi FFI boundary safely (no UB, no `catch_unwind` gap)? Is `dispatch_udf` REALLY
   panic-free for every `UdfError` variant + every worker return?
5. **Determinism / volatility / graph correctness.** Are UDF cells volatile (recompute when deps
   change AND on `mark_volatiles_dirty`)? A UDF reading A1 via an arg — is the A1→UDFcell dependency
   edge actually recorded so editing A1 recomputes the UDF? (Trace `functions_used` + the dep graph.)
   Snapshot/snapshot_delta/undo-redo of a UDF result cell and its spill — consistent + deterministic
   ordering? Does a UDF result persist correctly across save/load (.qbook) or get recomputed?
6. **Arg-marshalling adversarial:** `=MYUDF(A1:A1048576)` (whole-column-ish huge range as the single
   grid arg — memory?); a named range that resolves to a huge area; `=MYUDF(SEQUENCE(2,2))` vs
   `=MYUDF(SEQUENCE(1000,1000))` (the audit-fix passes the full produced grid now — bound?); error
   propagation when an arg is `#REF!`.

## Output
Per finding: `[HIGH|MEDIUM|LOW] <title>`, file:line, concrete defect + failure, fix. `CLEAN: <why>`
for genuinely-clean areas. End with H/M/L counts + SHIP / SHIP-WITH-FIXES / DO-NOT-SHIP. No invented
severity.
