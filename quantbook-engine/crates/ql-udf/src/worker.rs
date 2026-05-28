//! The [`UdfWorker`] abstraction + its error taxonomy + an in-process
//! [`MockWorker`].
//!
//! **6.4-3a.** The eval layer (6.4-3c) will hold a `&mut dyn UdfWorker` on the
//! eval context and call it from the `RegisteredFn::Udf` dispatch arm. This cycle
//! defines the trait + the loud [`UdfError`] taxonomy and proves the call paths
//! (success / raise / timeout) against a [`MockWorker`] — **no subprocess, no
//! Python**. The real process-backed worker (spawn / handshake / timeout-kill /
//! respawn) lands in 6.4-3b and will implement this same trait.

use std::time::Duration;

use ql_types::ArrayValue;

use crate::codec::CodecError;

/// Outcome of a failed UDF dispatch. Every variant maps to a *deterministic*
/// engine-side result at the call site (6.4-3c) — a cell error value + a
/// `CellDiagnostic` — never a panic and never a silently-dropped failure
/// (No-Fallbacks; contract §10.4 exit tests 6 + 7).
#[derive(Debug, thiserror::Error)]
pub enum UdfError {
    /// The Python callable raised. Maps to `#CALC!`/`#VALUE!` + a diagnostic
    /// carrying `exc_type` + `message` (exit test 7).
    #[error("udf raised {exc_type}: {message}")]
    Raised { exc_type: String, message: String },
    /// The call exceeded its deadline. The worker is killed; the result (if any
    /// arrives late) is dropped (exit test 6). Maps to `#TIMEOUT!`.
    #[error("udf timed out after {0:?}")]
    Timeout(Duration),
    /// The worker process died / the transport broke. Maps to `#CALC!` + a
    /// diagnostic; the worker respawns lazily on the next call.
    #[error("udf worker died / transport broken: {0}")]
    WorkerDied(String),
    /// Args could not be encoded, or the result could not be decoded.
    #[error("udf codec: {0}")]
    Codec(#[from] CodecError),
}

/// Dispatch one UDF call: marshal `args`, invoke the worker function identified by
/// `handle`, and return its result grid — subject to `deadline`.
///
/// Implementations must guarantee: a `deadline` breach surfaces
/// [`UdfError::Timeout`] (and, for a real process worker, kills it), and a dead
/// worker surfaces [`UdfError::WorkerDied`] rather than hanging. A scalar result
/// is a 1×1 [`ArrayValue`].
pub trait UdfWorker {
    fn call(
        &mut self,
        handle: u64,
        args: &ArrayValue,
        deadline: Duration,
    ) -> Result<ArrayValue, UdfError>;
}

/// In-process worker double for tests + for wiring the eval layer before the real
/// process worker exists. Runs a Rust closure in place of the Python callable.
///
/// It does NOT enforce `deadline` itself (there is no out-of-process work to time
/// out) — a test simulates a timeout by having the closure return
/// [`UdfError::Timeout`]. Real deadline enforcement + process-kill is 6.4-3b.
pub struct MockWorker<F> {
    responder: F,
}

impl<F> MockWorker<F>
where
    F: FnMut(u64, &ArrayValue) -> Result<ArrayValue, UdfError>,
{
    pub fn new(responder: F) -> Self {
        Self { responder }
    }
}

impl<F> UdfWorker for MockWorker<F>
where
    F: FnMut(u64, &ArrayValue) -> Result<ArrayValue, UdfError>,
{
    fn call(
        &mut self,
        handle: u64,
        args: &ArrayValue,
        _deadline: Duration,
    ) -> Result<ArrayValue, UdfError> {
        (self.responder)(handle, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode_grid, encode_grid};
    use crate::frame::{read_frame, write_frame, Frame, FrameType};
    use ql_types::Value;
    use std::sync::Arc;

    fn scalar(v: Value) -> ArrayValue {
        ArrayValue::singleton(v)
    }

    #[test]
    fn mock_worker_returns_a_result_grid() {
        // A UDF that doubles its single numeric arg.
        let mut w = MockWorker::new(|_handle, args: &ArrayValue| {
            let n = match args.get(0, 0) {
                Some(Value::Number(x)) => *x,
                _ => return Err(UdfError::Raised {
                    exc_type: "TypeError".into(),
                    message: "expected a number".into(),
                }),
            };
            Ok(ArrayValue::singleton(Value::Number(n * 2.0)))
        });
        let out = w
            .call(7, &scalar(Value::Number(21.0)), Duration::from_secs(1))
            .unwrap();
        assert_eq!(out.get(0, 0), Some(&Value::Number(42.0)));
    }

    #[test]
    fn mock_worker_surfaces_raise_and_timeout() {
        let mut raiser = MockWorker::new(|_h, _a| {
            Err(UdfError::Raised {
                exc_type: "ValueError".into(),
                message: "boom".into(),
            })
        });
        assert!(matches!(
            raiser.call(1, &scalar(Value::Blank), Duration::from_secs(1)),
            Err(UdfError::Raised { .. })
        ));

        let mut slow = MockWorker::new(|_h, _a| Err(UdfError::Timeout(Duration::from_millis(500))));
        assert!(matches!(
            slow.call(1, &scalar(Value::Blank), Duration::from_millis(500)),
            Err(UdfError::Timeout(_))
        ));
    }

    /// The load-bearing composition test: push args + result through the FULL
    /// wire pipeline (codec → frame → … → frame → codec) with the mock standing
    /// in for the worker process. Proves [`crate::codec`] + [`crate::frame`]
    /// compose into a faithful round-trip — the thing the real 6.4-3b worker will
    /// rely on across the actual pipe.
    #[test]
    fn call_round_trips_through_frame_and_codec() {
        // Engine-side args grid (a 1×3 row of mixed values).
        let args = ArrayValue::new(
            1,
            3,
            vec![
                Value::Number(10.0),
                Value::Text(Arc::from("x")),
                Value::Error(ql_types::ErrorValue::NA),
            ],
        )
        .unwrap();

        // --- engine → wire ---
        let call_frame = Frame::new(FrameType::Call, encode_grid(&args).unwrap());
        let mut pipe = Vec::new();
        write_frame(&mut pipe, &call_frame).unwrap();

        // --- worker side: read the CALL, decode, "run" the UDF, encode RETURN ---
        let mut cursor = std::io::Cursor::new(pipe);
        let got = read_frame(&mut cursor).unwrap().expect("a frame");
        assert_eq!(got.frame_type, FrameType::Call);
        let decoded_args = decode_grid(&got.payload).unwrap();
        // The worker echoes its args back as the result (identity UDF).
        let result = decoded_args.clone();
        let return_frame = Frame::new(FrameType::Return, encode_grid(&result).unwrap());
        let mut back = Vec::new();
        write_frame(&mut back, &return_frame).unwrap();

        // --- wire → engine: read the RETURN, decode ---
        let mut rcursor = std::io::Cursor::new(back);
        let rframe = read_frame(&mut rcursor).unwrap().expect("a frame");
        assert_eq!(rframe.frame_type, FrameType::Return);
        let final_grid = decode_grid(&rframe.payload).unwrap();

        // The grid survived engine → Arrow → frame → Arrow → engine intact.
        assert_eq!(final_grid.rows(), 1);
        assert_eq!(final_grid.cols(), 3);
        assert_eq!(final_grid.get(0, 0), Some(&Value::Number(10.0)));
        assert_eq!(final_grid.get(0, 1), Some(&Value::Text(Arc::from("x"))));
        assert_eq!(
            final_grid.get(0, 2),
            Some(&Value::Error(ql_types::ErrorValue::NA))
        );
    }
}
