---
title: Phase 5.3 step 2 audit synthesis (concurrent RenameSheet replay fix)
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~230k tokens) — full transcript: `2026-05-20-phase-5-3-step-2-codex.md`
  - Opus subagent (82k tokens, 462s) — full transcript: `2026-05-20-phase-5-3-step-2-opus.md`
audit_target: commit `1ed2bbba78a` (step 2 ship)
closure_commit: (this commit — step 2 audit closures)
---

## Engagement headline

**4th consecutive DIVERGENT-HIGH cycle** in Phase 5.3. Codex returned **FAIL (HIGH)** + 2 MEDIUM + 1 LOW. Opus returned **PASS-WITH-FINDINGS** (2 HIGH + 4 MEDIUM + 3 LOW). Both **CONVERGED on HIGH-1** (cross-sheet target collision still hard-fails) — independent verification of a real shipped bug.

## Convergent findings (both auditors)

| Finding | Codex severity | Opus severity | Closure |
|---|---|---|---|
| **HIGH-1**: Two peers concurrently rename DIFFERENT sheets to SAME target → `SheetRenameRejected` hard-fails replay. Same blast radius as the bug step 2 was meant to fix. | HIGH | HIGH-1 | D-2-style auto-disambiguation: catch `SheetNameError::Duplicate`, walk suffixes `X(2)`, `X(3)`, etc. up to `AUTO_RENAME_CEILING = 10_000`. New test `step2_audit_concurrent_rename_to_same_target_auto_disambiguates`. |
| **MEDIUM**: Doc drift — `op.rs:99` (Codex) / `crdt-data-model.md` row missing (Opus) about RenameSheet × RenameSheet semantics | MEDIUM | MEDIUM-1 | Updated `op.rs:99` RenameSheet docstring (advisory `old_name` + trade-off rationale). Added 3 new rows to conflict matrix table at `crdt-data-model.md:320-329`. |

## Unique to Codex

| Finding | Severity | Closure |
|---|---|---|
| Case-only renames dropped (canonical-equality idempotency check) | MEDIUM | Changed idempotency check to DISPLAY equality. New test `step2_audit_case_only_rename_updates_display_name`. |
| `op.rs:99` docs say `old_name` is "for replay-time validation" but post-step-2 it's advisory | MEDIUM | (covered above) |
| `SheetRenameNameMismatch` could use `#[deprecated]` | LOW | Added `#[deprecated]` attribute. |

## Unique to Opus

| Finding | Severity | Closure |
|---|---|---|
| Empty new_name edge case undocumented (hits `SheetNameError::Empty` → `SheetRenameRejected`) | HIGH-2 | Edge case explicitly enumerated in replay docstring. |
| Test #4 (rename + literal) lacks symmetric merge check | MEDIUM-2 | Test rewritten with bidirectional merge + assertions on both views. |
| Test #5 (3-peer) star-merge is degenerate; doesn't prove transitivity | MEDIUM-3 | Rewritten with 3 different merge orderings (BC vs CA vs AB) — genuine commutativity check. |
| `let _ = old_name;` is dead code | MEDIUM-4 | Removed during HIGH-1 rewrite. |
| Test #2 lacks bidirectional merge | LOW-1 | Test rewritten with bidirectional check. |

## Verifications recorded (no closure needed)

Both auditors confirmed:
- Production code (`ql_collab::CollabSession`) doesn't match `SheetRenameNameMismatch` — ABI-safe.
- Undo path doesn't emit `RenameSheet` (Loro retracts via UndoManager; no counter-op) — no undo regression.
- qbook envelope load doesn't invoke RenameSheet replay — no loader regression.
- Producer-side `WorkbookRuntime::rename_sheet` validates old_name at write time, so the advisory replay relaxation only matters for malformed logs.
- The 3 calamine_smoke failures under parallel test runs are the pre-existing temp_dir race from D-1 step 8 megaudit — unrelated to step 2.

## Pre-noted for step 4 (from step 1 audit)

`apply_rename_table` (`replay.rs:691`) + `apply_rename_column` (`replay.rs:749`) have the IDENTICAL bug shape AND **also need the HIGH-1 auto-disambiguation fix** when step 4 ships. Step 4 plan already updated to reflect this.

## Closure metrics

- Original step 2 ship: 5 tests + replay handler unification (HEAD `1ed2bbba78a`).
- After closure: 7 tests + replay handler + auto-disambiguation loop + display-equality idempotency + variant deprecation + 3 new conflict matrix rows.
- Workspace tests: 4305 → 4307 (+2) with `--test-threads=1`.
- Files modified: 4 (replay.rs, op.rs, test file, crdt-data-model.md).
- fmt + clippy: clean.

## Audit-discipline observation

The 4-cycle divergent-HIGH pattern (D-1 steps 5/6/7 + 5.3 step 1) extends to 5.3 step 2. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 3 + step 4 + step 5 megaudit) should expect the same.

**Worth noting**: the audit caught a bug introduced WHILE FIXING THE PRIOR BUG. Step 2's commit message confidently claimed "Edge cases covered: rename target collision → SheetRenameRejected (unchanged)" — both auditors challenged this. The discipline of skeptical adversarial audits AFTER each ship continues to find real issues that confirmation bias on the engineer's side would miss.

## Forward implications

- **Step 3 design**: the row 7 conflict-matrix test (in step 1's phase_5_3_conflict_matrix_probe.rs) still pins pre-fix `#NAME?` behavior; step 3 modifies it. Step 2's audit closure now also has multiple new doc-table rows that step 3 must keep consistent.
- **Step 4 scope**: extension to RenameTable + RenameColumn now MUST also include HIGH-1's auto-disambiguation pattern. Plan updated.
- **Step 5 megaudit**: should explicitly probe the empty new_name edge case + reserved-character paths in the wire-format-only producer scenario.
