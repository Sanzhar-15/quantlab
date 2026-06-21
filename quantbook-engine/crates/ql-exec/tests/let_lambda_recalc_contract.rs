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
fn name_merge_capture_vs_rebind_over_preserve_known_residual() {
    // **Codex FU-NEXT HIGH-2 — DOCUMENTED RESIDUAL (operator-approved ship-with-residual
    // class).** `g` captures the FIRST `f` (reads A1); the THIRD `f` (names SUM, reads A2)
    // is rebound AFTER `g` is defined and is NEVER invoked — only `g(2)` runs, and a
    // closure captures the env at CREATION (`eval_binding`'s Lambda arm), so `g`'s `f(z)`
    // calls the first `f`, not the third. At eval SUM never dispatches. But the context-
    // INSENSITIVE `bound` map merges both `f` bindings by name, so resolving `f(z)` inside
    // `g`'s body yields BOTH lambdas and the third's SUM is over-reported into
    // `functions_used`.
    //
    // This is an OVER-report that can re-open ALL THREE faces for this shape (see the sibling
    // `..._reopens_circ_face` test for the `#CIRC!` face); it is NEVER an under-report. It
    // is a STRICT NARROWING of the pre-FU-NEXT behavior (which walked every body). The full
    // fix is a context-SENSITIVE analysis carrying each lambda's captured abstract
    // environment. This test PINS the current behavior so that fix is a deliberate flip.
    // (SUM stands in for a UDF name.)
    let deps =
        formula_deps_for("LET(f,LAMBDA(x,A1),g,LAMBDA(z,f(z)),f,LAMBDA(x,SUM(A2)),g(2))")
            .expect("has deps");
    assert!(
        deps.functions_used.iter().any(|n| n.as_ref() == "SUM"),
        "RESIDUAL: name-merge marks the rebound-but-never-invoked lambda invoked, \
         over-reporting SUM (a context-sensitive capture analysis closes this); got {deps:?}"
    );
    // **No-under-dependency guard:** A1 — read by the LIVE captured first `f`, invoked via
    // `g(2)` — MUST be a precedent. The residual is purely an over-report; it never drops
    // a real dependency.
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
fn name_merge_capture_vs_rebind_reopens_circ_face_known_residual() {
    // **Codex FU-NEXT HIGH-2 — the `#CIRC!` face of the name-merge residual (PINNED).**
    // Same shape as `name_merge_capture_vs_rebind_over_preserve_known_residual`, but the
    // rebound-but-never-invoked third `f` reads the OWNING cell B1. The context-insensitive
    // name-merge marks it invoked, the walker walks its body, and B1 gets a spurious
    // self-edge → `recompute_all` yields `#CIRC!` instead of the real value (`g(2)` calls
    // the captured FIRST `f` → A1 = 10). This PINS the residual's DIRTYING face — proving
    // it is NOT load-path-only; the context-sensitive capture fix flips it to Number(10).
    // It remains an OVER-report (B1→B1 is spurious), never a dropped dependency.
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
        Value::Error(ErrorValue::Circ),
        "RESIDUAL (pinned): the name-merge over-reports the rebound f's B1 self-edge → \
         spurious #CIRC!; a context-sensitive capture analysis would yield Number(10)"
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
fn wrong_arity_call_args_over_walked_known_residual() {
    // **Codex FU-NEXT re-audit #4 — DOCUMENTED RESIDUAL (over-report, non-blocking).** The
    // arity filter gates the lambda BODY, but the walker's `CallLambda` arm still walks the
    // call's ARG subtrees unconditionally. `=LET(f,LAMBDA(x,1),f(B1,0))` is a wrong-arity
    // call → `invoke_lambda` returns `#VALUE!` BEFORE evaluating the args, so B1 is not
    // actually read; but the walker records B1 (the owning cell) as a precedent → a
    // spurious self-edge. This PINS the over-report (B1 IS recorded). It is NEVER an
    // under-report; the durable fix (live-call gating of args) is part of the deferred
    // context-sensitive analysis — see `invoked_lambda_bodies`' residual note.
    let deps = formula_deps_for("LET(f,LAMBDA(x,1),f(B1,0))").expect("has deps (B1 arg)");
    assert!(
        deps.cells.contains(&(0, 0, 1)),
        "RESIDUAL: the wrong-arity call's B1 arg is over-walked (live-call arg gating \
         closes this); got {deps:?}"
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
fn fu3_let_array_local_as_unified_fn_arg_is_calc() {
    // Megaudit (Sonnet lane B) deferred-boundary pin: an array local passed as an arg to a
    // UNIFIED array fn (=LET(s,SEQUENCE(3),TRANSPOSE(s))) stays #CALC! — array-as-arbitrary-arg
    // works nowhere in v1 (the LocalRef arg materializes to #CALC! before TRANSPOSE sees it).
    // Same as the SUM case but for the Unified tier; folds into FU4. Pre-existing, not an FU3
    // regression.
    let (wb, _g, _r) = setup("LET(s,SEQUENCE(3),TRANSPOSE(s))", 0.0);
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Calc)
    );
    assert_eq!(wb.spill_anchor_at(0, 0, 1).copied(), None, "must NOT spill");
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

// --- Deferred-tier PRODUCTION pins (a scalar-context #CALC! pin is vacuous: the
// boundary maps any BYROW array result to #CALC! regardless of the cells. These
// assert the SPILLED CELL values, so they FAIL the day MEDIAN/INDEX start
// computing over an array-local — making any future relaxation deliberate.) -----

#[test]
fn fu4b_byrow_median_over_row_local_is_calc_in_production() {
    // **Megaudit (Codex MED → operator-deferred; re-audit LOW: strengthen the pin).**
    // MEDIAN is RangeAware-tier, so an array-local row stays #CALC! per cell — the
    // result spills 2×1 with BOTH cells #CALC! (NOT {2;5}). If the relaxation later
    // extends to the RangeAware reducers, these cells become numbers and this fails.
    let (wb, _g, _r) = setup("BYROW({1,3,2;4,6,5},LAMBDA(r,MEDIAN(r)))", 0.0);
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(2, 1)),
        "BYROW still spills 2×1 even when each row is a deferred #CALC!"
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
fn fu4b_byrow_index_over_row_local_is_deferred_loud_in_production() {
    // Companion deferred-tier production pin for the RangeAware LOOKUP family: INDEX
    // over an array-local row stays LOUD (does NOT compute the lookup), confirming
    // the relaxation is reducers-only. **The exact code differs from MEDIAN:** INDEX
    // gets the array-local as `FnArg::Scalar(#CALC!)` (the RangeAware arm's unchanged
    // `other` materialization) and REJECTS that malformed array arg with #VALUE!,
    // whereas MEDIAN (a reducer) PROPAGATES the #CALC!. Both are loud/deferred; this
    // pin asserts the observed #VALUE! per cell. It still spills 2×1 (errors spill).
    // (The scalar-context pin `fu4b_byrow_index_over_row_local_is_calc_in_scalar_context`
    // only sees the boundary's whole-array→#CALC! collapse, so it can't distinguish the
    // codes — which is why this production pin exists.)
    let (wb, _g, _r) = setup("BYROW({1,2;3,4},LAMBDA(r,INDEX(r,1)))", 0.0);
    assert_eq!(
        wb.spill_anchor_at(0, 0, 1).copied(),
        Some(SpillShape::new(2, 1))
    );
    assert_eq!(
        wb.read(Address::new(0, 0, 1)),
        Value::Error(ErrorValue::Value)
    );
    assert_eq!(
        wb.read(Address::new(0, 1, 1)),
        Value::Error(ErrorValue::Value)
    );
}
