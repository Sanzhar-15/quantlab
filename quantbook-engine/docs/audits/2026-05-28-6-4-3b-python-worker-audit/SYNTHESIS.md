# Phase 6.4-3b Python-worker audit — SYNTHESIS

**Increment:** the real, process-backed Python UDF worker (commit `2671ade0cfa`): Rust `ProcessWorker`
(`crates/ql-udf/src/process.rs`) + control-frame codecs (`control.rs`) + the completed `UdfError`
taxonomy (`worker.rs`) + the plain-Python worker package (`crates/quantbook-py/python/quantbook/`).
First time the 6.4-3a wire protocol is exercised by a real `pyarrow` process instead of the mock.

**Audited code:** engine `ec39a55c39b`.

**Method:** parallel 2-way — Codex `gpt-5.5`/`xhigh` (`codex exec`, read-only, repo-scoped) + a
fresh-context Opus reviewer (general-purpose agent). Lane outputs preserved alongside (`lane-codex.out`
+ `lane-opus.md`); Codex prompt at `codex-prompt.md`. The auditor independently pre-confirmed two HIGHs
at source (the timeout-defeat frame-flood and the stdout-purity hole) before reconciling.

**Verdicts:** Codex **DO-NOT-SHIP**; Opus **SHIP-WITH-FIXES** — same blocking HIGHs, the usual framing
split. **Reconciled: SHIP-WITH-FIXES** (all fixes bounded within `ql-udf` + the Python worker; no
cross-crate surface).

## The 2-way earned its keep (neither lane alone caught everything)

- **Both lanes, independently:** the `Drop`-join deadlock on inherited stdout (HIGH) and the
  user-`print()` stdout-corruption (HIGH). Two lanes converging is a strong real-defect signal.
- **CODEX-only net-new HIGH:** `log-or-stale-frame-flood-can-defeat-timeout` — Opus rated the same
  channel only LOW (unbounded growth); Codex correctly saw the **timeout-defeat**: `recv_timeout`
  returns a ready frame immediately regardless of `remaining`, so a continuous LOG/stale-frame stream
  means the loop never hits `Err(Timeout)` and the deadline is silently defeated (exit-test-6 violation).
- **CODEX-only MED:** `registry-silently-overwrites-invalid-handles`.
- **OPUS-only MED:** `malformed-call-decode-crashes-loop-no-raise`, `python-encode-grid-accepts-nan-inf`.

## Reconciled findings + disposition

| ID | Codex | Opus | Reconciled | Disposition |
|---|---|---|---|---|
| drop-join-deadlock-on-inherited-stdout | HIGH | HIGH | **HIGH** | FIX — detach reader thread in `Drop` (std-only); keep kill+wait reap; process-group kill filed |
| udf-print-corrupts-protocol-stdout | HIGH | HIGH | **HIGH** | FIX — reserve protocol fd; redirect user stdout→stderr BEFORE importing UDF module |
| frame-flood-defeats-timeout | HIGH | LOW(growth) | **HIGH** | FIX — top-of-loop `Instant::now() >= deadline_at` guard |
| call-deadline-excludes-respawn-handshake-and-write | MED | MED | **MED** | FIX — `deadline_at` at entry; cap handshake recv by remaining; cover CALL write |
| registry-silently-overwrites-invalid-handles | MED | (missed) | **MED** | FIX — validate `callable`, `0<=handle<2**64`, reject duplicate |
| malformed-call-decode-crashes-loop-no-raise | (missed) | MED | **MED** | FIX — decode header first, grid inside try → RAISE w/ call_id |
| python-encode-grid-accepts-nan-inf | (missed) | MED | **MED** | FIX — reject non-finite in Python encode → clean RAISE |
| python-decode-grid-no-validation | (missed) | LOW | **LOW** | FIX — column-count check; subsumed by decode-in-try → comprehensible RAISE |
| log-mpsc-unbounded-growth | (in HIGH) | LOW | **LOW** | PARTIAL — deadline guard bounds in-call growth; full bound (sync_channel) filed for 6.4-3c |
| drop-child-wait-unbounded | (missed) | LOW | **LOW** | DOC — `D`-state SIGKILL caveat; std has no clean bounded wait |
| respawn-pid-reuse-flaky-assert | (missed) | LOW | **LOW** | FIX — rest respawn proof on a fresh successful CALL, soften pid-inequality |
| hello-ack-broken-pipe | (missed) | INFO | **INFO** | FIX(cheap) — treat protocol-write `BrokenPipeError` as clean exit |
| log-frame-asymmetry-unreachable | (missed) | INFO | **INFO** | NOTE — LOG emit is 6.4-3c; receive path now timeout-safe |

## CLEAN areas (both lanes concur)
Wire-byte symmetry Rust↔Python — frame envelope (`total_len=1+payload`, LE, type tags 1–7, 64 MiB cap,
torn/zero/oversized), CALL/RETURN `u64`-LE headers, HELLO/HELLO_ACK/RAISE layouts, and the 5-column grid
schema (names/types/nullability/order + `rows`/`cols` metadata + bool-before-int) all match byte-for-byte.
Rust decode paths avoid panics on malformed worker-controlled frames (6.4-3a hardening holds). Handshake-
failure paths reap the direct child (the local `wp` drops in `spawn`). The `remaining`/`deadline_at` math
across `continue`s is itself correct (the defect is that a ready frame bypasses the timeout, not the math).

## Filed for later (non-blocking)
- **6.4-3c:** process-group/session kill (needs a `libc`/`nix` dep — out of the std-only 3b budget) to
  kill grandchildren so the pipe closes (the detach fix prevents the hang but can leak a blocked reader
  thread + fd if a UDF orphans a child); full bounded-channel/backpressure for the reader; `LOG` emit
  path in the Python worker + a real LOG round-trip test; `LOG`→`CellDiagnostic` routing.
- **Perf backlog:** none new.
