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

use crate::ast::{CellAddr, Expr, RangeRef, SheetRef};
use crate::token::{AxisSpec, Operator, Token};

/// Parse error variants.
///
/// Phase 2A.11 audit M16 (2026-05-12): switched to `thiserror::Error` from
/// hand-rolled Display + std::error::Error. Strings identical to prior
/// hand-rolled formatters; consistency with the other error types.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ParseError {
    /// Reached end of token stream while expecting more input.
    #[error("unexpected end of input in {context}")]
    UnexpectedEnd { context: &'static str },
    /// A specific token type was expected but a different one was found.
    #[error("unexpected token in {context}: {got}")]
    Unexpected { context: &'static str, got: String },
    /// Range bounds malformed (e.g. `A1:B10:C100` or unmatched range types like `A1:B`).
    #[error("invalid range: {detail}")]
    InvalidRange { detail: &'static str },
    /// Trailing tokens after a complete expression.
    #[error("trailing {count} token(s) after expression")]
    Trailing { count: usize },
    /// Unclosed function call or grouping.
    #[error("unclosed {what}")]
    UnclosedDelimiter { what: &'static str },

    /// **W5-89 (Phase 4.6.A part 3):** `Sheet!` with no following ref
    /// (end-of-input or a non-reference token).
    #[error("dangling sheet qualifier — '{name}!' must be followed by a cell or range reference")]
    DanglingBang { name: String },

    /// **W5-89 (Phase 4.6.A part 3):** `Sheet1!Sheet2!X` — chained
    /// sheet qualifiers. Cross-sheet refs in Excel are flat; only ONE
    /// `Sheet!` per reference.
    #[error("double sheet qualifier — only one 'Sheet!' is allowed per reference")]
    DoubleSheetQualifier,

    /// **W5-89 (Phase 4.6.A part 3):** `Sheet1!A1:Sheet2!B2` —
    /// mixed-sheet endpoint range. Excel canon: the prefix applies to
    /// the whole range; specifying it on BOTH endpoints with different
    /// sheets is invalid.
    #[error("mixed-sheet range endpoints — both endpoints must reference the same sheet")]
    MixedSheetRangeEndpoints,

    /// **W5-89 (Phase 4.6.A part 3):** any non-reference term after a
    /// sheet qualifier — e.g. `Sheet1!SUM` (Function), `Sheet1!"x"`
    /// (literal), `Sheet1!(A1)` (grouping).
    #[error("sheet qualifier must be followed by a cell or range reference, got {got}")]
    SheetQualifierFollowedByNonReference { got: String },

    /// **W5-139 (Phase 4.9.C):** an R1C1 range endpoint pair where
    /// at least one axis disagrees in relativity (absolute vs
    /// relative) between the two endpoints. Excel canon forbids
    /// mixing, e.g. `R1C1:R[10]C5` (start row absolute, end row
    /// relative) is rejected with this error per design § 3.1.
    /// Closes Codex MEDIUM + Sonnet H-4 from the 4.9.AA review.
    #[error("R1C1 range endpoints have mismatched relativity — each axis must be uniformly absolute or relative across both endpoints")]
    R1C1MixedRelativity,

    /// **W5-98 (Phase 4.7.D):** array literal `{1, 2; 3}` has rows of
    /// different length. Excel pads missing cells with `#N/A` but
    /// Quantbook v1 rejects loudly per design § 3.2 — pad-with-N/A
    /// is a Phase 4.10 polish item. `row` is the zero-based index of
    /// the OFFENDING row (the first row whose length differs from
    /// row 0's length).
    #[error("array literal row {row} has {found} cell(s), expected {expected} (matching row 0)")]
    ArrayRowArityMismatch { expected: u32, found: u32, row: u32 },

    /// **W5-98 (Phase 4.7.D):** array literal `{}` — zero rows. Excel
    /// rejects empty arrays (`#VALUE!`); Quantbook v1 rejects at parse
    /// time. (Degenerate arrays from FUNCTIONS like `FILTER` with an
    /// all-false mask are different — those are runtime, not syntax.)
    #[error("empty array literal '{{}}' is not allowed")]
    EmptyArrayLiteral,

    /// **W5-98 (Phase 4.7.D):** array literal cell uses a token that
    /// isn't in the allowed subset (NUMBER / BOOL / STRING /
    /// unary-signed-NUMBER / error literal). Per design § 3.3,
    /// nested cell refs / function calls / nested arrays are NOT
    /// allowed in v1 array literals (Phase 4.10 lifts this).
    #[error("invalid array-cell token in array literal: {got}")]
    InvalidArrayCellToken { got: String },

    /// **W5-112 (Phase 4.8.C):** the bracket content of a structured
    /// reference (e.g. `Sales[...]`) didn't parse against the
    /// structured-ref sub-grammar. `reason` describes what failed
    /// (e.g. "unclosed inner `[`", "unknown special item `#Foo`",
    /// "empty column name").
    #[error("malformed structured reference {table_name}[{bracket_content}]: {reason}")]
    StructuredRefMalformed {
        table_name: String,
        bracket_content: String,
        reason: &'static str,
    },
}

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
        // Audit H3 fix (2026-05-12): track whether we already consumed a `:` so
        // `A:B:C` produces a parse error rather than silently merging spans via
        // build_range's WholeColumn:WholeColumn arm. Excel rejects nested ranges
        // outright. Reset is implicit: each recursive parse_expr call starts fresh,
        // so `(A:B) + (C:D)` (two parenthesized ranges) parses cleanly.
        let mut already_consumed_colon = false;

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
                if already_consumed_colon {
                    return Err(ParseError::InvalidRange {
                        detail: "nested range (e.g. A:B:C) — only one ':' per range; \
                                 parenthesize sub-ranges if needed",
                    });
                }
                self.advance();
                let rhs = self.parse_prefix()?;
                lhs = self.build_range(lhs, rhs)?;
                already_consumed_colon = true;
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

            // **W5-98 (Phase 4.7.D):** error-sigil literal (`#REF!`,
            // `#N/A`, etc.). Lexed by `lex_error_sigil` (W5-97). The
            // parser admits the token as a primary expression in any
            // position a literal would be valid. Common use sites:
            // `=#REF!`, `=IFERROR(SOMETHING(), #N/A)`,
            // `{1, #N/A, 3}` (array — see `parse_array_literal`).
            Token::Error(ev) => Ok(Expr::Error(ev)),

            // **W5-98 (Phase 4.7.D):** array literal `{1, 2; 3, 4}`.
            // Delegates to `parse_array_literal` which enforces:
            //   - non-empty (rejects `{}` with `EmptyArrayLiteral`)
            //   - uniform row arity (rejects `{1, 2; 3}` with
            //     `ArrayRowArityMismatch`)
            //   - restricted cell grammar per design § 3.3 (numbers,
            //     booleans, strings, error literals, unary-signed
            //     numbers — no nested refs / functions / arrays).
            Token::LBrace => self.parse_array_literal(),

            // Identifier — either a function call (if next is `(`) or a name-ref.
            // Phase 2A.1 (2026-05-12): a bare identifier outside a function context
            // emits `Expr::NameRef(name)`. The binder resolves the name against the
            // workbook's `NameTable` at bind time and surfaces `UnresolvedName` if
            // the name isn't registered.
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
                    // Phase 2A.1 (2026-05-12): bare identifier (no LParen) emits
                    // `Expr::NameRef(name)` — a defined-name reference resolved at
                    // bind time against the workbook's NameTable. If the name isn't
                    // registered, the binder returns `BindError::UnresolvedName`.
                    //
                    // This supersedes audit H2's parse-time rejection: the parse
                    // succeeds; the rejection moves to bind time with richer info
                    // (the actual unresolved name in the error variant).
                    //
                    // Built-in function names without parens (e.g. `=AVERAGE`) are
                    // unresolved names too, since there's no NameTable entry for
                    // them. Users get a clear "unresolved name AVERAGE" error
                    // pointing them to `=AVERAGE()`.
                    Ok(Expr::NameRef(canonicalize_function_name(&name)))
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
                        sheet: SheetRef::Current,
                        col,
                        row,
                        abs_col,
                        abs_row,
                    }))
                }
            }

            // BareColumn — `A`, `$AI` etc. Function call if followed by `(`; range
            // anchor if followed by `:` (handled by the infix loop). Otherwise it's a
            // standalone bare-column reference (e.g. inside `=A` — Excel parses this
            // as a 1×N range). Audit L2 fix (2026-05-12): the ql-exec binder REJECTS
            // standalone RangeRef::WholeColumn outside a Function context with
            // BindError::UnsupportedVariant; previous doc claimed scalar evaluator
            // fallback, which is wrong. Phase 4+ FormulaRegion binder handles this
            // by lowering to row-aligned CellRefs.
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
                        sheet: SheetRef::Current,
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
                sheet: SheetRef::Current,
                start_row: row,
                end_row: row,
                abs_start: abs,
                abs_end: abs,
            })),

            // **W5-139 (Phase 4.9.C):** R1C1-style reference token,
            // emitted by `lex_with(.., R1C1, ..)`. Parser folds into
            // an intermediate `Expr::R1C1Ref` carrying both axes
            // verbatim. The binder lowers to `ExprPlan::CellRef`
            // using `BindSite::at_cell` for relative-axis
            // resolution (separate sub-phase). Function-call
            // disambiguation does NOT apply — `R1C1` etc. can never
            // be a function name (Excel disallows function names
            // starting with `R` followed by digit/`C`).
            Token::R1C1Ref { row_axis, col_axis } => Ok(Expr::R1C1Ref {
                sheet: SheetRef::Current,
                row_axis,
                col_axis,
            }),

            // **W5-112 (Phase 4.8.C):** structured reference. Lexer
            // emitted `StructuredRef { table_name, bracket_content }`
            // with the OOXML escapes already resolved. Parse the
            // bracket content against the structured-ref sub-grammar
            // (`parse_structured_ref_spec`).
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                let spec = parse_structured_ref_spec(&table_name, &bracket_content)?;
                Ok(Expr::StructuredRef {
                    table_name: table_name.clone(),
                    spec,
                })
            }

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

            // **W5-89 (Phase 4.6.A part 3):** sheet-qualified reference.
            // Cross-sheet syntax `Sheet!Ref` and `'Sheet name'!Ref`.
            // The lexer emits SheetName/QuotedSheetName + Bang as a
            // two-token sequence; the parser consumes them as the
            // PREFIX of a cell-or-range reference. The inner term must
            // be a CellRef / BareColumn / BareRow / RangeRef shape —
            // anything else is `SheetQualifierFollowedByNonReference`.
            // Recursion: `parse_prefix` returns the FIRST term; range
            // assembly (`A1:B2`) happens in the outer `parse_expr` loop
            // via the `:` infix path.
            Token::SheetName(name) | Token::QuotedSheetName(name) => {
                // Expect Bang next (lexer guarantees this pairing).
                match self.advance() {
                    Some(Token::Bang) => {}
                    Some(other) => {
                        return Err(ParseError::Unexpected {
                            context: "after sheet name",
                            got: format!("{other:?}"),
                        });
                    }
                    None => {
                        return Err(ParseError::DanglingBang {
                            name: name.as_ref().to_owned(),
                        });
                    }
                }
                // Special-case: bare `Sheet!` with end-of-input or a
                // non-reference token. Surface as DanglingBang for
                // clarity (vs the generic "unexpected end" / "unexpected
                // token" the recursive call would emit).
                if self.peek().is_none() {
                    return Err(ParseError::DanglingBang {
                        name: name.as_ref().to_owned(),
                    });
                }
                let inner = self.parse_prefix()?;
                Ok(apply_sheet_to_term(inner, name)?)
            }

            // Bare `!` without a preceding sheet name. The lexer doesn't
            // emit `Token::Bang` outside the sheet-prefix sequence (it's
            // only emitted via `try_lex_sheet_name_prefix` /
            // `lex_quoted_sheet_name`), so reaching this arm means the
            // user wrote `Sheet1!Sheet2!Foo` and our outer recursion
            // ended up here. Reject explicitly as DoubleSheetQualifier
            // — the more specific error than the generic "unexpected
            // token" the wildcard would surface.
            Token::Bang => Err(ParseError::DoubleSheetQualifier),

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

    /// **W5-98 (Phase 4.7.D):** parse an array literal `{...}`.
    /// Caller has already consumed the opening `LBrace`. Consumes
    /// through the closing `RBrace`.
    ///
    /// Grammar (design § 3.1):
    /// ```text
    /// array_literal := '{' array_row (';' array_row)* '}'
    /// array_row    := array_cell (',' array_cell)*
    /// array_cell   := number | string | bool | error_lit | unary_signed_number
    /// ```
    ///
    /// Errors:
    /// - `EmptyArrayLiteral` — `{}` (zero rows).
    /// - `ArrayRowArityMismatch` — row N has different cell count than row 0.
    /// - `InvalidArrayCellToken` — token not in the v1 restricted cell grammar.
    /// - `UnclosedDelimiter { what: "{" }` — end-of-input before `}`.
    fn parse_array_literal(&mut self) -> Result<Expr, ParseError> {
        // Immediate close — empty literal. Reject.
        if matches!(self.peek(), Some(Token::RBrace)) {
            self.advance();
            return Err(ParseError::EmptyArrayLiteral);
        }
        let mut rows: Vec<Vec<Expr>> = Vec::new();
        let mut expected_arity: Option<u32> = None;
        loop {
            // Parse one row.
            let mut row: Vec<Expr> = Vec::new();
            // Each row has at least one cell (we just checked we're not
            // at RBrace; subsequent rows are entered after a Semicolon).
            row.push(self.parse_array_cell()?);
            while let Some(Token::Comma) = self.peek() {
                self.advance();
                row.push(self.parse_array_cell()?);
            }
            // Arity check.
            let row_arity = row.len() as u32;
            match expected_arity {
                None => expected_arity = Some(row_arity),
                Some(expected) if expected != row_arity => {
                    return Err(ParseError::ArrayRowArityMismatch {
                        expected,
                        found: row_arity,
                        row: rows.len() as u32,
                    });
                }
                _ => {}
            }
            rows.push(row);
            // Next: either `;` (more rows), `}` (end), or error.
            match self.advance() {
                Some(Token::Semicolon) => continue,
                Some(Token::RBrace) => return Ok(Expr::Array(rows)),
                Some(other) => {
                    return Err(ParseError::Unexpected {
                        context: "array literal",
                        got: format!("{other:?}"),
                    });
                }
                None => return Err(ParseError::UnclosedDelimiter { what: "{" }),
            }
        }
    }

    /// **W5-98 (Phase 4.7.D):** parse a single array cell per the
    /// restricted v1 grammar (design § 3.3). Allowed tokens:
    /// - `Token::Number(n)` → `Expr::Number(n)`
    /// - `Token::String(s)` → `Expr::String(s)`
    /// - `Token::Op(Plus|Minus)` + `Token::Number(n)` → folded literal
    /// - `Token::Ident("TRUE"|"FALSE")` → `Expr::Bool`
    /// - `Token::Error(ev)` → `Expr::Error(ev)`
    ///
    /// Anything else (CellRef, BareColumn, BareRow, LParen, LBrace, etc.)
    /// surfaces as `InvalidArrayCellToken`. The binder is the second
    /// line of defense — see `BindError::ArrayRowArityMismatch` for the
    /// matching binder rule in W5-100 (Phase 4.7.F).
    fn parse_array_cell(&mut self) -> Result<Expr, ParseError> {
        let token = self.advance().ok_or(ParseError::UnexpectedEnd {
            context: "array cell",
        })?;
        match token {
            Token::Number(n) => Ok(Expr::Number(n)),
            Token::String(s) => Ok(Expr::String(s)),
            Token::Error(ev) => Ok(Expr::Error(ev)),
            // Unary-signed number: peek for Number; only allow at the
            // immediate next position (no `--5` chains).
            Token::Op(Operator::Minus) => match self.advance() {
                Some(Token::Number(n)) => Ok(Expr::Number(-n)),
                Some(other) => Err(ParseError::InvalidArrayCellToken {
                    got: format!("Op(Minus) followed by {other:?}"),
                }),
                None => Err(ParseError::UnexpectedEnd {
                    context: "array cell after '-'",
                }),
            },
            Token::Op(Operator::Plus) => match self.advance() {
                Some(Token::Number(n)) => Ok(Expr::Number(n)),
                Some(other) => Err(ParseError::InvalidArrayCellToken {
                    got: format!("Op(Plus) followed by {other:?}"),
                }),
                None => Err(ParseError::UnexpectedEnd {
                    context: "array cell after '+'",
                }),
            },
            // TRUE / FALSE come through as `Token::Ident(_)` (4+ letters).
            Token::Ident(name) => {
                let upper = name.to_ascii_uppercase();
                if upper == "TRUE" {
                    Ok(Expr::Bool(true))
                } else if upper == "FALSE" {
                    Ok(Expr::Bool(false))
                } else {
                    Err(ParseError::InvalidArrayCellToken {
                        got: format!("Ident({name:?})"),
                    })
                }
            }
            other => Err(ParseError::InvalidArrayCellToken {
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
        // **W5-89 (Phase 4.6.A part 3):** merge sheet refs across the
        // range endpoints. Same-sheet, redundant-explicit, and prefix-
        // on-LHS-only cases collapse to a single SheetRef; mixed-sheet
        // endpoints reject. See `merge_sheet_refs` for the policy.
        let merged_sheet = merge_sheet_refs(&sheet_of_term(&lhs), &sheet_of_term(&rhs))?;
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
                    sheet: merged_sheet.clone(),
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
                    sheet: merged_sheet.clone(),
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
                    sheet: merged_sheet,
                    start_row: lo,
                    end_row: hi,
                    abs_start,
                    abs_end,
                }))
            }
            // **W5-139 (Phase 4.9.C):** R1C1 endpoint pair —
            // `R1C1:R10C5`, `R[1]C[1]:R[5]C[5]`, etc. Mixed-
            // relativity (one endpoint absolute, the other relative)
            // is REJECTED per design § 3.1 (closes Codex MEDIUM +
            // Sonnet H-4): the rule is per-axis, so the row axis of
            // both endpoints must agree in relativity, and the col
            // axis must independently agree. Cross-form mixing
            // (R1C1Ref vs CellRef) is rejected via the generic
            // `InvalidRange` arm below.
            (
                Expr::R1C1Ref {
                    sheet: a_sheet,
                    row_axis: a_row,
                    col_axis: a_col,
                },
                Expr::R1C1Ref {
                    sheet: _b_sheet,
                    row_axis: b_row,
                    col_axis: b_col,
                },
            ) => {
                if !axis_relativity_matches(&a_row, &b_row)
                    || !axis_relativity_matches(&a_col, &b_col)
                {
                    return Err(ParseError::R1C1MixedRelativity);
                }
                // Note: unlike A1 ranges, R1C1 ranges do NOT sort
                // start ≤ end here — relative offsets can't be
                // ordered against absolute coords until the binder
                // resolves both against an anchor. Normalization
                // happens post-bind. `merged_sheet` already
                // collapses sheet refs via `merge_sheet_refs`.
                let _ = a_sheet; // sheet info captured in merged_sheet
                Ok(Expr::RangeRef(RangeRef::R1C1Cells {
                    sheet: merged_sheet,
                    start_row: a_row,
                    start_col: a_col,
                    end_row: b_row,
                    end_col: b_col,
                }))
            }
            _ => Err(ParseError::InvalidRange {
                detail: "mixed CellRef/Column/Row range operands (e.g. A1:B); Phase 0 only allows matching types",
            }),
        }
    }
}

/// **W5-139 (Phase 4.9.C):** for R1C1 range endpoints, returns true
/// when both axes are absolute or both axes are relative. Mixed
/// (one abs, one rel) is the case `build_range` rejects with
/// `ParseError::R1C1MixedRelativity`. Per-axis check — row and col
/// are evaluated independently by the caller.
fn axis_relativity_matches(a: &AxisSpec, b: &AxisSpec) -> bool {
    matches!(
        (a, b),
        (AxisSpec::Abs(_), AxisSpec::Abs(_)) | (AxisSpec::Rel(_), AxisSpec::Rel(_))
    )
}

/// **W5-89 (Phase 4.6.A part 3):** attach a sheet name from `Sheet!Ref`
/// syntax to the inner reference term. The inner term must be a
/// reference shape (CellRef / RangeRef::*). Anything else is a parse
/// error. If the inner reference already has a non-`Current` sheet,
/// that's `DoubleSheetQualifier` (`Sheet1!Sheet2!X`).
fn apply_sheet_to_term(expr: Expr, name: Arc<str>) -> Result<Expr, ParseError> {
    // **W5-89:** `Sheet1!5:10` — the lexer emits `Number(5)` for bare
    // digits. The whole-row range conversion happens in `build_range`
    // when the `:` infix triggers. Up-front, we convert here so the
    // sheet prefix attaches to the resulting `WholeRow` singleton (and
    // the subsequent range merge keeps the prefix). Non-Number Exprs
    // pass through unchanged.
    let expr = if matches!(expr, Expr::Number(_)) {
        number_to_bare_row(expr)?
    } else {
        expr
    };
    match expr {
        Expr::CellRef(addr) => {
            if !matches!(addr.sheet, SheetRef::Current) {
                return Err(ParseError::DoubleSheetQualifier);
            }
            Ok(Expr::CellRef(CellAddr {
                sheet: SheetRef::Name(name),
                ..addr
            }))
        }
        Expr::RangeRef(r) => {
            let updated = match r {
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
                    if !matches!(sheet, SheetRef::Current) {
                        return Err(ParseError::DoubleSheetQualifier);
                    }
                    RangeRef::Cells {
                        sheet: SheetRef::Name(name),
                        start_col,
                        start_row,
                        end_col,
                        end_row,
                        abs_start_col,
                        abs_start_row,
                        abs_end_col,
                        abs_end_row,
                    }
                }
                RangeRef::WholeColumn {
                    sheet,
                    start_col,
                    end_col,
                    abs_start,
                    abs_end,
                } => {
                    if !matches!(sheet, SheetRef::Current) {
                        return Err(ParseError::DoubleSheetQualifier);
                    }
                    RangeRef::WholeColumn {
                        sheet: SheetRef::Name(name),
                        start_col,
                        end_col,
                        abs_start,
                        abs_end,
                    }
                }
                RangeRef::WholeRow {
                    sheet,
                    start_row,
                    end_row,
                    abs_start,
                    abs_end,
                } => {
                    if !matches!(sheet, SheetRef::Current) {
                        return Err(ParseError::DoubleSheetQualifier);
                    }
                    RangeRef::WholeRow {
                        sheet: SheetRef::Name(name),
                        start_row,
                        end_row,
                        abs_start,
                        abs_end,
                    }
                }
                // **W5-139 (Phase 4.9.C):** intermediate R1C1 range — same
                // treatment as the absolute-form ranges: refuse a second
                // qualifier, otherwise stamp the sheet name in.
                RangeRef::R1C1Cells {
                    sheet,
                    start_row,
                    start_col,
                    end_row,
                    end_col,
                } => {
                    if !matches!(sheet, SheetRef::Current) {
                        return Err(ParseError::DoubleSheetQualifier);
                    }
                    RangeRef::R1C1Cells {
                        sheet: SheetRef::Name(name),
                        start_row,
                        start_col,
                        end_row,
                        end_col,
                    }
                }
            };
            Ok(Expr::RangeRef(updated))
        }
        // **W5-139 (Phase 4.9.C):** intermediate R1C1 single ref —
        // same treatment as `Expr::CellRef`.
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => {
            if !matches!(sheet, SheetRef::Current) {
                return Err(ParseError::DoubleSheetQualifier);
            }
            Ok(Expr::R1C1Ref {
                sheet: SheetRef::Name(name),
                row_axis,
                col_axis,
            })
        }
        other => Err(ParseError::SheetQualifierFollowedByNonReference {
            got: format!("{other:?}"),
        }),
    }
}

/// **W5-89 (Phase 4.6.A part 3):** merge two endpoint `SheetRef`s for
/// range construction per design § 10.5:
///
/// - `(Current, Current)` → `Current` (same-sheet range).
/// - `(Name(N), Current)` → `Name(N)` (prefix applies to whole range).
/// - `(Current, Name(_))` → `MixedSheetRangeEndpoints` (Excel requires
///   the prefix at the start, not on the trailing endpoint).
/// - `(Name(A), Name(B))` with `A != B` (case-insensitive) →
///   `MixedSheetRangeEndpoints`.
/// - `(Name(A), Name(A))` → `Name(A)` (redundant explicit form,
///   normalized to single-prefix).
/// - `Id` variants are produced post-bind / by tests; treated symmetrically.
fn merge_sheet_refs(lhs: &SheetRef, rhs: &SheetRef) -> Result<SheetRef, ParseError> {
    match (lhs, rhs) {
        (SheetRef::Current, SheetRef::Current) => Ok(SheetRef::Current),
        (SheetRef::Name(n), SheetRef::Current) => Ok(SheetRef::Name(n.clone())),
        (SheetRef::Id(s), SheetRef::Current) => Ok(SheetRef::Id(*s)),
        (SheetRef::Current, SheetRef::Name(_) | SheetRef::Id(_)) => {
            Err(ParseError::MixedSheetRangeEndpoints)
        }
        (SheetRef::Name(a), SheetRef::Name(b)) => {
            if a.eq_ignore_ascii_case(b.as_ref()) {
                Ok(SheetRef::Name(a.clone()))
            } else {
                Err(ParseError::MixedSheetRangeEndpoints)
            }
        }
        (SheetRef::Id(a), SheetRef::Id(b)) if a == b => Ok(SheetRef::Id(*a)),
        // Cross-variant mismatch (Name vs Id) or different Id values.
        _ => Err(ParseError::MixedSheetRangeEndpoints),
    }
}

/// **W5-89 (Phase 4.6.A part 3):** extract the `SheetRef` field from
/// a reference-shaped Expr. Returns `Current` for non-reference shapes
/// so the caller's pattern-match logic stays clean (those branches
/// fail earlier with type-mismatch errors anyway).
fn sheet_of_term(expr: &Expr) -> SheetRef {
    match expr {
        Expr::CellRef(addr) => addr.sheet.clone(),
        Expr::RangeRef(RangeRef::Cells { sheet, .. })
        | Expr::RangeRef(RangeRef::WholeColumn { sheet, .. })
        | Expr::RangeRef(RangeRef::WholeRow { sheet, .. })
        | Expr::RangeRef(RangeRef::R1C1Cells { sheet, .. }) => sheet.clone(),
        // **W5-139 (Phase 4.9.C):** intermediate R1C1 single ref.
        Expr::R1C1Ref { sheet, .. } => sheet.clone(),
        _ => SheetRef::Current,
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
            sheet: SheetRef::Current,
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

// ===== W5-112 (Phase 4.8.C / 4.8.D): structured-reference sub-grammar =====

/// Parse the bracket content of a structured reference (e.g. `Sales[...]`)
/// against the spec sub-grammar (design § 6.3). `bracket_content`
/// PRESERVES OOXML `'`-prefix escapes per design § 5.1 (post-4.8.D
/// refactor); this function resolves escapes structurally.
///
/// Top-level shape decision (in order):
/// 1. Content starts with `@` (UNESCAPED) → `ThisRowColumn` or
///    `ThisRowColumnRange`.
/// 2. Content starts with `[` (UNESCAPED) → `Combination` (one or more
///    items separated by `,`, possibly with whitespace).
/// 3. Otherwise (escape-prefixed first char, or bare identifier) →
///    `BareColumn` (with escape resolution applied to the name).
fn parse_structured_ref_spec(
    table_name: &str,
    bracket_content: &str,
) -> Result<crate::ast::TableSpecSubtree, ParseError> {
    let trimmed = bracket_content.trim();
    if trimmed.is_empty() {
        return Err(ParseError::StructuredRefMalformed {
            table_name: table_name.to_owned(),
            bracket_content: bracket_content.to_owned(),
            reason: "empty bracket content",
        });
    }

    // Peek at the FIRST syntactic char (skipping over a leading `'X`
    // escape pair, since the escaped char is literal). We don't ACTUALLY
    // advance; we just discriminate the parse path.
    let first_syntactic_byte = trimmed.as_bytes().first().copied();
    let starts_with_unescaped_at = first_syntactic_byte == Some(b'@');
    let starts_with_unescaped_open_bracket = first_syntactic_byte == Some(b'[');

    let mut cursor = SrefCursor::new(trimmed);

    if starts_with_unescaped_at {
        cursor.advance();
        parse_sref_thisrow(table_name, bracket_content, &mut cursor)
    } else if starts_with_unescaped_open_bracket {
        parse_sref_combination(table_name, bracket_content, &mut cursor)
    } else {
        // Bare column shorthand. Whole remaining content is the column
        // name; resolve OOXML escapes.
        let name = unescape_sref_str(trimmed);
        if name.is_empty() {
            return Err(ParseError::StructuredRefMalformed {
                table_name: table_name.to_owned(),
                bracket_content: bracket_content.to_owned(),
                reason: "empty bare column name",
            });
        }
        Ok(crate::ast::TableSpecSubtree::BareColumn(Arc::from(
            name.as_str(),
        )))
    }
}

/// **W5-113 (Phase 4.8.D):** resolve OOXML `'X` escape pairs to literal
/// `X` in a structured-ref content fragment. Per design § 5.4 the 5
/// recognized escapes are `'[`, `']`, `'#`, `'@`, `''`; we apply the
/// rule generically (any `'X` resolves to `X`), matching the lexer's
/// balancer semantic.
fn unescape_sref_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\'' {
            // The lexer already guaranteed an escape pair always has
            // a following char (`DanglingStructuredRefEscape` otherwise).
            // Defensive: if absent here, drop the `'`.
            if let Some(escaped) = chars.next() {
                out.push(escaped);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Lightweight char cursor over a structured-ref bracket content string.
struct SrefCursor<'a> {
    rest: &'a str,
}

impl<'a> SrefCursor<'a> {
    fn new(s: &'a str) -> Self {
        Self { rest: s }
    }
    fn peek(&self) -> Option<char> {
        self.rest.chars().next()
    }
    fn advance(&mut self) {
        if let Some(c) = self.rest.chars().next() {
            self.rest = &self.rest[c.len_utf8()..];
        }
    }
    fn skip_ws(&mut self) {
        self.rest = self.rest.trim_start();
    }
    fn remaining_trimmed(&self) -> &'a str {
        self.rest.trim()
    }
    fn is_empty(&self) -> bool {
        self.rest.is_empty()
    }

    /// Consume a `[...]` group (without leading `[`-consumption — caller
    /// already consumed the `[`). Returns the inner string PRESERVING
    /// OOXML escapes (caller resolves them via `unescape_sref_str`).
    /// The inner `]` is consumed.
    ///
    /// **4.8.D refactor:** escape-aware traversal. A `'X` 2-char atom
    /// is skipped together (so an escaped `]` doesn't close the group).
    fn consume_bracket_group(&mut self) -> Result<&'a str, &'static str> {
        let mut depth: u32 = 1;
        let mut end_byte: Option<usize> = None;
        let bytes = self.rest.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'\'' {
                // Skip the 2-char escape atom together. (UTF-8: only ASCII
                // chars are in the escape set, so byte-offset += 2 works.)
                i += 2;
                continue;
            }
            match b {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        end_byte = Some(i);
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        let end = end_byte.ok_or("unclosed `[` inside structured-ref content")?;
        let inner = &self.rest[..end];
        self.rest = &self.rest[end + 1..];
        Ok(inner.trim())
    }
}

/// Parse the `@...` ThisRow shorthand (caller already consumed the `@`).
/// Column names are unescaped via `unescape_sref_str`.
fn parse_sref_thisrow(
    table_name: &str,
    bracket_content: &str,
    cursor: &mut SrefCursor<'_>,
) -> Result<crate::ast::TableSpecSubtree, ParseError> {
    cursor.skip_ws();
    let malformed = |reason: &'static str| ParseError::StructuredRefMalformed {
        table_name: table_name.to_owned(),
        bracket_content: bracket_content.to_owned(),
        reason,
    };

    // `@Col` (no inner brackets) — single column.
    if cursor.peek() != Some('[') {
        let raw = cursor.remaining_trimmed();
        if raw.is_empty() {
            return Err(malformed("empty column name after `@`"));
        }
        let name = unescape_sref_str(raw);
        return Ok(crate::ast::TableSpecSubtree::ThisRowColumn(Arc::from(
            name.as_str(),
        )));
    }

    // `@[Col]` or `@[Col1]:[Col2]` — bracketed forms.
    cursor.advance(); // consume `[`
    let first_raw = cursor
        .consume_bracket_group()
        .map_err(|_| malformed("unclosed `[` after `@`"))?;
    if first_raw.is_empty() {
        return Err(malformed("empty column name inside `@[...]`"));
    }
    let first = unescape_sref_str(first_raw);
    cursor.skip_ws();
    if cursor.is_empty() {
        return Ok(crate::ast::TableSpecSubtree::ThisRowColumn(Arc::from(
            first.as_str(),
        )));
    }
    // Expect `:[Col2]`.
    if cursor.peek() != Some(':') {
        return Err(malformed("expected `:` or end after `@[Col]`"));
    }
    cursor.advance(); // `:`
    cursor.skip_ws();
    if cursor.peek() != Some('[') {
        return Err(malformed("expected `[Col]` after `@[...]:` "));
    }
    cursor.advance(); // `[`
    let second_raw = cursor
        .consume_bracket_group()
        .map_err(|_| malformed("unclosed `[` in `@[Col1]:[Col2]`"))?;
    if second_raw.is_empty() {
        return Err(malformed("empty second column in `@[Col1]:[Col2]`"));
    }
    let second = unescape_sref_str(second_raw);
    cursor.skip_ws();
    if !cursor.is_empty() {
        return Err(malformed("trailing content after `@[Col1]:[Col2]`"));
    }
    Ok(crate::ast::TableSpecSubtree::ThisRowColumnRange(
        Arc::from(first.as_str()),
        Arc::from(second.as_str()),
    ))
}

/// Parse a `Combination` — one or more `[item]` (or `[Col1]:[Col2]`)
/// separated by `,`. Caller has NOT yet consumed the first `[`.
fn parse_sref_combination(
    table_name: &str,
    bracket_content: &str,
    cursor: &mut SrefCursor<'_>,
) -> Result<crate::ast::TableSpecSubtree, ParseError> {
    let malformed = |reason: &'static str| ParseError::StructuredRefMalformed {
        table_name: table_name.to_owned(),
        bracket_content: bracket_content.to_owned(),
        reason,
    };

    let mut items: Vec<crate::ast::TableSpecItem> = Vec::new();
    loop {
        cursor.skip_ws();
        if cursor.peek() != Some('[') {
            return Err(malformed("expected `[` to open structured-ref item"));
        }
        cursor.advance();
        let inner = cursor
            .consume_bracket_group()
            .map_err(|_| malformed("unclosed `[` inside Combination item"))?;
        let item = classify_sref_item(table_name, bracket_content, inner)?;

        // After this item, peek for `:` (column range) or `,` (next item) or end.
        cursor.skip_ws();
        if cursor.peek() == Some(':') {
            // Column range: only valid if the just-parsed item is a Column.
            cursor.advance();
            cursor.skip_ws();
            if cursor.peek() != Some('[') {
                return Err(malformed("expected `[Col2]` after `:` in column range"));
            }
            cursor.advance();
            let inner2 = cursor
                .consume_bracket_group()
                .map_err(|_| malformed("unclosed `[` in `[Col1]:[Col2]`"))?;
            let item2 = classify_sref_item(table_name, bracket_content, inner2)?;
            match (item, item2) {
                (crate::ast::TableSpecItem::Column(c1), crate::ast::TableSpecItem::Column(c2)) => {
                    items.push(crate::ast::TableSpecItem::ColumnRange(c1, c2));
                }
                _ => {
                    return Err(malformed(
                        "`:` between non-column items in structured ref (only `[Col]:[Col]` is valid)",
                    ));
                }
            }
        } else {
            items.push(item);
        }

        cursor.skip_ws();
        match cursor.peek() {
            Some(',') => {
                cursor.advance();
                continue;
            }
            None => break,
            _ => return Err(malformed("expected `,` or end after structured-ref item")),
        }
    }

    Ok(crate::ast::TableSpecSubtree::Combination(items))
}

/// Classify the inner content of a `[item]` against the 3 item shapes:
/// `Special(item)`, `Column(name)`, or (caller handles ColumnRange).
/// Column names are unescaped via `unescape_sref_str`; a leading `'#`
/// in the raw input is a literal `#` in the column name (NOT a special
/// item).
fn classify_sref_item(
    table_name: &str,
    bracket_content: &str,
    inner_raw: &str,
) -> Result<crate::ast::TableSpecItem, ParseError> {
    let trimmed_raw = inner_raw.trim();
    if trimmed_raw.is_empty() {
        return Err(ParseError::StructuredRefMalformed {
            table_name: table_name.to_owned(),
            bracket_content: bracket_content.to_owned(),
            reason: "empty `[]` item in structured ref",
        });
    }
    // Check whether the first char is an UNESCAPED `#`. A leading `'`
    // means the `#` (or any other char) is literal.
    let starts_with_unescaped_hash = trimmed_raw.starts_with('#');
    if starts_with_unescaped_hash {
        // Special item: take the substring after `#`, unescape it, and
        // match the special item set case-insensitively.
        let after_hash = &trimmed_raw[1..];
        let rest = unescape_sref_str(after_hash.trim());
        let special = match rest.to_ascii_uppercase().as_str() {
            "HEADERS" => crate::ast::SpecialItem::Headers,
            "TOTALS" => crate::ast::SpecialItem::Totals,
            "DATA" => crate::ast::SpecialItem::Data,
            "ALL" => crate::ast::SpecialItem::All,
            "THIS ROW" => crate::ast::SpecialItem::ThisRow,
            _ => {
                return Err(ParseError::StructuredRefMalformed {
                    table_name: table_name.to_owned(),
                    bracket_content: bracket_content.to_owned(),
                    reason: "unknown special item — supported: #Headers, #Totals, #Data, #All, #This Row",
                });
            }
        };
        Ok(crate::ast::TableSpecItem::Special(special))
    } else {
        // Column name. Unescape so a literal `'#Foo` becomes `#Foo`.
        let name = unescape_sref_str(trimmed_raw);
        Ok(crate::ast::TableSpecItem::Column(Arc::from(name.as_str())))
    }
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

    /// Phase 2A.5 (2026-05-12): dotted identifiers like `VAR.S` lex as a single
    /// `Token::Ident("VAR.S")` and parse as a function call when followed by `(`.
    /// Pin the parser end of the pipeline so the lexer change can't quietly
    /// regress into a CellRef + Number pattern downstream.
    #[test]
    fn parse_dotted_function_name() {
        match p("VAR.S(1, 2, 3)") {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "VAR.S");
                assert_eq!(args.len(), 3);
            }
            other => panic!("VAR.S(...) should parse as a function call, got {other:?}"),
        }
        match p("var.s(1, 2)") {
            Expr::Function { name, .. } => assert_eq!(name.as_ref(), "VAR.S"),
            other => panic!("var.s lowercase canonicalizes to VAR.S, got {other:?}"),
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

    /// Phase 2A.1 (2026-05-12): bare identifier (no LParen following) now emits
    /// `Expr::NameRef(name)` — a defined-name reference to be resolved at bind time
    /// against the workbook's `NameTable`. Unresolved names surface as
    /// `BindError::UnresolvedName` (the binder's responsibility, not the parser's).
    ///
    /// Supersedes audit H2 (W5-7), which made these a parse error. The H2 bug was that
    /// bare identifiers silently emitted `Function { args: vec![] }`; the W5-7 fix made
    /// them a hard parse error pending Phase 2's NameRef design. Phase 2A.1 completes
    /// the original intent: parse → NameRef → binder resolves or errors.
    ///
    /// TRUE / FALSE remain explicit exceptions (boolean literals).
    ///
    /// Only tested on 4+ letter names — 1-3 letter names lex as `BareColumn` (since
    /// they're valid Excel column references) and follow a different parser path.
    #[test]
    fn parse_bare_identifier_function_name_to_name_ref() {
        // 4+ letter built-in function names without parens parse as NameRef. The
        // binder will (correctly) refuse to resolve these because no name has been
        // defined for them — but that's a bind-time concern, not a parse-time one.
        // Names are canonicalized to upper-case at parse time.
        for src in ["AVERAGE", "IFERROR", "POWER", "SQRT"] {
            match p(src) {
                Expr::NameRef(name) => assert_eq!(
                    name.as_ref(),
                    src.to_ascii_uppercase().as_str(),
                    "expected NameRef({src:?}) canonicalized to upper-case, got {name:?}"
                ),
                other => panic!("expected Expr::NameRef for {src:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn parse_bare_identifier_unknown_name_to_name_ref() {
        // 4+ letter user-defined names parse as NameRef. Resolution happens at bind
        // time against the workbook's NameTable; unresolved names surface as
        // `BindError::UnresolvedName` in ql-exec (not tested here — see ql-exec tests).
        for src in ["MyDefinedName", "UnknownThing"] {
            match p(src) {
                Expr::NameRef(name) => assert_eq!(
                    name.as_ref(),
                    src.to_ascii_uppercase().as_str(),
                    "expected NameRef({src:?}) canonicalized to upper-case, got {name:?}"
                ),
                other => panic!("expected Expr::NameRef for {src:?}, got {other:?}"),
            }
        }
    }

    /// Audit H3 regression (2026-05-12): `A:B:C` used to silently merge into A:C via
    /// the WholeColumn:WholeColumn arm of build_range, dropping B. Excel rejects
    /// nested ranges. Now: parse error.
    #[test]
    fn parse_nested_range_errors() {
        // Three bare columns chained.
        assert!(matches!(perr("A:B:C"), ParseError::InvalidRange { .. }));
        // Three cell refs chained.
        assert!(matches!(perr("A1:B1:C1"), ParseError::InvalidRange { .. }));
        // Three rows chained.
        assert!(matches!(perr("1:2:3"), ParseError::InvalidRange { .. }));
    }

    #[test]
    fn parse_parenthesized_range_pair_ok() {
        // Two separate ranges joined by an operator MUST still parse (each :
        // appears in its own parse_expr recursion level). The `already_consumed_colon`
        // tracking resets on recursion.
        let e = p("(A:A) + (B:B)");
        // Top is binary plus; both operands are ranges.
        assert!(matches!(
            e,
            Expr::Binary {
                op: Operator::Plus,
                ..
            }
        ));
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

    // ===== W5-89 / Phase 4.6.A part 3 — cross-sheet parser =====

    fn parse_ok(src: &str) -> Expr {
        let toks = crate::lex(src).unwrap_or_else(|e| panic!("lex({src:?}) failed: {e}"));
        parse(toks).unwrap_or_else(|e| panic!("parse({src:?}) failed: {e}"))
    }

    fn parse_err(src: &str) -> ParseError {
        let toks = crate::lex(src).unwrap_or_else(|e| panic!("lex({src:?}) failed: {e}"));
        parse(toks).unwrap_err()
    }

    #[test]
    fn parse_sheet_qualified_cellref_unquoted() {
        let expr = parse_ok("Sheet1!A1");
        match expr {
            Expr::CellRef(addr) => {
                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet1")));
                assert_eq!(addr.col, 0);
                assert_eq!(addr.row, 0);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_cellref_quoted() {
        let expr = parse_ok("'Q3 2025'!B5");
        match expr {
            Expr::CellRef(addr) => {
                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Q3 2025")));
                assert_eq!(addr.col, 1);
                assert_eq!(addr.row, 4);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_quoted_with_escape() {
        let expr = parse_ok("'Ben''s Sheet'!A1");
        match expr {
            Expr::CellRef(addr) => {
                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Ben's Sheet")));
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_range_single_prefix() {
        // Excel-canon: `Sheet1!A1:B2` applies the prefix to the whole range.
        let expr = parse_ok("Sheet1!A1:B2");
        match expr {
            Expr::RangeRef(RangeRef::Cells {
                sheet,
                start_col,
                start_row,
                end_col,
                end_row,
                ..
            }) => {
                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
                assert_eq!((start_col, start_row, end_col, end_row), (0, 0, 1, 1));
            }
            other => panic!("expected RangeRef::Cells, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_range_redundant_explicit_form_normalizes() {
        // `Sheet1!A1:Sheet1!B2` is the redundant explicit form. Both endpoints
        // resolve to the same sheet; result normalizes to single-prefix.
        let expr = parse_ok("Sheet1!A1:Sheet1!B2");
        match expr {
            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
            }
            other => panic!("expected RangeRef::Cells, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_redundant_form_case_insensitive() {
        // `Sheet1!A1:sheet1!B2` — same canonical name, different case.
        // Should normalize without erroring.
        let expr = parse_ok("Sheet1!A1:sheet1!B2");
        match expr {
            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
                assert!(matches!(sheet, SheetRef::Name(_)));
            }
            other => panic!("expected RangeRef::Cells, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_whole_column() {
        let expr = parse_ok("Sheet1!A:A");
        match expr {
            Expr::RangeRef(RangeRef::WholeColumn { sheet, .. }) => {
                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
            }
            other => panic!("expected WholeColumn, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_whole_row() {
        let expr = parse_ok("Sheet1!1:5");
        match expr {
            Expr::RangeRef(RangeRef::WholeRow { sheet, .. }) => {
                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
            }
            other => panic!("expected WholeRow, got {other:?}"),
        }
    }

    #[test]
    fn parse_double_sheet_qualifier_rejected() {
        let err = parse_err("Sheet1!Sheet2!A1");
        assert!(matches!(err, ParseError::DoubleSheetQualifier));
    }

    #[test]
    fn parse_mixed_sheet_range_endpoints_rejected() {
        let err = parse_err("Sheet1!A1:Sheet2!B2");
        assert!(matches!(err, ParseError::MixedSheetRangeEndpoints));
    }

    #[test]
    fn parse_dangling_bang_at_end_of_input() {
        let err = parse_err("Sheet1!");
        match err {
            ParseError::DanglingBang { name } => assert_eq!(name, "Sheet1"),
            other => panic!("expected DanglingBang, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_inside_binary_op() {
        // `Sheet2!A1 + 1` — the prefix only applies to A1, not the whole expr.
        let expr = parse_ok("Sheet2!A1+1");
        match expr {
            Expr::Binary { op, lhs, rhs } => {
                assert_eq!(op, Operator::Plus);
                match lhs.as_ref() {
                    Expr::CellRef(addr) => {
                        assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet2")));
                    }
                    other => panic!("expected CellRef lhs, got {other:?}"),
                }
                assert!(matches!(rhs.as_ref(), Expr::Number(_)));
            }
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_inside_function_arg() {
        // `SUM(Sheet1!A1:A10)` — function arg is a cross-sheet range.
        let expr = parse_ok("SUM(Sheet1!A1:A10)");
        match expr {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 1);
                match &args[0] {
                    Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
                        assert_eq!(sheet, &SheetRef::Name(Arc::from("Sheet1")));
                    }
                    other => panic!("expected Cells RangeRef, got {other:?}"),
                }
            }
            other => panic!("expected Function, got {other:?}"),
        }
    }

    #[test]
    fn parse_unqualified_range_still_works() {
        // Regression guard: same-sheet ranges still parse to SheetRef::Current.
        let expr = parse_ok("A1:B2");
        match expr {
            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
                assert_eq!(sheet, SheetRef::Current);
            }
            other => panic!("expected Cells, got {other:?}"),
        }
    }

    #[test]
    fn parse_sheet_qualified_absolute_ref() {
        // `Sheet1!$A$1` — absolute markers preserved alongside sheet prefix.
        let expr = parse_ok("Sheet1!$A$1");
        match expr {
            Expr::CellRef(addr) => {
                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet1")));
                assert!(addr.abs_col);
                assert!(addr.abs_row);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_dotted_sheet_name() {
        let expr = parse_ok("Data.2024!A1");
        match expr {
            Expr::CellRef(addr) => {
                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Data.2024")));
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    // ===== W5-98 (Phase 4.7.D) — array literals + error literals =====

    #[test]
    fn parse_error_literal_ref() {
        let expr = parse_ok("#REF!");
        assert_eq!(expr, Expr::Error(ql_types::ErrorValue::Ref));
    }

    #[test]
    fn parse_error_literal_na() {
        let expr = parse_ok("#N/A");
        assert_eq!(expr, Expr::Error(ql_types::ErrorValue::NA));
    }

    #[test]
    fn parse_error_literal_inside_function_call() {
        let expr = parse_ok("IFERROR(#REF!, 0)");
        match expr {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "IFERROR");
                assert_eq!(args.len(), 2);
                assert_eq!(args[0], Expr::Error(ql_types::ErrorValue::Ref));
                assert_eq!(args[1], Expr::Number(0.0));
            }
            other => panic!("expected Function, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_1x3() {
        let expr = parse_ok("{1, 2, 3}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].len(), 3);
                assert_eq!(rows[0][0], Expr::Number(1.0));
                assert_eq!(rows[0][1], Expr::Number(2.0));
                assert_eq!(rows[0][2], Expr::Number(3.0));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_3x1() {
        let expr = parse_ok("{1; 2; 3}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows.len(), 3);
                for row in &rows {
                    assert_eq!(row.len(), 1);
                }
                assert_eq!(rows[0][0], Expr::Number(1.0));
                assert_eq!(rows[1][0], Expr::Number(2.0));
                assert_eq!(rows[2][0], Expr::Number(3.0));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_2x2() {
        let expr = parse_ok("{1, 2; 3, 4}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0].len(), 2);
                assert_eq!(rows[1].len(), 2);
                assert_eq!(rows[0][0], Expr::Number(1.0));
                assert_eq!(rows[0][1], Expr::Number(2.0));
                assert_eq!(rows[1][0], Expr::Number(3.0));
                assert_eq!(rows[1][1], Expr::Number(4.0));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_with_bool_string_error_mixed() {
        // Per design § 3.3: array cells allow NUMBER / BOOL / STRING /
        // error literal / unary-signed-NUMBER. This test exercises the
        // full set in one literal.
        let expr = parse_ok("{1, TRUE, \"hi\", #N/A, -5}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows.len(), 1);
                let row = &rows[0];
                assert_eq!(row.len(), 5);
                assert_eq!(row[0], Expr::Number(1.0));
                assert_eq!(row[1], Expr::Bool(true));
                match &row[2] {
                    Expr::String(s) => assert_eq!(s.as_ref(), "hi"),
                    other => panic!("expected String, got {other:?}"),
                }
                assert_eq!(row[3], Expr::Error(ql_types::ErrorValue::NA));
                assert_eq!(row[4], Expr::Number(-5.0));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_with_negative_numbers() {
        let expr = parse_ok("{-1, +2, -3.5}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows[0][0], Expr::Number(-1.0));
                assert_eq!(rows[0][1], Expr::Number(2.0));
                assert_eq!(rows[0][2], Expr::Number(-3.5));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_false_lowercase_bool() {
        let expr = parse_ok("{true, false}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows[0][0], Expr::Bool(true));
                assert_eq!(rows[0][1], Expr::Bool(false));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_arity_mismatch_rejects() {
        let err = parse_err("{1, 2; 3}");
        match err {
            ParseError::ArrayRowArityMismatch {
                expected,
                found,
                row,
            } => {
                assert_eq!(expected, 2);
                assert_eq!(found, 1);
                assert_eq!(row, 1);
            }
            other => panic!("expected ArrayRowArityMismatch, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_empty_rejects() {
        let err = parse_err("{}");
        assert!(matches!(err, ParseError::EmptyArrayLiteral));
    }

    #[test]
    fn parse_array_literal_nested_array_rejects() {
        // Nested arrays not allowed in v1 — `{` is not a valid cell
        // token per the restricted array_cell grammar.
        let err = parse_err("{1, {2, 3}}");
        match err {
            ParseError::InvalidArrayCellToken { got } => {
                assert!(got.contains("LBrace"), "got: {got}");
            }
            other => panic!("expected InvalidArrayCellToken, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_cell_ref_rejects() {
        // Cell references inside array literals are deferred to Phase 4.10.
        let err = parse_err("{A1, B1}");
        // Cell refs lex as either CellRef or BareColumn; either way
        // the array-cell parser rejects them.
        assert!(
            matches!(err, ParseError::InvalidArrayCellToken { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn parse_array_literal_function_call_rejects() {
        // Function calls inside array literals are also rejected — only
        // literals are allowed per design § 3.3.
        let err = parse_err("{SUM(1, 2), 3}");
        assert!(
            matches!(err, ParseError::InvalidArrayCellToken { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn parse_array_literal_unclosed_rejects() {
        let err = parse_err("{1, 2");
        match err {
            ParseError::UnclosedDelimiter { what } => assert_eq!(what, "{"),
            other => panic!("expected UnclosedDelimiter, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_as_function_arg() {
        // `=SUM({1, 2, 3})` — the array literal is a function argument.
        let expr = parse_ok("SUM({1, 2, 3})");
        match expr {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 1);
                match &args[0] {
                    Expr::Array(rows) => assert_eq!(rows[0].len(), 3),
                    other => panic!("expected Array arg, got {other:?}"),
                }
            }
            other => panic!("expected Function, got {other:?}"),
        }
    }

    // W5-98 closure (Sonnet M1 + M3 + L1 + L2 + L3): supplementary
    // tests covering edge cases the original commit missed.

    #[test]
    fn parse_array_literal_singleton_1x1() {
        // L1 — degenerate 1×1 array `{5}`. Valid; parser must NOT
        // confuse this with a `{}` empty-literal rejection.
        let expr = parse_ok("{5}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].len(), 1);
                assert_eq!(rows[0][0], Expr::Number(5.0));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_3x2_three_rows() {
        // M3 — three-row arity check. Exercises the loop bound past
        // the second row (covered by the existing 2x2 test).
        let expr = parse_ok("{1, 2; 3, 4; 5, 6}");
        match expr {
            Expr::Array(rows) => {
                assert_eq!(rows.len(), 3);
                for row in &rows {
                    assert_eq!(row.len(), 2);
                }
                assert_eq!(rows[0][0], Expr::Number(1.0));
                assert_eq!(rows[1][0], Expr::Number(3.0));
                assert_eq!(rows[2][0], Expr::Number(5.0));
                assert_eq!(rows[2][1], Expr::Number(6.0));
            }
            other => panic!("expected Array, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_arity_mismatch_second_row_longer() {
        // M1 — `{1; 2, 3}` second row LONGER than first. The original
        // arity test covered second-row-SHORTER; this covers the
        // opposite direction to catch any directional bias in the
        // arity-check logic.
        let err = parse_err("{1; 2, 3}");
        match err {
            ParseError::ArrayRowArityMismatch {
                expected,
                found,
                row,
            } => {
                assert_eq!(expected, 1);
                assert_eq!(found, 2);
                assert_eq!(row, 1);
            }
            other => panic!("expected ArrayRowArityMismatch, got {other:?}"),
        }
    }

    #[test]
    fn parse_error_literal_as_binary_operand() {
        // L2 — `=1 + #N/A`. Verify the new `Token::Error` primary arm
        // integrates with binary-operator precedence (i.e. is_op
        // dispatch sees the error as a complete primary and applies
        // the `+` correctly).
        let expr = parse_ok("1 + #N/A");
        match expr {
            Expr::Binary { op, lhs, rhs } => {
                assert_eq!(op, Operator::Plus);
                assert_eq!(*lhs, Expr::Number(1.0));
                assert_eq!(*rhs, Expr::Error(ql_types::ErrorValue::NA));
            }
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn parse_array_literal_double_semicolon_rejects() {
        // L3 — `{1;;3}` (double semicolon, missing cell). Document the
        // parser's behavior: after the first `;`, parse_array_cell is
        // called on the second `;`, which is NOT in the allowed cell
        // tokens → InvalidArrayCellToken{got: "Semicolon"}. The user
        // gets a clear "Semicolon not valid as array cell" error.
        let err = parse_err("{1;;3}");
        match err {
            ParseError::InvalidArrayCellToken { got } => {
                assert!(got.contains("Semicolon"), "got: {got}");
            }
            other => panic!("expected InvalidArrayCellToken, got {other:?}"),
        }
    }

    // ===== W5-112 (Phase 4.8.C) — structured references =====

    use crate::ast::{SpecialItem, TableSpecItem, TableSpecSubtree};

    #[test]
    fn parse_structured_ref_bare_column() {
        let expr = parse_ok("Sales[Qty]");
        match expr {
            Expr::StructuredRef { table_name, spec } => {
                assert_eq!(table_name.as_ref(), "Sales");
                assert_eq!(spec, TableSpecSubtree::BareColumn(Arc::from("Qty")));
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_single_column_in_brackets() {
        // `Sales[[Qty]]` — combination with one column.
        let expr = parse_ok("Sales[[Qty]]");
        match expr {
            Expr::StructuredRef { spec, .. } => match spec {
                TableSpecSubtree::Combination(items) => {
                    assert_eq!(items.len(), 1);
                    assert_eq!(items[0], TableSpecItem::Column(Arc::from("Qty")));
                }
                other => panic!("expected Combination, got {other:?}"),
            },
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_special_headers() {
        let expr = parse_ok("Sales[[#Headers]]");
        match expr {
            Expr::StructuredRef { spec, .. } => {
                assert_eq!(
                    spec,
                    TableSpecSubtree::Combination(vec![TableSpecItem::Special(
                        SpecialItem::Headers
                    )])
                );
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_all_5_specifiers() {
        let cases = [
            ("Sales[[#Headers]]", SpecialItem::Headers),
            ("Sales[[#Totals]]", SpecialItem::Totals),
            ("Sales[[#Data]]", SpecialItem::Data),
            ("Sales[[#All]]", SpecialItem::All),
            ("Sales[[#This Row]]", SpecialItem::ThisRow),
        ];
        for (src, expected) in cases {
            let expr = parse_ok(src);
            match expr {
                Expr::StructuredRef { spec, .. } => match spec {
                    TableSpecSubtree::Combination(items) => {
                        assert_eq!(
                            items,
                            vec![TableSpecItem::Special(expected)],
                            "case {src:?}"
                        );
                    }
                    other => panic!("case {src:?}: expected Combination, got {other:?}"),
                },
                other => panic!("case {src:?}: expected StructuredRef, got {other:?}"),
            }
        }
    }

    #[test]
    fn parse_structured_ref_special_column_combination() {
        // `Sales[[#Headers], [Qty]]` — 2-item combination.
        let expr = parse_ok("Sales[[#Headers], [Qty]]");
        match expr {
            Expr::StructuredRef { spec, .. } => {
                assert_eq!(
                    spec,
                    TableSpecSubtree::Combination(vec![
                        TableSpecItem::Special(SpecialItem::Headers),
                        TableSpecItem::Column(Arc::from("Qty")),
                    ])
                );
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_column_range() {
        // `Sales[[Col1]:[Col2]]` — column range item.
        let expr = parse_ok("Sales[[Col1]:[Col2]]");
        match expr {
            Expr::StructuredRef { spec, .. } => {
                assert_eq!(
                    spec,
                    TableSpecSubtree::Combination(vec![TableSpecItem::ColumnRange(
                        Arc::from("Col1"),
                        Arc::from("Col2")
                    )])
                );
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_three_item_combination() {
        // `Sales[[#Data], [#Totals], [Col]]` — multi-item combination
        // (the design § 6.2 Combination(Vec<...>) case driven by Codex
        // HIGH-4 closure).
        let expr = parse_ok("Sales[[#Data], [#Totals], [Col]]");
        match expr {
            Expr::StructuredRef { spec, .. } => {
                assert_eq!(
                    spec,
                    TableSpecSubtree::Combination(vec![
                        TableSpecItem::Special(SpecialItem::Data),
                        TableSpecItem::Special(SpecialItem::Totals),
                        TableSpecItem::Column(Arc::from("Col")),
                    ])
                );
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_at_column_shorthand() {
        // `Sales[@Qty]` — current-row shorthand.
        let expr = parse_ok("Sales[@Qty]");
        match expr {
            Expr::StructuredRef { spec, .. } => {
                assert_eq!(spec, TableSpecSubtree::ThisRowColumn(Arc::from("Qty")));
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_at_bracketed_column() {
        // `Sales[@[Qty]]` — bracketed @-form.
        let expr = parse_ok("Sales[@[Qty]]");
        match expr {
            Expr::StructuredRef { spec, .. } => {
                assert_eq!(spec, TableSpecSubtree::ThisRowColumn(Arc::from("Qty")));
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_at_column_range() {
        // `Sales[@[Col1]:[Col2]]` — current-row range.
        let expr = parse_ok("Sales[@[Col1]:[Col2]]");
        match expr {
            Expr::StructuredRef { spec, .. } => {
                assert_eq!(
                    spec,
                    TableSpecSubtree::ThisRowColumnRange(Arc::from("Col1"), Arc::from("Col2"))
                );
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_unknown_special_errors() {
        // `Sales[[#Foo]]` — `#Foo` is not a recognized special item.
        let err = parse_err("Sales[[#Foo]]");
        match err {
            ParseError::StructuredRefMalformed { reason, .. } => {
                assert!(reason.contains("special"), "reason: {reason}");
            }
            other => panic!("expected StructuredRefMalformed, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_empty_bracket_errors() {
        // `Sales[]` — empty bracket content.
        let err = parse_err("Sales[]");
        match err {
            ParseError::StructuredRefMalformed { reason, .. } => {
                assert!(reason.contains("empty"), "reason: {reason}");
            }
            other => panic!("expected StructuredRefMalformed, got {other:?}"),
        }
    }

    #[test]
    fn parse_structured_ref_sum_of_table_column() {
        // `SUM(Sales[Qty])` — function call with table ref as arg. The
        // critical integration: structured-ref is just a primary expr
        // and slots into argument lists like any other.
        let expr = parse_ok("SUM(Sales[Qty])");
        match expr {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 1);
                match &args[0] {
                    Expr::StructuredRef { table_name, spec } => {
                        assert_eq!(table_name.as_ref(), "Sales");
                        assert_eq!(spec, &TableSpecSubtree::BareColumn(Arc::from("Qty")));
                    }
                    other => panic!("expected StructuredRef arg, got {other:?}"),
                }
            }
            other => panic!("expected Function, got {other:?}"),
        }
    }

    // ===================================================================
    // W5-139 (Phase 4.9.C) — R1C1 parser tests.
    //
    // Tokens come from `lex_with(.., R1C1, EnUs)`. The parser folds
    // `Token::R1C1Ref` → `Expr::R1C1Ref` (single) and
    // `R1C1Ref Colon R1C1Ref` → `Expr::RangeRef(RangeRef::R1C1Cells)`.
    // Mixed-relativity range endpoints reject with
    // `ParseError::R1C1MixedRelativity`. Mixed CellRef/R1C1Ref ranges
    // reject with the existing `ParseError::InvalidRange`.
    // ===================================================================

    use crate::lexer::lex_with;
    use ql_types::{Locale, ReferenceMode};

    fn p_r1c1(src: &str) -> Expr {
        let tokens = lex_with(src, ReferenceMode::R1C1, Locale::EnUs).expect("lex_with R1C1");
        parse(tokens).expect("parse")
    }

    fn perr_r1c1(src: &str) -> ParseError {
        let tokens = lex_with(src, ReferenceMode::R1C1, Locale::EnUs).expect("lex_with R1C1");
        parse(tokens).expect_err("expected parse error")
    }

    /// **Single absolute R1C1 ref** parses to `Expr::R1C1Ref` with
    /// `SheetRef::Current`.
    #[test]
    fn r1c1_parse_absolute_single_ref() {
        match p_r1c1("R3C5") {
            Expr::R1C1Ref {
                sheet,
                row_axis,
                col_axis,
            } => {
                assert!(matches!(sheet, SheetRef::Current));
                assert_eq!(row_axis, AxisSpec::Abs(3));
                assert_eq!(col_axis, AxisSpec::Abs(5));
            }
            other => panic!("expected Expr::R1C1Ref, got {other:?}"),
        }
    }

    /// **Single relative R1C1 ref.** Both axes relative.
    #[test]
    fn r1c1_parse_relative_single_ref() {
        match p_r1c1("R[-1]C[2]") {
            Expr::R1C1Ref {
                row_axis, col_axis, ..
            } => {
                assert_eq!(row_axis, AxisSpec::Rel(-1));
                assert_eq!(col_axis, AxisSpec::Rel(2));
            }
            other => panic!("expected Expr::R1C1Ref, got {other:?}"),
        }
    }

    /// **Bare `RC`** parses with both axes `Rel(0)`.
    #[test]
    fn r1c1_parse_bare_rc_both_axes_rel_zero() {
        match p_r1c1("RC") {
            Expr::R1C1Ref {
                row_axis, col_axis, ..
            } => {
                assert_eq!(row_axis, AxisSpec::Rel(0));
                assert_eq!(col_axis, AxisSpec::Rel(0));
            }
            other => panic!("expected Expr::R1C1Ref, got {other:?}"),
        }
    }

    /// **R1C1 range `R1C1:R10C5`** — both axes absolute on both
    /// endpoints. Builds `RangeRef::R1C1Cells`.
    #[test]
    fn r1c1_parse_range_both_endpoints_absolute() {
        match p_r1c1("R1C1:R10C5") {
            Expr::RangeRef(RangeRef::R1C1Cells {
                sheet,
                start_row,
                start_col,
                end_row,
                end_col,
            }) => {
                assert!(matches!(sheet, SheetRef::Current));
                assert_eq!(start_row, AxisSpec::Abs(1));
                assert_eq!(start_col, AxisSpec::Abs(1));
                assert_eq!(end_row, AxisSpec::Abs(10));
                assert_eq!(end_col, AxisSpec::Abs(5));
            }
            other => panic!("expected RangeRef::R1C1Cells, got {other:?}"),
        }
    }

    /// **R1C1 range `R[1]C[1]:R[5]C[5]`** — both axes relative.
    #[test]
    fn r1c1_parse_range_both_endpoints_relative() {
        match p_r1c1("R[1]C[1]:R[5]C[5]") {
            Expr::RangeRef(RangeRef::R1C1Cells {
                start_row,
                start_col,
                end_row,
                end_col,
                ..
            }) => {
                assert_eq!(start_row, AxisSpec::Rel(1));
                assert_eq!(start_col, AxisSpec::Rel(1));
                assert_eq!(end_row, AxisSpec::Rel(5));
                assert_eq!(end_col, AxisSpec::Rel(5));
            }
            other => panic!("expected RangeRef::R1C1Cells, got {other:?}"),
        }
    }

    /// **Mixed-relativity row axis rejected.** `R1C1:R[10]C5` —
    /// start row Abs, end row Rel.
    #[test]
    fn r1c1_parse_range_mixed_row_relativity_rejected() {
        let err = perr_r1c1("R1C1:R[10]C5");
        assert!(matches!(err, ParseError::R1C1MixedRelativity));
    }

    /// **Mixed-relativity col axis rejected.** `R1C1:R10C[5]` —
    /// start col Abs, end col Rel.
    #[test]
    fn r1c1_parse_range_mixed_col_relativity_rejected() {
        let err = perr_r1c1("R1C1:R10C[5]");
        assert!(matches!(err, ParseError::R1C1MixedRelativity));
    }

    /// **Mixed-relativity both axes rejected.** Sanity that the
    /// per-axis check fires on the first mismatch, not the second.
    #[test]
    fn r1c1_parse_range_mixed_both_axes_rejected() {
        let err = perr_r1c1("R1C1:R[1]C[1]");
        assert!(matches!(err, ParseError::R1C1MixedRelativity));
    }

    /// **Sheet-qualified single R1C1 ref.** `Sheet1!R1C1` → R1C1Ref
    /// with `SheetRef::Name("Sheet1")`.
    #[test]
    fn r1c1_parse_sheet_qualified_single_ref() {
        match p_r1c1("Sheet1!R3C5") {
            Expr::R1C1Ref {
                sheet,
                row_axis,
                col_axis,
            } => {
                match sheet {
                    SheetRef::Name(n) => assert_eq!(n.as_ref(), "Sheet1"),
                    other => panic!("expected SheetRef::Name, got {other:?}"),
                }
                assert_eq!(row_axis, AxisSpec::Abs(3));
                assert_eq!(col_axis, AxisSpec::Abs(5));
            }
            other => panic!("expected Expr::R1C1Ref, got {other:?}"),
        }
    }

    /// **Sheet-qualified R1C1 range.** `Sheet1!R1C1:R10C5` — sheet
    /// prefix applies to whole range; trailing endpoint must NOT
    /// carry a separate prefix (Excel canon).
    #[test]
    fn r1c1_parse_sheet_qualified_range() {
        match p_r1c1("Sheet1!R1C1:R10C5") {
            Expr::RangeRef(RangeRef::R1C1Cells { sheet, .. }) => match sheet {
                SheetRef::Name(n) => assert_eq!(n.as_ref(), "Sheet1"),
                other => panic!("expected SheetRef::Name, got {other:?}"),
            },
            other => panic!("expected RangeRef::R1C1Cells, got {other:?}"),
        }
    }

    /// **Double-sheet on R1C1 rejected.** `Sheet1!Sheet2!R1C1` —
    /// only one sheet prefix allowed.
    #[test]
    fn r1c1_parse_double_sheet_qualifier_rejected() {
        let err = perr_r1c1("Sheet1!Sheet2!R1C1");
        assert!(matches!(err, ParseError::DoubleSheetQualifier));
    }

    /// **Mixed A1+R1C1 endpoints rejected as InvalidRange.** `A1` in
    /// R1C1 mode still lexes as `Token::CellRef`, so the parser may
    /// see `A1:R1C1` — the existing wildcard arm in `build_range`
    /// catches this as `InvalidRange` (not a new error class).
    #[test]
    fn r1c1_parse_mixed_a1_and_r1c1_range_rejected_as_invalid() {
        let err = perr_r1c1("A1:R1C1");
        assert!(matches!(err, ParseError::InvalidRange { .. }));
    }

    /// **R1C1 inside a function call.** `SUM(R1C1, R2C2)` — two R1C1
    /// refs as args, comma-separated. Exercises the function-call
    /// + R1C1 composition.
    #[test]
    fn r1c1_parse_inside_function_call() {
        match p_r1c1("SUM(R1C1,R2C2)") {
            Expr::Function { name, args } => {
                assert_eq!(name.as_ref(), "SUM");
                assert_eq!(args.len(), 2);
                assert!(matches!(args[0], Expr::R1C1Ref { .. }));
                assert!(matches!(args[1], Expr::R1C1Ref { .. }));
            }
            other => panic!("expected Function, got {other:?}"),
        }
    }

    /// **R1C1 inside arithmetic.** `R1C1 + R2C2` — binary op around
    /// two R1C1 refs.
    #[test]
    fn r1c1_parse_inside_binary_op() {
        match p_r1c1("R1C1+R2C2") {
            Expr::Binary { op, lhs, rhs } => {
                assert_eq!(op, Operator::Plus);
                assert!(matches!(*lhs, Expr::R1C1Ref { .. }));
                assert!(matches!(*rhs, Expr::R1C1Ref { .. }));
            }
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    /// **R1C1 unary minus.** `-R1C1` — exercise unary path.
    #[test]
    fn r1c1_parse_unary_minus_in_front_of_r1c1ref() {
        match p_r1c1("-R1C1") {
            Expr::Unary { op, operand } => {
                assert_eq!(op, Operator::Minus);
                assert!(matches!(*operand, Expr::R1C1Ref { .. }));
            }
            other => panic!("expected Unary, got {other:?}"),
        }
    }

    /// **A1 mode parser still works.** Confirms the new R1C1 arms
    /// don't affect the A1 parse path. `A1` (A1 mode) → CellRef.
    #[test]
    fn r1c1_a1_mode_cellref_still_parses_in_a1_mode() {
        match p("A1") {
            Expr::CellRef(addr) => {
                assert_eq!(addr.col, 0);
                assert_eq!(addr.row, 0);
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    /// **R1C1 range nested-colon rejected.** `R1C1:R5C5:R10C10` —
    /// existing nested-range rejection still fires.
    #[test]
    fn r1c1_parse_nested_range_rejected() {
        let err = perr_r1c1("R1C1:R5C5:R10C10");
        assert!(matches!(err, ParseError::InvalidRange { .. }));
    }

    /// **Same-relativity ranges round-trip the axis values exactly.**
    /// `R[2]C:R[5]C` — rows relative, cols both bare (Rel(0)).
    #[test]
    fn r1c1_parse_range_rel_row_bare_col_preserves_axis_values() {
        match p_r1c1("R[2]C:R[5]C") {
            Expr::RangeRef(RangeRef::R1C1Cells {
                start_row,
                start_col,
                end_row,
                end_col,
                ..
            }) => {
                assert_eq!(start_row, AxisSpec::Rel(2));
                assert_eq!(start_col, AxisSpec::Rel(0));
                assert_eq!(end_row, AxisSpec::Rel(5));
                assert_eq!(end_col, AxisSpec::Rel(0));
            }
            other => panic!("expected RangeRef::R1C1Cells, got {other:?}"),
        }
    }
}
