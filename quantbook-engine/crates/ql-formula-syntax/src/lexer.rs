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
///
/// Phase 2A.11 audit M16 (2026-05-12): switched from hand-rolled Display +
/// std::error::Error to `thiserror::Error` for consistency with QbookError,
/// RuntimeError, LoadAndRecomputeError, NameTableError (all already use
/// thiserror). Display strings are user-facing and identical to the prior
/// hand-rolled formatters.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum LexError {
    #[error("unterminated string literal")]
    UnterminatedString,

    #[error("invalid number: {0:?}")]
    InvalidNumber(String),

    #[error("unexpected character: {0:?}")]
    UnexpectedChar(char),

    /// Cell-ref or column letters exceed the Excel column-letter max (XFD = 16383). The
    /// constructor enforces this even though our `ColId = u32` could technically hold more.
    #[error("column letters out of range: {0:?}")]
    ColumnTooLarge(String),

    /// Row digits exceed the Excel row max (1048576). Same enforcement reason.
    #[error("row digits out of range: {0:?}")]
    RowTooLarge(String),
}

/// Excel's column-letter upper bound (XFD = 16383, zero-indexed).
pub const MAX_COLUMN: u32 = 16_383;
/// Excel's row upper bound (1,048,576 — 1-indexed in source, so max 0-indexed = 1,048,575).
pub const MAX_ROW: u32 = 1_048_575;

/// Tokenize a formula expression body (without the leading `=`).
pub fn lex(input: &str) -> Result<Vec<Token>, LexError> {
    let mut out = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&c) = chars.peek() {
        // Skip whitespace — Excel only treats ASCII space/tab/LF/CR as whitespace between
        // tokens (NBSP, vertical-tab, BOM, etc. are NOT whitespace in Excel formulas).
        // Per opus arch F14: `char::is_whitespace` is Unicode-defined and would silently
        // accept clipboard-paste NBSP; we lex strictly per Excel canon.
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
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

/// Lex either an identifier (function name / named ref) OR an A1 cell reference / bare-axis
/// reference. Source-shape grammar:
///   `[$]LETTERS[$]DIGITS` → CellRef
///   `[$]LETTERS`           → BareColumn (column letters with no row)
///   `[$]DIGITS`            → BareRow (row digits alone; only meaningful inside a range)
///   `_letters_digits…`     → Identifier (Ident / Word, parser disambiguates against `(`)
///
/// Tracks `leading_dollar` (the `$` before letters/digits) and `mid_dollar` (the `$` between
/// letters and digits) SEPARATELY so each propagates correctly to the abs markers.
/// Prior bug (codex r13 N5 / opus arch F1 / opus consistency B-2): pushing the leading `$`
/// into the letter buffer caused `$5` to lex as `BareRow { abs: false }` — silently wrong.
fn lex_ident_or_ref(chars: &mut Peekable<Chars>) -> Result<Token, LexError> {
    // Track the leading `$` separately — NEVER push into the letter buffer.
    let mut leading_dollar = false;
    if chars.peek() == Some(&'$') {
        leading_dollar = true;
        chars.next();
    }

    // Letter prefix: ASCII letters and underscore.
    let mut letters = String::new();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_alphabetic() || c == '_' {
            letters.push(c);
            chars.next();
        } else {
            break;
        }
    }

    // Phase 2A.5 (2026-05-12): dotted identifiers like `VAR.S`, `STDEV.P`. If we
    // see `.LETTERS`, treat as a continuation of the identifier — this commits
    // the token to the Ident path (no CellRef / BareColumn / BareRow
    // interpretation after a dot, since Excel doesn't have dotted cell refs).
    // An orphan dot (not followed by an ASCII letter) is a lex error here, not
    // a separate token: we've already entered identifier-lex mode, and Excel
    // canon doesn't put bare dots in identifier position.
    //
    // The `while` loop allows multi-dot patterns (e.g. `A.B.C`) for forward
    // compatibility — Excel only uses single-dot today, but the parser/binder
    // will reject unknown function names regardless of dot count.
    let mut has_dot = false;
    while chars.peek() == Some(&'.') {
        // Commit to consuming the `.` only when a letter follows. We peek twice
        // by cloning the iterator (cheap — Chars holds a single &str slice).
        let mut lookahead = chars.clone();
        lookahead.next(); // skip the `.` in the cloned view
        let next_is_letter = lookahead.peek().is_some_and(|c| c.is_ascii_alphabetic());
        if !next_is_letter {
            // Bare dot in identifier position (or end-of-input). Reject loudly.
            return Err(LexError::UnexpectedChar('.'));
        }
        chars.next(); // consume the `.` for real now
        letters.push('.');
        has_dot = true;
        while let Some(&c) = chars.peek() {
            if c.is_ascii_alphabetic() || c == '_' {
                letters.push(c);
                chars.next();
            } else {
                break;
            }
        }
    }

    // Phase 2A.5: once we've absorbed a dot, the token is unambiguously an
    // Ident. Cell-ref syntax (digits / extra `$`) isn't legal after a dot, and
    // leading `$` on an identifier isn't either. Reject these up front so the
    // error points at the offending character, not at downstream parse mismatch.
    if has_dot {
        if leading_dollar {
            return Err(LexError::UnexpectedChar('$'));
        }
        if chars.peek() == Some(&'$') {
            return Err(LexError::UnexpectedChar('$'));
        }
        if chars.peek().is_some_and(|c| c.is_ascii_digit()) {
            let bad = chars.peek().copied().unwrap();
            return Err(LexError::UnexpectedChar(bad));
        }
        return Ok(Token::Ident(Arc::from(letters)));
    }

    // Optional `$` between letters and digits (row-absolute marker).
    let mut mid_dollar = false;
    if chars.peek() == Some(&'$') {
        mid_dollar = true;
        chars.next();
    }

    // If digits follow, we're committed to a CellRef / BareRow form.
    if chars.peek().is_some_and(|c| c.is_ascii_digit()) {
        let mut row_digits = String::new();
        while let Some(&d) = chars.peek() {
            if d.is_ascii_digit() {
                row_digits.push(d);
                chars.next();
            } else {
                break;
            }
        }

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

        if letters.is_empty() {
            // Pure `[$]<digits>` → BareRow. Excel allows this only inside a range. The
            // absolute marker is the `leading_dollar` (the `$` that came BEFORE the digits).
            // A `mid_dollar` here would mean the source was `$$5` which is invalid in Excel.
            if mid_dollar {
                return Err(LexError::UnexpectedChar('$'));
            }
            return Ok(Token::BareRow {
                row,
                abs: leading_dollar,
            });
        }

        // letters + digits → CellRef. The raw `text` field is preserved so the parser can
        // disambiguate function calls (`LOG10(2)` → CellRef + LParen; parser looks up text
        // as a function name on encountering LParen). Excel-canonical: lexer emits CellRef
        // for `[col-letters][row-digits]`; parser overrides when `(` follows.
        let raw_text = format!(
            "{}{}{}{}",
            if leading_dollar { "$" } else { "" },
            letters,
            if mid_dollar { "$" } else { "" },
            row_digits
        );
        let parts = classify_letter_prefix_simple(&letters)?;
        Ok(Token::CellRef {
            col: parts.col,
            row,
            abs_col: leading_dollar,
            abs_row: mid_dollar,
            text: Arc::from(raw_text),
        })
    } else {
        // No trailing digits — either an identifier or a bare column.
        // `mid_dollar = true` here means we saw `<letters>$<non-digit>` — invalid in Excel.
        if mid_dollar {
            return Err(LexError::UnexpectedChar('$'));
        }
        if letters.is_empty() {
            // `$` alone with nothing after.
            return Err(LexError::UnexpectedChar('$'));
        }
        // Try column-letter interpretation (length 1-3, all ASCII alpha, value ≤ XFD).
        let raw_text = if leading_dollar {
            format!("${letters}")
        } else {
            letters.clone()
        };
        if letters.chars().all(|c| c.is_ascii_alphabetic()) && letters.len() <= 3 {
            // Try as column letters. If it fits, emit BareColumn; otherwise treat as Ident.
            if let Ok(col) = column_letters_to_index(&letters) {
                return Ok(Token::BareColumn {
                    col,
                    abs: leading_dollar,
                    text: Arc::from(raw_text),
                });
            }
        }
        // Identifier path. Identifiers cannot carry a `$` prefix in Excel.
        if leading_dollar {
            return Err(LexError::UnexpectedChar('$'));
        }
        Ok(Token::Ident(Arc::from(letters)))
    }
}

/// Simple classifier — letters-only (no `$` prefix; that's tracked separately by the caller).
/// Returns the column index for valid 1-3 letter column-letter sequences; errors for too-long
/// or non-alpha. The caller has already filtered out the `$` prefix.
struct LetterColumn {
    col: u32,
}

fn classify_letter_prefix_simple(letters: &str) -> Result<LetterColumn, LexError> {
    if letters.is_empty() || letters.len() > 3 {
        return Err(LexError::ColumnTooLarge(letters.to_string()));
    }
    if !letters.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(LexError::ColumnTooLarge(letters.to_string()));
    }
    let col = column_letters_to_index(letters)?;
    Ok(LetterColumn { col })
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

    #[test]
    fn ascii_whitespace_only_no_nbsp() {
        // Per opus arch F14: Excel only accepts ASCII whitespace. NBSP / vertical tab / BOM
        // are NOT whitespace in Excel formulas — should error out instead of being silently
        // dropped. \r\n line endings ARE accepted (the four ASCII forms).
        assert_eq!(
            lex_ok("1\r\n+\r\n2"),
            vec![
                Token::Number(1.0),
                Token::Op(Operator::Plus),
                Token::Number(2.0)
            ]
        );
        // NBSP between tokens should NOT be treated as whitespace.
        assert!(matches!(
            lex("1\u{00A0}+\u{00A0}2"),
            Err(LexError::UnexpectedChar('\u{00A0}'))
        ));
        // BOM at start should error.
        assert!(matches!(
            lex("\u{FEFF}1"),
            Err(LexError::UnexpectedChar('\u{FEFF}'))
        ));
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

    fn assert_cellref(
        toks: &[Token],
        col: u32,
        row: u32,
        abs_col: bool,
        abs_row: bool,
        text: &str,
    ) {
        assert_eq!(toks.len(), 1, "expected single token, got {toks:?}");
        match &toks[0] {
            Token::CellRef {
                col: c,
                row: r,
                abs_col: ac,
                abs_row: ar,
                text: t,
            } => {
                assert_eq!(
                    (*c, *r, *ac, *ar, t.as_ref()),
                    (col, row, abs_col, abs_row, text),
                    "CellRef mismatch"
                );
            }
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn cellref_basic() {
        assert_cellref(&lex_ok("A1"), 0, 0, false, false, "A1");
        assert_cellref(&lex_ok("B2"), 1, 1, false, false, "B2");
        assert_cellref(
            &lex_ok("XFD1048576"),
            MAX_COLUMN,
            MAX_ROW,
            false,
            false,
            "XFD1048576",
        );
    }

    #[test]
    fn cellref_absolute_markers() {
        assert_cellref(&lex_ok("$A1"), 0, 0, true, false, "$A1");
        assert_cellref(&lex_ok("A$1"), 0, 0, false, true, "A$1");
        assert_cellref(&lex_ok("$A$1"), 0, 0, true, true, "$A$1");
    }

    #[test]
    fn cellref_case_insensitive_column() {
        assert_cellref(&lex_ok("a1"), 0, 0, false, false, "a1");
    }

    #[test]
    fn cellref_row_zero_rejected() {
        // Excel rows are 1-indexed; "A0" is invalid.
        assert!(lex("A0").is_err());
    }

    // -- F1/B-2 regression: $<digits> bare-row absolute marker -----------------
    // Prior bug (codex r13 / opus arch F1 / opus consistency B-2): leading $ before
    // digits was silently dropped from BareRow.abs. Lock the correct behavior.

    #[test]
    fn bare_row_absolute_marker_preserved() {
        // `$5` (absolute row 5, only meaningful inside a range): abs MUST be true.
        let toks = lex_ok("$5");
        assert_eq!(toks, vec![Token::BareRow { row: 4, abs: true }]);
    }

    #[test]
    fn bare_row_relative_marker_when_no_dollar() {
        // No $ at all: shouldn't reach BareRow at all — bare digits route through the
        // number lexer. Verify.
        assert_eq!(lex_ok("5"), vec![Token::Number(5.0)]);
    }

    #[test]
    fn whole_row_range_absolute_pattern() {
        // `$1:$1` = absolute whole-row range. Both ends MUST carry abs:true.
        let toks = lex_ok("$1:$1");
        assert_eq!(
            toks,
            vec![
                Token::BareRow { row: 0, abs: true },
                Token::Colon,
                Token::BareRow { row: 0, abs: true },
            ]
        );
    }

    #[test]
    fn double_dollar_rejected() {
        // `$$5` is not valid Excel syntax — reject at lex time.
        assert!(matches!(lex("$$5"), Err(LexError::UnexpectedChar('$'))));
    }

    // -- N5: AI() reservation layering -----------------------------------------
    // CORR-06 / T4-D05: parser intercepts `AI(...)` and emits Error(AINotAvailable).
    // Lexer-level: `AI` is a regular 2-letter token (BareColumn), `AI(1)` is
    // `[BareColumn(34), LParen, Number(1), RParen]`. Parser dispatches.

    #[test]
    fn ai_lexes_with_text_preserved() {
        // The `text` field on BareColumn lets the parser detect "AI" + LParen and apply
        // CORR-06 reservation without re-deriving the letters from `col`.
        let toks = lex_ok("AI(1)");
        assert_eq!(toks.len(), 4);
        match &toks[0] {
            Token::BareColumn {
                col,
                abs: false,
                text,
            } => {
                assert_eq!(*col, 34); // A=1, I=9 → 1*26+9 = 35 → 0-indexed 34
                assert_eq!(text.as_ref(), "AI");
            }
            other => panic!("expected BareColumn('AI'), got {other:?}"),
        }
        assert_eq!(toks[1], Token::LParen);
        assert_eq!(toks[2], Token::Number(1.0));
        assert_eq!(toks[3], Token::RParen);
    }

    // -- N6: function-name vs CellRef ambiguity (LOG10) ------------------------
    // Excel-canonical: `LOG10` is BOTH a valid cell ref (col=8508, row=10) AND a function
    // name. The lexer emits CellRef; the parser uses the `text` field to look up the
    // function name when `LParen` follows.

    #[test]
    fn log10_lexes_as_cellref_with_text_for_parser() {
        let toks = lex_ok("LOG10");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::CellRef {
                col,
                row,
                abs_col: false,
                abs_row: false,
                text,
            } => {
                assert_eq!(*col, 8508);
                assert_eq!(*row, 9); // row 10 in source = 0-indexed 9
                assert_eq!(text.as_ref(), "LOG10");
            }
            other => panic!("expected CellRef('LOG10'), got {other:?}"),
        }
    }

    #[test]
    fn log10_followed_by_lparen_preserves_text_for_function_dispatch() {
        // LOG10(2) → [CellRef('LOG10'), LParen, Number(2), RParen]. Parser sees CellRef +
        // LParen, checks `text` against a function table, builds Expr::Function {name: "LOG10",
        // args: [Number(2)]}.
        let toks = lex_ok("LOG10(2)");
        assert_eq!(toks.len(), 4);
        match &toks[0] {
            Token::CellRef { text, .. } => assert_eq!(text.as_ref(), "LOG10"),
            other => panic!("expected CellRef, got {other:?}"),
        }
        assert_eq!(toks[1], Token::LParen);
        assert_eq!(toks[2], Token::Number(2.0));
        assert_eq!(toks[3], Token::RParen);
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
        let toks = lex_ok("A1:B2");
        assert_eq!(toks.len(), 3);
        assert!(matches!(
            toks[0],
            Token::CellRef {
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: false,
                ..
            }
        ));
        assert_eq!(toks[1], Token::Colon);
        assert!(matches!(
            toks[2],
            Token::CellRef {
                col: 1,
                row: 1,
                abs_col: false,
                abs_row: false,
                ..
            }
        ));
    }

    #[test]
    fn range_whole_column() {
        // A:A → BareColumn, Colon, BareColumn.
        let toks = lex_ok("A:A");
        assert_eq!(toks.len(), 3);
        assert!(matches!(
            toks[0],
            Token::BareColumn {
                col: 0,
                abs: false,
                ..
            }
        ));
        assert_eq!(toks[1], Token::Colon);
        assert!(matches!(
            toks[2],
            Token::BareColumn {
                col: 0,
                abs: false,
                ..
            }
        ));
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
        let toks = lex_ok("A * 2");
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

    #[test]
    fn formula_a1_times_2() {
        let toks = lex_ok("A1 * 2");
        assert_eq!(toks.len(), 3);
        assert!(matches!(
            toks[0],
            Token::CellRef {
                col: 0,
                row: 0,
                abs_col: false,
                abs_row: false,
                ..
            }
        ));
        assert_eq!(toks[1], Token::Op(Operator::Mul));
        assert_eq!(toks[2], Token::Number(2.0));
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

    // -- Phase 2A.5: dotted identifiers ----------------------------------------

    #[test]
    fn dotted_ident_var_s() {
        let toks = lex_ok("VAR.S");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::Ident(s) => assert_eq!(s.as_ref(), "VAR.S"),
            other => panic!("expected Ident(VAR.S), got {other:?}"),
        }
    }

    #[test]
    fn dotted_ident_stdev_p() {
        let toks = lex_ok("STDEV.P");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::Ident(s) => assert_eq!(s.as_ref(), "STDEV.P"),
            other => panic!("expected Ident(STDEV.P), got {other:?}"),
        }
    }

    #[test]
    fn dotted_ident_lowercase_preserved_at_lex_time() {
        // The lexer preserves case; the parser uppercases at canonicalization.
        let toks = lex_ok("var.s");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::Ident(s) => assert_eq!(s.as_ref(), "var.s"),
            other => panic!("expected Ident(var.s), got {other:?}"),
        }
    }

    #[test]
    fn dotted_ident_function_call() {
        let toks = lex_ok("VAR.S(1, 2, 3)");
        assert!(matches!(toks[0], Token::Ident(_)));
        assert_eq!(toks[1], Token::LParen);
        assert_eq!(toks[2], Token::Number(1.0));
        assert_eq!(toks[3], Token::Comma);
        // Last token must be RParen.
        assert_eq!(toks.last().unwrap(), &Token::RParen);
    }

    #[test]
    fn dotted_ident_multi_dot() {
        // Multi-dot names aren't Excel-standard, but the lexer accepts them
        // (the parser/binder rejects unknown function names downstream). This
        // pins the behavior so we don't regress without thinking about it.
        let toks = lex_ok("A.B.C");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::Ident(s) => assert_eq!(s.as_ref(), "A.B.C"),
            other => panic!("expected Ident(A.B.C), got {other:?}"),
        }
    }

    #[test]
    fn orphan_dot_in_ident_position_errors() {
        // `VAR.` with nothing after the dot — Excel doesn't allow trailing dots
        // in identifier position, and we can't undo the consumed letters.
        assert!(matches!(lex("VAR."), Err(LexError::UnexpectedChar('.'))));
        // `VAR.+` — dot followed by non-letter operator.
        assert!(matches!(lex("VAR.+1"), Err(LexError::UnexpectedChar('.'))));
        // `VAR.1` — dot followed by digit. Excel canon: dotted identifiers
        // can't have digits in the suffix.
        assert!(matches!(lex("VAR.1"), Err(LexError::UnexpectedChar('.'))));
    }

    #[test]
    fn dotted_ident_rejects_leading_dollar() {
        // `$VAR.S` — identifiers can't carry the column-absolute marker.
        assert!(matches!(lex("$VAR.S"), Err(LexError::UnexpectedChar('$'))));
    }

    #[test]
    fn dotted_ident_rejects_trailing_dollar() {
        // `VAR.S$` — no row-absolute marker after a dotted ident either.
        assert!(matches!(lex("VAR.S$"), Err(LexError::UnexpectedChar('$'))));
    }

    #[test]
    fn dotted_ident_rejects_trailing_digit() {
        // `VAR.S1` — once we've consumed a dot, the token is locked into the
        // Ident path; digits would imply CellRef semantics, which dotted names
        // don't support.
        assert!(matches!(lex("VAR.S1"), Err(LexError::UnexpectedChar('1'))));
    }

    #[test]
    fn cellref_followed_by_dot_still_works_as_separate_tokens() {
        // `A1.5` is `A1` (CellRef) followed by `.5` (Number) — the lexer
        // commits to the CellRef path when digits follow letters, and `.5`
        // re-enters lex_number. Pin this behavior so the dotted-ident path
        // doesn't accidentally steal CellRef syntax.
        let toks = lex_ok("A1+.5");
        assert!(matches!(toks[0], Token::CellRef { .. }));
        assert_eq!(toks[1], Token::Op(Operator::Plus));
        assert_eq!(toks[2], Token::Number(0.5));
    }

    /// Phase 2A.6 audit M8 (2026-05-12): leading-dot input like `.S` (no letters
    /// before the dot) routes through `lex_number`, not `lex_ident_or_ref`, and
    /// fails as `InvalidNumber` since `.S` isn't parseable as f64. Pin this so a
    /// future change to either lexer path can't silently steal the leading-dot
    /// syntax for a dotted identifier.
    #[test]
    fn leading_dot_routes_through_number_lexer_and_rejects() {
        assert!(matches!(lex(".S"), Err(LexError::InvalidNumber(_))));
        assert!(matches!(lex("."), Err(LexError::InvalidNumber(_))));
    }

    #[test]
    fn plain_ident_still_works_after_dot_extension() {
        // Regression guard: tokens with no dot in them must still lex the way
        // they did pre-2A.5 (Ident for 4+ letters / non-column-letter, BareColumn
        // for 1-3 valid column letters).
        let toks = lex_ok("AVERAGE");
        assert_eq!(toks.len(), 1);
        assert!(matches!(toks[0], Token::Ident(_)));
        let toks = lex_ok("A");
        assert!(matches!(toks[0], Token::BareColumn { .. }));
    }
}
