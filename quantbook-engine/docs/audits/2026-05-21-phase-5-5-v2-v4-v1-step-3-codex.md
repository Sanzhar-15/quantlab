---
title: Phase 5.5 V2 V4 V1 step 3 audit - Codex
date: 2026-05-21
audit_target: HEAD `d19fb5ee85d`
predecessor: `0bd592a4aa8`
auditor: Codex
verdict: PASS-WITH-FINDINGS
scope: Tier J bundle defensive hardening, plus bundled K5
---

# Phase 5.5 V2 V4 V1 step 3 audit - Codex

## VERDICT: PASS-WITH-FINDINGS

No HIGH or MEDIUM findings. J1 is deterministic at the public API boundary, J2 correctly pins the text-frame silent-drop contract, and J3/K5 correctly add positive compile-time trait-bound assertions for the actual `Send + Sync` state.

The main caveat is documentation drift. Some durable docs and dependency comments still describe the old `WebSocketTransport: !Sync` plan even though the shipped code now asserts `Sync`. The RejectingServer comments also overstate the parser path: `HTTP/1.1 999 GARBAGE\r\n\r\n` is parsed by tungstenite 0.29.0 as a complete HTTP response with a non-101 status, so the actual inner error is `tungstenite::Error::Http(_)`, not `HttpFormat(_)` and not `Io(_)`.

No cargo tests were run, per instruction.

## HIGH

None.

## MEDIUM

None.

## LOW

### L1 - Durable docs and Cargo comments still claim the old `!Sync` contract

Evidence:

`WebSocketTransport` now documents and asserts `Sync`:

```rust
// crates/ql-collab-ws/src/lib.rs:260
/// `WebSocketTransport: Send + Sync` ...

// crates/ql-collab-ws/src/lib.rs:770
static_assertions::assert_impl_all!(WebSocketTransport: Sync);
```

But several nearby/durable surfaces still say `!Sync`:

```toml
# Cargo.toml:61
# Phase 5.5 V2 V4 V1 step 3 ... compile-time
# assert that `WebSocketTransport: !Sync`.
```

```toml
# crates/ql-collab-ws/Cargo.toml:22
# assert that `WebSocketTransport: !Sync` ...
# ... `assert_not_impl_all!` ...
# ... future Sync-introducing refactor fails the build
```

```md
// docs/architecture/ide-consumer-contract.md:211
Transport is `Send` (compile-time assert); not `Sync` (single-consumer mpsc).

// docs/architecture/ide-consumer-contract.md:397
`WebSocketTransport` is `Send + !Sync`.

// docs/phase5/v2-v3-exit-packet.md:133
J3: `WebSocketTransport: !Sync` compile-time assert via `static_assertions`.
```

There is also a smaller local precision issue in the corrected docstring: it says both `Send + Sync` are asserted via `static_assertions` macros, but `Send` remains pinned by the pre-existing manual const assert while only `Sync` uses `static_assertions`.

Impact: no runtime or compile-time break; the shipped code pins the actual contract. The stale docs can mislead IDE consumers and future maintainers about whether shared-reference wrappers around the concrete transport are allowed.

Suggested closure: update the Cargo comments, IDE consumer contract, and V2 V3 exit packet to say `WebSocketTransport: Send + Sync`; clarify that single-consumer receive is enforced by `try_recv(&mut self)`, not by `!Sync`. Adjust the docstring phrase to "compile-time asserts" or convert the old Send const to `assert_impl_all!(WebSocketTransport: Send, Sync)`.

### L2 - RejectingServer comments/docs misdescribe the exact tungstenite parser path

Evidence:

The fixture writes this response:

```rust
// crates/ql-collab-ws/tests/common/mod.rs:150
let _ = stream.write_all(b"HTTP/1.1 999 GARBAGE\r\n\r\n").await;
```

Several comments/docs call it malformed or invalid:

```rust
// crates/ql-collab-ws/tests/common/mod.rs:117
/// The new version writes 8 bytes of garbage ...

// crates/ql-collab-ws/tests/common/mod.rs:144
// Deliberately malformed HTTP response ...
// ... status code is invalid garbage ...
```

```md
// docs/PHASE-4-V2-BACKLOG.md:546
tokio-tungstenite's handshake parser raises `Http(_)`/`HttpFormat(_)`
```

Actual tungstenite 0.29.0 path for this byte sequence:

1. `HandshakeMachine::single_round` reads bytes and calls `Obj::try_parse`.
2. `Response::try_parse` uses `httparse::Response::parse`; `\r\n\r\n` makes it `Complete`.
3. `Response::from_httparse` calls `StatusCode::from_u16(999)`.
4. `http` 1.4 accepts status values `100..=999`; `999` is unclassified but syntactically allowed.
5. `VerifyData::verify_response` rejects anything other than `101 Switching Protocols` and returns `Error::Http(response.into())`.
6. `WebSocketTransport::connect` maps `Error::Http(_)` to `WebSocketError::HandshakeFailed`.

So the contract is correct, but for a different reason than the comments imply: this is a parseable, complete, non-101 HTTP response, not a malformed status-line failure. The actual variant for the byte sequence is `tungstenite::Error::Http(_)`.

Impact: no test flake found. The response terminator is present, so tungstenite does not need EOF to finish parsing, and the public test asserts the intended `HandshakeFailed` wrapper. The issue is traceability/diagnostic accuracy.

Suggested closure: change the comments/backlog wording to "complete non-101 HTTP response with an unclassified 999 status" and "deterministically returns `Error::Http(_)` under tungstenite 0.29.0." Remove the "8 bytes of garbage", "invalid status", and `HttpFormat` language unless a truly malformed byte sequence is used.

## CONFIRMED CORRECT / NO FINDING

- J1 public behavior is deterministic for the shipped fixture: the response parses before EOF and non-101 maps to `WebSocketError::HandshakeFailed`. If a future parser rejected 999 as format-invalid, the existing `HttpFormat(_)` mapping would still land in the same public variant.
- J2 is correctly pinned. `TextFrameServer` sends one text frame and one binary frame; the reader task only enqueues `Message::Binary` and silently drops `Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_)`. The test would fail if a future refactor delivered the text payload as bytes, because it would receive the wrong blob before the binary payload.
- The J2 race window is handled by the 100 x 10 ms polling loop. The fixture does not send Ping, so tokio-tungstenite auto-pong behavior is not in this test's observable inbound path.
- J3's positive `WebSocketTransport: Sync` assert matches the actual field set: mpsc handles, `Arc<AtomicBool>`, `Arc<Mutex<_>>`, `Arc<AtomicU64>`, `Arc<(Mutex<u64>, Condvar)>`, and tokio `JoinHandle<()>` all satisfy the required bounds in this build. The receiver's single-consumer behavior is enforced by `try_recv(&mut self)`.
- K5 is correctly bundled: `WebSocketError` has only `String` payloads today, and `assert_impl_all!(WebSocketError: Send, Sync)` will catch a future non-thread-safe payload.
- `static_assertions` adds only the single `1.1.0` package to `Cargo.lock`; no transitive dependencies were introduced.
- Active code/doc references to the old test name are limited to explanatory comments and historical audit files. No non-audit caller/test depends on `connect_to_non_websocket_tcp_server_returns_handshake_or_connect_failed`.

## TEST COVERAGE

No tests were run for this audit. The supplied workspace gate was `4451 / 0` with `--test-threads=1`, plus clean fmt and clippy.

The new tests cover the intended public contracts:

- strict `Err(WebSocketError::HandshakeFailed(_))` for the rejecting TCP fixture;
- text-frame silent drop while the subsequent binary frame still delivers;
- compile-time trait bounds for `WebSocketTransport: Sync` and `WebSocketError: Send + Sync`.
