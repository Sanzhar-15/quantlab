# Adversarial audit — Quantbook Phase 6.4-3b (real Python UDF worker)

You are auditing a SHIPPED code increment for correctness, soundness, robustness, and
contract-fidelity. This is a **cycle-1 adversarial audit** of code that already compiles and
passes its tests (`cargo test -p ql-udf` 39 unit + 1 real-python integration; clippy clean;
`python3 -m quantbook._self_test` PASS). Your job is to find what the author missed. Be
skeptical. Default to flagging anything you cannot prove safe from source. **A clean "looks
good" is a FAILED audit if defects exist** — assume defects exist.

## Repo / scope

- Repo root: this directory (`quantbook-engine`), branch `feat/quantbook-engine`, HEAD `ec39a55c39b`.
- Read-only. Do not modify files. Produce findings only.
- **In scope (the 6.4-3b increment — commit `2671ade0cfa`):**
  - `crates/ql-udf/src/process.rs` (NEW — the `ProcessWorker`: spawn / handshake / reader
    thread / `call()` with deadline / timeout-kill / respawn / `Drop`). **This is the highest-risk file.**
  - `crates/ql-udf/src/control.rs` (NEW — HELLO/HELLO_ACK/RAISE/LOG/CANCEL payload codecs).
  - `crates/ql-udf/src/worker.rs` (the `UdfError` taxonomy — gained `Cancelled`/`Handshake`/`Protocol` this cycle).
  - `crates/ql-udf/src/lib.rs` (module wiring + re-exports).
  - `crates/ql-udf/tests/process_smoke.rs` (NEW — real-python end-to-end smoke).
  - `crates/quantbook-py/python/quantbook/` — the Python worker package (ALL files):
    `_frame.py`, `_codec.py`, `worker.py`, `__init__.py`, `_registry.py`, `_smoke_udfs.py`, `_self_test.py`.
- **Context (read for symmetry, but 6.4-3a-audited already — flag only NEW issues or 3b regressions):**
  `crates/ql-udf/src/codec.rs`, `crates/ql-udf/src/frame.rs`, `crates/ql-udf/src/payload.rs`.

## What this increment does

The engine drives an out-of-process Python worker over stdio using the wire protocol pinned in
6.4-3a (frame envelope `[u32 LE len][u8 type][payload]`; CALL/RETURN data payloads; an
`ArrayValue`⇄Arrow-IPC 5-column tagged-grid codec). 6.4-3b adds:
- the control-frame codecs (HELLO/HELLO_ACK handshake; RAISE; LOG; CANCEL),
- `ProcessWorker` (Rust): spawns `python -m quantbook.worker`, does a HELLO/HELLO_ACK handshake,
  sends one CALL per UDF invocation, reads RETURN/RAISE/LOG on a per-worker reader thread via an
  mpsc channel, enforces a per-call `deadline` via `recv_timeout`, and on a deadline breach or any
  transport break KILLS + reaps the child (hard cancel) and lazily respawns on the next call,
- the Python worker (plain Python 3.9-compatible, NO PyO3 in the hot path): a stdin→stdout frame
  loop that mirrors the Rust codec/frame/control encodings in `pyarrow`, dispatches CALL by handle
  to a registered Python callable, and turns any UDF exception into a RAISE.

Design doc: `docs/phase6/6-4-3-design.md` (esp. §2 architecture, §3 protocol, §5 worker
lifecycle/kill, §6 cancellation). Contract exit tests of interest: §10.4 test 6 (a late RETURN
after a deadline-kill must be DROPPED — never committed) and test 7 (a raise surfaces a diagnostic).

## Project rules that are FINDINGS if violated (from CLAUDE.md)

- **No-Fallbacks — errors must be visible.** No swallowed errors, no `|| default`, no silent
  retries, no `except: pass`, no graceful-degradation that hides the real failure. Every failure
  must surface loudly as a typed error. Flag any place a real error is masked, defaulted, or dropped.
- No panic reachable from worker-controlled bytes (the decode side is a trust boundary).

## Focus areas (the author's own hand-off — audit these HARD, but do NOT limit yourself to them)

1. **Reader-thread ↔ kill race + zombie reaping.** `ProcessWorker::call` on timeout calls
   `kill_worker()` → sets `self.proc = None` → `WorkerProcess::drop` does `child.kill()` +
   `child.wait()` + `reader.join()`. Is the join guaranteed to terminate (no deadlock / no hang)?
   Can the reader thread block forever on `read_frame` if the child is killed but a grandchild or
   a dup'd stdout fd keeps the pipe write-end open? Is the child always reaped (no zombies) on every
   exit path — timeout, transport error, handshake failure, `Drop`, `shutdown()`, normal completion?
   Is there a window where `kill()` then `wait()` races the reader's own read?
2. **Respawn + deadline accounting.** `call()` runs `ensure_started()` (spawn + handshake, bounded
   only by `handshake_timeout`, default 5s) and THEN starts the `deadline` clock for `recv_timeout`.
   Does a call with a short `deadline` that triggers a respawn actually honor that deadline, or can
   it block for up to `handshake_timeout + deadline`? Does the deadline cover CALL-write time? Is
   `deadline_at` computed correctly across LOG frames and stale-call_id skips (each `continue`
   recomputes `remaining` from the absolute `deadline_at` — verify no drift / no negative / no
   accidental infinite wait)? What if `deadline` is zero?
3. **Control-frame codec symmetry Rust↔Python.** Byte-for-byte compare `control.rs` ⇄ `_codec.py`
   (HELLO, HELLO_ACK, RAISE) and `frame.rs` ⇄ `_frame.py` (envelope, FrameType ints, MAX_FRAME_LEN,
   torn/zero/oversized handling) and `codec.rs`/`payload.rs` ⇄ `_codec.py` (grid schema field
   names/types/nullability/order, rows/cols metadata, CALL/RETURN u64-LE headers, endianness, the
   bool-before-int ordering in Python encode). Any asymmetry (a field the Python side omits, a
   length the two disagree on, an integer width/endianness mismatch, NaN/Inf handling divergence)
   is a HIGH — it means a real worker desyncs the stream.
4. **LOG → eprintln stopgap.** `call()` prints LOG frames via `eprintln!` and `continue`s. Is that
   a No-Fallbacks violation (is anything being swallowed)? Does it interact badly with the deadline
   (a flood of LOG frames resetting nothing / spinning)? (6.4-3c routes these to CellDiagnostics —
   judge whether the stopgap is acceptable, not whether the final design is done.)
5. **Worker stdout-purity.** `worker.py` writes protocol frames to `sys.stdout.buffer`. Is there
   ANYTHING that can write stray bytes to that same fd and corrupt the frame stream — a `print()`
   in user UDF code, a library writing to stdout, Python's own startup chatter, buffering? Is stdin
   read as raw bytes (`sys.stdin.buffer`) with no text-mode/`universal newlines` corruption? On
   Windows would stdio need binary mode (note if relevant, but host is macOS/Linux)?
6. **Handshake-version-mismatch path.** Trace the full handshake: engine writes HELLO, worker
   replies HELLO_ACK. What happens on: wrong protocol version (→ `Handshake`?), a non-HELLO_ACK
   first frame, the worker dying mid-handshake, the worker hanging (handshake_timeout), the worker
   importing a failing `QUANTBOOK_UDF_MODULE` before it ever reads HELLO? Is the child reaped on
   each of these? Does the engine ever leak a zombie/handle on a failed handshake?

## Also consider (open-ended — this list is NOT exhaustive; think adversarially)

- The Python worker's CALL handling: `decode_call(payload)` runs BEFORE the `try/except`. What
  happens if the engine sends a malformed CALL (bad grid bytes)? Does the worker crash the loop
  (no RAISE, no call_id) → engine sees EOF? Is that acceptable or a robustness defect?
- Python `_codec.encode_grid`: does it reject non-finite numbers? If a UDF returns `float('nan')`/
  `inf`, what does the engine see (the Rust decoder rejects non-finite — does the user get a
  comprehensible error or a cryptic codec error)? Large Python `int` → `float()` overflow to `inf`?
- Python `decode_grid` does NOT validate the schema (unlike the hardened Rust decoder) — positional
  `batch.column(0..4)`. Is the engine a sufficiently-trusted producer to justify the asymmetry, or
  is this a latent crash (IndexError on a short column set) that takes down the worker loop?
- `next_call_id` is consumed before `ensure_started()` — gaps on spawn failure (harmless?). Wrapping
  at u64::MAX (`wrapping_add`) — any correlation hazard?
- mpsc channel growth: the reader thread sends every frame; if `call()` is slow to drain (or a flood
  of LOG frames), does the unbounded channel grow without bound?
- Pipe-buffer deadlock: a very large CALL frame (> OS pipe buffer) written by `call()` while the
  worker simultaneously writes a large RETURN — can both block? Single-in-flight mitigates, but
  verify the ordering (worker reads the whole CALL before writing RETURN).
- `Drop` ordering of `WorkerProcess` fields vs the explicit `Drop::drop` (does `rx` drop before the
  join, breaking the reader's `tx.send`? Is that benign?).
- The `_self_test.py` and `process_smoke.rs`: do their assertions actually prove what they claim, or
  are any of them vacuous (e.g. asserting a round-trip that can't fail, or a timeout test that
  doesn't prove the child was killed / a new pid was spawned)? Test-honesty matters.
- `_smoke_udfs.py` fixture: does it exercise the claimed handles (double / raise / sleep-timeout)?
- Any `unwrap`/`expect`/`panic!`/array-index/slice that a worker (or a malformed frame) can reach.
- `__init__.py` `register_formula_function`: handle collisions, re-registration, int coercion.
- Cross-platform: `child.kill()` semantics, `SIGKILL` vs graceful, signal handling in the Python
  worker (does it ignore SIGPIPE / SIGINT correctly?).

## Output format (STRICT)

Start with one line: `VERDICT: SHIP-WITH-FIXES` or `VERDICT: DO-NOT-SHIP` or `VERDICT: SHIP-CLEAN`.

Then a findings list. For EACH finding:
- `ID:` a short kebab-case slug.
- `SEVERITY:` HIGH | MED | LOW | INFO.
- `LOCATION:` file:line(s).
- `WHAT:` the defect, concretely.
- `WHY:` the consequence (what breaks, under what input/timing). Cite the rule/contract if relevant.
- `FIX:` the concrete change you'd make.

Be specific and cite line numbers. If you believe the increment is genuinely clean on a focus area,
say so explicitly per-area (don't omit it). Prioritize: a real HIGH that desyncs the protocol, hangs
the engine, leaks a zombie, drops an error silently, or violates exit test 6 is worth more than ten
style nits. Think hard about timing/races/process-lifecycle — that is where this increment is riskiest.
