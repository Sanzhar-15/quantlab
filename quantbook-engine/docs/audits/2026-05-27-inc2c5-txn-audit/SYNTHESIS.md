# 6.1B inc.2c-5 — multi-call transaction handle: parallel Codex + Opus audit synthesis

**Date:** 2026-05-27 · **Target:** `crates/ql-exec/src/session.rs` — the
`begin_transaction`/`txn_add`/`commit_transaction`/`rollback_transaction`
implementation (previously `not_implemented` stubs) + the two new struct fields
(`txns`, `next_txn_id`) + `close()` clearing `txns` + the `unknown_transaction`
free fn.

**Method:** the standard parallel audit-discipline pair, both read-only, both
verifying at source:
- **Codex** — `gpt-5.5`, `model_reasoning_effort=xhigh`, `--sandbox read-only`
  (prompt `.codex-6-1b-inc2c5-txn-audit-prompt.md`, raw output
  `.codex-6-1b-inc2c5-txn-audit.out`).
- **Opus** — a `general-purpose` sub-agent with the same scope.

## Verdict: SOUND — no HIGH reachable. The two reviewers CONVERGED.

The transaction handle is a faithful pure-DTO buffer holding no engine borrow; the
workbook is untouched until commit; `commit_transaction` routes the buffer through
the **exact** `batch` machinery, so it inherits `batch`'s validation-atomicity,
graph consistency, single `Op::BatchCommit`, single `state_seq` tick, and the
same-cell value/formula conflict guard (`conflicting_batch_ops`). The
failed-commit **restore** (re-insert the buffer, transaction stays open) is safe
*precisely because* `batch` is validation-atomic on every reachable error path:
nothing is appended to the op-log and nothing is mutated before the failure point
(Phase 1 validates against the pre-batch workbook; Phase 2 appends the single
`BatchCommit` before any mutation; Phase 3 applies with the op-log detached and has
no post-mutation `Err` path for the current `SessionOp` variants; a panic in the
kernels is converted to `Faulted` by the `FaultGuard`, and a later commit then
fails at its own `ensure_ready` — never a silent double-apply).

## Findings applied (both reviewers flagged each independently)

| Sev | Finding | Fix shipped |
|-----|---------|-------------|
| **MED** | `txn_add` had no lifecycle gate → could return `Ok` on a `Faulted`/`Closed` session, silently buffering ops that can never commit (inconsistent with every other mutator). | Added `self.ensure_ready()?` at the start of `txn_add` (terminal/Busy → `invalid_state`, uniform). `rollback_transaction` stays ungated **by design** (cleanup is always permitted) — documented + tested. |
| **LOW** | `next_txn_id += 1` was unchecked → eventual `u64` wrap could reuse a live handle and overwrite its buffer (debug-panic / release-wrap). | `checked_add(1)` → loud `Internal`/`transaction_id_exhausted` on exhaustion; handle NOT inserted on overflow (No-Fallbacks; practically unreachable at 2^64). |
| **LOW** | Failed-commit + conflict transaction tests didn't assert the op-log was untouched (the invariant the restore depends on). | Added `oplog.len()`-unchanged + version-unchanged assertions to both; added `txn_add_on_closed_session_is_invalid_state`. |

## Verified non-findings (both)
- Commit-failure restore is sound for all reachable `EngineResult` errors (batch is validation-atomic).
- Redundant `ensure_ready` (commit + batch) is harmless; no TOCTOU (`&mut self`, single-writer).
- Unknown handles are fail-loud `NotFound`/`transaction_not_found`, never silent no-ops.
- Conflict-guard inheritance is real (commit → batch → `guard_vf_conflict!`); `CellAddr` is `Eq+Hash` over `{sheet,row,col}` so the guard is sheet-aware.
- `ops.clone()` in commit is correct (cost, not aliasing).
- `txns` unbounded growth is documented as a v1 limitation consistent with `ops`/`events`.

## Result
ql-exec lib **691/0**, clippy clean, workspace `cargo check` green after the fixes.
