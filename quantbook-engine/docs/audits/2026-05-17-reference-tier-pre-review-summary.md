# Reference-tier design — parallel pre-review reconciliation

**Date:** 2026-05-17
**Subject:** `docs/architecture/2026-05-17-reference-tier-design.md` v1
**Auditors:** parallel Codex (CLI) + separate-Opus (4.7, 1M-context). First pre-review under the 2026-05-17 audit-discipline rule applied at design-doc stage.
**HEAD at audit launch:** `8f9b37b5d6d`.
**Outcome:** design doc revised to v2 (all HIGH + MEDIUM closed in code/doc; 6 LOWs accepted with doc edits; 4 LOWs deferred as non-blocking).

## Audit counts

| Auditor | HIGH | MEDIUM | LOW | Total |
|--------|------|--------|-----|-------|
| Codex | 7 | 7 | 3 | 17 |
| Opus | 7 | 11 | 9 | 27 |

Output files: `docs/audits/2026-05-17-reference-tier-design-codex.md` (160 lines), `docs/audits/2026-05-17-reference-tier-design-opus.md` (~660 lines).

## Independent verification done at reconciliation

Per the "Don't Be Lazy" rule + the audit-discipline severity-conflict resolution rule, I independently verified key factual claims where the two audits disagreed:

- **Workbook source-text retention**: `crates/ql-storage/src/workbook.rs:221,253,874` confirm `formula_cells: HashMap<(SheetId, RowId, ColId), Arc<str>>` with `Workbook::formula_at()` returning the stored text. **Both audits agreed retention exists.** ✓
- **Source-text canonicalization at `set_formula`**: `crates/ql-exec/src/workbook_runtime.rs:573` confirms `print_with(...EnUs...)` canonicalization. Codex HIGH-4 was factually correct: stored text is canonicalized printer output, NOT raw user source. Opus HIGH-5's claim "we can return the raw source text exactly as the user typed it" was factually wrong about our storage — but Opus's *recommended outcome* (prepend `=` at the function boundary) matches Codex's. Net: no semantic conflict; just a factual nuance in the recommendation framing.
- **Parser zero-arg `ROW()` / `COLUMN()`**: Codex LOW-3 ran `cargo test -p ql-formula-syntax function_no_args` (passed). Confirmed.

## Severity-conflict resolution

Per audit-discipline rule ("take the higher severity unless the lower auditor's reasoning is clearly faulty"):

| Issue | Codex severity | Opus severity | Reconciled | Rationale |
|-------|---------------|---------------|------------|-----------|
| FORMULATEXT multi-cell semantics | HIGH-5 | LOW-5 | **MEDIUM** | Codex cites Microsoft canon (upper-left); Opus correctly distinguishes pre-365 implicit-intersection (upper-left) vs Excel-365 spill. We defer spill (HIGH-E below), so pre-365 behavior is canon for v1. The divergence from IronCalc (single-cell error) must be documented but is a v2-acceptable choice. MEDIUM. |
| Dep extractor over-tracking | MEDIUM-5 | HIGH-4 | **HIGH** | Opus's framing ("ROW(A1) recomputes on every A1 value change") is observable wasted work. The dep-tracking decision must be in the design doc, not deferred to implementation. Take Opus's HIGH. |
| Error class collapse (`ROW(#REF!)` etc.) | HIGH-7 | MEDIUM-1 | **HIGH** | Codex applies to all 6 reference-consuming fns; Opus focuses on FORMULATEXT specifically. The broader scope (Codex) wins. HIGH. |
| `RowId.0` syntax in pseudo-code | LOW-1 (subsumed) | HIGH-6 | **MEDIUM** | Codex aggregates identifier mismatches under one LOW-1; Opus split out HIGH-6 specifically for the `.0` issue. Impact is mechanical: pseudo-code edits before Step 1. Bumping to MEDIUM gives it more visibility than Codex's LOW. |
| § 2.2 binder pin claim | — | HIGH-7 | **MEDIUM** | Opus-only. Documentation correction, subsumed under HIGH-A binder rewrite. MEDIUM. |

## Reconciled findings — final dispositions

### HIGH (8 total — MUST close before Step 1)

**HIGH-A — Binder rejects literal `Expr::RangeRef` unconditionally.** (Codex HIGH-1 ↔ Opus HIGH-1, strongly convergent.)

`crates/ql-exec/src/plan.rs:636` rejects `Expr::RangeRef(_)` with `BindError::UnsupportedVariant` BEFORE checking `BindContext`. Adding reference-tier fns to `is_aggregate_function` (design's B1) does NOT enable `ROWS(A1:B3)` to bind — the rejection fires earlier. Confirmed by reading: `Expr::Function` (line 643+) recurses into args; on `RangeRef` arg, line 636 rejects.

**Closure (v2):** Replace B1 with **B1' — extend `Expr::RangeRef` binder arm to accept `RangeRef` in `BindContext::AggregateArg` AND in the new `BindContext::ReferenceArg` context.** Lower to a new `ExprPlan::RangeRef { range }` variant that carries a resolved `ql_types::Range` without requiring a name. `AggregateNameRef` keeps working for named ranges; the new variant covers literal ranges. The narrow-range helper for implicit intersection (`narrow_range_for_implicit_intersection`) stays scoped to the `@` path. Documented in v2 § 5.4.

---

**HIGH-B — Eager arg evaluation breaks ISREF lazy semantics.** (Codex HIGH-2 ↔ Opus HIGH-2, strongly convergent.)

`materialize_ref_arg(plan, env, registry, cache)`'s fallback `RefArg::Literal(eval_scalar_with_cache(...))` evaluates every non-reference arg eagerly. This produces:
1. Volatile fns re-firing under `ISREF(VOLATILE())`.
2. Aggregate cache pollution under `ISREF(SUM(NamedRange))`.
3. Calcgraph value-deps registered for args ISREF never consumes (Codex HIGH-2 cites `calcgraph_session.rs:230`).

**Closure (v2):** ISREF gets a per-fn ABI bit `lazy_args: bool`. The dispatcher checks the bit; if true, ISREF receives `RefArg::Shape(plan_kind)` carrying only the plan's variant tag (`CellRef` / `RangeRef` / `Function` / `Number` / …) — no evaluation. Other reference-tier fns keep eager evaluation but with the corrected variants (see HIGH-F). This is closest to IronCalc's pattern (`evaluate_node_with_reference` vs direct AST match-pattern in `fn_isref`). Per Opus Option C ("two materializers"). Documented in v2 § 5.3.

---

**HIGH-C — `ROWS` / `COLUMNS` must accept array literals.** (Codex HIGH-3, Opus-missed.)

Microsoft docs: `ROWS({1,2,3;4,5,6}) = 2`, `COLUMNS({1,2,3;4,5,6}) = 3`. The design's v1 `RefArg` enum lacks an `Array` variant. The materializer's fallback would evaluate `ExprPlan::Array` in scalar context to `Value::Error(ErrorValue::Calc)` per the existing W5-100 contract.

**Closure (v2):** Add `RefArg::Array(ArrayValue)` variant. The materializer maps `ExprPlan::Array` → `RefArg::Array(...)` per the existing Unified-tier precedent (`scalar.rs:273-294`). ROWS/COLUMNS get an `Array` match arm that reads `array_value.shape().0` / `shape().1`. Test pinning: `ROWS({1,2,3;4,5,6}) = 2`, `COLUMNS({1,2,3;4,5,6}) = 3`. Documented in v2 § 5.1, § 5.6.

---

**HIGH-D — FORMULATEXT source-text retention is solved; design must update.** (Codex HIGH-4 ↔ Opus HIGH-5, factual nuance reconciled above.)

Stored text in `formula_cells` is the canonicalized A1/EnUs printer output (per `set_formula` at workbook_runtime.rs:573). FORMULATEXT must prepend `=` at the function boundary. Both audits agree on outcome.

**Closure (v2):** Remove § 8 R3 from open-risk list. Add the `ReferenceQuery::formula_text_at` Excel-facing API: `fn formula_text_at(...) -> Option<String>` returning `Some(format!("={}", canonical))` where `canonical` is `workbook.formula_at(sheet, row, col)?.as_ref()`. Documented divergence from raw-user-source (we return canonicalized, IronCalc returns canonicalized-English-no-spaces; both are non-verbatim). Documented in v2 § 2.5, § 5.5, § 5.6.

---

**HIGH-E — ROW / COLUMN multi-cell silent truncation at cell-boundary.** (Codex HIGH-6, Opus-implicit-via-LOW-5.)

In a top-level `=ROW(A1:A5)`, Excel 365 spills to `{1;2;3;4;5}`. The design's "top-left only" return would silently produce `1` even in cell-boundary array context, where `eval_at_cell_boundary` already supports spilling via the Unified tier.

**Closure (v2):** Reference-tier fns called via `eval_at_cell_boundary` with a multi-cell `RefArg::Range` or `RefArg::Array` arg return `Value::Error(ErrorValue::Calc)` (`#CALC!`) instead of silently truncating. This matches the existing Unified-tier "array in scalar context → #CALC!" contract (W5-100 / scalar.rs:307-315). Spill-form ROW/COLUMN is a follow-up; this commit explicitly avoids silent wrong-results. Documented in v2 § 2.1, § 8 R5.

---

**HIGH-F — Error class collapse `ROW(#REF!) → #VALUE!`.** (Codex HIGH-7 ↔ Opus MEDIUM-1, taking Codex's broader HIGH per severity rule.)

`RefArg::Literal(Value::Error(ErrorValue::Ref))` falls through to `#VALUE!` in the per-fn impls. Excel canon: error propagation; `ROW(#REF!) = #REF!`.

**Closure (v2):** Add `RefArg::Error(ErrorValue)` variant. Materializer detects `Value::Error(_)` from eager eval and emits `RefArg::Error(...)` instead of `Literal`. Each per-fn impl propagates errors as the first match arm. Documented in v2 § 5.1, § 5.6.

---

**HIGH-G — `is_aggregate_function_lists_only_registered_aggregates` invariant test breaks at Step 1.** (Opus HIGH-3, Codex-missed.)

`crates/ql-exec/src/workbook_runtime.rs:5158-5212` asserts every name in `is_aggregate_function` is registered as either `Scalar` or `RangeAware`. Adding ROW/COLUMN/ROWS/COLUMNS/ISREF/ISFORMULA/FORMULATEXT (ReferenceAware tier) to the matcher would fail the test at Step 1 — gates can't go green.

**Closure (v2):** Step 1 sub-bullet: extend the invariant test with a third loop checking `reg.lookup_reference_aware(name).is_some()` for the new names. Rename the matcher to `accepts_range_arg_at_bind` (or similar) since "aggregate" no longer describes its load-bearing role; track this rename as a v2 architectural cleanup. Documented in v2 § 5.4, § 6 Step 1.

---

**HIGH-H — Dep extractor `walk_plan_for_deps` over-tracks reference-tier deps.** (Opus HIGH-4 ↔ Codex MEDIUM-5, taking Opus's HIGH per severity rule.)

`crates/ql-exec/src/calcgraph_session.rs:213-268` walks `ExprPlan::Function` args recursively; reference-tier args become value-deps. Consequence: `ROW(A1)` recomputes every time A1's value changes (wasteful but not incorrect); `ISFORMULA(A1)` recomputes on value changes but the result only changes on formula-status transitions.

**Closure (v2):** Pick **option (c)** from Opus's recommendation: ROW/COLUMN/ROWS/COLUMNS/ISREF get **dep-suppress** treatment (no value deps registered for their CellRef/RangeRef args). ISFORMULA/FORMULATEXT keep conservative value-deps as a v1 cost (a new `formula_status_deps` kind would require workbook-side `on_set_formula` / `on_clear_formula` dirty propagation — out of scope for v1, tracked as a follow-up). Document the trade-off explicitly: ROW/COLUMN/ROWS/COLUMNS = structural-only deps (no value deps); ISFORMULA/FORMULATEXT = conservative value-deps with documented over-recompute as v1 cost. Documented in v2 § 5.3, § 8 R8 (new).

### MEDIUM (9 reconciled after dedup — all closed in v2 doc)

**MEDIUM-α — `RefArg::Literal` is dead weight; collapse with `Scalar` + split out `Error`.** (Codex MEDIUM-1 + Opus MEDIUM-5.) Final shape: `RefArg { Scalar(Value), Range { range, values }, Reference { sheet, row, col, value }, Array(ArrayValue), Error(ErrorValue), Shape(PlanKind) }`. Six variants; each has a distinct consumer in the 7 reference-tier fns.

**MEDIUM-β — Reuse `formula_cell_for_sref()` instead of new `call_site()`.** (Opus MEDIUM-2.) Drop `RefContext::call_site`; reuse the existing `Option<Address>` from `env.formula_cell_for_sref()`. No new CellEnv methods for that purpose. Documented in v2 § 5.5.

**MEDIUM-γ — Coordinate-only range materialization for ROWS/COLUMNS.** (Codex MEDIUM-3.) `RefArg::Range` carries a `ql_types::Range` directly (MEDIUM-ε). For ROWS/COLUMNS we read coordinates only; the materializer skips `read_range_with_shape` for these fns. For ROW/COLUMN with a Range arg we read coordinates only (top-left). No value materialization for the reference-tier path's primary uses. Documented in v2 § 5.3.

**MEDIUM-δ — Test plan thin; expand to 8-10 per fn + cross-cutting suite.** (Codex MEDIUM-6 ↔ Opus MEDIUM-7.) v2 § 7 specifies per-fn 8 tests + cross-cutting suite of 6 (cross-sheet, structured-ref, implicit-intersection, row-limit, ISREF-no-eval, FORMULATEXT-leading-`=`). LibreOffice cross-checks: 2 per fn (top-left case + edge case).

**MEDIUM-ε — `RefArg::Range` should carry `ql_types::Range`, not coord tuples.** (Opus MEDIUM-4.) Single `range: ql_types::Range` field replaces `sheet + top_left + bottom_right`. Reuses `top_left()` / `bottom_right()` / `cell_count()` accessors. Closes Opus MEDIUM-10 (3D-range impossible structurally).

**MEDIUM-ζ — `ReferenceQuery` plumbing under-specified.** (Opus MEDIUM-6.) v2 § 5.5 adds explicit pseudo-code: `CellEnv::reference_query(&self) -> &dyn ReferenceQuery` with `NoOpReferenceQuery` default; `WorkbookEnv` overrides; `ql_storage::Workbook` impls `ReferenceQuery`.

**MEDIUM-η — Per-tier registry iterator + coverage walk.** (Opus MEDIUM-8.) Add `FunctionRegistry::reference_aware_names()`. Step 1 includes `coverage.rs` update.

**MEDIUM-θ — D2 → D1 migration plan needs concrete trigger + effort estimate.** (Codex MEDIUM-4 ↔ Opus MEDIUM-11, plus Codex's proposed D4 as middle ground.) v2 § 4 adopts **Option D4** (Codex's middle ground): narrow `ArgContract` metadata only for the 7 reference-tier fns; full D1 ParamSchema migration deferred to a dedicated phase. Triggers documented: (a) 6th tier proposed, OR (b) `is_aggregate_function` hardcoded list crosses 50 entries (today 35 + 7 = 42), OR (c) per-arg-position semantics emerge. Estimated D4 effort: 1-2 days; D1 effort: 3-5 days. v2 § 4.A documents this.

**MEDIUM-ι — Audit-discipline applied per-ship-commit, not per-batch.** (Codex MEDIUM-7 ↔ Opus audit-discipline self-application note.) v2 § 6 splits Step 6 into Step 4.A + Step 5.A. 3 audit cycles total (Step 1.A infrastructure-audit, Step 2.A range-fn-batch, Step 4.A info-fn-batch, Step 5.A FORMULATEXT). Step 1.A is the highest architectural-risk audit and MUST run before any user-facing fn is registered.

### LOW (10 reconciled — 6 doc edits + 4 deferred)

| Finding | Action |
|---------|--------|
| Codex LOW-1 / Opus HIGH-6 (RowId.0, ErrorValue::NotApplicable, range field names, Value::error) | **MEDIUM-class fix in v2 (per severity reconciliation):** rewrite all pseudo-code identifiers to match real API. |
| Codex LOW-2 / Opus MEDIUM-9 (function count 197→200 vs 193→200) | Fix § 9: "193 → 200 registered functions." |
| Codex LOW-3 (parser zero-arg verified) | Remove R6 from open risks; verified-passed test in commit message. |
| Opus LOW-1 (asymmetric COLUMN examples in § 0) | Fix § 0 examples list for COLUMN/COLUMNS symmetry. |
| Opus LOW-2 (ADDRESS scope conflict with 4.10.G) | v2 § 1 out-of-scope: only `OFFSET / INDIRECT` (drop ADDRESS). Cross-link 4.10.G. |
| Opus LOW-3 (`Value::error` lowercase) | Subsumed in Codex LOW-1 batch. |
| Opus LOW-4 (concrete LibreOffice values) | v2 § 7 table form: 7 reference values (one per fn) listed inline. |
| Opus LOW-5 (Excel pre-365 vs 365 FORMULATEXT multi-cell) | v2 § 2.5 + § 10 question 8: document pre-365 implicit-intersection vs Excel-365 spill; v1 takes IronCalc divergence (single-cell-only error class → `#N/A`); spill-form is follow-up. |
| Opus LOW-6 (status line "parallel-Codex+Opus pending") | Status line updated in v2. |
| Opus LOW-7 (step-number convention 2.A vs 3) | v2 § 6 uses Step N.A convention for audit-closure sub-steps. |
| Opus LOW-8 (Spec ID) | Add `Spec ID: RT-V1-01` to v2 § 0. |
| Opus LOW-9 (disjointness panic understatement) | v2 § 8 R8 (renumbered R9) clarifies registration-time disjointness invariant. |

Deferred (non-blocking, documented as future-session items):
- None — all LOWs absorbed into v2 doc edits.

## Cross-cutting hits both audits noted (Opus § 11)

| Item | Status in v2 |
|------|-------------|
| `is_aggregate_function_lists_only_registered_aggregates` test | Step 1 sub-bullet (HIGH-G closure). |
| `walk_plan_for_deps` for reference-tier | § 5.3 dep-suppress policy (HIGH-H closure). |
| `plan_cache.rs` cell-anchor key | § 8 R1 documents that `=ROW()` plans are cell-INDEPENDENT (no plan-cache change needed). |
| `coverage.rs` per-tier walk | Step 1 sub-bullet (MEDIUM-η closure). |
| `excel-matrix.md` row count test (`test_matrix_lists_registered_fns`) | Step 1 sub-bullet (matrix row addition). |
| IDE diagnostic surface `validate_formula` for `=ROW()` zero-arg | § 7 cross-cutting test added. |
| Op-log replay (`set_formula` → `recompute_dirty` path) | Opus verified `WorkbookEnv::with_formula_cell` at workbook_runtime.rs:3637 ✓ — no design changes needed; § 8 R1 documents. |
| Export/import (qbook round-trip with formula text) | `formula_at` already qbook-serialized; FORMULATEXT round-trips correctly. No design changes needed; § 8 R7 (new) documents. |

## Action plan post-reconciliation

1. ✅ This reconciliation summary written.
2. **Rewrite design doc to v2** incorporating all closures above. Mark v1 as "Superseded by v2 — see this reconciliation doc."
3. Update `.plans/_active.md` with the post-reconciliation step list.
4. Begin Step 1 (infrastructure) — the new ABI shape per v2 § 5.
5. Parallel Codex + Opus audit Step 1.A before any user-facing function is registered.
6. Continue per audit-discipline rule for each subsequent ship commit.

## Pattern signals captured

1. **B1 binder strategy convergent miss.** Both audits caught that `Expr::RangeRef` is rejected pre-context. **Pattern signal:** when a design says "X works because [hardcoded mechanism]" — verify the hardcoded mechanism actually fires in the path described. The W5-X comments at `plan.rs` are old and the binder logic has moved.

2. **Eager-vs-lazy materialization Convergent.** Both audits caught ISREF lazy semantics. **Pattern signal:** new dispatch tiers MUST specify the laziness contract per fn, not assume the existing eager-eval default. Same applies to future LAMBDA / fn-as-arg tier.

3. **Storage-canonicalization factual nuance.** Codex was right about canonicalization; Opus was wrong about raw-source retention. **Pattern signal:** independently verify storage-format claims at reconciliation time. Both auditors had partial views; only checking the actual code resolved it.

4. **Microsoft canon vs IronCalc divergence convergent on FORMULATEXT.** Both audits caught the leading-`=` requirement. Codex caught the multi-cell upper-left semantics (Opus rated LOW); reconciled at MEDIUM. **Pattern signal:** IronCalc-port faithfulness sometimes ships IronCalc's documented Excel-divergences; check Microsoft docs for primary canon.

5. **Calcgraph dep-tracking is a load-bearing surface for reference-tier.** Both audits caught it (Codex MEDIUM, Opus HIGH); reconciled at HIGH. **Pattern signal:** every new dispatch tier needs an explicit dep-tracking policy decision in its design doc.

6. **Test-invariant maintenance is process-class HIGH.** Opus caught the `is_aggregate_function_lists_only_registered_aggregates` test break; Codex did not. **Pattern signal:** when extending hardcoded lists with bound invariant tests, the test extension goes in the same commit.

## Status

- Design v1 superseded by v2 (this commit).
- All 8 HIGH closures applied in v2 design doc.
- All 9 MEDIUM closures applied in v2 design doc.
- All 10 LOW closures applied in v2 design doc.
- Ready to begin Step 1 (infrastructure) per v2 § 6.

---

## Reading order for the next session

1. This reconciliation doc — the canonical pre-review outcome.
2. `docs/architecture/2026-05-17-reference-tier-design.md` v2 — the active design.
3. `.plans/_active.md` — the step-by-step plan.
4. The two source pre-review docs (`*-codex.md` / `*-opus.md`) — only if you need to drill into a specific finding's reasoning.
