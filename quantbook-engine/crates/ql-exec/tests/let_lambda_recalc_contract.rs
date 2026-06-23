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
use ql_storage::{SpillShape, Workbook};
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
fn let_dead_lambda_binding_is_not_circular() {
    // **Wave P follow-up 1 → FU-NEXT (dead-lambda elimination) — boundary CLOSED.**
    // A1 = =LET(f, LAMBDA(x, A1), 1). `f` is a LAMBDA bound to a local that is NEVER
    // invoked (the body `1` has no call site), so A1 is never read. The dep walker walks
    // a lambda body only when the lambda is in the `invoked` set (`invoked_lambda_bodies`);
    // `f` has no call site, so it is not invoked and its body is not walked — A1 is no
    // longer registered as a (spurious self-)precedent of A1. The value is 1 both on the
    // initial inline compute AND after a full topological `recompute_all` — no more
    // conservative `#CIRC!`.
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

/// **Wave P follow-up 1 → FU-NEXT — under-dependency guard harness.** Edit A1 and assert
/// B1 recomputes from `b1_init` to `b1_new`. A STALE `b1_init` means the invocation-aware
/// analysis wrongly concluded the lambda is not invoked and the walker dropped A1 as a
/// precedent (an UNDER-dependency = a silent wrong value, the cardinal sin). Each caller
/// routes the use of the A1-reading lambda through a different `ExprPlan` shape, so
/// collectively they pin that `invoked_lambda_bodies` finds the call site through every
/// composite variant.
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
    // read. The body is `f` — a `LocalRef` in VALUE position, not a call site — so no
    // `CallLambda` ever resolves to the first `f`; `invoked_lambda_bodies` never marks it
    // invoked and the walker never walks its body. So the first binding is PRECISELY
    // dropped — A1 is not a precedent and editing A1 recomputes nothing.
    //
    // (This shape was already precise under Wave-P-follow-up-1's same-level-shadow bound;
    // FU-NEXT keeps it precise for the more general reason above. The UDF analog is pinned
    // by `dead_lambda_binding_drops_function_refs_in_its_body`.)
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
fn dead_lambda_udf_leak_residual_closed_by_invocation_aware_walker() {
    // **FU-NEXT (2026-06-21) — the stale-UDF over-preservation class is now CLOSED.**
    // Wave-P-follow-up-1's name-keyed scan left two slices that still recorded a function
    // ref from a never-invoked dead lambda — a SILENT stale on the worker-less `.qbook`
    // load path (via `plan_references_udf`, which reuses `walk_plan_for_deps`'s
    // `functions_used`). The invocation-aware walker drops a lambda body unless the
    // lambda is provably invoked; in both formulas below NO `CallLambda` ever references
    // the dead `f`, so its body (and the `SUM` it names) is never walked. This test was
    // `..._pins_current_behavior` (asserting SUM WAS leaked); FU-NEXT flips it to assert
    // the leak is gone. (SUM stands in for a UDF name; only the live `A1+f` body keeps
    // A1 as a cell-dep.)
    //
    // Slice 1 — NESTED shadow: `g,LET(f,0,f)` used to make the name-keyed scan think the
    // outer dead `f` was live (the inner `LocalRef(F)` resolves to the nested `f=0`).
    let nested = formula_deps_for("LET(f,LAMBDA(x,SUM(A1)),g,LET(f,0,f),f,7,A1+f)")
        .expect("formula has deps (A1 cell)");
    assert!(
        !nested.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "nested-shadow dead lambda must no longer leak its function ref — the lambda is \
         never invoked, so its body is not walked; got {nested:?}"
    );

    // Slice 2 — INDIRECT callable producer: the first `f`'s value is a `LET` that RETURNS
    // a lambda. The old skip matched only a direct `ExprPlan::Lambda` value and walked
    // this, reaching the inner lambda's `SUM`. The invocation-aware walker resolves the
    // closure flow and sees `f` is never called, so the inner body is not walked.
    let indirect = formula_deps_for("LET(f,LET(z,0,LAMBDA(x,SUM(A1))),f,7,A1+f)")
        .expect("formula has deps (A1 cell)");
    assert!(
        !indirect.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "indirect callable-producer dead binding must no longer leak its function ref; \
         got {indirect:?}"
    );
}

#[test]
fn nested_shadow_dead_lambda_self_ref_is_not_circular() {
    // **FU-NEXT — the DIRTYING face of the residual.** The nested-shadow dead-lambda
    // slice (`g,LET(f,0,f)` kept the outer dead `f` name-live for the old name-keyed
    // scan) was not only a SILENT load-path stale (the `functions_used` face, now closed
    // in `dead_lambda_udf_leak_residual_closed_by_invocation_aware_walker`) — when the
    // never-invoked lambda body references the OWNING cell, the spurious body-walk
    // registered a self-edge and `recompute_all` surfaced a LOUD wrong `#CIRC!`.
    //
    // B1 = `=LET(f,LAMBDA(x,B1),g,LET(f,0,f),f,7,1)`: `f` and `g` are both dead, the body
    // is `1`, so B1 = 1 (Excel parity). The first `f`'s body reads B1, but it is never
    // invoked, so B1 must NOT be its own precedent. The invocation-aware walker drops the
    // never-invoked body → no self-edge → 1, not #CIRC!.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 1, "LET(f,LAMBDA(x,B1),g,LET(f,0,f),f,7,1)")
            .unwrap();
    }
    let rebuilt = CalcgraphSession::rebuild_from_workbook(&wb);
    let mut graph = rebuilt.session;
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(1.0),
        "initial inline compute: dead lambdas, body is 1"
    );
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.recompute_all();
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(1.0),
        "the never-invoked nested-shadow dead lambda body is not walked, so there is no \
         spurious B1->B1 self-edge; `recompute_all` returns 1, not #CIRC!"
    );
}

#[test]
fn nested_shadow_dead_lambda_volatile_body_is_not_volatile() {
    // **FU-NEXT — the VOLATILITY face of the residual.** A volatile call (`NOW()`) inside
    // a never-invoked nested-shadow dead lambda body is currently walked, marking the
    // whole formula volatile (it re-fires every recalc) even though the lambda never runs.
    // `=LET(f,LAMBDA(x,NOW()),g,LET(f,0,f),f,7,1)` is a constant `1` — NOT volatile. The
    // invocation-aware walker drops the never-invoked body, so `NOW()` is never seen and
    // the formula has no deps at all (so `formula_deps_for` returns `None`).
    let deps = formula_deps_for("LET(f,LAMBDA(x,NOW()),g,LET(f,0,f),f,7,1)");
    assert!(
        deps.as_ref().map_or(true, |d| !d.is_volatile),
        "a never-invoked dead lambda body's NOW() must NOT make the formula volatile; \
         got {deps:?}"
    );
}

// ===========================================================================
// FU-NEXT no-under-dependency floor — the hard invocation shapes. Each keeps a
// real precedent through a different closure-flow path; a STALE value means the
// invocation-aware analysis under-reported (dropped a body eval actually runs).
// ===========================================================================

#[test]
fn currying_keeps_body_dep() {
    // `=LAMBDA(x,LAMBDA(y,A1+x+y))(5)(3)` — the INNER lambda is returned by the first
    // call and invoked by the second (chained `CallLambda`). Its body reads A1, so A1
    // MUST stay a precedent. This exercises `closures_of` flowing a closure through a
    // `CallLambda`'s RETURN (currying): the inner lambda is reached not via a name but
    // via the outer call's result. A1=10 -> 10+5+3=18; edit A1->20 -> 28.
    assert_edit_a1_recomputes("LAMBDA(x,LAMBDA(y,A1+x+y))(5)(3)", 10.0, 18.0, 20.0, 28.0);
}

#[test]
fn currying_through_let_keeps_body_dep() {
    // FU2's currying-through-LET shape: the returned lambda is produced by a LET body.
    // `=LAMBDA(x,LET(z,x,LAMBDA(y,A1+z+y)))(5)(3)`. `closures_of`'s `Let` arm must thread
    // the produced closure out so the inner body (reading A1) is marked invoked. 18 -> 28.
    assert_edit_a1_recomputes(
        "LAMBDA(x,LET(z,x,LAMBDA(y,A1+z+y)))(5)(3)",
        10.0,
        18.0,
        20.0,
        28.0,
    );
}

#[test]
fn recursive_self_application_keeps_dep_and_terminates() {
    // **Fixpoint termination + soundness on a self-referential callee.** `fact` is invoked
    // (`fact(fact,3)`) and its body calls `self(self,n-1)` — the analysis must reach a
    // fixpoint (the test COMPLETING proves the monotone bound / budget terminates) while
    // still marking the body invoked, so A1 (read in the base arm) stays a precedent.
    // Eval runs to the `MAX_LAMBDA_DEPTH` guard (eager IF makes the self-call always fire)
    // -> `#NUM!`, but the DEP must still include A1: an invoked recursive body keeps its
    // refs (proven at the dep level, independent of the runtime value).
    let deps =
        formula_deps_for("LET(fact,LAMBDA(self,n,IF(n<2,A1,n*self(self,n-1))),fact(fact,3))")
            .expect("formula has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "an invoked recursive lambda body's A1 must be a precedent; got {deps:?}"
    );
}

#[test]
fn both_branches_of_conditional_invoke_keep_deps() {
    // `IF(A2>0, f(1), h(1))` — `f` reads A1, `h` reads C1. The walker descends BOTH
    // Function args, so both lambdas are invocation-reachable and both A1 and C1 are
    // precedents. Sound: it never misses a conditionally-invoked branch (and eager IF
    // evaluates both branches at eval anyway).
    let deps = formula_deps_for("LET(f,LAMBDA(x,A1),h,LAMBDA(y,C1),IF(A2>0,f(1),h(1)))")
        .expect("formula has deps");
    let has = |r, c| deps.cells.iter().any(|&(s, rr, cc)| (s, rr, cc) == (0, r, c));
    assert!(
        has(0, 0) && has(0, 2),
        "both A1 (f's body) and C1 (h's body) must be precedents; got {deps:?}"
    );
}

#[test]
fn invoked_lambda_body_keeps_range_dep() {
    // An INVOKED lambda whose body reads a multi-cell RANGE keeps that range as a
    // precedent (editing a cell inside it recomputes). `LET(s,LAMBDA(x,SUM(A1:A3)),s(0))`.
    let deps = formula_deps_for("LET(s,LAMBDA(x,SUM(A1:A3)),s(0))").expect("has deps");
    assert!(
        !deps.literal_ranges.is_empty(),
        "an invoked body's range A1:A3 must be tracked; got {deps:?}"
    );
    assert!(
        deps.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "an invoked body's SUM must be tracked; got {deps:?}"
    );
}

// ===========================================================================
// FU-NEXT precision wins — context-gated drops a name-only heuristic would miss.
// ===========================================================================

#[test]
fn dead_lambda_invoked_only_inside_dead_outer_lambda_is_dropped() {
    // The win the simpler "name appears in a callee position" heuristic CANNOT get: `f`
    // is called (`f(z)`) ONLY inside `g`'s body, but `g` itself is never invoked (the body
    // is `5`), so `f` is never actually invoked at eval. The context-gated analysis never
    // traverses `g`'s body (g not invoked), so `f` is never marked invoked and SUM is
    // dropped. (SUM stands in for a UDF; a name-only heuristic would wrongly keep it.)
    let deps = formula_deps_for("LET(f,LAMBDA(x,SUM(A1)),g,LAMBDA(z,f(z)),5)");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.functions_used.iter().any(|n| n.as_ref() == "SUM")),
        "a lambda invoked only inside a NEVER-invoked outer lambda must be dropped; \
         got {deps:?}"
    );
}

#[test]
fn bare_uninvoked_top_level_lambda_drops_body_dep() {
    // `=LAMBDA(x,A1)` is an uninvoked callable -> `#CALC!`; its body is never evaluated, so
    // A1 is not a precedent. The bare Lambda is not in the invoked set (no call site), so
    // the old conservative over-dependency (walking the body unconditionally) is gone.
    let (mut wb, mut graph, reg) = setup("LAMBDA(x,A1)", 10.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc),
        "an uninvoked top-level lambda surfaces #CALC!"
    );
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert_eq!(
        attempted, 0,
        "editing A1 must NOT recompute a bare uninvoked lambda (its body is not a \
         precedent); attempted == {attempted} means A1 was wrongly registered"
    );
}

// ===========================================================================
// FU-NEXT megaudit follow-ups (Codex HIGH-1 / HIGH-2).
// ===========================================================================

#[test]
fn isref_lazy_arg_does_not_mark_lambda_invoked() {
    // **Codex FU-NEXT HIGH-1 (FIXED).** `ISREF` is LazyShape — it inspects only its
    // arg's syntactic SHAPE and never evaluates it — so `f(0)` inside `ISREF(f(0))` is
    // never invoked at eval, and `f`'s body (naming SUM, reading A2) must contribute no
    // precedent. Pre-fix, `discover` descended `ISREF`'s arg uniformly and marked `f`
    // invoked, over-reporting SUM + A2 (a worker-less-load stale-preserve). The fix makes
    // `discover` skip LazyShape args, mirroring `walk_plan_for_deps_inner`. Only the live
    // `A1` (outside ISREF) stays a precedent. (SUM stands in for a UDF.)
    let deps = formula_deps_for("LET(f,LAMBDA(x,SUM(A2)),A1+ISREF(f(0)))").expect("has deps");
    assert!(
        !deps.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "ISREF never evaluates its arg, so the lambda is not invoked and SUM must be \
         dropped; got {deps:?}"
    );
    assert!(
        !deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 1, 0)),
        "A2 (inside the never-evaluated ISREF arg's lambda body) must not be a precedent; \
         got {deps:?}"
    );
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "A1 (the live operand outside ISREF) MUST stay a precedent; got {deps:?}"
    );
}

#[test]
fn isref_skip_preserves_union_when_lambda_also_called_outside() {
    // **No-under-dependency guard for the HIGH-1 fix.** The LazyShape skip must only drop
    // the SPURIOUS ISREF-arg invocation — if the SAME lambda is also invoked OUTSIDE the
    // ISREF arg, the union must still mark it invoked. `=LET(f,LAMBDA(x,A1), f(0)+ISREF(f(0)))`
    // — the lhs `f(0)` IS evaluated (reads A1; `ISREF(f(0))` is FALSE→0 and is never
    // evaluated), so A1 MUST stay a precedent even though the ISREF arg's `f(0)` is
    // skipped in `discover`. A STALE drop here would be a silent stale on edit.
    assert_edit_a1_recomputes("LET(f,LAMBDA(x,A1),f(0)+ISREF(f(0)))", 10.0, 10.0, 20.0, 20.0)
}

#[test]
fn name_merge_capture_vs_rebind_is_lexically_resolved() {
    // **FU-NEXT-3 (2026-06-23) -- CLOSES Codex FU-NEXT HIGH-2 (was a documented residual).**
    // `g` captures the FIRST `f` (reads A1); the THIRD `f` (names SUM, reads A2) is rebound
    // AFTER `g` is defined and is NEVER invoked -- only `g(2)` runs, and a closure captures
    // the env at CREATION (`eval_binding`'s Lambda arm), so `g`'s `f(z)` calls the first `f`,
    // not the third. At eval SUM never dispatches. The closure environment is now keyed by
    // lexical BINDING SITE, so resolving `f(z)` inside `g`'s body yields ONLY the first `f`
    // (the binding in scope at `g`'s definition) -- the rebind is a DISTINCT site that never
    // leaks in. So SUM (and A2) are NO LONGER over-reported. (Flipped from
    // `_over_preserve_known_residual`, which asserted SUM WAS present.) (SUM ~ a UDF name.)
    let deps = formula_deps_for("LET(f,LAMBDA(x,A1),g,LAMBDA(z,f(z)),f,LAMBDA(x,SUM(A2)),g(2))")
        .expect("has deps (the live first f's A1)");
    assert!(
        !deps.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "FU-NEXT-3: the rebound-but-never-invoked third f is lexically excluded -> SUM must \
         NOT be reported; got {deps:?}"
    );
    assert!(
        !deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 1, 0)),
        "the rebound f's A2 must NOT be a precedent (never invoked); got {deps:?}"
    );
    // **No-under-dependency guard:** A1 -- read by the LIVE captured first `f`, invoked via
    // `g(2)` -- MUST stay a precedent. The fix removes only the over-report, never a real dep.
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "the live captured first f's A1 must stay a precedent; got {deps:?}"
    );
}

#[test]
fn arity_mismatch_call_does_not_mark_lambda_invoked() {
    // **Codex FU-NEXT re-audit Finding 3 (FIXED).** `f()` calls a 1-param lambda with 0
    // args; `invoke_lambda` returns `#VALUE!` BEFORE evaluating the body, so the body
    // never runs and SUM (+ A2) must NOT be reported. `discover` filters callees by exact
    // arity. (Closes the spurious-`#CIRC!`/volatility/stale-UDF faces for `f()`-style
    // bad-arity calls; SUM stands in for a UDF.)
    let deps = formula_deps_for("LET(f,LAMBDA(x,SUM(A2)),f())");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.functions_used.iter().any(|n| n.as_ref() == "SUM")),
        "a mismatched-arity call never invokes the body, so SUM must be dropped; got {deps:?}"
    );
}

#[test]
fn zero_arg_lambda_correctly_invoked_keeps_dep() {
    // **No-OVER-filter guard for the arity fix.** A 0-param lambda called with 0 args IS
    // invoked — the arity filter must allow it. `=LET(f,LAMBDA(A1),f())` reads A1 (the
    // lambda body is A1; `LAMBDA(A1)` has zero params), so editing A1 must recompute. A
    // stale here would mean the arity gate wrongly dropped a valid invocation.
    assert_edit_a1_recomputes("LET(f,LAMBDA(A1),f())", 10.0, 10.0, 20.0, 20.0)
}

#[test]
fn name_merge_capture_vs_rebind_is_lexically_resolved_no_circ() {
    // **FU-NEXT-3 (2026-06-23) -- the `#CIRC!` face, now CLOSED.** Same shape as
    // `name_merge_capture_vs_rebind_is_lexically_resolved`, but the rebound-but-never-invoked
    // third `f` reads the OWNING cell B1. PRE-FU-NEXT-3 the name-merge marked it invoked, the
    // walker walked its body, and B1 got a spurious self-edge -> `recompute_all` yielded
    // `#CIRC!`. Lexical resolution excludes the rebind (a distinct site, not in scope at `g`'s
    // definition), so there is no self-edge: `g(2)` calls the captured FIRST `f` -> A1 = 10.
    // (Flipped from `_reopens_circ_face_known_residual`, which asserted `#CIRC!`.)
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap(); // A1
        rt.set_formula(0, 0, 1, "LET(f,LAMBDA(x,A1),g,LAMBDA(z,f(z)),f,LAMBDA(x,B1),g(2))")
            .unwrap();
    }
    let rebuilt = CalcgraphSession::rebuild_from_workbook(&wb);
    let mut graph = rebuilt.session;
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.recompute_all();
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(10.0),
        "FU-NEXT-3: no spurious B1 self-edge -> g(2) calls the captured first f -> A1 = 10, \
         not #CIRC!"
    );
}

#[test]
fn wrong_arity_curry_does_not_leak_returned_closure() {
    // **Codex FU-NEXT re-audit #3 Finding 2 (FIXED).** The arity gate must also apply in
    // `closures_of` (currying returns), not just `discover`. `mk` takes 1 param, but
    // `bad,mk()` calls it with 0 args → `#VALUE!`, so `mk()` produces NO closure and
    // `bad(0)` never invokes the returned inner `LAMBDA(y,B1)`. Without the gate in
    // `closures_of`, the inner lambda leaked through the wrong-arity `mk()`, `bad(0)`
    // marked it invoked, and B1 (the owning cell) got a spurious self-edge. The shared
    // `callee_invoked_lambda` gate stops the leak, so B1 is not a self-precedent.
    let deps = formula_deps_for("LET(mk,LAMBDA(x,LAMBDA(y,B1)),good,mk(1),bad,mk(),bad(0))");
    assert!(
        deps.as_ref().map_or(true, |d| !d.cells.contains(&(0, 0, 1))),
        "a wrong-arity `mk()` must not leak the inner lambda's B1 self-edge through \
         `closures_of`; got {deps:?}"
    );
}

#[test]
fn wrong_arity_call_args_are_not_walked() {
    // **FU-NEXT-2 (2026-06-22) -- CLOSES Codex FU-NEXT re-audit #4 (was a documented
    // residual).** `=LET(f,LAMBDA(x,1),f(B1,0))` is a wrong-arity call (f takes 1 param,
    // called with 2 args) -> `invoke_lambda` returns `#VALUE!` BEFORE evaluating the args,
    // so B1 is never read. The walker's `CallLambda` arm now gates arg-walking on
    // `call_is_live`: this DEAD call's args are NOT walked, so B1 is no longer over-reported
    // as a (self-edge) precedent. The body `1` reads nothing, so the formula has NO deps
    // and `formula_deps_for` returns `None`. (Flipped from the old
    // `_over_walked_known_residual` pin, which asserted B1 WAS recorded.)
    let deps = formula_deps_for("LET(f,LAMBDA(x,1),f(B1,0))");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.cells.contains(&(0, 0, 1))),
        "FU-NEXT-2: the wrong-arity (dead) call's B1 arg must NOT be walked -- eval returns \
         #VALUE! before reading it; got {deps:?}"
    );
}

// =====================================================================
// FU3 (2026-06-21) — array-valued LET/LAMBDA spill (boundary 1 closed).
// A LET body / LAMBDA result that is an array now SPILLS at the cell
// boundary (production `WorkbookRuntime` path) instead of `#CALC!`.
// =====================================================================

/// Read the `n×1` column spill anchored at B1 (col 1) and assert it is `{1..n}`.
fn assert_b_column_seq(wb: &Workbook, n: u32) {
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(n, 1)),
        "expected a {n}×1 spill anchored at B1"
    );
    for i in 0..n {
        assert_eq!(
            wb.read(Address::new(0, i, 1)),
            Value::Number((i + 1) as f64),
            "spilled cell B{} must be {}",
            i + 1,
            i + 1
        );
    }
}

#[test]
fn fu3_let_body_array_fn_spills() {
    // =LET(x,5,SEQUENCE(x)) — body is a Unified array fn → spills 5×1 {1;2;3;4;5}.
    let (wb, _g, _r) = setup("LET(x,5,SEQUENCE(x))", 0.0);
    assert_b_column_seq(&wb, 5);
}

#[test]
fn fu3_lambda_invocation_array_result_spills() {
    // =LAMBDA(n,SEQUENCE(n))(3) — CallLambda whose body returns an array → spills 3×1.
    let (wb, _g, _r) = setup("LAMBDA(n,SEQUENCE(n))(3)", 0.0);
    assert_b_column_seq(&wb, 3);
}

#[test]
fn fu3_let_local_ref_to_array_spills() {
    // =LET(s,SEQUENCE(3),s) — s binds to an array (LocalBinding::Array, finally
    // constructed), the body LocalRef propagates it → spills 3×1.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),s)", 0.0);
    assert_b_column_seq(&wb, 3);
}

#[test]
fn fu3_let_curried_lambda_array_result_spills() {
    // =LET(f,LAMBDA(x,SEQUENCE(x)),f(3)) — f(3) returns an array → spills 3×1.
    let (wb, _g, _r) = setup("LET(f,LAMBDA(x,SEQUENCE(x)),f(3))", 0.0);
    assert_b_column_seq(&wb, 3);
}

#[test]
fn fu3_let_nested_array_propagation_spills() {
    // =LET(a,SEQUENCE(2),LET(b,a,b)) — the array propagates through the nested LET body.
    let (wb, _g, _r) = setup("LET(a,SEQUENCE(2),LET(b,a,b))", 0.0);
    assert_b_column_seq(&wb, 2);
}

#[test]
fn fu3_let_array_result_1x1_spills_single_cell() {
    // A 1×1 array result spills as a 1-cell spill (matches the =SEQUENCE(1) precedent —
    // intentional, NOT a scalar collapse).
    let (wb, _g, _r) = setup("LET(x,1,SEQUENCE(x))", 0.0);
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(1, 1)),
        "a 1×1 LET-body array registers a 1-cell spill, not a scalar write"
    );
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(1.0));
}

#[test]
fn fu3_let_spill_reshapes_on_precedent_edit() {
    // THE strongest FU3 test: =LET(s,SEQUENCE(A1),s). The spilling body reads A1 (inside
    // the LET binding) → A1 is a precedent (FU-NEXT walker). Editing A1 must re-dirty,
    // recompute, AND reshape the spill — proving (a) the dep walker tracks precedents
    // inside a spilling LET body (the zero-calcgraph-change claim) and (b) the spill
    // footprint redirties correctly.
    let (mut wb, mut graph, reg) = setup("LET(s,SEQUENCE(A1),s)", 3.0);
    assert_b_column_seq(&wb, 3); // A1=3 → B1:B3
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        rt.recompute_dirty().expect("graph attached");
    }
    assert_b_column_seq(&wb, 5); // A1=5 → reshaped to B1:B5
}

#[test]
fn fu3_let_callee_resolves_to_array_is_calc() {
    // Megaudit pin (Codex HIGH, operator-adjudicated): a callee that resolves to an ARRAY
    // surfaces #CALC!, NOT #VALUE!. =LET(s,SEQUENCE(3),s(1)): s is an array; invoke_lambda's
    // dedicated `Array` callee arm maps it to #CALC!, preserving the EXACT pre-FU3
    // scalar-context result (an array in any scalar position — incl. callee — is #CALC!).
    // The cardinal soundness rule (no scalar-context change) holds literally.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),s(1))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc),
        "calling an array-valued local must be #CALC! (array-in-scalar-position), not #VALUE!"
    );
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "no spill on the error"
    );
}

#[test]
fn fu3_array_arg_invoked_as_lambda_param_is_calc() {
    // Codex HIGH (2nd instance of the same class): an ARRAY passed as a lambda param and
    // then invoked — =LAMBDA(f,f(1))(SEQUENCE(3)) — also hits invoke_lambda's Array-callee
    // arm → #CALC! (preserving pre-FU3 scalar-context semantics).
    let (wb, _g, _r) = setup("LAMBDA(f,f(1))(SEQUENCE(3))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc),
        "invoking an array-valued lambda parameter must be #CALC!"
    );
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "no spill on the error"
    );
}

#[test]
fn fu4c_c2_let_transpose_over_array_local_spills() {
    // **FU4c-C2 (2026-06-22):** an array-local fed as a DATA arg to a Unified fn (TRANSPOSE)
    // now materializes as `FunctionArg::Array` at the cell boundary and the result SPILLS.
    // SEQUENCE(3) = 3x1 {1;2;3}; TRANSPOSE swaps shape -> 1x3 {1,2,3}. This is the FLIPPED
    // `fu3_let_array_local_as_unified_fn_arg_is_calc` deferred pin (it asserted #CALC!/no-spill
    // before C2 -- "the LocalRef arg materializes to #CALC! before TRANSPOSE sees it"). The
    // full FU4c-C2 production suite (FILTER/SORT/SORTBY/UNIQUE/degenerate/loud/cardinal-sin)
    // is in the dedicated section at the tail of this file.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),TRANSPOSE(s))", 0.0);
    assert_spill_block(&wb, 1, 3, &[1.0, 2.0, 3.0]);
}

#[test]
fn fu3_let_body_spill_blocked_is_spill_error() {
    // A LET body that would spill onto an occupied cell raises #SPILL! (the existing
    // spill-collision machinery applies to LET-body spills too).
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 2, 1, Value::Number(99.0)).unwrap(); // B3 occupied
        rt.set_formula(0, 0, 1, "LET(x,5,SEQUENCE(x))").unwrap(); // wants B1:B5
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Spill),
        "a LET-body spill blocked by an occupied target → #SPILL!"
    );
}

// --- FU3 LOUD boundaries (DEFERRED to FU4) — these stay #CALC!, no spill ----

#[test]
fn fu3_let_array_local_arithmetic_is_calc_in_production() {
    // Array arithmetic on a local stays #CALC! even on the production path (eval_binary has
    // no array broadcast — the engine-wide ceiling; folds into FU4).
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),s*2)", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc)
    );
    assert_eq!(wb.spill_anchor_at(0, 0, 1).copied(), None, "must NOT spill");
}

#[test]
fn fu4b_let_array_local_as_sum_arg_computes_in_production() {
    // **FU4b (2026-06-21) — FLIPPED from `fu3_let_array_local_as_sum_arg_is_calc_in_production`
    // (was #CALC!).** The scalar-aggregate array-as-arg relaxation (the substrate that makes
    // `SUM(row)` work inside BYROW) ALSO makes a generic array local flow into a reducer:
    // =LET(s,SEQUENCE(3),SUM(s)) now computes 1+2+3 = 6 (Excel-correct). SUM returns a SCALAR,
    // so there is no spill. The arithmetic (`s*2`) and Unified-tier (`TRANSPOSE(s)`) array-local
    // cases STAY #CALC! (deferred) — see the two pins above.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),SUM(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(6.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "SUM returns a scalar — no spill"
    );
}

#[test]
fn fu3_let_range_bound_local_is_rejected_at_bind() {
    // A LET value that is a bare range (=LET(s,A1:C1,s)) binds in BindContext::Scalar, which
    // rejects a bare range literal → the whole LET fails to bind (loud, No-Fallbacks).
    // Range-bound array locals fold into FU4 (need a range-capable bind context + array-as-arg).
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let result = rt.set_formula(0, 0, 1, "LET(s,A1:C1,s)");
    assert!(
        result.is_err(),
        "a bare-range LET value must be rejected at bind time (BindContext::Scalar); got {result:?}"
    );
}

// =============================================================================
// FU4 (2026-06-21) — Tier-1 higher-order helpers (MAP / MAKEARRAY / REDUCE /
// SCAN). Production path: spill + dependency tracking. The PRIMARY surface is
// the cardinal-sin test — a cell ref inside a helper's lambda body must be a
// precedent (the dep walker marks the helper's lambda arg invoked).
// =============================================================================

/// Assert the spill anchored at B1 (col 1) is `rows×cols` with `expected`
/// row-major values.
fn assert_spill_block(wb: &Workbook, rows: u32, cols: u32, expected: &[f64]) {
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(rows, cols)),
        "expected a {rows}×{cols} spill anchored at B1"
    );
    assert_eq!(
        expected.len(),
        (rows * cols) as usize,
        "test fixture: expected.len() must equal rows*cols"
    );
    for r in 0..rows {
        for c in 0..cols {
            let want = expected[(r * cols + c) as usize];
            assert_eq!(
                wb.read(Address::new(0, r, 1 + c)),
                Value::Number(want),
                "spilled cell at (row {r}, col {c}) must be {want}"
            );
        }
    }
}

// --- MAP --------------------------------------------------------------------

#[test]
fn fu4_map_single_array_spills() {
    // =MAP(SEQUENCE(3),LAMBDA(x,x*x)) — apply x*x to {1;2;3} → {1;4;9} (3×1).
    let (wb, _g, _r) = setup("MAP(SEQUENCE(3),LAMBDA(x,x*x))", 0.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 4.0, 9.0]);
}

#[test]
fn fu4_map_two_arrays_spills() {
    // =MAP({1,2,3},{10,20,30},LAMBDA(a,b,a+b)) — element-wise across two arrays
    // → {11,22,33} (1×3). Lambda arity (2) == array count (2).
    let (wb, _g, _r) = setup("MAP({1,2,3},{10,20,30},LAMBDA(a,b,a+b))", 0.0);
    assert_spill_block(&wb, 1, 3, &[11.0, 22.0, 33.0]);
}

#[test]
fn fu4_map_2d_spills() {
    // =MAP({1,2;3,4},LAMBDA(x,x*10)) — preserves the 2×2 shape → {10,20;30,40}.
    let (wb, _g, _r) = setup("MAP({1,2;3,4},LAMBDA(x,x*10))", 0.0);
    assert_spill_block(&wb, 2, 2, &[10.0, 20.0, 30.0, 40.0]);
}

#[test]
fn fu4_map_constant_lambda_spills() {
    // A lambda ignoring its param still maps element-wise → {7;7;7}. The input
    // range still drives the shape (see fu4_map_array_arg_reshapes...).
    let (wb, _g, _r) = setup("MAP(SEQUENCE(3),LAMBDA(x,7))", 0.0);
    assert_spill_block(&wb, 3, 1, &[7.0, 7.0, 7.0]);
}

#[test]
fn fu4_map_body_cell_ref_is_precedent_and_recomputes() {
    // **THE cardinal-sin test.** A cell ref INSIDE the lambda body
    // (=MAP(SEQUENCE(3),LAMBDA(x,x+$A$1))) must register $A$1 as a precedent, or
    // editing A1 leaves the MAP STALE. This passes ONLY if the dep walker marks
    // the helper's lambda arg invoked (FU4 `discover` change) so the body is walked.
    let (mut wb, mut graph, reg) = setup("MAP(SEQUENCE(3),LAMBDA(x,x+$A$1))", 10.0);
    assert_spill_block(&wb, 3, 1, &[11.0, 12.0, 13.0]); // A1=10
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the MAP (attempted == 0 means the dep inside the \
         lambda body was never registered — the cardinal sin)"
    );
    assert_spill_block(&wb, 3, 1, &[21.0, 22.0, 23.0]); // A1=20
}

#[test]
fn fu4_map_body_cell_ref_in_deps() {
    // Direct dep-extraction proof for the same shape: $A$1 (inside the body) is in
    // `deps.cells`.
    let deps = formula_deps_for("MAP(SEQUENCE(3),LAMBDA(x,x+$A$1))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the MAP lambda body must be a precedent; got {:?}",
        deps.cells
    );
}

#[test]
fn fu4_map_array_arg_reshapes_on_precedent_edit() {
    // The ARRAY arg's precedents drive the shape: =MAP(SEQUENCE($A$1),LAMBDA(x,x)).
    // A1=3 → {1;2;3}; edit A1=5 → reshape to {1;2;3;4;5}.
    let (mut wb, mut graph, reg) = setup("MAP(SEQUENCE($A$1),LAMBDA(x,x))", 3.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 2.0, 3.0]);
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        rt.recompute_dirty().expect("graph attached");
    }
    assert_spill_block(&wb, 5, 1, &[1.0, 2.0, 3.0, 4.0, 5.0]);
}

#[test]
fn fu4_map_let_bound_lambda_spills() {
    // A LET-bound lambda passed to MAP resolves via `closures_of`(LocalRef) at the
    // walker AND `eval_binding`(LocalRef)→Callable at eval. {1;2;3} → {2;4;6}.
    let (wb, _g, _r) = setup("LET(f,LAMBDA(x,x*2),MAP(SEQUENCE(3),f))", 0.0);
    assert_spill_block(&wb, 3, 1, &[2.0, 4.0, 6.0]);
}

#[test]
fn fu4_map_let_bound_lambda_body_ref_is_precedent() {
    // The cardinal-sin guard must also fire through a LET-bound lambda: the body's
    // $A$1 must be a precedent even though the lambda reaches MAP as a LocalRef.
    let (mut wb, mut graph, reg) =
        setup("LET(f,LAMBDA(x,x+$A$1),MAP(SEQUENCE(3),f))", 10.0);
    assert_spill_block(&wb, 3, 1, &[11.0, 12.0, 13.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(attempted >= 1, "A1 inside a LET-bound MAP lambda must be a precedent");
    assert_spill_block(&wb, 3, 1, &[21.0, 22.0, 23.0]);
}

#[test]
fn fu4_map_volatile_body_is_volatile() {
    // A volatile call inside the (invoked) lambda body marks the formula volatile —
    // the body IS walked (contrast a DEAD lambda, which is not).
    let deps = formula_deps_for("MAP(SEQUENCE(3),LAMBDA(x,x+RAND()))").expect("has deps");
    assert!(
        deps.is_volatile,
        "a volatile RAND() inside the MAP lambda body must mark the formula volatile"
    );
}

#[test]
fn fu4_map_spill_blocked_is_spill_error() {
    // A MAP spill blocked by an occupied target cell → #SPILL! (existing collision
    // machinery; same as a direct SEQUENCE spill).
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 2, 1, Value::Number(99.0)).unwrap(); // B3 occupied
        rt.set_formula(0, 0, 1, "MAP(SEQUENCE(3),LAMBDA(x,x))").unwrap(); // wants B1:B3
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Spill),
        "a MAP spill blocked by an occupied target → #SPILL!"
    );
}

#[test]
fn fu4_map_error_scalar_source_flows_into_lambda() {
    // **Megaudit (Codex MEDIUM):** a single ERROR-VALUED scalar array source must
    // become a 1×1 array whose element FLOWS INTO the lambda (so IFERROR can handle
    // it) — NOT short-circuit before the lambda runs. A1 = #DIV/0! (via =1/0);
    // MAP(A1, LAMBDA(x, IFERROR(x, 42))) → spills 1×1 {42}. This also makes the
    // scalar-cell source consistent with the 1×1-range source MAP(A1:A1, …).
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_formula(0, 0, 1, "MAP(A1,LAMBDA(x,IFERROR(x,42)))").unwrap();
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(42.0),
        "the error element must flow into the lambda; IFERROR recovers it to 42"
    );
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(1, 1)),
        "a single-cell error source maps to a 1×1 spill"
    );
}

// --- MAKEARRAY --------------------------------------------------------------

#[test]
fn fu4_makearray_2x3_spills() {
    // =MAKEARRAY(2,3,LAMBDA(r,c,r*10+c)) — 1-based (r,c) → {11,12,13;21,22,23}.
    let (wb, _g, _r) = setup("MAKEARRAY(2,3,LAMBDA(r,c,r*10+c))", 0.0);
    assert_spill_block(&wb, 2, 3, &[11.0, 12.0, 13.0, 21.0, 22.0, 23.0]);
}

#[test]
fn fu4_makearray_1x1_single_cell_spills() {
    // A 1×1 result is a single-cell spill (matches the FU3 =SEQUENCE(1) precedent).
    let (wb, _g, _r) = setup("MAKEARRAY(1,1,LAMBDA(r,c,r+c))", 0.0);
    assert_spill_block(&wb, 1, 1, &[2.0]); // r=1, c=1 → 2
}

#[test]
fn fu4_makearray_dims_from_cells_reshape() {
    // Dimension args are precedents: =MAKEARRAY($A$1,1,LAMBDA(r,c,r)). A1=3 →
    // {1;2;3}; edit A1=5 → reshape {1;2;3;4;5}.
    let (mut wb, mut graph, reg) = setup("MAKEARRAY($A$1,1,LAMBDA(r,c,r))", 3.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 2.0, 3.0]);
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        rt.recompute_dirty().expect("graph attached");
    }
    assert_spill_block(&wb, 5, 1, &[1.0, 2.0, 3.0, 4.0, 5.0]);
}

#[test]
fn fu4_makearray_fractional_dim_truncates() {
    // =MAKEARRAY(2.9,1,LAMBDA(r,c,r)) — truncates toward zero → 2 rows.
    let (wb, _g, _r) = setup("MAKEARRAY(2.9,1,LAMBDA(r,c,r))", 0.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 2.0]);
}

// --- REDUCE (scalar result; no spill) ---------------------------------------

#[test]
fn fu4_reduce_sum() {
    // =REDUCE(0,SEQUENCE(4),LAMBDA(a,v,a+v)) → 0+1+2+3+4 = 10 (scalar).
    let (wb, _g, _r) = setup("REDUCE(0,SEQUENCE(4),LAMBDA(a,v,a+v))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(10.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "REDUCE returns a scalar — no spill anchor"
    );
}

#[test]
fn fu4_reduce_product() {
    // =REDUCE(1,SEQUENCE(4),LAMBDA(a,v,a*v)) → 1*1*2*3*4 = 24.
    let (wb, _g, _r) = setup("REDUCE(1,SEQUENCE(4),LAMBDA(a,v,a*v))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(24.0));
}

#[test]
fn fu4_reduce_init_cell_is_precedent() {
    // The init arg is a precedent: =REDUCE($A$1,SEQUENCE(3),LAMBDA(a,v,a+v)).
    // A1=10 → 10+1+2+3 = 16; edit A1=20 → 26.
    let (mut wb, mut graph, reg) = setup("REDUCE($A$1,SEQUENCE(3),LAMBDA(a,v,a+v))", 10.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(16.0));
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(attempted >= 1, "REDUCE init cell A1 must be a precedent");
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(26.0));
}

// --- SCAN -------------------------------------------------------------------

#[test]
fn fu4_scan_running_sum_spills() {
    // =SCAN(0,SEQUENCE(5),LAMBDA(a,b,a+b)) → running sum {1;3;6;10;15} (5×1; the
    // initial value 0 is NOT a cell — result size == input size).
    let (wb, _g, _r) = setup("SCAN(0,SEQUENCE(5),LAMBDA(a,b,a+b))", 0.0);
    assert_spill_block(&wb, 5, 1, &[1.0, 3.0, 6.0, 10.0, 15.0]);
}

#[test]
fn fu4_scan_running_product_row() {
    // =SCAN(1,{1,2,3,4},LAMBDA(a,v,a*v)) → {1,2,6,24} (1×4, preserves row shape).
    let (wb, _g, _r) = setup("SCAN(1,{1,2,3,4},LAMBDA(a,v,a*v))", 0.0);
    assert_spill_block(&wb, 1, 4, &[1.0, 2.0, 6.0, 24.0]);
}

#[test]
fn fu4_scan_spill_blocked_is_spill_error() {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 2, 1, Value::Number(99.0)).unwrap(); // B3 occupied
        rt.set_formula(0, 0, 1, "SCAN(0,SEQUENCE(3),LAMBDA(a,v,a+v))")
            .unwrap(); // wants B1:B3
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Spill),
        "a SCAN spill blocked by an occupied target → #SPILL!"
    );
}

// =============================================================================
// FU4b (2026-06-21) — BYROW / BYCOL. The lambda receives a whole ROW / COLUMN
// ARRAY; the body consumes it via the scalar-aggregate array-as-arg relaxation
// (`SUM(row)`). Production path: spill + dependency tracking. The cardinal-sin
// surface (a cell ref inside the lambda body) is inherited from the FU4
// `discover` invoked-set mark (BYROW/BYCOL are `is_higher_order_helper` names).
// =============================================================================

// --- BYROW / BYCOL core shapes ----------------------------------------------

#[test]
fn fu4b_byrow_2d_spills_column() {
    // =BYROW({1,2;3,4},LAMBDA(r,SUM(r))) — SUM each row {1,2}=3, {3,4}=7 → 2×1 {3;7}.
    // The body's SUM(r) exercises the FU4b array-as-arg relaxation end-to-end.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,SUM(r)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[3.0, 7.0]);
}

#[test]
fn fu4b_bycol_2d_spills_row() {
    // =BYCOL({1,2;3,4},LAMBDA(c,SUM(c))) — SUM each col {1;3}=4, {2;4}=6 → 1×2 {4,6}.
    let (wb, _g, _r) = setup("BYCOL({1,2;3,4},LAMBDA(c,SUM(c)))", 0.0);
    assert_spill_block(&wb, 1, 2, &[4.0, 6.0]);
}

#[test]
fn fu4b_byrow_max_per_row() {
    // A different scalar-aggregate reducer over the row array → MAX per row.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,MAX(r)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[2.0, 4.0]);
}

#[test]
fn fu4b_bycol_count_per_col() {
    // COUNT over each column array → {2,2}.
    let (wb, _g, _r) = setup("BYCOL({1,2;3,4},LAMBDA(c,COUNT(c)))", 0.0);
    assert_spill_block(&wb, 1, 2, &[2.0, 2.0]);
}

#[test]
fn fu4b_byrow_single_row_is_1x1() {
    // A 1×3 source has ONE row → BYROW gives a single scalar → 1×1 {6}.
    let (wb, _g, _r) = setup("BYROW({1,2,3},LAMBDA(r,SUM(r)))", 0.0);
    assert_spill_block(&wb, 1, 1, &[6.0]);
}

#[test]
fn fu4b_bycol_single_row_is_1x3() {
    // A 1×3 source has 3 columns, each a 1×1 → BYCOL gives 1×3 {1,2,3}.
    let (wb, _g, _r) = setup("BYCOL({1,2,3},LAMBDA(c,SUM(c)))", 0.0);
    assert_spill_block(&wb, 1, 3, &[1.0, 2.0, 3.0]);
}

#[test]
fn fu4b_byrow_single_col_is_3x1() {
    // A 3×1 source has 3 rows, each a 1×1 → BYROW gives 3×1 {1,2,3}.
    let (wb, _g, _r) = setup("BYROW({1;2;3},LAMBDA(r,SUM(r)))", 0.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 2.0, 3.0]);
}

#[test]
fn fu4b_bycol_single_col_is_1x1() {
    // A 3×1 source has ONE column → BYCOL gives a single scalar → 1×1 {6}.
    let (wb, _g, _r) = setup("BYCOL({1;2;3},LAMBDA(c,SUM(c)))", 0.0);
    assert_spill_block(&wb, 1, 1, &[6.0]);
}

// --- BYROW / BYCOL dependency tracking (the cardinal-sin surface) -----------

#[test]
fn fu4b_byrow_body_cell_ref_is_precedent_and_recomputes() {
    // **THE cardinal-sin test for BYROW.** A cell ref INSIDE the lambda body
    // (=BYROW({1,2;3,4},LAMBDA(r,SUM(r)+$A$1))) must register $A$1 as a precedent,
    // or editing A1 leaves the BYROW STALE. Inherits the FU4 `discover` invoked-set
    // mark (BYROW is an `is_higher_order_helper` name). A1=10 → {3+10;7+10}={13;17}.
    let (mut wb, mut graph, reg) = setup("BYROW({1,2;3,4},LAMBDA(r,SUM(r)+$A$1))", 10.0);
    assert_spill_block(&wb, 2, 1, &[13.0, 17.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the BYROW (attempted == 0 means the dep inside the \
         lambda body was never registered — the cardinal sin)"
    );
    assert_spill_block(&wb, 2, 1, &[23.0, 27.0]); // A1=20
}

#[test]
fn fu4b_byrow_body_cell_ref_in_deps() {
    // Direct dep-extraction proof: $A$1 inside the BYROW lambda body is in deps.cells.
    let deps = formula_deps_for("BYROW({1,2;3,4},LAMBDA(r,SUM(r)+$A$1))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the BYROW lambda body must be a precedent; got {:?}",
        deps.cells
    );
}

#[test]
fn fu4b_byrow_data_arg_reshapes_on_precedent_edit() {
    // The ARRAY arg's precedents drive the shape: =BYROW(SEQUENCE($A$1),LAMBDA(r,SUM(r))).
    // SEQUENCE(n) is n×1; BYROW gives one SUM per (single-cell) row. A1=3 → {1;2;3};
    // edit A1=5 → reshape to {1;2;3;4;5}.
    let (mut wb, mut graph, reg) = setup("BYROW(SEQUENCE($A$1),LAMBDA(r,SUM(r)))", 3.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 2.0, 3.0]);
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        rt.recompute_dirty().expect("graph attached");
    }
    assert_spill_block(&wb, 5, 1, &[1.0, 2.0, 3.0, 4.0, 5.0]);
}

#[test]
fn fu4b_bycol_let_bound_lambda_spills() {
    // A LET-bound lambda passed to BYCOL resolves via `closures_of`(LocalRef) at the
    // walker AND `eval_binding`(LocalRef)→Callable at eval. {1,2;3,4} cols → {4,6}.
    let (wb, _g, _r) = setup("LET(f,LAMBDA(c,SUM(c)),BYCOL({1,2;3,4},f))", 0.0);
    assert_spill_block(&wb, 1, 2, &[4.0, 6.0]);
}

#[test]
fn fu4b_byrow_let_bound_lambda_body_ref_is_precedent() {
    // The cardinal-sin guard must also fire through a LET-bound BYROW lambda.
    let (mut wb, mut graph, reg) = setup("LET(f,LAMBDA(r,SUM(r)+$A$1),BYROW({1,2;3,4},f))", 10.0);
    assert_spill_block(&wb, 2, 1, &[13.0, 17.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "A1 inside a LET-bound BYROW lambda must be a precedent"
    );
    assert_spill_block(&wb, 2, 1, &[23.0, 27.0]);
}

#[test]
fn fu4b_byrow_volatile_body_is_volatile() {
    // A volatile call inside the (invoked) lambda body marks the formula volatile.
    let deps = formula_deps_for("BYROW({1,2;3,4},LAMBDA(r,SUM(r)+RAND()))").expect("has deps");
    assert!(
        deps.is_volatile,
        "a volatile RAND() inside the BYROW lambda body must mark the formula volatile"
    );
}

// --- BYROW / BYCOL error / boundary paths -----------------------------------

#[test]
fn fu4b_byrow_spill_blocked_is_spill_error() {
    // A BYROW spill (2×1 wanting B1:B2) blocked by an occupied target → #SPILL!.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(0, 1, 1, Value::Number(99.0)).unwrap(); // B2 occupied
        rt.set_formula(0, 0, 1, "BYROW({1,2;3,4},LAMBDA(r,SUM(r)))")
            .unwrap(); // wants B1:B2
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Spill),
        "a BYROW spill blocked by an occupied target → #SPILL!"
    );
}

#[test]
fn fu4b_byrow_runaway_body_is_num_not_stack_overflow() {
    // The per-row invocation MUST thread `depth` from `env.lambda_depth()` into
    // `invoke_closure_with_array` — a runaway self-application inside the body fires
    // the 64-deep guard as a loud `#NUM!`, NOT a native stack overflow (which would
    // SIGABRT the whole test process). The body ignores `r`.
    let (wb, _g, _r) = setup(
        "BYROW({1},LAMBDA(r,LET(g,LAMBDA(s,n,IF(n<0,0,1+s(s,n+1))),g(g,1))))",
        0.0,
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Num),
        "a runaway recursion in the BYROW body must be a clean #NUM!, not a crash"
    );
}

#[test]
fn fu4b_byrow_lambda_returns_row_is_calc_per_cell() {
    // **Megaudit (Codex / lane C):** a BYROW lambda that returns its ROW (an array,
    // not a scalar) makes each cell #CALC! via `helper_cell_value` — and the result
    // still SPILLS (2×1), one #CALC! per row, rather than collapsing the whole result.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,r))", 0.0);
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(2, 1)),
        "a per-row array result still spills 2×1 (each cell #CALC!)"
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc)
    );
    assert_eq!(
        wb.read(Address::new(0, 1, 1)),
        Value::Error(ErrorValue::Calc)
    );
}

#[test]
fn fu4b_byrow_error_element_in_row_flows_into_lambda() {
    // **Megaudit (lane C):** an ERROR element inside a row flows INTO the lambda —
    // SUM over a row containing #DIV/0! propagates the error for THAT row only; a
    // clean row computes normally. Data A1:B2 = {#DIV/0!,2; 3,4}; formula at D1.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_value(0, 0, 1, Value::Number(2.0)).unwrap(); // B1
        rt.set_value(0, 1, 0, Value::Number(3.0)).unwrap(); // A2
        rt.set_value(0, 1, 1, Value::Number(4.0)).unwrap(); // B2
        rt.set_formula(0, 0, 3, "BYROW(A1:B2,LAMBDA(r,SUM(r)))")
            .unwrap(); // D1, spills D1:D2
    }
    // Row 1 {#DIV/0!,2} → SUM propagates #DIV/0!; row 2 {3,4} → 7.
    assert_eq!(
        wb.read(Address::new(0, 0, 3)),
        Value::Error(ErrorValue::DivZero),
        "the error element flows into the lambda; SUM propagates it for that row"
    );
    assert_eq!(wb.read(Address::new(0, 1, 3)), Value::Number(7.0));
}

// --- PRODUCTION spill pins (a scalar-context #CALC! pin is vacuous: the boundary maps
// any BYROW array result to #CALC! regardless of the cells. These assert the SPILLED
// CELL values). The reducers (FU4c-A), lookups (FU4c-B), financial / pair-stats reducers
// (FU4c-C1), conditionals / text / multi-range / SUBTOTAL (FU4c-D), the Unified array tier
// TRANSPOSE/FILTER/SORT/SORTBY/UNIQUE (FU4c-C2), and the ReferenceAware tier
// ROWS/COLUMNS/ROW/COLUMN/ISFORMULA/FORMULATEXT (FU4c-C3) now compute (ROWS/COLUMNS) or loud-reject
// (ROW/COLUMN -> #VALUE!, ISFORMULA/FORMULATEXT -> #N/A) an array-local here; the ONLY still-DEFERRED
// consumer is CHOOSE (a passthrough, no data-array slot) -- its pin FAILS the day CHOOSE starts
// computing over an array-local, making any future relaxation deliberate. -----

#[test]
fn fu4c_byrow_median_over_row_local_computes_in_production() {
    // **FU4c (2026-06-22):** MEDIAN joined the `is_range_aware_reducer` gate, so an
    // array-local row now flattens into MEDIAN (via the RangeAware materialization arm)
    // and computes per row: row1 median(1,3,2)=2, row2 median(4,6,5)=5 → spills 2×1 {2;5}.
    // (This is the FU4b deferred-MEDIAN pin FLIPPED — the only value change in FU4c.)
    let (wb, _g, _r) = setup("BYROW({1,3,2;4,6,5},LAMBDA(r,MEDIAN(r)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[2.0, 5.0]);
}

#[test]
fn fu4c_byrow_index_over_row_local_computes_in_production() {
    // **FU4c-B (2026-06-22):** INDEX joined the `is_range_aware_lookup` gate, so an
    // array-local row now materializes as a shape-carrying `Range` and INDEX addresses
    // it: `INDEX(r,1)` over a 1×2 row (rows==1) returns the first element per row —
    // row1 {1,2}=>1, row2 {3,4}=>3 => spills 2x1 {1;3}. (This is the FU4b deferred-INDEX
    // pin FLIPPED — the only value change in FU4c-B, mirroring the FU4c-A MEDIAN flip.)
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,INDEX(r,1)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 3.0]);
}

// =============================================================================
// FU4c (2026-06-22): RangeAware STATISTICAL REDUCERS over an array-local.
// An array-valued LET/LAMBDA local now flattens into a gated reducer (MEDIAN /
// MODE / LARGE / SMALL / PERCENTILE / QUARTILE / RANK) via the RangeAware
// materialization arm. Production path: spill + dependency tracking. Mirrors the
// FU4b BYROW-SUM suite. The MEDIAN value-flip pin lives above (flipped from the
// FU4b deferred pin); these add the rest of the reducer family + the cardinal-sin
// + edge + deferred-stays-loud surface.
// =============================================================================

#[test]
fn fu4c_byrow_large_per_row() {
    // LARGE(row, 1) = the per-row maximum. row1 {1,3,2}→3, row2 {4,6,5}→6 → 2×1 {3;6}.
    let (wb, _g, _r) = setup("BYROW({1,3,2;4,6,5},LAMBDA(r,LARGE(r,1)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[3.0, 6.0]);
}

#[test]
fn fu4c_byrow_small_per_row() {
    // SMALL(row, 1) = the per-row minimum. row1 {1,3,2}→1, row2 {4,6,5}→4 → 2×1 {1;4}.
    let (wb, _g, _r) = setup("BYROW({1,3,2;4,6,5},LAMBDA(r,SMALL(r,1)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 4.0]);
}

#[test]
fn fu4c_bycol_median_per_col() {
    // MEDIAN over each COLUMN array. {1,4;3,6;2,5} is 3×2: col1 {1,3,2}→2, col2 {4,6,5}→5
    // → 1×2 {2,5}. Proves the array-local relaxation works for a BYCOL column-local too.
    let (wb, _g, _r) = setup("BYCOL({1,4;3,6;2,5},LAMBDA(c,MEDIAN(c)))", 0.0);
    assert_spill_block(&wb, 1, 2, &[2.0, 5.0]);
}

#[test]
fn fu4c_byrow_median_body_cell_ref_recomputes() {
    // **THE cardinal-sin test for a reducer body.** A cell ref inside the MEDIAN lambda
    // body must register $A$1 as a precedent (inherited from the FU4 `discover` invoked-set
    // mark — FU4c changes ONLY arg materialization, not dep extraction). A1=10 →
    // {median(1,3,2)+10; median(4,6,5)+10} = {12;15}; edit A1=20 → {22;25}.
    let (mut wb, mut graph, reg) = setup("BYROW({1,3,2;4,6,5},LAMBDA(r,MEDIAN(r)+$A$1))", 10.0);
    assert_spill_block(&wb, 2, 1, &[12.0, 15.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the BYROW-MEDIAN (attempted == 0 means the dep inside \
         the reducer lambda body was never registered — the cardinal sin)"
    );
    assert_spill_block(&wb, 2, 1, &[22.0, 25.0]);
}

#[test]
fn fu4c_byrow_median_body_cell_ref_in_deps() {
    // Direct dep-extraction proof: $A$1 inside the MEDIAN lambda body is in deps.cells.
    let deps = formula_deps_for("BYROW({1,3,2;4,6,5},LAMBDA(r,MEDIAN(r)+$A$1))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the BYROW-MEDIAN lambda body must be a precedent; got {:?}",
        deps.cells
    );
}

#[test]
fn fu4c_byrow_let_bound_median_lambda_spills() {
    // A LET-bound reducer lambda passed to BYROW resolves at both the walker and eval.
    let (wb, _g, _r) = setup("LET(f,LAMBDA(r,MEDIAN(r)),BYROW({1,3,2;4,6,5},f))", 0.0);
    assert_spill_block(&wb, 2, 1, &[2.0, 5.0]);
}

#[test]
fn fu4c_byrow_median_reshapes_on_precedent_edit() {
    // The ARRAY arg's precedents drive the shape. SEQUENCE(n) is n×1; BYROW gives one
    // MEDIAN per single-cell row (= that cell). A1=3 → {1;2;3}; edit A1=5 → {1;2;3;4;5}.
    let (mut wb, mut graph, reg) = setup("BYROW(SEQUENCE($A$1),LAMBDA(r,MEDIAN(r)))", 3.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 2.0, 3.0]);
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        rt.recompute_dirty().expect("graph attached");
    }
    assert_spill_block(&wb, 5, 1, &[1.0, 2.0, 3.0, 4.0, 5.0]);
}

#[test]
fn fu4c_byrow_median_single_row_is_1x1() {
    // A 1×3 source has ONE row → BYROW gives a single scalar → 1×1 {median(1,3,2)=2}.
    let (wb, _g, _r) = setup("BYROW({1,3,2},LAMBDA(r,MEDIAN(r)))", 0.0);
    assert_spill_block(&wb, 1, 1, &[2.0]);
}

#[test]
fn fu4c_bycol_median_single_col_is_1x1() {
    // A 3×1 source has ONE column → BYCOL gives a single scalar → 1×1 {median(1,3,2)=2}.
    let (wb, _g, _r) = setup("BYCOL({1;3;2},LAMBDA(c,MEDIAN(c)))", 0.0);
    assert_spill_block(&wb, 1, 1, &[2.0]);
}

#[test]
fn fu4c_byrow_median_1x1_source() {
    // A 1×1 source → 1×1 {median(5)=5}.
    let (wb, _g, _r) = setup("BYROW({5},LAMBDA(r,MEDIAN(r)))", 0.0);
    assert_spill_block(&wb, 1, 1, &[5.0]);
}

#[test]
fn fu4c_let_median_over_array_local_computes_in_production() {
    // The standalone scalar win: MEDIAN returns a SCALAR, so `LET(s,…,MEDIAN(s))` computes
    // a value at the cell boundary with NO spill (mirrors the FU4b SUM production pin).
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(5),MEDIAN(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "MEDIAN returns a scalar — no spill"
    );
}

#[test]
fn fu4c_byrow_median_error_element_in_row_flows_into_lambda() {
    // An ERROR element inside a row flows INTO MEDIAN, which propagates it for THAT row
    // only; a clean row computes. Data A1:B2 = {#DIV/0!,2; 3,4}; BYROW at D1 spills 2×1.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_value(0, 0, 1, Value::Number(2.0)).unwrap(); // B1
        rt.set_value(0, 1, 0, Value::Number(3.0)).unwrap(); // A2
        rt.set_value(0, 1, 1, Value::Number(4.0)).unwrap(); // B2
        rt.set_formula(0, 0, 3, "BYROW(A1:B2,LAMBDA(r,MEDIAN(r)))")
            .unwrap(); // D1, spills D1:D2
    }
    // Row 1 {#DIV/0!,2} → MEDIAN propagates #DIV/0!; row 2 {3,4} → median = 3.5.
    assert_eq!(
        wb.read(Address::new(0, 0, 3)),
        Value::Error(ErrorValue::DivZero),
        "the error element flows into the lambda; MEDIAN propagates it for that row"
    );
    assert_eq!(wb.read(Address::new(0, 1, 3)), Value::Number(3.5));
}

#[test]
fn fu4c_c1_byrow_choose_over_row_local_stays_loud_in_production() {
    // **Over-broad-gate guard (production), rebased at FU4c-D.** FU4c-D gated the conditionals
    // (BYROW SUMIF now COMPUTES — see the D production block), so the deferred-tier guard moves
    // to CHOOSE — the SOLE still-ungated RangeAware fn (a passthrough, no data-array slot). The
    // per-row array-local reaches it as `FnArg::Scalar(#CALC!)` (the unchanged `other =>` arm);
    // CHOOSE returns that sentinel VERBATIM → `#CALC!` per row (NOT `#VALUE!`). Catches a gate
    // that would relax the whole RangeAware tier (CHOOSE would then materialize the row as a
    // `Range` → its `FnArg::Range{..}=>Err(Value)` arm → `#VALUE!`). Still spills 2×1.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,CHOOSE(1,r)))", 0.0);
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(2, 1))
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc)
    );
    assert_eq!(
        wb.read(Address::new(0, 1, 1)),
        Value::Error(ErrorValue::Calc)
    );
}

// =============================================================================
// FU4c-B (2026-06-22): RangeAware LOOKUPS over an array-local, production path.
// An array-local now materializes as a shape-carrying Range and the lookups address
// it. Mirrors the FU4c-A reducer suite. The INDEX value-flip pin lives above (flipped
// from the FU4b deferred pin); these add the lookup-family spill / cardinal-sin / edge
// / error-flow surface. The CHOOSE pin above stays loud (the sole still-ungated RangeAware fn).
// =============================================================================

#[test]
fn fu4c_byrow_index_second_element_per_row() {
    // INDEX(r,2) over a 1x2 row (rows==1) -> the 2nd element per row. {2;4}.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,INDEX(r,2)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[2.0, 4.0]);
}

#[test]
fn fu4c_bycol_index_per_col() {
    // BYCOL gives each column as Nx1. INDEX(c,1) -> first element per col.
    // {1,4;3,6;2,5} cols: {1;3;2}->1, {4;6;5}->4 -> 1x2 {1,4}.
    let (wb, _g, _r) = setup("BYCOL({1,4;3,6;2,5},LAMBDA(c,INDEX(c,1)))", 0.0);
    assert_spill_block(&wb, 1, 2, &[1.0, 4.0]);
}

#[test]
fn fu4c_byrow_match_per_row() {
    // MATCH(5,r,0) over each row: {5,2}->pos 1, {5,4}->pos 1 -> {1;1}.
    let (wb, _g, _r) = setup("BYROW({5,2;5,4},LAMBDA(r,MATCH(5,r,0)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 1.0]);
}

#[test]
fn fu4c_byrow_index_body_cell_ref_recomputes() {
    // **THE cardinal-sin test for a lookup body.** A cell ref in the INDEX index slot
    // must register $A$1 as a precedent (inherited from FU4's invoked-set mark -- FU4c-B
    // changes ONLY arg materialization, not dep extraction). A1=1 -> INDEX(r,1) first
    // element per row {1;3}; edit A1=2 -> INDEX(r,2) {2;4}.
    let (mut wb, mut graph, reg) = setup("BYROW({1,2;3,4},LAMBDA(r,INDEX(r,$A$1)))", 1.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 3.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the BYROW-INDEX (attempted == 0 means the dep inside \
         the lookup lambda body was never registered -- the cardinal sin)"
    );
    assert_spill_block(&wb, 2, 1, &[2.0, 4.0]);
}

#[test]
fn fu4c_byrow_index_body_cell_ref_in_deps() {
    // Direct dep-extraction proof: $A$1 inside the INDEX lambda body is in deps.cells.
    let deps = formula_deps_for("BYROW({1,2;3,4},LAMBDA(r,INDEX(r,$A$1)))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the BYROW-INDEX lambda body must be a precedent; got {:?}",
        deps.cells
    );
}

#[test]
fn fu4c_byrow_let_bound_index_lambda_spills() {
    // A LET-bound lookup lambda passed to BYROW resolves at both the walker and eval.
    let (wb, _g, _r) = setup("LET(f,LAMBDA(r,INDEX(r,1)),BYROW({1,2;3,4},f))", 0.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 3.0]);
}

#[test]
fn fu4c_let_index_over_array_local_computes_in_production() {
    // Standalone scalar: INDEX returns a SCALAR, so `LET(s,...,INDEX(s,2))` computes a
    // value at the cell boundary with NO spill (mirrors the FU4c-A MEDIAN production pin).
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(5),INDEX(s,2))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(2.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "INDEX returns a scalar -- no spill"
    );
}

#[test]
fn fu4c_let_vlookup_over_2d_local_computes_in_production() {
    // A 2-D array-constant local binds row-major; VLOOKUP addresses it -> scalar 20.
    let (wb, _g, _r) = setup("LET(t,{1,10;2,20;3,30},VLOOKUP(2,t,2,FALSE))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(20.0));
}

#[test]
fn fu4c_byrow_match_error_element_in_row_is_skipped_not_propagated() {
    // **The lookup-vs-reducer error contrast.** `lookup_eq` treats an Error element as
    // non-equal (never matches), so MATCH SKIPS it -- distinct from MEDIAN/SUM which
    // PROPAGATE. Data A1:B2 = {#DIV/0!,2; 5,2}; MATCH(2,r,0) finds the 2 in BOTH rows.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_value(0, 0, 1, Value::Number(2.0)).unwrap(); // B1
        rt.set_value(0, 1, 0, Value::Number(5.0)).unwrap(); // A2
        rt.set_value(0, 1, 1, Value::Number(2.0)).unwrap(); // B2
        rt.set_formula(0, 0, 3, "BYROW(A1:B2,LAMBDA(r,MATCH(2,r,0)))")
            .unwrap(); // D1, spills D1:D2
    }
    // Row 1 {#DIV/0!,2}: MATCH skips the error, finds 2 at position 2.
    assert_eq!(
        wb.read(Address::new(0, 0, 3)),
        Value::Number(2.0),
        "MATCH skips the error element (lookup_eq does not propagate) and finds the clean 2"
    );
    // Row 2 {5,2}: 2 at position 2.
    assert_eq!(wb.read(Address::new(0, 1, 3)), Value::Number(2.0));
}

#[test]
fn fu4c_byrow_index_addresses_error_element_verbatim() {
    // INDEX addresses the cell VERBATIM, so an error element at the addressed position
    // flows out (the FU4c-A MEDIAN error-flow analog, but by addressing not reduction).
    // Data A1:B2 = {#DIV/0!,2; 3,4}; INDEX(r,1) returns the first element of each row.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_value(0, 0, 1, Value::Number(2.0)).unwrap(); // B1
        rt.set_value(0, 1, 0, Value::Number(3.0)).unwrap(); // A2
        rt.set_value(0, 1, 1, Value::Number(4.0)).unwrap(); // B2
        rt.set_formula(0, 0, 3, "BYROW(A1:B2,LAMBDA(r,INDEX(r,1)))")
            .unwrap(); // D1, spills D1:D2
    }
    // Row 1: INDEX(r,1) = first element = #DIV/0! (addressed verbatim).
    assert_eq!(
        wb.read(Address::new(0, 0, 3)),
        Value::Error(ErrorValue::DivZero),
        "INDEX addresses the error element verbatim"
    );
    // Row 2: INDEX(r,1) = 3.
    assert_eq!(wb.read(Address::new(0, 1, 3)), Value::Number(3.0));
}

// =============================================================================
// FU4c-C1 (2026-06-22): RangeAware FINANCIAL + PAIR-STATS reducers over an array-local,
// production path. Mirrors the FU4c-A/B suites. All values are EXACT-representable
// (pair-stats self-pairing identities; MAX_DRAWDOWN of a {100,50} row = -0.5) so the
// spill assertions use exact f64 equality — no approx helper needed in production.
// The CHOOSE pin above stays loud (#CALC! verbatim — the sole still-ungated RangeAware fn).
// =============================================================================

#[test]
fn fu4c_c1_byrow_correl_per_row_self_pair_computes() {
    // CORREL(r,r) over each 1x2 row = self-correlation = 1.0 (2 collinear points). {1;1}.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,CORREL(r,r)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 1.0]);
}

#[test]
fn fu4c_c1_byrow_sumxmy2_per_row_self_pair_is_zero() {
    // SUMXMY2(r,r) = Σ(x-x)^2 = 0 per row. {0;0}.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,SUMXMY2(r,r)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[0.0, 0.0]);
}

#[test]
fn fu4c_c1_bycol_sumxmy2_per_col_self_pair_is_zero() {
    // BYCOL gives each column as Nx1; SUMXMY2(c,c)=0 per col. 1x2 {0,0}.
    let (wb, _g, _r) = setup("BYCOL({1,4;3,6;2,5},LAMBDA(c,SUMXMY2(c,c)))", 0.0);
    assert_spill_block(&wb, 1, 2, &[0.0, 0.0]);
}

#[test]
fn fu4c_c1_byrow_max_drawdown_per_row_computes() {
    // MAX_DRAWDOWN over each {100,50} row = 50/100 - 1 = -0.5 (financial production spill).
    let (wb, _g, _r) = setup("BYROW({100,50;100,50},LAMBDA(r,MAX_DRAWDOWN(r)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[-0.5, -0.5]);
}

#[test]
fn fu4c_c1_byrow_correl_body_cell_ref_recomputes() {
    // **THE cardinal-sin test for a pair-stats body.** A cell ref alongside CORREL(r,r)
    // must register $A$1 as a precedent (inherited from FU4's invoked-set mark -- FU4c-C1
    // changes ONLY arg materialization, not dep extraction). A1=10 -> CORREL(r,r)+10 = 11
    // per row {11;11}; edit A1=20 -> {21;21}.
    let (mut wb, mut graph, reg) = setup("BYROW({1,2;3,4},LAMBDA(r,CORREL(r,r)+$A$1))", 10.0);
    assert_spill_block(&wb, 2, 1, &[11.0, 11.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the BYROW-CORREL (attempted == 0 means the dep inside \
         the pair-stats lambda body was never registered -- the cardinal sin)"
    );
    assert_spill_block(&wb, 2, 1, &[21.0, 21.0]);
}

#[test]
fn fu4c_c1_byrow_correl_body_cell_ref_in_deps() {
    // Direct dep-extraction proof: $A$1 inside the CORREL lambda body is in deps.cells.
    let deps = formula_deps_for("BYROW({1,2;3,4},LAMBDA(r,CORREL(r,r)+$A$1))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the BYROW-CORREL lambda body must be a precedent; got {:?}",
        deps.cells
    );
}

#[test]
fn fu4c_c1_byrow_let_bound_correl_lambda_spills() {
    // A LET-bound pair-stats lambda passed to BYROW resolves at both the walker and eval.
    let (wb, _g, _r) = setup("LET(f,LAMBDA(r,CORREL(r,r)),BYROW({1,2;3,4},f))", 0.0);
    assert_spill_block(&wb, 2, 1, &[1.0, 1.0]);
}

#[test]
fn fu4c_c1_let_correl_over_array_local_computes_in_production() {
    // Standalone scalar: CORREL returns a SCALAR, so `LET(s,...,CORREL(s,s))` computes a
    // value at the cell boundary with NO spill (mirrors the FU4c-A/B standalone pins).
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(5),CORREL(s,s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(1.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "CORREL returns a scalar -- no spill"
    );
}

#[test]
fn fu4c_c1_let_max_drawdown_over_array_local_computes_in_production() {
    // Standalone financial scalar: MAX_DRAWDOWN({100,50}) = -0.5, no spill.
    let (wb, _g, _r) = setup("LET(eq,{100,50},MAX_DRAWDOWN(eq))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(-0.5));
    assert_eq!(wb.spill_anchor_at(0, 0, 1).copied(), None);
}

#[test]
fn fu4c_c1_byrow_correl_error_element_in_row_propagates() {
    // **The pair-stats error contrast.** Unlike FU4c-B's MATCH (which SKIPS an error
    // element), CORREL's collector PROPAGATES it (returns Err on the first error) -- the
    // FU4c-A reducer semantics. Data A1:B2 = {#DIV/0!,2; 3,4}; CORREL(r,r) per row.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_value(0, 0, 1, Value::Number(2.0)).unwrap(); // B1
        rt.set_value(0, 1, 0, Value::Number(3.0)).unwrap(); // A2
        rt.set_value(0, 1, 1, Value::Number(4.0)).unwrap(); // B2
        rt.set_formula(0, 0, 3, "BYROW(A1:B2,LAMBDA(r,CORREL(r,r)))")
            .unwrap(); // D1, spills D1:D2
    }
    // Row 1 {#DIV/0!,2}: CORREL's collect_xy_pairs hits the error and propagates it.
    assert_eq!(
        wb.read(Address::new(0, 0, 3)),
        Value::Error(ErrorValue::DivZero),
        "CORREL propagates the error element (reducer semantics, not MATCH-skip)"
    );
    // Row 2 {3,4}: CORREL([3,4],[3,4]) = 1.0 (2 collinear points).
    assert_eq!(wb.read(Address::new(0, 1, 3)), Value::Number(1.0));
}

// =============================================================================
// FU4c-D (2026-06-22): RangeAware CONDITIONAL / TEXT / MULTI-RANGE / SUBTOTAL fns over an
// array-local, production path. Mirrors the FU4c-A/B/C1 suites. All values are EXACT (counts /
// sums) so the spill assertions use exact equality. Every value below recomputed by hand
// (NOT trusting the plan-agent table, which had per-row arithmetic slips). The CHOOSE pin
// above stays loud (#CALC! verbatim — the sole still-ungated RangeAware fn).
// =============================================================================

#[test]
fn fu4c_d_byrow_sumif_per_row_computes() {
    // SUMIF(r,">0") sums each row (all cells > 0). row1 {1,2}=3; row2 {3,4}=7. {3;7}.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,SUMIF(r,\">0\")))", 0.0);
    assert_spill_block(&wb, 2, 1, &[3.0, 7.0]);
}

#[test]
fn fu4c_d_byrow_countif_per_row_computes() {
    // COUNTIF(r,">0") counts each row (both cells > 0). {2;2}.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,COUNTIF(r,\">0\")))", 0.0);
    assert_spill_block(&wb, 2, 1, &[2.0, 2.0]);
}

#[test]
fn fu4c_d_byrow_sumproduct_per_row_computes() {
    // SUMPRODUCT(r,r) = sum of squares per row. row1 {1,2}=1+4=5; row2 {3,4}=9+16=25. {5;25}.
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,SUMPRODUCT(r,r)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[5.0, 25.0]);
}

#[test]
fn fu4c_d_bycol_sumif_per_col_computes() {
    // BYCOL gives each column as Nx1. matrix {1,4;3,6;2,5}: col0 {1,3,2}, col1 {4,6,5}.
    // SUMIF(c,">2"): col0 -> {3} -> 3; col1 -> {4,6,5} -> 15. 1x2 {3,15}.
    let (wb, _g, _r) = setup("BYCOL({1,4;3,6;2,5},LAMBDA(c,SUMIF(c,\">2\")))", 0.0);
    assert_spill_block(&wb, 1, 2, &[3.0, 15.0]);
}

#[test]
fn fu4c_d_byrow_sumif_body_cell_ref_recomputes() {
    // **THE cardinal-sin test for a conditional body.** A cell ref alongside SUMIF(r,">0")
    // must register $A$1 as a precedent (inherited from FU4's invoked-set mark -- FU4c-D
    // changes ONLY arg materialization, not dep extraction). A1=10 -> SUMIF(r,">0")+10 per row:
    // row1 3+10=13, row2 7+10=17 {13;17}; edit A1=20 -> {23;27}.
    let (mut wb, mut graph, reg) = setup("BYROW({1,2;3,4},LAMBDA(r,SUMIF(r,\">0\")+$A$1))", 10.0);
    assert_spill_block(&wb, 2, 1, &[13.0, 17.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the BYROW-SUMIF (attempted == 0 means the dep inside \
         the conditional lambda body was never registered -- the cardinal sin)"
    );
    assert_spill_block(&wb, 2, 1, &[23.0, 27.0]);
}

#[test]
fn fu4c_d_byrow_sumif_body_cell_ref_in_deps() {
    // Direct dep-extraction proof: $A$1 inside the SUMIF lambda body is in deps.cells.
    let deps =
        formula_deps_for("BYROW({1,2;3,4},LAMBDA(r,SUMIF(r,\">0\")+$A$1))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the BYROW-SUMIF lambda body must be a precedent; got {:?}",
        deps.cells
    );
}

#[test]
fn fu4c_d_let_sumif_over_array_local_computes_in_production() {
    // Standalone scalar: SUMIF returns a SCALAR, so `LET(s,...,SUMIF(s,">2"))` computes a value
    // at the cell boundary with NO spill (mirrors the FU4c-A/B/C1 standalone pins). {1..5}: 12.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(5),SUMIF(s,\">2\"))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(12.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "SUMIF returns a scalar -- no spill"
    );
}

#[test]
fn fu4c_d_let_subtotal_over_array_local_computes_in_production() {
    // Standalone SUBTOTAL scalar: SUBTOTAL(9,{1..5}) = sum = 15, no spill.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(5),SUBTOTAL(9,s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(15.0));
    assert_eq!(wb.spill_anchor_at(0, 0, 1).copied(), None);
}

#[test]
fn fu4c_d_byrow_sumproduct_error_element_propagates() {
    // **The propagate witness.** SUMPRODUCT's `to_num` propagates an error element
    // unconditionally (no criteria gate). Data A1:B2 = {#DIV/0!,2; 3,4}; SUMPRODUCT(r) per row.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_value(0, 0, 1, Value::Number(2.0)).unwrap(); // B1
        rt.set_value(0, 1, 0, Value::Number(3.0)).unwrap(); // A2
        rt.set_value(0, 1, 1, Value::Number(4.0)).unwrap(); // B2
        rt.set_formula(0, 0, 3, "BYROW(A1:B2,LAMBDA(r,SUMPRODUCT(r)))")
            .unwrap(); // D1, spills D1:D2
    }
    // Row 1 {#DIV/0!,2}: SUMPRODUCT hits the error and propagates it.
    assert_eq!(
        wb.read(Address::new(0, 0, 3)),
        Value::Error(ErrorValue::DivZero),
        "SUMPRODUCT propagates the error element"
    );
    // Row 2 {3,4}: SUMPRODUCT([3,4]) = 3+4 = 7.
    assert_eq!(wb.read(Address::new(0, 1, 3)), Value::Number(7.0));
}

#[test]
fn fu4c_d_byrow_countif_countblank_skip_error_element() {
    // **The skip contrast.** COUNTIF / COUNTBLANK do NOT propagate an error element (Excel
    // canon). Data A1:B2 = {#DIV/0!,5; 3,5}. COUNTIF(r,5) counts the 5s (error not matched);
    // COUNTBLANK(r) counts blanks (error is not blank).
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "1/0").unwrap(); // A1 = #DIV/0!
        rt.set_value(0, 0, 1, Value::Number(5.0)).unwrap(); // B1
        rt.set_value(0, 1, 0, Value::Number(3.0)).unwrap(); // A2
        rt.set_value(0, 1, 1, Value::Number(5.0)).unwrap(); // B2
        rt.set_formula(0, 0, 3, "BYROW(A1:B2,LAMBDA(r,COUNTIF(r,5)))")
            .unwrap(); // D1:D2
        rt.set_formula(0, 0, 5, "BYROW(A1:B2,LAMBDA(r,COUNTBLANK(r)))")
            .unwrap(); // F1:F2
    }
    // COUNTIF: row1 {#DIV/0!,5} -> 1 (the 5; error not matched); row2 {3,5} -> 1.
    assert_eq!(wb.read(Address::new(0, 0, 3)), Value::Number(1.0));
    assert_eq!(wb.read(Address::new(0, 1, 3)), Value::Number(1.0));
    // COUNTBLANK: no blanks in either row (an error is NOT blank) -> 0, 0.
    assert_eq!(wb.read(Address::new(0, 0, 5)), Value::Number(0.0));
    assert_eq!(wb.read(Address::new(0, 1, 5)), Value::Number(0.0));
}

// =============================================================================
// FU4c-C2 (2026-06-22): an array-local fed as a DATA arg to a Unified array fn
// (TRANSPOSE/FILTER/SORT/SORTBY/UNIQUE) materializes as FunctionArg::Array at the cell
// boundary and the result SPILLS -- byte-identical to the array-LITERAL path for a
// non-degenerate local. Ungated (no name predicate): every NON-data Unified slot
// loud-rejects an array (#VALUE!/#NUM! via coerce_arg_to_f64/_bool), so position-blind is
// sound; SEQUENCE/RANDARRAY have only scalar-dimension slots -> an array-local there is
// #VALUE!. The flipped TRANSPOSE pin lives above (fu4c_c2_let_transpose_over_array_local_spills);
// this block adds the rest. Every value recomputed by hand from array_returning_fns.rs
// (orientations: {a,b,c}=1xN row, {a;b;c}=Nx1 col, SEQUENCE(n)=nx1).
// =============================================================================

#[test]
fn fu4c_c2_let_transpose_2d_over_array_local_spills() {
    // {1,2;3,4} = 2x2 [[1,2],[3,4]]; TRANSPOSE out[j,i]=in[i,j] -> [1,3,2,4] (2x2).
    let (wb, _g, _r) = setup("LET(s,{1,2;3,4},TRANSPOSE(s))", 0.0);
    assert_spill_block(&wb, 2, 2, &[1.0, 3.0, 2.0, 4.0]);
}

#[test]
fn fu4c_c2_let_filter_over_array_locals_column() {
    // a={10;20;30} 3x1, b={1;0;1} 3x1 -> keep idx0,idx2 -> {10;30} (2x1). Both array-locals.
    let (wb, _g, _r) = setup("LET(a,{10;20;30},LET(b,{1;0;1},FILTER(a,b)))", 0.0);
    assert_spill_block(&wb, 2, 1, &[10.0, 30.0]);
}

#[test]
fn fu4c_c2_let_filter_array_local_with_literal_mask_row() {
    // a={10,20,30} 1x3 array-local, mask {1,0,1} 1x3 literal -> keep idx0,idx2 -> {10,30} (1x2).
    let (wb, _g, _r) = setup("LET(a,{10,20,30},FILTER(a,{1,0,1}))", 0.0);
    assert_spill_block(&wb, 1, 2, &[10.0, 30.0]);
}

#[test]
fn fu4c_c2_let_filter_all_false_no_if_empty_is_calc() {
    // all-FALSE mask, no if_empty -> degenerate (0,1) -> #CALC! at write_spill, no spill.
    let (wb, _g, _r) = setup("LET(a,{10;20;30},LET(b,{0;0;0},FILTER(a,b)))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc)
    );
    assert_eq!(wb.spill_anchor_at(0, 0, 1).copied(), None, "must NOT spill");
}

#[test]
fn fu4c_c2_let_filter_all_false_with_if_empty_computes() {
    // all-FALSE + if_empty=-1 -> 1x1 singleton {-1}. Read the anchor value directly
    // (a 1x1 result's spill-shape is not the focus); proves FILTER consumed the array-local.
    let (wb, _g, _r) = setup("LET(a,{10;20;30},LET(b,{0;0;0},FILTER(a,b,-1)))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(-1.0));
}

#[test]
fn fu4c_c2_filter_if_empty_array_local_matches_literal_first_cell() {
    // **5-lane megaudit fold (Codex + Opus + Sonnet-A all flagged the same caveat):** FILTER's
    // optional if_empty (arg2) is the ONE Unified slot that ACCEPTS an array rather than
    // loud-rejecting it -- it takes the array's FIRST cell (a pre-existing v1 simplification,
    // identical for an array LITERAL / RANGE). C2 makes an array-LOCAL reach the same slot; this
    // pin makes the convergence DELIBERATE: a multi-element if_empty array-local and the
    // equivalent literal both yield the first cell (-1), never a silent wrong result. (all-FALSE
    // mask routes to if_empty; e = {-1;-2} -> e.first() = -1.)
    let (local, _g1, _r1) = setup(
        "LET(a,{10;20;30},LET(b,{0;0;0},LET(e,{-1;-2},FILTER(a,b,e))))",
        0.0,
    );
    let (literal, _g2, _r2) = setup("LET(a,{10;20;30},LET(b,{0;0;0},FILTER(a,b,{-1;-2})))", 0.0);
    assert_eq!(local.read(Address::new(0, 0, 1)), Value::Number(-1.0));
    assert_eq!(
        literal.read(Address::new(0, 0, 1)),
        local.read(Address::new(0, 0, 1)),
        "an array-local if_empty must match the array-literal if_empty (both -> first cell)"
    );
}

#[test]
fn fu4c_c2_let_sort_over_array_local() {
    // {3;1;2} 3x1; SORT default sorts rows by key col asc -> {1;2;3} (3x1).
    let (wb, _g, _r) = setup("LET(s,{3;1;2},SORT(s))", 0.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 2.0, 3.0]);
}

#[test]
fn fu4c_c2_let_unique_over_array_local() {
    // {1;2;2;3;1} 5x1; UNIQUE dedups rows first-seen -> {1;2;3} (3x1).
    let (wb, _g, _r) = setup("LET(s,{1;2;2;3;1},UNIQUE(s))", 0.0);
    assert_spill_block(&wb, 3, 1, &[1.0, 2.0, 3.0]);
}

#[test]
fn fu4c_c2_let_sortby_over_array_locals() {
    // d={10;20;30}, k={2;3;1}; sort d's rows by k asc (order [2,0,1]) -> {30;10;20} (3x1).
    let (wb, _g, _r) = setup("LET(d,{10;20;30},LET(k,{2;3;1},SORTBY(d,k)))", 0.0);
    assert_spill_block(&wb, 3, 1, &[30.0, 10.0, 20.0]);
}

#[test]
fn fu4c_c2_degenerate_array_local_to_unified_is_calc_no_panic() {
    // **The soundness-lane catch.** A DEGENERATE array-local (an all-FALSE FILTER bound to a
    // local -- a state the binder forbids for an array LITERAL) fed to TRANSPOSE must NOT
    // panic: TRANSPOSE's own degeneracy guard early-returns an empty array -> #CALC! at
    // write_spill. (s = FILTER({1;2},{0;0}) = empty(0,1); TRANSPOSE(s) = empty(1,0) -> #CALC!.)
    let (wb, _g, _r) = setup("LET(s,FILTER({1;2},{0;0}),TRANSPOSE(s))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc)
    );
    assert_eq!(wb.spill_anchor_at(0, 0, 1).copied(), None, "must NOT spill");
}

#[test]
fn fu4c_c2_array_local_in_non_data_slot_is_loud() {
    // Position-blind soundness: an array-local in a NON-data Unified slot loud-rejects ->
    // #VALUE! (never a silent coercion). SEQUENCE's rows slot and SORT's sort_index slot both
    // route through coerce_arg_to_f64, which returns #VALUE! for a FunctionArg::Array.
    let (seq, _g1, _r1) = setup("LET(s,SEQUENCE(3),SEQUENCE(s))", 0.0);
    assert_eq!(
        seq.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(seq.spill_anchor_at(0, 0, 1).copied(), None);
    // A 2-element index array (not a 1x1) keeps the loud intent unambiguous.
    let (srt, _g2, _r2) = setup("LET(idx,{1,2},SORT({3;1;2},idx))", 0.0);
    assert_eq!(
        srt.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(srt.spill_anchor_at(0, 0, 1).copied(), None);
}

#[test]
fn fu4c_c2_transpose_over_array_local_body_cell_ref_recomputes() {
    // **The cardinal-sin test.** A cell ref inside the array-local's producer ($A$1 as
    // SEQUENCE's start) must register as a precedent so editing it recomputes the spill.
    // C2 changes ONLY arg materialization, not dep extraction (the dep walker is unchanged).
    // CONSTANT shape (rows fixed at 3, only start varies) -> no spill-reshape. A1=1 ->
    // SEQUENCE(3,1,1)={1;2;3} -> TRANSPOSE -> 1x3 {1,2,3}; edit A1=10 -> {10;11;12} -> {10,11,12}.
    let (mut wb, mut graph, reg) = setup("LET(s,SEQUENCE(3,1,$A$1),TRANSPOSE(s))", 1.0);
    assert_spill_block(&wb, 1, 3, &[1.0, 2.0, 3.0]);
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the TRANSPOSE-over-array-local spill (attempted == 0 means \
         the dep inside the Unified-fn LET binding was never registered -- the cardinal sin)"
    );
    assert_spill_block(&wb, 1, 3, &[10.0, 11.0, 12.0]);
}

#[test]
fn fu4c_c2_transpose_over_array_local_body_cell_ref_in_deps() {
    // Direct dep-extraction proof: $A$1 inside the SEQUENCE producer of the array-local is a
    // precedent of the spilling TRANSPOSE formula.
    let deps = formula_deps_for("LET(s,SEQUENCE(3,1,$A$1),TRANSPOSE(s))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the Unified-fn LET binding must be a precedent; got {:?}",
        deps.cells
    );
}

// =============================================================================
// FU4c-C3 (2026-06-22): an array-local fed as an arg to a ReferenceAware fn
// (ROW/COLUMN/ROWS/COLUMNS/ISFORMULA/FORMULATEXT) materializes as RefArg::Array at
// the SINGLE reference-aware materializer -- byte-identical to the array-LITERAL path.
// ROWS/COLUMNS compute the shape COUNT (the win); ROW/COLUMN loud-reject -> #VALUE!;
// ISFORMULA/FORMULATEXT loud-reject -> #N/A; ISREF (LazyShape, separate materializer)
// is unchanged FALSE. UNGATED (no name predicate). Unlike the C2 Unified tier these
// fns return SCALARS -> NO spill -> the cell holds a plain value (assert wb.read, not
// assert_spill_block). Values hand-recomputed from array_returning_fns.rs / reference_fns.rs
// (orientations: {a,b,c}=1xN row, {a;b;c}=Nx1 col, SEQUENCE(n)=nx1, SEQUENCE(r,c)=rxc).
// =============================================================================

#[test]
fn fu4c_c3_let_rows_over_seq_column_local() {
    // SEQUENCE(3) = 3x1; ROWS(s) = av.rows() = 3 (scalar, no spill).
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),ROWS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "ROWS returns a scalar -- must NOT spill"
    );
}

#[test]
fn fu4c_c3_let_columns_over_seq_column_local() {
    // SEQUENCE(3) = 3x1; COLUMNS(s) = av.cols() = 1.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),COLUMNS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(1.0));
}

#[test]
fn fu4c_c3_let_rows_over_seq_2d_local() {
    // SEQUENCE(2,3) = 2x3; ROWS(s) = 2.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(2,3),ROWS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(2.0));
}

#[test]
fn fu4c_c3_let_columns_over_seq_2d_local() {
    // SEQUENCE(2,3) = 2x3; COLUMNS(s) = 3.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(2,3),COLUMNS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
}

#[test]
fn fu4c_c3_let_rows_over_row_literal_local() {
    // {1,2,3} = 1x3 row; ROWS(s) = 1.
    let (wb, _g, _r) = setup("LET(s,{1,2,3},ROWS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(1.0));
}

#[test]
fn fu4c_c3_let_columns_over_row_literal_local() {
    // {1,2,3} = 1x3 row; COLUMNS(s) = 3.
    let (wb, _g, _r) = setup("LET(s,{1,2,3},COLUMNS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
}

#[test]
fn fu4c_c3_let_rows_over_col_literal_local() {
    // {1;2;3} = 3x1 col; ROWS(s) = 3.
    let (wb, _g, _r) = setup("LET(s,{1;2;3},ROWS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
}

#[test]
fn fu4c_c3_let_rows_over_2x2_literal_local() {
    // {1,2;3,4} = 2x2; ROWS(s) = 2.
    let (wb, _g, _r) = setup("LET(s,{1,2;3,4},ROWS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(2.0));
}

#[test]
fn fu4c_c3_let_columns_over_2x2_literal_local() {
    // {1,2;3,4} = 2x2; COLUMNS(s) = 2.
    let (wb, _g, _r) = setup("LET(s,{1,2;3,4},COLUMNS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(2.0));
}

#[test]
fn fu4c_c3_let_row_over_array_local_is_value() {
    // ROW does NOT accept an array (Microsoft canon, reference_fns.rs:78). The array-local
    // now REACHES ROW as RefArg::Array (was #CALC! propagation) -> #VALUE!.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),ROW(s))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c3_let_column_over_array_local_is_value() {
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),COLUMN(s))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c3_let_isformula_over_array_local_is_na() {
    // ISFORMULA rejects any non-reference -> #N/A (reference_fns.rs:266), WITHOUT querying
    // the workbook. The array-local reaches it as RefArg::Array -> #N/A.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),ISFORMULA(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Error(ErrorValue::NA));
}

#[test]
fn fu4c_c3_let_formulatext_over_array_local_is_na() {
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),FORMULATEXT(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Error(ErrorValue::NA));
}

#[test]
fn fu4c_c3_let_isref_over_array_local_is_false_unchanged() {
    // ISREF is the ONE ReferenceAware fn on ArgContract::LazyShape -- it uses the separate
    // `materialize_ref_arg_lazy` (LocalRef -> PlanKind::Literal -> FALSE), which the C3 arm
    // never touches. Identical before and after.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),ISREF(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Boolean(false));
}

#[test]
fn fu4c_c3_let_rows_over_degenerate_local_is_zero_no_panic() {
    // **Soundness-lane catch.** A DEGENERATE array-local (an all-FALSE FILTER bound to a
    // local -- a state the binder forbids for a literal): s = FILTER({1;2},{0;0}) = empty(0,1).
    // ROWS(s) = av.rows() = 0 (a plain field read -- no .first()/.at() -> no panic). The value
    // 0 is one no array LITERAL can produce.
    let (wb, _g, _r) = setup("LET(s,FILTER({1;2},{0;0}),ROWS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(0.0));
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        None,
        "ROWS of a degenerate local is a scalar 0 -- must NOT spill"
    );
}

#[test]
fn fu4c_c3_let_columns_over_degenerate_local_is_one_no_panic() {
    // s = FILTER({1;2},{0;0}) = empty(0,1); COLUMNS(s) = av.cols() = 1. No panic.
    let (wb, _g, _r) = setup("LET(s,FILTER({1;2},{0;0}),COLUMNS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(1.0));
}

#[test]
fn fu4c_c3_let_row_over_degenerate_local_is_value_no_panic() {
    // ROW matches RefArg::Array(_) shape-blind -> #VALUE!, never dereferences the array.
    let (wb, _g, _r) = setup("LET(s,FILTER({1;2},{0;0}),ROW(s))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c3_let_rows_over_degenerate_row_vec_local_is_one_no_panic() {
    // **Megaudit fold (Sonnet lane A coverage gap):** the OTHER degenerate orientation.
    // {1,2} is a ROW vector, so an all-FALSE FILTER -> empty(1,0) (the `is_row_vec` branch,
    // array_returning_fns.rs:423) -- a 0-COL array, vs the 0-ROW empty(0,1) above. ROWS = 1
    // (av.rows() on a 1x0 array, a field read -- panic-free).
    let (wb, _g, _r) = setup("LET(s,FILTER({1,2},{0,0}),ROWS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(1.0));
}

#[test]
fn fu4c_c3_let_columns_over_degenerate_row_vec_local_is_zero_no_panic() {
    // empty(1,0); COLUMNS = av.cols() = 0 (field read -- no panic on a 0-col array).
    let (wb, _g, _r) = setup("LET(s,FILTER({1,2},{0,0}),COLUMNS(s))", 0.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(0.0));
}

#[test]
fn fu4c_c3_let_rows_over_scalar_local_is_value() {
    // Non-array control: x = 5 is a LocalBinding::Value, so the new arm's `_` fallback
    // delegates to scalar eval -> RefArg::Scalar(5) -> ROWS rejects a scalar -> #VALUE!.
    // Proves the relaxation is strictly array-gated (unchanged from before C3).
    let (wb, _g, _r) = setup("LET(x,5,ROWS(x))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c3_let_row_over_scalar_local_is_value() {
    let (wb, _g, _r) = setup("LET(x,5,ROW(x))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn fu4c_c3_rows_over_shape_varying_array_local_recomputes() {
    // **The cardinal-sin test (PRIMARY -- value VARIES with A1).** C3 changes ONLY arg
    // materialization, not dep extraction (dep walker UNCHANGED). $A$1 is SEQUENCE's count,
    // so the array SHAPE (and thus ROWS) varies with A1: A1=3 -> SEQUENCE(3)=3x1 -> ROWS=3;
    // edit A1=5 -> SEQUENCE(5)=5x1 -> ROWS=5. A STALE 3 means $A$1 was never registered as a
    // precedent inside the ReferenceAware-fn LET binding.
    let (mut wb, mut graph, reg) = setup("LET(s,SEQUENCE($A$1),ROWS(s))", 3.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the shape-varying ROWS-over-array-local (attempted == 0 \
         means the dep inside the SEQUENCE producer was never registered -- the cardinal sin)"
    );
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(5.0));
}

#[test]
fn fu4c_c3_rows_over_shape_invariant_array_local_still_registers_dep() {
    // **Cardinal-sin (SECONDARY -- shape-INVARIANT).** SEQUENCE(3,1,$A$1) has CONSTANT shape
    // 3x1 regardless of $A$1 (only the start varies), so ROWS=3 for any A1. The point is NOT
    // a value change -- it is that $A$1 is STILL a registered precedent: editing it re-dirties
    // and recomputes (attempted >= 1), re-yielding 3 rather than going stale.
    let (mut wb, mut graph, reg) = setup("LET(s,SEQUENCE(3,1,$A$1),ROWS(s))", 1.0);
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "$A$1 must stay a precedent even though ROWS is shape-invariant"
    );
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(3.0));
}

#[test]
fn fu4c_c3_rows_over_array_local_seq_arg_cell_ref_in_deps() {
    // Direct dep-extraction proof: $A$1 inside the SEQUENCE producer of the array-local is a
    // precedent of the ROWS-over-array-local formula. ROWS routes through the AddressOnly
    // dep policy, but a LocalRef arg delegates to the no-op LocalRef arm -- the $A$1 dep comes
    // from the INDEPENDENT binding-value walk, so it is preserved.
    let deps = formula_deps_for("LET(s,SEQUENCE(3,1,$A$1),ROWS(s))").expect("has deps");
    assert!(
        deps.cells.iter().any(|&(s, r, c)| (s, r, c) == (0, 0, 0)),
        "$A$1 inside the ReferenceAware-fn LET binding must be a precedent; got {:?}",
        deps.cells
    );
}

// =============================================================================
// FU-NEXT-2 (2026-06-22): live-call arg gating. The walker's CallLambda arm walks
// a call's ARG subtrees IFF the call is LIVE (the callee resolves to a matching-arity
// lambda, so eval reaches the arg-eval loop). A provably-DEAD call (non-callable callee
// or arity mismatch) returns #VALUE!/#CALC! BEFORE evaluating its args (invoke_lambda,
// scalar.rs), so its args are never read -- the walker no longer over-reports them. The
// callee is ALWAYS walked. This can ONLY drop deps from provably-dead calls -- never an
// under-report (a live call's args are always walked; the `All` budget bail walks all).
// Closes Codex FU-NEXT re-audit #4 (the wrong-arity-args residual class). The flipped pin
// is `wrong_arity_call_args_are_not_walked` above.
// =============================================================================

#[test]
fn fu_next2_live_call_arg_cell_is_a_precedent() {
    // **The key new LIVE guard.** No prior pin has a CELL as the ARG of a live call.
    // `LET(f,LAMBDA(x,x),f(A1))` -- f is 1-param, called with 1 arg -> LIVE. The arg A1
    // is eagerly evaluated and returned (body `x` is a LocalRef, no grid dep of its own),
    // so A1 IS a precedent and MUST be walked. An under-report here would be the cardinal
    // sin (editing A1 would silently stale B1).
    let deps = formula_deps_for("LET(f,LAMBDA(x,x),f(A1))").expect("live call has the A1 arg dep");
    assert!(
        deps.cells.contains(&(0, 0, 0)),
        "a LIVE call's cell arg A1 must stay a precedent (the gate must not over-suppress); \
         got {deps:?}"
    );
}

#[test]
fn fu_next2_live_call_composite_arg_keeps_both_cells() {
    // A live call's arg is a whole subtree -- `LET(f,LAMBDA(x,x),f(A1+C1))` -> both A1 and
    // C1 (=(0,0,2)) are walked. Proves the arg subtree is walked in full when the call is live.
    let deps =
        formula_deps_for("LET(f,LAMBDA(x,x),f(A1+C1))").expect("live call has both arg deps");
    assert!(
        deps.cells.contains(&(0, 0, 0)) && deps.cells.contains(&(0, 0, 2)),
        "both cells in a LIVE call's composite arg must stay precedents; got {deps:?}"
    );
}

#[test]
fn fu_next2_live_curried_call_arg_is_a_precedent() {
    // The curry ARG of a live call. `LET(mk,LAMBDA(a,LAMBDA(b,b)),mk(A1)(2))` -- the inner
    // call `mk(A1)` is live (mk is 1-param, 1 arg), so its arg A1 is eagerly evaluated
    // (bound to `a`, even though `a` is unused in the returned body `b`) -> A1 IS read at
    // eval -> a precedent. The outer call `(...)(2)` is live too (returned lambda is
    // 1-param). Isolates ARG-walking through a curried live call.
    let deps =
        formula_deps_for("LET(mk,LAMBDA(a,LAMBDA(b,b)),mk(A1)(2))").expect("curried arg dep");
    assert!(
        deps.cells.contains(&(0, 0, 0)),
        "the curry ARG A1 of a LIVE inner call must stay a precedent; got {deps:?}"
    );
}

#[test]
fn fu_next2_live_call_arg_recomputes_end_to_end() {
    // Integration (positive cardinal-sin guard): `LET(f,LAMBDA(x,x),f(A1))` returns A1.
    // A1=10 -> B1=10; edit A1 -> 20 -> B1 MUST recompute to 20 (attempted >= 1). A STALE 10
    // means the live-call arg A1 was wrongly suppressed -- the cardinal sin.
    let (mut wb, mut graph, reg) = setup("LET(f,LAMBDA(x,x),f(A1))", 10.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(10.0),
        "initial B1 = A1 = 10"
    );
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert!(
        attempted >= 1,
        "editing A1 must recompute the LIVE-call-arg formula (attempted == 0 means the live \
         call's arg A1 was wrongly suppressed -- the cardinal sin)"
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Number(20.0),
        "B1 must recompute to 20"
    );
}

#[test]
fn fu_next2_too_few_args_arg_not_walked() {
    // DEAD via too-few args. `LET(f,LAMBDA(x,y,1),f(A1))` -- f takes 2 params, called with 1
    // arg -> arity mismatch -> invoke_lambda returns #VALUE! before reading A1. The body `1`
    // reads nothing, so A1 is the only candidate and it is suppressed -> NO deps -> None.
    let deps = formula_deps_for("LET(f,LAMBDA(x,y,1),f(A1))");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.cells.contains(&(0, 0, 0))),
        "a too-few-args (dead) call's A1 arg must NOT be walked; got {deps:?}"
    );
}

#[test]
fn fu_next2_non_callable_callee_arg_not_walked() {
    // DEAD via non-callable callee, AND exercises the empty-lambdas early return: `LET(f,5,
    // f(A1))` has ZERO Lambda nodes, so no callee can be Callable -> every CallLambda is
    // provably dead -> A1 (only present as the call's arg) is suppressed. The binding `f,5`
    // reads nothing. At eval `f` resolves to 5 -> invoke_lambda returns #VALUE! before A1.
    let deps = formula_deps_for("LET(f,5,f(A1))");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.cells.contains(&(0, 0, 0))),
        "a non-callable-callee (dead) call's A1 arg must NOT be walked; got {deps:?}"
    );
}

#[test]
fn fu_next2_nested_dead_call_suppresses_whole_arg_subtree() {
    // Per-call-node granularity: `LET(f,LAMBDA(x,1),g,LAMBDA(y,y),f(g(C1),0))` -- the OUTER
    // call f(g(C1),0) is dead (f is 1-param, called with 2 args), so its ENTIRE arg list is
    // suppressed at the WALKER, INCLUDING the would-be-live inner `g(C1)`. At eval
    // invoke_lambda(f) hits the arity gate and returns #VALUE! BEFORE evaluating g(C1), so C1
    // (=(0,0,2)) is never read -> not a precedent. Proves the gate suppresses the dead call's
    // ARG-WALK. (Since FU-NEXT-4, `discover` also no longer DESCENDS the dead call's args, so `g`
    // is not even marked invoked and the walker never walks g's body; the variant where g's body
    // reads a CELL is closed too -- see `fu_next4_invoked_lambda_in_dead_call_arg_is_dropped`.)
    let deps = formula_deps_for("LET(f,LAMBDA(x,1),g,LAMBDA(y,y),f(g(C1),0))");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.cells.contains(&(0, 0, 2))),
        "the whole arg subtree of a DEAD outer call (incl. a nested would-be-live call) must \
         NOT be walked; got {deps:?}"
    );
}

#[test]
fn fu_next2_dead_call_arg_not_a_precedent_end_to_end() {
    // Integration (cardinal-sin / over-report removal): `LET(f,LAMBDA(x,1),f(A1,0))` is a
    // wrong-arity call -> B1 = #VALUE!. A1 is NOT a precedent, so editing A1 recomputes
    // NOTHING (attempted == 0). Pre-fix the over-walked A1 would have wrongly re-dirtied B1.
    let (mut wb, mut graph, reg) = setup("LET(f,LAMBDA(x,1),f(A1,0))", 10.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value),
        "wrong-arity call -> B1 = #VALUE!"
    );
    let attempted = {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(0, 0, 0, Value::Number(20.0)).unwrap();
        rt.recompute_dirty().expect("graph attached").attempted
    };
    assert_eq!(
        attempted, 0,
        "the dead call's suppressed A1 arg is NOT a precedent, so editing A1 recomputes \
         nothing; attempted == {attempted} means A1 was wrongly over-walked"
    );
}

#[test]
fn fu_next4_invoked_lambda_in_dead_call_arg_is_dropped() {
    // **FU-NEXT-4 (2026-06-23) -- CLOSES the last dep-walker over-report** (was a documented
    // residual; flipped + renamed from
    // `fu_next2_invoked_lambda_in_dead_call_arg_overreports_body_known_residual`).
    // `f` takes 1 param but is called with 2 args, so `f(g(C1),0)` is a DEAD outer call. At eval
    // `invoke_lambda` returns #VALUE! BEFORE evaluating `g(C1)` (the arity check precedes the
    // arg-eval loop, scalar.rs), so `g` is never invoked and B1 (g's body) is never read -- the
    // correct dep set is {}. PRE-FU-NEXT-4 `discover` descended the dead call's args
    // UNCONDITIONALLY, marking `g` invoked -> the walker walked g's body -> over-reported B1.
    // Now the arg-descent is gated on call liveness (the dead outer call is skipped), so B1 is
    // NOT a precedent. (The companion `..._no_circ` pins the #CIRC! face; C5
    // `fu_next4_nested_invocation_in_live_call_keeps_dep` pins the inverse -- a LIVE
    // `f(g(C1),0)` MUST keep B1, proving this is an over-report fix, never an under-report.)
    let deps = formula_deps_for("LET(f,LAMBDA(x,1),g,LAMBDA(y,B1),f(g(C1),0))");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.cells.contains(&(0, 0, 1))),
        "FU-NEXT-4: the dead outer call's args are not descended -> g never invoked -> B1 must \
         NOT be a precedent; got {deps:?}"
    );
}

#[test]
fn fu_next2_wrong_arity_self_edge_no_circ() {
    // The #CIRC! face. `LET(f,LAMBDA(x,1),f(B1,0))` in B1 -- pre-fix B1 (the owning cell) was
    // over-walked as the call's arg, creating a spurious self-edge that yields #CIRC! on
    // recompute. FU-NEXT-2 suppresses the dead call's B1 arg -> no self-edge -> the real
    // wrong-arity result #VALUE! (NOT #CIRC!). Mirrors the name-merge `_reopens_circ_face`
    // pin for this class.
    let (wb, _g, _r) = setup("LET(f,LAMBDA(x,1),f(B1,0))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value),
        "no spurious self-edge -> the wrong-arity result #VALUE!, not #CIRC!"
    );
}

// =============================================================================
// FU-NEXT-3 (2026-06-23): lexical-scope resolver. The closure environment is now
// keyed by lexical BINDING SITE (not bare name), so a `LocalRef` resolves to the
// binding visible at its definition point (honoring LET binding order + shadowing
// + snapshot capture), exactly mirroring eval (scalar.rs eval_let_bindings /
// eval_binding Lambda capture / invoke_lambda). This closes residual 1 (name-merge:
// a captured-then-rebound lambda no longer leaks its rebind into the captor) WITHOUT
// ever resolving a name to FEWER lambdas than eval invokes (never an under-report;
// the budget/round-cap -> All floor still walks everything on any blowup). The two
// pre-flight pins below characterize the baseline: #6 passes on HEAD (closures_of(IF)
// already returns the empty set, matching eval); #9 FAILS on HEAD by design (the flat
// name-merge over-reports the forward-ref), and passes post-rewrite.
// =============================================================================

#[test]
fn fu_next3_if_bound_lambda_is_not_invoked() {
    // **#6 (eval-match guard -- passes pre- AND post-rewrite).** A LAMBDA wrapped in IF
    // and bound to a LET name is NOT callable at eval: `eval_binding`'s `_` arm
    // (scalar.rs:1058) scalarizes a non-(Lambda/LocalRef/CallLambda/Let) value to `#CALC!`,
    // so `f` resolves to `#CALC!` and `f(0)` errors BEFORE any body -- neither branch lambda
    // is invoked. So A1 and C1 (the branch bodies) are NOT precedents; only A2 (the IF
    // condition, walked normally) is. `closures_of(IF)` already returns the empty set
    // (Function is not callable-preserving), so the lexical rewrite must NOT add branch-union.
    let deps = formula_deps_for("LET(f,IF(A2>0,LAMBDA(x,A1),LAMBDA(x,C1)),f(0))");
    assert!(
        deps.as_ref()
            .map_or(true, |d| !d.cells.contains(&(0, 0, 0)) && !d.cells.contains(&(0, 0, 2))),
        "an IF-wrapped lambda is never invoked -> branch bodies A1/C1 are NOT precedents; got {deps:?}"
    );
    assert!(
        deps.as_ref()
            .map_or(false, |d| d.cells.contains(&(0, 1, 0))),
        "the IF condition A2 IS a precedent (walked normally); got {deps:?}"
    );
}

#[test]
fn fu_next3_forward_ref_is_not_a_dep() {
    // **#9 (forward-ref regression guard -- binder-enforced; passes pre- AND post-rewrite).**
    // `=LET(f,LAMBDA(n,g(n)),g,LAMBDA(m,B1),f(0))`: `g` is bound AFTER `f`, so it is NOT in
    // lexical scope at `f`'s definition. The binder ONLY emits `LocalRef` for an in-scope name
    // (`scalar.rs` LocalRef arm), so `g` inside `f`'s body is not a local reference at all --
    // the analysis never resolves it to the g-lambda -> g is never invoked -> B1 is not a
    // precedent (eval agrees: `g` is `#NAME?` inside `f`, via snapshot capture). The lexical
    // rewrite mirrors that same scope, so it must keep this correct. (Pre-flight confirmed this
    // PASSES on HEAD -- the name-merge over-report (residual 1) is the IN-scope rebind case,
    // a distinct mechanism from this out-of-scope forward reference.)
    let deps = formula_deps_for("LET(f,LAMBDA(n,g(n)),g,LAMBDA(m,B1),f(0))");
    assert!(
        deps.as_ref().map_or(true, |d| !d.cells.contains(&(0, 0, 1))),
        "forward-ref g is not in scope inside f -> never invoked -> B1 must NOT be a precedent; got {deps:?}"
    );
}

#[test]
fn fu_next3_capture_before_rebind_to_lambda_keeps_captured_drops_rebind() {
    // **#4 (capture-before-rebind, rebind is a LAMBDA -- the adversarial under-report probe).**
    // Like the flipped name_merge pin, but the rebound `f` is itself a lambda (reads B5),
    // never invoked. `g` captured the FIRST `f` (reads A1) at its definition, so `g(2)` ->
    // first `f` -> A1 MUST stay a precedent (an under-report here is the cardinal sin). The
    // rebound third `f` (B5) is a DISTINCT lexical site, never invoked -> B5 must be DROPPED.
    let deps = formula_deps_for("LET(f,LAMBDA(x,A1),g,LAMBDA(z,f(z)),f,LAMBDA(w,B5),g(2))")
        .expect("the captured first f's A1");
    assert!(
        deps.cells.contains(&(0, 0, 0)),
        "the captured first f's A1 MUST stay a precedent (no under-report); got {deps:?}"
    );
    assert!(
        !deps.cells.contains(&(0, 4, 1)),
        "the rebound never-invoked f's B5 must NOT be a precedent; got {deps:?}"
    );
}

#[test]
fn fu_next3_multi_call_site_param_union_keeps_all() {
    // **#5 (multi-call-site param union).** `apply=LAMBDA(h,h(0))` is invoked from two sites
    // with different lambdas: `apply(f)` (f reads A1) and `apply(g)` (g reads C1). The param
    // SITE `Param(apply,0)` unions {f,g} (context-insensitive across call sites -- preserved
    // from the 0-CFA), so `h(0)` invokes BOTH -> A1 and C1 are both precedents. Dropping
    // either would be an under-report.
    let deps = formula_deps_for(
        "LET(apply,LAMBDA(h,h(0)),f,LAMBDA(x,A1),g,LAMBDA(y,C1),SUM(apply(f),apply(g)))",
    )
    .expect("both A1 and C1 deps");
    assert!(
        deps.cells.contains(&(0, 0, 0)) && deps.cells.contains(&(0, 0, 2)),
        "both call-site closures must stay precedents (A1 and C1); got {deps:?}"
    );
}

#[test]
fn fu_next3_nested_let_shadow_both_live_keeps_both() {
    // **#7 (nested-LET shadow, both live).** The inner LET shadows `f` with LAMBDA(x,C1) and
    // invokes it (`f(0)` -> C1) inside the `r` binding; the outer body's `f(0)` resolves to
    // the OUTER `f` (LAMBDA(x,A1)) -> A1. Both are invoked at DISTINCT sites, so BOTH A1 and
    // C1 are precedents. A resolver that confused the two scopes would drop one (under-report).
    let deps = formula_deps_for("LET(f,LAMBDA(x,A1),r,LET(f,LAMBDA(x,C1),f(0)),SUM(f(0),r))")
        .expect("both A1 and C1 deps");
    assert!(
        deps.cells.contains(&(0, 0, 0)) && deps.cells.contains(&(0, 0, 2)),
        "both the outer (A1) and inner-shadowed (C1) f must stay precedents; got {deps:?}"
    );
}

#[test]
fn fu_next3_curried_param_union_keeps_both_closures() {
    // **#8b (the I2 probe -- monotone same-site param union via currying, no collapse).**
    // `apply=LAMBDA(h,LAMBDA(u,h(u)))` captures its param `h` in the returned inner lambda.
    // Invoked from TWO sites with different lambdas -- `apply(a1f)(0)` and `apply(c1f)(0)` --
    // so the param SITE `Param(apply,0)` accumulates the UNION {a1f, c1f} across fixpoint
    // rounds. The inner body `h(u)` resolves `h` to that one site -> BOTH a1f (reads A1) and
    // c1f (reads C1) are invoked. A site-keyed bound that grows monotonically (NOT
    // resolve-once-cached) keeps both; collapsing the param to a single closure would DROP
    // one -- an under-report. This is the seam invariant I2 protects.
    let deps = formula_deps_for(
        "LET(apply,LAMBDA(h,LAMBDA(u,h(u))),a1f,LAMBDA(x,A1),c1f,LAMBDA(y,C1),SUM(apply(a1f)(0),apply(c1f)(0)))",
    )
    .expect("both A1 and C1 deps");
    assert!(
        deps.cells.contains(&(0, 0, 0)) && deps.cells.contains(&(0, 0, 2)),
        "both members of the curried param union must stay precedents (A1 and C1); got {deps:?}"
    );
}

#[test]
fn fu_next3_backward_ref_is_a_dep() {
    // **#9b (the order-reversed companion to #9 -- the dep MUST stay).** Here `g` is bound
    // BEFORE `f`, so it IS in lexical scope at `f`'s definition; `f`'s body `g(n)` resolves to
    // `g` (reads C1) -> g IS invoked -> C1 IS a precedent. The inverse of #9: lexical
    // resolution must KEEP a backward reference (an under-report here is the cardinal sin).
    let deps = formula_deps_for("LET(g,LAMBDA(m,C1),f,LAMBDA(n,g(n)),f(0))")
        .expect("C1 dep via the backward-ref g");
    assert!(
        deps.cells.contains(&(0, 0, 2)),
        "backward-ref g IS in scope inside f -> invoked -> C1 must be a precedent; got {deps:?}"
    );
}

// =============================================================================
// FU-NEXT-4 (2026-06-23): gate discover's CallLambda arg-descent on call liveness.
// `discover` now descends a call's ARG subtrees ONLY when the call is LIVE (a
// matching-arity callee flows to it -- the SAME predicate the arity gate uses, so
// the analysis's arg-descent <=> the walker's `live_calls` arg-walk). A DEAD call's
// args are never evaluated at eval (`invoke_lambda` returns #VALUE! BEFORE the arg
// loop, scalar.rs:926), so a matching-arity inner call nested in a DEAD outer call
// is no longer spuriously marked invoked. This closes residual 3 (the LAST dep-walker
// over-report) WITHOUT dropping any LIVE call's nested invocation (never an under-
// report; the callee is always descended, the Param-binding path is untouched, and
// the budget/round-cap -> All floor still walks everything on any blowup). The pins
// below are the adversarial under-report matrix: C5/C6/C7 (live calls whose nested
// invocations MUST survive) pass pre- AND post-fix; the residual-3 pin above is
// FLIPPED (B1 dropped); O2 closes its #CIRC! face.
// =============================================================================

#[test]
fn fu_next4_nested_invocation_in_live_call_keeps_dep() {
    // **C5 (the cardinal-sin guard -- the inverse of the flipped residual-3 pin).**
    // SAME formula as the flipped `..._invoked_lambda_in_dead_call_arg_is_dropped` but `f`
    // is 2-param, so `f(g(C1),0)` is LIVE (matching arity). At eval a live call evaluates
    // ALL its args left-to-right (`invoke_lambda` arg loop, scalar.rs:933) EVEN when the
    // body ignores them, so `g(C1)` IS evaluated -> `g` invoked -> B1 read, and C1 (g's
    // arg) read. Both B1 and C1 MUST stay precedents: gating the arg-descent on liveness
    // must NOT drop a LIVE call's nested invocation. (Only `f`'s arity differs from the
    // dead case -- the minimal live/dead contrast.)
    let deps = formula_deps_for("LET(f,LAMBDA(a,b,1),g,LAMBDA(y,B1),f(g(C1),0))")
        .expect("B1 and C1 deps via the live call");
    assert!(
        deps.cells.contains(&(0, 0, 1)),
        "live call -> g(C1) invoked -> g's body B1 MUST stay a precedent (no under-report); got {deps:?}"
    );
    assert!(
        deps.cells.contains(&(0, 0, 2)),
        "live call -> its arg g(C1) is evaluated -> C1 MUST stay a precedent; got {deps:?}"
    );
}

#[test]
fn fu_next4_lambda_as_param_to_live_call_keeps_dep() {
    // **C6 (lambda passed as a param to a LIVE call, invoked in the callee body).**
    // `f(g)` is live (f 1-param), and f's body `h(1)` invokes the param `h`=`g` (bound via
    // `Param(f,0)` from the live call's arg flow -- a path the arg-descent gate does NOT
    // touch). So `g`'s body A1 IS read. Editing A1 MUST recompute B1 -- a STALE value means
    // the gate starved the Param-binding path (the cardinal sin). End-to-end.
    assert_edit_a1_recomputes(
        "LET(g,LAMBDA(y,A1),f,LAMBDA(h,h(1)),f(g))",
        10.0,
        10.0,
        20.0,
        20.0,
    );
}

#[test]
fn fu_next4_param_lambda_bound_after_consumer_keeps_dep() {
    // **C7 (the param-lambda is bound AFTER its consumer -- ordering torture).**
    // `p(r)` is live (p 1-param); p's body `q(0)` invokes the param `q`=`r`, and `r`
    // (reads A1) is bound AFTER `p`. The param flow (`Param(p,0)` <- {r}) must still reach
    // p's body across the fixpoint regardless of binding order, so A1 is a precedent.
    // Proves gating the arg-descent does not break the (separate, ungated) Param-binding
    // path even when the closure flows in a later round. (Distinct from C6: r bound after p.)
    let deps = formula_deps_for("LET(p,LAMBDA(q,q(0)),r,LAMBDA(z,A1),p(r))")
        .expect("A1 dep via the param-bound r");
    assert!(
        deps.cells.contains(&(0, 0, 0)),
        "p(r) live -> q(0) invokes r -> A1 MUST be a precedent (no under-report); got {deps:?}"
    );
}

#[test]
fn fu_next4_invoked_lambda_in_dead_call_arg_is_dropped_no_circ() {
    // **O2 (the #CIRC! face of residual 3, now CLOSED).** `=LET(f,LAMBDA(x,1),g,LAMBDA(y,B1),
    // f(g(C1),0))` in B1: `g`'s body reads the OWNING cell B1. PRE-FU-NEXT-4 `discover`
    // descended the DEAD outer call's args, marking `g` invoked -> the walker walked g's body
    // -> a spurious B1->B1 self-edge -> `recompute_all` yielded #CIRC!. Now the dead call's
    // args are not descended -> g not invoked -> no self-edge -> the real wrong-arity result
    // #VALUE! (f is 1-param, called with 2 args). Mirrors `fu_next2_wrong_arity_self_edge_no_circ`.
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 1, "LET(f,LAMBDA(x,1),g,LAMBDA(y,B1),f(g(C1),0))")
            .unwrap();
    }
    let rebuilt = CalcgraphSession::rebuild_from_workbook(&wb);
    let mut graph = rebuilt.session;
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.recompute_all();
    }
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value),
        "no spurious B1 self-edge -> recompute_all yields the wrong-arity #VALUE!, not #CIRC!"
    );
}
