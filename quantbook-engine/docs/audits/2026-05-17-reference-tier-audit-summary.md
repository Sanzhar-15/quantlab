# Reference-tier mini-phase — cumulative audit summary

**Branch:** `feat/quantbook-engine`
**Mini-phase ID:** RT-V1-01

This is the cumulative reconciliation across audit cycles. Per the 2026-05-17 audit-discipline rule, each ship commit gets a parallel Codex + Opus audit; this doc tracks every cycle.

---

## Audit cycle 1 — Pre-review of design v2 (2026-05-17)

**Scope:** `docs/architecture/2026-05-17-reference-tier-design.md` v1.
**Counts:** Codex 7H+7M+3L; Opus 7H+11M+9L. **Reconciled: 8 HIGH + 9 MEDIUM closures applied in v2.**
**Closure:** all HIGH + MEDIUM closed in design v2 (this commit was a doc-rewrite; no code).
**Detail:** see `2026-05-17-reference-tier-pre-review-summary.md`.

---

## Audit cycle 2 — Step 1 infrastructure (2026-05-17)

**Scope:** working-tree Step 1 infrastructure changes (`crates/ql-functions/src/reference_aware_fns.rs` + lib/registry/plan/scalar/calcgraph_session/env edits). No reference-aware fns user-facing yet.
**HEAD baseline:** `8f9b37b5d6d`. Gates pre-audit: 3090 tests passing (+8 from baseline), clippy clean, fmt clean.

**Codex audit:** `2026-05-17-rt-step-1-codex.md` — **2 HIGH + 2 MEDIUM + 3 LOW = 7 findings.**
**Opus audit:** `2026-05-17-rt-step-1-opus.md` — **3 HIGH + 8 MEDIUM + 9 LOW = 20 findings.**

### Severity-conflict reconciliation (per audit-discipline rule "take higher severity")

| Finding | Codex | Opus | Reconciled | Rationale |
|---------|-------|------|------------|-----------|
| Dep-walker over-suppression | HIGH-1 | — | **HIGH** | Codex-only. Correctness bug: `ROW(A1+1)` loses A1 dep. Opus's HIGH-3 is a different framing of the same area (volatile asymmetry). |
| Cell-boundary StructuredRef gap | HIGH-2 | — | **HIGH** | Codex-only. Verified by inspection: guard at scalar.rs:811 only matches `RangeRef`/`AggregateNameRef`/`Array`. |
| Doc-promised invariant test missing | — | HIGH-1 | **HIGH** | Opus-only. `accepts_special_arg_lists_only_registered_reference_aware` referenced in doc-comment but doesn't exist. |
| Design v2 § 5.4.A rename/extend skipped | — | HIGH-2 | **HIGH** | Opus-only. Design said "rename `is_aggregate_function` + extend invariant test"; impl shipped parallel matcher with no test. |
| Eager-materializer Function arg + suppressed dep asymmetry | — | HIGH-3 | **HIGH** | Opus-only. Wasted-CPU not wrong-result; HIGH for the *missing-documentation* portion. |
| Binder/registry drift risk | MEDIUM-1 | (subsumed) | **MEDIUM** | Same area as Opus HIGH-2. |
| Step 1 exec-side tests gap | MEDIUM-2 | LOW-1 | **MEDIUM** | Per severity rule: take higher (MEDIUM). |
| AggregateArg vs ReferenceArg scope drift | LOW-1 | MEDIUM-5 | **MEDIUM** | Per severity rule. |
| Synthetic `__rt_literal_range__` marker | LOW-3 | MEDIUM-6 | **MEDIUM** | Per severity rule. Public field leak. |
| Doc references nonexistent `contract_of(name)` | LOW-2 | — | **LOW** | Doc-only. |

### Opus-only findings (no Codex overlap)

- **MEDIUM-O-1** — `is_aggregate_function_lists_only_registered_aggregates` test extension never delivered (sibling to HIGH-O-1).
- **MEDIUM-O-2** — Array materializer evals every cell even when only shape needed (binder limit makes this cheap; doc-only fix).
- **MEDIUM-O-3** — `RefArg::Range.values` doc-promise drift (no consumer populates values yet; document or remove field).
- **MEDIUM-O-4** — `Workbook` impl moved to `WorkbookEnv` (sound engineering deviation; design needs update).
- **MEDIUM-O-7** — `is_dep_suppressed_reference_fn` no invariant test (drift hazard).
- **MEDIUM-O-8** — `PlanKind::Literal` collapses 6 ExprPlan variants (forward-compat concern).
- **LOW-O-1..9** — misc: integration test gap, builder constructors, doc-comment hygiene, parser-canonicalization invariant test, et al.

### Final HIGH list (must-close before Step 2)

| ID | Subject | Reconciled severity | Fix shape |
|----|---------|---------------------|-----------|
| **S1-HIGH-A** | Dep-walker over-suppression — `ROW(A1+1)` etc. | HIGH | Rewrite walker policy. For address-only ref-aware fns (ROW/COLUMN/ROWS/COLUMNS/ISREF), walk args but skip value-deps on direct `CellRef`/`RangeRef`. Register structural deps (named-range NAME / table TABLE_NAME) but NOT cell-stripe deps. Walk normally for non-reference shapes (Binary/Unary/Function/etc.). |
| **S1-HIGH-B** | Cell-boundary guard misses `StructuredRef` | HIGH | Add `StructuredRef` branch to the multi-cell guard. Use `narrow_structured_ref` to handle `[@Col]` correctly — narrowed → single-cell → no guard; full column → multi-cell → `#CALC!`. |
| **S1-HIGH-C** | Missing invariant test for `is_reference_aware_function` | HIGH | Add `accepts_special_arg_lists_only_registered_reference_aware` test. Direction: every name in `is_reference_aware_function` is recognized. At Step 1 (no fns registered) the **registry-side** loop is empty; test the **matcher-only** direction. Extend with registry-side loop in Step 2 when first fns register. |
| **S1-HIGH-D** | Design-impl drift on `is_aggregate_function` rename | HIGH | Path B: update design v2 § 5.4.A + § 6 Step 1 to specify the parallel-matcher approach (`is_reference_aware_function` separate from `is_aggregate_function`). Update plan file lines 55, 68. Rationale: parallel matcher cleaner than mass-rename. |
| **S1-HIGH-E** | Eager-materializer Function-arg + dep-suppress asymmetry | HIGH | Documentation: add a comment block to both `materialize_ref_arg_eager` and `is_dep_suppressed_reference_fn` (after walker rewrite) explaining the asymmetry. Wasted-CPU acceptable for v1; future tier additions should re-examine. |

### MEDIUM closures applied in Step 1.1

| ID | Subject | Fix shape |
|----|---------|-----------|
| **S1-MED-α** | Step 1 exec-side test gap | Add one integration test in `crates/ql-exec/tests/` that registers a placeholder reference-aware fn AND dispatches `=__RT_TEST__(A1)` through `eval_scalar_with_cache`. Verifies the binder→materializer→dispatcher chain. |
| **S1-MED-β** | Binder/registry drift (covered by S1-HIGH-C invariant test) | Resolved as part of S1-HIGH-C. |
| **S1-MED-γ** | AggregateArg vs ReferenceArg scope drift | Update design v2 § 5.4 + § 6 Step 1 to mark AggregateArg-side enabling as deferred. Update plan to reflect. |
| **S1-MED-δ** | Synthetic `__rt_literal_range__` marker | Refactor: add `FormulaDeps.literal_ranges: Vec<Range>` separate from `named_ranges`. Walker pushes literal ranges to the new field; stripe-index registration iterates both. Pub-surface clean. |
| **S1-MED-ε** | Workbook → WorkbookEnv impl deviation | Update design v2 § 5.5 to document the impl-on-WorkbookEnv decision + crate-graph rationale. |
| **S1-MED-ζ** | `is_dep_suppressed_reference_fn` no invariant test | Add `dep_suppressed_reference_fns_match_design` test (per Opus MEDIUM-7 recommendation). |
| **S1-MED-η** | `RefArg::Range.values` doc-promise drift | Update doc-comment to remove the "populated when consumer iterates" promise. Today no consumer populates; if a future iterating fn needs values, ArgContract migration handles it. |

### LOW closures (cherry-picked; rest deferred to post-mini-phase polish)

| ID | Subject | Fix shape |
|----|---------|-----------|
| **S1-LOW-1** | `contract_of(name)` doc reference | Update `register_reference_aware` doc-comment to match actual API (`lookup_reference_aware`). |
| **S1-LOW-2** | `BindContext::AggregateArg` doc references `accepts_special_arg_at_bind` (rename that didn't happen) | Revert reference to `is_aggregate_function`. |

### Deferred LOWs (post-mini-phase polish)

- Opus LOW-O-2 (`RefContext` builder constructors) — minor ergonomic.
- Opus LOW-O-4 (`names_all_chains_all_three_tables` test name says "three"; now five tiers) — naming hygiene.
- Opus LOW-O-5 (MAX_ROW math cross-check — not a defect; logged for traceability).
- Opus LOW-O-6 (parser canonicalization invariant test) — defensive test, low value.
- Opus LOW-O-7 (`materialize_ref_arg_eager` doc enumerates fallthrough) — doc completeness.
- Opus LOW-O-8 (`register_reference_aware_rejects_mixed_case` test variant) — test coverage completeness.
- Opus LOW-O-9 (per-fn pseudo-code verification deferred to Step 2) — tracking only.
- Opus MEDIUM-O-2 (array materializer evals all cells) — accepted v1 cost (binder limits to literals); doc-only fix.
- Opus MEDIUM-O-8 (PlanKind::Literal over-collapse) — forward-compat; revisit when first ISREF-variant fn ships.

### Cross-cutting pattern signals captured

1. **Doc-promised invariant tests can fail to ship.** Pre-commit grep would catch — add to commit-message discipline.
2. **Design ↔ implementation drift on rename + extend tasks.** Multi-file coordination is load-bearing; either ship all OR ship none, never partial.
3. **Volatile re-firing under dep-suppress is a quiet asymmetry.** Every new dispatch tier needs paired runtime-eval + dep-tracking policy.
4. **Synthetic markers leak through public fields.** Prefer sibling field over carrying a synthetic name.
5. **`PlanKind::Literal` collapse is over-aggressive.** ABI enums in public crates should over-specify, not under-specify.

---

## Net state post-Step-1.1

After Step 1.1 closures land:

- 5 HIGH (S1-HIGH-A through E) closed in code + docs.
- 7 MEDIUM (S1-MED-α through η) closed in code + docs.
- 2 LOW closed; 8 LOWs deferred to post-mini-phase polish with written reasons.
- Updated docs: design v2 § 5.4.A / § 5.5 / § 6 Step 1, plan file lines 55/68/65.
- Updated tests: +2 invariant tests (`accepts_special_arg_lists_only_registered_reference_aware`, `dep_suppressed_reference_fns_match_design`) + integration test for dispatcher chain.
- Net gates: all green, test count up by ≥3.

Ready for Step 2 (ROW/COLUMN/ROWS/COLUMNS implementation + Step 2.A audit).
