---
title: Phase 5.3 step 4 audit — Opus subagent verdict
date: 2026-05-20
audit_target: commit `7126eb44396` (step 4 ship)
auditor: Opus subagent (independent of engineer)
tokens_used: 87803
tool_uses: 26
duration_ms: 460686
verdict: PASS-WITH-FINDINGS (2 HIGH, 4 MEDIUM, 3 LOW)
---

## Verdict: PASS-WITH-FINDINGS

Step 4 ships the right algorithmic skeleton — replay no longer hard-fails, the chain-walk in `repair_table_rename_chain` mirrors the audit-locked sheet design, and the safety guard correctly extends step 3's closure to tables. However, **one HIGH (silent formula corruption when replay auto-disambiguates) is untested and reaches production**, and **the column repair gap is more severe than the step 4 commit messaging implies**.

## HIGH-1: Auto-disambiguated table repair silently corrupts formulas — repair maps to wrong table

**File**: `crates/ql-collab/src/repair.rs:394-491` + `crates/ql-oplog/src/replay.rs:828-863`

**What**: When replay auto-disambiguates (peer A: T1→X; peer B: T2→X → {X, X(2)}), the op log retains peer B's `new_name="X"`. `collect_table_renames` builds `historic_by_current[X] = [T1, T2]` because both ops nominally renamed-to-X. Peer B's formula `=T2[col]` (intending X(2)) is rewritten to `=X[col]` (the OTHER table). **Silent cross-table reference corruption.**

**CLOSED**: REVERTED auto-disambig for tables. Cross-source target collision now hard-fails with `TableCreateRejected`. V1 limitation documented in plan + replay docstring. V2 closure paths: emit synthesized correction op at replay (requires API change), or causality-aware tracking.

## HIGH-2: Column repair pass missing

**File**: `crates/ql-collab/src/repair.rs` (no `repair_column_rename_chain`)

**What**: Step 4 ships the replay fix for `apply_rename_column` (advisory skip + auto-disambig) but no repair pass for column references in formulas. Concurrent column rename + formula → broken bind → `#NAME?`.

**CLOSED**: REVERTED column auto-disambig (same root cause as HIGH-1: column repair would have needed disambig-trace integration). Cross-source column target collision now hard-fails. Column repair pass deferred to V2.

## MEDIUM-1: DropTable still hard-fails under CRDT merge of `RenameTable` + `DropTable`

**File**: `crates/ql-oplog/src/replay.rs:682-691`

**What**: Peer A renames T→T2. Peer B drops T concurrently. Causal order rename first, then drop → `tables_mut().remove("T")` → None → `ReplayError::TableNotFound`. Same bug shape that step 4 closed for RenameTable.

**DEFERRED**: out of step 4 scope. Documented as V1 limitation; step 5 megaudit or follow-up will close.

## MEDIUM-2: `canonical_chain` HashMap is dead state

**File**: `crates/ql-collab/src/repair.rs:399-541`

**What**: `canonical_chain: HashMap<String, String>` is built up but never read. Pure dead state.

**CLOSED**: removed. `collect_table_renames` signature simplified.

## MEDIUM-3: Inconsistent case-only rename policy across sheet/table/column

**File**: `crates/ql-oplog/src/replay.rs`

**What**: Sheet case-only APPLIES; Table case-only SILENTLY NO-OPS; Column case-only HARD-REJECTS. Three different policies.

**DEFERRED**: Architectural inconsistency, not a bug. Picking one policy is a design discussion for step 5 megaudit.

## MEDIUM-4: BatchCommit traversal not tested for tables

**File**: `crates/ql-collab/tests/repair_tables.rs`

**What**: The repair pass walks `BatchCommit { ops }` but no test exercises that path for tables.

**CLOSED**: added `step4_audit_batchcommit_nested_table_rename_traverses_correctly` test.

## LOW-1: `Arc::from(chosen_canonical.as_str())` per iteration

Premature optimization concern; loop is bounded at 10k iterations. **N/A after HIGH-1 revert** (no loop now).

## LOW-2: Transitive chain test missing for tables

**CLOSED**: added `step4_audit_transitive_table_chain_to_final_name` test (T → T2 → T3 + concurrent formula).

## LOW-3: `lookup_column` doc says uppercase but code lowercases

**DEFERRED**: pre-existing doc bug; out of step 4 scope.

## Synthesis

Step 4 successfully extends the step-2 RenameSheet algorithm to RenameTable/RenameColumn replay (advisory-skip + safety guard) and adds `repair_table_rename_chain`. The audit caught that the auto-disambig + repair interaction was silently corrupting formulas (HIGH-1) and that column repair was missing (HIGH-2). Both HIGHs closed by REVERTING auto-disambig and documenting the cross-source target collision as a V1 limitation. The four MEDIUM findings are split: M-2 closed (dead state removed), M-4 closed (test added), M-1 + M-3 deferred to step 5 megaudit. The pragmatic revert preserves step 4's primary closure (Opus step 1 audit M-2: rename hard-fail on missing source) while avoiding the silent-corruption HIGHs.
