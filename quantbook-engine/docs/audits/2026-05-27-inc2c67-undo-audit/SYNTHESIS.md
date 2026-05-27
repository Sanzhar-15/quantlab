# 6.1B inc.2c-6 (F2 `Op::ClearValue`) + inc.2c-7 (undo/redo): parallel Codex + Opus audit synthesis

**Date:** 2026-05-27 · **Targets:** the F2 Blank-durability fix (`Op::ClearValue`, committed `d8d22a04248`) and the undo/redo implementation on `WorkbookSession` (uncommitted at audit time).

**Method:** the standard parallel audit-discipline pair, both read-only, both verifying at source — and both notably deep (the Opus lane read the Loro 1.12.0 `undo.rs` internals to verify the merge-interval/grouping model; the Codex lane read `loro` integration tests + `replay_into`/`repair.rs`).
- **Codex** — `gpt-5.5`, `xhigh`, read-only (prompt `.codex-6-1b-inc2c67-undo-audit-prompt.md`, raw `.codex-6-1b-inc2c67-undo-audit.out`).
- **Opus** — `general-purpose` sub-agent, same scope.

## Verdict: the two load-bearing claims are CORRECT; one real silent-data-loss bug found + fixed.

Both reviewers independently **verified at source**:
- **Q1 — undo-unit granularity.** Every `WorkbookSession` mutating command emits exactly ONE Loro commit (single op or one `Op::BatchCommit`) EXCEPT `rename_table`/`rename_column` (the F10 `RenameTable/Column` + per-cell `PutFormula` loop), which are wrapped in `grouped()` (`group_start`/`group_end`). Both built the full per-command commit-count table; no other ungrouped multi-commit command exists. `resize_table` is one append. Confirmed against Loro `undo.rs:549-557`: with `set_merge_interval(0)`, each commit outside a group is its own undo unit; grouped commits merge into one.
- **Q2 — replay re-materialization fidelity.** After a Loro undo, `OpLog::iter()`/`replay_into` yields the post-undo (compacted) op list; `replay_into` ALONE faithfully reproduces sheet/table/column renames for a LINEAR single-writer log (the ql-collab repair passes are documented as concurrency-only, `repair.rs:45`). No divergence.
- **Q3 recompute detachment** (no spurious ops/commits), **Q4 token/delta coherence** (epoch bump → EpochMismatch, change-log cleared), **Q5 F2 ClearValue** (replay guard identical to PutValue; `put_at(Blank)` truly clears; all producers covered), **Q6 lifecycle/No-Fallbacks** (gated Ready; empty stack → consumed:false; `group_end` always runs; no swallow) — all verified clean.

## The one real finding (both reviewers; severity split) — FIXED

| Sev | Finding | Disposition |
|-----|---------|-------------|
| **Codex HIGH / Opus M1** | `from_workbook(populated_workbook)` builds the graph from the passed workbook but starts a **fresh empty `OpLog`**; `rematerialize` replayed from `Workbook::new()` + only post-construction ops → a consumed undo **silently dropped all pre-loaded content** (and redo could fail replay for lack of an `AddSheet`). Not reachable through the wired v1 surface today (only `new()`/empty is wired; `open`/`import` are `Capability` stubs) — but `from_workbook` is a **public** constructor and this becomes a live data-loss HIGH the instant persistence lands. | **FIXED (inc.2c-7).** Added a `baseline: Workbook` field (the construction-time workbook clone); `rematerialize` now replays the post-undo op-log onto a CLONE of the baseline, not a fresh empty workbook. Identical/trivial for the empty `new()` path; preserves pre-loaded content for populated sessions; forward-compatible with `open`/`import` (they set `baseline = loaded`). Makes "you cannot undo past the point the workbook was opened" the correct semantic. Regression test `undo_preserves_prepopulated_baseline_workbook` (edit → undo → baseline survives → redo re-applies). |

## Remaining findings — disposition

| Sev | Finding | Disposition |
|-----|---------|-------------|
| **MEDIUM** | `rename_table`/`rename_column` are not append-before-mutate atomic (the pre-existing **F10** gap: `RenameTable/Column` + interleaved per-cell `PutFormula`); a mid-loop append failure leaves a partial log, which `grouped()` then brackets as one (torn) undo unit. | **TRACKED, not fixed here** (consistent with the inc.2 audit F10 decision). PRE-EXISTING (not introduced by undo); near-zero reachability (only a Loro-internal/OOM append failure mid-loop, on a `String` serialize); fails loud. The proper fix = collect rename + formula-rewrite ops into one `Op::BatchCommit` before mutating (mirror `rename_sheet`); folded into the persistence increment. Undo's `grouped()` is correct for the success path (one undo reverts the whole rename). |
| **LOW (L1)** | Silent 100-step undo cap (Loro's `set_max_undo_steps(100)` default, not overridden). | **DOCUMENTED** on the `undo_manager` field (bounded retention is intentional for v1, mirrors `ops`/`events`/`change_log` bounds; configurable depth = later increment). |
| **LOW (L2)** | Granularity asymmetry: `rename_sheet` uses an internal `BatchCommit`; `rename_table`/`column` use `grouped()` over N+1 appends. | Cosmetic; resolves with the F10 fix above. |
| **LOW (L3)** | `state_seq += 1` after `bump_epoch()` in `rematerialize` is redundant for correctness (epoch change alone forces EpochMismatch). | Left as-is (harmless; keeps the logical clock monotonic forward, consistent with move/restore). |

## Result
ql-exec lib **709/0** (692 baseline + 16 undo + 1 baseline-regression), clippy clean, workspace `cargo check`/`build` green after the fix.
