---
title: Phase 5.3 step 3 audit synthesis (rename-repair pass, CORE 5.3 work)
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~135k tokens) — full transcript: `2026-05-20-phase-5-3-step-3-codex.md`
  - Opus subagent (83k tokens, 252s) — full transcript: `2026-05-20-phase-5-3-step-3-opus.md`
audit_target: commit `e76a9ce5499` (step 3 ship) + `4222d11fe7b` (lockfile)
closure_commit: (this commit — step 3 audit closures)
---

## Engagement headline

**5th consecutive DIVERGENT-HIGH cycle** in Phase 5.3. Codex returned **FAIL (HIGH × 2 + LOW)**. Opus returned **PASS-WITH-FINDINGS** (1 HIGH + 4 MEDIUM + 4 LOW). Both **CONVERGED on the cascade HIGH** but framed it differently:
- Codex HIGH-1: `{A→B, B→C}` cascade where peer A renamed sheet 1 `B→C` and sheet 0 `A→B`.
- Opus HIGH-1: same root cause, different scenario shape (sheet 0 `S→A`, sheet 1 `A→C`).

Both diagnose the rule-iteration-cascade. Codex also caught a **second HIGH** (HIGH-2: historic names live forever even when reused by a new sheet) that Opus rolled into the general class.

## Convergent findings (both auditors)

| Finding | Codex | Opus | Closure |
|---|---|---|---|
| Cross-sheet cascade corruption (rule iteration mis-retargets formula) | HIGH-1 | HIGH-1 | New safety guard: skip rules where `old_canonical` is currently held by ANY sheet. Closes both scenarios with one guard. |
| Doc claim "later in iteration wins" is inaccurate | LOW | (rolled into HIGH) | Module docstring rewritten with accurate cascade vs reused-name explanations. |
| `Cargo.lock` separate commit hygiene | implicit | LOW-3 | Noted for future. |

## Unique to Codex

| Finding | Severity | Closure |
|---|---|---|
| Historic names live forever even when current sheet reuses the name | HIGH-2 | Same guard as Opus HIGH-1 closes this. New test `step3_audit_historic_name_reused_by_new_sheet_does_not_corrupt`. |

## Unique to Opus

| Finding | Severity | Closure |
|---|---|---|
| Helper duplication (repair.rs ≈ sheets.rs) — bomb for step 4 | MEDIUM-1 | **DEFERRED to step 4**. Plan updated. |
| No-op fast path missing (empty rules still walks formulas) | MEDIUM-2 | Early-return when rules vec is empty. |
| Production wiring missing (function pub but no production caller) | MEDIUM-3 | Documented as deferred follow-up. |
| Test 7 printer-output assertion brittleness | MEDIUM-4 | Deferred (not a bug, tightening). |
| Cross-sheet formula refs untested | LOW-1 | New test `step3_audit_cross_sheet_formula_reference_gets_rewritten`. |
| Test 10 multi-occurrence assertion weak | LOW-2 | Strengthened to pin BOTH `Calculations!A1` AND `Calculations!B2`. |
| `_origin_sheet` field dead code | LOW-4 | Now used for `RepairReport.ambiguous_rules_skipped.origin_sheet`. |

## Code changes summary

**`crates/ql-collab/src/repair.rs`**:
- Added `AmbiguousSkip` struct + `RepairReport.ambiguous_rules_skipped` field.
- New algorithm phase 2: build `canonical_to_current_sheet: HashMap<String, SheetId>` of all current sheet names.
- Rule-building phase: skip rules whose `old_canonical` is in the current-name map; record in `ambiguous_rules_skipped`.
- New algorithm phase 4: fast-path no-op return when rules vec is empty.
- Module docstring rewritten with accurate cascade/reused-name limitations + safety guard rationale.

**`crates/ql-collab/src/lib.rs`**: re-export `AmbiguousSkip`.

**`crates/ql-collab/tests/repair_renames.rs`**:
- NEW: `step3_audit_cross_sheet_cascade_does_not_corrupt_formula` (HIGH-1 regression).
- NEW: `step3_audit_historic_name_reused_by_new_sheet_does_not_corrupt` (HIGH-2 regression).
- NEW: `step3_audit_cross_sheet_formula_reference_gets_rewritten` (LOW-1).
- MODIFIED: `repair_report_carries_diagnostic_information` — multi-occurrence assertions strengthened (LOW-2).

## Deferred items (step 4 / future)

| Item | Severity | Defer reason | Step |
|---|---|---|---|
| Helper unification (promote to ql-formula-syntax) | MEDIUM | Step 4 will add RenameTable + RenameColumn helpers; unify all three together | Step 4 |
| Production wiring (`CollabSession::repair_on_merge`) | MEDIUM | V1 design is caller-driven; production wiring is intentional follow-up | Post-Phase 5.3 |
| Printer-output assertion brittleness | MEDIUM | Not a bug, tightening; defer | Future |
| Cross-sheet historic-name ambiguity (when neither held) | (documented limitation) | Rare; requires causality-aware tracking | Post-V1 |

## Closure metrics

- Original step 3 ship: 10 tests, repair module at 262 LOC.
- After closure: 13 tests, repair module at ~290 LOC (added guard + AmbiguousSkip type + fast path).
- Workspace tests: 4317 → 4320 (+3 net) with `--test-threads=1`.
- Files modified: 3 (repair.rs, lib.rs, repair_renames.rs).
- fmt + clippy: clean.

## Audit-discipline observation

The 5-cycle divergent-HIGH pattern in Phase 5.3 continues to validate the multi-auditor discipline. Step 3 is the CORE 5.3 work — most complex single step in the arc — and BOTH auditors caught the same algorithm bug from different angles within ~250-300s each. Codex's tactical adversarial probing surfaced the cascade via a precise repro scenario; Opus's holistic analysis found the same bug plus surrounding architectural issues (helper duplication, production wiring, no-op fast path). The pattern is structurally load-bearing.

## Forward implications

- **Step 4 design**: helper unification + RenameTable/RenameColumn extension + auto-disambiguation guard applied to table/column rename targets. The guard's "skip if current holder exists" pattern transfers directly.
- **Step 5 megaudit**: should explicitly probe the documented "cross-sheet ambiguity" limitation case (when neither historic is current) + production wiring gap.
- **Step 6 exit packet**: production wiring decision (auto-hook into merge_bytes vs caller-driven) needs explicit closure in the V1 limitations / V2 backlog section.
