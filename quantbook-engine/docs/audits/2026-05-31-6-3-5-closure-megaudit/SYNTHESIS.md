# 6.3-5 Closure Megaudit — SYNTHESIS

Date: 2026-05-31. Engine HEAD `9429ac48193` (`feat/quantbook-engine`). IDE `cb3ca7cedca` (`feat/visualise-v1`).
Gate: Phase 6.3 EXIT — declare the `EngineSession` binding contract FROZEN v1 on ≥2 passing parity rows + a clean closure megaudit (entry-plan §6/§9).

## Lanes (3, per entry-plan §6)
- **Codex** (read-only, reasoning=high) → SHIP-WITH-FIXES. `lane-codex.out` (transcribed from run-log; codex read-only sandbox could not self-write).
- **Engine Opus** (fresh-context; first attempt blocked by the mac-bridge fault and CORRECTLY refused a verdict, re-run clean) → SHIP-WITH-FIXES. `lane-opus-engine.out`. (Two independent Opus engine runs converged on the same u64 finding.)
- **IDE-aware Opus** (cross-repo) → SHIP. `lane-opus-ide.out`. Error-code allowlist EXACT (`record == union − {unknown}`, verified programmatically), DTO/method/wire parity clean.

## Pre-freeze gates (verified GREEN, under python3.12 on the mac host)
ql-bindings-node build debug+release 0/0 · ql-exec 802/0 (default + xlsx-write) · clippy 0 (ql-bindings-node + quantbook-py) · node smoke PASS (all 6.3 blocks) · parity_matrix.py PARITY OK (22 steps).
(NOTE: the matrix MUST run under python3.12 — the mac SYSTEM python3 is 3.9.6 and cannot load the abi3-py310 extension. This was a one-time verify-script scare, not a defect.)

## NET DISTINCT FINDINGS (deduplicated across lanes; each personally re-verified in code)

### HIGH-A — u64 representation forks across bindings (Engine Opus HIGH-1/HIGH-2). VERIFIED.
- napi emits every u64 as a JS `BigInt`; the Node harness `stableStringify` (golden_flow.mjs:248) renders a BigInt as `JSON.stringify(v.toString())` = a **quoted decimal STRING**.
- pyo3 emits the same field as a plain Python `int` (e.g. `customPeer` at src/lib.rs:392); `json.dumps` renders a **JSON NUMBER**.
- The harness comment (golden_flow.mjs:246) *claims* the int "compares the same way" — that is FALSE (`"123"` ≠ `123`).
- Affected u64 fields: `FormatId.Custom.customPeer`, `Event.op`, `EventPage.nextCursor`, `TransactionId`, recalc op-ids.
- **Invisible to the matrix** because the golden flow uses `builtin 0` (never a custom format), masks `nextCursor`, and never records `Event.op`. So u64 parity is UNPROVEN, and the two bindings' JSON projections of a u64 genuinely differ.
- At freeze this matters: the 6.2 service transport (the NEXT phase) JSON-serializes these DTOs; a string-vs-number u64 is a real cross-binding wire divergence. NOTE the runtime API values are each lossless per-binding (BigInt in JS, int in Python) — the fork is at the JSON projection.

### HIGH-B — Session constructor outside the panic boundary (Codex HIGH-1/HIGH-2). VERIFIED.
- napi `Session::new()` (lib.rs:5561) is `#[napi(constructor, catch_unwind)]` (so NO host-abort) but does NOT enter `guarded` → a construction panic maps to napi's default error, not the structured `.code="panic"`.
- pyo3 `#[new]` (src/lib.rs:790) has NEITHER `guarded` NOR catch_unwind → a construction panic unwinds into CPython (PanicException, not the structured `QuantbookError`).
- Construction is allocation-only (`Arc`/`Mutex`/`HashMap`/`VecDeque` + `mint_epoch`) → realistically infallible, but the freeze-consistency gap is genuine and cheap to close (every OTHER method on both bindings is inside the boundary).

### MED-1 — pyo3 None-as-missing vs napi reject-null (Codex MED). Cross-binding No-Fallbacks divergence on optional DTO fields (`opt_f64`, src/lib.rs:239): napi rejects explicit JS `null` before the mapper; pyo3 silently treats `None` as absent. Freezing locks the divergence.

### MED-2 — missing REQUIRED list → different error code (Engine Opus MED-1). pyo3 `req_str_list` makes `aliases`/`provenanceTags`/`columnNames` required → `bad_argument`; napi models them non-Option `Vec<String>` so a missing field is a generic napi-deserialize error, NOT `bad_argument`. Violates §5.1 same-code promise. Not matrix-covered.

### MED-3 — matrix anti-vacuity guard accepts ≥10 steps but the flow is 22 (Codex MED + Engine Opus MED). parity_matrix.py:74. Two identically-truncated 10-step rows would pass the freeze gate. Fix: assert exact 22-step ordered name list (or ≥22). PURE TEST HARDENING — no contract risk.

### MED-4 — matrix never field-compares a full `FunctionMetadata` DTO (Engine Opus MED-2). Only `present`+`total` are compared; the ~12-field frozen DTO's per-field parity is unexercised. Coverage gap. Fix is test-only.

### MED-5 — `OperationState.Failed.error` is a `"[code] message"` STRING in BOTH bindings (Engine Opus MED-3). napi lib.rs:5188, pyo3 src/lib.rs:1303. SYMMETRIC (no fork) but freezes the exact `[code]`-prefix anti-pattern §5.1 retired for the main channel. Already documented "filed forward" at 6.3-1c §4b. Decision: keep-as-documented-v1 or restructure to a nested object before freeze.

### LOW-1 — Node harness `errCode` prefers the `[code]` message-prefix over native `.code` (golden_flow.mjs:62), opposite to Python (golden_flow.py:77). Test-harness-only fragility; not a contract issue.

### INFO — `bad_argument` is the binding's own FFI-validation code on the `[code]`-prefix path (not a structured EngineError throw). Both bindings agree. The earlier brief wording calling it stale was itself wrong — it exists exactly as described. No action beyond a one-line session-api.md §5.1 clarity note.

## DISPOSITION (proposed)
- **Test-only hardening — DO regardless (no contract risk):** MED-3 (exact 22-step guard), MED-4 (full FunctionMetadata compare), + add a matrix step that exercises a u64 field UNMASKED (a custom-format `customPeer`) so HIGH-A is provable. LOW-1 (align harness errCode to native-first).
- **Freeze-shape decisions (need the owner):** HIGH-A (u64 = decimal-string-everywhere vs native-bigint-per-binding-documented), HIGH-B (guard the constructors vs document-deliberate), MED-1/MED-2 (tighten pyo3/napi to identical reject-codes vs document), MED-5 (restructure OperationState.error vs keep documented v1 string).
- Adding the u64-exercising matrix step will FAIL until HIGH-A is resolved (the two are coupled) — so HIGH-A is genuinely freeze-gating, not deferrable.

## VERDICT
Two SHIP-WITH-FIXES + one SHIP. The tested 22-step surface is genuinely parity-clean; the freeze is blocked on HIGH-A (a real, verified, matrix-invisible u64 JSON-projection fork) and HIGH-B (constructor boundary gap), plus the MED cluster. The contract must NOT be declared FROZEN v1 until HIGH-A is resolved and the matrix is strengthened to prove it.
