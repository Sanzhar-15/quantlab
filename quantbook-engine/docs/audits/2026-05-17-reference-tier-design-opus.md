# Reference-tier design — separate-Opus pre-review

**Audit subject:** `docs/architecture/2026-05-17-reference-tier-design.md`
**Auditor:** Opus 4.7 (1M context), independent of parallel Codex pre-review.
**Date:** 2026-05-17.
**Baseline HEAD:** `8f9b37b5d6d`.
**Method:** independently verified every design claim against actual source files; classified findings without coordinating with Codex.

Severity scale per `quantbook_engine_audit_discipline.md`:
- **HIGH** — likely incorrect output if implemented as designed, or a hard blocker.
- **MEDIUM** — works but deviates from canon, has a maintainability cost, or misrepresents the codebase.
- **LOW** — style / doc / nit.

---

## HIGH findings

### HIGH-1 — `Expr::RangeRef` is unconditionally rejected by the binder; B1 strategy cannot bind `ROWS(A1:B3)` / `ROW(A1:B3)` / `COLUMNS(A1:B3)`

**Where:** `crates/ql-exec/src/plan.rs:636-642`; design § 5.4 "Recommended: B1."

**Detail.** The design § 5.4 says reference-tier fns will be added to `is_aggregate_function` so range args bind as `AggregateNameRef`. But the binder at `plan.rs:636` rejects `Expr::RangeRef(_)` with `BindError::UnsupportedVariant` **regardless of `BindContext`**:

```rust
Expr::RangeRef(_) => Err(BindError::UnsupportedVariant(
    "literal RangeRef in non-Function context is unsupported in v1; \
     use a named range (Phase 2B.4 AggregateNameRef) or wrap in an \
     aggregate function. (Updated W5-108 / Phase 4.7.O; …)",
)),
```

The error wording says "in non-Function context" but the match arm fires *before* any context inspection — line 643's `Expr::Function` branch only sets `arg_ctx` for the recursive call on each arg, and the recursive call on `Expr::RangeRef` hits line 636 first. **There is no path that today binds `SUM(A1:B3)` literal-range form** — `SUM(NamedRange)` and `SUM(A1+B1+...)` are the only supported aggregate-input shapes (confirmed by the test comment at `crates/ql-exec/src/transaction.rs:664`: *"Phase 1's scalar eval doesn't accept range args (SUM(A1:B5) requires aggregate dispatch — Phase 2B+), so the formula here references each cell individually."* — that comment is still accurate at HEAD).

Consequence: ROWS(A1:B3) / COLUMNS(A1:B3) / ROW(A1:B3) / ISFORMULA(A1:B3) **cannot reach the dispatcher** under B1 as written. Only NameRef → Range (e.g. `ROWS(Sales)`) works, plus single-cell `ROW(A1)` / `ISFORMULA(A1)` (which bind through `Expr::CellRef` at line 596, not `RangeRef`).

**Recommendation.** B1 is *necessary but not sufficient*. Either:
(a) Extend the `Expr::RangeRef` arm at line 636 to bind literal ranges to `ExprPlan::AggregateNameRef` (with a synthetic name) when `ctx == BindContext::AggregateArg` — i.e., move the W5-108 "use a named range" requirement out from under aggregate-fn arg position.
(b) Add a new `ExprPlan::RangeRef { range }` variant that carries a resolved `Range` without a name, and bind `Expr::RangeRef` in `AggregateArg` context to it. This is closer to the design's B2 alternative; the design dismisses B2 in two sentences but the cost picture inverts once you account for HIGH-1.

The design's R2 "verify the existing `Range` type's public surface" is the wrong question — `Range` IS sufficient, but the design fails to ask: "what plan node carries it from the binder to the dispatcher today?" Answer: only `AggregateNameRef`, gated by NameRef resolution. Document this explicitly. Without (a) or (b), the design's headline scope (`ROWS(A1:B3) → 3`) is unimplementable.

**Severity rationale.** This is the single largest design gap. Without resolving it, half the function semantics in § 2 cannot be exercised — and the test plan in § 7 specifies "range / named-range / cross-sheet variant" as the second happy-path test, which would fail at bind.

---

### HIGH-2 — Eager arg evaluation in `materialize_ref_arg` breaks ISREF / ISFORMULA / FORMULATEXT semantics

**Where:** Design § 5.3 `materialize_ref_arg`, last arm:
```rust
_ => RefArg::Literal(eval_scalar_with_cache(plan, env, registry, cache)),
```

**Detail.** The design uniformly *evaluates* every non-reference arg into a `Value`, then wraps as `RefArg::Literal`. This diverges from Excel and IronCalc canon for the inspection-style fns:

1. **`ISREF(1/0)`** — Excel returns `FALSE`. The design's path evaluates `1/0` → `#DIV/0!` → wraps as `RefArg::Literal(Value::Error(DivZero))`. The ISREF impl in § 5.6 returns `Value::Boolean(false)` for `Literal(_)` *iff* the impl ignores the inner Value. Looking at § 5.6: the match arm is `[RefArg::Scalar(_) | RefArg::Literal(_)] => Value::Boolean(false)` — that ignores the inner value, so ISREF technically returns `FALSE`. **But the eval still happens, with all its side effects** (aggregate cache writes, dep-graph accounting). For `ISREF(VOLATILE_FN())`, the volatile fn gets called every recompute even though the result is discarded. **Worse:** for `ISREF(SUM(NamedRange))`, the aggregate cache stores `(NamedRange, "SUM")` → an extra cache entry the user neither asked for nor benefits from.

2. **`ISFORMULA("text")`** — IronCalc returns `#VALUE!` *without evaluating*. Our design path matches the sketch (since `"text"` evaluates to `Value::Text("text")` and wraps as `Literal`, which falls through to `#VALUE!`). OK for this specific case. But:

3. **`FORMULATEXT(IF(A1>0, B1, C1))`** — the `IF` call is not a reference-returning fn. IronCalc's `evaluate_node_with_reference` returns the value, not a range, so falls into the "Argument must be a reference" branch — produces `#ERROR!` / `#VALUE!`. **The design's `materialize_ref_arg` evaluates IF eagerly**, which means if A1 is `#REF!`, the IF errors propagate, the args become `Literal(Value::Error(Ref))`, FORMULATEXT returns `#VALUE!` per § 5.6. Compare Excel: FORMULATEXT non-reference arg returns `#N/A` (per the design's own § 2.5 and IronCalc's `Error::NA` at `information.rs:875`). **The design's per-fn impls in § 5.6 already inconsistently mix `#VALUE!` and `#N/A` for the same `Literal(_)` case** — FORMULATEXT uses `#VALUE!` but should follow IronCalc and return `#N/A`. See MEDIUM-1.

4. **ISREF on a function call that's known to fail** — `ISREF(SUM(BadName))` — eager eval surfaces `#NAME?`, and ISREF returns `FALSE` (correct outcome), but only after a fully-fledged failing eval. Excel's lazy semantics avoid this.

**Recommendation.** ISREF in particular MUST NOT evaluate. Options:

- **Option A — Per-fn ABI bit "no-eval-on-non-ref".** ISREF gets `ABI::no_eval_args`. The dispatcher checks the bit and, for non-CellRef / non-RangeRef / non-AggregateNameRef / non-StructuredRef plans, emits `RefArg::Literal(Value::Blank)` (placeholder) WITHOUT calling `eval_scalar_with_cache`.

- **Option B — Inspect the `ExprPlan` shape, not the Value.** Pass the `ExprPlan` reference into `RefArg::Literal { plan_kind }` instead of an evaluated `Value`. The ISREF impl pattern-matches on the kind (`"Function"`, `"Number"`, etc.). Less surface area than Option A but loses access to the Value for fns that DO want it (ISFORMULA with a Range that resolves to a single Value).

- **Option C — Two materializers.** `materialize_ref_arg_lazy` (for ISREF) and `materialize_ref_arg_eager` (for the others). ABI per fn picks one. This is what IronCalc does — `evaluate_node_with_reference` vs direct pattern-match.

Option C maps directly to IronCalc's pattern and is cheapest for v1.

**Severity rationale.** Without addressing this, ISREF / ISFORMULA / FORMULATEXT trigger side effects on args they're supposed to inspect — including hitting the volatile-fn whitelist and the aggregate cache. The semantic divergence on `ISREF(VOLATILE())` is observable; the cache-pollution side effect is silent but architectural.

---

### HIGH-3 — Plan cache key does not account for `ROW()` / `COLUMN()` zero-arg cell-dependence; shared formula text across cells will return wrong rows

**Where:** `crates/ql-exec/src/plan_cache.rs:68-74` (`PlanCacheKey.cell_anchor`); design § 8 R1.

**Detail.** The plan cache key is `(text, sheet, name_gen, cell_anchor)` where `cell_anchor` is `Some((row, col))` ONLY when the formula text contains `@` (implicit intersection). For all other formulas, the key is cell-INDEPENDENT — `=ROW()` typed in B5 produces the SAME cache entry as `=ROW()` typed in B6, B7, etc.

`=ROW()` returns the CALLING cell's row. If B5 evaluates first, the plan binds + caches; B6 reuses the cached plan but the plan's `Expr::Function { name: "ROW", args: [] }` doesn't carry the calling cell — only the *evaluator* knows the cell, via `env.formula_cell_for_sref()`. **So the plan tree is fine — the issue is whether the result-level evaluation caches the result keyed on the cell.** Looking at `eval_scalar_with_cache`: the aggregate cache only fires for `Scalar`-tier aggregates with a single-`AggregateNameRef`-arg fast path; ReferenceAware would not hit it. So the plan-cache + eval combination is correct for `=ROW()`.

**BUT** — the design § 8 R1 says: *"`eval_scalar_with_cache` does NOT take a call-site parameter today; cell evaluation goes through `eval_at_cell_boundary` (line 557+) which DOES know the cell. ROW() without an arg must be called via a path that knows the cell. Mitigation: thread `Option<CallSite>` through `eval_scalar_with_cache`; if None and `ROW()` is called with no args, return `#REF!` (or `#VALUE!`)."*

This is the wrong analysis. The cell IS already available via `env.formula_cell_for_sref() -> Option<Address>` (existing, see `env.rs:83`). `WorkbookEnv::with_formula_cell` (env.rs:140) already wires it through at the cell-boundary entry. **`eval_scalar_with_cache` does receive the env; the env carries the cell.** The design's proposed new `call_site()` method is redundant — `formula_cell_for_sref()` already exists and serves exactly this purpose.

The actual issue is **MEDIUM**, not HIGH (downgraded): the design proposes a new method when an existing one suffices, and the design's R1 "thread `Option<CallSite>` through `eval_scalar_with_cache`" is unnecessary work. This is renamed to MEDIUM-2 below.

The HIGH-3 here is **the design fails to address plan-cache cell-anchor-dependence for `=ROW()` zero-arg specifically**: today's plan cache keys cell-anchor-dependent plans on `Some((row, col))` only when `@` is present (W5-150 / 4.9.O HIGH-1 closure). Reference-tier fns introduce a NEW kind of cell-anchor-dependence — `ROW()` and `COLUMN()` zero-arg return cell-dependent VALUES, not cell-dependent PLANS. The plan tree IS cell-independent (it's `Function { name: "ROW", args: [] }`). So sharing the plan across cells is fine. The dispatcher's per-call evaluation uses the env's calling cell. **There's no correctness bug, just a documentation gap.**

DOWNGRADED to MEDIUM-3 below.

Replacing this slot with a different HIGH:

### HIGH-3 (replacement) — `is_aggregate_function` matcher invariant test is silently broken by adding reference-tier fns to its list

**Where:** `crates/ql-exec/src/workbook_runtime.rs:5158-5212` (`is_aggregate_function_lists_only_registered_aggregates`); design § 6 Step 1.

**Detail.** The invariant test at workbook_runtime.rs:5158 asserts that every name in `is_aggregate_function` is registered as either `Scalar` (via `reg.lookup`) or `RangeAware` (via `reg.lookup_range_aware`). Today the test has two `for` loops covering 14 scalar + 21 range-aware names. The design § 6 Step 1 says "extend `is_aggregate_function` (or its successor) to allow Range args for the 7 fns."

Adding ROW / COLUMN / ROWS / COLUMNS / ISREF / ISFORMULA / FORMULATEXT to `is_aggregate_function` makes the invariant test fail — these are registered as `ReferenceAware`, neither `Scalar` nor `RangeAware`. The test loops at lines 5162 and 5175 assert `reg.lookup(name).is_some()` and `reg.lookup_range_aware(name).is_some()` respectively; neither would succeed for the new tier.

The design does not mention this test. Step 1's "Gates green" is unachievable without either (a) extending the test to recognize ReferenceAware-tier names, or (b) splitting `is_aggregate_function` into `is_range_arg_function` + the new tier-specific list. The W5-62 audit closure commit ("the invariant test had drifted out of sync with the is_aggregate_function whitelist") indicates this test has *already* been the source of past regressions — extending without coverage maintenance is a documented landmine.

**Recommendation.** Step 1 must include a sub-bullet: "Extend `is_aggregate_function_lists_only_registered_aggregates` with a third loop checking `reg.lookup_reference_aware(name).is_some()` for the new names." Also rename the matcher itself — `is_aggregate_function` is now load-bearing for THREE concepts (genuine aggregates, range-aware binding, reference-aware binding). The W5-X comment at plan.rs:359-376 already calls this out as "historical"; the design should explicitly bundle a one-shot rename to `accepts_range_arg_at_bind` or similar, even if the ParamSchema migration is deferred (§ R4).

**Severity rationale.** Pre-test-failure: untested. Post-test-failure: blocks gate-green at Step 1, which the design explicitly requires. Listed HIGH because Step 1 cannot ship without it.

---

### HIGH-4 — Dep extractor `walk_plan_for_deps` over-tracks deps for reference-tier fns; ISFORMULA / FORMULATEXT recompute on every value change in the referenced cell

**Where:** `crates/ql-exec/src/calcgraph_session.rs:213-268`; design § 0 / § 5.

**Detail.** `walk_plan_for_deps` is the bind-time dep extractor (Phase 3.2). For an `ExprPlan::Function { name: "ISFORMULA", args: [ExprPlan::CellRef { sheet, row, col, .. }] }`, the walker recurses into `args` and on `CellRef` pushes `(sheet, row, col)` into `deps.cells` (line 221). So a formula `B5 = ISFORMULA(A1)` registers as a stripe-reader of A1.

Consequence: every time A1's *value* changes (e.g., a literal `5` → `7`), the calcgraph dirty-propagation pass marks B5 dirty and B5 re-evaluates ISFORMULA(A1). The result doesn't change (A1 is still a literal both times), but the work happens. For ROW(A1) and COLUMN(A1), the same: A1 value changes → B5 dirties → ROW(A1) re-evaluates → returns the same `1`. Wasteful.

The design § 0 says: *"`ISFORMULA(A1)` wants to inspect cell A1's storage to learn whether it holds a formula or a literal."* — implying its dep is the cell's formula-status, not its value. But our calcgraph only knows value-level deps; promoting reference-tier fns to a "formula-status dep" tier would require either (a) a new dep kind in `FormulaDeps` (e.g., `formula_status_deps: Vec<(SheetId, RowId, ColId)>`) tracked separately, with the workbook firing dirty on formula_status change (set_formula / clear_formula transitions only, not on value-only updates), or (b) accepting the over-recompute as a v1 cost.

**Worse:** for `ROW(A1)` specifically, the result is FIXED (A1's row is 1 forever, until the cell is moved). Currently, `ROW(A1)` formulas would recompute on any A1 value change. Excel doesn't recompute `=ROW(A1)` when A1 changes — but our system would.

The design does not address dep-extraction at all. § 8 R6 mentions cross-sheet ISFORMULA but only for read-path correctness, not for the dep-tracking semantics.

**Recommendation.** Pick one and document:
- (a) Accept over-recompute as v1 cost. Document in the design + matrix. Note that `ROW(A1)` and `COLUMN(A1)` will recompute spuriously when A1 changes — wasteful but not incorrect.
- (b) Add a new dep kind for "structural" / "formula-status" deps. Workbook fires `on_set_formula` / `on_clear_formula` against these (not value-update); `set_value` does NOT dirty them. This is a Phase-4.7-tier refactor — out of scope for v1, but the design should explicitly acknowledge it as the followup.
- (c) Walk the `ExprPlan::Function` with name-awareness: if `name` is in the reference-tier set AND the arg is a `CellRef`, do NOT push to `deps.cells`. Don't push to a new dep-kind either — the formula simply never invalidates from cell-write. This is incorrect for ISFORMULA (which DOES need to invalidate on formula-status flip) but correct for ROW/COLUMN/ROWS/COLUMNS (whose result depends only on the address, not on the cell at all — and addresses don't change without an explicit row/col-insert which is a separate event).

Most cleanly: ROW/COLUMN/ROWS/COLUMNS take dep-suppress treatment (option c), ISFORMULA/FORMULATEXT take new formula-status dep kind (option b deferred to a followup but tracked). v1 acceptable: option (a) for all 7, documented.

**Severity rationale.** Without explicit decision, the implementation will silently inherit value-level deps and the resulting recompute over-firing is invisible to tests but observable in profile data. The §7 test plan doesn't cover dep-extraction semantics (no test would catch this regression).

---

### HIGH-5 — Source-text retention is ALREADY available; § 8 R3 deferral is unnecessary

**Where:** `crates/ql-storage/src/workbook.rs:874` (`Workbook::formula_at`); design § 8 R3.

**Detail.** Design R3 says: *"Does `WorkbookRuntime` retain the original formula source text, or only the parsed `Expr` AST? If only AST, FORMULATEXT must round-trip through the printer (`ql-formula-syntax::print`)…  Investigation needed BEFORE Step 1."*

This is investigatable now. `Workbook::formula_at(sheet, row, col) -> Option<&Arc<str>>` (workbook.rs:874) returns the original formula source text:

```rust
pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
    self.formula_cells.get(&(sheet, row, col))
}
```

The Workbook's `formula_cells: HashMap<(SheetId, RowId, ColId), Arc<str>>` retains the raw source text verbatim. So:

- FORMULATEXT can return `workbook.formula_at(s, r, c).map(|arc| arc.as_ref().to_string())` directly.
- No printer round-trip needed.
- **This is BETTER than IronCalc** — IronCalc's comment at `lookup_and_reference/mod.rs:847-848` admits its own divergence: *"It returns the formula in English; it formats the formula without spaces between elements"*. We can return the raw source text exactly as the user typed it, matching Excel canon more closely.

The design's R3 says we "can match [IronCalc's printer-round-tripped behavior]" — but we don't have to. We can match Excel canon by serving the raw text.

**Recommendation.** Promote R3 from "open question / investigate before Step 1" to "resolved: use `workbook.formula_at(...)` directly; expose a `Workbook::formula_text_at` proxy on `ReferenceQuery` that delegates to `formula_at` and returns `Option<String>` (or `Option<Arc<str>>` if we want zero-copy)." Update § 2.5 to remove the "printer round-trip" hedge. Add to § 5.6 FORMULATEXT pseudocode the canonical impl (which is simpler than the design currently sketches). Document the divergence from IronCalc as a positive — we return verbatim source, IronCalc returns canonicalized printer output.

The implementation also gains: no printer-side bugs to introduce or test. No need for the design's R3 step.

**Edge case** to test: source text with a leading `=` — does Excel's FORMULATEXT include or exclude the leading `=`? Excel canon: INCLUDES it. So FORMULATEXT should prepend `=` to `workbook.formula_at(...)`'s return (which is stored without the `=` per `parse_formula_text` convention). This is a one-line concat; add to the design's pseudo-code.

**Severity rationale.** HIGH because the design doc commits to "investigation before Step 1" — that investigation is now done, and the design needs to be updated before code starts (per the design-first discipline). Leaving R3 as an open question wastes Step 1 reading/writing.

---

### HIGH-6 — `RowId.0` syntax in pseudo-code does not compile; `RowId = u32` is a type alias, not a newtype

**Where:** Design § 5.6, multiple lines: `ctx.call_site.row.0 as f64 + 1.0`, `(br.0 - tr.0 + 1) as f64`, etc.

**Detail.** `crates/ql-types/src/address.rs:21`:
```rust
pub type RowId = u32;
```

`RowId` is a **type alias** for `u32`, NOT a tuple struct. The design's pseudo-code repeatedly accesses `.0` on `RowId` / `ColId` values — that's invalid Rust:

```rust
RefArg::Reference { row, .. } => Value::number(row.0 as f64 + 1.0),
//                                              ^^^^^ doesn't compile
```

The correct form is `*row as f64 + 1.0`. (Note: even with the `.0` suffix removed, the design also drops `+ 1.0`, which is correct because our `RowId` is 0-indexed — see HIGH-7.)

**Recommendation.** Search-and-replace `row.0`, `col.0`, `.row.0`, `.col.0` in § 5.6 to `row` / `col`. Audit all integer-conversion sites — the design currently has at least 8 such expressions across § 5.3, 5.6, and the per-fn sketches. While editing, verify the cast direction: `as f64` from `u32` is widening and lossless.

**Severity rationale.** Pseudo-code is the contract for implementation. Bad pseudo-code → implementation copies the bug → compile fails OR (worse, if a closure substitutes `RowId::from`/similar) a subtle off-by-one. Adjacent to HIGH-7. Listed separately because the fix is mechanical.

---

### HIGH-7 — Excel ROW/COLUMN are 1-indexed; our `RowId` / `ColId` are 0-indexed; pseudo-code only handles the offset in ONE place

**Where:** Design § 5.6 `row()` line 382 `Value::number(ctx.call_site.row.0 as f64 + 1.0)`; § 5.6 `rows()` line 394 `Value::number((br.0 - tr.0 + 1) as f64)`.

**Detail.** `RowId` / `ColId` are 0-indexed internally (`RowId(0)` = Excel row 1, per address.rs:20-24). Excel's `ROW(A1)` returns `1`, not `0`. The design's pseudo-code handles this inconsistently:

- `row()` for `RefArg::Reference { row, .. }`: returns `row.0 as f64 + 1.0` (line 384, with `.0` bug — see HIGH-6 — but conceptually `+1` for the offset). ✓
- `row()` for `RefArg::Range { top_left: (row, _), .. }`: returns `row.0 as f64 + 1.0` (line 385). ✓
- `rows()` for `RefArg::Range`: returns `(br.0 - tr.0 + 1) as f64` (line 394). The `+1` here is to convert exclusive-difference into inclusive count, NOT to convert from 0-indexed to 1-indexed. The `Range` end_row is already inclusive (`address.rs:65`), so `end_row - start_row + 1` IS the inclusive count. ✓
- `rows()` for `RefArg::Reference { .. }`: returns `Value::number(1.0)` (line 396). ✓

OK, the offsets are actually consistent. But the design's commentary at § 2.2 says: *"For whole-column refs (`A:A`), IronCalc and Excel both return the workbook row limit (1_048_576). We follow IronCalc — the `Range` carries `right.row - left.row + 1` and the binder's `RangeRef::WholeColumn` already pins this to the workbook row limit."*

This claim is partially incorrect: the binder at `plan.rs:1046-1068` handles `RangeRef::WholeColumn` ONLY inside an `@` (implicit intersection) context, and narrows to a single cell. For function arg context, the binder rejects `Expr::RangeRef` entirely (HIGH-1). When (and if) HIGH-1 is resolved by extending the binder, `RangeRef::WholeColumn` would need to produce a `Range` with `end_row = MAX_ROW` (1_048_575, 0-indexed) — which gives `MAX_ROW - 0 + 1 = 1_048_576`. ✓ — but the design's commentary doesn't show this calc, and confuses the @ path with the function-arg path.

**Recommendation.** Rewrite § 2.2's "the binder's `RangeRef::WholeColumn` already pins this to the workbook row limit" — it does NOT, in function-arg context. State the calculation explicitly: `end_row - start_row + 1` where `RangeRef::WholeColumn` resolves to `start_row=0, end_row=MAX_ROW` (which is `1_048_575` per `address.rs:28`). Document the 0/1-indexed split: internal storage 0-indexed; output values 1-indexed; the `+1` in `ROW()` impl handles the conversion. Add an explicit unit test for `ROWS(A:A) == 1048576` AND `ROW(A1) == 1` to pin both edges.

**Severity rationale.** Off-by-one in 1-indexed/0-indexed conversion is the classic Excel-engine bug. Naming clarity in the design head off implementation drift.

---

## MEDIUM findings

### MEDIUM-1 — FORMULATEXT error-class divergence: should be `#N/A` for all error conditions per Excel + IronCalc

**Where:** Design § 5.6 `formulatext` impl, lines 425-438.

**Detail.** The design's FORMULATEXT pseudo-code returns:
- `#N/A` when no formula at the cell. ✓
- `#N/A` for multi-cell range arg. ✓
- `#VALUE!` for `Scalar`/`Literal` arg (non-reference). ✗ — IronCalc returns `Error::ERROR` ("argument must be a reference") at `lookup_and_reference/mod.rs:881-885`, which maps to `#N/A` per Excel canon for FORMULATEXT specifically.

Excel docs (Microsoft 2024): *"FORMULATEXT returns #N/A if: the reference argument is to a cell that doesn't contain a formula; the reference argument is to a different sheet that isn't open; the reference argument is to a non-cell."*

So **all** error conditions for FORMULATEXT collapse to `#N/A`. IronCalc maps non-reference args to `Error::ERROR` (which is `#ERROR!` in their model, a non-Excel error class) — that's their divergence. We should match Microsoft canon.

The design's per-fn impls also have inconsistent class choices:
- ISFORMULA → `#VALUE!` for multi-cell range (line 417). Microsoft: ISFORMULA returns `#N/A` for any non-single-cell-reference arg. ✗
- ISREF → never returns an error; returns FALSE for non-references. ✓

**Recommendation.** Change FORMULATEXT non-reference / multi-cell / wrong-shape error returns to `#N/A` per design § 5.6:
- `[RefArg::Range { .. }]` (multi-cell) → `#N/A`. (Already `#N/A` per design — ✓.)
- `[RefArg::Scalar(_) | RefArg::Literal(_)]` → `#N/A`, not `#VALUE!`.
- `_` (wrong arity) → IronCalc returns `Error::Args` ("Wrong number of arguments") at line 852; Excel returns `#N/A` here too.

For ISFORMULA: change multi-cell → `#N/A` (was `#VALUE!`).

**Severity rationale.** Off-by-one error class is a visible Excel-canon divergence that the §7 LibreOffice cross-check tests would surface. MEDIUM because it works but produces the wrong error name.

---

### MEDIUM-2 — `CellEnv::call_site()` is redundant; `formula_cell_for_sref()` already exists

**Where:** Design § 5.5, R1; `crates/ql-exec/src/env.rs:83`.

**Detail.** Design § 5.5 proposes adding `fn call_site(&self) -> CallSite` to `CellEnv`. But `CellEnv::formula_cell_for_sref(&self) -> Option<ql_types::Address>` (env.rs:83) already exists — it returns the formula's own cell address, defaulting to `None` for envs that don't carry one. `WorkbookEnv::with_formula_cell` (env.rs:140) sets it; the structured-ref `[@Col]` narrowing code already consumes it (scalar.rs:489).

The design's R1 also says: *"`eval_scalar_with_cache` does NOT take a call-site parameter today"* — but it takes the env, and the env carries the cell. R1's mitigation ("thread `Option<CallSite>` through `eval_scalar_with_cache`") is therefore unnecessary work.

**Recommendation.** Reuse `formula_cell_for_sref()`. Rename in a follow-up if its current name (sref = structured-ref-specific connotation) becomes load-bearing for multiple consumers — but for v1, just call it. Drop the proposed `CallSite { sheet, row, col }` struct; pass `Address` (already exists, address.rs:35).

The design's `RefContext::call_site` field becomes `formula_cell: Option<Address>`. For `ROW()` zero-arg with no formula cell available (e.g. eval'd in a test path without `with_formula_cell`), return `#REF!` per § 8 R1 — already correct.

**Severity rationale.** MEDIUM because it works as designed; just duplicates an existing API. Implementation cost: low if caught now, more if it ships with the redundant method and we have two ways to ask "what cell?". Keep the env surface minimal.

---

### MEDIUM-3 — Plan cache shares plans for `=ROW()` across cells — correct but not documented

**Where:** Design § 8 R1; `crates/ql-exec/src/plan_cache.rs:73` (`cell_anchor`).

**Detail.** (Originally HIGH-3, downgraded after analysis.) The plan cache keys cell-anchor-dependent plans on `Some((row, col))` only when the formula text contains `@` (implicit intersection, W5-150). For `=ROW()` typed in B5 vs B6, the plan tree is identical (`Function { name: "ROW", args: [] }`) — the cell-specific value comes from the env at eval time, not from the plan. So plan-cache sharing is correct: B5 and B6 share the same plan, but each evaluates against its own env and gets its own row.

However, the design does not explicitly document this. A reader of § 8 R1 might assume `=ROW()` requires a cell-anchored plan-cache key (similar to `@A1:A10`); it does NOT. The cell-dependence lives at the *evaluator*, not the plan.

**Recommendation.** Add to § 8 R1: *"Plan-cache implications: `=ROW()` / `=COLUMN()` plans are cell-INDEPENDENT (the plan tree is `Function { name: "ROW", args: [] }` regardless of cell). The cell-specific result comes from `env.formula_cell_for_sref()` at evaluation time. No `plan_cache.rs` changes required."*

If the dispatcher uses `formula_cell_for_sref()` and the eval site already routes through `WorkbookEnv::with_formula_cell`, no changes to `plan_cache.rs` are needed.

**Severity rationale.** Doc gap. Not a correctness issue if implementer reads existing code; could be a stumbling block if implementer cargo-cults the `@` pattern.

---

### MEDIUM-4 — `RefArg::Range` field names diverge from `ql_types::Range`

**Where:** Design § 5.1, `RefArg::Range { sheet, top_left: (RowId, ColId), bottom_right: (RowId, ColId), values }`.

**Detail.** The design's `top_left` / `bottom_right` use `(RowId, ColId)` tuples. The canonical `ql_types::Range` uses named fields `start_row`, `start_col`, `end_row`, `end_col` (address.rs:60-68) with `top_left() -> Address` / `bottom_right() -> Address` accessor methods returning `Address` (which is itself `{sheet, row, col}`). So the design introduces a third coord convention.

The eval-site `AggregateNameRef.range` is already a `ql_types::Range`. The natural shape for `RefArg::Range` is to just carry the `Range` directly:

```rust
RefArg::Range {
    range: ql_types::Range,
    /// Materialized values, row-major. May be empty if the caller
    /// only needs metadata (ROWS/COLUMNS).
    values: Vec<Value>,
},
```

This:
- Reuses `Range`'s accessors (`top_left()`, `bottom_right()`, `cell_count()`, `contains(addr)`).
- Avoids the tuple naming inconsistency.
- Is one field instead of three (sheet+top_left+bottom_right).

**Recommendation.** Change `RefArg::Range` to carry a single `ql_types::Range` field. Update the pseudo-code in § 5.3, 5.6 accordingly: `top_left: (row, _)` becomes `range.start_row`, `bottom_right.0 - top_left.0 + 1` becomes `range.end_row - range.start_row + 1`.

**Severity rationale.** MEDIUM — works either way, but introducing a parallel coord convention is technical debt against a project already using `ql_types::Range` as canon.

---

### MEDIUM-5 — `RefArg::Literal` adds a fourth variant that only ISREF distinguishes; design § 5.1 admits this and asks Codex

**Where:** Design § 5.1 last paragraph, "ISREF is the only fn that benefits from the four-way split".

**Detail.** The design's `RefArg` has FOUR variants (`Scalar`, `Range`, `Reference`, `Literal`). The only fn that *behaviorally* distinguishes `Scalar` from `Literal` is ISREF (returns FALSE for both, so doesn't actually distinguish). ROW/COLUMN/ROWS/COLUMNS/ISFORMULA/FORMULATEXT all return `#VALUE!` (or `#N/A`) for both `Scalar` and `Literal`.

So `Literal` is **dead weight**. Collapse it into `Scalar`:

```rust
pub enum RefArg {
    Scalar(Value),    // pre-eval'd value, source was not reference-shaped
    Range { range: ql_types::Range, values: Vec<Value> },
    Reference { sheet, row, col, value: Value },
}
```

`ISREF` becomes: `[RefArg::Reference { .. } | RefArg::Range { .. }] => Boolean(true), [RefArg::Scalar(_)] => Boolean(false), _ => #N/A`. Cleaner.

The design § 5.1 already acknowledges this and asks Codex; I'm answering affirmatively: collapse `Literal` into `Scalar`.

**Recommendation.** Drop `RefArg::Literal`. Use `Scalar(Value)` for all pre-evaluated non-reference args.

**Severity rationale.** MEDIUM — design works with 4 variants; cleaner with 3. Cost of changing later (when we have multiple ReferenceAware consumers) is higher than now.

---

### MEDIUM-6 — `ReferenceQuery` separate-trait choice is correct, but the `dyn` plumbing is under-specified

**Where:** Design § 5.5 trait-split option.

**Detail.** The design § 5.5 offers two shapes for the workbook-introspection API:

Option A: methods on `CellEnv`:
```rust
fn is_formula_at(&self, …) -> bool;
fn formula_text_at(&self, …) -> Option<String>;
```

Option B: separate trait:
```rust
fn reference_query(&self) -> &dyn ReferenceQuery;
```

The design "leans toward" Option B but doesn't specify the implementation. For Option B, you need:
- `WorkbookEnv` to implement `ReferenceQuery` (delegating to its `&Workbook`), OR
- `WorkbookEnv` to hold a `&dyn ReferenceQuery` field (extra indirection).

The cleanest shape: have `WorkbookEnv` ALSO implement `ReferenceQuery`, and `CellEnv::reference_query()` returns `self as &dyn ReferenceQuery`. But `CellEnv` is generic-bounded (`E: CellEnv` in the dispatcher), so you can't directly cast a generic `E` to `&dyn ReferenceQuery` without a separate accessor. The accessor needs to be on `CellEnv` itself — which means `CellEnv` grows a method `reference_query(&self) -> &dyn ReferenceQuery`, defaulted to a `NoOpReferenceQuery` for impls that don't have a workbook (MapEnv).

`NoOpReferenceQuery::is_formula_at` returns `false`; `NoOpReferenceQuery::formula_text_at` returns `None`. Same end behavior as Option A's defaults, but with one extra accessor.

The actual "cleaner" shape per the design depends on how dyn-friendly we want to keep `CellEnv`. Today `CellEnv` is used as `E: CellEnv` (generic), NOT `&dyn CellEnv` — the `narrow_structured_ref` signature uses `<E: CellEnv + ?Sized>`. So we DON'T need dyn-compatibility; we CAN have methods returning `&dyn ReferenceQuery`.

**Recommendation.** Confirm the design as Option B (separate trait, accessor on CellEnv). Add to § 5.5:

```rust
pub trait CellEnv {
    // existing methods…
    fn reference_query(&self) -> &dyn ReferenceQuery {
        // Default impl returns a no-op singleton; only WorkbookEnv overrides.
        &NoOpReferenceQuery
    }
}

pub trait ReferenceQuery {
    fn is_formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> bool;
    fn formula_text_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<String>;
}

struct NoOpReferenceQuery;
impl ReferenceQuery for NoOpReferenceQuery {
    fn is_formula_at(&self, _: SheetId, _: RowId, _: ColId) -> bool { false }
    fn formula_text_at(&self, _: SheetId, _: RowId, _: ColId) -> Option<String> { None }
}

impl ReferenceQuery for ql_storage::Workbook {
    fn is_formula_at(&self, s, r, c) -> bool { self.formula_at(s, r, c).is_some() }
    fn formula_text_at(&self, s, r, c) -> Option<String> {
        self.formula_at(s, r, c).map(|arc| {
            // Excel canon: FORMULATEXT includes the leading `=`.
            let mut out = String::with_capacity(arc.len() + 1);
            out.push('=');
            out.push_str(arc);
            out
        })
    }
}

impl<'w> CellEnv for WorkbookEnv<'w> {
    fn reference_query(&self) -> &dyn ReferenceQuery {
        self.workbook  // workbook also impls ReferenceQuery; returned directly
    }
}
```

This wires through cleanly without forcing every test mock to grow methods. Note the `=` prepending — Excel canon.

**Severity rationale.** MEDIUM — design picks the right shape but the plumbing (especially generic-vs-dyn handling) needs explicit pseudo-code, otherwise the implementer may default to Option A and clutter MapEnv / CustomCtxEnv.

---

### MEDIUM-7 — Test plan § 7 is too thin given the architectural-novelty surface

**Where:** Design § 7.

**Detail.** The design § 7 says "6 tests per fn, ≥1 LibreOffice cross-check per fn." For an architectural change introducing a new dispatch tier, 6 is the floor, not the ceiling. Missing classes that ought to be covered:

1. **Cross-sheet refs** — `ISFORMULA(Sheet2!A1)` / `FORMULATEXT(Sheet2!A1)`. Sheet-ID round-trip is a known foot-gun (W5-71 / W5-153 had locale-aware EvalContext drift). Need ≥1 cross-sheet test per fn that takes a Reference (5 fns).
2. **Named-range args** — `ROWS(NamedRange)` / `ROW(SomeNamedCell)` — given today's binder only accepts ranges via NameRef → AggregateNameRef, this is the *primary* path that works without resolving HIGH-1. Test ≥1 named-range case per range-taking fn.
3. **Structured-ref args** — `ROWS(Sales[Qty])` / `ROW(Sales[@Qty])` — the W5-115/117 structured-ref path materializes into either `AggregateNameRef`-equivalent (full column) or single-cell-narrowed (via formula_cell). Both ROW and ROWS need a test against this.
4. **Implicit-intersection interaction** — `=@ROW(A1:A10)` — does the `@` wrap narrow before or after ROW evaluates? Per design § 1.2.1's deferred spill semantics, single-arg ROW returns top-left regardless; `@` should be idempotent. Pin with a test.
5. **Workbook row-limit edge** — `ROWS(A:A) == 1_048_576` (max), `ROW(XFD1048576) == 1_048_576`. Two boundary tests at MAX_ROW / MAX_COLUMN.
6. **`#REF!` propagation** — what does `ROW(#REF!)` return? Excel: `#REF!` (errors propagate). Our pseudocode has no test for this.
7. **Mixed sheet whole-column** — `ROWS(Sheet2!A:A)` — exercises `RangeRef::WholeColumn` × cross-sheet binding; the binder path currently rejects literal `RangeRef` (HIGH-1) so this is a HIGH-1-blocker test that documents the expected post-fix behavior.
8. **ISREF on a function call return** — `ISREF(SUM(A1:A3))` returns FALSE; `ISREF(IF(TRUE, A1, B1))` — Excel: TRUE (IF can return a reference). Our v1: FALSE (no reference-returning fns yet). Test pins the v1 semantics so we don't accidentally change it when OFFSET ships.
9. **ISREF arg evaluation suppression** — `ISREF(1/0)` must return FALSE without propagating `#DIV/0!`. See HIGH-2 — if implemented eagerly, this test fails.

Total: ≥9 additional cross-cutting tests on top of the per-fn 6. Recommendation: 8-10 tests per fn (60-70 total), with a separate "cross-cutting" suite for items 1, 4, 7, 9.

**Recommendation.** Expand § 7 to specify:
- Per-fn: 8 tests minimum (current 6 + cross-sheet + `#REF!` propagation).
- Cross-cutting suite: 6 tests covering structured-ref, implicit-intersection, row-limit, ISREF-no-eval, ISFORMULA-on-blank-cell, FORMULATEXT-leading-`=`.
- LibreOffice cross-check: 2 per fn (top-left case + edge case), not 1.

**Severity rationale.** MEDIUM because the existing plan is "ship something" — the additional coverage is the difference between "compiles + happy-path works" and "production-grade".

---

### MEDIUM-8 — `FunctionRegistry::lookup_reference_aware` and `register_reference_aware` need disjointness audit against existing tier-specific methods

**Where:** Design § 5.2; `crates/ql-functions/src/registry.rs:300-340`.

**Detail.** Today's registry has `names()`, `range_aware_names()`, `context_aware_names()`, `unified_names()`, `names_all()`. The reference-tier addition needs a `reference_aware_names()` iterator. Coverage report code (mentioned in design § 6 Step 2: "Add EXPLICITLY_DEFERRED → registered transitions in `coverage.rs`") must list the new tier. Without it, the 7 new fns count toward `names_all()` but not toward any tier-specific iterator — coverage walks miss them.

**Recommendation.** Add to design § 5.2: `pub fn reference_aware_names(&self) -> impl Iterator<Item = &&'static str> + '_` filter on `RegisteredFn::ReferenceAware(_)`. Step 1 commit lists this in the diff.

**Severity rationale.** LOW-MEDIUM — coverage report omission could mask "new fn not registered through any tier" bugs. Easy to catch in pre-commit CI but worth pinning in the design.

---

### MEDIUM-9 — § 9 acceptance count is wrong (197 → 200 = +3, but +7 new = 200; double-check arithmetic)

**Where:** Design § 6 Step 5 final, § 9 "197 → 200 registered fns (+7 new)."

**Detail.** Step 2 ends at 197 (4 fns added). Step 4 ends at 199 (+2). Step 5 ends at 200 (+1). Total +7 from 193: 193 + 7 = **200**. So the final count is correct: 200, not 200 (197 → 200 in Step 5 is technically +3, but Step 4 has already added 2 to reach 199 before Step 5's +1).

Re-checking: Step 2 says "193 → 197 (+4)". Wait, Steps 1-2 doesn't say 193 — let me re-read design. § 6 Step 2: *"Bump `default_registry_has_expected_count` (193 → 197)."* — that's the test count bump after Step 2 (adding ROW/COLUMN/ROWS/COLUMNS = 4 fns). Step 4: *"197 → 199. Update matrix."* — adding ISREF/ISFORMULA = 2 fns. Step 5: *"199 → 200. Update matrix."* — adding FORMULATEXT = 1 fn. Total: 4+2+1 = 7 ✓.

So § 9 "197 → 200" is a TYPO (should be 193 → 200). The "+7 new" is correct. The arithmetic between the steps is consistent.

**Recommendation.** Fix § 9: change "197 → 200 registered fns" to "193 → 200 registered fns".

**Severity rationale.** LOW (typo). Listed MEDIUM only because the acceptance criteria sets the gate; a wrong number could cause the verification test to fail unexpectedly.

---

### MEDIUM-10 — `Range` with cross-sheet `top_left.sheet == bottom_right.sheet` invariant is design-stated but not enforced

**Where:** Design § 5.1: *"`top_left.sheet == bottom_right.sheet`; 3D ranges are out of scope for v1 (IronCalc errors them too)."*

**Detail.** The design notes 3D ranges (`Sheet1:Sheet3!A1:A10`) are out of scope. But the comment is about a design *promise*, not a runtime check. If a future code path constructs `RefArg::Range` with mismatched sheets, behavior is undefined.

The shape with a single `ql_types::Range` field (MEDIUM-4 recommendation) eliminates this concern automatically — `Range` only carries one `sheet: SheetId` field (address.rs:60), so 3D is structurally impossible.

**Recommendation.** Adopting MEDIUM-4's single-Range field closes this.

**Severity rationale.** MEDIUM as a check on architectural integrity. Combined with MEDIUM-4.

---

### MEDIUM-11 — D2 → D1 migration plan is hand-waved; no trigger condition

**Where:** Design § 4 "Recommended: D2 for v1, with a written plan to migrate to D1 in a follow-on phase."

**Detail.** The audit prompt asks: *"Is that migration plan realistic? Estimate effort. Identify the trigger condition that should cause migration."* The design doesn't supply either.

Trigger conditions for D1 (ParamSchema):
1. When a 6th dispatch tier is needed — the W5-96 trigger comment ("if Phase 4.7 array formulas need yet ANOTHER tier"). Reference-tier IS the 5th tier under D2; the next addition (lambda? LAMBDA fn? user-defined fn registry?) makes ParamSchema cheaper than yet-another-parallel-tier.
2. When the `is_aggregate_function` hardcoded list crosses ~50 entries — at 35 today, +7 reference-tier = 42; +30-40 from Wave 3 distributions/depreciation/financials lands us at 70-80. Maintenance burden exceeds rewrite cost.
3. When per-arg position semantics emerge (e.g., XLOOKUP arg 2 is range, args 1/3/4 are scalar, args 5/6 are mode flags). Today's all-args-or-none-args treatment doesn't scale.

Effort estimate for D2 → D1:
- New `ParamSchema { arg_shapes: Vec<ArgShape> }` type.
- Per-fn registration adds a schema.
- Binder consults schema instead of `is_aggregate_function`.
- Dispatcher consults schema for arg materialization.
- Coverage walks (`names_all` etc.) collapse to one with schema-tier filtering.

Estimated effort: 2-3 days for the refactor + 1-2 days for the cross-fn audit (193 fns × verify-schema-matches-actual-behavior). Total: 3-5 days, similar to reference-tier itself. Triggers: condition 2 (50-entry threshold) is hit fastest — Wave 3 closure.

**Recommendation.** Add to § 4 a § 4.A "D1 migration plan":
- Trigger: when `is_aggregate_function` hardcoded list crosses 50 names OR when a 6th tier is proposed.
- Effort: 3-5 days.
- Scope: rewrite registry storage to `HashMap<name, (RegisteredFn, ParamSchema)>`; rewrite dispatcher's per-fn arm to one schema-driven loop.
- Risk: 193-fn behavior must be preserved; per-fn schema audit needed.

**Severity rationale.** MEDIUM — affects future planning, not current correctness. Listed because the audit prompt asked.

---

## LOW findings

### LOW-1 — § 0 introductory list has a duplicated bullet

**Where:** Design § 0, sentence enumerating function needs.

**Detail.** `ROW(A1)`, `ROW()`, `ROWS(A1:B3)`, `ISREF(A1)`, `ISFORMULA(A1)`, `FORMULATEXT(A1)`. Missing: `COLUMN`, `COLUMNS`. The bullets aren't symmetric (no COLUMN/COLUMNS examples). Suggest a minor edit for symmetry. (Skip if pressing on; not load-bearing.)

---

### LOW-2 — § 1.2 explicit-defer list mentions ADDRESS twice (under "Out of scope" and under "Wave 3 candidates" in the predecessor doc)

**Where:** Design § 1 "Out of scope" — `OFFSET / ADDRESS / INDIRECT`; design 4.10's W2 doc lists `ADDRESS` in 4.10.G.

**Detail.** The 2026-05-16 Wave 2 design (line 27) lists ADDRESS in batch 4.10.G (XLOOKUP/XMATCH+ADDRESS, status active). This new reference-tier doc § 1 "out of scope" lists `OFFSET / ADDRESS / INDIRECT`. They conflict — is ADDRESS in 4.10.G or deferred to reference-tier? Verify against actual registry HEAD.

<details>
<summary>Verification</summary>

`crates/ql-functions/src/registry.rs:default_registry()` listing was checked at lines 358-450; ADDRESS not yet registered there.
</details>

**Recommendation.** Clarify: ADDRESS is a 4.10.G item (Wave 2 PART 1), not reference-tier. Update reference-tier § 1 out-of-scope to mention only `OFFSET / INDIRECT`. Remove `ADDRESS` from the line. Cross-link the 4.10 doc's batch 4.10.G as the canonical ADDRESS plan.

---

### LOW-3 — § 5.6 pseudocode uses `Value::error(ErrorValue::Value)` but actual API is `Value::Error(ErrorValue::Value)` (capital E)

**Where:** Design § 5.6 throughout; the API is `Value::Error(ErrorValue::Value)` (variant of the `Value` enum), not `Value::error(...)`.

**Detail.** Look at existing fns in `crates/ql-functions/src/scalar_fns.rs` — they use `Value::Error(ErrorValue::Value)` (capital E). The design uses `Value::error(ErrorValue::Value)` (lowercase) — that's a constructor-method name that doesn't exist. Same for `Value::Boolean(true)`.

**Recommendation.** Fix pseudo-code: lowercase `value::error(...)` → `Value::Error(...)`. (Note: `Value::number(...)` IS a real method — `pub fn number(n: f64) -> Self` — but `Value::error(...)` is not. Differentiate.)

---

### LOW-4 — § 7 "≥1 LibreOffice cross-check per fn" — no concrete reference values supplied

**Where:** Design § 7 last bullet.

**Detail.** The design says "Codex (in pre-review or audit) should propose ≥1 reference value per fn from a known LibreOffice OpenFormula run." This pushes the work to Codex / audit, which is fine, but the design SHOULD include the values in the test plan so the implementer doesn't have to guess. For 7 fns × 1 value = 7 values. They're trivially obtained from a LibreOffice run.

**Recommendation.** Supply concrete reference values in § 7 table form:
- `ROW(A1)` → `1` (LibreOffice 7.6, default config).
- `COLUMN(A1)` → `1`.
- `ROWS(A1:A5)` → `5`.
- `COLUMNS(A1:E1)` → `5`.
- `ISREF(A1)` → `TRUE`.
- `ISFORMULA(A1)` where A1 has formula `=1+2` → `TRUE`.
- `FORMULATEXT(A1)` where A1 has formula `=1+2` → `"=1+2"`.

Each value carries 1 test that exercises the cross-check. Then audit / Codex adds 1+ MORE per fn for the harder cases.

---

### LOW-5 — § 10 question 8 "Excel canon: IRL FORMULATEXT(A1:B3) returns formula at A1" — citation needed

**Where:** Design § 10 question 8.

**Detail.** The claim "Excel canon: IRL FORMULATEXT(A1:B3) returns formula at A1 (top-left implicit intersection), not an error" is asserted without citation. Excel's actual behavior on `=FORMULATEXT(A1:B3)`:
- Pre-365 Excel: implicit-intersect down to cell-of-formula's row × A1's col. So `B5 = FORMULATEXT(A1:B3)` returns `#VALUE!` if B5 is outside the range, else the formula at the intersection.
- Excel 365 with dynamic arrays: spills the FORMULATEXT result over the 2×3 range — each cell shows its corresponding formula.

The design's pre-365 / 365 split is glossed. IronCalc's "single cell required" matches Excel 365 in array context (where the formula would spill but isn't allowed to), and pre-365 implicit-intersection (where the result is the intersection cell's formula).

**Recommendation.** Update § 10 question 8 with the pre-365 vs Excel-365 distinction. Recommend matching IronCalc (multi-cell → `#N/A` per MEDIUM-1) as v1 — consistent with our deferred spill story (§ 8 R5).

---

### LOW-6 — Status line claims "Codex pre-review pending" but doesn't commit to parallel-Opus pre-review

**Where:** Design § 0 status line.

**Detail.** The 2026-05-17 audit-discipline rule (memory) is parallel-Codex + separate-Opus. The status line says only "Codex pre-review pending." The actual practice this session is parallel-Codex+Opus (this audit). Update the status line:

"Codex + Opus pre-review pending — per the 2026-05-17 audit-discipline rule, both run in parallel before any code lands."

This ensures future readers see both pre-reviews are required, not one-or-the-other.

---

### LOW-7 — § 6 Step 3 says "Step 2.1 if findings" but the audit-summary doc lives elsewhere

**Where:** Design § 6 Step 3.

**Detail.** Inconsistent step numbering. If Step 3 IS "audit" and audit-step closure adds a sub-commit, the sub-commit should be "Step 2.1" (audit closure of Step 2's commit). But Step 3 also says outputs go in `docs/audits/2026-05-17-reference-tier-step-2-{codex,opus}.md`. Should the step be renamed "Step 2.1 — Parallel Codex + Opus audit on Step 2"?

**Recommendation.** Renumber: Step 3 → "Step 2.A: Parallel Codex + Opus audit on Step 2". Step 5 → "Step 4.A: Parallel Codex + Opus audit on Steps 3+4". This makes the closure-as-suffix pattern explicit, matching prior session conventions.

---

### LOW-8 — Spec ID convention missing

**Where:** Design § 0 header.

**Detail.** The Wave 2 design (2026-05-16) carries a "Spec ID: FN4-260-01". This new doc doesn't. Add one (e.g. RT-V1-01 for "Reference-tier v1, spec ID 01") for traceability into the matrix.

---

### LOW-9 — § 8 R8 "Disjointness panic in registry already prevents cross-tier collision, so order is just for readability." — correct but understated

**Where:** Design § 8 R8.

**Detail.** Confirmed: `FunctionRegistry::insert_or_panic` (registry.rs:184) asserts `prior.is_none()`. So order in the dispatcher `match` arms is purely stylistic. The current order (RangeAware → ContextAware → Unified → Scalar) is established in scalar.rs:169-432; adding ReferenceAware ahead of Scalar is consistent. R8's "for readability" understates the point — the disjointness invariant is enforced at REGISTRATION time, not dispatch time. Worth noting in the design that dispatch-time match-order is purely a style choice, with no semantic consequence.

---

## Cross-cutting hits the design missed (audit prompt item 11)

- **Test invariant `is_aggregate_function_lists_only_registered_aggregates`** (HIGH-3). Already addressed.
- **`walk_plan_for_deps` for reference-tier** (HIGH-4). Already addressed.
- **`plan_cache.rs` cell-anchor key** (MEDIUM-3). Already addressed.
- **Coverage walk in `coverage.rs`** (MEDIUM-8). Already addressed.
- **The Coverage matrix `docs/compat/excel-matrix.md`** — already mentioned in design § 6, but the test invariant that pins matrix rows against registry contents (`test_matrix_lists_registered_fns` or similar) needs to be checked for the 7 new rows. Not blocking.
- **IDE diagnostic surfaces** (`validate_formula` at workbook_runtime.rs:2942) — for `=ROW()` zero-arg, `validate_formula` typically runs without a formula cell. Per § 8 R1's mitigation, returns `#REF!`. Test it.
- **Op-log replay** — `set_formula(B5, "=ROW()")` on replay needs the formula cell to evaluate correctly. Verify that `WorkbookRuntime::recompute_dirty` (the replay-side recompute) uses `WorkbookEnv::with_formula_cell`. Quick check: workbook_runtime.rs:3637 — `WorkbookEnv::with_formula_cell(self.workbook, ql_types::Address::new(...))`. ✓ — replay path is correct.
- **Export/import** — qbook round-trip. Formula source text is stored in the qbook format already (uses `formula_at`). FORMULATEXT round-trips through serialization correctly.

## Audit-discipline self-application (audit prompt item 12)

The design § 6 Step 3 mentions "Parallel Codex + Opus audit" at the end of Step 2 batch. Step 6 mentions "Parallel Codex + Opus audit on Steps 4+5". So 2 audit cycles total — one after Steps 1-2, one after Steps 3-4-5. **This matches the 2026-05-17 audit-discipline rule** ("After each phase/wave/implementation … run parallel Codex + separate-Opus audits"). ✓

The design does NOT, however, commit to audit-on-EACH-commit; it bundles Steps 4 + 5 into one audit cycle. Per the rule's "after each ship commit" wording, the design should audit after Step 4 AND after Step 5 separately. Step 5 introduces source-text retention (FORMULATEXT-specific) — a distinct architectural surface from Step 4's information-fn batch. Bundling them risks one audit cycle missing the source-text retention nuances.

**Recommendation.** Split Step 6 into Step 4.A (audit Step 4 only) and Step 5.A (audit Step 5 only). 3 audit cycles total. Slight overhead but tighter coverage.

---

## Summary

| Severity | Count |
|----------|-------|
| HIGH | 7 |
| MEDIUM | 11 |
| LOW | 9 |
| **Total** | **27** |

Top critical issues (must close before code):
1. **HIGH-1** — binder rejects `Expr::RangeRef` unconditionally; design's B1 strategy doesn't bind `ROWS(A1:B3)` etc.
2. **HIGH-2** — eager arg eval in `materialize_ref_arg` breaks ISREF lazy semantics.
3. **HIGH-3** — `is_aggregate_function_lists_only_registered_aggregates` test will break at Step 1; design doesn't list maintenance.
4. **HIGH-4** — dep extractor over-tracks reference-tier deps; ROW/COLUMN recompute on every value change.
5. **HIGH-5** — source-text retention is already in `Workbook::formula_at`; R3 deferral wastes Step 1.
6. **HIGH-6** — `RowId.0` syntax in pseudocode is invalid (RowId is a type alias, not a newtype).
7. **HIGH-7** — § 2.2 incorrectly claims the binder pins WholeColumn count; the @ path narrows, the fn-arg path rejects.

Top maintainability concerns:
1. **MEDIUM-1** — FORMULATEXT error class should be `#N/A`, not `#VALUE!`.
2. **MEDIUM-2** — `call_site()` is redundant; `formula_cell_for_sref()` exists.
3. **MEDIUM-4** — `RefArg::Range` should carry `ql_types::Range` directly.
4. **MEDIUM-5** — drop `RefArg::Literal`; collapse into `Scalar`.
5. **MEDIUM-7** — § 7 test plan thin; recommend 8-10 tests per fn + cross-cutting suite.

Recommendation: do not start Step 1 until at least HIGH-1, HIGH-3, HIGH-5, HIGH-6, HIGH-7 are closed in the design doc. HIGH-2 / HIGH-4 can be closed at implementation time (in the impl PR) but the decision must be in the design doc first.
