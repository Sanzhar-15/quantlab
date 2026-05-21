# V2 V4 V1 step 5 (Tier I2 discard_pending_ops + V2 V4 V1 exit packet) — Opus adversarial audit

**Lane**: Opus parallel-to-Codex adversarial.
**HEAD audited**: `ca0f9de6ece` (predecessor `d75dab17f7f`).
**Files audited**: `crates/ql-oplog/src/log.rs::fork_at_vv`, `crates/ql-collab/src/session.rs::discard_pending_ops`, `crates/ql-collab/tests/auto_flush.rs` (lines 2002-2122), `docs/PHASE-4-V2-BACKLOG.md` Tier I2 entry, `docs/architecture/ide-consumer-contract.md` gotcha #5, `docs/phase5/v2-v4-v1-exit-packet.md`.
**Test gate (claimed)**: 4459 / 0, +6 net.
**Verdict**: **PASS-WITH-FINDINGS** — 0 HIGH, 2 MEDIUM, 4 LOW, 1 observation.

## H — none

## M — addressable in-cycle or carry to V2 V4 V2

### M1. `discard_pending_ops` partial-state mutation on `set_peer_id` failure is undocumented in the docstring's "Errors" section

In `session.rs:1058-1081`, the sequence is:
1. `self.log = new_log;` — UNCONDITIONAL state mutation.
2. `self.log.set_peer_id(self.peer_id.as_u64())?;` — `?` propagates.
3. `self.undo = make_undo_manager(&self.log);` — only reached on Ok.

If step 2 returns Err (per docstring "should not happen in practice" — but the error variant is enumerated), the session is in a partial state: `self.log` is the forked/fresh doc, but its peer_id is the Loro-default (NOT the session's stable `PeerId`), AND the `self.undo` field still points to the **prior** UndoManager (subscribed to the prior — now dropped — LoroDoc).

The docstring's "Errors" section enumerates the error variants but does NOT explicitly say "on Err the session is in a degraded state — discard the session." Compare to `flush_delta_to_transport`'s partial-state contract (documented at `AutoFlushPolicy::OnAppend` per session.rs:1090 reference). Add one bullet to the discard docstring: **"On Err, the session log was already replaced; treat the session as invalidated and rebuild from a fresh snapshot."**

Severity: MEDIUM. Real-world reachability is near-zero (we assert non-sentinel PeerId at construction), but the contract gap is a footgun if a future refactor introduces a stricter Loro check.

### M2. Transport interaction post-discard — peer-loops-back-the-discarded-ops semantic is mentioned in the docstring's "What's preserved" but the CRDT-convergence consequence is NOT spelled out

The docstring at session.rs:1019 says "the attached transport (still attached; not detached)" — implying discard is purely local. But for an IDE engineer:

**Scenario**: User flushes ops O1..O5, then locally appends O6..O10 (still pending). User clicks "Discard unsynced." Local log reverts to checkpoint (O1..O5). Transport is still attached. The peer NEVER saw O6..O10 (they were never flushed past the local boundary) — IF and ONLY IF the transport's queue was drained AND the writer task hadn't yet shipped them. In the K1 closure (V2 V4 V1 step 1), `flush_delta_to_transport` returns Ok once the bytes are queued; the writer task may have ALREADY put them on the wire.

The discard-while-flushed-but-not-acked window means: the peer DID receive O6..O10, and on the next `merge_bytes` will re-deliver them to the local log. Local "discard" was temporary.

The docstring should add: **"Discard is LOCAL ONLY. If the transport's writer task has already shipped pending ops to a peer (between `flush_delta_to_transport` returning Ok and `flush_pending_to_transport` being called), the peer's copy survives. On the next `merge_bytes`, those ops re-appear in the local log via CRDT convergence — discard is not a guaranteed permanent retraction. For a guaranteed retraction, pair discard with a peer-side ack-op protocol (out of scope for V2 V4 V1) or call `flush_pending_to_transport()` BEFORE the local user clicks Discard so you at least know the wire state."**

Severity: MEDIUM. The IDE engineer reading gotcha #5 in the consumer contract WILL hit this misunderstanding on first review. Worth tightening before Phase 5.7.

## L — cosmetic / documentation tightening

### L1. Backlog phrasing "builds a fresh session" misrepresents the implementation

`docs/PHASE-4-V2-BACKLOG.md:528-532` — the Tier I2 closure entry says the API "builds a fresh session from the last-flushed snapshot." Actual implementation is `&mut self` and forks IN PLACE. The observable effect is similar but the framing is wrong — it does NOT return a `Self`, does NOT detach the transport, does NOT re-construct an UndoManager-as-if-from-snapshot. Tighten to: "reverts the existing session's log to the last-flushed checkpoint by forking the underlying LoroDoc; preserves transport + auto-flush + peer_id."

### L2. Exit packet ship-commit cell shows `[step 5 ship]` literal placeholder

`docs/phase5/v2-v4-v1-exit-packet.md:5` says `ship_commit_range: 3342e21b964 → [step 5 closure commit]` and the table at line 27 has `[step 5 ship] | [step 5 closure]`. The current HEAD is `ca0f9de6ece` per the audit prompt. Replace the placeholders with the actual commit hash before the next session reads this packet — leaving `[step 5 ship]` makes the packet look like an unfinished draft.

### L3. Consumer-contract gotcha #5 lacks a code example

§ 4.1.1 gotchas 1-4 all reference APIs by name; gotcha #5 introduces `discard_pending_ops()` with prose only. For consistency + Phase 5.7 load-bearing UX (the "discard unsynced changes" gesture is one of the headline IDE workflows), add a small code block under gotcha #5 mirroring the indicator-status example:

```rust
fn user_clicked_discard(session: &mut CollabSession) -> Result<(), CollabSessionError> {
    // CALLER MUST end any active undo group BEFORE this call.
    let discarded = session.discard_pending_ops()?;
    log::info!("discarded {} pending ops", discarded);
    Ok(())
}
```

This is load-bearing for Phase 5.7. Worth adding now while the API is fresh.

### L4. Test `discard_pending_ops_recreates_undo_manager` doesn't pin "redo stack also cleared"

The test at auto_flush.rs:2090-2103 verifies undo after discard works on the NEW manager and there's nothing else to undo. It does NOT pin that the REDO stack is also fresh — i.e., if before discard you did append → undo (creating a redoable item), does discard clear the redo stack too?

By construction the new UndoManager has both stacks empty (it was just constructed), but pinning that explicitly with a test would close the contract gap. Carry to V2 V4 V2 backlog if not in-cycle.

## Observation — not a finding

**O1. UndoManager post-discard subscribes to merge_bytes ops**

The new UndoManager is constructed against the forked doc and subscribes to ALL commits, including those from `merge_bytes` (peer ops). After discard, if the user calls `merge_bytes` first then `undo()`, they undo a peer's op — which is surprising for the user. This is intrinsic to loro::UndoManager and not unique to discard, but the discard flow is the most likely place to surface the surprise (because the user just chose to revert, expecting subsequent edits to be "theirs"). Not addressable here; could merit a global note about UndoManager-subscribes-to-everything in the consumer contract.

## Dimension-by-dimension findings

| Dimension | Verdict |
|---|---|
| 1. `fork_at_vv` round-trip identity | OK — `vv_to_frontiers` + `fork_at` is the canonical Loro 1.12 idiom; docstring correctly notes the new doc's peer_id is Loro-default (not preserved). No reachability issue if `vv` comes from `oplog_vv()`. |
| 2. `discard_pending_ops` invariants | **M1** — partial-state contract on Err undocumented. Two-branch shape (fork vs fresh) is observationally equivalent — both satisfy the post-condition. |
| 3. Transport interaction post-discard | **M2** — peer-loops-back gotcha needs explicit doc. Scenario (a) is real for the K1-queued-but-not-yet-sent window. |
| 4. UndoManager stack semantics | **L4** + **O1** — redo-stack-empty not pinned; subscribes-to-everything is intrinsic. |
| 5. fork_at edge — external VV | OK — `last_flushed_vv` is private (no setter); only set by flush-success paths; round-trip is guaranteed. Defensive `?` covers the future-mutability case. |
| 6. Backlog entry vs implementation | **L1** — phrasing drift. |
| 7. V2 V4 V1 exit packet accuracy | OK on count (12/13 with K9 absorbed + K4 deferred matches). **L2** — placeholder commit hashes. |
| 8. Phase 5.7 readiness | OK in substance. **L3** — gotcha #5 code example is load-bearing. |

## Conclusion

Step 5 ships a clean, well-tested API. The 6 tests cover the main contract surface (zero-op fast path, never-flushed branch, after-flush branch, state preservation, undo manager recreation, from_snapshot case). The Tier I2 backlog entry is closed and the exit packet correctly tallies 12/13 (K4 properly deferred).

**Required for in-cycle closure**: M1 (1-line docstring addition), M2 (one-paragraph docstring addition), L1 (backlog phrasing tweak), L2 (replace `[step 5 ...]` placeholders with `ca0f9de6ece` + closure commit hash).

**Carry to V2 V4 V2 backlog** (acceptable): L3 (gotcha #5 code example), L4 (redo-stack pinning test), O1 (consumer-contract note on UndoManager-subscribes-to-everything).

No HIGH findings. No reason to block step 5 ship; the M items are documentation deltas, not code bugs. Proceed to V2 V4 V1 step 5 closure → V2 V4 V1 exit declaration.
