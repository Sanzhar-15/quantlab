PASS-WITH-FINDINGS

# Phase 5.7 V2 Transport Binding Megaudit - Codex

Audit target:
- Engine: `feat/quantbook-engine` at `4ea690ce24687b28b0d7f00e4a7374a7128a28df`
- IDE: `feat/visualise-v1` at `f9f98194958e1d2ba5a1224dde06ae17d0de5360`

## Q1-Q7 Verdicts

| Question | Verdict | Notes |
|---|---|---|
| Q1 - `kind()` propagation completeness | PASS-WITH-FINDINGS | Engine rejection paths route through the right helpers: `CollabSessionError` via `collab_session_error_to_napi`, `TransportError` via `transport_error_to_napi`, `WebSocketError` via `websocket_error_to_napi`, and validation/single-use errors via `bad_argument_error`. Raw `Error::from_reason` sites are helper internals plus non-engine task/fixture failures that intentionally parse as `unknown`. `transportLastError()` still collapses structured WebSocket runtime errors to strings before any helper can see them; see LOW-3. |
| Q2 - `pollRemote` blob-vs-op semantics | PASS | Binding `pollRemote()` returns blob count (`lib.rs:661-665`), `pollRemoteWithLimit(limit)` is a blob cap (`lib.rs:712-741`), and IDE JSDoc says BLOB count (`types.ts:123-183`). V2.2-V2.7 tests assert blob counts, including the single-blob/three-op guard at `quantbook-roundtrip.test.ts:575-600` and limit tests at `:747-784`. |
| Q3 - `AutoFlushPolicy` round-trip + `bad_argument` | PASS-WITH-FINDINGS | Parser aliases are still accepted (`lib.rs:944-947`) and invalid input emits `[bad_argument]` (`lib.rs:948-950`). `auto_flush_policy_to_string` also emits `[bad_argument]` on a future unknown enum variant (`lib.rs:972-987`). The prompt/active plan still mention an `"unknown"` return, but source and IDE types intentionally removed that fallback after V2.2 Opus HIGH-1; see MEDIUM-2. |
| Q4 - V2.4 `Arc<Mutex>` contracts | PASS | No session async method holds the mutex across `.await`. `flushPendingToTransport` extracts the ack handle under the lock (`lib.rs:920-923`), drops the guard, then awaits `spawn_blocking` (`lib.rs:934-937`). V2.1-V2.3 sync methods still perform session work under the mutex because the engine owns the transport inside `CoreCollabSession`; no recursive re-entry or guard/data lifetime inversion found. |
| Q5 - V2.5 `ack_handle` Send invariants | PASS-WITH-FINDINGS | `LoopbackTransport`/`NoopTransport` use the default `ack_handle() -> None`; `WebSocketTransport` returns an owned `WebSocketProgressAckHandle` with `target`, `progress`, and `closed` Arc clones (`ql-collab-ws/src/lib.rs:799-805`); `BlockingTransport` returns an owned `BlockingAckHandle` (`transport.rs:744-756`). Handle waits mirror the pre-refactor sync waits. `WebSocketProgressAckHandle` and `BlockingAckHandle` are pinned Send+Sync by compile assertions (`ql-collab-ws/src/lib.rs:864-877`, `transport.rs:779-793`). Docs still imply closed transport resolves instead of rejects; see MEDIUM-1. |
| Q6 - `BlockingTransportFixture` production-cdylib gating | PASS-WITH-FINDINGS | `ql-collab` gates `BlockingTransport`/`BlockingAckHandle` behind `test-fixtures` (`transport.rs:605-627`, `lib.rs:121-122`), but `ql-bindings-node` enables that feature unconditionally (`Cargo.toml:42-51`) and exports an ungated napi `BlockingTransportFixture` (`lib.rs:1211-1218`). IDE types and loader also expose/require it (`types.ts:290-333`, `loader.ts:288-297`). Current shipping state is not safe-by-default; the production-cdylib hardening backlog remains open. |
| Q7 - `kind()` string <-> `QuantbookErrorCode` union | PASS | Every current error variant has an explicit `kind()` arm: `TransportError` (`transport.rs:138-142`), `WebSocketError` (`ql-collab-ws/src/lib.rs:252-258`), `CollabSessionError` (`session.rs:173-180`). IDE union contains exactly the 12 requested codes (`types.ts:501-551`). Parser uses `KNOWN_QUANTBOOK_ERROR_CODES` without `unknown` (`session.ts:189-205`, `:268-274`); guard uses `ALL_QUANTBOOK_ERROR_CODES` with `unknown` (`session.ts:286-301`). |

## HIGH

None.

## MEDIUM

### MEDIUM-1: `flushPendingToTransport` docs say close resolves, but the code rejects with `[transport_closed]`

**File:line**:
- `crates/ql-bindings-node/src/lib.rs:875-879`
- `crates/ql-bindings-node/src/lib.rs:934-937`
- `crates/ql-collab-ws/src/lib.rs:836-849`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/src/quantbook/types.ts:258-267`

**Issue**: The binding and TS docs say the Promise resolves when "the transport has been detached / dropped / closed" (`lib.rs:875-879`, `types.ts:258-260`). The implementation does not do that for a real closed transport. `WebSocketProgressAckHandle::wait_for_drain()` returns `Err(TransportError::Closed)` if `closed` is set on entry or during the wait (`ql-collab-ws/src/lib.rs:836-849`), and the binding maps that through `transport_error_to_napi` (`lib.rs:934-937`), yielding a rejected Promise with `[transport_closed] transport closed`.

**Concrete reproduction**: Queue a WebSocket send, call `flushPendingToTransport()`, and close/drop the underlying WebSocket before the writer reaches the captured target. The promise rejects with `parseQuantbookError(err).code === 'transport_closed'`; it does not resolve. The same follows directly from the source path above.

**Suggested closure**: Update Rust and TS docs to say:
- resolves on successful drain, no attached transport, or transports with no async ack handle;
- rejects with `[transport_closed]` or `[transport_io]` if the handle reports a transport error.

Do not change the code: the rejection behavior is equivalent to the pre-V2.5 sync `flush_pending_to_transport()` path and is the right reconnect signal.

### MEDIUM-2: Active V2 plan still claims `autoFlushPolicy()` returns `"unknown"`, but source intentionally throws `[bad_argument]`

**File:line**:
- `.plans/_active.md:92-95`
- `crates/ql-bindings-node/src/lib.rs:826-837`
- `crates/ql-bindings-node/src/lib.rs:972-987`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/src/quantbook/types.ts:219-230`

**Issue**: The active plan still says `autoFlushPolicy()` returns canonical camelCase or `"unknown"` for forward compatibility (`.plans/_active.md:92-95`). The checked-out source intentionally does the opposite: `auto_flush_policy_to_string` returns `Err(bad_argument_error(...))` for an unknown future enum variant (`lib.rs:981-987`), and the TS API documents `autoFlushPolicy(): AutoFlushPolicy` with a thrown error on unknown engine variants (`types.ts:219-230`).

**Concrete reproduction**: Source-level reproduction is sufficient because `AutoFlushPolicy` currently has only `Disabled` and `OnAppend`. If a future engine variant is added before the binding mapping is updated, the catch-all at `lib.rs:981-987` throws `[bad_argument] autoFlushPolicy: engine reported unknown variant ...`; it cannot return `"unknown"`.

**Suggested closure**: Treat the code as canonical because this was the V2.2 Opus HIGH-1 no-fallback closure. Update `.plans/_active.md` and any V2 exit packet text to remove the `"unknown"` return contract and state the current fail-loud behavior. If product actually wants a sentinel, that is a protocol change and would need to revert the V2.2 closure in Rust, TS types, and tests.

## LOW

### LOW-1: `BlockingTransportFixture` still ships in the production cdylib surface

**File:line**:
- `crates/ql-collab/Cargo.toml:41-53`
- `crates/ql-bindings-node/Cargo.toml:42-51`
- `crates/ql-bindings-node/src/lib.rs:1211-1218`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/src/quantbook/loader.ts:288-297`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/src/quantbook/types.ts:290-333`

**Issue**: The engine fixture type is correctly `#[cfg(feature = "test-fixtures")]` in `ql-collab`, but `ql-bindings-node` enables `ql-collab/test-fixtures` unconditionally (`Cargo.toml:51`), defines `BlockingTransportFixture` without a binding-side cfg (`lib.rs:1211-1218`), and the IDE loader treats absence of the fixture as a stale-binary error (`loader.ts:288-297`). The current release dylib on disk contains `BlockingTransportFixture` strings.

**Concrete reproduction**:
- `strings quantbook-engine/target/release/libql_bindings_node.dylib | rg BlockingTransportFixture` returns the class name and method strings.
- `loadQuantbookEngine()` rejects a binary missing `BlockingTransportFixture` because `loader.ts:295-297` pushes it into `missing`.

**Suggested closure**: Add a `ql-bindings-node` feature such as `test-fixtures` that gates the napi class, its compile assert, and the `ql-collab/test-fixtures` dependency feature. Production builds should disable it; mocha/contract builds should enable it. Update the IDE loader and TS declarations so production surfaces do not require or expose the fixture.

### LOW-2: `BlockingTransportFixture` TS constructor JSDoc still says `0` is accepted, but Rust rejects `0`

**File:line**:
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/src/quantbook/types.ts:323-333`
- `crates/ql-bindings-node/src/lib.rs:1235-1268`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/test/quantbook-roundtrip.test.ts:1355-1377`

**Issue**: The TS declaration says `blockMs` may be `0` and means "wait indefinitely until released" (`types.ts:327-330`). The Rust binding rejects `0` at the napi boundary with `[bad_argument]` (`lib.rs:1260-1268`), and the IDE test suite pins that rejection (`quantbook-roundtrip.test.ts:1355-1377`).

**Concrete reproduction**: `new engine.BlockingTransportFixture(0)` throws `[bad_argument] BlockingTransportFixture: blockMs must be > 0 ...`, and `parseQuantbookError(err).code === 'bad_argument'`.

**Suggested closure**: Update the TS JSDoc to match the binding: `blockMs` must be a finite integer in `[1, u32::MAX]`; `0` is available only to Rust-side `BlockingTransport::new` tests, not to the napi fixture.

### LOW-3: `transportLastError()` collapses `WebSocketError::RuntimeError` before the V2.7 helpers can prefix it

**File:line**:
- `crates/ql-collab-ws/src/lib.rs:216-258`
- `crates/ql-collab-ws/src/lib.rs:714-728`
- `crates/ql-bindings-node/src/lib.rs:762-766`
- `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/src/quantbook/types.ts:508-516`

**Issue**: `WebSocketError::RuntimeError` has a V2.7 kind string (`websocket_runtime_error`) at `ql-collab-ws/src/lib.rs:252-258`, but the only post-connect runtime-error accessor maps it to `e.to_string()` (`ql-collab-ws/src/lib.rs:726-728`). The binding then returns that raw `Option<String>` (`lib.rs:762-766`). No V2.7 helper sees the structured `WebSocketError`, so IDE code cannot parse `websocket_runtime_error` from `transportLastError()` today. The TS union documents this as structurally defined but not reachable via a napi rejection path (`types.ts:508-516`).

**Concrete reproduction**: After a WebSocket runtime task records `WebSocketError::RuntimeError("peer reset")`, `session.transportLastError()` returns a raw string like `WebSocket runtime error: peer reset`. Wrapping that string in `new Error(...)` and calling `parseQuantbookError` yields `code: 'unknown'`, not `websocket_runtime_error`, because there is no `[websocket_runtime_error]` prefix.

**Suggested closure**: Either keep this as an explicitly deferred V2 backlog item, or add a structured `transportLastErrorInfo()`/prefixed `transportLastError()` path that applies `websocket_error_to_napi`-style kind prefixing to the stored runtime error. If the latter is chosen, update the TS JSDoc that currently says the code is not reachable.

## Verification Notes

- I read every source file cited above directly from the checked-out worktrees.
- `cargo` was not on PATH. Using the toolchain cargo binary still could not run `cargo tree`/`cargo build` because dependency resolution attempted crates.io and the environment cannot resolve `index.crates.io`; offline mode also failed because `napi` was not cached. The Q6 production-surface conclusion is therefore based on manifest/source inspection plus `strings` against the existing release dylib.
