//! Cell-STYLE API for `WorkbookRuntime` (FE-4 W4, 2026-06-10).
//!
//! The visual-formatting analog of [`super::formats`]. Two producer-side
//! methods mirror `intern_format` / `set_cell_format` one-to-one:
//!
//! - [`WorkbookRuntime::intern_style`] — register a [`Style`] in the
//!   workbook's `StyleTable` and emit `Op::RegisterStyle` iff a NEW id was
//!   allocated. Idempotent.
//! - [`WorkbookRuntime::set_cell_style`] — bind a cell to a [`StyleId`] (or
//!   clear via `None`). Refuses unknown ids (`RuntimeError::UnknownStyleId`).
//!
//! There is no `read_display`-equivalent here: styles are visual (the FE-5
//! canvas renderer consumes them), not part of the value-render pipeline that
//! `read_display` drives for number formats.

use ql_oplog::Op;
use ql_storage::{Style, StyleId};
use ql_types::{ColId, RowId, SheetId};

use super::{validate_cell, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// **FE-4 W4 (2026-06-10):** intern a [`Style`] into the workbook's
    /// `StyleTable` and emit `Op::RegisterStyle` to the op log iff the call
    /// allocated a NEW id. Returns the [`StyleId`], which the caller passes to
    /// [`set_cell_style`]. Mirrors [`WorkbookRuntime::intern_format`] exactly:
    /// peer-scoped dedup lookup, append-before-mutate ordering, idempotent on
    /// repeats.
    ///
    /// [`set_cell_style`]: WorkbookRuntime::set_cell_style
    pub fn intern_style(&mut self, style: Style) -> Result<StyleId, RuntimeError> {
        // Peer-scoped dedup (mirrors intern_format's lookup_string): if THIS
        // peer already interned an identical style, return it without a
        // duplicate op. A remote peer's identical-value style does NOT
        // short-circuit (producer/replay symmetry under multi-peer replay).
        if let Some(existing) = self.workbook.styles().lookup_style(&style) {
            return Ok(existing);
        }
        // New style — predict the id the table will allocate so we can emit
        // the op BEFORE mutating (append-before-mutate, matching intern_format).
        let styles = self.workbook.styles();
        let counter = styles.next_counter();
        // Pre-check counter overflow BEFORE appending the op (mirrors
        // intern_format's Opus-B LOW-2 closure): refuse before write so the
        // local log never gets an op local replay couldn't reproduce.
        if counter == u32::MAX {
            return Err(RuntimeError::StyleCounterExhausted {
                peer: styles.local_peer(),
            });
        }
        let id = StyleId::new(styles.local_peer(), counter);
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RegisterStyle {
                id: ql_oplog::StyleIdWire::from_storage(id),
                style: ql_oplog::StyleWire::from_storage(style),
            })?;
        }
        let allocated = self.workbook.styles_mut().intern(style);
        debug_assert_eq!(
            allocated, id,
            "StyleTable::intern allocated a different id than next_counter predicted"
        );
        Ok(allocated)
    }

    /// **FE-4 W4 (2026-06-10):** bind a cell to a [`StyleId`] (or clear its
    /// binding by passing `None`). Emits `Op::SetCellStyle` to the op log.
    /// Sheet/row/col are validated; `id = Some(...)` referencing an unknown id
    /// is REFUSED (`RuntimeError::UnknownStyleId`), matching replay's
    /// `StyleNotRegistered` semantic. Mirrors
    /// [`WorkbookRuntime::set_cell_format`] exactly.
    pub fn set_cell_style(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        id: Option<StyleId>,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        // Producer-side gate: refuse `Some(id)` referencing an unregistered
        // style. Replay does the same check so a wire-bound op log is
        // well-formed.
        //
        // **FE-9 (2026-06-14):** collapse an EMPTY (default) style to a CLEAR.
        // `Style::default()` is "no styling" (style.rs) — binding it would
        // materialize a phantom cell (a value-less, style-only overlay entry that
        // the snapshot + `.qbook` persistence still emit). The IDE's only "toggle
        // every attribute OFF" path registers a default `Style` and calls this,
        // so the collapse happens HERE — BEFORE op-append, so the op log records
        // the true `None`/clear intent and replay stays in lockstep with state.
        // An unknown id is still refused loudly (No-Fallbacks); only a
        // resolves-to-default id is treated as a clear.
        let effective_id = match id {
            Some(sid) => match self.workbook.styles().lookup(sid) {
                None => return Err(RuntimeError::UnknownStyleId(sid)),
                Some(style) if style.is_empty() => None, // default style ⇒ clear
                Some(_) => Some(sid),
            },
            None => None,
        };
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetCellStyle {
                sheet,
                row,
                col,
                id: effective_id.map(ql_oplog::StyleIdWire::from_storage),
            })?;
        }
        // Apply the mutation. After append-success this cannot fail.
        let overlay = self
            .workbook
            .sheet_mut(sheet)
            .expect("validate_cell guards sheet bounds")
            .style_overlay_mut();
        match effective_id {
            Some(sid) => {
                overlay.set(row, col, sid);
            }
            None => {
                overlay.clear(row, col);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::{Style, StyleId, Workbook};
    use ql_types::LEGACY_PEER;

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    fn bold() -> Style {
        Style {
            bold: true,
            ..Style::default()
        }
    }

    fn italic() -> Style {
        Style {
            italic: true,
            ..Style::default()
        }
    }

    #[test]
    fn intern_style_new_emits_register_op() {
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            let id = rt.intern_style(bold()).unwrap();
            assert_eq!(id, StyleId::new(LEGACY_PEER, 0));
        }
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], Op::RegisterStyle { .. }));
    }

    #[test]
    fn intern_style_duplicate_call_idempotent_no_second_op() {
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            let a = rt.intern_style(bold()).unwrap();
            let b = rt.intern_style(bold()).unwrap();
            assert_eq!(a, b);
        }
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1, "repeat intern must not emit a duplicate op");
    }

    #[test]
    fn set_cell_style_emits_op_and_updates_overlay() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let sid;
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            sid = rt.intern_style(bold()).unwrap();
            rt.set_cell_style(s, 3, 5, Some(sid)).unwrap();
        }
        assert_eq!(wb.sheet(s).unwrap().style_overlay().get(3, 5), Some(sid));
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops
            .iter()
            .any(|o| matches!(o, Op::SetCellStyle { id: Some(_), .. })));
    }

    #[test]
    fn set_cell_style_none_clears_overlay_and_emits_op() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            let sid = rt.intern_style(bold()).unwrap();
            rt.set_cell_style(s, 0, 0, Some(sid)).unwrap();
            rt.set_cell_style(s, 0, 0, None).unwrap();
        }
        assert_eq!(wb.sheet(s).unwrap().style_overlay().get(0, 0), None);
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops
            .iter()
            .any(|o| matches!(o, Op::SetCellStyle { id: None, .. })));
    }

    /// **FE-9 (2026-06-14):** binding an EMPTY (default) style collapses to a
    /// CLEAR — the overlay gets NO entry and the op log records
    /// `SetCellStyle{None}` (so replay stays in lockstep with state). This is the
    /// source fix that stops the IDE's "toggle every attribute off" gesture from
    /// creating a phantom (value-less, default-styled) cell.
    #[test]
    fn fe9_set_cell_style_empty_collapses_to_clear() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            let empty_id = rt.intern_style(Style::default()).unwrap();
            // Bind the default style on an empty cell → must collapse to a clear.
            rt.set_cell_style(s, 0, 0, Some(empty_id)).unwrap();
        }
        // No overlay entry — the default style is "no style".
        assert_eq!(wb.sheet(s).unwrap().style_overlay().get(0, 0), None);
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(
            ops.iter()
                .any(|o| matches!(o, Op::SetCellStyle { id: None, .. })),
            "FE-9: an empty-style bind must emit SetCellStyle{{None}}"
        );
        assert!(
            !ops.iter()
                .any(|o| matches!(o, Op::SetCellStyle { id: Some(_), .. })),
            "FE-9: an empty-style bind must NOT emit a set-to-empty op"
        );
    }

    #[test]
    fn set_cell_style_unknown_id_is_runtime_error() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let bad = StyleId::new(LEGACY_PEER, 999);
        let err = rt.set_cell_style(s, 0, 0, Some(bad)).unwrap_err();
        assert!(matches!(err, RuntimeError::UnknownStyleId(sid) if sid == bad));
    }

    #[test]
    fn intern_and_set_cell_style_replay_round_trip() {
        let mut producer_wb = Workbook::new();
        let s_p = producer_wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let sid;
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut log);
            sid = rt.intern_style(italic()).unwrap();
            rt.set_cell_style(s_p, 0, 0, Some(sid)).unwrap();
        }
        let mut replay_wb = Workbook::new();
        replay_wb.add_sheet("S");
        ql_oplog::replay_into(&log, &mut replay_wb, &reg).unwrap();
        assert_eq!(replay_wb.styles().lookup(sid), Some(italic()));
        assert_eq!(
            replay_wb.sheet(0).unwrap().style_overlay().get(0, 0),
            Some(sid)
        );
    }
}
