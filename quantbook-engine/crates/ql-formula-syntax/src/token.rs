//! Lexical tokens for the Quantbook formula language.
//!
//! Per spec Part V §4 Week 2 Days 5-6. **PHASE 0 MINIMUM** scope per audit recommendation:
//! - Number literals (integer + decimal + exponent + trailing %)
//! - String literals (`"..."` with `""` for embedded quote)
//! - A1 cell refs (column letters + row digits, with `$` absolute markers)
//! - Range refs (`A1:B10`, including infinite forms `A:A` / `1:1`)
//! - Identifiers (function names + named refs — disambiguated at parser level)
//! - Operators (`+ - * / % ^ & = <> < > <= >=`)
//! - Punctuation (`( ) , : ;`)
//!
//! **Deferred to Phase 3+** (out of Phase 0 scope, would inflate the parser surface):
//! - R1C1 references (`R1C1`, `R[1]C[1]`)
//! - Sheet-qualified refs (`Sheet1!A1`, `'Sheet 1'!A1`)
//! - Structured table refs (`Table1[Col]`, `Table1[@Col]`)
//! - Cross-workbook refs (`[file.xlsx]Sheet1!A1`)
//! - Array literal syntax `{1,2;3,4}`
//!
//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
//!
//! **AI() reservation (CORR-06 / T4-D05) lives entirely at the parser level.** The lexer
//! treats `AI` as a regular 2-letter column-letter identifier and emits `BareColumn { col,
//! abs, text }` with `text = "AI"`. When the parser encounters `BareColumn`-or-`CellRef`
//! immediately followed by `LParen`, it looks up the `text` field as a function name; if it
//! matches `AI` (case-insensitive), the parser emits `Expr::Function { name: "AI", ... }`
//! which the binder/evaluator then maps to `Error(ErrorValue::AINotAvailable)`. No special
//! lexer-level reservation; the `text` field IS the disambiguation handle.

use std::sync::Arc;

/// A single lexed token. `Copy` for primitives; `Arc<str>` for the text-bearing variants.
#[derive(Clone, Debug, PartialEq)]
pub enum Token {
    /// Numeric literal (integer, decimal, exponent — already coerced to `f64`). Trailing `%`
    /// is stripped and the value divided by 100 at lex time (Excel-canonical).
    Number(f64),

    /// String literal between `"..."` with `""` escape collapsed. The interior content only.
    String(Arc<str>),

    /// Identifier — function name (`SUM`, `AVERAGE`, `AI`) or named range. The parser
    /// disambiguates based on the following token (`(` → function, otherwise → named ref).
    Ident(Arc<str>),

    /// A1-style cell reference. Stores zero-indexed `(col, row)` plus absolute-marker flags
    /// AND the raw source text. The raw text is preserved so the parser can disambiguate
    /// function calls: Excel-canonical, `LOG10(2)` lexes as `CellRef{col=8508, row=9,
    /// text="LOG10"}` followed by `LParen` — the parser sees LParen and looks up `text` as
    /// a function name. (Per codex r13 N6 + opus arch F6 audit; the lexer can't disambiguate
    /// without lookahead beyond `(`, so the parser owns the dispatch.)
    CellRef {
        col: u32,
        row: u32,
        abs_col: bool,
        abs_row: bool,
        text: Arc<str>,
    },

    /// Open-axis cell reference for whole-column forms within a `Range` (e.g.  `A:A` lexes
    /// as two `BareColumn` joined by `Colon`). Stores zero-indexed col, abs marker, and the
    /// raw source text (for parser-level function-name disambiguation when followed by `(`).
    BareColumn {
        col: u32,
        abs: bool,
        text: Arc<str>,
    },

    /// Open-axis bare row for `1:1` forms — only meaningful inside a range. 0-indexed row
    /// + abs marker (the `$` BEFORE the digits, e.g. `$5`).
    BareRow {
        row: u32,
        abs: bool,
    },

    /// Operators — single tokens; the parser builds the precedence tree.
    Op(Operator),

    LParen,
    RParen,
    Comma,
    Colon,
    Semicolon,
}

/// Operator subtype carried by `Token::Op`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Operator {
    Plus,    // +
    Minus,   // -  (also unary)
    Mul,     // *
    Div,     // /
    Percent, // %  (postfix unary; lex emits as Op for clean disambiguation in parser)
    Pow,     // ^
    Concat,  // &
    Eq,      // =
    Neq,     // <>
    Lt,      // <
    Le,      // <=
    Gt,      // >
    Ge,      // >=
}

impl Operator {
    /// Stable text representation for AST printer / diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Operator::Plus => "+",
            Operator::Minus => "-",
            Operator::Mul => "*",
            Operator::Div => "/",
            Operator::Percent => "%",
            Operator::Pow => "^",
            Operator::Concat => "&",
            Operator::Eq => "=",
            Operator::Neq => "<>",
            Operator::Lt => "<",
            Operator::Le => "<=",
            Operator::Gt => ">",
            Operator::Ge => ">=",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_as_str_table() {
        assert_eq!(Operator::Plus.as_str(), "+");
        assert_eq!(Operator::Minus.as_str(), "-");
        assert_eq!(Operator::Mul.as_str(), "*");
        assert_eq!(Operator::Div.as_str(), "/");
        assert_eq!(Operator::Percent.as_str(), "%");
        assert_eq!(Operator::Pow.as_str(), "^");
        assert_eq!(Operator::Concat.as_str(), "&");
        assert_eq!(Operator::Eq.as_str(), "=");
        assert_eq!(Operator::Neq.as_str(), "<>");
        assert_eq!(Operator::Lt.as_str(), "<");
        assert_eq!(Operator::Le.as_str(), "<=");
        assert_eq!(Operator::Gt.as_str(), ">");
        assert_eq!(Operator::Ge.as_str(), ">=");
    }

    #[test]
    fn token_equality_is_structural() {
        let a = Token::Number(1.5);
        let b = Token::Number(1.5);
        assert_eq!(a, b);
        assert_ne!(Token::Number(1.5), Token::Number(2.5));
        assert_ne!(Token::LParen, Token::RParen);
    }

    #[test]
    fn cellref_components_distinct() {
        let a = Token::CellRef {
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
            text: Arc::from("A1"),
        };
        let b = Token::CellRef {
            col: 0,
            row: 0,
            abs_col: true,
            abs_row: false,
            text: Arc::from("$A1"),
        };
        let c = Token::CellRef {
            col: 0,
            row: 1,
            abs_col: false,
            abs_row: false,
            text: Arc::from("A2"),
        };
        assert_ne!(a, b);
        assert_ne!(a, c);
    }
}
