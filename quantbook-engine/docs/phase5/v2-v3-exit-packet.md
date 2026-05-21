---
title: Phase 5.5 V2 V3 V1 exit packet
date: 2026-05-21
status: ACTIVE — V2 V3 V1 SHIPPED via step 6 close
ship_commit_range: 51748b02944 (V2 V2 ship) → bce64a5c1ce (V2 V3 step 5 megaudit closure) → [this commit] (V2 V3 V1 exit)
predecessor_exit_packet: docs/phase5/v1-exit-packet.md (V1 = LoopbackTransport + V2 V1 explicit-drive)
audit_cycle_total: 5 per-step (10 transcripts) + 1 megaudit (3 transcripts) = 13 transcripts
test_count_at_v3_v1_exit: 4436 / 0 (workspace, --test-threads=1)
test_count_delta_from_v1: 4367 (post-5.3 baseline) → 4436 (V2 V3 step 6 exit) = +69 net
phase_5_7_readiness: UNBLOCKED — IDE engineer can build the 3 main workflows (Synced indicator, reconnect handshake, offline-write recovery) from `docs/architecture/ide-consumer-contract.md` § 4.1 alone
---

# Phase 5.5 V2 V3 V1 exit packet

## Summary

V2 V3 ships the production-grade collaboration substrate on top of V2 V1's explicit-drive transport + V2 V2's `OnAppend` auto-flush. Six steps, all 6 shipped on `feat/quantbook-engine` between 2026-05-21 morning and evening (single multi-day session continuation).

**Substrate state at V2 V3 V1 exit**: 2-peer paired sessions via `LoopbackTransport`, 3-peer hub-fanout topologies, real WebSocket connectivity via `ql-collab-ws::WebSocketTransport`, offline-write recovery, idempotency-guarded delta flushing, panic-safe task lifecycle. Phase 5.7 (IDE vertical slice) is unblocked.

## Ship timeline

| Step | Substance | Ship commit | Audit closure |
|---|---|---|---|
| V2 V2 | `AutoFlushPolicy::{Disabled, OnAppend}` on `CollabSession` | `51748b02944` | `b7aa4cb7bb9` |
| V2 V3 step 1 | Per-transport version-vector tracking + `flush_delta_to_transport` + idempotency guard | `603bdc9aa6c` | `e5ff11d549a` |
| V2 V3 step 2 | `poll_remote*` triggers auto-flush after non-empty drain | `e4e1ce282b1` | `fc3de6f99c7` |
| V2 V3 step 3 | Offline-write story + `has_pending_flush()` helper | `c73249d338c` | `10f40eb228b` |
| V2 V3 step 4 | NEW crate `ql-collab-ws::WebSocketTransport` + `last_error()` | `2cfac5b0395` | `0addbb2efd0` |
| V2 V3 step 5 | Full-arc 3-way megaudit (Codex + Opus-A + Opus-B) | (no separate ship) | `bce64a5c1ce` |
| V2 V3 step 6 | V1 exit packet + consumer doc rewrite + status drift sweep | (this commit) | — |

## Final API surface (V2 V3 delta from V1)

V1 exit packet at `docs/phase5/v1-exit-packet.md` listed the initial API. V2 V3 adds:

### `ql-collab` core

- **`CollabSession::set_auto_flush_policy(AutoFlushPolicy) -> AutoFlushPolicy`** (V2 V2). Returns previous policy.
- **`CollabSession::auto_flush_policy() -> AutoFlushPolicy`** (V2 V2). Accessor.
- **`AutoFlushPolicy::{Disabled, OnAppend}`** (V2 V2). Re-exported at crate root.
- **`CollabSession::flush_delta_to_transport() -> Result<bool, CollabSessionError>`** (V2 V3 step 1). Bandwidth-efficient delta send via `LoroDoc::ExportMode::Updates`.
- **`OpLog::oplog_vv() -> VersionVector`** (V2 V3 step 1). Snapshot the current per-peer version vector.
- **`OpLog::export_delta_bytes(from: &VersionVector) -> Result<Vec<u8>, OpLogError>`** (V2 V3 step 1). Export ops added since the given baseline.
- **`CollabSession::has_pending_flush() -> bool`** (V2 V3 step 3). True iff `current_vv != last_flushed_vv`.
- **`Transport::last_error(&self) -> Option<String>`** trait method (V2 V3 step 5). Default `None`; buffered impls override to expose runtime cause.
- **`CollabSession::transport_last_error() -> Option<String>`** (V2 V3 step 5). Proxy through to the attached transport's `last_error()`.
- **`CollabSession::detach_transport` now `#[must_use]`** (V2 V3 step 5). Nudges callers to drop the returned `Box` for background-task release.

### `ql-collab-ws` (NEW crate, V2 V3 step 4)

- **`WebSocketTransport`** — first production-grade `Transport` impl. Bridges async tokio-tungstenite to the sync `Transport` trait via `tokio::sync::mpsc` channels + 2 spawned background tokio tasks (writer + reader).
- **`WebSocketTransport::connect(url: &str) -> Result<Self, WebSocketError>`** — async constructor.
- **`WebSocketTransport::last_error() -> Option<WebSocketError>`** — concrete-type accessor returning the structured variant.
- **`WebSocketTransport::is_closed() -> bool`** / **`close()`** — explicit lifecycle.
- **`WebSocketError`** with 4 variants: `InvalidUrl(String)`, `ConnectFailed(String)`, `HandshakeFailed(String)`, `RuntimeError(String)` (added in V2 V3 step 4 closure, also stores poison-note + task-panic signals after V2 V3 step 5 closure).
- **`#[non_exhaustive]` on `WebSocketError`** — future variants may be added pre-0.2.0.

## Test count progression

| Milestone | Workspace tests | Delta |
|---|---|---|
| Post-5.3 baseline | 4367 | — |
| V2 V2 ship | 4382 | +15 |
| V2 V2 audit closure | 4391 | +9 |
| V2 V3 step 1 ship | 4395 | +4 |
| V2 V3 step 1 audit closure | 4398 | +3 |
| V2 V3 step 2 ship | 4398 | 0 (3 new + 1 inverted) |
| V2 V3 step 2 audit closure | 4402 | +4 |
| V2 V3 step 3 ship | 4409 | +7 |
| V2 V3 step 3 audit closure | 4414 | +5 |
| V2 V3 step 4 ship | 4429 | +15 (13 integration + 2 unit) |
| V2 V3 step 4 audit closure | 4433 | +4 |
| V2 V3 step 5 megaudit closure | 4436 | +3 |
| V2 V3 step 6 (this exit) | 4436 | 0 (doc-only) |
| **Total V2 V3 V1 delta** | — | **+69 net** |

## Audit cycle summary

13 audit transcripts under `docs/audits/2026-05-21-phase-5-5-*.md`:

| Step | Audit lane(s) | Verdict |
|---|---|---|
| V2 V2 | Codex + Opus | PASS-WITH-FINDINGS (0H + 7M + 6L) |
| V2 V3 step 1 | Codex + Opus | PASS-WITH-FINDINGS (0H + 2M + 9L) |
| V2 V3 step 2 | Codex + Opus | PASS-WITH-FINDINGS (0H + 3M + 4L) |
| V2 V3 step 3 | Codex + Opus | PASS-WITH-FINDINGS (0H + 3M + 5L) |
| V2 V3 step 4 | Codex + Opus | PASS-WITH-FINDINGS (0H + 5M + 7L) |
| V2 V3 step 5 megaudit | Codex (protocol) + Opus-A (consumer) + Opus-B (defensive) | PASS-WITH-FINDINGS (2H + 11M + 9L combined) |

**0 HIGH findings closed unfixed.** Both Opus-A HIGH findings (H1 `last_error()` unreachable, H2 `Err(Closed)` docstring guidance) closed in step 5 cycle via `Transport::last_error` trait method + step 6 consumer doc rewrite respectively.

**Convergent megaudit findings**: queued-vs-acked semantics (Codex M1 + Opus-B M1) — documented in V2 V3 step 5 closure cycle; structural ack-channel fix subsequently shipped as **V2 V4 V1 step 1 (HEAD `3342e21b964`)** via `Transport::flush_pending` + `CollabSession::flush_pending_to_transport()` proxy.

## V1 limitations carried forward (deferred to V2 V4)

The substrate is production-ready at V2 V3 V1 ship, but the following limitations are documented + tracked in `docs/PHASE-4-V2-BACKLOG.md` (Tiers I, J, K).

### Transport-layer (V2 V3 step 4 + 5 surfacing)

1. **No TLS support (`ws://` only).** TLS deployments use a TLS-terminating reverse proxy in front. V2 V4 will add a `rustls` feature flag to `ql-collab-ws`.
2. **No auto-reconnect helper.** Caller drives via `detach_transport` + new `WebSocketTransport::connect` + `attach_transport`. The V2 V3 step 1 baseline-reset on attach makes this safe (offline ops redelivered). V2 V4 will add a `ReconnectingWebSocketTransport` wrapper with configurable backoff.
3. **Unbounded outbound mpsc queue.** Memory growth is bounded in practice for the common disconnect case (closed-flag fast-paths sends), but unbounded in the dead-peer-but-not-closed scenario (TCP backpressure stalls without closed flag). V2 V4 will switch to bounded mpsc with caller-configurable backpressure policy.
4. **Client-only.** Server-side WebSocket implementations use other libraries (`axum-tungstenite`, `warp::ws`). V2 V4 may add an optional `ql-collab-ws-server` sibling crate.
5. **Drops text/ping/pong inbound frames silently.** Loro payloads are binary; non-binary frames don't carry our protocol. Future protocol extensions could add a callback hook.

### Architectural (V2 V3 step 5 megaudit surfacing)

6. **Queued-vs-acked semantics** (Codex M1 + Opus-B M1, convergent) — **CLOSED by V2 V4 V1 step 1** (HEAD `3342e21b964`, 2026-05-21). `last_flushed_vv` advances when `Transport::send` returns Ok (bytes queued in mpsc), NOT when bytes hit the wire. **Closure**: `Transport::flush_pending(&mut self) -> Result<(), TransportError>` trait method (default `Ok(())` for synchronous impls) + `CollabSession::flush_pending_to_transport()` proxy. Buffered async impls (`WebSocketTransport`) override to block sync caller until the writer task has completed `ws_sink.send` for every queued blob — provides level-1 (local writer) ack. TCP-level (level 2) and peer-application-level (level 3) ack remain out of scope (require lower-layer hooks / bidirectional protocol respectively).
7. **Symmetric-OnAppend 2× wire bandwidth** (Opus-B M6): in symmetric 2-peer pairings, every appended op pays a round-trip duplicate cost. Each peer's `OnAppend` fires both on append (sending the local op) AND on poll_remote (re-sending the now-merged state). Loro dedupes on import, but the wire bytes were sent. Per-transport baseline refactor (one `last_flushed_vv` per attached transport instead of per-session) is V2 V4 work.
8. **Drop-during-flush bytes lost** (Opus-B M1): `WebSocketTransport::Drop` aborts the writer task while bytes may still sit in `outbound_tx`. Bytes between the last `ws_sink.send` and abort are silently lost. Recovery: detach + reattach a new transport — V2 V3 step 1 baseline-reset re-sends from empty VV (Loro dedupes anything the prior transport DID deliver). Documented; V2 V4 deferred.

### Consumer-ergonomics (V2 V3 step 5 megaudit surfacing — closed in step 6 docs)

These were Opus-A findings that point to consumer-doc gaps; all closed by the § 4.1 rewrite at `docs/architecture/ide-consumer-contract.md`:

- Synced/Unsynced indicator wiring (M1, L1, L2) → § 4.1.1
- Reconnect handshake with retry-action table (H1, H2, M2) → § 4.1.2
- Offline-write recovery with explicit-flush idiom (L3, L4) → § 4.1.3
- Send/Sync threading model → § 4.1.x

## V2 V4 backlog (3 tiers from V2 V3 megaudits)

Consolidated reference. Full entries at `docs/PHASE-4-V2-BACKLOG.md`.

**Tier I — Phase 5.5 V2 V3 step 3 extensions** (3 items; I1 ✅ subsequently SHIPPED as V2 V4 V1 step 2 at `ff76fc99d49` + audit closure):
- I1: `pending_op_count()` ✅ SHIPPED. `pending_op_summary()` (count + oldest-op timestamp) remains deferred pending Loro per-op-timestamp exposure.
- I2: `discard_pending_ops()` API for "discard unsynced changes on window close" workflows.

**Tier J — Phase 5.5 V2 V3 step 4 extensions** (3 items):
- J1: `RejectingServer` test fixture determinism + corresponding test rename.
- J2: Inbound text/ping/pong frame test pinning (needs custom server fixture).
- J3: `WebSocketTransport` Send/Sync compile-time asserts. **Note**: originally framed as "!Sync assert"; V2 V4 V1 step 3 implementation revealed the type is actually Send + Sync (the V2 V3 step 4 docstring was wrong). Subsequently SHIPPED as positive `assert_impl_all!(WebSocketTransport: Sync)` + bundled K5 `assert_impl_all!(WebSocketError: Send, Sync)`. See `docs/PHASE-4-V2-BACKLOG.md` Tier J3 entry for the discovery details.

**Tier K — Phase 5.5 V2 V3 step 5 megaudit extensions** (9 items):
- K1: Ack channel for end-to-end delivery confirmation (Codex M1 + Opus-B M1 fundamental fix).
- K2: Mid-drop bytes-lost test pinning.
- K3: EchoServer `tokio::sync::Mutex` migration risk documentation.
- K4: Large-blob chunking strategy (Opus-A M4 + Opus-B M1).
- K5: `WebSocketError: Send + Sync` compile-time assert.
- K6: `Debug` for `WebSocketTransport` includes `last_error.is_some()`.
- K7: Empty `Message::Binary(b"")` test pinning at `OpLog::merge_bytes` level.
- K8: `poll_remote_with_limit` auto-flush-on-error semantic decision.
- K9: `detach_transport` reuse pattern in consumer doc (absorbed by § 4.1.2 in step 6).

## Phase 5.7 readiness assessment

**UNBLOCKED.** The Phase 5.7 IDE vertical slice can be built today against the V2 V3 V1 substrate without spelunking engine internals. Specifically:

| Phase 5.7 deliverable | Substrate support | Notes |
|---|---|---|
| Two-window editing demo | ✅ `LoopbackTransport::pair()` for tests; `ql-collab-ws::WebSocketTransport` for production | Per `docs/architecture/ide-consumer-contract.md` § 4.1.1-3 |
| Auto-flush on every keystroke | ✅ `AutoFlushPolicy::OnAppend` | V2 V2 ship; bandwidth-efficient via V2 V3 step 1 delta path |
| Synced / Unsynced indicator | ✅ `has_pending_flush()` + `has_transport()` gating | Documented § 4.1.1 |
| Reconnect handshake | ✅ `transport_last_error()` + `detach_transport` + `attach_transport` | Documented § 4.1.2 + retry-action table |
| Offline-write recovery | ✅ Loro op log IS the offline queue + baseline-reset on reattach | Documented § 4.1.3 |
| Presence cursor / selection | ✅ V2 V3 V2 (Phase 5.6 ship, separate from V2 V3 transport work) | `update_presence` / `peer_presence` / `sweep_presence` |
| Undo / redo | ✅ V1 + V2 V1 (Phase 5.4 ship) | `start_undo_group_scoped` returns RAII guard |
| Post-merge rename-repair | ✅ V1 (Phase 5.3 ship) | `CollabSession::rebuild_workbook` |

**Not blocking Phase 5.7** (deferred to V2 V4): TLS, auto-reconnect helper, bounded backpressure, server-side crate, true ack-channel delivery semantics, large-blob chunking.

## Audit-discipline observations (carry-forward to future phase-level closures)

1. **Investigation-first pays off**: V2 V3 step 3 investigation showed no offline queue needed (Loro IS the queue) — saved a planned ~1d implementation. V2 V3 step 4 investigation surfaced the runtime constraint (no tokio in core → new crate). 30-minute upfront cost saves 1-2× downstream churn.

2. **Doc-surface drift is the leading per-step audit find**: every step 2/3/4 closure had at least one finding about V1-limit / contract-language drift across the 4 surfaces (`transport.rs`, `MASTER-PLAN.md`, `v1-exit-packet.md`, `ide-consumer-contract.md`). Future ships: default to grep-ing for the OLD contract language as part of pre-commit checklist.

3. **`if let Err(_e)` and `.lock().ok()` are no-fallback violations in disguise**: V2 V3 steps 3/4/5 each had one. Rule: at every task / error boundary, capture the cause into an observable surface — no `_e`, no `.ok()` swallow.

4. **Drop / drop-order subtleties bite**: V2 V3 step 4 Opus M2 caught a docstring describing a Drop-graceful-path that's structurally unreachable (Rust drop order: body before fields). Audit Drop impls specifically for "what the docstring claims" vs "what the drop order actually does."

5. **3-way megaudit at phase boundary catches what per-step audits cannot**: V2 V3 step 5's 3 lanes (Codex protocol + Opus-A consumer + Opus-B defensive) found 2H + 11M + 9L. The convergent finding (queued-vs-acked semantics) and the Opus-A H1 (last_error unreachable) were both cumulative-state issues — they only matter when contracts from multiple steps interact. Per-step audits would have missed both.

6. **Consumer round-trip lane finds different bugs than protocol lane**: Opus-A's H1 was invisible to Codex (correct protocol) and Opus-B (no race) — visible only when walking the IDE workflow end-to-end. **Always include a consumer-perspective lane in megaudits.**

7. **`#[must_use]` on Box-returning APIs**: adding `#[must_use]` to `detach_transport` immediately surfaced 3 call sites that ignored the return. Cheap defensive hardening with consumer benefit.

8. **TaskExitGuard RAII pattern for panic-safe task cleanup**: idiomatic for tokio tasks where any-exit-must-do-X (set flag, record error). Reuse for V2 V4 reconnect helper if added.

## Forward direction

**Next**: Phase 5.7 IDE vertical slice. Two-window editing demo. ~1 week.

**Phase 5.5 V2 V4 (when scheduled)**: Tier I + J + K (~15 items across 3 tiers). Estimated 2-4 weeks depending on TLS feature complexity and reconnect-helper scope.

**Phase 5.8 megaudit**: randomized peer-merge tests + transport failure modes. ~4-6 days. Depends on 5.7 complete.
