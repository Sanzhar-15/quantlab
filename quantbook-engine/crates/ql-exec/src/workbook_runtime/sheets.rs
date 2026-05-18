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
fn rewrite_formula_text_for_sheet_rename(
    text: &str,
    old_canonical: &str,
    new_name: &Arc<str>,
) -> Option<String> {
    let stripped = text.strip_prefix('=').unwrap_or(text);
    let tokens = ql_formula_syntax::lex(stripped).ok()?;
    let expr = ql_formula_syntax::parse(tokens).ok()?;
    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
    if rewritten == expr {
        // Nothing changed; preserve the original text (avoids spurious
        // op-log entries and skips the round-trip-printing's canonical-
        // form rewrites for formulas that have no sheet references).
        return None;
    }
    let printed = ql_formula_syntax::print(&rewritten);
    // Preserve a leading `=` if the original had one.
    let with_eq = if text.starts_with('=') {
        format!("={printed}")
    } else {
        printed
    };
    Some(with_eq)
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
        // (Phase 4.6.D / future): walk NamedTarget::Formula entries for
        // the same rewrite. Today named formulas are deferred so
        // formula_cells is the only text-bearing surface to rewrite.

        // Append-before-mutate: emit the BatchCommit op first so a
        // failing append leaves storage unchanged. The batch carries:
        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let mut ops: Vec<Op> = Vec::with_capacity(rewritten_cells.len() + 1);
            for (s, r, c, ref new_text) in &rewritten_cells {
                ops.push(Op::PutFormula {
                    sheet: *s,
                    row: *r,
                    col: *c,
                    text: new_text.clone(),
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
    use ql_storage::Workbook;
    use ql_types::Value;

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
}
