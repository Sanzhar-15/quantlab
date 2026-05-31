# 6.2-2 audit synthesis (2026-06-01)

**Increment:** Phase 6.2-2 -- bind the 5 remaining "operations/events" `EngineSession`
methods over the `ql-service` hyper service (`startRecalc`/`awaitRecalc` split-recalc +
pre-start cancel window, `cancel`/`operationStatus`, `pollEvents`) AND add the SVC-6-02
long-lived `text/event-stream` events endpoint forwarding the engine event ring. The one
architectural change: the buffered service body (`Response<Full<Bytes>>`) became
`Response<UnsyncBoxBody<Bytes, Infallible>>` so the SSE stream and the ~50 buffered
endpoints share one `handle` return type. Pure transport.

**Method:** parallel 2-lane review per repo discipline -- Codex (default model,
`-c model_reasoning_effort=high`, `-s read-only`, Linux VM) + a fresh Opus lane
(general-purpose agent). Both reviewed only the 6.2-2 changes against the frozen napi
source-of-truth (`ql-bindings-node/src/lib.rs`: EventJson/EventPageJson/OperationStateJson/
OperationErrorJson + converters) + the engine types/impls (`ql-session/src/{operation.rs,
session.rs}`, `ql-exec/src/session.rs`).

## Verdicts

- **Codex: SHIP-WITH-FIXES** -- 0 HIGH, 1 MED, 1 LOW.
- **Opus: SHIP** -- 0 findings.

## The MED (Codex cross-lane catch; Opus missed it) -- FOLDED

**The SSE `poll_events` call bypassed the `guarded` panic boundary** (`router.rs`, the
`events` unfold closure). Every other engine call in the service runs under
`guarded` (catch_unwind -> structured `EngineError`); the SSE poll locked and called
`g.poll_events(...)` directly. A panic there would unwind the per-connection task
instead of yielding the designed final `event: error` frame -- a real gap in the
service's "every engine call is panic-guarded" contract (Opus verified no-lock-across-
await but did not flag the missing guard). **FOLDED:** the locked poll is now wrapped in
`guarded("events", || { ... })` -- a panic becomes a structured Err -> a final SSE error
frame + clean stream end, never an unwound task (parking_lot no-poison + the engine
FaultGuard keep the session usable). The lock is still held only for the poll, never
across the sleep.

## The LOW (Codex) -- FOLDED

**`ops_pre_start_cancel_window` proved `status == canceled` but not that the recompute
was SKIPPED by observable workbook state** -- a broken impl that recomputed yet marked the
op canceled would have passed. **FOLDED:** the test now seeds a stale dependent cell
(A1=6, B1=A1*2 eager 12, A1=7 -> B1 stale 12), cancels in the window, awaits, and asserts
B1 is STILL 12 after `await-recalc` (a real recompute would make it 14) -- the skip is now
observable.

## What both lanes verified clean

- **Wire parity:** EventWire / EventPageWire / OperationStateWire / OperationErrorWire
  match the napi DTOs field-for-field (op/done/total/nextCursor as u64 decimal strings;
  kind-tagged per-variant payloads + `skip_serializing_if None`; `OperationState.failed`
  carries the nested structured error, others omit it). Converters map every `Event` +
  `OperationState` variant; `DiagnosticWire`/`CellAddrWire` reuse correct.
- **Body migration:** every existing response still funnels through the 4 builders
  (`json`/`problem`/`no_content`/`octet_stream`, now `.boxed_unsync()`); the SSE handler
  is the only direct body builder. `boxed_unsync` (Send, !Sync) is correct for hyper's
  per-connection `tokio::spawn` (needs Send, not Sync); `Infallible` holds for both
  buffered and streaming bodies. No bypass missed.
- **SSE handler:** no parking_lot guard held across the `.await`; correct termination
  (session removed -> `?` ends the stream; poll error -> final frame then end); cursor
  advances in order; session resolved at connect (missing -> buffered 404); valid SSE
  framing (`event:`/`id:`/`data:`/blank line; heartbeat comment on an empty page); no
  busy-spin (250ms cadence). Opus additionally ruled out a deadlock between the SSE poll
  loop and a blocking `awaitRecalc` on the same session (single-lock-at-a-time ordering;
  contending paths run on different tasks).
- **Blocking awaitRecalc:** correctness-acceptable for v1 single-client localhost (the
  6.2-1 megaudit deferred `spawn_blocking` to 6.2-3; matches the napi synchronous binding).
- **No-Fallbacks:** `poll-events?cursor=` + `operation-status?op=` are required (loud
  `bad_argument` if missing); the `/events` stream cursor default-0 is a documented
  designed default (stream-from-ring-start), and a non-numeric cursor there is still
  rejected loudly.
- **Test observability:** split-recalc proves a real recompute (B1 stale-12 BEFORE await,
  14 AFTER); SSE test proves the stream actually forwarded `operation_completed` (not just
  connected); negatives assert exact codes/statuses. No wrong-reason asserts.
- **Pure-transport invariant:** ql-exec/ql-session untouched.

## Post-fold verification

- ql-service: 26 wire serde unit tests + 11 integration tests (golden 1 + cluster_a_b 2 +
  cluster_c_d 2 + cluster_e 5 + error_paths 1 + events_ops 5) -- all pass.
- clippy `-p ql-service --all-targets`: 0 ql-service warnings (the ql-storage/ql-oplog/
  ql-exec warnings are pre-existing in those dependency crates).
- build debug + release: 0/0 (`UnsyncBoxBody` compiles in release).
- **ql-exec `--lib` 802/0 (default + `--features xlsx-write`) UNCHANGED** -- pure transport.
- `cargo check --workspace`: clean.

**Final verdict: SHIP (Codex MED + LOW folded; both lanes' clean findings confirmed at source).**
