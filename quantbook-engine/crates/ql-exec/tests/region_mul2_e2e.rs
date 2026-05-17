//! End-to-end pipeline test: source string → lex → parse → bind → eval → result.
//!
//! Closes CORR-20's Day 7 deliverable: prove that a user-typed formula like `=A1*2`
//! produces the correct numeric value when evaluated through the full Quantbook
//! engine pipeline. Phase 0 Day 7 was deferred because the Pratt parser hadn't
//! shipped; with W5-1 + W5-2 done, this integration test closes the loop.
//!
//! Two paths covered:
//!
//! 1. **Scalar per-cell path**: `=A1*2` for a single owning cell, evaluated through
//!    `eval_scalar` with a `WorkbookEnv` backing the cell reads. Verifies the
//!    end-to-end semantic correctness for formula-bar use cases.
//!
//! 2. **SIMD bulk path**: `=A*2` parsed, classified via `lower::classify` into a
//!    `MulScalar` shape, dispatched over a 1000-element f64 chunk via
//!    `lower::dispatch`. Verifies the OG-02 hot path is reachable from source text.

use ql_calcgraph::RangeRef;
use ql_exec::{
    bind, classify, dispatch, eval_scalar, eval_scalar_with_registry, MapEnv, SimdShape,
};
use ql_formula_syntax::{lex, parse, SheetRef};
use ql_functions::default_registry;
use ql_types::{ErrorValue, Value};

/// Run a single source formula through the scalar pipeline against a MapEnv with the
/// given pre-populated cells, evaluated as if it lives on sheet 0. Returns the
/// resulting `Value`.
fn eval_source_scalar(src: &str, cells: &[((u16, u32, u32), Value)]) -> Value {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
    let plan = bind(&ast, 0).expect("bind");
    let mut env = MapEnv::new();
    for ((s, r, c), v) in cells {
        env.put(*s, *r, *c, v.clone());
    }
    eval_scalar(&plan, &env)
}

fn eval_source_with_registry(src: &str, cells: &[((u16, u32, u32), Value)]) -> Value {
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
    let plan = bind(&ast, 0).expect("bind");
    let mut env = MapEnv::new();
    for ((s, r, c), v) in cells {
        env.put(*s, *r, *c, v.clone());
    }
    let registry = default_registry();
    eval_scalar_with_registry(&plan, &env, &registry)
}

// ===== scalar E2E =====

#[test]
fn e2e_a1_times_two() {
    // =A1*2 with A1=21 → 42.
    let result = eval_source_scalar("A1 * 2", &[((0, 0, 0), Value::Number(21.0))]);
    assert_eq!(result, Value::Number(42.0));
}

#[test]
fn e2e_simple_addition() {
    // =A1+B1 with A1=10, B1=32 → 42.
    let result = eval_source_scalar(
        "A1 + B1",
        &[
            ((0, 0, 0), Value::Number(10.0)),
            ((0, 0, 1), Value::Number(32.0)),
        ],
    );
    assert_eq!(result, Value::Number(42.0));
}

#[test]
fn e2e_nested_arithmetic() {
    // =(A1 + B1) * 2 with A1=3, B1=4 → 14.
    let result = eval_source_scalar(
        "(A1 + B1) * 2",
        &[
            ((0, 0, 0), Value::Number(3.0)),
            ((0, 0, 1), Value::Number(4.0)),
        ],
    );
    assert_eq!(result, Value::Number(14.0));
}

#[test]
fn e2e_div_by_zero_yields_div_zero_error() {
    use ql_types::ErrorValue;
    let result = eval_source_scalar("A1 / 0", &[((0, 0, 0), Value::Number(10.0))]);
    assert_eq!(result, Value::Error(ErrorValue::DivZero));
}

#[test]
fn e2e_string_literal_and_concat() {
    // ="Hello, " & "world"
    let result = eval_source_scalar(r#""Hello, " & "world""#, &[]);
    assert_eq!(result, Value::text("Hello, world"));
}

#[test]
fn e2e_comparison_returns_bool() {
    // =A1 > 5 with A1=10 → TRUE
    let result = eval_source_scalar("A1 > 5", &[((0, 0, 0), Value::Number(10.0))]);
    assert_eq!(result, Value::Boolean(true));
}

#[test]
fn e2e_unary_minus() {
    // =-A1 with A1=7 → -7
    let result = eval_source_scalar("-A1", &[((0, 0, 0), Value::Number(7.0))]);
    assert_eq!(result, Value::Number(-7.0));
}

#[test]
fn e2e_postfix_percent() {
    // =(A1 + 1)% with A1=49 → 0.50
    let result = eval_source_scalar("(A1 + 1)%", &[((0, 0, 0), Value::Number(49.0))]);
    assert_eq!(result, Value::Number(0.5));
}

// ===== function dispatch via registry =====

#[test]
fn e2e_sum_function() {
    // =SUM(A1, A2, A3) with values 10, 20, 30 → 60
    let result = eval_source_with_registry(
        "SUM(A1, A2, A3)",
        &[
            ((0, 0, 0), Value::Number(10.0)),
            ((0, 1, 0), Value::Number(20.0)),
            ((0, 2, 0), Value::Number(30.0)),
        ],
    );
    assert_eq!(result, Value::Number(60.0));
}

#[test]
fn e2e_if_function() {
    // =IF(A1 > 0, "positive", "non-positive") with A1=5 → "positive"
    let result = eval_source_with_registry(
        r#"IF(A1 > 0, "positive", "non-positive")"#,
        &[((0, 0, 0), Value::Number(5.0))],
    );
    assert_eq!(result, Value::text("positive"));
}

#[test]
fn e2e_iferror_with_safe_value() {
    // =IFERROR(A1 / B1, 0) with A1=10, B1=0 → 0 (DivZero caught)
    let result = eval_source_with_registry(
        "IFERROR(A1 / B1, 0)",
        &[
            ((0, 0, 0), Value::Number(10.0)),
            ((0, 0, 1), Value::Number(0.0)),
        ],
    );
    assert_eq!(result, Value::Number(0.0));
}

// ===== W5-163 (Phase 4.10.A) — Logical fillins e2e =====

#[test]
fn e2e_ifs_first_match() {
    // =IFS(A1 < 0, "neg", A1 = 0, "zero", A1 > 0, "pos") with A1=5 → "pos"
    let result = eval_source_with_registry(
        r#"IFS(A1 < 0, "neg", A1 = 0, "zero", A1 > 0, "pos")"#,
        &[((0, 0, 0), Value::Number(5.0))],
    );
    assert_eq!(result, Value::text("pos"));
}

#[test]
fn e2e_ifna_passes_value_through() {
    // =IFNA(A1, "fallback") with A1=42 → 42 (non-#N/A passes through).
    // The unit tests in scalar_fns cover the #N/A → fallback branch;
    // this e2e proves the registry dispatch path works for IFNA.
    let result = eval_source_with_registry(
        r#"IFNA(A1, "fallback")"#,
        &[((0, 0, 0), Value::Number(42.0))],
    );
    assert_eq!(result, Value::Number(42.0));
}

#[test]
fn e2e_xor_parity() {
    // =XOR(A1 > 0, A2 > 0, A3 > 0) with A1=5, A2=-1, A3=10 → XOR(true,false,true) = false (even)
    let result = eval_source_with_registry(
        "XOR(A1 > 0, A2 > 0, A3 > 0)",
        &[
            ((0, 0, 0), Value::Number(5.0)),
            ((0, 1, 0), Value::Number(-1.0)),
            ((0, 2, 0), Value::Number(10.0)),
        ],
    );
    assert_eq!(result, Value::Boolean(false));
}

#[test]
fn e2e_switch_with_default() {
    // =SWITCH(A1, 1, "one", 2, "two", "other") with A1=3 → "other"
    let result = eval_source_with_registry(
        r#"SWITCH(A1, 1, "one", 2, "two", "other")"#,
        &[((0, 0, 0), Value::Number(3.0))],
    );
    assert_eq!(result, Value::text("other"));
}

#[test]
fn e2e_switch_type_strict_no_match() {
    // =SWITCH(A1, "1", "string match", 1, "number match") with A1=1 (number)
    // → "number match" (Number↔String never matches per Codex HIGH-1 closure).
    let result = eval_source_with_registry(
        r#"SWITCH(A1, "1", "string match", 1, "number match")"#,
        &[((0, 0, 0), Value::Number(1.0))],
    );
    assert_eq!(result, Value::text("number match"));
}

// ===== W5-164 (Phase 4.10.B) — Conditional-aggregate fillins e2e =====
//
// These functions take Range args which need named-range or table-ref
// bindings to work through the lightweight `bind(&ast, 0)` test
// helper. The unit tests in range_fns::tests cover the function
// contracts directly; this e2e proves they're discoverable via the
// registry (smoke test only).

#[test]
fn e2e_minifs_maxifs_countblank_registered() {
    use ql_functions::default_registry;
    let registry = default_registry();
    assert!(
        registry.lookup_range_aware("MINIFS").is_some(),
        "MINIFS registered"
    );
    assert!(
        registry.lookup_range_aware("MAXIFS").is_some(),
        "MAXIFS registered"
    );
    assert!(
        registry.lookup_range_aware("COUNTBLANK").is_some(),
        "COUNTBLANK registered"
    );
}

// ===== W5-165 (Phase 4.10.C) — *A variants + info scalars e2e =====

#[test]
fn e2e_averagea_text_counts_as_zero() {
    // =AVERAGEA(A1, A2, A3) with A1=10, A2="hi", A3=20 → (10+0+20)/3 ≈ 10.
    let result = eval_source_with_registry(
        "AVERAGEA(A1, A2, A3)",
        &[
            ((0, 0, 0), Value::Number(10.0)),
            ((0, 1, 0), Value::text("hi")),
            ((0, 2, 0), Value::Number(20.0)),
        ],
    );
    assert_eq!(result, Value::Number(10.0));
}

#[test]
fn e2e_maxa_diverges_from_max_on_text() {
    // =MAXA(A1, A2) with A1=-5, A2="hi" → max(-5, 0) = 0.
    // MAX would skip "hi" and return -5; MAXA counts "hi" as 0.
    let result = eval_source_with_registry(
        "MAXA(A1, A2)",
        &[
            ((0, 0, 0), Value::Number(-5.0)),
            ((0, 1, 0), Value::text("hi")),
        ],
    );
    assert_eq!(result, Value::Number(0.0));
}

#[test]
fn e2e_na_returns_na_sigil() {
    // =NA() → #N/A
    let result = eval_source_with_registry("NA()", &[]);
    assert_eq!(result, Value::Error(ErrorValue::NA));
}

#[test]
fn e2e_error_type_dispatches_on_dotted_name() {
    // =ERROR.TYPE(A1) where A1 holds a #REF! error → 4.
    let result = eval_source_with_registry(
        "ERROR.TYPE(A1)",
        &[((0, 0, 0), Value::Error(ErrorValue::Ref))],
    );
    assert_eq!(result, Value::Number(4.0));
}

#[test]
fn e2e_iseven_isodd_basic() {
    let result_even = eval_source_with_registry("ISEVEN(A1)", &[((0, 0, 0), Value::Number(4.0))]);
    assert_eq!(result_even, Value::Boolean(true));
    let result_odd = eval_source_with_registry("ISODD(A1)", &[((0, 0, 0), Value::Number(5.0))]);
    assert_eq!(result_odd, Value::Boolean(true));
}

#[test]
fn e2e_n_value_text_coerces_to_zero() {
    // =N(A1) with A1="hello" → 0 (Excel canon — NOT #VALUE!).
    let result = eval_source_with_registry("N(A1)", &[((0, 0, 0), Value::text("hello"))]);
    assert_eq!(result, Value::Number(0.0));
}

// ===== W5-166 (Phase 4.10.D) — combinatorics + sum-of-squares e2e =====

#[test]
fn e2e_fact_basic() {
    // =FACT(5) → 120.
    let result = eval_source_with_registry("FACT(5)", &[]);
    assert_eq!(result, Value::Number(120.0));
}

#[test]
fn e2e_factdouble_basic() {
    // =FACTDOUBLE(7) → 7*5*3*1 = 105.
    let result = eval_source_with_registry("FACTDOUBLE(7)", &[]);
    assert_eq!(result, Value::Number(105.0));
}

#[test]
fn e2e_combin_combina() {
    // =COMBIN(10, 3) → 120.
    let result = eval_source_with_registry("COMBIN(10, 3)", &[]);
    assert_eq!(result, Value::Number(120.0));
    // =COMBINA(5, 2) → C(6, 2) = 15.
    let result = eval_source_with_registry("COMBINA(5, 2)", &[]);
    assert_eq!(result, Value::Number(15.0));
}

#[test]
fn e2e_permut_permutationa() {
    // =PERMUT(5, 2) → 20.
    let result = eval_source_with_registry("PERMUT(5, 2)", &[]);
    assert_eq!(result, Value::Number(20.0));
    // =PERMUTATIONA(3, 2) → 9.
    let result = eval_source_with_registry("PERMUTATIONA(3, 2)", &[]);
    assert_eq!(result, Value::Number(9.0));
}

#[test]
fn e2e_sumsq_basic() {
    // =SUMSQ(A1, A2, A3) with A1=1, A2=2, A3=3 → 1+4+9 = 14.
    let result = eval_source_with_registry(
        "SUMSQ(A1, A2, A3)",
        &[
            ((0, 0, 0), Value::Number(1.0)),
            ((0, 1, 0), Value::Number(2.0)),
            ((0, 2, 0), Value::Number(3.0)),
        ],
    );
    assert_eq!(result, Value::Number(14.0));
}

#[test]
fn e2e_paired_sum_variants_registered() {
    // Range-aware paired-sum variants take Range args which need
    // named-range bindings; unit tests in range_fns cover the
    // contracts. This is a registry-dispatch smoke check.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("SUMX2MY2").is_some());
    assert!(registry.lookup_range_aware("SUMX2PY2").is_some());
    assert!(registry.lookup_range_aware("SUMXMY2").is_some());
}

// ===== W5-168 (Phase 4.10.F) — financial e2e =====

#[test]
fn e2e_pmt_zero_rate() {
    // =PMT(0, 10, 100) → -(100 + 0) / 10 = -10.
    let result = eval_source_with_registry("PMT(0, 10, 100)", &[]);
    assert_eq!(result, Value::Number(-10.0));
}

#[test]
fn e2e_pv_zero_rate() {
    // =PV(0, 10, -50) → -fv - pmt*nper = -0 - (-50)*10 = 500.
    let result = eval_source_with_registry("PV(0, 10, -50)", &[]);
    assert_eq!(result, Value::Number(500.0));
}

#[test]
fn e2e_npv_irr_registered() {
    // NPV / IRR take Range args; unit tests cover the contracts.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("NPV").is_some());
    assert!(registry.lookup_range_aware("IRR").is_some());
}

// ===== W5-170 (Wave 2 closing megaudit MEDIUM-1) — fill e2e dispatch
// gap for batches 4.10.E and 4.10.G. Unit tests covered the function
// contracts; these prove the registry dispatch path works through the
// lex/parse/bind/eval pipeline. =====

#[test]
fn e2e_char_code_basic() {
    // =CHAR(65) → "A".
    let result = eval_source_with_registry("CHAR(65)", &[]);
    assert_eq!(result, Value::text("A"));
    // =CODE("Z") → 90.
    let result = eval_source_with_registry(r#"CODE("Z")"#, &[]);
    assert_eq!(result, Value::Number(90.0));
}

#[test]
fn e2e_unicode_unichar_basic() {
    // =UNICODE("é") → 233.
    let result = eval_source_with_registry(r#"UNICODE("é")"#, &[]);
    assert_eq!(result, Value::Number(233.0));
    // =UNICHAR(233) → "é".
    let result = eval_source_with_registry("UNICHAR(233)", &[]);
    assert_eq!(result, Value::text("é"));
}

#[test]
fn e2e_value_basic_enus() {
    // =VALUE("2.71") → 2.71 (default locale EnUs; non-PI-adjacent value
    // to keep clippy::approx_constant happy).
    let result = eval_source_with_registry(r#"VALUE("2.71")"#, &[]);
    assert_eq!(result, Value::Number(2.71));
}

#[test]
fn e2e_fixed_default_format() {
    // =FIXED(1234.567) → "1,234.57" (default decimals=2, EnUs locale).
    let result = eval_source_with_registry("FIXED(1234.567)", &[]);
    assert_eq!(result, Value::text("1,234.57"));
}

#[test]
fn e2e_dollar_negative() {
    // W5-175: EnUs now uses accounting parens for negatives.
    // =DOLLAR(-1234.5) → "($1,234.50)".
    let result = eval_source_with_registry("DOLLAR(-1234.5)", &[]);
    assert_eq!(result, Value::text("($1,234.50)"));
}

#[test]
fn e2e_textjoin_registered() {
    // TEXTJOIN is RangeAwareFn; smoke-check via registry lookup.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("TEXTJOIN").is_some());
}

#[test]
fn e2e_vdb_depreciation() {
    // W5-183: VDB is ScalarFn; evaluable through `bind(&ast, 0)`.
    // Microsoft docs first-year example: VDB(2400, 300, 10, 0, 1) = 480.
    let result = eval_source_with_registry("VDB(2400, 300, 10, 0, 1)", &[]);
    assert_eq!(result, Value::Number(480.0));
    // Microsoft factor=1.5 partial-year example:
    // VDB(2400, 300, 10, 0, 0.875, 1.5) = 315.00.
    let result = eval_source_with_registry("VDB(2400, 300, 10, 0, 0.875, 1.5)", &[]);
    match result {
        Value::Number(got) => {
            assert!((got - 315.0).abs() < 0.01, "expected ≈ 315, got {got}")
        }
        other => panic!("expected Number, got {other:?}"),
    }
}

#[test]
fn e2e_db_depreciation() {
    // W5-182: DB is ScalarFn; evaluable through `bind(&ast, 0)`.
    // Microsoft docs first-period example: rate=0.319; result =
    // 1_000_000 * 0.319 * 7/12 = 186083.333...
    let expected = 1_000_000.0
        * (((1.0 - (100_000.0_f64 / 1_000_000.0).powf(1.0 / 6.0)) * 1000.0).round() / 1000.0)
        * 7.0
        / 12.0;
    let result = eval_source_with_registry("DB(1000000, 100000, 6, 1, 7)", &[]);
    match result {
        Value::Number(got) => assert!(
            (got - expected).abs() < 1e-6,
            "expected ≈ {expected}, got {got}"
        ),
        other => panic!("expected Number, got {other:?}"),
    }
}

#[test]
fn e2e_ddb_depreciation() {
    // W5-181: DDB is ScalarFn; evaluable through `bind(&ast, 0)`.
    // Microsoft docs example: DDB(2400, 300, 10, 1) = 480.
    let result = eval_source_with_registry("DDB(2400, 300, 10, 1)", &[]);
    assert_eq!(result, Value::Number(480.0));
    // With explicit factor=1 (single-declining): DDB(1000, 0, 10, 1, 1) = 100.
    let result = eval_source_with_registry("DDB(1000, 0, 10, 1, 1)", &[]);
    assert_eq!(result, Value::Number(100.0));
}

#[test]
fn e2e_sln_syd_depreciation() {
    // W5-180: SLN + SYD are ScalarFns; we can evaluate them directly
    // through the lightweight `bind(&ast, 0)` test helper (no range
    // construction needed).
    // SLN(30000, 7500, 10) = 2250 (Microsoft docs example).
    let result = eval_source_with_registry("SLN(30000, 7500, 10)", &[]);
    assert_eq!(result, Value::Number(2250.0));
    // SYD(30000, 7500, 10, 1) ≈ 4090.909... (first-year depreciation).
    let result = eval_source_with_registry("SYD(30000, 7500, 10, 1)", &[]);
    let expected = 22500.0 * 10.0 * 2.0 / (10.0 * 11.0);
    match result {
        Value::Number(got) => assert!(
            (got - expected).abs() < 1e-9,
            "expected ≈ {expected}, got {got}"
        ),
        other => panic!("expected Number, got {other:?}"),
    }
}

#[test]
fn e2e_pearson_rsq_steyx_registered() {
    // W5-179: PEARSON + RSQ + STEYX are RangeAwareFns; registry-lookup
    // smoke check per the W5-176 / W5-177 / W5-178 pattern.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("PEARSON").is_some());
    assert!(registry.lookup_range_aware("pearson").is_some());
    assert!(registry.lookup_range_aware("RSQ").is_some());
    assert!(registry.lookup_range_aware("rsq").is_some());
    assert!(registry.lookup_range_aware("STEYX").is_some());
    assert!(registry.lookup_range_aware("steyx").is_some());
}

#[test]
fn e2e_slope_intercept_registered() {
    // W5-178: SLOPE + INTERCEPT are RangeAwareFns; registry-lookup
    // smoke check per the W5-176 / W5-177 pattern (range-arg
    // construction not reachable via `bind(&ast, 0)` without
    // named-range scaffolding).
    let registry = default_registry();
    assert!(registry.lookup_range_aware("SLOPE").is_some());
    assert!(registry.lookup_range_aware("slope").is_some());
    assert!(registry.lookup_range_aware("INTERCEPT").is_some());
    assert!(registry.lookup_range_aware("intercept").is_some());
}

#[test]
fn e2e_correl_registered() {
    // W5-177: CORREL is RangeAwareFn; range-arg construction can't go
    // through the lightweight `bind(&ast, 0)` test helper without
    // named-range / table-ref scaffolding. Smoke-check via registry
    // dispatch (same pattern as XLOOKUP / XMATCH / TEXTJOIN / MIRR).
    let registry = default_registry();
    assert!(registry.lookup_range_aware("CORREL").is_some());
    assert!(registry.lookup_range_aware("correl").is_some()); // case-insensitive
}

#[test]
fn e2e_erf_erfc_through_dispatcher() {
    // **W5-D-10 (Phase 4.10 — V1 260 closeout):** end-to-end dispatch
    // for ERF / ERF.PRECISE / ERFC / ERFC.PRECISE. All scalar.
    // ERF(0) = 0.
    assert_eq!(eval_source_with_registry("ERF(0)", &[]), Value::Number(0.0));
    // ERFC(0) = 1.
    assert_eq!(
        eval_source_with_registry("ERFC(0)", &[]),
        Value::Number(1.0)
    );
    // ERF + ERFC complement identity (verify both paths route).
    let erf_v = match eval_source_with_registry("ERF(1)", &[]) {
        Value::Number(n) => n,
        _ => panic!("ERF(1) failed"),
    };
    let erfc_v = match eval_source_with_registry("ERFC(1)", &[]) {
        Value::Number(n) => n,
        _ => panic!("ERFC(1) failed"),
    };
    assert!((erf_v + erfc_v - 1.0).abs() < 1e-12);
    // PRECISE aliases (dotted names work through the regular
    // letter-leading dotted-ident path). **W5-D-10.1 (Codex LOW +
    // Opus LOW-3 closure):** prior comment referenced the W5-D-2
    // digit-leading-segment lexer extension, but `.PRECISE` segments
    // are letter-only — the W5-D-2 extension is NOT exercised here.
    assert_eq!(
        eval_source_with_registry("ERF.PRECISE(0)", &[]),
        Value::Number(0.0)
    );
    assert_eq!(
        eval_source_with_registry("ERFC.PRECISE(0)", &[]),
        Value::Number(1.0)
    );
    // Case-insensitive.
    assert_eq!(eval_source_with_registry("erf(0)", &[]), Value::Number(0.0));
}

#[test]
fn e2e_base_conversion_through_dispatcher() {
    // **W5-D-9 (Phase 4.10 — V1 260 closeout):** end-to-end dispatch
    // tests for base-conversion family. All scalar; verify parser +
    // registry routing for both directions.
    // DEC2BIN(5) = "101".
    assert_eq!(
        eval_source_with_registry("DEC2BIN(5)", &[]),
        Value::text("101")
    );
    // DEC2OCT(8) = "10".
    assert_eq!(
        eval_source_with_registry("DEC2OCT(8)", &[]),
        Value::text("10")
    );
    // DEC2HEX(255) = "FF".
    assert_eq!(
        eval_source_with_registry("DEC2HEX(255)", &[]),
        Value::text("FF")
    );
    // BIN2DEC(101) = 5.
    assert_eq!(
        eval_source_with_registry("BIN2DEC(101)", &[]),
        Value::Number(5.0)
    );
    // OCT2DEC("10") = 8.
    assert_eq!(
        eval_source_with_registry(r#"OCT2DEC("10")"#, &[]),
        Value::Number(8.0)
    );
    // HEX2DEC("FF") = 255.
    assert_eq!(
        eval_source_with_registry(r#"HEX2DEC("FF")"#, &[]),
        Value::Number(255.0)
    );
    // Case-insensitive lookup.
    assert_eq!(
        eval_source_with_registry("dec2bin(5)", &[]),
        Value::text("101")
    );
}

#[test]
fn e2e_bit_ops_through_dispatcher() {
    // **W5-D-8 (Phase 4.10 — V1 260 closeout):** end-to-end dispatch
    // tests for BIT* engineering family. All scalar; verify the
    // formula parser + registry lookup route correctly.
    // BITAND(12, 10) = 8 (0b1100 & 0b1010).
    assert_eq!(
        eval_source_with_registry("BITAND(12, 10)", &[]),
        Value::Number(8.0)
    );
    // BITOR(12, 10) = 14.
    assert_eq!(
        eval_source_with_registry("BITOR(12, 10)", &[]),
        Value::Number(14.0)
    );
    // BITXOR(12, 10) = 6.
    assert_eq!(
        eval_source_with_registry("BITXOR(12, 10)", &[]),
        Value::Number(6.0)
    );
    // BITLSHIFT(1, 3) = 8.
    assert_eq!(
        eval_source_with_registry("BITLSHIFT(1, 3)", &[]),
        Value::Number(8.0)
    );
    // BITRSHIFT(8, 3) = 1.
    assert_eq!(
        eval_source_with_registry("BITRSHIFT(8, 3)", &[]),
        Value::Number(1.0)
    );
    // Case-insensitive lookup.
    assert_eq!(
        eval_source_with_registry("bitand(12, 10)", &[]),
        Value::Number(8.0)
    );
}

#[test]
fn e2e_xnpv_xirr_registered() {
    // **W5-D-7 (Wave 3 closure — CLOSES Wave 3):** smoke-check
    // registry dispatch for XNPV / XIRR. Same pattern as sibling
    // financial range-aware fns (NPV / IRR / MIRR). Verifies
    // case-insensitive lookup works for the new uppercase canonical
    // names.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("XNPV").is_some());
    assert!(registry.lookup_range_aware("xnpv").is_some());
    assert!(registry.lookup_range_aware("XIRR").is_some());
    assert!(registry.lookup_range_aware("xirr").is_some());
}

#[test]
fn e2e_covariance_p_s_registered() {
    // **W5-D-6.1 (Opus MEDIUM-O-1 closure):** smoke-check registry
    // dispatch for COVARIANCE.P / COVARIANCE.S. Same pattern as
    // sibling paired-array fns (CORREL / SLOPE / INTERCEPT /
    // PEARSON / RSQ / STEYX). **Novel code path**: COVARIANCE.P
    // and COVARIANCE.S are the first Wave-3 paired-array fns with
    // a literal dot in the canonical name — verifies the
    // case-insensitive lexer + registry lookup handle the dotted
    // form correctly through the same path as NORM.DIST / T.DIST / etc.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("COVARIANCE.P").is_some());
    assert!(registry.lookup_range_aware("covariance.p").is_some());
    assert!(registry.lookup_range_aware("Covariance.P").is_some());
    assert!(registry.lookup_range_aware("COVARIANCE.S").is_some());
    assert!(registry.lookup_range_aware("covariance.s").is_some());
    assert!(registry.lookup_range_aware("Covariance.S").is_some());
}

#[test]
fn e2e_percentile_quartile_registered() {
    // **W5-D-11 (Phase 4.10 — V1 260 closeout):** smoke-check registry
    // dispatch for the order-statistics family. All RangeAwareFn — same
    // registry-lookup pattern used by sibling paired-array fns (CORREL /
    // COVARIANCE.* / MIRR). Verifies:
    // 1. Case-insensitive lookup of all 6 registered names.
    // 2. Dotted-name routing for `.INC` / `.EXC` (regular letter-leading
    //    dotted-ident path; the same path COVARIANCE.P/.S uses).
    // 3. Legacy alias parity: PERCENTILE registers to the same fn as
    //    PERCENTILE.INC, and QUARTILE registers to QUARTILE.INC (Excel
    //    2010+ canon). **W5-D-11.1 (Codex LOW-001 closure):**
    //    strengthened from `.is_some()` to comparing fn-pointer
    //    addresses via `usize`-cast equality so a future regression
    //    that re-points PERCENTILE/QUARTILE to the `.EXC` variants
    //    would fail the test rather than passing the presence check.
    let registry = default_registry();
    // .INC / .EXC variants.
    let p_inc = registry.lookup_range_aware("PERCENTILE.INC");
    let p_exc = registry.lookup_range_aware("PERCENTILE.EXC");
    let q_inc = registry.lookup_range_aware("QUARTILE.INC");
    let q_exc = registry.lookup_range_aware("QUARTILE.EXC");
    let p_alias = registry.lookup_range_aware("PERCENTILE");
    let q_alias = registry.lookup_range_aware("QUARTILE");
    assert!(p_inc.is_some());
    assert!(p_exc.is_some());
    assert!(q_inc.is_some());
    assert!(q_exc.is_some());
    assert!(p_alias.is_some());
    assert!(q_alias.is_some());
    // Alias parity via fn-pointer address comparison. Casting an `fn`
    // pointer to `*const ()` then to `usize` exposes the address;
    // matching addresses prove the legacy alias and the `.INC` variant
    // route through the same code.
    let addr = |f: ql_functions::RangeAwareFn| f as *const () as usize;
    assert_eq!(
        addr(p_alias.unwrap()),
        addr(p_inc.unwrap()),
        "PERCENTILE alias must point to PERCENTILE.INC"
    );
    assert_eq!(
        addr(q_alias.unwrap()),
        addr(q_inc.unwrap()),
        "QUARTILE alias must point to QUARTILE.INC"
    );
    // Disjointness sanity: .INC and .EXC are different fns.
    assert_ne!(
        addr(p_inc.unwrap()),
        addr(p_exc.unwrap()),
        "PERCENTILE.INC and PERCENTILE.EXC must be distinct fns"
    );
    assert_ne!(
        addr(q_inc.unwrap()),
        addr(q_exc.unwrap()),
        "QUARTILE.INC and QUARTILE.EXC must be distinct fns"
    );
    // Case-insensitive on all 6.
    assert!(registry.lookup_range_aware("percentile.inc").is_some());
    assert!(registry.lookup_range_aware("Percentile.Exc").is_some());
    assert!(registry.lookup_range_aware("quartile.inc").is_some());
    assert!(registry.lookup_range_aware("Quartile.Exc").is_some());
    assert!(registry.lookup_range_aware("percentile").is_some());
    assert!(registry.lookup_range_aware("quartile").is_some());
}

#[test]
fn e2e_subtotal_registered() {
    // **W5-D-12 (Phase 4.10 — V1 260 sealer):** smoke-check registry
    // dispatch for SUBTOTAL. RangeAwareFn; same registry-lookup pattern
    // used by sibling conditional aggregates (SUMIF / COUNTIF / SUMIFS).
    // Verifies case-insensitive lookup + dotted-name-not-required path.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("SUBTOTAL").is_some());
    assert!(registry.lookup_range_aware("subtotal").is_some());
    assert!(registry.lookup_range_aware("SubTotal").is_some());
}

#[test]
fn e2e_subtotal_scalar_args_dispatch() {
    // **W5-D-12.1 (Codex HIGH-001 closure):** prove SUBTOTAL actually
    // routes through the binder + dispatcher with real formula source.
    // Scalar data args sidestep the v1 limitation that literal
    // `A1:A3` RangeRefs in AggregateArg context aren't yet supported
    // (a documented engine-wide v1 gap tracked at plan.rs:706-731, NOT
    // specific to SUBTOTAL). SUBTOTAL(9, 1, 2, 3) → SUM = 6.
    assert_eq!(
        eval_source_with_registry("SUBTOTAL(9, 1, 2, 3)", &[]),
        Value::Number(6.0)
    );
}

#[test]
fn e2e_subtotal_109_normalizes_to_sum() {
    // **W5-D-12.1 (Codex HIGH-001 closure):** verify the 101..=111
    // normalization path is reachable through the real binder +
    // dispatcher. SUBTOTAL(109, 10, 20, 30) ≡ SUM-style dispatch
    // (v1 has no hidden-row metadata) → 60.
    assert_eq!(
        eval_source_with_registry("SUBTOTAL(109, 10, 20, 30)", &[]),
        Value::Number(60.0)
    );
}

#[test]
fn e2e_subtotal_invalid_function_num_is_value_error() {
    // **W5-D-12.1 (Codex HIGH-001 closure):** invalid function_num →
    // #VALUE! through the real dispatcher path.
    use ql_types::ErrorValue;
    assert_eq!(
        eval_source_with_registry("SUBTOTAL(12, 1, 2, 3)", &[]),
        Value::Error(ErrorValue::Value)
    );
}

#[test]
fn e2e_mirr_registered() {
    // W5-174: MIRR is RangeAwareFn; range-arg construction can't go
    // through the lightweight `bind(&ast, 0)` test helper without
    // named-range / table-ref scaffolding, so we smoke-check via
    // registry dispatch (same pattern as XLOOKUP / XMATCH / TEXTJOIN).
    let registry = default_registry();
    assert!(registry.lookup_range_aware("MIRR").is_some());
    assert!(registry.lookup_range_aware("mirr").is_some()); // case-insensitive
}

#[test]
fn e2e_numbervalue_basic_enus() {
    // W5-173 dispatch-gap defense — three paths through numbervalue_ctx so a
    // registry typo (e.g. accidentally swapping with value_ctx) trips the test.
    // =NUMBERVALUE("1.5") → 1.5 (default EnUs separators).
    let result = eval_source_with_registry(r#"NUMBERVALUE("1.5")"#, &[]);
    assert_eq!(result, Value::Number(1.5));
    // =NUMBERVALUE("50%") → 0.5 (trailing % branch, NOT exercised by VALUE).
    let result = eval_source_with_registry(r#"NUMBERVALUE("50%")"#, &[]);
    assert_eq!(result, Value::Number(0.5));
    // =NUMBERVALUE("1,234.56", ".", ",") → 1234.56 (explicit separator args
    // — VALUE only takes 1 arg, so this confirms the right fn is dispatched).
    let result = eval_source_with_registry(r#"NUMBERVALUE("1,234.56", ".", ",")"#, &[]);
    assert_eq!(result, Value::Number(1234.56));
    // =NUMBERVALUE("") → 0 (canonical divergence from VALUE which is #VALUE!).
    let result = eval_source_with_registry(r#"NUMBERVALUE("")"#, &[]);
    assert_eq!(result, Value::Number(0.0));
}

#[test]
fn e2e_address_basic() {
    // =ADDRESS(1, 1) → "$A$1" (default abs_num=1, a1=TRUE).
    let result = eval_source_with_registry("ADDRESS(1, 1)", &[]);
    assert_eq!(result, Value::text("$A$1"));
    // =ADDRESS(5, 27, 4) → "AA5" (col 27 = AA, abs_num=4 = no $).
    let result = eval_source_with_registry("ADDRESS(5, 27, 4)", &[]);
    assert_eq!(result, Value::text("AA5"));
}

#[test]
fn e2e_xlookup_xmatch_registered() {
    // XLOOKUP / XMATCH are RangeAwareFn; smoke-check via registry.
    let registry = default_registry();
    assert!(registry.lookup_range_aware("XLOOKUP").is_some());
    assert!(registry.lookup_range_aware("XMATCH").is_some());
}

#[test]
fn e2e_var_s_via_alias() {
    // =VAR(A1, A2, A3) → sample variance of [1, 2, 3] = 1
    // (VAR is an alias for VAR.S in the registry. The dotted-name VAR.S is not yet
    // supported by the lexer; the VAR alias is the Phase 1 source-form workaround.)
    let result = eval_source_with_registry(
        "VAR(A1, A2, A3)",
        &[
            ((0, 0, 0), Value::Number(1.0)),
            ((0, 1, 0), Value::Number(2.0)),
            ((0, 2, 0), Value::Number(3.0)),
        ],
    );
    assert_eq!(result, Value::Number(1.0));
}

#[test]
fn e2e_ai_function_returns_ai_not_available() {
    // =AI("prompt") per CORR-06 / T4-D05: parser emits Function { name: "AI", ... };
    // the AI sentinel function in the registry returns Error(AINotAvailable).
    // W5-4: previously this returned Name error (no AI registered); now properly
    // honors the spec sigil.
    use ql_types::ErrorValue;
    let result = eval_source_with_registry(r#"AI("prompt")"#, &[]);
    assert_eq!(result, Value::Error(ErrorValue::AINotAvailable));
}

#[test]
fn e2e_ai_with_no_args_also_returns_ai_not_available() {
    // =AI() bare — same sentinel.
    use ql_types::ErrorValue;
    let result = eval_source_with_registry("AI()", &[]);
    assert_eq!(result, Value::Error(ErrorValue::AINotAvailable));
}

#[test]
fn e2e_ai_case_insensitive_dispatch() {
    use ql_types::ErrorValue;
    for src in [r#"AI("x")"#, r#"ai("x")"#, r#"Ai("x")"#] {
        let result = eval_source_with_registry(src, &[]);
        assert_eq!(
            result,
            Value::Error(ErrorValue::AINotAvailable),
            "src={src}"
        );
    }
}

#[test]
fn e2e_complex_formula() {
    // =IF(SUM(A1, A2) > 50, "big", AVERAGE(A1, A2) * 2)
    // A1=30, A2=40 → SUM=70, 70>50, returns "big"
    let result = eval_source_with_registry(
        r#"IF(SUM(A1, A2) > 50, "big", AVERAGE(A1, A2) * 2)"#,
        &[
            ((0, 0, 0), Value::Number(30.0)),
            ((0, 1, 0), Value::Number(40.0)),
        ],
    );
    assert_eq!(result, Value::text("big"));

    // Same formula with A1=10, A2=15 → SUM=25, 25<=50, returns AVERAGE=12.5 * 2 = 25
    let result = eval_source_with_registry(
        r#"IF(SUM(A1, A2) > 50, "big", AVERAGE(A1, A2) * 2)"#,
        &[
            ((0, 0, 0), Value::Number(10.0)),
            ((0, 1, 0), Value::Number(15.0)),
        ],
    );
    assert_eq!(result, Value::Number(25.0));
}

// ===== SIMD bulk path E2E (OG-02 hot path from source) =====

#[test]
fn e2e_og02_source_to_simd_dispatch() {
    // =A * 2 — parse, classify, dispatch. Verifies the OG-02 hot path is reachable
    // from source text. The classifier should recognize `A * 2` as MulScalar (the
    // bare column A becomes a WholeColumn range, but the classifier currently expects
    // CellRef * Number — see note below).
    //
    // Phase 0 W5-3 verification: =A1 * 2 (cell-specific variant) classifies correctly.
    let src = "A1 * 2";
    let tokens = lex(src).expect("lex");
    let ast = parse(tokens).expect("parse");
    let plan = bind(&ast, 0).expect("bind");

    let shape = classify(&plan);
    assert!(matches!(
        shape,
        SimdShape::MulScalar {
            input_col: 0,
            scalar: 2.0,
        }
    ));

    // Dispatch over a 100-element f64 chunk and verify each output.
    let input: Vec<f64> = (0..100).map(|i| i as f64).collect();
    let mut out = vec![0.0; 100];
    let did_simd = dispatch(&shape, &input, &[], &mut out);
    assert!(did_simd);
    for (i, &v) in out.iter().enumerate() {
        assert_eq!(v, (i as f64) * 2.0);
    }
}

#[test]
fn e2e_og02_bare_column_bind_unsupported_in_phase_0() {
    // =A * 2 — bare column lexes to BareColumn → parser produces RangeRef::WholeColumn,
    // NOT a CellRef. The Phase 0 W4-1 binder rejects standalone RangeRef
    // outside a Function context (it needs the FormulaRegion binder, Phase 4+).
    //
    // Phase 0 W5-3 documents this gap: =A1 * 2 works (CellRef); =A * 2 is binder-
    // rejected until the FormulaRegion binder lands. Source authors today should
    // use SUM(A:A) / etc. for whole-column references.
    use ql_exec::BindError;
    let src = "A * 2";
    let ast = parse(lex(src).unwrap()).unwrap();
    let result = bind(&ast, 0);
    assert!(matches!(result, Err(BindError::UnsupportedVariant(_))));
}

// ===== error paths =====

#[test]
fn e2e_unknown_function_returns_name_error() {
    use ql_types::ErrorValue;
    let result = eval_source_with_registry("NONESUCH(A1)", &[]);
    assert_eq!(result, Value::Error(ErrorValue::Name));
}

#[test]
fn e2e_error_propagation_through_arithmetic() {
    use ql_types::ErrorValue;
    let result = eval_source_scalar("A1 + 5", &[((0, 0, 0), Value::Error(ErrorValue::Ref))]);
    assert_eq!(result, Value::Error(ErrorValue::Ref));
}

// ===== sanity: RangeRef re-export from ql-calcgraph works =====

#[test]
fn rangeref_reexport_compiles() {
    // Compile-time check that the ql-calcgraph re-export of RangeRef works for
    // downstream consumers like ql-exec test code.
    let _ = RangeRef::WholeColumn {
        sheet: SheetRef::Current,
        start_col: 0,
        end_col: 0,
        abs_start: false,
        abs_end: false,
    };
}
