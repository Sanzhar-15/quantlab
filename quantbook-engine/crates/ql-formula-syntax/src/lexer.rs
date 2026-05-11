//! Excel-formula lexer. Phase 0 minimum surface (see `token.rs` docs for scope).
//!
//! Produces a flat `Vec<Token>` from a formula source string. The caller (parser) handles
//! precedence + AST building.
//!
//! Source convention: the leading `=` of an Excel formula is NOT consumed by the lexer — the
//! caller strips it (`s.strip_prefix('=').unwrap_or(s)`). This keeps the lexer reusable for
//! sub-expressions and criteria strings.

use std::iter::Peekable;
use std::str::Chars;
use std::sync::Arc;

use crate::token::{Operator, Token};

/// Lex error — narrow, structured.
#[derive(Clone, Debug, PartialEq)]
pub enum LexError {
    UnterminatedString,
    InvalidNumber(String),
    UnexpectedChar(char),
    /// Cell-ref or column letters exceed the Excel column-letter max (XFD = 16383). The
    /// constructor enforces this even though our `ColId = u32` could technically hold more.
    ColumnTooLarge(String),
    /// Row digits exceed the Excel row max (1048576). Same enforcement reason.
    RowTooLarge(String),
}

impl std::fmt::Display for LexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LexError::UnterminatedString => write!(f, "unterminated string literal"),
            LexError::InvalidNumber(s) => write!(f, "invalid number: {s:?}"),
            LexError::UnexpectedChar(c) => write!(f, "unexpected character: {c:?}"),
            LexError::ColumnTooLarge(s) => write!(f, "column letters out of range: {s:?}"),
            LexError::RowTooLarge(s) => write!(f, "row digits out of range: {s:?}"),
        }
    }
}

impl std::error::Error for LexError {}

/// Excel's column-letter upper bound (XFD = 16383, zero-indexed).
pub const MAX_COLUMN: u32 = 16_383;
/// Excel's row upper bound (1,048,576 — 1-indexed in source, so max 0-indexed = 1,048,575).
pub const MAX_ROW: u32 = 1_048_575;

/// Tokenize a formula expression body (without the leading `=`).
pub fn lex(input: &str) -> Result<Vec<Token>, LexError> {
    let mut out = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&c) = chars.peek() {
        // Skip whitespace — Excel ignores it between tokens.
        if c.is_whitespace() {
            chars.next();
            continue;
        }

        match c {
            '(' => {
                chars.next();
                out.push(Token::LParen);
            }
            ')' => {
                chars.next();
                out.push(Token::RParen);
            }
            ',' => {
                chars.next();
                out.push(Token::Comma);
            }
            ':' => {
                chars.next();
                out.push(Token::Colon);
            }
            ';' => {
                chars.next();
                out.push(Token::Semicolon);
            }
            '+' => {
                chars.next();
                out.push(Token::Op(Operator::Plus));
            }
            '-' => {
                chars.next();
                out.push(Token::Op(Operator::Minus));
            }
            '*' => {
                chars.next();
                out.push(Token::Op(Operator::Mul));
            }
            '/' => {
                chars.next();
                out.push(Token::Op(Operator::Div));
            }
            '%' => {
                chars.next();
                out.push(Token::Op(Operator::Percent));
            }
            '^' => {
                chars.next();
                out.push(Token::Op(Operator::Pow));
            }
            '&' => {
                chars.next();
                out.push(Token::Op(Operator::Concat));
            }
            '=' => {
                chars.next();
                out.push(Token::Op(Operator::Eq));
            }
            '<' => {
                chars.next();
                match chars.peek() {
                    Some('>') => {
                        chars.next();
                        out.push(Token::Op(Operator::Neq));
                    }
                    Some('=') => {
                        chars.next();
                        out.push(Token::Op(Operator::Le));
                    }
                    _ => out.push(Token::Op(Operator::Lt)),
                }
            }
            '>' => {
                chars.next();
                match chars.peek() {
                    Some('=') => {
                        chars.next();
                        out.push(Token::Op(Operator::Ge));
                    }
                    _ => out.push(Token::Op(Operator::Gt)),
                }
            }
            '"' => out.push(lex_string(&mut chars)?),
            '0'..='9' | '.' => out.push(lex_number(&mut chars)?),
            '$' | 'A'..='Z' | 'a'..='z' | '_' => out.push(lex_ident_or_ref(&mut chars)?),
            other => return Err(LexError::UnexpectedChar(other)),
        }
    }

    Ok(out)
}

fn lex_string(chars: &mut Peekable<Chars>) -> Result<Token, LexError> {
    chars.next(); // consume opening quote
    let mut s = String::new();
    loop {
        match chars.next() {
            None => return Err(LexError::UnterminatedString),
            Some('"') => {
                // Doubled "" → embedded literal quote; otherwise end of string.
                if chars.peek() == Some(&'"') {
                    chars.next();
                    s.push('"');
                } else {
                    return Ok(Token::String(Arc::from(s)));
                }
            }
            Some(c) => s.push(c),
        }
    }
}

fn lex_number(chars: &mut Peekable<Chars>) -> Result<Token, LexError> {
    let mut raw = String::new();
    while let Some(&c) = chars.peek() {
        match c {
            '0'..='9' | '.' => {
                raw.push(c);
                chars.next();
            }
            'e' | 'E' => {
                raw.push(c);
                chars.next();
                // optional sign immediately after exponent
                if let Some(&sign) = chars.peek() {
                    if sign == '+' || sign == '-' {
                        raw.push(sign);
                        chars.next();
                    }
                }
            }
            _ => break,
        }
    }

    let n: f64 = raw
        .parse()
        .map_err(|_| LexError::InvalidNumber(raw.clone()))?;
    if n.is_nan() || n.is_infinite() {
        return Err(LexError::InvalidNumber(raw));
    }
    Ok(Token::Number(n))
}

/// Lex either an identifier (function name / named ref) OR an A1 cell reference / bare
/// column reference. We peek the structure: `[$]LETTERS[$]DIGITS` → CellRef;
/// `[$]LETTERS` (no digits) → BareColumn; otherwise Identifier.
fn lex_ident_or_ref(chars: &mut Peekable<Chars>) -> Result<Token, LexError> {
    // Phase 1: scan optional `$` then letters/underscore/digits as an identifier-ish prefix.
    let mut buf = String::new();
    if chars.peek() == Some(&'$') {
        buf.push('$');
        chars.next();
    }
    // Letter prefix.
    while let Some(&c) = chars.peek() {
        if c.is_ascii_alphabetic() || c == '_' {
            buf.push(c);
            chars.next();
        } else {
            break;
        }
    }

    // Decide if this is a cell-ref candidate: starts with `[$]` + letters and the next char
    // is either `$` then digits, or directly digits. The row-side `$` is tracked separately
    // via `saw_row_dollar`; it must NOT be pushed into `buf` (which holds the LETTER prefix
    // for `classify_letter_prefix`).
    let mut saw_row_dollar = false;
    if chars.peek() == Some(&'$') {
        saw_row_dollar = true;
        chars.next();
    }

    // If we now see digits, this is a CellRef or BareRow. Identifiers with embedded digits
    // are NOT supported (Excel named refs allow trailing digits — that's a Phase 3+ feature
    // to track in the lexer; for Phase 0 minimum, an identifier with trailing digits would
    // be parsed as `Ident("..." ) + Number` and the parser would reject).
    if let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            // We're committed: parse the row digits.
            let mut row_digits = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    row_digits.push(d);
                    chars.next();
                } else {
                    break;
                }
            }

            // Parse the letter part from `buf` to extract col + abs_col, then assemble.
            let parts = classify_letter_prefix(&buf)?;
            let row_1based: u32 = row_digits
                .parse()
                .map_err(|_| LexError::RowTooLarge(row_digits.clone()))?;
            if row_1based == 0 {
                return Err(LexError::InvalidNumber(format!(
                    "row 0 not allowed: {row_digits}"
                )));
            }
            let row = row_1based - 1;
            if row > MAX_ROW {
                return Err(LexError::RowTooLarge(row_digits));
            }

            match parts {
                LetterClass::Identifier(text) => {
                    // We had an identifier but then saw digits — Phase 0 doesn't support
                    // identifier-with-trailing-digits. Re-emit the identifier and the number
                    // separately? Simpler: error out for now.
                    Err(LexError::UnexpectedChar(text.chars().next().unwrap_or('?')))
                }
                LetterClass::CellLetters { col, abs_col } => Ok(Token::CellRef {
                    col,
                    row,
                    abs_col,
                    abs_row: saw_row_dollar,
                }),
                LetterClass::None => {
                    // Pure `[$]<digits>` form → BareRow.
                    Ok(Token::BareRow {
                        row,
                        abs: saw_row_dollar,
                    })
                }
            }
        } else {
            // No digits — classify the letter prefix.
            classify_to_token(&buf, saw_row_dollar)
        }
    } else {
        // EOF after the letter run.
        classify_to_token(&buf, saw_row_dollar)
    }
}

enum LetterClass {
    /// Looks like a cell column (`A`, `AA`, `$XFD`). Includes the abs marker.
    CellLetters { col: u32, abs_col: bool },
    /// Looks like an identifier (longer than column-letter cap, contains underscore, etc.).
    Identifier(String),
    /// No letters at all (the `$<digits>` form). Used to disambiguate `$1` as BareRow.
    None,
}

fn classify_letter_prefix(buf: &str) -> Result<LetterClass, LexError> {
    if buf.is_empty() {
        return Ok(LetterClass::None);
    }
    // Strip leading `$` for abs marker; check if any underscore + handle.
    let (abs_col, rest) = if let Some(rest) = buf.strip_prefix('$') {
        (true, rest)
    } else {
        (false, buf)
    };
    // If rest is empty (meaning `$` alone, then digits coming) → no letters.
    if rest.is_empty() {
        return Ok(LetterClass::None);
    }
    // Trailing `$` (the row-abs marker) must NOT be in `rest`; caller strips it before.
    // If any underscore — it's an identifier.
    if rest.contains('_') {
        return Ok(LetterClass::Identifier(rest.to_string()));
    }
    // Pure ASCII letters → try as column letters. Length must be ≤ 3 (Excel max XFD).
    if rest.chars().all(|c| c.is_ascii_alphabetic()) && rest.len() <= 3 {
        // Convert column letters to 0-indexed column. A=0, Z=25, AA=26, AAA=702, XFD=16383.
        let col = column_letters_to_index(rest)?;
        Ok(LetterClass::CellLetters { col, abs_col })
    } else {
        Ok(LetterClass::Identifier(rest.to_string()))
    }
}

fn classify_to_token(buf: &str, trailing_dollar: bool) -> Result<Token, LexError> {
    // `trailing_dollar` only applies when the buf is actually a column-letter prefix and the
    // next char wasn't a digit. Excel doesn't normally produce that — but defensively handle.
    let (abs_col, rest) = if let Some(r) = buf.strip_prefix('$') {
        (true, r)
    } else {
        (false, buf)
    };
    if rest.is_empty() {
        return Err(LexError::UnexpectedChar('$'));
    }
    // Identifier path: anything with underscore OR length > 3.
    if rest.contains('_') || rest.len() > 3 || rest.chars().any(|c| !c.is_ascii_alphabetic()) {
        if trailing_dollar {
            return Err(LexError::UnexpectedChar('$'));
        }
        return Ok(Token::Ident(Arc::from(rest)));
    }
    // 1-3 ASCII letters: try column letters.
    let col = column_letters_to_index(rest)?;
    // No digits seen — this is a BareColumn (e.g. `A:A` left half).
    Ok(Token::BareColumn {
        col,
        abs: abs_col || trailing_dollar,
    })
}

/// Convert Excel column letters (case-insensitive, 1-3 letters) into 0-indexed column.
/// A = 0, Z = 25, AA = 26, ZZ = 701, AAA = 702, XFD = 16383.
pub fn column_letters_to_index(letters: &str) -> Result<u32, LexError> {
    if letters.is_empty() || letters.len() > 3 {
        return Err(LexError::ColumnTooLarge(letters.to_string()));
    }
    let mut value: u32 = 0;
    for c in letters.chars() {
        let digit = match c {
            'A'..='Z' => (c as u32) - ('A' as u32) + 1,
            'a'..='z' => (c as u32) - ('a' as u32) + 1,
            _ => return Err(LexError::ColumnTooLarge(letters.to_string())),
        };
        // Excel uses bijective base-26: each position contributes (letter * 26^k).
        value = value
            .checked_mul(26)
            .and_then(|v| v.checked_add(digit))
            .ok_or_else(|| LexError::ColumnTooLarge(letters.to_string()))?;
    }
    let zero_based = value - 1;
    if zero_based > MAX_COLUMN {
        return Err(LexError::ColumnTooLarge(letters.to_string()));
    }
    Ok(zero_based)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex_ok(s: &str) -> Vec<Token> {
        lex(s).unwrap_or_else(|e| panic!("lex({s:?}) failed: {e}"))
    }

    // -- whitespace + empty ----------------------------------------------------

    #[test]
    fn empty_input_yields_empty_tokens() {
        assert_eq!(lex_ok(""), vec![]);
    }

    #[test]
    fn whitespace_is_skipped() {
        assert_eq!(lex_ok("   \t  "), vec![]);
        assert_eq!(
            lex_ok("1 + 2"),
            vec![
                Token::Number(1.0),
                Token::Op(Operator::Plus),
                Token::Number(2.0)
            ]
        );
    }

    // -- numbers ---------------------------------------------------------------

    #[test]
    fn number_integer() {
        assert_eq!(lex_ok("42"), vec![Token::Number(42.0)]);
    }

    #[test]
    fn number_decimal() {
        assert_eq!(lex_ok("2.5"), vec![Token::Number(2.5)]);
        assert_eq!(lex_ok(".5"), vec![Token::Number(0.5)]);
        assert_eq!(lex_ok("1."), vec![Token::Number(1.0)]);
    }

    #[test]
    fn number_exponent() {
        assert_eq!(lex_ok("1e3"), vec![Token::Number(1000.0)]);
        assert_eq!(lex_ok("1.5e-2"), vec![Token::Number(0.015)]);
        assert_eq!(lex_ok("1E+3"), vec![Token::Number(1000.0)]);
    }

    #[test]
    fn number_overflow_rejected() {
        assert!(lex("1e500").is_err());
    }

    // -- strings ---------------------------------------------------------------

    #[test]
    fn string_simple() {
        let toks = lex_ok("\"hello\"");
        assert_eq!(toks.len(), 1);
        if let Token::String(s) = &toks[0] {
            assert_eq!(s.as_ref(), "hello");
        } else {
            panic!();
        }
    }

    #[test]
    fn string_escaped_quote() {
        let toks = lex_ok("\"he said \"\"hi\"\"\"");
        if let Token::String(s) = &toks[0] {
            assert_eq!(s.as_ref(), "he said \"hi\"");
        } else {
            panic!();
        }
    }

    #[test]
    fn string_unterminated_errors() {
        assert_eq!(lex("\"oops"), Err(LexError::UnterminatedString));
    }

    #[test]
    fn empty_string_literal() {
        let toks = lex_ok("\"\"");
        if let Token::String(s) = &toks[0] {
            assert_eq!(s.as_ref(), "");
        } else {
            panic!();
        }
    }

    // -- operators -------------------------------------------------------------

    #[test]
    fn single_char_operators() {
        for (src, op) in &[
            ("+", Operator::Plus),
            ("-", Operator::Minus),
            ("*", Operator::Mul),
            ("/", Operator::Div),
            ("%", Operator::Percent),
            ("^", Operator::Pow),
            ("&", Operator::Concat),
            ("=", Operator::Eq),
            ("<", Operator::Lt),
            (">", Operator::Gt),
        ] {
            assert_eq!(lex_ok(src), vec![Token::Op(*op)], "src: {src}");
        }
    }

    #[test]
    fn two_char_operators() {
        assert_eq!(lex_ok("<>"), vec![Token::Op(Operator::Neq)]);
        assert_eq!(lex_ok("<="), vec![Token::Op(Operator::Le)]);
        assert_eq!(lex_ok(">="), vec![Token::Op(Operator::Ge)]);
    }

    #[test]
    fn lt_then_gt_is_lt_neq_combined_carefully() {
        // "<>=" should lex as Neq then Eq.
        assert_eq!(
            lex_ok("<>="),
            vec![Token::Op(Operator::Neq), Token::Op(Operator::Eq)]
        );
    }

    // -- punctuation -----------------------------------------------------------

    #[test]
    fn punctuation_tokens() {
        assert_eq!(
            lex_ok("(),:;"),
            vec![
                Token::LParen,
                Token::RParen,
                Token::Comma,
                Token::Colon,
                Token::Semicolon
            ]
        );
    }

    // -- column letters helper -------------------------------------------------

    #[test]
    fn column_letters_zero_based() {
        assert_eq!(column_letters_to_index("A").unwrap(), 0);
        assert_eq!(column_letters_to_index("B").unwrap(), 1);
        assert_eq!(column_letters_to_index("Z").unwrap(), 25);
        assert_eq!(column_letters_to_index("AA").unwrap(), 26);
        assert_eq!(column_letters_to_index("AZ").unwrap(), 51);
        assert_eq!(column_letters_to_index("BA").unwrap(), 52);
        assert_eq!(column_letters_to_index("ZZ").unwrap(), 701);
        assert_eq!(column_letters_to_index("AAA").unwrap(), 702);
        // Excel max column XFD = 16383 (1024 × 16 - 1).
        assert_eq!(column_letters_to_index("XFD").unwrap(), MAX_COLUMN);
    }

    #[test]
    fn column_letters_case_insensitive() {
        assert_eq!(column_letters_to_index("a").unwrap(), 0);
        assert_eq!(column_letters_to_index("Aa").unwrap(), 26);
        assert_eq!(column_letters_to_index("xfd").unwrap(), MAX_COLUMN);
    }

    #[test]
    fn column_letters_overflow_rejected() {
        assert!(matches!(
            column_letters_to_index("XFE"),
            Err(LexError::ColumnTooLarge(_))
        ));
        assert!(matches!(
            column_letters_to_index("ZZZ"),
            Err(LexError::ColumnTooLarge(_))
        ));
        assert!(matches!(
            column_letters_to_index(""),
            Err(LexError::ColumnTooLarge(_))
        ));
        assert!(matches!(
            column_letters_to_index("AAAA"),
            Err(LexError::ColumnTooLarge(_))
        ));
    }

    // -- cell refs -------------------------------------------------------------

    #[test]
    fn cellref_basic() {
        assert_eq!(
            lex_ok("A1"),
            vec![Token::CellRef {
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: false
            }]
        );
        assert_eq!(
            lex_ok("B2"),
            vec![Token::CellRef {
                col: 1,
                row: 1,
                abs_col: false,
                abs_row: false
            }]
        );
        assert_eq!(
            lex_ok("XFD1048576"),
            vec![Token::CellRef {
                col: MAX_COLUMN,
                row: MAX_ROW,
                abs_col: false,
                abs_row: false
            }]
        );
    }

    #[test]
    fn cellref_absolute_markers() {
        assert_eq!(
            lex_ok("$A1"),
            vec![Token::CellRef {
                col: 0,
                row: 0,
                abs_col: true,
                abs_row: false
            }]
        );
        assert_eq!(
            lex_ok("A$1"),
            vec![Token::CellRef {
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: true
            }]
        );
        assert_eq!(
            lex_ok("$A$1"),
            vec![Token::CellRef {
                col: 0,
                row: 0,
                abs_col: true,
                abs_row: true
            }]
        );
    }

    #[test]
    fn cellref_case_insensitive_column() {
        assert_eq!(
            lex_ok("a1"),
            vec![Token::CellRef {
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: false
            }]
        );
    }

    #[test]
    fn cellref_row_zero_rejected() {
        // Excel rows are 1-indexed; "A0" is invalid.
        assert!(lex("A0").is_err());
    }

    #[test]
    fn cellref_row_overflow_rejected() {
        // Excel max row is 1048576.
        assert!(lex("A1048577").is_err());
    }

    // -- range ----------------------------------------------------------------

    #[test]
    fn range_two_cells() {
        // A1:B2 → CellRef, Colon, CellRef. The parser combines into RangeRef.
        assert_eq!(
            lex_ok("A1:B2"),
            vec![
                Token::CellRef {
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: false
                },
                Token::Colon,
                Token::CellRef {
                    col: 1,
                    row: 1,
                    abs_col: false,
                    abs_row: false
                }
            ]
        );
    }

    #[test]
    fn range_whole_column() {
        // A:A → BareColumn, Colon, BareColumn.
        assert_eq!(
            lex_ok("A:A"),
            vec![
                Token::BareColumn { col: 0, abs: false },
                Token::Colon,
                Token::BareColumn { col: 0, abs: false }
            ]
        );
    }

    #[test]
    fn range_whole_row() {
        assert_eq!(
            lex_ok("1:1"),
            vec![Token::Number(1.0), Token::Colon, Token::Number(1.0)]
        );
        // Note: Phase 0 lexer treats `1:1` as Number, Colon, Number. The parser disambiguates
        // bare-row range vs numeric range. (Excel `1:1` only appears in range context; we
        // catch the row form when the parser builds a Range with two numbers around a colon.)
    }

    // -- identifiers -----------------------------------------------------------

    #[test]
    fn ident_function_name() {
        let toks = lex_ok("SUM");
        // SUM is 3 letters all-alphabetic — lexed as BareColumn (column 12,948).
        // The parser disambiguates: function follows by `(`; bare column doesn't.
        // For SUM: bareColumn col=12948 (S=18, U=20, M=12 → 18*26²+20*26+12 = 12,792+520+12 = 13,324?). Verify.
        // Actually SUM = (S-1)*26^2 + (U-1)*26^1 + (M-1) per bijective base... wait the function
        // uses (c-'A'+1). Hmm, let me just check what we lex.
        // SUM → col = (S idx + U idx + M idx) via bijective base-26.
        // S=19, U=21, M=13. value = 0*26 + 19 = 19. value = 19*26+21 = 515. value = 515*26+13 = 13403. zero_based = 13402.
        match &toks[0] {
            Token::BareColumn { col, .. } => assert_eq!(*col, 13402),
            other => panic!("expected BareColumn for 'SUM' (Phase 0 lexer), got {other:?}"),
        }
    }

    #[test]
    fn ident_long_function_name() {
        // 4+ letters always lex as Ident.
        let toks = lex_ok("SUMIF");
        assert_eq!(toks, vec![Token::Ident(Arc::from("SUMIF"))]);
        let toks = lex_ok("AVERAGE");
        assert_eq!(toks, vec![Token::Ident(Arc::from("AVERAGE"))]);
    }

    #[test]
    fn ident_with_underscore() {
        let toks = lex_ok("my_name");
        assert_eq!(toks, vec![Token::Ident(Arc::from("my_name"))]);
    }

    #[test]
    fn ai_lexes_as_bare_column() {
        // AI is 2 letters — `lex_ident_or_ref` classifies as BareColumn. The parser handles
        // the CORR-06 reservation at parse time (when followed by `(`).
        let toks = lex_ok("AI");
        match &toks[0] {
            Token::BareColumn { .. } | Token::Ident(_) => {} // both are acceptable; parser disambiguates
            other => panic!("unexpected token for AI: {other:?}"),
        }
    }

    // -- mixed -----------------------------------------------------------------

    #[test]
    fn formula_a_times_2() {
        // The Phase 0 OG-02 acceptance formula body: `A * 2` (caller strips the leading `=`).
        // Note: A standalone lexes as BareColumn since there's no row digit.
        assert_eq!(
            lex_ok("A * 2"),
            vec![
                Token::BareColumn { col: 0, abs: false },
                Token::Op(Operator::Mul),
                Token::Number(2.0)
            ]
        );
    }

    #[test]
    fn formula_a1_times_2() {
        assert_eq!(
            lex_ok("A1 * 2"),
            vec![
                Token::CellRef {
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: false
                },
                Token::Op(Operator::Mul),
                Token::Number(2.0)
            ]
        );
    }

    #[test]
    fn formula_function_call_shape() {
        // SUMIF(A1:A10, ">5") — function followed by `(`. Lexer doesn't know about function
        // semantics; parser interprets the structure.
        let toks = lex_ok("SUMIF(A1:A10,\">5\")");
        assert_eq!(toks[0], Token::Ident(Arc::from("SUMIF")));
        assert_eq!(toks[1], Token::LParen);
        // Range: CellRef, Colon, CellRef
        match &toks[2] {
            Token::CellRef { col: 0, row: 0, .. } => {}
            other => panic!("expected A1, got {other:?}"),
        }
        assert_eq!(toks[3], Token::Colon);
        match &toks[4] {
            Token::CellRef { col: 0, row: 9, .. } => {}
            other => panic!("expected A10, got {other:?}"),
        }
        assert_eq!(toks[5], Token::Comma);
        match &toks[6] {
            Token::String(s) => assert_eq!(s.as_ref(), ">5"),
            other => panic!("expected String, got {other:?}"),
        }
        assert_eq!(toks[7], Token::RParen);
    }

    #[test]
    fn formula_arithmetic_precedence_witnesses() {
        // Lexer doesn't enforce precedence; just sequence.
        let toks = lex_ok("1 + 2 * 3");
        assert_eq!(toks.len(), 5);
        assert_eq!(toks[0], Token::Number(1.0));
        assert_eq!(toks[1], Token::Op(Operator::Plus));
        assert_eq!(toks[2], Token::Number(2.0));
        assert_eq!(toks[3], Token::Op(Operator::Mul));
        assert_eq!(toks[4], Token::Number(3.0));
    }

    #[test]
    fn formula_negative_number_via_unary() {
        // `-5` lexes as Op(Minus), Number(5). The parser folds into UnaryOp(-, 5).
        // (Phase 0 lexer doesn't try to combine sign with number; that's a precedence call.)
        assert_eq!(
            lex_ok("-5"),
            vec![Token::Op(Operator::Minus), Token::Number(5.0)]
        );
    }

    #[test]
    fn formula_parentheses_grouping() {
        let toks = lex_ok("(1 + 2) * 3");
        assert_eq!(toks.len(), 7);
        assert_eq!(toks[0], Token::LParen);
        assert_eq!(toks[4], Token::RParen);
    }

    #[test]
    fn formula_concat_strings() {
        let toks = lex_ok("\"a\"&\"b\"");
        assert_eq!(toks.len(), 3);
        assert_eq!(toks[1], Token::Op(Operator::Concat));
    }

    // -- error paths -----------------------------------------------------------

    #[test]
    fn unexpected_char_errors() {
        // `@` is structured-ref territory (Phase 3+). Phase 0 lexer rejects.
        assert!(matches!(lex("@"), Err(LexError::UnexpectedChar('@'))));
        // `{` array-literal territory; Phase 0 rejects.
        assert!(matches!(lex("{"), Err(LexError::UnexpectedChar('{'))));
        // backtick — not in the Excel alphabet at all.
        assert!(matches!(lex("`"), Err(LexError::UnexpectedChar('`'))));
    }

    #[test]
    fn invalid_number_errors() {
        // "1.2.3" — f64::parse rejects.
        assert!(matches!(lex("1.2.3"), Err(LexError::InvalidNumber(_))));
    }
}
