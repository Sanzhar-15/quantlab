# Phase 5.7 V3.6 phase-termination -- 3-lane megaudit synthesis + closures

**Date**: 2026-05-26
**Engine HEAD entering**: `51149253383` (Opus Lane B audit transcript)
**Engine HEAD exiting**: `<this commit>` (CONVERGENT-HIGH-1 closure + MED/LOW sweeps)
**IDE HEAD entering**: `aa9d0448bb1`
**IDE HEAD exiting**: `<companion IDE commit>` (+2 mocha tests for cells-reappear contract)
**Lanes**: Codex Lane A (`c1da1a92bd6`) + Opus Lane B (`51149253383`) + claude-self Lane C (synthesis here)

## Convergence summary

| Severity | Lane A (Codex) | Lane B (Opus) | Lane C (claude) | Closed in cycle |
|---|---|---|---|---|
| HIGH | CODEX-PT-A1 | OPUS-PT-B1 | (convergent confirmed pre-Lane-B) | ✅ |
| MED  | none unique | B2 (Arc::make_mut inline), B3 (5-site contract drift), B4 (engine test gap), B5 (IDE test gap) | (covered by Opus-MED set) | ✅ all 4 |
| LOW  | F3 (current_work.md tail) | B6 (current_work.md tail; convergent), B7 (cycle-budget self-contradiction), B8 (producer/replay asymmetry), B9 (removedCells unused), B10 (no IDE delta consumer) | (covered) | 2 closed; 3 deferred |
| INFO | A2-A6, B-INFO, C-INFO, D-INFO, E-INFO, F-INFO | B11-B15 | (all cross-confirmed positive) | acknowledged |

**HIGH closure status**: CONVERGENT-HIGH-1 CLOSED in this commit.  V3.6 phase termination NOW clean.

## CONVERGENT-HIGH-1 -- RestoreSheet preserved-cells closure

### Both lanes' framing

- **CODEX-PT-A1** (Lane A): "RestoreSheet full-rebuild path returns a restored sheet without its preserved cells.  D8 correctly restores the sheet in the rebuilt `Workbook`, but the IDE-facing full snapshot still serializes cells from `CollabSession.last_snapshot`, not by enumerating the rebuilt `Workbook`.  `CacheEffect::RemoveSheet` prunes all cached cells on the sheet, and `CacheEffect::RestoreSheet` only removes the tombstone."
- **OPUS-PT-B1** (Lane B): "RestoreSheet does NOT recover pre-tombstone cells through napi `workbookSnapshot`.  The `CacheEffect::RemoveSheet` arm drops cells from `CollabSession.last_snapshot`; `CacheEffect::RestoreSheet` does NOT re-add them; `rebuild_snapshot_cache` also does NOT re-add them: it walks the op log in order; `Op::PutValue` at index `i` lands in the fresh cache, then `Op::RemoveSheet` at index `j > i` drops it, then `Op::RestoreSheet` at index `k > j` only un-flags the tombstone.  **The cache walker's drop-then-restore semantic is a one-way trip.**"

Both lanes wrote independent probe tests that failed as predicted.  Lane A's transcript at `2026-05-26-phase-5-7-v3-6-0-X-phase-termination-codex.md`; Lane B's at `...-opus.md`.

### Six contract-violating documentation sites

Pre-closure, the following sites promised "cells reappear" but the implementation did not deliver:

1. `crates/ql-oplog/src/op.rs:194-201` (Op::RestoreSheet wire docstring "Cell preservation")
2. `crates/ql-bindings-node/src/lib.rs:1442-1445` (napi `restore_sheet` docstring)
3. `crates/ql-bindings-node/src/lib.rs:1457-1465` (napi `restore_sheet` "Cache + delta interaction" docstring)
4. `extensions/quantlab/src/quantbook/types.ts:544-547` (IDE consumer JSDoc for `restoreSheet`)
5. `extensions/quantlab/src/quantbook/types.ts:558-560` ("the IDE should call `workbookSnapshot()` to get the un-tombstoned sheet's cells back")
6. `docs/architecture/ide-consumer-contract.md § 4.1.z6 V3.6.0.10` line 2135

Post-closure, the implementation matches the contract.  No docstring text changed.

### Chosen fix: cache mirrors V3.5.0.3b storage-preservation discipline

Lane A enumerated three fix options:
1. Iterate cells from the rebuilt Workbook for restored sheets.
2. Two-pass walk to detect tombstone-then-restore sequences.
3. Add a `recover_cells_from_workbook` step in `CacheEffect::RestoreSheet`.

Lane B enumerated three options similar in shape (A: source from Workbook; B: two-pass; C: rehydrate on restore via column-store iteration).

**Chosen approach**: do NOT prune cells on `Op::RemoveSheet` apply.  The cache mirrors the V3.5.0.3b Workbook storage-preservation discipline -- cells are preserved through the tombstone window; only the tombstone flag is set.  On `Op::RestoreSheet`, the tombstone is cleared and the preserved cells immediately resurface.  Cells written DURING the tombstone window (those still gated at `apply_cache_effect`'s tombstone-check) are silently dropped, matching the existing V3.5.0.X contract.

Code change at `crates/ql-collab/src/session.rs::apply_cache_effect::CacheEffect::RemoveSheet`:

```rust
// BEFORE (V3.6.0.X audit-of-D3 CONVERGENT-MED-2):
CacheEffect::RemoveSheet { id } => {
    buckets.tombstones.insert(id);
    buckets.snapshot.retain(|(sheet, _, _), _| *sheet != id);
    buckets.cell_op_index.retain(|(sheet, _, _), _| *sheet != id);
}

// AFTER (V3.6.0.X phase-termination CONVERGENT-HIGH-1):
CacheEffect::RemoveSheet { id } => {
    buckets.tombstones.insert(id);
    // Cells + index entries are preserved -- they mirror Workbook
    // V3.5.0.3b storage-preservation discipline.  D8 RestoreSheet
    // now resurfaces them automatically.
}
```

### Companion fixes required by the closure

1. **`crates/ql-collab/src/session.rs::list_sheets_from_cache`**: added a `removed_sheets.contains(sheet)` filter.  Pre-closure the cache pruned at RemoveSheet so the enumerate-from-cache approach incidentally hid tombstoned sheets via emptiness; post-closure we filter explicitly.  Mirrors the `workbook_snapshot` `is_sheet_removed` filter discipline.

2. **`crates/ql-bindings-node/src/lib.rs::workbook_snapshot_delta`**: added a `removed_sheet_ids` filter in the `changed_cells` build loop.  Pre-closure the cache prune incidentally suppressed `changedCells` entries for a cell-write + later RemoveSheet in the same delta window; post-closure we filter explicitly.  Matches Lane A's CODEX-PT-A5-INFO observation about the "happy coincidence" the prune provided.

3. **Existing test rewrite**: `v3_6_0_x_audit_of_d3_cell_op_index_pruned_on_remove_sheet` (which V3.6.0.X audit-of-D3 added to pin the "ghost entry prune" semantic) is updated to assert the NEW invariant -- entries PRESERVED.  The original "ghost hygiene" concern is OBSOLETED by V3.6.0.10 D8 RestoreSheet (entries are not ghosts; they're real pointers to ops the rebuild path must respect).  Test docstring extended to explain the supersession.

4. **Existing test rewrite**: `valid_add_remove_sheet_then_cell_op_silent_dropped` is updated.  Pre-closure asserted `snapshot_cells(0).len() == 0` immediately post-RemoveSheet; post-closure asserts `== 1` (cells preserved) + adds an assert that the existing pre-tombstone cell count is unchanged after NEW silent-dropped writes during the tombstone window.

### New tests

Engine (ql-collab; +4 over the 154 baseline → 158/158):
- `v3_6_0_x_phase_termination_codex_pt_a1_restore_sheet_resurfaces_preserved_cells_in_session_snapshot_cache` (flagship; matches Codex Probe + Opus Probe 1).
- `v3_6_0_x_phase_termination_rebuild_snapshot_cache_after_remove_then_restore_includes_cells` (matches Opus Probe 5 -- rebuild path / `from_snapshot`).
- `v3_6_0_x_phase_termination_tombstoned_sheet_cells_remain_hidden_until_restore` (visibility invariant: cells preserved in cache but hidden from consumers via `is_sheet_removed` filter; NEW writes during tombstone window silent-dropped).
- `v3_6_0_x_phase_termination_post_restore_writes_stack_atop_preserved_cells` (preserved cells + post-restore writes coexist).

IDE mocha (+2 over the 413 baseline → 415/415):
- `restoreSheet resurfaces preserved pre-tombstone cells (V3.6.0.X phase-termination CONVERGENT-HIGH-1 closure)` (end-to-end through napi `workbookSnapshot`; pins value preservation).
- `restoreSheet + new write: preserved cells AND new writes coexist (post-V3.6.0.X-phase-termination)` (stacking semantic).

## MED closures

### OPUS-PT-B2 -- inline Arc::make_mut comment drift

Site: `crates/ql-bindings-node/src/lib.rs:2646-2652` (post-edit shifted).

V3.6.0.8.4 OPUS-MED-3 closure swept 4 doc sites (large docstring at `lib.rs:2452-2458`); the inline comment at `:2646-2652` was missed.  Code is `(*cached_arc).clone()` always-clone (correct; R-V3.6-17 measurement showed 692 μs at 100k cells, well under the 20 ms threshold); inline comment now matches.

### OPUS-PT-B3 -- 5-site contract docstring drift

The 6 documentation sites listed under the HIGH section all PROMISED "cells reappear" and pre-closure the implementation contradicted them.  POST-CLOSURE the implementation matches the contract -- no docstring edits needed.  This MED auto-closes via the HIGH closure.

### OPUS-PT-B4 -- engine test gap

The 4 new ql-collab tests (above) close the gap.  154 → 158.

### OPUS-PT-B5 -- IDE mocha test gap

The 2 new IDE mocha tests close the gap.  413 → 415.

Note: a pre-existing type/runtime drift on `CellValueJson` was surfaced as a side-effect of writing these tests.  The napi runtime emits `{ kind, number?, boolean?, text?, error? }` (matching the `CellValueJson` interface in `types.ts`).  Some existing tests in the file use a buildHtml-input form `{ kind, value }` (matching `QuantbookCellValue` discriminated union).  The new tests cast through `unknown` to assert against the napi runtime shape.  This is not a new bug -- both shapes are documented and used in distinct contexts (`QuantbookCellSnapshot.entries[*].value` vs `WorkbookSnapshotJson.sheets[*].cells[*].value`) -- but a future cleanup could unify or rename to make the distinction more visible.  Filed as V3.6.1+ followup.

## LOW closures

### CODEX-PT-F3 + OPUS-PT-B6 -- current_work.md tail drift

Convergent finding.  Memory file at `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` has head section (lines 1-19) updated correctly at each session checkpoint, but tail sections (next-recommended-sub-step + first-three-commands + cycle-budget) carry stale text from prior cycles.  Swept in this commit.

### OPUS-PT-B7 -- cycle-budget self-contradiction

Same memory file says "Next session MUST start at 0 cycles" but the current session is already past that point with explicit user overrides at cycle 3 + cycle 4.  The "MUST" was the prior session's handoff guidance and is no longer applicable.  Swept in this commit.

## Deferred to V3.6.1+ / V3.7+ (per Opus recommendation)

### OPUS-PT-B8 -- producer/replay asymmetry on `restoreSheet` napi

`crates/ql-bindings-node/src/lib.rs::restore_sheet` rejects out-of-range `sheet_id` as `[bad_argument]`, while `Op::RestoreSheet` replay is permissive (silently no-ops out-of-range ids per CRDT idempotency).  Asymmetry documented at `op.rs:214`; producer-side guard is intentional ("id validation" guards against the local caller emitting an op the replay path would silently drop).  No behavior change needed; surfaced as a design observation.  Same pattern applies to `delete_sheet`.

### OPUS-PT-B9 -- `WorkbookSnapshotDeltaJson.removedCells` unused

Field is always empty (documented as "V3.7+ feature" at `lib.rs:2466-2468`).  TS consumer would compile against the field and silently get an empty array.  V3.7+ task: either populate the field or remove (breaking).  No in-cycle change.

### OPUS-PT-B10 -- no IDE `workbookSnapshotDelta` consumer

`cellGridPanel.render()` calls `workbookSnapshot()` unconditionally; the napi delta surface is present + tested + benchmarked but unused by production IDE code.  D6 perf shipped at engine, unrealized at consumer.  V3.6.1+ task to wire `workbookSnapshotDelta` into `cellGridPanel.render()` with `lastSeenVersion` token round-trip.  No in-cycle change.

## Risk register update

Added **R-V3.6-19** to the V3.6 risk register (per Opus recommendation):

> **R-V3.6-19 (CLOSED-AT-V3.6.0.X-phase-termination) RestoreSheet napi cell-recovery gap.**  DISCOVERED at V3.6.0.X phase-termination 3-lane megaudit (Codex CODEX-PT-A1 + Opus OPUS-PT-B1 convergent).  Pre-closure `CacheEffect::RemoveSheet` pruned cells from `CollabSession.last_snapshot`; `CacheEffect::RestoreSheet` did not re-add them; `rebuild_snapshot_cache` also did not re-add them (drop-then-restore is one-way through the walker).  Six independent documentation sites promised "cells reappear via workbookSnapshot full rebuild"; all six were contract-vs-implementation drift.  CLOSED: cache walker no longer prunes on RemoveSheet (mirrors V3.5.0.3b Workbook storage-preservation discipline); pre-tombstone cells preserved through tombstone window + resurfaced automatically on RestoreSheet.  Visibility handled by `workbook_snapshot`'s `is_sheet_removed` filter + new `removed_sheet_ids` filter in `workbook_snapshot_delta`'s `changedCells` build + new `removed_sheets.contains(sheet)` filter in `list_sheets_from_cache`.

## Tests baseline at exit

- ql-collab **158/158** (+4 over V3.6.0.X audit entry 154; +2 existing tests rewritten + 4 new)
- ql-oplog **67/67** (unchanged)
- ql-collab-ws **42/42** (unchanged)
- IDE mocha **415/415** (+2 over V3.6.0.X audit entry 413)
- engine workspace release build clean

## Verdict

**V3.6 PHASE TERMINATION CLEAN.**

All HIGH closed.  Engine + IDE regression coverage added.  Per-feature audits + phase-termination 3-lane megaudit all green.  D7 (#REF! substitution at V3.6.0.9) remains the only V3.6 D-decision unshipped; it is conditional pending user signal and not blocking phase exit.

Lane A transcript: `docs/audits/2026-05-26-phase-5-7-v3-6-0-X-phase-termination-codex.md`.
Lane B transcript: `docs/audits/2026-05-26-phase-5-7-v3-6-0-X-phase-termination-opus.md`.
Lane C synthesis + closures (this document): `docs/audits/2026-05-26-phase-5-7-v3-6-0-X-phase-termination-closures.md`.
