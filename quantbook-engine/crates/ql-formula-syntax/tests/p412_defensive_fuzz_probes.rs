#![allow(
    clippy::manual_str_repeat,
    clippy::manual_repeat_n,
    clippy::approx_constant,
    unused_imports,
    dead_code
)]
//! Phase 4.12 defensive-fuzz probes — parser stack/recursion/length/unicode.
//!
//! Marked `#[ignore]` — invoked by hand via `cargo test ... -- --ignored
//! --nocapture --test-threads=1`. Not part of the standard test gate.
//!
//! Each probe records what happens when the parser is fed pathological
//! input. Outcomes recorded: `Ok` (clean parse), `Err(ParseError)` (typed),
//! `Err(LexError)` (typed lex error), or PANIC / OOM / hang.
//!
//! Each test runs the relevant input in a fresh thread with a moderate
//! stack and catches `panic::catch_unwind` so a stack-overflow doesn't
//! kill the test binary.

use std::panic;

use ql_formula_syntax::{lex, parse};

fn try_parse(input: &str) -> Result<Result<ql_formula_syntax::Expr, String>, String> {
    let result = panic::catch_unwind(|| {
        let tokens = match lex(input) {
            Ok(t) => t,
            Err(e) => return Err(format!("LexError: {e}")),
        };
        parse(tokens).map_err(|e| format!("ParseError: {e}"))
    });
    match result {
        Ok(r) => Ok(r),
        Err(panic_payload) => {
            let msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                (*s).to_owned()
            } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_owned()
            };
            Err(format!("PANIC: {msg}"))
        }
    }
}

// ─── 1. Deep nesting ───────────────────────────────────────────────────────

/// 200-deep balanced parens — should parse cleanly. Baseline.
#[test]
#[ignore]
fn deep_paren_200() {
    let mut s = String::new();
    for _ in 0..200 {
        s.push('(');
    }
    s.push('1');
    for _ in 0..200 {
        s.push(')');
    }
    let r = try_parse(&s);
    eprintln!("deep_paren_200: {r:?}");
    assert!(matches!(r, Ok(Ok(_))), "expected clean parse");
}

/// 1000-deep balanced parens.
#[test]
#[ignore]
fn deep_paren_1000() {
    let mut s = String::new();
    for _ in 0..1000 {
        s.push('(');
    }
    s.push('1');
    for _ in 0..1000 {
        s.push(')');
    }
    let r = try_parse(&s);
    eprintln!("deep_paren_1000: {r:?}");
}

/// 5000-deep balanced parens — well below typical stack but enough to
/// probe whether the parser has any depth ceiling.
#[test]
#[ignore]
fn deep_paren_5000() {
    let mut s = String::new();
    for _ in 0..5000 {
        s.push('(');
    }
    s.push('1');
    for _ in 0..5000 {
        s.push(')');
    }
    let r = try_parse(&s);
    eprintln!("deep_paren_5000: {r:?}");
}

/// 20_000-deep balanced parens — expected to overflow stack with
/// recursive-descent and no depth limit.
#[test]
#[ignore]
fn deep_paren_20000() {
    // Spawn with a generous stack so a panic-on-overflow is observable
    // rather than aborting the test binary outright.
    let handle = std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024) // 64 MB
        .spawn(|| {
            let mut s = String::new();
            for _ in 0..20_000 {
                s.push('(');
            }
            s.push('1');
            for _ in 0..20_000 {
                s.push(')');
            }
            try_parse(&s)
        })
        .unwrap();
    let result = handle.join();
    eprintln!(
        "deep_paren_20000 join: {:?}",
        result.as_ref().map(|r| match r {
            Ok(Ok(_)) => "OK",
            Ok(Err(s)) => s.as_str(),
            Err(s) => s.as_str(),
        })
    );
    // We don't assert — the goal is to RECORD the outcome.
}

/// Deeply nested function calls — `SUM(SUM(SUM(...SUM(1))))` 1000 levels.
#[test]
#[ignore]
fn deep_function_call_1000() {
    let mut s = String::new();
    for _ in 0..1000 {
        s.push_str("SUM(");
    }
    s.push('1');
    for _ in 0..1000 {
        s.push(')');
    }
    let r = try_parse(&s);
    eprintln!("deep_function_call_1000: {r:?}");
}

/// Deeply nested unary minuses — `-----...1` 5000 deep.
#[test]
#[ignore]
fn deep_unary_minus_5000() {
    let mut s = String::new();
    for _ in 0..5000 {
        s.push('-');
    }
    s.push('1');
    let r = try_parse(&s);
    eprintln!("deep_unary_minus_5000: {r:?}");
}

/// Deeply right-associative power chain `2^2^2^...^2` (1000 ops). The
/// power operator is right-assoc, so it produces a left-rotated recursion.
#[test]
#[ignore]
fn deep_power_chain_1000() {
    let mut s = String::from("2");
    for _ in 0..1000 {
        s.push_str("^2");
    }
    let r = try_parse(&s);
    eprintln!("deep_power_chain_1000: {r:?}");
}

// ─── 2. Long inputs ────────────────────────────────────────────────────────

/// `=1+1+1+...+1` 10000 times.
#[test]
#[ignore]
fn long_addition_10000_terms() {
    let mut s = String::from("1");
    for _ in 0..10_000 {
        s.push_str("+1");
    }
    let r = try_parse(&s);
    eprintln!(
        "long_addition_10000_terms: {:?}",
        r.as_ref().map(|x| x.is_ok())
    );
}

/// `=A1+A1+A1+...+A1` 10000 times.
#[test]
#[ignore]
fn long_a1_addition_10000_terms() {
    let mut s = String::from("A1");
    for _ in 0..10_000 {
        s.push_str("+A1");
    }
    let r = try_parse(&s);
    eprintln!(
        "long_a1_addition_10000_terms: {:?}",
        r.as_ref().map(|x| x.is_ok())
    );
}

/// Large function call with 10000 args.
#[test]
#[ignore]
fn long_function_call_10000_args() {
    let mut s = String::from("SUM(1");
    for _ in 0..10_000 {
        s.push_str(",1");
    }
    s.push(')');
    let r = try_parse(&s);
    eprintln!(
        "long_function_call_10000_args: {:?}",
        r.as_ref().map(|x| x.is_ok())
    );
}

/// 100 KB of single-character identifier — should bail on first non-A1.
#[test]
#[ignore]
fn long_garbage_100kb() {
    let s: String = std::iter::repeat('x').take(100_000).collect();
    let r = try_parse(&s);
    eprintln!("long_garbage_100kb: {r:?}");
}

/// 100 KB string literal — should lex cleanly to one Token::String.
#[test]
#[ignore]
fn long_string_literal_100kb() {
    let mut s = String::from("\"");
    for _ in 0..100_000 {
        s.push('x');
    }
    s.push('"');
    let r = try_parse(&s);
    eprintln!(
        "long_string_literal_100kb: {:?}",
        r.as_ref().map(|x| x.is_ok())
    );
}

// ─── 3. Malformed inputs ───────────────────────────────────────────────────

#[test]
#[ignore]
fn malformed_missing_close_paren() {
    let r = try_parse("(1+2");
    eprintln!("malformed_missing_close_paren: {r:?}");
    assert!(matches!(r, Ok(Err(_))));
}

#[test]
#[ignore]
fn malformed_missing_open_paren() {
    let r = try_parse("1+2)");
    eprintln!("malformed_missing_open_paren: {r:?}");
    assert!(matches!(r, Ok(Err(_))));
}

#[test]
#[ignore]
fn malformed_unmatched_quote() {
    let r = try_parse("\"hello");
    eprintln!("malformed_unmatched_quote: {r:?}");
    assert!(matches!(r, Ok(Err(_))));
}

#[test]
#[ignore]
fn malformed_lone_equals() {
    let r = try_parse("");
    eprintln!("malformed_lone_equals_empty: {r:?}");
    let r = try_parse("=");
    eprintln!("malformed_lone_equals_eq: {r:?}");
}

#[test]
#[ignore]
fn malformed_dangling_operator() {
    for input in ["1+", "+", "*1", "1**", "1+*2", "1<>", "1 & ", "1:"] {
        let r = try_parse(input);
        eprintln!("malformed_dangling_operator {input:?}: {r:?}");
        assert!(matches!(r, Ok(Err(_))), "expected error on {input:?}");
    }
}

#[test]
#[ignore]
fn malformed_double_operator() {
    for input in ["1++2", "1**2", "1//2", "1==2"] {
        let r = try_parse(input);
        eprintln!("malformed_double_operator {input:?}: {r:?}");
    }
}

#[test]
#[ignore]
fn malformed_bad_cell_ref() {
    for input in [
        "A0",       // row 0 — Excel rows are 1-indexed
        "A1048577", // row too large
        "ZZZZ1",    // column too large
        "AA",       // bare column followed by nothing
        "1A",       // digit-then-letter
        "$",        // bare absolute marker
        "$$A1",     // doubled absolute marker
        "A$$1",
        "Sheet1!",          // dangling sheet
        "Sheet1!Sheet2!A1", // double sheet
    ] {
        let r = try_parse(input);
        eprintln!("malformed_bad_cell_ref {input:?}: {r:?}");
    }
}

#[test]
#[ignore]
fn malformed_nested_range() {
    let r = try_parse("A1:B2:C3");
    eprintln!("malformed_nested_range: {r:?}");
    assert!(matches!(r, Ok(Err(_))));
}

// ─── 4. Unicode / control chars ────────────────────────────────────────────

#[test]
#[ignore]
fn unicode_emoji_in_string() {
    let r = try_parse("\"hello 🌍 world\"");
    eprintln!("unicode_emoji_in_string: {r:?}");
    assert!(matches!(r, Ok(Ok(_))));
}

#[test]
#[ignore]
fn unicode_emoji_in_ident() {
    let r = try_parse("FOO🌍BAR()");
    eprintln!("unicode_emoji_in_ident: {r:?}");
}

#[test]
#[ignore]
fn unicode_rtl_in_string() {
    // Hebrew + Arabic + RTL marks.
    let r = try_parse("\"مرحبا עברית\"");
    eprintln!("unicode_rtl_in_string: {r:?}");
}

#[test]
#[ignore]
fn unicode_nul_in_string() {
    // Embedded NUL byte inside a string literal — does it survive?
    let r = try_parse("\"foo\0bar\"");
    eprintln!("unicode_nul_in_string: {r:?}");
}

#[test]
#[ignore]
fn unicode_control_chars_in_string() {
    // BEL (0x07), BS (0x08), VT (0x0B), FF (0x0C).
    for c in ['\x07', '\x08', '\x0B', '\x0C', '\x1B'] {
        let s = format!("\"x{c}y\"");
        let r = try_parse(&s);
        eprintln!("unicode_control_chars {:#x}: {:?}", c as u32, r);
    }
}

#[test]
#[ignore]
fn unicode_combining_diacritics() {
    // Combining characters in identifiers.
    let r = try_parse("foo\u{0301}bar()");
    eprintln!("unicode_combining_diacritics: {r:?}");
}

#[test]
#[ignore]
fn unicode_nbsp_in_formula() {
    // Per parser comments, NBSP is NOT whitespace per Excel canon. Test
    // that it fails predictably (lex error or parse error) rather than
    // panicking.
    let r = try_parse("1\u{00A0}+\u{00A0}2");
    eprintln!("unicode_nbsp_in_formula: {r:?}");
}

#[test]
#[ignore]
fn unicode_bom_prefix() {
    // BOM prefix — \u{FEFF}. Excel formula bodies don't expect a BOM.
    let r = try_parse("\u{FEFF}1+1");
    eprintln!("unicode_bom_prefix: {r:?}");
}

#[test]
#[ignore]
fn unicode_zero_width_joiner() {
    let r = try_parse("FOO\u{200D}BAR()");
    eprintln!("unicode_zero_width_joiner: {r:?}");
}

#[test]
#[ignore]
fn unicode_high_codepoint_string() {
    // U+10FFFF — max valid codepoint.
    let s = format!("\"a{}b\"", '\u{10FFFF}');
    let r = try_parse(&s);
    eprintln!("unicode_high_codepoint_string: {r:?}");
}

// ─── 5. Pathological array literals ────────────────────────────────────────

#[test]
#[ignore]
fn array_literal_huge_row_arity_10000() {
    let mut s = String::from("{1");
    for _ in 0..10_000 {
        s.push_str(",1");
    }
    s.push('}');
    let r = try_parse(&s);
    eprintln!(
        "array_literal_huge_row_arity_10000: {:?}",
        r.as_ref().map(|x| x.is_ok())
    );
}

#[test]
#[ignore]
fn array_literal_huge_rows_10000() {
    let mut s = String::from("{1");
    for _ in 0..10_000 {
        s.push_str(";1");
    }
    s.push('}');
    let r = try_parse(&s);
    eprintln!(
        "array_literal_huge_rows_10000: {:?}",
        r.as_ref().map(|x| x.is_ok())
    );
}

// ─── 6. Structured-ref bracket pathology ───────────────────────────────────

#[test]
#[ignore]
fn sref_nested_brackets_deep() {
    let mut s = String::from("T");
    for _ in 0..2000 {
        s.push('[');
    }
    s.push('x');
    for _ in 0..2000 {
        s.push(']');
    }
    let r = try_parse(&s);
    eprintln!("sref_nested_brackets_deep: {r:?}");
}

// ─── 7. Number-literal pathology ───────────────────────────────────────────

#[test]
#[ignore]
fn number_giant_digits() {
    // 5000 digits — f64 parse will saturate to Inf or 0 but should not panic.
    let s: String = std::iter::repeat('9').take(5000).collect();
    let r = try_parse(&s);
    eprintln!("number_giant_digits: {r:?}");
}

#[test]
#[ignore]
fn number_scientific_overflow() {
    let r = try_parse("1e1000");
    eprintln!("number_scientific_overflow: {r:?}");
}

#[test]
#[ignore]
fn number_scientific_underflow() {
    let r = try_parse("1e-1000");
    eprintln!("number_scientific_underflow: {r:?}");
}

#[test]
#[ignore]
fn number_many_decimals() {
    let mut s = String::from("0.");
    for _ in 0..5000 {
        s.push('1');
    }
    let r = try_parse(&s);
    eprintln!("number_many_decimals: {r:?}");
}
