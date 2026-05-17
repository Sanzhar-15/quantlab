# Codex Audit: RT-V1-01 Step 2 Reference Functions

Date: 2026-05-17
Baseline: `4efabe35deb5`
Scope: working-tree Step 2 changes for ROW / COLUMN / ROWS / COLUMNS

Targeted gates run:

- `cargo test -p ql-functions reference_fns -- --nocapture`: PASS
- `cargo test -p ql-exec --test reference_fns_e2e -- --nocapture`: PASS
- `cargo test -p ql-exec accepts_special_arg_lists_only_registered_reference_aware_matcher_pin -- --nocapture`: PASS
- `cargo test -p ql-exec step_2_reference_aware_names_registered_in_reference_tier -- --nocapture`: PASS
- `cargo test -p ql-exec dep_suppressed_reference_fns_match_design -- --nocapture`: PASS

Note: the requested audit-discipline memory path did not exist in this environment. I applied the HIGH / MEDIUM / LOW format and severity discipline requested in the prompt.

## HIGH-1

Subject: `ROW(SUM(A1:A3))` cannot reach the designed `#VALUE!` path

Where: `crates/ql-exec/src/plan.rs:689`, `crates/ql-exec/src/plan.rs:715`, `crates/ql-exec/src/plan.rs:721`, `crates/ql-exec/src/plan.rs:833`

Detail:

The design and audit prompt both call out `ROW(SUM(A1:A3))` as an important Microsoft-canon divergence case: SUM does not return a reference, so ROW should eagerly evaluate the inner function, receive a scalar, and return `#VALUE!`.

That is not what the current binder can do for the literal-range form. When binding the outer `ROW`, the argument `SUM(A1:A3)` is a nested `Expr::Function`. The nested SUM then chooses `BindContext::AggregateArg` for its own args at `plan.rs:721-724`. But `Expr::RangeRef` is still accepted only for `BindContext::ReferenceArg` at `plan.rs:689-704`; AggregateArg-side literal ranges are explicitly deferred. Therefore the formula shape `ROW(SUM(A1:A3))` fails during binding instead of dispatching and returning the per-fn `#VALUE!`.

Named-range variants such as `ROW(SUM(MyRange))` can bind because `NameRef -> Range` is accepted under AggregateArg at `plan.rs:833-838`, but the literal-range case named in the design does not.

Recommendation:

Either implement AggregateArg literal `RangeRef` lowering/dispatch for nested aggregate calls before claiming this canon case, or narrow the Step 2 design/docs/tests to say only named-range aggregate subcalls are supported in v1. Add an e2e test for `ROW(SUM(A1:A3))` with the intended result after the binding gap is closed.

Severity rationale:

HIGH because a valid Excel formula called out by the Step 2 audit contract is rejected at bind time instead of producing the specified `#VALUE!` result. The same binder gap will also affect the Step 3/4 examples `ISREF(SUM(A1:A3))`, `ISFORMULA(SUM(A1:A3))`, and `FORMULATEXT(SUM(A1:A3))` unless addressed or explicitly documented.

## MEDIUM-1

Subject: `ROWS` / `COLUMNS` can underflow on public, unnormalized `Range` payloads

Where: `crates/ql-functions/src/reference_fns.rs:100`, `crates/ql-functions/src/reference_fns.rs:117`, `crates/ql-types/src/address.rs:59`, `crates/ql-storage/src/workbook.rs:553`, `crates/ql-exec/src/plan.rs:833`

Detail:

`ROWS` and `COLUMNS` compute inclusive counts with direct `u32` subtraction:

- `range.end_row - range.start_row + 1`
- `range.end_col - range.start_col + 1`

Literal range refs are safe because `resolve_range_ref_to_range` uses `Range::new`, and `Range::new` normalizes corners. That is not a complete invariant across the engine. `Range` has public fields, `NamedTarget::Range` stores a `Range` directly, `NameTable::set` / `Workbook::set_name` accept the payload without normalization, and the binder forwards `ResolvedName::Range(range)` directly into `ExprPlan::AggregateNameRef`.

So an API caller, loader path, or test can register an inverted range such as `start_row = 10, end_row = 0`. `ROWS(MyBadRange)` then panics in debug builds or wraps to a huge count in release builds.

Recommendation:

Defend at one boundary and preferably two:

- Normalize `NamedTarget::Range` payloads when names are registered or when they are projected into `ResolvedName::Range`.
- Add checked row/column count helpers on `Range` and use them in `ROWS` / `COLUMNS`, returning a loud error (`#REF!` or `#VALUE!`) if an invariant-broken range reaches function dispatch.

Severity rationale:

MEDIUM because normal parsed A1 ranges are safe, but the public API does not actually enforce the invariant the Step 2 arithmetic relies on. If qbook import or external host code can feed raw `Range` structs, this becomes a user-visible wrong result or panic.

## MEDIUM-2

Subject: Step 2 e2e coverage does not exercise WorkbookEnv, named ranges, cross-sheet refs, or production `ROW()` / `COLUMN()`

Where: `crates/ql-exec/tests/reference_fns_e2e.rs:19`, `crates/ql-exec/tests/reference_fns_e2e.rs:77`, `.plans/_active.md:610`, `docs/architecture/2026-05-17-reference-tier-design.md:610`

Detail:

The integration helper binds with `ql_exec::bind` and evaluates against `MapEnv::new()`. That is useful for the pure dispatcher path, but it cannot cover:

- named ranges, because `bind` uses an empty name resolver;
- cross-sheet references by sheet name, because `bind` uses an empty sheet resolver;
- `ROW()` / `COLUMN()` in a real formula cell, because `MapEnv` has no `formula_cell_for_sref`;
- op-log replay / recompute, because no `WorkbookRuntime` path is used.

This leaves several design-required Step 2 cases unpinned. The e2e suite currently proves `ROW()` returns `#REF!` in a non-cell eval context, but not that `WorkbookRuntime::set_formula(..., "ROW()")` returns the formula cell's 1-indexed row or that plan-cache reuse across cells remains correct.

Recommendation:

Add runtime-backed tests using `WorkbookRuntime` or `bind_with_site` + `WorkbookEnv::with_formula_cell`:

- `ROW()` and `COLUMN()` at two different formula cells, proving the same cached plan evaluates cell-specifically.
- `ROW(NamedCell)`, `ROWS(NamedRange)`, `COLUMNS(NamedRange)`.
- `ROW(Sheet2!B5)` / `COLUMN(Sheet2!B5)`.
- One replay/recompute test for a stored `ROW()` formula.

Severity rationale:

MEDIUM because the implementation appears correct by inspection, but the missing tests are exactly the integration surfaces that differ from `MapEnv`: formula-cell context, name/sheet resolution, and replay.

## MEDIUM-3

Subject: The S1-HIGH-B structured-reference boundary guard is not regression-tested

Where: `crates/ql-exec/src/scalar.rs:849`, `crates/ql-exec/tests/reference_fns_e2e.rs:214`, `crates/ql-exec/tests/reference_fns_e2e.rs:230`, `crates/ql-exec/tests/reference_fns_e2e.rs:245`

Detail:

The e2e file comments say the cell-boundary tests exercise the S1-HIGH-B closure. They do not exercise the branch that S1-HIGH-B was about. The tests cover literal `RangeRef` cases (`ROW(A1:B3)`, `ROW(A5:A5)`, `COLUMN(A1:C1)`), while the repaired branch in `eval_at_cell_boundary` is the `ExprPlan::StructuredRef` arm at `scalar.rs:849-861`.

The code path is present and looks right: it narrows `[@...]` forms before deciding whether the range is multi-cell. But the prior high-severity bug was specifically that structured refs bypassed the guard, and that exact shape still has no regression test with the real ROW/COLUMN registrations.

Recommendation:

Add table-backed cell-boundary tests:

- `ROW(Sales[Qty])` and `COLUMN(Sales[Qty])` return `#CALC!` when the column data range is multi-cell.
- `ROW(Sales[@Qty])` / `COLUMN(Sales[@Qty])` from a formula cell inside the table do not trip the multi-cell guard.
- A formula-cell-outside-table `[@]` narrowing error still surfaces through the normal scalar path.

Severity rationale:

MEDIUM because this is a regression-test gap for a Step 1 HIGH closure that becomes user-facing in Step 2. The literal-range tests prove the generic guard, not the structured-reference branch that previously failed.

## LOW-1

Subject: `is_reference_aware_function` doc comment is stale after Step 2 registration

Where: `crates/ql-exec/src/plan.rs:496`

Detail:

The doc comment still says the matcher is pinned by an invariant test "added in this commit" and that "v1 always returns false until the 7 reference-aware fns are registered in Step 2 / 3 / 4." The function itself returns true for all seven names, and Step 2 has now registered four of them. The matcher-side and registry-side tests pass; the comment is the stale part.

Recommendation:

Update the comment to describe the current state: the matcher intentionally lists all seven names, the matcher-pin test covers the full list, and the Step 2 registry-side invariant covers the four currently registered names.

## LOW-2

Subject: Coverage-defer reason overclaims the covered classes

Where: `crates/ql-functions/tests/coverage.rs:576`

Detail:

The new `EXPLICITLY_DEFERRED` block says the per-fn unit tests cover "anchor / range / whole-column / array literal / error propagation / arity / non-reference." That is accurate for the batch as a whole, but not for each function:

- `COLUMN` lacks a too-many-args arity test.
- ROW/COLUMN do not and should not have whole-column/array-acceptance tests in the same sense as ROWS/COLUMNS.
- Named-range and cross-sheet classes required by the design are not covered in unit or e2e tests.

Recommendation:

Tighten the coverage note to avoid implying every listed class is covered for every function. If the missing classes are intentionally deferred to Step 5, say that explicitly and add the runtime-backed tests recommended above.
