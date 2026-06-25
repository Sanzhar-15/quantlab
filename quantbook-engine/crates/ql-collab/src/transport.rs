//! `Transport` trait — wire-byte channel for Phase 5 collaboration.
//!
//! **Phase 5.2.a (2026-05-19, scaffold):** trait shape defined.
//! **Phase 5.5 V1 (2026-05-19, `924750819bc`):** `LoopbackTransport`
//! shipped — in-process paired endpoints for 2-peer tests.
//! **Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05` + audit closure):**
//! `CollabSession` exposes 5 typed transport methods
//! (`attach_transport` / `detach_transport` / `has_transport` /
//! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
//! V2 V1 is "explicit drive" — caller invokes flush + poll on a
//! tick.
//! **Phase 5.5 V2 V2 (2026-05-21):** `AutoFlushPolicy` enum on
//! `CollabSession`. Opt-in `OnAppend` invokes flush automatically
//! after every mutator. Default is `Disabled` (V2 V1 behavior
//! preserved). See [`crate::AutoFlushPolicy`] +
//! [`crate::CollabSession::set_auto_flush_policy`].
//! **Phase 5.5 V2 V3 step 1 (2026-05-21):** version-vector tracking
//! for the **currently attached** transport baseline + delta flushes.
//! `CollabSession::flush_delta_to_transport` sends only the delta
//! since the last successful flush via `LoroDoc::ExportMode::Updates`.
//! Auto-flush routes through this delta path — wire payload is
//! O(per-op delta) instead of O(full state). Idempotency
//! short-circuit (no state change → no send) closes the V2 V2
//! echo-loop concern. The checkpoint is
//! per-session-currently-attached-transport, NOT per-transport-
//! identity (`attach_transport` resets the baseline).
//! **Phase 5.5 V2 V3 step 2 (2026-05-21):** wires `poll_remote*`
//! into auto-flush. After a successful drain (`merged > 0`), one
//! auto-flush fires per call (not per-blob — bandwidth-efficient).
//! V2 V3 step 1's idempotency guard prevents echo loops: drained
//! bytes that Loro dedupes leave the VV unchanged → flush
//! short-circuits to `Ok(false)`. 3-peer hub-fanout pattern now
//! works automatically under `OnAppend`.
//! **Phase 5.5 V2 V3 step 3 (2026-05-21):** offline-write story.
//! Investigation showed no explicit queue is needed: Loro's CRDT op
//! log IS the implicit offline queue. Append while no transport
//! attached → `maybe_auto_flush` no-ops; op committed locally. On
//! reattach: `attach_transport` resets `last_flushed_vv = None`; the
//! next mutator (or explicit `flush_delta_to_transport`) sends from
//! empty VV — delivers ALL accumulated ops including offline ones.
//! Adds `has_pending_flush() -> bool` ergonomic helper (compares
//! current VV vs last-flushed VV). 7 new integration tests pin the
//! offline-write contract.
//!
//! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
//! production-grade `Transport` impl ships as a separate crate,
//! `ql-collab-ws::WebSocketTransport`. Bridges async
//! tokio-tungstenite to the sync `Transport` trait via
//! `tokio::sync::mpsc` channels and two spawned background tasks
//! (reader and writer). Kept in a sibling crate so `ql-collab`
//! core stays runtime-agnostic; embedders needing only
//! `LoopbackTransport` or a custom impl don't pay for tokio. MVP
//! scope: client-only, plain `ws://`, NO TLS, NO auto-reconnect
//! (caller drives via detach and re-attach; V2 V3 step 1
//! baseline-reset contract delivers offline ops on reconnect).
//! 13 integration tests including 3 that verify the V2 V2 and
//! V2 V3 step 1-3 contracts hold over a real WebSocket. See
//! `ql-collab-ws` module docs for V1 limitations deferred to V2 V4
//! (TLS, auto-reconnect, bounded queue, server side, inbound
//! text/ping/pong frame dropping).
//!
//! **Phase 5.5 V2 V3 step 5 megaudit (2026-05-21, `bce64a5c1ce`):**
//! 3-way Codex+Opus-A+Opus-B. Lifted `last_error()` to the trait
//! (see method below), added `TaskExitGuard` RAII panic detection +
//! Close-frame reason capture + poisoned-mutex no-fallback fix.
//!
//! **Phase 5.5 V2 V3 step 6 exit packet (2026-05-21, `8a8236840f2`):**
//! V1 exit packet at `docs/phase5/v2-v3-exit-packet.md` + consumer
//! doc rewrite at `docs/architecture/ide-consumer-contract.md`
//! § 4.1.1-3 (3 worked-example subsections).
//!
//! **Phase 5.5 V2 V4 V1 (2026-05-21):** 12/13 Tier items shipped —
//! ack channel (`flush_pending`), `pending_op_count`,
//! `discard_pending_ops`, defensive hardening. K4 chunking deferred
//! to V2 V4 V2. See `docs/phase5/v2-v4-v1-exit-packet.md`.
//!
//! **Phase 5.7 V1 (2026-05-22):** FIRST IDE binding via napi-rs.
//! `crates/ql-bindings-node/` exposes `CollabSession` (no Transport
//! yet — V2). See `docs/phase5/5-7-v1-exit-packet.md`.
//!
//! Tests can also use [`NoopTransport`] which discards traffic.
//!
//! The contract is intentionally minimal:
//!
//! - `send(&mut self, bytes: &[u8])` — push bytes to the channel.
//!   Bytes are an opaque blob (a Loro export). The transport
//!   doesn't interpret them.
//! - `try_recv(&mut self) -> Option<Vec<u8>>` — non-blocking
//!   receive. Returns `None` if no bytes are queued.
//!
//! That's enough to plumb a `CollabSession::export_bytes` →
//! transport → remote `CollabSession::merge_bytes` flow. The
//! transport handles framing / reliability / reconnect / auth as
//! its implementation details.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use thiserror::Error;

/// Errors emitted by `Transport` impls.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum TransportError {
    /// The underlying I/O failed (socket dead, network partition,
    /// etc.). Implementations should distinguish recoverable
    /// (reconnect) from permanent (auth rejected) failures via
    /// variant structure in their own error type, then map to this
    /// variant at the trait boundary if they don't want to expose
    /// implementation details.
    #[error("transport I/O error: {0}")]
    Io(String),

    /// The transport is closed and no further sends are accepted.
    /// Receivers should still drain any already-queued bytes via
    /// `try_recv` before considering the channel done.
    #[error("transport closed")]
    Closed,
}

impl TransportError {
    /// **Phase 5.7 V2.7 (2026-05-22) — error-code discrimination.**
    ///
    /// Returns a stable `&'static str` identifier for this variant.
    /// Intended for the napi binding to prepend `[<kind>]` to JS
    /// error messages so IDE-side reconnect logic can branch on
    /// `error.code` (after parsing via `parseQuantbookError`)
    /// without substring-matching the human-readable `Display`
    /// text.
    ///
    /// **Stability**: variant kinds are SemVer-stable strings.
    /// Adding a new variant requires adding its kind here. Removing
    /// or renaming a kind is a breaking change for IDE consumers
    /// (their `code === 'transport_closed'` branches stop matching).
    /// Closes V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards (lossy
    /// `Display` projection of the underlying enum discriminant).
    pub fn kind(&self) -> &'static str {
        match self {
            TransportError::Io(_) => "transport_io",
            TransportError::Closed => "transport_closed",
        }
    }
}

/// Wire-byte channel for Phase 5 collaboration.
///
/// Implementations push and pull opaque byte blobs. The blobs ARE
/// Loro `LoroDoc::export(...)` snapshots / updates; the
/// transport doesn't interpret them. Framing (where one blob ends
/// and the next starts) is the implementation's responsibility.
pub trait Transport {
    /// Push `bytes` to the channel. Implementations may buffer
    /// internally; the call returns when the bytes are
    /// **queued for send**, not when the remote has received them.
    ///
    /// **V2 V3 step 5 megaudit closure (Codex M1 + Opus-B M1,
    /// 2026-05-21):** for buffered impls (`WebSocketTransport` and
    /// future async transports), there is a window between "send
    /// returned Ok" and "bytes on the wire" where the bytes can be
    /// silently lost (transport dropped, peer disconnect mid-flush,
    /// allocator failure during the writer task). The session's
    /// [`crate::CollabSession::flush_delta_to_transport`] advances
    /// `last_flushed_vv` immediately on `send`'s Ok return, so
    /// `has_pending_flush() == false` alone means "queued to the
    /// currently-attached transport," NOT "the peer has received the
    /// ops." **V2 V4 V1 step 1 (2026-05-21) Tier K1 closure**: call
    /// [`Transport::flush_pending`] after `flush_delta_to_transport`
    /// to block until the writer task has completed `ws_sink.send`
    /// for every queued blob — that provides level-1 (local writer)
    /// ack. For stronger guarantees (peer-application ack, TCP-level
    /// ack), keep the transport attached until you've verified peer
    /// reception out-of-band (e.g., via a custom ack-op layered on
    /// `merge_bytes`). On transport drop or `Err(Closed)`, detach +
    /// reattach a new transport — the V2 V3 step 1 baseline-reset
    /// contract re-sends from empty VV.
    ///
    /// On error, the caller should treat the byte blob as unsent
    /// and re-queue (or surface the error to the user). The
    /// transport will not retry automatically — that policy lives
    /// at the layer above (Phase 5.5 design will pick reconnect
    /// semantics).
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;

    /// Non-blocking receive. Returns `Some(bytes)` if a blob is
    /// queued, `None` otherwise. Implementations choose how often
    /// they poll the underlying channel; the contract is "if you
    /// have something, give it to me, else `None`."
    ///
    /// Returns `Err(TransportError::Closed)` only when the channel
    /// is permanently closed AND its internal queue is empty. A
    /// transient I/O failure during poll surfaces as
    /// `Err(TransportError::Io)`.
    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;

    /// Read the most recent transport-internal error, if any. Default
    /// returns `None` for impls without a runtime-error concept
    /// (`NoopTransport`, `LoopbackTransport`). Buffered async impls
    /// (`WebSocketTransport`) override to expose the underlying cause
    /// of the most recent task-observed failure.
    ///
    /// **V2 V3 step 5 megaudit closure (Opus-A H1, 2026-05-21):** the
    /// V2 V3 step 4 closure added `WebSocketTransport::last_error()`
    /// on the concrete type for IDE consumers driving reconnect
    /// handshakes — but `CollabSession::attach_transport` moves the
    /// concrete type into `Box<dyn Transport + Send>`, making it
    /// unreachable. Lifting the accessor to the trait + adding
    /// [`crate::CollabSession::transport_last_error`] proxy is the
    /// minimum-viable fix: IDE callers can now distinguish "peer
    /// reset" from "auth rejected" from "capacity exceeded" without
    /// downcasting or holding a parallel handle.
    ///
    /// Returns `Option<String>` (lossy) rather than a structured
    /// error type to keep the trait minimal and avoid leaking
    /// impl-specific types (`WebSocketError`, etc.). Consumers
    /// pattern-match on substring or just display the message.
    ///
    /// Read AFTER observing [`TransportError::Closed`] from `send`
    /// or `try_recv`. Returns `None` for clean shutdowns (caller
    /// `close()`, graceful peer Close frame, transport never failed).
    fn last_error(&self) -> Option<String> {
        None
    }

    /// Block until every byte blob previously queued via `send` has
    /// been written to the underlying transport's wire (e.g. WebSocket
    /// sink). Default `Ok(())` for synchronous transports
    /// (`LoopbackTransport`, `NoopTransport`) where `send` is already
    /// wire-delivery — there is no buffer to drain.
    ///
    /// **Phase 5.5 V2 V4 V1 step 1 (2026-05-21) — Tier K1 ack channel.**
    /// Closes the V2 V3 step 5 megaudit's convergent finding (Codex M1
    /// and Opus-B M1): buffered async transports
    /// (`WebSocketTransport`) return `Ok` from `send` once bytes are
    /// queued in an mpsc channel, NOT when bytes reach the wire.
    /// Without `flush_pending`, `CollabSession::has_pending_flush()
    /// == false` would mean "queued to currently-attached transport,"
    /// not "delivered." For IDE consumers building "safe to close
    /// window?" workflows, this is a real UX hole. `flush_pending`
    /// lets callers block until the local writer has caught up,
    /// providing a level-1 ack (bytes hit `ws_sink.send`
    /// successfully). TCP-ack (level 2) and peer-application-ack
    /// (level 3) require lower-layer hooks or custom protocols
    /// respectively.
    ///
    /// # Errors
    ///
    /// - `Err(TransportError::Closed)` if the transport is closed
    ///   (either before `flush_pending` was called OR during the wait
    ///   — e.g., writer task failed mid-flush and set the closed
    ///   flag).
    /// - `Err(TransportError::Io)` for internal synchronization
    ///   failures (mutex poisoning from a panicked task).
    ///
    /// # Async-context caveat
    ///
    /// `flush_pending` is blocking-sync (uses `Condvar::wait_timeout`).
    /// Calling it from within a tokio task body will block the
    /// runtime worker. Wrap with `tokio::task::block_in_place` (on
    /// multi-thread runtimes) or `tokio::task::spawn_blocking` (on
    /// any runtime) to avoid stalling other tasks.
    fn flush_pending(&mut self) -> Result<(), TransportError> {
        Ok(())
    }

    /// **Phase 5.7 V2.5 (2026-05-22) — async-flush ack handle.**
    ///
    /// Return a [`Box<dyn FlushAck + Send>`] that can wait for the
    /// drain target captured AT THIS CALL, from a context that has
    /// already released any outer locks guarding the [`Transport`].
    ///
    /// Default impl returns `None` (transports without async-flush
    /// semantics — Loopback, Noop — keep [`flush_pending`] as the
    /// canonical drain). Production transports with progress state
    /// shared across tasks ([`crate::WebSocketTransport`]'s writer)
    /// override and return a handle cloning their internal
    /// progress `Arc`s.
    ///
    /// # Target-snapshot contract (Codex M1 fix, 2026-05-22)
    ///
    /// Implementors MUST capture the drain target — i.e. the
    /// equivalent of `queued_count.load(...)` for transports with a
    /// writer counter — at this call site, BEFORE returning. The
    /// returned handle's [`FlushAck::wait_for_drain`] then waits
    /// until the writer progress reaches this captured target, NOT
    /// whatever `queued_count` is at wait-start time.
    ///
    /// Rationale: the napi binding pattern is
    ///
    /// 1. acquire session lock
    /// 2. call `transport.ack_handle()` → get handle (target captured here)
    /// 3. release session lock
    /// 4. `spawn_blocking(move || handle.wait_for_drain())`
    ///
    /// Between steps 3 and 4 the JS event loop is free to enqueue
    /// more sends via other session calls. Those sends MUST NOT
    /// extend the wait — the wait is "for sends queued BEFORE this
    /// call", same as [`flush_pending`]'s documented contract.
    ///
    /// # Async-context caveat
    ///
    /// [`FlushAck::wait_for_drain`] is blocking-sync (mirrors
    /// `flush_pending`). The intended caller pattern is to invoke
    /// it inside [`tokio::task::spawn_blocking`] (or equivalent) so
    /// the wait doesn't occupy a tokio worker thread.
    ///
    /// # Why a separate handle (vs `flush_pending(&self)`)
    ///
    /// The `&mut self` on `flush_pending` is enforced because the
    /// engine stores transports as `Box<dyn Transport + Send>` and
    /// proxies via `transport.as_mut()` — the trait object's
    /// dispatch interface requires `&mut self` for any mutator.
    /// Even if `flush_pending` itself doesn't logically mutate
    /// the transport's user-visible state, the call site needs a
    /// `&mut Box<dyn Transport>` and therefore an exclusive
    /// reference to the enclosing session.
    ///
    /// `ack_handle(&self) -> Box<...>` takes only a shared
    /// reference (no mutation; just cloning internal `Arc`s) so the
    /// napi binding can call it while holding only a brief
    /// `Mutex` guard, drop the guard, then run the wait without
    /// any outer lock held. Closes Opus V2.4 HIGH-1 (V8-block UX
    /// hazard) per
    /// `docs/audits/2026-05-22-phase-5-7-v2-4-opus.md:215-248`.
    fn ack_handle(&self) -> Option<Box<dyn FlushAck + Send>> {
        None
    }
}

/// **Phase 5.7 V2.5 (2026-05-22) — async-flush ack handle.**
///
/// Detached drain-wait abstraction for [`Transport`] impls with
/// progress state shared across tasks (e.g.
/// [`crate::WebSocketTransport`]'s writer counter + Condvar).
///
/// Constructed by [`Transport::ack_handle`]; the implementor
/// captures the drain target at construction time (see
/// [`Transport::ack_handle`] doc for the contract). The handle is
/// `Send` so a caller (typically the napi binding's
/// `flushPendingToTransport`) can move it across a
/// `tokio::task::spawn_blocking` boundary and perform the wait
/// without holding any outer lock guarding the transport.
///
/// **Send is required; Sync is not.** The trait requires only
/// `Send` so a future implementor wrapping a `!Sync` field (e.g.,
/// `Cell` for an internal cache) remains a valid `FlushAck`. The
/// shipped implementors ([`crate::WebSocketProgressAckHandle`] +
/// [`crate::BlockingAckHandle`] when the `test-fixtures` feature
/// is enabled) happen to be `Send + Sync` because every field is
/// Sync — pinned by positive compile-asserts at each impl site per
/// Rule 4. **V2.5 audit closure (Opus MEDIUM-1, 2026-05-22)**:
/// rewrote the prior `Send + !Sync` claim. Per-field walk of the
/// shipped impls (`Arc<(Mutex<u64>, Condvar)> + Arc<AtomicBool> +
/// u64` for `WebSocketProgressAckHandle`; `u64 + Arc<(Mutex<bool>,
/// Condvar)> + Arc<(Mutex<bool>, Condvar)>` for
/// `BlockingAckHandle`) shows both are `Sync`. The prior docstring
/// asserted a negative trait property (`!Sync`) that was
/// materially false — same Rule 4 anti-pattern as V2 V3 step 4's
/// false `WebSocketTransport: !Sync` claim. Caller code MUST NOT
/// rely on `!Sync` for safety; only on `Send`.
pub trait FlushAck: Send {
    /// Wait until the drain target captured at handle creation is
    /// reached, OR the underlying transport is closed.
    ///
    /// Mirrors [`Transport::flush_pending`]'s error semantics:
    /// `Err(TransportError::Closed)` if the transport was closed on
    /// entry or mid-wait; `Err(TransportError::Io(...))` for
    /// poisoned-mutex / channel-failure conditions.
    fn wait_for_drain(&self) -> Result<(), TransportError>;
}

/// No-op `Transport` impl for tests + scaffolding.
///
/// Records every `send` call in an internal `Vec` (so tests can
/// assert what would have gone over the wire) and `try_recv`
/// returns `None` forever (no incoming bytes). Suitable for tests
/// that exercise `CollabSession::append_op` without needing a
/// real channel. For 2-peer round-trip tests, use
/// [`LoopbackTransport::pair`] instead — `NoopTransport` is for
/// "I just need a Transport-shaped object" cases.
#[derive(Debug, Default)]
pub struct NoopTransport {
    /// Bytes the consumer would have pushed to the wire. Tests
    /// inspect this to verify their `CollabSession` calls emit the
    /// expected number / shape of exports.
    pub sent: Vec<Vec<u8>>,
    closed: bool,
}

impl NoopTransport {
    /// Construct a fresh `NoopTransport` with an empty `sent` log
    /// and `closed = false`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark the channel closed. Subsequent `send` calls return
    /// `TransportError::Closed`; `try_recv` returns `Closed` since
    /// nothing's queued.
    pub fn close(&mut self) {
        self.closed = true;
    }
}

impl Transport for NoopTransport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        self.sent.push(bytes.to_vec());
        Ok(())
    }

    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        Ok(None)
    }
}

/// **Phase 5.5 V1 (2026-05-19):** in-process paired `Transport`
/// impl for 2-peer round-trip testing.
///
/// Constructed via [`LoopbackTransport::pair`]: returns two
/// endpoints `(a, b)` where `a.send(bytes)` lands in `b`'s recv
/// queue and vice versa. The two endpoints share two
/// `Arc<Mutex<VecDeque<Vec<u8>>>>` channels via interior
/// mutability — `Send + Sync` so they can also be used across
/// threads if a future test wants that.
///
/// ## Use case
///
/// Wire two `CollabSession`s together for tests like:
/// ```ignore
/// let (mut tx_a, mut tx_b) = LoopbackTransport::pair();
/// let session_a = CollabSession::new(PeerId::new(1))?;
/// let session_b = CollabSession::new(PeerId::new(2))?;
/// // ... append ops on a, drain via tx_a.send / tx_b.try_recv ...
/// ```
///
/// **Phase 5.5 V2 V2 (2026-05-21):** `CollabSession` supports
/// opt-in auto-flush via `AutoFlushPolicy::OnAppend` — every
/// session mutator (`append_op`, `merge_bytes`, presence writes,
/// `undo` / `redo` when consumed, `sweep_presence`) then sends
/// through the attached transport automatically. Default policy
/// remains `Disabled` (V2 V1 explicit-drive behavior). Tests can
/// still drive the flow manually: append, export_bytes, send via
/// the transport, recv on the other side, merge_bytes — useful
/// when the test wants deterministic control over when bytes
/// land on the wire (e.g. ordering tests). **Phase 5.5 V2 V3 step 2
/// (2026-05-21):** `poll_remote*` now also triggers auto-flush after
/// a non-empty drain (one flush per call, not per-blob). See
/// [`crate::AutoFlushPolicy::OnAppend`] for the receive-side
/// contract.
///
/// ## Close semantics
///
/// Each endpoint has its OWN `closed` flag (separate
/// `AtomicBool`). `a.close()` shuts down endpoint A:
/// - A's `send` returns `TransportError::Closed` immediately.
/// - A's `try_recv` drains any already-queued bytes FIRST and
///   only returns `Closed` once the queue is empty (per the
///   `Transport` trait contract at the trait docstring).
/// - B is unaffected: B can still `send` (bytes land in A's
///   inbox; A drains them on the next try_recv before reporting
///   Closed) and `try_recv` (drains B's inbox).
///
/// ## Atomic ordering caveat
///
/// `close` uses `AtomicBool` with `Relaxed` ordering. For
/// cross-thread "close then send" semantics, callers must use
/// external synchronization — a thread that observes
/// `is_closed() == true` after another thread's `close()` is NOT
/// guaranteed by this transport alone (the atomic only protects
/// the flag itself, not the surrounding sequence).
pub struct LoopbackTransport {
    /// Channel WE drain via `try_recv`. The peer's `send` writes
    /// here.
    inbox: Arc<Mutex<VecDeque<Vec<u8>>>>,
    /// Channel WE write to via `send`. The peer's `try_recv`
    /// drains here.
    outbox: Arc<Mutex<VecDeque<Vec<u8>>>>,
    /// Per-endpoint close flag. Atomic so `close(&self)` doesn't
    /// need `&mut`.
    closed: AtomicBool,
}

impl std::fmt::Debug for LoopbackTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoopbackTransport")
            .field(
                "inbox_len",
                &self.inbox.lock().map(|q| q.len()).unwrap_or(0),
            )
            .field(
                "outbox_len",
                &self.outbox.lock().map(|q| q.len()).unwrap_or(0),
            )
            .field("closed", &self.closed.load(Ordering::Relaxed))
            .finish()
    }
}

impl LoopbackTransport {
    /// Construct a pair of `LoopbackTransport` endpoints. Returns
    /// `(a, b)` where `a.send(...)` enqueues to `b.try_recv()` and
    /// `b.send(...)` enqueues to `a.try_recv()`.
    pub fn pair() -> (Self, Self) {
        let a_to_b = Arc::new(Mutex::new(VecDeque::new()));
        let b_to_a = Arc::new(Mutex::new(VecDeque::new()));
        let a = Self {
            inbox: b_to_a.clone(),
            outbox: a_to_b.clone(),
            closed: AtomicBool::new(false),
        };
        let b = Self {
            inbox: a_to_b,
            outbox: b_to_a,
            closed: AtomicBool::new(false),
        };
        (a, b)
    }

    /// Mark this endpoint closed. Subsequent `send` / `try_recv`
    /// calls return `TransportError::Closed`. The peer endpoint
    /// is NOT affected by this call (each side has its own close
    /// flag).
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }

    /// True if this endpoint has been closed.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Number of bytes blobs waiting in this endpoint's inbox
    /// (i.e. sent by the peer, not yet drained via `try_recv`).
    /// Useful for tests that want to assert "the peer sent N
    /// blobs to me" without consuming them.
    ///
    /// **NF-01 (no-fallbacks):** panics on mutex poison instead of
    /// silently returning 0. A poisoned mutex means a thread panicked
    /// while holding the lock — the inbox state is undefined and
    /// returning 0 would mask a real bug.
    pub fn pending_recv(&self) -> usize {
        self.inbox
            .lock()
            .expect("LoopbackTransport inbox mutex poisoned")
            .len()
    }
}

impl Transport for LoopbackTransport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        self.outbox
            .lock()
            .map_err(|e| TransportError::Io(format!("loopback outbox lock poisoned: {e}")))?
            .push_back(bytes.to_vec());
        Ok(())
    }

    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        // Trait contract (transport.rs:71-74): "Closed only when the
        // channel is permanently closed AND its internal queue is
        // empty." So drain any already-queued bytes first; only
        // return Closed when both closed AND drained.
        // Codex + Opus 5.5 V1 audit MEDIUM/HIGH closure: pre-closure
        // we returned Closed immediately on close, violating the
        // contract.
        let mut queue = self
            .inbox
            .lock()
            .map_err(|e| TransportError::Io(format!("loopback inbox lock poisoned: {e}")))?;
        if let Some(bytes) = queue.pop_front() {
            return Ok(Some(bytes));
        }
        // Queue empty — now distinguish "open but empty" from "closed".
        if self.closed.load(Ordering::Relaxed) {
            Err(TransportError::Closed)
        } else {
            Ok(None)
        }
    }
}

// Codex + Opus 5.5 V1 audit closure: pin the Send+Sync contract
// the docstring promises. If a future refactor accidentally adds
// a non-Send/Sync field, this stops compiling.
const _ASSERT_LOOPBACK_TRANSPORT_SEND_SYNC: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<LoopbackTransport>();
};

// ================================================================
// Phase 5.7 V2.6 (2026-05-22) — BlockingTransport test fixture
// ================================================================
//
// Gated behind `feature = "test-fixtures"` per V2.5+V2.6 plan
// (Codex Q4 fix, 2026-05-22). Exists solely to force deterministic
// `flush_pending` contention so the V2.5 binding pattern (extract
// ack handle under lock, drop lock, then wait) can be regression-
// tested from IDE-side mocha.
//
// **Not a production type**: `flush_pending` blocks indefinitely
// until externally released via the paired `BlockingAckHandle`'s
// `release()` mechanism. Production callers would deadlock.

#[cfg(feature = "test-fixtures")]
use std::sync::Condvar;
#[cfg(feature = "test-fixtures")]
use std::time::Duration;

/// **Phase 5.7 V2.6 (2026-05-22) — test fixture.**
///
/// `Transport` impl that BLOCKS in `flush_pending` (and the
/// V2.5 `ack_handle().wait_for_drain()`) until externally
/// released, OR until the configured `block_ms` upper bound
/// elapses (defensive — tests never hang if `release()` is
/// forgotten).
///
/// `send` and `try_recv` are no-ops; the fixture tests flush
/// behavior in isolation, not the full send/recv cycle. For
/// 2-peer round-trip tests, use [`LoopbackTransport::pair`].
///
/// Use via the napi-binding-side `BlockingTransportFixture`
/// controller class, which owns the `release` + `blocked` Condvars
/// and exposes `takeTransport()` + `release()` + `waitUntilBlocked()`
/// to JS.
#[cfg(feature = "test-fixtures")]
pub struct BlockingTransport {
    /// Upper-bound wait duration in milliseconds. The wait exits
    /// at the earlier of (a) the `release` flag flipping to `true`
    /// or (b) `block_ms` elapsing. Prevents test hangs.
    block_ms: u64,
    /// Externally-controlled release signal. The
    /// `BlockingTransportFixture` napi class holds the same `Arc`
    /// and flips `*lock = true; cv.notify_all()` on `release()`.
    release: Arc<(Mutex<bool>, Condvar)>,
    /// Externally-observable "wait has been entered" signal. The
    /// `BlockingTransportFixture` napi class's
    /// `waitUntilBlocked()` JS method blocks on this until the
    /// flush task signals it has entered the wait. Makes V2.5
    /// contract tests deterministic (Codex M3 fix, 2026-05-22).
    blocked: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(feature = "test-fixtures")]
impl BlockingTransport {
    /// Construct a new `BlockingTransport` with the given upper-
    /// bound block duration. Caller-supplied `release` + `blocked`
    /// Arcs are shared with the binding-side fixture controller.
    ///
    /// `block_ms = 0` means "block indefinitely until released"
    /// (the upper bound is bypassed). Callers should always pass
    /// a defensive non-zero value for hang-protected tests.
    pub fn new(
        block_ms: u64,
        release: Arc<(Mutex<bool>, Condvar)>,
        blocked: Arc<(Mutex<bool>, Condvar)>,
    ) -> Self {
        Self {
            block_ms,
            release,
            blocked,
        }
    }

    /// Internal wait routine shared by `flush_pending` and
    /// `BlockingAckHandle::wait_for_drain`. Signals the `blocked`
    /// flag + notifies, then enters the wait loop on `release`.
    fn wait_blocked(
        block_ms: u64,
        release: &Arc<(Mutex<bool>, Condvar)>,
        blocked: &Arc<(Mutex<bool>, Condvar)>,
    ) -> Result<(), TransportError> {
        // Step 1: signal "wait entered" so external observers
        // (waitUntilBlocked from JS) can proceed.
        //
        // Use poisoned-mutex recovery via `PoisonError::into_inner`:
        // if a prior wait panicked, the blocked-flag mutex may be
        // poisoned. Recovering is safe because the flag is a
        // monotonic latch (once true, stays true; resetting on the
        // BlockingTransport's next attach is not supported in V2.6
        // — fixtures are single-use, mirroring LoopbackPair).
        {
            let mut flag = blocked.0.lock().map_err(|e| {
                TransportError::Io(format!("BlockingTransport blocked lock poisoned: {e}"))
            })?;
            *flag = true;
            blocked.1.notify_all();
        }

        // Step 2: wait until release flag flips OR block_ms elapses.
        let (lock, cv) = &**release;
        let mut released = lock.lock().map_err(|e| {
            TransportError::Io(format!("BlockingTransport release lock poisoned: {e}"))
        })?;
        // If block_ms == 0, treat as "wait indefinitely" (no
        // timeout). This is for tests that explicitly want to
        // verify the wait behavior; production usage of this
        // fixture would set a defensive non-zero upper bound.
        if block_ms == 0 {
            while !*released {
                released = cv.wait(released).map_err(|e| {
                    TransportError::Io(format!("BlockingTransport release wait poisoned: {e}"))
                })?;
            }
        } else {
            let deadline = Duration::from_millis(block_ms);
            // Single bounded wait; if not released by deadline we
            // exit normally (defensive timeout — Ok, not Err).
            // V2.5 audit closure (Opus LOW-4, 2026-05-22): the
            // `_timeout` binding documents the "we don't care if it
            // timed out vs released" semantic adequately; the prior
            // `let _ = *released;` vestigial read was cruft. The
            // `released` guard naturally drops at the closing brace
            // of this else block, releasing the mutex.
            let (_released, _timeout) = cv
                .wait_timeout_while(released, deadline, |r| !*r)
                .map_err(|e| {
                    TransportError::Io(format!("BlockingTransport release wait poisoned: {e}"))
                })?;
            // `_released` is bound explicitly (not `_`) so clippy
            // doesn't fire `let_underscore_lock` — the guard lives
            // for the rest of this scope and drops naturally.
        }

        Ok(())
    }
}

#[cfg(feature = "test-fixtures")]
impl Transport for BlockingTransport {
    fn send(&mut self, _bytes: &[u8]) -> Result<(), TransportError> {
        // No-op: fixture isolates flush_pending behavior.
        Ok(())
    }

    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        Ok(None)
    }

    fn flush_pending(&mut self) -> Result<(), TransportError> {
        Self::wait_blocked(self.block_ms, &self.release, &self.blocked)
    }

    fn ack_handle(&self) -> Option<Box<dyn FlushAck + Send>> {
        // Codex M1 contract: the ack handle captures all relevant
        // state at THIS call. For BlockingTransport, the "drain
        // target" is conceptual — the handle simply waits on the
        // shared release Condvar, same as flush_pending. Caller's
        // expectation: the wait completes when release() is called
        // OR block_ms elapses, regardless of when the wait actually
        // starts.
        Some(Box::new(BlockingAckHandle {
            block_ms: self.block_ms,
            release: Arc::clone(&self.release),
            blocked: Arc::clone(&self.blocked),
        }))
    }
}

/// **Phase 5.7 V2.6 (2026-05-22) — test fixture's ack handle.**
///
/// Detached drain-wait handle for [`BlockingTransport`]. Mirrors
/// `BlockingTransport::flush_pending` semantics on cloned `Arc`s.
/// Constructed by `BlockingTransport::ack_handle()`.
#[cfg(feature = "test-fixtures")]
pub struct BlockingAckHandle {
    block_ms: u64,
    release: Arc<(Mutex<bool>, Condvar)>,
    blocked: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(feature = "test-fixtures")]
impl FlushAck for BlockingAckHandle {
    fn wait_for_drain(&self) -> Result<(), TransportError> {
        BlockingTransport::wait_blocked(self.block_ms, &self.release, &self.blocked)
    }
}

// Rule 4 (audit-discipline): pin Send + Sync for both fixture
// types. The handle is moved once into spawn_blocking (never
// shared after the move), so `Send` is the load-bearing bound.
// **V2.5 audit closure (Opus MEDIUM-1, 2026-05-22)**: per-field
// walk shows both `BlockingTransport` and `BlockingAckHandle` are
// `Send + Sync` (all fields are `Arc<...>` or `u64`, all Sync).
// Pin both via positive assert per the V2 V4 V1 step 3 precedent
// for `WebSocketTransport`. Closes the false `!Sync` claim in the
// `FlushAck` trait docstring at the same time.
#[cfg(feature = "test-fixtures")]
const _ASSERT_BLOCKING_TRANSPORT_SEND_SYNC: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<BlockingTransport>();
    assert_send_sync::<BlockingAckHandle>();
};

#[cfg(test)]
mod tests {
    use super::{LoopbackTransport, NoopTransport, Transport, TransportError};

    #[test]
    fn noop_send_records_bytes() {
        let mut t = NoopTransport::new();
        t.send(b"hello").unwrap();
        t.send(b"world").unwrap();
        assert_eq!(t.sent, vec![b"hello".to_vec(), b"world".to_vec()]);
    }

    #[test]
    fn noop_try_recv_returns_none_when_open() {
        let mut t = NoopTransport::new();
        assert!(matches!(t.try_recv(), Ok(None)));
    }

    #[test]
    fn noop_send_after_close_errors() {
        let mut t = NoopTransport::new();
        t.send(b"first").unwrap();
        t.close();
        assert!(matches!(t.send(b"second"), Err(TransportError::Closed)));
        // The first send still recorded.
        assert_eq!(t.sent, vec![b"first".to_vec()]);
    }

    #[test]
    fn noop_try_recv_after_close_errors() {
        let mut t = NoopTransport::new();
        t.close();
        assert!(matches!(t.try_recv(), Err(TransportError::Closed)));
    }

    // -- LoopbackTransport tests (Phase 5.5 V1) --

    #[test]
    fn loopback_pair_a_to_b_round_trip() {
        let (mut a, mut b) = LoopbackTransport::pair();
        a.send(b"hello").unwrap();
        assert_eq!(b.try_recv().unwrap(), Some(b"hello".to_vec()));
        assert_eq!(b.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_pair_b_to_a_round_trip() {
        let (mut a, mut b) = LoopbackTransport::pair();
        b.send(b"world").unwrap();
        assert_eq!(a.try_recv().unwrap(), Some(b"world".to_vec()));
        assert_eq!(a.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_pair_bidirectional() {
        let (mut a, mut b) = LoopbackTransport::pair();
        a.send(b"a1").unwrap();
        b.send(b"b1").unwrap();
        a.send(b"a2").unwrap();

        assert_eq!(b.try_recv().unwrap(), Some(b"a1".to_vec()));
        assert_eq!(a.try_recv().unwrap(), Some(b"b1".to_vec()));
        assert_eq!(b.try_recv().unwrap(), Some(b"a2".to_vec()));
        assert_eq!(a.try_recv().unwrap(), None);
        assert_eq!(b.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_pair_fifo_order_preserved() {
        let (mut a, mut b) = LoopbackTransport::pair();
        for i in 0..10u8 {
            a.send(&[i]).unwrap();
        }
        for i in 0..10u8 {
            assert_eq!(b.try_recv().unwrap(), Some(vec![i]), "FIFO order must hold");
        }
    }

    #[test]
    fn loopback_pending_recv_reports_inbox_size() {
        let (mut a, b) = LoopbackTransport::pair();
        assert_eq!(b.pending_recv(), 0);
        a.send(b"x").unwrap();
        a.send(b"y").unwrap();
        assert_eq!(b.pending_recv(), 2);
        assert_eq!(a.pending_recv(), 0, "a's inbox unaffected by a.send");
    }

    #[test]
    fn loopback_close_one_side_does_not_affect_peer() {
        let (mut a, mut b) = LoopbackTransport::pair();
        a.close();
        assert!(a.is_closed());
        assert!(!b.is_closed(), "close is per-endpoint");
        // B can still send. Bytes land in A's inbox; A is closed so
        // any subsequent A.try_recv first drains them, then returns
        // Closed (Codex+Opus 5.5 V1 audit closure — drain-before-close
        // matches the Transport trait contract at transport.rs:71-74).
        b.send(b"orphan").unwrap();
        // A's send is blocked immediately.
        assert!(matches!(a.send(b"x"), Err(TransportError::Closed)));
        // A's try_recv drains the queued byte first (contract: only
        // return Closed when closed AND drained).
        assert_eq!(a.try_recv().unwrap(), Some(b"orphan".to_vec()));
        // Now empty + closed → Closed.
        assert!(matches!(a.try_recv(), Err(TransportError::Closed)));
        // B's recv still works (B's inbox is independent).
        assert_eq!(b.try_recv().unwrap(), None);
    }

    #[test]
    fn loopback_close_blocks_send_but_drains_recv() {
        // Renamed from loopback_close_blocks_own_send_and_recv — the
        // prior version asserted try_recv returned Closed immediately
        // on close, violating the trait contract that promises queue
        // drains before Closed.
        let (mut a, mut b) = LoopbackTransport::pair();
        b.send(b"first").unwrap();
        b.send(b"second").unwrap();
        a.close();
        // A drains both queued bytes first (contract: drain before Closed).
        assert_eq!(a.try_recv().unwrap(), Some(b"first".to_vec()));
        assert_eq!(a.try_recv().unwrap(), Some(b"second".to_vec()));
        // Now empty + closed → Closed.
        assert!(matches!(a.try_recv(), Err(TransportError::Closed)));
        // Send is blocked regardless of queue state.
        assert!(matches!(a.send(b"nope"), Err(TransportError::Closed)));
    }

    #[test]
    fn loopback_debug_includes_queue_sizes_and_close_state() {
        let (mut a, _b) = LoopbackTransport::pair();
        a.send(b"x").unwrap();
        a.close();
        let d = format!("{a:?}");
        assert!(d.contains("inbox_len"), "Debug must include inbox_len: {d}");
        assert!(
            d.contains("outbox_len"),
            "Debug must include outbox_len: {d}"
        );
        assert!(
            d.contains("closed: true"),
            "Debug must include closed state: {d}"
        );
    }

    // ============================================================
    // Phase 5.7 V2.6 (2026-05-22) — BlockingTransport tests
    // ============================================================
    //
    // Gated to the `test-fixtures` feature. `cargo test -p ql-collab`
    // alone runs without the feature; these tests skip. The CI gate
    // runs with `--all-features` per the V2.5+V2.6 acceptance
    // criteria so they execute there.

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn blocking_transport_send_and_recv_are_noops() {
        use super::BlockingTransport;
        use std::sync::Condvar;
        let release = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let blocked = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let mut t = BlockingTransport::new(0, release, blocked);
        // send returns Ok, doesn't queue anything observable.
        t.send(b"ignored").unwrap();
        // try_recv returns None forever.
        assert!(t.try_recv().unwrap().is_none());
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn blocking_transport_flush_pending_blocks_then_release_unblocks() {
        use super::BlockingTransport;
        use std::sync::Condvar;
        use std::time::Instant;
        let release = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let blocked = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let mut t = BlockingTransport::new(
            5000,
            std::sync::Arc::clone(&release),
            std::sync::Arc::clone(&blocked),
        );

        // Spawn a thread that releases after 50ms. The wait should
        // complete well before the 5000ms upper bound.
        let release_clone = std::sync::Arc::clone(&release);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            *release_clone.0.lock().unwrap() = true;
            release_clone.1.notify_all();
        });

        let start = Instant::now();
        t.flush_pending().expect("flush_pending unblocked");
        let elapsed = start.elapsed();
        // Should complete within ~250ms (50ms target + scheduler
        // jitter). Way below the 5000ms upper bound.
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "flush_pending should unblock promptly after release; took {elapsed:?}"
        );
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn blocking_transport_flush_pending_signals_blocked_flag() {
        // Pins the V2.6 deterministic-signal contract: the
        // `blocked` Condvar fires BEFORE the wait on `release`
        // starts. JS `waitUntilBlocked()` relies on this.
        use super::BlockingTransport;
        use std::sync::Condvar;
        let release = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let blocked = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let mut t = BlockingTransport::new(
            1000,
            std::sync::Arc::clone(&release),
            std::sync::Arc::clone(&blocked),
        );

        // Spawn the flush in a thread.
        let handle = std::thread::spawn(move || t.flush_pending());

        // Wait for `blocked` flag.
        {
            let (lock, cv) = &*blocked;
            let mut flag = lock.lock().unwrap();
            while !*flag {
                let (new_flag, timeout) = cv
                    .wait_timeout(flag, std::time::Duration::from_secs(2))
                    .unwrap();
                flag = new_flag;
                if timeout.timed_out() {
                    panic!("blocked flag never set within 2s");
                }
            }
        }

        // Release the flush.
        *release.0.lock().unwrap() = true;
        release.1.notify_all();

        // Flush thread completes.
        handle.join().unwrap().expect("flush_pending ok");
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn blocking_transport_block_ms_upper_bound_prevents_hang() {
        // Block with 100ms upper bound; never release. Wait should
        // still exit (defensive timeout).
        use super::BlockingTransport;
        use std::sync::Condvar;
        use std::time::Instant;
        let release = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let blocked = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let mut t = BlockingTransport::new(100, release, blocked);
        let start = Instant::now();
        t.flush_pending()
            .expect("flush_pending exits on upper bound");
        let elapsed = start.elapsed();
        assert!(
            elapsed >= std::time::Duration::from_millis(80)
                && elapsed < std::time::Duration::from_millis(500),
            "upper-bound exit should land near 100ms; took {elapsed:?}"
        );
    }

    #[cfg(feature = "test-fixtures")]
    #[test]
    fn blocking_ack_handle_wait_for_drain_matches_flush_pending() {
        // The detached `BlockingAckHandle` (from ack_handle()) must
        // unblock on the SAME release signal as the transport's
        // flush_pending. This is the V2.5 contract (handle works
        // without holding the transport).
        use super::{BlockingTransport, Transport};
        use std::sync::Condvar;
        use std::time::Instant;
        let release = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let blocked = std::sync::Arc::new((std::sync::Mutex::new(false), Condvar::new()));
        let t = BlockingTransport::new(
            5000,
            std::sync::Arc::clone(&release),
            std::sync::Arc::clone(&blocked),
        );

        // Take the handle (Codex M1 snapshot semantic — captured here).
        let handle = t
            .ack_handle()
            .expect("BlockingTransport returns an ack handle");
        // Drop the transport so the handle is genuinely detached.
        drop(t);

        let release_clone = std::sync::Arc::clone(&release);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            *release_clone.0.lock().unwrap() = true;
            release_clone.1.notify_all();
        });

        let start = Instant::now();
        handle.wait_for_drain().expect("wait_for_drain ok");
        assert!(
            start.elapsed() < std::time::Duration::from_millis(500),
            "handle wait should unblock independently of transport"
        );
    }

    // ============================================================
    // Phase 5.7 V2.7 (2026-05-22) — error-code discrimination
    // ============================================================

    #[test]
    fn transport_error_kind_io() {
        let e = super::TransportError::Io("socket dead".into());
        assert_eq!(e.kind(), "transport_io");
    }

    #[test]
    fn transport_error_kind_closed() {
        let e = super::TransportError::Closed;
        assert_eq!(e.kind(), "transport_closed");
    }

    // ============================================================
    // NF-01 — pending_recv panics on poison (no-fallback fix)
    // ============================================================

    /// Verify that `pending_recv` returns the correct count when the
    /// mutex is healthy. This locks in the post-NF-01 behavior:
    /// the `.expect()` does not trigger on a non-poisoned mutex.
    #[test]
    fn nf01_pending_recv_returns_correct_count_on_healthy_mutex() {
        let (mut a, b) = LoopbackTransport::pair();
        assert_eq!(b.pending_recv(), 0, "inbox empty before any send");
        a.send(b"msg1").unwrap();
        a.send(b"msg2").unwrap();
        a.send(b"msg3").unwrap();
        assert_eq!(b.pending_recv(), 3, "three blobs sent by a, visible in b's inbox");
        // After consuming one blob, count decreases.
        let mut b_mut = b;
        b_mut.try_recv().unwrap();
        assert_eq!(b_mut.pending_recv(), 2, "one blob consumed; two remain");
    }
}
