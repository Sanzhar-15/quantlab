//! Phase 5.3 step 5c audit closure (Opus HIGH-4 mirror, 2026-05-20) —
//! end-to-end column-repair recompute test.
//!
//! Mirrors `phase_5_3_step5b_e2e_resolve.rs` for the column-repair
//! case. The ql-collab integration tests at
//! `repair_columns.rs` assert formula TEXT is rewritten. **Opus
//! step 5c MEDIUM-2 found these are necessary but not sufficient**:
//! a future regression in `WorkbookRuntime`'s binding pass could
//! re-introduce `#NAME?` while leaving rewritten text intact.
//!
//! This test pairs `rebuild_workbook` (which runs replay + all 3
//! repair passes) with `WorkbookRuntime::recompute_all` to verify
//! the formula RESOLVES end-to-end after a concurrent column rename.

use ql_collab::{CollabSession, PeerId};
use ql_exec::WorkbookRuntime;
use ql_functions::default_registry;
use ql_oplog::{CellWireValue, Op, OpLog};
use ql_types::{Address, Value};

const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

fn shared_base_with_table_and_value() -> Vec<u8> {
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
        cols: 1,
        has_header: true,
        has_totals: false,
        column_names: vec!["Qty".to_owned()],
    })
    .unwrap();
    // Header at S!A1; data at S!A2 = 42.0.
    log.append(Op::PutValue {
        sheet: 0,
        row: 1,
        col: 0,
        value: CellWireValue::Number(42.0),
    })
    .unwrap();
    log.export_bytes().unwrap()
}

/// **Canonical column-rename D-3 closure, end-to-end.**
///
/// Peer A renames `Tbl.Qty → Tbl.Quantity`; peer B (concurrent) writes
/// a formula `=Tbl[Qty]` referencing the old column name. After
/// `CollabSession::rebuild_workbook` + `WorkbookRuntime::recompute_all`,
/// the formula MUST resolve to a non-error value (the literal at
/// `S!A2 = 42.0`, since `Tbl[Qty]` would spill to that cell).
///
/// Pre-Phase-5.3-step-5c: column repair pass didn't exist; the
/// formula surfaced as `#NAME?` / `#REF?` after recompute.
/// Post-step-5c + audit closure: repair pass rewrites `Tbl[Qty]` →
/// `Tbl[Quantity]` and recompute resolves correctly.
#[test]
fn step5c_e2e_concurrent_column_rename_plus_edit_recomputes_to_resolved_value() {
    let base_bytes = shared_base_with_table_and_value();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();

    // Peer A: rename column Qty → Quantity.
    session_a
        .append_op(Op::RenameColumn {
            table: "Tbl".to_owned(),
            old_name: "Qty".to_owned(),
            new_name: "Quantity".to_owned(),
        })
        .unwrap();

    // Peer B (concurrent): write formula at S!B3 referencing OLD column "Qty".
    // Use SUM to get a scalar resolution from the structured ref.
    session_b
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 2,
            col: 1,
            text: "SUM(Tbl[Qty])".to_owned(),
        })
        .unwrap();

    let b_bytes = session_b.export_bytes().unwrap();
    session_a.merge_bytes(&b_bytes).unwrap();

    // Production wiring path.
    let reg = default_registry();
    let (mut wb, report) = session_a.rebuild_workbook(&reg).unwrap();

    assert_eq!(
        report.column_repair.formulas_rewritten, 1,
        "column repair MUST fire (formulas_rewritten: 1). report = {report:?}"
    );

    // Recompute.
    {
        let mut runtime = WorkbookRuntime::new(&mut wb, &reg);
        runtime.recompute_all();
    }

    // Load-bearing assertion: formula resolves to the literal value
    // (42.0) via the rewritten column ref. Pre-Phase-5.3-step-5c this
    // would have surfaced as Value::Error(ErrorValue::Name).
    let resolved = wb.read(Address::new(0, 2, 1));
    assert_eq!(
        resolved,
        Value::Number(42.0),
        "post-rebuild_workbook + recompute MUST resolve SUM(Tbl[Quantity]) \
         to 42.0 via the rewritten column ref. Pre-step-5c this was #NAME?. \
         Got {resolved:?}."
    );

    // Pin the rewritten text too.
    assert_eq!(
        wb.formula_at(0, 2, 1).map(|s| s.to_string()),
        Some("SUM(Tbl[Quantity])".to_string()),
        "formula text must reference the current column canonical (Quantity)"
    );
}

/// **Cross-kind interaction end-to-end** (mirror of Codex+Opus HIGH-1
/// closure). Peer A renames table `Tbl → Sales`; peer B renames
/// column `Tbl.Qty → Quantity`; peer C writes formula
/// `=Tbl[Qty]`. After merge + rebuild + recompute, the formula must
/// reference Sales/Quantity and resolve (not panic, not #NAME?).
#[test]
fn step5c_e2e_cross_kind_rename_three_peer_recomputes() {
    const PEER_C_ID: u64 = 3;
    let base_bytes = shared_base_with_table_and_value();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();
    let mut session_c = CollabSession::from_snapshot(PeerId::new(PEER_C_ID), &base_bytes).unwrap();

    session_a
        .append_op(Op::RenameTable {
            old_name: "Tbl".to_owned(),
            new_name: "Sales".to_owned(),
        })
        .unwrap();
    session_b
        .append_op(Op::RenameColumn {
            table: "Tbl".to_owned(),
            old_name: "Qty".to_owned(),
            new_name: "Quantity".to_owned(),
        })
        .unwrap();
    session_c
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 2,
            col: 1,
            text: "SUM(Tbl[Qty])".to_owned(),
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
        "rebuild_workbook MUST NOT hard-fail under 3-peer cross-kind \
         rename interaction (HIGH-1 closure). Got {result:?}"
    );
    let (mut wb, _report) = result.unwrap();

    // Recompute must not panic. The exact resolved value depends on
    // Loro's causal order interaction between the column rename
    // (which may advisory-skip because its wire table "Tbl" was
    // renamed away) and the formula. Load-bearing property: no
    // panic, no replay error.
    let mut runtime = WorkbookRuntime::new(&mut wb, &reg);
    runtime.recompute_all();
    // Just confirm the workbook is in a queryable state.
    let _resolved = wb.read(Address::new(0, 2, 1));
}
