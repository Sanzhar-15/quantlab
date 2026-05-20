//! Phase 5.3 step 4 — concurrent RenameTable + RenameColumn replay
//! convergence. 2026-05-20.
//!
//! Mirrors `phase_5_3_step2_rename_concurrent.rs` (sheet rename) for
//! table + column renames. The pre-step-4 bug shape (from Opus step 1
//! audit MEDIUM-2): `apply_rename_table` (`replay.rs:691`) and
//! `apply_rename_column` (`replay.rs:749`) hard-fail under CRDT
//! merge of concurrent renames — same root cause as the RenameSheet
//! bug step 2 fixed.
//!
//! Post-step-4: replay applies "last-in-causal-order wins" +
//! D-2-style auto-disambiguation for target collisions (mirroring
//! step 2).

use ql_oplog::{replay_into, Op, OpLog};
use ql_storage::Workbook;

const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    log.set_peer_id(peer_id)
        .expect("set_peer_id with non-zero id must succeed");
    log
}

fn base_with_table(table_name: &str, col_names: Vec<String>) -> OpLog {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log.append(Op::CreateTable {
        name: table_name.to_owned(),
        sheet: 0,
        top_row: 0,
        top_col: 0,
        rows: 3,
        cols: col_names.len() as u32,
        has_header: true,
        has_totals: false,
        column_names: col_names,
    })
    .unwrap();
    log
}

fn replay_into_fresh(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    let reg = ql_functions::default_registry();
    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    wb
}

// ===== RenameTable: concurrent rename to different targets =====

/// **Step 4 PRIMARY for tables**: two peers concurrently rename the
/// same table T to different targets T2 vs T3. Pre-step-4 the second
/// op hard-failed with `TableNotFound`. Post-step-4: replay applies
/// the first rename, then idempotent-skips the second (current state
/// already doesn't match the second op's old_name).
#[test]
fn step4_concurrent_rename_table_different_targets_no_hard_fail() {
    let base = base_with_table("T", vec!["A".to_owned()])
        .export_bytes()
        .unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameTable {
            old_name: "T".to_owned(),
            new_name: "T2".to_owned(),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameTable {
            old_name: "T".to_owned(),
            new_name: "T3".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let wb_a = replay_into_fresh(&peer_a);

    // Replay didn't hard-fail. Exactly 1 table exists.
    assert_eq!(wb_a.tables().iter().count(), 1);
}

/// **Step 4 audit closure (Codex+Opus HIGH-1, 2026-05-20):**
/// cross-table target collision (different sources, same target).
/// Pre-audit-closure: auto-disambig produced {X, X(2)} but the
/// repair pass mis-handled the auto-disambig'd canonical, causing
/// silent formula corruption. Post-audit-closure: REVERTED to
/// hard-reject via `TableCreateRejected`. V1 limitation.
#[test]
fn step4_audit_cross_table_target_collision_hard_fails() {
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
            name: "T2".to_owned(),
            sheet: 0,
            top_row: 5,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            column_names: vec!["B".to_owned()],
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameTable {
            old_name: "T1".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameTable {
            old_name: "T2".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();

    // Replay must hard-fail with TableCreateRejected on the second
    // rename's target collision (V1 limitation, audit-closed).
    let mut wb = Workbook::new();
    let reg = ql_functions::default_registry();
    let result = replay_into(&peer_a, &mut wb, &reg);
    assert!(
        result.is_err(),
        "cross-source target collision must hard-fail post-audit-closure (V1 limitation)"
    );
}

// ===== RenameColumn: concurrent rename =====

/// **Step 4 for columns**: two peers concurrently rename the same
/// column to different targets. Pre-step-4 the second op hard-failed.
/// Post-step-4: idempotent skip.
#[test]
fn step4_concurrent_rename_column_different_targets_no_hard_fail() {
    let base = base_with_table("T", vec!["A".to_owned(), "B".to_owned()])
        .export_bytes()
        .unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "A".to_owned(),
            new_name: "Alpha".to_owned(),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "A".to_owned(),
            new_name: "Apple".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let wb = replay_into_fresh(&peer_a);

    // Replay didn't hard-fail. Column 0 has one of the renamed values
    // (whichever applied in causal order); col 1 = B (unchanged).
    let meta = wb.tables().lookup("T").unwrap();
    assert_eq!(meta.columns.len(), 2);
    let col0_display = meta.columns[0].display.as_ref();
    assert!(
        col0_display == "Alpha" || col0_display == "Apple",
        "col 0 display must be one of the concurrent targets; got {col0_display:?}"
    );
    assert_eq!(meta.columns[1].display.as_ref(), "B");
}

/// **Step 4 audit closure (Codex+Opus HIGH-2, 2026-05-20):**
/// cross-column target collision. Pre-audit-closure: auto-disambig
/// produced {Z, Z(2)} but no column repair pass landed → silent
/// formula-binding to wrong column. Post-audit-closure: REVERTED
/// to hard-reject. V1 limitation.
#[test]
fn step4_audit_cross_column_target_collision_hard_fails() {
    let base = base_with_table("T", vec!["A".to_owned(), "B".to_owned()])
        .export_bytes()
        .unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "A".to_owned(),
            new_name: "Z".to_owned(),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "B".to_owned(),
            new_name: "Z".to_owned(),
        })
        .unwrap();
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();

    let mut wb = Workbook::new();
    let reg = ql_functions::default_registry();
    let result = replay_into(&peer_a, &mut wb, &reg);
    assert!(
        result.is_err(),
        "cross-source column target collision must hard-fail post-audit-closure (V1 limitation)"
    );
}

/// **Step 4 regression baseline**: sequential rename (single-writer)
/// still works after the step-4 changes. Pre-existing functionality
/// must NOT break.
#[test]
fn step4_sequential_single_writer_table_rename_still_works() {
    let mut log = base_with_table("T", vec!["A".to_owned()]);
    log.append(Op::RenameTable {
        old_name: "T".to_owned(),
        new_name: "T2".to_owned(),
    })
    .unwrap();

    let wb = replay_into_fresh(&log);
    assert!(wb.tables().lookup("T").is_none());
    assert_eq!(
        wb.tables().lookup("T2").unwrap().display_name.as_ref(),
        "T2"
    );
}

#[test]
fn step4_sequential_single_writer_column_rename_still_works() {
    let mut log = base_with_table("T", vec!["A".to_owned(), "B".to_owned()]);
    log.append(Op::RenameColumn {
        table: "T".to_owned(),
        old_name: "A".to_owned(),
        new_name: "Alpha".to_owned(),
    })
    .unwrap();

    let wb = replay_into_fresh(&log);
    let meta = wb.tables().lookup("T").unwrap();
    assert_eq!(meta.columns[0].display.as_ref(), "Alpha");
    assert_eq!(meta.columns[1].display.as_ref(), "B");
}
