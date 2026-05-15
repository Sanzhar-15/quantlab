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
    /// Numeric literal (integer, decimal, exponent — already coerced to `f64`).
    /// Audit L1 fix (2026-05-12): a trailing `%` is NOT folded into the literal at
    /// lex time; the lexer emits a separate `Op(Percent)` token. The parser applies
    /// percent semantics via `Unary { op: Percent, operand }` (postfix unary). To
    /// match Excel canon more strictly, future Phase 2+ may fold `%` into the
    /// literal at lex time; until then `50%` produces two tokens (Number(50.0),
    /// Op(Percent)) and the parser produces Unary { Percent, Number(50.0) } which
    /// evaluates to 0.5.
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

    /// **W5-97 (Phase 4.7.C):** `{` — opens an array literal. Used by the
    /// Phase 4.7 array-literal grammar (`{1,2;3,4}`). Outside that grammar
    /// the parser rejects it with `ParseError::UnexpectedToken`.
    LBrace,

    /// **W5-97 (Phase 4.7.C):** `}` — closes an array literal.
    RBrace,

    /// **W5-97 (Phase 4.7.C):** an Excel error sigil literal (`#REF!`,
    /// `#N/A`, `#DIV/0!`, `#NUM!`, `#NAME?`, `#NULL!`, `#VALUE!`,
    /// `#SPILL!`, `#CALC!`, plus the Quantbook-specific sigils like
    /// `#DISCONNECTED!`). Recognized at lex time so `=IFERROR(#REF!, 0)`
    /// and array literals `{1, #N/A, 3}` (Phase 4.7.D) tokenize cleanly.
    /// The parser maps this to `Expr::ErrorLiteral(_)` (4.7.D) — for
    /// now (4.7.C) the parser treats it as an unexpected token.
    Error(ql_types::ErrorValue),

    /// **W5-88 (Phase 4.6.A part 2):** `!` separator between a sheet
    /// name and a cell/range reference. Only meaningful immediately
    /// after a `SheetName` / `QuotedSheetName` token; appearing
    /// elsewhere is a parser error.
    Bang,

    /// **W5-88 (Phase 4.6.A part 2):** unquoted sheet name preceding `!`.
    /// `[A-Za-z_][A-Za-z0-9_.]*` per design doc § 4.1. The lexer uses
    /// one-token lookahead to disambiguate from `Ident`: only when the
    /// next non-whitespace char is `!` does the run emit as
    /// `SheetName + Bang` instead of an `Ident`. Stored as `Arc<str>`
    /// for cheap clone-through-bind.
    SheetName(Arc<str>),

    /// **W5-88 (Phase 4.6.A part 2):** quoted sheet name `'...'` with
    /// `''` → `'` escape decoded. Like `SheetName`, only emitted when
    /// the closing quote is followed by `!` (skipping intervening
    /// whitespace). The body is the decoded form (no surrounding quotes).
    QuotedSheetName(Arc<str>),

    /// **W5-138 (Phase 4.9.B.4):** R1C1-style reference. Emitted only
    /// when `lex_with` is called with `ReferenceMode::R1C1`. Each axis
    /// is independently `Abs(n)` (1-indexed) or `Rel(offset)` (signed
    /// offset from formula anchor). Ranges (`R1C1:R10C5`) lex as
    /// `R1C1Ref + Colon + R1C1Ref` — the colon-join + range assembly
    /// stays in the parser (4.9.C).
    ///
    /// Relative-offset resolution defers to bind time (4.9.C / 4.9.H)
    /// using `BindSite::at_cell`; the lexer accepts any in-range i32
    /// offset without applying anchor arithmetic.
    ///
    /// Bare `R` / `C` (no digit, no `[]`) are canonicalized to
    /// `Rel(0)` per Excel R1C1 canon (`RC` ≡ "this cell").
    R1C1Ref {
        row_axis: AxisSpec,
        col_axis: AxisSpec,
    },

    /// **W5-111 (Phase 4.8.B):** structured table reference `Table[Col]`,
    /// `Table[[#Headers], [Col]]`, etc. `table_name` is the case-preserving
    /// identifier preceding `[`; `bracket_content` is the UNESCAPED text
    /// between the outer `[` and matching `]` (per OOXML escape rules
    /// `'[`, `']`, `'#`, `'@`, `''` consumed at lex time).
    ///
    /// The parser runs a structured-ref sub-grammar over `bracket_content`
    /// to produce `Expr::StructuredRef` (Phase 4.8.C / W5-112).
    ///
    /// **#148 closure:** an identifier followed immediately by `[` lexes
    /// as `StructuredRef` even when the identifier matches a column-letter
    /// pattern (`Src`, `AAA`). Pre-4.8.B these would have shadowed into
    /// `BareColumn` and surfaced misleading bind errors. Table-name
    /// validity (rejecting `A1`/`A:A`/cell-ref-like names) is enforced
    /// at `create_table` (Phase 4.8.H), NOT here.
    StructuredRef {
        /// Table identifier verbatim (case-preserving; canonicalize at
        /// bind time via `Workbook::lookup_table`).
        table_name: Arc<str>,
        /// Bracket content with escapes resolved.
        bracket_content: Arc<str>,
    },
}

/// **W5-138 (Phase 4.9.B.4):** one axis (row OR column) of an R1C1
/// reference. Either an absolute 1-indexed row/column number, or a
/// signed relative offset from the formula's anchor cell.
///
/// - `Abs(n)` — 1-indexed. `Abs(0)` is invalid (R1C1 is 1-indexed
///   in source per Excel canon); the lexer rejects it. `Abs(n)` is
///   bounded by `MAX_ROW + 1` / `MAX_COLUMN + 1` at lex time.
/// - `Rel(offset)` — signed offset (`R[-1]` = one row above anchor).
///   Resolution happens at bind time (4.9.C / 4.9.H). The lexer
///   accepts any value that fits in `i32`; anchor + offset bounds-
///   check defers to the binder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AxisSpec {
    Abs(u32),
    Rel(i32),
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
