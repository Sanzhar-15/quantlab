---
title: Phase 5.5 V2 V4 V1 step 5 audit - Codex
date: 2026-05-21
audit_target: HEAD `ca0f9de6ece`
predecessor: `d75dab17f7f`
auditor: Codex
verdict: PASS-WITH-FINDINGS
scope: Tier I2 discard_pending_ops + V2 V4 V1 exit packet
---

# Phase 5.5 V2 V4 V1 step 5 audit - Codex

## VERDICT: PASS-WITH-FINDINGS

No HIGH findings. `CollabSession::discard_pending_ops` is correct for the current private-session checkpoint path: it reverts to `last_flushed_vv`, restores the session peer id on the new Loro doc, preserves transport/policy state, recreates the `UndoManager`, and leaves `pending_op_count() == 0` / `has_pending_flush() == false` for the covered scenarios.

The main issue is at the lower-level public helper: `OpLog::fork_at_vv` documents invalid VVs as an `Err`, but Loro 1.12's `vv_to_frontiers` can panic before `fork_at` gets a chance to return an error when a multi-peer VV references missing history. This does not appear reachable through `discard_pending_ops`, because `last_flushed_vv` is private and comes from this session's own `oplog_vv()` after successful flushes.

No cargo tests were run, per instruction. Supplied gate: 4459 / 0 with `--test-threads=1`; fmt and clippy clean.

## HIGH

None.

## MEDIUM

### M1 - `OpLog::fork_at_vv` can panic on invalid multi-peer VVs despite returning `Result`

Evidence:

```rust
// crates/ql-oplog/src/log.rs:384
pub fn fork_at_vv(&self, vv: &loro::VersionVector) -> Result<Self, OpLogError> {
    let frontiers = self.doc.vv_to_frontiers(vv);
    let forked = self.doc.fork_at(&frontiers)?;
    Ok(Self { doc: forked })
}
```

Loro 1.12 public API is infallible:

```rust
// loro-1.12.0/src/lib.rs:861
pub fn vv_to_frontiers(&self, vv: &VersionVector) -> Frontiers {
    self.doc.vv_to_frontiers(vv)
}
```

The internal implementation maps each nonzero VV entry to `ID(peer, counter - 1)`, then unwraps frontier shrinking:

```rust
// loro-internal-1.12.0/src/oplog/loro_dag.rs:1228
pub fn vv_to_frontiers(&self, vv: &VersionVector) -> Frontiers {
    ...
    let last_ids: Frontiers = this.iter().filter_map(...).collect();
    ...
    shrink_frontiers(&last_ids, self).unwrap()
}
```

`shrink_frontiers` returns `Err(id)` when any frontier id is missing from the DAG:

```rust
// loro-internal-1.12.0/src/version.rs:879
let Some(lamport) = dag.get_lamport(&id) else {
    return Err(id);
};
```

For a single invalid peer/counter, `shrink_frontiers` returns early without validation (`last_ids.len() <= 1`), so `fork_at` can later return an encode/frontier error. For a multi-peer invalid VV, the `.unwrap()` can panic before `fork_at` runs. That contradicts the new docstring's error contract at `crates/ql-oplog/src/log.rs:378-383`.

Impact: not a current `CollabSession::discard_pending_ops` bug, because the only caller passes `last_flushed_vv`, and that field is private and set from this same log's `oplog_vv()` on successful flush. It is still a public `ql-oplog` API robustness hole.

Suggested closure: validate `vv` before calling `vv_to_frontiers`, e.g. require `self.doc.oplog_vv().includes_vv(vv)` and return an `OpLogError` for invalid/ahead VVs. Then keep a post-fork round-trip assertion or check (`forked.oplog_vv() == *vv`) for the documented post-condition.

## LOW

### L1 - Discard is local-only, but the docs do not say that clearly

`discard_pending_ops` preserves the transport and rewinds only the local session log. If another peer already learned about an op through some path, this method does not send a compensating revert and does not make peers auto-revert. The current docstring lists what is discarded and preserved, but omits that local-only/convergence caveat:

```rust
// crates/ql-collab/src/session.rs:995
/// Discard all ops appended to the local log since the last successful
/// flush.
```

The IDE consumer gotcha also warns that the operation is destructive, but not that it is not a protocol-level revert:

```md
docs/architecture/ide-consumer-contract.md:257
```

Suggested closure: add one sentence to the session docstring and gotcha #5: this abandons only this session's unflushed local view; peers are not instructed to revert, and protocol-level rollback needs an explicit domain operation.

### L2 - Offline-write recovery docs should cross-reference the discard branch

Section 4.1.3 is framed as "User edits offline. They reconnect. All edits flow to peers." That is correct for recovery, but V2 V4 V1 now adds the opposite user flow: user chooses not to recover offline edits.

Evidence:

```md
docs/architecture/ide-consumer-contract.md:342
#### 4.1.3 Offline-write recovery

docs/architecture/ide-consumer-contract.md:382
if session.has_pending_flush() {
    session.flush_delta_to_transport()?;
}
```

Without a cross-reference, an IDE implementer reading only the recovery workflow could miss that "Discard" should happen before attach/explicit flush when the user chooses to abandon offline changes. Suggested closure: add a gotcha to 4.1.3: if the reconnect dialog offers "Discard local/offline edits", call `discard_pending_ops()` before reattaching or before the post-attach explicit flush.

### L3 - Exit/backlog closure docs still contain placeholders or stale closure detail

The 12/13 shipped framing is broadly accurate: I1, I2, J1, J2, J3, K1, K2, K3, K5, K6, K7, K8 are marked shipped, K9 is absorbed, and K4 is deferred. The durable docs still have a few cleanup misses:

- `docs/phase5/v2-v4-v1-exit-packet.md:5` has `[step 5 closure commit]`.
- `docs/phase5/v2-v4-v1-exit-packet.md:27` has `[step 5 ship]` / `[step 5 closure]`.
- `docs/phase5/v2-v4-v1-exit-packet.md:85` still says step 5 audits are pending / TBD.
- `docs/PHASE-4-V2-BACKLOG.md:524` still has `[step 2 closure commit]`.
- `docs/PHASE-4-V2-BACKLOG.md:573` still has `[V2 V4 V1 step 1 commit]`.
- `docs/PHASE-4-V2-BACKLOG.md:587` describes K3 as a comment-only closure, while HEAD has the stronger `ServerState { closing, tasks }` race-protection helper in `crates/ql-collab-ws/tests/common/mod.rs`.

Impact: documentation only, but the exit packet is intended as the final handoff record. Suggested closure: resolve placeholders and align the K3 backlog wording with the final step 4 closure.

### L4 - Attached-transport preservation is implemented but not directly test-pinned

`discard_pending_ops` does not mutate `self.transport`, so preserving an attached transport is evident from code. The tests cover a detached state in `discard_pending_ops_preserves_session_state`, but no test covers "attached before discard remains attached" or the immediate post-discard behavior (`flush_delta_to_transport()` returns `Ok(false)`, append-after-discard sends a new delta).

Impact: low coverage gap only. The implementation is straightforward and the existing tests cover the harder state transition (fork/fresh-log + peer id + undo recreation).

## CONFIRMED CORRECT / NO FINDING

- `discard_pending_ops` clones `last_flushed_vv` before replacing the log, then preserves that checkpoint. For `Some(vv)`, the forked log's VV matches the checkpoint on valid same-doc VVs; for `None`, a fresh `OpLog::new()` makes current/default VV match `last_flushed_vv.unwrap_or_default()`.
- The `from_snapshot` + never-flushed case is intentionally destructive: imported ops count as pending because `last_flushed_vv == None`, and discard replaces the log with an empty one.
- Re-setting `peer_id` after `fork_at` / fresh `OpLog::new()` is necessary and correct. Loro `set_peer_id` is fallible only for `u64::MAX` or invalid transaction state; the current constructors reject `u64::MAX` through the initial `set_peer_id` call.
- Recreating `UndoManager` is necessary and correct. The old manager is bound to the old Loro doc and its stacks should not survive the discard boundary.
- The six new test names match their bodies. They pin zero-noop, never-flushed discard, flushed-checkpoint revert, session-state preservation, undo-manager recreation, and from-snapshot wipe.
- Loro 1.12's documented snapshot-at behavior supports the valid-VV post-condition: `SnapshotAt` exports state/history at frontiers, and Loro's own tests assert imported `snapshot_at(v1).oplog_vv() == vv1`.

## TEST COVERAGE

No tests run for this audit, per instruction.

Supplied workspace gate: 4459 / 0 with `--test-threads=1`; fmt and clippy clean.
