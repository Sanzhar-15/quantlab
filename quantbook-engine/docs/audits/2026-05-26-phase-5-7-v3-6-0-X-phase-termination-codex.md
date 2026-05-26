# Phase 5.7 V3.6 phase-termination audit -- Codex Lane A

**Date**: 2026-05-26
**Engine HEAD**: 7e3a8bc53ec
**IDE HEAD**: aa9d0448bb1
**Verdict**: FAIL

## Findings summary

1 HIGH + 0 MED + 1 LOW + 9 INFO across 11 shipped V3.6 sub-step rows.

The phase-level audit found one user-visible correctness bug that only appears when V3.5 tombstone-preserved sheet storage, V3.6 D6 snapshot/delta caching, and V3.6 D8 RestoreSheet are considered together. Baseline engine tests still pass (`ql-collab` 154/154), but a targeted restore probe fails because the authoritative rebuilt `Workbook` contains the restored cell while the IDE-facing `workbookSnapshot()` omits it.

## Findings table

| Sev | ID | Section | Title |
|-----|----|---------|-------|
| HIGH | CODEX-PT-A1-HIGH | A.1/A.3/C.1/C.2 | RestoreSheet full-rebuild path returns a restored sheet without its preserved cells |
| LOW | CODEX-PT-F3-LOW | F.3 | `current_work.md` handoff still carries stale D9/406 next-session state |
| INFO | CODEX-PT-A2-INFO | A.2 | RegisterFormat undo/merge/poll cache synchronization holds |
| INFO | CODEX-PT-A4-INFO | A.4/E.3 | D9 typing_stroke plus remote merge is benign in the shipped IDE render path |
| INFO | CODEX-PT-A5-INFO | A.5 | RemoveSheet delta emits `sheetsRemoved` and skips orphaned cells |
| INFO | CODEX-PT-A6-INFO | A.6/C.3 | D6 benches are semantically comparable, with a post-D8 bench gap |
| INFO | CODEX-PT-B-INFO | B.1/B.2/B.3 | Wire schema stays at v1; compat failure modes are loud |
| INFO | CODEX-PT-C-INFO | C.1/C.2/C.3 | Cross-feature test gaps remain around RestoreSheet snapshots and deltas |
| INFO | CODEX-PT-D-INFO | D.1/D.2 | Rule 4 arc terminus still holds through V3.6 |
| INFO | CODEX-PT-E-INFO | E.1/E.2/E.3 | V3.5/V3.6 risk-register closures are mostly accurate; R-V3.6-9 remains partial |
| INFO | CODEX-PT-F-INFO | F.1/F.2 | D9 docs sweep and audit transcript table are coherent outside the handoff drift |

## HIGH findings (detail)

### CODEX-PT-A1-HIGH: RestoreSheet full-rebuild path returns a restored sheet without its preserved cells

**Finding**

D8 correctly restores the sheet in the rebuilt `Workbook`, but the IDE-facing full snapshot still serializes cells from `CollabSession.last_snapshot`, not by enumerating the rebuilt `Workbook`. `CacheEffect::RemoveSheet` prunes all cached cells on the sheet, and `CacheEffect::RestoreSheet` only removes the tombstone. Therefore a sheet removed and then restored reappears in `workbookSnapshot().sheets`, but pre-tombstone cells are absent from the snapshot.

This is phase-level because each individual D looked plausible:

- V3.5.0.3b preserved cells in `Workbook` storage across tombstones.
- D8 `rebuild_workbook` restores the sheet and preserved cells.
- D6 `classify_delta_op` forces `fullRebuildRequired=true` for `Op::RestoreSheet`.
- But the D6/D4/D2 snapshot body still uses the session cache for cells, so the full rebuild fallback does not actually rehydrate the IDE-facing cell list.

**Relevant code**

Storage/replay side is correct:

```rust
// crates/ql-oplog/src/replay.rs:795-824
Op::RestoreSheet { id } => {
    workbook.restore_sheet(*id);
    Ok(())
}

// crates/ql-storage/src/workbook.rs:781-784
pub fn restore_sheet(&mut self, id: SheetId) {
    if (id as usize) < self.sheets.len() {
        self.removed_sheets.remove(&id);
    }
}
```

Cache side drops cells at remove and does not rehydrate them at restore:

```rust
// crates/ql-collab/src/session.rs:1582-1598
CacheEffect::RemoveSheet { id } => {
    buckets.tombstones.insert(id);
    buckets.snapshot.retain(|(sheet, _, _), _| *sheet != id);
    buckets.cell_op_index.retain(|(sheet, _, _), _| *sheet != id);
}
CacheEffect::RestoreSheet { id } => {
    buckets.tombstones.remove(&id);
    // no re-add of pre-tombstone cell state
}
```

The snapshot body rebuilds `Workbook`, skips tombstones using that rebuilt state, but still sources cells from the cache:

```rust
// crates/ql-bindings-node/src/lib.rs:2138-2142, 2226-2264
let (workbook, _report) = inner.rebuild_workbook(&registry)?;
...
if workbook.is_sheet_removed(sheet_id) {
    continue;
}
let cells: Vec<CellSnapshotJson> = inner
    .snapshot_cells(sheet_id)
    .into_iter()
    ...
```

The D8 test coverage stops short of the failure condition. The engine test `v3_6_0_10_restore_sheet_untombstones_in_workbook` checks the sheet count/name after rebuild (`crates/ql-collab/src/session.rs:7851-7877`), but not the restored cell contents. The IDE mocha test checks that the sheet comes back in `workbookSnapshot.sheets`, and the delta test checks only `fullRebuildRequired=true`.

**A.1 cache window analysis**

There is a stale cached-workbook window after appending `RestoreSheet` if the previous `last_snapshot_workbook` reflected the tombstoned sheet, because `append_op` intentionally does not clear the D6 workbook cache. However, a caller using `workbookSnapshotDelta(lastSeenVersion)` does not receive a false cell-only delta in that window: `classify_delta_op` sees `Op::RestoreSheet` and returns `fullRebuildRequired=true` (`crates/ql-bindings-node/src/lib.rs:452-461`, `2641-2644`). The stale cached workbook is therefore not served as a valid delta.

The bug is the next step: the required full `workbookSnapshot()` fallback rebuilds a correct `Workbook`, caches it, and then serializes an empty cell list for the restored sheet because it reads `inner.snapshot_cells(sheet_id)`. A direct `workbookSnapshot()` after restore has the same problem.

**A.3 format/render impact**

A custom-formatted cell on a removed-then-restored sheet also loses its rendered display string. This follows from the same root cause: the cell is absent before the D4 render branch can look up its format or call `format::render`. The session-wide format table and rebuilt `Workbook.formats()` can still contain the format definition, but there is no `CellSnapshotJson` carrying `value`, `format`, or `rendered`.

**Reproducibility**

I created and then removed a temporary probe file under `crates/ql-collab/tests/codex_pt_restore_probe.rs` with this essential assertion:

```rust
#[test]
fn restore_sheet_preserved_cells_reappear_in_session_snapshot_cache() {
    let mut session = CollabSession::new(PeerId::new(1)).unwrap();
    session.append_op(Op::AddSheet { name: "S".to_owned(), chunk_rows: 16384 }).unwrap();
    session.append_op(Op::PutValue {
        sheet: 0,
        row: 0,
        col: 0,
        value: CellWireValue::Number(7.0),
    }).unwrap();
    session.append_op(Op::RemoveSheet { id: 0 }).unwrap();
    session.append_op(Op::RestoreSheet { id: 0 }).unwrap();

    let registry = ql_functions::default_registry();
    let (workbook, _) = session.rebuild_workbook(&registry).unwrap();
    assert!(!workbook.is_sheet_removed(0));
    assert!(workbook.sheet(0).unwrap().read(0, 0).is_some());
    assert_eq!(session.snapshot_cells(0).len(), 1);
}
```

Command:

```sh
~/.cargo/bin/cargo test -p ql-collab --release --features test-fixtures --test codex_pt_restore_probe -- --nocapture
```

Observed failure:

```text
restored sheet cells are present in rebuilt Workbook but absent from CollabSession snapshot cache
left: 0
right: 1
```

Baseline after deleting the probe remains green:

```sh
~/.cargo/bin/cargo test -p ql-collab --release --features test-fixtures --lib
# result: 154 passed; 0 failed
```

**Fix recommendation**

Close this before declaring V3.6 phase termination complete. The narrow fix should ensure full snapshot fallback after `RestoreSheet` serializes preserved cells from the authoritative rebuilt workbook, not from the pruned session cache alone.

Recommended options:

1. Teach `workbookSnapshot()` to enumerate live cells from the rebuilt `Workbook` for restored sheets, while still using the session cache for fields that only live there if needed. This aligns the full snapshot with D8's storage-preservation contract.
2. Alternatively, change the session cache rebuild semantics so `RestoreSheet` rehydrates pre-tombstone cell entries by replaying relevant pre-remove cell effects. If this path is chosen, also revisit index behavior: `sheet_op_index` currently indexes `RemoveSheet` but not `RestoreSheet`, so partial invalidation after restore depends on full-rebuild paths and can miss restore ordering.
3. Add regressions:
   - Engine: `PutValue -> RemoveSheet -> RestoreSheet -> workbookSnapshot-equivalent` includes the cell.
   - Engine/IDE: same flow with `RegisterFormat + SetCellFormat` includes `format` and `rendered`.
   - Napi delta: baseline snapshot, remove, restore, `workbookSnapshotDelta` returns `fullRebuildRequired=true`, and the following `workbookSnapshot()` includes restored cells.
   - Undo: after restore and a post-restore overwrite, undoing the overwrite exposes the pre-tombstone value or forces a full cache rebuild that does.

## MED findings (detail)

None.

## LOW findings (detail)

### CODEX-PT-F3-LOW: `current_work.md` handoff still carries stale D9/406 next-session state

**Finding**

The memory handoff at `/Users/sanzhar/OrbStack/ubuntu/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` correctly states the shipped heads and top-level baseline at lines 1-19: engine `7e3a8bc53ec`, IDE `aa9d0448bb1`, `ql-collab` 154/154, IDE mocha 413/413. Later handoff sections are stale:

- Lines 64-66 say "6 cycles used" and "Next session MUST start at 0 cycles" even though the same file documents 8 cycles across 2 sessions at lines 21-33.
- Lines 68-72 still list "V3.6.0.11 D9 typing-stroke watchdog" as a next recommended sub-step, despite D9 being shipped.
- Lines 81-85 still expect IDE mocha "406 passing" instead of 413.

**Fix recommendation**

Update the handoff tail to make the next action V3.6 phase-termination audit/closure work or conditional D7 only, and update the mocha expectation to 413.

**Reproducibility**

```sh
nl -ba /Users/sanzhar/OrbStack/ubuntu/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md | sed -n '1,95p'
```

## INFO observations

### CODEX-PT-A2-INFO: RegisterFormat undo/merge/poll cache synchronization holds

I did not find a D6+D1+D2 cache desynchronization for undo of `Op::RegisterFormat`.

The important path is that `RegisterFormat` is non-cell-keyed. Undo/redo therefore falls through the existing non-cell-keyed full snapshot-cache rebuild path rather than trying a partial cell invalidation. `rebuild_snapshot_cache` rebuilds `last_snapshot`, `removed_sheets`, `format_table_cache`, `cell_op_index`, and `sheet_op_index` together via the canonical cache-effect walker. `merge_bytes` and `poll_remote_with_limit` also rebuild the snapshot cache and invalidate the workbook cache. Existing ql-collab tests cover RegisterFormat append, rebuild, merge, Builtin-drop, first-write-wins, and BatchCommit recursion.

Residual risk is limited to RestoreSheet interactions described in CODEX-PT-A1-HIGH, not RegisterFormat itself.

### CODEX-PT-A4-INFO: D9 typing_stroke plus remote merge is benign in the shipped IDE render path

The shipped IDE production render path still calls full `workbookSnapshot(this.session)` from `CellGridPanel.render()` (`cellGridPanel.ts:751-753`). `workbookSnapshotDelta` is present in TypeScript types/tests, but not used by the production cell-grid render path.

When a remote merge arrives while `_presenceRepaintInFlight` is true, `tickPollRemote` drains the engine via `session.pollRemote()`, then sets `_pendingRenderAfterTyping` and skips render (`cellGridPanel.ts:936-966`). D9 `typing_stroke` only re-arms the existing watchdog if `_presenceRepaintInFlight` is true (`cellGridPanel.ts:674-693`). The engine workbook cache being invalidated by `pollRemote` does not affect this guard: the deferred render later calls full `workbookSnapshot()`.

If the webview `'input'` listener never fires, the original `setPresenceTyping(true)` watchdog remains armed and auto-clears after 30s (`cellGridPanel.ts:575-617`). D9 only extends that deadline on actual strokes; it does not remove the stuck-true recovery.

### CODEX-PT-A5-INFO: RemoveSheet delta emits `sheetsRemoved` and skips orphaned cells

For a delta range containing a cell write and a later `RemoveSheet`, the delta classifier records both the changed cell coordinate and `sheetsRemoved` (`crates/ql-bindings-node/src/lib.rs:392-404`). The cell-only fast path applies the op range to the cloned workbook and then builds changed cells from `inner.snapshot_cell(sheet,row,col)`. Because `CacheEffect::RemoveSheet` prunes the session snapshot, `snapshot_cell` returns `None` and the changed-cell entry is skipped (`lib.rs:2684-2700`). The consumer receives `sheetsRemoved`, not an orphan `changedCells` entry for a tombstoned sheet.

Coverage note: IDE mocha checks `sheetsRemoved` for `deleteSheet` but does not explicitly assert `changedCells` is empty when a cell write and sheet remove are in the same delta window.

### CODEX-PT-A6-INFO: D6 benches are semantically comparable, with a post-D8 bench gap

The V3.6.0.7 full snapshot bench and V3.6.0.8.4 delta-vs-full bench are apples-to-apples for Rust-side snapshot semantics:

- Both use the same 100k-cell, 50% formatted, 1-sheet workload (`build_session(1000, 100, 1, 50)` in `workbook_snapshot.rs:246-249`).
- `snapshot_equivalent` mirrors the Rust body of `workbookSnapshot()`: rebuild workbook, build eval context, use per-snapshot parsed-format cache, iterate display order, skip tombstones, and read cells from `session.snapshot_cells(sheet_id)` (`workbook_snapshot.rs:98-150`).
- `bench_workbook_snapshot_delta` includes a full snapshot baseline in the same criterion group (`workbook_snapshot.rs:293-319`).

Caveat: the bench measures the Rust-side equivalent and returns counts through `black_box`; it does not measure napi object materialization or JS-side serialization. That is acceptable for the D6 Rust perf contract, but not a complete VS Code frame-time benchmark.

Post-D8 gap: there is no bench for the `RestoreSheet -> fullRebuildRequired -> workbookSnapshot()` fallback, which is also the path affected by CODEX-PT-A1-HIGH.

### CODEX-PT-B-INFO: Wire schema stays at v1; compat failure modes are loud

`OPLOG_SCHEMA_VERSION` remains `1` (`crates/ql-io/src/oplog_persistence.rs:129`). V3.6 added `Op::SetDateSystem` and `Op::RestoreSheet` as additive serde-tagged enum variants; the op docstrings explicitly note no schema bump for these additive variants (`crates/ql-oplog/src/op.rs:174`, `226`, `288`).

Forward-compat surface: a pre-V3.6 binary that reads a post-V3.6 `.qbook` with one of the new op variants can decode the Loro snapshot framing, but will fail when iterating/deserializing the op JSON. The failure is loud: `OpLogError::Deserialize { index, source }` from `crates/ql-oplog/src/log.rs:136`, surfaced through callers as `[session_oplog]` or the relevant ql-io replay/load error. Recovery is to open with a V3.6-capable engine; no in-place down-migrator exists.

Backward-compat surface: post-V3.6 binaries load pre-V3.6 op logs that do not contain the new variants. Workbooks without an explicit `SetDateSystem` use `Workbook::new()`'s Excel1900 default; `.qbook` envelope loads that carry Excel1904 are seeded into the log with `Op::SetDateSystem` by current `from_qbook`.

### CODEX-PT-C-INFO: Cross-feature test gaps remain around RestoreSheet snapshots and deltas

Engine-level gap: no ql-collab test exercises `RemoveSheet -> RestoreSheet -> IDE-facing workbookSnapshot-equivalent includes restored cells`. Existing D8 tests verify untombstone state, idempotency, out-of-range no-op, post-restore writes landing in cache, and remote merge convergence. They do not assert pre-tombstone cell reappearance in the session snapshot cache.

IDE-level gap: D8 mocha checks `restoreSheet` napi shape and `workbookSnapshotDelta` fullRebuild on restore, but it does not assert restored cell contents or rendered strings after the required full `workbookSnapshot()` fallback.

Bench gap: no Criterion benchmark covers the post-D8 RestoreSheet full-rebuild/cache path.

### CODEX-PT-D-INFO: Rule 4 arc terminus still holds through V3.6

The V3.6 additions reviewed in this pass are all positive Send+Sync compositions:

- `last_snapshot_workbook: Option<Arc<Workbook>>` requires `Workbook: Send + Sync`; `Workbook` remains a composition of owned collections, strings, numeric ids, format tables, and value/formula structures. D8 added `Workbook::restore_sheet(id)` only; it did not add fields.
- `last_snapshot_oplog_vv: Option<VersionVector>` and `last_snapshot_op_count: Option<usize>` are positive compositions.
- `format_table_cache: HashMap<FormatId, Arc<str>>`, `cell_op_index`, and `sheet_op_index` are HashMaps over Send+Sync keys/values.
- `CacheBuckets<'a>` is a local helper over mutable references and is not a new shared cross-thread surface.
- Napi JSON structs added across V3.6 (`FormatDefJson`, `CellSnapshotJson.rendered`, `WorkbookSnapshotJson.formats/dateSystem/version`, `WorkbookSnapshotDeltaJson`, `ChangedCellJson`, `RemovedCellJson`) are owned primitive/string/vector/buffer compositions.
- New wire enums/variants (`DateSystemWire`, `Op::SetDateSystem`, `Op::RestoreSheet`) are owned primitive/string compositions.

No new negative-trait trigger was found; the documented arc terminus remains 6.

### CODEX-PT-E-INFO: V3.5/V3.6 risk-register closures are mostly accurate; R-V3.6-9 remains partial

V3.5 risk register review:

- R-V3.5-4 rendering deferral is genuinely closed by D4 plus audit-of-D4 closures: `rendered`, `dateSystem`, `Op::SetDateSystem`, `data-raw-value`, pending-value skip, locale threading, and parsed-format cache are all present.
- R-V3.5-5 RegisterFormat snapshot surfacing is genuinely closed by D2 plus audit-of-D2 sort/first-write-wins/Builtin-drop closures.
- R-V3.5-7 D9 closure is genuine for the false-negative case: every webview input stroke re-arms the watchdog, and absence of input strokes leaves the original 30s watchdog intact.
- R-V3.5-1 full-snapshot O(N) remains mitigated at the API level by D6, but production IDE grid render still uses full `workbookSnapshot()`. This is consistent with the shipped D6 scope, but should remain visible when evaluating future IDE performance.

V3.6 risk register review:

- R-V3.6-9 remains PARTIAL-CLOSED. D8 shipped, D7 #REF! substitution remains conditional/out of scope, and D9 does not change that interaction.
- R-V3.6-14/15/16/17/18 closure statements are consistent with code and tests reviewed here.

### CODEX-PT-F-INFO: D9 docs sweep and audit transcript table are coherent outside the handoff drift

`docs/architecture/ide-consumer-contract.md` has the V3.6.0.11 D9 subsection, the D9 audit-transcript row, and the R-V3.5-7 closure text. It also keeps D7 out of scope and marks phase-termination audit as unblocked. `docs/MASTER-PLAN.md` line 547 reflects V3.6.0.11 D9 shipped and phase-termination audit pending.

No new docs drift was found in those repo-local docs beyond the `current_work.md` handoff issue in CODEX-PT-F3-LOW.

## Cross-feature interaction map

| Interaction | Exercised | Result |
|-------------|-----------|--------|
| A.1 D6 delta + D8 RestoreSheet | Code walk + targeted Rust probe | Delta correctly forces full rebuild; full rebuild snapshot drops preserved cells. HIGH. |
| A.2 D6 delta + D1 UndoManager + D2 RegisterFormat | Code walk + existing tests reviewed | RegisterFormat undo/merge/poll synchronization holds; no finding. |
| A.3 D4 render + D6 delta + D8 RestoreSheet | Inferred from A.1 code path | Rendered string cannot survive because restored cell is missing before render. Covered by HIGH. |
| A.4 D9 typing_stroke + D6 delta/cache | IDE render path walk | Benign in shipped IDE because production render uses full snapshot and deferred render guard is independent of engine cache state. INFO. |
| A.5 V3.5 tombstone preservation + D6 + D8 | Delta classifier/render walk | RemoveSheet delta emits `sheetsRemoved` and skips orphaned changed cells. RestoreSheet side is broken by HIGH. |
| A.6 V3.6.0.7 spike vs V3.6.0.8.4 perf | Bench source walk | Semantically comparable Rust-side benches; napi/JS and RestoreSheet fallback not measured. INFO. |
| B.1-B.3 wire stability | Code/doc walk | Schema v1 unchanged; new variants additive; old readers fail loudly on unknown variants. INFO. |
| C.1-C.3 cumulative coverage | Test source walk + baseline run | Baselines green, but restore-cell and restore-render flows are uncovered. INFO/HIGH. |
| D.1-D.2 Rule 4 | Field/type composition walk | No new Send+Sync issue. INFO. |
| E.1-E.3 risk closures | Docs + code walk | R-V3.5-7 closure genuine; R-V3.6-9 still partial. INFO. |
| F.1-F.3 docs/handoff | Docs + memory walk | Repo docs coherent; external handoff tail stale. LOW. |

Coverage not exercised with a live IDE mocha run in this lane: full IDE suite, panel-level fake-timer watchdog test, and a real VS Code webview render after restore. The engine targeted probe and source walk are sufficient for the HIGH because the failing state exists before IDE rendering.

## Lane A unique vs convergent

Likely convergent in Lane B:

- CODEX-PT-A1-HIGH should be easy to rediscover if Lane B probes restored cell contents instead of only sheet visibility. The source comments in `apply_cache_effect(RestoreSheet)` explicitly say cells do not reappear in the cache while assuming `workbookSnapshot` reads from `rebuild_workbook`, which is false for cells.
- CODEX-PT-C-INFO should converge because current tests visibly stop at sheet visibility and `fullRebuildRequired`.

Lane-A-unique or less likely to converge:

- CODEX-PT-F3-LOW depends on reading the external memory handoff file outside the repo docs sweep.
- CODEX-PT-A6-INFO's nuance about Rust-side semantic comparability versus napi/JS timing may depend on the specific bench-source inspection sequence.

## Verdict + recommendation

**Verdict: FAIL.** The phase should not be terminated as clean while CODEX-PT-A1-HIGH is open.

Recommendation for next-session work:

1. Close CODEX-PT-A1-HIGH in-cycle before V3.6 phase closure. The fix should make `workbookSnapshot()` after `RemoveSheet -> RestoreSheet` include preserved cells, formats, and rendered strings.
2. Add the engine and IDE regressions listed in the HIGH. At minimum, assert restored cell contents after the `workbookSnapshotDelta fullRebuildRequired -> workbookSnapshot()` fallback.
3. Sweep the small `current_work.md` handoff drift with the closure docs.
4. Defer broader items to V3.6.1+ only if they are not part of the closure: a real IDE delta-render migration, napi/JS frame-time benching, and a RestoreSheet-specific Criterion benchmark.
