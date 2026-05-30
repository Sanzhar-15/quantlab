# Phase 6.4B UDF-hardening closure audit (UDF-6-02..04) — SYNTHESIS

**Date:** 2026-05-30 · **Branch:** `feat/quantbook-engine` · **Audited HEAD:** `cce49bc656d`
(UDF-6-03 type matrix + UDF-6-04 security doc) ← `67170a4479f` (FF-2 test fixup) ←
`fee55b8c719` (H + I + FF-2) ← `57bfc434850`/`9b7401253bc` (FF-1).

**The 6.4 phase gate.** Multi-lane: 1 Codex lane (gpt-5.5, `model_reasoning_effort=xhigh`,
read-only) + 3 fresh-context Opus lanes. Scope: FF-1 (callable-name gate), H (op-budget),
I (grid caps), FF-2 (txn diagnostics sink), UDF-6-02 (worker-kill cancel), UDF-6-03 (type
matrix), UDF-6-04 (security doc).

## Verdicts
- **Codex** — SHIP-WITH-FIXES. No HIGH. MED: op-budget not armed on open/rematerialize.
  LOWs: scalar 1×1 `unwrap_or(#CALC!)` no diagnostic; doc §4.3 allocation precision;
  drop() swallows kill/wait errors. INFO: degenerate 3×0/0×0 not in real-worker matrix.
- **Opus-A (doc honesty)** — DOC-IS-HONEST. No overstated bound. MED: §7 omits worker
  *persistence* (long-lived worker → UDF globals/fds/sockets survive across calls/passes).
  LOW: NonFinite citation off-by-one.
- **Opus-B (type matrix)** — TEST-IS-SOUND. No HIGH/MED. Verified the real out-of-process
  round-trip, numpy isinstance across 1.x/2.x, -0.0 bit-exactness isolated from PartialEq.
- **Opus-C (hardening code)** — SHIP-WITH-FIXES. **One HIGH**: arrow `bodyLength` unbounded
  allocation on the decode path. H/UDF-6-02/FF-1/FF-2 all clean.

## The net-new HIGH (the gate earned its keep)

**Lane C found it; Codex missed it.** `decode_grid`'s `MAX_GRID_BYTES` check bounds only the
OUTER buffer (`bytes.len()`). Arrow-ipc-58.3.0 `StreamReader` then reads each IPC message's
worker-controlled `bodyLength` flatbuffer field and does
`MutableBuffer::from_len_zeroed(bodyLength)` (`reader.rs:1835`) — and `buf.resize(meta_len)`
(`reader.rs:~1828`) — BEFORE the `read_exact` that would fail on a short stream, with **no
cap**. A ~256-byte `RETURN` frame declaring `bodyLength = 8 GB` therefore OOMs/aborts the
ENGINE before any engine-side cap fires — breaking the crash-isolation invariant that worker
misbehaviour → leaf cell error, not engine death (design §5). Codex looked at the same path
but assumed the byte cap bounded arrow's allocation (it does not; `bodyLength` is independent
of `bytes.len()`); it surfaced the symptom as a doc-precision LOW only. **Confirmed at the
arrow source** before fixing.

## Dispositions (all applied this cycle)

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | HIGH | arrow `bodyLength`/`meta_len` unbounded alloc on decode | `codec.rs precheck_ipc_message_bounds` — pre-walks IPC framing, rejects any message with `bodyLength`/`meta_len` > cap (or un-parseable) BEFORE `StreamReader`; new `MalformedIpcFraming` variant; +2 adversarial tests (forged bodyLength → `GridTooManyBytes`; forged meta_len) |
| 2 | MED | op-budget armed only in `run_recalc` (not undo/redo `rematerialize` or `open`) | extracted `udf_op_deadline_for_pass()`; armed at all 3 full-pass sites; +1 test (`udf_op_budget_arms_on_undo_redo_rematerialize`) |
| 3 | MED | doc §7 omits worker-process persistence | added "Worker statefulness" §7 row (globals/fds/sockets persist across calls/passes) |
| 4 | LOW | scalar 1×1 `unwrap_or(#CALC!)` silent on invariant break | emit a `udf_protocol` diagnostic in the (unreachable) `None` arm, mirroring the `Err` arm (No-Fallbacks) |
| 5 | LOW | doc §4.3 "caps before allocating" imprecise | rewrote §4.3 to distinguish the 4 allocation layers (frame / arrow-internal precheck / engine cell-vec / encode transient) |
| 6 | LOW | doc §6 NonFinite citation off-by-one | corrected to `codec.rs:538` (also re-checked post-precheck line shift) |
| 7 | LOW | `WorkerProcess::drop` swallows kill/wait errors | **ACCEPTED v1** — `Drop` cannot return `Result`; kill+wait is best-effort and documented; logging from drop is noisy. Filed with the process-group-kill item. |
| 8 | INFO | degenerate 3×0/0×0 not in real-worker matrix (only 0×3) | extended `udf_type_matrix` to round-trip all three zero-area shapes |

## Verification (post-fix, Mac host, python3 + pyarrow + numpy 2.0.2 + pandas)
ql-exec lib **785/0** (default + `--features xlsx-write`); ql-udf **45/0**; udf_type_matrix
4/4 (real numpy+pandas assertions executed); udf_exit_tests 8/8; udf_e2e 1/1; process_smoke
2/2; clippy no-new on touched files; `cargo check --workspace` clean (Send/napi preserved).

## Filed forward (post-v1, not blocking)
OS-level sandbox (seccomp/namespaces/cgroup — needs `libc`/`nix`); process-group/session
kill (orphan grandchildren + the `drop` error-swallow #7); host-configurable op-budget +
per-function deadlines over napi; the MockWorker bypasses the codec so the real-worker
grid-cap path has no E2E integration test (unit + adversarial only).

## Lane outputs
Codex full transcript: `../../../.codex-6-4b-udf-closure-audit.out` (repo-root-relative).
The three Opus lanes ran as fresh-context subagents; their findings are captured in the
disposition table above.
