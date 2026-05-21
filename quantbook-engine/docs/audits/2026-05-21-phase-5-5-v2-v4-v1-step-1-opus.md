# Phase 5.5 V2 V4 V1 step 1 — Opus adversarial audit

**Audit target:** HEAD `3342e21b964` — Tier K1 ack channel (Transport::flush_pending).
**Predecessor:** `8a8236840f2` (V2 V3 step 6 exit packet).
**Audited in parallel with:** Codex audit on the same ship.
**Workspace gate:** 4442 / 0 with `--test-threads=1`, fmt + clippy clean (per the ship note; not re-run here).

---

## Verdict

**Ship-ready with three closures.** The flush_pending mechanism is sound: SeqCst on `queued_count` + Mutex-guarded `progress.0` give correct happens-before; the Condvar wait_timeout idiom handles the "wake on closed-flag" loop bound; the multi-thread runtime test is the right way to validate level-1 ack. The convergent V2 V3 step 5 finding (Codex M1 + Opus-B M1) is genuinely closed at the documented "level-1" depth. But three real holes need follow-up (one MEDIUM behavioral, two doc-drift) and two LOWs are worth recording.

---

## HIGH

None. The mechanism is sound under current API constraints.

---

## MEDIUM

### M1 — Reader-task closed-flag transitions do NOT notify the Condvar; bounded-but-real 100ms flush_pending latency window

File: `crates/ql-collab-ws/src/lib.rs` lines 432, 457, 472, 487 (reader task `closed_reader.store(true, ...)`).

The writer task sets `closed_writer.store(true)` AND `progress_writer.1.notify_all()` together (line 388-391). `WebSocketTransport::close()` (line 549-551) and `Drop` (line 578-579) also pair the two. **The reader task** sets closed=true in four places (binary mpsc-drop, Close frame, Err, stream-end-None) — **none** call `progress.1.notify_all()`.

Scenario: caller queues bytes via `send`; writer is parked on `outbound_rx.recv` waiting for new bytes; caller calls `flush_pending` and parks on Condvar; concurrently the **reader** observes peer disconnect and sets closed=true. `flush_pending` wakes only via the 100ms `wait_timeout`. Bounded delay but unnecessary. The docstring at line 661-664 ("notified after each progress increment AND on closed-flag transitions") is **partially false** — only writer-side / close()-side / Drop-side transitions notify.

Test `flush_pending_returns_closed_if_server_drops_mid_flush` passes because it allows up to 3 seconds and 100ms timeout reliably wakes within budget. So the test isn't a flake — but the docstring overpromises.

**Closure:** clone an `Arc<(Mutex<u64>, Condvar)>` into the reader task and call `progress.1.notify_all()` at each of the four `closed_reader.store(true, ...)` sites. Equivalently: extend TaskExitGuard to hold the Condvar Arc and notify in its Drop too (handles panic path — see M2).

### M2 — TaskExitGuard panic-path does NOT notify the Condvar; panic deadlocks flush_pending for the full 100ms wait_timeout per iteration

File: `crates/ql-collab-ws/src/lib.rs` lines 114-157 (`TaskExitGuard`).

The guard holds `closed: Arc<AtomicBool>` and `last_error: Arc<Mutex<...>>` but **not** the Condvar Arc. On panic-unwind of the writer task, `Drop` records the panic + sets closed=true (line 150-154). It does NOT notify the Condvar. Any `flush_pending` parked on the Condvar wakes only via the 100ms wait_timeout.

This is the exact failure mode the rest of the file plumbs the Condvar to avoid (writer's Err arm at line 391 notifies precisely to close this gap). The panic path leaves it unplugged.

**Closure:** add a third field `progress: Arc<(Mutex<u64>, Condvar)>` to `TaskExitGuard`; call `progress.1.notify_all()` in `Drop::drop` after setting closed. Pass an `Arc::clone(&progress)` at both `TaskExitGuard::new` sites.

### M3 — Doc drift: three call-sites still say "V2 V4 will add an ack channel" after V2 V4 V1 step 1 shipped one

The audit memo flagged this as a known drift pattern. Confirmed three sites still outdated:

1. `crates/ql-collab/src/transport.rs:132-134` — `Transport::send` docstring V2 V3 step 5 closure block: "V2 V4 will add an explicit ack-channel API for true end-to-end delivery confirmation." Should now say: "Closed by V2 V4 V1 step 1 (HEAD `3342e21b964`) — see [`Transport::flush_pending`]."

2. `crates/ql-collab/src/session.rs:1029-1030` — `flush_delta_to_transport` docstring § "Delivery semantics — queued vs acked": "V2 V4 will add an explicit ack-channel API for true end-to-end delivery confirmation (V2 V4 backlog Tier K1)." Same closure fix.

3. `docs/phase5/v2-v3-exit-packet.md:109` — § "V1 limitations carried forward" item #6 (Queued-vs-acked semantics): "V2 V4 Tier K1 will add an explicit ack-channel API for true end-to-end delivery confirmation." Should be marked **CLOSED** (or moved to a "V2 V3 follow-ons shipped" subsection) with HEAD pointer.

The ide-consumer-contract.md updates (§ 4.1.1 gotcha #3 + § 4.1.3 gotcha #4) and PHASE-4-V2-BACKLOG.md Tier K1 SHIPPED marker are correctly updated — these three sites slipped through.

---

## LOW

### L1 — Writer task's `progress_writer.0.lock()` swallows poisoned-mutex case (CLAUDE.md no-fallback)

File: `crates/ql-collab-ws/src/lib.rs` line 398: `if let Ok(mut counter) = progress_writer.0.lock() {`.

If the progress mutex is poisoned (a prior `flush_pending` panicked between lock + wait — extremely unlikely under current API but possible), the writer task silently skips the counter increment. Subsequent successful writes are not reflected in `progress.0`; flush_pending never reaches its target and times out every 100ms forever (until close).

This is the V2 V3 step 5 megaudit Opus-B M3 pattern that was closed elsewhere via `record_runtime_error` + `PoisonError::into_inner`. Here it's swallowed. The `flush_pending` impl at lines 681-694 handles its own lock poisoning (returns `TransportError::Io`) — the writer-side is the asymmetric leak. Either:
- (a) `record_runtime_error(...poisoned writer counter); closed.store(true); notify_all; return;`
- (b) `match progress_writer.0.lock() { Ok(mut c) => ..., Err(p) => { let mut c = p.into_inner(); *c += 1; progress_writer.1.notify_all(); } }`

(b) is closer to the symmetric recovery used in `last_error` mutex handling. Either way, the silent-skip is a no-fallback violation.

### L2 — `queued_count` SeqCst is conservative but justifiable; not a finding

File: `crates/ql-collab-ws/src/lib.rs` line 609. `Ordering::SeqCst` on a monotonic counter is overkill — `Ordering::Relaxed` is sufficient because flush_pending's read at line 679 is followed by a mutex `lock()` (acquire-release), which provides the happens-before. The mutex is the synchronization point; the atomic just needs to be monotonic. Performance impact is invisible (one ordering instruction per send). Defer to V2 V4+ profiling. Confirmed safe.

### L3 — `multi_thread_runtime()` test helper pins `worker_threads(2)`; real IDE consumers will use more

File: `tests/websocket_transport.rs:55-61`. Two-worker runtime is the minimum to deadlock-prove the helper (one worker hosts the test's `block_on`, the second hosts the writer/reader tasks). A future tokio change that needs N>2 workers would silently flake. Not a current issue. Worth a comment that 2 is intentional-minimum.

---

## Confirmed-safe paths the audit prompt asked about

1. **Condvar protocol correctness (dim 1):** writer increment-then-notify under lock + flush_pending wait_timeout-with-target-check loop is the textbook pattern. No missed-wake bug visible. The TaskExitGuard does NOT notify on panic — that's M2 above.

2. **queued_count vs progress.0 happens-before (dim 2):** SeqCst on the atomic plus the mutex acquire-release on the counter side gives correct ordering. flush_pending observes `queued_count` snapshot at entry (SeqCst load); writer's eventual mutex lock + counter increment is published; subsequent wait_timeout re-acquires and re-reads. Correct.

3. **Drop notify_all unreachable in practice (dim 4):** confirmed. `&mut self` exclusivity on both Drop and flush_pending forbids concurrent access. The Drop's `notify_all` is documented dead code for future shared-ref APIs. Good defensive coding.

4. **close() vs flush_pending interaction (dim 5):** correct. close() is "mark closed for future sends" not "force drain." Consistent with the contract. The docstring at line 537-547 documents the no-drain semantic.

5. **flush_pending on never-attached / detached transport (dim 6):** correct. `session.flush_pending_to_transport()` returns `Ok(())` if no transport. The detach-then-flush boundary is the caller's problem per the contract — acceptable.

6. **Mutex poisoning recovery asymmetry (dim 8):** the `Io`-on-poison reasoning in `flush_pending` docstring (lines 670-677) is defensible — the busy-loop risk from `into_inner()`-recovery is real if the writer panicked mid-counter-increment. Surface as Io + reconnect is the right call. **But the SAME logic should apply to the writer-side lock failure** — see L1. The asymmetry is currently: flush_pending recovers loudly (Io), writer recovers silently (no-op). Should be: both recover loudly.

7. **Reader task closed-flag → notify (dim 3):** **NOT safe** — see M1.

8. **Send semantics (dim 9):** SeqCst conservative; see L2.

9. **Doc-drift sweep (dim 10):** ide-consumer-contract.md correct; PHASE-4-V2-BACKLOG.md correct; three other sites drifted — see M3.

---

## Cross-check with the prompt's debugging story

The audit memo describes the deadlock-on-single-thread-runtime debugging story and asks: "verify the documentation surfaces this caveat clearly enough." Confirmed:

- `Transport::flush_pending` docstring (transport.rs:213-219) has a § "Async-context caveat" naming both `block_in_place` and `spawn_blocking`. Clear.
- `CollabSession::flush_pending_to_transport` (session.rs:763-768) repeats the caveat. Clear.
- ide-consumer-contract.md § 4.1.1 gotcha #3 mentions the blocking-sync nature and `spawn_blocking` / multi-thread runtime. Clear.
- `multi_thread_runtime()` test helper (tests/websocket_transport.rs:46-61) has the most pedagogically-useful docstring of the four — explicitly says "single-threaded runtime would deadlock."

An IDE engineer reading any of these surfaces without the audit transcript will avoid the deadlock. Documentation closure is genuinely good. The one nit: the trait docstring says "Wrap with `tokio::task::block_in_place` (on multi-thread runtimes)..." — block_in_place would be **wrong** on a single-thread runtime (panics in debug). The session-level proxy docstring is more accurate by saying "multi-thread runtime" as a prerequisite. Could tighten the trait-level docstring to match.

---

## Recommendation

Land M1 + M2 + M3 + L1 in a single closure cycle (estimated 30-60 min — all mechanical). M1 and M2 are the same fix shape (clone the Condvar Arc into the reader task + TaskExitGuard). M3 is a 3-file mechanical doc update. L1 is a 2-3 line change to symmetrize poisoning behavior. The result is a clean V2 V4 V1 step 1 ship with no observable behavioral gaps and full doc consistency.

L2 + L3 defer.

If Codex's parallel lane converges on M1 or M2 (the Condvar-notify gaps), prioritize those first — they're the only ones that affect observable timing.
