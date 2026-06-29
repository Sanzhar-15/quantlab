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
use ql_storage::{FormatId, Workbook};
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
        // Phase 5.2 D-1 step 4 audit Codex HIGH-1 closure: use
        // `FormatTable::lookup_string` (peer-scoped) instead of the
        // pre-audit global `iter().find()`. The old check returned
        // ANY id with this string (including remote peers' Customs
        // post-multi-peer-replay), which broke producer/replay
        // symmetry: producer would short-circuit to a remote peer's
        // id without emitting `Op::RegisterFormat`, but replay would
        // allocate a different (local-peer-namespaced) id.
        //
        // `lookup_string` mirrors `FormatTable::intern`'s lookup
        // precedence: built-in strings short-circuit globally; Custom
        // strings only short-circuit if THIS peer interned them. If
        // the string isn't in either namespace, return None and fall
        // through to allocation.
        if let Some(existing) = self.workbook.formats().lookup_string(s) {
            return Ok(existing);
        }
        // New string — predict the id the table will allocate so we can
        // emit the op BEFORE mutating (append-before-mutate ordering,
        // matching set_name / set_value).
        //
        // Phase 5.2 D-1 step 4 (2026-05-20): Op::RegisterFormat now
        // carries `FormatIdWire` directly. Drop the pre-step-4
        // `to_legacy_u32().expect(...)` conversion. The producer
        // predicts the id from `FormatTable::next_custom_counter()`
        // under `local_peer`, emits the FormatIdWire op, then
        // allocates via `intern`. Debug-assert that prediction
        // matches actual allocation.
        let formats = self.workbook.formats();
        let counter = formats.next_custom_counter();
        // Phase 5.2 D-1 step 8 megaudit closure (Opus-B LOW-2,
        // 2026-05-20): pre-check the counter against u32::MAX BEFORE
        // appending Op::RegisterFormat. Pre-closure: intern() panicked
        // at `checked_add(1).expect(...)` AFTER the op was already
        // written to the local log — log got an op that local replay
        // couldn't reproduce. Now: refuse before write.
        //
        // Reachability is implausible in practice (u32::MAX per-peer
        // intern calls = ~4.3B), but the check matches step-5 audit's
        // pre-validation discipline at register_at.
        if counter == u32::MAX {
            return Err(RuntimeError::FormatCounterExhausted {
                peer: formats.local_peer(),
            });
        }
        let id = FormatId::Custom(formats.local_peer(), counter);
        if let Some(oplog) = self.oplog.as_deref_mut() {
            // **TF8 / Wave-C (2026-06-29):** tag the registration commit with
            // `FORMAT_COMMIT_ORIGIN` so the owning session's `UndoManager`
            // (which excludes that origin prefix) does NOT record this
            // content-addressed intern as an undo unit. The op is still
            // pushed to the op-log for replay/persistence — only the commit
            // origin differs. A cell only *displays* a format via the
            // still-undoable `Op::SetCellFormat`. This also makes
            // `nudge_cell_decimals` (intern + set_cell_format) a single undo
            // unit (the SetCellFormat).
            oplog.append_with_origin(
                Op::RegisterFormat {
                    id: ql_oplog::FormatIdWire::from_storage(id),
                    string: s.to_owned(),
                },
                ql_oplog::FORMAT_COMMIT_ORIGIN,
            )?;
        }
        let allocated = self.workbook.formats_mut().intern(s);
        debug_assert_eq!(
            allocated, id,
            "FormatTable::intern allocated a different id than next_custom_counter predicted"
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
                return Err(RuntimeError::UnknownFormatId(fid));
            }
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetCellFormat {
                sheet,
                row,
                col,
                // Phase 5.2 D-1 step 4: Op carries FormatIdWire directly;
                // drop the pre-step-4 to_legacy_u32 expect.
                id: id.map(ql_oplog::FormatIdWire::from_storage),
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
        // EvalContext: workbook's date_system + workbook's locale + System now-provider.
        // The locale drives which decimal / thousands separator glyphs the number
        // renderer emits (e.g. `,` decimal for De/Fr vs `.` for EnUs).
        let ctx = EvalContext {
            date_system: self.workbook.date_system(),
            locale: self.workbook.locale(),
            ..EvalContext::default()
        };
        format::render(&value, fmt, &ctx)
    }

    /// **R9 / Wave B (2026-06-17):** increase (`delta > 0`) or decrease
    /// (`delta < 0`) the number of decimal places a cell's number format shows
    /// — Excel's "Increase/Decrease Decimal" gesture. Reads the cell's current
    /// format (an unbound cell, or one bound to `General`, is treated as the
    /// base integer format `"0"`), nudges the format-code string via
    /// [`format::nudge_format_decimals`], and — when the result differs from the
    /// cell's current bound format — interns the new format and binds the cell
    /// to it (emitting `Op::RegisterFormat` if newly allocated + an
    /// `Op::SetCellFormat`, exactly as a `register_format` + `set_cell_format`
    /// pair would).
    ///
    /// Returns the `FormatId` the cell was (re)bound to, or `None` when the
    /// nudge is a no-op: already at the clamp boundary (0 decimals on decrease,
    /// [`format::MAX_DECIMALS`] on increase), the cell already carries exactly
    /// the nudged format, `delta == 0`, or the format is non-numeric (a
    /// date/text format is left untouched).
    ///
    /// **Decrease-from-General (Excel parity):** an unbound/`General` cell
    /// decreased binds the explicit integer format `"0"` (Excel's Decrease
    /// Decimal forces integer display); increased binds `"0.0"`.
    ///
    /// A format that fails to parse surfaces [`RuntimeError::InvalidFormat`]
    /// loudly (No-Fallbacks) — never binds a corrupt format code.
    ///
    /// **Known limitation (Wave-B 5-lane audit MED; tracked for the Wave-C IDE
    /// picker):** a cell whose format uses a V2-deferred grammar the engine's
    /// format parser does not yet support — color codes (`[Red]`), conditional
    /// sections (`[>100]`), or elapsed-time (`[h]`/`[mm]`) — cannot be nudged
    /// and returns `InvalidFormat`. This includes Excel's stock accounting/
    /// currency built-ins that carry `[Red]` on the negative section. The error
    /// is loud + correct (No-Fallbacks: we will not silently mangle a format we
    /// can't fully model); the IDE picker should disable / message the
    /// increase-decimal button for such cells rather than surface the raw error.
    /// (Locale-coded currency `[$-409]`/`[$€-409]` IS supported and nudges fine.)
    pub fn nudge_cell_decimals(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        delta: i32,
    ) -> Result<Option<FormatId>, RuntimeError> {
        // Compute the nudged format string (read-only); `None` ⇒ no-op.
        match compute_nudged_format(self.workbook, sheet, row, col, delta)? {
            None => Ok(None),
            Some(nudged) => {
                let new_id = self.intern_format(&nudged)?;
                self.set_cell_format(sheet, row, col, Some(new_id))?;
                Ok(Some(new_id))
            }
        }
    }
}

/// **R9 / Wave C (2026-06-18):** the READ-ONLY half of [`WorkbookRuntime::nudge_cell_decimals`] —
/// compute the number-format STRING a cell would carry after a decimal nudge, WITHOUT interning a
/// format or rebinding the cell. Reads the cell's current format (unbound / `General` ⇒ the integer
/// base `"0"`), nudges the format-code string by `delta`, and returns the result, or `None` for a
/// no-op (`delta == 0`, the clamp boundary, or the cell already carries the nudged format).
///
/// Pure over `&Workbook` (no mutation, no oplog) so the session's `nudge_decimals_preview` can call it
/// from a `&self` read path — the IDE registers the returned string + applies it over a selection in
/// ONE batch, giving a multi-cell decimal nudge a single undo unit. `nudge_cell_decimals` (the apply
/// path) interns + rebinds whatever this returns. A format the engine cannot model (`[Red]`/conditional/
/// elapsed-time) surfaces [`RuntimeError::InvalidFormat`] loudly (No-Fallbacks — never a corrupt format).
pub(crate) fn compute_nudged_format(
    workbook: &Workbook,
    sheet: SheetId,
    row: RowId,
    col: ColId,
    delta: i32,
) -> Result<Option<String>, RuntimeError> {
    validate_cell(workbook, sheet, row, col)?;
    if delta == 0 {
        return Ok(None);
    }
    // Current bound format string (None ⇒ unbound ⇒ General default).
    let current_id = workbook
        .sheet(sheet)
        .and_then(|s| s.format_overlay().get(row, col));
    let current_str: Option<String> = match current_id {
        Some(id) => Some(
            workbook
                .formats()
                .lookup(id)
                // An overlay id absent from the table is corrupted state;
                // surface loudly rather than silently treating it as General.
                .ok_or(RuntimeError::UnknownFormatId(id))?
                .to_owned(),
        ),
        None => None,
    };
    // Base for the nudge: a non-`General` bound format nudges in place;
    // unbound OR `General` is treated as the integer base `"0"`.
    let base: &str = match current_str.as_deref() {
        Some(s) if !s.eq_ignore_ascii_case("General") => s,
        _ => "0",
    };
    let nudged = format::nudge_format_decimals(base, delta).map_err(RuntimeError::InvalidFormat)?;
    // No-op iff the cell already carries exactly the nudged format.
    if current_str.as_deref() == Some(nudged.as_str()) {
        return Ok(None);
    }
    Ok(Some(nudged))
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
            assert_eq!(id2, FormatId::Builtin(2));
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
            // Step 3: first custom under LEGACY_PEER, counter=0.
            // Round-trips to legacy u32 = 164 (FIRST_CUSTOM_FORMAT_ID).
            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
            assert_eq!(id, FormatId::Custom(ql_types::LEGACY_PEER, 0));
        }
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::RegisterFormat { id, string } => {
                // Step 4: Op carries FormatIdWire. First custom under
                // LEGACY_PEER = Custom { peer: LEGACY_PEER, counter: 0 }.
                assert_eq!(
                    *id,
                    ql_oplog::FormatIdWire::Custom {
                        peer: ql_types::LEGACY_PEER,
                        counter: 0
                    }
                );
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
            rt.set_cell_format(s, 3, 5, Some(FormatId::Builtin(14)))
                .unwrap();
        }
        // Overlay updated.
        assert_eq!(
            wb.sheet(s).unwrap().format_overlay().get(3, 5),
            Some(FormatId::Builtin(14))
        );
        // Op recorded.
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops.iter().any(|o| matches!(
            o,
            Op::SetCellFormat {
                id: Some(ql_oplog::FormatIdWire::Builtin { id: 14 }),
                ..
            }
        )));
    }

    #[test]
    fn set_cell_format_with_none_clears_overlay_and_emits_op() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // Pre-set the binding via low-level API.
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, FormatId::Builtin(14));
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
        let bad_id = FormatId::legacy_from_u32(9999);
        let err = rt.set_cell_format(s, 0, 0, Some(bad_id)).unwrap_err();
        // Step 3: UnknownFormatId carries FormatId (was u32 pre-step-3).
        // legacy_from_u32(9999) = Custom(LEGACY_PEER, 9999 - 164) = 9835.
        assert!(matches!(
            err,
            RuntimeError::UnknownFormatId(fid) if fid == bad_id
        ));
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
            .set(0, 0, FormatId::Builtin(14)); // m/d/yyyy
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
            .set(0, 0, FormatId::Builtin(14));
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
            .set(0, 0, FormatId::Builtin(49)); // @
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
        let custom_id = FormatId::legacy_from_u32(ql_storage::FIRST_CUSTOM_FORMAT_ID);
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

    // ===== R9 / Wave B — nudge_cell_decimals =====

    /// Resolve a cell's currently-bound format string (None ⇒ unbound).
    fn bound_format(wb: &Workbook, s: ql_types::SheetId, row: u32, col: u32) -> Option<String> {
        wb.sheet(s)
            .unwrap()
            .format_overlay()
            .get(row, col)
            .map(|id| wb.formats().lookup(id).unwrap().to_owned())
    }

    #[test]
    fn nudge_increase_adds_a_decimal_place() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1234.5));
        let reg = default_registry();
        let display;
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("0.00").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
            let new = rt.nudge_cell_decimals(s, 0, 0, 1).unwrap();
            assert!(new.is_some(), "increase must (re)bind a format");
            display = rt.read_display(s, 0, 0);
        }
        assert_eq!(display, "1234.500");
        assert_eq!(bound_format(&wb, s, 0, 0).as_deref(), Some("0.000"));
    }

    #[test]
    fn nudge_decrease_removes_a_decimal_place() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("0.00").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
            rt.nudge_cell_decimals(s, 0, 0, -1).unwrap();
        }
        assert_eq!(bound_format(&wb, s, 0, 0).as_deref(), Some("0.0"));
    }

    #[test]
    fn nudge_unbound_increase_binds_one_decimal() {
        // An unbound (General) cell increased ⇒ base "0" + one decimal = "0.0".
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let new = rt.nudge_cell_decimals(s, 0, 0, 1).unwrap();
            assert!(new.is_some());
        }
        assert_eq!(bound_format(&wb, s, 0, 0).as_deref(), Some("0.0"));
    }

    #[test]
    fn nudge_decrease_from_general_binds_integer_zero() {
        // Excel parity: Decrease Decimal on a General/unbound cell forces the
        // explicit integer format "0".
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let new = rt.nudge_cell_decimals(s, 0, 0, -1).unwrap();
            assert!(new.is_some());
        }
        assert_eq!(bound_format(&wb, s, 0, 0).as_deref(), Some("0"));
    }

    #[test]
    fn nudge_decrease_at_zero_decimals_is_noop() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            let id = rt.intern_format("0").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
            // Decreasing an already-integer format ⇒ no change.
            assert_eq!(rt.nudge_cell_decimals(s, 0, 0, -1).unwrap(), None);
        }
        // No SetCellFormat op beyond the initial bind (the no-op emits nothing).
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        let set_format_ops = ops
            .iter()
            .filter(|o| matches!(o, Op::SetCellFormat { .. }))
            .count();
        assert_eq!(
            set_format_ops, 1,
            "no-op nudge must not emit a SetCellFormat"
        );
    }

    // ===== R9 / Wave C (2026-06-18): compute_nudged_format (read-only preview) =====

    #[test]
    fn preview_increase_returns_more_decimals_without_mutating() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("0.00").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        }
        // Preview is read-only: returns the nudged STRING, leaves the binding intact.
        let nudged = super::compute_nudged_format(&wb, s, 0, 0, 1).unwrap();
        assert_eq!(nudged.as_deref(), Some("0.000"));
        assert_eq!(
            bound_format(&wb, s, 0, 0).as_deref(),
            Some("0.00"),
            "preview must NOT rebind the cell"
        );
    }

    #[test]
    fn preview_decrease_returns_fewer_decimals() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("0.00").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        }
        assert_eq!(
            super::compute_nudged_format(&wb, s, 0, 0, -1).unwrap().as_deref(),
            Some("0.0")
        );
    }

    #[test]
    fn preview_unbound_increase_uses_general_base() {
        // Unbound (General) cell ⇒ base "0" ⇒ increase = "0.0".
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        assert_eq!(
            super::compute_nudged_format(&wb, s, 0, 0, 1).unwrap().as_deref(),
            Some("0.0")
        );
        // Still unbound — preview never binds.
        assert_eq!(bound_format(&wb, s, 0, 0), None);
    }

    #[test]
    fn preview_explicit_general_format_uses_base() {
        // A cell EXPLICITLY bound to the "General" format string behaves like the unbound case:
        // base "0" ⇒ increase = "0.0" (the `eq_ignore_ascii_case("General")` branch in
        // compute_nudged_format). Closes the Wave-C audit LOW gap (explicit-General was untested).
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("General").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        }
        assert_eq!(
            super::compute_nudged_format(&wb, s, 0, 0, 1).unwrap().as_deref(),
            Some("0.0")
        );
    }

    #[test]
    fn preview_noop_returns_none() {
        // delta 0 ⇒ None; a bound "0" decreased ⇒ already at zero decimals ⇒ None.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("0").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        }
        assert_eq!(super::compute_nudged_format(&wb, s, 0, 0, 0).unwrap(), None);
        assert_eq!(super::compute_nudged_format(&wb, s, 0, 0, -1).unwrap(), None);
    }

    #[test]
    fn preview_and_apply_agree_on_the_nudged_string() {
        // The apply path must bind exactly what the preview returns (they share
        // compute_nudged_format) — the IDE's batched preview equals per-cell apply.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let previewed = super::compute_nudged_format(&wb, s, 0, 0, 1).unwrap();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.nudge_cell_decimals(s, 0, 0, 1).unwrap();
        }
        assert_eq!(previewed.as_deref(), bound_format(&wb, s, 0, 0).as_deref());
    }

    #[test]
    fn nudge_date_format_is_noop() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("m/d/yyyy").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
            assert_eq!(rt.nudge_cell_decimals(s, 0, 0, 1).unwrap(), None);
        }
        assert_eq!(bound_format(&wb, s, 0, 0).as_deref(), Some("m/d/yyyy"));
    }

    #[test]
    fn nudge_delta_zero_is_noop() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            assert_eq!(rt.nudge_cell_decimals(s, 0, 0, 0).unwrap(), None);
        }
        assert_eq!(bound_format(&wb, s, 0, 0), None);
    }

    #[test]
    fn nudge_emits_register_and_set_format_ops() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
            // Start from a builtin so the nudge allocates a NEW custom format.
            let id = rt.intern_format("0.00").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
            rt.nudge_cell_decimals(s, 0, 0, 1).unwrap(); // -> "0.000" (new custom)
        }
        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops.iter().any(|o| matches!(o, Op::RegisterFormat { .. })));
        assert!(ops
            .iter()
            .any(|o| matches!(o, Op::SetCellFormat { id: Some(_), .. })));
    }

    #[test]
    fn nudge_multi_step_increase() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format("0").unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
            rt.nudge_cell_decimals(s, 0, 0, 3).unwrap();
        }
        assert_eq!(bound_format(&wb, s, 0, 0).as_deref(), Some("0.000"));
    }

    #[test]
    fn nudge_increase_at_max_decimals_is_noop() {
        // Audit LOW (runtime/session lane): the increase-clamp at 30 decimals,
        // exercised through the runtime wiring (not just the pure fn).
        let at_cap = format!("0.{}", "0".repeat(30));
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let id = rt.intern_format(&at_cap).unwrap();
            rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
            // Already at the cap → increase is a no-op (Ok(None)).
            assert_eq!(rt.nudge_cell_decimals(s, 0, 0, 1).unwrap(), None);
        }
        assert_eq!(bound_format(&wb, s, 0, 0).as_deref(), Some(at_cap.as_str()));
    }

    // ===== COR-03 / TA3 — locale threading through read_display =====

    #[test]
    fn read_display_de_locale_uses_comma_decimal_dot_thousands() {
        // Workbook with De locale: #,##0.00 on 1234.56 should render "1.234,56".
        let mut wb = Workbook::new();
        wb.set_locale(ql_types::Locale::De);
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1234.56));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let id = rt.intern_format("#,##0.00").unwrap();
        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        assert_eq!(rt.read_display(s, 0, 0), "1.234,56");
    }

    #[test]
    fn read_display_enus_locale_unchanged_regression() {
        // EnUs (default) workbook: output must remain byte-identical.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1234.56));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let id = rt.intern_format("#,##0.00").unwrap();
        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        assert_eq!(rt.read_display(s, 0, 0), "1,234.56");
    }

    #[test]
    fn nudge_v2_unsupported_format_surfaces_invalid_format() {
        // Audit MED (Opus lane): a cell bound to a V2-deferred format the parser
        // can't model (e.g. a `[Red]` color code) cannot be nudged -> a loud
        // RuntimeError::InvalidFormat (No-Fallbacks), never a silent mangle.
        // (intern_format does not parse-validate at intern time, so a [Red]
        // format can be bound — mirroring an XLSX import of such a format.)
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let id = rt.intern_format("[Red]0.00").unwrap();
        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        let err = rt.nudge_cell_decimals(s, 0, 0, 1).unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidFormat(_)));
    }
}
