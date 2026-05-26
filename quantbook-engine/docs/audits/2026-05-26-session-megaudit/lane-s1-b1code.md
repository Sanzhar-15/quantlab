# Lane S1 — B#1 Code Audit (2026-05-26)

**Auditor**: Sonnet 4.6 (S1, read-only lane)
**Scope**: commit `ff09a5e17a7` — "fix(quantbook): 5.8 megaudit B#1 — export_snapshot must hide tombstoned-sheet cells"
**Files reviewed**:
- `crates/ql-collab/src/session.rs` — new accessor + regression test
- `crates/ql-bindings-node/src/lib.rs` — `export_snapshot` body (`~1756–1767`)
**Reference comparators**:
- `workbook_snapshot` tombstone skip (`lib.rs ~2223–2238`)
- `list_sheets_from_cache` (`session.rs ~1780–1797`)
- `apply_cache_effect` RemoveSheet / RestoreSheet arms (`session.rs ~1611–1634`)
- `rebuild_snapshot_cache` (`session.rs ~2198–2238`)
- Workbook `is_sheet_removed` / `remove_sheet` (`ql-storage/src/workbook.rs ~748–760`)

---

## Test run

```
cargo test -p ql-collab
255 passed; 0 failed; 6 ignored
```

New test `is_sheet_removed_in_cache_tracks_tombstone_while_snapshot_cells_preserves` — PASSES.

---

## Findings

### F-01 — Tombstone source is correct
**Severity**: INFO (no defect)
**Files**: `session.rs:1812`, `workbook.rs:758`

`is_sheet_removed_in_cache` reads `self.removed_sheets` (the cache-layer `HashSet<u16>` maintained by `apply_cache_effect`). This set is:
- Populated by `CacheEffect::RemoveSheet { id } => buckets.tombstones.insert(id)` (session.rs ~1611).
- Cleared on restore by `CacheEffect::RestoreSheet { id } => buckets.tombstones.remove(&id)` (session.rs ~1633).
- Atomically rebuilt by `rebuild_snapshot_cache` (session.rs ~2203–2235) on every merge / undo / redo path.

The Workbook's `is_sheet_removed` reads the storage-layer `removed_sheets` populated by `replay.rs` `apply_op`. Both sets mirror the same op sequence; they are kept in sync by the same `Op::RemoveSheet` / `Op::RestoreSheet` causal walk. The choice of the cache-layer set (rather than rebuilding a Workbook) is correct and intentional: `export_snapshot` does not build a Workbook, so using the cache is the only O(1) path. `list_sheets_from_cache` makes the same choice (session.rs ~1792).

### F-02 — Empty entries list is the correct return shape
**Severity**: INFO (no defect)
**Files**: `lib.rs:1763–1766`

`workbook_snapshot` handles a tombstoned sheet by `continue` (lib.rs ~2236), which omits the entire `SheetSnapshotJson` from the `sheets` array — effectively zero cells for that sheet. `export_snapshot` is sheet-scoped (caller passes a sheet id); "no cells" is the correct translation of "sheet tombstoned" for this API. Returning `Vec::new()` produces `{"snapshot_format_version":1,"sheet":<id>,"entries":[]}`, which is structurally valid JSON per the documented shape (lib.rs ~1683–1706) — the spec does not forbid an empty `entries` array. An error return would be semantically wrong: the sheet may be legitimately tombstoned and the caller should receive the current (empty) view.

### F-03 — Restore symmetry is correct
**Severity**: INFO (no defect)
**Files**: `session.rs:1633`, `session.rs:6079–6086`

`Op::RestoreSheet` fires `CacheEffect::RestoreSheet`, which calls `tombstones.remove(&id)` (session.rs ~1633). After restore, `is_sheet_removed_in_cache` returns `false`, and `export_snapshot` falls through to `inner.snapshot_cells(sheet)`. Since `CacheEffect::RemoveSheet` no longer prunes cells (post-R-V3.6-19 phase-termination closure), the pre-tombstone cells are preserved and resurface on restore. The new test asserts this roundtrip at line 6079–6086. Correct.

### F-04 — Never-existed sheet id: behavior is consistent pre/post fix
**Severity**: INFO (no defect)
**Files**: `session.rs:1812`, `lib.rs:1763–1766`

For a sheet id that was never the target of any `Op::PutValue` or `Op::RemoveSheet`:
- `is_sheet_removed_in_cache(X)` → `false` (X is not in `removed_sheets`).
- `snapshot_cells(X)` → empty vec (no cache entries for X).
- Net result: `export_snapshot(X)` returns `{..., "entries":[]}`.

This is identical to pre-fix behavior and to `workbook_snapshot` behavior (which would simply not include the sheet in the `sheets` array if `sheet_count == 0`). No regression.

### F-05 — Subtle difference: cache's `removed_sheets` vs Workbook's `removed_sheets` on out-of-range sheet ids
**Severity**: LOW (theoretical only; no practical impact)
**Files**: `session.rs:1611–1612`, `workbook.rs:749–752`

The cache's `apply_cache_effect` inserts into `removed_sheets` unconditionally on `CacheEffect::RemoveSheet { id }` (no bounds check, session.rs ~1612). The Workbook's `remove_sheet` only inserts if `(id as usize) < self.sheets.len()` (workbook.rs ~749–752). If a peer emits `Op::RemoveSheet { id: 9999 }` where sheet 9999 was never created (impossible from a well-behaved producer, but conceivable from a malformed or future-version peer), the cache would mark 9999 as tombstoned while the Workbook would not. In that case, `is_sheet_removed_in_cache(9999)` returns `true`, causing `export_snapshot(9999)` to return empty — but `snapshot_cells(9999)` would also return empty (no cells were ever written for a sheet that doesn't exist). The behavior is functionally identical (empty entries either way). This discrepancy predates this commit and is documented in the `applied_cache_effect` RemoveSheet arm. Not introduced by this fix; no action needed.

### F-06 — The new test exercises the accessor and invariant, but not `export_snapshot` directly
**Severity**: LOW (acceptable given constraints)
**Files**: `session.rs:6051–6087`

The test verifies:
1. `is_sheet_removed_in_cache` flips `true` on `Op::RemoveSheet` and `false` on `Op::RestoreSheet` (the accessor contract).
2. `snapshot_cells` returns 1 entry throughout (R-V3.6-19 preserve invariant).
3. `list_sheets_from_cache` is empty while tombstoned and returns `[7]` after restore.

It does NOT call `export_snapshot` (which is a napi-gated method in `ql-bindings-node`; the napi symbols cannot be linked in `ql-collab` unit tests). The test therefore validates the building blocks — the accessor and the preserve invariant — but delegates the integration of those building blocks (the `if inner.is_sheet_removed_in_cache(sheet) { Vec::new() } else { inner.snapshot_cells(sheet) }` branch) to the mocha test suite.

This gap is acknowledged in the commit message: "ql-bindings-node lib cargo-check clean (napi lib-test cannot link standalone — napi runtime symbols — so this surface is mocha-tested, not cargo-tested)." Given the napi linking constraint, unit-testing the two building blocks separately is the correct and only feasible cargo-level approach. The test IS meaningful: it would catch a regression where `is_sheet_removed_in_cache` stopped tracking tombstones, or where `snapshot_cells` started returning empty on tombstone (breaking the preserve contract, which would make the fix invisible). The mocha layer should provide the integration coverage.

One gap: the test does not verify `list_sheets_from_cache` filtering after a new write on the tombstoned sheet (i.e., that `PutValue` on a tombstoned sheet is silently dropped from the cache, so tombstone window has no leaked writes). However, this is covered by the existing test `put_value_on_tombstoned_sheet_is_silently_dropped` (session.rs ~6371) which was already present before this commit. Not a gap introduced here.

### F-07 — Docstring of `export_snapshot` not updated to document tombstone behavior
**Severity**: LOW (polish)
**Files**: `lib.rs:1708–1715`

The `# Semantics` section (lib.rs ~1708–1715) describes V3.2.a behavior and mentions "V3.2.b+ may upgrade this to route through `rebuild_workbook`". It does not mention the tombstone-filtering behavior added by this commit. The inline block comment at lines 1757–1762 covers the rationale, but the official `# Semantics` section is stale. Callers relying on the function-level doc for a complete behavioral contract will miss the tombstone rule. Recommend adding a `**V3.6.0.X (2026-05-26)**:` note to `# Semantics` describing the empty-entries return for tombstoned sheets.

### F-08 — `snapshot_cells` docstring stale on tombstone-agnostic behavior
**Severity**: LOW (polish)
**Files**: `session.rs:2079–2080`

The docstring says: "Empty if no cell-keyed op has been observed on this sheet." Post-R-V3.6-19, `snapshot_cells` returns 1 cell for a tombstoned sheet that had a prior `PutValue` — it is NOT empty. The docstring should state "tombstone-agnostic: returns pre-tombstone entries regardless of `removed_sheets` state; callers must filter via `is_sheet_removed_in_cache` or equivalent." This stale language predates this commit; the new `is_sheet_removed_in_cache` docstring correctly describes the expected caller pattern, but `snapshot_cells` itself doesn't advertise its agnosticism. Not introduced by this fix.

### F-09 — No mocha test cited or newly added to cover `exportSnapshot` + removed sheet
**Severity**: LOW (coverage gap at integration layer)
**Files**: (ql-bindings-node mocha suite, not reviewed here)

The commit message notes the live IDE render path migrated to `workbookSnapshot` at V3.5.0.4b and that `exportSnapshot` is legacy. If the mocha suite does not have a test for `exportSnapshot(removedSheetId)` returning `entries: []`, the fix has zero end-to-end cargo or mocha coverage. This lane cannot verify the mocha suite (outside scope), but the gap should be confirmed by the mocha/integration lane.

---

## Summary of severity counts

| Severity | Count | Description |
|----------|-------|-------------|
| HIGH     | 0     | —           |
| MEDIUM   | 0     | —           |
| LOW      | 4     | F-05, F-06, F-07, F-09 (F-08 predates) |
| INFO     | 4     | F-01, F-02, F-03, F-04 |

---

## VERDICT

**The B#1 fix is CORRECT.**

The logic (`if inner.is_sheet_removed_in_cache(sheet) { Vec::new() }`) directly mirrors the two existing consumers that got the tombstone filter right: `list_sheets_from_cache` (session.rs ~1792) and `workbook_snapshot` (lib.rs ~2236). The tombstone source (`removed_sheets` in the session cache) is maintained in sync with all op-mutation paths and is the same field consulted by `list_sheets_from_cache`. The return shape (empty entries JSON) is valid per the documented contract. Restore symmetry works correctly.

**The fix is adequately tested at the cargo level given the napi constraint.** The new test covers the accessor correctness and the preserve invariant — the two components the fix composes. A direct cargo test of `export_snapshot` is impossible without napi symbols. Adequacy at the integration layer depends on mocha coverage (F-09: unverified by this lane).

**Remaining items**: four LOWs, all polish or pre-existing. None block correctness or shipping. F-07 and F-09 are the most actionable (docstring update + mocha test confirmation).
