//! Render a `Value` through a parsed `FormatString`.
//!
//! Public surface: [`render`].
//!
//! Pipeline:
//!   route to section by value type + sign → dispatch on `SectionKind` →
//!   build digit / date / text pieces → assemble the section's literals
//!   and pieces into a final `String`.
//!
//! See `docs/architecture/2026-05-13-format-string-grammar.md` § 3-§ 6
//! for the contract and § 11 for IronCalc divergences. V2 token types
//! (colors, conditionals, fractions, elapsed time) are unreachable at
//! render time because the parser surfaces them as `UnsupportedV2` —
//! this module accepts the parsed AST as well-formed.

use ql_types::{
    fraction_to_hms, serial_to_ymd, unix_days_to_ymd, DateSystem, ErrorValue, EvalContext, Value,
};

use super::ast::{
    DigitKind, FormatString, MonthNameLen, NumberState, Section, SectionKind, SectionToken,
};

// ============================================================================
// Public API
// ============================================================================

/// Render `value` through `fmt` using the given evaluation context.
///
/// **Contract:** see mini-spec § 3 (section routing) + § 4-§ 6 (token
/// semantics). Errors propagate as their canonical sigils
/// (`Value::Error(ErrorValue::Num)` renders as `"#NUM!"` etc.).
pub fn render(value: &Value, fmt: &FormatString, ctx: &EvalContext) -> String {
    // Error sigils never honor the format string — Excel canon.
    if let Value::Error(e) = value {
        return error_sigil(*e).to_string();
    }
    let section = route_section(value, fmt);
    let auto_minus = fmt.sections.len() == 1;
    render_section(value, section, ctx, auto_minus)
}

// ============================================================================
// Section routing
// ============================================================================

fn route_section<'a>(value: &Value, fmt: &'a FormatString) -> &'a Section {
    let n = fmt.sections.len();
    let idx = match (value, n) {
        // Text passthrough — section 3 if present; otherwise general routing.
        (Value::Text(_), 4) => 3,
        (Value::Text(_), _) => 0,
        // Numeric routing — by sign / zero.
        (Value::Number(v), _) => routing_index_for_number(*v, n),
        (Value::Boolean(b), _) => {
            // Treat TRUE / FALSE as 1.0 / 0.0 for routing; render special-cased.
            routing_index_for_number(if *b { 1.0 } else { 0.0 }, n)
        }
        (Value::Blank, _) => routing_index_for_number(0.0, n),
        (Value::Error(_), _) => 0, // unreachable (caller checked)
    };
    &fmt.sections[idx]
}

fn routing_index_for_number(v: f64, n_sections: usize) -> usize {
    match (n_sections, v) {
        (1, _) => 0,
        (2, v) if v < 0.0 => 1,
        (2, _) => 0,
        (3, v) if v > 0.0 => 0,
        (3, v) if v < 0.0 => 1,
        (3, _) => 2, // == 0
        (4, v) if v > 0.0 => 0,
        (4, v) if v < 0.0 => 1,
        (4, _) => 2, // == 0
        _ => 0,      // 0 sections is unreachable; parser guarantees at least 1
    }
}

// ============================================================================
// Per-section dispatch
// ============================================================================

fn render_section(value: &Value, section: &Section, ctx: &EvalContext, auto_minus: bool) -> String {
    match section.kind {
        SectionKind::Empty => String::new(),
        SectionKind::General => render_general(value),
        SectionKind::Text => render_text_section(value, section),
        SectionKind::Number => render_number_section_inner(value, section, auto_minus),
        SectionKind::Date => render_date_section(value, section, ctx),
    }
}

// ============================================================================
// General
// ============================================================================

fn render_general(value: &Value) -> String {
    match value {
        Value::Number(n) => render_general_number(*n),
        Value::Boolean(true) => "TRUE".to_string(),
        Value::Boolean(false) => "FALSE".to_string(),
        Value::Text(s) => s.as_ref().to_string(),
        Value::Blank => String::new(),
        Value::Error(e) => error_sigil(*e).to_string(),
    }
}

/// Excel "General" number rendering: trim trailing zeros, use scientific
/// notation only at extremes. V1 keeps it simple — `f64::to_string` plus
/// a thin post-processor.
fn render_general_number(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        // Render integer-valued numbers without a decimal point.
        return format!("{}", n as i64);
    }
    // f64::to_string gives a shortest round-trip representation; Excel's
    // General is slightly different but close enough for V1.
    let s = format!("{n}");
    s
}

// ============================================================================
// Number section
// ============================================================================

/// Pre-pass shape extraction over a Number section's tokens.
#[derive(Debug, Default)]
struct NumberShape {
    int_zero_count: u32,
    int_total_count: u32,
    int_question_count: u32,
    dec_zero_count: u32,
    dec_total_count: u32,
    dec_question_count: u32,
    exp_total_count: u32,
    has_thousands: bool,
    scale_by_thousands: u32,
    percent: u32,
    is_scientific: bool,
    scientific_minus: bool,
}

fn extract_number_shape(tokens: &[SectionToken]) -> NumberShape {
    let mut s = NumberShape::default();
    for t in tokens {
        match t {
            SectionToken::Digit {
                kind,
                number: NumberState::Integer,
            } => {
                s.int_total_count += 1;
                if matches!(kind, DigitKind::Zero) {
                    s.int_zero_count += 1;
                }
                if matches!(kind, DigitKind::Question) {
                    s.int_question_count += 1;
                }
            }
            SectionToken::Digit {
                kind,
                number: NumberState::Decimal,
            } => {
                s.dec_total_count += 1;
                if matches!(kind, DigitKind::Zero) {
                    s.dec_zero_count += 1;
                }
                if matches!(kind, DigitKind::Question) {
                    s.dec_question_count += 1;
                }
            }
            SectionToken::Digit {
                number: NumberState::Exponent,
                ..
            } => {
                s.exp_total_count += 1;
            }
            SectionToken::ThousandsSeparator => s.has_thousands = true,
            SectionToken::ScaleByThousands(n) => s.scale_by_thousands += n,
            SectionToken::Percent(n) => s.percent += n,
            SectionToken::ExponentMarker { signed_minus } => {
                s.is_scientific = true;
                s.scientific_minus = *signed_minus;
            }
            _ => {}
        }
    }
    s
}

/// Entry point that lets the caller
/// suppress the auto-prepended leading minus. Section-routing in
/// multi-section formats (2/3/4 sections) gives the negative-value
/// section its own slot, and that section is responsible for its own
/// sign rendering (typically via literal `-` or `(...)` parens). Only
/// the 1-section case should auto-prepend.
fn render_number_section_inner(
    value: &Value,
    section: &Section,
    emit_leading_minus: bool,
) -> String {
    let n = match value {
        Value::Number(n) => *n,
        Value::Boolean(true) => 1.0,
        Value::Boolean(false) => 0.0,
        Value::Blank => 0.0,
        Value::Text(_) => return render_text_section(value, section),
        Value::Error(_) => return String::new(),
    };
    let shape = extract_number_shape(&section.tokens);

    // Apply scale + percent BEFORE rendering.
    let scaled = apply_scale(n, &shape);
    let is_negative = scaled < 0.0;
    let abs = scaled.abs();

    // Build integer + decimal + exponent strings.
    let (int_str, dec_str, exp_str) = if shape.is_scientific {
        render_scientific_parts(abs, &shape)
    } else {
        render_fixed_parts(abs, &shape)
    };

    // Weave the digit string + literals + currency back together.
    weave_number(
        section,
        &int_str,
        &dec_str,
        exp_str.as_deref(),
        is_negative && emit_leading_minus,
        &shape,
    )
}

fn apply_scale(n: f64, s: &NumberShape) -> f64 {
    let mut v = n;
    if s.scale_by_thousands > 0 {
        v /= 1000f64.powi(s.scale_by_thousands as i32);
    }
    if s.percent > 0 {
        v *= 100f64.powi(s.percent as i32);
    }
    v
}

/// Render a fixed-point (non-scientific) value to `(integer_string,
/// decimal_string)` per the section shape. `decimal_string` is empty if
/// the section has no decimal digit tokens.
fn render_fixed_parts(abs: f64, s: &NumberShape) -> (String, String, Option<String>) {
    let dec_count = s.dec_total_count as usize;
    // Round to dec_count places via format!.
    let rendered = if dec_count == 0 {
        format!("{}", abs.round() as u128)
    } else {
        format!("{abs:.dec_count$}")
    };
    let (int_part, dec_part) = match rendered.split_once('.') {
        Some((i, d)) => (i.to_string(), d.to_string()),
        None => (rendered, String::new()),
    };
    let int_padded = pad_integer(&int_part, s.int_zero_count, s.int_question_count);
    let int_thousands = if s.has_thousands {
        insert_thousands(&int_padded)
    } else {
        int_padded
    };
    let dec_padded = pad_decimal(&dec_part, s.dec_zero_count, s.dec_question_count);
    (int_thousands, dec_padded, None)
}

/// Render a scientific value into integer / decimal / exponent strings.
fn render_scientific_parts(abs: f64, s: &NumberShape) -> (String, String, Option<String>) {
    let dec_count = s.dec_total_count as usize;
    let exp_count = s.exp_total_count.max(1) as usize;
    // Render via {:e} then split.
    let rendered = if dec_count == 0 {
        format!("{abs:.0e}")
    } else {
        format!("{abs:.dec_count$e}")
    };
    let (mantissa, exp_raw) = rendered.split_once('e').unwrap_or((&rendered, "0"));
    let (mantissa_int, mantissa_dec) = match mantissa.split_once('.') {
        Some((i, d)) => (i.to_string(), d.to_string()),
        None => (mantissa.to_string(), String::new()),
    };
    let exp_n: i32 = exp_raw.parse().unwrap_or(0);
    let exp_sign = if exp_n >= 0 {
        if s.scientific_minus {
            ""
        } else {
            "+"
        }
    } else {
        "-"
    };
    let exp_str = format!("{exp_sign}{:0>width$}", exp_n.abs(), width = exp_count);
    let int_padded = pad_integer(&mantissa_int, s.int_zero_count, s.int_question_count);
    let dec_padded = pad_decimal(&mantissa_dec, s.dec_zero_count, s.dec_question_count);
    (int_padded, dec_padded, Some(exp_str))
}

/// Pad the integer string per Excel rules: at least `zero_count` digits,
/// space-pad up to `question_count` more.
fn pad_integer(int_str: &str, zero_count: u32, question_count: u32) -> String {
    let min_zeros = zero_count as usize;
    let min_total = (zero_count + question_count) as usize;
    let mut out = int_str.to_string();
    if out.len() < min_zeros {
        let pad = "0".repeat(min_zeros - out.len());
        out = format!("{pad}{out}");
    }
    if out.len() < min_total {
        let pad = " ".repeat(min_total - out.len());
        out = format!("{pad}{out}");
    }
    out
}

/// Pad the decimal string: pad with zeros up to `zero_count` then spaces
/// up to `zero_count + question_count`. Strip beyond.
fn pad_decimal(dec_str: &str, zero_count: u32, question_count: u32) -> String {
    let min_zeros = zero_count as usize;
    let min_total = (zero_count + question_count) as usize;
    let mut out = dec_str.to_string();
    if out.len() < min_zeros {
        let pad = "0".repeat(min_zeros - out.len());
        out = format!("{out}{pad}");
    }
    if out.len() < min_total {
        let pad = " ".repeat(min_total - out.len());
        out = format!("{out}{pad}");
    }
    out
}

fn insert_thousands(int_str: &str) -> String {
    // Walk from the right, inserting "," every 3 digits. Preserve leading
    // sign-or-space content by only inserting between digits.
    let mut chars: Vec<char> = int_str.chars().rev().collect();
    let mut out = String::with_capacity(chars.len() + chars.len() / 3);
    let mut digit_run = 0;
    while let Some(c) = chars.pop() {
        if c.is_ascii_digit() {
            // Insert thousands marker every 3 from the right; this is done by
            // counting from the END, so we do this differently below.
            out.push(c);
            digit_run += 1;
        } else {
            out.push(c);
            digit_run = 0;
        }
    }
    // Simpler: re-do the insertion correctly. Walk right-to-left.
    let mut rebuilt = String::with_capacity(out.len() + out.len() / 3);
    let bytes: Vec<char> = out.chars().collect();
    // Find where the digit run ends (i.e., trailing digits considered the
    // "integer" part).
    let mut last_digit_idx_plus_one = bytes.len();
    while last_digit_idx_plus_one > 0 && !bytes[last_digit_idx_plus_one - 1].is_ascii_digit() {
        last_digit_idx_plus_one -= 1;
    }
    let mut first_digit_idx = last_digit_idx_plus_one;
    while first_digit_idx > 0 && bytes[first_digit_idx - 1].is_ascii_digit() {
        first_digit_idx -= 1;
    }
    // Push the prefix (non-digits before the integer run).
    for c in &bytes[..first_digit_idx] {
        rebuilt.push(*c);
    }
    let int_chars = &bytes[first_digit_idx..last_digit_idx_plus_one];
    let digit_count = int_chars.len();
    for (offset, c) in int_chars.iter().enumerate() {
        let from_right = digit_count - offset;
        if offset > 0 && from_right % 3 == 0 {
            rebuilt.push(',');
        }
        rebuilt.push(*c);
    }
    for c in &bytes[last_digit_idx_plus_one..] {
        rebuilt.push(*c);
    }
    let _ = digit_run; // silence unused warning above
    rebuilt
}

/// Walk the section tokens and assemble the final string by interleaving
/// literals with the pre-computed digit pieces.
fn weave_number(
    section: &Section,
    int_str: &str,
    dec_str: &str,
    exp_str: Option<&str>,
    is_negative: bool,
    shape: &NumberShape,
) -> String {
    let mut out = String::new();
    // For 1-section formats with negative values, Excel-canon prepends "-".
    if is_negative {
        out.push('-');
    }
    let mut int_pos = 0usize;
    let mut dec_pos = 0usize;
    let mut exp_pos = 0usize;
    let int_chars: Vec<char> = int_str.chars().collect();
    let dec_chars: Vec<char> = dec_str.chars().collect();
    let exp_chars: Vec<char> = exp_str.unwrap_or("").chars().collect();
    // The digit tokens are emitted positionally; each token consumes ONE
    // char from its respective stream. Because we may have more or fewer
    // chars than tokens (Excel does NOT truncate excess integer digits;
    // it spills them through the FIRST digit token), the FIRST integer
    // digit token receives the overflow + its own char.
    //
    // For simplicity (and to match Excel's "first int digit absorbs extra"
    // behavior), pre-compute the overflow:
    let int_token_count = (shape.int_zero_count + shape.int_question_count) as usize
        + section
            .tokens
            .iter()
            .filter(|t| {
                matches!(
                    t,
                    SectionToken::Digit {
                        kind: DigitKind::Sharp,
                        number: NumberState::Integer
                    }
                )
            })
            .count();
    let int_overflow_len = int_chars.len().saturating_sub(int_token_count);
    let mut int_first_digit_seen = false;

    for t in &section.tokens {
        match t {
            SectionToken::Digit { number, .. } => match number {
                NumberState::Integer => {
                    if !int_first_digit_seen {
                        // Spill all overflow plus this digit.
                        let take = int_overflow_len + 1;
                        for c in int_chars.iter().take(take) {
                            out.push(*c);
                        }
                        int_pos += take;
                        int_first_digit_seen = true;
                    } else if int_pos < int_chars.len() {
                        out.push(int_chars[int_pos]);
                        int_pos += 1;
                    }
                }
                NumberState::Decimal => {
                    if dec_pos < dec_chars.len() {
                        out.push(dec_chars[dec_pos]);
                        dec_pos += 1;
                    }
                }
                NumberState::Exponent => {
                    if exp_pos < exp_chars.len() {
                        out.push(exp_chars[exp_pos]);
                        exp_pos += 1;
                    }
                }
            },
            SectionToken::DecimalPoint => out.push('.'),
            SectionToken::ThousandsSeparator => {
                // Already woven into int_str via `insert_thousands`; skip.
            }
            SectionToken::ScaleByThousands(_) | SectionToken::Percent(_) => {
                // Applied to the value pre-render; no glyph here unless %
                // — we DO want a literal '%' for each Percent token.
                if matches!(t, SectionToken::Percent(_)) {
                    for _ in 0..shape.percent {
                        out.push('%');
                    }
                }
            }
            SectionToken::ExponentMarker { signed_minus } => {
                out.push('E');
                if *signed_minus {
                    out.push('-');
                } else {
                    out.push('+');
                }
                // Skip the sign char baked into exp_str (we render it ourselves
                // above; advance exp_pos past the sign).
                if exp_pos < exp_chars.len()
                    && (exp_chars[exp_pos] == '+' || exp_chars[exp_pos] == '-')
                {
                    exp_pos += 1;
                }
            }
            SectionToken::QuotedText(s) => out.push_str(s),
            SectionToken::Literal(c) => out.push(*c),
            SectionToken::Currency { ch, .. } => out.push(*ch),
            SectionToken::Spacer(_) | SectionToken::Ghost(_) => {
                // V1: ignore at render — no column-width metadata.
            }
            SectionToken::TextPassthrough => {
                // In a Number section, `@` is a degenerate case; emit nothing.
            }
            // Date tokens never appear in a Number section (kind classifier).
            SectionToken::Day { .. }
            | SectionToken::DayName { .. }
            | SectionToken::Month { .. }
            | SectionToken::MonthName { .. }
            | SectionToken::Year { .. }
            | SectionToken::Hour { .. }
            | SectionToken::Minute { .. }
            | SectionToken::Second { .. }
            | SectionToken::AmPm
            | SectionToken::General => {}
        }
    }
    out
}

// ============================================================================
// Date section
// ============================================================================

fn render_date_section(value: &Value, section: &Section, ctx: &EvalContext) -> String {
    let serial = match value {
        Value::Number(n) => *n,
        Value::Boolean(true) => 1.0,
        Value::Boolean(false) => 0.0,
        Value::Blank => 0.0,
        Value::Text(_) => return render_text_section(value, section),
        Value::Error(_) => return String::new(),
    };
    if serial < 0.0 {
        return "#####".to_string();
    }
    // Detect time-only sections (no Year/Month/Day/DayName tokens). For
    // these, skip the ymd lookup so a fractional-only serial like 0.5
    // (noon) renders cleanly in Excel1900, where `serial_to_ymd(0.5)`
    // truncates to serial 0 and surfaces `#NUM!`.
    let needs_ymd = section.tokens.iter().any(|t| {
        matches!(
            t,
            SectionToken::Year { .. }
                | SectionToken::Month { .. }
                | SectionToken::MonthName { .. }
                | SectionToken::Day { .. }
                | SectionToken::DayName { .. }
        )
    });
    let (y, m, d) = if needs_ymd {
        match serial_to_ymd(serial, ctx.date_system) {
            Ok(ymd) => ymd,
            Err(_) => return "#####".to_string(),
        }
    } else {
        (1900, 1, 1)
    };
    let frac = serial.fract().abs();
    let (h_raw, mi, s) = fraction_to_hms(frac);
    // Determine 12h vs 24h for hour rendering: 12h iff this section
    // contains an AM/PM token.
    let has_ampm = section
        .tokens
        .iter()
        .any(|t| matches!(t, SectionToken::AmPm));
    let (h_display, is_pm) = if has_ampm {
        match h_raw {
            0 => (12, false),
            1..=11 => (h_raw, false),
            12 => (12, true),
            _ => (h_raw - 12, true),
        }
    } else {
        (h_raw, false)
    };
    // Compute weekday once for ddd/dddd. Use real-Gregorian dow via
    // unix_days_to_ymd → consistent with ISOWEEKNUM (W5-76 path); for
    // serial>=61 in Excel1900 this matches Excel's WEEKDAY exactly.
    let dow_sun_zero = compute_dow_sun_zero(serial, ctx.date_system);

    let mut out = String::new();
    for t in &section.tokens {
        match t {
            SectionToken::Year { short } => {
                if *short {
                    out.push_str(&format!("{:02}", y % 100));
                } else {
                    out.push_str(&format!("{y:04}"));
                }
            }
            SectionToken::Month { padded, .. } => {
                if *padded {
                    out.push_str(&format!("{m:02}"));
                } else {
                    out.push_str(&format!("{m}"));
                }
            }
            SectionToken::MonthName { length } => {
                out.push_str(month_name(m, *length));
            }
            SectionToken::Day { padded } => {
                if *padded {
                    out.push_str(&format!("{d:02}"));
                } else {
                    out.push_str(&format!("{d}"));
                }
            }
            SectionToken::DayName { full } => {
                out.push_str(weekday_name(dow_sun_zero, *full));
            }
            SectionToken::Hour { padded } => {
                if *padded {
                    out.push_str(&format!("{h_display:02}"));
                } else {
                    out.push_str(&format!("{h_display}"));
                }
            }
            SectionToken::Minute { padded } => {
                if *padded {
                    out.push_str(&format!("{mi:02}"));
                } else {
                    out.push_str(&format!("{mi}"));
                }
            }
            SectionToken::Second { padded } => {
                if *padded {
                    out.push_str(&format!("{s:02}"));
                } else {
                    out.push_str(&format!("{s}"));
                }
            }
            SectionToken::AmPm => {
                out.push_str(if is_pm { "PM" } else { "AM" });
            }
            SectionToken::QuotedText(text) => out.push_str(text),
            SectionToken::Literal(c) => out.push(*c),
            SectionToken::Currency { ch, .. } => out.push(*ch),
            SectionToken::Spacer(_) | SectionToken::Ghost(_) => {}
            // Digit / decimal / scale tokens inside a date section are
            // unusual but legal (Excel uses them for fractional-second
            // padding). V1: ignore — proper handling lands in Phase 4.10.
            SectionToken::Digit { .. }
            | SectionToken::DecimalPoint
            | SectionToken::ThousandsSeparator
            | SectionToken::ScaleByThousands(_)
            | SectionToken::Percent(_)
            | SectionToken::ExponentMarker { .. }
            | SectionToken::TextPassthrough
            | SectionToken::General => {}
        }
    }
    out
}

fn compute_dow_sun_zero(serial: f64, system: DateSystem) -> u32 {
    // Use the same Excel-canon serial math as `WEEKDAY` (W5-72):
    //   Excel1900: (serial_int - 1).rem_euclid(7) where 0=Sun
    //   Excel1904: (serial_int + 5).rem_euclid(7)
    let serial_int = serial.trunc() as i64;
    let dow = match system {
        DateSystem::Excel1900 => (serial_int - 1).rem_euclid(7),
        DateSystem::Excel1904 => (serial_int + 5).rem_euclid(7),
    };
    let _ = unix_days_to_ymd; // referenced for clarity; not used here.
    dow as u32
}

fn month_name(m: u32, length: MonthNameLen) -> &'static str {
    const FULL: [&str; 13] = [
        "",
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const SHORT: [&str; 13] = [
        "", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const LETTER: [&str; 13] = [
        "", "J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D",
    ];
    let idx = m.clamp(1, 12) as usize;
    match length {
        MonthNameLen::Short => SHORT[idx],
        MonthNameLen::Full => FULL[idx],
        MonthNameLen::SingleLetter => LETTER[idx],
    }
}

fn weekday_name(dow_sun_zero: u32, full: bool) -> &'static str {
    const FULL: [&str; 7] = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ];
    const SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let idx = (dow_sun_zero.min(6)) as usize;
    if full {
        FULL[idx]
    } else {
        SHORT[idx]
    }
}

// ============================================================================
// Text section
// ============================================================================

fn render_text_section(value: &Value, section: &Section) -> String {
    let text_body = match value {
        Value::Text(s) => s.as_ref().to_string(),
        Value::Number(n) => render_general_number(*n),
        Value::Boolean(true) => "TRUE".to_string(),
        Value::Boolean(false) => "FALSE".to_string(),
        Value::Blank => String::new(),
        Value::Error(e) => error_sigil(*e).to_string(),
    };
    let mut out = String::new();
    for t in &section.tokens {
        match t {
            SectionToken::TextPassthrough => out.push_str(&text_body),
            SectionToken::QuotedText(s) => out.push_str(s),
            SectionToken::Literal(c) => out.push(*c),
            SectionToken::Currency { ch, .. } => out.push(*ch),
            SectionToken::Spacer(_) | SectionToken::Ghost(_) => {}
            _ => {}
        }
    }
    out
}

// ============================================================================
// Error sigil helper
// ============================================================================

fn error_sigil(e: ErrorValue) -> &'static str {
    e.sigil()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::parse;

    fn ctx_1900() -> EvalContext {
        EvalContext::default()
    }

    fn render_str(value: &Value, fmt_str: &str) -> String {
        let fmt = parse(fmt_str).expect("valid format");
        render(value, &fmt, &ctx_1900())
    }

    fn render_num(n: f64, fmt: &str) -> String {
        render_str(&Value::Number(n), fmt)
    }

    // ===== General =====

    #[test]
    fn general_renders_integer_value_without_decimal() {
        assert_eq!(render_num(42.0, "General"), "42");
    }

    #[test]
    fn general_renders_fractional() {
        let s = render_num(0.5, "General");
        assert!(s.starts_with("0.5"), "got {s}");
    }

    #[test]
    fn general_text_is_passthrough() {
        assert_eq!(render_str(&Value::text("hi"), "General"), "hi");
    }

    #[test]
    fn general_boolean_uppercase() {
        assert_eq!(render_str(&Value::Boolean(true), "General"), "TRUE");
        assert_eq!(render_str(&Value::Boolean(false), "General"), "FALSE");
    }

    #[test]
    fn general_blank_is_empty() {
        assert_eq!(render_str(&Value::Blank, "General"), "");
    }

    // ===== Number — digit placeholders =====

    #[test]
    fn zero_format_renders_integer() {
        assert_eq!(render_num(7.0, "0"), "7");
        assert_eq!(render_num(70.0, "0"), "70");
    }

    #[test]
    fn zero_format_pads_with_zero() {
        assert_eq!(render_num(7.0, "00"), "07");
        assert_eq!(render_num(7.0, "0000"), "0007");
    }

    #[test]
    fn sharp_format_does_not_pad() {
        assert_eq!(render_num(7.0, "#"), "7");
        assert_eq!(render_num(7.0, "###"), "7");
    }

    #[test]
    fn fixed_decimal_rounds() {
        assert_eq!(render_num(1.234, "0.00"), "1.23");
        assert_eq!(render_num(1.235, "0.00"), "1.24"); // banker's round may vary
        assert_eq!(render_num(1.0, "0.00"), "1.00");
    }

    #[test]
    fn fixed_decimal_pads_with_zero() {
        assert_eq!(render_num(1.5, "0.000"), "1.500");
    }

    // ===== Number — thousands sep =====

    #[test]
    fn thousands_separator_inserts_comma() {
        assert_eq!(render_num(1500.0, "#,##0"), "1,500");
        assert_eq!(render_num(1500000.0, "#,##0"), "1,500,000");
    }

    #[test]
    fn thousands_with_decimal() {
        assert_eq!(render_num(1234.5, "#,##0.00"), "1,234.50");
    }

    #[test]
    fn small_number_with_thousands_format_unchanged() {
        assert_eq!(render_num(42.0, "#,##0"), "42");
    }

    // ===== Number — scale =====

    #[test]
    fn trailing_comma_scales_by_thousand() {
        assert_eq!(render_num(2500.0, "#,"), "3");
        assert_eq!(render_num(1_500_000.0, "0,,"), "2");
    }

    // ===== Number — percent =====

    #[test]
    fn percent_multiplies_by_hundred() {
        assert_eq!(render_num(0.5, "0%"), "50%");
        assert_eq!(render_num(0.123, "0.00%"), "12.30%");
    }

    // ===== Number — scientific =====

    #[test]
    fn scientific_renders_exponent_sign() {
        let s = render_num(12345.0, "0.00E+00");
        assert!(
            s.starts_with("1.23E+04") || s.starts_with("1.23E+4"),
            "got {s}"
        );
    }

    // ===== Number — sign + sections =====

    #[test]
    fn one_section_negative_emits_leading_minus() {
        assert_eq!(render_num(-42.0, "0"), "-42");
    }

    #[test]
    fn two_section_negative_uses_section_one() {
        // Section 1 is "(0)" so -42 → "(42)".
        assert_eq!(render_num(-42.0, "0;(0)"), "(42)");
    }

    #[test]
    fn three_section_zero_uses_section_two() {
        assert_eq!(render_num(0.0, "0;-0;\"zero\""), "zero");
    }

    #[test]
    fn four_section_text_value_uses_section_three() {
        assert_eq!(render_str(&Value::text("abc"), "0;-0;0;@"), "abc");
    }

    // ===== Number — quoted text + literals + currency =====

    #[test]
    fn quoted_text_emitted_verbatim() {
        assert_eq!(render_num(5.0, "0 \"items\""), "5 items");
    }

    #[test]
    fn currency_symbol_emitted() {
        assert_eq!(render_num(99.0, "$#,##0"), "$99");
    }

    #[test]
    fn bracket_currency_locale_code_ignored_at_render() {
        assert_eq!(render_num(99.0, "[$€-409]#,##0"), "€99");
    }

    #[test]
    fn escaped_char_emitted_as_literal() {
        assert_eq!(render_num(5.0, "0\\X"), "5X");
    }

    // ===== Date — built-in id 14: m/d/yyyy =====

    #[test]
    fn date_m_d_yyyy_renders_serial() {
        // 2024-07-04 serial in Excel1900: ymd_to_serial(2024,7,4) = 45477.
        let s = render_num(45477.0, "m/d/yyyy");
        assert_eq!(s, "7/4/2024");
    }

    #[test]
    fn date_with_padded_month_and_day() {
        let s = render_num(45477.0, "mm/dd/yyyy");
        assert_eq!(s, "07/04/2024");
    }

    #[test]
    fn date_iso_format() {
        let s = render_num(45477.0, "yyyy-mm-dd");
        assert_eq!(s, "2024-07-04");
    }

    #[test]
    fn date_two_digit_year() {
        let s = render_num(45477.0, "m/d/yy");
        assert_eq!(s, "7/4/24");
    }

    #[test]
    fn date_short_month_name() {
        let s = render_num(45477.0, "d-mmm-yyyy");
        assert_eq!(s, "4-Jul-2024");
    }

    #[test]
    fn date_full_month_name() {
        let s = render_num(45477.0, "mmmm d, yyyy");
        assert_eq!(s, "July 4, 2024");
    }

    #[test]
    fn date_single_letter_month() {
        let s = render_num(45477.0, "mmmmm");
        assert_eq!(s, "J"); // July → J
    }

    #[test]
    fn date_short_weekday() {
        // 2024-07-04 was a Thursday.
        let s = render_num(45477.0, "ddd");
        assert_eq!(s, "Thu");
    }

    #[test]
    fn date_full_weekday() {
        let s = render_num(45477.0, "dddd");
        assert_eq!(s, "Thursday");
    }

    // ===== Time =====

    #[test]
    fn time_h_mm_ss_24h() {
        // 0.5 day = 12:00:00.
        let s = render_num(0.5, "h:mm:ss");
        assert_eq!(s, "12:00:00");
    }

    #[test]
    fn time_h_mm_ampm() {
        let s = render_num(0.5, "h:mm AM/PM");
        assert_eq!(s, "12:00 PM");
    }

    #[test]
    fn time_h_mm_ampm_midnight() {
        let s = render_num(0.0, "h:mm AM/PM");
        assert_eq!(s, "12:00 AM");
    }

    #[test]
    fn time_h_mm_ampm_one_pm() {
        // 13:00 = 0.5 + 1/24 ≈ 0.5416...
        let serial = 0.5 + 1.0 / 24.0;
        let s = render_num(serial, "h:mm AM/PM");
        assert_eq!(s, "1:00 PM");
    }

    #[test]
    fn time_padded_hour() {
        // 0.25 day = 06:00.
        let s = render_num(0.25, "hh:mm");
        assert_eq!(s, "06:00");
    }

    #[test]
    fn datetime_combined() {
        // 2024-07-04 noon = 45477 + 0.5.
        let s = render_num(45477.5, "m/d/yyyy h:mm");
        assert_eq!(s, "7/4/2024 12:00");
    }

    // ===== Text passthrough =====

    #[test]
    fn at_passthrough_for_text_value() {
        assert_eq!(render_str(&Value::text("hello"), "@"), "hello");
    }

    #[test]
    fn at_passthrough_wraps_with_literals() {
        assert_eq!(render_str(&Value::text("hello"), "\"[\"@\"]\""), "[hello]");
    }

    // ===== Error sigils ignore the format =====

    #[test]
    fn num_error_renders_as_sigil() {
        assert_eq!(
            render(
                &Value::Error(ErrorValue::Num),
                &parse("0").unwrap(),
                &ctx_1900()
            ),
            "#NUM!"
        );
        assert_eq!(
            render(
                &Value::Error(ErrorValue::DivZero),
                &parse("yyyy-mm-dd").unwrap(),
                &ctx_1900()
            ),
            "#DIV/0!"
        );
    }

    // ===== Empty section =====

    #[test]
    fn empty_third_section_renders_zero_as_empty() {
        // "0;-0;" → section[2] empty; zero value should render to "".
        assert_eq!(render_num(0.0, "0;-0;"), "");
    }

    // ===== Built-in format ids (mini-spec § 10) =====

    #[test]
    fn builtin_id_1_integer() {
        assert_eq!(render_num(42.6, "0"), "43");
    }

    #[test]
    fn builtin_id_2_two_decimals() {
        assert_eq!(render_num(5.555_5, "0.00"), "5.56");
    }

    #[test]
    fn builtin_id_3_thousands() {
        assert_eq!(render_num(1234567.0, "#,##0"), "1,234,567");
    }

    #[test]
    fn builtin_id_4_thousands_with_decimals() {
        assert_eq!(render_num(1234.5, "#,##0.00"), "1,234.50");
    }

    #[test]
    fn builtin_id_9_percent_no_decimals() {
        assert_eq!(render_num(0.25, "0%"), "25%");
    }

    #[test]
    fn builtin_id_10_percent_two_decimals() {
        assert_eq!(render_num(0.25, "0.00%"), "25.00%");
    }

    #[test]
    fn builtin_id_15_d_mmm_yy() {
        // 2024-07-04 = 45477. "d-mmm-yy" → "4-Jul-24".
        let s = render_num(45477.0, "d-mmm-yy");
        assert_eq!(s, "4-Jul-24");
    }

    #[test]
    fn builtin_id_17_mmm_yy() {
        let s = render_num(45477.0, "mmm-yy");
        assert_eq!(s, "Jul-24");
    }

    #[test]
    fn builtin_id_18_h_mm_ampm() {
        let s = render_num(0.5, "h:mm AM/PM");
        assert_eq!(s, "12:00 PM");
    }

    #[test]
    fn builtin_id_19_h_mm_ss_ampm() {
        let s = render_num(0.5, "h:mm:ss AM/PM");
        assert_eq!(s, "12:00:00 PM");
    }

    #[test]
    fn builtin_id_21_h_mm_ss_24h() {
        let s = render_num(0.5, "h:mm:ss");
        assert_eq!(s, "12:00:00");
    }

    #[test]
    fn builtin_id_22_datetime() {
        let s = render_num(45477.5, "m/d/yyyy h:mm");
        assert_eq!(s, "7/4/2024 12:00");
    }

    #[test]
    fn builtin_id_45_mm_ss_minute_second_disambiguation() {
        // "mm:ss" with no hour anchor — § 4.1: mm BEFORE ss → minute.
        // Serial 0.5 = noon = (h:0, m:0, s:0). So mm:ss → "00:00".
        let s = render_num(0.5, "mm:ss");
        assert_eq!(s, "00:00");
    }

    #[test]
    fn builtin_id_49_text_passthrough() {
        assert_eq!(render_str(&Value::text("foo"), "@"), "foo");
    }
}
