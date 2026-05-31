# 6.3-2 phase-closure MEGAUDIT — synthesis (2026-05-30)

> **RESOLVED 2026-05-30** by the 6.3-2 closure hardening pass — engine `1231e432eb2`
> (`feat/quantbook-engine`), IDE `037421ff38a` (`feat/visualise-v1`). All 6 recommended
> follow-up items shipped (the H1/H2 coercion fix + M1/M2 strict unions + X1/X2 IDE parity
> backfill + the pollEvents/recalcAll/setUdfWorker smoke pins + the 5 docstring tidy-ups).
> Re-audited (parallel Codex high + Opus) → 0 HIGH / 0 MED both lanes; 2 Codex LOWs
> (wrong-reason recalcAll smoke; stale FormatIdJson `Option<u32>` doc) folded into the feat.
> See the "6.3-2 hardening" bullet in `docs/phase6/6-3-entry-plan.md`. NEXT = 6.3-3 (live-grid).

5-way parallel megaudit of the COMPLETED Phase 6.3-2 napi binding surface (all 32 EngineSession methods
bound on the owning `Session` napi class across sub-increments a–e, plus the 6.3-1 machinery). Engine HEAD
`d322e1984f6`; IDE HEAD `7dcf0acf030`. The code is already SHIPPED — this is a post-ship closure audit.

Lanes (distinct lenses, read-only):
- **Codex A** — napi contract conformance (catch_unwind / guarded / env / native errors / BigInt) → **SHIP, 0 findings**
- **Codex B** — DTO + converter correctness + No-Fallbacks → **DO-NOT-SHIP** (the cross-lane catch)
- **Opus 1** — cross-repo DTO/method parity + IDE error-code allowlist + loader presence → **SHIP-WITH-FIXES**
- **Opus 2** — lifecycle gating / FaultGuard / atomicity / docstring-vs-behavior → **SHIP** (5 LOW doc nits)
- **Opus 3** — smoke coverage + observability (the completeness critic) → **SHIP-WITH-FIXES**

Lane transcripts: `.codex-6-3-2-megaudit-laneA.out`, `.codex-6-3-2-megaudit-laneB.out` (repo root, untracked).
Opus lane reports are captured below.

---

## Reconciled findings (severity = post-verification, all confirmed at source)

### HIGH — No-Fallbacks coercion class (Codex B; verified)

The codebase documents at `crates/ql-bindings-node/src/lib.rs:160-170` that a `u32` napi param applies ECMAScript
`ToUint32` (NaN/Inf→0, fraction→floor-toward-zero, -1→u32::MAX), and that `validate_u32_index`/`validate_u16_index`
exist SPECIFICALLY to avoid this by taking the param as `f64` and validating loudly. Three DTOs bypass that discipline
by declaring `u32` fields directly:

- **H1 — `FormatIdJson.builtin: Option<u32>` + `custom_counter: Option<u32>`** (`lib.rs:672`), consumed by
  `setFormat` / `registerFormat` via `session_format_id_from_json` (`lib.rs:4436`). Repro:
  `setFormat(0,0,0,{kind:"builtin", builtin: NaN})` silently applies builtin format **0**; `{kind:"custom",
  customPeer:1n, customCounter:2.9}` silently stores counter **2**. A malformed format id is masked into a valid-looking
  one — a wrong value, not an error. **In 6.3-2a scope.** (Note: `custom_peer` is `Option<BigInt>` and IS validated for
  sign/lossless in the converter — only the two `u32` fields are affected.)
- **H2 — `ArityJson.n/min/max: Option<u32>`** (`lib.rs:4754`), consumed by `registerFunction` via `arity_from_json`
  (`lib.rs:5132`). Repro: `arity:{kind:"fixed", n:2.9}` registers `Fixed{n:2}`; `n:NaN` registers `Fixed{n:0}`. The
  existing `u8::try_from` only catches values >255 AFTER the coercion. **In 6.4-2 scope (function registration), not
  strictly 6.3-2 — but same defect class on the same binding surface.**

**Fix:** change these fields to `Option<f64>` and validate via `validate_u32_index` in the converter (the established
pattern), exactly as every coordinate field already does. Add smoke negatives (`builtin: NaN` / `n: 2.9` → `bad_argument`).

### MED — strict tagged-union gaps (Codex B; verified)

- **M1 — `CellValueJson` is not a strict tagged union.** `session_cell_value_from_json` (`lib.rs:4355`) honors `kind`
  and requires the kind's payload, but silently IGNORES extraneous-for-kind fields: `{kind:"blank", number:123}` clears
  the cell (drops 123); `{kind:"number", number:1, text:"x"}` stores 1 (drops text). The STORED value is always
  correct-for-kind (so not HIGH), but per the No-Fallbacks bar + the strict pattern established for `SessionOpJson`
  (6.3-2e) and `ArityJson`, extras should be rejected. Reachable via setValue/batch/txnAdd/writeRange.
- **M2 — `FormatIdJson` drops extraneous-for-kind fields** (a `builtin` kind ignores `customPeer`/`customCounter` and
  vice-versa). Same strict-union gap as M1; fold into the H1 fix.

### Cross-repo (Opus 1) — SHIP-WITH-FIXES (latent, unconsumed)

- **X1 — 4 bound owning-`Session` methods have NO IDE `SessionInstance` TS sig (and no loader presence entry):**
  `close` (6.1C M8), `registerFunction` / `unregisterFunction` / `listFunctions` (6.4-2). LATENT — no IDE caller hits
  them yet, so nothing is broken today, but the typed handle can't reach the 6.1C teardown method or the entire 6.4-2
  UDF-registration surface. **Pre-existing (6.1C / 6.4-2), not introduced by 6.3-2.**
- **X2 — 2 DTOs have no IDE TS mirror:** `ArityJson`, `FunctionMetadataJson` (the `listFunctions`/`registerFunction`
  types). Self-consistent with X1 (their methods are also un-mirrored). Fix X1+X2 together.
- **CLEAN:** the IDE error-code allowlist (`KNOWN_QUANTBOOK_ERROR_CODE_RECORD` + `QuantbookErrorCode` union) is
  COMPLETE — every engine code reachable from the bound methods is present (compile-enforced via the `Record<Exclude<...>>`
  invariant); DTO field parity for the entire CONSUMED surface is exact.
- LOW: `BatchResultJson.version` typed `Uint8Array` IDE-side vs `Buffer` on the snapshot DTOs (functionally compatible —
  `Buffer extends Uint8Array`); `RangeResultJson.schemaVersion?` optional IDE-side (intentional convention).

### Semantics/docstrings (Opus 2) — SHIP (5 LOW doc nits, no behavior defect)

Lifecycle gating, FaultGuard coverage (legitimate errors do NOT seal the session), atomicity (batch/txn all-or-nothing,
commit-restores-buffer-on-failure, rollback-consumes), reserved-stub Capability honesty, and the HIGH-value error-code
docstrings are ALL correct. The setName-normalizes-vs-queryRange-rejects inverted-range asymmetry is real, not a bug
(`Range::new` min/maxes and cannot underflow; queryRange rejects before its `end-start+1` span arithmetic), and correctly
documented + filed-forward. LOW doc imprecisions to tidy:
- LOW — `setFormula` docstring says bind failures are `[formula_parse]`/`[bad_argument]`-class; a bind failure is
  actually `[formula_bind]` (Compute class).
- LOW — `import` docstring "malformed bytes → `[persistence]`" omits that an over-limit-but-well-formed CSV →
  `[csv_exceeds_limits]` (BadArgument).
- LOW — `operationStatus` docstring "legal while Busy" is understated (legal in ALL states incl. terminal).
- LOW — `restoreSheet` docstring says "a Conflict" without naming `[sheet_not_deleted]` (its siblings name their codes).
- LOW (pre-existing engine invariant, not a binding defect) — batch Phase-3 apply is designed-infallible after Phase-1
  validation; a Phase-3 failure would leave a partial mutation + Ready session. Flagged for visibility only.

### Smoke coverage (Opus 3) — SHIP-WITH-FIXES

44/51 owning-`Session` methods are OBSERVABLY pinned; NO wrong-reason asserts found (the historically-risky batch-
atomicity, txn-rollback, and rename "still-30" traps are all correctly closed by conjoined positive+negative asserts).
Gaps:
- **HIGH (smoke) — `pollEvents` is BOUND BUT NEVER CALLED.** Real cursor-decode (BigInt sign/lossless) + `EventPageJson`
  builder logic, entirely unexercised at the JS boundary. Add a positive page-shape assert + a negative `pollEvents(-1n)`
  → `bad_argument`.
- MED — `recalcAll` never called (thin wrapper; one observable recompute assert closes it).
- MED — `setUdfWorker` never called; the spawn path needs a Python fixture (defer), but the `handshakeTimeoutMs`
  arg-validation negatives need no Python and should be pinned.
- LOW — `setFormat` happy-path + `markVolatilesDirty` are throw-only (their effects are genuinely unobservable in plain-
  Node v1 — `includeFormats` queryRange throws not_implemented; no volatile fn in the smoke). Document the limitation.

---

## Overall

The 6.3-2 binding layer is **contract-correct, lifecycle/atomicity-correct, cross-repo-parity-correct for everything the
IDE consumes, and strongly smoke-pinned** (4 of 5 lanes SHIP / SHIP-WITH-FIXES on latent items). The single real defect
CLASS is **Codex B's No-Fallbacks coercion** (H1/H2 + the M1/M2 strict-union gaps) — `u32` DTO fields that silently
coerce malformed JS Numbers instead of rejecting them, in violation of the codebase's own documented `validate_u32_index`
convention. These were not introduced by the a–e increments uniformly (FormatId=6.3-2a, Arity=6.4-2, CellValue=inc.2)
but they all live on this binding surface and a phase closure should not leave them un-fixed.

### Recommended follow-up increment (a focused 6.3-2 hardening pass)

1. (HIGH) `FormatIdJson` `builtin`/`customCounter` → `Option<f64>` + `validate_u32_index` in `session_format_id_from_json`;
   make it a strict tagged union (reject extraneous-for-kind). + smoke negatives.
2. (HIGH) `ArityJson` `n`/`min`/`max` → `Option<f64>` + `validate_u32_index` in `arity_from_json`. + smoke negative.
3. (MED) `CellValueJson` → strict tagged union in `session_cell_value_from_json` (reject extraneous-for-kind). + smoke negative.
4. (X1/X2) Add the 4 missing IDE `SessionInstance` sigs (`close`/`registerFunction`/`unregisterFunction`/`listFunctions`)
   + the 2 DTO mirrors (`ArityJson`/`FunctionMetadataJson`) + the loader presence entries.
5. (smoke HIGH/MED) Pin `pollEvents` (page-shape + negative cursor), `recalcAll`, and `setUdfWorker` arg-validation.
6. (LOW) The 5 docstring tidy-ups from Opus 2.

Re-audit the hardening pass (the coercion fixes change FFI input types — exercise NaN/fraction/negative for each).
