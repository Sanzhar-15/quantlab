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
        scope: None,
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
    // **W5-84 closure (Sonnet MEDIUM D.3):** include format ops in the
    // realistic sequence so the equivalence comparator exercises the
    // FormatTable + CellFormatOverlay paths.
    //
    // Register a custom format id (164 = first custom).
    ops.push(Op::RegisterFormat {
        id: 164,
        string: "\"€\" #,##0.00".to_owned(),
    });
    // Bind a cell on sheet 0 to a built-in id 14 (m/d/yyyy) — no
    // RegisterFormat needed; the built-in is pre-seeded by
    // `FormatTable::default()`.
    ops.push(Op::SetCellFormat {
        sheet: 0,
        row: 0,
        col: 0,
        id: Some(14),
    });
    // Bind another cell to the custom id.
    ops.push(Op::SetCellFormat {
        sheet: 0,
        row: 1,
        col: 0,
        id: Some(164),
    });
    // And clear a binding (Op::SetCellFormat with None on a previously-
    // bound cell). Tests the clear path.
    ops.push(Op::SetCellFormat {
        sheet: 0,
        row: 0,
        col: 0,
        id: None,
    });
    // **W5-93 (Phase 4.6.E closure):** sheet-scoped name on sheet 0.
    // Codex MEDIUM-3 + Sonnet M.2: the pre-W5-93 realistic sequence
    // only exercised `scope: None`, so a missing or wrong scope branch
    // in replay would have passed the equivalence test silently.
    ops.push(Op::SetName {
        scope: Some(0),
        name: "ScopedRate".to_owned(),
        target: NamedTargetWire::Constant {
            value: CellWireValue::Number(0.42),
        },
    });
    // And on sheet 1 (Inventory).
    ops.push(Op::SetName {
        scope: Some(1),
        name: "WarehouseBin".to_owned(),
        target: NamedTargetWire::Cell {
            sheet: 1,
            row: 0,
            col: 0,
        },
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
            Op::SetName {
                scope,
                name,
                target,
            } => {
                let t = target.to_target(name).unwrap();
                match scope {
                    None => {
                        wb.set_name(name, t).unwrap();
                    }
                    Some(sheet) => {
                        // W5-92 (Phase 4.6.D): sheet-scoped name; producer
                        // mirrors replay by routing through Sheet::set_scoped_name.
                        wb.sheet_mut(*sheet)
                            .expect("producer-side sheet lookup must succeed")
                            .set_scoped_name(name, t)
                            .expect("producer-side set_scoped_name must succeed");
                    }
                }
            }
            Op::AddSheet { name, chunk_rows } => {
                wb.add_sheet_with_chunk_rows(name.clone(), *chunk_rows);
            }
            Op::RenameSheet {
                id,
                old_name: _,
                new_name,
            } => {
                // W5-91: producer side calls `Workbook::rename_sheet`
                // directly here (the formula-text rewrite happens at the
                // `WorkbookRuntime` layer, above the op-log boundary).
                wb.rename_sheet(*id, new_name.clone())
                    .expect("producer-side rename_sheet must succeed");
            }
            Op::RegisterFormat { id, string } => {
                wb.formats_mut()
                    .register_at(ql_storage::FormatId(*id), string.as_str())
                    .expect("producer-side register_at must succeed");
            }
            Op::SetCellFormat {
                sheet,
                row,
                col,
                id,
            } => {
                let s = wb.sheet_mut(*sheet).expect("sheet exists");
                match id {
                    Some(raw_id) => {
                        s.format_overlay_mut()
                            .set(*row, *col, ql_storage::FormatId(*raw_id));
                    }
                    None => {
                        s.format_overlay_mut().clear(*row, *col);
                    }
                }
            }
            Op::BatchCommit { ops } => {
                apply_producer_side(ops, wb);
            }
            // **W5-118 (Phase 4.8.H), W5-119 (Phase 4.8.I), W5-121
            // (Phase 4.8.I.2), W5-122 (Phase 4.8.J):** producer-side
            // equivalence for table ops would require mirroring the
            // WorkbookRuntime validation here. Not exercised by
            // `realistic_op_sequence` today; assert unreachable so a
            // future addition forces a test author to mirror the
            // producer logic.
            Op::CreateTable { .. }
            | Op::DropTable { .. }
            | Op::RenameTable { .. }
            | Op::RenameColumn { .. }
            | Op::ResizeTable { .. } => {
                unreachable!(
                    "realistic_op_sequence doesn't emit table ops yet; \
                     update apply_producer_side when adding table coverage"
                )
            }
            // **W5-146 (Phase 4.9.J):** workbook-scope reference mode /
            // locale. Pure metadata; mirror replay by calling the
            // matching `Workbook` setter directly.
            Op::SetReferenceMode { mode } => {
                // **W5-151 (4.9.O MEDIUM-2):** `to_runtime` is now
                // fallible (mirroring LocaleWire); `realistic_op_sequence`
                // never emits Unknown.
                wb.set_reference_mode(
                    mode.clone()
                        .to_runtime()
                        .expect("realistic_op_sequence never emits unknown reference modes"),
                );
            }
            Op::SetLocale { locale } => {
                wb.set_locale(
                    locale
                        .clone()
                        .to_runtime()
                        .expect("realistic_op_sequence never emits unknown locales"),
                );
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

    // **W5-84 closure (Sonnet MEDIUM D.3):** FormatTable + per-sheet
    // CellFormatOverlay must also be compared so a producer/replay
    // divergence in format ops surfaces here (rather than letting a
    // bug in `RegisterFormat` / `SetCellFormat` ordering or id-
    // prediction slip through with matching cell values but mismatched
    // formats).
    let formats_a: std::collections::HashMap<u32, String> = a
        .formats()
        .iter()
        .map(|(id, s)| (id.0, s.to_owned()))
        .collect();
    let formats_b: std::collections::HashMap<u32, String> = b
        .formats()
        .iter()
        .map(|(id, s)| (id.0, s.to_owned()))
        .collect();
    assert_eq!(
        formats_a, formats_b,
        "FormatTable contents differ between producer and replay"
    );
    for sheet_id in 0..(a.sheet_count() as u16) {
        let overlay_a: std::collections::HashMap<(u32, u32), u32> = a
            .sheet(sheet_id)
            .unwrap()
            .format_overlay()
            .iter()
            .map(|((r, c), fid)| ((r, c), fid.0))
            .collect();
        let overlay_b: std::collections::HashMap<(u32, u32), u32> = b
            .sheet(sheet_id)
            .unwrap()
            .format_overlay()
            .iter()
            .map(|((r, c), fid)| ((r, c), fid.0))
            .collect();
        assert_eq!(
            overlay_a, overlay_b,
            "CellFormatOverlay differs on sheet {sheet_id}"
        );

        // **W5-93 (Phase 4.6.E closure):** per-sheet `scoped_names`
        // also has to be compared so a producer/replay divergence
        // in `Op::SetName { scope: Some(_), .. }` ordering or
        // routing surfaces here. Codex MEDIUM-3 + Sonnet M.3: the
        // pre-W5-93 comparator skipped scoped_names entirely, so a
        // missed routing branch in replay would have passed silently.
        let scoped_a = a.sheet(sheet_id).unwrap().scoped_names();
        let scoped_b = b.sheet(sheet_id).unwrap().scoped_names();
        assert_eq!(
            scoped_a.len(),
            scoped_b.len(),
            "sheet {sheet_id} scoped_names lengths differ"
        );
        for (name, _) in scoped_a.iter() {
            let target_a = scoped_a.lookup_ci(name).expect("present in a");
            let target_b = scoped_b.lookup_ci(name).unwrap_or_else(|| {
                panic!("scoped name {name:?} present on sheet {sheet_id} in a but not in b")
            });
            assert_eq!(
                target_a, target_b,
                "scoped name {name:?} on sheet {sheet_id} target differs"
            );
        }
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
