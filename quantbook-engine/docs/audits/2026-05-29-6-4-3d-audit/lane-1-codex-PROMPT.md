# Adversarial audit — Quantbook engine Phase 6.4-3d (UDF worker-injection: engine blockers + napi)

You are a skeptical Rust auditor. FIND DEFECTS in a freshly committed increment; do NOT praise it.
Rate each finding HIGH / MEDIUM / LOW. Report a concern even if you are only ~55% sure — it is cheaper
to dismiss a false positive than to miss a real bug. Be concrete: file:line + why it is wrong + the
trigger.

## Repo / scope
Repo root: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`
Branch `feat/quantbook-engine`, HEAD `0de9f1fd7b5`. `rg` is NOT installed — use `grep -rn`.
The increment is `git diff bf261d6bd53..0de9f1fd7b5 -- crates/` (run it; also pre-written to
`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/.6_4_3d_src.diff`). 9 files,
+760/-64: ql-exec {env.rs, scalar.rs, calcgraph_session.rs, session.rs, workbook_runtime/{mod,recompute,cells}.rs}
+ ql-bindings-node {Cargo.toml, src/lib.rs}.

Design context (`docs/phase6/6-4-3-design.md` §top records the blockers). This increment closes the three
6.4-3c-megaudit blockers that gate Python-UDF worker injection, plus the napi bridge:

- **G (CellDiagnostic sink):** `scalar.rs::dispatch_udf` emits a structured per-cell diagnostic
  (codes udf_no_worker/udf_raised/udf_timeout/udf_worker_died/udf_cancelled/udf_handshake/udf_protocol/
  udf_codec) ADDITIVELY (the cell VALUE mapping in `map_udf_error` is unchanged). Mechanism: a ql-exec-local
  `env::UdfCellDiagnostic` + a DEFAULTED `CellEnv::push_udf_diagnostic` (only `WorkbookEnv` overrides) +
  `WorkbookSession.udf_diagnostics: RefCell<Vec<_>>` lent through `WorkbookRuntime::with_session_state[_no_oplog]`
  + the env ctor `WorkbookEnv::with_formula_cell_worker_and_diagnostics` (used at recompute.rs + cells.rs
  sites; transaction.rs keeps the worker-only ctor → None collector) + drained into `Event::CellDiagnostic`
  by a new `WorkbookSession::drain_udf_diagnostics()` called in BOTH `with_runtime` and `with_runtime_no_oplog`
  AFTER `drop(guard)`.
- **C1 (literal multi-cell range deps):** `FormulaDeps.literal_ranges: Vec<Range>` + a `walk_plan_for_deps`
  RangeRef multi-cell else-arm (`deps.literal_ranges.push(*range)`) + a registration loop through the EXISTING
  range-keyed `register_range_dependency` (graph crate untouched) + `is_empty`/`len` updates + the
  `recompute_dirty` VEQ clause `|| !deps.literal_ranges.is_empty()`. So `=MYUDF(A1:A2)` (Reference-context UDF)
  re-evals on edits inside the range.
- **D (non-destructive open/load):** D1 = `self.udf_worker.take()` + restore across `*self =
  from_workbook_with_registry(..)` in open / xlsx-import / csv-import. D2 = in `try_recompute_with_simd_profile`,
  if `preserve_saved_udf_when_no_worker && self.udf_worker.is_none() && plan_references_udf(plan, registry)`,
  read the cell's existing computed value and return it WITHOUT clearing the spill. `preserve_saved_udf_when_no_worker`
  is a bool threaded through try_recompute_one_cached / _with_aggregate_cache / _with_simd_profile; `recompute_all`
  passes `true`, `recompute_dirty` passes `false`. `plan_references_udf` builds a `FormulaDeps`, runs
  `walk_plan_for_deps`, checks `functions_used` against `registry.udf_handle`.
- **napi:** `PythonWorkerConfigJson` `#[napi(object)]` DTO + `Session::setUdfWorker` builds a
  `ql_udf::ProcessWorker`, calls `ensure_started()` EAGERLY (outside the `self.inner.lock()`), maps errors via
  `udf_spawn_error_to_napi` (Handshake → `[worker_handshake]`, else → `[worker_spawn_failed]`), then
  `self.inner.lock().set_udf_worker(Box::new(worker))`.

## Hunt especially for
1. **D2 spill-skip soundness** — does returning the existing value WITHOUT clearing the spill leave the calc
   graph / spill registration in a consistent state? Can a stale spill-anchor + a preserved value diverge?
   Is reading `workbook.read(addr)` the right "existing computed value"? Is the early-return's
   `(existing, simd_eligible, None, None)` tuple correct for both recompute_all and (false-gated) recompute_dirty?
2. **D2 load-only scoping** — is `preserve_saved_udf_when_no_worker=false` for recompute_dirty actually
   correct/safe? Any path where recompute_all is NOT the load path (so preserve fires when it shouldn't)?
   Conversely any LOAD path that does NOT pass true? Check `rematerialize` (undo/redo) — it calls
   `recompute_all` too (session.rs ~828): does preserving saved UDF values there corrupt undo/redo?
3. **D1 worker-move soundness** — `take()` then `*self = ..` then restore: is the drop-order correct (old self
   holds None → no child kill)? Any panic between take and restore that loses the worker? Is it sound across
   ALL THREE swap sites (open recomputes after; xlsx/csv do not)?
4. **C1 dep correctness** — the over-tracking (ISFORMULA/FORMULATEXT multi-cell literal ranges now get a dep).
   Is the VEQ clause correct? Does the storage-gate (`!deps.is_empty()`) / reverse-index cleanup handle
   literal_ranges (leak on re-bind)? Is `register_range_dependency` truly name-agnostic? Any double-registration
   / dedup concern vs named_ranges?
5. **G borrow/drain timing** — the `RefCell<Vec<UdfCellDiagnostic>>` is lent into the runtime AND drained by
   the session after drop(guard). Any borrow_mut overlap / re-entrancy / double-borrow panic? Does the drain
   run on EVERY path that dispatches a UDF (set_formula, recompute_all, recompute_dirty, batch)? Any path that
   dispatches but does NOT drain (leaked diagnostics or, worse, a borrow held across the next runtime)?
   The standalone WorkbookTransaction commit path uses the worker-only ctor (None collector) — is that a silent
   gap (a UDF failing in a txn emits no diagnostic)?
6. **G + FaultGuard** — does any new code path panic (so the FaultGuard seals the session)? `dispatch_udf`
   must stay panic-free. `drain_udf_diagnostics` borrow_mut after drop(guard) — can it panic?
7. **napi** — `setUdfWorker`: is calling `ensure_started()` OUTSIDE the lock then `set_udf_worker` INSIDE a
   TOCTOU / correctness problem? Can a panic in the napi method cross the catch_unwind-free boundary (the 6.4-2
   bad-name-panic class)? Is the BigInt-style validation present where needed? handshakeTimeoutMs `as u64` cast
   — overflow/precision? Does `ProcessWorker` being Send keep the session Send (the assert)? Does re-calling
   setUdfWorker (replace) drop+kill the old worker correctly?
8. **Send/!Sync** — `WorkbookSession` gained `RefCell<Vec<UdfCellDiagnostic>>` (Send, !Sync). Still Send? The
   `WorkbookRuntime` gained `Option<&RefCell<Vec<UdfCellDiagnostic>>>`. Any Sync requirement violated?
9. **Tests** — do the +4 tests actually prove what they claim? Is the C1 test's UDF really non-volatile (so the
   re-eval proves the dep, not volatility)? Does the D test's save/open round-trip actually exercise D2 (no
   worker) and D1 (worker preserved)?

Write your findings to your final message: a numbered list, each with severity, file:line, the trigger, and a
suggested fix. If you find nothing in a category, say so explicitly. Do not summarize the diff back to me —
report defects.
