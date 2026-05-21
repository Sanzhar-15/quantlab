---
title: Phase 5.5 V2 V3 step 3 audit — Opus subagent verdict (adversarial probe + investigation-finding verification lane)
date: 2026-05-21
audit_target: HEAD `c73249d338c` (V2 V3 step 3 — offline-write story + has_pending_flush helper)
auditor: Opus subagent (independent of engineer; parallel with Codex)
tokens_used: 97417
tool_uses: 37
duration_ms: 320573
verdict: PASS-WITH-FINDINGS (0 HIGH + 3 MEDIUM + 5 LOW)
lane: adversarial probe synthesis + investigation-finding verification
---

# Phase 5.5 V2 V3 step 3 — Opus Adversarial Audit

## VERDICT: PASS-WITH-FINDINGS

The investigation finding ("Loro's CRDT op log IS the implicit offline queue; no separate buffer needed") holds under all 7 traced offline scenarios. The new `has_pending_flush()` helper is correct: `current_vv` vs `last_flushed_vv.unwrap_or_default()` cleanly captures "are there local ops the currently-attached transport hasn't seen yet." The 7 new integration tests pin the V2 V2 + V2 V3 step 1+2 composed contract directly, names are accurate, and the partial-state recovery path is end-to-end test-pinned.

However: the central claim sits on a docstring that has a concrete edge case wrong, plus the investigation finding leaves two ergonomic gaps undocumented as known limitations, and three offline-write-contract surfaces (from_snapshot, merge_bytes, Disabled-policy) are unpinned by tests despite being implied by the "Loro op log IS the queue" claim.

---

## HIGH

None.

---

## MEDIUM

### M1 — Docstring claim "no transport attached returns false" is wrong for `from_snapshot` sessions

File: `crates/ql-collab/src/session.rs` lines 752–759. **Convergent with Codex L1.**

The docstring asserts:
> "No transport attached" vs "all ops flushed" — both return `false` from this method (the former because the empty `current_vv` of a brand-new session equals the empty `last_flushed_vv.unwrap_or_default()`...)

The "brand-new session" qualifier silently scopes this to `CollabSession::new(...)` sessions with no ops. But `CollabSession::from_snapshot(...)` constructs a session where:
- `log = OpLog::import_bytes(bytes)?` → `oplog_vv()` reflects all peers in the imported snapshot (typically non-empty)
- `last_flushed_vv: None` → `unwrap_or_default()` = empty VV
- `current != last` → `has_pending_flush()` returns **true** despite no transport attached and no caller interaction

This breaks the named use case "IDE status indicator: Synced vs Unsynced changes" — a fresh `from_snapshot` open immediately surfaces as "Unsynced" with no user action.

Fix preference: docstring correction. Add a caveat paragraph acknowledging `from_snapshot` + post-detach non-empty cases return true.

### M2 — "No explicit queue needed" omits two ergonomic gaps that are NOT documented as known limitations

The investigation finding is framed as a clean win — "Loro's CRDT op log IS the implicit offline queue." Correct for the "flush all accumulated ops on reattach" use case but silently drops two adjacent IDE consumer needs:

1. **Bounded offline queue**: no `pending_op_count()`, no `oldest_pending_op_timestamp()`. IDE policies like "if more than N pending ops, switch to read-only mode" can't be implemented without traversing the Loro op log directly.
2. **Offline-write discard**: Loro op log doesn't support "ungrowing." An IDE consumer with a "discard unsynced changes on window close" workflow has no API.

Neither is documented as a known limitation in any of: `has_pending_flush` docstring, `transport.rs` module-doc, `ide-consumer-contract.md`, `v1-exit-packet.md`, `MASTER-PLAN.md`.

The Phase 5.3 closure pattern (cf. `PHASE-4-V2-BACKLOG.md` Tier H) is to enumerate known limitations explicitly even when they're deferred. Add 2 V2 V4 backlog entries.

### M3 — Test coverage gap: investigation "Scenario C" (merge_bytes + presence + undo offline) NOT pinned

Commit message claims "Scenario C: same shape as Scenario A." But the 7 new step-3 tests cover ONLY `append_op` and explicit `flush_delta_to_transport` for the offline path. No tests for:
- `update_presence` offline → reattach → flush delivers presence
- `merge_bytes` offline → reattach → flush delivers the merged ops
- `undo` / `redo` offline → reattach → flush delivers the undo op

The equivalence relies on every mutator routing through `maybe_auto_flush` which silently no-ops on `transport.is_none()`. Without probe tests, a future refactor that diverges one mutator's offline path silently breaks the claimed Scenario-C contract.

---

## LOW

### L1 — Step-3 tests are all `OnAppend`-policy; Disabled-policy offline path not pinned

All 7 new tests set `AutoFlushPolicy::OnAppend`. The offline-write contract is policy-orthogonal but step 3 only pins the OnAppend branch. Add a Disabled-policy variant test.

### L2 — `closed_transport_failed_flush` doesn't assert no spurious wire bytes during failure phase

**Convergent with Codex L2.** The test uses `NoopTransport::close()` from the start — doesn't exercise the "had successful flush + last_flushed_vv = X + transport closes mid-session + last_flushed_vv stays X after subsequent failed flush" branch.

### L3 — `has_pending_flush_returns_true_after_offline_append_false_after_flush` drops the LoopbackTransport peer mid-test

`let _ = observer;` drops the peer endpoint immediately after attach. Incidentally safe under LoopbackTransport's Arc-shared-queue model but fragile against future refactors. Either keep observer bound or rename + add a comment.

### L4 — Module-doc claim ordering in transport.rs

The V2 V3 step 3 paragraph traces `maybe_auto_flush` (internal) before `append_op` (public). Cosmetic; rewrite to lead with the visible API contract.

### L5 — Test name `has_pending_flush_distinguishes_synced_from_detached_via_state_advance` is one-sided

The test exercises the full cross-lifecycle cycle, not just state-advance. Cosmetic.

---

## Investigation finding verification

Traced under 7 probe scenarios:

| Scenario | Traced outcome | Test? |
|---|---|---|
| `append_op` + OnAppend + no transport | Op committed; `maybe_auto_flush` no-ops → `Ok(())` | ✓ |
| `append_op` + OnAppend + closed transport | Op committed; flush Err propagates; `last_flushed_vv` unchanged | ✓ (with L2 caveat) |
| `append_op` + Disabled + no transport | Op committed; `maybe_auto_flush` no-ops via Disabled-arm | ✗ (L1) |
| `merge_bytes` + OnAppend + no transport | Merged ops committed; `maybe_auto_flush` no-ops | ✗ (M3) |
| `update_presence` + OnAppend + no transport | Presence committed; `maybe_auto_flush` no-ops | ✗ (M3) |
| Reattach + post-attach mutator | `last_flushed_vv=None` → delta from empty VV → all ops sent | ✓ |
| Reattach + explicit `flush_delta_to_transport` | Same with explicit driver | ✓ |

The investigation finding is **correct**. The 3 unpinned scenarios are not broken, just not test-pinned (one refactor away from silent regression).

---

## Suggested closure scope

Cheapest path:
1. **M1** — docstring correction (~3 lines), no behavior change.
2. **M2** — add 2 V2 V4 backlog entries (no code).
3. **M3** — add 2 cross-mutator tests.
4. **L1** — add 1 Disabled-policy test.
5. **L2-L5** — bundle cosmetic fixes into the closure commit.

Total estimated effort: ~1-2 hours. None block V2 V3 step 4 (WebSocket impl).
