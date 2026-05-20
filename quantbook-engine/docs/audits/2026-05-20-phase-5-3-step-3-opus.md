---
title: Phase 5.3 step 3 audit — Opus subagent verdict
date: 2026-05-20
audit_target: commit `e76a9ce5499` (step 3 ship) + `4222d11fe7b` (lockfile)
auditor: Opus subagent (independent of engineer)
tokens_used: 82688
tool_uses: 27
duration_ms: 251883
verdict: PASS-WITH-FINDINGS (1 HIGH, 4 MEDIUM, 4 LOW)
---

## Verdict: PASS-WITH-FINDINGS

Step 3 ships the core mechanism correctly for the row-7 single-rename-single-formula case, and the test pattern is sound — bidirectional convergence + BatchCommit traversal are genuinely defensive. But the algorithm has one real **silent data-corruption bug** when two sheets' rename chains touch the same historic name (HIGH-1), and three structural concerns that compound in step 4.

## HIGH-1: Cross-sheet historic-name CASCADE corruption

**File**: `crates/ql-collab/src/repair.rs:181-198`

**What**: The module docstring claims the cross-sheet ambiguity limitation produces a "later in iteration wins" outcome. The code does something WORSE: it applies rules sequentially in a `for (old, new, _) in &rules { if let Some(rewritten) = ...{ current_text = rewritten } }` loop, so a formula gets **cascaded through every matching rule**.

**Scenario**: Sheet 0 was named `S`, renamed to `A`. Sheet 1 was named `A`, renamed to `C`. Repair builds two rules in sheet-id order:
- Rule 1: `(S → A, sheet=0)`
- Rule 2: `(A → C, sheet=1)`

Concurrent formula `=S!X` (intended for original sheet 0):
1. Rule 1 fires: `=S!X` → `=A!X`
2. Rule 2 fires on the just-rewritten text: `=A!X` → `=C!X`

Final: `=C!X` (sheet 1) — but user authored `=S!X` to reference what is NOW sheet 0 (current name `A`). The formula was silently retargeted to a different sheet. **Silent semantic data corruption.**

**Closure**: skip rules where `old_canonical` is currently held by ANY sheet. Closes BOTH the cascade scenario (Codex+Opus HIGH-1) AND the historic-name-reused scenario (Codex HIGH-2) with a single guard. `RepairReport.ambiguous_rules_skipped` surfaces skipped rules for diagnostics. New regression test `step3_audit_cross_sheet_cascade_does_not_corrupt_formula`.

## MEDIUM-1: Helper duplication is a maintenance bomb

**Files**: `crates/ql-collab/src/repair.rs:243-262` and `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60`

**What**: `rewrite_formula_with_rename` is a near-identical copy of `rewrite_formula_text_for_sheet_rename`. Step 4 (RenameTable + RenameColumn) will need the same treatment — landing the lift now prevents three helpers from diverging.

**Closure status**: **DEFERRED to step 4** (out of step-3 audit scope). The unification is a step-4 prep task; documented in `.plans/_active.md` step 4 description.

## MEDIUM-2: No-op fast-path missing

**File**: `crates/ql-collab/src/repair.rs:181-198`

**What**: Even when `rules` is empty (no rename ops in the log), the code walks every formula. For a 100k-formula workbook with zero renames — the steady state — this is pure overhead.

**Closure**: added `if rules.is_empty() { return ... }` early return after rule building.

## MEDIUM-3: Production wiring is missing and undocumented

**What**: Step 3 ships `repair_sheet_rename_chain` as a `pub` symbol but no production caller invokes it. Only the row-7 test + the 10 tests in `repair_renames.rs`.

**Why it matters**: The V1 user-visible promise (closing the D-3 limitation) is only delivered when callers add the line. Without it, Phase 5.5 V2 WebSocket transport ships with the bug step 3 was meant to fix.

**Closure status**: documented as deferred follow-up in module docstring + plan file. Production wiring (`CollabSession::repair_on_merge` toggle OR caller-side opt-in) is a separate work item.

## MEDIUM-4: Test 7's `'X(2)'!B1` assertion is brittle past `(` and `)`

**What**: Test asserts a specific printer-quoting output, which couples the test to printer internals. Step 2's auto-disambiguation suffix uses `(N)` so the quote behavior is exercised — but the test doesn't cover (a) names with embedded spaces, (b) embedded `'` requiring `''` escape.

**Closure status**: **Deferred**. The current assertion is correct for `X(2)` and the printer's behavior is stable. Test extension is a tightening, not a closure for an actual bug.

## LOW-1: Tests never exercise cross-sheet formula references

**Closure**: added `step3_audit_cross_sheet_formula_reference_gets_rewritten` — formula on sheet T references renamed sheet S, asserts rewrite happens regardless of formula's holder sheet.

## LOW-2: Test 10 multi-occurrence assertion is weak

**Closure**: strengthened `repair_report_carries_diagnostic_information` to pin BOTH occurrences (`Calculations!A1` AND `Calculations!B2`) explicitly.

## LOW-3: `Cargo.lock` separate-commit hygiene

**Closure status**: noted; future commits will fold lockfile into the ship commit.

## LOW-4: `_origin_sheet` field in `rules` was dead code

**Closure**: now USED for `RepairReport.ambiguous_rules_skipped.origin_sheet`.

## Independence checks (verified)

- D-2 auto-rename prevents IDENTICAL concurrent name collisions, but NOT historic-name reuse — sheet 0 dropping name `A` and sheet 1 then renaming to `A` is normal sequential edit. The audit closure handles this case correctly.
- Producer-side helper at `sheets.rs:37-60` is identical to repair.rs's local helper. Drift risk remains for V1; unification deferred to step 4.

## Synthesis

Step 3 ships the core mechanism correctly for the happy path. HIGH-1 is the one to close before step 4 — fixing it after step 4 doubles the rule space. Closed with the `old_canonical-currently-held` guard, which is a tight + small change with both HIGH scenarios covered. The MEDIUM/LOW findings split between immediate-fix (no-op fast path, test strengthening, dead code) and deferred (helper unification, production wiring, printer-output brittleness) — three of the deferred items are pinned for step 4 / future production wiring respectively.
