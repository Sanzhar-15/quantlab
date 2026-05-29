# Phase 6.4-4 — UDF exit-tests + 6.4-3 arc CLOSURE — 5-way megaudit SYNTHESIS

**Date:** 2026-05-29. **Audited:** the new `crates/ql-exec/tests/udf_exit_tests.rs`
(closure gate for §10.4 tests 1-8) + the cumulative 6.4-3a/b/c/d production surface, held
against `docs/api/session-api.md` §10.4. **6.4-4 changed NO production code** — it adds one
public-API integration test file. Brief: `PROMPT.md`.

## Lanes

| Lane | Reviewer | Focus | Verdict |
|------|----------|-------|---------|
| Codex-1 | gpt-5.5 xhigh (read-only) | Half A — exit-test fidelity + coverage | SHIP-WITH-FIXES |
| Codex-2 | gpt-5.5 xhigh (read-only) | Half B — 6.4-3 arc holistic closure | SHIP-WITH-FIXES |
| Opus-A | fresh-context | exit-test fidelity (mutation-probed) | SHIP |
| Opus-B | fresh-context | worker model / concurrency / lifecycle / no-late-commit | SHIP |
| Opus-C | fresh-context | semantics / diagnostics / contract fidelity | SHIP-WITH-FIXES |

**Reconciled verdict: SHIP-WITH-FIXES — no HIGH, no DO-NOT-SHIP in any lane.** The closure is
real: the 8 tests pass and are non-vacuous (Opus-A ran a destructive mutation probe confirming the
counter assertions are load-bearing; Opus-B re-ran `process_smoke` 2/2 against real pyarrow). All
findings are test-hardening + doc-honesty + two forward-risk doc notes + one filed-forward
pre-existing validation gap.

## Fixes applied (this cycle)

All in `crates/ql-exec/tests/udf_exit_tests.rs` unless noted. None touch production behavior.

- **TH-1 — test 8 intermediate assertions** (Codex-1 MED-1 + Codex-2 LOW-1 + Opus-A LOW-1).
  After `register_function` + `set_udf_worker` but BEFORE `recalc_dirty`, assert B1 is STILL
  `#NAME?` and `calls == 0`; after `recalc_dirty`, assert `B1 == 42` and `calls == 1`. Closes the
  "register/set_worker eagerly heals B1, or recalc_dirty double-evals" false-pass — the chain is
  now airtight.
- **TH-2 — tests 1 & 2 pre-recalc assertions** (Codex-2 LOW-1). After the `set_value` edit but
  before `recalc_dirty`, assert the counter is unchanged — so a future eager-recompute-in-set_value
  regression (with recalc_dirty becoming a no-op) can no longer pass these vacuously.
- **TH-3 — test 3 isolates volatility from plain recalc** (Codex-1 LOW-3). First call
  `recalc_dirty()` with nothing dirty → assert the counter stays at 1 (a plain dirty recalc does
  NOT re-run a volatile with no dirty dep); THEN `mark_volatiles_dirty()` + `recalc_dirty()` →
  assert 2. Removed the stray "fanout" framing (this test has no dependent; fanout is covered by
  `session.rs::mark_volatiles_dirty_fans_out_*`).
- **TH-4 — diagnostic-code coverage gap** (Opus-C MED-1 + MED-2). Exit test 7 covered only
  `udf_no_worker`/`udf_raised`/`udf_timeout`; the other five user-visible codes
  (`udf_worker_died`, `udf_codec`, `udf_protocol`, `udf_handshake`, `udf_cancelled`) were emitted
  by `scalar.rs::udf_error_diagnostic` but UNTESTED — all are `MockWorker`-reachable. Added a
  table-driven block asserting each of the 7 `UdfError` variants → its stable `(code, severity)`
  (plus the no-worker case). Corrected the docstring's false "three mock-reachable modes" claim.
- **TH-5 — test 7 severity + message stability** (Codex-1 LOW-4 + Opus-C). Assert
  `severity == Error` on every diagnostic and the exact `udf_raised` message
  (`"ValueError: boom"`) + a stable no-worker message.
- **TH-6 — test 6 citation + wording honesty** (Codex-1 MED-2 + Opus-C MED-3 + Codex-2 LOW-3).
  Cite the exact `process_smoke` tests (`process_worker_round_trips_against_real_python` for the
  timeout-kill `pid()==None`; `process_worker_times_out_under_frame_flood` for the flood-deadline),
  soften "is proven" to the construction-plus-kill argument, and state plainly that v1 reaches the
  TIMEOUT half only — the cooperative-`CANCEL` route (`UdfError::Cancelled`) is not yet wired from
  the session (its diagnostic code IS now covered by TH-4).
- **TH-7 — module-doc framing** (Codex-2 LOW-2). State the suite proves SIX positive exits + TWO
  reserved-capability guards (4 & 5), not eight positive proofs.
- **DOC-1 — `map_udf_error` wildcard note** (Opus-C LOW-1). `scalar.rs`: a `// adding a variant?
  reconsider this wildcard before it silently maps to #CALC!` note on the `_ => Calc` arm
  (`udf_error_diagnostic` above it is already exhaustive, so a new variant is a compile error there).
- **DOC-2 — `loader.rs` D2 forward-risk warning** (Opus-B LOW-1). `load_workbook_and_recompute`
  uses the honest (non-preserving) `recompute_all`; a doc note warns it must NOT be wired to load a
  `.qbook` carrying saved UDF values without a worker (would reintroduce the megaudit-closed D2
  data-loss). Not live today (product loads via `WorkbookSession::open`, which preserves).

## Filed forward (NOT fixed this cycle — with rationale)

- **FF-1 — `validate_canonical_function_name` does not match the formula identifier grammar**
  (Codex-2 MED-1). A host can register `MY UDF` / `MY-UDF` / `É`; the validator only rejects empty
  + ASCII-lowercase, so registration succeeds and `list_functions` advertises a name no formula can
  reference. **MED, no data corruption** — the registration is inert; `=MY UDF(...)` fails loud at
  parse / resolves to `#NAME?`. A *correct* fix must mirror the lexer's function-identifier grammar
  EXACTLY, including dotted names (`T.DIST.2T`) and digit-leading dotted segments; rushing a
  grammar-matching validator in a closure cycle risks REGRESSING valid registrations (a worse bug).
  No reusable lexer predicate is exposed today. **Deferred to a focused 6.4-2-followup** that
  extracts a shared lexer identifier predicate and mirrors it in `ql-functions`. Pre-existing since
  the 6.4-2 cycle-2 validator; not introduced by 6.4-4.
- **FF-2 — `WorkbookTransaction` has no `udf_diagnostics` sink** (Opus-B LOW-2). A UDF committed
  via a runtime-level `WorkbookTransaction` maps to the correct cell VALUE but emits no
  `CellDiagnostic`. **Not live:** all `rt.transaction()` callers are `#[cfg(test)]`; the live
  `batch`/`commit_transaction` path drives `rt.set_formula` inside `with_runtime_no_oplog`, which
  DOES thread + drain diagnostics. Forward risk only: if a future production path commits UDFs via
  `WorkbookTransaction`, thread a collector mirroring `with_optional_oplog`.

## Verified CLEAN by ≥2 lanes (no action)
RefCell nested-borrow (no double-borrow reachable — inner released before outer; Opus-B + the
code's own proof); panic-freedom of dispatch → FaultGuard never seals on a UDF failure (Opus-B
per-path walk); `Send`/`!Sync` soundness (Opus-B per-field walk + the napi `assert_send`); the
recompute preserve path is load-only (`recompute_all_preserving_saved_udf` single caller = `open`;
Opus-B + Opus-A); diagnostic drain ordering (one push → one drain → append-only ring; no
miss/double/misattribution; Opus-B + Opus-A); the no-late-commit construction (kill + drop channel
+ fresh respawn; Opus-A + Opus-B + Codex-2); value/diagnostic taxonomy consistency
(`#NAME?`/`#CALC!`/`#TIMEOUT!`; Opus-C); tests 4/5 reserved-tier deferrals honest (all five lanes).
