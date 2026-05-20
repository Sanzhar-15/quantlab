---
title: Phase 5.3 step 5c audit — Codex verdict (tactical correctness + adversarial lane)
date: 2026-05-20
audit_target: commit `96caf84a1af` (5c ship)
auditor: Codex CLI (parallel with Opus subagent)
verdict: FAIL (1 HIGH + 1 MEDIUM + 4 LOW)
lane: tactical correctness + workspace grep + adversarial integration probes
note: original `.out` file was deleted post-extraction; this document preserves the verdict block. Full transcript was ~9700 lines.
---

# Codex 5c audit — verdict transcript

## Executive summary

5c handles the column-only repair path, but it does not close the adversarial integration case where the table and one of its columns are renamed concurrently. Depending on replay order, the merged log either fails to rebuild before repair runs, or rebuilds but leaves `Sales[A]` stale after table repair because the column rule is still keyed under historic table `T`. That is a correctness failure for the 5c closure claim.

## VERDICT: FAIL

### HIGH

#### 1. Table rename × column rename breaks rebuild or leaves stale formulas

**File refs**:
- `crates/ql-oplog/src/replay.rs:927` (`apply_rename_column`)
- `crates/ql-collab/src/repair.rs:748` (column rule keying)
- `crates/ql-collab/src/session.rs:465` (`rebuild_workbook` propagation)

**Empirical probes** (run by Codex during audit, removed before submission):

1. **3-peer concurrent case**: base `T[A]`; peer A `RenameTable T → Sales`; peer B `RenameColumn T.A → AA`; peer C `PutFormula T[A]+1`. `replay_into` failed with `TableNotFound { index: 3, name: "T" }` when table rename replayed before column rename.

2. **Opposite deterministic order**: `PutFormula T[A]+1`, `RenameColumn T.A → AA`, `RenameTable T → Sales`. Replay succeeded, table repair rewrote to `Sales[A] + 1`, then column repair reported `ColumnRepairReport { formulas_rewritten: 0, column_rewrites: [], ... }`. Expected `Sales[AA] + 1`.

**Root cause**: `apply_rename_column` requires the wire table name to still exist. If it does, `repair_column_rename_chain` still records the rule under the wire table canonical `T`; after table repair, formulas reference `Sales[...]`, and Phase 3 drops the `(T, aa)` rule because current workbook tables only include `Sales`.

**Proposed closure**: build a table-alias mapping from table rename history and use it consistently for replay/repair, or add stable table IDs to table/column ops. Minimal V1 closure should:
- Add regression tests for both op orders.
- Remap column repair rules from historic table canonical to current table canonical when unambiguous.
- Prevent `apply_rename_column` from hard-failing merged logs where the table exists under a known renamed canonical.

### MEDIUM

#### M1. Committed 5c tests do not cover the H1 interaction

The 8 shipped `repair_columns` tests pass, but they only prove column-only text repair. No coverage for:
- Table rename + column rename + concurrent formula.
- Bidirectional convergence under cross-kind interaction.
- A committed end-to-end recompute assertion for columns.

Codex ran: `cargo test -p ql-collab --test repair_columns -- --test-threads=1` → 8 passed.

The safety-guard test verifies the skip record for `A → AA; B → A`, but does not assert the behavioral cost: a formula intending original `T[A]` remains unrepaired because `a` is currently held by the renamed-from-`B` column. That is a V1 tradeoff, but it should be pinned explicitly.

### LOW

#### L1. Chain walker is semantically correct for `T.A → T.B → T.C`
Raw collection becomes `(T,b)=[a]`, then `(T,c)=[b,a]`; Phase 3 sorts/dedupes to `[a,b]`.

#### L2. API naming remains asymmetric
`RepairReport` vs `TableRepairReport` / `ColumnRepairReport`, and `AmbiguousSkip` vs prefixed table/column variants. This matches the deferred step 5b LOW but should be cleaned before API freeze.

#### L3. `ColumnAmbiguousSkip.current_holder_col_canonical` is currently redundant with `historic_canonical`
`current_holder_col_display` adds useful diagnostics but is asymmetric with sheet/table skip records.

#### L4. Stale docs remain
- `repair.rs:16` still says "Both repair functions" and raw call sequence omits column repair.
- `known-gaps.md:113` still says column repair is V2 backlog.
- `.plans/_active.md:115` still lists "Column repair pass missing."
- No Tier H entry exists in `PHASE-4-V2-BACKLOG.md` to retire.

## tokens used
135,046

---

**Codex audit closed**. Cross-lane synthesis with Opus 5c audit (Opus convergent on HIGH-1 + identified Opus M1 silent rule-drop + M3 dead field + L2 docstring overstatement) drove the audit-closure commit. Both lanes converged on the same critical cross-kind table×column interaction HIGH.
