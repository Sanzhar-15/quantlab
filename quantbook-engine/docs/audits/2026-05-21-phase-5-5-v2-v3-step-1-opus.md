---
title: Phase 5.5 V2 V3 step 1 audit — Opus subagent verdict (adversarial probe synthesis + Loro API contract lane)
date: 2026-05-21
audit_target: HEAD `603bdc9aa6c` (Phase 5.5 V2 V3 step 1 — version-vector delta flush)
auditor: Opus subagent (independent of engineer; parallel with Codex)
tokens_used: 110409
tool_uses: 52
duration_ms: 335781
verdict: PASS-WITH-FINDINGS (0 HIGH + 2 MEDIUM + 6 LOW + 3 nice-to-have)
lane: adversarial probe synthesis + Loro 1.12 API contract verification
---

# Phase 5.5 V2 V3 step 1 — Opus Adversarial Audit

## VERDICT: PASS-WITH-FINDINGS

The V2 V3 step 1 ship is correct on the core mechanics: VV equality is structurally symmetric (`loro-internal/version.rs:269-276`), `VersionVector::default()` is the empty FxHashMap which is exactly what `ExportMode::all_updates()` uses internally (`encoding.rs:94-98`), the `expect("just-checked is_some above")` at `session.rs:836` is panic-safe under `&mut self`, the lifecycle of `last_flushed_vv` is consistent, and `LoroDoc::export` for `Updates` mode is infallible. Probes D1, D2, D4, D5, D6, D7, D8 all close cleanly.

---

## HIGH

None.

---

## MEDIUM

### M1 — Test `delta_flush_failure_does_not_advance_vv_so_retry_resends` does NOT verify its named property

File: `quantbook-engine/crates/ql-collab/tests/auto_flush.rs:896-934`.

The test name claims to verify "failure does not advance VV, so retry resends." But on line 919 the test calls `s.detach_transport()`, which resets `last_flushed_vv = None`. Then `s.attach_transport(tx_a)` resets it again. The acknowledging comment on lines 922-924 confirms: "this tests a different property than the original intent."

The actual property — that an Err'd `flush_delta_to_transport` leaves `last_flushed_vv` unchanged so a retry (on the SAME transport, without detach) re-sends the same delta — has NO test coverage. A regression where `last_flushed_vv` is updated BEFORE the `transport.send(&bytes)?` line would silently pass CI.

**Suggested fix:** add a `OneShotFailingTransport` test fixture that returns `Err(Closed)` on first `send` and `Ok(())` on subsequent calls. Verify two consecutive `flush_delta_to_transport` calls: first returns `Err`, second returns `Ok(true)` with bytes containing the same delta.

### M2 — `set_auto_flush_policy` docstring is stale post-V2 V3 step 1

File: `quantbook-engine/crates/ql-collab/src/session.rs:674`.

The doc reads "auto-invoke `flush_to_transport` internally" — but V2 V3 step 1 reroutes through `flush_delta_to_transport`. The `AutoFlushPolicy::OnAppend` doc at lines 200-216 DOES note the V2 V3 reroute. The `set_auto_flush_policy` doc lags.

---

## LOW

### L1 — No bandwidth-savings assertion in any test

V2 V3 step 1's raison d'être is "O(state) → O(delta)" wire compression. Every test asserts correctness but NONE asserts `second_bytes.len() < first_bytes.len()` for the same logical content. A regression where `flush_delta_to_transport` accidentally re-routes through `export_bytes()` would pass every existing test silently.

### L2 — Missing test: idempotency short-circuit after `merge_bytes` of duplicate ops

The audit-closure narrative claims the idempotency guard catches the case where a `merge_bytes` is itself a no-op (Loro dedupe). No test verifies this specifically.

### L3 — No test verifies symmetric-OnAppend convergence WITHOUT echo-loop on a paired LoopbackTransport

The audit-closure narrative claims V2 V3 step 1 idempotency makes "symmetric `OnAppend` on both peers of a paired transport safe" (session.rs:255-259). No test constructs two `CollabSession` instances both with `OnAppend` policy and paired endpoints, performs writes on both, verifies convergence + bounded wire-byte count. Today the safety claim is mechanically deducible but not test-pinned.

### L4 — Lost-in-flight delta cannot be detected at the sender

Design-level note for V2 V3 step 2/4. If a delta blob is dropped, sender's `last_flushed_vv` advances but peer never receives. Subsequent deltas reference a prefix the peer doesn't have. Sender-side VV ack from receiver needed.

### L5 — `from_snapshot` + immediate `flush_delta_to_transport` re-sends imported history

Design contract: the engine cannot know the peer's prior knowledge without a handshake. V2 V3 step 4 (WebSocket connection-establish handshake) should expose "peer already has VV X" so first flush sends delta from that.

### L6 — Empty-doc first flush sends a non-zero-byte payload

`CollabSession::new` → `attach_transport` → `flush_delta_to_transport()` on an empty doc sends a small Loro-header-only blob (the `None` branch doesn't short-circuit). Probably intentional (handshake), worth being explicit in docstring.

---

## Information / nice-to-have

### I1 — `oplog_vv` docstring at log.rs:343-353 has draft-state self-correcting comment

"Wait — `CollabSession` lives in `ql-collab` and depends on `ql-oplog`..." reads as stream-of-consciousness. Replace with clean statement.

### I2 — Mixed-path test verifies only snapshot-then-delta order, not the reverse

Adding the delta-then-snapshot mix would round out coverage of the documented mix-and-match pattern.

### I3 — `delta_flush_after_merge_bytes_sends_merged_state_to_third_peer` ambiguity

Comment says "simulating B handing A bytes through some other channel" but the test uses `export_bytes()` (full snapshot). Clarifying that the "other channel" specifically uses snapshot bytes reduces reader ambiguity.

---

## Loro 1.12 API contracts verified

| Contract | Verified at | Result |
|---|---|---|
| `VersionVector` PartialEq is symmetric value comparison | `loro-internal/version.rs:269-276` | ✓ |
| `VersionVector::default()` = empty FxHashMap | `loro-internal/version.rs` (Default impl) | ✓ |
| `ExportMode::all_updates()` ≡ `Updates { from: Default::default() }` | `loro-internal/encoding.rs:94-98` | ✓ |
| `LoroDoc::export(Updates)` returns infallible bytes | `loro-internal/encoding.rs:386-392` | ✓ |
| `oplog_vv()` clone cost is O(peer-count), not O(op-count) | `loro::LoroDoc::oplog_vv` returns `self.oplog.lock().vv().clone()` | ✓ |
| Delta export is real delta (not snapshot-pretending-as-delta) | `oplog.export_blocks_from(vv, w)` iterates `latest_vv.sub_iter(start_vv)` | ✓ |
| `&mut self` excludes concurrent mutation during VV check/encode/send | Rust borrow-checker by construction | ✓ |

---

## Summary

V2 V3 step 1 ships clean on core invariants. 9 new tests cover the headline cases. Main correctness-affecting gaps are M1 (failure-retry test misnames) and L3 (symmetric-OnAppend convergence not test-pinned). Neither blocks the ship; both should be closed in V2 V3 step 5 megaudit. Doc lag (M2) should be fixed in step 5 closure or step 2 commit.

The Loro 1.12 API contracts are verified — no surprises.
