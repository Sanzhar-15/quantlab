# Adversarial audit — Quantbook engine Phase 6.4-3c (Python-UDF eval wiring)

You are an adversarial code auditor. Be a skeptic. Your job is to FIND DEFECTS in a freshly
committed increment, not to praise it. Rate each finding HIGH / MEDIUM / LOW. A HIGH is a
correctness bug, a panic/abort path, a soundness hole (Send/Sync), a security gap, or a
silent-wrong-result. Default to reporting a concern even if you are only ~60% sure — it is
cheaper for me to dismiss a false positive than to miss a real one.

## Repo / scope

Working root: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`
Branch: `feat/quantbook-engine`. The increment under audit is the diff:

    git diff 88c0dc5836a..88406c32b70

(two commits: `88406c32b70` = 6.4-3c CODE, `4ec19775058` = doc-sync on top of it.)
Read the actual committed files — do not trust this prompt's paraphrase. The full source diff
(excluding tests) is also at `../.6_4_3c_src.diff` and the tests/docs diff at
`../.6_4_3c_tests_docs.diff` relative to the working root.

## What 6.4-3c does (context, verify against code)

Quantbook is a spreadsheet engine. A user can register a Python function (`register_function`)
and reference it in a formula: `=MYUDF(A1)`. Before this increment, dispatch had no arm for
UDFs, so a registered `=MYUDF(A1)` returned `#NAME?`. 6.4-3c adds dispatch: it marshals the
formula's evaluated args into a single Arrow grid (`ArrayValue`), calls an out-of-process
Python worker (`ql_udf::UdfWorker`, shipped in 6.4-3a/b — a leaf crate over Arrow-IPC/stdio),
and maps the result / `UdfError` back to a cell value.

Key design decisions (already locked — do NOT re-litigate these, but DO verify they are
implemented soundly):
- Dispatch is "Option B": UDFs are dispatched from the `scalar.rs` function-dispatch `None`
  arm via `registry.udf_handle(name)`, NOT via a `RegisteredFn::Udf` variant. There is also a
  parallel guard arm in `eval_at_cell_boundary` so a top-level `=MYUDF(...)` returning a grid
  can spill.
- The worker is reached through the eval env by interior mutability:
  `CellEnv::udf_worker() -> Option<&RefCell<Box<dyn UdfWorker + Send>>>`. The session owns the
  `RefCell`; `WorkbookRuntime` borrows it through the two `with_session_state*` constructors;
  it is threaded into the value-computing env via `with_formula_cell_and_worker`.
- v1 arg marshalling: N scalar args -> a 1xN row grid; exactly one range/array arg (and it is
  the only arg) -> its native grid; mixed scalar+range OR >=2 range args -> `#VALUE!`.
- Failures map to deterministic cell error VALUES now: `UdfError::Timeout` -> `#TIMEOUT!`,
  everything else -> `#CALC!`. No-worker-configured -> `#CALC!`. A structured CellDiagnostic
  sink is deferred.
- `UDF_CALL_DEADLINE = 30s` bounds one blocking call on the synchronous recalc thread.

## Mandatory audit dimensions — work through EACH, cite file:line

1. **RefCell re-entrancy / BorrowMutError panic.** `dispatch_udf` does
   `worker_cell.borrow_mut()` and holds it across `worker.call(...)`. Prove or disprove: can
   any code path hold one `borrow_mut` while a second `borrow_mut` (or `borrow`) on the SAME
   `RefCell` is taken? Trace nested UDFs `=MYUDF(MYUDF2(A1))` precisely: when are args
   evaluated vs. when is the borrow taken? Can `worker.call` ever re-enter the engine's eval
   (callback, volatile re-fetch, anything)? A `RefCell` double-borrow is a PANIC -> it would
   trip the recompute FaultGuard and seal the session. This is the #1 concern.

2. **FaultGuard panic-freedom.** The recompute path is wrapped in a FaultGuard that SEALS the
   session permanently on any panic (6.1C M3). Enumerate EVERY panic/unwrap/expect/unreachable
   reachable from the new dispatch code: `marshal_udf_args`, `dispatch_udf`, `map_udf_error`,
   the `None`-arm, the `eval_at_cell_boundary` guard. Is the `unreachable!()` in
   `marshal_udf_args` truly unreachable for every `ExprPlan` shape `is_range_like` admits? Is
   the `.expect()` in the boundary guard sound? Can `borrow_mut()` panic (see #1)? Can a
   malformed `ArrayValue::new` / `grid.get` index panic?

3. **Send/!Sync soundness.** `WorkbookEnv` now holds `Option<&RefCell<Box<dyn UdfWorker + Send>>>`,
   which makes `WorkbookEnv` `!Sync`. `WorkbookSession` holds `Option<RefCell<Box<dyn UdfWorker
   + Send>>>` and must stay `Send` (the napi bindings `assert_send::<CoreWorkbookSession>()`).
   Verify: (a) `WorkbookSession: Send` actually holds (RefCell<Box<dyn T + Send>> is Send — is
   the `+ Send` bound present at EVERY declaration site?); (b) NO parallel/rayon/SIMD code path
   ever constructs or carries a `&WorkbookEnv` (or any `CellEnv` with a `Some` worker) across a
   thread boundary during eval. Grep the aggregate/SIMD path. If `WorkbookEnv` is shared across
   threads anywhere, the `!Sync` is a soundness bug.

4. **Arg marshalling correctness.** Examine `marshal_udf_args`. Edge cases: zero-arg UDF
   (`=MYUDF()`); a single scalar; a single literal array `{1,2,3}`; a `StructuredRef` whose
   `[@]` narrowing fails; an arg that evaluates to an error value (`=MYUDF(1/0)`) — is the
   error packed into the grid and sent to Python, short-circuited, or wrong? Is `is_range_like`
   complete — are there ExprPlan variants that denote a range/array but are NOT in the list
   (whole-column refs, cross-sheet ranges, spill refs, dynamic-array producers)? If one is
   missed, a range arg silently marshals as a scalar — a silent-wrong-result. Does the 1xN-row
   convention match what the shipped Python worker (`_smoke_udfs.py`) and the 6.4-3a/b codec
   actually expect?

5. **Boundary-spill guard.** The new `eval_at_cell_boundary` arm. Verify mutual exclusivity
   with the existing Unified / ROW-COLUMN guards (claim: a name is never both a builtin and a
   UDF because `register_udf` rejects conflicts — verify the conflict check actually covers ALL
   builtin tiers, not just `fns`). Does a 1x1 grid return Scalar (not a 1x1 spill)? Does an
   error-valued UDF result spill or scalar-ize correctly? Ordering relative to `_`?

6. **transaction.rs inline-eval gap.** The handoff claims a UDF inside a transaction evaluates
   to `#CALC!` during the txn (no worker on the txn's env) then "self-heals" on post-commit
   recompute. CONFIRM by reading `transaction.rs`: does its inline eval really omit the worker?
   Does the post-commit recompute actually re-evaluate and overwrite the `#CALC!`? Or does a
   committed `#CALC!` persist (a real bug)? Is the transient `#CALC!` observable to a reader
   mid-txn in a way that matters?

7. **fn_gen / plan-cache / dirty interaction.** Does `set_udf_worker` need to dirty anything?
   A formula bound while no worker was present produces `#CALC!`; after `set_udf_worker` is it
   recomputed, or stuck at `#CALC!` until an unrelated edit dirties it? Is the cached `ExprPlan`
   identical with/without a worker (it must be — dispatch resolves `udf_handle` at eval time)?
   Does registering/unregistering a UDF correctly bump `fn_gen` and re-dispatch (the
   `register_function_dirties_dependent_formulas` test was changed #NAME?->#CALC! — verify the
   change is correct, not masking a regression)?

8. **Deadlock / liveness.** The 30s deadline blocks the synchronous recalc thread (Model A).
   While blocked, the napi `Mutex<WorkbookSession>` is held. Is there any reentrancy or
   cross-lock that could deadlock? If a single recompute touches many UDF cells, is the deadline
   per-call (so a sheet of N UDFs can stall 30*N seconds)? Flag if the total stall is unbounded.

9. **Anything else** — determinism/volatility of UDF cells, double-evaluation of args, blank/
   empty grid handling, the `Value::Blank` fallback on `grid.get(0,0)`, error-value column in
   the codec, panics in `ArrayValue::row`/`column`/`singleton`.

## Output format

For each finding: `[HIGH|MEDIUM|LOW] <title>` then file:line, a 1-3 sentence explanation of the
defect and the concrete failure it causes, and a suggested fix. End with a one-line SHIP /
SHIP-WITH-FIXES / DO-NOT-SHIP verdict and the count of HIGH/MED/LOW. If you find NO HIGHs, say so
explicitly — do not invent severity. Be concrete and cite line numbers from the actual files.
