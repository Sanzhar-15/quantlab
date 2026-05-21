---
title: Phase 5.5 V2 V3 step 2 audit — Opus subagent verdict (adversarial probe synthesis + contract invariant lane)
date: 2026-05-21
audit_target: HEAD `e4e1ce282b1` (Phase 5.5 V2 V3 step 2 — poll_remote auto-flush)
auditor: Opus subagent (independent of engineer; parallel with Codex)
tokens_used: 97328
tool_uses: 35
duration_ms: 303654
verdict: PASS-WITH-FINDINGS (0 HIGH + 3 MEDIUM + 4 LOW)
lane: adversarial probe synthesis (E1-E8) + invariant checking
---

# Phase 5.5 V2 V3 step 2 — Opus Adversarial Audit

## VERDICT: PASS-WITH-FINDINGS

V2 V3 step 2 ships correctly: the `if merged > 0 { self.maybe_auto_flush()?; }` block in `poll_remote_with_limit` is well-placed, the skip-zero guard is sound, the idempotency interaction with V2 V3 step 1 holds, and the partial-state contract on auto-flush Err is documented. The 4 test changes pin the contract at the right granularity (inverted exclusion test + 3 new edge cases). All 8 adversarial probes (E1–E8) terminate / hold under reasoning.

However, three stale-doc residuals (one in code, two in test docstrings) survived the contract inversion, and one test-coverage gap exists for a documented contract.

---

## HIGH

None.

---

## MEDIUM

### M1 — STALE DOC: `LoopbackTransport` docstring still asserts the old exclusion

File: `crates/ql-collab/src/transport.rs` lines 190–192.

The text in the `LoopbackTransport` doc was authored at V2 V2 time and **directly contradicts** the V2 V3 step 2 contract that the same file's module-doc (lines 27–35) now asserts.

Fix: replace the stale lines with a V2 V3 step 2 statement referencing the new contract.

### M2 — STALE DOC: `symmetric_on_append_two_peers_converge_with_bounded_wire_bytes` docstring asserts the OLD V2 V3 step 1 exclusion

File: `crates/ql-collab/tests/auto_flush.rs` lines 1188–1195 + 1213.

Comments refer to the now-defunct exclusion as if it still holds. Test still PASSES — `flush_delta_to_transport` after the auto-flushing `poll_remote` hits the idempotency short-circuit. But the docstring's *load-bearing rationale* is now incorrect.

Fix: either (a) drop the explicit flushes; verify convergence works by `poll_remote` alone (stronger step-2 test), OR (b) keep them and update docstring: "explicit flushes kept for V2 V3 step 1 closure narrative continuity; under V2 V3 step 2 they're idempotent no-ops".

### M3 — TEST GAP: partial-state contract on auto-flush Err in `poll_remote_with_limit` is documented but not pinned by a test

The docstring at `session.rs` lines 916–926 documents a specific partial-state contract for the drain-ok + flush-Err case. None of the 4 new tests cover this scenario — they cover only success paths + zero-drain skip.

Fix: add a test using a transport that succeeds for `try_recv` (drain) but errors on `send` (flush). Assert: `Err(Transport(Closed))`, `op_count() >= 1` (merged blob committed), `last_flushed_vv` unchanged.

Without this test, a future regression that advances `last_flushed_vv` before the send (or that returns `Ok(merged)` on flush Err) would slip past. Codex L3 convergent.

---

## LOW

### L1 — Round-trip "verify Loro-imported" sanity is weak

`poll_remote_triggers_auto_flush_under_on_append` test lines 455–457 import into a FRESH OpLog and discard. Verifies bytes are valid Loro but doesn't verify post-merge content matches.

### L2 — `poll_remote_idempotent_merge_short_circuits_no_wire_send` returns Ok(1) for "merged 1 blob" but no ops actually merged

Reader might wonder whether `merged` should count "blobs drained" vs "ops applied". Current contract is "blobs drained" — explicit at session.rs line 854. Worth a one-line comment in the test pointing this out.

### L3 — Echo-loop bound assertion missing in `poll_remote_triggers_auto_flush_under_on_append`

After A's auto-flush sends bytes back to B's inbox, test consumes them once but doesn't verify termination if both peers were OnAppend. Symmetric test at line 1187 does this with a 20-iteration cap; the new step-2-specific test doesn't.

### L4 — V1-limit "single-attached-transport" claim is repeated 3 times across docs

`AutoFlushPolicy::OnAppend` docstring + `ide-consumer-contract.md` + commit message. If V2 V3 step 4 lifts this, ALL 3 sites need updating in lockstep.

---

## Probe summary

| Probe | Question | Result |
|---|---|---|
| E1 | Self-loopback amplification | Terminates after 2 round-trips via V2 V3 step 1 idempotency guard. ✓ |
| E2 | Drain-cap edge cases | `max_blobs == 0` and `merged == max_blobs` both handled correctly. ✓ |
| E3 | Closed-transport mid-batch | Code correctly drains all queued bytes per trait contract; partial-state contract documented; only the test gap (M3) is the concern. ✓ |
| E4 | Partial-state contract accuracy | Merges committed before flush attempt; claim correct. ✓ |
| E5 | VV checkpoint advancement | `last_flushed_vv` advances only on flush success; delta includes both polled merges + local appends. ✓ |
| E6 | Inverted test logic | Structure clean; no extra ops muddy the count. ✓ |
| E7 | 3-peer hub claim | Contingent on multi-peer-multiplexing transport (out of scope for V1); documented as V1 limit. Honest framing. ✓ |
| E8 | Stale symmetric-OnAppend test docstring | Surfaced as M2. |

---

## Convergence with Codex

Both auditors found the same 3 issues (Codex L1 = Opus M1; Codex L2 = Opus M2; Codex L3 = Opus M3). Opus elevated to MEDIUM because of the contradiction (M1) and contract-pin gap (M3) implications; Codex framed as LOW. Either bucketing is defensible; the issues themselves are concrete and addressable.

## Recommendation

Ship V2 V3 step 2 as-is. Before V2 V3 step 5 megaudit, close:

1. **M1** — fix LoopbackTransport stale docstring (1-line edit).
2. **M2** — fix symmetric-OnAppend test docstrings + optionally drop redundant explicit flushes (2-line edits OR small test refactor).
3. **M3** — add partial-state-on-flush-Err test (~30 lines).
4. **L4** — single-attached-transport limit could be consolidated into one canonical doc reference (defer).

L1, L2, L3 (Opus-unique) can defer to step 5 megaudit pass.
