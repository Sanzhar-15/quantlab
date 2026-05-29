# Adversarial audit — Quantbook Phase 6.4-3d Step 5 (cross-repo)

You are a skeptical senior reviewer. Find real defects. Be adversarial; prefer DO-NOT-SHIP if any HIGH is real. Output: a verdict (DO-NOT-SHIP / SHIP-WITH-FIXES / SHIP), then findings ranked HIGH/MED/LOW, each with file:line, the concrete failure scenario, and a fix. Do not rubber-stamp.

## What shipped (two commits, two repos)

Phase 6.4-3d Step 5 wires the IDE side of Python-UDF worker injection, plus an engine prerequisite.

- ENGINE commit `1e182a2fad3` on `feat/quantbook-engine`, repo `quantlab-quantbook/quantbook-engine`:
  - `crates/ql-bindings-node/src/lib.rs`: new napi `Session.pollEvents(cursor: BigInt) -> EventPageJson` + faithful `#[napi(object)]` DTOs `CellAddrJson`/`DiagnosticJson`/`OperationStateJson`/`EventJson`/`EventPageJson` + mappers `severity_to_str`/`*_from_session`. Also rewrote the pre-existing `handshakeTimeoutMs` range check to `!(0.0..=MAX).contains(&ms)` (clippy).
  - `crates/quantbook-py/python/quantbook/worker.py`: `main()` rewritten to survive a host that gives the child no usable stderr (`sys.stderr is None`) — the embedded node/electron host does exactly this, and the prior `os.dup2(sys.stderr.fileno(), 1)` crashed on `None.fileno()` so the worker exited before HELLO_ACK and every UDF call failed with `#CALC!`.
  - new node smoke `crates/ql-bindings-node/tests/smoke_udf_pollevents.mjs`.
- IDE commit `9d5ca7b75fa` on `feat/visualise-v1`, repo `quantlab/extensions/quantlab`:
  - `src/quantbook/types.ts`: `PythonWorkerConfigJson` + `setUdfWorker`/`pollEvents` on `SessionInstance` + Event/Diagnostic/CellAddr/OperationState/EventPage TS types + 5 new `QuantbookErrorCode` members + `diagnostic?` on the cell-snapshot entry.
  - `src/quantbook/session.ts`: same 5 codes in the compile-enforced `KNOWN_QUANTBOOK_ERROR_CODE_RECORD`.
  - `src/quantbook/loader.ts`: `setUdfWorker`/`pollEvents` added to the `Session.prototype` shape check.
  - `src/quantbook/udfWorker.ts` (NEW): `planUdfWorkerConfig` (pure: trust gate -> `[worker_untrusted_workspace]`; interpreter via the `quantlab.pythonPath` cascade, verified >=3.9 -> `[worker_spawn_failed]`) + `injectUdfWorker` (async; lazy vscode/TrustManager imports; yields before the SYNCHRONOUS blocking `setUdfWorker`).
  - `src/quantbook/cellGrid/cellGridLogic.ts`: `buildCellDiagnosticMessages` + `attachCellDiagnostics`.
  - `src/quantbook/cellGrid/cellGridHtml.ts`: `renderRows` adds an `escapeHtml`'d `title=` tooltip.

## Inputs
- Engine diff: `quantlab-quantbook/quantbook-engine/docs/audits/2026-05-29-6-4-3d-step5-audit/engine-delta.diff`
- IDE diff: `quantlab-quantbook/quantbook-engine/docs/audits/2026-05-29-6-4-3d-step5-audit/ide-delta.diff`
- Read the actual source files for full context (paths above). The engine `Event`/`Diagnostic`/`EventPage` defs are in `quantlab-quantbook/quantbook-engine/crates/ql-session/src/{session.rs,dto.rs}`; the napi `setUdfWorker` + error helpers are in `crates/ql-bindings-node/src/lib.rs`.

## Focus (find concrete bugs, not style)
ENGINE:
1. `EventJson` DTO fidelity: is EVERY `Event` variant mapped with the right payload fields? Any field dropped/mislabeled? `op`/`done`/`total` BigInt conversions correct? `next_cursor`/`structureKind` napi camelCase correct?
2. `pollEvents` cursor: BigInt->u64 negative/lossy rejection sound? Does claiming "no lifecycle gate" match the engine `WorkbookSession::poll_events`? Is `&self` + `lock()` + `&mut`-method call sound (Send/Sync)?
3. `worker.py` `main()`: is the new fd dance correct on BOTH paths (valid stderr AND `sys.stderr is None`)? Does it still reserve the protocol channel as fd 1 (`os.dup(1)`)? Any fd LEAK (proto_fd / sink_fd / the dup'd sys.stdout)? Does it preserve the 6.4-3b invariant (user stdout never corrupts the protocol stream)? Does it regress the cargo path where stderr is valid? Edge: what if `sys.stdout` is also None, or fd 1 itself is closed?

IDE:
4. Error-code parity: union (types.ts) vs the Record (session.ts) — exactly the 5 codes, no typo, no missing? `parseQuantbookError` recognizes them?
5. Trust gate: can `planUdfWorkerConfig` ever spawn / run the version subprocess when untrusted? Is the `versionCheck` truly lazy? Does `injectUdfWorker` resolve python BEFORE or AFTER the trust check, and does that matter (any I/O before the gate)?
6. Diagnostic rendering: `renderRows` `title=` — XSS-safe (escapeHtml)? Does `attachCellDiagnostics` correctly DROP stale diagnostics for recovered (non-error) cells? `buildCellDiagnosticMessages` last-wins + sheet-filter correct? Any case where a stale `udf_no_worker` tooltip shows on a cell that now has a real value?
7. The lazy `await import('vscode')` / `await import('../core/trust/TrustManager')` in `injectUdfWorker` — correct at runtime in the extension host? Any type/runtime mismatch?
8. Cross-repo wire: do the IDE EventJson field names match the napi-rs camelCase output of the engine DTOs? Do the 5 IDE error codes match what the engine actually emits (`udf_spawn_error_to_napi` emits `worker_spawn_failed`/`worker_handshake`; `invalid_state`/`session_busy` from `set_udf_worker_checked`)? Is `worker_untrusted_workspace` correctly IDE-only?

Report now.
