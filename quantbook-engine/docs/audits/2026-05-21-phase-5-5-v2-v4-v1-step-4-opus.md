# Phase 5.5 V2 V4 V1 step 4 — Opus adversarial audit

**HEAD:** `1924d3ed1e1` (predecessor `35dc6dcabbd`).
**Scope:** small-bundle ship K2 + K3 + K6 + K7 + K8. 4451 → 4453 tests (+K2, +K7).
**Stance:** adversarial. Goal is to find what Codex (parallel lane) misses, not to ratify.
**Verdict:** **0 HIGH, 1 MEDIUM, 4 LOW, 1 OBSERVATIONAL.** Cleanup ship clears the bar; one parallelism gap with the K3 doc + one tightening recommendation on K2.

---

## MEDIUM

### M1. K3 LOAD-BEARING comment is single-sited; `TextFrameServer` has the same pattern, no comment

`crates/ql-collab-ws/tests/common/mod.rs` lines 222–272 define `TextFrameServer` with the same load-bearing pattern as `EchoServer`:

```
let conn_tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
let conn_tasks_in_accept = Arc::clone(&conn_tasks);
let accept_task = tokio::spawn(async move {
    loop {
        match listener.accept().await {
            Ok((stream, _peer_addr)) => {
                let handle = tokio::spawn(handle_text_then_binary(stream));
                if let Ok(mut tasks) = conn_tasks_in_accept.lock() {
                    tasks.push(handle);
                }
            }
            Err(_) => return,
        }
    }
});
```

This is the SAME spawn → sync-lock → push pattern as `EchoServer::start`. Step 4 added the LOAD-BEARING comment ONLY on `EchoServer`. A future refactorer migrating one to `tokio::sync::Mutex` would read the EchoServer comment, NOT find the TextFrameServer site flagged, and silently introduce the documented leak. The K3 closure rationale (V2 V3 step 5 Opus-B M5) applies identically to TextFrameServer.

**Recommendation:** add a brief cross-reference comment at `TextFrameServer::start` (e.g., "same load-bearing std::sync::Mutex contract as EchoServer — see K3 comment there"). One-liner; closes the parallel-fixture gap without re-stating the whole rationale.

Severity MEDIUM (not HIGH) because the only consumer is test code and the leak would manifest as a test-suite hang on the FIRST run, not a production bug. But it IS exactly the silent-migration risk the K3 comment exists to prevent.

---

## LOW

### L1. K2 test does not FORCE the drop-loss scenario; passes via trivial-recovery path on fast machines

`mid_drop_bytes_lost_recoverable_via_reattach` (lines 982–1093) intentionally omits `flush_pending_to_transport` before drop. On a fast machine, the writer task may complete all 3 sends before `Drop`'s `writer_task.abort()` fires. In that case no bytes were lost; the test passes via the TRIVIAL recovery path "WS#1 delivered all 3 blobs, echo bounced them back to the original session, Loro deduped on merge". The reattach + baseline-reset path on WS#2 is still exercised (because we did detach + attach), but it isn't actually RECOVERING anything — it's re-sending data that already round-tripped.

This is acknowledged in the prompt's audit dimension 1 as defensible: the test pins the RECOVERY CONTRACT (reattach + flush → all-ops-resent), which is what V2 V3 step 5 Opus-B M1 framed. Forcing drop-loss would require artificially blocking the writer task (e.g., a slow-drain wrapper transport), which adds significant test plumbing.

**Recommendation (LOW):** add a comment to the test body explicitly acknowledging "this test pins the RECOVERY contract regardless of whether drop-loss happened on this run; on fast machines all bytes may have reached WS#1 before Drop, in which case the reattach path re-sends already-known ops and Loro dedupes". This is a documentation-only addition; current test logic is correct.

Codex (parallel lane) likely flags this same point — convergent finding is fine.

### L2. K7 test is loose on Loro 1.12 current behavior (accepts both Ok and Err)

`merge_bytes_with_empty_slice_does_not_panic` (lines 681–725) accepts either `Ok(unchanged-len)` OR `Err(Loro(_), unchanged-len)`. The commit message says "Loro 1.12 currently returns Err". The test's inline comment says "The pinned behavior in Loro 1.12: empty input is treated as Err". So the test KNOWS the current behavior but does not strictly pin it.

Trade-off (acknowledged in prompt):
- **Strict pin** (assert Err only): catches a future Loro version that silently flips Err → Ok, but breaks on every intentional upgrade and forces a test edit.
- **Loose pin** (current): test doesn't break on upgrades that toggle Ok/Err but still catches the most-important regression (panic).

The loose pinning is defensible AS LONG AS the comment explicitly names what's being given up. The current comment in the test ("Whatever Loro 1.12 does here, pin it as a contract") slightly overstates — the contract pinned is "no-panic + no-partial-state", NOT the specific Ok/Err shape.

**Recommendation:** tighten the inline comment to "this pins NO-PANIC and NO-PARTIAL-STATE; the Ok/Err shape is intentionally loose so Loro upgrades that flip the discriminant don't break this test without altering the safety contract". One-line clarification.

### L3. K6 Debug holds `last_error` mutex briefly; OK for normal use, worth noting

`.field("last_error_present", &self.last_error().is_some())` calls `last_error()` which acquires `Mutex<Option<WebSocketError>>` (V2 V3 step 5 Opus-B M3 closure made it poison-resilient). The Debug formatter holds the lock for a `clone()` (cheap — `WebSocketError` is `String`-backed) then drops it.

In normal use this is fine. The risk is the `Debug` impl being invoked from a context where holding ANY lock is dangerous — e.g., panic-message construction during a writer-task panic where the panic was caused by the same mutex being poisoned. In that case `last_error.lock()` returns `Err(PoisonError)` and the `into_inner()` recovery path runs. No deadlock; just `last_error_present` reflects the slot's contents across the poison boundary.

The K6 closure correctly inherits the V2 V3 step 5 Opus-B M3 hardening — there's no regression. But the K6 commit message doesn't explicitly note this inheritance.

**Recommendation:** add a short comment ("relies on `last_error()`'s poison-resilient unlock — V2 V3 step 5 Opus-B M3") near the new Debug field for traceability. Cosmetic.

### L4. K8 docstring amendment is correct but spans 13 lines for a single contract clarification

The K8 amendment at `crates/ql-collab/src/session.rs` lines 1239–1252 is ~13 lines of prose explaining a single behavior: "if `?` propagates mid-loop, post-loop `maybe_auto_flush` is skipped; recovery is via the next flush path." The prose is correct (verified against the code path at lines 1265–1301: `merge_bytes(&bytes)?` and `return Err(CollabSessionError::Transport(other))` both bypass the `if merged > 0 { self.maybe_auto_flush()?; }`).

It IS verbose for the niche corner case. A future reader looking at `poll_remote_with_limit` now reads 70+ lines of docstring before the function body. The verbosity is defensible because the contract is non-obvious from the body, and the V2 V3 step 5 Codex L1 was specifically about this gap.

**Recommendation:** none — verbose is the correct trade-off here. Logging for symmetry with Codex's likely L1.

---

## OBSERVATIONAL

### O1. Cumulative pattern — step 4 has lower-severity findings than steps 1-3

Prompt dimension 7 asked: "is this the 4th consecutive ship caught by audit?" Answer: yes, but with a clear severity drop-off:
- Step 1: 1 HIGH (Codex M2 spurious-Err on `undo`/`redo` empty stack).
- Step 2: 1 HIGH + 3 MEDIUM (V2 V2 pending-op-count regression vector).
- Step 3: 0 HIGH + 2 MEDIUM + 7 LOW (Tier J + K5 cleanup).
- Step 4 (this): 0 HIGH + 1 MEDIUM + 4 LOW.

The drop-off is consistent with the cleanup-vs-semantic-change distinction the prompt called out. The small-bundle approach IS appropriate for cleanup. The 1 MEDIUM (M1 above — parallel fixture not annotated) is a "missed parallel site" pattern, not a semantic correctness issue.

This validates the audit-discipline rule from 2026-05-17: "after each phase/wave/implementation, run parallel Codex + separate-Opus audits". Step 4 cleared as expected; the audit caught one missed parallel site that would have shipped silently otherwise.

---

## Items deliberately NOT raised

- K2 echo-roundtrip timing (50 × 20ms loop): adequate. The OS+local-loopback round-trip is microseconds, not milliseconds. The loop is defensive against tokio scheduling jitter, not against actual slow I/O.
- K2 `op_count() == 3` assertion: correct. Loro dedupes ops by identity, so echo-bounce of own ops doesn't inflate the count. Verified against `OpLog::len()` at `quantbook-engine/crates/ql-oplog/src/log.rs:148` (which proxies Loro's op count).
- K6 Debug ordering of fields: `closed → writer_finished → reader_finished → last_error_present`. Reads top-down as "what's the transport state + did anything go wrong". Natural.
- K8 docstring claim "Closed-as-EOF break" — verified at lines 1280–1284 of session.rs: the `Err(TransportError::Closed)` arm `break`s, falling through to the post-loop `maybe_auto_flush` guarded by `if merged > 0`. Correct.

---

## Closure recommendations (in priority order)

1. **M1** — add cross-reference comment to `TextFrameServer::start` re K3 contract. One-line; closes parallel-fixture gap.
2. **L1** — add comment in K2 test acknowledging the trivial-recovery-path scenario. One-line.
3. **L2** — tighten K7 inline comment to clarify "no-panic + no-partial-state" is the pinned contract (NOT the Ok/Err shape). One-line.
4. **L3** — note `last_error()` poison-resilience inheritance near K6 Debug field. Cosmetic.

All 4 fit in a single closure commit of ~6–8 lines net. No semantic changes required.
