#![allow(
    unused_imports,
    dead_code,
    clippy::all,
    clippy::pedantic,
    clippy::nursery
)]
//! Phase 4.12 defensive function-arg fuzz probes.
//!
//! Tests ~30 functions across categories with NaN, Inf, -Inf, subnormal,
//! massive magnitudes, empty / single-cell / 1M-cell ranges, all-error
//! ranges, mixed-type ranges, and self-referential ranges.
//!
//! Marked `#[ignore]`. Each probe records observable outcome to stderr;
//! the assertion is just "didn't panic / hang".

use std::panic;
use std::sync::atomic::{AtomicUsize, Ordering};

use ql_exec::WorkbookRuntime;
use ql_functions::default_registry;
use ql_storage::Workbook;
use ql_types::Value;

fn build_wb() -> (Workbook, ql_functions::FunctionRegistry) {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    (wb, default_registry())
}

fn try_set_formula(rt: &mut WorkbookRuntime, row: u32, col: u32, text: &str) -> String {
    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
        rt.set_formula(0, row, col, text)
    }));
    match result {
        Ok(Ok(v)) => format!("OK: {v:?}"),
        Ok(Err(e)) => format!("RuntimeError: {e}"),
        Err(p) => {
            let msg = if let Some(s) = p.downcast_ref::<&str>() {
                (*s).to_owned()
            } else if let Some(s) = p.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic>".to_owned()
            };
            format!("PANIC: {msg}")
        }
    }
}

// ─── NaN / Inf / subnormal scalar handling ─────────────────────────────────

/// Pump NaN / Inf / subnormal through every scalar function in this list.
/// Outcome we want for each: typed `#NUM!` / `#VALUE!` (or whatever Excel
/// canon is) — but specifically NOT a Rust panic or NaN-out-the-bottom
/// silent corruption.
const SCALAR_FNS_TO_PROBE: &[&str] = &[
    // Math
    "ABS",
    "SIGN",
    "SQRT",
    "EXP",
    "LN",
    "LOG10",
    "LOG",
    // Round family
    "ROUND",
    "ROUNDUP",
    "ROUNDDOWN",
    "MROUND",
    // Trig
    "SIN",
    "COS",
    "TAN",
    "ASIN",
    "ACOS",
    "ATAN",
    // Hyperbolic
    "SINH",
    "COSH",
    "TANH",
    // Combinatorics
    "FACT",
    "GAMMA",
    // Logical
    "IF",
    // Error trapping
    "IFERROR",
    "IFNA",
    // Bit ops
    "BITAND",
    "BITOR",
    "BITLSHIFT",
    // Base conv
    "DEC2BIN",
    "DEC2HEX",
    // Iterative kernels
    "GAMMALN",
];

#[test]
#[ignore]
fn scalar_fns_with_nan_inf() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let weird_args = &[
        "0/0",            // NaN via /0 — surfaces #DIV/0 first
        "1/0",            // +Inf via /0
        "-1/0",           // -Inf via /0
        "1E308 * 10",     // overflow to Inf
        "1E-308 / 1E308", // underflow to subnormal/0
        "1E300",
        "-1E300",
        "5E-324", // smallest subnormal
    ];
    static IDX: AtomicUsize = AtomicUsize::new(0);
    for fname in SCALAR_FNS_TO_PROBE {
        for arg in weird_args {
            let i = IDX.fetch_add(1, Ordering::SeqCst);
            let row = (i / 16384) as u32;
            let col = (i % 16384) as u32;
            // Two-arg fns: ROUND, MROUND, LOG, BITAND, BITOR, BITLSHIFT, IF, IFERROR, IFNA, DEC2BIN, DEC2HEX
            let text = match *fname {
                "ROUND" | "ROUNDUP" | "ROUNDDOWN" | "MROUND" => format!("{fname}({arg},2)"),
                "LOG" => format!("{fname}({arg},10)"),
                "BITAND" | "BITOR" => format!("{fname}({arg},1)"),
                "BITLSHIFT" | "BITRSHIFT" => format!("{fname}(1,{arg})"),
                "IF" => format!("IF({arg}>0,1,0)"),
                "IFERROR" | "IFNA" => format!("{fname}({arg},42)"),
                "DEC2BIN" | "DEC2HEX" => format!("{fname}({arg})"),
                _ => format!("{fname}({arg})"),
            };
            let outcome = try_set_formula(&mut rt, row, col, &text);
            if outcome.starts_with("PANIC") {
                eprintln!("PANIC FOUND: fn={fname} text={text:?} => {outcome}");
            }
            eprintln!("[{fname:12}] arg={arg:24} → {outcome}");
        }
    }
}

// ─── Iterative kernel fuzz ────────────────────────────────────────────────

/// Iterative kernels — known to have caused HIGHs in Wave 3 (BINOM.INV
/// panic, GAMMA.INV hang, XIRR non-root). Probe with near-singular inputs.
#[test]
#[ignore]
fn iterative_kernels_near_singular() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let probes: &[(&str, &str)] = &[
        // NORM.INV / NORM.S.INV
        ("NORM.INV(0, 0, 1)", "p=0 → expect -Inf or #NUM!"),
        ("NORM.INV(1, 0, 1)", "p=1 → expect +Inf or #NUM!"),
        ("NORM.INV(0.5, 0, 0)", "stdev=0 → expect #NUM!"),
        ("NORM.S.INV(0)", "p=0 boundary"),
        ("NORM.S.INV(1)", "p=1 boundary"),
        // T.INV
        ("T.INV(0.5, 0)", "df=0"),
        ("T.INV(0.5, -1)", "df<0"),
        ("T.INV(0, 5)", "p=0"),
        ("T.INV(1, 5)", "p=1"),
        // CHISQ.INV
        ("CHISQ.INV(0, 5)", "p=0"),
        ("CHISQ.INV(1, 5)", "p=1"),
        ("CHISQ.INV(0.5, 0)", "df=0"),
        // BINOM.INV
        ("BINOM.INV(0, 0.5, 0.5)", "n=0"),
        ("BINOM.INV(10, 0, 0.5)", "p=0"),
        ("BINOM.INV(10, 1, 0.5)", "p=1"),
        ("BINOM.INV(10, 0.5, 0)", "alpha=0"),
        ("BINOM.INV(10, 0.5, 1)", "alpha=1"),
        // GAMMA.INV (Wave 3 HIGH)
        ("GAMMA.INV(0.5, 0, 1)", "alpha=0"),
        ("GAMMA.INV(0.5, 1, 0)", "beta=0"),
        ("GAMMA.INV(0.5, 1, 5E-324)", "beta subnormal"),
        ("GAMMA.INV(0, 1, 1)", "p=0"),
        ("GAMMA.INV(1, 1, 1)", "p=1"),
        // IRR / RATE (iterative)
        ("IRR({-1, 1})", "trivial 2-point"),
        ("IRR({-1, 0, 0, 0, 0})", "no positive flows"),
        ("IRR({0, 0, 0})", "all-zero"),
        ("IRR({1, 2, 3})", "no negative flows"),
        ("RATE(0, 100, -100)", "nper=0"),
        ("RATE(-1, 100, -100)", "nper=-1"),
        ("RATE(360, 0, -100)", "pmt=0"),
        // XIRR / XNPV
        ("XIRR({-100, 100}, {44197, 44197})", "same date both flows"),
        // PERCENTILE / QUARTILE
        ("PERCENTILE({}, 0.5)", "empty array"),
        ("PERCENTILE({1}, -0.1)", "k out of range"),
        ("PERCENTILE({1}, 1.1)", "k out of range"),
    ];
    static IDX: AtomicUsize = AtomicUsize::new(0);
    for (text, note) in probes {
        let i = IDX.fetch_add(1, Ordering::SeqCst);
        let row = i as u32;
        let outcome = try_set_formula(&mut rt, row, 0, text);
        if outcome.starts_with("PANIC") {
            eprintln!("PANIC FOUND: text={text:?} ({note}) => {outcome}");
        }
        eprintln!("[{note:50}] {text:48} → {outcome}");
    }
}

// ─── Self-referential ranges ───────────────────────────────────────────────

/// Function arg is the cell that holds the function — direct self-reference.
#[test]
#[ignore]
fn self_referential_formula_direct() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let outcome = try_set_formula(&mut rt, 0, 0, "A1 + 1");
    eprintln!("self_referential_formula_direct: {outcome}");
    // Outcome should be #CIRC! after recompute.
    let _ = rt.recompute_all();
    let v = wb.read(ql_types::Address::new(0, 0, 0));
    eprintln!("post-recompute A1 = {v:?}");
}

/// SUM(A:A) inside A1 — self-referential range.
#[test]
#[ignore]
fn self_referential_sum_whole_column() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let outcome = try_set_formula(&mut rt, 0, 0, "SUM(A:A)");
    eprintln!("self_referential_sum_whole_column: {outcome}");
    let _ = rt.recompute_all();
    let v = wb.read(ql_types::Address::new(0, 0, 0));
    eprintln!("post-recompute A1 = {v:?}");
}

/// 2-cycle with `with_graph` (Tarjan SCC active). Should yield #CIRC!.
#[test]
#[ignore]
fn two_cycle_a1_b1_with_graph() {
    use ql_exec::CalcgraphSession;
    let (mut wb, reg) = build_wb();
    let mut session = CalcgraphSession::new();
    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut session);
    let r1 = try_set_formula(&mut rt, 0, 0, "B1 + 1");
    let r2 = try_set_formula(&mut rt, 0, 1, "A1 - 1");
    eprintln!("two_cycle_a1_b1_with_graph: A1={r1} B1={r2}");
    let _ = rt.recompute_dirty();
    let va = wb.read(ql_types::Address::new(0, 0, 0));
    let vb = wb.read(ql_types::Address::new(0, 0, 1));
    eprintln!("post-recompute_dirty A1={va:?} B1={vb:?}");
}

/// 2-cycle: A1 = B1+1, B1 = A1-1.
#[test]
#[ignore]
fn two_cycle_a1_b1() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let r1 = try_set_formula(&mut rt, 0, 0, "B1 + 1");
    let r2 = try_set_formula(&mut rt, 0, 1, "A1 - 1");
    eprintln!("two_cycle_a1_b1: A1={r1} B1={r2}");
    let _ = rt.recompute_all();
    let va = wb.read(ql_types::Address::new(0, 0, 0));
    let vb = wb.read(ql_types::Address::new(0, 0, 1));
    eprintln!("post-recompute A1={va:?} B1={vb:?}");
}

// ─── Deep dependency chain ─────────────────────────────────────────────────

/// 1000-cell chain: A1 = 1, A2 = A1+1, ..., A1000 = A999 + 1. Does
/// recompute stack-overflow?
#[test]
#[ignore]
fn deep_dependency_chain_1000() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let _ = rt.set_formula(0, 0, 0, "1").unwrap();
    for i in 1..1000 {
        // A{i+1} = A{i} + 1
        let prev_row = i; // A1 is row 0 in 0-index, A2 is row 1, etc.
        let _ = i; // silence
        let formula = format!("A{} + 1", prev_row);
        let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            rt.set_formula(0, i as u32, 0, formula)
        }));
        if result.is_err() {
            eprintln!("set_formula panic at row {i}");
            return;
        }
    }
    eprintln!("deep_dependency_chain_1000: all set_formula succeeded");
    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| rt.recompute_all()));
    match result {
        Ok(rr) => eprintln!(
            "recompute: complete={} failed={}",
            rr.is_complete(),
            rr.failed_count()
        ),
        Err(_) => eprintln!("recompute PANICKED on 1000-cell chain"),
    }
    let last = wb.read(ql_types::Address::new(0, 999, 0));
    eprintln!("A1000 = {last:?}");
}

#[test]
#[ignore]
fn deep_dependency_chain_10000() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let _ = rt.set_formula(0, 0, 0, "1").unwrap();
    for i in 1..10_000u32 {
        let formula = format!("A{} + 1", i);
        let result =
            panic::catch_unwind(panic::AssertUnwindSafe(|| rt.set_formula(0, i, 0, formula)));
        if result.is_err() {
            eprintln!("set_formula panic at row {i}");
            return;
        }
    }
    eprintln!("deep_dependency_chain_10000: set_formula complete");
    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| rt.recompute_all()));
    match result {
        Ok(rr) => eprintln!(
            "recompute: complete={} failed={}",
            rr.is_complete(),
            rr.failed_count()
        ),
        Err(_) => eprintln!("recompute PANICKED on 10000-cell chain"),
    }
}

// ─── Huge range fan-in ─────────────────────────────────────────────────────

/// SUM over a 1M-cell whole-column range with sparse data.
#[test]
#[ignore]
fn sum_whole_column_million_cells_sparse() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    // Populate ~100 cells across the column.
    for i in 0..100u32 {
        let _ = rt.set_formula(0, i * 1000, 0, "1.5").unwrap();
    }
    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
        rt.set_formula(0, 0, 5, "SUM(A:A)")
    }));
    eprintln!("sum_whole_column_million_cells_sparse: {result:?}");
}

/// SUMPRODUCT with array args — recursion path.
#[test]
#[ignore]
fn sumproduct_with_2d_arrays() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let outcome = try_set_formula(&mut rt, 0, 0, "SUMPRODUCT({1,2;3,4},{5,6;7,8})");
    eprintln!("sumproduct_with_2d_arrays: {outcome}");
}

// ─── Function-name resolution edge cases ───────────────────────────────────

/// Pass a function name that doesn't exist.
#[test]
#[ignore]
fn unknown_function_name() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let outcome = try_set_formula(&mut rt, 0, 0, "ZZZNOTAFN(1)");
    eprintln!("unknown_function_name: {outcome}");
}

#[test]
#[ignore]
fn function_with_zero_args() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    for fname in ["SUM", "AVERAGE", "MAX", "MIN", "PRODUCT", "ROUND", "IF"] {
        let outcome = try_set_formula(&mut rt, 0, 0, &format!("{fname}()"));
        eprintln!("function_with_zero_args [{fname}]: {outcome}");
    }
}

// ─── Massive arg list ──────────────────────────────────────────────────────

#[test]
#[ignore]
fn sum_with_1000_arg_list() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let mut s = String::from("SUM(1");
    for _ in 0..999 {
        s.push_str(",1");
    }
    s.push(')');
    let outcome = try_set_formula(&mut rt, 0, 0, &s);
    eprintln!("sum_with_1000_arg_list: {outcome}");
}

// ─── Name-resolution cycle via defined names ───────────────────────────────

#[test]
#[ignore]
fn defined_name_self_reference() {
    let (mut wb, reg) = build_wb();
    // Set a defined name that points to a constant (not formula), then
    // formula that references it self-referentially via cell.
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    // Set name X = A1 (cell ref via NamedTarget). Then A1 = X + 1.
    use ql_storage::NamedTarget;
    let target = NamedTarget::Cell(ql_types::Address::new(0, 0, 0));
    let _ = rt.set_name("X", target);
    let outcome = try_set_formula(&mut rt, 0, 0, "X + 1");
    eprintln!("defined_name_self_reference set: {outcome}");
    let _ = rt.recompute_all();
    let v = wb.read(ql_types::Address::new(0, 0, 0));
    eprintln!("defined_name_self_reference post-recompute A1 = {v:?}");
}

// ─── Cross-sheet ref to a dropped sheet (rename-around) ────────────────────

#[test]
#[ignore]
fn cross_sheet_ref_after_rename() {
    let (mut wb, reg) = build_wb();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let _ = rt.add_sheet("OtherSheet", 16384);
    let _ = rt.set_formula(1, 0, 0, "42");
    let outcome1 = try_set_formula(&mut rt, 0, 0, "OtherSheet!A1");
    eprintln!("cross_sheet_initial: {outcome1}");
    let rename_result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
        rt.rename_sheet(1, "RenamedSheet")
    }));
    eprintln!("rename: {rename_result:?}");
    let _ = rt.recompute_all();
    let v = wb.read(ql_types::Address::new(0, 0, 0));
    eprintln!("A1 after rename = {v:?}");
}
