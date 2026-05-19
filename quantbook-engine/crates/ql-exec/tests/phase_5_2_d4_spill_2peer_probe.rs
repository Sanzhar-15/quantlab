//! Phase 5.2 D-4 probe test — spill semantics survive 2-peer CRDT merge.
//!
//! Phase 5.1 audit Opus M-2 + Codex V3 closure: design claims that
//! spill blocking semantics are order-independent under CRDT merge
//! because:
//!
//! 1. Replay stores formula text per `Op::PutFormula` (no
//!    materialization at replay time).
//! 2. `recompute_all` is called ONCE post-replay against the final
//!    merged workbook state.
//! 3. `write_spill` (`cells.rs:669`) blocks on occupied target
//!    cells — irrespective of which op was logged "first."
//!
//! This probe verifies the claim end-to-end. Two peers concurrently
//! edit: peer A writes `=SEQUENCE(3)` at A1 (would spill to A1:A3);
//! peer B writes literal `5` at A2. After merging both peers' op
//! logs via Loro's CRDT and replaying + recomputing, A1 emits
//! `#SPILL!` because A2 is occupied. The same outcome must hold for
//! BOTH peer-export orderings (A merges B's bytes; OR B merges A's
//! bytes) — this is the order-independence claim.
//!
//! New `OpLog::merge_bytes` API added in this commit; this is the
//! first test that exercises it.

use ql_exec::WorkbookRuntime;
use ql_functions::default_registry;
use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
use ql_storage::Workbook;
use ql_types::{Address, ErrorValue, Value};

/// Build a base op log carrying just `AddSheet("S")`. Both peers
/// fork from this to share a common causal ancestor.
fn shared_base_log() -> OpLog {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log
}

/// Helper: replay a log into a fresh workbook + recompute. Returns
/// the workbook ready for assertions.
fn replay_and_recompute(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    let reg = default_registry();
    replay_into(log, &mut wb, &reg).expect("replay should succeed");
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.recompute_all();
    }
    wb
}

/// **Peer A merges peer B's bytes.** After merge, peer A's log
/// contains both ops in deterministic causal order. Replay +
/// recompute → A1 emits `#SPILL!` (A2 occupied), A2 keeps `5`.
#[test]
fn d4_spill_blocking_survives_a_merges_b() {
    let base_bytes = shared_base_log().export_bytes().unwrap();

    // Peer A: fork from base + write the spilling formula.
    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
    peer_a
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "SEQUENCE(3)".to_owned(),
        })
        .unwrap();

    // Peer B: fork from base + write the blocking literal at A2.
    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
    peer_b
        .append(Op::PutValue {
            sheet: 0,
            row: 1,
            col: 0,
            value: CellWireValue::Number(5.0),
        })
        .unwrap();

    // Peer A merges peer B's bytes (Phase 5.5 will do this via the
    // transport layer; the test uses the export/merge API directly).
    let b_bytes = peer_b.export_bytes().unwrap();
    peer_a.merge_bytes(&b_bytes).unwrap();
    assert!(
        peer_a.len() >= 3,
        "merged log must contain at least AddSheet + PutFormula + PutValue"
    );

    let merged_wb = replay_and_recompute(&peer_a);

    assert_eq!(
        merged_wb.read(Address::new(0, 0, 0)),
        Value::Error(ErrorValue::Spill),
        "A1 must emit #SPILL! when A2 is occupied (recompute_all detects \
         the spill block regardless of which op was logged first)"
    );
    assert_eq!(
        merged_wb.read(Address::new(0, 1, 0)),
        Value::Number(5.0),
        "A2 retains its literal value 5"
    );
}

/// **Peer B merges peer A's bytes.** The CRDT-determinism claim:
/// outcome MUST be identical to `d4_spill_blocking_survives_a_merges_b`
/// regardless of which peer initiates the merge. Verifies
/// order-independence of the merge direction.
#[test]
fn d4_spill_blocking_survives_b_merges_a() {
    let base_bytes = shared_base_log().export_bytes().unwrap();

    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
    peer_a
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "SEQUENCE(3)".to_owned(),
        })
        .unwrap();

    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
    peer_b
        .append(Op::PutValue {
            sheet: 0,
            row: 1,
            col: 0,
            value: CellWireValue::Number(5.0),
        })
        .unwrap();

    // Reverse merge direction: peer B pulls peer A's bytes.
    let a_bytes = peer_a.export_bytes().unwrap();
    peer_b.merge_bytes(&a_bytes).unwrap();

    let merged_wb = replay_and_recompute(&peer_b);

    assert_eq!(
        merged_wb.read(Address::new(0, 0, 0)),
        Value::Error(ErrorValue::Spill),
        "merge direction is irrelevant — A1 still emits #SPILL!"
    );
    assert_eq!(
        merged_wb.read(Address::new(0, 1, 0)),
        Value::Number(5.0),
        "A2 retains 5 under reverse merge too"
    );
}

/// **No collision case.** If peer B writes at a NON-spill-footprint
/// cell (e.g. A5 outside the SEQUENCE(3) target A1:A3), the spill
/// succeeds — A1:A3 materialize with 1, 2, 3; A5 keeps its literal.
/// This is the order-independence claim's "happy path" complement.
#[test]
fn d4_spill_succeeds_when_concurrent_op_outside_footprint() {
    let base_bytes = shared_base_log().export_bytes().unwrap();

    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
    peer_a
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "SEQUENCE(3)".to_owned(),
        })
        .unwrap();

    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
    peer_b
        .append(Op::PutValue {
            sheet: 0,
            row: 4,
            col: 0, // A5, outside the SEQUENCE(3) footprint A1:A3
            value: CellWireValue::Number(99.0),
        })
        .unwrap();

    let b_bytes = peer_b.export_bytes().unwrap();
    peer_a.merge_bytes(&b_bytes).unwrap();

    let merged_wb = replay_and_recompute(&peer_a);

    // Spill materialized: A1=1, A2=2, A3=3.
    assert_eq!(merged_wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
    assert_eq!(merged_wb.read(Address::new(0, 1, 0)), Value::Number(2.0));
    assert_eq!(merged_wb.read(Address::new(0, 2, 0)), Value::Number(3.0));
    // A5 keeps peer B's value.
    assert_eq!(merged_wb.read(Address::new(0, 4, 0)), Value::Number(99.0));
}

/// **Determinism across re-merge.** Replay an export of the merged
/// log a SECOND time on a fresh workbook — the outcome must be
/// byte-identical to the first replay. This pins the "deterministic
/// replay" claim from the design doc.
#[test]
fn d4_replay_of_merged_log_is_deterministic_across_runs() {
    let base_bytes = shared_base_log().export_bytes().unwrap();

    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
    peer_a
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "SEQUENCE(3)".to_owned(),
        })
        .unwrap();

    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
    peer_b
        .append(Op::PutValue {
            sheet: 0,
            row: 1,
            col: 0,
            value: CellWireValue::Number(5.0),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();

    let wb_first = replay_and_recompute(&peer_a);

    // Round-trip the merged log through export/import (simulates
    // saving + reloading the merged state) and replay again.
    let merged_bytes = peer_a.export_bytes().unwrap();
    let reloaded = OpLog::import_bytes(&merged_bytes).unwrap();
    let wb_second = replay_and_recompute(&reloaded);

    // Same cell values across both runs.
    for (row, col) in [(0, 0), (1, 0), (2, 0)] {
        assert_eq!(
            wb_first.read(Address::new(0, row, col)),
            wb_second.read(Address::new(0, row, col)),
            "cell ({row},{col}) must match across replays"
        );
    }
}
