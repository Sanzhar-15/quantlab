//! AST printer — produces an A1-canonical string from an `Expr`.
//!
//! Phase B per CORR-20 deliverable: round-trip property `parse(print(parse(src))) ==
//! parse(src)`. The printed form is NOT byte-identical to the source — operator
//! spacing, parenthesization, and function-name casing normalize. The semantic
//! equivalence is what matters (and what the round-trip property captures).
//!
//! ## Parenthesization
//!
//! The printer parenthesizes `Binary` and `Unary` subexpressions whenever the parent's
//! operator binding power would cause re-parsing to misorder the result. The rule:
//!
//! - For a child binary expression with op `c_op`, parenthesize if `bp(c_op).lbp <
//!   parent_min_bp`.
//! - For a power right-operand: parenthesize if `bp(c_op).rbp <= parent_rbp` (since `^`
//!   is right-associative).
//!
//! This produces canonical output: `=1 + 2 * 3` (no parens), `=(1 + 2) * 3` (parens
//! around the addition).
//!
//! ## Round-trip semantics
//!
//! `Number::Number(0.5)` doesn't round-trip to the source `50%` — the lexer normalized
//! percent at lex time. Other normalizations:
//! - Function names → uppercase (`sum(...)` → `SUM(...)`).
//! - Range corners → sorted (`A2:A1` → `A1:A2`).
//! - Whitespace → eliminated except inside string literals.
//!
//! These are intentional canonical-form rewrites, not bugs. The round-trip property
//! checks that `parse(printed) == parse(original)`, NOT that the strings match.

use crate::ast::{CellAddr, Expr, RangeRef, SheetRef};
use crate::token::Operator;

/// Print an `Expr` to its A1-canonical string form.
pub fn print(expr: &Expr) -> String {
    let mut out = String::new();
    print_expr(expr, &mut out, 0);
    out
}

/// Convert a 0-indexed column number to Excel letters (A, B, ..., Z, AA, AB, ...).
fn column_index_to_letters(mut col: u32) -> String {
    let mut letters = String::new();
    // Excel column letters are base-26 with A=1 (not base-26 with A=0). The conversion:
    // 0 → A, 25 → Z, 26 → AA, 27 → AB, ..., 701 → ZZ, 702 → AAA.
    loop {
        let digit = (col % 26) as u8;
        letters.insert(0, (b'A' + digit) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    letters
}

fn print_cell_addr(addr: &CellAddr, out: &mut String) {
    print_sheet_prefix(&addr.sheet, out);
    if addr.abs_col {
        out.push('$');
    }
    out.push_str(&column_index_to_letters(addr.col));
    if addr.abs_row {
        out.push('$');
    }
    // Row source-form is 1-based.
    out.push_str(&(addr.row + 1).to_string());
}

/// **W5-89 (Phase 4.6.A part 3):** emit `Sheet!` or `'Sheet name'!`
/// prefix for non-`Current` sheet refs.
///
/// **Contract:** `print` is pre-bind-only. The expected inputs are:
/// - `SheetRef::Current` — no prefix.
/// - `SheetRef::Name(_)` — the parser's output for a sheet-qualified
///   ref; emits `Sheet!` or `'Sheet name'!`.
///
/// `SheetRef::Id(_)` would require resolving the id back to a name,
/// which means threading workbook context through the printer. That
/// resolver-aware variant is a Phase 4.6.E follow-up polish item
/// tracked in `docs/known-gaps.md` (GAP-X-01). Until then, calling
/// `print` on a post-bind AST is a programmer error and panics with
/// the specific id so the call site is obvious.
///
/// **W5-93 (Phase 4.6.E closure):** Codex MEDIUM and Sonnet MEDIUM
/// converged on this finding. Closure stance: keep the panic (no-
/// fallbacks rule), improve the message, document the contract.
/// The current `rewrite_sheet_name_in_expr` path walks pre-bind
/// ASTs only, so the panic isn't reachable through any production
/// code path today.
fn print_sheet_prefix(sheet: &SheetRef, out: &mut String) {
    match sheet {
        SheetRef::Current => {}
        SheetRef::Name(name) => {
            print_sheet_name(name, out);
            out.push('!');
        }
        SheetRef::Id(id) => panic!(
            "ql_formula_syntax::print: SheetRef::Id({id}) reached the printer, \
             but print() is pre-bind-only by contract (see fn doc comment). \
             The bound id has no associated name string at the AST level; a \
             resolver-aware print_with_resolver(expr, &workbook) API is \
             tracked as Phase 4.6.E follow-up. If you're trying to round-trip \
             a bound expression, re-parse from text instead — the binder \
             does NOT round-trip back through the printer."
        ),
    }
}

/// **W5-89 (Phase 4.6.A part 3):** emit a sheet name in its canonical
/// source form. Quotes the name if it contains any character outside
/// `[A-Za-z0-9_.]`, starts with a digit (would lex as a number/row),
/// or is empty (defensive — empty names are rejected at registry time
/// anyway). Embedded `'` is escaped as `''`.
fn print_sheet_name(name: &str, out: &mut String) {
    let needs_quoting = name.is_empty()
        || name.starts_with(|c: char| c.is_ascii_digit())
        || name
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'));
    if needs_quoting {
        out.push('\'');
        for c in name.chars() {
            if c == '\'' {
                out.push('\'');
                out.push('\'');
            } else {
                out.push(c);
            }
        }
        out.push('\'');
    } else {
        out.push_str(name);
    }
}

fn print_range(r: &RangeRef, out: &mut String) {
    match r {
        RangeRef::Cells {
            sheet,
            start_col,
            start_row,
            end_col,
            end_row,
            abs_start_col,
            abs_start_row,
            abs_end_col,
            abs_end_row,
        } => {
            // **W5-89 (Phase 4.6.A part 3):** sheet prefix applies to the
            // WHOLE range, emitted once at the start (Excel canon). The
            // trailing endpoint omits the prefix; both endpoints get
            // `SheetRef::Current` in the synthesized `CellAddr` so
            // `print_cell_addr` emits no prefix internally.
            print_sheet_prefix(sheet, out);
            print_cell_addr(
                &CellAddr {
                    sheet: SheetRef::Current,
                    col: *start_col,
                    row: *start_row,
                    abs_col: *abs_start_col,
                    abs_row: *abs_start_row,
                },
                out,
            );
            out.push(':');
            print_cell_addr(
                &CellAddr {
                    sheet: SheetRef::Current,
                    col: *end_col,
                    row: *end_row,
                    abs_col: *abs_end_col,
                    abs_row: *abs_end_row,
                },
                out,
            );
        }
        RangeRef::WholeColumn {
            sheet,
            start_col,
            end_col,
            abs_start,
            abs_end,
        } => {
            print_sheet_prefix(sheet, out);
            if *abs_start {
                out.push('$');
            }
            out.push_str(&column_index_to_letters(*start_col));
            out.push(':');
            if *abs_end {
                out.push('$');
            }
            out.push_str(&column_index_to_letters(*end_col));
        }
        RangeRef::WholeRow {
            sheet,
            start_row,
            end_row,
            abs_start,
            abs_end,
        } => {
            print_sheet_prefix(sheet, out);
            if *abs_start {
                out.push('$');
            }
            out.push_str(&(*start_row + 1).to_string());
            out.push(':');
            if *abs_end {
                out.push('$');
            }
            out.push_str(&(*end_row + 1).to_string());
        }
    }
}

fn print_string_literal(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        if ch == '"' {
            out.push('"');
            out.push('"');
        } else {
            out.push(ch);
        }
    }
    out.push('"');
}

fn print_number(n: f64, out: &mut String) {
    // Use Rust's default f64 Display which matches Excel's general number formatting
    // closely (e.g., 2.0 prints as "2", 2.5 as "2.5", 1e10 as "10000000000").
    if n.fract() == 0.0 && n.abs() < 1.0e16 {
        // Integer-valued f64 → no decimal point.
        out.push_str(&format!("{}", n as i64));
    } else {
        out.push_str(&format!("{n}"));
    }
}

/// Print an Expr with parenthesization decisions driven by `parent_min_bp` — the
/// effective right-binding-power of the parent context. Higher = more aggressive
/// parenthesization.
fn print_expr(expr: &Expr, out: &mut String, parent_min_bp: u8) {
    match expr {
        Expr::Number(n) => print_number(*n, out),
        Expr::Bool(b) => out.push_str(if *b { "TRUE" } else { "FALSE" }),
        Expr::String(s) => print_string_literal(s, out),
        Expr::CellRef(addr) => print_cell_addr(addr, out),
        Expr::RangeRef(r) => print_range(r, out),
        Expr::Binary { op, lhs, rhs } => {
            let (lbp, rbp) = binary_bp(*op);
            let needs_parens = lbp < parent_min_bp;
            if needs_parens {
                out.push('(');
            }
            // Audit H1 fix (2026-05-12): for right-associative ops (Pow has lbp > rbp
            // in Pratt convention), the LHS of the same op MUST be parenthesized so
            // `(a^b)^c` round-trips correctly. Previously the LHS got `lbp` which
            // matched the child's lbp and produced no parens, silently re-parsing
            // as `a^(b^c)`. For left-associative ops, lbp = rbp - 1, so passing lbp
            // continues to allow `(a+b)+c` chains to print as `a + b + c` (correct
            // left-assoc).
            let is_right_assoc = lbp > rbp;
            let lhs_min_bp = if is_right_assoc { lbp + 1 } else { lbp };
            print_expr(lhs, out, lhs_min_bp);
            out.push(' ');
            out.push_str(op.as_str());
            out.push(' ');
            print_expr(rhs, out, rbp + 1); // +1 so right operand of same op gets parens
            if needs_parens {
                out.push(')');
            }
        }
        Expr::Unary { op, operand } => {
            match op {
                Operator::Percent => {
                    // Postfix: operand% — parenthesize if operand is a Binary/Unary
                    // that has lower precedence than percent (bp 60).
                    print_expr(operand, out, 61);
                    out.push('%');
                }
                Operator::Minus | Operator::Plus => {
                    // Prefix: -operand / +operand
                    out.push_str(op.as_str());
                    print_expr(operand, out, 70);
                }
                other => {
                    // Other operators aren't valid as unary; print as prefix anyway.
                    out.push_str(other.as_str());
                    print_expr(operand, out, 70);
                }
            }
        }
        Expr::Function { name, args } => {
            out.push_str(name);
            out.push('(');
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                print_expr(a, out, 0);
            }
            out.push(')');
        }
        Expr::NameRef(name) => {
            // Phase 2A.1: defined-name reference round-trips as the bare name.
            out.push_str(name);
        }
        Expr::Error(ev) => {
            // **W5-98 (Phase 4.7.D):** error literal round-trips as its
            // canonical sigil — `#REF!`, `#N/A`, `#DIV/0!`, etc. The
            // lexer's `lex_error_sigil` accepts any case; the printer
            // emits the canonical (Excel-canon) form.
            out.push_str(ev.sigil());
        }
        Expr::Array(rows) => {
            // **W5-98 (Phase 4.7.D / 4.7.E):** array literal round-trips
            // as `{cell, cell; cell, cell}`. Cells separated by `, ` and
            // rows by `; ` (mirrors Excel canon + the parser grammar).
            // Empty arrays are rejected at parse time (`EmptyArrayLiteral`),
            // so `rows` is always non-empty here; defensive `unreachable!`
            // for the degenerate case.
            if rows.is_empty() {
                unreachable!(
                    "print_expr: Expr::Array with zero rows — parser rejects empty \
                     literals via ParseError::EmptyArrayLiteral; constructing one \
                     directly is a programmer bug"
                );
            }
            out.push('{');
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    out.push_str("; ");
                }
                for (j, cell) in row.iter().enumerate() {
                    if j > 0 {
                        out.push_str(", ");
                    }
                    print_expr(cell, out, 0);
                }
            }
            out.push('}');
        }
        Expr::Spill(_) => {
            // `Expr::Spill(Box<Expr>)` is reserved for Excel's `A1#`
            // spill-range-ref syntax (Phase 4.9). NOT used for runtime
            // spill anchors — those live in `Workbook::spill_anchors`,
            // not in the AST. Phase 4.7 does not construct this; loud
            // panic per the no-fallbacks rule.
            unreachable!(
                "print_expr: Expr::Spill is reserved for Phase 4.9 (Excel `A1#` syntax) \
                 and not constructed in Phase 4.7 — reaching here means the AST was malformed"
            );
        }
        Expr::StructuredRef { table_name, spec } => {
            // **W5-113 (Phase 4.8.D):** structured-ref round-trip with
            // OOXML-escape-aware emission. Column names containing `[`,
            // `]`, `#`, `@`, `'` are escaped with `'` prefix per design
            // § 5.4 so the lexer's unescape pass recovers the original
            // name on re-lex. Table names cannot contain any of these
            // characters (Excel canon: table names are restricted to
            // alphanumeric + `_` + `.`), so they're emitted verbatim.
            out.push_str(table_name);
            out.push('[');
            print_sref_spec(spec, out);
            out.push(']');
        }
    }
}

/// **W5-113 (Phase 4.8.D):** apply OOXML structured-reference escapes
/// to a column-name string when emitting it inside `[...]` bracket
/// content. Each of `[`, `]`, `#`, `@`, `'` is preceded by `'`. The
/// lexer's `consume_structured_ref_bracket` reverses this on re-lex.
fn escape_for_sref(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '[' | ']' | '#' | '@' | '\'') {
            out.push('\'');
        }
        out.push(c);
    }
    out
}

/// **W5-112 (Phase 4.8.C / 4.8.D):** print the bracket content of a
/// structured reference. Column names are emitted via
/// [`escape_for_sref`] so the round-trip lex(print(parse(x))) = x for
/// any well-formed column name.
fn print_sref_spec(spec: &crate::ast::TableSpecSubtree, out: &mut String) {
    use crate::ast::{SpecialItem, TableSpecItem, TableSpecSubtree};
    match spec {
        TableSpecSubtree::BareColumn(name) => {
            // BareColumn: name is the entire bracket content. Escape
            // any special chars (lexer unescapes).
            out.push_str(&escape_for_sref(name));
        }
        TableSpecSubtree::ThisRowColumn(name) => {
            // Canonical printed form: `@[Col]` (bracketed) so a name
            // starting with `[` or `#` doesn't collide with the
            // unbracketed `@Col` shorthand. Always emit brackets for
            // round-trip stability.
            out.push('@');
            out.push('[');
            out.push_str(&escape_for_sref(name));
            out.push(']');
        }
        TableSpecSubtree::ThisRowColumnRange(c1, c2) => {
            out.push('@');
            out.push('[');
            out.push_str(&escape_for_sref(c1));
            out.push(']');
            out.push(':');
            out.push('[');
            out.push_str(&escape_for_sref(c2));
            out.push(']');
        }
        TableSpecSubtree::Combination(items) => {
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                match item {
                    TableSpecItem::Special(s) => {
                        out.push('[');
                        out.push_str(match s {
                            SpecialItem::Headers => "#Headers",
                            SpecialItem::Totals => "#Totals",
                            SpecialItem::Data => "#Data",
                            SpecialItem::All => "#All",
                            SpecialItem::ThisRow => "#This Row",
                        });
                        out.push(']');
                    }
                    TableSpecItem::Column(c) => {
                        out.push('[');
                        out.push_str(&escape_for_sref(c));
                        out.push(']');
                    }
                    TableSpecItem::ColumnRange(c1, c2) => {
                        out.push('[');
                        out.push_str(&escape_for_sref(c1));
                        out.push(']');
                        out.push(':');
                        out.push('[');
                        out.push_str(&escape_for_sref(c2));
                        out.push(']');
                    }
                }
            }
        }
    }
}

/// Binding-power table for binary operators — must match `parser::infix_bp`.
fn binary_bp(op: Operator) -> (u8, u8) {
    match op {
        Operator::Eq
        | Operator::Neq
        | Operator::Lt
        | Operator::Le
        | Operator::Gt
        | Operator::Ge => (10, 11),
        Operator::Concat => (20, 21),
        Operator::Plus | Operator::Minus => (30, 31),
        Operator::Mul | Operator::Div => (40, 41),
        Operator::Pow => (51, 50),
        // Audit L4 fix (2026-05-12): Percent is postfix-only; `binary_bp(Percent)`
        // never occurs in correct code. Loud panic per the no-fallbacks rule.
        Operator::Percent => {
            unreachable!("binary_bp called with Operator::Percent (postfix-only); programmer bug")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;
    use crate::parser::parse;
    use std::sync::Arc;

    fn rt(src: &str) -> String {
        let expr = parse(lex(src).expect("lex")).expect("parse");
        print(&expr)
    }

    fn rt_roundtrip(src: &str) {
        // Round-trip property: parse(print(parse(src))) == parse(src).
        let first = parse(lex(src).expect("lex")).expect("parse");
        let printed = print(&first);
        let second = parse(lex(&printed).expect("lex of printed")).expect("re-parse");
        assert_eq!(
            first, second,
            "round-trip failed for: {src}\nprinted: {printed}"
        );
    }

    // ===== column letter conversion =====

    #[test]
    fn col_letters_basic() {
        assert_eq!(column_index_to_letters(0), "A");
        assert_eq!(column_index_to_letters(1), "B");
        assert_eq!(column_index_to_letters(25), "Z");
        assert_eq!(column_index_to_letters(26), "AA");
        assert_eq!(column_index_to_letters(27), "AB");
        assert_eq!(column_index_to_letters(51), "AZ");
        assert_eq!(column_index_to_letters(52), "BA");
        assert_eq!(column_index_to_letters(701), "ZZ");
        assert_eq!(column_index_to_letters(702), "AAA");
    }

    #[test]
    fn col_letters_max_excel() {
        // Excel max column = 16383 = XFD.
        assert_eq!(column_index_to_letters(16_383), "XFD");
    }

    // ===== literals =====

    #[test]
    fn print_integer_number() {
        assert_eq!(rt("42"), "42");
    }

    #[test]
    fn print_decimal_number() {
        assert_eq!(rt("3.5"), "3.5");
    }

    #[test]
    fn print_negative_number_via_unary() {
        // The parser produces Unary { Minus, Number(5) } (no negative literals).
        assert_eq!(rt("-5"), "-5");
    }

    #[test]
    fn print_bool() {
        assert_eq!(rt("TRUE"), "TRUE");
        assert_eq!(rt("false"), "FALSE"); // canonicalized to uppercase
    }

    #[test]
    fn print_string_basic() {
        assert_eq!(rt("\"hello\""), "\"hello\"");
    }

    #[test]
    fn print_string_with_embedded_quote() {
        // Source `"a""b"` lexes to String("a\"b"); printer must escape on print.
        let expr = parse(lex("\"a\"\"b\"").unwrap()).unwrap();
        assert_eq!(print(&expr), "\"a\"\"b\"");
    }

    // ===== cell refs =====

    #[test]
    fn print_cell_ref_a1() {
        assert_eq!(rt("A1"), "A1");
    }

    #[test]
    fn print_cell_ref_absolute() {
        assert_eq!(rt("$B$5"), "$B$5");
        assert_eq!(rt("$A1"), "$A1");
        assert_eq!(rt("A$1"), "A$1");
    }

    #[test]
    fn print_cell_ref_two_letter_col() {
        assert_eq!(rt("AA1"), "AA1");
        assert_eq!(rt("$XFD$1048576"), "$XFD$1048576");
    }

    // ===== ranges =====

    #[test]
    fn print_range_cells() {
        assert_eq!(rt("A1:B10"), "A1:B10");
    }

    #[test]
    fn print_range_whole_column() {
        assert_eq!(rt("A:A"), "A:A");
        assert_eq!(rt("A:C"), "A:C");
    }

    #[test]
    fn print_range_whole_row() {
        // Parser normalizes `1:1` via number_to_bare_row to WholeRow{start_row=0,end_row=0}.
        // Printer prints back as `1:1`.
        assert_eq!(rt("1:1"), "1:1");
        assert_eq!(rt("$1:$1"), "$1:$1");
    }

    // ===== arithmetic + precedence parenthesization =====

    #[test]
    fn print_binary_simple_add() {
        assert_eq!(rt("1 + 2"), "1 + 2");
    }

    #[test]
    fn print_mul_over_add_no_parens() {
        // 1 + 2 * 3 — the multiplication is RHS so it doesn't need parens.
        assert_eq!(rt("1 + 2 * 3"), "1 + 2 * 3");
    }

    #[test]
    fn print_explicit_parens_preserved_when_needed() {
        // (1 + 2) * 3 — the addition is LHS of multiplication; needs parens.
        assert_eq!(rt("(1 + 2) * 3"), "(1 + 2) * 3");
    }

    #[test]
    fn print_subtraction_left_assoc() {
        // 10 - 3 - 2 → (10 - 3) - 2 in AST; printer prints "10 - 3 - 2" (left assoc).
        assert_eq!(rt("10 - 3 - 2"), "10 - 3 - 2");
    }

    #[test]
    fn print_subtraction_with_negated_rhs() {
        // 10 - (5 - 2): the RHS is parenthesized because parser's right operand of `-`
        // gets min_bp = 31 (lbp+1), and 5-2 has bp 30 < 31 → parens.
        assert_eq!(rt("10 - (5 - 2)"), "10 - (5 - 2)");
    }

    #[test]
    fn print_power_right_assoc() {
        // 2 ^ 3 ^ 2 → 2 ^ (3 ^ 2) in AST. Printer: power is right-assoc with rbp 50;
        // the right operand of `^` needs parens only when its lbp < 51. 3^2 has lbp 51
        // which is NOT < 51, so NO parens (preserves right-assoc).
        assert_eq!(rt("2 ^ 3 ^ 2"), "2 ^ 3 ^ 2");
    }

    #[test]
    fn print_concat_with_arithmetic() {
        // A1 & 1 + 2 → A1 & (1 + 2) in AST. Printer: concat (bp 20/21) parent passes
        // min_bp = 21 to rhs; plus has lbp 30 ≥ 21 → no parens needed.
        assert_eq!(rt("A1 & 1 + 2"), "A1 & 1 + 2");
    }

    #[test]
    fn print_comparison() {
        assert_eq!(rt("A1 = B1"), "A1 = B1");
        assert_eq!(rt("A1 < B1"), "A1 < B1");
        assert_eq!(rt("A1 <= B1"), "A1 <= B1");
        assert_eq!(rt("A1 >= B1"), "A1 >= B1");
        assert_eq!(rt("A1 <> B1"), "A1 <> B1");
    }

    // ===== unary =====

    #[test]
    fn print_unary_minus() {
        assert_eq!(rt("-A1"), "-A1");
    }

    #[test]
    fn print_unary_minus_then_mul() {
        // -2 * 3 = (-2) * 3 in AST. Printer: mul lbp=40, unary parent min_bp=40, mul
        // operand has lbp 40 → no parens.
        assert_eq!(rt("-2 * 3"), "-2 * 3");
    }

    #[test]
    fn print_postfix_percent_on_grouped() {
        // (1 + 2)% — the parser produces Unary { Percent, Binary { Plus, 1, 2 } }.
        // Printer: percent's min_bp=61 passed to inner; plus has lbp 30 < 61 → parens.
        assert_eq!(rt("(1 + 2)%"), "(1 + 2)%");
    }

    // ===== function calls =====

    #[test]
    fn print_function_no_args() {
        assert_eq!(rt("NOW()"), "NOW()");
    }

    #[test]
    fn print_function_with_args() {
        assert_eq!(rt("SUM(1, 2, 3)"), "SUM(1, 2, 3)");
    }

    #[test]
    fn print_nested_function() {
        assert_eq!(rt("IF(A1 > 0, 1, 2)"), "IF(A1 > 0, 1, 2)");
    }

    #[test]
    fn print_function_name_canonicalized() {
        assert_eq!(rt("sum(1, 2)"), "SUM(1, 2)");
        assert_eq!(rt("Sum(1, 2)"), "SUM(1, 2)");
    }

    #[test]
    fn print_ai_function() {
        assert_eq!(rt("AI(\"hello\")"), "AI(\"hello\")");
        assert_eq!(rt("ai(\"x\")"), "AI(\"x\")");
    }

    #[test]
    fn print_function_with_range_arg() {
        assert_eq!(rt("SUM(A:A)"), "SUM(A:A)");
        assert_eq!(rt("SUM(A1:B10)"), "SUM(A1:B10)");
    }

    // ===== round-trip property tests =====
    //
    // These are stronger than the equality-of-printed-form tests above — they verify
    // `parse(print(parse(src))) == parse(src)` for a variety of inputs.

    #[test]
    fn roundtrip_literals() {
        rt_roundtrip("42");
        rt_roundtrip("3.5");
        rt_roundtrip("\"hello\"");
        rt_roundtrip("TRUE");
        rt_roundtrip("FALSE");
    }

    #[test]
    fn roundtrip_cellrefs() {
        rt_roundtrip("A1");
        rt_roundtrip("$B$5");
        rt_roundtrip("XFD1048576");
    }

    #[test]
    fn roundtrip_arithmetic() {
        rt_roundtrip("1 + 2");
        rt_roundtrip("1 + 2 * 3");
        rt_roundtrip("(1 + 2) * 3");
        rt_roundtrip("10 - 3 - 2");
        rt_roundtrip("2 ^ 3 ^ 2");
        rt_roundtrip("A1 + B1 * 2 - 5");
    }

    /// Audit H1 regression test (2026-05-12). `(a^b)^c` is left-grouped (Pow's LHS is
    /// itself a Pow). Previously the printer emitted `a ^ b ^ c` because both child
    /// and parent had lbp=51 and the `lbp < parent_min_bp` check was false. The
    /// resulting string re-parses as right-grouped `a^(b^c)`, breaking the AST. Fix:
    /// pass `lbp + 1` to the LHS for right-associative ops so the LHS-as-same-op gets
    /// parens.
    #[test]
    fn roundtrip_left_grouped_power() {
        // Direct round-trip: parse `(2^3)^4` should equal parse(print(parse(input))).
        rt_roundtrip("(2 ^ 3) ^ 4");
        // Adversarial deep left-grouping.
        rt_roundtrip("((2 ^ 3) ^ 4) ^ 5");
        // Confirm the surface form makes parens explicit. The parser of `2 ^ 3 ^ 4`
        // produces Pow(2, Pow(3, 4)) (right-assoc); printing must NOT add parens.
        // The parser of `(2 ^ 3) ^ 4` produces Pow(Pow(2, 3), 4); printing MUST add
        // parens around the LHS to preserve the AST.
        let right_grouped = parse(lex("2 ^ 3 ^ 4").unwrap()).unwrap();
        assert_eq!(print(&right_grouped), "2 ^ 3 ^ 4");
        let left_grouped = parse(lex("(2 ^ 3) ^ 4").unwrap()).unwrap();
        assert_eq!(print(&left_grouped), "(2 ^ 3) ^ 4");
    }

    #[test]
    fn roundtrip_comparison_concat() {
        rt_roundtrip("A1 = B1");
        rt_roundtrip("A1 & \"x\"");
        rt_roundtrip("A1 & 1 + 2");
    }

    #[test]
    fn roundtrip_unary() {
        rt_roundtrip("-5");
        rt_roundtrip("-A1");
        rt_roundtrip("-2 * 3");
        rt_roundtrip("(1 + 2)%");
    }

    #[test]
    fn roundtrip_functions() {
        rt_roundtrip("SUM(1, 2, 3)");
        rt_roundtrip("IF(A1 > 0, 1, 2)");
        rt_roundtrip("SUM(A1, B1)");
        rt_roundtrip("AI(\"prompt\")");
        rt_roundtrip("LOG10(100)");
    }

    #[test]
    fn roundtrip_ranges() {
        rt_roundtrip("A1:B10");
        rt_roundtrip("A:A");
        rt_roundtrip("1:1");
        rt_roundtrip("SUM(A:A)");
        rt_roundtrip("$1:$1");
    }

    #[test]
    fn roundtrip_complex_formula() {
        rt_roundtrip("IF(SUM(A1:A10) > 100, \"big\", AVERAGE(B1:B10) * 2)");
        rt_roundtrip("(A1 + B1) * (C1 - D1) / 2");
        rt_roundtrip("SUM(A1, IF(B1 > 0, C1, -C1))");
    }

    #[test]
    fn roundtrip_og02_pattern() {
        rt_roundtrip("A * 2");
        rt_roundtrip("A1 * 2");
        rt_roundtrip("(A1 + B1) * 2");
    }

    // ===== W5-1 corpus expansion (additional parser-corpus tests) =====

    #[test]
    fn roundtrip_chained_function_calls() {
        rt_roundtrip("ROUND(SUM(A1, B1), 2)");
    }

    #[test]
    fn roundtrip_deeply_nested() {
        rt_roundtrip("((((1 + 2) * 3) - 4) / 5)");
    }

    #[test]
    fn roundtrip_mixed_abs_markers() {
        rt_roundtrip("$A1:B$10");
        rt_roundtrip("$A$1 + B2");
    }

    #[test]
    fn roundtrip_string_with_special_chars() {
        // Embedded space, comma, equals — all preserved verbatim inside the string.
        rt_roundtrip("\"hello, world = 42\"");
    }

    #[test]
    fn roundtrip_iferror_pattern() {
        rt_roundtrip("IFERROR(A1 / B1, 0)");
    }

    #[test]
    fn roundtrip_with_many_args() {
        rt_roundtrip("SUM(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)");
    }

    /// Phase 2A.5 (2026-05-12): the lexer now accepts dotted identifiers, so
    /// `VAR.S(...)` round-trips through lex → parse → print. Replaces the prior
    /// "VAR alias workaround" path.
    #[test]
    fn roundtrip_dotted_function_name() {
        rt_roundtrip("VAR.S(1, 2, 3)");
        rt_roundtrip("STDEV.P(1, 2, 3, 4)");
    }

    /// Multi-dot identifiers (lexer-accepted, binder-rejected for unknown
    /// names) still round-trip through the printer cleanly. Pin per audit L9
    /// (2026-05-12) so a future printer change can't break dotted-name output.
    #[test]
    fn print_multi_dot_name_ref() {
        let e = parse(lex("A.B.C").expect("lex")).expect("parse");
        let printed = print(&e);
        assert_eq!(printed, "A.B.C");
    }

    // ===== W5-89 / Phase 4.6.A part 3 — sheet-prefix printing =====

    /// Helper: parse → print → assert round-trip text matches expected.
    fn round_trip(src: &str, expected: &str) {
        let e = parse(lex(src).expect("lex")).expect("parse");
        assert_eq!(print(&e), expected, "round-trip mismatch for {src:?}");
    }

    #[test]
    fn print_unquoted_sheet_prefix_cellref() {
        round_trip("Sheet1!A1", "Sheet1!A1");
    }

    #[test]
    fn print_dotted_sheet_name_unquoted() {
        round_trip("Data.2024!B5", "Data.2024!B5");
    }

    #[test]
    fn print_quoted_sheet_name_with_space() {
        round_trip("'Q3 2025'!A1", "'Q3 2025'!A1");
    }

    #[test]
    fn print_quoted_sheet_name_with_escape() {
        round_trip("'Ben''s Sheet'!A1", "'Ben''s Sheet'!A1");
    }

    #[test]
    fn print_sheet_prefix_on_range() {
        round_trip("Sheet1!A1:B2", "Sheet1!A1:B2");
    }

    #[test]
    fn print_sheet_prefix_on_whole_column() {
        round_trip("Sheet1!A:A", "Sheet1!A:A");
    }

    #[test]
    fn print_sheet_prefix_on_whole_row() {
        round_trip("Sheet1!1:5", "Sheet1!1:5");
    }

    #[test]
    fn print_redundant_explicit_form_normalizes_to_single_prefix() {
        // `Sheet1!A1:Sheet1!B2` parses + normalizes; print emits single-prefix form.
        let e = parse(lex("Sheet1!A1:Sheet1!B2").expect("lex")).expect("parse");
        assert_eq!(print(&e), "Sheet1!A1:B2");
    }

    #[test]
    fn print_sheet_prefix_in_binary_expression() {
        // Printer adds canonical spaces around binary operators.
        round_trip("Sheet2!A1+1", "Sheet2!A1 + 1");
    }

    #[test]
    fn print_sheet_prefix_in_function_arg() {
        round_trip("SUM(Sheet1!A1:A10)", "SUM(Sheet1!A1:A10)");
    }

    #[test]
    fn print_sheet_prefix_preserves_absolute_markers() {
        round_trip("Sheet1!$A$1", "Sheet1!$A$1");
    }

    #[test]
    fn print_sheet_name_with_special_char_is_quoted() {
        // A sheet name containing `-` would normally need quoting because `-`
        // is not in `[A-Za-z0-9_.]`. Tested via direct AST construction
        // (the parser/lexer wouldn't produce this without quoting at the
        // source).
        let e = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("Sales-Q1")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        assert_eq!(print(&e), "'Sales-Q1'!A1");
    }

    #[test]
    fn print_sheet_name_starting_with_digit_is_quoted() {
        let e = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("2024")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        assert_eq!(print(&e), "'2024'!A1");
    }

    #[test]
    fn same_sheet_ref_omits_prefix() {
        // `SheetRef::Current` MUST NOT emit a prefix.
        round_trip("A1", "A1");
        round_trip("A1:B2", "A1:B2");
    }

    // ===== W5-98 (Phase 4.7.D) — array literals + error literals =====

    #[test]
    fn print_error_literal_round_trips() {
        round_trip("#REF!", "#REF!");
        round_trip("#N/A", "#N/A");
        round_trip("#DIV/0!", "#DIV/0!");
        round_trip("#NAME?", "#NAME?");
        round_trip("#VALUE!", "#VALUE!");
        round_trip("#NUM!", "#NUM!");
        round_trip("#NULL!", "#NULL!");
        round_trip("#SPILL!", "#SPILL!");
        round_trip("#CALC!", "#CALC!");
    }

    #[test]
    fn print_error_literal_canonicalizes_case() {
        // Lexer accepts case-insensitive; printer emits canonical.
        let e = parse(lex("#ref!").expect("lex")).expect("parse");
        assert_eq!(print(&e), "#REF!");
    }

    #[test]
    fn print_array_literal_1x3() {
        round_trip("{1, 2, 3}", "{1, 2, 3}");
    }

    #[test]
    fn print_array_literal_3x1() {
        round_trip("{1; 2; 3}", "{1; 2; 3}");
    }

    #[test]
    fn print_array_literal_2x2() {
        round_trip("{1, 2; 3, 4}", "{1, 2; 3, 4}");
    }

    #[test]
    fn print_array_literal_mixed_cells() {
        round_trip("{1, TRUE, \"hi\", #N/A, -5}", "{1, TRUE, \"hi\", #N/A, -5}");
    }

    #[test]
    fn print_array_literal_as_function_arg() {
        round_trip("SUM({1, 2, 3})", "SUM({1, 2, 3})");
    }

    #[test]
    fn print_array_normalizes_whitespace() {
        // Input has extra whitespace; printer emits canonical spacing.
        let e = parse(lex("{1,2;3,4}").expect("lex")).expect("parse");
        assert_eq!(print(&e), "{1, 2; 3, 4}");
    }

    #[test]
    fn print_array_round_trip_through_parse_print_parse() {
        // The fundamental round-trip property — parse(print(parse(s))) == parse(s).
        let s = "{1, 2; 3, 4}";
        let parsed_once = parse(lex(s).expect("lex")).expect("parse");
        let printed = print(&parsed_once);
        let parsed_twice = parse(lex(&printed).expect("lex")).expect("parse");
        assert_eq!(parsed_once, parsed_twice);
    }

    // ===== W5-113 (Phase 4.8.D) — structured-reference round-trip =====

    #[test]
    fn print_sref_bare_column() {
        round_trip("Sales[Qty]", "Sales[Qty]");
    }

    #[test]
    fn print_sref_bracketed_column_canonicalizes_to_bare() {
        // Parser distinguishes BareColumn (`Sales[Qty]`) from
        // Combination(vec![Column]) (`Sales[[Qty]]`). Printer renders
        // each in its canonical form. NOT semantically normalized at
        // parse time per design § 6.2.
        let e_bare = parse(lex("Sales[Qty]").expect("lex")).expect("parse");
        assert_eq!(print(&e_bare), "Sales[Qty]");
        let e_bracketed = parse(lex("Sales[[Qty]]").expect("lex")).expect("parse");
        assert_eq!(print(&e_bracketed), "Sales[[Qty]]");
    }

    #[test]
    fn print_sref_all_5_specifiers() {
        round_trip("Sales[[#Headers]]", "Sales[[#Headers]]");
        round_trip("Sales[[#Totals]]", "Sales[[#Totals]]");
        round_trip("Sales[[#Data]]", "Sales[[#Data]]");
        round_trip("Sales[[#All]]", "Sales[[#All]]");
        round_trip("Sales[[#This Row]]", "Sales[[#This Row]]");
    }

    #[test]
    fn print_sref_special_column_combination() {
        round_trip("Sales[[#Headers], [Qty]]", "Sales[[#Headers], [Qty]]");
    }

    #[test]
    fn print_sref_column_range() {
        round_trip("Sales[[Col1]:[Col2]]", "Sales[[Col1]:[Col2]]");
    }

    #[test]
    fn print_sref_three_item_combination() {
        round_trip(
            "Sales[[#Data], [#Totals], [Col]]",
            "Sales[[#Data], [#Totals], [Col]]",
        );
    }

    #[test]
    fn print_sref_at_column_shorthand_canonicalizes_to_bracketed() {
        // `[@Col]` lexes / parses as ThisRowColumn; printer emits the
        // bracketed form `[@[Col]]` for round-trip stability (a column
        // starting with `[` or `#` would otherwise collide with the
        // bare-`@Col` shorthand).
        let e = parse(lex("Sales[@Qty]").expect("lex")).expect("parse");
        assert_eq!(print(&e), "Sales[@[Qty]]");
        // The bracketed form round-trips unchanged.
        round_trip("Sales[@[Qty]]", "Sales[@[Qty]]");
    }

    #[test]
    fn print_sref_at_column_range_round_trips() {
        round_trip("Sales[@[Col1]:[Col2]]", "Sales[@[Col1]:[Col2]]");
    }

    // ===== Escape round-trip tests (the heart of 4.8.D) =====

    /// Column name containing `[` is escaped as `'[`. Pin: lex →
    /// parse extracts unescaped `[`; print → emits with `'[` escape;
    /// re-lex → unescape back to `[`.
    #[test]
    fn print_sref_column_name_with_bracket_round_trips() {
        // Source: `Tbl['[a]` — column name is `[a`. Print emits
        // `Tbl['[a]` again (unchanged source canon).
        round_trip("Tbl['[a]", "Tbl['[a]");
    }

    #[test]
    fn print_sref_column_name_with_close_bracket_round_trips() {
        round_trip("Tbl[a']]", "Tbl[a']]");
    }

    #[test]
    fn print_sref_column_name_with_hash_round_trips() {
        // Column literally named `#Foo` (NOT the #Headers specifier).
        // Stored as Column("#Foo"); printer escapes as `'#Foo`.
        let e = parse(lex("Tbl['#Foo]").expect("lex")).expect("parse");
        match &e {
            Expr::StructuredRef { spec, .. } => match spec {
                crate::ast::TableSpecSubtree::BareColumn(name) => {
                    assert_eq!(name.as_ref(), "#Foo");
                }
                other => panic!("expected BareColumn, got {other:?}"),
            },
            other => panic!("expected StructuredRef, got {other:?}"),
        }
        let printed = print(&e);
        assert_eq!(printed, "Tbl['#Foo]");
    }

    #[test]
    fn print_sref_column_name_with_at_sign_round_trips() {
        // Column literally named `@Foo` (NOT the @Col shorthand because
        // it's in bare-column position, not after `[@`).
        round_trip("Tbl['@Foo]", "Tbl['@Foo]");
    }

    #[test]
    fn print_sref_column_name_with_apostrophe_round_trips() {
        // `Bob''s` → column name `Bob's`. Apostrophe escapes itself.
        round_trip("Tbl[Bob''s]", "Tbl[Bob''s]");
    }

    /// The fundamental property: lex → parse → print → re-lex → re-parse
    /// produces an identical AST. Pins that escape emission is lossless.
    #[test]
    fn print_sref_round_trip_through_parse_print_parse() {
        let cases = [
            "Sales[Qty]",
            "Sales[[#Headers], [Qty]]",
            "Sales[[Col1]:[Col2]]",
            "Sales[@[Qty]]",
            "Sales[@[Col1]:[Col2]]",
            "Tbl['[a]",
            "Tbl[a']]",
            "Tbl['#Foo]",
            "Tbl['@Foo]",
            "Tbl[Bob''s]",
            "SUM(Sales[Qty])",
        ];
        for src in cases {
            let once = parse(lex(src).expect("lex")).expect("parse");
            let printed = print(&once);
            let twice = parse(lex(&printed).expect("lex")).expect("parse");
            assert_eq!(once, twice, "round-trip diverged for {src:?}: printed as {printed:?}");
        }
    }
}
