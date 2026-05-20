//! Phase 5.3 step 5b — `CollabSession::sync_workbook` integration tests.
//! 2026-05-20.
//!
//! Production-wiring closure for Opus-A Scenario E HIGH (step 5
//! megaudit): the repair pass exists since step 3 but had ZERO
//! non-test callers, so end-users running `merge_bytes` +
//! `replay_into` + `recompute` would STILL see `#NAME?` for
//! concurrent-rename formulas. `sync_workbook` atomically pairs
//! `replay_into` with the two repair passes per audit-locked D-5.3-1
//! caller contract.
//!
//! Coverage:
//! - Empty-log fast path → `SyncReport::default()`.
//! - Single-peer happy path: sync_workbook applies replay + reports.
//! - Two-peer concurrent RenameSheet + edit → sheet repair rewrites
//!   formula text (the canonical D-3 V1-limitation closure scenario).
//! - Two-peer concurrent RenameTable + table-ref formula → table
//!   repair rewrites.
//! - Error propagation: cross-source target collision (V1 limitation)
//!   produces `CollabSessionError::Replay`.

use ql_collab::{CollabSession, CollabSessionError, SyncReport};
use ql_functions::default_registry;
use ql_oplog::{CellWireValue, Op};
use ql_oplog::{OpLog, PeerId};
use ql_storage::Workbook;
use ql_types::Address;

const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

/// Produce a SHARED base log's snapshot bytes containing
/// `Op::AddSheet("S")` + a literal at S!A1 = 42.0. Both peers must
/// fork from the SAME bytes — otherwise each peer's base ops carry a
/// different Loro internal peer-id (`OpLog::new` is random by default)
/// and Loro treats the AddSheet ops as concurrent + distinct, firing
/// D-2 auto-rename on merge and breaking the test's assumption that
/// both peers operate on the same sheet 0. This is the per-step-1
/// audit closure pattern: "CRDT convergence requires stable non-zero
/// peer-ids" (`crdt-data-model.md` § Peer-id stability).
fn shared_base_bytes() -> Vec<u8> {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log.append(Op::PutValue {
        sheet: 0,
        row: 0,
        col: 0,
        value: CellWireValue::Number(42.0),
    })
    .unwrap();
    log.export_bytes().unwrap()
}

/// Build a fresh session at `peer_id` from the shared base bytes.
fn session_with_seed(peer_id: u64, base_bytes: &[u8]) -> CollabSession {
    CollabSession::from_snapshot(PeerId::new(peer_id), base_bytes).unwrap()
}

#[test]
fn sync_workbook_empty_log_fast_path_returns_default_report() {
    let session = CollabSession::new(PeerId::new(PEER_A_ID)).unwrap();
    let mut wb = Workbook::new();
    let reg = default_registry();
    let report = session.sync_workbook(&mut wb, &reg).unwrap();

    // Empty log → no ops replayed, no repairs.
    assert_eq!(report.ops_replayed, 0);
    assert_eq!(report.sheet_repair.formulas_rewritten, 0);
    assert_eq!(report.table_repair.formulas_rewritten, 0);
    // Workbook untouched.
    assert_eq!(wb.sheet_count(), 0);
}

#[test]
fn sync_workbook_single_peer_applies_replay() {
    let base = shared_base_bytes();
    let session = session_with_seed(PEER_A_ID, &base);
    let mut wb = Workbook::new();
    let reg = default_registry();
    let report = session.sync_workbook(&mut wb, &reg).unwrap();

    // 2 ops in the seed (AddSheet + PutValue).
    assert_eq!(report.ops_replayed, 2);
    // No rename ops, so both repair passes are no-ops.
    assert_eq!(report.sheet_repair.formulas_rewritten, 0);
    assert!(report.sheet_repair.sheet_rewrites.is_empty());
    assert_eq!(report.table_repair.formulas_rewritten, 0);
    // Workbook reflects replay state.
    assert_eq!(wb.sheet_count(), 1);
    assert_eq!(wb.sheet(0).unwrap().name(), "S");
    assert_eq!(
        wb.read(Address::new(0, 0, 0)),
        ql_types::Value::Number(42.0)
    );
}

/// **The canonical D-3 V1-limitation closure scenario.** Peer A
/// renames sheet "S" → "S2"; peer B concurrently writes a formula
/// `=S!A1` (referencing the old name). Without `sync_workbook`'s
/// repair invocation, the formula would surface as `#NAME?` after
/// recompute. With `sync_workbook`, the repair pass rewrites the
/// formula text to `=S2!A1` so recompute resolves correctly.
#[test]
fn sync_workbook_concurrent_rename_sheet_plus_edit_repair_fires() {
    // Both peers fork from the same shared base bytes (stable Loro
    // peer-id on the base ops).
    let base = shared_base_bytes();
    let mut session_a = session_with_seed(PEER_A_ID, &base);
    let mut session_b = session_with_seed(PEER_B_ID, &base);

    // Peer A renames S → S2.
    session_a
        .append_op(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();

    // Peer B (concurrent) writes a formula referencing the OLD name "S".
    session_b
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();

    // Merge into peer A's session.
    let b_bytes = session_b.export_bytes().unwrap();
    session_a.merge_bytes(&b_bytes).unwrap();

    // Rebuild the workbook through the wrapper.
    let mut wb = Workbook::new();
    let reg = default_registry();
    let report = session_a.sync_workbook(&mut wb, &reg).unwrap();

    // The repair pass fired on exactly the one formula peer B authored
    // against the pre-rename name.
    assert_eq!(
        report.sheet_repair.formulas_rewritten, 1,
        "exactly 1 formula must be rewritten by sheet repair"
    );
    assert!(
        !report.sheet_repair.sheet_rewrites.is_empty(),
        "sheet rewrite summary must be populated"
    );

    // Sheet is now named S2.
    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
    // Formula text was rewritten to reference the current name.
    let formula = wb.formula_at(0, 1, 0).map(|s| s.to_string());
    assert_eq!(
        formula,
        Some("S2!A1".to_string()),
        "formula text MUST be rewritten by repair pass (production wiring closure: H-S1)"
    );
}

/// **Table-rename analog of the sheet case.** Peer A creates a table T,
/// renames it T → T2; peer B writes a formula referencing T's old name.
/// Repair must rewrite to T2.
#[test]
fn sync_workbook_concurrent_rename_table_plus_edit_repair_fires() {
    // Base log: sheet S + table T (2x2, 1 col header).
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::CreateTable {
            name: "T".to_owned(),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["A".to_owned()],
        })
        .unwrap();
    let base_bytes = base_log.export_bytes().unwrap();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();

    // Peer A renames T → T2.
    session_a
        .append_op(Op::RenameTable {
            old_name: "T".to_owned(),
            new_name: "T2".to_owned(),
        })
        .unwrap();

    // Peer B writes a formula referencing T's old name.
    session_b
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 5,
            col: 5,
            text: "T[A]".to_owned(),
        })
        .unwrap();

    let b_bytes = session_b.export_bytes().unwrap();
    session_a.merge_bytes(&b_bytes).unwrap();

    let mut wb = Workbook::new();
    let reg = default_registry();
    let report = session_a.sync_workbook(&mut wb, &reg).unwrap();

    assert_eq!(
        report.table_repair.formulas_rewritten, 1,
        "exactly 1 formula must be rewritten by table repair"
    );
    // Table renamed; formula rewritten.
    assert!(wb.tables().lookup("T").is_none(), "T no longer present");
    assert!(wb.tables().lookup("T2").is_some(), "T2 present post-rename");
    let formula = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    assert_eq!(
        formula,
        Some("T2[A]".to_string()),
        "table-ref formula text MUST be rewritten by repair pass"
    );
}

/// **Error propagation:** the V1 cross-source target collision
/// limitation makes `replay_into` hard-fail. `sync_workbook` should
/// surface the error as `CollabSessionError::Replay`.
#[test]
fn sync_workbook_replay_error_surfaces_via_session_error_variant() {
    // Build a log that triggers cross-source target collision:
    // base has 2 tables T1 + T3; one peer renames T1→X, another T3→X.
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::CreateTable {
            name: "T1".to_owned(),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["A".to_owned()],
        })
        .unwrap();
    base_log
        .append(Op::CreateTable {
            name: "T3".to_owned(),
            sheet: 0,
            top_row: 5,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["A".to_owned()],
        })
        .unwrap();
    let base_bytes = base_log.export_bytes().unwrap();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();

    session_a
        .append_op(Op::RenameTable {
            old_name: "T1".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    session_b
        .append_op(Op::RenameTable {
            old_name: "T3".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();

    let b_bytes = session_b.export_bytes().unwrap();
    session_a.merge_bytes(&b_bytes).unwrap();

    let mut wb = Workbook::new();
    let reg = default_registry();
    let result: Result<SyncReport, CollabSessionError> = session_a.sync_workbook(&mut wb, &reg);
    assert!(
        matches!(result, Err(CollabSessionError::Replay(_))),
        "expected CollabSessionError::Replay; got {result:?}"
    );
    // Per replay_into's caller contract (Phase 5.3 step 5 megaudit
    // closure), the workbook is now in a HALF-MERGED state. The
    // caller MUST discard it. We don't assert anything about wb's
    // state here — that would lock in the partial-state contract by
    // accident.
}
