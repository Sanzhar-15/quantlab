---
name: 2026-05-24_phase-5-7-v3-5-workbook-snapshot-sheet-ops-undo-format
status: in-progress (V3.5 entry plan drafted; V3.5.0.1 decision lock ships in THIS commit -- 5 design decisions (Op-enum cache shape extension, partial-invalidate undo strategy, WorkbookSnapshot napi shape, richer sheet operations, V3.4.0.5c mid-edit-render guard for R-V3.4-3 KNOWN-GAP closure) locked per the V3.4.0.X Opus § F V3.5 ENTRY READINESS packet. V3.5.0.2-V3.5.0.X is the implementation sequence; multi-week arc; expect 6-9 sessions.)
date: 2026-05-24
predecessor_plan: .plans/_archive/2026-05-23_phase-5-7-v3-4-undo-persistence-presence.md (V3.4 phase termination -- undo/redo + .qbook persistence + presence integration; ALL 9 sub-steps SHIPPED + AUDITED including V3.4.0.X cumulative megaudit + closures)
predecessor_v3_4_0_x_audits: docs/audits/2026-05-24-phase-5-7-v3-4-0-x-{codex,opus}.md (V3.4.0.X audit; Opus § F V3.5 ENTRY READINESS is the basis for THIS entry plan)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V3.5 -- IDE-side `rebuild_workbook` consumption + full Op enum cache coverage (formats + names) + partial-invalidate undo strategy + richer sheet operations (rename/delete/reorder) + V3.4.0.5c mid-edit-render guard. The first Phase 5.7 sub-phase that exposes the full `Workbook` across the FFI boundary (V3.4 kept Workbook engine-side-only inside `to_qbook`); enables IDE-side formula rendering + format-aware cell display + sheet management UX. All pre-V3.5 blockers (V3.4.0.X HIGH-1+2+3 + V3.4.0.X MEDIUM-5 iteration-order doc) closed.
current_engine_head: (this commit) V3.5 entry plan + V3.5.0.1 decision lock
current_ide_head: b6a3f48572a (V3.4.0.X IDE closures; unchanged for V3.5.0.1 -- decision lock is engine-only docs)
current_mocha_count: 254 / 254 (V3.4.0.X exit baseline)
current_ql_collab_tests: 81 / 81 (V3.4.0.X exit baseline)
current_ql_collab_ws_tests: 42 / 42 (10 lib + 30 ws + 2 V3.1.a relay)
current_engine_workspace: 4472 / 0 baseline (will grow with V3.5 WorkbookSnapshot napi + sheet-ops napi + partial-invalidate undo + format cache tests)
audit_rules_inherited:
  - Rule 1: Stop fresh-session reminders (2026-05-17)
  - Rule 2: Parallel Codex+Opus per phase/wave/step (2026-05-17)
  - Rule 3: Range-aware fn ships need lex+parse+bind+eval coverage (2026-05-21; not V3.5-relevant; pre-V3.5)
  - Rule 4: Negative trait claims need positive compile proof OR per-field walk (2026-05-21; arc terminus 6, V3.5 expected to add 1+ new structs per D3 WorkbookSnapshot)
type: project
---

# V3.5 -- IDE-side `rebuild_workbook` consumption + full Op enum cache + sheet ops + partial-invalidate undo (Phase 5.7, 2026-05-24)

> **NEW SESSION? START HERE.**

Sister-section to `docs/architecture/ide-consumer-contract.md § 4.1.z5` (V3.5.0.9 docs will land it). This plan is the engine-side scoping document.

## Predecessor closure

V3.4 SHIPPED + AUDITED end-to-end across 2 sessions; all 9 sub-steps complete; 29 audit transcripts cumulative across Phase 5.7. See `.plans/_archive/2026-05-23_phase-5-7-v3-4-undo-persistence-presence.md` for the V3.4 plan archive; `docs/audits/2026-05-24-phase-5-7-v3-4-0-x-{codex,opus}.md` for the V3.4.0.X cumulative megaudit transcripts; `docs/architecture/ide-consumer-contract.md § 4.1.z4` for the V3.4 surface spec + audit closures sub-section.

V3.4 cumulative test deltas: ql-collab 76 -> **81** (+5); IDE mocha 181 -> **254** (+73 V3.4-specific).

## V3.5 scope (per V3.4.0.X Opus § F V3.5 ENTRY READINESS)

V3.5 is the first Phase 5.7 sub-phase that exposes the FULL Workbook across the FFI boundary. V3.4 kept Workbook engine-side-only (`to_qbook` materializes it internally; never crosses FFI). V3.5 surfaces it for IDE-side formula rendering, format-aware cell display, and sheet management UX.

Five major sub-areas:

1. **WorkbookSnapshot napi shape** (D3): expose a flattened, JSON-serializable view of the full Workbook for IDE rendering. NOT a 1:1 mirror of `ql-storage::Workbook` (whose API is large + tightly coupled). A flattened view: sheets + cells + names + formats + tables.

2. **Full Op enum cache coverage** (D1): extend `CellState` to carry format info (V3.4.0.2's value+formula -> V3.5's value+formula+format). RegisterFormat / SetName / RenameSheet land in their own session-wide caches.

3. **Partial-invalidate undo strategy** (D2): V3.4.0.2 always full-rebuilds on undo. V3.5 makes this incremental for cell-keyed ops: undo of `Op::PutValue { sheet, row, col, .. }` pops `(sheet, row, col)` from cache + replays only that cell's op-log subset. Full-rebuild stays for session-wide ops (SetName / RenameSheet).

4. **Richer sheet operations** (D4): `renameSheet(oldName, newName)` / `deleteSheet(name)` / `moveSheet(name, newIndex)` napi + IDE multi-sheet UX integration.

5. **R-V3.4-3 KNOWN-GAP closure** (D5 / V3.4.0.5c follow-up): host-level mid-edit-render guard. `presenceRepaintInFlight` boolean OR typing-counter checked in `tickPollRemote` before `render()` -- skip the render and re-queue for the next tick if mid-edit. Closes the host-driven `webview.html` rebuild during mid-edit `<input>` destroy hazard.

## V3.5 design decisions (locked at V3.5.0.1)

### D1 Op-enum cache shape extension

**Question:** how does `CellState` extend for richer Op variants?

**Options:**
- (a) Extend `CellState` with `format: Option<FormatId>` for cell-keyed format ops (SetCellFormat). RegisterFormat / SetName / RenameSheet land in SEPARATE session-wide HashMaps on `CollabSession`.
- (b) Promote `last_snapshot` to a richer `CacheState { cells, formats, names, tables }` with sub-maps per Op category. Each sub-map gets its own per-Op invalidation discipline.

**Tradeoffs:**
- (a) is minimal-divergence from V3.4.0.2; per-field LWW pattern carries cleanly; new fields = new positive Rule 4 walks but no architectural change.
- (b) is forward-compat for V3.6+ when cache may serve queries beyond `snapshot_cells` (e.g., `snapshot_formats`, `snapshot_names`). But V3.5 doesn't need (b) yet.

**Decision: A.** Extend `CellState` with `format: Option<FormatId>` for V3.5.0.5. Session-wide format/name/table state stays on `Workbook`; V3.5's WorkbookSnapshot napi (D3) surfaces them by flattening the Workbook. V3.6+ can promote to (b) if profiling shows the cache needs to serve more queries.

**Rule 4 trigger:** YES. `CellState` field walk must re-run when `format: Option<FormatId>` lands. `FormatId` is `enum { Builtin(u32), Custom(PeerId, u32) }` per D-1; both variants are `Send + Sync` (audited at D-1 megaudit step 8). Composition with `Option<T>` + the existing CellState fields preserves Send + Sync. Arc terminus stays at 6 if the walk is done correctly.

### D2 Partial-invalidate undo strategy

**Question:** undo's cache invalidation -- full-rebuild (V3.4.0.2 current) or partial-invalidate (V3.5+ goal)?

**Options:**
- (a) Always partial-invalidate. Undo of `Op::PutValue { sheet, row, col, .. }` pops `(sheet, row, col)` from cache + walks only the subset of ops touching that cell to reconstruct LWW. Same for PutFormula / ClearFormula. Session-wide ops (SetName etc.) trigger full-rebuild.
- (b) Always full-rebuild (current V3.4.0.2 behavior). Simple, slow at scale.
- (c) Profile-driven: full-rebuild until `op_count > N`, then switch. Adds complexity.

**Tradeoffs:**
- (a) is the V3.5 user-visible improvement (undo on a 100k-cell workbook becomes O(cell-op-history) instead of O(N)). Adds complexity in the cache-update path.
- Full-rebuild remains the fallback for any cache-cold or invariant-violation case.

**Decision: A** (partial-invalidate for cell-keyed ops; full-rebuild for session-wide ops). V3.5.0.6 implementation: new `invalidate_cell(&mut self, sheet, row, col)` method on CollabSession that walks `self.log.iter()` filtering by `(sheet, row, col)` + replays into a fresh `CellState`. `undo()` / `redo()` for cell-keyed Op variants call `invalidate_cell` only; non-cell-keyed Op undo falls back to `rebuild_snapshot_cache`.

**Risk:** the iteration-order invariant (V3.4.0.X Opus M5 closure) MUST hold for partial-invalidate's correctness. Pin a regression test that compares partial-invalidate result against full-rebuild on the same op log.

### D3 WorkbookSnapshot napi shape

**Question:** what shape does the napi expose for IDE-side rendering?

**Options:**
- (a) Mirror full `ql-storage::Workbook` API across FFI (sheets, cells, names, formats accessors). Large API surface; tightly coupled to internal types.
- (b) Flattened JSON-serializable snapshot: `WorkbookSnapshot { sheets: Vec<SheetSnapshot>, names: Vec<NamedRangeJson>, formats: Vec<FormatDefJson> }` where each SheetSnapshot has `{ id, name, cells: Vec<CellSnapshot> }`. JSON-friendly; mirrors V3.4.0.2 CellState pattern at higher level.
- (c) Lazy: cell-by-cell accessors (`get_cell(sheet, row, col)`) without snapshot. Avoids the large-payload cost but doesn't fit the V3.5 IDE renderer (which wants a full state to render at once).

**Tradeoffs:**
- (b) is the V3.5 sweet spot. Pre-flattened; IDE iterates once; CSP-safe data-block embedding.
- (a) couples engine internals to napi. Avoid.
- (c) doesn't support the IDE renderer's batch read pattern.

**Decision: B.** WorkbookSnapshot napi struct with `#[napi(object)]`. Field design:
```rust
#[napi(object)]
pub struct WorkbookSnapshotJson {
    pub sheets: Vec<SheetSnapshotJson>,
    pub names: Vec<NamedRangeJson>,
    pub formats: Vec<FormatDefJson>,
}
#[napi(object)]
pub struct SheetSnapshotJson {
    pub id: u16,
    pub name: String,
    pub cells: Vec<CellSnapshotJson>,
}
#[napi(object)]
pub struct CellSnapshotJson {
    pub row: u32,
    pub col: u32,
    pub value: Option<CellWireValueJson>,
    pub formula: Option<String>,
    pub format: Option<FormatIdJson>,
}
```
(Exact field shape may evolve at V3.5.0.2 implementation; the shape above is the entry plan.)

**Performance note:** large workbooks (100k+ cells) will produce large JSON. V3.6+ may add incremental snapshot deltas; V3.5 ships the full snapshot.

**Rule 4 trigger:** YES. 4 new `#[napi(object)]` structs (`WorkbookSnapshotJson`, `SheetSnapshotJson`, `CellSnapshotJson`, plus `NamedRangeJson` + `FormatDefJson` + `FormatIdJson` etc.). All field-by-field walks. Composition of primitives + Option<T> + Vec<T>. Arc terminus stays at 6 with positive Send + Sync walks.

### D4 Richer sheet operations

**Question:** which sheet operations does V3.5 surface?

**Required (from Opus § F item 7):**
- `renameSheet(oldName, newName)` -> emits `Op::RenameSheet`.
- `deleteSheet(name)` -> emits `Op::RemoveSheet` (engine: verify this exists per Phase 4.8.i.2 work; add if missing).
- `moveSheet(name, newIndex)` -> reordering.

**Decision: ALL THREE shipping at V3.5.0.3.** napi + IDE typed wrappers + IDE multi-sheet command integration (`quantlab.quantbookSheetRename` / `...SheetDelete` / `...SheetMove`).

**Pre-V3.5 engine audit:** verify `Op::RenameSheet` + `Op::RemoveSheet` + (any reorder Op) exist on `ql-oplog/src/op.rs`. If not, V3.5.0.3 adds them.

**IDE UX caveat:** sheet deletion is destructive; the IDE command MUST `showWarningMessage` with confirmation before emitting the op. Sheet rename is non-destructive but cross-references in formulas need `repair_sheet_rename_chain` from Phase 5.3 -- verify the V3.5 napi calls trigger repair correctly.

### D5 R-V3.4-3 mid-edit-render guard (V3.4.0.5c carry)

**Question:** how does V3.5 close the R-V3.4-3 KNOWN-GAP (host-driven `webview.html` rebuild during mid-edit `<input>` lifetime destroys the input)?

**Options:**
- (a) Boolean flag `presenceRepaintInFlight` set by dispatcher's `presenceUpdate` arm when `state.typing === true`, cleared on `state.typing === false`. `tickPollRemote` checks the flag before `render()`; if true, skip + re-queue.
- (b) Counter `activeEditCount` incremented on each `typing: true`, decremented on each `typing: false`. Allows multi-cell edit tracking (V3.6+).
- (c) Direct check: query the panel's webview state via `vscode.window.activeTextEditor`-style accessor. Requires new API surface.

**Tradeoffs:**
- (a) is the minimal V3.4.0.5c fix; matches the V3.4.0.1 D4 boolean-flag race-guard pattern (mirrors `activeInput` from V3.3.0.4).
- (b) is forward-compat for V3.6+ multi-cell edit scenarios.
- (c) is the cleanest but requires more design + new API.

**Decision: A.** Boolean flag `presenceRepaintInFlight` on `CellGridPanel`. Set by dispatcher when `presenceUpdate.state.typing === true`; cleared when `typing === false`. `tickPollRemote` at line ~474-492 in `cellGridPanel.ts` checks the flag before calling `this.render()` on `merged` ticks; if true, skip the render + log + re-queue (the next merged tick will fire render). The re-queue path avoids losing the merged ops -- the cache is updated by `pollRemote()`'s engine call BEFORE the render gate; only the visual repaint is deferred.

**Risk:** stale-presence + transport-disconnect could leave `presenceRepaintInFlight = true` forever, blocking all renders. Mitigation: re-init the flag to false on `CellGridPanel.show()` + on `attachTransport` lifecycle.

**Test coverage:** mocha pin for the host-level guard logic (separate from the webview script's `activeInput` guard which V3.3.0.4 covers).

## V3.5 sub-step rollout (planned)

1. **V3.5.0.1 -- decision lock** ✅ SHIPPED at engine (THIS commit, docs-only). Decisions D1-D5 above.
2. **V3.5.0.2 -- engine `WorkbookSnapshot` napi (D3).** New `#[napi(object)]` structs `WorkbookSnapshotJson` + `SheetSnapshotJson` + `CellSnapshotJson` + `NamedRangeJson` + `FormatDefJson` + `FormatIdJson`. New napi method `CollabSession.workbookSnapshot() -> WorkbookSnapshotJson` that calls `inner.rebuild_workbook(&default_registry())` + flattens to JSON via field mappings. Engine-only; IDE consumption is V3.5.0.4. Rule 4 per-field walks on each new struct.
3. **V3.5.0.3 -- engine sheet operations napi (D4).** New napi methods `renameSheet(oldName, newName)` + `deleteSheet(name)` + `moveSheet(name, newIndex)`. Append corresponding Ops (`Op::RenameSheet`, etc.). Engine-side pre-audit: verify these Op variants exist in `ql-oplog/src/op.rs`; add any missing.
4. **V3.5.0.4 -- IDE WorkbookSnapshot consumption + sheet management UI commands.** New IDE typed wrapper `workbookSnapshot(session): WorkbookSnapshotJson`. New IDE commands `quantlab.quantbookSheetRename` (showInputBox for newName) + `quantlab.quantbookSheetDelete` (showWarningMessage confirmation) + `quantlab.quantbookSheetMove` (showQuickPick for newIndex). package.json + package.nls.json registration.
5. **V3.5.0.5 -- engine `CellState` format extension + RegisterFormat handling (D1).** `CellState` adds `format: Option<FormatId>` field. `collect_cache_effects` recurses on `Op::SetCellFormat` / `Op::RegisterFormat`. Per-field walk extension (Rule 4 trigger). Mocha tests for cell-keyed format LWW.
6. **V3.5.0.6 -- engine partial-invalidate undo (D2).** New `invalidate_cell(&mut self, sheet, row, col)` method on CollabSession. `undo()` / `redo()` dispatch: cell-keyed Op variants call `invalidate_cell`; non-cell-keyed Op fall back to `rebuild_snapshot_cache`. Regression test comparing partial-invalidate result against full-rebuild on the same op log.
7. **V3.5.0.7 -- IDE mid-edit-render guard (D5 / R-V3.4-3 KNOWN-GAP closure).** New `presenceRepaintInFlight: boolean` field on `CellGridPanel`. Dispatcher's `presenceUpdate` arm sets/clears the flag based on `state.typing`. `tickPollRemote` checks the flag before `this.render()` on merged ticks; skips + logs if true. Reinit on `show()` + `attachTransport`. Mocha pin for the guard logic.
8. **V3.5.0.8 -- mocha + ql-collab tests** (~20-30 new): cell-keyed undo partial-invalidate matches full-rebuild; sheet rename/delete/move round-trip via WorkbookSnapshot; format-cache LWW + cross-peer convergence; mid-edit-render guard prevents `<input>` destruction; WorkbookSnapshot napi shape stability across V3.5 sub-step iterations.
9. **V3.5.0.9 -- docs.** New `ide-consumer-contract.md § 4.1.z5` section (mirrors V3.4.0.7 § 4.1.z4 structure) covering: WorkbookSnapshot napi surface + flattened-view contract; full Op enum cache (CellState format extension + session-wide format/name caches on Workbook); partial-invalidate undo contract; richer sheet operations (rename/delete/move + Phase 5.3 repair-chain integration); mid-edit-render guard; V3.5 risk register R-V3.5-1..N; drift hazards for V3.6+ maintainers; out-of-scope items; live smoke procedure (steps 12-15 extending V3.4.0.7 steps 7-11: sheet rename / delete / move; format editing; workbook snapshot inspection in webview devtools).
10. **V3.5.0.X -- parallel Codex+Opus megaudit + closures** (per Rule 2; mirrors V3.2.d / V3.3.0.X / V3.4.0.X 2-lane pattern). Codex Lane A: protocol/correctness over the new napi surface (WorkbookSnapshot serialization correctness + partial-invalidate undo cache invariants + sheet rename/delete/move repair-chain interaction + format LWW semantics). Opus Lane B: adversarial per-field walks on new napi structs (WorkbookSnapshotJson + SheetSnapshotJson + CellSnapshotJson + NamedRangeJson + FormatDefJson + FormatIdJson + CellState format-extension) + partial-invalidate undo design audit + V3.5.0.7 mid-edit-render guard correctness + R-V3.4-3 final closure verification + V3.6 entry-readiness analysis. Cross-lane convergent HIGHs MUST close in-cycle.

## V3.5 risk register

- **R-V3.5-1 WorkbookSnapshot napi serialization performance.** Large workbooks (100k+ cells) produce large JSON payloads at every snapshot call. V3.5 ships the full snapshot; V3.6+ may add incremental deltas. Document the per-call O(N) cost in the napi docstring. Mitigation: IDE callers should batch snapshot calls (don't call per-keystroke).
- **R-V3.5-2 Partial-invalidate undo correctness under causal reorder.** V3.5.0.6 partial-invalidate replays the op-log subset filtered by `(sheet, row, col)`. The replay MUST preserve Loro's causal-merge iteration order for the filtered subset. Regression test: build an op log with concurrent cross-peer writes on the same cell, undo a local write, compare partial-invalidate result against full-rebuild. If they diverge, partial-invalidate is broken.
- **R-V3.5-3 Sheet rename/delete/reorder Op semantics across peers.** Cross-peer convergence: two peers concurrently renaming the same sheet to different names -- which name wins? LWW per (op_index, peer_id) per Loro convention. Document the convergence behavior + add cross-peer mocha pin. Sheet deletion: if Peer A deletes sheet 3 + Peer B writes to sheet 3 concurrently, what happens at merge? Phase 5.3 conflict-resolution may have prior art; verify before V3.5.0.3 ship.
- **R-V3.5-4 Format ops cache invalidation.** SetCellFormat is per-cell (CellState.format extension); RegisterFormat is session-wide (separate cache OR Workbook state). The two have different invalidation triggers: SetCellFormat invalidates ONE cell entry; RegisterFormat invalidates EVERY cell using that FormatId. V3.5.0.5 must wire both correctly; cross-validation test required.
- **R-V3.5-5 Mid-edit-render guard false-positives.** If `presenceRepaintInFlight` gets stuck true (transport disconnect mid-typing; engine error mid-presenceUpdate), all subsequent renders are blocked indefinitely. Mitigation: reinit on `show()` + `attachTransport`; possibly also a watchdog timer that clears the flag after N seconds of no presence updates.
- **R-V3.5-6 Cross-restart UserIdentity** -- DEFERRED from V3.4.0.4b D5 to V3.4.1+. Envelope v3 + `user_identity: Option<UserIdentity>` field land IF user-facing "show my contributions" feature surfaces. V3.5 explicitly does NOT ship this; the PeerId-fresh-per-session contract is preserved.
- **R-V3.5-7 WorkbookSnapshot napi struct evolution.** V3.5 ships 6 new `#[napi(object)]` structs. Future field additions (V3.6+ for richer format / chart / pivot state) are API-breaking for IDE consumers that destructure the JSON shape. Mitigation: document the "extend never reshape" contract for these napi objects; consider `#[non_exhaustive]` if napi-rs supports it (verify -- the Opus L1 finding flagged this for `PresenceStateJson` too).

## V3.5 out of scope

- IDE-side `rebuild_workbook` ROUND-TRIP (Workbook -> mutate -> workbook -> back). V3.5 is read-only IDE-side consumption (WorkbookSnapshot is a snapshot, not a live handle). V3.6+ may add a live-Workbook surface if formula re-evaluation in the IDE needs it.
- Full Op enum cache for ALL session-wide ops. V3.5.0.5 ships SetCellFormat / RegisterFormat. SetName / RenameSheet / RemoveSheet / etc. continue to live on Workbook state and are surfaced via WorkbookSnapshot (D3) on demand; their cache invalidation is the full-rebuild path.
- Per-peer color hashing for presence decoration. V3.4.1+ polish.
- Envelope v3 schema bump for UserIdentity. V3.4.1+ if attribution feature surfaces (R-V3.5-6).
- WorkbookSnapshot incremental deltas. V3.6+ if profiling shows the full snapshot cost is too high.
- vscode-test command-flow tests (Opus V3.4.0.X recommendation). V3.5.1+ test-infrastructure investment.
- Threshold-based `sweepPresence` variant. Waits on engine `sweep_presence_with_threshold(secs)`; V3.4.1+ or V3.5.1+.
- `WorkbookRuntime::set_value` recompute integration (live formula re-eval on the IDE side). V3.6+ explicit decision; V3.5 IDE renders formula TEXT but does NOT re-evaluate formulas (the engine's recompute pass produces the cached values via `rebuild_workbook`).

## V3.5.0.X audit transcript pre-allocation

- Codex Lane A: `docs/audits/<YYYY-MM-DD>-phase-5-7-v3-5-0-x-codex.md`
- Opus Lane B: `docs/audits/<YYYY-MM-DD>-phase-5-7-v3-5-0-x-opus.md`

Expected ~16-18 hours of total wall time across 6-9 sessions for the full V3.5 arc.

## V3.6+ entry-readiness preview (deferred from V3.5)

Out-of-scope items above plus:
- Live formula re-evaluation in IDE-side rendering (requires `rebuild_workbook` round-trip + WorkbookRuntime exposure).
- WorkbookSnapshot incremental deltas.
- Per-peer color hashing presence polish.
- vscode-test command-flow tests infrastructure.
- Chart / pivot table napi surfaces (Phase 4 product features now exposable via WorkbookSnapshot).
- `CacheState { cells, formats, names, tables }` promotion (V3.5 D1 option (b) if profiling justifies).

These are explicitly NOT V3.5 work; deferred to V3.6 entry-readiness analysis at V3.5.0.X Opus § F.
