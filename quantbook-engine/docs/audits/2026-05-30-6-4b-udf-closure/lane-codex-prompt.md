# Codex security/correctness audit — Quantbook Phase 6.4B UDF hardening closure (UDF-6-02..04)

You are auditing the **Phase 6.4B UDF-hardening closure** of the Quantbook engine — the
out-of-process Python user-defined-function (UDF) subsystem. This is the **6.4 phase gate**:
the code must be correct, the security claims must be honest, and the type-conversion contract
must be genuinely tested. Be adversarial. Read the actual code; do not trust comments or commit
messages. Cite every finding with `file:line`.

## Repo
Engine repo root: `quantbook-engine/` (run from the git root which is the parent dir).
Branch `feat/quantbook-engine`. The 6.4B work to audit is in these commits (HEAD chain):
- `cce49bc656d` — UDF-6-03 type-conversion matrix test + UDF-6-04 security doc
- `67170a4479f` — FF-2 test compile fixup
- `fee55b8c719` — H (op-level recalc budget) + I (grid caps) + FF-2 (txn diagnostics sink)
- `57bfc434850` / `9b7401253bc` — FF-1 (callable-name gate)

Diff the range `7c13931b1ab..HEAD` to see the 6.4B deltas, but audit the FULL relevant code paths
(process.rs, codec.rs, scalar.rs dispatch, session.rs, transaction.rs), not just the diff.

## Scope — audit each of these, hardest-first

1. **I — grid caps (`crates/ql-udf/src/codec.rs`).** `MAX_GRID_CELLS` (5M), `MAX_GRID_BYTES`
   (= `MAX_FRAME_LEN` 64 MiB), `encode_grid_capped` / `decode_grid_capped`. CRITICAL: is the byte
   cap checked **before** any large allocation on the decode (return) path — i.e. can a crafted/
   oversized return frame from a malicious worker force an unbounded allocation BEFORE the cap
   fires? Is the cell-count cap checked before allocating the cell vec? Off-by-one (`>` vs `>=`)?
   Does `checked_mul` actually guard the rows*cols overflow? Does the frame-layer cap
   (`frame.rs` `MAX_FRAME_LEN`, read side) fire before allocation too? Is there a gap between the
   frame cap and the grid byte cap?

2. **H — op-level recalc budget (`crates/ql-exec/src/scalar.rs`).** `UDF_OP_BUDGET` (120s),
   `UDF_CALL_DEADLINE` (30s), `effective_udf_deadline(op_deadline, now)`, the arming in
   `run_recalc` (worker-attached only), the dispatch-skip when the budget is exhausted
   (→ `#TIMEOUT!` + `udf_budget_exhausted`). Can the budget FAIL to bound a recompute pass (e.g.
   `checked_duration_since` returning None handled wrong, a zero/None deadline let-through, the
   per-call clamp not applied)? Is the budget armed exactly once per pass? Does a non-UDF / no-worker
   recompute stay byte-for-byte unchanged (deadline None path)? Any way a single UDF still stalls
   the whole pass past the budget?

3. **UDF-6-02 — timeout/cancel via worker-kill (`crates/ql-udf/src/process.rs`).** The deadline
   check in `call()`, `kill_worker()`, the late-RETURN drop, lazy respawn, `WorkerProcess::drop`
   (kill+reap direct child, DETACH reader thread). CRITICAL: can a timed-out worker's LATE RETURN
   ever be committed as a cell value (a no-late-commit violation)? Can the drop path DEADLOCK (the
   reader thread blocked on a grandchild holding the pipe)? Is the kill+reap race-free? Does a dead
   worker surface `WorkerDied` rather than hanging?

4. **FF-1 — callable-name gate (`crates/ql-exec/src/session.rs`
   `validate_canonical_function_name`).** It validates a UDF canonical name by probing
   `NAME(1)` through the engine lexer+parser and requiring it parse to exactly `Expr::Function`.
   Can a name that is NOT a safe callable slip through (injection, whitespace, operators, dotted,
   non-ASCII, reserved)? Can a LEGITIMATE callable be wrongly rejected (the `LOG10`/`ATAN2`
   CellRef-lexed case, dotted `T.DIST.2T`)? Is this gate actually invoked on the registration path
   before the registry mutation?

5. **FF-2 — transaction diagnostics sink (`crates/ql-exec/src/transaction.rs`).** The collector
   threaded through `WorkbookTransaction` + `WorkbookRuntime::transaction`; commit eval uses
   `with_formula_cell_worker_and_diagnostics`. Does the standalone-transaction commit path now
   record UDF-failure diagnostics correctly (no drop, no double-record)? Is the orphaned old ctor
   still sound? Does the new test prove what it claims?

6. **UDF-6-04 — security doc HONESTY (`docs/security/udf-ai-connectors.md`).** This is a trust-model
   doc. For EACH claim, verify against the code: (a) is any claim FALSE or overstated (e.g. claims a
   bound the code doesn't enforce)? (b) is any REAL gap OMITTED from the "what is NOT defended"
   section? (c) are the cited constants/line numbers accurate? Specifically check the trust-gate
   description (engine `set_udf_worker_checked` ensure_ready; the IDE double-gate lives in the
   separate `quantlab/quantlab` repo at `extensions/quantlab/src/quantbook/udfWorker.ts` — you may
   not have it, note if so), the "no OS sandbox" claim, the orphan/grandchild caveat, the op-budget/
   grid-cap/frame-cap numbers.

7. **UDF-6-03 — type matrix test (`crates/ql-exec/tests/udf_type_matrix.rs` +
   `crates/quantbook-py/python/quantbook/_smoke_udfs.py`).** Does the test genuinely PROVE the
   round-trip (real worker, not mock), or are any assertions trivially true / false-positives? Is
   the numpy/pandas boundary assertion correct (np.float64 round-trips, np.int64/np.bool_/pandas
   raise TypeError)? Are the skip-guards honest (a missing library must SKIP, never silently pass or
   masquerade as the type-boundary error)? Gaps in the matrix (a Value variant or sigil not covered,
   the -0.0 sign-bit check)? Could a numpy version difference make the assertion wrong?

## Cross-cutting
- **No-Fallbacks discipline** (this codebase forbids silent error-swallowing): any `unwrap_or`,
  `|| default`, swallowed error, or silent coercion in the UDF paths is a finding.
- Determinism / Send+Sync soundness of any new shared state.
- Anything that would let a UDF (arbitrary trusted-workspace Python) escape the documented bounds.

## Output
For each finding: **severity (HIGH / MEDIUM / LOW / INFO)**, `file:line`, what's wrong, why it
matters, and a concrete fix. End with an overall verdict: **SHIP / SHIP-WITH-FIXES / DO-NOT-SHIP**
and a one-paragraph rationale. Prioritize correctness/security HIGHs over style. If you find nothing
wrong in a scope item, say so explicitly (don't pad).
