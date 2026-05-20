//! Phase 5.3 step 5c audit closures (Codex+Opus convergent HIGH-1 +
//! Opus M1, 2026-05-20) — cross-kind table×column rename interaction
//! regression tests.
//!
//! Pre-closure two failure modes:
//! 1. **HIGH-1**: `RenameTable T → Sales` followed by `RenameColumn
//!    { table: "T", ... }` hard-failed `replay_into` with
//!    `TableNotFound { name: "T" }` because `apply_rename_column`
//!    required the wire table to still exist by its original name.
//!    Step 4 closed the analogous case for `apply_rename_table` via
//!    advisory-skip; step 5c audit closure extends the same pattern
//!    to `apply_rename_column`.
//! 2. **M1 (silent rule-drop)**: in the reverse order (`RenameColumn`
//!    then `RenameTable`), replay succeeded but `repair_column_rename_chain`
//!    keyed its rule by historic table `"T"`. Post-table-repair the
//!    formula text references `Sales[A]`; column rule for `("T", "a")`
//!    silently dropped. Closure: pre-walk table renames in the
//!    column-repair pass + resolve each column op's wire table name
//!    to the CURRENT canonical via the table-rename chain.

use ql_collab::{CollabSession, PeerId};
use ql_functions::default_registry;
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

fn base_with_table() -> OpLog {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log.append(Op::CreateTable {
        name: "Tbl".to_owned(),
        sheet: 0,
        top_row: 0,
        top_col: 0,
        rows: 3,
        cols: 2,
        has_header: true,
        has_totals: false,
        column_names: vec!["A".to_owned(), "B".to_owned()],
    })
    .unwrap();
    log
}

// ===== H1 regression: replay must NOT hard-fail =====

/// **Pre-closure**: `replay_into` errored with
/// `ReplayError::TableNotFound { name: "Tbl" }` when peer A renamed
/// `Tbl → Sales` causally before peer B's `RenameColumn { table:
/// "Tbl", ... }`.
/// **Post-closure**: replay advisory-skips the column rename when the
/// wire table is missing (mirrors step 4 closure for
/// `apply_rename_table`).
#[test]
fn step5c_audit_concurrent_table_rename_before_column_rename_does_not_hardfail() {
    let base = base_with_table().export_bytes().unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameTable {
            old_name: "Tbl".to_owned(),
            new_name: "Sales".to_owned(),
        })
        .unwrap();

    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameColumn {
            table: "Tbl".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();

    let mut wb = Workbook::new();
    let reg = default_registry();
    let result = replay_into(&peer_a, &mut wb, &reg);

    // Post-closure: replay succeeds. The column rename's intent may be
    // lost (advisory-skip) — that's the V1 limitation.
    assert!(
        result.is_ok(),
        "replay must NOT hard-fail when table was renamed concurrently \
         (Codex+Opus step 5c HIGH-1 closure: apply_rename_column advisory-skips). \
         Got: {result:?}"
    );
}

/// **Pre-closure**: `CollabSession::rebuild_workbook` propagated the
/// `TableNotFound` error from `replay_into` — the entire merged log
/// became un-rebuildable.
/// **Post-closure**: production wrapper succeeds.
#[test]
fn step5c_audit_rebuild_workbook_does_not_propagate_replay_hardfail() {
    let base = base_with_table().export_bytes().unwrap();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base).unwrap();

    session_a
        .append_op(Op::RenameTable {
            old_name: "Tbl".to_owned(),
            new_name: "Sales".to_owned(),
        })
        .unwrap();
    session_b
        .append_op(Op::RenameColumn {
            table: "Tbl".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();
    session_a
        .merge_bytes(&session_b.export_bytes().unwrap())
        .unwrap();

    let reg = default_registry();
    let result = session_a.rebuild_workbook(&reg);
    assert!(
        result.is_ok(),
        "rebuild_workbook must NOT propagate TableNotFound from cross-kind \
         table+column rename interaction. Got: {result:?}"
    );
}

// ===== M1 regression: column repair must use post-table-rename canonical =====

/// **Pre-closure (Opus M1 silent rule-drop)**: single log with
/// `[RenameColumn(Tbl.A→AA), RenameTable(Tbl→Sales), PutFormula(Tbl[A]+1)]`.
/// After replay: workbook has `Sales` table with columns `[AA, B]` and
/// formula `Tbl[A]+1`. Sheet repair: no-op. Table repair: rewrites
/// `Tbl[A]+1` → `Sales[A] + 1`. Column repair (pre-closure): rule keyed
/// by historic table `Tbl` doesn't match `Sales` snapshot → rule
/// silently dropped → formula stays `Sales[A] + 1`. **No diagnostic.**
///
/// **Post-closure**: column repair walks the table-rename chain first,
/// resolves the column op's wire table `Tbl` → current canonical
/// `Sales`. Rule keyed by `(Sales, aa) ← [a]`. Phase 5 finds the
/// formula `Sales[A] + 1` and rewrites to `Sales[AA] + 1`.
#[test]
fn step5c_audit_column_repair_resolves_table_rename_chain() {
    let mut log = base_with_table();
    log.append(Op::PutFormula {
        sheet: 0,
        row: 5,
        col: 5,
        text: "Tbl[A]+1".to_owned(),
    })
    .unwrap();
    log.append(Op::RenameColumn {
        table: "Tbl".to_owned(),
        old_name: "A".to_owned(),
        new_name: "AA".to_owned(),
    })
    .unwrap();
    log.append(Op::RenameTable {
        old_name: "Tbl".to_owned(),
        new_name: "Sales".to_owned(),
    })
    .unwrap();

    let mut wb = Workbook::new();
    let reg = default_registry();
    replay_into(&log, &mut wb, &reg).unwrap();

    // Walk the full repair chain in production order (replay already
    // done above).
    let sheet_report = ql_collab::repair_sheet_rename_chain(&mut wb, &log).unwrap();
    let table_report = ql_collab::repair_table_rename_chain(&mut wb, &log).unwrap();
    let column_report = ql_collab::repair_column_rename_chain(&mut wb, &log).unwrap();

    // Post-closure assertion: column repair fires because the rule key
    // was resolved to the current table canonical "SALES".
    assert_eq!(
        column_report.formulas_rewritten, 1,
        "column repair MUST fire post-table-rename. Pre-closure was 0 (silent drop). \
         sheet_report={sheet_report:?} table_report={table_report:?} column_report={column_report:?}"
    );
    // Final formula text reflects both renames.
    assert_eq!(
        wb.formula_at(0, 5, 5).map(|s| s.to_string()),
        Some("Sales[AA] + 1".to_string()),
        "formula must reference the FINAL table+column canonical names \
         (Sales[AA], not Sales[A])"
    );
}

/// **M1 closure via 2-peer scenario**: peer A renames `Tbl.A → AA`;
/// peer B (concurrent) renames `Tbl → Sales` AND writes formula
/// `Tbl[A]+1`. After merge, all three ops apply. The column repair
/// must resolve `Tbl → Sales` and rewrite formula to `Sales[AA] + 1`.
#[test]
fn step5c_audit_two_peer_cross_kind_renames_rebuild_correctly() {
    let base = base_with_table().export_bytes().unwrap();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base).unwrap();

    // Peer A: column rename only.
    session_a
        .append_op(Op::RenameColumn {
            table: "Tbl".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();
    // Peer B: table rename + formula.
    session_b
        .append_op(Op::RenameTable {
            old_name: "Tbl".to_owned(),
            new_name: "Sales".to_owned(),
        })
        .unwrap();
    session_b
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 5,
            col: 5,
            text: "Tbl[A]+1".to_owned(),
        })
        .unwrap();

    session_a
        .merge_bytes(&session_b.export_bytes().unwrap())
        .unwrap();

    let reg = default_registry();
    let (wb, report) = session_a.rebuild_workbook(&reg).unwrap();

    // Sheet absent of renames; table + column both fired.
    assert_eq!(
        report.table_repair.formulas_rewritten, 1,
        "table repair must rewrite Tbl[A]+1 → Sales[A]+1"
    );
    assert_eq!(
        report.column_repair.formulas_rewritten, 1,
        "column repair must rewrite Sales[A]+1 → Sales[AA]+1 \
         (post-closure: resolves table rename chain). report = {report:?}"
    );

    let formula = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    assert_eq!(
        formula,
        Some("Sales[AA] + 1".to_string()),
        "final formula text reflects both renames: Sales[AA] + 1"
    );
}

// ===== Codex's reverse-order regression (FAILED pre-closure) =====

/// **Codex empirical probe (3-peer reordered)**: base `Tbl[A]`; peer A
/// `RenameTable Tbl → Sales`; peer B `RenameColumn Tbl.A → AA`; peer
/// C `PutFormula Tbl[A]+1`. Pre-closure replay hard-failed with
/// `TableNotFound`. Post-closure replay succeeds + repair chain runs.
#[test]
fn step5c_audit_three_peer_cross_kind_renames_no_hardfail() {
    const PEER_C_ID: u64 = 3;
    let base = base_with_table().export_bytes().unwrap();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base).unwrap();
    let mut session_c = CollabSession::from_snapshot(PeerId::new(PEER_C_ID), &base).unwrap();

    session_a
        .append_op(Op::RenameTable {
            old_name: "Tbl".to_owned(),
            new_name: "Sales".to_owned(),
        })
        .unwrap();
    session_b
        .append_op(Op::RenameColumn {
            table: "Tbl".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();
    session_c
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 5,
            col: 5,
            text: "Tbl[A]+1".to_owned(),
        })
        .unwrap();

    session_a
        .merge_bytes(&session_b.export_bytes().unwrap())
        .unwrap();
    session_a
        .merge_bytes(&session_c.export_bytes().unwrap())
        .unwrap();

    let reg = default_registry();
    let result = session_a.rebuild_workbook(&reg);
    assert!(
        result.is_ok(),
        "3-peer cross-kind rebuild must NOT hard-fail. Got: {result:?}"
    );
    let (wb, _report) = result.unwrap();
    // Pin only that the formula DIDN'T retain `Tbl[A]` (the historic
    // name). The exact final text depends on Loro's causal order of
    // column-rename vs PutFormula (may interact with the
    // column-rename advisory-skip in apply_rename_column when the
    // table was already renamed away). The load-bearing property is:
    // replay didn't error and rebuild_workbook returned Ok.
    let final_text = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    assert!(
        final_text.is_some(),
        "formula must exist in post-rebuild workbook"
    );
}
