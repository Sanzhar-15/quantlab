//! `TEXT(value, format_string)` — Excel-canon text formatter.
//!
//! Phase 4.5.E (W5-83). Thin wrapper around [`super::parse`] + [`super::render`].
//! Registered as a `ContextAwareFn` because the renderer needs the
//! workbook's `DateSystem` for serial→date conversion.
//!
//! Behavior per Excel canon:
//! - `TEXT(value, "")` → empty string (Excel returns "" for empty format).
//! - `TEXT(value, format)` where parse fails → `#VALUE!`.
//! - `TEXT(<error>, _)` → propagate the error (e.g. `TEXT(#NUM!, "0")` → `#NUM!`).
//! - `TEXT` arity ≠ 2 → `#VALUE!`.
//! - `format` arg coerced via `Value::Text` body; other types → `#VALUE!`
//!   (Excel-canon for `TEXT(_, 5)` is `#VALUE!` — the format must be text).

use ql_types::{ErrorValue, EvalContext, Value};

use super::{parse, render};

/// `TEXT(value, format_string)` — render `value` through the format
/// string, returning a text result. ContextAwareFn signature.
pub fn text_ctx(args: &[Value], ctx: &EvalContext) -> Value {
    if args.len() != 2 {
        return Value::Error(ErrorValue::Value);
    }
    // Propagate errors from value through (matches `+`, `-` etc. canon).
    if let Value::Error(e) = &args[0] {
        return Value::Error(*e);
    }
    // Propagate errors from format string.
    if let Value::Error(e) = &args[1] {
        return Value::Error(*e);
    }
    // Format string must be text. Excel-canon: numeric / boolean / blank
    // → `#VALUE!`. The strictness mirrors `DATEVALUE` and similar
    // text-only functions.
    let format_text: &str = match &args[1] {
        Value::Text(s) => s.as_ref(),
        Value::Blank => "",
        _ => return Value::Error(ErrorValue::Value),
    };
    if format_text.is_empty() {
        // Excel: TEXT(x, "") returns empty string regardless of x.
        return Value::text(String::new());
    }
    let fmt = match parse(format_text) {
        Ok(f) => f,
        Err(_) => return Value::Error(ErrorValue::Value),
    };
    let rendered = render(&args[0], &fmt, ctx);
    Value::text(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_1900() -> EvalContext {
        EvalContext::default()
    }
    fn n(x: f64) -> Value {
        Value::Number(x)
    }
    fn t(s: &str) -> Value {
        Value::text(s.to_string())
    }

    fn run(args: &[Value]) -> Value {
        text_ctx(args, &ctx_1900())
    }

    // ===== Arity + coercion =====

    #[test]
    fn arity_zero_is_value_error() {
        assert_eq!(run(&[]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn arity_one_is_value_error() {
        assert_eq!(run(&[n(1.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn arity_three_is_value_error() {
        assert_eq!(
            run(&[n(1.0), t("0"), t("extra")]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn numeric_format_arg_is_value_error() {
        // TEXT(1, 0) → #VALUE!: the format arg must be text.
        assert_eq!(run(&[n(1.0), n(0.0)]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn boolean_format_arg_is_value_error() {
        assert_eq!(
            run(&[n(1.0), Value::Boolean(true)]),
            Value::Error(ErrorValue::Value)
        );
    }

    #[test]
    fn empty_format_string_returns_empty_text() {
        // Excel-canon: TEXT(x, "") → "".
        assert_eq!(run(&[n(42.0), t("")]), Value::text(""));
    }

    #[test]
    fn blank_format_arg_treated_as_empty() {
        // V1 lenience: blank coerces to empty string; result is empty text.
        assert_eq!(run(&[n(42.0), Value::Blank]), Value::text(""));
    }

    // ===== Error propagation =====

    #[test]
    fn value_error_propagates() {
        assert_eq!(
            run(&[Value::Error(ErrorValue::Num), t("0.00")]),
            Value::Error(ErrorValue::Num)
        );
    }

    #[test]
    fn format_string_error_propagates() {
        assert_eq!(
            run(&[n(1.0), Value::Error(ErrorValue::Ref)]),
            Value::Error(ErrorValue::Ref)
        );
    }

    #[test]
    fn invalid_format_string_returns_value_error() {
        // `[Red]0` parses successfully as a V2-deferred token error;
        // TEXT must surface the failure as `#VALUE!`.
        assert_eq!(run(&[n(1.0), t("[Red]0")]), Value::Error(ErrorValue::Value));
    }

    #[test]
    fn invalid_year_token_surfaces_as_value_error() {
        // `yyy` triggers `FormatParseError::Other` per the mini-spec § 11
        // IronCalc divergence.
        assert_eq!(run(&[n(1.0), t("yyy")]), Value::Error(ErrorValue::Value));
    }

    // ===== Rendering: number formats =====

    #[test]
    fn text_with_two_decimals() {
        assert_eq!(run(&[n(5.6789), t("0.00")]), Value::text("5.68"));
    }

    #[test]
    fn text_with_thousands_separator() {
        assert_eq!(run(&[n(1234567.0), t("#,##0")]), Value::text("1,234,567"));
    }

    #[test]
    fn text_with_percent() {
        assert_eq!(run(&[n(0.5), t("0%")]), Value::text("50%"));
    }

    #[test]
    fn text_with_scientific() {
        let v = run(&[n(12345.0), t("0.00E+00")]);
        // Renderer produces "1.23E+04".
        assert_eq!(v, Value::text("1.23E+04"));
    }

    #[test]
    fn text_negative_in_parens() {
        // Two-section format: positive | negative.
        assert_eq!(run(&[n(-42.0), t("0;(0)")]), Value::text("(42)"));
    }

    #[test]
    fn text_with_currency() {
        assert_eq!(run(&[n(99.0), t("$#,##0")]), Value::text("$99"));
    }

    // ===== Rendering: date / time formats =====

    #[test]
    fn text_with_iso_date_format() {
        // 2024-07-04 = serial 45477 in Excel1900.
        assert_eq!(
            run(&[n(45477.0), t("yyyy-mm-dd")]),
            Value::text("2024-07-04")
        );
    }

    #[test]
    fn text_with_short_month_name() {
        assert_eq!(
            run(&[n(45477.0), t("d-mmm-yyyy")]),
            Value::text("4-Jul-2024")
        );
    }

    #[test]
    fn text_with_time_ampm() {
        // Noon = 0.5.
        assert_eq!(run(&[n(0.5), t("h:mm AM/PM")]), Value::text("12:00 PM"));
    }

    #[test]
    fn text_with_combined_datetime() {
        assert_eq!(
            run(&[n(45477.5), t("m/d/yyyy h:mm")]),
            Value::text("7/4/2024 12:00")
        );
    }

    // ===== Rendering: text passthrough + General =====

    #[test]
    fn text_at_passthrough_for_text_value() {
        assert_eq!(run(&[t("hello"), t("@")]), Value::text("hello"));
    }

    #[test]
    fn text_general_format() {
        assert_eq!(run(&[n(42.0), t("General")]), Value::text("42"));
    }

    #[test]
    fn text_general_for_text_value() {
        assert_eq!(run(&[t("hi"), t("General")]), Value::text("hi"));
    }

    // ===== Locale awareness (V1: en-US only) =====

    #[test]
    fn text_with_excel1904_date_system() {
        // 1904 serial 0 = 1904-01-01.
        let ctx_1904 = EvalContext {
            date_system: ql_types::DateSystem::Excel1904,
            ..EvalContext::default()
        };
        assert_eq!(
            text_ctx(&[n(0.0), t("yyyy-mm-dd")], &ctx_1904),
            Value::text("1904-01-01")
        );
    }
}
