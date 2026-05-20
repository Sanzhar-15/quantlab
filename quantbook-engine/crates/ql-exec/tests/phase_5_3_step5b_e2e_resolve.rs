//! Phase 5.3 step 5b audit closure (Opus HIGH-4, 2026-05-20) —
//! end-to-end resolution verification for `CollabSession::rebuild_workbook`.
//!
//! The Phase 5.3 step 5b ship landed the production-wiring closure
//! (`rebuild_workbook` chains `replay_into` + sheet repair + table
//! repair). The integration tests in `crates/ql-collab/tests/rebuild_workbook.rs`
//! assert formula TEXT is rewritten correctly. **Opus step 5b HIGH-4
//! found that text-rewrite is necessary but not sufficient**: a future
//! regression in `WorkbookRuntime`'s binding pass (e.g., case-folding
//! bug, sheet-name lookup) could re-introduce `#NAME?` while leaving
//! the rewritten text intact. The ql-collab tests would still pass.
//!
//! This test lives in ql-exec because it needs `WorkbookRuntime::recompute_all`.
//! ql-exec already has `ql-collab` as a dev-dep (added in Phase 5.3
//! step 3 for the row 7 conflict-matrix probe). Pairs the
//! `rebuild_workbook` wrapper with `recompute_all` to verify the
//! formula RESOLVES to the correct value end-to-end.

use ql_collab::CollabSession;
use ql_exec::WorkbookRuntime;
use ql_functions::default_registry;
use ql_oplog::{CellWireValue, Op, OpLog, PeerId};
use ql_types::{Address, Value};

const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

/// Build a shared base log carrying `Op::AddSheet("S")` + the literal
/// `S!A1 = 42.0`. Both peers fork from these bytes so the base ops
/// carry a stable Loro peer-id (per step 1 audit closure: CRDT
/// convergence requires stable peer-ids).
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

/// **The canonical D-3 V1-limitation closure scenario, end-to-end.**
///
/// Peer A renames sheet `S → S2`; peer B concurrently writes a formula
/// `=S!A1` (referencing the pre-rename name). After
/// `CollabSession::rebuild_workbook` + `WorkbookRuntime::recompute_all`,
/// the formula MUST resolve to `Value::Number(42.0)` — not `#NAME?`.
///
/// Pre-Phase-5.3 (or with raw `merge_bytes` + `replay_into` + no repair):
/// `BindError::UnknownSheet("S")` → `Value::Error(ErrorValue::Name)`.
/// Post-Phase-5.3 step 3 + step 5b: the repair pass rewrites `S!A1` →
/// `S2!A1` and recompute resolves to 42.0.
///
/// This is the **load-bearing end-to-end test** that proves the
/// production wiring works for real users (not just text rewrite).
#[test]
fn step5b_rebuild_workbook_concurrent_rename_plus_edit_recomputes_to_correct_value() {
    let base_bytes = shared_base_bytes();

    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();

    // Peer A: rename S → S2.
    session_a
        .append_op(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();

    // Peer B (concurrent): formula referencing OLD name S.
    session_b
        .append_op(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();

    // Peer A merges peer B's bytes.
    let b_bytes = session_b.export_bytes().unwrap();
    session_a.merge_bytes(&b_bytes).unwrap();

    // Production wiring path: rebuild_workbook constructs a fresh
    // workbook + chains replay_into + repair_sheet_rename_chain +
    // repair_table_rename_chain.
    let reg = default_registry();
    let (mut wb, report) = session_a.rebuild_workbook(&reg).unwrap();

    // Sanity: the wrapper did fire the sheet-repair pass.
    assert_eq!(
        report.sheet_repair.formulas_rewritten, 1,
        "rebuild_workbook must trigger sheet repair (1 formula rewritten)"
    );

    // Recompute: this is the end-to-end step that exercises
    // WorkbookRuntime's binding + evaluator. Pre-repair, the formula
    // text `S!A1` would bind-fail (sheet S no longer exists post-rename
    // to S2) → `#NAME?`. Post-repair, the rewritten `S2!A1` binds
    // correctly → `Number(42.0)`.
    {
        let mut runtime = WorkbookRuntime::new(&mut wb, &reg);
        runtime.recompute_all();
    }

    // **LOAD-BEARING ASSERTION (Opus step 5b HIGH-4 closure)**: the
    // formula at S2!A2 (the cell where peer B wrote `=S!A1`) must
    // resolve to the literal value at S2!A1 (42.0), NOT `#NAME?`.
    let resolved = wb.read(Address::new(0, 1, 0));
    assert_eq!(
        resolved,
        Value::Number(42.0),
        "post-rebuild_workbook recompute MUST resolve the concurrent-rename formula \
         to the literal value (42.0) via the rewritten text — NOT #NAME?. \
         Pre-Phase-5.3 this surfaced as Value::Error(ErrorValue::Name)."
    );

    // Pin the rewritten text too (regression check against the
    // ql-collab tests):
    assert_eq!(
        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("S2!A1".to_string())
    );
}

/// **Empty-log end-to-end:** `rebuild_workbook` on an empty session
/// returns a fresh empty workbook. Recompute on an empty workbook is a
/// no-op (no formulas to evaluate); no panic.
#[test]
fn step5b_rebuild_workbook_empty_session_recomputes_cleanly() {
    let session = CollabSession::new(PeerId::new(PEER_A_ID)).unwrap();
    let reg = default_registry();
    let (mut wb, report) = session.rebuild_workbook(&reg).unwrap();
    assert_eq!(report.ops_replayed, 0);
    assert_eq!(wb.sheet_count(), 0);

    // Recompute on an empty workbook must not panic.
    let mut runtime = WorkbookRuntime::new(&mut wb, &reg);
    runtime.recompute_all();
}
