---
title: Phase 5.3 step 2 audit — Opus subagent verdict
date: 2026-05-20
audit_target: commit `1ed2bbba78a` (step 2 ship)
auditor: Opus subagent (independent of engineer)
tokens_used: 81973
tool_uses: 42
duration_ms: 461528
verdict: PASS-WITH-FINDINGS (2 HIGH + 4 MEDIUM + 3 LOW)
---

## Verdict: PASS-WITH-FINDINGS

Step 2 correctly closes the original hard-fail (same-sheet, different-target case) and the 5 tests pin convergence cleanly. fmt + clippy clean; `let _ = old_name;` is idiomatic and produces no clippy warning. The variant-keep-for-ABI choice is sound — verified no production code matches `SheetRenameNameMismatch`. Undo path doesn't emit RenameSheet (Loro's UndoManager retracts the visible LoroList entry; no counter-op), so no undo regression. The qbook envelope load path doesn't directly invoke `replay_into` on a RenameSheet stream, so no loader regression. However, I found one HIGH the commit message incorrectly characterizes as "the right behavior" and several test-coverage gaps.

## HIGH-1: Cross-sheet target collision still hard-fails replay — inconsistent with D-2 AddSheet policy

**File**: `crates/ql-oplog/src/replay.rs:560-569`

**What**: Two peers concurrently rename DIFFERENT sheets to the SAME target (peer A: S1→X; peer B: S2→X). After merge, the second `Workbook::rename_sheet` returns `SheetNameError::Duplicate { name: "X" }`, which step 2 wraps into `ReplayError::SheetRenameRejected` and propagates with `?`. **Replay hard-fails — exactly the failure mode step 2 was meant to eliminate for the same-sheet case.**

**Verified empirically**: ran a probe; result was `Err(SheetRenameRejected { index: 3, id: 1, old_name: "S2", new_name: "X", source: Duplicate { name: "X" } })` and one sheet was already renamed. Workbook is left in a half-renamed state.

**Why it matters**: D-2 set the policy that concurrent collision in `AddSheet` auto-renames to `<name>(2)`. The conflict-matrix doc (line 327) calls this out explicitly. Two users renaming two of their own sheets to the same name is a plausible UX event and should converge. As coded, the merged log is permanently un-replayable — no recovery path.

**Suggested fix**: apply the D-2 auto-rename walk inside the case-2+3 branch when `Workbook::rename_sheet` returns `Duplicate`. Mirror the AddSheet logic at `replay.rs:458-490`.

**CLOSED**: D-2-style auto-disambiguation implemented. New test `step2_audit_concurrent_rename_to_same_target_auto_disambiguates`. Converges with Codex HIGH.

## HIGH-2: `Op::RenameSheet { id, old_name, new_name: "" }` — empty new_name in concurrent context

**File**: `crates/ql-oplog/src/replay.rs:560-569`

**What**: Step 2 silently delegates ALL non-case-1 paths to `Workbook::rename_sheet(id, new_name.clone())`. `Workbook::rename_sheet` at `workbook.rs:497-499` returns `SheetNameError::Empty` when `new_name.is_empty()`. Pre-step-2 producer-side validation in `WorkbookRuntime::rename_sheet` rejects empty names — but the wire op format does not enforce this.

**Why it matters**: Not a regression strictly, but step 2's docstring claimed "rename target collision → SheetRenameRejected" without acknowledging that Empty + ReservedCharacter take the same path through the same error variant with a different `source`. Worse, in a multi-peer setting, the wire-format-only producer would be the ONLY layer rejecting `""`, and no probe test for this.

**Suggested fix**: document empty/reserved-char edge cases explicitly in the docstring.

**CLOSED**: docstring explicitly enumerates Empty + ReservedCharacter edge cases as part of "Edge cases" section.

## MEDIUM-1: Doc drift — `crdt-data-model.md` § 311-334 has no row for `RenameSheet × RenameSheet`

**File**: `docs/architecture/crdt-data-model.md:320-329`

**What**: The conflict-resolution table lists `SetName × SetName` (line 326) as "last-in-causal-order wins" — but `RenameSheet × RenameSheet` is not in the table. Row 7 covers RenameSheet × concurrent edit (formula text rewrite), which is step 3's domain. Step 2's policy is now codified in code but invisible in the canonical doc.

**Suggested fix**: add a row to the conflict table.

**CLOSED**: 3 new rows added to the conflict matrix table:
- `RenameSheet { 0, _, A } × RenameSheet { 0, _, B }` (same sheet, different targets)
- `RenameSheet { 0, _, X } × RenameSheet { 1, _, X }` (different sheets, same target — auto-disambiguates)
- `RenameSheet { 0, "Sheet1", "SHEET1" }` (case-only rename)

## MEDIUM-2: Test #4 doesn't verify the symmetric merge direction

**File**: `crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:215-258`

**What**: `step2_concurrent_rename_plus_literal_write_both_apply` only merges peer B's bytes into peer A and asserts on peer A's view. The symmetric direction is never checked.

**CLOSED**: test #4 rewritten with bidirectional merge + assertions on both peer A's and peer B's views.

## MEDIUM-3: Test #5 doesn't actually exercise transitivity

**File**: `crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:269-324`

**What**: The 3-peer test uses star-merge: each peer pulls every other peer's bytes. This makes A==B and B==C a tautology under set equality of the merged ops, not a genuine transitivity check.

**Suggested fix**: peers do DIFFERENT merge sequences (A merges B then C; B merges C then A; C merges A then B) and check that the FINAL state still converges.

**CLOSED**: 3-peer test rewritten to use 3 DIFFERENT merge orderings (BC, CA, AB). Genuine commutativity+associativity check now.

## MEDIUM-4: `let _ = old_name;` pattern is dead code

**File**: `crates/ql-oplog/src/replay.rs:560`

**What**: `let _ = old_name;` silences the unused-binding warning but is misleading because `old_name` IS used at line 566 (`old_name: old_name.clone()` in the error closure). Dead binding.

**CLOSED**: removed during the HIGH-1 rewrite. The variable is naturally used in error closures throughout the new auto-disambiguation loop.

## LOW-1: Test #2 doesn't bidirectionally merge

**File**: `crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:143-166`

**What**: `step2_concurrent_rename_identical_targets_is_idempotent` only does `peer_a.merge_bytes(&peer_b)` and asserts on peer A.

**CLOSED**: test #2 rewritten with bidirectional check + per-peer assertions.

## LOW-2: 3 calamine_smoke failures unrelated to step 2

Confirmed — pre-existing temp_dir race from D-1 step 8 megaudit Opus MEDIUM. Not a step 2 concern.

## LOW-3: Step 4 inheritance risk

The Opus step 1 MEDIUM-2 finding noted that `RenameTable` and `RenameColumn` have identical hard-fail patterns. Step 2 fixed only RenameSheet. **HIGH-1 above means step 4 will inherit the cross-table-collision bug** when it ships unless the fix is uniform. **Worth pre-noting in step 4 plan.**

**Pre-noted in `.plans/_active.md` step 4 description** during step 1 audit closure.

## Independence checks (verified)

- Production code (`CollabSession`) doesn't match `SheetRenameNameMismatch` anywhere.
- Undo path doesn't emit `RenameSheet` (Loro retracts via UndoManager; no counter-op).
- qbook envelope load doesn't invoke RenameSheet replay.
- Producer-side `WorkbookRuntime::rename_sheet` still validates old_name at write time, so the advisory replay relaxation only matters for malformed logs.

## Synthesis

Step 2 is structurally sound for the same-sheet/different-target case it set out to fix, but it leaves a sibling bug (HIGH-1: different-sheet/same-target) unaddressed. The commit message's claim that target collision "is the right behavior" warrants challenge: D-2 already established auto-rename as the policy for concurrent collision in AddSheet — RenameSheet should follow suit for consistency. The 5 tests pin the property they target but have subtle coverage gaps (MEDIUM-2/3) that would let a future regression slip. The `let _ = old_name` pattern is dead code (MEDIUM-4) since `old_name` IS used 6 lines down. Doc drift (MEDIUM-1) is an easy fix to fold into the step-3 prep.
