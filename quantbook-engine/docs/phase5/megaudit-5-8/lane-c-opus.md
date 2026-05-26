Phase 5 Megaudit (5.8) — LANE C (Opus): cross-sub-phase interaction matrix.

You are auditing the COMPLETE Quantbook Phase 5 collaboration surface. PHASE-LEVEL megaudit. Read-only / audit-only. THIS LANE IS THE WHOLE POINT OF A PHASE MEGAUDIT: find bugs in the INTERACTIONS BETWEEN sub-phases that per-sub-step audits structurally cannot see. (Precedent: the V3.6.0.X CONVERGENT-HIGH-1 — RemoveSheet pruned cache cells that D8 RestoreSheet then couldn't resurface — was invisible to the per-step D8 audit because it was a D8×V3.5.0.3b-tombstone×cache-walker interaction. Find the next one.)

Repo (engine): /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
Source HEAD: `1465b1db4c4`. IDE consumer: /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab/src/quantbook/**.

The Phase 5 features, by sub-phase, that can INTERACT:
- Transport/merge (5.5 V2: auto-flush, version-vector, poll-remote, offline-queue, websocket).
- Snapshot + incremental delta (V3.5.0.2 workbookSnapshot; V3.6.0.8 workbookSnapshotDelta; V3.6.1 IDE delta consumer + per-session shared cache).
- Undo/redo (V3.4 + V3.6.0.2 Loro on_push/on_pop; partial-invalidate undo V3.5.0.6).
- Sheet ops (V3.5.0.3: rename/remove[tombstone]/move[display-order overlay]; V3.6.0.10 RestoreSheet).
- Format (V3.5.0.5 CellState.format; V3.6.0.3 RegisterFormat cache; V3.6.0.5 format-aware render + SetDateSystem).
- Tables (CreateTable/DropTable/RenameTable/RenameColumn/ResizeTable).
- Cell op-index (V3.6.0.4 cell_op_index/sheet_op_index).
- Virtualization render (V3.3 multi-sheet virtualization; mid-edit-render guard V3.5.0.7 + typing watchdog V3.6.0.11).
- Presence (V3.4 presence/cursors).

YOUR INTERACTION MATRIX — for each pair/triple, trace the code path end-to-end and find divergence/loss/stale-state. Prioritize the starred ones.
C1. ★ delta × undo/redo: undo after a delta was served; does the version token + cache stay coherent? (force_clear on undo + the IDE's shared delta cache.)
C2. ★ delta × merge_bytes/poll-remote: remote merge between two delta calls; staleness → fullRebuild correctness; does the shared per-session IDE cache (V3.6.1.2) handle it?
C3. ★ sheet-remove × delta × restore × snapshot: the full tombstone lifecycle through BOTH snapshot and delta paths (R-V3.6-19 area — confirm no residual gap; check cells written DURING tombstone window, multi-peer remove+restore).
C4. ★ format-cache × undo: undo of RegisterFormat / SetCellFormat; does format_table_cache + rendered strings stay correct? (V3.6.0.X audit-of-D2 INFO-1 claimed full-rebuild fallback; verify.)
C5. ★ moveSheet display-order overlay × snapshot/delta × remove/restore: does the display-order overlay interact correctly with tombstones + the snapshot's sheet ordering + delta sheetsRemoved? (sheet_display_order iteration.)
C6. BatchCommit × {undo, delta, cache walker}: a BatchCommit containing mixed ops (cell + sheet + format) — does the cache walker process all effects atomically? does undo of a BatchCommit invalidate correctly? does it classify_delta_op correctly (fullRebuild if it contains a metadata op)?
C7. tables × {snapshot, cache, merge}: do table ops surface in snapshot? do they merge deterministically? are they in the cache walker at all, or only in Workbook (cache-vs-workbook divergence risk like the early RemoveSheet one)?
C8. SetDateSystem / SetLocale × format render × snapshot: date-system change after cells rendered; locale passthrough; does a SetDateSystem mid-session re-render correctly via snapshot/delta?
C9. cell_op_index × undo retract × invalidate_cell: Loro UndoManager retract compacts the op list + shifts positional indices (R-V3.6-10); confirm rebuild_op_indices_only fully covers every path that mutates the visible log.
C10. mid-edit-render guard / typing watchdog × pollRemote merged tick × delta: the V3.5.0.7/V3.6.0.11 guard defers renders during typing; does a deferred render + a delta acquisition interact correctly (stale _pendingRenderAfterTyping)?
C11. IDE consumer flow end-to-end: dispatchIncomingMessage → appendPutValue/appendPutFormula → onCommit render → acquireWorkbookSnapshot (delta) → buildHtml, across sheet switches + multi-panel-same-session + collab. Any place the IDE state can diverge from engine truth.

DISCIPLINE: trace actual code paths (cite file:line across BOTH repos). For each interaction, state whether it's CORRECT, or describe the divergence with a concrete reproducing sequence of ops. Distinguish proven from suspected. A reproducing op-sequence (even if you can't run it) is the most valuable output — hand it to Lane A (Codex) framing for empirical confirmation.

OUTPUT: return findings as a structured list (orchestrator writes to docs/phase5/megaudit-5-8/lane-c.md). Format per finding: #, Finding (one line), Severity, Files (path:line, both repos), Repro (op sequence), Evidence, Recommendation. End with VERDICT + coverage note (which C1–C11 traced; any interaction you could not fully trace).
