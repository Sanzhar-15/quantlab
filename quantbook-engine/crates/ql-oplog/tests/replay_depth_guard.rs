//! Tier C2 (Phase 4 v2 backlog, 2026-06-24) — end-to-end behaviour of the
//! PUBLIC replay path on a deeply-nested `Op::BatchCommit`.
//!
//! Threat model (verified empirically while building this):
//! - The untrusted input surface is loading a `.qbook`: bytes → Loro import →
//!   `OpLog::iter` DESERIALIZE. `serde_json`'s deserializer enforces a
//!   128-level recursion limit, and each `BatchCommit` is ~2 JSON levels, so a
//!   batch nested beyond ~64 levels is rejected with a typed `Deserialize`
//!   error BEFORE `apply_op` ever recurses. This test pins that the public
//!   path therefore fails LOUDLY (typed error, no crash/hang/silent-apply).
//! - The engine-internal `apply_op` recursion is additionally bounded by an
//!   explicit guard ([`ReplayError::BatchDepthExceeded`], cap 64) for any
//!   non-serde / future caller — that guard is unit-tested directly against
//!   `apply_op` in `src/replay.rs` (it cannot be reached through this
//!   serde-bounded public path, by design).
//!
//! NOTE: `OpLog::append` SERIALIZES (no recursion limit — that is a serde
//! deserialize-only feature), so appending a pathologically deep batch
//! recurses on the real stack. This test runs append+replay on a generous-
//! stack worker so the harness can't overflow during the append; serde's
//! deserialize recursion counter trips independently of stack size, so the
//! `replay_into` rejection it verifies holds on any stack.

use ql_functions::default_registry;
use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
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
fn replay_into_rejects_deeply_nested_batch_loudly() {
    // Run on a big stack: `append` serializes (and the deep `Op` later drops)
    // on the real stack, so this keeps the harness from overflowing there. The
    // property under test — `replay_into` REJECTS the deep batch — comes from
    // serde's deserialize recursion counter, which is stack-size-independent.
    let outcome = std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(|| {
            let registry = default_registry();
            let mut wb = Workbook::new();
            wb.add_sheet("S");
            let mut log = OpLog::new();
            log.append(nest(200))
                .expect("serialize/append has no recursion limit");

            let result = replay_into(&log, &mut wb, &registry);
            // Loud error, never a silent apply.
            assert!(
                result.is_err(),
                "a 200-deep nested batch must be rejected loudly, got {result:?}"
            );
            // Nothing committed (the failure precedes any inner-op apply).
            assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
        })
        .expect("spawn worker thread")
        .join();
    outcome.expect("worker overflowed/panicked — public replay path is NOT bounded");
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
