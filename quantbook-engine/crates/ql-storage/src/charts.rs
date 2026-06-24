//! **Wave Q1 (2026-06-23):** chart-object metadata storage.
//!
//! Mirrors the [`crate::TableTable`] pattern (Phase 4.8.A). Chart objects
//! are workbook-level entities: a basic chart (line / bar / scatter)
//! anchored at a grid cell, drawing a single rectangular source range.
//! Unlike tables and names, chart objects are NEVER referenced from formula
//! text, so they carry plain `String` names (no `Arc<str>` interning) and
//! are keyed by a stable monotonic `u32` id rather than by name.
//!
//! **id-keyed (NOT name-keyed) by design.** Chart create/move/delete is
//! undoable; undo forces a full op-log replay (`rebuild_snapshot_cache`).
//! If `AddChart` re-allocated ids at replay time the ids would drift across
//! rebuilds and later `UpdateChart { id }` / `RemoveChart { id }` ops would
//! miss. So the id is allocated ONCE at create time and carried verbatim on
//! the op wire; replay inserts at that id.
//!
//! This module is **data model only.** Mutation API (add / update / remove)
//! lands in `ql_exec::WorkbookRuntime` with op-log emission. Direct calls
//! into [`ChartTable`]'s mutation methods are reserved for the qbook loader
//! and tests; product code uses the runtime API.

use std::collections::HashMap;

use ql_types::{ColId, Range, RowId, SheetId};

/// **Wave Q1:** the basic chart kind. v1 ships line / bar / scatter only
/// (the full chart-type catalog stays v1.5 per the v1-rebaseline). The
/// wire representation is a lowercase string (mirrors the `ReferenceMode`
/// `"a1"`/`"r1c1"` pattern): both the op log and the `.qbook` envelope
/// store the string and reject unknowns loudly via [`Self::from_wire_str`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartKind {
    Line,
    Bar,
    Scatter,
}

impl ChartKind {
    /// Canonical lowercase wire token. Stable across versions — changing
    /// these strings is a wire-format break.
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            ChartKind::Line => "line",
            ChartKind::Bar => "bar",
            ChartKind::Scatter => "scatter",
        }
    }

    /// Parse a wire token. Returns `None` on an unknown string so the
    /// caller can fail loudly (op replay -> `ReplayError`, qbook load ->
    /// `QbookError`) rather than silently defaulting.
    pub fn from_wire_str(s: &str) -> Option<Self> {
        match s {
            "line" => Some(ChartKind::Line),
            "bar" => Some(ChartKind::Bar),
            "scatter" => Some(ChartKind::Scatter),
            _ => None,
        }
    }
}

/// **Wave Q1:** a single workbook-scoped chart object.
///
/// `id` is the stable identity (see module docs). `sheet`/`anchor_row`/
/// `anchor_col` place the chart's top-left corner; `width_px`/`height_px`
/// size it; `source_range` is the rectangular data range it plots (carries
/// its own sheet, which may differ from the anchor sheet). `title` is an
/// optional display title (the chart name is the internal handle).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChartObject {
    /// Stable id, monotonically allocated, never reused.
    pub id: u32,
    /// Internal handle (display title lives in `title`). Not formula-referenced.
    pub name: String,
    pub chart_type: ChartKind,
    /// Anchor sheet (top-left corner's sheet).
    pub sheet: SheetId,
    pub anchor_row: RowId,
    pub anchor_col: ColId,
    pub width_px: u32,
    pub height_px: u32,
    /// The rectangular data range plotted by the chart.
    pub source_range: Range,
    /// Optional display title.
    pub title: Option<String>,
}

/// **Wave Q1:** workbook-level chart registry.
///
/// Mirrors [`crate::TableTable`] but keyed by stable `u32` id (charts are
/// never name-referenced). `generation` is bumped on every successful
/// mutation for plan/render cache invalidation; `next_chart_id` is the
/// monotonic id allocator (one counter per workbook, never reused).
///
/// **No product mutation API here.** Direct `insert` from the qbook loader
/// is fine; product code mutates via `WorkbookRuntime::add_chart` etc.
/// (Wave Q1 runtime layer) which emit op-log entries.
#[derive(Clone, Debug, Default)]
pub struct ChartTable {
    charts: HashMap<u32, ChartObject>,
    /// Monotonic counter bumped on every successful mutation.
    generation: u64,
    /// Monotonic per-chart-id allocator. Never reused; auto-bumped past any
    /// loaded id by [`Self::insert`] (mirrors `TableTable::next_column_id`).
    next_chart_id: u32,
}

impl ChartTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Cache-invalidation counter. Bumped on every successful mutation.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Look up a chart by id.
    pub fn lookup(&self, id: u32) -> Option<&ChartObject> {
        self.charts.get(&id)
    }

    /// All chart entries; HashMap-arbitrary order.
    pub fn iter(&self) -> impl Iterator<Item = (&u32, &ChartObject)> + '_ {
        self.charts.iter()
    }

    pub fn len(&self) -> usize {
        self.charts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.charts.is_empty()
    }

    /// **Loader / mutation-internal API.** Insert a chart at its own `id`.
    /// The caller is responsible for id uniqueness (the runtime allocates
    /// via [`Self::allocate_chart_id`]; the loader preserves persisted ids).
    ///
    /// Bumps the generation counter on success and auto-bumps
    /// `next_chart_id` past the inserted id (mirrors
    /// `TableTable::insert`) so the allocator never collides with a loaded
    /// id after a `.qbook` round-trip.
    pub fn insert(&mut self, chart: ChartObject) {
        // `saturating_add`: a loaded `id == u32::MAX` must not overflow-panic
        // (debug) / wrap to 0 (release) when advancing the high-water mark.
        self.next_chart_id = self.next_chart_id.max(chart.id.saturating_add(1));
        self.charts.insert(chart.id, chart);
        self.generation = self.generation.wrapping_add(1);
    }

    /// Remove a chart by id. Bumps generation iff a removal occurred
    /// (idempotent no-op clears don't invalidate caches).
    pub fn remove(&mut self, id: u32) -> Option<ChartObject> {
        let removed = self.charts.remove(&id);
        if removed.is_some() {
            self.generation = self.generation.wrapping_add(1);
        }
        removed
    }

    /// Mutable access to a chart by id. Generation bump is the CALLER's
    /// responsibility (since `&mut ChartObject` lets the caller see no-op
    /// mutations too) — call [`Self::bump_generation`] after mutating.
    pub fn get_mut(&mut self, id: u32) -> Option<&mut ChartObject> {
        self.charts.get_mut(&id)
    }

    /// Allocate and return the next chart id. Monotonic across the workbook
    /// lifetime; never reused. Wraps at `u32::MAX` via `wrapping_add` (4
    /// billion chart allocations is unreachable in practice).
    pub fn allocate_chart_id(&mut self) -> u32 {
        let id = self.next_chart_id;
        self.next_chart_id = self.next_chart_id.wrapping_add(1);
        id
    }

    /// Explicitly bump generation. For callers that mutated through
    /// `get_mut` and need to invalidate caches.
    pub fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chart(id: u32, name: &str, kind: ChartKind) -> ChartObject {
        ChartObject {
            id,
            name: name.to_string(),
            chart_type: kind,
            sheet: 0,
            anchor_row: 1,
            anchor_col: 2,
            width_px: 480,
            height_px: 320,
            source_range: Range::new(0, 0, 0, 9, 1),
            title: Some(format!("{name} title")),
        }
    }

    #[test]
    fn chart_kind_wire_round_trip() {
        for k in [ChartKind::Line, ChartKind::Bar, ChartKind::Scatter] {
            assert_eq!(ChartKind::from_wire_str(k.as_wire_str()), Some(k));
        }
        assert_eq!(ChartKind::from_wire_str("pie"), None);
        assert_eq!(ChartKind::from_wire_str("Line"), None); // case-sensitive canon
    }

    #[test]
    fn chart_table_insert_lookup_round_trip() {
        let mut ct = ChartTable::new();
        let c = chart(0, "Returns", ChartKind::Line);
        ct.insert(c.clone());
        assert_eq!(ct.lookup(0), Some(&c));
        assert_eq!(ct.lookup(1), None);
        assert_eq!(ct.len(), 1);
        assert!(!ct.is_empty());
    }

    #[test]
    fn chart_table_generation_bumps_on_mutation() {
        let mut ct = ChartTable::new();
        let g0 = ct.generation();
        ct.insert(chart(0, "A", ChartKind::Bar));
        let g1 = ct.generation();
        assert_ne!(g0, g1);
        ct.remove(0);
        let g2 = ct.generation();
        assert_ne!(g1, g2);
        // Idempotent remove doesn't bump.
        ct.remove(0);
        assert_eq!(g2, ct.generation());
    }

    #[test]
    fn allocate_chart_id_is_monotonic() {
        let mut ct = ChartTable::new();
        assert_eq!(ct.allocate_chart_id(), 0);
        assert_eq!(ct.allocate_chart_id(), 1);
        assert_eq!(ct.allocate_chart_id(), 2);
    }

    /// `insert` auto-bumps `next_chart_id` past any inserted id. Without
    /// this, the `.qbook` loader (which preserves persisted ids verbatim)
    /// would let `allocate_chart_id` later hand out an id that collides
    /// with one already in storage. Mirrors the table column-id pin.
    #[test]
    fn insert_bumps_next_chart_id_past_loaded_id() {
        let mut ct = ChartTable::new();
        ct.insert(chart(30, "loaded", ChartKind::Scatter));
        // Next allocator call must return 31, NEVER <= 30.
        assert_eq!(ct.allocate_chart_id(), 31);
    }

    #[test]
    fn insert_preserves_high_water_across_multiple_inserts() {
        let mut ct = ChartTable::new();
        ct.insert(chart(100, "A", ChartKind::Line));
        ct.insert(chart(5, "B", ChartKind::Bar));
        assert_eq!(
            ct.allocate_chart_id(),
            101,
            "allocator must stay past highest seen (100)"
        );
    }

    /// **v1.5-deferred collab pin (w119 fold).** The RAW id-keyed store primitive
    /// is last-writer-wins on a duplicate id. NOTE this pins the STORAGE PRIMITIVE
    /// only -- op-log REPLAY of a duplicate `AddChart` is first-writer-wins /
    /// idempotent-skip (see `ql-oplog` replay), so a merged op log does NOT
    /// silently overwrite through that path. The residual v1.5 hazard is peer-
    /// LOCAL id ALLOCATION collision (two peers both `allocate_chart_id` -> 0);
    /// peer-namespaced ids are the v1.5 fix. Locks the primitive's behavior so a
    /// future change to it is a noticed one.
    #[test]
    fn same_id_insert_is_last_writer_wins() {
        let mut ct = ChartTable::new();
        ct.insert(chart(0, "peer-a", ChartKind::Line));
        ct.insert(chart(0, "peer-b", ChartKind::Bar));
        assert_eq!(ct.len(), 1, "same id collapses to one entry");
        assert_eq!(ct.lookup(0).unwrap().name, "peer-b", "last writer wins");
    }

    #[test]
    fn get_mut_then_bump_generation() {
        let mut ct = ChartTable::new();
        ct.insert(chart(0, "A", ChartKind::Line));
        let g1 = ct.generation();
        {
            let c = ct.get_mut(0).unwrap();
            c.title = Some("renamed".to_string());
        }
        // get_mut alone does NOT bump.
        assert_eq!(ct.generation(), g1);
        ct.bump_generation();
        assert_ne!(ct.generation(), g1);
        assert_eq!(ct.lookup(0).unwrap().title.as_deref(), Some("renamed"));
    }
}
