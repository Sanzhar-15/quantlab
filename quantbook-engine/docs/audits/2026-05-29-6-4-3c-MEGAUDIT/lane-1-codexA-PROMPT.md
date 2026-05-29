# MEGAUDIT Lane A (Codex) — Quantbook 6.4-3c UDF eval wiring + its audit-fix

You are an adversarial Rust auditor. FIND DEFECTS; do not praise. Rate HIGH/MEDIUM/LOW. Report
at ~55% confidence — a dismissed false positive is cheap, a missed bug is not.

## Working root & scope
`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`, branch
`feat/quantbook-engine`, HEAD `3b28ba5e91f` (doc-only on top of code HEAD `a9ef3f252ca`).

The increment is `git diff 88c0dc5836a..a9ef3f252ca` (run it; code lives in commit `88406c32b70`
= original wiring + `a9ef3f252ca` = audit-fix). Diff files also at (relative to working root):
`../.mega_src.diff` (all code), `../.mega_tests.diff` (tests), and CRITICALLY
`../.mega_auditfix_src.diff` = the **570-line audit-fix delta that has had NO independent review**.
Read the ACTUAL files at HEAD.

## Your PRIMARY focus: did the audit-fix introduce new defects?

The audit-fix (`a9ef3f252ca`) reworked `scalar.rs::marshal_udf_args` and threaded a worker into
`transaction.rs`. These are the riskiest, least-reviewed lines. Tear them apart:

1. **`marshal_udf_args` now recurses through `eval_at_cell_boundary` per array-capable arg.**
   Previously a UDF arg was scalar-evaluated. Now an arg that is a Unified-tier function or a UDF is
   evaluated via `eval_at_cell_boundary(arg, ...)`. Prove or disprove each:
   - **Double-borrow:** `dispatch_udf` holds `worker_cell.borrow_mut()` across `worker.call`. With
     per-arg `eval_at_cell_boundary` that itself can dispatch a nested UDF, is there ANY ordering
     where the outer `borrow_mut` is live while a nested arg eval takes `borrow_mut` again? Trace
     `=OUTER(INNER(...))` and `=OUTER(A1, INNER(...))` exactly. A double-borrow PANICS → FaultGuard
     seals the session.
   - **Double-evaluation:** does any arg get evaluated twice (once to classify shape, once to read
     value)? Side-effecting/volatile args (RAND, NOW, a volatile UDF) evaluated twice = wrong/
     non-deterministic. Walk the `enum Arg` collect loop.
   - **Unbounded recursion / stack overflow:** `marshal_udf_args` → `eval_arg` → `eval_at_cell_boundary`
     → (UDF arm) `marshal_udf_args`. Is depth bounded only by formula nesting? Is there a cycle?
   - **Behavior regression for previously-OK args:** a Unified function returning a SCALAR (e.g. is
     `SUM` Unified-tier? `IF`? `INDEX`?) now routes through `eval_at_cell_boundary` instead of
     `eval_scalar_with_cache`. Do those two paths return the IDENTICAL value for a scalar-returning
     Unified fn at a UDF arg? Check the `eval_at_cell_boundary` Unified arm vs the scalar Unified arm
     — arg materialization, the ROW/COLUMN multi-cell guard, implicit intersection. Any divergence is
     a silent regression in `=MYUDF(SUM(A1:A5))`-style formulas.
   - **The `n_grid==1 && evaluated.len()==1` rule:** a single Unified-fn arg returning a SCALAR →
     `n_grid==0` → row path. A single arg returning an ARRAY → grid path. Correct? What about a
     single arg that is an array-capable fn but returns a 1×1 (`SEQUENCE(1,1)`) — Scalar or Grid?
2. **`transaction.rs` worker threading:** new `udf_worker` field + param on `with_optional_oplog`,
   used in `commit` pass-2 via `with_formula_cell_and_worker`. Lifetime soundness (`'a` on the
   borrowed `&RefCell`)? The `commit(self)` destructure now binds `udf_worker` — any move/borrow
   conflict with the `workbook`/`ops` loop? Does a UDF returning an ARRAY in this no-spill path
   behave correctly (it has no `write_spill`)?
3. **LOW-1 fix:** `dispatch_udf` 1×1 extraction now `unwrap_or(Value::Error(Calc))`. Sound?

## Then the FULL increment (original wiring too)
- RefCell/`!Sync` soundness end-to-end; `WorkbookSession: Send` (napi `assert_send`).
- FaultGuard panic-freedom: enumerate EVERY `unwrap`/`expect`/`unreachable`/index/`panic` reachable
  from the dispatch path (incl. the TWO new `unreachable!`s in `marshal_udf_args` and the `.expect`
  in the boundary guard). Are they provably unreachable?
- builtin↔UDF dispatch mutual-exclusivity at every tier.
- arg marshalling edge cases: zero-arg, error-valued arg, StructuredRef narrow-fail, literal array.

## Output
Per finding: `[HIGH|MEDIUM|LOW] <title>`, file:line, the concrete defect + failure it causes, fix.
If a focus area is genuinely clean, say `CLEAN: <why>`. End with H/M/L counts and a one-line
SHIP / SHIP-WITH-FIXES / DO-NOT-SHIP verdict. Don't invent severity.
