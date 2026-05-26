# 5.8 Phase 5 Megaudit — LANE C (Opus): cross-sub-phase interaction matrix

**Audited at:** engine source HEAD `1465b1db4c4` (working tree `dfa3d113c90` = docs-only on top; `git log` confirms `841978..3e8c63..dfa3d1` are doc commits, source unchanged). IDE HEAD `d028568b53b` (V3.6.1.2). Read-only static analysis; no source modified.

**Method:** traced actual end-to-end code paths across BOTH repos for each interaction C1–C11. Engine delta path: `crates/ql-bindings-node/src/lib.rs::workbook_snapshot_delta` + `classify_delta_op` + `crates/ql-collab/src/session.rs` cache walker / undo / merge / poll. IDE consumer: `extensions/quantlab/src/quantbook/cellGrid/cellGridLogic.ts` (`acquireWorkbookSnapshotViaDelta`, `mergeWorkbookDelta`, `getSharedDeltaCache`, `dispatchIncomingMessage`) + `cellGrid/cellGridPanel.ts` (`render`, `tickPollRemote`, `safeRender`, typing watchdog).

**Headline:** the delta/snapshot/cache machinery is unusually rigorous. The engine's invalidation discipline (5 log-mutation sites all `force_clear_workbook_cache`) + the conservative `classify_delta_op` allowlist (any metadata/rename op forces `fullRebuildRequired`) + the IDE's two-call protocol form a near-complete divergence safety net. I found **one real latent divergence** (C-HIGH? downgraded to MED because not currently IDE-reachable — see C1 finding #1), **one error-misattribution** (MED), and several INFO/LOW observations. No open HIGH that is reachable through any current IDE write-path.

---

## Findings

### #1 — Local `ClearFormula` / `SetCellFormat(None)` that empties a cache entry emits an EMPTY delta → IDE keeps the stale cell (delta × cache-entry-removal divergence)

- **Severity:** MED (would be HIGH if any IDE write-path emitted a standalone local `Op::ClearFormula` / `Op::SetCellFormat{None}`; today none does — see Reachability).
- **Files:**
  - Engine: `crates/ql-bindings-node/src/lib.rs:2700-2760` (`workbook_snapshot_delta` changedCells builder — the `snapshot_cell(...) -> None => continue` skip at `:2719-2722`) + `:2804` (`removed_cells: Vec::new()` hardcoded).
  - Engine cache walker that removes the entry: `crates/ql-collab/src/session.rs:1530-1535` (`ClearFormula` all-None removal) + `:1548-1561` (`SetCellFormat{None}` all-None removal).
  - IDE: `extensions/quantlab/src/quantbook/cellGrid/cellGridLogic.ts:992-1058` (`mergeWorkbookDelta` — no path drops a cell that the engine cleared, because `removedCells` is `[]` and the cleared cell never appears in `changedCells`).
- **Repro (op sequence; hand to Lane A for empirical confirmation):**
  1. `addSheet(0)`; `appendPutFormula(0,0,0,"=1+1")`.
  2. `workbookSnapshot()` → seed; capture version `V1` (engine cache + IDE shared cache now hold cell (0,0,0) with formula).
  3. Append a *standalone local* `Op::ClearFormula{0,0,0}` (via a future `appendClearFormula` napi, OR a runtime `set_value`-over-formula path that emits a non-batched ClearFormula through `append_op`). Engine cache walker removes (0,0,0) from `last_snapshot` (all fields None).
  4. `workbookSnapshotDelta(V1)`: classify → `ClearFormula` is cell-keyed → `changed_cells.insert((0,0,0))`; no rename → cell-only fast path. `apply_ops_in_range` clears the cell in the cloned workbook. changedCells loop: `snapshot_cell(0,0,0)` → `None` → `continue` (skip). Result: `changedCells=[]`, `removedCells=[]`, `sheetsRemoved=[]`, version advanced.
  5. IDE `mergeWorkbookDelta`: nothing to apply → **shared cache still shows (0,0,0) with formula "=1+1"** while engine truth has the cell cleared. Divergence persists across all subsequent cell-only deltas until something trips `fullRebuildRequired`.
- **Evidence:** The engine's own docstring acknowledges the asymmetry (`lib.rs:2466-2471`: "True removals … invalidate the cache via `force_clear_workbook_cache` → next delta call returns `fullRebuildRequired=true`") — but that promise is only kept for removals that go through merge/undo/discard/poll, NOT for a removal that arrives as a plain `append_op` cell op. A standalone `ClearFormula`/`SetCellFormat{None}` via `append_op` does NOT clear the workbook cache, so the next delta is a cell-only delta that silently drops the now-empty cell. The IDE `removedCells` consumer (`cellGridLogic.ts:1020-1030`) is implemented + fixture-tested but the engine never emits into it. The shape-equivalence divergence guard (`test/quantbook-roundtrip.test.ts:7486-7516`) covers `puts / deleteSheet / renameSheet / undo` — **NOT** ClearFormula or SetCellFormat — so this gap is untested.
- **Reachability (why MED not HIGH):** Confirmed via grep that NO `appendClearFormula`, `appendSetCellFormat`, or `appendRegisterFormat` napi method exists (neither in `crates/ql-bindings-node/src/lib.rs` nor in `extensions/quantlab/src/quantbook/types.ts`). The only producers of `Op::ClearFormula`/`Op::SetCellFormat`/`Op::RegisterFormat` are (a) remote peers' runtime → arrive via `merge_bytes`/`poll_remote` which `force_clear_workbook_cache` → fullRebuild → safe; (b) the rename-repair `BatchCommit` bundled with `Op::RenameSheet` → `classify_delta_op` sets `has_rename=true` → fullRebuild → safe. So today the gap is unreachable from the IDE. It becomes a live HIGH the moment V3.7+ adds a local clear-cell / set-format write-path (the CellValueJson-union-cleanup / formula-clear backlog).
- **Recommendation:** Close the engine contract now (cheap, prevents a latent foot-gun): in `workbook_snapshot_delta`'s changedCells loop, when `snapshot_cell` returns `None` for a coord that WAS present in `cached_arc` (i.e., the cell existed pre-delta and is now gone), emit a `removedCells` entry instead of `continue`-skipping. Alternatively (more conservative, matches existing discipline): make `append_op` `force_clear_workbook_cache()` when an effect's all-None removal actually deletes a cache entry (mirror the merge/undo invalidation). Add a shape-equivalence test step exercising a standalone ClearFormula before V3.7 opens the write-path.

---

### #2 — `render()` throwing inside the putValue commit try-block misattributes a delta/render failure as a cell-write failure (errorReply for a cell that was actually written)

- **Severity:** MED
- **Files:**
  - IDE: `extensions/quantlab/src/quantbook/cellGrid/cellGridLogic.ts:421-461` (`dispatchIncomingMessage` putValue arm: `appendPutValueValidated(...); deps.onCommit();` and `appendPutFormulaValidated(...); deps.onCommit();` are BOTH inside the `try`, with the `catch` at `:451` emitting an `errorReply` keyed to the cell).
  - `deps.onCommit` = `() => this.render()` (`cellGrid/cellGridPanel.ts:866`), and `render()` → `acquireWorkbookSnapshot()` → `workbookSnapshotDelta()` which CAN throw `[session_replay]` (engine `crates/ql-bindings-node/src/lib.rs:2669-2672`).
- **Repro (op sequence):**
  1. Open cell-grid panel; type a value into a cell and commit.
  2. `appendPutValue` succeeds (engine log mutated). `onCommit()` → `render()` → `workbookSnapshotDelta` enters the cell-only fast path and `apply_ops_in_range` fails mid-replay (e.g., a corrupted op surfaced by a concurrent merge, or any `[session_replay]` path).
  3. The throw is caught at `cellGridLogic.ts:451`; the user sees an `errorReply` for the cell ("[session_replay] …") even though the cell WRITE succeeded.
- **Evidence:** The write and the render are not separated. The `[session_replay]` throw path also `force_clear_workbook_cache`s (engine `:2668`), so the NEXT render recovers via fullRebuild — but the immediate UX is a spurious per-cell error on a successful write. (Note the engine `[session_replay]` path is itself a should-not-happen-in-normal-flow path, which is why this is MED not HIGH; but the *misattribution* is a real defect-in-the-error-channel.)
- **Recommendation:** Move `deps.onCommit()` OUT of the write try-block (call it after the write try succeeds, in its own try/catch that logs a render failure without emitting a cell `errorReply`). Mirrors the `tickPollRemote` merged-branch pattern where render failures are handled separately from the merge.

---

### #3 — `WorkbookSnapshotJson` has no `tables` / `names` surface; table + named-range ops never reach the IDE (cache-vs-workbook is fine, but the Phase-5 exit "tables merge" criterion is verified only at the CRDT layer, not the IDE surface)

- **Severity:** INFO (documented scope limitation; not a divergence bug — flagged for the exit-criteria attestation)
- **Files:**
  - Engine: `crates/ql-bindings-node/src/lib.rs:842-900` (`WorkbookSnapshotJson` = `{ sheets, formats, date_system, version }` — no `tables`, no `names`) + `:2121-2123` docstring ("does NOT surface named ranges, tables, spill").
  - `classify_delta_op` correctly forces fullRebuild on every table op (`:399` RenameTable/RenameColumn; `:445-447` CreateTable/DropTable/ResizeTable) and on `SetName` (`:448`).
  - `collect_cache_effects` has NO arm for table ops or SetName (`crates/ql-collab/src/session.rs:1427` `_ => {}`), so tables never touch the cell cache.
- **Evidence:** Tables live in `workbook.tables_mut()` (separate from cell storage; `crates/ql-oplog/src/replay.rs:899-963`). Table ops do not write cell values; formula refs to tables are resolved only at recompute (the napi snapshot surfaces stored `CellState` + repaired formula text, not recomputed table-ref values). So there is NO cache-vs-workbook RENDER divergence from tables (unlike the early RemoveSheet case where the cache walker was tombstone-blind). RenameTable/RenameColumn DO rewrite formula text via `repair_table_rename_chain`/`repair_column_rename_chain`, but they force fullRebuild → IDE re-fetches repaired text. CreateTable/DropTable/ResizeTable force fullRebuild conservatively. The merge-determinism of table ops (DropTable advisory-skip, RenameTable advisory-skip) is a Lane B / replay concern, verified present in `replay.rs:922-963`.
- **Recommendation:** For the Phase-5 exit attestation, record explicitly that "tables + names merge deterministically" is satisfied at the OpLog/Workbook CRDT layer (replay + repair chains + advisory-skip), and that the IDE snapshot surface intentionally does not expose tables/names yet (a product-surface item, not a Phase-5 merge-correctness gap). Lane B/D should pin a multi-peer table-merge convergence test if one does not already exist (`crates/ql-oplog/tests/phase_5_3_step*` cover some of this).

---

### #4 — `workbook_snapshot_delta` monotonicity invariant (op_count slice) is enforced only by a `debug_assert` (release builds can silently produce a wrong delta if the invalidation discipline is ever broken)

- **Severity:** INFO (acknowledged design tradeoff; no current break found)
- **Files:** Engine `crates/ql-bindings-node/src/lib.rs:2609-2617` (`debug_assert_eq!` on `new_ops.len() == current_op_count - cached_op_count`).
- **Evidence:** The delta replay slice `[cached_op_count, current_op_count)` is positional. It is correct ONLY if the only log mutation between cache-populate and the delta call is `append_op` (monotone growth). The 5 mutators (merge/discard/undo/redo/poll) all `force_clear_workbook_cache` (engine `session.rs:1699, 3249, 3808, 3902, 3644`), and `set_workbook_cache` (`:1911-1919`) always re-pins `op_count = log.len()`. I traced all five and confirmed the discipline holds at current HEAD. The risk is a FUTURE 6th log-mutator added without the `force_clear` (the same class as the V3.6.0.8.4 CODEX-HIGH-1 poll-remote miss, which WAS a real escaped gap). In release builds the debug_assert is compiled out → a broken delta would be silent.
- **Recommendation:** Consider a cheap release-safe guard: if `new_ops.len() != current_op_count - cached_op_count`, `force_clear_workbook_cache()` + return `fullRebuildRequired=true` (fail-safe to the recovery path) instead of relying on debug_assert. Cost is one subtraction per delta call. Low priority given the invariant currently holds.

---

### #5 — Multi-panel SHARED delta cache: in-place mutation + per-session `version` token are coherent across DIFFERENT-sheet panels, but the shape-equivalence + shared-cache tests are single-sheet only (coverage gap, not a bug)

- **Severity:** LOW (coverage gap; the path is correct by construction)
- **Files:**
  - IDE: `cellGrid/cellGridLogic.ts:1095-1118` (`acquireWorkbookSnapshotViaDelta` — snapshot+version always advance together in all 3 branches) + `:1141-1154` (`getSharedDeltaCache` per-session `WeakMap`) + `cellGrid/cellGridPanel.ts:761-767` + `:802-854` (`render` reads the shared snapshot synchronously, extracts by sheet id via `extractSheetSnapshot`, never retains it).
  - Test gap: `test/quantbook-roundtrip.test.ts:7464-7484` (shared-cache test) and `:7486-7516` (shape-equivalence) are both SINGLE-sheet.
- **Evidence (why correct):** The shared cache holds ALL sheets; `extractSheetSnapshot` (`cellGridLogic.ts:761-765`) filters by `s.id === sheetId`, so display-order (C5) is decoration-only and a panel always renders its own sheet's cells regardless of which sibling advanced the cache. The engine's per-session workbook cache mirrors the IDE per-session shared cache 1:1 (one `last_snapshot_*` triple), so the first panel to poll after a change rides the cell-only/empty-delta fast path and siblings see same-VV empty deltas. Staleness (`caller_vv != cached_vv`) always forces fullRebuild (engine `:2530-2532`), so a token mismatch can never silently return stale data. JS single-threadedness makes the shared in-place mutation race-free (renders are strictly sequential; `mergeWorkbookDelta` mutates+returns `cached` and the panel consumes it synchronously).
- **Recommendation:** Add a multi-sheet shared-cache test: two `extractSheetSnapshot` consumers on sheets 0 and 1 sharing one cache, interleave edits on both sheets across delta calls, assert each consumer's extracted sheet matches a fresh `workbookSnapshot()` extract. Closes the only meaningful coverage hole for C2/C11.

---

### #6 — Tombstone-window cell writes are dropped consistently in BOTH the cache walker and replay; restore resurfaces only pre-tombstone cells (C3 — CONVERGENT-HIGH-1 area confirmed CLOSED, no residual gap)

- **Severity:** INFO (positive confirmation)
- **Files:**
  - Engine cache: `crates/ql-collab/src/session.rs:1611-1635` (`RemoveSheet` no longer prunes; `RestoreSheet` un-tombstones) + the tombstone gate `:1475-1479` (cell-keyed effects on a tombstoned sheet early-return).
  - Engine replay: `crates/ql-oplog/src/replay.rs:503-505, 520-522, 531-533, 863-865` (PutValue/PutFormula/ClearFormula/SetCellFormat silent no-op on tombstoned sheet) + `:792` `remove_sheet` + `:823` `restore_sheet`.
  - Delta path filter: `crates/ql-bindings-node/src/lib.rs:2698-2706` (changedCells filtered against `removed_sheet_set`); `classify_delta_op` forces fullRebuild on `RestoreSheet` (`:460-461`).
  - Workbook display-order across remove/restore/move: `crates/ql-storage/src/workbook.rs:385-389` (RemoveSheet does NOT touch display_order), `:809-817` (move_sheet), `:467-468` (sheet_count includes tombstoned slots).
- **Repro traced (all CORRECT):**
  - *Cells written DURING tombstone window via delta:* deleteSheet(0)→PutValue(0,1,1,5)[dropped]. delta: sheetsRemoved=[0], changedCells filtered → []. IDE drops sheet 0. CORRECT.
  - *Remove+restore in SAME delta window:* deleteSheet(0)→restoreSheet(0). classify: RemoveSheet pushes id, then RestoreSheet sets has_rename → fullRebuild (removed_sheets discarded). IDE re-fetches; sheet 0 resurfaces with pre-tombstone cells. CORRECT.
  - *Restore in a LATER delta window:* delete in window N (cell-only delta, sheetsRemoved=[0], engine cache advanced to tombstoned WB), restore in window N+1 (RestoreSheet → fullRebuild). full `workbookSnapshot()` reads `snapshot_cells` from `last_snapshot` (pre-tombstone cell preserved, never pruned) + rebuilt Workbook (restored). Both agree; mid-window write absent in both. CORRECT.
  - *Move then remove then restore:* display_order keeps the moved position across the tombstone window; restored sheet reappears at its moved position. CORRECT.
  - *Multi-peer remove+restore via merge:* `merge_bytes`/`poll_remote` force_clear workbook cache + full `rebuild_snapshot_cache` (causal-order walk applies RemoveSheet then RestoreSheet) → next delta = fullRebuild. Convergent. CORRECT.
- **Evidence:** The cache walker (`apply_cache_effect`) and replay (`apply_op`) drop tombstone-window writes by the identical guard, so the cell cache and Workbook never diverge across the tombstone lifecycle. CONVERGENT-HIGH-1 (RemoveSheet pruning cells that RestoreSheet couldn't resurface) is fully closed at this HEAD with regression tests at `session.rs:8081, 8115`.
- **Recommendation:** None. Confirmed closed.

---

### #7 — Format-cache × undo (C4) is correct: SetCellFormat undoes via per-cell partial-invalidate; RegisterFormat undoes via full rebuild; rendered strings are always recomputed from the rebuilt FormatTable

- **Severity:** INFO (positive confirmation)
- **Files:**
  - `crates/ql-collab/src/session.rs:2539-2542` (`SetCellFormat` is cell-keyed in `collect_affected_cells_recursive`) → undo partial-invalidate path `:3818-3833`; RegisterFormat is non-cell-keyed (`:2555` `_ => false`) → undo full `rebuild_snapshot_cache` `:3840`.
  - `invalidate_cell` handles the `SetCellFormat`/`format` field + ghost-entry removal `:2548-1561` (via `apply_cache_effect`).
  - Workbook cache force-cleared on every undo/redo (`:3808, 3902`) → delta returns fullRebuild → `workbook_snapshot` recomputes `rendered` from the rebuilt+repaired `FormatTable` (`lib.rs:2299-2324`), never from a cached rendered string.
- **Evidence:** The V3.6.0.X audit-of-D2 INFO-1 "full-rebuild fallback" claim is verified: RegisterFormat undo → full rebuild; SetCellFormat undo → invalidate_cell (which re-derives format from the log). No stale rendered string can survive an undo because the rendered string is never cached across calls (per-snapshot parse cache only; recomputed each `workbook_snapshot`). The format `Ord`-sort discipline (`lib.rs:2776-2778` delta; `:2376-2377` full) keeps `formats` deterministic across both paths.
- **Recommendation:** None. (Note: SetCellFormat/RegisterFormat undo is not currently IDE-reachable — same Reachability note as finding #1 — but the engine paths are correct.)

---

### #8 — BatchCommit (C6) classified + applied + undone atomically across all effects

- **Severity:** INFO (positive confirmation)
- **Files:**
  - `classify_delta_op` recurses into BatchCommit and short-circuits on the first metadata/rename inner op (`crates/ql-bindings-node/src/lib.rs:408-421`); any non-cell inner op → fullRebuild.
  - `collect_cache_effects` recurses BatchCommit (`session.rs:1374-1378`); `apply_ops_in_range`→`apply_op` recurses BatchCommit (`replay.rs:889-898`).
  - `affected_cells_for_partial_invalidate`/`collect_affected_cells_recursive` recurse BatchCommit, returning None on any non-cell inner op → undo full rebuild (`session.rs:2543-2556`); grouped/merge-interval pushes stage empty cells → undo full rebuild (`session.rs:1308-1314`, the grouped-undo HIGH closure).
- **Evidence:** A homogeneous cell BatchCommit (`{PutValue, ClearFormula}` from the runtime atomic-replace) takes the cell-only delta path and all coords surface in changedCells; a mixed BatchCommit (`{PutValue, RenameSheet}` / `{PutValue, AddSheet}`) forces fullRebuild via the inner classify break. Undo of a grouped/merge-window BatchCommit conservatively full-rebuilds. All atomic.
- **Recommendation:** None.

---

### #9 — SetDateSystem / SetLocale (C8) force fullRebuild and re-render all cells against the new EvalContext; cell-only deltas use the cached workbook's date_system consistently

- **Severity:** INFO (positive confirmation)
- **Files:** `classify_delta_op` SetDateSystem/SetLocale → fullRebuild (`lib.rs:449, 451`); replay applies to workbook (`replay.rs:980-997`); `workbook_snapshot` builds `EvalContext` from `workbook.date_system()`/`workbook.locale()` (`lib.rs:2168-2173`) and the delta cell-only path builds it from `next_workbook` (`lib.rs:2677-2681`).
- **Evidence:** A mid-session date-system change forces a fullRebuild → full `workbookSnapshot()` rebuilds the workbook (picking up the SetDateSystem effect) and re-renders every formatted cell with the new date system. Cell-only deltas only run when NO SetDateSystem is in range, so `next_workbook.date_system()` equals the cache-time value — consistent. CONVERGENT-HIGH-1 of the audit-of-D4 (SetDateSystem ensuring replay applies the loaded value) is referenced and present.
- **Recommendation:** None.

---

### #10 — cell_op_index / sheet_op_index (C9) refreshed on every visible-log mutation; undo/redo retract-compaction covered by `rebuild_op_indices_only`

- **Severity:** INFO (positive confirmation; the release-only debug_assert is finding #4)
- **Files:** `undo`/`redo` call `rebuild_op_indices_only` (cell-keyed retract) or full `rebuild_snapshot_cache` (non-cell) BEFORE the per-cell invalidate (`session.rs:3829/3840, 3915/3921`); merge/poll/discard/from_snapshot rebuild indices via `rebuild_snapshot_cache`; `append_op` updates indices incrementally in `apply_cache_effect` (`session.rs:1499-1510`). Parity test at `session.rs:5435` (`rebuild_op_indices_only` matches full rebuild under tombstones).
- **Evidence:** Every path that mutates the visible log refreshes the positional indices. The delta path's `last_snapshot_op_count` token is re-pinned by `set_workbook_cache` on every snapshot/delta and cleared by every mutator, so a retract-shifted index can never be consumed by a stale delta (the workbook cache is gone after undo).
- **Recommendation:** See finding #4 (promote the debug_assert to a release-safe fail-to-fullRebuild).

---

### #11 — IDE end-to-end consumer flow (C11): no state-divergence path found beyond findings #1 and #2

- **Severity:** INFO (positive confirmation)
- **Files:** `cellGrid/cellGridPanel.ts:802-854` (`render` → `acquireWorkbookSnapshot` → `extractSheetSnapshot` → `buildHtml`) + `:862-911` (`handleIncoming` → `dispatchIncomingMessage`) + `:953-1059` (`tickPollRemote`) + `:352-378` (`safeRender` mid-edit guard) + `:561-718` (typing watchdog) ; `cellGridLogic.ts:235-461` (dispatcher) + `:1095-1154` (delta orchestration + shared cache).
- **Evidence / traced paths (all coherent):**
  - The ONLY snapshot-acquisition path for rendering is `acquireWorkbookSnapshotViaDelta` (verified by grep: no other IDE callsite of `workbookSnapshot`/`workbookSnapshotDelta` exists except inside the orchestrator; `listSheets` at `cellGridPanel.ts:192` is title-only and does not touch the workbook cache). No bypass that advances the engine cache without updating the shared IDE cache.
  - Local edit `onCommit` → render → cell-only delta (append_op doesn't invalidate). Collab merged tick → render → fullRebuild (pollRemote cleared cache). Undo/redo → render → fullRebuild (cleared cache). Sheet commands (`commands/quantbookCommands.ts` addSheet/rename/delete/move → `refreshAll` → `safeRender`) → first panel fullRebuild (metadata op) or sheetsRemoved (deleteSheet), siblings same-VV empty delta. All converge.
  - C10 typing watchdog × deferred render × merge: a deferred render (`_pendingRenderAfterTyping`) always fires AFTER the merge already force-cleared the engine cache, so when it finally runs the delta returns fullRebuild → fresh data. No stale `_pendingRenderAfterTyping` consumes a stale cache. `tickPollRemote` idle/merged branches + `setPresenceTyping`/`resetTypingWatchdog` all clear/fire the deferred render consistently (`cellGridPanel.ts:970-985, 1010-1022`).
  - A `changedCell` for an unknown sheet is defensively skipped (`cellGridLogic.ts:1009-1016`) but is unreachable in normal flow because AddSheet/RestoreSheet (the only live-sheet introducers) force fullRebuild which re-seeds the whole shared cache before any cell-only delta references the new sheet. Confirmed PutValue does NOT auto-create sheets (`replay.rs:1565-1597` `validate_cell` errors on `sheet >= sheet_count`), so the cell-only path can only reference sheets present at cache time → `apply_ops_in_range` cannot hit InvalidSheet on the fast path.
- **Recommendation:** Apply findings #1 (engine removedCells/invalidation for local clears) and #2 (separate render from write try-block).

---

## VERDICT

**PASS with one MED to close in-cycle (#1) + one MED UX fix (#2).** No open HIGH reachable through any current IDE write-path. The cross-sub-phase interaction surface (delta × {undo/redo, merge/poll, sheet-remove/restore/move, format, BatchCommit, date-system, virtualization, presence}) is coherent: the engine's 5-site `force_clear_workbook_cache` discipline + the conservative `classify_delta_op` fullRebuild allowlist + the IDE two-call protocol + per-session shared cache form a complete divergence safety net for every op type EXCEPT a standalone local cell-clear (finding #1), which is latent because no IDE/napi write-path emits a non-batched `Op::ClearFormula`/`Op::SetCellFormat{None}`/`Op::RegisterFormat` today. The CONVERGENT-HIGH-1 (RemoveSheet/RestoreSheet) class is confirmed CLOSED with no residual gap.

**Close finding #1 before V3.7 opens any local clear-cell / set-format / register-format write-path** — at that point it becomes a live HIGH.

### Coverage note (C1–C11)

- **C1 (delta × undo/redo):** FULLY TRACED. Correct — undo/redo `force_clear_workbook_cache` → fullRebuild; shared cache re-seeds. (Engine `session.rs:3808/3902`; IDE test `:7399-7412`.)
- **C2 (delta × merge/poll-remote):** FULLY TRACED. Correct — merge/poll force_clear → fullRebuild; shared cache handles it. (Engine `:1699/3644`; IDE test `:7414-7433`.)
- **C3 (sheet-remove × delta × restore × snapshot):** FULLY TRACED, 5 sub-scenarios incl. multi-peer + tombstone-window writes. Correct/closed (finding #6).
- **C4 (format-cache × undo):** FULLY TRACED. Correct (finding #7). Caveat: SetCellFormat/RegisterFormat undo not IDE-reachable today.
- **C5 (moveSheet display-order × snapshot/delta × remove/restore):** FULLY TRACED incl. move-then-remove-then-restore. Correct (finding #6 display-order sub-trace).
- **C6 (BatchCommit × {undo, delta, cache walker}):** FULLY TRACED. Correct (finding #8).
- **C7 (tables × {snapshot, cache, merge}):** TRACED. Tables not in snapshot/cache (finding #3); merge-determinism at CRDT layer is Lane B's deep dive (I confirmed the advisory-skip + repair-chain code exists but did not run multi-peer table convergence probes — handed to Lane A/B).
- **C8 (SetDateSystem/SetLocale × format render × snapshot):** FULLY TRACED. Correct (finding #9).
- **C9 (cell_op_index × undo retract × invalidate_cell):** FULLY TRACED. Correct (finding #10); release-only debug_assert flagged (finding #4).
- **C10 (mid-edit-render guard / typing watchdog × pollRemote merged tick × delta):** FULLY TRACED. Correct (finding #11 C10 sub-trace).
- **C11 (IDE consumer flow end-to-end):** FULLY TRACED. Coherent except findings #1, #2.

**Could not fully trace empirically:** none statically blocked. Two items handed to the empirical lane (Lane A) for confirmation: (a) finding #1's repro requires a synthetic standalone `Op::ClearFormula` via `append_op` (no napi exposes it — Lane A can construct it through `merge_bytes` of a runtime-produced standalone ClearFormula to confirm the divergence, OR confirm it's truly unreachable); (b) C7 multi-peer table-merge convergence under concurrent CreateTable/RenameColumn/DropTable (Lane A/B empirical probes).
