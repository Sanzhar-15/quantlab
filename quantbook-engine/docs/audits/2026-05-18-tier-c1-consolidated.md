---
audit: Tier C1 — cycle detection in recompute_all (consolidated)
auditors: Codex + Opus subagent (parallel pass, 2-way)
date: 2026-05-18
commit_under_review: 3451d90a03f
closures_landed_at: <head-after-this-commit>
companion_docs:
  - docs/audits/2026-05-18-tier-c1-codex.md
  - docs/audits/2026-05-18-tier-c1-opus.md
---

# Tier C1 audit — consolidated findings + closure summary

Parallel 2-way audit per the engine audit-discipline rule
(`memory/quantbook_engine_audit_discipline.md`): Codex run on host,
Opus subagent in read-only Explore mode. Both auditors read
`recompute_all`, `recompute_dirty` (for comparison), and
`rebuild_from_workbook` + `schedule_dirty` contracts.

## Unique HIGHs surfaced

Codex caught **2 HIGHs** Opus missed. Opus caught **1 HIGH** Codex
missed.

### Codex H-1 — cycled `#CIRC!` written lazily inside HashMap loop

File: `crates/ql-exec/src/workbook_runtime.rs` line 3044 (pre-fix).

Pre-fix code wrote `#CIRC!` for cycled cells inside the eval
loop, not in a pre-pass. A non-cycled dependent (`B1=A1+1` where
`A1=A1+1`) could evaluate before A1 was overwritten — reading
A1's stale prior value instead of `#CIRC!`. `iter_formulas()` is
explicitly arbitrary order (`crates/ql-storage/src/workbook.rs:929`).

**Closure:** pre-pass added before main loop; all cycled cells
get `#CIRC!` (and spill cleanup, per H-2) before any non-cycled
eval runs. New regression test
`recompute_all_dependent_of_cycle_propagates_circ_error`.

### Codex H-2 — old-spill dissolution bypassed for cycled cells

File: `crates/ql-exec/src/workbook_runtime.rs` line 3050 (pre-fix).

Pre-fix cycled-cell short-circuit bypassed
`try_recompute_with_simd_profile` which itself runs spill cleanup
on shape change (line 3681). A previously-spilling anchor
(`A1 = SEQUENCE(3)` spilled into A1:A3) overwritten with a
circular formula left stale spill targets in A2/A3.

**Closure:** pre-pass calls `clear_spill_if_present((sheet, row,
col))` before writing `#CIRC!`. New regression test
`recompute_all_clears_stale_spill_when_anchor_becomes_circular`.

### Opus H-1 — bind-failed nodes potentially in cycled set

File: `crates/ql-exec/src/calcgraph_session.rs` lines 892–921.

Bind-failed formula nodes are inserted into the session's cell
index with zero outgoing edges. The ambiguity: could Tarjan ever
place them in `cycled`? Tarjan only emits a node in `cycled` if
it is in a non-trivial SCC or has a self-loop — neither applies
to zero-edge nodes. So `cycled` correctly excludes them.

**Closure:** in-code comment in `recompute_all`'s docstring
documents the safety argument. No code change needed; the eval
loop's existing parse/bind error path correctly surfaces these
formulas to `failures`.

## MEDIUMs deferred to v2 backlog

| Source | Issue | File:line | Disposition |
|---|---|---|---|
| Codex M-1 | Spill-target producer-alias cycles missed on cold load (spill state not restored from `.qbook`) | `qbook_format.rs:3480`, `calcgraph_session.rs:724` | Defer — Phase 5 spill-replay work |
| Codex M-2 | `replay_into` doesn't end with `recompute_all` | `replay.rs:296` | Defer — Phase 5 prep (replay-callsite cycle-detection wrapper) |
| Codex M-3 | `build_range_supplemental` is `O(\|dirty\|² × avg_ranges)` on full-dirty cold load | `calcgraph_session.rs:1677` | Defer — Tier C1-perf v2 backlog |
| Codex M-4 / Opus M-2 | 2× parse cost (rebuild + recompute) on cold load | `workbook_runtime.rs:3008` | Defer — Tier C1-perf v2 backlog |
| Opus M-1 | Test coverage gaps: 3-cycle, range cycle, named-range cycle, cross-sheet cycle, table-column cycle | `workbook_runtime.rs:4619` | Defer — Tier C1-coverage v2 backlog |

## LOWs closed in this commit

- **Codex L-1**: doc comment said "no graph awareness" — outdated.
  Updated to mention the ephemeral cycle-detection pre-pass.
- **Opus L-1**: in-loop comment claimed "matches `recompute_dirty`'s
  contract" — imprecise. Rewritten to say "matches cycled-cell
  accounting" with explicit note that VEQ logic is intentionally
  absent.
- **Codex L-2 (test coverage)**: see Opus M-1 deferral.

## OK confirmations (both auditors agree)

- Ephemeral session isolation: dropped before any workbook
  mutation; aggregate cache cleared at rebuild end.
- `cell_node_for` None handling: guarded by `is_some()`.
- Loader path inherits fix transparently
  (`loader.rs:63` calls `recompute_all`).
- `#[non_exhaustive]` interaction with `RuntimeError`: partial-
  match pattern works correctly.

## Test count

- Pre-audit: 4135 baseline + 4 Tier-C1 tests = 4139.
- Post-audit: 4139 + 2 audit-closure tests = **4141 passing, 0 failed.**

## Forward work (v2 backlog updates)

Add three new Tier C1-followup items to `docs/PHASE-4-V2-BACKLOG.md`:

- **C1.a (perf)**: thread `rebuild_from_workbook`'s bound plans
  forward into `PlanCache` so the eval loop reuses the binds.
  Estimated effort: 1-2 days. Trigger: bench shows > 5 % of cold-
  load time is double-parse.
- **C1.b (perf)**: full-dirty scheduler path for
  `build_range_supplemental` using per-sheet row/col stripe
  lookups instead of `O(\|dirty\|²)`. Estimated effort: 2-4 days.
- **C1.c (coverage)**: add `recompute_all` regression tests for
  3-cycle, `SUM(A:A)` self-loop, named-range cycle, cross-sheet
  cycle, table-column cycle. Estimated effort: half a day.
- **C2 (replay-callsite cycle wrapper)**: existing v2 backlog
  entry stays; Codex M-2 confirms `replay_into` itself does not
  call `recompute_all`, so Phase 5 replay wrappers must call it
  before exposing values.
