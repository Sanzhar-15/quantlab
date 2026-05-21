---
title: Phase 5.5 V2 V3 step 5 megaudit - Codex lane (protocol & correctness)
date: 2026-05-21
audit_target: HEAD `0addbb2efd0` (cumulative V2 V3 steps 1-4)
auditor: Codex
verdict: PASS-WITH-FINDINGS
lane: protocol & correctness
---

# Phase 5.5 V2 V3 step 5 megaudit - Codex lane

## VERDICT: PASS-WITH-FINDINGS

No HIGH findings. The core Loro VersionVector arithmetic is sound: the checkpoint is reset on transport lifecycle, advances only after synchronous `Transport::send` success, and remains unchanged on direct export/send errors. Attach/detach reset semantics make offline-write recovery correct, and the normal successful `poll_remote` path now flushes the merged union exactly once.

The main cumulative protocol issue is at the boundary introduced by step 4: `WebSocketTransport::send` returns success when bytes are accepted into the local mpsc queue, but the actual socket write happens later in the writer task. `CollabSession` advances `last_flushed_vv` immediately after trait-level success, so a later writer-task failure can leave the session reporting "no pending flush" even though the frame was never put on the WebSocket. This is not Loro corruption and reconnect via `attach_transport` still recovers by resetting the baseline, but it weakens the `has_pending_flush` / idempotency contract for the production transport.

## HIGH

None.

## MEDIUM

### M1 - WebSocket queued-send success can advance `last_flushed_vv` before bytes reach the socket

Evidence:

`Transport::send` explicitly permits buffered implementations:

```rust
// quantbook-engine/crates/ql-collab/src/transport.rs:113
/// Push `bytes` to the channel. Implementations may buffer
/// internally; the call returns when the bytes are
/// **queued for send**, not when the remote has received them.
```

`WebSocketTransport::send` satisfies that trait by enqueueing to `outbound_tx`:

```rust
// quantbook-engine/crates/ql-collab-ws/src/lib.rs:403
if self.closed.load(Ordering::Relaxed) {
    return Err(TransportError::Closed);
}
self.outbound_tx
    .send(bytes.to_vec())
    .map_err(|_| TransportError::Closed)
```

The real WebSocket write happens later in the background writer task, where failure is only recorded after the caller has already received `Ok(())`:

```rust
// quantbook-engine/crates/ql-collab-ws/src/lib.rs:261
while let Some(bytes) = outbound_rx.recv().await {
    if let Err(e) = ws_sink.send(Message::Binary(bytes.into())).await {
        if let Ok(mut slot) = last_error_writer.lock() {
            *slot = Some(WebSocketError::RuntimeError(e.to_string()));
        }
        closed_writer.store(true, Ordering::Relaxed);
        return;
    }
}
```

`CollabSession::flush_delta_to_transport` advances the checkpoint immediately after trait-level `send` succeeds:

```rust
// quantbook-engine/crates/ql-collab/src/session.rs:939
let transport = self.transport.as_mut().expect("just-checked is_some above");
transport.send(&bytes)?;
self.last_flushed_vv = Some(current_vv);
Ok(true)
```

That creates this cumulative sequence:

1. `append_op(X)` commits locally.
2. `flush_delta_to_transport` exports X and `WebSocketTransport::send` enqueues it successfully.
3. `last_flushed_vv = vv(X)`.
4. Writer task later fails before/while sending the WebSocket frame and sets `closed = true`.
5. `has_pending_flush()` compares equal VVs and returns false.
6. A manual `flush_delta_to_transport()` retry also returns `Ok(false)` before touching the now-closed transport:

```rust
// quantbook-engine/crates/ql-collab/src/session.rs:924
if let Some(last_vv) = self.last_flushed_vv.as_ref() {
    if last_vv == &current_vv {
        return Ok(false);
    }
}
```

This is not a problem for `LoopbackTransport`, where success means the peer inbox has the bytes. It is specific to async transports that acknowledge local queue acceptance before the backing I/O write. The recovery story still works if the caller observes closure and reattaches, because `attach_transport` resets `last_flushed_vv = None` and the next flush sends all ops. The problematic window is the false "synced" state before that reset, especially for IDE status and "safe to close" decisions.

Suggested closure direction: either narrow the documented semantics to "queued to the currently attached transport" and avoid treating `has_pending_flush == false` as remote delivery, or add an acknowledgement/flush-completion boundary for async transports before advancing `last_flushed_vv`. A smaller mitigation is to ensure callers can observe the attached transport's `Closed`/`last_error` state through `CollabSession` and reset the baseline on reconnect.

## LOW

### L1 - `poll_remote_with_limit` can advance `current_vv` and then return before the step-2 auto-flush on later error

Evidence:

```rust
// quantbook-engine/crates/ql-collab/src/session.rs:1029
let mut merged = 0usize;
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

If blob 1 merges successfully and blob 2 is malformed (`self.log.merge_bytes(&bytes)?` returns `Err`) or `try_recv` returns `TransportError::Io` after prior successful drains, `current_vv` has advanced but execution exits before the post-loop `maybe_auto_flush`.

This does not create a false synced state: `last_flushed_vv` is unchanged, so `has_pending_flush()` remains true and explicit flush or detach/reattach can recover. It is still a contract caveat for the step-2 shorthand "after a non-empty drain, one auto-flush fires"; the precise behavior is "after a non-empty drain that reaches a normal loop exit or Closed-as-EOF break."

### L2 - `last_error` intentionally leaves stream-end EOF indistinguishable from clean caller close

Evidence:

```rust
// quantbook-engine/crates/ql-collab-ws/src/lib.rs:295
Ok(Message::Close(_)) => {
    // Graceful peer close - leave last_error None.
    closed_reader.store(true, Ordering::Relaxed);
    return;
}
...
// Stream ended (peer closed) - mark closed.
closed_reader.store(true, Ordering::Relaxed);
```

The `Err(e)` stream arm stores `Some(WebSocketError::RuntimeError(_))`, but the stream-end `None` path only marks closed. A peer EOF without an observed Close frame therefore has the same `last_error() == None` surface as `close()`:

```rust
// quantbook-engine/crates/ql-collab-ws/src/lib.rs:354
pub fn last_error(&self) -> Option<WebSocketError> {
    self.last_error.lock().ok().and_then(|guard| guard.clone())
}
```

This is low for this lane because it does not affect VV arithmetic or idempotency, and `try_recv` still eventually returns `Closed` after the inbound queue drains. It is nevertheless a protocol-observability ambiguity: callers cannot distinguish clean local close, graceful peer close, and EOF-without-cause unless tungstenite delivered an `Err`.

## Confirmed correct

- **VV equality / empty baseline.** Loro 1.12 `VersionVector` equality is structural value equality, treating missing peers as zero (`loro-internal-1.12.0/src/version.rs:269-276`). `ExportMode::all_updates()` is `Updates { from: Default::default() }` (`encoding.rs:94-97`), so the `None` branch in `flush_delta_to_transport` really is an empty-VV full-history update.
- **No `last_flushed_vv > current_vv` path found.** `last_flushed_vv` is initialized/reset to `None`, and only assigned from `self.log.oplog_vv()` after successful `flush_to_transport` or `flush_delta_to_transport`. Loro import/append/undo/presence operations grow the op log VV rather than shrinking it.
- **Direct flush failure preserves retry state.** `flush_delta_to_transport` exports before borrowing the transport, and `self.last_flushed_vv = Some(current_vv)` occurs only after `transport.send(&bytes)?`; `Closed`, `Io`, and export errors all leave the old checkpoint intact.
- **Offline-write recovery is correct.** `append_op` commits before `maybe_auto_flush`; no transport makes `maybe_auto_flush` a no-op; `attach_transport` resets `last_flushed_vv = None`; the next delta flush sends from the empty VV. The same reset makes recovery from a failed/closed transport send all accumulated ops to the new transport.
- **Normal receive-side auto-flush is correct.** When `poll_remote_with_limit` drains one or more blobs and exits normally, it fires one `maybe_auto_flush`, and the idempotency guard suppresses duplicate self-echoes when Loro dedupes without advancing the VV.
- **Drain-before-close holds in the WebSocket receive path.** `WebSocketTransport::try_recv` returns queued `Ok(Some(bytes))` before checking the closed flag, and `TryRecvError::Disconnected` means the mpsc queue is empty and the reader task has dropped `inbound_tx`.
- **No concurrent attach/mutator interleaving through `CollabSession`.** The session protocol state (`transport`, `auto_flush_policy`, `last_flushed_vv`, `log`) is mutated through `&mut self`; the interior mutability is inside transport implementations, not the session checkpoint itself.

No cargo tests were run for this audit, per instruction.
