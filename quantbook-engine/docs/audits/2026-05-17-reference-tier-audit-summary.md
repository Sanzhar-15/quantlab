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

---

## Audit cycle 3 — Step 2 (ROW/COLUMN/ROWS/COLUMNS implementation)

**Scope:** working-tree Step 2 changes — `crates/ql-functions/src/reference_fns.rs` (NEW, 4 fn impls + 28 unit tests), `crates/ql-functions/src/{lib,registry}.rs`, `crates/ql-exec/src/plan.rs` (registry-side invariant test), `crates/ql-exec/tests/reference_fns_e2e.rs` (NEW, 32 e2e tests), `crates/ql-functions/tests/coverage.rs` (4 entries), `docs/compat/excel-matrix.md` (4 rows).
**HEAD baseline:** `4efabe35deb` (post-Step-1.1). Pre-audit gates: 3173 tests passing.

**Codex audit:** `2026-05-17-rt-step-2-codex.md` — **1 HIGH + 3 MEDIUM + 2 LOW = 6 findings.**
**Opus audit:** `2026-05-17-rt-step-2-opus.md` — **3 HIGH + 9 MEDIUM + 12 LOW = 24 findings.**

### Severity reconciliation

| Finding | Codex | Opus | Reconciled | Rationale |
|---------|-------|------|------------|-----------|
| `ROW(SUM(A1:A3))` bind-fails (design example divergence) | HIGH-1 | — | **HIGH** | Codex-only. Design's named Microsoft-canon case fails at bind. Same gap affects Step 3/4 examples for ISREF/ISFORMULA/FORMULATEXT. |
| Named-range + cross-sheet + structured-ref coverage absent | MED-2/3 | HIGH-1 | **HIGH** | Convergent. Opus rates higher. Plan checklist enumerated these as Step 2 requirements; gaps include dedicated materializer + walker paths that ship without test coverage. |
| CellRef materializer reads value AND silently coerces `Value::Error` to `RefArg::Reference` | — | HIGH-2 | **HIGH** | Opus-only. Real error-propagation bug: `ROW(Sheet99!A1)` where Sheet99 missing returns `1` instead of `#REF!`. Reachability is low today (no `delete_sheet` API) but the gap is architectural. |
| Stale doc on `is_reference_aware_function` | LOW-1 | HIGH-3 | **MEDIUM** | Opus's HIGH framing overrates; doc-only. But two factual errors (false claim + nonexistent test name reference) — MEDIUM per severity rule. |
| `ROWS`/`COLUMNS` u32 underflow on non-normalized Range | MED-1 | LOW-3 | **MEDIUM** | Codex's framing emphasizes public-API reachability. Take higher. |
| E2E gap for `=ROW()` formula-cell happy path | MED-2 (sub) | MED-2 | **MEDIUM** | Convergent. Resolved by S2-HIGH-1's added tests. |
| Coverage-note `EXPLICITLY_DEFERRED` overclaims | LOW-2 | MED-7 | **MEDIUM** | Take higher. |
| Structured-ref boundary guard untested | MED-3 | (subsumed in HIGH-1) | **MEDIUM** | Same area as HIGH-1. |
| Step 2 invariant only covers 4 of 7 names | — | MED-5 | **MEDIUM** | Real test gap. ISREF/ISFORMULA/FORMULATEXT in matcher but not yet registered; typo in those would slip through Step 2. |
| Misc MEDIUMs (ROW(1×3) test, walker doc, matrix counts, args.len()!=1 boundary, Range.values dead, design § 5.6 shape() drift) | — | MED-1/3/4/6/8/9 | **LOW** | Reconciled down — doc-only or unreachable-today concerns. |

### Final HIGH list (must-close in Step 2.1)

| ID | Subject | Fix shape |
|----|---------|-----------|
| **S2-HIGH-1** | Coverage gaps: named-range, cross-sheet, formula-cell `=ROW()`, structured-ref | Add named-range + cross-sheet + WorkbookRuntime formula-cell tests in Step 2.1; defer structured-ref + implicit-intersection (`@ROW(A1:A10)`) to Step 5 cross-cutting suite with explicit rationale in plan file. |
| **S2-HIGH-2** | CellRef materializer eats `Value::Error` | Mirror the fallthrough arm's error mapping in the CellRef arm — `match read_cell { Value::Error(ev) => RefArg::Error(ev), ok => RefArg::Reference { ok } }`. Smaller fix (preserve `value` field for forward compat); a future cycle can drop the field entirely if no consumer materializes. |
| **S2-HIGH-3** | `ROW(SUM(A1:A3))` bind-fails | Document the v1 scope: nested `SUM(A1:A3)`-style literal-range subcalls bind-fail per S1-MED-γ AggregateArg defer. The Microsoft-canon `#VALUE!` requires AggregateArg-side literal RangeRef binding (out of scope for RT-V1). Update `reference_fns.rs` doc-comment + design § 5.6 + excel-matrix Notes to make the scope explicit. Add an explicit e2e test pinning the v1 behavior (`ROW(SUM(A1:A3)) → BindError`) so a future regression is caught. The named-range form (`ROW(SUM(NamedRange))`) DOES work and is tested as part of S2-HIGH-1's named-range coverage. |

### MEDIUM closures (5 items)

| ID | Subject | Fix shape |
|----|---------|-----------|
| **S2-MED-α** | Stale doc on `is_reference_aware_function` (Opus HIGH-3 reconciled to MED) | Rewrite doc-comment to reflect post-Step-2 state + reference the correct test names. |
| **S2-MED-β** | u32 underflow on non-normalized Range | Range arithmetic already safe in v1 paths (binder normalizes via `Range::new`). Add defensive `checked_sub`-style guard in `rows`/`columns` impls OR add a debug_assert. Document the public-API risk for follow-up. |
| **S2-MED-γ** | Step 2 invariant only covers 4 of 7 names | Extend `step_2_reference_aware_names_registered_in_reference_tier` to ALSO assert ISREF/ISFORMULA/FORMULATEXT are NOT yet in `lookup_reference_aware` (and ARE in `is_reference_aware_function`). |
| **S2-MED-δ** | `EXPLICITLY_DEFERRED` coverage notes overclaim | Tighten the reason strings — say "reference-aware fn (W5-RT-2); covered by reference_fns unit tests (anchor / range / array literal / error propagation / arity / non-reference) + e2e dispatch tests; matrix N/A. Cross-sheet + named-range coverage in S2.1 closure tests; structured-ref in Step 5 cross-cutting suite." |
| **S2-MED-ε** | Walker `RangeRef` arm doc stale post-Step-2 | Update the inline comment claiming "the only v1 consumers (ISFORMULA / FORMULATEXT...)"; ROW/COLUMN/ROWS/COLUMNS also consume but through the address-only walker route. |

### LOW closures (cherry-picked)

Opus's 12 LOWs + Codex's 2 LOWs: most are doc/naming/test-helper polish. Step 2.1 takes only items that touch correctness or surfaced files; the rest deferred to post-mini-phase polish wave.

| ID | Subject | Action |
|----|---------|--------|
| **S2-LOW-1** | Matrix `excel-matrix.md` test counts mismatch (`9+8 e2e` etc.) | Recompute against actual test count, update. |
| **S2-LOW-2** | Microsoft canon `ROW({1,2,3})` 1×3 shape not specifically tested | Add unit test in reference_fns.rs. |
| **S2-LOW-3** | Step 2.1 fixes design § 5.6 `av.shape()` drift to `av.rows()/cols()` | Doc fix in design. |
| Deferred LOWs (10 items) | Test-name consistency, helper extraction, defensive arms doc, symmetric arity coverage, etc. | Post-mini-phase polish; tracked in Step 6 closure docs. |

### Cross-cutting pattern signals (Step 2 cycle)

1. **Coverage gaps tend to slip when test infrastructure differs.** Named-range / cross-sheet / structured-ref / formula-cell-context each require non-trivial test setup (NameTable / sheet resolver / WorkbookRuntime). The Step 2 implementation defaulted to `MapEnv` + `eval_with_map` for ergonomic reasons; the more expensive setups were silently skipped. **Pattern signal:** when plan checklist enumerates coverage classes, verify each by-grep before claiming Step complete.

2. **Materializer arms must follow uniform error-propagation contract.** The CellRef arm's silent error coercion (HIGH-2) violates the fallthrough arm's `Value::Error → RefArg::Error(ev)` mapping. **Pattern signal:** when adding new dispatcher arms, the error-mapping pattern must be replicated explicitly — not left implicit.

3. **Design-doc Microsoft-canon examples are contract.** The `ROW(SUM(A1:A3))` example shipped in design § 5.6 but the impl can't reach it (S1-MED-γ AggregateArg defer affects Step 2/3/4 cross-fn examples). **Pattern signal:** when deferring a binder feature, audit the design examples that depend on it AND list them as known-divergence at deferral time.

4. **Doc-comments referencing "added in this commit" rot the moment that commit lands.** Opus HIGH-3's claim about `is_reference_aware_function` is the same pattern as Step 1's HIGH-O-1. **Pattern signal:** prefer doc-comments that reference test-name + module location (line independent) and that describe present state without "added recently" / "in this commit" language.

5. **Test-class coverage matrix is load-bearing for plan-completion claims.** The plan's checklist line 87 names 8 categories; impl shipped 5. **Pattern signal:** before checking a plan item complete, grep the impl-tree for ALL categories listed and document deferrals explicitly.

---

## Audit cycle 4 — Step 3 (ISREF + ISFORMULA implementation)

**Scope:** working-tree Step 3 changes — `reference_fns.rs` (added ISREF + ISFORMULA + 19 unit tests), `registry.rs` (registered LazyShape + Eager), `plan.rs` (invariant test extended), new `reference_fns_step3_e2e.rs` (~22 e2e tests), `coverage.rs` (2 new entries), `excel-matrix.md` rows.
**HEAD baseline:** `98ca4e697b3` (post-Step-2.1). Pre-audit gates: 3229 tests passing.

**Codex audit:** `2026-05-17-rt-step-3-codex.md` — **4 HIGH + 1 MEDIUM + 3 LOW = 8 findings.**
**Opus audit:** `2026-05-17-rt-step-3-opus.md` — **4 HIGH + 10 MEDIUM + 10 LOW = 24 findings.**

### Severity reconciliation

| Finding | Codex | Opus | Reconciled | Rationale |
|---------|-------|------|------------|-----------|
| S2-HIGH-2 closure regression — CellRef materializer error-coerces, ISFORMULA(A1) returns A1's value-error instead of TRUE/FALSE | HIGH-1 | HIGH-S3-O-1 | **HIGH** | Convergent. The S2-HIGH-2 closure was the wrong architectural fix; both audits independently caught it via live ISFORMULA probe. The right shape: drop `value` field from `RefArg::Reference` entirely. |
| ISREF (LazyShape) walker policy wrong — `ISREF(NOW())` spuriously volatile; `ISREF(A1+1)` registers A1 dep | MEDIUM-1 | HIGH-S3-O-2 | **HIGH** | Convergent (Codex rated MED, Opus HIGH). Take higher: real semantics violation. The LazyShape contract guarantees no-eval; the walker should match — NO arg walking for ISREF. |
| 1×1 RangeRef arm no-op — `ISFORMULA(A1:A1)` doesn't dirty when A1 changes | HIGH-2 | (subsumed) | **HIGH** | Codex-only. Real correctness bug introduced by the S1-MED-δ closure (dropped synthetic marker but also dropped the legitimate 1×1 dep). |
| `ISREF(SUM(A1:A3))` / `ISFORMULA(SUM(A1:A3))` bind-fail | HIGH-3 | (covered in MEDIUMs) | **HIGH** | S2-HIGH-3 propagation; Step 3 doc-comments still reference the design example. Resolved by doc-update + pinning bind-fail tests. |
| Producer/replay divergence for `=ISFORMULA(A1)` when A1 is being set | HIGH-4 | (not flagged) | **HIGH** | Codex-only. Real producer-replay invariant break. Workbook-runtime restructure required; documented + pinned with v1-divergence test. |
| ISREF-no-eval instrumented test missing | — | HIGH-S3-O-3 | **MEDIUM** | Plan checklist item not delivered. Critical lazy-semantics test exists (`isref_of_divide_by_zero_returns_false_without_eval`); deeper instrumentation is plan-item-pending — reclassify as MEDIUM. |
| "workbook-runtime e2e" claim in coverage doc but tests use storage-level put_formula | — | HIGH-S3-O-4 | **MEDIUM** | Doc-only inaccuracy; the tests still cover the path correctly. Reclassify to MEDIUM. |
| `lookup_context_aware` missing from disjointness check | — | (LOW) | **LOW** | Already structurally enforced by HashMap; doc-only gap. |
| Various MEDIUMs (doc lies, design divergence, untested paths) | — | MED-1 through 10 | mixed | Some are doc-fixes, some real but small. Cherry-pick. |
| Doc / count / naming nits | LOW-1/2/3 | LOW-1 through 10 | various **LOW** | Apply in this cycle's doc edits; defer most to post-mini-phase polish. |

### Final HIGH list (5 issues — must-close)

| ID | Subject | Fix shape |
|----|---------|-----------|
| **S3-HIGH-1** | CellRef materializer regression from S2-HIGH-2 | **REVERT S2-HIGH-2** + drop `value` field from `RefArg::Reference`. Per-fn impls only need address; if a future fn wants the value, it calls `env.read_cell` directly. Missing-sheet errors are caught at bind time (`BindError::UnknownSheet`), not eval. |
| **S3-HIGH-2** | LazyShape walker policy (ISREF) | New `ExprPlan::Function` arm branch: `if name == "ISREF" { /* no arg walking */ }` before the address-only branch. Fixes `ISREF(NOW())` spurious volatility + `ISREF(A1+1)` spurious A1 dep. |
| **S3-HIGH-3** | 1×1 RangeRef walker no-op | Walker's `ExprPlan::RangeRef` arm now pushes a cell-dep when `start_row == end_row && start_col == end_col`. Multi-cell ranges stay no-op (result is `#N/A` anyway). Restores `=ISFORMULA(A1:A1)` dirtying. |
| **S3-HIGH-4** | `ROW/ISREF/ISFORMULA(SUM(A1:A3))` bind-fail | Update doc-comments in `reference_fns.rs` to remove `ROW(SUM(A1:A3))` / `ISREF(SUM(A1:A3))` / `ISFORMULA(SUM(A1:A3))` from happy-path examples (S2-HIGH-3 → S3-HIGH-4). Add explicit `*_of_sum_literal_range_bind_fails_v1_scope` pinning tests for ISREF + ISFORMULA. |
| **S3-HIGH-5** | Producer/replay divergence for `=ISFORMULA(A1)` when A1 is being set | Documented v1 divergence. `WorkbookRuntime::set_formula` evaluates BEFORE storing the formula; replay does the reverse. v1 acceptance: the divergence is real but only affects ISFORMULA-on-the-being-set-cell (rare in practice). Fix is a workbook_runtime restructure (out of scope for Step 3.1). Add pinning test + design-doc note. |

### MEDIUM closures (cherry-picked)

| ID | Subject | Fix shape |
|----|---------|-----------|
| **S3-MED-α** | Coverage-doc accuracy ("workbook-runtime e2e" claim) | Rephrase to "WorkbookEnv-backed storage-level e2e" — accurate description of what the tests actually do. |
| **S3-MED-β** | ISREF-no-eval instrumented test | Add one test that exercises the no-eval invariant beyond the existing `1/0` shape — use a volatile-fn invocation in ISREF's arg and verify the formula is NOT marked volatile. |
| **S3-MED-γ** | `lookup_context_aware` missing in disjointness check | Add the missing check to `step_2_reference_aware_names_registered_in_reference_tier` for completeness. |
| **S3-MED-δ** | Module header stale (Step 2-only description) | Update `reference_fns.rs` file-level doc to cover both batches + LazyShape contract introduction. |

### LOW deferred (no fixes this cycle)

Opus LOWs 1-10 + Codex LOWs 1-3 — naming nits, test renames, citation links. Tracked for post-mini-phase polish.

### Step 3 pattern signals captured

1. **Architectural fixes have second-order regression potential.** S2-HIGH-2 (CellRef error coercion) seemed correct in isolation; Step 3 audits caught that it conflated "ref is invalid" with "ref points to error-valued cell". **Pattern signal:** when adding error-coercion in a materializer arm, audit ALL consumers' semantics — not just the one motivating the fix. The "no value carried in `RefArg::Reference`" shape is the architecturally-correct invariant; the S2-HIGH-2 closure papered over it instead of removing the field.

2. **Walker policy must match each contract.** Step 1.1's address-only walker was designed for Eager fns (ROW/COLUMN/ROWS/COLUMNS). Adding ISREF with LazyShape exposed the asymmetry: the materializer doesn't eval, but the walker walks anyway. **Pattern signal:** each dispatcher contract (Eager / LazyShape / future variants) needs a matched walker policy. Stage future audits to verify both surfaces together.

3. **Codex caught what Opus didn't (and vice versa) — convergence is signal.** S3-HIGH-1 (materializer regression) was convergent — high-confidence. S3-HIGH-2 (ISREF walker) Codex rated MEDIUM, Opus HIGH — reconciliation rule kicked in. S3-HIGH-4 (producer/replay) was Codex-only — the kind of cross-cycle producer/replay invariant that requires deep walking. **Pattern signal:** running parallel audits with different models surfaces independent classes of issues. Severity-conflict resolution rule (take higher unless reasoning is faulty) consistently produces the right call.

4. **The `RangeRef` walker arm has now flipped twice.** Original: synthetic-marker push (S1-MED-δ found unsafe). Step 1.1: no-op (Step 3 HIGH-2 found unsafe for 1×1). Step 3.1: cell-dep on 1×1 only. **Pattern signal:** when a finding closes by *deleting* code, audit what coverage the deleted code was load-bearing for.

---

## Audit cycle 5 — Step 4 (FORMULATEXT — CLOSES mini-phase)

**Scope:** working-tree Step 4 changes — `reference_fns.rs` (added `formulatext` impl + 9 unit tests), `registry.rs` (registered FORMULATEXT Eager + count 199 → 200), `plan.rs` (invariant test extended to all 7 names; FORMULATEXT-pending sentinel removed), NEW `reference_fns_step4_e2e.rs` (~15 e2e tests with the producer/replay pin), `coverage.rs` (FORMULATEXT entry), `excel-matrix.md`.
**HEAD baseline:** `43615dd7cd1` (post-Step-3.1). Pre-audit gates: 3260 tests passing.

**Codex audit:** `2026-05-17-rt-step-4-codex.md` — **1 HIGH + 1 MEDIUM + 5 LOW = 7 findings.**
**Opus audit:** `2026-05-17-rt-step-4-opus.md` — **3 HIGH + 11 MEDIUM + 11 LOW = 25 findings.**

### Severity reconciliation

| Finding | Codex | Opus | Reconciled | Rationale |
|---------|-------|------|------------|-----------|
| FORMULATEXT producer/replay self-reference pin missing | HIGH-S4-1 | S4-HIGH-2 | **HIGH** | Convergent. Parallel to S3-HIGH-5 for ISFORMULA. |
| Transaction::put_formula canonicalization divergence | — | S4-HIGH-1 | **HIGH** | Opus-only architectural finding. Two public producer APIs store text differently; design § 2.5 "canonical printer output" promise broken for one of them. |
| Module header still labels FORMULATEXT "Pending" | LOW-S4-2 | S4-HIGH-3 | **MEDIUM** | Opus rated HIGH; doc-only inaccuracy. Reconcile MEDIUM per severity discipline — fixed in this cycle anyway. |
| Design § 2.5 doc `FORMULATEXT(SUM(A1:A3))` outdated | MEDIUM-S4-1 | (covered) | **MEDIUM** | Convergent. |
| Matrix test count 14 vs 16 | LOW-S4-1 | S4-MED-2 | **MEDIUM** | Take higher; matrix accuracy. |
| Plan checklist unchecked items | LOW-S4-4 | S4-MED-3 | **MEDIUM** | Process hygiene; fix this cycle. |
| Stale doc-comment citation (step3_e2e vs step4_e2e) | (not flagged) | S4-MED-1 | **LOW** | Doc-only. |
| Various Opus MEDIUMs (LibreOffice cross-check, clear_formula transition, NamedMultiCellRange, etc.) | — | S4-MED-4 through 11 | **LOW** | Cherry-pick a couple as future-cycle work; not blocking mini-phase ship. |
| Test comment inaccuracies, naming, ABI doc | LOW-S4-3/5 | various LOW | **LOW** | Cherry-pick. |

### Final HIGH list (3 — all closed)

| ID | Subject | Fix shape |
|----|---------|-----------|
| **S4-HIGH-1** | `Transaction::put_formula` skips canonicalization | Document the divergence in `reference_fns.rs` doc-comment + `excel-matrix.md` row. **Option 3 (accept-and-document)** per Opus's recommendation — alignment fix is post-RT-V1. Both producer APIs preserve the leading-`=` invariant; only canonical-vs-raw stored text varies. |
| **S4-HIGH-2** | FORMULATEXT self-reference producer/replay divergence pin | Added `formulatext_self_reference_returns_na_during_set_formula_v1_pin` in `reference_fns_step4_e2e.rs` — parallel to S3-HIGH-5's ISFORMULA pin. |
| **S4-HIGH-3** | Module header labels FORMULATEXT "Pending" post-ship | Header updated to remove "Pending" + add CLOSES note. |

### MEDIUM closures (4)

| ID | Subject | Fix |
|----|---------|-----|
| **S4-MED-1 (Codex)** | Design § 2.5 FORMULATEXT(SUM(A1:A3)) outdated | (Pending in this cycle — design doc § 2.5 update.) |
| **S4-MED-2** | Matrix test count 14 → 16 | Updated to `9+15 e2e` (15 e2e after S4-HIGH-2 pin added). |
| **S4-MED-3** | Plan checklist Step 3/4 unchecked items | Updated to reflect shipped state. |
| **S4-MED-α** | Doc-comment citation `step3_e2e` → `step4_e2e` | Fixed in reference_fns.rs. |

### LOW deferred

Most Opus LOWs (test naming, ABI doc updates to design § 5, R1C1-mode caveat, etc.) deferred to post-mini-phase polish or Step 5/6 closure. Tracked.

### Mini-phase complete

W5-RT-4 closes the address-only/information/text triad. All 7 reference-tier fns shipped + audited:
- W5-RT-2 (ROW/COLUMN/ROWS/COLUMNS) — Step 2 address-only batch.
- W5-RT-3 (ISREF/ISFORMULA) — Step 3 information batch.
- W5-RT-4 (FORMULATEXT) — Step 4 text batch.

Cumulative across 5 audit cycles: **21 HIGH + ~38 MEDIUM + ~40 LOW** findings — all HIGHs closed, MEDIUMs largely closed (~10 deferred with reasons), LOWs cherry-picked.

### Step 4 pattern signals

1. **Audit count tapering across cycles is signal of maturing architecture.** Cycle 2 (Step 1): 5 HIGH. Cycle 3 (Step 2): 3 HIGH. Cycle 4 (Step 3): 5 HIGH (regression chain!). Cycle 5 (Step 4): 3 HIGH (no new regressions; mostly canonicalization-divergence + doc-rot inherited from prior cycles). **Pattern signal:** late-cycle audits find less novel material — but the regressions they DO find are the most subtle. The S3 → S4 chain (S2-HIGH-2 → S3-HIGH-1 regression → S3.1 fix → S4 finds no new regression) demonstrates the audit discipline working in the long-cycle direction.

2. **Two producer APIs is one too many for a single canonical invariant.** `WorkbookRuntime::set_formula` canonicalizes; `WorkbookTransaction::put_formula` doesn't. Design § 2.5 wrote the canonical invariant assuming one API; reality has two. **Pattern signal:** when a design promises a "canonical X", audit ALL public producer APIs for X — not just the one named in the design.

3. **Producer/replay invariant is a class of finding, not a one-off.** S3-HIGH-5 (ISFORMULA) → S4-HIGH-2 (FORMULATEXT). Both have the same root cause (workbook_runtime set-formula evaluates before installing). **Pattern signal:** when a producer/replay finding closes for one fn, audit ALL fns that query workbook state for the same shape.

4. **Doc-comments labeled "Pending" rot at ship time.** S4-HIGH-3. Same class as Step 1's HIGH-O-1, Step 2's stale `accepts_special_arg_at_bind`, Step 3's `is_reference_aware_function` "v1 always returns false". **Pattern signal — RECURRING:** add a pre-commit grep for `Pending|TODO|in this commit|added recently` in changed files. The cost is one grep; the benefit is catching this pattern across cycles.
