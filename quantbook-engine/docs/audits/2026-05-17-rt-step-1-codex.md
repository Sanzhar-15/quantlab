# Codex Audit: RT-V1-01 Step 1 Infrastructure

Date: 2026-05-17
Baseline: `8f9b37b5d6d`
Scope: reference-tier Step 1 infrastructure working tree changes

Gates verified:

- `cargo fmt --check`: PASS
- `cargo clippy --workspace --all-targets -- -D warnings`: PASS
- `cargo test --workspace --all-targets`: PASS

Note: the requested audit-discipline memory path did not exist in this environment. I applied the HIGH / MEDIUM / LOW format and severity discipline requested in the prompt.

## HIGH-1

Subject: Reference-tier dep suppression drops real value and structural dependencies

Where: `crates/ql-exec/src/calcgraph_session.rs:166`, `crates/ql-exec/src/calcgraph_session.rs:249`, `crates/ql-exec/src/scalar.rs:576`, `crates/ql-exec/src/scalar.rs:603`

Detail:

`is_dep_suppressed_reference_fn` suppresses dependency walking for every argument of `ROW`, `COLUMN`, `ROWS`, `COLUMNS`, and `ISREF` based only on the function name. That is too coarse for the Step 1 ABI.

For eager reference-aware functions, the materializer suppresses value reads only for direct reference shapes such as `CellRef`, `RangeRef`, `AggregateNameRef`, and `StructuredRef`. Other shapes still evaluate through `eval_scalar_with_cache` and can depend on nested values or propagate nested errors. For example, `ROW(A1+1)` or `ROWS(IF(A1, B1, C1))` is not a pure coordinate query in the current dispatcher: the fallback path evaluates the binary/function argument before wrapping the result as `Scalar` or `Error`. The calcgraph walker would skip those argument subtrees completely, so edits to `A1`, `B1`, or `C1` can leave the formula stale.

The same issue affects structural dependencies. `AggregateNameRef` and `StructuredRef` arguments are intentionally kept as references by the materializer, but the walker suppresses them entirely under the reference-tier names. That means formulas such as `ROWS(MyRange)`, `ISREF(MyRange)`, `ROWS(Sales[Qty])`, and `ISREF(Sales[Qty])` may not be recorded in `name_to_formulas` or `table_to_formulas`. Later named-range retargets or table-shape changes can miss dirtying these formulas.

Recommendation:

Replace the function-name-only suppression with shape-aware dependency extraction that matches the materializer contract.

- For direct coordinate-only shapes, suppress value stripe dependencies.
- For scalar fallback shapes such as binary, unary, and nested function plans in eager contracts, recurse normally because the dispatcher evaluates them.
- For `AggregateNameRef` and `StructuredRef`, record structural name/table dependencies even when suppressing value dependencies.
- For lazy `ISREF`, preserve structural dependencies while avoiding value reads for pure shape checks.

Add calcgraph tests covering direct-cell suppression, scalar fallback dependencies, named-range retargeting, and structured-reference table changes.

Severity rationale:

This can produce stale workbook results after ordinary edits. It is architectural because the walker no longer matches the dispatcher materialization semantics.

## HIGH-2

Subject: ROW/COLUMN cell-boundary guard misses structured references

Where: `crates/ql-exec/src/scalar.rs:811`, `crates/ql-exec/src/scalar.rs:576`

Detail:

The new `eval_at_cell_boundary` guard rejects multi-cell `ROW` and `COLUMN` arguments only for `RangeRef`, `AggregateNameRef`, and `Array`. It does not inspect `ExprPlan::StructuredRef`.

The eager materializer later turns a structured reference into `RefArg::Range` through `narrow_structured_ref`. Therefore a top-level formula such as `ROW(Sales[Qty])` or `COLUMN(Sales[Qty])` can bypass the boundary guard and execute with only the materialized range coordinates. If the Step 2 implementation returns the top-left row/column, this recreates the silent truncation behavior the design is trying to prevent.

The guard also needs to distinguish full-column structured references from narrowed `[@...]` forms. A blanket `StructuredRef` rejection would incorrectly reject cases that narrow to a single cell or single row at the formula cell.

Recommendation:

Handle `ExprPlan::StructuredRef` in the ROW/COLUMN boundary guard by using the same narrowing logic as the materializer, then reject only when the resulting range is multi-cell for the boundary context. Add tests for:

- `ROW(Table[Column])` and `COLUMN(Table[Column])` returning `#CALC!` when multi-cell.
- `ROW(Table[@Column])` and `COLUMN(Table[@Column])` preserving the narrowed single-reference behavior.
- Structured-reference narrowing errors flowing consistently with existing scalar evaluation.

Severity rationale:

This is a user-visible semantic error as soon as `ROW` or `COLUMN` is registered in Step 2. It also bypasses a guard that exists specifically to prevent ambiguous multi-cell reference behavior.

## MEDIUM-1

Subject: Binder reference-aware function list is registry-independent and drift-prone

Where: `crates/ql-exec/src/plan.rs:497`, `crates/ql-exec/src/plan.rs:717`, `crates/ql-functions/src/registry.rs:258`

Detail:

The binder decides whether to bind function arguments in `ReferenceArg` context using a hardcoded `is_reference_aware_function` list. The runtime dispatcher decides whether a function is reference-aware from registry state. These two sources can diverge.

During Step 1, the hardcoded list already accepts the seven planned names even though they are not registered yet. That is intentional for infrastructure staging, but it shows the invariant is external to the type system. In Step 2 and later:

- A hardcoded binder name without a matching registration will accept literal ranges but fail at evaluation as an unknown function.
- A registered reference-aware name missing from the binder list will reject literal range syntax before dispatch can use the ABI.
- A future per-argument contract function could require special binding for only some positions, but the current classifier only operates at whole-function granularity.

Recommendation:

Add an invariant test before Step 2 lands that compares the shipped reference-aware registrations with the binder classifier for the names intended to be user-facing. Longer term, source bind-time argument context from shared function metadata or a single generated/static table rather than maintaining separate hardcoded lists. When per-position contracts arrive, the metadata should be able to say which argument positions require `ReferenceArg` and which remain scalar.

Severity rationale:

No Step 1 user-facing function is broken yet, but this is infrastructure intended to scale to Step 2 and XLOOKUP-style contracts. The current shape invites registration/binder drift.

## MEDIUM-2

Subject: Step 1 tests cover ABI registration but not exec-side infrastructure

Where: `crates/ql-functions/src/reference_aware_fns.rs:176`

Detail:

The eight new tests exercise the `ql-functions` ABI and registry surface: default context values, enum variants, duplicate/lowercase rejection, and registry lookup. They do not cover the highest-risk Step 1 code in `ql-exec`: binder lowering, materializer variant mapping, cell-boundary guards, dependency walking, or environment query plumbing.

That leaves the infrastructure largely verified only by compilation until Step 2 registers user-facing functions. The two HIGH findings above both sit outside the current test coverage.

Recommendation:

Add Step 1 infrastructure tests using local reference-aware test functions registered in a scratch registry where needed. Useful cases:

- Binding literal cell/range/whole-row/whole-column references into `RangeRef`.
- Eager materializer output for `CellRef`, `RangeRef`, `AggregateNameRef`, `StructuredRef`, `Array`, `Error`, and scalar fallback.
- Lazy materializer `PlanKind` output for cell, range, function, array literal, binary, unary, and error plans.
- Calcgraph walker tests proving direct reference values are suppressed but scalar fallback and structural name/table dependencies are retained.
- Boundary guard tests for multi-cell range, array, named range, and structured reference arguments.

Severity rationale:

This is a test gap rather than an independent runtime defect, but it is in the architectural-risk commit and covers behavior that will become user-facing immediately in Step 2.

## LOW-1

Subject: Design and active plan still describe AggregateArg lowering that Step 1 deferred

Where: `docs/architecture/2026-05-17-reference-tier-design.md:394`, `docs/architecture/2026-05-17-reference-tier-design.md:571`, `.plans/_active.md:52`, `crates/ql-exec/src/plan.rs:685`

Detail:

The active design and plan say `Expr::RangeRef` should lower to `ExprPlan::RangeRef` in both `AggregateArg` and `ReferenceArg`, and that the old aggregate special-argument helper should be renamed or generalized. The implementation only enables the `ReferenceArg` path and leaves aggregate binding unchanged.

The prompt explicitly says AggregateArg enabling is deferred and that Step 1 should not add reference-tier names to `is_aggregate_function`, so this is not necessarily an implementation bug. It is still process drift: future reviewers reading only the design/plan will expect behavior that the Step 1 code intentionally does not provide.

Recommendation:

Update the design or active plan to record the actual Step 1 stance:

- `Expr::RangeRef` is accepted only in `ReferenceArg` for this commit.
- AggregateArg preservation is deferred.
- `is_aggregate_function` remains unchanged in Step 1, with a separate reference-aware classifier.

Alternatively, implement the design as written before Step 1 is committed.

## LOW-2

Subject: Registry doc comment references a nonexistent `contract_of(name)` API

Where: `crates/ql-functions/src/registry.rs:249`

Detail:

The `register_reference_aware` documentation says the dispatcher consults `contract_of(name)` to decide whether to materialize eagerly or lazily. No such API exists in the implementation. The contract is stored in `RegisteredFn::ReferenceAware(ReferenceAwareFn, ArgContract)` and is obtained through `lookup_any` or `lookup_reference_aware`.

Recommendation:

Update the comment to describe the actual API shape, or add a `contract_of` helper if that is still the intended public surface for future tests or dispatchers.

## LOW-3

Subject: Literal range deps are stored as named ranges with a synthetic name

Where: `crates/ql-exec/src/calcgraph_session.rs:282`, `crates/ql-exec/src/calcgraph_session.rs:197`

Detail:

The new `ExprPlan::RangeRef` walker arm stores direct literal ranges in `FormulaDeps::named_ranges` using the synthetic name `__rt_literal_range__`. Current reverse lookup appears to avoid user-name collision because `deps.names` is not populated for this synthetic entry. However, the field documentation says `named_ranges` contains canonical named ranges, and other consumers or future diagnostics can now observe a fake name in that collection.

Recommendation:

Prefer a separate field for unnamed range dependencies, such as `range_deps: Vec<Range>`, or change the field shape to store `Option<Arc<str>>` for the source name. If the synthetic-name approach stays, document the sentinel and add a regression test proving it cannot collide with user-defined names in reverse lookup or cleanup paths.
