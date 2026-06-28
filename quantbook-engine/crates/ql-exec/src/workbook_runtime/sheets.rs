//! Sheet mutation API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.3 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Two
//! producer-side sheet methods + a tokenization-aware formula-text
//! rewriter helper used by rename_sheet. Pure code move; no
//! behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::add_sheet`] (W5-92) — append a new sheet,
//!   validate name + chunk_rows, emit `Op::AddSheet`.
//! - [`WorkbookRuntime::rename_sheet`] (W5-91) — rename by id,
//!   rewrite cross-sheet refs in stored formula text via
//!   lex→parse→rewrite→print, emit `BatchCommit` containing every
//!   `PutFormula` rewrite + the `RenameSheet` op.

use std::sync::Arc;

use ql_oplog::Op;
use ql_types::{ColId, RowId, SheetId};

use super::{RuntimeError, WorkbookRuntime};

/// **W5-91 (Phase 4.6.C):** rewrite cross-sheet refs in a formula text
/// when a sheet is renamed. Round-trips `text → lex → parse → rewrite
/// → print` so substitution is tokenization-aware (string literals,
/// quoted-sheet escapes, function calls, etc. all get the right
/// treatment).
///
/// Returns `Some(new_text)` if the rewrite changed the formula,
/// `None` otherwise (so the caller can skip the storage write +
/// op-log entry when there's nothing to record).
///
/// Defensive: if `lex` or `parse` fails (corrupted historical text),
/// returns `None` rather than propagating an error — the rename
/// shouldn't break otherwise-recoverable workbooks.
/// Sheet-rename variant of [`ql_formula_syntax::rewrite_formula_text`].
/// V2 Tier H1 closure (2026-05-20): formerly an open-coded duplicate
/// of the lex/parse/rewrite/print round-trip; now a thin wrapper.
fn rewrite_formula_text_for_sheet_rename(
    text: &str,
    old_canonical: &str,
    new_name: &Arc<str>,
) -> Option<String> {
    ql_formula_syntax::rewrite_formula_text(
        text,
        ql_formula_syntax::NameRewrite::Sheet {
            old_canonical,
            new_display: new_name,
        },
    )
}

impl<'a> WorkbookRuntime<'a> {
    /// **W5-92 (Phase 4.6.D):** create a new sheet,
    /// emitting `Op::AddSheet` into the attached op log (if any). Returns
    /// the new sheet's `SheetId`. Wraps `Workbook::add_sheet_with_chunk_rows`.
    ///
    /// `chunk_rows` is the per-sheet chunk size. Pass `16_384` (the engine
    /// default) unless you have a specific reason — the qbook loader uses
    /// the saved chunk_rows so layouts round-trip.
    ///
    /// Direct callers of `Workbook::add_sheet` / `add_sheet_with_chunk_rows`
    /// bypass the op log silently — that path is documented as low-level.
    /// See GAP-O-02 in `docs/known-gaps.md`.
    pub fn add_sheet(
        &mut self,
        name: impl Into<String>,
        chunk_rows: u32,
    ) -> Result<SheetId, RuntimeError> {
        // Phase 2B.7 audit H1: pre-validate inputs BEFORE the op-log append
        // so a bad value can't leave a phantom AddSheet in the log followed
        // by a process-killing panic from `ColumnStore::with_chunk_rows` or
        // `Workbook::add_sheet_with_chunk_rows` (assert on `id >= SheetId::MAX`).
        if chunk_rows == 0 {
            return Err(RuntimeError::InvalidChunkRows(chunk_rows));
        }
        let current_sheet_count = self.workbook.sheet_count() as u32;
        if current_sheet_count >= SheetId::MAX as u32 {
            return Err(RuntimeError::TooManySheets {
                current: current_sheet_count,
                max: SheetId::MAX as u32,
            });
        }

        let name: String = name.into();
        // **W5-93 (Phase 4.6.E closure):** pre-validate the name BEFORE
        // appending to the op log so a duplicate or reserved-char name
        // can't leave a phantom `AddSheet` entry followed by a failed
        // mutation. Codex HIGH-1 flagged that the prior path silently
        // accepted any name at the storage boundary.
        self.workbook
            .validate_sheet_name(&name)
            .map_err(RuntimeError::SheetName)?;
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::AddSheet {
                name: name.clone(),
                chunk_rows,
            })?;
        }
        // Now infallible: validation already passed, so the storage call
        // can't return an error. Routes through the panicking convenience
        // wrapper.
        let new_id = self.workbook.add_sheet_with_chunk_rows(name, chunk_rows);

        // Phase 3.1: notify calcgraph. Today a counter-bump; Phase 4.6
        // will use this to track per-sheet structure generations for
        // cross-sheet reference invalidation.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_add_sheet(new_id);
        }

        Ok(new_id)
    }

    /// **W5-91 (Phase 4.6.C):** rename a sheet by id. Walks every
    /// stored formula in `formula_cells` and every `NamedTarget::Formula`
    /// entry, rewrites cross-sheet references to the new sheet name via
    /// `lex → parse → rewrite → print`, emits the rewritten text + the
    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
    /// the rewrites to storage, then swaps `Sheet::name`. Bumps the
    /// `PlanCache` generation so cached bound plans miss on the next
    /// recompute.
    ///
    /// Validation: rejects empty / Excel-reserved-char / canonical-
    /// duplicate new names via `Workbook::validate_sheet_name`.
    ///
    /// **Tokenization-aware:** the parse + rewrite + print round-trip
    /// catches every sheet-qualified ref in the AST, including those
    /// inside string literals' position (it doesn't actually substitute
    /// inside `"..."` because the parser keeps those as `Expr::String`).
    /// If a formula's text fails to lex/parse (corrupt input from a
    /// historical bug), the text is left UNCHANGED — defensive against
    /// breaking otherwise-recoverable workbooks at rename time.
    ///
    /// Direct callers of `Workbook::rename_sheet` bypass formula-text
    /// rewriting + op-log recording — that path is loader-only.
    pub fn rename_sheet(
        &mut self,
        id: SheetId,
        new_name: impl Into<String>,
    ) -> Result<(), RuntimeError> {
        let new_name: String = new_name.into();
        // Capture old name BEFORE any mutation (defensive — if anything
        // below errors, the workbook stays as-is).
        let old_name = self.workbook.sheet(id).map(|s| s.name().to_owned()).ok_or(
            RuntimeError::InvalidSheet {
                sheet: id,
                sheet_count: self.workbook.sheet_count(),
            },
        )?;
        // Validate new name. Skip the validation if canonical name is
        // unchanged (case-only rename is allowed); `Workbook::rename_sheet`
        // will apply the display update.
        let old_canonical = ql_storage::Workbook::canonical_sheet_name(&old_name);
        let new_canonical = ql_storage::Workbook::canonical_sheet_name(&new_name);
        if new_canonical != old_canonical {
            self.workbook.validate_sheet_name(&new_name)?;
        }
        // Rewrite stored formula text. Collect rewrites into a batch so
        // the op log records them alongside the rename atomically.
        let new_name_arc: Arc<str> = Arc::from(new_name.as_str());
        let mut rewritten_cells: Vec<(SheetId, RowId, ColId, String)> = Vec::new();
        for (sheet, row, col, text) in self.workbook.iter_formulas() {
            if let Some(new_text) =
                rewrite_formula_text_for_sheet_rename(text.as_ref(), &old_canonical, &new_name_arc)
            {
                rewritten_cells.push((sheet, row, col, new_text));
            }
        }
        // GAP-B-06: named-formula bodies (`NamedTarget::Formula`) carry raw
        // text that may reference the renamed sheet by name — rewrite them the
        // same way cell formulas are. `rewrite_formula_text_for_sheet_rename`
        // only touches sheet-QUALIFIED refs (`NameRewrite::Sheet`), so a name's
        // scope (workbook-global vs sheet-scoped) does not change the result;
        // both name tables are walked. The binder still rejects
        // `NamedTarget::Formula` (`NamedFormulaUnsupported`, latent), but the
        // bodies persist in the op log + .qbook and round-trip, so the stored
        // text MUST follow the rename. Collected here (immutable borrow), then
        // dual-written below alongside the cell rewrites.
        let mut rewritten_names: Vec<(Option<SheetId>, String, Arc<str>)> = Vec::new();
        for (name, target) in self.workbook.names().iter() {
            if let ql_storage::NamedTarget::Formula(body) = target {
                if let Some(new_body) = rewrite_formula_text_for_sheet_rename(
                    body.as_ref(),
                    &old_canonical,
                    &new_name_arc,
                ) {
                    rewritten_names.push((
                        None,
                        name.as_ref().to_owned(),
                        Arc::from(new_body.as_str()),
                    ));
                }
            }
        }
        // Scoped names on EVERY sheet, INCLUDING tombstoned ones: their storage
        // + scoped names are retained and restorable (v1 has no hard delete and
        // never reuses a sheet id), so a scoped Formula that qualifies the
        // renamed sheet must be rewritten — else a later `RestoreSheet` resurfaces
        // a stale body (Codex w141 HIGH).
        let sheet_count = self.workbook.sheet_count() as SheetId;
        for sid in 0..sheet_count {
            // sid < sheet_count == sheets.len() → always Some; fail loud otherwise.
            let s = self
                .workbook
                .sheet(sid)
                .expect("sheet(sid): sid < sheet_count is an invariant");
            for (name, target) in s.scoped_names().iter() {
                if let ql_storage::NamedTarget::Formula(body) = target {
                    // NF-07 (inherited): a body that fails to lex/parse yields
                    // None and is left un-rewritten — the same documented
                    // contract as the cell-formula path above (a corrupt body
                    // also can't bind, so no NEW error is hidden here).
                    if let Some(new_body) = rewrite_formula_text_for_sheet_rename(
                        body.as_ref(),
                        &old_canonical,
                        &new_name_arc,
                    ) {
                        rewritten_names.push((
                            Some(sid),
                            name.as_ref().to_owned(),
                            Arc::from(new_body.as_str()),
                        ));
                    }
                }
            }
        }

        // Append-before-mutate: emit the BatchCommit op first so a
        // failing append leaves storage unchanged. The batch carries:
        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let mut ops: Vec<Op> =
                Vec::with_capacity(rewritten_cells.len() + rewritten_names.len() + 1);
            for (s, r, c, ref new_text) in &rewritten_cells {
                ops.push(Op::PutFormula {
                    sheet: *s,
                    row: *r,
                    col: *c,
                    text: new_text.clone(),
                });
            }
            for (scope, name, new_body) in &rewritten_names {
                ops.push(Op::SetName {
                    scope: *scope,
                    name: name.to_ascii_uppercase(),
                    target: ql_io::NamedTargetWire::from_target(&ql_storage::NamedTarget::Formula(
                        new_body.clone(),
                    )),
                });
            }
            ops.push(Op::RenameSheet {
                id,
                old_name: old_name.clone(),
                new_name: new_name.clone(),
            });
            oplog.append(Op::BatchCommit { ops })?;
        }
        // Apply mutations. Rewrites go in first so the storage layer
        // never sees a state where the sheet name is new but formula
        // text still references the old name. (Order matters only for
        // observers that race — single-threaded mutation doesn't care,
        // but the invariant is cleaner.)
        for (s, r, c, new_text) in rewritten_cells {
            self.workbook.put_formula(s, r, c, new_text.as_str());
        }
        // Dual-write the named-formula rewrites to storage too (the op above is
        // the durable/replay record; this keeps the live in-memory workbook in
        // sync without a full replay, mirroring the cell `put_formula` path).
        // A re-set of an already-present, already-valid name cannot fail
        // (`would_accept` passed when it was first defined; the target is a
        // valid `Formula`) — an `Err` here is a broken invariant, so fail loud.
        for (scope, name, new_body) in rewritten_names {
            let target = ql_storage::NamedTarget::Formula(new_body);
            match scope {
                None => self.workbook.set_name(&name, target).expect(
                    "rename: re-setting an existing valid global named formula cannot fail",
                ),
                Some(sid) => self
                    .workbook
                    .sheet_mut(sid)
                    .expect("rename: scoped sheet existed during collection above")
                    .set_scoped_name(&name, target)
                    .expect(
                        "rename: re-setting an existing valid scoped named formula cannot fail",
                    ),
            }
        }
        // Swap the name. Cannot fail here — validation already passed.
        self.workbook
            .rename_sheet(id, new_name)
            .expect("rename_sheet validation already passed");
        // Wipe the PlanCache so cached bound plans (which baked in the
        // old SheetId via SheetRef::Name resolution) miss on next
        // recompute and rebind against the new sheet name. Sheet
        // rename is edit-rate, not recompute-rate; a full cache flush
        // is acceptable per design § 10.5 / Codex MEDIUM-7. (A
        // finer-grained `sheet_gen` counter could be wired in a follow-
        // up — filed as a future polish item.)
        self.plan_cache.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::Value;
    use std::sync::Arc;

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    // ===== W5-91 (Phase 4.6.C) rename_sheet =====

    #[test]
    fn rename_sheet_rewrites_formula_text_and_recomputes() {
        // S1!A1 = 10 ; S2!A1 = S1!A1 * 2 = 20.
        // Rename S1 → SheetX. Stored formula on S2!A1 must read
        // "SheetX!A1 ..."; recompute must still produce 20.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let s2 = wb.add_sheet("S2");
        wb.put_at(s1, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s2, 0, 0, "S1!A1 * 2").unwrap();
        rt.rename_sheet(s1, "SheetX").unwrap();
        let _ = rt.recompute_all();
        drop(rt);
        assert_eq!(wb.sheet(s1).unwrap().name(), "SheetX");
        let new_text = wb
            .formula_at(s2, 0, 0)
            .map(|s| s.as_ref().to_owned())
            .unwrap_or_default();
        assert!(
            new_text.contains("SheetX!A1"),
            "expected rewrite to mention SheetX!A1, got: {new_text:?}"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(s2, 0, 0)),
            Value::Number(20.0)
        );
    }

    #[test]
    fn rename_sheet_leaves_unrelated_formulas_alone() {
        // S1!A1 = 10, S1!B1 = A1*2 (no sheet prefix, owning-sheet relative).
        // S2 exists. Rename S2 → SheetX. S1!B1's formula text must not change.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let s2 = wb.add_sheet("S2");
        wb.put_at(s1, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s1, 0, 1, "A1 * 2").unwrap();
        let before = wb
            .formula_at(s1, 0, 1)
            .map(|s| s.as_ref().to_owned())
            .unwrap_or_default();

        // Re-borrow.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s2, "SheetX").unwrap();
        drop(rt);

        let after = wb
            .formula_at(s1, 0, 1)
            .map(|s| s.as_ref().to_owned())
            .unwrap_or_default();
        assert_eq!(before, after);
    }

    #[test]
    fn rename_sheet_duplicate_target_rejected_runtime() {
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let _s2 = wb.add_sheet("S2");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.rename_sheet(s1, "s2").unwrap_err();
        assert!(matches!(err, RuntimeError::SheetName(_)));
        drop(rt);
        assert_eq!(wb.sheet(s1).unwrap().name(), "S1");
    }

    #[test]
    fn rename_sheet_unknown_id_rejected_runtime() {
        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S1");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.rename_sheet(42, "X").unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidSheet { .. }));
    }

    #[test]
    fn rename_sheet_case_only_rename_runtime() {
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("Sheet1");
        wb.put_at(s1, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s1, 0, 1, "Sheet1!A1 + 1").unwrap();
        rt.rename_sheet(s1, "SHEET1").unwrap();
        let _ = rt.recompute_all();
        drop(rt);
        assert_eq!(wb.sheet(s1).unwrap().name(), "SHEET1");
        assert_eq!(
            wb.read(ql_types::Address::new(s1, 0, 1)),
            Value::Number(11.0)
        );
    }

    // ===== GAP-B-06 — named-formula (`NamedTarget::Formula`) bodies are
    // rewritten on sheet rename, the same as cell formulas. Tests cover the
    // storage dual-write (observable on the live workbook) + the op emission.

    #[test]
    fn rename_sheet_rewrites_global_named_formula_qualified_ref() {
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S1!A1 - 1")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s1, "Renamed").unwrap();
        drop(rt);
        match wb.names().lookup_ci("Profit").expect("name present") {
            NamedTarget::Formula(b) => {
                assert!(b.contains("Renamed!A1"), "got {b:?}");
                assert!(!b.contains("S1!"), "stale ref survived: {b:?}");
            }
            other => panic!("expected Formula, got {other:?}"),
        }
    }

    #[test]
    fn rename_sheet_rewrites_scoped_named_formula() {
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        wb.sheet_mut(s1)
            .unwrap()
            .set_scoped_name("Local", NamedTarget::Formula(Arc::from("S1!B2 * 2")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s1, "Renamed").unwrap();
        drop(rt);
        match wb
            .sheet(s1)
            .unwrap()
            .scoped_names()
            .lookup_ci("Local")
            .expect("scoped name present")
        {
            NamedTarget::Formula(b) => assert!(b.contains("Renamed!B2"), "got {b:?}"),
            other => panic!("expected Formula, got {other:?}"),
        }
    }

    #[test]
    fn rename_sheet_leaves_unrelated_named_formula_alone() {
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let _s2 = wb.add_sheet("S2");
        // References S2, but S1 is renamed → must be untouched.
        wb.set_name("Other", NamedTarget::Formula(Arc::from("S2!A1 - 1")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s1, "Renamed").unwrap();
        drop(rt);
        match wb.names().lookup_ci("Other").expect("name present") {
            NamedTarget::Formula(b) => assert_eq!(b.as_ref(), "S2!A1 - 1"),
            other => panic!("expected Formula, got {other:?}"),
        }
    }

    #[test]
    fn rename_sheet_named_formula_emits_set_name_op() {
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S1!A1 - 1")))
            .unwrap();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.rename_sheet(s1, "Renamed").unwrap();
        }
        // The rename batch must carry a SetName overwriting the named formula.
        let mut found = false;
        for op_res in oplog.iter() {
            if let Op::BatchCommit { ops } = op_res.expect("op decodes") {
                for op in ops {
                    if let Op::SetName { name, target, .. } = op {
                        if name == "PROFIT" {
                            match target.to_target(&name).expect("decode wire target") {
                                NamedTarget::Formula(b) => {
                                    assert!(b.contains("Renamed!A1"), "got {b:?}");
                                    found = true;
                                }
                                other => panic!("expected Formula, got {other:?}"),
                            }
                        }
                    }
                }
            }
        }
        assert!(
            found,
            "rename batch must emit SetName for the named formula"
        );
    }

    #[test]
    fn rename_sheet_rewrites_tombstoned_sheet_scoped_named_formula() {
        // Codex w141 HIGH regression: a scoped formula on a TOMBSTONED sheet that
        // qualifies the renamed sheet must still be rewritten (the sheet is
        // restorable, so a stale body would resurface on RestoreSheet).
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let s2 = wb.add_sheet("S2");
        wb.sheet_mut(s2)
            .unwrap()
            .set_scoped_name("X", NamedTarget::Formula(Arc::from("S1!A1 - 1")))
            .unwrap();
        wb.remove_sheet(s2); // tombstone S2 (scoped names retained)
        assert!(wb.is_sheet_removed(s2));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s1, "Renamed").unwrap();
        drop(rt);
        match wb
            .sheet(s2)
            .unwrap()
            .scoped_names()
            .lookup_ci("X")
            .expect("scoped name retained on tombstoned sheet")
        {
            NamedTarget::Formula(b) => assert!(b.contains("Renamed!A1"), "got {b:?}"),
            other => panic!("expected Formula, got {other:?}"),
        }
    }

    #[test]
    fn rename_sheet_leaves_workbook_scoped_bare_ref_named_formula_alone() {
        // A bare ref has no sheet identity; a rename must not touch it.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        wb.set_name("Bare", NamedTarget::Formula(Arc::from("A5 - 1")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s1, "Renamed").unwrap();
        drop(rt);
        match wb.names().lookup_ci("Bare").unwrap() {
            NamedTarget::Formula(b) => assert_eq!(b.as_ref(), "A5 - 1"),
            other => panic!("expected Formula, got {other:?}"),
        }
    }

    #[test]
    fn rename_sheet_to_name_with_space_quotes_named_formula_ref() {
        // Renaming to a name that needs quoting must produce a quoted ref body.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        wb.set_name("Profit", NamedTarget::Formula(Arc::from("S1!A1 - 1")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s1, "My Sheet").unwrap();
        drop(rt);
        match wb.names().lookup_ci("Profit").unwrap() {
            NamedTarget::Formula(b) => {
                assert!(b.contains("'My Sheet'!A1"), "got {b:?}")
            }
            other => panic!("expected Formula, got {other:?}"),
        }
    }

    // ===== W5-93 (Phase 4.6.E closure) — add_sheet pre-validation =====
    //
    // **Tier D1 Step 3.4 cleanup:** these add_sheet tests were missed
    // by Step 3.3 (left behind under the original W5-93 banner in
    // mod.rs). Moved here alongside Step 3.4's names extraction.

    #[test]
    fn add_sheet_rejects_canonical_duplicate() {
        // Codex HIGH-1: WorkbookRuntime::add_sheet must pre-validate.
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.add_sheet("SHEET1", 16).unwrap_err();
        assert!(matches!(err, RuntimeError::SheetName(_)));
        // Workbook unchanged (only the original sheet).
        drop(rt);
        assert_eq!(wb.sheet_count(), 1);
    }

    #[test]
    fn add_sheet_rejects_reserved_char() {
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.add_sheet("Bad/Sheet", 16).unwrap_err();
        assert!(matches!(err, RuntimeError::SheetName(_)));
    }

    #[test]
    fn add_sheet_with_bad_name_emits_no_oplog_entry() {
        // Pre-validation must run BEFORE the op log append so a bad
        // name doesn't leave a phantom AddSheet in the log.
        use ql_oplog::{Op, OpLog};
        let mut wb = Workbook::new();
        wb.add_sheet("Sheet1");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        let _ = rt.add_sheet("Sheet1", 16).unwrap_err();
        drop(rt);
        let ops: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(
            ops.len(),
            0,
            "no Op::AddSheet for rejected name; got {ops:?}"
        );
    }

    /// Phase 2B.7 audit H1: `add_sheet` rejects `chunk_rows == 0`
    /// BEFORE any op-log append. Without this check, the workbook gets
    /// a sheet with `chunk_rows = 0` and the first cell write panics
    /// inside the column store — and the op log has a phantom AddSheet
    /// entry that would replay the same poison state on next load.
    ///
    /// Phase 5 V1 V2 V2 D1.a re-partitioning: moved from
    /// `validate.rs::tests` to its natural owning submodule
    /// `sheets.rs::tests`.
    #[test]
    fn add_sheet_rejects_zero_chunk_rows() {
        use ql_oplog::OpLog;
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let result = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.add_sheet("Bad", 0)
        };
        match result {
            Err(RuntimeError::InvalidChunkRows(0)) => {}
            other => panic!("expected InvalidChunkRows(0), got {other:?}"),
        }
        // No sheet added; no op-log entry.
        assert_eq!(wb.sheet_count(), 0);
        assert!(
            oplog.is_empty(),
            "op log must stay empty on validation failure"
        );
    }
}
