---
title: Phase 5.3 step 5c audit — Opus subagent verdict (holistic + adversarial + e2e lane)
date: 2026-05-20
audit_target: commit `96caf84a1af` (5c ship)
auditor: Opus subagent (independent of engineer; parallel with Codex)
tokens_used: 138581
tool_uses: 70
duration_ms: 1428769
verdict: PASS-WITH-FINDINGS (1 HIGH + 4 MEDIUM + 3 LOW)
lane: holistic + adversarial probe synthesis + end-to-end verification
---

# Phase 5.3 step 5c — Opus auditor verdict (holistic + adversarial lane)

## Executive summary

**VERDICT: PASS-WITH-FINDINGS**

Phase 5.3 step 5c ships a coherent column-rename repair pass that genuinely closes the simple case targeted by step 5 megaudit Opus-A V1 LIM #3: concurrent **column** rename + concurrent formula referencing the old column name resolves correctly post-`rebuild_workbook` + `recompute_all` (empirically verified end-to-end via my probe `pe2e1` recomputing `Tbl[A]+1` to `Number(43.0)`). Symmetry with sheet+table repair is good, safety guard is correctly applied per-table, BatchCommit traversal mirrors the prior passes, and 3-peer concurrent column renames compose correctly.

**However**, my empirical probes uncovered one HIGH that 5c does NOT close, two MEDIUM gaps in test coverage, two MEDIUM API hygiene concerns, and confirmed step 5c introduces 2 new clippy warnings. The most consequential finding: **concurrent table-rename × column-rename interleaving hard-fails at `replay_into`** with `TableNotFound { index: 3, name: "Tbl" }`, propagating through `rebuild_workbook`, **before** the column repair pass even gets to run. The Codex parallel lane independently discovered this and verified the failure empirically.

The step 5c column-repair code itself is correct for the cases it can see; the failure is at a different layer (replay's `apply_rename_column` hard-fails on missing table while `apply_rename_table` advisory-skips — an asymmetry from step 4). This is a legitimate V1 limitation to surface in V2 backlog / known-gaps, but it is **not currently documented** and the 5c doc explicitly downplays it as "adversarial cross-peer interleavings" when my probe shows it's a 2-peer normal concurrent edit.

5c is a clean ship of its in-scope function; **the scope itself was incomplete** by not addressing replay-layer interactions.

---

## Findings

### HIGH

#### H1. Concurrent table-rename × column-rename hard-fails at `replay_into` — production wrapper inherits the failure

**File:line**: `crates/ql-oplog/src/replay.rs:920-996` (`apply_rename_column`) + `crates/ql-collab/src/session.rs:457-478` (`rebuild_workbook` propagates).

**Reproducer (confirmed):**
- Setup: AddSheet S, CreateTable Tbl { col A }.
- Peer A appends: `RenameTable { Tbl → Sales }`.
- Peer B (concurrent): `RenameColumn { table: "Tbl", A → AA }`.
- `session_a.merge_bytes(peer_b_bytes)`; then `session_a.rebuild_workbook(&reg)`
- → `Err(Replay(TableNotFound { index: 3, name: "Tbl" }))`.

**Root cause**: `apply_rename_column` at `replay.rs:927-934` hard-fails when the table was renamed by a causally-prior peer. Compare with `apply_rename_table` at `replay.rs:847-860` which advisory-skips in the analogous "source-missing" case (step 4 audit closure for table rename). The asymmetry is **unintended** — step 4 closed the table version but didn't extend the same fix to columns.

**Impact**: Every cross-peer rename of any column **on a table that another peer concurrently renamed** breaks the entire workbook merge. This is V1 LIM #1 (replay non-atomic on cross-source collision) extended to a NEW interaction the step 5 audit did not enumerate. NOT a "column repair pass" gap — even ADDING repair logic doesn't help because replay fails BEFORE repair gets to run.

**Proposed closure**:
1. **Cheapest**: Mirror `apply_rename_table`'s advisory-skip pattern in `apply_rename_column`: if `tables_mut().get_mut(&table_canonical).is_none()`, return `Ok(())` (advisory-skip the column rename since the table was renamed concurrently — V1 limitation). Add a regression test.
2. **Better** (V2): Causality-aware column op that re-targets to the current table canonical after `RenameTable` events.

---

### MEDIUM

#### M1. Silent rule-drop when column rename op's `table` field is stale relative to table's post-replay canonical

**File:line**: `crates/ql-collab/src/repair.rs:849-884` (`collect_column_renames`) + `repair.rs:723-732` (current_columns_per_table snapshot).

**Reproducer**: log `[AddSheet, CreateTable(Tbl), RenameColumn(table:"Tbl", A→AA), RenameTable(Tbl→Sales), PutFormula(Tbl[A]+1)]`. Run sheet+table+column repair in order. Result: formula = `"Sales[A] + 1"` (NOT `"Sales[AA] + 1"`). `col_report.formulas_rewritten == 0`. `col_report.ambiguous_rules_skipped` is EMPTY.

After `repair_table_rename_chain` rewrites `Tbl[A]` → `Sales[A]`, the column-repair pass tries to apply rule keyed by `("TBL", "a") → "AA"`. Since `current_columns_per_table` only has key `"SALES"` (post-replay canonical), the lookup fails and the rule is **silently dropped**. No entry in `ambiguous_rules_skipped` — silent formula corruption with no diagnostic surface.

The docstring at `repair.rs:678-685` acknowledges this as "silently dropped (V1 limitation)" and dismisses it as "adversarial cross-peer interleavings." **My probe shows it's NOT adversarial**: a single log with the natural ordering (col rename → table rename → formula) triggers it. A 2-peer scenario where peer A col-renames then merges peer B's later table-rename is also natural, not adversarial.

**Proposed closure (V1)**:
1. **Minimum**: Re-key column rules through the TABLE rename chain. When `collect_column_renames` records `(table, old_c) → new_c`, also walk the table-rename log and follow the `table` field through `table_canonical → eventual current canonical`. The `historic_by_current` map should be keyed by `(eventual_table_canonical, new_col_canonical)`.
2. **Surface diagnostic**: When a column rule is dropped because the table-canonical doesn't match `current_columns_per_table`, push a record to `ambiguous_rules_skipped` OR a new field (non-breaking via `#[non_exhaustive]`).

#### M2. Test coverage thin for a "HIGH closure" — missing 3 critical regression families

The 8 tests at `repair_columns.rs` are mostly single-writer or simple 2-peer.

**Missing**:
- NO end-to-end recompute test for column repair (regression in `WorkbookRuntime`'s binding would slip through).
- NO 3-peer test in the committed suite.
- NO bidirectional convergence test.
- NO table-rename × column-rename interaction test (this is H1).

**Proposed closure**:
1. Add `crates/ql-exec/tests/phase_5_3_step5c_e2e_column_resolve.rs` (mirror `phase_5_3_step5b_e2e_resolve.rs` shape).
2. Add 3-peer + bidirectional + H1 regression tests.

#### M3. `ColumnAmbiguousSkip::current_holder_col_canonical` is definitionally equal to `historic_canonical` — dead/redundant API field

The "current holder" of `hc` (lowercase canonical) is, by definition, the column whose canonical IS `hc`. Storing both is redundant. The `_display` field IS informationally useful (case-preserved display name).

**Proposed closure**:
1. Drop `current_holder_col_canonical` (redundant). Keep `_display` and `historic_canonical`.
2. `ColumnAmbiguousSkip` is NOT `#[non_exhaustive]` so removing a field later is a breaking change — fix now while still pre-IDE-binding.

#### M4. Naming asymmetry inherited (`RepairReport` vs `TableRepairReport` vs `ColumnRepairReport`) — last chance before 5.3 ships

Step 5b LOW-3 deferred this; 5c continues. After 5.3 lands and is consumed by IDE in 5.7, renaming becomes a breaking change.

**Recommendation**: rename `RepairReport` → `SheetRepairReport` in 5c follow-up OR step 6.

---

### LOW

#### L1. 2 new clippy warnings introduced by 5c

- `repair.rs:149:5` — `doc_overindented_list_items`
- `repair.rs:748:9` — `needless_borrowed_reference`

#### L2. Docstring at `repair.rs:684` overstates op ordering

"Production-side renames always emit the column op AFTER the table rename" — empirically false under CRDT merge. Reframe to "single-writer / linear-history flows always emit table rename before column rename; concurrent multi-peer flows may interleave (V1 LIM, see M1)."

#### L3. Helper duplication count grows 5 → 6 sites

5c added `rewrite_formula_with_column_rename`. The TODO at `repair.rs:410-418` correctly points to V2 unification.

#### L4. Tier H V2 backlog entry STILL missing

Step 5 megaudit H-D2 mandated `PHASE-4-V2-BACKLOG.md` Tier H section MUST happen before `_active.md` archives. Step 6 work.

---

## Production-Wiring Completeness Check

- Non-test callers of `rebuild_workbook`: ZERO.
- 5.3 closure "complete in principle" YES for **simple, single-rename-kind scenarios**. Cross-kind interactions are NOT closed.

---

## Empirical Probes Summary

| Probe | Description | Result |
|------|------|------|
| P1 | Concurrent table-rename + column-rename → `replay_into` | `Err(TableNotFound)` (HIGH H1) |
| P2 | Same via `rebuild_workbook` | `Err(Replay(TableNotFound))` (propagates) |
| P3 | 3-peer (table rename + col rename + formula) | Panic |
| P4 | Reverse causal: col rename → table rename | `Ok` (order-dependent) |
| P5 | Bidirectional convergence (col renames only) | Convergence works |
| P6 | Full chain on complex log (table + col rename) | `Sales[AA] + 1` |
| P7 | Stale-table-name col op | Replay errors |
| P8 | Single-writer col rename + repair | `Sales[AA] + 1` |
| M1 | Col rename → table rename → formula | `Sales[A] + 1` (silent corruption) |
| pe2e1 | E2E recompute: col rename + concurrent formula | `Number(43.0)` |
| pe2e2 | 3-peer concurrent col renames + formula | `Tbl[AA]+Tbl[BB]+Tbl[CC]` |

All probe files cleaned up; nothing left in `crates/*/tests/`.

---

## Recommended Closure Path

**For 5c follow-up (~2h)**:
1. **H1**: Mirror table-rename advisory-skip pattern in `apply_rename_column`. Add regression test.
2. **M1**: Re-key column rules by post-table-rename canonical (walk table rename chain).
3. **L1**: Fix the 2 new clippy warnings.

**For step 6 / megaudit (deferred)**:
4. **M2**: Add 3 missing test families.
5. **M3**: Drop redundant `current_holder_col_canonical` field while still pre-IDE-binding.
6. **M4**: Rename `RepairReport` → `SheetRepairReport`.
7. **L2/L3/L4**: Doc fixes + V2 backlog.

**For Phase 5.7 IDE binding**:
8. Wire `rebuild_workbook` into IDE consumer paths.
