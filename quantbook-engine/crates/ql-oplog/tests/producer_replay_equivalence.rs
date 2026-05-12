//! Phase 2A.3.a integration test — producer-replay equivalence.
//!
//! The load-bearing invariant for the op log: any sequence of state
//! mutations that we'd record as a sequence of `Op` values, when replayed
//! against a fresh `Workbook`, produces the same observable workbook
//! state as the producer side achieved by direct mutation.
//!
//! This test mocks the producer side (we don't have `WorkbookRuntime`
//! integration yet — that's 2A.3.b). Instead, the test:
//!
//! 1. Builds a sequence of `Op` values matching a realistic IDE session
//!    (paste block + named-range + multi-sheet).
//! 2. Replays them against a fresh workbook (state A).
//! 3. Manually applies the equivalent state mutations to a SECOND fresh
//!    workbook (state B), using the same `Workbook` APIs that replay uses
//!    internally.
//! 4. Asserts the two workbooks are observationally equal on every cell +
//!    formula + name that either touches.
//!
//! Future commits (2A.3.b) will replace step 3 with real producer-side
//! op recording from `WorkbookRuntime` / `WorkbookTransaction`. The test
//! shape stays the same; the producer just becomes "real" instead of
//! "synthetic by hand."

use ql_functions::default_registry;
use ql_io::{CellWireValue, NamedTargetWire};
use ql_oplog::{replay_into, Op, OpLog};
use ql_storage::{NamedTarget, Workbook};
use ql_types::{Address, Value};

/// Build a realistic op sequence: paste 5x5 block of literals, add a
/// formula referencing one of them, register a named constant, add a
/// second sheet, write a value on it.
fn realistic_op_sequence() -> Vec<Op> {
    let mut ops = Vec::new();
    // 5x5 paste block on sheet 0.
    for r in 0..5u32 {
        for c in 0..5u32 {
            ops.push(Op::PutValue {
                sheet: 0,
                row: r,
                col: c,
                value: CellWireValue::Number((r * 10 + c) as f64),
            });
        }
    }
    // Formula at (5, 0).
    ops.push(Op::PutFormula {
        sheet: 0,
        row: 5,
        col: 0,
        text: "A1 + B2 + C3".to_owned(),
    });
    // Named constant.
    ops.push(Op::SetName {
        name: "TaxRate".to_owned(),
        target: NamedTargetWire::Constant {
            value: CellWireValue::Number(0.21),
        },
    });
    // Second sheet.
    ops.push(Op::AddSheet {
        name: "Inventory".to_owned(),
        chunk_rows: 16384,
    });
    // Value on sheet 1.
    ops.push(Op::PutValue {
        sheet: 1,
        row: 0,
        col: 0,
        value: CellWireValue::Text("widget".to_owned()),
    });
    ops
}

/// Mocks the producer side by applying ops directly to a workbook via the
/// same APIs that replay uses internally. In 2A.3.b this becomes the
/// real `WorkbookRuntime` + `WorkbookTransaction` calls; the public
/// invariant is unchanged.
fn apply_producer_side(ops: &[Op], wb: &mut Workbook) {
    for op in ops {
        match op {
            Op::PutValue {
                sheet,
                row,
                col,
                value,
            } => {
                let v = value.to_value().unwrap();
                wb.put_at(*sheet, *row, *col, v);
            }
            Op::PutFormula {
                sheet,
                row,
                col,
                text,
            } => {
                wb.put_formula(*sheet, *row, *col, text.as_str());
            }
            Op::ClearFormula { sheet, row, col } => {
                wb.clear_formula(*sheet, *row, *col);
            }
            Op::SetName { name, target } => {
                let t = target.to_target(name).unwrap();
                wb.set_name(name, t).unwrap();
            }
            Op::AddSheet { name, chunk_rows } => {
                wb.add_sheet_with_chunk_rows(name.clone(), *chunk_rows);
            }
            Op::BatchCommit { ops } => {
                apply_producer_side(ops, wb);
            }
        }
    }
}

/// Observational equality: compare two workbooks by cell-by-cell read,
/// formula text, sheet count, sheet names, and NameTable contents.
fn assert_workbooks_observationally_equal(a: &Workbook, b: &Workbook) {
    assert_eq!(a.sheet_count(), b.sheet_count(), "sheet counts differ");
    for sheet_id in 0..(a.sheet_count() as u16) {
        let sa = a.sheet(sheet_id).expect("sheet exists in a");
        let sb = b.sheet(sheet_id).expect("sheet exists in b");
        assert_eq!(sa.name(), sb.name(), "sheet {sheet_id} name differs");
        // Compare bounds + every cell within them. Outside-bounds cells
        // are uniformly Blank, so bound-equality + within-bounds-equality
        // suffices.
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
    // NameTable: compare lengths and per-name lookups.
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

#[test]
fn producer_and_replay_produce_observationally_equivalent_workbooks() {
    let ops = realistic_op_sequence();

    // Producer side: direct mutations.
    let mut producer_wb = Workbook::new();
    producer_wb.add_sheet("S"); // sheet 0 pre-exists (matches the test setup).
    apply_producer_side(&ops, &mut producer_wb);

    // Replay side: build an OpLog, replay against an empty workbook with
    // the same pre-existing sheet 0.
    let mut log = OpLog::new();
    for op in &ops {
        log.append(op.clone()).unwrap();
    }
    let mut replay_wb = Workbook::new();
    replay_wb.add_sheet("S");
    let reg = default_registry();
    let count = replay_into(&log, &mut replay_wb, &reg).unwrap();
    assert_eq!(count, ops.len());

    // Observational equality.
    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);

    // Sanity-spot-check some cells / names by hand.
    assert_eq!(
        replay_wb.read(Address::new(0, 2, 2)),
        Value::Number(22.0),
        "spot-check: (2,2) in the 5x5 paste block"
    );
    assert_eq!(
        replay_wb.formula_at(0, 5, 0).map(|s| s.as_ref()),
        Some("A1 + B2 + C3"),
        "spot-check: formula at (5, 0) survived round-trip"
    );
    assert!(matches!(
        replay_wb.names().lookup_ci("TaxRate"),
        Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
    ));
    assert_eq!(replay_wb.sheet_count(), 2);
    assert_eq!(
        replay_wb.read(Address::new(1, 0, 0)),
        Value::text("widget"),
        "spot-check: text value on second sheet"
    );
}

#[test]
fn binary_export_then_replay_equivalent_to_in_memory_replay() {
    // Verifies that going through the binary persistence layer doesn't
    // change replay results.
    let ops = realistic_op_sequence();

    let mut log = OpLog::new();
    for op in &ops {
        log.append(op.clone()).unwrap();
    }

    // In-memory replay → workbook A.
    let mut wb_in_memory = Workbook::new();
    wb_in_memory.add_sheet("S");
    let reg = default_registry();
    replay_into(&log, &mut wb_in_memory, &reg).unwrap();

    // Binary round-trip → restored log → replay → workbook B.
    let bytes = log.export_bytes().unwrap();
    let restored = OpLog::import_bytes(&bytes).unwrap();
    let mut wb_via_disk = Workbook::new();
    wb_via_disk.add_sheet("S");
    replay_into(&restored, &mut wb_via_disk, &reg).unwrap();

    assert_workbooks_observationally_equal(&wb_in_memory, &wb_via_disk);
}

#[test]
fn batch_commit_replay_equivalent_to_flat_replay() {
    // Two op logs: one with ops flat, the other wrapping the same ops in
    // a single BatchCommit. Both should produce the same workbook state.
    let flat_ops = vec![
        Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        },
        Op::PutValue {
            sheet: 0,
            row: 0,
            col: 1,
            value: CellWireValue::Number(2.0),
        },
        Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "A1 + B1".to_owned(),
        },
    ];

    let batched = vec![Op::BatchCommit {
        ops: flat_ops.clone(),
    }];

    let reg = default_registry();

    let mut wb_flat = Workbook::new();
    wb_flat.add_sheet("S");
    let mut log_flat = OpLog::new();
    for op in &flat_ops {
        log_flat.append(op.clone()).unwrap();
    }
    replay_into(&log_flat, &mut wb_flat, &reg).unwrap();

    let mut wb_batched = Workbook::new();
    wb_batched.add_sheet("S");
    let mut log_batched = OpLog::new();
    for op in &batched {
        log_batched.append(op.clone()).unwrap();
    }
    replay_into(&log_batched, &mut wb_batched, &reg).unwrap();

    assert_workbooks_observationally_equal(&wb_flat, &wb_batched);
}
