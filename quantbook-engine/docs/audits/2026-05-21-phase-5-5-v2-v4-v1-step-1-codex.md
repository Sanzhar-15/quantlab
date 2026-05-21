---
title: Phase 5.5 V2 V4 V1 step 1 audit - Codex
date: 2026-05-21
audit_target: HEAD `3342e21b964`
predecessor: `8a8236840f2`
auditor: Codex
verdict: PASS-WITH-FINDINGS
scope: Tier K1 ack channel, `Transport::flush_pending`
---

# Phase 5.5 V2 V4 V1 step 1 audit - Codex

## VERDICT: PASS-WITH-FINDINGS

No HIGH findings. The core counter/condvar drain path is sound for the intended level-1 local writer acknowledgement: `send()` increments `queued_count` only after a successful mpsc enqueue, the writer increments `progress.0` only after `ws_sink.send(...).await` returns `Ok`, and `flush_pending()` uses the standard mutex + condvar loop with a timeout so spurious wakes and missed close notifications do not hang forever.

The main issue is a public contract mismatch: the trait and impl docs say `flush_pending` returns `Closed` if the transport is already closed, but the implementation can return `Ok(())` on a closed transport once the progress counter has caught up. The new test also has a closed-state name/comment but explicitly accepts either `Ok` or `Closed`, so the shipped behavior is not pinned to the documented fast-path.

No cargo tests were run, per instruction.

## HIGH

None.

## MEDIUM

### M1 - `flush_pending` does not enforce the documented closed-on-entry error

Evidence:

`Transport::flush_pending` documents a closed-on-entry error:

```rust
// crates/ql-collab/src/transport.rs:204
/// # Errors
///
/// - `Err(TransportError::Closed)` if the transport is closed
///   (either before `flush_pending` was called OR during the wait
```

The `WebSocketTransport` override repeats the same contract:

```rust
// crates/ql-collab-ws/src/lib.rs:666
/// # Errors
/// - `TransportError::Closed` if the transport was already closed
///   on entry, OR if the writer task sets closed mid-wait
```

But the implementation only checks `closed` inside the `while *counter < target` loop:

```rust
// crates/ql-collab-ws/src/lib.rs:678
fn flush_pending(&mut self) -> Result<(), TransportError> {
    let target = self.queued_count.load(Ordering::SeqCst);
    let (counter_lock, cv) = &*self.progress;
    let mut counter = counter_lock
        .lock()
        .map_err(|e| TransportError::Io(format!("flush_pending lock poisoned: {e}")))?;
    while *counter < target {
        if self.closed.load(Ordering::Relaxed) {
            return Err(TransportError::Closed);
        }
        let (new_counter, _timeout_result) = cv
            .wait_timeout(counter, Duration::from_millis(100))
            .map_err(|e| TransportError::Io(format!("flush_pending wait poisoned: {e}")))?;
        counter = new_counter;
    }
    Ok(())
}
```

So a closed transport with no pending blobs, or a closed transport whose writer already caught up, returns `Ok(())`. The new closed-state test name and header say it pins `Err(Closed)`:

```rust
// crates/ql-collab-ws/tests/websocket_transport.rs:735
fn flush_pending_after_close_returns_closed() {
    // ... If the transport is already closed on entry, flush_pending returns
    // Err(Closed) without blocking.
```

But the assertion accepts both outcomes:

```rust
// crates/ql-collab-ws/tests/websocket_transport.rs:756
// After explicit close, flush_pending may either:
//   (a) return Err(Closed) immediately ...
//   (b) return Ok if the writer task happened to drain both sends ...
// Both are valid per the contract.
match result {
    Ok(()) | Err(TransportError::Closed) => {}
    other => panic!("expected Ok or Err(Closed), got {other:?}"),
}
```

Impact: callers cannot rely on the documented reconnect/error branch after `flush_pending` if the transport closed before the call but the local progress counter is already at target. That may be acceptable if the desired contract is "Ok means all previously queued frames reached the sink even if the transport is now closed," but it is not the contract currently documented at the trait, session proxy, and impl levels.

Suggested closure: choose one contract and pin it. If closed-on-entry must be an error, add a `closed` check before the counter loop and update the test to require `Err(Closed)`. If drained-then-closed `Ok(())` is intentional, rewrite the trait/session/impl docs and the test name/comment to say closed only errors while there is still unflushed queued work.

## LOW

### L1 - Not all closed-flag transitions notify the condvar despite comments saying they do

Evidence:

The progress field docs say the condvar is notified on each closed transition:

```rust
// crates/ql-collab-ws/src/lib.rs:280
/// `(counter, condvar)` pair. Counter is incremented by the writer
/// task AFTER each successful `ws_sink.send`. Condvar is notified
/// on each counter increment AND on `closed`-flag transition
```

The connect-site comments and `flush_pending` docs say the same:

```rust
// crates/ql-collab-ws/src/lib.rs:351
// `progress.1` (Condvar) is notified after
// each progress increment AND on closed-flag transitions

// crates/ql-collab-ws/src/lib.rs:659
/// The writer task increments `progress.0` + `notify_all` after
/// each successful `ws_sink.send`, AND `notify_all` on closed-
/// flag transitions.
```

Only some transitions notify: writer send error, `close()`, and `Drop`. Reader-side transitions set `closed` without notifying:

```rust
// crates/ql-collab-ws/src/lib.rs:457
closed_reader.store(true, Ordering::Relaxed);

// crates/ql-collab-ws/src/lib.rs:472
closed_reader.store(true, Ordering::Relaxed);

// crates/ql-collab-ws/src/lib.rs:487
closed_reader.store(true, Ordering::Relaxed);
```

The panic guard also sets `closed` without notifying:

```rust
// crates/ql-collab-ws/src/lib.rs:154
self.closed.store(true, Ordering::Relaxed);
```

This is not a correctness hang because `flush_pending` uses a 100 ms `wait_timeout` and checks `closed` on each loop. It is still documentation drift, and it makes the wake-up latency dependent on the timeout for reader-observed disconnects and task panics. The test comment for `flush_pending_returns_closed_if_server_drops_mid_flush` also says the reader notifies the condvar, but the reader does not own `progress`.

Suggested closure: either pass `progress` to the reader task and `TaskExitGuard` so every closed transition really notifies, or soften the docs to "notified on writer failure / explicit close / drop; other close paths are observed on the timeout tick."

### L2 - Prior queued-vs-acked docstrings still point to a future V2 V4 ack API

Evidence:

The `Transport::send` docstring still says V2 V4 will add the explicit ack API:

```rust
// crates/ql-collab/src/transport.rs:127
/// If you need stronger delivery guarantees, the V2 V3 V1 substrate
/// recommends: (1) keep the transport attached until you've
/// verified peer reception out-of-band ...
/// ... V2 V4 will
/// add an explicit ack-channel API for true end-to-end delivery
/// confirmation.
```

`CollabSession::flush_delta_to_transport` has the same stale forward pointer:

```rust
// crates/ql-collab/src/session.rs:1026
/// For IDE consumers building "safe to close window?" workflows,
/// the `has_pending_flush() == false` signal is insufficient on
/// its own - combine with a peer-side ack or wait-for-quiescence
/// strategy. V2 V4 will add an explicit ack-channel API for true
/// end-to-end delivery confirmation (V2 V4 backlog Tier K1).
```

There is also an internal `flush_to_transport` comment that overstates the post-`send` state:

```rust
// crates/ql-collab/src/session.rs:948
// `last_flushed_vv` to current. The peer now has everything
// up to this VV; subsequent `flush_delta_to_transport` calls
```

Impact: the new API exists, but two public docs still tell readers it is future work, and one nearby implementation comment says the peer has the bytes immediately after trait-level `send`. This is exactly the stale surface the step intended to close.

Suggested closure: update these docs to point at `Transport::flush_pending` / `CollabSession::flush_pending_to_transport` as the V2 V4 V1 level-1 closure, while preserving the distinction that TCP ack and peer-application ack still require lower-layer hooks or protocol changes.

### L3 - "Bytes hit the wire" is slightly stronger wording than `ws_sink.send().await` can prove

Evidence:

The new docs consistently call the result a level-1 ack and define it as success from `ws_sink.send`, which is the right implementation boundary:

```rust
// crates/ql-collab/src/transport.rs:197
/// `flush_pending`
/// lets callers block until the local writer has caught up,
/// providing a level-1 ack (bytes hit `ws_sink.send`
/// successfully).
```

Some consumer docs then shorten that to "bytes hit the wire":

```md
// docs/PHASE-4-V2-BACKLOG.md:571
then `has_pending_flush() == false` truly means bytes hit the wire
(within current process; TCP reliability handles wire->peer transit).
```

`SinkExt::send` success is best described as "the WebSocket sink accepted/flushed the frame to the underlying async writer." It is not TCP acknowledgement and not peer receipt, as the docs already correctly state elsewhere. The "wire" shorthand is understandable, but it invites over-reading in IDE UX copy like "all offline edits are now synced."

Suggested closure: use the precise phrase "writer task completed `ws_sink.send` for all queued blobs" or "submitted/flushed to the WebSocket sink" in public docs. Keep "not TCP-ack, not peer-application-ack" prominent.

## CONFIRMED CORRECT / NO FINDING

- The condvar wait pattern itself is standard: the mutex is held for the predicate check, `wait_timeout` releases it while sleeping and re-acquires on wake, and the loop handles spurious wakeups.
- The monotonic counter contract holds after each public `send()` returns: `queued_count` only increments after successful mpsc enqueue, and `progress.0` only increments after successful writer-side `ws_sink.send`. There is a harmless transient where the writer can increment progress before `send()` performs the atomic increment, because enqueue precedes `fetch_add`; no public `flush_pending(&mut self)` call can observe that between the two statements on the same caller-owned transport.
- Capturing `target` once is correct for the current `&mut self` API. Concurrent sends cannot race with a `flush_pending` call through safe Rust.
- Poisoning behavior is conservative but defensible. `last_error` recovers from poison because it is best-effort diagnostics; `flush_pending` surfaces poison as `TransportError::Io`, which is safer for a progress predicate that might otherwise be trusted after a panic.
- The async-context caveat is reachable at all important public surfaces: trait doc, session proxy doc, and the new `multi_thread_runtime()` test helper. The tests correctly avoid blocking a single-thread runtime worker.
- `Drop` notifying the condvar is currently unreachable with concurrent `flush_pending` because both require exclusive access by safe Rust, but it is harmless and documents the intended behavior for any future shared-reference API.
- The six new tests cover the main happy path, proxy path, no-transport default path, and bounded error/close waits. They do not cover mutex poisoning, which is reasonable without panic injection.
