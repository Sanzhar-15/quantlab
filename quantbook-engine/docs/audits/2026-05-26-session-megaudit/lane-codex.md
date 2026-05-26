# 2026-05-26 Session Mega-Audit - Lane Codex

HEAD confirmed: `302c7243ddc docs(quantbook): LOCK Phase 6 decision-lock (wedge-first, staged; Codex-validated)`.

Diff audited: `git diff dfa3d113c90..302c7243ddc`. The only engine source commit in that range is `ff09a5e17a7` (`crates/ql-collab/src/session.rs`, `crates/ql-bindings-node/src/lib.rs`); the rest is docs.

## Findings

### 1. `workbookSnapshotDelta` can still emit preserved pre-tombstone cells for an already tombstoned sheet

Severity: HIGH

Files:
- `crates/ql-bindings-node/src/lib.rs:2712`
- `crates/ql-bindings-node/src/lib.rs:2729`
- `crates/ql-collab/src/session.rs:2125`
- `crates/ql-collab/src/session.rs:1475`
- `crates/ql-oplog/src/replay.rs:492`
- `crates/ql-bindings-node/src/lib.rs:1577`

Evidence:
- `workbookSnapshotDelta` only filters changed cells against `removed_sheet_ids` gathered from `Op::RemoveSheet` ops in the current delta window (`lib.rs:2708-2715`). It does not filter against the current tombstone set before reading `inner.snapshot_cell(sheet, row, col)` (`lib.rs:2729`).
- The raw `snapshot_cell` accessor returns `self.last_snapshot.get(&(sheet,row,col)).cloned()` with no tombstone check (`session.rs:2125-2127`).
- Public napi `appendPutValue` appends `Op::PutValue` without checking whether the sheet is currently tombstoned (`lib.rs:1577-1601`).
- Replay intentionally no-ops cell writes to removed sheets (`replay.rs:492-505`), while the cache walker also drops post-tombstone cell-keyed effects at the tombstone gate (`session.rs:1475-1477`). That leaves the preserved pre-tombstone state in the raw cache.
- Temporary ql-collab probe passed: after `AddSheet` + `PutValue(0,0,0)=1` + `RemoveSheet(0)`, `is_sheet_removed_in_cache(0)==true` and `snapshot_cell(0,0,0)` still returns value `1`; after a post-tombstone `PutValue(0,0,0)=2`, `snapshot_cell(0,0,0)` still returns value `1`.
- Reachable leak sequence: full snapshot/delta establishes a cached workbook with sheet 0 removed, caller invokes public `appendPutValue(0,0,0,2)`, then `workbookSnapshotDelta(lastRemovedVersion)` classifies a changed cell, does not see a current-window `RemoveSheet`, reads raw `snapshot_cell`, and emits the stale pre-tombstone cell for a sheet still absent from the workbook.

Recommendation:
Filter `workbookSnapshotDelta` changed-cell emission against the current tombstone state, not just same-window removals. The minimal fix is to skip if `inner.is_sheet_removed_in_cache(sheet)` before `snapshot_cell`, or equivalently consult `next_workbook.is_sheet_removed(sheet)` after replay. Add a regression covering post-delete baseline + post-tombstone cell op + delta.

### 2. B#1 `exportSnapshot` fix is correct and minimal, but its test coverage is core-level only

Severity: INFO

Files:
- `crates/ql-bindings-node/src/lib.rs:1756`
- `crates/ql-collab/src/session.rs:1812`
- `crates/ql-collab/src/session.rs:6052`

Evidence:
- `ff09a5e17a7` adds `CollabSession::is_sheet_removed_in_cache(sheet)` as a direct `removed_sheets.contains` check (`session.rs:1812-1814`).
- `export_snapshot` now returns `Vec::new()` when that accessor is true, before reading `snapshot_cells(sheet)` (`lib.rs:1756-1767`). That is the right visibility behavior for a removed sheet and preserves the intentionally tombstone-agnostic cache.
- Existing regression `is_sheet_removed_in_cache_tracks_tombstone_while_snapshot_cells_preserves` verifies the accessor flips true on `RemoveSheet`, false on `RestoreSheet`, while `snapshot_cells` keeps the cell (`session.rs:6052-6086`).
- Temporary ql-collab probe added actual `AddSheet` setup through sheet id 7 and passed: `AddSheet` x8 + `PutValue(7)` + `RemoveSheet(7)` preserved `snapshot_cells(7)` while `is_sheet_removed_in_cache(7)==true`; `RestoreSheet(7)` cleared the tombstone and surfaced sheet 7 via `list_sheets_from_cache`.
- `cargo check -p ql-bindings-node --lib` passed. I did not run `cargo test -p ql-bindings-node` because the known standalone napi lib-test link failure is real for `_napi_*` symbols.

Recommendation:
Keep the B#1 logic. Add a napi/mocha regression for `exportSnapshot(removedSheetId)` when the binding test environment is available, because the current shipped test proves the core predicate, not the JS method shape.

### 3. Tombstone visibility status across cache consumers

Severity: INFO

Files:
- `crates/ql-bindings-node/src/lib.rs:1763`
- `crates/ql-bindings-node/src/lib.rs:2236`
- `crates/ql-bindings-node/src/lib.rs:2714`
- `crates/ql-bindings-node/src/lib.rs:2729`
- `crates/ql-collab/src/session.rs:1780`
- `crates/ql-collab/src/session.rs:2087`
- `crates/ql-collab/src/session.rs:2125`

Evidence:
- `exportSnapshot`: fixed. It checks `inner.is_sheet_removed_in_cache(sheet)` and returns empty entries for tombstoned sheets (`lib.rs:1763-1767`).
- `workbookSnapshot`: filtered. It skips `workbook.is_sheet_removed(sheet_id)` before reading `inner.snapshot_cells(sheet_id)` (`lib.rs:2223-2237`).
- `listSheets` / `list_sheets_from_cache`: filtered. The core enumerator skips `self.removed_sheets.contains(sheet)` (`session.rs:1780-1797`), and the napi wrapper returns that result (`lib.rs:1838-1852`).
- `workbookSnapshotDelta`: partially filtered only for sheets removed in the same delta window (`lib.rs:2708-2715`), but not for sheets already tombstoned before the window; see Finding 1.
- Raw `snapshot_cells` and `snapshot_cell`: intentionally tombstone-agnostic (`session.rs:2087-2097`, `session.rs:2125-2127`). They are safe only if every visibility consumer filters explicitly.
- Non-test direct uses found: `exportSnapshot`, `workbookSnapshot`, `workbookSnapshotDelta`, and the `ql-bindings-node` benchmark. No other production Rust caller of `snapshot_cells` was found.

Recommendation:
Treat `snapshot_cells` / `snapshot_cell` as raw cache accessors in docs and call sites. Any user-visible path must apply `is_sheet_removed_in_cache` or a `Workbook::is_sheet_removed` filter.

### 4. Collaborative table producer remains absent from shipped producer surfaces

Severity: INFO

Files:
- `crates/ql-bindings-node/src/lib.rs:1256`
- `crates/ql-collab/src/session.rs:1233`
- `crates/ql-exec/src/workbook_runtime/tables.rs:162`
- `crates/ql-exec/src/workbook_runtime/tables.rs:308`
- `crates/ql-exec/src/workbook_runtime/tables.rs:447`
- `crates/ql-exec/src/workbook_runtime/mod.rs:182`

Evidence:
- Napi exported mutators are sheet/cell/presence/transport/snapshot methods; grep of `#[napi(js_name = ...)]` shows no `createTable`, `renameTable`, or `renameColumn` binding.
- `WorkbookRuntime` does produce table ops into an attached plain `OpLog`: `CreateTable` (`tables.rs:162`), `RenameTable` (`tables.rs:308`), and `RenameColumn` (`tables.rs:447`).
- That runtime attachment is `WorkbookRuntime::with_oplog(&mut Workbook, &FunctionRegistry, &mut OpLog)` (`mod.rs:182-195`), not a `CollabSession`; grep found no wiring from `WorkbookRuntime` table APIs into the mergeable `CollabSession` producer path.
- `CollabSession::append_op(pub Op)` can accept arbitrary table ops (`session.rs:1233`), and tests do inject them directly. That is a custom/test injection surface, not a shipped collaborative table producer.

Recommendation:
The Phase 5 PASS disposition for table-convergence HIGHs remains valid for shipped producer surfaces. Re-open the table merge HIGHs before exposing any table napi methods or any `WorkbookRuntime`-backed collaborative producer that writes into `CollabSession`.

### 5. Phase 5 package tests are clean except for sandbox-blocked websocket relay integration

Severity: INFO

Files:
- `crates/ql-collab-ws/tests/relay.rs:83`

Evidence:
- `cargo test -p ql-collab`: 255 passed / 0 failed; 6 doctests ignored. This matches the expected 255 pass count.
- `cargo test -p ql-oplog`: 92 passed / 0 failed; 10 ignored defensive probes.
- `cargo test -p ql-storage`: 199 passed / 0 failed; 1 doctest ignored.
- `cargo test -p ql-collab-ws`: library tests passed 10 / 0, then integration tests `two_clients_cross_broadcast` and `third_client_receives_both_streams` failed before exercising relay logic because `TcpListener::bind("127.0.0.1:0")` returned `Operation not permitted` at `relay.rs:83`. This is consistent with restricted network permissions in this execution environment, not evidence of a B#1 regression.
- `cargo check -p ql-bindings-node --lib`: passed.

Recommendation:
Re-run `cargo test -p ql-collab-ws --test relay` in an environment that permits localhost TCP binds. No source change is indicated by this sandbox failure.

## Verdict

The narrow B#1 `exportSnapshot` code change is sound, minimal, and empirically supported at the ql-collab core layer. However, the session's shipped-work closure is NOT fully sound as a tombstone-leak closure: `workbookSnapshotDelta` still has a reachable HIGH leak path through raw `snapshot_cell` for sheets that were already tombstoned before the current delta window.

The table-unreachability disposition remains sound for shipped producer surfaces: no napi or `WorkbookRuntime` wiring emits `CreateTable` / `RenameTable` / `RenameColumn` into a collaborative `CollabSession` op log, aside from direct custom/test `append_op` injection.

Coverage completed: C1 completed with `git show`, existing test review, temporary ql-collab probes, `cargo test -p ql-collab`, and `cargo check -p ql-bindings-node --lib`; C2 completed by grep/read plus raw-cache probe; C3 completed by grep/read of napi, `CollabSession`, `BatchCommit`, and `WorkbookRuntime`; C4 completed for ql-collab, ql-oplog, ql-storage, and ql-collab-ws library tests. ql-collab-ws relay integration could not be completed in this sandbox because localhost bind is denied.
