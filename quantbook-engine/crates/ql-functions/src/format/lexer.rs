//! Flat token stream over an Excel format string.
//!
//! See `docs/architecture/2026-05-13-format-string-grammar.md` § 2 (EBNF)
//! and § 6 (V1/V2 token table) for scope. The lexer is intentionally dumb:
//! it emits a flat sequence of tokens. Section splitting + m/mm
//! disambiguation + section-kind classification all live in the parser.

use super::error::{FormatParseError, V2Token};

/// One lexical token. Position info on each variant points back into the
/// source string so error reporting can cite locations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Token {
    // Digits + punctuation
    Zero {
        pos: usize,
    },
    Sharp {
        pos: usize,
    },
    Question {
        pos: usize,
    },
    Period {
        pos: usize,
    },
    Comma {
        pos: usize,
    },
    Percent {
        pos: usize,
    },
    Scientific {
        pos: usize,
        signed_minus: bool,
    },

    // Date / time keyword runs (case-insensitive, length-disambiguated)
    DateY {
        pos: usize,
        len: u32,
    }, // y/yy → short, yyyy → long; 3/5+ → error
    DateM {
        pos: usize,
        len: u32,
    }, // m/mm/mmm/mmmm/mmmmm (role resolved by parser)
    DateD {
        pos: usize,
        len: u32,
    }, // d/dd/ddd/dddd
    TimeH {
        pos: usize,
        len: u32,
    }, // h/hh
    TimeS {
        pos: usize,
        len: u32,
    }, // s/ss
    AmPm {
        pos: usize,
    }, // AM/PM, am/pm, A/P, a/p

    // Text / literal
    QuotedText {
        pos: usize,
        value: String,
    },
    EscapedChar {
        pos: usize,
        ch: char,
    },
    DirectCurrency {
        pos: usize,
        ch: char,
    }, // $ € £ ¥ directly
    BracketCurrency {
        pos: usize,
        ch: char,
        locale_code: Option<u32>,
    }, // [$€-409]
    Literal {
        pos: usize,
        ch: char,
    },
    Raw {
        pos: usize,
    }, // @
    Spacer {
        pos: usize,
        ch: char,
    }, // *X
    Ghost {
        pos: usize,
        ch: char,
    }, // _X
    Separator {
        pos: usize,
    }, // ;

    General {
        pos: usize,
    },
}

impl Token {
    pub fn position(&self) -> usize {
        match self {
            Token::Zero { pos }
            | Token::Sharp { pos }
            | Token::Question { pos }
            | Token::Period { pos }
            | Token::Comma { pos }
            | Token::Percent { pos }
            | Token::Scientific { pos, .. }
            | Token::DateY { pos, .. }
            | Token::DateM { pos, .. }
            | Token::DateD { pos, .. }
            | Token::TimeH { pos, .. }
            | Token::TimeS { pos, .. }
            | Token::AmPm { pos }
            | Token::QuotedText { pos, .. }
            | Token::EscapedChar { pos, .. }
            | Token::DirectCurrency { pos, .. }
            | Token::BracketCurrency { pos, .. }
            | Token::Literal { pos, .. }
            | Token::Raw { pos }
            | Token::Spacer { pos, .. }
            | Token::Ghost { pos, .. }
            | Token::Separator { pos }
            | Token::General { pos } => *pos,
        }
    }
}

/// Tokenize `input` into a flat token stream. Returns the first
/// `FormatParseError` on malformed input.
pub fn tokenize(input: &str) -> Result<Vec<Token>, FormatParseError> {
    if input.is_empty() {
        return Err(FormatParseError::Empty);
    }
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        let c = chars[i];
        match c {
            '0' => {
                tokens.push(Token::Zero { pos: start });
                i += 1;
            }
            '#' => {
                tokens.push(Token::Sharp { pos: start });
                i += 1;
            }
            '?' => {
                tokens.push(Token::Question { pos: start });
                i += 1;
            }
            '.' => {
                tokens.push(Token::Period { pos: start });
                i += 1;
            }
            ',' => {
                tokens.push(Token::Comma { pos: start });
                i += 1;
            }
            '%' => {
                tokens.push(Token::Percent { pos: start });
                i += 1;
            }
            ';' => {
                tokens.push(Token::Separator { pos: start });
                i += 1;
            }
            '@' => {
                tokens.push(Token::Raw { pos: start });
                i += 1;
            }
            '$' | '€' | '£' | '¥' => {
                tokens.push(Token::DirectCurrency { pos: start, ch: c });
                i += 1;
            }
            '"' => {
                // Quoted text — gather until the closing quote.
                let mut s = String::new();
                let mut j = i + 1;
                let mut closed = false;
                while j < chars.len() {
                    if chars[j] == '"' {
                        closed = true;
                        break;
                    }
                    s.push(chars[j]);
                    j += 1;
                }
                if !closed {
                    return Err(FormatParseError::UnterminatedQuotedText { position: start });
                }
                tokens.push(Token::QuotedText {
                    pos: start,
                    value: s,
                });
                i = j + 1;
            }
            '\\' => {
                if i + 1 >= chars.len() {
                    return Err(FormatParseError::TrailingBackslash { position: start });
                }
                tokens.push(Token::EscapedChar {
                    pos: start,
                    ch: chars[i + 1],
                });
                i += 2;
            }
            '_' => {
                if i + 1 >= chars.len() {
                    return Err(FormatParseError::TrailingSpacerOrGhost { position: start });
                }
                tokens.push(Token::Ghost {
                    pos: start,
                    ch: chars[i + 1],
                });
                i += 2;
            }
            '*' => {
                if i + 1 >= chars.len() {
                    return Err(FormatParseError::TrailingSpacerOrGhost { position: start });
                }
                tokens.push(Token::Spacer {
                    pos: start,
                    ch: chars[i + 1],
                });
                i += 2;
            }
            '[' => {
                // [...] block — currency, color, condition, or elapsed.
                // We dispatch the V2-deferred categories to UnsupportedV2.
                let (tok, advance) = lex_bracket_block(&chars, i)?;
                tokens.push(tok);
                i += advance;
            }
            // Date/time keyword runs (case-insensitive). Capture maximal run.
            'd' | 'D' | 'm' | 'M' | 'y' | 'Y' | 'h' | 'H' | 's' | 'S' => {
                let lower = c.to_ascii_lowercase();
                let mut j = i + 1;
                while j < chars.len() && chars[j].eq_ignore_ascii_case(&lower) {
                    j += 1;
                }
                let len = (j - i) as u32;
                let tok = match lower {
                    'd' => {
                        if len > 4 {
                            return Err(FormatParseError::Other {
                                position: start,
                                message: format!("invalid day token length {len}"),
                            });
                        }
                        Token::DateD { pos: start, len }
                    }
                    'm' => {
                        if len > 5 {
                            return Err(FormatParseError::Other {
                                position: start,
                                message: format!("invalid month token length {len}"),
                            });
                        }
                        Token::DateM { pos: start, len }
                    }
                    'y' => {
                        if !matches!(len, 1 | 2 | 4) {
                            return Err(FormatParseError::Other {
                                position: start,
                                message: format!("invalid year token length {len}"),
                            });
                        }
                        Token::DateY { pos: start, len }
                    }
                    'h' => {
                        if len > 2 {
                            return Err(FormatParseError::Other {
                                position: start,
                                message: format!("invalid hour token length {len}"),
                            });
                        }
                        Token::TimeH { pos: start, len }
                    }
                    's' => {
                        if len > 2 {
                            return Err(FormatParseError::Other {
                                position: start,
                                message: format!("invalid second token length {len}"),
                            });
                        }
                        Token::TimeS { pos: start, len }
                    }
                    _ => unreachable!("outer match restricted to dmyhs"),
                };
                tokens.push(tok);
                i = j;
            }
            // AM/PM, A/P (case-insensitive)
            'a' | 'A' | 'p' | 'P' => {
                if let Some(consumed) = try_lex_ampm(&chars, i) {
                    tokens.push(Token::AmPm { pos: start });
                    i += consumed;
                } else {
                    tokens.push(Token::Literal { pos: start, ch: c });
                    i += 1;
                }
            }
            // Scientific exponent — E+/E- only; bare E/e is a literal.
            'e' | 'E' if i + 1 < chars.len() && (chars[i + 1] == '+' || chars[i + 1] == '-') => {
                let signed_minus = chars[i + 1] == '-';
                tokens.push(Token::Scientific {
                    pos: start,
                    signed_minus,
                });
                i += 2;
            }
            'e' | 'E' => {
                tokens.push(Token::Literal { pos: start, ch: c });
                i += 1;
            }
            // "General" keyword (case-insensitive).
            'g' | 'G' if matches_keyword(&chars, i, "general") => {
                tokens.push(Token::General { pos: start });
                i += "general".len();
            }
            'g' | 'G' => {
                tokens.push(Token::Literal { pos: start, ch: c });
                i += 1;
            }
            // Pure literal characters per § 2 EBNF — punctuation / sign / space
            '(' | ')' | '+' | '-' | '{' | '}' | '<' | '=' | '!' | '~' | '>' | '^' | '\'' | '/'
            | ':' | ' ' => {
                tokens.push(Token::Literal { pos: start, ch: c });
                i += 1;
            }
            // Anything else — treat as a literal (forgiving for non-ASCII text).
            _ => {
                tokens.push(Token::Literal { pos: start, ch: c });
                i += 1;
            }
        }
    }
    Ok(tokens)
}

/// Try to match `keyword` (case-insensitive) starting at `start`. Returns
/// true if the next `keyword.len()` characters match.
fn matches_keyword(chars: &[char], start: usize, keyword: &str) -> bool {
    let kchars: Vec<char> = keyword.chars().collect();
    if start + kchars.len() > chars.len() {
        return false;
    }
    for (offset, kc) in kchars.iter().enumerate() {
        if !chars[start + offset].eq_ignore_ascii_case(kc) {
            return false;
        }
    }
    true
}

/// Try to recognize AM/PM at position `i`. Returns the consumed length on
/// success.
fn try_lex_ampm(chars: &[char], i: usize) -> Option<usize> {
    // AM/PM, am/pm  — 5 chars
    if i + 5 <= chars.len() {
        let candidate: String = chars[i..i + 5].iter().collect();
        if candidate.eq_ignore_ascii_case("AM/PM") || candidate.eq_ignore_ascii_case("PM/AM") {
            return Some(5);
        }
    }
    // A/P, a/p  — 3 chars
    if i + 3 <= chars.len() {
        let candidate: String = chars[i..i + 3].iter().collect();
        if candidate.eq_ignore_ascii_case("A/P") || candidate.eq_ignore_ascii_case("P/A") {
            return Some(3);
        }
    }
    None
}

/// Parse a `[...]` block starting at `chars[i]`. Returns the corresponding
/// token + the number of chars consumed (including the brackets).
fn lex_bracket_block(chars: &[char], i: usize) -> Result<(Token, usize), FormatParseError> {
    // Find the closing bracket.
    let mut j = i + 1;
    while j < chars.len() && chars[j] != ']' {
        j += 1;
    }
    if j >= chars.len() {
        return Err(FormatParseError::UnknownBracketBlock {
            position: i,
            content: chars[i + 1..].iter().collect(),
        });
    }
    let inner: String = chars[i + 1..j].iter().collect();
    let consumed = j - i + 1;

    // [$currency] or [$currency-LCID]
    if let Some(rest) = inner.strip_prefix('$') {
        let (sym, locale_code) = match rest.split_once('-') {
            Some((s, lcid_hex)) => {
                let lcid = u32::from_str_radix(lcid_hex.trim(), 16).map_err(|_| {
                    FormatParseError::UnknownBracketBlock {
                        position: i,
                        content: inner.clone(),
                    }
                })?;
                (s, Some(lcid))
            }
            None => (rest, None),
        };
        // The currency symbol is the first char of `sym`. Reject empty.
        let ch = sym
            .chars()
            .next()
            .ok_or_else(|| FormatParseError::UnknownBracketBlock {
                position: i,
                content: inner.clone(),
            })?;
        return Ok((
            Token::BracketCurrency {
                pos: i,
                ch,
                locale_code,
            },
            consumed,
        ));
    }

    // V2-deferred categories.
    let lower = inner.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "red" | "blue" | "green" | "yellow" | "magenta" | "cyan" | "white" | "black"
    ) || lower.starts_with("color ")
    {
        return Err(FormatParseError::UnsupportedV2 {
            kind: V2Token::ColorCodes,
            position: i,
        });
    }
    if matches!(lower.as_str(), "h" | "hh" | "m" | "mm" | "s" | "ss") {
        return Err(FormatParseError::UnsupportedV2 {
            kind: V2Token::ElapsedTime,
            position: i,
        });
    }
    // Conditional: starts with a comparator char.
    if matches!(lower.chars().next(), Some('<') | Some('>') | Some('=')) {
        return Err(FormatParseError::UnsupportedV2 {
            kind: V2Token::Conditional,
            position: i,
        });
    }

    Err(FormatParseError::UnknownBracketBlock {
        position: i,
        content: inner,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== Single-token recognition =====

    #[test]
    fn lex_empty_is_error() {
        assert_eq!(tokenize(""), Err(FormatParseError::Empty));
    }

    #[test]
    fn lex_digit_placeholders() {
        let toks = tokenize("0#?").unwrap();
        assert_eq!(toks.len(), 3);
        assert!(matches!(toks[0], Token::Zero { .. }));
        assert!(matches!(toks[1], Token::Sharp { .. }));
        assert!(matches!(toks[2], Token::Question { .. }));
    }

    #[test]
    fn lex_period_and_comma() {
        let toks = tokenize("0.00").unwrap();
        assert!(matches!(toks[1], Token::Period { .. }));
        let toks = tokenize("#,##0").unwrap();
        assert!(matches!(toks[1], Token::Comma { .. }));
    }

    #[test]
    fn lex_percent() {
        let toks = tokenize("0%").unwrap();
        assert!(matches!(toks[1], Token::Percent { .. }));
    }

    #[test]
    fn lex_scientific_plus_and_minus() {
        // Tokens: 0, ., 0, 0, E+, 0, 0 → Scientific at index 4.
        let toks = tokenize("0.00E+00").unwrap();
        assert!(matches!(
            toks[4],
            Token::Scientific {
                signed_minus: false,
                ..
            }
        ));
        let toks = tokenize("0.00E-00").unwrap();
        assert!(matches!(
            toks[4],
            Token::Scientific {
                signed_minus: true,
                ..
            }
        ));
    }

    #[test]
    fn lex_separator() {
        let toks = tokenize("0;0").unwrap();
        assert!(matches!(toks[1], Token::Separator { .. }));
    }

    #[test]
    fn lex_raw_text_passthrough() {
        let toks = tokenize("@").unwrap();
        assert!(matches!(toks[0], Token::Raw { .. }));
    }

    // ===== Date / time runs =====

    #[test]
    fn lex_year_short_and_long() {
        let toks = tokenize("yy").unwrap();
        assert_eq!(toks, vec![Token::DateY { pos: 0, len: 2 }]);
        let toks = tokenize("yyyy").unwrap();
        assert_eq!(toks, vec![Token::DateY { pos: 0, len: 4 }]);
    }

    #[test]
    fn lex_year_three_y_is_error() {
        // § 11 IronCalc-divergence: yyy is explicitly rejected, not silently
        // mapped to YearShort.
        let err = tokenize("yyy").unwrap_err();
        assert!(matches!(err, FormatParseError::Other { .. }));
    }

    #[test]
    fn lex_month_all_lengths() {
        for (s, len) in [("m", 1), ("mm", 2), ("mmm", 3), ("mmmm", 4), ("mmmmm", 5)] {
            let toks = tokenize(s).unwrap();
            assert_eq!(toks, vec![Token::DateM { pos: 0, len }]);
        }
        // 6+ rejected.
        assert!(matches!(
            tokenize("mmmmmm").unwrap_err(),
            FormatParseError::Other { .. }
        ));
    }

    #[test]
    fn lex_day_all_lengths() {
        for (s, len) in [("d", 1), ("dd", 2), ("ddd", 3), ("dddd", 4)] {
            let toks = tokenize(s).unwrap();
            assert_eq!(toks, vec![Token::DateD { pos: 0, len }]);
        }
        assert!(matches!(
            tokenize("ddddd").unwrap_err(),
            FormatParseError::Other { .. }
        ));
    }

    #[test]
    fn lex_hour_and_second() {
        let toks = tokenize("hh:ss").unwrap();
        assert!(matches!(toks[0], Token::TimeH { len: 2, .. }));
        assert!(matches!(toks[1], Token::Literal { ch: ':', .. }));
        assert!(matches!(toks[2], Token::TimeS { len: 2, .. }));
    }

    #[test]
    fn lex_ampm_long_and_short() {
        let toks = tokenize("h AM/PM").unwrap();
        assert!(toks.iter().any(|t| matches!(t, Token::AmPm { .. })));
        let toks = tokenize("h A/P").unwrap();
        assert!(toks.iter().any(|t| matches!(t, Token::AmPm { .. })));
        let toks = tokenize("h am/pm").unwrap();
        assert!(toks.iter().any(|t| matches!(t, Token::AmPm { .. })));
    }

    #[test]
    fn lex_keyword_runs_are_case_insensitive() {
        let toks = tokenize("YYYY-MM-DD").unwrap();
        assert!(matches!(toks[0], Token::DateY { len: 4, .. }));
        assert!(matches!(toks[2], Token::DateM { len: 2, .. }));
        assert!(matches!(toks[4], Token::DateD { len: 2, .. }));
    }

    // ===== Text / literal / currency =====

    #[test]
    fn lex_quoted_text() {
        let toks = tokenize("\"foo\"").unwrap();
        match &toks[0] {
            Token::QuotedText { value, .. } => assert_eq!(value, "foo"),
            other => panic!("expected QuotedText, got {other:?}"),
        }
    }

    #[test]
    fn lex_quoted_text_with_special_chars_inside() {
        let toks = tokenize("\"x;y\"").unwrap();
        match &toks[0] {
            Token::QuotedText { value, .. } => assert_eq!(value, "x;y"),
            other => panic!("expected QuotedText, got {other:?}"),
        }
    }

    #[test]
    fn lex_unterminated_quoted_text_is_error() {
        let err = tokenize("\"unterminated").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnterminatedQuotedText { position: 0 }
        ));
    }

    #[test]
    fn lex_escaped_char() {
        let toks = tokenize("\\X").unwrap();
        assert!(matches!(toks[0], Token::EscapedChar { ch: 'X', .. }));
    }

    #[test]
    fn lex_trailing_backslash_is_error() {
        let err = tokenize("0\\").unwrap_err();
        assert!(matches!(err, FormatParseError::TrailingBackslash { .. }));
    }

    #[test]
    fn lex_direct_currency_chars() {
        for c in ['$', '€', '£', '¥'] {
            let toks = tokenize(&c.to_string()).unwrap();
            assert!(matches!(toks[0], Token::DirectCurrency { .. }));
        }
    }

    #[test]
    fn lex_bracket_currency_no_locale() {
        let toks = tokenize("[$€]").unwrap();
        match &toks[0] {
            Token::BracketCurrency {
                ch, locale_code, ..
            } => {
                assert_eq!(*ch, '€');
                assert_eq!(*locale_code, None);
            }
            other => panic!("expected BracketCurrency, got {other:?}"),
        }
    }

    #[test]
    fn lex_bracket_currency_with_locale_code() {
        let toks = tokenize("[$€-409]").unwrap();
        match &toks[0] {
            Token::BracketCurrency {
                ch, locale_code, ..
            } => {
                assert_eq!(*ch, '€');
                assert_eq!(*locale_code, Some(0x409));
            }
            other => panic!("expected BracketCurrency, got {other:?}"),
        }
    }

    #[test]
    fn lex_spacer_and_ghost() {
        let toks = tokenize("_(*0").unwrap();
        assert!(matches!(toks[0], Token::Ghost { ch: '(', .. }));
        assert!(matches!(toks[1], Token::Spacer { ch: '0', .. }));
    }

    #[test]
    fn lex_trailing_underscore_is_error() {
        let err = tokenize("0_").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::TrailingSpacerOrGhost { .. }
        ));
    }

    #[test]
    fn lex_trailing_asterisk_is_error() {
        let err = tokenize("0*").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::TrailingSpacerOrGhost { .. }
        ));
    }

    #[test]
    fn lex_literal_punctuation() {
        // Each of these should land as Token::Literal.
        for c in ['(', ')', '+', '-', '/', ':', ' '] {
            let toks = tokenize(&c.to_string()).unwrap();
            assert!(matches!(toks[0], Token::Literal { .. }));
        }
    }

    #[test]
    fn lex_general_keyword() {
        let toks = tokenize("General").unwrap();
        assert_eq!(toks.len(), 1);
        assert!(matches!(toks[0], Token::General { .. }));
        let toks = tokenize("GENERAL").unwrap();
        assert!(matches!(toks[0], Token::General { .. }));
    }

    // ===== V2-deferred tokens surface as UnsupportedV2 =====

    #[test]
    fn lex_color_codes_unsupported_v2() {
        let err = tokenize("[Red]0").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnsupportedV2 {
                kind: V2Token::ColorCodes,
                ..
            }
        ));
        let err = tokenize("[Color 5]0").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnsupportedV2 {
                kind: V2Token::ColorCodes,
                ..
            }
        ));
    }

    #[test]
    fn lex_conditional_unsupported_v2() {
        let err = tokenize("[>100]0").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnsupportedV2 {
                kind: V2Token::Conditional,
                ..
            }
        ));
        let err = tokenize("[<=0]0").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnsupportedV2 {
                kind: V2Token::Conditional,
                ..
            }
        ));
    }

    #[test]
    fn lex_elapsed_time_unsupported_v2() {
        let err = tokenize("[h]:mm:ss").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnsupportedV2 {
                kind: V2Token::ElapsedTime,
                ..
            }
        ));
        let err = tokenize("[mm]:ss").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnsupportedV2 {
                kind: V2Token::ElapsedTime,
                ..
            }
        ));
    }

    #[test]
    fn lex_unrecognized_bracket_block_is_error() {
        // `[foo]` is not currency, color, condition, or elapsed. Reject.
        let err = tokenize("[unknown]0").unwrap_err();
        assert!(matches!(err, FormatParseError::UnknownBracketBlock { .. }));
    }

    #[test]
    fn lex_unterminated_bracket_block_is_error() {
        let err = tokenize("[unterminated").unwrap_err();
        assert!(matches!(err, FormatParseError::UnknownBracketBlock { .. }));
    }

    // ===== Composite fixtures =====

    #[test]
    fn lex_iso_date_format() {
        let toks = tokenize("yyyy-mm-dd").unwrap();
        // y(4) - m(2) - d(2) → 5 tokens (3 keywords + 2 literals).
        assert_eq!(toks.len(), 5);
        assert!(matches!(toks[0], Token::DateY { len: 4, .. }));
        assert!(matches!(toks[1], Token::Literal { ch: '-', .. }));
        assert!(matches!(toks[2], Token::DateM { len: 2, .. }));
        assert!(matches!(toks[3], Token::Literal { ch: '-', .. }));
        assert!(matches!(toks[4], Token::DateD { len: 2, .. }));
    }

    #[test]
    fn lex_time_format_hmms() {
        // "h:mm:ss" → h + : + m(2) + : + s(2)
        let toks = tokenize("h:mm:ss").unwrap();
        assert_eq!(toks.len(), 5);
        assert!(matches!(toks[0], Token::TimeH { len: 1, .. }));
        assert!(matches!(toks[2], Token::DateM { len: 2, .. }));
        assert!(matches!(toks[4], Token::TimeS { len: 2, .. }));
    }

    #[test]
    fn lex_thousands_with_fixed_decimal() {
        // "#,##0.00" — comma between digits = thousands sep
        let toks = tokenize("#,##0.00").unwrap();
        assert!(matches!(toks[0], Token::Sharp { .. }));
        assert!(matches!(toks[1], Token::Comma { .. }));
        assert!(matches!(toks[2], Token::Sharp { .. }));
        assert!(matches!(toks[3], Token::Sharp { .. }));
        assert!(matches!(toks[4], Token::Zero { .. }));
        assert!(matches!(toks[5], Token::Period { .. }));
    }

    #[test]
    fn lex_four_section_format() {
        let toks = tokenize("0;-0;;@").unwrap();
        // 0 ; - 0 ; ; @ → 7 tokens
        assert_eq!(toks.len(), 7);
        let separators = toks
            .iter()
            .filter(|t| matches!(t, Token::Separator { .. }))
            .count();
        assert_eq!(separators, 3);
    }
}
