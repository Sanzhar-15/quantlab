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
        assert!(
            rt.recompute_all().is_complete(),
            "recompute on replay-side workbook had failures"
        );
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
        assert!(
            rt.recompute_all().is_complete(),
            "recompute on replay-side workbook had failures"
        );
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
        assert!(
            rt.recompute_all().is_complete(),
            "recompute on replay-side workbook had failures"
        );
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
        assert!(
            rt.recompute_all().is_complete(),
            "recompute on replay-side workbook had failures"
        );
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
        assert!(
            rt.recompute_all().is_complete(),
            "recompute on replay-side workbook had failures"
        );
    }

    // Save + reload through the convenience function. The replayed workbook
    // should round-trip through qbook serialization without issue.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("replayed.qbook");
    ql_io::save_workbook(&replay_wb, "replayed-e2e", &path).unwrap();
    let (reloaded, recompute) = load_workbook_and_recompute(&path, &reg).unwrap();
    assert!(recompute.is_complete());
    assert_eq!(reloaded.read(Address::new(0, 0, 1)), Value::Number(111.0));
}

/// Phase 2A.3.c full-stack persistence round-trip: producer (real runtime)
/// → save_workbook_with_oplog → load_workbook_with_oplog → replay → recompute
/// yields a workbook observationally equal to the producer's final state.
#[test]
fn producer_save_load_replay_recompute_round_trip_yields_equivalent_workbook() {
    use ql_oplog::{load_workbook_with_oplog, save_workbook_with_oplog};
    use tempfile::TempDir;

    // ===== Produce =====
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut producer_oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
        rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap();
        rt.set_value(0, 0, 1, Value::Number(4.0)).unwrap();
        rt.set_formula(0, 0, 2, "A1 + B1").unwrap();
        rt.set_formula(0, 0, 3, "A1 * B1").unwrap();
        // Overwrite to exercise PutValue + ClearFormula.
        rt.set_value(0, 0, 3, Value::Number(99.0)).unwrap();
    }

    // ===== Save both =====
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("e2e.qbook");
    save_workbook_with_oplog(&producer_wb, &producer_oplog, "e2e", &path).unwrap();

    // ===== Load both =====
    let (_loaded_wb, loaded_oplog) = load_workbook_with_oplog(&path).unwrap();
    assert_eq!(
        loaded_oplog.len(),
        producer_oplog.len(),
        "oplog op count mismatch after save/load"
    );

    // ===== Replay against fresh workbook + recompute =====
    let mut replay_wb = fresh_wb();
    replay_into(&loaded_oplog, &mut replay_wb, &reg).unwrap();
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        assert!(
            rt.recompute_all().is_complete(),
            "recompute on replay-side workbook had failures"
        );
    }

    // ===== Equivalence =====
    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);

    // And the loaded workbook ALONE (without replay) matches the producer —
    // it was saved with the materialized values intact.
    let (loaded_wb_alone, _) = load_workbook_with_oplog(&path).unwrap();
    // After load_workbook, formula values are Pending (Blank) — the
    // loaded workbook has the formula TEXT and the SAVED value. The saved
    // value was the producer's evaluated result, so it should still match.
    assert_eq!(
        loaded_wb_alone.read(Address::new(0, 0, 2)),
        Value::Number(7.0)
    );
    assert_eq!(
        loaded_wb_alone.read(Address::new(0, 0, 3)),
        Value::Number(99.0)
    );
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

// ===== W5-84 closure (Codex MEDIUM + Sonnet MEDIUM I.2):
//       E2E format persistence round-trip =====

/// Real producer → save to `.qbook` → load → recompute → `read_display`.
/// This is the full end-to-end persistence + display path for the
/// Phase 4.5.D + 4.5.E arc. Prior tests covered the layers in
/// isolation but never the combined flow.
#[test]
fn format_persistence_round_trip_through_qbook() {
    use ql_storage::FormatId;

    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("formats_e2e.qbook");
    let reg = default_registry();

    // ===== Producer side =====
    let mut producer_wb = fresh_wb();
    let custom_id;
    {
        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
        // Number value with built-in date format.
        rt.set_value(0, 0, 0, Value::Number(45477.0)).unwrap(); // 2024-07-04
        rt.set_cell_format(0, 0, 0, Some(FormatId(14))).unwrap();
        // Number value with custom format.
        rt.set_value(0, 1, 0, Value::Number(1234.5)).unwrap();
        custom_id = rt.intern_format("#,##0.00").unwrap();
        rt.set_cell_format(0, 1, 0, Some(custom_id)).unwrap();
        // Formula that uses TEXT() — value should be the rendered string.
        rt.set_formula(0, 2, 0, "TEXT(A1, \"yyyy-mm-dd\")").unwrap();
        let _ = rt.recompute_all();
    }
    // Snapshot expected display values on the producer side.
    let producer_display_a1 = {
        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
        rt.read_display(0, 0, 0)
    };
    let producer_display_a2 = {
        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
        rt.read_display(0, 1, 0)
    };
    assert_eq!(producer_display_a1, "7/4/2024");
    assert_eq!(producer_display_a2, "1,234.50");

    // ===== Save =====
    ql_io::save_workbook(&producer_wb, "formats_e2e", &path).unwrap();

    // ===== Load + recompute =====
    let (loaded_wb, _result) = load_workbook_and_recompute(&path, &reg).unwrap();

    // FormatTable: the custom entry survived.
    assert_eq!(
        loaded_wb.formats().lookup(custom_id),
        Some("#,##0.00"),
        "custom format string must survive .qbook round-trip"
    );
    // Per-sheet overlay: bindings survived.
    assert_eq!(
        loaded_wb.sheet(0).unwrap().format_overlay().get(0, 0),
        Some(FormatId(14)),
        "built-in id 14 binding must survive round-trip"
    );
    assert_eq!(
        loaded_wb.sheet(0).unwrap().format_overlay().get(1, 0),
        Some(custom_id),
        "custom id binding must survive round-trip"
    );
    // Cell values survive too.
    assert_eq!(
        loaded_wb.read(Address::new(0, 0, 0)),
        Value::Number(45477.0)
    );
    assert_eq!(loaded_wb.read(Address::new(0, 1, 0)), Value::Number(1234.5));
    // TEXT formula's value (post-recompute) — should be the rendered string.
    assert_eq!(
        loaded_wb.read(Address::new(0, 2, 0)),
        Value::text("2024-07-04"),
        "TEXT(A1, \"yyyy-mm-dd\") must round-trip + recompute to the rendered string"
    );

    // ===== read_display on the reloaded workbook =====
    let mut loaded_wb_mut = loaded_wb;
    let mut rt = WorkbookRuntime::new(&mut loaded_wb_mut, &reg);
    assert_eq!(
        rt.read_display(0, 0, 0),
        "7/4/2024",
        "read_display through reloaded FormatTable + overlay must match producer"
    );
    assert_eq!(
        rt.read_display(0, 1, 0),
        "1,234.50",
        "custom-format read_display must match producer"
    );
    // Unbound cell (the TEXT formula's output) renders via General path.
    assert_eq!(rt.read_display(0, 2, 0), "2024-07-04");
}

/// **W5-108 (Phase 4.7.O) — Codex M4 / Sonnet L3 closure**: op-log
/// replay of a `PutFormula { text: "SEQUENCE(3)" }` followed by
/// `recompute_all` MUST reconstruct the spill anchor + target
/// computed overlays. Design § 12.1 ("no new variants — `Op::PutFormula`
/// only") relies on this replay-then-recompute equivalence — replay
/// only restores formula text, and the post-replay recompute is what
/// re-derives the spill state. Pre-4.7.O the parallel test at
/// workbook_runtime.rs:7978 used `put_formula` directly, bypassing
/// the actual replay path; this test pins the boundary itself.
#[test]
fn oplog_replay_then_recompute_reconstructs_spill_anchor_for_array_function() {
    use ql_oplog::Op;
    use ql_storage::SpillShape;

    // ===== Producer: a single PutFormula op for SEQUENCE(3). =====
    let mut oplog = OpLog::new();
    oplog
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "SEQUENCE(3)".to_string(),
        })
        .unwrap();

    // ===== Replay against a fresh workbook + recompute. =====
    let mut wb = fresh_wb();
    let reg = default_registry();
    replay_into(&oplog, &mut wb, &reg).unwrap();
    // Sanity: replay restored ONLY the formula text — no spill yet.
    assert_eq!(wb.spill_anchor_at(0, 0, 0), None);
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert!(
            rt.recompute_all().is_complete(),
            "recompute on replayed workbook had failures"
        );
    }

    // ===== Spill state must be re-derived. =====
    assert_eq!(
        wb.spill_anchor_at(0, 0, 0).copied(),
        Some(SpillShape::new(3, 1)),
        "recompute_all must re-register the SEQUENCE spill anchor"
    );
    assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
    assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Number(2.0));
    assert_eq!(wb.read(Address::new(0, 2, 0)), Value::Number(3.0));
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
        Some("SEQUENCE(3)")
    );
}

/// **W5-108 (Phase 4.7.O) — companion to the spill-reconstruction
/// test**: replay of a PutFormula with an array literal `{1, 2, 3}`
/// must ALSO reconstruct the spill via recompute_all. Pins design
/// § 12.1 for the literal-array path (vs the dynamic-function path
/// above).
#[test]
fn oplog_replay_then_recompute_reconstructs_spill_for_literal_array() {
    use ql_oplog::Op;
    use ql_storage::SpillShape;

    let mut oplog = OpLog::new();
    oplog
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "{10, 20, 30}".to_string(),
        })
        .unwrap();

    let mut wb = fresh_wb();
    let reg = default_registry();
    replay_into(&oplog, &mut wb, &reg).unwrap();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert!(rt.recompute_all().is_complete());
    }
    assert_eq!(
        wb.spill_anchor_at(0, 0, 0).copied(),
        Some(SpillShape::new(1, 3))
    );
    assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(10.0));
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(20.0));
    assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Number(30.0));
}

/// **W5-118 (Phase 4.8.H) e2e:** create_table emits Op::CreateTable;
/// replay against a fresh workbook reconstructs the table; subsequent
/// formula referencing the table binds + evaluates correctly.
#[test]
fn create_table_op_log_replay_reconstructs_table() {
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut producer_oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
    }
    // Producer-side seed values; replay won't re-create cell values
    // unless they were emitted as Op::PutValue (which we DO here).
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
        rt.set_value(0, 1, 0, Value::Number(50.0)).unwrap();
        rt.set_value(0, 2, 0, Value::Number(75.0)).unwrap();
        let _ = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
    }
    assert_eq!(
        producer_wb.read(Address::new(0, 10, 0)),
        Value::Number(125.0)
    );

    // ===== Replay against fresh workbook + recompute. =====
    let mut replay_wb = fresh_wb();
    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
    // After replay, the table exists and cells are set, but the formula
    // value isn't computed (replay doesn't evaluate).
    assert!(
        replay_wb.lookup_table("Sales").is_some(),
        "table re-registered"
    );
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        assert!(rt.recompute_all().is_complete(), "recompute failures");
    }
    assert_eq!(
        replay_wb.read(Address::new(0, 10, 0)),
        Value::Number(125.0),
        "post-replay SUM(Sales[Qty]) matches producer"
    );
}

/// **W5-118 (Phase 4.8.H) e2e:** drop_table emits Op::DropTable; replay
/// removes the table; a formula that referenced it would re-bind as
/// UnknownTable (we verify by checking the table is absent).
#[test]
fn drop_table_op_log_replay_removes_table() {
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut producer_oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
        rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
            .unwrap();
        rt.drop_table("Sales").unwrap();
    }
    assert!(producer_wb.lookup_table("Sales").is_none());

    let mut replay_wb = fresh_wb();
    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
    assert!(
        replay_wb.lookup_table("Sales").is_none(),
        "table dropped on replay"
    );
}

/// **W5-121 (Phase 4.8.I.2) e2e:** rename_column emits
/// `Op::RenameColumn` + `Op::PutFormula` for each rewritten cell;
/// replay against a fresh workbook reconstructs both the renamed
/// column metadata AND the rewritten formula text, so post-replay
/// recompute_all evaluates the SUM correctly under the new column
/// name.
#[test]
fn rename_column_op_log_replay_reconstructs_rename() {
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut producer_oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        rt.set_value(0, 1, 0, Value::Number(50.0)).unwrap();
        rt.set_value(0, 2, 0, Value::Number(75.0)).unwrap();
        let _ = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
        let n = rt.rename_column("Sales", "Qty", "Quantity").unwrap();
        assert_eq!(n, 1, "one formula rewritten");
    }
    assert_eq!(
        producer_wb.read(Address::new(0, 10, 0)),
        Value::Number(125.0)
    );

    let mut replay_wb = fresh_wb();
    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
    // Column metadata reflects rename.
    let meta = replay_wb
        .lookup_table("Sales")
        .expect("table re-registered");
    assert!(
        meta.lookup_column("Quantity").is_some(),
        "renamed column visible on replay"
    );
    assert!(
        meta.lookup_column("Qty").is_none(),
        "old column gone on replay"
    );
    // Formula text reflects rewrite.
    let text = replay_wb
        .formula_at(0, 10, 0)
        .expect("formula present")
        .clone();
    assert!(text.contains("Quantity"), "got: {text}");
    assert!(!text.contains("Qty"), "got: {text}");
    // Recompute produces the same value as the producer.
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        assert!(rt.recompute_all().is_complete());
    }
    assert_eq!(
        replay_wb.read(Address::new(0, 10, 0)),
        Value::Number(125.0),
        "post-replay SUM(Sales[Quantity]) matches producer"
    );
}

/// **W5-122 (Phase 4.8.J) e2e:** resize_table emits `Op::ResizeTable`;
/// replay against a fresh workbook reconstructs the new dimensions +
/// new column roster; post-replay recompute_all picks up the resized
/// range and evaluates SUM correctly.
#[test]
fn resize_table_op_log_replay_reconstructs_resize() {
    let mut producer_wb = fresh_wb();
    let reg = default_registry();
    let mut producer_oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        // Seed 4 values via PutValue so replay sees them; the table
        // initially covers only the first 2 data rows.
        rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
        rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
        rt.set_value(0, 3, 0, Value::Number(40.0)).unwrap();
        rt.set_value(0, 4, 0, Value::Number(50.0)).unwrap();
        // SUM at initial dim: rows 1-2 = 30.
        let _ = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
        // Grow to 5 rows + add "Price" column.
        rt.resize_table("Sales", 5, 2, vec!["Price".into()], vec![])
            .unwrap();
        // Resize bumps TableTable generation + clears plan cache, but
        // doesn't dirty individual formula cells (targeted dirty-prop
        // via `table_to_formulas` is 4.8.G.3, deferred). The
        // legacy-pass `recompute_all` re-evaluates every formula so
        // the SUM picks up the new range.
        assert!(rt.recompute_all().is_complete());
    }
    assert_eq!(
        producer_wb.read(Address::new(0, 10, 0)),
        Value::Number(120.0),
        "producer SUM after resize+recompute covers rows 1-4 = 120"
    );

    let mut replay_wb = fresh_wb();
    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
    // Table metadata reflects resize.
    let meta = replay_wb.lookup_table("Sales").expect("table present");
    assert_eq!(meta.rows, 5);
    assert_eq!(meta.cols, 2);
    assert!(meta.lookup_column("Qty").is_some());
    assert!(
        meta.lookup_column("Price").is_some(),
        "new column visible on replay"
    );
    // Post-replay recompute confirms SUM picks up the new range.
    {
        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
        assert!(rt.recompute_all().is_complete());
    }
    assert_eq!(
        replay_wb.read(Address::new(0, 10, 0)),
        Value::Number(120.0),
        "post-replay SUM matches producer"
    );
}

/// **W5-123 (Phase 4.8.L) e2e:** create a workbook with a table +
/// formula, save it to disk via `ql_io::save_workbook` (v6 schema),
/// reload via `load_workbook_and_recompute`, verify the table
/// metadata + formula text + post-load SUM all match the pre-save
/// state. Pins the full v5→v6 persistence round-trip with a real
/// `Table[Col]` formula.
#[test]
fn save_load_workbook_with_table_and_formula_roundtrips() {
    use tempfile::TempDir;
    let reg = default_registry();
    let mut producer_wb = fresh_wb();
    {
        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
        rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
        let v = rt.set_formula(0, 5, 0, "SUM(Sales[Qty])").unwrap();
        assert_eq!(v, Value::Number(30.0));
    }

    let dir = TempDir::new().unwrap();
    let path = dir.path().join("with_table.qbook");
    ql_io::save_workbook(&producer_wb, "with-table", &path).unwrap();

    let (reloaded, recompute) = ql_exec::load_workbook_and_recompute(&path, &reg).unwrap();
    assert!(
        recompute.is_complete(),
        "load+recompute had failures: {:?}",
        recompute
    );
    // Table metadata reloaded.
    let meta = reloaded
        .lookup_table("Sales")
        .expect("table metadata reloaded");
    assert_eq!(meta.rows, 3);
    assert_eq!(meta.cols, 1);
    assert!(meta.has_header);
    assert!(meta.lookup_column("Qty").is_some());
    // Formula text reloaded.
    let text = reloaded
        .formula_at(0, 5, 0)
        .expect("formula reloaded")
        .clone();
    assert_eq!(text.as_ref(), "SUM(Sales[Qty])");
    // Post-load recompute produces the same SUM as pre-save.
    assert_eq!(
        reloaded.read(Address::new(0, 5, 0)),
        Value::Number(30.0),
        "post-load SUM(Sales[Qty]) matches pre-save"
    );
}
