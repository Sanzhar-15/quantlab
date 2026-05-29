//! Real-Python end-to-end for Phase 6.4-3c UDF eval wiring.
//!
//! Proves the FULL path the unit tests (MockWorker) cannot: a `WorkbookSession`
//! with a real `ql_udf::ProcessWorker` (spawning `python -m quantbook.worker`)
//! computes `=MYUDF(A1)` through engine → Arrow → stdio → pyarrow → dispatch →
//! Arrow → stdio → engine. If `python3`/`python` with `pyarrow` is not on PATH,
//! the test prints a LOUD skip and returns (test-environment gating, NOT a
//! production fallback — the engine fails loud on a missing interpreter; see
//! `ql_udf::process::tests::missing_interpreter_*`). Mirrors
//! `crates/ql-udf/tests/process_smoke.rs`.

use std::path::PathBuf;
use std::process::Command;

use ql_exec::WorkbookSession;
use ql_session::dto::CellValue;
use ql_session::function_meta::{
    ArgContext, ArgPolicy, Arity, BatchShape, CancelPolicy, DepShape, FunctionMetadata, Volatility,
};
use ql_session::session::{EngineSession, FunctionImplHandle};
use ql_udf::{ProcessWorker, PythonWorkerConfig};

/// Find an interpreter that can `import pyarrow`, or `None`.
fn python_with_pyarrow() -> Option<String> {
    for py in ["python3", "python"] {
        let ok = Command::new(py)
            .args(["-c", "import pyarrow"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(py.to_string());
        }
    }
    None
}

/// The `_smoke_udfs` worker config — `quantbook-py/python` is a sibling of this
/// crate (`crates/ql-exec` → `crates/quantbook-py`).
fn smoke_config(py: &str) -> PythonWorkerConfig {
    let pythonpath = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../quantbook-py/python")
        .canonicalize()
        .expect("quantbook-py/python directory should exist");
    PythonWorkerConfig::new(py)
        .with_pythonpath(pythonpath)
        .with_udf_module("quantbook._smoke_udfs")
}

/// Aggregate-context Python UDF metadata (mirrors the session.rs `udf_meta` helper).
fn udf_meta(canonical_name: &str) -> FunctionMetadata {
    FunctionMetadata {
        canonical_name: canonical_name.to_string(),
        display_name: None,
        aliases: vec![],
        arity: Arity::Variadic,
        volatility: Volatility::Volatile,
        determinism: false,
        dep_shape: DepShape::ValueDeps,
        batch_shape: BatchShape::ArrayBatch,
        arg_policy: ArgPolicy::Strict,
        cancellation: CancelPolicy::WorkerKill,
        arg_context: ArgContext::Aggregate,
        provenance_tags: vec!["python".to_string()],
    }
}

#[test]
fn udf_computes_against_real_python() {
    let py = match python_with_pyarrow() {
        Some(p) => p,
        None => {
            eprintln!(
                "SKIP udf_computes_against_real_python: \
                 no `python3`/`python` with `pyarrow` on PATH"
            );
            return;
        }
    };

    let mut s = WorkbookSession::new();
    let sheet = s.add_sheet("S", 16384).unwrap();

    // Register MYUDF under handle 7 — `_smoke_udfs._double` (doubles its 1×1 arg).
    s.register_function(udf_meta("MYUDF"), FunctionImplHandle(7))
        .expect("register_function clean");

    // Install the real process-backed worker.
    s.set_udf_worker(Box::new(ProcessWorker::new(smoke_config(&py))));

    // A1 = 21; B1 = MYUDF(A1) should compute 42 through the live Python worker.
    s.set_value(
        ql_session::dto::CellAddr { sheet, row: 0, col: 0 },
        CellValue::Number { number: 21.0 },
    )
    .unwrap();
    s.set_formula(
        ql_session::dto::CellAddr { sheet, row: 0, col: 1 },
        "MYUDF(A1)",
    )
    .unwrap();

    let b1 = s
        .cell(ql_session::dto::CellAddr { sheet, row: 0, col: 1 })
        .unwrap()
        .expect("B1 must exist")
        .value
        .expect("B1 must have a committed value");
    assert_eq!(
        b1,
        CellValue::Number { number: 42.0 },
        "=MYUDF(A1) with A1=21 must compute 42 via the real Python worker (got {b1:?})"
    );
}
