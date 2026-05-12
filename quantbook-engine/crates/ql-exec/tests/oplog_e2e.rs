//! Phase 2A.3.b end-to-end producer-replay equivalence — the real producer.
//!
//! 2A.3.a shipped a producer-replay equivalence test in `ql-oplog` itself, but
//! that test mocks the producer side by calling `Workbook` mutations directly.
//! 2A.3.b wires the engine's real producer (WorkbookRuntime + WorkbookTransaction)
//! to emit ops into an attached `OpLog`. This file pins the load-bearing
//! invariant of 2A.3.b: producer (real runtime) → op log → replay (+ recompute)
//! yields a workbook observationally equal to the producer's final state.
//!
//! The replay side runs `WorkbookRuntime::recompute_all` after replay because
//! `set_formula` emits `PutFormula` text only — replay restores the text
//! without materializing the value. The recompute call closes that gap.

use ql_exec::{load_workbook_and_recompute, WorkbookRuntime, WorkbookTransaction};
use ql_functions::default_registry;
use ql_oplog::{replay_into, OpLog};
use ql_storage::{NamedTarget, Workbook};
use ql_types::{Address, Value};

/// Build a fresh single-sheet workbook (sheet 0 named "S"). The producer-side
/// and replay-side both start with this shape so the op log only needs to
/// record post-init mutations.
fn fresh_wb() -> Workbook {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    wb
}

/// Observational equality: sheet count, sheet names, cell values, formula
/// text, name table. Copied loosely from the 2A.3.a producer-replay test
/// since the engine doesn't expose a `PartialEq` on `Workbook`.
fn assert_workbooks_observationally_equal(a: &Workbook, b: &Workbook) {
    assert_eq!(a.sheet_count(), b.sheet_count(), "sheet counts differ");
    for sheet_id in 0..(a.sheet_count() as u16) {
        let sa = a.sheet(sheet_id).expect("sheet exists in a");
        let sb = b.sheet(sheet_id).expect("sheet exists in b");
        assert_eq!(sa.name(), sb.name(), "sheet {sheet_id} name differs");
        let bounds_a = sa.bounds();
        let bounds_b = sb.bounds();
        let row_extent = bounds_a.row_extent.max(bounds_b.row_extent);
        let col_extent = bounds_a.col_extent.max(bounds_b.col_extent);
        for row in 0..row_extent {
            for col in 0..col_extent {
                let va = sa.read(row, col);
                let vb = sb.read(row, col);
                assert_eq!(
                    va, vb,
                    "cell (sheet={sheet_id}, row={row}, col={col}) value differs: {va:?} vs {vb:?}"
                );
                let fa = a
                    .formula_at(sheet_id, row, col)
                    .map(|s| s.as_ref().to_owned());
                let fb = b
                    .formula_at(sheet_id, row, col)
                    .map(|s| s.as_ref().to_owned());
                assert_eq!(
                    fa, fb,
                    "cell (sheet={sheet_id}, row={row}, col={col}) formula differs: {fa:?} vs {fb:?}"
                );
            }
        }
    }
    let names_a = a.names();
    let names_b = b.names();
    assert_eq!(names_a.len(), names_b.len(), "name table lengths differ");
    for (name, _) in names_a.iter() {
        let target_a = names_a.lookup_ci(name).expect("present in a");
        let target_b = names_b
            .lookup_ci(name)
            .unwrap_or_else(|| panic!("name {name:?} present in a but not in b"));
        assert_eq!(target_a, target_b, "name {name:?} target differs");
    }
}

/// Runtime produced ops, replay-then-recompute reproduces observable state.
///
/// Producer side: a series of `set_value` and `set_formula` calls through a
/// runtime with an attached op log. Pre-seeds a named constant on the
/// workbook (NameTable mutations don't flow through the op log in 2A.3.b —
/// that's 2A.3.c / 2A.3.d scope — so the test pre-creates the name on the
/// replay-side workbook to match).
#[test]
fn runtime_produced_oplog_replay_then_recompute_yields_observationally_equivalent_workbook() {
    // ===== Producer side =====
    let mut producer_wb = fresh_wb();
    producer_wb
        .set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
        .unwrap();
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
        // 5 literal writes.
        for c in 0..5u32 {
            rt.set_value(0, 0, c, Value::Number((c + 1) as f64 * 10.0))
                .unwrap();
        }
        // Formula referencing the literals.
        rt.set_formula(0, 1, 0, "A1 + B1 + C1 + D1 + E1").unwrap();
        // Formula referencing the named constant.
        rt.set_formula(0, 1, 1, "A1 * TaxRate").unwrap();
        // Overwrite one cell to exercise PutValue + ClearFormula.
        rt.set_formula(0, 2, 0, "100 + 1").unwrap();
        rt.set_value(0, 2, 0, Value::Number(7.0)).unwrap();
    }
    // Sanity check producer side: 5+5+10+30+2.1+7 — but the formula at (2,0)
    // got overwritten by 7. (1,0) = 10+20+30+40+50 = 150. (1,1) = 10*0.21 = 2.1.
    assert_eq!(
        producer_wb.read(Address::new(0, 1, 0)),
        Value::Number(150.0)
    );
    assert_eq!(producer_wb.read(Address::new(0, 1, 1)), Value::Number(2.1));
    assert_eq!(producer_wb.read(Address::new(0, 2, 0)), Value::Number(7.0));

    // ===== Replay side =====
    // Pre-create the same name table state (2A.3.b doesn't record SetName).
    let mut replay_wb = fresh_wb();
    replay_wb
        .set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
        .unwrap();
    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
    // Replay restored formula TEXT only; values are pending. Run
    // recompute_all to materialize.
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        rt.recompute_all().unwrap();
    }

    // ===== Equivalence =====
    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
}

/// Transaction-shaped producer: a paste-block via `WorkbookTransaction::commit`
/// emits one `BatchCommit`. Replay against fresh workbook + recompute_all
/// reproduces the same state.
#[test]
fn transaction_produced_oplog_replay_then_recompute_yields_observationally_equivalent_workbook() {
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
        let mut tx = rt.transaction();
        // 3x3 paste of literals.
        for r in 0..3u32 {
            for c in 0..3u32 {
                tx.put_value(0, r, c, Value::Number((r * 3 + c) as f64))
                    .unwrap();
            }
        }
        // Formula referencing a literal from the same transaction.
        tx.put_formula(0, 5, 0, "A1 + B2 + C3").unwrap();
        tx.commit().unwrap();
    }

    let mut replay_wb = fresh_wb();
    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        rt.recompute_all().unwrap();
    }

    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
    // Spot-check the formula cell.
    assert_eq!(
        replay_wb.read(Address::new(0, 5, 0)),
        Value::Number(0.0 + 4.0 + 8.0)
    );
}

/// Mixed sequence: runtime edits + transaction commits + more runtime edits.
/// Verifies that a single OpLog carries them all and replay reproduces the
/// state cohesively.
#[test]
fn mixed_runtime_and_transaction_producer_replays_equivalently() {
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
        rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
        {
            let mut tx = rt.transaction();
            tx.put_value(0, 0, 1, Value::Number(2.0)).unwrap();
            tx.put_value(0, 0, 2, Value::Number(3.0)).unwrap();
            tx.commit().unwrap();
        }
        rt.set_formula(0, 0, 3, "A1 + B1 + C1").unwrap();
    }

    let mut replay_wb = fresh_wb();
    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        rt.recompute_all().unwrap();
    }

    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
    assert_eq!(replay_wb.read(Address::new(0, 0, 3)), Value::Number(6.0));
}

/// Binary-round-trip variant: producer → export_bytes → import_bytes →
/// replay → recompute. Confirms 2A.3.b's producer side is compatible with
/// the persistence shape that 2A.3.c will use.
#[test]
fn runtime_produced_oplog_survives_binary_round_trip() {
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
        rt.set_formula(0, 1, 0, "A1 * 10").unwrap();
    }

    let bytes = oplog.export_bytes().unwrap();
    let restored = OpLog::import_bytes(&bytes).unwrap();
    assert_eq!(restored.len(), oplog.len());

    let mut replay_wb = fresh_wb();
    replay_into(&restored, &mut replay_wb, &reg).unwrap();
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        rt.recompute_all().unwrap();
    }

    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
}

/// Failed mutations leave the op log untouched: a set_formula that fails at
/// parse time (or any pipeline stage before mutation) must not emit an op.
#[test]
fn failed_set_formula_does_not_append_to_oplog() {
    let mut wb = fresh_wb();
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        // Buffer one good op.
        rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
        // Then trigger a parse error.
        let result = rt.set_formula(0, 0, 1, "(1 + 2");
        assert!(result.is_err());
        // And another good op.
        rt.set_value(0, 0, 2, Value::Number(3.0)).unwrap();
    }
    // Expect exactly 2 ops (the good ones); failed one didn't land.
    assert_eq!(oplog.len(), 2);
}

/// Sanity: `load_workbook_and_recompute` (the existing entry point) still
/// works on a workbook produced via the op-log replay path. Phase 2A.4 added
/// this convenience; nothing in 2A.3.b should regress it.
#[test]
fn replayed_workbook_supports_load_recompute_convenience() {
    use tempfile::TempDir;

    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
        rt.set_value(0, 0, 0, Value::Number(11.0)).unwrap();
        rt.set_formula(0, 0, 1, "A1 + 100").unwrap();
    }

    let mut replay_wb = fresh_wb();
    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        rt.recompute_all().unwrap();
    }

    // Save + reload through the convenience function. The replayed workbook
    // should round-trip through qbook serialization without issue.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("replayed.qbook");
    ql_io::save_workbook(&replay_wb, "replayed-e2e", &path).unwrap();
    let reloaded = load_workbook_and_recompute(&path, &reg).unwrap();
    assert_eq!(reloaded.read(Address::new(0, 0, 1)), Value::Number(111.0));
}

/// Sanity check: ensure `WorkbookTransaction::with_oplog` standalone (no
/// enclosing runtime) also produces valid ops.
#[test]
fn standalone_transaction_with_oplog_produces_batch_commit() {
    let mut wb = fresh_wb();
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
        tx.put_value(0, 0, 0, Value::Number(42.0)).unwrap();
        tx.put_value(0, 0, 1, Value::Number(43.0)).unwrap();
        tx.commit().unwrap();
    }
    // One BatchCommit with 2 inner ops.
    assert_eq!(oplog.len(), 1);

    let mut replay_wb = fresh_wb();
    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
    assert_eq!(replay_wb.read(Address::new(0, 0, 0)), Value::Number(42.0));
    assert_eq!(replay_wb.read(Address::new(0, 0, 1)), Value::Number(43.0));
}
