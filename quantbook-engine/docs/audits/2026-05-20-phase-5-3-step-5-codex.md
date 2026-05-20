Reading prompt from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/sanzhar/.codex/memories]
reasoning effort: xhigh
reasoning summaries: none
session id: 019e4656-018e-75b0-ba62-95824ebb75cf
--------
user
# Phase 5.3 step 5 — 3-way megaudit (Codex lane) 2026-05-20

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target**: full Phase 5.3 arc. HEAD `18ad97d5725` (plan doc) on top of `6752ca2545c` (step 4 audit closures). The 5.3 arc spans commits:
- Step 1 ship `5595d8dcfb0` + fmt `a6babc65b51`; closure `03408fa17bd`
- Step 2 ship `1ed2bbba78a`; closure `f426683fee0`
- Step 3 ship `e76a9ce5499` + lockfile `4222d11fe7b`; closure `6bb76e3ade3`
- Step 4 ship `7126eb44396`; closure `6752ca2545c`
- Plan doc `18ad97d5725`

**Workspace state at HEAD**: 4334 tests passing / 0 failed with `--test-threads=1`; fmt + clippy clean.

**Phase 5.3 is at 4/6 steps complete.** This megaudit (step 5) precedes the exit packet (step 6). Audit-discipline ledger: 8 per-step audit cycles ran in 5.3 (4 ship audits + 4 closure cycles), 6 consecutive divergent-HIGH cycles. Every per-step audit caught a real HIGH; closures landed substantial code changes including a step-4 revert.

## Audit history pointers (read these before forming findings)

- `quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md`
- `quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md`
- `quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-consolidated.md`
- `quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md`
- `quantbook-engine/.plans/_active.md` — full plan; § "V1 limitations stack" near line 115
- `quantbook-engine/docs/architecture/crdt-data-model.md` § 311-360 — conflict resolution matrix + peer-id stability invariant

## Your lane: CROSS-STEP INVARIANTS + WORKSPACE GREP + V1-LIMITATION RE-VERIFICATION

You are the **Codex lane** of a 3-way megaudit (the other two are Opus subagents running adversarial probe synthesis + doc completeness in parallel). Your job is tactical, workspace-wide, and adversarial against confirmation bias accumulated across 4 cycles.

### Required deliverables

1. **Stale-pattern grep**: search the workspace for patterns that the 5.3 ship should have removed but might still exist:
   - References to `SheetRenameNameMismatch` outside `replay.rs` (variant is deprecated but kept for ABI)
   - References to `to_legacy_u32` (D-1 era; should not appear in 5.3 surfaces)
   - References to `XnpvIrr` … wait, irrelevant — focus on the 5.3 surfaces: replay handlers (RenameSheet/Table/Column), repair modules, conflict-matrix tests
   - Stale "PRE-FIX" / "Phase 5.3 step 3 will" / "FIX coming in step N" prose in committed code/docs
   - Stale TODOs that reference step 5 itself (since you're step 5)

2. **Cross-step invariant verification**: re-examine each step's audit closure for unintended interaction with later steps:
   - Step 1's `fork_with_peer` discovery (peer-id stability invariant): is it actually load-bearing in steps 2-4 tests? Grep test files; flag tests that fork peers WITHOUT calling `set_peer_id` or `fork_with_peer`.
   - Step 2's deprecated `SheetRenameNameMismatch` variant: does any test still expect it to fire? Does any production code path still match against it?
   - Step 3's `repair_sheet_rename_chain` safety guard (skip rules where `old_canonical` is currently held): does step 4's `repair_table_rename_chain` apply the SAME guard? Compare both algorithms line-by-line.
   - Step 4's revert from auto-disambig: any leftover commented-out `AUTO_RENAME_CEILING` constants in replay.rs? Any test that still expects `X(2)` post-collision?

3. **V1-limitation empirical re-verification**: for each V1 limitation, write a 2-3 line probe that should produce the documented behavior. If the probe ACTUALLY produces something different, that's a HIGH. Limitations:
   - Cross-source target collision (tables) → hard-fails (peer A: T1→X; peer B: T2→X concurrent)
   - Cross-source target collision (columns) → hard-fails
   - DropTable + concurrent RenameTable → hard-fails (Opus step 4 M-1 — not closed)
   - Column repair pass missing (formulas referencing renamed columns post-merge → bind fails or behaves how?)
   - Case-only rename policy inconsistency: sheet (applies via display), table (no-op same-canonical), column (rejects). Write probes for each.

4. **Helper duplication count**: grep for `ql_formula_syntax::lex` invocations across the workspace. The Opus step 3 audit M-1 deferred a unification (then estimated at 3 call sites). Verify the CURRENT count; if it's grown to 5+, escalate to MEDIUM with concrete unification plan.

5. **Step 5 readiness**: is the exit-packet writable cleanly? Check for:
   - 5.3-introduced API surface NOT in `docs/architecture/ide-consumer-contract.md` (public exports from `ql-collab` like `repair_sheet_rename_chain`, `RepairReport`, `AmbiguousSkip`, table variants)
   - `docs/MASTER-PLAN.md` § Phase 5 — any 5.3 references that need updating
   - `docs/phase5/v1-exit-packet.md` — 5.3 status row state

### Verdict format

Produce: **VERDICT: PASS / PASS-WITH-FINDINGS / FAIL** + bucketed findings (HIGH / MEDIUM / LOW) + **1-paragraph executive summary at the top** suitable for direct paste into the megaudit-consolidated transcript.

For each HIGH, include:
- File:line reference
- Reproduction (test code or grep command)
- Proposed closure (revert, doc, code change, test)

This is the final pre-exit-packet audit. Your job is to find anything that would embarrass the next session 2 months from now. Adversarial mode: assume the engineer's confirmation bias has accumulated across 4 cycles.

codex
I’ll treat this as a code-review audit rather than an implementation task: first I’m going to read the phase notes and the relevant engine modules, then I’ll run targeted greps/probes against the current workspace.
exec
/bin/zsh -lc "pwd && rg --files -g 'AGENTS.md' -g '.github/copilot-instructions.md' -g 'quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-*-consolidated.md' -g 'quantbook-engine/.plans/_active.md' -g 'quantbook-engine/docs/architecture/crdt-data-model.md' -g 'quantbook-engine/docs/architecture/ide-consumer-contract.md' -g 'quantbook-engine/docs/MASTER-PLAN.md' -g 'quantbook-engine/docs/phase5/v1-exit-packet.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/MASTER-PLAN.md
quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/architecture/ide-consumer-contract.md
quantbook-engine/docs/phase5/v1-exit-packet.md
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-consolidated.md
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md
AGENTS.md

exec
/bin/zsh -lc 'git status --short && git rev-parse --short HEAD && git branch --show-current' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 1013ms:
?? .codex-phase-5-3-step-5-audit.out
?? .codex-phase-5-3-step-5-megaudit-prompt.md
?? .opus-a-phase-5-3-step-5-prompt.md
?? .opus-b-phase-5-3-step-5-prompt.md
?? 2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt
?? 2026-05-13-003338-this-session-is-being-continued-from-a-previous-c.txt
?? node_modules
?? quantbook-engine/.codex/prompts/2026-05-14-AA-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-127-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-128-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-129-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-132-133followup-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-HIGH3-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-LOW-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM4-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM5-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-K-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-L-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-M-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-N-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.I-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-megaudit-pass2.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closing-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-final-reverify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-mid-arc-audit.md
?? quantbook-engine/.plans/_archive/
?? quantbook-engine/2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt
18ad97d5725
feat/quantbook-engine

codex
The worktree has only untracked scratch/prompt artifacts; HEAD and branch match the audit target. I’m reading the audit history and architectural contracts now so the greps can be interpreted against the intended invariants, not just raw matches.
exec
/bin/zsh -lc "sed -n '1,160p' AGENTS.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

exec
/bin/zsh -lc "sed -n '1,220p' quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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

exec
/bin/zsh -lc "sed -n '1,260p' quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
---
title: Phase 5.3 step 2 audit synthesis (concurrent RenameSheet replay fix)
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~230k tokens) — full transcript: `2026-05-20-phase-5-3-step-2-codex.md`
  - Opus subagent (82k tokens, 462s) — full transcript: `2026-05-20-phase-5-3-step-2-opus.md`
audit_target: commit `1ed2bbba78a` (step 2 ship)
closure_commit: (this commit — step 2 audit closures)
---

## Engagement headline

**4th consecutive DIVERGENT-HIGH cycle** in Phase 5.3. Codex returned **FAIL (HIGH)** + 2 MEDIUM + 1 LOW. Opus returned **PASS-WITH-FINDINGS** (2 HIGH + 4 MEDIUM + 3 LOW). Both **CONVERGED on HIGH-1** (cross-sheet target collision still hard-fails) — independent verification of a real shipped bug.

## Convergent findings (both auditors)

| Finding | Codex severity | Opus severity | Closure |
|---|---|---|---|
| **HIGH-1**: Two peers concurrently rename DIFFERENT sheets to SAME target → `SheetRenameRejected` hard-fails replay. Same blast radius as the bug step 2 was meant to fix. | HIGH | HIGH-1 | D-2-style auto-disambiguation: catch `SheetNameError::Duplicate`, walk suffixes `X(2)`, `X(3)`, etc. up to `AUTO_RENAME_CEILING = 10_000`. New test `step2_audit_concurrent_rename_to_same_target_auto_disambiguates`. |
| **MEDIUM**: Doc drift — `op.rs:99` (Codex) / `crdt-data-model.md` row missing (Opus) about RenameSheet × RenameSheet semantics | MEDIUM | MEDIUM-1 | Updated `op.rs:99` RenameSheet docstring (advisory `old_name` + trade-off rationale). Added 3 new rows to conflict matrix table at `crdt-data-model.md:320-329`. |

## Unique to Codex

| Finding | Severity | Closure |
|---|---|---|
| Case-only renames dropped (canonical-equality idempotency check) | MEDIUM | Changed idempotency check to DISPLAY equality. New test `step2_audit_case_only_rename_updates_display_name`. |
| `op.rs:99` docs say `old_name` is "for replay-time validation" but post-step-2 it's advisory | MEDIUM | (covered above) |
| `SheetRenameNameMismatch` could use `#[deprecated]` | LOW | Added `#[deprecated]` attribute. |

## Unique to Opus

| Finding | Severity | Closure |
|---|---|---|
| Empty new_name edge case undocumented (hits `SheetNameError::Empty` → `SheetRenameRejected`) | HIGH-2 | Edge case explicitly enumerated in replay docstring. |
| Test #4 (rename + literal) lacks symmetric merge check | MEDIUM-2 | Test rewritten with bidirectional merge + assertions on both views. |
| Test #5 (3-peer) star-merge is degenerate; doesn't prove transitivity | MEDIUM-3 | Rewritten with 3 different merge orderings (BC vs CA vs AB) — genuine commutativity check. |
| `let _ = old_name;` is dead code | MEDIUM-4 | Removed during HIGH-1 rewrite. |
| Test #2 lacks bidirectional merge | LOW-1 | Test rewritten with bidirectional check. |

## Verifications recorded (no closure needed)

Both auditors confirmed:
- Production code (`ql_collab::CollabSession`) doesn't match `SheetRenameNameMismatch` — ABI-safe.
- Undo path doesn't emit `RenameSheet` (Loro retracts via UndoManager; no counter-op) — no undo regression.
- qbook envelope load doesn't invoke RenameSheet replay — no loader regression.
- Producer-side `WorkbookRuntime::rename_sheet` validates old_name at write time, so the advisory replay relaxation only matters for malformed logs.
- The 3 calamine_smoke failures under parallel test runs are the pre-existing temp_dir race from D-1 step 8 megaudit — unrelated to step 2.

## Pre-noted for step 4 (from step 1 audit)

`apply_rename_table` (`replay.rs:691`) + `apply_rename_column` (`replay.rs:749`) have the IDENTICAL bug shape AND **also need the HIGH-1 auto-disambiguation fix** when step 4 ships. Step 4 plan already updated to reflect this.

## Closure metrics

- Original step 2 ship: 5 tests + replay handler unification (HEAD `1ed2bbba78a`).
- After closure: 7 tests + replay handler + auto-disambiguation loop + display-equality idempotency + variant deprecation + 3 new conflict matrix rows.
- Workspace tests: 4305 → 4307 (+2) with `--test-threads=1`.
- Files modified: 4 (replay.rs, op.rs, test file, crdt-data-model.md).
- fmt + clippy: clean.

## Audit-discipline observation

The 4-cycle divergent-HIGH pattern (D-1 steps 5/6/7 + 5.3 step 1) extends to 5.3 step 2. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 3 + step 4 + step 5 megaudit) should expect the same.

**Worth noting**: the audit caught a bug introduced WHILE FIXING THE PRIOR BUG. Step 2's commit message confidently claimed "Edge cases covered: rename target collision → SheetRenameRejected (unchanged)" — both auditors challenged this. The discipline of skeptical adversarial audits AFTER each ship continues to find real issues that confirmation bias on the engineer's side would miss.

## Forward implications

- **Step 3 design**: the row 7 conflict-matrix test (in step 1's phase_5_3_conflict_matrix_probe.rs) still pins pre-fix `#NAME?` behavior; step 3 modifies it. Step 2's audit closure now also has multiple new doc-table rows that step 3 must keep consistent.
- **Step 4 scope**: extension to RenameTable + RenameColumn now MUST also include HIGH-1's auto-disambiguation pattern. Plan updated.
- **Step 5 megaudit**: should explicitly probe the empty new_name edge case + reserved-character paths in the wire-format-only producer scenario.

exec
/bin/zsh -lc "sed -n '1,280p' quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-consolidated.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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

exec
/bin/zsh -lc "sed -n '1,320p' quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
---
title: Phase 5.3 step 4 audit synthesis (RenameTable/RenameColumn extension)
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~131k tokens) — full transcript: `2026-05-20-phase-5-3-step-4-codex.md`
  - Opus subagent (88k tokens, 461s) — full transcript: `2026-05-20-phase-5-3-step-4-opus.md`
audit_target: commit `7126eb44396` (step 4 ship)
closure_commit: (this commit — step 4 audit closures)
---

## Engagement headline

**6th consecutive DIVERGENT-HIGH cycle** in Phase 5.3. Both auditors returned FAIL/PASS-WITH-FINDINGS with **2 convergent HIGHs**:
- HIGH-1: Table repair mis-handles auto-disambig'd canonicals → silent formula corruption.
- HIGH-2: Column repair pass missing → concurrent column rename produces broken formulas.

Plus 6 unique findings (4 MEDIUM + 3 LOW).

## Convergent HIGH closures

| Finding | Both | Closure |
|---|---|---|
| Auto-disambig + repair mismatch (cross-source target collision corrupts formulas) | HIGH-1 | **REVERTED auto-disambig** for tables. Cross-source collision now hard-fails. V1 limitation documented. |
| Column repair pass missing | HIGH-2 | **REVERTED auto-disambig** for columns. Same closure pattern. Column repair pass deferred to V2. |

The clean fix would have been to thread the auto-disambig outcome through replay → repair (Opus's suggested option a), but that requires replay API changes. Pragmatic revert preserves step 4's primary value (closing the original "missing source" hard-fail per Opus step 1 audit M-2) without introducing the silent-corruption HIGH.

## Unique closures

| Finding | Source | Severity | Closure |
|---|---|---|---|
| Dead `canonical_chain` HashMap in `collect_table_renames` | Opus M-2 | MEDIUM | Removed; signature simplified |
| HashSet iteration non-determinism in repair phase 3 | Codex M-2 | MEDIUM | Sort canonicals before iteration |
| BatchCommit-nested table rename untested | Opus M-4 | MEDIUM | Added `step4_audit_batchcommit_nested_table_rename_traverses_correctly` |
| Test weak (uses T→T not T→T2 case) | Codex L-1 | LOW | Test 3 reframed for clearer assertion; cross-source test split into hard-fail probe + transitive chain probe |
| Transitive table chain test missing | Opus L-2 | LOW | Added `step4_audit_transitive_table_chain_to_final_name` |

## Deferred (documented limitations)

| Item | Source | Defer reason | Tracking |
|---|---|---|---|
| Cross-source target collision (tables + columns) hard-fails | HIGH closure | Auto-disambig + repair interaction requires API change | V1 limitation, V2 backlog |
| Column repair pass | HIGH-2 | Same root cause as HIGH-1 + scope | Future step 4.1 OR V2 |
| DropTable hard-fails on concurrent rename | Opus M-1 | Same bug class as table rename; out of step 4 scope | Step 5 megaudit or V2 |
| Inconsistent case-only rename policy across sheet/table/column | Opus M-3 | Architectural design decision | Step 5 megaudit |
| Codex MEDIUM-3 (NameTable hard-reject in suffix walk) | Codex M-3 | N/A — auto-disambig reverted | (Mooted) |
| `lookup_column` doc says uppercase but code lowercases | Opus L-3 | Pre-existing doc bug | Future cleanup |

## Code changes summary

**`crates/ql-oplog/src/replay.rs`**:
- `apply_rename_table`: removed auto-disambig suffix walk; restored hard-reject on `TableCreateRejected` for cross-source target collision. Preserved advisory-skip for missing-source (the original Opus step 1 audit M-2 closure). Updated docstring to document V1 limitation.
- `apply_rename_column`: same revert + preservation pattern.

**`crates/ql-collab/src/repair.rs`**:
- `collect_table_renames`: removed dead `canonical_chain` HashMap. Signature simplified.
- `repair_table_rename_chain`: sort current canonicals before iteration for determinism.

**Tests updated**:
- `phase_5_3_step4_table_column_concurrent.rs`: 2 tests reframed to assert HARD-FAIL on cross-source collision (post-revert behavior). 
- `repair_tables.rs`: 1 test reframed (cross-table → hard-fail) + 2 new tests added (transitive chain + BatchCommit).

## Closure metrics

- Step 4 ship: 12 tests (6 replay + 6 repair).
- After audit closure: 14 tests (6 replay + 8 repair: 2 new + 1 reframed).
- Workspace tests: 4332 → 4334 (+2 net).
- Files modified: 4 (replay.rs, repair.rs, 2 test files).
- fmt + clippy: clean.

## Audit-discipline observation

6 consecutive divergent-HIGH cycles. The pattern is structurally validated. Notably, step 4 was framed as "the simpler extension" — but both auditors caught the same HIGH despite the smaller scope. Opus also noted: "step 4 has scope-creep deferred-items disguised as 'audit-locked V1 limitations'" — which I take seriously. The revert is the honest scoping: close what step 4 actually closes (missing-source hard-fail), document what's still broken (cross-source collision, column repair), don't claim more.

## Forward implications

- **Step 5 megaudit**: should re-examine the cross-source target collision V1 limitation as a candidate for V2 closure. Specifically: would `replay_into` returning a `(Workbook, ReplayTrace)` tuple work?
- **Step 6 exit packet**: must document the V1 limitations crisply (cross-source target collision for tables AND columns; column repair pass deferred; DropTable hard-fail). These compound to a non-trivial gap vs sheets.
- The "advisory-skip vs hard-fail" decision was the right V1 call for step 4 closure, but it leaves a sibling-bug at DropTable that step 5 megaudit MUST surface as work-or-defer.

exec
/bin/zsh -lc "sed -n '300,380p' quantbook-engine/docs/architecture/crdt-data-model.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '100,180p' quantbook-engine/.plans/_active.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   for a 100k-cell workbook is the worst-case memory profile.
4. Re-binding formula text after a sheet rename is op-log-aware
   (W5-91 emits a `BatchCommit` containing PutFormula entries
   for every rewritten cell + the RenameSheet op). Per-cell
   containers can't express atomic batches.

Option B / per-cell-container is Phase 5 V2 work at the
earliest, and only if we discover specific use cases (e.g.
character-level concurrent editing of one long formula) that
benefit from it.

## Conflict resolution semantics (Phase 5.3 preview)

The 5.1 design picks Option A → conflicts resolve by Loro's
underlying merge order: **Fugue/origin-based with peer-id
tiebreaker** (per `loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163,192`),
NOT Lamport timestamps. The op-log replay path observes the
final causal order; the LAST op in that order wins for each
target. Phase 5.3 formalizes this with these defaults:

| Concurrent op pair | Resolution |
|---|---|
| `PutValue { A1, v_a }` × `PutValue { A1, v_b }` | Last-in-causal-order wins (Fugue/origin) |
| `PutFormula { A1, f_a }` × `PutFormula { A1, f_b }` | Last-in-causal-order wins |
| `PutValue { A1, v_a }` × `PutFormula { A1, f_b }` | Last-in-causal-order wins; replay applies both and recompute observes final state |
| `ClearFormula { A1 }` × `PutFormula { A1, f }` | Last-in-causal-order wins |
| `SetName { foo, t_a }` × `SetName { foo, t_b }` | Last-in-causal-order wins |
| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | **Phase 5.3 step 3 ✅ shipped 2026-05-20:** post-merge `ql_collab::repair_sheet_rename_chain` rewrites the formula text from `A!...` to `B!...` (current name) before recompute. Pre-step-3 the D-3 V1 limitation produced `#NAME?`; post-step-3 the formula resolves correctly. Caller invokes the repair pass between `replay_into` and `recompute_all` (caller-driven, NOT auto-hooked into `merge_bytes`). |
| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
| `RenameSheet { 0, _, X }` × `RenameSheet { 1, _, X }` (different sheets, same target) | **Phase 5.3 step 2 audit closure ✅ shipped:** D-2-style auto-disambiguation — second rename suffixes to `X(2)`, etc. Pre-closure replay hard-failed via `SheetRenameRejected { source: Duplicate }`. |
| `RenameSheet { 0, "Sheet1", "SHEET1" }` (case-only rename) | **Phase 5.3 step 2 audit closure ✅ shipped:** replay applies the display update. Pre-closure the canonical-equality idempotency check silently dropped case-only renames. |
| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |

The 5.3 audit checkpoint validates these defaults against the
Phase 4.12 megaudit's cycle-detection / spill / drop-table
invariants — every Phase 4 edge case must survive the CRDT
merge.

### Peer-id stability is a precondition for CRDT convergence

**Phase 5.3 step 1 audit closure (2026-05-20).** Loro's
Fugue/origin-based merge uses peer-ids as a tiebreaker. Two peers
forking from the same snapshot MUST carry STABLE non-zero peer-ids
across the lifetime of their OpLogs for deterministic convergence
under bidirectional merge:

- **Production code** (`ql_collab::CollabSession::new` /
  `from_snapshot`) already enforces this — both constructors call
  `OpLog::set_peer_id(peer_id.as_u64())` with an `assert_ne!(_, 0)`
  release-firing guard (D-1 step 8 megaudit closure).
- **Test scaffolding** for 2-peer probe tests (e.g.
  `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs`)
  MUST also call `set_peer_id` with distinct stable ids after
  `OpLog::import_bytes`. `LoroDoc::new()` assigns a random peer-id
  per process; without an explicit `set_peer_id` the (peer-id
  pair) differs across merge directions and bidirectional
  convergence assertions fail spuriously.
- The default `OpLog::new()` and `OpLog::import_bytes` paths
  intentionally retain randomized peer-ids — they're for
  single-writer (legacy / qbook) workflows where multi-peer
  semantics don't apply. The peer-id only matters once two ops
  with distinct peer-ids enter the same merged log.

## Undo/redo (Phase 5.4 — V1 shipped)

**Phase 5.4 V1 ✅ shipped at `89c02b9d83e` (2026-05-19).**
Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
peer has its own undo stack tracking THEIR local appends only.
Undoing APPENDS an inverse op AND retracts the original from
the visible `"ops"` LoroList — so `OpLog::len()` shrinks
post-undo. (V1 implementation correction: prior "remove from
the log (semantically; tombstones)" wording was imprecise;
Loro neither physically removes nor tombstones — it composes
a remote-event-style retraction. See `ql_collab::CollabSession::undo`.)

This is local-undo, NOT collaborative-undo. Two users editing
the same cell + one user undoing their edit produces a sane
result: their edit retracts from the visible log AND propagates
to peers via merge; the other user's edit (if later in causal
order) stays.

 succeeded in 0ms:
- Deferred (V2): helper unification (now 3 call sites; would prevent step-4 expansion to 5+); production wiring (caller-driven by design)

### Step 4 — RenameTable/RenameColumn extension ✅ SHIPPED 2026-05-20
- Ship: `7126eb44396`
- Audit closure: `6752ca2545c` (6th consecutive divergent-HIGH cycle — both auditors caught 2 HIGHs: (a) auto-disambig + repair mismatch corrupts cross-table formulas; (b) column repair pass missing)
- Tests: 14 (6 replay + 8 table repair; 2 reframed for hard-fail post-revert; 2 new for transitive chain + BatchCommit)
- Replay: `apply_rename_table` + `apply_rename_column` — advisory-skip for missing source (concurrent rename); hard-reject on cross-source target collision (audit-CLOSURE revert)
- NEW: `repair_table_rename_chain` + `TableRepairReport` + `TableRewriteSummary` + `TableAmbiguousSkip`
- Audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-4-{codex,opus,consolidated}.md`

**Step 4 audit REVERT** (Codex+Opus HIGH × 2):
- Pre-closure: replay auto-disambig'd target collision via X → X(2) suffix walk (mirroring step 2). Repair pass keyed history by op's wire `new_name="X"` → mis-mapped to actual canonical X(2) → silent cross-table reference corruption.
- Post-closure: REVERTED auto-disambig. Cross-source target collision now hard-fails with `TableCreateRejected` / `TableColumnRejected`. V1 limitation documented.
- Preserved: advisory-skip for missing-source (the original Opus step-1-audit M-2 closure).

**V1 limitations stack from step 4 audit closure** (deferred to V2 / step 5 megaudit assessment):
- Cross-source target collision hard-fails (tables, columns)
- Column repair pass missing
- DropTable hard-fails on concurrent RenameTable (Opus M-1)
- Case-only rename policy inconsistency across sheet/table/column (Opus M-3)
- Helper duplication (5+ call sites; Opus step-3 M-1 deferred from step 3 audit)
- Production wiring missing (Opus step-3 M-3)

### Step 5 — 3-way megaudit (~0.5 day) ⏳ NEXT
Codex (cross-step + grep) + Opus-A (empirical 2-peer + adversarial randomized interleavings + production wiring check) + Opus-B (doc completeness + helper duplication + cross-crate consistency).

**Megaudit MUST re-examine the V1 limitations stack** from step 4 audit closure (above) for V2 prioritization. Specifically:
- Is the cross-source target collision hard-fail acceptable as V1? Or should V2 thread a disambig-trace through replay→repair?
- Should column repair pass land in V1, or is the gap acceptable?
- Audit-prompt the auditors to construct ADVERSARIAL probes attempting to break the safety guard via odd scenarios (e.g., 3+ chained renames + cross-sheet ambiguity + concurrent edits)

Per D-1 step-8 megaudit pattern: dispatch all 3 lanes IN PARALLEL (not sequential) to avoid anchoring.

### Step 6 — Exit packet + handoff refresh (~0.5 day)
Write `docs/phase5/5-3-exit-packet.md` mirroring `d-1-exit-packet.md` structure. Refresh:
- `docs/MASTER-PLAN.md` § Phase 5.2 sub-items
- `docs/phase5/v1-exit-packet.md` (5.3 status row → ✅)
- `docs/phase5/entry-plan.md` (5.3 table row)
- `docs/architecture/crdt-data-model.md` (final V1 state + audit-locked limitations)
- `docs/architecture/ide-consumer-contract.md` (5.3-introduced API: `repair_sheet_rename_chain`, `repair_table_rename_chain`, etc.)
- `MEMORY.md` + `current_work.md` (handoff)

Final commit. Verify clean checkout + 3-fold gates.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Step 1 probe tests reveal hidden gaps beyond the matrix | M | Triage on discovery: small gaps → close in step 1; large → file follow-up tasks |
| Step 2's policy change breaks existing rename tests | L | Existing rename tests use single-writer paths (no concurrent renames); the change only affects case 3 which is currently unreachable in single-writer |
| Step 3's repair pass has cross-sheet interaction with names/tables | M | Defined out of scope (D-5.3-6); 5.3.b can extend if needed |
| Loro's causal-order is non-deterministic for byte-tied concurrent ops | L (verified by D-4 probes) | Reuse D-4's order-independence assertion pattern (test both merge directions) |
| Repair-pass idempotency assumption breaks on edge case | L | Helper's `None`-on-no-change is the safety net; test-pin idempotency explicitly |
| Index-padding race during commits | L | 4 incidents total (3 V1 + 1 D-1 step 7); mitigation pattern (re-stage + verify) is reliable |

## Open questions for the user (sign-off needed)

ALL CLOSED:
1. ~~Priority confirmation (5.3 vs 5.5 V2 V2/V3 vs other)~~ → user said "Proceed with 5.3 as planned" (AskUserQuestion at session start). After 5.3 ships, the recommended sequence is **5.5 V2 V2/V3 (production transport) → 5.7 IDE slice → 5.8 Phase 5 megaudit** per D-1 exit packet priority guidance.
2. ~~D-5.3-3 policy~~ → user said "Last-in-causal-order wins; apply to current". Shipped in step 2.
3. ~~D-5.3-4 module location~~ → engineered's-discretion call: `ql-collab/src/repair.rs` shipped.
4. ~~Step 4 scope~~ → shipped + audit-closure REVERTED auto-disambig (V1 limitation). Column repair pass deferred to V2.

## Audit-cycle observations (steps 1-4)

Each step's parallel Codex+Opus audit found at least one HIGH that the engineer's confirmation bias missed. The 6-consecutive divergent-HIGH pattern is **structurally validated**:

| Step | Codex HIGHs | Opus HIGHs | Convergent | Notable |
|---|---|---|---|---|
| 1 | 1 (row 3 degenerate) | 1 (same) | YES | Tests were tautological — same value for both winners |
| 2 | 1 (cross-sheet target collision still hard-fails) | 1 (same) | YES | My step-2 fix was incomplete |
| 3 | 2 (cascade + reused-name) | 1 (same root cause) | YES | Single safety guard closed both scenarios |
| 4 | 2 (auto-disambig + repair mismatch + column repair gap) | 2 (same) | YES | Closure REQUIRED revert; can't fix in-place without API change |

In every cycle, the audit closure surfaced V1 limitations to document. Step 5 megaudit should consolidate all V1 limitations into a single section of the exit packet, and surface helper-unification + production-wiring as actionable V2 follow-ups.

## Exit criteria

- All 6 step tasks marked complete. **CURRENT: 4/6 complete (steps 1-4); steps 5-6 remain.**
- Workspace tests at 4291 + N. **CURRENT: 4334** (+43 net across 5.3).
- fmt + clippy clean.

exec
/bin/zsh -lc "rg -n \"fork_with_peer|set_peer_id|import_bytes|fork\\(\" quantbook-engine/crates/ql-collab quantbook-engine/crates/ql-oplog -g '*test*.rs' -g 'tests/**/*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 exited 1 in 0ms:
exec
/bin/zsh -lc "rg -n \"SheetRenameNameMismatch|to_legacy_u32|XnpvIrr|PRE-FIX|Phase 5\\.3 step 3 will|FIX coming in step|step 5|Step 5|AUTO_RENAME_CEILING|\\bX\\(2\\)\\b|ql_formula_syntax::lex\" quantbook-engine" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:327:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/architecture/crdt-data-model.md:329:| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
quantbook-engine/docs/architecture/crdt-data-model.md:621:**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/architecture/crdt-data-model.md:755:   shapes through `to_storage()` (step 5 `2ae5bfcab28`); save path
quantbook-engine/docs/architecture/crdt-data-model.md:756:   emits Wire directly, dropping pre-step-5 `to_legacy_u32().expect()`
quantbook-engine/crates/ql-oplog/src/replay.rs:154:    SheetRenameNameMismatch {
quantbook-engine/crates/ql-oplog/src/replay.rs:287:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
quantbook-engine/crates/ql-oplog/src/replay.rs:294:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
quantbook-engine/crates/ql-oplog/src/replay.rs:465:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/crates/ql-oplog/src/replay.rs:472:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/crates/ql-oplog/src/replay.rs:551:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/crates/ql-oplog/src/replay.rs:574:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/crates/ql-oplog/src/replay.rs:608:            // reserved for envelope-load migration in step 5.
quantbook-engine/crates/ql-oplog/src/replay.rs:1793:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/architecture/2026-05-14-array-formulas-and-spills.md:595:- `SEQUENCE(2, 3, 10, 5)` → 2×3 starting at 10, step 5: `[[10, 15, 20], [25, 30, 35]]`.
quantbook-engine/crates/ql-oplog/src/op.rs:109:    /// match the current sheet name (`SheetRenameNameMismatch`); under
quantbook-engine/crates/ql-oplog/src/op.rs:145:    /// (step 5).
quantbook-engine/docs/architecture/2026-05-17-reference-tier-design.md:8:- **2026-05-17, Shipped**: Steps 1-4 implementation + Step 5 cross-cutting + Step 6 closure docs landed.
quantbook-engine/docs/architecture/2026-05-17-reference-tier-design.md:671:### Step 5 — Cross-cutting test suite (one commit)
quantbook-engine/docs/architecture/2026-05-17-reference-tier-design.md:691:Each function ships with **8+ tests** (per MEDIUM-δ); cross-cutting suite of **6 tests** per Step 5. LibreOffice cross-checks: **2 per fn** (top-left case + edge case).
quantbook-engine/crates/ql-oplog/src/wire.rs:462:        // pre-migration. Step 5's loader is responsible for not mixing
quantbook-engine/crates/ql-oplog/src/wire.rs:578:    // explicitly so step 5+ callers can rely on it.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/crates/ql-io/src/qbook_format.rs:149:/// **Phase 5.2 D-1 step 5 (2026-05-20):** bumped to v8. v8 changes:
quantbook-engine/crates/ql-io/src/qbook_format.rs:172:///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
quantbook-engine/crates/ql-io/src/qbook_format.rs:308:    /// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/crates/ql-io/src/qbook_format.rs:605:/// **Phase 5.2 D-1 step 5 (2026-05-20):** envelope-side `id` field used
quantbook-engine/crates/ql-io/src/qbook_format.rs:639:    /// **Step 5 migration contract:** this is the ONLY conversion needed
quantbook-engine/crates/ql-io/src/qbook_format.rs:659:/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/crates/ql-io/src/qbook_format.rs:674:/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/crates/ql-io/src/qbook_format.rs:1217:                        // Phase 5.2 D-1 step 5: envelope schema bumped to
quantbook-engine/crates/ql-io/src/qbook_format.rs:1220:                        // pre-step-5 hit the to_legacy_u32().expect() panic).
quantbook-engine/crates/ql-io/src/qbook_format.rs:1309:                    // Phase 5.2 D-1 step 5: emit v8 tagged-tuple shape
quantbook-engine/crates/ql-io/src/qbook_format.rs:1311:                    // `id.to_legacy_u32().expect(...)` which would have
quantbook-engine/crates/ql-io/src/qbook_format.rs:1596:    // **Phase 5.2 D-1 step 5 audit Codex MEDIUM-1 closure (2026-05-20):**
quantbook-engine/crates/ql-io/src/qbook_format.rs:1678:            // Phase 5.2 D-1 step 5: `entry.id` is now `FormatEntryId`
quantbook-engine/crates/ql-io/src/qbook_format.rs:1733:            // (the enum) rather than `u32`. Phase 5.2 D-1 step 5:
quantbook-engine/crates/ql-io/src/qbook_format.rs:3150:            id_a.to_legacy_u32(),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3154:            id_b.to_legacy_u32(),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3297:        // Phase 5.2 D-1 step 5: MalformedFormat.id changed u32 → FormatId.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3402:    // ===== Phase 5.2 D-1 step 5 (2026-05-20) — qbook envelope v7 → v8 =====
quantbook-engine/crates/ql-io/src/qbook_format.rs:3404:    /// **Step 5 fixture test:** hand-craft a v7 envelope with bare-u32
quantbook-engine/crates/ql-io/src/qbook_format.rs:3497:    /// **Step 5 round-trip test:** verify v8 envelopes preserve non-LEGACY
quantbook-engine/crates/ql-io/src/qbook_format.rs:3499:    /// property step 5 enables — pre-step-5 the save path's
quantbook-engine/crates/ql-io/src/qbook_format.rs:3500:    /// `to_legacy_u32().expect(...)` would have panicked on
quantbook-engine/crates/ql-io/src/qbook_format.rs:3542:    /// **Step 5 round-trip test:** verify v8 envelopes serialize the
quantbook-engine/crates/ql-io/src/qbook_format.rs:3612:    /// **Step 5 ordering test:** verify untagged enum dispatch is
quantbook-engine/crates/ql-io/src/qbook_format.rs:3662:    /// **Step 5:** the `FormatEntryId::from_storage(FormatId)` constructor
quantbook-engine/crates/ql-io/src/qbook_format.rs:3687:    // ===== Step 5 audit closure regression tests (2026-05-20) =====
quantbook-engine/crates/ql-io/src/qbook_format.rs:4117:    /// **Phase 5.2 D-1 step 5 (2026-05-20):** v8 is now current; bumped
quantbook-engine/crates/ql-io/src/qbook_format.rs:4285:        // Phase 5.2 D-1 step 5 (2026-05-20) bumped from 7 to 8: FormatEntry.id
quantbook-engine/crates/ql-collab/src/repair.rs:355:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-collab/src/repair.rs:548:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:320:    // any to_legacy_u32 hop.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:97:  (= `PeerId(0)`) for step 5's qbook migration.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:118:- ✅ Migration helpers: `FormatId::legacy_from_u32(n)` + `FormatId::to_legacy_u32() -> Option<u32>` (None for non-LEGACY peer Customs).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:124:  - ql-io: qbook envelope save/load uses `to_legacy_u32().expect(...)` + `is_custom()`. Pre-step-5 envelope still u32-shaped.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:125:  - ql-io-xlsx: xlsx import/export uses `legacy_from_u32` / `to_legacy_u32().expect(...)`. Pre-step-6 xlsx sees only LEGACY_PEER.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:138:- ✅ Producer (`ql-exec::workbook_runtime::formats`) + replay (`ql-oplog::replay`) drop the legacy_from_u32/to_legacy_u32 expects.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:145:### Step 5: Backwards-compat in `qbook_format` — ✅ SHIPPED 2026-05-20 (`2ae5bfcab28` + audit `30ef2637d6f`)
quantbook-engine/docs/phase5/d-1-starting-checklist.md:155:Step 5 shipped:
quantbook-engine/docs/phase5/d-1-starting-checklist.md:159:- ✅ Save path emits `FormatEntryId::from_storage(fid)` directly. Dropped `to_legacy_u32().expect()` panics at 2 sites — v8 envelopes express non-LEGACY peer Custom ids losslessly.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:163:**Step 5 audit (`30ef2637d6f`) — 3rd consecutive DIVERGENT-HIGH cycle**. Codex caught 2 HIGH (counter-overflow panic on load with `Custom(LEGACY_PEER, u32::MAX)`; `Builtin(>163)` load+resave drops entry) + 1 MEDIUM (v<8 envelopes accepting v8 wire-shaped ids). Opus PASSED structurally, caught 1 MEDIUM (docstring claims inline TOML shape but `to_string_pretty` emits section-header form) + 2 LOW. All 6 findings closed:
quantbook-engine/docs/phase5/d-1-starting-checklist.md:170:8 new tests at audit closure (+3 ql-storage, +5 ql-io qbook_format). Workspace tests: 4257 → 4262 (step 5 ship) → 4270 (audit closure). Full transcripts at `docs/audits/2026-05-20-phase-5-2-d-1-step-5-{codex,opus,consolidated}.md`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:176:- ✅ 3 `to_legacy_u32().expect("pre-step-6 ...")` panic sites removed from xlsx export.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:240:- [ ] You've read this doc's Step 4 + Step 5 sections (most-recent + next), `docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md` (most-recent audit), and `crdt-data-model.md` § "Format id collision" (overall design status). `v1-exit-packet.md` is broader Phase 5 V1 context if needed.
quantbook-engine/docs/phase5/d-1-exit-packet.md:53:| `qbook_format::WORKBOOK_SCHEMA_VERSION` | 8 | Step 5 | qbook envelope shape (v8 = FormatEntryId tagged tuple) |
quantbook-engine/docs/phase5/d-1-exit-packet.md:109:| Step 5 ship + audit | 4270 |
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:43:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:65:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:133:                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:260:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:1://! **W5-RT-5 / RT-V1-01 Step 5: cross-cutting integration tests.**
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:95:///    the pre-step-6 `to_legacy_u32()` mapping. Holds for ALL counters
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:188:        // {5, 7} from replay scenarios) — pre-step-6 `to_legacy_u32()`
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:548:        // pre-step-6 expect() on `to_legacy_u32()` panicked on
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:653:    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1264:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/crates/ql-types/src/peer.rs:91:/// migration (Phase 5.2 D-1 step 5).
quantbook-engine/crates/ql-types/src/peer.rs:107:/// Cross-ref: `docs/phase5/d-1-starting-checklist.md` § "Step 5".
quantbook-engine/crates/ql-storage/src/format.rs:30://! (used by qbook envelope loader in step 5 and xlsx import in step 6).
quantbook-engine/crates/ql-storage/src/format.rs:66:/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/crates/ql-storage/src/format.rs:114:    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/crates/ql-storage/src/format.rs:134:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/crates/ql-storage/src/format.rs:155:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/crates/ql-storage/src/format.rs:418:        // Phase 5.2 D-1 step 5 audit Codex HIGH-1 + HIGH-2 closure
quantbook-engine/crates/ql-storage/src/format.rs:563:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
quantbook-engine/crates/ql-storage/src/format.rs:572:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
quantbook-engine/crates/ql-storage/src/format.rs:853:    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/crates/ql-storage/src/format.rs:854:        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/crates/ql-storage/src/format.rs:855:        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/crates/ql-storage/src/format.rs:856:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/crates/ql-storage/src/format.rs:858:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/crates/ql-storage/src/format.rs:864:    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/crates/ql-storage/src/format.rs:869:        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/crates/ql-storage/src/format.rs:890:            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/crates/ql-storage/src/format.rs:1070:    // ===== Step 5 audit closures (2026-05-20) =====
quantbook-engine/crates/ql-storage/src/format.rs:1072:    /// **Codex HIGH-1 closure (step 5 audit):** `register_at` must NOT
quantbook-engine/crates/ql-storage/src/format.rs:1113:    /// **Codex HIGH-2 closure (step 5 audit):** `register_at` must reject
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:267:        // has no peer-id concept to recover. So to_legacy_u32() still
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:272:                id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-17-rt-step-2-opus.md:67:- **Single `@ROW(A1:A10)` test** to verify implicit-intersection (or document it as Step 5 cross-cutting coverage per design § Step 5 line 661, with explicit rationale this is intentionally deferred).
quantbook-engine/docs/audits/2026-05-17-rt-step-2-opus.md:69:If deferred to Step 5 (as design § Step 5 cross-cutting suite implies for some), update the plan to amend the Phase 2 checklist to specify which categories are deferred to Step 5 and which are in scope for Step 2.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/crates/ql-storage/src/lib.rs:85:        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:161:3. Neither → `SheetRenameNameMismatch` error (divergent state).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:36:- `FormatId::to_legacy_u32() → Option<u32>`: inverse (returns None for non-LEGACY Custom ids).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:44:- Save: `id.0` → `id.to_legacy_u32().expect("pre-step-4 FormatId must be expressible as legacy u32")`. Filter `id.0 >= FIRST_CUSTOM_FORMAT_ID` → `id.is_custom()`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:49:- Export (umya_export): `id.0` → `id.to_legacy_u32().expect(...)`. Filter → `is_custom()`. Sort key uses legacy u32.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:53:- `intern_format` predicts `Custom(local_peer, next_custom_counter)`; Op append uses `to_legacy_u32().expect(...)`. Debug-assert predicted == allocated.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:71:1. **`legacy_from_u32` ↔ `to_legacy_u32` round-trip.** For all u32 `n`, `FormatId::legacy_from_u32(n).to_legacy_u32() == Some(n)`. Test `legacy_round_trip_through_helpers` at format.rs covers some — verify ALL `u32` values: 0, 1, 163, 164, 165, u32::MAX. Pin via tests.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:73:2. **`FormatId::Builtin(n)` for `n > 163` — is it allowed?** The enum doesn't enforce `n ≤ 163` in `Builtin`. Could a caller construct `FormatId::Builtin(999)` (semantically a custom xlsx-numFmtId)? Should we reject? If allowed, what does `to_legacy_u32()` return? `Some(999)` per current impl. Is that correct or should it return None / panic for out-of-range built-ins?
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:81:6. **`to_legacy_u32().expect()` invariants across cascade sites.** Each `expect()` is load-bearing — panic if a non-LEGACY peer FormatId reaches it. Enumerate the expect() sites:
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:109:14. **Step 4 will:** change `Op::RegisterFormat { id: u32 }` → `Op::RegisterFormat { id: FormatIdWire }`. The producer + replay sites currently use `to_legacy_u32().expect()` / `legacy_from_u32`. Step 4 drops these. Verify the substitution is mechanical (no logic changes needed) for each site.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:298:      loader (step 5) and xlsx import.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:299:    - FormatId::to_legacy_u32(): inverse of legacy_from_u32. Returns
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:314:      to_legacy_u32 round-trip, non-legacy-peer None case.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:324:    - Save side: `id.0` (raw u32 access) → `id.to_legacy_u32().expect(...)`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:326:      is load-bearing — step 5 will change the envelope schema to carry
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:335:    - xlsx export (umya_export): `id.0` → `id.to_legacy_u32().expect(...)`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:344:      (u32 wire pre-step-4); to_legacy_u32 expect()s the conversion.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:482:    30	//! (used by qbook envelope loader in step 5 and xlsx import in step 6).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:555:   103	    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:575:   123	    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:596:   144	/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1028:   573	    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1029:   574	        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1030:   575	        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1031:   576	        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1033:   578	            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1039:   584	    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1044:   589	        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1051:   596	            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1419:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1725:   423	            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1732:   430	                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1821:    55	        // `to_legacy_u32`. At step 3 all FormatTables default to
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1828:    62	                id: id.to_legacy_u32().expect(
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1875:   109	                    f.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2003:   237	            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2277:   494	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2399:/bin/zsh -lc "rg -n \"RegisterFormat|SetCellFormat|FormatNotRegistered|legacy_from_u32|to_legacy_u32|FormatId::Builtin\\(200\\)|Builtin\\([2-9][0-9][0-9]\\)\" quantbook-engine/crates -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2454:quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:323:    // any to_legacy_u32 hop.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2459:quantbook-engine/crates/ql-io/src/qbook_format.rs:1112:                        // still uses bare-u32 ids. `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2460:quantbook-engine/crates/ql-io/src/qbook_format.rs:1119:                            .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2461:quantbook-engine/crates/ql-io/src/qbook_format.rs:1196:                    .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2466:quantbook-engine/crates/ql-io/src/qbook_format.rs:2999:            id_a.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2467:quantbook-engine/crates/ql-io/src/qbook_format.rs:3003:            id_b.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2469:quantbook-engine/crates/ql-storage/src/lib.rs:85:        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2473:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:55:        // `to_legacy_u32`. At step 3 all FormatTables default to
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2475:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:62:                id: id.to_legacy_u32().expect(
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2479:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:109:                    f.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2482:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:237:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2495:quantbook-engine/crates/ql-storage/src/format.rs:123:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2496:quantbook-engine/crates/ql-storage/src/format.rs:144:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2510:quantbook-engine/crates/ql-storage/src/format.rs:573:    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2511:quantbook-engine/crates/ql-storage/src/format.rs:574:        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2512:quantbook-engine/crates/ql-storage/src/format.rs:575:        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2513:quantbook-engine/crates/ql-storage/src/format.rs:576:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2514:quantbook-engine/crates/ql-storage/src/format.rs:578:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2515:quantbook-engine/crates/ql-storage/src/format.rs:584:    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2516:quantbook-engine/crates/ql-storage/src/format.rs:589:        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2518:quantbook-engine/crates/ql-storage/src/format.rs:596:            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2521:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:267:                id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2529:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1024:    // sees only LEGACY_PEER customs, so to_legacy_u32 succeeds).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2530:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1025:    let fmt_a_n = fmt_a.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2531:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    let fmt_b_n = fmt_b.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2532:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1027:    let fmt_c_n = fmt_c.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2541:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:292:        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2542:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:298:                a.1.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2543:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:340:    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2544:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:349:                    id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2545:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1003:            fid.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3099:   323	    // any to_legacy_u32 hop.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3169:  1112	                        // still uses bare-u32 ids. `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3173:  1116	                        // load-bearing — step 5 changes the envelope
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3176:  1119	                            .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3253:  1196	                    .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3396:   292	        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3402:   298	                a.1.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3444:   340	    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3453:   349	                    id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3493:  1003	            fid.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3863:    85	        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4205:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:55:        // `to_legacy_u32`. At step 3 all FormatTables default to
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4324:quantbook-engine/crates/ql-storage/src/format.rs:576:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4325:quantbook-engine/crates/ql-storage/src/format.rs:578:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4639:quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6097:test format::tests::to_legacy_u32_returns_none_for_non_legacy_peer ... ok
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6098:test format::tests::to_legacy_u32_round_trips_builtins_and_legacy_customs ... ok
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6429:Detail: The docs define `Builtin` as `0..=163`, but the public enum allows `FormatId::Builtin(200)`, and tests currently register it. `to_legacy_u32()` returns `Some(200)`, while `is_custom()` is false, so qbook/xlsx custom-format rosters skip the string at save/export (`qbook_format.rs:1192`, `umya_export.rs:347`). That can produce overlays or XLSX style ids with no persisted format definition.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6435:Recommendation: defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6439:Detail: `legacy_from_u32(u32::MAX).to_legacy_u32()` should round-trip, but the current test stops at `10_000`. Also consider checked arithmetic for arbitrary `Custom(LEGACY_PEER, c)` and `register_at(Custom(local, c))` at `u32::MAX`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6457:Detail: The docs define `Builtin` as `0..=163`, but the public enum allows `FormatId::Builtin(200)`, and tests currently register it. `to_legacy_u32()` returns `Some(200)`, while `is_custom()` is false, so qbook/xlsx custom-format rosters skip the string at save/export (`qbook_format.rs:1192`, `umya_export.rs:347`). That can produce overlays or XLSX style ids with no persisted format definition.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6463:Recommendation: defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6467:Detail: `legacy_from_u32(u32::MAX).to_legacy_u32()` should round-trip, but the current test stops at `10_000`. Also consider checked arithmetic for arbitrary `Custom(LEGACY_PEER, c)` and `register_at(Custom(local, c))` at `u32::MAX`.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1024:    // sees only LEGACY_PEER customs, so to_legacy_u32 succeeds).
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1025:    let fmt_a_n = fmt_a.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    let fmt_b_n = fmt_b.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1027:    let fmt_c_n = fmt_c.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1773:    // xlsx export's `to_legacy_u32().expect(...)` panicked on
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1812:    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1896:    // to the pre-step-6 to_legacy_u32() output. We verify by running
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1966:    // matching pre-step-6 `to_legacy_u32()` output (c + 164). Pre-
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:56:        // id.0 + 1` at format.rs; post-D-1 step 5 audit closure the
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:173:Mark Steps 2/3 checkboxes as `[x]` to reflect shipped state. Mark Step 4 boxes as `[x]` upon Step 4 commit (post-audit-cycle). Step 5/6 remain `[ ]`. This is hygiene that should be part of the Step 4 commit OR the Step 4.1 audit-closure commit.
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:246:**Severity rationale:** naming hygiene. MEDIUM because the name actively misleads readers searching for Step 2-specific coverage; Step 5 cross-cutting work will add more invariant tests and the naming convention matters.
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:269:If declared out-of-scope for Step 4, add to Step 5 cross-cutting suite — but Step 5 plan checklist doesn't currently enumerate it.
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:418:The ordering is correct, but consider adding a comment block at the head of the match describing the arm-coverage invariant — for future readers / Step 5 work.
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:479:### S4-LOW-10 — Step 5 plan checklist doesn't include the deferrals from Step 4
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:483:**Detail:** Step 5 lists structured-ref, implicit-intersection, row-limit boundaries, ISREF no-eval, ISFORMULA on blank cell, FORMULATEXT leading-`=`. Step 4 deferred clear_formula transitions (S4-MED-7), named-multi-cell-range FORMULATEXT (S4-MED-8), and `FORMULATEXT(SUM(NamedRange))` (S4-MED-9). These don't appear in Step 5's checklist either.
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:485:**Recommendation:** Update Step 5 plan items to include the deferrals. Alternatively, fold them into Step 4's commit as an audit-closure follow-up.
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:545:| 27. Design + plan status update for Step 5/6 | PENDING | Plan checkboxes not updated — S4-MED-3. |
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:547:| 29. Mini-phase closure docs | PENDING | Step 5/6 still ahead. |
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:577:| S4-LOW-10 | LOW | Step 5 plan checklist doesn't include Step 4 deferrals |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:55:This is the wire-format-defining step in a schema-breaking arc. Issues here propagate through step 3 (storage) + step 4 (Op) + step 5 (qbook envelope).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:62:2. **`from_u32_legacy` correctness.** Pre-5.2 used `FIRST_CUSTOM_FORMAT_ID = 164` (matches xlsx's `FIRST_XLSX_CUSTOM_NUMFMT`). Verify by reading `crates/ql-storage/src/format.rs` for the actual constant + checking that step 5's loader will consume `from_u32_legacy(n)` for ALL u32 values present in old `.qbook` files — including the rare cases like `n = u32::MAX` (which step 2 doesn't test). Are there any pre-5.2 u32 values that should be REJECTED rather than mapped (e.g. negative-equivalents wrapping, or reserved values)?
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:70:6. **Step 5 readiness — `.qbook` envelope.** Read `crates/ql-io/src/qbook_format.rs` (look for `FormatId` or `numFmtId` mentions). How does the current envelope encode cell format ids? Will the step-5 migration call `from_u32_legacy(n)` once per old format-id value at load time?
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:72:7. **`FIRST_XLSX_BUILTIN_MAX` const placement.** I put it as a local const inside wire.rs (not pub). Should it be public for step 5's loader? Or should step 5 just use the magic `163` literal? The d-1-checklist mentions `FIRST_XLSX_CUSTOM_NUMFMT = 164` as a "probable" constant — is the right home for that constant `ql-types`, `ql-oplog::wire`, or `ql-storage::format`?
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:969:   440	        // pre-migration. Step 5's loader is responsible for not mixing
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7392:quantbook-engine/docs/phase5/d-1-starting-checklist.md:132:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7648:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7964:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:692:quantbook-engine/docs/phase5/d-1-starting-checklist.md:122:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9315:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2473:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9849:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3827:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9966:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9973:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10679:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12051:   489	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12197:    91	/// migration (Phase 5.2 D-1 step 5).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12213:   107	/// Cross-ref: `docs/phase5/d-1-starting-checklist.md` § "Step 5".
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12347:    76	//!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12434:   590	**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12485:   127	### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12490:   132	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14097:PASS on step-5 readiness. Current `.qbook` stores `FormatEntry.id` and `FormatOverlayEntry.id` as `u32`; step 5 must convert both `formats.entries[].id` and every `sheets.format_overlay[].id` via the legacy mapping.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14099:PASS on const placement. Keep `FIRST_XLSX_BUILTIN_MAX` private here; step 5 should call `from_u32_legacy`, not duplicate `163`. A public xlsx boundary constant belongs with storage/xlsx mapping, not `ql_oplog::wire`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14128:PASS on step-5 readiness. Current `.qbook` stores `FormatEntry.id` and `FormatOverlayEntry.id` as `u32`; step 5 must convert both `formats.entries[].id` and every `sheets.format_overlay[].id` via the legacy mapping.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14130:PASS on const placement. Keep `FIRST_XLSX_BUILTIN_MAX` private here; step 5 should call `from_u32_legacy`, not duplicate `163`. A public xlsx boundary constant belongs with storage/xlsx mapping, not `ql_oplog::wire`.
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9339:   128	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:2:title: Phase 5.2 D-1 step 5 audit synthesis (qbook envelope schema bump v7→v8 + legacy loader)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:9:audit_target: commit `2ae5bfcab28` (Phase 5.2 D-1 step 5 — qbook envelope schema bump v7→v8 + legacy loader)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:13:# Phase 5.2 D-1 step 5 audit synthesis
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:56:| Step 5 ship (2ae5bfcab28) | 4262 | +5 |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:57:| Step 5 audit closure (this commit) | 4270 | +8 |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:61:Step 6 (xlsx export/import flatten) builds on step 5's envelope. Specifically:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:62:- Step 6 calls `FormatTable::iter().filter(|(id, _)| id.is_custom())` to dump custom formats to xlsx `numFmtId`. Step 5's `BuiltinOutOfRange` guard ensures no `Builtin(>163)` entries can exist in the table to confuse step 6.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:63:- Step 6 must decide how to flatten `Custom(non-LEGACY peer, _)` to a single-namespace `numFmtId` (xlsx has no peer-id concept). Step 5's lossless round-trip through `.qbook` doesn't address this; step 6's design decision.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:69:Neither auditor alone would have closed both H1 + H2 (Codex caught) and M2 (Opus caught) in step 5. The discipline rule of mandatory parallel 2-way audit is reaffirmed.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-consolidated.md:75:| Step 5 audit | 2 | 0 (PASS) | DIVERGENT — same pattern + Opus M2 unique |
quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:101:  of-snapshot)` ; `else → SheetRenameNameMismatch`. Storage failures
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2352:crates/ql-oplog/src/replay.rs:367:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2365:crates/ql-oplog/src/replay.rs:958:        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:14:# Codex audit — Phase 5.2 D-1 step 5 (qbook envelope schema bump v7→v8 + legacy loader) 2026-05-20
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:20:**Audit target:** commit `2ae5bfcab28` (Phase 5.2 D-1 step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:42:4. **Save path** (~lines 1100-1240): dropped `to_legacy_u32().expect(...)` panics at 2 sites; now emits `FormatEntryId::from_storage(fid)` directly. The custom-formats save block restructured: collect `(FormatId, String)` pairs first → sort by `FormatId` (derived Ord) → map to `FormatEntry` with Wire variant. This preserves the prior u32-sort semantic via FormatId's derived Ord.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:49:Step 5 is on the cold-data path (envelope persistence). Forward steps 6 (xlsx) and 7 (oplog.bin magic bytes) depend on this being correct. Migration bugs surface only when loading old `.qbook` files — silent failures here are particularly dangerous.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:75:3. **Step-4 dependency**: step 4 changed `ReplayError::FormatNotRegistered.id` to FormatId. Step 5 makes the analogous change to `MalformedFormat.id`. Are these two error types semantically aligned now? Any inconsistency in how `Debug` renders them?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:95:For each finding, please cite the exact file + line number + reproducing scenario where possible. The previous 4 audit cycles (steps 1-4) all caught real load-bearing issues; step 5's correctness is similarly load-bearing for step 6 (xlsx).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:282:2ae5bfcab28 (HEAD -> feat/quantbook-engine) Phase 5.2 D-1 step 5 — qbook envelope schema bump v7→v8 + legacy loader
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:291:/bin/zsh -lc "rg -n \"FormatEntryId|FormatEntry|FormatOverlayEntry|WORKBOOK_SCHEMA_VERSION|MalformedFormat|ReplayError::FormatNotRegistered|FormatIdWire|legacy_from_u32|to_legacy_u32|LEGACY_PEER|struct FormatId|enum FormatId\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:384:quantbook-engine/crates/ql-storage/src/lib.rs:85:        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:393:quantbook-engine/crates/ql-storage/src/format.rs:66:/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:402:quantbook-engine/crates/ql-storage/src/format.rs:134:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:404:quantbook-engine/crates/ql-storage/src/format.rs:155:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:424:quantbook-engine/crates/ql-storage/src/format.rs:799:    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:425:quantbook-engine/crates/ql-storage/src/format.rs:800:        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:426:quantbook-engine/crates/ql-storage/src/format.rs:801:        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:427:quantbook-engine/crates/ql-storage/src/format.rs:802:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:428:quantbook-engine/crates/ql-storage/src/format.rs:804:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:429:quantbook-engine/crates/ql-storage/src/format.rs:810:    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:430:quantbook-engine/crates/ql-storage/src/format.rs:815:        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:432:quantbook-engine/crates/ql-storage/src/format.rs:836:            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:451:quantbook-engine/crates/ql-io/src/qbook_format.rs:159:///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:485:quantbook-engine/crates/ql-io/src/qbook_format.rs:1207:                        // pre-step-5 hit the to_legacy_u32().expect() panic).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:490:quantbook-engine/crates/ql-io/src/qbook_format.rs:1298:                    // `id.to_legacy_u32().expect(...)` which would have
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:496:quantbook-engine/crates/ql-io/src/qbook_format.rs:1628:            // Phase 5.2 D-1 step 5: `entry.id` is now `FormatEntryId`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:509:quantbook-engine/crates/ql-io/src/qbook_format.rs:3100:            id_a.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:510:quantbook-engine/crates/ql-io/src/qbook_format.rs:3104:            id_b.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:513:quantbook-engine/crates/ql-io/src/qbook_format.rs:3247:        // Phase 5.2 D-1 step 5: MalformedFormat.id changed u32 → FormatId.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:537:quantbook-engine/crates/ql-io/src/qbook_format.rs:3450:    /// `to_legacy_u32().expect(...)` would have panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:549:quantbook-engine/crates/ql-io/src/qbook_format.rs:3582:    /// **Step 5:** the `FormatEntryId::from_storage(FormatId)` constructor
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:553:quantbook-engine/crates/ql-io/src/qbook_format.rs:3956:        // Phase 5.2 D-1 step 5 (2026-05-20) bumped from 7 to 8: FormatEntry.id
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:559:quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:579:quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:320:    // any to_legacy_u32 hop.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:583:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:292:        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:584:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:298:                a.1.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:585:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:340:    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:586:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:349:                    id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:587:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1003:            fid.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:589:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:267:                id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:596:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1024:    // sees only LEGACY_PEER customs, so to_legacy_u32 succeeds).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:597:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1025:    let fmt_a_n = fmt_a.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:598:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    let fmt_b_n = fmt_b.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:599:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1027:    let fmt_c_n = fmt_c.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:604:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:65:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:608:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:117:                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:611:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:244:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:629:    Phase 5.2 D-1 step 5 — qbook envelope schema bump v7→v8 + legacy loader
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:636:    u32 and the save path's `to_legacy_u32().expect(...)` would have panicked
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:647:      directly. Dropped the to_legacy_u32().expect() panics at 2 sites.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:663:      Custom id round-trips losslessly (the property step 5 enables).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:671:    Gates: 4262 workspace tests passing (+5 from step 5). fmt + clippy clean.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:829:+/// **Phase 5.2 D-1 step 5 (2026-05-20):** bumped to v8. v8 changes:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:839:+///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:978:+    /// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1169:+/// **Phase 5.2 D-1 step 5 (2026-05-20):** envelope-side `id` field used
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1203:+    /// **Step 5 migration contract:** this is the ONLY conversion needed
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1223:+/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1239:+/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1430:-                        // still uses bare-u32 ids. `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1434:-                        // load-bearing — step 5 changes the envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1437:-                            .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1439:+                        // Phase 5.2 D-1 step 5: envelope schema bumped to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1442:+                        // pre-step-5 hit the to_legacy_u32().expect() panic).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1526:-                    .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1541:+                    // Phase 5.2 D-1 step 5: emit v8 tagged-tuple shape
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1543:+                    // `id.to_legacy_u32().expect(...)` which would have
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1734:+            // Phase 5.2 D-1 step 5: `entry.id` is now `FormatEntryId`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1796:+            // (the enum) rather than `u32`. Phase 5.2 D-1 step 5:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1998:+        // Phase 5.2 D-1 step 5: MalformedFormat.id changed u32 → FormatId.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2105:+    // ===== Phase 5.2 D-1 step 5 (2026-05-20) — qbook envelope v7 → v8 =====
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2107:+    /// **Step 5 fixture test:** hand-craft a v7 envelope with bare-u32
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2200:+    /// **Step 5 round-trip test:** verify v8 envelopes preserve non-LEGACY
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2202:+    /// property step 5 enables — pre-step-5 the save path's
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2203:+    /// `to_legacy_u32().expect(...)` would have panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2245:+    /// **Step 5 round-trip test:** verify v8 envelopes serialize the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2285:+    /// **Step 5 ordering test:** verify untagged enum dispatch is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2335:+    /// **Step 5:** the `FormatEntryId::from_storage(FormatId)` constructor
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2541:+    /// **Phase 5.2 D-1 step 5 (2026-05-20):** v8 is now current; bumped
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2713:+        // Phase 5.2 D-1 step 5 (2026-05-20) bumped from 7 to 8: FormatEntry.id
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2961:   149	/// **Phase 5.2 D-1 step 5 (2026-05-20):** bumped to v8. v8 changes:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2971:   159	///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3217:  1204	                        // Phase 5.2 D-1 step 5: envelope schema bumped to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3220:  1207	                        // pre-step-5 hit the to_legacy_u32().expect() panic).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3392:  1628	            // Phase 5.2 D-1 step 5: `entry.id` is now `FormatEntryId`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3447:  1683	            // (the enum) rather than `u32`. Phase 5.2 D-1 step 5:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3542:  1296	                    // Phase 5.2 D-1 step 5: emit v8 tagged-tuple shape
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3544:  1298	                    // `id.to_legacy_u32().expect(...)` which would have
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3606:   592	/// **Phase 5.2 D-1 step 5 (2026-05-20):** envelope-side `id` field used
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3640:   626	    /// **Step 5 migration contract:** this is the ONLY conversion needed
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3660:   646	/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3675:   661	/// **Phase 5.2 D-1 step 5 (2026-05-20):** `id` changed from `u32` to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3698:  3352	    // ===== Phase 5.2 D-1 step 5 (2026-05-20) — qbook envelope v7 → v8 =====
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3700:  3354	    /// **Step 5 fixture test:** hand-craft a v7 envelope with bare-u32
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3793:  3447	    /// **Step 5 round-trip test:** verify v8 envelopes preserve non-LEGACY
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3795:  3449	    /// property step 5 enables — pre-step-5 the save path's
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3796:  3450	    /// `to_legacy_u32().expect(...)` would have panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3838:  3492	    /// **Step 5 round-trip test:** verify v8 envelopes serialize the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3878:  3532	    /// **Step 5 ordering test:** verify untagged enum dispatch is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3928:  3582	    /// **Step 5:** the `FormatEntryId::from_storage(FormatId)` constructor
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3975:    66	/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:4023:   114	    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:4043:   134	    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:4064:   155	/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:4753:quantbook-engine/crates/ql-io/src/qbook_format.rs:3247:        // Phase 5.2 D-1 step 5: MalformedFormat.id changed u32 → FormatId.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:4951:   462	        // pre-migration. Step 5's loader is responsible for not mixing
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:5134:    91	/// migration (Phase 5.2 D-1 step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:5150:   107	/// Cross-ref: `docs/phase5/d-1-starting-checklist.md` § "Step 5".
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32051:   143	    SheetRenameNameMismatch {
quantbook-engine/crates/ql-exec/tests/reference_fns_coverage_extensions.rs:11://! is deferred to the Step 5 cross-cutting suite per design § 7.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:561:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1191://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1503://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1915:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:2717:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:2836:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:2859:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3031:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3137:            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:4363:   249	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:5514:    /// match the current sheet name (`SheetRenameNameMismatch`); under
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:5550:    /// (step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-opus.md:41:- L7 — `Builtin(n>163)` indirect path closed by step 5 audit.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:37:| M-1 | `current_work.md` step 5 lists D-2/D-3/D-4 as pending | Opus | ✅ FIXED in rewrite |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2688:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1051:docs/audits/2026-05-17-rt-step-4-opus.md:418:The ordering is correct, but consider adding a comment block at the head of the match describing the arm-coverage invariant — for future readers / Step 5 work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3627:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1051:docs/audits/2026-05-17-rt-step-4-opus.md:418:The ordering is correct, but consider adding a comment block at the head of the match describing the arm-coverage invariant — for future readers / Step 5 work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4346:quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:418:The ordering is correct, but consider adding a comment block at the head of the match describing the arm-coverage invariant — for future readers / Step 5 work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4364:quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:418:The ordering is correct, but consider adding a comment block at the head of the match describing the arm-coverage invariant — for future readers / Step 5 work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7904:   322	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:17:**2-way audit caught real load-bearing issues that step 1 missed.** Codex identified one HIGH (PeerId serde gap), one MEDIUM with architectural impact (Cargo cycle for step 3), one MEDIUM with planning-correctness impact (LEGACY_PEER deferral timing), plus 3 LOW doc-drift items. Opus passed step 1 with 3 LOW polish items — Opus and Codex DIVERGED on the LEGACY_PEER deferral question (Opus said defer was fine; Codex said fix now). The divergence was load-bearing: Codex's reading was correct because the migration helper is born in step 2, not step 5.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:37:**M2 — `LEGACY_PEER` deferral to step 5 is too late (Codex; Opus disagreed and said defer was fine).**
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:40:- **Disagreement resolution:** Codex correct. Opus saw the d-1-checklist's "step 5 home" framing for LEGACY_PEER and judged that as the natural defer point; Codex looked at the from_u32_legacy helper's birth location and worked back. Going forward, when auditors disagree on deferral, ship the constant — adding earlier is cheap (one const) and removing duplication later is expensive.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:38:- `ql-exec::workbook_runtime::formats::intern_format` emits `FormatIdWire::from_storage(id)` directly. No more `to_legacy_u32().expect(...)`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:87:1. **Op wire-format break is documented and intentional.** Old `.qbook` saves with `oplog.bin` carrying u32-shaped Op variants will fail to deserialize via serde post-step-4. This is expected per D-1 design (step 5 + step 7 add migration/magic-bytes). Verify: are there any test fixtures or callers that load pre-step-4 oplog.bin blobs? If yes, they're broken now. (Step 5/7 work, not step 4 bug — but worth surfacing.)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:118:10. **The 5 dropped `to_legacy_u32().expect()` sites in oplog paths.** Pre-step-4, these existed because Op carried u32. Post-step-4 they're gone. Verify by grep that NO `to_legacy_u32().expect()` calls remain in:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:123:    The remaining sites (5 expects) should all be in `ql-io/src/qbook_format.rs` (step 5) and `ql-io-xlsx/src/write/umya_export.rs` (step 6).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:125:### Forward-readiness for step 5
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:127:11. **Step 5 will:** bump the .qbook envelope schema version, add a legacy loader that reads pre-step-5 u32 ids and converts via `FormatId::legacy_from_u32`. The current qbook_format.rs save path uses `to_legacy_u32().expect(...)` — still load-bearing because step 5 hasn't bumped the schema yet. Verify the expect() invariant holds: no caller produces non-LEGACY-peer FormatIds today (no production code calls `FormatTable::with_peer(non_LEGACY)` or `set_local_peer(non_LEGACY)`).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:140:Severities: HIGH (blocks step 5), MEDIUM (should-fix this cycle), LOW (polish).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:372:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:450:    times). Step-4 audit must run before step 5 (qbook envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:471:     pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:492: /// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1038:     fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1039:         assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1040:         assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1041:         assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1043:             FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1049:     fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1054:         assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1075:             assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1305:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1383:    times). Step-4 audit must run before step 5 (qbook envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1479:+    /// (step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1686:     SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1759:                         if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1823:                 Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1847:+            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2298:         assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2521:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2599:    times). Step-4 audit must run before step 5 (qbook envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2663:-        // `to_legacy_u32`. At step 3 all FormatTables default to
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2668:+        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2677:-                id: id.to_legacy_u32().expect(
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2725:-                    f.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2729:+                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2856:             assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3337:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3415:    times). Step-4 audit must run before step 5 (qbook envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3928:    54	        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3980:   106	                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4107:   233	            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4363:    30	//! (used by qbook envelope loader in step 5 and xlsx import in step 6).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4399:    66	/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4447:   114	    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4467:   134	    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4488:   155	/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5026:   693	    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5027:   694	        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5028:   695	        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5029:   696	        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5031:   698	            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5037:   704	    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5042:   709	        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5063:   730	            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5389:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5675:   429	            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5682:   436	                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5746:   500	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5764:   518	            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6854:  1608	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:7700:   462	        // pre-migration. Step 5's loader is responsible for not mixing
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:7888:/bin/zsh -lc "rg -n \"Op::RegisterFormat|Op::SetCellFormat|RegisterFormat \\{|SetCellFormat \\{|to_storage\\(|to_legacy_u32\\(\\)\\.expect|legacy_from_u32\\(|from_storage\\(|from_u32_legacy\\(\" quantbook-engine/crates" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:7968:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:54:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8118:quantbook-engine/docs/phase5/d-1-starting-checklist.md:97:  (= `PeerId(0)`) for step 5's qbook migration.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8120:quantbook-engine/docs/phase5/d-1-starting-checklist.md:124:  - ql-io: qbook envelope save/load uses `to_legacy_u32().expect(...)` + `is_custom()`. Pre-step-5 envelope still u32-shaped.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8122:quantbook-engine/docs/phase5/d-1-starting-checklist.md:138:### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8123:quantbook-engine/docs/phase5/d-1-starting-checklist.md:143:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8127:quantbook-engine/docs/phase5/d-1-starting-checklist.md:163:**Estimated total: 10-14 hours = ~2 working days.** Step 5 (backwards-compat) is the riskiest; allocate time for old `.qbook` fixture tests.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8466:quantbook-engine/crates/ql-storage/src/format.rs:30://! (used by qbook envelope loader in step 5 and xlsx import in step 6).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8468:quantbook-engine/crates/ql-storage/src/format.rs:114:    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8660:quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8994:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9005:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:109:14. **Step 4 will:** change `Op::RegisterFormat { id: u32 }` → `Op::RegisterFormat { id: FormatIdWire }`. The producer + replay sites currently use `to_legacy_u32().expect()` / `legacy_from_u32`. Step 4 drops these. Verify the substitution is mechanical (no logic changes needed) for each site.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9014:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:482:    30	//! (used by qbook envelope loader in step 5 and xlsx import in step 6).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9016:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:555:   103	    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9051:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2399:/bin/zsh -lc "rg -n \"RegisterFormat|SetCellFormat|FormatNotRegistered|legacy_from_u32|to_legacy_u32|FormatId::Builtin\\(200\\)|Builtin\\([2-9][0-9][0-9]\\)\" quantbook-engine/crates -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9094:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2459:quantbook-engine/crates/ql-io/src/qbook_format.rs:1112:                        // still uses bare-u32 ids. `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9095:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2460:quantbook-engine/crates/ql-io/src/qbook_format.rs:1119:                            .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9096:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2461:quantbook-engine/crates/ql-io/src/qbook_format.rs:1196:                    .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9101:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2466:quantbook-engine/crates/ql-io/src/qbook_format.rs:2999:            id_a.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9102:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2467:quantbook-engine/crates/ql-io/src/qbook_format.rs:3003:            id_b.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9162:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4639:quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9175:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6429:Detail: The docs define `Builtin` as `0..=163`, but the public enum allows `FormatId::Builtin(200)`, and tests currently register it. `to_legacy_u32()` returns `Some(200)`, while `is_custom()` is false, so qbook/xlsx custom-format rosters skip the string at save/export (`qbook_format.rs:1192`, `umya_export.rs:347`). That can produce overlays or XLSX style ids with no persisted format definition.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9177:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6435:Recommendation: defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9178:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6457:Detail: The docs define `Builtin` as `0..=163`, but the public enum allows `FormatId::Builtin(200)`, and tests currently register it. `to_legacy_u32()` returns `Some(200)`, while `is_custom()` is false, so qbook/xlsx custom-format rosters skip the string at save/export (`qbook_format.rs:1192`, `umya_export.rs:347`). That can produce overlays or XLSX style ids with no persisted format definition.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9180:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6463:Recommendation: defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9654:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:59:6. **LEGACY_PEER deferral.** The d-1-checklist (step 1 description) recommends "Pick one in step 1" for the LEGACY_PEER sentinel (`PeerId(0)` vs `PeerId(u64::MAX - 1)`). The shipped commit DEFERS this to step 5 (qbook envelope) with the rationale "no current use site." Is this defensible, or should the constant be added now for forward consistency?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9668:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:692:quantbook-engine/docs/phase5/d-1-starting-checklist.md:122:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9726:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2473:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9767:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3822:### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9768:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3827:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9772:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3847:**Estimated total: 10-14 hours = ~2 working days.** Step 5 (backwards-compat) is the riskiest; allocate time for old `.qbook` fixture tests.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9802:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9805:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9809:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:55:This is the wire-format-defining step in a schema-breaking arc. Issues here propagate through step 3 (storage) + step 4 (Op) + step 5 (qbook envelope).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9810:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:62:2. **`from_u32_legacy` correctness.** Pre-5.2 used `FIRST_CUSTOM_FORMAT_ID = 164` (matches xlsx's `FIRST_XLSX_CUSTOM_NUMFMT`). Verify by reading `crates/ql-storage/src/format.rs` for the actual constant + checking that step 5's loader will consume `from_u32_legacy(n)` for ALL u32 values present in old `.qbook` files — including the rare cases like `n = u32::MAX` (which step 2 doesn't test). Are there any pre-5.2 u32 values that should be REJECTED rather than mapped (e.g. negative-equivalents wrapping, or reserved values)?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9812:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:70:6. **Step 5 readiness — `.qbook` envelope.** Read `crates/ql-io/src/qbook_format.rs` (look for `FormatId` or `numFmtId` mentions). How does the current envelope encode cell format ids? Will the step-5 migration call `from_u32_legacy(n)` once per old format-id value at load time?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10157:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7392:quantbook-engine/docs/phase5/d-1-starting-checklist.md:132:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10166:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7648:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10181:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7964:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:692:quantbook-engine/docs/phase5/d-1-starting-checklist.md:122:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10236:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9315:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2473:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10265:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9849:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3827:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10270:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9966:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10271:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9973:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10298:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10679:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10356:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12347:    76	//!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10363:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12485:   127	### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10364:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12490:   132	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11574:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:20:**L1 — `FIRST_XLSX_BUILTIN_MAX` not `pub`.** wire.rs:295 keeps the const file-private. Step 5 (qbook envelope loader) and step 6 (xlsx export at `umya_export.rs`) both will want a shared boundary value. Two options: (a) export `pub const FIRST_XLSX_BUILTIN_MAX` (or `FIRST_XLSX_CUSTOM_NUMFMT = 164`) from `ql_oplog::wire`, OR (b) defer — duplicate the const in step 5/6 callers and audit then. Either works; (a) is mildly cleaner because the d-1-checklist already names `FIRST_XLSX_CUSTOM_NUMFMT` as a shared concept. Not blocking step 3 (step 3 has no use for this constant).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11576:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:34:- No arithmetic on `Op::RegisterFormat.id: u32` or `Op::SetCellFormat.id: Option<u32>` in replay (replay.rs:497-540) or producer (formats.rs:41-114) — only `==` / `lookup` lookups + `>= FIRST_CUSTOM_FORMAT_ID` filter at save (qbook_format.rs:1179). Step 4 swap is a clean signature change at these sites; step 5 reads the filter through `from_u32_legacy`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11586:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:411:   116	### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11587:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11591:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:436:   141	**Estimated total: 10-14 hours = ~2 working days.** Step 5 (backwards-compat) is the riskiest; allocate time for old `.qbook` fixture tests.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12121:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-opus.md:32:- **LEGACY_PEER deferral defensible.** D-1 checklist locates the sentinel at step 5 (qbook envelope schema bump) where its only call-site (the legacy-u32 loader) is born. Adding the constant in step 1 with no consumer would (a) violate the no-unused-symbols hygiene the project enforces and (b) prematurely commit to one of two equally-valid encodings (`PeerId(0)` vs `PeerId(u64::MAX - 1)`). The checklist explicitly hedges "Pick one in step 1" but the decision criterion (Loro acceptance, sentinel collision avoidance) is more naturally informed by step 5's loader needs. Defer is correct.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12899:/bin/zsh -lc "rg -n \"to_legacy_u32\\(|expect\\(\" quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs quantbook-engine/crates/ql-io/src/qbook_format.rs quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12902:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:298:                a.1.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12905:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:349:                    id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12907:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1003:            fid.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12911:quantbook-engine/crates/ql-io/src/qbook_format.rs:1112:                        // still uses bare-u32 ids. `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12913:quantbook-engine/crates/ql-io/src/qbook_format.rs:1119:                            .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12915:quantbook-engine/crates/ql-io/src/qbook_format.rs:1196:                    .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12919:quantbook-engine/crates/ql-io/src/qbook_format.rs:2999:            id_a.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12920:quantbook-engine/crates/ql-io/src/qbook_format.rs:3003:            id_b.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12925:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:54:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12929:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:233:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12985:quantbook-engine/crates/ql-storage/src/format.rs:696:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12986:quantbook-engine/crates/ql-storage/src/format.rs:698:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13009:quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13098:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1024:    // sees only LEGACY_PEER customs, so to_legacy_u32 succeeds).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13118:            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13262:                        // still uses bare-u32 ids. `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13266:                        // load-bearing — step 5 changes the envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13269:                            .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13346:                    .to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13366:        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13372:                a.1.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13414:    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13423:                    id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13439:  - ql-io: qbook envelope save/load uses `to_legacy_u32().expect(...)` + `is_custom()`. Pre-step-5 envelope still u32-shaped.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13440:  - ql-io-xlsx: xlsx import/export uses `legacy_from_u32` / `to_legacy_u32().expect(...)`. Pre-step-6 xlsx sees only LEGACY_PEER.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13453:### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13458:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14023:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14046:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:1148:- `SEQUENCE(2, 3, 10, 5)` → 2×3 starting at 10, step 5.
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:4894:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-consolidated.md:100:| Step 5 audit | Codex+Opus | 2 HIGH + 0 + 1 unique Opus MEDIUM (DIVERGENT) | Codex + Opus complement |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1081:   480	**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/crates/ql-functions/tests/coverage.rs:723:         ref + implicit-intersection deferred to Step 5 cross-cutting \
quantbook-engine/crates/ql-functions/tests/coverage.rs:731:         implicit-intersection deferred to Step 5; scalar arg-coverage \
quantbook-engine/crates/ql-functions/tests/coverage.rs:739:         implicit-intersection deferred to Step 5; scalar arg-coverage \
quantbook-engine/crates/ql-functions/tests/coverage.rs:747:         implicit-intersection deferred to Step 5; scalar arg-coverage \
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:59:6. **LEGACY_PEER deferral.** The d-1-checklist (step 1 description) recommends "Pick one in step 1" for the LEGACY_PEER sentinel (`PeerId(0)` vs `PeerId(u64::MAX - 1)`). The shipped commit DEFERS this to step 5 (qbook envelope) with the rationale "no current use site." Is this defensible, or should the constant be added now for forward consistency?
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:692:quantbook-engine/docs/phase5/d-1-starting-checklist.md:122:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2473:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3822:### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3827:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3847:**Estimated total: 10-14 hours = ~2 working days.** Step 5 (backwards-compat) is the riskiest; allocate time for old `.qbook` fixture tests.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4268:**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5718:[MEDIUM] `LEGACY_PEER` deferral to step 5 is too late for the written plan
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5762:[MEDIUM] `LEGACY_PEER` deferral to step 5 is too late for the written plan
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:40:- `crates/ql-oplog/src/replay.rs` — rename-sheet replay 3-case reconciliation, scoped-SetName routing, `ReplayError::SheetRenameNameMismatch` + `SheetRenameRejected`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-opus.md:1:# Opus audit — Phase 5.2 D-1 step 5 (qbook envelope schema bump v7→v8 + legacy loader) 2026-05-20
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-opus.md:9:Step 5 is **structurally correct and ships a sound migration path**. The four hardest invariants — untagged variant order, save-side determinism, multi-peer round-trip, and forward-compat — are all correct in the code. Hands-on round-trip verification (cross-peer same-string, multi-peer, builtin-in-overlay, 3-entry overlay) all decoded cleanly.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-opus.md:15:None. Step 5 ships clean structurally.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:28:Closed the pre-step-2 replay hard-fail at `crates/ql-oplog/src/replay.rs:486-532` (specifically case 3, `SheetRenameNameMismatch`). Discovered during step 1 code survey: under CRDT merge of concurrent renames (peer A: S→S2 + peer B: S→S3 concurrent), the second rename op's `old_name="S"` no longer matches current ("S2") → replay erred → unrecoverable.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:35:- `ReplayError::SheetRenameNameMismatch` variant kept for ABI compat; zero emit sites post-step-2; docstring marks "VARIANT NO LONGER EMITTED."
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:73:7. **`ReplayError::SheetRenameNameMismatch` dead variant.** Should it be `#[deprecated]`? Removed entirely? Kept silently? Pick the right call.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:252:    `SheetRenameNameMismatch`). Discovered during Phase 5.3 step 1 code survey
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:272:    - `ReplayError::SheetRenameNameMismatch` variant kept for ABI compat
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:396:+            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:457:-                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:472:+    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:499:-        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:541:   460	            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:548:   467	                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:590:   509	            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:810:+//! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:923:+    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1143:   149	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1362:/bin/zsh -lc "rg -n \"enum Op|RenameSheet|RenameTable|RenameColumn|DropSheet|DeleteSheet|RemoveSheet|SheetRenameNameMismatch\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1365:quantbook-engine/crates/ql-oplog/src/replay.rs:149:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1369:quantbook-engine/crates/ql-oplog/src/replay.rs:509:            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1379:quantbook-engine/crates/ql-oplog/src/replay.rs:1660:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1392:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1399:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1426:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1719:   126	    /// (step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:2394:quantbook-engine/docs/phase5/d-1-starting-checklist.md:240:- [ ] You've read this doc's Step 4 + Step 5 sections (most-recent + next), `docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md` (most-recent audit), and `crdt-data-model.md` § "Format id collision" (overall design status). `v1-exit-packet.md` is broader Phase 5 V1 context if needed.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:3163:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:3393:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:3404:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:56:The 3-cycle divergent-HIGH pattern from D-1 (steps 5, 6, 7) extended into Phase 5.3 step 1. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 2 + step 3 + step 4 + step 5 megaudit) should expect the same: parallel Codex + Opus, with closure for both, before progressing.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:3463:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:428:docs/architecture/crdt-data-model.md:301:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:3712:./quantbook-engine/docs/phase5/d-1-starting-checklist.md:240:- [ ] You've read this doc's Step 4 + Step 5 sections (most-recent + next), `docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md` (most-recent audit), and `crdt-data-model.md` § "Format id collision" (overall design status). `v1-exit-packet.md` is broader Phase 5 V1 context if needed.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:4625:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:428:docs/architecture/crdt-data-model.md:301:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:4692:./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:4705:./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:56:The 3-cycle divergent-HIGH pattern from D-1 (steps 5, 6, 7) extended into Phase 5.3 step 1. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 2 + step 3 + step 4 + step 5 megaudit) should expect the same: parallel Codex + Opus, with closure for both, before progressing.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:4753:./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5110:   327	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5340:  1660	    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5434:     5	//! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5547:   118	    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5892:   500	// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5894:   502	/// **Conflict-matrix row 7 (PRE-FIX behavior):** peer A renames
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5953:   561	    // **PRE-FIX assertion**: bind fails → #NAME?. After Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5960:   568	        "PRE-FIX (D-3 V1 limitation): formula references old sheet name → \
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5962:   570	         Phase 5.3 step 3 will fix this via rename-repair."
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5970:/bin/zsh -lc "rg -n \"RenameSheet \\{|old_name.*validation|replay-time validation|SheetRenameNameMismatch|current name matches neither|old_name carried\" quantbook-engine/crates quantbook-engine/docs -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5974:quantbook-engine/crates/ql-oplog/src/replay.rs:149:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5976:quantbook-engine/crates/ql-oplog/src/replay.rs:509:            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5980:quantbook-engine/crates/ql-oplog/src/replay.rs:1660:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5991:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5998:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6010:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1419:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6012:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2277:   494	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6016:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12051:   489	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6017:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:161:3. Neither → `SheetRenameNameMismatch` error (divergent state).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6022:quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9339:   128	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6026:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32051:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6029:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1686:     SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6031:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1823:                 Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6035:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2298:         assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6039:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5389:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6041:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5746:   500	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6045:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6854:  1608	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6049:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:40:- `crates/ql-oplog/src/replay.rs` — rename-sheet replay 3-case reconciliation, scoped-SetName routing, `ReplayError::SheetRenameNameMismatch` + `SheetRenameRejected`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6051:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6724:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6052:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7593:525:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6056:quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:101:  of-snapshot)` ; `else → SheetRenameNameMismatch`. Storage failures
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6069:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6070:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6058:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6075:quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1320:   129	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6077:quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1646:   443	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6085:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6086:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6088:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4358:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6090:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4740:   525	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6094:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5848:  1633	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6107:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7671:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6110:quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1542:129:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6112:quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2649:443:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6115:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5702:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6284:quantbook-engine/docs/architecture/crdt-data-model.md:327:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6289:quantbook-engine/docs/architecture/crdt-data-model.md:618:**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6308:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:934:   327	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6313:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1200:   593	**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6557:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6921:   320	    // any to_legacy_u32 hop.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:7077:LOW: `ReplayError::SheetRenameNameMismatch` is okay to keep, but should be actively marked if you want discoverability.  
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:7114:LOW: `ReplayError::SheetRenameNameMismatch` is okay to keep, but should be actively marked if you want discoverability.  
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:428:docs/architecture/crdt-data-model.md:301:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:528:docs/audits/2026-05-19-handoff-audit-consolidated.md:37:| M-1 | `current_work.md` step 5 lists D-2/D-3/D-4 as pending | Opus | ✅ FIXED in rewrite |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1051:docs/audits/2026-05-17-rt-step-4-opus.md:418:The ordering is correct, but consider adding a comment block at the head of the match describing the arm-coverage invariant — for future readers / Step 5 work.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1055:docs/audits/2026-05-17-rt-step-4-opus.md:545:| 27. Design + plan status update for Step 5/6 | PENDING | Plan checkboxes not updated — S4-MED-3. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md:44:| DropTable hard-fails on concurrent rename | Opus M-1 | Same bug class as table rename; out of step 4 scope | Step 5 megaudit or V2 |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md:45:| Inconsistent case-only rename policy across sheet/table/column | Opus M-3 | Architectural design decision | Step 5 megaudit |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md:77:- **Step 5 megaudit**: should re-examine the cross-source target collision V1 limitation as a candidate for V2 closure. Specifically: would `replay_into` returning a `(Workbook, ReplayTrace)` tuple work?
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md:79:- The "advisory-skip vs hard-fail" decision was the right V1 call for step 4 closure, but it leaves a sibling-bug at DropTable that step 5 megaudit MUST surface as work-or-defer.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-opus.md:32:- **LEGACY_PEER deferral defensible.** D-1 checklist locates the sentinel at step 5 (qbook envelope schema bump) where its only call-site (the legacy-u32 loader) is born. Adding the constant in step 1 with no consumer would (a) violate the no-unused-symbols hygiene the project enforces and (b) prematurely commit to one of two equally-valid encodings (`PeerId(0)` vs `PeerId(u64::MAX - 1)`). The checklist explicitly hedges "Pick one in step 1" but the decision criterion (Loro acceptance, sentinel collision avoidance) is more naturally informed by step 5's loader needs. Defer is correct.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:62:- `to_legacy_u32().expect(` — any remaining expect-on-legacy sites (should be 0 post-step-6).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:309:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:244:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:319:quantbook-engine/crates/ql-storage/src/lib.rs:85:        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:848://! (used by qbook envelope loader in step 5 and xlsx import in step 6).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:884:/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:932:    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:952:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:973:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:1381:    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:1465:    // to the pre-step-6 to_legacy_u32() output. We verify by running
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:1535:    // matching pre-step-6 `to_legacy_u32()` output (c + 164). Pre-
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:2010:        // Phase 5.2 D-1 step 5 audit Codex HIGH-1 + HIGH-2 closure
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:2155:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:2164:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:3279:    /// (step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5104:///    the pre-step-6 `to_legacy_u32()` mapping. Holds for ALL counters
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5182:        // {5, 7} from replay scenarios) — pre-step-6 `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5513:        // pre-step-6 expect() on `to_legacy_u32()` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5623:    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6219:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6392:1678:            // Phase 5.2 D-1 step 5: `entry.id` is now `FormatEntryId`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6431:3297:        // Phase 5.2 D-1 step 5: MalformedFormat.id changed u32 → FormatId.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6480:3662:    /// **Step 5:** the `FormatEntryId::from_storage(FormatId)` constructor
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6505:4285:        // Phase 5.2 D-1 step 5 (2026-05-20) bumped from 7 to 8: FormatEntry.id
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6621:            // Phase 5.2 D-1 step 5: `entry.id` is now `FormatEntryId`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6676:            // (the enum) rather than `u32`. Phase 5.2 D-1 step 5:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6724:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6742:            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7262:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7314:                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7593:525:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7739:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7746:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8784:/bin/zsh -lc "rg -n \"to_legacy_u32\\(\\)\\.expect\\(\" quantbook-engine -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8788:quantbook-engine/crates/ql-io/src/qbook_format.rs:172:///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8789:quantbook-engine/crates/ql-io/src/qbook_format.rs:1220:                        // pre-step-5 hit the to_legacy_u32().expect() panic).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8790:quantbook-engine/crates/ql-io/src/qbook_format.rs:1311:                    // `id.to_legacy_u32().expect(...)` which would have
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8791:quantbook-engine/crates/ql-io/src/qbook_format.rs:3500:    /// `to_legacy_u32().expect(...)` would have panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8792:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:609:    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8793:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1220:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8794:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1773:    // xlsx export's `to_legacy_u32().expect(...)` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8795:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1812:    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:8796:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:65:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:34350:   173	        // {5, 7} from replay scenarios) — pre-step-6 `to_legacy_u32()`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:34448:   609	    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:34534:  1733	            // (the enum) rather than `u32`. Phase 5.2 D-1 step 5:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:34670:   126	    /// (step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:22:Predecessor chain: `9a95429b284` (step 5 doc refresh) → `30ef2637d6f` (step 5 audit closures) → `2ae5bfcab28` (step 5 ship — qbook envelope v7→v8) → step 4 ship `6a4b8b0922f`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:33:   - 3 `to_legacy_u32().expect("pre-step-6 ...")` panic sites removed:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:57:3. **Byte-stability for LEGACY_PEER-only workbooks.** The claim is "Custom(LEGACY_PEER, c) → c + 164 — identical to pre-step-6 `to_legacy_u32()` output." Verify:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:59:   - For a LEGACY_PEER-only workbook with Customs counter=5, 7 (non-contiguous from register_at replay): does the translation yield 164, 165 (re-indexed)? OR 169, 171 (preserving counter)? Pre-step-6 yielded the latter (`to_legacy_u32` returns `c + 164`). Post-step-6 yields the former (sequential allocation). This is a byte-incompatibility.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:88:Run thorough analysis. Spawn sub-agents for cross-file invariants. Don't shortcut reasoning. Step 5 audit caught 2 HIGHs reachable from on-disk input (counter overflow + Builtin range) — the same level of scrutiny applies here.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:277:    the pre-step-6 to_legacy_u32() output. All existing xlsx round-trip
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:285:        `to_legacy_u32().expect("pre-step-6 ...")` panics:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:364:/bin/zsh -lc 'rg -n "XlsxNumFmtTranslation|cellxfs_roster|post_process_zip|inject_cell_xfs|to_legacy_u32|FIRST_CUSTOM_FORMAT_ID|UnsupportedFeatureKind::Other|multi-peer-format-id-flatten" quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:368:101:/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:381:424:        // pre-step-6 expect() on `to_legacy_u32()` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:383:468:    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:385:514:    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:398:1125:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:507:/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:835:        // pre-step-6 expect() on `to_legacy_u32()` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:879:    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:925:    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1466:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1519:/bin/zsh -lc "rg -n \"enum FormatId|struct FormatId|FIRST_CUSTOM_FORMAT_ID|LEGACY_PEER|to_legacy_u32|legacy_from_u32|register_at|formats\\(|format_overlay\\(|FormatId::Builtin|FormatId::Custom\" quantbook-engine/crates quantbook-engine/ql*" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1554:    the pre-step-6 to_legacy_u32() output. All existing xlsx round-trip
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1562:        `to_legacy_u32().expect("pre-step-6 ...")` panics:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1695:+/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2016:-        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2022:-                a.1.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2030:+        // pre-step-6 expect() on `to_legacy_u32()` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2073:-    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2079:+    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2087:-                    id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2130:+    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2351:+/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2375:-            fid.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2544:        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2550:                a.1.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2592:    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2601:                    id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2805:/bin/zsh -lc "rg -n \"enum FormatId|struct FormatId|FIRST_CUSTOM_FORMAT_ID|LEGACY_PEER|to_legacy_u32|legacy_from_u32|register_at|formats\\(|format_overlay\\(|FormatId::Builtin|FormatId::Custom\" quantbook-engine/crates" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2849:quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:320:    // any to_legacy_u32 hop.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2895:quantbook-engine/crates/ql-storage/src/lib.rs:85:        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2911:quantbook-engine/crates/ql-storage/src/format.rs:66:/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2924:quantbook-engine/crates/ql-storage/src/format.rs:134:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2930:quantbook-engine/crates/ql-storage/src/format.rs:155:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3003:quantbook-engine/crates/ql-storage/src/format.rs:853:    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3004:quantbook-engine/crates/ql-storage/src/format.rs:854:        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3005:quantbook-engine/crates/ql-storage/src/format.rs:855:        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3006:quantbook-engine/crates/ql-storage/src/format.rs:856:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3007:quantbook-engine/crates/ql-storage/src/format.rs:858:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3008:quantbook-engine/crates/ql-storage/src/format.rs:864:    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3010:quantbook-engine/crates/ql-storage/src/format.rs:869:        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3012:quantbook-engine/crates/ql-storage/src/format.rs:890:            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3043:quantbook-engine/crates/ql-storage/src/format.rs:1072:    /// **Codex HIGH-1 closure (step 5 audit):** `register_at` must NOT
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3055:quantbook-engine/crates/ql-storage/src/format.rs:1113:    /// **Codex HIGH-2 closure (step 5 audit):** `register_at` must reject
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3069:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:101:/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3086:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:424:        // pre-step-6 expect() on `to_legacy_u32()` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3090:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:468:    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3092:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:514:    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3093:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1125:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3095:quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3097:quantbook-engine/crates/ql-io/src/qbook_format.rs:172:///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3107:quantbook-engine/crates/ql-io/src/qbook_format.rs:1220:                        // pre-step-5 hit the to_legacy_u32().expect() panic).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3111:quantbook-engine/crates/ql-io/src/qbook_format.rs:1311:                    // `id.to_legacy_u32().expect(...)` which would have
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3121:quantbook-engine/crates/ql-io/src/qbook_format.rs:3150:            id_a.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3123:quantbook-engine/crates/ql-io/src/qbook_format.rs:3154:            id_b.to_legacy_u32(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3162:quantbook-engine/crates/ql-io/src/qbook_format.rs:3500:    /// `to_legacy_u32().expect(...)` would have panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3233:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:65:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3237:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:117:                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3244:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:244:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3263:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:267:        // has no peer-id concept to recover. So to_legacy_u32() still
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3264:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:272:                id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3299:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1024:    // sees only LEGACY_PEER customs, so to_legacy_u32 succeeds).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3300:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1025:    let fmt_a_n = fmt_a.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3301:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    let fmt_b_n = fmt_b.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3302:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1027:    let fmt_c_n = fmt_c.to_legacy_u32().unwrap();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3317:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1773:    // xlsx export's `to_legacy_u32().expect(...)` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3323:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1812:    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3333:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1896:    // to the pre-step-6 to_legacy_u32() output. We verify by running
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3408://! (used by qbook envelope loader in step 5 and xlsx import in step 6).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3444:/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3492:    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3512:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3533:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3801:        // Phase 5.2 D-1 step 5 audit Codex HIGH-1 + HIGH-2 closure
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4380:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4389:    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4465:    // xlsx export's `to_legacy_u32().expect(...)` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4504:    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4588:    // to the pre-step-6 to_legacy_u32() output. We verify by running
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4682:        // has no peer-id concept to recover. So to_legacy_u32() still
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4687:                id.to_legacy_u32()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6058:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6076:            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6160:                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6265:    // explicitly so step 5+ callers can rely on it.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7017:   101	/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7146:   468	    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7192:   514	    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7211:  1125	/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7332:   134	    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7366:  1773	    // xlsx export's `to_legacy_u32().expect(...)` panicked on
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7405:  1812	    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7460:  1896	    // to the pre-step-6 to_legacy_u32() output. We verify by running
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:19:| **HIGH-1**: Two peers concurrently rename DIFFERENT sheets to SAME target → `SheetRenameRejected` hard-fails replay. Same blast radius as the bug step 2 was meant to fix. | HIGH | HIGH-1 | D-2-style auto-disambiguation: catch `SheetNameError::Duplicate`, walk suffixes `X(2)`, `X(3)`, etc. up to `AUTO_RENAME_CEILING = 10_000`. New test `step2_audit_concurrent_rename_to_same_target_auto_disambiguates`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:28:| `SheetRenameNameMismatch` could use `#[deprecated]` | LOW | Added `#[deprecated]` attribute. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:43:- Production code (`ql_collab::CollabSession`) doesn't match `SheetRenameNameMismatch` — ABI-safe.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:63:The 4-cycle divergent-HIGH pattern (D-1 steps 5/6/7 + 5.3 step 1) extends to 5.3 step 2. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 3 + step 4 + step 5 megaudit) should expect the same.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:71:- **Step 5 megaudit**: should explicitly probe the empty new_name edge case + reserved-character paths in the wire-format-only producer scenario.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:20:**L1 — `FIRST_XLSX_BUILTIN_MAX` not `pub`.** wire.rs:295 keeps the const file-private. Step 5 (qbook envelope loader) and step 6 (xlsx export at `umya_export.rs`) both will want a shared boundary value. Two options: (a) export `pub const FIRST_XLSX_BUILTIN_MAX` (or `FIRST_XLSX_CUSTOM_NUMFMT = 164`) from `ql_oplog::wire`, OR (b) defer — duplicate the const in step 5/6 callers and audit then. Either works; (a) is mildly cleaner because the d-1-checklist already names `FIRST_XLSX_CUSTOM_NUMFMT` as a shared concept. Not blocking step 3 (step 3 has no use for this constant).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:26:**L4 — `LEGACY_PEER` rationale doc-only.** `LEGACY_PEER = PeerId(0)` collision-freedom guarantee depends on `peer_id != 0` being enforced for active peers (peer.rs:99-105 documents this; Phase 5.2.b is named as the enforcement spot). Step 2 does not add a runtime assertion. Step 4 / step 5 should add a `debug_assert_ne!(peer_id.as_u64(), 0)` at `OpLog::set_peer_id` if not already present, to make the legacy-collision invariant tooled. Not a step-2 issue.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:34:- No arithmetic on `Op::RegisterFormat.id: u32` or `Op::SetCellFormat.id: Option<u32>` in replay (replay.rs:497-540) or producer (formats.rs:41-114) — only `==` / `lookup` lookups + `>= FIRST_CUSTOM_FORMAT_ID` filter at save (qbook_format.rs:1179). Step 4 swap is a clean signature change at these sites; step 5 reads the filter through `from_u32_legacy`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:47:The M1 `deny_unknown_fields` gap is worth fixing this cycle (single-line annotation) because step 4 puts `FormatIdWire` on the wire and silent acceptance of extra fields is exactly the soft failure the global no-fallbacks rule forbids. M2 (test name) is a one-line cosmetic fix. L1-L4 are deferrable to step 3 / step 4 / step 5 closures as their consumers materialize.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-opus-b.md:28:Intro says "Steps 1-4 of 8 shipped; steps 5-8 pending. ... currently step 5. Per-step audit transcripts: ... step-{1..4}-..." — but body shows steps 1-7 SHIPPED + step 8 pending. Fresh sessions reading this would start at step 5 thinking it's NEXT (it's done).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-consolidated.md:74:3. Workspace-wide grep for remaining `to_legacy_u32().expect()` / pre-D-1 patterns: largely done in steps 5+6 closures; verify.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-consolidated.md:82:| Step 5 audit | 2 | 0 (PASS) | DIVERGENT |
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-codex.md:131:**Detail:** The audit rule says run Codex and separate Opus after each coherent unit of work and reconcile HIGH/MEDIUM findings, taking the higher severity on conflicts. The design audits after Step 2 and then combines Steps 4+5. Step 1 is infrastructure-only but is the highest architectural-risk commit; Step 4 and Step 5 are separate semantic surfaces and should not wait for a combined phase-end audit.
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-codex.md:133:**Recommendation:** Require parallel Codex+Opus after Step 1, Step 2, Step 4, and Step 5, or explicitly combine implementation commits before auditing. The status line should also say that each ship commit follows the parallel-audit rule, not only the phase closure.
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-codex.md:149:**Detail:** The baseline says 193 functions. Step 2 says 193 -> 197, Step 4 says 197 -> 199, Step 5 says 199 -> 200. The acceptance section says "197 -> 200 registered fns (+7 new)", which drops the actual baseline and makes the +7 arithmetic unclear.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:22:Predecessor chain: `9c748474c66` (step 6 doc refresh) → `2ba66ee3710` (step 6 audit closures) → `19f6aa1b008` (step 6 ship — xlsx FormatId↔numFmtId mapping) → step 5 audit closure `30ef2637d6f`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:727:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:49:Step 5 is on the cold-data path (envelope persistence). Forward steps 6 (xlsx) and 7 (oplog.bin magic bytes) depend on this being correct. Migration bugs surface only when loading old `.qbook` files — silent failures here are particularly dangerous.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:758:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:87:1. **Op wire-format break is documented and intentional.** Old `.qbook` saves with `oplog.bin` carrying u32-shaped Op variants will fail to deserialize via serde post-step-4. This is expected per D-1 design (step 5 + step 7 add migration/magic-bytes). Verify: are there any test fixtures or callers that load pre-step-4 oplog.bin blobs? If yes, they're broken now. (Step 5/7 work, not step 4 bug — but worth surfacing.)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1382:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14023:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1383:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14046:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2632:docs/architecture/ide-consumer-contract.md:209:**D-1 (steps 1-6 of 8 shipped 2026-05-19/20, steps 7-8 pending):** `FormatId` is now `enum { Builtin(u32), Custom(PeerId, u32) }` in `ql-storage::format` (was `struct FormatId(pub u32)` pre-D-1). IDE callers MUST pattern-match the variant rather than reading `.0`. Use `FormatId::is_builtin()` / `is_custom()` / `GENERAL` accessors. For pre-D-1 bare-u32 ids (xlsx import), use `FormatId::legacy_from_u32(n)` migration helper (n ≤ 163 → Builtin; n ≥ 164 → Custom(LEGACY_PEER, n - 164)). `Op::RegisterFormat` + `Op::SetCellFormat` carry `FormatIdWire` on the wire. `.qbook` envelope v8 (step 5 `2ae5bfcab28`) carries the tagged-tuple `FormatEntryId` shape losslessly for multi-peer ids; v<8 envelopes auto-migrate at load via untagged-enum dispatch. Step-5 audit closure (`30ef2637d6f`) added `FormatTableError::CounterOverflow` + `BuiltinOutOfRange` variants — `register_at` fails loudly on `Builtin(>163)` or counter-at-u32::MAX inputs. xlsx export (step 6 `19f6aa1b008` + audit `2ba66ee3710`) flattens multi-peer FormatIds via dedup-by-code (cross-peer same string → one numFmtId); LEGACY_PEER counters preserve `c + 164` for byte-stability; non-LEGACY peer flattens reported via `XlsxExportReport.dropped_features`. Strict mode removes lossy file on failure (NewWorkbook + UpdateOriginal). Step 7 (oplog.bin magic bytes) + step 8 (megaudit) remain.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2905:docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:49:Step 5 is on the cold-data path (envelope persistence). Forward steps 6 (xlsx) and 7 (oplog.bin magic bytes) depend on this being correct. Migration bugs surface only when loading old `.qbook` files — silent failures here are particularly dangerous.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3117:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:87:1. **Op wire-format break is documented and intentional.** Old `.qbook` saves with `oplog.bin` carrying u32-shaped Op variants will fail to deserialize via serde post-step-4. This is expected per D-1 design (step 5 + step 7 add migration/magic-bytes). Verify: are there any test fixtures or callers that load pre-step-4 oplog.bin blobs? If yes, they're broken now. (Step 5/7 work, not step 4 bug — but worth surfacing.)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3741:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14023:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3742:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14046:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:5581:crates/ql-io/src/qbook_format.rs:639:    /// **Step 5 migration contract:** this is the ONLY conversion needed
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:5727:crates/ql-storage/src/format.rs:155:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10851:   126	    /// (step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11057:docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md:113:- LEGACY_PEER migration path (`legacy_from_u32` + `to_legacy_u32`) audited and clean.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11059:docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md:118:3. Drop the `to_legacy_u32().expect()` sites in qbook_format save path (envelope now carries FormatIdWire directly).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11085:docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:291:/bin/zsh -lc "rg -n \"FormatEntryId|FormatEntry|FormatOverlayEntry|WORKBOOK_SCHEMA_VERSION|MalformedFormat|ReplayError::FormatNotRegistered|FormatIdWire|legacy_from_u32|to_legacy_u32|LEGACY_PEER|struct FormatId|enum FormatId\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11162:docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:404:quantbook-engine/crates/ql-storage/src/format.rs:155:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11284:docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2285:+    /// **Step 5 ordering test:** verify untagged enum dispatch is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11323:docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3878:  3532	    /// **Step 5 ordering test:** verify untagged enum dispatch is
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11332:docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:4064:   155	/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11425:docs/audits/2026-05-20-phase-5-2-d-1-step-5-opus.md:9:Step 5 is **structurally correct and ships a sound migration path**. The four hardest invariants — untagged variant order, save-side determinism, multi-peer round-trip, and forward-compat — are all correct in the code. Hands-on round-trip verification (cross-peer same-string, multi-peer, builtin-in-overlay, 3-entry overlay) all decoded cleanly.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11434:docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:38:- **Forward-readiness for step 5.** Op serializes via serde_json::to_string in log.rs:94, deserializes via serde_json::from_str in log.rs:129. FormatIdWire's tagged serde shape is verified by round_trips_worst_case_through_serde_json. The end-to-end binary export → replay test passes with the new wire shape.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11437:docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:52:Step 5 (qbook envelope schema bump + legacy loader) can build on `FormatIdWire::from_u32_legacy` (step 2 helper) + the lossless `from_storage`/`to_storage` boundary + the now-peer-scoped `FormatTable::register_at` (which won't false-positive collide on legacy-loaded `Custom(LEGACY_PEER, _)` ids).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11448:docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11449:docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:40:- **Disagreement resolution:** Codex correct. Opus saw the d-1-checklist's "step 5 home" framing for LEGACY_PEER and judged that as the natural defer point; Codex looked at the from_u32_legacy helper's birth location and worked back. Going forward, when auditors disagree on deferral, ship the constant — adding earlier is cheap (one const) and removing duplication later is expensive.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11483:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:38:- `ql-exec::workbook_runtime::formats::intern_format` emits `FormatIdWire::from_storage(id)` directly. No more `to_legacy_u32().expect(...)`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11489:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:127:11. **Step 5 will:** bump the .qbook envelope schema version, add a legacy loader that reads pre-step-5 u32 ids and converts via `FormatId::legacy_from_u32`. The current qbook_format.rs save path uses `to_legacy_u32().expect(...)` — still load-bearing because step 5 hasn't bumped the schema yet. Verify the expect() invariant holds: no caller produces non-LEGACY-peer FormatIds today (no production code calls `FormatTable::with_peer(non_LEGACY)` or `set_local_peer(non_LEGACY)`).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11498:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:372:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11505:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:492: /// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11531:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1305:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11624:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2521:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11679:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3337:    **3. Drop legacy_from_u32/to_legacy_u32 expects in oplog paths.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11725:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4488:   155	/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11830:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:7888:/bin/zsh -lc "rg -n \"Op::RegisterFormat|Op::SetCellFormat|RegisterFormat \\{|SetCellFormat \\{|to_storage\\(|to_legacy_u32\\(\\)\\.expect|legacy_from_u32\\(|from_storage\\(|from_u32_legacy\\(\" quantbook-engine/crates" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12018:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8994:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12024:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9005:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:109:14. **Step 4 will:** change `Op::RegisterFormat { id: u32 }` → `Op::RegisterFormat { id: FormatIdWire }`. The producer + replay sites currently use `to_legacy_u32().expect()` / `legacy_from_u32`. Step 4 drops these. Verify the substitution is mechanical (no logic changes needed) for each site.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12054:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9051:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2399:/bin/zsh -lc "rg -n \"RegisterFormat|SetCellFormat|FormatNotRegistered|legacy_from_u32|to_legacy_u32|FormatId::Builtin\\(200\\)|Builtin\\([2-9][0-9][0-9]\\)\" quantbook-engine/crates -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12205:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9802:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12206:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9805:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12207:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9810:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:62:2. **`from_u32_legacy` correctness.** Pre-5.2 used `FIRST_CUSTOM_FORMAT_ID = 164` (matches xlsx's `FIRST_XLSX_CUSTOM_NUMFMT`). Verify by reading `crates/ql-storage/src/format.rs` for the actual constant + checking that step 5's loader will consume `from_u32_legacy(n)` for ALL u32 values present in old `.qbook` files — including the rare cases like `n = u32::MAX` (which step 2 doesn't test). Are there any pre-5.2 u32 values that should be REJECTED rather than mapped (e.g. negative-equivalents wrapping, or reserved values)?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12209:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9812:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:70:6. **Step 5 readiness — `.qbook` envelope.** Read `crates/ql-io/src/qbook_format.rs` (look for `FormatId` or `numFmtId` mentions). How does the current envelope encode cell format ids? Will the step-5 migration call `from_u32_legacy(n)` once per old format-id value at load time?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12272:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10166:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7648:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12293:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10270:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9966:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12294:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10271:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9973:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12382:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11576:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:34:- No arithmetic on `Op::RegisterFormat.id: u32` or `Op::SetCellFormat.id: Option<u32>` in replay (replay.rs:497-540) or producer (formats.rs:41-114) — only `==` / `lookup` lookups + `>= FIRST_CUSTOM_FORMAT_ID` filter at save (qbook_format.rs:1179). Step 4 swap is a clean signature change at these sites; step 5 reads the filter through `from_u32_legacy`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12540:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13440:  - ql-io-xlsx: xlsx import/export uses `legacy_from_u32` / `to_legacy_u32().expect(...)`. Pre-step-6 xlsx sees only LEGACY_PEER.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12554:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14023:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12557:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:14046:Pass checks: `FormatIdWire::from_storage` and `to_storage` are mechanical variant-preserving mappings; replay and `producer_replay_equivalence` both use `to_storage()`. No `to_legacy_u32().expect()` remains in the requested ql-exec / ql-oplog paths. `ql-storage` still does not depend on `ql-oplog`. I found no checked-in `.qbook` / `oplog.bin` fixture files, so the intentional old-op serde break is not currently tripping static fixtures.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12569:docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1519:/bin/zsh -lc "rg -n \"enum FormatId|struct FormatId|FIRST_CUSTOM_FORMAT_ID|LEGACY_PEER|to_legacy_u32|legacy_from_u32|register_at|formats\\(|format_overlay\\(|FormatId::Builtin|FormatId::Custom\" quantbook-engine/crates quantbook-engine/ql*" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12573:docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2805:/bin/zsh -lc "rg -n \"enum FormatId|struct FormatId|FIRST_CUSTOM_FORMAT_ID|LEGACY_PEER|to_legacy_u32|legacy_from_u32|register_at|formats\\(|format_overlay\\(|FormatId::Builtin|FormatId::Custom\" quantbook-engine/crates" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12591:docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2930:quantbook-engine/crates/ql-storage/src/format.rs:155:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12643:docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3533:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12769:docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:14:- `to_legacy_u32(Builtin(200))` returns `Some(200)`, then `legacy_from_u32(200)` returns `Custom(LEGACY_PEER, 36)`. **The "round-trip" is asymmetric**: the storage→u32→storage hop is NOT identity for `Builtin(n)` with n≥164. The `legacy_round_trip_through_helpers` test only validates u32→storage→u32 (the safe direction).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12770:docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:15:- Mitigations are environmental: production code never constructs `Builtin(n)` with n>163 (verified by grep); xlsx import / qbook loader / replay go through `legacy_from_u32` which routes 164+ to Custom. So this is contractual debt, not a live bug, but it can bite in step 4 when an in-memory FormatId crosses the wire boundary and serializes via `to_legacy_u32`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12776:docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:43:- Q13: forward-readiness for step 4. The 5 `to_legacy_u32().expect()` sites in intern_format and set_cell_format will become mechanical drop-ins (`Op::RegisterFormat { id: fid.to_wire() }`). The 5 sites in qbook_format and umya_export are NOT touched by step 4 (they're step 5 and step 6 respectively). Replay's `legacy_from_u32` hop at replay.rs:513 and :536 disappears in step 4 (Op carries FormatIdWire directly; convert via FormatId::from_wire). **No gnarly sites.** `producer_replay_equivalence`'s `apply_producer_side` will need a corresponding update — slightly load-bearing but mechanical.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12867:docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12871:docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12879:docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:34:- No arithmetic on `Op::RegisterFormat.id: u32` or `Op::SetCellFormat.id: Option<u32>` in replay (replay.rs:497-540) or producer (formats.rs:41-114) — only `==` / `lookup` lookups + `>= FIRST_CUSTOM_FORMAT_ID` filter at save (qbook_format.rs:1179). Step 4 swap is a clean signature change at these sites; step 5 reads the filter through `from_u32_legacy`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12882:docs/audits/2026-05-19-phase-5-2-d-1-step-2-opus.md:47:The M1 `deny_unknown_fields` gap is worth fixing this cycle (single-line annotation) because step 4 puts `FormatIdWire` on the wire and silent acceptance of extra fields is exactly the soft failure the global no-fallbacks rule forbids. M2 (test name) is a one-line cosmetic fix. L1-L4 are deferrable to step 3 / step 4 / step 5 closures as their consumers materialize.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12889:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:71:1. **`legacy_from_u32` ↔ `to_legacy_u32` round-trip.** For all u32 `n`, `FormatId::legacy_from_u32(n).to_legacy_u32() == Some(n)`. Test `legacy_round_trip_through_helpers` at format.rs covers some — verify ALL `u32` values: 0, 1, 163, 164, 165, u32::MAX. Pin via tests.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12896:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:109:14. **Step 4 will:** change `Op::RegisterFormat { id: u32 }` → `Op::RegisterFormat { id: FormatIdWire }`. The producer + replay sites currently use `to_legacy_u32().expect()` / `legacy_from_u32`. Step 4 drops these. Verify the substitution is mechanical (no logic changes needed) for each site.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12900:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:299:    - FormatId::to_legacy_u32(): inverse of legacy_from_u32. Returns
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:12916:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:596:   144	/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13041:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2399:/bin/zsh -lc "rg -n \"RegisterFormat|SetCellFormat|FormatNotRegistered|legacy_from_u32|to_legacy_u32|FormatId::Builtin\\(200\\)|Builtin\\([2-9][0-9][0-9]\\)\" quantbook-engine/crates -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13117:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2496:quantbook-engine/crates/ql-storage/src/format.rs:144:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13220:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6439:Detail: `legacy_from_u32(u32::MAX).to_legacy_u32()` should round-trip, but the current test stops at `10_000`. Also consider checked arithmetic for arbitrary `Custom(LEGACY_PEER, c)` and `register_at(Custom(local, c))` at `u32::MAX`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13221:docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:6467:Detail: `legacy_from_u32(u32::MAX).to_legacy_u32()` should round-trip, but the current test stops at `10_000`. Also consider checked arithmetic for arbitrary `Custom(LEGACY_PEER, c)` and `register_at(Custom(local, c))` at `u32::MAX`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13301:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:62:2. **`from_u32_legacy` correctness.** Pre-5.2 used `FIRST_CUSTOM_FORMAT_ID = 164` (matches xlsx's `FIRST_XLSX_CUSTOM_NUMFMT`). Verify by reading `crates/ql-storage/src/format.rs` for the actual constant + checking that step 5's loader will consume `from_u32_legacy(n)` for ALL u32 values present in old `.qbook` files — including the rare cases like `n = u32::MAX` (which step 2 doesn't test). Are there any pre-5.2 u32 values that should be REJECTED rather than mapped (e.g. negative-equivalents wrapping, or reserved values)?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13304:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:70:6. **Step 5 readiness — `.qbook` envelope.** Read `crates/ql-io/src/qbook_format.rs` (look for `FormatId` or `numFmtId` mentions). How does the current envelope encode cell format ids? Will the step-5 migration call `from_u32_legacy(n)` once per old format-id value at load time?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13475:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7648:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:39:- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13530:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9966:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5720:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13534:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9973:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5764:Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13647:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14099:PASS on const placement. Keep `FIRST_XLSX_BUILTIN_MAX` private here; step 5 should call `from_u32_legacy`, not duplicate `163`. A public xlsx boundary constant belongs with storage/xlsx mapping, not `ql_oplog::wire`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13653:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14130:PASS on const placement. Keep `FIRST_XLSX_BUILTIN_MAX` private here; step 5 should call `from_u32_legacy`, not duplicate `163`. A public xlsx boundary constant belongs with storage/xlsx mapping, not `ql_oplog::wire`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13708:docs/audits/2026-05-19-phase-5-2-d-1-step-3-consolidated.md:47:- The enum has no type-level guard preventing `FormatId::Builtin(200)`. Tests at format.rs:502+555 (pre-closure) actively used `Builtin(200)`. Consequences: `to_legacy_u32(Builtin(200))` returns `Some(200)`, but `legacy_from_u32(200)` returns `Custom(LEGACY_PEER, 36)`. The round-trip is ASYMMETRIC in the storage→u32→storage direction for misused Builtin values.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13710:docs/audits/2026-05-19-phase-5-2-d-1-step-3-consolidated.md:61:- **Closure (this commit):** accept Codex's defer recommendation. The expect()s are documented as load-bearing; step 4 will drop the Op-path expect()s by changing Op to FormatIdWire. Step 5 will drop the qbook-envelope expect()s. Step 6 will drop the xlsx-export expect()s.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13715:docs/audits/2026-05-19-phase-5-2-d-1-step-3-consolidated.md:119:3. Drop the `legacy_from_u32 / to_legacy_u32().expect()` conversions in producer + replay paths.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13945:    /// (step 5).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md:17:**Second DIVERGENT-HIGH cycle of the session** (after step 3 audit). Codex found 1 HIGH; Opus PASSED with 0 HIGH. As at step 3, the divergence WAS the finding — Codex's HIGH was a forward-activating bug that Opus's "passes for now" framing would have shipped to step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md:107:Step 5 (qbook envelope schema bump + legacy loader) starts on solid foundation:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md:113:- LEGACY_PEER migration path (`legacy_from_u32` + `to_legacy_u32`) audited and clean.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md:115:Step 5 scope:
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md:118:3. Drop the `to_legacy_u32().expect()` sites in qbook_format save path (envelope now carries FormatIdWire directly).
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-opus.md:447:**Where:** Design § 6 Step 5 final, § 9 "197 → 200 registered fns (+7 new)."
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-opus.md:449:**Detail.** Step 2 ends at 197 (4 fns added). Step 4 ends at 199 (+2). Step 5 ends at 200 (+1). Total +7 from 193: 193 + 7 = **200**. So the final count is correct: 200, not 200 (197 → 200 in Step 5 is technically +3, but Step 4 has already added 2 to reach 199 before Step 5's +1).
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-opus.md:451:Re-checking: Step 2 says "193 → 197 (+4)". Wait, Steps 1-2 doesn't say 193 — let me re-read design. § 6 Step 2: *"Bump `default_registry_has_expected_count` (193 → 197)."* — that's the test count bump after Step 2 (adding ROW/COLUMN/ROWS/COLUMNS = 4 fns). Step 4: *"197 → 199. Update matrix."* — adding ISREF/ISFORMULA = 2 fns. Step 5: *"199 → 200. Update matrix."* — adding FORMULATEXT = 1 fn. Total: 4+2+1 = 7 ✓.
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-opus.md:592:**Recommendation.** Renumber: Step 3 → "Step 2.A: Parallel Codex + Opus audit on Step 2". Step 5 → "Step 4.A: Parallel Codex + Opus audit on Steps 3+4". This makes the closure-as-suffix pattern explicit, matching prior session conventions.
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-opus.md:627:The design does NOT, however, commit to audit-on-EACH-commit; it bundles Steps 4 + 5 into one audit cycle. Per the rule's "after each ship commit" wording, the design should audit after Step 4 AND after Step 5 separately. Step 5 introduces source-text retention (FORMULATEXT-specific) — a distinct architectural surface from Step 4's information-fn batch. Bundling them risks one audit cycle missing the source-text retention nuances.
quantbook-engine/docs/audits/2026-05-17-reference-tier-design-opus.md:629:**Recommendation.** Split Step 6 into Step 4.A (audit Step 4 only) and Step 5.A (audit Step 5 only). 3 audit cycles total. Slight overhead but tighter coverage.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:411:   116	### Step 5: Backwards-compat in `qbook_format` (2-3 hours)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:436:   141	**Estimated total: 10-14 hours = ~2 working days.** Step 5 (backwards-compat) is the riskiest; allocate time for old `.qbook` fixture tests.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1643:   590	**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5702:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11497:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:528:docs/audits/2026-05-19-handoff-audit-consolidated.md:37:| M-1 | `current_work.md` step 5 lists D-2/D-3/D-4 as pending | Opus | ✅ FIXED in rewrite |
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:392:### MEDIUM-S3-O-5 — No e2e test for `=ISFORMULA(@A1:A10)` implicit-intersection narrowing — design § 7 cross-fn coverage matrix calls this out and it's listed in Phase 3 as part of ISFORMULA coverage; the binder's implicit-intersection narrowing of `@RangeRef` produces a single-cell CellRef, which the ISFORMULA Eager materializer consumes via the CellRef arm. Step 5 (cross-cutting suite) is the documented home for this — but Step 5 has no plan-checklist line specifically enumerating it.
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:409:**Recommendation:** Add to Step 5 cross-cutting suite (per the deferral pattern from Step 2 S2-HIGH-1):
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:427:**Severity rationale:** MEDIUM because (a) the plan checklist enumerates this but doesn't specify which step owns it (Step 3 or Step 5); (b) the design § 7 cross-fn matrix lists implicit-intersection coverage explicitly; (c) the path is structurally complete but unexercised — first regression would be invisible. Same pattern as Step 2 S2-HIGH-1's structured-ref deferral.
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:431:### MEDIUM-S3-O-6 — No test for `ISFORMULA(<structured-ref>)`. The S1-HIGH-B / S2-HIGH-1 deferral of structured-ref tests to Step 5 doesn't fully apply to ISFORMULA — the eager-materializer's StructuredRef arm narrows via `narrow_structured_ref`, which behaves differently for `Sales[@Col]` (single-cell after narrowing) vs `Sales[Col]` (full column). ISFORMULA's single-cell path should query `is_formula_at`, multi-cell should return `#N/A`. The current impl is correct but unverified.
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:444:The deferral in S2-HIGH-1 (structured-ref to Step 5 cross-cutting) is explicit, but the Step 3 ISFORMULA tests don't acknowledge this is deferred. The coverage entry says "covered by reference_fns unit tests (NoOpReferenceQuery FALSE path + arity + multi-cell #N/A + non-reference #N/A + error propagation) + ql-exec workbook-runtime e2e ..." — no mention of structured-ref deferral.
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:450:2. Update the EXPLICITLY_DEFERRED entry to mention structured-ref coverage is deferred to Step 5.
quantbook-engine/docs/audits/2026-05-17-reference-tier-pre-review-summary.md:125:**MEDIUM-ι — Audit-discipline applied per-ship-commit, not per-batch.** (Codex MEDIUM-7 ↔ Opus audit-discipline self-application note.) v2 § 6 splits Step 6 into Step 4.A + Step 5.A. 3 audit cycles total (Step 1.A infrastructure-audit, Step 2.A range-fn-batch, Step 4.A info-fn-batch, Step 5.A FORMULATEXT). Step 1.A is the highest architectural-risk audit and MUST run before any user-facing fn is registered.
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:145:| **S2-HIGH-1** | Coverage gaps: named-range, cross-sheet, formula-cell `=ROW()`, structured-ref | Add named-range + cross-sheet + WorkbookRuntime formula-cell tests in Step 2.1; defer structured-ref + implicit-intersection (`@ROW(A1:A10)`) to Step 5 cross-cutting suite with explicit rationale in plan file. |
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:156:| **S2-MED-δ** | `EXPLICITLY_DEFERRED` coverage notes overclaim | Tighten the reason strings — say "reference-aware fn (W5-RT-2); covered by reference_fns unit tests (anchor / range / array literal / error propagation / arity / non-reference) + e2e dispatch tests; matrix N/A. Cross-sheet + named-range coverage in S2.1 closure tests; structured-ref in Step 5 cross-cutting suite." |
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:283:Most Opus LOWs (test naming, ABI doc updates to design § 5, R1C1-mode caveat, etc.) deferred to post-mini-phase polish or Step 5/6 closure. Tracked.
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:80:- `crates/ql-oplog/src/replay.rs` — rename-sheet replay 3-case reconciliation, scoped-SetName routing, `ReplayError::SheetRenameNameMismatch` + `SheetRenameRejected`.
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5405:    91	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:6015:   128	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:6233:   346	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9274:   937	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3643:95:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-opus.md:14:Step 2 correctly closes the original hard-fail (same-sheet, different-target case) and the 5 tests pin convergence cleanly. fmt + clippy clean; `let _ = old_name;` is idiomatic and produces no clippy warning. The variant-keep-for-ABI choice is sound — verified no production code matches `SheetRenameNameMismatch`. Undo path doesn't emit RenameSheet (Loro's UndoManager retracts the visible LoroList entry; no counter-op), so no undo regression. The qbook envelope load path doesn't directly invoke `replay_into` on a RenameSheet stream, so no loader regression. However, I found one HIGH the commit message incorrectly characterizes as "the right behavior" and several test-coverage gaps.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-opus.md:101:- Production code (`CollabSession`) doesn't match `SheetRenameNameMismatch` anywhere.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-consolidated.md:47:- The enum has no type-level guard preventing `FormatId::Builtin(200)`. Tests at format.rs:502+555 (pre-closure) actively used `Builtin(200)`. Consequences: `to_legacy_u32(Builtin(200))` returns `Some(200)`, but `legacy_from_u32(200)` returns `Custom(LEGACY_PEER, 36)`. The round-trip is ASYMMETRIC in the storage→u32→storage direction for misused Builtin values.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-consolidated.md:60:- `FormatTable::with_peer(non_LEGACY)` + `set_local_peer(non_LEGACY)` are public. A test or future code that uses them WITHOUT step 4's full wiring would panic at the 5 `to_legacy_u32().expect()` sites. Codex's recommendation: "defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx."
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-consolidated.md:61:- **Closure (this commit):** accept Codex's defer recommendation. The expect()s are documented as load-bearing; step 4 will drop the Op-path expect()s by changing Op to FormatIdWire. Step 5 will drop the qbook-envelope expect()s. Step 6 will drop the xlsx-export expect()s.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-consolidated.md:119:3. Drop the `legacy_from_u32 / to_legacy_u32().expect()` conversions in producer + replay paths.
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1542:129:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2649:443:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1276:crates/ql-exec/src/workbook_runtime.rs:93:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4801:crates/ql-exec/src/workbook_runtime.rs:93:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-17-rt-step-2-codex.md:151:Tighten the coverage note to avoid implying every listed class is covered for every function. If the missing classes are intentionally deferred to Step 5, say that explicitly and add the runtime-backed tests recommended above.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:56:The 3-cycle divergent-HIGH pattern from D-1 (steps 5, 6, 7) extended into Phase 5.3 step 1. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 2 + step 3 + step 4 + step 5 megaudit) should expect the same: parallel Codex + Opus, with closure for both, before progressing.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-opus.md:38:**DEFERRED**: out of step 4 scope. Documented as V1 limitation; step 5 megaudit or follow-up will close.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-opus.md:54:**DEFERRED**: Architectural inconsistency, not a bug. Picking one policy is a design discussion for step 5 megaudit.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-opus.md:78:Step 4 successfully extends the step-2 RenameSheet algorithm to RenameTable/RenameColumn replay (advisory-skip + safety guard) and adds `repair_table_rename_chain`. The audit caught that the auto-disambig + repair interaction was silently corrupting formulas (HIGH-1) and that column repair was missing (HIGH-2). Both HIGHs closed by REVERTING auto-disambig and documenting the cross-source target collision as a V1 limitation. The four MEDIUM findings are split: M-2 closed (dead state removed), M-4 closed (test added), M-1 + M-3 deferred to step 5 megaudit. The pragmatic revert preserves step 4's primary closure (Opus step 1 audit M-2: rename hard-fail on missing source) while avoiding the silent-corruption HIGHs.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:7:## HIGH (blocks step 5)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:15:## LOW (polish — defer to step 5/6/8)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:33:- **No remaining `.expect()` in oplog producer/replay paths.** Workspace grep for `to_legacy_u32` shows only `qbook_format.rs` (step 5 work), `umya_export.rs` (step 6 work), test assertions. Zero `.expect()` chains remain in producer/replay code.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:38:- **Forward-readiness for step 5.** Op serializes via serde_json::to_string in log.rs:94, deserializes via serde_json::from_str in log.rs:129. FormatIdWire's tagged serde shape is verified by round_trips_worst_case_through_serde_json. The end-to-end binary export → replay test passes with the new wire shape.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:46:**PASS — proceed to step 5.**
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:50:M1 is a docs-polish item for step 7's commit, not a code bug. L1-L5 are deferred-to-step-8 polish, none of which would surface in step 5's qbook envelope migration work. Step 4 is the structural pivot the rest of D-1 builds on; the foundation it lays is correct.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:52:Step 5 (qbook envelope schema bump + legacy loader) can build on `FormatIdWire::from_u32_legacy` (step 2 helper) + the lossless `from_storage`/`to_storage` boundary + the now-peer-scoped `FormatTable::register_at` (which won't false-positive collide on legacy-loaded `Custom(LEGACY_PEER, _)` ids).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:39:**Why it matters**: Step 5's megaudit + step 6's exit packet need an unambiguous "what was pinned" baseline. Right now the mapping between "design doc row N" and "test row N" is off-by-one AND incomplete.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:103:Step 1 ships a real load-bearing test suite that catches 7 of the 7 matrix-row properties it intends to catch — but Row 3 is degenerate, the row labeling is off-by-one against the design doc, and the plan understates the step-4 RenameTable/RenameColumn work. The `fork_with_peer` discovery was the right call and is correctly threaded through the 7 main tests. None of the findings block step 2; HIGH-1 should be fixed before step 5's megaudit so the megaudit doesn't have to flag it. MEDIUM-1, MEDIUM-2, and LOW-2 are cheap pre-step-2 cleanups. MEDIUM-3 and LOW-1 are nice-to-haves that can roll into the step 5 megaudit closure.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:14:- `to_legacy_u32(Builtin(200))` returns `Some(200)`, then `legacy_from_u32(200)` returns `Custom(LEGACY_PEER, 36)`. **The "round-trip" is asymmetric**: the storage→u32→storage hop is NOT identity for `Builtin(n)` with n≥164. The `legacy_round_trip_through_helpers` test only validates u32→storage→u32 (the safe direction).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:15:- Mitigations are environmental: production code never constructs `Builtin(n)` with n>163 (verified by grep); xlsx import / qbook loader / replay go through `legacy_from_u32` which routes 164+ to Custom. So this is contractual debt, not a live bug, but it can bite in step 4 when an in-memory FormatId crosses the wire boundary and serializes via `to_legacy_u32`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:24:**L2 — Single `expect()` message uses "step-4" wording but actually guards a step-6 invariant in xlsx export.** The 3 xlsx-export expect()s (umya_export.rs:299, 350, 1004) say `"pre-step-6 xlsx export sees only legacy FormatId"`. Consistent. But qbook_format.rs:1120 and :1197 say `"pre-step-4 FormatId must be expressible as legacy u32"` — yet step 4 is the wire-Op-shape change, not the qbook envelope schema bump (step 5). The qbook envelope wording should say "pre-step-5". Cosmetic; defer to step 5.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:36:- Q6: 5 `to_legacy_u32().expect()` sites enumerated (1 in intern_format, 1 in set_cell_format, 2 in qbook_format save, 3 in umya_export — sort, custom_formats, cellxfs roster). All 5 safe at step 3: no production caller invokes `FormatTable::with_peer(non_LEGACY)` or `set_local_peer(non_LEGACY)`. Confirmed by `rg`: only `crates/ql-storage/src/format.rs` test module exercises non-LEGACY peers, and those tests don't reach the expect() paths.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-opus.md:43:- Q13: forward-readiness for step 4. The 5 `to_legacy_u32().expect()` sites in intern_format and set_cell_format will become mechanical drop-ins (`Op::RegisterFormat { id: fid.to_wire() }`). The 5 sites in qbook_format and umya_export are NOT touched by step 4 (they're step 5 and step 6 respectively). Replay's `legacy_from_u32` hop at replay.rs:513 and :536 disappears in step 4 (Op carries FormatIdWire directly; convert via FormatId::from_wire). **No gnarly sites.** `producer_replay_equivalence`'s `apply_producer_side` will need a corresponding update — slightly load-bearing but mechanical.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-consolidated.md:52:**L1 (Opus) — `FIRST_XLSX_BUILTIN_MAX` not `pub`.** Defer to step 5/6 when consumers materialize. Either a pub re-export from `ql_oplog::wire` or duplication-then-audit-then is acceptable; the decision needs a real use site, not speculative shape.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-consolidated.md:86:- **Step 5 megaudit**: should explicitly probe the documented "cross-sheet ambiguity" limitation case (when neither historic is current) + production wiring gap.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:78:12. **Helper unification deferred**: TODO inline-documented. Now 3 helpers across 2 crates (repair.rs has 2: sheet + table; sheets.rs has 1: sheet). Will Step 5 megaudit be the right time to unify, or is it ALREADY too painful?
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:198:+///    walk suffixes `X(2)`, `X(3)`, etc. up to `AUTO_RENAME_CEILING`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:205:+    const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:295:+        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:323:+    const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:378:+        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:607:+    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:759:   769	///    walk suffixes `X(2)`, `X(3)`, etc. up to `AUTO_RENAME_CEILING`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:766:   776	    const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:843:   853	        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:871:   881	    const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:924:   934	        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:1307:   355	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:1503:   551	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:2192:   551	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4643:quantbook-engine/crates/ql-oplog/src/replay.rs:608:            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4761:   154	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4890:quantbook-engine/docs/architecture/crdt-data-model.md:329:| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5023:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1191://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5030:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1915:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5192:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1362:/bin/zsh -lc "rg -n \"enum Op|RenameSheet|RenameTable|RenameColumn|DropSheet|DeleteSheet|RemoveSheet|SheetRenameNameMismatch\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5204:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1392:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5211:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1399:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5235:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1426:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5304:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5960:   568	        "PRE-FIX (D-3 V1 limitation): formula references old sheet name → \
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5307:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5991:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5314:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5998:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5323:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6086:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5347:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6557:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5392:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5422:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:103:Step 1 ships a real load-bearing test suite that catches 7 of the 7 matrix-row properties it intends to catch — but Row 3 is degenerate, the row labeling is off-by-one against the design doc, and the plan understates the step-4 RenameTable/RenameColumn work. The `fork_with_peer` discovery was the right call and is correctly threaded through the 7 main tests. None of the findings block step 2; HIGH-1 should be fixed before step 5's megaudit so the megaudit doesn't have to flag it. MEDIUM-1, MEDIUM-2, and LOW-2 are cheap pre-step-2 cleanups. MEDIUM-3 and LOW-1 are nice-to-haves that can roll into the step 5 megaudit closure.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5492:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:19:| **HIGH-1**: Two peers concurrently rename DIFFERENT sheets to SAME target → `SheetRenameRejected` hard-fails replay. Same blast radius as the bug step 2 was meant to fix. | HIGH | HIGH-1 | D-2-style auto-disambiguation: catch `SheetNameError::Duplicate`, walk suffixes `X(2)`, `X(3)`, etc. up to `AUTO_RENAME_CEILING = 10_000`. New test `step2_audit_concurrent_rename_to_same_target_auto_disambiguates`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5535:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5886:   551	            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5909:   574	                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5943:   608	            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5959:   327	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5961:   329	| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5992:   107	### Step 5 — 3-way megaudit (~0.5 day)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6025:quantbook-engine/.plans/_archive/2026-05-17_rt-v1-01-reference-tier-mini-phase.md:89:- [x] Tests: 28 unit + 32 e2e + 13 coverage-extension + 1 registry invariant; covers anchor / range / array literal / non-reference / `#REF!` / LibreOffice cross-checks; named-range + cross-sheet + formula-cell happy-path added in S2-HIGH-1 closure; structured-ref + implicit-intersection deferred to Step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6185:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-opus.md:50:M1 is a docs-polish item for step 7's commit, not a code bug. L1-L5 are deferred-to-step-8 polish, none of which would surface in step 5's qbook envelope migration work. Step 4 is the structural pivot the rest of D-1 builds on; the foundation it lays is correct.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6397:quantbook-engine/docs/audits/2026-05-17-rt-step-2-opus.md:67:- **Single `@ROW(A1:A10)` test** to verify implicit-intersection (or document it as Step 5 cross-cutting coverage per design § Step 5 line 661, with explicit rationale this is intentionally deferred).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6398:quantbook-engine/docs/audits/2026-05-17-rt-step-2-opus.md:69:If deferred to Step 5 (as design § Step 5 cross-cutting suite implies for some), update the plan to amend the Phase 2 checklist to specify which categories are deferred to Step 5 and which are in scope for Step 2.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6429:quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:483:**Detail:** Step 5 lists structured-ref, implicit-intersection, row-limit boundaries, ISREF no-eval, ISFORMULA on blank cell, FORMULATEXT leading-`=`. Step 4 deferred clear_formula transitions (S4-MED-7), named-multi-cell-range FORMULATEXT (S4-MED-8), and `FORMULATEXT(SUM(NamedRange))` (S4-MED-9). These don't appear in Step 5's checklist either.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6505:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6086:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6521:quantbook-engine/docs/audits/2026-05-17-rt-step-2-codex.md:151:Tighten the coverage note to avoid implying every listed class is covered for every function. If the missing classes are intentionally deferred to Step 5, say that explicitly and add the runtime-backed tests recommended above.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6666:quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:283:Most Opus LOWs (test naming, ABI doc updates to design § 5, R1C1-mode caveat, etc.) deferred to post-mini-phase polish or Step 5/6 closure. Tracked.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6854:quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:444:The deferral in S2-HIGH-1 (structured-ref to Step 5 cross-cutting) is explicit, but the Step 3 ISFORMULA tests don't acknowledge this is deferred. The coverage entry says "covered by reference_fns unit tests (NoOpReferenceQuery FALSE path + arity + multi-cell #N/A + non-reference #N/A + error propagation) + ql-exec workbook-runtime e2e ..." — no mention of structured-ref deferral.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6855:quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:450:2. Update the EXPLICITLY_DEFERRED entry to mention structured-ref coverage is deferred to Step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:7205:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-consolidated.md:82:| Step 5 audit | 2 | 0 (PASS) | DIVERGENT — Codex 2 forward bugs + Opus 1 unique MEDIUM |
quantbook-engine/docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:196:**Action:** make `ql_formula_syntax::lexer::MAX_{ROW,COLUMN}` `pub(crate)` (or import from `ql_types` and drop the local declaration). The export is a footgun: a caller importing `MAX_ROW` from `ql_formula_syntax` gets `u32` (subtly compatible but not type-equivalent to the canonical `RowId`).
quantbook-engine/docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:280:- `lex_with` — **not used externally** (`grep -rn "ql_formula_syntax::lex_with\|use ql_formula_syntax::{[^}]*lex_with"` returns zero).
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1320:   129	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1646:   443	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2822:    43	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2368:   322	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:934:   327	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1200:   593	**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1334:   727	   shapes through `to_storage()` (step 5 `2ae5bfcab28`); save path
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1335:   728	   emits Wire directly, dropping pre-step-5 `to_legacy_u32().expect()`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4168:   102	### Step 5 — 3-way megaudit (~0.5 day)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4358:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4491:   276	    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4498:   283	    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4669:   454	            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4676:   461	                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4740:   525	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4758:   543	            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5848:  1633	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7600:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7607:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7671:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7689:            // reserved for envelope-load migration in step 5.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8503:   126	    /// (step 5).

codex
The first grep shows one likely stale committed test comment in the active conflict-matrix probe and a lot of older audit transcript noise. I’m narrowing the searches to active source/docs and excluding historical audit transcripts so the final finding list is actionable.
exec
/bin/zsh -lc 'rg --files quantbook-engine/crates | head -200' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-bindings-node/src/lib.rs
quantbook-engine/crates/ql-bindings-node/Cargo.toml
quantbook-engine/crates/ql-io-ods/src/lib.rs
quantbook-engine/crates/ql-io-ods/Cargo.toml
quantbook-engine/crates/ql-formula-semantics/src/lib.rs
quantbook-engine/crates/ql-formula-semantics/Cargo.toml
quantbook-engine/crates/ql-oplog/Cargo.toml
quantbook-engine/crates/ql-types/src/peer.rs
quantbook-engine/crates/ql-types/src/coercion.rs
quantbook-engine/crates/ql-types/src/eval_context.rs
quantbook-engine/crates/ql-types/src/array.rs
quantbook-engine/crates/ql-types/src/value.rs
quantbook-engine/crates/ql-types/src/date.rs
quantbook-engine/crates/ql-types/src/address.rs
quantbook-engine/crates/ql-types/src/lib.rs
quantbook-engine/crates/ql-types/src/error.rs
quantbook-engine/crates/ql-calcgraph/src/stripes.rs
quantbook-engine/crates/ql-calcgraph/src/stats.rs
quantbook-engine/crates/ql-calcgraph/src/node.rs
quantbook-engine/crates/ql-calcgraph/src/topo.rs
quantbook-engine/crates/ql-calcgraph/src/dirty.rs
quantbook-engine/crates/ql-calcgraph/src/lib.rs
quantbook-engine/crates/ql-calcgraph/src/graph.rs
quantbook-engine/crates/ql-calcgraph/src/fingerprint.rs
quantbook-engine/crates/ql-calcgraph/src/edges.rs
quantbook-engine/crates/ql-oplog/src/replay.rs
quantbook-engine/crates/ql-oplog/src/op.rs
quantbook-engine/crates/ql-oplog/src/wire.rs
quantbook-engine/crates/ql-oplog/src/lib.rs
quantbook-engine/crates/ql-oplog/src/log.rs
quantbook-engine/crates/ql-oplog/src/error.rs
quantbook-engine/crates/ql-calcgraph/benches/region_split_merge.rs
quantbook-engine/crates/ql-calcgraph/benches/prefix_sum_a5.rs
quantbook-engine/crates/ql-calcgraph/benches/dirty_og05.rs
quantbook-engine/crates/ql-calcgraph/Cargo.toml
quantbook-engine/crates/ql-ai/src/lib.rs
quantbook-engine/crates/ql-ai/Cargo.toml
quantbook-engine/crates/ql-storage/src/sheet.rs
quantbook-engine/crates/ql-storage/src/format_overlay.rs
quantbook-engine/crates/ql-storage/src/tables.rs
quantbook-engine/crates/ql-storage/src/column.rs
quantbook-engine/crates/ql-storage/src/workbook.rs
quantbook-engine/crates/ql-storage/src/spill.rs
quantbook-engine/crates/ql-storage/src/overlay.rs
quantbook-engine/crates/ql-storage/src/lib.rs
quantbook-engine/crates/ql-storage/src/format.rs
quantbook-engine/crates/ql-collab/Cargo.toml
quantbook-engine/crates/ql-storage/Cargo.toml
quantbook-engine/crates/ql-collab/src/undo.rs
quantbook-engine/crates/ql-collab/src/repair.rs
quantbook-engine/crates/ql-collab/src/lib.rs
quantbook-engine/crates/ql-collab/src/transport.rs
quantbook-engine/crates/ql-collab/src/presence.rs
quantbook-engine/crates/ql-collab/src/session.rs
quantbook-engine/crates/ql-types/tests/coercion_matrix.rs
quantbook-engine/crates/ql-types/Cargo.toml
quantbook-engine/crates/ql-io/src/qbook_format.rs
quantbook-engine/crates/ql-io/src/lib.rs
quantbook-engine/crates/ql-io/src/oplog_persistence.rs
quantbook-engine/crates/ql-collab/tests/repair_renames.rs
quantbook-engine/crates/ql-collab/tests/repair_tables.rs
quantbook-engine/crates/ql-exec/Cargo.toml
quantbook-engine/crates/ql-bindings-wasm/src/lib.rs
quantbook-engine/crates/ql-bindings-wasm/Cargo.toml
quantbook-engine/crates/ql-bench/src/machine.rs
quantbook-engine/crates/ql-bench/src/report.rs
quantbook-engine/crates/ql-bench/src/synthetic.rs
quantbook-engine/crates/ql-bench/src/lib.rs
quantbook-engine/crates/ql-service/src/lib.rs
quantbook-engine/crates/ql-service/Cargo.toml
quantbook-engine/crates/ql-connectors/src/lib.rs
quantbook-engine/crates/ql-connectors/Cargo.toml
quantbook-engine/crates/ql-bench/Cargo.toml
quantbook-engine/crates/ql-exec/tests/reference_fns_step3_e2e.rs
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs
quantbook-engine/crates/ql-exec/tests/error_precedence.rs
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs
quantbook-engine/crates/ql-exec/tests/distribution_fns_e2e.rs
quantbook-engine/crates/ql-exec/tests/reference_fns_step4_e2e.rs
quantbook-engine/crates/ql-exec/tests/reference_tier_dispatcher_smoke.rs
quantbook-engine/crates/ql-exec/tests/reference_fns_e2e.rs
quantbook-engine/crates/ql-exec/tests/reference_fns_coverage_extensions.rs
quantbook-engine/crates/quantbook-py/src/lib.rs
quantbook-engine/crates/quantbook-py/pyproject.toml
quantbook-engine/crates/ql-io/Cargo.toml
quantbook-engine/crates/ql-bindings-c/src/lib.rs
quantbook-engine/crates/ql-bindings-c/Cargo.toml
quantbook-engine/crates/ql-bench/build.rs
quantbook-engine/crates/ql-functions/Cargo.toml
quantbook-engine/crates/ql-exec/src/lower.rs
quantbook-engine/crates/ql-exec/src/loader.rs
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs
quantbook-engine/crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs
quantbook-engine/crates/ql-exec/src/env.rs
quantbook-engine/crates/ql-exec/src/scalar.rs
quantbook-engine/crates/ql-exec/src/simd.rs
quantbook-engine/crates/ql-exec/src/transaction.rs
quantbook-engine/crates/ql-exec/src/plan_cache.rs
quantbook-engine/crates/ql-exec/src/lib.rs
quantbook-engine/crates/ql-exec/src/eval_result.rs
quantbook-engine/crates/ql-exec/src/plan.rs
quantbook-engine/crates/ql-exec/src/aggregate_cache.rs
quantbook-engine/crates/ql-functions/src/wildcard.rs
quantbook-engine/crates/ql-functions/src/reference_fns.rs
quantbook-engine/crates/ql-terminal/src/lib.rs
quantbook-engine/crates/ql-terminal/Cargo.toml
quantbook-engine/crates/ql-functions/src/scalar_fns.rs
quantbook-engine/crates/ql-functions/src/context_aware_fns.rs
quantbook-engine/crates/ql-functions/src/welford.rs
quantbook-engine/crates/ql-functions/src/registry.rs
quantbook-engine/crates/ql-functions/src/array_returning_fns.rs
quantbook-engine/crates/ql-functions/src/financial_fns.rs
quantbook-engine/crates/ql-sql/src/lib.rs
quantbook-engine/crates/ql-sql/Cargo.toml
quantbook-engine/crates/quantbook-py/Cargo.toml
quantbook-engine/crates/ql-profile/Cargo.toml
quantbook-engine/crates/ql-udf/Cargo.toml
quantbook-engine/crates/ql-formula-syntax/Cargo.toml
quantbook-engine/crates/ql-functions/src/format/parser.rs
quantbook-engine/crates/ql-functions/src/format/lexer.rs
quantbook-engine/crates/ql-functions/src/format/ast.rs
quantbook-engine/crates/ql-functions/src/format/mod.rs
quantbook-engine/crates/ql-functions/src/format/render.rs
quantbook-engine/crates/ql-functions/src/format/error.rs
quantbook-engine/crates/ql-functions/src/format/text_fn.rs
quantbook-engine/crates/ql-functions/src/volatile.rs
quantbook-engine/crates/ql-functions/src/date_fns.rs
quantbook-engine/crates/ql-functions/src/range_aware_fns.rs
quantbook-engine/crates/ql-functions/src/distribution_fns.rs
quantbook-engine/crates/ql-functions/src/range_fns.rs
quantbook-engine/crates/ql-functions/src/reference_aware_fns.rs
quantbook-engine/crates/ql-functions/src/lib.rs
quantbook-engine/crates/ql-io-xlsx/Cargo.toml
quantbook-engine/crates/quantbook-py/python/quantbook/__init__.py
quantbook-engine/crates/ql-io/tests/p412_qbook_corruption_probes.rs
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs
quantbook-engine/crates/ql-exec/benches/og04_scalar_1m.rs
quantbook-engine/crates/ql-exec/benches/og02_mul2.rs
quantbook-engine/crates/ql-exec/benches/og02_chunk_sweep.rs
quantbook-engine/crates/ql-formula-syntax/src/parser.rs
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs
quantbook-engine/crates/ql-formula-syntax/src/ast.rs
quantbook-engine/crates/ql-formula-syntax/src/locale.rs
quantbook-engine/crates/ql-formula-syntax/src/printer.rs
quantbook-engine/crates/ql-formula-syntax/src/lib.rs
quantbook-engine/crates/ql-formula-syntax/src/token.rs
quantbook-engine/crates/ql-udf/src/lib.rs
quantbook-engine/crates/ql-functions/tests/per_function_overrides.rs
quantbook-engine/crates/ql-functions/tests/coverage.rs
quantbook-engine/crates/ql-profile/src/graph_profile.rs
quantbook-engine/crates/ql-profile/src/lib.rs
quantbook-engine/crates/ql-profile/src/timings.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs
quantbook-engine/crates/ql-io-xlsx/src/model.rs
quantbook-engine/crates/ql-io-xlsx/src/report.rs
quantbook-engine/crates/ql-io-xlsx/src/options.rs
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs
quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs
quantbook-engine/crates/ql-io-xlsx/src/error.rs
quantbook-engine/crates/ql-io-xlsx/src/lib.rs
quantbook-engine/crates/ql-io-xlsx/src/read/tables_xml.rs
quantbook-engine/crates/ql-io-xlsx/src/read/cell_styles_xml.rs
quantbook-engine/crates/ql-io-xlsx/src/read/tables_import.rs
quantbook-engine/crates/ql-io-xlsx/src/read/names_import.rs
quantbook-engine/crates/ql-io-xlsx/src/read/calamine_grid.rs
quantbook-engine/crates/ql-io-xlsx/src/read/mod.rs
quantbook-engine/crates/ql-io-xlsx/src/read/sheet_parts.rs
quantbook-engine/crates/ql-io-xlsx/src/read/package.rs
quantbook-engine/crates/ql-io-xlsx/src/read/feature_inventory.rs
quantbook-engine/crates/ql-io-xlsx/src/read/convert.rs
quantbook-engine/crates/ql-io-xlsx/src/read/workbook_xml.rs
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs
quantbook-engine/crates/ql-io-xlsx/src/read/rels.rs
quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_text_edge.rs

exec
/bin/zsh -lc "rg -n \"SheetRenameNameMismatch\" quantbook-engine/crates quantbook-engine/docs -g '*.rs' -g '*.md' -g '"'!docs/audits/**'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:329:| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
quantbook-engine/crates/ql-oplog/src/replay.rs:154:    SheetRenameNameMismatch {
quantbook-engine/crates/ql-oplog/src/replay.rs:1793:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:161:3. Neither → `SheetRenameNameMismatch` error (divergent state).
quantbook-engine/crates/ql-oplog/src/op.rs:109:    /// match the current sheet name (`SheetRenameNameMismatch`); under
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32051:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:101:  of-snapshot)` ; `else → SheetRenameNameMismatch`. Storage failures
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1686:     SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1823:                 Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2298:         assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5389:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5746:   500	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6854:  1608	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1419:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2277:   494	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12051:   489	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9339:   128	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3031:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:5514:    /// match the current sheet name (`SheetRenameNameMismatch`); under
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:40:- `crates/ql-oplog/src/replay.rs` — rename-sheet replay 3-case reconciliation, scoped-SetName routing, `ReplayError::SheetRenameNameMismatch` + `SheetRenameRejected`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:28:Closed the pre-step-2 replay hard-fail at `crates/ql-oplog/src/replay.rs:486-532` (specifically case 3, `SheetRenameNameMismatch`). Discovered during step 1 code survey: under CRDT merge of concurrent renames (peer A: S→S2 + peer B: S→S3 concurrent), the second rename op's `old_name="S"` no longer matches current ("S2") → replay erred → unrecoverable.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:35:- `ReplayError::SheetRenameNameMismatch` variant kept for ABI compat; zero emit sites post-step-2; docstring marks "VARIANT NO LONGER EMITTED."
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:73:7. **`ReplayError::SheetRenameNameMismatch` dead variant.** Should it be `#[deprecated]`? Removed entirely? Kept silently? Pick the right call.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:252:    `SheetRenameNameMismatch`). Discovered during Phase 5.3 step 1 code survey
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:272:    - `ReplayError::SheetRenameNameMismatch` variant kept for ABI compat
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:396:+            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:457:-                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:472:+    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:499:-        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:590:   509	            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:810:+//! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:923:+    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1143:   149	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1362:/bin/zsh -lc "rg -n \"enum Op|RenameSheet|RenameTable|RenameColumn|DropSheet|DeleteSheet|RemoveSheet|SheetRenameNameMismatch\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1365:quantbook-engine/crates/ql-oplog/src/replay.rs:149:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1369:quantbook-engine/crates/ql-oplog/src/replay.rs:509:            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1379:quantbook-engine/crates/ql-oplog/src/replay.rs:1660:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1392:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1399:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:3163:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:3393:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:4692:./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:4753:./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5340:  1660	    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5434:     5	//! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5547:   118	    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5970:/bin/zsh -lc "rg -n \"RenameSheet \\{|old_name.*validation|replay-time validation|SheetRenameNameMismatch|current name matches neither|old_name carried\" quantbook-engine/crates quantbook-engine/docs -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5974:quantbook-engine/crates/ql-oplog/src/replay.rs:149:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5976:quantbook-engine/crates/ql-oplog/src/replay.rs:509:            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5980:quantbook-engine/crates/ql-oplog/src/replay.rs:1660:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5991:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5998:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6010:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1419:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6012:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2277:   494	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6016:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12051:   489	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6017:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:161:3. Neither → `SheetRenameNameMismatch` error (divergent state).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6022:quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9339:   128	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6026:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32051:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6029:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1686:     SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6031:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1823:                 Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6035:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2298:         assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6039:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5389:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6041:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5746:   500	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6045:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6854:  1608	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6049:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:40:- `crates/ql-oplog/src/replay.rs` — rename-sheet replay 3-case reconciliation, scoped-SetName routing, `ReplayError::SheetRenameNameMismatch` + `SheetRenameRejected`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6051:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6724:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6052:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7593:525:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6056:quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:101:  of-snapshot)` ; `else → SheetRenameNameMismatch`. Storage failures
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6069:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6070:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6058:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6075:quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1320:   129	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6077:quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1646:   443	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6085:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6086:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6088:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4358:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6090:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4740:   525	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6094:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5848:  1633	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6107:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7671:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6110:quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1542:129:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6112:quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2649:443:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6115:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5702:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:7077:LOW: `ReplayError::SheetRenameNameMismatch` is okay to keep, but should be actively marked if you want discoverability.  
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:7114:LOW: `ReplayError::SheetRenameNameMismatch` is okay to keep, but should be actively marked if you want discoverability.  
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6724:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7593:525:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4761:   154	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4890:quantbook-engine/docs/architecture/crdt-data-model.md:329:| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5192:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1362:/bin/zsh -lc "rg -n \"enum Op|RenameSheet|RenameTable|RenameColumn|DropSheet|DeleteSheet|RemoveSheet|SheetRenameNameMismatch\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5204:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1392:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5211:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1399:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5307:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5991:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5314:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5998:quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5323:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6086:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5535:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5961:   329	| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:6505:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6086:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:7205:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6058:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1320:   129	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1646:   443	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4358:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4740:   525	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5848:  1633	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7671:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-opus.md:14:Step 2 correctly closes the original hard-fail (same-sheet, different-target case) and the 5 tests pin convergence cleanly. fmt + clippy clean; `let _ = old_name;` is idiomatic and produces no clippy warning. The variant-keep-for-ABI choice is sound — verified no production code matches `SheetRenameNameMismatch`. Undo path doesn't emit RenameSheet (Loro's UndoManager retracts the visible LoroList entry; no counter-op), so no undo regression. The qbook envelope load path doesn't directly invoke `replay_into` on a RenameSheet stream, so no loader regression. However, I found one HIGH the commit message incorrectly characterizes as "the right behavior" and several test-coverage gaps.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-opus.md:101:- Production code (`CollabSession`) doesn't match `SheetRenameNameMismatch` anywhere.
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1542:129:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2649:443:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:28:| `SheetRenameNameMismatch` could use `#[deprecated]` | LOW | Added `#[deprecated]` attribute. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-consolidated.md:43:- Production code (`ql_collab::CollabSession`) doesn't match `SheetRenameNameMismatch` — ABI-safe.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5702:   137	    SheetRenameNameMismatch {

exec
/bin/zsh -lc "rg -n \"to_legacy_u32\" quantbook-engine/crates/ql-oplog quantbook-engine/crates/ql-collab quantbook-engine/crates/ql-exec quantbook-engine/docs/architecture quantbook-engine/docs/phase5 -g '*.rs' -g '*.md' -g '"'!docs/audits/**'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:756:   emits Wire directly, dropping pre-step-5 `to_legacy_u32().expect()`
quantbook-engine/docs/phase5/d-1-starting-checklist.md:118:- ✅ Migration helpers: `FormatId::legacy_from_u32(n)` + `FormatId::to_legacy_u32() -> Option<u32>` (None for non-LEGACY peer Customs).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:124:  - ql-io: qbook envelope save/load uses `to_legacy_u32().expect(...)` + `is_custom()`. Pre-step-5 envelope still u32-shaped.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:125:  - ql-io-xlsx: xlsx import/export uses `legacy_from_u32` / `to_legacy_u32().expect(...)`. Pre-step-6 xlsx sees only LEGACY_PEER.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:138:- ✅ Producer (`ql-exec::workbook_runtime::formats`) + replay (`ql-oplog::replay`) drop the legacy_from_u32/to_legacy_u32 expects.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:159:- ✅ Save path emits `FormatEntryId::from_storage(fid)` directly. Dropped `to_legacy_u32().expect()` panics at 2 sites — v8 envelopes express non-LEGACY peer Custom ids losslessly.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:176:- ✅ 3 `to_legacy_u32().expect("pre-step-6 ...")` panic sites removed from xlsx export.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:65:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:133:                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:260:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:320:    // any to_legacy_u32 hop.

exec
/bin/zsh -lc "rg -n \"AUTO_RENAME_CEILING|\\bX\\(2\\)\\b\" quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-oplog/tests quantbook-engine/crates/ql-collab/tests quantbook-engine/crates/ql-exec/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:465:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/crates/ql-oplog/src/replay.rs:472:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/crates/ql-oplog/src/replay.rs:551:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/crates/ql-oplog/src/replay.rs:574:                        if suffix > AUTO_RENAME_CEILING {

exec
/bin/zsh -lc "rg -n \"PRE-FIX|Phase 5\\.3 step 3 will|FIX coming in step|TODO.*step 5|step 5.*TODO|Step 5.*TODO|TODO.*Step 5\" quantbook-engine/crates quantbook-engine/docs quantbook-engine/.plans -g '*.rs' -g '*.md' -g '"'!docs/audits/**'"' -g '"'!docs/phase5/d-1-*'"' -g '"'!docs/architecture/2026-*'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1191://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1915:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1426:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5892:   500	// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5894:   502	/// **Conflict-matrix row 7 (PRE-FIX behavior):** peer A renames
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5953:   561	    // **PRE-FIX assertion**: bind fails → #NAME?. After Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5960:   568	        "PRE-FIX (D-3 V1 limitation): formula references old sheet name → \
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5962:   570	         Phase 5.3 step 3 will fix this via rename-repair."
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6557:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:78:12. **Helper unification deferred**: TODO inline-documented. Now 3 helpers across 2 crates (repair.rs has 2: sheet + table; sheets.rs has 1: sheet). Will Step 5 megaudit be the right time to unify, or is it ALREADY too painful?
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5023:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1191://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5030:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:1915:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5235:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1426:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5304:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5960:   568	        "PRE-FIX (D-3 V1 limitation): formula references old sheet name → \
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5347:quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:6557:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:5392:quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/repair.rs | sed -n '1,260p;260,470p;470,720p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '120,190p;430,610p;650,820p;1760,1825p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/op.rs | sed -n '80,130p;130,170p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    80	    ///
    81	    /// Replay: routes to `Workbook::set_name` (scope `None`) or
    82	    /// `Sheet::set_scoped_name` (scope `Some`); reserved-name refusal
    83	    /// surfaces as `ReplayError::NameRejected` in either path. A
    84	    /// `scope: Some(id)` referencing an unknown sheet surfaces as
    85	    /// `ReplayError::InvalidSheet`.
    86	    SetName {
    87	        #[serde(default, skip_serializing_if = "Option::is_none")]
    88	        scope: Option<SheetId>,
    89	        name: String,
    90	        target: NamedTargetWire,
    91	    },
    92	
    93	    /// Create a new sheet. Mirrors `Workbook::add_sheet_with_chunk_rows`.
    94	    /// Sheet IDs are deterministic (the workbook assigns them in append
    95	    /// order); the producer doesn't pin the ID in the op, since replay
    96	    /// against an empty workbook produces the same sequence.
    97	    AddSheet { name: String, chunk_rows: u32 },
    98	
    99	    /// **W5-91 (Phase 4.6.C):** rename an existing sheet by id. Mirrors
   100	    /// `Workbook::rename_sheet`. Per design doc § 3.1, the producer-side
   101	    /// runtime rewrites all stored formula text BEFORE emitting this op
   102	    /// (and emits `Op::PutFormula` ops for each rewritten cell in the
   103	    /// same `BatchCommit`), so replay-on-top-of-snapshot OR replay-from-
   104	    /// empty both produce correct state.
   105	    ///
   106	    /// **Phase 5.3 step 2 audit closure (Codex MEDIUM-2, 2026-05-20):**
   107	    /// `old_name` is now ADVISORY at replay time, not validated. Pre-
   108	    /// step-2 the replay handler rejected ops whose `old_name` didn't
   109	    /// match the current sheet name (`SheetRenameNameMismatch`); under
   110	    /// CRDT merge of concurrent renames the second op's `old_name`
   111	    /// legitimately fails to match, so the validation was wrong. Post-
   112	    /// step-2 the replay handler unconditionally renames the sheet at
   113	    /// `id` to `new_name` (with D-2-style auto-disambiguation on
   114	    /// duplicate targets). `old_name` is retained on the wire for:
   115	    ///   - diagnostics in `ReplayError::SheetRenameRejected.old_name`
   116	    ///   - producer-side single-writer log debuggability (the op records
   117	    ///     what the producer's local state was at write time)
   118	    ///   - future re-introduction of strict-mode replay if needed
   119	    ///
   120	    /// **Trade-off**: single-writer malformed logs (`old="Wrong",
   121	    /// new="X"` against current "S") now silently rename "S" → "X"
   122	    /// rather than erroring. The CRDT use case requires this; we
   123	    /// accept the single-writer trade-off because the producer-side
   124	    /// `WorkbookRuntime::rename_sheet` validates locally before
   125	    /// emitting, so a malformed op indicates corruption or a custom
   126	    /// op-log producer that bypassed the runtime.
   127	    RenameSheet {
   128	        id: SheetId,
   129	        old_name: String,
   130	        new_name: String,
   130	        new_name: String,
   131	    },
   132	
   133	    /// Register a format string at a specific id. Mirrors
   134	    /// `FormatTable::register_at`. Emitted when
   135	    /// `WorkbookRuntime::intern_format` allocates a NEW id; idempotent
   136	    /// on replay (re-registering an existing id with the same string
   137	    /// is a no-op). Re-registering at the same id with a DIFFERENT
   138	    /// string fails at `FormatTable::register_at` and surfaces as
   139	    /// `ReplayError::FormatRejected`. Shipped W5-80 (Phase 4.5.D part 4).
   140	    ///
   141	    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from `u32`
   142	    /// to [`crate::wire::FormatIdWire`] (tagged tuple `Builtin(u32)` /
   143	    /// `Custom(PeerId, u32)`). The `from_u32_legacy` migration helper
   144	    /// converts pre-5.2 saves to the new shape at envelope-load time
   145	    /// (step 5).
   146	    RegisterFormat {
   147	        id: crate::wire::FormatIdWire,
   148	        string: String,
   149	    },
   150	
   151	    /// Set or clear a cell's format id. Mirrors
   152	    /// `CellFormatOverlay::set` (when `id` is `Some`) and `::clear`
   153	    /// (when `id` is `None`). The id MUST resolve in the workbook's
   154	    /// `FormatTable` at replay time; an unknown id surfaces as
   155	    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
   156	    ///
   157	    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from
   158	    /// `Option<u32>` to `Option<FormatIdWire>`.
   159	    SetCellFormat {
   160	        sheet: SheetId,
   161	        row: RowId,
   162	        col: ColId,
   163	        /// `None` ⇒ clear the overlay entry (cell falls back to General).
   164	        /// `Some(id)` ⇒ bind the cell to that format id.
   165	        id: Option<crate::wire::FormatIdWire>,
   166	    },
   167	
   168	    /// One transaction's ops applied atomically at replay time. Produced
   169	    /// by `WorkbookTransaction::commit` in 2A.3.b. Replay applies each
   170	    /// inner op in order; on failure, replay reports the inner op's

 succeeded in 0ms:
     1	//! `ql_collab::repair` — Phase 5.3 step 3 rename-repair pass
     2	//! (CORE 5.3 work, 2026-05-20).
     3	//!
     4	//! ## Purpose
     5	//!
     6	//! After merging concurrent ops from peers, formulas authored against
     7	//! pre-rename sheet names may reference names that no longer exist.
     8	//! Pre-step-3 behavior (D-3 V1 limitation): such formulas surface as
     9	//! `BindError::UnknownSheet` → `#NAME?` at recompute time. This module
    10	//! ships the post-merge repair pass that rewrites the formula text
    11	//! in-place via the existing `ql_formula_syntax::rewrite_sheet_name_in_expr`
    12	//! machinery (same one producer-side rename uses for single-writer flows).
    13	//!
    14	//! ## Caller contract
    15	//!
    16	//! `repair_sheet_rename_chain` is **caller-driven**, NOT hooked into
    17	//! `merge_bytes`. Audit-locked design decision D-5.3-1 (see
    18	//! `quantbook-engine/.plans/_active.md`). Typical call sequence:
    19	//!
    20	//! ```text
    21	//! 1. CollabSession::merge_bytes(peer_b_bytes)   // pull peer's ops
    22	//! 2. replay_into(log, &mut workbook, &registry) // apply ops to workbook
    23	//! 3. ql_collab::repair_sheet_rename_chain(&mut workbook, &log)?  // <-- THIS module
    24	//! 4. WorkbookRuntime::recompute_all(...)        // evaluate formulas
    25	//! ```
    26	//!
    27	//! Step 3 is OPTIONAL (replay + recompute work without it), but skipping
    28	//! it means concurrent-edit formulas referencing renamed sheets resolve
    29	//! as `#NAME?`. Production callers in collaborative workflows SHOULD
    30	//! invoke it before recompute; single-writer / qbook-load workflows
    31	//! don't need it (no concurrent renames possible).
    32	//!
    33	//! ## Algorithm (chain-based, NOT causality-aware)
    34	//!
    35	//! Audit-locked design decision D-5.3-2.
    36	//!
    37	//! 1. Walk the op log; for each `Op::RenameSheet { id, old_name, .. }`
    38	//!    (including ops nested in `BatchCommit`), record `old_name` as a
    39	//!    historic name of `id`.
    40	//!
    41	//! 2. For each sheet, build the rewrite rule
    42	//!    `(canonical_historic_name → current_display_name)`. Skip pairs
    43	//!    where the canonical matches the sheet's CURRENT canonical
    44	//!    (no-op). The "current" name is taken from the workbook post-replay
    45	//!    — this captures step-2's auto-disambiguation suffixes (e.g.
    46	//!    a sheet that wanted "X" but ended up "X(2)" rewrites historic
    47	//!    references to "X(2)", not the intended "X").
    48	//!
    49	//! 3. Walk every formula in the workbook via `Workbook::iter_formulas`.
    50	//!    For each, apply rewrites via [`rewrite_formula_with_rename`].
    51	//!    Idempotent: the helper returns `None` when no change applies.
    52	//!    Multiple rewrites may compose (transitive chain S1→S2→S3 produces
    53	//!    rewrites for both S1 and S2 → final name).
    54	//!
    55	//! 4. Apply collected updates via `Workbook::put_formula`.
    56	//!
    57	//! ## Safety guard: skip rules where `old_canonical` is currently held
    58	//!
    59	//! Step 3 audit closure (Codex HIGH-1 + HIGH-2, 2026-05-20). Two
    60	//! formula-corruption scenarios drove the guard:
    61	//!
    62	//! 1. **Cascade through rewritten names** (Codex HIGH-1): base sheets
    63	//!    `A` and `B`. Peer renames `B → C`, then `A → B`. Final: sheet 0
    64	//!    = B, sheet 1 = C. Pre-guard the rules `{A → B, B → C}` would
    65	//!    apply iteratively: formula `A!A1` → `B!A1` (rule 1) → `C!A1`
    66	//!    (rule 2). **Wrong** — the cell ends up referencing sheet 1
    67	//!    when the formula author meant sheet 0 (now named B).
    68	//!
    69	//! 2. **Historic names live forever** (Codex HIGH-2): sheet S
    70	//!    renamed to T. Later, a NEW sheet S is added (after the rename).
    71	//!    A formula `S!A1` written after the new S is added INTENDS the
    72	//!    new S. Pre-guard the historic rule `S → T` would rewrite the
    73	//!    valid current reference to `T!A1`. **Wrong** — corrupts a
    74	//!    valid formula.
    75	//!
    76	//! Closure: **skip rules where `old_canonical` is currently held by
    77	//! ANY sheet in the workbook**. The `ambiguous_skipped` field of
    78	//! `RepairReport` surfaces these for diagnostics (no silent loss —
    79	//! per the no-fallback rule).
    80	//!
    81	//! ## Known limitations (V1, post-step-3 audit closure)
    82	//!
    83	//! - **Cross-sheet historic-name ambiguity** (when neither historic
    84	//!   is currently held): two sheets had the same canonical name at
    85	//!   different chain points, AND neither sheet currently holds that
    86	//!   name. Rules end up in the vec; rule-iteration order picks the
    87	//!   winner (sorted by sheet id, so lowest sheet_id's rule fires
    88	//!   first). Rare; not closed in V1.
    89	//!
    90	//! - **Concurrent-rename intermediate names lost**: if peer A's chain
    91	//!   is S1→S2→S3 with both ops applied in sequence, the intermediate
    92	//!   name "S2" lives in `old_name` of the second op so it IS captured.
    93	//!   But if a concurrent rename forced the second op to apply "from"
    94	//!   a different name (step 2's last-wins policy), the old_name from
    95	//!   the wire may not reflect what current was at apply-time. Formulas
    96	//!   referencing that intermediate name may not be repaired. Mitigation
    97	//!   for future: causality-aware tracking via Loro op-ids (deferred).
    98	//!
    99	//! - **Step 4 extension**: this V1 only handles sheet renames.
   100	//!   `Op::RenameTable` + `Op::RenameColumn` need the same treatment;
   101	//!   step 4 of the Phase 5.3 arc adds them.
   102	
   103	use ql_oplog::{Op, OpLog, OpLogError};
   104	use ql_storage::Workbook;
   105	use ql_types::SheetId;
   106	use std::collections::HashMap;
   107	use std::sync::Arc;
   108	
   109	/// Report returned by [`repair_sheet_rename_chain`]. Caller uses for
   110	/// logging / diagnostics. Per the no-fallback rule (CLAUDE.md), this
   111	/// surfaces *what was done* rather than silently absorbing the work.
   112	#[derive(Debug, Clone, Default)]
   113	pub struct RepairReport {
   114	    /// Total number of formulas whose text was rewritten by the pass.
   115	    pub formulas_rewritten: usize,
   116	
   117	    /// Per-sheet rewrite summary: the sheet id, its final display name
   118	    /// post-replay, and the historic canonical names whose references
   119	    /// were rewritten. Empty if no sheet had a rename.
   120	    pub sheet_rewrites: Vec<SheetRewriteSummary>,
   121	
   122	    /// **Step 3 audit closure (Codex HIGH-1 + HIGH-2, Opus HIGH-1,
   123	    /// 2026-05-20):** rules that were SKIPPED because their
   124	    /// `old_canonical` is currently held by another (or the same)
   125	    /// sheet — applying the rewrite would corrupt formulas that
   126	    /// legitimately reference the current holder. Surfaced for
   127	    /// diagnostics per the no-fallback rule.
   128	    pub ambiguous_rules_skipped: Vec<AmbiguousSkip>,
   129	}
   130	
   131	/// Per-sheet summary line in [`RepairReport`].
   132	#[derive(Debug, Clone)]
   133	pub struct SheetRewriteSummary {
   134	    pub sheet: SheetId,
   135	    pub current_display_name: String,
   136	    /// Historic canonical names from `Op::RenameSheet.old_name`. Sorted
   137	    /// + deduped. Empty iff the sheet had no rename ops in the log.
   138	    pub historic_canonicals: Vec<String>,
   139	}
   140	
   141	/// **Step 3 audit closure entry**: an ambiguous rule the pass refused
   142	/// to apply because doing so would have corrupted a valid current
   143	/// reference. See the safety guard in the module docs.
   144	#[derive(Debug, Clone)]
   145	pub struct AmbiguousSkip {
   146	    /// Sheet id whose chain produced this rule.
   147	    pub origin_sheet: SheetId,
   148	    /// Historic canonical name (the rule's "old" side).
   149	    pub historic_canonical: String,
   150	    /// Sheet id of the current holder of `historic_canonical`. If equal
   151	    /// to `origin_sheet`, the same sheet was renamed away and then back
   152	    /// to its starting name (no-op, normally pruned earlier but recorded
   153	    /// here for completeness).
   154	    pub current_holder_sheet: SheetId,
   155	}
   156	
   157	/// Walk the op log to build a chain of sheet renames, then rewrite
   158	/// every formula in `workbook` whose text references a historic
   159	/// (pre-rename) sheet name. See module docs for the algorithm.
   160	///
   161	/// Returns a [`RepairReport`] describing what was changed. The report
   162	/// is informational; the workbook is mutated in place.
   163	///
   164	/// **Errors**: only propagates `OpLogError` from iterating the op log
   165	/// (e.g., a corrupted Loro `LoroValue::String` that fails serde
   166	/// decode). Formula rewrites that fail to parse are SKIPPED silently
   167	/// (the helper returns `None` on parse failure, preserving the
   168	/// pre-rewrite text). This matches the producer-side helper's
   169	/// behavior and avoids the no-fallback violation that would fire if
   170	/// we returned an error for unparseable formulas (those formulas
   171	/// would already produce parse errors at recompute time — repair
   172	/// doesn't worsen that).
   173	///
   174	/// **Caller-driven**: NOT auto-invoked by `merge_bytes`. See module
   175	/// docs for the expected call sequence.
   176	pub fn repair_sheet_rename_chain(
   177	    workbook: &mut Workbook,
   178	    log: &OpLog,
   179	) -> Result<RepairReport, OpLogError> {
   180	    // ===== Phase 1: walk op log; collect historic old_names per sheet.
   181	    let mut historic_by_sheet: HashMap<SheetId, Vec<String>> = HashMap::new();
   182	    for op_result in log.iter() {
   183	        let op = op_result?;
   184	        collect_rename_old_names(&op, &mut historic_by_sheet);
   185	    }
   186	
   187	    // ===== Phase 2: snapshot current canonical names + their owning
   188	    // sheet ids. Used by the ambiguity guard (step 3 audit closure)
   189	    // to skip rules whose `old_canonical` is currently held by some
   190	    // sheet — applying such a rule would corrupt formulas that
   191	    // legitimately reference the current holder.
   192	    let sheet_count = workbook.sheet_count() as u16;
   193	    let mut canonical_to_current_sheet: HashMap<String, SheetId> = HashMap::new();
   194	    for i in 0..sheet_count {
   195	        if let Some(s) = workbook.sheet(i) {
   196	            canonical_to_current_sheet.insert(Workbook::canonical_sheet_name(s.name()), i);
   197	        }
   198	    }
   199	
   200	    // ===== Phase 3: build (canonical_historic → current_display_name) rules.
   201	    // Skip pairs where canonical historic matches current canonical (no-op)
   202	    // OR where `historic_canonical` is currently held by ANY sheet (would
   203	    // corrupt the current holder's formula refs — Codex+Opus HIGH closure).
   204	    let mut rules: Vec<(String, Arc<str>, SheetId)> = Vec::new();
   205	    let mut sheet_rewrites: Vec<SheetRewriteSummary> = Vec::new();
   206	    let mut ambiguous_rules_skipped: Vec<AmbiguousSkip> = Vec::new();
   207	    let mut sheet_ids: Vec<SheetId> = historic_by_sheet.keys().copied().collect();
   208	    sheet_ids.sort_unstable();
   209	    for sheet_id in sheet_ids {
   210	        let historic = historic_by_sheet
   211	            .get(&sheet_id)
   212	            .cloned()
   213	            .unwrap_or_default();
   214	        let Some(current) = workbook.sheet(sheet_id).map(|s| s.name().to_owned()) else {
   215	            // Sheet ID is in the rename history but doesn't exist in the
   216	            // current workbook. Should not happen for sheet renames (no
   217	            // DropSheet op exists in V1). Defensive skip.
   218	            continue;
   219	        };
   220	        let current_canonical = Workbook::canonical_sheet_name(&current);
   221	        let current_arc: Arc<str> = Arc::from(current.as_str());
   222	
   223	        // Dedupe historic canonicals; skip those matching current canonical
   224	        // (no-op renames).
   225	        let mut historic_canonicals: Vec<String> = historic
   226	            .iter()
   227	            .map(|s| Workbook::canonical_sheet_name(s))
   228	            .filter(|c| c != &current_canonical)
   229	            .collect();
   230	        historic_canonicals.sort();
   231	        historic_canonicals.dedup();
   232	
   233	        for hc in &historic_canonicals {
   234	            // **Audit closure (Codex+Opus HIGH-1 + Codex HIGH-2)**: if
   235	            // `hc` is CURRENTLY held by any sheet, the rule would
   236	            // corrupt that sheet's legitimate formula references.
   237	            // E.g., sheet 0 renamed S→T; sheet 1 added as S afterward;
   238	            // formula `=S!A1` intends sheet 1, not sheet 0. The rule
   239	            // S→T would mis-rewrite it. Skip and report.
   240	            //
   241	            // Symmetric closure of the cascade case (Codex HIGH-1):
   242	            // sheets 0+1 each renamed; sheet 0's chain `B→C, A→B`
   243	            // and sheet 1's chain `S→...`. After all renames, sheet 0
   244	            // is named B. A rule from a DIFFERENT sheet with old=B
   245	            // would cascade-rewrite formulas that legitimately
   246	            // reference sheet 0. The guard catches both.
   247	            if let Some(holder) = canonical_to_current_sheet.get(hc) {
   248	                ambiguous_rules_skipped.push(AmbiguousSkip {
   249	                    origin_sheet: sheet_id,
   250	                    historic_canonical: hc.clone(),
   251	                    current_holder_sheet: *holder,
   252	                });
   253	                continue;
   254	            }
   255	            rules.push((hc.clone(), Arc::clone(&current_arc), sheet_id));
   256	        }
   257	
   258	        sheet_rewrites.push(SheetRewriteSummary {
   259	            sheet: sheet_id,
   260	            current_display_name: current,
   260	            current_display_name: current,
   261	            historic_canonicals,
   262	        });
   263	    }
   264	
   265	    // ===== Phase 4: fast-path no-op when no rules survive.
   266	    // (Audit closure: Opus MEDIUM-2 — empty `rules` should NOT incur
   267	    // the per-formula iteration cost.)
   268	    if rules.is_empty() {
   269	        return Ok(RepairReport {
   270	            formulas_rewritten: 0,
   271	            sheet_rewrites,
   272	            ambiguous_rules_skipped,
   273	        });
   274	    }
   275	
   276	    // ===== Phase 5: walk formulas, collect updates.
   277	    // Two-phase to avoid mut/immut borrow conflict on workbook.
   278	    let mut to_update: Vec<(SheetId, u32, u32, String)> = Vec::new();
   279	    for (sheet, row, col, text) in workbook.iter_formulas() {
   280	        let mut current_text = text.to_string();
   281	        let mut changed = false;
   282	        for (old_canonical, new_name, _origin_sheet) in &rules {
   283	            if let Some(rewritten) =
   284	                rewrite_formula_with_rename(&current_text, old_canonical, new_name)
   285	            {
   286	                current_text = rewritten;
   287	                changed = true;
   288	            }
   289	        }
   290	        if changed {
   291	            to_update.push((sheet, row, col, current_text));
   292	        }
   293	    }
   294	    let rewrite_count = to_update.len();
   295	
   296	    // ===== Phase 6: apply updates.
   297	    for (sheet, row, col, new_text) in to_update {
   298	        workbook.put_formula(sheet, row, col, new_text);
   299	    }
   300	
   301	    Ok(RepairReport {
   302	        formulas_rewritten: rewrite_count,
   303	        sheet_rewrites,
   304	        ambiguous_rules_skipped,
   305	    })
   306	}
   307	
   308	/// Walk an `Op`, including ops nested in `BatchCommit`, and record
   309	/// `RenameSheet.old_name` entries in `historic`. Other op kinds are
   310	/// ignored.
   311	fn collect_rename_old_names(op: &Op, historic: &mut HashMap<SheetId, Vec<String>>) {
   312	    match op {
   313	        Op::RenameSheet { id, old_name, .. } => {
   314	            historic.entry(*id).or_default().push(old_name.clone());
   315	        }
   316	        Op::BatchCommit { ops } => {
   317	            for inner in ops {
   318	                collect_rename_old_names(inner, historic);
   319	            }
   320	        }
   321	        _ => {}
   322	    }
   323	}
   324	
   325	/// Rewrite `text` (formula source) substituting every reference to
   326	/// `old_canonical` (a canonical-uppercase sheet name) with `new_name`
   327	/// (the new display name).
   328	///
   329	/// Mirror of the producer-side helper at
   330	/// `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60`. Kept here
   331	/// because ql-collab has no dep on ql-exec (direction: ql-collab is
   332	/// below ql-exec). Both helpers route through
   333	/// `ql_formula_syntax::{lex, parse, rewrite_sheet_name_in_expr, print}`.
   334	///
   335	/// **TODO (Opus step 3 audit MEDIUM-1, deferred-to-step-4 follow-up)**:
   336	/// promote this + `rewrite_formula_with_table_rename` +
   337	/// `rewrite_formula_with_column_rename` (this module) AND
   338	/// `rewrite_formula_text_for_sheet_rename` (sheets.rs:37-60) AND
   339	/// the inlined table/column rewrites (tables.rs:316-336, 471-490)
   340	/// to a single public helper in `ql-formula-syntax`. All 5+ call
   341	/// sites would converge on one implementation, preventing drift.
   342	/// Deferred to a separate refactor commit to keep step 4 scoped to
   343	/// the audit-locked algorithm + tests.
   344	///
   345	/// Returns `None` when:
   346	/// - The text doesn't lex/parse (formula is malformed — caller should
   347	///   not surface this as an error; recompute will surface it).
   348	/// - The parsed AST doesn't reference `old_canonical` (no rewrite).
   349	fn rewrite_formula_with_rename(
   350	    text: &str,
   351	    old_canonical: &str,
   352	    new_name: &Arc<str>,
   353	) -> Option<String> {
   354	    let stripped = text.strip_prefix('=').unwrap_or(text);
   355	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
   356	    let expr = ql_formula_syntax::parse(tokens).ok()?;
   357	    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
   358	    if rewritten == expr {
   359	        return None;
   360	    }
   361	    let printed = ql_formula_syntax::print(&rewritten);
   362	    let with_eq = if text.starts_with('=') {
   363	        format!("={printed}")
   364	    } else {
   365	        printed
   366	    };
   367	    Some(with_eq)
   368	}
   369	
   370	/// **Phase 5.3 step 4 (2026-05-20):** table-rename analog of
   371	/// [`repair_sheet_rename_chain`]. After a CRDT merge with concurrent
   372	/// table renames, formulas using `T[col]` structured references may
   373	/// reference table names that no longer exist. This pass rewrites
   374	/// the formula text to reference the current table name.
   375	///
   376	/// Algorithm mirrors the sheet version: chain-based, with the same
   377	/// safety guard (skip rules where `old_canonical` is currently held
   378	/// by ANY table — closes the cascade + reused-name corruption cases
   379	/// surfaced in step 3 audit).
   380	///
   381	/// Returns a [`TableRepairReport`] describing what was changed.
   382	///
   383	/// **Caller-driven**: invoke between `replay_into` and `recompute_all`
   384	/// (same call sequence as [`repair_sheet_rename_chain`]).
   385	pub fn repair_table_rename_chain(
   386	    workbook: &mut Workbook,
   387	    log: &OpLog,
   388	) -> Result<TableRepairReport, OpLogError> {
   389	    // Phase 1: collect historic table names from RenameTable ops.
   390	    // Tables are keyed by canonical (uppercase) name, NOT by id —
   391	    // unlike sheets which carry stable IDs. So our "chain" is keyed
   392	    // by NEW canonical name (the current key), with old_name as a
   393	    // value we map back from.
   394	    let mut historic_by_current: HashMap<String, Vec<String>> = HashMap::new();
   395	    // Use causal-order replay to know which historic name maps to
   396	    // which final canonical: walk ops in order, accumulating each
   397	    // hop's old_name under historic_by_current[new_name].
   398	    //
   399	    // **Audit closure (Opus MEDIUM-2):** previously also threaded
   400	    // a `canonical_chain: HashMap<String, String>` through the
   401	    // walker, but its `while let Some(next)` lookup result was
   402	    // never read — pure dead state. Removed.
   403	    for op_result in log.iter() {
   404	        let op = op_result?;
   405	        collect_table_renames(&op, &mut historic_by_current);
   406	    }
   407	
   408	    // Phase 2: snapshot current canonical names.
   409	    let current_table_canonicals: std::collections::HashSet<String> = workbook
   410	        .tables()
   411	        .iter()
   412	        .map(|(name, _)| name.to_ascii_uppercase())
   413	        .collect();
   414	
   415	    // Phase 3: build (canonical_historic -> current_display_name) rules.
   416	    // For each current table, walk its historic chain. Skip rules where
   417	    // the old_canonical is currently held by ANY table (safety guard
   418	    // mirroring step 3 audit closure).
   419	    //
   420	    // **Audit closure (Codex+Opus MEDIUM, 2026-05-20):** sort the
   421	    // current canonicals before iteration for deterministic rule
   422	    // order. HashSet iteration is non-deterministic; both the rules
   423	    // vec and the `table_rewrites` report would otherwise vary across
   424	    // runs.
   425	    let mut rules: Vec<(String, Arc<str>)> = Vec::new();
   426	    let mut table_rewrites: Vec<TableRewriteSummary> = Vec::new();
   427	    let mut ambiguous_rules_skipped: Vec<TableAmbiguousSkip> = Vec::new();
   428	    let mut sorted_current_canonicals: Vec<&String> = current_table_canonicals.iter().collect();
   429	    sorted_current_canonicals.sort();
   430	    for current_canonical in sorted_current_canonicals {
   431	        let Some(historic_set) = historic_by_current.get(current_canonical) else {
   432	            continue;
   433	        };
   434	        // Resolve current display name from the workbook.
   435	        let Some(meta) = workbook.tables().lookup(current_canonical) else {
   436	            continue;
   437	        };
   438	        let current_display: Arc<str> = Arc::clone(&meta.display_name);
   439	        let mut historic_canonicals: Vec<String> = historic_set
   440	            .iter()
   441	            .map(|s| s.to_ascii_uppercase())
   442	            .filter(|c| c != current_canonical)
   443	            .collect();
   444	        historic_canonicals.sort();
   445	        historic_canonicals.dedup();
   446	        for hc in &historic_canonicals {
   447	            if current_table_canonicals.contains(hc) {
   448	                // Safety guard: another table currently owns this
   449	                // historic name. Skip + report.
   450	                ambiguous_rules_skipped.push(TableAmbiguousSkip {
   451	                    origin_table_current_canonical: current_canonical.clone(),
   452	                    historic_canonical: hc.clone(),
   453	                });
   454	                continue;
   455	            }
   456	            rules.push((hc.clone(), Arc::clone(&current_display)));
   457	        }
   458	        table_rewrites.push(TableRewriteSummary {
   459	            current_canonical: current_canonical.clone(),
   460	            current_display_name: current_display.to_string(),
   461	            historic_canonicals,
   462	        });
   463	    }
   464	
   465	    if rules.is_empty() {
   466	        return Ok(TableRepairReport {
   467	            formulas_rewritten: 0,
   468	            table_rewrites,
   469	            ambiguous_rules_skipped,
   470	        });
   470	        });
   471	    }
   472	
   473	    // Phase 4: walk formulas, collect updates.
   474	    let mut to_update: Vec<(SheetId, u32, u32, String)> = Vec::new();
   475	    for (sheet, row, col, text) in workbook.iter_formulas() {
   476	        let mut current_text = text.to_string();
   477	        let mut changed = false;
   478	        for (old_canonical, new_display) in &rules {
   479	            if let Some(rewritten) =
   480	                rewrite_formula_with_table_rename(&current_text, old_canonical, new_display)
   481	            {
   482	                current_text = rewritten;
   483	                changed = true;
   484	            }
   485	        }
   486	        if changed {
   487	            to_update.push((sheet, row, col, current_text));
   488	        }
   489	    }
   490	    let rewrite_count = to_update.len();
   491	
   492	    // Phase 5: apply updates.
   493	    for (sheet, row, col, new_text) in to_update {
   494	        workbook.put_formula(sheet, row, col, new_text);
   495	    }
   496	
   497	    Ok(TableRepairReport {
   498	        formulas_rewritten: rewrite_count,
   499	        table_rewrites,
   500	        ambiguous_rules_skipped,
   501	    })
   502	}
   503	
   504	/// Walk an `Op` (including BatchCommit-nested) and accumulate
   505	/// historic table canonicals per current canonical. Transitive
   506	/// chain propagation: when an op renames `old_c → new_c`, any
   507	/// historic entries previously keyed under `old_c` move to `new_c`
   508	/// (along with `old_c` itself).
   509	fn collect_table_renames(op: &Op, historic_by_current: &mut HashMap<String, Vec<String>>) {
   510	    match op {
   511	        Op::RenameTable { old_name, new_name } => {
   512	            let old_c = old_name.to_ascii_uppercase();
   513	            let new_c = new_name.to_ascii_uppercase();
   514	            // historic_by_current[new_c] gets old_c appended (the
   515	            // most recent old name for this final canonical).
   516	            historic_by_current
   517	                .entry(new_c.clone())
   518	                .or_default()
   519	                .push(old_c.clone());
   520	            // Propagate prior chain: if old_c had its own historic
   521	            // entries, move them to new_c.
   522	            if let Some(prior) = historic_by_current.remove(&old_c) {
   523	                for p in prior {
   524	                    historic_by_current
   525	                        .entry(new_c.clone())
   526	                        .or_default()
   527	                        .push(p);
   528	                }
   529	            }
   530	        }
   531	        Op::BatchCommit { ops } => {
   532	            for inner in ops {
   533	                collect_table_renames(inner, historic_by_current);
   534	            }
   535	        }
   536	        _ => {}
   537	    }
   538	}
   539	
   540	/// Table-rename analog of [`rewrite_formula_with_rename`]. Routes
   541	/// through `ql_formula_syntax::rewrite_table_ref`.
   542	fn rewrite_formula_with_table_rename(
   543	    text: &str,
   544	    old_canonical: &str,
   545	    new_name: &Arc<str>,
   546	) -> Option<String> {
   547	    let stripped = text.strip_prefix('=').unwrap_or(text);
   548	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
   549	    let expr = ql_formula_syntax::parse(tokens).ok()?;
   550	    let rewritten = ql_formula_syntax::rewrite_table_ref(&expr, old_canonical, new_name);
   551	    if rewritten == expr {
   552	        return None;
   553	    }
   554	    let printed = ql_formula_syntax::print(&rewritten);
   555	    let with_eq = if text.starts_with('=') {
   556	        format!("={printed}")
   557	    } else {
   558	        printed
   559	    };
   560	    Some(with_eq)
   561	}
   562	
   563	/// Report for [`repair_table_rename_chain`].
   564	#[derive(Debug, Clone, Default)]
   565	pub struct TableRepairReport {
   566	    pub formulas_rewritten: usize,
   567	    pub table_rewrites: Vec<TableRewriteSummary>,
   568	    pub ambiguous_rules_skipped: Vec<TableAmbiguousSkip>,
   569	}
   570	
   571	/// Per-table summary line in [`TableRepairReport`].
   572	#[derive(Debug, Clone)]
   573	pub struct TableRewriteSummary {
   574	    pub current_canonical: String,
   575	    pub current_display_name: String,
   576	    pub historic_canonicals: Vec<String>,
   577	}
   578	
   579	/// Skipped table rule due to current-holder ambiguity.
   580	#[derive(Debug, Clone)]
   581	pub struct TableAmbiguousSkip {
   582	    pub origin_table_current_canonical: String,
   583	    pub historic_canonical: String,
   584	}

 succeeded in 0ms:
   120	
   121	    /// `Op::SetCellFormat` referenced a format id that hasn't been
   122	    /// registered yet. The producer SHOULD always emit `RegisterFormat`
   123	    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
   124	    /// **W5-80.**
   125	    ///
   126	    /// **Phase 5.2 D-1 step 4:** `id` changed from `u32` to
   127	    /// `ql_storage::FormatId` (the converted-from-wire shape).
   128	    #[error("replay set-cell-format references unregistered format id {id:?} at op index {index}")]
   129	    FormatNotRegistered {
   130	        index: usize,
   131	        id: ql_storage::FormatId,
   132	    },
   133	
   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
   135	    /// whose current name matches neither `old_name` nor `new_name`
   136	    /// (i.e. the replay state has diverged from what the op recorded).
   137	    ///
   138	    /// **Phase 5.3 step 2 (2026-05-20) — VARIANT NO LONGER EMITTED.**
   139	    /// Under CRDT merge of concurrent renames, current name may
   140	    /// legitimately match neither. The replay handler now applies
   141	    /// the rename to the current sheet (last-in-causal-order wins
   142	    /// policy). Variant kept for ABI compat — external callers that
   143	    /// match against it will simply never see it. Marked
   144	    /// `#[deprecated]` for IDE discoverability (Codex step-2 audit
   145	    /// LOW closure). May be removed in a future major version.
   146	    #[deprecated(
   147	        since = "0.1.0",
   148	        note = "Phase 5.3 step 2: no longer emitted. Concurrent renames now apply via last-in-causal-order wins policy. See replay.rs RenameSheet handler."
   149	    )]
   150	    #[error(
   151	        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
   152	         expected current name {expected:?}, found {found:?}"
   153	    )]
   154	    SheetRenameNameMismatch {
   155	        index: usize,
   156	        id: SheetId,
   157	        expected: String,
   158	        found: String,
   159	    },
   160	
   161	    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
   162	    /// new name (duplicate, reserved character, empty).
   163	    #[error(
   164	        "replay rename-sheet rejected at op index {index}: sheet {id} \
   165	         from {old_name:?} to {new_name:?} ({source})"
   166	    )]
   167	    SheetRenameRejected {
   168	        index: usize,
   169	        id: SheetId,
   170	        old_name: String,
   171	        new_name: String,
   172	        #[source]
   173	        source: ql_storage::SheetNameError,
   174	    },
   175	
   176	    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
   177	    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
   178	    /// under canonical comparison, or an Excel-reserved character.
   179	    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
   180	    /// accepted any name, so an op log produced against a buggy
   181	    /// storage path could let conflicting sheets enter replay state.
   182	    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
   183	    SheetNameRejected {
   184	        index: usize,
   185	        name: String,
   186	        #[source]
   187	        source: ql_storage::SheetNameError,
   188	    },
   189	
   190	    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
   430	                                sheet_count,
   431	                            })?;
   432	                    sheet_ref.set_scoped_name(name, target).map_err(|source| {
   433	                        ReplayError::NameRejected {
   434	                            index,
   435	                            name: name.clone(),
   436	                            source,
   437	                        }
   438	                    })?;
   439	                }
   440	            }
   441	            Ok(())
   442	        }
   443	        Op::AddSheet { name, chunk_rows } => {
   444	            // **W5-93 (Phase 4.6.E closure):** route through the fallible
   445	            // `try_add_sheet_with_chunk_rows` and surface a clean
   446	            // `ReplayError::SheetNameRejected` on validation failure.
   447	            // Codex HIGH-1 flagged that the prior infallible path
   448	            // silently accepted duplicate-canonical names + reserved
   449	            // characters at the replay boundary too.
   450	            //
   451	            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
   452	            // duplicate-canonical-name. Phase 5 multi-peer scenario:
   453	            // peer A and peer B both call `add_sheet("S")` locally;
   454	            // each producer-side validates against its own snapshot
   455	            // (no collision visible); both emit
   456	            // `Op::AddSheet { name: "S", ... }`; merged log has both.
   457	            // First replay succeeds; second hits the duplicate guard.
   458	            // Pre-D-2 we rejected the second op (worse UX than Google
   459	            // Sheets, which auto-renames to S(2)). Now we walk
   460	            // `<name>(2)`, `<name>(3)`, … until we find a free name.
   461	            // `Empty` + `ReservedCharacter` still reject — auto-rename
   462	            // only resolves the collaboration-collision case.
   463	            let mut chosen = name.clone();
   464	            let mut suffix = 2u32;
   465	            const AUTO_RENAME_CEILING: u32 = 10_000;
   466	            loop {
   467	                match workbook.try_add_sheet_with_chunk_rows(chosen.clone(), *chunk_rows) {
   468	                    Ok(_) => return Ok(()),
   469	                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
   470	                        chosen = format!("{name}({suffix})");
   471	                        suffix += 1;
   472	                        if suffix > AUTO_RENAME_CEILING {
   473	                            // Pathological: more than 10k sheets all
   474	                            // share the same base name (impossible in
   475	                            // realistic workbooks; max sheets per
   476	                            // workbook is 65,535). Surface a clean
   477	                            // error rather than loop forever.
   478	                            return Err(ReplayError::SheetNameRejected {
   479	                                index,
   480	                                name: name.clone(),
   481	                                source: ql_storage::SheetNameError::Duplicate {
   482	                                    name: name.clone(),
   483	                                },
   484	                            });
   485	                        }
   486	                    }
   487	                    Err(other) => {
   488	                        return Err(ReplayError::SheetNameRejected {
   489	                            index,
   490	                            name: name.clone(),
   491	                            source: other,
   492	                        });
   493	                    }
   494	                }
   495	            }
   496	        }
   497	        Op::RenameSheet {
   498	            id,
   499	            old_name,
   500	            new_name,
   501	        } => {
   502	            // **W5-91 (Phase 4.6.C) + Phase 5.3 step 2 + step-2 audit
   503	            // closure (2026-05-20):** snapshot-vs-replay reconciliation
   504	            // + CRDT concurrent-rename policy.
   505	            //
   506	            // Two cases (post-step-2-audit-closure):
   507	            //
   508	            //   1. Current display name == new_name (EXACT equality, not
   509	            //      canonical) → idempotent. Replay-on-top-of-snapshot OR
   510	            //      concurrent peers picked the same target. No-op.
   511	            //
   512	            //      **MEDIUM-1 audit closure (Codex):** pre-closure the
   513	            //      idempotency check used canonical equality, which
   514	            //      silently dropped case-only renames (e.g. "Sheet1" →
   515	            //      "SHEET1"). Storage permits case-only renames and
   516	            //      updates the display field; replay must do the same.
   517	            //
   518	            //   2. Otherwise → apply the rename. Subsumes:
   519	            //      - pre-step-2 case 2 (current == old_name; fresh rename).
   520	            //      - pre-step-2 case 3 (current ∈ neither; **Phase 5.3
   521	            //        step 2 policy**, audit-locked: last-in-causal-order
   522	            //        wins under CRDT merge — apply to current sheet name.
   523	            //        Matches `crdt-data-model.md` § 311-334 last-wins
   524	            //        rule for SetName + same-cell writes).
   525	            //      - case-only rename (canonical equal, display differs).
   526	            //
   527	            // **HIGH-1 audit closure (Codex + Opus convergent):** rename
   528	            // target collision (`new_name` already used by a different
   529	            // sheet) auto-disambiguates via D-2-style suffix walk
   530	            // (`<name>(2)`, `<name>(3)`, …). Pre-closure this propagated
   531	            // `SheetRenameRejected` and hard-failed replay — same blast
   532	            // radius as the original pre-step-2 bug, just shifted to a
   533	            // different concurrent scenario (peer A: sheet0 S1→X, peer
   534	            // B: sheet1 S3→X, both valid locally, second errors on merge).
   535	            //
   536	            // D-2 (AddSheet auto-rename) set the precedent at
   537	            // `replay.rs:458-490`; RenameSheet now follows the same
   538	            // pattern for consistency. `Empty` + `ReservedCharacter`
   539	            // still reject — auto-rename only resolves collisions.
   540	            //
   541	            // Edge cases:
   542	            //   - Sheet doesn't exist at id → `InvalidSheet` (unchanged).
   543	            //   - `new_name` is empty → `SheetRenameRejected { source:
   544	            //     SheetNameError::Empty }` propagated from storage. The
   545	            //     wire op format does not enforce non-empty; producer-side
   546	            //     `WorkbookRuntime::rename_sheet` validates, but a
   547	            //     malformed log can still bypass that path. HIGH-2 audit
   548	            //     closure (Opus): documented here.
   549	            //   - Reserved-character in `new_name` → `SheetRenameRejected
   550	            //     { source: ReservedCharacter(_) }`. Same caveat as Empty.
   551	            const AUTO_RENAME_CEILING: u32 = 10_000;
   552	
   553	            let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
   554	                ReplayError::InvalidSheet {
   555	                    index,
   556	                    sheet: *id,
   557	                    sheet_count: workbook.sheet_count(),
   558	                },
   559	            )?;
   560	            if current == *new_name {
   561	                // Case 1: already at exact target display. No-op.
   562	                return Ok(());
   563	            }
   564	            // Case 2: apply rename, auto-disambiguating Duplicate via D-2
   565	            // pattern. Empty + ReservedCharacter still reject.
   566	            let mut chosen = new_name.clone();
   567	            let mut suffix = 2u32;
   568	            loop {
   569	                match workbook.rename_sheet(*id, chosen.clone()) {
   570	                    Ok(_) => return Ok(()),
   571	                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
   572	                        chosen = format!("{new_name}({suffix})");
   573	                        suffix += 1;
   574	                        if suffix > AUTO_RENAME_CEILING {
   575	                            return Err(ReplayError::SheetRenameRejected {
   576	                                index,
   577	                                id: *id,
   578	                                old_name: old_name.clone(),
   579	                                new_name: new_name.clone(),
   580	                                source: ql_storage::SheetNameError::Duplicate {
   581	                                    name: new_name.clone(),
   582	                                },
   583	                            });
   584	                        }
   585	                    }
   586	                    Err(other) => {
   587	                        return Err(ReplayError::SheetRenameRejected {
   588	                            index,
   589	                            id: *id,
   590	                            old_name: old_name.clone(),
   591	                            new_name: new_name.clone(),
   592	                            source: other,
   593	                        });
   594	                    }
   595	                }
   596	            }
   597	        }
   598	        Op::RegisterFormat { id, string } => {
   599	            // **W5-80:** route through `FormatTable::register_at` so
   600	            // collisions surface as `FormatRejected` (rather than the
   601	            // panic-on-duplicate behavior `intern` would have via the
   602	            // by_string fast path; `register_at` is the explicit-id form).
   603	            //
   604	            // Phase 5.2 D-1 step 4: `Op::RegisterFormat.id` is now
   605	            // `FormatIdWire`. Convert to `ql_storage::FormatId` via
   606	            // `to_storage()`. The pre-step-4 `legacy_from_u32` migration
   607	            // helper is no longer needed for the wire-replay path; it's
   608	            // reserved for envelope-load migration in step 5.
   609	            let fid = id.to_storage();
   610	            workbook
   650	            for inner_op in ops {
   651	                // Phase 2A.3.a: nested ops flatten to the parent's index
   652	                // for error reporting. Phase 5+ may extend with
   653	                // (outer, inner) tuple indexing once the producer side
   654	                // emits nested commits in practice.
   655	                apply_op(inner_op, workbook, index)?;
   656	            }
   657	            Ok(())
   658	        }
   659	        Op::CreateTable {
   660	            name,
   661	            sheet,
   662	            top_row,
   663	            top_col,
   664	            rows,
   665	            cols,
   666	            has_header,
   667	            has_totals,
   668	            column_names,
   669	        } => apply_create_table(
   670	            workbook,
   671	            index,
   672	            name,
   673	            *sheet,
   674	            *top_row,
   675	            *top_col,
   676	            *rows,
   677	            *cols,
   678	            *has_header,
   679	            *has_totals,
   680	            column_names,
   681	        ),
   682	        Op::DropTable { name } => {
   683	            let canonical = name.to_ascii_uppercase();
   684	            if workbook.tables_mut().remove(canonical.as_str()).is_none() {
   685	                return Err(ReplayError::TableNotFound {
   686	                    index,
   687	                    name: name.clone(),
   688	                });
   689	            }
   690	            Ok(())
   691	        }
   692	        Op::RenameTable { old_name, new_name } => {
   693	            apply_rename_table(workbook, index, old_name, new_name)
   694	        }
   695	        Op::RenameColumn {
   696	            table,
   697	            old_name,
   698	            new_name,
   699	        } => apply_rename_column(workbook, index, table, old_name, new_name),
   700	        Op::ResizeTable {
   701	            name,
   702	            new_rows,
   703	            new_cols,
   704	            added_columns,
   705	            removed_columns,
   706	        } => apply_resize_table(
   707	            workbook,
   708	            index,
   709	            name,
   710	            *new_rows,
   711	            *new_cols,
   712	            added_columns,
   713	            removed_columns,
   714	        ),
   715	        // **W5-146 (Phase 4.9.J) + W5-151 (4.9.O MEDIUM-2 closure):**
   716	        // workbook-scope reference-mode change. Forward-compat
   717	        // unknown wire values surface `ReplayError::UnknownReferenceMode`
   718	        // with the captured string (mirrors the `LocaleWire::Unknown`
   719	        // path below).
   720	        Op::SetReferenceMode { mode } => match mode.clone().to_runtime() {
   721	            Ok(m) => {
   722	                workbook.set_reference_mode(m);
   723	                Ok(())
   724	            }
   725	            Err(found) => Err(ReplayError::UnknownReferenceMode { index, found }),
   726	        },
   727	        // **W5-146 (Phase 4.9.J):** workbook-scope locale change.
   728	        // Unknown wire values (forward-compat op-log file) surface
   729	        // `ReplayError::UnknownLocale` with the captured string.
   730	        Op::SetLocale { locale } => match locale.clone().to_runtime() {
   731	            Ok(loc) => {
   732	                workbook.set_locale(loc);
   733	                Ok(())
   734	            }
   735	            Err(found) => Err(ReplayError::UnknownLocale { index, found }),
   736	        },
   737	    }
   738	}
   739	
   740	/// **W5-119 (Phase 4.8.I) + Phase 5.3 step 4 (2026-05-20):**
   741	/// replay a `RenameTable`. Validates source exists, target name is
   742	/// available (TableTable + NameTable shared namespace), then re-keys
   743	/// the entry.
   744	///
   745	/// **Phase 5.3 step 4 (audit-locked, mirrors step 2 for
   746	/// RenameSheet):** two CRDT-merge scenarios required this handler to
   747	/// be made resilient:
   748	///
   749	/// 1. **Concurrent rename of same table** (last-wins): peer A
   750	///    renames T→T1, peer B (concurrent) renames T→T2. After Loro's
   751	///    causal merge, the second op's `old_name="T"` no longer
   752	///    resolves to a live table. Pre-step-4 this errored with
   753	///    `TableNotFound`. Post-step-4: if NO table at `old_canonical`
   754	///    exists but the workbook still has the post-first-rename
   755	///    name (T1 or T2 depending on causal order), we no-op the
   756	///    second rename if its `new_name` matches a current table
   757	///    (idempotency); otherwise, we treat the rename as advisory
   758	///    and skip if the table simply doesn't exist anywhere.
   759	///    Note: unlike sheets which carry stable IDs, tables are
   760	///    keyed by canonical name — there's no equivalent "rename
   761	///    current table to new_name" because we can't disambiguate
   762	///    which current table the wire op was thought to be acting on.
   763	///    Skip is the safer policy.
   764	///
   765	/// 2. **Cross-table target collision** (V1 LIMITATION — hard-fail):
   766	///    peer A renames T1→X, peer B renames T2→X (different sources,
   767	///    same target). After merge, the second op errors with
   768	///    `TableCreateRejected`. Pre-step-4-audit the handler attempted
   769	///    D-2-style auto-disambig (X → X(2)), but the step 4 audit
   770	///    (Codex+Opus HIGH-1) showed this produced silent formula-
   771	///    corruption when combined with `repair_table_rename_chain` —
   772	///    the repair keyed its chain by op's wire `new_name` and missed
   773	///    the auto-disambig'd canonical. Reverted to hard-reject. V2
   774	///    closure path: emit synthesized correction op at replay (would
   775	///    require API change to surface the disambig outcome to repair).
   776	fn apply_rename_table(
   777	    workbook: &mut Workbook,
   778	    index: usize,
   779	    old_name: &str,
   780	    new_name: &str,
   781	) -> Result<(), ReplayError> {
   782	    let old_canonical = old_name.to_ascii_uppercase();
   783	
   784	    // **Step 4 audit-locked policy** (V1 — tables): source table
   785	    // missing under CRDT merge means a concurrent peer renamed it.
   786	    // Three scenarios:
   787	    //  (a) the rename has already been applied as part of this peer's
   788	    //      causal-order replay (idempotent — current state has new_name).
   789	    //  (b) a concurrent peer renamed it to a DIFFERENT target (e.g.
   790	    //      peer A: T→T2; peer B: T→T3). Sheets handle this via stable
   791	    //      sheet IDs (rename current sheet to new_name); tables don't
   792	    //      have stable IDs (keyed by canonical name) so we can't
   793	    //      disambiguate which table this op was thought to be acting
   794	    //      on. Apply "advisory skip" — drop the second rename's intent
   795	    //      to avoid corruption.
   796	    //  (c) the source genuinely doesn't exist (corruption or stale op
   797	    //      against a never-existed table).
   798	    //
   799	    // V1 policy: skip silently in case (a) and (b); error only when
   800	    // there's clearly no related table state to interpret the op
   801	    // against (no current_canonical, no new_canonical, no plausible
   802	    // post-rename state).
   803	    //
   804	    // **V1 limitation (deferred to V2):** scenario (b) loses peer
   805	    // B's rename intent. Causality-aware tracking would let us tell
   806	    // "this op was authored when T existed locally; the table was
   807	    // since renamed to T2 by a concurrent peer; we COULD apply
   808	    // T2→T3." Today the only safe call is advisory-skip.
   809	    if workbook.tables().lookup(&old_canonical).is_none() {
   810	        let new_canonical = new_name.to_ascii_uppercase();
   811	        if workbook.tables().lookup(&new_canonical).is_some() {
   812	            // Case (a): idempotent — new_name already exists.
   813	            return Ok(());
   814	        }
   815	        // Cases (b) and (c): no related state. Advisory skip
   816	        // (case b) accepts losing the rename intent rather than
   817	        // hard-failing replay; the alternative would be re-erroring
   818	        // and making merged logs un-replayable. The diagnostic
   819	        // surface for (b) would require op-log-level reporting
   820	        // beyond replay's return type — deferred to V2.
  1760	            id: 0,
  1761	            old_name: "Sheet1".to_owned(),
  1762	            new_name: "Renamed".to_owned(),
  1763	        })
  1764	        .unwrap();
  1765	
  1766	        let mut wb = Workbook::new();
  1767	        let reg = default_registry();
  1768	        replay_into(&log, &mut wb, &reg).unwrap();
  1769	        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
  1770	    }
  1771	
  1772	    #[test]
  1773	    fn replay_rename_sheet_already_renamed_is_noop() {
  1774	        // Replay-on-top-of-snapshot path: snapshot already has the new
  1775	        // name; replay must NOT error.
  1776	        let mut log = OpLog::new();
  1777	        log.append(Op::RenameSheet {
  1778	            id: 0,
  1779	            old_name: "Sheet1".to_owned(),
  1780	            new_name: "Renamed".to_owned(),
  1781	        })
  1782	        .unwrap();
  1783	
  1784	        let mut wb = Workbook::new();
  1785	        wb.add_sheet("Renamed"); // snapshot already at the new name
  1786	        let reg = default_registry();
  1787	        replay_into(&log, &mut wb, &reg).unwrap();
  1788	        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
  1789	    }
  1790	
  1791	    /// **Phase 5.3 step 2 (2026-05-20):** test name + assertion
  1792	    /// inverted by the audit-locked CRDT policy change. Pre-step-2
  1793	    /// this asserted `SheetRenameNameMismatch` fired when the
  1794	    /// current sheet name matched neither old nor new (e.g. a
  1795	    /// snapshot whose state diverged from the op's `old_name`).
  1796	    /// Post-step-2 that case applies the rename to the current
  1797	    /// sheet ("last-in-causal-order wins" policy) — current name
  1798	    /// after replay is `new_name`.
  1799	    ///
  1800	    /// The renamed test reflects the new property: replay applies
  1801	    /// the rename even when current ≠ old_name.
  1802	    #[test]
  1803	    fn replay_rename_sheet_current_neither_old_nor_new_applies_rename() {
  1804	        // Snapshot has a name that's neither old nor new ⇒ under
  1805	        // Phase 5.3 step 2, this is the canonical concurrent-rename
  1806	        // scenario: another peer's rename already changed the sheet
  1807	        // name; this op's `old_name` is interpreted as "what the
  1808	        // peer thought was current," and replay applies the rename
  1809	        // to whatever the sheet currently is.
  1810	        let mut log = OpLog::new();
  1811	        log.append(Op::RenameSheet {
  1812	            id: 0,
  1813	            old_name: "Sheet1".to_owned(),
  1814	            new_name: "Renamed".to_owned(),
  1815	        })
  1816	        .unwrap();
  1817	
  1818	        let mut wb = Workbook::new();
  1819	        wb.add_sheet("Something Else");
  1820	        let reg = default_registry();
  1821	        replay_into(&log, &mut wb, &reg).expect("replay must apply rename, not error");
  1822	        assert_eq!(
  1823	            wb.sheet(0).unwrap().name(),
  1824	            "Renamed",
  1825	            "Phase 5.3 step 2: 'last-in-causal-order wins' — rename applies to current sheet"

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/lib.rs | sed -n '1,140p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `ql-collab` — Phase 5 multi-user CRDT collaboration crate.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold ship):** establishes the
     4	//! module shape per the audit-closed design at
     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
     6	//! A (preserve op-log shape on top of Loro `LoroList`); this crate
     7	//! is the layer above ql-oplog that orchestrates multi-peer
     8	//! collaboration.
     9	//!
    10	//! ## Module layout
    11	//!
    12	//! - `PeerId` — re-exported from [`ql_types::PeerId`] (Phase 5.2 D-1
    13	//!   step 1.1, 2026-05-19; originally `ql_collab::peer::PeerId` at
    14	//!   5.2.a, briefly relocated to `ql_oplog::PeerId` at step 1, finally
    15	//!   at `ql_types::PeerId` after the step-1 Codex audit caught a
    16	//!   forthcoming Cargo cycle). Stable per-session identifier; wraps
    17	//!   Loro's `u64`.
    18	//! - [`session`] — `CollabSession`: per-peer state holder that
    19	//!   wraps an `OpLog`, manages local appends, and exposes
    20	//!   `merge_bytes` + `export_bytes` for transport integration.
    21	//! - [`transport`] — `Transport` trait + 2 impls: `NoopTransport`
    22	//!   (test stub) and `LoopbackTransport` (Phase 5.5 V1 ship
    23	//!   2026-05-19 — in-process paired endpoints for 2-peer
    24	//!   round-trip tests). Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05`)
    25	//!   added `CollabSession` typed transport methods
    26	//!   (attach/detach/flush/poll). Phase 5.5 V2 V2 / V3 pending —
    27	//!   auto-flush + version-vector deltas + WebSocket impl.
    28	//! - [`presence`] — per-peer ephemeral cursor + selection state
    29	//!   (Phase 5.6 V1 ship 2026-05-19). `PresenceState` JSON-encoded
    30	//!   into the shared `LoroDoc`'s `"presence"` LoroMap (LWW per key).
    31	//! - [`undo`] — peer-local undo/redo via Loro's `UndoManager`.
    32	//!   V1 ship 2026-05-19 (`89c02b9d83e`): 7 undo/redo methods.
    33	//!   V2 V1 (`6138a7203f6` + `e199a5fda5a`): atomic grouping +
    34	//!   merge-interval. V2 V1.1: RAII `start_undo_group_scoped`
    35	//!   returning `UndoGroupGuard`. V2 V2 pending — push/pop
    36	//!   listeners.
    37	//!
    38	//! ## Stability
    39	//!
    40	//! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
    41	//! will populate the reserved modules and may shift trait shapes.
    42	//! No `#[non_exhaustive]` on enums yet — locked at Phase 5.8
    43	//! megaudit per the engine audit-discipline rule.
    44	//!
    45	//! ### Pre-stability API changes (logged)
    46	//!
    47	//! - **Phase 5.2.b (2026-05-19, `ef056f50bee`):** `CollabSession::new`
    48	//!   return type changed from `Self` to
    49	//!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
    50	//!   fallible (`u64::MAX` is reserved), so the constructor must
    51	//!   propagate the error. Internal-only at the time of the change;
    52	//!   no external callers.
    53	//! - **Phase 5.4 V1 (2026-05-19, `89c02b9d83e` + audit closure):**
    54	//!   `CollabSessionError::Undo(loro::LoroError)` variant added.
    55	//!   Exposes `loro::LoroError` in the public error surface — pre-0.2.0
    56	//!   this couples consumers to the loro crate version; a stable API
    57	//!   would wrap it in a ql-collab-owned error. Will be re-typed
    58	//!   before 0.2.0.
    59	//! - **Phase 5.4 V1 audit closure (2026-05-19):**
    60	//!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
    61	//!   to `&mut self`. Prevents accidental peer-id changes through
    62	//!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
    63	//!   an attached `UndoManager`'s stacks per Loro's internal
    64	//!   subscription behavior (`loro-internal::undo:654-662`).
    65	//! - **Phase 5.2 D-1 step 1 (2026-05-19, `aaa54d32f4d`):** `PeerId`
    66	//!   moved from `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId`.
    67	//!   Brief intermediate placement; superseded same-day by step 1.1.
    68	//! - **Phase 5.2 D-1 step 1.1 (2026-05-19):** Codex audit on step 1
    69	//!   caught (a) PeerId lacked `Serialize`/`Deserialize` (blocks step
    70	//!   2's serde-derived `FormatIdWire`); (b) `ql_storage::FormatId::Custom(PeerId, _)`
    71	//!   in step 3 would form a Cargo cycle (`ql-oplog -> ql-storage` exists;
    72	//!   making `ql-storage -> ql-oplog` for PeerId would loop). Step 1.1
    73	//!   moved PeerId to `ql_types::PeerId` (the true dependency floor —
    74	//!   `ql-storage`, `ql-oplog`, and `ql-collab` all depend on it),
    75	//!   added `#[serde(transparent)]` derives, and shipped the
    76	//!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
    77	//!   migration. `ql_collab::PeerId` now re-exports `ql_types::PeerId`.
    78	//!
    79	//!   **Back-compat surface:** `use ql_collab::PeerId;` keeps working
    80	//!   unchanged (both step 1 and step 1.1 preserve the re-export).
    81	//!   `use ql_collab::peer::PeerId;` (the old module path) was broken
    82	//!   by step 1 and stays broken — `pub mod peer` is gone. Workspace
    83	//!   grep confirms no such caller existed; external consumers were
    84	//!   already using `ql_collab::PeerId` (the re-export).
    85	
    86	pub mod presence;
    87	// Phase 5.3 step 3 (2026-05-20) — rename-repair pass. Caller-driven
    88	// post-merge cleanup that rewrites formula text referencing pre-rename
    89	// sheet names. See `repair.rs` module docs + `docs/architecture/crdt-data-model.md`
    90	// § "Conflict resolution semantics" rows for the RenameSheet × concurrent
    91	// edit closure that this module ships.
    92	pub mod repair;
    93	pub mod session;
    94	pub mod transport;
    95	pub mod undo;
    96	
    97	// PeerId actually lives in `ql_types` post step 1.1, but ql-collab
    98	// re-exports via `ql_oplog::PeerId` (itself a re-export) to avoid
    99	// adding a new direct `ql-types` Cargo dep on ql-collab. External
   100	// callers using `use ql_collab::PeerId;` resolve identically.
   101	pub use ql_oplog::PeerId;
   102	
   103	pub use presence::{PresenceError, PresenceState};
   104	pub use repair::{
   105	    repair_sheet_rename_chain, repair_table_rename_chain, AmbiguousSkip, RepairReport,
   106	    SheetRewriteSummary, TableAmbiguousSkip, TableRepairReport, TableRewriteSummary,
   107	};
   108	pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
   109	pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
   110	pub use undo::UndoManager;

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs | sed -n '1,180p;450,620p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 conflict-matrix probe tests — pin the audit-locked
     2	//! "last-in-causal-order wins" defaults from `crdt-data-model.md`
     3	//! § Conflict resolution semantics (Phase 5.3 preview).
     4	//!
     5	//! Most rows in the matrix are correct by Loro's underlying CRDT
     6	//! merge (Fugue/origin-based with peer-id tiebreaker). These tests
     7	//! make that load-bearing — any future regression in either Loro's
     8	//! semantics OR our op-replay path trips a test.
     9	//!
    10	//! Pattern: D-4's `phase_5_2_d4_spill_2peer_probe.rs` template.
    11	//! Each test:
    12	//!   1. Build a shared base log (common causal ancestor).
    13	//!   2. Fork peer A + peer B by `import_bytes(&base_bytes)`.
    14	//!   3. Each peer appends its local op.
    15	//!   4. Exchange via `export_bytes` + `merge_bytes` — in BOTH
    16	//!      directions when the test verifies convergence.
    17	//!   5. Replay + recompute via `replay_and_recompute`.
    18	//!   6. Assert final workbook state.
    19	//!
    20	//! Coverage of the 8-row matrix at `crdt-data-model.md:320-329`:
    21	//! - Row 1: PutValue × PutValue same address — pinned here
    22	//! - Row 2: PutFormula × PutFormula same address — pinned here
    23	//! - Row 3: PutValue × PutFormula same address — pinned here
    24	//! - Row 4: ClearFormula × PutFormula same address — pinned here
    25	//! - Row 5: SetName concurrent same name — pinned here
    26	//! - Row 6: AddSheet × AddSheet same name (D-2 auto-rename) — pinned here
    27	//! - Row 7: RenameSheet × concurrent edit on sheet — **pinned here as
    28	//!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
    29	//!   step 3 ships the rename-repair pass which will MODIFY this test
    30	//!   to assert the post-fix behavior (formula text rewritten,
    31	//!   correct value resolves).
    32	//! - Row 8: DropTable × concurrent edit referencing T — pinned here
    33	//!   (D-3 → #NAME?; no repair planned — drop is destructive)
    34	//!
    35	//! "Last-in-causal-order wins" means the CRDT picks ONE value
    36	//! deterministically; both merge directions converge to the same
    37	//! state. The tests verify CONVERGENCE (both peers see the same
    38	//! final state) — they don't predict WHICH op wins (that depends
    39	//! on Loro's internal peer-id tiebreaker, which we don't pin).
    40	//!
    41	//! Audit-discipline NOTE (step 1 audit closure, both Codex HIGH
    42	//! and Opus HIGH-1): value-only assertions are NOT load-bearing.
    43	//! A test that checks `Value::Number(7.0)` after concurrent
    44	//! literal-7 and formula-3+4 cannot distinguish which op won
    45	//! (both produce 7.0) AND would pass even if structural state
    46	//! diverges (e.g. peer A has formula_at=None, peer B has
    47	//! formula_at=Some). Convergence tests at the same address MUST
    48	//! additionally assert `formula_at` convergence to pin structural
    49	//! state, and SHOULD use distinct observable values (literal=7
    50	//! and formula="99-50"=49).
    51	
    52	use ql_exec::WorkbookRuntime;
    53	use ql_functions::default_registry;
    54	use ql_oplog::{replay_into, CellWireValue, NamedTargetWire, Op, OpLog};
    55	use ql_storage::Workbook;
    56	use ql_types::{Address, ErrorValue, Value};
    57	
    58	/// Build a base op log carrying `AddSheet("S")`. Most tests fork
    59	/// from this; the AddSheet × AddSheet test bypasses it (since it
    60	/// needs to test sheet-name collision directly).
    61	fn base_with_sheet() -> OpLog {
    62	    let mut log = OpLog::new();
    63	    log.append(Op::AddSheet {
    64	        name: "S".to_owned(),
    65	        chunk_rows: 16384,
    66	    })
    67	    .unwrap();
    68	    log
    69	}
    70	
    71	/// Build a base op log with sheet "S" + a `CreateTable("T")`
    72	/// covering A1:B3 with header row. Used by the DropTable conflict
    73	/// test (row 7).
    74	fn base_with_sheet_and_table() -> OpLog {
    75	    let mut log = base_with_sheet();
    76	    log.append(Op::CreateTable {
    77	        name: "T".to_owned(),
    78	        sheet: 0,
    79	        top_row: 0,
    80	        top_col: 0,
    81	        rows: 3,
    82	        cols: 2,
    83	        has_header: true,
    84	        has_totals: false,
    85	        column_names: vec!["X".to_owned(), "Y".to_owned()],
    86	    })
    87	    .unwrap();
    88	    log
    89	}
    90	
    91	/// Replay log into a fresh workbook + recompute. Mirror of D-4's
    92	/// helper.
    93	fn replay_and_recompute(log: &OpLog) -> Workbook {
    94	    let mut wb = Workbook::new();
    95	    let reg = default_registry();
    96	    replay_into(log, &mut wb, &reg).expect("replay should succeed");
    97	    {
    98	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    99	        rt.recompute_all();
   100	    }
   101	    wb
   102	}
   103	
   104	/// Stable peer ids for the two-peer fork. Loro's CRDT tiebreaker
   105	/// picks deterministic order ONLY when peer-ids are stable across
   106	/// the merge — if both directions use random `LoroDoc::new()` ids,
   107	/// the (peer-id pair) differs across directions and convergence
   108	/// breaks. PEER_A_ID < PEER_B_ID makes the order observable.
   109	///
   110	/// Both ids are non-zero (LEGACY_PEER reservation — `set_peer_id(0)`
   111	/// asserts post-step-8 audit closure).
   112	const PEER_A_ID: u64 = 1;
   113	const PEER_B_ID: u64 = 2;
   114	
   115	/// Build a freshly-forked `OpLog` carrying `base_bytes` and a fixed
   116	/// peer-id. New ops appended to this log carry `peer_id` in their
   117	/// Loro op-ids; the imported base ops retain their original peer-id
   118	/// (Loro semantic — import preserves origin).
   119	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
   120	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
   121	    log.set_peer_id(peer_id)
   122	        .expect("set_peer_id with non-zero id must succeed");
   123	    log
   124	}
   125	
   126	/// Fork two peers from `base_bytes` with STABLE peer-ids, apply
   127	/// `op_a` on peer A (id = `PEER_A_ID`) and `op_b` on peer B
   128	/// (id = `PEER_B_ID`), then merge bidirectionally. Returns the two
   129	/// replayed+recomputed workbooks `(wb_after_a_merges_b,
   130	/// wb_after_b_merges_a)`. The convergence property asserts these
   131	/// produce identical observable state.
   132	fn fork_apply_merge_both_directions(base_bytes: &[u8], op_a: Op, op_b: Op) -> (Workbook, Workbook) {
   133	    // Peer A's view: id=1, appends op_a, merges peer B's bytes.
   134	    let mut peer_a = fork_with_peer(base_bytes, PEER_A_ID);
   135	    peer_a.append(op_a.clone()).unwrap();
   136	
   137	    let mut peer_b_for_a = fork_with_peer(base_bytes, PEER_B_ID);
   138	    peer_b_for_a.append(op_b.clone()).unwrap();
   139	    peer_a
   140	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   141	        .unwrap();
   142	
   143	    // Peer B's view: id=2, appends op_b, merges peer A's bytes.
   144	    let mut peer_b = fork_with_peer(base_bytes, PEER_B_ID);
   145	    peer_b.append(op_b).unwrap();
   146	
   147	    let mut peer_a_for_b = fork_with_peer(base_bytes, PEER_A_ID);
   148	    peer_a_for_b.append(op_a).unwrap();
   149	    peer_b
   150	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   151	        .unwrap();
   152	
   153	    (replay_and_recompute(&peer_a), replay_and_recompute(&peer_b))
   154	}
   155	
   156	// ===== Row 1: PutValue × PutValue same address =====
   157	
   158	/// **Conflict-matrix row 1:** two peers each write a literal at A1.
   159	/// Loro's Fugue/origin-based merge picks one deterministically; both
   160	/// merge directions converge to the same final value.
   161	#[test]
   162	fn row1_putvalue_concurrent_same_address_converges() {
   163	    let base = base_with_sheet().export_bytes().unwrap();
   164	    let (wb_a, wb_b) = fork_apply_merge_both_directions(
   165	        &base,
   166	        Op::PutValue {
   167	            sheet: 0,
   168	            row: 0,
   169	            col: 0,
   170	            value: CellWireValue::Number(1.0),
   171	        },
   172	        Op::PutValue {
   173	            sheet: 0,
   174	            row: 0,
   175	            col: 0,
   176	            value: CellWireValue::Number(2.0),
   177	        },
   178	    );
   179	
   180	    let a1_a = wb_a.read(Address::new(0, 0, 0));
   450	// ===== Row 6: AddSheet × AddSheet same name (D-2 auto-rename) =====
   451	
   452	/// **Conflict-matrix row 6:** two peers each AddSheet with the
   453	/// same name. Phase 5.2 D-2 (`1ca19e2fa37`) shipped the auto-
   454	/// rename behavior — the second add in causal order becomes
   455	/// `<name>(2)`. This test pins it: after merge, BOTH sheets exist
   456	/// (no rejection); the second carries `(2)` suffix.
   457	#[test]
   458	fn row6_addsheet_same_name_auto_renames_via_d2() {
   459	    // Empty base — no AddSheet here; both peers contribute one.
   460	    let base = OpLog::new().export_bytes().unwrap();
   461	
   462	    let (wb_a, wb_b) = fork_apply_merge_both_directions(
   463	        &base,
   464	        Op::AddSheet {
   465	            name: "Calc".to_owned(),
   466	            chunk_rows: 16384,
   467	        },
   468	        Op::AddSheet {
   469	            name: "Calc".to_owned(),
   470	            chunk_rows: 16384,
   471	        },
   472	    );
   473	
   474	    // **Audit closure (Codex LOW-1):** assert exact convergence on
   475	    // the name set + ordering, not just "both names present in each
   476	    // peer's view." A regression that left peers with different
   477	    // sheet-id → name mappings would pass the looser check.
   478	    let names_a: Vec<String> = (0..wb_a.sheet_count() as u16)
   479	        .map(|i| wb_a.sheet(i).unwrap().name().to_owned())
   480	        .collect();
   481	    let names_b: Vec<String> = (0..wb_b.sheet_count() as u16)
   482	        .map(|i| wb_b.sheet(i).unwrap().name().to_owned())
   483	        .collect();
   484	
   485	    assert_eq!(
   486	        names_a, names_b,
   487	        "convergence: both peers' sheet-id → name mappings must match exactly"
   488	    );
   489	    // After D-2 auto-rename, exact result is {Calc, Calc(2)} in
   490	    // sheet-id order. Loro's causal merge picks the same first-wins
   491	    // outcome for both peers (we don't predict WHICH peer became
   492	    // Calc(2), but both peers agree).
   493	    assert_eq!(
   494	        names_a,
   495	        vec!["Calc".to_string(), "Calc(2)".to_string()],
   496	        "D-2 auto-rename: sheets must be [Calc, Calc(2)] in id order; got {names_a:?}"
   497	    );
   498	}
   499	
   500	// ===== Row 7: RenameSheet × concurrent edit on sheet (POST-STEP-3) =====
   501	
   502	/// **Conflict-matrix row 7 (Phase 5.3 step 3 — REPAIR PASS APPLIED):**
   503	/// peer A renames sheet "S" to "S2"; peer B concurrently writes a
   504	/// formula at A2 referencing "S!A1" (the old name). After merge +
   505	/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
   506	/// text is REWRITTEN to "S2!A1" and the cell resolves to 42.0 (the
   507	/// literal at S2!A1, originally at S!A1 before rename).
   508	///
   509	/// **Pre-step-3 behavior** (kept here as historical context):
   510	/// without the repair pass, the formula bind-failed at recompute →
   511	/// `Value::Error(ErrorValue::Name)` per the D-3 V1 limitation. Step
   512	/// 3's rename-repair pass closes that limitation.
   513	///
   514	/// **Test is intentionally bidirectional via `fork_apply_merge_both_directions`**
   515	/// — both peers, after merge + repair, must converge to the same
   516	/// formula text + resolved value.
   517	#[test]
   518	fn row7_rename_sheet_concurrent_edit_resolves_via_repair_pass() {
   519	    // Base: sheet S with a literal at S!A1 = 42.0.
   520	    let mut base_log = base_with_sheet();
   521	    base_log
   522	        .append(Op::PutValue {
   523	            sheet: 0,
   524	            row: 0,
   525	            col: 0,
   526	            value: CellWireValue::Number(42.0),
   527	        })
   528	        .unwrap();
   529	    let base = base_log.export_bytes().unwrap();
   530	
   531	    // Use the bidirectional helper to fork the two peers + apply
   532	    // their concurrent ops + cross-merge — but we have to interpose
   533	    // the repair pass between replay and recompute. The fork helper
   534	    // doesn't know about repair (it's a step-2-and-earlier helper),
   535	    // so we duplicate its logic inline here for the step 3 case.
   536	    let mut peer_a = OpLog::import_bytes(&base).unwrap();
   537	    peer_a.set_peer_id(1).unwrap();
   538	    peer_a
   539	        .append(Op::RenameSheet {
   540	            id: 0,
   541	            old_name: "S".to_owned(),
   542	            new_name: "S2".to_owned(),
   543	        })
   544	        .unwrap();
   545	    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
   546	    peer_b_for_a.set_peer_id(2).unwrap();
   547	    peer_b_for_a
   548	        .append(Op::PutFormula {
   549	            sheet: 0,
   550	            row: 1,
   551	            col: 0,
   552	            text: "S!A1".to_owned(),
   553	        })
   554	        .unwrap();
   555	    peer_a
   556	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   557	        .unwrap();
   558	
   559	    // Symmetric peer B view.
   560	    let mut peer_b = OpLog::import_bytes(&base).unwrap();
   561	    peer_b.set_peer_id(2).unwrap();
   562	    peer_b
   563	        .append(Op::PutFormula {
   564	            sheet: 0,
   565	            row: 1,
   566	            col: 0,
   567	            text: "S!A1".to_owned(),
   568	        })
   569	        .unwrap();
   570	    let mut peer_a_for_b = OpLog::import_bytes(&base).unwrap();
   571	    peer_a_for_b.set_peer_id(1).unwrap();
   572	    peer_a_for_b
   573	        .append(Op::RenameSheet {
   574	            id: 0,
   575	            old_name: "S".to_owned(),
   576	            new_name: "S2".to_owned(),
   577	        })
   578	        .unwrap();
   579	    peer_b
   580	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   581	        .unwrap();
   582	
   583	    // Replay + REPAIR PASS (Phase 5.3 step 3 work) + recompute.
   584	    let replay_repair_recompute = |log: &OpLog| -> Workbook {
   585	        let mut wb = Workbook::new();
   586	        let reg = default_registry();
   587	        replay_into(log, &mut wb, &reg).expect("replay must succeed");
   588	        // **Step 3 closure point**: the repair pass rewrites concurrent
   589	        // formula text referencing pre-rename sheet names. Without
   590	        // this call, recompute would surface #NAME? (D-3 V1 limitation).
   591	        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
   592	            .expect("repair_sheet_rename_chain must succeed");
   593	        assert_eq!(
   594	            report.formulas_rewritten, 1,
   595	            "exactly 1 formula (peer B's =S!A1) must be rewritten"
   596	        );
   597	        {
   598	            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   599	            rt.recompute_all();
   600	        }
   601	        wb
   602	    };
   603	
   604	    let wb_a = replay_repair_recompute(&peer_a);
   605	    let wb_b = replay_repair_recompute(&peer_b);
   606	
   607	    let a2_a = wb_a.read(Address::new(0, 1, 0));
   608	    let a2_b = wb_b.read(Address::new(0, 1, 0));
   609	
   610	    assert_eq!(a2_a, a2_b, "convergence on S2!A2 across merge directions");
   611	    // **POST-STEP-3 assertion**: repair rewrote `S!A1` → `S2!A1`; the
   612	    // cell at S2!A1 is the literal 42.0 from the base log.
   613	    assert_eq!(
   614	        a2_a,
   615	        Value::Number(42.0),
   616	        "post-repair: formula resolves correctly via rewritten text (S!A1 → S2!A1); \
   617	         got {a2_a:?}. Without the repair pass, this would be #NAME? (D-3 V1 limitation)."
   618	    );
   619	
   620	    // Pin the formula text directly to confirm the repair did its job.

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs | sed -n '1,240p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '809,970p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   809	    if workbook.tables().lookup(&old_canonical).is_none() {
   810	        let new_canonical = new_name.to_ascii_uppercase();
   811	        if workbook.tables().lookup(&new_canonical).is_some() {
   812	            // Case (a): idempotent — new_name already exists.
   813	            return Ok(());
   814	        }
   815	        // Cases (b) and (c): no related state. Advisory skip
   816	        // (case b) accepts losing the rename intent rather than
   817	        // hard-failing replay; the alternative would be re-erroring
   818	        // and making merged logs un-replayable. The diagnostic
   819	        // surface for (b) would require op-log-level reporting
   820	        // beyond replay's return type — deferred to V2.
   821	        return Ok(());
   822	    }
   823	
   824	    // **Step 4 audit closure (Codex+Opus HIGH-1, 2026-05-20):**
   825	    // auto-disambiguation REVERTED. The previous implementation
   826	    // walked suffixes (X → X(2)) on TableTable collision, but the
   827	    // repair pass at `ql_collab::repair_table_rename_chain` keys
   828	    // its chain by the op's wire `new_name`, not the actual
   829	    // post-replay canonical (which would be the suffixed `X(2)`).
   830	    // That mismatch caused silent formula-text corruption:
   831	    // formulas referencing peer B's old table got rewritten to the
   832	    // OTHER table named X (peer A's), pointing at the wrong sheet.
   833	    //
   834	    // Reverting to hard-reject on collision restores correctness:
   835	    // - Cross-source target collision (peer A: T1→X; peer B: T2→X
   836	    //   concurrent): the second op errors via TableCreateRejected.
   837	    //   This is a HARD-FAIL — V1 limitation, documented in plan.
   838	    //   Future V2 closure paths: emit synthesized correction op at
   839	    //   replay (would require API change), OR reconcile via
   840	    //   causality-aware tracking.
   841	    let new_canonical_arc: std::sync::Arc<str> =
   842	        std::sync::Arc::from(new_name.to_ascii_uppercase().as_str());
   843	    // No-op same-canonical case.
   844	    if old_canonical.eq_ignore_ascii_case(new_name) {
   845	        return Ok(());
   846	    }
   847	    // NameTable collision (different namespace).
   848	    if workbook.names().lookup_ci(&new_canonical_arc).is_some() {
   849	        return Err(ReplayError::TableCreateRejected {
   850	            index,
   851	            name: new_name.to_owned(),
   852	            reason: "defined-name with this canonical name already exists (rename target)",
   853	        });
   854	    }
   855	    // TableTable collision.
   856	    if workbook.tables().lookup(&new_canonical_arc).is_some() {
   857	        return Err(ReplayError::TableCreateRejected {
   858	            index,
   859	            name: new_name.to_owned(),
   860	            reason: "table with this canonical name already exists (rename target)",
   861	        });
   862	    }
   863	    // Apply the rename.
   864	    let mut meta = workbook
   865	        .tables_mut()
   866	        .remove(&old_canonical)
   867	        .expect("source verified above");
   868	    meta.name = std::sync::Arc::clone(&new_canonical_arc);
   869	    meta.display_name = std::sync::Arc::from(new_name);
   870	    workbook.tables_mut().insert(new_canonical_arc, meta);
   871	    Ok(())
   872	}
   873	
   874	/// **W5-121 (Phase 4.8.I.2):** replay a `RenameColumn`. Validates the
   875	/// target table exists, the source column exists (case-insensitive), and
   876	/// the target column name is available within the table. Mutates the
   877	/// matching `TableColumn`'s `name` (lowercase canonical) and `display`
   878	/// (case-preserving). Bumps the `TableTable` generation so plan caches
   879	/// invalidate. Same-canonical column renames are rejected — the producer
   880	/// side treats those as a no-op and doesn't emit the op, so receiving
   881	/// one indicates log divergence.
   882	fn apply_rename_column(
   883	    workbook: &mut ql_storage::Workbook,
   884	    index: usize,
   885	    table: &str,
   886	    old_name: &str,
   887	    new_name: &str,
   888	) -> Result<(), ReplayError> {
   889	    let table_canonical = table.to_ascii_uppercase();
   890	    let meta = workbook
   891	        .tables_mut()
   892	        .get_mut(&table_canonical)
   893	        .ok_or_else(|| ReplayError::TableNotFound {
   894	            index,
   895	            name: table.to_owned(),
   896	        })?;
   897	
   898	    // **Phase 5.3 step 4 (V1, mirrors apply_rename_table policy)**:
   899	    // missing source column under CRDT merge means a concurrent peer
   900	    // renamed it. Idempotent skip if new_name already exists OR if
   901	    // the table itself has been re-structured (advisory). Errors only
   902	    // if there's clearly no related column state.
   903	    if meta.lookup_column(old_name).is_none() {
   904	        if meta.lookup_column(new_name).is_some() {
   905	            // Idempotent: new_name already exists from a prior
   906	            // causal-order rename.
   907	            return Ok(());
   908	        }
   909	        // Advisory skip: concurrent peer renamed to a different
   910	        // target. V1 limitation — see apply_rename_table for the
   911	        // full rationale (no stable column-id equivalent).
   912	        return Ok(());
   913	    }
   914	    let (col_idx, _) = meta.lookup_column(old_name).expect("just-checked");
   915	
   916	    if new_name.is_empty() {
   917	        return Err(ReplayError::TableColumnRejected {
   918	            index,
   919	            table: table.to_owned(),
   920	            column: new_name.to_owned(),
   921	            reason: "column name cannot be empty",
   922	        });
   923	    }
   924	    let old_lower = old_name.to_ascii_lowercase();
   925	    let new_lower = new_name.to_ascii_lowercase();
   926	    if old_lower == new_lower {
   927	        return Err(ReplayError::TableColumnRejected {
   928	            index,
   929	            table: table.to_owned(),
   930	            column: new_name.to_owned(),
   931	            reason: "rename to same canonical column name (producer should not emit)",
   932	        });
   933	    }
   934	
   935	    // **Step 4 audit closure (Codex+Opus HIGH-2, 2026-05-20):**
   936	    // column auto-disambiguation REVERTED. Same root cause as
   937	    // table HIGH-1: column repair pass (deferred from step 4)
   938	    // would have needed to track replay's suffix choice. Without
   939	    // that integration, suffixing silently produces wrong-column
   940	    // bindings post-merge. Reverting to hard-reject on collision
   941	    // restores correctness:
   942	    // - Cross-source target collision (peer A: A→Z; peer B: B→Z
   943	    //   concurrent in the same table): the second op errors via
   944	    //   TableColumnRejected. This is a HARD-FAIL — V1 limitation.
   945	    if meta.lookup_column(new_name).is_some() {
   946	        return Err(ReplayError::TableColumnRejected {
   947	            index,
   948	            table: table.to_owned(),
   949	            column: new_name.to_owned(),
   950	            reason: "column with this canonical name already exists (rename target)",
   951	        });
   952	    }
   953	
   954	    meta.columns[col_idx as usize].name = std::sync::Arc::from(new_lower.as_str());
   955	    meta.columns[col_idx as usize].display = std::sync::Arc::from(new_name);
   956	    workbook.tables_mut().bump_generation();
   957	    Ok(())
   958	}
   959	
   960	/// **W5-122 (Phase 4.8.J):** replay a `ResizeTable`. Validates the
   961	/// target table exists, the arithmetic invariant
   962	/// (`new_cols == old_cols + added.len() - removed.len()`),
   963	/// `removed_columns` exactly match the current trailing columns
   964	/// (case-insensitive on display), the final column roster has unique
   965	/// canonical names, and the new footprint cells outside the old
   966	/// footprint don't overlap other tables. Mutates the table metadata
   967	/// in place (rows/cols + columns vec). Bumps `TableTable` generation.
   968	fn apply_resize_table(
   969	    workbook: &mut ql_storage::Workbook,
   970	    index: usize,

 succeeded in 0ms:
     1	//! Phase 5.3 step 2 — concurrent RenameSheet replay convergence.
     2	//!
     3	//! Pre-step-2: replay's RenameSheet handler at `replay.rs:486-532`
     4	//! had three cases. Case 3 ("current name matches neither old nor
     5	//! new") returned `ReplayError::SheetRenameNameMismatch`, which
     6	//! **hard-failed replay** under CRDT merge of concurrent renames.
     7	//! E.g., peer A: `RenameSheet { id, old: "S", new: "S2" }`; peer B
     8	//! concurrently issues `RenameSheet { id, old: "S", new: "S3" }`.
     9	//! After Loro's causal merge, whichever rename replays SECOND finds
    10	//! `current != "S"` (already renamed by the first) and `current !=
    11	//! its own new_name` — case 3 — replay errored.
    12	//!
    13	//! Post-step-2: case 3 applies the rename to whatever the sheet
    14	//! currently is. The audit-locked policy from `crdt-data-model.md`
    15	//! § 311-334 — "last-in-causal-order wins" — produces deterministic
    16	//! convergence: both peers, after merging each other's ops, observe
    17	//! the same final sheet name (the winner's new_name).
    18	//!
    19	//! These probes pin the property via the D-4 / step-1 test pattern.
    20	//! `fork_with_peer(base, peer_id)` inlined here because it lives in
    21	//! a different test target (ql-exec); the helper is small enough to
    22	//! duplicate, and keeping these tests in ql-oplog avoids pulling in
    23	//! ql-exec for a replay-layer concern.
    24	//!
    25	//! Convergence still requires stable non-zero peer-ids per
    26	//! `crdt-data-model.md` § "Peer-id stability is a precondition for
    27	//! CRDT convergence" (added by Phase 5.3 step 1 audit closure).
    28	
    29	use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
    30	use ql_storage::Workbook;
    31	use ql_types::Address;
    32	
    33	const PEER_A_ID: u64 = 1;
    34	const PEER_B_ID: u64 = 2;
    35	
    36	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    37	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    38	    log.set_peer_id(peer_id)
    39	        .expect("set_peer_id with non-zero id must succeed");
    40	    log
    41	}
    42	
    43	fn base_with_sheet(name: &str) -> OpLog {
    44	    let mut log = OpLog::new();
    45	    log.append(Op::AddSheet {
    46	        name: name.to_owned(),
    47	        chunk_rows: 16384,
    48	    })
    49	    .unwrap();
    50	    log
    51	}
    52	
    53	/// Replay log into a fresh workbook. NOTE: unlike the step 1 probes
    54	/// in `phase_5_3_conflict_matrix_probe.rs`, these tests don't need
    55	/// recompute (we're checking the sheet-name layer, not formula
    56	/// evaluation). So we use `replay_into` directly without pulling in
    57	/// `WorkbookRuntime` / ql-exec.
    58	fn replay_into_fresh(log: &OpLog) -> Workbook {
    59	    let mut wb = Workbook::new();
    60	    // default_registry would require ql-functions; pass an empty
    61	    // registry — replay doesn't call into the function registry
    62	    // anyway (it stores formulas as text, recomputes on demand).
    63	    let reg = ql_functions::default_registry();
    64	    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    65	    wb
    66	}
    67	
    68	/// **Step 2 PRIMARY property:** two peers concurrently rename the
    69	/// same sheet to DIFFERENT targets. Replay must NOT hard-fail. The
    70	/// merged log's final sheet name converges across merge directions.
    71	#[test]
    72	fn step2_concurrent_rename_different_targets_converges() {
    73	    let base = base_with_sheet("S").export_bytes().unwrap();
    74	
    75	    // Peer A's view: id=1 renames S → S2, then merges peer B's bytes.
    76	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    77	    peer_a
    78	        .append(Op::RenameSheet {
    79	            id: 0,
    80	            old_name: "S".to_owned(),
    81	            new_name: "S2".to_owned(),
    82	        })
    83	        .unwrap();
    84	    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    85	    peer_b_for_a
    86	        .append(Op::RenameSheet {
    87	            id: 0,
    88	            old_name: "S".to_owned(),
    89	            new_name: "S3".to_owned(),
    90	        })
    91	        .unwrap();
    92	    peer_a
    93	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
    94	        .expect("merge_bytes must succeed");
    95	
    96	    // Peer B's view: symmetric — id=2 renames S → S3, then merges A.
    97	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    98	    peer_b
    99	        .append(Op::RenameSheet {
   100	            id: 0,
   101	            old_name: "S".to_owned(),
   102	            new_name: "S3".to_owned(),
   103	        })
   104	        .unwrap();
   105	    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
   106	    peer_a_for_b
   107	        .append(Op::RenameSheet {
   108	            id: 0,
   109	            old_name: "S".to_owned(),
   110	            new_name: "S2".to_owned(),
   111	        })
   112	        .unwrap();
   113	    peer_b
   114	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   115	        .expect("merge_bytes must succeed (reverse direction)");
   116	
   117	    // **The critical assertion**: replay must succeed (no
   118	    // SheetRenameNameMismatch hard-fail).
   119	    let wb_a = replay_into_fresh(&peer_a);
   120	    let wb_b = replay_into_fresh(&peer_b);
   121	
   122	    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
   123	    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
   124	
   125	    assert_eq!(
   126	        name_a, name_b,
   127	        "convergence: both peers must observe the same final sheet name"
   128	    );
   129	    // The winner is one of {S2, S3}; we don't predict WHICH (depends
   130	    // on Loro's tiebreaker).
   131	    assert!(
   132	        name_a == "S2" || name_a == "S3",
   133	        "sheet name must be one of the concurrently-written targets; got {name_a:?}"
   134	    );
   135	}
   136	
   137	/// **Step 2:** two peers concurrently rename to the SAME target.
   138	/// Trivially idempotent — both ops fold into the same final state.
   139	///
   140	/// **Audit closure (Opus LOW-1):** added bidirectional merge check
   141	/// for discipline consistency with test #1. Pre-closure only checked
   142	/// peer A's view after pulling peer B; symmetric direction omitted.
   143	#[test]
   144	fn step2_concurrent_rename_identical_targets_is_idempotent() {
   145	    let base = base_with_sheet("S").export_bytes().unwrap();
   146	
   147	    // Peer A's view: id=1, rename, then merge B's bytes.
   148	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   149	    peer_a
   150	        .append(Op::RenameSheet {
   151	            id: 0,
   152	            old_name: "S".to_owned(),
   153	            new_name: "Renamed".to_owned(),
   154	        })
   155	        .unwrap();
   156	    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
   157	    peer_b_for_a
   158	        .append(Op::RenameSheet {
   159	            id: 0,
   160	            old_name: "S".to_owned(),
   161	            new_name: "Renamed".to_owned(),
   162	        })
   163	        .unwrap();
   164	    peer_a
   165	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   166	        .unwrap();
   167	
   168	    // Peer B's view: symmetric — id=2, rename, then merge A's bytes.
   169	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   170	    peer_b
   171	        .append(Op::RenameSheet {
   172	            id: 0,
   173	            old_name: "S".to_owned(),
   174	            new_name: "Renamed".to_owned(),
   175	        })
   176	        .unwrap();
   177	    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
   178	    peer_a_for_b
   179	        .append(Op::RenameSheet {
   180	            id: 0,
   181	            old_name: "S".to_owned(),
   182	            new_name: "Renamed".to_owned(),
   183	        })
   184	        .unwrap();
   185	    peer_b
   186	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   187	        .unwrap();
   188	
   189	    let wb_a = replay_into_fresh(&peer_a);
   190	    let wb_b = replay_into_fresh(&peer_b);
   191	    assert_eq!(wb_a.sheet(0).unwrap().name(), "Renamed");
   192	    assert_eq!(wb_b.sheet(0).unwrap().name(), "Renamed");
   193	    assert_eq!(
   194	        wb_a.sheet(0).unwrap().name(),
   195	        wb_b.sheet(0).unwrap().name(),
   196	        "bidirectional convergence: both peers must observe the same final name"
   197	    );
   198	}
   199	
   200	/// **Step 2:** sequential rename across peers (peer B SAW peer A's
   201	/// rename before issuing its own). No concurrency — peer B's op has
   202	/// `old_name = "S2"` matching the post-A-rename state. Pinned as a
   203	/// regression baseline: the policy change must NOT break the
   204	/// non-concurrent case.
   205	#[test]
   206	fn step2_sequential_rename_across_peers_converges() {
   207	    let base = base_with_sheet("S").export_bytes().unwrap();
   208	
   209	    // Peer A: rename S → S2.
   210	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   211	    peer_a
   212	        .append(Op::RenameSheet {
   213	            id: 0,
   214	            old_name: "S".to_owned(),
   215	            new_name: "S2".to_owned(),
   216	        })
   217	        .unwrap();
   218	
   219	    // Peer B receives peer A's bytes FIRST (sees S2), then renames
   220	    // S2 → S3. This is the sequential (not concurrent) path.
   221	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   222	    peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
   223	    peer_b
   224	        .append(Op::RenameSheet {
   225	            id: 0,
   226	            old_name: "S2".to_owned(),
   227	            new_name: "S3".to_owned(),
   228	        })
   229	        .unwrap();
   230	
   231	    // Peer A then receives peer B's full log.
   232	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   233	
   234	    let wb_a = replay_into_fresh(&peer_a);
   235	    let wb_b = replay_into_fresh(&peer_b);
   236	    assert_eq!(wb_a.sheet(0).unwrap().name(), "S3");
   237	    assert_eq!(wb_b.sheet(0).unwrap().name(), "S3");
   238	}
   239	
   240	/// **Step 2:** concurrent rename + concurrent literal write at the

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs | sed -n '1,360p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 step 4 — concurrent RenameTable + RenameColumn replay
     2	//! convergence. 2026-05-20.
     3	//!
     4	//! Mirrors `phase_5_3_step2_rename_concurrent.rs` (sheet rename) for
     5	//! table + column renames. The pre-step-4 bug shape (from Opus step 1
     6	//! audit MEDIUM-2): `apply_rename_table` (`replay.rs:691`) and
     7	//! `apply_rename_column` (`replay.rs:749`) hard-fail under CRDT
     8	//! merge of concurrent renames — same root cause as the RenameSheet
     9	//! bug step 2 fixed.
    10	//!
    11	//! Post-step-4: replay applies "last-in-causal-order wins" +
    12	//! D-2-style auto-disambiguation for target collisions (mirroring
    13	//! step 2).
    14	
    15	use ql_oplog::{replay_into, Op, OpLog};
    16	use ql_storage::Workbook;
    17	
    18	const PEER_A_ID: u64 = 1;
    19	const PEER_B_ID: u64 = 2;
    20	
    21	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    22	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    23	    log.set_peer_id(peer_id)
    24	        .expect("set_peer_id with non-zero id must succeed");
    25	    log
    26	}
    27	
    28	fn base_with_table(table_name: &str, col_names: Vec<String>) -> OpLog {
    29	    let mut log = OpLog::new();
    30	    log.append(Op::AddSheet {
    31	        name: "S".to_owned(),
    32	        chunk_rows: 16384,
    33	    })
    34	    .unwrap();
    35	    log.append(Op::CreateTable {
    36	        name: table_name.to_owned(),
    37	        sheet: 0,
    38	        top_row: 0,
    39	        top_col: 0,
    40	        rows: 3,
    41	        cols: col_names.len() as u32,
    42	        has_header: true,
    43	        has_totals: false,
    44	        column_names: col_names,
    45	    })
    46	    .unwrap();
    47	    log
    48	}
    49	
    50	fn replay_into_fresh(log: &OpLog) -> Workbook {
    51	    let mut wb = Workbook::new();
    52	    let reg = ql_functions::default_registry();
    53	    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    54	    wb
    55	}
    56	
    57	// ===== RenameTable: concurrent rename to different targets =====
    58	
    59	/// **Step 4 PRIMARY for tables**: two peers concurrently rename the
    60	/// same table T to different targets T2 vs T3. Pre-step-4 the second
    61	/// op hard-failed with `TableNotFound`. Post-step-4: replay applies
    62	/// the first rename, then idempotent-skips the second (current state
    63	/// already doesn't match the second op's old_name).
    64	#[test]
    65	fn step4_concurrent_rename_table_different_targets_no_hard_fail() {
    66	    let base = base_with_table("T", vec!["A".to_owned()])
    67	        .export_bytes()
    68	        .unwrap();
    69	
    70	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    71	    peer_a
    72	        .append(Op::RenameTable {
    73	            old_name: "T".to_owned(),
    74	            new_name: "T2".to_owned(),
    75	        })
    76	        .unwrap();
    77	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    78	    peer_b
    79	        .append(Op::RenameTable {
    80	            old_name: "T".to_owned(),
    81	            new_name: "T3".to_owned(),
    82	        })
    83	        .unwrap();
    84	
    85	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    86	    let wb_a = replay_into_fresh(&peer_a);
    87	
    88	    // Replay didn't hard-fail. Exactly 1 table exists.
    89	    assert_eq!(wb_a.tables().iter().count(), 1);
    90	}
    91	
    92	/// **Step 4 audit closure (Codex+Opus HIGH-1, 2026-05-20):**
    93	/// cross-table target collision (different sources, same target).
    94	/// Pre-audit-closure: auto-disambig produced {X, X(2)} but the
    95	/// repair pass mis-handled the auto-disambig'd canonical, causing
    96	/// silent formula corruption. Post-audit-closure: REVERTED to
    97	/// hard-reject via `TableCreateRejected`. V1 limitation.
    98	#[test]
    99	fn step4_audit_cross_table_target_collision_hard_fails() {
   100	    let mut base_log = OpLog::new();
   101	    base_log
   102	        .append(Op::AddSheet {
   103	            name: "S".to_owned(),
   104	            chunk_rows: 16384,
   105	        })
   106	        .unwrap();
   107	    base_log
   108	        .append(Op::CreateTable {
   109	            name: "T1".to_owned(),
   110	            sheet: 0,
   111	            top_row: 0,
   112	            top_col: 0,
   113	            rows: 2,
   114	            cols: 1,
   115	            has_header: true,
   116	            has_totals: false,
   117	            column_names: vec!["A".to_owned()],
   118	        })
   119	        .unwrap();
   120	    base_log
   121	        .append(Op::CreateTable {
   122	            name: "T2".to_owned(),
   123	            sheet: 0,
   124	            top_row: 5,
   125	            top_col: 0,
   126	            rows: 2,
   127	            cols: 1,
   128	            has_header: true,
   129	            has_totals: false,
   130	            column_names: vec!["B".to_owned()],
   131	        })
   132	        .unwrap();
   133	    let base = base_log.export_bytes().unwrap();
   134	
   135	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   136	    peer_a
   137	        .append(Op::RenameTable {
   138	            old_name: "T1".to_owned(),
   139	            new_name: "X".to_owned(),
   140	        })
   141	        .unwrap();
   142	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   143	    peer_b
   144	        .append(Op::RenameTable {
   145	            old_name: "T2".to_owned(),
   146	            new_name: "X".to_owned(),
   147	        })
   148	        .unwrap();
   149	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   150	
   151	    // Replay must hard-fail with TableCreateRejected on the second
   152	    // rename's target collision (V1 limitation, audit-closed).
   153	    let mut wb = Workbook::new();
   154	    let reg = ql_functions::default_registry();
   155	    let result = replay_into(&peer_a, &mut wb, &reg);
   156	    assert!(
   157	        result.is_err(),
   158	        "cross-source target collision must hard-fail post-audit-closure (V1 limitation)"
   159	    );
   160	}
   161	
   162	// ===== RenameColumn: concurrent rename =====
   163	
   164	/// **Step 4 for columns**: two peers concurrently rename the same
   165	/// column to different targets. Pre-step-4 the second op hard-failed.
   166	/// Post-step-4: idempotent skip.
   167	#[test]
   168	fn step4_concurrent_rename_column_different_targets_no_hard_fail() {
   169	    let base = base_with_table("T", vec!["A".to_owned(), "B".to_owned()])
   170	        .export_bytes()
   171	        .unwrap();
   172	
   173	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   174	    peer_a
   175	        .append(Op::RenameColumn {
   176	            table: "T".to_owned(),
   177	            old_name: "A".to_owned(),
   178	            new_name: "Alpha".to_owned(),
   179	        })
   180	        .unwrap();
   181	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   182	    peer_b
   183	        .append(Op::RenameColumn {
   184	            table: "T".to_owned(),
   185	            old_name: "A".to_owned(),
   186	            new_name: "Apple".to_owned(),
   187	        })
   188	        .unwrap();
   189	
   190	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   191	    let wb = replay_into_fresh(&peer_a);
   192	
   193	    // Replay didn't hard-fail. Column 0 has one of the renamed values
   194	    // (whichever applied in causal order); col 1 = B (unchanged).
   195	    let meta = wb.tables().lookup("T").unwrap();
   196	    assert_eq!(meta.columns.len(), 2);
   197	    let col0_display = meta.columns[0].display.as_ref();
   198	    assert!(
   199	        col0_display == "Alpha" || col0_display == "Apple",
   200	        "col 0 display must be one of the concurrent targets; got {col0_display:?}"
   201	    );
   202	    assert_eq!(meta.columns[1].display.as_ref(), "B");
   203	}
   204	
   205	/// **Step 4 audit closure (Codex+Opus HIGH-2, 2026-05-20):**
   206	/// cross-column target collision. Pre-audit-closure: auto-disambig
   207	/// produced {Z, Z(2)} but no column repair pass landed → silent
   208	/// formula-binding to wrong column. Post-audit-closure: REVERTED
   209	/// to hard-reject. V1 limitation.
   210	#[test]
   211	fn step4_audit_cross_column_target_collision_hard_fails() {
   212	    let base = base_with_table("T", vec!["A".to_owned(), "B".to_owned()])
   213	        .export_bytes()
   214	        .unwrap();
   215	
   216	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   217	    peer_a
   218	        .append(Op::RenameColumn {
   219	            table: "T".to_owned(),
   220	            old_name: "A".to_owned(),
   221	            new_name: "Z".to_owned(),
   222	        })
   223	        .unwrap();
   224	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   225	    peer_b
   226	        .append(Op::RenameColumn {
   227	            table: "T".to_owned(),
   228	            old_name: "B".to_owned(),
   229	            new_name: "Z".to_owned(),
   230	        })
   231	        .unwrap();
   232	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   233	
   234	    let mut wb = Workbook::new();
   235	    let reg = ql_functions::default_registry();
   236	    let result = replay_into(&peer_a, &mut wb, &reg);
   237	    assert!(
   238	        result.is_err(),
   239	        "cross-source column target collision must hard-fail post-audit-closure (V1 limitation)"
   240	    );
   241	}
   242	
   243	/// **Step 4 regression baseline**: sequential rename (single-writer)
   244	/// still works after the step-4 changes. Pre-existing functionality
   245	/// must NOT break.
   246	#[test]
   247	fn step4_sequential_single_writer_table_rename_still_works() {
   248	    let mut log = base_with_table("T", vec!["A".to_owned()]);
   249	    log.append(Op::RenameTable {
   250	        old_name: "T".to_owned(),
   251	        new_name: "T2".to_owned(),
   252	    })
   253	    .unwrap();
   254	
   255	    let wb = replay_into_fresh(&log);
   256	    assert!(wb.tables().lookup("T").is_none());
   257	    assert_eq!(
   258	        wb.tables().lookup("T2").unwrap().display_name.as_ref(),
   259	        "T2"
   260	    );
   261	}
   262	
   263	#[test]
   264	fn step4_sequential_single_writer_column_rename_still_works() {
   265	    let mut log = base_with_table("T", vec!["A".to_owned(), "B".to_owned()]);
   266	    log.append(Op::RenameColumn {
   267	        table: "T".to_owned(),
   268	        old_name: "A".to_owned(),
   269	        new_name: "Alpha".to_owned(),
   270	    })
   271	    .unwrap();
   272	
   273	    let wb = replay_into_fresh(&log);
   274	    let meta = wb.tables().lookup("T").unwrap();
   275	    assert_eq!(meta.columns[0].display.as_ref(), "Alpha");
   276	    assert_eq!(meta.columns[1].display.as_ref(), "B");
   277	}

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_tables.rs | sed -n '1,360p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 step 4 — table rename-repair integration tests. 2026-05-20.
     2	//!
     3	//! Mirrors `repair_renames.rs` (sheet repair) pattern for table
     4	//! rename scenarios. Covers:
     5	//! - Primary case: concurrent rename + concurrent formula referencing old table name
     6	//! - Auto-disambiguation interaction (step 4 replay handler)
     7	//! - Safety guard: skip rules where old_canonical is currently held
     8	//! - No-rename log → no-op
     9	//! - BatchCommit traversal
    10	//! - Empty new_name + same-canonical no-op (replay rejects/skips)
    11	
    12	use ql_collab::{repair_table_rename_chain, TableRepairReport};
    13	use ql_oplog::{replay_into, Op, OpLog};
    14	use ql_storage::Workbook;
    15	
    16	const PEER_A_ID: u64 = 1;
    17	const PEER_B_ID: u64 = 2;
    18	
    19	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    20	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    21	    log.set_peer_id(peer_id)
    22	        .expect("set_peer_id with non-zero id must succeed");
    23	    log
    24	}
    25	
    26	/// Build a base log: AddSheet("S") + CreateTable("T") with columns
    27	/// [A, B] over A1:B3.
    28	fn base_with_table(table_name: &str) -> OpLog {
    29	    let mut log = OpLog::new();
    30	    log.append(Op::AddSheet {
    31	        name: "S".to_owned(),
    32	        chunk_rows: 16384,
    33	    })
    34	    .unwrap();
    35	    log.append(Op::CreateTable {
    36	        name: table_name.to_owned(),
    37	        sheet: 0,
    38	        top_row: 0,
    39	        top_col: 0,
    40	        rows: 3,
    41	        cols: 2,
    42	        has_header: true,
    43	        has_totals: false,
    44	        column_names: vec!["A".to_owned(), "B".to_owned()],
    45	    })
    46	    .unwrap();
    47	    log
    48	}
    49	
    50	fn replay_to_workbook(log: &OpLog) -> Workbook {
    51	    let mut wb = Workbook::new();
    52	    let reg = ql_functions::default_registry();
    53	    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    54	    wb
    55	}
    56	
    57	// ===== Test 1: PRIMARY — concurrent table rename + concurrent formula =====
    58	
    59	/// **Step 4 PRIMARY property**: peer A renames table T → T2; peer B
    60	/// (concurrent) writes a formula `=T[A]` referencing the old name.
    61	/// After merge + table repair, formula text is rewritten to `=T2[A]`.
    62	#[test]
    63	fn repair_rewrites_concurrent_formula_referencing_old_table_name() {
    64	    let base = base_with_table("T").export_bytes().unwrap();
    65	
    66	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    67	    peer_a
    68	        .append(Op::RenameTable {
    69	            old_name: "T".to_owned(),
    70	            new_name: "T2".to_owned(),
    71	        })
    72	        .unwrap();
    73	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    74	    peer_b
    75	        .append(Op::PutFormula {
    76	            sheet: 0,
    77	            row: 5,
    78	            col: 0,
    79	            text: "T[A]".to_owned(),
    80	        })
    81	        .unwrap();
    82	
    83	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    84	    let mut wb = replay_to_workbook(&peer_a);
    85	
    86	    // Table is now T2 (peer A's rename applied via replay).
    87	    assert_eq!(
    88	        wb.tables().lookup("T2").unwrap().display_name.as_ref(),
    89	        "T2"
    90	    );
    91	    // Pre-repair: formula references old "T".
    92	    assert_eq!(
    93	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
    94	        Some("T[A]".to_string())
    95	    );
    96	
    97	    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
    98	
    99	    // Post-repair: formula references current table name.
   100	    assert_eq!(
   101	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
   102	        Some("T2[A]".to_string()),
   103	        "repair must rewrite T[A] to T2[A] (current name)"
   104	    );
   105	    assert_eq!(report.formulas_rewritten, 1);
   106	}
   107	
   108	// ===== Test 2: No-rename log → fast-path no-op =====
   109	
   110	#[test]
   111	fn repair_with_no_table_renames_is_noop() {
   112	    let mut log = OpLog::new();
   113	    log.append(Op::AddSheet {
   114	        name: "S".to_owned(),
   115	        chunk_rows: 16384,
   116	    })
   117	    .unwrap();
   118	    log.append(Op::CreateTable {
   119	        name: "T".to_owned(),
   120	        sheet: 0,
   121	        top_row: 0,
   122	        top_col: 0,
   123	        rows: 2,
   124	        cols: 1,
   125	        has_header: true,
   126	        has_totals: false,
   127	        column_names: vec!["X".to_owned()],
   128	    })
   129	    .unwrap();
   130	    log.append(Op::PutFormula {
   131	        sheet: 0,
   132	        row: 5,
   133	        col: 0,
   134	        text: "T[X]".to_owned(),
   135	    })
   136	    .unwrap();
   137	
   138	    let mut wb = replay_to_workbook(&log);
   139	    let report: TableRepairReport = repair_table_rename_chain(&mut wb, &log).unwrap();
   140	
   141	    assert_eq!(report.formulas_rewritten, 0);
   142	    assert!(report.table_rewrites.is_empty());
   143	    assert_eq!(
   144	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
   145	        Some("T[X]".to_string())
   146	    );
   147	}
   148	
   149	// ===== Test 3: Step 4 replay last-wins — concurrent same-table rename =====
   150	
   151	/// **Step 4 audit property (mirrors step 2 for sheets)**: two peers
   152	/// concurrently rename the same table T → T1 vs T → T2. After
   153	/// Loro's causal merge, the second op replays against an already-
   154	/// renamed table. Pre-step-4: TableNotFound hard-fail. Post-step-4:
   155	/// idempotent skip if new_name matches the current table state.
   156	#[test]
   157	fn step4_concurrent_same_table_rename_does_not_hard_fail() {
   158	    let base = base_with_table("T").export_bytes().unwrap();
   159	
   160	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   161	    peer_a
   162	        .append(Op::RenameTable {
   163	            old_name: "T".to_owned(),
   164	            new_name: "T".to_owned(), // same-name no-op (replay handles)
   165	        })
   166	        .unwrap();
   167	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   168	    peer_b
   169	        .append(Op::RenameTable {
   170	            old_name: "T".to_owned(),
   171	            new_name: "T2".to_owned(),
   172	        })
   173	        .unwrap();
   174	
   175	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   176	    // Replay must succeed — no hard-fail.
   177	    let wb = replay_to_workbook(&peer_a);
   178	
   179	    // Either T or T2 wins per causal order; verify the table exists
   180	    // under SOME canonical name. (Idempotent same-name case + T→T2
   181	    // case both leave a valid state.)
   182	    let count = wb.tables().iter().count();
   183	    assert_eq!(count, 1, "exactly one table after merge");
   184	}
   185	
   186	// ===== Test 4: Step 4 audit closure — cross-table target collision V1 limitation =====
   187	
   188	/// **Step 4 audit closure (Codex+Opus HIGH-1, 2026-05-20):** two
   189	/// peers concurrently rename DIFFERENT tables to the SAME target.
   190	/// Pre-audit-closure: replay auto-disambig'd to {X, X(2)} but the
   191	/// repair pass mishandled the auto-disambig'd canonical, causing
   192	/// silent formula corruption. Post-audit-closure: replay HARD-FAILS
   193	/// via `TableCreateRejected`. Documented V1 limitation.
   194	#[test]
   195	fn step4_audit_cross_table_target_collision_hard_fails() {
   196	    // Base: 2 tables T1 + T3.
   197	    let mut base_log = OpLog::new();
   198	    base_log
   199	        .append(Op::AddSheet {
   200	            name: "S".to_owned(),
   201	            chunk_rows: 16384,
   202	        })
   203	        .unwrap();
   204	    base_log
   205	        .append(Op::CreateTable {
   206	            name: "T1".to_owned(),
   207	            sheet: 0,
   208	            top_row: 0,
   209	            top_col: 0,
   210	            rows: 2,
   211	            cols: 1,
   212	            has_header: true,
   213	            has_totals: false,
   214	            column_names: vec!["A".to_owned()],
   215	        })
   216	        .unwrap();
   217	    base_log
   218	        .append(Op::CreateTable {
   219	            name: "T3".to_owned(),
   220	            sheet: 0,
   221	            top_row: 5,
   222	            top_col: 0,
   223	            rows: 2,
   224	            cols: 1,
   225	            has_header: true,
   226	            has_totals: false,
   227	            column_names: vec!["B".to_owned()],
   228	        })
   229	        .unwrap();
   230	    let base = base_log.export_bytes().unwrap();
   231	
   232	    // Peer A: rename T1 → X. Peer B: rename T3 → X. Both valid locally.
   233	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   234	    peer_a
   235	        .append(Op::RenameTable {
   236	            old_name: "T1".to_owned(),
   237	            new_name: "X".to_owned(),
   238	        })
   239	        .unwrap();
   240	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   241	    peer_b
   242	        .append(Op::RenameTable {
   243	            old_name: "T3".to_owned(),
   244	            new_name: "X".to_owned(),
   245	        })
   246	        .unwrap();
   247	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   248	
   249	    // Replay must hard-fail with TableCreateRejected. V1 limitation.
   250	    let mut wb = Workbook::new();
   251	    let reg = ql_functions::default_registry();
   252	    let result = replay_into(&peer_a, &mut wb, &reg);
   253	    assert!(
   254	        result.is_err(),
   255	        "post-audit-closure: cross-source target collision hard-fails (V1 limitation, audit-locked)"
   256	    );
   257	}
   258	
   259	// ===== Test 7: Audit closure — transitive chain T → T2 → T3 + concurrent formula =====
   260	
   261	/// **Step 4 audit closure (Opus LOW-2):** transitive table rename
   262	/// chain (sequential single-peer T → T2 → T3) with a concurrent
   263	/// peer's formula referencing the original name. Repair must
   264	/// rewrite `T[A]` → `T3[A]` (skipping the intermediate T2).
   265	#[test]
   266	fn step4_audit_transitive_table_chain_to_final_name() {
   267	    let base = base_with_table("T").export_bytes().unwrap();
   268	
   269	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   270	    peer_a
   271	        .append(Op::RenameTable {
   272	            old_name: "T".to_owned(),
   273	            new_name: "T2".to_owned(),
   274	        })
   275	        .unwrap();
   276	    peer_a
   277	        .append(Op::RenameTable {
   278	            old_name: "T2".to_owned(),
   279	            new_name: "T3".to_owned(),
   280	        })
   281	        .unwrap();
   282	
   283	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   284	    peer_b
   285	        .append(Op::PutFormula {
   286	            sheet: 0,
   287	            row: 5,
   288	            col: 0,
   289	            text: "T[A]".to_owned(),
   290	        })
   291	        .unwrap();
   292	
   293	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   294	    let mut wb = replay_to_workbook(&peer_a);
   295	
   296	    let _report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   297	
   298	    assert_eq!(
   299	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
   300	        Some("T3[A]".to_string()),
   301	        "transitive chain: T → T2 → T3 rewrites T references directly to T3 (skipping intermediate T2)"
   302	    );
   303	}
   304	
   305	// ===== Test 8: Audit closure — BatchCommit traversal =====
   306	
   307	/// **Step 4 audit closure (Opus MEDIUM-4):** verify that
   308	/// `collect_table_renames` correctly walks BatchCommit-nested
   309	/// `Op::RenameTable` ops. The recursive code-path is exercised on
   310	/// real CRDT-merge scenarios where producer-side bundles rename +
   311	/// PutFormula in one BatchCommit.
   312	#[test]
   313	fn step4_audit_batchcommit_nested_table_rename_traverses_correctly() {
   314	    let base = base_with_table("T").export_bytes().unwrap();
   315	
   316	    // Peer A: BatchCommit-wrapped rename.
   317	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   318	    peer_a
   319	        .append(Op::BatchCommit {
   320	            ops: vec![Op::RenameTable {
   321	                old_name: "T".to_owned(),
   322	                new_name: "T2".to_owned(),
   323	            }],
   324	        })
   325	        .unwrap();
   326	    // Peer B: concurrent formula referencing the old name.
   327	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   328	    peer_b
   329	        .append(Op::PutFormula {
   330	            sheet: 0,
   331	            row: 5,
   332	            col: 0,
   333	            text: "T[A]".to_owned(),
   334	        })
   335	        .unwrap();
   336	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   337	
   338	    let mut wb = replay_to_workbook(&peer_a);
   339	    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   340	
   341	    assert_eq!(
   342	        report.formulas_rewritten, 1,
   343	        "BatchCommit-nested RenameTable must be discovered by the chain walker"
   344	    );
   345	    assert_eq!(
   346	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
   347	        Some("T2[A]".to_string())
   348	    );
   349	}
   350	
   351	// ===== Test 5: Idempotency =====
   352	
   353	#[test]
   354	fn table_repair_is_idempotent() {
   355	    let base = base_with_table("T").export_bytes().unwrap();
   356	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   357	    peer_a
   358	        .append(Op::RenameTable {
   359	            old_name: "T".to_owned(),
   360	            new_name: "T2".to_owned(),

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_renames.rs | sed -n '1,420p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 step 3 (CORE 5.3 work) — `ql_collab::repair_sheet_rename_chain`
     2	//! integration tests. 2026-05-20.
     3	//!
     4	//! Covers the user-visible property step 3 ships: after merging
     5	//! concurrent ops, formulas authored against pre-rename sheet names
     6	//! get rewritten to the current name. The repair pass closes the V1
     7	//! limitation documented at `crdt-data-model.md:615-648` (D-3 →
     8	//! `#NAME?`).
     9	//!
    10	//! Test pattern follows Phase 5.3 step 2's `phase_5_3_step2_rename_concurrent.rs`:
    11	//! 2-peer fork with stable peer-ids. Each test:
    12	//!   1. Build shared base log.
    13	//!   2. Fork peer A + peer B via `fork_with_peer`.
    14	//!   3. Each peer appends its local op.
    15	//!   4. Exchange via `export_bytes` + `merge_bytes`.
    16	//!   5. Replay into fresh workbook.
    17	//!   6. `repair_sheet_rename_chain(&mut wb, &log)`.
    18	//!   7. Assert formula text + (optionally) recomputed value.
    19	//!
    20	//! NOTE: these tests don't recompute (no ql-functions in ql-collab's
    21	//! dev-deps). They assert the FORMULA TEXT after repair, which is the
    22	//! load-bearing property. Recompute correctness is a downstream concern
    23	//! pinned at the row-7 test in `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs`.
    24	
    25	use ql_collab::{repair_sheet_rename_chain, RepairReport};
    26	use ql_oplog::{replay_into, Op, OpLog};
    27	use ql_storage::Workbook;
    28	
    29	const PEER_A_ID: u64 = 1;
    30	const PEER_B_ID: u64 = 2;
    31	
    32	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    33	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    34	    log.set_peer_id(peer_id)
    35	        .expect("set_peer_id with non-zero id must succeed");
    36	    log
    37	}
    38	
    39	fn base_with_sheet(name: &str) -> OpLog {
    40	    let mut log = OpLog::new();
    41	    log.append(Op::AddSheet {
    42	        name: name.to_owned(),
    43	        chunk_rows: 16384,
    44	    })
    45	    .unwrap();
    46	    log
    47	}
    48	
    49	/// Replay `log` into a fresh workbook. We use the registry from
    50	/// ql-functions (already a ql-collab dep) since `replay_into` requires
    51	/// it; we don't recompute (that's a downstream test concern).
    52	fn replay_to_workbook(log: &OpLog) -> Workbook {
    53	    let mut wb = Workbook::new();
    54	    let reg = ql_functions::default_registry();
    55	    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    56	    wb
    57	}
    58	
    59	/// Helper: build a merged log from two peers + apply concurrent ops.
    60	/// Mirrors the step-2 pattern; peer A is the merger.
    61	fn merged_log_with_concurrent_ops(base: &[u8], op_a: Op, op_b: Op) -> OpLog {
    62	    let mut peer_a = fork_with_peer(base, PEER_A_ID);
    63	    peer_a.append(op_a).unwrap();
    64	    let mut peer_b = fork_with_peer(base, PEER_B_ID);
    65	    peer_b.append(op_b).unwrap();
    66	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    67	    peer_a
    68	}
    69	
    70	// ===== Test 1: PRIMARY — concurrent rename + concurrent formula edit =====
    71	
    72	/// **Step 3 PRIMARY property**: peer A renames sheet S → S2;
    73	/// peer B (concurrent, no knowledge of rename) writes `=S!A1` at B1.
    74	/// After merge + repair, the formula text is rewritten to `=S2!A1`.
    75	///
    76	/// This is the canonical bug case from `crdt-data-model.md` row 7:
    77	/// pre-step-3 the formula would bind-fail (S no longer exists) and
    78	/// recompute → #NAME?. Post-step-3 the formula references the current
    79	/// sheet name and resolves correctly.
    80	#[test]
    81	fn repair_rewrites_concurrent_formula_referencing_old_name() {
    82	    // Base: sheet S exists.
    83	    let base = base_with_sheet("S").export_bytes().unwrap();
    84	
    85	    let log = merged_log_with_concurrent_ops(
    86	        &base,
    87	        Op::RenameSheet {
    88	            id: 0,
    89	            old_name: "S".to_owned(),
    90	            new_name: "S2".to_owned(),
    91	        },
    92	        Op::PutFormula {
    93	            sheet: 0,
    94	            row: 1,
    95	            col: 0, // B2... actually row 1, col 0 = A2
    96	            text: "S!A1".to_owned(),
    97	        },
    98	    );
    99	
   100	    let mut wb = replay_to_workbook(&log);
   101	    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
   102	    // Pre-repair: formula at (1,0) is "S!A1".
   103	    assert_eq!(
   104	        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
   105	        Some("S!A1".to_string()),
   106	        "pre-repair formula text is the raw merge state (S!A1, referencing old name)"
   107	    );
   108	
   109	    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair must succeed");
   110	
   111	    // Post-repair: formula rewritten to reference current sheet name.
   112	    assert_eq!(
   113	        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
   114	        Some("S2!A1".to_string()),
   115	        "post-repair formula text references current sheet name (S2)"
   116	    );
   117	    assert_eq!(
   118	        report.formulas_rewritten, 1,
   119	        "exactly 1 formula rewritten (B's =S!A1)"
   120	    );
   121	    assert_eq!(report.sheet_rewrites.len(), 1);
   122	    assert_eq!(report.sheet_rewrites[0].sheet, 0);
   123	    assert_eq!(report.sheet_rewrites[0].current_display_name, "S2");
   124	    assert_eq!(report.sheet_rewrites[0].historic_canonicals, vec!["S"]);
   125	}
   126	
   127	// ===== Test 2: Transitive chain (sequential renames) =====
   128	
   129	/// **Step 3:** sequential rename chain S → S2 → S3 (single peer
   130	/// across multiple ops). Peer B (forked at base) writes `=S!A1`.
   131	/// Repair should rewrite the formula to `=S3!A1` (the final name)
   132	/// since "S" is no longer current.
   133	#[test]
   134	fn repair_handles_transitive_chain_to_final_name() {
   135	    let base = base_with_sheet("S").export_bytes().unwrap();
   136	
   137	    // Peer A: chain S → S2 → S3.
   138	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   139	    peer_a
   140	        .append(Op::RenameSheet {
   141	            id: 0,
   142	            old_name: "S".to_owned(),
   143	            new_name: "S2".to_owned(),
   144	        })
   145	        .unwrap();
   146	    peer_a
   147	        .append(Op::RenameSheet {
   148	            id: 0,
   149	            old_name: "S2".to_owned(),
   150	            new_name: "S3".to_owned(),
   151	        })
   152	        .unwrap();
   153	
   154	    // Peer B: concurrent formula referencing original name.
   155	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   156	    peer_b
   157	        .append(Op::PutFormula {
   158	            sheet: 0,
   159	            row: 0,
   160	            col: 0,
   161	            text: "S!A1".to_owned(),
   162	        })
   163	        .unwrap();
   164	
   165	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   166	    let mut wb = replay_to_workbook(&peer_a);
   167	
   168	    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   169	
   170	    // Formula rewritten directly to the final name S3 (skipping S2).
   171	    assert_eq!(
   172	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   173	        Some("S3!A1".to_string()),
   174	        "transitive chain: S → S2 → S3 rewrites S references directly to S3"
   175	    );
   176	}
   177	
   178	// ===== Test 3: Rename-back (chain collapses) =====
   179	
   180	/// **Step 3:** rename-back chain S → S2 → S. Peer B writes
   181	/// `=S2!A1` (referencing the intermediate). After repair:
   182	/// formula references S (the current name), because S2 is now a
   183	/// historic name in the chain.
   184	#[test]
   185	fn repair_handles_rename_back_intermediate_reference() {
   186	    let base = base_with_sheet("S").export_bytes().unwrap();
   187	
   188	    // Peer A: S → S2 → S (final = original).
   189	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   190	    peer_a
   191	        .append(Op::RenameSheet {
   192	            id: 0,
   193	            old_name: "S".to_owned(),
   194	            new_name: "S2".to_owned(),
   195	        })
   196	        .unwrap();
   197	    peer_a
   198	        .append(Op::RenameSheet {
   199	            id: 0,
   200	            old_name: "S2".to_owned(),
   201	            new_name: "S".to_owned(),
   202	        })
   203	        .unwrap();
   204	
   205	    // Peer B references the INTERMEDIATE name S2.
   206	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   207	    peer_b
   208	        .append(Op::PutFormula {
   209	            sheet: 0,
   210	            row: 0,
   211	            col: 0,
   212	            text: "S2!A1".to_owned(),
   213	        })
   214	        .unwrap();
   215	
   216	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   217	    let mut wb = replay_to_workbook(&peer_a);
   218	
   219	    assert_eq!(wb.sheet(0).unwrap().name(), "S");
   220	
   221	    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   222	
   223	    // S2 was historic; repair rewrites S2 → S (current name).
   224	    assert_eq!(
   225	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   226	        Some("S!A1".to_string()),
   227	        "rename-back: S2 references rewritten to current name S"
   228	    );
   229	}
   230	
   231	// ===== Test 4: No-op case — formula references unrenamed sheet =====
   232	
   233	/// **Step 3:** formula references a sheet that was NEVER renamed.
   234	/// Repair must be a no-op for that formula. Pins idempotency of the
   235	/// helper's None-on-no-change return.
   236	#[test]
   237	fn repair_leaves_unrelated_formulas_unchanged() {
   238	    // Base: two sheets S (id 0) + T (id 1).
   239	    let mut base_log = OpLog::new();
   240	    base_log
   241	        .append(Op::AddSheet {
   242	            name: "S".to_owned(),
   243	            chunk_rows: 16384,
   244	        })
   245	        .unwrap();
   246	    base_log
   247	        .append(Op::AddSheet {
   248	            name: "T".to_owned(),
   249	            chunk_rows: 16384,
   250	        })
   251	        .unwrap();
   252	    let base = base_log.export_bytes().unwrap();
   253	
   254	    // Peer A: rename S → S2 (id 0).
   255	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   256	    peer_a
   257	        .append(Op::RenameSheet {
   258	            id: 0,
   259	            old_name: "S".to_owned(),
   260	            new_name: "S2".to_owned(),
   261	        })
   262	        .unwrap();
   263	
   264	    // Peer B: formula on T referencing T (unrelated to rename).
   265	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   266	    peer_b
   267	        .append(Op::PutFormula {
   268	            sheet: 1,
   269	            row: 0,
   270	            col: 0,
   271	            text: "T!B1".to_owned(),
   272	        })
   273	        .unwrap();
   274	
   275	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   276	    let mut wb = replay_to_workbook(&peer_a);
   277	
   278	    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   279	
   280	    // T!B1 untouched.
   281	    assert_eq!(
   282	        wb.formula_at(1, 0, 0).map(|s| s.to_string()),
   283	        Some("T!B1".to_string()),
   284	        "formula on unrenamed sheet must NOT be rewritten"
   285	    );
   286	    assert_eq!(
   287	        report.formulas_rewritten, 0,
   288	        "no formula references the renamed sheet's old name"
   289	    );
   290	}
   291	
   292	// ===== Test 5: Idempotency =====
   293	
   294	/// **Step 3:** running repair TWICE produces the same result as
   295	/// running it once. Pins the no-op-on-no-change property — critical
   296	/// for callers that might invoke repair multiple times during a
   297	/// session.
   298	#[test]
   299	fn repair_is_idempotent() {
   300	    let base = base_with_sheet("S").export_bytes().unwrap();
   301	    let log = merged_log_with_concurrent_ops(
   302	        &base,
   303	        Op::RenameSheet {
   304	            id: 0,
   305	            old_name: "S".to_owned(),
   306	            new_name: "S2".to_owned(),
   307	        },
   308	        Op::PutFormula {
   309	            sheet: 0,
   310	            row: 0,
   311	            col: 0,
   312	            text: "S!A1".to_owned(),
   313	        },
   314	    );
   315	
   316	    let mut wb = replay_to_workbook(&log);
   317	    let first = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   318	    let after_first = wb.formula_at(0, 0, 0).map(|s| s.to_string());
   319	
   320	    let second = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   321	    let after_second = wb.formula_at(0, 0, 0).map(|s| s.to_string());
   322	
   323	    assert_eq!(first.formulas_rewritten, 1);
   324	    assert_eq!(
   325	        second.formulas_rewritten, 0,
   326	        "second repair pass must be a no-op (helper returns None on no-change)"
   327	    );
   328	    assert_eq!(
   329	        after_first, after_second,
   330	        "formula text stable across repeated repair calls"
   331	    );
   332	}
   333	
   334	// ===== Test 6: Empty log =====
   335	
   336	/// **Step 3:** no rename ops in the log → repair is trivial no-op.
   337	#[test]
   338	fn repair_with_no_renames_is_noop() {
   339	    let mut log = OpLog::new();
   340	    log.append(Op::AddSheet {
   341	        name: "S".to_owned(),
   342	        chunk_rows: 16384,
   343	    })
   344	    .unwrap();
   345	    log.append(Op::PutFormula {
   346	        sheet: 0,
   347	        row: 0,
   348	        col: 0,
   349	        text: "S!A1".to_owned(),
   350	    })
   351	    .unwrap();
   352	
   353	    let mut wb = replay_to_workbook(&log);
   354	    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair on no-rename log");
   355	
   356	    assert_eq!(report.formulas_rewritten, 0);
   357	    assert!(report.sheet_rewrites.is_empty());
   358	    assert_eq!(
   359	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   360	        Some("S!A1".to_string())
   361	    );
   362	}
   363	
   364	// ===== Test 7: Step 2 auto-disambiguation chain =====
   365	
   366	/// **Step 3 + step-2-audit interaction**: two peers concurrently
   367	/// rename DIFFERENT sheets to the SAME target. Step 2's auto-
   368	/// disambiguation suffixes the second to `X(2)`. Peer C writes
   369	/// `=S3!A1` referencing sheet 1's original name. After merge +
   370	/// repair, the formula should rewrite to the current name of
   371	/// sheet 1, which is `X(2)`.
   372	#[test]
   373	fn repair_handles_step2_auto_disambiguation_suffix() {
   374	    // Base: 2 sheets (S1 = id 0, S3 = id 1).
   375	    let mut base_log = OpLog::new();
   376	    base_log
   377	        .append(Op::AddSheet {
   378	            name: "S1".to_owned(),
   379	            chunk_rows: 16384,
   380	        })
   381	        .unwrap();
   382	    base_log
   383	        .append(Op::AddSheet {
   384	            name: "S3".to_owned(),
   385	            chunk_rows: 16384,
   386	        })
   387	        .unwrap();
   388	    let base = base_log.export_bytes().unwrap();
   389	
   390	    // Peer A: rename sheet 0 (S1) → X.
   391	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   392	    peer_a
   393	        .append(Op::RenameSheet {
   394	            id: 0,
   395	            old_name: "S1".to_owned(),
   396	            new_name: "X".to_owned(),
   397	        })
   398	        .unwrap();
   399	    // Peer B: rename sheet 1 (S3) → X (concurrent, target collision
   400	    // triggers step 2 auto-rename to X(2)). Also writes a formula
   401	    // referencing the OLD name S3.
   402	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   403	    peer_b
   404	        .append(Op::RenameSheet {
   405	            id: 1,
   406	            old_name: "S3".to_owned(),
   407	            new_name: "X".to_owned(),
   408	        })
   409	        .unwrap();
   410	    peer_b
   411	        .append(Op::PutFormula {
   412	            sheet: 1,
   413	            row: 0,
   414	            col: 0,
   415	            text: "S3!B1".to_owned(),
   416	        })
   417	        .unwrap();
   418	
   419	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   420	    let mut wb = replay_to_workbook(&peer_a);

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_renames.rs | sed -n '364,760p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   364	// ===== Test 7: Step 2 auto-disambiguation chain =====
   365	
   366	/// **Step 3 + step-2-audit interaction**: two peers concurrently
   367	/// rename DIFFERENT sheets to the SAME target. Step 2's auto-
   368	/// disambiguation suffixes the second to `X(2)`. Peer C writes
   369	/// `=S3!A1` referencing sheet 1's original name. After merge +
   370	/// repair, the formula should rewrite to the current name of
   371	/// sheet 1, which is `X(2)`.
   372	#[test]
   373	fn repair_handles_step2_auto_disambiguation_suffix() {
   374	    // Base: 2 sheets (S1 = id 0, S3 = id 1).
   375	    let mut base_log = OpLog::new();
   376	    base_log
   377	        .append(Op::AddSheet {
   378	            name: "S1".to_owned(),
   379	            chunk_rows: 16384,
   380	        })
   381	        .unwrap();
   382	    base_log
   383	        .append(Op::AddSheet {
   384	            name: "S3".to_owned(),
   385	            chunk_rows: 16384,
   386	        })
   387	        .unwrap();
   388	    let base = base_log.export_bytes().unwrap();
   389	
   390	    // Peer A: rename sheet 0 (S1) → X.
   391	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   392	    peer_a
   393	        .append(Op::RenameSheet {
   394	            id: 0,
   395	            old_name: "S1".to_owned(),
   396	            new_name: "X".to_owned(),
   397	        })
   398	        .unwrap();
   399	    // Peer B: rename sheet 1 (S3) → X (concurrent, target collision
   400	    // triggers step 2 auto-rename to X(2)). Also writes a formula
   401	    // referencing the OLD name S3.
   402	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   403	    peer_b
   404	        .append(Op::RenameSheet {
   405	            id: 1,
   406	            old_name: "S3".to_owned(),
   407	            new_name: "X".to_owned(),
   408	        })
   409	        .unwrap();
   410	    peer_b
   411	        .append(Op::PutFormula {
   412	            sheet: 1,
   413	            row: 0,
   414	            col: 0,
   415	            text: "S3!B1".to_owned(),
   416	        })
   417	        .unwrap();
   418	
   419	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   420	    let mut wb = replay_to_workbook(&peer_a);
   421	
   422	    // Sheet 0 = "X" (peer A's rename), sheet 1 = "X(2)" (auto-disambig).
   423	    assert_eq!(wb.sheet(0).unwrap().name(), "X");
   424	    assert_eq!(wb.sheet(1).unwrap().name(), "X(2)");
   425	
   426	    repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   427	
   428	    // Sheet 1's formula referencing old S3 → rewritten to current X(2).
   429	    // Formula syntax requires quoting sheet names containing `(` or `)`,
   430	    // so the printer emits `'X(2)'!B1` (single-quoted), NOT `X(2)!B1`.
   431	    // This is correct canonical form for the formula language.
   432	    let formula_text = wb.formula_at(1, 0, 0).map(|s| s.to_string());
   433	    assert_eq!(
   434	        formula_text,
   435	        Some("'X(2)'!B1".to_string()),
   436	        "repair must rewrite to the auto-disambiguated current name X(2) \
   437	         (single-quoted because '(' requires quoting in formula syntax)"
   438	    );
   439	}
   440	
   441	// ===== Test 8: BatchCommit-wrapped rename =====
   442	
   443	/// **Step 3:** the producer-side rename emits in a `BatchCommit`
   444	/// (rename + formula rewrites together). Our repair must traverse
   445	/// BatchCommits to find nested `Op::RenameSheet`.
   446	#[test]
   447	fn repair_walks_batchcommit_nested_renames() {
   448	    let base = base_with_sheet("S").export_bytes().unwrap();
   449	
   450	    // Peer A: rename via BatchCommit (mirrors producer pattern).
   451	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   452	    peer_a
   453	        .append(Op::BatchCommit {
   454	            ops: vec![Op::RenameSheet {
   455	                id: 0,
   456	                old_name: "S".to_owned(),
   457	                new_name: "Renamed".to_owned(),
   458	            }],
   459	        })
   460	        .unwrap();
   461	
   462	    // Peer B: concurrent formula referencing old name.
   463	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   464	    peer_b
   465	        .append(Op::PutFormula {
   466	            sheet: 0,
   467	            row: 0,
   468	            col: 0,
   469	            text: "S!A1".to_owned(),
   470	        })
   471	        .unwrap();
   472	
   473	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   474	    let mut wb = replay_to_workbook(&peer_a);
   475	
   476	    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   477	    assert_eq!(
   478	        report.formulas_rewritten, 1,
   479	        "BatchCommit-nested RenameSheet must be discovered by the chain walker"
   480	    );
   481	    assert_eq!(
   482	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   483	        Some("Renamed!A1".to_string())
   484	    );
   485	}
   486	
   487	// ===== Test 9: Bidirectional merge convergence =====
   488	
   489	/// **Step 3:** repair must be deterministic across merge directions.
   490	/// Both peers, after merging each other's bytes + running repair,
   491	/// must observe identical formula text.
   492	#[test]
   493	fn repair_converges_across_merge_directions() {
   494	    let base = base_with_sheet("S").export_bytes().unwrap();
   495	
   496	    // Peer A's view: rename + put_value (for cell to reference).
   497	    // Peer B's view: formula referencing S.
   498	    let op_a = Op::RenameSheet {
   499	        id: 0,
   500	        old_name: "S".to_owned(),
   501	        new_name: "S2".to_owned(),
   502	    };
   503	    let op_b = Op::PutFormula {
   504	        sheet: 0,
   505	        row: 0,
   506	        col: 0,
   507	        text: "S!A1".to_owned(),
   508	    };
   509	
   510	    // Direction 1: A merges B.
   511	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   512	    peer_a.append(op_a.clone()).unwrap();
   513	    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
   514	    peer_b_for_a.append(op_b.clone()).unwrap();
   515	    peer_a
   516	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   517	        .unwrap();
   518	    let mut wb_a = replay_to_workbook(&peer_a);
   519	    repair_sheet_rename_chain(&mut wb_a, &peer_a).unwrap();
   520	
   521	    // Direction 2: B merges A.
   522	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   523	    peer_b.append(op_b).unwrap();
   524	    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
   525	    peer_a_for_b.append(op_a).unwrap();
   526	    peer_b
   527	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   528	        .unwrap();
   529	    let mut wb_b = replay_to_workbook(&peer_b);
   530	    repair_sheet_rename_chain(&mut wb_b, &peer_b).unwrap();
   531	
   532	    assert_eq!(
   533	        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
   534	        wb_b.formula_at(0, 0, 0).map(|s| s.to_string()),
   535	        "bidirectional convergence: formula text matches across merge directions"
   536	    );
   537	    assert_eq!(
   538	        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
   539	        Some("S2!A1".to_string())
   540	    );
   541	}
   542	
   543	// ===== Test 10: RepairReport structure =====
   544	
   545	/// **Step 3:** verify the report's structure carries useful diagnostic
   546	/// information for callers (no-fallback rule — surface what was done).
   547	#[test]
   548	fn repair_report_carries_diagnostic_information() {
   549	    let base = base_with_sheet("Sheet1").export_bytes().unwrap();
   550	
   551	    let log = merged_log_with_concurrent_ops(
   552	        &base,
   553	        Op::RenameSheet {
   554	            id: 0,
   555	            old_name: "Sheet1".to_owned(),
   556	            new_name: "Calculations".to_owned(),
   557	        },
   558	        Op::PutFormula {
   559	            sheet: 0,
   560	            row: 0,
   561	            col: 0,
   562	            text: "Sheet1!A1+Sheet1!B2".to_owned(),
   563	        },
   564	    );
   565	
   566	    let mut wb = replay_to_workbook(&log);
   567	    let report: RepairReport = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   568	
   569	    assert_eq!(report.formulas_rewritten, 1);
   570	    assert_eq!(report.sheet_rewrites.len(), 1);
   571	    let summary = &report.sheet_rewrites[0];
   572	    assert_eq!(summary.sheet, 0);
   573	    assert_eq!(summary.current_display_name, "Calculations");
   574	    // historic_canonicals contains "SHEET1" (canonical uppercase).
   575	    assert_eq!(summary.historic_canonicals, vec!["SHEET1"]);
   576	
   577	    // Verify the formula now references "Calculations" (both occurrences).
   578	    // **Audit closure (Opus LOW-2):** strengthened from "contains" to
   579	    // pin BOTH occurrences explicitly.
   580	    let f = wb.formula_at(0, 0, 0).unwrap();
   581	    assert!(
   582	        f.contains("Calculations!A1"),
   583	        "first ref must be rewritten; got: {f}"
   584	    );
   585	    assert!(
   586	        f.contains("Calculations!B2"),
   587	        "second ref must be rewritten; got: {f}"
   588	    );
   589	    assert!(
   590	        !f.contains("Sheet1!"),
   591	        "no Sheet1 references should remain; got: {f}"
   592	    );
   593	}
   594	
   595	// ===== Test 11: Step-3 audit Codex+Opus HIGH-1 (cascade closure) =====
   596	
   597	/// **Step 3 audit closure (Codex+Opus HIGH-1):** sheet 0 renamed
   598	/// `A → B`; sheet 1 (which existed initially as `B`) renamed
   599	/// `B → C`. Pre-closure both rules would land in the rule vec and
   600	/// applying them iteratively would cascade `A!X → B!X → C!X` —
   601	/// silently retargeting a formula meant for sheet 0 (now named B)
   602	/// to sheet 1. Post-closure: the rule `B → C` is SKIPPED because
   603	/// `B` is currently held by sheet 0; formula `A!X` rewrites to
   604	/// `B!X` correctly.
   605	///
   606	/// To produce this scenario via the op log: base has sheet 0 (initially
   607	/// `A`) and sheet 1 (initially `B`). One peer renames sheet 1
   608	/// `B → C` and sheet 0 `A → B`. (Order matters at producer side; here
   609	/// we batch them into a single peer's log for simplicity.)
   610	#[test]
   611	fn step3_audit_cross_sheet_cascade_does_not_corrupt_formula() {
   612	    // Base: sheet 0 = "A", sheet 1 = "B".
   613	    let mut base_log = OpLog::new();
   614	    base_log
   615	        .append(Op::AddSheet {
   616	            name: "A".to_owned(),
   617	            chunk_rows: 16384,
   618	        })
   619	        .unwrap();
   620	    base_log
   621	        .append(Op::AddSheet {
   622	            name: "B".to_owned(),
   623	            chunk_rows: 16384,
   624	        })
   625	        .unwrap();
   626	    let base = base_log.export_bytes().unwrap();
   627	
   628	    // Peer A: rename sheet 1 (B → C) AND sheet 0 (A → B). Both at peer 1.
   629	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   630	    peer_a
   631	        .append(Op::RenameSheet {
   632	            id: 1,
   633	            old_name: "B".to_owned(),
   634	            new_name: "C".to_owned(),
   635	        })
   636	        .unwrap();
   637	    peer_a
   638	        .append(Op::RenameSheet {
   639	            id: 0,
   640	            old_name: "A".to_owned(),
   641	            new_name: "B".to_owned(),
   642	        })
   643	        .unwrap();
   644	
   645	    // Peer B: concurrent formula referencing original sheet 0 by name "A".
   646	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   647	    peer_b
   648	        .append(Op::PutFormula {
   649	            sheet: 0,
   650	            row: 0,
   651	            col: 0,
   652	            text: "A!A1".to_owned(),
   653	        })
   654	        .unwrap();
   655	
   656	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   657	    let mut wb = replay_to_workbook(&peer_a);
   658	    assert_eq!(wb.sheet(0).unwrap().name(), "B");
   659	    assert_eq!(wb.sheet(1).unwrap().name(), "C");
   660	
   661	    let report = repair_sheet_rename_chain(&mut wb, &peer_a).unwrap();
   662	
   663	    // Formula must rewrite to "B!A1" (sheet 0's current name).
   664	    // Pre-closure the cascade would have produced "C!A1" (sheet 1)
   665	    // because rule (B → C) would cascade-apply to the just-rewritten
   666	    // "B!A1".
   667	    assert_eq!(
   668	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   669	        Some("B!A1".to_string()),
   670	        "post-closure: A → B applies, B → C is skipped because B is current. \
   671	         Pre-closure produced C!A1 (cascade)."
   672	    );
   673	
   674	    // The skipped rule must be recorded in the report for diagnostics.
   675	    let skipped_b_to_c: Vec<_> = report
   676	        .ambiguous_rules_skipped
   677	        .iter()
   678	        .filter(|s| s.historic_canonical == "B")
   679	        .collect();
   680	    assert_eq!(
   681	        skipped_b_to_c.len(),
   682	        1,
   683	        "rule with old='B' must be reported as ambiguous-skipped (current holder = sheet 0)"
   684	    );
   685	    assert_eq!(skipped_b_to_c[0].origin_sheet, 1);
   686	    assert_eq!(skipped_b_to_c[0].current_holder_sheet, 0);
   687	}
   688	
   689	// ===== Test 12: Step-3 audit Codex HIGH-2 (reused name closure) =====
   690	
   691	/// **Step 3 audit closure (Codex HIGH-2):** sheet S renamed to T;
   692	/// later a NEW sheet named S is added. A formula `=S!A1` written
   693	/// after the new S is added INTENDS the new S. Pre-closure: the
   694	/// historic rule `S → T` would rewrite the valid current reference
   695	/// to `T!A1`. Post-closure: the rule is SKIPPED because S is
   696	/// currently held by sheet 1 (the new S).
   697	#[test]
   698	fn step3_audit_historic_name_reused_by_new_sheet_does_not_corrupt() {
   699	    // Build log: sheet 0 added as "S", renamed to "T", sheet 1 added
   700	    // as "S" (now a different sheet), formula `=S!A1` on sheet 1.
   701	    let mut log = OpLog::new();
   702	    log.append(Op::AddSheet {
   703	        name: "S".to_owned(),
   704	        chunk_rows: 16384,
   705	    })
   706	    .unwrap();
   707	    log.append(Op::RenameSheet {
   708	        id: 0,
   709	        old_name: "S".to_owned(),
   710	        new_name: "T".to_owned(),
   711	    })
   712	    .unwrap();
   713	    log.append(Op::AddSheet {
   714	        name: "S".to_owned(),
   715	        chunk_rows: 16384,
   716	    })
   717	    .unwrap();
   718	    log.append(Op::PutFormula {
   719	        sheet: 1,
   720	        row: 0,
   721	        col: 0,
   722	        text: "S!A1".to_owned(),
   723	    })
   724	    .unwrap();
   725	
   726	    let mut wb = replay_to_workbook(&log);
   727	    assert_eq!(wb.sheet(0).unwrap().name(), "T");
   728	    assert_eq!(wb.sheet(1).unwrap().name(), "S");
   729	
   730	    let report = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   731	
   732	    // Formula `=S!A1` must NOT be rewritten — S is now sheet 1.
   733	    assert_eq!(
   734	        wb.formula_at(1, 0, 0).map(|s| s.to_string()),
   735	        Some("S!A1".to_string()),
   736	        "post-closure: rule S → T is skipped (S is current sheet 1's name); \
   737	         formula stays valid. Pre-closure would have rewritten to T!A1."
   738	    );
   739	    assert_eq!(
   740	        report.formulas_rewritten, 0,
   741	        "no formulas should be rewritten (the only candidate rule was skipped)"
   742	    );
   743	
   744	    // Report MUST surface the skipped rule.
   745	    let skipped: Vec<_> = report
   746	        .ambiguous_rules_skipped
   747	        .iter()
   748	        .filter(|s| s.historic_canonical == "S")
   749	        .collect();
   750	    assert_eq!(skipped.len(), 1);
   751	    assert_eq!(skipped[0].origin_sheet, 0);
   752	    assert_eq!(skipped[0].current_holder_sheet, 1);
   753	}
   754	
   755	// ===== Test 13: cross-sheet formula reference (Opus LOW-1) =====
   756	
   757	/// **Step 3 audit closure (Opus LOW-1):** formula lives on sheet T,
   758	/// references renamed sheet S. The repair must rewrite refs in
   759	/// formulas regardless of which sheet holds the formula. Most
   760	/// tests put the formula on the renamed sheet itself; this pins

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_tables.rs | sed -n '351,760p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   351	// ===== Test 5: Idempotency =====
   352	
   353	#[test]
   354	fn table_repair_is_idempotent() {
   355	    let base = base_with_table("T").export_bytes().unwrap();
   356	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   357	    peer_a
   358	        .append(Op::RenameTable {
   359	            old_name: "T".to_owned(),
   360	            new_name: "T2".to_owned(),
   361	        })
   362	        .unwrap();
   363	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   364	    peer_b
   365	        .append(Op::PutFormula {
   366	            sheet: 0,
   367	            row: 5,
   368	            col: 0,
   369	            text: "T[A]".to_owned(),
   370	        })
   371	        .unwrap();
   372	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   373	    let mut wb = replay_to_workbook(&peer_a);
   374	
   375	    let first = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   376	    let after_first = wb.formula_at(0, 5, 0).map(|s| s.to_string());
   377	    let second = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   378	    let after_second = wb.formula_at(0, 5, 0).map(|s| s.to_string());
   379	
   380	    assert_eq!(first.formulas_rewritten, 1);
   381	    assert_eq!(second.formulas_rewritten, 0);
   382	    assert_eq!(after_first, after_second);
   383	}
   384	
   385	// ===== Test 6: Reused-name safety guard =====
   386	
   387	/// Table T renamed to T2; a NEW table named T is later created.
   388	/// A formula `=T[A]` (intending the new T) must NOT be rewritten to
   389	/// `=T2[A]`. Step 3 audit safety guard applies to tables too.
   390	#[test]
   391	fn step4_audit_reused_table_name_safety_guard() {
   392	    let mut log = OpLog::new();
   393	    log.append(Op::AddSheet {
   394	        name: "S".to_owned(),
   395	        chunk_rows: 16384,
   396	    })
   397	    .unwrap();
   398	    log.append(Op::CreateTable {
   399	        name: "T".to_owned(),
   400	        sheet: 0,
   401	        top_row: 0,
   402	        top_col: 0,
   403	        rows: 2,
   404	        cols: 1,
   405	        has_header: true,
   406	        has_totals: false,
   407	        column_names: vec!["A".to_owned()],
   408	    })
   409	    .unwrap();
   410	    log.append(Op::RenameTable {
   411	        old_name: "T".to_owned(),
   412	        new_name: "T2".to_owned(),
   413	    })
   414	    .unwrap();
   415	    // NEW table T created after the rename (sheet S = sheet 0, this
   416	    // table fits at rows 5..=6 below the original).
   417	    log.append(Op::CreateTable {
   418	        name: "T".to_owned(),
   419	        sheet: 0,
   420	        top_row: 5,
   421	        top_col: 0,
   422	        rows: 2,
   423	        cols: 1,
   424	        has_header: true,
   425	        has_totals: false,
   426	        column_names: vec!["A".to_owned()],
   427	    })
   428	    .unwrap();
   429	    // Formula written AFTER the new T is created, intending the new T.
   430	    log.append(Op::PutFormula {
   431	        sheet: 0,
   432	        row: 10,
   433	        col: 0,
   434	        text: "T[A]".to_owned(),
   435	    })
   436	    .unwrap();
   437	
   438	    let mut wb = replay_to_workbook(&log);
   439	    let report = repair_table_rename_chain(&mut wb, &log).unwrap();
   440	
   441	    // Formula must NOT be rewritten — T is currently a live table.
   442	    assert_eq!(
   443	        wb.formula_at(0, 10, 0).map(|s| s.to_string()),
   444	        Some("T[A]".to_string()),
   445	        "safety guard: rule T → T2 is skipped because T is currently held by another table"
   446	    );
   447	    assert_eq!(report.formulas_rewritten, 0);
   448	    // The skipped rule is reported.
   449	    assert!(
   450	        report
   451	            .ambiguous_rules_skipped
   452	            .iter()
   453	            .any(|s| s.historic_canonical == "T"),
   454	        "skipped rule must be surfaced for diagnostics"
   455	    );
   456	}

exec
/bin/zsh -lc "rg -n \"ql_formula_syntax::lex\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/repair.rs:355:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-collab/src/repair.rs:548:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:43:    let tokens = ql_formula_syntax::lex(stripped).ok()?;

exec
/bin/zsh -lc "rg -n \"SheetRenameNameMismatch\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:154:    SheetRenameNameMismatch {
quantbook-engine/crates/ql-oplog/src/replay.rs:1793:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/crates/ql-oplog/src/op.rs:109:    /// match the current sheet name (`SheetRenameNameMismatch`); under
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).

exec
/bin/zsh -lc "rg -n \"set_peer_id|fork_with_peer|OpLog::import_bytes|import_bytes\\(\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/log.rs:66:/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
quantbook-engine/crates/ql-oplog/src/log.rs:159:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:170:    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
quantbook-engine/crates/ql-oplog/src/log.rs:190:    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
quantbook-engine/crates/ql-oplog/src/log.rs:204:    /// `OpLog::set_peer_id` that bypass the CollabSession constructor.
quantbook-engine/crates/ql-oplog/src/log.rs:205:    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:209:             OpLog::set_peer_id must be called with a non-zero peer; collides with LEGACY_PEER otherwise."
quantbook-engine/crates/ql-oplog/src/log.rs:211:        self.doc.set_peer_id(peer)?;
quantbook-engine/crates/ql-oplog/src/log.rs:296:    /// Callers MUST construct the manager AFTER `set_peer_id` and
quantbook-engine/crates/ql-oplog/src/log.rs:333:    pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:463:        let restored = OpLog::import_bytes(&bytes).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:473:        let restored = OpLog::import_bytes(&bytes).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:481:        let result = OpLog::import_bytes(bytes);
quantbook-engine/crates/ql-oplog/src/log.rs:489:    fn set_peer_id_changes_doc_peer_id() {
quantbook-engine/crates/ql-oplog/src/log.rs:492:        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:494:        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
quantbook-engine/crates/ql-oplog/src/log.rs:498:    fn set_peer_id_after_import_works() {
quantbook-engine/crates/ql-oplog/src/log.rs:501:        origin.set_peer_id(11).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:510:        let mut reborn = OpLog::import_bytes(&bytes).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:511:        reborn.set_peer_id(22).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:562:        let restored = OpLog::import_bytes(&bytes).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:582:        base.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:585:        let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:586:        peer_a.set_peer_id(10).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:591:        let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:592:        peer_b.set_peer_id(20).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:632:    fn set_peer_id_max_is_rejected_as_loro_sentinel() {
quantbook-engine/crates/ql-oplog/src/log.rs:637:        let result = log.set_peer_id(u64::MAX);
quantbook-engine/crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs:76:    let log = OpLog::import_bytes(&bytes).expect(
quantbook-engine/crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs:112:    let log = OpLog::import_bytes(&bytes).expect("framing succeeds");
quantbook-engine/crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs:130:    let log = OpLog::import_bytes(&bytes).expect("framing succeeds");
quantbook-engine/crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs:149:    let log = OpLog::import_bytes(&bytes).expect("framing succeeds");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:20://! `fork_with_peer(base, peer_id)` inlined here because it lives in
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:36:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:37:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:38:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:39:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:76:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:84:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:97:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:105:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:148:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:156:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:169:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:177:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:210:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:221:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:256:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:264:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:278:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:287:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:342:        let mut log = fork_with_peer(&base, peer_id);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:430:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:438:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:451:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:459:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:21:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:22:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:23:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:24:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:70:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:77:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:135:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:142:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:173:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:181:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:216:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:224:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:437:    let restored = OpLog::import_bytes(&bytes).unwrap();
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:35:    let r = try_catch(|| OpLog::import_bytes(&bytes));
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:54:        let r = try_catch(|| OpLog::import_bytes(truncated));
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:82:        let r = try_catch(|| OpLog::import_bytes(&bytes));
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:93:    let r = try_catch(|| OpLog::import_bytes(&[]));
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:103:    let r = try_catch(|| OpLog::import_bytes(&bytes));
quantbook-engine/crates/ql-collab/src/undo.rs:56://!   `OpLog::set_peer_id` is callable but doing so mid-stream
quantbook-engine/crates/ql-collab/src/lib.rs:49://!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
quantbook-engine/crates/ql-collab/src/lib.rs:60://!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:13://!   2. Fork peer A + peer B via `fork_with_peer`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:32:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:33:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:34:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:35:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:62:    let mut peer_a = fork_with_peer(base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:64:    let mut peer_b = fork_with_peer(base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:138:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:155:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:189:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:206:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:255:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:265:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:391:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:402:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:451:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:463:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:511:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:513:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:522:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:524:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:629:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:646:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/src/presence.rs:46://! `OpLog::set_peer_id` and `CollabSession::new`.
quantbook-engine/crates/ql-types/src/peer.rs:33://! - `ql_oplog::OpLog::set_peer_id` — wires through to Loro's
quantbook-engine/crates/ql-types/src/peer.rs:34://!   `LoroDoc::set_peer_id` so concurrent appends carry the right
quantbook-engine/crates/ql-types/src/peer.rs:64:    /// (`LoroDoc::set_peer_id` takes `u64`).
quantbook-engine/crates/ql-collab/src/session.rs:32://!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
quantbook-engine/crates/ql-collab/src/session.rs:33://!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
quantbook-engine/crates/ql-collab/src/session.rs:152:    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
quantbook-engine/crates/ql-collab/src/session.rs:156:    /// **Caller pitfalls** (from `OpLog::set_peer_id`):
quantbook-engine/crates/ql-collab/src/session.rs:173:    /// regardless of build profile. Centralized in `OpLog::set_peer_id`
quantbook-engine/crates/ql-collab/src/session.rs:183:        log.set_peer_id(peer_id.as_u64())?;
quantbook-engine/crates/ql-collab/src/session.rs:208:    ///   concurrent session — see `OpLog::set_peer_id` for details.
quantbook-engine/crates/ql-collab/src/session.rs:223:        let mut log = OpLog::import_bytes(bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:224:        log.set_peer_id(peer_id.as_u64())?;
quantbook-engine/crates/ql-collab/src/session.rs:818:        // CollabSession but never passed to LoroDoc::set_peer_id, so
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:19:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:20:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:21:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:22:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:66:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:73:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:160:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:167:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:233:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:240:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:269:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:283:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:317:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:327:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:356:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:363:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-io/src/oplog_persistence.rs:294:        let oplog = OpLog::import_bytes(loro_bytes)?;
quantbook-engine/crates/ql-io/src/oplog_persistence.rs:312:        let oplog = OpLog::import_bytes(bytes)?;
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:226:    let restored = OpLog::import_bytes(&bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:64:    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:75:    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:117:    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:127:    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:163:    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:173:    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:204:    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:214:    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:231:    let reloaded = OpLog::import_bytes(&merged_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:13://!   2. Fork peer A + peer B by `import_bytes(&base_bytes)`.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:110:/// Both ids are non-zero (LEGACY_PEER reservation — `set_peer_id(0)`
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:119:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:120:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:121:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:122:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:134:    let mut peer_a = fork_with_peer(base_bytes, PEER_A_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:137:    let mut peer_b_for_a = fork_with_peer(base_bytes, PEER_B_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:144:    let mut peer_b = fork_with_peer(base_bytes, PEER_B_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:147:    let mut peer_a_for_b = fork_with_peer(base_bytes, PEER_A_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:536:    let mut peer_a = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:537:    peer_a.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:545:    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:546:    peer_b_for_a.set_peer_id(2).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:560:    let mut peer_b = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:561:    peer_b.set_peer_id(2).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:570:    let mut peer_a_for_b = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:571:    peer_a_for_b.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:688:/// **Audit closure (Opus LOW-1):** switched to `fork_with_peer` for
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:690:/// `OpLog::import_bytes` without `set_peer_id` — it happened to pass
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:694:/// convergence. Using `fork_with_peer` makes the pattern uniform.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:699:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:708:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:722:    let reloaded = OpLog::import_bytes(&merged_bytes).unwrap();

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs | sed -n '1,110p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs | sed -n '250,540p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Sheet mutation API for `WorkbookRuntime`.
     2	//!
     3	//! Tier D1 Step 3.3 (2026-05-18): extracted from `mod.rs` per
     4	//! `docs/architecture/workbook-runtime-split-design.md`. Two
     5	//! producer-side sheet methods + a tokenization-aware formula-text
     6	//! rewriter helper used by rename_sheet. Pure code move; no
     7	//! behavior change.
     8	//!
     9	//! Methods:
    10	//! - [`WorkbookRuntime::add_sheet`] (W5-92) — append a new sheet,
    11	//!   validate name + chunk_rows, emit `Op::AddSheet`.
    12	//! - [`WorkbookRuntime::rename_sheet`] (W5-91) — rename by id,
    13	//!   rewrite cross-sheet refs in stored formula text via
    14	//!   lex→parse→rewrite→print, emit `BatchCommit` containing every
    15	//!   `PutFormula` rewrite + the `RenameSheet` op.
    16	
    17	use std::sync::Arc;
    18	
    19	use ql_oplog::Op;
    20	use ql_types::{ColId, RowId, SheetId};
    21	
    22	use super::{RuntimeError, WorkbookRuntime};
    23	
    24	/// **W5-91 (Phase 4.6.C):** rewrite cross-sheet refs in a formula text
    25	/// when a sheet is renamed. Round-trips `text → lex → parse → rewrite
    26	/// → print` so substitution is tokenization-aware (string literals,
    27	/// quoted-sheet escapes, function calls, etc. all get the right
    28	/// treatment).
    29	///
    30	/// Returns `Some(new_text)` if the rewrite changed the formula,
    31	/// `None` otherwise (so the caller can skip the storage write +
    32	/// op-log entry when there's nothing to record).
    33	///
    34	/// Defensive: if `lex` or `parse` fails (corrupted historical text),
    35	/// returns `None` rather than propagating an error — the rename
    36	/// shouldn't break otherwise-recoverable workbooks.
    37	fn rewrite_formula_text_for_sheet_rename(
    38	    text: &str,
    39	    old_canonical: &str,
    40	    new_name: &Arc<str>,
    41	) -> Option<String> {
    42	    let stripped = text.strip_prefix('=').unwrap_or(text);
    43	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
    44	    let expr = ql_formula_syntax::parse(tokens).ok()?;
    45	    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
    46	    if rewritten == expr {
    47	        // Nothing changed; preserve the original text (avoids spurious
    48	        // op-log entries and skips the round-trip-printing's canonical-
    49	        // form rewrites for formulas that have no sheet references).
    50	        return None;
    51	    }
    52	    let printed = ql_formula_syntax::print(&rewritten);
    53	    // Preserve a leading `=` if the original had one.
    54	    let with_eq = if text.starts_with('=') {
    55	        format!("={printed}")
    56	    } else {
    57	        printed
    58	    };
    59	    Some(with_eq)
    60	}
    61	
    62	impl<'a> WorkbookRuntime<'a> {
    63	    /// **W5-92 (Phase 4.6.D):** create a new sheet,
    64	    /// emitting `Op::AddSheet` into the attached op log (if any). Returns
    65	    /// the new sheet's `SheetId`. Wraps `Workbook::add_sheet_with_chunk_rows`.
    66	    ///
    67	    /// `chunk_rows` is the per-sheet chunk size. Pass `16_384` (the engine
    68	    /// default) unless you have a specific reason — the qbook loader uses
    69	    /// the saved chunk_rows so layouts round-trip.
    70	    ///
    71	    /// Direct callers of `Workbook::add_sheet` / `add_sheet_with_chunk_rows`
    72	    /// bypass the op log silently — that path is documented as low-level.
    73	    /// See GAP-O-02 in `docs/known-gaps.md`.
    74	    pub fn add_sheet(
    75	        &mut self,
    76	        name: impl Into<String>,
    77	        chunk_rows: u32,
    78	    ) -> Result<SheetId, RuntimeError> {
    79	        // Phase 2B.7 audit H1: pre-validate inputs BEFORE the op-log append
    80	        // so a bad value can't leave a phantom AddSheet in the log followed
    81	        // by a process-killing panic from `ColumnStore::with_chunk_rows` or
    82	        // `Workbook::add_sheet_with_chunk_rows` (assert on `id >= SheetId::MAX`).
    83	        if chunk_rows == 0 {
    84	            return Err(RuntimeError::InvalidChunkRows(chunk_rows));
    85	        }
    86	        let current_sheet_count = self.workbook.sheet_count() as u32;
    87	        if current_sheet_count >= SheetId::MAX as u32 {
    88	            return Err(RuntimeError::TooManySheets {
    89	                current: current_sheet_count,
    90	                max: SheetId::MAX as u32,
    91	            });
    92	        }
    93	
    94	        let name: String = name.into();
    95	        // **W5-93 (Phase 4.6.E closure):** pre-validate the name BEFORE
    96	        // appending to the op log so a duplicate or reserved-char name
    97	        // can't leave a phantom `AddSheet` entry followed by a failed
    98	        // mutation. Codex HIGH-1 flagged that the prior path silently
    99	        // accepted any name at the storage boundary.
   100	        self.workbook
   101	            .validate_sheet_name(&name)
   102	            .map_err(RuntimeError::SheetName)?;
   103	        if let Some(oplog) = self.oplog.as_deref_mut() {
   104	            oplog.append(Op::AddSheet {
   105	                name: name.clone(),
   106	                chunk_rows,
   107	            })?;
   108	        }
   109	        // Now infallible: validation already passed, so the storage call
   110	        // can't return an error. Routes through the panicking convenience

 succeeded in 0ms:
   250	        // BindError::UnknownTable → emit #NAME?"). Matches the
   251	        // brute-force pattern in `rename_table` / `rename_column`
   252	        // / `resize_table`. A future polish (table_gen in the
   253	        // cache key) would replace this full flush with targeted
   254	        // invalidation.
   255	        self.plan_cache.clear();
   256	        Ok(())
   257	    }
   258	
   259	    /// **W5-119 (Phase 4.8.I):** rename a table. Per design § 12.2 + HIGH-1
   260	    /// closure (Codex pass-1), this REWRITES STORED FORMULA TEXT — Excel
   261	    /// canon: the next bind sees the new name and binds successfully.
   262	    ///
   263	    /// Process:
   264	    /// 1. Validate: source exists; target name available (TableTable +
   265	    ///    NameTable shared namespace); not a no-op (same canonical name).
   266	    /// 2. Op-log append `Op::RenameTable` (before any mutation).
   267	    /// 3. Walk every formula cell; parse the text; rewrite via
   268	    ///    `ast::rewrite_table_ref`; if the AST changed, print it back
   269	    ///    and emit `Op::PutFormula` + update storage.
   270	    /// 4. Re-key the `TableTable` entry from old canonical to new
   271	    ///    canonical; update display_name.
   272	    ///
   273	    /// Returns the number of formula cells whose text was rewritten.
   274	    ///
   275	    /// **Tier D1 Step 3.2 doc-attachment fix:** the doc block above
   276	    /// was previously misattached to `set_reference_mode` because
   277	    /// that fn was inserted between this comment and `rename_table`.
   278	    /// Step 3.2 moved the config setters to `config.rs`, so the doc
   279	    /// now reaches its intended target.
   280	    pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> {
   281	        let old_canonical = old_name.to_ascii_uppercase();
   282	        let new_canonical = new_name.to_ascii_uppercase();
   283	        if self.workbook.tables().lookup(&old_canonical).is_none() {
   284	            return Err(RuntimeError::TableNotFound(old_name.to_owned()));
   285	        }
   286	        // No-op rename (same canonical) — accept silently without
   287	        // emitting an op so the log stays compact.
   288	        if old_canonical == new_canonical {
   289	            return Ok(0);
   290	        }
   291	        // Target uniqueness.
   292	        if self.workbook.tables().lookup(&new_canonical).is_some() {
   293	            return Err(RuntimeError::TableCreateRejected {
   294	                name: new_name.to_owned(),
   295	                reason: "table with this canonical name already exists (rename target)",
   296	            });
   297	        }
   298	        if self.workbook.names().lookup_ci(&new_canonical).is_some() {
   299	            return Err(RuntimeError::TableCreateRejected {
   300	                name: new_name.to_owned(),
   301	                reason: "defined-name with this canonical name already exists (rename target)",
   302	            });
   303	        }
   304	        // Op-log append BEFORE mutation (W5-103 atomicity). We emit
   305	        // RenameTable + N PutFormula ops; if the log append fails,
   306	        // no workbook state has changed yet.
   307	        if let Some(oplog) = self.oplog.as_deref_mut() {
   308	            oplog.append(Op::RenameTable {
   309	                old_name: old_canonical.clone(),
   310	                new_name: new_canonical.clone(),
   311	            })?;
   312	        }
   313	        // Walk formula cells and rewrite. Collect first to avoid borrow
   314	        // conflicts (iter holds &workbook; rewrite needs &mut workbook).
   315	        let new_display_arc: Arc<str> = Arc::from(new_name);
   316	        let formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
   317	            .workbook
   318	            .iter_formulas()
   319	            .map(|(s, r, c, text)| (s, r, c, Arc::clone(text)))
   320	            .collect();
   321	        let mut rewritten = 0;
   322	        for (s, r, c, text) in formulas {
   323	            let tokens = match lex(text.as_ref()) {
   324	                Ok(t) => t,
   325	                Err(_) => continue, // malformed → leave alone (rewrite is best-effort)
   326	            };
   327	            let expr = match parse(tokens) {
   328	                Ok(e) => e,
   329	                Err(_) => continue,
   330	            };
   331	            let new_expr =
   332	                ql_formula_syntax::rewrite_table_ref(&expr, &old_canonical, &new_display_arc);
   333	            if new_expr == expr {
   334	                continue; // no StructuredRef references the renamed table
   335	            }
   336	            let new_text = ql_formula_syntax::print(&new_expr);
   337	            // Emit PutFormula so replay reconstructs the rewrite.
   338	            if let Some(oplog) = self.oplog.as_deref_mut() {
   339	                oplog.append(Op::PutFormula {
   340	                    sheet: s,
   341	                    row: r,
   342	                    col: c,
   343	                    text: new_text.clone(),
   344	                })?;
   345	            }
   346	            // Update workbook formula text directly (bypass set_formula
   347	            // to avoid re-running the bind eagerly; the recompute path
   348	            // will re-bind against the new name at next eval).
   349	            self.workbook.put_formula(s, r, c, new_text);
   350	            rewritten += 1;
   351	        }
   352	        // Re-key the TableTable entry.
   353	        let mut meta = self
   354	            .workbook
   355	            .tables_mut()
   356	            .remove(&old_canonical)
   357	            .expect("verified at top");
   358	        let new_canonical_arc: Arc<str> = Arc::from(new_canonical.as_str());
   359	        meta.name = Arc::clone(&new_canonical_arc);
   360	        meta.display_name = Arc::clone(&new_display_arc);
   361	        self.workbook.tables_mut().insert(new_canonical_arc, meta);
   362	        // **W5-157 (Phase 4.8.G.3):** fire the calcgraph hook to
   363	        // re-key `table_to_formulas[OLD] → [NEW]`, substitute the
   364	        // Arc<str> in each reader's `deps.tables` so a future
   365	        // `remove_formula_deps` cleans up correctly, and dirty-fan
   366	        // the readers. Without this, a subsequent `drop_table(NEW)`
   367	        // would miss every formula that previously bound against
   368	        // `OLD` (the index still keys them under the stale name).
   369	        if let Some(g) = self.graph.as_deref_mut() {
   370	            g.on_table_rename(&old_canonical, &new_canonical);
   371	        }
   372	        // Invalidate plan cache by clearing — every formula that
   373	        // referenced the OLD name now has new text, so cache lookups
   374	        // miss anyway; the bare invalidation prevents stale entries.
   375	        self.plan_cache.clear();
   376	        Ok(rewritten)
   377	    }
   378	
   379	    /// **W5-121 (Phase 4.8.I.2):** rename a column within an existing
   380	    /// table. Mirrors [`Self::rename_table`] semantics for column refs:
   381	    /// rewrites stored formula text in every cell whose StructuredRef
   382	    /// references the renamed column (Excel canon — the next bind sees
   383	    /// the new name).
   384	    ///
   385	    /// Process:
   386	    /// 1. Validate: table exists; source column exists (case-insensitive);
   387	    ///    target name available within the table; non-empty; not a no-op
   388	    ///    (same lowercase canonical).
   389	    /// 2. Op-log append `Op::RenameColumn` (before any mutation).
   390	    /// 3. Walk every formula cell; parse the text; rewrite via
   391	    ///    `ast::rewrite_column_ref` (scoped to refs matching the
   392	    ///    canonical table name); if the AST changed, print + emit
   393	    ///    `Op::PutFormula` + update storage.
   394	    /// 4. Mutate the matching `TableColumn` entry's lowercase canonical
   395	    ///    `name` and case-preserving `display`; bump TableTable
   396	    ///    generation so plan caches invalidate.
   397	    ///
   398	    /// Returns the number of formula cells whose text was rewritten.
   399	    /// Cross-table isolation: structured refs to OTHER tables pass
   400	    /// through unchanged even when they mention a column with the same
   401	    /// name. Same-canonical rename returns `Ok(0)` without emitting an
   402	    /// op (mirrors [`Self::rename_table`]).
   403	    pub fn rename_column(
   404	        &mut self,
   405	        table_name: &str,
   406	        old_col: &str,
   407	        new_col: &str,
   408	    ) -> Result<usize, RuntimeError> {
   409	        let table_canonical = table_name.to_ascii_uppercase();
   410	        // Validate table exists.
   411	        let meta = self
   412	            .workbook
   413	            .tables()
   414	            .lookup(&table_canonical)
   415	            .ok_or_else(|| RuntimeError::TableNotFound(table_name.to_owned()))?;
   416	        // Validate source column exists.
   417	        if meta.lookup_column(old_col).is_none() {
   418	            return Err(RuntimeError::TableColumnNotFound {
   419	                table: table_name.to_owned(),
   420	                column: old_col.to_owned(),
   421	            });
   422	        }
   423	        // Empty target rejected.
   424	        if new_col.is_empty() {
   425	            return Err(RuntimeError::TableColumnRejected {
   426	                table: table_name.to_owned(),
   427	                column: new_col.to_owned(),
   428	                reason: "column name cannot be empty",
   429	            });
   430	        }
   431	        // No-op rename (same lowercase canonical) — accept silently
   432	        // without emitting an op. Mirrors `rename_table`. Display-only
   433	        // case rename is deferred to a future sub-phase.
   434	        let old_lower = old_col.to_ascii_lowercase();
   435	        let new_lower = new_col.to_ascii_lowercase();
   436	        if old_lower == new_lower {
   437	            return Ok(0);
   438	        }
   439	        // Target uniqueness within the table.
   440	        if meta.lookup_column(new_col).is_some() {
   441	            return Err(RuntimeError::TableColumnRejected {
   442	                table: table_name.to_owned(),
   443	                column: new_col.to_owned(),
   444	                reason: "column with this canonical name already exists (rename target)",
   445	            });
   446	        }
   447	        // Op-log append BEFORE mutation (W5-103 atomicity). RenameColumn
   448	        // + N PutFormula ops; if the log append fails, no workbook state
   449	        // has changed yet.
   450	        if let Some(oplog) = self.oplog.as_deref_mut() {
   451	            oplog.append(Op::RenameColumn {
   452	                table: table_canonical.clone(),
   453	                old_name: old_col.to_owned(),
   454	                new_name: new_col.to_owned(),
   455	            })?;
   456	        }
   457	        // Walk formula cells and rewrite. Collect first to avoid borrow
   458	        // conflicts (iter holds &workbook; rewrite needs &mut workbook).
   459	        let new_display_arc: Arc<str> = Arc::from(new_col);
   460	        let formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
   461	            .workbook
   462	            .iter_formulas()
   463	            .map(|(s, r, c, text)| (s, r, c, Arc::clone(text)))
   464	            .collect();
   465	        let mut rewritten = 0;
   466	        for (s, r, c, text) in formulas {
   467	            let tokens = match lex(text.as_ref()) {
   468	                Ok(t) => t,
   469	                Err(_) => continue,
   470	            };
   471	            let expr = match parse(tokens) {
   472	                Ok(e) => e,
   473	                Err(_) => continue,
   474	            };
   475	            let new_expr = ql_formula_syntax::rewrite_column_ref(
   476	                &expr,
   477	                &table_canonical,
   478	                old_col,
   479	                &new_display_arc,
   480	            );
   481	            if new_expr == expr {
   482	                continue;
   483	            }
   484	            let new_text = ql_formula_syntax::print(&new_expr);
   485	            if let Some(oplog) = self.oplog.as_deref_mut() {
   486	                oplog.append(Op::PutFormula {
   487	                    sheet: s,
   488	                    row: r,
   489	                    col: c,
   490	                    text: new_text.clone(),
   491	                })?;
   492	            }
   493	            self.workbook.put_formula(s, r, c, new_text);
   494	            rewritten += 1;
   495	        }
   496	        // Mutate the column metadata in place.
   497	        let meta = self
   498	            .workbook
   499	            .tables_mut()
   500	            .get_mut(&table_canonical)
   501	            .expect("verified at top");
   502	        let (col_idx, _) = meta
   503	            .lookup_column(old_col)
   504	            .expect("verified at top before any mutation");
   505	        meta.columns[col_idx as usize].name = Arc::from(new_lower.as_str());
   506	        meta.columns[col_idx as usize].display = Arc::clone(&new_display_arc);
   507	        // `get_mut` doesn't bump generation; do it explicitly so plan
   508	        // caches keyed on `TableTable::generation` invalidate.
   509	        self.workbook.tables_mut().bump_generation();
   510	        // **W5-158 (Phase 4.8.G.3):** fire the calcgraph hook so the
   511	        // dirty set picks up every reader of this table. Coarse —
   512	        // table-keyed rather than column-keyed (the reverse index
   513	        // doesn't track columns). VEQ at recompute time suppresses
   514	        // the typical no-op writes; the hook's value is keeping
   515	        // the post-rename plan cache + dirty state machine
   516	        // consistent for downstream tooling (debug, ql-profile).
   517	        if let Some(g) = self.graph.as_deref_mut() {
   518	            g.on_column_rename(&table_canonical, old_col, new_col);
   519	        }
   520	        // Invalidate plan cache by clearing — every formula that
   521	        // referenced the OLD column now has new text, so cache lookups
   522	        // miss anyway; bare invalidation prevents stale entries.
   523	        self.plan_cache.clear();
   524	        Ok(rewritten)
   525	    }
   526	
   527	    /// **W5-122 (Phase 4.8.J):** resize a table's footprint per
   528	    /// design § 12.3. Three scenarios are supported by a single op:
   529	    ///
   530	    /// - **Grow / shrink rows:** common path. Pass `added_columns =
   531	    ///   removed_columns = []` and the new row count.
   532	    /// - **Append column(s) at the END:** list each new display name
   533	    ///   in `added_columns`; column ids are freshly allocated.
   534	    /// - **Truncate trailing column(s):** list each in
   535	    ///   `removed_columns` in their current left-to-right order
   536	    ///   (case-insensitive on display).
   537	    ///
   538	    /// Inserting / removing a column in the MIDDLE is NOT supported in
   539	    /// 4.8 (Phase 5 structural edits — requires physical cell move).
   540	    ///

exec
/bin/zsh -lc "rg -n \"rewrite_.*(sheet|table|column)|rewrite_sheet_name|rewrite_table_ref|rewrite_column|parse\\(|lex\\(\" quantbook-engine/crates/ql-exec/src/workbook_runtime quantbook-engine/crates/ql-collab/src/repair.rs -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"pub fn rewrite|fn rewrite|rewrite_table_ref|rewrite_sheet_name_in_expr|rewrite_column\" quantbook-engine/crates/ql-formula-syntax/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/repair.rs:11://! in-place via the existing `ql_formula_syntax::rewrite_sheet_name_in_expr`
quantbook-engine/crates/ql-collab/src/repair.rs:333:/// `ql_formula_syntax::{lex, parse, rewrite_sheet_name_in_expr, print}`.
quantbook-engine/crates/ql-collab/src/repair.rs:336:/// promote this + `rewrite_formula_with_table_rename` +
quantbook-engine/crates/ql-collab/src/repair.rs:337:/// `rewrite_formula_with_column_rename` (this module) AND
quantbook-engine/crates/ql-collab/src/repair.rs:338:/// `rewrite_formula_text_for_sheet_rename` (sheets.rs:37-60) AND
quantbook-engine/crates/ql-collab/src/repair.rs:355:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-collab/src/repair.rs:356:    let expr = ql_formula_syntax::parse(tokens).ok()?;
quantbook-engine/crates/ql-collab/src/repair.rs:357:    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
quantbook-engine/crates/ql-collab/src/repair.rs:480:                rewrite_formula_with_table_rename(&current_text, old_canonical, new_display)
quantbook-engine/crates/ql-collab/src/repair.rs:541:/// through `ql_formula_syntax::rewrite_table_ref`.
quantbook-engine/crates/ql-collab/src/repair.rs:542:fn rewrite_formula_with_table_rename(
quantbook-engine/crates/ql-collab/src/repair.rs:548:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-collab/src/repair.rs:549:    let expr = ql_formula_syntax::parse(tokens).ok()?;
quantbook-engine/crates/ql-collab/src/repair.rs:550:    let rewritten = ql_formula_syntax::rewrite_table_ref(&expr, old_canonical, new_name);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:75:        let tokens = lex(formula_text)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:76:        let expr = parse(tokens)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:268:    ///    `ast::rewrite_table_ref`; if the AST changed, print it back
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:323:            let tokens = match lex(text.as_ref()) {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:327:            let expr = match parse(tokens) {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:332:                ql_formula_syntax::rewrite_table_ref(&expr, &old_canonical, &new_display_arc);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:391:    ///    `ast::rewrite_column_ref` (scoped to refs matching the
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:467:            let tokens = match lex(text.as_ref()) {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:471:            let expr = match parse(tokens) {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:475:            let new_expr = ql_formula_syntax::rewrite_column_ref(
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:832:                    let expr = parse(tokens)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:200:                .and_then(|s| format::parse(s).ok());
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:203:                format::parse("General").expect("'General' is a valid format string")
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:545:                                            let tokens = lex(reader_text.as_ref())?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:546:                                            let expr = parse(tokens)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:759:                    let expr = parse(tokens)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2597:        let tokens = lex("A1 * 2").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2598:        let expr = parse(tokens).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2623:        let tokens = lex("A1 / 2").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2624:        let expr = parse(tokens).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:89:        let expr = parse(tokens)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:538:                    let tokens = lex(text.as_ref())?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:539:                    let expr = parse(tokens)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:93:/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:37:fn rewrite_formula_text_for_sheet_rename(
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:43:    let tokens = ql_formula_syntax::lex(stripped).ok()?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:44:    let expr = ql_formula_syntax::parse(tokens).ok()?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:45:    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:174:                rewrite_formula_text_for_sheet_rename(text.as_ref(), &old_canonical, &new_name_arc)

 succeeded in 0ms:
quantbook-engine/crates/ql-formula-syntax/src/printer.rs:330:/// The current `rewrite_sheet_name_in_expr` path walks pre-bind
quantbook-engine/crates/ql-formula-syntax/src/lib.rs:47:    rewrite_column_ref, rewrite_sheet_name_in_expr, rewrite_table_ref, CellAddr, Expr, RangeRef,
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:282:pub fn rewrite_sheet_name_in_expr(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:299:            lhs: Box::new(rewrite_sheet_name_in_expr(lhs, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:300:            rhs: Box::new(rewrite_sheet_name_in_expr(rhs, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:304:            operand: Box::new(rewrite_sheet_name_in_expr(operand, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:310:                .map(|a| rewrite_sheet_name_in_expr(a, old_canonical, new_name))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:317:                        .map(|cell| rewrite_sheet_name_in_expr(cell, old_canonical, new_name))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:322:        Expr::Spill(inner) => Expr::Spill(Box::new(rewrite_sheet_name_in_expr(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:349:            rewrite_sheet_name_in_expr(inner, old_canonical, new_name),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:356:/// Mirrors [`rewrite_sheet_name_in_expr`] in spirit but for tables.
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:361:pub fn rewrite_table_ref(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:372:            lhs: Box::new(rewrite_table_ref(lhs, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:373:            rhs: Box::new(rewrite_table_ref(rhs, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:377:            operand: Box::new(rewrite_table_ref(operand, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:383:                .map(|a| rewrite_table_ref(a, old_canonical, new_name))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:390:                        .map(|cell| rewrite_table_ref(cell, old_canonical, new_name))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:396:            Expr::Spill(Box::new(rewrite_table_ref(inner, old_canonical, new_name)))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:425:            Expr::ImplicitIntersection(Box::new(rewrite_table_ref(inner, old_canonical, new_name)))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:434:/// Sibling of [`rewrite_table_ref`]; used by
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:443:pub fn rewrite_column_ref(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:459:            lhs: Box::new(rewrite_column_ref(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:465:            rhs: Box::new(rewrite_column_ref(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:474:            operand: Box::new(rewrite_column_ref(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:485:                .map(|a| rewrite_column_ref(a, table_canonical_upper, old_col, new_col))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:493:                            rewrite_column_ref(cell, table_canonical_upper, old_col, new_col)
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:499:        Expr::Spill(inner) => Expr::Spill(Box::new(rewrite_column_ref(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:519:            rewrite_column_ref(inner, table_canonical_upper, old_col, new_col),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:537:fn rewrite_spec_column(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:579:fn rewrite_spec_item_column(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:609:fn rewrite_sheet_ref(sheet: &SheetRef, old_canonical: &str, new_name: &Arc<str>) -> SheetRef {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:618:fn rewrite_range_ref(r: &RangeRef, old_canonical: &str, new_name: &Arc<str>) -> RangeRef {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:929:    // W5-91 (Phase 4.6.C) — rewrite_sheet_name_in_expr coverage.
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:942:    fn rewrite_renames_matching_cellref_sheet_name() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:945:        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:956:    fn rewrite_skips_current_and_id_sheet_refs() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:960:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:966:        let out_id = rewrite_sheet_name_in_expr(&expr_id, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:971:    fn rewrite_non_matching_name_passes_through() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:974:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:979:    fn rewrite_recurses_into_binary_and_function() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:991:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1017:    fn rewrite_recurses_into_rangeref_cells() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1030:        let out = rewrite_sheet_name_in_expr(&rng, "OLDSHEET", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1041:    fn rewrite_is_case_insensitive_on_match() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1045:        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1057:    // `rewrite_column_ref` was previously tested only transitively via
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1072:    fn rewrite_column_ref_string_literal_is_immune() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1078:        let out = rewrite_column_ref(&expr, "SALES", "Qty", &new_col);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1086:    fn rewrite_column_ref_special_item_passes_through() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1094:        let out = rewrite_column_ref(&sref("Sales", spec), "SALES", "Qty", &new_col);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1115:    fn rewrite_column_ref_this_row_column_range_rewrites_both_endpoints() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1121:        let out = rewrite_column_ref(&sref("Sales", spec), "SALES", "Qty", &new_col);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1135:    fn rewrite_column_ref_column_range_rewrites_only_matching_endpoint() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1143:        let out = rewrite_column_ref(&sref("Sales", spec), "SALES", "Qty", &new_col);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1160:    fn rewrite_column_ref_cross_table_isolation_holds() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1163:        // unchanged. This is the guard at `rewrite_column_ref`'s
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1168:        let out = rewrite_column_ref(&sref("Inventory", spec), "SALES", "Qty", &new_col);

exec
/bin/zsh -lc "sed -n '1,80p' quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Table mutation API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.5 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Six
//! producer-side table methods + a private re-extract helper.
//! Pure code move; no behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::create_table`] (W5-118) — register a new
//!   workbook-scoped table with column validation, footprint
//!   uniqueness, name collision, op-log emission.
//! - [`WorkbookRuntime::drop_table`] (W5-118) — drop a table,
//!   surface a dropped-table BindError on next recompute of any
//!   formula that referenced it (design § 12.4).
//! - [`WorkbookRuntime::rename_table`] (W5-119) — rename + rewrite
//!   every `Table[Col]` reference in stored formula text via
//!   lex→parse→rewrite→print, emit BatchCommit atomically.
//! - [`WorkbookRuntime::rename_column`] (W5-121) — rename a column
//!   inside a table, rewrite stored formula text.
//! - [`WorkbookRuntime::resize_table`] (W5-122) — change a table's
//!   row/column footprint with validation.
//! - `reextract_table_readers` (private helper) — re-extract calc
//!   graph dep info for every formula that references a renamed
//!   table.

use std::sync::Arc;

use ql_formula_syntax::{lex, lex_with, parse};
use ql_oplog::Op;
use ql_types::{ColId, RowId, SheetId};

use crate::plan::{bind_with_site, BindSite};
use crate::plan_cache::PlanCacheKey;

use super::{RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    // ===== W5-118 (Phase 4.8.H) — table mutation API =====

    /// **W5-118 (Phase 4.8.H):** register a new workbook-scoped table,
    /// emitting `Op::CreateTable` into the attached op log (if any).
    ///
    /// Validation (op log append is BEFORE storage mutation per the
    /// W5-103 atomicity pattern):
    /// - Sheet exists.
    /// - Footprint fits in the sheet (rows + cols > 0).
    /// - No overlap with any existing table footprint.
    /// - Name is unique against both `TableTable` AND `NameTable`
    ///   (shared namespace per design § 4.3 / § 13 decision #3).
    /// - Column count matches `column_names.len()`.
    /// - Column names are non-empty and unique case-insensitively.
    ///
    /// Each column is assigned a stable id from
    /// `TableTable::allocate_column_id`. Header / totals rows are
    /// metadata-only — this method does NOT write into the header row;
    /// callers can pre-populate cells via `set_value`.
    ///
    /// Direct callers of `Workbook::tables_mut().insert` bypass the op
    /// log silently — that path is documented as low-level (qbook
    /// loader + tests).
    #[allow(clippy::too_many_arguments)]
    pub fn create_table(
        &mut self,
        name: &str,
        sheet: SheetId,
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
        has_header: bool,
        has_totals: bool,
        column_names: Vec<String>,
    ) -> Result<(), RuntimeError> {
        let canonical = name.to_ascii_uppercase();
        // ----- Validation (all checks BEFORE op-log append) -----
        let sheet_count = self.workbook.sheet_count();
        if self.workbook.sheet(sheet).is_none() {
            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
        }
        if rows == 0 || cols == 0 {

codex
For helper duplication, the exact `ql_formula_syntax::lex` grep is 3, but the duplicate rewrite pattern is actually 5 because table/column producer code imports `lex` unqualified. I’m checking the public-contract docs next, then I’ll run targeted tests/probes rather than relying on comments.
exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/ide-consumer-contract.md | sed -n '1,260p;260,560p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	# IDE consumer contract
     2	
     3	**Status:** Engine Phase 2B.6 — first vertical-slice surface  
     4	**Date:** 2026-05-12  
     5	**Stability:** **DRAFT** — names + shapes will change as Engine Phase 6.1 (Stable Engine Session API) formalizes them. This document is the SPEC that 6.1 will harden.
     6	
     7	This document describes how the Quantlab IDE (`extensions/quantlab/`, a separate worktree) consumes the Quantbook engine. It is informed by the IDE-2B-01..05 acceptance criteria in `docs/MASTER-PLAN.md` Phase 2B.6 and exercised in `crates/ql-exec/tests/ide_simulation.rs`.
     8	
     9	## 1. Lifecycle (one workbook session)
    10	
    11	```text
    12	                                         ┌────────────────────────────┐
    13	   IDE opens .qbook                      │ engine state:              │
    14	   ────────────►  load_workbook_with_oplog─►  Workbook + OpLog        │
    15	                                         └────────────┬───────────────┘
    16	                                                      │
    17	                                                      ▼
    18	   user types in formula bar / pastes   ┌────────────────────────────┐
    19	   ──────────────────────────────────►  │ per-edit:                  │
    20	                                         │   WorkbookRuntime::with_oplog
    21	                                         │   .set_value / .set_formula│
    22	                                         │   .transaction().commit()  │
    23	                                         └────────────┬───────────────┘
    24	                                                      │ (mutates wb, appends ops)
    25	                                                      ▼
    26	   user saves                            ┌────────────────────────────┐
    27	   ──────────────────────────────────►  │ save_workbook_with_oplog   │
    28	                                         └────────────┬───────────────┘
    29	                                                      │
    30	   user reopens                                       ▼
    31	   ──────────────────────────────────►  load_workbook_with_oplog → restored
    32	```
    33	
    34	The IDE holds three pieces of state per open workbook:
    35	
    36	| State | Type | Lifetime |
    37	|---|---|---|
    38	| `wb` | `ql_storage::Workbook` | Open until save / close |
    39	| `oplog` | `ql_oplog::OpLog` | Open until save / close. Carries mutation history. |
    40	| `registry` | `ql_functions::FunctionRegistry` | Process-wide singleton (`default_registry()`) |
    41	
    42	`WorkbookRuntime` is **per-edit**, not per-session. It borrows `&mut wb` + `&reg` + `&mut oplog` for the duration of one user action (one set_formula call, one paste transaction, one recompute). Borrowing `&mut wb` for the runtime's lifetime prevents the IDE from reading the workbook through other paths while an edit is in flight — that's intentional. The IDE typically constructs a runtime, performs ONE operation, drops the runtime, then re-reads cells for grid rendering.
    43	
    44	Engine Phase 6.1 will formalize this as a `WorkbookSession` struct that owns wb + oplog + registry, exposing edit methods directly without the borrow dance. 2B.6 doesn't ship that — the test scaffolding in `ide_simulation.rs` documents the pattern.
    45	
    46	## 2. Operations the IDE invokes
    47	
    48	### 2.1 Open / load
    49	
    50	```rust
    51	let (wb, oplog) = ql_io::load_workbook_with_oplog(path)?;
    52	```
    53	
    54	- Loads the `.qbook/` directory.
    55	- `oplog.bin` MUST be present (Phase 2A.3.c contract; load fails with `MissingFile` otherwise).
    56	- The IDE then renders the grid by walking cells via `wb.sheet(id)?.read(row, col)` for each visible cell, and `wb.formula_at(sheet, row, col)` for the formula bar.
    57	
    58	**Tier D2 (2026-05-19, `e15e8908742`):** the persistence API moved from `ql_oplog::{load,save}_workbook_with_oplog` to `ql_io::{load,save}_workbook_with_oplog`. The old import paths fail to compile.
    59	
    60	If the workbook has no op log (legacy save or external tool), use the bare `ql_io::load_workbook(path)` and construct a fresh empty `OpLog::new()` — but note that subsequent saves via `ql_io::save_workbook_with_oplog` will write the new (empty-then-growing) log over the absent one.
    61	
    62	### 2.2 Edit a single cell
    63	
    64	User types `=A1 * 2` and hits Enter:
    65	
    66	```rust
    67	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
    68	let value = rt.set_formula(sheet, row, col, "A1 * 2")?;
    69	// value is Value::Number(20.0) given A1=10
    70	// rt drops; wb + oplog observable again
    71	```
    72	
    73	The IDE renders `value` in the cell. If `set_formula` returns `Err(RuntimeError::...)`:
    74	- The Display string is user-facing — render it in a diagnostic panel / hover tooltip.
    75	- The workbook is unchanged (no partial write, per the no-fallbacks rule).
    76	- The op log is unchanged (append-before-mutate ordering).
    77	
    78	Common error variants the IDE renders:
    79	- `RuntimeError::Lex(...)` — syntax / tokenization error (e.g., unexpected `@`).
    80	- `RuntimeError::Parse(...)` — parse error (e.g., unclosed paren).
    81	- `RuntimeError::Bind(BindError::UnresolvedName(...))` — `#NAME?` analogue.
    82	- `RuntimeError::Bind(BindError::NamedRangeInScalarContext(...))` — use SUM/AVERAGE/COUNT etc.
    83	- `RuntimeError::Bind(BindError::NamedFormulaUnsupported(...))` — named formulas are Engine Phase 4.
    84	- `RuntimeError::InvalidSheet { ... }` / `InvalidCell { ... }` — coordinate out of range.
    85	
    86	### 2.3 Edit a single cell to a literal
    87	
    88	User types `42` (no leading `=`):
    89	
    90	```rust
    91	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
    92	rt.set_value(sheet, row, col, Value::Number(42.0))?;
    93	```
    94	
    95	Sets a literal; clears any prior formula. Emits `Op::PutValue` (+ `Op::ClearFormula` if cell had a formula).
    96	
    97	### 2.4 Cancel an edit
    98	
    99	User starts typing, presses Esc. **The IDE simply does not call `set_formula` / `set_value`.** No engine state changes. No op log entry. The runtime is never constructed.
   100	
   101	This is the canonical "no-op cancel" path. The engine offers no explicit cancel API because none is needed — borrow-checked mutation requires explicit `&mut` access, and the IDE never grants it for cancelled edits.
   102	
   103	### 2.5 Paste a block
   104	
   105	User pastes 10 cells (literals + formulas):
   106	
   107	```rust
   108	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   109	{
   110	    let mut tx = rt.transaction();
   111	    for (row, col, value) in pasted_literals {
   112	        tx.put_value(sheet, row, col, value)?;
   113	    }
   114	    for (row, col, formula) in pasted_formulas {
   115	        tx.put_formula(sheet, row, col, formula)?;
   116	    }
   117	    tx.commit()?;
   118	}
   119	```
   120	
   121	The transaction:
   122	- Buffers all writes; eager bind validation surfaces formula errors BEFORE the commit (so the paste atomically succeeds or rejects).
   123	- Drop without commit = no-op (canonical "ESC cancels paste" path).
   124	- Emits exactly one `Op::BatchCommit { ops: [...] }` per commit.
   125	
   126	### 2.6 Set / remove a defined name
   127	
   128	User adds a named range in the Name Manager:
   129	
   130	```rust
   131	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   132	rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))?;
   133	```
   134	
   135	Emits `Op::SetName`. Returns `RuntimeError::Name(NameTableError::Reserved(...))` for reserved names (currently just `AI` per CORR-06).
   136	
   137	### 2.7 Add a sheet
   138	
   139	```rust
   140	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   141	let new_sheet_id = rt.add_sheet("Sheet2", 16_384)?;
   142	```
   143	
   144	`16_384` is the engine default chunk size; pass the same unless deliberately tuning.
   145	
   146	### 2.8 Clear a formula (keep value)
   147	
   148	User edits the formula bar to remove the leading `=` (Excel-canon: strips formula, leaves last-evaluated value as a literal):
   149	
   150	```rust
   151	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   152	rt.clear_formula(sheet, row, col)?;
   153	```
   154	
   155	Emits `Op::PutValue(current) + Op::ClearFormula` (preserves the "strip formula, keep value" semantic across replay). No-op if cell had no formula.
   156	
   157	### 2.9 Recompute on demand
   158	
   159	After an out-of-band mutation (e.g., a UDF refresh, a future connector update) the IDE forces a full recompute:
   160	
   161	```rust
   162	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   163	let result = rt.recompute_all();
   164	if !result.is_complete() {
   165	    for failure in &result.failures {
   166	        // display per-cell diagnostic
   167	    }
   168	}
   169	```
   170	
   171	Hit/miss counters in the bind-plan cache visible via `rt.cache_stats()` — IDE can surface these in a status bar / debug pane (Engine Phase 6.2 wires them into the ql-profile JSON for the IDE to render).
   172	
   173	### 2.10 Save
   174	
   175	```rust
   176	ql_io::save_workbook_with_oplog(&wb, &oplog, "name", path)?;
   177	```
   178	
   179	Atomic save (`.qbook/` + `oplog.bin` ride the same temp-then-rename protocol). The op log persists in full — any future session reloading this `.qbook` sees the same history.
   180	
   181	## 3. What the IDE does NOT do
   182	
   183	- **The IDE does NOT call `Workbook::set_name`, `Workbook::add_sheet`, `Workbook::put_at`, or `Workbook::clear_formula` directly.** Those are LOW-LEVEL methods (doc-marked Phase 2B.5) used by the qbook loader, the op-log replay path, runtime-internal recompute pass 2, and tests. Direct calls bypass the op log silently — a correctness hole for product code.
   184	- **The IDE does NOT manage the op log directly.** No `oplog.append(...)` calls. The runtime emits ops; the IDE just hands the runtime an `&mut OpLog` and the runtime handles the rest.
   185	- **The IDE does NOT evaluate formulas itself.** All evaluation goes through the runtime. The IDE consumes results, never produces them.
   186	- **The IDE does NOT cache parsed/bound plans.** That's the runtime's `PlanCache`. The IDE consumes hit/miss stats for observability but never inserts directly.
   187	
   188	## 4. Engine surfaces NOT yet shipped (filed in `docs/known-gaps.md`)
   189	
   190	The IDE will need these eventually; they're not blocking the Phase 2B.6 vertical slice:
   191	
   192	- ~~**On-keystroke validation.**~~ ✅ SHIPPED in Phase 2B.7: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` exists. Closes GAP-I-04.
   193	- ~~**Undo / redo.**~~ ✅ SHIPPED in Phase 5.4 V1/V2 V1/V2 V1.1 (2026-05-19). See `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)" — `CollabSession::{undo,redo,can_undo,can_redo,undo_count,redo_count,clear_undo_stack,start_undo_group,end_undo_group,start_undo_group_scoped,set_undo_merge_interval}`.
   194	- **Incremental dependency-aware recompute.** `recompute_all` re-walks every formula. The IDE wants "this cell changed → recompute its dependents only." GAP-R-01 (Engine Phase 3 — calcgraph integration).
   195	- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. Causality-aware rename-repair pass at merge time is deferred to Phase 5.3.
   196	- **Long-running cancellation.** No `Cancel-token` on long operations. Engine Phase 6.1 work.
   197	
   198	### 4.1 Phase 5 collaboration surface (preview — for Phase 5.7 IDE vertical slice)
   199	
   200	Phase 5 V1 (2026-05-19) added the engine-side multi-user CRDT collaboration substrate as the `ql-collab` crate. Full API inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)". IDE callers will use:
   201	
   202	- **`ql_collab::CollabSession`** — per-peer session holder. Wraps an `OpLog` + `loro::UndoManager` + optional `Box<dyn Transport>`.
   203	- **`CollabSession::new(peer_id) -> Result<Self, _>`** + **`from_snapshot(peer_id, bytes)`** — construction.
   204	- **Op log:** `append_op` / `merge_bytes` / `export_bytes`.
   205	- **Undo:** `undo` / `redo` / `start_undo_group_scoped` (returns RAII `UndoGroupGuard` — recommended for paste/fill-down/table-import).
   206	- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V2/V3 will add WebSocket.
   207	- **Presence:** `update_presence(state)` / `peer_presence(peer)` / `clear_presence` / `peers_with_presence` / `sweep_presence` (V2 — caller-opt-in clean-slate on rejoin).
   208	
   209	**D-1 (✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 megaudit):** `FormatId` is now `enum { Builtin(u32), Custom(PeerId, u32) }` in `ql-storage::format`. IDE callers MUST pattern-match the variant rather than reading `.0`. Use `FormatId::is_builtin()` / `is_custom()` / `GENERAL` accessors. For pre-D-1 bare-u32 ids (xlsx import), use `FormatId::legacy_from_u32(n)`. `Op::RegisterFormat` + `Op::SetCellFormat` carry `FormatIdWire` on the wire. `.qbook` envelope v8 carries the tagged-tuple `FormatEntryId` shape losslessly for multi-peer ids; v<8 envelopes auto-migrate. xlsx export flattens multi-peer FormatIds via dedup-by-code; non-LEGACY peer flattens reported via `XlsxExportReport.dropped_features`. xlsx import surfaces unresolved-overlay-numfmt as `report.unsupported` entries. `.qbook/oplog.bin` files wrapped in Tier D3 header (`OPLOG_MAGIC = b"QLOL"` + BE u32 `OPLOG_SCHEMA_VERSION`). `CollabSession::new` + `from_snapshot` + `OpLog::set_peer_id` assert `PeerId != 0` (release-firing). See `docs/phase5/d-1-exit-packet.md` for the full closure record.
   210	
   211	## 5. Acceptance pattern (`crates/ql-exec/tests/ide_simulation.rs`)
   212	
   213	The simulation test exercises this contract end-to-end without an actual IDE. Each `#[test]` corresponds to one of IDE-2B-01..05:
   214	
   215	| Test | Acceptance | What it proves |
   216	|---|---|---|
   217	| `ide_01_formula_edit_returns_value` | IDE-2B-01 | `set_formula` returns the evaluated Value; IDE can render it |
   218	| `ide_02_bind_errors_carry_user_facing_display` | IDE-2B-02 | Errors round-trip with non-empty Display strings; no fallback values |
   219	| `ide_03_cancel_pattern_no_state_change` | IDE-2B-03 | The borrow-check-enforced "no call = no mutation" pattern works |
   220	| `ide_04_paste_block_via_transaction` | IDE-2B-04 | Transaction commit emits exactly one BatchCommit; partial drop = no state |
   221	| `ide_05_save_reload_preserves_state_and_oplog` | IDE-2B-05 | Round-trip preserves workbook + oplog length + visible cell values |
   222	
   223	The test file is the spec for what the actual TypeScript binding (Engine Phase 6.3) will call.

exec
/bin/zsh -lc "rg -n \"repair_|RepairReport|AmbiguousSkip|TableRepair|TableRewrite|TableAmbiguous|Phase 5\\.3|5\\.3|RenameSheet|RenameTable|RenameColumn|DropTable|column repair|target collision\" quantbook-engine/docs/architecture/ide-consumer-contract.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
195:- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. Causality-aware rename-repair pass at merge time is deferred to Phase 5.3.

exec
/bin/zsh -lc "rg -n \"Phase 5|5\\.3|collab|CRDT|Exit|exit\" quantbook-engine/docs/MASTER-PLAN.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
9:This is the long path. There is no MVP shortcut in this plan. The v1 target is a real spreadsheet engine backing Quantlab: correct scalar semantics, fast graph-driven recomputation, Excel coverage, collaboration, import/export, bindings, service mode, Python UDFs, SQL, connectors, AI(), and an exercised IDE integration.
34:| **Engine 5 (Collaboration CRDT)** | Product Phase 9 (deferred to v1.5 per canonical plan) | Canonical plan defers full collab to v1.5; engine-side, when this work happens, it lives here. May be cut from v1 per canonical. |
35:| **Engine 6 (Product Surfaces)** | Product Phase 5 (Python kernel + UDFs) + Phase 6 (VS Code surface) + Phase 7 (UX) + Phase 8 (SQL/connectors) | The canonical plan splits these across four product phases; the engine work to support them is sequenced here. The TypeScript/UI work in canonical phases 1, 7 lives in `Charts/packages/sheets-*` and `extensions/quantlab/`, NOT in this engine worktree. |
61:- T1-D05: Loro reserved for operation history and collaboration substrate work, not evaluator state.
69:Phase 2A closed a large correctness and persistence pass: defined names, transactions, load-and-recompute, dotted function identifiers, schema v2, crash-safe save, Excel-canon coercion fixes, deterministic formula fingerprints, error ergonomics, and audit closure. Phase 2A.3 then shipped Loro-backed op-log scaffolding: `ql-oplog`, typed `Op` variants, Loro snapshot persistence, replay, runtime and transaction producer wiring, and `.qbook/oplog.bin` persistence. The stale `docs/phase2/entry-plan.md` and `docs/phase2/exit-packet.md` still say 2A.3 is deferred; this plan supersedes that statement and requires a doc-rot repair pass in Phase 2B.
95:| `ql-oplog` | mutation history, replay, future collaborative operation vocabulary |
100:| `ql-collab` | multi-user CRDT documents, merge, presence, undo/redo, offline sync |
146:   Update `docs/phase2/entry-plan.md`, `docs/phase2/exit-packet.md`, phase maps, and this file to mark 2A.3 shipped. Add a "current known gaps" checklist with owners.  
197:**Exit Criteria**
208:- `docs/phase2/exit-packet.md` repaired.
210:- `docs/phase2b/exit-packet.md`.
219:- Phase 2B exit gates green.
360:**Exit Criteria**
371:- `docs/phase3/exit-packet.md`.
383:- **GAP-G-01 + GAP-G-03 SHIPPED (W5-50, 2026-05-13).** Decision recorded in `docs/architecture/2026-05-13-graph-storage-decision.md` (W5-49) and implemented W5-50: Option A — `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index, wired into `extract_and_register_deps`. Option C — `topo::schedule_with_supplemental` accepts a HashMap of temp adjacency; `CalcgraphSession::build_range_supplemental` constructs F→G edges for dirty-formula pairs inside ranges. FormulaRegion binder (Option B) still deferred to Phase 4.7. Phase 4.3 V2 (SUMIF/COUNTIF/lookup family) is **now unblocked**. Tests: +35 vs Phase 3 exit (981 → 1016 workspace).
401:   - Architectural recommendations: adopt IronCalc's precedence tower for Phase 4.7; locale threading pattern for 4.9; recoverable parse errors via AST `ParseError` nodes for 4.4 error matrix; move-formula as separate tree-walk pass for Phase 5+ copy/paste.  
512:    Acceptance: A4-01 ✅ all gates green (4135 workspace tests); A4-02 ✅ compatibility matrix (311 rows, 83% coverage); A4-03 ✅ Excel corpus smoke green (177/177 fixtures); A4-04 ✅ test count 4135 / 946 Phase 3 exit = 4.37× (target ≥ 2× cleared).
513:    Shipped: 5-way parallel megaudit (Codex / Opus-A / Opus-B / Opus-C / self) caught 19 unique HIGHs invisible at per-sub-phase level; 5 closed (correctness + panic + matrix integrity + NUL-in-strings + parser-and-semantics index); 14 deferred to Phase 5 prep with explicit dispositions in `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` + tracked in `docs/PHASE-4-V2-BACKLOG.md`. Phase 4 exit packet at `docs/phase4/exit-packet.md` (ACTIVE).
525:**Exit Criteria** — ALL MET (Phase 4 SHIPS 2026-05-18)
532:**Phase 4 SHIPPED at HEAD `3b8939d9522` on `feat/quantbook-engine`.** Exit packet: `docs/phase4/exit-packet.md` (ACTIVE). Phase 4.11 + 4.12 megaudits closed 17 + 5 = 22 HIGHs invisible at per-batch level; 14 deferred to Phase 5 prep with explicit rationale.
537:- `docs/phase4/exit-packet.md` ✅ ACTIVE (2026-05-18).
543:## Phase 5 - Multi-User CRDT Collaboration
545:**Status (2026-05-20): Phase 5 V1 + D-1 COMPLETE.** Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` (D-1 closure). Remaining: 5.3 conflict resolution, 5.5 V2 V2/V3 production transport, 5.7 IDE slice, 5.8 Phase 5 megaudit (separate from D-1 step 8).
547:**Purpose:** Turn collaboration from a single-writer op log into real multi-user CRDT state for sheets, cells, names, tables, presence, undo/redo, and offline sync.
552:- Phase 4 semantics are broad enough that collaboration does not need to redesign value/formula/table structures.
563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).
565:2. **5.2 `ql-collab` Core Documents** 🟡 IN PROGRESS.
571:   - ✅ **D-1 (FormatId tagged tuple, multi-day) — SHIPPED 2026-05-20.** All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit complete. **16/16 audit cycles caught real bugs.** Workspace tests: 4222 → 4291 (+69). See `docs/phase5/d-1-exit-packet.md` for the closure record + `docs/phase5/d-1-starting-checklist.md` for execution-trace history.
573:3. **5.3 Conflict Resolution Semantics** — future. Causality-aware rename-repair pass. 4-7 days. (V1 ships `BindError::UnknownSheet → #NAME?` as the simple case per Phase 5.2 D-3.)
590:7. **5.7 Collaboration IDE Vertical Slice** — future. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
592:8. **5.8 Phase 5 Megaudit** — future. Depends on 5.1-5.7 complete.
601:- This phase requires a two-peer IDE collaboration slice.
603:**Exit Criteria**
605:- `ql-collab` is real.
608:- Single-writer op log is no longer confused with collaboration.
613:- `docs/phase5/v1-exit-packet.md` ✅ (Phase 5 V1 canonical closeout 2026-05-19).
625:- Phase 4 compatibility and Phase 5 collaboration are stable enough to expose.
687:**Exit Criteria**
696:- `docs/phase6/exit-packet.md`.
712:- Requires compatibility matrix and collaboration model to be stable.
717:   Standardize timings, graph profiles, cache stats, dirty counts, function errors, collaboration conflicts, and service logs.  
723:   Add reproducible stress tests: 1B-cell sparse workbook, 25M SIMD regions, large dependency chains, whole-column aggregates, xlsx corpus, collaboration fuzz, service soak.  
735:   Exercise real workflows: formula editing, paste, import/export, collaboration, UDFs, AI(), diagnostics, cancellation, and recovery.  
760:**Exit Criteria**
770:- `docs/phase7/exit-packet.md`.
788:- Dispatch an independent audit at every phase exit.
789:- Dispatch a megaudit at least every two phases; mandatory megaudits are Phase 3, Phase 4, Phase 5, and Phase 7.
796:- Every phase starts with `entry-plan.md` and ends with `exit-packet.md`.
797:- Every phase exit includes a doc-rot pass touching phase maps, this master plan if needed, audit index, compatibility matrix if relevant, and architecture docs.
803:- Each phase must add comprehensive tests. Aim for more than 2x test count over the phase when the phase changes product behavior; if that is unrealistic, write the exception in the exit packet.
814:- No direct mutation bypass may exist in product paths without op-log/collab semantics.
816:- No collaboration conflict may be auto-dropped without a documented deterministic policy.
823:- Phase 5 proves two-peer collaboration.
832:   Why this matters: putting graph state in `Workbook`, `WorkbookRuntime`, or a separate session object changes persistence, bindings, collab, and service APIs.  
835:2. **What is the exact `.qbook` schema boundary between user state, computed state, and op/collab state?**  
836:   Why this matters: computed-overlay separation, replay, and CRDT merge can corrupt each other if persisted ambiguously.  
851:6. **What is the collaboration conflict policy for formula versus value concurrent edits?**  
853:   Decide by Phase 5.3.
882:| CRDT merge loses user edits | Critical | Offline peers edit same structures and one edit disappears | Formal conflict policy, randomized merge tests, collaboration audit | 5 |
883:| Op log and CRDT model diverge | High | Single-writer op log semantics are mistaken for collaborative history | Phase 5 model doc separates op history, CRDT state, and computed state | 5 |
889:| Doc rot misleads future sessions | Medium | Phase docs contradict shipped code | Phase-exit doc pass required; stale docs treated as bugs | All |

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/MASTER-PLAN.md | sed -n '1,220p;220,420p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	# Quantbook Engine Master Plan
     2	
     3	**Status:** Canonical engine-side plan, Phase 4.3 V2 closure session 2026-05-13  
     4	**Date:** 2026-05-13 (last touched W5-58 — FN4-01 closure)  
     5	**Current HEAD:** see `docs/audits/2026-05-13-engine-session-final-handoff.md` § Session ledger for the exact hash (last shippable W5-58 = `d6a6bcdcfc5`; W5-59 finalization = `51fedf11c68`; W5-60 closure adds the final mega-audit fixes on top)  
     6	**Scope:** engine-internal sequencing for all 24 workspace crates  
     7	**Authored:** Claude Opus 4.7 + Codex (co-thinking session, 2026-05-12)
     8	
     9	This is the long path. There is no MVP shortcut in this plan. The v1 target is a real spreadsheet engine backing Quantlab: correct scalar semantics, fast graph-driven recomputation, Excel coverage, collaboration, import/export, bindings, service mode, Python UDFs, SQL, connectors, AI(), and an exercised IDE integration.
    10	
    11	---
    12	
    13	## 0. How this document relates to the product master plan
    14	
    15	There is a **canonical product master plan** for Quantbook at:
    16	
    17	> `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md`
    18	
    19	That document (dated 2026-05-10, 949 lines) is the **product source-of-truth**: the fusion thesis, the wedge, the v1 ship definition, the 11-phase / 9-12 month budget, the kill gates, the v1.5 deferrals, the legal posture, the renderer/Python/IDE phase plan. It is gitignored (lives outside this engine worktree). Future sessions should read it before making product-level decisions.
    20	
    21	This `MASTER-PLAN.md` is the **engine-side execution plan**: how the Rust engine work proceeds from where it is today (HEAD at W5-60 closure, post-FN4-01 wave 1 closure + final mega-audit fixes; see `docs/audits/2026-05-13-engine-session-final-handoff.md` for the precise hash) through to a state where every product-plan phase that needs engine support has it. It uses engine-internal phase numbers (`2B`, `3`, `4`, `5`, `6`, `7`) that DO NOT align with the canonical plan's numbering (`Phase 0..10`).
    22	
    23	### Mapping between engine-internal phases and canonical product phases
    24	
    25	| Engine phase (this doc) | Canonical product phase(s) | Notes |
    26	|---|---|---|
    27	| Engine 0 (Viability spike) ✅ | Product Phase 0 | Same. 13/13 gates locked. |
    28	| Engine 1 (Parser + persistence + runtime facade) ✅ | Product Phase 0 spillover + parts of Phase 2 (`.qbook/`) + parts of Phase 3 (parser, recompute) | Engine front-ran the canonical plan by absorbing parts of Phase 2 storage and Phase 3 parser. |
    29	| Engine 2A.1–2A.13 ✅ | Parts of Product Phase 3 (named ranges, errors, fingerprints, parser breadth) | Engine correctness + audit closure. |
    30	| Engine 2A.3 (op log) ✅ | Product Phase 0 deliverable (`ql-oplog` scaffolding) advanced into producer wiring + persistence | Loro op log scaffolding called for in canonical Phase 0; we shipped it now because the API surface was ready. |
    31	| **Engine 2B (Correct Runtime Contract)** | Product Phase 3 (continued) + Product Phase 6 (first IDE integration vertical slice) | First time the IDE is exercised against the engine. |
    32	| **Engine 3 (One Engine — calcgraph integration)** | Product Phase 3 (the unified engine spine the canonical plan assumed in §2.1) | The canonical plan describes "one authoritative graph"; Engine 3 actually builds that. |
    33	| **Engine 4 (Excel Coverage)** | Product Phase 3 (depth) + Product Phase 4 (xlsx import) | Roughly 260 functions + arrays/spills/tables/cross-sheet refs + xlsx I/O. |
    34	| **Engine 5 (Collaboration CRDT)** | Product Phase 9 (deferred to v1.5 per canonical plan) | Canonical plan defers full collab to v1.5; engine-side, when this work happens, it lives here. May be cut from v1 per canonical. |
    35	| **Engine 6 (Product Surfaces)** | Product Phase 5 (Python kernel + UDFs) + Phase 6 (VS Code surface) + Phase 7 (UX) + Phase 8 (SQL/connectors) | The canonical plan splits these across four product phases; the engine work to support them is sequenced here. The TypeScript/UI work in canonical phases 1, 7 lives in `Charts/packages/sheets-*` and `extensions/quantlab/`, NOT in this engine worktree. |
    36	| **Engine 7 (Hardening + Ship)** | Product Phase 10 | Same. Final release candidate. |
    37	
    38	**Where the engine plan does NOT cover canonical phases:**
    39	
    40	- **Canonical Phase 1 (Renderer spike, WebGL grid)** — entirely TypeScript work in `Charts/packages/sheets-{protocol,client,renderer}`. Engine provides the API surface; renderer is its own project. No engine-side phase covers it.
    41	- **Canonical Phase 2 (storage + protocol + skeleton packages)** — engine has shipped the `.qbook/` storage piece; the `sheets-protocol`/`sheets-client` TypeScript packages are renderer-team work.
    42	- **Canonical Phase 6 (Quantlab IDE integration)** — the engine's job is to provide a usable API; the actual `extensions/quantlab/` work is a parallel TypeScript track. Engine 2B includes the first vertical slice as a forcing function.
    43	
    44	### Why two documents
    45	
    46	The canonical plan is product-shaped and parallel-track (engine + renderer + Python + IDE proceeding in measured concurrency). The actual execution since 2026-05-11 has been engine-serial: depth-first through the Rust core. This engine plan reflects that reality and extends it. Future sessions should:
    47	
    48	1. Open the canonical plan to understand product intent, v1 definition, ship gates.
    49	2. Open this engine plan to know what to build next in the engine.
    50	3. When the two diverge, **the canonical plan wins on product scope and timing**; this doc adjusts.
    51	
    52	## PART I - Strategic Posture
    53	
    54	### 1. How We Got Here
    55	
    56	Phase 0 proved that the engine shape is viable. The locked architectural gates are still binding:
    57	
    58	- T1-D02: hand-rolled dependency graph on the hot path, not petgraph.
    59	- T1-D03: direct Arrow kernels on the hot path, not Polars or DataFusion.
    60	- T1-D04: pulp plus multiversion SIMD.
    61	- T1-D05: Loro reserved for operation history and collaboration substrate work, not evaluator state.
    62	- T1-D06: stock VS Code APIs for v1.
    63	- T1-D07: Tier-0 wedge is Monaco-powered formula bar plus Python UDFs.
    64	- T2-D01: `.qbook/` directory plus `workbook.toml` envelope.
    65	- T3-D03: roughly 260 v1 spreadsheet functions.
    66	
    67	Phase 1 built the first live formula path: lexer, parser, AST printer, scalar binding, scalar evaluation, `.qbook/` persistence, `WorkbookRuntime::set_formula`, and `recompute_all`. It made the engine useful, but it did not make it architecturally complete. `recompute_all` still walks formula cells in map order, so dependency chains can compute incorrectly.
    68	
    69	Phase 2A closed a large correctness and persistence pass: defined names, transactions, load-and-recompute, dotted function identifiers, schema v2, crash-safe save, Excel-canon coercion fixes, deterministic formula fingerprints, error ergonomics, and audit closure. Phase 2A.3 then shipped Loro-backed op-log scaffolding: `ql-oplog`, typed `Op` variants, Loro snapshot persistence, replay, runtime and transaction producer wiring, and `.qbook/oplog.bin` persistence. The stale `docs/phase2/entry-plan.md` and `docs/phase2/exit-packet.md` still say 2A.3 is deferred; this plan supersedes that statement and requires a doc-rot repair pass in Phase 2B.
    70	
    71	The engine now has **1219 workspace tests at W5-60 close** (was 816 at the time this paragraph was first written; ~+403 across the W5-49..W5-60 arc) and 7 green gates. That is a floor, not a trophy. The major unresolved problem is that the "fast engine" (`ql-calcgraph`, SIMD region lowering, storage profiles) and the "runtime engine" (`WorkbookRuntime`, per-formula scalar path) still do not form one engine.
    72	
    73	Reference reading already changed the plan:
    74	
    75	- `docs/phase0/references-reading-log.md` corrected the stripe design to Formualizer-style per-row/per-column/block stripes (`CORR-21`).
    76	- Range aggregate caching is a Phase 3/4 feature informed by HyperFormula, not Formualizer (`CORR-22`).
    77	- Scheduling should use Tarjan SCC on dirty subsets (`CORR-23`).
    78	- Graph tests should expose typed accessors, not serialized graph dumps (`CORR-24`).
    79	- Storage eventually needs user and computed overlays (`CORR-25`).
    80	
    81	### 2. What Full Product v1 Means
    82	
    83	The 24-crate workspace is v1 scope. Stubs are not optional decorations; they are reserved product surfaces.
    84	
    85	| Crate | v1 role |
    86	|---|---|
    87	| `ql-types` | shared values, errors, addresses, coercion, date serials, sheet/range types |
    88	| `ql-storage` | workbook, sheets, columns, user/computed overlays, names, tables, style/format metadata |
    89	| `ql-formula-syntax` | lexer, parser, printer, fingerprints, A1/R1C1/localized syntax |
    90	| `ql-formula-semantics` | binding, name resolution, tables, cross-sheet references, aggregate context |
    91	| `ql-functions` | roughly 260 Excel-compatible functions, function metadata, volatility, lazy args |
    92	| `ql-calcgraph` | dependency graph, dirty propagation, SCC scheduling, range deps, aggregate caches |
    93	| `ql-exec` | runtime facade, scalar and SIMD evaluation, plan cache, graph integration |
    94	| `ql-io` | `.qbook` persistence and schema migrations |
    95	| `ql-oplog` | mutation history, replay, future collaborative operation vocabulary |
    96	| `ql-profile` | timings, graph profile exports, observability records |
    97	| `ql-bench` | reproducible perf and scale workloads |
    98	| `ql-io-xlsx` | Excel import/export through calamine and write support |
    99	| `ql-io-ods` | OpenDocument import/export |
   100	| `ql-collab` | multi-user CRDT documents, merge, presence, undo/redo, offline sync |
   101	| `ql-service` | engine-as-service API, transport, auth boundary hooks |
   102	| `ql-bindings-wasm` | browser/worker engine bindings |
   103	| `ql-bindings-node` | IDE and Node integration surface |
   104	| `ql-bindings-c` | stable C ABI |
   105	| `quantbook-py` | Python package for local automation and notebooks |
   106	| `ql-udf` | Python UDF execution, sandboxing, registration, cancellation |
   107	| `ql-sql` | SQL over sheets/tables, Arrow/DuckDB bridge where appropriate |
   108	| `ql-connectors` | external data imports, refresh, credentials boundary |
   109	| `ql-ai` | real AI() implementation, provider boundary, cancellation, provenance |
   110	| `ql-terminal` | terminal-side integration only if it survives product clarification |
   111	
   112	The full v1 means all of these crates either ship real behavior or have a documented product decision removing them. As of this plan, none are removed.
   113	
   114	### 3. Seven Phases At A Glance
   115	
   116	| Phase | Name | Purpose | Estimate | Primary proof |
   117	|---|---|---|---:|---|
   118	| 2B | Correct Runtime Contract | Fix immediate runtime correctness gaps, cache bind plans, prepare named aggregate context, and run the first IDE vertical slice. | 2-4 weeks | IDE can edit formulas through the engine with real diagnostics and op-log persistence. |
   119	| 3 | One Engine | Wire `ql-calcgraph` into `WorkbookRuntime` so runtime and fast engine share graph, storage, invalidation, and scheduling. | 4-8 weeks | Dependency chains, ranges, volatiles, and incremental recompute are graph-driven. |
   120	| 4 | Excel Coverage | Expand parser, semantics, function library, arrays, tables, cross-sheet refs, formats, and xlsx I/O. | 8-16 weeks | Compatibility matrix exists and passes broad Excel corpus coverage. |
   121	| 5 | Collaboration | Make Loro a true multi-user substrate for cells, sheets, names, tables, and presence. | 6-12 weeks | Two offline peers merge deterministically without losing edits. |
   122	| 6 | Product Surfaces | Ship service mode, bindings, connectors, SQL, Python UDFs, and AI(). | 6-10 weeks | IDE, Node, Python, WASM, and service clients run the same engine contract. |
   123	| 7 | Hardening And Ship | Performance, observability, release artifacts, audits, scale tests, and IDE polish. | 4-6 weeks | End-to-end release candidate survives scale, audit, and IDE acceptance. |
   124	
   125	## PART II - Phase Plans
   126	
   127	## Phase 2B - Correct Runtime Contract
   128	
   129	**Purpose:** Make current runtime semantics honest enough for the IDE while preparing the bind and aggregate context that Phase 3 will graph-drive.
   130	
   131	**Entry State Required**
   132	
   133	- Phase 0, Phase 1, Phase 2A, and Phase 2A.3 are green at HEAD `fc977815cd2`.
   134	- `ql-oplog` producer/replay tests pass.
   135	- `docs/phase2/*` are known stale; do not trust their 2A.3 deferral statement.
   136	
   137	**Dependencies**
   138	
   139	- Depends on Phase 2A.3 op-log producer wiring.
   140	- Must not require full calcgraph integration; that is Phase 3.
   141	- Must coordinate with `extensions/quantlab/` for first IDE slice.
   142	
   143	**Sub-items**
   144	
   145	1. **2B.1 Doc-Rot Repair And Reality Baseline**  
   146	   Update `docs/phase2/entry-plan.md`, `docs/phase2/exit-packet.md`, phase maps, and this file to mark 2A.3 shipped. Add a "current known gaps" checklist with owners.  
   147	   References: `docs/phase0/references-reading-log.md`; `crates/ql-oplog/src/{op,log,replay,persistence}.rs`; `crates/ql-exec/tests/oplog_e2e.rs`.  
   148	   Acceptance: DOC-2B-01 all Phase 2 docs agree that 2A.3 shipped; DOC-2B-02 every known gap has a target phase; DOC-2B-03 no stale "Phase 4 calcgraph" wording remains where Phase 3 is meant.  
   149	   Effort: 1 day.
   150	
   151	2. **2B.2 Recompute Result Contract**  
   152	   Replace short-circuit-only `recompute_all` reporting with `RecomputeResult` containing attempted count, succeeded count, failed cell, failure kind, and partial-state policy. Keep no-fallbacks: failures are visible.  
   153	   References: `.references/formualizer/crates/formualizer-workbook/src/recalculate.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/eval.rs`; `.references/hyperformula/src/Evaluator.ts` only for failure reporting concepts if needed.  
   154	   Acceptance: R2B-01 failure returns exact cell and formula text; R2B-02 successful earlier cells are counted; R2B-03 no panic on invalid persisted formula; R2B-04 load-and-recompute preserves partial workbook on recompute failure.  
   155	   Effort: 2-3 days.
   156	
   157	3. **2B.3 Bind-Plan Cache V0**  
   158	   Cache parsed and bound `ExprPlan` next to workbook formula text, keyed by formula fingerprint plus sheet/name-table generation. Invalidate on formula text change, name-table mutation, and sheet add. Keep cache local to runtime/storage; do not invent graph scheduling here.  
   159	   References: `.references/hyperformula/src/parser/ParserWithCaching.ts`; `.references/hyperformula/src/parser/Cache.ts`; `.references/formualizer/crates/formualizer-eval/src/engine/graph/formula_analysis.rs`.  
   160	   Acceptance: BPC-01 repeated `recompute_all` does not re-lex/re-parse unchanged formulas; BPC-02 name changes invalidate affected plans; BPC-03 fingerprints remain stable; BPC-04 cache miss/hit counters visible in `ql-profile`.  
   161	   Effort: 3-5 days.
   162	
   163	4. **2B.4 Named-Range Aggregate Context Prep** ✅ SHIPPED (`f64ff00dcb1`)  
   164	   Bind `SUM(Sales)` to a typed `ExprPlan::AggregateNameRef { name, range }` instead of generic `UnsupportedVariant`; scalar-context misuse surfaces precise `BindError::NamedRangeInScalarContext`. Evaluation returns `#CALC!` for AggregateNameRef pending Phase 3.6. **Deviation from original plan:** the work stays in `ql-exec/src/plan.rs` rather than moving to `ql-formula-semantics`. The move was deferred because `ExprPlan` lives in `ql-exec`; relocating it cleanly requires Phase 3 calcgraph integration to land first (so the eventual home is `ql-formula-semantics` once ownership questions resolve). Tracked as a follow-up; not a 2B.4 blocker.  
   165	   References used: same as planned (formualizer + hyperformula).  
   166	   Acceptance shipped: NAG-01..04 + `nag_05_nested_aggregates_with_named_range_bind_cleanly` + `nag_06_round_with_nested_sum_of_named_range_binds_cleanly`.  
   167	   Effort actual: ~1 day (binder context threading + new variants + tests).
   168	
   169	5. **2B.5 Op-Log Producer Coverage Audit**  
   170	   Close silent bypasses: `Workbook::set_name`, `Workbook::add_sheet`, and direct `put_at` paths either emit ops through a runtime/transaction facade or are marked low-level with tests proving callers cannot accidentally use them from product surfaces.  
   171	   References: `crates/ql-oplog/src/op.rs`; `.references/formualizer/crates/formualizer-workbook/src/transaction.rs`; `.references/formualizer/crates/formualizer-sheetport/src/batch.rs`.  
   172	   Acceptance: OPL-2B-01 every public product mutation has an op-log equivalent; OPL-2B-02 producer/replay equivalence covers values, formulas, names, sheets, and batches; OPL-2B-03 low-level bypass methods carry explicit docs and tests.  
   173	   Effort: 2-3 days.
   174	
   175	6. **2B.6 First IDE Vertical Slice**  
   176	   Exercise `extensions/quantlab/` against the engine path: edit a formula in a Monaco-powered formula bar, get diagnostics, commit/cancel, paste a small block, save `.qbook`, reload, and verify `oplog.bin`. Use stock VS Code APIs.  
   177	   References: `.references/formualizer/crates/formualizer-sheetport/src/session.rs`; `.references/formualizer/bindings/wasm/src/index.ts` for binding-shape ideas; VS Code API docs already vendored in the host repo.  
   178	   Acceptance: IDE-2B-01 formula edit calls engine and displays value; IDE-2B-02 lex/parse/bind errors display without falling back; IDE-2B-03 cancel leaves workbook unchanged; IDE-2B-04 paste uses transaction API; IDE-2B-05 saved workbook reloads with same visible state and op log length.  
   179	   Effort: 4-7 days, split between engine and IDE worktree.
   180	
   181	7. **2B.7 Phase 2B Audit And Gate Lock**  
   182	   Dispatch independent audit after 2B.2-2B.6. Fix HIGH findings, triage MEDIUM, document deferrals.  
   183	   References: prior audit docs under `docs/audits/`; `scripts/check-*.sh`.  
   184	   Acceptance: A2B-01 fmt, clippy, workspace tests, pin guard, build flags, multiversion clone guard, cargo audit all green; A2B-02 test count at least 1.5x Phase 2A.3 baseline or explicit exception; A2B-03 audit report checked in.  
   185	   Effort: 2-3 days.
   186	
   187	**Audit Checkpoints**
   188	
   189	- Mini-audit after 2B.5 focused on op-log coverage and no-fallbacks.
   190	- Full Phase 2B audit after IDE slice.
   191	
   192	**IDE Proof Points**
   193	
   194	- This phase owns the first IDE vertical slice.
   195	- It must prove the `set_formula` contract, cancellation, diagnostics, paste transaction, save/load, and op-log persistence.
   196	
   197	**Exit Criteria**
   198	
   199	- `recompute_all` failure reporting is explicit.
   200	- Bind-plan cache exists and invalidates correctly.
   201	- Named-range aggregate binding has a typed plan shape.
   202	- IDE vertical slice is exercised, not hand-waved.
   203	- Phase docs no longer lie about 2A.3.
   204	
   205	**Documentation Deliverables**
   206	
   207	- `docs/phase2/entry-plan.md` repaired.
   208	- `docs/phase2/exit-packet.md` repaired.
   209	- `docs/phase2b/entry-plan.md`.
   210	- `docs/phase2b/exit-packet.md`.
   211	- Audit report under `docs/audits/`.
   212	
   213	## Phase 3 - One Engine
   214	
   215	**Purpose:** Integrate `ql-calcgraph` with `WorkbookRuntime` so dependency tracking, storage, scheduling, scalar evaluation, SIMD regions, and recomputation are one runtime.
   216	
   217	**Entry State Required**
   218	
   219	- Phase 2B exit gates green.
   220	- Bind-plan cache V0 exists.
   220	- Bind-plan cache V0 exists.
   221	- IDE slice has exposed the real runtime contract.
   222	
   223	**Dependencies**
   224	
   225	- Requires 2B bind-plan cache and aggregate context prep.
   226	- Blocks Phase 4 arrays, tables, cross-sheet scale work, and xlsx formulas at meaningful scale.
   227	
   228	**Sub-items**
   229	
   230	1. **3.1 Calcgraph Runtime Ownership Model** ✅ SHIPPED 2026-05-12 (W5-34)  
   231	   Decide where graph state lives: likely inside `WorkbookRuntime` session state with persistable rebuild from workbook formulas, not inside `Workbook` storage alone. Define rebuild, mutation, and snapshot APIs.  
   232	   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/vertex_store.rs`; `.references/hyperformula/src/DependencyGraph/DependencyGraph.ts`.  
   233	   Acceptance: G3-01 ✅ graph rebuilds deterministically (`rebuild_is_deterministic_across_runs`); G3-02 ✅ 5-hook mutation API (`on_set_value`, `on_set_formula`, `on_clear_formula`, `on_set_name`, `on_add_sheet`); G3-03 ✅ no petgraph hot-path dep — Phase 0 W3-1 hand-rolled `Graph` per Round 7 T1-D02 lock.  
   234	   Shipped: `CalcgraphSession` ownership shell at `crates/ql-exec/src/calcgraph_session.rs`; constructor variants (`new`, `with_oplog`, `with_graph`, `with_oplog_and_graph`); 11 unit tests + 4 wiring tests in `workbook_runtime.rs`. Future Phase 6.1 `WorkbookSession` will absorb Workbook + OpLog + CalcgraphSession + PlanCache + FunctionRegistry into one owning struct (GAP-PS-09).  
   235	   Effort: 3-4 days.
   236	
   237	2. **3.2 Dependency Extraction From Bound Plans** ✅ SHIPPED 2026-05-12 (W5-35)  
   238	   Extract cell, range, name, volatile, and future table dependencies from `ExprPlan`. Preserve compressed range dependencies for whole-column/whole-row ranges.  
   239	   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/formula_analysis.rs`; `.references/hyperformula/src/parser/collectDependencies.ts`; `.references/hyperformula/src/parser/RelativeDependency.ts`.  
   240	   Acceptance: DEP-3-01 ✅ direct cell deps captured (`dep_3_01_direct_cell_refs_captured`); DEP-3-02 ✅ range deps remain compressed (`dep_3_02_range_deps_remain_compressed`); DEP-3-03 ✅ named deps captured (`dep_3_03_named_deps_captured`); DEP-3-04 ✅ volatile functions marked (`dep_3_04_volatile_functions_marked`).  
   241	   Shipped: `CalcgraphSession::{formula_deps, volatile_formulas, name_to_formulas}` side-tables; `walk_plan_for_deps` recursive walker; `RebuildResult` aggregates per-formula bind failures (parallel to `RecomputeResult`); `on_set_formula` takes `&ExprPlan` (no re-binding in the hook); `on_clear_formula` evicts dep state. 9 new tests; full ql-exec suite at 268 tests. Open follow-ups: GAP-R-07 (scalar `NameRef` name-tracking) and the 3.3 dirty-propagation wire-up that consumes this substrate.  
   242	   Effort: 3-5 days (actual: ~1 day from 3.1 substrate; clean handoff to 3.3).
   243	
   244	3. **3.3 Dirty Propagation And Stripe Range Index** ✅ SHIPPED 2026-05-12 (W5-36)  
   245	   Wire writes to dirty direct dependents and range dependents through Formualizer-style stripe maps. Add precision re-check to remove false positives.  
   246	   References: `.references/formualizer/crates/formualizer-eval/src/engine/graph/range_deps.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/graph/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/sheet_index.rs`.  
   247	   Acceptance: DIR-3-01 ✅ write inside range dirties dependent (`dir_3_01_write_inside_range_dirties_dependent`); DIR-3-02 ✅ write outside range does not dirty after precision check (`dir_3_02_write_outside_range_filtered_by_precision_check`); DIR-3-03 ✅ whole-row, whole-column, and bounded ranges covered (`dir_3_03_whole_col_whole_row_bounded_all_supported`); DIR-3-04 ✅ no per-cell edge explosion for full columns (`dir_3_04_no_per_cell_edge_explosion_for_full_columns`).  
   248	   Shipped: session-side `dirty: HashSet<NodeId>` plus the 5 hooks fanning out via `Graph::dependents_for_cell` (stripe + precision) for range deps and a new session-side `cell_to_formulas` reverse index for direct cell deps; `on_set_name` fans out via `name_to_formulas`; `take_dirty()` claims + clears for the future 3.4 SCC scheduler; `range_to_rangeref` converter promotes `Range { start_row: 0, end_row: MAX }` to `RangeRef::WholeColumn` (and symmetric for whole-row) to keep the stripe index O(width) instead of O(height). 10 new tests; full ql-exec suite at 278 tests, workspace at 892. Known limitation: stale Phase 0 stripe entries on re-bind (append-only `Graph`) — filed as GAP-G-01 (performance, not correctness; precision check filters at the read side).  
   249	   Effort: 4-6 days (actual: ~1 day; substrate already existed in `ql-calcgraph` from Phase 0 W3-5).
   250	
   251	4. **3.4 Tarjan SCC Scheduler And Full Topological Recompute** ✅ SHIPPED 2026-05-12 (W5-37)  
   252	   Replace map-order recompute with dirty-subset Tarjan SCC plus deterministic layers. Cycles surface as Excel errors and diagnostics, not panics.  
   253	   References: `.references/formualizer/crates/formualizer-eval/src/engine/scheduler.rs`; `.references/hyperformula/src/DependencyGraph/TopSort.ts`; `docs/phase0/references-reading-log.md` CORR-23.  
   254	   Acceptance: SCH-3-01 ✅ dependency chains schedule in dependency-first order (`sch_3_01_dependency_chains_schedule_in_dependency_first_order` + `recompute_dirty_cascades_dependency_chain`); SCH-3-02 ✅ cycles surface in `Schedule::cycled` (`sch_3_02_cycles_report_all_scc_members` + `recompute_dirty_writes_circ_error_for_cycle_members`); SCH-3-03 ✅ deterministic across runs (`sch_3_03_schedule_is_deterministic_across_runs`); SCH-3-04 ✅ dirty subset avoids unrelated formulas (`sch_3_04_dirty_subset_avoids_unrelated_formulas` + `recompute_dirty_skips_unrelated_formulas`).  
   255	   Shipped:  
   256	   - Phase 0 W3-3 iterative Tarjan in `ql_calcgraph::topo::schedule` was already built (no recursion limit on deep chains). 3.4 wires it.  
   257	   - `extract_and_register_deps` adds forward `graph.add_edge(formula, dep_formula)` for direct cell→cell deps (self-edges allowed for `=A1` at A1 → Tarjan reports as cycled).  
   258	   - `on_set_formula` does retroactive-edge wiring: when a new formula appears at a cell that older formulas already reference, the F'→F forward edges are materialized so Tarjan can order them.  
   259	   - `rebuild_from_workbook` pre-inserts all formula nodes before any extract pass so the forward-edge wiring at extract time sees a complete `cell_index`.  
   260	   - `mark_dirty_from_cell_write` upgraded from single-hop (Phase 3.3) to BFS — a chain edit cascades through the reverse-dep graph until fixpoint.  
   261	   - `CalcgraphSession::schedule_dirty() -> Schedule` drains the dirty set and runs Tarjan.  
   262	   - `CalcgraphSession::cell_address_for(NodeId)` — inverse of `cell_node_for`, needed by the runtime to look up addresses from schedule output.  
   263	   - `WorkbookRuntime::recompute_dirty()` evaluates the `sorted` partition in dependency-first order via the existing PlanCache pipeline; writes `Value::Error(ErrorValue::Circ)` for every `cycled` member.  
   264	   - New `ErrorValue::Circ` variant (15th, was reserved at Phase 0; Phase 0 doc updated). Handled in `ql-io::qbook_format` wire roundtrip.  
   265	   16 new tests (10 session unit + 5 runtime integration + 1 wire roundtrip). ql-exec at 295, workspace at 905.  
   266	   Effort: 5-7 days (actual: ~1 day; substrate was already there from Phase 0 W3-3).
   267	
   268	5. **3.5 Computed-Overlay Separation** ✅ SHIPPED 2026-05-12 (W5-38)  
   269	   Split user edits from computed formula/spill outputs in storage. Reads cascade user -> computed -> base. User write clears stale computed value at that cell.  
   270	   References: `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/range_view.rs`; `docs/phase0/references-reading-log.md` CORR-25.  
   271	   Acceptance: OVR-3-01 ✅ formula output writes to computed overlay, not user (`ovr_3_01_set_formula_writes_to_computed_overlay_not_user`); OVR-3-02 ✅ typing over formula clears formula text + computed (`ovr_3_02_typing_over_formula_clears_formula_and_computed`); OVR-3-03 ✅ save/load preserves layer (`ovr_3_03_save_load_preserves_layer`); OVR-3-04 ✅ read cascade consistent (`ovr_3_04_read_cascade_consistent_across_lane_types`).  
   272	   Shipped:  
   273	   - `ColumnStore` now carries `user_overlays: Vec<SparseOverlay>` AND `computed_overlays: Vec<SparseOverlay>` (parallel per-chunk). Read cascade: user → computed → base.  
   274	   - `ColumnStore::put` (user edit) auto-clears computed at the row; symmetric `put_computed` clears user. The two lanes maintain the invariant "a row has at most one of {user, computed} entry."  
   275	   - `ColumnStore::{clear_computed, clear_user}` for explicit lane drops.  
   276	   - `Sheet::{put_computed, clear_computed, clear_user}` mirror the column API.  
   277	   - `Workbook::{put_computed_at, clear_computed_at, clear_user_at}`. `Workbook::clear_formula` ALSO drops the cell's computed entry (no formula → no formula output).  
   278	   - `WorkbookRuntime::{set_formula, recompute_all, recompute_dirty}` route formula outputs through `put_computed_at` (was `put_at`); `clear_formula` runtime path promotes the final formula value into the user lane before clearing (Excel "strip formula, keep value" canonicalized to "value becomes literal"). Transaction commit pass 2 routes formula results through `put_computed_at`.  
   279	   - `WorkbookRuntime::recompute_dirty` writes `#CIRC!` to the computed overlay (not user) for cycle members.  
   280	   - qbook loader (`ql_io::load_workbook`) routes cells with formula text to `put_computed_at`; cells without formulas go to `put_at` (user). Save path needs no change — `sheet.read` already goes through the cascade and surfaces the right value per cell.  
   281	   - `iter_chunks` signature changed: `(idx, &base, &user_overlay, &computed_overlay)` tuple. `overlay(idx)` deprecated; new code uses `user_overlay` / `computed_overlay` explicitly.  
   282	   - One additional Phase 3.5 acceptance test `ovr_3_02b_clear_formula_promotes_value_to_user_lane` pins the explicit-clear behavior.  
   283	   10 new tests (5 in ColumnStore + 5 OVR-* at runtime). ql-exec at 305 (was 295), ql-storage at 70 (was 65), workspace at 915 (was 905).  
   284	   Effort: 4-7 days (actual: ~1 day; the overlay primitive was already per-chunk, so the split was straightforward).
   285	
   286	6. **3.6 Range Aggregate Cache V1** ✅ SHIPPED 2026-05-12 (W5-39)  
   287	   Add aggregate cache nodes for SUM/COUNT/MIN/MAX/AVERAGE/PRODUCT over range plans, invalidated by dirty stripes. Start simple: clear relevant aggregate cache on intersecting writes; optimize later.  
   288	   References: `.references/hyperformula/src/DependencyGraph/RangeVertex.ts`; `.references/hyperformula/src/DependencyGraph/RangeMapping.ts`; `.references/formualizer/crates/formualizer-eval/src/engine/tests/compressed_range_scheduler.rs`.  
   289	   Acceptance: AGG-3-01 ✅ unrelated writes don't trigger rescan (`agg_3_01_no_rescan_on_unrelated_writes`); AGG-3-02 ✅ intersecting writes invalidate (`agg_3_02_intersecting_write_invalidates_cache`); AGG-3-03 ✅ full-column aggregate remains compressed (`agg_3_03_full_column_aggregate_remains_compressed`); AGG-3-04 ✅ results match scalar baseline for SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT (`agg_3_04_results_match_scalar_baseline`).  
   290	   Shipped:  
   291	   - New module `aggregate_cache.rs`: `AggregateCache` trait, `InMemAggregateCache` (HashMap-backed with `RefCell` interior mutability for `&self` stores), `NoAggregateCache` zero-cost no-op default. Stats: hits / misses / invalidations.  
   292	   - `CellEnv::read_range(range)` — default impl iterates row-by-row; `WorkbookEnv` overrides to clamp to `Sheet::bounds` so `SUM(WholeCol)` doesn't iterate `RowId::MAX` cells.  
   293	   - Aggregate evaluator: scalar.rs Function branch detects `(aggregate_fn, [single AggregateNameRef arg])` and routes through cache (hit → return cached; miss → materialize range → call fn → store cached, except for `Value::Error` results). Multi-range aggregates (`SUM(A, B)`) fall back to no-cache materialize-and-call.  
   294	   - `eval_scalar_with_cache(plan, env, registry, &dyn AggregateCache)` is the new entry point; `eval_scalar_with_registry` wraps with `NoAggregateCache`.  
   295	   - `CalcgraphSession::aggregate_cache: InMemAggregateCache` field + `aggregate_cache()` / `aggregate_cache_stats()` accessors. `mark_dirty_from_cell_write` calls `invalidate_at(s, r, c)` before fanning out dirty propagation — entries whose range contains the cell are dropped (precision-exact).  
   296	   - `WorkbookRuntime::set_formula` routes through `eval_scalar_with_cache` (using session cache when attached). `recompute_dirty` uses `try_recompute_with_aggregate_cache`.  
   297	   - The legacy `eval_scalar_with_registry` + `recompute_all` paths use `NoAggregateCache` (no behavior change without a session).  
   298	   16 new tests (7 aggregate_cache unit + 4 AGG-3-01..04 acceptance + 3 NAG-* updated for actual eval + 2 read_range correctness). ql-exec at 311 (was 295). Workspace at 926 (was 915).  
   299	   Notes: V1 caches only single-`AggregateNameRef`-arg calls. Multi-range and mixed-type args (`SUM(A, 5)`, `SUM(A, B)`) fall back to no-cache. Phase 4.7 (array formulas) revisits.  
   300	   Effort: 5-8 days (actual: ~1 day; substrate from 3.5 overlay split made range reads clean).
   301	
   302	7. **3.7 Volatile Function Invalidation** ✅ SHIPPED 2026-05-12 (W5-40)  
   303	   Model NOW/RAND/RANDBETWEEN and later volatile functions as graph roots invalidated by recompute cycle, edit, or explicit recalc mode. Add deterministic test mode.  
   304	   References: `.references/formualizer/crates/formualizer-eval/src/rng.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/tests/volatile_rng.rs`; `.references/ironcalc/base/src/functions/math_and_trigonometry/random.rs`.  
   305	   Acceptance: VOL-3-01 ✅ `mark_volatile_dirty` + `recompute_dirty` produces a new RAND() value (`vol_3_01_volatile_formulas_recompute_when_requested`); VOL-3-02 ✅ non-volatile dependents update when volatile changes (`vol_3_02_nonvolatile_dependents_update_when_volatile_changes`); VOL-3-03 ✅ seeded RNG produces deterministic RAND() sequence (`vol_3_03_seeded_rng_produces_deterministic_rand_sequence`).  
   306	   Shipped:  
   307	   - New `ql-functions::volatile` module: NOW, TODAY, RAND, RANDBETWEEN. xorshift64 PRNG with thread-local state — no `rand` crate dep (Phase 0 pin-guard rule). Default seeds from SystemTime nanos; tests override via `set_test_rng_seed`. Excel epoch (1899-12-30) used for NOW/TODAY serial dates; `set_test_now_secs` pins for tests.  
   308	   - All 4 registered in `default_registry`. Registry count now 30 (was 26).  
   309	   - `CalcgraphSession::mark_volatile_dirty()` — adds all volatile formulas to the dirty set AND calls `mark_dirty_from_cell_write` for each to fan out the reverse-dep BFS (VOL-3-02 wiring; downstream chains pick up the new value). Returns count of marked formulas.  
   310	   - `CalcgraphSession::volatile_count()` for observability.  
   311	   - The Phase 3.2 substrate (`is_volatile_function` whitelist + `volatile_formulas` set populated during dep extraction) was already in place; 3.7 just wires the tick.  
   312	   - Public `ql_functions::{set_test_rng_seed, set_test_now_secs, clear_test_overrides}` for engine + IDE test fixtures.  
   313	   13 new tests (9 volatile unit + 3 VOL-3-01..03 acceptance + 1 zero-volatile-noop). ql-exec at 315, ql-functions at 72, workspace at 939.  
   314	   Notes: RANDARRAY / INDIRECT / OFFSET / INFO / CELL still deferred to Phase 4.3 (function library expansion). NOW/TODAY date arithmetic is approximate (Excel 1900 leap-year quirk not modeled); Phase 4.5 (date/time + format) pins exact semantics.  
   315	   Effort: 2-4 days (actual: ~1 day; substrate from 3.2 made this small).
   316	
   317	8. **3.8 Value-Equality Short-Circuit** ✅ SHIPPED 2026-05-12 (W5-41)  
   318	   If a recomputed value is equal to the previous visible value, do not dirty downstream dependents beyond what is already required. Equality must respect Excel errors, blanks, numbers, text, bools, and dates.  
   319	   References: `.references/hyperformula/src/DependencyGraph/TopSort.ts`; `.references/hyperformula/src/interpreter/InterpreterValue.ts`; `crates/ql-types/src/value.rs`.  
   320	   Acceptance: VEQ-3-01 ✅ unchanged upstream suppresses downstream recompute (`veq_3_01_unchanged_upstream_suppresses_downstream_recompute`); VEQ-3-02 ✅ error equality is correct (`veq_3_02_error_equality_suppresses_downstream`); VEQ-3-03 ✅ profile records skipped vertices via `RecomputeResult.skipped_value_equality` (`veq_3_03_profile_records_skipped_vertices`).  
   321	   Shipped:  
   322	   - `RecomputeResult.skipped_value_equality: usize` — new public field counting how many dirty formulas were skipped via VEQ. Always 0 on `recompute_all` (legacy path).  
   323	   - `recompute_dirty` rewrite: snapshot prior values for all sched nodes; process in topo order; for each node, decide if it needs eval (volatile → yes, range deps → yes, top-level dirty → yes, has-changed-upstream → yes, otherwise → SKIP). After eval, compare new vs prior. If equal, suppress the computed-overlay write and don't mark as changed; downstream formulas observe "no changed deps" and skip too.  
   324	   - Cycled nodes apply VEQ: a pre-existing `#CIRC!` stays `#CIRC!`; skip the write but count.  
   325	   - Volatile formulas (NOW, RAND, etc.) bypass VEQ — they always re-evaluate (Phase 3.7 invariant preserved via `session.is_volatile(node)` check).  
   326	   - Aggregate-cache hits (Phase 3.6) interact correctly: a cached aggregate result that matches prior still counts as a VEQ skip when the formula's eval returns it.  
   327	   4 new tests (VEQ-3-01..03 + volatile-bypass regression). ql-exec at 319 (was 315). Workspace at 943 (was 939).  
   328	   Notes: V1 doesn't handle range-dep formulas with VEQ — they always re-evaluate. The Phase 3.6 aggregate cache already provides O(1) re-eval for unchanged ranges, so this is a small cost.  
   329	   Effort: 2-4 days (actual: ~1 day; the substrate from 3.3 BFS + 3.4 schedule_dirty + 3.6 prior-comparison-via-overlay made this small).
   330	
   331	9. **3.9 SIMD Region Through Graph Runtime** ✅ SHIPPED 2026-05-12 (W5-42, V1)  
   332	   Ensure region-style lowering and direct Arrow kernels are invoked from the graph scheduler rather than separate bench-only paths.  
   333	   References: `.references/formualizer/crates/formualizer-eval/src/stripes.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/range_view.rs`; `crates/ql-exec/src/{lower,simd}.rs`.  
   334	   Acceptance: SIMD-3-01 ✅ OG-02 `=A*2` pattern still classifies to `SimdShape::MulScalar`; `scripts/check-multiversion-clones.sh` confirms the multiversion clones are present in `mul_scalar` (`simd_3_01_og02_pattern_classifies_to_mul_scalar`); SIMD-3-02 ✅ `Operator::Div` returns `SimdShape::NotApplicable` so `10 / 0` emits Excel-canon `#DIV/0!` not `#NUM!` (`simd_3_02_division_falls_back_to_scalar`); SIMD-3-03 ✅ `RecomputeResult.simd_classified` counter exposes SIMD-eligibility of dirty formulas; legacy `recompute_all` is always 0 (`simd_3_03_profile_records_simd_eligible_formulas`).  
   335	   Shipped:  
   336	   - `RecomputeResult.simd_classified: usize` — new public field, parallel to `skipped_value_equality`. Counts dirty formulas whose `lower::classify` returns an applicable `SimdShape`.  
   337	   - `WorkbookRuntime::try_recompute_with_simd_profile` — slightly-expanded helper that returns `(Value, bool)` where the bool is the SIMD-eligibility flag. `try_recompute_with_aggregate_cache` is now a thin wrapper that discards the flag.  
   338	   - V1 observability only — actual bulk SIMD dispatch via `simd::*` kernels remains on the bench / FormulaRegion path. The Phase 4.7+ array-formula / FormulaRegion binder lands the real batching. The graph scheduler's awareness of SIMD-eligibility is the V1 contribution: the IDE / profile reader can now see WHERE region optimization would pay off.  
   339	   3 new acceptance tests + 1 regression. ql-exec at 322 (was 319). Workspace at 946 (was 943).  
   340	   Notes: this V1 is intentionally observability-focused. The MASTER-PLAN's 3-6 day effort estimate covered the full FormulaRegion-binder + per-region batched dispatch — that's structurally a Phase 4 task (depends on the array-formula binder + region detection at write time). Phase 3.10 megaudit will evaluate whether V1 is sufficient or whether a richer V1.1 is needed before Phase 4.  
   341	   Effort: 3-6 days (actual V1: ~0.5 day; the substrate from Phase 0 W4-2/3 and the bench gate already validated the kernel-level SIMD).
   342	
   343	10. **3.10 Phase 3 Megaudit** ✅ SHIPPED 2026-05-12 (W5-43)  
   344	    Independent audit of graph correctness, scheduler cycles, storage overlays, dirty propagation, aggregate invalidation, and perf regressions.  
   345	    Acceptance: A3-01 ✅ all 7 gates green pre- and post-audit; A3-02 ✅ dependency-chain correctness locked (with H1/H3/H4 documented as Phase 4 carryovers — root cause: Phase 0 append-only graph contract); A3-03 ✅ `crates/ql-exec/benches/a3_10k_dirty_recompute.rs` checked in (chain + idempotent edit shapes); A3-04 ⚠️ documented exception (946 tests vs ~1724 target — Phase 3 was substrate-completion, not new-feature; 84 net tests cover every declared acceptance gate without redundancy; broad expansion lands Phase 4 with function library + array formulas + date/time + xlsx).  
   346	    Audit dispatched: Codex (gpt-5-codex via `codex exec`) reviewed Phase 3.1–3.9 commits independently. Findings: 4 HIGH (H1 range-deps-not-edges, H2 set_name not transitive, H3/H4 append-only-graph rebind staleness), 4 MEDIUM, 3 LOW, 6 test gaps. **Closed in audit commit:** H2 (BFS fanout fix + regression test `h2_set_name_propagates_dirty_transitively`), L1 (architecture doc rewrite), L2 (GAP-G-01 re-classified from performance-only to correctness), T4 (set_name regression test). **Deferred to Phase 4 with documented gaps:** H1 → GAP-G-03 (range-as-scheduler-edge), H3+H4 → GAP-G-01 (now correctness; needs delta-edge graph), M1 → GAP-R-08 (volatile-dependent recompute Excel-canon), M3 → GAP-S-06 (load bounds for formula-only cells). Full audit report: `docs/audits/2026-05-12-phase-3-megaudit.md`.  
   347	    Effort: 3-5 days (actual: ~0.5 day including Codex dispatch + audit closure fixes).
   348	
   349	**Audit Checkpoints**
   350	
   351	- Internal checkpoint after 3.4 before overlay/cache work.
   352	- Megaudit after 3.9. This is mandatory because Phase 3 changes the engine spine.
   353	
   354	**IDE Proof Points**
   355	
   356	- IDE edits must trigger incremental recompute.
   357	- Diagnostics must identify cycles and dirty recompute failures.
   358	- Formula bar must show stable values after dependency-chain edits.
   359	
   360	**Exit Criteria**
   361	
   362	- No map-order recompute remains in product paths.
   363	- Runtime and fast engine are one graph-driven engine.
   364	- Range aggregates have first usable cache.
   365	- Computed/user overlay separation exists.
   366	- Volatile invalidation is explicit.
   367	
   368	**Documentation Deliverables**
   369	
   370	- `docs/phase3/entry-plan.md`.
   371	- `docs/phase3/exit-packet.md`.
   372	- `docs/architecture/calcgraph-runtime.md`.
   373	- Updated reference reading log entries for every borrowed pattern.
   374	
   375	## Phase 4 - Excel Coverage
   376	
   377	**Purpose:** Build broad Excel compatibility: parser breadth, function library, coercion/error matrices, dates/times, formatting, arrays/spills, tables, cross-sheet refs, named aggregate contexts, localization, and xlsx import/export.
   378	
   379	**Entry State Required**
   380	
   381	- Phase 3 graph runtime is shipped.
   382	- Aggregate, dirty, and volatile machinery exist.
   383	- **GAP-G-01 + GAP-G-03 SHIPPED (W5-50, 2026-05-13).** Decision recorded in `docs/architecture/2026-05-13-graph-storage-decision.md` (W5-49) and implemented W5-50: Option A — `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index, wired into `extract_and_register_deps`. Option C — `topo::schedule_with_supplemental` accepts a HashMap of temp adjacency; `CalcgraphSession::build_range_supplemental` constructs F→G edges for dirty-formula pairs inside ranges. FormulaRegion binder (Option B) still deferred to Phase 4.7. Phase 4.3 V2 (SUMIF/COUNTIF/lookup family) is **now unblocked**. Tests: +35 vs Phase 3 exit (981 → 1016 workspace).
   384	
   385	**Dependencies**
   386	
   387	- Array formulas, spills, structured references, xlsx formula load, and cross-sheet recalculation depend on Phase 3 graph integration.
   388	- IronCalc deep-read is mandatory at Phase 4 start.
   389	- ~~Phase 4.3 V2 is gated on GAP-G-01 (Option A) + GAP-G-03 (small Option C).~~ **Gate cleared W5-50.** Phase 4.7 (array formulas) consumes Option A's revocation API as well.
   390	
   391	**Sub-items**
   392	
   393	1. **4.1 IronCalc Parser Deep-Read And Parser Gap Matrix** ✅ SHIPPED 2026-05-12 (W5-44)  
   394	   Read IronCalc parser and lexer in the deferred order, then write a Quantbook parser gap matrix.  
   395	   References: `.references/ironcalc/base/src/expressions/parser/mod.rs`; `.references/ironcalc/base/src/expressions/lexer/mod.rs`; `.references/ironcalc/base/src/expressions/parser/static_analysis.rs`; `.references/ironcalc/base/src/expressions/parser/stringify.rs`; `.references/ironcalc/base/src/expressions/parser/move_formula.rs`.  
   396	   Acceptance: PAR-4-01 ✅ gap matrix checked in at `docs/parser/ironcalc-deep-read.md`; PAR-4-02 ✅ parser expansion (4.6/4.7/4.8/4.9 lexer + AST work) is now formally unlocked; PAR-4-03 ✅ license + provenance documented (IronCalc MIT + Apache-2.0; reference-only policy).  
   397	   Shipped:  
   398	   - Full token-kind gap analysis (IronCalc has 11 tokens we don't; we have a few simplifications IronCalc lacks).  
   399	   - Full AST-node gap analysis (IronCalc has 10 node variants we don't, mapped to Phase 4.6/4.7/4.8/4.9 / post-v1 buckets).  
   400	   - Feature parity table covering A1/R1C1/cross-sheet/array/structured/LAMBDA/implicit-intersection/spill/localization/move-formula.  
   401	   - Architectural recommendations: adopt IronCalc's precedence tower for Phase 4.7; locale threading pattern for 4.9; recoverable parse errors via AST `ParseError` nodes for 4.4 error matrix; move-formula as separate tree-walk pass for Phase 5+ copy/paste.  
   402	   - Sequencing recommendation: collapse 4.6+4.7+4.8 lexer work into one token-set expansion sprint to avoid three back-to-back lexer churns.  
   403	   - Surfaced GAP-G-01 + GAP-G-03 (Phase 3.10 megaudit carryovers) as Phase 4 entry decisions — array formulas + function library expansion both rebind formulas at scale; the append-only graph fix needs to happen before 4.3 or be a known limitation gated by 4.12 megaudit.  
   404	   Effort: 2-4 days (actual: ~0.5 day; Explore subagent did the IronCalc survey).
   405	
   406	2. **4.2 Excel Compatibility Matrix Harness** ✅ SHIPPED 2026-05-12 (W5-45); doc honesty patched W5-48  
   407	   Create a checked-in matrix for functions, operators, coercions, errors, arrays, tables, date systems, localization, and xlsx import/export.  
   408	   References: `.references/formualizer/benchmarks/function_matrix.yaml` (taxonomy ref only — not directly applicable; formualizer's matrix is benchmark-scenario claim-safety, not per-function compat); `.references/ironcalc/base/src/test/` (used implicitly via Phase 4.1 gap matrix).  
   409	   Acceptance:  
   410	   - ECM-4-01 ✅ matrix exists at `docs/compat/excel-matrix.md`.  
   411	   - ECM-4-02 ⚠️ **PARTIAL** (revised W5-48 per Codex deep-audit): each function row carries Status + Tests + Phase + Notes; the CATEGORY for each function is the `###` section header it lives under (Aggregates/Statistical, Logical, Math&Trig, Text, Date&Time, Lookup&Reference, Information, Financial, Engineering, Database, Reserved) rather than a per-row column. ~52 rows have empty/short Notes — full per-row parity-note expansion is the documented Phase 4.3+ follow-up. The original ECM-4-02 prose was rewritten to match the actual schema.  
   412	   - ECM-4-03 ✅ `scripts/report-compat-coverage.sh` parses the matrix and emits human-readable + JSON output with per-category breakdown and headline `coverage=NN%`.  
   413	   Shipped baseline: 217 rows (post-W5-46 + W5-48 status revisions: 70 ✅ + 16 ⚠️ + 1 🔄 + 130 ❌) ≈ **40% coverage**.  
   414	   Effort: 2-3 days (actual: ~0.5 day for V1 + 0.1 day for audit closure).
   415	
   416	3. **4.3 Function Library Expansion Wave 1 - Core 100** 🔄 IN PROGRESS (V1 batch shipped 2026-05-13, W5-46; FN4-02 backfill W5-48)  
   417	   Implement high-use math, logical, text, lookup, statistical, date/time, and information functions. Include metadata for volatility, laziness, array behavior, and argument coercion.  
   418	   **V2 prerequisites (W5-49 decision; SHIPPED W5-50 + W5-52):**
   419	   - GAP-G-01 + GAP-G-03 (graph correctness): SHIPPED. W5-50 wired revocation into the rebind path; W5-52 (mega-audit closure) extended it to the clear path that W5-50 missed. See `docs/architecture/2026-05-13-graph-storage-decision.md`.
   420	   - ~~**GAP-F-05 (function-dispatch signature)**~~ **SHIPPED W5-53.** Parallel `RangeAwareFn = fn(&[FnArg]) -> Value` table added to `FunctionRegistry`; `enum FnArg { Scalar(Value), Range(Vec<Value>) }`. Eval-side dispatch checks the range-aware table first. SUMIF + COUNTIF shipped in the same commit as the first range-aware functions. The full range-aware family (SUMIFS / AVERAGEIF / SUMPRODUCT / VLOOKUP / HLOOKUP / MATCH / INDEX / CHOOSE) is now safely unblocked.

exec
/bin/zsh -lc "rg -n \"5\\.3|Phase 5\\.3|repair|Rename|status|Status|✅|⏳|TODO\" quantbook-engine/docs/phase5/v1-exit-packet.md && nl -ba quantbook-engine/docs/phase5/v1-exit-packet.md | sed -n '1,260p;260,560p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
3:status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20** (all 8 steps + 7 per-step audits + 1 megaudit). See `docs/phase5/d-1-exit-packet.md`. 5.3, 5.5 V2 V2/V3, 5.7, and 5.8 also remain.
20:Phase 5.2 D-1 (FormatId tagged tuple) ✅ SHIPPED 2026-05-20 — see
21:`docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
25:## Acceptance criteria status (Phase 5 V1)
27:| ID | Criterion | Status | Evidence |
29:| A5V1-01 | All workspace gates green | ✅ | 4222 workspace tests passing; fmt + clippy clean workspace-wide |
30:| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
31:| A5V1-03 | `ql-collab` substantively populated | ✅ | 5 modules (peer / session / transport / presence / undo) + ~30 public methods + 67 unit tests + 1 integration test |
32:| A5V1-04 | Op-log + Loro merge semantics verified for multi-peer | ✅ | `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` (4 tests) + 8 paired LoopbackTransport tests + 2-peer round-trip via attached transport |
33:| A5V1-05 | Audit discipline preserved | ✅ | 2-way Codex + Opus audit dispatched after every substantive cycle; 7 of 10 cycles caught HIGH/MEDIUM findings convergently |
39:| Sub-phase | Theme | Status | Commit(s) |
41:| 5.1 | CRDT data model decision | ✅ AUDIT-CLOSED | `918d7efdd91` (design) + `df52cb44ad2` (4 decisions D-1..D-4 locked) |
42:| Tier D2 | `ql-oplog → ql-io` dependency inversion | ✅ SHIPPED | `e15e8908742` |
43:| 5.2 D-2 | AddSheet auto-rename on duplicate | ✅ SHIPPED | `1ca19e2fa37` |
44:| 5.2 D-3 | BindError::UnknownSheet → ErrorValue::Name | ✅ SHIPPED | `e71312d4bcd` |
45:| 5.2 D-4 | OpLog::merge_bytes + 2-peer spill probe | ✅ SHIPPED | `2f217a2067a` |
46:| 5.2.a | `ql-collab` scaffold (PeerId + CollabSession + Transport) | ✅ SHIPPED | `66a571b30af` |
47:| 5.2.b | PeerId → LoroDoc::set_peer_id wiring | ✅ SHIPPED | `ef056f50bee` + `524b5a8c231` (audit closures) |
48:| 5.6 V1 | Presence map (per-peer cursor + selection) | ✅ SHIPPED | `c677e244704` + `43f20abc887` (audit closures) |
49:| 5.4 V1 | Peer-local undo/redo via Loro UndoManager | ✅ SHIPPED | `89c02b9d83e` + `e2ba052a626` (audit closures) |
50:| 5.5 V1 | LoopbackTransport for 2-peer round-trip tests | ✅ SHIPPED | `3590aa6d89e` + `924750819bc` (truncation fix) + `bfa8401e1b5` (audit closures) |
51:| 5.5 V2 V1 | CollabSession transport wrappers (attach/detach/flush/poll) | ✅ SHIPPED | `ffd8f6e5f05` + `ad9b18fe133` (audit closures) |
52:| 5.4 V2 V1 | Undo grouping + merge-interval | ✅ SHIPPED | `6138a7203f6` + `e199a5fda5a` (truncation fix + audit closures) |
53:| 5.4 V2 V1.1 | RAII UndoGroupGuard (panic/Err-safe grouping) | ✅ SHIPPED | `7cbdc689ea9` + `d49e873f237` (Codex audit PASS) |
54:| **Phase 5 V1 exit packet** (this doc) | ✅ shipped | `b8b2e04e0d7` |
55:| 5.6 V2 (sweep_presence — closes V1 persistence known-limitation) | ✅ shipped | `d4b3cdb2dc2` |
56:| D1.a cluster 1 (add_sheet_rejects test → sheets.rs) | ✅ shipped | `06252f2b638` |
57:| D1.a cluster 2 (clear_formula_rejects_* → cells.rs) | ✅ shipped | `9b45ee656eb` + `4528dc62c3b` (backlog status) |
58:| D1.a clusters 3+4 (set_formula canonicalization + drop_table) — **D1.a COMPLETE** | ✅ shipped | `93210e43567` |
152:| ID | Decision | Status |
154:| D-1 | `FormatId` → tagged tuple `{ Builtin(u32), Custom(PeerId, u32) }` | ✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit. See `docs/phase5/d-1-exit-packet.md`. |
155:| D-2 | AddSheet auto-rename on duplicate canonical | ✅ SHIPPED `1ca19e2fa37` |
156:| D-3 | `BindError::UnknownSheet → ErrorValue::Name` mapping | ✅ SHIPPED `e71312d4bcd` |
157:| D-4 | Spill semantics: replay defers to recompute, not per-op | ✅ SHIPPED `2f217a2067a` |
185:1. Phase 5.5 V1 (`3590aa6d89e`, truncated `session.rs` + `transport.rs`) — caught by self-audit reading git diff; repaired in `924750819bc`.
186:2. Phase 5.4 V2 V1 (`6138a7203f6`, truncated `session.rs`) — caught by BOTH Codex + Opus 2-way audit via clean-checkout verification; repaired in `e199a5fda5a`.
217:- **Phase 5.2 D-1 — FormatId tagged tuple.** ✅ **SHIPPED 2026-05-20.**
226:- **Phase 5.3 — Conflict resolution semantics.** Causality-aware
227:  rename-repair pass at merge time (currently V1 emits `#NAME?`
236:  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
248:- ~~**Phase 5.6 V2 — Presence eviction sweep**~~ — ✅ SHIPPED
257:- ~~**Tier D1.a — test-cluster re-partitioning**~~ — ✅ SHIPPED
     1	---
     2	title: Phase 5 V1 exit packet (5.1 → 5.6 V1+V2 + 5.4 V2 V1+V1.1 + 5.5 V2 V1 + D1.a)
     3	status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20** (all 8 steps + 7 per-step audits + 1 megaudit). See `docs/phase5/d-1-exit-packet.md`. 5.3, 5.5 V2 V2/V3, 5.7, and 5.8 also remain.
     4	date: 2026-05-19
     5	updated: 2026-05-20 (post-exit-packet additions: 5.6 V2 sweep_presence + D1.a 4-cluster closure + D-1 ALL STEPS SHIPPED)
     6	predecessor: docs/phase4/exit-packet.md + docs/phase5/entry-plan.md
     7	successor: docs/phase5/d-1-starting-checklist.md (fresh-session entry for the multi-day D-1 arc)
     8	supersedes_pointer: docs/phase5/entry-plan.md (entry-plan stays as historical scope reference; this packet is the closeout)
     9	---
    10	
    11	# Phase 5 V1 exit packet — multi-user CRDT collaboration substrate
    12	
    13	This packet closes the Phase 5 **V1 surface** of the Quantbook
    14	engine. V1 shipped the engine-side collaboration data model end-to-
    15	end: CRDT data model decision (5.1), op-log semantic decisions
    16	(5.2 D-2/D-3/D-4 + 5.2.a scaffold + 5.2.b set_peer_id), peer-local
    17	undo (5.4 V1 + V2 V1 + V2 V1.1), in-process transport (5.5 V1 +
    18	V2 V1), and ephemeral presence (5.6 V1).
    19	
    20	Phase 5.2 D-1 (FormatId tagged tuple) ✅ SHIPPED 2026-05-20 — see
    21	`docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
    22	+ Phase 5.5 V2 V2/V3 (WebSocket / auto-flush) + Phase 5.7 IDE
    23	vertical slice remain ahead of the 5.8 megaudit.
    24	
    25	## Acceptance criteria status (Phase 5 V1)
    26	
    27	| ID | Criterion | Status | Evidence |
    28	|---|---|---|---|
    29	| A5V1-01 | All workspace gates green | ✅ | 4222 workspace tests passing; fmt + clippy clean workspace-wide |
    30	| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
    31	| A5V1-03 | `ql-collab` substantively populated | ✅ | 5 modules (peer / session / transport / presence / undo) + ~30 public methods + 67 unit tests + 1 integration test |
    32	| A5V1-04 | Op-log + Loro merge semantics verified for multi-peer | ✅ | `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` (4 tests) + 8 paired LoopbackTransport tests + 2-peer round-trip via attached transport |
    33	| A5V1-05 | Audit discipline preserved | ✅ | 2-way Codex + Opus audit dispatched after every substantive cycle; 7 of 10 cycles caught HIGH/MEDIUM findings convergently |
    34	
    35	All five acceptance criteria empirically met.
    36	
    37	## Sub-phase shipped tally
    38	
    39	| Sub-phase | Theme | Status | Commit(s) |
    40	|---|---|---|---|
    41	| 5.1 | CRDT data model decision | ✅ AUDIT-CLOSED | `918d7efdd91` (design) + `df52cb44ad2` (4 decisions D-1..D-4 locked) |
    42	| Tier D2 | `ql-oplog → ql-io` dependency inversion | ✅ SHIPPED | `e15e8908742` |
    43	| 5.2 D-2 | AddSheet auto-rename on duplicate | ✅ SHIPPED | `1ca19e2fa37` |
    44	| 5.2 D-3 | BindError::UnknownSheet → ErrorValue::Name | ✅ SHIPPED | `e71312d4bcd` |
    45	| 5.2 D-4 | OpLog::merge_bytes + 2-peer spill probe | ✅ SHIPPED | `2f217a2067a` |
    46	| 5.2.a | `ql-collab` scaffold (PeerId + CollabSession + Transport) | ✅ SHIPPED | `66a571b30af` |
    47	| 5.2.b | PeerId → LoroDoc::set_peer_id wiring | ✅ SHIPPED | `ef056f50bee` + `524b5a8c231` (audit closures) |
    48	| 5.6 V1 | Presence map (per-peer cursor + selection) | ✅ SHIPPED | `c677e244704` + `43f20abc887` (audit closures) |
    49	| 5.4 V1 | Peer-local undo/redo via Loro UndoManager | ✅ SHIPPED | `89c02b9d83e` + `e2ba052a626` (audit closures) |
    50	| 5.5 V1 | LoopbackTransport for 2-peer round-trip tests | ✅ SHIPPED | `3590aa6d89e` + `924750819bc` (truncation fix) + `bfa8401e1b5` (audit closures) |
    51	| 5.5 V2 V1 | CollabSession transport wrappers (attach/detach/flush/poll) | ✅ SHIPPED | `ffd8f6e5f05` + `ad9b18fe133` (audit closures) |
    52	| 5.4 V2 V1 | Undo grouping + merge-interval | ✅ SHIPPED | `6138a7203f6` + `e199a5fda5a` (truncation fix + audit closures) |
    53	| 5.4 V2 V1.1 | RAII UndoGroupGuard (panic/Err-safe grouping) | ✅ SHIPPED | `7cbdc689ea9` + `d49e873f237` (Codex audit PASS) |
    54	| **Phase 5 V1 exit packet** (this doc) | ✅ shipped | `b8b2e04e0d7` |
    55	| 5.6 V2 (sweep_presence — closes V1 persistence known-limitation) | ✅ shipped | `d4b3cdb2dc2` |
    56	| D1.a cluster 1 (add_sheet_rejects test → sheets.rs) | ✅ shipped | `06252f2b638` |
    57	| D1.a cluster 2 (clear_formula_rejects_* → cells.rs) | ✅ shipped | `9b45ee656eb` + `4528dc62c3b` (backlog status) |
    58	| D1.a clusters 3+4 (set_formula canonicalization + drop_table) — **D1.a COMPLETE** | ✅ shipped | `93210e43567` |
    59	
    60	**23 commits to exit-packet ship + 7 post-exit-packet commits = 30 commits total** in the Phase 5 V1 arc.
    61	
    62	Post-exit-packet adds (2026-05-19 session-end additions):
    63	- Phase 5.6 V2 sweep_presence (+3 tests; closes V1 persistence known-limitation).
    64	- D1.a re-partitioning across 4 clusters (9 tests relocated; net 0 workspace test count change since these are byte-identical relocations).
    65	
    66	## Final API surface (ql-collab)
    67	
    68	```rust
    69	// Identity
    70	pub struct PeerId(pub u64);  // 16-hex Display; matches Loro's u64 peer id
    71	
    72	// Per-peer session
    73	pub struct CollabSession {
    74	    peer_id: PeerId,
    75	    log: OpLog,
    76	    undo: loro::UndoManager,
    77	    transport: Option<Box<dyn Transport + Send>>,
    78	}
    79	
    80	impl CollabSession {
    81	    // Construction
    82	    pub fn new(peer_id: PeerId) -> Result<Self, _>;
    83	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, _>;
    84	
    85	    // State access
    86	    pub fn peer_id(&self) -> PeerId;
    87	    pub fn op_log(&self) -> &OpLog;
    88	    pub fn op_count(&self) -> usize;
    89	    pub fn is_empty(&self) -> bool;
    90	
    91	    // Op log + merge
    92	    pub fn append_op(&mut self, op: Op) -> Result<(), _>;
    93	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, _>;
    94	    pub fn export_bytes(&self) -> Result<Vec<u8>, _>;
    95	
    96	    // Undo / redo (5.4 V1)
    97	    pub fn undo(&mut self) -> Result<bool, _>;
    98	    pub fn redo(&mut self) -> Result<bool, _>;
    99	    pub fn can_undo(&self) -> bool;
   100	    pub fn can_redo(&self) -> bool;
   101	    pub fn undo_count(&self) -> usize;
   102	    pub fn redo_count(&self) -> usize;
   103	    pub fn clear_undo_stack(&self);
   104	
   105	    // Undo grouping (5.4 V2 V1 + V1.1)
   106	    pub fn start_undo_group(&mut self) -> Result<(), _>;
   107	    pub fn end_undo_group(&mut self);
   108	    pub fn set_undo_merge_interval(&mut self, ms: i64);
   109	    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, _>;
   110	
   111	    // Transport (5.5 V2 V1)
   112	    pub fn attach_transport<T: Transport + Send + 'static>(&mut self, t: T) -> Option<Box<...>>;
   113	    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>>;
   114	    pub fn has_transport(&self) -> bool;
   115	    pub fn flush_to_transport(&mut self) -> Result<bool, _>;
   116	    pub fn poll_remote(&mut self) -> Result<usize, _>;
   117	    pub fn poll_remote_with_limit(&mut self, max: usize) -> Result<usize, _>;
   118	
   119	    // Presence (5.6 V1 + V2)
   120	    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), _>;
   121	    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, _>;
   122	    pub fn clear_presence(&mut self) -> Result<(), _>;
   123	    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, _>;
   124	    pub fn sweep_presence(&mut self) -> Result<usize, _>;  // V2: clear all, return count
   125	}
   126	
   127	// Transport
   128	pub trait Transport {
   129	    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
   130	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
   131	}
   132	pub struct NoopTransport { ... }
   133	pub struct LoopbackTransport { ... }  // pair() returns 2 endpoints
   134	
   135	// Presence (5.6 V1)
   136	pub struct PresenceState {
   137	    pub sheet: u16,
   138	    pub row: u32, pub col: u32,
   139	    pub selection_end_row: u32, pub selection_end_col: u32,
   140	    pub typing: bool,
   141	}
   142	
   143	// Undo RAII (5.4 V2 V1.1)
   144	pub struct UndoGroupGuard<'a> { ... }  // Drop calls end_undo_group
   145	impl Deref<Target = CollabSession> + DerefMut for UndoGroupGuard
   146	```
   147	
   148	Total: **~31 public methods + 5 types** on `ql-collab` (was 30 at exit-packet; +1 sweep_presence in V2 follow-up).
   149	
   150	## Audit-locked decisions (Phase 5.1)
   151	
   152	| ID | Decision | Status |
   153	|---|---|---|
   154	| D-1 | `FormatId` → tagged tuple `{ Builtin(u32), Custom(PeerId, u32) }` | ✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit. See `docs/phase5/d-1-exit-packet.md`. |
   155	| D-2 | AddSheet auto-rename on duplicate canonical | ✅ SHIPPED `1ca19e2fa37` |
   156	| D-3 | `BindError::UnknownSheet → ErrorValue::Name` mapping | ✅ SHIPPED `e71312d4bcd` |
   157	| D-4 | Spill semantics: replay defers to recompute, not per-op | ✅ SHIPPED `2f217a2067a` |
   158	
   159	## Audit discipline performance
   160	
   161	The 2-way Codex + Opus audit rule was applied to **9 of 10** substantive cycles (5.6 V1 ran Codex-only due to Anthropic 529 outage × 3 Opus retries; 5.4 V2 V1.1 ran Codex-only as a documented follow-up to a pre-audited design).
   162	
   163	| Cycle | Codex finding | Opus finding | Convergent? |
   164	|---|---|---|---|
   165	| 5.2.b set_peer_id | MEDIUM: API exposure of set_peer_id | HIGH: silent undo-stack-clear footgun | Same root cause, different framing |
   166	| 5.6 V1 presence | MEDIUM: persistence contract drift | (529 unavailable) | N/A — Codex-only this cycle |
   167	| 5.4 V1 undo | HIGH: cached_len stale after undo | HIGH: silent set_peer_id footgun (different angle) | Both unique correctness HIGHs |
   168	| 5.5 V1 LoopbackTransport | MEDIUM: drain-before-Closed contract violation | HIGH: same finding, different framing | Yes |
   169	| 5.5 V2 V1 transport wrappers | MEDIUM: poll_remote unbounded + partial-merge ambiguity | HIGH: same | Yes |
   170	| 5.4 V2 V1 undo grouping | HIGH: TRUNCATION (commit blob broken) | HIGH: same TRUNCATION | Yes |
   171	| 5.4 V2 V1.1 RAII guard | (Codex-only) PASS | (skipped — pre-audited design) | N/A |
   172	
   173	**8 of 9 cycles that ran 2-way caught real correctness/contract bugs.**
   174	**5 of 9 cycles caught convergent findings from both auditors.**
   175	
   176	The 2-way audit-discipline rule is validated as load-bearing —
   177	without either auditor, real bugs would have shipped (cached_len
   178	stale, drain-before-Closed contract violation, truncation race
   179	twice, etc.).
   180	
   181	## Index-padding race incidents
   182	
   183	The `cargo fmt --all` × `git add` race noted in user memory
   184	(`git_index_padding_race.md`) recurred **3 times** this session:
   185	1. Phase 5.5 V1 (`3590aa6d89e`, truncated `session.rs` + `transport.rs`) — caught by self-audit reading git diff; repaired in `924750819bc`.
   186	2. Phase 5.4 V2 V1 (`6138a7203f6`, truncated `session.rs`) — caught by BOTH Codex + Opus 2-way audit via clean-checkout verification; repaired in `e199a5fda5a`.
   187	3. Phase 5.4 V2 V1.1 audit-closure commit + 5.4 V2 V1 audit-closure commit + D1.a cluster 2 commit each hit `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` in the pre-commit hook (recovered via re-stage + retry; no truncation made it into the blob those times — different failure mode than incidents 1+2 but same root cause: cargo fmt × git add timing on large files).
   188	
   189	The recurring pre-commit-hook `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
   190	error pattern is well-documented; mitigation (re-stage + commit
   191	fix) works reliably. Root-cause investigation of the husky
   192	precommit hook's stdio handling is forward work for a separate
   193	session.
   194	
   195	## Test count evolution
   196	
   197	| Phase milestone | Workspace test count |
   198	|---|---|
   199	| Phase 4 exit | 4131 |
   200	| Phase 5.1 audit-closed | (no change; design-only) |
   201	| Phase 5.2.b ship | 4164 (+33 across 5.2 D-2/D-3/D-4 + 5.2.a + 5.2.b) |
   202	| Phase 5.6 V1 ship + audit | 4180 (+16) |
   203	| Phase 5.4 V1 ship + audit | 4187 (+7) |
   204	| Phase 5.5 V1 ship + audit | 4196 (+9) |
   205	| Phase 5.5 V2 V1 ship + audit | 4209 (+13) |
   206	| Phase 5.4 V2 V1 ship + audit | 4215 (+6) |
   207	| Phase 5.4 V2 V1.1 ship | 4219 (+4) |
   208	| Phase 5.6 V2 sweep_presence | 4222 (+3) |
   209	| D1.a clusters 1-4 (relocations) | **4222** (0 net; byte-identical) |
   210	
   211	Phase 5 V1 added **91 net tests** to the engine.
   212	
   213	## What's deferred (forward work for next session(s))
   214	
   215	### Major (multi-day)
   216	
   217	- **Phase 5.2 D-1 — FormatId tagged tuple.** ✅ **SHIPPED 2026-05-20.**
   218	  All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit
   219	  complete. See `docs/phase5/d-1-exit-packet.md` for the closure
   220	  record (final HEAD `6e32c269c22`; workspace tests 4222 → 4291;
   221	  16/16 audit cycles caught real bugs). Touched `ql-types::peer`,
   222	  `ql-storage::format`, `ql-oplog::wire` + `op` + `replay`,
   223	  `ql-io::qbook_format` (v7→v8) + `oplog_persistence` (Tier D3
   224	  header), `ql-io-xlsx::write::umya_export` (XlsxNumFmtTranslation).
   225	
   226	- **Phase 5.3 — Conflict resolution semantics.** Causality-aware
   227	  rename-repair pass at merge time (currently V1 emits `#NAME?`
   228	  for concurrent edits to renamed sheets). 4-7 days estimated.
   229	
   230	- **Phase 5.5 V2 V2 / V3 — Production transport.** WebSocket impl
   231	  + reconnect / offline sync + auto-flush on append (with
   232	  per-transport version-vector tracking for delta exports).
   233	  1-2 weeks estimated.
   234	
   235	- **Phase 5.7 — IDE vertical slice.** Two-window editing demo.
   236	  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
   237	
   238	- **Phase 5.8 — Megaudit.** Randomized peer-merge tests +
   239	  transport failure modes. 4-6 days.
   240	
   241	### Minor (V2 V2 polish)
   242	
   243	- **Phase 5.4 V2 V2 — UndoManager push/pop listeners** (lower
   244	  priority; UndoManager already exposed via `pub use loro::UndoManager`;
   245	  Loro's API surface is complex — couples to `UndoOrRedo`,
   246	  `CounterSpan`, `DiffEvent`, `UndoItemMeta`; defer until Phase 5.7
   247	  IDE surfaces a concrete consumer need).
   248	- ~~**Phase 5.6 V2 — Presence eviction sweep**~~ — ✅ SHIPPED
   249	  `d4b3cdb2dc2` as `CollabSession::sweep_presence` (caller-opt-in).
   250	
   251	### Infrastructure
   252	
   253	- **Tier D3 — `oplog.bin` magic bytes + version header.** Bundle
   254	  with D-1 schema work (it's the discriminator the loader uses to
   255	  detect old envelope schemas for migration).
   256	- **Tier C2 — BatchCommit depth guard.** Low priority.
   257	- ~~**Tier D1.a — test-cluster re-partitioning**~~ — ✅ SHIPPED
   258	  across 4 commits (`06252f2b638`, `9b45ee656eb`, `4528dc62c3b`,
   259	  `93210e43567`). 9 tests relocated to their semantically correct
   260	  owning submodules. Pure mechanical, net 0 test count change.
   260	  owning submodules. Pure mechanical, net 0 test count change.
   261	- **Index-padding race root-cause** in husky precommit hook —
   262	  recurring `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` on large-file edits
   263	  + cargo fmt × git add race. 3 incidents this session; mitigation
   264	  (re-stage + retry) reliable but root cause is forward work.
   265	
   266	## Cross-references
   267	
   268	- `docs/phase5/entry-plan.md` — Phase 5 entry plan (still active for scope).
   269	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
   270	- `docs/known-gaps.md` — GAP-C-03 / C-04 / C-05 closed at V1; remaining items.
   271	- `docs/MASTER-PLAN.md` §541-621 — Phase 5 sub-items + acceptance.
   272	- `docs/audits/2026-05-19-*.md` — 23 audit transcripts across 11 audit cycles (each cycle produced 2-3 docs: Codex + Opus + Consolidated, with 5.6 V1 missing Opus due to Anthropic 529 × 3 retries and 5.4 V2 V1.1 Codex-only per documented justification).
   273	
   274	## Verdict
   275	
   276	**Phase 5 V1 is COMPLETE.** The engine-side collaboration substrate
   277	ships as a usable surface for Phase 5.7 IDE integration. D-1 is the
   278	natural fresh-session starting point for the next Phase 5 push.

exec
/bin/zsh -lc "rg -n \"DropTable|drop_table|case[-_ ]only|same-canonical|same canonical|SHEET1|RenameColumn|rename_column|column repair|UnknownTable|UnknownColumn|#NAME|TableNotFound|TableColumnRejected\" quantbook-engine/crates/ql-oplog/tests quantbook-engine/crates/ql-collab/tests quantbook-engine/crates/ql-exec/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:619:/// **W5-118 (Phase 4.8.H) e2e:** drop_table emits Op::DropTable; replay
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:621:/// UnknownTable (we verify by checking the table is absent).
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:623:fn drop_table_op_log_replay_removes_table() {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:631:        rt.drop_table("Sales").unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:643:/// **W5-121 (Phase 4.8.I.2) e2e:** rename_column emits
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:644:/// `Op::RenameColumn` + `Op::PutFormula` for each rewritten cell;
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:650:fn rename_column_op_log_replay_reconstructs_rename() {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:661:        let n = rt.rename_column("Sales", "Qty", "Quantity").unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:893:/// producer emits `create_table → rename_column → resize_table` (the
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:900:fn composed_create_rename_column_resize_replay_roundtrip() {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:919:        let n = rt.rename_column("Sales", "Price", "Cost").unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:947:/// save → load → `rename_column` → verify formula text + value
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:952:fn composed_save_load_then_rename_column_roundtrip() {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:980:        let n = rt.rename_column("Sales", "Qty", "Quantity").unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:497:/// **Step 2 audit closure (Codex MEDIUM-1):** case-only renames
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:498:/// (e.g., "Sheet1" → "SHEET1") must update the display name even
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:500:/// check used canonical comparison and silently dropped case-only
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:503:fn step2_audit_case_only_rename_updates_display_name() {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:513:        new_name: "SHEET1".to_owned(),
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:520:        "SHEET1",
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:521:        "case-only rename must update display name (Codex MEDIUM-1 closure); \
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:1://! Phase 5.3 step 4 — concurrent RenameTable + RenameColumn replay
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:7://! `apply_rename_column` (`replay.rs:749`) hard-fail under CRDT
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:61:/// op hard-failed with `TableNotFound`. Post-step-4: replay applies
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:162:// ===== RenameColumn: concurrent rename =====
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:168:fn step4_concurrent_rename_column_different_targets_no_hard_fail() {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:175:        .append(Op::RenameColumn {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:183:        .append(Op::RenameColumn {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:207:/// produced {Z, Z(2)} but no column repair pass landed → silent
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:218:        .append(Op::RenameColumn {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:226:        .append(Op::RenameColumn {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:266:    log.append(Op::RenameColumn {
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:336:        rt.drop_table("T1").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:457:fn i1_drop_table_invalidates_dependent_formulas() {
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:471:        rt.drop_table("T").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:475:    println!("[I1] after drop_table: {after:?}");
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:478:            println!("[I1 OK] dropped-table dependent → #NAME?/#REF!");
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:482:            got {after:?}, expected #NAME?/#REF!"
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:768:fn i12_drop_table_name_pointing_into_data_range_still_works() {
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:786:        rt.drop_table("T").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:790:    println!("[I12] after drop_table, SUM(MyData) = {v:?}");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:8://! `#NAME?`).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:78:/// recompute → #NAME?. Post-step-3 the formula references the current
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:574:    // historic_canonicals contains "SHEET1" (canonical uppercase).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:575:    assert_eq!(summary.historic_canonicals, vec!["SHEET1"]);
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:227:            | Op::DropTable { .. }
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:229:            | Op::RenameColumn { .. }
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:10://! - Empty new_name + same-canonical no-op (replay rejects/skips)
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:154:/// renamed table. Pre-step-4: TableNotFound hard-fail. Post-step-4:
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:32://! - Row 8: DropTable × concurrent edit referencing T — pinned here
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:33://!   (D-3 → #NAME?; no repair planned — drop is destructive)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:72:/// covering A1:B3 with header row. Used by the DropTable conflict
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:590:        // this call, recompute would surface #NAME? (D-3 V1 limitation).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:617:         got {a2_a:?}. Without the repair pass, this would be #NAME? (D-3 V1 limitation)."
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:628:// ===== Row 8: DropTable × concurrent edit referencing T =====
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:633:/// `T[X]` reference binds to UnknownTable → recompute emits
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:634:/// `#NAME?` (D-3 mapping `e71312d4bcd` shipped).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:638:/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:642:/// the original test claimed "DropTable wins deterministically"
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:643:/// — imprecise. The correct statement: BOTH ops apply (DropTable
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:646:/// no longer contains T) regardless of causal order → #NAME? is
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:654:        Op::DropTable {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:670:    // T is dropped (DropTable always applies — there's no
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:672:    // fails → #NAME? per D-3.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:676:        "A5 must emit #NAME? (D-3: BindError::UnknownTable → ErrorValue::Name); got {a5_a:?}"

exec
/bin/zsh -lc "rg -n \"BindError|UnknownTable|UnknownColumn|UnknownSheet|TableColumn|Structured|Name\\)\" quantbook-engine/crates/ql-exec/src quantbook-engine/crates/ql-formula-semantics/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/src/env.rs:121:    /// known. Used by the eval-side `ExprPlan::StructuredRef` arm to
quantbook-engine/crates/ql-exec/src/env.rs:288:    /// constructed via `with_formula_cell`. The scalar.rs StructuredRef
quantbook-engine/crates/ql-exec/src/env.rs:427:/// `ResolvedName` variants (the binder converts them to specific `BindError`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:226:    /// the formula (via `ExprPlan::StructuredRef.table_name`). Used by
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:368:        ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:400:/// - `StructuredRef { table_name, resolved }` — register the TABLE name
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:426:        ExprPlan::StructuredRef { table_name, .. } => {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:473:    /// `ExprPlan::StructuredRef`. Used by `on_table_*` mutation
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:796:        // `table_to_formulas` for every StructuredRef table dep.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:842:            // Re-binding a formula whose StructuredRef target
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1117:    /// 2. Re-bind it (table is gone → `BindError::UnknownTable` →
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1312:    /// every reader's cached `ExprPlan::StructuredRef.resolved`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1726:    use crate::plan::BindError;
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2161:            (0, 0, 2, "SUM(MyUnknownName1)"), // bind fail (UnresolvedName)
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2194:                RuntimeError::Bind(BindError::UnresolvedName(_))
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3966:    // StructuredRef-bearing formula registers in `table_to_formulas`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3971:    /// **W5-154:** `table_to_formulas` populates for StructuredRef
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3973:    /// `ExprPlan::StructuredRef` and pushes the table name into
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3981:        // Synthesize an ExprPlan::StructuredRef directly. Range value
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3983:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4007:        let plan_f1 = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4039:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4060:    /// **W5-154:** rebinding a formula whose StructuredRef target
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4070:        let plan_v1 = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4080:        let plan_v2 = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4132:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4173:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4201:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4249:        let qty_plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4257:        let price_plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4291:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4332:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4356:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4397:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4424:        let plan = ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:72:        ExprPlan::Function { .. } => Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/scalar.rs:106:        ExprPlan::StructuredRef { .. } => Value::Error(ErrorValue::Calc),
quantbook-engine/crates/ql-exec/src/scalar.rs:204:                            ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:261:                            ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:337:                        // **W5-116/117 (Phase 4.8.G + G.2):** single-StructuredRef
quantbook-engine/crates/ql-exec/src/scalar.rs:343:                        [ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:380:                                | ExprPlan::StructuredRef { .. }
quantbook-engine/crates/ql-exec/src/scalar.rs:398:                                ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:463:                None => Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/scalar.rs:467:        // supposed to surface `BindError::NamedRangeInScalarContext`
quantbook-engine/crates/ql-exec/src/scalar.rs:491:        ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:505:/// **W5-117 (Phase 4.8.G.2):** narrow a `StructuredRef::resolved` range
quantbook-engine/crates/ql-exec/src/scalar.rs:545:/// Coordinate-only path for `AggregateNameRef`/`RangeRef`/`StructuredRef`:
quantbook-engine/crates/ql-exec/src/scalar.rs:589:            // time (`BindError::UnknownSheet`); the runtime-stale-sheet
quantbook-engine/crates/ql-exec/src/scalar.rs:605:        ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:653:        | ExprPlan::StructuredRef { .. } => PlanKind::RangeRef,
quantbook-engine/crates/ql-exec/src/scalar.rs:717:/// `ExprPlan::Array(vec![])` (`BindError::EmptyArrayLiteral`) and
quantbook-engine/crates/ql-exec/src/scalar.rs:719:/// (`BindError::ArrayRowArityMismatch`). So when we reach this code,
quantbook-engine/crates/ql-exec/src/scalar.rs:843:        // it because StructuredRef takes a different plan shape. Step
quantbook-engine/crates/ql-exec/src/scalar.rs:844:        // 1.1 closure adds the StructuredRef branch, narrowing first via
quantbook-engine/crates/ql-exec/src/scalar.rs:863:                ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/scalar.rs:1418:        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::Name));
quantbook-engine/crates/ql-exec/src/scalar.rs:1429:        assert_eq!(eval_reg(&expr, &env, &reg), Value::Error(ErrorValue::Name));
quantbook-engine/crates/ql-exec/src/transaction.rs:522:                Err(RuntimeError::Bind(crate::plan::BindError::UnresolvedName(
quantbook-engine/crates/ql-exec/src/transaction.rs:526:            "expected Bind(UnresolvedName), got {result:?}"
quantbook-engine/crates/ql-exec/src/transaction.rs:795:        use crate::plan::BindError;
quantbook-engine/crates/ql-exec/src/transaction.rs:804:            Err(RuntimeError::Bind(BindError::NamedTargetIsBlank(name))) => {
quantbook-engine/crates/ql-exec/src/transaction.rs:814:        use crate::plan::BindError;
quantbook-engine/crates/ql-exec/src/transaction.rs:826:            Err(RuntimeError::Bind(BindError::NamedTargetIsError(name, err))) => {
quantbook-engine/crates/ql-exec/src/plan.rs:80:    /// [`BindError::NamedRangeInScalarContext`] instead of binding to this
quantbook-engine/crates/ql-exec/src/plan.rs:93:    /// this (`BindError::ArrayRowArityMismatch`) on every public input AND
quantbook-engine/crates/ql-exec/src/plan.rs:123:    /// name) and `StructuredRef` (which needs a table); the only path
quantbook-engine/crates/ql-exec/src/plan.rs:146:    StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:170:pub enum BindError {
quantbook-engine/crates/ql-exec/src/plan.rs:238:    UnknownSheet(Arc<str>),
quantbook-engine/crates/ql-exec/src/plan.rs:278:    UnknownTable(std::sync::Arc<str>),
quantbook-engine/crates/ql-exec/src/plan.rs:283:    /// and `recompute_all` (W5-156) alongside `UnknownTable` — covers
quantbook-engine/crates/ql-exec/src/plan.rs:286:    UnknownTableColumn {
quantbook-engine/crates/ql-exec/src/plan.rs:306:    StructuredRefDegenerateRange(std::sync::Arc<str>),
quantbook-engine/crates/ql-exec/src/plan.rs:358:/// (aggregate-arg) or surfaces as `BindError::NamedRangeInScalarContext`
quantbook-engine/crates/ql-exec/src/plan.rs:382:    /// `SUM(A1:B3)` work — currently a `BindError::UnsupportedVariant`)
quantbook-engine/crates/ql-exec/src/plan.rs:575:/// `BindError::UnresolvedName`; any cross-sheet ref (`SheetRef::Name`)
quantbook-engine/crates/ql-exec/src/plan.rs:576:/// produces `BindError::UnknownSheet`.
quantbook-engine/crates/ql-exec/src/plan.rs:579:pub fn bind(expr: &Expr, owning_sheet: SheetId) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:585:/// `BindError::UnknownSheet`. Callers that need cross-sheet support
quantbook-engine/crates/ql-exec/src/plan.rs:592:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:613:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:631:/// surfaces `BindError::ThisRowRequiresOwningCell` in that case.
quantbook-engine/crates/ql-exec/src/plan.rs:655:/// `tables` parameter for `Expr::StructuredRef` resolution; legacy
quantbook-engine/crates/ql-exec/src/plan.rs:658:/// `BindError::UnknownTable`).
quantbook-engine/crates/ql-exec/src/plan.rs:665:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:671:/// `bind_with_site(.., &EmptyTableLookup)` — any `Expr::StructuredRef`
quantbook-engine/crates/ql-exec/src/plan.rs:672:/// surfaces `BindError::UnknownTable`.
quantbook-engine/crates/ql-exec/src/plan.rs:678:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:689:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:708:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:770:                Err(BindError::UnsupportedVariant(
quantbook-engine/crates/ql-exec/src/plan.rs:819:                return Err(BindError::EmptyArrayLiteral);
quantbook-engine/crates/ql-exec/src/plan.rs:826:                    return Err(BindError::ArrayRowArityMismatch {
quantbook-engine/crates/ql-exec/src/plan.rs:847:                            return Err(BindError::ArrayCellNotLiteral {
quantbook-engine/crates/ql-exec/src/plan.rs:861:        Expr::Spill(_) => Err(BindError::UnsupportedVariant(
quantbook-engine/crates/ql-exec/src/plan.rs:905:                    BindContext::Scalar => Err(BindError::NamedRangeInScalarContext(name.clone())),
quantbook-engine/crates/ql-exec/src/plan.rs:911:                    Err(BindError::NamedFormulaUnsupported(name.clone()))
quantbook-engine/crates/ql-exec/src/plan.rs:914:                Some(ResolvedName::Blank) => Err(BindError::NamedTargetIsBlank(name.clone())),
quantbook-engine/crates/ql-exec/src/plan.rs:916:                    Err(BindError::NamedTargetIsError(name.clone(), e))
quantbook-engine/crates/ql-exec/src/plan.rs:918:                None => Err(BindError::UnresolvedName(name.clone())),
quantbook-engine/crates/ql-exec/src/plan.rs:924:        Expr::StructuredRef { table_name, spec } => {
quantbook-engine/crates/ql-exec/src/plan.rs:935:        // fail with `BindError::R1C1RequiresAnchor` rather than
quantbook-engine/crates/ql-exec/src/plan.rs:980:        //   9. StructuredRef inner → patch `is_this_row: true` on
quantbook-engine/crates/ql-exec/src/plan.rs:986:        // Out-of-range narrow → `BindError::UnsupportedVariant` to
quantbook-engine/crates/ql-exec/src/plan.rs:1013:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1037:                return Err(BindError::EmptyArrayLiteral);
quantbook-engine/crates/ql-exec/src/plan.rs:1082:        Expr::StructuredRef { table_name, spec } => {
quantbook-engine/crates/ql-exec/src/plan.rs:1088:                ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:1093:                } => Ok(ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:1100:                // ExprPlan::StructuredRef; the wildcard arm is
quantbook-engine/crates/ql-exec/src/plan.rs:1116:        Expr::Spill(_) => Err(BindError::UnsupportedVariant(
quantbook-engine/crates/ql-exec/src/plan.rs:1131:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1135:        .ok_or(BindError::ImplicitIntersectionRequiresAnchor)?;
quantbook-engine/crates/ql-exec/src/plan.rs:1242:        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
quantbook-engine/crates/ql-exec/src/plan.rs:1274:) -> Result<u32, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1282:                return Err(BindError::R1C1OutOfBounds {
quantbook-engine/crates/ql-exec/src/plan.rs:1291:                return Err(BindError::R1C1RequiresAnchor);
quantbook-engine/crates/ql-exec/src/plan.rs:1295:                return Err(BindError::R1C1OutOfBounds {
quantbook-engine/crates/ql-exec/src/plan.rs:1312:/// surface them as distinct `BindError` variants instead of either coercing
quantbook-engine/crates/ql-exec/src/plan.rs:1350:/// returns `None`, so any NameRef becomes `BindError::UnresolvedName`.
quantbook-engine/crates/ql-exec/src/plan.rs:1370:/// entry points: any cross-sheet ref surfaces as `BindError::UnknownSheet`.
quantbook-engine/crates/ql-exec/src/plan.rs:1383:/// `Expr::StructuredRef { table_name, spec }` → `ExprPlan::StructuredRef
quantbook-engine/crates/ql-exec/src/plan.rs:1395:/// `BindError::UnknownTable(name)`.
quantbook-engine/crates/ql-exec/src/plan.rs:1408:/// against the table registry. Produces `ExprPlan::StructuredRef`
quantbook-engine/crates/ql-exec/src/plan.rs:1429:) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1433:        .ok_or_else(|| BindError::UnknownTable(Arc::clone(table_name)))?;
quantbook-engine/crates/ql-exec/src/plan.rs:1436:    let unknown_column = |col: &Arc<str>| BindError::UnknownTableColumn {
quantbook-engine/crates/ql-exec/src/plan.rs:1447:                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
quantbook-engine/crates/ql-exec/src/plan.rs:1460:                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
quantbook-engine/crates/ql-exec/src/plan.rs:1470:                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
quantbook-engine/crates/ql-exec/src/plan.rs:1473:                BindError::StructuredRefDegenerateRange(Arc::clone(&canonical_name))
quantbook-engine/crates/ql-exec/src/plan.rs:1485:    Ok(ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:1508:) -> Result<(Range, bool), BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1549:) -> Result<(ql_types::RowId, ql_types::RowId), BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1554:            .ok_or_else(|| BindError::StructuredRefDegenerateRange(Arc::clone(canonical)))?;
quantbook-engine/crates/ql-exec/src/plan.rs:1568:                .ok_or_else(|| BindError::TableHasNoHeader(Arc::clone(canonical)))?,
quantbook-engine/crates/ql-exec/src/plan.rs:1571:                .ok_or_else(|| BindError::TableHasNoTotals(Arc::clone(canonical)))?,
quantbook-engine/crates/ql-exec/src/plan.rs:1574:                .ok_or_else(|| BindError::StructuredRefDegenerateRange(Arc::clone(canonical)))?,
quantbook-engine/crates/ql-exec/src/plan.rs:1584:                    .ok_or_else(|| BindError::StructuredRefDegenerateRange(Arc::clone(canonical)))?
quantbook-engine/crates/ql-exec/src/plan.rs:1601:) -> Result<(ql_types::ColId, ql_types::ColId), BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1615:                        .ok_or_else(|| BindError::UnknownTableColumn {
quantbook-engine/crates/ql-exec/src/plan.rs:1626:                        .ok_or_else(|| BindError::UnknownTableColumn {
quantbook-engine/crates/ql-exec/src/plan.rs:1633:                        .ok_or_else(|| BindError::UnknownTableColumn {
quantbook-engine/crates/ql-exec/src/plan.rs:1666:        Expr::StructuredRef { .. } => "StructuredRef",
quantbook-engine/crates/ql-exec/src/plan.rs:1679:///   `BindError::UnknownSheet`.
quantbook-engine/crates/ql-exec/src/plan.rs:1684:) -> Result<SheetId, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1690:            .ok_or_else(|| BindError::UnknownSheet(n.clone())),
quantbook-engine/crates/ql-exec/src/plan.rs:1703:) -> Result<Range, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:1737:        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
quantbook-engine/crates/ql-exec/src/plan.rs:1966:            Err(BindError::UnsupportedVariant(_))
quantbook-engine/crates/ql-exec/src/plan.rs:2105:            BindError::UnknownSheet(name) => assert_eq!(name.as_ref(), "Nonexistent"),
quantbook-engine/crates/ql-exec/src/plan.rs:2106:            other => panic!("expected UnknownSheet, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2122:        assert!(matches!(err, BindError::UnknownSheet(_)));
quantbook-engine/crates/ql-exec/src/plan.rs:2216:            BindError::ArrayRowArityMismatch {
quantbook-engine/crates/ql-exec/src/plan.rs:2245:            BindError::ArrayCellNotLiteral { row, col, got } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2265:            BindError::ArrayCellNotLiteral { got, .. } => assert_eq!(got, "Array"),
quantbook-engine/crates/ql-exec/src/plan.rs:2276:        assert!(matches!(err, BindError::EmptyArrayLiteral));
quantbook-engine/crates/ql-exec/src/plan.rs:2287:        assert!(matches!(err, BindError::EmptyArrayLiteral));
quantbook-engine/crates/ql-exec/src/plan.rs:2301:            BindError::ArrayCellNotLiteral { row, col, got } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2322:            BindError::ArrayCellNotLiteral { row, col, got } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2369:    use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-exec/src/plan.rs:2386:        let col = |id, name: &str| TableColumn {
quantbook-engine/crates/ql-exec/src/plan.rs:2414:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2427:            ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2441:            other => panic!("expected StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2448:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2461:            BindError::UnknownTable(name) => assert_eq!(name.as_ref(), "Sales"),
quantbook-engine/crates/ql-exec/src/plan.rs:2462:            other => panic!("expected UnknownTable, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2469:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2482:            BindError::UnknownTableColumn { table, column } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2486:            other => panic!("expected UnknownTableColumn, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2493:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2506:            ExprPlan::StructuredRef { resolved, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2513:            other => panic!("expected StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2521:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2537:            ExprPlan::StructuredRef { resolved, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2543:            other => panic!("expected StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2551:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2567:            ExprPlan::StructuredRef { resolved, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2573:            other => panic!("expected StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2580:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2593:            ExprPlan::StructuredRef { resolved, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2599:            other => panic!("expected StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2606:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2619:            ExprPlan::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2631:            other => panic!("expected StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2640:        let expr = Expr::StructuredRef {
quantbook-engine/crates/ql-exec/src/plan.rs:2653:            BindError::TableHasNoHeader(name) => assert_eq!(name.as_ref(), "SALES"),
quantbook-engine/crates/ql-exec/src/plan.rs:2672:    fn bind_r1c1_at(expr: &Expr, anchor: Address) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:2682:    fn bind_r1c1_no_anchor(expr: &Expr) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:2817:        assert!(matches!(err, BindError::R1C1RequiresAnchor));
quantbook-engine/crates/ql-exec/src/plan.rs:2850:            BindError::R1C1OutOfBounds { resolved_row, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2872:            BindError::R1C1OutOfBounds { resolved_row, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:2917:    /// **Unknown sheet on R1C1 ref surfaces UnknownSheet.** Mirrors
quantbook-engine/crates/ql-exec/src/plan.rs:2928:            BindError::UnknownSheet(n) => assert_eq!(n.as_ref(), "Missing"),
quantbook-engine/crates/ql-exec/src/plan.rs:2929:            other => panic!("expected UnknownSheet, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:2957:        assert!(matches!(err, BindError::R1C1OutOfBounds { .. }));
quantbook-engine/crates/ql-exec/src/plan.rs:2974:    fn bind_at(src: &str, anchor: Address) -> Result<ExprPlan, BindError> {
quantbook-engine/crates/ql-exec/src/plan.rs:3271:        assert!(matches!(err, BindError::ImplicitIntersectionRequiresAnchor));
quantbook-engine/crates/ql-exec/src/plan.rs:3275:    /// `is_this_row: true` on the bound StructuredRef. This is the
quantbook-engine/crates/ql-exec/src/plan.rs:3295:            ExprPlan::StructuredRef { is_this_row, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:3298:            other => panic!("expected ExprPlan::StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:3329:            ExprPlan::StructuredRef { is_this_row, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:3335:            other => panic!("expected ExprPlan::StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/plan.rs:3362:            ExprPlan::StructuredRef { is_this_row, .. } => {
quantbook-engine/crates/ql-exec/src/plan.rs:3368:            other => panic!("expected ExprPlan::StructuredRef, got {other:?}"),
quantbook-engine/crates/ql-exec/src/lib.rs:9://!   `BindError` variants including `UnresolvedName`,
quantbook-engine/crates/ql-exec/src/lib.rs:77://! (`BindError`, `RuntimeError`) and `SimdShape` carry
quantbook-engine/crates/ql-exec/src/lib.rs:134:    BindError, BindSite, ExprPlan, NameLookup, ResolvedName, SheetResolver, TableLookup,
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:157:    use crate::plan::BindError;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:371:            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:374:            other => panic!("expected Bind(UnresolvedName), got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:382:    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:449:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(name))) => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2095:            RuntimeError::Bind(crate::plan::BindError::UnknownSheet(name)) => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2098:            other => panic!("expected RuntimeError::Bind(UnknownSheet), got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4436:    /// `ExprPlan::StructuredRef`, and (c) write `#NAME?` to those
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4501:            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4538:            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4543:            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4584:    /// stays in StructuredRef.bracket_content; outside-bracket `@`
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4586:    /// canonicalize to ExprPlan::StructuredRef with
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4590:        use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4602:            columns: vec![TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:13://!   surface a dropped-table BindError on next recompute of any
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:175:        use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:176:        let columns: Vec<TableColumn> = column_names
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:178:            .map(|cn| TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:205:    /// dropped table re-bind to `BindError::UnknownTable` on next
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:212:    /// with cached `ExprPlan::StructuredRef` plans would continue
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:217:    /// 3. Next recompute re-binds → `BindError::UnknownTable` →
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:246:        // (`ExprPlan::StructuredRef { resolved: <pre-drop range> }`)
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:250:        // BindError::UnknownTable → emit #NAME?"). Matches the
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:334:                continue; // no StructuredRef references the renamed table
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:381:    /// rewrites stored formula text in every cell whose StructuredRef
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:394:    /// 4. Mutate the matching `TableColumn` entry's lowercase canonical
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:418:            return Err(RuntimeError::TableColumnNotFound {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:425:            return Err(RuntimeError::TableColumnRejected {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:441:            return Err(RuntimeError::TableColumnRejected {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:582:        use ql_storage::TableColumn;
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:749:            meta.columns.push(TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:882:    /// - 4.8.B: lexer Token::StructuredRef.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:883:    /// - 4.8.C: parser Expr::StructuredRef + Combination/BareColumn.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:885:    /// - 4.8.F: TableLookup blanket impl + ExprPlan::StructuredRef
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:887:    /// - 4.8.G: eval-side StructuredRef arm in scalar.rs aggregate path.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:890:        use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:893:        let col = |id, name: &str| TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:936:        use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:949:                TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:955:                TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:989:        use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1001:            columns: vec![TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1248:            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1450:            RuntimeError::TableColumnRejected { reason, .. } => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1453:            other => panic!("expected TableColumnRejected, got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1466:            RuntimeError::TableColumnNotFound { table, column } => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1470:            other => panic!("expected TableColumnNotFound, got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1495:            RuntimeError::TableColumnRejected { reason, .. } => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1498:            other => panic!("expected TableColumnRejected, got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1827:    /// (re-bind fails with UnknownTableColumn → mark_dirty), and
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1830:    /// `UnknownTableColumn` in addition to `UnknownTable`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1865:                "UnknownTableColumn must map to #NAME?, not RecomputeFailure — got: {:?}",
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1871:            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2111:    /// works for StructuredRef single-arg (not just SUM).
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2114:        use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2126:            columns: vec![TableColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:102:            .map_err(RuntimeError::SheetName)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:33:use crate::plan::{bind_with_site, BindError, BindSite};
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:181:                    // `BindError::UnknownSheet` to `#NAME?`. Surfaces
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:192:                        BindError::UnknownTable(_)
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:193:                        | BindError::UnknownTableColumn { .. }
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:194:                        | BindError::UnknownSheet(_),
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:201:                            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:581:                        // BindError::UnknownTable → emit #NAME?") and
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:582:                        // the `plan.rs:260` UnknownTable docstring.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:595:                        // map `BindError::UnknownSheet` here. Mirror of
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:600:                            BindError::UnknownTable(_)
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:601:                            | BindError::UnknownTableColumn { .. }
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:602:                            | BindError::UnknownSheet(_),
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:605:                            let v = Value::Error(ErrorValue::Name);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:865:    use crate::plan::BindError;
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1296:        wb.put_formula(0, 0, 2, "UnknownName + 1"); // bind error (UnresolvedName)
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1611:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1619:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1627:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1651:            Err(RuntimeError::Bind(BindError::NamedFormulaUnsupported(n))) => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3199:    // BindError::UnknownSheet → #NAME? mapping in recompute_all +
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3251:            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3302:            Value::Error(ErrorValue::Name),
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:21:use crate::plan::BindError;
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:32:    // Display now that LexError + BindError implement thiserror::Error with
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:54:    Bind(BindError),
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:167:    TableColumnNotFound { table: String, column: String },
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:174:    TableColumnRejected {
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:195:impl From<BindError> for RuntimeError {
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:196:    fn from(e: BindError) -> Self {

exec
/bin/zsh -lc "find quantbook-engine -maxdepth 2 -name Cargo.toml -print -exec sed -n '1,80p' {} \\;" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/Cargo.toml
# Quantbook Engine — Cargo workspace
# Phase 0 viability spike. See ../.plans/_QUANTBOOK-v1-SPECIFICATION.md Part V.
#
# IMPORTANT: per Cargo's rules (https://doc.rust-lang.org/cargo/reference/workspaces.html),
# [workspace.dependencies] entries CANNOT carry `optional = true`. Optionality lives on the
# consuming crate's Cargo.toml. There is no `[workspace.features]` table — features belong on
# member crates. This file is the result of codex r9 audit corrections.

[workspace]
resolver = "2"
members = ["crates/*"]
# Phase 0 active set (other crates are stubs reserving the workspace tree):
default-members = [
    "crates/ql-types",
    "crates/ql-storage",
    "crates/ql-formula-syntax",
    "crates/ql-formula-semantics",
    "crates/ql-functions",
    "crates/ql-calcgraph",
    "crates/ql-exec",
    "crates/ql-bench",
    "crates/ql-profile",
    "crates/ql-oplog",
    "crates/ql-terminal",
]

[workspace.package]
version = "0.1.0"
edition = "2021"
# MSRV floor 1.85: required for edition2024 (clap_lex 1.1.0 transitively via criterion). Day 2
# bump from 1.83. Build is pinned to 1.95.0 in rust-toolchain.toml.
rust-version = "1.85"
license = "MIT OR Apache-2.0"
publish = false

[workspace.dependencies]
# Apache Arrow — exact pins for Phase 0. All 7 crates kept in lock-step at the same patch
# (58.3.0 is the latest 58.x patch as of 2026-05-11; arrow-array 58.1.0's `^58` transitive
# would otherwise drift arrow-buffer to 58.3 and break the pin guard).
arrow = "=58.3.0"
arrow-array = "=58.3.0"
arrow-buffer = "=58.3.0"
arrow-schema = "=58.3.0"
arrow-select = "=58.3.0"
arrow-arith = "=58.3.0"
arrow-cast = "=58.3.0"

# Concurrency
rayon = "=1.12.0"
tokio = { version = "=1.50.0", default-features = false, features = ["rt-multi-thread", "macros", "fs", "net", "time", "sync"] }

# Bench
criterion = { version = "=0.8.2", default-features = false, features = ["html_reports"] }
# Property-based testing for invariant checks (ql-storage, ql-calcgraph, ql-exec dev-deps)
proptest = "=1.8.0"

# SIMD (runtime dispatch per Phase 0 Decision F).
# pulp's default features include `x86-v3` (= AVX2 baseline at compile time), which would
# defeat A3 by baking AVX2 into distributable binaries. We disable defaults and opt back in
# to `std` only; runtime dispatch comes from pulp's per-function `Arch::detect()` and
# `multiversion`. Do NOT add `x86-v3`/`x86-v4` to features here.
pulp = { version = "=0.22.2", default-features = false, features = ["std"] }
multiversion = "=0.8.0"
bytemuck = "=1.25.0"

# Python interop (Phase 5; reserved in workspace pins for consistency)
pyo3 = { version = "=0.28.3", default-features = false, features = ["extension-module", "abi3-py310"] }

# WASM (later phases). Pinned to 0.2.121 (latest 2026-05-11; the older 0.2.118 drifted via
# transitive resolution after toolchain bump 1.83→1.95 — see scripts/check-cargo-lock-pins.sh).
wasm-bindgen = "=0.2.121"

# Storage / formats (later phases)
polars = { version = "=0.53.0", default-features = false, features = ["lazy", "fmt", "parquet"] }
datafusion = { version = "=53.1.0", default-features = false }
duckdb = { version = "=1.10502.0", default-features = false, features = ["bundled", "appender-arrow"] }
calamine = "=0.34.0"

# Reactive (salsa = experiments only per Decision A) / collab
salsa = "=0.26.2"

exec
/bin/zsh -lc "rg -n \"case.*rename|rename.*case|same canonical|same-canonical|SHEET|Quantity|rename_table\\(|rename_column\\(\" quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-oplog/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:514:            //      silently dropped case-only renames (e.g. "Sheet1" →
quantbook-engine/crates/ql-oplog/src/replay.rs:515:            //      "SHEET1"). Storage permits case-only renames and
quantbook-engine/crates/ql-oplog/src/replay.rs:519:            //      - pre-step-2 case 2 (current == old_name; fresh rename).
quantbook-engine/crates/ql-oplog/src/replay.rs:525:            //      - case-only rename (canonical equal, display differs).
quantbook-engine/crates/ql-oplog/src/replay.rs:693:            apply_rename_table(workbook, index, old_name, new_name)
quantbook-engine/crates/ql-oplog/src/replay.rs:699:        } => apply_rename_column(workbook, index, table, old_name, new_name),
quantbook-engine/crates/ql-oplog/src/replay.rs:776:fn apply_rename_table(
quantbook-engine/crates/ql-oplog/src/replay.rs:816:        // (case b) accepts losing the rename intent rather than
quantbook-engine/crates/ql-oplog/src/replay.rs:843:    // No-op same-canonical case.
quantbook-engine/crates/ql-oplog/src/replay.rs:882:fn apply_rename_column(
quantbook-engine/crates/ql-oplog/src/replay.rs:931:            reason: "rename to same canonical column name (producer should not emit)",
quantbook-engine/crates/ql-oplog/src/replay.rs:1796:    /// Post-step-2 that case applies the rename to the current
quantbook-engine/crates/ql-oplog/src/replay.rs:2055:            name: "SHEET1".to_owned(),
quantbook-engine/crates/ql-oplog/src/replay.rs:2066:        // Second sheet auto-renamed (original was "SHEET1" which is
quantbook-engine/crates/ql-oplog/src/replay.rs:2068:        assert_eq!(wb.sheet(1).unwrap().name(), "SHEET1(2)");
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:265:    ///    NameTable shared namespace); not a no-op (same canonical name).
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:280:    pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:286:        // No-op rename (same canonical) — accept silently without
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:403:    pub fn rename_column(
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:431:        // No-op rename (same lowercase canonical) — accept silently
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:433:        // case rename is deferred to a future sub-phase.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:604:        // short-circuit. Mirrors `rename_column`'s same-canonical
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1112:            rt.rename_table("Sales", "Orders").unwrap()
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1146:        let err = rt.rename_table("A", "B").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1160:        let err = rt.rename_table("Nope", "Yep").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1177:            let _ = rt.rename_table("S", "T").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1218:            let rewritten = rt.rename_table("Sales", "Orders").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1274:            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1279:        let (idx, col) = meta.lookup_column("Quantity").expect("new column present");
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1282:        assert_eq!(col.display.as_ref(), "Quantity");
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1290:            text.contains("Quantity"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1291:            "formula text should reference Quantity, got: {text}"
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1337:            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1341:        assert!(text.contains("Quantity"), "got: {text}");
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1377:            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1381:        assert!(text.contains("Quantity"), "got: {text}");
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1415:            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1420:        assert!(sales_text.contains("Quantity"), "got: {sales_text}");
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1424:        assert!(!orders_text.contains("Quantity"), "got: {orders_text}");
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1428:        assert!(orders.lookup_column("Quantity").is_none());
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1448:        let err = rt.rename_column("Sales", "Qty", "Price").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1464:        let err = rt.rename_column("Sales", "Nope", "Whatever").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1479:        let err = rt.rename_column("Nope", "A", "B").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1493:        let err = rt.rename_column("Sales", "Qty", "").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1504:        // Display-only case rename (e.g. "Qty" → "QTY") shares the
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1514:            let n = rt.rename_column("Sales", "Qty", "QTY").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1533:            let n = rt.rename_column("S", "Q", "R").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1582:            let rewritten = rt.rename_column("Sales", "Qty", "Quantity").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2056:    /// same-canonical no-op contract — caller-visible behavior is
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:13://! Post-step-2: case 3 applies the rename to whatever the sheet
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:497:/// **Step 2 audit closure (Codex MEDIUM-1):** case-only renames
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:498:/// (e.g., "Sheet1" → "SHEET1") must update the display name even
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:503:fn step2_audit_case_only_rename_updates_display_name() {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:513:        new_name: "SHEET1".to_owned(),
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:520:        "SHEET1",
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:521:        "case-only rename must update display name (Codex MEDIUM-1 closure); \

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs | sed -n '1488,1524p;2048,2078p' && nl -ba quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs | sed -n '490,530p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1488	        let mut wb = make_runtime_workbook();
  1489	        let reg = default_registry();
  1490	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
  1491	        rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
  1492	            .unwrap();
  1493	        let err = rt.rename_column("Sales", "Qty", "").unwrap_err();
  1494	        match err {
  1495	            RuntimeError::TableColumnRejected { reason, .. } => {
  1496	                assert!(reason.contains("cannot be empty"), "reason: {reason}");
  1497	            }
  1498	            other => panic!("expected TableColumnRejected, got {other:?}"),
  1499	        }
  1500	    }
  1501	
  1502	    #[test]
  1503	    fn rename_column_same_canonical_is_noop() {
  1504	        // Display-only case rename (e.g. "Qty" → "QTY") shares the
  1505	        // lowercase canonical, so the runtime accepts silently with
  1506	        // Ok(0) and emits no op. Mirrors `rename_table` policy.
  1507	        let mut wb = make_runtime_workbook();
  1508	        let reg = default_registry();
  1509	        let mut oplog = OpLog::new();
  1510	        {
  1511	            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
  1512	            rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
  1513	                .unwrap();
  1514	            let n = rt.rename_column("Sales", "Qty", "QTY").unwrap();
  1515	            assert_eq!(n, 0);
  1516	        }
  1517	        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
  1518	        // Only the CreateTable op landed; no RenameColumn op emitted.
  1519	        assert_eq!(ops.len(), 1, "got {ops:?}");
  1520	        assert!(matches!(&ops[0], Op::CreateTable { .. }));
  1521	    }
  1522	
  1523	    #[test]
  1524	    fn rename_column_emits_ops() {
  2048	                && added_columns == &vec!["Price".to_owned()]
  2049	                && removed_columns.is_empty()
  2050	        ));
  2051	    }
  2052	
  2053	    /// **W5-127 (Phase 4.8.O.3 — Codex LOW-1):** exact no-op resize
  2054	    /// (same dims, no column changes) returns `Ok(())` without
  2055	    /// emitting an `Op::ResizeTable`. Mirrors `rename_column`'s
  2056	    /// same-canonical no-op contract — caller-visible behavior is
  2057	    /// unchanged but the op log stays compact.
  2058	    #[test]
  2059	    fn resize_table_exact_noop_emits_nothing() {
  2060	        let mut wb = make_runtime_workbook();
  2061	        let reg = default_registry();
  2062	        let mut oplog = OpLog::new();
  2063	        {
  2064	            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
  2065	            rt.create_table(
  2066	                "Sales",
  2067	                0,
  2068	                0,
  2069	                0,
  2070	                3,
  2071	                2,
  2072	                true,
  2073	                false,
  2074	                vec!["Qty".into(), "Price".into()],
  2075	            )
  2076	            .unwrap();
  2077	            // Exact no-op: same dims, empty added + removed.
  2078	            rt.resize_table("Sales", 3, 2, vec![], vec![])
   490	    assert_eq!(
   491	        sorted,
   492	        vec!["X".to_string(), "X(2)".to_string()],
   493	        "auto-disambiguation: {{X, X(2)}} present; got {names_a:?}"
   494	    );
   495	}
   496	
   497	/// **Step 2 audit closure (Codex MEDIUM-1):** case-only renames
   498	/// (e.g., "Sheet1" → "SHEET1") must update the display name even
   499	/// though canonical equality holds. Pre-closure the idempotency
   500	/// check used canonical comparison and silently dropped case-only
   501	/// renames; storage layer does accept them.
   502	#[test]
   503	fn step2_audit_case_only_rename_updates_display_name() {
   504	    let mut log = OpLog::new();
   505	    log.append(Op::AddSheet {
   506	        name: "Sheet1".to_owned(),
   507	        chunk_rows: 16384,
   508	    })
   509	    .unwrap();
   510	    log.append(Op::RenameSheet {
   511	        id: 0,
   512	        old_name: "Sheet1".to_owned(),
   513	        new_name: "SHEET1".to_owned(),
   514	    })
   515	    .unwrap();
   516	
   517	    let wb = replay_into_fresh(&log);
   518	    assert_eq!(
   519	        wb.sheet(0).unwrap().name(),
   520	        "SHEET1",
   521	        "case-only rename must update display name (Codex MEDIUM-1 closure); \
   522	         pre-closure replay no-op'd because canonical equality, leaving 'Sheet1'"
   523	    );
   524	}

exec
/bin/zsh -lc 'rg -n "rename_table.*same|same.*rename_table|case.*table|display-only" quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 exited 1 in 0ms:
codex
Several V1 limitations already have direct tests; the gaps are DropTable×RenameTable, table case-only display behavior, and a concrete column-formula post-merge value. I’m going to add a temporary probe test file, run it, then remove it so the audit leaves the worktree unchanged.
exec
/bin/zsh -lc 'cargo test -p ql-oplog --test phase_5_3_step4_table_column_concurrent step4_audit_cross_table_target_collision_hard_fails -- --test-threads=1 && cargo test -p ql-oplog --test phase_5_3_step4_table_column_concurrent step4_audit_cross_column_target_collision_hard_fails -- --test-threads=1 && cargo test -p ql-oplog --test phase_5_3_step2_rename_concurrent step2_audit_case_only_rename_updates_display_name -- --test-threads=1 && cargo test -p ql-exec --test phase_5_3_conflict_matrix_probe row8_droptable_concurrent_edit_yields_name_error -- --test-threads=1 && cargo test -p ql-exec workbook_runtime::tables::tests::rename_column_same_canonical_is_noop -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 513372ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.11s
     Running tests/phase_5_3_step4_table_column_concurrent.rs (target/debug/deps/phase_5_3_step4_table_column_concurrent-a91584adb631f991)

running 1 test
test step4_audit_cross_table_target_collision_hard_fails ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.02s

    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.06s
     Running tests/phase_5_3_step4_table_column_concurrent.rs (target/debug/deps/phase_5_3_step4_table_column_concurrent-a91584adb631f991)

running 1 test
test step4_audit_cross_column_target_collision_hard_fails ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.00s

   Compiling ql-oplog v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 12.31s
     Running tests/phase_5_3_step2_rename_concurrent.rs (target/debug/deps/phase_5_3_step2_rename_concurrent-7342d3e8b96b0506)

running 1 test
test step2_audit_case_only_rename_updates_display_name ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out; finished in 0.00s

   Compiling ql-oplog v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog)
   Compiling ql-io v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io)
   Compiling ql-collab v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab)
   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 32.70s
     Running tests/phase_5_3_conflict_matrix_probe.rs (target/debug/deps/phase_5_3_conflict_matrix_probe-a7d4507d25a58877)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.00s

   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 18.37s
     Running unittests src/lib.rs (target/debug/deps/ql_exec-77a7c0ccf0b4a340)

running 1 test
test workbook_runtime::tables::tests::rename_column_same_canonical_is_noop ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 635 filtered out; finished in 0.00s

     Running tests/distribution_fns_e2e.rs (target/debug/deps/distribution_fns_e2e-978034af0ab2744e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 111 filtered out; finished in 0.00s

     Running tests/error_precedence.rs (target/debug/deps/error_precedence-16b74909cce5d5d6)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out; finished in 0.00s

     Running tests/ide_simulation.rs (target/debug/deps/ide_simulation-e8f76697287a81cc)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.00s

     Running tests/oplog_e2e.rs (target/debug/deps/oplog_e2e-a6d9eee78ceaab44)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out; finished in 0.00s

     Running tests/opus_a_phase_4_12_cross_features.rs (target/debug/deps/opus_a_phase_4_12_cross_features-9c0b5954fe0f940d)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 35 filtered out; finished in 0.00s

     Running tests/p412_function_arg_fuzz.rs (target/debug/deps/p412_function_arg_fuzz-5745bb960651be88)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out; finished in 0.00s

     Running tests/phase_5_2_d4_spill_2peer_probe.rs (target/debug/deps/phase_5_2_d4_spill_2peer_probe-2001fad6b359f662)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.00s

     Running tests/phase_5_3_conflict_matrix_probe.rs (target/debug/deps/phase_5_3_conflict_matrix_probe-a7d4507d25a58877)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 0.00s

     Running tests/reference_fns_coverage_extensions.rs (target/debug/deps/reference_fns_coverage_extensions-fd620457eab55647)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 14 filtered out; finished in 0.00s

     Running tests/reference_fns_e2e.rs (target/debug/deps/reference_fns_e2e-510c39c4c11f3796)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 32 filtered out; finished in 0.00s

     Running tests/reference_fns_step3_e2e.rs (target/debug/deps/reference_fns_step3_e2e-44f7b6b861163ff6)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 29 filtered out; finished in 0.00s

     Running tests/reference_fns_step4_e2e.rs (target/debug/deps/reference_fns_step4_e2e-52c4d057d1903f61)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 17 filtered out; finished in 0.00s

     Running tests/reference_fns_step5_cross_cutting.rs (target/debug/deps/reference_fns_step5_cross_cutting-cde4d558deb1b6e5)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out; finished in 0.00s

     Running tests/reference_tier_dispatcher_smoke.rs (target/debug/deps/reference_tier_dispatcher_smoke-0f53850705baf65e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 13 filtered out; finished in 0.00s

     Running tests/region_mul2_e2e.rs (target/debug/deps/region_mul2_e2e-9d4987213cc5dd41)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 69 filtered out; finished in 0.00s


exec
/bin/zsh -lc 'rg -n "fn row8|row8_|DropTable" quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
32://! - Row 8: DropTable × concurrent edit referencing T — pinned here
72:/// covering A1:B3 with header row. Used by the DropTable conflict
628:// ===== Row 8: DropTable × concurrent edit referencing T =====
638:/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).
642:/// the original test claimed "DropTable wins deterministically"
643:/// — imprecise. The correct statement: BOTH ops apply (DropTable
649:fn row8_droptable_vs_concurrent_table_ref_yields_name_error() {
654:        Op::DropTable {
670:    // T is dropped (DropTable always applies — there's no

exec
/bin/zsh -lc 'cargo test -p ql-exec --test phase_5_3_conflict_matrix_probe row8_droptable_vs_concurrent_table_ref_yields_name_error -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 387ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.12s
     Running tests/phase_5_3_conflict_matrix_probe.rs (target/debug/deps/phase_5_3_conflict_matrix_probe-a7d4507d25a58877)

running 1 test
test row8_droptable_vs_concurrent_table_ref_yields_name_error ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 8 filtered out; finished in 0.01s


apply patch
patch: completed
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..472da960a4624d152dcf80307349c5b10f75e1d8
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,168 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a.append(Op::DropTable { name: "T".into() }).unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    assert!(
+        replay_result(&peer_a).is_err(),
+        "DropTable + concurrent RenameTable should hit the documented V1 hard-fail"
+    );
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(str::to_owned),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..472da960a4624d152dcf80307349c5b10f75e1d8
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,168 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a.append(Op::DropTable { name: "T".into() }).unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    assert!(
+        replay_result(&peer_a).is_err(),
+        "DropTable + concurrent RenameTable should hit the documented V1 hard-fail"
+    );
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(str::to_owned),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

exec
/bin/zsh -lc 'cargo test -p ql-exec --test codex_phase_5_3_step5_temp_probes -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..472da960a4624d152dcf80307349c5b10f75e1d8
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,168 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a.append(Op::DropTable { name: "T".into() }).unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    assert!(
+        replay_result(&peer_a).is_err(),
+        "DropTable + concurrent RenameTable should hit the documented V1 hard-fail"
+    );
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(str::to_owned),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

 exited 101 in 5839ms:
   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
error[E0631]: type mismatch in function arguments
   --> crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs:103:36
    |
103 |         wb.formula_at(0, 5, 0).map(str::to_owned),
    |                                --- ^^^^^^^^^^^^^
    |                                |   |
    |                                |   expected due to this
    |                                |   found signature defined here
    |                                required by a bound introduced by this call
    |
    = note: expected function signature `fn(&Arc<str>) -> _`
               found function signature `fn(&str) -> _`
note: required by a bound in `Option::<T>::map`
   --> /rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/option.rs:1160:4
help: consider wrapping the function in a closure
    |
103 |         wb.formula_at(0, 5, 0).map(|arg0: &Arc<str>| str::to_owned(/* &str */)),
    |                                    +++++++++++++++++              ++++++++++++

For more information about this error, try `rustc --explain E0631`.
error: could not compile `ql-exec` (test "codex_phase_5_3_step5_temp_probes") due to 1 previous error

apply patch
patch: completed
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..4204d258bc6d9556d348d6603b9fc62a57da8384
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,168 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a.append(Op::DropTable { name: "T".into() }).unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    assert!(
+        replay_result(&peer_a).is_err(),
+        "DropTable + concurrent RenameTable should hit the documented V1 hard-fail"
+    );
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..4204d258bc6d9556d348d6603b9fc62a57da8384
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,168 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a.append(Op::DropTable { name: "T".into() }).unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    assert!(
+        replay_result(&peer_a).is_err(),
+        "DropTable + concurrent RenameTable should hit the documented V1 hard-fail"
+    );
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

exec
/bin/zsh -lc 'cargo test -p ql-exec --test codex_phase_5_3_step5_temp_probes -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..4204d258bc6d9556d348d6603b9fc62a57da8384
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,168 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a.append(Op::DropTable { name: "T".into() }).unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    assert!(
+        replay_result(&peer_a).is_err(),
+        "DropTable + concurrent RenameTable should hit the documented V1 hard-fail"
+    );
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

 exited 101 in 26449ms:
   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 5.62s
     Running tests/codex_phase_5_3_step5_temp_probes.rs (target/debug/deps/codex_phase_5_3_step5_temp_probes-d67de54502226bae)

running 3 tests
test codex_probe_case_only_policy_sheet_table_column ... ok
test codex_probe_column_rename_formula_without_repair_yields_name_error ... ok
test codex_probe_drop_table_concurrent_rename_table_hard_fails ... FAILED

failures:

---- codex_probe_drop_table_concurrent_rename_table_hard_fails stdout ----

thread 'codex_probe_drop_table_concurrent_rename_table_hard_fails' (99531286) panicked at crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs:73:5:
DropTable + concurrent RenameTable should hit the documented V1 hard-fail
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    codex_probe_drop_table_concurrent_rename_table_hard_fails

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

error: test failed, to rerun pass `-p ql-exec --test codex_phase_5_3_step5_temp_probes`

codex
The temporary probes confirmed table/column target collisions, column-repair absence, and case-only behavior, but the DropTable×RenameTable probe did not match the documented “hard-fail” in one deterministic peer ordering. I’m checking the opposite peer-id/causal ordering before classifying it.
apply patch
patch: completed
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..dec6119b126fdd395c66a0f87ea9e270fd521993
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,190 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+
+    let mut drop_then_rename_a = fork_with_peer(&base, PEER_A_ID);
+    drop_then_rename_a
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    let mut drop_then_rename_b = fork_with_peer(&base, PEER_B_ID);
+    drop_then_rename_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    drop_then_rename_a
+        .merge_bytes(&drop_then_rename_b.export_bytes().unwrap())
+        .unwrap();
+
+    let drop_then_rename = replay_result(&drop_then_rename_a);
+    eprintln!("drop(id=1)+rename(id=2): {drop_then_rename:?}");
+
+    let mut rename_then_drop_a = fork_with_peer(&base, PEER_A_ID);
+    rename_then_drop_a
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    let mut rename_then_drop_b = fork_with_peer(&base, PEER_B_ID);
+    rename_then_drop_b
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    rename_then_drop_a
+        .merge_bytes(&rename_then_drop_b.export_bytes().unwrap())
+        .unwrap();
+    let rename_then_drop = replay_result(&rename_then_drop_a);
+    eprintln!("rename(id=1)+drop(id=2): {rename_then_drop:?}");
+
+    assert!(drop_then_rename.is_err() || rename_then_drop.is_err());
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..dec6119b126fdd395c66a0f87ea9e270fd521993
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,190 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+
+    let mut drop_then_rename_a = fork_with_peer(&base, PEER_A_ID);
+    drop_then_rename_a
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    let mut drop_then_rename_b = fork_with_peer(&base, PEER_B_ID);
+    drop_then_rename_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    drop_then_rename_a
+        .merge_bytes(&drop_then_rename_b.export_bytes().unwrap())
+        .unwrap();
+
+    let drop_then_rename = replay_result(&drop_then_rename_a);
+    eprintln!("drop(id=1)+rename(id=2): {drop_then_rename:?}");
+
+    let mut rename_then_drop_a = fork_with_peer(&base, PEER_A_ID);
+    rename_then_drop_a
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    let mut rename_then_drop_b = fork_with_peer(&base, PEER_B_ID);
+    rename_then_drop_b
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    rename_then_drop_a
+        .merge_bytes(&rename_then_drop_b.export_bytes().unwrap())
+        .unwrap();
+    let rename_then_drop = replay_result(&rename_then_drop_a);
+    eprintln!("rename(id=1)+drop(id=2): {rename_then_drop:?}");
+
+    assert!(drop_then_rename.is_err() || rename_then_drop.is_err());
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

exec
/bin/zsh -lc 'cargo test -p ql-exec --test codex_phase_5_3_step5_temp_probes codex_probe_drop_table_concurrent_rename_table_hard_fails -- --test-threads=1 --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..dec6119b126fdd395c66a0f87ea9e270fd521993
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,190 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+
+    let mut drop_then_rename_a = fork_with_peer(&base, PEER_A_ID);
+    drop_then_rename_a
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    let mut drop_then_rename_b = fork_with_peer(&base, PEER_B_ID);
+    drop_then_rename_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    drop_then_rename_a
+        .merge_bytes(&drop_then_rename_b.export_bytes().unwrap())
+        .unwrap();
+
+    let drop_then_rename = replay_result(&drop_then_rename_a);
+    eprintln!("drop(id=1)+rename(id=2): {drop_then_rename:?}");
+
+    let mut rename_then_drop_a = fork_with_peer(&base, PEER_A_ID);
+    rename_then_drop_a
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    let mut rename_then_drop_b = fork_with_peer(&base, PEER_B_ID);
+    rename_then_drop_b
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    rename_then_drop_a
+        .merge_bytes(&rename_then_drop_b.export_bytes().unwrap())
+        .unwrap();
+    let rename_then_drop = replay_result(&rename_then_drop_a);
+    eprintln!("rename(id=1)+drop(id=2): {rename_then_drop:?}");
+
+    assert!(drop_then_rename.is_err() || rename_then_drop.is_err());
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

 succeeded in 26416ms:
   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 5.76s
     Running tests/codex_phase_5_3_step5_temp_probes.rs (target/debug/deps/codex_phase_5_3_step5_temp_probes-d67de54502226bae)

running 1 test
test codex_probe_drop_table_concurrent_rename_table_hard_fails ... drop(id=1)+rename(id=2): Ok(Workbook { sheets: [Sheet { name: "S", columns: [ColumnStore { chunk_rows: 16384, base_chunks: [PrimitiveArray<Float64>
[
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  ...16364 elements...,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
]], user_overlays: [SparseOverlay { entries: {1: Number(10.0), 2: Number(20.0)} }], computed_overlays: [SparseOverlay { entries: {} }] }], bounds: Bounds { row_extent: 3, col_extent: 1 }, chunk_rows: 16384, format_overlay: CellFormatOverlay { entries: {} }, scoped_names: NameTable { entries: {}, generation: 0 } }], names: NameTable { entries: {}, generation: 0 }, formula_cells: {}, date_system: Excel1900, formats: FormatTable { by_id: {Builtin(11): "0.00E+00", Builtin(9): "0%", Builtin(14): "m/d/yyyy", Builtin(49): "@", Builtin(0): "General", Builtin(4): "#,##0.00", Builtin(22): "m/d/yyyy h:mm", Builtin(37): "#,##0 ;(#,##0)", Builtin(15): "d-mmm-yy", Builtin(19): "h:mm:ss AM/PM", Builtin(45): "mm:ss", Builtin(2): "0.00", Builtin(10): "0.00%", Builtin(1): "0", Builtin(16): "d-mmm", Builtin(17): "mmm-yy", Builtin(3): "#,##0", Builtin(18): "h:mm AM/PM", Builtin(21): "h:mm:ss", Builtin(20): "h:mm"}, by_builtin_string: {"@": Builtin(49), "mmm-yy": Builtin(17), "0%": Builtin(9), "d-mmm": Builtin(16), "mm:ss": Builtin(45), "h:mm": Builtin(20), "m/d/yyyy h:mm": Builtin(22), "0": Builtin(1), "m/d/yyyy": Builtin(14), "#,##0": Builtin(3), "h:mm AM/PM": Builtin(18), "0.00E+00": Builtin(11), "#,##0 ;(#,##0)": Builtin(37), "0.00": Builtin(2), "h:mm:ss AM/PM": Builtin(19), "h:mm:ss": Builtin(21), "General": Builtin(0), "0.00%": Builtin(10), "d-mmm-yy": Builtin(15), "#,##0.00": Builtin(4)}, by_custom_string: {}, next_custom_counter: 0, local_peer: PeerId(0) }, spill_anchors: SpillAnchorTable { anchors: {}, targets: {} }, tables: TableTable { tables: {}, generation: 2, next_column_id: 2 }, reference_mode: A1, locale: EnUs })
rename(id=1)+drop(id=2): Err(TableNotFound { index: 5, name: "T" })
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.01s


exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md | sed -n '38,70p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/.plans/_active.md | sed -n '112,132p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    38	## Deferred (documented limitations)
    39	
    40	| Item | Source | Defer reason | Tracking |
    41	|---|---|---|---|
    42	| Cross-source target collision (tables + columns) hard-fails | HIGH closure | Auto-disambig + repair interaction requires API change | V1 limitation, V2 backlog |
    43	| Column repair pass | HIGH-2 | Same root cause as HIGH-1 + scope | Future step 4.1 OR V2 |
    44	| DropTable hard-fails on concurrent rename | Opus M-1 | Same bug class as table rename; out of step 4 scope | Step 5 megaudit or V2 |
    45	| Inconsistent case-only rename policy across sheet/table/column | Opus M-3 | Architectural design decision | Step 5 megaudit |
    46	| Codex MEDIUM-3 (NameTable hard-reject in suffix walk) | Codex M-3 | N/A — auto-disambig reverted | (Mooted) |
    47	| `lookup_column` doc says uppercase but code lowercases | Opus L-3 | Pre-existing doc bug | Future cleanup |
    48	
    49	## Code changes summary
    50	
    51	**`crates/ql-oplog/src/replay.rs`**:
    52	- `apply_rename_table`: removed auto-disambig suffix walk; restored hard-reject on `TableCreateRejected` for cross-source target collision. Preserved advisory-skip for missing-source (the original Opus step 1 audit M-2 closure). Updated docstring to document V1 limitation.
    53	- `apply_rename_column`: same revert + preservation pattern.
    54	
    55	**`crates/ql-collab/src/repair.rs`**:
    56	- `collect_table_renames`: removed dead `canonical_chain` HashMap. Signature simplified.
    57	- `repair_table_rename_chain`: sort current canonicals before iteration for determinism.
    58	
    59	**Tests updated**:
    60	- `phase_5_3_step4_table_column_concurrent.rs`: 2 tests reframed to assert HARD-FAIL on cross-source collision (post-revert behavior). 
    61	- `repair_tables.rs`: 1 test reframed (cross-table → hard-fail) + 2 new tests added (transitive chain + BatchCommit).
    62	
    63	## Closure metrics
    64	
    65	- Step 4 ship: 12 tests (6 replay + 6 repair).
    66	- After audit closure: 14 tests (6 replay + 8 repair: 2 new + 1 reframed).
    67	- Workspace tests: 4332 → 4334 (+2 net).
    68	- Files modified: 4 (replay.rs, repair.rs, 2 test files).
    69	- fmt + clippy: clean.
    70	

 succeeded in 0ms:
   112	- Post-closure: REVERTED auto-disambig. Cross-source target collision now hard-fails with `TableCreateRejected` / `TableColumnRejected`. V1 limitation documented.
   113	- Preserved: advisory-skip for missing-source (the original Opus step-1-audit M-2 closure).
   114	
   115	**V1 limitations stack from step 4 audit closure** (deferred to V2 / step 5 megaudit assessment):
   116	- Cross-source target collision hard-fails (tables, columns)
   117	- Column repair pass missing
   118	- DropTable hard-fails on concurrent RenameTable (Opus M-1)
   119	- Case-only rename policy inconsistency across sheet/table/column (Opus M-3)
   120	- Helper duplication (5+ call sites; Opus step-3 M-1 deferred from step 3 audit)
   121	- Production wiring missing (Opus step-3 M-3)
   122	
   123	### Step 5 — 3-way megaudit (~0.5 day) ⏳ NEXT
   124	Codex (cross-step + grep) + Opus-A (empirical 2-peer + adversarial randomized interleavings + production wiring check) + Opus-B (doc completeness + helper duplication + cross-crate consistency).
   125	
   126	**Megaudit MUST re-examine the V1 limitations stack** from step 4 audit closure (above) for V2 prioritization. Specifically:
   127	- Is the cross-source target collision hard-fail acceptable as V1? Or should V2 thread a disambig-trace through replay→repair?
   128	- Should column repair pass land in V1, or is the gap acceptable?
   129	- Audit-prompt the auditors to construct ADVERSARIAL probes attempting to break the safety guard via odd scenarios (e.g., 3+ chained renames + cross-sheet ambiguity + concurrent edits)
   130	
   131	Per D-1 step-8 megaudit pattern: dispatch all 3 lanes IN PARALLEL (not sequential) to avoid anchoring.
   132	

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '680,690p;809,821p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   680	            column_names,
   681	        ),
   682	        Op::DropTable { name } => {
   683	            let canonical = name.to_ascii_uppercase();
   684	            if workbook.tables_mut().remove(canonical.as_str()).is_none() {
   685	                return Err(ReplayError::TableNotFound {
   686	                    index,
   687	                    name: name.clone(),
   688	                });
   689	            }
   690	            Ok(())
   809	    if workbook.tables().lookup(&old_canonical).is_none() {
   810	        let new_canonical = new_name.to_ascii_uppercase();
   811	        if workbook.tables().lookup(&new_canonical).is_some() {
   812	            // Case (a): idempotent — new_name already exists.
   813	            return Ok(());
   814	        }
   815	        // Cases (b) and (c): no related state. Advisory skip
   816	        // (case b) accepts losing the rename intent rather than
   817	        // hard-failing replay; the alternative would be re-erroring
   818	        // and making merged logs un-replayable. The diagnostic
   819	        // surface for (b) would require op-log-level reporting
   820	        // beyond replay's return type — deferred to V2.
   821	        return Ok(());

diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..dec6119b126fdd395c66a0f87ea9e270fd521993
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,190 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+
+    let mut drop_then_rename_a = fork_with_peer(&base, PEER_A_ID);
+    drop_then_rename_a
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    let mut drop_then_rename_b = fork_with_peer(&base, PEER_B_ID);
+    drop_then_rename_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    drop_then_rename_a
+        .merge_bytes(&drop_then_rename_b.export_bytes().unwrap())
+        .unwrap();
+
+    let drop_then_rename = replay_result(&drop_then_rename_a);
+    eprintln!("drop(id=1)+rename(id=2): {drop_then_rename:?}");
+
+    let mut rename_then_drop_a = fork_with_peer(&base, PEER_A_ID);
+    rename_then_drop_a
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    let mut rename_then_drop_b = fork_with_peer(&base, PEER_B_ID);
+    rename_then_drop_b
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    rename_then_drop_a
+        .merge_bytes(&rename_then_drop_b.export_bytes().unwrap())
+        .unwrap();
+    let rename_then_drop = replay_result(&rename_then_drop_a);
+    eprintln!("rename(id=1)+drop(id=2): {rename_then_drop:?}");
+
+    assert!(drop_then_rename.is_err() || rename_then_drop.is_err());
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

exec
/bin/zsh -lc 'cargo test -p ql-exec --test codex_phase_5_3_step5_temp_probes -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
diff --git a/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
new file mode 100644
index 0000000000000000000000000000000000000000..dec6119b126fdd395c66a0f87ea9e270fd521993
--- /dev/null
+++ b/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
@@ -0,0 +1,190 @@
+use ql_exec::WorkbookRuntime;
+use ql_functions::default_registry;
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::{Address, ErrorValue, Value};
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id).unwrap();
+    log
+}
+
+fn base_with_sales_table() -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: "S".to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log.append(Op::CreateTable {
+        name: "T".to_owned(),
+        sheet: 0,
+        top_row: 0,
+        top_col: 0,
+        rows: 3,
+        cols: 2,
+        has_header: true,
+        has_totals: false,
+        column_names: vec!["A".to_owned(), "B".to_owned()],
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 1,
+        col: 0,
+        value: CellWireValue::Number(10.0),
+    })
+    .unwrap();
+    log.append(Op::PutValue {
+        sheet: 0,
+        row: 2,
+        col: 0,
+        value: CellWireValue::Number(20.0),
+    })
+    .unwrap();
+    log
+}
+
+fn replay_result(log: &OpLog) -> Result<Workbook, ql_oplog::ReplayError> {
+    let mut wb = Workbook::new();
+    let reg = default_registry();
+    replay_into(log, &mut wb, &reg)?;
+    Ok(wb)
+}
+
+#[test]
+fn codex_probe_drop_table_concurrent_rename_table_hard_fails() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+
+    let mut drop_then_rename_a = fork_with_peer(&base, PEER_A_ID);
+    drop_then_rename_a
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    let mut drop_then_rename_b = fork_with_peer(&base, PEER_B_ID);
+    drop_then_rename_b
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    drop_then_rename_a
+        .merge_bytes(&drop_then_rename_b.export_bytes().unwrap())
+        .unwrap();
+
+    let drop_then_rename = replay_result(&drop_then_rename_a);
+    eprintln!("drop(id=1)+rename(id=2): {drop_then_rename:?}");
+
+    let mut rename_then_drop_a = fork_with_peer(&base, PEER_A_ID);
+    rename_then_drop_a
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "T2".into(),
+        })
+        .unwrap();
+    let mut rename_then_drop_b = fork_with_peer(&base, PEER_B_ID);
+    rename_then_drop_b
+        .append(Op::DropTable { name: "T".into() })
+        .unwrap();
+    rename_then_drop_a
+        .merge_bytes(&rename_then_drop_b.export_bytes().unwrap())
+        .unwrap();
+    let rename_then_drop = replay_result(&rename_then_drop_a);
+    eprintln!("rename(id=1)+drop(id=2): {rename_then_drop:?}");
+
+    assert!(drop_then_rename.is_err() || rename_then_drop.is_err());
+}
+
+#[test]
+fn codex_probe_column_rename_formula_without_repair_yields_name_error() {
+    let base = base_with_sales_table().export_bytes().unwrap();
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "Alpha".into(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutFormula {
+            sheet: 0,
+            row: 5,
+            col: 0,
+            text: "SUM(T[A])".into(),
+        })
+        .unwrap();
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let mut wb = replay_result(&peer_a).expect("replay itself succeeds");
+    assert_eq!(
+        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
+        Some("SUM(T[A])".to_owned()),
+        "no column repair pass rewrites T[A] to T[Alpha]"
+    );
+    {
+        let reg = default_registry();
+        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+        rt.recompute_all();
+    }
+    assert_eq!(
+        wb.read(Address::new(0, 5, 0)),
+        Value::Error(ErrorValue::Name),
+        "formula referencing renamed column binds as #NAME? without column repair"
+    );
+}
+
+#[test]
+fn codex_probe_case_only_policy_sheet_table_column() {
+    let mut sheet_log = OpLog::new();
+    sheet_log
+        .append(Op::AddSheet {
+            name: "Sheet1".into(),
+            chunk_rows: 16384,
+        })
+        .unwrap();
+    sheet_log
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "Sheet1".into(),
+            new_name: "SHEET1".into(),
+        })
+        .unwrap();
+    assert_eq!(replay_result(&sheet_log).unwrap().sheet(0).unwrap().name(), "SHEET1");
+
+    let mut table_log = base_with_sales_table();
+    table_log
+        .append(Op::RenameTable {
+            old_name: "T".into(),
+            new_name: "t".into(),
+        })
+        .unwrap();
+    assert_eq!(
+        replay_result(&table_log)
+            .unwrap()
+            .tables()
+            .lookup("T")
+            .unwrap()
+            .display_name
+            .as_ref(),
+        "T",
+        "same-canonical table rename is a replay no-op"
+    );
+
+    let mut column_log = base_with_sales_table();
+    column_log
+        .append(Op::RenameColumn {
+            table: "T".into(),
+            old_name: "A".into(),
+            new_name: "a".into(),
+        })
+        .unwrap();
+    assert!(
+        replay_result(&column_log).is_err(),
+        "same-canonical column rename is rejected at replay"
+    );
+}

 succeeded in 350ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.08s
     Running tests/codex_phase_5_3_step5_temp_probes.rs (target/debug/deps/codex_phase_5_3_step5_temp_probes-d67de54502226bae)

running 3 tests
test codex_probe_case_only_policy_sheet_table_column ... ok
test codex_probe_column_rename_formula_without_repair_yields_name_error ... ok
test codex_probe_drop_table_concurrent_rename_table_hard_fails ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s


apply patch
patch: completed
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/codex_phase_5_3_step5_temp_probes.rs
exec
/bin/zsh -lc 'git status --short' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 1058ms:
?? .codex-phase-5-3-step-5-audit.out
?? .codex-phase-5-3-step-5-megaudit-prompt.md
?? .opus-a-phase-5-3-step-5-prompt.md
?? .opus-b-phase-5-3-step-5-prompt.md
?? 2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt
?? 2026-05-13-003338-this-session-is-being-continued-from-a-previous-c.txt
?? node_modules
?? quantbook-engine/.codex/prompts/2026-05-14-AA-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-127-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-128-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-129-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-132-133followup-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-HIGH3-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-LOW-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM4-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM5-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-K-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-L-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-M-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-N-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.I-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-megaudit-pass2.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closing-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-final-reverify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-mid-arc-audit.md
?? quantbook-engine/.plans/_archive/
?? quantbook-engine/2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-opus-a.md
?? quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-opus-b.md

exec
/bin/zsh -lc "rg -n \"OpLog::import_bytes|import_bytes\\(|set_peer_id|fork_with_peer\" quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs quantbook-engine/crates/ql-collab/tests/repair_renames.rs quantbook-engine/crates/ql-collab/tests/repair_tables.rs quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:19:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:20:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:21:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:22:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:66:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:73:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:160:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:167:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:233:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:240:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:269:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:283:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:317:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:327:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:356:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:363:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:13://!   2. Fork peer A + peer B by `import_bytes(&base_bytes)`.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:110:/// Both ids are non-zero (LEGACY_PEER reservation — `set_peer_id(0)`
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:119:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:120:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:121:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:122:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:134:    let mut peer_a = fork_with_peer(base_bytes, PEER_A_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:137:    let mut peer_b_for_a = fork_with_peer(base_bytes, PEER_B_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:144:    let mut peer_b = fork_with_peer(base_bytes, PEER_B_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:147:    let mut peer_a_for_b = fork_with_peer(base_bytes, PEER_A_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:536:    let mut peer_a = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:537:    peer_a.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:545:    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:546:    peer_b_for_a.set_peer_id(2).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:560:    let mut peer_b = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:561:    peer_b.set_peer_id(2).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:570:    let mut peer_a_for_b = OpLog::import_bytes(&base).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:571:    peer_a_for_b.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:688:/// **Audit closure (Opus LOW-1):** switched to `fork_with_peer` for
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:690:/// `OpLog::import_bytes` without `set_peer_id` — it happened to pass
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:694:/// convergence. Using `fork_with_peer` makes the pattern uniform.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:699:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:708:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:722:    let reloaded = OpLog::import_bytes(&merged_bytes).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:21:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:22:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:23:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:24:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:70:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:77:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:135:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:142:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:173:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:181:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:216:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:224:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:20://! `fork_with_peer(base, peer_id)` inlined here because it lives in
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:36:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:37:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:38:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:39:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:76:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:84:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:97:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:105:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:148:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:156:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:169:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:177:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:210:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:221:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:256:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:264:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:278:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:287:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:342:        let mut log = fork_with_peer(&base, peer_id);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:430:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:438:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:451:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:459:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:13://!   2. Fork peer A + peer B via `fork_with_peer`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:32:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:33:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:34:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:35:        .expect("set_peer_id with non-zero id must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:62:    let mut peer_a = fork_with_peer(base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:64:    let mut peer_b = fork_with_peer(base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:138:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:155:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:189:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:206:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:255:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:265:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:391:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:402:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:451:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:463:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:511:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:513:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:522:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:524:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:629:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:646:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);

exec
/bin/zsh -lc "rg -n \"X\\(2\\)|AUTO_RENAME_CEILING|auto-disambig|auto-disambigu\" quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs quantbook-engine/crates/ql-collab/tests/repair_tables.rs quantbook-engine/crates/ql-collab/tests/repair_renames.rs quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:190:/// Pre-audit-closure: replay auto-disambig'd to {X, X(2)} but the
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:191:/// repair pass mishandled the auto-disambig'd canonical, causing
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:12://! D-2-style auto-disambiguation for target collisions (mirroring
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:94:/// Pre-audit-closure: auto-disambig produced {X, X(2)} but the
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:95:/// repair pass mis-handled the auto-disambig'd canonical, causing
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:206:/// cross-column target collision. Pre-audit-closure: auto-disambig
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:364:// ===== Test 7: Step 2 auto-disambiguation chain =====
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:368:/// disambiguation suffixes the second to `X(2)`. Peer C writes
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:371:/// sheet 1, which is `X(2)`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:400:    // triggers step 2 auto-rename to X(2)). Also writes a formula
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:422:    // Sheet 0 = "X" (peer A's rename), sheet 1 = "X(2)" (auto-disambig).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:424:    assert_eq!(wb.sheet(1).unwrap().name(), "X(2)");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:428:    // Sheet 1's formula referencing old S3 → rewritten to current X(2).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:430:    // so the printer emits `'X(2)'!B1` (single-quoted), NOT `X(2)!B1`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:435:        Some("'X(2)'!B1".to_string()),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:436:        "repair must rewrite to the auto-disambiguated current name X(2) \
quantbook-engine/crates/ql-oplog/src/replay.rs:465:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/crates/ql-oplog/src/replay.rs:472:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/crates/ql-oplog/src/replay.rs:529:            // sheet) auto-disambiguates via D-2-style suffix walk
quantbook-engine/crates/ql-oplog/src/replay.rs:551:            const AUTO_RENAME_CEILING: u32 = 10_000;
quantbook-engine/crates/ql-oplog/src/replay.rs:564:            // Case 2: apply rename, auto-disambiguating Duplicate via D-2
quantbook-engine/crates/ql-oplog/src/replay.rs:574:                        if suffix > AUTO_RENAME_CEILING {
quantbook-engine/crates/ql-oplog/src/replay.rs:769:///    D-2-style auto-disambig (X → X(2)), but the step 4 audit
quantbook-engine/crates/ql-oplog/src/replay.rs:773:///    the auto-disambig'd canonical. Reverted to hard-reject. V2
quantbook-engine/crates/ql-oplog/src/replay.rs:825:    // auto-disambiguation REVERTED. The previous implementation
quantbook-engine/crates/ql-oplog/src/replay.rs:826:    // walked suffixes (X → X(2)) on TableTable collision, but the
quantbook-engine/crates/ql-oplog/src/replay.rs:829:    // post-replay canonical (which would be the suffixed `X(2)`).
quantbook-engine/crates/ql-oplog/src/replay.rs:936:    // column auto-disambiguation REVERTED. Same root cause as
quantbook-engine/crates/ql-oplog/src/replay.rs:1849:    /// auto-disambiguates via the suffix walk (`Sheet2(2)`, etc.) —
quantbook-engine/crates/ql-oplog/src/replay.rs:1856:        // succeed via auto-disambiguation (Sheet2 → Sheet2(2)).
quantbook-engine/crates/ql-oplog/src/replay.rs:1878:            .expect("replay must auto-disambiguate, not error (post-HIGH-1 closure)");

exec
/bin/zsh -lc "rg -n \"PRE-FIX|Phase 5\\.3 step 3 will|FIX coming in step|TODO.*step 5|step 5.*TODO|Step 5.*TODO|TODO.*Step 5\" quantbook-engine/crates/ql-oplog quantbook-engine/crates/ql-collab quantbook-engine/crates/ql-exec quantbook-engine/docs/architecture quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/.plans/_active.md -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc 'rg -n "matches!'"\\(["'^'"\\n]*SheetRenameNameMismatch|SheetRenameNameMismatch \\{\\s*\\.\\.|Err\\(["'^'"\\n]*SheetRenameNameMismatch|ReplayError::SheetRenameNameMismatch\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which

 succeeded in 0ms:
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs | sed -n '1,16p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_tables.rs | sed -n '1,12p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 step 4 — concurrent RenameTable + RenameColumn replay
     2	//! convergence. 2026-05-20.
     3	//!
     4	//! Mirrors `phase_5_3_step2_rename_concurrent.rs` (sheet rename) for
     5	//! table + column renames. The pre-step-4 bug shape (from Opus step 1
     6	//! audit MEDIUM-2): `apply_rename_table` (`replay.rs:691`) and
     7	//! `apply_rename_column` (`replay.rs:749`) hard-fail under CRDT
     8	//! merge of concurrent renames — same root cause as the RenameSheet
     9	//! bug step 2 fixed.
    10	//!
    11	//! Post-step-4: replay applies "last-in-causal-order wins" +
    12	//! D-2-style auto-disambiguation for target collisions (mirroring
    13	//! step 2).
    14	
    15	use ql_oplog::{replay_into, Op, OpLog};
    16	use ql_storage::Workbook;

 succeeded in 0ms:
     1	//! Phase 5.3 step 4 — table rename-repair integration tests. 2026-05-20.
     2	//!
     3	//! Mirrors `repair_renames.rs` (sheet repair) pattern for table
     4	//! rename scenarios. Covers:
     5	//! - Primary case: concurrent rename + concurrent formula referencing old table name
     6	//! - Auto-disambiguation interaction (step 4 replay handler)
     7	//! - Safety guard: skip rules where old_canonical is currently held
     8	//! - No-rename log → no-op
     9	//! - BatchCommit traversal
    10	//! - Empty new_name + same-canonical no-op (replay rejects/skips)
    11	
    12	use ql_collab::{repair_table_rename_chain, TableRepairReport};

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs | sed -n '20,33p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    20	//! Coverage of the 8-row matrix at `crdt-data-model.md:320-329`:
    21	//! - Row 1: PutValue × PutValue same address — pinned here
    22	//! - Row 2: PutFormula × PutFormula same address — pinned here
    23	//! - Row 3: PutValue × PutFormula same address — pinned here
    24	//! - Row 4: ClearFormula × PutFormula same address — pinned here
    25	//! - Row 5: SetName concurrent same name — pinned here
    26	//! - Row 6: AddSheet × AddSheet same name (D-2 auto-rename) — pinned here
    27	//! - Row 7: RenameSheet × concurrent edit on sheet — **pinned here as
    28	//!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
    29	//!   step 3 ships the rename-repair pass which will MODIFY this test
    30	//!   to assert the post-fix behavior (formula text rewritten,
    31	//!   correct value resolves).
    32	//! - Row 8: DropTable × concurrent edit referencing T — pinned here
    33	//!   (D-3 → #NAME?; no repair planned — drop is destructive)

exec
/bin/zsh -lc "rg -n \"Phase 5\\.3|5\\.3|repair_sheet_rename_chain|repair_table_rename_chain|AmbiguousSkip|TableRepairReport|TableAmbiguousSkip|RenameTable|RenameColumn\" quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/architecture/ide-consumer-contract.md -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/ide-consumer-contract.md:195:- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. Causality-aware rename-repair pass at merge time is deferred to Phase 5.3.
quantbook-engine/docs/architecture/crdt-data-model.md:79:- Tables: `CreateTable`, `DropTable`, `RenameTable`,
quantbook-engine/docs/architecture/crdt-data-model.md:80:  `RenameColumn`, `ResizeTable`
quantbook-engine/docs/architecture/crdt-data-model.md:177:For Phase 5 V1 this is acceptable per master plan § 5.3
quantbook-engine/docs/architecture/crdt-data-model.md:311:## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/architecture/crdt-data-model.md:318:target. Phase 5.3 formalizes this with these defaults:
quantbook-engine/docs/architecture/crdt-data-model.md:328:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | **Phase 5.3 step 3 ✅ shipped 2026-05-20:** post-merge `ql_collab::repair_sheet_rename_chain` rewrites the formula text from `A!...` to `B!...` (current name) before recompute. Pre-step-3 the D-3 V1 limitation produced `#NAME?`; post-step-3 the formula resolves correctly. Caller invokes the repair pass between `replay_into` and `recompute_all` (caller-driven, NOT auto-hooked into `merge_bytes`). |
quantbook-engine/docs/architecture/crdt-data-model.md:329:| `RenameSheet { 0, _, A }` × `RenameSheet { 0, _, B }` (same sheet, different targets) | **Phase 5.3 step 2 ✅ shipped:** last-in-causal-order wins; second rename applies to the current sheet name. `old_name` becomes advisory (replay no longer validates it). Pre-step-2 replay hard-failed via `SheetRenameNameMismatch`. |
quantbook-engine/docs/architecture/crdt-data-model.md:330:| `RenameSheet { 0, _, X }` × `RenameSheet { 1, _, X }` (different sheets, same target) | **Phase 5.3 step 2 audit closure ✅ shipped:** D-2-style auto-disambiguation — second rename suffixes to `X(2)`, etc. Pre-closure replay hard-failed via `SheetRenameRejected { source: Duplicate }`. |
quantbook-engine/docs/architecture/crdt-data-model.md:331:| `RenameSheet { 0, "Sheet1", "SHEET1" }` (case-only rename) | **Phase 5.3 step 2 audit closure ✅ shipped:** replay applies the display update. Pre-closure the canonical-equality idempotency check silently dropped case-only renames. |
quantbook-engine/docs/architecture/crdt-data-model.md:334:The 5.3 audit checkpoint validates these defaults against the
quantbook-engine/docs/architecture/crdt-data-model.md:341:**Phase 5.3 step 1 audit closure (2026-05-20).** Loro's
quantbook-engine/docs/architecture/crdt-data-model.md:580:open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/architecture/crdt-data-model.md:627:deferred to Phase 5.3. Audit pushed back: spreadsheet users
quantbook-engine/docs/architecture/crdt-data-model.md:645:**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
quantbook-engine/docs/architecture/crdt-data-model.md:668:shows `#NAME?` after the merge. Phase 5.3 adds a causality-
quantbook-engine/docs/architecture/crdt-data-model.md:676:manual edit or until 5.3 ships the causality-aware repair.
quantbook-engine/docs/architecture/crdt-data-model.md:680:**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
quantbook-engine/docs/architecture/crdt-data-model.md:737:   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/phase5/entry-plan.md:3:status: SUPERSEDED-BY-EXIT-PACKET — Phase 5 V1 COMPLETE 2026-05-19. **D-1 SHIPPED 2026-05-20** (all 8 steps + 7 per-step audits + 1 megaudit). See `docs/phase5/d-1-exit-packet.md` (D-1 closure record) + `docs/phase5/v1-exit-packet.md` (canonical V1 record) + `docs/phase5/d-1-starting-checklist.md` (D-1 execution-trace history). 5.3, 5.5 V2 V2/V3, 5.7, and 5.8 also remain.
quantbook-engine/docs/phase5/entry-plan.md:116:| 5.3 | Conflict Resolution Semantics | 4-7 days | Causality-aware rename-repair pass; multi-value / delete-vs-update. Loro merge is Fugue/origin-based (not Lamport LWW — corrected by Phase 5.1 audit). |
quantbook-engine/docs/phase5/entry-plan.md:186:- `docs/architecture/conflict-resolution.md` — at 5.3 close.

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '620,682p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   620	
   621	**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
   622	
   623	**Source:** Opus H-3.
   624	
   625	The pre-audit design said "AddSheet S × AddSheet S → first
   626	wins; second errors via NameRejected" with auto-rename
   627	deferred to Phase 5.3. Audit pushed back: spreadsheet users
   628	expect Google Sheets behavior where both adds succeed with
   629	auto-disambiguation (S and S(2)). Silent rejection of the
   630	second is worse UX than auto-rename.
   631	
   632	**Resolution:** Phase 5.2 acceptance criterion: AddSheet
   633	collision auto-renames the SECOND ADD (in deterministic merge
   634	order) to `<name>(2)`. If `<name>(2)` is also taken, escalate
   635	to `<name>(3)`, etc.
   636	
   637	This is a producer/replay path change, not a wire-format
   638	change. The `Op::AddSheet { name }` op is unchanged; replay
   639	re-resolves the final name at apply time when a collision is
   640	detected. Producer-side emits the original name; replay-side
   641	disambiguates.
   642	
   643	### D-3: RenameSheet × concurrent edit — known V1 limitation
   644	
   645	**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
   646	
   647	**Source:** Opus H-2 + Codex V5.
   648	
   649	The pre-audit design described this as "edit's formula text
   650	references the old name → bind fails → `#NAME?`." Codex
   651	verified the actual bug shape:
   652	
   653	- Bind error type is `BindError::UnknownSheet("S")`, NOT
   654	  `BindError::UnresolvedName("S")` (different code path).
   655	- `recompute_all` (post-Tier-C1) does NOT map
   656	  `BindError::UnknownSheet` to `Value::Error(ErrorValue::Name)`
   657	  — only `UnknownTable` and `UnknownTableColumn` get that
   658	  treatment in `cells.rs::recompute_dirty` and `recompute_all`
   659	  (`workbook_runtime/recompute.rs:179`).
   660	- Result: the cell retains its stale pre-recompute value AND
   661	  the formula appears as a `RecomputeFailure` in
   662	  `RecomputeResult::failures`. Worse than `#NAME?` — the user
   663	  sees the formula text but a wrong value.
   664	
   665	**Resolution:** Phase 5.2 adds the missing
   666	`BindError::UnknownSheet → ErrorValue::Name` mapping in
   667	`recompute_all` and `recompute_dirty` so the cell at least
   668	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
   669	aware rename-repair pass: at merge time, the replay sweep
   670	walks formulas added causally-before the RenameSheet op and
   671	rewrites their text in-place (the same way the producer-side
   672	rename does for visible formulas).
   673	
   674	Documented as a **known Phase 5.2 V1 limitation**: concurrent
   675	cross-sheet formula additions may surface as `#NAME?` until
   676	manual edit or until 5.3 ships the causality-aware repair.
   677	
   678	### D-4: Spill semantics — replay defers to recompute, not per-op
   679	
   680	**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
   681	
   682	**Source:** Codex V3.

exec
/bin/zsh -lc "rg -n \"step 4.*adds|Step 4 extension|need the same treatment|column repair pass|RenameColumn.*repair|repair.*RenameColumn|Phase 5\\.3 will add|until 5\\.3 ships|5\\.3 ships\" quantbook-engine/crates/ql-collab/src/repair.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/.plans/_active.md -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:645:**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
quantbook-engine/docs/architecture/crdt-data-model.md:676:manual edit or until 5.3 ships the causality-aware repair.
quantbook-engine/.plans/_active.md:104:- Audit closure: `6752ca2545c` (6th consecutive divergent-HIGH cycle — both auditors caught 2 HIGHs: (a) auto-disambig + repair mismatch corrupts cross-table formulas; (b) column repair pass missing)
quantbook-engine/.plans/_active.md:128:- Should column repair pass land in V1, or is the gap acceptable?
quantbook-engine/.plans/_active.md:158:1. ~~Priority confirmation (5.3 vs 5.5 V2 V2/V3 vs other)~~ → user said "Proceed with 5.3 as planned" (AskUserQuestion at session start). After 5.3 ships, the recommended sequence is **5.5 V2 V2/V3 (production transport) → 5.7 IDE slice → 5.8 Phase 5 megaudit** per D-1 exit packet priority guidance.
quantbook-engine/crates/ql-collab/src/repair.rs:99://! - **Step 4 extension**: this V1 only handles sheet renames.
quantbook-engine/crates/ql-collab/src/repair.rs:100://!   `Op::RenameTable` + `Op::RenameColumn` need the same treatment;
quantbook-engine/crates/ql-collab/src/repair.rs:101://!   step 4 of the Phase 5.3 arc adds them.

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/MASTER-PLAN.md | sed -n '543,592p' && nl -ba quantbook-engine/docs/phase5/v1-exit-packet.md | sed -n '20,24p;213,240p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   543	## Phase 5 - Multi-User CRDT Collaboration
   544	
   545	**Status (2026-05-20): Phase 5 V1 + D-1 COMPLETE.** Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` (D-1 closure). Remaining: 5.3 conflict resolution, 5.5 V2 V2/V3 production transport, 5.7 IDE slice, 5.8 Phase 5 megaudit (separate from D-1 step 8).
   546	
   547	**Purpose:** Turn collaboration from a single-writer op log into real multi-user CRDT state for sheets, cells, names, tables, presence, undo/redo, and offline sync.
   548	
   549	**Entry State Required**
   550	
   551	- Phase 3 graph runtime exists.
   552	- Phase 4 semantics are broad enough that collaboration does not need to redesign value/formula/table structures.
   553	
   554	**Dependencies**
   555	
   556	- Requires stable operation vocabulary from `ql-oplog`.
   557	- Requires storage semantics for computed versus user state.
   558	- Requires IDE proof surface for multi-user presence.
   559	
   560	**Sub-items**
   561	
   562	1. **5.1 Collaboration Data Model Decision** ✅ SHIPPED 2026-05-19 (`918d7efdd91` + `df52cb44ad2`).
   563	   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).
   564	
   565	2. **5.2 `ql-collab` Core Documents** 🟡 IN PROGRESS.
   566	   - ✅ D-2 (`1ca19e2fa37`) AddSheet auto-rename.
   567	   - ✅ D-3 (`e71312d4bcd`) UnknownSheet → #NAME?.
   568	   - ✅ D-4 (`2f217a2067a`) OpLog::merge_bytes + 2-peer spill probe.
   569	   - ✅ 5.2.a scaffold (`66a571b30af`).
   570	   - ✅ 5.2.b PeerId → LoroDoc wiring (`ef056f50bee`).
   571	   - ✅ **D-1 (FormatId tagged tuple, multi-day) — SHIPPED 2026-05-20.** All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit complete. **16/16 audit cycles caught real bugs.** Workspace tests: 4222 → 4291 (+69). See `docs/phase5/d-1-exit-packet.md` for the closure record + `docs/phase5/d-1-starting-checklist.md` for execution-trace history.
   572	
   573	3. **5.3 Conflict Resolution Semantics** — future. Causality-aware rename-repair pass. 4-7 days. (V1 ships `BindError::UnknownSheet → #NAME?` as the simple case per Phase 5.2 D-3.)
   574	
   575	4. **5.4 Undo/Redo And Operation Grouping** ✅ V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19.
   576	   - V1 (`89c02b9d83e`): 7 undo/redo methods on CollabSession wrapping `loro::UndoManager`; presence-origin commits auto-excluded.
   577	   - V2 V1 (`6138a7203f6` + `e199a5fda5a`): `start_undo_group` / `end_undo_group` + `set_undo_merge_interval`.
   578	   - V2 V1.1 (`7cbdc689ea9`): RAII `start_undo_group_scoped` returning `UndoGroupGuard` (panic/Err-safe). Codex audit PASS.
   579	   - V2 V2 pending: push/pop listeners (lower priority, speculative).
   580	
   581	5. **5.5 Transport Layer And Offline Sync** 🟡 V1 + V2 V1 SHIPPED 2026-05-19; V2 V2/V3 pending.
   582	   - V1 (`924750819bc`): `Transport` trait + `NoopTransport` + `LoopbackTransport::pair()`.
   583	   - V2 V1 (`ffd8f6e5f05`): `CollabSession::{attach,detach,has}_transport` + `flush_to_transport` + `poll_remote` (+ `_with_limit`).
   584	   - V2 V2 / V3 pending: WebSocket impl + reconnect + auto-flush + version-vector delta exports.
   585	
   586	6. **5.6 Presence And Awareness** ✅ V1 + V2 SHIPPED 2026-05-19.
   587	   - V1 (`c677e244704`): `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods.
   588	   - V2 (`d4b3cdb2dc2`): `sweep_presence` caller-opt-in clean-slate.
   589	
   590	7. **5.7 Collaboration IDE Vertical Slice** — future. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
   591	
   592	8. **5.8 Phase 5 Megaudit** — future. Depends on 5.1-5.7 complete.
    20	Phase 5.2 D-1 (FormatId tagged tuple) ✅ SHIPPED 2026-05-20 — see
    21	`docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
    22	+ Phase 5.5 V2 V2/V3 (WebSocket / auto-flush) + Phase 5.7 IDE
    23	vertical slice remain ahead of the 5.8 megaudit.
    24	
   213	## What's deferred (forward work for next session(s))
   214	
   215	### Major (multi-day)
   216	
   217	- **Phase 5.2 D-1 — FormatId tagged tuple.** ✅ **SHIPPED 2026-05-20.**
   218	  All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit
   219	  complete. See `docs/phase5/d-1-exit-packet.md` for the closure
   220	  record (final HEAD `6e32c269c22`; workspace tests 4222 → 4291;
   221	  16/16 audit cycles caught real bugs). Touched `ql-types::peer`,
   222	  `ql-storage::format`, `ql-oplog::wire` + `op` + `replay`,
   223	  `ql-io::qbook_format` (v7→v8) + `oplog_persistence` (Tier D3
   224	  header), `ql-io-xlsx::write::umya_export` (XlsxNumFmtTranslation).
   225	
   226	- **Phase 5.3 — Conflict resolution semantics.** Causality-aware
   227	  rename-repair pass at merge time (currently V1 emits `#NAME?`
   228	  for concurrent edits to renamed sheets). 4-7 days estimated.
   229	
   230	- **Phase 5.5 V2 V2 / V3 — Production transport.** WebSocket impl
   231	  + reconnect / offline sync + auto-flush on append (with
   232	  per-transport version-vector tracking for delta exports).
   233	  1-2 weeks estimated.
   234	
   235	- **Phase 5.7 — IDE vertical slice.** Two-window editing demo.
   236	  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
   237	
   238	- **Phase 5.8 — Megaudit.** Randomized peer-merge tests +
   239	  transport failure modes. 4-6 days.
   240	

codex
Executive summary: VERDICT: FAIL. I found one HIGH in the V1-limitation re-verification: `DropTable × concurrent RenameTable` is not simply “hard-fails”; it is order-dependent. With drop before rename, replay succeeds and silently drops the rename intent; with rename before drop, replay hard-fails via `TableNotFound`. The rest of the 5.3 cross-step invariants are broadly intact, but there is doc rot around post-step-3/post-step-4 behavior, public 5.3 APIs are not yet in the IDE consumer contract, and the real formula-rewrite helper duplication count is 5 even though exact `ql_formula_syntax::lex` grep returns 3.

**VERDICT: FAIL**

**HIGH**
1. `DropTable × concurrent RenameTable` limitation is empirically wrong / incomplete.
File refs: [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:682), [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:809), [.plans/_active.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/.plans/_active.md:118), [step-4 audit](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md:44).

Repro probe:
```rust
// same base table T
drop(id=1) + rename(id=2, T->T2) => replay Ok, table absent
rename(id=1, T->T2) + drop(id=2, T) => Err(TableNotFound { index: 5, name: "T" })
```
I verified this with a temporary ql-exec integration probe, then removed the file. The current implementation explains it: `DropTable` errors if the old key is gone, while `apply_rename_table` advisory-skips when its source is gone.

Proposed closure: either fix replay so `DropTable` can advisory-drop the current renamed table when the old source is gone, or rewrite the limitation/docs/tests to state the exact V1 behavior: “order-dependent; drop-before-rename succeeds by dropping and skipping stale rename, rename-before-drop hard-fails.” Add a permanent two-order regression test.

**MEDIUM**
1. Formula rewrite helper duplication is effectively 5 call sites.
Exact grep `rg "ql_formula_syntax::lex" quantbook-engine/crates -g '*.rs'` returns 3:
[repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:355), [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:548), [sheets.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:43). But `tables.rs` imports `lex` unqualified and adds two more table/column rewrite loops at [tables.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:323) and [tables.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:467).

Closure plan: put a shared formula-text rewrite helper in `ql-formula-syntax` that preserves leading `=`, skips malformed text, and accepts sheet/table/column rewrite mode. Replace the two ql-collab helpers plus ql-exec sheet/table/column producer rewrites.

**LOW**
1. Stale docs/prose remain:
- [phase_5_3_conflict_matrix_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:27) still says row 7 is PRE-FIX and “step 3 will” modify it.
- [phase_5_3_step4_table_column_concurrent.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:11) still claims table/column target collisions auto-disambiguate post-step-4.
- [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:99) still says step 4 adds RenameTable + RenameColumn repair; column repair was deferred.
- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:645) still says 5.3 will add rename repair.

2. Step 5/6 readiness docs are not current yet:
[ide-consumer-contract.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/ide-consumer-contract.md:195), [MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:545), and [v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:226) still describe 5.3 as future/deferred. They need the step-6 refresh, including public exports `repair_sheet_rename_chain`, `repair_table_rename_chain`, `RepairReport`, `AmbiguousSkip`, `TableRepairReport`, `TableAmbiguousSkip`.

**Clean Checks**
- No production/test code left modified; temporary probe file was deleted.
- Targeted tests passed for table collision, column collision, sheet case-only rename, row 8 DropTable edit, and column same-canonical no-op.
- `SheetRenameNameMismatch`: no test expects it to fire; only historical prose/doc references remain outside the deprecated replay variant.
- Step 2-4 peer-fork tests consistently use `fork_with_peer` or immediate `set_peer_id`; I found no 5.3 fork missing stable peer IDs.
tokens used
222,746
Executive summary: VERDICT: FAIL. I found one HIGH in the V1-limitation re-verification: `DropTable × concurrent RenameTable` is not simply “hard-fails”; it is order-dependent. With drop before rename, replay succeeds and silently drops the rename intent; with rename before drop, replay hard-fails via `TableNotFound`. The rest of the 5.3 cross-step invariants are broadly intact, but there is doc rot around post-step-3/post-step-4 behavior, public 5.3 APIs are not yet in the IDE consumer contract, and the real formula-rewrite helper duplication count is 5 even though exact `ql_formula_syntax::lex` grep returns 3.

**VERDICT: FAIL**

**HIGH**
1. `DropTable × concurrent RenameTable` limitation is empirically wrong / incomplete.
File refs: [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:682), [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:809), [.plans/_active.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/.plans/_active.md:118), [step-4 audit](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-consolidated.md:44).

Repro probe:
```rust
// same base table T
drop(id=1) + rename(id=2, T->T2) => replay Ok, table absent
rename(id=1, T->T2) + drop(id=2, T) => Err(TableNotFound { index: 5, name: "T" })
```
I verified this with a temporary ql-exec integration probe, then removed the file. The current implementation explains it: `DropTable` errors if the old key is gone, while `apply_rename_table` advisory-skips when its source is gone.

Proposed closure: either fix replay so `DropTable` can advisory-drop the current renamed table when the old source is gone, or rewrite the limitation/docs/tests to state the exact V1 behavior: “order-dependent; drop-before-rename succeeds by dropping and skipping stale rename, rename-before-drop hard-fails.” Add a permanent two-order regression test.

**MEDIUM**
1. Formula rewrite helper duplication is effectively 5 call sites.
Exact grep `rg "ql_formula_syntax::lex" quantbook-engine/crates -g '*.rs'` returns 3:
[repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:355), [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:548), [sheets.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:43). But `tables.rs` imports `lex` unqualified and adds two more table/column rewrite loops at [tables.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:323) and [tables.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:467).

Closure plan: put a shared formula-text rewrite helper in `ql-formula-syntax` that preserves leading `=`, skips malformed text, and accepts sheet/table/column rewrite mode. Replace the two ql-collab helpers plus ql-exec sheet/table/column producer rewrites.

**LOW**
1. Stale docs/prose remain:
- [phase_5_3_conflict_matrix_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:27) still says row 7 is PRE-FIX and “step 3 will” modify it.
- [phase_5_3_step4_table_column_concurrent.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:11) still claims table/column target collisions auto-disambiguate post-step-4.
- [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:99) still says step 4 adds RenameTable + RenameColumn repair; column repair was deferred.
- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:645) still says 5.3 will add rename repair.

2. Step 5/6 readiness docs are not current yet:
[ide-consumer-contract.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/ide-consumer-contract.md:195), [MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:545), and [v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:226) still describe 5.3 as future/deferred. They need the step-6 refresh, including public exports `repair_sheet_rename_chain`, `repair_table_rename_chain`, `RepairReport`, `AmbiguousSkip`, `TableRepairReport`, `TableAmbiguousSkip`.

**Clean Checks**
- No production/test code left modified; temporary probe file was deleted.
- Targeted tests passed for table collision, column collision, sheet case-only rename, row 8 DropTable edit, and column same-canonical no-op.
- `SheetRenameNameMismatch`: no test expects it to fire; only historical prose/doc references remain outside the deprecated replay variant.
- Step 2-4 peer-fork tests consistently use `fork_with_peer` or immediate `set_peer_id`; I found no 5.3 fork missing stable peer IDs.
