//! **W5-RT-2 / Step 2.1 closures** — coverage extension tests for the
//! S2-HIGH-1 closure (named-range + cross-sheet + workbook-runtime
//! formula-cell paths) and S2-HIGH-3 closure (pin `ROW(SUM(A1:A3))`
//! bind-fail as documented v1 scope).
//!
//! These tests exercise the dispatch paths the Step 2 e2e file
//! intentionally skipped because they require more elaborate setup
//! (Workbook + NameTable / 2-sheet workbook / WorkbookEnv::with_formula_cell).
//!
//! Structured-ref and implicit-intersection (`@ROW(A1:A10)`) coverage
//! is deferred to the Step 5 cross-cutting suite per design § 7.

use ql_exec::{bind_with_names_and_sheets, eval_scalar_with_cache, MapEnv, NoAggregateCache};
use ql_formula_syntax::{lex, parse};
use ql_functions::default_registry;
use ql_storage::{NamedTarget, Workbook};
use ql_types::{Address, ErrorValue, Range, Value};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

fn workbook_with_two_sheets() -> Workbook {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    wb.add_sheet("Sheet2");
    wb
}

fn parse_and_bind_with_workbook(src: &str, wb: &Workbook) -> ql_exec::ExprPlan {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    bind_with_names_and_sheets(&ast, 0, wb, wb, &reg).expect("bind")
}

// ---------------------------------------------------------------------
// Named-range coverage (S2-HIGH-1)
// ---------------------------------------------------------------------

#[test]
fn rows_of_named_range_returns_range_height() {
    let mut wb = workbook_with_two_sheets();
    // NamedRange `Sales` covers Sheet1!A1:A10 → ROWS(Sales) = 10.
    let range = Range::new(0, 0, 0, 9, 0);
    wb.set_name("Sales", NamedTarget::Range(range)).unwrap();

    let plan = parse_and_bind_with_workbook("ROWS(Sales)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    let result = eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache);
    assert_eq!(result, Value::number(10.0));
}

#[test]
fn columns_of_named_range_returns_range_width() {
    let mut wb = workbook_with_two_sheets();
    let range = Range::new(0, 0, 0, 0, 4);
    wb.set_name("Headers", NamedTarget::Range(range)).unwrap();

    let plan = parse_and_bind_with_workbook("COLUMNS(Headers)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(5.0)
    );
}

#[test]
fn row_of_named_range_returns_top_left_row() {
    let mut wb = workbook_with_two_sheets();
    // Named range Sheet1!C3:E10 → ROW(MyRange) = 3 (top-left row 0-indexed → 2+1).
    let range = Range::new(0, 2, 2, 9, 4);
    wb.set_name("MyRange", NamedTarget::Range(range)).unwrap();

    let plan = parse_and_bind_with_workbook("ROW(MyRange)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(3.0)
    );
}

#[test]
fn column_of_named_range_returns_top_left_col() {
    let mut wb = workbook_with_two_sheets();
    let range = Range::new(0, 2, 2, 9, 4);
    wb.set_name("MyRange", NamedTarget::Range(range)).unwrap();

    let plan = parse_and_bind_with_workbook("COLUMN(MyRange)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(3.0)
    );
}

// ---------------------------------------------------------------------
// Cross-sheet coverage (S2-HIGH-1)
// ---------------------------------------------------------------------

#[test]
fn row_of_cross_sheet_cell_ref_returns_row() {
    let wb = workbook_with_two_sheets();
    // Sheet2!B5 — row 4 (0-indexed) → ROW returns 5.
    let plan = parse_and_bind_with_workbook("ROW(Sheet2!B5)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(5.0)
    );
}

#[test]
fn column_of_cross_sheet_cell_ref_returns_column() {
    let wb = workbook_with_two_sheets();
    // Sheet2!D2 — col 3 (0-indexed) → COLUMN returns 4.
    let plan = parse_and_bind_with_workbook("COLUMN(Sheet2!D2)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(4.0)
    );
}

#[test]
fn rows_of_cross_sheet_range_returns_height() {
    let wb = workbook_with_two_sheets();
    // Sheet2!A1:A5 → 5 rows.
    let plan = parse_and_bind_with_workbook("ROWS(Sheet2!A1:A5)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(5.0)
    );
}

#[test]
fn columns_of_cross_sheet_range_returns_width() {
    let wb = workbook_with_two_sheets();
    let plan = parse_and_bind_with_workbook("COLUMNS(Sheet2!A1:E1)", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(5.0)
    );
}

// ---------------------------------------------------------------------
// Workbook-runtime `=ROW()` formula-cell happy path (S2-HIGH-1)
// ---------------------------------------------------------------------

#[test]
fn row_zero_arg_with_formula_cell_via_workbook_env_returns_row() {
    use ql_exec::WorkbookEnv;

    let mut wb = workbook_with_two_sheets();
    // Insert some seed cell so the sheet exists.
    wb.sheet_mut(0).unwrap().put(0, 0, Value::number(1.0));

    // Bind `ROW()` (no arg).
    let tokens = lex("ROW()").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");

    // Construct a WorkbookEnv with formula_cell = Sheet1!B3 (row 2, col 1).
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 2, 1));
    let reg = default_registry();
    let result = eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache);
    // ROW() at B3 = 3 (1-indexed).
    assert_eq!(result, Value::number(3.0));
}

#[test]
fn column_zero_arg_with_formula_cell_via_workbook_env_returns_col() {
    use ql_exec::WorkbookEnv;

    let mut wb = workbook_with_two_sheets();
    wb.sheet_mut(0).unwrap().put(0, 0, Value::number(1.0));

    let tokens = lex("COLUMN()").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");

    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 7, 4));
    // COLUMN() at E8 = 5 (col 4 + 1).
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::number(5.0)
    );
}

#[test]
fn row_zero_arg_evaluates_per_cell_via_plan_cache_sharing() {
    // Verify that the same plan tree (cached) evaluates cell-specifically.
    // `=ROW()` bound once produces `Function { name: "ROW", args: [] }`.
    // Two different WorkbookEnv-with-formula-cell instances should each
    // return THEIR cell's row.
    use ql_exec::WorkbookEnv;

    let mut wb = workbook_with_two_sheets();
    wb.sheet_mut(0).unwrap().put(0, 0, Value::number(1.0));

    let tokens = lex("ROW()").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg).expect("bind");
    // Env at row 2 → ROW() = 3.
    let env_b3 = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 2, 1));
    assert_eq!(
        eval_scalar_with_cache(&plan, &env_b3, &reg, &NoAggregateCache),
        Value::number(3.0)
    );

    // Same plan, env at row 5 → ROW() = 6.
    let env_b6 = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 5, 1));
    assert_eq!(
        eval_scalar_with_cache(&plan, &env_b6, &reg, &NoAggregateCache),
        Value::number(6.0)
    );
}

// ---------------------------------------------------------------------
// W2-literal-range: `ROW(SUM(A1:A3))` now BINDS (literal range in the
// inner aggregate is accepted) and evaluates to #VALUE! — matching the
// named-range sibling below and the Microsoft-canon result.
// ---------------------------------------------------------------------

#[test]
fn row_of_sum_literal_range_now_binds_and_evaluates_to_value_error() {
    // **W2-literal-range (2026-06-09):** previously
    // `row_of_sum_literal_range_bind_fails_v1_scope` pinned the S1-MED-γ
    // AggregateArg defer — the inner `A1:A3` was rejected in
    // `BindContext::AggregateArg`. W2 lifts that defer, so the inner
    // `SUM(A1:A3)` now binds (literal range → `ExprPlan::RangeRef`),
    // evaluates to a scalar, and the outer `ROW(scalar)` returns #VALUE!
    // per the Microsoft-canon `ROW(SUM(A1:A3)) → #VALUE!`. This is now
    // byte-identical to the named-range form
    // (`row_of_sum_named_range_works_via_existing_aggregate_path`).
    use ql_exec::WorkbookEnv;
    let mut wb = workbook_with_two_sheets();
    wb.sheet_mut(0).unwrap().put(0, 0, Value::number(1.0));
    wb.sheet_mut(0).unwrap().put(1, 0, Value::number(2.0));
    wb.sheet_mut(0).unwrap().put(2, 0, Value::number(3.0));
    let tokens = lex("ROW(SUM(A1:A3))").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let plan = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg)
        .expect("W2: ROW(SUM(A1:A3)) now binds — literal range in aggregate arg");
    let env = WorkbookEnv::with_formula_cell(&wb, Address::new(0, 0, 1));
    // SUM(A1:A3) = 6 (scalar); ROW(scalar) = #VALUE!.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn row_of_sum_named_range_works_via_existing_aggregate_path() {
    // The named-range form DOES work — `AggregateNameRef` is the
    // existing path. SUM(Sales) eagerly evaluates; ROW receives a Scalar
    // arg and returns #VALUE! per the design.
    let mut wb = workbook_with_two_sheets();
    let range = Range::new(0, 0, 0, 2, 0);
    wb.set_name("Sales", NamedTarget::Range(range)).unwrap();

    let plan = parse_and_bind_with_workbook("ROW(SUM(Sales))", &wb);
    let env = MapEnv::new();
    let reg = default_registry();
    // SUM(Sales) = 0 (empty cells). ROW(Scalar) = #VALUE!.
    assert_eq!(
        eval_scalar_with_cache(&plan, &env, &reg, &NoAggregateCache),
        Value::Error(ErrorValue::Value)
    );
}

// ---------------------------------------------------------------------
// S2-HIGH-2 closure verification: CellRef materializer propagates errors
// ---------------------------------------------------------------------

#[test]
fn row_of_unknown_sheet_at_bind_time_surfaces_error_class() {
    // The binder's `Expr::CellRef(SheetRef::Name)` resolution catches
    // unknown sheets at BIND time, surfacing `BindError::UnknownSheet`.
    // So `ROW(UnknownSheet!A1)` is rejected before reaching the
    // materializer — the S2-HIGH-2 fix targets the eval-time path,
    // which is only reachable today via WorkbookEnv constructed with
    // a stale sheet ID (no production path; verified via runtime
    // delete-sheet absence). This test pins the bind-time rejection
    // explicitly so a future implementation that DOES enable
    // runtime sheet deletion has a regression target for the materializer's
    // post-fix Value::Error → RefArg::Error path.
    let wb = workbook_with_two_sheets();
    let tokens = lex("ROW(UnknownSheet!A1)").expect("lex");
    let ast = parse(tokens).expect("parse");
    let reg = default_registry();
    let result = bind_with_names_and_sheets(&ast, 0, &wb, &wb, &reg);
    assert!(
        result.is_err(),
        "unknown-sheet CellRef should bind-fail; got {result:?}"
    );
}
