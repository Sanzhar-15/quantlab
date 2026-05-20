//! Phase 5.3 step 5b — `CollabSession::rebuild_workbook` integration
//! tests. 2026-05-20.
//!
//! Production-wiring closure for Opus-A Scenario E HIGH (step 5
//! megaudit) plus step 5b audit closures (Codex MEDIUM-1, Opus HIGH-2,
//! Opus HIGH-3): the repair pass exists since step 3 but had ZERO
//! non-test callers, so end-users running `merge_bytes` plus
//! `replay_into` plus `recompute` would STILL see `#NAME?` for
//! concurrent-rename formulas. `rebuild_workbook` constructs a fresh
//! `Workbook::new()` internally and atomically chains `replay_into`
//! and the two repair passes per audit-locked D-5.3-1 caller contract.
//!
//! The API was reshaped from the original `sync_workbook(&mut Workbook, ..)`
//! signature to eliminate the caller-misuse class (double-invocation,
//! stale-workbook-from-other-log, empty-log fast-path-on-populated-workbook
//! — all empirically demonstrated by step 5b Opus audit probes P1, P9,
//! P10). The new signature returns `(Workbook, SyncReport)` — caller
//! can't pass a stale workbook because the API doesn't accept one.
//!
//! Coverage:
//! - Empty-log fast path → fresh `Workbook::new()` + `SyncReport::default()`.
//! - Single-peer happy path.
//! - Canonical D-3 V1-limitation closure (sheet rename + concurrent edit).
//! - Table-rename analog.
//! - Error propagation: cross-source target collision (V1 limitation)
//!   produces `CollabSessionError::Replay`; the partially-replayed
//!   workbook is dropped by the wrapper (caller never sees it).
//! - Display impl for `SyncReport` (Opus step 5b audit MEDIUM-2 closure).

use ql_collab::{CollabSession, CollabSessionError, SyncReport};
use ql_functions::default_registry;
use ql_oplog::{CellWireValue, Op};
use ql_oplog::{OpLog, PeerId};
use ql_types::Address;

const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

/// Produce a SHARED base log's snapshot bytes containing
/// `Op::AddSheet("S")` + a literal at S!A1 = 42.0. Both peers must
/// fork from the SAME bytes — otherwise each peer's base ops carry a
/// different Loro internal peer-id (`OpLog::new` is random by default)
/// and Loro treats the AddSheet ops as concurrent + distinct, firing
/// D-2 auto-rename on merge. This is the per-step-1 audit closure
/// pattern: "CRDT convergence requires stable non-zero peer-ids"
/// (`crdt-data-model.md` § Peer-id stability).
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
fn rebuild_workbook_empty_log_returns_fresh_workbook_and_default_report() {
    let session = CollabSession::new(PeerId::new(PEER_A_ID)).unwrap();
    let reg = default_registry();
    let (wb, report) = session.rebuild_workbook(&reg).unwrap();

    // Empty log → fresh empty workbook + default report.
    assert_eq!(report.ops_replayed, 0);
    assert_eq!(report.sheet_repair.formulas_rewritten, 0);
    assert_eq!(report.table_repair.formulas_rewritten, 0);
    // Workbook IS fresh — wrapper constructs it internally (Opus HIGH-3 closure).
    assert_eq!(wb.sheet_count(), 0);
}

#[test]
fn rebuild_workbook_single_peer_applies_replay() {
    let base = shared_base_bytes();
    let session = session_with_seed(PEER_A_ID, &base);
    let reg = default_registry();
    let (wb, report) = session.rebuild_workbook(&reg).unwrap();

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
/// `=S!A1` (referencing the old name). Without the repair pass, the
/// formula surfaces as `#NAME?` after recompute. With
/// `rebuild_workbook`, the repair pass rewrites the formula text to
/// `S2!A1` so recompute resolves correctly. The end-to-end recompute
/// verification lives in `crates/ql-exec/tests/phase_5_3_step5b_e2e_resolve.rs`
/// (Opus step 5b HIGH-4 closure — text rewrite alone is necessary but
/// not sufficient).
#[test]
fn rebuild_workbook_concurrent_rename_sheet_plus_edit_repair_fires() {
    let base = shared_base_bytes();
    let mut session_a = session_with_seed(PEER_A_ID, &base);
    let mut session_b = session_with_seed(PEER_B_ID, &base);

    session_a
        .append_op(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();

    session_b
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();

    let b_bytes = session_b.export_bytes().unwrap();
    session_a.merge_bytes(&b_bytes).unwrap();

    let reg = default_registry();
    let (wb, report) = session_a.rebuild_workbook(&reg).unwrap();

    assert_eq!(
        report.sheet_repair.formulas_rewritten, 1,
        "exactly 1 formula must be rewritten by sheet repair"
    );
    assert!(
        !report.sheet_repair.sheet_rewrites.is_empty(),
        "sheet rewrite summary must be populated"
    );

    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
    let formula = wb.formula_at(0, 1, 0).map(|s| s.to_string());
    assert_eq!(
        formula,
        Some("S2!A1".to_string()),
        "formula text MUST be rewritten by repair pass (production wiring closure: H-S1)"
    );
}

/// **Table-rename analog of the sheet case.**
#[test]
fn rebuild_workbook_concurrent_rename_table_plus_edit_repair_fires() {
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

    session_a
        .append_op(Op::RenameTable {
            old_name: "T".to_owned(),
            new_name: "T2".to_owned(),
        })
        .unwrap();
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

    let reg = default_registry();
    let (wb, report) = session_a.rebuild_workbook(&reg).unwrap();

    assert_eq!(report.table_repair.formulas_rewritten, 1);
    assert!(wb.tables().lookup("T").is_none());
    assert!(wb.tables().lookup("T2").is_some());
    let formula = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    assert_eq!(formula, Some("T2[A]".to_string()));
}

/// **Error propagation:** cross-source target collision (V1 limitation)
/// fires `replay_into` → `Err(TableCreateRejected)`. The wrapper drops
/// the partially-replayed workbook before returning the error (caller
/// never observes the half-merged state — Opus step 5b HIGH-2 closure
/// via API reshape: workbook is owned by the wrapper, dropped at scope
/// exit).
///
/// **Audit closure (Opus MEDIUM-4):** also documents that the
/// underlying `ReplayError` is preserved via `#[source]` for callers
/// that want to extract the op index.
#[test]
fn rebuild_workbook_replay_error_surfaces_via_session_error_variant() {
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

    let reg = default_registry();
    let result: Result<(ql_storage::Workbook, SyncReport), CollabSessionError> =
        session_a.rebuild_workbook(&reg);
    assert!(
        matches!(result, Err(CollabSessionError::Replay(_))),
        "expected CollabSessionError::Replay; got {result:?}"
    );
    // The half-merged workbook was constructed + dropped inside the
    // wrapper — caller never observes it. This is the API-reshape
    // closure for Opus step 5b HIGH-2 (double-call corruption is now
    // impossible because each call produces a NEW workbook).
}

/// **Audit closure (Opus step 5b MEDIUM-2 + LOW-4):** `SyncReport`'s
/// `Display` impl produces a one-line diagnostic string suitable for
/// `log::info!`. Pin the format.
#[test]
fn sync_report_display_emits_one_line_diagnostic() {
    let base = shared_base_bytes();
    let mut session_a = session_with_seed(PEER_A_ID, &base);
    let mut session_b = session_with_seed(PEER_B_ID, &base);
    session_a
        .append_op(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    session_b
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();
    let b_bytes = session_b.export_bytes().unwrap();
    session_a.merge_bytes(&b_bytes).unwrap();

    let reg = default_registry();
    let (_wb, report) = session_a.rebuild_workbook(&reg).unwrap();

    let line = format!("{report}");
    // Pin the format: must be one line + must include all 4 counters
    // (ops, sheet_rewrites, sheet_skipped, table_rewrites, table_skipped).
    assert!(
        !line.contains('\n'),
        "Display must be one line; got {line:?}"
    );
    assert!(line.starts_with("sync: ops="));
    assert!(line.contains("sheet_rewrites="));
    assert!(line.contains("table_rewrites="));
    assert!(line.contains("skip="));
}
