---
name: 2026-05-22_phase-5-7-v3-multi-window-demo
status: in-progress (V3.1.a engine relay SHIPPED at `9df01c5a050`; V3.1.b IDE multi-window command SHIPPED at `b314ead754d`; V3.1.c reconnect UX partially shipped, restart-on-failure action + ide-consumer-contract update remain; V3.1.e audit obligations pending = parallel Codex+Opus next session)
date: 2026-05-22
predecessor_plan: .plans/_archive/2026-05-22_phase-5-7-v2-transport-binding.md (V2 phase — Transport binding through V2.8 megaudit)
predecessor_v2_exit_packet: docs/phase5/5-7-v2-exit-packet.md (V2 phase termination — architectural decisions V2.1-V2.8, V3 backlog, V3-entry readiness reference)
predecessor_lane_c_v3_readiness: docs/audits/2026-05-22-phase-5-7-v2-megaudit-opus-b-v3.md (§ Section 3 — V3 ENTRY READINESS — Lane C's Part 2)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V3 — product-visible vertical slice. Multi-window IDE demo first; cell-grid UI + persistence + rebuild_workbook wiring + full Op enum + undo/redo + presence follow.
current_engine_head: 9df01c5a050 (Phase 5.7 V3.1.a engine -- relay binary + integration tests; docs sweep for V3.1.b status pending)
current_ide_head: b314ead754d (Phase 5.7 V3.1.b IDE -- multi-window demo command + V3.1 mocha round-trip)
current_mocha_count: 97 / 97 (V2.9 baseline 96 + V3.1.b multi-window round-trip test)
current_ql_collab_tests: 74 / 74 (with --features test-fixtures)
current_ql_collab_ws_tests: 42 / 42 (10 lib + 30 websocket_transport + 2 V3.1.a relay integration tests)
current_engine_workspace: 4472 / 0 baseline (last verified at V2.5 ship gate; V3 will re-verify at each step)
audit_rules_inherited:
  - Rule 1: no fresh-session reminders (existing memory)
  - Rule 2: parallel Codex+Opus per step
  - Rule 3: Range-aware fn ships need lex+parse+bind+eval coverage (not applicable to IDE binding work)
  - Rule 4: negative trait claims need positive compile proof OR per-field walk. Phase 5.7 arc TERMINUS = 6 (V2.7 + V2.8 megaudit per-field walks: 0 new triggers). V3 inherits the convention; expect 0-1 new triggers as V3 adds binding classes.
v3_arc_estimate: 1-2 weeks total. V3.1 multi-window demo ~1-2d. Cell-grid UI ~1wk. Persistence + rebuild_workbook wiring ~1wk. Total ~3wk if all V3 work is done in one phase; can split into V3.1 (demo), V3.2 (grid + persistence), V3.3 (full surface).
---

# Phase 5.7 V3 — Product Vertical Slice (Plan)

## V2.9 hardening (lands with this plan commit) ✅

Lane C MEDIUM-3 closure: `KNOWN_QUANTBOOK_ERROR_CODES` is now derived from a `Record<Exclude<QuantbookErrorCode, 'unknown'>, true>` (TS compile-time enforcement). Pre-V2.9 the Set was a manually-maintained string list -- a fresh engine kind added to the union without updating the Set silently bucketed under `'unknown'`. V2.9 closes the drift surface (the Lane C megaudit's one remaining required-pre-V3 item beyond the cfg-gate HIGH-1 that landed in V2.8).

IDE commits: V2 archive + V2.9 closure ship in the same commit. Mocha: 96/96 (was 95 at V2.8; +1 V2.9 round-trip test pinning every code in the union routes through `parseQuantbookError`).

## V3 scope

V2 made the IDE multi-peer-capable but the user can't yet SEE collaboration. V3 lands the product-visible surface:

1. **V3.1 — Multi-window IDE demo** (this step) — ~1-2d. `quantlab.quantbookDemo` spawns a second VS Code window via `vscode.openFolder` (or the existing multi-window CLI); both windows attach `WebSocketTransport` to a localhost ws server; demonstrate edits propagating A → B. The new component is the localhost ws server (Lane C confirmed `ql-collab-ws` is client-only; V3.1 brings its own server).

2. **V3.2 — Cell-grid UI** — ~1wk. Real grid widget bound to `CollabSession` snapshots. Out of scope for V3.1.

3. **V3.3 — rebuild_workbook wiring + `.qbook` persistence + full Op enum** — ~1wk. Out of scope for V3.1.

4. **V3.x — undo/redo (UndoGroupGuard RAII translation) + presence** — separate cycles. Out of scope for V3.1.

V3 backlog smaller items (V2 carryforward — interleave when convenient):
- Structured `transportLastErrorInfo()` accessor (makes `websocket_runtime_error` reachable)
- `CollabSessionError::Transport(_)` origin tracking (V2.7 Opus M3)
- `willFlushSend()` helper
- `LoopbackTransport.close()` binding
- `HandshakeFailed` fixture
- `@napi-rs/cli` publish pipeline
- `#[napi(strict)]` sweep
- `#[must_use]` on `attach_transport<T>`

## V3.1 — Multi-window IDE demo (entry step)

### Goal

Two VS Code IDE windows on localhost, each running a `CollabSession`, connected via WebSocket. User types in window A's command → window B's session observes the op. Visible proof that V2's Transport binding works end-to-end across separate IDE processes.

### V3.1 sub-steps

- [x] **V3.1.a — Localhost ws server** ✅ SHIPPED 2026-05-22
   - Chose path B (test-only binary at `crates/ql-collab-ws/examples/relay-server.rs`). Smaller scope, demo-only signal. Revisit path A only if V3.2+ tests need a reusable server type.
   - Implementation: stateless broadcast relay. `tokio::sync::broadcast::Sender<(usize, Vec<u8>)>` carries `(sender_conn_id, bytes)`; each per-connection task subscribes and filters out frames where `sender_id == self.conn_id` (sender-side self-filter). 256-frame broadcast ring; older frames dropped if a client lags (CRDT is idempotent on re-merge — acceptable for demo).
   - Stdout line on bind: `[ql-collab-ws relay] listening on ws://127.0.0.1:<port>` -- stable contract for V3.1.b to pattern-match for readiness.
   - Port: `QL_RELAY_PORT` env or default 7117.
   - Build: `cargo build -p ql-collab-ws --example relay-server --release`.
   - Run: `cargo run -p ql-collab-ws --example relay-server --release` (or invoke the built binary directly).
   - Tests at `crates/ql-collab-ws/tests/relay.rs` (2 integration tests; inline twin of `handle_connection` to test without subprocess):
     - `two_clients_cross_broadcast`: A→B propagation + A-self-filter pin.
     - `third_client_receives_both_streams`: 3-way fan-out pin.
   - Trade-off accepted: the inline twin in `tests/relay.rs` duplicates ~40 lines of `handle_connection` logic from the example binary. Keeping both in sync is a manual discipline; V3.2+ can promote to `pub mod relay` in the lib if reuse demands grow.

- [x] **V3.1.b — IDE `quantlab.quantbookDemoMultiWindow` command** ✅ SHIPPED 2026-05-22 at IDE commit `b314ead754d`.
   Design pivot from the original V3 plan: instead of env-var role hand-off + programmatic `vscode.openFolder` for window 2, V3.1.b uses **symmetric try-connect-first** -- each window runs the same command; the first window to invoke spawns the relay, subsequent windows detect it already listening and skip spawn. PeerId = `BigInt(process.pid)` (Lane C R7); row = `pid & 0xffff` so multi-window edits land in distinct rows for visual convergence.
   - New `resolveRelayBinaryPath()` in `extensions/quantlab/src/quantbook/loader.ts` (mirror of `resolveEnginePath` walk-up pattern; escape hatch `QUANTBOOK_RELAY_BINARY_PATH`).
   - New `extensions/quantlab/src/quantbook/multiWindowDemo.ts`:
     - `spawnRelayBinary(log, binaryPath)` waits for the V3.1.a stdout marker `[ql-collab-ws relay] listening on ws://...` before resolving (Lane C R6 closure).
     - `connectOrSpawn(engine, log)` symmetric across windows.
     - `reconnectWithBackoff(engine, log)` 3 retries at 500/1000/2000ms (Lane C R2 closure).
     - `runMultiWindowDemo(engine, log) -> Disposable` orchestrates: session per window, auto-flush onAppend, periodic 2s append + 1s poll, transport_closed -> reconnect path.
   - New command `quantlab.quantbookDemoMultiWindow` registered alongside V1 `quantlab.quantbookDemo`. Both share the OutputChannel.
   - package.json + package.nls.json updated with the new command + title.
   - User instructions surfaced in OutputChannel: "Open another VS Code window via File > New Window and run this command again."

- [~] **V3.1.c — Multi-window error UX** — PARTIALLY shipped in V3.1.b (`b314ead754d`):
   1. ✅ `transport_closed` → automatic detach + reconnect with 500/1000/2000ms backoff, 3 tries max, "Connection lost" `vscode.window.showErrorMessage` on exhaustion. Implemented in `multiWindowDemo.ts::reconnectWithBackoff` + `handleTransportClosed`.
   2. [ ] Server-side crash UX: today the reconnect-exhausted notification IS the "Demo server stopped" surface, but there is no "offer to restart" action. V3.1.c remainder: add a `vscode.window.showWarningMessage(message, 'Restart Demo')` action that re-invokes the command on user click.
   3. [ ] Document reconnect contract in `docs/architecture/ide-consumer-contract.md`.

- [x] **V3.1.d — Tests** ✅ PARTIALLY done in V3.1.a + V3.1.b commits:
   1. ✅ V3.1.a integration tests in `crates/ql-collab-ws/tests/relay.rs` (2 tests): cross-broadcast A→B + self-filter pin; 3-way fan-out pin.
   2. ✅ V3.1.b IDE mocha `V3.1 round-trip: two sessions exchange ops through spawned relay binary` (port 17117 to avoid 7117 demo collision; spawns binary, awaits readiness, two sessions, A→B + B→A propagation pins). 97/97 mocha after V3.1.b.
   3. [ ] V3.1.d remainder (deferred to V3.1.c follow-up): mocha test for the reconnect path -- kill relay mid-flight, assert `transportLastError()` populates + reconnect succeeds when relay restarts. Requires more elaborate process lifecycle (kill+respawn within one test). Reuse the V2.5 BlockingTransportFixture pattern is NOT needed -- the relay binary itself provides deterministic timing.

- [ ] **V3.1.e — Audit obligations** per audit-discipline rules:
   - Parallel Codex + Opus per step (Rule 2).
   - Drop-order walk if any new binding class is added (Lane C R4).
   - Rule 4 (no negative-trait claims without proof) — expect 0 if no new !Send/!Sync claims; V3.1 likely just composes existing types.
   - V2 backlog item: cap napi `block_ms` at sane upper bound (Lane C R5 — 60_000ms ceiling). NOT a V3.1 requirement, defer to V3.x.

### V3.1 acceptance criteria

- [ ] Localhost ws relay binary exists + accepts connections (or A-path: `WebSocketServer` type lands in ql-collab-ws).
- [ ] `quantlab.quantbookDemo` spawns 2 IDE windows, both connect to relay, ops propagate.
- [ ] Disconnect / reconnect UX is documented + tested.
- [ ] Mocha test suite reaches ~99 / 99 (was 96; +3 V3.1 tests).
- [ ] ql-collab-ws workspace tests pass (any new server-side tests if A-path).
- [ ] V3.1 entry packet at `docs/phase5/5-7-v3-1-entry-packet.md` (smaller than V2 exit packet -- captures the relay design + reconnect contract).
- [ ] Audit transcripts at `docs/audits/2026-05-23-phase-5-7-v3-1-{codex,opus}.md` (or whatever date this lands on).

### V3.1 deferred to V3.x

- TLS for the localhost ws transport (not required for local demo).
- Auto-reconnect with smarter backoff (V3.1 ships 3-try fixed-delay; smarter policy = V3.x).
- Bounded outbound mpsc backpressure (Lane C R2 — localhost has ample memory; defer).
- Server-side state (multi-window relay is stateless — each peer's session is independent).
- Production deployment of the relay (V3.1 is dev-only demo).

## §1 First-five-minutes verification (V3 session entry)

```sh
# Engine
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
git status --short | grep -v '^??'    # expect empty
git log --oneline -3
# Expect newest at top:
#   <v3-entry-plan-commit> docs(5.7): V2 archive + V2.9 closure + V3 entry plan
#   18d498fcffb docs(5.7): V2 docs finalize v4 -- V2.8 megaudit closures + V2 exit packet
#   6917e36d846 Phase 5.7 V2.8 megaudit code closures (engine)

# IDE
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab
git status --short | grep -v '^??'   # expect empty
git log --oneline -3
# Expect newest first:
#   <v2.9-closure-ide-commit> feat(quantbook): V2.9 Lane C M3 closure + V3.1 entry test
#   5af03456785 feat(quantbook): Phase 5.7 V2 docs finalize v4 (IDE)
#   07bb0043dc4 feat(quantbook): Phase 5.7 V2.8 megaudit code closures (IDE)
```

## §2 Reading order for V3.1 (next session)

1. **`memory/current_work.md`** — session handoff entry point. Will be updated again at V3.1 ship.
2. **This V3 plan** (`.plans/_active.md`) — current step inventory + V3.1 sub-steps.
3. **`docs/phase5/5-7-v2-exit-packet.md`** — V2 phase termination packet. V3 builds on V2's architectural decisions.
4. **`docs/audits/2026-05-22-phase-5-7-v2-megaudit-opus-b-v3.md` § Section 3** — Lane C's V3 entry readiness analysis. Multi-window gaps + V3 risks R1-R5.
5. **`docs/architecture/ide-consumer-contract.md` § 4.1** — current IDE consumer surface (now reflects V2.1-V2.7 bound).
6. **Engine `crates/ql-collab-ws/src/lib.rs`** — current WebSocketTransport. Client-only today; V3.1.a may extend.
7. **IDE `extensions/quantlab/src/commands/quantbookCommands.ts`** — current `quantlab.quantbookDemo` (single-window V1 form). V3.1.b rewrites.

## §3 V3.1 risk register

(Per Lane C R1-R5 + V3.1-specific concerns.)

- **R1 (resolved)**: Production-cdylib fixture leak. CLOSED at V2.8 via cfg-gate.
- **R2 (partially-resolved)**: parseQuantbookError scaling. V2.8 closed cause-walk; V3.1.c adds reconnect UX.
- **R3**: Send+Sync claim drift as V3 binding surface grows. V3.1 likely doesn't add new binding classes; revisit at V3.2 (cell-grid UI may add).
- **R4**: Drop order under new bindings. V3.1 doesn't add; revisit at V3.2/V3.3.
- **R5**: BlockingTransport block_ms upper bound = u32::MAX. Lane C recommended capping at 60_000ms. V3 backlog (not V3.1 blocker).
- **R6 (new for V3.1)**: VS Code `vscode.openFolder` second-window timing. The new window initializes asynchronously; the relay server must be up BEFORE either window connects. Mitigation: V3.1.b sequences `spawn relay → wait for ready signal → spawn window 2`.
- **R7 (new for V3.1)**: PeerId collision in dev mode. Both demo windows hardcoded as PeerId=1 / PeerId=2; if the user runs the demo twice without resetting, the second invocation overlaps. Mitigation: V3.1.b uses `peerId = process.pid` or a UUID-derived BigInt to make collisions vanishingly rare.
- **R8 (new for V3.1)**: Demo binary discovery. The relay binary lives outside the engine cdylib; the IDE needs to find it. Reuse the V1 walk-up discovery pattern in loader.ts but for the relay binary (or shell out `cargo run` from the engine workspace).
