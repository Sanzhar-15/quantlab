---
title: Phase 5.7 V2.8 megaudit — Opus-B / Forward-looking + adversarial per-field walk (V3 entry-readiness)
date: 2026-05-22
audit_target_engine: 4ea690ce246
audit_target_ide: f9f98194958
lane: opus-b / adversarial-walk + V3-entry-delta (Lane C of the V2.8 megaudit)
verdict: PASS-WITH-FINDINGS (1 HIGH, 4 MEDIUM, 4 LOW)
---

# Phase 5.7 V2.8 megaudit — Opus-B (Lane C)

## Mandate

Two-part:

1. **Per-field adversarial walks** on every V2-touched trait / struct,
   looking for Rule 4 violations or silent traps that survived the
   per-step audits (V2.1 → V2.7).
2. **V3 entry-plan delta** — which V2 backlog items MUST close before
   V3 starts, what V2-side gaps the multi-window IDE demo exposes,
   what V3-specific risks loom.

Targets (A–F) per the V2.8 megaudit brief. The walks are explicit;
verdicts are recorded against the SHIPPED code at engine HEAD
`4ea690ce246` and IDE HEAD `f9f98194958`, not against prior audit
transcripts.

## Headline

**One HIGH.** The `BlockingTransportFixture` napi class in
`crates/ql-bindings-node/src/lib.rs:1211-1356` is NOT cfg-gated on
the binding side, and `ql-bindings-node/Cargo.toml:51` enables
`ql-collab/test-fixtures` UNCONDITIONALLY. The fixture's JS surface
is therefore present in every release cdylib. Combined with the
fixture being declared "Not for production use" in its own
docstring, this is the V2 backlog "production-cdylib hardening of
BlockingTransportFixture" item, currently OPEN. I escalate it from
LOW-2 (where Opus V2.5 left it) to HIGH for V3 because the
multi-window IDE demo and onward shipping will load the same
cdylib that test-fixture controllers are exposed from — any
malicious or compromised JS in the IDE process can construct a
`BlockingTransportFixture`, attach a `BlockingTransport`, and park
a session's `flushPendingToTransport` task for up to `u32::MAX`
milliseconds (~49 days) per call.

Other findings are smaller: 3 MEDIUMs around the LoopbackPair /
Transport napi wrappers' missing-Sync silence under Rule 4 (no
negative claim — Rule 4 silence, NOT a Rule 4 violation, but
documenting the SemVer floor explicitly is warranted before V3),
the `auto_flush_policy_to_string` engine-drift surface, and a
subtle blocked-flag latch hazard. 1 MEDIUM on the IDE consumer
pattern (parseQuantbookError ignores non-Error throwables AND
loses bracket prefixes from String-Error wrappers built by older
Node versions).

Rule 4 arc count: 0 new triggers in this lane. Arc remains at 6.
All shipped negative trait claims (`CoreCollabSession: Send +
!Sync` in `ql-collab/src/session.rs:92-105` via probe-then-
commented-out pattern) have either compile-asserted positive
proof or a documented per-field walk. The `CollabSession`
docstring at `ql-bindings-node/src/lib.rs:1428-1443` correctly
notes V2.4's `Send + Sync` is a STRICT IMPROVEMENT over V1's
`Send + !Sync` (no inversion bug).

# Section 1 — Per-target walk log

## A. `Transport` trait + impls

### A.0 Locations

- Trait + LoopbackTransport + NoopTransport + BlockingTransport
  + FlushAck trait + BlockingAckHandle: `crates/ql-collab/src/transport.rs`.
- WebSocketTransport + WebSocketProgressAckHandle:
  `crates/ql-collab-ws/src/lib.rs`.
- napi `Transport` wrapper + `LoopbackPair` + `BlockingTransportFixture`:
  `crates/ql-bindings-node/src/lib.rs`.

Search confirmed no other Transport impls live in the workspace:

```sh
$ rg "impl Transport for" crates/
crates/ql-collab/src/transport.rs:405:impl Transport for NoopTransport {
crates/ql-collab/src/transport.rs:547:impl Transport for LoopbackTransport {
crates/ql-collab/src/transport.rs:730:impl Transport for BlockingTransport {
crates/ql-collab-ws/src/lib.rs:661:impl Transport for WebSocketTransport {
```

Four impls. All examined.

### A.1 Trait shape — Send + Sync bounds on each method

```rust
pub trait Transport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
    fn last_error(&self) -> Option<String> { None }
    fn flush_pending(&mut self) -> Result<(), TransportError> { Ok(()) }
    fn ack_handle(&self) -> Option<Box<dyn FlushAck + Send>> { None }
}
```

- Trait itself has NO supertrait bound (not `Transport: Send`).
  This is intentional — the engine boxes as
  `Box<dyn Transport + Send>` at the call site, so the Send bound
  is applied where it matters (the `CollabSession::transport`
  field declaration at `ql-collab/src/session.rs:364`).
- `ack_handle()` returns `Box<dyn FlushAck + Send>` — Send required
  so the binding can move the handle into `spawn_blocking`. NOT
  `+ Sync` — handle is single-use after extraction. Walk:
  - `WebSocketProgressAckHandle` (3 fields, all Send+Sync — see A.3
    below) — composite IS Send+Sync, but trait only requires Send.
    SAFE.
  - `BlockingAckHandle` (3 fields, all Send+Sync — see C.3 below)
    — composite IS Send+Sync, trait only requires Send. SAFE.

### A.2 LoopbackTransport per-field walk

```rust
pub struct LoopbackTransport {
    inbox: Arc<Mutex<VecDeque<Vec<u8>>>>,
    outbox: Arc<Mutex<VecDeque<Vec<u8>>>>,
    closed: AtomicBool,
}
```

| Field | Type | Send? | Sync? | Notes |
|---|---|---|---|---|
| inbox | `Arc<Mutex<VecDeque<Vec<u8>>>>` | yes | yes | `Arc<T: Send+Sync>: Send+Sync`; `Mutex<T: Send>: Send+Sync`; `VecDeque<Vec<u8>>` is `Send+Sync` |
| outbox | (same) | yes | yes | same |
| closed | `AtomicBool` | yes | yes | std::sync::atomic::AtomicBool is Send + Sync |

Composite: `Send + Sync`. Compile-asserted at line 586-589 by
`_ASSERT_LOOPBACK_TRANSPORT_SEND_SYNC`. CORRECT.

### A.3 WebSocketTransport per-field walk

```rust
pub struct WebSocketTransport {
    outbound_tx: mpsc::UnboundedSender<Vec<u8>>,
    inbound_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    closed: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<WebSocketError>>>,
    queued_count: Arc<AtomicU64>,
    progress: Arc<(Mutex<u64>, Condvar)>,
    writer_task: JoinHandle<()>,
    reader_task: JoinHandle<()>,
}
```

| Field | Type | Send? | Sync? | Source |
|---|---|---|---|---|
| outbound_tx | `mpsc::UnboundedSender<Vec<u8>>` | yes | yes | tokio docs: UnboundedSender is Send+Sync |
| inbound_rx | `mpsc::UnboundedReceiver<Vec<u8>>` | yes | yes | tokio docs: UnboundedReceiver is Send+Sync (NOT Clone) |
| closed | `Arc<AtomicBool>` | yes | yes | trivial |
| last_error | `Arc<Mutex<Option<WebSocketError>>>` | yes | yes | WebSocketError is Send+Sync per static_assertion at line 898 |
| queued_count | `Arc<AtomicU64>` | yes | yes | trivial |
| progress | `Arc<(Mutex<u64>, Condvar)>` | yes | yes | tuple of Send+Sync is Send+Sync |
| writer_task | `JoinHandle<()>` | yes | yes | tokio JoinHandle is Send+Sync when output is Send |
| reader_task | (same) | yes | yes | same |

Composite: `Send + Sync`. Pinned at line 859-862 (`Send`) +
line 889 (`Sync` via static_assertion!). CORRECT and aligned with
the V2 V3 step 4 + V2 V4 V1 step 3 Rule 4 closures. Rule 4 #5
remedy is robust here.

### A.4 NoopTransport per-field walk

```rust
pub struct NoopTransport {
    pub sent: Vec<Vec<u8>>,
    closed: bool,
}
```

Both fields are trivially Send+Sync. Default derives Debug. No
Drop. SAFE.

### A.5 V2.5 `ack_handle` addition — handle Send+'static contract

`Transport::ack_handle() -> Option<Box<dyn FlushAck + Send>>` (line
325-327). The `+ Send` bound on the returned trait object is the
load-bearing contract for napi-rs's `tokio::task::spawn_blocking`
move pattern.

Note: the trait object is `Box<dyn FlushAck + Send>`, NOT
`Box<dyn FlushAck + Send + 'static>`. Implicit lifetime is
`'static` because trait objects default to `'static` unless
specified otherwise — confirmed by Rust reference. SAFE.

Note (Codex M1 contract): the docstring (line 279-298) emphasises
the target-snapshot at call time. Walk:
- `WebSocketTransport::ack_handle` captures
  `self.queued_count.load(Ordering::SeqCst)` BEFORE constructing
  the handle (line 800-802). CORRECT.
- `BlockingTransport::ack_handle` doesn't capture a target — the
  handle's wait is on the shared `release` Condvar, which fires
  globally. The handle's `block_ms` upper-bound was captured at
  fixture construction time (line 753 stores `self.block_ms`).
  Semantically the handle DOES capture state (the bound) at
  ack_handle time, but the "drain target" concept doesn't map
  here — block-state IS the target. The docstring at
  `transport.rs:744-757` is honest about this. SAFE.

### A.6 Trait dispatch through Box

Storage at `CollabSession::transport: Option<Box<dyn Transport + Send>>`.
Dispatch via `self.transport.as_ref().and_then(|t| t.ack_handle())`
(session.rs:907). Trait method `ack_handle(&self)` — shared
reference, no aliasing concerns. SAFE.

### A.7 Verdict for target A

PASS. All four impls have positive Send+Sync (or Send-only)
proofs at the trait dispatch boundary. No Rule 4 violations.
Compile-asserts are robust.

## B. `FlushAck` struct (V2.5)

### B.0 Declaration

```rust
pub trait FlushAck: Send {
    fn wait_for_drain(&self) -> Result<(), TransportError>;
}
```

Trait, NOT a struct (audit brief said "struct" — actually a
trait; per-field walk applies to the two impls).

### B.1 FlushAck trait shape

`FlushAck: Send` supertrait. `wait_for_drain(&self)` — shared
receiver. The trait docstring (transport.rs:330-360) is detailed
on the V2.5 audit closure of the prior false `!Sync` claim. The
current text correctly says:

> Send is required; Sync is not. The trait requires only Send so
> a future implementor wrapping a !Sync field (e.g., Cell for an
> internal cache) remains a valid FlushAck.

This is a positive bound statement. No Rule 4 violation. The
shipped impls (`WebSocketProgressAckHandle` + `BlockingAckHandle`)
both compile-assert Send + Sync (line 874-877 + 789-793). CORRECT.

### B.2 WebSocketProgressAckHandle per-field walk

```rust
pub struct WebSocketProgressAckHandle {
    target: u64,
    progress: Arc<(Mutex<u64>, Condvar)>,
    closed: Arc<AtomicBool>,
}
```

| Field | Send? | Sync? |
|---|---|---|
| target: u64 | yes | yes |
| progress: Arc<(Mutex<u64>, Condvar)> | yes | yes |
| closed: Arc<AtomicBool> | yes | yes |

Composite: Send + Sync. Pinned line 874-877. CORRECT.

### B.3 BlockingAckHandle per-field walk

```rust
pub struct BlockingAckHandle {
    block_ms: u64,
    release: Arc<(Mutex<bool>, Condvar)>,
    blocked: Arc<(Mutex<bool>, Condvar)>,
}
```

Same shape; all 3 fields Send + Sync. Composite Send + Sync.
Pinned line 789-793. CORRECT.

### B.4 Docstring claim consistency check (Rule 4 audit point)

Reading transport.rs:344-360:

> The shipped implementors ([WebSocketProgressAckHandle] +
> [BlockingAckHandle] when the test-fixtures feature is enabled)
> happen to be Send + Sync because every field is Sync — pinned
> by positive compile-asserts at each impl site per Rule 4.
> V2.5 audit closure (Opus MEDIUM-1, 2026-05-22): rewrote the
> prior `Send + !Sync` claim.

Consistent with the actual auto-impls. The "happen to be" wording
is appropriately defensive — the docstring doesn't claim the
trait REQUIRES Sync, only notes that today's impls are. CORRECT.
Rule 4 #6 remedy is robust.

### B.5 Verdict for target B

PASS. The V2.5 docstring correctly distinguishes trait
contract (Send only) from concrete-impl reality (Send + Sync).
Positive compile-asserts on both impls. No Rule 4 violations
introduced.

## C. `BlockingTransport` + `BlockingTransportFixture` (V2.6)

### C.0 BlockingTransport per-field walk (engine-side, gated on test-fixtures)

```rust
#[cfg(feature = "test-fixtures")]
pub struct BlockingTransport {
    block_ms: u64,
    release: Arc<(Mutex<bool>, Condvar)>,
    blocked: Arc<(Mutex<bool>, Condvar)>,
}
```

| Field | Send? | Sync? |
|---|---|---|
| block_ms: u64 | yes | yes |
| release | yes | yes |
| blocked | yes | yes |

Composite: Send + Sync. Pinned at line 789-793 via
`_ASSERT_BLOCKING_TRANSPORT_SEND_SYNC`. CORRECT.

### C.1 Drop semantics under panic

No custom Drop. Field-decl drop order:
1. `block_ms` (trivial Drop)
2. `release` (Arc Drop: decrements ref count; the Mutex+Condvar
   live on while the binding-side `BlockingTransportFixture`
   still holds its clone)
3. `blocked` (same)

If `flush_pending` panics mid-wait, the `wait_blocked`
poisoned-mutex recovery path (transport.rs:683-687, 692-694)
uses `PoisonError::into_inner` so a panicked prior caller doesn't
permanently brick the fixture's mutex. POISON RECOVERY IS
SAFE (poisoned mutexes are still valid memory; recover-and-
continue is the documented std::sync semantic).

**Subtle hazard observed**: the `blocked` flag at line 685 is a
monotonic latch — once `true`, stays `true`. Single-use fixture
mirrors `LoopbackPair`. The docstring at line 678-682 says so.
Verdict: if the fixture were re-used (caller takes a second
transport instance from `take_transport()` after a release), the
second wait would see `blocked == true` from a prior call and
signal `notify_all` immediately — but `take_transport` is
explicitly single-use (line 1294-1303 returns Err on second
call). So the latch hazard is unreachable from JS. SAFE.

### C.2 BlockingTransportFixture (napi side) per-field walk

```rust
#[napi]
pub struct BlockingTransportFixture {
    inner: Option<ql_collab::BlockingTransport>,
    release: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    blocked: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}
```

| Field | Send? | Sync? |
|---|---|---|
| inner: Option<BlockingTransport> | yes | yes (BlockingTransport is Send+Sync from C.0) |
| release | yes | yes |
| blocked | yes | yes |

Composite Send + Sync. Pinned line 1422-1425 via `_ASSERT_BINDING_BLOCKING_TRANSPORT_FIXTURE_SEND`. Sync is NOT
pinned positively on the napi side — but napi-rs holds class
instances per-Worker, so Sync isn't strictly required. Rule 4
silence (no negative claim) — SAFE but see MEDIUM-2 below.

### C.3 Production-cdylib leak surface — feature-graph audit

```
[ql-bindings-node/Cargo.toml:51]
ql-collab = { path = "../ql-collab", features = ["test-fixtures"] }
```

This enables `ql-collab/test-fixtures` UNCONDITIONALLY. The engine
`BlockingTransport` + `BlockingAckHandle` types are compiled in.

```
[ql-bindings-node/src/lib.rs:1211-1356]
#[napi]
pub struct BlockingTransportFixture { ... }   // NO cfg attribute
```

The napi class wrapper is NOT gated by any cfg. `cargo build -p
ql-bindings-node --release` produces a cdylib with the
`BlockingTransportFixture` JS class symbol fully exported. The
binding crate's IDE-facing `extensions/quantlab/src/quantbook/types.ts`
declares `BlockingTransportFixtureInstance` /
`BlockingTransportFixtureConstructor` at line 290 / 323, with the
shape exposed on the `QuantbookEngineModule` index at line 477.

**This is a HIGH for V3 entry.** See HIGH-1 below.

### C.4 Verdict for target C

PASS-WITH-FINDINGS — see HIGH-1 in Section 2.

## D. `LoopbackPair` (V2.1)

### D.0 Per-field walk

```rust
#[napi]
pub struct LoopbackPair {
    a: Option<LoopbackTransport>,
    b: Option<LoopbackTransport>,
}
```

Each end: `LoopbackTransport` (Send+Sync per A.2). Composite:
Send + Sync. Pinned at line 1410-1413 (Send only — Sync is
silent). Same Rule 4 silence as the `Transport` napi class. SAFE.

### D.1 takeA / takeB single-use semantics under V2.4's Arc<Mutex<CollabSession>>

```rust
pub fn take_a(&mut self) -> Result<Transport> {
    let end = self.a.take().ok_or_else(|| {
        bad_argument_error("LoopbackPair.takeA already called on this pair".to_string())
    })?;
    Ok(Transport { inner: Some(Box::new(end)) })
}
```

`&mut self` on the napi class. napi-rs enforces this through
`napi::bindgen_prelude::ClassInstance<T>` which uses `&mut self`
ref tracking — when a JS instance is in a method call, the
instance is borrowed mutably; concurrent JS calls on the SAME
instance from the same Worker are sequentialized by V8's single-
threaded execution model.

The V2.4 audit found that V2.3's `&mut self` on `CollabSession`
methods produced UB under napi-rs async re-entry. The fix was to
wrap `CollabSession`'s inner in `Arc<Mutex<...>>` so methods
could take `&self`. **The same V2.3-style UB hazard does NOT
recur for `LoopbackPair::takeA`/`takeB` because these methods
are SYNC** — napi-rs generates a stack-allocated `&mut Self`
ref for the call duration, and there's no `.await` point where
the runtime might re-enter the same JS instance. The single
JS Worker's event loop runs `takeA()` to completion before the
next JS call lands.

Across Workers: napi-rs class instances are per-Worker — a
LoopbackPair instance created in Worker A is not accessible
from Worker B (the V8 isolate boundary blocks it). So
cross-Worker `&mut self` aliasing is also impossible.

Note: the V2.3 UB hazard was specific to ASYNC methods
(`#[napi] pub async fn`) on `CollabSession`. `takeA`/`takeB`
are sync. SAFE.

### D.2 bad_argument code emission for double-take (V2.7 closure)

Confirmed at line 1152 and 1163: both `take_a` and `take_b` use
`bad_argument_error("...")` to produce a JS Error with the
`[bad_argument] LoopbackPair.takeA already called on this pair`
prefix. The IDE-side `parseQuantbookError` will produce
`{code: 'bad_argument', message: 'LoopbackPair.takeA already
called on this pair'}`.

**Test verification**: IDE mocha at line ~ 200 of
`extensions/quantlab/test/quantbook-roundtrip.test.ts` has
`"V2.7 closure: napi argument validation surfaces bad_argument
code"` per current_work.md §6. Per current_work.md §0 the IDE
quantbook mocha is 91/91, so the test passes. CONFIRMED ARMED.

### D.3 Default impl

```rust
impl Default for LoopbackPair {
    fn default() -> Self { Self::new() }
}
```

`#[napi(constructor)]` requires Default for napi class
constructors that take no args. SAFE.

### D.4 Verdict for target D

PASS. Single-use semantics intact under V2.4. bad_argument
emission correct. No Rule 4 violations.

## E. Error enums (TransportError, WebSocketError, CollabSessionError)

### E.0 TransportError

```rust
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum TransportError {
    #[error("transport I/O error: {0}")]
    Io(String),
    #[error("transport closed")]
    Closed,
}
```

`kind()` (line 138-143):
- `Io(_) => "transport_io"`
- `Closed => "transport_closed"`

Match is exhaustive WITHOUT a `_` catch-all. Adding a new variant
will fail to compile (non-exhaustive on the type, but exhaustive
in the match — Rust enforces this). CORRECT.

Display strings: "transport I/O error: {0}" + "transport closed".
The String payload in `Io(String)` could carry impl-specific text
(e.g., a tungstenite error string with a peer's address +
port). Let me check whether that's a leak:

- `WebSocketTransport`'s writer task at ql-collab-ws/src/lib.rs:441-446
  records `e.to_string()` from `ws_sink.send(...).err()` into
  `last_error`. The TransportError emitted by `WebSocketTransport::send`
  is `TransportError::Closed` (NOT Io) — see line 678-680: any
  send failure maps to `Closed`. So `TransportError::Io` is NOT
  reachable via `WebSocketTransport::send`. It IS reachable via
  `flush_pending` poisoned-mutex (line 765-770).
- `LoopbackTransport::send`'s `Io` arm (line 553-554) carries the
  string "loopback outbox lock poisoned: {e}". No peer info.
- `BlockingTransport`'s `wait_blocked` Io arm (line 683-684, 692-694)
  carries the std::sync::PoisonError display. No peer info.

**No address/path/secret leak in TransportError Display
strings**. The strings ARE descriptive (poison error contents)
but contain no peer or credential information.

### E.1 WebSocketError

```rust
#[derive(Debug, Clone, Error)]
#[non_exhaustive]
pub enum WebSocketError {
    InvalidUrl(String),
    ConnectFailed(String),
    HandshakeFailed(String),
    RuntimeError(String),
}
```

`kind()` exhaustive WITHOUT `_`. CORRECT (same SemVer compile-
time enforcement as TransportError).

Display strings: ALL FOUR carry the inner `String`. The String is
the tungstenite::Error display string from connect / handshake /
runtime task. Tungstenite errors CAN carry the peer address (for
TCP-level errors like "Connection refused (os error 61)" — peer
addr may or may not be embedded; depends on tokio + OS). For an
INVALID URL, the inner string IS the URL — potential leak of any
auth token in the URL itself.

**Mild leak surface**: `ws://user:password@host:port/path` URLs
WOULD have `user:password@host:port/path` in the InvalidUrl
display. Today the napi binding's `parseQuantbookError` returns
`{code: 'websocket_invalid_url', message: 'invalid WebSocket
URL: ws://user:password@host:port/path'}`. The IDE would log
that. **Not a HIGH because V1 doesn't support auth-embedded
URLs**; the V2 backlog TLS work would add Bearer-token auth via
headers, NOT URLs. But for V3 documentation it's worth noting:
NEVER allow URL-embedded credentials.

I file this as LOW-1 below.

### E.2 CollabSessionError

```rust
#[non_exhaustive]
pub enum CollabSessionError {
    OpLog(#[from] OpLogError),
    Presence(#[from] PresenceError),
    Undo(#[from] loro::LoroError),
    Transport(#[from] TransportError),
    Replay(#[from] ReplayError),
}
```

`kind()` (line 173-181):
- 4 variants → 4 explicit kinds
- `Transport(inner) => inner.kind()` — passthrough.

Match is exhaustive WITHOUT a `_` catch-all. CORRECT.

`Transport` passthrough: V2.7 Opus M3 (which is now in V2 backlog
per current_work.md §0) documented this as intentional. The IDE
consumer gets the same code (`transport_closed`) whether the path
was a direct Transport call or a wrapped session method. This is
the right tradeoff for reconnect logic. SAFE per V2.7 audit
closure.

### E.3 SemVer compile-time guard for kind strings

Opus V2.7 LOW-2 noted: adding a new variant tomorrow without
thinking — does `kind()` match arm catch it? Walk:

- `TransportError`: exhaustive without `_`. NEW VARIANT FAILS TO
  COMPILE. SAFE.
- `WebSocketError`: same. SAFE.
- `CollabSessionError`: same. SAFE.

The exhaustive-match without `_` PROVIDES the compile-time guard
the V2 backlog wants. The actual residual concern from V2.7 LOW-2
is whether the STRING content is stable across edits (e.g., a
typo that turns `"transport_io"` into `"trasnport_io"` would not
be caught at compile time). That requires a test, not a
compile guard. See MEDIUM-3 below.

### E.4 Verdict for target E

PASS-WITH-FINDINGS. Exhaustive matches enforce variant
addition at compile time (better than V2.7 LOW-2 suggested).
Display strings have a mild credential-leak concern for
auth-embedded URLs (LOW-1). String-content stability needs a
test that doesn't exist today (MEDIUM-3).

## F. V2.4 Arc<Mutex<CollabSessionInner>>

### F.0 Per-field walk

```rust
#[napi]
pub struct CollabSession {
    inner: Arc<Mutex<CoreCollabSession>>,
}
```

Single field. `parking_lot::Mutex<T: Send>: Send + Sync` per
`lock_api-0.4.14/src/mutex.rs:144`. `Arc<T: Send+Sync>: Send+Sync`.
`CoreCollabSession: Send` (engine pin). So composite: Send + Sync.

Pinned line 1382-1388 (`_ASSERT_BINDING_COLLAB_SESSION_SEND` asserts
both Send AND Sync). CORRECT.

### F.1 Drop order under panic

No custom Drop on the binding `CollabSession`. Field-decl order:
1. `inner: Arc<Mutex<CoreCollabSession>>` (only field) drops →
   - Arc ref count decrements; if 0, Mutex drops:
     - parking_lot Mutex Drop: releases the lock if held (it
       cannot be — Mutex is unique-owned via Arc once strong
       count is 0). Then T drops.
     - `CoreCollabSession` drops: peer_id (trivial) → log
       (Loro OpLog Drop) → undo (UndoManager Drop, no LoroDoc
       borrow per V2.5 V1 closure) → transport (Box<dyn Transport
       + Send> Drop — calls each impl's Drop; `WebSocketTransport`
       aborts both tasks at line 656-657) → auto_flush_policy
       (Copy, trivial) → last_flushed_vv (VersionVector Drop).

Order is safe. If a panic happens mid-method-call holding the
parking_lot lock, parking_lot's Mutex does NOT poison — the lock
is auto-released on unwind. SAFE.

### F.2 Re-entrant lock paths

Walk every method on the binding `CollabSession` for "calls another
method on the same session":
- `append_put_value`: acquires lock → `inner.append_op(...)`.
  Does `append_op` re-enter? Read session.rs `append_op`
  (line 493) — calls `self.maybe_auto_flush()` which calls
  `flush_delta_to_transport` on `&mut self`. Both operate on the
  same `&mut CoreCollabSession` (the Mutex guard's deref). NO
  external re-entry into another binding method. SAFE.
- `export_bytes`, `merge_bytes`, `op_count`, `pending_op_count`,
  `has_pending_flush`, `peer_id`: single-method delegations.
  SAFE.
- `attach_transport(transport: &mut Transport)`: takes a
  separate napi class ref. Does `attach_transport_boxed` re-enter
  binding code? No, it's pure engine-side. SAFE.
- `detach_transport`, `has_transport`, `flush_to_transport`,
  `flush_delta_to_transport`, `poll_remote`, `poll_remote_with_limit`,
  `transport_last_error`, `set_auto_flush_policy`,
  `auto_flush_policy`: single-method delegations. SAFE.
- `flush_pending_to_transport`: locks → extracts handle via
  `inner.flush_pending_handle()` → DROPS LOCK → `spawn_blocking`
  with the handle. Inside the spawn_blocking task, the handle's
  `wait_for_drain` does NOT re-acquire the session lock — it only
  touches its own `progress` + `closed` Arcs. NO re-entry. V8-
  block CLOSED. CORRECT.

**Hidden re-entry walk**: napi-rs's class binding may, in some
versions, call user-defined Drop / Finalize while user code holds
a reference. Today napi-rs 3.x doesn't auto-call methods on Drop.
SAFE.

### F.3 Send + Sync compile-asserted across V2.4

V2.4's claim: was `Send + !Sync` pre-V2.4, became `Send + Sync`
post-V2.4. Compile-asserted at line 1382-1388. The transition is
RULE 4 #5 remedy (V2.4 audit closure).

Verifying the transition isn't a regression for napi-rs:
- napi-rs class instances are managed by V8's GC. The Send + Sync
  bound is required by tokio's `spawn_blocking` (the captured
  closure must be `Send + 'static`) and by napi-rs's
  `#[napi] async fn` codegen (which captures `&self`).
- `&self` requires `&Self: Send` in async contexts, which
  requires `Self: Sync`. V2.4's `Arc<Mutex<...>>` provides this.
- Pre-V2.4 it was `!Sync` — but the prior code path didn't have
  the `spawn_blocking` pattern. V2.4 introduced it (closing V2.3's
  starvation HIGH) and the Sync requirement arose alongside.
  CORRECT.

### F.4 Verdict for target F

PASS. V2.4 Arc<Mutex<>> refactor is sound under per-field walk.
No re-entry, no drop-order hazard. Send+Sync compile-asserted.
Rule 4 properly applied (negative claim removed, positive claim
proved).

# Section 2 — Findings

## HIGH-1 — `BlockingTransportFixture` ships in production cdylib (Opus V2.5 LOW-2 escalated)

**Severity**: HIGH (was LOW-2 in Opus V2.5 transcript)

**Where**: `crates/ql-bindings-node/Cargo.toml:51` +
`crates/ql-bindings-node/src/lib.rs:1211-1356`.

**Why escalated**: V2.5 closed this as LOW-2 ("future production
hardening"; line 1254-1257). For V2 work that didn't ship outside
the IDE's mocha test, LOW was defensible. **For V3 entry (multi-
window IDE demo + onward shipping), HIGH is warranted** because:

1. The cdylib is loaded by the IDE extension's `loader.ts` and any
   IDE process now has `BlockingTransportFixture` reachable from
   JS — the multi-window demo will run in TWO IDE processes simul-
   taneously, doubling the attack surface.
2. The fixture's docstring explicitly says "Not for production use
   — the underlying `BlockingTransport` blocks `flush_pending`
   indefinitely until `release()` is called (or the constructor's
   `block_ms` upper bound elapses)" (line 1208-1210). Allowing JS
   in any IDE webview / extension to construct one parks tokio
   `spawn_blocking` threads for up to `u32::MAX ms` (~49.7 days)
   per call.
3. With auto-flush policy `OnAppend` enabled, a malicious /
   compromised extension can build a `BlockingTransportFixture`,
   take its `Transport`, attach to a session, fire a mutator (auto-
   flush triggers `flushPendingToTransport`-equivalent through
   `flush_delta_to_transport`), and freeze tokio blocking pool
   threads. With 512 default blocking threads, the attacker can DoS
   all flush-pending traffic across the entire IDE process.
4. The napi class is visible in the public `QuantbookEngineModule`
   interface at `extensions/quantlab/src/quantbook/types.ts:477`
   — IDE consumers can discover and instantiate it.

**Remediation (V3-required)**:

Option A (preferred): cfg-gate the napi class on a binding-side
`test-fixtures` feature.

```rust
// ql-bindings-node/Cargo.toml
[features]
default = []   # or "test-fixtures" during dev
test-fixtures = ["ql-collab/test-fixtures"]

[dependencies]
ql-collab = { path = "../ql-collab" }   # no default features

// ql-bindings-node/src/lib.rs
#[cfg(feature = "test-fixtures")]
#[napi]
pub struct BlockingTransportFixture { ... }

#[cfg(feature = "test-fixtures")]
#[napi]
impl BlockingTransportFixture { ... }
```

Then build production with `cargo build -p ql-bindings-node --release`
(no `--features test-fixtures`) and CI / mocha with
`--features test-fixtures`. Mocha tests that import the fixture
fail loudly on production cdylib (which is correct — production
builds shouldn't carry the fixture).

Option B (worse, but compatible): runtime-gate via env var.

```rust
#[napi(constructor)]
pub fn new(block_ms: f64) -> Result<Self> {
    if std::env::var("QUANTBOOK_TEST_FIXTURES_ENABLED").is_err() {
        return Err(bad_argument_error(
            "BlockingTransportFixture is not available in this build".to_string()
        ));
    }
    // ... rest
}
```

Option A is cleaner — Option B leaks a string into production
docs that hints at the fixture's existence. **I recommend
Option A.**

**Pre-V3 gating verdict**: BLOCKING. V3 cannot ship to user-
facing dogfood with the fixture exposed. See Section 3.1.

## MEDIUM-1 — `WebSocketError` InvalidUrl Display leaks URL-embedded credentials (LOW-1 from earlier in this lane, escalated)

**Severity**: MEDIUM
**Where**: `crates/ql-collab-ws/src/lib.rs:220-222`.

```rust
#[error("invalid WebSocket URL: {0}")]
InvalidUrl(String),
```

The `{0}` is the full URL. If a caller passes
`ws://user:hunter2@host:port/path` (RFC 3986 userinfo), the
InvalidUrl display contains the password. The napi binding
prepends `[websocket_invalid_url]` and Error.message becomes
`"[websocket_invalid_url] invalid WebSocket URL:
ws://user:hunter2@host:port/path"`. The IDE's `parseQuantbookError`
returns this in `info.message`. Any IDE logging path that records
the message (channel output, error reporting, telemetry) captures
the credential.

V1 of `ql-collab-ws` documents "ws://only" (line 47-49) — no auth
mention. But the engine doesn't ENFORCE that URLs lack userinfo.
A typo in IDE-side reconnect logic (`ws://...?token=hunter2`)
would similarly leak.

**Remediation**:

1. Engine: scrub the URL before storing in `InvalidUrl`:
   - Parse the URL with `url::Url` (already a transitive dep)
     - if successful, strip `set_username("")` + `set_password(None)`
       + `set_query(None)` before formatting.
     - if parse fails, the URL is INVALID — emit a fixed string
       like "invalid WebSocket URL: <parse failed; redacted>".

2. IDE: defense-in-depth — `parseQuantbookError` could redact
   common credential patterns in `info.message` before display.
   But engine-side scrubbing is the right layer.

**Severity rationale**: not HIGH because V1 doesn't have auth
flows + no IDE caller today passes userinfo-bearing URLs. But
V2/V3 will (Bearer-token auth via headers is the V2 backlog
plan, but a user might paste a URL with credentials by accident).
The leak surface widens as the binding gains adopters.

## MEDIUM-2 — Rule 4 silence (no positive Sync proof) on `Transport` napi wrapper + `LoopbackPair`

**Severity**: MEDIUM
**Where**: `crates/ql-bindings-node/src/lib.rs:1395-1413`.

```rust
const _ASSERT_BINDING_TRANSPORT_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<Transport>();
};

const _ASSERT_BINDING_LOOPBACK_PAIR_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<LoopbackPair>();
};
```

Only `Send` is positively asserted. The `Transport` wrapper holds
`Option<Box<dyn CoreTransport + Send>>` — the trait object lacks
`+ Sync`, so the wrapper is NOT Sync. Same for LoopbackPair
(holds `Option<LoopbackTransport>`, which IS Sync, so the
wrapper IS Sync — but the assert doesn't pin it).

Rule 4 doesn't strictly require positive Sync proof when no
negative `!Sync` claim exists. But:

- The `BlockingTransportFixture` assert (line 1422-1425) also pins
  Send only.
- The `CollabSession` assert (line 1382-1388) pins BOTH.

This is asymmetric. Risk: a future refactor that ADDS a `!Sync`
field to `LoopbackPair` (e.g., a Cell<>) would silently break
Sync without compile-time signal. Today the IDE doesn't share
`LoopbackPair` instances across threads (napi-rs holds them per-
Worker), but V3's multi-window demo might cross that boundary.

**Remediation**: extend the Send asserts to Send + Sync where
the type is genuinely Send + Sync. For the `Transport` wrapper
(whose trait object lacks `+ Sync`), leave at Send only AND
add a Rule-4-style docstring comment noting that the wrapper is
intentionally `!Sync` because the trait object is `+ Send` only.

```rust
// Transport wrapper: Send only (trait object lacks + Sync).
// LoopbackPair: Send + Sync (LoopbackTransport is Send + Sync).
// BlockingTransportFixture: Send + Sync (per C.2 walk above).
const _ASSERT_BINDING_LOOPBACK_PAIR_SEND_SYNC: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<LoopbackPair>();
};
```

This makes the SemVer floor explicit.

**Severity rationale**: MEDIUM because Rule 4 silence is one
class of audit-discipline gap. The cumulative Rule 4 arc has
6 triggers; this isn't a 7th (no negative claim), but it's the
same FAMILY of "audit assumed X without proof". Pre-V3 cleanup
is appropriate.

## MEDIUM-3 — Kind-string stability is not test-pinned

**Severity**: MEDIUM
**Where**: error-code stability surface.

V2.7 added kind() accessors with SemVer-stable strings. The
`#[non_exhaustive]` exhaustive match enforces VARIANT addition
at compile time. But STRING-CONTENT typos are unguarded:

- Engine: `crates/ql-collab/src/transport.rs:138-143`,
  `crates/ql-collab-ws/src/lib.rs:252-259`,
  `crates/ql-collab/src/session.rs:173-181`.
- Tests at the bottom of each file (`transport_error_kind_io`
  etc.) DO pin each kind string for each variant. Walk:

  ```rust
  // transport.rs:1107
  fn transport_error_kind_io() {
      let e = super::TransportError::Io("socket dead".into());
      assert_eq!(e.kind(), "transport_io");
  }
  ```

  These ARE the pin tests. CORRECT — but the IDE's
  `KNOWN_QUANTBOOK_ERROR_CODES` set in
  `extensions/quantlab/src/quantbook/session.ts:189-205` is
  manually maintained, NOT generated from the engine output.

The IDE-side surface (`QuantbookErrorCode` union in types.ts +
the set in session.ts) is THE drift surface. A typo on the engine
side (e.g., `"transport_io"` becomes `"transport_oi"` accidentally)
would:
- pass the engine's `transport_error_kind_io` test if the test
  is updated alongside (the test mirrors the kind exactly).
- The IDE's KNOWN_QUANTBOOK_ERROR_CODES set would NOT contain
  `"transport_oi"`, so `parseQuantbookError` would return
  `{code: 'unknown', message: '[transport_oi] ...'}`.
- IDE reconnect logic looking for `info.code === 'transport_io'`
  silently misses.

V2.7 audit's Codex M3 closure note (session.ts:184-187) already
flags this:

> Keeping this set in sync with the union type QuantbookErrorCode
> (minus 'unknown') is a manual discipline. V2 backlog: codegen
> this set from the union (or use a const enum) to eliminate the
> drift hazard.

**Remediation**: codegen the IDE-side set from the engine via
a build-time script. Either:
- napi-rs exposes a const `pub const KIND_NAMES: &[&str] = &[...]`
  produced from the kind() accessors (manual today; a `kind!`
  proc-macro could do it).
- TypeScript-side: derive `KNOWN_QUANTBOOK_ERROR_CODES` from
  the union type at TS compile time:

  ```ts
  // Force exhaustive coverage at compile time
  const KNOWN_CODES: Record<Exclude<QuantbookErrorCode, 'unknown'>, true> = {
      transport_io: true,
      transport_closed: true,
      // ... all kinds
      bad_argument: true,
  };
  const KNOWN_QUANTBOOK_ERROR_CODES = new Set(Object.keys(KNOWN_CODES)) as ReadonlySet<QuantbookErrorCode>;
  ```

  If a future kind is added to the union but not to KNOWN_CODES,
  the Record's Exclude<> fails to compile.

**Severity rationale**: MEDIUM because the drift hazard is real
and the current "manual discipline" comment is a paper bandage.
A V3-scale codebase will have more kinds (presence_*, sync_*,
session_undo_at_root_*) and the drift surface grows.

## MEDIUM-4 — `parseQuantbookError` loses bracket prefix for nested-Error wrappers

**Severity**: MEDIUM
**Where**: `extensions/quantlab/src/quantbook/session.ts:254-275`.

```ts
export function parseQuantbookError(err: unknown): QuantbookErrorInfo {
    if (!(err instanceof Error)) {
        return { code: 'unknown', ... };
    }
    const match = QUANTBOOK_ERROR_PREFIX_RE.exec(err.message);
    // ...
}
```

The regex only matches if `err.message` STARTS with the bracket
prefix. But:

1. Some libraries (e.g., `aggregate-error`, Node.js's `AggregateError`)
   wrap multiple errors. `AggregateError.message` is typically a
   summary string, NOT containing the bracket prefix.
2. Promise rejection forwarding through `try/catch` MAY produce
   wrapper errors. Specifically, the napi-rs async pattern at
   `flushPendingToTransport`:

   ```rust
   tokio::task::spawn_blocking(move || handle.wait_for_drain())
       .await
       .map_err(|e| Error::from_reason(format!("flushPendingToTransport task: {e}")))?
       .map_err(transport_error_to_napi)
   ```

   If the `spawn_blocking` task panics, the outer Error has
   message `"flushPendingToTransport task: ..."` — NO bracket
   prefix. `parseQuantbookError` returns `{code: 'unknown',
   message: '...task: ...'}`. The IDE's reconnect logic sees
   `unknown` and fall through to a generic-error branch.

3. If `Error.cause` is populated (modern Node.js Error
   constructors support `new Error('outer', {cause: innerErr})`),
   the bracket prefix lives on the INNER error, not outer.
   `parseQuantbookError` doesn't traverse `cause`.

**Remediation**:

```ts
export function parseQuantbookError(err: unknown): QuantbookErrorInfo {
    if (!(err instanceof Error)) {
        return { code: 'unknown', message: typeof err === 'string' ? err : String(err), cause: err };
    }
    // V3 enhancement: walk cause chain for a bracket prefix.
    let current: Error | undefined = err;
    while (current) {
        const match = QUANTBOOK_ERROR_PREFIX_RE.exec(current.message);
        if (match) {
            const rawCode = match[1];
            const rest = match[2];
            if (KNOWN_QUANTBOOK_ERROR_CODES.has(rawCode as QuantbookErrorCode)) {
                return { code: rawCode as QuantbookErrorCode, message: rest, cause: err };
            }
            return { code: 'unknown', message: err.message, cause: err };
        }
        // Walk cause chain (TC39 Error.cause).
        const cause = (current as Error & { cause?: unknown }).cause;
        current = cause instanceof Error ? cause : undefined;
    }
    return { code: 'unknown', message: err.message, cause: err };
}
```

**Severity rationale**: MEDIUM because the napi-rs
`spawn_blocking` task error path is REACHABLE today (any panic
in the wait task surfaces this way). V2.7 audit's Opus L3
"`websocket_runtime_error` reachability documented" closure
acknowledged that some codes are structurally defined but not
reachable via napi paths; this MEDIUM is the symmetric problem
on the IDE side (some napi paths can't surface their code
because the bracket is wrapped).

## LOW-1 — V2.7 IDE drift sentinel: `'unknown'` is in `ALL_QUANTBOOK_ERROR_CODES` for the type guard but not for the parser set

**Severity**: LOW
**Where**: `extensions/quantlab/src/quantbook/session.ts:286-289`.

This is documented and intentional — Opus V2.7 MEDIUM-1 closure
explicitly notes the asymmetry. The current code is correct. I
flag it for ARCHIVAL purposes during V2.8 megaudit closure: a
future contributor might "fix" the asymmetry without reading the
Opus V2.7 transcript. The current_work.md §0 mentions this
closure, but the type-guard docstring should ALSO note the
asymmetry is intentional, not a bug.

**Remediation**: extend the JSDoc on `isQuantbookErrorCode` (line
300-302):

```ts
/**
 * Type guard for `QuantbookErrorCode`. Accepts ALL `QuantbookErrorCode`
 * values including `'unknown'` (the parser fallback) -- INTENTIONALLY
 * asymmetric with `KNOWN_QUANTBOOK_ERROR_CODES` per Opus V2.7 MEDIUM-1
 * closure. ...
 */
```

## LOW-2 — `blocked` flag latch is unreachable hazard, but docstring should call out

**Severity**: LOW
**Where**: `crates/ql-collab/src/transport.rs:680-688` (in
`wait_blocked`).

```rust
let mut flag = blocked.0.lock().map_err(|e| ...)?;
*flag = true;
blocked.1.notify_all();
```

`blocked` is a monotonic latch. The docstring at line 678-682
says "single-use" but the rationale is buried in a comment.
Today's contract is correct (LoopbackPair-mirroring single-use),
but the V3 multi-window demo might tempt a contributor to add a
"reset" path for re-attachable fixtures.

**Remediation**: add a `debug_assert!(!*flag)` to catch
double-use during test runs, OR document the latch invariant in
the struct-level docstring more visibly.

## LOW-3 — `WebSocketTransport::Drop` notify_all is unreachable in practice

**Severity**: LOW
**Where**: `crates/ql-collab-ws/src/lib.rs:631-658`.

```rust
fn drop(&mut self) {
    self.closed.store(true, Ordering::Relaxed);
    self.progress.1.notify_all();   // Unreachable in practice
    self.writer_task.abort();
    self.reader_task.abort();
}
```

Comment at line 647-653 acknowledges: "Unreachable in practice
because Drop is called on a unique &mut self so no concurrent
flush_pending can be in flight, but kept for safety + future
shared-reference APIs."

This is correct documentation. But: post-V2.5, the
`WebSocketProgressAckHandle` IS a shared-reference API
(`Arc<(Mutex<u64>, Condvar)>`). A handle CAN exist outside the
transport. If a future refactor exposes a handle BEFORE moving
the transport into the session's Box, the Drop notify_all
becomes reachable. CURRENTLY safe because all V2.5 handle
extractions happen via `Transport::ack_handle(&self)` from
inside the session's Mutex guard, but the V3 multi-window demo
might add a "pre-attach handshake" pattern that breaks this.

**Remediation**: docstring update — the "future shared-reference
APIs" caveat is already present; tighten to call out the
V2.5 handle pattern.

## LOW-4 — `BlockingTransport::wait_blocked` defensive timeout returns Ok even on never-released path

**Severity**: LOW
**Where**: `crates/ql-collab/src/transport.rs:705-723`.

```rust
let (_released, _timeout) = cv.wait_timeout_while(...);
// `_released` ... drops naturally.
// ...
Ok(())   // returns Ok regardless of whether release fired or block_ms elapsed
```

The test fixture's `block_ms_upper_bound_prevents_hang` (line
1042-1060) ASSERTS this — `Ok` on never-released. Today's IDE
test mocha treats Ok as "wait completed normally", which is fine
for the fixture's semantics.

But: an IDE caller who attaches a `BlockingTransport` and
expects the wait to fail on never-released (e.g., a test that
asserts `flushPendingToTransport()` REJECTS when blocked) would
get a surprise Ok-on-timeout. The V2.5 contract tests work
around this by using `release()` to drive the unblock + asserting
elapsed time, not error.

**Remediation**: document the defensive-timeout Ok-return more
visibly. Or change the semantic to return a `TimedOut` error
variant (semver-breaking).

**Severity rationale**: LOW because the current contract is
DOCUMENTED and TESTED. The hazard is only that an IDE caller
might assume timeout-becomes-Err without reading the docstring.
For V3, if multi-window demo uses BlockingTransport-style
fixtures (it shouldn't — HIGH-1 closure removes them), this
matters.

# Section 3 — V3 ENTRY READINESS

## 3.1 V2 backlog: required-pre-V3 vs deferred

| Backlog item | V2 source | Pre-V3? | Justification |
|---|---|---|---|
| **Production-cdylib hardening of BlockingTransportFixture** | Opus V2.5 LOW-2 | **REQUIRED** | Per HIGH-1 above. Multi-window IDE demo + onward shipping cannot expose a tokio-blocking-pool DoS fixture. |
| **Compile-time guard for SemVer-stable kind strings** | Opus V2.7 LOW-2 | **REQUIRED (lighter form)** | Today's exhaustive-without-`_` matches catch VARIANT-addition. The remaining gap is engine ↔ IDE STRING DRIFT (MEDIUM-3). V3 will add more kinds (presence_*, session_undo_*) — drift surface widens. Recommend the TS-side Record<Exclude<>> codegen approach (MEDIUM-3 remediation) as the minimum-viable closure. |
| **Transport-passthrough origin tracking** | Opus V2.7 M3 | DEFER to V3.x | `CollabSessionError::Transport(_)` passthrough is the documented contract. Adding origin tracking (e.g., a `Transport(TransportError, TransportOrigin)` variant where Origin distinguishes "during attach" vs "during flush" vs "during poll") is V3 enhancement, not V3 prerequisite. |
| **Structured `transportLastError()` accessor** | V2.7 closure note | DEFER to V3.x | Would make `websocket_runtime_error` reachable via napi rejection. Useful for the V3 reconnect UX but not blocking. Multi-window demo can use the existing prefix-less string accessor today. |
| **willFlushSend helper** | V2 backlog | DEFER to V3.x | Speculative ergonomic; no concrete V3 caller needs it. |
| **LoopbackTransport.close** | V2 backlog | DEFER to V3.x | Tests can detach the transport from the session to release the loopback pair; explicit close is a convenience. |
| **HandshakeFailed fixture** | V2 backlog | DEFER to V3.x | V2.7 audit already documented `websocket_handshake_failed` as reachable today via passing a real ws-server URL that returns 401. The fixture is a nice-to-have, not blocking. |

**Net pre-V3 list (2 items)**:
1. **HIGH-1**: cfg-gate BlockingTransportFixture (Option A: binding
   feature flag). Engine work + IDE mocha import update.
2. **MEDIUM-3**: codegen / Record<Exclude<>> for the IDE-side
   QuantbookErrorCode drift surface.

Both can be done in a single V2.9 hardening cycle before V3
starts. Estimated 1-2 days.

## 3.2 Multi-window IDE demo (V3 work) — V2-side gaps

The plan per current_work.md §0 is: V2.8 megaudit (this lane is
1 of 3) → V2 exit packet → V3 entry (multi-window IDE demo via
`vscode.openFolder` + localhost ws relay).

**WebSocketTransport readiness for two browser windows on localhost**:

Walk:
1. **Connection multiplexing**: each IDE window creates its own
   `CollabSession` + `WebSocketTransport::connect(ws://localhost:port)`.
   The current `WebSocketTransport` is client-only (line 65 of
   ql-collab-ws/src/lib.rs). The localhost server is OUTSIDE the
   engine's surface — the V3 demo brings its own server (likely
   `tokio-tungstenite::accept_async` in a separate binary or
   the engine's `ql-collab-ws` extending to server-side).
2. **Server-side**: per ql-collab-ws V1 limitations doc at line
   65-67: "Client-only. Server-side WebSocket impls use other
   libraries (axum-tungstenite, warp::ws, etc.)." V3 demo
   server is a V3-scope NEW component, not a V2 gap.
3. **TLS**: V1 is plain ws:// only. For localhost, TLS is not
   required. SAFE for the demo.
4. **Auto-reconnect**: V1 has no auto-reconnect (line 51-55).
   Two windows on localhost should not need reconnect if the
   demo runs both client + server in the same process tree.
   If one window's process dies, the other window's transport
   sees `WebSocketError::RuntimeError("peer stream ended without
   close frame")` (via the reader_task graceful-exit path at line
   554-561). The IDE reconnect logic can detect via
   `transport_last_error()`. SAFE.
5. **Bounded queue**: unbounded outbound mpsc (line 56-64).
   Localhost dead-peer-but-not-closed scenario is realistic
   (e.g., main process pauses while user OS dialog blocks). With
   no backpressure, the alive window's outbound queue can grow
   unboundedly. For a demo this is acceptable (memory budget on
   localhost is ample), but document it.
6. **Inbound frame handling**: text/ping/pong dropped per
   V1 limits (line 68-75). For ping/pong, tokio-tungstenite
   handles Pong via the sink — but only on next app send. For a
   demo with bursty traffic, this is fine. SAFE.

**V2-side gaps the demo will force open**:

- **Auto-reconnect on transient localhost drop**: not strictly
  required for a demo (just retry-from-user), but a polished
  demo wants it. V2 backlog defers this.
- **Bounded outbound mpsc**: not strictly required for localhost
  demo (memory ample), but the V2 V3 step 4 audit closure (Opus
  M5) committed to V2 V4 + backpressure policy. V2 V4 V2 (K4
  chunking) was deferred per current_work.md §0 — V3 inherits
  this debt.
- **Multi-Worker safety of napi classes**: each IDE window has
  its own Node renderer process (V8 isolate). napi-rs class
  instances cannot cross Workers by construction. Each window's
  CollabSession lives in its own process — no cross-process
  binding issues. SAFE.

**Net assessment**: V2 is ready for the multi-window demo on
localhost with the auto-reconnect + bounded-mpsc gaps documented.
The demo will surface these as V3.x backlog naturally.

## 3.3 V3-specific risks

### R1 — Test-fixture exposure (HIGH-1) blocks V3 entry

Covered above. Required pre-V3.

### R2 — parseQuantbookError consumer pattern doesn't scale to multi-window failure modes

**Issue**: today's IDE code path is:

```ts
try {
    session.flushPendingToTransport();
} catch (err) {
    const info = parseQuantbookError(err);
    switch (info.code) { /* ... */ }
}
```

For two windows on localhost, failure modes multiply:

1. **Window A's transport disconnects** (peer = Window B closed):
   `info.code === 'transport_closed'` on A's session. A's reconnect
   logic kicks. But B also sees disconnect simultaneously (its
   reader_task observes Window A's side closed). Both windows
   race to reconnect on the same localhost:port. Server-side
   has to disambiguate or both reconnect attempts succeed and
   the server has 3 client sockets briefly.
2. **Window A's local op log diverges from B's** (during the
   disconnect): on reconnect, B's transport is fresh (V2 V3 step 1
   contract resets last_flushed_vv = None), so B's next flush
   sends from empty VV → ALL local ops including divergence.
   Loro's CRDT merges them. SAFE.
3. **Stale closure** (Window A's UI is open but tokio runtime
   crashed): A's transport's writer_task aborted; A's session
   still has the transport attached. Subsequent A operations:
   `appendPutValue` succeeds locally (op committed). Auto-flush
   tries to send via transport. `WebSocketTransport::send`
   returns `Err(Closed)` (closed flag set by the aborted task's
   TaskExitGuard). Engine maps to
   `CollabSessionError::Transport(TransportError::Closed)`. napi
   layer prepends `[transport_closed]`. IDE's
   parseQuantbookError → `{code: 'transport_closed'}`. IDE
   reconnect logic should call `detachTransport()` +
   `Transport.websocketConnect(...)` + `attachTransport()`.
4. **The wrapped task panic** (MEDIUM-4): if `spawn_blocking`
   panics (e.g., parking_lot poison after pre-V2.4-style aliasing
   bug, hypothetically), the IDE sees
   `"flushPendingToTransport task: ..."` — `parseQuantbookError`
   returns `{code: 'unknown', message: '...task: ...'}`.
   Reconnect logic gets generic-error path, not transport-specific.
   See MEDIUM-4 remediation.

**Net R2 verdict**: MEDIUM-4 closure (cause-chain walk in
parseQuantbookError) is V3-recommended. The auto-reconnect
policy is a V3 design discussion (idempotency on rapid retry,
exponential backoff, etc.).

### R3 — Send + Sync claims drift as V3 surface grows

V2.4 made `CollabSession: Sync` (was `!Sync`). V3 will add new
binding classes (PresenceState, UndoGroupGuard, FormatId enum
wrapper). Each must be audited for Rule 4. The MEDIUM-2
"asymmetric assert" hardening should be applied to all new
classes.

### R4 — Drop order under V3's reference-aware bindings

`CollabSession` field-decl order (peer_id → log → undo →
transport → auto_flush_policy → last_flushed_vv) is currently
safe. V3 will add presence, undo group state, and possibly a
"weak session ref" for the multi-window relay. Each addition
shifts Drop order; per Rule 4 audit-discipline a Drop-order
walk is REQUIRED for each V3 ship.

### R5 — `BlockingTransport` block_ms upper-bound of u32::MAX

After HIGH-1 closure, the fixture is dev-only. But within dev,
the napi binding accepts up to u32::MAX (validate_u32_index
returns u32). u32::MAX ms ≈ 49.7 days. A developer typo
`new BlockingTransportFixture(4294967295)` (one comma too many
in `1000000`) parks a tokio blocking-pool thread for 49.7 days.
The thread is daemon → process exit cleans it up, BUT if mocha
test infrastructure forgets to call `.release()` the test runner
hangs until OS-level kill.

**Remediation (defense-in-depth)**: cap napi block_ms at a more
reasonable upper bound (e.g., 60_000 ms = 1 minute). For dev
fixtures, 1 minute is plenty.

```rust
const FIXTURE_MAX_BLOCK_MS: u32 = 60_000;
if block_ms_u32 > FIXTURE_MAX_BLOCK_MS {
    return Err(bad_argument_error(format!(
        "BlockingTransportFixture: blockMs must be ≤ {FIXTURE_MAX_BLOCK_MS} (1 minute)"
    )));
}
```

**Severity rationale**: not a finding because it's a dev-only
hazard. Flagged as R5 for the V3 entry plan.

# Section 4 — Summary

## Walk verdicts

| Target | Verdict |
|---|---|
| A. Transport trait + impls | PASS |
| B. FlushAck trait + impls | PASS (Rule 4 #6 remedy robust) |
| C. BlockingTransport / Fixture | PASS-WITH-FINDINGS (HIGH-1 prod cdylib) |
| D. LoopbackPair (V2.1) | PASS |
| E. Error enums | PASS-WITH-FINDINGS (MEDIUM-3 string drift) |
| F. V2.4 Arc<Mutex<CollabSession>> | PASS |

## Findings tally

| Severity | Count |
|---|---:|
| HIGH | 1 |
| MEDIUM | 4 |
| LOW | 4 |
| **TOTAL** | **9** |

## Rule 4 tally

- New triggers this lane: **0**.
- Cumulative arc count: **6** (unchanged).
- Largest hazard: HIGH-1 (test-fixture exposure) — NOT a Rule 4
  trigger (no negative trait claim involved), but a SemVer-floor
  hazard.

## V3 entry-readiness verdict

**CONDITIONAL GO** for V3 entry. Two items required pre-V3:

1. HIGH-1: cfg-gate BlockingTransportFixture out of release cdylib.
2. MEDIUM-3 (recommended): IDE-side QuantbookErrorCode drift codegen.

Other 7 findings (MEDIUMs + LOWs) can land in V3.x or V2.9
hardening cycle. Multi-window demo can begin on localhost
after HIGH-1 closure; auto-reconnect + bounded mpsc surface as
V3.x backlog naturally.

**V2 exit packet recommendation**: include the V3-required list
above as "V2 closure prerequisites" in the exit packet. V3 entry
plan should explicitly call out that the demo cannot ship until
HIGH-1 closes.
