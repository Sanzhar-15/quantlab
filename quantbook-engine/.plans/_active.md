---
name: 2026-05-22_phase-5-7-v2-transport-binding
status: in-progress
date: 2026-05-22
predecessor_commit: 89dd5f0d170 (engine: docs(5.7) finalize V2 — exit packet + MASTER-PLAN backfill)
ide_predecessor_commit: 97e0513d134 (IDE: Phase 5.7 V1 megaudit closures)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V2 — Transport binding (extends V1's CollabSession-only surface)
canonical_v2_design_reference: docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md
arc_estimate: 3-5 days total. THIS session: V2.1 + V2.2 (sync surface). Next session: V2.3+ (async / WebSocket / megaudit).
session_cycles_budget: 2 cycles this session per CLAUDE.md global rule.
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

## V2.1 — Loopback foundations + core attach/flush/poll (Cycle 1, ~half-day)

**Engine work**:

- [ ] **`ql-collab` Rust**: add `CollabSession::attach_transport_boxed(&mut self, Box<dyn Transport + Send>) -> Option<Box<dyn Transport + Send>>` sibling to the generic `attach_transport<T>`. Same semantics, takes a boxed trait object instead. Rust-side test verifying equivalence.
- [ ] **`ql-bindings-node`**: add napi `Transport` opaque class wrapping `Option<Box<dyn CoreTransport + Send>>`.
  - Static factory `Transport.loopbackPair() -> [Transport, Transport]` (returns a 2-element JS array)
  - Internal method `take_inner()` (Rust-only, not napi) for extraction during attach.
- [ ] **`ql-bindings-node`**: extend `CollabSession` napi class with:
  - `attachTransport(transport: Transport): void` — moves Box out of the Transport wrapper, calls `attach_transport_boxed`. Subsequent calls on the same wrapper error.
  - `detachTransport(): boolean` — drops the returned `Option<Box<dyn Transport>>` Rust-side (no JS round-trip for the box). Returns true if a transport was attached.
  - `hasTransport(): boolean`
  - `flushToTransport(): boolean` — sync; returns `true` if bytes were sent.
  - `pollRemote(): u32` — sync; returns merged-op count clamped to u32::MAX.

**IDE work**:

- [ ] Extend `types.ts` with napi Transport class shape + new CollabSession methods.
- [ ] Extend `session.ts` with `loopbackTransportPair()` helper + transport-aware wrappers.
- [ ] Add 8-10 mocha tests covering two-peer Loopback round-trip via `flushToTransport` / `pollRemote`.

**Audit obligations**:

- [ ] Rust unit tests for `attach_transport_boxed` (equivalence + transport replacement).
- [ ] Engine-side: sweep `attach_transport_boxed` + each new napi method for FFI-reachable panics.
- [ ] Parallel Codex + Opus audit before closure.

## V2.2 — Full sync transport surface (Cycle 2, ~half-day)

**Engine work**:

- [ ] `flushDeltaToTransport(): boolean` — V2 V3 step 1's delta path; the production default.
- [ ] `pollRemoteWithLimit(limit: f64): u32` — limit takes `f64` for ToUint32 hygiene.
- [ ] `transportLastError(): string | null` — `None` → `null`.
- [ ] AutoFlushPolicy enum binding:
  - Decide JS shape: simplest is string union (`'disabled' | 'onAppend'`) since the enum has no payload.
  - `setAutoFlushPolicy(policy: string): string` — returns prior policy.
  - `autoFlushPolicy(): string`.

**IDE work**:

- [ ] Wrap new methods in `session.ts`.
- [ ] Tests:
  - Delta vs full-snapshot flush semantics.
  - `pollRemoteWithLimit` boundary cases (0 limit, > available).
  - AutoFlushPolicy round-trip + onAppend integration test (two-peer auto-sync).
  - `transportLastError` after a detach (expect `null`).

**Audit obligations**:

- [ ] Parallel Codex + Opus audit.
- [ ] If the audit surfaces a NEW Rule 4 hazard (precedent: V1 had 3 such), close it before commit.

## V2.3+ — DEFERRED to next session

These need a fresh window per CLAUDE.md ">2 cycles per session" + benefit from clean context:

- V2.3: WebSocketTransport `Transport.websocketConnect(url)` async (napi `AsyncTask` or `#[napi(async)]`)
- V2.4: `flushPendingToTransport()` async (Condvar wait wrapped in `#[napi(async)]`)
- V2.5: Multi-window IDE demo (extend `quantlab.quantbookDemo` command)
- V2.6: Tiny WS echo-fanout server (~50 lines in a sibling test crate) for local 2-peer testing
- V2.7: 3-way megaudit + V2 exit packet

## Acceptance criteria for V2 SHIP this session (V2.1 + V2.2)

- [ ] Engine `cargo test --workspace --all-features` passes (target: 4461+ / 0)
- [ ] `ql-bindings-node` Rust unit tests pass
- [ ] IDE quantbook mocha tests pass (target: 26 + V2 additions, all green)
- [ ] fmt + clippy clean on both repos
- [ ] No new TS compile errors
- [ ] Engine `.dylib` rebuilds and loads in Node
- [ ] All audit HIGHs closed in cycle
- [ ] `.plans/_active.md` updated to reflect what shipped vs deferred for V2.3+
- [ ] `memory/current_work.md` updated with new HEAD + V2 progress narrative
- [ ] Plan archived if both V2.1 + V2.2 ship; otherwise updated for V2.3+ continuation

## Hand-off if session caps out before V2.2 closes

- Commit V2.1 ship + closure cleanly
- Update plan to mark V2.1 done + V2.2 still pending
- current_work.md handoff §0 updated with the V2.1 commit ladder
- Next session picks up V2.2 from a clean state
