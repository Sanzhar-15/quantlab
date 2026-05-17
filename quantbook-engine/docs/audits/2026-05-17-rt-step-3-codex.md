# Codex Audit: RT-V1-01 Step 3 ISREF / ISFORMULA

Date: 2026-05-17
Baseline: `98ca4e697b3`
Scope: working-tree Step 3 changes for ISREF / ISFORMULA

Targeted gates run:

- `cargo test -p ql-functions reference_fns -- --nocapture`: PASS
- `cargo test -p ql-exec --test reference_fns_step3_e2e -- --nocapture`: PASS
- `cargo test -p ql-exec step_2_reference_aware_names_registered_in_reference_tier -- --nocapture`: PASS
- `cargo test -p ql-exec dep_suppressed_reference_fns_match_design -- --nocapture`: PASS
- `cargo test -p ql-functions default_registry_has_expected_count -- --nocapture`: PASS
- `cargo test -p ql-functions --test coverage every_registered_function_has_a_coverage_decision -- --nocapture`: PASS

Note: the requested audit-discipline memory path did not exist in this environment. I applied the HIGH / MEDIUM / LOW finding format and severity discipline requested in the prompt.

## HIGH-1

Subject: `ISFORMULA(A1)` propagates A1's error value instead of inspecting A1's formula status

Where: `crates/ql-exec/src/scalar.rs:592`, `crates/ql-exec/src/scalar.rs:594`, `crates/ql-functions/src/reference_fns.rs:234`

Detail:

`materialize_ref_arg_eager` reads every `ExprPlan::CellRef` and converts any `Value::Error(ev)` returned by `env.read_cell` into `RefArg::Error(ev)`. `isformula` then propagates that error before it can query `ctx.workbook.is_formula_at`.

That conflates two different cases:

- The argument is the literal error `#REF!`, where propagation is correct.
- The argument is a valid reference to a cell whose current value is an error, where `ISFORMULA` should still inspect storage metadata.

Concrete wrong outputs:

- A1 contains a literal `#N/A`: `ISFORMULA(A1)` should be `FALSE`, but the materializer produces `RefArg::Error(NA)`.
- A1 contains a formula whose computed value is `#DIV/0!`: `ISFORMULA(A1)` should be `TRUE`, but the materializer produces `RefArg::Error(DivZero)`.

The existing happy-path test uses `Workbook::put_formula` directly, which stores formula metadata without a computed error value, so it does not exercise this path. The same materializer shape will also matter for Step 4 FORMULATEXT.

Recommendation:

Do not use the referenced cell's value error as the validity signal for a reference. Either produce `RefArg::Reference { address, value }` even when `value` is an error, or add a separate env/reference validation API so missing-sheet stale refs can still surface `#REF!` without treating ordinary error-valued cells as invalid refs. Add tests for `ISFORMULA(A1)` where A1 is a literal error and where A1 is a formula returning an error.

Severity rationale:

HIGH because valid user formulas can return the referenced cell's value error instead of the formula-status boolean required by the function contract.

## HIGH-2

Subject: `ISFORMULA(A1:A1)` has no dependency on A1, so incremental recompute can go stale

Where: `crates/ql-functions/src/reference_fns.rs:240`, `crates/ql-exec/src/plan.rs:698`, `crates/ql-exec/src/calcgraph_session.rs:302`, `crates/ql-exec/src/calcgraph_session.rs:333`

Detail:

The implementation correctly treats a 1x1 `RefArg::Range` as a single-cell query. A literal `A1:A1` argument binds through `ExprPlan::RangeRef { range }`, materializes as `RefArg::Range`, and returns `ctx.workbook.is_formula_at(...)`.

The dep walker does not match that behavior. `ISFORMULA` is not address-only, so it uses the normal walker; the normal `ExprPlan::RangeRef` arm is an unconditional no-op, justified by the multi-cell `#N/A` case. That justification is false for 1x1 ranges, where the result depends on A1's formula status.

Result: `B1 = ISFORMULA(A1:A1)` can compute correctly once, then fail to dirty when A1 changes from literal to formula or formula to literal. `ISFORMULA(A1)` does register a value dep via `CellRef`; only the semantically equivalent 1x1 range form is missing it.

Recommendation:

Special-case 1x1 `RangeRef` dependencies for `ISFORMULA` and FORMULATEXT, or make the normal `RangeRef` walker push a cell dep when `start == end` on both axes. Add a calcgraph/runtime test that sets `=ISFORMULA(A1:A1)`, changes A1's formula status, and verifies the dependent recomputes.

Severity rationale:

HIGH because this can produce stale workbook results under the supported incremental dependency model.

## HIGH-3

Subject: `ISREF(SUM(A1:A3))` and `ISFORMULA(SUM(A1:A3))` bind-fail instead of reaching the documented outcomes

Where: `crates/ql-exec/src/plan.rs:698`, `crates/ql-exec/src/plan.rs:724`, `crates/ql-functions/src/reference_fns.rs:182`, `crates/ql-functions/src/reference_fns.rs:220`, `crates/ql-exec/tests/reference_fns_step3_e2e.rs:81`

Detail:

The Step 3 docs and design still claim:

- `ISREF(SUM(A1:A3))` -> `FALSE`.
- `ISFORMULA(SUM(A1:A3))` -> `#N/A`.

The current binder cannot reach either implementation path for the literal-range form. Binding the outer reference-aware function puts its direct arg in `ReferenceArg` context, but once that arg is a nested `SUM(...)`, the SUM arm chooses `BindContext::AggregateArg` for SUM's own args. Literal `Expr::RangeRef` is still rejected outside `ReferenceArg`, so the formula fails at bind time. The e2e test avoids the problem by using `ISREF(SUM(1, 2))`, which does not exercise the documented literal-range case.

This is the same binder limitation called out in the Step 2 audit, but Step 3 reintroduces the un-narrowed examples in doc-comments and does not add pinning tests for the v1 bind-error stance.

Recommendation:

Either implement AggregateArg-side literal `RangeRef` lowering so these formulas reach the documented results, or explicitly document the v1 bind-fail scope for ISREF/ISFORMULA and add tests pinning that behavior until the binder gap is closed.

Severity rationale:

HIGH because valid formulas named in the Step 3 contract are rejected before evaluation instead of producing the specified user-visible results.

## HIGH-4

Subject: Producer/replay ordering can diverge for `set_formula(A1, "=ISFORMULA(A1)")`

Where: `crates/ql-exec/src/workbook_runtime.rs:727`, `crates/ql-exec/src/workbook_runtime.rs:775`, `crates/ql-oplog/src/replay.rs:323`, `crates/ql-exec/src/env.rs:307`

Detail:

`WorkbookRuntime::set_formula` evaluates the formula before storing its formula text in the workbook. During that evaluation, `WorkbookEnv::is_formula_at(A1)` sees the old workbook state. For a new formula written to A1:

- Producer path: evaluate `=ISFORMULA(A1)` before `put_formula`; `formula_at(A1)` is `None`, so the computed value is `FALSE`.
- Replay path: `Op::PutFormula` restores the formula text first, then `recompute_all` evaluates with `formula_at(A1)` already present, so the computed value is `TRUE`.

The prompt specifically calls out this replay path. The Step 3 tests use storage-level `Workbook::put_formula` plus direct eval, so they do not cover the producer ordering used by `set_formula`.

Recommendation:

Add a runtime/op-log producer-replay test for `set_formula(0, 0, 0, "=ISFORMULA(A1)")`. Fix by giving `ReferenceQuery` a pending-formula overlay during `set_formula` evaluation, or by moving formula metadata installation before evaluation with rollback/atomicity preserved.

Severity rationale:

HIGH because it can break producer/replay equivalence and gives different answers for the same final workbook state.

## MEDIUM-1

Subject: ISREF still registers deps and volatility for non-reference arg subtrees even though LazyShape never evaluates them

Where: `crates/ql-exec/src/calcgraph_session.rs:288`, `crates/ql-exec/src/calcgraph_session.rs:400`, `crates/ql-exec/src/calcgraph_session.rs:416`

Detail:

`ISREF` is included in `is_address_only_reference_fn`, which routes args through `walk_plan_for_address_only_deps`. That walker was designed for the Eager address-only functions: it skips direct reference value deps, but walks Binary / Unary / Function subtrees normally because ROW/COLUMN/ROWS/COLUMNS eagerly evaluate those shapes.

ISREF is different. Its LazyShape contract never evaluates any arg shape. So:

- `ISREF(A1+1)` gets a value dep on A1 even though only the outer Binary shape matters.
- `ISREF(NOW())` is marked volatile even though NOW is not evaluated.
- `ISREF(SUM(NamedRange))` can register structural deps for a nested function whose shape remains `Function` regardless of the named range's cells.

This does not change the returned value, but it violates the design's "no value deps for ISREF args" intent and causes unnecessary dirtying/recompute.

Recommendation:

Split the dep policy: keep the current shape-aware eager policy for ROW/COLUMN/ROWS/COLUMNS, and add an ISREF/LazyShape policy that does not recurse into value-producing subtrees. Preserve only direct structural deps that can change the direct arg shape, such as a direct `AggregateNameRef` / `StructuredRef`.

Severity rationale:

MEDIUM because outputs remain correct, but the implementation deviates from the LazyShape dependency contract and can create avoidable recompute/volatile work.

## LOW-1

Subject: Step 3 test-count and runtime-coverage docs do not match reality

Where: `docs/compat/excel-matrix.md:241`, `docs/compat/excel-matrix.md:242`, `crates/ql-functions/tests/coverage.rs:617`, `crates/ql-functions/tests/coverage.rs:637`

Detail:

`reference_fns_step3_e2e.rs` currently contains 23 tests: 11 ISREF tests and 12 ISFORMULA tests. The matrix says `ISFORMULA` has `9+10 e2e`, and the prompt's accounting says Step 3 added 21 e2e tests. The coverage note also says "workbook-runtime e2e", but the Step 3 happy paths use storage-level `Workbook::put_formula` and direct `WorkbookEnv` evaluation, not `WorkbookRuntime::set_formula`, recompute, or op-log replay.

Recommendation:

Update the matrix/counts to `ISREF 10+11 e2e` and `ISFORMULA 9+12 e2e`, or adjust if two tests are moved. Reword the coverage note from "workbook-runtime e2e" to "WorkbookEnv-backed e2e" unless runtime tests are added.

Severity rationale:

LOW because this is documentation/test-accounting drift, but it obscures the missing runtime coverage in HIGH-4.

## LOW-2

Subject: Reference-aware registry disjointness invariant omits the context-aware tier

Where: `crates/ql-exec/src/plan.rs:1770`, `crates/ql-exec/src/plan.rs:1780`, `crates/ql-exec/src/plan.rs:1796`

Detail:

`step_2_reference_aware_names_registered_in_reference_tier` claims registered reference-aware names must not resolve through any other tier, but it checks only scalar, range-aware, and unified lookups. It omits `lookup_context_aware`. The shared `RegisteredFn` map structurally prevents a name from being both `ReferenceAware` and `ContextAware`, so this is not a runtime bug, but the invariant is not as comprehensive as its comment says.

The FORMULATEXT pending check is also narrowed to `lookup_reference_aware` and scalar `lookup`, leaving the other tier filters implicit.

Recommendation:

Add explicit `lookup_context_aware(name).is_none()` assertions for registered reference-aware names, and check all non-reference-aware tiers in the pending FORMULATEXT sentinel.

Severity rationale:

LOW because the registry representation enforces disjointness, but the invariant test should match the stated safety property.

## LOW-3

Subject: `reference_fns.rs` module header still describes only the Step 2 batch

Where: `crates/ql-functions/src/reference_fns.rs:1`

Detail:

The file-level doc says it implements ROW / COLUMN / ROWS / COLUMNS and that all four register with `ArgContract::Eager`. Step 3 appended ISREF and ISFORMULA to the same module, including the first LazyShape user-facing function, but the header was not updated.

Recommendation:

Update the module header to describe the broader reference-aware function module and list both batches, including ISREF's LazyShape contract.

Severity rationale:

LOW because this is documentation drift, but it is at the top of the main Step 3 implementation file.
