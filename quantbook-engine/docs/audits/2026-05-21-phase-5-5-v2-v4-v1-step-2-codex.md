---
title: Phase 5.5 V2 V4 V1 step 2 audit - Codex
date: 2026-05-21
audit_target: HEAD `ff76fc99d49`
predecessor: `ef9e8f2f75c`
auditor: Codex
verdict: PASS-WITH-FINDINGS
scope: Tier I1 `CollabSession::pending_op_count()`
---

# Phase 5.5 V2 V4 V1 step 2 audit - Codex

## VERDICT: PASS-WITH-FINDINGS

No HIGH findings. The mechanical checkpoint lifecycle is implemented consistently: `last_flushed_op_count` is initialized/reset alongside `last_flushed_vv`, and both successful flush paths update both fields only after `Transport::send` succeeds. Failed sends preserve both baselines.

The main issue is the counter source. `pending_op_count()` uses `OpLog::len()`, but that is the visible `"ops"` list length, not a monotonic Loro causal/update count. Existing undo/redo semantics can shrink that visible list after a flush, so `saturating_sub` can return `0` while `has_pending_flush()` is still `true` and a delta really needs to be sent.

No cargo tests were run, per instruction.

## HIGH

None.

## MEDIUM

### M1 - `pending_op_count()` can report zero for pending undo/retraction deltas

Evidence:

`pending_op_count()` snapshots and subtracts `self.log.len()`:

```rust
// crates/ql-collab/src/session.rs:1034
self.last_flushed_vv = Some(self.log.oplog_vv());
self.last_flushed_op_count = Some(self.log.len());

// crates/ql-collab/src/session.rs:1146
self.last_flushed_vv = Some(current_vv);
self.last_flushed_op_count = Some(self.log.len());

// crates/ql-collab/src/session.rs:960
pub fn pending_op_count(&self) -> usize {
    let total = self.log.len();
    let last = self.last_flushed_op_count.unwrap_or(0);
    total.saturating_sub(last)
}
```

But `OpLog::len()` is explicitly the current visible list length:

```rust
// crates/ql-oplog/src/log.rs:140
/// Number of ops currently visible in the `"ops"` LoroList.
///
/// ... Loro `UndoManager`
/// retracted ops from the visible list.
pub fn len(&self) -> usize {
    self.doc.get_list(OPS_CONTAINER).len()
}
```

Existing tests pin that undo shrinks this visible count:

```rust
// crates/ql-collab/src/session.rs:2217
fn undo_retracts_visible_op_from_op_log_len() {
    ...
    assert_eq!(s.op_count(), 2);
    assert!(s.undo().unwrap());
    assert_eq!(s.op_count(), 1, "visible op count must shrink to 1");
}
```

That creates a current false-zero path:

1. Append two workbook ops.
2. Successfully `flush_delta_to_transport()`: `last_flushed_vv = VV2`, `last_flushed_op_count = Some(2)`.
3. Call `undo()` with `AutoFlushPolicy::Disabled` or no working transport. Loro changes the document/VV and retracts the visible list from 2 to 1.
4. `has_pending_flush()` is `true` because `current_vv != last_flushed_vv`.
5. `pending_op_count()` returns `1.saturating_sub(2) == 0`.

The same shape applies if an undo under `OnAppend` commits locally and then the auto-flush fails: the VV has advanced and the retry must send a delta, but the visible count can be lower than the prior flushed count. Peer-merged undo/retraction deltas can also shrink a hub's visible list after it has already flushed to a downstream transport.

Impact: the new helper does not reliably implement its documented sibling relationship with `has_pending_flush()`. The consumer doc currently says the boolean check is `pending_op_count() > 0`; that is false for the trace above. IDE bounded-queue or "N pending changes" policies can undercount to zero exactly when a pending retraction still needs transport delivery.

Suggested closure: base this accessor on a monotonic causal/update count that tracks the same state as `last_flushed_vv`, not on visible `OpLog::len()`. If Loro exposes enough `VersionVector` iteration, compute a VV-total delta; otherwise add an `OpLog` helper for the underlying Loro op-log length/counter. If the intended API is instead "visible workbook op entries pending," then the docs should not claim it is the count of transport-unseen log entries or equivalent to `has_pending_flush()`.

Suggested tests:

- `flush -> undo with Disabled policy -> has_pending_flush() == true && pending_op_count() > 0`.
- `flush -> attach closed transport with OnAppend -> undo returns Err(Closed) && pending_op_count() > 0`.
- hub merge of a peer undo/retraction after prior flush still reports pending count > 0.

## LOW

### L1 - Durable docs still leave Tier I1 looking pending or point queue observability at the boolean

Evidence:

`docs/phase5/v2-v3-exit-packet.md` still lists I1 as a V2 V4 backlog item:

```md
// docs/phase5/v2-v3-exit-packet.md:126
**Tier I - Phase 5.5 V2 V3 step 3 extensions** (3 items):
- I1: `pending_op_count()` / `pending_op_summary()` for bounded-queue IDE policies.
```

That exit packet already has later V2 V4 step-1 state folded into the limitations section, so leaving I1 unannotated can make future readers reopen a partially shipped item.

`docs/architecture/ide-consumer-contract.md` added the new gotcha, but the WebSocket limitation bullet still tells readers to combine the unbounded queue limitation with only `has_pending_flush()`:

```md
// docs/architecture/ide-consumer-contract.md:214
- **Unbounded outbound mpsc queue.** Memory grows if peer disconnects + caller keeps appending. Combine with V2 V3 step 3 `has_pending_flush()` for observability; V2 V4 will switch to bounded + backpressure policy.
```

Suggested closure: update the exit packet to say `pending_op_count()` shipped in V2 V4 V1 step 2 while `pending_op_summary()` remains deferred, and update the unbounded-queue bullet to point at `pending_op_count()` for threshold/backlog observability while retaining `has_pending_flush()` for cheap boolean status.

## CONFIRMED CORRECT / NO FINDING

- The six intended update sites are present: constructors initialize `last_flushed_op_count = None`, `attach_transport` and `detach_transport` reset it to `None`, and both `flush_to_transport` and `flush_delta_to_transport` set it after successful `send`.
- `flush_to_transport` and `flush_delta_to_transport` failure paths preserve the baseline because `transport.send(&bytes)?` short-circuits before either checkpoint update.
- The idempotency short-circuit in `flush_delta_to_transport` updates neither checkpoint; that is correct when both checkpoints are already synchronized. M1 is about the count source becoming non-monotonic, not about a missing assignment in the short-circuit.
- The from-snapshot edge case is documented for the append-only/visible-count path: `last_flushed_op_count = None` means the imported visible op count is reported before the first transport flush.
- `CollabSession` mutation remains `&mut self`-driven; there is no race between checkpoint writes and reads.

## TEST COVERAGE

The six new tests cover fresh sessions, visible appends, successful flush reset, attach baseline reset, failed append-flush preservation, and peer append merges. They do not cover existing shrink/retraction paths (`undo`, failed undo auto-flush, peer undo merge), which is where the counter currently diverges from `has_pending_flush()`.
