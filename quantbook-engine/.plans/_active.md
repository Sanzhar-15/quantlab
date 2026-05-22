---
name: 2026-05-22_phase-5-7-v3-multi-window-demo
status: in-progress (V2 phase TERMINATED via V2.8 megaudit + V2 exit packet; V2.9 Lane C M3 closure landing this commit; V3 entry plan drafted; V3.1 multi-window IDE demo is the first work item)
date: 2026-05-22
predecessor_plan: .plans/_archive/2026-05-22_phase-5-7-v2-transport-binding.md (V2 phase — Transport binding through V2.8 megaudit)
predecessor_v2_exit_packet: docs/phase5/5-7-v2-exit-packet.md (V2 phase termination — architectural decisions V2.1-V2.8, V3 backlog, V3-entry readiness reference)
predecessor_lane_c_v3_readiness: docs/audits/2026-05-22-phase-5-7-v2-megaudit-opus-b-v3.md (§ Section 3 — V3 ENTRY READINESS — Lane C's Part 2)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V3 — product-visible vertical slice. Multi-window IDE demo first; cell-grid UI + persistence + rebuild_workbook wiring + full Op enum + undo/redo + presence follow.
current_engine_head: 18d498fcffb (docs(5.7) V2 docs finalize v4 — V2 phase termination)
current_ide_head: 5af03456785 (V2 docs finalize v4 IDE — V2 phase termination)
current_mocha_count: 96 / 96 (V2.8 baseline 95 + V2.9 Lane C M3 round-trip test)
current_ql_collab_tests: 74 / 74 (with --features test-fixtures)
current_ql_collab_ws_tests: 10 / 10
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

- [ ] **V3.1.a — Localhost ws server (engine side OR test binary)** — pick one of:
   - (A) Extend `ql-collab-ws` with a `WebSocketServer` type using `tokio-tungstenite::accept_async`. Reuses the existing crate's tokio infrastructure. Adds a new top-level type but stays inside `ql-collab-ws`'s scope.
   - (B) New test-only binary at `crates/ql-collab-ws/examples/relay-server.rs` (or `crates/ql-bindings-node/examples/relay-server.rs`). Smaller scope (no public API addition). Demo-only.
   - **Recommendation: B for V3.1** (smaller scope, clearer demo-only signal). Revisit A if V3.2+ needs reusable server in tests.

- [ ] **V3.1.b — IDE `quantlab.quantbookDemo` command rewrite** — currently a single-window demo (per V1). Rewrite to:
   1. Check whether already-running-as-window-2 (env var `QUANTLAB_QUANTBOOK_DEMO_PEER=2`).
   2. If not (i.e., this is window 1): spawn relay server (child process via `child_process.spawn` of the V3.1.a binary, OR same-process via napi if A path chosen). Spawn window 2 via `vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true })` with env override so window 2 knows its peer role.
   3. Both windows: load engine, create `CollabSession(peerId = 1n or 2n)`, `Transport.websocketConnect('ws://localhost:<port>')`, `attachTransport(t)`, set `AutoFlushPolicy::OnAppend`.
   4. Surface progress in the OutputChannel with peer ID + connection state + op count.
   5. Demo command in window 1 appends `PutValue(sheet=0, row=peerId, col=0, value=$timestamp)` every 2s; window 2 polls `pollRemote()` every 1s; both windows log `opCount()` to their OutputChannel. Edit propagation visible in the OutputChannel.

- [ ] **V3.1.c — Multi-window error UX** — Lane C R2: today's `parseQuantbookError` handles single-session failure modes. Multi-window adds: peer disconnect from the other window, server crash, rapid reconnect storms. V3.1 ships:
   1. `transport_closed` -> automatic detach + reconnect with exponential backoff (3 tries max, then "Connection lost" notification).
   2. Server-side crash: both windows surface "Demo server stopped" + offer to restart.
   3. Document the reconnect contract in IDE consumer notes.

- [ ] **V3.1.d — Tests** — at least:
   1. Mocha test that spawns the relay binary in a fixture, opens two CollabSessions in the SAME process (cross-Worker is unsupported per V2 — multi-window is cross-PROCESS), attaches both as separate ws clients to localhost, appends on session A, asserts session B sees the op via `pollRemote` within 500ms.
   2. Mocha test for the reconnect path: kill the relay mid-flight, assert `transportLastError() === 'WebSocket runtime error: ...'` + `parseQuantbookError(err).code === 'transport_closed'` on next send.
   3. Reuse the V2.5+V2.6 BlockingTransportFixture pattern for deterministic timing if needed.

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
