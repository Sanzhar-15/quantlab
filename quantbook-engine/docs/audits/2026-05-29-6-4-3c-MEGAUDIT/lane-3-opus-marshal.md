# Lane 3 — Opus deep-dive on `marshal_udf_args` (the rewritten code)

Verdict: **SHIP-WITH-FIXES** · HIGH 0 · MED 1 · LOW 1 · 21 tool uses / 78.9k tokens.

## MEDIUM — Unified boundary arm missing `StructuredRef` materialization
`scalar.rs` `eval_at_cell_boundary` Unified arm has only `AggregateNameRef`/`Array`/`other→Scalar`; the scalar Unified arm (scalar.rs:280-295) reads `StructuredRef` as a `Range`. The 6.4-3c audit-fix routes array-capable UDF args through the boundary arm, so `=MYUDF(TRANSPOSE(Sales[Qty]))` scalar-evaluates the structured ref → TRANSPOSE gets a 1×1 `#CALC!` instead of the column. Fix: add the `StructuredRef` arm to the boundary materializer (mirror scalar.rs:280-295). [Reconciled with Codex-A HIGH; FIXED this cycle + un-ignored the i23 regression test that documented it.]

## LOW — no expression-nesting depth cap (evaluator-wide, amplified by UDF frame)
`marshal_udf_args → eval_arg → eval_at_cell_boundary → (UDF arm) → marshal_udf_args` is bounded only by formula nesting; a deeply nested formula stack-overflows/aborts regardless of UDFs (pre-existing). Filed-forward.

## Point-by-point (verbatim verdicts)
1. **Double-evaluation — CLEAN.** Each arg evaluated exactly once in the collect loop; classification + packing reuse `evaluated`. A nested Unified fn re-materializes ITS OWN args once (correct).
2. **RefCell re-entrancy — CLEAN.** `borrow_mut` taken only in `dispatch_udf`, held only across the leaf `worker.call`. For `=OUTER(INNER(A1))` / `=OUTER(A1, INNER(B1))` / `=OUTER(INNER1(), INNER2())`, each inner borrow is scoped to its own `dispatch_udf` and released before the next; `marshal_udf_args(OUTER)` fully completes before `dispatch_udf(OUTER)` borrows. No overlap. (Note: zero nested-UDF test coverage — safety is reasoning-only; recommend a `=OUTER(INNER(A1))` MockWorker test.)
3. **Unbounded recursion — see LOW.**
4. **Scalar-returning-Unified-fn-arg regression — the MEDIUM above.** Unified tier = exactly `SEQUENCE`, `TRANSPOSE`, `FILTER` (registry.rs:1187-1193). The boundary and scalar paths materialize `AggregateNameRef`/`Array`/scalar args identically; the ONE divergence was the missing `StructuredRef` arm.
5. **Shape-rule edges — CLEAN.** `SEQUENCE(1,1)` sole arg → 1×1 grid (consistent); degenerate 0×N sole arg → `ArrayValue::new` accepts, codec round-trips shape; `=MYUDF(A1:A3, SEQUENCE(2,2))` → 2 grids → `#VALUE!`. (Filed note: Python-worker tolerance of a 0-area grid unverified.)
6. **Two `unreachable!()` + boundary `.expect()` — CLEAN.** Both `unreachable!`s dead by the immediately-preceding `n_grid` count; the `.expect` guarded by the `is_some()` check with no interleaving mutation.
7. **Error-arg semantics — CLEAN.** `=MYUDF(1/0)` packs `#DIV/0!` into the grid (intentional, matches Excel UDFs); consistent across row + grid paths.
