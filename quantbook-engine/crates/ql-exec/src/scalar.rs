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
    let lhs_num = match coercion::to_number_strict(lhs) {
        Ok(n) => n,
        Err(e) => return Value::Error(e),
    };
    let rhs_num = match coercion::to_number_strict(rhs) {
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
    // Phase 0 W4-1: Number-vs-Number comparisons only. Mixed-type comparison + Bool
    // ordering rules land in W4-4 with full Excel semantics. Other type pairs fall back
    // to "equal iff both are the same variant + value."
    let cmp = compare_values_phase0(lhs, rhs);
    let result_bool = match op {
        Operator::Eq => cmp == Some(std::cmp::Ordering::Equal),
        Operator::Neq => cmp != Some(std::cmp::Ordering::Equal),
        Operator::Lt => cmp == Some(std::cmp::Ordering::Less),
        Operator::Le => matches!(
            cmp,
            Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
        ),
        Operator::Gt => cmp == Some(std::cmp::Ordering::Greater),
        Operator::Ge => {
            matches!(
                cmp,
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            )
        }
        _ => unreachable!(),
    };
    Value::Boolean(result_bool)
}

fn compare_values_phase0(lhs: &Value, rhs: &Value) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    match (lhs, rhs) {
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::Boolean(a), Value::Boolean(b)) => Some(a.cmp(b)),
        (Value::Text(a), Value::Text(b)) => Some(a.as_ref().cmp(b.as_ref())),
        (Value::Blank, Value::Blank) => Some(Ordering::Equal),
        // Same-variant fallback: missing pairs return None (Phase 0 doesn't implement
        // Excel's mixed-type ordering yet). Eq/Neq still produce a Bool via `None != Equal`.
        _ => None,
    }
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
}
