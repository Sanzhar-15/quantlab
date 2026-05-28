//! **OG-04 acceptance bench** — 1M-cell scalar evaluator baseline.
//!
//! Per Phase 0 spec Part V §1 OG-04: informational baseline measurement of per-cell
//! `eval_scalar` over 1M evaluations. This is NOT a perf target gate (OG-02 is the
//! actual hot-path target via the SIMD route); OG-04 establishes the SCALAR baseline
//! so future regressions to the slow-path evaluator show up.
//!
//! What we measure:
//! 1. `eval_scalar` of `=A_i * 2` for i in 0..1M against a MapEnv backed by a HashMap
//!    holding 1M cell values.
//! 2. Same plan with `eval_scalar_with_registry` (function-dispatch path, even though
//!    no function is invoked) — verifies the overhead of the wider evaluator.
//!
//! Expected: tens of ns per cell on Apple Silicon / modern x86. Scalar is the slow
//! path by design; the OG-02 SIMD path is ~100× faster (3.4 ms vs ~340 ms at 1M
//! scalar evals).

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use ql_exec::{bind, eval_scalar, eval_scalar_with_registry, ExprPlan, MapEnv};
use ql_formula_syntax::{CellAddr, Expr, Operator, SheetRef};
use ql_functions::default_registry;
use ql_types::Value;

const N: usize = 1_000_000;

fn build_env() -> MapEnv {
    let mut env = MapEnv::new();
    for i in 0..N {
        env.put(0, i as u32, 0, Value::Number(i as f64));
    }
    env
}

fn build_mul2_plan_for(row: u32) -> ExprPlan {
    let expr = Expr::Binary {
        op: Operator::Mul,
        lhs: Box::new(Expr::CellRef(CellAddr {
            sheet: SheetRef::Current,
            col: 0,
            row,
            abs_col: false,
            abs_row: false,
        })),
        rhs: Box::new(Expr::Number(2.0)),
    };
    // 6.4-1 (H1): binder now takes &FunctionRegistry. Bench formula has no
    // function calls so a fresh empty/default registry is sufficient.
    let registry = default_registry();
    bind(&expr, 0, &registry).unwrap()
}

fn bench_og04_scalar_1m_mul2(c: &mut Criterion) {
    let env = build_env();
    // Build 1M distinct plans once (each plan binds a different row).
    let plans: Vec<ExprPlan> = (0..N).map(|i| build_mul2_plan_for(i as u32)).collect();

    let mut group = c.benchmark_group("og04_scalar_1m");
    group.sample_size(10);

    group.bench_function("eval_scalar_mul2", |b| {
        b.iter(|| {
            let mut acc = 0.0_f64;
            for plan in &plans {
                if let Value::Number(n) = eval_scalar(plan, &env) {
                    acc += n;
                }
            }
            black_box(acc);
        });
    });

    let registry = default_registry();
    group.bench_function("eval_scalar_with_registry_mul2", |b| {
        b.iter(|| {
            let mut acc = 0.0_f64;
            for plan in &plans {
                if let Value::Number(n) = eval_scalar_with_registry(plan, &env, &registry) {
                    acc += n;
                }
            }
            black_box(acc);
        });
    });

    group.finish();
}

criterion_group!(benches, bench_og04_scalar_1m_mul2);
criterion_main!(benches);
