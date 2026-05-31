# 6.3-5 CLOSURE MEGAUDIT — Codex lane (repo-scoped, read-only)

You are auditing **Phase 6.3 — Full bindings over the stable `EngineSession` session API** at its CLOSURE, immediately before the binding contract is declared **FROZEN v1**. This is a phase-exit gate, not an increment review. Freezing means the DTO shapes, error taxonomy, camelCase key names, and BigInt/Buffer conventions become a compatibility commitment. Your job is to find anything that must NOT be frozen as-is.

Repo: `quantlab-quantbook/quantbook-engine` @ HEAD `9429ac48193` (branch `feat/quantbook-engine`). Engine logic is OUT of scope and was NOT changed by 6.3 — 6.3 is a pure binding layer over the already-shipped `EngineSession` trait (`crates/ql-session/src/session.rs`) implemented by `WorkbookSession` (`crates/ql-exec/src/session.rs`).

## Primary surface to audit
1. **napi binding** — `crates/ql-bindings-node/src/lib.rs` (the owning `Session` napi class: ~42 bound methods + DTOs + converters + the `guarded(env,..)`/`engine_error_to_napi`/`throw_structured` error contract + `validate_u16_index`/`validate_u32_index`/BigInt validators). NOTE: the file also contains a LEGACY `CollabSession`/`Transport` class — that is NOT the 6.3 surface; focus on the owning `Session`.
2. **pyo3 facade** — `crates/quantbook-py/src/lib.rs` (the `quantbook._quantbook` thin Session facade, ~24 golden-flow methods), `crates/quantbook-py/build.rs`, `crates/quantbook-py/Cargo.toml`.
3. **golden parity matrix** — `crates/quantbook-py/tests/parity_matrix.py`, `crates/quantbook-py/tests/golden_flow.py`, `crates/ql-bindings-node/tests/golden_flow.mjs`, `crates/ql-bindings-node/tests/smoke_session.mjs`.

## What to check (freeze-readiness)
- **Cross-binding parity is REAL, not vacuous.** The matrix masks `version`/`nextCursor`. Confirm the mask cannot hide a genuine divergence; confirm the comparator actually fails on a mismatch (not a tautology); confirm the transcript is non-trivial (it claims ≥22 steps). Does each binding genuinely exercise the SAME contract, or does one silently skip/stub a step the other runs?
- **Error taxonomy parity.** napi structured errors set native `.code`/`.class`/`.retryable`/`.details`/`.source`; FFI `bad_argument` keeps the `[code]` prefix with `.code="GenericFailure"`. The pyo3 `QuantbookError` must carry the SAME code/class/retryable/details/source. Are there codes that diverge between Node and Python? Does the `.mjs` errCode helper's prefix-then-native fallback ever pick the wrong code?
- **No-Fallbacks discipline** (hard project rule). Hunt for any silent coercion / default-on-missing / swallowed error in BOTH bindings: napi `ToUint32`/`ToNumber` coercion of malformed JS numbers before validation; pyo3 `extract()` paths that default; required lists defaulting to `[]`; tagged-union converters that silently drop extraneous-for-kind fields instead of rejecting; out-of-domain ints. (Prior increments fixed several of these — verify none remain and none regressed.)
- **Panic boundary completeness.** Every bound method on both bindings must be inside the `catch_unwind` boundary (napi `guarded`+`#[napi(catch_unwind)]`; pyo3 `guarded(py,..)`). A missed method is an abort-the-host hole. Enumerate the methods and confirm coverage. Confirm the deliberate-panic matrix row proves `[panic]` surfaces (note the documented release-build caveat: the panic probe is debug-only).
- **DTO field parity** across napi DTOs ↔ pyo3 dicts ↔ the engine DTOs: every field present, same key name (camelCase), same type discipline (Buffer for opaque bytes, BigInt for u64). Any field dropped/renamed/retyped in one binding.
- **Lifecycle gating + state machine**: gated methods reject after `close()` with `invalid_state`; ungated pure reads (`canUndo`/`canRedo`) do not. Consistent across both bindings.
- **The 5 deferred §2c methods** (`writeRange`/`publishDataset`/`bindRange`/`refreshSource`/`materializeQuery`) must surface honest Capability errors (`not_implemented_in_v1_core`) in Node and be absent/Capability-erroring in Python — NOT silently succeed.
- **Anything that, once frozen, becomes a wart we cannot fix without a breaking change.**

## Output (write to this exact file)
Write your verdict to `docs/audits/2026-05-31-6-3-5-closure-megaudit/lane-codex.out`. Structure:
- One-line verdict: `SHIP` / `SHIP-WITH-FIXES` / `DO-NOT-SHIP`.
- Findings table: each finding = SEVERITY (HIGH/MED/LOW/INFO) · file:line · what · why it matters at FREEZE · concrete fix. HIGH = must fix before freeze. Reproduce/cite exact lines; do not speculate.
- A short "verified clean" list of the dimensions you checked and found sound.
Be adversarial. A clean phase-freeze audit that missed a frozen-in wart is worse than a noisy one.
