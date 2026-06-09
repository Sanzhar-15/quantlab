//! Phase 5.3 V2 Tier H1 closure (2026-05-20) — unified
//! formula-text rewriter for sheet / table / column renames.
//!
//! Pre-closure 6 call sites duplicated the same
//! `lex → parse → rewrite_<kind> → print` round-trip + leading-`=`
//! preservation logic across `ql-collab` (3 sites in `repair.rs`)
//! and `ql-exec` (3 sites in `workbook_runtime/{sheets,tables}.rs`).
//! Each site only varied in WHICH `rewrite_*` AST helper it called.
//!
//! Step 5 megaudit Codex M1 + Opus-B M1 (convergent across both
//! audit lanes) flagged the duplication. Step 5c LOW grew the count
//! to 6 sites. Closed in this V2 Tier H8-H1 follow-up.
//!
//! ## Algorithm
//!
//! ```text
//! 1. Strip leading `=` (some callers store formulas with the `=`
//!    prefix, others without — handle both).
//! 2. Lex; on error return None (malformed formula — caller's
//!    recompute will surface it).
//! 3. Parse; on error return None (same rationale).
//! 4. Dispatch to the kind-specific `rewrite_*` AST helper.
//! 5. If the AST didn't change, return None (signals caller "no
//!    rewrite needed" so they can skip the PutFormula op-log emit
//!    + avoid spurious canonical-form whitespace rewrites).
//! 6. Print + re-attach leading `=` if the original had one.
//! ```

use crate::{
    lex, parse, print, rewrite_column_ref, rewrite_sheet_name_in_expr, rewrite_table_ref,
    shift_cell_refs, ShiftAxis, ShiftOp, ShiftScope,
};
use std::sync::Arc;

/// Specifies which rename rewrite to apply via [`rewrite_formula_text`].
///
/// Mirrors the three kinds of `ql_oplog::Op::Rename*` ops:
/// `RenameSheet`, `RenameTable`, `RenameColumn`. The kind-specific
/// fields match the underlying AST rewriter signatures —
/// [`rewrite_sheet_name_in_expr`], [`rewrite_table_ref`],
/// [`rewrite_column_ref`].
#[derive(Debug, Clone)]
pub enum NameRewrite<'a> {
    /// Rename a sheet. `old_canonical` is the case-insensitive
    /// historic canonical name; `new_display` is the new display
    /// (case-preserved) name. The rewriter substitutes every
    /// `SheetRef::Name(s)` where `s.eq_ignore_ascii_case(old_canonical)`.
    Sheet {
        old_canonical: &'a str,
        new_display: &'a Arc<str>,
    },
    /// Rename a table. `old_canonical` is the historic uppercase
    /// canonical table name; `new_display` is the new display name.
    /// The rewriter substitutes the `table_name` field of every
    /// `Expr::StructuredRef` whose `table_name.eq_ignore_ascii_case(old_canonical)`.
    Table {
        old_canonical: &'a str,
        new_display: &'a Arc<str>,
    },
    /// Rename a column within a specific table. `table_canonical_upper`
    /// scopes the rewrite to that table; `old_col` is the historic
    /// column name (any case — `eq_ignore_ascii_case` match);
    /// `new_display` is the new display name. Refs to OTHER tables'
    /// columns of the same name are left untouched.
    Column {
        table_canonical_upper: &'a str,
        old_col: &'a str,
        new_display: &'a Arc<str>,
    },
}

/// Apply a rename rewrite to a formula's text.
///
/// Routes through `lex → parse → rewrite → print` so substitution
/// is tokenization-aware (won't accidentally match inside string
/// literals etc.) and the result is canonically formatted.
///
/// # Returns
///
/// - `Some(new_text)` if the AST changed. Preserves a leading `=`
///   if the original had one.
/// - `None` if:
///   - The text doesn't lex (malformed — caller's recompute will
///     surface it).
///   - The text doesn't parse (same rationale).
///   - The AST didn't reference the renamed entity (no-op rewrite).
///
/// # Side effects
///
/// The output text is the printer's CANONICAL form: whitespace
/// normalized, operator spacing added (`A+B` → `A + B`), function
/// names uppercased (`sum(x)` → `SUM(x)`), etc. Formulas the
/// rewrite touches get this canonicalization; formulas it doesn't
/// touch (returns `None`) preserve their original text.
pub fn rewrite_formula_text(text: &str, rewrite: NameRewrite<'_>) -> Option<String> {
    let stripped = text.strip_prefix('=').unwrap_or(text);
    let tokens = lex(stripped).ok()?;
    let expr = parse(tokens).ok()?;
    let rewritten = match rewrite {
        NameRewrite::Sheet {
            old_canonical,
            new_display,
        } => rewrite_sheet_name_in_expr(&expr, old_canonical, new_display),
        NameRewrite::Table {
            old_canonical,
            new_display,
        } => rewrite_table_ref(&expr, old_canonical, new_display),
        NameRewrite::Column {
            table_canonical_upper,
            old_col,
            new_display,
        } => rewrite_column_ref(&expr, table_canonical_upper, old_col, new_display),
    };
    if rewritten == expr {
        return None;
    }
    let printed = print(&rewritten);
    let with_eq = if text.starts_with('=') {
        format!("={printed}")
    } else {
        printed
    };
    Some(with_eq)
}

/// **W3 (insert/delete rows & columns):** shift the row/col coordinate of
/// every reference in a formula's text that resolves to the structurally-
/// edited sheet. Routes through `lex → parse → shift → print` so substitution
/// is tokenization-aware (won't touch string literals; tolerates whitespace-
/// padded sheet refs like `S1 !A1` since the lexer normalizes them).
///
/// # Returns
///
/// - `Some(new_text)` if the AST changed (preserving a leading `=`).
/// - `None` if the text doesn't lex / doesn't parse / contains no reference
///   to the edited sheet (no-op shift). Mirrors [`rewrite_formula_text`]'s
///   contract so the producer can skip the `PutFormula` op for untouched
///   formulas.
///
/// A reference whose coordinate is deleted or overflows the axis maximum
/// becomes `#REF!` (`Expr::Error(ErrorValue::Ref)`), which prints as `#REF!`
/// and round-trips losslessly.
pub fn shift_formula_text(
    text: &str,
    axis: ShiftAxis,
    op: ShiftOp,
    scope: ShiftScope<'_>,
) -> Option<String> {
    let stripped = text.strip_prefix('=').unwrap_or(text);
    let tokens = lex(stripped).ok()?;
    let expr = parse(tokens).ok()?;
    let shifted = shift_cell_refs(&expr, axis, op, scope);
    if shifted == expr {
        return None;
    }
    let printed = print(&shifted);
    let with_eq = if text.starts_with('=') {
        format!("={printed}")
    } else {
        printed
    };
    Some(with_eq)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sheet_rewrite_preserves_leading_equals() {
        let new = Arc::from("S2");
        let out = rewrite_formula_text(
            "=S!A1",
            NameRewrite::Sheet {
                old_canonical: "S",
                new_display: &new,
            },
        );
        assert_eq!(out, Some("=S2!A1".to_string()));
    }

    #[test]
    fn sheet_rewrite_without_leading_equals() {
        let new = Arc::from("S2");
        let out = rewrite_formula_text(
            "S!A1",
            NameRewrite::Sheet {
                old_canonical: "S",
                new_display: &new,
            },
        );
        assert_eq!(out, Some("S2!A1".to_string()));
    }

    #[test]
    fn no_change_returns_none() {
        let new = Arc::from("S2");
        let out = rewrite_formula_text(
            "1 + 2",
            NameRewrite::Sheet {
                old_canonical: "S",
                new_display: &new,
            },
        );
        assert_eq!(out, None);
    }

    #[test]
    fn malformed_text_returns_none() {
        let new = Arc::from("S2");
        // `[` without context is a lex error.
        let out = rewrite_formula_text(
            "[",
            NameRewrite::Sheet {
                old_canonical: "S",
                new_display: &new,
            },
        );
        assert_eq!(out, None);
    }

    #[test]
    fn table_rewrite_preserves_other_tables() {
        let new = Arc::from("Sales");
        let out = rewrite_formula_text(
            "T[A]+Revenue[A]",
            NameRewrite::Table {
                old_canonical: "T",
                new_display: &new,
            },
        );
        // T → Sales; Revenue stays. Printer canonicalizes `+` → ` + `.
        assert_eq!(out, Some("Sales[A] + Revenue[A]".to_string()));
    }

    #[test]
    fn column_rewrite_scoped_to_owning_table() {
        let new = Arc::from("AA");
        let out = rewrite_formula_text(
            "T[A]+T[B]",
            NameRewrite::Column {
                table_canonical_upper: "T",
                old_col: "A",
                new_display: &new,
            },
        );
        // T[A] → T[AA]; T[B] untouched.
        assert_eq!(out, Some("T[AA] + T[B]".to_string()));
    }

    // ========================================================================
    // W3 (insert/delete rows & columns) — shift_formula_text trap coverage.
    // ========================================================================

    /// Scope: the formula lives on the edited sheet "S0" (id 0), so bare
    /// (`Current`) refs shift. The single helper for the common case.
    fn owner_scope() -> ShiftScope<'static> {
        ShiftScope {
            edited_canonical: "S0",
            edited_id: 0,
            owner_is_edited: true,
        }
    }

    fn insert_rows(text: &str, at: u32, count: u32) -> Option<String> {
        shift_formula_text(
            text,
            ShiftAxis::Row,
            ShiftOp::Insert { at, count },
            owner_scope(),
        )
    }
    fn delete_rows(text: &str, start: u32, end: u32) -> Option<String> {
        shift_formula_text(
            text,
            ShiftAxis::Row,
            ShiftOp::Delete { start, end },
            owner_scope(),
        )
    }
    fn insert_cols(text: &str, at: u32, count: u32) -> Option<String> {
        shift_formula_text(
            text,
            ShiftAxis::Col,
            ShiftOp::Insert { at, count },
            owner_scope(),
        )
    }
    fn delete_cols(text: &str, start: u32, end: u32) -> Option<String> {
        shift_formula_text(
            text,
            ShiftAxis::Col,
            ShiftOp::Delete { start, end },
            owner_scope(),
        )
    }

    // --- Trap: constants / function-only formulas unchanged ---------------

    #[test]
    fn shift_constant_only_is_noop() {
        assert_eq!(insert_rows("1 + 2", 0, 1), None);
        assert_eq!(insert_rows("=1 + 2", 0, 1), None);
        assert_eq!(delete_rows("\"hello\"", 0, 5), None);
    }

    #[test]
    fn shift_function_no_refs_is_noop() {
        assert_eq!(insert_rows("=PI()", 0, 1), None);
        assert_eq!(insert_rows("=NOW()", 0, 1), None);
    }

    // --- Trap: basic row insert shifts refs at/after the point ------------

    #[test]
    fn insert_row_shifts_ref_at_or_below() {
        // =A5 (row index 4). Insert 1 row at index 2 (3rd row). A5 → A6.
        assert_eq!(insert_rows("=A5", 2, 1), Some("=A6".to_string()));
        // Ref ABOVE the insert point is unchanged.
        assert_eq!(insert_rows("=A2", 2, 1), None);
        // Ref AT the insert point shifts (>= at).
        assert_eq!(insert_rows("=A3", 2, 1), Some("=A4".to_string()));
    }

    #[test]
    fn insert_multiple_rows_shifts_by_count() {
        assert_eq!(insert_rows("=A5", 0, 3), Some("=A8".to_string()));
    }

    // --- Trap: the 4 fixed/relative combos ($ preserved, coord shifts) ----

    #[test]
    fn insert_row_shifts_all_four_dollar_combos() {
        // A1 (relative both) — row shifts.
        assert_eq!(insert_rows("=A5", 0, 1), Some("=A6".to_string()));
        // $A$1 (absolute both) — Excel structural insert STILL shifts the
        // coordinate; the $ markers are preserved.
        assert_eq!(insert_rows("=$A$5", 0, 1), Some("=$A$6".to_string()));
        // A$1 (row absolute) — row shifts, $ preserved.
        assert_eq!(insert_rows("=A$5", 0, 1), Some("=A$6".to_string()));
        // $A1 (col absolute) — row shifts, $A preserved.
        assert_eq!(insert_rows("=$A5", 0, 1), Some("=$A6".to_string()));
    }

    #[test]
    fn insert_col_shifts_all_four_dollar_combos() {
        // Column insert at index 0 (before A): all refs in/after col A move.
        assert_eq!(insert_cols("=B5", 0, 1), Some("=C5".to_string()));
        assert_eq!(insert_cols("=$B$5", 0, 1), Some("=$C$5".to_string()));
        assert_eq!(insert_cols("=B$5", 0, 1), Some("=C$5".to_string()));
        assert_eq!(insert_cols("=$B5", 0, 1), Some("=$C5".to_string()));
    }

    // --- Trap: whitespace-padded sheet refs (=S0 !A1) ---------------------

    #[test]
    fn shift_tolerates_whitespace_padded_sheet_ref() {
        // Lexer tolerates whitespace before `!`. The ref is on the edited
        // sheet (S0), so its row shifts; the printer normalizes to `S0!A6`.
        let out = insert_rows("=S0 !A5", 0, 1);
        assert_eq!(out, Some("=S0!A6".to_string()));
    }

    // --- Trap: out-of-bounds → #REF! --------------------------------------

    #[test]
    fn insert_at_max_row_overflows_to_ref() {
        // A ref at the last row (index MAX_ROW) pushed down by 1 → #REF!.
        let last = crate::MAX_ROW; // 1_048_575
        let text = format!("=A{}", last + 1); // 1-indexed display
        let out = shift_formula_text(
            &text,
            ShiftAxis::Row,
            ShiftOp::Insert { at: 0, count: 1 },
            owner_scope(),
        );
        assert_eq!(out, Some("=#REF!".to_string()));
    }

    // --- Trap: deleted ref → #REF! (incl. multi-ref formula) --------------

    #[test]
    fn delete_row_makes_pointed_ref_a_ref_error() {
        // =A3 (row index 2). Delete rows [2,2]. The pointed row is gone.
        assert_eq!(delete_rows("=A3", 2, 2), Some("=#REF!".to_string()));
    }

    #[test]
    fn delete_row_ref_error_in_multi_ref_formula() {
        // =A3 + A10. Delete row index 2 (A3). A3 → #REF!, A10 → A9.
        assert_eq!(
            delete_rows("=A3 + A10", 2, 2),
            Some("=#REF! + A9".to_string())
        );
    }

    #[test]
    fn delete_row_shifts_refs_below_block() {
        // =A10. Delete rows [2,4] (3 rows). A10 (index 9) → index 6 → A7.
        assert_eq!(delete_rows("=A10", 2, 4), Some("=A7".to_string()));
        // Ref above the block unchanged.
        assert_eq!(delete_rows("=A2", 2, 4), None);
    }

    // --- Trap: range shrink + collapse ------------------------------------

    #[test]
    fn delete_rows_shrinks_range_partially() {
        // =SUM(A2:A5). Delete rows [1,2] (indices 1,2 = rows 2,3).
        // A2,A3 deleted; A4,A5 (indices 3,4) slide up to indices 1,2 = A2:A3.
        assert_eq!(
            delete_rows("=SUM(A2:A5)", 1, 2),
            Some("=SUM(A2:A3)".to_string())
        );
    }

    #[test]
    fn delete_rows_collapses_range_to_ref() {
        // =SUM(A2:A4). Delete rows [1,3] (covers all of A2:A4). → #REF!.
        assert_eq!(
            delete_rows("=SUM(A2:A4)", 1, 3),
            Some("=SUM(#REF!)".to_string())
        );
    }

    #[test]
    fn insert_rows_grows_range_when_inside() {
        // =SUM(A2:A5). Insert 1 row at index 3 (between). End shifts; start
        // (index 1) is before the point → unchanged. A2:A5 → A2:A6.
        assert_eq!(
            insert_rows("=SUM(A2:A5)", 3, 1),
            Some("=SUM(A2:A6)".to_string())
        );
    }

    // --- Trap: whole-column / whole-row ranges ----------------------------

    #[test]
    fn insert_col_shifts_whole_column_range() {
        // =SUM(B:C). Insert column at index 0 → C:D... actually B:C → C:D.
        assert_eq!(
            insert_cols("=SUM(B:C)", 0, 1),
            Some("=SUM(C:D)".to_string())
        );
    }

    #[test]
    fn row_insert_leaves_whole_column_unchanged() {
        // A whole-column range spans all rows already; a row insert is a no-op.
        assert_eq!(insert_rows("=SUM(A:A)", 0, 5), None);
    }

    #[test]
    fn col_insert_leaves_whole_row_unchanged() {
        assert_eq!(insert_cols("=SUM(1:1)", 0, 5), None);
    }

    // --- Trap: cross-sheet ref scoping ------------------------------------

    #[test]
    fn ref_on_other_sheet_not_shifted_when_current() {
        // Formula lives on a sheet that is NOT the edited one. A bare ref
        // (Current) must NOT shift.
        let scope = ShiftScope {
            edited_canonical: "S0",
            edited_id: 0,
            owner_is_edited: false,
        };
        let out = shift_formula_text(
            "=A5",
            ShiftAxis::Row,
            ShiftOp::Insert { at: 0, count: 1 },
            scope,
        );
        assert_eq!(out, None);
    }

    #[test]
    fn sheet_qualified_ref_into_edited_sheet_shifts() {
        // A formula on ANOTHER sheet references S0!A5 (into the edited sheet).
        // That ref MUST shift even though owner_is_edited is false.
        let scope = ShiftScope {
            edited_canonical: "S0",
            edited_id: 0,
            owner_is_edited: false,
        };
        let out = shift_formula_text(
            "=S0!A5",
            ShiftAxis::Row,
            ShiftOp::Insert { at: 0, count: 1 },
            scope,
        );
        assert_eq!(out, Some("=S0!A6".to_string()));
    }

    #[test]
    fn sheet_qualified_ref_to_different_sheet_unchanged() {
        // S9!A5 references a DIFFERENT sheet; editing S0 must not touch it.
        assert_eq!(insert_rows("=S9!A5", 0, 1), None);
    }

    // --- Trap: malformed text returns None --------------------------------

    #[test]
    fn shift_malformed_text_returns_none() {
        assert_eq!(insert_rows("[", 0, 1), None);
    }

    // --- Trap: deleting a column makes a single ref #REF! -----------------

    #[test]
    fn delete_col_makes_pointed_ref_a_ref_error() {
        // =B5 (col index 1). Delete columns [1,1]. → #REF!.
        assert_eq!(delete_cols("=B5", 1, 1), Some("=#REF!".to_string()));
    }
}
