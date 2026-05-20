---
title: Phase 5.3 step 1 audit synthesis (conflict matrix test pinning)
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~203k tokens) — full transcript: `2026-05-20-phase-5-3-step-1-codex.md`
  - Opus subagent (101k tokens, 423s) — full transcript: `2026-05-20-phase-5-3-step-1-opus.md`
audit_target: commit `a6babc65b51` (step 1 ship `5595d8dcfb0` + fmt-reconcile `a6babc65b51`)
closure_commit: (this commit — Phase 5.3 step 1 audit closures)
---

## Engagement headline

**3rd consecutive DIVERGENT-HIGH cycle** in the post-D-1 era. Codex returned **FAIL (HIGH)** + 2 MEDIUM + 2 LOW. Opus returned **PASS-WITH-FINDINGS** (1 HIGH + 3 MEDIUM + 2 LOW). Both converged on HIGH-1 (row 3 degenerate) — independent verification.

## Convergent findings (both auditors)

| Finding | Codex severity | Opus severity | Closure |
|---|---|---|---|
| **HIGH-1**: Row 3 `Value::Number(7.0)` assertion can't distinguish literal vs formula winner (both = 7.0) | HIGH | HIGH-1 | Row 3 rewritten: literal=7.0 + formula="99-50"=49.0 (distinct); `formula_at` convergence assertion; match on distinct values |
| **MEDIUM-1**: Matrix labeling off — design doc has 8 rows; test calls "row 7" the DropTable row (actually row 8); row 7 (RenameSheet × edit) was missing | MEDIUM | MEDIUM-1 | Added new `row7_rename_sheet_concurrent_edit_yields_name_error_pre_step_3_fix` pinning pre-fix #NAME? (step 3 will modify); renamed DropTable test to row 8 |
| **MEDIUM-3 (Codex M3 / Opus M3)**: Row 5 `BatchCommit` wrapping is a confound; should race only SetName ops with PutFormula in base | LOW-2 | MEDIUM-3 | Row 5 restructured: `PutFormula("TaxRate")` baked into base log; peers race only SetName |

## Unique to Codex

| Finding | Severity | Closure |
|---|---|---|
| **Codex MEDIUM-2**: Rows 2 + 4 only check observable value; could pass with wrong formula text | MEDIUM | Added `formula_at` convergence assertions + structural disambiguation to row 2 + row 4 |
| **Codex LOW-1**: Row 6 doesn't pin exact name convergence (just "both names present in each peer's view") | LOW | Tightened to `assert_eq!(names_a, names_b)` + `assert_eq!(names_a, vec!["Calc", "Calc(2)"])` |

## Unique to Opus

| Finding | Severity | Closure |
|---|---|---|
| **Opus MEDIUM-2**: Plan understates step 4. `apply_rename_table` (replay.rs:691) and `apply_rename_column` (replay.rs:749) have IDENTICAL `old_canonical` lookup hard-fail bug to RenameSheet. Step 4 is "extend step 2," not "investigate." | MEDIUM | Updated `.plans/_active.md` step 4 + task #4 description: "extend step 2's fix" with replay.rs:691 + 749 references; revised effort from 0.5-1d "investigation" to ~0.5d "implementation" |
| **Opus LOW-1**: `merged_log_round_trips_deterministically` uses raw `import_bytes` — discipline inconsistency | LOW | Switched to `fork_with_peer(&base, PEER_*_ID)` |
| **Opus LOW-2**: Peer-id stability note should go in design doc NOW (step 6 deferral saves no time; step 2 will rediscover) | LOW | Added "Peer-id stability is a precondition for CRDT convergence" subsection to `crdt-data-model.md` § 311-334 |

## Verifications recorded (no closure needed)

Both auditors independently confirmed:
- `fork_with_peer` discovery is real load-bearing structural insight
- `fork_apply_merge_both_directions` directionally correct (peer_a_for_b should be PEER_A_ID, matching source author — Loro import preserves source op-ids)
- Production code at `ql_collab::CollabSession::new` + `from_snapshot` already sets stable non-zero peer-ids (D-1 step 8 megaudit closure) — no production gap
- D-4 tests are NOT secretly broken — their assertions are direction-independent so they don't need `fork_with_peer`

## Closure metrics

- Original: 8 tests at HEAD `a6babc65b51` (4299 workspace tests)
- After closure: 9 tests at HEAD (this commit) (4300 workspace tests)
- New test: `row7_rename_sheet_concurrent_edit_yields_name_error_pre_step_3_fix` — pins pre-fix #NAME? behavior; step 3 will modify
- Files modified: 3 (test file, design doc, plan file) + task #4 description
- fmt + clippy: clean

## Audit-discipline observation

The 3-cycle divergent-HIGH pattern from D-1 (steps 5, 6, 7) extended into Phase 5.3 step 1. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 2 + step 3 + step 4 + step 5 megaudit) should expect the same: parallel Codex + Opus, with closure for both, before progressing.

## Forward implications

- **Step 2 design**: peer-id stability is now documented; step 2 engineer doesn't need to rediscover.
- **Step 3 design**: row 7 is now a TEST that step 3 will modify; modifying that test is the OBSERVABLE step-3 win.
- **Step 4 scope**: revised down to ~0.5 day "extend step 2 + step 3." Codex's deferred-from-survey concern about parallel hard-fails in replay.rs:691 + 749 confirmed by Opus.
