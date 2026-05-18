//! Format API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.1 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Three
//! methods covering the producer-side format surface — table
//! interning, per-cell binding, and display rendering. Pure code
//! move; no behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::intern_format`] — register a format string
//!   in the workbook's `FormatTable` and emit `Op::RegisterFormat`
//!   if (and only if) a new id was allocated. Idempotent.
//! - [`WorkbookRuntime::set_cell_format`] — bind a cell to a
//!   `FormatId` (or clear via `None`). Refuses unknown ids
//!   (`RuntimeError::UnknownFormatId`).
//! - [`WorkbookRuntime::read_display`] — read a cell and render it
//!   through its `FormatId` binding (or General if unbound).
//!   Memoizes parsed `FormatString` per id in
//!   `WorkbookRuntime::format_cache`.

use ql_functions::format;
use ql_oplog::Op;
use ql_storage::FormatId;
use ql_types::{ColId, EvalContext, RowId, SheetId};

use super::{validate_cell, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// **W5-82 (Phase 4.5.D part 6):** intern a number-format string into
    /// the workbook's `FormatTable` and emit `Op::RegisterFormat` to the
    /// op log if (and only if) the call allocated a NEW id. Returns the
    /// `FormatId`, which the caller can pass to [`set_cell_format`].
    ///
    /// Idempotent on repeated calls with the same string — the second
    /// call returns the same id without emitting a duplicate op. This
    /// keeps the op log compact and replay deterministic.
    ///
    /// Direct callers of `Workbook::formats_mut().intern()` bypass the
    /// op log silently; that path is documented as low-level and intended
    /// for the qbook loader + tests + engine-internal reconstruction.
    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
        // Check whether the table already knows this string. If so, no
        // new id is allocated and we MUST NOT emit `RegisterFormat`
        // (idempotent path).
        if let Some(existing) = self.workbook.formats().iter().find(|(_, t)| *t == s) {
            return Ok(existing.0);
        }
        // New string — predict the id the table will allocate so we can
        // emit the op BEFORE mutating (append-before-mutate ordering,
        // matching set_name / set_value).
        let id = FormatId(self.workbook.formats().next_custom_id());
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RegisterFormat {
                id: id.0,
                string: s.to_owned(),
            })?;
        }
        let allocated = self.workbook.formats_mut().intern(s);
        debug_assert_eq!(
            allocated, id,
            "FormatTable::intern allocated a different id than next_custom_id predicted"
        );
        Ok(allocated)
    }

    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
    /// clear its binding by passing `None`). Emits `Op::SetCellFormat`
    /// to the op log. Sheet/row/col are validated; `id = Some(...)` that
    /// references an unknown id is REFUSED (matching replay's
    /// `FormatNotRegistered` semantic — producer-side enforcement is
    /// the cleaner spot for the check).
    ///
    /// Direct callers of `Sheet::format_overlay_mut()` bypass the op
    /// log silently; that path is documented as low-level.
    pub fn set_cell_format(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        id: Option<FormatId>,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        // Producer-side gatekeeping: refuse `Some(id)` referencing an
        // unregistered format. Replay does the same check (W5-80) so
        // an op log that ever reaches the wire is well-formed.
        if let Some(fid) = id {
            if self.workbook.formats().lookup(fid).is_none() {
                return Err(RuntimeError::UnknownFormatId(fid.0));
            }
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetCellFormat {
                sheet,
                row,
                col,
                id: id.map(|f| f.0),
            })?;
        }
        // Apply the mutation. After append-success this cannot fail.
        let overlay = self
            .workbook
            .sheet_mut(sheet)
            .expect("validate_cell guards sheet bounds")
            .format_overlay_mut();
        match id {
            Some(fid) => {
                overlay.set(row, col, fid);
            }
            None => {
                overlay.clear(row, col);
            }
        }
        Ok(())
    }

    /// **W5-82 (Phase 4.5.D part 6):** read a cell and render it through
    /// its `FormatId` binding (or `General` if unbound). Returns the
    /// final display string the IDE would show. The runtime's
    /// `EvalContext` (date system, locale, now-provider) drives
    /// date/time rendering.
    ///
    /// Lookup chain per call:
    ///   1. cell's raw `Value` (cheap; lives on the storage hot path)
    ///   2. format id from sheet's `CellFormatOverlay` (None → General)
    ///   3. parsed `FormatString` from `format_cache` (parse + insert on miss)
    ///   4. `format::render(&value, &fmt, &ctx)` → `String`
    ///
    /// If the cell's format references an id that's missing from the
    /// `FormatTable` (corrupted state — should not happen in practice
    /// because `set_cell_format` refuses unknown ids), falls back to
    /// `General` rendering. If the format string fails to parse,
    /// falls back to `General` and the renderer never errors.
    ///
    /// **W5-84 closure (Codex MEDIUM-2) cache-staleness caveat:** the
    /// `format_cache` is keyed by `FormatId` and populated on first
    /// `read_display` for that id. `FormatTable::register_at` rejects
    /// id→string mutations, so cached entries stay correct for the
    /// runtime's lifetime under the runtime's own append-only
    /// `intern_format` path. HOWEVER, the low-level
    /// `Workbook::formats_mut()` accessor (loader-only by convention but
    /// `pub` for the qbook loader + tests) can register a new id AFTER
    /// `read_display` has cached the General fallback for that id. In
    /// that pathological sequence the cache will continue rendering
    /// General until the runtime is rebuilt. Analogous to the
    /// `WorkbookEnv` date-system caveat documented on
    /// `Workbook::set_date_system`. Tracked as GAP-F-12 in
    /// `docs/known-gaps.md`.
    pub fn read_display(&mut self, sheet: SheetId, row: RowId, col: ColId) -> String {
        let value = self.workbook.read(ql_types::Address::new(sheet, row, col));
        let format_id = self
            .workbook
            .sheet(sheet)
            .and_then(|s| s.format_overlay().get(row, col))
            .unwrap_or(FormatId::GENERAL);
        // Cache lookup. Vacant → resolve via FormatTable + parse + insert.
        let needs_parse = !self.format_cache.contains_key(&format_id);
        if needs_parse {
            let parsed = self
                .workbook
                .formats()
                .lookup(format_id)
                .and_then(|s| format::parse(s).ok());
            // Fall back to General if either lookup or parse failed.
            let parsed = parsed.unwrap_or_else(|| {
                format::parse("General").expect("'General' is a valid format string")
            });
            self.format_cache.insert(format_id, parsed);
        }
        let fmt = self
            .format_cache
            .get(&format_id)
            .expect("just inserted above");
        // V1 EvalContext: workbook's date_system + en-US locale + System now-provider.
        let ctx = EvalContext {
            date_system: self.workbook.date_system(),
            ..EvalContext::default()
        };
        format::render(&value, fmt, &ctx)
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::{FormatId, Workbook};
    use ql_types::{ErrorValue, Value};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    // ===== W5-82 / Phase 4.5.D part 6 — format runtime wrappers =====

    #[test]
    fn intern_format_returns_existing_builtin_id_no_oplog_op() {
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            // "General" is built-in id 0; pre-populated by FormatTable::default().
            let id = rt.intern_format("General").unwrap();
            assert_eq!(id, FormatId::GENERAL);
            let id2 = rt.intern_format("0.00").unwrap();
            assert_eq!(id2, FormatId(2));
        }
        // No RegisterFormat ops should have been emitted — both strings
        // are pre-populated built-ins.
        let ops: Vec<_> = log.iter().collect();
        assert_eq!(ops.len(), 0, "built-ins must not emit RegisterFormat ops");
    }

    #[test]
    fn intern_format_new_string_emits_register_op() {
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            let id = rt.intern_format("\"€\" #,##0.00").unwrap();
            assert_eq!(id.0, ql_storage::FIRST_CUSTOM_FORMAT_ID);
        }
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::RegisterFormat { id, string } => {
                assert_eq!(*id, ql_storage::FIRST_CUSTOM_FORMAT_ID);
                assert_eq!(string, "\"€\" #,##0.00");
            }
            other => panic!("expected RegisterFormat, got {other:?}"),
        }
    }

    #[test]
    fn intern_format_duplicate_call_idempotent_no_second_op() {
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            let id1 = rt.intern_format("\"⚓\" #,##0").unwrap();
            let id2 = rt.intern_format("\"⚓\" #,##0").unwrap();
            assert_eq!(id1, id2);
        }
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1, "second intern must not emit a duplicate op");
    }

    #[test]
    fn set_cell_format_emits_op_and_updates_overlay() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            rt.set_cell_format(s, 3, 5, Some(FormatId(14))).unwrap();
        }
        // Overlay updated.
        assert_eq!(
            wb.sheet(s).unwrap().format_overlay().get(3, 5),
            Some(FormatId(14))
        );
        // Op recorded.
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops
            .iter()
            .any(|o| matches!(o, Op::SetCellFormat { id: Some(14), .. })));
    }

    #[test]
    fn set_cell_format_with_none_clears_overlay_and_emits_op() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Pre-set the binding via low-level API.
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, FormatId(14));
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            rt.set_cell_format(s, 0, 0, None).unwrap();
        }
        assert_eq!(wb.sheet(s).unwrap().format_overlay().get(0, 0), None);
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops
            .iter()
            .any(|o| matches!(o, Op::SetCellFormat { id: None, .. })));
    }

    #[test]
    fn set_cell_format_unknown_id_is_runtime_error() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_cell_format(s, 0, 0, Some(FormatId(9999)))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::UnknownFormatId(9999)));
    }

    // ===== W5-82 — read_display integration =====

    #[test]
    fn read_display_general_path_for_unbound_cell() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // No overlay entry → FormatId::GENERAL → integer renders without decimal.
        assert_eq!(rt.read_display(s, 0, 0), "42");
    }

    #[test]
    fn read_display_with_built_in_date_format() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // 2024-07-04 = serial 45477 in Excel1900.
        wb.put_at(s, 0, 0, Value::Number(45477.0));
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, FormatId(14)); // m/d/yyyy
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert_eq!(rt.read_display(s, 0, 0), "7/4/2024");
    }

    #[test]
    fn read_display_with_custom_format() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1234.5));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Intern then bind via runtime APIs (mirrors IDE-flow).
        let id = rt.intern_format("#,##0.00").unwrap();
        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        assert_eq!(rt.read_display(s, 0, 0), "1,234.50");
    }

    #[test]
    fn read_display_caches_parsed_format() {
        // Render twice; the second call should hit the cache. We can't
        // directly observe cache hits without an accessor, but we can
        // verify the render result is stable and that mutating the
        // overlay between calls produces fresh output (cache stores
        // FormatString per id, not per cell).
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        wb.put_at(s, 0, 1, Value::Number(7.5));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let id = rt.intern_format("0.00").unwrap();
        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        rt.set_cell_format(s, 0, 1, Some(id)).unwrap();
        assert_eq!(rt.read_display(s, 0, 0), "42.00");
        // Second call against a DIFFERENT cell using the SAME format id —
        // must hit the cached parsed FormatString.
        assert_eq!(rt.read_display(s, 0, 1), "7.50");
    }

    #[test]
    fn read_display_error_value_passes_sigil_through() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Error(ErrorValue::DivZero));
        // Bind to a date format — error sigils ignore the format string.
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, FormatId(14));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert_eq!(rt.read_display(s, 0, 0), "#DIV/0!");
    }

    #[test]
    fn read_display_text_value_through_at_format() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::text("hello"));
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, FormatId(49)); // @
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert_eq!(rt.read_display(s, 0, 0), "hello");
    }

    #[test]
    fn intern_and_set_cell_format_replay_round_trip() {
        // The two new ops must survive replay against a fresh workbook.
        let mut producer_wb = Workbook::new();
        let s_p = producer_wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut log);
            let id = rt.intern_format("\"€\" #,##0.00").unwrap();
            rt.set_cell_format(s_p, 0, 0, Some(id)).unwrap();
        }
        // Replay against a fresh workbook.
        let mut replay_wb = Workbook::new();
        replay_wb.add_sheet("S");
        ql_oplog::replay_into(&log, &mut replay_wb, &reg).unwrap();
        // Format registered.
        let custom_id = FormatId(ql_storage::FIRST_CUSTOM_FORMAT_ID);
        assert_eq!(
            replay_wb.formats().lookup(custom_id),
            Some("\"€\" #,##0.00")
        );
        // Cell overlay restored.
        assert_eq!(
            replay_wb.sheet(0).unwrap().format_overlay().get(0, 0),
            Some(custom_id)
        );
    }
}
