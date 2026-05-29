# Phase 6.4-3d (engine blockers C1/D/G + napi setUdfWorker) — 3-way audit SYNTHESIS

**Date:** 2026-05-29 · **Audited:** `git diff bf261d6bd53..0de9f1fd7b5 -- crates/` (the 6.4-3d
engine blockers `5f163027a80` + napi `66a788e40c2` + the race-fix `0de9f1fd7b5`). The IDE side
(Step 5) is NOT yet implemented, so this audit covers the **engine + napi** surface only.
**Branch:** `feat/quantbook-engine`. Code-then-audit per the 6.4-3a/b/c precedent.

Three independent lanes (preserved alongside this file):

| Lane | Reviewer | Focus | Verdict |
|------|----------|-------|---------|
| 1 | Codex gpt-5.5 xhigh | full increment, adversarial | DO-NOT-SHIP (3 HIGH + 2 MED + 2 LOW) |
| 2 | Opus, fresh-context | engine-internal (D2/C1/G/D1 soundness) | SHIP-WITH-FIXES (2 HIGH + 1 MED + 3 LOW) |
| 3 | Opus, fresh-context | napi + cross-repo wire contract | SHIP-WITH-FIXES (1 HIGH + 2 MED + 2 LOW) |

**The discipline earned its keep:** 3 HIGHs, each independently caught by ≥2 lanes — all real bugs in
shipped code. C1 (literal-range deps), the G borrow/drain plumbing, D1 (worker move), and Send/!Sync
were rated CLEAN by all relevant lanes.

---

## HIGH findings (all FIXED in audit-fix commit)

### HIGH-1 — D2 preserve fired on non-load `recompute_all` paths (Codex #1 + Opus-engine HIGH-1)
`recompute_all` hardcoded `preserve_saved_udf_when_no_worker = true`, but it is called by THREE
session paths, not just load:
- **`open`** (session.rs:1202) — load; preserve is correct.
- **`recalc_all`** (session.rs:2227, via `run_recalc`) — a user who opened without a worker, edited an
  input, then recalc'd would keep the *stale* saved value instead of `#CALC!`.
- **`rematerialize`** (session.rs:877, undo/redo) — **catastrophic**: `replay_into` restores formula
  TEXT only, so the cell holds no computed value; preserve read `Blank` and wrote it back. Opus-engine
  reproduced a dependent `=B1+1` becoming `1.0` (a silent wrong number).

**FIX:** `recompute_all()` now delegates to `recompute_all_impl(false)` (the pre-6.4-3d behavior for ALL
~60 existing callers, incl. recalc_all / rematerialize / replay / names / sheets / cells / tests). A new
`recompute_all_preserving_saved_udf()` (= `recompute_all_impl(true)`) is called ONLY by `open`. This also
resolves Codex #4 (the `workbook.read` user-overlay concern was xlsx-only; xlsx import does not call
recompute_all, and the sole preserve path is now `.qbook` open where `read` returns the computed value).

### HIGH-2 — D2 did not actually preserve spills (Codex #2 + Opus-engine HIGH-2)
`.qbook` does NOT persist spill TARGET cells (they are rebuilt by recompute; `qbook_format.rs`), so the
D2 early-return preserved only the anchor scalar — a previously-spilled UDF opened with no worker shows
anchor-only, body blank. The code comment claiming "saved spilled-array footprints survive" was wrong.
**Disposition (user-chosen Option A — scoped preserve):** this is non-destructive (the spill body was
never on disk) but incomplete; corrected the comment to document it honestly as the v1 limitation
("reopen with a worker to restore spill bodies"). Filed-forward: a spilled-UDF round-trip test +
(option) marking a re-spillable anchor `#CALC!` when no worker can rebuild the body.

### HIGH-3 — `setUdfWorker` had no lifecycle gate; `close()` didn't drop the worker (Codex #5 + Opus-napi H1)
The inherent `set_udf_worker` is a bare field-setter (no `ensure_ready`); the napi method injected a live
Python child into a **Closed/Faulted** session, and `close()` left the worker attached (leak). The
docstring's advertised `[invalid_state]` was unreachable.
**FIX:** new lifecycle-gated `WorkbookSession::set_udf_worker_checked` (`ensure_ready()?` then set,
returns `EngineResult`); the inherent infallible `set_udf_worker` stays for Rust tests. The napi method
spawns OUTSIDE the lock then calls `set_udf_worker_checked` UNDER the lock — a session that closed during
the spawn is caught and the just-spawned worker is dropped (child killed), closing the inject-vs-close
race. `close()` now sets `udf_worker = None` (kills + reaps the child deterministically). Docstring +
Appendix-A errors updated (`[invalid_state]`/`[session_busy]`).

---

## MEDIUM / LOW — dispositions

- **MED (Codex #3 / Opus-engine MED-1): xlsx import recompute uses a worker-less recomputer** + open
  reuses the worker with no trust gate. The xlsx recomputer (`EngineXlsxRecomputer` → `WorkbookRuntime::new`)
  has no worker, so importing xlsx UDF formulas with a live session worker keeps cached values; and the
  trust-of-reuse is the IDE's call. **FILED-FORWARD** (xlsx rarely carries quantbook UDFs; trust gating
  is the IDE's job per 6.4-3d scope). To revisit when xlsx-UDF interop matters.
- **MED (Codex #4): D2 read-lane** — RESOLVED by the HIGH-1 rescope (only `.qbook` open preserves; `read`
  is correct there).
- **MED (Opus-napi M1): `setUdfWorker` is synchronous, blocks the JS thread up to the handshake timeout.**
  Documented inline ("the IDE MUST call it off the UI thread"); **FILED-FORWARD** for IDE Step 5 (make it
  an async napi `AsyncTask`, or the IDE calls off-thread).
- **MED (Opus-napi M2): `invalid_state`/`session_busy` missing from the IDE allowlist** (pre-existing
  6.4-2 gap, now reachable on setUdfWorker via the HIGH-3 gate). **FILED for IDE Step 5** alongside the
  worker codes.
- **LOW (Codex #6 / Opus-napi): `handshakeTimeoutMs` f64→u64.** FIXED — reject non-finite/negative AND
  cap at 600_000 ms (10 min) so a huge value cannot saturate into an unbounded wait.
- **LOW (Codex #7 / Opus-engine LOW-2): standalone `WorkbookTransaction` commit emits no UDF diagnostic.**
  Test-only-reachable (the live `commit_transaction` routes through the runtime); **FILED-FORWARD**
  (matches the 6.4-3c HIGH-2 latent framing).
- **LOW (Opus-engine LOW-1): over-tracking of value-independent multi-cell literal ranges** (ISFORMULA/
  FORMULATEXT) — harmless (re-eval to the same value, VEQ-skipped). Documented; perf-budget note.
- **LOW (Opus-napi L2): re-call double-spawn race** — benign (the dropped worker is reaped); the IDE
  single-threads injection.

## Verified CLEAN by the lanes
C1 registration/cleanup + VEQ + storage-gate (all three lanes); G borrow/drain timing + panic-freedom +
`drop(guard)` soundness; D1 worker take/restore drop-order; Send/!Sync (`UdfCellDiagnostic` is Send →
`WorkbookSession` stays Send); the C1 test is genuinely non-volatile; DTO mapping fidelity; replace/reap
semantics; napi panic-across-boundary (no unwrap/panic in the startup path).

---

## Audit-fix verification (all green)
- `cargo test -p ql-exec --features xlsx-write` → **776 lib + ALL integration suites 0-failed**
  (773 + 3 new: `recalc_all_does_not_preserve_stale_udf_value_without_worker`,
  `undo_recomputes_udf_cell_honestly_without_worker`, `set_udf_worker_checked_rejects_closed_session`).
- `tests/udf_e2e` 1/1 real-python.
- `cargo clippy -p ql-exec -p ql-bindings-node --all-targets` — NO new warnings (the doc-list/complex-type
  warnings are pre-existing 6.4-2, line-shifted; confirmed at source).
- `cargo check --workspace` clean incl. ql-bindings-node `assert_send`.

## Files changed (audit-fix)
- `crates/ql-exec/src/workbook_runtime/recompute.rs` — recompute_all wrapper split (HIGH-1) + honest spill
  comment (HIGH-2).
- `crates/ql-exec/src/session.rs` — `open` → preserving variant (HIGH-1); `set_udf_worker_checked` +
  `close()` worker-drop (HIGH-3); +3 tests.
- `crates/ql-bindings-node/src/lib.rs` — napi setUdfWorker uses the gated setter (HIGH-3) +
  handshakeTimeoutMs cap (LOW) + doc/error updates.

## NEXT
IDE Step 5 (cross-repo `feat/visualise-v1`) must add: the 3 worker error codes + `invalid_state`/
`session_busy` to the allowlist; call `setUdfWorker` off the UI thread; render `CellDiagnostic`. Then a
cdylib rebuild + node smoke + IDE tsc/mocha, then doc-sync (mark D/C/G CLOSED in design §top), then 6.4-4.
