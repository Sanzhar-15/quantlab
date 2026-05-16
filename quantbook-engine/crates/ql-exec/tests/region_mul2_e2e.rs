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
