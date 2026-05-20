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

use crate::{lex, parse, print, rewrite_column_ref, rewrite_sheet_name_in_expr, rewrite_table_ref};
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
}
