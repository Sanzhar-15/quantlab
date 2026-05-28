# 6.4-3b Python worker audit — OPUS LANE (fresh-context general-purpose agent)

Engine HEAD `ec39a55c39b`. Scope: `crates/ql-udf/src/{process,control,worker,lib}.rs`,
`crates/ql-udf/tests/process_smoke.rs`, and the full `crates/quantbook-py/python/quantbook/`
worker package. Context (6.4-3a-audited): `codec.rs`/`frame.rs`/`payload.rs`.

**Verdict: SHIP-WITH-FIXES.**

## HIGH

### `reader-join-deadlock-on-grandchild-stdout`
`process.rs:108-121` (`WorkerProcess::drop`), comment `:116-118`. `Drop` does `child.kill()` +
`child.wait()` + `reader.join()`; the comment claims the join "does not block." FALSE when a UDF
spawns a grandchild (`subprocess`, `multiprocessing`, any forking lib) that inherits the stdout
write-end: `child.wait()` reaps the direct child, but the pipe write-end stays open in the
grandchild, so the reader's `read_frame` blocks forever and `reader.join()` **deadlocks the engine
thread** on the hard-cancel path (timeout / transport error / `shutdown()` / `Drop`). The entire
exit-test-6 path runs through this. **FIX:** don't unconditionally join after kill — detach the
reader thread (drop the `JoinHandle`); and/or spawn in its own process group and kill the group;
and/or bound the join with a timeout.

### `worker-stdout-not-isolated-from-user-prints`
`worker.py:66-67` (`main` passes `sys.stdout.buffer` as protocol channel); docstring `:3-6`. No
enforcement of the "never print to stdout" rule. Any `print()` in user UDF code, a library writing
to stdout, or interpreter startup chatter injects raw bytes into the frame stream → the Rust reader
reads them as a `[u32 len][type]` header → garbage length / desync → `WorkerDied`. A stray `print()`
is overwhelmingly common. **FIX:** at startup, `proto_fd = os.dup(stdout.fileno())`; `os.dup2(stderr,
stdout)`; `sys.stdout = sys.stderr`; pass the dup'd `proto` fd (not `sys.stdout.buffer`) to `run()`.

## MED

### `malformed-call-decode-crashes-loop-no-raise`
`worker.py:45-46` — `decode_call(payload)` is OUTSIDE the `try/except` at `:47`. A malformed grid in
a CALL raises out of `run()` and kills the loop with **no RAISE and no `call_id`**; the engine sees
EOF → `WorkerDied("worker exited mid-call")`, the real codec error lost. Violates "ANY UDF failure
becomes a RAISE, never crashes the loop" + No-Fallbacks. **FIX:** decode the fixed 16-byte header
first, then decode the grid INSIDE `try` so a grid-decode failure is a RAISE correlated to `call_id`.

### `python-encode-grid-accepts-nan-inf-cryptic-engine-error`
`_codec.py:109-110`. Python `encode_grid` accepts `float('nan')`/`inf` and serializes them as
numbers; the Rust decoder rejects them as `NonFinite` → engine surfaces a cryptic `UdfError::Codec`
for a UDF that *ran fine* and merely returned a non-finite number. **FIX:** in the numeric branch,
`if not math.isfinite(v): raise ValueError("UDF returned a non-finite number: %r" % v)` — becomes a
clean RAISE (it runs inside the CALL try/except).

### `respawn-handshake-not-counted-against-deadline`
`process.rs:288` (`ensure_started()?`) then `:308` (`deadline_at = now + deadline`). `call()` runs
spawn + handshake (bounded only by `handshake_timeout`, default 5s) BEFORE starting the deadline
clock; a short-deadline call that triggers a respawn can block up to `handshake_timeout + deadline`.
Trait contract says the call is subject to `deadline`. **FIX:** compute `deadline_at` at call entry;
cap the handshake `recv_timeout` by the remaining budget; cover the CALL write.

## LOW

- `drop-child-wait-unbounded` — `process.rs:114` `child.wait()` is unbounded; a child in `D`
  (uninterruptible I/O) state doesn't die on SIGKILL until it leaves `D`. Rare; document the caveat.
- `log-mpsc-unbounded-growth` — `process.rs:200` unbounded channel; a chatty worker emitting frames
  faster than `call()` drains (and nobody drains between calls) grows memory unbounded. Bounded
  `sync_channel` or drain policy.
- `python-decode-grid-no-validation-positional-access` — `_codec.py:163-184`. Unlike the hardened
  Rust decoder, Python `decode_grid` does no schema/shape validation; a short-column grid → IndexError
  crashes the loop (ties to the malformed-CALL finding). Minimal column-count check + raise.
- `respawn-pid-reuse-flaky-assert` — `process_smoke.rs:117-121` relies on a different pid after
  respawn; PID reuse (unlikely) would spuriously fail. The successful fresh CALL after respawn is the
  load-bearing proof; soften the `assert_ne`.

## INFO

- `log-frame-asymmetry-unreachable` — Rust has `encode_log`/`decode_log` + a LOG receive path in
  `call()`, but the Python worker has no `encode_log` and never emits LOG → the LOG path is currently
  unreachable from the real worker (dead-until-6.4-3c). Focus-area-4 review is otherwise vacuous.
- `hello-ack-broken-pipe-uncaught-during-handshake` — `worker.py:42-44`; if the engine dies mid-
  handshake the worker's HELLO_ACK write raises `BrokenPipeError` (uncaught → traceback to stderr).
  Cosmetic; optionally treat a protocol-write `BrokenPipeError` as a clean exit.

## Per-focus-area disposition
1. Reader/kill/reaping — reaping correct on ALL paths; but `reader.join()` after kill is NOT
   guaranteed to terminate (grandchild) → HIGH; plus `wait()` unbounded (LOW).
2. Respawn + deadline — the `remaining` math across LOG/stale `continue`s is correct (absolute
   deadline, no drift/negative, `ZERO` returns immediately); but spawn+handshake precede the deadline
   clock → MED.
3. Codec symmetry — CLEAN on the wire bytes (HELLO/HELLO_ACK/RAISE/frame/grid all byte-for-byte). Only
   non-desyncing asymmetries: Python lacks `encode_log`/`decode_cancel` (INFO); NaN/Inf divergence (MED).
4. LOG→eprintln — essentially clean/INFO (surfaced not swallowed; deadline survives a flood) BUT path
   currently unreachable; unbounded channel (LOW).
5. Worker stdout-purity — HIGH (no isolation). stdin is raw `sys.stdin.buffer` (correct).
6. Handshake-mismatch — mostly clean (wrong version→Handshake; non-ack→Protocol; die→WorkerDied;
   hang→handshake_timeout; child reaped on each). Failing `QUANTBOOK_UDF_MODULE` import → process exits
   → WorkerDied (loud, acceptable). Related: deadline MED + broken-pipe INFO.

Net: solid codec symmetry + reaping-on-failure + loud-error discipline, but two HIGHs bite real
(non-hostile) usage — a UDF that prints corrupts the session; a UDF that leaves a child turns a
deadline kill into an engine hang.
