Audited the requested `a9ef3f252ca` range via `git show`/`git diff`; the live checkout is on a different dirty HEAD, so findings below are anchored to the requested commit.

[HIGH] Volatile UDF dirtying does not fan out to dependents  
`crates/ql-exec/src/session.rs:2164`, `crates/ql-exec/src/calcgraph_session.rs:1912`  
`WorkbookSession::mark_volatiles_dirty` manually marks volatile formula nodes dirty, but bypasses `CalcgraphSession::mark_volatile_dirty`, which also dirties downstream dependents. Failure: `B1=MYUDF(A1)` registered volatile, `C1=B1+1`; `mark_volatiles_dirty(); recalc_dirty()` can recompute `B1` while leaving `C1` stale.  
Fix: call `self.graph.mark_volatile_dirty()` from the session API, or replicate its fanout behavior. Add a volatile-UDF-with-dependent test.

[HIGH] Multi-cell literal UDF range args are read but not dependency-tracked  
`crates/ql-exec/src/scalar.rs:1008`, `crates/ql-exec/src/plan.rs:723`, `crates/ql-exec/src/calcgraph_session.rs:501`  
A reference-aware UDF can receive `A1:A2` as a full grid, but the graph walker only records `RangeRef` dependencies when the range is exactly 1x1. Failure: editing `A1`/`A2` does not dirty `=MYUDF(A1:A2)`, even though the UDF consumed those values. Named ranges are better covered; this bug is for literal multi-cell `RangeRef`.  
Fix: record literal range deps for value-dependent UDF args, while preserving the address-only/lazy-shape exemptions.

[HIGH] Spill target cells are written but missing from deltas  
`crates/ql-exec/src/workbook_runtime/cells.rs:741`, `crates/ql-exec/src/session.rs:1379`, `crates/ql-exec/src/session.rs:2327`, `crates/ql-exec/src/workbook_runtime/recompute.rs:172`  
`write_spill` writes every target cell, but session change logs and recompute changed-cell sets mostly record only the formula anchor. Failure: a UDF returning a 2x1 grid updates `B1:B2`, while `snapshot_delta()` can report only `B1`; if only a spill target changes and the anchor value stays equal, the delta can report nothing. Incremental clients will miss or retain stale spill cells.  
Fix: plumb old/new spill footprints into `SessionChange` and recompute changed sets, or force a full snapshot rebuild whenever spill targets may have changed.

[MEDIUM] Per-cell 30s UDF deadline can wedge the whole session for N * 30s  
`crates/ql-exec/src/scalar.rs:51`, `crates/ql-udf/src/process.rs:296`, `crates/ql-bindings-node/src/lib.rs:4691`, `crates/ql-exec/src/session.rs:2653`  
Deadline math is sane per call: absolute `Instant`, saturating remaining time, handshake included. The liveness defect is operation-level: `recalc_all` over N hung UDF cells blocks the synchronous recalc thread and the napi session mutex for roughly `30s * N`. A UDF returning at 29.9s can repeat indefinitely across cells. `cancel` is not practically reachable while the mutex is held.  
Fix: add an operation-level cancellation/budget checked between cells and inside worker calls; avoid holding the napi mutex across long recalc work, or make cancellation use an independent atomic/token.

[MEDIUM] No pre-materialization cap for huge UDF arg/result grids  
`crates/ql-exec/src/scalar.rs:1008`, `crates/ql-exec/src/env.rs:318`, `crates/ql-udf/src/process.rs:309`, `crates/ql-udf/src/frame.rs:88`  
Explicit huge ranges and large produced arrays are materialized into `Vec<Value>`/Arrow payloads before the 64 MiB frame cap helps. Open-ended ranges clamp to populated sheet bounds, but bounded full-sheet ranges, huge named ranges, or large `SEQUENCE(...)` UDF args can allocate/iterate heavily on the synchronous recalc path.  
Fix: enforce max UDF grid cells/bytes before `read_range_with_shape`, before worker encode, and before accepting worker result grids.

[MEDIUM] Panic containment still has a napi boundary gap  
`crates/ql-exec/src/session.rs:154`, `crates/ql-exec/src/session.rs:435`, `crates/ql-bindings-node/src/lib.rs:19`, `crates/ql-bindings-node/src/lib.rs:4691`  
`FaultGuard` should mark the session Faulted during Rust unwinds, and `dispatch_udf` maps normal `UdfError`s cleanly. But the Node binding explicitly does not use `catch_unwind`; a panic in an injected worker, a `RefCell` double-borrow, or an invariant panic can still cross/abort at the napi boundary rather than returning a JS error.  
Fix: add explicit `catch_unwind`/`#[napi(catch_unwind)]` around session entrypoints and convert to JS/engine errors after FaultGuard seals the session.

[LOW] `open` drops the installed UDF worker before recomputing  
`crates/ql-exec/src/session.rs:1134`, `crates/ql-exec/src/session.rs:1142`, `crates/ql-exec/src/session.rs:372`  
`open` preserves the registry, replaces `self` with a fresh session whose `udf_worker` is `None`, then recomputes. UDF formulas in a loaded `.qbook` recompute to `#CALC!` unless the host reinstalls the worker and recalculates.  
Fix: preserve the existing worker across `open`, or explicitly defer/retry UDF recompute after worker installation.

CLEAN: spill writeback handles degenerate grids as `#CALC!`, out-of-bounds as `#SPILL!`, and blocks overwriting formulas/nonblank/spill targets before writing. 1x1 UDF results take the scalar path. Error-valued cells inside returned grids spill as normal values.

CLEAN: normal worker timeout/death recovery looks coherent. `ProcessWorker` kills and clears the child, next call lazily respawns, and the `RefCell` borrow is scoped to `dispatch_udf`; I did not see a half-dead borrow or poison issue on the ordinary timeout path.

CLEAN: simple `A1` UDF args and named-range aggregate args are dependency-tracked; the graph also records `functions_used` so later registration can dirty formulas that referenced an unknown function.

Counts: HIGH 3, MEDIUM 3, LOW 1.  
Verdict: DO-NOT-SHIP until the HIGH graph/delta correctness issues are fixed.