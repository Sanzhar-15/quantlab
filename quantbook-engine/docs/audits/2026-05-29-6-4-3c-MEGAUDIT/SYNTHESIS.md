# Phase 6.4-3c UDF eval wiring — 5-way MEGAUDIT SYNTHESIS

**Date:** 2026-05-29 · **Audited:** `git diff 88c0dc5836a..a9ef3f252ca` (the full 6.4-3c
increment = original wiring `88406c32b70` + the 3-way audit-fix `a9ef3f252ca`), with PRIMARY
emphasis on the 570-line audit-fix delta that the 3-way audit had not itself reviewed (the
`marshal_udf_args` rewrite + the transaction worker-threading). Code HEAD at audit time
`a9ef3f252ca`.

This megaudit was requested AFTER the 3-way audit shipped — it is broader (5 lanes vs 3),
deeper (distinct non-overlapping deep lenses), and explicitly re-audited the audit-fix code.

## Lanes (all preserved alongside this file)

| Lane | Reviewer | Focus | Verdict | H/M/L |
|---|---|---|---|---|
| 1 | Codex `gpt-5.5` `xhigh` | audit-fix correctness + full increment | **DO-NOT-SHIP** | 1/2/0 |
| 2 | Codex `gpt-5.5` `xhigh` | pathological / liveness / graph correctness | **DO-NOT-SHIP** | 3/3/1 |
| 3 | Opus | deep-dive on `marshal_udf_args` | SHIP-WITH-FIXES | 0/1/1 |
| 4 | Opus | concurrency / lifecycle / soundness | **SHIP** | 0/0/3 |
| 5 | Opus | semantics / calc-graph / persistence | SHIP-WITH-FIXES | 1/2/3 |

The 5-way earned its keep emphatically: it surfaced **5 findings the 3-way missed**, including
**a regression the 3-way's own fix introduced** and **two pre-existing correctness bugs in shipped
code** (one of them a *known, parked* bug). All claims below were re-verified against the actual
source by the orchestrator before action.

## Reconciliation & disposition

| # | Finding | Lanes | Severity | Disposition |
|---|---------|-------|----------|-------------|
| A | `eval_at_cell_boundary` Unified arm missing `StructuredRef` materialization → `=TRANSPOSE(Table[Col])` (direct AND as a UDF arg via the audit-fix) gets `#CALC!`/wrong input | Codex-A HIGH, Opus-marshal MED | HIGH | **FIXED** — added the arm; un-ignored the parked `i23` test that documented it |
| B | `WorkbookSession::mark_volatiles_dirty` bypasses fanout → dependents of a volatile UDF (and RAND/NOW) stay STALE | Codex-B HIGH | HIGH | **FIXED** — call `graph.mark_volatile_dirty()`; new regression test |
| C | Multi-cell LITERAL `RangeRef` args of a Reference-context UDF not dep-tracked → editing the range doesn't recompute | Codex-B HIGH | HIGH (narrow) | **DOCUMENTED + FILED** — needs a literal-range value-dep mechanism that doesn't exist; the common Aggregate+named-range path IS tracked |
| D | `open`/`import`/load recompute UDF cells with `udf_worker:None` → destroys saved values (`#CALC!`) | Opus-sem HIGH, Codex-A MED, Codex-B LOW | HIGH (latent) | **DOCUMENTED as a HARD 6.4-3d BLOCKER** — no product injection path at 6.4-3c; correct fix = 6.4-3d worker-on-open + trust gating |
| E | Spill targets under-reported in `snapshot_delta` | Codex-B HIGH | HIGH (pre-existing) | **= the tracked 6.1C H3** (affects ALL array formulas); UDF spills inherit it; invasive fix deferred to 6.3 |
| F | Wasted eval of later args when result is doomed `#VALUE!` (side-effects/latency) | Codex-A MED | MED | **DOCUMENTED** — correctness-neutral; short-circuit filed-forward |
| G | `#CALC!` conflates no-worker / raised / died | Opus-sem MED | MED | **FILED** — CellDiagnostic sink (6.4-3d) |
| H | Per-call 30s deadline → N×30s aggregate stall under the napi mutex | Codex-B MED, Opus-sem MED | MED | **already documented** (3-way); op-level budget filed for 6.4-3d |
| I | No pre-materialization cap for huge UDF arg/result grids | Codex-B MED, Opus-conc LOW | MED | **FILED** — grid cell/byte cap before read/encode |
| J | napi boundary lacks `catch_unwind` | Codex-B MED | MED | **= the tracked 6.3 M1** (`#[napi(catch_unwind)]`); dispatch is panic-free so unreachable via UDFs today |
| K | respawn handshake budget starvation; recursion depth cap; missing nested-UDF / persistence / unregister tests | Opus-conc/marshal/sem LOW | LOW | **FILED** (added a nested-UDF concern note; the others filed-forward) |

### CLEAN by ≥1 engine lane (verified)
RefCell re-entrancy (no overlapping `borrow_mut` for nested UDFs), double-evaluation (each arg
once), Send/`!Sync` (`+ Send` everywhere; no parallel path carries a worker-bearing env),
FaultGuard panic-freedom (all new panic sites provably unreachable), worker death/respawn/Drop,
deadlock (no engine lock the worker needs), transaction worker-threading lifetime soundness, the
two `unreachable!`s + boundary `.expect`, the shape rule, error-arg forwarding.

## Fixes applied this cycle (megaudit-fix)

1. **A** — `scalar.rs` `eval_at_cell_boundary` Unified arm: added the `StructuredRef` arm
   (narrow `[@]`, `read_range_with_shape` → `FunctionArg::Range`), mirroring the scalar Unified
   arm (scalar.rs:280-295). Fixes directly-typed `=TRANSPOSE/FILTER(Table[Col])` AND the UDF-arg
   path the audit-fix opened. **Un-ignored** `i23_transpose_over_structured_ref` (a parked Phase
   4.12 investigative test that documented this exact bug) and converted it to a hard assertion.
2. **B** — `session.rs` `mark_volatiles_dirty`: replaced the manual per-node
   `graph.mark_dirty(node)` loop (no fanout) with `graph.mark_volatile_dirty()` (marks + fans out
   transitive reverse-deps). New test `mark_volatiles_dirty_fans_out_to_dependents_of_volatile_udf`.

## Tests (+2, −1 ignored)
- `mark_volatiles_dirty_fans_out_to_dependents_of_volatile_udf` (proves B: a counting volatile UDF
  `B1`, `C1=B1+1`; after F9 both advance — the bug left `C1` stale).
- `i23_transpose_over_structured_ref` un-ignored + asserted (proves A: `TRANSPOSE(T[X])` now equals
  `TRANSPOSE(TRange)` = `1.0`, no longer `#CALC!`).

## Verification
- `cargo test -p ql-exec --features xlsx-write` → **769 lib + all integration suites 0 failed**
  (i23 now passes; 34 still-ignored investigative tests remain).
- `cargo test -p ql-exec --test udf_e2e` → **1/1** real-python.
- `cargo clippy -p ql-exec --all-targets` → **no new warnings** (4 lib + 7 test, pre-existing).
- `cargo check --workspace` → clean incl. `ql-bindings-node` `assert_send`/`assert_sync`.
- Cargo.lock unchanged.

**Verdict: SHIP** (after fixes A + B). Two real bugs fixed (one a regression from the 3-way's own
fix, one a known-parked pre-existing bug); the remaining HIGHs are either pre-existing-tracked (E),
a latent 6.4-3d-lifecycle blocker not reachable in the product today (D), or a narrow
needs-new-mechanism gap on an advanced config (C) — all documented and filed, none a silent
shipping wrong-result on the common path.

## HARD blockers recorded for 6.4-3d (must be closed before worker injection ships)
- **D** — `open`/`import` must preserve/inject the worker (trusted-workspace-gated) and NOT
  recompute UDF cells to `#CALC!`, OR preserve cached UDF values when no worker is present.
  Shipping injection (6.4-3d) without this is data-loss on reopen.
- **C** — literal-range value-dep tracking for Reference-context UDF args.
- **G** — CellDiagnostic sink (distinguish no-worker / raised / timeout / died).
- **H/I** — op-level recalc budget + per-call cancel; grid size caps.
