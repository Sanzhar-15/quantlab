//! Real-Python end-to-end smoke for [`ql_udf::ProcessWorker`] (Phase 6.4-3b).
//!
//! Spawns the actual `python -m quantbook.worker` and drives the full
//! engine → Arrow → stdio → pyarrow → dispatch → Arrow → stdio → engine round trip,
//! plus the raise / timeout-kill / respawn paths. If `python3` (or `python`) with
//! `pyarrow` is not available, the test prints a LOUD skip and returns — this is
//! test-environment gating, not a production fallback (the engine itself fails loud
//! on a missing interpreter; see `process::tests::missing_interpreter_*`).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use ql_types::{ArrayValue, Value};
use ql_udf::{ProcessWorker, PythonWorkerConfig, UdfError, UdfWorker};

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

fn smoke_config(py: &str) -> PythonWorkerConfig {
    let pythonpath = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../quantbook-py/python")
        .canonicalize()
        .expect("quantbook-py/python directory should exist");
    PythonWorkerConfig::new(py)
        .with_pythonpath(pythonpath)
        .with_udf_module("quantbook._smoke_udfs")
}

#[test]
fn process_worker_round_trips_against_real_python() {
    let py = match python_with_pyarrow() {
        Some(p) => p,
        None => {
            eprintln!(
                "SKIP process_worker_round_trips_against_real_python: \
                 no `python3`/`python` with `pyarrow` on PATH"
            );
            return;
        }
    };
    let mut w = ProcessWorker::new(smoke_config(&py));

    // (1) handle 7 — double a number: full engine↔pyarrow round trip.
    let out = w
        .call(7, &ArrayValue::singleton(Value::Number(21.0)), Duration::from_secs(10))
        .expect("call handle 7");
    assert_eq!(out.rows(), 1);
    assert_eq!(out.cols(), 1);
    assert_eq!(out.get(0, 0), Some(&Value::Number(42.0)));
    let pid_before = w.pid();
    assert!(pid_before.is_some(), "worker should be live after a successful call");

    // (2) handle 8 — identity over a mixed 1x3 grid: faithful round-trip of
    //     number / text / boolean across the Arrow tagged columns.
    let grid = ArrayValue::new(
        1,
        3,
        vec![
            Value::Number(1.5),
            Value::Text(Arc::from("hi")),
            Value::Boolean(true),
        ],
    )
    .unwrap();
    let back = w.call(8, &grid, Duration::from_secs(10)).expect("call handle 8");
    assert_eq!(back.rows(), 1);
    assert_eq!(back.cols(), 3);
    assert_eq!(back.get(0, 0), Some(&Value::Number(1.5)));
    assert_eq!(back.get(0, 1), Some(&Value::Text(Arc::from("hi"))));
    assert_eq!(back.get(0, 2), Some(&Value::Boolean(true)));

    // (3) handle 9 — the Python callable raises → deterministic Raised + diagnostic.
    let err = w
        .call(9, &ArrayValue::singleton(Value::Blank), Duration::from_secs(10))
        .unwrap_err();
    match err {
        UdfError::Raised { exc_type, message } => {
            assert_eq!(exc_type, "ValueError");
            assert!(
                message.contains("intentional smoke failure"),
                "raise message: {message}"
            );
        }
        other => panic!("expected UdfError::Raised, got {other:?}"),
    }

    // (4) handle 11 — sleeps 60s, deadline 300ms → Timeout + the worker is killed.
    let timed_out = w
        .call(11, &ArrayValue::singleton(Value::Blank), Duration::from_millis(300))
        .unwrap_err();
    assert!(
        matches!(timed_out, UdfError::Timeout(_)),
        "expected UdfError::Timeout, got {timed_out:?}"
    );
    assert_eq!(w.pid(), None, "the worker must be dead after a timeout-kill");

    // (5) Respawn: a subsequent call lazily re-spawns + re-handshakes and succeeds.
    let out2 = w
        .call(7, &ArrayValue::singleton(Value::Number(4.0)), Duration::from_secs(10))
        .expect("respawn + call handle 7");
    assert_eq!(out2.get(0, 0), Some(&Value::Number(8.0)));
    assert!(w.pid().is_some(), "a fresh worker should be live after respawn");
    assert_ne!(
        w.pid(),
        pid_before,
        "respawn must be a NEW process (different pid)"
    );
}
