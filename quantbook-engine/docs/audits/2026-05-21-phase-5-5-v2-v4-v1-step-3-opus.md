# V2 V4 V1 step 3 — Opus adversarial audit

**Target HEAD:** `d19fb5ee85d`
**Workspace gate:** 4451 / 0, fmt + clippy clean.
**Scope:** Tier J1 (RejectingServer determinism), J2 (TextFrameServer + text-frame drop test), J3 (Send + Sync compile-time asserts with docstring correction), bundled K5 (WebSocketError Send+Sync assert).
**Predecessor:** `0bd592a4aa8`.

## Verdict

**Ship.** Real bugs in scope are minor (LOW/INFO). One MEDIUM is a stale workspace-Cargo.toml comment from the old `!Sync` framing that survived the docstring correction. The Tier J3 docstring is honest about the V2 V3 step 4 mistake — the prior wrong claim is named, root-caused (Sync ≠ exclusive-access), and pinned with a positive assert. The procedural finding (3 consecutive ships with audit-caught bugs) deserves a Tier-bucket entry.

---

## HIGH

_None._

---

## MEDIUM

### M1. Stale `!Sync` comment in workspace `Cargo.toml` (lines 61-64)
The workspace `Cargo.toml` block introducing `static_assertions` still reads:
```
# Phase 5.5 V2 V4 V1 step 3 (2026-05-21) — Tier J3 compile-time
# assert that `WebSocketTransport: !Sync`. `static_assertions` is a
# tiny no-runtime-cost crate exposing `assert_not_impl_all!` and
# `assert_impl_all!` macros. Used only by ql-collab-ws.
```
The comment mentions `assert_not_impl_all!` first and claims the dep was added to assert `!Sync` — both stale relative to the actual ship which uses `assert_impl_all!` to pin `Sync`. Asymmetric closure: the lib.rs docstring + comment are corrected, the backlog is corrected, but the workspace dep comment was not. Future engineers reading the dep block would believe the wrong contract.
**Fix:** rewrite to "compile-time assert that `WebSocketTransport: Send + Sync` (and `WebSocketError: Send + Sync`)" and drop the `assert_not_impl_all!` mention.

### M2. RejectingServer determinism has an unaudited shutdown race
The fixture writes `b"HTTP/1.1 999 GARBAGE\r\n\r\n"` then `stream.shutdown().await`. The doc comment claims "deterministic" handshake-error mapping. Two race paths the comment does not acknowledge:
1. The write may flush only into the kernel buffer; shutdown sends FIN. If the client's TCP stack reads the bytes BEFORE seeing FIN, tungstenite's HTTP response parser sees a complete malformed response → `Http(_)` → `HandshakeFailed` ✓.
2. On Linux/Windows, an aggressive close-with-pending-data can produce RST instead of FIN-then-data (SO_LINGER=0 semantics, but tokio doesn't set that). Rare in practice with `shutdown().await` which honors the write half.
The 4451 / 0 gate runs on this Mac (BSD socket semantics). The `lib.rs::connect` mapping has a catch-all `_ => HandshakeFailed(msg)` arm, so most `Io` paths still produce HandshakeFailed... **except `tungstenite::Error::Io(_)` which maps to `ConnectFailed` explicitly.** A FIN/RST race that surfaces a partial-read `Io` error → test fails strict.
**Recommendation:** either (a) keep the strict assertion + document that the gate is "Mac/Linux empirical" and add a CI matrix note that Windows-on-CI may need a soft-assert reintroduction, or (b) defer-to-V2 V4 a "BadHandshakeResponse" fixture that wraps the connection in a custom acceptor that completes the HTTP framing properly (write 200 OK with non-101 status) — this would actually be `Http(_)` per the protocol, not "malformed". The current "999 GARBAGE" is a malformed-status-line path that some parsers might route through `HttpFormat(_)` or `Protocol(_)` depending on tungstenite version. The fall-through `_` arm catches everything except `Io` and `Url`, so the test mostly works — but the fixture comment overstates determinism.

---

## LOW

### L1. J2 test concurrency assumption
`handle_text_then_binary` calls `ws.send(Text)` then `ws.send(Binary)` sequentially. tokio-tungstenite's SinkExt::send flushes per call (or auto-flushes), so frames hit the wire in order. The client reader task processes frames serially from `ws_stream.next()`, so binary-after-text ordering is preserved. **OK** — but worth a one-line comment in the fixture that the ordering is what pins the test (if both frames arrived "atomically" via re-ordering the server would still pass, but the test asserts the binary is delivered AFTER the text-drop, which is the contract).

### L2. J2 test uses 1-second poll budget with 10ms sleeps
`for _ in 0..100 { ... sleep(10ms) }` totals 1 second. Loopback + tokio is fast (frames typically deliver within first 1-2 iterations). 1 second is generous on a loaded CI runner. **OK** — matches the existing `await_blob(&mut ws, 100)` pattern elsewhere in the file (consistency).

### L3. The final `try_recv` assertion in J2 is not robust to delayed pings
The test asserts `next = try_recv()` returns `Ok(None)` after the binary frame. tokio-tungstenite 0.29 client does NOT auto-ping by default (only auto-pongs in response to peer pings). Server fixture sends Text + Binary then idles inside `while let Some(msg_result) = ws.next().await { ... }` — no pings sent. The assertion is safe.
**Forward concern:** if V2 V4 enables `WebSocketConfig::ping_interval` (V1 Cargo.toml line 47-58 already mentions "rustls + heartbeats" deferred to V2 V4), this test's final assertion would start observing pings. Pings are silently dropped by the reader task per the documented contract → `try_recv` still returns `Ok(None)`. **Safe by design.** Worth a one-line forward-comment.

### L4. `Cargo.toml` `static_assertions = "=1.1.0"` lacks features-discipline note
Other workspace deps document `default-features = false` when applicable. `static_assertions` has no default features (verified — crate is feature-free), so omitting `default-features = false` is correct. No issue, just inconsistent commenting density. **Skip.**

### L5. The corrected `## Send + Sync` docstring section says the prior claim was "incorrectly based on intuition"
The phrasing is honest. It identifies the mental model that produced the bug: "the single-consumer mpsc receiver should prevent sharing." It distinguishes `Sync` (referential, `&T` cross-thread) from `&mut` exclusivity (borrow checker). **Adequate.** One small clarity nit: the section doesn't mention that `tokio::sync::mpsc::UnboundedReceiver` is itself `Sync` in tokio 1.50 (the prior intuition was that the Receiver should be `!Sync`). A one-liner like "in particular, `mpsc::UnboundedReceiver` is `Sync` even though `recv`/`try_recv` take `&mut self` — that's the conceptual root of the original mistake" would close the loop.

---

## INFO / PROCEDURAL

### P1. Three consecutive ships with audit-caught substantive bugs — pattern signal
- V2 V4 V1 step 1: single-threaded runtime deadlock (caught at first test run, not by review).
- V2 V4 V1 step 2: visible-list count source bug (caught by audit).
- V2 V4 V1 step 3: wrong `!Sync` docstring (caught at first compile of the assert — not by V2 V3 step 4 ship review, not by V2 V3 step 4 single-lane audit, not by V2 V3 step 5 3-lane megaudit).

This is a **review-coverage gap**, not a Tier-bucket item. Auditors check "what does the docstring say" but not "is the claim true." Pattern recommendation: when a future audit sees a `!Trait` claim in a docstring, the auditor should mentally try `assert_not_impl_all!` (or read the fields and confirm) rather than accept the claim. Add to `quantbook_engine_audit_discipline.md`:
> _Whenever code documents a negative trait bound (`!Send`, `!Sync`, `!Unpin`), require either (a) a compile-time `assert_not_impl_all!` proving it OR (b) a per-field walk of the trait impls in the audit. Negative claims without proof are recurring sources of stale docstrings._

### P2. K5 bundling is clean
J3 closure ships both asserts in one block (transport + error type). Backlog entry K5 cross-references J3 with explicit "bundled" language. Backlog SHIPPED markings on J1/J2/J3/K5 are consistent. **OK.**

### P3. The `_ => WebSocketError::HandshakeFailed(msg)` catch-all is load-bearing for J1
Without the catch-all, a `tungstenite::Error::Protocol(_)` path from the "999 GARBAGE" parser would not map to HandshakeFailed. The catch-all dates from V2 V3 step 4. The J1 closure implicitly depends on it. **Defensive note for V2 V4:** if the error-mapping is ever refactored to be exhaustive (removing the `_`), the J1 test could regress. Worth a comment near the catch-all.

---

## Confirmed safe

- `static_assertions = "=1.1.0"` exact-pin follows workspace convention.
- `Cargo.lock` gained one new entry (small, no-runtime-cost crate per the docstring).
- J3 lib.rs comment block (lines 752-779) honestly recants the V2 V3 step 4 claim and explains the root cause (Sync vs &mut self confusion).
- WebSocketError Send + Sync (4 String-carrying variants) — assert catches any future `Rc<...>`/`Cell<...>` regression.
- TextFrameServer Drop semantics mirror EchoServer (per-conn task tracking + abort on drop). No leak risk.
- Test rename — no stale references outside the rename-comment itself and the historical audit/plan files.
- `inbound_rx` field comment was not edited; it still references `try_recv` for the drain path which is consistent with the new positive Sync assert.

---

## Summary line for closure log

0 HIGH / 2 MEDIUM (1 stale-comment, 1 race-doc) / 5 LOW (4 nit + 1 forward-leaning) / 3 INFO. Procedural finding P1 (negative-trait docstring claims require proof) deserves audit-discipline memory update.
