---
title: Phase 5.5 V2 V3 step 4 audit — Opus subagent verdict (adversarial probe lane)
date: 2026-05-21
audit_target: HEAD `2cfac5b0395` (V2 V3 step 4 — WebSocket transport, `ql-collab-ws` crate)
auditor: Opus subagent (independent of engineer; parallel with Codex)
verdict: PASS-WITH-FINDINGS (0 HIGH + 5 MEDIUM + 4 LOW)
lane: adversarial probe
---

# Phase 5.5 V2 V3 step 4 — Opus Adversarial Audit

## VERDICT: PASS-WITH-FINDINGS

The first production-grade `Transport` impl is functionally sound: the sync/async bridge via two background tokio tasks honors the `Transport` trait contract correctly (drain-before-close, `send` queues only, no auto-retry), the crate boundary is well-justified, `Drop` correctly aborts both tasks, and the 13 integration tests provide meaningful coverage including the three high-value V2 V2 + V2 V3 step 1-3 contract-over-real-WS regressions. The compile-time `Send` assert and `#[non_exhaustive]` `WebSocketError` enum are correct hardening choices. tokio-tungstenite 0.29 has default features `connect` + `handshake` only — no accidental TLS dep pull-through.

However, this is the first step at this layer where errors leave the type system unaccompanied by structure: the writer/reader tasks discard their tungstenite errors (`if let Err(_e)` and `Err(_e)` arms in lib.rs:214 and lib.rs:247) so consumers see a uniform `Closed` regardless of whether the cause was peer reset, write-buffer overflow, protocol violation, or a panic. For an IDE consumer driving reconnect handshakes off `TransportError::Closed`, the lost causality matters. Plus several smaller surface-area issues: a misleading Drop docstring, a stale dev-deps comment pointing at a non-existent file path, one test name that doesn't quite match its assertion shape, and the unbounded mpsc memory-growth hazard is documented but not pinned by a test.

---

## HIGH

None.

---

## MEDIUM

### M1 — Writer/reader task errors silently discarded; `Closed` flattens 8 distinct failure causes

File: `crates/ql-collab-ws/src/lib.rs` lines 214 and 247.

The writer task:
```rust
if let Err(_e) = ws_sink.send(Message::Binary(bytes.into())).await {
    closed_writer.store(true, Ordering::Relaxed);
    return;
}
```
The reader task `Err(_e) => { closed_reader.store(true, ...); return; }`.

This is observably correct for the immediate happy/sad path — `send` and `try_recv` return `Err(Closed)` once the flag flips. But per the CLAUDE.md no-fallbacks rule ("Errors Must Be Visible"), discarding `_e` removes the ability to distinguish:

- **8 distinct tungstenite::Error variants** (per `tungstenite-0.29.0/src/error.rs`: `ConnectionClosed`, `AlreadyClosed`, `Io`, `Tls`, `Capacity`, `Protocol`, `WriteBufferFull`, `Utf8`, `AttackAttempt`) collapse into one `Closed` at the trait boundary
- **Server-initiated close-with-reason** (the `Close(CloseFrame)` payload at lib.rs:237) is dropped; reason and code never surface
- **Reader-task panic** vs **clean close** is indistinguishable on the caller side

For an IDE driving reconnect handshakes off `Err(TransportError::Closed)`, the choice between "show user 'connection lost — retrying'" vs "show user 'authentication failed — sign in again'" requires the cause. The current shape forces the consumer to either probe-and-retry-forever or always show a generic message.

Two minimal fixes available:

1. **`last_error: Arc<Mutex<Option<WebSocketError>>>` field** populated by tasks on exit; new accessor `pub fn last_error(&self) -> Option<WebSocketError>`. Consumers needing the cause read it after observing `Closed`.
2. **`TransportError::Io(String)` already exists** at `transport.rs:96`. The current Transport impl maps task-observed disconnects to `Closed` exclusively. Reader/writer could map non-graceful exits to `Io(reason)` and only protocol-Close to `Closed`. Symmetric with the trait's stated distinction.

The Drop-during-in-flight-send concern in the audit prompt § 2 is a special case of this: bytes queued just before drop are lost silently. Adding error observability also gives consumers a path to flag this scenario.

**Recommendation**: low-cost fix #1 in this closure cycle; defer richer Io classification to V2 V4 reconnect work where the consumer of the cause exists.

### M2 — Drop docstring describes a graceful-close path that does not run

File: `crates/ql-collab-ws/src/lib.rs` lines 286-297.

```rust
impl Drop for WebSocketTransport {
    fn drop(&mut self) {
        // ... Dropping `outbound_tx` (when self is
        // dropped) signals the writer task to exit gracefully via
        // `outbound_rx.recv()` returning None; abort() is a safety
        // net for the reader task ...
        self.closed.store(true, Ordering::Relaxed);
        self.writer_task.abort();
        self.reader_task.abort();
    }
}
```

The docstring claims `outbound_tx` drop signals the writer task to exit gracefully. But in Rust, `Drop::drop` runs **before** the struct's fields are dropped. So the order is:

1. `Drop::drop` body runs — calls `writer_task.abort()` while `outbound_tx` is still alive
2. After `Drop::drop` returns, fields drop in declaration order: `outbound_tx`, `inbound_rx`, `closed`, `writer_task`, `reader_task`
3. By the time `outbound_tx` drops, the writer task has already been aborted

So the `outbound_rx.recv().await -> None -> ws_sink.close().await` path (lib.rs:218-222) is **unreachable from Drop**. It only runs in tests/situations where the caller manually moves `outbound_tx` somewhere else — which is impossible since it's a private field.

This is not a correctness bug (`abort()` is sufficient), but the docstring misleads future maintainers. Either (a) reorder Drop to drop outbound_tx first (would require moving the sender out — awkward), or (b) revise the docstring to say "abort is the sole shutdown path; the graceful-recv-None branch in the writer task only fires when the task itself drops, which under current design only happens via abort."

**Recommendation**: docstring fix only. The current behavior is correct for an MVP — tasks abort cleanly; OS handles the TCP teardown. The graceful `ws_sink.close().await` branch is genuinely useful for a future "soft close" API but not the Drop path.

### M3 — `RejectingServer` accept-then-drop fires `_stream` drop INSIDE the `if let Ok(...)` scope; behavior may not match the test's spelled-out expectation

File: `crates/ql-collab-ws/tests/common/mod.rs` lines 123-129.

```rust
let accept_task = tokio::spawn(async move {
    if let Ok((_stream, _)) = listener.accept().await {
        // _stream drops here; client sees connection reset.
    }
});
```

The comment claims `_stream` drops here. It does — but **only after the empty block exits**, and then the `accept_task` itself completes. The race window: between TCP accept and stream drop, the kernel may have already sent the SYN-ACK; the client's tokio-tungstenite begins the HTTP upgrade write. The stream drop sends FIN. Whether the client sees FIN **mid-HTTP-write** or **before any read** is platform/timing-dependent.

The corresponding test (`websocket_transport.rs` lines 105-125) hedges by accepting EITHER `HandshakeFailed` OR `ConnectFailed`:
```rust
matches!(result, Err(WebSocketError::HandshakeFailed(_)) | Err(WebSocketError::ConnectFailed(_)))
```

The test comment justifies this as "platform-dependent" but the actual cause is two-fold:
1. **Timing**: when does the client send the HTTP upgrade vs receive the FIN
2. **Classification**: tungstenite returns `Io(_)` if EOF arrives before HTTP response bytes (→ ConnectFailed), or `Http(_)` if some bytes arrived and parsed badly (→ HandshakeFailed)

This is acceptable for an MVP test but the fixture would be more deterministic if `RejectingServer` either (a) explicitly held the stream for some configured duration before dropping, or (b) wrote a deliberately-malformed HTTP response then dropped, forcing the `HandshakeFailed` path. Right now the test passes on whichever platform it runs on, but a future CI environment with different timing characteristics could shift the outcome unexpectedly — flake risk is non-zero.

**Recommendation**: defer fix — the platform-tolerant test is reasonable for V1 — but flag in the V2 V4 backlog: "tighten `RejectingServer` to deterministically force HandshakeFailed."

### M4 — `collab_session_websocket_send_after_close_surfaces_closed` test depends on a 200ms grace + ordering that has multiple race shapes

File: `crates/ql-collab-ws/tests/websocket_transport.rs` lines 434-482.

The test:
1. Connect to echo server, attach to session, set OnAppend
2. `append_op(add_sheet())` — first append flushes via WS, server echoes
3. `drop(server)` — accept aborted, per-conn aborted, TCP socket gone
4. Sleep 200ms
5. `poll_remote()` — drains any pending echo
6. `append_op(put_value(...))` — auto-flush should hit Closed; op MUST commit locally

The race surface:
- After `drop(server)`, the **client's reader task** observes EOF and sets `closed = true`. This happens on the next tokio scheduler tick after the FIN arrives — typically <10ms, but 200ms is the conservative grace.
- The **writer task** may not observe failure until the NEXT send (lib.rs:214). Crucially: between `drop(server)` and the next `append_op`, the writer task has nothing in `outbound_rx` (we already drained from step 2). So the writer task is parked on `outbound_rx.recv().await` — it does NOT independently observe the broken socket until either (a) a new send arrives that fails, or (b) the reader task sets `closed` but the writer task doesn't read that flag.
- The test relies on the reader task setting `closed` → `send` checks `closed` at lib.rs:302 and returns `Err(Closed)` BEFORE the writer task is involved.

This works on the current implementation. But it's load-bearing on **"`send` reads `closed` first"** — i.e., lib.rs:302-303 must precede the outbound_tx.send call. If a future refactor reorders this (e.g., to enable an outbox-queuing-while-closed feature), the test would flake.

A more robust test would also assert WHY closed was observed — but per M1, that information isn't currently exposed. Plus the test doesn't pin behavior when the server-close arrives MID-FLUSH (between the writer task's `recv` and `send`). The current implementation handles it (the `send` returns Err → writer task sets closed and exits → next caller `send` returns Closed via the flag check), but no test exercises this race.

**Recommendation**: in closure, add a test that asserts the closed-flag-precedes-outbound-tx ordering remains, OR add a brief comment in `Transport::send` noting it's load-bearing for race correctness. Defer the mid-flush race test to V2 V4.

### M5 — Unbounded outbound mpsc memory-growth hazard is documented in 4 places but pinned by zero tests

File: `crates/ql-collab-ws/src/lib.rs` lines 53-55 (module-doc); `crates/ql-collab/src/transport.rs` (referenced); `docs/architecture/ide-consumer-contract.md` line 214; `docs/phase5/v1-exit-packet.md` line 296.

All four surfaces say "memory grows if peer disconnects + caller keeps appending." But none of the 13 integration tests verify what actually happens in this scenario. The likely behavior:

1. Server disconnects; reader task observes EOF, sets `closed = true`
2. Writer task is parked on `outbound_rx.recv()` — has not yet observed failure
3. Caller calls `send(bytes)`. lib.rs:302 reads `closed` → already true → **returns `Err(Closed)` before queueing**.

So the actual memory-growth window is narrow: only between server-disconnect and reader-task-flag-set. The documented hazard ("memory grows") is **probably overstated** by current code — the closed flag fast-paths sends quickly.

Conversely: if the SERVER side stops accepting writes but doesn't tear down the TCP socket (TCP backpressure / dead-peer scenario), the writer task's `ws_sink.send` would block, `outbound_rx` would grow unboundedly, and `send` would NOT see closed (reader still reading any incoming bytes; closed flag still false). This is the real unbounded-growth scenario.

Two concerns:
- The documentation is imprecise (doesn't distinguish broken-pipe from dead-peer)
- No test exercises either shape; the hazard exists in the spec without code-level verification

**Recommendation**: tighten the documentation (specifically: "unbounded only when WS sink stalls due to peer dead-but-not-closed or slow consumer; an explicit Close fast-paths via reader-task flag") and add a smoke test under V2 V4 closure when the bounded-queue helper lands.

---

## LOW

### L1 — `tests/common/echo_server.rs` referenced in dev-deps comment but file is `tests/common/mod.rs`

File: `crates/ql-collab-ws/Cargo.toml` lines 26-28.

The dev-deps comment says:
```
# tests/common/echo_server.rs
```

But the file is actually `tests/common/mod.rs` (verified). Cosmetic-only — doesn't affect build.

### L2 — `connect_to_non_websocket_tcp_server_returns_handshake_or_connect_failed` test name uses "_or_"

File: `crates/ql-collab-ws/tests/websocket_transport.rs` lines 105-125.

Convergent with M3. The test name encodes the disjunction explicitly, which is honest, but the V2 V3 step 2 audit established the rule: "test names that lie violate the audit discipline." This test name doesn't lie — it accurately says "or" — but the underlying nondeterminism behind that "or" is the M3 issue. Consider renaming to `connect_to_rejecting_tcp_server_returns_error` once the underlying ambiguity is resolved (V2 V4 fixture tightening).

### L3 — Module-doc says "auto-pong" for inbound ping; tokio-tungstenite 0.29 default behavior is to surface ping as an event for caller to pong manually

File: `crates/ql-collab-ws/src/lib.rs` line 61.

> "ping is handled by tokio-tungstenite's internal auto-pong"

Spot-check: tokio-tungstenite 0.29's `WebSocketStream` does in fact auto-respond to ping during the read path (yields the Ping in the stream AND queues a Pong in the sink for the next write). The reader task DROPS the `Ping(_)` arm at lib.rs:241-242 — which is correct (no app data to deliver) — but the auto-pong response only fires on the NEXT write through the sink. Since the writer task only writes on app sends, **a connection with no app traffic will NOT respond to ping until the app sends something**. Server-side idle timeout would then close the connection.

This is fine for the MVP (matches the documented "no auto-reconnect; V2 V4 handles") but the module-doc is slightly optimistic. A maintainer reading "internal auto-pong" might assume the heartbeat works end-to-end without app traffic — it doesn't.

**Recommendation**: minor docstring tightening: "tokio-tungstenite queues a Pong response on the sink for the next write; with no app traffic the Pong is not flushed until the next app send."

### L4 — Compile-time Send assert covers Send but not the documented "not Sync" intent

File: `crates/ql-collab-ws/src/lib.rs` lines 339-345.

```rust
const _ASSERT_WEBSOCKET_TRANSPORT_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<WebSocketTransport>();
};
```

The docstring (lines 130-136) explicitly says `WebSocketTransport: Send`, NOT `Sync`. The assert pins the Send half. If a future refactor accidentally adds an `Arc<dyn Sync>` field that incidentally makes the type `Sync`, the assert still passes silently — but the documented "not Sync" contract would be violated without a compiler signal.

Pinning negative trait bounds in Rust is awkward (no `assert_not_sync<T: !Sync>()` form), but a `static_assertions::assert_not_impl_all!` macro exists and is the idiomatic way. Optional, minor — the negative bound is more of a documented promise than a contract callers rely on.

---

## Suggested closure scope

Ranked cheap → impactful:

1. **L1 cosmetic** — fix `Cargo.toml` dev-deps comment to point at `tests/common/mod.rs`. 30 seconds.
2. **M2 Drop docstring** — revise to acknowledge `abort()` is the sole shutdown path under current design; the graceful-recv-None branch is dormant. 5 minutes.
3. **L3 auto-pong nuance** — tighten module-doc per the recommendation. 2 minutes.
4. **M5 documentation tightening** — distinguish broken-pipe from dead-peer in the unbounded-queue hazard across the 4 doc surfaces. 10 minutes.
5. **M4 race-ordering comment** — add a `// LOAD-BEARING: closed-flag check must precede outbound_tx.send` comment at lib.rs:302. 1 minute.
6. **M1 last_error accessor** — add `last_error: Arc<Mutex<Option<WebSocketError>>>` field + accessor; populate in both tasks' Err arms. ~30 minutes. **HIGHEST FORWARD-IMPACT** — unblocks V2 V4 reconnect-cause work that needs the causality.
7. **M3 RejectingServer determinism** — DEFER to V2 V4 fixture-tightening backlog.
8. **L2 test rename** — DEFER pending M3 resolution.
9. **L4 not-Sync assert** — DEFER; the negative bound is documentation, not contract-pinned.

Items 1-5 are 20-minute total cosmetic + doc closure. Item 6 is the only meaningful code change and is conditional on whether the V2 V3 step 5 megaudit also flags it (Codex's parallel run may surface convergent or divergent framing).
