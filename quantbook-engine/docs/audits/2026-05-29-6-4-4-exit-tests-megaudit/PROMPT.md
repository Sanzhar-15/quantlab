# Phase 6.4-4 — UDF exit-tests + 6.4-3 arc CLOSURE megaudit

You are an adversarial reviewer. Be skeptical; prefer DO-NOT-SHIP if any HIGH is real.
Output a verdict (SHIP / SHIP-WITH-FIXES / DO-NOT-SHIP) + findings ranked HIGH/MED/LOW,
each with `file:line`, a concrete failure scenario, and a fix. Do not rubber-stamp.
Repo root: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`.

## What 6.4-4 ships

6.4-4 is the **closure gate** of the 6.4-3 Python-UDF arc. It adds **one test file only**
(`crates/ql-exec/tests/udf_exit_tests.rs`, ~460 lines) — a public-API integration suite that
proves the already-shipped 6.4-3a/b/c/d production code against the contract's eight exit tests
in `docs/api/session-api.md` §10.4. **No production code changed in 6.4-4.**

The §10.4 exit tests:
1. pure UDF recomputes on referenced-input change
2. pure UDF does NOT recompute on unrelated edit
3. volatile UDF recomputes on recalc/volatile pass
4. `publish` dirties dependents
5. `BoundFrame` overlay edit dirties bound-range formulas
6. canceled/timed-out UDF does not commit a late result
7. failed UDF → deterministic `CellDiagnostic`
8. registering a UDF dirties formulas that referenced its (previously-unknown) name

Tests 4 & 5 target reserved-tier producers (`publish_dataset`/`bind_range`) that are
`not_implemented_in_v1_core` today — the suite asserts the not-implemented status and documents
the deferral rather than skipping.

## Audit scope — TWO halves

### A. Exit-test FIDELITY + COVERAGE (the new file)
- Does each test actually PROVE its §10.4 claim, or could it pass vacuously / for the wrong
  reason? (e.g. does test 2 truly prove dependency-scoped dirtiness, or would it pass even if
  recalc_dirty were a no-op? does test 3 isolate volatility from a plain full recalc? does test 8
  prove the register→dirty→recalc chain or could #NAME?→42 happen via some other path?)
- Is the invocation-counter approach (`Arc<AtomicUsize>` in a `FnMut` MockWorker) sound — could a
  cache hit or double-eval skew the counts the tests assert (==1, ==2)?
- Are the tests 4 & 5 DEFERRALS honest and defensible, or do they paper over a real gap? Is
  asserting `not_implemented_in_v1_core` the right closure posture?
- COVERAGE COMPLETENESS: given what is implementable at v1, is anything in §10.4 left unproven that
  COULD be proven? Are there UDF behaviors that should be in a closure gate but aren't (nested UDFs,
  array-spill, scalar-context array→#CALC!, two-range→#VALUE!, no-worker usability)? Note: many of
  these have lib-level tests in `crates/ql-exec/src/session.rs` (search `MockWorker`); judge whether
  the closure gate is complete given those exist.

### B. 6.4-3 ARC holistic closure (cumulative production surface)
The arc shipped across 6.4-3a (codec), 6.4-3b (real worker), 6.4-3c (eval dispatch), 6.4-3d
(blockers C1/D/G + napi setUdfWorker + IDE). Each increment was audited separately; this is the
final holistic pass. Look for cross-increment gaps the per-increment audits could not see:
- Eval dispatch + marshalling: `crates/ql-exec/src/scalar.rs` (`dispatch_udf`, `marshal_udf_args`,
  `map_udf_error`, `udf_error_diagnostic`, `eval_at_cell_boundary` UDF guard, `UDF_CALL_DEADLINE`).
- Worker model + diagnostics: `crates/ql-exec/src/env.rs` (`CellEnv::udf_worker`,
  `push_udf_diagnostic`, `UdfCellDiagnostic`), `crates/ql-exec/src/session.rs`
  (`set_udf_worker`/`set_udf_worker_checked`, `drain_udf_diagnostics`, `poll_events`,
  `register_function`), recompute preserve paths in
  `crates/ql-exec/src/workbook_runtime/recompute.rs` (`recompute_all_impl(preserve_saved_udf)`,
  `recompute_all_preserving_saved_udf`, `plan_references_udf`).
- Graph invalidation: `crates/ql-exec/src/calcgraph_session.rs` (`on_function_registered`,
  literal-range deps, `mark_volatile_dirty` fanout).
- Transaction path: `crates/ql-exec/src/transaction.rs` (commit dispatches UDF through the worker).
- The leaf crate: `crates/ql-udf/src/{codec,frame,process,worker,control,payload}.rs`.
- No-late-commit / cancel story (exit test 6): is the engine-half claim (Timeout→#TIMEOUT! committed
  atomically, no late overwrite) actually true, and is the process-half (`ql-udf` process_smoke
  kill+drop-late-RETURN) genuinely the proof the test comment cites?

## Known FILED-FORWARD (NOT regressions; do not re-raise as HIGH)
- debugpy attach (`6.4-3d-debug`); the live `cellGridPanel`→owning-`Session` migration + live
  `pollEvents` loop (IDE Option-A boundary); sync `setUdfWorker` → async-napi `AsyncTask`;
  op-level UDF recalc budget + per-call deadlines (the N×30s aggregate stall, design §H/I);
  grid cell/byte caps; richer list-of-grids arg protocol (mixed/multi-range/array+scalar → #VALUE!).
These are documented deferrals. Flag only if 6.4-4 made one WORSE or mis-documented it.

## Deliverable
A markdown verdict + ranked findings. The reconciliation across all lanes determines ship.
