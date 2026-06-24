#![allow(
    unused_imports,
    dead_code,
    unused_mut,
    unused_variables,
    clippy::all,
    clippy::pedantic,
    clippy::nursery
)]
//! Phase 4.12 Opus-B pinpoint probes — now Tier B3 regressions.
//!
//! Originally `#[ignore]`'d diagnostics that identified the exact
//! default-stack threshold at which the parser stack-OVERFLOWED (~200
//! nested levels on a tight 2 MiB stack). **Tier B3 (2026-06-24)** added a
//! recursion-depth guard ([`ParseError::DepthExceeded`], cap 100), so the
//! parser no longer overflows on deep input — it returns a typed error
//! after at most ~100 frames. These tests are therefore un-ignored and
//! turned into assertions: each runs the parser on a worker thread with a
//! TIGHT 2 MiB stack (mirrors a default macOS thread — the production
//! floor) and asserts the thread JOINS WITHOUT A STACK-OVERFLOW ABORT and
//! that over-limit input is rejected (parsed-as-error) rather than
//! accepted. A regression that reintroduced unbounded recursion would
//! abort the worker thread and fail the outer `Ok` assertion.

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

// Accepted nesting depths are < 100 (parser cap `MAX_PARSE_DEPTH = 100`;
// `n` nested levels reach recursion depth `n + 1`, so `n >= 100` is
// rejected). The const is private to the parser crate, so the boundary is
// duplicated here as a literal; a change to the cap that is not mirrored
// here will fail these assertions, which is the intended signal.
const ACCEPTED_BELOW: usize = 100;

#[test]
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
        // Outer `Ok` == the 2 MiB worker thread joined without a
        // stack-overflow abort. This is the load-bearing assertion.
        let inner = try_parse_tight(s)
            .unwrap_or_else(|e| panic!("paren[{n}] thread aborted (stack overflow?): {e}"));
        if n < ACCEPTED_BELOW {
            assert_eq!(inner, Ok(true), "paren[{n}] should parse");
        } else {
            assert_eq!(
                inner,
                Ok(false),
                "paren[{n}] must be rejected by the depth guard, not parsed or aborted"
            );
        }
    }
}

#[test]
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
        let inner = try_parse_tight(s)
            .unwrap_or_else(|e| panic!("function_call[{n}] thread aborted (stack overflow?): {e}"));
        if n < ACCEPTED_BELOW {
            assert_eq!(inner, Ok(true), "function_call[{n}] should parse");
        } else {
            assert_eq!(
                inner,
                Ok(false),
                "function_call[{n}] must be rejected by the depth guard, not parsed or aborted"
            );
        }
    }
}

#[test]
fn sheet_qualifier_chain_threshold_2mib() {
    // Tier B3 fold regression: a chained sheet qualifier (`Sheet!Sheet!…!A1`)
    // is lexed as repeated `SheetName, Bang` pairs and was a depth-guard BYPASS
    // — the `parse_prefix` SheetName arm recursed once per qualifier WITHOUT
    // re-entering the guarded `parse_expr`. Pre-fix, a long chain overflowed the
    // 2 MiB stack and aborted the thread (the rejection only fired on unwind,
    // after N frames). Post-fix the chain is rejected BEFORE recursing, so the
    // worker thread joins and every chain length >= 2 is rejected.
    for n in [50usize, 200, 1000, 5000] {
        let mut s = String::new();
        for _ in 0..n {
            s.push_str("Sheet!");
        }
        s.push_str("A1");
        let inner = try_parse_tight(s)
            .unwrap_or_else(|e| panic!("sheet_chain[{n}] thread aborted (stack overflow?): {e}"));
        assert_eq!(
            inner,
            Ok(false),
            "sheet_chain[{n}] must be rejected (chained qualifier), not parsed or aborted"
        );
    }
}
