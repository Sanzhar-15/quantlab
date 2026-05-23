---
name: empty
status: empty
date: 2026-05-24
---

No active plan.  V3.5 phase COMPLETE + AUDITED + ARCHIVED at `_archive/2026-05-24_phase-5-7-v3-5-workbook-snapshot-sheet-ops-undo-format.md`.

Next phase entry candidates (V3.6+ scope per V3.5.0.9 § 4.1.z5 deferrals + Opus § F V3.6 entry-readiness packet):

- **V3.6.0.1 decision lock** -- 8-9 D-decisions per Opus § F: session-wide RegisterFormat FormatTable cache (would add `WorkbookSnapshotJson.formats: Vec<FormatDefJson>` top-level field); format-aware buildHtml rendering (number/date/currency); per-cell op-index for O(ops-for-this-cell) `invalidate_cell`; Loro UndoManager `on_pop` callback wiring (cleaner partial-invalidate without the `pure_local_frontier` proxy); incremental WorkbookSnapshot deltas; `#REF!` substitution for cross-sheet refs to deleted sheets; `Op::RestoreSheet` un-delete; sheet-tabs multi-tab UI redesign; IDE-facing `appendPutFormula` napi (unblocks end-to-end repaired-formula integration tests + format-UI write-path).
- **V3.5.0.4c sheet-tabs UI scaffold** -- defer to V3.5.1+ unless user signal surfaces.  Multi-sheet UX adequately covered by V3.5.0.4a Command Palette + V3.5.0.4b reactive title; V3.6+ multi-tab redesign may consolidate.
- **V3.5.1+ polish** -- Opus-L1 dead-code arc in `affected_cells_for_partial_invalidate` simplification; Opus-L2 `buildSheetMovePositionItems` source-at-current UX nit; Opus-L3 V3.5.0.4b reactive title race; Opus-I1 `Workbook::move_sheet` linear-search; Opus-M3 `quantbookCellGridSwitchSheet` + `quantbookCellGridRefresh` consolidation.

Open this file as `_active.md` when starting the next plan.
