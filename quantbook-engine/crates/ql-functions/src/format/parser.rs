//! Section assembly + m/mm disambiguation + kind classification.
//!
//! Pipeline:
//!   tokenize (lexer.rs) → split on `Separator` → resolve `m`/`mm` →
//!   build `Section::tokens` → classify SectionKind → return FormatString.
//!
//! See `docs/architecture/2026-05-13-format-string-grammar.md` § 3, § 4,
//! § 8 for the contract.

use super::ast::{
    DigitKind, FormatString, MonthNameLen, MonthRole, NumberState, Section, SectionKind,
    SectionToken,
};
use super::error::FormatParseError;
use super::lexer::{tokenize, Token};

/// Excel-canon: at most 4 sections (positive / negative / zero / text).
const MAX_SECTIONS: usize = 4;

/// Parse a format string into a `FormatString` AST.
///
/// See the parent design doc § 6.2 + the grammar mini-spec at
/// `docs/architecture/2026-05-13-format-string-grammar.md` for the
/// authoritative scope.
pub fn parse(input: &str) -> Result<FormatString, FormatParseError> {
    let tokens = tokenize(input)?;
    let raw_sections = split_sections(&tokens)?;
    let mut sections = Vec::with_capacity(raw_sections.len());
    for raw in raw_sections {
        sections.push(build_section(raw)?);
    }
    Ok(FormatString { sections })
}

/// Split a flat token stream on `Token::Separator` into per-section
/// slices. Enforces the `MAX_SECTIONS` cap.
fn split_sections(tokens: &[Token]) -> Result<Vec<&[Token]>, FormatParseError> {
    let mut sections: Vec<&[Token]> = Vec::new();
    let mut start = 0;
    for (i, tok) in tokens.iter().enumerate() {
        if matches!(tok, Token::Separator { .. }) {
            sections.push(&tokens[start..i]);
            start = i + 1;
        }
    }
    sections.push(&tokens[start..]);
    if sections.len() > MAX_SECTIONS {
        return Err(FormatParseError::TooManySections(sections.len()));
    }
    Ok(sections)
}

/// Build a `Section` from its raw token slice.
fn build_section(raw: &[Token]) -> Result<Section, FormatParseError> {
    if raw.is_empty() {
        return Ok(Section {
            kind: SectionKind::Empty,
            tokens: Vec::new(),
        });
    }
    // Single-token General sections.
    if raw.len() == 1 && matches!(raw[0], Token::General { .. }) {
        return Ok(Section {
            kind: SectionKind::General,
            tokens: vec![SectionToken::General],
        });
    }
    // Resolve m/mm roles using a pre-pass that walks the raw stream.
    let month_roles = resolve_month_roles(raw);
    // Build the SectionToken vector + track scale/position state.
    let mut tokens: Vec<SectionToken> = Vec::with_capacity(raw.len());
    let mut number_state = NumberState::Integer;
    // Whether the immediately-preceding emitted token was a digit. Drives
    // the comma role resolution.
    let mut prev_emitted_was_digit = false;
    // Count of commas seen but not yet decided about (between-digits =
    // thousands separator, trailing = scale-by-thousands).
    let mut pending_commas: u32 = 0;
    let mut percent_count: u32 = 0;
    let mut m_index = 0usize;

    // Helper closure to flush pending commas given the role determined
    // by the NEXT token's kind.
    let flush_commas = |pending: &mut u32, was_thousands: bool, out: &mut Vec<SectionToken>| {
        if *pending == 0 {
            return;
        }
        if was_thousands {
            // Any count of between-digits commas collapses to one
            // ThousandsSeparator (Excel canon).
            out.push(SectionToken::ThousandsSeparator);
        } else {
            out.push(SectionToken::ScaleByThousands(*pending));
        }
        *pending = 0;
    };

    for tok in raw {
        // Commas are deferred: they accumulate in `pending_commas` and
        // resolve only when a non-comma token arrives.
        if matches!(tok, Token::Comma { .. }) {
            if prev_emitted_was_digit || pending_commas > 0 {
                pending_commas += 1;
                // `prev_emitted_was_digit` stays as-is so that a later
                // digit still recognizes "we are still in a digit-comma
                // run" and collapses to ThousandsSeparator.
            } else {
                // Comma in non-digit context — literal `,`.
                tokens.push(SectionToken::Literal(','));
            }
            continue;
        }
        // Any non-comma token forces a flush of any pending commas. The
        // role depends on whether THIS token is a digit (→ thousands) or
        // not (→ scale).
        let is_digit_now = matches!(
            tok,
            Token::Zero { .. } | Token::Sharp { .. } | Token::Question { .. }
        );
        flush_commas(&mut pending_commas, is_digit_now, &mut tokens);

        let mut emitted_digit_this_iter = false;
        let next_section_token: Option<SectionToken> = match tok {
            Token::Zero { .. } => {
                emitted_digit_this_iter = true;
                Some(SectionToken::Digit {
                    kind: DigitKind::Zero,
                    number: number_state,
                })
            }
            Token::Sharp { .. } => {
                emitted_digit_this_iter = true;
                Some(SectionToken::Digit {
                    kind: DigitKind::Sharp,
                    number: number_state,
                })
            }
            Token::Question { .. } => {
                emitted_digit_this_iter = true;
                Some(SectionToken::Digit {
                    kind: DigitKind::Question,
                    number: number_state,
                })
            }
            Token::Period { .. } => {
                number_state = NumberState::Decimal;
                Some(SectionToken::DecimalPoint)
            }
            Token::Percent { .. } => {
                percent_count += 1;
                None
            }
            Token::Scientific { signed_minus, .. } => {
                number_state = NumberState::Exponent;
                Some(SectionToken::ExponentMarker {
                    signed_minus: *signed_minus,
                })
            }
            Token::DateY { len, .. } => Some(SectionToken::Year { short: *len == 2 }),
            Token::DateD { len, .. } => match len {
                1 => Some(SectionToken::Day { padded: false }),
                2 => Some(SectionToken::Day { padded: true }),
                3 => Some(SectionToken::DayName { full: false }),
                4 => Some(SectionToken::DayName { full: true }),
                _ => unreachable!("lexer guards day length"),
            },
            Token::DateM { len, .. } => {
                let role = month_roles[m_index];
                m_index += 1;
                match (len, role) {
                    (1, MonthRole::Month) => Some(SectionToken::Month {
                        padded: false,
                        role: MonthRole::Month,
                    }),
                    (2, MonthRole::Month) => Some(SectionToken::Month {
                        padded: true,
                        role: MonthRole::Month,
                    }),
                    (1, MonthRole::Minute) => Some(SectionToken::Minute { padded: false }),
                    (2, MonthRole::Minute) => Some(SectionToken::Minute { padded: true }),
                    (3, _) => Some(SectionToken::MonthName {
                        length: MonthNameLen::Short,
                    }),
                    (4, _) => Some(SectionToken::MonthName {
                        length: MonthNameLen::Full,
                    }),
                    (5, _) => Some(SectionToken::MonthName {
                        length: MonthNameLen::SingleLetter,
                    }),
                    _ => unreachable!("lexer guards month length"),
                }
            }
            Token::TimeH { len, .. } => Some(SectionToken::Hour { padded: *len == 2 }),
            Token::TimeS { len, .. } => Some(SectionToken::Second { padded: *len == 2 }),
            Token::AmPm { .. } => Some(SectionToken::AmPm),
            Token::QuotedText { value, .. } => Some(SectionToken::QuotedText(value.clone())),
            Token::EscapedChar { ch, .. } => Some(SectionToken::Literal(*ch)),
            Token::DirectCurrency { ch, .. } => Some(SectionToken::Currency {
                ch: *ch,
                locale_code: None,
            }),
            Token::BracketCurrency {
                ch, locale_code, ..
            } => Some(SectionToken::Currency {
                ch: *ch,
                locale_code: *locale_code,
            }),
            Token::Literal { ch, .. } => Some(SectionToken::Literal(*ch)),
            Token::Raw { .. } => Some(SectionToken::TextPassthrough),
            Token::Spacer { ch, .. } => Some(SectionToken::Spacer(*ch)),
            Token::Ghost { ch, .. } => Some(SectionToken::Ghost(*ch)),
            Token::General { .. } => Some(SectionToken::Literal('G')),
            Token::Comma { .. } => unreachable!("comma handled above"),
            Token::Separator { .. } => {
                unreachable!("split_sections strips separators before this loop");
            }
        };
        if let Some(st) = next_section_token {
            tokens.push(st);
        }
        prev_emitted_was_digit = emitted_digit_this_iter;
    }
    // Flush any trailing commas left at end of section — these are scale.
    flush_commas(&mut pending_commas, false, &mut tokens);
    // Collapse multiple `%` into a single token.
    if percent_count > 0 {
        tokens.push(SectionToken::Percent(percent_count));
    }
    // Classify the section kind from the assembled token list.
    let kind = classify_section_kind(&tokens);
    Ok(Section { kind, tokens })
}

/// Walk the raw token stream and decide the role of each `Token::DateM`
/// — minute vs month. Returns a vector indexed by m-occurrence order.
fn resolve_month_roles(raw: &[Token]) -> Vec<MonthRole> {
    // Collect indices of DateM tokens.
    let m_positions: Vec<usize> = raw
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            if matches!(t, Token::DateM { .. }) {
                Some(i)
            } else {
                None
            }
        })
        .collect();
    let mut roles = Vec::with_capacity(m_positions.len());
    for &pos in &m_positions {
        let role = classify_one_m(raw, pos);
        roles.push(role);
    }
    roles
}

/// Look backward + forward from the m-position for an h/hh or s/ss anchor.
/// Per § 4.1, minute if the nearest time anchor (skipping non-date/time
/// tokens) on either side is an hour or second.
fn classify_one_m(raw: &[Token], pos: usize) -> MonthRole {
    // Walk backward for a date or time anchor.
    let prior_anchor = walk_for_anchor(raw, pos, /*forward=*/ false);
    if matches!(
        prior_anchor,
        Some(AnchorKind::Hour) | Some(AnchorKind::Second)
    ) {
        return MonthRole::Minute;
    }
    // Walk forward for an anchor.
    let next_anchor = walk_for_anchor(raw, pos, /*forward=*/ true);
    if matches!(next_anchor, Some(AnchorKind::Second)) {
        // Hour-then-m would have been caught by the backward pass; on the
        // forward pass only a following second anchors `m` as minute (the
        // canonical "mm:ss" form).
        return MonthRole::Minute;
    }
    MonthRole::Month
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AnchorKind {
    Hour,
    Second,
    DateYDM,
}

fn walk_for_anchor(raw: &[Token], from: usize, forward: bool) -> Option<AnchorKind> {
    let range: Box<dyn Iterator<Item = usize>> = if forward {
        Box::new(from + 1..raw.len())
    } else {
        Box::new((0..from).rev())
    };
    for i in range {
        match &raw[i] {
            Token::TimeH { .. } => return Some(AnchorKind::Hour),
            Token::TimeS { .. } => return Some(AnchorKind::Second),
            Token::DateY { .. } | Token::DateD { .. } => return Some(AnchorKind::DateYDM),
            // Continue past spacer / ghost / literal / quoted / currency.
            _ => continue,
        }
    }
    None
}

fn classify_section_kind(tokens: &[SectionToken]) -> SectionKind {
    if tokens.is_empty() {
        return SectionKind::Empty;
    }
    if tokens.len() == 1 && matches!(tokens[0], SectionToken::General) {
        return SectionKind::General;
    }
    let mut has_digit = false;
    let mut has_date_or_time = false;
    let mut has_text_passthrough = false;
    for t in tokens {
        match t {
            SectionToken::Digit { .. } => has_digit = true,
            SectionToken::Day { .. }
            | SectionToken::DayName { .. }
            | SectionToken::Month { .. }
            | SectionToken::MonthName { .. }
            | SectionToken::Year { .. }
            | SectionToken::Hour { .. }
            | SectionToken::Minute { .. }
            | SectionToken::Second { .. }
            | SectionToken::AmPm => has_date_or_time = true,
            SectionToken::TextPassthrough => has_text_passthrough = true,
            _ => {}
        }
    }
    if has_text_passthrough {
        SectionKind::Text
    } else if has_date_or_time {
        SectionKind::Date
    } else if has_digit {
        SectionKind::Number
    } else {
        // Only literals / quoted / currency / spacer / ghost: still Text.
        SectionKind::Text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(s: &str) -> FormatString {
        parse(s).unwrap_or_else(|e| panic!("parse failed on {s:?}: {e:?}"))
    }

    // ===== Single-section, kind classification =====

    #[test]
    fn single_zero_is_number_section() {
        let fs = parse_ok("0");
        assert_eq!(fs.sections.len(), 1);
        assert_eq!(fs.sections[0].kind, SectionKind::Number);
    }

    #[test]
    fn iso_date_is_date_section() {
        let fs = parse_ok("yyyy-mm-dd");
        assert_eq!(fs.sections.len(), 1);
        assert_eq!(fs.sections[0].kind, SectionKind::Date);
    }

    #[test]
    fn raw_at_is_text_section() {
        let fs = parse_ok("@");
        assert_eq!(fs.sections.len(), 1);
        assert_eq!(fs.sections[0].kind, SectionKind::Text);
    }

    #[test]
    fn general_keyword_classifies_as_general() {
        let fs = parse_ok("General");
        assert_eq!(fs.sections[0].kind, SectionKind::General);
        assert_eq!(fs.sections[0].tokens, vec![SectionToken::General]);
    }

    #[test]
    fn literal_only_section_is_text() {
        let fs = parse_ok("\"label\"");
        assert_eq!(fs.sections[0].kind, SectionKind::Text);
    }

    // ===== Section split + count =====

    #[test]
    fn two_section_split() {
        let fs = parse_ok("0;-0");
        assert_eq!(fs.sections.len(), 2);
        assert_eq!(fs.sections[0].kind, SectionKind::Number);
        assert_eq!(fs.sections[1].kind, SectionKind::Number);
    }

    #[test]
    fn three_section_with_zero_label() {
        let fs = parse_ok("0;-0;\"zero\"");
        assert_eq!(fs.sections.len(), 3);
        assert_eq!(fs.sections[2].kind, SectionKind::Text);
    }

    #[test]
    fn four_section_with_empty_zero() {
        let fs = parse_ok("0;-0;;@");
        assert_eq!(fs.sections.len(), 4);
        assert_eq!(fs.sections[2].kind, SectionKind::Empty);
        assert_eq!(fs.sections[3].kind, SectionKind::Text);
    }

    #[test]
    fn trailing_semicolon_creates_empty_second_section() {
        let fs = parse_ok("0;");
        assert_eq!(fs.sections.len(), 2);
        assert_eq!(fs.sections[1].kind, SectionKind::Empty);
    }

    #[test]
    fn five_sections_is_error() {
        let err = parse("0;0;0;0;0").unwrap_err();
        assert_eq!(err, FormatParseError::TooManySections(5));
    }

    // ===== Numeric punctuation =====

    #[test]
    fn thousands_separator_between_digits() {
        let fs = parse_ok("#,##0");
        // Tokens: Digit(#), Thousands, Digit(#), Digit(#), Digit(0)
        assert_eq!(fs.sections[0].tokens.len(), 5);
        assert_eq!(fs.sections[0].tokens[1], SectionToken::ThousandsSeparator);
    }

    #[test]
    fn trailing_comma_is_scale_by_thousands() {
        let fs = parse_ok("#,");
        assert_eq!(
            fs.sections[0].tokens.last().unwrap(),
            &SectionToken::ScaleByThousands(1)
        );
    }

    #[test]
    fn two_trailing_commas_scale_by_millions() {
        let fs = parse_ok("#,,");
        assert_eq!(
            fs.sections[0].tokens.last().unwrap(),
            &SectionToken::ScaleByThousands(2)
        );
    }

    #[test]
    fn decimal_point_switches_number_state() {
        let fs = parse_ok("0.00");
        match &fs.sections[0].tokens[0] {
            SectionToken::Digit { number, .. } => assert_eq!(*number, NumberState::Integer),
            other => panic!("expected Digit, got {other:?}"),
        }
        // After the period, digits should be NumberState::Decimal.
        match &fs.sections[0].tokens[2] {
            SectionToken::Digit { number, .. } => assert_eq!(*number, NumberState::Decimal),
            other => panic!("expected Digit, got {other:?}"),
        }
    }

    #[test]
    fn exponent_marker_switches_number_state() {
        let fs = parse_ok("0.00E+00");
        // The two digits after E+ should be Exponent.
        let last_two = &fs.sections[0].tokens[fs.sections[0].tokens.len() - 2..];
        for t in last_two {
            match t {
                SectionToken::Digit { number, .. } => assert_eq!(*number, NumberState::Exponent),
                other => panic!("expected Digit, got {other:?}"),
            }
        }
    }

    #[test]
    fn percent_collapses_to_count() {
        let fs = parse_ok("0%");
        assert_eq!(
            fs.sections[0].tokens.last().unwrap(),
            &SectionToken::Percent(1)
        );
        let fs = parse_ok("0%%");
        assert_eq!(
            fs.sections[0].tokens.last().unwrap(),
            &SectionToken::Percent(2)
        );
    }

    // ===== m/mm disambiguation =====

    #[test]
    fn mm_in_time_context_is_minute() {
        let fs = parse_ok("h:mm:ss");
        // tokens: Hour, ':', Minute, ':', Second
        assert!(matches!(
            fs.sections[0].tokens[2],
            SectionToken::Minute { padded: true }
        ));
    }

    #[test]
    fn standalone_mm_is_month_when_no_time_anchor() {
        let fs = parse_ok("yyyy-mm-dd");
        // tokens: Year(yyyy), '-', Month(mm,Month), '-', Day(dd)
        assert!(matches!(
            fs.sections[0].tokens[2],
            SectionToken::Month {
                padded: true,
                role: MonthRole::Month
            }
        ));
    }

    #[test]
    fn mm_after_ss_in_reverse_position_resolves_to_minute() {
        // "ss:mm" — `mm` follows `ss`. Backward anchor for mm is `ss` → minute.
        let fs = parse_ok("ss:mm");
        assert!(matches!(
            fs.sections[0].tokens[2],
            SectionToken::Minute { padded: true }
        ));
    }

    #[test]
    fn mm_before_ss_resolves_to_minute() {
        // "mm:ss" — `mm` precedes `ss`. Forward anchor is `ss` → minute.
        let fs = parse_ok("mm:ss");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::Minute { padded: true }
        ));
    }

    #[test]
    fn mmm_is_always_month_name_short() {
        let fs = parse_ok("h:mmm:s");
        // mmm has length 3 → MonthName::Short regardless of context.
        assert!(matches!(
            fs.sections[0].tokens[2],
            SectionToken::MonthName {
                length: MonthNameLen::Short
            }
        ));
    }

    #[test]
    fn mmmmm_is_single_letter_month() {
        let fs = parse_ok("mmmmm");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::MonthName {
                length: MonthNameLen::SingleLetter
            }
        ));
    }

    // ===== Year length =====

    #[test]
    fn year_short_vs_long() {
        let fs = parse_ok("yy");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::Year { short: true }
        ));
        let fs = parse_ok("yyyy");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::Year { short: false }
        ));
    }

    // ===== Day length =====

    #[test]
    fn day_lengths() {
        let fs = parse_ok("d");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::Day { padded: false }
        ));
        let fs = parse_ok("dd");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::Day { padded: true }
        ));
        let fs = parse_ok("ddd");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::DayName { full: false }
        ));
        let fs = parse_ok("dddd");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::DayName { full: true }
        ));
    }

    // ===== Currency =====

    #[test]
    fn direct_dollar_is_currency() {
        let fs = parse_ok("$#,##0.00");
        assert!(matches!(
            fs.sections[0].tokens[0],
            SectionToken::Currency {
                ch: '$',
                locale_code: None
            }
        ));
    }

    #[test]
    fn bracket_currency_with_locale_preserved() {
        let fs = parse_ok("[$€-409]#,##0.00");
        match &fs.sections[0].tokens[0] {
            SectionToken::Currency { ch, locale_code } => {
                assert_eq!(*ch, '€');
                assert_eq!(*locale_code, Some(0x409));
            }
            other => panic!("expected Currency, got {other:?}"),
        }
    }

    // ===== Quoted text + literal =====

    #[test]
    fn quoted_text_preserved() {
        let fs = parse_ok("0 \"items\"");
        let has_quoted = fs.sections[0]
            .tokens
            .iter()
            .any(|t| matches!(t, SectionToken::QuotedText(s) if s == "items"));
        assert!(has_quoted);
    }

    #[test]
    fn escaped_char_renders_literal() {
        let fs = parse_ok("0\\X");
        assert_eq!(
            fs.sections[0].tokens.last().unwrap(),
            &SectionToken::Literal('X')
        );
    }

    // ===== Spacer / ghost =====

    #[test]
    fn spacer_ast_preserved() {
        let fs = parse_ok("0*0");
        assert!(fs.sections[0]
            .tokens
            .iter()
            .any(|t| matches!(t, SectionToken::Spacer('0'))));
    }

    #[test]
    fn ghost_ast_preserved() {
        let fs = parse_ok("0_)");
        assert!(fs.sections[0]
            .tokens
            .iter()
            .any(|t| matches!(t, SectionToken::Ghost(')'))));
    }

    // ===== Built-in formats (§ 10 sub-table) =====

    #[test]
    fn builtin_id_0_general() {
        let fs = parse_ok("General");
        assert_eq!(fs.sections[0].kind, SectionKind::General);
    }

    #[test]
    fn builtin_id_4_thousands_with_decimal() {
        let fs = parse_ok("#,##0.00");
        assert_eq!(fs.sections[0].kind, SectionKind::Number);
        // Check shape: # , # # 0 . 0 0 → digit, thousands, 3*digit, period, 2*digit
        assert_eq!(fs.sections[0].tokens.len(), 8);
    }

    #[test]
    fn builtin_id_14_m_d_yyyy_is_date() {
        let fs = parse_ok("m/d/yyyy");
        assert_eq!(fs.sections[0].kind, SectionKind::Date);
    }

    #[test]
    fn builtin_id_18_h_mm_ampm_is_date_with_ampm() {
        let fs = parse_ok("h:mm AM/PM");
        assert_eq!(fs.sections[0].kind, SectionKind::Date);
        let has_ampm = fs.sections[0]
            .tokens
            .iter()
            .any(|t| matches!(t, SectionToken::AmPm));
        assert!(has_ampm);
    }

    #[test]
    fn builtin_id_22_m_d_yyyy_h_mm_is_date() {
        let fs = parse_ok("m/d/yyyy h:mm");
        assert_eq!(fs.sections[0].kind, SectionKind::Date);
    }

    #[test]
    fn builtin_id_37_neg_in_parens_two_section() {
        let fs = parse_ok("#,##0 ;(#,##0)");
        assert_eq!(fs.sections.len(), 2);
        assert_eq!(fs.sections[0].kind, SectionKind::Number);
        assert_eq!(fs.sections[1].kind, SectionKind::Number);
    }

    // ===== V2-deferred surfacing as parse errors =====

    #[test]
    fn color_codes_error_is_uncovered_v2() {
        let err = parse("[Red]0").unwrap_err();
        assert!(matches!(err, FormatParseError::UnsupportedV2 { .. }));
    }

    #[test]
    fn conditional_error_is_uncovered_v2() {
        let err = parse("[>100]0;[<=0]\"zero\"").unwrap_err();
        assert!(matches!(err, FormatParseError::UnsupportedV2 { .. }));
    }

    #[test]
    fn elapsed_time_error_is_uncovered_v2() {
        let err = parse("[h]:mm:ss").unwrap_err();
        assert!(matches!(err, FormatParseError::UnsupportedV2 { .. }));
    }

    // ===== Error propagation from lexer =====

    #[test]
    fn empty_input_propagates_empty_error() {
        assert_eq!(parse(""), Err(FormatParseError::Empty));
    }

    #[test]
    fn unterminated_quoted_propagates() {
        let err = parse("\"oops").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::UnterminatedQuotedText { .. }
        ));
    }

    #[test]
    fn trailing_backslash_propagates() {
        let err = parse("0\\").unwrap_err();
        assert!(matches!(err, FormatParseError::TrailingBackslash { .. }));
    }

    #[test]
    fn trailing_underscore_propagates() {
        let err = parse("0_").unwrap_err();
        assert!(matches!(
            err,
            FormatParseError::TrailingSpacerOrGhost { .. }
        ));
    }

    #[test]
    fn invalid_year_length_propagates() {
        let err = parse("yyy").unwrap_err();
        assert!(matches!(err, FormatParseError::Other { .. }));
    }
}
