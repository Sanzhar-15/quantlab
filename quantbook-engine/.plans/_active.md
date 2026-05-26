---
name: 2026-05-26_phase-5-7-v3-6-1-delta-consumer-backlog
status: |
  IN-PROGRESS — V3.6.1 backlog cleanup mini-phase (realizes V3.6 deferred items).

  **OPUS-PT-B10 SHIPPED 2026-05-26** (cycle 1): wired the V3.6.0.8 D6 incremental
  `workbookSnapshotDelta` engine API into the IDE render path.  Pre-B10 the 228×
  delta perf win (1.08 ms vs 246 ms full snapshot at 100 new cells) was dormant —
  `CellGridPanel.render()` called full `workbookSnapshot()` on every repaint.  Now
  `render()` acquires via the two-call delta protocol (seed → delta → fullRebuild
  re-fetch) maintaining a per-panel accumulated `WorkbookSnapshotJson`.

  Pure orchestration + merge live in `cellGridLogic.ts`
  (`acquireWorkbookSnapshotViaDelta` + `mergeWorkbookDelta`); `CellGridPanel`
  delegates via its `_deltaCache`.  Engine UNCHANGED (IDE-only TS; the napi delta
  surface was already shipped + audited + benched in V3.6.0.8).

  **Win lands on the LOCAL-edit repaint** (the typing-latency path; `append_op`
  doesn't invalidate the cache).  Collab merged-tick + multi-panel-same-session
  correctly fall back to full rebuild (engine cache force-clear / shared-cache VV
  advance) — no regression.  Complete divergence safety net (engine's conservative
  fullRebuild allowlist + 5 invalidation sites); shape-equivalence mocha meta-test
  pins fast-path === full-path.

  Cycle accounting: cycle 1 of 2 this fresh session (within CLAUDE.md ≤2 ceiling).
date: 2026-05-26
predecessor_plan: .plans/_archive/2026-05-24_phase-5-7-v3-6-on-pop-format-registry-rendering.md (V3.6 PHASE TERMINATION CLEAN at engine 1465b1db4c4 + IDE 64d95a5d52c; 9-decision arc D1-D6+D8+D9 SHIPPED + audited; V3.6.0.X phase-termination 3-lane megaudit + CONVERGENT-HIGH-1 closure; only D7 #REF! conditional)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: |
  V3.6.1 — realize / close the items the V3.6.0.X phase-termination megaudit
  deferred (OPUS-PT-B8/B9/B10) plus opportunistic hygiene.  B10 (IDE delta
  consumer) is the highest-leverage: it converts the already-built+audited D6
  engine perf into a felt user-facing gain on the typing-latency path.
current_engine_head: <this commit, V3.6.1 plan-file hygiene — archive V3.6 plan + create this V3.6.1 plan; engine SOURCE unchanged at 1465b1db4c4> ← 1465b1db4c4 (V3.6 phase-termination CONVERGENT-HIGH-1 closure — V3.6 PHASE CLEAN) ← prior chain
current_ide_head: <companion IDE commit this session — OPUS-PT-B10 workbookSnapshotDelta consumer: session.ts workbookSnapshotDelta wrapper + cellGridLogic.ts mergeWorkbookDelta + acquireWorkbookSnapshotViaDelta + DeltaSnapshotCache + cellGridPanel.ts _deltaCache + acquireWorkbookSnapshot delegation + render() swap + 15 mocha tests> ← 64d95a5d52c (V3.6.0.X phase-termination IDE regression) ← prior chain
current_mocha_count: 1423 passing / 0 failing / 25 pending (full `npm test` glob = qviz + quantbook suites; V3.6.1 added 15 — 8 pure mergeWorkbookDelta + 1 pure-mock protocol guard + 6 engine-backed protocol incl. shape-equivalence divergence guard + multi-panel BUG-1 pin)
current_ql_collab_tests: 158 / 158 (UNCHANGED — no engine source touched)
current_ql_oplog_tests: 67 / 67 (UNCHANGED)
current_ql_collab_ws_tests: 42 / 42 (UNCHANGED)
audit_rules_inherited: parallel Codex+Opus per phase/wave/step; range-aware fn ships need lex+parse+bind+eval; negative trait claims need positive compile proof; phase-level closures use 3-5-way megaudits.

## V3.6.1 sub-steps

1. **V3.6.1.1 — OPUS-PT-B10 IDE delta consumer** ✅ SHIPPED 2026-05-26 (cycle 1).
   - `src/quantbook/session.ts`: new typed `workbookSnapshotDelta(session, lastSeenVersion)` wrapper.
   - `src/quantbook/cellGrid/cellGridLogic.ts`: pure `mergeWorkbookDelta(cached, delta)` (upsert changedCells in sorted (row,col) position; drop sheetsRemoved; merge formatsAdded by full FormatId; apply removedCells + sheetsChanged forward-compat; advance version) + `DeltaSnapshotCache` interface + pure `acquireWorkbookSnapshotViaDelta(session, cache)` two-call orchestrator.
   - `src/quantbook/cellGrid/cellGridPanel.ts`: `_deltaCache` field; `acquireWorkbookSnapshot()` delegates to the pure orchestrator; `render()` swapped from `workbookSnapshot()` to `acquireWorkbookSnapshot()`.
   - +15 mocha tests (`quantbook V3.6.1 -- *`).  No engine source change; Rule 4 arc terminus N/A (IDE-only).
   - No-Fallbacks: `fullRebuildRequired` is an explicit designed protocol signal (re-fetch), NOT a swallowed error; deliberately NO hidden periodic resync (would mask divergence).

## Remaining V3.6.1 backlog (next cycles / sessions)

- **OPUS-PT-B9** — `WorkbookSnapshotDeltaJson.removedCells` always empty at this engine version (V3.7+ feature).  The IDE merge already handles it forward-compat (fixture-tested).  Engine-side population is V3.7+.
- **OPUS-PT-B8** — producer/replay asymmetry on `restoreSheet`/`deleteSheet` napi (out-of-range rejected producer-side, permissive on replay).  Doc-only design observation; no behavior change.
- **CellValueJson type/runtime drift cleanup** — flagged in the V3.6 phase-termination recommended-next list.
- **V-next (perf)** — hoist a shared per-session snapshot cache so multi-panel-same-session panels all get the delta fast path (today only the first panel per change does).
- **V3.6.2+ (perf)** — incremental DOM patching in the webview (postMessage cell-level updates) to also save the buildHtml + `webview.html` reassign cost.
- **V3.6.0.9 D7** — `#REF!` substitution for cross-sheet refs to deleted sheets (conditional pending user signal; not blocking).

## Verification (V3.6.1.1)
- `npm run compile` clean (strict TS).
- `npm test`: 1423 passing / 0 failing; all 15 new V3.6.1 tests ran (not skipped) + passed, incl. engine-backed shape-equivalence + multi-panel pin.
- Engine workspace tests re-run green (ql-collab 158 / ql-oplog 67 / ql-collab-ws 42); engine source untouched.
