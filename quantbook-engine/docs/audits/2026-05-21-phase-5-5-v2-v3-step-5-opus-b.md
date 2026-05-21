---
title: Phase 5.5 V2 V3 step 5 megaudit — Opus-B lane (defensive/adversarial)
date: 2026-05-21
audit_target: HEAD `0addbb2efd0` (cumulative V2 V3 steps 1-4)
auditor: Opus-B
verdict: PASS-WITH-FINDINGS (0 HIGH + 6 MEDIUM + 4 LOW)
lane: defensive/adversarial
---

# Phase 5.5 V2 V3 step 5 megaudit — Opus-B lane

## VERDICT: PASS-WITH-FINDINGS

The V2 V3 step 1-4 arc is correct on the happy paths exercised by the 4433-test gate, but its **silent-loss surface** is wider than the docs admit. The single most likely production-visible failure is `WebSocketTransport::Drop` discarding queued outbound bytes the caller has already been told are "queued for send" (trait contract: `send` returns when bytes are queued, not delivered). For an IDE consumer that auto-flushes the last op and then closes the workbook tab, that last delta vanishes on the wire — peer never sees it — and `has_pending_flush()` already reports false because the local VV was advanced. The offline-write story does NOT recover this case (it depends on `last_flushed_vv` rollback, which never happened).

Secondary defensive concerns cluster around (a) two silent-error swallows that violate CLAUDE.md no-fallback (poisoned `last_error` mutex, dropped reader-task `inbound_tx.send` `is_err()`), (b) one race in the test fixture (EchoServer accept→push under separate locks) that could leak per-conn tasks past test end on adverse interleaving, and (c) a panic-in-task gap: tokio runtime swallows panics in spawned tasks, the `closed` flag is set only on `Err` arms, so a panicked reader/writer leaves the transport in `closed = false` state with no tasks running — caller polls `try_recv` forever returning `Ok(None)`.

None of these are HIGH because each requires a corner-case interleaving or a panic that the current code doesn't appear to produce. But the audit prompt asks "where will future changes silently break invariants?" — and the answers here are concentrated, not diffuse. Codex's protocol lane and Opus-A's IDE round-trip lane should cross-validate the M1 finding in particular (drop-loss).

---

## MEDIUM

### M1 — `WebSocketTransport::Drop` silently discards queued-but-unsent bytes; offline-write story does not recover them

File: `crates/ql-collab-ws/src/lib.rs` lines 370-390. Cross-ref: `Transport::send` docstring at `crates/ql-collab/src/transport.rs` lines 113-121 ("the call returns when the bytes are **queued for send**, not when the remote has received them").

The contract is explicit: `send` returns `Ok(())` once bytes are in the outbound mpsc. Loss is the transport's concern. But:

1. Caller invokes `session.append_op(op)` under `OnAppend`. `flush_delta_to_transport` succeeds: bytes are queued in `outbound_tx`; `last_flushed_vv = Some(current_vv)` is set; `Ok(true)` returns.
2. Caller drops the session (or detaches and drops the transport handle).
3. `WebSocketTransport::drop` runs: stores `closed = true`, then `writer_task.abort()`. Per the M2 closure comment at lines 372-381, `abort()` runs *before* `outbound_tx` drops in field-decl order, so the writer task is killed mid-`outbound_rx.recv()` BEFORE it has a chance to drain queued bytes. **Any bytes between the last `ws_sink.send` and the abort are lost.**
4. `has_pending_flush()` returns `false` (last_flushed_vv was advanced in step 1).
5. The peer never receives those ops. On reconnect via a fresh `WebSocketTransport`, the V2 V3 step 1 contract resets `last_flushed_vv = None` and re-sends from empty VV → ops are recovered. **So this is only fatal if the caller never reconnects** (e.g., tab close, app shutdown, single-session export workflow).

The offline-write doc story claims "Loro's CRDT op log IS the offline queue" — TRUE for appends made while no transport is attached, but FALSE for appends made AFTER a successful `flush_delta_to_transport` whose bytes were queued but not yet on the wire. The VV-advance in step 1 (`self.last_flushed_vv = Some(current_vv)`) is optimistic: it assumes queue → wire. The actual on-wire confirmation is several mpsc + ws_sink + TCP steps away.

The mismatch is between two contracts:
- `Transport::send` docstring: "queued, not delivered."
- `flush_delta_to_transport` docstring (line 940-945): "Advance the VV checkpoint. Only on success."

Both are individually correct, but the system-level invariant a caller would assume ("`has_pending_flush() == false` means the peer has my ops, OR I can re-attach to get them") does NOT hold across drop.

**Two minimal fixes:**
1. **Drop-side flush attempt** — before aborting, give the writer task a bounded grace (e.g., `tokio::time::timeout(100ms, writer_task)` — but Drop is sync). Awkward in Drop; would need an async `close()` API.
2. **Document the gap** — module-doc and `flush_delta_to_transport` doc should say: "Successful flush means bytes queued at the transport; in-flight bytes are lost on transport drop. For shutdown safety, callers should await a deliberate quiescence signal before drop (V2 V4 deferred)."

V2 V4 reconnect work already accepts this gap implicitly (full delta-from-empty-VV resend recovers everything Loro knows about). But the no-reconnect case (tab close mid-flush) is silently lossy and should be either pinned in a test as ACCEPTED behavior or addressed.

**Recommendation**: documentation closure this cycle; explicit shutdown API deferred to V2 V4.

### M2 — Reader task panic leaves transport in `closed = false` with no tasks running; caller polls forever

File: `crates/ql-collab-ws/src/lib.rs` lines 285-320.

Tokio's default panic policy: a panicking task aborts the task; the runtime continues. The closed flag is set only in the `Err` arm (line 313) and after stream-end (line 319). A panic in the reader task body — e.g., `bytes.to_vec()` in low-memory conditions, or a future trait-method addition with an unwrap — bypasses both flag-set paths.

Net effect:
- `writer_task.is_finished() = false` (writer is parked on `recv()`, alive).
- `reader_task.is_finished() = true` (panicked → finished from `JoinHandle::is_finished` perspective).
- `closed = false`.
- Caller polling `try_recv` → mpsc receiver still open, returns `TryRecvError::Empty` → `Ok(None)` forever.

The `Debug` impl at lines 203-210 surfaces `reader_finished = true` so a debug-print would notice. But `is_closed()` returns `false`, `last_error()` returns `None`, and there is no observable signal that the transport is broken.

Same shape applies to the writer task panic, but writer-panic is more directly recoverable: the next `send` call panicked-task's mpsc receiver is dropped → `outbound_tx.send` returns `Err` → mapped to `Closed`. So writer-panic at least surfaces on the next send. Reader-panic doesn't surface at all if the caller is only reading.

**Two minimal fixes:**
1. Wrap the spawn body in a closure that on any exit path (Err, panic-via-`catch_unwind`, or stream-end) sets `closed = true`. Idiomatic: spawn a small helper that defers a `closed.store(true)` via a sentinel struct's `Drop`. Catches panic-unwinding via the inner type's drop.
2. Periodically `is_finished()` the reader task from `try_recv` and set `closed` if so. Cheap (single `JoinHandle` check per poll).

Both would close the gap. Fix #1 is the more idiomatic and panic-safe.

**Recommendation**: implement fix #1 next cycle; flag in V2 V4 backlog if deferred.

### M3 — Poisoned `last_error` mutex silently returns `None` — violates CLAUDE.md no-fallback rule

File: `crates/ql-collab-ws/src/lib.rs` lines 354-356.

```rust
pub fn last_error(&self) -> Option<WebSocketError> {
    self.last_error.lock().ok().and_then(|guard| guard.clone())
}
```

The `.lock().ok()` swallows `PoisonError`. A poisoned mutex means a panicked task held the lock — which is itself an error condition the caller should know about. The accessor returns `None` (== "no error observed") in a state that actually means "the task that was tracking errors panicked." Indistinguishable from a clean transport at the API surface.

Per CLAUDE.md no-fallback: "No try/catch that swallows errors or returns a default value. No `value || default` patterns." `.lock().ok().and_then(...)` is exactly that pattern.

The same shape exists in both writer and reader tasks at lines 266 and 310: `if let Ok(mut slot) = last_error_writer.lock() { ... }`. A poisoned mutex on the producer side means the error is silently dropped. Likelier than the reader side because the writer task is the one that's more likely to panic (allocator for `bytes.into()`).

**Fix:** Either
1. Use `parking_lot::Mutex` (no poison concept) — adds dep but cleanly eliminates the issue.
2. Panic on poison via `.lock().unwrap()` — exposes the issue loudly.
3. Surface poison as a sentinel variant: `WebSocketError::TaskPanic` stashed elsewhere (e.g., a separate `AtomicBool poisoned` flag set on poison).

Per CLAUDE.md, option 2 is most aligned with the project's posture ("errors must be visible"). Option 1 is operationally cleanest.

**Recommendation**: closure in this cycle if cheap (single-line change to `.unwrap()` + a comment). Otherwise document and defer.

### M4 — Reader task drops the close-frame reason; auth-rejection signal is lost

File: `crates/ql-collab-ws/src/lib.rs` lines 295-299.

```rust
Ok(Message::Close(_)) => {
    // Graceful peer close — leave last_error None.
    closed_reader.store(true, Ordering::Relaxed);
    return;
}
```

The `Message::Close(_)` arm discards the `Option<CloseFrame>`. RFC 6455 defines close codes (1000 = normal, 1008 = policy violation, 1011 = server error) and a UTF-8 reason string. Servers use these to signal application-level issues — most importantly, a **future auth-rejection path** ("session expired, please reauthenticate") delivered as a close frame with a specific code/reason rather than a TCP reset.

The M1 step 4 audit closure added `RuntimeError(String)` for non-graceful exits but left graceful close opaque. So:
- Peer kicks us with `Close(CloseFrame { code: 1008, reason: "auth rejected" })`: `last_error = None`, `is_closed = true`.
- Peer TCP-resets us: `last_error = Some(RuntimeError(io-error))`, `is_closed = true`.

The IDE consumer driving reconnect must distinguish these. Currently it can't.

**Fix:** Either
1. Add a `GracefulClose { code: u16, reason: String }` variant to `WebSocketError` and populate on the Close arm.
2. Don't discriminate by graceful/non-graceful — store ALL close information in `last_error`, with a new variant for the graceful case.

V2 V3 step 4 audit closure said the Close-frame-reason concern was "deferred to V2 V4 reconnect work where the consumer of the cause exists." That's defensible, but worth flagging again here as a pinned item for the V2 V4 backlog — the reconnect work will need this signal.

**Recommendation**: defer with explicit V2 V4 backlog item (not just an audit-closure paragraph).

### M5 — `EchoServer::Drop` race: accept-task push to `conn_tasks` is unsynchronized with Drop's abort+drain

File: `crates/ql-collab-ws/tests/common/mod.rs` lines 46-65 (accept loop) and 73-86 (Drop).

The accept loop:
```rust
let handle = tokio::spawn(handle_echo_connection(stream));
if let Ok(mut tasks) = conn_tasks_in_accept.lock() {
    tasks.push(handle);
}
```

Drop:
```rust
self.accept_task.abort();
if let Ok(mut tasks) = self.conn_tasks.lock() {
    for h in tasks.drain(..) { h.abort(); }
}
```

The race window: the accept loop has spawned a per-conn task but NOT yet acquired the `conn_tasks` mutex (e.g., spawned at line 51, about to call `lock()` at line 52). `accept_task.abort()` schedules cancellation at the next await point. The accept task happens to be between spawn (sync) and lock (sync) — cancellation doesn't fire mid-sync-code; it fires at the next `.await`. The next await is the loop iteration's `listener.accept().await`. So the per-conn task IS pushed to `conn_tasks` before the accept task is cancelled.

So this PARTICULAR race is benign in the current code because lock() is sync and there's no await between spawn and push.

BUT: a future refactor that swaps `std::sync::Mutex<Vec>` for `tokio::sync::Mutex<Vec>` (idiomatic in async code) would introduce an await between spawn and push, opening a genuine race window where a per-conn task could land in conn_tasks AFTER drain, escaping the abort. Lifetime past test-end = leaked tokio task = test runtime hang on drop.

Even with `std::sync::Mutex`, on a busy multi-threaded runtime, the abort() of the accept task could in theory race with the lock acquisition (abort sets a cancellation flag; the cancellation lands at the next await; if the lock is contended, the task yields under the hood... actually no, std::sync::Mutex doesn't yield, it spins/blocks. So in practice this is safe.).

The defensive concern is documentation: a future maintainer migrating to async Mutex would silently introduce a leak.

**Recommendation**: add a comment at the accept-loop site explicitly noting that `std::sync::Mutex` is load-bearing for the Drop race-freedom, and a future migration to tokio::sync::Mutex requires a synchronization barrier (e.g., a oneshot to signal the accept loop has reached steady state).

### M6 — Symmetric `OnAppend` bandwidth amplification undocumented; round-trip duplicate per op

File: `crates/ql-collab/src/session.rs` lines 1262-1337 (test `symmetric_on_append_two_peers_converge_with_bounded_wire_bytes`).

V2 V3 step 1+2 closure docs claim "duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)`." This is TRUE for the receiver of a duplicate. But:

Trace A↔B both OnAppend:
1. A.append(op_a) → A's `current_vv` advances → flush sends op_a to B's inbox. `A.last_flushed_vv = A.current_vv`.
2. B.poll_remote drains op_a → `B.log.merge_bytes` advances `B.current_vv` (B now has its own pre-state + op_a, so VV genuinely changed).
3. B's `maybe_auto_flush` fires: `current_vv != last_flushed_vv` (B's last_flushed_vv was at B's pre-poll state). Idempotency guard does NOT short-circuit. B sends delta to A's inbox — the delta includes op_a (since op_a is in `B.current_vv` but not in `B.last_flushed_vv`).
4. A.poll_remote drains B's blob → `A.log.merge_bytes(blob)` — Loro dedupes op_a (already known). `A.current_vv` does NOT advance.
5. A's `maybe_auto_flush` fires: `A.current_vv == A.last_flushed_vv` → idempotency short-circuits. No send.

So step 3 sends op_a BACK to A unnecessarily. Loro dedupes on import (step 4). One round-trip duplicate per op. The "no echo loop" claim is technically true — the loop terminates at step 5 — but every op pays a 2× wire-bandwidth tax in symmetric topologies.

The V2 V3 step 1 audit closure documented this in passing ("the original V2 V2 echo-loop concern is closed at the source") but did NOT pin the bandwidth-amplification fact. For a steady-state two-peer session with 1 op/sec, this is ~2× upload at each peer. For a 10-peer mesh, it's much worse (each peer auto-flushes the merged state onward to all attached transports — and step 1's `last_flushed_vv` is per-session, not per-transport, so on multi-transport sessions the amplification compounds).

V1 limit at line 256-262 acknowledges multi-transport fanout as deferred. But the 2-peer 2× amplification is V1-shipping behavior and isn't called out.

**Recommendation**: document the 2× duplicate-resend behavior in `AutoFlushPolicy::OnAppend` docstring as a known V1 cost; flag the multi-transport per-transport-VV refactor as the proper fix in V2 V4 backlog.

---

## LOW

### L1 — Reader task's `inbound_tx.send(bytes.to_vec()).is_err()` returns silently without setting `closed`

File: `crates/ql-collab-ws/src/lib.rs` lines 288-294.

```rust
Ok(Message::Binary(bytes)) => {
    if inbound_tx.send(bytes.to_vec()).is_err() {
        return;
    }
}
```

If `inbound_tx.send` returns `Err`, the receiver was dropped — which means `WebSocketTransport` was dropped (the receiver is `self.inbound_rx`). Returning is correct (no point continuing). But `closed` is not stored. This is consistent with the comment ("WebSocketTransport dropped — exit cleanly") because if the transport is dropped, nobody can observe `closed` anyway. Defensive cosmetic only.

Recommendation: add `closed_reader.store(true, Ordering::Relaxed)` before return for state-machine symmetry — every exit path from the reader task sets closed. Costs nothing.

### L2 — `Debug` for `WebSocketTransport` doesn't surface `last_error`

File: `crates/ql-collab-ws/src/lib.rs` lines 203-210.

The Debug impl shows `closed`, `writer_finished`, `reader_finished` but not `last_error.is_some()`. For diagnostics in a transport that's reported `closed = true` and `*_finished = true`, knowing whether `last_error` has a value matters more than knowing the booleans. Cheap addition.

### L3 — Empty binary frame `Message::Binary(b"")` is forwarded to `CollabSession::merge_bytes`; Loro behavior unverified

File: `crates/ql-collab-ws/src/lib.rs` line 288-293; downstream `ql-collab/src/session.rs::merge_bytes`.

A misbehaving peer sending a 0-byte binary frame: reader pushes empty vec to inbound_tx. `CollabSession::merge_bytes(&[])` → `OpLog::merge_bytes(&[])` → `LoroDoc::import(&[])`. Loro's behavior on empty input is not pinned by any test in scope. Likely Ok (no-op) but failure mode is unverified — if `LoroDoc::import` panics on empty input under some future Loro version, it propagates up to `poll_remote` and via `?` to the caller as a `CollabSessionError::OpLog`.

Recommendation: add a unit test against `OpLog::merge_bytes(&[])` pinning the Loro contract. Cheap.

### L4 — `Send` assert is one-shot; no asserts for `WebSocketError: Clone + Send + Sync` even though `last_error()` clones across thread boundary

File: `crates/ql-collab-ws/src/lib.rs` lines 443-446.

The Send assert covers `WebSocketTransport`. The `WebSocketError` type derives `Clone, Error`. It's `Send + Sync` only because all its fields are `String` — not pinned. If a future refactor adds an `Arc<dyn FnOnce>` or similar to `RuntimeError`, the type silently becomes `!Send` and `last_error()` (which returns `Option<WebSocketError>`) still compiles. Future cross-thread `last_error()` consumers would discover the regression downstream.

Recommendation: add `assert_send_sync::<WebSocketError>()` to the existing assert block. One line.

---

## Confirmed safe

- **No deadlock paths**: `last_error: Mutex<Option<_>>` is never held across an await, never nested, and lock duration is O(1).
- **Borrow-checker isolation of single-threaded session method calls**: `CollabSession` is `!Sync` (only `transport: Box<dyn Transport + Send>` and other field types are individually `Sync`-relevant, but `LoroDoc` ownership makes session `!Sync` — confirmed implicitly by the `_ASSERT_COLLAB_SESSION_SEND` const checking only `Send`). No `&self` accessors mutate state. The race window the audit prompt § 2 worried about (a background thread calls `is_closed()` while main holds `&mut self` for `send`) requires aliasing `&` and `&mut` which Rust forbids at the type system level.
- **`AtomicBool` `Relaxed` ordering for `closed`**: writes from background tasks become visible to the caller's polling on the same thread (test pattern) via tokio's runtime scheduling barriers; for cross-thread, the V2 V1 audit closure already established `Relaxed` is OK because the surrounding session methods take `&mut self` which orders accesses.
- **EchoServer per-conn task abort kills TCP socket**: per-conn task owns the WS stream which owns the TCP stream; abort drops the task → drops the stream → kernel sends FIN/RST. Reader-side observes EOF/Err and sets `closed = true`. Verified by `server_close_propagates_to_try_recv_as_closed` test.
- **Drop ordering of `WebSocketTransport`**: Drop body sets `closed = true` before `writer_task.abort()` / `reader_task.abort()`. Concurrent observers see `closed` change first. Then field drops happen in decl order (outbound_tx, inbound_rx, closed Arc, last_error Arc, writer_task, reader_task). All Arcs are reference-counted; tasks holding their clones release them as the abort cancels them. No leak.
- **`flush_delta_to_transport` borrow-checker dance** (session.rs lines 936-940) — `self.log` immut access for VV/bytes then `self.transport` mut access for send. Two-phase borrow is correct; no aliasing issue.
- **`poll_remote_with_limit` `Ok(0)` no-flush short-circuit** (session.rs line 1054) — defensive optimization. Even without it the VV-compare in `flush_delta_to_transport` would short-circuit, so behavior is identical. Doc comment justifies it.
- **`set_auto_flush_policy` doesn't auto-flush on policy change** — confirmed not a bug: switching from Disabled to OnAppend with pending unflushed ops leaves them pending. Doc explicitly says "set_auto_flush_policy is orthogonal to attach_transport"; same applies to has_pending_flush. Callers wanting immediate sync invoke `flush_delta_to_transport` explicitly.
