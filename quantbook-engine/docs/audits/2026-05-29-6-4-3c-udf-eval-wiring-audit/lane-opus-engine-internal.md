# Lane 2 — Opus fresh-context, engine-internal adversarial review

Verdict: **SHIP-WITH-FIXES** · HIGH 0 · MED 3 · LOW 3 · 62 tool uses / 135.6k tokens.

## Dimension-by-dimension (verbatim)

### 1. RefCell re-entrancy / double-borrow — CLEAN
`dispatch_udf` takes `worker_cell.borrow_mut()` and holds it across `worker.call(...)`. Both call sites call `marshal_udf_args` to FULL completion *before* `dispatch_udf`. `marshal_udf_args` never touches `env.udf_worker()`. For nested `=MYUDF(MYUDF2(A1))`, the inner UDF takes and *releases* its own `borrow_mut` inside its own `dispatch_udf`, returns a `Value`, and only then does the outer `dispatch_udf` borrow. `UdfWorker::call(&mut self, ...)` gives the worker NO access to the env/registry/RefCell, so neither MockWorker nor ProcessWorker can re-enter eval. The `nested_udf_evaluates` test exercises exactly this. No path holds two borrows. Verified sound.

### 2. FaultGuard panic-freedom — CLEAN (one dead-fallback nit, LOW-1)
Enumerated every panic-class construct: `marshal_udf_args` `unreachable!()` is truly unreachable (`is_range_like` admits exactly the four shapes the match handles); `ArrayValue::new(...).map_err(...)` returns Err never panics; boundary `.expect()` is sound (guard guarantees Some); `borrow_mut()` cannot panic (proven #1); accessors are non-panicking. The `udf_with_no_worker_is_calc_not_panic` test asserts the session stays usable. Dispatch is panic-free.

### 3. Send / !Sync soundness — CLEAN
`+ Send` present at every declaration site. `Arc<Mutex<T>>: Send` needs only `T: Send`, so `assert_send::<CoreWorkbookSession>()` still compiles despite `WorkbookSession` being `!Sync`. Grepped ql-exec + ql-calcgraph: NO rayon/par_iter/thread::spawn in the eval path; the SIMD aggregate path reads `ColumnStore::iter_chunks` and bypasses `CellEnv` entirely. The `!Sync` is confined to the single recalc thread.

### 4. Arg marshalling — CLEAN, with one observation (MEDIUM-1)
`is_range_like` verified complete against the full `ExprPlan` variant list — the only multi-cell-denoting variants are RangeRef, AggregateNameRef, StructuredRef, Array — all covered. The binder constrains what can appear (a literal `A1:A5` → BindError; a named range under AggregateArg → AggregateNameRef). zero-arg → 1×0 grid tolerated. **[Reconciliation note: this dimension MISSED Codex HIGH-1 — array-PRODUCING function calls like `SEQUENCE(2,2)` are `ExprPlan::Function`, not range refs, so they bypass `is_range_like` and scalarize. The lane reasoned only about range REFERENCES being binder-constrained, not about Unified-tier functions producing arrays at runtime.]**

### 5. Boundary-spill guard mutual-exclusivity — CLEAN
Verified at the registry: `register_udf`→`register_metadata` rejects any name already in `metadata`; `register_builtin_metadata` inserts metadata for every builtin in `fns` with a boot-time assert. So `register_udf("SUM"/"OFFSET"/"ROW"/...)` always conflicts. 1×1→Scalar, N×M→Array, degenerate→Array→write_spill→#CALC! (non-panicking).

### 6. transaction.rs inline-eval gap — REAL but LATENT (MEDIUM-2)
`transaction.rs:397` builds `WorkbookEnv::new` (worker=None) and the struct maintains NO calcgraph → a UDF committed through standalone `WorkbookTransaction` is a permanent `#CALC!`. HOWEVER the session's live transaction API routes through `batch`→`with_runtime_no_oplog`→`with_formula_cell_and_worker` (worker threaded). The standalone path is reachable only via `WorkbookRuntime::transaction()`, whose only three callers are all `#[cfg(test)]`. No live UDF-bearing caller today. Flag for 6.4-3d.

### 7. fn_gen / plan-cache / dirty — MOSTLY CLEAN (UX sharp edge, LOW-2)
`set_udf_worker` does NOT dirty; clean `#CALC!` cells stay `#CALC!` after injection and `recalc_dirty` won't pick them up (only `recalc_all`). Cached `ExprPlan` identical with/without worker (handle resolved at eval time). The changed dirties test (#NAME?→#CALC!) is correct, not a masked regression.

### 8. Liveness — REAL (MEDIUM-3)
`UDF_CALL_DEADLINE = 30s` is PER-CALL; a recalc over N hung UDF cells stalls the session mutex up to 30·N s. No deadlock; unbounded aggregate stall.

### 9. Other
- error-valued args forwarded to worker (MEDIUM-1) — diverges from Excel left-error-wins; may be deliberate, undocumented.
- UDFs register Volatile → recompute graph-correct.
- no double-eval of args.

## Findings
- **MEDIUM-1** — error-valued args forwarded, not short-circuited (scalar.rs ~261).
- **MEDIUM-2** — standalone WorkbookTransaction omits worker, no self-heal (transaction.rs:397). Latent (test-only callers).
- **MEDIUM-3** — per-call 30s deadline under session mutex → unbounded aggregate stall.
- **LOW-1** — dead silent `unwrap_or(Value::Blank)` in 1×1 extraction (scalar.rs:336 / dispatch_udf).
- **LOW-2** — `set_udf_worker` doesn't dirty; stale `#CALC!` survives `recalc_dirty`.
- **LOW-3** — non-default-registry could place a name in both `fns` and `udf_handles` (mutual-exclusivity is construction-dependent, not structural). No wrong result today.
