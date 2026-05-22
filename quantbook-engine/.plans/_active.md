---
name: 2026-05-22_phase-5-7-v3-2-cell-grid-ui
status: in-progress (V3.2.a SCAFFOLD COMPLETE + V3.2.a.1 ergonomic enhancement -- exportSnapshot napi (engine `355a3226f0a`) + IDE typed wrapper (`831c9f2bf37`) + webview scaffold + `quantlab.quantbookCellGrid` command (`fcfe9e91188`) + V3.2.a.1 in-place refresh + single-tab-per-sheet (`130d28000ca`); engine Cargo.lock fix for V3.2.a serde_json (`748c09194d9`); virtualized renderer deferred to V3.3; V3.2.b cell-edit flow is the next entry; predecessor V3.1 fully shipped at engine `97ac0b902d1` / IDE `a46abea484a`)
date: 2026-05-22
predecessor_plan: .plans/_archive/2026-05-22_phase-5-7-v3-1-multi-window-demo.md (V3.1 multi-window demo, all sub-steps + audit closed)
predecessor_v2_exit_packet: docs/phase5/5-7-v2-exit-packet.md (V2 phase termination -- Transport binding architectural decisions V2.1-V2.8)
predecessor_v3_1_audits: docs/audits/2026-05-22-phase-5-7-v3-1-{codex,opus}.md (V3.1.e parallel audit; Opus § Section 3 contains the V3.2 ENTRY READINESS analysis this plan is built on)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V3.2 -- cell-grid UI. Real grid widget bound to a CollabSession; user-facing cell editing surface. First production-grade IDE consumer of the V2 Transport binding + V3.1 multi-window infrastructure.
current_engine_head: 748c09194d9 (Cargo.lock fix for V3.2.a serde_json dep; session-end audit drift-fix)
current_ide_head: 130d28000ca (V3.2.a.1 in-place refresh + single-tab-per-sheet)
current_mocha_count: 108 / 108
current_ql_collab_tests: 74 / 74 (with --features test-fixtures)
current_ql_collab_ws_tests: 42 / 42 (10 lib + 30 websocket_transport + 2 V3.1.a relay)
current_engine_workspace: 4472 / 0 baseline
audit_rules_inherited:
  - Rule 1: no fresh-session reminders (existing memory)
  - Rule 2: parallel Codex+Opus per step
  - Rule 4: negative trait claims need positive compile proof OR per-field walk. Arc terminus = 6. V3.2 adds binding classes -- expect 0-2 new triggers; per-class audit required (per Opus V3.1.e R3 action item).
v3_2_arc_estimate: 1-2 weeks. V3.2.a grid scaffolding (~2d). V3.2.b cell-edit flow (~3d). V3.2.c live multi-window propagation (~2d). V3.2.d audit + closure (~1-2d). V3.2.e exit packet (~1d).
---

# Phase 5.7 V3.2 -- Cell-Grid UI (Plan)

## V3.1 ship report (predecessor)

V3.1 multi-window demo is fully shipped. Highlights:

- V3.1.a engine relay binary at `crates/ql-collab-ws/examples/relay-server.rs`. Stateless broadcast with sender-side self-filter. V3.1.e Codex L2 closure added tokio::signal graceful shutdown via JoinSet::abort_all.
- V3.1.b IDE multi-window command `quantlab.quantbookDemoMultiWindow` at `extensions/quantlab/src/quantbook/multiWindowDemo.ts`. Symmetric try-connect-first, peerId = BigInt(process.pid), reconnect-with-backoff (500/1000/2000ms x 3).
- V3.1.c reconnect UX: dispose-from-handler + Restart Demo action + ide-consumer-contract section 4.1.y documenting the protocol.
- V3.1.e closures: spawn race retry, Windows-cold-spawn timeout (10s + env override), signal-aware liveness predicate, reconnect-mid-flight engine contract test, relay graceful shutdown.
- Audit verdicts: Codex 0H+1M+5L, Opus 0H+2M+9L. 4 actionable closures shipped; 12 LOWs deferred to V3.x with rationale. Rule 4 arc terminus stays at 6 (0 new triggers).

## V3.2 scope

V3.2 = cell-grid UI. Lift the V3.1 demo patterns into a real grid widget that users can interact with. This is the FIRST production-grade IDE consumer of the V2 Transport binding.

### What V3.2 delivers

1. **Webview-based cell grid** that renders sheet 0 (initial scope) of a CollabSession's workbook state.
2. **Per-cell edit flow**: click cell -> edit value -> commit on Enter/blur -> append PutValue op -> auto-flush to transport.
3. **Live multi-window propagation**: a second window's grid updates when peer A appends. Uses V2 V2's `AutoFlushPolicy::OnAppend` for outbound; uses Transport push-notification OR fast-poll (decision below) for inbound.
4. **Reconnect UX integration**: status-bar indicator (Connected / Reconnecting / Disconnected) hooked to the V3.1.c reconnect contract. Inline error decoration at cell-level for typed errors (`bad_argument` on invalid input, `transport_closed` blocking the cell with a "queued for sync" badge).
5. **Per-class Rule 4 audit** for every new binding class (`CellRange`, `CellEdit`, possibly `GridView`/`GridSnapshot`).

### What V3.2 does NOT deliver

- Multi-sheet support (V3.3 -- sheet tabs).
- Cell range selection + multi-cell paste / drag-fill (V3.3+).
- Undo/redo wiring via `UndoGroupGuard` (V3.4).
- Presence (per-peer cursor color) (V3.4 + Phase 5.6 V2 integration).
- `rebuild_workbook` wiring (V3.5 + Phase 5.3 production-visible closure).
- `.qbook` persistence (V3.5+).
- Production relay deployment (server-side state for presence/history -- per Opus R7).

## V3.2 sub-steps

- **V3.2.a -- Grid scaffolding (~2d)** ✅ SHIPPED 2026-05-22.
   1. [x] New webview component at `extensions/quantlab/src/quantbook/cellGrid/`. `cellGridHtml.ts` (pure HTML functions, no vscode import -- enables host-free testing) + `cellGridPanel.ts` (vscode `WebviewPanel` wrapper). IDE commit `fcfe9e91188`.
   2. [x] Read sheet 0's cell range from the engine via `CollabSession.exportSnapshot(sheet)`. SHIPPED at engine `355a3226f0a` + IDE `831c9f2bf37`. Returns JSON-serialized `QuantbookCellSnapshot` (snapshot_format_version = 1, entries sorted by (row, col) with last-write-wins per cell). Decision 1 LOCKED to Option A.
   3. [partial] Table render: static HTML table shipped. Virtualization deferred to V3.3 (out of V3.2.a scope per plan).
   4. [x] Read-only render -- `enableScripts: false` + CSP `default-src 'none'`. V3.2.b will flip scripts on for message-passing.
   5. [x] `quantlab.quantbookCellGrid` command registered + package.json + package.nls.json (title "Quantbook: Open Cell Grid"). Sample data injected at command invocation so the grid renders non-empty on first open.
   6. [x] Mocha tests: 10 total (5 V3.2.a engine-side snapshot + 5 V3.2.a IDE HTML rendering including XSS escape pin + CSP meta tag pin).

- [ ] **V3.2.b -- Cell-edit flow (~3d)** -- write surface.
   1. Click cell -> input element appears -> user types -> Enter or blur commits.
   2. Validate input (number / string / formula stub for V3.2; full formula in V3.3).
   3. Call `appendPutValueValidated(session, sheet, row, col, value)`.
   4. AutoFlushPolicy = OnAppend -> auto-sync to transport.
   5. Re-render the cell from the session's new state.
   6. Catch errors via parseQuantbookError; show inline decoration with the structured code.
   7. Mocha tests: simulated key events + assertion on the resulting session state.

- [ ] **V3.2.c -- Live multi-window propagation (~2d)** -- read surface from peer.
   1. Decide inbound model: (a) periodic 1s `pollRemote` (V3.1 pattern; demo-OK) vs (b) Transport-push event-driven via `Transport::ack_handle`-style subscription (cleaner; needs engine API).
   2. On inbound op observed: re-render affected cells.
   3. Status-bar indicator hooked to transport state (Connected / Reconnecting / Disconnected).
   4. Per-cell "incoming" flash animation (200ms tint) for visual feedback when a remote op lands.
   5. Mocha test: two sessions in one process, A appends, B observes the cell change.
   6. Manual smoke: two VS Code windows, edit in one, observe in the other.

- [ ] **V3.2.d -- Parallel Codex + Opus audit + closures (~1-2d)** -- per Rule 2.
   - Codex lane: protocol/correctness sweep over the new napi surface + grid rendering correctness + edit-commit semantics.
   - Opus lane: adversarial per-field walks on every new binding class (Rule 4), webview security (CSP, message-channel validation), V3.3-readiness analysis.
   - Cross-lane convergent HIGHs MUST close in-cycle.

- [ ] **V3.2.e -- V3.2 exit packet (~1d)** at `docs/phase5/5-7-v3-2-exit-packet.md`.
   - Mirrors the V2 exit packet structure: commit ladder, surface contract, decisions locked (multiplex vs per-session, push vs poll), Rule 4 arc state, V3.3+ backlog, audit transcripts inventory.

## V3.2 design decisions to lock at V3.2.a entry

### Decision 1: Snapshot API shape

**Question:** how does the IDE get the cell data for rendering?

**Option A: New napi method on CollabSession** like `exportSnapshot(sheet: number)` that returns a structured `{rows, cols, cells}` shape.
- Pro: simple TS consumer; no Loro internals leak into JS.
- Con: new API surface; needs Rule 4 audit; needs schema versioning if grid representation changes.

**Option B: Existing `exportBytes` + TS-side Loro doc parser.**
- Pro: zero new engine API; reuses Loro's stable serialization.
- Con: TS depends on Loro internals; harder to maintain across Loro version bumps.

**Option C: Per-cell on-demand fetch.**
- Pro: no snapshot at all; virtualized grid fetches cells as needed.
- Con: many round-trips; only works with a per-cell API (`getCellValue(sheet, row, col)`) which would need to be added.

**Recommendation: Option A** (new napi method, lock the shape at V3.2.a, version via `snapshot_format_version` field). Simplest TS consumer; clear ownership boundary.

### Decision 2: Inbound notification model

**Question:** how does the grid know when a remote op lands?

**Option A: Continue 1s polling (V3.1 pattern).**
- Pro: works today; no new engine API.
- Con: 1s latency floor for inbound visibility; polling overhead on idle.

**Option B: Engine push via a new `Transport::on_inbound_blob(callback)` hook.**
- Pro: zero-latency push; matches user expectation for collaborative grid.
- Con: requires new engine API + cross-thread callback (tokio task -> napi ThreadsafeFunction); Rule 4 concerns around the callback's Send + Sync.

**Recommendation: Option A for V3.2** (defer Option B to V3.x). 1s polling is acceptable for first-version collaborative grid; latency optimization is a refinement. V3.x: design Push API with full Rule 4 audit.

### Decision 3: Multiplexed vs per-session Transport (Opus R6)

**Question:** one Transport per session (V3.1 model) or one Transport multiplexing many sessions?

**Recommendation: per-session for V3.2** (matches V3.1). Defer multiplexing to V3.x when many-workbooks-per-IDE-window becomes a real product surface.

### Decision 4: Server-side state (Opus R7)

**Question:** V3.2 needs presence (who-edits-this-cell)? History catch-up?

**Recommendation: NEITHER in V3.2 scope.** Presence is V3.4 (Phase 5.6 V2 integration). History catch-up is V3.5+ (paired with `rebuild_workbook` wiring). V3.2 grid is two-peer happy-path only; reconnect uses V3.1.c's reconnect-with-backoff against the stateless relay.

## V3.1 patterns to carry / discard (per Opus V3.1.e § 3)

### CARRY:

- PeerId = BigInt(process.pid) (unchanged).
- Symmetric try-connect-first orchestration (still applies; V3.2 grid is just a different consumer).
- reconnectWithBackoff PATTERN (extract magic numbers into a config object for V3.2; defaults stay at 500/1000/2000ms x 3 for localhost).
- parseQuantbookError + switch-on-code (rock-solid; V3.2 grid wraps every mutation in try/catch).
- Dispose-from-handler safety (V3.1.c idempotent dispose; V3.2 grid widget unmount inherits the idiom).
- Reconnect UX warningMessage pattern (V3.2 uses status-bar indicator + inline toast instead of modal; underlying contract unchanged).
- Transport::ack_handle pattern (V3.2 contention tests use BlockingTransportFixture; ack_handle is V3.x for push notification API).

### DO NOT CARRY:

- Periodic 2s append (V3.1 demo only; V3.2 is event-driven on cell-edit commit).
- Row = pid & 0xffff (visual confusion in real grid; V3.2 uses cursor color via PresenceState in V3.4).
- 1s pollRemote (carry for V3.2 inbound but flag as V3.x to upgrade to push API).
- Spawn-from-IDE relay model (V3.2 demos still use it; production grid wants persistent service -- V3.3 backlog).
- Shared OutputChannel (V3.2 grid uses dedicated `LogLevel`-aware logger).
- Hardcoded port 7117 (V3.x: configuration / DNS-SD; V3.2 still hardcoded for demo simplicity).

## V3.2 risks (continued from V2.8 Lane C + V3.1.e Opus § 3.3)

- **R1 BlockingTransportFixture path:** CLEAR (V2.8 cfg-gate path inherits to V3.2 contention tests). PASS.
- **R2 Inline error surface:** MEDIUM. parseQuantbookError pattern carries; UX layer needs design (per-cell decoration + status bar).
- **R3 Send + Sync drift:** HIGH if not actively audited. Every new V3.2 binding class needs parallel Codex+Opus Rule 4 review.
- **R4 Drop order under unmount:** LOW. Modal grid -> grid transitions are slow enough to let cleanup complete.
- **R5 Reconnect UX:** MEDIUM. V3.1.c pattern carries; V3.2 grid is FIRST production consumer of `ide-consumer-contract.md § 4.1.y`.
- **R6 Connection-pool / multiplexing:** DEFERRED to V3.x per Decision 3.
- **R7 Server-side state for presence/history:** DEFERRED to V3.4/V3.5 per Decision 4.

## V3.x backlog inherited (not blocking V3.2)

From V2 exit packet + V3.1.e audit:

- Structured `transportLastErrorInfo()` accessor (V2.7 closure note; makes `websocket_runtime_error` reachable).
- `KNOWN_QUANTBOOK_ERROR_CODES` is already codegen'd via V2.9 closure -- DONE.
- `willFlushSend()` helper.
- `LoopbackTransport.close()` binding.
- `HandshakeFailed` fixture.
- `CollabSessionError::Transport(_)` origin tracking (V2.7 Opus M3).
- `@napi-rs/cli` publish pipeline (V1 backlog).
- `#[napi(strict)]` sweep.
- Production cdylib error-paths sweep.
- PID-only PeerId restart/reuse collision (V3.1.e Codex M1).
- AtomicUsize conn_id wrap (V3.1.e Codex L3).
- 8 of 9 V3.1.e Opus LOWs.

## §1 First-five-minutes verification (V3.2.b session entry)

```sh
# Engine
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
git status --short | grep -v '^??'    # expect empty
git log --oneline -5
# Expect newest at top:
#   748c09194d9 build(quantbook): commit Cargo.lock for V3.2.a serde_json dep addition
#   a8c9b939c03 docs(5.7): V3.2.a scaffold complete -- plan status update
#   93277be4d7f docs(5.7): V3.2.a snapshot foundation status update
#   355a3226f0a feat(quantbook): V3.2.a (engine) -- exportSnapshot napi method
#   55a689a0797 docs(5.7): V3.1 plan archive + V3.2 entry plan drafted

# IDE
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab
git status --short | grep -v '^??'   # expect empty
git log --oneline -5
# Expect newest first:
#   130d28000ca V3.2.a.1 (IDE) -- in-place panel refresh + single-tab-per-sheet
#   fcfe9e91188 V3.2.a scaffold (IDE) -- webview + quantbookCellGrid command
#   831c9f2bf37 V3.2.a (IDE) -- typed wrapper for exportSnapshot + 5 mocha tests
#   58f607fe1d0 V2.9 Lane C M3 closure
#   a46abea484a V3.1.e closure (Codex LOW-5) -- reconnect-mid-flight test

# Tests baseline:
#   ql-collab 74/74; ql-collab-ws 42/42; IDE mocha 108/108
```

## §2 Reading order for V3.2.b (next session)

1. **`memory/current_work.md`** -- session handoff (entry point).
2. **This V3.2 plan** -- V3.2.a checkboxes [x]; V3.2.b sub-step checklist drives the next session.
3. **`docs/audits/2026-05-22-phase-5-7-v3-1-opus.md` § Section 3** -- V3.2 entry readiness (Opus). The R3 Send+Sync drift hazard applies to ANY new V3.2.b binding class (CellRange / CellEdit / etc.) -- parallel Codex+Opus Rule 4 review required per class.
4. **`docs/architecture/ide-consumer-contract.md` § 4.1.y** -- reconnect contract (V3.2.b grid widget hooks this for inline error UX).
5. **`extensions/quantlab/src/quantbook/cellGrid/cellGridHtml.ts`** + **`cellGridPanel.ts`** -- V3.2.a scaffold. V3.2.b adds message-passing on top; flip `enableScripts: true` + nonced CSP.
6. **`extensions/quantlab/src/auth/LoginWebviewPanel.ts`** -- existing extension webview with message-passing + CSP pattern; use as a reference (V3.2.b can copy the nonce + onDidReceiveMessage skeleton).
7. **VS Code Webview docs** on message-passing + CSP nonce.

## §3 V3.2.b entry recommendation

Start V3.2.b by FIRST locking the message-passing protocol shape in this plan (extend §V3.2.b section below). Decision items:

1. Message envelope: `{type: 'putValue' | 'refresh' | 'errorReply', ...}` discriminator + payload schema.
2. Nonce derivation: per-panel-instance crypto.randomUUID() OR per-page-load random hex.
3. Error reply schema: `{type: 'errorReply', sheet, row, col, code: QuantbookErrorCode, message}` for inline cell decoration.
4. Optimistic vs pessimistic cell rendering: pre-V3.2.b assume PESSIMISTIC (commit only after engine accepts) -- matches CRDT semantics + avoids stale-rollback complexity.
5. Re-render strategy on remote ops: V3.2.b does NOT include live remote propagation (V3.2.c). The V3.2.a.1 Refresh command is the workaround.

LOCK these decisions BEFORE coding. Then implement V3.2.b sub-steps 1-7 per the V3.2.b checklist below.

V3.2 is the first PRODUCT-USER-VISIBLE surface of the entire Phase 5.7 arc. The audit discipline that paid off 6 Rule 4 triggers across V1+V2 must continue.
