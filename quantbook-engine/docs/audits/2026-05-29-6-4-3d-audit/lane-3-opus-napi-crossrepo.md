# Lane 3 — Opus fresh-context, napi + cross-repo wire contract
Verdict: **SHIP-WITH-FIXES** · HIGH 1 · MED 2 · LOW 2 · 24 tool uses / 71k tokens.
(The IDE side Step 5 is NOT implemented; this lane audits the napi method + verifies the wire contract is
ready for the IDE.) Build clean; Send/Sync asserts compile.

## HIGH — H1: `setUdfWorker` has NO lifecycle gate; injects into Closed/Faulted sessions
`lib.rs setUdfWorker` → `WorkbookSession::set_udf_worker` is a bare field-setter (returns `()`, never
consults `self.state`), unlike every sibling mutator (which calls `ensure_ready()?`). Trigger:
`close(); setUdfWorker(cfg)` spawns a real Python child + attaches it to a terminal session; same for
Faulted; `close()` also doesn't drop the worker (leak). The docstring's advertised `[invalid_state]` is
UNREACHABLE. FIX: a checked `set_udf_worker` (`ensure_ready`, re-check under the lock after spawn) +
clear/shutdown `udf_worker` in `close()`.

## MEDIUM
- M1: `setUdfWorker` is a SYNCHRONOUS napi method (plain `pub fn`, no AsyncTask) → blocks the JS thread
  for up to the handshake timeout (default 5s) during `ensure_started`. On the Electron main thread that
  freezes the UI. FIX: async napi method, or the IDE must call off the main thread.
- M2: `invalid_state`/`session_busy` are emitted by the engine (and advertised by the 6.4-2 fn docstrings)
  but ABSENT from the IDE `QuantbookErrorCode` union + `KNOWN_QUANTBOOK_ERROR_CODE_RECORD` → bucket as
  `unknown`. Pre-existing 6.4-2 gap; the H1 fix makes `[invalid_state]` newly reachable on setUdfWorker.

## LOW
- L1: new worker codes `[worker_spawn_failed]`/`[worker_handshake]` not yet in the IDE allowlist
  (EXPECTED pending Step 5; wire format verified compatible: the IDE parser
  `^\[([a-z][a-z0-9_]*)\]\s*(.*)$` cleanly extracts them — no parser change needed). `worker_untrusted_workspace`
  is IDE-only.
- L2: re-call double-spawn race (out-of-lock spawn; Session is Sync) — benign, the dropped worker is reaped.

## Verified CLEAN
Panic-across-boundary (no unwrap/expect/panic in startup; `handshakeTimeoutMs` guard ordering correct —
`!is_finite()` catches NaN; the `as u64` saturation is defined-behavior, not UB — but NOW capped by the
audit-fix); DTO mapping fidelity (every field maps; Vec<String>→Vec<PathBuf> lossless; Option↔undefined
correct); Send/Sync asserts compile (ProcessWorker: Send via the `Box<dyn UdfWorker + Send>` bound);
replace/reap (old WorkerProcess::drop kills+reaps); CellDiagnostic is engine-only until Step 5 (no napi
event surface bound yet — `pollEvents` is NOT exposed on the Session class, so Step 5 needs it + an IDE
DTO + the diagnostic-code allowlist).
