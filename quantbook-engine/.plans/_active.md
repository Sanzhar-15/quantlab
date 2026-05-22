---
name: 2026-05-22_phase-5-7-v2-transport-binding
status: in-progress (V2.1 + V2.2 + V2.3 + V2.4 SHIPPED; V2.5+ pending next session)
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

## V2.5+ — DEFERRED to next session

These need a fresh window per CLAUDE.md ">2 cycles per session":

### V2.5 — Engine refactor for V8-block hazard (Opus V2.4 HIGH-1)

Pick ONE of:
- (a) Clone `Arc<Transport>` inside the session lock, release lock, wait on the cloned transport directly. Requires engine refactor to make Transport extractable.
- (b) Replace Condvar with `tokio::sync::Notify` in `flush_pending`. Truly async; no lock held across wait. Requires engine API change.

Recommend (b) — cleaner long-term. V2.5 audit will verify the V8-block test (test-only blocking transport fixture) actually passes after the refactor.

### V2.6 — Test-only blocking transport fixture

For real contention/V8-block test coverage. Engine-side trait impl that returns Pending forever (or for a configured delay). Closes Codex V2.3 LOW-2 + Opus V2.4 MEDIUM-1+2 (V2.4 soundness tests were vacuous on Loopback).

### V2.7 — Multi-window IDE demo

Extend `quantlab.quantbookDemo` command to spawn a second VS Code window via the `vscode.openFolder` API + a localhost WebSocket relay. The current command does in-process LoopbackPair; V2.7 does two separate extension hosts.

### V2.8 — 3-way Codex+Opus-A+Opus-B megaudit + V2 exit packet

Phase-level closure pattern. Sweep V2.1+V2.2+V2.3+V2.4+V2.5+V2.6 for cumulative findings invisible at per-step.

### V2 backlog (carryforward from V1 + V2.1 + V2.2 + V2.3 + V2.4)

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
