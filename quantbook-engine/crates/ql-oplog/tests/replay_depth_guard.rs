//! Tier C2 (2026-06-24) + TB6 (2026-06-25) — end-to-end behaviour of the
//! PUBLIC op-log paths on a deeply-nested `Op::BatchCommit`.
//!
//! Threat model (each defense pins a typed error, no crash/hang/silent-apply):
//! - **Write path (TB6):** producing ops locally goes through `OpLog::append`
//!   (and `CollabSession::append_op`). TB6 added a write-side guard
//!   ([`OpLogError::BatchDepthExceeded`], cap `MAX_APPEND_BATCH_DEPTH = 32`) that
//!   rejects a pathologically-nested batch BEFORE serialization, so it never
//!   enters the log. `append_rejects_deeply_nested_batch_loudly` pins this.
//!   (Before TB6 this test appended the deep batch and relied on `replay_into`
//!   to reject it; the rejection now happens earlier, at `append`.)
//! - **Read path (untrusted `.qbook`):** bytes → Loro import → `OpLog::iter`
//!   DESERIALIZE is bounded independently by `serde_json`'s 128-level recursion
//!   limit (each `BatchCommit` ≈ 2 JSON levels → rejects beyond ~63 levels with
//!   a typed `Deserialize`), and the replay-side `apply_op` guard
//!   ([`ReplayError::BatchDepthExceeded`], cap 64) is the defense-in-depth
//!   backstop for any non-serde caller. Both are unit-tested directly in
//!   `src/replay.rs`; a deep batch can no longer reach `replay_into` via the
//!   local append path (append rejects it first), so that property lives there.

use ql_functions::default_registry;
use ql_oplog::{replay_into, CellWireValue, Op, OpLog, OpLogError};
use ql_storage::Workbook;
use ql_types::{Address, Value};

/// `BatchCommit{[BatchCommit{[ … PutValue … ]}]}` nested `depth` levels deep,
/// built ITERATIVELY so constructing the test data never recurses.
fn nest(depth: usize) -> Op {
    let mut op = Op::PutValue {
        sheet: 0,
        row: 0,
        col: 0,
        value: CellWireValue::Number(1.0),
    };
    for _ in 0..depth {
        op = Op::BatchCommit { ops: vec![op] };
    }
    op
}

#[test]
fn append_rejects_deeply_nested_batch_loudly() {
    // TB6: the public WRITE path (`OpLog::append`) rejects a pathologically-deep
    // batch with a typed error BEFORE it can be serialized/stored/replayed — so
    // such an op never enters the log. Run on a big stack only so the deep `Op`'s
    // recursive Drop (on append's early return) can't overflow the harness; the
    // rejection itself comes from the bounded depth pre-check, independent of
    // stack size.
    let outcome = std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(|| {
            let mut log = OpLog::new();
            let err = log
                .append(nest(200))
                .expect_err("a 200-deep nested batch must be rejected by append");
            assert!(
                matches!(err, OpLogError::BatchDepthExceeded { .. }),
                "expected a loud BatchDepthExceeded, got {err:?}"
            );
            // Rejected before any store — the log is untouched.
            assert!(log.is_empty(), "rejected op must not be stored");
        })
        .expect("spawn worker thread")
        .join();
    outcome.expect("worker overflowed/panicked — append guard is NOT bounded");
}

#[test]
fn replay_into_shallow_batch_still_works() {
    // Sanity: a normal one-level batch replays fine through the depth-threaded
    // `apply_op` (guards that the `, 0` / `depth + 1` plumbing didn't break the
    // happy path).
    let registry = default_registry();
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let mut log = OpLog::new();
    log.append(nest(1)).expect("append shallow batch");

    let n = replay_into(&log, &mut wb, &registry).expect("shallow batch replays");
    assert_eq!(n, 1);
    assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
}
