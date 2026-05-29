# Phase 6.4-3d Step 5 — 3-way audit SYNTHESIS

**Date:** 2026-05-29. **Audited:** engine commit `1e182a2fad3` (`feat/quantbook-engine`) +
IDE commit `9d5ca7b75fa` (`feat/visualise-v1`). Code-then-audit per the 6.4-3a/b/c precedent.
Diffs: `engine-delta.diff`, `ide-delta.diff`. Codex prompt + raw lane: `codex-prompt.md`, `lane-codex.out`.

## Lanes

| Lane | Reviewer | Focus | Verdict |
|------|----------|-------|---------|
| 1 | Codex (default model, reasoning xhigh) | full delta, adversarial | DO-NOT-SHIP (1 HIGH + 2 MED + 1 LOW) |
| 2 | Opus, fresh-context | engine-internal (pollEvents DTOs + worker.py) | SHIP (0H/0M, 3 LOW) |
| 3 | Opus, fresh-context | cross-repo / IDE | SHIP-WITH-FIXES (1 HIGH + 3 MED + 2 LOW) |

**The discipline earned its keep:** Codex caught a net-new security HIGH (the trust gate ignored VS Code
Restricted Mode) that NEITHER Opus lane found; Opus-IDE caught a HIGH (client-side repaint drops the
tooltip) that Codex framed only as "not wired". Both engine lanes rated the pollEvents DTOs + Send/Sync
CLEAN. (`gpt-5.5-codex` is unavailable on this ChatGPT account; ran the account default at xhigh.)

---

## HIGH findings — both FIXED

### HIGH-1 (Codex) — trust gate ignored VS Code Restricted Mode
`injectUdfWorker` gated only on QuantLab's own `TrustManager.isWorkspaceTrusted`, NOT
`vscode.workspace.isTrusted`. A workspace trusted in QuantLab's store but opened in VS Code Restricted
Mode (where extensions must not execute workspace code) could still spawn arbitrary workspace Python.
**FIX (`udfWorker.ts`):** require BOTH `vscode.workspace.isTrusted` AND `TrustManager.isWorkspaceTrusted`,
gate FIRST and resolve the interpreter (any fs probing) ONLY when trusted.

### HIGH-2 (Opus-IDE) — client-side `renderRowsClient` dropped the `title=` tooltip on scroll
The server `renderRows` emits the diagnostic `title=`, but the webview's virtualization mirror
`renderRowsClient` (which overwrites `tbody.innerHTML` on every scroll) did not — so the tooltip would
vanish on the first scroll. **FIX (`cellGridHtml.ts`):** mirror the `titleAttr` (htmlEscape-safe) into
`renderRowsClient`. Test added asserting both server + client render carry it.

---

## MED — dispositions

- **MED (Codex): diagnostic path not wired into the live `cellGridPanel`.** EXPECTED — this is the
  user-approved Option-A scope for Step 5 (contract + helper + renderer surface; the live panel still
  runs on `CollabSession`). The live panel→owning-Session migration + a `pollEvents` loop is **filed
  forward** as its own increment. Not a defect.
- **MED (Opus-IDE): `QUANTBOOK_ENGINE_PATH` override breaks `resolveQuantbookPyDir` + misleading doc.**
  **FIX:** added an explicit `QUANTBOOK_PY_DIR` env override (wins verbatim) + honest doc stating the
  derivation requires the canonical layout. Tests added (override + canonical-layout derivation).
- **MED (Opus-IDE): `resolveQuantbookPyDir` untested.** **FIX:** 2 tests added.
- **MED (Codex / Opus-IDE stale concern): `attachCellDiagnostics` could keep a stale tooltip on a
  re-attached/recovered cell.** Correct for the intended fresh-snapshot input, but not idempotent.
  **FIX (`cellGridLogic.ts`):** rebuilt to STRIP any pre-existing `diagnostic` and re-add only the
  CURRENT message on a CURRENT error cell — idempotent + reattachment-safe. Tests added (strip +
  idempotency).
- **MED (Opus-IDE): `injectUdfWorker` "yield then call" does not actually take the blocking call off
  the host thread; doc was half-honest.** Per the user-locked decision (keep the engine method sync),
  this is **doc-only**: the docstring now bluntly states it BLOCKS the extension host up to
  `handshakeTimeoutMs`, that there is no worker-thread offload, and that the real mitigation is the
  filed-forward async-napi `AsyncTask`.

## LOW — dispositions

- **LOW (Codex): worker.py `main()` didn't handle a non-`None` BROKEN stderr; fd 2 left closed.**
  **PARTIALLY FIXED + a trap caught:** the `diag` reassignment now fires on `opened_devnull` (covers
  both `None` and broken-non-`None` stderr → routes the worker's own diagnostics to the sink). Codex
  also suggested `os.dup2(sink_fd, 2)` — **this was tried and REVERTED**: when the host left fd 2 closed
  (the very case that makes `sys.stderr` None), the earlier `proto_fd = os.dup(1)` REUSES fd 2 as the
  protocol channel, so repointing fd 2 clobbers the protocol pipe and the worker exits before HELLO_ACK
  (caught by re-running the node smoke). fd 2 is deliberately left as-is; the worker never writes to a
  raw fd 2.
- **LOW (Opus-engine): pyarrow import precedes the fd-1 redirect** (pre-existing 6.4-3b; smoke-clean on
  macOS). **FILED FORWARD.**
- **LOW (Opus-engine): `sys.stdin` not guarded like stdout/stderr** (unreachable via `ProcessWorker`,
  which always pipes fd 0). **FILED FORWARD.**
- **LOW (Opus-engine): `run(stdin, stdout, stderr)` params are really `proto`/`diag`** (cosmetic).
  **FILED FORWARD.**
- **LOW (Opus-IDE): `injectUdfWorker` never `recalcAll()`s** (by design; doc tells the caller to).
  **FILED FORWARD** to the live-wiring increment.
- **LOW (Opus-IDE): `buildCellDiagnosticMessages` O(events) if a live loop re-reads from `0n`** — the
  live loop must poll incrementally with `nextCursor`. **FILED FORWARD** (noted in the EventPageJson doc).

## Verified CLEAN (no finding) by the lanes
Engine `EventJson` variant coverage (all 6 variants, correct payloads, lossless BigInt), `nextCursor`/
`structureKind` napi camelCase, cursor BigInt→u64 rejection, the "no lifecycle gate" doc claim,
Send/Sync, the `!(0.0..=MAX).contains(&ms)` clippy rewrite (behavior-identical incl. NaN/Inf), the
5-code union↔Record parity (compile-enforced), lazy `await import` correctness, the worker.py valid-stderr
(cargo) path, fd discipline (no leak) on the kept paths, diagnostic XSS-safety (escapeHtml), the 16 (now
22) tests pinning their claims.

## Audit-fix verification (all green)
- Engine: `python3 -m py_compile worker.py` OK; `quantbook._self_test` PASS; `cargo test -p ql-udf
  --test process_smoke` 2/2; node `smoke_udf_pollevents.mjs` ALL pass (pollEvents diagnostic + spawn-fail
  + real-python `=MYUDF(A1)`→42 via the no-stderr path).
- IDE: hygiene clean; `tsc --noEmit` exit 0; mocha `quantbook*` **464 passing** (was 458; +6 audit-fix
  tests).

## Files changed (audit-fix)
- Engine `1e182a2fad3` follow-up: `crates/quantbook-py/python/quantbook/worker.py` (diag reassignment on
  `opened_devnull`; removed the fd-2 clobber).
- IDE `9d5ca7b75fa` follow-up: `src/quantbook/udfWorker.ts` (double trust gate + gate-before-resolve +
  `QUANTBOOK_PY_DIR` override + honest docs), `src/quantbook/cellGrid/cellGridLogic.ts`
  (`attachCellDiagnostics` strip-then-attach), `src/quantbook/cellGrid/cellGridHtml.ts` (client tooltip
  mirror), `test/quantbook-udf-worker.test.ts` (+6 tests).
