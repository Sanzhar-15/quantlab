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
use ql_types::{Address, Value};

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
fn let_dead_lambda_binding_is_not_circular() {
    // **Wave P follow-up 1 (dead-local-binding elimination) — boundary CLOSED.**
    // A1 = =LET(f, LAMBDA(x, A1), 1). `f` is a LAMBDA bound to a local that is NEVER
    // referenced in the body (`1`), so it can never be invoked and A1 is never read.
    // The dep walker's `Let` arm now SKIPS walking a dead lambda binding's body, so
    // A1 is no longer registered as a (spurious self-)precedent of A1. The value is
    // 1 both on the initial inline compute AND after a full topological
    // `recompute_all` — no more conservative `#CIRC!`.
    //
    // (Pre-fix this surfaced `#CIRC!` on `recompute_all` because the lambda body was
    // walked unconditionally, creating an A1->A1 self-edge. That was the worst of the
    // three Wave P boundaries — a WRONG result where Excel returns 1.) The
    // under-dependency guards below prove the skip is SOUND: a lambda whose name IS
    // referenced (invoked, passed, aliased, nested) still registers its body's deps.
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
    // Full topological recompute no longer sees a self-edge -> stays 1 (not #CIRC!).
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.recompute_all();
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 0)),
        Value::Number(1.0),
        "the dead lambda binding's body is no longer walked, so there is no spurious \
         A1->A1 self-edge; `recompute_all` returns 1 (Excel parity), not #CIRC!"
    );
}

/// **Wave P follow-up 1 — under-dependency guard harness.** Edit A1 and assert B1
/// recomputes from `b1_init` to `b1_new`. A STALE `b1_init` means the dead-binding
/// liveness scan wrongly dropped A1 as a precedent (an UNDER-dependency = a silent
/// wrong value, the cardinal sin). Each caller routes the use of the A1-reading
/// lambda through a different `ExprPlan` shape, so collectively they pin that
/// `plan_references_local` descends every composite variant.
fn assert_edit_a1_recomputes(
    formula_b1: &str,
    a1_init: f64,
    b1_init: f64,
    a1_new: f64,
    b1_new: f64,
) {
    let (mut wb, mut graph, reg) = setup(formula_b1, a1_init);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(b1_init),
        "initial B1 for `{formula_b1}`"
    );
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(a1_new)).unwrap();
        rt.recompute_dirty().expect("graph attached");
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(b1_new),
        "B1 must recompute after editing A1 in `{formula_b1}`; a STALE value means the \
         liveness scan dropped A1 (under-dependency = silent wrong)"
    );
}

#[test]
fn live_lambda_use_in_nested_lambda_body_keeps_dep() {
    // `f` is used (invoked) inside ANOTHER lambda's body (`g`'s body `f(z)`). The
    // liveness scan must descend `Lambda` bodies to see that use, else A1 is dropped.
    assert_edit_a1_recomputes(
        "LET(f,LAMBDA(x,A1),g,LAMBDA(z,f(z)),g(2))",
        10.0,
        10.0,
        20.0,
        20.0,
    );
}

#[test]
fn live_lambda_use_as_call_arg_keeps_dep() {
    // `f` is passed as an ARGUMENT to `apply` and invoked through a param. The scan
    // must descend `CallLambda.args` to see the use.
    assert_edit_a1_recomputes(
        "LET(f,LAMBDA(x,A1),apply,LAMBDA(h,n,h(n)),apply(f,2))",
        10.0,
        10.0,
        20.0,
        20.0,
    );
}

#[test]
fn live_lambda_use_as_call_callee_keeps_dep() {
    // `f` is invoked directly (`f(0)`). The scan must descend `CallLambda.callee`.
    assert_edit_a1_recomputes("LET(f,LAMBDA(x,A1),f(0))", 10.0, 10.0, 20.0, 20.0);
}

#[test]
fn live_lambda_use_in_nested_let_value_keeps_dep() {
    // `f` is used inside a NESTED LET's binding value (`r = LET(q,f(0),q)`). The scan
    // must descend `Let` binding values.
    assert_edit_a1_recomputes(
        "LET(f,LAMBDA(x,A1),r,LET(q,f(0),q),r)",
        10.0,
        10.0,
        20.0,
        20.0,
    );
}

#[test]
fn live_lambda_use_in_function_arg_keeps_dep() {
    // `f` is invoked inside a `Function` arg list (`SUM(f(1),f(2))` = 2*A1). The scan
    // must descend `Function.args`.
    assert_edit_a1_recomputes("LET(f,LAMBDA(x,A1),SUM(f(1),f(2)))", 10.0, 20.0, 20.0, 40.0);
}

#[test]
fn live_lambda_use_in_binary_operand_keeps_dep() {
    // `f` is invoked inside a `Binary` operand (`f(0)+1`). The scan must descend
    // `Binary.lhs`/`Binary.rhs`.
    assert_edit_a1_recomputes("LET(f,LAMBDA(x,A1),f(0)+1)", 10.0, 11.0, 20.0, 21.0);
}

#[test]
fn live_lambda_use_in_unary_operand_keeps_dep() {
    // `f` is invoked under a `Unary` negation (`-f(0)`). The scan must descend
    // `Unary.operand`.
    assert_edit_a1_recomputes("LET(f,LAMBDA(x,A1),-f(0))", 10.0, -10.0, 20.0, -20.0);
}

#[test]
fn let_dead_lambda_binding_skips_unread_cell_dep() {
    // The precise POSITIVE assertion that the skip fired: `=LET(f,LAMBDA(x,A1),1)` in
    // B1 — `f` is dead (unused in the body `1`), so A1 is NOT a precedent and editing
    // A1 recomputes NOTHING (attempted == 0). Pre-fix A1 was registered and B1 would
    // be recomputed (the over-dependency this follow-up removes).
    let (mut wb, mut graph, reg) = setup("LET(f,LAMBDA(x,A1),1)", 10.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(1.0), "B1 = 1");
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert_eq!(
        attempted, 0,
        "editing A1 must NOT recompute B1 — the dead lambda binding's body cells are \
         not precedents (the liveness skip fired); attempted == {attempted} means A1 \
         was wrongly registered"
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(1.0),
        "B1 stays 1"
    );
}

#[test]
fn let_same_level_reused_name_dead_lambda_is_precisely_dropped() {
    // `=LET(f,LAMBDA(x,A1),f,7,f)` in B1: the first `f` (body reads A1) is shadowed by
    // `f=7` at the SAME LET level before any use, so the result is 7 and A1 is never
    // read. The liveness scan bounds its search to the bindings BEFORE the next
    // same-name rebind (here: none) and does NOT scan the body (the body's `f`
    // resolves to `f=7`, not the first f). So the first binding is PRECISELY dropped —
    // A1 is not a precedent and editing A1 recomputes nothing.
    //
    // This is the fix for the Codex megaudit HIGH: the name-keyed scan used to keep
    // the first f live, which was safe for cell dirtying but caused
    // `plan_references_udf` to over-PRESERVE a stale saved value for a shadowed
    // lambda that named a UDF (`dead_lambda_binding_drops_function_refs_in_its_body`
    // pins the UDF analog).
    let (mut wb, mut graph, reg) = setup("LET(f,LAMBDA(x,A1),f,7,f)", 10.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(7.0),
        "B1 = 7 (first f shadowed by f=7 before any use)"
    );
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert_eq!(
        attempted, 0,
        "the same-level-shadowed dead first f is precisely dropped, so A1 is NOT a \
         precedent and editing A1 recomputes nothing; attempted == {attempted} means \
         the shadow-precise bound failed and A1 was wrongly registered"
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(7.0),
        "B1 stays 7"
    );
}

#[test]
fn live_lambda_captured_before_same_level_rebind_keeps_dep() {
    // **No-under-dependency guard for the shadow-precise bound (Codex re-audit).** The
    // first `f` reads A1 and is shadowed by `f,7` later — BUT `g` (bound BEFORE the
    // rebind) captures the first `f` in its closure and invokes it via `g(2)`. So A1
    // IS read at eval and MUST stay a precedent. The liveness scan must find the use
    // of `f` inside `g`'s value (which lies in `[idx+1 .. next_rebind)`), proving the
    // bound does not drop a binding captured before its rebind. `g(2)` -> first
    // `f(2)` -> A1.
    assert_edit_a1_recomputes(
        "LET(f,LAMBDA(x,A1),g,LAMBDA(z,f(z)),f,7,g(2))",
        10.0,
        10.0,
        20.0,
        20.0,
    );
}

/// Read the extracted `FormulaDeps` for the B1 formula (or `None` if it has no
/// tracked deps and so was not stored).
fn formula_deps_for(formula_b1: &str) -> Option<ql_exec::FormulaDeps> {
    let (_wb, graph, _reg) = setup(formula_b1, 0.0);
    let node = graph.cell_node_for(0, 0, 1)?;
    graph.formula_deps(node).cloned()
}

#[test]
fn dead_lambda_binding_drops_function_refs_in_its_body() {
    // `plan_references_udf` (workbook_runtime/recompute.rs) REUSES `walk_plan_for_deps`
    // and inspects `FormulaDeps.functions_used` to decide whether a worker-less load
    // should preserve a cached UDF value. So the dead-binding skip must also drop
    // function names that appear ONLY inside a dead lambda body — else a worker-less
    // load over-preserves. Proxy via the public `functions_used` field (populated by
    // the SAME `walk_plan_for_deps` call that `plan_references_udf` runs independently
    // on the plan), using the builtin SUM as a stand-in name.
    let dead = formula_deps_for("LET(f,LAMBDA(x,SUM(A1)),1)");
    assert!(
        dead.as_ref().map_or(true, |d| !d
            .functions_used
            .iter()
            .any(|n| n.as_ref() == "SUM")),
        "a function named only inside a DEAD lambda body must not be tracked; got {dead:?}"
    );
    let live = formula_deps_for("LET(f,LAMBDA(x,SUM(A1)),f(0))").expect("live formula has deps");
    assert!(
        live.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "a function inside a LIVE (invoked) lambda body must be tracked; got {live:?}"
    );
    // **Codex megaudit HIGH fix (same-level shadow).** `=LET(f,LAMBDA(x,SUM(A1)),f,7,A1+f)`
    // — the first f names SUM but is shadowed by `f=7` before use, so it is never
    // invoked. With the shadow-precise bound the first f is dropped, so SUM is NOT in
    // `functions_used` — `plan_references_udf` therefore no longer over-preserves a
    // stale saved value for the analogous real-UDF formula on a worker-less load.
    let shadowed = formula_deps_for("LET(f,LAMBDA(x,SUM(A1)),f,7,A1+f)");
    assert!(
        shadowed.as_ref().map_or(true, |d| !d
            .functions_used
            .iter()
            .any(|n| n.as_ref() == "SUM")),
        "a function named only inside a SAME-LEVEL-SHADOWED dead lambda must not be \
         tracked (Codex HIGH); got {shadowed:?}"
    );
}

#[test]
fn dead_lambda_udf_leak_known_residual_pins_current_behavior() {
    // **KNOWN RESIDUAL (Codex re-audit w104-fu; operator-approved ship-with-residual).**
    // The dead-binding skip closes the simple-dead and same-level-shadow slices of the
    // stale-UDF over-preservation class, but TWO slices remain and still record a
    // function ref from a never-invoked dead lambda — a SILENT stale on the worker-less
    // `.qbook` load path (via `plan_references_udf`). The precise invocation-aware dep
    // walker (the named NEXT wave) closes both; this test PINS the current behavior so
    // that fix is a deliberate flip, not an accident. (SUM stands in for a UDF name.)
    //
    // Slice 1 — NESTED shadow: `g,LET(f,0,f)` makes the name-keyed scan think the outer
    // dead `f` is used (the inner `LocalRef(F)` resolves to the nested `f=0`, not the
    // outer one).
    let nested = formula_deps_for("LET(f,LAMBDA(x,SUM(A1)),g,LET(f,0,f),f,7,A1+f)")
        .expect("formula has deps (A1 cell)");
    assert!(
        nested.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "RESIDUAL: nested-shadow dead lambda still leaks its function ref (precise \
         walker closes this); got {nested:?}"
    );

    // Slice 2 — INDIRECT callable producer: the first `f`'s value is a `LET` that
    // RETURNS a lambda, so the skip (which matches only a direct `ExprPlan::Lambda`
    // value) walks it and reaches the inner lambda's `SUM`.
    let indirect = formula_deps_for("LET(f,LET(z,0,LAMBDA(x,SUM(A1))),f,7,A1+f)")
        .expect("formula has deps (A1 cell)");
    assert!(
        indirect.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "RESIDUAL: indirect callable-producer dead binding still leaks its function ref \
         (precise walker closes this); got {indirect:?}"
    );
}
