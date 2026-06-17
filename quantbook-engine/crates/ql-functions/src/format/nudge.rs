//! Decimal-place nudge for number-format strings (FE styling — R9 / Wave B,
//! 2026-06-17).
//!
//! Implements Excel's "Increase Decimal" / "Decrease Decimal" gesture as a
//! pure transformation over a format-code string: add (`delta > 0`) or remove
//! (`delta < 0`) one decimal placeholder per step, per numeric section.
//!
//! **Why operate on the string via the lexer (not the AST):** [`super::render`]
//! renders *values* through a format; there is no AST → format-code re-emitter.
//! The lexer ([`tokenize`]) already attaches a source `pos` (char index, since
//! the lexer indexes a `Vec<char>`) to every token, so we can locate the
//! decimal point + fraction-digit run by token position and splice the raw
//! string at those offsets. Quoted text (`"..."`), escaped chars (`\x`), and
//! bracket runs (`[$-409]`) become their own tokens, so their interior
//! characters are never mistaken for a decimal point or digit — the splice is
//! escape-/quote-/bracket-safe for free.
//!
//! **No-Fallbacks safety net:** the result is re-parsed with [`parse`] before
//! return; a transform that would yield an unparseable format surfaces a loud
//! `Err`, never a silently-corrupt format code.
//!
//! **Contract (documented, deterministic, value-independent):**
//! - Each call shifts the decimal-place count by `delta` (looped one step at a
//!   time; a step that cannot apply — clamp boundary — ends the loop early).
//! - Applies to every **numeric** section (has a digit placeholder `0`/`#`/`?`
//!   and no date/time token). Date / text / empty / `General` sections are left
//!   unchanged (so nudging a pure date format is a no-op).
//! - Increase inserts a `0` at the end of the section's fraction run (or, with
//!   no decimal point, inserts `.0` after the integer placeholders — e.g.
//!   `#,##0` → `#,##0.0`, `0%` → `0.0%`). Capped at [`MAX_DECIMALS`] (Excel's
//!   30-place limit); at the cap the step is a no-op.
//! - Decrease removes the last fraction placeholder; removing the final one
//!   also removes the decimal point (`0.0` → `0`, `#,##0.0` → `#,##0`,
//!   `0.0%` → `0%`). At zero decimals the step is a no-op.
//! - The `General` base case is handled by the *caller* (the runtime treats an
//!   unbound / `General` cell as base `"0"`); a literal `"General"` passed here
//!   is a no-op in both directions.

use super::error::FormatParseError;
use super::lexer::{tokenize, Token};
use super::parser::parse;

/// Excel caps the decimal-place count of a number format at 30. Increase
/// beyond this is a no-op step.
pub const MAX_DECIMALS: usize = 30;

/// Increase (`delta > 0`) or decrease (`delta < 0`) the number of decimal
/// places shown by the number format `input`, returning the new format-code
/// string. See the module docs for the full contract.
///
/// `delta == 0` returns `input` unchanged. A malformed `input` (does not
/// tokenize/parse) — or a transform that would yield an unparseable result —
/// returns the underlying [`FormatParseError`] (No-Fallbacks: never emit a
/// corrupt format).
pub fn nudge_format_decimals(input: &str, delta: i32) -> Result<String, FormatParseError> {
    // Validate the input is a format we can represent FIRST — even for the
    // `delta == 0` no-op — so this function never returns `Ok` for an
    // unparseable format (a caller probing validity gets a consistent contract,
    // and No-Fallbacks holds on every path). For an already-interned format
    // this always passes; the check makes the fn safe on arbitrary strings.
    parse(input)?;
    if delta == 0 {
        return Ok(input.to_owned());
    }

    let up = delta > 0;
    let steps = delta.unsigned_abs();
    let mut current = input.to_owned();
    for _ in 0..steps {
        let next = nudge_one(&current, up)?;
        if next == current {
            // Clamp boundary reached (0 decimals on decrease, MAX on increase,
            // or a non-numeric format) — further steps cannot change anything.
            break;
        }
        current = next;
    }
    // No-Fallbacks safety net: never return a format that would not parse.
    parse(&current)?;
    Ok(current)
}

/// One increase/decrease step. Tokenizes `s`, splits into sections on
/// `Token::Separator`, computes a splice per numeric section using absolute
/// token char-positions, then applies all splices. Token positions are
/// absolute over the whole input, so applying splices in descending start
/// order needs no per-section offset bookkeeping.
fn nudge_one(s: &str, up: bool) -> Result<String, FormatParseError> {
    let tokens = tokenize(s)?;

    // Section boundaries: index ranges into `tokens` split on Separator.
    let mut sections: Vec<&[Token]> = Vec::new();
    let mut start = 0usize;
    for (i, tok) in tokens.iter().enumerate() {
        if matches!(tok, Token::Separator { .. }) {
            sections.push(&tokens[start..i]);
            start = i + 1;
        }
    }
    sections.push(&tokens[start..]);

    let mut splices: Vec<Splice> = Vec::new();
    for sec in &sections {
        splices.extend(section_splices(sec, up));
    }
    if splices.is_empty() {
        return Ok(s.to_owned());
    }

    // Apply descending by start so earlier splices don't shift later offsets.
    splices.sort_by(|a, b| b.start.cmp(&a.start));
    let mut chars: Vec<char> = s.chars().collect();
    for sp in &splices {
        let end = sp.start + sp.remove;
        debug_assert!(end <= chars.len(), "splice out of range");
        chars.splice(sp.start..end, sp.insert.chars());
    }
    Ok(chars.into_iter().collect())
}

/// A single edit on the char buffer: remove `remove` chars at `start`, insert
/// `insert` there.
struct Splice {
    start: usize,
    remove: usize,
    insert: String,
}

/// Compute the splice(s) for ONE section. Returns an empty vec if the section
/// is not numeric or the step is a no-op (clamp boundary). May return TWO
/// splices on a decrease that removes the final fraction digit — the decimal
/// point and the digit are removed as separate 1-char splices so any literal
/// token BETWEEN them (pathological formats like `0."x"0`) is preserved rather
/// than swept away by a single inclusive-span delete.
fn section_splices(sec: &[Token], up: bool) -> Vec<Splice> {
    // Numeric = has a digit placeholder and no date/time token. Date/time
    // sections (and Text/General/Empty) are left untouched.
    let has_digit = sec.iter().any(|t| is_digit(t));
    let has_datetime = sec.iter().any(|t| {
        matches!(
            t,
            Token::DateY { .. }
                | Token::DateM { .. }
                | Token::DateD { .. }
                | Token::TimeH { .. }
                | Token::TimeS { .. }
                | Token::AmPm { .. }
        )
    });
    if !has_digit || has_datetime {
        return Vec::new();
    }

    let period_pos = sec.iter().find_map(|t| match t {
        Token::Period { pos } => Some(*pos),
        _ => None,
    });
    let sci_pos = sec.iter().find_map(|t| match t {
        Token::Scientific { pos, .. } => Some(*pos),
        _ => None,
    });

    // Partition digit placeholders into mantissa-integer vs mantissa-fraction
    // (exponent digits — after `E` — are excluded from both).
    let before_sci = |p: usize| sci_pos.map_or(true, |sp| p < sp);
    let mut integer_positions: Vec<usize> = Vec::new();
    let mut fraction_positions: Vec<usize> = Vec::new();
    for t in sec {
        if !is_digit(t) {
            continue;
        }
        let p = t.position();
        if !before_sci(p) {
            continue; // exponent digit
        }
        match period_pos {
            Some(pp) if p > pp => fraction_positions.push(p),
            Some(_) => integer_positions.push(p),
            None => integer_positions.push(p),
        }
    }

    if up {
        let frac_count = fraction_positions.len();
        if frac_count >= MAX_DECIMALS {
            return Vec::new(); // clamp
        }
        if let Some(&last_frac) = fraction_positions.iter().max() {
            // Append a `0` after the last fraction digit.
            vec![Splice {
                start: last_frac + 1,
                remove: 0,
                insert: "0".to_owned(),
            }]
        } else if let Some(pp) = period_pos {
            // Decimal point but no fraction digits ("0.") — add a `0` after it.
            vec![Splice {
                start: pp + 1,
                remove: 0,
                insert: "0".to_owned(),
            }]
        } else if let Some(&last_int) = integer_positions.iter().max() {
            // No decimal point — insert ".0" after the integer placeholders.
            vec![Splice {
                start: last_int + 1,
                remove: 0,
                insert: ".0".to_owned(),
            }]
        } else {
            Vec::new()
        }
    } else {
        // Decrease.
        let frac_count = fraction_positions.len();
        if frac_count == 0 {
            return Vec::new(); // already 0 decimals
        }
        let last_frac = *fraction_positions.iter().max().unwrap();
        if frac_count >= 2 {
            // Drop just the last fraction digit.
            return vec![Splice {
                start: last_frac,
                remove: 1,
                insert: String::new(),
            }];
        }
        // Exactly one fraction digit: remove it AND the decimal point.
        let pp = period_pos.expect("a fraction digit implies a decimal point");
        if integer_positions.is_empty() {
            // No integer placeholder (e.g. ".0") — a precise removal would leave
            // no digit at all (invalid). Collapse the point→digit span to a
            // single "0" so the section stays a valid number format.
            let lo = pp.min(last_frac);
            let hi = pp.max(last_frac);
            vec![Splice {
                start: lo,
                remove: hi - lo + 1,
                insert: "0".to_owned(),
            }]
        } else {
            // PRECISE removal: drop the decimal point and the fraction digit as
            // two separate 1-char splices (non-overlapping, applied descending
            // downstream). This preserves any literal token BETWEEN the point
            // and the digit (e.g. `0."x"0` → `0"x"`), which an inclusive-span
            // delete would silently sweep away.
            vec![
                Splice {
                    start: last_frac,
                    remove: 1,
                    insert: String::new(),
                },
                Splice {
                    start: pp,
                    remove: 1,
                    insert: String::new(),
                },
            ]
        }
    }
}

fn is_digit(t: &Token) -> bool {
    matches!(
        t,
        Token::Zero { .. } | Token::Sharp { .. } | Token::Question { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(s: &str) -> String {
        nudge_format_decimals(s, 1).unwrap()
    }
    fn down(s: &str) -> String {
        nudge_format_decimals(s, -1).unwrap()
    }

    // ===== Increase =====

    #[test]
    fn increase_plain_integer_adds_decimal_point() {
        assert_eq!(up("0"), "0.0");
    }

    #[test]
    fn increase_appends_to_existing_fraction() {
        assert_eq!(up("0.0"), "0.00");
        assert_eq!(up("0.00"), "0.000");
    }

    #[test]
    fn increase_preserves_thousands_separator() {
        assert_eq!(up("#,##0"), "#,##0.0");
        assert_eq!(up("#,##0.00"), "#,##0.000");
    }

    #[test]
    fn increase_preserves_percent_suffix() {
        assert_eq!(up("0%"), "0.0%");
        assert_eq!(up("0.00%"), "0.000%");
    }

    #[test]
    fn increase_preserves_currency_prefix() {
        assert_eq!(up("$#,##0.00"), "$#,##0.000");
    }

    #[test]
    fn increase_scientific_targets_mantissa_not_exponent() {
        assert_eq!(up("0.00E+00"), "0.000E+00");
        // No mantissa fraction yet → add one before the exponent.
        assert_eq!(up("0E+00"), "0.0E+00");
    }

    #[test]
    fn increase_applies_to_every_numeric_section() {
        assert_eq!(up("0.00;-0.00"), "0.000;-0.000");
        assert_eq!(up("0.0;(0.0);\"-\""), "0.00;(0.00);\"-\"");
    }

    #[test]
    fn increase_leaves_text_section_untouched() {
        // Number section nudged, @ text section unchanged.
        assert_eq!(up("0.0;@"), "0.00;@");
    }

    #[test]
    fn increase_is_noop_on_pure_date_format() {
        assert_eq!(up("yyyy-mm-dd"), "yyyy-mm-dd");
        assert_eq!(up("m/d/yyyy"), "m/d/yyyy");
    }

    #[test]
    fn increase_is_noop_on_text_only_format() {
        assert_eq!(up("@"), "@");
    }

    #[test]
    fn increase_caps_at_max_decimals() {
        let at_cap = format!("0.{}", "0".repeat(MAX_DECIMALS));
        // Already at the 30-decimal cap → increase is a no-op.
        assert_eq!(nudge_format_decimals(&at_cap, 1).unwrap(), at_cap);
    }

    #[test]
    fn increase_does_not_treat_quoted_dot_as_decimal() {
        // The '.' inside the quoted literal is NOT a decimal point — it is
        // preserved verbatim and a real ".0" fraction is appended instead
        // (the format `0"."0` has no actual decimal, so increase adds one).
        assert_eq!(up("0\".\"0"), "0\".\"0.0");
    }

    #[test]
    fn increase_does_not_treat_escaped_dot_as_decimal() {
        // Same for an escaped '\.': preserved, real decimal added separately.
        assert_eq!(up("0\\.0"), "0\\.0.0");
    }

    // ===== Decrease =====

    #[test]
    fn decrease_removes_last_fraction_digit() {
        assert_eq!(down("0.000"), "0.00");
        assert_eq!(down("0.00"), "0.0");
    }

    #[test]
    fn decrease_to_zero_removes_decimal_point() {
        assert_eq!(down("0.0"), "0");
        assert_eq!(down("#,##0.0"), "#,##0");
        assert_eq!(down("0.0%"), "0%");
    }

    #[test]
    fn decrease_is_noop_at_zero_decimals() {
        assert_eq!(down("0"), "0");
        assert_eq!(down("#,##0"), "#,##0");
    }

    #[test]
    fn decrease_scientific_targets_mantissa() {
        assert_eq!(down("0.00E+00"), "0.0E+00");
        assert_eq!(down("0.0E+00"), "0E+00");
    }

    #[test]
    fn decrease_applies_to_every_numeric_section() {
        assert_eq!(down("0.00;-0.00"), "0.0;-0.0");
        assert_eq!(down("0.0;-0.0"), "0;-0");
    }

    #[test]
    fn decrease_is_noop_on_pure_date_format() {
        assert_eq!(down("yyyy-mm-dd"), "yyyy-mm-dd");
    }

    #[test]
    fn decrease_currency_to_integer() {
        assert_eq!(down("$#,##0.0"), "$#,##0");
    }

    // ===== Round-trips / multi-step / edges =====

    #[test]
    fn increase_then_decrease_round_trips_common_formats() {
        for f in ["0", "0.00", "#,##0.00", "0.0%", "$#,##0.00", "0.00E+00"] {
            assert_eq!(down(&up(f)), f, "round-trip failed for {f}");
        }
    }

    #[test]
    fn multi_step_delta_adds_multiple_places() {
        assert_eq!(nudge_format_decimals("0", 3).unwrap(), "0.000");
        assert_eq!(nudge_format_decimals("0.00000", -3).unwrap(), "0.00");
    }

    #[test]
    fn multi_step_decrease_clamps_at_zero() {
        assert_eq!(nudge_format_decimals("0.0", -5).unwrap(), "0");
    }

    #[test]
    fn delta_zero_is_identity() {
        assert_eq!(nudge_format_decimals("0.00", 0).unwrap(), "0.00");
    }

    #[test]
    fn general_literal_is_noop_both_directions() {
        // The runtime maps unbound/General cells to base "0"; a literal
        // "General" passed directly here is a documented no-op.
        assert_eq!(up("General"), "General");
        assert_eq!(down("General"), "General");
    }

    #[test]
    fn leading_period_format_decrease_keeps_valid_number() {
        // ".0" decreasing past zero must not collapse to an invalid ".".
        assert_eq!(down(".0"), "0");
    }

    #[test]
    fn malformed_input_surfaces_error() {
        // An unparseable format is rejected loudly (No-Fallbacks), not coerced.
        // 5 sections exceeds Excel's 4-section cap → TooManySections.
        assert!(nudge_format_decimals("0;0;0;0;0", 1).is_err());
        // Empty string is not a valid format either.
        assert!(nudge_format_decimals("", 1).is_err());
    }

    #[test]
    fn result_always_reparses() {
        for f in ["0", "0.0", "0.00", "#,##0.00", "0%", "0.0%", "$#,##0.00"] {
            let u = up(f);
            assert!(parse(&u).is_ok(), "increase of {f} -> {u} did not reparse");
            let d = down(f);
            assert!(parse(&d).is_ok(), "decrease of {f} -> {d} did not reparse");
        }
    }

    // ===== Audit-driven regression tests (Wave B 5-lane panel) =====

    #[test]
    fn delta_zero_validates_input() {
        // Finding 10: the delta==0 path must still reject an unparseable input
        // (No-Fallbacks: never return Ok for a format we can't represent).
        assert!(nudge_format_decimals("0;0;0;0;0", 0).is_err());
        assert!(nudge_format_decimals("", 0).is_err());
    }

    #[test]
    fn escaped_and_quoted_dot_round_trip() {
        // Numerical-lane LOW-3: the escaped/quoted-dot formats (no real decimal)
        // gain a real ".0" on increase and lose it on decrease, round-tripping.
        assert_eq!(down(&up("0\\.0")), "0\\.0");
        assert_eq!(down(&up("0\".\"0")), "0\".\"0");
    }

    #[test]
    fn decrease_preserves_literal_between_point_and_fraction() {
        // Numerical-lane LOW-1 fix: a literal token BETWEEN the decimal point
        // and the single fraction digit is PRESERVED (precise point+digit
        // removal), not swept away by an inclusive-span delete.
        // `0."x"0` (one fraction digit `0` after a quoted literal) → `0"x"`.
        let out = down("0.\"x\"0");
        assert_eq!(out, "0\"x\"");
        // And the result re-parses (still a valid number format).
        assert!(parse(&out).is_ok());
    }

    #[test]
    fn nonstandard_slash_fraction_does_not_corrupt() {
        // Opus-lane LOW: `0/0` / `#/#` slip the `?/?` fraction guard and are
        // treated as plain numeric sections. The nudge must still produce a
        // re-parseable result (the safety net), never silent corruption.
        let u = up("0/0");
        assert!(parse(&u).is_ok(), "0/0 increase -> {u} did not reparse");
        let u2 = up("#/#");
        assert!(parse(&u2).is_ok(), "#/# increase -> {u2} did not reparse");
    }
}
