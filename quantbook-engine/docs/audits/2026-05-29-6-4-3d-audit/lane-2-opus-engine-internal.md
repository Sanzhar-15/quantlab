# Lane 2 — Opus fresh-context, engine-internal (D2/C1/G/D1 soundness)
Verdict: **SHIP-WITH-FIXES** · HIGH 2 · MED 1 · LOW 3 · 61 tool uses / 135k tokens.
(Built ql-bindings-node clean; 773 ql-exec lib tests pass; reproduced both HIGHs with temp tests.)

## HIGH-1 — Undo/redo silently BLANKS UDF cells (and corrupts dependents) on a no-worker session
`session.rs` `rematerialize` (runs on undo/redo) → `replay_into` restores formula TEXT only (never
re-writes computed values) → `recompute_all` now passes preserve=true → the preserve branch does
`workbook.read(addr)` which returns `Blank` after replay → writes Blank + skips eval. Reproduced: after
`undo`, `B1=MYUDF(A1)` (saved 42) → Blank, `C1=B1+1` → **1.0** (silent wrong). Pre-6.4-3d undo recomputed
to a visible `#CALC!`. FIX: do not let preserve fire under rematerialize/recalc_all — only `open`.

## HIGH-2 — Saved spilled-UDF arrays collapse on open with no worker
`.qbook` does not persist spill target cells (rebuilt by recompute); the D2 early-return reads only the
anchor scalar + returns `None,None` spill shapes + skips the boundary eval that re-registers the spill.
Reproduced: `B1=MYUDF(A1)` spilling `{10;20}` → open no-worker → B1=10, B2=Blank (footprint lost). FIX:
re-materialize the saved spill, or do not claim spill preservation without a worker (mark anchor #CALC!).

## MEDIUM-1 — `open` reuses the live worker with NO trust gate
D1 preserves the worker across the swap, then `open` recomputes against it → opening any workbook in a
worker-session auto-executes its `=MYUDF(..)` against the live Python process. Design doc flagged
"reusing a live worker across opening an untrusted workbook is a trust decision." FILE/gate at the IDE.

## LOW
- LOW-1: over-tracking multi-cell literal-range args for value-independent ref fns (ISFORMULA/FORMULATEXT)
  — correct result (VEQ-skips), small perf cost; bounded to ReferenceArg.
- LOW-2: standalone `WorkbookTransaction` commit emits no UDF diagnostic (test-only-reachable).
- LOW-3: diagnostic asymmetry — no-worker `set_formula` emits `udf_no_worker`; a later no-worker
  recalc/open (preserve) does not. Cosmetic.

## Verified CLEAN
G borrow/re-entrancy (disjoint RefCells; push holds borrow only for the push, never across worker.call);
G drain coverage (both with_runtime variants drop(guard) then drain; no dispatch path leaks); G panic-
freedom + `into_plan_cache` releases the borrow so `drain_udf_diagnostics(&mut self)` is callable;
C1 storage-gate includes literal_ranges + name-agnostic cleanup + idempotent double-registration;
D1 drop-order (take→`*self=` drops None→restore; panic before restore reaps the local; no leak);
D2 recompute_dirty=false → just-registered UDF goes #NAME?→#CALC!; Send/!Sync; preserve-bool plumbing
(only recompute_all=true / recompute_dirty=false — the rematerialize inheritance is HIGH-1).

Root cause of both HIGHs: the preserve heuristic assumes `workbook.read(addr)` holds a trustworthy saved
value — true for `.qbook` open + live recalc_all, FALSE for op-log replay (rematerialize) and spill
targets (never persisted).
