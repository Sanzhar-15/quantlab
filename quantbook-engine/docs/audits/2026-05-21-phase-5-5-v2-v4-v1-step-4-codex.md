---
title: Phase 5.5 V2 V4 V1 step 4 audit - Codex
date: 2026-05-21
audit_target: HEAD `1924d3ed1e1`
predecessor: `35dc6dcabbd`
auditor: Codex
verdict: PASS-WITH-FINDINGS
scope: Small Tier K bundle: K2, K3, K6, K7, K8
---

# Phase 5.5 V2 V4 V1 step 4 audit - Codex

## VERDICT: PASS-WITH-FINDINGS

No HIGH findings. K2, K6, K7, and the backlog closure entries are broadly correct, and K8 correctly documents the early-Err skip path. The main issue is K3: the new EchoServer comment overstates the race-freedom provided by `std::sync::Mutex`. The accept loop has no `.await` between spawning a per-connection task and pushing its handle, but `Drop` can still drain the vector before that push on a multi-thread runtime.

No cargo tests were run, per instruction. The supplied gate is 4453 / 0 with `--test-threads=1`, plus clean fmt and clippy.

## HIGH

None.

## MEDIUM

### M1 - K3 comment claims Drop race-freedom that the current ordering does not guarantee

Evidence:

```rust
// crates/ql-collab-ws/tests/common/mod.rs:64
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
```

```rust
// crates/ql-collab-ws/tests/common/mod.rs:96
self.accept_task.abort();
if let Ok(mut tasks) = self.conn_tasks.lock() {
    for h in tasks.drain(..) {
        h.abort();
    }
}
```

The new comment says the sync `spawn -> lock -> push` sequence means a spawned per-conn handle is "ALWAYS in `conn_tasks` before the next await point, and Drop's drain catches it." The first half is true in the Tokio-cancellation sense: `accept_task.abort()` will not cancel the accept task in the middle of synchronous code.

That does not imply Drop's drain catches the handle. On a multi-thread runtime, normal thread interleaving can be:

1. Accept task returns from `listener.accept().await`.
2. Accept task calls `tokio::spawn(handle_echo_connection(stream))` and obtains a `JoinHandle`.
3. Before `conn_tasks_in_accept.lock()`/`push`, another thread runs `EchoServer::drop`.
4. Drop calls `accept_task.abort()`, then locks and drains `conn_tasks` before the new handle is present.
5. The accept task resumes. Cancellation still cannot land until the next `.await`, so it locks and pushes the handle after Drop's drain has already completed.

Dropping a `JoinHandle` would detach the task, and this path leaves a per-connection task alive past the server's Drop path. The existing sync mutex reduces the race compared to an async mutex, but it is not a complete Drop race-freedom proof. The comment is therefore load-bearing but currently inaccurate, and K3 is not fully closed as written.

Suggested closure: put a small shared state under the same mutex, e.g. `{ closing: bool, tasks: Vec<JoinHandle<()>> }`. Drop should set `closing = true` while holding the lock, abort/drain existing tasks, and release. The accept loop should lock after spawn and either push the handle when `closing == false` or immediately `handle.abort()` when `closing == true`. That closes both interleavings, including a future `tokio::sync::Mutex` migration if paired with an explicit quiescence barrier.

## LOW

### L1 - K2 test proves reattach recovery, not actual mid-drop byte loss

Evidence:

```rust
// crates/ql-collab-ws/tests/websocket_transport.rs:1013
session.append_op(add_sheet()).expect("add_sheet");
session.append_op(put_value(0, 0, 0, 1.0)).expect("put");
session.append_op(put_value(0, 0, 1, 2.0)).expect("put");

let _dropped_ws1 = session.detach_transport();
drop(_dropped_ws1);

// ...
session.attach_transport(ws2);
assert!(session.has_pending_flush());
assert!(session.pending_op_count() >= 3);
session.flush_delta_to_transport().expect("flush #2 success");
session.flush_pending_to_transport().expect("flush_pending #2 success");
```

The recovery flow is correct: detach/drop resets the baseline, reattach resets it again, `pending_op_count()` includes all three local ops, and the explicit flush to WS#2 redelivers from empty VV. This pins the intended "drop without flush_pending is recoverable by reattach + baseline reset" contract.

It does not deterministically exercise bytes actually being lost on WS#1. The writer task may have drained and sent all three blobs before `drop(_dropped_ws1)`. A future `WebSocketTransport::Drop` implementation that gracefully drained before aborting would still pass this test. That is acceptable if K2's intended contract is recovery, but the test name, comments, and backlog line overclaim when they say it exercises drop-loss itself.

Suggested closure: either soften the wording to "drop-without-flush-pending recovery" or use a controllable/stalling transport fixture if the desired contract is "bytes were actually queued but not written before Drop."

### L2 - K8 docstring omits the max-blobs cap exit, where auto-flush also fires

Evidence:

```rust
// crates/ql-collab/src/session.rs:1239
/// the precise rule is "after a
/// non-empty drain that reaches the loop's normal exit (Ok(None)
/// or Closed-as-EOF break)."
```

```rust
// crates/ql-collab/src/session.rs:1273
while merged < max_blobs {
    match transport.try_recv() {
        Ok(Some(bytes)) => {
            self.log.merge_bytes(&bytes)?;
            merged += 1;
        }
        Ok(None) => break,
        Err(TransportError::Closed) => break,
        Err(other) => return Err(CollabSessionError::Transport(other)),
    }
}
if merged > 0 {
    self.maybe_auto_flush()?;
}
```

The implementation auto-flushes after any non-empty, non-error exit from the loop. That includes the bounded-drain path where `merged == max_blobs` and the `while merged < max_blobs` condition ends the loop without an `Ok(None)` or Closed break.

Impact is documentation only, but K8 was specifically a doc-precision closure. The precise public rule should be: "after a non-empty drain that exits without error, whether by reaching `max_blobs`, `Ok(None)`, or Closed-as-EOF." The same paragraph also mentions non-Closed `Other`, but the current `TransportError` variants are only `Io(String)` and `Closed`; if "future non-Closed variants" is intended, that should be said explicitly.

## CONFIRMED CORRECT / NO FINDING

- K6 is safe. `Debug for WebSocketTransport` now includes `last_error_present`, and the call goes through `last_error()`, which recovers from a poisoned mutex via `PoisonError::into_inner()` rather than panicking or silently returning `None`.
- K7 is meaningful coverage. `merge_bytes_with_empty_slice_does_not_panic` pins that empty input either returns a Loro error with unchanged visible log length or becomes an accepted no-op with unchanged returned length. A panic or unexpected `OpLogError` variant fails the test.
- K8's early-Err discussion matches the code for decode and transport errors: successful earlier merges remain committed, `maybe_auto_flush()` is skipped by `?`/early return, `last_flushed_vv` remains unchanged, and a later flush path will send the accumulated delta.
- The backlog entries for K2, K3, K6, K7, and K8 point to the shipped artifacts and the +2 test-count explanation is consistent with one new WS integration test and one new ql-oplog unit test.

## TEST COVERAGE

Not run for this audit, per instruction.

Supplied workspace gate: 4453 / 0 with `--test-threads=1`; fmt and clippy clean.
