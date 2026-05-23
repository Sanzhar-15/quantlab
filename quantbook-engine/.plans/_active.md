---
name: 2026-05-23_phase-5-7-v3-4-undo-persistence-presence
status: in-progress (V3.4.0.1 lock `a87c31eed4f`; V3.4.0.2 cache `1ae59a1a1aa`; V3.4.0.3 undo/redo engine `7d63ff53132` + IDE `673792af05f`; V3.4.0.5a presence napi engine `5ce55f65739` + IDE `8ff2d81f1e4`; V3.4.0.5b IDE presence engine `cd26a37b513` + IDE `1744cee11af`; V3.4.0.4a engine napi engine `bef220d7d3c` + IDE `ec9b59db8a5`; **V3.4.0.4b IDE commands + UUID PeerId shipped** at engine (THIS commit; plan only) + IDE (paired) +4 mocha (224 -> 228) with D5 deviation documented. V3.4.0.7 docs § 4.1.z4 is the only remaining V3.4 ship sub-step before V3.4.0.X audit.)
date: 2026-05-23
predecessor_plan: .plans/_archive/2026-05-22_phase-5-7-v3-3-multi-sheet-virtualization.md (V3.3.0 phase termination -- multi-sheet + virtualization scaffold + 2-lane megaudit + 10 in-cycle closures)
predecessor_exit_packet: docs/phase5/5-7-v3-2-exit-packet.md (V3.2 closure -- cell-grid UI vertical slice; V3.3 carries no exit packet per V3.3 plan -- V3.3.0.X megaudit transcripts provide the canonical record)
predecessor_v3_3_0_x_audits: docs/audits/2026-05-23-phase-5-7-v3-3-0-x-{codex,opus}.md (V3.3.0.X audit; Opus § V3.4 ENTRY READINESS is the basis for THIS entry plan)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V3.4 -- undo/redo binding + .qbook persistence + presence integration with cell-grid. The first Phase 5.7 sub-phase that exercises Loro's full CRDT surface (undo retraction; persistence round-trip; presence merge). All pre-V3.4 blockers (V3.3.0.X H1+H2+M1+M5) closed.
current_engine_head: (this commit) V3.4.0.4b plan update with D5 deviation rationale (engine code unchanged from V3.4.0.4a `bef220d7d3c`)
current_ide_head: (this commit) V3.4.0.4b IDE -- generateUuidPeerId helper + quantbookSaveAs/Open commands + package.{json,nls.json} registration + 4 mocha tests
current_mocha_count: 228 / 228 (V3.4.0.4b adds +4 over 224)
current_ql_collab_tests: 79 / 79 (unchanged; V3.4.0.4b is IDE-only)
current_ql_collab_ws_tests: 42 / 42 (10 lib + 30 ws + 2 V3.1.a relay)
current_engine_workspace: 4472 / 0 baseline (will grow with V3.4 persistence napi + undo napi + presence napi tests)
audit_rules_inherited:
  - Rule 1: no fresh-session reminders
  - Rule 2: parallel Codex+Opus per major sub-step (carries from V3.2.d / V3.3.0.X precedent)
  - Rule 4: negative trait claims need positive compile proof OR per-field walk. Arc terminus = 6. V3.4 will introduce new Rust state (extended `CellState` cache value type; UUID PeerId derivation; .qbook envelope wrapping) -- per-field walks REQUIRED at each engine sub-step audit.
session_cycles_budget: 2 cycles per session per CLAUDE.md global rule. V3.4 is multi-week; expect 6-9 sessions (more than V3.3 because the surface is wider: undo + persistence + presence are 3 orthogonal axes).
v3_4_progress_summary: V3.4.0.1 decision lock shipping this commit. V3.4.0.2 hybrid cache shape + V3.4.0.3 undo napi + V3.4.0.4 .qbook persistence + V3.4.0.5 presence integration + V3.4.0.6 mocha + V3.4.0.7 docs + V3.4.0.X audit = 8 sub-steps planned.
---

# Phase 5.7 V3.4 -- Undo/Redo + .qbook Persistence + Presence Integration (Plan)

V3.4 is the first Phase 5.7 sub-phase that exercises Loro's full CRDT surface. V3.3.0 shipped the cell-grid scale-out; V3.4 ships the CRDT primitives that make the cell-grid a real workbook (not just a transient view).

Three orthogonal axes land in V3.4:

1. **Undo / redo** -- the Loro `UndoManager` already exists (used internally since V1; `CollabSession::undo` / `redo` shipped at V3.3.0.X HIGH-1 closure with cache invalidation). V3.4 binds them via napi + wires IDE Cmd-Z / Cmd-Shift-Z.
2. **`.qbook` persistence** -- `crates/ql-io/src/qbook_format.rs` ships the v2 envelope format (TOML + per-sheet JSONL, since Phase 2A.8 megaudit). V3.4 binds `to_qbook(path)` + `from_qbook(path, peerId)` via napi + wires IDE Open / Save As commands.
3. **Presence integration with cell-grid** -- `crates/ql-collab/src/presence.rs` + `CollabSession::update_presence` / `peer_presence` / `clear_presence` / `sweep_presence` shipped at Phase 5.6 V1 + V2. V3.4 wires presence-state data block into the cell-grid webview; renders peer cursors as cell decorations.

## Scope

V3.4 is **NOT** a full feature build. It is:

1. **V3.4.0** -- baseline undo + persistence + presence (~2-3 weeks; 8 planned sub-steps).
2. **V3.4.1+** (later entry plans) -- advanced undo (multi-cell groups, undo-redo-history navigation); persistence polish (auto-save, conflict resolution); presence polish (named users, cursor colors).

V3.4 explicitly **DOES NOT** include:

- `rebuild_workbook` routing into a fresh `Workbook` (V3.5+ -- the V3.3.0 incremental cache is the V3.4-scope alternative)
- Full Op enum coverage of the cache for non-cell ops (`SetName`, `AddSheet`, etc. land via separate engine state, NOT through the unified cell-state cache; see D1)
- Cloud / WAN persistence (V3.x productionization)
- Real-time presence cursors with smooth animation (V3.4.1+)
- Optimistic rendering revisit (still N/A at localhost; V3.x WAN may revisit per V3.2.b.1 B4 + V3.3.0.1 D5)
- Push API for inbound observation (still deferred to V3.x; V3.2.c.1 C2 + V3.3.0.1 D6 carry)

## V3.4.0 -- design decisions (V3.4.0.1, LOCKED 2026-05-23)

Per V3.3.0.X Opus § V3.4 ENTRY READINESS (transcript at `docs/audits/2026-05-23-phase-5-7-v3-3-0-x-opus.md` lines 753-844). Five decisions:

### Decision D1: Op-enum cache shape

**Question:** how does the V3.3.0.3 `last_snapshot: HashMap<(u16, u32, u32), CellWireValue>` cache extend to cover Op variants beyond `PutValue`?

The `Op` enum at `crates/ql-oplog/src/op.rs:43` has many variants the V3.3.0 cache doesn't yet model: `PutFormula`, `ClearFormula`, `SetName`, `AddSheet`, `RenameSheet`, `RegisterFormat` (D-1), `SetCellFormat` (D-1), etc. V3.4 needs cache support for at least `PutFormula` + `ClearFormula` (cell-keyed) to support undo round-trips through the cache cleanly.

**Options:**
- **A. Per-variant cache** -- one `HashMap` per Op kind. E.g., `put_value_cache: HashMap<(sheet, row, col), CellWireValue>`, `put_formula_cache: HashMap<(sheet, row, col), String>`, etc. Preserves Op fidelity per-variant.
- **B. Unified per-cell `CellState`** -- one `HashMap<(sheet, row, col), CellState>` where `CellState { value: Option<CellWireValue>, formula: Option<String>, format: Option<FormatId> }`. One lookup per cell; queries like "what is the state of this cell" are O(1).
- **C. Hybrid** -- unified `HashMap<(sheet, row, col), CellState>` for cell-keyed ops (PutValue, PutFormula, ClearFormula, SetCellFormat). Separate first-class engine state for non-cell-keyed ops (`Workbook::sheets` for AddSheet/RenameSheet; `Workbook::names` for SetName; etc.) -- these already exist on `Workbook` and don't need cache mirroring.

**Recommendation: C (hybrid).**

**Rationale:**
- Cell-keyed ops naturally share the `(sheet, row, col)` key. One HashMap = one allocation + one hash per cell read. Per-variant duplicates the key.
- Non-cell-keyed ops have natural homes already: `Workbook::sheets()` returns sheet list; `Workbook::names()` returns the NameTable. The cache should NOT shadow these (would create a second source of truth + invalidation hazard).
- Maps cleanly to existing `CellWireValue` shape: `CellState.value` is `Option<CellWireValue>` (None means "no PutValue/Pending observed; might exist as a formula-only cell"). `CellState.formula` carries the text from `PutFormula`; `ClearFormula` writes `None`.
- Allows future format support (`SetCellFormat` writes `CellState.format`) without re-shaping the cache.
- Read path stays simple: `snapshot_cells(sheet) -> Vec<((u32, u32), CellState)>` (one method covers what V3.3.0's PutValue-only + future formula+format would otherwise need 3 methods for).

**Decision: C.** Implementation phasing:
- V3.4.0.2 introduces `CellState` with at least `value: Option<CellWireValue>` + `formula: Option<String>`. `ClearFormula` mutation handled.
- V3.4.0.2 PRESERVES the V3.3.0.3 napi `export_snapshot` return shape (the `value: CellValueJson` discriminated union) -- the cache shape is INTERNAL; the JSON shape is the IDE contract.
- V3.5+ extends `CellState` with `format: Option<FormatId>` when SetCellFormat caching becomes needed.

### Decision D2: Undo/redo cache invalidation strategy

**Question:** the V3.3.0.X HIGH-1 closure made `undo` / `redo` call `rebuild_snapshot_cache()` when consumed. V3.4 binds undo via napi; should it stay full-rebuild, or move to partial-invalidate?

**Options:**
- **A. Full rebuild** (current V3.3.0.X HIGH-1 closure). O(N) per undo/redo. Simple, proven correct.
- **B. Partial invalidate** -- new `invalidate_cells(cells: Vec<CellKey>)` accessor; the undo path tracks which cells the inverse op touched + invalidates only those. O(undo-group-size).
- **C. Hybrid** -- partial when undo group is single-cell or single-op; full when "large" (multi-cell `BatchCommit`).

**Recommendation: A (full rebuild).**

**Rationale:**
- V3.3.0.X full-rebuild already shipped + tested (`undo_invalidates_snapshot_cache` ql-collab test at engine `73e31df1737`). Working code.
- Loro's `UndoManager::undo` / `::redo` return `bool` (consumed yes/no) but do NOT expose the set of cells affected by the consumed group. Tracking it ourselves requires reading the visible op-log's tail after undo and diffing -- complex + race-prone.
- O(N) per undo is acceptable at V3.4 scale (undo is user-initiated, ~1/sec max; V3.4 typical workbook is hundreds-to-thousands of ops). At V3.5+ scale (10K+ ops), partial invalidate is a clean follow-on refactor -- `last_snapshot` + `rebuild_snapshot_cache` are private internal state; nothing externally depends on the strategy.
- Partial-invalidate has correctness hazards: if the diff misses a cell (e.g., `BatchCommit` containing nested PutValues per V3.3.0.X Codex out-of-scope item), the cache silently desyncs. Full rebuild has no such failure mode.

**Decision: A.** Defer partial-invalidate to V3.5+ if profiling justifies. The `force_clear_snapshot_cache` test seam shipped at V3.3.0.X MEDIUM-5 already supports future partial-invalidate regression tests.

### Decision D3: Persistence schema versioning gate

**Question:** when V3.4 ships `to_qbook(path)` / `from_qbook(path, peerId)`, which version field gates the format -- envelope-level or snapshot-wrapper-level?

**Existing state** (per `crates/ql-io/src/qbook_format.rs`):
- Envelope = `workbook.toml` with `schema_version: u32`. Currently **v2** (Phase 2A.8 megaudit landed this).
- v1 -> v2 migration already shipped + tested.
- Per-sheet `sheets/N.jsonl` files; sparse representation; one CellRecord per non-blank cell.

**Options:**
- **A. Envelope-level via existing `schema_version`** -- V3.4 extends the format to v3 if a new field is added; otherwise reuses v2 as-is.
- **B. Snapshot wrapper** -- new per-snapshot inline version field; engine emits both envelope version + snapshot version.
- **C. Both** -- belt-and-suspenders.

**Recommendation: A (envelope-level via existing v2 `schema_version`).**

**Rationale:**
- The format ALREADY EXISTS. Phase 2A.8 shipped v2. V3.4 reuses it = zero new schema design work.
- v1 -> v2 migration is the proven pattern (see `qbook_format.rs` "Compatibility policy" section). v2 -> v3 follows the same.
- D-1 ship at Tier D3 (2026-05-20) established the same envelope-level versioning pattern for `oplog.bin` (`OPLOG_MAGIC = b"QLOL"` + BE u32 schema version). The engine is consistent across formats.
- Snapshot wrapper would mean TWO version numbers in flight (envelope + snapshot) -- redundant + confusing.

**Decision: A.** V3.4 ships .qbook persistence at **v2** (no new fields needed). Bump to **v3** ONLY if V3.4.0.5 presence integration requires persisting presence state alongside the workbook (likely NOT -- presence is ephemeral by Phase 5.6 design). If V3.5+ adds Loro-doc-bytes for cache materialization, that's a v3 boundary.

### Decision D4: Presence + virtualization race guard

**Question:** when peer A's presence update lands on peer B's pollRemote tick, peer B's webview must update presence decorations. If peer B is mid-scroll (V3.3.0.4 virtualization is repainting tbody) OR mid-edit (V3.2.b activeInput is non-null), how do the repaints coordinate?

**Existing pattern:** V3.3.0.4 added `if (activeInput !== null) return;` mid-edit guard at the scroll repaint. Same idea extends here.

**Options:**
- **A. Shared boolean-flag guards** -- extend V3.3.0.4 pattern with named flags: `activeInput` (edit), `presenceRepaintInFlight` (presence DOM mutation), `virtualizationRepaintInFlight` (scroll). Each DOM-mutating callback checks the others at entry.
- **B. Per-domain mutexes** -- one mutex per repaint kind.
- **C. Scroll-debounce + presence-tick coalescence** -- queue presence updates during scroll; flush on scroll-end (debounce ~100ms).

**Recommendation: A (extend V3.3.0.4 boolean-flag pattern).**

**Rationale:**
- Webview is single-threaded JS (Electron Chromium event loop). Real concurrency does not exist; mutexes (option B) are overkill.
- Scroll-debounce (option C) adds latency to presence updates. Presence is supposed to feel reactive ("I see who else is editing"); 100ms debounce makes the UX feel laggy.
- V3.3.0.4's `activeInput` guard is proven (mocha-tested; live-smoke-pending but logic-correct). Extending the same pattern preserves the audit-discipline of "one well-understood mechanism" over "three different ones".
- Implementation: each DOM-mutating callback sets its in-flight flag before mutation, clears after. Other callbacks check the union at entry: `if (activeInput !== null || presenceRepaintInFlight || virtualizationRepaintInFlight) defer;`
- Deferral mechanism: enqueue a microtask via `queueMicrotask(() => callback())` if any guard is set. Drains on next event-loop tick when guards clear.

**Decision: A.** V3.4.0.5 introduces `presenceRepaintInFlight` flag; checks `activeInput` + virtualization flag at entry; defers via microtask if blocked.

### Decision D5: PeerId derivation under persistence (closes R-V3.3-5)

**Question:** when a session loads from `.qbook`, what PeerId does it use? The R-V3.3-5 carryforward from V3.1.e Codex M1 + V3.2.d HIGH-1 cross-restart highlights that `BigInt(process.pid)` collides on PID reuse across system restarts (PID space is ~32k usable on macOS / 4M on Linux but the OS recycles aggressively).

This becomes URGENT at V3.4 because:
- **Without persistence**, PID reuse only matters within a session (V3.2.d HIGH-1 closure handled same-window collab-then-collab).
- **With persistence**, loading the same .qbook twice (different OS restarts, same PID-collision case) causes the Loro CRDT to see "same peer with different history" -- a causality violation that produces silent merge anomalies.

**Options:**
- **A. Carry-forward `BigInt(process.pid)`** -- accept the rare cross-restart collision. Document as known limitation.
- **B. UUID-derived BigInt persisted in `.qbook` envelope** -- session generates a UUID at creation; `.qbook` save persists it; `.qbook` load restores it. Stable peer identity across restarts.
- **C. Workspace-nonce-derived** -- `BigInt(hash(workspaceUri, process.pid))`. Workspace-scoped uniqueness; survives PID reuse within the same workspace.

**Recommendation: B (UUID-derived, persisted in envelope).**

**Rationale:**
- R-V3.3-5 cross-restart collision is a real CRDT correctness hazard. Document-and-accept (option A) is a CLAUDE.md "No Fallbacks" violation pattern (the bug is silent + the user has no way to know).
- Persistence IS the natural integration point. The .qbook file CAN carry the peer's identity ("I am peer X for this workbook"). Load restores -> consistent CRDT.
- UUID truncation to u64: 2^64 keyspace vs PID's ~2^15 effective range = vastly larger collision-resistance margin. UUIDv4 random space is 122 bits; truncated to 64 bits keeps ~64 bits of randomness. Birthday-paradox collision probability is ~2^32 sessions before first collision; effectively zero for real workbooks.
- No back-compat issue: V3.4 is the FIRST .qbook ship in Phase 5.7. The persisted-peerId contract starts on day 1; no migration from a no-peerId era.

**Decision: B.** Implementation:
- Session creation (`createSession(peerId)`): if caller passes explicit `peerId`, use it; otherwise generate `BigInt(uuid_truncated_to_u64)`.
- `.qbook` envelope v3 adds `peer_id_for_this_session: u64` field (OR: stored separately in `~/.config/quantlab/peer_ids.json` keyed by workbook UUID; envelope-level is simpler).
- `from_qbook(path, peer_id_override?)`: if `peer_id_override` is passed, use it (lets a NEW collaborator join an existing workbook); otherwise reuse the envelope's `peer_id_for_this_session` (rejoining your own workbook).
- IDE side: `quantlab.quantbookOpen` command passes `undefined` for peer_id_override on first open (reuses persisted); passes a fresh UUID-derived PID on "Join as New Peer" sub-command (V3.4.1+ scope; not in V3.4.0).

## V3.4.0 sub-steps

1. **V3.4.0.1 -- decision lock** (engine `a87c31eed4f`, docs-only). Decisions D1-D5 above.
2. **V3.4.0.2 -- engine hybrid cache shape (D1)** ✅ SHIPPED at engine (THIS commit). `CellState{value: Option<CellWireValue>, formula: Option<String>}` defined in `ql-collab/src/session.rs` with explicit Rule 4 per-field walk (HashMap + Option<T> + CellWireValue + String all Send+Sync; composition Send+Sync; **0 new triggers**; arc terminus stays at 6). Migrated `last_snapshot: HashMap<(u16,u32,u32), CellWireValue>` -> `HashMap<(u16,u32,u32), CellState>`. Extended `append_op` O(1) path + `rebuild_snapshot_cache` walk to handle `Op::PutValue` + `Op::PutFormula` + `Op::ClearFormula` (3 cell-keyed variants). Ghost-entry avoidance: `ClearFormula` uses `get_mut` + skip-if-absent so `list_sheets_from_cache` doesn't surface phantom sheets. napi `export_snapshot` extracts `.value` + skips formula-only cells (JSON shape preserved -- IDE mocha 181/181 holds). 3 new ql-collab tests (76 -> 79): `cell_state_formula_roundtrip` (per-field LWW: PutValue + PutFormula both populate; reverse order same), `cell_state_clear_formula_invariant` (ClearFormula preserves value, nulls formula; ghost-entry avoidance pin), `cell_state_undo_preserves_invariants_after_full_rebuild` (undo of PutValue doesn't clobber earlier PutFormula).
3. **V3.4.0.3 -- engine + IDE undo/redo napi bindings** ✅ SHIPPED at engine (THIS commit) + IDE. Engine: thin `#[napi(js_name="undo")] pub fn undo(&self) -> Result<bool>` + matching `redo` wrappers over `CollabSession::undo`/`redo` (already had V3.3.0.X HIGH-1 cache-rebuild semantics). IDE: `undo()`/`redo()` on `CollabSessionInstance` interface + typed wrappers `undo(session): boolean` + `redo(session): boolean` in `session.ts`. Dispatcher extended with `undo`/`redo` envelope arms: consumed=true -> deps.onCommit (triggers panel re-render via V3.3.0.3 cache); consumed=false silent no-op (empty stack); engine throw -> deps.onError with structured code + `[undo]`/`[redo]` message prefix + sentinel sheet/row/col coords (session-wide action). Webview script (V3.4.0.3 D4 boolean-flag race guard pattern): document-level keydown listener with `activeInput !== null` mid-edit guard (preserves browser text-undo inside cell `<input>`); maps `(Cmd|Ctrl)+Z` -> `{type:'undo'}` post, `(Cmd|Ctrl)+Shift+Z` OR `Ctrl+Y` -> `{type:'redo'}` post; case-insensitive key match. 13 new IDE mocha tests (181 -> 194): 4 napi round-trip (empty/single-undo/undo-redo/multi-cell-shrinkage), 5 dispatcher arms (undo consumed/empty/redo consumed/redo empty/payload ignored), 4 HTML wiring (document-level listener/mid-edit guard/Cmd-Ctrl-Z-Y envelopes/V3.2.a-compat read-only gate).
4. **V3.4.0.4 -- engine + IDE `.qbook` persistence (D3 + D5).** REORDERED to ship AFTER V3.4.0.5 + SPLIT a/b like V3.4.0.5.
   - **V3.4.0.4a (engine napi)** SHIPPED at engine (THIS commit pair) + IDE (paired commit).  Adds 3 new deps to ql-bindings-node Cargo.toml (`ql-io` + `ql-functions` + `ql-storage`; `uuid` deferred to V3.4.0.4b where the IDE generates UUID-derived peer-ids via `crypto.randomUUID()` instead of engine-side).  4 new napi methods: `toQbook(path) -> ()` (calls `inner.rebuild_workbook(&default_registry())` + `save_workbook_with_oplog`; hardcoded workbook name "quantbook" at V3.4.0.4a); `fromQbook(path, peer_id_override: BigInt)` factory (load_workbook_with_oplog + oplog.export_bytes + CollabSession::from_snapshot round-trip; peer_id_override REQUIRED not Option); `addSheet(name, chunkRows)` (REAL SEMANTIC GAP CLOSED: rebuild_workbook replay requires sheets before PutValue; without addSheet napi exposure, sessions built via appendPutValue alone could NOT be saved -- session_replay invalid sheet); new `persistence_error_to_napi` helper with 4 codes (`qbook_error` / `qbook_unsupported_version` / `qbook_truncated_header` / `qbook_unknown` wildcard for non_exhaustive future variants).  Engine-side rebuild_workbook usage at the napi layer is permitted at V3.4 per V3.4.0.1 plan note; the rebuilt Workbook never crosses FFI.  IDE: types.ts CollabSessionInstance.toQbook + addSheet + CollabSessionConstructor.fromQbook factory; session.ts exportToQbook / sessionFromQbook / addSheet typed wrappers; QuantbookErrorCode + KNOWN_QUANTBOOK_ERROR_CODE_RECORD extended with 4 new persistence codes; +5 mocha tests (219 -> 224): empty round-trip + peerIdOverride wins; cells round-trip preserves via cache rebuild; listSheets round-trip; non-existent path -> structured error; peerIdOverride=0 -> bad_argument.  D3 stays at v2 envelope (no schema bump needed for V3.4.0.4a; D5 UUID PeerId persistence deferred to V3.4.0.4b).
   - **V3.4.0.4b (IDE commands + UUID PeerId)** SHIPPED at IDE (THIS commit; engine plan-only).  `generateUuidPeerId(): bigint` helper in session.ts (crypto.randomUUID -> first 16 hex chars -> BigInt; non-zero retry on the astronomically-rare all-zero truncation; 8-attempt cap surfaces broken entropy source per No-Fallbacks).  2 new commands `quantlab.quantbookSaveAs` (vscode.window.showSaveDialog filter .qbook -> exportToQbook on activeLocalPanels[0].session) + `quantlab.quantbookOpen` (showOpenDialog canSelectFolders=true filter .qbook -> generateUuidPeerId -> sessionFromQbook -> CellGridPanel.show(sheet=0)).  Both registered in package.json + package.nls.json.  +4 mocha tests (224 -> 228): non-zero / u64-range / 1000-call uniqueness / engine round-trip.
     - **D5 DEVIATION DOCUMENTED**: V3.4.0.1 D5 originally specified persisted-per-workbook PeerId via envelope v3 OR `~/.config` config file.  V3.4.0.4b implementation discovery: persisted-per-workbook PeerId has unsolvable two-windows-same-workspace collision (both windows would read the same stashed PeerId).  Fresh-UUID-per-session is CRDT-correct (each session = distinct Loro peer) + closes R-V3.3-5 fully (no PID space; UUID 2^64 keyspace).  Trade-off: no cross-restart "this peer is User A" op-attribution (future ops get unique attribution; past ops keep their original PeerId).  V3.4.1+ may add per-workbook stash IF a user-facing feature (e.g., "show my contributions") surfaces; for V3.4.0.4b it's deferred.  Plan-rationale committed alongside this update.
     - **NOT included in V3.4.0.4b**: live VS Code smoke test (user-action gap; documented in V3.4.0.7 docs section like V3.3.0.6 live-smoke procedure).  Save-on-edit auto-save (V3.4.1+).  Multi-sheet picker in Open UX (always lands on sheet 0; user runs Switch Cell Grid Sheet).
5. **V3.4.0.5 -- presence integration with cell-grid (D4).** REORDERED (2026-05-23): engine napi shipped FIRST (this commit pair); IDE integration follows in a separate sub-step.
   - **V3.4.0.5a (engine napi)** SHIPPED at engine (THIS commit).  5 wrappers + new `#[napi(object)] PresenceStateJson` struct + bidirectional `From` impls (CorePresenceState <-> PresenceStateJson) at the FFI boundary: `updatePresence(state)` + `peerPresence(peer) -> Option<PresenceStateJson>` + `clearPresence()` + `sweepPresence() -> u32` (V1 contract: sweeps ALL entries unconditionally; no threshold; threshold-based variant deferred to V3.4.1+) + `peersWithPresence() -> Vec<BigInt>` (enumeration primitive for "who's here" panels).  IDE typed wrappers in `session.ts` mirror the listSheets/undo/redo single-line indirection pattern.  +9 IDE mocha tests covering round-trip + null on unknown peer + LWW overwrite + clear + multi-peer enumeration via mergeBytes + sweep on empty + sweep multi-peer + persistence across exportBytes/fromSnapshot (V1 known limitation pin).
   - **V3.4.0.5b (IDE cell-grid integration)** SHIPPED at IDE (THIS commit; no engine changes).  `buildPresenceSnapshotJson(session, sheet)` host-side helper builds `{selfPeerId, peers: PresenceSnapshotPeer[]}` from peersWithPresence + peerPresence (skip-self filter; race-aware None-skip).  `CellGridHtmlOptions.presence?: unknown` carries the snapshot through `buildHtml`; emitted as `<script id="cell-grid-presence" type="application/json">` parallel to V3.3.0.4 cell-grid-data with belt-and-suspenders `</script>` escape.  New CSS `.cell-peer-presence` uses outline (not border) so layout doesn't shift on peer arrival/departure.  Webview script: presence-init parses data block on every render; filters peers by SHEET (single-sheet panel); finds matching `.cell-value[data-row][data-col]` td + adds `.cell-peer-presence` class + `data-peer="${peerId}"` attribute.  beginEdit broadcasts `{type:'presenceUpdate', state:{...typing:true}}`; endEdit broadcasts typing=false.  Dispatcher new arm `presenceUpdate` with runtime field validation (6 required numeric/boolean fields) routing to session.updatePresence; bad_argument errorReply on malformed; NO onCommit on success (presence doesn't affect cell snapshot -- re-render thrash avoidance).  Panel render-time presence fetch (try/catch with console.warn fallback per CLAUDE.md No-Fallbacks); panel onDidDispose calls session.clearPresence so this peer's cursor disappears for remote peers when the window closes (console.warn on engine failure).  **R-V3.4-7 sweep cadence VOIDED**: engine `sweepPresence()` has no threshold variant + sweeps ALL entries unconditionally -- periodic sweep would clobber live remote peers.  Sweep deferred to V3.4.1+ when engine ships threshold-based variant.  **R-V3.4-3 presenceRepaintInFlight race guard DEFERRED**: render() rebuilds full HTML on every pollRemote merged tick (V3.2.c + V3.3.0.3 cache invalidation), so presence decoration regenerates naturally; activeInput mid-edit guard already prevents tbody clobber from scroll handler.  +16 new IDE mocha tests (203 -> 219).
6. **V3.4.0.6 -- mocha tests** (~15 new): cache-after-undo via PutFormula; .qbook round-trip preserves cache; .qbook round-trip preserves peerId across reload; presence decoration appears + disappears; presence + scroll race guard; UUID PeerId uniqueness; multi-window collab via .qbook (open same file in two windows).
7. **V3.4.0.7 -- docs.** Extend `ide-consumer-contract.md § 4.1.z4` (new section) covering: new engine napi surface (undo + redo + to_qbook + from_qbook + presence quartet); CellState cache shape; undo invalidation contract; .qbook envelope v3 format; UUID PeerId derivation rule; presence decoration contract; V3.4 risk register R-V3.4-1..7; out-of-scope items; live smoke procedure.
8. **V3.4.0.X -- parallel Codex+Opus megaudit + closures** (per Rule 2; mirrors V3.2.d / V3.3.0.X 2-lane pattern). Codex Lane A: protocol/correctness over the new napi surface (undo correctness + persistence round-trip invariants + presence merge semantics). Opus Lane B: adversarial per-field walks on `CellState` + UUID PeerId derivation + envelope v3 schema; V3.5 entry-readiness analysis. Cross-lane convergent HIGHs MUST close in-cycle.

## V3.4 risk register

- **R-V3.4-1 Hybrid cache shape migration breaks consumers.** MITIGATED at V3.4.0.2 by keeping `snapshot_cells(sheet)` signature stable AND keeping napi `export_snapshot` JSON shape unchanged; internal field shape change only.
- **R-V3.4-2 Undo/redo across persistence load.** Loading a `.qbook` gives the session a fresh state; Loro `UndoManager` history is RESET on `from_snapshot` (matches existing behavior in `CollabSession::from_snapshot`). Document explicitly in § 4.1.z4: load -> no undo of pre-load state available.
- **R-V3.4-3 Presence + 2-window collab race.** Peer A's presence update lands on B's pollRemote tick -> B's webview repaints. If B is mid-scroll, V3.3.0.4 `activeInput` guard + V3.4.0.5 `presenceRepaintInFlight` flag cover it. PIN with two-session mocha test at V3.4.0.6.
- **R-V3.4-4 PeerId reuse across .qbook save/load** -- closed by D5 (UUID-derived peerId persisted in envelope). R-V3.3-5 carryforward TERMINATES at V3.4.0.4.
- **R-V3.4-5 Undo across remote-op merge.** Loro `UndoManager` only undoes LOCAL ops; remote ops merged via pollRemote are NOT undone (this is correct CRDT behavior; undoing a remote op would mean "delete the peer's edit" which violates causality). Document in V3.4.0.7 § 4.1.z4 with an explicit example: "Cmd-Z after a remote edit lands undoes YOUR last edit, not the remote one."
- **R-V3.4-6 .qbook save during pending-flush.** Save must capture the post-flush state OR explicitly include unflushed ops. Decision deferred to V3.4.0.4 implementation; current preference: save flushes first (synchronize_then_save), since persistence is the authoritative ground state.
- **R-V3.4-7 Presence sweep frequency.** Phase 5.6 V2 added `sweep_presence(threshold_secs)`; V3.4 grid integration MUST call it on some cadence to clear stale peers. Candidates: tied to pollRemote 1s loop (every Nth tick); or a dedicated `setInterval` at 30s. Decision deferred to V3.4.0.5 implementation; current preference: every 10th pollRemote tick (so once per 10s for the V3.3.0.1 D6 1s polling cadence).

## V3.4 out of scope

- **Full Op enum cache coverage**: V3.4 cache covers PutValue + PutFormula + ClearFormula. RegisterFormat + SetCellFormat (D-1) defer to V3.5+ when format-cache becomes needed by IDE rendering.
- **Advanced undo**: multi-cell groups, undo-redo-history UI, persistence-spanning undo. V3.4.1+ scope.
- **Cloud / WAN persistence**: cloud .qbook storage, S3 backend, real-time sync over WAN. V3.x productionization (Phase 5.8+).
- **Real-time animated presence cursors**: V3.4.0 ships static colored borders on cells; smooth pixel-precise cursors are V3.4.1+.
- **Optimistic rendering revisit**: still N/A at localhost; V3.x WAN may revisit per V3.2.b.1 B4 + V3.3.0.1 D5 carries unchanged.
- **Push API for inbound observation**: V3.2.c.1 C2 + V3.3.0.1 D6 + V3.4 carry the 1s polling cadence. Push API is V3.x with its own audit cycle.
- **`rebuild_workbook` routing into a fresh `Workbook`**: V3.5+ scope. V3.4 reads from `last_snapshot` cache; full workbook reconstruction (formula recompute, etc.) is V3.5+.

## §1 First-five-minutes verification (for next session resuming this plan)

```sh
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine

# Confirm V3.4.0.1 ship (THIS commit will be at HEAD after this plan lands)
git log --oneline -1
# expect: <HEAD> docs(5.7): V3.4.0.1 -- lock 5 design decisions for undo + persistence + presence

# Pre-V3.4 blockers all closed (V3.3.0.X confirmation)
git log --oneline | grep "V3.3.0.X" | head -3
# expect:
#   6083ba9282a docs(5.7): V3.3.0.X follow-up -- archived plan status=done
#   56f9c8aa3f9 docs(5.7): V3.3.0.X plan close + MASTER-PLAN sweep
#   73e31df1737 feat(quantbook): Phase 5.7 V3.3.0.X megaudit engine closures

# Engine tests still green (76 ql-collab + 42 ql-collab-ws):
mac zsh -lc 'cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && ~/.cargo/bin/cargo test -p ql-collab --release --features test-fixtures --lib && ~/.cargo/bin/cargo test -p ql-collab-ws --release' | grep 'test result:'

# IDE mocha (181/181):
mac zsh -lc 'cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab && node node_modules/mocha/bin/mocha.js out/test/quantbook-roundtrip.test.js --ui tdd --timeout 30000 --require source-map-support/register --require out/test/helpers/mocha-setup.js' | tail -3
```

## §2 Reading order for V3.4.0.2 implementation

1. **`crates/ql-collab/src/session.rs:387-451`** -- `last_snapshot` field docstring (V3.3.0.X HIGH-1 + MEDIUM-2 closure). The 7 op-mutation paths enumerated here all need extension for D1.C cache shape change.
2. **`crates/ql-collab/src/session.rs:725-746`** -- `rebuild_snapshot_cache()` implementation (V3.3.0.3 + V3.3.0.X MEDIUM-1 atomic-swap). V3.4.0.2 extends the match arm to handle `Op::PutFormula` + `Op::ClearFormula`.
3. **`crates/ql-collab/src/session.rs:671-702`** -- `list_sheets_from_cache()` (V3.3.0.X MEDIUM-3). The sheet derivation logic needs no change because cell keys still carry sheet; CellState only changes the VALUE shape.
4. **`crates/ql-bindings-node/src/lib.rs::export_snapshot`** -- the napi method that the IDE consumes. PRESERVE its JSON shape per R-V3.4-1.
5. **`crates/ql-oplog/src/op.rs:43-120`** -- the `Op` enum variants. V3.4.0.2 wires PutFormula + ClearFormula; future V3.5+ extends to other variants.
6. **`crates/ql-io/src/qbook_format.rs`** -- existing v2 envelope format. V3.4.0.4 extends to v3 IF needed (likely yes for D5 peerId persistence).
7. **`crates/ql-collab/src/presence.rs`** + `crates/ql-collab/src/session.rs::update_presence` etc. -- Phase 5.6 V1+V2 surface. V3.4.0.5 binds these via napi.
8. **`extensions/quantlab/src/quantbook/cellGrid/cellGridHtml.ts`** -- V3.3.0.4 added `cell-grid-data` data block; V3.4.0.5 adds parallel `cell-grid-presence` data block.

## §3 V3.4.0.2 entry recommendation (for next session)

Start V3.4.0.2 by:

1. Reading V3.3.0.3 `last_snapshot` field docstring + `rebuild_snapshot_cache` implementation (§ 2 items 1-3 above).
2. Defining the `CellState` struct in `ql-collab/src/session.rs` (NOT in ql-oplog -- this is a session-cache type, not a wire type):
   ```rust
   #[derive(Clone, Debug, Default)]
   pub struct CellState {
       pub value: Option<CellWireValue>,
       pub formula: Option<String>,
       // Phase 5.7 V3.5+: pub format: Option<FormatId>,
   }
   ```
3. Rule 4 per-field walk on `CellState`: `Option<T>` is Send+Sync when T is; `CellWireValue` is Send+Sync per V1 audit; `String` is Send+Sync trivially. Composition: Send+Sync. Inherits V2.4 `Arc<Mutex<>>` sync pinning. **0 new triggers expected.**
4. Migrating `last_snapshot: HashMap<(u16, u32, u32), CellWireValue>` -> `HashMap<(u16, u32, u32), CellState>`.
5. Updating all 7 op-mutation paths (the cache invariant docstring enumerates them).
6. Extending `rebuild_snapshot_cache` match arm to handle `Op::PutFormula { sheet, row, col, text }` -> set `CellState.formula = Some(text)`; and `Op::ClearFormula { sheet, row, col }` -> set `CellState.formula = None`.
7. Updating napi `export_snapshot` to read from `CellState.value` (preserving the V3.3.0.3 JSON shape; ignoring `formula` for V3.4.0.2 -- formula visualization in the cell-grid is a V3.4.0.5+ concern).
8. New ql-collab unit tests: `cell_state_formula_roundtrip`, `cell_state_clear_formula_invariant`, `cell_state_undo_preserves_formula`.

Estimated V3.4.0.2 effort: ~1 day (engine code + Rule 4 walk + tests + ql-bindings-node compile-check + IDE mocha re-run to ensure JSON-shape stability).
