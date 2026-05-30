//! UDF-6-03 — Rust↔Python type-conversion matrix, end-to-end through the REAL
//! Python worker.
//!
//! Where `udf_e2e.rs` proves one number computes, this proves the *conversion
//! contract*: every [`Value`] variant and all 15 [`ErrorValue`] sigils survive a
//! full round-trip (Rust encode → length-prefixed Arrow-IPC → stdin → pyarrow
//! decode → the `_echo` UDF → pyarrow encode → stdout → Rust decode), bit-exactly;
//! and the numpy/pandas dtype boundary fails LOUDLY rather than silently coercing.
//!
//! It drives `ql_udf::ProcessWorker::call` directly (not the formula evaluator) so
//! it can inject *every* variant — including error sigils, which the binder's
//! `ArgPolicy::Strict` would short-circuit before dispatch in a real formula.
//!
//! Skip discipline mirrors `udf_e2e.rs`: if no `python3`/`python` with `pyarrow`
//! is on PATH the test prints a LOUD skip and returns. numpy/pandas sub-cases are
//! additionally guarded on their library importing — a missing library is a skip,
//! NOT a silent pass (and never gets mistaken for the type-boundary `TypeError`).
//! This is test-environment gating, NOT a production fallback (the engine fails
//! loud on a missing interpreter).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use ql_types::{ArrayValue, ErrorValue, Value};
use ql_udf::{ProcessWorker, PythonWorkerConfig, UdfError, UdfWorker};

/// `_smoke_udfs` handle 8 — identity over the whole args grid (round-trip).
const ECHO: u64 = 8;
/// numpy/pandas return-type fixtures (see `_smoke_udfs.py`).
const RET_NUMPY_FLOAT64: u64 = 20;
const RET_NUMPY_INT64: u64 = 21;
const RET_NUMPY_BOOL: u64 = 22;
const RET_PANDAS_SERIES: u64 = 23;
const RET_PANDAS_DATAFRAME: u64 = 24;

/// Generous per-call deadline — these calls are trivial; we are testing
/// conversion, not timing.
const DEADLINE: Duration = Duration::from_secs(30);

/// Find an interpreter that can `import pyarrow`, or `None`.
fn python_with_pyarrow() -> Option<String> {
    for py in ["python3", "python"] {
        if module_importable(py, "pyarrow") {
            return Some(py.to_string());
        }
    }
    None
}

/// Whether `py -c "import <module>"` succeeds.
fn module_importable(py: &str, module: &str) -> bool {
    Command::new(py)
        .args(["-c", &format!("import {module}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The `_smoke_udfs` worker config — `quantbook-py/python` is a sibling of this
/// crate (`crates/ql-exec` → `crates/quantbook-py`). Mirrors `udf_e2e::smoke_config`.
fn smoke_config(py: &str) -> PythonWorkerConfig {
    let pythonpath = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../quantbook-py/python")
        .canonicalize()
        .expect("quantbook-py/python directory should exist");
    PythonWorkerConfig::new(py)
        .with_pythonpath(pythonpath)
        .with_udf_module("quantbook._smoke_udfs")
}

/// Spawn + handshake a real worker, failing loud if it cannot start.
fn started_worker(py: &str) -> ProcessWorker {
    let mut w = ProcessWorker::new(smoke_config(py));
    w.ensure_started()
        .expect("the real Python worker should spawn + handshake");
    w
}

/// LOUD-skip guard shared by every test. Returns the interpreter or `None` after
/// printing a skip line.
fn require_pyarrow(test: &str) -> Option<String> {
    match python_with_pyarrow() {
        Some(p) => Some(p),
        None => {
            eprintln!("SKIP {test}: no `python3`/`python` with `pyarrow` on PATH");
            None
        }
    }
}

/// Every `Value` variant and all 15 `ErrorValue` sigils round-trip identically
/// through the real worker, across scalar, 1×N, multi-row, and degenerate shapes.
#[test]
fn value_variants_and_error_sigils_round_trip_through_real_worker() {
    let Some(py) = require_pyarrow("value_variants_and_error_sigils_round_trip_through_real_worker")
    else {
        return;
    };
    let mut w = started_worker(&py);

    // --- A 1×N row containing every Value variant + all 15 error sigils. ---
    let mut cells = vec![
        Value::Blank,
        Value::Boolean(true),
        Value::Boolean(false),
        Value::Number(0.0),
        Value::Number(1.0),
        Value::Number(-1.0),
        Value::Number(3.5),
        Value::Number(f64::MAX),
        Value::Number(f64::MIN),
        Value::Number(f64::MIN_POSITIVE),
        Value::Number(1e-300),
        Value::Number(1e300),
        Value::Text(Arc::from("")),
        Value::Text(Arc::from("hello")),
        // Unicode + multi-byte: the codec is UTF-8, must survive.
        Value::Text(Arc::from("café π → ✓ 日本語")),
    ];
    for ev in ErrorValue::ALL {
        cells.push(Value::Error(ev));
    }
    let row = ArrayValue::row(cells);
    let out = w.call(ECHO, &row, DEADLINE).expect("echo of the full row");
    assert_eq!(
        out, row,
        "every Value variant + all 15 ErrorValue sigils must round-trip identically"
    );

    // --- A 1×1 scalar of each variant (the spreadsheet's common case). ---
    for v in [
        Value::Blank,
        Value::Boolean(true),
        Value::Number(42.0),
        Value::Text(Arc::from("scalar")),
        Value::Error(ErrorValue::DivZero),
    ] {
        let g = ArrayValue::singleton(v.clone());
        let out = w.call(ECHO, &g, DEADLINE).expect("echo of a scalar");
        assert_eq!(out, g, "scalar {v:?} must round-trip");
    }

    // --- A multi-row (3×2) grid: rows/cols metadata + row-major order. ---
    let grid = ArrayValue::new(
        3,
        2,
        vec![
            Value::Number(1.0),
            Value::Text(Arc::from("a")),
            Value::Boolean(true),
            Value::Blank,
            Value::Error(ErrorValue::NA),
            Value::Number(-2.5),
        ],
    )
    .expect("3×2 grid is well-formed");
    let out = w.call(ECHO, &grid, DEADLINE).expect("echo of a 3×2 grid");
    assert_eq!(out, grid, "a 3×2 grid must round-trip with shape preserved");
    assert_eq!(out.rows(), 3, "row count preserved");

    // --- Degenerate (0-area) shapes must survive the codec's metadata path. ---
    // All three zero-area shapes round-trip end-to-end through the real worker (the
    // shape rides in schema metadata, so 0×3 / 3×0 / 0×0 are distinguishable).
    for (r, c) in [(0u32, 3u32), (3, 0), (0, 0)] {
        let empty = ArrayValue::empty(r, c);
        let out = w
            .call(ECHO, &empty, DEADLINE)
            .unwrap_or_else(|e| panic!("echo of a {r}×{c} grid: {e:?}"));
        assert_eq!(out, empty, "a {r}×{c} degenerate grid must round-trip");
        assert_eq!(out.rows(), r, "{r}×{c}: row count preserved");
        assert_eq!(out.cols(), c, "{r}×{c}: col count preserved");
    }
}

/// Signed zero is preserved bit-exactly (`-0.0` keeps its sign bit). `ArrayValue`'s
/// `PartialEq` treats `0.0 == -0.0`, so the matrix test above cannot catch a sign
/// flip — assert the raw bits here.
#[test]
fn negative_zero_round_trips_bit_exact() {
    let Some(py) = require_pyarrow("negative_zero_round_trips_bit_exact") else {
        return;
    };
    let mut w = started_worker(&py);

    let neg_zero = ArrayValue::singleton(Value::Number(-0.0));
    let out = w.call(ECHO, &neg_zero, DEADLINE).expect("echo of -0.0");
    match out.get(0, 0) {
        Some(Value::Number(x)) => assert_eq!(
            x.to_bits(),
            (-0.0f64).to_bits(),
            "-0.0 must round-trip bit-exact (sign bit preserved), got {x}"
        ),
        other => panic!("expected a Number cell, got {other:?}"),
    }
}

/// The numpy scalar boundary: `numpy.float64` round-trips (it subclasses Python
/// `float`); `numpy.int64` and `numpy.bool_` do NOT — the encoder raises a loud
/// `TypeError` (surfaced as [`UdfError::Raised`]), never a silent coercion.
/// Guarded on numpy being importable (a missing numpy is a SKIP, not the boundary).
#[test]
fn numpy_scalar_type_boundary_is_honest() {
    let Some(py) = require_pyarrow("numpy_scalar_type_boundary_is_honest") else {
        return;
    };
    if !module_importable(&py, "numpy") {
        eprintln!("SKIP numpy_scalar_type_boundary_is_honest: `numpy` not importable by {py}");
        return;
    }
    let mut w = started_worker(&py);
    // The fixtures ignore their args; pass a 1×1 placeholder.
    let arg = ArrayValue::singleton(Value::Number(0.0));

    // numpy.float64 — a Python `float` subclass → encodes as Value::Number.
    let out = w
        .call(RET_NUMPY_FLOAT64, &arg, DEADLINE)
        .expect("numpy.float64 must round-trip (float subclass)");
    assert_eq!(
        out.get(0, 0),
        Some(&Value::Number(2.5)),
        "numpy.float64(2.5) must decode to Value::Number(2.5)"
    );

    // numpy.int64 — NOT an int/float subclass → loud TypeError.
    assert_type_rejected(
        w.call(RET_NUMPY_INT64, &arg, DEADLINE),
        "numpy.int64",
    );

    // numpy.bool_ — NOT a bool/int subclass → loud TypeError.
    assert_type_rejected(
        w.call(RET_NUMPY_BOOL, &arg, DEADLINE),
        "numpy.bool_",
    );
}

/// The pandas boundary: a `Series`/`DataFrame` is an unsupported cell type → the
/// encoder raises a loud `TypeError`. Guarded on pandas being importable.
#[test]
fn pandas_type_boundary_is_honest() {
    let Some(py) = require_pyarrow("pandas_type_boundary_is_honest") else {
        return;
    };
    if !module_importable(&py, "pandas") {
        eprintln!("SKIP pandas_type_boundary_is_honest: `pandas` not importable by {py}");
        return;
    }
    let mut w = started_worker(&py);
    let arg = ArrayValue::singleton(Value::Number(0.0));

    assert_type_rejected(
        w.call(RET_PANDAS_SERIES, &arg, DEADLINE),
        "pandas.Series",
    );
    assert_type_rejected(
        w.call(RET_PANDAS_DATAFRAME, &arg, DEADLINE),
        "pandas.DataFrame",
    );
}

/// Assert a `call` result is a loud `TypeError` RAISE (the encoder rejecting an
/// unsupported return type) — never a silent success or a different failure mode.
fn assert_type_rejected(result: Result<ArrayValue, UdfError>, what: &str) {
    match result {
        Err(UdfError::Raised { exc_type, message }) => {
            assert_eq!(
                exc_type, "TypeError",
                "{what} must be rejected as a TypeError (got {exc_type}: {message})"
            );
        }
        Err(other) => panic!("{what}: expected a Raised TypeError, got a different UdfError: {other:?}"),
        Ok(grid) => panic!("{what}: expected a loud TypeError, but the call SUCCEEDED with {grid:?} (silent coercion!)"),
    }
}
