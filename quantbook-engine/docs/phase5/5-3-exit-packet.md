---
title: Phase 5.3 exit packet — causality-aware rename-repair (sheets + tables + columns)
status: SHIPPED 2026-05-20
date: 2026-05-20
predecessor: docs/phase5/d-1-exit-packet.md (D-1 SHIPPED 2026-05-20 at HEAD 6289c4f3d4a)
audit_transcripts: docs/audits/2026-05-20-phase-5-3-step-{1,2,3,4,5,5b,5c}-{codex,opus,opus-a,opus-b,consolidated}.md (20 files)
---

# Phase 5.3 — Conflict resolution semantics — EXIT PACKET

## Status

**SHIPPED.** All 6 steps + 12 per-step / sub-cycle audit cycles + 1 full-arc megaudit closed.

- **Final HEAD:** `24e9a775c98` on `feat/quantbook-engine` (5c audit closure; predecessors: `96caf84a1af` 5c ship → `2d908cce229` 5b audit closure → `815ecf0589e` 5b ship → `524615b7418` 5a → `6752ca2545c` step 4 closure → previous Phase 5.3 steps 1-4 chain).
- **Workspace tests:** 4361 passing / 0 failed (+70 net from pre-5.3 baseline of 4291) with `--test-threads=1`.
- **fmt + clippy:** clean workspace-wide (`-D warnings` passes).
- **Audit cycles:** 14 total (4 per-step audits at steps 1-4 + 1 full-arc megaudit at step 5 + 2 per-ship audits at sub-cycles 5b + 5c + 7 audit-closure commits) — **14/14 caught real bugs**. 7 consecutive divergent-HIGH cycles where both auditors converged on the same HIGH.

## What 5.3 delivered

**Goal:** close the D-3 V1 limitation (concurrent rename + merge produces `#NAME?`). Pre-5.3, when peer A renames sheet `S → S2` while peer B concurrently writes `=S!A1`, the post-merge formula references a sheet name that no longer exists → `BindError::UnknownSheet` → `Value::Error(ErrorValue::Name)` at recompute time.

**Solution:** caller-driven post-merge **rename-repair pass** that rewrites formula text from historic to current canonical names. Extended across all three rename surfaces (sheet, table, column) with a safety guard against cascade / resurrection corruption, plus a production-wiring wrapper (`CollabSession::rebuild_workbook`) that chains replay + all three repair passes in the correct order.

```rust
// Production-wiring API (Phase 5.3 step 5b):
pub fn rebuild_workbook(&self, registry: &FunctionRegistry)
    -> Result<(Workbook, SyncReport), CollabSessionError>
{
    let mut wb = Workbook::new();
    if self.log.is_empty() { return Ok((wb, SyncReport::default())); }
    let ops_replayed = replay_into(&self.log, &mut wb, registry)?;
    let sheet_repair = repair_sheet_rename_chain(&mut wb, &self.log)?;
    let table_repair = repair_table_rename_chain(&mut wb, &self.log)?;
    let column_repair = repair_column_rename_chain(&mut wb, &self.log)?;
    Ok((wb, SyncReport { ops_replayed, sheet_repair, table_repair, column_repair }))
}
```

## Architecture at a glance

| Layer | Function | Location | Role |
|---|---|---|---|
| Replay handler | `apply_rename_sheet` | `ql_oplog::replay` (replay.rs:486) | Advisory-skip on missing source; case-only renames apply via display equality |
| Replay handler | `apply_rename_table` | `ql_oplog::replay` (replay.rs:740) | Advisory-skip on missing source; hard-reject on cross-source target collision (V1 limitation) |
| Replay handler | `apply_rename_column` | `ql_oplog::replay` (replay.rs:920) | Advisory-skip on missing source (table OR column); hard-reject on cross-source target collision |
| Repair pass | `repair_sheet_rename_chain` | `ql_collab::repair` (repair.rs:184) | Walks log → chain map → rewrites formula text via `ql_formula_syntax::rewrite_sheet_name_in_expr` |
| Repair pass | `repair_table_rename_chain` | `ql_collab::repair` (repair.rs:411) | Same for tables via `ql_formula_syntax::rewrite_table_ref` |
| Repair pass | `repair_column_rename_chain` | `ql_collab::repair` (repair.rs:703) | Same for columns; rules keyed by `(resolved_table_canonical, col_canonical)` — RESOLVES table-rename chain first (step 5c audit closure) |
| Convenience wrapper | `CollabSession::rebuild_workbook` | `ql_collab::session` (session.rs:386) | Atomic `replay → sheet → table → column` chain; constructs fresh `Workbook::new()` internally |

## Conflict resolution semantics — V1 truth table

(See `crdt-data-model.md` § "Conflict resolution semantics" for the canonical version. Key rows:)

| Op-pair | V1 behavior |
|---|---|
| `PutValue × PutValue` same address | Last-in-causal-order wins |
| `PutFormula × PutFormula` same address | Last-in-causal-order wins |
| `PutValue × PutFormula` same address | Last-in-causal-order wins; formula+value coexist via cell-cascade |
| `SetName × SetName` same name | Last-in-causal-order wins |
| `AddSheet × AddSheet` same name | Both succeed; second auto-renames `S → S(2)` (D-2) |
| `RenameSheet × concurrent edit on sheet` | **✅ step 3 + 5b**: post-merge `repair_sheet_rename_chain` rewrites formula text; recompute resolves correctly |
| `RenameSheet × RenameSheet` same id, different targets | **✅ step 2**: last-in-causal-order wins; second rename applies to current sheet name |
| `RenameSheet × RenameSheet` different sheets, same target | **✅ step 2 audit closure**: D-2-style auto-disambig (target → target(2)) |
| `RenameTable × concurrent edit on table` | **✅ step 4 + 5b**: post-merge `repair_table_rename_chain` rewrites formula text |
| `RenameTable × RenameTable` cross-source same target | **HARD-FAIL** at replay (V1 LIM — step 4 audit revert; auto-disambig was unsound without API change) |
| `RenameColumn × concurrent edit on column` | **✅ step 5c + 5c audit closure**: post-merge `repair_column_rename_chain` rewrites formula text |
| `RenameColumn × RenameColumn` cross-source same target | **HARD-FAIL** at replay (V1 LIM — same root cause as table) |
| `RenameTable × RenameColumn` cross-kind | **✅ step 5c audit closure**: replay advisory-skips on missing-table; column repair resolves table-rename chain |
| `DropTable × RenameTable` concurrent | **✅ step 5a audit closure**: both orderings now converge to "table absent" (DropTable advisory-skips on missing source) |
| `DropTable × concurrent edit referencing T` | `#NAME?` per D-3 (no repair planned — drop is destructive) |

## Step-by-step commit map

| Step | Commit | Audit closure | What |
|---|---|---|---|
| 1 — Conflict matrix probes | `5595d8dcfb0` + `a6babc65b51` (fmt) | `03408fa17bd` | 9-test conflict matrix probe; discovered peer-id stability invariant for CRDT determinism |
| 2 — Concurrent RenameSheet replay fix | `1ed2bbba78a` | `f426683fee0` | Replay case 2+3 unification; D-2 auto-disambig for cross-sheet target collision; deprecated `SheetRenameNameMismatch` |
| 3 (CORE) — Rename-repair pass (sheets) | `e76a9ce5499` + lockfile `4222d11fe7b` | `6bb76e3ade3` | NEW `ql_collab::repair_sheet_rename_chain` + `SheetRepairReport` + `SheetRewriteSummary` + `SheetAmbiguousSkip` + safety guard (types renamed from `RepairReport` / `AmbiguousSkip` in post-5.3 Tier H8 closure) |
| 4 — Extend to tables/columns | `7126eb44396` | `6752ca2545c` | `apply_rename_table` + `apply_rename_column` advisory-skip; NEW `repair_table_rename_chain` + `TableRepairReport`; auto-disambig revert closure |
| 5 (megaudit) | 3-way Codex + Opus-A + Opus-B | step 5a-5d (4 sub-cycles) | 9 HIGHs surfaced; 4 sub-cycles of closure work |
| 5a — Trivial closures + DropTable advisory-skip | `524615b7418` | (closure cycle) | Batched 7 findings: DropTable + atomicity docstring + 8 doc / test prose cleanups |
| 5b — Production wiring (`rebuild_workbook`) | `815ecf0589e` → `2d908cce229` (audit closure) | (per-ship audit) | NEW `CollabSession::rebuild_workbook` + `SyncReport` + `CollabSessionError::Replay` variant; API reshape post-audit (closures HIGH-2 + HIGH-3 from 5b audit) |
| 5c — Column repair pass | `96caf84a1af` → `24e9a775c98` (audit closure) | (per-ship audit) | NEW `repair_column_rename_chain` + `ColumnRepairReport`; cross-kind table×column closure (HIGH-1 + M1 from 5c audit) |
| 6 — Exit packet | (this commit) | — | Surface refresh + V2 backlog Tier H + memory handoff |

## What 5.3 enables

1. **Concurrent sheet renames + writes** resolve correctly post-merge (D-3 V1 limitation closed for sheets — step 3).
2. **Concurrent table renames + table-ref formulas** resolve (step 4 + 5b production wiring).
3. **Concurrent column renames + column-ref formulas** resolve (step 5c).
4. **Cross-kind table×column rename interactions** rebuild cleanly (step 5c audit closure: replay advisory-skips + column repair resolves table-rename chain).
5. **DropTable × concurrent RenameTable** converges to "table absent" in both causal orderings (step 5a closure: DropTable now advisory-skips on missing source).
6. **CollabSession::rebuild_workbook** is the single-call production entry: replay → sheet repair → table repair → column repair → caller calls `WorkbookRuntime::recompute_all`.
7. **All three repair passes have safety guards** against cascade-corruption + reused-name resurrection (step 3 audit closure pattern, extended to tables + columns).
8. **`SyncReport` provides one-line diagnostic surface** via `Display` impl: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`.
9. **`#[non_exhaustive]` + `#[must_use]`** on `SyncReport` + `rebuild_workbook` ensure ABI-safe additions in Phase 5c+ and no silent diagnostic-surface drops.

## Audit-discipline metrics

| Metric | Value |
|---|---|
| Cycles run | 14 (4 per-step ship + closure cycles for steps 1-4, plus megaudit, plus 5b + 5c per-ship audits) |
| Cycles that caught real bugs | 14/14 (100%) |
| Divergent-HIGH cycles | 7 consecutive (steps 1, 2, 3, 4, megaudit, 5b, 5c) |
| HIGH findings caught + closed | ~16 (1-2 per per-step audit + 6-9 megaudit + 4 5b + 2 5c) |
| MEDIUM findings caught + closed | ~30 across all cycles |
| Sub-cycle revert closures | 1 (step 4 auto-disambig revert; step 5c HIGH was code-fix not revert) |
| Audit transcripts saved | 20 (`docs/audits/2026-05-20-phase-5-3-*.md`) |

**Audit-discipline observation**: the 3-way megaudit format (Codex tactical + Opus-A adversarial empirical + Opus-B doc completeness) caught 9 HIGHs that the per-step audits had missed at steps 1-4 — specifically the cross-step + cross-handler invariants (production wiring missing, replay atomicity, column repair missing) and doc-completeness gaps (IDE contract, V1 limits durable home, stale forward-tense surfaces). The per-step audits at steps 5b + 5c then caught a NEW HIGH each (5b: double-call corruption + empty-log fast path; 5c: cross-kind table×column interaction). Both lanes (tactical Codex + holistic Opus) continued to find different bugs in each cycle. **The parallel 2-way + 3-way audit pattern is structurally load-bearing for engine work at this complexity.**

## Test count evolution

| Milestone | Tests |
|---|---|
| Pre-5.3 (D-1 exit) | 4291 |
| Step 1 ship + audit closure | 4300 (+9) |
| Step 2 ship + audit closure | 4307 (+7) |
| Step 3 ship + audit closure | 4320 (+13) |
| Step 4 ship + audit closure | 4334 (+14) |
| Step 5a closure | 4338 (+4) |
| Step 5b ship | 4343 (+5) |
| Step 5b audit closure | 4346 (+3) |
| Step 5c ship | 4354 (+8) |
| Step 5c audit closure | 4361 (+7) |
| **Step 6 exit packet** | **4361** (docs only) |

**+70 net tests across the 5.3 arc.**

## V1 limitations (audit-locked, tracked in `PHASE-4-V2-BACKLOG.md` Tier H)

These were surfaced by the step 5 megaudit + per-step audits, deemed legitimate V1 trade-offs, and deferred to V2 (except items marked ✅ — closed post-5.3 as pre-IDE-binding cleanup):

1. **Cross-source target collision hard-fails (tables, columns)** — peer A `T1→X` + peer B `T2→X` errors `TableCreateRejected`. Step 4 audit revert closed an unsound auto-disambig path; V2 closure requires API change (synthesized correction op at replay).
2. **Concurrent table-rename × column-rename** loses column-rename intent — `apply_rename_column` advisory-skips when its wire table is missing (step 5c HIGH-1 closure). V2 closure: causality-aware tracking via Loro op-ids.
3. **DropTable + concurrent RenameTable** loses rename intent — both orderings converge to "table absent" (step 5a closure). V2: same as #2.
4. **Case-only rename policy inconsistency** — sheet applies, table no-ops, column rejects. 3-way asymmetry; V2 alignment.
5. **Concurrent-rename intermediate names** preserved via the `old_name` field of each rename op (step 3 docstring; step 5 megaudit Opus-A empirically validated). Edge cases where this fails require causality-aware tracking (V2).
6. **Cross-sheet historic-name ambiguity** when neither historic is currently held — substitution-order consumption picks winner (step 5 megaudit Opus-A finding). Rare; V2 closure unclear.
7. **`replay_into` non-atomic on Err** — half-merged workbook state. Caller MUST discard (docstring contract; step 5 megaudit Opus-A HIGH; `rebuild_workbook` wraps so callers don't see partial state).
8. **Mismatched workbook ↔ log silent corruption** — `repair_sheet_rename_chain` trusts post-replay workbook. `rebuild_workbook` eliminates this for production callers (no longer takes workbook by mut-ref). Raw callers' problem (step 5b Opus HIGH-latent).
9. ~~**Helper duplication**~~ — ✅ CLOSED 2026-05-20 in post-5.3 V2 Tier H1 commit `8085f42bf5b`. Promoted to single public `ql_formula_syntax::rewrite_formula_text(text, NameRewrite)` helper; 6 call sites consolidated.
10. **Production wiring missing for IDE** — `rebuild_workbook` ships as the API entry point; Phase 5.7 IDE binding will actually call it (step 5b Opus HIGH-1 framing closure). *(Status update 2026-05-22: Phase 5.7 V1 SHIPPED 2026-05-22 WITHOUT wiring `rebuild_workbook` — V1 was minimum-surface (`CollabSession::new` / `fromSnapshot` / `appendPutValue` / `exportBytes` / `mergeBytes` / observability accessors only). `rebuild_workbook` requires `FunctionRegistry` binding, deferred to Phase 5.7 V3 (cell-grid UI + persistence). The user-visible D-3 closure now lands at V3 rather than V1. See `docs/PHASE-4-V2-BACKLOG.md` H9 + `docs/phase5/5-7-v1-exit-packet.md`.)*
11. **Whitespace canonicalization side effect** — repair-touched formulas get `parse → print`-normalized whitespace + operator spacing + function-name case (step 5 megaudit Opus-A Scenario F). V2: surgical diff-only rewrite.
12. ~~**API naming asymmetry**~~ — ✅ CLOSED 2026-05-20 in post-5.3 V2 Tier H8 commit `7eded6214dd`. Renamed `RepairReport` → `SheetRepairReport` + `AmbiguousSkip` → `SheetAmbiguousSkip` for symmetry with table/column variants. Pre-IDE-binding so non-breaking.
13. **`lookup_column` docstring** said "uppercases" but code lowercases — step 4 Opus L-3 fixed in step 5a.

## Cross-references

- Plan file: `quantbook-engine/.plans/_active.md` (archived to `_archive/` as part of this commit)
- Architecture: `docs/architecture/crdt-data-model.md` § "Conflict resolution semantics"
- IDE contract: `docs/architecture/ide-consumer-contract.md` § "Post-merge rename-repair"
- Master plan: `docs/MASTER-PLAN.md` § Phase 5.3
- V1 exit packet (Phase 5 V1 surface): `docs/phase5/v1-exit-packet.md`
- Entry plan: `docs/phase5/entry-plan.md`
- V2 backlog: `docs/PHASE-4-V2-BACKLOG.md` Tier H
- Known gaps: `docs/known-gaps.md` GAP-C-02 (✅ V1 closure marker)
- Per-step audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-{1,2,3,4}-{codex,opus,consolidated}.md` (12 files)
- Step 5 megaudit transcripts: `docs/audits/2026-05-20-phase-5-3-step-5-{codex,opus-a,opus-b,consolidated}.md` (4 files)
- Sub-cycle audit transcripts: `docs/audits/2026-05-20-phase-5-3-step-5{b,c}-{codex,opus}.md` (4 files)

## What's next for Phase 5

Phase 5 still has 3 sub-items post-5.3. **Recommended priority order** (unchanged from D-1 exit packet recommendation; 5.3 didn't shift priorities):

1. **5.5 V2 V2/V3** Production transport (WebSocket + reconnect + offline sync + auto-flush on append). Largest remaining scope (1-2 weeks). Unblocks the IDE.
2. **5.7** IDE vertical slice (two-window editing demo with multi-peer presence + format collaboration + post-merge rename-repair). **Depends on D-1 + 5.3 + 5.5 V2 V2** — all three are now done EXCEPT 5.5. **At this point, the user-visible D-3 closure (concurrent rename + edit) requires step 7 to wire `rebuild_workbook` into the IDE's merge-then-recompute path** — without that, end-users still see `#NAME?` (step 5b Opus HIGH-1 rhetorical framing closure).
3. **5.8** Phase 5 megaudit (separate from D-1 + 5.3 step 5 megaudits). 4-6 days; randomized peer-merge tests + transport failure modes. Run AFTER 5.3 + 5.5 stabilize.

**Recommended trade-off framing:** Phase 5.3 closes the most user-visible correctness gap (concurrent rename + merge across all three rename surfaces) in-principle. Phase 5.7 closes the gap in-practice (real users hitting the IDE). 5.5 unblocks 5.7. 5.8 is the final megaudit before Phase 5 graduation.

The 3 remaining items are independent (in priority); the natural sequence is 5.5 → 5.7 → 5.8. **Pre-5.7 prep already done post-5.3** (commits `7eded6214dd` + `8085f42bf5b`): V2 Tier H8 (API naming symmetry — `RepairReport` → `SheetRepairReport`) + V2 Tier H1 (helper unification — 6 sites → 1 `rewrite_formula_text` helper). Both were "last chance before IDE binding consumes the API"; closed before they could ossify.
