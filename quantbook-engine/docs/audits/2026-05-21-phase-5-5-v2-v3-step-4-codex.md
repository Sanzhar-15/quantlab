Reading prompt from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/sanzhar/.codex/memories]
reasoning effort: xhigh
reasoning summaries: none
session id: 019e4a02-e904-7522-9d72-67a22602d20f
--------
user
# Phase 5.5 V2 V3 step 4 audit — WebSocket transport (`ql-collab-ws`)

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target**: HEAD `2cfac5b0395` (V2 V3 step 4 ship). Predecessor: `10f40eb228b` (V2 V3 step 3 audit-closure).

**Workspace tests at ship**: 4429 / 0 with `--test-threads=1` (+15 net from 4414: 13 ql-collab-ws integration tests + 2 unit). fmt + clippy clean.

**Plan**: `quantbook-engine/.plans/_active.md` (status: in-progress; archive at audit closure).

## What shipped

V2 V3 step 4 — first production-grade `Transport` impl. New crate `ql-collab-ws` housing `WebSocketTransport`. Bridges async tokio-tungstenite (`=0.29.0`) to the sync `Transport` trait via `tokio::sync::mpsc::unbounded_channel` and 2 spawned background tokio tasks (writer + reader).

### Scope locked at plan time

- **Crate layout**: new sibling crate `ql-collab-ws`, separate from `ql-collab` (keeps tokio out of core).
- **MVP**: client-only, plain `ws://`, in-process echo-server test fixture, NO TLS, NO auto-reconnect helper, NO server-side wrapper.
- **Decision**: investigation-first to verify the design fit. Investigation confirmed: 2 mpsc channels + 2 background tasks + RAII Drop is the canonical pattern.

### What was added

1. NEW crate `ql-collab-ws` with `WebSocketTransport` + `WebSocketError`.
2. NEW workspace.deps: `tokio-tungstenite = "=0.29.0"` + `futures-util = "=0.3.32"`.
3. 13 integration tests against in-process `EchoServer` fixture (binds 127.0.0.1:0, echoes binary frames, aborts per-conn tasks + accept task on Drop).
4. Doc updates in 4 surfaces (`transport.rs` module-doc, `MASTER-PLAN.md`, `v1-exit-packet.md`, `ide-consumer-contract.md`).

### What did NOT change

- No change to `ql-collab` core (transport.rs only got a doc-comment paragraph mentioning step 4).
- No change to existing transport impls (`NoopTransport`, `LoopbackTransport`).
- No new `Transport` trait methods.

## Files to focus your audit on

### Code
* `crates/ql-collab-ws/src/lib.rs` — `WebSocketTransport` impl + `WebSocketError`.
* `crates/ql-collab-ws/tests/common/mod.rs` — `EchoServer` + `RejectingServer` fixtures.
* `crates/ql-collab-ws/tests/websocket_transport.rs` — 13 integration tests.

### Plumbing
* `Cargo.toml` — workspace dep additions.
* `crates/ql-collab-ws/Cargo.toml` — crate manifest.

### Docs
* `crates/ql-collab/src/transport.rs` lines 44-61 — step 4 paragraph.
* `docs/MASTER-PLAN.md` § 5.5 — step 4 row.
* `docs/phase5/v1-exit-packet.md` § V2 V3 step 4 — ship row.
* `docs/architecture/ide-consumer-contract.md` § Production transport — bullet list of V1 limitations.

## Specific audit dimensions

### 1. Transport trait fit

The `Transport` trait (in `ql-collab/src/transport.rs`) requires:
- `send(&mut self, &[u8]) -> Result<(), TransportError>` — returns when bytes are QUEUED.
- `try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>` — drain-before-close: `Closed` only when permanently closed AND queue empty.

Verify `WebSocketTransport::send` correctly:
- Returns `Err(Closed)` when `self.closed` is set.
- Returns `Err(Closed)` when `outbound_tx.send` errors (receiver dropped).
- Returns `Ok(())` on successful queue.

Verify `WebSocketTransport::try_recv` correctly:
- Returns `Ok(Some(bytes))` if inbound has bytes.
- Returns `Ok(None)` if inbound is empty AND not closed.
- Returns `Err(Closed)` if inbound is empty AND (closed flag set OR mpsc receiver disconnected).
- On `TryRecvError::Disconnected`: sets the closed flag AND returns Closed (caches the state for fast-path on subsequent calls).

### 2. Runtime ownership and task lifecycle

Trace the two background tasks:
- **writer_task**: `while let Some(bytes) = outbound_rx.recv().await { ws_sink.send(Message::Binary(bytes.into())).await ... }`. Exits on outbound_rx None (sender dropped) or sink error. On exit (clean), calls `ws_sink.close().await` once.
- **reader_task**: `while let Some(msg_result) = ws_stream.next().await { ... }`. Exits on stream end, Close frame, or Err.

Spot-check:
- Does `Drop` actually abort both tasks? See `WebSocketTransport::drop` — it sets `closed = true` then calls `.abort()` on both JoinHandles.
- Is there a path where a task lives past Drop? `JoinHandle::abort` is non-blocking; tokio drops the task on next scheduler tick. As long as the runtime outlives the Drop, no leak.
- Caller pattern is `rt.block_on(connect(...))` then `rt.block_on(...)` to drive the session. If the runtime is dropped before the WebSocketTransport, the tasks are torn down by the runtime — but then the JoinHandles' abort() is a no-op. Safe.

### 3. Send-only invariant + lack of Sync

`CollabSession::transport: Option<Box<dyn Transport + Send>>` requires `Send`. The compile-time assert `_ASSERT_WEBSOCKET_TRANSPORT_SEND` at the bottom of `lib.rs` pins this. Verify it exists and is correct.

`WebSocketTransport` is NOT Sync because `try_recv` is `&mut self` (single-consumer mpsc). Verify there's no claim to Sync in the docstring.

### 4. Error path completeness

`WebSocketError` has 3 variants: `InvalidUrl`, `ConnectFailed`, `HandshakeFailed`. `connect()` matches `tungstenite::Error::Url` → `InvalidUrl`; `Io` → `ConnectFailed`; `Http`/`HttpFormat` → `HandshakeFailed`; everything else → `HandshakeFailed`.

Spot-check: are there any tungstenite errors that SHOULD map to a different variant? The current fallback is `HandshakeFailed` for anything unknown — per CLAUDE.md no-fallback rule, this is acceptable as long as it surfaces clearly (it does — `Display` includes the underlying message).

### 5. Test coverage of MVP V1 limitations

Limitations documented:
- No TLS: not test-pinnable (lack of feature is the test).
- No auto-reconnect: test `collab_session_websocket_reattach_after_close_delivers_offline_ops` exercises the "caller drives reattach" pattern.
- Unbounded queue: not stressed (V2 V4 work).
- Drops text/ping/pong: NOT explicitly test-pinned. Inbound text frames in the wild would be silently dropped — is this a concern?

### 6. CollabSession integration

3 tests in `websocket_transport.rs` exercise the V2 V3 contract via real WebSockets:

1. `collab_session_attach_websocket_round_trip_via_echo` — OnAppend auto-flush over WS; verifies echo round-trip + `has_pending_flush() == false` post-flush.
2. `collab_session_websocket_reattach_after_close_delivers_offline_ops` — V2 V3 step 3 contract: append while detached, attach WS, explicit flush delivers all offline ops, echo confirms.
3. `collab_session_websocket_send_after_close_surfaces_closed` — V2 V2 + V2 V3 step 1+2 partial-state contract: server drops mid-session, next append → `Err(Transport(Closed))` with op committed locally.

Verify each test's assertions match its name (Codex's history of catching "test names that lie" pattern).

### 7. Drop semantics race + EchoServer per-conn tracking

`EchoServer::Drop` now tracks per-connection JoinHandles in `Arc<Mutex<Vec<JoinHandle<()>>>>` and aborts ALL of them on Drop. This was added during impl to fix 2 failing tests (`server_close_propagates_to_try_recv_as_closed` + `collab_session_websocket_send_after_close_surfaces_closed`) — without per-conn abort, dropping the accept task left existing connections alive.

Spot-check: is the mutex poisoning handled correctly? The current pattern is `if let Ok(mut tasks) = conn_tasks.lock()` — if a previous lock holder panicked, lock returns Err and the per-conn tasks DON'T get aborted (silent skip). Acceptable for a test fixture (panic was already going to fail the test) but worth flagging.

### 8. Doc surface completeness

V1 limitations are documented in 4 places:
- `crates/ql-collab-ws/src/lib.rs` module-doc.
- `crates/ql-collab/src/transport.rs` module-doc (paragraph mentions step 4 + V1 limits).
- `docs/phase5/v1-exit-packet.md` § V2 V3 step 4.
- `docs/architecture/ide-consumer-contract.md` § Production transport (bullet list).

Spot-check: are the 5 limitations consistent across all 4 surfaces? (TLS, auto-reconnect, bounded queue, client-only, frame-drop.)

## Output

**VERDICT: PASS / PASS-WITH-FINDINGS / FAIL**

Bucketed findings (HIGH / MEDIUM / LOW) with file:line evidence. Don't paraphrase code; quote it.

## Note

Don't run cargo test — gates already verified at WS=4429.

Audit transcript will be saved to `quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-4-codex.md`.

codex
I’ll audit this as a review, focusing on behavioral mismatches and documentation drift rather than rerunning the verified gates. I’ll first read the local agent guidance and the focused source/docs, then trace the transport lifecycle and tests against the contract.
exec
/bin/zsh -lc "sed -n '1,220p' .github/copilot-instructions.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '1,260p' crates/ql-collab-ws/tests/common/mod.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '1,260p' crates/ql-collab-ws/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 exited 1 in 0ms:
sed: crates/ql-collab-ws/src/lib.rs: No such file or directory

 succeeded in 0ms:
# VS Code Copilot Instructions

## Project Overview

Visual Studio Code is built with a layered architecture using TypeScript, web APIs and Electron, combining web technologies with native app capabilities. The codebase is organized into key architectural layers:

### Root Folders
- `src/`: Main TypeScript source code with unit tests in `src/vs/*/test/` folders
- `build/`: Build scripts and CI/CD tools
- `extensions/`: Built-in extensions that ship with VS Code
- `test/`: Integration tests and test infrastructure
- `scripts/`: Development and build scripts
- `resources/`: Static resources (icons, themes, etc.)
- `out/`: Compiled JavaScript output (generated during build)

### Core Architecture (`src/` folder)
- `src/vs/base/` - Foundation utilities and cross-platform abstractions
- `src/vs/platform/` - Platform services and dependency injection infrastructure
- `src/vs/editor/` - Text editor implementation with language services, syntax highlighting, and editing features
- `src/vs/workbench/` - Main application workbench for web and desktop
  - `workbench/browser/` - Core workbench UI components (parts, layout, actions)
  - `workbench/services/` - Service implementations
  - `workbench/contrib/` - Feature contributions (git, debug, search, terminal, etc.)
  - `workbench/api/` - Extension host and VS Code API implementation
- `src/vs/code/` - Electron main process specific implementation
- `src/vs/server/` - Server specific implementation

The core architecture follows these principles:
- **Layered architecture** - from `base`, `platform`, `editor`, to `workbench`
- **Dependency injection** - Services are injected through constructor parameters
- **Contribution model** - Features contribute to registries and extension points
- **Cross-platform compatibility** - Abstractions separate platform-specific code

### Built-in Extensions (`extensions/` folder)
The `extensions/` directory contains first-party extensions that ship with VS Code:
- **Language support** - `typescript-language-features/`, `html-language-features/`, `css-language-features/`, etc.
- **Core features** - `git/`, `debug-auto-launch/`, `emmet/`, `markdown-language-features/`
- **Themes** - `theme-*` folders for default color themes
- **Development tools** - `extension-editing/`, `vscode-api-tests/`

Each extension follows the standard VS Code extension structure with `package.json`, TypeScript sources, and contribution points to extend the workbench through the Extension API.

### Finding Related Code
1. **Semantic search first**: Use file search for general concepts
2. **Grep for exact strings**: Use grep for error messages or specific function names
3. **Follow imports**: Check what files import the problematic module
4. **Check test files**: Often reveal usage patterns and expected behavior

## Validating TypeScript changes

MANDATORY: Always check the `VS Code - Build` watch task output via #runTasks/getTaskOutput for compilation errors before running ANY script or declaring work complete, then fix all compilation errors before moving forward.

- NEVER run tests if there are compilation errors
- NEVER use `npm run compile` to compile TypeScript files but call #runTasks/getTaskOutput instead

### TypeScript compilation steps
- Monitor the `VS Code - Build` task outputs for real-time compilation errors as you make changes
- This task runs `Core - Build` and `Ext - Build` to incrementally compile VS Code TypeScript sources and built-in extensions
- Start the task if it's not already running in the background

### TypeScript validation steps
- Use the run test tool if you need to run tests. If that tool is not available, then you can use `scripts/test.sh` (or `scripts\test.bat` on Windows) for unit tests (add `--grep <pattern>` to filter tests) or `scripts/test-integration.sh` (or `scripts\test-integration.bat` on Windows) for integration tests (integration tests end with .integrationTest.ts or are in /extensions/).
- Use `npm run valid-layers-check` to check for layering issues

## Coding Guidelines

### Indentation

We use tabs, not spaces.

### Naming Conventions

- Use PascalCase for `type` names
- Use PascalCase for `enum` values
- Use camelCase for `function` and `method` names
- Use camelCase for `property` names and `local variables`
- Use whole words in names when possible

### Types

- Do not export `types` or `functions` unless you need to share it across multiple components
- Do not introduce new `types` or `values` to the global namespace

### Comments

- Use JSDoc style comments for `functions`, `interfaces`, `enums`, and `classes`

### Strings

- Use "double quotes" for strings shown to the user that need to be externalized (localized)
- Use 'single quotes' otherwise
- All strings visible to the user need to be externalized using the `vs/nls` module
- Externalized strings must not use string concatenation. Use placeholders instead (`{0}`).

### UI labels
- Use title-style capitalization for command labels, buttons and menu items (each word is capitalized).
- Don't capitalize prepositions of four or fewer letters unless it's the first or last word (e.g. "in", "with", "for").

### Style

- Use arrow functions `=>` over anonymous function expressions
- Only surround arrow function parameters when necessary. For example, `(x) => x + x` is wrong but the following are correct:

```typescript
x => x + x
(x, y) => x + y
<T>(x: T, y: T) => x === y
```

- Always surround loop and conditional bodies with curly braces
- Open curly braces always go on the same line as whatever necessitates them
- Parenthesized constructs should have no surrounding whitespace. A single space follows commas, colons, and semicolons in those constructs. For example:

```typescript
for (let i = 0, n = str.length; i < 10; i++) {
    if (x < 10) {
        foo();
    }
}
function f(x: number, y: string): void { }
```

- Whenever possible, use in top-level scopes `export function x(…) {…}` instead of `export const x = (…) => {…}`. One advantage of using the `function` keyword is that the stack-trace shows a good name when debugging.

### Code Quality

- All files must include Microsoft copyright header
- Prefer `async` and `await` over `Promise` and `then` calls
- All user facing messages must be localized using the applicable localization framework (for example `nls.localize()` method)
- Don't add tests to the wrong test suite (e.g., adding to end of file instead of inside relevant suite)
- Look for existing test patterns before creating new structures
- Use `describe` and `test` consistently with existing patterns
- Prefer regex capture groups with names over numbered capture groups.
- If you create any temporary new files, scripts, or helper files for iteration, clean up these files by removing them at the end of the task
- Never duplicate imports. Always reuse existing imports if they are present.
- Do not use `any` or `unknown` as the type for variables, parameters, or return values unless absolutely necessary. If they need type annotations, they should have proper types or interfaces defined.
- When adding file watching, prefer correlated file watchers (via fileService.createWatcher) to shared ones.
- When adding tooltips to UI elements, prefer the use of IHoverService service.

 exited 1 in 0ms:
sed: crates/ql-collab-ws/tests/common/mod.rs: No such file or directory

codex
The repo root here has an AGENTS file that points at VS Code-style guidance, but the audit files are not at the workspace root path. I’m locating the engine worktree/subdirectory now so the line references come from the actual audited code.
exec
/bin/zsh -lc pwd in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook

exec
/bin/zsh -lc "find . -maxdepth 3 -type d -name 'ql-collab-ws' -o -name 'quantbook-engine'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
./quantbook-engine
./quantbook-engine/crates/ql-collab-ws

exec
/bin/zsh -lc "rg --files -g 'lib.rs' -g 'websocket_transport.rs' -g 'mod.rs' -g 'Cargo.toml' | rg 'ql-collab-ws|quantbook-engine|Cargo.toml'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
build/win32/Cargo.toml
quantbook-engine/crates/ql-bindings-node/src/lib.rs
quantbook-engine/crates/ql-bindings-node/Cargo.toml
quantbook-engine/crates/ql-io-ods/src/lib.rs
quantbook-engine/crates/ql-io-ods/Cargo.toml
quantbook-engine/crates/ql-formula-semantics/src/lib.rs
quantbook-engine/crates/ql-formula-semantics/Cargo.toml
quantbook-engine/crates/ql-oplog/src/lib.rs
quantbook-engine/crates/ql-oplog/Cargo.toml
quantbook-engine/crates/ql-storage/src/lib.rs
quantbook-engine/crates/ql-storage/Cargo.toml
quantbook-engine/crates/ql-collab/src/lib.rs
quantbook-engine/crates/ql-collab/Cargo.toml
quantbook-engine/crates/ql-ai/src/lib.rs
quantbook-engine/crates/ql-ai/Cargo.toml
quantbook-engine/crates/ql-types/src/lib.rs
quantbook-engine/crates/ql-types/Cargo.toml
quantbook-engine/crates/ql-calcgraph/src/lib.rs
quantbook-engine/crates/ql-calcgraph/Cargo.toml
quantbook-engine/crates/ql-bench/src/lib.rs
quantbook-engine/crates/ql-bench/Cargo.toml
quantbook-engine/crates/ql-collab-ws/src/lib.rs
quantbook-engine/crates/ql-collab-ws/tests/websocket_transport.rs
quantbook-engine/crates/ql-collab-ws/tests/common/mod.rs
quantbook-engine/crates/ql-collab-ws/Cargo.toml
quantbook-engine/crates/ql-io-xlsx/src/read/mod.rs
quantbook-engine/crates/ql-io-xlsx/src/lib.rs
quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs
quantbook-engine/crates/ql-io-xlsx/Cargo.toml
quantbook-engine/crates/ql-connectors/src/lib.rs
quantbook-engine/crates/ql-connectors/Cargo.toml
quantbook-engine/crates/ql-terminal/src/lib.rs
quantbook-engine/crates/ql-terminal/Cargo.toml
quantbook-engine/crates/ql-bindings-wasm/src/lib.rs
quantbook-engine/crates/ql-bindings-wasm/Cargo.toml
quantbook-engine/crates/ql-bindings-c/src/lib.rs
quantbook-engine/crates/ql-bindings-c/Cargo.toml
quantbook-engine/crates/ql-udf/src/lib.rs
quantbook-engine/crates/ql-udf/Cargo.toml
quantbook-engine/crates/ql-profile/src/lib.rs
quantbook-engine/crates/ql-profile/Cargo.toml
quantbook-engine/crates/ql-io/src/lib.rs
quantbook-engine/crates/ql-io/Cargo.toml
quantbook-engine/crates/quantbook-py/src/lib.rs
quantbook-engine/crates/quantbook-py/Cargo.toml
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs
quantbook-engine/crates/ql-exec/src/lib.rs
quantbook-engine/crates/ql-exec/Cargo.toml
quantbook-engine/crates/ql-service/src/lib.rs
quantbook-engine/crates/ql-service/Cargo.toml
quantbook-engine/crates/ql-sql/src/lib.rs
quantbook-engine/crates/ql-sql/Cargo.toml
quantbook-engine/crates/ql-functions/src/format/mod.rs
quantbook-engine/crates/ql-functions/src/lib.rs
quantbook-engine/crates/ql-functions/Cargo.toml
quantbook-engine/crates/ql-formula-syntax/src/lib.rs
quantbook-engine/crates/ql-formula-syntax/Cargo.toml
quantbook-engine/Cargo.toml
cli/Cargo.toml

exec
/bin/zsh -lc 'find .. -name AGENTS.md -print' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'git rev-parse --show-toplevel && git rev-parse --short HEAD && git status --short' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '1,260p' crates/ql-collab-ws/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '1,320p' crates/ql-collab-ws/tests/common/mod.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 264ms:
//! `ql-collab-ws` — WebSocket `Transport` impl for Phase 5
//! collaboration.
//!
//! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
//! production-grade [`Transport`](ql_collab::Transport) impl. Bridges
//! tokio-tungstenite's async WebSocket client to the sync `Transport`
//! trait via `tokio::sync::mpsc` channels and two spawned background
//! tasks.
//!
//! ## Crate boundary rationale
//!
//! `ql-collab` core is purely sync and embeddable in non-tokio
//! runtimes (e.g., an IDE main thread, future WASM target). Pulling
//! tokio + tokio-tungstenite into the core would force that
//! constraint on every consumer. Keeping the WebSocket impl in a
//! separate crate means:
//! - Consumers who only need `LoopbackTransport` (tests) or a custom
//!   transport (in-process IPC, gRPC streaming) don't pay for tokio.
//! - The async runtime lives at the application boundary, not in the
//!   collaboration layer.
//!
//! ## Architecture
//!
//! ```text
//!  caller (sync, e.g. inside CollabSession::append_op)
//!    │
//!    │  send(bytes)        try_recv() -> Option<bytes>
//!    ▼                            ▲
//!  WebSocketTransport             │
//!    │ outbound_tx              inbound_rx
//!    │  (mpsc::UnboundedSender)  (mpsc::UnboundedReceiver)
//!    ▼                            ▲
//!  writer_task (tokio)          reader_task (tokio)
//!    │  awaits outbound_rx        │  awaits ws_stream.next()
//!    ▼                            ▲
//!    │  ws_sink.send(Binary)      │  inbound_tx.send(bytes)
//!    ▼                            │
//!  ===================== TCP socket =====================
//! ```
//!
//! The two background tasks own the WebSocket halves
//! (`SplitSink` + `SplitStream` via `futures_util::StreamExt::split`).
//! `Drop` aborts both tasks (RAII close).
//!
//! ## V1 limitations (deferred to V2 V4)
//!
//! - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy
//!   in front, or wait for V2 V4 `rustls` feature.
//! - **No auto-reconnect.** Caller drives via `detach_transport` +
//!   new `connect` + `attach_transport`. The Phase 5.5 V2 V3 step 1
//!   `last_flushed_vv = None` reset on attach delivers all accumulated
//!   ops on reconnect (offline-write story).
//! - **Unbounded outbound mpsc queue.** Memory grows if peer
//!   disconnects mid-flow + caller keeps appending. V2 V4 will switch
//!   to bounded with caller-configurable backpressure policy.
//! - **Client-only.** Server-side WebSocket impls use other libraries
//!   (`axum-tungstenite`, `warp::ws`, etc.).
//! - **Drops text/ping/pong/close frames as inbound data.** Loro
//!   payloads are binary blobs; non-binary frames don't carry our
//!   protocol. Close frames trigger task exit; ping is handled by
//!   tokio-tungstenite's internal auto-pong; text frames are
//!   silently dropped (a future protocol extension could add a
//!   callback hook).
//!
//! ## Example
//!
//! ```ignore
//! use ql_collab::{CollabSession, PeerId, AutoFlushPolicy};
//! use ql_collab_ws::WebSocketTransport;
//!
//! let rt = tokio::runtime::Runtime::new()?;
//! let ws = rt.block_on(WebSocketTransport::connect("ws://localhost:8080"))?;
//! let mut session = CollabSession::new(PeerId::new(1))?;
//! session.attach_transport(ws);
//! session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
//! // ... appends now propagate via WebSocket automatically ...
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use ql_collab::{Transport, TransportError};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

/// Errors emitted when constructing a [`WebSocketTransport`].
///
/// Distinguishes URL-format errors (caller mistake) from connection
/// errors (network state). Maps tungstenite errors opaquely — we
/// don't want to leak tungstenite types into the public API.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum WebSocketError {
    /// The URL string failed to parse or is missing required parts.
    /// Per CLAUDE.md no-fallback rule: surface clearly, don't silently
    /// retry with a "fixed up" URL.
    #[error("invalid WebSocket URL: {0}")]
    InvalidUrl(String),

    /// TCP connect failed (refused, timeout, DNS, etc.).
    #[error("WebSocket connection failed: {0}")]
    ConnectFailed(String),

    /// WebSocket protocol handshake failed (HTTP upgrade rejected,
    /// invalid response, etc.).
    #[error("WebSocket handshake failed: {0}")]
    HandshakeFailed(String),
}

/// Phase 5.5 V2 V3 step 4 — WebSocket `Transport` impl.
///
/// Bridges async tokio-tungstenite to the sync `Transport` trait via
/// `tokio::sync::mpsc` channels and two spawned background tasks.
/// See module-level docs for architecture diagram.
///
/// ## Construction
///
/// Use [`connect`](Self::connect) — async fn that performs the WS
/// handshake. Caller pattern from sync code:
///
/// ```ignore
/// let rt = tokio::runtime::Runtime::new()?;
/// let ws = rt.block_on(WebSocketTransport::connect("ws://host:port"))?;
/// session.attach_transport(ws);
/// ```
///
/// ## Send/Sync
///
/// `WebSocketTransport: Send` (asserted via compile-time const). Not
/// `Sync` — exclusive ownership is required because `try_recv` takes
/// `&mut self` (the mpsc receiver is single-consumer). This matches
/// the `CollabSession::transport: Box<dyn Transport + Send>`
/// constraint.
pub struct WebSocketTransport {
    /// Caller-side sender feeding the writer task. Sync write via
    /// `UnboundedSender::send` (which is non-blocking).
    outbound_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Caller-side receiver pulling from the reader task. Sync drain
    /// via `UnboundedReceiver::try_recv`.
    inbound_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    /// Set true when either task observes a permanent failure (WS
    /// close, IO error, peer disconnect) OR caller invokes
    /// [`close`](Self::close). Both `send` and `try_recv` honor this
    /// flag per the `Transport` trait drain-before-close contract.
    closed: Arc<AtomicBool>,
    /// Background tokio task that drains `outbound_rx` and writes
    /// `Message::Binary` frames to the WebSocket sink. Aborted on
    /// `Drop`.
    writer_task: JoinHandle<()>,
    /// Background tokio task that polls the WebSocket stream and
    /// pushes binary payloads into `inbound_tx`. Aborted on `Drop`.
    reader_task: JoinHandle<()>,
}

impl std::fmt::Debug for WebSocketTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSocketTransport")
            .field("closed", &self.closed.load(Ordering::Relaxed))
            .field("writer_finished", &self.writer_task.is_finished())
            .field("reader_finished", &self.reader_task.is_finished())
            .finish()
    }
}

impl WebSocketTransport {
    /// Connect to a WebSocket server at `url` (e.g. `ws://host:port/path`).
    ///
    /// Must be called from within a tokio runtime context (the two
    /// background tasks are spawned via `tokio::spawn`). The typical
    /// pattern from sync code is `runtime.block_on(connect(...))`.
    ///
    /// On success, returns a fully-wired transport: send/recv channels
    /// connected, background tasks running. On failure, returns one
    /// of the [`WebSocketError`] variants with the underlying cause.
    pub async fn connect(url: &str) -> Result<Self, WebSocketError> {
        // tokio-tungstenite::connect_async handles URL parse + TCP
        // connect + WS handshake in one call. Distinguish the failure
        // modes via the returned error string match — opaque to keep
        // tungstenite types out of our public API.
        let (ws_stream, _response) = tokio_tungstenite::connect_async(url).await.map_err(|e| {
            let msg = e.to_string();
            // Coarse classification — tungstenite::Error doesn't have a
            // clean discriminant for "URL parse" vs "TCP connect" vs
            // "handshake". Use the error type to route.
            match e {
                tokio_tungstenite::tungstenite::Error::Url(_) => WebSocketError::InvalidUrl(msg),
                tokio_tungstenite::tungstenite::Error::Io(_) => WebSocketError::ConnectFailed(msg),
                tokio_tungstenite::tungstenite::Error::Http(_)
                | tokio_tungstenite::tungstenite::Error::HttpFormat(_) => {
                    WebSocketError::HandshakeFailed(msg)
                }
                _ => WebSocketError::HandshakeFailed(msg),
            }
        })?;

        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let closed = Arc::new(AtomicBool::new(false));
        let closed_writer = Arc::clone(&closed);
        let closed_reader = Arc::clone(&closed);

        // Writer task: drains outbound mpsc, writes Binary frames to
        // the WS sink. Exits on outbound_rx close (caller dropped
        // outbound_tx, which happens when WebSocketTransport drops)
        // OR on sink error.
        let writer_task = tokio::spawn(async move {
            while let Some(bytes) = outbound_rx.recv().await {
                if let Err(_e) = ws_sink.send(Message::Binary(bytes.into())).await {
                    closed_writer.store(true, Ordering::Relaxed);
                    return;
                }
            }
            // outbound_rx closed (sender dropped) — clean shutdown.
            // Attempt a graceful WS close frame; ignore errors (peer
            // may already be gone).
            let _ = ws_sink.close().await;
        });

        // Reader task: polls WS stream; pushes binary payloads into
        // inbound mpsc. Exits on stream end, error, or Close frame.
        let reader_task = tokio::spawn(async move {
            while let Some(msg_result) = ws_stream.next().await {
                match msg_result {
                    Ok(Message::Binary(bytes)) => {
                        if inbound_tx.send(bytes.to_vec()).is_err() {
                            // Receiver dropped (WebSocketTransport
                            // dropped) — exit cleanly.
                            return;
                        }
                    }
                    Ok(Message::Close(_)) => {
                        closed_reader.store(true, Ordering::Relaxed);
                        return;
                    }
                    Ok(
                        Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_),
                    ) => {
                        // Non-binary frames dropped per protocol
                        // contract (see module-level V1 limits).
                    }
                    Err(_e) => {
                        closed_reader.store(true, Ordering::Relaxed);
                        return;
                    }
                }
            }
            // Stream ended (peer closed) — mark closed.
            closed_reader.store(true, Ordering::Relaxed);
        });

        Ok(Self {
            outbound_tx,
            inbound_rx,
            closed,

 succeeded in 266ms:
//! Shared test fixtures for ql-collab-ws integration tests.
//!
//! In-process WebSocket echo server bound to 127.0.0.1:0 (OS-assigned
//! port). Echoes binary frames back to sender; drops text/ping/pong.
//! `Drop` aborts the listener loop.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

/// In-process WebSocket echo server. Echoes every binary frame back
/// to the sender. Listens on 127.0.0.1:0 (OS-assigned port). Use
/// [`url`](Self::url) to get the `ws://127.0.0.1:PORT` URL for the
/// client to connect to.
///
/// **Drop semantics:** aborts the accept loop AND every per-connection
/// task spawned during the lifetime of this server. The per-conn
/// abort is what tears down the live TCP socket → the client-side
/// reader observes EOF and marks closed. Without per-conn tracking,
/// `drop(server)` would only stop accepting NEW connections and
/// existing ones would dangle until the test process exits.
pub struct EchoServer {
    addr: SocketAddr,
    accept_task: JoinHandle<()>,
    conn_tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl EchoServer {
    /// Bind a TcpListener on 127.0.0.1:0 and spawn an accept loop.
    /// Each incoming connection is upgraded to a WebSocket and runs
    /// a per-connection echo loop in its own spawned task. The
    /// per-conn JoinHandle is recorded on `conn_tasks` so `Drop` can
    /// abort it.
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0 in test");
        let addr = listener
            .local_addr()
            .expect("local_addr after successful bind");
        let conn_tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let conn_tasks_in_accept = Arc::clone(&conn_tasks);
        let accept_task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _peer_addr)) => {
                        let handle = tokio::spawn(handle_echo_connection(stream));
                        if let Ok(mut tasks) = conn_tasks_in_accept.lock() {
                            tasks.push(handle);
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            addr,
            accept_task,
            conn_tasks,
        }
    }

    /// `ws://127.0.0.1:PORT` URL the client should connect to.
    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

impl Drop for EchoServer {
    fn drop(&mut self) {
        // Abort the accept loop first so no NEW per-conn tasks land
        // in conn_tasks during teardown. Then abort every per-conn
        // task — each task owns its TCP stream, so abort drops the
        // stream and the client observes a TCP RST / EOF.
        self.accept_task.abort();
        if let Ok(mut tasks) = self.conn_tasks.lock() {
            for h in tasks.drain(..) {
                h.abort();
            }
        }
    }
}

async fn handle_echo_connection(stream: TcpStream) {
    let mut ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    while let Some(msg_result) = ws.next().await {
        match msg_result {
            Ok(Message::Binary(bytes)) => {
                if ws.send(Message::Binary(bytes)).await.is_err() {
                    return;
                }
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

/// One-shot client-side TCP server that accepts a single connection,
/// then closes it without completing the WebSocket handshake. Used
/// to drive `HandshakeFailed` paths without an external dependency.
pub struct RejectingServer {
    addr: SocketAddr,
    accept_task: JoinHandle<()>,
}

impl RejectingServer {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1:0 in test");
        let addr = listener
            .local_addr()
            .expect("local_addr after successful bind");
        let accept_task = tokio::spawn(async move {
            // Accept one TCP connection then drop it — the client's
            // WS handshake sees EOF and fails.
            if let Ok((_stream, _)) = listener.accept().await {
                // _stream drops here; client sees connection reset.
            }
        });
        Self { addr, accept_task }
    }

    pub fn url(&self) -> String {
        format!("ws://{}", self.addr)
    }
}

impl Drop for RejectingServer {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

 succeeded in 393ms:
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
2cfac5b0395
?? ../.codex-phase-5-5-v2-v3-step-3-audit-prompt.md
?? ../.codex-phase-5-5-v2-v3-step-3-audit.out
?? ../.codex-phase-5-5-v2-v3-step-4-audit-prompt.md
?? ../.codex-phase-5-5-v2-v3-step-4-audit.out
?? ../2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt
?? ../2026-05-13-003338-this-session-is-being-continued-from-a-previous-c.txt
?? ../node_modules
?? .codex/prompts/2026-05-14-AA-design-review.md
?? .codex/prompts/2026-05-14-J-127-verify.md
?? .codex/prompts/2026-05-14-J-128-verify.md
?? .codex/prompts/2026-05-14-J-129-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-132-133followup-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-HIGH3-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-LOW-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-MEDIUM4-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-MEDIUM5-verify.md
?? .codex/prompts/2026-05-14-K-verify.md
?? .codex/prompts/2026-05-14-L-verify.md
?? .codex/prompts/2026-05-14-M-verify.md
?? .codex/prompts/2026-05-14-N-verify.md
?? .codex/prompts/2026-05-14-O-closure-verify.md
?? .codex/prompts/2026-05-14-O-megaudit.md
?? .codex/prompts/2026-05-14-phase-4.7.I-review.md
?? .codex/prompts/2026-05-14-phase-4.7.J-megaudit-pass2.md
?? .codex/prompts/2026-05-14-phase-4.7.J-review.md
?? .codex/prompts/2026-05-15-phase-4.8-closing-megaudit.md
?? .codex/prompts/2026-05-15-phase-4.8-closure-verify.md
?? .codex/prompts/2026-05-15-phase-4.8-final-reverify.md
?? .codex/prompts/2026-05-15-phase-4.9-design-review.md
?? .codex/prompts/2026-05-15-phase-4.9-mid-arc-audit.md
?? .plans/_active.md
?? .plans/_archive/2026-05-13_w5-77-phase-4.5d-format-parser.md
?? .plans/_archive/2026-05-13_w5-78-phase-4.5d-renderer.md
?? .plans/_archive/2026-05-14_w5-121-phase-4.8.i.2-rename-column.md
?? .plans/_archive/2026-05-14_w5-122-phase-4.8.j-resize-table.md
?? .plans/_archive/2026-05-14_w5-123-phase-4.8.l-persistence-v6.md
?? .plans/_archive/2026-05-15_phase-4.8.O-findings.md
?? .plans/_archive/2026-05-17_phase-4-10-v1-260-closeout.md
?? .plans/_archive/2026-05-17_rt-v1-01-reference-tier-mini-phase.md
?? .plans/_archive/2026-05-18_phase-4-11-xlsx-import-export.md
?? .plans/_archive/2026-05-18_tier-a-api-stability.md
?? .plans/_archive/2026-05-21_phase-5-5-v2-v2-auto-flush.md
?? .plans/_archive/2026-05-21_phase-5-5-v2-v3-step-1-version-vector.md
?? .plans/_archive/2026-05-21_phase-5-5-v2-v3-step-2-poll-remote-auto-flush.md
?? .plans/_archive/2026-05-21_phase-5-5-v2-v3-step-3-offline-write-queue.md
?? 2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? 2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt

2026-05-21T10:10:02.053612Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open
 succeeded in 18899ms:
../AGENTS.md

exec
/bin/zsh -lc "sed -n '261,520p' crates/ql-collab-ws/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab-ws/src/lib.rs | sed -n '1,360p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab-ws/tests/common/mod.rs | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 272ms:
            writer_task,
            reader_task,
        })
    }

    /// True if this transport has been closed — either explicitly via
    /// [`close`](Self::close), via Drop, or by either background task
    /// observing a permanent failure (peer disconnect, WS Close frame,
    /// IO error).
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Explicitly mark this transport closed. Subsequent
    /// [`Transport::send`] calls return `Err(Closed)`; subsequent
    /// [`Transport::try_recv`] calls drain the inbound queue first,
    /// then return `Err(Closed)` (per trait contract).
    ///
    /// Does NOT abort the background tasks — only Drop does that. If
    /// the caller wants the tasks gone, drop the transport.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }
}

impl Drop for WebSocketTransport {
    fn drop(&mut self) {
        // Set closed first so any concurrent send/try_recv observes
        // it. Then abort tasks. Dropping `outbound_tx` (when self is
        // dropped) signals the writer task to exit gracefully via
        // `outbound_rx.recv()` returning None; abort() is a safety
        // net for the reader task which awaits on the WS stream and
        // won't otherwise notice the caller is gone.
        self.closed.store(true, Ordering::Relaxed);
        self.writer_task.abort();
        self.reader_task.abort();
    }
}

impl Transport for WebSocketTransport {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        // UnboundedSender::send returns Err iff the receiver dropped.
        // The receiver lives in the writer task; if it dropped, the
        // task exited (panic, abort, or graceful). Treat as Closed.
        self.outbound_tx
            .send(bytes.to_vec())
            .map_err(|_| TransportError::Closed)
    }

    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        // Drain-before-close per `Transport` trait contract
        // (transport.rs:112-115): "Closed only when channel
        // permanently closed AND internal queue is empty."
        use mpsc::error::TryRecvError;
        match self.inbound_rx.try_recv() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(TryRecvError::Empty) => {
                if self.closed.load(Ordering::Relaxed) {
                    Err(TransportError::Closed)
                } else {
                    Ok(None)
                }
            }
            Err(TryRecvError::Disconnected) => {
                // Reader task exited and dropped inbound_tx. Mark
                // closed so subsequent calls fast-path; treat as
                // Closed for this call (the queue is empty AND the
                // upstream is permanently gone).
                self.closed.store(true, Ordering::Relaxed);
                Err(TransportError::Closed)
            }
        }
    }
}

// Phase 5.5 V2 V3 step 4 — pin the Send invariant. CollabSession
// stores `Box<dyn Transport + Send>`; if a future refactor adds a
// non-Send field this stops compiling. Sync is NOT required.
const _ASSERT_WEBSOCKET_TRANSPORT_SEND: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<WebSocketTransport>();
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_error_display_includes_cause() {
        let e = WebSocketError::InvalidUrl("malformed".into());
        assert!(e.to_string().contains("malformed"));
        let e = WebSocketError::ConnectFailed("refused".into());
        assert!(e.to_string().contains("refused"));
        let e = WebSocketError::HandshakeFailed("401".into());
        assert!(e.to_string().contains("401"));
    }

    #[test]
    fn websocket_error_variants_compile() {
        // Smoke check that each variant constructs + matches. The
        // `#[non_exhaustive]` attribute is for downstream crates;
        // inside this crate the variant set is closed and `_` would
        // be unreachable.
        for e in [
            WebSocketError::InvalidUrl("x".into()),
            WebSocketError::ConnectFailed("y".into()),
            WebSocketError::HandshakeFailed("z".into()),
        ] {
            match e {
                WebSocketError::InvalidUrl(_) => (),
                WebSocketError::ConnectFailed(_) => (),
                WebSocketError::HandshakeFailed(_) => (),
            }
        }
    }
}

 succeeded in 271ms:
     1	//! `ql-collab-ws` — WebSocket `Transport` impl for Phase 5
     2	//! collaboration.
     3	//!
     4	//! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
     5	//! production-grade [`Transport`](ql_collab::Transport) impl. Bridges
     6	//! tokio-tungstenite's async WebSocket client to the sync `Transport`
     7	//! trait via `tokio::sync::mpsc` channels and two spawned background
     8	//! tasks.
     9	//!
    10	//! ## Crate boundary rationale
    11	//!
    12	//! `ql-collab` core is purely sync and embeddable in non-tokio
    13	//! runtimes (e.g., an IDE main thread, future WASM target). Pulling
    14	//! tokio + tokio-tungstenite into the core would force that
    15	//! constraint on every consumer. Keeping the WebSocket impl in a
    16	//! separate crate means:
    17	//! - Consumers who only need `LoopbackTransport` (tests) or a custom
    18	//!   transport (in-process IPC, gRPC streaming) don't pay for tokio.
    19	//! - The async runtime lives at the application boundary, not in the
    20	//!   collaboration layer.
    21	//!
    22	//! ## Architecture
    23	//!
    24	//! ```text
    25	//!  caller (sync, e.g. inside CollabSession::append_op)
    26	//!    │
    27	//!    │  send(bytes)        try_recv() -> Option<bytes>
    28	//!    ▼                            ▲
    29	//!  WebSocketTransport             │
    30	//!    │ outbound_tx              inbound_rx
    31	//!    │  (mpsc::UnboundedSender)  (mpsc::UnboundedReceiver)
    32	//!    ▼                            ▲
    33	//!  writer_task (tokio)          reader_task (tokio)
    34	//!    │  awaits outbound_rx        │  awaits ws_stream.next()
    35	//!    ▼                            ▲
    36	//!    │  ws_sink.send(Binary)      │  inbound_tx.send(bytes)
    37	//!    ▼                            │
    38	//!  ===================== TCP socket =====================
    39	//! ```
    40	//!
    41	//! The two background tasks own the WebSocket halves
    42	//! (`SplitSink` + `SplitStream` via `futures_util::StreamExt::split`).
    43	//! `Drop` aborts both tasks (RAII close).
    44	//!
    45	//! ## V1 limitations (deferred to V2 V4)
    46	//!
    47	//! - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy
    48	//!   in front, or wait for V2 V4 `rustls` feature.
    49	//! - **No auto-reconnect.** Caller drives via `detach_transport` +
    50	//!   new `connect` + `attach_transport`. The Phase 5.5 V2 V3 step 1
    51	//!   `last_flushed_vv = None` reset on attach delivers all accumulated
    52	//!   ops on reconnect (offline-write story).
    53	//! - **Unbounded outbound mpsc queue.** Memory grows if peer
    54	//!   disconnects mid-flow + caller keeps appending. V2 V4 will switch
    55	//!   to bounded with caller-configurable backpressure policy.
    56	//! - **Client-only.** Server-side WebSocket impls use other libraries
    57	//!   (`axum-tungstenite`, `warp::ws`, etc.).
    58	//! - **Drops text/ping/pong/close frames as inbound data.** Loro
    59	//!   payloads are binary blobs; non-binary frames don't carry our
    60	//!   protocol. Close frames trigger task exit; ping is handled by
    61	//!   tokio-tungstenite's internal auto-pong; text frames are
    62	//!   silently dropped (a future protocol extension could add a
    63	//!   callback hook).
    64	//!
    65	//! ## Example
    66	//!
    67	//! ```ignore
    68	//! use ql_collab::{CollabSession, PeerId, AutoFlushPolicy};
    69	//! use ql_collab_ws::WebSocketTransport;
    70	//!
    71	//! let rt = tokio::runtime::Runtime::new()?;
    72	//! let ws = rt.block_on(WebSocketTransport::connect("ws://localhost:8080"))?;
    73	//! let mut session = CollabSession::new(PeerId::new(1))?;
    74	//! session.attach_transport(ws);
    75	//! session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
    76	//! // ... appends now propagate via WebSocket automatically ...
    77	//! ```
    78	
    79	use std::sync::atomic::{AtomicBool, Ordering};
    80	use std::sync::Arc;
    81	
    82	use futures_util::{SinkExt, StreamExt};
    83	use ql_collab::{Transport, TransportError};
    84	use thiserror::Error;
    85	use tokio::sync::mpsc;
    86	use tokio::task::JoinHandle;
    87	use tokio_tungstenite::tungstenite::Message;
    88	
    89	/// Errors emitted when constructing a [`WebSocketTransport`].
    90	///
    91	/// Distinguishes URL-format errors (caller mistake) from connection
    92	/// errors (network state). Maps tungstenite errors opaquely — we
    93	/// don't want to leak tungstenite types into the public API.
    94	#[derive(Debug, Error)]
    95	#[non_exhaustive]
    96	pub enum WebSocketError {
    97	    /// The URL string failed to parse or is missing required parts.
    98	    /// Per CLAUDE.md no-fallback rule: surface clearly, don't silently
    99	    /// retry with a "fixed up" URL.
   100	    #[error("invalid WebSocket URL: {0}")]
   101	    InvalidUrl(String),
   102	
   103	    /// TCP connect failed (refused, timeout, DNS, etc.).
   104	    #[error("WebSocket connection failed: {0}")]
   105	    ConnectFailed(String),
   106	
   107	    /// WebSocket protocol handshake failed (HTTP upgrade rejected,
   108	    /// invalid response, etc.).
   109	    #[error("WebSocket handshake failed: {0}")]
   110	    HandshakeFailed(String),
   111	}
   112	
   113	/// Phase 5.5 V2 V3 step 4 — WebSocket `Transport` impl.
   114	///
   115	/// Bridges async tokio-tungstenite to the sync `Transport` trait via
   116	/// `tokio::sync::mpsc` channels and two spawned background tasks.
   117	/// See module-level docs for architecture diagram.
   118	///
   119	/// ## Construction
   120	///
   121	/// Use [`connect`](Self::connect) — async fn that performs the WS
   122	/// handshake. Caller pattern from sync code:
   123	///
   124	/// ```ignore
   125	/// let rt = tokio::runtime::Runtime::new()?;
   126	/// let ws = rt.block_on(WebSocketTransport::connect("ws://host:port"))?;
   127	/// session.attach_transport(ws);
   128	/// ```
   129	///
   130	/// ## Send/Sync
   131	///
   132	/// `WebSocketTransport: Send` (asserted via compile-time const). Not
   133	/// `Sync` — exclusive ownership is required because `try_recv` takes
   134	/// `&mut self` (the mpsc receiver is single-consumer). This matches
   135	/// the `CollabSession::transport: Box<dyn Transport + Send>`
   136	/// constraint.
   137	pub struct WebSocketTransport {
   138	    /// Caller-side sender feeding the writer task. Sync write via
   139	    /// `UnboundedSender::send` (which is non-blocking).
   140	    outbound_tx: mpsc::UnboundedSender<Vec<u8>>,
   141	    /// Caller-side receiver pulling from the reader task. Sync drain
   142	    /// via `UnboundedReceiver::try_recv`.
   143	    inbound_rx: mpsc::UnboundedReceiver<Vec<u8>>,
   144	    /// Set true when either task observes a permanent failure (WS
   145	    /// close, IO error, peer disconnect) OR caller invokes
   146	    /// [`close`](Self::close). Both `send` and `try_recv` honor this
   147	    /// flag per the `Transport` trait drain-before-close contract.
   148	    closed: Arc<AtomicBool>,
   149	    /// Background tokio task that drains `outbound_rx` and writes
   150	    /// `Message::Binary` frames to the WebSocket sink. Aborted on
   151	    /// `Drop`.
   152	    writer_task: JoinHandle<()>,
   153	    /// Background tokio task that polls the WebSocket stream and
   154	    /// pushes binary payloads into `inbound_tx`. Aborted on `Drop`.
   155	    reader_task: JoinHandle<()>,
   156	}
   157	
   158	impl std::fmt::Debug for WebSocketTransport {
   159	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
   160	        f.debug_struct("WebSocketTransport")
   161	            .field("closed", &self.closed.load(Ordering::Relaxed))
   162	            .field("writer_finished", &self.writer_task.is_finished())
   163	            .field("reader_finished", &self.reader_task.is_finished())
   164	            .finish()
   165	    }
   166	}
   167	
   168	impl WebSocketTransport {
   169	    /// Connect to a WebSocket server at `url` (e.g. `ws://host:port/path`).
   170	    ///
   171	    /// Must be called from within a tokio runtime context (the two
   172	    /// background tasks are spawned via `tokio::spawn`). The typical
   173	    /// pattern from sync code is `runtime.block_on(connect(...))`.
   174	    ///
   175	    /// On success, returns a fully-wired transport: send/recv channels
   176	    /// connected, background tasks running. On failure, returns one
   177	    /// of the [`WebSocketError`] variants with the underlying cause.
   178	    pub async fn connect(url: &str) -> Result<Self, WebSocketError> {
   179	        // tokio-tungstenite::connect_async handles URL parse + TCP
   180	        // connect + WS handshake in one call. Distinguish the failure
   181	        // modes via the returned error string match — opaque to keep
   182	        // tungstenite types out of our public API.
   183	        let (ws_stream, _response) = tokio_tungstenite::connect_async(url).await.map_err(|e| {
   184	            let msg = e.to_string();
   185	            // Coarse classification — tungstenite::Error doesn't have a
   186	            // clean discriminant for "URL parse" vs "TCP connect" vs
   187	            // "handshake". Use the error type to route.
   188	            match e {
   189	                tokio_tungstenite::tungstenite::Error::Url(_) => WebSocketError::InvalidUrl(msg),
   190	                tokio_tungstenite::tungstenite::Error::Io(_) => WebSocketError::ConnectFailed(msg),
   191	                tokio_tungstenite::tungstenite::Error::Http(_)
   192	                | tokio_tungstenite::tungstenite::Error::HttpFormat(_) => {
   193	                    WebSocketError::HandshakeFailed(msg)
   194	                }
   195	                _ => WebSocketError::HandshakeFailed(msg),
   196	            }
   197	        })?;
   198	
   199	        let (mut ws_sink, mut ws_stream) = ws_stream.split();
   200	
   201	        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();
   202	        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();
   203	
   204	        let closed = Arc::new(AtomicBool::new(false));
   205	        let closed_writer = Arc::clone(&closed);
   206	        let closed_reader = Arc::clone(&closed);
   207	
   208	        // Writer task: drains outbound mpsc, writes Binary frames to
   209	        // the WS sink. Exits on outbound_rx close (caller dropped
   210	        // outbound_tx, which happens when WebSocketTransport drops)
   211	        // OR on sink error.
   212	        let writer_task = tokio::spawn(async move {
   213	            while let Some(bytes) = outbound_rx.recv().await {
   214	                if let Err(_e) = ws_sink.send(Message::Binary(bytes.into())).await {
   215	                    closed_writer.store(true, Ordering::Relaxed);
   216	                    return;
   217	                }
   218	            }
   219	            // outbound_rx closed (sender dropped) — clean shutdown.
   220	            // Attempt a graceful WS close frame; ignore errors (peer
   221	            // may already be gone).
   222	            let _ = ws_sink.close().await;
   223	        });
   224	
   225	        // Reader task: polls WS stream; pushes binary payloads into
   226	        // inbound mpsc. Exits on stream end, error, or Close frame.
   227	        let reader_task = tokio::spawn(async move {
   228	            while let Some(msg_result) = ws_stream.next().await {
   229	                match msg_result {
   230	                    Ok(Message::Binary(bytes)) => {
   231	                        if inbound_tx.send(bytes.to_vec()).is_err() {
   232	                            // Receiver dropped (WebSocketTransport
   233	                            // dropped) — exit cleanly.
   234	                            return;
   235	                        }
   236	                    }
   237	                    Ok(Message::Close(_)) => {
   238	                        closed_reader.store(true, Ordering::Relaxed);
   239	                        return;
   240	                    }
   241	                    Ok(
   242	                        Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_),
   243	                    ) => {
   244	                        // Non-binary frames dropped per protocol
   245	                        // contract (see module-level V1 limits).
   246	                    }
   247	                    Err(_e) => {
   248	                        closed_reader.store(true, Ordering::Relaxed);
   249	                        return;
   250	                    }
   251	                }
   252	            }
   253	            // Stream ended (peer closed) — mark closed.
   254	            closed_reader.store(true, Ordering::Relaxed);
   255	        });
   256	
   257	        Ok(Self {
   258	            outbound_tx,
   259	            inbound_rx,
   260	            closed,
   261	            writer_task,
   262	            reader_task,
   263	        })
   264	    }
   265	
   266	    /// True if this transport has been closed — either explicitly via
   267	    /// [`close`](Self::close), via Drop, or by either background task
   268	    /// observing a permanent failure (peer disconnect, WS Close frame,
   269	    /// IO error).
   270	    pub fn is_closed(&self) -> bool {
   271	        self.closed.load(Ordering::Relaxed)
   272	    }
   273	
   274	    /// Explicitly mark this transport closed. Subsequent
   275	    /// [`Transport::send`] calls return `Err(Closed)`; subsequent
   276	    /// [`Transport::try_recv`] calls drain the inbound queue first,
   277	    /// then return `Err(Closed)` (per trait contract).
   278	    ///
   279	    /// Does NOT abort the background tasks — only Drop does that. If
   280	    /// the caller wants the tasks gone, drop the transport.
   281	    pub fn close(&self) {
   282	        self.closed.store(true, Ordering::Relaxed);
   283	    }
   284	}
   285	
   286	impl Drop for WebSocketTransport {
   287	    fn drop(&mut self) {
   288	        // Set closed first so any concurrent send/try_recv observes
   289	        // it. Then abort tasks. Dropping `outbound_tx` (when self is
   290	        // dropped) signals the writer task to exit gracefully via
   291	        // `outbound_rx.recv()` returning None; abort() is a safety
   292	        // net for the reader task which awaits on the WS stream and
   293	        // won't otherwise notice the caller is gone.
   294	        self.closed.store(true, Ordering::Relaxed);
   295	        self.writer_task.abort();
   296	        self.reader_task.abort();
   297	    }
   298	}
   299	
   300	impl Transport for WebSocketTransport {
   301	    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
   302	        if self.closed.load(Ordering::Relaxed) {
   303	            return Err(TransportError::Closed);
   304	        }
   305	        // UnboundedSender::send returns Err iff the receiver dropped.
   306	        // The receiver lives in the writer task; if it dropped, the
   307	        // task exited (panic, abort, or graceful). Treat as Closed.
   308	        self.outbound_tx
   309	            .send(bytes.to_vec())
   310	            .map_err(|_| TransportError::Closed)
   311	    }
   312	
   313	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
   314	        // Drain-before-close per `Transport` trait contract
   315	        // (transport.rs:112-115): "Closed only when channel
   316	        // permanently closed AND internal queue is empty."
   317	        use mpsc::error::TryRecvError;
   318	        match self.inbound_rx.try_recv() {
   319	            Ok(bytes) => Ok(Some(bytes)),
   320	            Err(TryRecvError::Empty) => {
   321	                if self.closed.load(Ordering::Relaxed) {
   322	                    Err(TransportError::Closed)
   323	                } else {
   324	                    Ok(None)
   325	                }
   326	            }
   327	            Err(TryRecvError::Disconnected) => {
   328	                // Reader task exited and dropped inbound_tx. Mark
   329	                // closed so subsequent calls fast-path; treat as
   330	                // Closed for this call (the queue is empty AND the
   331	                // upstream is permanently gone).
   332	                self.closed.store(true, Ordering::Relaxed);
   333	                Err(TransportError::Closed)
   334	            }
   335	        }
   336	    }
   337	}
   338	
   339	// Phase 5.5 V2 V3 step 4 — pin the Send invariant. CollabSession
   340	// stores `Box<dyn Transport + Send>`; if a future refactor adds a
   341	// non-Send field this stops compiling. Sync is NOT required.
   342	const _ASSERT_WEBSOCKET_TRANSPORT_SEND: fn() = || {
   343	    fn assert_send<T: Send>() {}
   344	    assert_send::<WebSocketTransport>();
   345	};
   346	
   347	#[cfg(test)]
   348	mod tests {
   349	    use super::*;
   350	
   351	    #[test]
   352	    fn websocket_error_display_includes_cause() {
   353	        let e = WebSocketError::InvalidUrl("malformed".into());
   354	        assert!(e.to_string().contains("malformed"));
   355	        let e = WebSocketError::ConnectFailed("refused".into());
   356	        assert!(e.to_string().contains("refused"));
   357	        let e = WebSocketError::HandshakeFailed("401".into());
   358	        assert!(e.to_string().contains("401"));
   359	    }
   360	

 succeeded in 264ms:
     1	//! Shared test fixtures for ql-collab-ws integration tests.
     2	//!
     3	//! In-process WebSocket echo server bound to 127.0.0.1:0 (OS-assigned
     4	//! port). Echoes binary frames back to sender; drops text/ping/pong.
     5	//! `Drop` aborts the listener loop.
     6	
     7	use std::net::SocketAddr;
     8	use std::sync::{Arc, Mutex};
     9	
    10	use futures_util::{SinkExt, StreamExt};
    11	use tokio::net::{TcpListener, TcpStream};
    12	use tokio::task::JoinHandle;
    13	use tokio_tungstenite::tungstenite::Message;
    14	
    15	/// In-process WebSocket echo server. Echoes every binary frame back
    16	/// to the sender. Listens on 127.0.0.1:0 (OS-assigned port). Use
    17	/// [`url`](Self::url) to get the `ws://127.0.0.1:PORT` URL for the
    18	/// client to connect to.
    19	///
    20	/// **Drop semantics:** aborts the accept loop AND every per-connection
    21	/// task spawned during the lifetime of this server. The per-conn
    22	/// abort is what tears down the live TCP socket → the client-side
    23	/// reader observes EOF and marks closed. Without per-conn tracking,
    24	/// `drop(server)` would only stop accepting NEW connections and
    25	/// existing ones would dangle until the test process exits.
    26	pub struct EchoServer {
    27	    addr: SocketAddr,
    28	    accept_task: JoinHandle<()>,
    29	    conn_tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    30	}
    31	
    32	impl EchoServer {
    33	    /// Bind a TcpListener on 127.0.0.1:0 and spawn an accept loop.
    34	    /// Each incoming connection is upgraded to a WebSocket and runs
    35	    /// a per-connection echo loop in its own spawned task. The
    36	    /// per-conn JoinHandle is recorded on `conn_tasks` so `Drop` can
    37	    /// abort it.
    38	    pub async fn start() -> Self {
    39	        let listener = TcpListener::bind("127.0.0.1:0")
    40	            .await
    41	            .expect("bind 127.0.0.1:0 in test");
    42	        let addr = listener
    43	            .local_addr()
    44	            .expect("local_addr after successful bind");
    45	        let conn_tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
    46	        let conn_tasks_in_accept = Arc::clone(&conn_tasks);
    47	        let accept_task = tokio::spawn(async move {
    48	            loop {
    49	                match listener.accept().await {
    50	                    Ok((stream, _peer_addr)) => {
    51	                        let handle = tokio::spawn(handle_echo_connection(stream));
    52	                        if let Ok(mut tasks) = conn_tasks_in_accept.lock() {
    53	                            tasks.push(handle);
    54	                        }
    55	                    }
    56	                    Err(_) => return,
    57	                }
    58	            }
    59	        });
    60	        Self {
    61	            addr,
    62	            accept_task,
    63	            conn_tasks,
    64	        }
    65	    }
    66	
    67	    /// `ws://127.0.0.1:PORT` URL the client should connect to.
    68	    pub fn url(&self) -> String {
    69	        format!("ws://{}", self.addr)
    70	    }
    71	}
    72	
    73	impl Drop for EchoServer {
    74	    fn drop(&mut self) {
    75	        // Abort the accept loop first so no NEW per-conn tasks land
    76	        // in conn_tasks during teardown. Then abort every per-conn
    77	        // task — each task owns its TCP stream, so abort drops the
    78	        // stream and the client observes a TCP RST / EOF.
    79	        self.accept_task.abort();
    80	        if let Ok(mut tasks) = self.conn_tasks.lock() {
    81	            for h in tasks.drain(..) {
    82	                h.abort();
    83	            }
    84	        }
    85	    }
    86	}
    87	
    88	async fn handle_echo_connection(stream: TcpStream) {
    89	    let mut ws = match tokio_tungstenite::accept_async(stream).await {
    90	        Ok(ws) => ws,
    91	        Err(_) => return,
    92	    };
    93	    while let Some(msg_result) = ws.next().await {
    94	        match msg_result {
    95	            Ok(Message::Binary(bytes)) => {
    96	                if ws.send(Message::Binary(bytes)).await.is_err() {
    97	                    return;
    98	                }
    99	            }
   100	            Ok(Message::Close(_)) => return,
   101	            Ok(_) => {}
   102	            Err(_) => return,
   103	        }
   104	    }
   105	}
   106	
   107	/// One-shot client-side TCP server that accepts a single connection,
   108	/// then closes it without completing the WebSocket handshake. Used
   109	/// to drive `HandshakeFailed` paths without an external dependency.
   110	pub struct RejectingServer {
   111	    addr: SocketAddr,
   112	    accept_task: JoinHandle<()>,
   113	}
   114	
   115	impl RejectingServer {
   116	    pub async fn start() -> Self {
   117	        let listener = TcpListener::bind("127.0.0.1:0")
   118	            .await
   119	            .expect("bind 127.0.0.1:0 in test");
   120	        let addr = listener
   121	            .local_addr()
   122	            .expect("local_addr after successful bind");
   123	        let accept_task = tokio::spawn(async move {
   124	            // Accept one TCP connection then drop it — the client's
   125	            // WS handshake sees EOF and fails.
   126	            if let Ok((_stream, _)) = listener.accept().await {
   127	                // _stream drops here; client sees connection reset.
   128	            }
   129	        });
   130	        Self { addr, accept_task }
   131	    }
   132	
   133	    pub fn url(&self) -> String {
   134	        format!("ws://{}", self.addr)
   135	    }
   136	}
   137	
   138	impl Drop for RejectingServer {
   139	    fn drop(&mut self) {
   140	        self.accept_task.abort();
   141	    }
   142	}

codex
The main implementation matches the stated two-task bridge shape so far. I’m now reading the integration tests with line numbers and cross-checking their names against their actual assertions, especially around close propagation and reattach behavior.
exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/transport.rs | sed -n '1,180p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab-ws/tests/websocket_transport.rs | sed -n '1,420p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba Cargo.toml | sed -n '1,180p' && nl -ba crates/ql-collab-ws/Cargo.toml | sed -n '1,180p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 288ms:
     1	//! `Transport` trait — wire-byte channel for Phase 5 collaboration.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold):** trait shape defined.
     4	//! **Phase 5.5 V1 (2026-05-19, `924750819bc`):** `LoopbackTransport`
     5	//! shipped — in-process paired endpoints for 2-peer tests.
     6	//! **Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05` + audit closure):**
     7	//! `CollabSession` exposes 5 typed transport methods
     8	//! (`attach_transport` / `detach_transport` / `has_transport` /
     9	//! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
    10	//! V2 V1 is "explicit drive" — caller invokes flush + poll on a
    11	//! tick.
    12	//! **Phase 5.5 V2 V2 (2026-05-21):** `AutoFlushPolicy` enum on
    13	//! `CollabSession`. Opt-in `OnAppend` invokes flush automatically
    14	//! after every mutator. Default is `Disabled` (V2 V1 behavior
    15	//! preserved). See [`crate::AutoFlushPolicy`] +
    16	//! [`crate::CollabSession::set_auto_flush_policy`].
    17	//! **Phase 5.5 V2 V3 step 1 (2026-05-21):** version-vector tracking
    18	//! for the **currently attached** transport baseline + delta flushes.
    19	//! `CollabSession::flush_delta_to_transport` sends only the delta
    20	//! since the last successful flush via `LoroDoc::ExportMode::Updates`.
    21	//! Auto-flush routes through this delta path — wire payload is
    22	//! O(per-op delta) instead of O(full state). Idempotency
    23	//! short-circuit (no state change → no send) closes the V2 V2
    24	//! echo-loop concern. The checkpoint is
    25	//! per-session-currently-attached-transport, NOT per-transport-
    26	//! identity (`attach_transport` resets the baseline).
    27	//! **Phase 5.5 V2 V3 step 2 (2026-05-21):** wires `poll_remote*`
    28	//! into auto-flush. After a successful drain (`merged > 0`), one
    29	//! auto-flush fires per call (not per-blob — bandwidth-efficient).
    30	//! V2 V3 step 1's idempotency guard prevents echo loops: drained
    31	//! bytes that Loro dedupes leave the VV unchanged → flush
    32	//! short-circuits to `Ok(false)`. 3-peer hub-fanout pattern now
    33	//! works automatically under `OnAppend`.
    34	//! **Phase 5.5 V2 V3 step 3 (2026-05-21):** offline-write story.
    35	//! Investigation showed no explicit queue is needed: Loro's CRDT op
    36	//! log IS the implicit offline queue. Append while no transport
    37	//! attached → `maybe_auto_flush` no-ops; op committed locally. On
    38	//! reattach: `attach_transport` resets `last_flushed_vv = None`; the
    39	//! next mutator (or explicit `flush_delta_to_transport`) sends from
    40	//! empty VV — delivers ALL accumulated ops including offline ones.
    41	//! Adds `has_pending_flush() -> bool` ergonomic helper (compares
    42	//! current VV vs last-flushed VV). 7 new integration tests pin the
    43	//! offline-write contract.
    44	//!
    45	//! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
    46	//! production-grade `Transport` impl ships as a separate crate,
    47	//! `ql-collab-ws::WebSocketTransport`. Bridges async
    48	//! tokio-tungstenite to the sync `Transport` trait via
    49	//! `tokio::sync::mpsc` channels and two spawned background tasks
    50	//! (reader and writer). Kept in a sibling crate so `ql-collab`
    51	//! core stays runtime-agnostic; embedders needing only
    52	//! `LoopbackTransport` or a custom impl don't pay for tokio. MVP
    53	//! scope: client-only, plain `ws://`, NO TLS, NO auto-reconnect
    54	//! (caller drives via detach and re-attach; V2 V3 step 1
    55	//! baseline-reset contract delivers offline ops on reconnect).
    56	//! 13 integration tests including 3 that verify the V2 V2 and
    57	//! V2 V3 step 1-3 contracts hold over a real WebSocket. See
    58	//! `ql-collab-ws` module docs for V1 limitations deferred to V2 V4
    59	//! (TLS, auto-reconnect, bounded queue, server side).
    60	//!
    61	//! **Phase 5.5 V2 V3 remaining (pending):** full-arc megaudit
    62	//! (step 5) and exit packet (step 6).
    63	//!
    64	//! Tests can also use [`NoopTransport`] which discards traffic.
    65	//!
    66	//! The contract is intentionally minimal:
    67	//!
    68	//! - `send(&mut self, bytes: &[u8])` — push bytes to the channel.
    69	//!   Bytes are an opaque blob (a Loro export). The transport
    70	//!   doesn't interpret them.
    71	//! - `try_recv(&mut self) -> Option<Vec<u8>>` — non-blocking
    72	//!   receive. Returns `None` if no bytes are queued.
    73	//!
    74	//! That's enough to plumb a `CollabSession::export_bytes` →
    75	//! transport → remote `CollabSession::merge_bytes` flow. The
    76	//! transport handles framing / reliability / reconnect / auth as
    77	//! its implementation details.
    78	
    79	use std::collections::VecDeque;
    80	use std::sync::atomic::{AtomicBool, Ordering};
    81	use std::sync::{Arc, Mutex};
    82	
    83	use thiserror::Error;
    84	
    85	/// Errors emitted by `Transport` impls.
    86	#[derive(Debug, Error)]
    87	#[non_exhaustive]
    88	pub enum TransportError {
    89	    /// The underlying I/O failed (socket dead, network partition,
    90	    /// etc.). Implementations should distinguish recoverable
    91	    /// (reconnect) from permanent (auth rejected) failures via
    92	    /// variant structure in their own error type, then map to this
    93	    /// variant at the trait boundary if they don't want to expose
    94	    /// implementation details.
    95	    #[error("transport I/O error: {0}")]
    96	    Io(String),
    97	
    98	    /// The transport is closed and no further sends are accepted.
    99	    /// Receivers should still drain any already-queued bytes via
   100	    /// `try_recv` before considering the channel done.
   101	    #[error("transport closed")]
   102	    Closed,
   103	}
   104	
   105	/// Wire-byte channel for Phase 5 collaboration.
   106	///
   107	/// Implementations push and pull opaque byte blobs. The blobs ARE
   108	/// Loro `LoroDoc::export(...)` snapshots / updates; the
   109	/// transport doesn't interpret them. Framing (where one blob ends
   110	/// and the next starts) is the implementation's responsibility.
   111	pub trait Transport {
   112	    /// Push `bytes` to the channel. Implementations may buffer
   113	    /// internally; the call returns when the bytes are
   114	    /// **queued for send**, not when the remote has received them.
   115	    ///
   116	    /// On error, the caller should treat the byte blob as unsent
   117	    /// and re-queue (or surface the error to the user). The
   118	    /// transport will not retry automatically — that policy lives
   119	    /// at the layer above (Phase 5.5 design will pick reconnect
   120	    /// semantics).
   121	    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
   122	
   123	    /// Non-blocking receive. Returns `Some(bytes)` if a blob is
   124	    /// queued, `None` otherwise. Implementations choose how often
   125	    /// they poll the underlying channel; the contract is "if you
   126	    /// have something, give it to me, else `None`."
   127	    ///
   128	    /// Returns `Err(TransportError::Closed)` only when the channel
   129	    /// is permanently closed AND its internal queue is empty. A
   130	    /// transient I/O failure during poll surfaces as
   131	    /// `Err(TransportError::Io)`.
   132	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
   133	}
   134	
   135	/// No-op `Transport` impl for tests + scaffolding.
   136	///
   137	/// Records every `send` call in an internal `Vec` (so tests can
   138	/// assert what would have gone over the wire) and `try_recv`
   139	/// returns `None` forever (no incoming bytes). Suitable for tests
   140	/// that exercise `CollabSession::append_op` without needing a
   141	/// real channel. For 2-peer round-trip tests, use
   142	/// [`LoopbackTransport::pair`] instead — `NoopTransport` is for
   143	/// "I just need a Transport-shaped object" cases.
   144	#[derive(Debug, Default)]
   145	pub struct NoopTransport {
   146	    /// Bytes the consumer would have pushed to the wire. Tests
   147	    /// inspect this to verify their `CollabSession` calls emit the
   148	    /// expected number / shape of exports.
   149	    pub sent: Vec<Vec<u8>>,
   150	    closed: bool,
   151	}
   152	
   153	impl NoopTransport {
   154	    /// Construct a fresh `NoopTransport` with an empty `sent` log
   155	    /// and `closed = false`.
   156	    pub fn new() -> Self {
   157	        Self::default()
   158	    }
   159	
   160	    /// Mark the channel closed. Subsequent `send` calls return
   161	    /// `TransportError::Closed`; `try_recv` returns `Closed` since
   162	    /// nothing's queued.
   163	    pub fn close(&mut self) {
   164	        self.closed = true;
   165	    }
   166	}
   167	
   168	impl Transport for NoopTransport {
   169	    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
   170	        if self.closed {
   171	            return Err(TransportError::Closed);
   172	        }
   173	        self.sent.push(bytes.to_vec());
   174	        Ok(())
   175	    }
   176	
   177	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
   178	        if self.closed {
   179	            return Err(TransportError::Closed);
   180	        }

 succeeded in 288ms:
     1	//! Phase 5.5 V2 V3 step 4 (2026-05-21) — `WebSocketTransport`
     2	//! integration tests against an in-process echo server.
     3	//!
     4	//! All tests run on a `current_thread` tokio runtime built per-test
     5	//! so they're independently schedulable; `--test-threads=1` is fine
     6	//! (matches the rest of the workspace gate). The test fixture
     7	//! ([`common::EchoServer`]) binds 127.0.0.1:0 → no port conflicts.
     8	
     9	mod common;
    10	
    11	use std::time::Duration;
    12	
    13	use ql_collab::{
    14	    AutoFlushPolicy, CollabSession, CollabSessionError, PeerId, Transport, TransportError,
    15	};
    16	use ql_collab_ws::{WebSocketError, WebSocketTransport};
    17	use ql_oplog::{CellWireValue, Op};
    18	
    19	use crate::common::{EchoServer, RejectingServer};
    20	
    21	fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
    22	    Op::PutValue {
    23	        sheet,
    24	        row,
    25	        col,
    26	        value: CellWireValue::Number(n),
    27	    }
    28	}
    29	
    30	fn add_sheet() -> Op {
    31	    Op::AddSheet {
    32	        name: "S".to_owned(),
    33	        chunk_rows: 16384,
    34	    }
    35	}
    36	
    37	/// Build a single-threaded tokio runtime for one test. Each test owns
    38	/// its runtime so panics + abort() cleanups can't leak across tests.
    39	fn runtime() -> tokio::runtime::Runtime {
    40	    tokio::runtime::Builder::new_current_thread()
    41	        .enable_all()
    42	        .build()
    43	        .expect("build tokio runtime")
    44	}
    45	
    46	/// Poll `try_recv` with short sleeps for up to `max_iters * 10ms`
    47	/// looking for a binary blob. Async background tasks need a chance
    48	/// to deliver bytes; tests block on this helper.
    49	async fn await_blob(transport: &mut WebSocketTransport, max_iters: u32) -> Option<Vec<u8>> {
    50	    for _ in 0..max_iters {
    51	        match transport.try_recv() {
    52	            Ok(Some(b)) => return Some(b),
    53	            Ok(None) => tokio::time::sleep(Duration::from_millis(10)).await,
    54	            Err(_) => return None,
    55	        }
    56	    }
    57	    None
    58	}
    59	
    60	// =============================================================
    61	// Connect path
    62	// =============================================================
    63	
    64	#[test]
    65	fn connect_to_echo_server_succeeds() {
    66	    let rt = runtime();
    67	    rt.block_on(async {
    68	        let server = EchoServer::start().await;
    69	        let ws = WebSocketTransport::connect(&server.url())
    70	            .await
    71	            .expect("handshake to echo server");
    72	        assert!(!ws.is_closed(), "fresh transport is open");
    73	    });
    74	}
    75	
    76	#[test]
    77	fn connect_to_invalid_url_returns_err() {
    78	    let rt = runtime();
    79	    rt.block_on(async {
    80	        // Missing scheme.
    81	        let result = WebSocketTransport::connect("not-a-url").await;
    82	        assert!(
    83	            matches!(result, Err(WebSocketError::InvalidUrl(_))),
    84	            "expected InvalidUrl, got {:?}",
    85	            result.err()
    86	        );
    87	    });
    88	}
    89	
    90	#[test]
    91	fn connect_to_nonexistent_server_returns_connect_failed() {
    92	    let rt = runtime();
    93	    rt.block_on(async {
    94	        // Port 1 is reserved for tcpmux, virtually nothing listens
    95	        // there. Connect should be refused.
    96	        let result = WebSocketTransport::connect("ws://127.0.0.1:1").await;
    97	        assert!(
    98	            matches!(result, Err(WebSocketError::ConnectFailed(_))),
    99	            "expected ConnectFailed, got {:?}",
   100	            result.err()
   101	        );
   102	    });
   103	}
   104	
   105	#[test]
   106	fn connect_to_non_websocket_tcp_server_returns_handshake_or_connect_failed() {
   107	    let rt = runtime();
   108	    rt.block_on(async {
   109	        let bad_server = RejectingServer::start().await;
   110	        let result = WebSocketTransport::connect(&bad_server.url()).await;
   111	        // RejectingServer accepts the TCP connection then drops it.
   112	        // tokio-tungstenite sees EOF mid-handshake → reported as Io
   113	        // (ConnectFailed) on some platforms, HandshakeFailed on
   114	        // others. Either is acceptable; the important thing is we
   115	        // got an error, not a successful Self.
   116	        assert!(
   117	            matches!(
   118	                result,
   119	                Err(WebSocketError::HandshakeFailed(_)) | Err(WebSocketError::ConnectFailed(_))
   120	            ),
   121	            "expected HandshakeFailed or ConnectFailed, got {:?}",
   122	            result.err()
   123	        );
   124	    });
   125	}
   126	
   127	// =============================================================
   128	// Round-trip via echo server
   129	// =============================================================
   130	
   131	#[test]
   132	fn send_recv_round_trip_via_echo_server() {
   133	    let rt = runtime();
   134	    rt.block_on(async {
   135	        let server = EchoServer::start().await;
   136	        let mut ws = WebSocketTransport::connect(&server.url())
   137	            .await
   138	            .expect("handshake");
   139	        ws.send(b"hello-loro-blob").expect("send queued");
   140	        let echoed = await_blob(&mut ws, 100).await;
   141	        assert_eq!(
   142	            echoed.as_deref(),
   143	            Some(b"hello-loro-blob".as_slice()),
   144	            "echo server must reflect the bytes back"
   145	        );
   146	    });
   147	}
   148	
   149	#[test]
   150	fn multiple_sends_preserve_fifo_order_through_echo() {
   151	    let rt = runtime();
   152	    rt.block_on(async {
   153	        let server = EchoServer::start().await;
   154	        let mut ws = WebSocketTransport::connect(&server.url())
   155	            .await
   156	            .expect("handshake");
   157	        for i in 0..5u8 {
   158	            ws.send(&[i, i + 10]).expect("send");
   159	        }
   160	        let mut received = Vec::new();
   161	        for _ in 0..5 {
   162	            let b = await_blob(&mut ws, 100).await.expect("blob");
   163	            received.push(b);
   164	        }
   165	        let expected: Vec<Vec<u8>> = (0..5u8).map(|i| vec![i, i + 10]).collect();
   166	        assert_eq!(
   167	            received, expected,
   168	            "FIFO order must be preserved through WebSocket echo"
   169	        );
   170	    });
   171	}
   172	
   173	// =============================================================
   174	// Closed semantics
   175	// =============================================================
   176	
   177	#[test]
   178	fn explicit_close_blocks_send_returns_closed() {
   179	    let rt = runtime();
   180	    rt.block_on(async {
   181	        let server = EchoServer::start().await;
   182	        let mut ws = WebSocketTransport::connect(&server.url())
   183	            .await
   184	            .expect("handshake");
   185	        ws.close();
   186	        assert!(ws.is_closed());
   187	        let r = ws.send(b"after-close");
   188	        assert!(
   189	            matches!(r, Err(TransportError::Closed)),
   190	            "send after explicit close MUST surface Closed"
   191	        );
   192	    });
   193	}
   194	
   195	#[test]
   196	fn explicit_close_drains_inbox_before_returning_closed() {
   197	    let rt = runtime();
   198	    rt.block_on(async {
   199	        // Trait contract (transport.rs:112-115): Closed only when
   200	        // permanently closed AND queue empty. Pre-load the inbox
   201	        // before close.
   202	        let server = EchoServer::start().await;
   203	        let mut ws = WebSocketTransport::connect(&server.url())
   204	            .await
   205	            .expect("handshake");
   206	        ws.send(b"queued-before-close").expect("send");
   207	        // Let the echo + delivery happen.
   208	        let echoed = await_blob(&mut ws, 100).await.expect("echo delivered");
   209	        assert_eq!(echoed, b"queued-before-close".to_vec());
   210	        // Now send a second one, give it time to land in the inbox,
   211	        // close, then drain.
   212	        ws.send(b"queued-also").expect("send");
   213	        // Give the reader task a chance to receive it.
   214	        tokio::time::sleep(Duration::from_millis(50)).await;
   215	        ws.close();
   216	        // Drain-before-close: first try_recv must return the blob,
   217	        // THEN return Closed once empty.
   218	        match ws.try_recv() {
   219	            Ok(Some(b)) => {
   220	                assert_eq!(b, b"queued-also".to_vec(), "drained blob is the queued one");
   221	                assert!(matches!(ws.try_recv(), Err(TransportError::Closed)));
   222	            }
   223	            Ok(None) => {
   224	                // Race: reader task hadn't delivered yet. After more
   225	                // sleep, must EITHER deliver the blob (drain-before-close)
   226	                // OR return Closed because the channel is closed and
   227	                // the blob never landed.
   228	                tokio::time::sleep(Duration::from_millis(50)).await;
   229	                let final_r = ws.try_recv();
   230	                assert!(
   231	                    matches!(final_r, Ok(Some(_)) | Err(TransportError::Closed)),
   232	                    "post-close try_recv must be Some or Closed, got {:?}",
   233	                    final_r
   234	                );
   235	            }
   236	            Err(_) => panic!("first try_recv after close should drain first"),
   237	        }
   238	    });
   239	}
   240	
   241	#[test]
   242	fn server_close_propagates_to_try_recv_as_closed() {
   243	    let rt = runtime();
   244	    rt.block_on(async {
   245	        let server = EchoServer::start().await;
   246	        let mut ws = WebSocketTransport::connect(&server.url())
   247	            .await
   248	            .expect("handshake");
   249	        // Drop the server: accept task aborts; existing connection
   250	        // dies when its tokio scope ends. Reader task sees EOF / Err
   251	        // and marks closed.
   252	        drop(server);
   253	        // Give the reader task time to observe the disconnect.
   254	        tokio::time::sleep(Duration::from_millis(200)).await;
   255	        // Subsequent send may succeed initially (writer task queued
   256	        // it) but the connection is gone. Loop try_recv until Closed.
   257	        let mut closed_observed = false;
   258	        for _ in 0..50 {
   259	            match ws.try_recv() {
   260	                Ok(None) => tokio::time::sleep(Duration::from_millis(20)).await,
   261	                Ok(Some(_)) => continue,
   262	                Err(TransportError::Closed) => {
   263	                    closed_observed = true;
   264	                    break;
   265	                }
   266	                Err(other) => panic!("unexpected error: {other:?}"),
   267	            }
   268	        }
   269	        assert!(
   270	            closed_observed,
   271	            "after server drop + grace, try_recv MUST eventually return Closed"
   272	        );
   273	    });
   274	}
   275	
   276	// =============================================================
   277	// Drop / RAII cleanup
   278	// =============================================================
   279	
   280	#[test]
   281	fn drop_aborts_background_tasks() {
   282	    let rt = runtime();
   283	    rt.block_on(async {
   284	        let server = EchoServer::start().await;
   285	        let ws = WebSocketTransport::connect(&server.url())
   286	            .await
   287	            .expect("handshake");
   288	        // Snapshot whether tasks are still running.
   289	        assert!(!ws.is_closed());
   290	        let dbg_before = format!("{:?}", ws);
   291	        assert!(
   292	            dbg_before.contains("writer_finished: false"),
   293	            "writer task is running pre-drop: {dbg_before}"
   294	        );
   295	        assert!(
   296	            dbg_before.contains("reader_finished: false"),
   297	            "reader task is running pre-drop: {dbg_before}"
   298	        );
   299	        drop(ws);
   300	        // After drop, the spawned tasks are abort()ed. We can't
   301	        // re-introspect a dropped transport, but if the tasks weren't
   302	        // aborted they'd leak the tokio runtime past test end. The
   303	        // runtime drop on test exit would block. This test passing
   304	        // (i.e. the test function returning) is the assertion.
   305	    });
   306	}
   307	
   308	// =============================================================
   309	// CollabSession integration — V2 V3 contract verification
   310	// =============================================================
   311	
   312	#[test]
   313	fn collab_session_attach_websocket_round_trip_via_echo() {
   314	    // Highest-value test: wire WebSocketTransport into CollabSession
   315	    // under OnAppend; verify the V2 V3 step 2 + step 3 contract
   316	    // (auto-flush + offline-write reattach) holds over a REAL
   317	    // WebSocket, not just LoopbackTransport.
   318	    let rt = runtime();
   319	    rt.block_on(async {
   320	        let server = EchoServer::start().await;
   321	        let ws = WebSocketTransport::connect(&server.url())
   322	            .await
   323	            .expect("handshake");
   324	
   325	        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
   326	        session.attach_transport(ws);
   327	        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   328	
   329	        // OnAppend + attached WS: each append flushes the delta over
   330	        // the wire. The echo server reflects each blob back; the
   331	        // session's poll_remote drains the inbox and merges.
   332	        session.append_op(add_sheet()).expect("add_sheet");
   333	        session.append_op(put_value(0, 0, 0, 42.0)).expect("put");
   334	
   335	        // Poll until we've drained the echoes (auto-flush is one
   336	        // direction; the echo server reflects each blob back as a
   337	        // separate frame). Loro dedupes on import — but the import
   338	        // still returns the blob count, NOT op count.
   339	        let mut total_merged = 0usize;
   340	        for _ in 0..50 {
   341	            tokio::time::sleep(Duration::from_millis(20)).await;
   342	            let merged = session.poll_remote().expect("poll");
   343	            total_merged += merged;
   344	            if total_merged >= 2 {
   345	                break;
   346	            }
   347	        }
   348	        assert!(
   349	            total_merged >= 1,
   350	            "session.poll_remote MUST receive at least one echoed blob, got {total_merged}"
   351	        );
   352	
   353	        // Session op_count = 2 (add_sheet + put_value). Echo didn't
   354	        // change it (Loro dedupes own peer's ops on re-import).
   355	        assert_eq!(session.op_count(), 2, "Loro dedup keeps op_count stable");
   356	
   357	        // has_pending_flush should be false after auto-flush
   358	        // completed (V2 V3 step 1 idempotency guard).
   359	        assert!(
   360	            !session.has_pending_flush(),
   361	            "OnAppend + attached WS leaves session synced post-mutator"
   362	        );
   363	    });
   364	}
   365	
   366	#[test]
   367	fn collab_session_websocket_reattach_after_close_delivers_offline_ops() {
   368	    // V2 V3 step 3 contract: append while transport detached; reattach
   369	    // (or attach new transport); next auto-flush delivers all
   370	    // accumulated ops. Verifies the contract holds for WS transport
   371	    // identically to LoopbackTransport.
   372	    let rt = runtime();
   373	    rt.block_on(async {
   374	        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
   375	        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   376	
   377	        // Phase 1: NO transport attached. Append ops — they commit
   378	        // locally; maybe_auto_flush no-ops.
   379	        session.append_op(add_sheet()).expect("add_sheet offline");
   380	        session
   381	            .append_op(put_value(0, 0, 0, 1.0))
   382	            .expect("put offline");
   383	        session
   384	            .append_op(put_value(0, 0, 1, 2.0))
   385	            .expect("put offline");
   386	        assert!(session.has_pending_flush(), "offline ops are pending");
   387	        assert!(!session.has_transport());
   388	
   389	        // Phase 2: attach WS. attach_transport resets
   390	        // last_flushed_vv = None per V2 V3 step 1 contract.
   391	        let server = EchoServer::start().await;
   392	        let ws = WebSocketTransport::connect(&server.url())
   393	            .await
   394	            .expect("handshake");
   395	        session.attach_transport(ws);
   396	        assert!(session.has_transport());
   397	        // attach_transport itself doesn't auto-flush (V2 V2 design).
   398	        // The next mutator OR explicit flush_delta_to_transport
   399	        // delivers all accumulated ops.
   400	
   401	        // Phase 3: explicit flush sends from empty VV → all 3 ops
   402	        // delivered as a single delta blob to the server, which
   403	        // echoes it back. Session's poll_remote then drains the
   404	        // echoed blob; Loro dedupes own ops.
   405	        session
   406	            .flush_delta_to_transport()
   407	            .expect("explicit flush succeeds");
   408	        assert!(
   409	            !session.has_pending_flush(),
   410	            "flush leaves session synced (current_vv == last_flushed_vv)"
   411	        );
   412	
   413	        // Drain echo.
   414	        let mut total_merged = 0usize;
   415	        for _ in 0..50 {
   416	            tokio::time::sleep(Duration::from_millis(20)).await;
   417	            total_merged += session.poll_remote().expect("poll");
   418	            if total_merged >= 1 {
   419	                break;
   420	            }

 succeeded in 282ms:
     1	# Quantbook Engine — Cargo workspace
     2	# Phase 0 viability spike. See ../.plans/_QUANTBOOK-v1-SPECIFICATION.md Part V.
     3	#
     4	# IMPORTANT: per Cargo's rules (https://doc.rust-lang.org/cargo/reference/workspaces.html),
     5	# [workspace.dependencies] entries CANNOT carry `optional = true`. Optionality lives on the
     6	# consuming crate's Cargo.toml. There is no `[workspace.features]` table — features belong on
     7	# member crates. This file is the result of codex r9 audit corrections.
     8	
     9	[workspace]
    10	resolver = "2"
    11	members = ["crates/*"]
    12	# Phase 0 active set (other crates are stubs reserving the workspace tree):
    13	default-members = [
    14	    "crates/ql-types",
    15	    "crates/ql-storage",
    16	    "crates/ql-formula-syntax",
    17	    "crates/ql-formula-semantics",
    18	    "crates/ql-functions",
    19	    "crates/ql-calcgraph",
    20	    "crates/ql-exec",
    21	    "crates/ql-bench",
    22	    "crates/ql-profile",
    23	    "crates/ql-oplog",
    24	    "crates/ql-terminal",
    25	]
    26	
    27	[workspace.package]
    28	version = "0.1.0"
    29	edition = "2021"
    30	# MSRV floor 1.85: required for edition2024 (clap_lex 1.1.0 transitively via criterion). Day 2
    31	# bump from 1.83. Build is pinned to 1.95.0 in rust-toolchain.toml.
    32	rust-version = "1.85"
    33	license = "MIT OR Apache-2.0"
    34	publish = false
    35	
    36	[workspace.dependencies]
    37	# Apache Arrow — exact pins for Phase 0. All 7 crates kept in lock-step at the same patch
    38	# (58.3.0 is the latest 58.x patch as of 2026-05-11; arrow-array 58.1.0's `^58` transitive
    39	# would otherwise drift arrow-buffer to 58.3 and break the pin guard).
    40	arrow = "=58.3.0"
    41	arrow-array = "=58.3.0"
    42	arrow-buffer = "=58.3.0"
    43	arrow-schema = "=58.3.0"
    44	arrow-select = "=58.3.0"
    45	arrow-arith = "=58.3.0"
    46	arrow-cast = "=58.3.0"
    47	
    48	# Concurrency
    49	rayon = "=1.12.0"
    50	tokio = { version = "=1.50.0", default-features = false, features = ["rt-multi-thread", "macros", "fs", "net", "time", "sync"] }
    51	
    52	# Phase 5.5 V2 V3 step 4 (2026-05-21) — WebSocket transport in ql-collab-ws.
    53	# tokio-tungstenite is the de-facto async websocket client for tokio.
    54	# futures-util provides SplitSink / SplitStream + StreamExt::next /
    55	# SinkExt::send. MVP scope: no TLS feature flags (plain ws:// only);
    56	# V2 V4 adds rustls. tokio-tungstenite 0.29.0 depends on tokio ^1.0
    57	# (compat with our =1.50.0 pin) and futures-util ^0.3.28.
    58	tokio-tungstenite = "=0.29.0"
    59	futures-util = { version = "=0.3.32", default-features = false, features = ["std", "sink"] }
    60	
    61	# Bench
    62	criterion = { version = "=0.8.2", default-features = false, features = ["html_reports"] }
    63	# Property-based testing for invariant checks (ql-storage, ql-calcgraph, ql-exec dev-deps)
    64	proptest = "=1.8.0"
    65	
    66	# SIMD (runtime dispatch per Phase 0 Decision F).
    67	# pulp's default features include `x86-v3` (= AVX2 baseline at compile time), which would
    68	# defeat A3 by baking AVX2 into distributable binaries. We disable defaults and opt back in
    69	# to `std` only; runtime dispatch comes from pulp's per-function `Arch::detect()` and
    70	# `multiversion`. Do NOT add `x86-v3`/`x86-v4` to features here.
    71	pulp = { version = "=0.22.2", default-features = false, features = ["std"] }
    72	multiversion = "=0.8.0"
    73	bytemuck = "=1.25.0"
    74	
    75	# Python interop (Phase 5; reserved in workspace pins for consistency)
    76	pyo3 = { version = "=0.28.3", default-features = false, features = ["extension-module", "abi3-py310"] }
    77	
    78	# WASM (later phases). Pinned to 0.2.121 (latest 2026-05-11; the older 0.2.118 drifted via
    79	# transitive resolution after toolchain bump 1.83→1.95 — see scripts/check-cargo-lock-pins.sh).
    80	wasm-bindgen = "=0.2.121"
    81	
    82	# Storage / formats (later phases)
    83	polars = { version = "=0.53.0", default-features = false, features = ["lazy", "fmt", "parquet"] }
    84	datafusion = { version = "=53.1.0", default-features = false }
    85	duckdb = { version = "=1.10502.0", default-features = false, features = ["bundled", "appender-arrow"] }
    86	calamine = "=0.34.0"
    87	
    88	# Reactive (salsa = experiments only per Decision A) / collab
    89	salsa = "=0.26.2"
    90	loro = "=1.12.0"
    91	
    92	# Utility
    93	thiserror = "=2.0.18"
    94	tracing = "=0.1.44"
    95	dashmap = "=6.1.0"
    96	petgraph = { version = "=0.8.3", default-features = false, features = ["std"] }
    97	tempfile = "=3.27.0"
    98	mimalloc = { version = "=0.1.48", default-features = false }
    99	num_cpus = "=1.17.0"
   100	# Phase 2A.10 audit H3/M14: SipHash24 with a fixed seed for stable formula
   101	# fingerprints. `siphasher` pins the algorithm contract (unlike stdlib
   102	# `DefaultHasher` whose internal algorithm is not specified). 800 MB/s
   103	# throughput is plenty for fingerprint use; we don't need BLAKE3's
   104	# cryptographic strength.
   105	siphasher = "=1.0.1"
   106	
   107	# Serialization (graph-profile.json export — OG-06; `.qbook/workbook.toml` envelope per
   108	# the Phase 1 workbook format).
   109	serde = { version = "=1.0.228", features = ["derive"] }
   110	serde_json = "=1.0.149"
   111	toml = "=0.9.7"
   112	
   113	# Statistical distributions (Wave 3 distributions batch: NORM.* / T.* /
   114	# CHISQ.* / F.* / BINOM.* / POISSON.* / GAMMA.* / BETA.*). IronCalc uses
   115	# the same crate at the same pin — matching their version for canon
   116	# behavioral compatibility. `default-features = false` keeps the crate
   117	# minimal (no rand integration).
   118	statrs = { version = "=0.18.0", default-features = false }
   119	
   120	[profile.dev]
   121	opt-level = 0
   122	debug = true
   123	
   124	[profile.release]
   125	opt-level = 3
   126	lto = "thin"
   127	codegen-units = 1
   128	debug = "line-tables-only"
   129	
   130	[profile.bench]
   131	opt-level = 3
   132	lto = "thin"
   133	codegen-units = 1
     1	[package]
     2	name = "ql-collab-ws"
     3	version.workspace = true
     4	edition.workspace = true
     5	rust-version.workspace = true
     6	license.workspace = true
     7	publish.workspace = true
     8	
     9	[lib]
    10	path = "src/lib.rs"
    11	
    12	[dependencies]
    13	# **Phase 5.5 V2 V3 step 4 (2026-05-21) — WebSocket transport.**
    14	# First production-grade `Transport` impl. Separate crate so
    15	# `ql-collab` core stays runtime-agnostic (no forced tokio dep on
    16	# embedders that don't need WebSockets).
    17	ql-collab         = { path = "../ql-collab" }
    18	tokio             = { workspace = true }
    19	tokio-tungstenite = { workspace = true }
    20	futures-util      = { workspace = true }
    21	thiserror         = { workspace = true }
    22	
    23	[dev-dependencies]
    24	# Integration tests need an in-process WebSocket echo server.
    25	# `tokio-tungstenite::accept_async` accepts incoming connections; the
    26	# test fixture (`tests/common/echo_server.rs`) binds a TcpListener on
    27	# 127.0.0.1:0 and echoes binary frames. ql-collab dev-dep gives
    28	# CollabSession + PeerId for the round-trip integration test.
    29	ql-collab         = { path = "../ql-collab" }
    30	ql-oplog          = { path = "../ql-oplog" }
    31	tokio             = { workspace = true, features = ["test-util"] }

exec
/bin/zsh -lc "nl -ba crates/ql-collab-ws/tests/websocket_transport.rs | sed -n '421,760p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'rg -n "V2 V3 step 4|Production transport|No TLS|auto-reconnect|Unbounded|Client-only|Drops text|text/ping|bounded queue|server-side|server side" docs/MASTER-PLAN.md docs/phase5/v1-exit-packet.md docs/architecture/ide-consumer-contract.md crates/ql-collab/src/transport.rs crates/ql-collab-ws/src/lib.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"struct CollabSession|attach_transport|detach_transport|flush_delta_to_transport|poll_remote|has_pending_flush|maybe_auto_flush|transport\" crates/ql-collab/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 290ms:
   421	        }
   422	        assert!(
   423	            total_merged >= 1,
   424	            "post-reattach flush blob MUST be echoed back, got {total_merged}"
   425	        );
   426	        assert_eq!(
   427	            session.op_count(),
   428	            3,
   429	            "3 offline ops preserved through reattach"
   430	        );
   431	    });
   432	}
   433	
   434	#[test]
   435	fn collab_session_websocket_send_after_close_surfaces_closed() {
   436	    // Auto-flush + closed transport partial-state contract: V2 V3
   437	    // step 1+2 behavior must hold for WS. Local op commits; send
   438	    // returns Err(Closed); state advances; has_pending_flush = true.
   439	    let rt = runtime();
   440	    rt.block_on(async {
   441	        let server = EchoServer::start().await;
   442	        let ws = WebSocketTransport::connect(&server.url())
   443	            .await
   444	            .expect("handshake");
   445	        let mut session = CollabSession::new(PeerId::new(1)).expect("session");
   446	        session.attach_transport(ws);
   447	        session.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   448	
   449	        // First append flushes successfully.
   450	        session.append_op(add_sheet()).expect("first append");
   451	
   452	        // Drop the server; wait for reader to observe close.
   453	        drop(server);
   454	        tokio::time::sleep(Duration::from_millis(200)).await;
   455	
   456	        // Try to nudge any state changes through (ignore result —
   457	        // we only care that the followup append shows Closed).
   458	        let _ = session.poll_remote();
   459	
   460	        // Next append: auto-flush should hit Err(Closed). Op MUST
   461	        // commit locally (partial-state contract).
   462	        let pre_count = session.op_count();
   463	        let result = session.append_op(put_value(0, 0, 0, 99.0));
   464	        assert!(
   465	            matches!(
   466	                result,
   467	                Err(CollabSessionError::Transport(TransportError::Closed))
   468	            ),
   469	            "expected Transport(Closed), got {:?}",
   470	            result
   471	        );
   472	        assert_eq!(
   473	            session.op_count(),
   474	            pre_count + 1,
   475	            "op committed locally even when auto-flush errors"
   476	        );
   477	        assert!(
   478	            session.has_pending_flush(),
   479	            "failed-flush leaves has_pending_flush = true (recoverable via reattach)"
   480	        );
   481	    });
   482	}

 succeeded in 291ms:
docs/phase5/v1-exit-packet.md:284:- **Phase 5.5 V2 V3 step 4 — WebSocket transport impl.** ✅
docs/phase5/v1-exit-packet.md:289:  plan time: client-only, plain `ws://`, NO TLS, NO auto-reconnect
docs/phase5/v1-exit-packet.md:298:  wrapper, server-side `ql-collab-ws-server` sibling crate). Crate
docs/architecture/ide-consumer-contract.md:206:- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 step 4 (✅ SHIPPED 2026-05-21) adds `ql-collab-ws::WebSocketTransport` as the first production-grade impl (separate crate — see "Production transport (ql-collab-ws)" section below).
docs/architecture/ide-consumer-contract.md:209:- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
docs/architecture/ide-consumer-contract.md:211:- **Production transport (✅ Phase 5.5 V2 V3 step 4 SHIPPED 2026-05-21 — `ql-collab-ws::WebSocketTransport`):** new sibling crate `ql-collab-ws` houses the first production-grade `Transport` impl. Bridges async tokio-tungstenite (`=0.29.0`) to the sync `Transport` trait via `tokio::sync::mpsc` channels + 2 spawned background tasks (writer drains outbound; reader pushes inbound). Caller pattern (sync): `let rt = tokio::runtime::Runtime::new()?; let ws = rt.block_on(WebSocketTransport::connect("ws://host:port"))?; session.attach_transport(ws);`. `Drop` aborts both background tasks (RAII close). Transport is `Send` (compile-time assert); not `Sync` (single-consumer mpsc). **Why a separate crate**: `ql-collab` core stays runtime-agnostic — embedders that need only `LoopbackTransport` or a custom impl (in-process IPC, gRPC stream) don't pay for tokio. **MVP V1 limitations** (all deferred to V2 V4 in `docs/PHASE-4-V2-BACKLOG.md` Tier I and future):
docs/architecture/ide-consumer-contract.md:212:    - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy in front, or wait for V2 V4 `rustls` feature.
docs/architecture/ide-consumer-contract.md:213:    - **No auto-reconnect.** On `Err(TransportError::Closed)`, caller drives recovery: `session.detach_transport(); let new_ws = rt.block_on(WebSocketTransport::connect(url))?; session.attach_transport(new_ws);`. V2 V3 step 1's baseline reset (`last_flushed_vv = None` on attach) makes the next flush deliver all accumulated ops including offline ones — the offline-write contract above holds identically for WS.
docs/architecture/ide-consumer-contract.md:214:    - **Unbounded outbound mpsc queue.** Memory grows if peer disconnects + caller keeps appending. Combine with V2 V3 step 3 `has_pending_flush()` for observability; V2 V4 will switch to bounded + backpressure policy.
docs/architecture/ide-consumer-contract.md:215:    - **Client-only.** Server-side WebSocket impls use other libraries (`axum-tungstenite`, `warp::ws`, etc.).
docs/architecture/ide-consumer-contract.md:216:    - **Drops text/ping/pong frames as inbound data.** Loro payloads are binary; non-binary frames don't carry our protocol. Close frames trigger reader task exit + closed-flag set.
crates/ql-collab/src/transport.rs:45://! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
crates/ql-collab/src/transport.rs:53://! scope: client-only, plain `ws://`, NO TLS, NO auto-reconnect
crates/ql-collab/src/transport.rs:59://! (TLS, auto-reconnect, bounded queue, server side).
docs/MASTER-PLAN.md:588:   - **V2 V3 step 4 ✅ SHIPPED 2026-05-21**: WebSocket transport impl. New crate `ql-collab-ws::WebSocketTransport`. Bridges async tokio-tungstenite (`=0.29.0`) to sync `Transport` trait via `tokio::sync::mpsc` + 2 background tasks. MVP: client-only, plain `ws://`, NO TLS, NO auto-reconnect (caller drives via detach+attach), unbounded outbound queue. 13 integration tests against in-process echo server including 3 that verify V2 V2 + V2 V3 step 1-3 contracts hold over a real WebSocket. V1 limitations deferred to V2 V4 (TLS, bounded backpressure, reconnect wrapper, server-side crate).
crates/ql-collab-ws/src/lib.rs:4://! **Phase 5.5 V2 V3 step 4 (2026-05-21, this ship):** first
crates/ql-collab-ws/src/lib.rs:31://!    │  (mpsc::UnboundedSender)  (mpsc::UnboundedReceiver)
crates/ql-collab-ws/src/lib.rs:47://! - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy
crates/ql-collab-ws/src/lib.rs:49://! - **No auto-reconnect.** Caller drives via `detach_transport` +
crates/ql-collab-ws/src/lib.rs:53://! - **Unbounded outbound mpsc queue.** Memory grows if peer
crates/ql-collab-ws/src/lib.rs:56://! - **Client-only.** Server-side WebSocket impls use other libraries
crates/ql-collab-ws/src/lib.rs:58://! - **Drops text/ping/pong/close frames as inbound data.** Loro
crates/ql-collab-ws/src/lib.rs:113:/// Phase 5.5 V2 V3 step 4 — WebSocket `Transport` impl.
crates/ql-collab-ws/src/lib.rs:139:    /// `UnboundedSender::send` (which is non-blocking).
crates/ql-collab-ws/src/lib.rs:140:    outbound_tx: mpsc::UnboundedSender<Vec<u8>>,
crates/ql-collab-ws/src/lib.rs:142:    /// via `UnboundedReceiver::try_recv`.
crates/ql-collab-ws/src/lib.rs:143:    inbound_rx: mpsc::UnboundedReceiver<Vec<u8>>,
crates/ql-collab-ws/src/lib.rs:305:        // UnboundedSender::send returns Err iff the receiver dropped.
crates/ql-collab-ws/src/lib.rs:339:// Phase 5.5 V2 V3 step 4 — pin the Send invariant. CollabSession

 succeeded in 280ms:
crates/ql-collab/src/lib.rs:20://!   `merge_bytes` + `export_bytes` for transport integration.
crates/ql-collab/src/lib.rs:21://! - [`transport`] — `Transport` trait + 2 impls: `NoopTransport`
crates/ql-collab/src/lib.rs:25://!   added `CollabSession` typed transport methods
crates/ql-collab/src/lib.rs:94:pub mod transport;
crates/ql-collab/src/lib.rs:111:pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
crates/ql-collab/src/transport.rs:7://! `CollabSession` exposes 5 typed transport methods
crates/ql-collab/src/transport.rs:8://! (`attach_transport` / `detach_transport` / `has_transport` /
crates/ql-collab/src/transport.rs:9://! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
crates/ql-collab/src/transport.rs:18://! for the **currently attached** transport baseline + delta flushes.
crates/ql-collab/src/transport.rs:19://! `CollabSession::flush_delta_to_transport` sends only the delta
crates/ql-collab/src/transport.rs:25://! per-session-currently-attached-transport, NOT per-transport-
crates/ql-collab/src/transport.rs:26://! identity (`attach_transport` resets the baseline).
crates/ql-collab/src/transport.rs:27://! **Phase 5.5 V2 V3 step 2 (2026-05-21):** wires `poll_remote*`
crates/ql-collab/src/transport.rs:36://! log IS the implicit offline queue. Append while no transport
crates/ql-collab/src/transport.rs:37://! attached → `maybe_auto_flush` no-ops; op committed locally. On
crates/ql-collab/src/transport.rs:38://! reattach: `attach_transport` resets `last_flushed_vv = None`; the
crates/ql-collab/src/transport.rs:39://! next mutator (or explicit `flush_delta_to_transport`) sends from
crates/ql-collab/src/transport.rs:41://! Adds `has_pending_flush() -> bool` ergonomic helper (compares
crates/ql-collab/src/transport.rs:69://!   Bytes are an opaque blob (a Loro export). The transport
crates/ql-collab/src/transport.rs:75://! transport → remote `CollabSession::merge_bytes` flow. The
crates/ql-collab/src/transport.rs:76://! transport handles framing / reliability / reconnect / auth as
crates/ql-collab/src/transport.rs:95:    #[error("transport I/O error: {0}")]
crates/ql-collab/src/transport.rs:98:    /// The transport is closed and no further sends are accepted.
crates/ql-collab/src/transport.rs:101:    #[error("transport closed")]
crates/ql-collab/src/transport.rs:109:/// transport doesn't interpret them. Framing (where one blob ends
crates/ql-collab/src/transport.rs:118:    /// transport will not retry automatically — that policy lives
crates/ql-collab/src/transport.rs:209:/// through the attached transport automatically. Default policy
crates/ql-collab/src/transport.rs:212:/// the transport, recv on the other side, merge_bytes — useful
crates/ql-collab/src/transport.rs:215:/// (2026-05-21):** `poll_remote*` now also triggers auto-flush after
crates/ql-collab/src/transport.rs:238:/// guaranteed by this transport alone (the atomic only protects
crates/ql-collab/src/transport.rs:323:        // Trait contract (transport.rs:71-74): "Closed only when the
crates/ql-collab/src/transport.rs:451:        // matches the Transport trait contract at transport.rs:71-74).
crates/ql-collab/src/session.rs:4://! with peer-id-aware operations + transport plumbing. Subsequent
crates/ql-collab/src/session.rs:13://! - **Phase 5.5** — transport layer. V1 shipped at
crates/ql-collab/src/session.rs:16://!   `CollabSession::{attach,detach,has}_transport` +
crates/ql-collab/src/session.rs:17://!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
crates/ql-collab/src/session.rs:45://! - `export_bytes(&self)` — produce a snapshot for transport.
crates/ql-collab/src/session.rs:61:use crate::transport::{Transport, TransportError};
crates/ql-collab/src/session.rs:64:/// the number of blobs `CollabSession::poll_remote` drains per
crates/ql-collab/src/session.rs:66:/// an externally-fed transport produces faster than we merge.
crates/ql-collab/src/session.rs:67:/// Callers wanting a different bound use `poll_remote_with_limit`.
crates/ql-collab/src/session.rs:72:// with attached transports"). If a future Loro dep bump or field
crates/ql-collab/src/session.rs:103:    /// For `flush_to_transport`: the local `OpLog` is unaffected
crates/ql-collab/src/session.rs:107:    /// For `poll_remote`: any bytes successfully drained BEFORE
crates/ql-collab/src/session.rs:110:    /// transport itself is misbehaving (`Io`) — `Closed` is
crates/ql-collab/src/session.rs:111:    /// handled gracefully by `poll_remote` itself (returns
crates/ql-collab/src/session.rs:113:    /// Caller should detach + reattach a new transport instead
crates/ql-collab/src/session.rs:115:    #[error("transport error: {0}")]
crates/ql-collab/src/session.rs:181:/// its current snapshot through the attached transport without an
crates/ql-collab/src/session.rs:182:/// explicit [`CollabSession::flush_to_transport`] call.
crates/ql-collab/src/session.rs:193:    /// explicitly via [`CollabSession::flush_to_transport`] +
crates/ql-collab/src/session.rs:194:    /// [`CollabSession::poll_remote`]. Auto-flush never fires.
crates/ql-collab/src/session.rs:200:    /// `undo`, `redo`, `poll_remote`, `poll_remote_with_limit`.
crates/ql-collab/src/session.rs:203:    /// through [`flush_delta_to_transport`] (delta path) rather than
crates/ql-collab/src/session.rs:204:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
crates/ql-collab/src/session.rs:207:    /// no-op (no transport.send invocation) — this closes the V2 V2
crates/ql-collab/src/session.rs:210:    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** `poll_remote*` now
crates/ql-collab/src/session.rs:227:    /// - Transport-lifecycle methods (`attach_transport` etc.).
crates/ql-collab/src/session.rs:229:    /// If no transport is attached, this is silently a no-op (the
crates/ql-collab/src/session.rs:230:    /// flush hook checks `self.transport.is_some()` first).
crates/ql-collab/src/session.rs:233:    /// flush attempt fails (transport closed, I/O error), the
crates/ql-collab/src/session.rs:240:    /// (transport recovered) or detach the transport.
crates/ql-collab/src/session.rs:244:    /// transport is safe via the V2 V3 idempotency guard. The
crates/ql-collab/src/session.rs:245:    /// guard short-circuits `flush_delta_to_transport` when no ops
crates/ql-collab/src/session.rs:251:    /// `poll_remote` also auto-flushes — the round-trip back to the
crates/ql-collab/src/session.rs:252:    /// SAME paired transport hits the idempotency guard if the
crates/ql-collab/src/session.rs:256:    /// **V1 limit (V2 V3 step 2)**: auto-flush from `poll_remote`
crates/ql-collab/src/session.rs:257:    /// goes back to the SAME transport the bytes came from. In a
crates/ql-collab/src/session.rs:258:    /// true multi-transport hub topology, the merged state would
crates/ql-collab/src/session.rs:259:    /// only fan to ONE transport per session. V2 V3 step 4
crates/ql-collab/src/session.rs:260:    /// (WebSocket + multi-transport routing) may add per-transport
crates/ql-collab/src/session.rs:268:/// at scaffold time; Phase 5.5 will add the live transport
crates/ql-collab/src/session.rs:277:pub struct CollabSession {
crates/ql-collab/src/session.rs:289:    /// transport. `None` until `attach_transport` is called.
crates/ql-collab/src/session.rs:291:    /// threads with attached transports.
crates/ql-collab/src/session.rs:296:    transport: Option<Box<dyn Transport + Send>>,
crates/ql-collab/src/session.rs:303:    /// `flush_to_transport` / `flush_delta_to_transport` call.
crates/ql-collab/src/session.rs:310:    /// - Reset to `None` on `attach_transport` (a new transport-peer
crates/ql-collab/src/session.rs:311:    ///   needs the full state from scratch) and `detach_transport`
crates/ql-collab/src/session.rs:314:    ///   either `flush_to_transport` (full snapshot path) or
crates/ql-collab/src/session.rs:315:    ///   `flush_delta_to_transport` (V2 V3 delta path).
crates/ql-collab/src/session.rs:333:    ///   ids unless your transport layer enforces single-ownership.
crates/ql-collab/src/session.rs:362:            transport: None,
crates/ql-collab/src/session.rs:405:            transport: None,
crates/ql-collab/src/session.rs:419:    /// is `OnAppend` AND a transport is attached, fires
crates/ql-collab/src/session.rs:420:    /// [`flush_to_transport`] internally after the append. Transport
crates/ql-collab/src/session.rs:427:        self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:449:    /// any third-party peer attached via the transport (3+ peer fanout
crates/ql-collab/src/session.rs:450:    /// via this session's transport endpoint). Same partial-state
crates/ql-collab/src/session.rs:455:        self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:459:    /// Produce a Loro snapshot blob suitable for **transport to other
crates/ql-collab/src/session.rs:622:    /// [`flush_to_transport`] calls push the session's current
crates/ql-collab/src/session.rs:623:    /// snapshot through it; [`poll_remote`] drains incoming
crates/ql-collab/src/session.rs:626:    /// Returns `Some(previous)` if a transport was already
crates/ql-collab/src/session.rs:630:    /// (caller invokes `flush_to_transport` per tick). V2 V2 added
crates/ql-collab/src/session.rs:639:    /// `None` (V2 V3 step 1 contract). A new transport-peer hasn't
crates/ql-collab/src/session.rs:641:    /// [`flush_delta_to_transport`] (or any auto-flushing mutator)
crates/ql-collab/src/session.rs:650:    /// let _ = session.attach_transport(new_transport);
crates/ql-collab/src/session.rs:651:    /// if session.has_pending_flush() {
crates/ql-collab/src/session.rs:652:    ///     session.flush_delta_to_transport()?;
crates/ql-collab/src/session.rs:655:    /// `attach_transport` itself does NOT auto-flush — it's a
crates/ql-collab/src/session.rs:660:    pub fn attach_transport<T: Transport + Send + 'static>(
crates/ql-collab/src/session.rs:662:        transport: T,
crates/ql-collab/src/session.rs:665:        // to `None`. A new transport-peer hasn't seen ANY of this
crates/ql-collab/src/session.rs:666:        // session's ops, so the next `flush_delta_to_transport` must
crates/ql-collab/src/session.rs:668:        // VV from a prior transport, the new peer would miss ops
crates/ql-collab/src/session.rs:671:        self.transport.replace(Box::new(transport))
crates/ql-collab/src/session.rs:675:    /// transport. Returns it for caller cleanup; returns `None`
crates/ql-collab/src/session.rs:676:    /// if no transport was attached.
crates/ql-collab/src/session.rs:677:    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
crates/ql-collab/src/session.rs:679:        // a subsequent `attach_transport` lands on a clean baseline.
crates/ql-collab/src/session.rs:681:        self.transport.take()
crates/ql-collab/src/session.rs:684:    /// **Phase 5.5 V2 V1 (2026-05-19):** true iff a transport is
crates/ql-collab/src/session.rs:686:    pub fn has_transport(&self) -> bool {
crates/ql-collab/src/session.rs:687:        self.transport.is_some()
crates/ql-collab/src/session.rs:698:    /// [`flush_delta_to_transport`] internally — IDE callers can
crates/ql-collab/src/session.rs:703:    /// ([`flush_delta_to_transport`]), not the full-snapshot path
crates/ql-collab/src/session.rs:704:    /// ([`flush_to_transport`]). Wire payload is O(per-op delta)
crates/ql-collab/src/session.rs:706:    /// the full partial-state contract on transport failure.
crates/ql-collab/src/session.rs:708:    /// Orthogonal to [`attach_transport`]: setting `OnAppend` without
crates/ql-collab/src/session.rs:709:    /// a transport is harmless (auto-flush is silently a no-op until
crates/ql-collab/src/session.rs:710:    /// a transport is attached). Conversely, both explicit
crates/ql-collab/src/session.rs:711:    /// [`flush_to_transport`] (snapshot) and
crates/ql-collab/src/session.rs:712:    /// [`flush_delta_to_transport`] (delta) remain available
crates/ql-collab/src/session.rs:716:    /// (transport closed, I/O error), the surrounding mutator
crates/ql-collab/src/session.rs:732:    /// successfully flushed to the currently-attached transport.
crates/ql-collab/src/session.rs:748:    ///   manual [`flush_delta_to_transport`] after attach.
crates/ql-collab/src/session.rs:755:    /// The helper compares VVs; it doesn't know about transports.
crates/ql-collab/src/session.rs:761:    /// 3. Brand-new session AFTER `detach_transport` AND no further
crates/ql-collab/src/session.rs:764:    /// Three scenarios that return `true` even though no transport
crates/ql-collab/src/session.rs:766:    /// 1. Brand-new session with offline appends (no transport
crates/ql-collab/src/session.rs:774:    ///    OR wrap with `has_transport() && has_pending_flush()`
crates/ql-collab/src/session.rs:775:    ///    to gate the indicator on the transport-attached state.
crates/ql-collab/src/session.rs:776:    /// 3. Post-`detach_transport` non-empty session — the orphaned
crates/ql-collab/src/session.rs:780:    /// Bottom line: combine with [`has_transport`] when the IDE
crates/ql-collab/src/session.rs:786:    /// Append while no transport attached: `append_op` succeeds
crates/ql-collab/src/session.rs:787:    /// (V2 V2 contract — `maybe_auto_flush` returns `Ok(())`
crates/ql-collab/src/session.rs:788:    /// silently when no transport). The op is committed locally;
crates/ql-collab/src/session.rs:789:    /// `has_pending_flush()` returns `true`. On
crates/ql-collab/src/session.rs:790:    /// [`attach_transport`], `last_flushed_vv` resets to `None`.
crates/ql-collab/src/session.rs:791:    /// The next mutator (or explicit `flush_delta_to_transport`)
crates/ql-collab/src/session.rs:795:    pub fn has_pending_flush(&self) -> bool {
crates/ql-collab/src/session.rs:803:    /// [`flush_to_transport`] when policy is `OnAppend` AND a transport
crates/ql-collab/src/session.rs:811:    /// [`flush_delta_to_transport`] (delta path) instead of
crates/ql-collab/src/session.rs:812:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
crates/ql-collab/src/session.rs:815:    fn maybe_auto_flush(&mut self) -> Result<(), CollabSessionError> {
crates/ql-collab/src/session.rs:819:                if self.transport.is_none() {
crates/ql-collab/src/session.rs:822:                let _sent = self.flush_delta_to_transport()?;
crates/ql-collab/src/session.rs:830:    /// transport. No-op (returns `Ok(false)`) if no transport
crates/ql-collab/src/session.rs:844:    /// will track per-transport version vectors and send deltas
crates/ql-collab/src/session.rs:853:    /// still call `flush_to_transport` after an explicit batch
crates/ql-collab/src/session.rs:855:    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
crates/ql-collab/src/session.rs:856:        let Some(transport) = self.transport.as_mut() else {
crates/ql-collab/src/session.rs:860:        transport.send(&bytes)?;
crates/ql-collab/src/session.rs:863:        // up to this VV; subsequent `flush_delta_to_transport` calls
crates/ql-collab/src/session.rs:865:        // update, a mixed-call sequence (`flush_to_transport` then
crates/ql-collab/src/session.rs:866:        // `flush_delta_to_transport`) would re-send the snapshot's
crates/ql-collab/src/session.rs:875:    /// attached transport. Returns `Ok(true)` if bytes were sent,
crates/ql-collab/src/session.rs:876:    /// `Ok(false)` if no transport is attached OR if no ops have
crates/ql-collab/src/session.rs:879:    /// step 2's `poll_remote` auto-flush wiring).
crates/ql-collab/src/session.rs:882:    /// The first flush after `attach_transport` (or after `new`)
crates/ql-collab/src/session.rs:884:    /// delivering the full history to the new transport-peer.
crates/ql-collab/src/session.rs:892:    /// # Mix-and-match with `flush_to_transport`
crates/ql-collab/src/session.rs:897:    /// - Initial handshake: `flush_to_transport` to seed the peer
crates/ql-collab/src/session.rs:899:    /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
crates/ql-collab/src/session.rs:900:    ///   `flush_delta_to_transport`) sends tiny deltas per
crates/ql-collab/src/session.rs:902:    /// - On peer reconnect: caller may choose to `flush_to_transport`
crates/ql-collab/src/session.rs:908:    /// Same partial-state contract as `flush_to_transport`:
crates/ql-collab/src/session.rs:913:    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
crates/ql-collab/src/session.rs:914:        if self.transport.is_none() {
crates/ql-collab/src/session.rs:923:        // Ok(false) without invoking transport.send.
crates/ql-collab/src/session.rs:936:        // Now borrow transport mutably for the send. Done in two
crates/ql-collab/src/session.rs:938:        // self.transport (mut) here — borrow-checker dance.
crates/ql-collab/src/session.rs:939:        let transport = self.transport.as_mut().expect("just-checked is_some above");
crates/ql-collab/src/session.rs:940:        transport.send(&bytes)?;
crates/ql-collab/src/session.rs:949:    /// the attached transport's recv queue up to a default cap
crates/ql-collab/src/session.rs:955:    /// [`poll_remote_with_limit`]. The cap prevents one
crates/ql-collab/src/session.rs:956:    /// `poll_remote` call from starving the calling thread when
crates/ql-collab/src/session.rs:957:    /// a future externally-fed transport is producing faster
crates/ql-collab/src/session.rs:960:    /// Returns `Ok(0)` if no transport attached.
crates/ql-collab/src/session.rs:970:    /// through [`flush_delta_to_transport`] when
crates/ql-collab/src/session.rs:977:    /// `transport.send`.
crates/ql-collab/src/session.rs:980:    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
crates/ql-collab/src/session.rs:986:    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
crates/ql-collab/src/session.rs:987:        self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
crates/ql-collab/src/session.rs:991:    /// [`poll_remote`] but with an explicit per-call cap on the
crates/ql-collab/src/session.rs:1000:    /// (either empty or transport reported `Closed`).
crates/ql-collab/src/session.rs:1006:    /// [`flush_delta_to_transport`]; V2 V3 step 1's idempotency
crates/ql-collab/src/session.rs:1012:    /// post-batch auto-flush fails (closed transport, I/O error
crates/ql-collab/src/session.rs:1019:    /// (e.g., manual [`flush_delta_to_transport`] after detaching
crates/ql-collab/src/session.rs:1020:    /// and reattaching a working transport) sends the same delta the
crates/ql-collab/src/session.rs:1022:    pub fn poll_remote_with_limit(
crates/ql-collab/src/session.rs:1026:        let Some(transport) = self.transport.as_mut() else {
crates/ql-collab/src/session.rs:1031:            match transport.try_recv() {
crates/ql-collab/src/session.rs:1049:        // `flush_delta_to_transport` returns Ok(false) without
crates/ql-collab/src/session.rs:1050:        // invoking transport.send when no state advanced (Loro-
crates/ql-collab/src/session.rs:1055:            self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:1077:        self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:1111:        self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:1133:    /// a closed transport cannot turn a "nothing to undo" into a
crates/ql-collab/src/session.rs:1143:        // `Err(Transport(_))` when the transport was closed AND the
crates/ql-collab/src/session.rs:1146:        // of transport state (no mutation, no flush attempt).
crates/ql-collab/src/session.rs:1148:            self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:1166:            self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:1334:        self.maybe_auto_flush()?;
crates/ql-collab/src/session.rs:1365:            .field("transport_attached", &self.transport.is_some())
crates/ql-collab/src/session.rs:2100:    fn attach_transport_returns_none_when_no_prior() {
crates/ql-collab/src/session.rs:2101:        use crate::transport::NoopTransport;
crates/ql-collab/src/session.rs:2103:        assert!(!s.has_transport());
crates/ql-collab/src/session.rs:2104:        let prior = s.attach_transport(NoopTransport::new());
crates/ql-collab/src/session.rs:2106:        assert!(s.has_transport());
crates/ql-collab/src/session.rs:2110:    fn attach_transport_returns_previous_on_replace() {
crates/ql-collab/src/session.rs:2111:        use crate::transport::NoopTransport;
crates/ql-collab/src/session.rs:2113:        s.attach_transport(NoopTransport::new());
crates/ql-collab/src/session.rs:2114:        let prior = s.attach_transport(NoopTransport::new());
crates/ql-collab/src/session.rs:2119:    fn detach_transport_returns_box_then_clears() {
crates/ql-collab/src/session.rs:2120:        use crate::transport::NoopTransport;
crates/ql-collab/src/session.rs:2122:        s.attach_transport(NoopTransport::new());
crates/ql-collab/src/session.rs:2123:        assert!(s.has_transport());
crates/ql-collab/src/session.rs:2124:        let detached = s.detach_transport();
crates/ql-collab/src/session.rs:2126:        assert!(!s.has_transport());
crates/ql-collab/src/session.rs:2127:        assert!(s.detach_transport().is_none(), "second detach is None");
crates/ql-collab/src/session.rs:2131:    fn flush_to_transport_noop_without_attached() {
crates/ql-collab/src/session.rs:2133:        let flushed = s.flush_to_transport().unwrap();
crates/ql-collab/src/session.rs:2134:        assert!(!flushed, "flush with no transport returns false");
crates/ql-collab/src/session.rs:2138:    fn poll_remote_noop_without_attached() {
crates/ql-collab/src/session.rs:2140:        let drained = s.poll_remote().unwrap();
crates/ql-collab/src/session.rs:2141:        assert_eq!(drained, 0, "poll with no transport returns 0");
crates/ql-collab/src/session.rs:2145:    fn flush_to_transport_pushes_bytes_via_attached() {
crates/ql-collab/src/session.rs:2146:        use crate::transport::LoopbackTransport;
crates/ql-collab/src/session.rs:2150:        s.attach_transport(tx_a);
crates/ql-collab/src/session.rs:2155:            "transport idle until flush is called"
crates/ql-collab/src/session.rs:2157:        let flushed = s.flush_to_transport().unwrap();
crates/ql-collab/src/session.rs:2168:    fn poll_remote_drains_attached_transport() {
crates/ql-collab/src/session.rs:2169:        use crate::transport::LoopbackTransport;
crates/ql-collab/src/session.rs:2182:        s.attach_transport(tx_a);
crates/ql-collab/src/session.rs:2183:        let drained = s.poll_remote().unwrap();
crates/ql-collab/src/session.rs:2187:        let drained2 = s.poll_remote().unwrap();
crates/ql-collab/src/session.rs:2193:        use crate::transport::LoopbackTransport;
crates/ql-collab/src/session.rs:2200:        peer_a.attach_transport(tx_a);
crates/ql-collab/src/session.rs:2202:        peer_b.attach_transport(tx_b);
crates/ql-collab/src/session.rs:2206:        peer_a.flush_to_transport().unwrap();
crates/ql-collab/src/session.rs:2207:        let drained_b = peer_b.poll_remote().unwrap();
crates/ql-collab/src/session.rs:2213:        peer_b.flush_to_transport().unwrap();
crates/ql-collab/src/session.rs:2214:        let drained_a = peer_a.poll_remote().unwrap();
crates/ql-collab/src/session.rs:2220:    fn flush_to_transport_errors_when_transport_closed() {
crates/ql-collab/src/session.rs:2222:        // flush-on-closed-transport. Attach a LoopbackTransport,
crates/ql-collab/src/session.rs:2224:        use crate::transport::LoopbackTransport;
crates/ql-collab/src/session.rs:2229:        // this on the raw transport.
crates/ql-collab/src/session.rs:2231:        s.attach_transport(tx_a);
crates/ql-collab/src/session.rs:2232:        let result = s.flush_to_transport();
crates/ql-collab/src/session.rs:2238:            "flush on closed transport must Err(Closed), got {result:?}"
crates/ql-collab/src/session.rs:2245:    fn poll_remote_treats_closed_as_graceful_end_of_stream() {
crates/ql-collab/src/session.rs:2248:        // Closed only after queue drains; CollabSession::poll_remote
crates/ql-collab/src/session.rs:2251:        use crate::transport::LoopbackTransport;
crates/ql-collab/src/session.rs:2266:        s.attach_transport(tx_a);
crates/ql-collab/src/session.rs:2268:        let drained = s.poll_remote().unwrap();
crates/ql-collab/src/session.rs:2271:            "poll_remote must drain all queued blobs even when transport is closed"
crates/ql-collab/src/session.rs:2274:        let drained2 = s.poll_remote().unwrap();
crates/ql-collab/src/session.rs:2279:    fn poll_remote_with_limit_caps_drain() {
crates/ql-collab/src/session.rs:2280:        // Codex+Opus 5.5 V2 V1 audit closure (H1): poll_remote_with_limit
crates/ql-collab/src/session.rs:2282:        use crate::transport::LoopbackTransport;
crates/ql-collab/src/session.rs:2293:        s.attach_transport(tx_a);
crates/ql-collab/src/session.rs:2295:        let d1 = s.poll_remote_with_limit(4).unwrap();
crates/ql-collab/src/session.rs:2297:        let d2 = s.poll_remote_with_limit(4).unwrap();
crates/ql-collab/src/session.rs:2299:        let d3 = s.poll_remote_with_limit(4).unwrap();
crates/ql-collab/src/session.rs:2301:        let d4 = s.poll_remote_with_limit(4).unwrap();
crates/ql-collab/src/session.rs:2306:        let d5 = s.poll_remote_with_limit(0).unwrap();
crates/ql-collab/src/session.rs:2314:        use crate::transport::LoopbackTransport;
crates/ql-collab/src/session.rs:2320:        s.attach_transport(tx_a1);
crates/ql-collab/src/session.rs:2321:        assert!(s.flush_to_transport().unwrap());
crates/ql-collab/src/session.rs:2323:        let detached1 = s.detach_transport();
crates/ql-collab/src/session.rs:2325:        assert!(!s.has_transport());
crates/ql-collab/src/session.rs:2327:        // Cycle 2: attach DIFFERENT transport, flush, detach.
crates/ql-collab/src/session.rs:2329:        s.attach_transport(tx_a2);
crates/ql-collab/src/session.rs:2331:        assert!(s.flush_to_transport().unwrap());
crates/ql-collab/src/session.rs:2335:        s.detach_transport();
crates/ql-collab/src/session.rs:2339:    fn debug_includes_transport_attached() {
crates/ql-collab/src/session.rs:2340:        use crate::transport::NoopTransport;
crates/ql-collab/src/session.rs:2344:            d_pre.contains("transport_attached: false"),
crates/ql-collab/src/session.rs:2345:            "Debug must include transport_attached: false: {d_pre}"
crates/ql-collab/src/session.rs:2347:        s.attach_transport(NoopTransport::new());
crates/ql-collab/src/session.rs:2350:            d_post.contains("transport_attached: true"),
crates/ql-collab/src/session.rs:2356:    fn two_sessions_exchange_state_via_loopback_transport() {
crates/ql-collab/src/session.rs:2359:        // flush appends to the transport (5.5 V2 work), so the
crates/ql-collab/src/session.rs:2362:        use crate::transport::{LoopbackTransport, Transport};
crates/ql-collab/src/session.rs:2376:        // Peer B drains the transport and merges.

codex
The CollabSession tests do assert the advertised effects: echo delivery, offline reattach via explicit delta flush, and partial-state-on-closed-transport. I’m checking the documentation surfaces now; one possible drift is whether the “frame drop” limitation is listed everywhere the prompt says it should be.
exec
/bin/zsh -lc "nl -ba docs/MASTER-PLAN.md | sed -n '570,602p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba docs/phase5/v1-exit-packet.md | sed -n '274,306p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba docs/architecture/ide-consumer-contract.md | sed -n '204,218p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/session.rs | sed -n '620,690p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 275ms:
   570	   - ✅ 5.2.b PeerId → LoroDoc wiring (`ef056f50bee`).
   571	   - ✅ **D-1 (FormatId tagged tuple, multi-day) — SHIPPED 2026-05-20.** All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit complete. **16/16 audit cycles caught real bugs.** Workspace tests: 4222 → 4291 (+69). See `docs/phase5/d-1-exit-packet.md` for the closure record + `docs/phase5/d-1-starting-checklist.md` for execution-trace history.
   572	
   573	3. **5.3 Conflict Resolution Semantics** ✅ SHIPPED 2026-05-20. Causality-aware rename-repair pass for sheets + tables + columns. 4 days actual (vs 4-7 day estimate). All 6 steps + 14 audit cycles complete. **14/14 audit cycles caught real bugs.** Workspace tests: 4291 → 4361 (+70). New public API: `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` convenience wrapper. See `docs/phase5/5-3-exit-packet.md` for the closure record + 20 audit transcripts at `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked at `docs/PHASE-4-V2-BACKLOG.md` Tier H. **Production-visible D-3 closure happens at step 5.7 IDE binding** (rebuild_workbook is shipped as the API entry; IDE has to wire it).
   574	
   575	4. **5.4 Undo/Redo And Operation Grouping** ✅ V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19.
   576	   - V1 (`89c02b9d83e`): 7 undo/redo methods on CollabSession wrapping `loro::UndoManager`; presence-origin commits auto-excluded.
   577	   - V2 V1 (`6138a7203f6` + `e199a5fda5a`): `start_undo_group` / `end_undo_group` + `set_undo_merge_interval`.
   578	   - V2 V1.1 (`7cbdc689ea9`): RAII `start_undo_group_scoped` returning `UndoGroupGuard` (panic/Err-safe). Codex audit PASS.
   579	   - V2 V2 pending: push/pop listeners (lower priority, speculative).
   580	
   581	5. **5.5 Transport Layer And Offline Sync** 🟡 V1 + V2 V1 + V2 V2 (auto-flush) + V2 V3 step 1 (delta flush) SHIPPED 2026-05-21; V2 V3 steps 2-6 pending.
   582	   - V1 (`924750819bc`): `Transport` trait + `NoopTransport` + `LoopbackTransport::pair()`.
   583	   - V2 V1 (`ffd8f6e5f05`): `CollabSession::{attach,detach,has}_transport` + `flush_to_transport` + `poll_remote` (+ `_with_limit`). Explicit-drive.
   584	   - V2 V2 (`51748b02944` ship + `b7aa4cb7bb9` audit-closure): `AutoFlushPolicy::{Disabled, OnAppend}` enum. Default `Disabled` (V2 V1 behavior); `OnAppend` triggers flush after every mutator.
   585	   - V2 V3 step 1 (`603bdc9aa6c` ship + `e5ff11d549a` audit-closure): per-transport version-vector tracking + `CollabSession::flush_delta_to_transport` using `LoroDoc::ExportMode::Updates`. Auto-flush reroutes through the delta path. Idempotency short-circuit closes V2 V2 audit echo-loop class. New `OpLog` API: `oplog_vv()` + `export_delta_bytes(&VersionVector)`.
   586	   - V2 V3 step 2 (`e4e1ce282b1` ship + `fc3de6f99c7` audit-closure): wires `poll_remote*` into auto-flush. One flush per drain batch. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer hub fanout works automatically under `OnAppend`.
   587	   - V2 V3 step 3 (`c73249d338c` ship + `10f40eb228b` audit-closure): offline-write story. Investigation showed no explicit queue needed — Loro's CRDT op log IS the implicit offline queue. Append while no transport returns Ok + commits locally; reattach + flush sends all accumulated ops (delta from empty VV). Adds `CollabSession::has_pending_flush()` ergonomic helper. 7 ship + 5 closure tests pin the contract.
   588	   - **V2 V3 step 4 ✅ SHIPPED 2026-05-21**: WebSocket transport impl. New crate `ql-collab-ws::WebSocketTransport`. Bridges async tokio-tungstenite (`=0.29.0`) to sync `Transport` trait via `tokio::sync::mpsc` + 2 background tasks. MVP: client-only, plain `ws://`, NO TLS, NO auto-reconnect (caller drives via detach+attach), unbounded outbound queue. 13 integration tests against in-process echo server including 3 that verify V2 V2 + V2 V3 step 1-3 contracts hold over a real WebSocket. V1 limitations deferred to V2 V4 (TLS, bounded backpressure, reconnect wrapper, server-side crate).
   589	   - V2 V3 steps 5-6 pending: full-arc megaudit (step 5) + exit packet (step 6).
   590	
   591	6. **5.6 Presence And Awareness** ✅ V1 + V2 SHIPPED 2026-05-19.
   592	   - V1 (`c677e244704`): `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods.
   593	   - V2 (`d4b3cdb2dc2`): `sweep_presence` caller-opt-in clean-slate.
   594	
   595	7. **5.7 Collaboration IDE Vertical Slice** — future. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
   596	
   597	8. **5.8 Phase 5 Megaudit** — future. Depends on 5.1-5.7 complete.
   598	
   599	**Audit Checkpoints**
   600	
   601	- Design audit after 5.1 before implementation.
   602	- Megaudit after 5.7.

 succeeded in 272ms:
   274	  Loro's CRDT op log IS the implicit offline queue. Append while
   275	  no transport attached → `append_op` returns `Ok(())` and commits
   276	  locally (`maybe_auto_flush` silently no-ops). On reattach,
   277	  `attach_transport` resets `last_flushed_vv = None`; next mutator
   278	  or explicit `flush_delta_to_transport` sends delta from empty VV
   279	  (= ALL accumulated ops including offline ones). NEW ergonomic
   280	  helper `CollabSession::has_pending_flush() -> bool` for IDE
   281	  status indicators + reconnect handshake. 7 new integration tests
   282	  pin the contract. No code change to the wire path.
   283	
   284	- **Phase 5.5 V2 V3 step 4 — WebSocket transport impl.** ✅
   285	  **SHIPPED 2026-05-21**. New crate `ql-collab-ws` housing
   286	  `WebSocketTransport`. Bridges async tokio-tungstenite (`=0.29.0`)
   287	  to the sync `Transport` trait via `tokio::sync::mpsc` channels +
   288	  2 spawned background tasks (reader + writer). MVP scope locked at
   289	  plan time: client-only, plain `ws://`, NO TLS, NO auto-reconnect
   290	  (caller drives via detach + new connect + attach — V2 V3 step 1
   291	  baseline-reset contract delivers offline ops on reconnect),
   292	  unbounded outbound mpsc queue. 13 integration tests against an
   293	  in-process tokio-tungstenite echo server, including 3 that
   294	  verify the V2 V2 + V2 V3 step 1-3 contracts hold over a real
   295	  WebSocket (auto-flush round-trip, offline-reattach delivery,
   296	  partial-state on server close). V1 limitations deferred to V2 V4
   297	  (TLS via rustls feature, bounded backpressure, `ReconnectingWebSocketTransport`
   298	  wrapper, server-side `ql-collab-ws-server` sibling crate). Crate
   299	  NOT added to `default-members` — keeps `cargo build` lean; tests
   300	  still run via `--workspace`.
   301	
   302	- **Phase 5.5 V2 V3 steps 5-6 — Megaudit + exit packet.** Step 5:
   303	  full-arc 3-way megaudit (Codex + Opus-A + Opus-B per Phase 5.3
   304	  step 5 precedent) covering V2 V3 steps 1-4 end-to-end. Step 6:
   305	  V2 V3 exit packet. 1-1.5 days estimated.
   306	

 succeeded in 265ms:
   204	- **Op log:** `append_op` / `merge_bytes` / `export_bytes`.
   205	- **Undo:** `undo` / `redo` / `start_undo_group_scoped` (returns RAII `UndoGroupGuard` — recommended for paste/fill-down/table-import).
   206	- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 step 4 (✅ SHIPPED 2026-05-21) adds `ql-collab-ws::WebSocketTransport` as the first production-grade impl (separate crate — see "Production transport (ql-collab-ws)" section below).
   207	- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
   208	- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
   209	- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
   210	- **Offline-write (✅ Phase 5.5 V2 V3 step 3 SHIPPED 2026-05-21)**: append while no transport attached → `append_op` returns `Ok(())` and commits locally; `maybe_auto_flush` silently no-ops. **Loro's CRDT op log IS the implicit offline queue — no separate buffer needed.** On reattach: `attach_transport` resets `last_flushed_vv = None`. The next mutator (or explicit `flush_delta_to_transport`) sends the delta from empty VV — delivers ALL accumulated ops including the offline ones. Recovery from a failed flush (transport closed mid-session) follows the same pattern: the failed-flush op is committed locally; detach + reattach (or just reattach — it replaces + resets) + explicit flush sends everything. NEW `CollabSession::has_pending_flush() -> bool` ergonomic helper: compares `current_vv` vs `last_flushed_vv.unwrap_or_default()`. Use for IDE status indicators ("Synced" vs "Unsynced changes") + reconnect handshake logic. **Idiom for explicit reattach-then-sync**: `session.attach_transport(t); if session.has_pending_flush() { session.flush_delta_to_transport()?; }` — `attach_transport` doesn't auto-flush by design (lifecycle event, not mutation; preserves V2 V1 `Option<previous>` return signature).
   211	- **Production transport (✅ Phase 5.5 V2 V3 step 4 SHIPPED 2026-05-21 — `ql-collab-ws::WebSocketTransport`):** new sibling crate `ql-collab-ws` houses the first production-grade `Transport` impl. Bridges async tokio-tungstenite (`=0.29.0`) to the sync `Transport` trait via `tokio::sync::mpsc` channels + 2 spawned background tasks (writer drains outbound; reader pushes inbound). Caller pattern (sync): `let rt = tokio::runtime::Runtime::new()?; let ws = rt.block_on(WebSocketTransport::connect("ws://host:port"))?; session.attach_transport(ws);`. `Drop` aborts both background tasks (RAII close). Transport is `Send` (compile-time assert); not `Sync` (single-consumer mpsc). **Why a separate crate**: `ql-collab` core stays runtime-agnostic — embedders that need only `LoopbackTransport` or a custom impl (in-process IPC, gRPC stream) don't pay for tokio. **MVP V1 limitations** (all deferred to V2 V4 in `docs/PHASE-4-V2-BACKLOG.md` Tier I and future):
   212	    - **No TLS (`ws://` only).** Use a TLS-terminating reverse proxy in front, or wait for V2 V4 `rustls` feature.
   213	    - **No auto-reconnect.** On `Err(TransportError::Closed)`, caller drives recovery: `session.detach_transport(); let new_ws = rt.block_on(WebSocketTransport::connect(url))?; session.attach_transport(new_ws);`. V2 V3 step 1's baseline reset (`last_flushed_vv = None` on attach) makes the next flush deliver all accumulated ops including offline ones — the offline-write contract above holds identically for WS.
   214	    - **Unbounded outbound mpsc queue.** Memory grows if peer disconnects + caller keeps appending. Combine with V2 V3 step 3 `has_pending_flush()` for observability; V2 V4 will switch to bounded + backpressure policy.
   215	    - **Client-only.** Server-side WebSocket impls use other libraries (`axum-tungstenite`, `warp::ws`, etc.).
   216	    - **Drops text/ping/pong frames as inbound data.** Loro payloads are binary; non-binary frames don't carry our protocol. Close frames trigger reader task exit + closed-flag set.
   217	- **Presence:** `update_presence(state)` / `peer_presence(peer)` / `clear_presence` / `peers_with_presence` / `sweep_presence` (V2 — caller-opt-in clean-slate on rejoin).
   218	- **Post-merge rename-repair (✅ Phase 5.3 SHIPPED 2026-05-20):** after `merge_bytes`, before recompute, call `CollabSession::rebuild_workbook(&FunctionRegistry) -> Result<(Workbook, SyncReport), CollabSessionError>` to atomically chain `replay_into → repair_sheet_rename_chain → repair_table_rename_chain → repair_column_rename_chain`. Returns a FRESH workbook (caller doesn't pass a workbook by mut-ref — eliminates double-call / stale-workbook misuse class per step 5b audit closure). The `SyncReport` has a one-line `Display` impl for `log::info!` consumption: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`. Caller-driven by design (audit-locked D-5.3-1: repair is NOT auto-invoked by `merge_bytes` so callers can batch multiple merges before paying replay+repair cost). **Without this call**, concurrent-rename formulas surface as `#NAME?` at recompute. Raw `replay_into` + per-pass repair calls remain available for diagnostic / partial-replay flows; see `crates/ql-collab/src/repair.rs` module docs § "Caller contract" for the manual sequence. Repair report types: `SheetRepairReport` + `TableRepairReport` + `ColumnRepairReport` (post-Tier-H8 rename for API symmetry; pre-H8 was `RepairReport` for sheets) — each with `formulas_rewritten: usize` + per-rename summaries + `ambiguous_rules_skipped` diagnostic surfaces. See `docs/phase5/5-3-exit-packet.md` for the full closure record.

 succeeded in 271ms:
   620	    /// **Phase 5.5 V2 V1 (2026-05-19):** attach a `Transport`
   621	    /// implementation to this session. Subsequent
   622	    /// [`flush_to_transport`] calls push the session's current
   623	    /// snapshot through it; [`poll_remote`] drains incoming
   624	    /// bytes and merges them.
   625	    ///
   626	    /// Returns `Some(previous)` if a transport was already
   627	    /// attached and got replaced.
   628	    ///
   629	    /// **Phase 5.5 V2 V2 (2026-05-21):** V2 V1 was explicit-drive
   630	    /// (caller invokes `flush_to_transport` per tick). V2 V2 added
   631	    /// the opt-in [`AutoFlushPolicy::OnAppend`] for IDE callers who
   632	    /// want every mutator to propagate without scheduling their
   633	    /// own ticks. Default policy remains
   634	    /// [`AutoFlushPolicy::Disabled`] so V2 V1 callers see no
   635	    /// behavior change; switch via [`set_auto_flush_policy`].
   636	    ///
   637	    /// **Phase 5.5 V2 V3 step 3 (2026-05-21) — offline-write story
   638	    /// for reconnect**: this method resets `last_flushed_vv` to
   639	    /// `None` (V2 V3 step 1 contract). A new transport-peer hasn't
   640	    /// seen any of this session's ops. The next
   641	    /// [`flush_delta_to_transport`] (or any auto-flushing mutator)
   642	    /// sends from the empty VV — i.e., ALL local ops including
   643	    /// those appended while offline. **Loro's CRDT op log IS the
   644	    /// offline queue; no separate buffer needed.**
   645	    ///
   646	    /// **Idiom for explicit reattach-then-sync** (recommended for
   647	    /// callers that want the new peer to see all state
   648	    /// immediately, rather than waiting for the next mutator):
   649	    /// ```ignore
   650	    /// let _ = session.attach_transport(new_transport);
   651	    /// if session.has_pending_flush() {
   652	    ///     session.flush_delta_to_transport()?;
   653	    /// }
   654	    /// ```
   655	    /// `attach_transport` itself does NOT auto-flush — it's a
   656	    /// lifecycle event, not a mutation, and the existing API
   657	    /// returns `Option<previous>` rather than `Result<>` (changing
   658	    /// that would be a breaking V2 V1 API change). Callers needing
   659	    /// immediate sync trigger it explicitly.
   660	    pub fn attach_transport<T: Transport + Send + 'static>(
   661	        &mut self,
   662	        transport: T,
   663	    ) -> Option<Box<dyn Transport + Send>> {
   664	        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** reset `last_flushed_vv`
   665	        // to `None`. A new transport-peer hasn't seen ANY of this
   666	        // session's ops, so the next `flush_delta_to_transport` must
   667	        // send from the empty VV (= all ops). If we kept the stale
   668	        // VV from a prior transport, the new peer would miss ops
   669	        // 0..stale_vv and end up with a corrupt view.
   670	        self.last_flushed_vv = None;
   671	        self.transport.replace(Box::new(transport))
   672	    }
   673	
   674	    /// **Phase 5.5 V2 V1 (2026-05-19):** detach the current
   675	    /// transport. Returns it for caller cleanup; returns `None`
   676	    /// if no transport was attached.
   677	    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
   678	        // Phase 5.5 V2 V3 step 1: orphaned VV is meaningless. Clear so
   679	        // a subsequent `attach_transport` lands on a clean baseline.
   680	        self.last_flushed_vv = None;
   681	        self.transport.take()
   682	    }
   683	
   684	    /// **Phase 5.5 V2 V1 (2026-05-19):** true iff a transport is
   685	    /// currently attached.
   686	    pub fn has_transport(&self) -> bool {
   687	        self.transport.is_some()
   688	    }
   689	
   690	    /// **Phase 5.5 V2 V2 (2026-05-21):** set the auto-flush policy

exec
/bin/zsh -lc 'rg -n "fn .*websocket|fn .*connect|fn .*send|fn .*close|fn .*drop|fn collab" crates/ql-collab-ws/tests/websocket_transport.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'rg -n "Text|Ping|Pong|non-binary|text/ping|Message::Text|Message::Ping|Message::Pong" crates/ql-collab-ws/tests crates/ql-collab-ws/src/lib.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/session.rs | sed -n '913,1060p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 340ms:
65:fn connect_to_echo_server_succeeds() {
77:fn connect_to_invalid_url_returns_err() {
91:fn connect_to_nonexistent_server_returns_connect_failed() {
106:fn connect_to_non_websocket_tcp_server_returns_handshake_or_connect_failed() {
132:fn send_recv_round_trip_via_echo_server() {
150:fn multiple_sends_preserve_fifo_order_through_echo() {
178:fn explicit_close_blocks_send_returns_closed() {
196:fn explicit_close_drains_inbox_before_returning_closed() {
242:fn server_close_propagates_to_try_recv_as_closed() {
281:fn drop_aborts_background_tasks() {
313:fn collab_session_attach_websocket_round_trip_via_echo() {
367:fn collab_session_websocket_reattach_after_close_delivers_offline_ops() {
435:fn collab_session_websocket_send_after_close_surfaces_closed() {

 succeeded in 333ms:
   913	    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
   914	        if self.transport.is_none() {
   915	            return Ok(false);
   916	        }
   917	        let current_vv = self.log.oplog_vv();
   918	        // Idempotency short-circuit: no state change since last flush.
   919	        // Closes V2 V2 audit M2/M3 (echo-loop). NOTE: VersionVector
   920	        // equality is by value (Loro impls PartialEq via the
   921	        // underlying op count per peer); a session that hasn't
   922	        // appended/merged anything since the prior flush returns
   923	        // Ok(false) without invoking transport.send.
   924	        if let Some(last_vv) = self.last_flushed_vv.as_ref() {
   925	            if last_vv == &current_vv {
   926	                return Ok(false);
   927	            }
   928	        }
   929	        // Encode delta bytes. `from = last_flushed_vv` (or empty if None).
   930	        let bytes = match self.last_flushed_vv.as_ref() {
   931	            Some(from) => self.log.export_delta_bytes(from)?,
   932	            None => self
   933	                .log
   934	                .export_delta_bytes(&loro::VersionVector::default())?,
   935	        };
   936	        // Now borrow transport mutably for the send. Done in two
   937	        // phases because we needed self.log (immut) above and need
   938	        // self.transport (mut) here — borrow-checker dance.
   939	        let transport = self.transport.as_mut().expect("just-checked is_some above");
   940	        transport.send(&bytes)?;
   941	        // Advance the VV checkpoint. Only on success — Err leaves
   942	        // last_flushed_vv at its prior value so retry sends the
   943	        // same delta.
   944	        self.last_flushed_vv = Some(current_vv);
   945	        Ok(true)
   946	    }
   947	
   948	    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** drain
   949	    /// the attached transport's recv queue up to a default cap
   950	    /// (`DEFAULT_POLL_REMOTE_LIMIT = 64` blobs), merging each
   951	    /// blob into the local `OpLog`. Returns the number of blobs
   952	    /// merged.
   953	    ///
   954	    /// For unbounded drain (or a different cap), use
   955	    /// [`poll_remote_with_limit`]. The cap prevents one
   956	    /// `poll_remote` call from starving the calling thread when
   957	    /// a future externally-fed transport is producing faster
   958	    /// than we drain.
   959	    ///
   960	    /// Returns `Ok(0)` if no transport attached.
   961	    /// `TransportError::Closed` is handled gracefully — the
   962	    /// trait contract guarantees Closed only after the queue
   963	    /// drains, so the merge count reflects all queued blobs and
   964	    /// the function returns `Ok(merged)`. `Io` errors propagate
   965	    /// as `CollabSessionError::Transport` — any merges before
   966	    /// the error already persist in the local `OpLog`.
   967	    ///
   968	    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** triggers ONE
   969	    /// auto-flush after the drain batch (not per-blob), routed
   970	    /// through [`flush_delta_to_transport`] when
   971	    /// [`auto_flush_policy`] is `OnAppend` AND at least one blob
   972	    /// was actually drained. V2 V3 step 1's idempotency short-
   973	    /// circuit handles the Loro-deduped (no-op) merge case: if
   974	    /// the drained bytes contained only ops already known
   975	    /// locally, the post-merge VV doesn't advance and the
   976	    /// auto-flush returns `Ok(false)` without invoking
   977	    /// `transport.send`.
   978	    ///
   979	    /// V2 V2 audit (Codex M1 + Opus M1) flagged the prior
   980	    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
   981	    /// version-vector idempotency guard makes wiring it in safe
   982	    /// (no echo loop), and V2 V3 step 2 (this) reverses the
   983	    /// exclusion. The 3-peer fanout pattern (hub drains peer B's
   984	    /// blob → hub auto-flushes merged state onward) now works
   985	    /// automatically under `OnAppend`.
   986	    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
   987	        self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
   988	    }
   989	
   990	    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** like
   991	    /// [`poll_remote`] but with an explicit per-call cap on the
   992	    /// number of blobs to drain.
   993	    ///
   994	    /// `max_blobs == 0` is a no-op (returns `Ok(0)` even if
   995	    /// blobs are queued — call again with a non-zero cap).
   996	    ///
   997	    /// Returns `Ok(merged)` where `merged <= max_blobs`. If the
   998	    /// returned count equals `max_blobs`, more blobs may still
   999	    /// be queued — call again. If less, the queue drained
  1000	    /// (either empty or transport reported `Closed`).
  1001	    ///
  1002	    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** when at least one
  1003	    /// blob was drained AND [`auto_flush_policy`] is `OnAppend`,
  1004	    /// fires ONE auto-flush after the loop (per-batch, not
  1005	    /// per-blob — bandwidth efficient). Routed through
  1006	    /// [`flush_delta_to_transport`]; V2 V3 step 1's idempotency
  1007	    /// guard short-circuits when the post-merge VV equals the
  1008	    /// pre-poll `last_flushed_vv` (i.e., the drained blobs only
  1009	    /// contained ops already known locally — Loro-deduped merge).
  1010	    ///
  1011	    /// **Partial-state contract on auto-flush failure**: if the
  1012	    /// post-batch auto-flush fails (closed transport, I/O error
  1013	    /// during the send), the method returns
  1014	    /// `Err(CollabSessionError::Transport(_))` AFTER all `merged`
  1015	    /// blobs have been committed to `self.log`. The caller never
  1016	    /// sees `Ok(merged)` in this case; inspect `op_count()` to
  1017	    /// determine how many merges actually committed locally.
  1018	    /// `last_flushed_vv` is NOT advanced on flush Err — a retry
  1019	    /// (e.g., manual [`flush_delta_to_transport`] after detaching
  1020	    /// and reattaching a working transport) sends the same delta the
  1021	    /// failed call would have.
  1022	    pub fn poll_remote_with_limit(
  1023	        &mut self,
  1024	        max_blobs: usize,
  1025	    ) -> Result<usize, CollabSessionError> {
  1026	        let Some(transport) = self.transport.as_mut() else {
  1027	            return Ok(0);
  1028	        };
  1029	        let mut merged = 0usize;
  1030	        while merged < max_blobs {
  1031	            match transport.try_recv() {
  1032	                Ok(Some(bytes)) => {
  1033	                    self.log.merge_bytes(&bytes)?;
  1034	                    merged += 1;
  1035	                }
  1036	                Ok(None) => break,
  1037	                Err(TransportError::Closed) => {
  1038	                    // Trait contract: Closed only after queue drains. Any
  1039	                    // already-drained bytes are accounted in `merged`.
  1040	                    // Treat as graceful end-of-stream.
  1041	                    break;
  1042	                }
  1043	                Err(other) => return Err(CollabSessionError::Transport(other)),
  1044	            }
  1045	        }
  1046	        // **Phase 5.5 V2 V3 step 2 (2026-05-21):** auto-flush after
  1047	        // the drain batch. ONE flush per call (not per-blob) —
  1048	        // bandwidth-efficient. V2 V3 step 1's idempotency guard at
  1049	        // `flush_delta_to_transport` returns Ok(false) without
  1050	        // invoking transport.send when no state advanced (Loro-
  1051	        // deduped merge). Skip when 0 blobs drained: state didn't
  1052	        // change locally, no point firing the VV-clone+compare
  1053	        // path (defensive optimization).
  1054	        if merged > 0 {
  1055	            self.maybe_auto_flush()?;
  1056	        }
  1057	        Ok(merged)
  1058	    }
  1059	
  1060	    /// **Phase 5.6 V1 (2026-05-19):** write this session's own

 succeeded in 344ms:
crates/ql-collab-ws/src/lib.rs:58://! - **Drops text/ping/pong/close frames as inbound data.** Loro
crates/ql-collab-ws/src/lib.rs:59://!   payloads are binary blobs; non-binary frames don't carry our
crates/ql-collab-ws/src/lib.rs:242:                        Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_),
crates/ql-collab-ws/tests/common/mod.rs:4://! port). Echoes binary frames back to sender; drops text/ping/pong.

exec
/bin/zsh -lc 'rg -n "tokio-tungstenite|native-tls|rustls|webpki|tokio-rustls" Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"features|default\" ~/.cargo/registry/src -g 'Cargo.toml' | rg 'tokio-tungstenite-0.29.0/Cargo.toml|tungstenite-0.29.0/Cargo.toml'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "find ~/.cargo/registry/src -path '*tokio-tungstenite-0.29.0/Cargo.toml' -o -path '*tungstenite-0.29.0/Cargo.toml'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 267ms:
2135: "tokio-tungstenite",
2997:name = "tokio-tungstenite"

 succeeded in 400ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:53:all-features = true
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:55:[features]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:69:default = [
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:104:required-features = ["connect"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:109:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:114:required-features = ["connect"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:119:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:124:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:129:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:134:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:139:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:143:features = [
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:147:default-features = false
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:160:default-features = false
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:172:features = ["io-util"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:173:default-features = false
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:182:default-features = false
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:186:default-features = false
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:203:features = [
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:207:default-features = false
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:211:features = ["tokio"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:215:features = [
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml:222:default-features = false
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:52:all-features = true
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:54:[features]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:59:default = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:88:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:93:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:98:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:103:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:108:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:113:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:124:required-features = ["handshake"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:164:features = ["std"]
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml:166:default-features = false

 succeeded in 736ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml

exec
/bin/zsh -lc "nl -ba ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-tungstenite-0.29.0/Cargo.toml | sed -n '55,95p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tungstenite-0.29.0/Cargo.toml | sed -n '54,82p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba Cargo.lock | sed -n '2988,3020p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 333ms:
    55	[features]
    56	__rustls-tls = [
    57	    "rustls",
    58	    "rustls-pki-types",
    59	    "tokio-rustls",
    60	    "stream",
    61	    "tungstenite/__rustls-tls",
    62	    "handshake",
    63	]
    64	connect = [
    65	    "stream",
    66	    "tokio/net",
    67	    "handshake",
    68	]
    69	default = [
    70	    "connect",
    71	    "handshake",
    72	]
    73	handshake = ["tungstenite/handshake"]
    74	native-tls = [
    75	    "native-tls-crate",
    76	    "tokio-native-tls",
    77	    "stream",
    78	    "tungstenite/native-tls",
    79	    "handshake",
    80	]
    81	native-tls-vendored = [
    82	    "native-tls",
    83	    "native-tls-crate/vendored",
    84	    "tungstenite/native-tls-vendored",
    85	]
    86	rustls-tls-native-roots = [
    87	    "__rustls-tls",
    88	    "rustls-native-certs",
    89	]
    90	rustls-tls-webpki-roots = [
    91	    "__rustls-tls",
    92	    "webpki-roots",
    93	]
    94	stream = []
    95	url = ["tungstenite/url"]

 succeeded in 324ms:
    54	[features]
    55	__rustls-tls = [
    56	    "rustls",
    57	    "rustls-pki-types",
    58	]
    59	default = ["handshake"]
    60	handshake = [
    61	    "data-encoding",
    62	    "http",
    63	    "httparse",
    64	    "sha1",
    65	]
    66	native-tls = ["native-tls-crate"]
    67	native-tls-vendored = [
    68	    "native-tls",
    69	    "native-tls-crate/vendored",
    70	]
    71	rustls-tls-native-roots = [
    72	    "__rustls-tls",
    73	    "rustls-native-certs",
    74	]
    75	rustls-tls-webpki-roots = [
    76	    "__rustls-tls",
    77	    "webpki-roots",
    78	]
    79	url = ["dep:url"]
    80	
    81	[lib]
    82	name = "tungstenite"

 succeeded in 317ms:
  2988	source = "registry+https://github.com/rust-lang/crates.io-index"
  2989	checksum = "5c55a2eff8b69ce66c84f85e1da1c233edc36ceb85a2058d11b0d6a3c7e7569c"
  2990	dependencies = [
  2991	 "proc-macro2",
  2992	 "quote",
  2993	 "syn 2.0.117",
  2994	]
  2995	
  2996	[[package]]
  2997	name = "tokio-tungstenite"
  2998	version = "0.29.0"
  2999	source = "registry+https://github.com/rust-lang/crates.io-index"
  3000	checksum = "8f72a05e828585856dacd553fba484c242c46e391fb0e58917c942ee9202915c"
  3001	dependencies = [
  3002	 "futures-util",
  3003	 "log",
  3004	 "tokio",
  3005	 "tungstenite",
  3006	]
  3007	
  3008	[[package]]
  3009	name = "toml"
  3010	version = "0.9.7"
  3011	source = "registry+https://github.com/rust-lang/crates.io-index"
  3012	checksum = "00e5e5d9bf2475ac9d4f0d9edab68cc573dc2fd644b0dba36b0c30a92dd9eaa0"
  3013	dependencies = [
  3014	 "indexmap",
  3015	 "serde_core",
  3016	 "serde_spanned",
  3017	 "toml_datetime",
  3018	 "toml_parser",
  3019	 "toml_writer",
  3020	 "winnow 0.7.15",

codex
**VERDICT: PASS-WITH-FINDINGS**

**HIGH**
None.

**MEDIUM**
None.

**LOW**

1. Doc limitation list is inconsistent across the requested surfaces. The crate docs list the frame-drop limitation:

[crates/ql-collab-ws/src/lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab-ws/src/lib.rs:58):
```rust
//! - **Drops text/ping/pong/close frames as inbound data.** Loro
```

But the core transport doc only lists four deferred limits:

[crates/ql-collab/src/transport.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:58):
```rust
//! (TLS, auto-reconnect, bounded queue, server side).
```

Same omission in the plan and exit packet:

[docs/MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:588):
```md
V1 limitations deferred to V2 V4 (TLS, bounded backpressure, reconnect wrapper, server-side crate).
```

[docs/phase5/v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:296):
```md
partial-state on server close). V1 limitations deferred to V2 V4
```

2. `MASTER-PLAN.md` section header is stale relative to its own step rows. It still says V2 V3 steps 2-6 are pending:

[docs/MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:581):
```md
V2 V3 steps 2-6 pending.
```

but the same section marks steps 2, 3, and 4 shipped, including:

[docs/MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:588):
```md
- **V2 V3 step 4 ✅ SHIPPED 2026-05-21**: WebSocket transport impl.
```

3. Non-binary inbound-frame handling is documented and implemented, but not test-pinned. The implementation silently drops these frames:

[crates/ql-collab-ws/src/lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab-ws/src/lib.rs:241):
```rust
Ok(
    Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_),
) => {
    // Non-binary frames dropped per protocol
```

The integration test list has no text/ping/pong case; it covers connect, binary round-trip/FIFO, close/drop, and CollabSession paths.

**Confirmed**
`send`, `try_recv`, task `Drop`, `Send` assertion, error mapping, and the three CollabSession integration tests match the stated contract. I did not run `cargo test`, per your instruction.
tokens used
76,975
**VERDICT: PASS-WITH-FINDINGS**

**HIGH**
None.

**MEDIUM**
None.

**LOW**

1. Doc limitation list is inconsistent across the requested surfaces. The crate docs list the frame-drop limitation:

[crates/ql-collab-ws/src/lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab-ws/src/lib.rs:58):
```rust
//! - **Drops text/ping/pong/close frames as inbound data.** Loro
```

But the core transport doc only lists four deferred limits:

[crates/ql-collab/src/transport.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:58):
```rust
//! (TLS, auto-reconnect, bounded queue, server side).
```

Same omission in the plan and exit packet:

[docs/MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:588):
```md
V1 limitations deferred to V2 V4 (TLS, bounded backpressure, reconnect wrapper, server-side crate).
```

[docs/phase5/v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:296):
```md
partial-state on server close). V1 limitations deferred to V2 V4
```

2. `MASTER-PLAN.md` section header is stale relative to its own step rows. It still says V2 V3 steps 2-6 are pending:

[docs/MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:581):
```md
V2 V3 steps 2-6 pending.
```

but the same section marks steps 2, 3, and 4 shipped, including:

[docs/MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:588):
```md
- **V2 V3 step 4 ✅ SHIPPED 2026-05-21**: WebSocket transport impl.
```

3. Non-binary inbound-frame handling is documented and implemented, but not test-pinned. The implementation silently drops these frames:

[crates/ql-collab-ws/src/lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab-ws/src/lib.rs:241):
```rust
Ok(
    Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_),
) => {
    // Non-binary frames dropped per protocol
```

The integration test list has no text/ping/pong case; it covers connect, binary round-trip/FIFO, close/drop, and CollabSession paths.

**Confirmed**
`send`, `try_recv`, task `Drop`, `Send` assertion, error mapping, and the three CollabSession integration tests match the stated contract. I did not run `cargo test`, per your instruction.
