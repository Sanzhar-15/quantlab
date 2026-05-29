# 6.4-4 closure megaudit — preserved lane reports (5 lanes)

Reconciliation is in `SYNTHESIS.md`. Raw Codex transcripts (≈450 KB of echoed
file dumps) were trimmed to their verdict+findings here to keep the repo lean.

---

## Lane Codex-1 (gpt-5.5 xhigh) — Half A: exit-test fidelity + coverage — SHIP-WITH-FIXES

No HIGH production blocker; the closure tests overclaim in a few places.

- **MED-1** `udf_exit_tests.rs:451` (test 8): does not fully prove the
  register→dirty→`recalc_dirty` chain — passes on final value + `calls>=1` even
  if register/set_worker eagerly healed B1 or recalc_dirty double-evaluated. Fix:
  assert B1 still `#NAME?` and `calls==0` after register+set_worker but BEFORE
  recalc_dirty; `B1==42` and `calls==1` after.
- **MED-2** `udf_exit_tests.rs:308` (test 6): proves timeout VALUE mapping, not
  actual no-late-commit; the cited process tests self-skip without pyarrow. Fix:
  relabel as the engine-half mapping test + tighten citation (or add a real
  fake-process late-return test).
- **LOW-3** `udf_exit_tests.rs:214` (test 3): does not isolate volatile-pass from
  plain dirty recalc; the "fanout" claim has no dependent in-test. Fix: first
  `recalc_dirty()` with nothing dirty → counter stays 1; then
  `mark_volatiles_dirty()`+`recalc_dirty()` → 2. Cite the session.rs fanout test.
- **LOW-4** `udf_exit_tests.rs:371` (test 7): only asserts code, not
  severity/message. Fix: assert `severity==Error` + stable messages.

Tests 4 & 5 are honest deferrals (`not_implemented_in_v1_core`), not regressions.

---

## Lane Codex-2 (gpt-5.5 xhigh) — Half B: 6.4-3 arc holistic closure — SHIP-WITH-FIXES

No HIGH. Timeout/no-late-commit story sound: synchronous engine boundary, one
error result on timeout, process worker kills/drops the timed-out worker with no
async channel that can later overwrite a committed cell.

- **MED-1** `session.rs:3189` `validate_canonical_function_name`: accepts
  uncallable names (`MY UDF`, `MY-UDF`, `É`) — only rejects empty + ASCII
  lowercase, so `list_functions` advertises a name no formula can reference. Fix:
  validate against the formula identifier grammar via a shared lexer helper;
  mirror in `ql-functions`. [→ filed forward FF-1; correct fix must match the
  dotted-name grammar, deferred to avoid regressing valid registrations.]
- **LOW-1** tests 1 & 2 don't fully isolate `recalc_dirty` (a future eager
  set_value + no-op recalc_dirty would still pass). Fix: assert value+count
  unchanged after set_value, before recalc_dirty.
- **LOW-2** tests 4 & 5 are deferrals, not positive proofs — label the suite
  "6 positive exits + 2 reserved guards".
- **LOW-3** test 6 covers timeout, not cancellation; the contract says
  "canceled/timed-out". Narrow wording to timeout-only for v1.

---

## Lane Opus-A (fresh context) — exit-test fidelity (mutation-probed) — SHIP

All 8 tests pass; verified by code-reading AND a destructive mutation probe that
the counter assertions are load-bearing. Each test proves its §10.4 claim for the
right reason. No HIGH/MED.

- Per-test: test 1 sound (set_value does not eagerly recompute dependents →
  count==2 proves fanout); test 2 PROVEN non-vacuous (mutated assert to ==2 →
  failed left:1 right:2); test 3 sound (`mark_volatile_dirty` fanout variant →
  `is_volatile` forces re-eval); test 6 engine-half sound + process_smoke citation
  ACCURATE (kill + drop channel make a late RETURN physically undeliverable);
  test 7 no leak/double-count (fresh session per case, addr filter, append-only
  ring); test 8 the crux holds — `functions_used` records MYUDF even when unknown
  at authoring, `recompute_dirty` recomputes ONLY the dirty set, so 42 REQUIRES
  the dirty-on-register hook.
- **LOW-1** test 8 `calls>=1` could be `==1`. **LOW-2** test 7c message not
  asserted. **LOW-3** late-RETURN proven by construction, not an injected frame.
- Coverage COMPLETE: lib-level MockWorker suite (session.rs ~3669) covers
  array-spill, scalar-context-array→#CALC!, two-range→#VALUE!, nested UDF,
  no-worker usability, open/import/undo preserve paths. Tests 4/5 deferrals honest.

---

## Lane Opus-B (fresh context) — worker model / concurrency / lifecycle / no-late-commit — SHIP

Clean of HIGH/MED. Ran `udf_exit_tests` 8/8 and `process_smoke` 2/2 against real
pyarrow (NOT skipped).

- RefCell nested-borrow NOT reachable (inner borrow released inside
  `marshal_udf_args` before the outer `borrow_mut`; worker.call is a leaf).
- Panic-freedom verified per-path → FaultGuard never seals on a UDF failure.
- Send/!Sync per-field walk + the napi `assert_send` positive proof hold.
- No-late-commit: kill_worker drops WorkerProcess + mpsc receiver; respawn fresh
  channel; Drop detaches (not joins) the reader (deadlock-free); top-of-loop
  deadline guard. Both process_smoke tests exercise it.
- Diagnostic drain: one push → one drain → append-only ring; no
  miss/double/misattribution; on panic the drain is skipped (sealed session).
- **LOW-1** `loader.rs::load_workbook_and_recompute` uses non-preserving
  `recompute_all` — forward D2 risk if wired for `.qbook` loading (not live).
  [→ DOC-2 warning added.]
- **LOW-2** `WorkbookTransaction` has no diagnostics sink — forward risk only
  (live batch/commit path threads diagnostics; only test callers use it).
  [→ filed forward FF-2.]

---

## Lane Opus-C (fresh context) — semantics / diagnostics / contract fidelity — SHIP-WITH-FIXES

No HIGH; arc genuinely closable; taxonomy internally consistent. Ran
`udf_exit_tests` 8/8 + lib udf 22/22.

- **MED-1** five user-visible diagnostic codes (`udf_cancelled`, `udf_handshake`,
  `udf_protocol`, `udf_worker_died`, `udf_codec`) have ZERO test coverage — all
  mock-reachable. Add a test pinning all 8 code strings. [→ TH-4.]
- **MED-2** test 7 docstring "three mock-reachable modes" is wrong (all 7 are
  reachable) — masks MED-1. [→ TH-4 docstring fix.]
- **MED-3** test 6 overclaims: glob `process_worker_times_out_*` matches one fn;
  the canonical timeout-kill is inside `process_worker_round_trips_*`; neither
  asserts a late RETURN dropped directly. [→ TH-6 citation fix.]
- **LOW-1** `map_udf_error` wildcard `_ => Calc` silently absorbs new variants.
  [→ DOC-1 note.]
- **LOW-2** append-only diagnostic ring → stale diagnostics accumulate (consumer
  strips; documented model, not a regression).
- Sound: tests 1/2/3 isolation real; test 8 non-vacuous; counter approach sound;
  tests 4/5 deferrals honest; `#NAME?`/`#CALC!`/`#TIMEOUT!` taxonomy consistent;
  `udf_error_diagnostic` exhaustive (new variant = compile error); `Diagnostic.code`
  is free-form String (not EngineError-allowlist-gated).
