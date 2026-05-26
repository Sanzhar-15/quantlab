# Lane S2 — Tombstone-Leak Hunt
**Audit date**: 2026-05-26  
**Scope**: All callers of `snapshot_cells` / `snapshot_cell` in the quantbook engine + IDE; any cache accessor on `CollabSession` that exposes cell/sheet data without a tombstone filter; liveness of `exportSnapshot` in the IDE.  
**Background**: R-V3.6-19 closure made the cache PRESERVE cells on tombstoned sheets. `snapshot_cells` is intentionally tombstone-AGNOSTIC. Every VISIBILITY consumer must filter. B#1 (commit ff09a5e17a7) fixed `export_snapshot`. This lane hunts for remaining unfiltered consumers.

---

## 1. Consumer Table: `snapshot_cells` / `snapshot_cell` Callers

| Consumer | File : line | Kind | Tombstone filter? | Leaks? |
|---|---|---|---|---|
| `export_snapshot` (napi) | `crates/ql-bindings-node/src/lib.rs:1734` | non-test | YES — `is_sheet_removed_in_cache(sheet)` check (B#1) | NO (fixed) |
| `workbook_snapshot` (napi) | `crates/ql-bindings-node/src/lib.rs:2141` | non-test | YES — `workbook.is_sheet_removed(sheet_id)` skip at lib.rs:2236 gates the `snapshot_cells` call at 2273 | NO |
| `workbook_snapshot_delta` (napi) | `crates/ql-bindings-node/src/lib.rs:2498` | non-test | PARTIAL — `removed_sheet_set` at lib.rs:2708-2715 only covers RemoveSheet ops in the current delta window; cross-window tombstone leak possible (see Finding S2-01 below) | CONDITIONAL HIGH |
| `list_sheets` (napi) | `crates/ql-bindings-node/src/lib.rs:1839` | non-test | YES — delegates to `list_sheets_from_cache()` which filters `removed_sheets` at session.rs:1792 | NO |
| bench `snapshot_equivalent` | `crates/ql-bindings-node/benches/workbook_snapshot.rs:98` | bench-only | YES — `workbook.is_sheet_removed(sheet_id)` at bench:124 | NO (bench only) |
| test helper `capture_full_cache` | `crates/ql-collab/src/session.rs:6773` | test-only | YES — calls `list_sheets_from_cache()` which is filtered; tombstoned sheets never appear in the sheet list | NO (test only) |
| All other `snapshot_cells(sheet)` callers | `crates/ql-collab/src/session.rs:4809..8260` | test-only | N/A — tests deliberately probe tombstone-agnostic semantics (R-V3.6-19 regression tests) | NO (test only) |
| `crates/ql-collab/tests/session_megaaudit_probe.rs:28,32,37` | test-only | N/A — probe the preserve contract | NO (test only) |

---

## 2. Other Cache Accessors That Expose Cell/Sheet Data

| Accessor | File : line | Tombstone-aware? | Notes |
|---|---|---|---|
| `list_sheets_from_cache()` | `session.rs:1780` | YES — filters `self.removed_sheets` | Correct |
| `is_sheet_removed_in_cache(sheet)` | `session.rs:1812` | YES — is the filter itself | Correct |
| `format_table_cache_iter()` | `session.rs:1847` | N/A — format entries are not sheet-keyed; no tombstone semantics apply | OK |
| `cell_op_index_iter()` | `session.rs:1868` | NO — raw index, may contain cells from tombstoned sheets | Test-seam only; not exposed via any napi method; no IDE visibility |
| `sheet_op_index_iter()` | `session.rs:1883` | NO — raw index of RemoveSheet op positions | Test-seam only; not exposed via any napi method; no IDE visibility |
| `last_snapshot_workbook()` | `session.rs:1895` | N/A — returns the cached `Arc<Workbook>` used by delta; the Workbook itself carries tombstone state via `is_sheet_removed` | Accessed only in `workbook_snapshot_delta` under the lock |
| `snapshot_cell(sheet, row, col)` | `session.rs:2125` | NO — O(1) hash lookup, tombstone-agnostic | Called only in `workbook_snapshot_delta` at lib.rs:2729; partially filtered (see Finding S2-01) |

---

## 3. IDE `exportSnapshot` Liveness Check

### Claim being verified
The session doc says "the `exportSnapshot` TS wrapper is legacy/dead" and the live render path migrated to `workbookSnapshot` at V3.5.0.4b.

### Evidence

**TS wrapper definition**: `extensions/quantlab/src/quantbook/session.ts:421` — `exportCellSnapshot()` defined, exported, calls `session.exportSnapshot(sheet)`.

**Live render path** (`cellGridPanel.ts:802`):
```
render(): void {
    const wbSnapshot = this.acquireWorkbookSnapshot();   // line 803
```
`acquireWorkbookSnapshot()` at line 761 → `acquireWorkbookSnapshotViaDelta()` from `cellGridLogic.ts` → calls `workbookSnapshot()` (seed) or `workbookSnapshotDelta()` (incremental). **No call to `exportCellSnapshot` or `exportSnapshot`.**

**Stale comment**: `cellGridPanel.ts:12` says "Renders the engine snapshot via exportCellSnapshot" — this is a STALE file-level docstring, not live code. The `render()` body does not call `exportCellSnapshot`.

**Other stale references**:
- `cellGridPanel.ts:1025` — "exportCellSnapshot can throw" — this is in a comment about historical context, not a call site.
- `cellGridLogic.ts:722,749` — both are docstring references, not call sites.

**Test usage only**: `test/quantbook-roundtrip.test.ts` imports and calls `exportCellSnapshot` at many sites (lines 2207-2891). This is the ONLY active caller.

**VERDICT (IDE)**: `exportCellSnapshot` / `exportSnapshot` is DEAD in all live IDE render paths. The live path is `acquireWorkbookSnapshotViaDelta → workbookSnapshot / workbookSnapshotDelta`. B#1's severity as a live render bug was LOW even before the fix (the dead path would only trigger if someone called `exportCellSnapshot` explicitly from a command — no such command exists).

---

## 4. Findings

---

### Finding S2-01 — MEDIUM: `workbook_snapshot_delta` cross-window tombstone leak via `snapshot_cell`

**Severity**: MEDIUM (exploitable in theory; IDE behavior required to trigger; no current live IDE path hits it in normal use)

**File**: `crates/ql-bindings-node/src/lib.rs:2712-2731`

**Evidence**:

The filter at line 2708-2715 builds `removed_sheet_set` ONLY from `Op::RemoveSheet` ops in the current delta window `[cached_op_count, current_op_count)`:
```rust
let removed_sheet_set: std::collections::HashSet<u16> =
    removed_sheet_ids.iter().copied().collect();
for (sheet, row, col) in changed_cell_coords {
    if removed_sheet_set.contains(&sheet) {        // ← only current-window RemoveSheet
        continue;
    }
    let state = match inner.snapshot_cell(sheet, row, col) {   // ← tombstone-AGNOSTIC
        Some(state) => state,
        None => continue,
    };
```

`snapshot_cell` (session.rs:2125) is tombstone-agnostic: it returns whatever is in `last_snapshot` for `(sheet, row, col)` including pre-tombstone values preserved by R-V3.6-19.

**Attack scenario**:
1. `PutValue { sheet: 7, row: 0, col: 0, value: 5.0 }` → cached; snapshot seeded; `workbookSnapshot()` called → delta cache at VV=A.
2. `RemoveSheet { id: 7 }` → cache tombstones sheet 7; `force_clear_workbook_cache()` triggered by `append_op`... wait — let me re-examine.

Actually, `append_op` for `RemoveSheet` does NOT call `force_clear_workbook_cache`. Let me refine the scenario:

Step 1: `PutValue(7, 0, 0, 5.0)` appended; `workbookSnapshot()` called → workbook cache set at VV=A, op_count=1.
Step 2: `RemoveSheet { id: 7 }` appended → cache tombstones 7 (via `apply_cache_effect`), but workbook cache NOT cleared (only `merge_bytes/discard_pending_ops/undo/redo` clear it).
Step 3: `PutValue(7, 0, 0, 99.0)` appended → cache DROPS the effect (tombstone gate at session.rs:1476); `(7,0,0)` still has value=5.0 in cache.
Step 4: `workbookSnapshotDelta(VV=A)`:
  - delta range = ops [1..3] = `[RemoveSheet{7}, PutValue{7,0,0,99.0}]`
  - `classify_delta_op(RemoveSheet{7})` → `removed_sheet_ids = [7]`
  - `classify_delta_op(PutValue{7,0,0,99.0})` → `changed_cell_coords = {(7,0,0)}`
  - `removed_sheet_set = {7}` → filter FIRES → (7,0,0) skipped ✓

**Actually in that scenario it's filtered correctly** because the RemoveSheet is in the SAME delta window.

**Revised scenario for the actual leak**:

Step 1: `PutValue(7, 0, 0, 5.0)` appended + `workbookSnapshot()` → workbook cache at VV=A, op_count=1.
Step 2: `workbookSnapshotDelta(VV=A)` returns empty delta → workbook cache updated to VV=B=A (no new ops).
Step 3: `RemoveSheet { id: 7 }` appended → `apply_cache_effect(CacheEffect::RemoveSheet{7})` → `removed_sheets.insert(7)` (tombstoned in cache). Cells preserved (R-V3.6-19). Workbook cache NOT cleared (only `merge_bytes/discard_pending_ops/undo/redo` clear it per V3.6.0.8.2 invalidation discipline).

Wait — does `append_op` for `RemoveSheet` clear the workbook cache? Let me check the invalidation discipline.

Looking at the V3.6.0.8.3 algorithm comment at lib.rs:2454-2456:
> "5. Enumerate ops since cached op_count (positional range [cached_op_count, log.len())). V3.6.0.8.2 invalidation discipline guarantees append_op is the ONLY way the log grew between cache populate + delta call (merge_bytes / discard_pending_ops / undo / redo all invalidated the cache)"

And at lib.rs:2550-2554:
> "V3.6.0.8.2 invalidation discipline guarantees positional indices [cached_op_count, current_op_count) are stable (append_op is the only growth path between cache populate and now)."

**`append_op` does NOT clear the workbook cache** — only `merge_bytes`, `discard_pending_ops`, `undo`, `redo` do. So after `RemoveSheet { id: 7 }` via `append_op`, the workbook cache is still valid (pointing to op_count=1).

Step 4: `workbookSnapshotDelta(VV=B)`:
  - VV=B matches cached VV → proceed to delta
  - delta range = ops [1..2] = `[RemoveSheet{7}]`
  - `classify_delta_op(RemoveSheet{7})` → `removed_sheet_ids=[7]`, no cell coords
  - `changed_cell_coords` is empty
  - `removed_sheet_set = {7}`
  - delta output: `sheets_removed=[7]`, `changed_cells=[]` ✓ — IDE learns sheet 7 is removed

Step 5: Workbook cache updated to VV=C, op_count=2.
Step 6: `appendPutValue(7, 0, 0, 99.0)` appended → cache drops it (tombstone gate). Workbook cache NOT cleared.
Step 7: `workbookSnapshotDelta(VV=C)`:
  - delta range = ops [2..3] = `[PutValue{7,0,0,99.0}]`
  - `classify_delta_op(PutValue{7,0,0,99.0})` → `changed_cell_coords={(7,0,0)}`
  - `removed_sheet_ids = []`, `removed_sheet_set = {}` — **NO RemoveSheet in this delta window**
  - filter at line 2714 does NOT fire for (7,0,0)
  - `snapshot_cell(7, 0, 0)` → returns 5.0 (pre-tombstone preserved value!)
  - **LEAKED: delta emits `ChangedCellJson { sheet: 7, cell: { value: 5.0 } }`**

The IDE would process this delta and see a `changedCells` entry for a sheet it already knows is removed (from the step 4 delta). The correctness impact is IDE-specific: if the IDE discards updates for removed sheets, it's a no-op; if it applies them naively, it could re-display cells for a deleted sheet.

**Mitigation in practice**: The IDE delete-sheet flow (napi `delete_sheet` → `Op::RemoveSheet`) should prevent the IDE from subsequently calling `appendPutValue` on the same sheet. The only real-world trigger would be:
- A bug in the IDE calling `appendPutValue` on a deleted sheet, OR
- In a future scenario where a shared delta cache between sessions (V3.6.1 OPUS-PT-B10) leads to cross-session state confusion.

**Fix**: At line 2714, augment the filter to ALSO check `inner.is_sheet_removed_in_cache(sheet)`:
```rust
if removed_sheet_set.contains(&sheet) || inner.is_sheet_removed_in_cache(sheet) {
    continue;
}
```
This costs one HashSet lookup per changed cell (O(1); same cost as the existing `removed_sheet_set` check) and closes the cross-window gap.

---

### Finding S2-02 — LOW: `workbook_snapshot` uses Workbook tombstone (`workbook.is_sheet_removed`) as filter while calling `snapshot_cells` from the cache — two independent sources

**Severity**: LOW (no actual divergence observed; flag as potential future risk)

**File**: `crates/ql-bindings-node/src/lib.rs:2236 + 2273`

**Evidence**:

`workbook_snapshot` calls `rebuild_workbook` to get a fresh Workbook, then uses `workbook.is_sheet_removed(sheet_id)` (storage layer) to filter, but calls `inner.snapshot_cells(sheet_id)` (cache layer). These two tombstone sources are both derived from the same op log but maintained independently.

In normal operation they are equivalent. The risk window: if the cache's `removed_sheets` diverges from `workbook.removed_sheets` (e.g., due to a future bug in `apply_cache_effect` or a `RestoreSheet` race), the filter could incorrectly pass a tombstoned sheet through.

**Mitigating factor**: Both are rebuilt from the same op log in `rebuild_snapshot_cache` + `rebuild_workbook` respectively; the `workbook_snapshot` call rebuilds the workbook fresh every time, and the cache is also consistently maintained. No known divergence path exists today.

**Recommendation**: Document the invariant explicitly: "workbook.is_sheet_removed and cache.removed_sheets MUST agree; any future code path that updates one must update the other." No code change required for current correctness.

---

### Finding S2-03 — INFO: `cell_op_index_iter` and `sheet_op_index_iter` are tombstone-unaware raw index accessors

**Severity**: INFO (no current external exposure)

**File**: `crates/ql-collab/src/session.rs:1868, 1883`

**Evidence**: Both return raw HashMap iterators without tombstone filtering. `cell_op_index` may contain entries for cells on tombstoned sheets; `sheet_op_index` maps tombstoned sheet ids to their RemoveSheet op positions.

**Mitigating factor**: Neither is exposed through any napi binding or used outside test code. The `cell_op_index_iter` caller context (test equality checks, V3.7+ incremental delta planning) expects raw access. Document that consumers of these iterators must check `is_sheet_removed_in_cache(sheet)` if they intend to surface cell-level data.

---

### Finding S2-04 — INFO: `exportCellSnapshot` / `exportSnapshot` IDE wrapper is dead in all live render paths

**Severity**: INFO (confirming session claim; B#1 priority is NOT elevated to "active" by this)

**File**: `extensions/quantlab/src/quantbook/session.ts:421`; `extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts:802`

**Evidence**: See Section 3 above. The live render path at `cellGridPanel.ts:render()` uses `acquireWorkbookSnapshot()` → `acquireWorkbookSnapshotViaDelta()` which calls `workbookSnapshot()` or `workbookSnapshotDelta()`. `exportCellSnapshot` is only imported and called in test files (`test/quantbook-roundtrip.test.ts`).

The stale file-level docstring at `cellGridPanel.ts:12` ("Renders the engine snapshot via exportCellSnapshot") predates V3.5.0.4b and was not updated when the migration landed. This is a documentation debt item, not a live bug.

**Recommendation**: Update `cellGridPanel.ts:12` docstring to reflect the current `workbookSnapshot` / `workbookSnapshotDelta` path. Mark `exportCellSnapshot` in `session.ts` as `@deprecated` with a note pointing to `workbookSnapshot`.

---

## 5. Summary Table — All Non-Test Snapshot Consumers

| Consumer | Filter | Status |
|---|---|---|
| `export_snapshot` (napi, lib.rs:1734) | `is_sheet_removed_in_cache(sheet)` | CLOSED (B#1) |
| `workbook_snapshot` (napi, lib.rs:2141) | `workbook.is_sheet_removed(sheet_id)` before `snapshot_cells` call | CORRECT |
| `workbook_snapshot_delta` — `removed_sheet_set` filter (lib.rs:2712-2716) | `removed_sheet_set` from ops in current delta window ONLY | PARTIAL — S2-01 cross-window gap |
| `workbook_snapshot_delta` — `snapshot_cell` call (lib.rs:2729) | None (tombstone-agnostic) | LEAKS if S2-01 gap triggered |
| `list_sheets` (napi, lib.rs:1839) | `list_sheets_from_cache()` filters `removed_sheets` | CORRECT |

---

## 6. VERDICT

**B#1 did NOT close all tombstone-leak paths.**

There is one remaining unfiltered path:

**S2-01 (MEDIUM)**: `workbook_snapshot_delta` contains a cross-window tombstone leak. The `removed_sheet_set` filter (lib.rs:2714) only covers RemoveSheet ops in the CURRENT delta window. If a sheet was tombstoned in a PRIOR delta window and the IDE subsequently (accidentally or via a bug) calls `appendPutValue` on the tombstoned sheet, the delta will:
1. Add the new cell coord to `changed_cell_coords` (from the new PutValue op)
2. Pass the `removed_sheet_set` filter (no RemoveSheet in the current window)
3. Return the PRE-TOMBSTONE cached value via `snapshot_cell` (which is tombstone-agnostic)
4. Emit a `ChangedCellJson` for a sheet the IDE was already told was deleted

**Fix is one line** at lib.rs:2714:
```rust
if removed_sheet_set.contains(&sheet) || inner.is_sheet_removed_in_cache(sheet) {
```

**Practicality**: In normal IDE flows (delete-sheet disables further writes to that sheet), this gap does not trigger. It becomes relevant if: (a) the IDE has a bug calling `appendPutValue` on a deleted sheet, or (b) future scenarios where the delta cache and IDE state diverge. It is a latent MEDIUM, not a currently-exploited HIGH.

**All other non-test snapshot_cells consumers are correctly filtered.** The "raw snapshot_cells accessor" Lane B feared has no unfiltered non-test caller beyond the one identified above (`snapshot_cell` in the delta path).

**IDE exportSnapshot is confirmed dead** in all live paths — B#1's urgency was lower than indicated by the megaudit framing (the fix was still correct and necessary for tests + future live use).
