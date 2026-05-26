Phase 5 Megaudit (5.8) — LANE B (Opus): per-sub-phase invariants + risk-register verification.

You are auditing the COMPLETE Quantbook Phase 5 collaboration surface. PHASE-LEVEL megaudit (per-step audits already ran). Read-only / audit-only: report findings with file:line evidence; do NOT edit code. Your lane is DEEP STATIC CORRECTNESS — confirm every claimed-closed invariant is actually closed in CURRENT code, and that the safety invariants hold across the whole surface.

Repo (engine): /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
Source HEAD: `1465b1db4c4` (V3.6 PHASE CLEAN). Core files: crates/ql-collab/src/session.rs (CollabSession + cache walker + undo + snapshot/delta), crates/ql-oplog/src/{op.rs,replay.rs,*}, crates/ql-bindings-node/src/lib.rs (napi), crates/ql-storage/src/workbook.rs. Risk register + invariant narrative: docs/architecture/ide-consumer-contract.md (§4.1.z5, §4.1.z6) + .plans/_active.md + .plans/_archive/2026-05-24_phase-5-7-v3-6-*.md.

YOUR CHECKLIST:

B1. RISK-REGISTER WALK — for EACH risk below, open the cited closure and confirm it (a) exists in current code, (b) is correct, (c) has a regression test pinning it. Report any risk whose claimed state is false (a "CLOSED" risk that isn't, or an OPEN risk that's silently broken).
- R-V3.3-1..6 (multi-sheet virtualization era).
- R-V3.4-1..7 (undo/persistence/presence; note R-V3.4-3 presenceRepaintInFlight CLOSED-at-V3.5.0.X, R-V3.4-7 sweep cadence VOIDED).
- R-V3.5-1..7 (WorkbookSnapshot/sheet-ops/format/undo; R-V3.5-2 cell_op_index perf CLOSED-at-V3.6.0.4, R-V3.5-7 typing-watchdog CLOSED-at-V3.6.0.11).
- R-V3.6-1..19 (the V3.6 arc; esp. R-V3.6-14 cache-stale-after-undo [5 invalidation sites], R-V3.6-15 VV/op_count drift [debug_assert at lib.rs ~2604], R-V3.6-16 multi-peer rename+cell, R-V3.6-17 clone cost [692µs@100k], R-V3.6-18 apply_ops_in_range, R-V3.6-19 RestoreSheet preserved-cells [the V3.6.0.X CONVERGENT-HIGH-1 closure: RemoveSheet no-prune]).

B2. CACHE-WALKER INVARIANTS (crates/ql-collab/src/session.rs `apply_cache_effect` + `collect_cache_effects` + `rebuild_snapshot_cache` + `rebuild_op_indices_only` + `invalidate_cell`). Verify across all 7 CacheEffect arms (PutValue/PutFormula/ClearFormula/RegisterFormat/SetCellFormat/RemoveSheet/RestoreSheet):
- Tombstone preservation (R-V3.6-19): RemoveSheet must NOT prune cells/cell_op_index; tombstoned-sheet cells stay hidden via is_sheet_removed + removed_sheet_ids filters; RestoreSheet resurfaces them.
- RegisterFormat first-write-wins (not LWW) mirroring FormatTable::register_at (D2 CONVERGENT-HIGH-1).
- cell_op_index ∪ sheet_op_index sync invariant under undo/redo retract (R-V3.6-10; rebuild_op_indices_only uses the canonical walker).
- invalidate_cell atomic-swap (no torn write on fallible OpLog::get; V3.6.0.X audit-of-D3 CONVERGENT-HIGH-1).
- append_op does NOT invalidate the workbook cache (the delta fast-path precondition); the 5 force_clear sites (merge_bytes, discard_pending_ops, undo, redo, poll_remote drain) DO.

B3. RULE-4 ARC TERMINUS (Send+Sync) = 6. The discipline: negative trait claims need positive per-field proof. Walk EVERY type added across Phase 5 (Op variants, wire enums, CacheEffect variants, CollabSession fields, napi structs: FormatDefJson, FormatIdJson, CellSnapshotJson, WorkbookSnapshotJson, WorkbookSnapshotDeltaJson, ChangedCellJson, RemovedCellJson, etc.). Confirm each is Send+Sync by positive field composition; confirm no new !Send/!Sync trigger was introduced. Report any type whose Send+Sync status is asserted but not actually held.

B4. VV/op_count + clone-cost (R-V3.6-15/17): confirm the (VersionVector, op_count) cache pair cannot drift (the "set together / clear together" + monotonicity debug_assert); confirm Workbook clone is the chosen pattern (always-clone, not Arc::make_mut) and the cost claim (692µs@100k) is grounded.

B5. UNDO/REDO correctness (Loro UndoManager on_push/on_pop wiring, V3.6.0.2 D1): confirm pending_undo_cells encoding, grouped-undo conservative fallback (inside_group + undo_merge_interval_ms gating), and that the V3.5.0.X pure_local_frontier gate was actually REMOVED (not left dead).

DISCIPLINE: cite file:line for every claim. For each risk, state CONFIRMED-CLOSED / NOT-CLOSED / DEFERRED-APPROPRIATELY with evidence. Flag any docstring that claims a property the code doesn't have (contract-vs-impl drift is a real finding — the V3.6.0.10 megaudit found many).

OUTPUT: return your findings as a structured list (the orchestrator will write them to docs/phase5/megaudit-5-8/lane-b.md). Format per finding: #, Finding (one line), Severity (HIGH/MED/LOW/INFO), Files (path:line), Evidence (cited code), Recommendation. End with: VERDICT + a risk-register table (R-id → CONFIRMED-CLOSED / issue) + coverage note (which checklist items B1–B5 completed).
