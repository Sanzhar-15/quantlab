//! Scalar evaluator — `eval_scalar(plan, env) -> Value`.
//!
//! Per-cell evaluation path. Used for:
//! - Single-cell formulas (`=A1+B1` in cell C1).
//! - Per-cell fallback inside a FormulaRegion when SIMD isn't applicable (text, error,
//!   mixed types, non-arithmetic ops).
//! - Tests, which is most of the W4-1 coverage.
//!
//! The SIMD hot path for OG-02 lives in `simd.rs` (W4-2) and bypasses this entirely —
//! it consumes Arrow Float64Array slices directly via `multiversion`-dispatched kernels.
//!
//! ## Excel binary arithmetic semantics (Phase 0)
//!
//! For binary operators `+ - * / ^`:
//! - If either operand is an `Error`, propagate that error (left operand wins).
//! - Coerce both operands to f64 via `to_number_strict` (Number → self; Bool → 0/1;
//!   Blank → 0; Text → `#VALUE!`; Error → propagate).
//! - Apply the f64 op. Sanitize result via `sanitize_f64` (NaN/Inf → `#NUM!`).
//! - Special cases: division by zero → `#DIV/0!`; negative base ** non-integer exponent
//!   → `#NUM!`.
//!
//! For `&` (concat): coerce both to text via `to_text_for_formula`; concat. Errors
//! propagate.
//!
//! Comparison operators (`=`, `<>`, `<`, `>`, `<=`, `>=`) are partially supported: same-
//! type comparisons return Bool; cross-type comparisons use Excel's type ordering
//! (Number < Text < Bool — yes really, see Microsoft docs). Phase 0 just handles
//! same-type Number comparisons; mixed-type lands in W4-4.
//!
//! Unary `-x` negates; `+x` no-ops; `x%` divides by 100.

use ql_formula_syntax::Operator;
use ql_functions::FunctionRegistry;
use ql_types::{coercion, ErrorValue, Value};

use crate::env::CellEnv;
use crate::plan::ExprPlan;

/// Evaluate an `ExprPlan` against `env` to produce a `Value`. Total function — never
/// panics on Excel semantics (NaN, div-by-zero, etc.). Panics only on internal
/// programmer errors (e.g. malformed ExprPlan that bind() couldn't produce).
///
/// `Function` variants return `#NAME?` (`ErrorValue::Name`). To dispatch through a
/// registry, use `eval_scalar_with_registry` instead.
pub fn eval_scalar<E: CellEnv>(plan: &ExprPlan, env: &E) -> Value {
    match plan {
        ExprPlan::Number(n) => Value::number(*n),
        ExprPlan::Bool(b) => Value::Boolean(*b),
        ExprPlan::String(s) => Value::Text(s.clone()),
        ExprPlan::CellRef {
            sheet, row, col, ..
        } => env.read_cell(*sheet, *row, *col),
        ExprPlan::Binary { op, lhs, rhs } => {
            let l = eval_scalar(lhs, env);
            let r = eval_scalar(rhs, env);
            eval_binary(*op, l, r)
        }
        ExprPlan::Unary { op, operand } => {
            let v = eval_scalar(operand, env);
            eval_unary(*op, v)
        }
        ExprPlan::Function { .. } => Value::Error(ErrorValue::Name),
    }
}

/// Like `eval_scalar` but dispatches `Function` variants through a `FunctionRegistry`.
/// Unknown function names return `#NAME?`. Args are evaluated left-to-right with this
/// same function (recursive); error-args propagate naturally through the registered
/// function's logic.
pub fn eval_scalar_with_registry<E: CellEnv>(
    plan: &ExprPlan,
    env: &E,
    registry: &FunctionRegistry,
) -> Value {
    match plan {
        ExprPlan::Number(n) => Value::number(*n),
        ExprPlan::Bool(b) => Value::Boolean(*b),
        ExprPlan::String(s) => Value::Text(s.clone()),
        ExprPlan::CellRef {
            sheet, row, col, ..
        } => env.read_cell(*sheet, *row, *col),
        ExprPlan::Binary { op, lhs, rhs } => {
            let l = eval_scalar_with_registry(lhs, env, registry);
            let r = eval_scalar_with_registry(rhs, env, registry);
            eval_binary(*op, l, r)
        }
        ExprPlan::Unary { op, operand } => {
            let v = eval_scalar_with_registry(operand, env, registry);
            eval_unary(*op, v)
        }
        ExprPlan::Function { name, args } => match registry.lookup(name) {
            Some(f) => {
                let evaluated: Vec<Value> = args
                    .iter()
                    .map(|a| eval_scalar_with_registry(a, env, registry))
                    .collect();
                f(&evaluated)
            }
            None => Value::Error(ErrorValue::Name),
        },
    }
}

fn eval_binary(op: Operator, lhs: Value, rhs: Value) -> Value {
    // Error propagation comes first — Excel's left-error-wins rule.
    if let Value::Error(e) = lhs {
        return Value::Error(e);
    }
    if let Value::Error(e) = rhs {
        return Value::Error(e);
    }

    match op {
        Operator::Plus | Operator::Minus | Operator::Mul | Operator::Div | Operator::Pow => {
            eval_arithmetic(op, &lhs, &rhs)
        }
        Operator::Concat => eval_concat(&lhs, &rhs),
        Operator::Eq
        | Operator::Neq
        | Operator::Lt
        | Operator::Le
        | Operator::Gt
        | Operator::Ge => eval_compare(op, &lhs, &rhs),
        // Phase 0 doesn't produce Percent as a binary op (it's unary in Excel).
        Operator::Percent => Value::Error(ErrorValue::Value),
    }
}

fn eval_arithmetic(op: Operator, lhs: &Value, rhs: &Value) -> Value {
    // Phase 2A.9 audit M1: arithmetic uses Excel-canonical *lenient* coercion.
    // `"5" + 1` evaluates to `6` (text-that-parses-as-number coerces); only
    // unparseable text returns `#VALUE!`. Phase 1 used the strict path which
    // rejected ALL text — that was a documented Phase 0 deviation from Excel
    // canon, with the lenient impl sitting unused in `ql-types::coercion`.
    let lhs_num = match coercion::to_number_lenient(lhs) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let rhs_num = match coercion::to_number_lenient(rhs) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };

    let result = match op {
        Operator::Plus => lhs_num + rhs_num,
        Operator::Minus => lhs_num - rhs_num,
        Operator::Mul => lhs_num * rhs_num,
        Operator::Div => {
            if rhs_num == 0.0 {
                return Value::Error(ErrorValue::DivZero);
            }
            lhs_num / rhs_num
        }
        Operator::Pow => {
            // Excel: negative base with non-integer exponent → #NUM!. Plain f64::powf
            // would produce NaN which sanitize_f64 would map to #NUM!, but check
            // explicitly so the error type is clear.
            if lhs_num < 0.0 && rhs_num.fract() != 0.0 {
                return Value::Error(ErrorValue::Num);
            }
            // Phase 2A.9 audit M3: Excel canon — `0^0` is `#NUM!`. Rust/IEEE
            // produces 1.0, which would be a silent deviation. Guard explicitly.
            if lhs_num == 0.0 && rhs_num == 0.0 {
                return Value::Error(ErrorValue::Num);
            }
            lhs_num.powf(rhs_num)
        }
        _ => unreachable!("eval_arithmetic called with non-arithmetic op {op:?}"),
    };

    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

fn eval_concat(lhs: &Value, rhs: &Value) -> Value {
    let l = match coercion::to_text_for_formula(lhs) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    let r = match coercion::to_text_for_formula(rhs) {
        Ok(s) => s,
        Err(e) => return Value::Error(e),
    };
    Value::text(format!("{l}{r}"))
}

fn eval_compare(op: Operator, lhs: &Value, rhs: &Value) -> Value {
    // Phase 2A.9 audit M2: implement Excel-canonical cross-type comparison.
    // Same-type pairs compare per their natural ordering; mixed-type pairs
    // order by type rank: Number < Text < Boolean. Blank coerces to 0 for
    // Number comparisons and "" for Text. Errors propagate.
    if let Value::Error(e) = lhs {
        return Value::Error(*e);
    }
    if let Value::Error(e) = rhs {
        return Value::Error(*e);
    }
    let cmp = compare_values_excel(lhs, rhs);
    let result_bool = match op {
        Operator::Eq => cmp == std::cmp::Ordering::Equal,
        Operator::Neq => cmp != std::cmp::Ordering::Equal,
        Operator::Lt => cmp == std::cmp::Ordering::Less,
        Operator::Le => matches!(cmp, std::cmp::Ordering::Less | std::cmp::Ordering::Equal),
        Operator::Gt => cmp == std::cmp::Ordering::Greater,
        Operator::Ge => {
            matches!(cmp, std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
        }
        _ => unreachable!(),
    };
    Value::Boolean(result_bool)
}

/// Phase 2A.9 audit M2: Excel-canonical comparison ordering. When operands
/// have different types, they're ordered by type rank: Number/Blank < Text <
/// Boolean. Within a type, natural ordering applies. Blank coerces to 0 (for
/// Number comparisons) or "" (for Text); we represent Blank as having the
/// Number rank so `=0=B1` is TRUE for blank B1.
///
/// This replaces `compare_values_phase0`, which returned `None` for mixed
/// types and let downstream code silently degrade to `false` for ordering
/// comparisons — a documented Phase 0 deviation from Excel canon.
fn compare_values_excel(lhs: &Value, rhs: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    // Same-type comparisons go through the natural ordering.
    match (lhs, rhs) {
        (Value::Number(a), Value::Number(b)) => return a.partial_cmp(b).unwrap_or(Ordering::Equal),
        (Value::Boolean(a), Value::Boolean(b)) => return a.cmp(b),
        (Value::Text(a), Value::Text(b)) => return a.as_ref().cmp(b.as_ref()),
        (Value::Blank, Value::Blank) => return Ordering::Equal,
        _ => {}
    }
    // Blank coerces per the other operand: Blank vs Number → compare as 0;
    // Blank vs Text → compare as "". This matches Excel's behavior for the
    // common `=A1=0` and `=A1=""` idioms.
    match (lhs, rhs) {
        (Value::Blank, Value::Number(b)) => {
            return 0.0_f64.partial_cmp(b).unwrap_or(Ordering::Equal)
        }
        (Value::Number(a), Value::Blank) => return a.partial_cmp(&0.0).unwrap_or(Ordering::Equal),
        (Value::Blank, Value::Text(b)) => return "".cmp(b.as_ref()),
        (Value::Text(a), Value::Blank) => return a.as_ref().cmp(""),
        _ => {}
    }
    // True cross-type: rank by type. Excel canon: Number < Text < Boolean.
    // Blank carries the Number rank (it coerces above before reaching here for
    // Number/Text peers, so this only matters for Blank-vs-Bool).
    fn type_rank(v: &Value) -> u8 {
        match v {
            Value::Number(_) | Value::Blank => 0,
            Value::Text(_) => 1,
            Value::Boolean(_) => 2,
            // Error already short-circuited in eval_compare.
            Value::Error(_) => unreachable!("Error short-circuits in eval_compare"),
        }
    }
    type_rank(lhs).cmp(&type_rank(rhs))
}

fn eval_unary(op: Operator, operand: Value) -> Value {
    if let Value::Error(e) = operand {
        return Value::Error(e);
    }
    let n = match coercion::to_number_strict(&operand) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let result = match op {
        Operator::Minus => -n,
        Operator::Plus => n,
        Operator::Percent => n / 100.0,
        _ => return Value::Error(ErrorValue::Value),
    };
    match coercion::sanitize_f64(result) {
        Ok(n) => Value::Number(n),
        Err(e) => Value::Error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::MapEnv;
    use crate::plan::bind;
    use ql_formula_syntax::{CellAddr, Expr};
    use std::sync::Arc;

    fn cell_ref(col: u32, row: u32) -> Expr {
        Expr::CellRef(CellAddr {
            sheet: None,
            col,
            row,
            abs_col: false,
            abs_row: false,
        })
    }

    fn n(v: f64) -> Expr {
        Expr::Number(v)
    }

    fn bin(op: Operator, lhs: Expr, rhs: Expr) -> Expr {
        Expr::Binary {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        }
    }

    fn eval(expr: &Expr, env: &MapEnv) -> Value {
        let plan = bind(expr, 0).expect("bind");
        eval_scalar(&plan, env)
    }

    // ===== literal + ref =====

    #[test]
    fn number_literal() {
        let env = MapEnv::new();
        assert_eq!(eval(&n(42.5), &env), Value::Number(42.5));
    }

    #[test]
    fn bool_literal() {
        let env = MapEnv::new();
        assert_eq!(eval(&Expr::Bool(true), &env), Value::Boolean(true));
    }

    #[test]
    fn string_literal() {
        let env = MapEnv::new();
        let s = Expr::String(Arc::from("hello"));
        assert_eq!(eval(&s, &env), Value::text("hello"));
    }

    #[test]
    fn nan_literal_becomes_num_error() {
        // Value::number sanitizer rejects NaN/Inf and surfaces #NUM!.
        let env = MapEnv::new();
        assert_eq!(eval(&n(f64::NAN), &env), Value::Error(ErrorValue::Num));
        assert_eq!(eval(&n(f64::INFINITY), &env), Value::Error(ErrorValue::Num));
    }

    #[test]
    fn cell_ref_reads_from_env() {
        let mut env = MapEnv::new();
        env.put(0, 5, 3, Value::Number(7.0));
        // Read column 3, row 5.
        assert_eq!(eval(&cell_ref(3, 5), &env), Value::Number(7.0));
    }

    #[test]
    fn cell_ref_missing_is_blank() {
        let env = MapEnv::new();
        assert_eq!(eval(&cell_ref(0, 0), &env), Value::Blank);
    }

    // ===== arithmetic =====

    #[test]
    fn binary_plus() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Plus, n(1.0), n(2.0)), &env),
            Value::Number(3.0)
        );
    }

    #[test]
    fn binary_minus() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Minus, n(5.0), n(2.0)), &env),
            Value::Number(3.0)
        );
    }

    #[test]
    fn binary_mul_is_og02_op() {
        // =A * 2 — the OG-02 acceptance pattern.
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Mul, n(3.0), n(4.0)), &env),
            Value::Number(12.0)
        );
    }

    #[test]
    fn binary_div() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Div, n(10.0), n(2.0)), &env),
            Value::Number(5.0)
        );
    }

    #[test]
    fn div_by_zero_yields_div_zero_error() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Div, n(10.0), n(0.0)), &env),
            Value::Error(ErrorValue::DivZero)
        );
    }

    #[test]
    fn pow_basic() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Pow, n(2.0), n(10.0)), &env),
            Value::Number(1024.0)
        );
    }

    #[test]
    fn pow_negative_base_with_fractional_exponent_yields_num_error() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Pow, n(-2.0), n(0.5)), &env),
            Value::Error(ErrorValue::Num)
        );
    }

    // ===== coercion =====

    #[test]
    fn bool_plus_number_coerces_to_one() {
        let env = MapEnv::new();
        // true + 5 = 1 + 5 = 6
        assert_eq!(
            eval(&bin(Operator::Plus, Expr::Bool(true), n(5.0)), &env),
            Value::Number(6.0)
        );
        // false + 5 = 0 + 5 = 5
        assert_eq!(
            eval(&bin(Operator::Plus, Expr::Bool(false), n(5.0)), &env),
            Value::Number(5.0)
        );
    }

    #[test]
    fn blank_plus_number_yields_number() {
        let env = MapEnv::new();
        // Blank coerces to 0 per Excel. =A1 + 5 when A1 is blank → 5.
        assert_eq!(
            eval(&bin(Operator::Plus, cell_ref(0, 0), n(5.0)), &env),
            Value::Number(5.0)
        );
    }

    #[test]
    fn text_plus_number_yields_value_error() {
        let env = MapEnv::new();
        let txt = Expr::String(Arc::from("hello"));
        // to_number_strict rejects Text → #VALUE!
        assert_eq!(
            eval(&bin(Operator::Plus, txt, n(5.0)), &env),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== error propagation =====

    #[test]
    fn error_in_lhs_propagates() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Ref));
        let result = eval(&bin(Operator::Plus, cell_ref(0, 0), n(5.0)), &env);
        assert_eq!(result, Value::Error(ErrorValue::Ref));
    }

    #[test]
    fn error_in_rhs_propagates() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Num));
        let result = eval(&bin(Operator::Plus, n(5.0), cell_ref(0, 0)), &env);
        assert_eq!(result, Value::Error(ErrorValue::Num));
    }

    #[test]
    fn lhs_error_wins_over_rhs_error() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Ref));
        env.put(0, 0, 1, Value::Error(ErrorValue::Value));
        let result = eval(&bin(Operator::Plus, cell_ref(0, 0), cell_ref(1, 0)), &env);
        assert_eq!(result, Value::Error(ErrorValue::Ref));
    }

    // ===== unary =====

    #[test]
    fn unary_minus() {
        let env = MapEnv::new();
        let expr = Expr::Unary {
            op: Operator::Minus,
            operand: Box::new(n(5.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Number(-5.0));
    }

    #[test]
    fn unary_percent() {
        let env = MapEnv::new();
        let expr = Expr::Unary {
            op: Operator::Percent,
            operand: Box::new(n(50.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Number(0.5));
    }

    // ===== nested =====

    #[test]
    fn nested_a1_plus_b1_times_2() {
        // =(A1 + B1) * 2 with A1=3, B1=4 → (3+4)*2 = 14
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(3.0));
        env.put(0, 0, 1, Value::Number(4.0));
        let inner = bin(Operator::Plus, cell_ref(0, 0), cell_ref(1, 0));
        let outer = bin(Operator::Mul, inner, n(2.0));
        assert_eq!(eval(&outer, &env), Value::Number(14.0));
    }

    #[test]
    fn og02_pattern_cell_times_two() {
        // The OG-02 baseline pattern: =A * 2 over many rows. Single-cell verification.
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(42.0));
        let expr = bin(Operator::Mul, cell_ref(0, 0), n(2.0));
        assert_eq!(eval(&expr, &env), Value::Number(84.0));
    }

    // ===== concat =====

    #[test]
    fn concat_two_strings() {
        let env = MapEnv::new();
        let l = Expr::String(Arc::from("foo"));
        let r = Expr::String(Arc::from("bar"));
        assert_eq!(
            eval(&bin(Operator::Concat, l, r), &env),
            Value::text("foobar")
        );
    }

    #[test]
    fn concat_number_and_string() {
        let env = MapEnv::new();
        let l = n(42.0);
        let r = Expr::String(Arc::from(" rows"));
        assert_eq!(
            eval(&bin(Operator::Concat, l, r), &env),
            Value::text("42 rows")
        );
    }

    // ===== comparison (Number-vs-Number Phase 0 subset) =====

    #[test]
    fn comparison_eq() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Eq, n(5.0), n(5.0)), &env),
            Value::Boolean(true)
        );
        assert_eq!(
            eval(&bin(Operator::Eq, n(5.0), n(6.0)), &env),
            Value::Boolean(false)
        );
    }

    #[test]
    fn comparison_lt() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Lt, n(3.0), n(5.0)), &env),
            Value::Boolean(true)
        );
        assert_eq!(
            eval(&bin(Operator::Lt, n(5.0), n(5.0)), &env),
            Value::Boolean(false)
        );
    }

    #[test]
    fn comparison_ge() {
        let env = MapEnv::new();
        assert_eq!(
            eval(&bin(Operator::Ge, n(5.0), n(5.0)), &env),
            Value::Boolean(true)
        );
        assert_eq!(
            eval(&bin(Operator::Ge, n(4.0), n(5.0)), &env),
            Value::Boolean(false)
        );
    }

    // ===== overflow / sanitization =====

    #[test]
    fn arithmetic_overflow_to_num_error() {
        let env = MapEnv::new();
        // f64::MAX * 2.0 = Inf → sanitize_f64 returns #NUM!
        let expr = bin(Operator::Mul, n(f64::MAX), n(2.0));
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::Num));
    }

    // ===== W4-5: function dispatch via registry =====

    fn eval_reg(expr: &Expr, env: &MapEnv, reg: &FunctionRegistry) -> Value {
        let plan = bind(expr, 0).expect("bind");
        eval_scalar_with_registry(&plan, env, reg)
    }

    #[test]
    fn function_without_registry_yields_name_error() {
        // Plain eval_scalar (no registry) returns #NAME? for any Function variant.
        let env = MapEnv::new();
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![n(1.0), n(2.0)],
        };
        let plan = bind(&expr, 0).unwrap();
        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::Name));
    }

    #[test]
    fn function_unknown_name_via_registry_yields_name_error() {
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        let expr = Expr::Function {
            name: Arc::from("DOES_NOT_EXIST"),
            args: vec![n(1.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Error(ErrorValue::Name));
    }

    #[test]
    fn function_sum_via_registry() {
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        // =SUM(1, 2, 3) → 6
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![n(1.0), n(2.0), n(3.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(6.0));
    }

    #[test]
    fn function_sum_with_cellrefs_via_registry() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(10.0));
        env.put(0, 1, 0, Value::Number(20.0));
        env.put(0, 2, 0, Value::Number(30.0));
        let reg = ql_functions::default_registry();
        // =SUM(A1, A2, A3)
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell_ref(0, 0), cell_ref(0, 1), cell_ref(0, 2)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(60.0));
    }

    #[test]
    fn function_if_via_registry() {
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        // =IF(TRUE, 1, 2) → 1
        let expr = Expr::Function {
            name: Arc::from("IF"),
            args: vec![Expr::Bool(true), n(1.0), n(2.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(1.0));
    }

    #[test]
    fn function_nested_in_binary() {
        // =SUM(1, 2) * 3 = 9
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        let inner = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![n(1.0), n(2.0)],
        };
        let outer = bin(Operator::Mul, inner, n(3.0));
        assert_eq!(eval_reg(&outer, &env, &reg), Value::Number(9.0));
    }

    #[test]
    fn function_var_uses_two_pass_via_registry() {
        // =VAR.S(1, 3) → 2 (per Welford two-pass)
        let env = MapEnv::new();
        let reg = ql_functions::default_registry();
        let expr = Expr::Function {
            name: Arc::from("VAR.S"),
            args: vec![n(1.0), n(3.0)],
        };
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Number(2.0));
    }

    #[test]
    fn function_error_in_arg_propagates_via_excel_semantics() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Error(ErrorValue::Ref));
        let reg = ql_functions::default_registry();
        let expr = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell_ref(0, 0), n(5.0)],
        };
        // SUM propagates the first error encountered.
        assert_eq!(eval_reg(&expr, &env, &reg), Value::Error(ErrorValue::Ref));
    }

    // ===== Phase 2A.9 audit M1: lenient arithmetic coercion =====

    /// Excel: `="5" + 1` evaluates to `6`. Text-that-parses-as-number coerces.
    /// Phase 2A.9: switched `eval_arithmetic` from `to_number_strict` to
    /// `to_number_lenient`. Previously returned `#VALUE!`.
    #[test]
    fn arithmetic_lenient_coerces_numeric_text() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(Expr::String(Arc::from("5"))),
            rhs: Box::new(Expr::Number(1.0)),
        };
        // Excel: 6
        assert_eq!(eval(&expr, &env), Value::Number(6.0));
    }

    /// Excel: `="50%" + 0` evaluates to `0.5`. Trailing-`%` text coerces with
    /// `/100` scaling per the lenient path.
    #[test]
    fn arithmetic_lenient_handles_percent_text() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(Expr::String(Arc::from("50%"))),
            rhs: Box::new(Expr::Number(2.0)),
        };
        // Excel: 1.0 (50% × 2)
        assert_eq!(eval(&expr, &env), Value::Number(1.0));
    }

    /// Excel: `="abc" + 1` evaluates to `#VALUE!` (unparseable text).
    #[test]
    fn arithmetic_lenient_unparseable_text_is_value_error() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(Expr::String(Arc::from("abc"))),
            rhs: Box::new(Expr::Number(1.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::Value));
    }

    // ===== Phase 2A.9 audit M2: Excel cross-type comparison =====

    /// Excel canon: when comparing across types, Number < Text < Boolean.
    /// `=5 < "x"` is TRUE because Number ranks below Text.
    #[test]
    fn compare_number_less_than_text_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Lt,
            lhs: Box::new(Expr::Number(5.0)),
            rhs: Box::new(Expr::String(Arc::from("x"))),
        };
        // Excel: TRUE
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    /// Excel: `="x" < TRUE` is TRUE (Text < Boolean).
    #[test]
    fn compare_text_less_than_boolean_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Lt,
            lhs: Box::new(Expr::String(Arc::from("x"))),
            rhs: Box::new(Expr::Bool(true)),
        };
        // Excel: TRUE
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    /// Excel: `=5 >= "0"` is FALSE because Number < Text (5 ranks below "0"
    /// not by numeric coercion but by type rank).
    #[test]
    fn compare_number_not_greater_or_equal_text_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Ge,
            lhs: Box::new(Expr::Number(5.0)),
            rhs: Box::new(Expr::String(Arc::from("0"))),
        };
        // Excel: FALSE (Number ranks below Text)
        assert_eq!(eval(&expr, &env), Value::Boolean(false));
    }

    /// Excel: `=A1=0` where A1 is Blank → TRUE (Blank coerces to 0).
    #[test]
    fn compare_blank_equals_zero() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Blank);
        let expr = Expr::Binary {
            op: Operator::Eq,
            lhs: Box::new(cell_ref(0, 0)),
            rhs: Box::new(Expr::Number(0.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    /// Same-type comparisons unchanged: `=5 < 10` is TRUE.
    #[test]
    fn compare_same_type_numbers_unchanged() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Lt,
            lhs: Box::new(Expr::Number(5.0)),
            rhs: Box::new(Expr::Number(10.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Boolean(true));
    }

    // ===== Phase 2A.9 audit M3: 0^0 = #NUM! =====

    /// Excel: `=0^0` is `#NUM!`. Rust/IEEE produces 1.0.
    #[test]
    fn pow_zero_zero_is_num_error_excel_canon() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Pow,
            lhs: Box::new(Expr::Number(0.0)),
            rhs: Box::new(Expr::Number(0.0)),
        };
        // Excel: #NUM!
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::Num));
    }

    /// Regression guard: `=2^10` still works.
    #[test]
    fn pow_normal_unchanged() {
        let env = MapEnv::new();
        let expr = Expr::Binary {
            op: Operator::Pow,
            lhs: Box::new(Expr::Number(2.0)),
            rhs: Box::new(Expr::Number(10.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Number(1024.0));
    }

    // ===== Phase 2A.9 audit H5: division produces #DIV/0! =====

    /// Excel: `=A1 / 0` where A1=10 → `#DIV/0!`. Phase 2A.9 routes division
    /// through scalar evaluator (was: SIMD reciprocal-mul produced Inf →
    /// sanitize_f64 → #NUM!, wrong error class).
    #[test]
    fn div_by_zero_scalar_returns_div_zero_error() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(10.0));
        let expr = Expr::Binary {
            op: Operator::Div,
            lhs: Box::new(cell_ref(0, 0)),
            rhs: Box::new(Expr::Number(0.0)),
        };
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::DivZero));
    }

    /// `=A1 / B1` with B1=0 → #DIV/0!.
    #[test]
    fn div_cellref_by_zero_cellref_returns_div_zero_error() {
        let mut env = MapEnv::new();
        env.put(0, 0, 0, Value::Number(10.0));
        env.put(0, 0, 1, Value::Number(0.0));
        let expr = Expr::Binary {
            op: Operator::Div,
            lhs: Box::new(cell_ref(0, 0)),
            rhs: Box::new(cell_ref(0, 1)),
        };
        assert_eq!(eval(&expr, &env), Value::Error(ErrorValue::DivZero));
    }
}
