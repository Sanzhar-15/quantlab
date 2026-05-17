# RT-V1-01 Step 4 — Opus audit (independent)

**Scope:** FORMULATEXT implementation (W5-RT-4) — Step 4 changes vs `43615dd7cd1` baseline.
**Files audited:**
- `crates/ql-functions/src/reference_fns.rs` (+~66 lines impl, +~90 lines unit tests)
- `crates/ql-functions/src/registry.rs` (FORMULATEXT registration + count bump)
- `crates/ql-exec/src/plan.rs` (invariant test extended; pending-name block removed)
- `crates/ql-exec/tests/reference_fns_step4_e2e.rs` (NEW — 16 e2e tests)
- `crates/ql-functions/tests/coverage.rs` (1 EXPLICITLY_DEFERRED entry)
- `docs/compat/excel-matrix.md` (FORMULATEXT row)

**Gates verified:** `cargo test` 3154 tests passing; FORMULATEXT unit + e2e tests pass. (Prompt cited 3260 tests; my run shows 3154 — see LOW-9.)

**Audit methodology:** independent of the parallel Codex audit. I did NOT read `docs/audits/2026-05-17-rt-step-4-codex.md` before writing this. Findings reflect my own pass across the prompt's 29 check items + free exploration.

---

## HIGH findings

### S4-HIGH-1 — Design § 2.5's "canonical printer output" promise broken by `Transaction::put_formula` + raw `Workbook::put_formula` paths

**Where:**
- Promise: `docs/architecture/2026-05-17-reference-tier-design.md` § 2.5 line 123 ("canonical printer output + leading `=`") + line 135 ("we return *canonicalized A1/EnUs printer output*").
- Doc-comment claim: `crates/ql-exec/src/env.rs:303-306` says `Workbook::formula_at` "retains the canonicalized printer output".
- Reality: `crates/ql-exec/src/transaction.rs:196-234` (`WorkbookTransaction::put_formula`) parses + binds but stores the **raw user-typed `text`** verbatim — never calls `print_with` to canonicalize.
- Reality: `crates/ql-storage/src/workbook.rs:830` (`Workbook::put_formula`) is also `pub` and accepts any `Arc<str>`-coercible input verbatim. Op-log replay (`crates/ql-oplog/src/replay.rs:323-332`) calls it directly with the recorded text — which is canonical IF the producer was `WorkbookRuntime::set_formula`, but raw IF the producer was `WorkbookTransaction::put_formula`.

**Detail:**
The HIGH-D pre-review closure RESOLVED source-text retention by asserting `Workbook::formula_at` always returns canonical printer output (per `parse → print_with(...EnUs...)` at `workbook_runtime.rs:573`). This is true for **`WorkbookRuntime::set_formula`** only. For **`WorkbookTransaction::put_formula`** (a public producer API used in test infrastructure and intended for paste-block / batch writes per `transaction.rs:5-78`):

```rust
// transaction.rs:206-232 — raw text stored, NOT canonicalized
let text = formula_text.into();
let tokens = lex(text.as_ref())?;
let expr = parse(tokens)?;
// ... bind(expr) ...
self.ops.push(PendingOp::Formula { sheet, row, col, text, plan });  // text = raw input
```

Concrete divergence:
- `rt.set_formula(0, 0, 0, "1+2")` → stores canonical `"1 + 2"` → FORMULATEXT returns `"=1 + 2"`.
- `tx.put_formula(0, 0, 0, "1+2"); tx.commit()` → stores raw `"1+2"` → FORMULATEXT returns `"=1+2"`.

Same formula, two different FORMULATEXT outputs depending on the producer API. The design § 2.5 promise ("canonicalized A1/EnUs printer output") is violated by the Transaction path.

The Step 4 e2e tests **only** exercise the raw `Workbook::put_formula` path (`formulatext_of_formula_cell_returns_text_with_leading_eq` uses `wb.put_formula(0, 0, 0, "1+2")` and asserts `"=1+2"` — would FAIL if the workbook had canonicalized to `"1 + 2"`). So the test suite cannot detect this divergence — it implicitly bakes in the "raw stored" behavior as expected.

**Recommendation:**
Three credible fixes; pick one:

1. **Canonicalize at FORMULATEXT boundary**: replace `formula_text_at`'s direct concatenation with `parse → print_with(...EnUs...) → format!("={canonical}")`. Cost: O(parse) per FORMULATEXT call; correct semantics regardless of producer path. Adds a `ql-formula-syntax` dep to `env.rs` (already a transitive dep through workbook_runtime).
2. **Canonicalize at `Transaction::put_formula`**: parallel the `WorkbookRuntime::set_formula` flow — call `print_with` on the parsed AST and store canonical text. Cost: one print_with per buffered op, dropped on raw text. Aligns the two producer APIs.
3. **Re-document the divergence**: accept that FORMULATEXT returns "whatever's stored" and explicitly note in design § 2.5 + module docs that Transaction-API users get raw text. This is the cheapest fix but contradicts the HIGH-D closure framing.

Add an e2e test pinning the chosen behavior: `formulatext_of_runtime_set_formula_returns_canonical_text` exercising `WorkbookRuntime::set_formula("=1+2")` and asserting `"=1 + 2"` (or whatever the chosen contract says).

**Severity rationale:** real user-visible divergence in a documented contract. The design doc says canonical; the impl breaks that promise for one of two public producer APIs. Not a wrong-result crash, but a contract violation. Step 4 closes the mini-phase; this gap should be resolved or explicitly accepted with updated docs.

---

### S4-HIGH-2 — `=FORMULATEXT(A1)` self-reference producer/replay divergence not pinned (parallel to S3-HIGH-5 for ISFORMULA)

**Where:** No test exists in `crates/ql-exec/tests/reference_fns_step4_e2e.rs` analogous to `isformula_self_reference_returns_false_during_set_formula_v1_pin` (`reference_fns_step3_e2e.rs:368`).

**Detail:**
S3-HIGH-5 identified that `=ISFORMULA(A1)` typed at A1 returns FALSE on producer side (set_formula evals BEFORE installing the formula in `formula_cells` — so `formula_at(A1) = None`), but TRUE on replay (replay restores formula_cells BEFORE recompute). The Step 3.1 closure pinned this with a v1-divergence test.

The same exact pattern affects `=FORMULATEXT(A1)` typed at A1:
- Producer side: `formula_text_at(A1) = None` during eval → FORMULATEXT returns `#N/A`.
- Replay side: `formula_text_at(A1) = Some("FORMULATEXT(A1)")` → FORMULATEXT returns `"=FORMULATEXT(A1)"`.

The audit prompt explicitly calls this out (Item 16, and `.codex-rt-step-4-prompt.md:65` flags the same pattern). Step 4 doesn't pin or document the divergence — a regression that "accidentally fixes" the producer side without coordinating with the replay side would slip silently through.

**Recommendation:**
Add `formulatext_self_reference_returns_na_during_set_formula_v1_pin` to `reference_fns_step4_e2e.rs`. Storage-level setup (mirrors the ISFORMULA pin): no formula installed at A1, `FORMULATEXT(A1)` evaluated with `WorkbookEnv::with_formula_cell(&wb, Address::new(0, 0, 0))` → assert `#N/A`. Add doc-comment noting the replay-side asymmetry (returns `"=FORMULATEXT(A1)"`).

Also: update module-header divergence list and `docs/compat/excel-matrix.md` FORMULATEXT row to mention the divergence.

**Severity rationale:** real producer/replay invariant break (same shape as S3-HIGH-5, which was rated HIGH and pinned). The fact that Step 3 already pinned the ISFORMULA flavor demonstrates the team treats this severity as HIGH. Step 4 should mirror the discipline for FORMULATEXT.

---

### S4-HIGH-3 — Module-header doc in `reference_fns.rs` still says FORMULATEXT is "Pending"

**Where:** `crates/ql-functions/src/reference_fns.rs:8-9`

```rust
//! - **W5-RT-4 / Step 4** — text batch: FORMULATEXT (`Eager` +
//!   `ReferenceQuery::formula_text_at`). Pending.
```

**Detail:**
The module header lists each step's status. Step 4 just shipped — but the header says "Pending." This is documented as a prompt-item (Item 26): "Module header in `reference_fns.rs`: updated to cover all 3 batches" — the answer is NO. The audit-discipline pattern signal from Step 2 ("Doc-comments referencing 'added in this commit' rot the moment that commit lands") suggested describing present state without temporal language. This shipped with "Pending" on a fn that's been implemented in the same commit.

**Recommendation:**
Update the module header to remove "Pending" and reflect the post-Step-4 state. Suggested:

```rust
//! - **W5-RT-4 / Step 4** — text batch: FORMULATEXT (`Eager` +
//!   `ReferenceQuery::formula_text_at` — prepends `=` to canonical
//!   stored text per Excel canon). CLOSES the RT-V1-01 mini-phase.
```

Also remove the section-header comment at line 273-275 noting "(CLOSES mini-phase)" as a duplication once the module header is canonical.

**Severity rationale:** documentation rot of a self-describing module — concrete instance of a recurring pattern signal flagged across prior cycles. HIGH because it ships an inaccuracy directly into the source file that future grep-based audits would treat as ground truth.

---

## MEDIUM findings

### S4-MED-1 — Doc-comment claims test is in `reference_fns_step3_e2e` but actual test is in `reference_fns_step4_e2e`

**Where:**
- `crates/ql-functions/src/reference_fns.rs:293`: `/// (pinned in `reference_fns_step3_e2e`)`
- Actual test: `crates/ql-exec/tests/reference_fns_step4_e2e.rs:279` — `formulatext_of_sum_literal_range_bind_fails_v1_scope`

**Detail:**
The FORMULATEXT doc-comment cites `reference_fns_step3_e2e` for the bind-fail pin. The test is actually in `reference_fns_step4_e2e`. Pure doc-vs-reality drift — a reader following the breadcrumb to `step3_e2e` won't find the test and may waste time tracking it down.

Secondary instance: `crates/ql-functions/src/reference_fns.rs:940` (inline comment): "The e2e tests (in reference_fns_step3_e2e.rs / step4_e2e.rs) exercise the formula-bearing happy paths" — there are NO FORMULATEXT tests in `step3_e2e.rs`; only `step4_e2e.rs`. Same drift.

**Recommendation:**
Update both citations to `reference_fns_step4_e2e`.

**Severity rationale:** Two related doc-test citation drifts, exactly the kind of issue Step 2/3 pattern signals warned about. MEDIUM because the test still exists (so behavior is pinned), just the pointer is wrong.

---

### S4-MED-2 — `excel-matrix.md` FORMULATEXT test count is `9+14 e2e`; actual is `9+16 e2e`

**Where:** `docs/compat/excel-matrix.md` (FORMULATEXT row) + audit prompt itself (cites "14 e2e tests").

**Detail:**
The `reference_fns_step4_e2e.rs` file contains 16 `#[test]` functions (verified via grep + `cargo test --test reference_fns_step4_e2e` output: "running 16 tests"). The matrix says `9+14 e2e`. The audit prompt also says "14 e2e tests" — suggesting the original Step 4 plan was 14, but two more landed (likely the bind-fail pin + the cell-with-error pin). Count drift.

The 16 tests:
1. formulatext_of_formula_cell_returns_text_with_leading_eq
2. formulatext_of_complex_formula_returns_canonical_text
3. formulatext_of_literal_cell_returns_na
4. formulatext_of_blank_cell_returns_na
5. formulatext_of_1x1_range_pointing_at_formula_returns_text
6. formulatext_of_multi_cell_range_returns_na
7. formulatext_of_text_arg_returns_na
8. formulatext_of_number_arg_returns_na
9. formulatext_of_arithmetic_arg_returns_na
10. formulatext_propagates_ref_error
11. formulatext_of_cell_with_error_value_returns_na_not_propagated_error
12. formulatext_arity_zero_returns_na
13. formulatext_arity_two_returns_na
14. formulatext_cross_sheet_returns_text
15. formulatext_of_named_cell_pointing_at_formula_returns_text
16. formulatext_of_sum_literal_range_bind_fails_v1_scope

**Recommendation:**
Update matrix row to `9+16 e2e`.

**Severity rationale:** MEDIUM per the S2-LOW-1 → reconciled-to-MEDIUM pattern (matrix test counts are load-bearing for plan-completion claims).

---

### S4-MED-3 — Plan-checklist hygiene: Steps 2/3/4 boxes still unchecked despite shipped commits

**Where:** `.plans/_active.md`:
- Line 90-92: Step 2 e2e + matrix + audit boxes unchecked (Step 2 shipped at `69b16852386` + 2.1 at `98ca4e697b3`).
- Line 98-102: All Step 3 boxes unchecked (Step 3 shipped at `af7a49f87b7` + 3.1 at `43615dd7cd1`).
- Line 108-112: All Step 4 boxes unchecked (Step 4 working-tree, ready to ship).

**Detail:**
Per the global CLAUDE.md plan protocol: "Mark steps with checkboxes. Check them off as you complete work." Steps 2-3 are fully shipped per the cumulative summary; Step 4 is mid-ship. The plan file's checkboxes haven't tracked the shipped work — it's effectively a stale snapshot.

**Recommendation:**
Mark Steps 2/3 checkboxes as `[x]` to reflect shipped state. Mark Step 4 boxes as `[x]` upon Step 4 commit (post-audit-cycle). Step 5/6 remain `[ ]`. This is hygiene that should be part of the Step 4 commit OR the Step 4.1 audit-closure commit.

**Severity rationale:** plan checklist is supposed to be the live source of truth for what's shipped; reading it today would mislead a reader who hasn't read the cumulative-audit-summary doc. MEDIUM per the plan-protocol rule strength.

---

### S4-MED-4 — Missing LibreOffice cross-check for FORMULATEXT (per plan line 109)

**Where:** Plan `.plans/_active.md` line 109 enumerates "LibreOffice cross-check" as a Step 4 test requirement. Search of `reference_fns.rs` + `reference_fns_step4_e2e.rs` for "LibreOffice" finds **zero matches** for FORMULATEXT-related comments or tests. Compare:

```
$ grep "LibreOffice" reference_fns.rs
... 7 mentions, ALL for ROW/COLUMN/ROWS/COLUMNS — none for ISREF/ISFORMULA/FORMULATEXT
```

**Detail:**
Step 2 (ROW/COLUMN/ROWS/COLUMNS) shipped with LibreOffice cross-check comments (e.g., `// LibreOffice cross-check: ROW(B5) = 5`). Step 3 (ISREF/ISFORMULA) shipped WITHOUT them. Step 4 (FORMULATEXT) also shipped without them. The plan line 109 explicitly requires "LibreOffice cross-check" for Step 4.

For FORMULATEXT, the expected LibreOffice cross-checks (per design § 7 anchor table line 688):
- `FORMULATEXT(A1)` where A1 = `=1+2` → LibreOffice returns `"=1+2"`. Step 4's `formulatext_of_formula_cell_returns_text_with_leading_eq` test asserts `"=1+2"` (raw stored). Same string, **but** LibreOffice would also canonicalize spaces — verify Step 4's assertion matches LibreOffice for the same input. Note: LibreOffice 7.6 returns `"=1+2"` WITHOUT spaces (no canonicalization to `"=1 + 2"`); IronCalc canonicalizes. Document which we match.

**Recommendation:**
Add a LibreOffice cross-check comment for FORMULATEXT (and back-fill for ISREF/ISFORMULA). At minimum, document in the design or matrix doc which canonicalization stance FORMULATEXT takes: LibreOffice's (raw-stored) or IronCalc's (canonicalized). This connects to S4-HIGH-1 — whichever stance we take, the test should align with that real-world spreadsheet's behavior.

**Severity rationale:** plan-listed requirement not delivered. Same pattern as Step 2's plan-line-87 → only 5 of 8 categories shipped, reconciled-as-MEDIUM (S2-MED-γ).

---

### S4-MED-5 — Stale doc-comment on `is_reference_aware_function`

**Where:** `crates/ql-exec/src/plan.rs:505-509`

```rust
///   disjointly NOT resolve in any other tier. Direction: registry →
///   matcher. Currently covers 4 of 7 (ROW/COLUMN/ROWS/COLUMNS via
///   W5-RT-2 Step 2); extends as Step 3 (ISREF/ISFORMULA) and Step 4
///   (FORMULATEXT) ship. The matcher pre-lists all 7 by design so the
///   binder routing is stable as registrations land.
```

**Detail:**
This was the doc-comment that Step 2's S2-MED-α was already supposed to keep up to date. Steps 3+4 have shipped; the doc still says "Currently covers 4 of 7" and "extends as Step 3 ... and Step 4 ... ship" (future tense). Direct doc rot from a pattern repeatedly flagged.

**Recommendation:**
Rewrite to post-Step-4 state:

```rust
///   disjointly NOT resolve in any other tier. Direction: registry →
///   matcher. All 7 names registered as of W5-RT-4 (Step 4 — CLOSES
///   the mini-phase): ROW/COLUMN/ROWS/COLUMNS via W5-RT-2 (Step 2),
///   ISREF/ISFORMULA via W5-RT-3 (Step 3), FORMULATEXT via W5-RT-4
///   (Step 4). Pinned by `step_2_reference_aware_names_registered_in_
///   reference_tier` in this module's tests.
```

**Severity rationale:** repeat-offender doc-comment, identical pattern to S2-MED-α and Step 2 pattern signal #4. MEDIUM per the "doc-comments referencing 'in this commit' rot" rule.

---

### S4-MED-6 — Invariant test name `step_2_reference_aware_names_registered_in_reference_tier` stale post-Step-4

**Where:** `crates/ql-exec/src/plan.rs:1756`

**Detail:**
The test was added in Step 2 to cover the 4 Step-2 names; Step 3 extended the loop to add ISREF/ISFORMULA + the pending-name block for FORMULATEXT; Step 4 extended further to add FORMULATEXT and remove the pending block. The test name "step_2_*" no longer reflects what the test does — it now covers all 7 reference-tier names + the mini-phase-complete state.

**Recommendation:**
Rename to one of:
- `all_reference_aware_names_registered_in_reference_tier`
- `reference_aware_names_disjoint_across_dispatcher_tiers`

(Rename in `plan.rs`; this isn't called from outside the module so the change is local.)

**Severity rationale:** naming hygiene. MEDIUM because the name actively misleads readers searching for Step 2-specific coverage; Step 5 cross-cutting work will add more invariant tests and the naming convention matters.

---

### S4-MED-7 — `Workbook::clear_formula` (formula → literal transition) interaction not covered

**Where:** `crates/ql-exec/tests/reference_fns_step4_e2e.rs` — no test exercises the formula→literal transition.

**Detail:**
Audit prompt Item 21 calls this out specifically. The state-transition semantics of FORMULATEXT:
1. A1 has a formula → FORMULATEXT(A1) returns `"=<text>"`.
2. `clear_formula(A1)` runs → A1 becomes a literal → `formula_at(A1) = None`.
3. FORMULATEXT(A1) should return `#N/A`.

The behavior IS correct (verified by reading the impl: `formula_text_at` returns `None` after `clear_formula`, and FORMULATEXT's match arm hits the `None` → `#N/A` arm). But there's no test pinning it. The closest existing tests:
- `formulatext_of_literal_cell_returns_na` — sets up a literal from scratch; doesn't exercise transition.
- `formulatext_of_blank_cell_returns_na` — never had a formula; doesn't exercise transition.

A formula → literal transition test would catch a future regression where, e.g., `clear_formula` accidentally left the formula text behind for some path (or, conversely, where the dep-walker's 1×1 dep didn't fire on `clear_formula`).

**Recommendation:**
Add `formulatext_after_clear_formula_returns_na`: put a formula at A1, assert FORMULATEXT returns `"=<text>"`, call `clear_formula(A1)`, assert FORMULATEXT returns `#N/A`. Also add a calcgraph-attached variant that asserts the formula re-evaluates correctly after `clear_formula` fires (verifies the value-dep on A1 dirties FORMULATEXT's cell).

If declared out-of-scope for Step 4, add to Step 5 cross-cutting suite — but Step 5 plan checklist doesn't currently enumerate it.

**Severity rationale:** state-transition coverage gap that the prompt explicitly listed. MEDIUM because the impl is correct today, but the test missing means a regression could slip.

---

### S4-MED-8 — FORMULATEXT(NamedMultiCellRange) → #N/A not tested

**Where:** Only `formulatext_of_named_cell_pointing_at_formula_returns_text` exists (1×1 named range). No test for multi-cell named range.

**Detail:**
Design § 7 cross-fn coverage matrix line 698 ("Named-range arg") and design § 2.5 (multi-cell → #N/A) implicitly require this combination. The named-range happy-path is covered for 1×1 only.

The materializer path: `Expr::NameRef` → `ExprPlan::AggregateNameRef { range }` → `materialize_ref_arg_eager` → `RefArg::Range { range, values: vec![] }`. If the range is multi-cell, FORMULATEXT's impl hits the `[RefArg::Range { .. }]` non-1×1 arm → `#N/A`. Behavior is correct, but untested for the named-multi-cell shape.

**Recommendation:**
Add `formulatext_of_named_multi_cell_range_returns_na`:
```rust
let mut wb = workbook_with_sheet();
wb.set_name("MyRange", NamedTarget::Range(Range::new(0, 0, 0, 2, 1))).unwrap();
// ... FORMULATEXT(MyRange) → #N/A
```

**Severity rationale:** coverage gap of the cross-product (named × multi-cell). MEDIUM because it pins a non-trivial materializer→fn-impl path against future regressions (named-range materialization, range normalization, fn-impl multi-cell arm).

---

### S4-MED-9 — `FORMULATEXT(SUM(NamedRange))` claim in doc-comment is untested

**Where:** `crates/ql-functions/src/reference_fns.rs:294-295`

```rust
///   The named-range form `FORMULATEXT(SUM(NamedRange))` evaluates
///   eagerly and returns `#N/A` (SUM result is Scalar, not Reference).
```

**Detail:**
The doc-comment claims this path works (evaluates SUM eagerly, returns #N/A because SUM's result is Scalar). No test in `reference_fns_step4_e2e.rs` exercises `FORMULATEXT(SUM(NamedRange))`. Mirrors the S2 pattern: docs make claims that the test suite doesn't pin.

If the claim is wrong (e.g., SUM(NamedRange) bind-fails for FORMULATEXT's arg position for the same reason as `SUM(A1:A3)`), a reader would believe the doc-comment without realizing it's not pinned.

**Recommendation:**
Either add a `formulatext_of_sum_named_range_returns_na` test verifying the doc claim, OR remove the doc claim and replace with "(this path's behavior is not pinned in v1)".

**Severity rationale:** documented behavior claim without test. MEDIUM per the recurring pattern signal "documented contracts must have pinning tests."

---

### S4-MED-10 — Cross-sheet test uses sheet name `S1` instead of design-doc's `Sheet1`/`Sheet2`

**Where:**
- Design § 7 cross-fn matrix line 700: `ISFORMULA(Sheet2!A1)`, `FORMULATEXT(Sheet2!A1)`.
- Test `formulatext_cross_sheet_returns_text` uses `FORMULATEXT(S1!B5)`.

**Detail:**
Two different sheet-naming conventions in design vs test. Not a defect (both work; sheet name is arbitrary) but the divergence undermines using design § 7 as a coverage reference doc.

**Recommendation:**
Either rename the test workbook's sheets to `Sheet1`/`Sheet2` to match design, OR update design § 7 to use `S0`/`S1` (cheaper-to-type, matches `workbook_with_two_sheets`-style fixtures). Minor.

**Severity rationale:** doc-vs-impl naming drift. MEDIUM because it touches a cross-referenced contract surface; if a future audit grep'd for `Sheet2` to find the cross-sheet test, the grep would fail.

---

### S4-MED-11 — Empty-string formula edge case unreachable but undefended

**Where:** `crates/ql-exec/src/env.rs:312-319` (`formula_text_at` impl).

**Detail:**
If `Workbook::formula_at` returned `Some(Arc::from(""))` (an empty string), `formula_text_at` would return `Some("=")`. FORMULATEXT(A1) would return `Value::Text("=")`. Today the empty-formula state is unreachable: `set_formula` would lex+parse-fail on empty input; `put_formula` raw is internal-test-only in product paths. But `Workbook::put_formula` is `pub`, and a future code path or external integration (e.g., `ql-io` reading a corrupted `.qbook/` formula table) could land an empty string.

Same concern: a single-`=` formula (e.g., `put_formula("=")`)—lex/parse fails downstream, but FORMULATEXT would return `"==`" (double `=`) defensively.

**Recommendation:**
Either add a guard in `formula_text_at` (if `arc.is_empty() { return None; }`), OR add an invariant assertion in `Workbook::put_formula` rejecting empty strings, OR add a defensive test pinning the current behavior so a future change is intentional.

**Severity rationale:** defensive gap, not a today-reachable bug. MEDIUM because the `pub` surface area is small but real — `ql-io` could land malformed text on load.

---

## LOW findings

### S4-LOW-1 — Comment in `reference_fns.rs` line 939 says "Unit tests use NoOpReferenceQuery → always returns None → #N/A"

**Where:** `crates/ql-functions/src/reference_fns.rs:937-941`

**Detail:** This is true and useful. But the comment doesn't explain WHY (the production `WorkbookEnv` impl is on `ql-exec` which can't be a `ql-functions` dep — circular dep). A reader unfamiliar with the crate graph might wonder why we test through a no-op. Optional clarity.

**Recommendation:** Add a one-line explanation: "Storage-level tests use `Workbook` directly in `reference_fns_step4_e2e.rs` (ql-exec crate) — `ql-functions` can't depend on `ql-storage` without breaking the crate graph."

**Severity rationale:** documentation completeness, LOW.

---

### S4-LOW-2 — `Workbook` `pub fn put_formula` doc-comment doesn't warn about FORMULATEXT round-trip

**Where:** `crates/ql-storage/src/workbook.rs:830-853`

**Detail:** `Workbook::put_formula` stores the text verbatim. Callers using it directly (instead of `WorkbookRuntime::set_formula`) get their raw text back from `formula_at` — and FORMULATEXT will prepend `=` to that raw text. If a caller passes `"=1+2"` (with leading `=`), FORMULATEXT returns `"==1+2"`. The doc-comment lists Phase 2A.13 bounds checks but says nothing about formula-text canonicalization or the FORMULATEXT interaction.

**Recommendation:** Add a paragraph noting that callers should pass formula text WITHOUT leading `=` and that this method does NOT canonicalize (R1C1 / locale-separator / space-normalization). Reference `WorkbookRuntime::set_formula` as the canonicalizing alternative. Connects to S4-HIGH-1.

**Severity rationale:** doc-comment gap on a `pub` API. LOW because the unwary caller is also doing something off-the-beaten-path.

---

### S4-LOW-3 — Single-arity test name inconsistency

**Where:** `crates/ql-exec/tests/reference_fns_step4_e2e.rs:227-237`

Test names:
- `formulatext_arity_zero_returns_na`
- `formulatext_arity_two_returns_na`

But the unit-test equivalents in `reference_fns.rs` use different (consistent-within-file) names:
- `formulatext_arity_zero_returns_na`
- `formulatext_arity_two_returns_na`

Same names actually — false alarm. Skip.

**Reclassified:** N/A. Discarding finding.

---

### S4-LOW-4 — FORMULATEXT R1C1-mode user receives EnUs A1 output (documented divergence not in matrix)

**Where:** Design § R4 (line 730) mentions canonicalization divergence; `docs/compat/excel-matrix.md` FORMULATEXT row doesn't mention the R1C1-vs-A1 mode divergence.

**Detail:** When the workbook is in R1C1 mode (`Workbook::set_reference_mode(R1C1)`), `WorkbookRuntime::set_formula` still canonicalizes to A1+EnUs (`workbook_runtime.rs:573-578`). FORMULATEXT returns the A1+EnUs text — not R1C1. Excel matches the active reference mode; we always return A1.

**Recommendation:** Add a clause to the matrix row mentioning this. Already in design § R4 as a documented divergence; surface it in the user-visible matrix doc too.

**Severity rationale:** documented but not user-surfaced. LOW.

---

### S4-LOW-5 — `formulatext` impl arm ordering: `Reference` before 1×1 `Range` — confirm not load-bearing for materializer-emitted Range from CellRef

**Where:** `crates/ql-functions/src/reference_fns.rs:307-336`

**Detail:** The match arms:
1. `[RefArg::Error(ev)]`
2. `[RefArg::Reference { address, .. }]`
3. `[RefArg::Range { range, .. }]` if 1×1
4. `[RefArg::Range { .. } | RefArg::Array(_) | RefArg::Scalar(_) | RefArg::Shape(_)]`
5. `_` fallthrough

`materialize_ref_arg_eager` emits `RefArg::Reference` for `ExprPlan::CellRef` (single cell) and `RefArg::Range` for `AggregateNameRef`/`RangeRef`/`StructuredRef`-narrowed-to-multicell. A 1×1 `ExprPlan::RangeRef` (e.g., `A1:A1`) would emit `RefArg::Range { range: 1×1 }` — caught by arm 3. A 1×1 named range likewise → `RefArg::Range` → arm 3. A 1×1 structured-ref narrowed → `RefArg::Range` → arm 3. ✓

The ordering is correct, but consider adding a comment block at the head of the match describing the arm-coverage invariant — for future readers / Step 5 work.

**Recommendation:** Add a short comment block. Or skip; current style is consistent with ISFORMULA.

**Severity rationale:** style/clarity. LOW.

---

### S4-LOW-6 — `coverage.rs` EXPLICITLY_DEFERRED entry says "ql-exec WorkbookEnv-backed storage-level e2e" — but the cross-sheet + named-cell tests also use the `bind_with_names_and_sheets` chain

**Where:** `crates/ql-functions/tests/coverage.rs:645-651` (Step 4 FORMULATEXT entry).

**Detail:** The phrasing is accurate but could be more specific about which paths are exercised. Step 3.1 ran into the same precision issue (S3-MED-α: "workbook-runtime e2e" claim → reworded). Step 4's entry sidesteps that by saying "WorkbookEnv-backed storage-level e2e" — good. But Step 4 also exercises name-table binding + sheet resolution (`bind_with_names_and_sheets(..., &wb, &wb)`), which is NOT pure storage-level. The coverage-doc reason could explicitly mention name-lookup + sheet-resolver coverage.

**Recommendation:** Update reason string to: "WorkbookEnv-backed e2e via storage-level `Workbook::put_formula` + name/sheet-resolver chain (`bind_with_names_and_sheets`); covers single-cell, 1×1 range, cross-sheet, named-cell, cell-with-error-value not-propagated, plus bind-fail pin for literal-range nested SUM."

**Severity rationale:** doc-precision LOW.

---

### S4-LOW-7 — Concrete formula text in matrix doc doesn't explain canonicalization divergence

**Where:** `docs/compat/excel-matrix.md` FORMULATEXT row.

**Detail:** The row says "returns canonical formula text WITH leading `=` (Excel canon)" — which is the design-promise framing but doesn't acknowledge the producer-API divergence flagged in S4-HIGH-1.

**Recommendation:** If S4-HIGH-1's resolution is option 3 (document the divergence), update the matrix row to mention it. If it's option 1 or 2 (fix the canonicalization), the row is correct as-written but should reference the new boundary.

**Severity rationale:** propagation of HIGH-1 to the user-facing matrix doc. LOW only because HIGH-1 carries the substantive concern.

---

### S4-LOW-8 — `formulatext` impl uses `text.into()` for Value::Text — defensive review

**Where:** `crates/ql-functions/src/reference_fns.rs:314, 326`

**Detail:** `text` is a `String`; `Value::Text` wraps `Arc<str>`; `text.into()` converts via the `From<String> for Arc<str>` impl. Allocates a new `Arc<str>` from the `String`. Functionally correct. A future micro-opt: have `formula_text_at` return `Arc<str>` directly (skipping the intermediate `String` allocation), since `Workbook::formula_at` already returns `&Arc<str>`. Cost: `format!("={...}")` doesn't compose with Arc cleanly, but a custom builder using `Arc::from(format!(...))` works.

**Recommendation:** Defer to a follow-up. Current code is clear and correct.

**Severity rationale:** micro-optimization, LOW.

---

### S4-LOW-9 — Audit prompt cites pre-Step-4 tests as 3235 and post-Step-4 as 3260; my run shows 3154 total

**Where:** Audit prompt header.

**Detail:** My `cargo test` run (PATH-fixed Rustup 1.95.0) reports 3154 tests passing. The prompt cites 3260. Discrepancy of 106. Possibilities:
1. Doc tests not counted in my run (verified: `cargo test --doc` reports 0 doc tests).
2. Some test target is conditionally compiled and skipped on my env.
3. The prompt's count is off — the cycle 4 (Step 3) summary cited 3229; +25 for Step 4 puts it at 3254, not 3260.

The discrepancy is a metadata issue — gates still green either way — but it's worth flagging that prompt-stated counts don't match my run.

**Recommendation:** Verify the canonical test count for the engine before declaring Step 4 complete. Adjust the prompt + audit-summary numbers if 3154 is correct.

**Severity rationale:** metadata accuracy, LOW.

---

### S4-LOW-10 — Step 5 plan checklist doesn't include the deferrals from Step 4

**Where:** `.plans/_active.md` line 117-123 (Phase 5).

**Detail:** Step 5 lists structured-ref, implicit-intersection, row-limit boundaries, ISREF no-eval, ISFORMULA on blank cell, FORMULATEXT leading-`=`. Step 4 deferred clear_formula transitions (S4-MED-7), named-multi-cell-range FORMULATEXT (S4-MED-8), and `FORMULATEXT(SUM(NamedRange))` (S4-MED-9). These don't appear in Step 5's checklist either.

**Recommendation:** Update Step 5 plan items to include the deferrals. Alternatively, fold them into Step 4's commit as an audit-closure follow-up.

**Severity rationale:** plan-hygiene, LOW.

---

### S4-LOW-11 — `formulatext` impl pattern `[RefArg::Range { .. } | RefArg::Array(_) | ...]` shape order

**Where:** `crates/ql-functions/src/reference_fns.rs:332`

**Detail:** Order of variants in the OR-pattern: `Range`, `Array`, `Scalar`, `Shape`. ISFORMULA uses the same order (line 266). For readability, alphabetical or "most common first" might be clearer. Style-only.

**Recommendation:** Leave as-is; consistency with ISFORMULA matters more than ordering taste.

**Severity rationale:** style, LOW.

---

### S4-LOW-12 — `step_2_reference_aware_names_registered_in_reference_tier` doc-comment lines 1746-1754 partially stale

**Where:** `crates/ql-exec/src/plan.rs:1745-1754`

**Detail:** The doc-comment still says: "**Step 2.1 (S2-MED-γ closure):** also asserts the Step 3/4 names (ISREF / ISFORMULA / FORMULATEXT) are NOT yet registered". This is no longer true post-Step-4. The Step 4 update comment at line 1800 mentions the removal, but the head doc-comment wasn't updated.

**Recommendation:** Update the doc-comment block (lines 1745-1754) to reflect the post-Step-4 state. Remove the "Step 2.1 ... NOT yet registered" prose since it no longer applies.

**Severity rationale:** stale doc-comment within the test that's the canonical invariant. Same pattern as S4-MED-5 + S4-HIGH-3; LOW because the test logic is correct, only the doc-comment header is stale.

---

## Summary of independent verification (per CLAUDE.md "verify before claiming")

| Item from audit prompt | Verified | Outcome |
|--|--|--|
| 1. Leading-`=` invariant — no double-prepending | YES | Pre-prepend impl correct for `formula_at` returning text without `=`. Double-prepend risk only if `Workbook::put_formula("=...")` is called raw — flagged as S4-LOW-2. |
| 2. set_formula canonicalization vs put_formula raw text | YES | **REAL DIVERGENCE** — S4-HIGH-1. Verified by reading `workbook_runtime.rs:566-583` (canonical) vs `transaction.rs:206-232` (raw) vs `workbook.rs:830` (raw). |
| 3. Multi-cell `#N/A` per Microsoft | YES | Impl + tests match. |
| 4. 1×1 range single-cell | YES | Impl + unit + e2e tests match. |
| 5. S3-HIGH-1 lesson applied (CellRef materializer) | YES | scalar.rs:577-595 emits Reference { address } only; FORMULATEXT test `formulatext_of_cell_with_error_value_returns_na_not_propagated_error` pins. |
| 6. Cross-sheet | YES | Test `formulatext_cross_sheet_returns_text` exists. |
| 7. Named-cell 1×1 | YES | Test `formulatext_of_named_cell_pointing_at_formula_returns_text` exists. Multi-cell named missing — S4-MED-8. |
| 8. FORMULATEXT dep-tracking via normal walker | YES | calcgraph_session.rs:309-313 — FORMULATEXT falls through to normal walker. |
| 9. Value-dep on referenced cell | YES | Pinned by `dep_suppressed_reference_fns_match_design`. |
| 10. Cross-sheet dep correctly registered | YES | Walker handles cross-sheet via CellRef.sheet/Range.sheet. |
| 11. Invariant test extended to all 7 | YES | plan.rs:1762-1770 — loop covers all 7. |
| 12. Count bump 199 → 200 | YES | registry.rs:899 + test passes. |
| 13. Disjointness | YES | All 4 other tiers checked in the loop. |
| 14. Per-fn 9 unit + 16 e2e (claimed 14) | PARTIAL | Count mismatch — S4-MED-2. |
| 15. Leading-`=` test exists | YES | `formulatext_of_formula_cell_returns_text_with_leading_eq` asserts `text.starts_with('=')`. |
| 16. Producer/replay divergence for FORMULATEXT-on-self | NOT PINNED | S4-HIGH-2. |
| 17. SUM(A1:A3) bind-fail pin | YES | `formulatext_of_sum_literal_range_bind_fails_v1_scope` exists. |
| 18. Cell-with-error-value test | YES | Exists and passes. |
| 19. Plan-cache: cell-INDEPENDENT | YES | Workbook_runtime.rs:600 — cell_anchor only set on `@`-bearing canonical text. FORMULATEXT plans cell-independent. |
| 20. Op-log replay correctness | INDIRECT | Verified via `replay.rs:323-332` calling `put_formula` directly. Replay reuses producer-side text — consistent. |
| 21. `clear_formula` interaction | NOT TESTED | S4-MED-7. |
| 22. set_formula → store body without `=` → prepend `=` | YES | Round-trip verified by reading workbook_runtime.rs + env.rs. |
| 23. Matrix counts | INCORRECT | S4-MED-2. |
| 24. Doc-comments vs impl drift | YES | Multiple drifts: S4-MED-1 (test file path), S4-HIGH-3 (module header), S4-MED-5 (`is_reference_aware_function`), S4-LOW-12 (test doc). |
| 25. Design vs impl | MOSTLY | Matches except S4-HIGH-1 canonicalization claim. |
| 26. Module header updated | NO | S4-HIGH-3. |
| 27. Design + plan status update for Step 5/6 | PENDING | Plan checkboxes not updated — S4-MED-3. |
| 28. All 7 reference-tier fns registered | YES | Verified. |
| 29. Mini-phase closure docs | PENDING | Step 5/6 still ahead. |

---

## Summary table

| ID | Severity | Subject |
|--|--|--|
| S4-HIGH-1 | HIGH | Canonicalization promise broken by Transaction::put_formula + raw put_formula paths |
| S4-HIGH-2 | HIGH | `=FORMULATEXT(A1)` self-reference producer/replay divergence not pinned (parallel to S3-HIGH-5) |
| S4-HIGH-3 | HIGH | Module-header doc still says FORMULATEXT is "Pending" |
| S4-MED-1 | MEDIUM | Doc-comment cites `reference_fns_step3_e2e` but test is in `reference_fns_step4_e2e` |
| S4-MED-2 | MEDIUM | Matrix says `9+14 e2e` but actual is `9+16` |
| S4-MED-3 | MEDIUM | Plan-checklist hygiene: Steps 2/3/4 boxes still unchecked |
| S4-MED-4 | MEDIUM | Missing LibreOffice cross-check for FORMULATEXT (plan line 109) |
| S4-MED-5 | MEDIUM | Stale doc-comment on `is_reference_aware_function` (plan.rs:505-509) |
| S4-MED-6 | MEDIUM | Invariant test name `step_2_*` stale post-Step-4 |
| S4-MED-7 | MEDIUM | `clear_formula` (formula → literal) transition not covered |
| S4-MED-8 | MEDIUM | FORMULATEXT(NamedMultiCellRange) → #N/A not tested |
| S4-MED-9 | MEDIUM | `FORMULATEXT(SUM(NamedRange))` doc-comment claim untested |
| S4-MED-10 | MEDIUM | Cross-sheet test uses `S1` instead of design-doc's `Sheet2` |
| S4-MED-11 | MEDIUM | Empty-string formula edge case unreachable but undefended |
| S4-LOW-1 | LOW | Test-helper comment doesn't explain crate-graph rationale |
| S4-LOW-2 | LOW | `Workbook::put_formula` doc-comment doesn't warn about FORMULATEXT interaction |
| S4-LOW-4 | LOW | FORMULATEXT R1C1-mode user receives EnUs A1 output (not in matrix) |
| S4-LOW-5 | LOW | `formulatext` impl match-arm ordering — clarity comment optional |
| S4-LOW-6 | LOW | `coverage.rs` reason string could be more precise about exercise paths |
| S4-LOW-7 | LOW | Matrix doc doesn't acknowledge canonicalization divergence |
| S4-LOW-8 | LOW | `text.into()` allocation — micro-opt deferred |
| S4-LOW-9 | LOW | Audit-prompt total-tests count off (3260 vs my-run 3154) |
| S4-LOW-10 | LOW | Step 5 plan checklist doesn't include Step 4 deferrals |
| S4-LOW-11 | LOW | OR-pattern variant order — style |
| S4-LOW-12 | LOW | Invariant test doc-comment lines 1745-1754 partially stale |

**Counts:** 3 HIGH + 11 MEDIUM + 11 LOW (excluding 1 discarded LOW-3) = **25 findings**.

---

## Cross-cutting pattern signals (Step 4 cycle)

1. **The S2/S3 pattern signal "doc-comments referencing 'added in this commit' rot the moment that commit lands" continues to fire.** S4-HIGH-3 (module header "Pending"), S4-MED-5 (is_reference_aware_function), S4-LOW-12 (test doc-comment). Pre-commit grep for "Pending"/"will ship"/"Step N work" in changed files would catch instances. Recommend adding this to the engine commit discipline.

2. **Canonicalization promise depends on producer-API choice.** S4-HIGH-1 — `Workbook::formula_at`'s "canonical" contract is enforced by `WorkbookRuntime::set_formula` only. `WorkbookTransaction::put_formula` (a parallel public producer) bypasses canonicalization silently. Pattern signal: when a downstream contract (FORMULATEXT canonical output) is verified against ONE producer, audit ALL producers reaching the same storage state.

3. **Plan-checklist hygiene drifts when multiple commits ship.** S4-MED-3 — Steps 2/3 fully shipped, boxes unchecked. The handoff/cumulative-audit-summary docs are accurate but the plan file isn't. Pattern signal: every "shipped W5-RT-X" commit message should be paired with a `.plans/_active.md` checkbox flip.

4. **Test count drift across docs.** S4-MED-2 + S4-LOW-9. The matrix doc says "14 e2e"; the audit prompt says "14 e2e tests"; actual is 16. The total-tests count in the prompt header (3260) doesn't match my run (3154). Pattern signal: machine-extract test counts via `cargo test 2>&1 | grep "test result" | awk` rather than hand-counting.

5. **Self-reference producer/replay invariant doesn't carry across fn boundaries.** S4-HIGH-2 — Step 3 pinned ISFORMULA self-reference; Step 4 didn't pin FORMULATEXT self-reference even though the same shape applies. Pattern signal: when fixing an invariant for one fn, audit all fns sharing the same underlying mechanism (here: `is_formula_at` and `formula_text_at` both query workbook state that's installed AFTER eval).

---

## Final state

Output file: `docs/audits/2026-05-17-rt-step-4-opus.md`
**Counts: 3 HIGH + 11 MEDIUM + 11 LOW = 25 findings.**
