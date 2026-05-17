# Reference-tier Step 1 — separate-Opus audit

**Date:** 2026-05-17
**Subject:** Step 1 infrastructure commit (working-tree, pre-commit) of the reference-tier mini-phase.
**Auditor:** separate-Opus (4.7, 1M-context), independent of the parallel Codex audit running concurrently.
**HEAD baseline:** `8f9b37b5d6d`. Test count: 3082 → 3090 (+8). All four gates reported green.
**Design doc:** `docs/architecture/2026-05-17-reference-tier-design.md` v2.
**Pre-review reconciliation:** `docs/audits/2026-05-17-reference-tier-pre-review-summary.md`.
**Plan:** `.plans/_active.md` § Phase 1.

## Audit scope

Files read end-to-end (or all relevant sections):

- **NEW:** `crates/ql-functions/src/reference_aware_fns.rs` (305 lines).
- `crates/ql-functions/src/lib.rs` (re-exports).
- `crates/ql-functions/src/registry.rs` (lines 1-410, 791-855, 999-1023 — `RegisteredFn::ReferenceAware`, `register_reference_aware`, lookup, names iterators, count-test).
- `crates/ql-exec/src/plan.rs` (lines 100-170, 350-509, 632-735, 1055-1180, 1620-1675 — `ExprPlan::RangeRef`, `BindContext::ReferenceArg`, `is_reference_aware_function`, `Expr::RangeRef` binder arm, narrow_range_for_implicit_intersection, resolve_range_ref_to_range).
- `crates/ql-exec/src/scalar.rs` (lines 50-110, 140-505, 539-640, 690-840 — both eval entry points, materializer helpers, cell-boundary guard).
- `crates/ql-exec/src/calcgraph_session.rs` (lines 140-350, 660-700 — `is_dep_suppressed_reference_fn`, walker, dep registration).
- `crates/ql-exec/src/env.rs` (lines 1-320, 452-620 — CellEnv trait, WorkbookEnv, ReferenceQuery impl, MapEnv).
- `crates/ql-exec/src/workbook_runtime.rs` (lines 555-625, 5150-5240 — set_formula canonicalization path + the `is_aggregate_function_lists_only_registered_aggregates` invariant test).
- `crates/ql-functions/tests/coverage.rs` (lines 60-160, 575-650).
- `crates/ql-storage/src/workbook.rs` (lines 800-895 — put_formula + formula_at).
- Crate-graph spot-check: `ql-storage/Cargo.toml`, `ql-functions/Cargo.toml`.

## Findings — final dispositions

**Tally:** 3 HIGH + 8 MEDIUM + 9 LOW = **20 findings.**

Per the audit-discipline rule ("don't stop at 2-3 findings; surface every concern"), I have included even low-impact items. Concerns where I am uncertain are flagged as LOW with the uncertainty noted.

---

## HIGH

### HIGH-O-1 — `is_reference_aware_function` invariant test promised in doc-comment but never delivered.

**Where:** `crates/ql-exec/src/plan.rs:492-496`.

```rust
/// Pinned via the `accepts_special_arg_lists_only_registered_reference_aware`
/// invariant test (added in this commit). v1 always returns false until the
/// 7 reference-aware fns are registered in Step 2 / 3 / 4 — that ordering
/// is intentional: Step 1 ships the infrastructure with no user-facing fn
/// dispatching through it, gates green.
pub(crate) fn is_reference_aware_function(name: &str) -> bool {
```

**Detail:** the doc comment for `is_reference_aware_function` explicitly states the matcher is "Pinned via the `accepts_special_arg_lists_only_registered_reference_aware` invariant test (added in this commit)". I `grep -r`ed the entire `crates/` tree for that test name — **the test does not exist.** No invariant test cross-checks the seven names ROW/COLUMN/ROWS/COLUMNS/ISREF/ISFORMULA/FORMULATEXT against `FunctionRegistry::lookup_reference_aware`. The doc claim is a forward reference to work that wasn't done in this commit.

This means:

1. A typo in `is_reference_aware_function` (e.g., listing `"RAW"` instead of `"ROW"`) would not be caught at test time. The pattern that the design's HIGH-G closure cared about — drift between the binder's hardcoded matcher and the registry — is replicated here for the new tier without the matching invariant test.
2. The doc comment is itself a falsehood. Per the no-fallbacks rule, doc lies are a form of silent state.
3. Plan file line 68 ("Extend `accepts_special_arg_lists_only_registered_fns` (was `is_aggregate_function_lists_only...`) for the new tier") is unchecked but the work to support it didn't ship either (see HIGH-O-2 + MEDIUM-O-1).

**Recommendation:** before Step 2 lands the registration of the 7 fns, add an invariant test of this exact form (skeleton — adapt names to match `default_registry` setup):

```rust
#[test]
fn accepts_special_arg_lists_only_registered_reference_aware() {
    let reg = default_registry();
    // After Step 2/3/4, all seven must be registered.
    for name in &["ROW", "COLUMN", "ROWS", "COLUMNS", "ISREF", "ISFORMULA", "FORMULATEXT"] {
        assert!(
            reg.lookup_reference_aware(name).is_some(),
            "is_reference_aware_function lists {name:?} but it's not registered \
             in default_registry's reference-aware tier"
        );
        assert!(
            reg.lookup(name).is_none(),
            "{name:?} is reference-aware ONLY; must not appear in the scalar table"
        );
        assert!(
            reg.lookup_range_aware(name).is_none(),
            "{name:?} is reference-aware ONLY; must not appear in the range-aware table"
        );
        assert!(
            reg.lookup_unified(name).is_none(),
            "{name:?} is reference-aware ONLY; must not appear in the unified table"
        );
    }
}
```

At Step 1 (no fns registered), the test would have to be marked `#[ignore]` with a comment, OR (better) check the OTHER direction — every name in `reg.reference_aware_names()` is also recognized by `is_reference_aware_function`. The second formulation is non-trivially useful even at Step 1: it pins the dispatcher/binder/matcher relationship without depending on registration ordering.

Alternatively, fix the doc comment to say "**will be** pinned via … added in Step 2" rather than "added in this commit". But the doc comment IS load-bearing — it advertises a safety net that doesn't exist. The post-Step-2 invariant test is the right fix.

**Severity rationale:** HIGH because the design's HIGH-G closure was specifically about preventing exactly this kind of drift, and the implementation re-introduced the gap. The plan checklist (line 68) explicitly called for it. Failing to ship invariant tests with the data they're meant to pin is a known load-bearing pattern in this codebase.

---

### HIGH-O-2 — Step 1 deviates from design § 5.4 / § 6 Step 1 on `is_aggregate_function` rename + extension, without updating the design doc.

**Where:** the design v2 § 5.4.A + design v2 § 6 Step 1 (`docs/architecture/2026-05-17-reference-tier-design.md`) AND `crates/ql-exec/src/plan.rs:383-502` AND `.plans/_active.md:55,68`.

**Detail:** The design v2 § 5.4.A is unambiguous about the rename and invariant-test extension:

> Rename to `accepts_special_arg_at_bind(name) -> bool`. The `is_aggregate_function_lists_only_registered_aggregates` invariant test (workbook_runtime.rs:5158-5212) extends with a third loop checking `reg.lookup_reference_aware(name).is_some()` for the new names; the test renames to `accepts_special_arg_lists_only_registered_fns`.
>
> **Step 1 commit bundles: matcher rename + invariant-test rename + extension + reference-tier name addition. Gates green or Step 1 doesn't ship.**

Design § 6 Step 1 echoes:

> Rename `is_aggregate_function` → `accepts_special_arg_at_bind`. Add reference-tier names. Extend the invariant test to recognize `lookup_reference_aware` (per HIGH-G).

The plan file mirrors this in checklist items at `.plans/_active.md:55` and `:68`.

**What actually shipped:**

- `is_aggregate_function` is **not** renamed (still `is_aggregate_function` at plan.rs:401).
- Reference-tier names are **not** added to `is_aggregate_function`; instead a parallel matcher `is_reference_aware_function` was added (plan.rs:497).
- The invariant test is **not** renamed and **not** extended (workbook_runtime.rs:5158-5239 unchanged).
- The design doc was **not** updated to reflect the parallel-matcher decision.

The parallel-matcher approach is arguably cleaner than what the design specified (it gives clean separation between the two binder-context families and avoids forcing the existing 35-entry `is_aggregate_function` test loops to grow a third tier-shape branch). But the deviation is undocumented and the plan checklist for this step is now wrong — items 55 and 68 are formally not closeable as written.

The doc-comment at plan.rs:365 also still references the old design (mentions `accepts_special_arg_at_bind` for the `AggregateArg` variant), creating a documentation/implementation mismatch (see LOW-O-3).

**Recommendation:** pick one path and commit to it before Step 2 audit:

1. **Path A (match design):** rename `is_aggregate_function` → `accepts_special_arg_at_bind`, fold the reference-tier names into it, extend the invariant test as the design specified.
2. **Path B (keep parallel matcher):** update the design v2 doc § 5.4.A and § 6 Step 1 to specify the parallel-matcher approach, mark `.plans/_active.md:55` and `:68` as superseded, and add the missing invariant test (HIGH-O-1) for the parallel matcher.

Either path is acceptable; the unacceptable state is "the design says A, the code does B, no doc update reconciles them, and the invariant test for either is missing." Without resolution, the plan checklist drifts further from reality every subsequent step.

**Severity rationale:** HIGH because the design v2 doc is the canonical contract for this mini-phase. Codex+Opus pre-review closed eight HIGH and nine MEDIUM findings to produce v2; mid-flight deviating from v2 without updating it negates the pre-review's value. Also bundles HIGH-O-1's missing invariant — same area, same root cause.

---

### HIGH-O-3 — `materialize_ref_arg_eager` eagerly evaluates `ExprPlan::Function` args, leaking volatile re-firing and cache writes into reference-tier dispatch.

**Where:** `crates/ql-exec/src/scalar.rs:603-609`.

```rust
ExprPlan::Error(ev) => RefArg::Error(*ev),
other => {
    let v = eval_scalar_with_cache(other, env, registry, cache);
    match v {
        Value::Error(ev) => RefArg::Error(ev),
        ok => RefArg::Scalar(ok),
    }
}
```

**Detail:** the eager materializer's `other` arm falls through every plan variant not explicitly listed — including `ExprPlan::Function { .. }`. This means `ROW(NOW())` (or any Eager-contract reference-aware fn with a Function arg) **does** evaluate the inner function call:

1. **Volatile fns re-fire.** `ROW(NOW())` calls `eval_scalar_with_cache(NOW(), ...)` every dispatcher pass. `NOW()` is registered as `RegisteredFn::ContextAware` and re-fires per call.
2. **Aggregate cache writes happen.** `ROW(SUM(NamedRange))` triggers the aggregate cache `store_aggregate` at scalar.rs:362 just as if SUM were called directly.
3. **Volatile dep tracking is suppressed at the walker level (is_dep_suppressed_reference_fn).** So `=ROW(NOW())` is NOT marked volatile (walker skips args). The formula won't re-compute on volatile cycles even though NOW IS evaluated on each pass through it. Result: the volatile-fn evaluation is genuinely wasted CPU — its output is consumed only to be coerced to `#VALUE!` (since ROW expects a Reference / Range / Array, not a Scalar).

For the v1 cohort (ROW, COLUMN, ROWS, COLUMNS, ISFORMULA, FORMULATEXT), this is wasted-work-not-wrong-result: the eager eval produces `RefArg::Scalar(...)` or `RefArg::Error(...)`, and every per-fn impl rejects with `#VALUE!` or `#N/A`. So output correctness is preserved.

However, the design v2 § 5.3 dep-tracking policy text said:

> ROW / COLUMN / ROWS / COLUMNS / ISREF: dep-SUPPRESS. The walker recognizes these fn names and does NOT recurse into their args. **No value-deps registered. The result depends only on the address/syntactic-shape** — neither changes without an explicit structural event…

The "result depends only on the address/syntactic-shape" rationale is the truth-condition for the dep-suppress: structural-only dependency. But the **runtime** still evaluates Function args eagerly. This is an asymmetry: the dep-walker assumes Function args don't affect the result; the runtime evaluates them anyway. The mismatch creates wasted CPU AND a subtle correctness footgun: if a future reference-aware fn (e.g., a hypothetical `INDIRECT_REF`) was added with Eager contract that genuinely depended on the Function arg's *value*, the dep-suppress walker would NOT track it.

**Lower-impact related concern:** the `materialize_ref_arg_eager` calls `eval_scalar_with_cache` instead of skipping eval for non-reference args. The design v2 § 5.3 materializer pseudocode (lines 357-363) does the same thing, so the implementation matches the design. But the design didn't reckon with the volatile re-firing under suppressed deps.

**Recommendation (two-fold):**

1. **Documentation in this commit:** add a comment to `materialize_ref_arg_eager` (or to `is_dep_suppressed_reference_fn`) explicitly noting "eager materializer evaluates Function args; dep walker suppresses recursion for ROW/COLUMN/ROWS/COLUMNS. This is asymmetric — wasted CPU under volatile Function args is the acceptable v1 cost. If a future reference-aware Eager-contract fn genuinely needs Function-arg values to inform its result, REVISIT THIS DECISION (the dep-walker would silently miss the dep)."
2. **Step 2 follow-up:** add a defensive test once ROW is registered: `=ROW(NOW())` does NOT change between recompute cycles (deterministically returns `#VALUE!` because NOW returns a Number, which is not a Reference). This locks in the wasted-but-correct contract.

**Severity rationale:** HIGH because the asymmetry is invisible without reading both files side-by-side AND because the design didn't flag it. Future tier additions (LAMBDA / fn-as-arg) will trip over this same boundary unless it's documented now. The actual *wasted-CPU* portion is acceptable v1 cost; the *missing documentation* is what I'm rating HIGH.

---

## MEDIUM

### MEDIUM-O-1 — `is_aggregate_function_lists_only_registered_aggregates` test extension never delivered; will not catch a typo in the new `is_reference_aware_function` matcher.

**Where:** `crates/ql-exec/src/workbook_runtime.rs:5158-5239`.

**Detail:** sibling to HIGH-O-1 + HIGH-O-2 with a different framing. The existing invariant test iterates Scalar / RangeAware / Unified tier lookups for the names in `is_aggregate_function`. Per the design § 5.4.A (HIGH-G closure), Step 1 was to extend it with a third loop iterating `lookup_reference_aware` for the new tier. That extension shipped neither here nor in a sibling test.

Result: a typo in `is_reference_aware_function` (e.g., listing `"ROWCOUNT"` or misspelling `"FORMULATEXT"` as `"FORMULATXT"`) WILL pass the test suite. The HIGH-G closure was specifically about this hazard.

**Recommendation:** see HIGH-O-1 — the same invariant test addresses this concern. Tracking as MEDIUM rather than HIGH because the immediate impact at Step 1 (no fns registered) is doc-comment falsehood, not behavior; behavior-level impact arrives at Step 2 onwards.

**Severity rationale:** the design's HIGH-G closure framing is HIGH-severity in pre-review terms; downgraded to MEDIUM here because the LOOP-IS-EMPTY situation at Step 1 doesn't actually break anything until Step 2 fires. But the missing test is what makes the deviation in HIGH-O-2 a load-bearing concern; treat MEDIUM-O-1 and HIGH-O-1/HIGH-O-2 as joint.

---

### MEDIUM-O-2 — `materialize_ref_arg_eager` may evaluate `ExprPlan::Array` args repeatedly when Step 2 ROW/COLUMN/ROWS/COLUMNS spans multiple arg positions.

**Where:** `crates/ql-exec/src/scalar.rs:587-601`.

```rust
ExprPlan::Array(rows) => {
    let row_count = rows.len() as u32;
    let col_count = rows.first().map(|r| r.len()).unwrap_or(0) as u32;
    let mut cells: Vec<Value> = Vec::with_capacity((row_count * col_count) as usize);
    for row in rows {
        for cell in row {
            cells.push(eval_scalar_with_cache(cell, env, registry, cache));
        }
    }
    let av = ArrayValue::new(row_count, col_count, cells)
        .expect("ExprPlan::Array passed binder validation; shape intact");
    RefArg::Array(av)
}
```

**Detail:** the materializer evaluates every cell of the array literal even when the consuming fn (ROWS/COLUMNS) only needs the SHAPE — `ArrayValue::shape()`. The design v2 § 2.2 / § 5.3 advertises coordinate-only materialization for Range args (which it does, correctly), but for Array literals it materializes values. ROWS/COLUMNS over a 100×100 array literal will eval 10,000 cells just to return `100`.

For Step 1, this is irrelevant (no fns registered). For Step 2 (`ROWS({...})`), each call evaluates the entire array.

The binder restriction at `Expr::Array` (plan.rs:766-784) limits array cells to Number/Bool/String/Error — pure literals. So the eval cost is `O(cells)` of `eval_scalar_with_cache` calls each of which trivially returns the literal value. Not 10,000× cell-reads; just 10,000× function-call overhead. Still wasted but minor.

**Recommendation:** for Step 2 / Step 3 ROWS/COLUMNS specifically, consider whether the materializer can skip cell eval for `RefArg::Array` when the consumer only needs `.shape()`. The cleanest fix would be a `RefArg::Array { shape: (u32, u32), values: Option<ArrayValue> }` shape — but that breaks the ABI prematurely. For now, document the wasted-work as an acceptable v1 cost.

Alternatively, the design's `ArrayValue` constructor invariant requires `cells.len() == rows * cols`, so the shape can't be carried without the values via the current `ArrayValue` API. Leaving as-is is reasonable.

**Severity rationale:** MEDIUM because the wasted work is real but bounded by binder restriction (only literals in array cells, so eval is cheap). LOW would also be defensible.

---

### MEDIUM-O-3 — `materialize_ref_arg_eager`'s `ExprPlan::AggregateNameRef` arm bypasses `read_range_with_shape`, but a future iterating reference-aware fn would need values.

**Where:** `crates/ql-exec/src/scalar.rs:568-575`.

```rust
ExprPlan::AggregateNameRef { range, .. } => RefArg::Range {
    range: *range,
    values: vec![],
},
ExprPlan::RangeRef { range } => RefArg::Range {
    range: *range,
    values: vec![],
},
```

**Detail:** the materializer hands these to `RefArg::Range { range, values: vec![] }` — coordinate-only path per the design v2 § 5.3 MEDIUM-γ closure. ROWS/COLUMNS / ROW/COLUMN read only `range.start_row` / `range.end_row` / `range.start_col` / `range.end_col`, so empty `values` is correct for them.

But the doc-comment in reference_aware_fns.rs:42-44 says:

> `values` may be empty when the consumer only needs metadata (ROWS/COLUMNS coordinate-only path); populated when the consumer iterates (none in v1).

The "populated when the consumer iterates" promise is **not implemented** — there's no path that populates `values`. A future iterating reference-aware fn (e.g., an SUMIFREF-style aggregator) would silently see empty values. The single materializer can't tell which consumer wants values vs not, because `ArgContract` only has Eager / LazyShape — it can't express "Eager with coordinate-only Range" vs "Eager with materialized Range".

This is a latent v2 hazard but not a Step 1 defect. Documented in design § 4.A as trigger 3 for D1 migration.

**Recommendation:** add an assertion or `debug_assert!` in the per-fn impls of ROW/ROWS/COLUMN/COLUMNS — `assert!(values.is_empty())` — so a future-misuse that DOES populate values surfaces loudly. Or, better: drop the `values` field from `RefArg::Range` entirely until the day a consumer needs it. The current shape is mis-specified for v1 (a single empty vec carried around for no reason).

Note that `Vec::with_capacity(0)` is effectively a small zero-overhead sentinel; the cost is more conceptual ("what does this empty vec mean?") than runtime.

**Severity rationale:** MEDIUM because the doc-comment promises a contract the code can't honor without ArgContract migration. If left undocumented, a Step-N+ contributor adding the first iterating reference-aware fn will misread the comment.

---

### MEDIUM-O-4 — `Workbook` does not directly impl `ReferenceQuery` per design § 5.5; the impl moved to `WorkbookEnv` with no design-doc update.

**Where:** `crates/ql-exec/src/env.rs:303-320` AND design v2 § 5.5.

**Detail:** the design v2 § 5.5 pseudo-code shows:

```rust
impl ReferenceQuery for ql_storage::Workbook {
    fn is_formula_at(&self, s: SheetId, r: RowId, c: ColId) -> bool { ... }
    fn formula_text_at(&self, s: SheetId, r: RowId, c: ColId) -> Option<String> { ... }
}
```

The implementation puts the impl on `WorkbookEnv<'w>` instead, in `ql-exec/src/env.rs`. The rationale (which I infer): `ReferenceQuery` is defined in `ql-functions`; impl-ing it on `ql_storage::Workbook` would force `ql-storage` to depend on `ql-functions`. Currently `ql-storage` depends only on `ql-types`, and `ql-functions` doesn't depend on `ql-storage`. Adding `ql-storage → ql-functions` would not create a cycle, but it would add a graph edge.

The implementation's chosen path (impl on WorkbookEnv inside ql-exec, which already depends on both) avoids the new edge. This is a clean engineering deviation. But:

1. The design doc was not updated.
2. The plan checklist (line 65) says "**ql-storage / Workbook**: `impl ReferenceQuery for Workbook` returning canonicalized formula text WITH leading `=`." That is unchecked but the work shipped on the WorkbookEnv side.

**Recommendation:** update the design v2 § 5.5 pseudo-code to reflect `impl ReferenceQuery for WorkbookEnv` and explain the crate-graph rationale. Update plan line 65 to reflect "impl on WorkbookEnv (avoid ql-storage→ql-functions edge)".

**Severity rationale:** MEDIUM because the design-doc is the contract; not updating it leaves the next reader (next-session contributor / future auditor) puzzled. The technical decision is right; the documentation lag is what I'm flagging.

---

### MEDIUM-O-5 — Design v2 § 5.4 / § 6 Step 1 call for `BindContext::AggregateArg` + `BindContext::ReferenceArg` both accepting literal `Expr::RangeRef`. Implementation accepts ONLY `ReferenceArg`.

**Where:** `crates/ql-exec/src/plan.rs:685-710`.

```rust
Expr::RangeRef(rr) => {
    // ...
    if ctx == BindContext::ReferenceArg {
        let range = resolve_range_ref_to_range(rr, owning_sheet, sheets)?;
        Ok(ExprPlan::RangeRef { range })
    } else {
        Err(BindError::UnsupportedVariant(
            "literal RangeRef in non-Function context is unsupported in v1; \
             use a named range (Phase 2B.4 AggregateNameRef) or wrap in an \
             aggregate function. (Updated W5-108 / Phase 4.7.O; original \
             ... W5-RT-1 added literal RangeRef support inside reference-aware \
             fn arg lists only.)",
        ))
    }
}
```

**Detail:** the design v2 § 5.4 explicitly states:

> Lower to a new `ExprPlan::RangeRef { range }` variant; extend the `Expr::RangeRef` binder arm to lower to it when:
>
> - `BindContext::AggregateArg` — supports `SUM(A1:B3)` literal-range (closes a long-standing W5-X gap as a side-effect, not core scope here).
> - `BindContext::ReferenceArg` (NEW context flag) — used inside reference-tier fn arg positions.

And design § 6 Step 1:

> Extend the `Expr::RangeRef` binder arm to accept `BindContext::AggregateArg | BindContext::ReferenceArg`.

The implementation accepts only `ReferenceArg`. The doc-comment in the implementation acknowledges this:

> AggregateArg-side enabling (which would let `SUM(A1:B3)` bind) is deferred: every Scalar/RangeAware/Unified dispatcher arm would also need new `ExprPlan::RangeRef` handling, which is out of scope for the reference-tier mini-phase. Tracked as a follow-up in the design doc § 5.4.

The implementation's deferral rationale is sensible (the AggregateArg-side enabling would need parallel work in the scalar.rs RangeAware/Unified dispatcher arms to consume `ExprPlan::RangeRef` properly), but it's a deviation from the design v2 § 5.4 + § 6 Step 1 that wasn't reconciled. The design said both contexts; the implementation does one.

**Recommendation:** update design v2 § 5.4 + § 6 Step 1 to mark the `BindContext::AggregateArg` extension as **deferred to a follow-up** with the rationale stated in the binder doc comment. Add a tracker (e.g. "RT-V1 follow-up: AggregateArg literal-range support, requires new arms in the scalar dispatcher's RangeAware/Unified paths").

Alternatively, ship the design's full version in Step 1 if it doesn't risk gates. Given the implementation deferred for a documented reason, the right outcome is doc reconciliation, not code change.

**Severity rationale:** MEDIUM. The current behavior is a documented v1 scope, but the design doc itself says BOTH contexts should be supported in Step 1 — so the gap is design-doc-vs-implementation drift, not a v1 scope choice.

---

### MEDIUM-O-6 — `ExprPlan::RangeRef` injects synthetic `__rt_literal_range__` into the public `FormulaDeps.named_ranges` field, leaking a private marker through a public surface.

**Where:** `crates/ql-exec/src/calcgraph_session.rs:282-295`.

```rust
ExprPlan::RangeRef { range } => {
    // Push as an unnamed range dep. We reuse the named_ranges
    // vec since the calcgraph stripe-index reads only the
    // `Range` payload; the name slot carries a synthetic
    // marker so the reverse-index doesn't choke on Arc::clone.
    // ...
    let synthetic_name: Arc<str> = Arc::from("__rt_literal_range__");
    deps.named_ranges.push((synthetic_name, *range));
}
```

**Detail:** `FormulaDeps.named_ranges` is a `pub` field on a `pub` struct (calcgraph_session.rs:193-214), exposed via `CalcgraphSession::formula_deps(node) -> Option<&FormulaDeps>` at line 508. Downstream consumers can iterate `deps.named_ranges` and read `name.as_ref()`. Today, the synthetic marker appears as `"__rt_literal_range__"` — a fake name with no corresponding entry in the workbook's `NameTable`.

Concretely:

1. The current code path safely ignores the name (the stripe-index registration at line 667 uses only the range payload).
2. The dedup pass at line 625 *intentionally* skips `named_ranges` dedup (because two SUM args for the same named range are legitimate). Two RangeRef args with the same range would produce TWO entries with the same synthetic name — also fine, just minor duplication.
3. BUT: any future caller that consumes `formula_deps(node).named_ranges` expecting tuples to correspond to real workbook names (e.g., a "show me the dep graph for this formula" diagnostic) will see the leaked marker.
4. The marker COULD collide with a user-defined name `__rt_literal_range__` — Excel allows names with underscores. The collision is benign for the stripe-index but creates ambiguity for diagnostics.

Two cleaner alternatives:

- **Alternative A:** add a `FormulaDeps.literal_ranges: Vec<Range>` field separate from `named_ranges`. The walker pushes there; downstream stripe-index registration iterates both fields.
- **Alternative B:** change `FormulaDeps.named_ranges` to `Vec<(Option<Arc<str>>, Range)>` — None for literal ranges, Some for named.

Either would eliminate the synthetic marker entirely.

For Step 1 the synthetic marker has zero observable behavioral impact (no downstream consumer iterates named_ranges for literal-range plans yet, because no reference-aware fn is registered to produce them). But the pattern is a hidden-state-via-string-marker antipattern that the codebase otherwise avoids.

**Recommendation:** apply Alternative A or B in a follow-up commit, before any downstream tooling consumes `formula_deps`. At minimum, document the marker convention publicly on `FormulaDeps.named_ranges` so consumers know to filter it out.

**Severity rationale:** MEDIUM because the field is `pub` and exposes the marker through a `pub` accessor. Today there's no consumer that's harmed. Tomorrow's contributor reading `for (name, range) in deps.named_ranges` won't expect the marker.

---

### MEDIUM-O-7 — `is_dep_suppressed_reference_fn` lists ROW/COLUMN/ROWS/COLUMNS/ISREF but is hardcoded with no invariant test.

**Where:** `crates/ql-exec/src/calcgraph_session.rs:181-183`.

```rust
pub(crate) fn is_dep_suppressed_reference_fn(name: &str) -> bool {
    matches!(name, "ROW" | "COLUMN" | "ROWS" | "COLUMNS" | "ISREF")
}
```

**Detail:** like `is_reference_aware_function`, this hardcoded list will fall out of sync with the registry over time. If a future contributor adds `ROW.MULTI` or a similar variant to `is_reference_aware_function` and `register_reference_aware`, but forgets to add it here, the formula will register false-positive value-deps and recompute too aggressively. The bug would be silent — the dep walker would faithfully push deps that produce correct-but-wasteful recomputes.

The design v2 § 5.3 (HIGH-H closure) clearly enumerates which 5 names suppress and which 2 (ISFORMULA, FORMULATEXT) keep value-deps as v1 cost. So the LIST is correct at v1 ship. The concern is drift after.

**Recommendation:** add an invariant test that pins the list against the design's enumeration, e.g.:

```rust
#[test]
fn dep_suppressed_reference_fns_match_design() {
    assert!(is_dep_suppressed_reference_fn("ROW"));
    assert!(is_dep_suppressed_reference_fn("COLUMN"));
    assert!(is_dep_suppressed_reference_fn("ROWS"));
    assert!(is_dep_suppressed_reference_fn("COLUMNS"));
    assert!(is_dep_suppressed_reference_fn("ISREF"));
    assert!(!is_dep_suppressed_reference_fn("ISFORMULA"));
    assert!(!is_dep_suppressed_reference_fn("FORMULATEXT"));
    // Spelling sanity — typo guard.
    assert!(!is_dep_suppressed_reference_fn("RAW"));
    assert!(!is_dep_suppressed_reference_fn("COLUM"));
}
```

Note that `is_reference_aware_function` overlaps with `is_dep_suppressed_reference_fn` — but `is_reference_aware_function` includes the seven names while `is_dep_suppressed_reference_fn` includes only five. A cross-check would also be useful: "every name in `is_dep_suppressed_reference_fn` is also in `is_reference_aware_function`".

Note also that the function name uses `_reference_fn` suffix while the design § 5.3 talks about reference-tier policy classes. Consider naming alignment with `is_reference_aware_function` (e.g., `is_address_only_reference_aware_function` or `_suppresses_value_deps`).

**Severity rationale:** MEDIUM — like MEDIUM-O-1, the immediate behavioral impact is zero (none of these are registered yet), but the gap is foreseeable drift.

---

### MEDIUM-O-8 — `materialize_ref_arg_lazy` collapses `ExprPlan::Number` / `Bool` / `String` / `Array` / `Binary` / `Unary` into a single `PlanKind::Literal` — loses information.

**Where:** `crates/ql-exec/src/scalar.rs:631-637`.

```rust
ExprPlan::Number(_)
| ExprPlan::Bool(_)
| ExprPlan::String(_)
| ExprPlan::Array(_)
| ExprPlan::Binary { .. }
| ExprPlan::Unary { .. } => PlanKind::Literal,
```

**Detail:** the design v2 § 2.3 specifies `ISREF(1+2) = FALSE`, `ISREF({1,2,3}) = ?` (not enumerated; but Excel canon: arrays are NOT references → FALSE), `ISREF(1/0) = FALSE`. All collapse to `PlanKind::Literal` per the impl. ISREF returns FALSE. ✓ — semantically correct for the v1 cohort.

But the lazy materializer is the ONLY producer of `PlanKind`, and it discards information that COULD distinguish:
- `ExprPlan::Array(_)` — an array literal (a different class of "not a reference" than a number).
- `ExprPlan::Binary { .. }` — an arithmetic expression (similarly distinct).
- `ExprPlan::Error(_)` — already kept as `PlanKind::Error` (kept distinct from Literal). ✓

If a future reference-aware function (`ISARRAY`? hypothetical) needs to distinguish array literals from numbers, it can't via the current `PlanKind`. This is a forward-compatibility gap.

For v1's ISREF, the collapse is fine — ISREF returns FALSE for all of these. But the PlanKind enum is a public-ish ABI (it's re-exported from ql-functions); adding a variant later is a breaking change for anyone who pattern-matched on it. Step 1 should over-specify, not under-specify.

**Recommendation:** consider splitting `PlanKind::Literal` into `Literal`, `Array`, `Arithmetic`. ISREF still maps Literal/Array/Arithmetic → FALSE. The cost is a slightly larger enum; the benefit is future flexibility.

Alternatively, leave as-is and explicitly call out in the doc comment that `PlanKind::Literal` covers "any non-reference, non-function plan" — current doc comment at reference_aware_fns.rs:79-80 says "literal-shaped expression. Not a reference" which is fine but doesn't enumerate the variants.

**Severity rationale:** MEDIUM-as-future-cost, LOW-as-today. Calling it MEDIUM because the enum is in the ABI surface.

---

## LOW

### LOW-O-1 — Unit tests in `reference_aware_fns.rs` are smoke-level; no integration test exercises the dispatcher path.

**Where:** `crates/ql-functions/src/reference_aware_fns.rs:176-303`.

**Detail:** the 8 unit tests in this file:

1. `no_op_reference_query_returns_defaults` — singleton sanity ✓
2. `no_op_reference_query_singleton_is_usable` — dyn-coercion ✓
3. `ref_arg_variants_construct` — smoke test of all 6 variants ✓
4. `arg_contract_variants_distinct` — trivial ✓
5. `plan_kind_function_returns_reference_distinction` — trivial ✓
6. `registry_round_trip_for_reference_aware` — registry sanity ✓
7. `register_reference_aware_rejects_duplicate` — duplicate-panic ✓
8. `register_reference_aware_rejects_lowercase` — canonical-uppercase-panic ✓

What's missing: an integration test that registers a placeholder reference-aware fn AND dispatches a formula through `eval_scalar_with_cache` to verify the dispatcher arm wiring (scalar.rs:437-462) actually fires. The placeholder fn could be `fn placeholder(_args, _ctx) -> Value { Value::number(42.0) }` registered as `"__RT_TEST_FN__"` with `ArgContract::Eager`, then a `MapEnv` + `FunctionRegistry` setup that binds `=__RT_TEST_FN__(A1)` and evaluates. The dispatch returning `42.0` would prove the binder/materializer/dispatcher chain is wired.

Without this test, Step 2 is the first time the dispatch path runs end-to-end. Any wiring bug (e.g., the dispatcher arm at scalar.rs:437 being mis-ordered relative to the disjointness assumption, or `RefContext::new` arguments being passed in wrong order) only surfaces during Step 2 implementation — undermining the "Step 1 lands the infrastructure with gates green, audit before any user-facing fn" rationale from the plan.

**Recommendation:** add an integration test in `reference_aware_fns.rs` (or a new test file in `ql-functions/tests/`) that registers a placeholder and dispatches through scalar.rs. Skeleton:

```rust
#[test]
fn dispatcher_invokes_reference_aware_fn_end_to_end() {
    use ql_exec::{eval_scalar_with_cache, env::MapEnv, NoAggregateCache};
    use ql_exec::plan::{bind, ExprPlan};
    // ... build registry with placeholder ...
    // ... bind "=__RT_TEST_FN__(A1)" ...
    let result = eval_scalar_with_cache(&plan, &env, &registry, &NoAggregateCache);
    assert_eq!(result, Value::number(42.0));
}
```

The test would need to live in `ql-exec` (since it depends on `eval_scalar_with_cache`), not in `ql-functions` proper.

**Severity rationale:** LOW because the registry round-trip + dispatcher pseudo-code review I did manually didn't surface a wiring bug, but the integration coverage gap is the kind of thing the "Don't Be Lazy" rule warns against.

---

### LOW-O-2 — `RefContext` lacks builder/with-formula-cell convenience constructors; tests will be verbose.

**Where:** `crates/ql-functions/src/reference_aware_fns.rs:122-134`.

**Detail:** `RefContext::new(eval_ctx, formula_cell, workbook)` is the only constructor. Step 2's per-fn tests will need to construct `RefContext` repeatedly with different `formula_cell` settings. The pattern compares to `WorkbookEnv::with_formula_cell` (env.rs:154-158) which has a builder.

**Recommendation:** add `RefContext::sheet_only(&eval_ctx, &workbook)` and/or `RefContext::at_cell(&eval_ctx, addr, &workbook)` convenience constructors before Step 2 tests are written. Minor ergonomic improvement.

**Severity rationale:** LOW — minor convenience.

---

### LOW-O-3 — `BindContext::AggregateArg` doc comment references `accepts_special_arg_at_bind` (the design-doc name), but the function is `is_aggregate_function`.

**Where:** `crates/ql-exec/src/plan.rs:365`.

```rust
/// Inside the argument list of an aggregate function (SUM, AVERAGE,
/// MIN, MAX, COUNT, etc. — see `accepts_special_arg_at_bind`).
```

**Detail:** the doc-comment references a function name that doesn't exist (`accepts_special_arg_at_bind`). The actual function is `is_aggregate_function` (line 401). Consistent with HIGH-O-2 — the rename was specified by the design v2 but didn't ship. The doc comment was updated; the function rename was skipped. Net: dead reference.

**Recommendation:** revert the doc-comment to reference `is_aggregate_function` OR perform the rename. Pick one.

**Severity rationale:** LOW — doc-comment hygiene; no behavioral impact.

---

### LOW-O-4 — `names_all_chains_all_three_tables` test name says "three tables"; there are now five tiers.

**Where:** `crates/ql-functions/src/registry.rs:1002`.

**Detail:** the test was written when there were three tables (Scalar, RangeAware, ContextAware). Unified added a fourth; ReferenceAware adds a fifth. The test still works (it uses `names_all()` which is tier-agnostic), but the test NAME is now misleading.

**Recommendation:** rename to `names_all_chains_all_tiers` or extend the test to cover all five tiers explicitly. Same for `len_includes_context_aware_table` and `is_empty_checks_all_three_tables` which are also stale-named.

**Severity rationale:** LOW — naming hygiene.

---

### LOW-O-5 — The `MAX_ROW` math at design § 2.2 cross-checked against `resolve_range_ref_to_range::WholeColumn` produces `ROWS(A:A) = 1_048_576`.

**Where:** `crates/ql-exec/src/plan.rs:1650-1666` AND `crates/ql-types/src/address.rs:28,31`.

**Detail:** verification (not a finding, just a cross-check note). `WholeColumn` produces `Range::new(sheet_id, 0, start_col, MAX_ROW, end_col)` where `MAX_ROW = 1_048_575`. `end_row - start_row + 1 = 1_048_575 - 0 + 1 = 1_048_576`. The design's claim that `ROWS(A:A) = 1_048_576` (Excel-canonical row count) is correct.

Similarly `WholeRow` produces `Range::new(..., start_row, 0, end_row, MAX_COLUMN)` where `MAX_COLUMN = 16_383`. `COLUMNS(1:1) = 16_383 - 0 + 1 = 16_384`. Also correct.

No action needed. Logged for future-reference traceability.

**Severity rationale:** LOW — cross-check, not a defect.

---

### LOW-O-6 — Cell-boundary multi-cell guard at scalar.rs:811-833 uses `matches!(name.as_ref(), "ROW" | "COLUMN")` — works because the parser canonicalizes, but no explicit invariant test pins the assumption.

**Where:** `crates/ql-exec/src/scalar.rs:811-835`.

**Detail:** the guard string-matches against literal upper-case names. The parser at `crates/ql-formula-syntax/src/parser.rs:293,624,1087` canonicalizes function names via `to_ascii_uppercase`. So by the time `name.as_ref()` reaches this guard, the name is already upper-case. Confirmed.

But: a future code path that constructs `ExprPlan::Function` directly (e.g., via test fixtures or programmatic API) could produce mixed-case names. The guard would silently miss them.

The `is_volatile_function` comment at calcgraph_session.rs:147 explicitly notes the parser canonicalizes; `is_reference_aware_function` and `is_dep_suppressed_reference_fn` rely on the same invariant. Internal consistency. But there's no test that asserts "if you construct a Function plan with lower-case name, the guard does NOT fire" — which would be the regression test.

**Recommendation:** add a test that programmatically constructs `ExprPlan::Function { name: Arc::from("row"), args: [...] }` and verifies the cell-boundary guard does NOT fire (because the matcher is case-sensitive). This pins the parser-canonicalization-required invariant.

**Severity rationale:** LOW — defensive test.

---

### LOW-O-7 — `materialize_ref_arg_eager` doc-comment says fallthrough hits Function/Binary/Unary — verified, but variants like `Number`/`Bool`/`String` are also hitting it.

**Where:** `crates/ql-exec/src/scalar.rs:539-611`.

**Detail:** the explicit arms cover `CellRef`, `AggregateNameRef`, `RangeRef`, `StructuredRef`, `Array`, `Error`. The fallthrough `other` arm catches `Number`, `Bool`, `String`, `Binary`, `Unary`, AND `Function`. The doc comment at scalar.rs:539-543 doesn't enumerate them.

Each of these resolves via `eval_scalar_with_cache(other, ...)`:
- `Number(n)` → `Value::Number(n)` → `RefArg::Scalar(...)` ✓
- `Bool(b)` → `Value::Boolean(b)` → `RefArg::Scalar(...)` ✓
- `String(s)` → `Value::Text(s)` → `RefArg::Scalar(...)` ✓
- `Binary` → arithmetic result → `RefArg::Scalar(...)` or `RefArg::Error(...)` ✓
- `Unary` → similar ✓
- `Function` → see HIGH-O-3 ✓ (eager-fires, wasted CPU)

**Recommendation:** update the doc-comment to enumerate the fallthrough's coverage: "Number/Bool/String — eager-eval to Value, then convert; Binary/Unary — arithmetic, similarly; Function — eager-eval, see § HIGH-O-3 caveat for volatile re-firing."

**Severity rationale:** LOW — doc-comment completeness.

---

### LOW-O-8 — `register_reference_aware_rejects_lowercase` test uses `"rt_lowercase"` — but `insert_or_panic` checks for ANY lower-case byte, so `"RT_LOWERCASE"` would pass and `"RT_lowercase"` would also panic.

**Where:** `crates/ql-functions/src/reference_aware_fns.rs:294-303`.

**Detail:** the test passes `"rt_lowercase"` which has all lower-case ASCII. The panic message contains `"canonical upper-case"`. Both expected. But the test name `register_reference_aware_rejects_lowercase` could be read as "rejects only fully-lowercase names" — actually it rejects ANY name containing lowercase ASCII.

**Recommendation:** add a second test variant `register_reference_aware_rejects_mixed_case` that passes `"RT_LowerCase"` and verifies the panic. Two tests pin both shapes.

**Severity rationale:** LOW — test coverage completeness.

---

### LOW-O-9 — Design v2 § 5.6 per-fn pseudo-code unverified by Step 1 (Step 2/3/4 work) — flagging for tracking only.

**Where:** design `docs/architecture/2026-05-17-reference-tier-design.md` § 5.6.

**Detail:** the design's per-fn pseudo-code for ROW/ROWS/COLUMN/COLUMNS/ISREF/ISFORMULA/FORMULATEXT references types like `Value::number(...)`, `Value::Error(...)`, `Range::start_row`, `Address::row`, etc. Step 1 doesn't implement any of these; the verification waits until Step 2. The pre-review pass already pinned the identifier-correctness (LOW-1 / Opus HIGH-6 in v1 → MEDIUM in reconciliation), so the type signatures should be correct. But no compile-checks fire until Step 2.

**Recommendation:** at Step 2 implementation, cross-check each per-fn impl against design § 5.6 once more.

**Severity rationale:** LOW — tracking; not a Step 1 defect.

---

## Cross-cutting observations (not separate findings)

### CC-1 — Plan checklist line 41-45 sub-bullets (pre-flight verification).

The plan checklist at `.plans/_active.md:41-45` lists pre-flight verifications:
- Grep `is_aggregate_function` call sites; count for rename ripple budget.
- Read `crates/ql-exec/src/workbook_runtime.rs:5158-5212` invariant test; understand its current shape.
- Read `crates/ql-exec/src/calcgraph_session.rs:213-268` walker; understand current shape.
- Read `crates/ql-types/src/address.rs` (`Range`, `Address`, `RowId`, `ColId`); confirm v2 design's identifier claims.

The pre-flight items are checkboxes; whether they were run isn't verifiable from the working tree alone (the commit message / handoff doc would show). Given HIGH-O-2 (the rename + invariant-test extension was dropped silently), the pre-flight for `is_aggregate_function` ripple may not have produced an output that triggered the design-doc update.

This is not a finding per se — but a process observation: the pre-flight items should produce a checked-in artifact (an audit-log entry or commit-message excerpt) that locks in their answers. Without that, "the pre-flight was done" is an unverifiable claim.

### CC-2 — `is_aggregate_function` doc comment + invariant test relationship is unchanged.

The `is_aggregate_function` matcher in plan.rs:401 lists 35 names. The invariant test at workbook_runtime.rs:5158 enumerates the same names. Both unchanged in this commit. No regression.

### CC-3 — Plan-cache correctness for `ExprPlan::RangeRef`.

The plan cache (`crates/ql-exec/src/plan_cache.rs:69-73`) keys by `(text, sheet, name_gen, cell_anchor)`. `cell_anchor` is `Some((row, col))` iff the text contains `@`. The text for `=ROW(A1:A5)` is `"ROW(A1:A5)"` (no `@`), so `cell_anchor: None` — plan shared across cells. ✓ Plan tree contains `ExprPlan::Function { args: [RangeRef { range: A1:A5 }] }`. The Range payload is cell-INDEPENDENT (the range is authored, not derived from the formula cell). ✓ No plan-cache invalidation needed.

But: `=ROW()` (zero-arg) — text is `"ROW()"`, no `@`, `cell_anchor: None`. Plan tree is `ExprPlan::Function { name: "ROW", args: [] }`. Per design v2 § 8 R1, this plan is cell-INDEPENDENT — the per-cell `formula_cell` for the result comes from `env.formula_cell_for_sref()` at evaluation. ✓ Correct.

No plan-cache concern. Confirmed.

### CC-4 — Op-log replay path.

The design v2 § 8 R7 verified that `WorkbookRuntime::recompute_dirty` uses `WorkbookEnv::with_formula_cell` at workbook_runtime.rs:3637. I did not re-verify this in my audit (taking the design's claim at face value), but the env.rs:154-158 `with_formula_cell` constructor exists and the dispatcher's `env.formula_cell_for_sref()` call at scalar.rs:458 reads from it. The chain is intact for the evaluation path; replay-path verification stays where the design left it.

### CC-5 — Export/import (qbook round-trip).

The design v2 § 5.5 / § 8 R7 (new) says qbook round-trips formulas as source text via `Workbook::formula_at`. Step 1 doesn't change this; FORMULATEXT (Step 4) prepends `=` at the function boundary. No serialization concerns.

### CC-6 — Step 1 plan checklist completion state.

Per `.plans/_active.md:37-74`, the Phase 1 sub-bullets are:

| Item | Plan line | Status |
|------|-----------|--------|
| Step 1.A pre-flight | 41-45 | unchecked |
| `PlanKind` enum | 46 | shipped |
| `RefArg` enum (6 variants) | 48 | shipped |
| `ReferenceAwareFn`, `RefContext`, `ArgContract`, `ReferenceQuery`, `NoOpReferenceQuery` | 49 | shipped |
| `RegisteredFn::ReferenceAware` + register/lookup/contract_of/reference_aware_names/names_all | 50 | shipped (no separate `contract_of`; included in `lookup_reference_aware` return) |
| `ExprPlan::RangeRef { range }` | 52 | shipped |
| `Expr::RangeRef` binder accept `AggregateArg \| ReferenceArg` | 53 | partial — only `ReferenceArg` (see MEDIUM-O-5) |
| `BindContext::ReferenceArg` | 54 | shipped |
| Rename `is_aggregate_function` → `accepts_special_arg_at_bind`; add 7 names | 55 | **NOT shipped** (HIGH-O-2) |
| Update call sites of rename | 56 | N/A (rename didn't happen) |
| `ReferenceAware` dispatch arm | 58 | shipped |
| `materialize_ref_arg_eager` + `_lazy` | 59 | shipped |
| Cell-boundary multi-cell `#CALC!` guard | 60 | shipped |
| Per-fn-name policy table in walker | 62 | shipped (as standalone `is_dep_suppressed_reference_fn`) |
| Dep-suppress for ROW/COLUMN/ROWS/COLUMNS/ISREF | 63 | shipped |
| Dep-normal for ISFORMULA/FORMULATEXT | 64 | shipped (by exclusion from the suppressed list) |
| ReferenceQuery for Workbook | 65 | shipped (on WorkbookEnv instead; MEDIUM-O-4) |
| CellEnv reference_query() default + WorkbookEnv override | 66 | shipped |
| Extend `accepts_special_arg_lists_only_registered_fns` test | 68 | **NOT shipped** (HIGH-O-1) |
| Compile / clippy / fmt / doc gates | 69 | reported green |

**Net checklist state:** 3 items skipped / partial (rows 55, 56, 68 — covered by HIGH-O-1, HIGH-O-2, MEDIUM-O-5). Plan file should be updated to reflect actuals before Step 2 begins.

---

## Pattern signals captured

1. **Doc-promised invariant tests can fail to ship.** HIGH-O-1: the doc comment at plan.rs:492 promises a test that doesn't exist. Pattern signal: never write "added in this commit" without verifying the test actually exists in the commit. A pre-commit grep would catch this trivially.

2. **Design ↔ implementation drift on rename + extend tasks.** HIGH-O-2: the plan said "rename + extend invariant test", the code did neither, and the design doc still says "rename + extend". This is the kind of multi-file coordination that the codebase has been good about historically. Pattern signal: when a HIGH-G-class closure has multiple files to touch, ALL of them should ship together OR none should.

3. **Volatile re-firing under dep-suppress is a quiet asymmetry.** HIGH-O-3: the dep walker assumes Function args don't affect the result; the materializer evaluates them anyway. Pattern signal: every new dispatch tier has a dep-tracking policy AND a runtime-eval policy; both should be designed together with the symmetry explicit.

4. **Synthetic markers leak through public fields.** MEDIUM-O-6: the `__rt_literal_range__` marker shows up in a `pub` field via a `pub` accessor. Pattern signal: when reusing an existing collection for a new dep-class, prefer adding a sibling field over carrying a synthetic name.

5. **`PlanKind::Literal` collapse is over-aggressive.** MEDIUM-O-8: future reference-aware fns that distinguish Array from Number lose the distinction at lazy-shape time. Pattern signal: ABI enums in public crates should over-specify, not under-specify.

---

## Recommendation for Step 1.A closure

Before Step 2 (ROW/COLUMN/ROWS/COLUMNS implementation) ships, close (at minimum):

1. **HIGH-O-1** — add the missing invariant test for `is_reference_aware_function` (or rename it per the design's preferred shape).
2. **HIGH-O-2** — resolve the design-vs-implementation drift (rename `is_aggregate_function`, or update the design doc + plan to specify parallel-matchers).
3. **HIGH-O-3** — add the documentation note about the volatile-fn re-firing asymmetry.
4. **LOW-O-3** — fix the dead doc-reference in plan.rs:365.

The MEDIUM items can be tracked as RT-1.5 / RT-1.6 / etc. follow-ups inside the Step 2 commit batch. The LOW items can go into a post-mini-phase polish wave.

The implementation overall is sound: the registry / dispatcher / binder / walker / env wiring works, the 8 unit tests pin the registry contract, the design's HIGH closures (A, B, C, D, E, F, H) are implemented in code form, and gates are reported green. The audit findings are concentrated in **documentation drift** (HIGH-O-1, HIGH-O-2, LOW-O-3, LOW-O-4, LOW-O-7), **missing invariant tests** (HIGH-O-1, MEDIUM-O-1, MEDIUM-O-7), and **architectural concerns visible only when reading multiple files side-by-side** (HIGH-O-3, MEDIUM-O-4, MEDIUM-O-5, MEDIUM-O-6).

---

## Counts

- HIGH: 3
- MEDIUM: 8
- LOW: 9
- **Total: 20**
