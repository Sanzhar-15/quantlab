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
