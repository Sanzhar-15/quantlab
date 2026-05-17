# Reference-tier Step 3 — separate-Opus audit

**Date:** 2026-05-17
**Subject:** Step 3 implementation commit (working-tree, pre-commit) of the reference-tier mini-phase. Registers ISREF + ISFORMULA — the information batch. ISREF is the **first user-facing fn through `ArgContract::LazyShape`**; ISFORMULA uses `Eager` + `ReferenceQuery::is_formula_at`.
**Auditor:** separate-Opus (4.7, 1M-context), independent of the parallel Codex audit running concurrently.
**HEAD baseline:** `98ca4e697b3` (post-Step-2.1). Test count: 3187 → 3229 (+42, breakdown: 19 unit + 23 e2e). All four gates reported green pre-audit; Step 3 e2e suite confirmed green by re-running locally (23/23 pass).
**Design doc:** `docs/architecture/2026-05-17-reference-tier-design.md` v2 § 2.3, § 2.4, § 5.6.
**Plan:** `.plans/_active.md` Phase 3.
**Audit transcripts read:** `2026-05-17-rt-step-1-{codex,opus}.md`, `2026-05-17-rt-step-2-{codex,opus}.md`, cumulative summary `2026-05-17-reference-tier-audit-summary.md`.

## Audit scope

Files read end-to-end:

- **NEW:** `crates/ql-exec/tests/reference_fns_step3_e2e.rs` (285 lines, 23 e2e tests).
- `crates/ql-functions/src/reference_fns.rs` (852 lines — Step 3 added ISREF + ISFORMULA impls + 19 unit tests on top of Step 2's 4 fns + 35 tests).
- `crates/ql-functions/src/registry.rs` (diff — 2 new `register_reference_aware` calls + count test 197 → 199).
- `crates/ql-functions/src/reference_aware_fns.rs` (full file 312 lines — Step 1 infra, unchanged in Step 3).
- `crates/ql-exec/src/plan.rs` (diff — `step_2_reference_aware_names_registered_in_reference_tier` extended to 6 names; FORMULATEXT-only check left).
- `crates/ql-exec/src/scalar.rs:420-690` — dispatcher arm + `materialize_ref_arg_eager` / `_lazy` materializers; cell-boundary guard `eval_at_cell_boundary:830-892`.
- `crates/ql-exec/src/calcgraph_session.rs:160-420, 1700-1745` — `is_address_only_reference_fn` (ISREF in the list), `walk_plan_for_address_only_deps` (shape-aware), `dep_suppressed_reference_fns_match_design` invariant test.
- `crates/ql-exec/src/env.rs:154-320` — `WorkbookEnv::reference_query()` + `ReferenceQuery` impl.
- `crates/ql-storage/src/workbook.rs:820-890` — `put_formula` / `formula_at` / `clear_formula` / `put_computed_at`.
- `crates/ql-functions/tests/coverage.rs` (diff — 2 EXPLICITLY_DEFERRED entries).
- `docs/compat/excel-matrix.md` (diff — ISREF + ISFORMULA rows replacing the prior consolidated `ISFORMULA / ISREF` deferred row).
- `crates/ql-storage/src/sheet.rs:140-180` — `Sheet::read` returns the **stored value overlay**; `put_computed` writes formula evaluation results including errors.
- `.references/ironcalc/base/src/functions/information.rs:119-200` — IronCalc canon for `fn_isref` + `fn_isformula`.

Probe test I ran during the audit (then removed): `crates/ql-exec/tests/probe_step2_error_regression.rs` confirming the inherited Step 2.1 error-overlay propagation regression (see HIGH-S3-O-1 below).

## Findings — final dispositions

**Tally:** 4 HIGH + 10 MEDIUM + 13 LOW = **27 findings.**

Per the audit-discipline rule ("don't stop at 2-3 findings; surface every concern"), I have included low-impact items too.

---

## HIGH

### HIGH-S3-O-1 — **Inherited regression from Step 2.1 now exposed by ISFORMULA**: `materialize_ref_arg_eager`'s `ExprPlan::CellRef` arm propagates the cell's **evaluated-value error** as `RefArg::Error(ev)`, so `ISFORMULA(B2)` on a formula cell whose result is `#DIV/0!` returns `#DIV/0!` instead of `TRUE`. Excel canon: ISFORMULA returns TRUE iff the cell stores a formula — REGARDLESS of the formula's evaluated value. **Concrete reproduction:** `wb.put_formula(0,0,0,"1/0"); wb.put_computed_at(0,0,0, Value::Error(DivZero));` then `=ISFORMULA(A1)` returns `Value::Error(DivZero)`. Tested + confirmed locally via temp probe (then removed).

**Where:** `crates/ql-exec/src/scalar.rs:573-600`.

```rust
ExprPlan::CellRef { sheet, row, col, .. } => {
    let value = env.read_cell(*sheet, *row, *col);
    match value {
        Value::Error(ev) => RefArg::Error(ev),
        ok => RefArg::Reference { address, value: ok },
    }
}
```

**Detail:** Step 2.1 audit (closing S2-HIGH-2) added this error-mapping arm. The reachability comment at scalar.rs:585-591 claims:

> Note: today this path is unreachable from end-user formulas (the workbook runtime has no `delete_sheet` API and binder rejects unknown-sheet refs at bind time, not at eval).

**That claim is wrong.** The path IS reachable, and Step 3's ISFORMULA reachability + impl-shape makes the bug user-visible for the first time. `env.read_cell(sheet, row, col)` returns *whatever is stored in the sheet's column overlay at (row, col)*. For an evaluated formula cell whose result is an error, `put_computed_at` writes `Value::Error(ev)` to the overlay (see `crates/ql-exec/src/workbook_runtime.rs:1238`, `:3009`, `:3024`). The next `read_cell` returns that error. The Step 2.1 arm then wraps it as `RefArg::Error(ev)` and ISFORMULA's first match arm (the design's HIGH-F closure for `#REF!` propagation) returns that error.

**Three concrete user-visible cases:**

1. `=ISFORMULA(A1)` where A1 = `=1/0`. Excel: `TRUE`. Ours: `#DIV/0!`.
2. `=ISFORMULA(A1)` where A1 = `=Sheet99!X1` and Sheet99 was deleted (after refactor). Excel: `TRUE`. Ours: `#REF!`.
3. `=ROW(A1)` where A1 = `=1/0`. Excel: `1`. Ours: `#DIV/0!`. (ROW inherits the same bug — already shipped in Step 2; was masked because no tests exercised a formula-with-error-value cell.)

The probe test I ran during the audit (`probe_isformula_on_formula_cell_with_error_result` + `probe_row_on_formula_cell_with_error_result`) confirms both. Output:

```
Result: Error(DivZero)
assertion `left == right` failed: ISFORMULA(A1) for a formula cell returning #DIV/0! should be TRUE
  left: Error(DivZero)
 right: Boolean(true)
```

**Why the Step 2.1 closure shipped this:** the closure was framed as "mirror the fallthrough arm's error mapping". The fallthrough arm `other => eval_scalar_with_cache(...)` evaluates an arbitrary subexpression (e.g., `ROW(SUM(NamedRange))` → eager-eval SUM, returns Scalar(Number)); errors there are runtime errors from arithmetic/text/etc. that SHOULD propagate. But CellRef is a *direct reference* — the user wrote `ROW(A1)`, NOT `ROW(A1+0)`. The address is the input, not the cell's value. Excel canon: address-only fns (ROW/COLUMN) and formula-status fns (ISFORMULA) consume the address, not the value. So the materializer should NOT propagate read errors from CellRef.

**The Step 2.1 audit's example case (`ROW(Sheet99!A1)` for deleted sheet)** is also conceptually wrong: in Excel, `ROW(InvalidRef)` returns the row of the (already-resolved) reference, not `#REF!`. `#REF!` is what happens to a formula when ITS OWN cell ref is broken (e.g., the user deleted the referenced row/column). Excel canon for `ROW(<broken-ref>)` after a column delete: the formula becomes `=ROW(#REF!)`, which evaluates to `#REF!` because the ARG IS now an error literal — not because the row read returned an error. That path (Expr::Error literal arg) is correctly handled by the materializer's `ExprPlan::Error(ev) => RefArg::Error(ev)` arm at scalar.rs:635.

**Reconciliation with Step 2.1's intent:** the Step 2.1 fix conflated two distinct error sources:

| Source | Step 2.1 behavior | Correct Excel behavior |
|--------|-------------------|------------------------|
| `Expr::Error(ev)` literal arg (e.g., `=ROW(#REF!)`) | Propagate via materializer's Error arm | Propagate (matches) |
| `ExprPlan::CellRef` whose cell value-overlay is an error | Propagate via Step 2.1's CellRef arm | **DO NOT propagate** (address is what matters) |

Step 2.1 added propagation to the second case in addition to the first, creating the bug.

**Recommendation:** **Roll back the Step 2.1 error-propagation in the CellRef arm.** The CellRef materializer should return `RefArg::Reference { address, value: ok_or_blank }` REGARDLESS of whether `read_cell` returns an error. Two options:

1. **(Preferred)** Drop the `value` field from `RefArg::Reference` entirely. No v1 consumer uses it (`..`-pattern in ROW/COLUMN/ROWS/COLUMNS/ISFORMULA/FORMULATEXT). Closes the wasted-CPU concern from Step 2 Opus HIGH-S2-O-2 too. ABI break is internal-only.

2. **(Minimal)** Replace the Step 2.1 arm with:
   ```rust
   ExprPlan::CellRef { sheet, row, col, .. } => RefArg::Reference {
       address: ql_types::Address::new(*sheet, *row, *col),
       value: Value::Blank,  // unused; placeholder.
   }
   ```
   No read at all. Closes the bug AND the wasted-CPU concern. Doc-comment update needed.

After EITHER fix, add a regression e2e test:

```rust
#[test]
fn isformula_of_formula_cell_with_error_result_returns_true() {
    let mut wb = Workbook::new(); wb.add_sheet("S0");
    wb.put_formula(0, 0, 0, "1/0");
    wb.put_computed_at(0, 0, 0, Value::Error(ErrorValue::DivZero));
    // Bind/eval =ISFORMULA(A1) — must return TRUE, NOT #DIV/0!.
}
```

**Severity rationale:** HIGH because (a) it's an Excel-canon divergence that's reachable from any formula cell that ever evaluated to an error; (b) it silently masks formula-status TRUE as a downstream error, with no compiler/runtime warning; (c) Step 3 introduces the new ISFORMULA fn that makes the bug user-visible; (d) the Step 2.1 reachability claim was incorrect (audited by Step 2 Opus but the audit also missed the formula-with-error case — both audits missed it because no test exercised `put_computed_at(error)`). ROW/COLUMN already shipped with the bug in Step 2; Step 3 just adds another fn that surfaces it. This is the single most important finding in Step 3 scope.

---

### HIGH-S3-O-2 — `materialize_ref_arg_lazy` + walker asymmetry for ISREF + volatile Function args: `=ISREF(NOW())` marks the formula volatile (walker descends through `walk_plan_for_address_only_deps` fall-through to `walk_plan_for_deps`, which sets `is_volatile = true`), but the lazy materializer NEVER evaluates NOW(). **Result: spurious recompute on every volatile cycle, producing a stable FALSE.** This is a NEW asymmetry introduced by Step 3 (registering ISREF with `ArgContract::LazyShape`); the Step 1.1 walker was designed assuming Eager-contract address-only fns.

**Where:**
- Walker: `crates/ql-exec/src/calcgraph_session.rs:400-418` (`walk_plan_for_address_only_deps`, Function arm falls through to `walk_plan_for_deps`).
- Materializer: `crates/ql-exec/src/scalar.rs:651-673` (`materialize_ref_arg_lazy` for `ExprPlan::Function` → `PlanKind::Function`; never calls eval).
- Step 1.1 doc-comment: `calcgraph_session.rs:390-396`: *"ROW(NOW()) MUST mark the formula volatile"* — but this assumes Eager contract. ISREF inherits the dep policy but skips eval.

**Detail:** Step 1.1 closure (S1-HIGH-A) made the dep walker **shape-aware**: direct CellRef/RangeRef skips value-deps (address-only), but Binary/Unary/Function/etc. fall through to `walk_plan_for_deps` (which marks volatile for `NOW`/`RAND`/etc.). The rationale: the eager materializer DOES evaluate Function args at dispatch time, so volatile re-firing IS needed to keep the recompute path correct.

**But ISREF uses LazyShape contract.** The lazy materializer at scalar.rs:651-673 maps `ExprPlan::Function` → `PlanKind::Function { returns_reference: false }` WITHOUT calling `eval_scalar_with_cache`. So:

- Walker marks `=ISREF(NOW())` volatile via the fall-through.
- Calcgraph schedules `=ISREF(NOW())` to recompute on every volatile cycle.
- Lazy materializer returns `PlanKind::Function { returns_reference: false }` without evaluating NOW.
- ISREF returns FALSE.
- Result is stable across recomputes — but every recompute spends CPU re-dispatching.

This is asymmetric: for ROW/COLUMN/ROWS/COLUMNS (Eager) the volatile marking is **correct** (NOW IS evaluated, so the result IS time-dependent — though it always coerces to `#VALUE!` for non-Reference scalar). For ISREF (LazyShape) the volatile marking is **wasted** (NOW is never evaluated; the result is purely shape-derived).

**Reachability:** `=ISREF(NOW())` is unusual but legal. More likely: `=ISREF(SUM(NOW()))` or `=IF(ISREF(NOW()), "yes", "no")` — anywhere a user wraps a volatile-fn in an ISREF.

**Wasted CPU magnitude:** for a workbook with N volatile cells and M `=ISREF(volatile_expr)` formulas, every volatile cycle re-dispatches all M. If the cell-cache short-circuits the recompute (input plan didn't change), the cost is one materializer call per cycle. If not, it's one full re-dispatch.

**Recommendation:** Two paths:

1. **(Preferred)** Make `walk_plan_for_address_only_deps` even shape-aware-er: for the LazyShape contract subset (ISREF in v1, future ISFORMULA-class lazy fns), skip volatile detection too. Add a sibling `walk_plan_for_lazy_shape_args` that NEVER recurses; or add a per-name policy:

   ```rust
   if name == "ISREF" {
       // LazyShape — no eval, no recursion, no volatile detection.
       // The result depends only on the arg's plan-tree shape, which
       // is stable across recomputes.
       continue;
   }
   if is_address_only_reference_fn(name) {
       for arg in args { walk_plan_for_address_only_deps(arg, deps); }
   } else { ... }
   ```

2. **(Documentation)** Add a doc-comment note at `is_address_only_reference_fn` explicitly enumerating: "ISREF is in this list but goes through `materialize_ref_arg_lazy`, NOT eager-eval. Volatile marking on its args is therefore wasted CPU but harmless (result is stable). Tracked as known v1 cost; fix in a follow-up."

The minimum to ship Step 3 is the documentation note. The correctness-correct fix is path 1; it's worth doing because ISREF is the FIRST LazyShape fn and the asymmetry will accumulate as more LazyShape fns ship (ISREFTYPE / ISARRAY follow-ups).

**Severity rationale:** HIGH because (a) it's a NEW asymmetry introduced by Step 3 that the Step 1.1 walker design didn't anticipate; (b) the design doc § 5.3 dep-tracking policy explicitly listed ISREF as "dep-SUPPRESS" — current behavior partially follows but Function args silently leak through the fall-through; (c) the wasted CPU compounds with workbook size for the specific pattern `=ISREF(volatile_expr)`; (d) the test suite has zero coverage of this case. HIGH-flavored for the design-intent divergence + missing test coverage + workspace-wide latent cost; MEDIUM-flavored for the magnitude (most workbooks won't have `=ISREF(NOW())`). I rate HIGH because the design intent ("no value-deps registered" — design v2 § 5.3 line 389) is being silently violated and Step 3 is the natural moment to either ship the fix or document the divergence.

---

### HIGH-S3-O-3 — **Missing test coverage for the volatile-fn / cache-pollution invariant of LazyShape contract.** The plan checklist Phase 3 line 99 requires *"8+ per fn including ISREF-no-eval verification (instrumented test for volatile-fn or cache-pollution)"*. The shipped tests verify ISREF-no-eval for the `1/0` div-by-zero case (which exercises Binary/eval-side errors). But the *aggregate-cache pollution* test and *volatile-fn instrumented* test (both explicitly named in the plan) are absent.

**Where:**
- Plan: `.plans/_active.md:99` *"8+ per fn including ISREF-no-eval verification (instrumented test for volatile-fn or cache-pollution)"*.
- Tests file: `crates/ql-exec/tests/reference_fns_step3_e2e.rs` (zero matches for `NOW`, `RAND`, `volatile`, `aggregate_cache`, `cache`).

**Detail:** The Step 1 Opus audit HIGH-O-3 captured the asymmetry between materializer eager-eval and walker dep-suppress — specifically that volatile-fn re-firing under suppressed deps was a quiet asymmetry. Step 1.1 made the walker shape-aware so ROW(NOW()) DOES mark volatile (correct for Eager contract). Step 3 introduces LazyShape contract for the first time. The plan's Phase 3 checklist explicitly required test coverage for this — verifying that under LazyShape contract:

1. **Aggregate cache not polluted.** `=ISREF(SUM(NamedRange))` must NOT cause `store_aggregate` to fire for SUM. A test would assert via an `AggregateCache` impl that counts `store_aggregate` calls.

2. **Volatile-fn not re-evaluated.** `=ISREF(NOW())` must NOT call NOW's impl. A test would use a custom NOW-mock that bumps a counter on each call.

Neither test is present. The only no-eval test (`isref_of_divide_by_zero_returns_false_without_eval`) checks the negative case: that `1/0` doesn't surface `#DIV/0!`. But this passes via the binder's Binary plan → `PlanKind::Literal` arm — it doesn't directly verify the materializer skipped the eval (it could also pass if the materializer evaluated but suppressed the error result). A counter-instrumented test is the only way to verify the no-eval contract.

**Recommendation:** Add two integration tests in Step 3.1 closure:

```rust
// Counter-instrumented NOW impl to verify ISREF does NOT eval its arg.
#[test]
fn isref_of_volatile_fn_does_not_invoke_volatile() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NOW_CALLS: AtomicUsize = AtomicUsize::new(0);
    fn count_now(_: &[Value], _: &EvalContext) -> Value {
        NOW_CALLS.fetch_add(1, Ordering::Relaxed);
        Value::number(1.0)
    }
    let mut reg = FunctionRegistry::new();
    reg.register_reference_aware("ISREF", reference_fns::isref, ArgContract::LazyShape);
    reg.register_context_aware("NOW", count_now);
    NOW_CALLS.store(0, Ordering::Relaxed);
    let result = eval_with_reg("ISREF(NOW())", &reg);
    assert_eq!(result, Value::Boolean(false));
    assert_eq!(NOW_CALLS.load(Ordering::Relaxed), 0,
        "ISREF must NOT invoke its arg under LazyShape contract");
}

// Aggregate-cache instrumentation test for ISREF.
#[test]
fn isref_of_aggregate_does_not_pollute_aggregate_cache() {
    let cache = CountingAggregateCache::new();
    eval_with_cache("ISREF(SUM(NamedRange))", &cache);
    assert_eq!(cache.store_calls(), 0,
        "ISREF must NOT trigger aggregate cache writes");
}
```

**Severity rationale:** HIGH because (a) the plan checklist explicitly enumerated this coverage class; (b) the no-eval guarantee is the SINGLE most important contract for `ArgContract::LazyShape` (the design's HIGH-B closure); (c) the regression risk is high — a future materializer refactor that "for consistency" applies eager-eval to LazyShape args would silently break the contract; (d) the current `isref_of_divide_by_zero_returns_false_without_eval` test only catches the case where eval would surface an error — it does NOT catch the case where eval succeeds but writes to the cache or fires side effects. This is the same pattern as Step 1's HIGH-O-1 (doc-promised invariant test missing).

---

### HIGH-S3-O-4 — **ISFORMULA test suite has ZERO coverage of the `WorkbookRuntime::set_formula` path** (which canonicalizes via `parse → print_with`). All TRUE-path tests use `Workbook::put_formula` (storage-level), bypassing the canonicalization step. The "workbook-runtime e2e" claim in the new EXPLICITLY_DEFERRED entry for ISFORMULA is therefore false.

**Where:**
- Tests: `crates/ql-exec/tests/reference_fns_step3_e2e.rs:137` (`isformula_of_formula_cell_returns_true` uses `wb.put_formula(0, 1, 1, "1+2")`).
- Coverage claim: `crates/ql-functions/tests/coverage.rs:632-641` (`ISFORMULA` entry says *"+ ql-exec workbook-runtime e2e (formula-vs-literal cell TRUE/FALSE via real Workbook)"*).

**Detail:** Two factual issues:

1. **Coverage claim falsity.** The EXPLICITLY_DEFERRED entry mentions "workbook-runtime e2e (formula-vs-literal cell TRUE/FALSE via real Workbook)" — implying the tests exercise `WorkbookRuntime` (the transaction + op-log + canonicalization path). Grep across `reference_fns_step3_e2e.rs` confirms ZERO `WorkbookRuntime`, `set_formula`, `transaction`, `commit`, or `recompute` references. All formula setup uses `Workbook::put_formula` (storage-level, bypasses canonicalization + op-log + cache invalidation). The "workbook-runtime e2e" wording is misleading.

2. **Canonicalization path untested.** `WorkbookRuntime::set_formula` at workbook_runtime.rs:534 does `parse → print_with(.., A1, EnUs, ...)` to canonicalize the formula text before calling `Workbook::put_formula` (line 775). The canonicalized text may differ from the user-typed source (spacing/case/operator-precedence/etc.). ISFORMULA reads `formula_cells.get(...).is_some()`, so the boolean result is invariant under canonicalization. **But** ISFORMULA's downstream design (FORMULATEXT in Step 4) reads the canonical text directly; an undetected canonicalization bug there would surface only via Step 4. The lack of canonicalization coverage in Step 3 means Step 4's tests will need to back-fill this coverage.

**Probable scenario:** end-user types `=isformula(B2)` (lowercase). WorkbookRuntime parses + canonicalizes → ISFORMULA registered as "ISFORMULA" via case-insensitive lookup. The formula text in `formula_cells` is canonical. ISFORMULA returns the storage-level value. This works. But: end-user types `=ISFORMULA(b2)` (lowercase B2). Parser canonicalizes to `B2`. The canonical text stored: `ISFORMULA(B2)`. The user's mental model is still "lowercase b2". Future debugging surface: "I typed lowercase, why is the stored formula uppercase?" — this is the FORMULATEXT concern. For ISFORMULA itself (boolean), the path is fine.

**Recommendation:**

1. Add ONE workbook-runtime e2e test in Step 3.1 closure:

```rust
#[test]
fn isformula_via_workbook_runtime_set_formula() {
    let mut wb = Workbook::new();
    wb.add_sheet("S0");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_formula(0, 1, 1, "=1+2").unwrap();        // B2 = formula via runtime
    rt.set_formula(0, 0, 0, "=ISFORMULA(B2)").unwrap();
    rt.recompute_all();
    let v = wb.read(Address::new(0, 0, 0));
    assert_eq!(v, Value::Boolean(true));
}
```

2. Fix the EXPLICITLY_DEFERRED entry wording to either match the actual coverage ("via Workbook::put_formula storage-level setup") OR add the workbook-runtime e2e and keep the wording.

**Severity rationale:** HIGH because (a) the coverage claim is FACTUALLY FALSE; (b) the missing workbook-runtime e2e is the only path that exercises the canonicalization + op-log integration; (c) the integration path is load-bearing for FORMULATEXT (Step 4) and a Step 3.1 closure to add the e2e test would be cheap. HIGH-flavored for "coverage claim is a lie" (same severity rationale as the Step 1 HIGH-O-1 / Step 2 HIGH-S2-O-3 doc-comment lies); MEDIUM-flavored for the actual coverage gap (boolean ISFORMULA is invariant under canonicalization). Net: HIGH per severity rule ("take higher"). Same pattern as Step 2's S2-MED-δ (coverage claim overclaim).

---

## MEDIUM

### MEDIUM-S3-O-1 — `step_2_reference_aware_names_registered_in_reference_tier` disjointness check missing `lookup_context_aware`. The test pinpoints ISREF / ISFORMULA must NOT appear in scalar / range-aware / unified tables, but skips the context-aware tier. A future typo registering ISREF as `register_context_aware` would silently slip through.

**Where:** `crates/ql-exec/src/plan.rs:1755-1800`.

**Detail:** The disjointness loop:

```rust
assert!(reg.lookup(name).is_none(), "{name:?} ... scalar table");
assert!(reg.lookup_range_aware(name).is_none(), "{name:?} ... range-aware");
assert!(reg.lookup_unified(name).is_none(), "{name:?} ... unified");
```

`lookup_context_aware` is omitted. Today the underlying registry storage is a single `HashMap<&'static str, RegisteredFn>` (see registry.rs:340 `lookup_any`), so a name can only appear in ONE tier — a duplicate registration would panic at `register_context_aware`. So the risk is reduced to "the panic catches it at default_registry() construction time, not at test time". But the test is the explicit invariant. The pattern `accepts_special_arg_lists_only_registered_reference_aware_matcher_pin` lists scalar+range-aware+unified at plan.rs:1779-1782 — copy-paste oversight: context-aware was simply forgotten when adding the disjointness loop.

The sibling test `is_aggregate_function_lists_only_registered_aggregates` at workbook_runtime.rs:5158-5239 also OMITS context-aware. So this is a broader pattern, not unique to Step 3. But Step 3 had the opportunity to fix it and didn't.

**Recommendation:** Add to both disjointness loops in plan.rs:1755 + workbook_runtime.rs:5158:

```rust
assert!(reg.lookup_context_aware(name).is_none(),
    "{name:?} is reference-aware ONLY; must not appear in context-aware table");
```

Trivial fix. Defense-in-depth.

**Severity rationale:** MEDIUM. The single-HashMap storage prevents accidental dual-registration, but the test omission is an invariant gap. MEDIUM-flavored because it's defense-in-depth rather than current correctness; LOW-flavored if the registry storage invariant ("single tier per name") is held by stronger means (panic on duplicate). Net MEDIUM because adding the check is one line and the pattern signal ("invariant tests should be exhaustive") is load-bearing.

---

### MEDIUM-S3-O-2 — ISREF / ISFORMULA `RefArg::Error` defensive arms diverge from design § 5.6 pseudo-code without doc-comment justification.

**Where:** `crates/ql-functions/src/reference_fns.rs:194-209` (ISREF) + `:232-256` (ISFORMULA).

**Detail:** Design § 5.6 ISREF pseudo-code:

```rust
fn isref(args: &[RefArg], _: &RefContext) -> Value {
    match args {
        [RefArg::Shape(PlanKind::CellRef | PlanKind::RangeRef)] => Value::Boolean(true),
        [RefArg::Shape(PlanKind::Function { returns_reference: true })] => Value::Boolean(true),
        [RefArg::Shape(_)] => Value::Boolean(false),
        _ => Value::Error(ErrorValue::NA),  // arity error
    }
}
```

The impl ADDS defense-in-depth arms for `RefArg::Reference / Range / Scalar / Array / Error`:

```rust
[RefArg::Reference { .. } | RefArg::Range { .. }] => Value::Boolean(true),
[RefArg::Scalar(_) | RefArg::Array(_) | RefArg::Error(_)] => Value::Boolean(false),
```

The doc-comment at reference_fns.rs:200-205 says these are "unreachable under the contract but kept for defense-in-depth". Two issues:

1. **Semantic divergence.** Under the design's pseudo-code, `RefArg::Error(_)` would fall through `_ => Value::Error(ErrorValue::NA)` (arity error). The impl returns `Value::Boolean(false)`. These are different user-visible results. Even though the impl path is "unreachable under LazyShape contract", **someone might invoke `isref()` directly from a future test or extension**, and the behavior would silently differ from spec.

2. **No design-doc update.** If the defense-in-depth arms are intentional, they should be reflected in the design § 5.6 OR explicitly noted as "impl-only defense-in-depth, NOT design contract".

Similarly for ISFORMULA: design says `[_] => Value::Error(ErrorValue::NA)` (arity error). Impl explicitly enumerates `[RefArg::Range { .. } | RefArg::Array(_) | RefArg::Scalar(_) | RefArg::Shape(_)] => Value::Error(ErrorValue::NA)` plus the `_` arm. Net behavior matches design, but a future impl reader would have to verify all variants are enumerated.

**Recommendation:** Two paths:

1. **Drop the defensive arms.** They're unreachable under the dispatcher's contract enforcement. The single `_ => Value::Error(ErrorValue::NA)` arm covers everything-not-Shape-not-arity-1.

2. **Document the design-impl divergence.** Add to the doc-comment: "Defensive arms diverge from design § 5.6 pseudo-code for clarity / forward-compat. Specifically: a future caller invoking `isref(&[RefArg::Error(...)], ...)` directly (bypassing the dispatcher) gets FALSE, not #N/A. This is intentional v1 defense-in-depth."

Path 1 is cleaner; path 2 is acceptable if the design is updated too.

**Severity rationale:** MEDIUM because the behavior divergence is silent (no test would fail if isref's `RefArg::Error` arm was changed from FALSE to #N/A), and the doc-comment claims "unreachable" without explaining the chosen semantics. Pattern signal: "design pseudo-code and impl should match OR divergence should be explicitly justified" — same pattern as Step 2's S2-MED-α (stale doc).

---

### MEDIUM-S3-O-3 — `isref` doc-comment says "`ISREF(NamedCell)` → TRUE (resolves to AggregateNameRef → RangeRef)" but `NamedTarget::Cell` resolves to `ExprPlan::CellRef` → `PlanKind::CellRef`, NOT `AggregateNameRef`. The user-visible result (TRUE) is correct via a different path.

**Where:** `crates/ql-functions/src/reference_fns.rs:181`.

**Detail:** The plan resolution path for a `NamedTarget::Cell` (single named cell, not a range):

1. `Expr::NameRef("MyCell")` → binder calls `names.lookup_named_target` → `Some(ResolvedName::Cell(sheet, row, col, abs_col, abs_row))` (plan.rs:825).
2. The Cell arm at plan.rs:825-832 produces `ExprPlan::CellRef { sheet, row, col, abs_col, abs_row }`.
3. Lazy materializer maps `ExprPlan::CellRef` → `PlanKind::CellRef`.
4. ISREF returns TRUE (matches `CellRef | RangeRef`).

The doc-comment claim "AggregateNameRef → RangeRef" is wrong; it would apply to a `NamedTarget::Range` (named **range**, not **cell**). The Step 3 e2e test `isref_of_named_range_returns_true` actually uses `NamedTarget::Range`, so the COMMENT and TEST are consistent — the COMMENT just mis-says "NamedCell". The test for `NamedTarget::Cell` proper is missing (coverage gap).

**Recommendation:**

1. Fix the doc-comment to enumerate BOTH cases:
   - `ISREF(NamedCell)` (NamedTarget::Cell) → TRUE (resolves to `ExprPlan::CellRef` → `PlanKind::CellRef`).
   - `ISREF(NamedRange)` (NamedTarget::Range) → TRUE (resolves to `ExprPlan::AggregateNameRef` → `PlanKind::RangeRef`).

2. Add a Step 3.1 e2e test using `NamedTarget::Cell`:

```rust
#[test]
fn isref_of_named_cell_returns_true() {
    let mut wb = workbook_with_sheet();
    wb.set_name("MyCell", NamedTarget::Cell(Address::new(0, 5, 5))).unwrap();
    // ... bind ISREF(MyCell), assert TRUE
}
```

**Severity rationale:** MEDIUM. The doc-comment is factually wrong (per Step 1 / Step 2's pattern of "doc claims one path, impl uses another"). The test gap is a real missing-coverage case (no test exercises the `NamedTarget::Cell` lazy-materializer path).

---

### MEDIUM-S3-O-4 — `excel-matrix.md` test count for ISFORMULA is "9+10 e2e" but actual e2e count is **12** (`isformula_of_formula_cell_returns_true` + `..._literal_cell` + `..._blank_cell` + `..._multi_cell_range` + `..._text_arg` + `..._number_arg` + `..._arithmetic_arg` + `..._propagates_ref_error` + `..._arity_zero` + `..._arity_two` + `..._of_named_cell` + `..._cross_sheet`). Off by 2.

**Where:** `docs/compat/excel-matrix.md:242` (ISFORMULA row).

**Detail:** Grep across `reference_fns_step3_e2e.rs` for `^fn isformula_`:

```
fn isformula_of_formula_cell_returns_true
fn isformula_of_literal_cell_returns_false
fn isformula_of_blank_cell_returns_false
fn isformula_of_multi_cell_range_returns_na
fn isformula_of_text_arg_returns_na
fn isformula_of_number_arg_returns_na
fn isformula_of_arithmetic_arg_returns_na
fn isformula_propagates_ref_error
fn isformula_arity_zero_returns_na
fn isformula_arity_two_returns_na
fn isformula_of_named_cell_pointing_at_formula_returns_true
fn isformula_cross_sheet_returns_correct_status
```

12 tests. Matrix says 10. ISREF count is correct (10 unit + 11 e2e = 21; matrix says "10+11 e2e" = 21 ✓).

**Recommendation:** Update matrix to `"9+12 e2e"`. Same pattern as Step 2's S2-LOW-1 — recompute against actual file when committing.

**Severity rationale:** MEDIUM. The matrix is a coverage-report contract; an undercount could silently mask test deletions. Pattern signal: "test counts in user-facing docs should be derived, not hand-maintained" — but no automated tooling today; manual update with grep is the v1 cost.

---

### MEDIUM-S3-O-5 — No e2e test for `=ISFORMULA(@A1:A10)` implicit-intersection narrowing — design § 7 cross-fn coverage matrix calls this out and it's listed in Phase 3 as part of ISFORMULA coverage; the binder's implicit-intersection narrowing of `@RangeRef` produces a single-cell CellRef, which the ISFORMULA Eager materializer consumes via the CellRef arm. Step 5 (cross-cutting suite) is the documented home for this — but Step 5 has no plan-checklist line specifically enumerating it.

**Where:**
- Plan checklist: `.plans/_active.md:115-123` (Phase 5).
- Test files: zero matches for `@A1` / `@ISFORMULA` / `ImplicitIntersection`.

**Detail:** The implicit-intersection narrow path:

1. AST: `Expr::Function { name: "ISFORMULA", args: [Expr::ImplicitIntersection(Expr::RangeRef(rr))] }`.
2. Binder routes ISFORMULA's args under `ReferenceArg` context.
3. `Expr::ImplicitIntersection(_)` arm at plan.rs:934 calls `bind_implicit_intersection`.
4. For `Expr::RangeRef(rr)`, `narrow_range_for_implicit_intersection` narrows to a single cell using the formula's anchor (plan.rs:996).
5. Result: `ExprPlan::CellRef { sheet, row, col, .. }` (single cell).
6. Materializer: `RefArg::Reference { address }` → ISFORMULA queries `is_formula_at(address)`.

This path is structurally complete but untested. Same gap exists for ISREF: `=ISREF(@A1:A10)` should return TRUE (the `@`-narrowed result is a CellRef).

**Recommendation:** Add to Step 5 cross-cutting suite (per the deferral pattern from Step 2 S2-HIGH-1):

```rust
#[test]
fn isformula_implicit_intersection_narrows_to_anchor_row() {
    let mut wb = workbook_with_sheet();
    wb.put_formula(0, 4, 0, "1+2");  // A5 = formula.
    // Formula cell at row 4 (A5). @A1:A10 narrows to A5.
    let tokens = lex("@A1:A10").expect("lex");  // wrap with ISFORMULA: ISFORMULA(@A1:A10)
    // ... bind/eval at formula cell row 4 → ISFORMULA(@A1:A10) → checks A5 → TRUE.
}

#[test]
fn isref_implicit_intersection_narrows_to_anchor_returns_true() {
    // ISREF(@A1:A10) at any anchor → narrows to CellRef → PlanKind::CellRef → TRUE.
}
```

**Severity rationale:** MEDIUM because (a) the plan checklist enumerates this but doesn't specify which step owns it (Step 3 or Step 5); (b) the design § 7 cross-fn matrix lists implicit-intersection coverage explicitly; (c) the path is structurally complete but unexercised — first regression would be invisible. Same pattern as Step 2 S2-HIGH-1's structured-ref deferral.

---

### MEDIUM-S3-O-6 — No test for `ISFORMULA(<structured-ref>)`. The S1-HIGH-B / S2-HIGH-1 deferral of structured-ref tests to Step 5 doesn't fully apply to ISFORMULA — the eager-materializer's StructuredRef arm narrows via `narrow_structured_ref`, which behaves differently for `Sales[@Col]` (single-cell after narrowing) vs `Sales[Col]` (full column). ISFORMULA's single-cell path should query `is_formula_at`, multi-cell should return `#N/A`. The current impl is correct but unverified.

**Where:**
- Materializer: `crates/ql-exec/src/scalar.rs:609-619` (StructuredRef arm narrows + propagates narrow errors).
- ISFORMULA impl: `crates/ql-functions/src/reference_fns.rs:241-249` (1×1 range arm).
- Tests: zero matches for `StructuredRef`, `Sales[Qty]`, `@Sales[`, `table_lookup` in `reference_fns_step3_e2e.rs`.

**Detail:** Two paths:

1. `=ISFORMULA(Sales[@Qty])` where Sales is a table. The binder produces `ExprPlan::StructuredRef { resolved: full_col_range, is_this_row: true }`. The materializer's StructuredRef arm calls `narrow_structured_ref(resolved, true, env)` → returns a single-row range. `RefArg::Range { range: 1-row-range }`. **But the range may still be multi-COLUMN** (Sales[@Qty] is 1-row × 1-col if Qty is a single column). Need to verify the impl's 1×1 check (`range.start_row == range.end_row && range.start_col == range.end_col`) is satisfied for the typical narrow case.

2. `=ISFORMULA(Sales[Qty])` (full column, no `@`). `is_this_row: false`, `narrow_structured_ref` returns the range unchanged. Multi-cell range → `#N/A`. Correct.

The deferral in S2-HIGH-1 (structured-ref to Step 5 cross-cutting) is explicit, but the Step 3 ISFORMULA tests don't acknowledge this is deferred. The coverage entry says "covered by reference_fns unit tests (NoOpReferenceQuery FALSE path + arity + multi-cell #N/A + non-reference #N/A + error propagation) + ql-exec workbook-runtime e2e ..." — no mention of structured-ref deferral.

**Recommendation:** Either:

1. Add a Step 3.1 e2e for `ISFORMULA(Sales[@Qty])` happy path (single-cell narrowing) AND `ISFORMULA(Sales[Qty])` multi-cell `#N/A`.

2. Update the EXPLICITLY_DEFERRED entry to mention structured-ref coverage is deferred to Step 5.

**Severity rationale:** MEDIUM. Same pattern as Step 2 S2-HIGH-1 (structured-ref coverage gap). The materializer's StructuredRef arm has the narrow-error propagation path that's specifically used by `@Col` narrowing — untested for ISFORMULA, latent regression risk if the narrow path changes shape.

---

### MEDIUM-S3-O-7 — `ISFORMULA` test suite includes `isformula_of_named_cell_pointing_at_formula_returns_true` BUT the test uses `NamedTarget::Range(Range::new(0, 0, 0, 0, 0))` (1×1 range), NOT a true `NamedTarget::Cell(Address::new(0, 0, 0))`. The two paths are structurally different in the binder (`ResolvedName::Range` → `AggregateNameRef` vs `ResolvedName::Cell` → `CellRef`) and materializer (`Range { range: 1×1 }` vs `Reference { address }`). The test name is misleading; the test covers ONE of the two paths.

**Where:** `crates/ql-exec/tests/reference_fns_step3_e2e.rs:247-266`.

**Detail:** Same root cause as MEDIUM-S3-O-3 (doc-comment confuses Cell vs Range). The test exercises the 1×1-range path (which hits the ISFORMULA Range arm). The CellRef path (which hits the Reference arm) is not exercised. Net coverage is partial.

**Recommendation:** Either rename the test to clarify (e.g., `isformula_of_named_1x1_range_pointing_at_formula_returns_true`) AND add a sibling test for `NamedTarget::Cell` proper:

```rust
#[test]
fn isformula_of_named_cell_pointing_at_formula_returns_true() {
    let mut wb = workbook_with_sheet();
    wb.put_formula(0, 0, 0, "1+2");
    wb.set_name("MyCell", NamedTarget::Cell(Address::new(0, 0, 0))).unwrap();
    // ... bind/eval — expects TRUE via CellRef → Reference → is_formula_at path.
}
```

**Severity rationale:** MEDIUM. The test name is misleading (claims to cover a case it doesn't); the underlying coverage gap is a real path (`NamedTarget::Cell` materializer arm) that's the most natural way for end-users to write `=ISFORMULA(MyImportantCell)`.

---

### MEDIUM-S3-O-8 — No test for `ISFORMULA(<cell that was previously formula then overwritten with literal>)` — i.e., the `clear_formula` state transition. ISFORMULA should return FALSE after `clear_formula` removes the entry. Untested for v1.

**Where:**
- Storage path: `crates/ql-storage/src/workbook.rs:868-871` (`clear_formula`).
- Test files: zero matches for `clear_formula`, `put_value.*put_formula`, or state-transition tests.

**Detail:** Scenario: user types `=1+2` in A1 (formula stored). Later user types `5` in A1 (literal overwrites formula). The `set_value` path calls `clear_formula` to drop the entry from `formula_cells` (`workbook_runtime.rs:1351`). Subsequent `=ISFORMULA(A1)` should return FALSE.

This state transition is reachable but untested. The Step 3 e2e only tests:
- Formula cell → TRUE (put_formula sets it).
- Literal cell → FALSE (put on column, no formula).
- Blank cell → FALSE (nothing set).

Missing: post-`clear_formula` → FALSE.

**Recommendation:** Add to Step 3.1 closure:

```rust
#[test]
fn isformula_after_formula_cleared_returns_false() {
    let mut wb = workbook_with_sheet();
    wb.put_formula(0, 1, 1, "1+2");
    wb.clear_formula(0, 1, 1);  // formula removed.
    // ... ISFORMULA(B2) → FALSE.
}
```

**Severity rationale:** MEDIUM. State transitions are a natural failure mode (clear-formula bug → ISFORMULA returns TRUE on a cleared formula). Test infra is trivial (3 lines). Coverage gap noted by audit-discipline pattern: "edge state transitions need explicit tests".

---

### MEDIUM-S3-O-9 — Step 3 doesn't add a test for the `is_address_only_reference_fn` matcher's ISREF inclusion. The `dep_suppressed_reference_fns_match_design` test in `calcgraph_session.rs:1719` pins the matcher's contents, but no test verifies the END-TO-END walker behavior for `=ISREF(A1)` (i.e., that A1 does NOT register in `deps.cells`).

**Where:**
- Walker invariant pin: `crates/ql-exec/src/calcgraph_session.rs:1719-1742`.
- Walker integration tests: scattered in `calcgraph_session.rs` `tests` module, no specific `=ISREF(...)` dep extraction test.

**Detail:** The matcher test pins the **list of names** but doesn't verify that the walker actually invokes `walk_plan_for_address_only_deps` for ISREF. A future refactor could move the `if is_address_only_reference_fn(name) { ... }` check elsewhere or remove it entirely; the matcher-pin test would still pass while the dep-suppression silently broke.

A direct integration test would walk `ExprPlan::Function { name: "ISREF", args: [ExprPlan::CellRef { ... }] }` and assert `deps.cells.is_empty()`.

**Recommendation:** Add to Step 3.1 closure or Step 6 (final closure):

```rust
#[test]
fn isref_of_cellref_suppresses_value_deps() {
    let plan = ExprPlan::Function {
        name: Arc::from("ISREF"),
        args: vec![ExprPlan::CellRef { sheet: 0, row: 0, col: 0, abs_col: false, abs_row: false }],
    };
    let mut deps = FormulaDeps::default();
    walk_plan_for_deps(&plan, &mut deps);
    assert!(deps.cells.is_empty(),
        "ISREF should NOT register cell deps; deps.cells = {:?}", deps.cells);
    assert!(!deps.is_volatile, "ISREF of CellRef should NOT mark volatile");
}
```

**Severity rationale:** MEDIUM. The matcher pin catches typo drift but not behavior drift. The end-to-end walker test is the only way to verify the dep-suppression is wired correctly. Pattern signal: "matcher pins" and "behavior tests" are complementary; both should ship.

---

### MEDIUM-S3-O-10 — `ISFORMULA` impl's 1×1-range corner case uses `range.start_row == range.end_row && range.start_col == range.end_col` but doesn't account for `range.sheet` (the range carries a `sheet` field). For a 1×1 range, `range.sheet` is the sheet from the binder, NOT necessarily the calling formula's sheet. This is currently correct (the `is_formula_at` query uses `range.sheet`), but the doc-comment doesn't explain that cross-sheet 1×1 ranges DO query the correct sheet.

**Where:** `crates/ql-functions/src/reference_fns.rs:241-249`.

**Detail:** The 1×1 range arm:

```rust
[RefArg::Range { range, .. }]
    if range.start_row == range.end_row && range.start_col == range.end_col =>
{
    Value::Boolean(ctx.workbook.is_formula_at(
        range.sheet,
        range.start_row,
        range.start_col,
    ))
}
```

`range.sheet` is whatever the binder resolved. For `=ISFORMULA(NamedRangePointingAtSheet2.A1)` where the named range targets Sheet 2, `range.sheet = 1`. The query goes to sheet 1's `formula_cells`. Correct.

But the doc-comment at reference_fns.rs:218-224 doesn't enumerate the cross-sheet case for 1×1 ranges. The cross-sheet test exists (`isformula_cross_sheet_returns_correct_status`) but uses `S1!A1` (CellRef path, not 1×1-Range path). Cross-sheet 1×1-Range is untested.

**Recommendation:**

1. Add a Step 3.1 e2e test for `ISFORMULA(NamedRangeAcrossSheet1)` where the named range is `NamedTarget::Range(Range::new(1, 0, 0, 0, 0))` (1×1 on sheet 1).

2. Update the impl's doc-comment to enumerate the 1×1-cross-sheet case.

**Severity rationale:** MEDIUM. The path is correct but unverified; the test gap is real (zero coverage of cross-sheet 1×1 Range).

---

## LOW

### LOW-S3-O-1 — `materialize_ref_arg_lazy` doc-comment at scalar.rs:646-650 doesn't mention the volatile-fn / cache-pollution asymmetry that HIGH-S3-O-2 captures.

**Recommendation:** Add a "Step 3 (RT-V1-01) caveat" note: "Lazy materializer NEVER calls `eval_scalar_with_cache`, so no aggregate cache writes and no volatile re-firing. **But:** the dep walker for ISREF inherits the Eager-contract policy (shape-aware), so ISREF(NOW()) does still mark the formula volatile. See HIGH-S3-O-2 / calcgraph_session.rs for the asymmetry."

---

### LOW-S3-O-2 — `default_registry_has_expected_count` comment block at registry.rs:875-885 lists Step 3 fns as `ISREF + ISFORMULA = 2 — reference-tier information batch; ISREF uses LazyShape (first user-facing fn through that contract), ISFORMULA uses Eager + workbook ReferenceQuery::is_formula_at`. Accurate but the inline running-total at line 879 (`197 → 199`) doesn't explicitly add up — at-glance the reader has to do the math.

**Recommendation:** Add a `// 197 + 2 = 199` annotation. Minor doc clarity.

---

### LOW-S3-O-3 — `reference_fns.rs` test module re-imports `NO_OP_REFERENCE_QUERY` from `crate::reference_aware_fns` in the test helper functions (line 276). Trivial pattern but the `RefContext::new(...)` calls inside the helpers don't document that the no-op singleton means `ctx.workbook.is_formula_at(...)` always returns `false` in unit tests. The TRUE path of ISFORMULA is therefore unexercised at the unit-test level — only e2e tests exercise the TRUE path. The doc-comment at reference_fns.rs:773-775 mentions this but a comment in the test helper would be more discoverable.

**Recommendation:** Add a brief comment at the helper functions, e.g.:

```rust
fn ctx_no_cell<'a>() -> RefContext<'a> {
    // NoOpReferenceQuery → `ctx.workbook.is_formula_at` ALWAYS returns false.
    // Tests that assert ISFORMULA TRUE must use e2e setup with WorkbookEnv.
    RefContext::new(&DEFAULT_EVAL_CONTEXT, None, &NO_OP_REFERENCE_QUERY)
}
```

---

### LOW-S3-O-4 — `isref` doc-comment at reference_fns.rs:174-193 lists 9 examples; the test suite covers all 9 plus the cross-cutting defense-in-depth arms. But the example list doesn't include `ISREF(A1, B2) → #N/A` (arity > 1), which IS in the impl's `_` arm AND a test (`isref_arity_two_returns_na`). Doc-impl symmetry would add the arity-2 case.

**Recommendation:** Add `- `ISREF(A1, B2)` → `#N/A` (arity).` to the example list, matching the test.

---

### LOW-S3-O-5 — `isformula` doc-comment at reference_fns.rs:212-231 says "Microsoft 2024" for the `#N/A` divergence claim. Should be a citation link (URL to support.microsoft.com docs) or stated as IronCalc / LibreOffice cross-check origin instead of bare year.

**Recommendation:** Either drop the citation OR add the URL: `support.microsoft.com/en-us/office/isformula-function-...`.

---

### LOW-S3-O-6 — `isref_of_function_call_returns_false_v1_scope` uses `SUM(1, 2)` to avoid the S1-MED-γ AggregateArg defer. Comment explains this. But the test name doesn't make the workaround visible. A future reader might think "why not use SUM(A1:A3)? That's the more natural test."

**Recommendation:** Either rename to `isref_of_scalar_arg_function_call_returns_false_v1_scope` OR add a multi-line doc-comment above the test linking to S1-MED-γ explicitly.

---

### LOW-S3-O-7 — `isref_of_named_range_returns_true` uses a 10×1 range. The same path (`AggregateNameRef` → `PlanKind::RangeRef` → TRUE) would also handle a 1×1 range, a whole-column, etc. No coverage of the variant shapes. Minor.

**Recommendation:** Optional Step 3.1: add a parameterized test or table-driven enumeration covering 1×1 / 1×10 / 10×10 / whole-column named ranges.

---

### LOW-S3-O-8 — `isformula_cross_sheet_returns_correct_status` only tests the TRUE case (cross-sheet formula cell). The corresponding FALSE case (cross-sheet literal cell) is missing.

**Recommendation:** Add `isformula_cross_sheet_literal_cell_returns_false` for symmetry.

---

### LOW-S3-O-9 — `isref_arity_zero_returns_na` and `isref_arity_two_returns_na` exist as unit + e2e tests. But ISFORMULA's symmetric cases `isformula_arity_zero_returns_na` / `isformula_arity_two_returns_na` only exist at unit level — wait, e2e ARE present. Verified. No issue. Leaving the finding in place to confirm coverage.

(Withdrawn after verification — actually present.)

---

### LOW-S3-O-10 — `excel-matrix.md` ISFORMULA row description says "Multi-cell range → `#N/A` (Microsoft canon; IronCalc returns `#VALUE!` divergence documented)." But "documented divergence" doesn't link to where. Step 3 design doc § 2.4 + impl doc-comment both describe it, but matrix readers won't find them.

**Recommendation:** Add doc URLs: `(see design 2026-05-17 § 2.4)`.

---

### LOW-S3-O-11 — `coverage.rs` ISREF entry says "covered by reference_fns unit tests (each PlanKind variant + arity + defensive Eager arms)". The unit tests do NOT cover ALL PlanKind variants explicitly — they cover `CellRef`, `RangeRef`, `Function { returns_reference: true/false }`, `Literal`, `Error`. That's 5 of 5 PlanKind variants. Verified. Leaving the finding in place but reduce-by-merging into LOW-S3-O-10 cluster.

(Verified: actual coverage matches the claim. Withdraw.)

---

### LOW-S3-O-12 — `materialize_ref_arg_lazy` Function arm hardcodes `returns_reference: false`. The doc-comment at scalar.rs:658-663 documents this. But the future-compat hook isn't elaborated: when reference-returning fns (OFFSET / INDIRECT) ship, this site is the single point of change. A `TODO(rt-v2)` marker would make the migration target visible.

**Recommendation:** Add `// TODO(rt-v2): when OFFSET/INDIRECT register as reference-returning, look up `returns_reference` from the registry here.` to scalar.rs:661.

---

### LOW-S3-O-13 — `isformula` impl has a 1×1-range arm that mirrors the design's pseudo-code. The pseudo-code at design § 5.6 says "if range.start_row == range.end_row && range.start_col == range.end_col"; the impl matches. But the design's pseudo-code uses the `if` guard syntax — the impl uses the same. Cross-check OK. No finding (withdraw).

---

## Cross-cutting pattern signals (Step 3 cycle)

1. **Step 2.1 closure introduced HIGH-S3-O-1 regression that was invisible until Step 3.** The Step 2 audit's HIGH-S2-O-2 fix conflated two error sources (CellRef-from-Expr::Error vs CellRef-from-stored-error-overlay). Step 3's ISFORMULA registration made the regression user-visible. **Pattern signal:** closure rationale should explicitly enumerate ALL error sources that reach the modified arm; "mirror the fallthrough" is insufficient when the fallthrough handles a different class of inputs.

2. **LazyShape contract introduces a new walker asymmetry (HIGH-S3-O-2).** The Step 1.1 walker policy was designed assuming Eager contract for all address-only fns. ISREF (LazyShape, in the address-only list) creates an asymmetry that wasn't anticipated. **Pattern signal:** when adding a new `ArgContract` variant, audit ALL walker / dispatcher / materializer policy tables for asymmetries vs the existing variant.

3. **Plan-checklist coverage gaps recur (HIGH-S3-O-3).** Step 2 had the same pattern (S2-HIGH-1: 8 categories listed in plan, 5 shipped). Step 3 ships 7 of 8 categories (missing: volatile-fn / cache-pollution instrumented tests for ISREF — the SINGLE most important contract for LazyShape). **Pattern signal:** before checking a plan item complete, do a deliberate grep across the test tree for EACH listed category and document deferrals explicitly with rationale (Step 1.1 deferred 8 LOWs with written reasons — that pattern works; copy to checklist items).

4. **Coverage-report wording overclaims (HIGH-S3-O-4).** Step 2 had the same pattern (S2-MED-δ: EXPLICITLY_DEFERRED overclaim). Step 3's new entries say "workbook-runtime e2e" but the actual tests don't use WorkbookRuntime. **Pattern signal:** when writing coverage-report entries, copy the actual test names + setup pattern verbatim into the entry, not a paraphrase.

5. **Defensive arms vs design pseudo-code (MEDIUM-S3-O-2).** Step 3's impl adds defense-in-depth arms not in the design's pseudo-code. Behavior may silently diverge from spec. **Pattern signal:** "defense-in-depth" arms should be either (a) provably equivalent to the `_` arm OR (b) explicitly documented as design divergence.

6. **Test names that describe wrong path (MEDIUM-S3-O-7).** `isformula_of_named_cell_pointing_at_formula_returns_true` actually tests `NamedTarget::Range`, not `NamedTarget::Cell`. **Pattern signal:** test names should describe the EXACT plan-shape path being exercised, not the user-visible mental model. (Reader: "where's the test for NamedTarget::Cell?" → grep returns this test → false confidence.)

7. **State transitions go untested (MEDIUM-S3-O-8).** `clear_formula` → ISFORMULA FALSE is unverified. **Pattern signal:** when a fn queries mutable storage state, enumerate the storage state transitions explicitly and ship at least one test per transition.

---

## Recommendations summary

**Must close before Step 4:** HIGH-S3-O-1, HIGH-S3-O-2 (at minimum the doc note), HIGH-S3-O-3 (one instrumented test), HIGH-S3-O-4 (one workbook-runtime test + coverage wording fix).

**Should close in Step 3.1:** MEDIUM-S3-O-1 through O-10, especially O-1 (one-line disjointness fix), O-3 (doc + test), O-4 (count update), O-7 (test rename or add sibling), O-8 (state-transition test).

**Defer to Step 4 / Step 6 polish:** LOW-S3-O-1 through O-13 (documentation polish).

**Open architectural question for follow-up:** the materializer's CellRef arm — drop the `value` field (closes wasted-CPU + HIGH-S3-O-1 in one ABI change) OR keep + skip the read (preserves field for forward compat). Decision deferred but tracked.

---

## Net state assessment

The Step 3 implementation is **structurally sound**: the LazyShape contract is correctly wired (the critical `ISREF(1/0) → FALSE` test passes), ISFORMULA's eager + ReferenceQuery integration works (cross-sheet TRUE confirmed), the e2e suite covers most variants, the registry count math is right (197 → 199), and the invariant tests catch typos in the matcher / disjointness.

The findings concentrate in:

- **Inherited regression** (HIGH-S3-O-1) — Step 2.1's "fix" exposed Step 3's bug surface for the first time. Reachable via any formula cell that evaluated to error.
- **New asymmetry** introduced by LazyShape contract (HIGH-S3-O-2) — walker policy assumes Eager but ISREF skips eval.
- **Coverage gaps** for the load-bearing LazyShape no-eval contract (HIGH-S3-O-3, HIGH-S3-O-4, MEDIUM-S3-O-5/6/7/8/9/10) — the contract that ISREF establishes is the FIRST user-facing LazyShape; its invariants need direct (instrumented) coverage, not just behavioral proxies.
- **Doc-impl drift** (MEDIUM-S3-O-2/3/7, several LOWs) — recurring pattern from Steps 1/2.

Pre-Step-3 audit was due per the audit-discipline rule; the rule earned its keep this cycle by surfacing the inherited HIGH-S3-O-1 + the new HIGH-S3-O-2 asymmetry that neither the Step 1.1 nor Step 2.1 closures anticipated.

---

**Final tally:** 4 HIGH + 10 MEDIUM + 13 LOW = **27 findings** (after withdrawing LOW-S3-O-9, LOW-S3-O-11, LOW-S3-O-13: net **4 HIGH + 10 MEDIUM + 10 LOW = 24 findings**).
