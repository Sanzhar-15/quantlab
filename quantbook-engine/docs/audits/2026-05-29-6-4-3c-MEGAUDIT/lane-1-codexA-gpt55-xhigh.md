I audited the HEAD files and the requested diffs source-only; I did not run tests in this read-only workspace.

**Findings**

[HIGH] Unified boundary evaluation mishandles StructuredRef arguments  
[scalar.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/scalar.rs:854)  
`eval_scalar_with_cache`’s Unified arm materializes `StructuredRef` as a range, but `eval_at_cell_boundary`’s Unified arm does not. The audit-fix routes Unified/UDF-capable UDF args through `eval_at_cell_boundary`, so `=MYUDF(TRANSPOSE(Table1[Col]))` can now scalar-evaluate the structured ref instead of passing it as `FunctionArg::Range`, producing `#CALC!`/wrong data instead of the array the same Unified function path is supposed to see.  
Fix: factor the Unified argument materialization logic so boundary and scalar paths share the same `AggregateNameRef` / `StructuredRef` / literal-array handling, or add the missing `StructuredRef` arm to the boundary path with tests for `MYUDF(TRANSPOSE(Table[Col]))`.

[MEDIUM] UDF marshalling evaluates arguments after the result is already doomed to `#VALUE!`  
[scalar.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/scalar.rs:1060)  
`marshal_udf_args` evaluates every arg into `evaluated` before enforcing the “only one grid arg, and it must be the sole arg” rule. `=OUTER(SEQUENCE(2,2), INNER())` or `=OUTER(SomeRange, INNER())` calls `INNER()` even though the outer marshal must return `#VALUE!`. If `INNER` is volatile, slow, times out, or has external side effects, the user gets visible side effects/latency hidden behind a final shape error.  
Fix: short-circuit once a grid arg is seen and `args.len() > 1`, or pre-classify plan-obvious grid args before evaluating later scalar/UDF args. Add a test with a counting/timeout worker.

[MEDIUM] `open` / `import` drop an installed UDF worker, then recompute clean `#CALC!` values  
[session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/session.rs:1135), [session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/session.rs:1213)  
`open` preserves the registry but replaces `self` with a fresh session, losing `udf_worker`. The immediate recompute then has registered UDF metadata but no worker, so UDF formulas become clean `#CALC!`. Since `set_udf_worker` intentionally does not dirty cells, later `recalc_dirty` will not repair them. `import` follows the same replacement pattern.  
Fix: preserve `self.udf_worker` across session adoption and make import/open recompute worker-aware, or explicitly mark UDF formulas dirty after worker installation.

**Clean Areas**

CLEAN: double-borrow in normal engine recursion. For `=OUTER(INNER(...))`, the inner `dispatch_udf` borrow is taken and dropped entirely inside `marshal_udf_args` before outer `dispatch_udf` borrows. For `=OUTER(A1, INNER(...))`, `A1` is evaluated first, then the inner borrow, then either outer dispatch happens after marshal or marshal returns `#VALUE!`; no overlapping `RefCell::borrow_mut`.

CLEAN: no strict double-evaluation. Each arg is evaluated once in the collect loop; shape classification uses the stored `Arg`. The separate issue is unnecessary evaluation of later args when the final shape error is already known.

CLEAN: recursion is bounded by the formula AST nesting for this change. Cell references read cached/current values rather than recursively evaluating referenced formulas in `marshal_udf_args`, so I did not find a new dynamic eval cycle. Deep formula nesting can still stack overflow as a general recursive-evaluator risk.

CLEAN: `n_grid == 1 && evaluated.len() == 1` semantics. Scalar-returning Unified functions become a 1-row scalar argument. Array-returning Unified functions remain grids. `SEQUENCE(1,1)` returns an array, so it is correctly treated as a 1x1 grid. A nested UDF returning a 1x1 grid is collapsed to scalar by `dispatch_udf`, consistent with the current worker protocol.

CLEAN: transaction worker threading. The borrowed `&RefCell` lifetime is stored as `'a`, `commit(self)` destructuring does not create a move/borrow conflict, and the pass-2 env borrow is scoped before writing computed values. Array-returning UDFs in transaction scalar recompute become `#CALC!`; there is no spill path there, but that is the existing no-spill transaction behavior.

CLEAN: LOW-1 fix. The 1x1 extraction fallback to `Value::Error(Calc)` is sound; `ArrayValue::new` makes `get(0,0)` present for a valid 1x1 array, and the fallback is safer than panic/blank if an invariant is ever broken.

CLEAN: dispatch-path panic audit for the new `unreachable!`s and boundary `.expect`. The two `marshal_udf_args` `unreachable!`s follow from the immediately counted `n_grid` over the same immutable vector. The UDF-handle `.expect` is guarded by the same registry lookup with no mutation in between. The array-shape `.expect`s still depend on binder invariants; I did not find a UDF-specific path that violates them.

Counts: HIGH 1 / MEDIUM 2 / LOW 0.  
Verdict: DO-NOT-SHIP until the HIGH is fixed.