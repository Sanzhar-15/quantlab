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

use ql_types::{Locale, ReferenceMode};

use crate::token::{Operator, Token};

/// Lex error — narrow, structured.
///
/// Phase 2A.11 audit M16 (2026-05-12): switched from hand-rolled Display +
/// std::error::Error to `thiserror::Error` for consistency with QbookError,
/// RuntimeError, NameTableError (all already use thiserror). Display strings
/// are user-facing and identical to the prior hand-rolled formatters.
/// (Phase 2B.2 removed `LoadAndRecomputeError`; recompute failures are now
/// aggregated in `RecomputeResult` rather than surfaced as a wrapping enum.)
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

    /// **W5-88 (Phase 4.6.A part 2):** a `'...'`-style quoted sheet name
    /// was opened but never closed before end-of-input.
    #[error("unterminated quoted sheet name")]
    UnterminatedQuotedSheetName,

    /// **W5-88 (Phase 4.6.A part 2):** a `'...'` block was closed but not
    /// followed by `!`. Bare quoted strings have no other lexical role
    /// in Excel formulas — this is a clean syntax error.
    #[error("quoted string not followed by '!' — only valid as a sheet-name prefix")]
    DanglingQuotedString,

    /// **W5-97 (Phase 4.7.C):** a `#` was followed by characters that
    /// don't form any recognized error sigil. Excel's error literals are
    /// `#REF!`, `#VALUE!`, `#N/A`, `#DIV/0!`, `#NULL!`, `#NUM!`, `#NAME?`,
    /// `#SPILL!`, `#CALC!` (plus Quantbook-specific `#DISCONNECTED!`,
    /// `#BINDING!`, `#TIMEOUT!`, `#PERMISSION!`, `#AI_NOT_AVAILABLE_V1`,
    /// `#CIRC!`). The fragment captured is the longest run of sigil-
    /// looking characters starting at the `#`.
    #[error("unrecognized error sigil: {0:?}")]
    InvalidErrorSigil(String),

    /// **W5-111 (Phase 4.8.B):** a structured-reference opened a `[`
    /// after a table-name identifier but the matching `]` never appeared
    /// before end-of-input.
    #[error("unterminated structured reference (missing `]`)")]
    UnterminatedStructuredRef,

    /// **W5-111 (Phase 4.8.B):** a single-quote escape `'` inside
    /// structured-ref bracket content was the LAST character before the
    /// close. Per OOXML escape rules, `'` requires a following character
    /// to escape. A trailing `'` is a syntax error.
    #[error("dangling escape `'` at end of structured reference bracket content")]
    DanglingStructuredRefEscape,

    /// **W5-138 (Phase 4.9.B.4):** the lexer committed to an R1C1
    /// reference (saw `R` followed by `[`, digit, or `C`/`c` while in
    /// `ReferenceMode::R1C1`) but the remainder of the token did not
    /// match the R1C1 grammar (e.g. `R1+`, `R[]C1`, `R0C1`, `R1C0`,
    /// `R[1.5]C`). Captures the consumed fragment for diagnostics.
    #[error("malformed R1C1 reference: {0:?}")]
    MalformedR1C1(String),
}

/// Excel's column-letter upper bound (XFD = 16383, zero-indexed).
pub const MAX_COLUMN: u32 = 16_383;
/// Excel's row upper bound (1,048,576 — 1-indexed in source, so max 0-indexed = 1,048,575).
pub const MAX_ROW: u32 = 1_048_575;

/// Tokenize a formula expression body (without the leading `=`).
///
/// **W5-134 (Phase 4.9.B.1):** Backward-compat shim that delegates to
/// [`lex_with`] with `(ReferenceMode::A1, Locale::EnUs)` — the engine's
/// historical hardcoded defaults. New call sites that need mode or
/// locale awareness should call `lex_with` directly.
pub fn lex(input: &str) -> Result<Vec<Token>, LexError> {
    lex_with(input, ReferenceMode::A1, Locale::EnUs)
}

/// Tokenize a formula expression body with explicit `(ReferenceMode,
/// Locale)` context.
///
/// **Behavior consumed so far:**
///
/// - **W5-134 (4.9.B.1):** signature scaffolding only.
/// - **W5-135 (4.9.B.2):** `locale.decimal_separator` wired into the
///   number-literal lex loop (`lex_number`). In `Locale::De` /
///   `Locale::Fr`, `2,34` lexes as `Number(2.34)`; in `Locale::EnUs`
///   the historical `.` decimal stays unchanged. In DE / FR, `2.34`
///   was originally expected to surface a lex error at the bare `.`
///   — but W5-136 added a pre-dispatch that intercepts DE `.` as
///   `Token::Semicolon` (the array-row separator), so the post-W5-136
///   reality is `[Number(2), Semicolon, Number(34)]` (three tokens,
///   parser rejects later).
/// - **W5-136 (4.9.B.3):** locale-aware argument + array separators dispatched at the top of the lex loop.
///
/// W5-136 detail: EN keeps `,` → `Comma` + `;` → `Semicolon` exactly;
/// DE/FR remap source glyphs to canonical role-tokens (DE `;` →
/// `Comma`, DE `\\` → `Comma`, DE `.` → `Semicolon`). Parser sees the
/// SAME token vocab regardless of locale; only the source-glyph
/// mapping changes. Closes the leading-decimal gap from 4.9.B.2 in
/// DE/FR (DE `,5` lexes as `Number(0.5)` instead of hitting the
/// deleted literal `,` arm).
///
/// - **W5-138 (4.9.B.4):** R1C1 token emission. When `mode ==
///   ReferenceMode::R1C1` AND the next char is `R`/`r` AND the
///   following char is `[`, an ASCII digit, or `C`/`c`, the lexer
///   commits to lexing a `Token::R1C1Ref`. Forms accepted: `R1C1`,
///   `RC`, `R1C`, `RC1`, `R[1]C[-2]`, `R[+3]C`. Out-of-range
///   absolute axes (`R0`, `R1048577`, `C16385`) surface
///   `RowTooLarge` / `ColumnTooLarge` / `MalformedR1C1`. Malformed
///   forms post-commit (`R1+`, `R[]C`, `R[1.5]C`) surface
///   `MalformedR1C1`. A1 mode is unchanged — `R1` still lexes as
///   `CellRef { col: 17, row: 0 }`.
///
/// This split lets each behavior change land as an independent commit
/// with its own test coverage, instead of an atomic ~2k-line lexer
/// rewrite.
pub fn lex_with(input: &str, mode: ReferenceMode, locale: Locale) -> Result<Vec<Token>, LexError> {
    let locale_data = crate::locale::locale_data(locale);
    let decimal_sep = locale_data.decimal_separator;
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

        // **W5-136 (Phase 4.9.B.3):** locale-aware separator pre-
        // dispatch. The parser's token vocabulary stays the same
        // across locales — `Token::Comma` is the "arg-or-array-col
        // separator" role-token, `Token::Semicolon` is the "array-
        // row separator" role-token. Only the source glyph mapping
        // changes per locale.
        //
        // EN: `,` plays both arg-separator AND array-col-separator
        // roles (Excel canon, disambiguated by parser context inside
        // `(...)` vs `{...}`). `;` plays array-row role. Both map to
        // their existing tokens — net change is zero for EN.
        //
        // DE/FR: `;` is arg-separator → `Comma`. `\\` is array-col
        // separator → `Comma`. `.` is array-row separator →
        // `Semicolon`. `,` is decimal-separator (handled by 4.9.B.2
        // number-lex; falls through here to the decimal-start arm in
        // the main match below).
        //
        // Implemented BEFORE the main `match c` so the locale rule
        // wins over any hardcoded literal-glyph arm (now deleted for
        // `,` and `;`).
        if c == locale_data.arg_separator || c == locale_data.array_col_separator {
            chars.next();
            out.push(Token::Comma);
            continue;
        }
        if c == locale_data.array_row_separator {
            chars.next();
            out.push(Token::Semicolon);
            continue;
        }

        // **W5-138 (Phase 4.9.B.4):** R1C1-mode reference dispatch.
        // When in R1C1 mode AND the current char is `R`/`r`, peek
        // the next char to decide whether to commit to R1C1 lex.
        // Commit-on-`[`, ASCII-digit, or `C`/`c`; back off on
        // anything else (the `R` is consumed by the identifier
        // arm below as a bare column letter — A1 fallback for
        // mode-agnostic identifiers, e.g. `R + 1` arithmetic).
        // In A1 mode (the default), this block is skipped entirely
        // and `R1` lexes as a normal A1 `CellRef`.
        if mode == ReferenceMode::R1C1 && (c == 'R' || c == 'r') {
            if let Some(tok) = try_lex_r1c1_ref(&mut chars)? {
                out.push(tok);
                continue;
            }
            // Fall through to the regular identifier/A1 dispatch.
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
            // W5-136: the literal `,` and `;` arms were deleted —
            // those glyphs are now handled by the locale-aware
            // pre-dispatch above. In EN the pre-dispatch maps them
            // identically; in DE/FR they're either remapped (`;` →
            // Comma) or fall through to the decimal-start arm (`,`).
            ':' => {
                chars.next();
                out.push(Token::Colon);
            }
            // **W5-97 (Phase 4.7.C):** array-literal braces. The parser
            // consumes these in W5-98 (Phase 4.7.D) to build
            // `Expr::Array`. Outside an array-literal context the
            // parser surfaces `ParseError::UnexpectedToken`.
            '{' => {
                chars.next();
                out.push(Token::LBrace);
            }
            '}' => {
                chars.next();
                out.push(Token::RBrace);
            }
            // **W5-97 (Phase 4.7.C):** error-sigil literal. `#` is not
            // a lexical char anywhere else in Excel formula source, so
            // we commit to lex-as-error-sigil eagerly and surface
            // `LexError::InvalidErrorSigil` if the run doesn't match
            // any of `ErrorValue::ALL`. Greedy match per `lex_error_sigil`.
            '#' => {
                out.push(lex_error_sigil(&mut chars)?);
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
            '0'..='9' => out.push(lex_number(&mut chars, decimal_sep)?),
            // **W5-135 + W5-136:** the locale's decimal separator
            // also starts a number (`.5` in EN, `,5` in DE/FR). The
            // W5-135 guard `&& c != ',' && c != ';'` was deleted in
            // W5-136 because the literal `,`/`;` match arms above are
            // now also deleted — the locale-aware pre-dispatch
            // intercepts them by ROLE (separator-glyph), not by
            // literal. In DE/FR the decimal-sep `,` falls through
            // the pre-dispatch (it's not an arg/array-col/array-row
            // glyph in those locales) and lands here, starting a
            // number. In EN the decimal-sep `.` falls through too
            // (also not a separator glyph in EN's role table) and
            // restores the prior `'0'..='9' | '.'` arm exactly.
            c if c == decimal_sep => out.push(lex_number(&mut chars, decimal_sep)?),
            // **W5-88 (Phase 4.6.A part 2):** quoted sheet name `'...'`.
            // Single-quote has no other lexical role in Excel formulas;
            // bare/unclosed/non-prefix `'...'` surfaces as a clean lex
            // error.
            '\'' => {
                lex_quoted_sheet_name(&mut chars, &mut out)?;
            }
            // **W5-88 (Phase 4.6.A part 2):** unquoted sheet-name prefix
            // must be detected BEFORE the A1/function/cell-ref classifier
            // per Codex MEDIUM-1: `A!B1` lexes sheet `A`, not bare column
            // `A`; `A1!B1` lexes sheet `A1`, not cell `A1`. The check
            // uses a cheap multi-char peek (Chars::clone) to avoid
            // committing unless a real `!` follows.
            'A'..='Z' | 'a'..='z' | '_' if try_lex_sheet_name_prefix(&mut chars, &mut out)? => {
                // Token(s) emitted by try_lex_sheet_name_prefix when it
                // returns true. Fall through to next loop iteration.
            }
            '$' | 'A'..='Z' | 'a'..='z' | '_' => out.push(lex_ident_or_ref(&mut chars)?),
            // **W5-143 (Phase 4.9.G):** standalone `@` — implicit-
            // intersection operator. In-bracket `@` (inside
            // `Sales[@Col]`) is consumed by
            // `consume_structured_ref_bracket` per OOXML escape
            // rules and never reaches this arm.
            '@' => {
                chars.next();
                out.push(Token::At);
            }
            other => return Err(LexError::UnexpectedChar(other)),
        }
    }

    Ok(out)
}

/// **W5-97 (Phase 4.7.C):** lex an Excel error sigil literal starting
/// at `#`. Returns `Token::Error(ev)` on a recognized sigil, or
/// `LexError::InvalidErrorSigil` with the captured fragment.
///
/// Strategy: BUILD a candidate fragment via a CLONED iterator so we
/// can back off without disturbing the real cursor. Collect every
/// sigil-body char (ASCII letters / digits / `_` / `/` / `!` / `?` /
/// `.`), then find the LONGEST `ErrorValue::ALL` sigil that is a
/// prefix of the fragment. Consume only that many chars from the
/// real iterator — any tail past the sigil end stays in `chars` for
/// subsequent lex steps.
///
/// Edge cases:
/// - `#REF!5` → `Token::Error(Ref)` + `Token::Number(5)`. The `5` is
///   re-lexed normally on the next loop iteration.
/// - `#N/A` (no trailing `!`/`?`) → `Token::Error(NA)`. Sigil consumed
///   fully; iterator now positioned at whatever follows.
/// - `#NA` (missing slash) → `InvalidErrorSigil("#NA")` — no sigil
///   matches.
/// - Case-insensitive: `#ref!` matches `#REF!`.
fn lex_error_sigil(chars: &mut Peekable<Chars>) -> Result<Token, LexError> {
    // PEEK ONLY: build the fragment via a clone so we can back off
    // unmatched-tail chars without losing them.
    let mut peek = chars.clone();
    let mut fragment = String::new();
    fragment.push('#');
    peek.next(); // skip the `#` on the clone

    while let Some(&c) = peek.peek() {
        match c {
            // Body chars of every `ErrorValue::ALL` sigil. The set is
            // EXACT to the sigils — no `.` (no sigil contains a dot)
            // and no special punctuation beyond `_`, `/`, `!`, `?`.
            'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '/' | '!' | '?' => {
                fragment.push(c);
                peek.next();
            }
            _ => break,
        }
    }

    // Find the longest sigil that is a case-insensitive prefix of
    // `fragment`. All sigil bytes are ASCII so byte-indexing is safe.
    let mut best: Option<(ql_types::ErrorValue, usize)> = None;
    for ev in ql_types::ErrorValue::ALL {
        let sigil = ev.sigil();
        if fragment.len() >= sigil.len()
            && fragment.as_bytes()[..sigil.len()].eq_ignore_ascii_case(sigil.as_bytes())
        {
            match best {
                None => best = Some((ev, sigil.len())),
                Some((_, prev_len)) if sigil.len() > prev_len => best = Some((ev, sigil.len())),
                _ => {}
            }
        }
    }

    let (ev, matched_len) = best.ok_or(LexError::InvalidErrorSigil(fragment))?;

    // Consume EXACTLY `matched_len` chars from the real iterator. All
    // sigil bytes are ASCII (1 char = 1 byte), so byte length and char
    // count coincide.
    for _ in 0..matched_len {
        chars.next();
    }

    Ok(Token::Error(ev))
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

/// Consume a number literal. `decimal_sep` is the locale's decimal
/// separator glyph (`.` for EN, `,` for DE/FR); it's translated to
/// `.` in the accumulated `raw` string so Rust's `f64::from_str`
/// (which is locale-invariant on the `.`) parses correctly.
///
/// **W5-135 (Phase 4.9.B.2):** `decimal_sep` is the new parameter.
/// Before this, the function hardcoded `.`.
fn lex_number(chars: &mut Peekable<Chars>, decimal_sep: char) -> Result<Token, LexError> {
    let mut raw = String::new();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            raw.push(c);
            chars.next();
        } else if c == decimal_sep {
            // Always push canonical `.` so `f64::from_str` succeeds
            // regardless of locale. `decimal_sep` is the source glyph;
            // `.` is the wire/parse glyph.
            raw.push('.');
            chars.next();
        } else if c == 'e' || c == 'E' {
            raw.push(c);
            chars.next();
            // optional sign immediately after exponent
            if let Some(&sign) = chars.peek() {
                if sign == '+' || sign == '-' {
                    raw.push(sign);
                    chars.next();
                }
            }
        } else {
            break;
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
    // An orphan dot (not followed by an ASCII letter or digit) is a lex
    // error here, not a separate token: we've already entered
    // identifier-lex mode, and Excel canon doesn't put bare dots in
    // identifier position.
    //
    // **W5-D-2 (2026-05-17)**: extended to accept `.DIGIT+LETTER...`
    // segments — Excel canon includes `T.DIST.2T`, `T.INV.2T`,
    // `F.DIST.RT`, `CHISQ.DIST.RT`, etc. A segment that *starts* with a
    // digit accepts further alphanumeric chars but must contain at
    // least one letter (a pure-digit segment like `.123` is rejected
    // since no Excel function uses that shape and it would more likely
    // be a tokenization error). Letter-starting segments retain the
    // pre-W5-D-2 strict rule of letters/underscore only — this preserves
    // the post-loop reject-trailing-digit guard (line ~590) that
    // catches typos like `VAR.S5`.
    //
    // The `while` loop allows multi-dot patterns (e.g. `T.DIST.2T`) —
    // Excel uses up to 3-segment names.
    let mut has_dot = false;
    while chars.peek() == Some(&'.') {
        // Commit to consuming the `.` only when a letter or digit
        // follows. Peek twice by cloning the iterator (cheap — Chars
        // holds a single &str slice).
        let mut lookahead = chars.clone();
        lookahead.next(); // skip the `.` in the cloned view
        let next_char = lookahead.peek().copied();
        let next_is_letter = next_char.is_some_and(|c| c.is_ascii_alphabetic());
        let next_is_digit = next_char.is_some_and(|c| c.is_ascii_digit());
        if !next_is_letter && !next_is_digit {
            // Bare dot in identifier position (or end-of-input). Reject loudly.
            return Err(LexError::UnexpectedChar('.'));
        }
        chars.next(); // consume the `.` for real now
        letters.push('.');
        has_dot = true;
        if next_is_digit {
            // Digit-leading segment (Excel `.2T` / `.RT`-style): accept
            // alphanumeric continuation (letters + digits, but NOT
            // underscore — the digit-leading shape is reserved for Excel
            // canon function names which never embed `_`). Require at
            // least one letter eventually (pure-digit segments rejected).
            //
            // **W5-D-2.1 closure (Codex LOW-2):** dropped `|| c == '_'`
            // from this branch — the prior over-acceptance accepted
            // `T.DIST.2_T`-style identifiers that aren't in Excel canon.
            // Downstream binder still rejects unknown names; closing it
            // at lex time narrows the accepted grammar to spec.
            let mut saw_letter = false;
            while let Some(&c) = chars.peek() {
                if c.is_ascii_alphabetic() {
                    saw_letter = true;
                    letters.push(c);
                    chars.next();
                } else if c.is_ascii_digit() {
                    letters.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            if !saw_letter {
                return Err(LexError::UnexpectedChar('.'));
            }
        } else {
            // Letter-leading segment (Excel `.S`, `.DIST`-style): only
            // letters/underscore (pre-W5-D-2 strict rule).
            while let Some(&c) = chars.peek() {
                if c.is_ascii_alphabetic() || c == '_' {
                    letters.push(c);
                    chars.next();
                } else {
                    break;
                }
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

        // **W5-D-9 (Phase 4.10 — V1 260 closeout, base conversion):**
        // If letters follow the digits AND we don't have absolute-`$`
        // markers AND there's a non-empty letter prefix, treat the
        // whole thing (`letters + digits + more letters`) as a single
        // Ident token rather than a CellRef. This unlocks Excel
        // function names with embedded digits like `DEC2BIN`,
        // `BIN2DEC`, `HEX2DEC`, `OCT2DEC`, `DEC2HEX`, `DEC2OCT`.
        //
        // Without this: `DEC2BIN` lexes as `DEC2` (CellRef row 2, col
        // DEC) + `BIN` (Ident) — parser sees CellRef-not-followed-by-
        // LParen and treats DEC2 as a literal cell reference, then
        // `BIN(...)` becomes its own fn call, leaving the original
        // `DEC2` as orphan tokens. Parser surfaces as
        // `Trailing { count: ... }`.
        //
        // Constraints:
        // - Skip this path if absolute markers are set (`$DEC2BIN` or
        //   `DEC$2BIN` would be malformed for both interpretations).
        // - The trailing letter run accepts letters and underscores
        //   (matching the leading-ident-run rule).
        if !leading_dollar
            && !mid_dollar
            && !letters.is_empty()
            && chars.peek().is_some_and(|c| c.is_ascii_alphabetic())
        {
            let mut full = letters;
            full.push_str(&row_digits);
            while let Some(&c) = chars.peek() {
                if c.is_ascii_alphanumeric() || c == '_' {
                    full.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            // Trailing `$` / `.` / digits at end of ident are not valid
            // — defer to caller error path. The lexer is committed to
            // Ident here; downstream parser handles unknown names.
            return Ok(Token::Ident(Arc::from(full)));
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
        // No trailing digits — either an identifier, a bare column, OR a
        // structured table reference (Phase 4.8.B / #148 closure).
        // `mid_dollar = true` here means we saw `<letters>$<non-digit>` — invalid in Excel.
        if mid_dollar {
            return Err(LexError::UnexpectedChar('$'));
        }
        if letters.is_empty() {
            // `$` alone with nothing after.
            return Err(LexError::UnexpectedChar('$'));
        }

        // **W5-111 (Phase 4.8.B / #148 closure):** structured-reference
        // lookahead. If the next char is `[`, this is `Token::StructuredRef`
        // REGARDLESS of whether `letters` would otherwise classify as a
        // column letter (`Src`, `AAA`, `RC`, ...). Pre-4.8.B the lexer
        // emitted BareColumn for `Src` then choked on the trailing `[`,
        // surfacing as a misleading bind error. The lookahead pre-empts.
        //
        // Table names CAN NOT carry a `$` prefix (Excel canon — `$Sales`
        // is invalid).
        if !leading_dollar && chars.peek() == Some(&'[') {
            chars.next(); // consume the opening `[`
            let bracket_content = consume_structured_ref_bracket(chars)?;
            return Ok(Token::StructuredRef {
                table_name: Arc::from(letters),
                bracket_content: Arc::from(bracket_content),
            });
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

/// **W5-111 (Phase 4.8.B / 4.8.D refactor):** consume the bracket
/// content of a structured reference. The caller has already consumed
/// the opening `[`. Returns the content between the outer `[` and
/// matching `]` PRESERVING the OOXML `'`-prefix escapes; the closing
/// `]` is consumed but not pushed.
///
/// Per OOXML structured-reference grammar (design doc § 5.1 + § 5.4),
/// the bracket balancer is escape-aware: a `'`-prefixed `]` does NOT
/// close the bracket (it's a literal `]` inside a column name).
/// Similarly, `'[` doesn't increment depth. The `'` markers themselves
/// are PRESERVED in the output so the parser can structurally
/// distinguish syntactic from literal occurrences of `[`, `]`, `#`,
/// `@`, `'` (see § 5.1 for the ambiguity that motivated preservation).
///
/// Escape pairs the balancer recognizes (consumed as 2-char atoms,
/// emitted as 2-char atoms):
/// `'[`, `']`, `'#`, `'@`, `''`.
///
/// **Error cases:**
/// - EOF before matching unescaped `]` → `LexError::UnterminatedStructuredRef`.
/// - Trailing `'` with no following character →
///   `LexError::DanglingStructuredRefEscape`.
fn consume_structured_ref_bracket(chars: &mut Peekable<Chars>) -> Result<String, LexError> {
    let mut content = String::new();
    let mut depth: u32 = 1; // we've already consumed the opening `[`
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                // Escape pair: PRESERVE the `'` + next char as a 2-char
                // atom in the output. The balancer skips bracket-depth
                // tracking for the next char (so escaped `]` doesn't
                // close us).
                match chars.next() {
                    Some(escaped) => {
                        content.push('\'');
                        content.push(escaped);
                    }
                    None => return Err(LexError::DanglingStructuredRefEscape),
                }
            }
            '[' => {
                depth = depth.saturating_add(1);
                content.push('[');
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(content);
                }
                content.push(']');
            }
            other => content.push(other),
        }
    }
    Err(LexError::UnterminatedStructuredRef)
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

// ===== W5-88 (Phase 4.6.A part 2) — sheet-prefix lexing =====

/// Scan an unquoted sheet-name candidate at `chars` and peek ahead for
/// `!`. If a `Sheet!` prefix is recognized, emit `SheetName + Bang` and
/// return `Ok(true)`. If not (the leading run is actually an Ident /
/// CellRef / etc.), leave `chars` untouched and return `Ok(false)` —
/// the caller falls through to the existing dispatch.
///
/// Multi-char lookahead via `Chars::clone()`: cheap (just a `&str` +
/// cursor) and doesn't disturb the real iterator.
///
/// Per design doc § 4.1: name shape `[A-Za-z_][A-Za-z0-9_.]*`. Per
/// § 4.3 / Codex MEDIUM-1: this routine MUST run before the A1/
/// function/name classifier so `A1!B1` lexes sheet `A1`, not cell
/// `A1`. Edge cases (whitespace around `!`, dotted names, etc.) are
/// pinned in the test corpus.
fn try_lex_sheet_name_prefix(
    chars: &mut Peekable<Chars>,
    out: &mut Vec<Token>,
) -> Result<bool, LexError> {
    // Peek into a clone to scan the candidate name + lookahead.
    let mut peek = chars.clone();
    let mut name = String::new();

    // First char: `[A-Za-z_]` (caller's match arm already verified).
    let first = peek.next().expect("caller guaranteed at least one char");
    debug_assert!(first.is_ascii_alphabetic() || first == '_');
    name.push(first);

    // Trailing chars: `[A-Za-z0-9_.]`.
    while let Some(&c) = peek.peek() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
            name.push(c);
            peek.next();
        } else {
            break;
        }
    }

    // Skip whitespace between name and `!` per design § 4.3.
    while let Some(&c) = peek.peek() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            peek.next();
        } else {
            break;
        }
    }

    // Decision: is the next char `!`?
    let is_sheet_prefix = peek.peek() == Some(&'!');
    if !is_sheet_prefix {
        // Not a sheet prefix — leave `chars` untouched; caller falls
        // through to the existing identifier dispatch.
        return Ok(false);
    }

    // Commit: consume from the real `chars` iterator to match what we
    // scanned in the clone, then emit SheetName + Bang.
    for _ in 0..name.chars().count() {
        chars.next();
    }
    // Skip whitespace between name and `!`.
    while let Some(&c) = chars.peek() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            chars.next();
        } else {
            break;
        }
    }
    // Consume the `!`.
    chars.next();

    out.push(Token::SheetName(Arc::from(name)));
    out.push(Token::Bang);
    Ok(true)
}

/// **W5-138 (Phase 4.9.B.4):** try to lex an R1C1-style reference
/// starting at the current `R`/`r`. Returns:
///
/// - `Ok(Some(tok))` — committed and lexed successfully. The real
///   `chars` cursor has been advanced past the full reference.
/// - `Ok(None)` — not an R1C1 reference (the char after `R`/`r` is
///   neither `[`, ASCII digit, nor `C`/`c`). `chars` is untouched;
///   the caller falls through to the identifier/A1 dispatch.
/// - `Err(MalformedR1C1)` — committed but the body did not match the
///   grammar (missing `C`, empty `[]`, `0` for absolute, decimal in
///   brackets, …). `chars` may have been partially advanced through
///   the malformed fragment.
///
/// Commit rule: peek the char AFTER `R`/`r`. If it is `[`, an ASCII
/// digit, or `C`/`c`, COMMIT — once committed, any further malformation
/// is a lex error (no silent fallback). If the lookahead is anything
/// else, back off without consuming the `R` — the caller's identifier
/// arm will treat it as a bare column letter (consistent with A1 mode).
fn try_lex_r1c1_ref(chars: &mut Peekable<Chars>) -> Result<Option<Token>, LexError> {
    // Peek-only via clone. Don't mutate `chars` until we commit.
    let mut peek = chars.clone();
    let r_char = peek.next().expect("caller ensured R/r at boundary");
    debug_assert!(r_char.eq_ignore_ascii_case(&'R'));

    let should_commit = matches!(peek.peek(), Some('[') | Some('0'..='9'))
        || matches!(peek.peek(), Some(c) if c.eq_ignore_ascii_case(&'C'));
    if !should_commit {
        return Ok(None);
    }

    let mut fragment = String::new();
    fragment.push(r_char);

    let row_axis = parse_r1c1_axis(&mut peek, &mut fragment, R1C1Axis::Row)?;

    // Expect a mandatory `C`/`c` separator between axes.
    match peek.next() {
        Some(c) if c.eq_ignore_ascii_case(&'C') => fragment.push(c),
        _ => return Err(LexError::MalformedR1C1(fragment)),
    }

    let col_axis = parse_r1c1_axis(&mut peek, &mut fragment, R1C1Axis::Col)?;

    // Reject column-letter shadow: `R1C1A` would lex `R1C1` then leave
    // `A` for the next iter (where it parses as `BareColumn`). That's
    // correct — `R1C1A` is `R1C1 * A` in some grammars but Excel
    // forbids juxtaposition; the parser surfaces an error on the dangling
    // `A`. The lexer is happy to emit the two tokens.

    *chars = peek;
    Ok(Some(Token::R1C1Ref { row_axis, col_axis }))
}

/// **W5-138 (Phase 4.9.B.4):** parse one R1C1 axis (row or column).
///
/// Grammar (post-`R` or post-`C`):
///
/// ```text
/// axis := '[' signed_int ']'    -- relative offset
///       | unsigned_int          -- absolute 1-indexed
///       | (empty)               -- bare R/C ≡ Rel(0)
/// ```
///
/// Validation:
///
/// - Absolute `0` rejected (R1C1 is 1-indexed).
/// - Absolute overflow rejected (`RowTooLarge` / `ColumnTooLarge`).
/// - Empty `[]`, non-digit body, missing `]` → `MalformedR1C1`.
fn parse_r1c1_axis(
    chars: &mut Peekable<Chars>,
    fragment: &mut String,
    axis: R1C1Axis,
) -> Result<crate::token::AxisSpec, LexError> {
    use crate::token::AxisSpec;

    match chars.peek().copied() {
        Some('[') => {
            chars.next();
            fragment.push('[');

            let mut digits = String::new();
            if let Some(&sign @ ('+' | '-')) = chars.peek() {
                digits.push(sign);
                fragment.push(sign);
                chars.next();
            }
            let mut saw_digit = false;
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    digits.push(d);
                    fragment.push(d);
                    chars.next();
                    saw_digit = true;
                } else {
                    break;
                }
            }
            if !saw_digit {
                return Err(LexError::MalformedR1C1(std::mem::take(fragment)));
            }
            match chars.next() {
                Some(']') => fragment.push(']'),
                _ => return Err(LexError::MalformedR1C1(std::mem::take(fragment))),
            }
            let offset: i32 = digits
                .parse()
                .map_err(|_| LexError::MalformedR1C1(std::mem::take(fragment)))?;
            Ok(AxisSpec::Rel(offset))
        }
        Some(c) if c.is_ascii_digit() => {
            let mut digits = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    digits.push(d);
                    fragment.push(d);
                    chars.next();
                } else {
                    break;
                }
            }
            let n: u32 = digits
                .parse()
                .map_err(|_| LexError::MalformedR1C1(std::mem::take(fragment)))?;
            if n == 0 {
                return Err(LexError::MalformedR1C1(std::mem::take(fragment)));
            }
            let max = match axis {
                R1C1Axis::Row => MAX_ROW + 1,
                R1C1Axis::Col => MAX_COLUMN + 1,
            };
            if n > max {
                return Err(match axis {
                    R1C1Axis::Row => LexError::RowTooLarge(std::mem::take(fragment)),
                    R1C1Axis::Col => LexError::ColumnTooLarge(std::mem::take(fragment)),
                });
            }
            Ok(AxisSpec::Abs(n))
        }
        // Bare R or bare C — canonicalize to Rel(0) per Excel R1C1
        // canon (`RC` means "this row, this col").
        _ => Ok(AxisSpec::Rel(0)),
    }
}

/// **W5-138 (Phase 4.9.B.4):** which axis is being parsed — selects
/// the right bounds-check and error variant.
#[derive(Clone, Copy)]
enum R1C1Axis {
    Row,
    Col,
}

/// Lex a quoted-sheet-name prefix `'...'!`. The caller has just peeked
/// the opening `'`. The body allows any char except `'`; `''` decodes
/// to a single `'`. After the closing `'`, whitespace is skipped and
/// `!` is required — bare `'...'` without `!` produces
/// `LexError::DanglingQuotedString`.
fn lex_quoted_sheet_name(
    chars: &mut Peekable<Chars>,
    out: &mut Vec<Token>,
) -> Result<(), LexError> {
    // Consume opening quote.
    chars.next();
    let mut name = String::new();
    loop {
        match chars.next() {
            None => return Err(LexError::UnterminatedQuotedSheetName),
            Some('\'') => {
                // `''` is the embedded-quote escape; otherwise this is
                // the closing quote.
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    name.push('\'');
                } else {
                    break;
                }
            }
            Some(c) => name.push(c),
        }
    }
    // Skip whitespace before required `!`.
    while let Some(&c) = chars.peek() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            chars.next();
        } else {
            break;
        }
    }
    if chars.peek() != Some(&'!') {
        return Err(LexError::DanglingQuotedString);
    }
    chars.next();

    out.push(Token::QuotedSheetName(Arc::from(name)));
    out.push(Token::Bang);
    Ok(())
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
        // `@` is the implicit-intersection operator. As of W5-143
        // (Phase 4.9.G), the lexer emits `Token::At` instead of
        // rejecting; the post-W5-143 assertion lives in
        // `standalone_at_lexes_to_token_at` below.
        // `{` was rejected pre-W5-97 (Phase 4.7.C); now accepted as
        // `Token::LBrace`. The replacement assertion (lex_ok) lives in
        // `lbrace_and_rbrace_lex_to_brace_tokens` below in this module.
        // backtick — not in the Excel alphabet at all.
        assert!(matches!(lex("`"), Err(LexError::UnexpectedChar('`'))));
    }

    /// **W5-143 (Phase 4.9.G):** standalone `@` outside brackets
    /// lexes to `Token::At`. The parser folds it into
    /// `Expr::ImplicitIntersection`.
    #[test]
    fn standalone_at_lexes_to_token_at() {
        let tokens = lex("@").unwrap();
        assert_eq!(tokens, vec![Token::At]);
    }

    /// **W5-143:** `@` followed by a cell ref lexes as two tokens.
    #[test]
    fn at_followed_by_cellref_lexes_as_two_tokens() {
        let tokens = lex("@A1").unwrap();
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0], Token::At);
        assert!(matches!(tokens[1], Token::CellRef { col: 0, row: 0, .. }));
    }

    /// **W5-143:** In-bracket `@` is still consumed by the
    /// structured-ref bracket logic — NOT emitted as `Token::At`.
    /// `Sales[@Col]` lexes as a single `StructuredRef`.
    #[test]
    fn at_inside_structured_ref_brackets_stays_inside_bracket_content() {
        let tokens = lex("Sales[@Col]").unwrap();
        assert_eq!(tokens.len(), 1);
        match &tokens[0] {
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                assert_eq!(table_name.as_ref(), "Sales");
                // OOXML escape rules: bare `@` inside brackets is
                // the unescape sentinel for `[@Col]` (this-row form).
                assert_eq!(bracket_content.as_ref(), "@Col");
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    /// **W5-143:** `Sheet1!@A1` lexes as
    /// SheetName + Bang + At + CellRef — the parser binds the sheet
    /// to the inner ref and wraps in `@`.
    #[test]
    fn sheet_qualified_at_ref_lexes_as_four_tokens() {
        let tokens = lex("Sheet1!@A1").unwrap();
        assert_eq!(tokens.len(), 4);
        assert!(matches!(tokens[0], Token::SheetName(_)));
        assert!(matches!(tokens[1], Token::Bang));
        assert_eq!(tokens[2], Token::At);
        assert!(matches!(tokens[3], Token::CellRef { .. }));
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

    // =====================================================================
    // **W5-D-2.1 (Opus MEDIUM-O-1 closure):** lexer-level unit tests for
    // the digit-leading dotted-segment branch added in W5-D-2. The new
    // branch accepts `.DIGIT+LETTER...` segments — needed for Excel canon
    // names like `T.DIST.2T`, `T.INV.2T`, `F.DIST.RT`, `CHISQ.DIST.RT`,
    // etc. Letter-leading segments retain pre-W5-D-2 strict
    // letters/underscore-only rule (covered by tests above). These tests
    // pin the digit-leading branch in isolation.
    // =====================================================================

    fn ident_text(t: &Token) -> &str {
        match t {
            Token::Ident(s) => s,
            other => panic!("expected Token::Ident, got {other:?}"),
        }
    }

    #[test]
    fn dotted_ident_digit_leading_segment_t_dist_2t() {
        let toks = lex_ok("T.DIST.2T");
        assert_eq!(toks.len(), 1);
        assert_eq!(ident_text(&toks[0]), "T.DIST.2T");
    }

    #[test]
    fn dotted_ident_digit_leading_segment_t_inv_2t() {
        let toks = lex_ok("T.INV.2T");
        assert_eq!(toks.len(), 1);
        assert_eq!(ident_text(&toks[0]), "T.INV.2T");
    }

    #[test]
    fn dotted_ident_digit_leading_segment_lowercase_preserved() {
        // Lex preserves case; downstream registry normalizes for lookup.
        let toks = lex_ok("t.dist.2t");
        assert_eq!(toks.len(), 1);
        assert_eq!(ident_text(&toks[0]), "t.dist.2t");
    }

    #[test]
    fn dotted_ident_letter_then_digit_leading_segment_f_dist_rt() {
        // Mixed: letter-leading segment + digit-leading segment isn't the
        // only forward-compat shape we need — `F.DIST.RT` is pure letter
        // segments and should still lex (regression guard for the
        // unchanged letter-leading branch).
        let toks = lex_ok("F.DIST.RT");
        assert_eq!(toks.len(), 1);
        assert_eq!(ident_text(&toks[0]), "F.DIST.RT");
    }

    #[test]
    fn dotted_ident_multi_dot_digit_leading_final_segment() {
        // Three-segment with digit-leading final — forward-compat for
        // `CHISQ.DIST.RT`-style names (which are letter-only, but the
        // generic shape `A.B.2C` should lex too).
        let toks = lex_ok("A.B.2C");
        assert_eq!(toks.len(), 1);
        assert_eq!(ident_text(&toks[0]), "A.B.2C");
    }

    #[test]
    fn dotted_ident_digit_leading_segment_pure_digit_rejects() {
        // `T.DIST.2` — digit-leading segment with NO trailing letter.
        // The `saw_letter` check at the end of the digit-branch fires
        // and returns `UnexpectedChar('.')`. This is the new branch's
        // primary rejection condition.
        assert!(matches!(
            lex("T.DIST.2"),
            Err(LexError::UnexpectedChar('.'))
        ));
    }

    #[test]
    fn dotted_ident_digit_leading_segment_orphan_dot_rejects() {
        // `T.DIST.` — orphan dot at end (no char follows). The lookahead
        // sees None, fails both letter and digit checks, returns the
        // `UnexpectedChar('.')` error.
        assert!(matches!(lex("T.DIST."), Err(LexError::UnexpectedChar('.'))));
    }

    #[test]
    fn dotted_ident_digit_leading_segment_rejects_trailing_digit() {
        // Post-loop trailing-digit guard still fires on
        // `T.DIST.2T1` — the inner digit-branch loop consumes `2T1` (all
        // alphanumeric), but actually... wait. Let me trace this:
        // - Initial: `T`
        // - Dot 1: peek `D`, letter-branch. Inner loop: consume `DIST`,
        //   stop at `.`.
        // - Dot 2: peek `2`, digit-branch. Inner loop: consume `2T1`
        //   (alphanumeric loop, since both letter and digit accepted).
        //   `saw_letter` = true. Exit.
        // - Loop ends, peek None.
        // So `T.DIST.2T1` lexes as one token. Pin that behavior.
        let toks = lex_ok("T.DIST.2T1");
        assert_eq!(toks.len(), 1);
        assert_eq!(ident_text(&toks[0]), "T.DIST.2T1");
    }

    #[test]
    fn dotted_ident_digit_leading_segment_rejects_underscore() {
        // **W5-D-2.1 (Codex LOW-2 closure):** digit-leading segments
        // reject `_` (Excel canon function names with digit-leading
        // segments never embed `_`). The pre-W5-D-2.1 impl accepted it
        // via `c.is_ascii_digit() || c == '_'`; the closure dropped
        // the underscore. With `_` rejected, after consuming `.2` we
        // have `saw_letter=false` when `_` breaks the inner loop, so
        // the post-loop `saw_letter` check fires →
        // `UnexpectedChar('.')`. This test pins the narrower grammar.
        assert!(matches!(
            lex("T.DIST.2_T"),
            Err(LexError::UnexpectedChar('.'))
        ));
    }

    #[test]
    fn dotted_ident_digit_leading_segment_followed_by_args() {
        // Verifies the parser sees `T.DIST.2T(1, 1)` as Ident + LParen
        // + Number + ... — the e2e test relies on this shape.
        let toks = lex_ok("T.DIST.2T(1, 1)");
        assert_eq!(ident_text(&toks[0]), "T.DIST.2T");
        assert!(matches!(toks[1], Token::LParen));
        assert_eq!(toks[2], Token::Number(1.0));
    }

    // ===== W5-D-9.1 — `letters-digits-letters` ident-lex extension =====
    //
    // Cross-cutting lexer change to support Excel function names with
    // embedded digits like `DEC2BIN` / `BIN2DEC` / `HEX2DEC` /
    // `OCT2DEC` / `DEC2HEX` / `DEC2OCT`. **Codex W5-D-9 LOW-2 + Opus
    // W5-D-9 MEDIUM-2 closure**: direct lexer tests for the new
    // branch, replacing the prior-only e2e-coverage approach.

    #[test]
    fn ident_letters_digits_letters_lexes_as_single_ident() {
        // `DEC2BIN` should be a single Ident token (not CellRef("DEC2")
        // + Ident("BIN")).
        let toks = lex_ok("DEC2BIN");
        assert_eq!(toks.len(), 1);
        assert!(matches!(toks[0], Token::Ident(_)));
        if let Token::Ident(s) = &toks[0] {
            assert_eq!(s.as_ref(), "DEC2BIN");
        }
    }

    #[test]
    fn ident_letters_digits_letters_with_lparen() {
        // `DEC2BIN(5)` should lex as Ident + LParen + Number + RParen.
        let toks = lex_ok("DEC2BIN(5)");
        assert!(matches!(toks[0], Token::Ident(_)));
        if let Token::Ident(s) = &toks[0] {
            assert_eq!(s.as_ref(), "DEC2BIN");
        }
        assert!(matches!(toks[1], Token::LParen));
        assert_eq!(toks[2], Token::Number(5.0));
    }

    #[test]
    fn ident_bin2dec_hex2dec_oct2dec_all_lex_as_idents() {
        // All 6 base-conversion fns should be single Ident tokens.
        for name in [
            "DEC2BIN", "DEC2OCT", "DEC2HEX", "BIN2DEC", "OCT2DEC", "HEX2DEC",
        ] {
            let toks = lex_ok(name);
            assert_eq!(toks.len(), 1, "{name} should be 1 token");
            assert!(matches!(toks[0], Token::Ident(_)), "{name} should be Ident");
            if let Token::Ident(s) = &toks[0] {
                assert_eq!(s.as_ref(), name);
            }
        }
    }

    #[test]
    fn log10_still_lexes_as_cellref_no_regression() {
        // **W5-D-9.1 regression guard**: existing trailing-digit-only
        // patterns (LOG10, ATAN2, LOG2) must NOT be affected by the
        // letters-digits-letters extension. They have no letters
        // after the digits, so the new branch is not triggered.
        let toks = lex_ok("LOG10");
        assert!(
            matches!(toks[0], Token::CellRef { .. }),
            "LOG10 should remain CellRef, got {:?}",
            toks[0]
        );
        if let Token::CellRef { text, .. } = &toks[0] {
            assert_eq!(text.as_ref(), "LOG10");
        }
    }

    #[test]
    fn log2_still_lex_as_cellref_no_regression() {
        // Companion to the LOG10 regression guard — LOG2 is 3-letter
        // prefix + digit; should still lex as CellRef.
        // (Note: ATAN2 has a 4-letter prefix which exceeds the
        // column-letter limit, so it can't lex standalone as a
        // CellRef regardless; it only works as `ATAN2(...)` via the
        // parser's fn-name override. Not a regression for the
        // letters-digits-letters extension.)
        let toks = lex_ok("LOG2");
        assert!(
            matches!(toks[0], Token::CellRef { .. }),
            "LOG2 should remain CellRef, got {:?}",
            toks[0]
        );
    }

    #[test]
    fn ident_letters_digits_letters_with_dollar_falls_through() {
        // `$DEC2BIN` has a leading $ (absolute-column marker). The
        // letters-digits-letters branch is GUARDED OUT in this case
        // — the lexer falls through to the CellRef row-parse path,
        // which sees `2BIN` (digits then non-digit) and produces a
        // CellRef-like emit OR an error. Either way, `$DEC2BIN`
        // should NOT lex as `Ident("$DEC2BIN")`.
        let result = lex("$DEC2BIN");
        // Whatever path it takes, the first token (if any) must NOT
        // be Ident("$DEC2BIN"). The CellRef fallback will produce a
        // CellRef + extra tokens or a row-parse error.
        if let Ok(toks) = result {
            if let Token::Ident(s) = &toks[0] {
                assert_ne!(
                    s.as_ref(),
                    "$DEC2BIN",
                    "$DEC2BIN must not lex as single Ident"
                );
            }
        }
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

    // ===== W5-88 / Phase 4.6.A part 2 — sheet-prefix tokens =====

    #[test]
    fn unquoted_sheet_prefix_emits_sheet_name_bang_then_cellref() {
        let toks = lex_ok("Sheet1!A1");
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::SheetName(n) => assert_eq!(n.as_ref(), "Sheet1"),
            other => panic!("expected SheetName, got {other:?}"),
        }
        assert_eq!(toks[1], Token::Bang);
        assert!(matches!(toks[2], Token::CellRef { .. }));
    }

    #[test]
    fn unquoted_sheet_prefix_with_range() {
        let toks = lex_ok("Sheet1!A1:B2");
        // SheetName, Bang, CellRef(A1), Colon, CellRef(B2)
        assert_eq!(toks.len(), 5);
        assert!(matches!(toks[0], Token::SheetName(_)));
        assert_eq!(toks[1], Token::Bang);
    }

    #[test]
    fn sheet_prefix_takes_priority_over_a1_classification() {
        // Per Codex MEDIUM-1: `A!B1` must lex sheet `A`, not bare column `A`.
        let toks = lex_ok("A!B1");
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::SheetName(n) => assert_eq!(n.as_ref(), "A"),
            other => panic!("expected SheetName, got {other:?}"),
        }
        assert_eq!(toks[1], Token::Bang);
        assert!(matches!(toks[2], Token::CellRef { .. }));
    }

    #[test]
    fn cell_ref_shaped_name_classifies_as_sheet_when_followed_by_bang() {
        // Per Codex MEDIUM-1: `A1!B1` lexes sheet `A1`, not cell `A1`.
        let toks = lex_ok("A1!B1");
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::SheetName(n) => assert_eq!(n.as_ref(), "A1"),
            other => panic!("expected SheetName, got {other:?}"),
        }
    }

    #[test]
    fn function_name_shaped_sheet_works_without_paren() {
        // `SUM!A1` is a sheet reference, NOT a function call. The lexer's
        // sheet-prefix recognizer wins over the function/Ident dispatch
        // because of one-token lookahead.
        let toks = lex_ok("SUM!A1");
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::SheetName(n) => assert_eq!(n.as_ref(), "SUM"),
            other => panic!("expected SheetName, got {other:?}"),
        }
    }

    #[test]
    fn function_call_still_works_after_sheet_prefix_check() {
        // `SUM(A1)` — no `!` so the sheet-prefix detection fails and
        // we fall through to the existing dispatch. Per the pre-W5-88
        // lexer behavior: 3-letter `SUM` resolves as `BareColumn`
        // (because `SUM` is a valid column-letter trio); the parser
        // sees `LParen` next and routes to a function call.
        let toks = lex_ok("SUM(A1)");
        assert_eq!(toks.len(), 4);
        assert!(matches!(toks[0], Token::BareColumn { .. }));
        assert_eq!(toks[1], Token::LParen);
        assert!(matches!(toks[2], Token::CellRef { .. }));
        assert_eq!(toks[3], Token::RParen);
    }

    #[test]
    fn dotted_sheet_name_supported() {
        let toks = lex_ok("Data.2024!A1");
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::SheetName(n) => assert_eq!(n.as_ref(), "Data.2024"),
            other => panic!("expected SheetName, got {other:?}"),
        }
    }

    #[test]
    fn whitespace_around_bang_accepted() {
        // Excel accepts whitespace around `!` per design § 4.3.
        let toks = lex_ok("Sheet1 ! A1");
        // Whitespace between Sheet1 and ! is consumed by the recognizer.
        // Whitespace between ! and A1 is consumed by the main loop.
        assert!(matches!(toks[0], Token::SheetName(_)));
        assert_eq!(toks[1], Token::Bang);
        assert!(matches!(toks[2], Token::CellRef { .. }));
    }

    #[test]
    fn quoted_sheet_name_with_space() {
        let toks = lex_ok("'Q3 2025'!A1");
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::QuotedSheetName(n) => assert_eq!(n.as_ref(), "Q3 2025"),
            other => panic!("expected QuotedSheetName, got {other:?}"),
        }
        assert_eq!(toks[1], Token::Bang);
    }

    #[test]
    fn quoted_sheet_name_with_escaped_quote() {
        // Excel canon: `''` inside a quoted sheet name decodes to a single `'`.
        let toks = lex_ok("'Ben''s Sheet'!A1");
        match &toks[0] {
            Token::QuotedSheetName(n) => assert_eq!(n.as_ref(), "Ben's Sheet"),
            other => panic!("expected QuotedSheetName, got {other:?}"),
        }
    }

    #[test]
    fn unterminated_quoted_sheet_name_errors() {
        match lex("'unterminated") {
            Err(LexError::UnterminatedQuotedSheetName) => {}
            other => panic!("expected UnterminatedQuotedSheetName, got {other:?}"),
        }
    }

    #[test]
    fn dangling_quoted_string_without_bang_errors() {
        // A `'...'` block without a trailing `!` has no other role in
        // Excel formulas — distinct error from a quoted sheet name.
        match lex("'no bang'") {
            Err(LexError::DanglingQuotedString) => {}
            other => panic!("expected DanglingQuotedString, got {other:?}"),
        }
    }

    #[test]
    fn quoted_sheet_with_whitespace_before_bang() {
        let toks = lex_ok("'Sheet One'  !  A1");
        assert!(matches!(toks[0], Token::QuotedSheetName(_)));
        assert_eq!(toks[1], Token::Bang);
        assert!(matches!(toks[2], Token::CellRef { .. }));
    }

    #[test]
    fn double_sheet_qualifier_lexes_but_parser_will_reject() {
        // `Sheet1!Sheet2!A1` lexes as three tokens of the sheet-pattern
        // shape (SheetName, Bang, SheetName, Bang, CellRef). The parser
        // owns the "double sheet qualifier" rejection (W5-89).
        let toks = lex_ok("Sheet1!Sheet2!A1");
        assert_eq!(toks.len(), 5);
        assert!(matches!(toks[0], Token::SheetName(_)));
        assert_eq!(toks[1], Token::Bang);
        assert!(matches!(toks[2], Token::SheetName(_)));
        assert_eq!(toks[3], Token::Bang);
    }

    #[test]
    fn ident_inside_function_args_still_works() {
        // Defined-name reference inside a function. Should NOT be
        // classified as a sheet prefix because there's no `!` after.
        // SUM is 3-letter BareColumn; TaxRate is 7-letter Ident.
        let toks = lex_ok("SUM(TaxRate)");
        assert!(matches!(toks[0], Token::BareColumn { .. }));
        assert_eq!(toks[1], Token::LParen);
        match &toks[2] {
            Token::Ident(n) => assert_eq!(n.as_ref(), "TaxRate"),
            other => panic!("expected Ident, got {other:?}"),
        }
    }

    #[test]
    fn quoted_string_after_quote_uses_quoted_sheet_name_path() {
        // Lexer's `'` arm is dedicated to quoted sheet names. A bare
        // `'...'` is always treated as a candidate sheet prefix; only
        // the `!`-or-no-`!` check disambiguates.
        let toks = lex_ok("'A'!B1");
        match &toks[0] {
            Token::QuotedSheetName(n) => assert_eq!(n.as_ref(), "A"),
            other => panic!("expected QuotedSheetName, got {other:?}"),
        }
    }

    // ===== W5-97 (Phase 4.7.C) — array braces + error literals =====

    #[test]
    fn lbrace_and_rbrace_lex_to_brace_tokens() {
        let toks = lex_ok("{}");
        assert_eq!(toks.len(), 2);
        assert_eq!(toks[0], Token::LBrace);
        assert_eq!(toks[1], Token::RBrace);
    }

    #[test]
    fn array_literal_shape_lexes_to_expected_token_stream() {
        // Per design § 3.1: `{1, 2; 3, 4}` should lex as
        // LBrace, Number, Comma, Number, Semicolon, Number, Comma, Number, RBrace.
        let toks = lex_ok("{1, 2; 3, 4}");
        assert_eq!(toks.len(), 9);
        assert_eq!(toks[0], Token::LBrace);
        assert!(matches!(toks[1], Token::Number(n) if n == 1.0));
        assert_eq!(toks[2], Token::Comma);
        assert!(matches!(toks[3], Token::Number(n) if n == 2.0));
        assert_eq!(toks[4], Token::Semicolon);
        assert!(matches!(toks[5], Token::Number(n) if n == 3.0));
        assert_eq!(toks[6], Token::Comma);
        assert!(matches!(toks[7], Token::Number(n) if n == 4.0));
        assert_eq!(toks[8], Token::RBrace);
    }

    #[test]
    fn error_sigil_ref_lexes() {
        let toks = lex_ok("#REF!");
        assert_eq!(toks.len(), 1);
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Ref));
    }

    #[test]
    fn error_sigil_value_lexes() {
        let toks = lex_ok("#VALUE!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Value));
    }

    #[test]
    fn error_sigil_na_lexes_without_trailing_punct() {
        // #N/A is the one canonical sigil that ends without ! or ?.
        let toks = lex_ok("#N/A");
        assert_eq!(toks.len(), 1);
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::NA));
    }

    #[test]
    fn error_sigil_div_zero_with_slash_lexes() {
        let toks = lex_ok("#DIV/0!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::DivZero));
    }

    #[test]
    fn error_sigil_name_with_question_mark_lexes() {
        let toks = lex_ok("#NAME?");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Name));
    }

    #[test]
    fn error_sigil_spill_lexes() {
        let toks = lex_ok("#SPILL!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Spill));
    }

    #[test]
    fn error_sigil_calc_lexes() {
        let toks = lex_ok("#CALC!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Calc));
    }

    #[test]
    fn error_sigil_null_lexes() {
        let toks = lex_ok("#NULL!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Null));
    }

    #[test]
    fn error_sigil_num_lexes() {
        let toks = lex_ok("#NUM!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Num));
    }

    #[test]
    fn error_sigil_circ_lexes() {
        // Quantbook-specific Phase 3.4 sigil.
        let toks = lex_ok("#CIRC!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Circ));
    }

    #[test]
    fn error_sigil_case_insensitive() {
        let toks = lex_ok("#ref!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Ref));
        let toks = lex_ok("#Value!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Value));
        let toks = lex_ok("#n/a");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::NA));
    }

    #[test]
    fn error_sigil_followed_by_digit_does_not_over_consume() {
        // `#REF!5` → Error(Ref) + Number(5). The `5` is NOT a sigil-
        // body continuation; the lexer must stop after `!`.
        let toks = lex_ok("#REF!5");
        assert_eq!(toks.len(), 2);
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Ref));
        assert!(matches!(toks[1], Token::Number(n) if n == 5.0));
    }

    #[test]
    fn error_sigil_na_followed_by_letter_does_not_over_consume() {
        // `#N/A` ends without trailing punct. The next char `5` should
        // start a separate token.
        let toks = lex_ok("#N/A 5");
        assert_eq!(toks.len(), 2);
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::NA));
        assert!(matches!(toks[1], Token::Number(n) if n == 5.0));
    }

    #[test]
    fn error_sigil_in_array_lexes() {
        // Array literals with error literals (per design § 3.3):
        // `{1, #N/A, 3}` should lex without issue.
        let toks = lex_ok("{1, #N/A, 3}");
        assert_eq!(toks.len(), 7);
        assert_eq!(toks[0], Token::LBrace);
        assert!(matches!(toks[1], Token::Number(n) if n == 1.0));
        assert_eq!(toks[2], Token::Comma);
        assert_eq!(toks[3], Token::Error(ql_types::ErrorValue::NA));
        assert_eq!(toks[4], Token::Comma);
        assert!(matches!(toks[5], Token::Number(n) if n == 3.0));
        assert_eq!(toks[6], Token::RBrace);
    }

    #[test]
    fn invalid_error_sigil_surfaces_clean_error() {
        // `#NA` (no slash) doesn't match any known sigil — should
        // surface InvalidErrorSigil, NOT a partial match.
        let err = lex("#NA").unwrap_err();
        match err {
            LexError::InvalidErrorSigil(s) => assert_eq!(s, "#NA"),
            other => panic!("expected InvalidErrorSigil, got {other:?}"),
        }
    }

    #[test]
    fn invalid_error_sigil_empty_body_surfaces_clean_error() {
        // Just `#` with nothing after, or `#` followed by non-sigil chars.
        let err = lex("#").unwrap_err();
        assert!(matches!(err, LexError::InvalidErrorSigil(s) if s == "#"));
    }

    #[test]
    fn error_sigil_inside_function_call_lexes() {
        // `IFERROR(#REF!, 0)` should lex cleanly.
        let toks = lex_ok("IFERROR(#REF!, 0)");
        // Expected: BareColumn/Ident(IFERROR), LParen, Error(Ref), Comma, Number(0), RParen.
        assert_eq!(toks.len(), 6);
        assert_eq!(toks[1], Token::LParen);
        assert_eq!(toks[2], Token::Error(ql_types::ErrorValue::Ref));
        assert_eq!(toks[3], Token::Comma);
        assert!(matches!(toks[4], Token::Number(n) if n == 0.0));
        assert_eq!(toks[5], Token::RParen);
    }

    // W5-97 closure (Sonnet M1): positive lex tests for the five
    // Quantbook-specific sigils — guards a future `ErrorValue::ALL`
    // maintenance regression. `#AI_NOT_AVAILABLE_V1` is structurally
    // distinct because it ends with a DIGIT (not `!` or `?`), so its
    // no-over-consume behavior is exercised by `..._not_available_v1`
    // tests below.

    #[test]
    fn error_sigil_disconnected_lexes() {
        let toks = lex_ok("#DISCONNECTED!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Disconnected));
    }

    #[test]
    fn error_sigil_binding_lexes() {
        let toks = lex_ok("#BINDING!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Binding));
    }

    #[test]
    fn error_sigil_timeout_lexes() {
        let toks = lex_ok("#TIMEOUT!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Timeout));
    }

    #[test]
    fn error_sigil_permission_lexes() {
        let toks = lex_ok("#PERMISSION!");
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::Permission));
    }

    #[test]
    fn error_sigil_ai_not_available_v1_lexes() {
        // Ends with `_V1` — a digit-terminated sigil, not `!`/`?`.
        // Exercises the no-over-consume path on a non-punctuation
        // terminator (analogous to `#N/A` for the canonical sigils).
        let toks = lex_ok("#AI_NOT_AVAILABLE_V1");
        assert_eq!(toks.len(), 1);
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::AINotAvailable));
    }

    #[test]
    fn error_sigil_ai_not_available_v1_followed_by_space_does_not_over_consume() {
        // `#AI_NOT_AVAILABLE_V1 5` → AINotAvailable + Number(5).
        let toks = lex_ok("#AI_NOT_AVAILABLE_V1 5");
        assert_eq!(toks.len(), 2);
        assert_eq!(toks[0], Token::Error(ql_types::ErrorValue::AINotAvailable));
        assert!(matches!(toks[1], Token::Number(n) if n == 5.0));
    }

    // ===== W5-111 (Phase 4.8.B) — structured references =====

    #[test]
    fn structured_ref_simple_column() {
        let toks = lex_ok("Sales[Qty]");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                assert_eq!(table_name.as_ref(), "Sales");
                assert_eq!(bracket_content.as_ref(), "Qty");
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    #[test]
    fn structured_ref_with_nested_brackets() {
        // `Sales[[#Headers], [Qty]]` — outer `[` opens at depth 1; the inner
        // `[`s increment depth to 2; their `]`s drop back to 1; the final
        // `]` drops to 0 and closes.
        let toks = lex_ok("Sales[[#Headers], [Qty]]");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                assert_eq!(table_name.as_ref(), "Sales");
                assert_eq!(bracket_content.as_ref(), "[#Headers], [Qty]");
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    /// Each of the 5 OOXML escape pairs is PRESERVED as `'X` 2-char
    /// atoms in the bracket content (the lexer's balancer is escape-
    /// aware but doesn't substitute — see lexer module doc + design § 5.1).
    /// The parser's structured-ref sub-grammar resolves the escapes
    /// structurally (4.8.D refactor).
    #[test]
    fn structured_ref_escape_pairs() {
        // `'[`, `']`, `'#`, `'@`, `''` escapes.
        let cases = [
            ("Tbl['[a]", "'[a"), // escaped opening bracket inside content
            ("Tbl[a']]", "a']"), // escaped closing bracket
            ("Tbl['#Hash]", "'#Hash"),
            ("Tbl['@AtSign]", "'@AtSign"),
            ("Tbl[Bob''s]", "Bob''s"),
        ];
        for (src, expected_content) in cases {
            let toks = lex_ok(src);
            assert_eq!(toks.len(), 1, "case {src:?} produced wrong token count");
            match &toks[0] {
                Token::StructuredRef {
                    bracket_content, ..
                } => {
                    assert_eq!(bracket_content.as_ref(), expected_content, "case {src:?}");
                }
                other => panic!("case {src:?} → expected StructuredRef, got {other:?}"),
            }
        }
    }

    #[test]
    fn structured_ref_unterminated_bracket_errors() {
        let err = lex("Tbl[abc").unwrap_err();
        assert_eq!(err, LexError::UnterminatedStructuredRef);
    }

    #[test]
    fn structured_ref_dangling_escape_errors() {
        // `'` is the LAST character before EOF inside bracket content.
        let err = lex("Tbl[abc'").unwrap_err();
        assert_eq!(err, LexError::DanglingStructuredRefEscape);
    }

    /// **#148 closure (Phase 4.7.N follow-up):** `Src` is a valid 3-letter
    /// column letter (S=19, R=18, C=3 → column 12,950) and would lex as
    /// `BareColumn` PRE-4.8.B. The Ident-with-`[`-lookahead in
    /// `lex_ident_or_ref` pre-empts: `Src[Col]` lexes as StructuredRef.
    #[test]
    fn issue_148_closure_src_lexes_as_structured_ref() {
        let toks = lex_ok("Src[Col]");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                assert_eq!(table_name.as_ref(), "Src");
                assert_eq!(bracket_content.as_ref(), "Col");
            }
            other => panic!("expected StructuredRef for Src[Col], got {other:?}"),
        }
    }

    /// Sibling regression: `AAA[Col]` — `AAA` is column 702. Pre-4.8.B the
    /// lexer would emit `BareColumn{col=702}` then a `LBrace`? No — `[` is
    /// not even in the existing token vocabulary outside structured refs.
    /// Pre-4.8.B `AAA[Col]` would have lexed as `BareColumn + UnexpectedChar('[')`.
    #[test]
    fn issue_148_closure_aaa_lexes_as_structured_ref() {
        let toks = lex_ok("AAA[Col]");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                assert_eq!(table_name.as_ref(), "AAA");
                assert_eq!(bracket_content.as_ref(), "Col");
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    /// A bare column followed by anything OTHER than `[` still lexes as
    /// `BareColumn` (no regression). `A:A` test is below; here we just
    /// check `Src` without a following `[`.
    #[test]
    fn bare_column_without_bracket_still_lexes_as_bare_column() {
        let toks = lex_ok("Src");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::BareColumn { col, abs, text } => {
                assert!(!abs);
                assert_eq!(text.as_ref(), "Src");
                // S=19, R=18, C=3 — value computed below for spot-check.
                let expected = (19u32 * 26 + 18) * 26 + 3 - 1;
                assert_eq!(*col, expected);
            }
            other => panic!("expected BareColumn for `Src`, got {other:?}"),
        }
    }

    /// `A:A` regression: bare-column followed by `:` followed by bare-
    /// column. The `[`-lookahead must NOT fire for `A:A`. (Existing
    /// test `whole_column_range_a_a_lexes_as_two_bare_columns_and_colon`
    /// at line ~1097 already covers this; restated here for clarity
    /// since the lookahead change affected the same code path.)
    #[test]
    fn issue_148_closure_a_colon_a_still_works() {
        let toks = lex_ok("A:A");
        assert_eq!(toks.len(), 3);
        assert!(matches!(toks[0], Token::BareColumn { col: 0, .. }));
        assert!(matches!(toks[1], Token::Colon));
        assert!(matches!(toks[2], Token::BareColumn { col: 0, .. }));
    }

    /// Function-name-like table refs lex as StructuredRef. Per design
    /// § 5.2 the lexer no longer excludes function names; table-name
    /// validation in create_table (4.8.H) rejects illegal names.
    #[test]
    fn function_name_table_ref_lexes_as_structured_ref() {
        let toks = lex_ok("SUM[Qty]");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                assert_eq!(table_name.as_ref(), "SUM");
                assert_eq!(bracket_content.as_ref(), "Qty");
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    /// `A[0]` — `A` is column 0; without lookahead this would be
    /// BareColumn + `[` + Number + `]`. With lookahead, the `[` triggers
    /// StructuredRef capture; `bracket_content` is `"0"`. Table-name
    /// validation in 4.8.H rejects `A` as a table name (it's a cell-ref
    /// pattern), so `A[0]` surfaces as `BindError::UnknownTable("A")` —
    /// behavior change is intentional per design § 5.3.
    #[test]
    fn a_bracket_zero_lexes_as_structured_ref() {
        let toks = lex_ok("A[0]");
        assert_eq!(toks.len(), 1);
        match &toks[0] {
            Token::StructuredRef {
                table_name,
                bracket_content,
            } => {
                assert_eq!(table_name.as_ref(), "A");
                assert_eq!(bracket_content.as_ref(), "0");
            }
            other => panic!("expected StructuredRef, got {other:?}"),
        }
    }

    /// `$A` cannot precede `[` — `$` is the absolute-marker, table names
    /// don't carry `$`. `$A[X]` would be `$A` (BareColumn abs) then `[X]`
    /// — and since `[X]` outside an Ident-`[` context is a lexer error,
    /// the test asserts the lookahead skips the `[` for `$`-prefixed
    /// idents.
    #[test]
    fn dollar_prefixed_ident_does_not_match_structured_ref_lookahead() {
        // `$A[1]` should lex as `BareColumn(A, abs)` + `[1]`-style
        // unsupported. Actually `[` outside structured-ref is going to
        // surface SOME error. We just need to confirm the FIRST token is
        // a `BareColumn` not a `StructuredRef`.
        let result = lex("$A[1]");
        // Either errors (the `[` is an unexpected char on its own) or
        // produces BareColumn-first. Either way the first token is NOT
        // StructuredRef.
        match result {
            Ok(toks) => match &toks[0] {
                Token::BareColumn { abs: true, .. } => {}
                other => panic!("expected first token BareColumn(abs), got {other:?}"),
            },
            Err(_) => {
                // Acceptable — `[` may surface as UnexpectedChar; the
                // invariant is that `$A` was NOT pulled into a
                // StructuredRef.
            }
        }
    }

    // ===== W5-134 (Phase 4.9.B.1) — lex_with signature scaffolding =====

    /// `lex(input)` and `lex_with(input, A1, EnUs)` must produce
    /// identical token streams — the shim is a pure delegation. Pin
    /// across the representative grammar to catch any future drift.
    #[test]
    fn lex_and_lex_with_a1_enus_match_on_representative_inputs() {
        let cases = [
            "",
            "1",
            "1+2*3",
            "SUM(A1, A2, A3)",
            "A1:B10",
            "'Sheet 1'!A1",
            "{1, 2; 3, 4}",
            "\"hello\"",
            "#REF!",
            "Sales[Qty]",
            "Sales[@Qty]*2",
            "FALSE",
            "1.5e-3",
        ];
        for src in cases {
            let a = lex(src);
            let b = lex_with(src, ReferenceMode::A1, Locale::EnUs);
            assert_eq!(a, b, "lex vs lex_with diverge on input: {src:?}");
        }
    }

    /// **W5-134 contract, relaxed in W5-136:** `lex_with(input,
    /// mode, locale)` must not PANIC for any `(mode, locale)` pair.
    /// Returning `Err` is a valid outcome — DE/FR will reject
    /// EN-syntax input like `SUM(A1, A2)` because `,` is the
    /// decimal separator in DE/FR, not an arg separator. The
    /// original assertion (`is_ok()`) was overly strict; the actual
    /// contract has always been "no panic."
    #[test]
    fn lex_with_accepts_all_mode_locale_combinations_without_panic() {
        let src = "SUM(A1, A2)";
        for mode in [ReferenceMode::A1, ReferenceMode::R1C1] {
            for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
                // `let _` discards Ok/Err — only a panic would fail
                // the test.
                let _ = lex_with(src, mode, locale);
            }
        }
    }

    // ===== W5-135 (Phase 4.9.B.2) — locale decimal separator =====
    //
    // Tripwire test `lex_with_pre_4_9_b_2_is_locale_invariant` from
    // W5-134 was deliberately deleted here: it asserted that locale
    // had NO effect on lex output, which was true at 4.9.B.1 but
    // false now that 4.9.B.2 wires `decimal_sep`. The tests below
    // pin the new locale-dependent behavior.

    #[test]
    fn de_locale_treats_comma_inside_number_as_decimal() {
        // `2,34` in DE → Number(2.34).
        let tokens = lex_with("2,34", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(tokens, vec![Token::Number(2.34)]);
    }

    #[test]
    fn fr_locale_treats_comma_inside_number_as_decimal() {
        // `2,5` in FR → Number(2.5).
        let tokens = lex_with("2,5", ReferenceMode::A1, Locale::Fr).unwrap();
        assert_eq!(tokens, vec![Token::Number(2.5)]);
    }

    #[test]
    fn en_locale_treats_dot_inside_number_as_decimal_unchanged() {
        // `2.34` in EN-US → Number(2.34). Identical to pre-W5-135.
        let tokens = lex_with("2.34", ReferenceMode::A1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![Token::Number(2.34)]);
    }

    /// **Pre-W5-135 behavior preserved in EN.** `2,34` in EN-US
    /// lexes as `Number(2) Comma Number(34)` — the `,` is the arg
    /// separator at top level. This must NOT regress.
    #[test]
    fn en_locale_treats_comma_outside_number_as_comma_token() {
        let tokens = lex_with("2,34", ReferenceMode::A1, Locale::EnUs).unwrap();
        assert_eq!(
            tokens,
            vec![Token::Number(2.0), Token::Comma, Token::Number(34.0)]
        );
    }

    /// **DE doesn't accept `.` as decimal.** Post-W5-136 outcome:
    /// number-lex consumes the `2`, breaks at `.` (not a digit, not
    /// DE's decimal_sep `,`, not exponent). The next loop iteration's
    /// pre-dispatch intercepts `.` as `Token::Semicolon` (DE's array-
    /// row separator). Then `34` lex as another number. Result:
    /// `[Number(2), Semicolon, Number(34)]` — three tokens, not one
    /// `Number(2.34)`. The parser rejects this stream as invalid
    /// expression syntax (a number can't follow a Semicolon outside
    /// an array literal); the lexer is correct.
    ///
    /// Originally (pre-W5-136) the `.` would have surfaced as
    /// `UnexpectedChar`; that path is no longer reachable. Tightened
    /// per Sonnet mid-arc-audit L-5 to assert the exact post-W5-136
    /// token stream rather than a too-broad "not Number(2.34)".
    #[test]
    fn de_locale_dot_not_decimal_splits_into_three_tokens() {
        let tokens = lex_with("2.34", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(
            tokens,
            vec![Token::Number(2.0), Token::Semicolon, Token::Number(34.0)],
            "DE `2.34` must lex as three tokens, not Number(2.34)"
        );
    }

    /// **Scientific notation in DE.** `2,5e-3` should lex as
    /// `Number(0.0025)` — the `,` is decimal, `e-3` is exponent.
    /// Mirror IronCalc's `test_german_locale` reference.
    #[test]
    fn de_locale_scientific_notation_with_comma_decimal() {
        let tokens = lex_with("2,5e-3", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(tokens, vec![Token::Number(2.5e-3)]);
    }

    /// **EN happy-path regression pin.** The number-lex changes
    /// introduce a new dispatch arm and refactor `lex_number`'s body
    /// from `match c { ... }` to `if c.is_ascii_digit() { ... }
    /// else if c == decimal_sep { ... }`. Every existing EN number
    /// representation must continue to round-trip identically.
    #[test]
    fn en_number_lex_regression_battery() {
        let cases: &[(&str, f64)] = &[
            ("0", 0.0),
            ("1", 1.0),
            ("12345", 12345.0),
            ("0.5", 0.5),
            (".5", 0.5),
            ("1.5e3", 1500.0),
            ("1.5e+3", 1500.0),
            ("1.5e-3", 0.0015),
            ("1E10", 1e10),
        ];
        for (src, expected) in cases {
            let tokens = lex_with(src, ReferenceMode::A1, Locale::EnUs).unwrap();
            match tokens.as_slice() {
                [Token::Number(n)] => assert_eq!(
                    *n, *expected,
                    "EN regression: {src:?} expected {expected}, got {n}"
                ),
                other => panic!("EN regression: {src:?} expected single Number, got {other:?}"),
            }
        }
    }

    // ===== W5-136 (Phase 4.9.B.3) — locale-aware arg/array separators =====

    /// **DE arg separator**: `SUM(1;2)` lexes the same way
    /// `SUM(1,2)` does in EN. The token vocab stays the same; only
    /// the source glyph mapping changes. (Note: the lexer emits
    /// `SUM` as `Token::BareColumn` because letters look like column
    /// refs; the parser disambiguates to a function call when `(`
    /// follows. This is pre-existing EN behavior — we pin the SAME
    /// stream for DE.)
    #[test]
    fn de_locale_semicolon_acts_as_arg_separator() {
        let de = lex_with("SUM(1;2)", ReferenceMode::A1, Locale::De).unwrap();
        let en = lex_with("SUM(1,2)", ReferenceMode::A1, Locale::EnUs).unwrap();
        assert_eq!(
            de, en,
            "DE `SUM(1;2)` and EN `SUM(1,2)` must yield identical token streams"
        );
    }

    /// **DE array col separator** `\\`: `1\\2` lexes as `Number(1),
    /// Comma, Number(2)`. EN array col is `,` (same role-token), so
    /// the parser sees identical structure regardless of locale.
    #[test]
    fn de_locale_backslash_acts_as_array_col_separator() {
        let tokens = lex_with("1\\2", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(
            tokens,
            vec![Token::Number(1.0), Token::Comma, Token::Number(2.0)]
        );
    }

    /// **DE array row separator** `.`: `1.2` (no decimal context)
    /// lexes as `Number(1), Semicolon, Number(2)`. The `.` is intercepted
    /// by the pre-dispatch (role: array-row-separator in DE), NOT
    /// number-lex (decimal-sep in DE is `,`). Mirrors EN's `1;2` →
    /// `Number(1), Semicolon, Number(2)`.
    #[test]
    fn de_locale_dot_acts_as_array_row_separator() {
        let tokens = lex_with("1.2", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(
            tokens,
            vec![Token::Number(1.0), Token::Semicolon, Token::Number(2.0)]
        );
    }

    /// **Full DE array literal** `{1\\2.3\\4}` parses as a 2×2 array
    /// (matching EN `{1,2;3,4}`). Tokens: `LBrace, Number(1), Comma,
    /// Number(2), Semicolon, Number(3), Comma, Number(4), RBrace`.
    #[test]
    fn de_locale_full_array_literal_lexes_as_2x2() {
        let tokens = lex_with("{1\\2.3\\4}", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(
            tokens,
            vec![
                Token::LBrace,
                Token::Number(1.0),
                Token::Comma,
                Token::Number(2.0),
                Token::Semicolon,
                Token::Number(3.0),
                Token::Comma,
                Token::Number(4.0),
                Token::RBrace,
            ]
        );
    }

    /// **DE leading-`,` decimal** — closes the gap from 4.9.B.2's
    /// docstring. `,5` in DE was previously hitting the literal `,`
    /// arm (deleted in 4.9.B.3); now the pre-dispatch doesn't match
    /// `,` (it's decimal_sep, not arg/array-sep), so the decimal-
    /// start arm fires and lexes the leading-comma number.
    #[test]
    fn de_locale_leading_comma_is_decimal_start() {
        let tokens = lex_with(",5", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(tokens, vec![Token::Number(0.5)]);
    }

    /// **EN regression battery — `,` and `;` unchanged.** Pin the
    /// pre-existing EN behavior: `,` is `Comma`, `;` is `Semicolon`,
    /// `{1,2;3,4}` is a 2×2 array. The pre-dispatch maps each glyph
    /// to the SAME token it did before (EN arg/array-col = `,` →
    /// Comma; EN array-row = `;` → Semicolon). Net change for EN
    /// must be zero.
    #[test]
    fn en_locale_separators_unchanged_after_4_9_b_3() {
        // Comma + Semicolon at top level.
        let tokens = lex_with("a,b;c", ReferenceMode::A1, Locale::EnUs).unwrap();
        assert_eq!(tokens.len(), 5);
        assert!(matches!(&tokens[0], Token::BareColumn { .. }));
        assert_eq!(tokens[1], Token::Comma);
        assert!(matches!(&tokens[2], Token::BareColumn { .. }));
        assert_eq!(tokens[3], Token::Semicolon);
        assert!(matches!(&tokens[4], Token::BareColumn { .. }));
        // Full EN array literal.
        let arr = lex_with("{1,2;3,4}", ReferenceMode::A1, Locale::EnUs).unwrap();
        assert_eq!(
            arr,
            vec![
                Token::LBrace,
                Token::Number(1.0),
                Token::Comma,
                Token::Number(2.0),
                Token::Semicolon,
                Token::Number(3.0),
                Token::Comma,
                Token::Number(4.0),
                Token::RBrace,
            ]
        );
    }

    /// **DE separator dispatch — happy path.** `5;6` in DE: `5` →
    /// Number, `;` → Comma (DE's arg separator, intercepted by pre-
    /// dispatch), `6` → Number. Pinned tightly to the role-token
    /// invariance contract.
    ///
    /// Closes Codex mid-arc-audit LOW on the prior stale comment
    /// which incorrectly claimed bare `,` in DE produces
    /// `Number(0.0)`. Actual behavior: bare `,` (no following digit)
    /// triggers `lex_number` to consume `,` (it's decimal_sep in
    /// DE), translate to raw `"."`, hit EOF or non-digit, then
    /// `"."`-parse fails → `LexError::InvalidNumber(".")`. NOT
    /// `Number(0.0)`. The case is documented for future-self
    /// reference but not exercised in this test (the happy path is
    /// the load-bearing pin).
    #[test]
    fn de_locale_separator_pair_dispatch_disambiguates_correctly() {
        let tokens = lex_with("5;6", ReferenceMode::A1, Locale::De).unwrap();
        assert_eq!(
            tokens,
            vec![Token::Number(5.0), Token::Comma, Token::Number(6.0)]
        );
    }

    /// **DE bare `,` errors loudly.** Pins the actual behavior
    /// (`InvalidNumber(".")`) corrected from the stale prior claim
    /// in `de_locale_separator_pair_dispatch_disambiguates_correctly`'s
    /// docstring. Closes Codex mid-arc-audit LOW.
    #[test]
    fn de_locale_bare_comma_errors_invalid_number() {
        let result = lex_with(",", ReferenceMode::A1, Locale::De);
        match result {
            Err(LexError::InvalidNumber(s)) => assert_eq!(s, "."),
            other => panic!("expected InvalidNumber(\".\"), got {other:?}"),
        }
    }

    // ---------------------------------------------------------------
    // W5-138 (Phase 4.9.B.4) — R1C1 token emission tests.
    //
    // Mode gating: every R1C1 behavior fires only when `mode ==
    // ReferenceMode::R1C1`. A1 mode is byte-identical to pre-W5-138.
    // ---------------------------------------------------------------

    use crate::token::AxisSpec;

    fn r1c1(row: AxisSpec, col: AxisSpec) -> Token {
        Token::R1C1Ref {
            row_axis: row,
            col_axis: col,
        }
    }

    /// **A1 mode preserved.** `R1` in A1 mode is still a `CellRef`,
    /// not an R1C1 token. The R1C1 dispatch is mode-gated.
    #[test]
    fn r1c1_a1_mode_leaves_r1_as_cellref() {
        let tokens = lex_with("R1", ReferenceMode::A1, Locale::EnUs).unwrap();
        // Column R = 17 (0-indexed). Row 0 (0-indexed).
        assert!(matches!(
            tokens.as_slice(),
            [Token::CellRef {
                col: 17,
                row: 0,
                ..
            }]
        ));
    }

    /// **R1C1 absolute pair.** `R1C1` → `R1C1Ref { Abs(1), Abs(1) }`.
    #[test]
    fn r1c1_absolute_pair_lexes_to_r1c1ref() {
        let tokens = lex_with("R1C1", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![r1c1(AxisSpec::Abs(1), AxisSpec::Abs(1))]);
    }

    /// **R1C1 case-insensitivity.** Lowercase `r1c1` lexes the same.
    #[test]
    fn r1c1_lowercase_lexes_same_as_uppercase() {
        let lo = lex_with("r1c1", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        let up = lex_with("R1C1", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(lo, up);
    }

    /// **Mixed-case `R1c1` accepted.** Excel canon accepts both
    /// cases independently per axis-prefix letter.
    #[test]
    fn r1c1_mixed_case_axis_prefixes_accepted() {
        let tokens = lex_with("R1c1", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![r1c1(AxisSpec::Abs(1), AxisSpec::Abs(1))]);
    }

    /// **Relative `R[-1]C`.** `R[-1]C` → `Rel(-1)` row, `Rel(0)` col.
    /// Bare `C` canonicalizes to `Rel(0)`.
    #[test]
    fn r1c1_relative_negative_row_bare_col_lexes() {
        let tokens = lex_with("R[-1]C", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![r1c1(AxisSpec::Rel(-1), AxisSpec::Rel(0))]);
    }

    /// **Relative `R[2]C[3]`.** Both axes relative, positive offsets.
    #[test]
    fn r1c1_relative_positive_offsets_both_axes() {
        let tokens = lex_with("R[2]C[3]", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![r1c1(AxisSpec::Rel(2), AxisSpec::Rel(3))]);
    }

    /// **Bare `RC` ≡ `Rel(0)` on both axes.** "This cell" form.
    #[test]
    fn r1c1_bare_rc_canonicalizes_to_rel_zero() {
        let tokens = lex_with("RC", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![r1c1(AxisSpec::Rel(0), AxisSpec::Rel(0))]);
    }

    /// **Mixed `R1C[2]`.** Absolute row, relative col.
    #[test]
    fn r1c1_mixed_abs_row_rel_col() {
        let tokens = lex_with("R1C[2]", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![r1c1(AxisSpec::Abs(1), AxisSpec::Rel(2))]);
    }

    /// **Explicit `+` sign in brackets.** `R[+3]C` → `Rel(3)`.
    #[test]
    fn r1c1_explicit_positive_sign_in_brackets() {
        let tokens = lex_with("R[+3]C", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens, vec![r1c1(AxisSpec::Rel(3), AxisSpec::Rel(0))]);
    }

    /// **Range `R1C1:R10C5`.** Lexer emits `R1C1Ref + Colon +
    /// R1C1Ref`; parser builds the range in 4.9.C.
    #[test]
    fn r1c1_range_lexes_as_two_refs_joined_by_colon() {
        let tokens = lex_with("R1C1:R10C5", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(
            tokens,
            vec![
                r1c1(AxisSpec::Abs(1), AxisSpec::Abs(1)),
                Token::Colon,
                r1c1(AxisSpec::Abs(10), AxisSpec::Abs(5)),
            ]
        );
    }

    /// **Bounds: max absolute row.** `R1048576C16384` = (MAX_ROW+1,
    /// MAX_COLUMN+1) — accepted at the boundary.
    #[test]
    fn r1c1_at_grid_boundary_accepted() {
        let tokens = lex_with("R1048576C16384", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(
            tokens,
            vec![r1c1(AxisSpec::Abs(1_048_576), AxisSpec::Abs(16_384))]
        );
    }

    /// **Row absolute `0` rejected.** R1C1 is 1-indexed.
    #[test]
    fn r1c1_absolute_zero_row_rejected_as_malformed() {
        let result = lex_with("R0C1", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **Column absolute `0` rejected.** R1C1 is 1-indexed.
    #[test]
    fn r1c1_absolute_zero_col_rejected_as_malformed() {
        let result = lex_with("R1C0", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **Row over MAX_ROW+1 → `RowTooLarge`.** Distinct error from
    /// `MalformedR1C1` so the diagnostic matches Excel's "row out of
    /// range" phrasing.
    #[test]
    fn r1c1_row_overflow_uses_row_too_large_error() {
        let result = lex_with("R1048577C1", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::RowTooLarge(_))));
    }

    /// **Col over MAX_COLUMN+1 → `ColumnTooLarge`.**
    #[test]
    fn r1c1_col_overflow_uses_column_too_large_error() {
        let result = lex_with("R1C16385", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::ColumnTooLarge(_))));
    }

    /// **`R1` (no `C`) → MalformedR1C1.** Committed on digit, then
    /// expected `C`/`c` next — but hit EOF.
    #[test]
    fn r1c1_missing_c_axis_after_committed_r_rejected() {
        let result = lex_with("R1", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **`R1+` → MalformedR1C1.** Committed on digit; `+` is not
    /// `C`/`c`.
    #[test]
    fn r1c1_committed_then_non_c_rejected() {
        let result = lex_with("R1+", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **Empty brackets `R[]C` → MalformedR1C1.**
    #[test]
    fn r1c1_empty_brackets_rejected() {
        let result = lex_with("R[]C1", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **Sign-only brackets `R[+]C` → MalformedR1C1.** Has sign but
    /// no digit.
    #[test]
    fn r1c1_sign_only_brackets_rejected() {
        let result = lex_with("R[+]C1", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **Unterminated brackets `R[1C` → MalformedR1C1.** Saw `[1`
    /// but no `]` before the next token boundary.
    #[test]
    fn r1c1_unterminated_brackets_rejected() {
        let result = lex_with("R[1C", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **Decimal in brackets `R[1.5]C` → MalformedR1C1.** `1` parsed,
    /// then `.` is not `]`.
    #[test]
    fn r1c1_decimal_in_brackets_rejected() {
        let result = lex_with("R[1.5]C", ReferenceMode::R1C1, Locale::EnUs);
        assert!(matches!(result, Err(LexError::MalformedR1C1(_))));
    }

    /// **Back-off: `Range` in R1C1 mode.** `R` followed by `a` is NOT
    /// a commit-trigger — falls through to identifier lex. The
    /// remaining text behaves like the existing identifier dispatch
    /// (Excel canon would produce different tokens for the same input
    /// in A1 vs R1C1 modes; here both modes back off on `R`+letter-
    /// not-C and produce identical tokens).
    #[test]
    fn r1c1_back_off_on_r_followed_by_non_c_letter() {
        let r1c1_tokens = lex_with("Range", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        let a1_tokens = lex_with("Range", ReferenceMode::A1, Locale::EnUs).unwrap();
        assert_eq!(r1c1_tokens, a1_tokens);
    }

    /// **Back-off: bare `R`+space in R1C1 mode falls through to
    /// identifier lex.** Subsequent `1` lexes as a number.
    #[test]
    fn r1c1_back_off_on_r_followed_by_whitespace() {
        let tokens = lex_with("R 1", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        // Falls through: `R` becomes BareColumn, then whitespace, then
        // `1` → Number.
        assert_eq!(tokens.len(), 2);
        assert!(matches!(tokens[0], Token::BareColumn { col: 17, .. }));
        assert!(matches!(tokens[1], Token::Number(n) if n == 1.0));
    }

    /// **A1 mode unaffected for `RC`.** In A1 mode the dispatch is
    /// skipped entirely; `RC` lexes as a 2-letter column identifier
    /// (BareColumn). This is the back-compat invariant.
    #[test]
    fn r1c1_dispatch_skipped_in_a1_mode_for_rc() {
        let a1 = lex_with("RC", ReferenceMode::A1, Locale::EnUs).unwrap();
        let r1c1_mode = lex_with("RC", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_ne!(a1, r1c1_mode);
        assert!(matches!(a1.as_slice(), [Token::BareColumn { .. }]));
        assert_eq!(r1c1_mode, vec![r1c1(AxisSpec::Rel(0), AxisSpec::Rel(0))]);
    }

    /// **R1C1 mode + DE locale composes correctly.** Locale separator
    /// pre-dispatch and R1C1 ref dispatch are independent. `R1C1;R2C2`
    /// in DE/R1C1 → two refs separated by `Comma` (DE's `;` is arg-sep).
    #[test]
    fn r1c1_mode_composes_with_de_locale() {
        let tokens = lex_with("R1C1;R2C2", ReferenceMode::R1C1, Locale::De).unwrap();
        assert_eq!(
            tokens,
            vec![
                r1c1(AxisSpec::Abs(1), AxisSpec::Abs(1)),
                Token::Comma,
                r1c1(AxisSpec::Abs(2), AxisSpec::Abs(2)),
            ]
        );
    }

    /// **Inside a function call `SUM(R1C1,R2C2)`.** Confirms R1C1
    /// tokens coexist with parens + commas as a parser-ready
    /// stream.
    #[test]
    fn r1c1_inside_function_call_tokenizes_cleanly() {
        let tokens = lex_with("SUM(R1C1,R2C2)", ReferenceMode::R1C1, Locale::EnUs).unwrap();
        assert_eq!(tokens.len(), 6);
        // SUM lexes as BareColumn (parser disambiguates as fn-call later).
        assert!(matches!(tokens[0], Token::BareColumn { .. }));
        assert!(matches!(tokens[1], Token::LParen));
        assert_eq!(tokens[2], r1c1(AxisSpec::Abs(1), AxisSpec::Abs(1)));
        assert!(matches!(tokens[3], Token::Comma));
        assert_eq!(tokens[4], r1c1(AxisSpec::Abs(2), AxisSpec::Abs(2)));
        assert!(matches!(tokens[5], Token::RParen));
    }
}
