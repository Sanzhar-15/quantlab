#![allow(
    unused_imports,
    dead_code,
    unused_mut,
    unused_variables,
    clippy::all,
    clippy::pedantic,
    clippy::nursery
)]
//! Phase 4.12 Opus-B pinpoint probes.
//!
//! Identifies the *exact* default-stack threshold at which the parser
//! stack-overflows. Each probe runs on the default cargo-test thread
//! stack (usually 2 MiB on macOS / 8 MiB on Linux) — production callers
//! hit the parser on threads of similar size.

use std::panic;

use ql_formula_syntax::{lex, parse};

fn try_parse_catch(input: &str) -> Result<bool, String> {
    let result = panic::catch_unwind(|| {
        let toks = match lex(input) {
            Ok(t) => t,
            Err(_) => return false,
        };
        parse(toks).is_ok()
    });
    result.map_err(|p| {
        if let Some(s) = p.downcast_ref::<&str>() {
            (*s).to_owned()
        } else if let Some(s) = p.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_owned()
        }
    })
}

/// Run on a thread with a TIGHT 2 MiB stack — mirrors a default test
/// thread on macOS, and reasonably close to a typical hot-path worker.
fn try_parse_tight(input: String) -> Result<Result<bool, String>, String> {
    let handle = std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024) // 2 MiB
        .spawn(move || try_parse_catch(&input))
        .unwrap();
    handle
        .join()
        .map_err(|_| "join error / thread aborted (stack overflow)".to_owned())
}

#[test]
#[ignore]
fn paren_threshold_2mib() {
    for n in [50usize, 100, 200, 400, 800, 1600, 3200] {
        let mut s = String::new();
        for _ in 0..n {
            s.push('(');
        }
        s.push('1');
        for _ in 0..n {
            s.push(')');
        }
        let r = try_parse_tight(s);
        eprintln!("paren[{n}, 2MiB stack]: {r:?}");
    }
}

#[test]
#[ignore]
fn function_call_threshold_2mib() {
    for n in [50usize, 100, 200, 400, 800, 1600] {
        let mut s = String::new();
        for _ in 0..n {
            s.push_str("SUM(");
        }
        s.push('1');
        for _ in 0..n {
            s.push(')');
        }
        let r = try_parse_tight(s);
        eprintln!("function_call[{n}, 2MiB stack]: {r:?}");
    }
}
