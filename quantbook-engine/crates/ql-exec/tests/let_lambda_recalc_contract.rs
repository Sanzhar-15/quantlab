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
