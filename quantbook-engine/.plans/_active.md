---
name: 2026-05-22_phase-5-7-v2-transport-binding
status: in-progress (V2.1 + V2.2 + V2.3 + V2.4 SHIPPED; V2.5 + V2.6 PLANNED for this session as cycle 5 combined)
date: 2026-05-22
predecessor_commit: 89dd5f0d170 (engine: docs(5.7) finalize V2 — exit packet + MASTER-PLAN backfill)
ide_predecessor_commit: 97e0513d134 (IDE: Phase 5.7 V1 megaudit closures)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V2 — Transport binding (extends V1's CollabSession-only surface)
canonical_v2_design_reference: docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md
canonical_v2_audit_references:
  v2.1: docs/audits/2026-05-22-phase-5-7-v2-1-{codex,opus}.md
  v2.2: docs/audits/2026-05-22-phase-5-7-v2-2-{codex,opus}.md
  v2.3: docs/audits/2026-05-22-phase-5-7-v2-3-{codex,opus}.md
  v2.4: docs/audits/2026-05-22-phase-5-7-v2-4-{codex,opus}.md
arc_estimate_original: 3-5 days total. Actual: V2.1+V2.2 cycle-1; V2.3+V2.4 cycle-2 (continued in fresh context); V2.5+ next session.
session_cycles_budget: 2 cycles per session per CLAUDE.md global rule. Multi-session arc.
v2_progress_summary: 4 cycles done (V2.1, V2.2, V2.3, V2.4) → 4 remaining (V2.5 engine refactor, V2.6 test fixture, V2.7 multi-window demo, V2.8 megaudit + exit packet).
current_engine_head: 7123c6a57bb (Phase 5.7 V2.4 audit closures)
current_ide_head: 8f0a44e19e9 (feat(quantbook): Phase 5.7 V2.4 audit closures)
current_mocha_count: 72 / 72
current_engine_workspace: 4461 / 0 baseline (V2.4 closure doesn't touch ql-collab)
audit_rules_inherited:
  - Rule 1: no fresh-session reminders (existing memory)
  - Rule 2: parallel Codex+Opus per step
  - Rule 4: negative trait claims need positive compile proof OR per-field walk (caught 3 violations in V1)
---

# Phase 5.7 V2 — Transport binding (Plan)

## Scope

Bind the engine's Transport surface so the IDE can attach Transport variants (LoopbackTransport, WebSocketTransport) to a CollabSession and drive multi-peer sync from JS.

V1 was `CollabSession` only — no peers could talk to each other from the IDE side. V2 makes the IDE multi-peer capable.

## Pre-cleared design decisions (from Opus-B megaudit V2-readiness report)

1. **Transport binding shape**: Option A — single opaque `Transport` napi class with static factory methods.
2. **`attach_transport<T>` generic problem (Opus-B HIGH-2)**: napi-rs cannot bind generics. Add `attach_transport_boxed(&mut self, Box<dyn Transport + Send>)` as a Rust-side sibling. The generic version stays for direct Rust callers.
3. **Async-connect shape (WebSocketTransport)**: `#[napi(async)]` returning JS `Promise<Transport>`. Deferred to V2.3 (next session).
4. **`flush_pending_to_transport` sync Condvar problem**: `#[napi(async)]` to avoid V8 freeze. Deferred to V2.3 (next session).
5. **Multi-window topology**: same-machine two-window via WebSocket localhost. Deferred to V2.3+ (next session).
6. **Engine assertion sweep (Rule 4)**: each newly-bound method MUST be checked for FFI-reachable `assert_*!` / `panic!` / `unwrap` / `expect`. Per-step audits enforce this.

## V2.1 — Loopback foundations + core attach/flush/poll (Cycle 1) ✅ SHIPPED 2026-05-22

**Engine commit**: `c4e7b471142` Phase 5.7 V2.1 engine — Transport binding foundations
**IDE commit**: `1f142366839` feat(quantbook): Phase 5.7 V2.1 — Transport binding wrappers
**Tests**: engine 4461 / 0 (gate run); ql-collab lib 66 / 0; ql-bindings-node 3 / 0; IDE mocha 40 / 40 (was 26 at V1 megaudit closure)

**Engine work**:

- [x] **`ql-collab` Rust**: added `CollabSession::attach_transport_boxed(&mut self, Box<dyn Transport + Send>)` sibling — closes V1 megaudit Opus-B HIGH-2. Generic `attach_transport<T>` delegates to it. 2 new Rust unit tests pin equivalence + VV-reset.
- [x] **`ql-bindings-node`**: new napi `Transport` opaque class (Send compile-assert added per Rule 4). `take_inner()` Rust-only extractor.
- [x] **`ql-bindings-node`**: new `LoopbackPair` napi class with `takeA` / `takeB` single-use semantics + `impl Default`. Replaces the ambitious `Transport.loopbackPair()` plan that failed the `ObjectFinalize` factory constraint — see ship-commit message rationale.
- [x] **`ql-bindings-node`**: 5 new `CollabSession` napi methods (`attachTransport`, `detachTransport`, `hasTransport`, `flushToTransport`, `pollRemote`). All sync, error-mapped via `format!("{e}")` to JS Error.

**IDE work**:

- [x] Extended `types.ts` with `TransportInstance`, `LoopbackPairInstance`, `LoopbackPairConstructor` interfaces + 5 new CollabSession methods.
- [x] Extended `session.ts` with `loopbackTransportPair()` + `createLoopbackPair()` helpers.
- [x] Added 14 mocha tests (target was 8-10 — exceeded). Coverage includes happy-path, consumption errors, no-transport branches, three-mutation chain, bidirectional sync, baseline reset, cross-session consumption, mid-flight detach.

**Audit obligations**:

- [x] Rust unit tests for `attach_transport_boxed` (equivalence + VV reset).
- [x] Engine-side panic sweep applied (taking f64 row/col in V1 closure mitigated direct-call ToUint32; V2.1 transport methods take no untrusted JS-number params).
- [x] Parallel Codex + Opus audits dispatched (Codex at `.codex-phase-5-7-v2-1-audit.out`; Opus to `docs/audits/2026-05-22-phase-5-7-v2-1-opus.md`).

**Findings emerged during V2.1 work**:

- **pollRemote returns BLOB count, NOT op count** — engine docstring clear; the V2 binding inherits this semantic. Test discovered this by asserting >=3 (got 1). Documented in types.ts + ship commit + an explicit test that pins the contract. V2 may add `pollRemoteOps()` companion later if a use case materializes.
- **napi-rs `#[napi(factory, ...)]` requires single-Self return** — `Vec<Transport>` doesn't satisfy `ObjectFinalize`. Discovered during initial build. Closure: intermediate `LoopbackPair` class with single-use takers (also cleaner UX for the rare "delayed take" case).
- **`cargo test` cannot link napi symbols** — Rust unit tests in `ql-bindings-node` must use `CoreCollabSession` directly, NOT the napi wrappers. Already-applied V1 pattern; reaffirmed in V2.1.
- **`clippy::new_without_default`** fires on `LoopbackPair::new()`. Closure: `impl Default` added.

## V2.2 — Full sync transport surface (Cycle 2) ✅ SHIPPED 2026-05-22

**Engine commit**: [V2.2 engine ship commit hash]
**IDE commit**: [V2.2 IDE ship commit hash]
**Tests**: IDE mocha **60 / 60** (was 41 at V2.1 closure)

**Engine work**:

- [x] `flushDeltaToTransport(): boolean` — V2 V3 step 1's delta path; the production default. Idempotency short-circuit on no-state-change returns Ok(false).
- [x] `pollRemoteWithLimit(limit: f64): u32` — limit takes `f64` per V1 megaudit ToUint32-hygiene pattern. Validated finite + non-negative + integer + in u32 range via `validate_u32_index`.
- [x] `transportLastError(): string | null` — `None` → `null`. Documented Display-loss caveat for V2.3+ structured discrimination.
- [x] AutoFlushPolicy enum binding:
  - JS shape: string union `'disabled' | 'onAppend'` (V2 plan locked).
  - `setAutoFlushPolicy(policy: string): string` — returns prior policy as canonical camelCase.
  - `autoFlushPolicy(): string` — returns canonical camelCase, `'unknown'` for forward-compat (engine enum is `#[non_exhaustive]`).
  - Engine-side parser accepts aliases (`Disabled`, `OnAppend`, `on-append`).

**IDE work**:

- [x] Extended `types.ts` with 5 new CollabSession methods + `AutoFlushPolicy` exported type union.
- [x] Extended `session.ts` with `isAutoFlushPolicy` strict camelCase type guard. (Engine accepts loose aliases; IDE config-validation path uses the strict guard.)
- [x] Added 19 new mocha tests:
  - flushDelta idempotency contract (first-after-attach sends; second is no-op).
  - flushDelta sends bytes when state changed; no-transport returns false.
  - flushDelta vs flushToTransport semantic difference.
  - pollRemoteWithLimit 0/2/10/negative/NaN/fractional/out-of-u32 cases.
  - transportLastError null on no-transport + on clean Loopback.
  - autoFlushPolicy defaults to 'disabled'.
  - setAutoFlushPolicy returns prior, round-trip, rejects unknown, accepts engine aliases.
  - **onAppend two-peer convergence integration test** — proves auto-flush fires without explicit caller.
  - isAutoFlushPolicy strict guard rejects engine aliases (camelCase only).

**Findings during V2.2 work**:

- **First flushDeltaToTransport after attach ALWAYS sends** even on empty log. Test assumption that "no ops appended → no-op" was wrong: attach sets `last_flushed_vv = None`, idempotency guard short-circuits only when `Some(last_vv) == current_vv`. With None it always proceeds. Closure: rewrote test as "second flush with no state change short-circuits".
- AutoFlushPolicy engine parser is loose (accepts aliases); IDE-side strict camelCase guard added to compensate. The asymmetry is documented + tested explicitly.

**Audit obligations**:

- [x] Parallel Codex + Opus audit (Codex 3M+4L + Opus 2H+5M+6L, all closed in-cycle).

## V2.3 — Async surface (Cycle 3) ✅ SHIPPED 2026-05-22

**Engine commits**: `1e2354cb7b1` (ship; flushPending initially included) → `ea07bc6af4e` (closure: REMOVE flushPending; keep websocketConnect only).
**IDE commits**: `6616e28a2a3` (ship) → `233957ab140` (closure).
**Tests**: IDE mocha 66/66 after closure.

**What shipped**:
- `Transport.websocketConnect(url): Promise<Transport>` — static async factory. Real-network round-trip validated via in-process Node `ws` echo-fanout relay.
- napi `async` feature added (= `tokio_rt`).
- New dep on `ql-collab-ws` for WebSocketTransport.
- 4 mocha tests in new V2.3 suite: rejection paths (InvalidUrl, ConnectFailed), connect-success, end-to-end two-peer round-trip, WebSocket Transport single-use semantics.

**Audit FAIL on first ship — Codex+Opus 2H convergent**:
- HIGH-1: Rust UB via napi `&mut self` async aliasing on `flushPendingToTransport`. Verified per napi-derive-backend-5.0.4 codegen.
- HIGH-2: tokio runtime starvation (Condvar wait on shared worker pool).

**Closure REMOVED `flushPendingToTransport`**. Documented V2.4 reintroduction plan (options A: Arc<Mutex>, B: Notify, C: serialization guard). V2.3 retained only the safe `websocketConnect`.

Other V2.3 closures: loader V2.3 export check, tighter rejection categories, replaced 50ms setTimeout with poll loop, removed try/catch swallow in test fixture.

## V2.4 — Sound async reintroduction (Cycle 4) ✅ SHIPPED 2026-05-22

**Engine commits**: `c51df9f41f4` (ship: Arc<Mutex> refactor + flushPending reintroduction) → `7123c6a57bb` (closure).
**IDE commits**: `3ab02bbe732` (ship) → `8f0a44e19e9` (closure).
**Tests**: IDE mocha 72/72 after closure.

**What shipped (Option A from V2.3 closure plan)**:
- `CollabSession` napi class refactored from `inner: CoreCollabSession` (`&mut self` methods) to `inner: Arc<parking_lot::Mutex<CoreCollabSession>>` (`&self` methods + internal lock).
- 17 napi method signatures changed `&mut self` → `&self` with `let inner = self.inner.lock();` inside.
- `flushPendingToTransport` REINTRODUCED as `pub async fn(&self) -> Result<()>`. Body: `tokio::task::spawn_blocking(move || { let mut g = inner.lock(); g.flush_pending_to_transport() })`. No `unsafe` (napi-rs accepts async `&self`).
- New direct deps: `parking_lot = "=0.12.5"` + `tokio = { workspace = true }`.
- Send + Sync compile-assert updated: was `Send + !Sync`, now `Send + Sync` (Arc<Mutex<T>>: Sync when T: Send).

**V2.3 HIGHs STRUCTURALLY CLOSED** (both auditors verified via source-walks):
- HIGH-1 (UB): napi-derive-backend-5.0.4 `codegen/fn.rs:278-284` for `FnSelf::Ref` produces shared `&`, not `&mut`. Multiple aliasing reads sound; mutation via Mutex.
- HIGH-2 (tokio starvation): `spawn_blocking` runs on tokio's blocking pool (default 512), NOT worker pool. Condvar wait no longer occupies a worker.

**V2.4 NEW HIGHs closed in-cycle**:
- HIGH-2 (Rule 4 doc-drift): module docstring still claimed `Send + !Sync` after refactor became `Send + Sync`. Rewrote with V2.4 reality + source citations.
- HIGH-1 (V8-block UX hazard): sync method during pending `flushPendingToTransport` blocks V8 event loop on lock acquisition. NOT a soundness hazard. Documented as known trade-off; V2.5+ engine refactor plan (clone-Arc-then-release OR Notify-based async). Caller discipline today: don't call other session methods while flushPending is awaiting.

**V2.4 audit verdicts**:
- Codex: PASS-WITH-FINDINGS (0H+0M+3L+1OBS).
- Opus: PASS-WITH-FINDINGS (2H+7M+5L+6OBS).

## V2.5 + V2.6 — Combined cycle (Cycle 5) — PLANNED 2026-05-22 (Codex-verified PASS-WITH-FINDINGS)

**Codex review verdict** (`/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/.codex-v2-5-plan-review.out`, 2026-05-22):
> PASS-WITH-FINDINGS. The core V8-block fix direction is sound; ship after applying the 4 MEDIUM + 1 LOW recommendations below. Q1 lock-release pattern VERIFIED. Q2 Box<dyn FlushAck + Send> design ACCEPTABLE.

**Codex-driven plan revisions** (applied below to design + step order):
- **M1** — Capture `target: u64` in `WebSocketProgressAckHandle` (at `ack_handle()` call), NOT inside `wait_for_drain`. Preserves "previously queued" contract.
- **M2** — `BlockingTransport` is NOT exposed as `new engine.BlockingTransport(...)`. Replace with `BlockingTransportFixture` napi class: `takeTransport(): Transport`, `release(): void`, `waitUntilBlocked(): Promise<void>`. Mirrors V2.1 `LoopbackPair` pattern.
- **M3** — V2.5 contract test uses `await fixture.waitUntilBlocked()` (deterministic) BEFORE measuring `opCount` elapsed. Relative assertion: `elapsed < blockMs/2`, with `blockMs = 1000`.
- **M4** — `Transport` stays as `pub trait Transport` (no `Send` supertrait). Only add the default `ack_handle()` method.
- **L1** — Re-export `FlushAck` in `crates/ql-collab/src/lib.rs` alongside `Transport`.
- **Q4 feature-gate**: `BlockingTransportFixture` lives behind `test-fixtures` Cargo feature on ql-collab. ql-bindings-node's `Cargo.toml` enables this feature unconditionally (so the cdylib always carries it). Justification: simple build flow, fixture is harmless (can only block its own session's flush; no CRDT corruption path). V2 backlog item: "harden test-fixture exposure for production cdylib builds" (defer to post-V2 product hardening).

**Combined into one ship cycle** because Opus V2.4 MEDIUM-2 flagged that V2.4's "soundness" mocha tests are vacuous on Loopback (LoopbackTransport's `flush_pending` is the trait default `Ok(())` — returns immediately; no mutex contention is forced). The V2.5 engine refactor cannot be MEANINGFULLY audited without the V2.6 BlockingTransport fixture that proves both (a) the V8-block hazard exists in V2.4, and (b) V2.5 closes it. Shipping V2.5 without V2.6 would just re-open the "tests don't exercise the contention path" finding.

### Research grounding (source-walked 2026-05-22, this session)

- **`CollabSession::flush_pending_to_transport`** (`crates/ql-collab/src/session.rs:855-861`) is a simple proxy: `self.transport.as_mut()?.flush_pending()`. The wait happens INSIDE the transport, not in the session.
- **Only the napi binding** calls this in production (`crates/ql-bindings-node/src/lib.rs:832-841`). No engine tests, no other callers.
- **`WebSocketTransport` progress state** (`crates/ql-collab-ws/src/lib.rs:296-322`):
  - `queued_count: Arc<AtomicU64>` — bytes queued (incremented by `send()`)
  - `progress: Arc<(Mutex<u64>, Condvar)>` — bytes written by writer task (incremented + notified by writer)
  - `closed: Arc<AtomicBool>` — early-exit flag
  - **All three are already Arc-shared with the writer task** → extractable for an external "ack handle".
- **`Transport: Send`** (the trait bound, `crates/ql-collab/src/transport.rs`). Trait does NOT require `Sync`. `Box<dyn Transport + Send>` is `?Sync`.
- **Trait-object `ack_handle(&self)` method is non-breaking**: default impl returns `None`; Loopback/Noop inherit; only WebSocketTransport (+ new BlockingTransport) override.
- **The V8-block hazard is in the napi binding, not the engine**: the binding holds `self.inner.lock()` across `spawn_blocking`. Inside the blocking task, the engine's `flush_pending_to_transport` is called, which waits on the WebSocketTransport Condvar. While that wait runs, the session Mutex is held — blocking any concurrent JS sync call on V8 thread.
- **Opus V2.4 HIGH-1 closure recommendation (verbatim, `docs/audits/2026-05-22-phase-5-7-v2-4-opus.md:215-248`)**: Option A — extract a progress-handle clone under the session lock, release the lock, then perform the Condvar wait WITHOUT the session lock held.
- **Why not "Option B (Notify)"**: replacing Condvar with `tokio::sync::Notify` doesn't help — `flush_pending` is sync at the trait level (called from within `spawn_blocking`); the hazard is the outer session lock, not the inner sync primitive. (Verified per Explore agent source-walk + Opus audit.)

### V2.6 — `BlockingTransport` test fixture (engine-side) — Codex-revised

**Location**: `crates/ql-collab/src/transport.rs` (alongside existing `LoopbackTransport` + `NoopTransport`). Gated behind `#[cfg(feature = "test-fixtures")]` so the production-build-without-feature does NOT carry it. **The ql-bindings-node `Cargo.toml` enables `test-fixtures` unconditionally** (cdylib always carries the fixture). Codex Q4 prefers feature-gate over production-cdylib; this compromise keeps the cdylib build flow unchanged (no `--features` flag at mocha-build time) while making the gate explicit + auditable + later removable.

**Engine surface**:
```rust
#[cfg(feature = "test-fixtures")]
pub struct BlockingTransport {
    block_ms: u64,                     // upper bound for the block_pending wait
    release: Arc<(Mutex<bool>, Condvar)>,  // external release signal
    blocked: Arc<(Mutex<bool>, Condvar)>,  // signal: "wait has been entered"
    // No internal send/recv channels — `send` and `try_recv` are no-ops; the fixture
    // tests flushPending behavior in isolation, not the full send/recv cycle.
}

#[cfg(feature = "test-fixtures")]
pub struct BlockingAckHandle {
    block_ms: u64,
    release: Arc<(Mutex<bool>, Condvar)>,
    blocked: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(feature = "test-fixtures")]
impl Transport for BlockingTransport {
    fn send(&mut self, _bytes: &[u8]) -> Result<(), TransportError> { Ok(()) }
    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> { Ok(None) }

    fn flush_pending(&mut self) -> Result<(), TransportError> {
        // Set blocked = true + notify (test can await this signal).
        // Then wait until release flag flips OR block_ms expires.
        // (Implementation below — uses same Mutex+Condvar pattern as WebSocketTransport.)
    }

    fn ack_handle(&self) -> Option<Box<dyn FlushAck + Send>> {
        Some(Box::new(BlockingAckHandle {
            block_ms: self.block_ms,
            release: Arc::clone(&self.release),
            blocked: Arc::clone(&self.blocked),
        }))
    }
}

#[cfg(feature = "test-fixtures")]
impl FlushAck for BlockingAckHandle {
    fn wait_for_drain(&self) -> Result<(), TransportError> {
        // Same logic as BlockingTransport::flush_pending but on Arc clones.
        // Critically: signals `blocked = true` BEFORE entering the wait so the JS
        // contract test's `waitUntilBlocked()` resolves only AFTER the V2.5 binding
        // has dropped the session lock + started the spawn_blocking task + entered
        // the Condvar wait.
    }
}
```

**JS-side fixture controller** (Codex M2 fix — `BlockingTransport` is NOT a `new`-able napi class):

```rust
#[cfg(feature = "test-fixtures")]
#[napi]
pub struct BlockingTransportFixture {
    inner: Option<BlockingTransport>,           // taken once via takeTransport()
    release: Arc<(Mutex<bool>, Condvar)>,
    blocked: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(feature = "test-fixtures")]
#[napi]
impl BlockingTransportFixture {
    /// JS: `new BlockingTransportFixture(blockMs: number)`.
    /// `blockMs` is the upper-bound time the fixture blocks if `release()`
    /// is never called (defensive — prevents test hangs).
    #[napi(constructor)]
    pub fn new(block_ms: f64) -> Result<Self> {
        // validate_u32_index pattern from V1 megaudit closure.
        let block_ms_u32 = validate_u32_index("BlockingTransportFixture", "blockMs", block_ms)?;
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let blocked = Arc::new((Mutex::new(false), Condvar::new()));
        Ok(Self {
            inner: Some(BlockingTransport::new(block_ms_u32 as u64,
                Arc::clone(&release), Arc::clone(&blocked))),
            release,
            blocked,
        })
    }

    /// JS: `fixture.takeTransport()`. Returns the Transport wrapper that can be
    /// passed to `session.attachTransport()`. Single-use (consumes the fixture's
    /// inner BlockingTransport). Mirrors V2.1 LoopbackPair's takeA/takeB pattern.
    #[napi(js_name = "takeTransport")]
    pub fn take_transport(&mut self) -> Result<Transport> {
        let t = self.inner.take().ok_or_else(|| {
            Error::from_reason("BlockingTransportFixture.takeTransport already called on this fixture".to_string())
        })?;
        Ok(Transport { inner: Some(Box::new(t)) })
    }

    /// JS: `fixture.release()`. Unblocks any in-progress flush_pending wait on
    /// the fixture's transport. Idempotent.
    #[napi]
    pub fn release(&self) {
        let (lock, cv) = &*self.release;
        *lock.lock() = true;
        cv.notify_all();
    }

    /// JS: `await fixture.waitUntilBlocked()`. Resolves AFTER the V2.5 napi
    /// binding has extracted the ack handle, dropped the session lock, started
    /// spawn_blocking, and entered the Condvar wait. Critical for deterministic
    /// V2.5 contract testing (Codex M3 fix).
    #[napi(js_name = "waitUntilBlocked")]
    pub async fn wait_until_blocked(&self) -> Result<()> {
        let blocked = Arc::clone(&self.blocked);
        tokio::task::spawn_blocking(move || {
            let (lock, cv) = &*blocked;
            let mut guard = lock.lock();
            while !*guard { cv.wait(&mut guard); }
        })
        .await
        .map_err(|e| Error::from_reason(format!("waitUntilBlocked: {e}")))
    }
}
```

**Why this shape**:
- `BlockingTransportFixture` is a separate napi class (not a Transport subclass) — Codex M2 fix.
- Returns a `Transport` instance via `takeTransport()` — works with existing `attachTransport(t: Transport)` surface.
- `waitUntilBlocked()` makes the V2.5 contract test deterministic — Codex M3 fix.
- `block_ms` is a defensive upper bound — test never hangs if `release()` is forgotten.

### V2.5 — Engine refactor: `Transport::ack_handle` trait extension

**Trait change** (additive, non-breaking — default impl returns `None`).
**Codex M4 fix**: do NOT add `: Send` supertrait to `Transport` (the current trait at `crates/ql-collab/src/transport.rs:128` has no supertrait; adding one is breaking even for engine-internal callers because some impl sites may not yet be Send-checked).

```rust
// In crates/ql-collab/src/transport.rs

pub trait Transport {  // Codex M4: NO `: Send` supertrait added
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
    fn flush_pending(&mut self) -> Result<(), TransportError> { Ok(()) }
    fn last_error(&self) -> Option<String> { None }

    /// **V2.5 (2026-05-22)**: Extract a Send handle that can perform
    /// the same drain-wait as `flush_pending`, but from a context that
    /// has already released any outer locks guarding the Transport.
    ///
    /// Default `None` — transports without async-flush semantics
    /// (Loopback, Noop) keep `flush_pending` as the canonical drain.
    /// `WebSocketTransport` overrides to return a handle cloning its
    /// internal `Arc<(Mutex<u64>, Condvar)>` progress channel.
    ///
    /// **Codex M1 contract**: the returned handle MUST capture the
    /// drain target (queued_count snapshot) at the moment of this call.
    /// Sends queued AFTER this call returns do NOT extend the wait.
    /// Preserves the documented `flush_pending` semantic at
    /// `crates/ql-collab/src/transport.rs:201`.
    ///
    /// Closes Opus V2.4 HIGH-1 (V8-block UX hazard) by enabling the
    /// napi binding to drop the session Mutex before performing the
    /// Condvar wait.
    fn ack_handle(&self) -> Option<Box<dyn FlushAck + Send>> { None }
}

/// **V2.5 (2026-05-22)**: Detached flush-pending handle. Holds Arc
/// clones of the underlying transport's progress state so the wait
/// can run without the transport (or its outer locks) held.
///
/// `Send` is sufficient — the handle is moved into one spawn_blocking
/// task and never shared (Codex risk #9 confirmed).
pub trait FlushAck: Send {
    /// Wait for the drain target captured at handle creation to be
    /// reached. Mirrors `Transport::flush_pending` Closed/Io error
    /// semantics for transports that override it.
    fn wait_for_drain(&self) -> Result<(), TransportError>;
}
```

**`WebSocketTransport` impl** (`crates/ql-collab-ws/src/lib.rs`) — Codex M1 fix applied:

```rust
pub struct WebSocketProgressAckHandle {
    /// **Codex M1 fix**: target captured at `ack_handle()` call.
    /// Wait for progress counter to reach THIS value, not whatever
    /// queued_count is at wait-start time. Preserves the documented
    /// "previously queued" contract from
    /// `crates/ql-collab/src/transport.rs:201`.
    target: u64,
    progress: Arc<(Mutex<u64>, Condvar)>,
    closed: Arc<AtomicBool>,
}

impl FlushAck for WebSocketProgressAckHandle {
    fn wait_for_drain(&self) -> Result<(), TransportError> {
        // Logic mirrors `WebSocketTransport::flush_pending` (lib.rs:733-760)
        // but with a CAPTURED target (Codex M1 fix), not a fresh load.
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        let (counter_lock, cv) = &*self.progress;
        let mut counter = counter_lock.lock().map_err(|e| {
            TransportError::Io(format!("flush_pending lock poisoned: {e}"))
        })?;
        while *counter < self.target {
            if self.closed.load(Ordering::Relaxed) {
                return Err(TransportError::Closed);
            }
            let (new_counter, _) = cv.wait_timeout(counter, Duration::from_millis(100))
                .map_err(|e| TransportError::Io(format!("flush_pending wait poisoned: {e}")))?;
            counter = new_counter;
        }
        Ok(())
    }
}

impl Transport for WebSocketTransport {
    // ... existing methods unchanged ...

    fn ack_handle(&self) -> Option<Box<dyn FlushAck + Send>> {
        // **Codex M1 fix**: capture target here, BEFORE returning.
        // queued_count is updated by `send()` (lib.rs:657, 664). This snapshot
        // is the canonical "drain target" for this flushPending call.
        Some(Box::new(WebSocketProgressAckHandle {
            target: self.queued_count.load(Ordering::SeqCst),
            progress: Arc::clone(&self.progress),
            closed: Arc::clone(&self.closed),
        }))
    }
}
```

**`CoreCollabSession` proxy** (`crates/ql-collab/src/session.rs`):

```rust
/// **V2.5 (2026-05-22)**: Extract the attached transport's flush ack
/// handle for async drain waits without holding the session-owning
/// outer lock (e.g., the napi binding's `Arc<Mutex<CollabSession>>`).
///
/// Returns None if no transport is attached or the attached transport
/// has no async-flush semantics. Takes `&self` (not `&mut self`) so
/// napi binding callers can extract under a `try_lock` or read guard.
pub fn flush_pending_handle(&self) -> Option<Box<dyn FlushAck + Send>> {
    self.transport.as_ref()?.ack_handle()
}
```

**napi binding refactor** (`crates/ql-bindings-node/src/lib.rs`):

```rust
#[napi(js_name = "flushPendingToTransport")]
pub async fn flush_pending_to_transport(&self) -> Result<()> {
    // V2.5 closure of Opus V2.4 HIGH-1: extract ack handle under
    // session lock, release lock, then wait WITHOUT holding the
    // session lock. Concurrent JS sync methods can now acquire the
    // lock immediately while the Condvar wait runs.
    let handle_opt: Option<Box<dyn ql_collab::FlushAck + Send>> = {
        let inner = self.inner.lock();
        inner.flush_pending_handle()
    }; // session lock released here

    let Some(handle) = handle_opt else {
        return Ok(()); // no transport, or transport has no ack semantics
    };

    tokio::task::spawn_blocking(move || handle.wait_for_drain())
        .await
        .map_err(|e| Error::from_reason(format!("flushPendingToTransport task: {e}")))?
        .map_err(|e| Error::from_reason(format!("{e}")))
}
```

**V2.4's existing `flush_pending_to_transport`** (the engine method, sync) remains unchanged — it's still used by tests + non-napi callers (currently zero, but the trait method `flush_pending` is the canonical sync API).

### Files to create / modify

**Engine** (`quantlab-quantbook/quantbook-engine/`):

1. `crates/ql-collab/src/transport.rs`: add `FlushAck` trait + `Transport::ack_handle` default-`None` method (no `Send` supertrait, per Codex M4). **Add** `BlockingTransport` + `BlockingAckHandle` structs `#[cfg(feature = "test-fixtures")]` (Codex Q4 fix).
2. `crates/ql-collab/src/lib.rs`: re-export `FlushAck` alongside existing `Transport` re-exports (Codex L1 fix). Also re-export `BlockingTransport` behind the same feature flag.
3. `crates/ql-collab-ws/src/lib.rs`: add `WebSocketProgressAckHandle` struct (with **`target: u64` field captured in `ack_handle()`** per Codex M1) + `impl FlushAck` + `impl Transport::ack_handle for WebSocketTransport` override.
4. `crates/ql-collab/src/session.rs`: add `CoreCollabSession::flush_pending_handle(&self) -> Option<Box<dyn FlushAck + Send>>`. Takes `&self` (the underlying `transport.as_ref()` is non-mut). No changes to existing methods.
5. `crates/ql-bindings-node/src/lib.rs`:
   - Import `ql_collab::FlushAck`.
   - Refactor `flush_pending_to_transport` napi method per the snippet above (extract handle under lock, release, spawn_blocking-wait).
   - Add `BlockingTransportFixture` napi class (constructor + `takeTransport()` + `release()` + `waitUntilBlocked()`) per Codex M2 fix.
   - Update module-level docstring to record V2.5's lock-release pattern + new Send+Sync claims if any.
   - Add Rule 4 compile-asserts: `BlockingTransportFixture: Send`, `WebSocketProgressAckHandle: Send`, `Box<dyn FlushAck + Send>: Send`.
6. `crates/ql-collab/Cargo.toml`: add `test-fixtures = []` feature.
7. `crates/ql-bindings-node/Cargo.toml`: enable `test-fixtures` on the `ql-collab` dep unconditionally (`ql-collab = { path = "...", features = ["test-fixtures"] }`).

**IDE** (`quantlab/quantlab/`):

1. `extensions/quantlab/src/quantbook/types.ts`:
   - Add `BlockingTransportFixtureInstance` + `BlockingTransportFixtureConstructor` interfaces (mirror V2.1 LoopbackPair pattern):
     ```ts
     export interface BlockingTransportFixtureInstance {
       takeTransport(): TransportInstance;
       release(): void;
       waitUntilBlocked(): Promise<void>;
     }
     export interface BlockingTransportFixtureConstructor {
       new(blockMs: number): BlockingTransportFixtureInstance;
     }
     ```
   - Add `readonly BlockingTransportFixture: BlockingTransportFixtureConstructor` to `QuantbookNativeModule`.
   - Update `flushPendingToTransport` JSDoc to **remove the V2.4 V8-block warning** + add a V2.5 reference: "session lock is released before the Condvar wait; concurrent sync methods on the same session do NOT block the V8 event loop".
2. `extensions/quantlab/src/quantbook/loader.ts`: extend shape-check to include `BlockingTransportFixture` (production export). Add to the V2.4 prototype check list with a V2.5 tag.
3. `extensions/quantlab/test/quantbook-roundtrip.test.ts`:
   - **Replace** the V2.4 "smoke test of concurrent JS callers" + "smoke test of interleaved sync during pending async" (the vacuous-on-Loopback ones, per Opus V2.4 MEDIUM-2) with REAL contention tests using `BlockingTransportFixture`.
   - Add 4-6 new tests using the Codex M3 deterministic pattern:
     - `BlockingTransportFixture.takeTransport returns attachable Transport`.
     - `BlockingTransportFixture.takeTransport throws on second call (single-use)`.
     - **V2.5 contract test (THE PIN)**: `flushPendingToTransport does NOT block sync methods on the same session`.
       ```ts
       const fixture = new engine.BlockingTransportFixture(1000); // 1000ms upper bound
       const t = fixture.takeTransport();
       const session = createSession(1n);
       session.attachTransport(t);
       const flushP = session.flushPendingToTransport();
       await fixture.waitUntilBlocked();  // CODEX M3: deterministic
       const start = Date.now();
       const count = session.opCount();
       const elapsed = Date.now() - start;
       assert.ok(elapsed < 500, `opCount took ${elapsed}ms; expected < blockMs/2 = 500`);
       fixture.release();
       await flushP;
       ```
     - V2.5 contract test: concurrent flushPendingToTransport calls serialize through ack handle correctly (both resolve after a single release).
     - `BlockingTransportFixture.release()` is idempotent (calling twice doesn't deadlock).
     - V2.5 contract test: `detachTransport()` during pending flush returns `Err(Closed)` to the awaiting flushPending promise within ~150ms (Codex Risk-5 corollary).

### Testing strategy

**Engine**:
- Add Rust unit tests in `crates/ql-collab/src/transport.rs` (`mod tests`):
  - `BlockingTransport::flush_pending blocks for configured duration`.
  - `BlockingTransport::release unblocks waiting thread`.
  - `BlockingTransport::ack_handle returns a handle that mirrors flush_pending semantics`.
- Add Rust unit tests in `crates/ql-collab-ws/src/lib.rs` (`mod tests`):
  - `WebSocketProgressAckHandle::wait_for_drain matches flush_pending`.
  - `Arc::clone of progress fields means in-flight wait sees writer updates`.

**Binding (Rust unit tests in `ql-bindings-node`)**:
- Add a test that calls `CoreCollabSession::flush_pending_handle()` after attaching a `BlockingTransport` (or WebSocket equivalent) and verifies the returned handle is `Some` with non-trivial wait behavior.

**IDE (mocha)**:
- See files-to-modify section above.

**Workspace gate**:
- `cargo test --workspace --all-features` (slow, ~10-15 min on Mac). Expected: 4461+ / 0 baseline preserved + new tests added.
- `cargo fmt --all` + `cargo clippy --workspace --all-features` clean.

### Risks and mitigations

1. **`BlockingTransport` shipped to production cdylib could be misused.** Mitigation: feature-gate behind `test-fixtures`. Cost: cdylib build must enable the feature → minor Cargo.toml change. Defer decision to Codex verification.

2. **`Transport::ack_handle` default impl returning `None` means `flushPendingToTransport` becomes a no-op for Loopback** (previously: also no-op because `flush_pending` default returns `Ok(())` immediately). Behavior preserved. Mitigation: explicit test for "no-op on Loopback".

3. **Race condition between handle extraction and transport detach.** If JS calls `detachTransport()` between the `flush_pending_handle()` call and the `wait_for_drain()` call, the handle's Arc clones still point at the now-orphaned transport's progress state. The writer task is aborted (per `WebSocketTransport::Drop`) so `closed` flips and `wait_for_drain` returns `Err(Closed)` promptly. Test this case explicitly.

4. **Rule 4 application** (audit-discipline rule from V1+V2.x): the new `FlushAck` trait is `Send`. The compile-asserts must pin `BlockingTransport: Send + Sync` and `WebSocketProgressAckHandle: Send + Sync` AND `Box<dyn FlushAck + Send>: Send`.

5. **Engine refactor depth**: this is the deepest engine change since V2 began (touches Transport trait + ql-collab-ws + ql-collab + ql-bindings-node). 4 crates modified. Audit cycle MUST cross-verify each layer via source-walks (Codex protocol + Opus adversarial lanes).

6. **Engine workspace test pass**: V2.5 changes Transport trait; existing test code that exercises Transport impls (`auto_flush.rs` + others) might need updates if they exercise `ack_handle` indirectly. Pre-flight: grep `Transport` impl sites + ensure default impl satisfies.

### Acceptance criteria for cycle V2.5+V2.6

- [ ] Engine `cargo build -p ql-collab -p ql-collab-ws -p ql-bindings-node --release` clean.
- [ ] Engine `cargo test -p ql-collab -p ql-collab-ws -p ql-bindings-node --release` passes (existing + new tests).
- [ ] Engine `cargo test --workspace --all-features` baseline preserved (4461+ / 0).
- [ ] Engine `cargo fmt --all` + `cargo clippy --workspace --all-features` clean.
- [ ] IDE `tsc -p .` clean.
- [ ] IDE quantbook mocha: target 76+ / 76+ (was 72 at V2.4 close; +4-6 new V2.5 tests; -2 vacuous V2.4 tests).
- [ ] V2.5 contract test (BlockingTransport: opCount() during pending flush < 100 ms) PASSES under V2.5 build; should FAIL if reverted to V2.4 binding pattern.
- [ ] Parallel Codex + Opus audit dispatched + ALL HIGHs closed in cycle.
- [ ] Rule 4 compile-asserts added for `FlushAck`, `BlockingTransport`, `WebSocketProgressAckHandle`.
- [ ] Updated module docstrings: V8-block hazard now CLOSED (was "known trade-off" in V2.4).
- [ ] Commit pair: engine ship + IDE ship (+ closure commits if audit finds anything).

### Cycle budget allocation

- **Cycle 1 this session**: V2.5+V2.6 combined.
- **Cycle 2 this session**: RESERVED. After V2.5+V2.6 ships + audit closes, re-evaluate. Candidates: structured `Error.code` discrimination (closes Opus M3 across V2.1+V2.2+V2.3, unlocks V2.7 reconnect logic — ~half-day), or multi-window IDE demo (V2.7 — ~1-2d, higher user-visible value but higher risk).

### Implementation step order (for cycle V2.5+V2.6)

1. Engine: add `FlushAck` trait + `Transport::ack_handle` method (default `None`). Compile + build.
2. Engine: add `BlockingTransport` struct + `impl Transport for BlockingTransport`. Rust unit tests. Compile + cargo test.
3. Engine: `WebSocketProgressAckHandle` + `impl FlushAck` + `impl Transport::ack_handle for WebSocketTransport`. Rust unit tests. Compile + cargo test.
4. Engine: `CoreCollabSession::flush_pending_handle`. Rust unit tests. Compile + cargo test.
5. Binding: refactor `flush_pending_to_transport` napi method per design. Add `BlockingTransport` napi class. Compile + clippy.
6. IDE: extend `types.ts` + `loader.ts`. tsc + mocha (subset).
7. IDE: replace V2.4 vacuous tests + add V2.5 contract tests. Mocha full run.
8. Engine: `cargo fmt + clippy + cargo test --workspace --all-features` workspace gate (background).
9. Commit V2.5 + V2.6 ship pair (engine + IDE).
10. Dispatch parallel Codex + Opus audits.
11. Wait for audit results.
12. Close audit findings in-cycle (engine closure + IDE closure if needed).
13. Commit V2.5 + V2.6 closure pair if findings emerged.
14. Update `.plans/_active.md` to mark cycle 5 (V2.5+V2.6) shipped + re-think cycle 2.

### Engine assertion sweep (Rule 4 / Rule 4-extension per Opus V2.3 M5)

Each new method MUST be pre-checked for FFI-reachable panics:
- `Transport::ack_handle` default impl: returns `None` — no panic path.
- `WebSocketProgressAckHandle::wait_for_drain`: mirrors existing `WebSocketTransport::flush_pending` semantics; no new panic paths (uses same `lock()?` + `wait_timeout()?` patterns).
- `BlockingTransport::flush_pending` + `BlockingTransport::release`: uses `Condvar` + `Mutex` — `lock()?` patterns; no `unwrap`/`expect` on user-provided data.
- napi binding `flush_pending_to_transport` refactor: same `spawn_blocking` + `lock()` pattern as V2.4; new `flush_pending_handle()` proxy method is `&self` (parking_lot's `lock()` never panics on uncontended path; contended path can deadlock but never panic).
- Per Rule 4: pin `_ASSERT_FLUSH_ACK_SEND` + `_ASSERT_BLOCKING_TRANSPORT_SEND_SYNC` + `_ASSERT_WEBSOCKET_ACK_HANDLE_SEND_SYNC` const-fn asserts.

### V2.7 — Multi-window IDE demo

Extend `quantlab.quantbookDemo` command to spawn a second VS Code window via the `vscode.openFolder` API + a localhost WebSocket relay. The current command does in-process LoopbackPair; V2.7 does two separate extension hosts.

### V2.8 — 3-way Codex+Opus-A+Opus-B megaudit + V2 exit packet

Phase-level closure pattern. Sweep V2.1+V2.2+V2.3+V2.4+V2.5+V2.6 for cumulative findings invisible at per-step.

### V2 backlog (carryforward from V1 + V2.1 + V2.2 + V2.3 + V2.4 + V2.5)

- Structured `Error.code` discrimination via napi `Error::with_code` + `TransportError::kind()` accessor. V2.4 deferred again; pressing for V2.7 multi-window UX.
- `#[napi(strict)]` sweep for type-confusion safety (Opus V2.1 LOW-1).
- `#[must_use]` on `attach_transport<T>` (Opus V2.1 M1; ~80 call site sweep).
- `willFlushSend()` helper to match `flushDeltaToTransport`'s idempotency guard (Opus V2.2 M3).
- `LoopbackTransport.close()` binding for negative-path tests (Opus V2.1 LOW-5).
- Codex V2.3 LOW-2: HandshakeFailed test fixture (local HTTP server rejecting WS upgrade).
- Rule 4 extension to FFI behavior claims (Opus V2.3 M5).
- RwLock for pure-read methods if profiling shows contention (Opus V2.4 M7).
- Document parking_lot's no-poison + CoreCollabSession panic safety (Opus V2.4 M5).
- Document spawn_blocking pool budget interaction with WebSocketTransport reader/writer tasks (Opus V2.4 M4).
- **Gate `BlockingTransportFixture` napi class behind a `ql-bindings-node`-side feature** (V2.5 Codex M1 + Opus L2 convergent). Today the engine-side `test-fixtures` feature gates the underlying `BlockingTransport` + `BlockingAckHandle`, but the binding crate enables it unconditionally so the napi wrapper ships in every cdylib. V2.5 closure rejected `blockMs == 0` at the napi boundary as defense-in-depth, but the fixture's mere presence is still a per-session bounded DoS surface. Future production-cdylib hardening: feature-gate the entire `BlockingTransportFixture` napi class + update CI to build with `--features test-fixtures` for mocha, plain build for production.
- **Rename test for honesty** (V2.5 Codex L2 / Opus L2): `ack_handle_survives_transport_drop_terminates` (renamed from `..._returns_closed` in V2.5 closure) accepts both Ok and Err; if precision is needed, build a fixture that times Drop relative to wait entry (probably belongs in the new V2.6-era `BlockingTransport` family of fixtures).

## Acceptance criteria for V2 SHIP this session — MET

- [x] Engine workspace baseline 4461 / 0 (V2.x closure cycles don't touch ql-collab core).
- [x] `ql-bindings-node` Rust unit tests pass.
- [x] IDE quantbook mocha 72 / 72 (was 26 at V1 close).
- [x] fmt + clippy clean on both repos.
- [x] No new TS compile errors.
- [x] Engine `.dylib` rebuilds and loads.
- [x] All audit HIGHs closed in cycle (V2.1, V2.2, V2.4 cycles; V2.3 HIGHs closed via REMOVE; V2.4 closed via refactor).
- [x] `.plans/_active.md` updated through V2.4 + V2.5 plan.
- [x] `memory/current_work.md` updated with V2.4 HEAD + V2 progress narrative.
- [x] All 9 audit transcripts tracked in `docs/audits/` (5 V1 + 4 V2.x Codex + 4 V2.x Opus).
- [ ] Plan archive: defer until V2 fully ships (V2.8 megaudit + V2 exit packet land in V2.5+).

## V2 commit ladder (cumulative)

Engine `feat/quantbook-engine`:
- V1: 677ee03ee8b → 6003db4ce2c → c47bc0816b5 → c7406aa82cd → 89dd5f0d170
- V2.1: c4e7b471142 → 39ed260bec9
- V2.2: d9b4168022d → d33876f7745
- V2.3: 1e2354cb7b1 → ea07bc6af4e
- V2.4: c51df9f41f4 → 7123c6a57bb (current HEAD pre-docs-finalize)

IDE `feat/visualise-v1`:
- V1: 1a7fc8bbe3f → a517d7c5f71 → 97e0513d134
- V2.1: 1f142366839 → 9da8d5df060
- V2.2: b245c5b9fa8 → 3871c8ce055
- V2.3: 6616e28a2a3 → 233957ab140
- V2.4: 3ab02bbe732 → 8f0a44e19e9 (current HEAD)
