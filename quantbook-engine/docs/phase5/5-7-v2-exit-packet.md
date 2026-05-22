---
title: Phase 5.7 V2 exit packet (Transport binding)
date: 2026-05-22
status: ACTIVE -- Phase 5.7 V2 SHIPPED across V2.1 through V2.7 + AUDITED + V2.8 megaudit complete
ship_commit_range_engine: |
  V2.1: c4e7b471142 (ship) -> 39ed260bec9 (closure)
  V2.2: d9b4168022d (ship) -> d33876f7745 (closure)
  V2.3: 1e2354cb7b1 (ship) -> ea07bc6af4e (closure)
  V2.4: c51df9f41f4 (ship) -> 7123c6a57bb (closure)
  docs-finalize-v2: 9eece27cf77
  V2.5+V2.6: 1b233af6150 (ship) -> 81c66d02f9f (closure)
  V2.7: 2a3e2ebcbfe (ship) -> 8f5b2e02ab7 (closure)
  docs-finalize-v3: 4ea690ce246
  V2.8 megaudit code closures: 6917e36d846
ship_commit_range_ide: |
  V2.1: 1f142366839 -> 9da8d5df060
  V2.2: b245c5b9fa8 -> 3871c8ce055
  V2.3: 6616e28a2a3 -> 233957ab140
  V2.4: 3ab02bbe732 -> 8f0a44e19e9
  V2.5+V2.6: c5997998741 -> 8798349be6d
  V2.7: 2a5619f9162 -> f9f98194958
  V2.8 megaudit code closures: 07bb0043dc4
predecessor_exit_packet: docs/phase5/5-7-v1-exit-packet.md (V1 -- the architectural-decisions packet)
v2_design_reference: docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md (the V2-readiness lane from V1 megaudit; canonical V2 design source)
audit_cycle_total_v2: |
  V2.1 ship + closure
  V2.2 ship + closure
  V2.3 ship + closure (Codex FAIL -> flushPendingToTransport REMOVED)
  V2.4 ship + closure (Arc<Mutex> refactor + flushPendingToTransport REINTRODUCED)
  V2.5+V2.6 ship + closure (V8-block CLOSURE via Transport::ack_handle + BlockingTransportFixture)
  V2.7 ship + closure (structured Error.code discrimination)
  V2.8 phase termination megaudit (3-way Codex+Opus-A+Opus-B) + code closures
  = 7 ship+closure cycles + V2.8 megaudit = 8 cycles total
audit_transcripts_inventory_v2: |
  21 total in docs/audits/2026-05-22-phase-5-7-* (3 of these are the V2.8 megaudit lanes):
  - V2.1: v2-1-codex.md, v2-1-opus.md
  - V2.2: v2-2-codex.md, v2-2-opus.md
  - V2.3: v2-3-codex.md, v2-3-opus.md
  - V2.4: v2-4-codex.md, v2-4-opus.md
  - V2.5+V2.6: v2-5-plan-review-codex.md, v2-5-codex.md, v2-5-opus.md
  - V2.7: v2-7-codex.md, v2-7-opus.md
  - V2.8 megaudit: v2-megaudit-codex.md, v2-megaudit-opus-a-docs.md, v2-megaudit-opus-b-v3.md
test_counts_at_v2_exit: |
  Engine workspace: 4472 / 0 baseline (verified at V2.5 ship gate; V2.7 and V2.8 do not touch ql-collab core)
  ql-collab --features test-fixtures: 74 / 74
  ql-collab-ws: 10 / 10 (was 4 at V2.7 closure; +6 V2.8 scrub_url_credentials_in unit tests)
  ql-bindings-node Rust lib tests: 3 / 3
  IDE quantbook mocha: 95 / 95 (was 91 at V2.7 closure; +4 V2.8 parseQuantbookError Error.cause walk tests; the V2.6 "stale binary missing fixture" test was re-purposed as V2.8 fixture-optional contract test, net +4)
v2_rule_4_arc_count: 6 cumulative triggers (3 from V1, 1 each at V2.3 / V2.4 / V2.5; V2.7 zero; V2.8 zero new triggers in Lane C per-field walks)
phase_5_8_readiness: |
  UNBLOCKED -- V2.8 megaudit closed the production-cdylib leak HIGH (cfg-gate
  BlockingTransportFixture). Phase 5.8 megaudit can now run against the
  complete Phase 5 surface, OR V3 product work can start (multi-window IDE
  demo + cell-grid UI + rebuild_workbook wiring + persistence).
---

# Phase 5.7 V2 -- Transport Binding Exit Packet

## Summary

Phase 5.7 V2 binds the full Transport surface to JS. V1 shipped the `CollabSession` round-trip (a single-peer minimum); V2 makes the IDE **multi-peer capable** by exposing `LoopbackTransport`, `WebSocketTransport`, attach/flush/poll, AutoFlushPolicy, async drain, V8-block-free spawn_blocking patterns, and structured error-code discrimination.

V2 took **7 ship+closure cycles** across one calendar day (2026-05-22), plus the V2.8 phase-termination megaudit. The arc was driven from the V1 megaudit's V2-readiness lane (`docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md`) -- that document analyzed 8 V2 hazards in advance, and V2.1 through V2.7 closed them in order.

### Highlights

- **V2.3 audit FAIL is in the canon.** Codex flagged Rust UB via napi `&mut self` async re-entry; `flushPendingToTransport` was REMOVED in the V2.3 closure commit. V2.4 reintroduced it sound, wrapped in `Arc<parking_lot::Mutex<CoreCollabSession>>`.
- **V8-block closure (V2.5).** The V2.4 reintroduction held the mutex across `spawn_blocking` Condvar waits, freezing the V8 event loop on concurrent JS calls. V2.5 added `Transport::ack_handle()` so the binding can extract a Send+Sync handle under a brief lock, drop the guard, and wait inside `spawn_blocking` with no aliased state.
- **Structured Error.code (V2.7).** Engine error variants now expose `kind() -> &'static str`; the napi binding prepends `[<kind>]` to Display; the IDE parses + dispatches via `parseQuantbookError` and a 12-code `QuantbookErrorCode` union.
- **V2.8 megaudit caught a HIGH invisible at per-step level.** Three parallel lanes (Codex protocol + Opus-A docs + Opus-B adversarial) ran against the cumulative V2.1-V2.7 surface. Lane C escalated the production-cdylib `BlockingTransportFixture` leak from V2.5-LOW to required-pre-V3, and the V2.8 closure cfg-gates it behind a binding-side `test-fixtures` Cargo feature.

### What V2 deliberately did NOT do

V2 stays within the Transport binding surface. Out of scope (kept for V3+):

- Multi-window IDE demo (`quantlab.quantbookDemo` spawning a second VS Code window via `vscode.openFolder` + localhost ws relay)
- Cell-grid UI (real grid widget bound to `CollabSession` snapshots)
- `rebuild_workbook` wiring (Phase 5.3 production visibility)
- `.qbook` persistence import/export
- Undo/redo (UndoGroupGuard RAII translation)
- Presence (PresenceState shape + sweep_presence)
- Full Op enum (beyond `PutValue`)
- `@napi-rs/cli` publish pipeline

These continue to live in V3+ scope per `docs/phase5/5-7-v1-exit-packet.md` "V1 deferred to V2/V3" table.

## V2 commit ladder (cumulative)

Engine `feat/quantbook-engine`:

| Cycle | Ship | Closure |
|---|---|---|
| V1 (Phase 5.7 V1 + megaudit) | `677ee03ee8b` -> `6003db4ce2c` -> `c47bc0816b5` -> `c7406aa82cd` | -- |
| V1 docs finalize | `89dd5f0d170` | -- |
| V2.1 | `c4e7b471142` | `39ed260bec9` |
| V2.2 | `d9b4168022d` | `d33876f7745` |
| V2.3 | `1e2354cb7b1` | `ea07bc6af4e` |
| V2.4 | `c51df9f41f4` | `7123c6a57bb` |
| V2 docs finalize v2 | `9eece27cf77` | -- |
| V2.5 + V2.6 (combined) | `1b233af6150` | `81c66d02f9f` |
| V2.7 | `2a3e2ebcbfe` | `8f5b2e02ab7` |
| V2 docs finalize v3 | `4ea690ce246` | -- |
| **V2.8 megaudit code closures** | **`6917e36d846`** | -- |

IDE `feat/visualise-v1`:

| Cycle | Ship | Closure |
|---|---|---|
| V1 (Phase 5.7 V1 + megaudit) | `1a7fc8bbe3f` -> `a517d7c5f71` -> `97e0513d134` | -- |
| V2.1 | `1f142366839` | `9da8d5df060` |
| V2.2 | `b245c5b9fa8` | `3871c8ce055` |
| V2.3 | `6616e28a2a3` | `233957ab140` |
| V2.4 | `3ab02bbe732` | `8f0a44e19e9` |
| V2.5 + V2.6 (combined) | `c5997998741` | `8798349be6d` |
| V2.7 | `2a5619f9162` | `f9f98194958` |
| **V2.8 megaudit code closures** | **`07bb0043dc4`** | -- |

## V2 API surface shipped

### Engine `ql-bindings-node` (napi exports added since V1)

```typescript
// Opaque wrapper for an attachable Transport. Single-use.
class Transport {
    isAttachable(): boolean;
    // V2.3 static async factory
    static websocketConnect(url: string): Promise<Transport>;
}

// V2.1 -- paired loopback transport factory
class LoopbackPair {
    constructor();
    takeA(): Transport;
    takeB(): Transport;
}

// V2.6 -- contention test fixture (gated behind cargo `test-fixtures` feature
// from V2.8 onward; production cdylib does NOT expose this class)
class BlockingTransportFixture {
    constructor(blockMs: number);  // [1, u32::MAX]
    takeTransport(): Transport;
    release(): void;
    waitUntilBlocked(): Promise<void>;
}

// CollabSession additions
class CollabSession {
    // V2.1 sync surface
    attachTransport(transport: Transport): void;
    detachTransport(): boolean;
    hasTransport(): boolean;
    flushToTransport(): boolean;       // V2.1 full-state flush
    pollRemote(): number;               // BLOB count, not op count
    // V2.2 sync surface
    flushDeltaToTransport(): boolean;
    pollRemoteWithLimit(limit: number): number;
    transportLastError(): string | null;
    setAutoFlushPolicy(policy: AutoFlushPolicy): AutoFlushPolicy;
    autoFlushPolicy(): AutoFlushPolicy;
    // V2.4 async surface (V2.5 V8-block-free)
    flushPendingToTransport(): Promise<void>;
}
```

### IDE consumer surface (`extensions/quantlab/src/quantbook/`)

- `session.ts`: TS wrapper helpers + `parseQuantbookError` (V2.7 + V2.8 cause-walk) + `QuantbookErrorCode` (12-code union) + `KNOWN_QUANTBOOK_ERROR_CODES` (parser, no `'unknown'`) + `ALL_QUANTBOOK_ERROR_CODES` (type guard, includes `'unknown'`) + `isQuantbookErrorCode` type guard + `isAutoFlushPolicy` type guard.
- `types.ts`: full TS surface mirror. V2.8: `BlockingTransportFixture` is OPTIONAL (`?:`) on `QuantbookNativeModule`.
- `loader.ts`: V2.8 no longer requires `BlockingTransportFixture` -- production cdylib without `test-fixtures` loads OK.
- `test/quantbook-roundtrip.test.ts::requireBlockingTransportFixture(engine)`: helper that throws a "rebuild with `--features test-fixtures`" message when mocha needs the fixture.

### Structured error-code contract (V2.7 + V2.8 cause-walk)

| Variant | Kind |
|---|---|
| `TransportError::Io(_)` | `"transport_io"` |
| `TransportError::Closed` | `"transport_closed"` |
| `WebSocketError::InvalidUrl(_)` | `"websocket_invalid_url"` (credentials scrubbed via `scrub_url_credentials_in` -- V2.8 closure) |
| `WebSocketError::ConnectFailed(_)` | `"websocket_connect_failed"` |
| `WebSocketError::HandshakeFailed(_)` | `"websocket_handshake_failed"` |
| `WebSocketError::RuntimeError(_)` | `"websocket_runtime_error"` (structurally defined; not currently emitted via napi rejection paths -- see V3 backlog) |
| `CollabSessionError::OpLog(_)` | `"session_oplog"` |
| `CollabSessionError::Presence(_)` | `"session_presence"` |
| `CollabSessionError::Undo(_)` | `"session_undo"` |
| `CollabSessionError::Replay(_)` | `"session_replay"` |
| `CollabSessionError::Transport(inner)` | `inner.kind()` (passthrough; e.g. `"transport_closed"`) |
| napi binding validation guards | `"bad_argument"` (V2.7 closure; 14 retrofit sites) |
| Parser fallback | `"unknown"` |

`parseQuantbookError(err)` walks `Error.cause` up to depth 8 with a Set-based self-cycle guard (V2.8 Lane C MEDIUM-4 closure) so napi `spawn_blocking` task-panic wrappers route to the engine's structured code via `err.cause.cause...`.

## Architectural decisions locked at V2

### Decision 1: `attach_transport_boxed` sibling for napi-rs (V2.1)

napi-rs cannot bind Rust generics. The engine's `CollabSession::attach_transport<T: Transport + Send>(t: T)` was supplemented with a sibling `attach_transport_boxed(&mut self, Box<dyn Transport + Send>)` so the binding can hand the boxed trait object across the FFI boundary. The generic version stays for direct Rust callers.

### Decision 2: `LoopbackPair` over `Transport.loopbackPair()` factory (V2.1)

napi-rs's `#[napi(factory)]` requires a single-Self return type; `Vec<Transport>` doesn't satisfy `ObjectFinalize`. V2.1 introduced an intermediate `LoopbackPair` napi class with single-use `takeA()` / `takeB()`. Also cleaner UX for the rare "delayed take" use case.

### Decision 3: `pollRemote` returns BLOB count, not op count (V2.1)

`pollRemote()` returns the number of blobs received (V1 engine docstring); V2.2's `pollRemoteWithLimit(limit)` caps blobs, not ops. IDE types.ts + JSDoc encode this. A `pollRemoteOps()` companion may be added later if a use case materializes.

### Decision 4: `AutoFlushPolicy` is `#[non_exhaustive]` and the JS surface throws on unknown engine variants (V2.2 + V2.7 closures)

The engine enum is `#[non_exhaustive]`. The V2.2 napi `autoFlushPolicy()` initially returned `"unknown"` as a forward-compat sentinel, but V2.2 Opus HIGH-1 closure replaced that with a fail-loud `[bad_argument]` throw (no silent sentinel fall-through). V2.7 reinforced this with the `bad_argument_error` helper.

### Decision 5: V2.3 `flushPendingToTransport` async path REQUIRES Arc<Mutex> ownership (V2.3 audit FAIL + V2.4 closure)

V2.3 originally bound `flushPendingToTransport` against a `&mut self` async method, which created a Rust UB hazard via napi's async re-entry pattern (a second JS call to the same session could re-enter the lock while the first await was suspended). Codex FAILed V2.3; the closure REMOVED `flushPendingToTransport`. V2.4 wrapped the session in `Arc<parking_lot::Mutex<CoreCollabSession>>` and reintroduced it sound. The Send+Sync composition is positive-asserted (lib.rs `_ASSERT_BINDING_COLLAB_SESSION_SEND`).

### Decision 6: V2.5 ack-handle pattern for V8-non-blocking flush (V2.5 closure)

V2.4's `flushPendingToTransport` held the mutex across `spawn_blocking` Condvar waits, freezing V8 on concurrent sync calls. V2.5 added `Transport::ack_handle() -> Option<Box<dyn FlushAck + Send>>`. The binding extracts the handle under a brief lock, drops the guard, then waits on the handle's Arc-cloned progress state inside `spawn_blocking`. The handle owns no reference to the session mutex; concurrent JS sync methods acquire the lock immediately while the wait runs.

`FlushAck: Send` supertrait only (no `Sync`). The shipped impls (`WebSocketProgressAckHandle` + `BlockingAckHandle`) ARE Send+Sync; both are compile-asserted via `static_assertions::assert_impl_all!`.

### Decision 7: `BlockingTransportFixture` is feature-gated (V2.6 design + V2.8 closure)

V2.6 added `BlockingTransport` + `BlockingAckHandle` on `ql-collab` behind a `test-fixtures` Cargo feature. V2.6 originally enabled that feature unconditionally on `ql-bindings-node` -- a deliberate tradeoff documented as "post-V2 product hardening" backlog. V2.8 closed the backlog: a binding-side `test-fixtures` feature now gates the entire fixture surface. Production cdylib builds do not carry it. Mocha + contention tests rebuild with `--features test-fixtures`.

### Decision 8: Structured `Error.code` discrimination via `[kind]` prefix (V2.7)

Engine error variants expose `kind() -> &'static str`. The napi binding's three `{collab_session,transport,websocket}_error_to_napi` helpers prepend `[<kind>]` to Display; a fourth helper `bad_argument_error(msg)` prepends `[bad_argument]` to validation-error messages. The IDE `parseQuantbookError` extracts the prefix and maps to a 12-code `QuantbookErrorCode` union. V2.3+ Display strings stay intact AFTER the prefix so substring tests like `/invalid WebSocket URL/` continue to pass.

The exhaustive `match` in each `kind()` impl (no `_` catch-all) provides a compile-time SemVer guard: adding a new variant without a matching arm fails the build (V2.7 backlog Opus L2 already satisfied; identified by Codex Q7 at V2.8 megaudit).

### Decision 9: Credential-scrubbed `WebSocketError::InvalidUrl` (V2.8 closure)

The free-fn `scrub_url_credentials_in(text: &str) -> String` rewrites `scheme://userinfo@` patterns to `scheme://[REDACTED]@`. Applied at the single `WebSocketTransport::connect()` error-construction site so credentials in URLs (e.g. `ws://user:pass@host`) never surface in IDE error toasts, logs, or `transportLastError()` output.

## V2.8 megaudit verdicts (cumulative)

Three parallel lanes ran against the cumulative V2.1-V2.7 surface (engine HEAD `4ea690ce246` + IDE HEAD `f9f98194958`).

### Lane A -- Codex protocol/correctness

**Verdict**: PASS-WITH-FINDINGS (0 HIGH, 2 MEDIUM, 3 LOW).

| Question | Verdict |
|---|---|
| Q1 -- `kind()` propagation completeness | PASS-WITH-FINDINGS |
| Q2 -- `pollRemote` BLOB-vs-op semantics | PASS |
| Q3 -- AutoFlushPolicy round-trip + `bad_argument` | PASS-WITH-FINDINGS |
| Q4 -- V2.4 Arc<Mutex> contracts | PASS |
| Q5 -- V2.5 `ack_handle` Send invariants | PASS-WITH-FINDINGS |
| Q6 -- `BlockingTransportFixture` production-cdylib gating | PASS-WITH-FINDINGS (-> closed in V2.8 via cfg-gate) |
| Q7 -- kind string <-> `QuantbookErrorCode` union completeness | PASS |

### Lane B -- Opus-A docs / exit-readiness

**Verdict**: PASS-WITH-FINDINGS (5 HIGH, 8 MEDIUM, 10 LOW; all DOC fixes -- closed in the docs-finalize-v4 sweep this commit).

Highlights:
- Stale "Codex transcript pending docs-finalize" markers across `_active.md`, `MASTER-PLAN.md`, `5-7-v1-exit-packet.md`.
- `MASTER-PLAN.md` mis-stated the V2.5 audit HIGH count (claimed 2; actual 0).
- Cycle numbering fractured across 4 docs (V2.7 labeled as cycle 4 / cycle 6 / cycle 7).
- `docs/architecture/ide-consumer-contract.md` in future tense ("V2 will bind Transport").
- `current_work.md` frontmatter said "12 audit transcripts"; actual was 18.

### Lane C -- Opus-B adversarial / V3 entry-readiness

**Verdict**: PASS-WITH-FINDINGS (1 HIGH, 4 MEDIUM, 4 LOW). 0 new Rule 4 triggers in per-field walks of `Transport`, `FlushAck`, `BlockingTransport`, `BlockingTransportFixture`, `LoopbackPair`, error enums, `Arc<Mutex<CollabSession>>`.

| Finding | Closure |
|---|---|
| HIGH-1: `BlockingTransportFixture` ships in every production cdylib (DoS surface: u32::MAX ms blocking-pool park) | Closed V2.8 -- cfg-gate behind binding-side `test-fixtures` feature |
| MEDIUM-1: `WebSocketError::InvalidUrl` Display leaks URL-embedded credentials | Closed V2.8 -- `scrub_url_credentials_in` helper |
| MEDIUM-2: Rule 4 silence on `Transport` napi wrapper + `LoopbackPair` Send-only asserts | Closed V2.8 -- positive Sync compile asserts for `LoopbackPair` + `BlockingTransportFixture`; explicit comment documents why `Transport` stays Send-only |
| MEDIUM-3: `KNOWN_QUANTBOOK_ERROR_CODES` not codegen'd from `QuantbookErrorCode` union | Closed V2.9 (post-V2-phase hardening) -- IDE `58f607fe1d0`. `Record<Exclude<QuantbookErrorCode, 'unknown'>, true>` compile-time enforcement: adding a code to the union without adding it to the record fails TS compile. Runtime Set derived via `Object.keys`. |
| MEDIUM-4: `parseQuantbookError` doesn't walk `Error.cause` chain | Closed V2.8 -- depth-8 walker with self-cycle guard |

## Rule 4 arc log (audit-discipline rule 4)

Rule 4: negative trait claims (`!Send` / `!Sync` / `!Unpin`) need positive compile proof OR per-field walk. Phase 5.7 cumulative arc (V1 through V2.8):

| # | When | Trigger | Result |
|---|---|---|---|
| 1 | V1 smoke | `PeerId(0)` panic via `assert_ne!` | Pre-rejected at FFI helper |
| 2 | V1 closure | `catch_unwind` + Send/Sync rationale claim | False; verified via napi-rs source walks; docstring updated |
| 3 | V1 megaudit | False `PeerId::new` sentinel claim | Docstring + correct attribution |
| 4 | V2.3 audit | False napi-rs `Reference<T>` exclusivity claim | Method REMOVED -> V2.4 refactor |
| 5 | V2.4 audit | Stale `Send + !Sync` docstring after `Send + Sync` refactor | Docstring updated + positive Sync asserts |
| 6 | V2.5 audit | False `FlushAck: Send + !Sync` claim while impls were Send + Sync | Docstring updated + positive Sync asserts |
| -- | V2.7 audit | (no negative-trait claims to attack) | 0 triggers |
| -- | V2.8 megaudit Lane C | Per-field walks on Transport, FlushAck, BlockingTransport, LoopbackPair, error enums | 0 new triggers |

**Arc terminus: 6.** The Rule 4 audit discipline is now mature; V3 inherits the same convention.

## V2 backlog explicitly carried to V3

These were identified in V2 audit transcripts but deferred to V3 product scope:

1. **Multi-window IDE demo** (`quantlab.quantbookDemo` spawning a second VS Code window via `vscode.openFolder` + localhost ws relay). V2.7+ design ready; defer to V3 as a product surface.
2. **Production-cdylib hardening of `BlockingTransport` symbols** (Lane C HIGH-1 *partial closure*). V2.8 cfg-gates `BlockingTransportFixture`; the underlying `ql_collab::BlockingTransport` symbols are also `#[cfg(feature = "test-fixtures")]`-gated already. Production builds are now clean.
3. **Structured `transportLastErrorInfo()` accessor** (V2.7 closure + Lane A LOW-3). Today `transportLastError()` returns a raw `Option<String>` with no kind prefix; the engine has the kind but the napi accessor maps `WebSocketError -> e.to_string()`. Adding a structured accessor would make `websocket_runtime_error` reachable via `parseQuantbookError`. Defer until a V3 caller needs it.
4. **`KNOWN_QUANTBOOK_ERROR_CODES` codegen** (Lane C MEDIUM-3). **CLOSED at V2.9** (IDE `58f607fe1d0`) via `Record<Exclude<QuantbookErrorCode, 'unknown'>, true>` compile-time enforcement -- adding a code to the union without adding a key to the Record fails TS compile, and the runtime Set is derived from `Object.keys`. No longer in V3 backlog.
5. **`willFlushSend` helper** (V2 backlog from prior cycle).
6. **`LoopbackTransport.close`** (V2 backlog from prior cycle).
7. **`HandshakeFailed` fixture** (V2 backlog from prior cycle).
8. **`CollabSessionError::Transport(_)` origin tracking** (V2.7 Opus M3). Today documented as intentional passthrough; V3 may want explicit origin if multi-window WS reconnect needs richer context.
9. **`@napi-rs/cli` publish pipeline** (V1 backlog still open).
10. **Production-build error-paths sweep** (V2 backlog from prior cycle): every code path that emits a raw `Error::from_reason(...)` should route through a kind-stamped helper. V2.7 closed 14 of these via `bad_argument_error`; sweep the remainder in V3.

## V2.9 post-phase-termination hardening (2026-05-22)

Between V2.8 phase termination + V3 entry, one Lane C finding turned out to need lighter remediation than the megaudit suggested:

**Lane C MEDIUM-3 (KNOWN_QUANTBOOK_ERROR_CODES manual-sync drift)**. The audit framed this as "codegen" -- file-generation infra. The actual remediation was a TS type trick: `Record<Exclude<QuantbookErrorCode, 'unknown'>, true>` enforces at COMPILE TIME that the runtime Set matches the union (every key required by the type system, runtime Set derived via `Object.keys`). No codegen tool, no file generator -- just structural typing. IDE commit `58f607fe1d0` ships it + a round-trip mocha test that exercises all 11 emittable codes.

V2.9 is the only post-V2.8 V2-scoped commit; the rest of the post-V2.8 work is V3-phase. V2.9 is conceptually "V2 polish" that landed during V3 entry because Opus V3.1.e Lane C re-flagged it as required-pre-V3.

## V2 backlog item RETIRED at V2.8

- **V2.7 Opus L2 -- compile-time guard for SemVer-stable kind strings.** Codex Q7 verified the existing exhaustive `match` in each `kind()` impl (no `_` catch-all) already provides this guarantee. Adding a new error variant without a matching arm fails to compile.

## Verification at V2 exit (post-V2.8 megaudit + code closures)

- **Engine workspace tests**: 4472 / 0 baseline (verified at V2.5 ship gate; V2.7 and V2.8 do not touch ql-collab core)
- **ql-collab `--features test-fixtures`**: 74 / 74
- **ql-collab-ws**: 10 / 10 (was 4 at V2.7 closure; +6 V2.8 `scrub_url_credentials_in` unit tests)
- **ql-bindings-node Rust lib tests**: 3 / 3
- **IDE quantbook mocha**: 95 / 95 (was 91 at V2.7 closure; +4 V2.8 cause-walk closure tests; V2.6 "stale binary missing fixture" test re-purposed as V2.8 fixture-optional contract test, net +4)
- **fmt + clippy**: clean on both repos
- **Production-cdylib symbol audit**: `strings target/release/libql_bindings_node.dylib | grep BlockingTransportFixture` returns no matches when built without `--features test-fixtures` (verified at V2.8 closure)
- **VS Code interactive smoke**: multi-window demo deferred to V3 -- text-mode contract tests + IDE mocha cover the full Transport surface
- **Audit transcripts tracked**: 21 in `docs/audits/2026-05-22-phase-5-7-*` (5 V1 + 13 V2.1-V2.7 per-step + 3 V2.8 megaudit)

## Build commands (V2.8 update)

```bash
# Production cdylib (no fixture):
cd .../quantbook-engine
cargo build -p ql-bindings-node --release

# Mocha + contention contract test cdylib (with fixture):
cd .../quantbook-engine
cargo build -p ql-bindings-node --release --features test-fixtures

# Engine tests (test-fixtures required for ql-collab fixture tests):
cargo test -p ql-collab --release --features test-fixtures --lib
cargo test -p ql-collab-ws --release --lib

# IDE mocha:
cd .../quantlab/extensions/quantlab
node node_modules/mocha/bin/mocha.js out/test/quantbook-roundtrip.test.js \
    --ui tdd --timeout 30000 \
    --require source-map-support/register \
    --require out/test/helpers/mocha-setup.js
```

## Cross-repo coordination notes for V3

V3 work continues across both repos. V2 conventions held; V3 inherits:

1. **Ship pairs**: every binding surface change has TWO commits, one per repo, referencing each other.
2. **Audit lane parity**: Codex + Opus run in parallel per audit cycle.
3. **Closure commits**: same pattern -- two commits per repo, audit-driven.
4. **Plan files**: live in engine `.plans/_active.md` (engine drives binding surface design). V3's plan should reference this V2 exit packet.
5. **Audit-discipline Rule 4**: arc closes at 6 triggers for V2; V3 inherits the same convention (negative-trait claims need positive compile proof OR per-field walk).
6. **Test-fixture builds**: any new test-only surface in V3 should be `#[cfg(feature = "test-fixtures")]`-gated on the binding crate, NOT just on the engine crate.
7. **Phase-termination megaudit**: V2.8's 3-way pattern (Codex protocol + Opus-A docs + Opus-B adversarial+forward-looking) caught 6 HIGHs and 14 MEDIUMs invisible at per-step level. V3 should plan for the same pattern at its phase boundary.

## Reading order for V3 / next session

1. **`memory/current_work.md`** -- session handoff (entry point).
2. **This V2 exit packet** -- V2 surface + decisions + V3 backlog (load-bearing for V3 scope).
3. **`docs/audits/2026-05-22-phase-5-7-v2-megaudit-opus-b-v3.md`** -- V3-entry readiness section (Lane C's Part 2). Multi-window IDE demo readiness + V3 risks.
4. **`docs/phase5/5-7-v1-exit-packet.md`** -- V1 architectural decisions (still load-bearing).
5. **`docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md`** -- V2 design source. V3 entry can grep this for the V1 megaudit's "V3 hazards" framing (less analyzed than V2 hazards were, but useful pattern).
6. **Engine module docs**: `crates/ql-bindings-node/src/lib.rs` head + per-method docstrings.
7. **IDE module docs**: `extensions/quantlab/src/quantbook/{loader,session,types}.ts`.
8. **V2.8 megaudit transcripts** (already incorporated into closure; read for disagreement or for V3 hazard depth):
   - `docs/audits/2026-05-22-phase-5-7-v2-megaudit-codex.md` -- protocol lane
   - `docs/audits/2026-05-22-phase-5-7-v2-megaudit-opus-a-docs.md` -- docs lane
   - `docs/audits/2026-05-22-phase-5-7-v2-megaudit-opus-b-v3.md` -- adversarial + V3-entry lane

## Phase 5.8 readiness

V2.8 closed the production-cdylib HIGH. Phase 5.8 megaudit can now run against the complete Phase 5 surface:

- Phase 5.1 collaboration data model
- Phase 5.2 `ql-collab` core + D-1 (FormatId)
- Phase 5.3 conflict resolution + `rebuild_workbook`
- Phase 5.4 undo/redo + UndoGroupGuard
- Phase 5.5 V2 V2 + V2 V3 + V2 V4 V1 transport layer
- Phase 5.6 presence + sweep_presence
- Phase 5.7 V1 IDE binding + V2 Transport binding <- this packet

**Recommended ordering**: V3 product work (multi-window IDE demo + cell-grid UI + persistence + rebuild_workbook wiring) FIRST, then Phase 5.8 megaudit. Rationale:

- V2 binding alone is still a thin surface from the user's perspective -- no visible product yet.
- V3 lands the actual user-facing surface that exercises V1+V2 in anger.
- Phase 5.8 megaudit gets richer material once V3 is in scope.

Alternative: Phase 5.8 megaudit first (since V2.8 already cleaned the V2 production binary). Decide based on V3 timeline pressure.

Phase 5.8 estimated ~4-6 days as a separate cycle (per V1 exit packet).
