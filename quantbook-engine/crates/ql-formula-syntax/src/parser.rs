//! Pratt parser — Phase B per CORR-20.
//!
//! Turns a `Vec<Token>` from the lexer into an `Expr` AST. Excel-canonical operator
//! precedence (low → high):
//!
//! ```text
//! comparison (=, <>, <, >, <=, >=)      bp 10/11 — left-assoc
//! concat (&)                            bp 20/21
//! addition (+, -)                       bp 30/31
//! multiplication (*, /)                 bp 40/41
//! power (^)                             bp 51/50 — right-assoc
//! percent (postfix %)                   bp 60   — postfix unary
//! unary prefix (-x, +x)                 bp 70
//! range (:)                             bp 80/81 — highest
//! function call / atomic                terminal
//! ```
//!
//! ## Function-call disambiguation
//!
//! Per CORR-13 (lexer audit fix R7), function names are NOT lexer-level keywords. The
//! lexer emits `CellRef { ..., text: "LOG10" }` and `BareColumn { ..., text: "AI" }`
//! preserving the source text. The parser uses the `text` field for function-name
//! lookup when the very next token is `LParen`:
//!
//! - `Ident("SUM")` + `LParen` → function call with name "SUM"
//! - `CellRef { text: "LOG10", ... }` + `LParen` → function call with name "LOG10"
//!   (NOT a cell-ref; precedence: `LParen` follows wins)
//! - `BareColumn { text: "AI", ... }` + `LParen` → function call with name "AI"
//!
//! All function names are uppercased to canonical form (Excel convention).
//!
//! ## AI() reservation (CORR-06 / T4-D05)
//!
//! After uppercase normalization, function name `"AI"` emits an ordinary
//! `Expr::Function { name: "AI", args }` AST node. The binder / evaluator maps that
//! function dispatch to `Error(ErrorValue::AINotAvailable)` (the `#AI_NOT_AVAILABLE_V1`
//! sigil). No special-case handling at parser level beyond name preservation.

use std::sync::Arc;

use crate::ast::{CellAddr, Expr, RangeRef};
use crate::token::{Operator, Token};

/// Parse error variants.
#[derive(Clone, Debug, PartialEq)]
pub enum ParseError {
    /// Reached end of token stream while expecting more input.
    UnexpectedEnd { context: &'static str },
    /// A specific token type was expected but a different one was found.
    Unexpected { context: &'static str, got: String },
    /// Range bounds malformed (e.g. `A1:B10:C100` or unmatched range types like `A1:B`).
    InvalidRange { detail: &'static str },
    /// Trailing tokens after a complete expression.
    Trailing { count: usize },
    /// Unclosed function call or grouping.
    UnclosedDelimiter { what: &'static str },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEnd { context } => write!(f, "unexpected end of input in {context}"),
            Self::Unexpected { context, got } => write!(f, "unexpected token in {context}: {got}"),
            Self::InvalidRange { detail } => write!(f, "invalid range: {detail}"),
            Self::Trailing { count } => write!(f, "trailing {count} token(s) after expression"),
            Self::UnclosedDelimiter { what } => write!(f, "unclosed {what}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Parse a complete formula from `tokens` (lexer output) to an AST.
pub fn parse(tokens: Vec<Token>) -> Result<Expr, ParseError> {
    let mut p = Parser::new(tokens);
    let e = p.parse_expr(0)?;
    if p.pos < p.tokens.len() {
        return Err(ParseError::Trailing {
            count: p.tokens.len() - p.pos,
        });
    }
    Ok(e)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    /// Pratt main loop. `min_bp` is the right-binding-power required to continue
    /// consuming infix operators.
    #[allow(clippy::while_let_loop)] // Loop body has multi-branch control flow
                                     // (postfix/range/binary/terminator); clearer as `loop`.
    fn parse_expr(&mut self, min_bp: u8) -> Result<Expr, ParseError> {
        let mut lhs = self.parse_prefix()?;

        loop {
            // Peek the next token; decide whether it's an infix/postfix operator we should
            // continue consuming.
            let next = match self.peek().cloned() {
                Some(t) => t,
                None => break,
            };

            // Postfix `%` — bp 60, no rhs.
            if matches!(next, Token::Op(Operator::Percent)) {
                if min_bp > 60 {
                    break;
                }
                self.advance();
                lhs = Expr::Unary {
                    op: Operator::Percent,
                    operand: Box::new(lhs),
                };
                continue;
            }

            // Range `:` — bp 80/81.
            if matches!(next, Token::Colon) {
                if min_bp > 80 {
                    break;
                }
                self.advance();
                let rhs = self.parse_prefix()?;
                lhs = self.build_range(lhs, rhs)?;
                continue;
            }

            // Binary operators.
            if let Token::Op(op) = next {
                let (lbp, rbp) = match infix_bp(op) {
                    Some(bp) => bp,
                    None => break,
                };
                if lbp < min_bp {
                    break;
                }
                self.advance();
                let rhs = self.parse_expr(rbp)?;
                lhs = Expr::Binary {
                    op,
                    lhs: Box::new(lhs),
                    rhs: Box::new(rhs),
                };
                continue;
            }

            // Anything else — terminator.
            break;
        }

        Ok(lhs)
    }

    fn parse_prefix(&mut self) -> Result<Expr, ParseError> {
        let token = self
            .advance()
            .ok_or(ParseError::UnexpectedEnd { context: "prefix" })?;

        match token {
            Token::Number(n) => Ok(Expr::Number(n)),
            Token::String(s) => Ok(Expr::String(s)),

            // Identifier — either a function call (if next is `(`) or a name-ref.
            // Phase 0 W5-1: bare identifier outside function context is treated as a
            // named-range reference. Named ranges aren't resolved in Phase 0 (no name
            // table integration with the parser yet); future Phase 1 binding will
            // resolve them.
            Token::Ident(name) => {
                if matches!(self.peek(), Some(Token::LParen)) {
                    self.advance(); // consume `(`
                    let args = self.parse_call_args()?;
                    Ok(Expr::Function {
                        name: canonicalize_function_name(&name),
                        args,
                    })
                } else {
                    // Recognize TRUE / FALSE as boolean literals here per Excel canon
                    // (lexer doesn't yet emit Bool tokens; identifiers are routed via
                    // the parser).
                    let upper = name.to_ascii_uppercase();
                    if upper == "TRUE" {
                        return Ok(Expr::Bool(true));
                    }
                    if upper == "FALSE" {
                        return Ok(Expr::Bool(false));
                    }
                    // Phase 0: bare identifier = named ref. The binder will fail at
                    // resolution time if unknown (Phase 1 work).
                    Ok(Expr::Function {
                        name: canonicalize_function_name(&name),
                        args: vec![],
                    })
                }
            }

            // CellRef — A1-style. Function-call disambiguation: if next is `(`, treat
            // as a function name (e.g. `LOG10(2)`).
            Token::CellRef {
                col,
                row,
                abs_col,
                abs_row,
                text,
            } => {
                if matches!(self.peek(), Some(Token::LParen)) {
                    self.advance();
                    let args = self.parse_call_args()?;
                    Ok(Expr::Function {
                        name: canonicalize_function_name(&text),
                        args,
                    })
                } else {
                    Ok(Expr::CellRef(CellAddr {
                        sheet: None,
                        col,
                        row,
                        abs_col,
                        abs_row,
                    }))
                }
            }

            // BareColumn — `A`, `$AI` etc. Function call if followed by `(`; range
            // anchor if followed by `:` (handled by the infix loop). Otherwise it's a
            // standalone bare-column reference (e.g. inside `=A` — Excel parses this as
            // a 1×N range; Phase 0 W5-1 falls through to scalar evaluator which will
            // produce a Value::Blank or similar via the binder).
            Token::BareColumn { col, abs, text } => {
                if matches!(self.peek(), Some(Token::LParen)) {
                    self.advance();
                    let args = self.parse_call_args()?;
                    Ok(Expr::Function {
                        name: canonicalize_function_name(&text),
                        args,
                    })
                } else {
                    // A bare column standing alone isn't a useful Phase 0 construct
                    // (it'd evaluate over the entire column as a vector). Keep it as a
                    // RangeRef::WholeColumn for the binder to handle / reject.
                    Ok(Expr::RangeRef(RangeRef::WholeColumn {
                        sheet: None,
                        start_col: col,
                        end_col: col,
                        abs_start: abs,
                        abs_end: abs,
                    }))
                }
            }

            // BareRow — `1`, `$5`. Same logic but for rows. Cannot be a function call
            // (digits-only identifiers aren't valid function names).
            Token::BareRow { row, abs } => Ok(Expr::RangeRef(RangeRef::WholeRow {
                sheet: None,
                start_row: row,
                end_row: row,
                abs_start: abs,
                abs_end: abs,
            })),

            // Unary prefix operators.
            Token::Op(Operator::Minus) => {
                let operand = self.parse_expr(70)?;
                Ok(Expr::Unary {
                    op: Operator::Minus,
                    operand: Box::new(operand),
                })
            }
            Token::Op(Operator::Plus) => {
                let operand = self.parse_expr(70)?;
                Ok(Expr::Unary {
                    op: Operator::Plus,
                    operand: Box::new(operand),
                })
            }

            // Grouping `(...)`.
            Token::LParen => {
                let inner = self.parse_expr(0)?;
                match self.advance() {
                    Some(Token::RParen) => Ok(inner),
                    Some(other) => Err(ParseError::Unexpected {
                        context: "grouping",
                        got: format!("{other:?}"),
                    }),
                    None => Err(ParseError::UnclosedDelimiter { what: "(" }),
                }
            }

            other => Err(ParseError::Unexpected {
                context: "prefix",
                got: format!("{other:?}"),
            }),
        }
    }

    /// Parse comma-separated function-call arguments. Caller has already consumed `(`.
    /// Consumes the closing `)`.
    fn parse_call_args(&mut self) -> Result<Vec<Expr>, ParseError> {
        let mut args = Vec::new();
        // Empty arg list — immediate `)`.
        if matches!(self.peek(), Some(Token::RParen)) {
            self.advance();
            return Ok(args);
        }
        loop {
            let arg = self.parse_expr(0)?;
            args.push(arg);
            match self.advance() {
                Some(Token::Comma) => continue,
                Some(Token::RParen) => return Ok(args),
                Some(other) => {
                    return Err(ParseError::Unexpected {
                        context: "function-args",
                        got: format!("{other:?}"),
                    })
                }
                None => return Err(ParseError::UnclosedDelimiter { what: "(" }),
            }
        }
    }

    /// Build a `RangeRef::Cells`-style range from a `:`-separated pair of operands.
    /// Recognized patterns:
    /// - `CellRef:CellRef` → `RangeRef::Cells`
    /// - `WholeColumn:WholeColumn` → `RangeRef::WholeColumn` (merged spans)
    /// - `WholeRow:WholeRow` → `RangeRef::WholeRow`
    ///
    /// Mixed cases (e.g. `A1:B`) are an `InvalidRange` parse error.
    fn build_range(&self, lhs: Expr, rhs: Expr) -> Result<Expr, ParseError> {
        // Normalize `Number:Number` (Excel whole-row notation `1:5`). The lexer emits
        // Number tokens for bare digits without `$`; the parser converts them to
        // 0-indexed row references here.
        let lhs = number_to_bare_row(lhs)?;
        let rhs = number_to_bare_row(rhs)?;
        match (lhs, rhs) {
            (Expr::CellRef(a), Expr::CellRef(b)) => {
                // Sort start/end on each axis (Excel normalizes A2:A1 → A1:A2).
                let (start_col, end_col, abs_start_col, abs_end_col) = if a.col <= b.col {
                    (a.col, b.col, a.abs_col, b.abs_col)
                } else {
                    (b.col, a.col, b.abs_col, a.abs_col)
                };
                let (start_row, end_row, abs_start_row, abs_end_row) = if a.row <= b.row {
                    (a.row, b.row, a.abs_row, b.abs_row)
                } else {
                    (b.row, a.row, b.abs_row, a.abs_row)
                };
                Ok(Expr::RangeRef(RangeRef::Cells {
                    sheet: None,
                    start_col,
                    start_row,
                    end_col,
                    end_row,
                    abs_start_col,
                    abs_start_row,
                    abs_end_col,
                    abs_end_row,
                }))
            }
            // `A:A` — both sides parsed as WholeColumn singletons; merge their spans.
            (
                Expr::RangeRef(RangeRef::WholeColumn {
                    start_col: a_s,
                    end_col: a_e,
                    abs_start: a_abs_s,
                    abs_end: a_abs_e,
                    ..
                }),
                Expr::RangeRef(RangeRef::WholeColumn {
                    start_col: b_s,
                    end_col: b_e,
                    abs_start: b_abs_s,
                    abs_end: b_abs_e,
                    ..
                }),
            ) => {
                let lo = a_s.min(b_s).min(a_e).min(b_e);
                let hi = a_e.max(b_e).max(a_s).max(b_s);
                // Take the abs flag from whichever side contributed the extreme.
                let abs_start = if a_s == lo { a_abs_s } else { b_abs_s };
                let abs_end = if a_e == hi || b_e == hi {
                    if a_e == hi {
                        a_abs_e
                    } else {
                        b_abs_e
                    }
                } else {
                    false
                };
                Ok(Expr::RangeRef(RangeRef::WholeColumn {
                    sheet: None,
                    start_col: lo,
                    end_col: hi,
                    abs_start,
                    abs_end,
                }))
            }
            // `1:1` — both sides parsed as WholeRow singletons.
            (
                Expr::RangeRef(RangeRef::WholeRow {
                    start_row: a_s,
                    end_row: a_e,
                    abs_start: a_abs_s,
                    abs_end: a_abs_e,
                    ..
                }),
                Expr::RangeRef(RangeRef::WholeRow {
                    start_row: b_s,
                    end_row: b_e,
                    abs_start: b_abs_s,
                    abs_end: b_abs_e,
                    ..
                }),
            ) => {
                let lo = a_s.min(b_s).min(a_e).min(b_e);
                let hi = a_e.max(b_e).max(a_s).max(b_s);
                let abs_start = if a_s == lo { a_abs_s } else { b_abs_s };
                let abs_end = if a_e == hi || b_e == hi {
                    if a_e == hi {
                        a_abs_e
                    } else {
                        b_abs_e
                    }
                } else {
                    false
                };
                Ok(Expr::RangeRef(RangeRef::WholeRow {
                    sheet: None,
                    start_row: lo,
                    end_row: hi,
                    abs_start,
                    abs_end,
                }))
            }
            _ => Err(ParseError::InvalidRange {
                detail: "mixed CellRef/Column/Row range operands (e.g. A1:B); Phase 0 only allows matching types",
            }),
        }
    }
}

/// Convert a literal `Number(N)` to a `RangeRef::WholeRow` singleton (1-indexed in source
/// → 0-indexed internal). Used in range parsing for the `1:5` whole-row pattern. Other
/// Expr variants pass through unchanged.
fn number_to_bare_row(e: Expr) -> Result<Expr, ParseError> {
    if let Expr::Number(n) = e {
        // Excel row indices are 1-based positive integers in source. Validate:
        if n.fract() != 0.0 || n < 1.0 || n > (u32::MAX as f64) {
            return Err(ParseError::InvalidRange {
                detail: "row index must be a positive integer",
            });
        }
        let row = (n as u32) - 1;
        Ok(Expr::RangeRef(RangeRef::WholeRow {
            sheet: None,
            start_row: row,
            end_row: row,
            abs_start: false,
            abs_end: false,
        }))
    } else {
        Ok(e)
    }
}

/// Infix-operator binding powers. Returns `None` for tokens that aren't infix operators.
fn infix_bp(op: Operator) -> Option<(u8, u8)> {
    match op {
        Operator::Eq
        | Operator::Neq
        | Operator::Lt
        | Operator::Le
        | Operator::Gt
        | Operator::Ge => Some((10, 11)),
        Operator::Concat => Some((20, 21)),
        Operator::Plus | Operator::Minus => Some((30, 31)),
        Operator::Mul | Operator::Div => Some((40, 41)),
        Operator::Pow => Some((51, 50)), // right-assoc: lbp > rbp by 1
        Operator::Percent => None,       // postfix-only
    }
}

/// Canonicalize a function name to uppercase (Excel convention) per CORR-06.
/// Returns an Arc<str> for cheap clone into Expr::Function.name.
fn canonicalize_function_name(name: &Arc<str>) -> Arc<str> {
    let upper = name.as_ref().to_ascii_uppercase();
    Arc::from(upper.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;

    fn p(src: &str) -> Expr {
        parse(lex(src).expect("lex")).expect("parse")
    }

    fn perr(src: &str) -> ParseError {
        parse(lex(src).expect("lex")).expect_err("expected parse error")
    }

    // ===== literals =====

    #[test]
    fn parse_number_literal() {
        assert_eq!(p("42"), Expr::Number(42.0));
        assert_eq!(p("3.5"), Expr::Number(3.5));
    }

    #[test]
    fn parse_string_literal() {
        match p("\"hello\"") {
            Expr::String(s) => assert_eq!(s.as_ref(), "hello"),
            _ => panic!(),
        }
    }

    #[test]
    fn parse_bool_literals_via_ident() {
        assert_eq!(p("TRUE"), Expr::Bool(true));
        assert_eq!(p("FALSE"), Expr::Bool(false));
        // Case-insensitive
        assert_eq!(p("True"), Expr::Bool(true));
        assert_eq!(p("false"), Expr::Bool(false));
    }

    // ===== cell refs =====

    #[test]
    fn parse_cell_ref_a1() {
        match p("A1") {
            Expr::CellRef(addr) => {
                assert_eq!(addr.col, 0);
                assert_eq!(addr.row, 0);
                assert!(!addr.abs_col && !addr.abs_row);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_cell_ref_absolute() {
        match p("$B$5") {
            Expr::CellRef(addr) => {
                assert_eq!(addr.col, 1);
                assert_eq!(addr.row, 4);
                assert!(addr.abs_col && addr.abs_row);
            }
            _ => panic!(),
        }
    }

    // ===== arithmetic + precedence =====

    #[test]
    fn parse_simple_add() {
        let e = p("1 + 2");
        match e {
            Expr::Binary {
                op: Operator::Plus,
                lhs,
                rhs,
            } => {
                assert_eq!(*lhs, Expr::Number(1.0));
                assert_eq!(*rhs, Expr::Number(2.0));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_og02_pattern() {
        // =A * 2 — THE OG-02 baseline. Lexer emits BareColumn{col=0, text="A"} + Op(Mul) +
        // Number(2.0). Parser builds Binary { Mul, BareColumn→WholeColumn(A), Number(2) }.
        let e = p("A * 2");
        match e {
            Expr::Binary {
                op: Operator::Mul,
                lhs,
                rhs,
            } => {
                assert!(matches!(
                    *lhs,
                    Expr::RangeRef(RangeRef::WholeColumn { start_col: 0, .. })
                ));
                assert_eq!(*rhs, Expr::Number(2.0));
            }
            _ => panic!("expected Binary Mul"),
        }
    }

    #[test]
    fn parse_precedence_mul_over_add() {
        // 1 + 2 * 3 → 1 + (2 * 3)
        let e = p("1 + 2 * 3");
        match e {
            Expr::Binary {
                op: Operator::Plus,
                lhs,
                rhs,
            } => {
                assert_eq!(*lhs, Expr::Number(1.0));
                assert!(matches!(
                    *rhs,
                    Expr::Binary {
                        op: Operator::Mul,
                        ..
                    }
                ));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_precedence_parens_override() {
        // (1 + 2) * 3 → (1 + 2) * 3
        let e = p("(1 + 2) * 3");
        match e {
            Expr::Binary {
                op: Operator::Mul,
                lhs,
                rhs,
            } => {
                assert!(matches!(
                    *lhs,
                    Expr::Binary {
                        op: Operator::Plus,
                        ..
                    }
                ));
                assert_eq!(*rhs, Expr::Number(3.0));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_power_right_associative() {
        // 2 ^ 3 ^ 2 → 2 ^ (3 ^ 2)
        let e = p("2 ^ 3 ^ 2");
        match e {
            Expr::Binary {
                op: Operator::Pow,
                lhs,
                rhs,
            } => {
                assert_eq!(*lhs, Expr::Number(2.0));
                assert!(matches!(
                    *rhs,
                    Expr::Binary {
                        op: Operator::Pow,
                        ..
                    }
                ));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_subtraction_left_associative() {
        // 10 - 3 - 2 → (10 - 3) - 2
        let e = p("10 - 3 - 2");
        match e {
            Expr::Binary {
                op: Operator::Minus,
                lhs,
                rhs,
            } => {
                assert!(matches!(
                    *lhs,
                    Expr::Binary {
                        op: Operator::Minus,
                        ..
                    }
                ));
                assert_eq!(*rhs, Expr::Number(2.0));
            }
            _ => panic!(),
        }
    }

    // ===== unary =====

    #[test]
    fn parse_unary_minus_number() {
        let e = p("-5");
        match e {
            Expr::Unary {
                op: Operator::Minus,
                operand,
            } => assert_eq!(*operand, Expr::Number(5.0)),
            _ => panic!(),
        }
    }

    #[test]
    fn parse_unary_minus_cellref() {
        let e = p("-A1");
        match e {
            Expr::Unary {
                op: Operator::Minus,
                operand,
            } => {
                assert!(matches!(*operand, Expr::CellRef(_)));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_unary_binds_tighter_than_mul() {
        // -2 * 3 → (-2) * 3, not -(2*3)
        let e = p("-2 * 3");
        match e {
            Expr::Binary {
                op: Operator::Mul,
                lhs,
                rhs,
            } => {
                assert!(matches!(
                    *lhs,
                    Expr::Unary {
                        op: Operator::Minus,
                        ..
                    }
                ));
                assert_eq!(*rhs, Expr::Number(3.0));
            }
            _ => panic!(),
        }
    }

    // ===== comparison + concat =====

    #[test]
    fn parse_comparison_eq() {
        let e = p("A1 = B1");
        match e {
            Expr::Binary {
                op: Operator::Eq,
                lhs,
                rhs,
            } => {
                assert!(matches!(*lhs, Expr::CellRef(_)));
                assert!(matches!(*rhs, Expr::CellRef(_)));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_concat_string() {
        // "foo" & "bar"
        let e = p("\"foo\" & \"bar\"");
        match e {
            Expr::Binary {
                op: Operator::Concat,
                lhs,
                rhs,
            } => {
                assert!(matches!(*lhs, Expr::String(_)));
                assert!(matches!(*rhs, Expr::String(_)));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_concat_lower_precedence_than_arithmetic() {
        // A1 & 1 + 2 → A1 & (1 + 2)
        let e = p("A1 & 1 + 2");
        match e {
            Expr::Binary {
                op: Operator::Concat,
                rhs,
                ..
            } => {
                assert!(matches!(
                    *rhs,
                    Expr::Binary {
                        op: Operator::Plus,
                        ..
                    }
                ));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_comparison_lower_precedence_than_concat() {
        // A1 & "x" = "Ax" → (A1 & "x") = "Ax"
        let e = p("A1 & \"x\" = \"Ax\"");
        match e {
            Expr::Binary {
                op: Operator::Eq,
                lhs,
                ..
            } => {
                assert!(matches!(
                    *lhs,
                    Expr::Binary {
                        op: Operator::Concat,
                        ..
                    }
                ));
            }
            _ => panic!(),
        }
    }

    // ===== function calls =====

    #[test]
    fn parse_function_no_args() {
        let e = p("NOW()");
        match e {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "NOW");
                assert!(args.is_empty());
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_function_one_arg() {
        let e = p("ABS(-5)");
        match e {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "ABS");
                assert_eq!(args.len(), 1);
                assert!(matches!(args[0], Expr::Unary { .. }));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_function_multiple_args() {
        let e = p("SUM(1, 2, 3)");
        match e {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 3);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_nested_function() {
        // IF(SUM(A1, A2) > 0, "ok", "bad")
        let e = p("IF(SUM(A1, A2) > 0, \"ok\", \"bad\")");
        match e {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "IF");
                assert_eq!(args.len(), 3);
                // First arg is a comparison; lhs is SUM call.
                if let Expr::Binary {
                    op: Operator::Gt,
                    lhs,
                    ..
                } = &args[0]
                {
                    assert!(matches!(lhs.as_ref(), Expr::Function { .. }));
                } else {
                    panic!("expected comparison");
                }
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_function_name_uppercased() {
        // sum(1, 2) → name should be "SUM"
        match p("sum(1, 2)") {
            Expr::Function { name, .. } => assert_eq!(name.as_ref(), "SUM"),
            _ => panic!(),
        }
        match p("Sum(1, 2)") {
            Expr::Function { name, .. } => assert_eq!(name.as_ref(), "SUM"),
            _ => panic!(),
        }
    }

    #[test]
    fn parse_log10_disambiguation() {
        // LOG10 lexes as a CellRef (col=L+O+G+1+0... ridiculous column index, text="LOG10").
        // When followed by `(`, the parser treats it as a function name.
        match p("LOG10(100)") {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "LOG10");
                assert_eq!(args.len(), 1);
            }
            _ => panic!("LOG10(...) should parse as a function call"),
        }
    }

    // ===== AI() reservation per CORR-06 =====

    #[test]
    fn parse_ai_function_reservation_canonical() {
        // AI("prompt") — AI is a BareColumn (col=0+I=... in column-letter math, "AI"
        // → col 34). When followed by `(`, parser emits Function { name: "AI", ... }.
        // The binder maps that to AINotAvailable; that's a Phase 0 ql-exec concern.
        match p("AI(\"hello\")") {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "AI");
                assert_eq!(args.len(), 1);
                assert!(matches!(args[0], Expr::String(_)));
            }
            _ => panic!("AI(...) should parse as a function call"),
        }
    }

    #[test]
    fn parse_ai_function_case_insensitive() {
        // ai("..."), Ai(...), AI(...) should all canonicalize to "AI".
        for src in ["ai(\"x\")", "Ai(\"x\")", "AI(\"x\")"] {
            match p(src) {
                Expr::Function { name, .. } => assert_eq!(name.as_ref(), "AI", "src={src}"),
                _ => panic!("{src} should parse as Function"),
            }
        }
    }

    // ===== ranges =====

    #[test]
    fn parse_range_cells() {
        // A1:B10
        let e = p("A1:B10");
        match e {
            Expr::RangeRef(RangeRef::Cells {
                start_col,
                start_row,
                end_col,
                end_row,
                ..
            }) => {
                assert_eq!((start_col, start_row, end_col, end_row), (0, 0, 1, 9));
            }
            _ => panic!("expected Cells range"),
        }
    }

    #[test]
    fn parse_range_whole_column() {
        // A:A
        match p("A:A") {
            Expr::RangeRef(RangeRef::WholeColumn {
                start_col, end_col, ..
            }) => assert_eq!((start_col, end_col), (0, 0)),
            _ => panic!("expected WholeColumn"),
        }
    }

    #[test]
    fn parse_range_whole_column_multi() {
        // A:C → cols 0..=2
        match p("A:C") {
            Expr::RangeRef(RangeRef::WholeColumn {
                start_col, end_col, ..
            }) => assert_eq!((start_col, end_col), (0, 2)),
            _ => panic!(),
        }
    }

    #[test]
    fn parse_range_whole_row() {
        // 1:1
        match p("1:1") {
            Expr::RangeRef(RangeRef::WholeRow {
                start_row, end_row, ..
            }) => assert_eq!((start_row, end_row), (0, 0)),
            _ => panic!("expected WholeRow"),
        }
    }

    #[test]
    fn parse_sum_of_whole_column() {
        // =SUM(A:A) — THE A4 acceptance pattern.
        match p("SUM(A:A)") {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 1);
                assert!(matches!(
                    args[0],
                    Expr::RangeRef(RangeRef::WholeColumn { start_col: 0, .. })
                ));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_range_normalizes_reversed_corners() {
        // Excel: A2:A1 → A1:A2 (normalized).
        match p("A2:A1") {
            Expr::RangeRef(RangeRef::Cells {
                start_row, end_row, ..
            }) => assert!(start_row <= end_row, "normalized rows"),
            _ => panic!(),
        }
    }

    // ===== postfix percent =====

    #[test]
    fn parse_postfix_percent() {
        // Note: 50% lexes directly to Number(0.5) per the lexer's percent handling.
        // For a postfix-percent on a parenthesized expression: (1 + 2)% → 0.03
        let e = p("(1 + 2)%");
        match e {
            Expr::Unary {
                op: Operator::Percent,
                operand,
            } => {
                assert!(matches!(
                    *operand,
                    Expr::Binary {
                        op: Operator::Plus,
                        ..
                    }
                ));
            }
            _ => panic!(),
        }
    }

    // ===== errors =====

    #[test]
    fn parse_trailing_garbage_errors() {
        assert!(matches!(perr("1 + 2 3"), ParseError::Trailing { .. }));
    }

    #[test]
    fn parse_unclosed_paren_errors() {
        assert!(matches!(
            perr("(1 + 2"),
            ParseError::UnclosedDelimiter { what: "(" }
        ));
    }

    #[test]
    fn parse_empty_errors() {
        let result = parse(vec![]);
        assert!(matches!(result, Err(ParseError::UnexpectedEnd { .. })));
    }

    #[test]
    fn parse_mismatched_range_types_errors() {
        // A1:B (CellRef:BareColumn) is invalid Phase 0.
        assert!(matches!(perr("A1:B"), ParseError::InvalidRange { .. }));
    }

    // ===== full OG-02 + SUM patterns =====

    #[test]
    fn parse_og02_full_pipeline() {
        // =A * 2 — verify the AST is the exact shape ql-exec::lower::classify expects
        // for MulScalar dispatch.
        let e = p("A * 2");
        match e {
            Expr::Binary {
                op: Operator::Mul,
                lhs,
                rhs,
            } => {
                assert!(matches!(*lhs, Expr::RangeRef(RangeRef::WholeColumn { .. })));
                assert_eq!(*rhs, Expr::Number(2.0));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_arithmetic_with_cellref_pattern() {
        // =A1 * 2 — the row-specific variant. Lower into MulScalar via classify+dispatch.
        let e = p("A1 * 2");
        match e {
            Expr::Binary {
                op: Operator::Mul,
                lhs,
                rhs,
            } => {
                assert!(matches!(*lhs, Expr::CellRef(_)));
                assert_eq!(*rhs, Expr::Number(2.0));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_complex_formula() {
        // =IF(SUM(A1:A10) > 100, "big", AVERAGE(B1:B10) * 2)
        let src = "IF(SUM(A1:A10) > 100, \"big\", AVERAGE(B1:B10) * 2)";
        let e = p(src);
        match e {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "IF");
                assert_eq!(args.len(), 3);
                // arg[0]: SUM(A1:A10) > 100
                assert!(matches!(
                    args[0],
                    Expr::Binary {
                        op: Operator::Gt,
                        ..
                    }
                ));
                // arg[1]: "big"
                assert!(matches!(args[1], Expr::String(_)));
                // arg[2]: AVERAGE(...) * 2
                assert!(matches!(
                    args[2],
                    Expr::Binary {
                        op: Operator::Mul,
                        ..
                    }
                ));
            }
            _ => panic!(),
        }
    }
}
