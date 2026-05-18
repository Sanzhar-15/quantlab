#![allow(
    unused_imports,
    dead_code,
    unused_mut,
    unused_variables,
    clippy::all,
    clippy::pedantic,
    clippy::nursery
)]
//! Phase 4.12 Opus-B threaded depth probe.
//!
//! Run via:
//! `cargo test -p ql-formula-syntax --test p412_b_threaded_depth_probe -- --ignored --nocapture`
//!
//! All deep-nesting probes run on a dedicated thread with a generous 64 MB
//! stack and `panic::catch_unwind` so a stack overflow is OBSERVABLE
//! rather than killing the test binary. Reports the largest depth that
//! succeeds and the depth at which the parser fails.

use std::panic;

use ql_formula_syntax::{lex, parse};

#[derive(Debug)]
enum Outcome {
    Ok,
    LexErr(String),
    ParseErr(String),
    Panic(String),
}

fn try_parse_threaded(input: String) -> Outcome {
    let handle = std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(move || {
            let r = panic::catch_unwind(|| {
                let toks = match lex(&input) {
                    Ok(t) => t,
                    Err(e) => return Outcome::LexErr(format!("{e}")),
                };
                match parse(toks) {
                    Ok(_) => Outcome::Ok,
                    Err(e) => Outcome::ParseErr(format!("{e}")),
                }
            });
            match r {
                Ok(o) => o,
                Err(p) => {
                    let msg = if let Some(s) = p.downcast_ref::<&str>() {
                        (*s).to_owned()
                    } else if let Some(s) = p.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "<non-string panic payload>".to_owned()
                    };
                    Outcome::Panic(msg)
                }
            }
        })
        .unwrap();
    handle
        .join()
        .unwrap_or(Outcome::Panic("join failed".to_owned()))
}

#[test]
#[ignore]
fn deep_function_call_thresholds() {
    for n in [100usize, 200, 500, 1000, 2000, 5000] {
        let mut s = String::new();
        for _ in 0..n {
            s.push_str("SUM(");
        }
        s.push('1');
        for _ in 0..n {
            s.push(')');
        }
        let r = try_parse_threaded(s);
        eprintln!("deep_function_call[{n}]: {r:?}");
    }
}

#[test]
#[ignore]
fn deep_paren_thresholds() {
    for n in [100usize, 500, 1000, 2000, 5000, 10000] {
        let mut s = String::new();
        for _ in 0..n {
            s.push('(');
        }
        s.push('1');
        for _ in 0..n {
            s.push(')');
        }
        let r = try_parse_threaded(s);
        eprintln!("deep_paren[{n}]: {r:?}");
    }
}

#[test]
#[ignore]
fn deep_unary_minus_thresholds() {
    for n in [1000usize, 5000, 10000, 20000] {
        let mut s = String::new();
        for _ in 0..n {
            s.push('-');
        }
        s.push('1');
        let r = try_parse_threaded(s);
        eprintln!("deep_unary_minus[{n}]: {r:?}");
    }
}

#[test]
#[ignore]
fn long_addition_thresholds() {
    for n in [1000usize, 10_000, 50_000, 100_000] {
        let mut s = String::from("1");
        for _ in 0..n {
            s.push_str("+1");
        }
        let r = try_parse_threaded(s);
        eprintln!("long_addition[{n}]: {r:?}");
    }
}
