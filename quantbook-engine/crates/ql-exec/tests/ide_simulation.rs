//! Engine Phase 2B.6 — IDE consumer simulation.
//!
//! This file is the engine-side forcing function for the first IDE vertical
//! slice (`extensions/quantlab/`, separate worktree). It exercises the
//! engine through the EXACT call pattern an IDE would use, without
//! involving any TypeScript / VS Code APIs. The five tests map 1:1 to the
//! Phase 2B.6 acceptance items IDE-2B-01..05 in `docs/MASTER-PLAN.md`.
//!
//! When the Engine Phase 6.3 Node/WASM bindings ship, the JS-side IDE
//! code mirrors this Rust shape; if the bindings are correct and the
//! engine contract holds, the IDE works.
//!
//! The contract document this file implements is
//! `docs/architecture/ide-consumer-contract.md`. If you change behaviour
//! here, change that doc too — they're co-load-bearing.

use ql_exec::{BindError, RuntimeError, WorkbookRuntime};
use ql_functions::default_registry;
use ql_oplog::{load_workbook_with_oplog, save_workbook_with_oplog, OpLog};
use ql_storage::{NamedTarget, Workbook};
use ql_types::{Address, Value};
use tempfile::TempDir;

/// Build a fresh workbook the way the IDE would on "File → New": one
/// empty sheet, empty op log.
fn fresh_workbook_session() -> (Workbook, OpLog) {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    (wb, OpLog::new())
}

/// IDE-2B-01: a user-typed formula returns its evaluated value through
/// the engine's `set_formula` surface; the workbook reflects the value
/// and the formula text afterwards.
#[test]
fn ide_01_formula_edit_returns_value() {
    let (mut wb, mut oplog) = fresh_workbook_session();
    let reg = default_registry();

    // Seed A1 with a literal the way the IDE's grid-render-then-edit
    // would: a set_value through the runtime.
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
    }

    // User types `=A1 * 2` in the formula bar at B1, hits Enter.
    let value = {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_formula(0, 0, 1, "A1 * 2").unwrap()
    };

    // The engine returned 20; the IDE renders that in the cell.
    assert_eq!(value, Value::Number(20.0));
    // The workbook reflects both the value (via read) and the formula
    // text (via formula_at — the formula bar uses this when the cell is
    // selected).
    assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(20.0));
    assert_eq!(wb.formula_at(0, 0, 1).map(|s| s.as_ref()), Some("A1 * 2"));
    // The op log captured both the literal and the formula.
    assert_eq!(oplog.len(), 2);
}

/// IDE-2B-02: bind / lex / parse errors round-trip with user-facing
/// Display strings and DO NOT mutate the workbook or the op log. The
/// IDE renders the Display string as a diagnostic; the cell stays blank
/// (or at its prior value).
#[test]
fn ide_02_bind_errors_carry_user_facing_display() {
    let (mut wb, mut oplog) = fresh_workbook_session();
    let reg = default_registry();

    // Three error classes the IDE will commonly hit:
    let cases: &[(&str, &str)] = &[
        // (formula text, expected substring in user-facing Display)
        // **W5-143 (Phase 4.9.G):** `@` is now valid (implicit
        // intersection). Backtick replaces it as the still-invalid
        // lex char.
        ("`foo", "unexpected character"),
        ("(1 + 2", "parse error"),
        ("UnresolvedName + 1", "UNRESOLVEDNAME"),
    ];

    for (text, needle) in cases {
        let result = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_formula(0, 5, 5, *text)
        };
        match result {
            Err(err) => {
                let display = err.to_string();
                assert!(
                    !display.is_empty(),
                    "error must have a non-empty Display: text={text:?}"
                );
                assert!(
                    display.contains(needle),
                    "Display {display:?} doesn't mention {needle:?} for text={text:?}"
                );
            }
            Ok(_) => panic!("text {text:?} should not have evaluated cleanly"),
        }
    }

    // No partial write: the cell at (0, 5, 5) is blank, no formula, op
    // log untouched. (append-before-mutate ordering means error returns
    // leave engine state unchanged.)
    assert_eq!(wb.read(Address::new(0, 5, 5)), Value::Blank);
    assert!(wb.formula_at(0, 5, 5).is_none());
    assert!(
        oplog.is_empty(),
        "no ops should be recorded for failed edits"
    );

    // A named-range scalar misuse surfaces a specific precise variant
    // (the IDE renders this as "wrap in SUM/AVERAGE" hint).
    use ql_types::Range;
    wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
        .unwrap();
    let scalar_misuse = {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_formula(0, 5, 5, "Sales + 1")
    };
    assert!(matches!(
        scalar_misuse,
        Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(_)))
    ));
}

/// IDE-2B-03: the canonical "user starts typing and presses Esc" path —
/// the IDE never constructs the runtime, so the workbook never sees the
/// edit. No engine API call needed; this test pins the convention.
#[test]
fn ide_03_cancel_pattern_no_state_change() {
    let (mut wb, mut oplog) = fresh_workbook_session();
    let reg = default_registry();

    // Seed B1 with a known value.
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(0, 0, 1, Value::Number(99.0)).unwrap();
    }
    let oplog_len_before_cancel = oplog.len();
    let cell_value_before_cancel = wb.read(Address::new(0, 0, 1));

    // User clicks B1, starts typing `=A1 * 100`, then presses Esc.
    // The IDE handles Esc by SIMPLY NOT calling the engine. No
    // WorkbookRuntime is constructed.
    //
    // We model the cancel as the absence of a call.

    // Verify: workbook + op log unchanged.
    assert_eq!(wb.read(Address::new(0, 0, 1)), cell_value_before_cancel);
    assert_eq!(oplog.len(), oplog_len_before_cancel);
    // Sanity: still no formula at the cancelled cell.
    assert!(wb.formula_at(0, 0, 1).is_none());

    // The "drop transaction without commit" path is the corollary:
    // a transaction that gets dropped never mutates state.
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        let mut tx = rt.transaction();
        tx.put_value(0, 0, 1, Value::Number(0.0)).unwrap();
        tx.put_value(0, 0, 2, Value::Number(0.0)).unwrap();
        // No tx.commit(). Drop happens here.
    }
    assert_eq!(wb.read(Address::new(0, 0, 1)), cell_value_before_cancel);
    assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Blank);
    assert_eq!(oplog.len(), oplog_len_before_cancel);
}

/// IDE-2B-04: a clipboard paste of a multi-cell block executes through
/// the transaction API. Commit emits exactly ONE `Op::BatchCommit` per
/// paste; the workbook reflects all writes atomically. A paste of size
/// N produces 1 op (not N) — visible in the op log length.
#[test]
fn ide_04_paste_block_via_transaction() {
    let (mut wb, mut oplog) = fresh_workbook_session();
    let reg = default_registry();
    let op_count_before = oplog.len();

    // User pastes a 3×3 block of literals + one summary formula.
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        let mut tx = rt.transaction();
        for row in 0..3u32 {
            for col in 0..3u32 {
                tx.put_value(0, row, col, Value::Number((row * 3 + col + 1) as f64))
                    .unwrap();
            }
        }
        // Summary formula at (3, 0): SUM(A1, A2, A3) — using individual
        // cell refs since SUM(A1:A3) range syntax isn't yet supported in
        // scalar context. Sums to 1+4+7 = 12.
        tx.put_formula(0, 3, 0, "SUM(A1, A2, A3)").unwrap();
        tx.commit().unwrap();
    }

    // 9 literal writes + 1 formula = 10 ops, but they all live INSIDE
    // ONE BatchCommit. The op log grew by exactly 1.
    let ops_added = oplog.len() - op_count_before;
    assert_eq!(
        ops_added, 1,
        "paste must emit exactly one BatchCommit, not N individual ops; \
         got {ops_added} new ops"
    );

    // Verify the workbook reflects the full paste atomically.
    for row in 0..3u32 {
        for col in 0..3u32 {
            let expected = Value::Number((row * 3 + col + 1) as f64);
            assert_eq!(wb.read(Address::new(0, row, col)), expected);
        }
    }
    // Summary formula: 1 + 4 + 7 = 12.
    assert_eq!(wb.read(Address::new(0, 3, 0)), Value::Number(12.0));
    assert_eq!(
        wb.formula_at(0, 3, 0).map(|s| s.as_ref()),
        Some("SUM(A1, A2, A3)")
    );
}

/// IDE-2B-05: save → close → reopen preserves cell values, formula
/// text, named ranges, and op log length. The full round-trip works
/// without external state.
#[test]
fn ide_05_save_reload_preserves_state_and_oplog() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("ide-roundtrip.qbook");

    // Producer session: open new workbook, do a series of edits typical
    // of a user model-building session.
    let producer_oplog_len = {
        let (mut wb, mut oplog) = fresh_workbook_session();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Register a named constant via the runtime.
            rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
                .unwrap();
            // Seed inputs.
            rt.set_value(0, 0, 0, Value::Number(1000.0)).unwrap();
            // Formula referencing the named constant.
            rt.set_formula(0, 1, 0, "A1 * TaxRate").unwrap();
            // Add a sheet for "Inventory".
            let sheet1 = rt.add_sheet("Inventory", 16_384).unwrap();
            // Paste a 2×2 into it via transaction.
            {
                let mut tx = rt.transaction();
                for r in 0..2u32 {
                    for c in 0..2u32 {
                        tx.put_value(sheet1, r, c, Value::Number((r * 2 + c + 1) as f64 * 10.0))
                            .unwrap();
                    }
                }
                tx.commit().unwrap();
            }
        }
        // Save.
        save_workbook_with_oplog(&wb, &oplog, "ide-roundtrip", &path).unwrap();
        oplog.len()
    };

    // Consumer session: reopen the file. The IDE renders cells from
    // `wb.read(...)`; the formula bar from `wb.formula_at(...)`.
    let (reloaded_wb, reloaded_oplog) = load_workbook_with_oplog(&path).unwrap();

    // Sheet count + names match.
    assert_eq!(reloaded_wb.sheet_count(), 2);
    assert!(matches!(
        reloaded_wb.names().lookup_ci("TaxRate"),
        Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
    ));
    // Sheet 0 cell values.
    assert_eq!(
        reloaded_wb.read(Address::new(0, 0, 0)),
        Value::Number(1000.0)
    );
    assert_eq!(
        reloaded_wb.read(Address::new(0, 1, 0)),
        Value::Number(210.0)
    );
    // Sheet 0 formula text round-tripped.
    assert_eq!(
        reloaded_wb.formula_at(0, 1, 0).map(|s| s.as_ref()),
        Some("A1 * TaxRate")
    );
    // Sheet 1 cell values from the paste.
    for r in 0..2u32 {
        for c in 0..2u32 {
            let expected = Value::Number((r * 2 + c + 1) as f64 * 10.0);
            assert_eq!(reloaded_wb.read(Address::new(1, r, c)), expected);
        }
    }
    // Op log length matches what was saved. The IDE typically uses this
    // for "you have unsaved changes" (compare current vs saved length).
    assert_eq!(
        reloaded_oplog.len(),
        producer_oplog_len,
        "oplog length must round-trip through save/load"
    );
}

/// Convenience: when the IDE forces a recompute (e.g., a UDF refresh
/// invalidated cached values), the engine surfaces structural failures
/// per cell via `RecomputeResult` — the IDE renders each failure as a
/// red-cell diagnostic without short-circuiting.
#[test]
fn ide_recompute_failures_are_per_cell() {
    let (mut wb, mut oplog) = fresh_workbook_session();
    let reg = default_registry();

    // Seed two good formulas and one corrupted formula (simulating
    // on-disk corruption survived through a load). Engine Phase 2B.2's
    // RecomputeResult must surface the bad cell distinctly.
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
        rt.set_formula(0, 1, 0, "A1 + 1").unwrap();
        rt.set_formula(0, 2, 0, "A1 * 2").unwrap();
    }
    // Hand-inject a broken formula by going through the low-level path
    // (simulates corrupted on-disk state surviving load).
    wb.put_formula(0, 3, 0, "(((");

    // IDE force-recomputes.
    let result = {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.recompute_all()
    };

    assert_eq!(result.attempted, 3, "saw all 3 formula cells");
    assert_eq!(result.succeeded, 2);
    assert_eq!(result.failed_count(), 1);
    let failure = &result.failures[0];
    assert_eq!((failure.sheet, failure.row, failure.col), (0, 3, 0));
    assert_eq!(failure.formula_text.as_ref(), "(((");
    // The two good formulas DID write their values; the IDE renders
    // those normally.
    assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Number(11.0));
    assert_eq!(wb.read(Address::new(0, 2, 0)), Value::Number(20.0));
}

/// The bind-plan cache observability the IDE exposes in a status bar
/// works end-to-end: after one recompute_all there's exactly one miss
/// per formula; the second recompute_all is all hits.
#[test]
fn ide_recompute_cache_observability() {
    let (mut wb, mut oplog) = fresh_workbook_session();
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(0, 0, 0, Value::Number(7.0)).unwrap();
        rt.set_formula(0, 1, 0, "A1 + 1").unwrap();
        rt.set_formula(0, 2, 0, "A1 * 2").unwrap();
    }

    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
    let _r1 = rt.recompute_all();
    let stats_1 = rt.cache_stats();
    let _r2 = rt.recompute_all();
    let stats_2 = rt.cache_stats();

    // Second pass adds 2 hits (one per formula) and no new misses. The
    // IDE renders these in its observability surface.
    assert_eq!(stats_2.hits - stats_1.hits, 2);
    assert_eq!(stats_2.misses, stats_1.misses);
}
