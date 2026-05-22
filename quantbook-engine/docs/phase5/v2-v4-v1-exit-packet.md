---
title: Phase 5.5 V2 V4 V1 exit packet
date: 2026-05-21
status: ACTIVE — V2 V4 V1 SHIPPED via step 5 close (12/13 Tier items; K4 chunking deferred to V2 V4 V2)
ship_commit_range: 3342e21b964 (V2 V4 V1 step 1 ship) → ca0f9de6ece (V2 V4 V1 step 5 ship + V1 exit packet) → 397676899fb (V2 V4 V1 step 5 audit closure — final V1 commit)
predecessor_exit_packet: docs/phase5/v2-v3-exit-packet.md (V2 V3 V1)
audit_cycle_total: 5 ship + 5 closure = 10 transcripts (steps 1-5)
test_count_at_v4_v1_exit: 4459 / 0 expected (workspace, --test-threads=1)
test_count_delta_from_v2_v3_v1_exit: 4436 → 4459 = +23 net
phase_5_7_readiness: REAFFIRMED — substrate is more complete than at V2 V3 V1; all observability + recovery + discard primitives now ship
---

# Phase 5.5 V2 V4 V1 exit packet

## Summary

V2 V4 V1 closes the high-leverage IDE-consumer-facing gaps + defensive hardening surfaced by the V2 V3 step 5 megaudit. 5 substantive ships across 5 steps, each with parallel Codex+Opus audit + closure. 12/13 Tier items shipped; K4 (chunking) is explicitly architectural and deferred to V2 V4 V2.

## Ship timeline

| Step | Tier | Substance | Ship commit | Closure |
|---|---|---|---|---|
| 1 | K1 | Ack channel — `Transport::flush_pending` + `CollabSession::flush_pending_to_transport` | `3342e21b964` | `ef9e8f2f75c` |
| 2 | I1 | `pending_op_count()` (VV-math after audit closure) | `ff76fc99d49` | `0bd592a4aa8` |
| 3 | J1+J2+J3+K5 | RejectingServer determinism + text-frame test + Send/Sync asserts | `d19fb5ee85d` | `35dc6dcabbd` |
| 4 | K2+K3+K6+K7+K8 | Drop-loss test + EchoServer Mutex doc + Debug field + empty Binary test + poll_remote docstring | `1924d3ed1e1` | `d75dab17f7f` |
| 5 | I2 | `discard_pending_ops` + V2 V4 V1 exit packet | `ca0f9de6ece` | (closure commit follows this exit packet) |

## Final API surface (V2 V4 V1 delta from V2 V3 V1)

### `ql-collab` core (CollabSession)

- **`flush_pending_to_transport(&mut self) -> Result<(), CollabSessionError>`** (step 1). Proxies to `Transport::flush_pending`; blocks until writer task has caught up.
- **`transport_last_error(&self) -> Option<String>`** (V2 V3 step 5, but reaffirmed in V2 V4 V1).
- **`pending_op_count(&self) -> usize`** (step 2). VV-math; strictly monotonic; sibling to `has_pending_flush()`.
- **`discard_pending_ops(&mut self) -> Result<usize, CollabSessionError>`** (step 5). Reverts log to last-flushed checkpoint; preserves session state.

### `ql-collab` trait (`Transport`)

- **`flush_pending(&mut self) -> Result<(), TransportError>`** trait method (default `Ok(())`); `WebSocketTransport` overrides via Arc<(Mutex, Condvar)>.

### `ql-oplog` (OpLog)

- **`fork_at_vv(&self, &VersionVector) -> Result<Self, OpLogError>`** (step 5). Wraps `LoroDoc::vv_to_frontiers` + `LoroDoc::fork_at`.

### `ql-collab-ws` (WebSocketTransport)

- **`assert_impl_all!(WebSocketTransport: Sync)`** (step 3). Pinned via `static_assertions = "=1.1.0"`.
- **`assert_impl_all!(WebSocketError: Send, Sync)`** (step 3, K5 bundled).
- **Debug includes `last_error_present: bool`** (step 4, K6).
- **`RejectingServer` writes complete non-101 HTTP** (step 3, J1) — deterministic `HandshakeFailed`.
- **`TextFrameServer` test fixture** (step 3, J2).
- **`ServerState { closing, tasks }` race-protection helper** (step 4 closure, Codex M1 race fix) — both EchoServer + TextFrameServer use it.

### `ql-oplog` test additions

- `merge_bytes_with_empty_slice_does_not_panic` (step 4, K7).

## Test count progression

| Milestone | Workspace tests | Delta |
|---|---|---|
| V2 V3 V1 exit | 4436 | — |
| V2 V4 V1 step 1 ship | 4442 | +6 (flush_pending tests) |
| V2 V4 V1 step 1 closure | 4442 | 0 (refactor only) |
| V2 V4 V1 step 2 ship | 4448 | +6 (pending_op_count tests) |
| V2 V4 V1 step 2 closure | 4450 | +2 (undo + from_snapshot) |
| V2 V4 V1 step 3 ship | 4451 | +1 (text-frame test) |
| V2 V4 V1 step 3 closure | 4451 | 0 (docs only) |
| V2 V4 V1 step 4 ship | 4453 | +2 (mid-drop + empty-binary) |
| V2 V4 V1 step 4 closure | 4453 | 0 (race-fix refactor) |
| V2 V4 V1 step 5 ship | 4459 expected | +6 (discard tests) |
| **Total V2 V4 V1 delta** | — | **+23 net** |

## Audit cycle summary

10 transcripts at `docs/audits/2026-05-21-phase-5-5-v2-v4-v1-step-N-{codex,opus}.md` (steps 1-5).

| Step | Codex | Opus | Outcome |
|---|---|---|---|
| 1 | PASS-WITH-FINDINGS 0H+1M+3L | PASS-WITH-FINDINGS 0H+3M+1L | Convergent: Condvar notify fan-out. Codex M1: contract/impl divergence. |
| 2 | PASS-WITH-FINDINGS 0H+1M+1L | PASS-WITH-FINDINGS 1H+2M+3L | **CONVERGENT HIGH**: `OpLog::len()` undo path bug. Closure rewrote `pending_op_count` to VV math. |
| 3 | PASS-WITH-FINDINGS 0H+0M+2L | PASS-WITH-FINDINGS 0H+2M+5L+3 procedural | Convergent: stale !Sync doc drift. Discovery: type IS Sync (V2 V3 step 4 docstring was wrong). |
| 4 | PASS-WITH-FINDINGS 0H+1M+2L | PASS-WITH-FINDINGS 0H+1M+4L+1obs | **Codex M1 unique**: multi-thread Drop race in EchoServer. Opus M1: convergent on TextFrameServer mirror. |
| 5 | PASS-WITH-FINDINGS 0H+1M+4L | PASS-WITH-FINDINGS 0H+2M+4L+1obs | Codex M1: `fork_at_vv` panic on invalid VV from external callers (Loro `vv_to_frontiers` internal unwrap); closed via pre-validation + new `OpLogError::InvalidVersionVector` variant. Convergent (Opus M2 + Codex L1): discard is local-only; docs amended. |

**2 HIGH findings closed across the arc** (Opus-A H1 + Opus-A H2 in step 1 from V2 V3 step 5 megaudit; Opus H1 + Codex M1 in step 2 — convergent). All closed in cycle.

## Key audit-discipline learnings extracted to memory

V2 V4 V1 surfaced 4 generalizable patterns now in `memory/quantbook_engine_audit_discipline.md`:

- **Rule 4** (added 2026-05-21 from V2 V4 V1 step 3): negative trait claims (`!Send`, `!Sync`, `!Unpin`) require positive compile proof OR per-field walk. The `!Sync` claim survived 3 audits + 1 megaudit before V2 V4 V1 step 3's attempted assert exposed it.
- (Implicit) Negative arithmetic / saturating_sub: V2 V4 V1 step 2 used `saturating_sub` defensively; audit revealed it was load-bearing TODAY (undo path), not just future-defensive. Generalizes: when you write defensive arithmetic, verify whether it's actually load-bearing.
- (Implicit) Multi-thread vs single-thread reasoning: step 4 K3 closure shipped with a wrong single-thread Drop-race argument; Codex M1 caught the multi-thread interleaving. Default-tokio is multi-thread; reasoning about Drop races MUST consider multi-thread interleaving.
- (Implicit) Single-thread test runtime + sync blocking: step 1 deadlocked on first test run because `flush_pending` blocks the worker. Documented async-context caveat + multi-thread test runtime helper.

## V1 limitations carried forward (deferred to V2 V4 V2)

Only 1 Tier item not closed by V2 V4 V1:

### K4 — Large-blob chunking strategy

- **Source**: V2 V3 step 5 megaudit Opus-A M4 (consumer concern) + Opus-B M1 (defensive).
- **Why deferred**: architectural; pairs with bounded-mpsc replacement of the current unbounded outbound channel. Doesn't fit V2 V4 V1's "cleanup" framing — needs its own design step.
- **Recommended timing**: V2 V4 V2 step 1 (or its own phase), paired with bounded-queue + backpressure policy + chunking.

## Phase 5.7 readiness — REAFFIRMED

The Phase 5.7 IDE vertical slice was unblocked at V2 V3 V1 exit. V2 V4 V1 makes it BETTER:

- **`flush_pending_to_transport()`** — IDE can confirm wire delivery before showing "Saved" UX.
- **`pending_op_count()`** — IDE can show "N changes pending" or implement bounded-queue policies.
- **`discard_pending_ops()`** — IDE can offer "Discard unsynced changes" gesture in window-close dialogs.
- **`transport_last_error()`** — IDE can choose retry strategy based on the runtime error kind.
- **Compile-time Send/Sync proof** — IDE can confidently wrap `WebSocketTransport` in `Arc` for shared cross-thread access if needed.

All 3 main IDE workflows (Synced indicator, reconnect handshake, offline-write recovery) documented in `docs/architecture/ide-consumer-contract.md` § 4.1.1-3 with 5 gotchas covering the V2 V4 V1 additions.

## Forward direction

**Status update (post-V2 V4 V1, 2026-05-22):** Phase 5.7 V1 SHIPPED 2026-05-22 (engine `677ee03ee8b` → `6003db4ce2c` + IDE `1a7fc8bbe3f` → `a517d7c5f71`). First IDE binding via napi-rs cdylib. See `docs/phase5/5-7-v1-exit-packet.md` for the V1 closure record + V2/V3 deferred list. The forward direction below is now post-5.7-V1.

**Next options:**

1. **Phase 5.7 V2 — Transport binding** (~3-5d, recommended). Bind the Transport trait + LoopbackTransport + WebSocketTransport + `attach_transport` / `detach_transport` / `flush_*` / `poll_remote_*` + multi-window demo. See Phase 5.7 V1 megaudit Opus-B for V2 design hazards (async-connect binding shape, sync `flush_pending` blocking V8, full Op enum binding, UndoGroupGuard RAII vs JS Drop, etc.).

2. **Phase 5.5 V2 V4 V2** (~2-3 days). K4 chunking + bounded mpsc + backpressure policy. Architectural cleanup; can run in parallel with 5.7 V2.

3. **Phase 5.7 V3 — Cell grid + persistence** (~1-2wk). Real spreadsheet UI: paste-fill-down, formula UI, `.qbook` open/save, full Op enum binding, undo/redo UI, `rebuild_workbook` wiring (D-3 production-visible). Depends on V2 for collaboration UX.

4. **Phase 5.8 megaudit** (~4-6 days). Now best done after 5.7 V2+ binding so IDE-side state is in scope. Depends on 5.7 V2+ complete.

**Recommendation**: Phase 5.7 V2 (engineering throughput on the user-visible collaboration story; V2 V4 V2 K4 chunking can run in parallel as cleanup).

## Multi-day session totals (post-5.3 → V2 V4 V1)

22 commits + 23 audit transcripts (20 per-step + 3 megaudit):
- V2 V2 ship + closure
- V2 V3 steps 1+2+3+4 ship + closure
- V2 V3 step 5 megaudit closure
- V2 V3 step 6 V1 exit
- V2 V4 V1 steps 1+2+3+4+5 ship + closure (5 pairs)

Net test count: 4367 (post-5.3) → 4459 (V2 V4 V1 exit) = **+92 net**.
