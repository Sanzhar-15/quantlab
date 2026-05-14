//! `ql-formula-syntax` — Excel-canonical formula lex + parse + print pipeline.
//!
//! Module map (Phase 0 → Phase 2A):
//!
//! - [`token`] (Phase 0 W2-5) — `Token`, `Operator` enums; the lexer's output
//!   vocabulary.
//! - [`ast`] (Phase 0 W2-6; extended Phase 2A.1) — `Expr` tree with variants
//!   for Number, String, Bool, CellRef, RangeRef, Binary, Unary, Function,
//!   Array, Spill, and (Phase 2A.1) `NameRef(Arc<str>)` for defined-name
//!   references.
//! - [`lexer`] (Phase 0 W2-5; extended Phase 2A.5) — `lex()`: source → tokens.
//!   Covers numbers, strings, identifiers (including Phase 2A.5 dotted names
//!   like `VAR.S`, `STDEV.P`), A1 cell refs, ranges via Colon, whole-column /
//!   whole-row sentinels, operators, punctuation. ASCII-whitespace strict.
//!   Phase 3+ deferred: R1C1, sheet-qualified refs, structured table refs,
//!   cross-workbook, array literals.
//! - [`parser`] (Phase 1 W5-1) — `parse()`: tokens → `Expr`. Pratt-style with
//!   Excel-canonical precedence (unary > ^ > * / > + - > & > comparison).
//!   Function-call disambiguation across Ident / CellRef / BareColumn (e.g.
//!   `LOG10(2)` lexes as CellRef but parses as a function call when `(`
//!   follows). TRUE / FALSE recognized as booleans.
//! - [`printer`] (Phase 1 W5-2) — `print()`: `Expr` → source. Round-trip
//!   property `parse(print(parse(s))) == parse(s)` locked by tests.
//!
//! The `AI()` reservation per CORR-06 / T4-D05 is canonicalized at parser
//! level and dispatches through `ql_functions::default_registry` to a
//! sentinel that returns `Error(AINotAvailable)`.

pub mod ast;
pub mod lexer;
pub mod parser;
pub mod printer;
pub mod token;

pub use ast::{rewrite_sheet_name_in_expr, CellAddr, Expr, RangeRef, SheetRef};
pub use lexer::{column_letters_to_index, lex, LexError, MAX_COLUMN, MAX_ROW};
pub use parser::{parse, ParseError};
pub use printer::print;
pub use token::{Operator, Token};

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Smoke test: every public surface compiles + composes.
    #[test]
    fn reexports_compile() {
        let _: Token = Token::Number(1.0);
        let _: Operator = Operator::Plus;
        let _: Result<Vec<Token>, LexError> = lex("=A1");
        let _: Expr = Expr::Number(1.5);
        let _: CellAddr = CellAddr {
            sheet: SheetRef::Current,
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        };
        let _: RangeRef = RangeRef::Cells {
            sheet: SheetRef::Current,
            start_col: 0,
            start_row: 0,
            end_col: 0,
            end_row: 0,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        };
        let _: Arc<str> = Arc::from("ident");
    }

    /// Integration: Phase 0 OG-02 formula body `A * 2` lexes to the expected token stream
    /// that a future parser will fold into `Expr::Binary(Mul, BareColumn(A), Number(2))`.
    #[test]
    fn og02_formula_body_lexes_to_expected_stream() {
        let toks = lex("A * 2").unwrap();
        assert_eq!(toks.len(), 3);
        assert!(matches!(
            toks[0],
            Token::BareColumn {
                col: 0,
                abs: false,
                ..
            }
        ));
        assert_eq!(toks[1], Token::Op(Operator::Mul));
        assert_eq!(toks[2], Token::Number(2.0));
    }
}
