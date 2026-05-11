//! `ql-formula-syntax` — Token, Lexer, AST type definitions.
//!
//! **PHASE 0 PARTIAL** — Week 2 Days 5-6 scope ships in two parts:
//! 1. (THIS COMMIT) Token, Lexer, AST types. Bounded; ~45 tokenizer tests + AST shape tests.
//! 2. (FUTURE) Pratt parser, AST printer, 100 parser tests. Deferred to a fresh session
//!    after the reference reading sprint (`docs/phase0/references-reading-log.md` Section 5).
//!
//! Rationale (codex-r11 audit + opus-arch #9): the Pratt parser is the 2-3 day item that
//! benefits from clear-headed implementation with Formualizer + IronCalc parser internals
//! freshly read. Shipping the lexer + AST shapes now unblocks Week 2 Day 7 fixture writing,
//! Week 3 calcgraph (which consumes `Expr`), and Week 4 ql-exec — none of which need the
//! parser to exist yet (the test fixtures construct `Expr` trees directly).
//!
//! Phase 0 lexer covers: numbers, strings, identifiers, A1 cell refs, ranges via Colon,
//! whole-column / whole-row sentinels, operators, punctuation. Deferred to Phase 3+:
//! R1C1, sheet-qualified, structured table refs, cross-workbook, array literals.
//!
//! The `AI()` reservation per CORR-06 / T4-D05 is intercepted at parser level (not yet
//! built here) and emits `Error(AINotAvailable)` from `ql-types`.

pub mod ast;
pub mod lexer;
pub mod token;

pub use ast::{CellAddr, Expr, RangeRef};
pub use lexer::{column_letters_to_index, lex, LexError, MAX_COLUMN, MAX_ROW};
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
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        };
        let _: RangeRef = RangeRef {
            start_col: Some(0),
            start_row: Some(0),
            end_col: Some(0),
            end_row: Some(0),
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
