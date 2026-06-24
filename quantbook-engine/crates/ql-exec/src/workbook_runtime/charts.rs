//! Chart-object mutation API for `WorkbookRuntime`.
//!
//! **Wave Q1 (2026-06-23):** the producer-side CRUD for workbook-scoped
//! chart objects, mirroring the table mutation API (`tables.rs`) but
//! simpler — charts are INERT metadata: they never register cells, never
//! participate in formula dependencies, and have no structured-reference
//! binder surface. So (unlike tables) there is no calcgraph dirty-fan hook
//! and no plan-cache flush; `PlanCacheKey` does not include the chart
//! generation because no plan depends on a chart.
//!
//! Methods:
//! - [`WorkbookRuntime::add_chart`] — allocate a stable id, emit
//!   `Op::AddChart` (id carried verbatim on the wire), insert into the store.
//! - [`WorkbookRuntime::update_chart`] — full-state replace, emit
//!   `Op::UpdateChart`; loud `ChartNotFound` on a missing id.
//! - [`WorkbookRuntime::remove_chart`] — remove + emit `Op::RemoveChart`;
//!   loud `ChartNotFound` on a missing id (replay stays idempotent).
//! - [`WorkbookRuntime::list_charts`] — read-only snapshot of all charts.
//!
//! Op-log append is BEFORE storage mutation (the W5-103 atomicity pattern):
//! on append failure the workbook is unchanged.

use ql_oplog::Op;
use ql_storage::{ChartKind, ChartObject};
use ql_types::{ColId, Range, RowId, SheetId};

use super::{RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    // ===== Wave Q1 (2026-06-23) — chart-object mutation API =====

    /// **Wave Q1:** add a chart object, emitting `Op::AddChart` into the
    /// attached op log (if any). Returns the allocated stable id.
    ///
    /// The id is allocated FIRST from the workbook's chart-id counter, then
    /// carried VERBATIM on the op wire — replay re-inserts at that id without
    /// re-allocating, so the id survives the full op-log replay that undo
    /// triggers (see `Op::AddChart` docs). Append is BEFORE storage mutation
    /// (W5-103 atomicity); on append failure the workbook is unchanged (the
    /// burned id is harmless — ids are never reused).
    #[allow(clippy::too_many_arguments)]
    pub fn add_chart(
        &mut self,
        name: &str,
        chart_type: ChartKind,
        sheet: SheetId,
        anchor_row: RowId,
        anchor_col: ColId,
        width_px: u32,
        height_px: u32,
        source_range: Range,
        title: Option<String>,
    ) -> Result<u32, RuntimeError> {
        // **v1.5-deferred collab hazard (w119):** `allocate_chart_id` is a
        // per-workbook, peer-LOCAL monotonic counter. Under a MERGED collab op
        // log two peers can each allocate the SAME id (both start at 0); their
        // `AddChart`s then collide on the id-keyed store (last-writer-wins
        // overwrite) and a later `UpdateChart { id }` is ambiguous. v1 is
        // single-writer so this cannot occur; peer-namespaced ids are a v1.5
        // collab-phase change. Pinned by `same_id_insert_is_last_writer_wins`
        // (ql-storage charts.rs).
        let id = self.workbook.charts_mut().allocate_chart_id();
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::AddChart {
                id,
                name: name.to_string(),
                chart_type: chart_type.as_wire_str().to_string(),
                sheet,
                anchor_row,
                anchor_col,
                width_px,
                height_px,
                src_sheet: source_range.sheet,
                src_start_row: source_range.start_row,
                src_start_col: source_range.start_col,
                src_end_row: source_range.end_row,
                src_end_col: source_range.end_col,
                title: title.clone(),
            })?;
        }
        self.workbook.charts_mut().insert(ChartObject {
            id,
            name: name.to_string(),
            chart_type,
            sheet,
            anchor_row,
            anchor_col,
            width_px,
            height_px,
            source_range,
            title,
        });
        Ok(id)
    }

    /// **Wave Q1:** replace a chart object's full mutable state (every field
    /// except `id`), emitting `Op::UpdateChart`. Errors loudly with
    /// [`RuntimeError::ChartNotFound`] if `id` isn't registered (No-Fallbacks).
    #[allow(clippy::too_many_arguments)]
    pub fn update_chart(
        &mut self,
        id: u32,
        name: &str,
        chart_type: ChartKind,
        sheet: SheetId,
        anchor_row: RowId,
        anchor_col: ColId,
        width_px: u32,
        height_px: u32,
        source_range: Range,
        title: Option<String>,
    ) -> Result<(), RuntimeError> {
        if self.workbook.charts().lookup(id).is_none() {
            return Err(RuntimeError::ChartNotFound(id));
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::UpdateChart {
                id,
                name: name.to_string(),
                chart_type: chart_type.as_wire_str().to_string(),
                sheet,
                anchor_row,
                anchor_col,
                width_px,
                height_px,
                src_sheet: source_range.sheet,
                src_start_row: source_range.start_row,
                src_start_col: source_range.start_col,
                src_end_row: source_range.end_row,
                src_end_col: source_range.end_col,
                title: title.clone(),
            })?;
        }
        self.workbook.charts_mut().insert(ChartObject {
            id,
            name: name.to_string(),
            chart_type,
            sheet,
            anchor_row,
            anchor_col,
            width_px,
            height_px,
            source_range,
            title,
        });
        Ok(())
    }

    /// **Wave Q1:** remove a chart object by id, emitting `Op::RemoveChart`.
    /// Errors loudly with [`RuntimeError::ChartNotFound`] if `id` isn't
    /// registered (No-Fallbacks; the store's `remove` + replay are idempotent,
    /// so the loud check lives here at the producer).
    pub fn remove_chart(&mut self, id: u32) -> Result<(), RuntimeError> {
        if self.workbook.charts().lookup(id).is_none() {
            return Err(RuntimeError::ChartNotFound(id));
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RemoveChart { id })?;
        }
        let _ = self.workbook.charts_mut().remove(id);
        Ok(())
    }

    /// **Wave Q1:** all chart objects, cloned (HashMap-arbitrary order).
    /// Read-only; the IDE sorts/positions as it sees fit.
    pub fn list_charts(&self) -> Vec<ChartObject> {
        self.workbook
            .charts()
            .iter()
            .map(|(_, c)| c.clone())
            .collect()
    }
}
