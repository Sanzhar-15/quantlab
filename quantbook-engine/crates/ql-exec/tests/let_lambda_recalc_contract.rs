//! **Wave P (2026-06-20) — LET/LAMBDA dependency-extraction recalc contract.**
//!
//! THE #1 correctness risk for LET/LAMBDA: a `CellRef` inside a LET binding
//! VALUE or a LAMBDA BODY must register as a PRECEDENT in the calcgraph, so
//! editing that cell re-dirties + recomputes the formula. A `walk_plan_for_deps`
//! arm that forgot to descend the binding values / body would compile fine but
//! leave the dependent STALE — caught here, deterministically, via the real
//! production recompute path (`WorkbookRuntime` + `CalcgraphSession`).

use ql_exec::{CalcgraphSession, WorkbookRuntime};
use ql_functions::{default_registry, FunctionRegistry};
use ql_storage::Workbook;
use ql_types::{Address, ErrorValue, Value};

/// Build a 1-sheet workbook with `A1 = a1` and `B1 = <formula>`, then build the
/// calcgraph (the dep-extraction pass that walks every formula's `ExprPlan`).
fn setup(formula_b1: &str, a1: f64) -> (Workbook, CalcgraphSession, FunctionRegistry) {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 0, 0, Value::Number(a1)).unwrap();
        rt.set_formula(0, 0, 1, formula_b1).unwrap();
    }
    let rebuilt = CalcgraphSession::rebuild_from_workbook(&wb);
    assert!(
        rebuilt.is_complete(),
        "{} build failures",
        rebuilt.failures.len()
    );
    (wb, rebuilt.session, reg)
}

#[test]
fn let_binding_cell_ref_is_a_precedent() {
    // B1 = =LET(a, A1, a+1). Initially A1=10 -> B1=11.
    let (mut wb, mut graph, reg) = setup("LET(a,A1,a+1)", 10.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(11.0),
        "initial B1 = A1 + 1 = 11"
    );

    // Edit A1 -> 20. The LET binding reads A1, so B1 MUST re-dirty + recompute.
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the dependent LET formula (attempted == 0 means \
         the dep was never registered)"
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(21.0),
        "B1 must recompute to 21 after A1 -> 20; a STALE 11 means the LET dep-walker \
         arm failed to register A1 (inside the binding value) as a precedent"
    );
}

#[test]
fn lambda_body_cell_ref_is_a_precedent() {
    // B1 = =LET(f, LAMBDA(x, x+A1), f(2)). Initially A1=10 -> B1 = 2 + 10 = 12.
    let (mut wb, mut graph, reg) = setup("LET(f,LAMBDA(x,x+A1),f(2))", 10.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(12.0),
        "initial B1 = 2 + A1 = 12"
    );

    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached");
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(22.0),
        "B1 must recompute to 22 after A1 -> 20; a STALE 12 means the LAMBDA-body \
         dep-walker arm failed to register A1 (inside the lambda body) as a precedent"
    );
}

#[test]
fn let_independent_of_unrelated_cell_edits() {
    // B1 = =LET(a, A1, a+1) does NOT depend on C1 — editing C1 must not change B1
    // (the LocalRef `a` carries no spurious grid dep).
    let (mut wb, mut graph, reg) = setup("LET(a,A1,a+1)", 10.0);
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 2, Value::Number(999.0)).unwrap(); // C1, unrelated
        rt.recompute_dirty().expect("graph attached");
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(11.0),
        "B1 stays 11 — it does not depend on C1"
    );
}

#[test]
fn let_use_before_bind_is_rejected_at_bind() {
    // =LET(x, y, y, 2, x): the VALUE of `x` references `y` BEFORE `y` is bound
    // (LET binds left-to-right), so `y` is an UNRESOLVED name. Our engine binds
    // eagerly at `set_formula` (`bind_with_site(...)?`), so — exactly like any
    // other unresolved-name formula — the entry is rejected LOUDLY at bind time
    // (a `RuntimeError` carrying the `UnresolvedName`), not silently stored.
    // This proves the left-to-right scoping: `y` is correctly NOT a local when
    // `x`'s value binds (donor `let_undefined_symbol_before_binding`; the donor
    // engine surfaces #NAME? in the cell instead — both are loud, No-Fallbacks).
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let result = rt.set_formula(0, 0, 1, "LET(x,y,y,2,x)");
    assert!(
        result.is_err(),
        "use-before-bind inside LET must be rejected at bind time \
         (unresolved name 'y'); got {result:?}"
    );
}

#[test]
fn uninvoked_lambda_self_ref_is_conservatively_circular() {
    // **Codex megaudit #2 (CONFIRMED — a conservative over-dependency, NOT
    // benign as first thought).** A1 = =LET(f, LAMBDA(x, A1), 1). The dep walker
    // descends the lambda body unconditionally (REQUIRED so an INVOKED lambda's
    // cell refs recalc — see `lambda_body_cell_ref_is_a_precedent`), so it
    // registers A1 as a precedent of A1 even though `f` is never invoked. The
    // VALUE on the initial inline compute is 1, but a full topological pass
    // (`recompute_all`) detects the A1->A1 self-edge and surfaces `#CIRC!`.
    //
    // This is a CONSERVATIVE dependency behavior (a formula that textually
    // self-references inside a never-taken position is flagged circular — the
    // same class as `=IF(FALSE, A1, 1)` in A1). It is LOUD (`#CIRC!`), and the
    // trigger (an uninvoked lambda whose body cyclically references its own
    // cell) is contrived. A precise invocation-aware dep walker (registering
    // lambda-body deps only for INVOKED lambdas) would return 1 here; that is a
    // documented follow-up. This test PINS the current conservative behavior so
    // a change is deliberate, not accidental.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "LET(f,LAMBDA(x,A1),1)").unwrap();
    }
    let rebuilt = CalcgraphSession::rebuild_from_workbook(&wb);
    let mut graph = rebuilt.session;
    // Initial inline compute: the lambda is not invoked, so the value is 1.
    assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
    // Full topological recompute detects the conservative self-edge -> #CIRC!.
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.recompute_all();
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 0)),
        Value::Error(ErrorValue::Circ),
        "conservative self-edge from the (uninvoked) lambda body -> #CIRC! on a \
         full recompute; loud + contrived, documented as a follow-up"
    );
}
