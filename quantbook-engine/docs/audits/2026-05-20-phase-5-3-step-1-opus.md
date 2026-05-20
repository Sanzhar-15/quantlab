---
title: Phase 5.3 step 1 audit — Opus subagent verdict
date: 2026-05-20
audit_target: commit `a6babc65b51` (step 1 ship `5595d8dcfb0` + fmt-reconcile `a6babc65b51`)
auditor: Opus subagent (independent of engineer)
tokens_used: 100641
tool_uses: 42
duration_ms: 423199
verdict: PASS-WITH-FINDINGS (1 HIGH + 3 MEDIUM + 2 LOW)
---

## Verdict: PASS-WITH-FINDINGS

The 8 tests at HEAD `a6babc65b51` are well-engineered overall and the `fork_with_peer` discovery is a real load-bearing structural insight. 7 of 8 tests correctly pin the property they claim. One test (row 3) is degenerate, and there are gaps in matrix-doc/test-doc alignment and in the plan's risk modeling for step 4.

## Findings

### HIGH-1 — Row 3 is degenerate by coincidence

**File**: `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:220-248`

**What**: The test uses literal `7.0` and formula `3+4` (which evaluates to `7.0`). The final assertion `assert_eq!(a1_a, Value::Number(7.0))` is satisfied regardless of which op wins causal order:
- The `Workbook::read` cascade prefers user-overlay over computed-overlay (`column.rs:6-30`).
- `put_at` deliberately does NOT clear pre-existing `formula_cells` (`workbook.rs:809-814`), so after replay, BOTH user-overlay=7.0 AND formula_cells["3+4"] exist regardless of causal order.
- The formula evaluates to the same number as the literal, so even if the read cascade were broken, the assertion would still pass.

**Why it matters**: A regression where `put_at` STARTS clearing formula_cells, or where the read cascade flips to prefer computed-overlay, or where one op silently no-ops, would all leave this test green while the property is broken. The test is a tautology for this input.

**Fix**: change one side so the two outcomes are observably distinct. E.g. literal=`7.0`, formula=`"99-50"` (=49). Then assert `a1_a == Value::Number(7.0) || a1_a == Value::Number(49.0)`. Better yet, ALSO assert `formula_cells.contains_key((0,0,0))` or some structural witness so we pin BOTH the final read AND the storage shape.

**Closed**: Step 1 closure commit. Row 3 now uses literal=7.0 + formula="99-50"=49.0 (distinct); asserts `formula_at` convergence; match on Number(7.0) (literal wins) vs Number(49.0) (formula wins).

### MEDIUM-1 — Step 1 test coverage doesn't match design doc matrix scope

**File**: `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:20-27` AND `docs/architecture/crdt-data-model.md:320-329`

**What**: The test file's prelude lists 7 rows; the design doc's matrix has 9 rows (rows 8 + 9 are `RenameSheet × concurrent edit` and `DropTable × concurrent edit referencing T`). Row 7 in the test is actually doc-row 9 (DropTable). Doc-row 8 (RenameSheet × edit) is deferred to step 2 — but the test file doesn't say that.

**Why it matters**: Step 5's megaudit + step 6's exit packet need an unambiguous "what was pinned" baseline. Right now the mapping between "design doc row N" and "test row N" is off-by-one AND incomplete.

**Fix**: relabel test file row comments to match design doc numbering, AND add explicit "rows 8-9 of the matrix deferred to step 2." Or renumber the design doc table.

**Closed**: Step 1 closure commit. Test now labels rows 1-8 matching design doc; added new `row7_rename_sheet_concurrent_edit_yields_name_error_pre_step_3_fix` pinning the pre-fix #NAME? behavior (step 3 will modify the assertion to the post-fix state); renamed DropTable test to row 8.

### MEDIUM-2 — Plan misses parallel hard-fail bugs in RenameTable + RenameColumn replay

**File**: `quantbook-engine/.plans/_active.md:19-21, 95-100`

**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.

**Why it matters**: Step 4 is currently framed as an "investigation" with "~0 work or up to 1 day" estimate. The bug shape is structurally known and the fix is the same as step 2. Risk register doesn't flag step 4 as a near-certain extension of step 2's work.

**Fix**: update step 4 in `_active.md` to say "extends step 2's policy to RenameTable + RenameColumn — both have the identical `old_name` lookup gap (replay.rs:691 + 749). Likely ~0.5 day."

**Closed**: Step 1 closure commit. Plan + task #4 description updated.

### MEDIUM-3 — Row 5's BatchCommit introduces an unnecessary confound

**File**: `phase_5_3_conflict_matrix_probe.rs:312-365`

**What**: The test wraps `SetName + PutFormula` per peer in a `BatchCommit` so the PutFormula text is identical on both peers. But this makes the test pin SetName×SetName conflict under BatchCommit framing, not under naive same-cell semantics. For design-doc fidelity, row 5 entry says `SetName { foo, t_a } × SetName { foo, t_b }`, not "BatchCommit-wrapped SetName."

**Why it matters**: If we later relax BatchCommit to a different shape (e.g. one LoroList entry per inner op), this test would silently change semantics.

**Fix**: rewrite row 5 to put `PutFormula =TaxRate` into the base log; each peer appends only `Op::SetName`. Drop the BatchCommit.

**Closed**: Step 1 closure commit. Row 5 baked `PutFormula("TaxRate")` into the base log; peers race only the two SetName ops. (Converges with Codex LOW-2.)

### LOW-1 — `merged_log_round_trips_deterministically` doesn't use `fork_with_peer`

**File**: `phase_5_3_conflict_matrix_probe.rs:472-507`

**What**: Uses raw `OpLog::import_bytes(&base).unwrap()` for both peers without `set_peer_id`. The test happens to pass because it verifies wb_first == wb_second within ONE merge direction (no bidirectional merge).

**Why it matters**: Inconsistent with the discipline established by the other 7 tests. A future maintainer copies this test as a template and writes a 2-direction variant — instant convergence failure.

**Fix**: switch to `fork_with_peer(&base, PEER_A_ID)` and `fork_with_peer(&base, PEER_B_ID)`.

**Closed**: Step 1 closure commit. Switched to `fork_with_peer` for both peers.

### LOW-2 — Peer-id-stability note belongs in design doc NOW

**File**: `docs/architecture/crdt-data-model.md` § 311-334 (no mention) + § 489-496 (production peer-id wiring only).

**What**: User deferred the doc update to step 6. The test file itself carries an inline note at lines 86-96, which is good. But step 2's engineer will independently rediscover this — wasting a half-cycle.

**Why it matters**: Cheap to fix now; expensive if step 2 trips.

**Fix**: add 1-2 sentences to `crdt-data-model.md` § 311-334.

**Closed**: Step 1 closure commit. Added "Peer-id stability is a precondition for CRDT convergence" subsection to `crdt-data-model.md` § 311-334.

## Independence check — D-4

D-4's tests are NOT secretly broken. They survive random peer-ids because their assertions are direction-independent regardless of which concurrent op "wins": (a) the spill-blocking row asserts `#SPILL!`, true for both orderings since A2 is occupied; (b) the no-collision row tests cells that don't conflict; (c) the round-trip test verifies single-direction-merge determinism. None of D-4's 4 tests assert "which concrete value wins a same-cell race" — that's why D-4 didn't need `fork_with_peer`.

## Production-side peer-id setting (verified)

`CollabSession::new(peer_id)` at `crates/ql-collab/src/session.rs:175-191` AND `from_snapshot` at `:214-232` both call `log.set_peer_id(peer_id.as_u64())` and assert non-zero. The 5.3 test scaffolding `fork_with_peer` correctly mirrors production. **No production-level gap.** The user's structural insight ("CRDT convergence depends on stable peer-ids") is accurate but the production path already enforces it.

## Synthesis

Step 1 ships a real load-bearing test suite that catches 7 of the 7 matrix-row properties it intends to catch — but Row 3 is degenerate, the row labeling is off-by-one against the design doc, and the plan understates the step-4 RenameTable/RenameColumn work. The `fork_with_peer` discovery was the right call and is correctly threaded through the 7 main tests. None of the findings block step 2; HIGH-1 should be fixed before step 5's megaudit so the megaudit doesn't have to flag it. MEDIUM-1, MEDIUM-2, and LOW-2 are cheap pre-step-2 cleanups. MEDIUM-3 and LOW-1 are nice-to-haves that can roll into the step 5 megaudit closure.
