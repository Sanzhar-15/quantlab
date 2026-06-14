#![allow(
    unused_imports,
    dead_code,
    unused_mut,
    unused_variables,
    clippy::all,
    clippy::pedantic,
    clippy::nursery
)]

//! Phase 4.12 cross-feature integration probes (Opus-A).
//!
//! Each `#[ignore]` test constructs a synthetic workbook combining
//! MULTIPLE Phase 4 features simultaneously and asserts the integration
//! point holds.
//!
//! Run with:
//!   cargo test -p ql-exec --test opus_a_phase_4_12_cross_features \
//!     -- --ignored --nocapture <name>

use ql_exec::{CalcgraphSession, RuntimeError, WorkbookRuntime};
use ql_functions::default_registry;
use ql_oplog::{replay::replay_into, OpLog};
use ql_storage::{FormatId, NamedTarget, Workbook};
use ql_types::{Address, ArrayValue, DateSystem, ErrorValue, Locale, Range, ReferenceMode, Value};

fn col_letter(c: u32) -> char {
    char::from_u32(b'A' as u32 + c).unwrap_or('?')
}

// ---------------------------------------------------------------------
// W1: multi-sheet workbook with structured table refs across sheets +
//     named ranges + custom format codes; then mutate and verify
//     recompute fires correctly.
// ---------------------------------------------------------------------

#[test]
#[ignore]
fn w1a_cross_sheet_table_ref_with_name_then_resize() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("Data");
    let s2 = wb.add_sheet("Report");
    let reg = default_registry();
    let mut graph = CalcgraphSession::new();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog_and_graph(&mut wb, &reg, &mut oplog, &mut graph);

        rt.set_value(s1, 0, 0, Value::Text("Qty".into())).unwrap();
        rt.set_value(s1, 0, 1, Value::Text("Price".into())).unwrap();
        rt.set_value(s1, 1, 0, Value::Number(10.0)).unwrap();
        rt.set_value(s1, 1, 1, Value::Number(2.0)).unwrap();
        rt.set_value(s1, 2, 0, Value::Number(20.0)).unwrap();
        rt.set_value(s1, 2, 1, Value::Number(3.0)).unwrap();
        rt.set_value(s1, 3, 0, Value::Number(30.0)).unwrap();
        rt.set_value(s1, 3, 1, Value::Number(4.0)).unwrap();

        rt.create_table(
            "Sales",
            s1,
            0,
            0,
            4,
            2,
            true,
            false,
            vec!["Qty".to_owned(), "Price".to_owned()],
        )
        .unwrap();

        rt.set_name("QtyRange", NamedTarget::Range(Range::new(s1, 1, 0, 3, 0)))
            .unwrap();

        let fmt_id = rt.intern_format("#,##0.00 \"€\"").unwrap();
        let v1 = rt.set_formula(s2, 0, 0, "SUM(Sales[Qty])").unwrap();
        rt.set_cell_format(s2, 0, 0, Some(fmt_id)).unwrap();
        let v2 = rt.set_formula(s2, 0, 1, "SUM(QtyRange)").unwrap();
        println!("[W1A pre-resize] structured-ref={v1:?} named-range={v2:?}");
        assert_eq!(v1, Value::Number(60.0), "Sales[Qty] sum");
        assert_eq!(v2, Value::Number(60.0), "QtyRange sum");

        // Add a new data row.
        rt.set_value(s1, 4, 0, Value::Number(40.0)).unwrap();
        rt.set_value(s1, 4, 1, Value::Number(5.0)).unwrap();

        // Resize table footprint.
        let res = rt.resize_table("Sales", 5, 2, vec![], vec![]);
        println!("[W1A] resize result: {res:?}");
        res.unwrap();
        let report = rt.recompute_dirty();
        println!("[W1A post-resize] recompute_dirty report: {report:?}");
    }

    let v1_after = wb.read(Address::new(s2, 0, 0));
    let v2_after = wb.read(Address::new(s2, 0, 1));
    println!("[W1A post-resize] structured={v1_after:?} named={v2_after:?}");
    if v1_after != Value::Number(100.0) {
        println!(
            "[W1A FINDING] resize_table did not re-fire SUM(Sales[Qty]); \
            got {v1_after:?}, expected 100.0"
        );
    }
    if v2_after != Value::Number(60.0) {
        println!("[W1A] named range surprisingly auto-extended: got {v2_after:?}, expected 60.0");
    }
}

#[test]
#[ignore]
fn w1b_rename_sheet_hosting_table_doesnt_break_structured_ref() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("Data");
    let s2 = wb.add_sheet("Report");
    let reg = default_registry();
    let mut oplog = OpLog::new();
    let after = {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(s1, 0, 0, Value::Text("Qty".into())).unwrap();
        rt.set_value(s1, 1, 0, Value::Number(10.0)).unwrap();
        rt.set_value(s1, 2, 0, Value::Number(20.0)).unwrap();
        rt.create_table("T", s1, 0, 0, 3, 1, true, false, vec!["Qty".to_owned()])
            .unwrap();

        let before = rt.set_formula(s2, 0, 0, "SUM(T[Qty])").unwrap();
        assert_eq!(before, Value::Number(30.0), "pre-rename");
        rt.rename_sheet(s1, "RenamedData").unwrap();
        let _ = rt.recompute_dirty();
        let _ = rt.recompute_all();
        ()
    };
    let _ = after;
    let after = wb.read(Address::new(s2, 0, 0));
    println!("[W1B post-rename] table sum after host rename = {after:?}");
    assert_eq!(after, Value::Number(30.0), "post-rename SUM(T[Qty])");
}

#[test]
#[ignore]
fn w1c_date1904_with_custom_format_renders_correctly() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    wb.set_date_system(DateSystem::Excel1904);
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);

    rt.set_value(0, 0, 0, Value::Number(0.0)).unwrap();
    let fmt_id = rt.intern_format("yyyy-mm-dd").unwrap();
    rt.set_cell_format(0, 0, 0, Some(fmt_id)).unwrap();
    let display = rt.read_display(0, 0, 0);
    println!("[W1C] date1904 serial 0 with yyyy-mm-dd = {display:?}");
    if !display.contains("1904") {
        println!(
            "[W1C FINDING] date1904 serial 0 rendered as {display:?} — \
            expected 1904 prefix. Format renderer may be ignoring \
            workbook.date_system()."
        );
    }
    let v_today = rt.set_formula(0, 1, 0, "TODAY()").unwrap();
    println!("[W1C] TODAY() in date1904 mode = {v_today:?}");
    if let Value::Number(serial) = v_today {
        let expected_1904_2026 = 44_696.0;
        let expected_1900_2026 = 46_159.0;
        let drift_from_1904 = (serial - expected_1904_2026).abs();
        let drift_from_1900 = (serial - expected_1900_2026).abs();
        println!("[W1C] TODAY() serial = {serial} (drift_1904={drift_from_1904}, drift_1900={drift_from_1900})");
        if drift_from_1904 > 60.0 && drift_from_1900 < 60.0 {
            println!(
                "[W1C FINDING] TODAY() returned date1900 serial ({serial}) \
                even though workbook.date_system = Excel1904. \
                Phase 4.5 × 4.10 integration leak."
            );
        }
    }
    // Also test YEAR() conversion under date1904.
    rt.set_value(0, 2, 0, Value::Number(36526.0)).unwrap();
    let yr = rt.set_formula(0, 2, 1, "YEAR(A3)").unwrap();
    println!("[W1C] YEAR(A3=36526 in date1904) = {yr:?}");
    // 36526 in date1904 = 2004-01-01 (approx). In date1900 = 2000-01-01.
    // Expect 2004 if date1904 honored.
    if let Value::Number(y) = yr {
        let y = y as i32;
        if y == 2000 {
            println!(
                "[W1C FINDING] YEAR(36526) returned 2000 (date1900 mapping) \
                even though workbook.date_system = Excel1904 (expected 2004)"
            );
        } else if y == 2004 {
            println!("[W1C OK] YEAR() honors date1904");
        } else {
            println!("[W1C] YEAR(36526) = {y} (date1904 expected 2004, date1900 expected 2000)");
        }
    }
}

// ---------------------------------------------------------------------
// W2: array formula × table × cross-sheet
// ---------------------------------------------------------------------

#[test]
#[ignore]
fn w2a_array_formula_over_table_then_resize() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("Data");
    let s2 = wb.add_sheet("Report");
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(s1, 0, 0, Value::Text("X".into())).unwrap();
        rt.set_value(s1, 1, 0, Value::Number(1.0)).unwrap();
        rt.set_value(s1, 2, 0, Value::Number(2.0)).unwrap();
        rt.set_value(s1, 3, 0, Value::Number(3.0)).unwrap();
        rt.create_table("T", s1, 0, 0, 4, 1, true, false, vec!["X".to_owned()])
            .unwrap();
        let transpose = rt.set_formula(s2, 0, 0, "TRANSPOSE(T[X])");
        println!("[W2A] TRANSPOSE(T[X]) anchor returns: {transpose:?}");
        let sp = rt.set_formula(s2, 2, 0, "SUMPRODUCT(T[X], T[X])").unwrap();
        println!("[W2A] SUMPRODUCT(T[X],T[X]) = {sp:?}");
        assert_eq!(sp, Value::Number(1.0 + 4.0 + 9.0));
    }
    for c in 0..4u32 {
        let v = wb.read(Address::new(s2, 0, c));
        println!("[W2A] Report!{}1 = {v:?}", col_letter(c));
    }
}

// ---------------------------------------------------------------------
// W3: locale parsing
// ---------------------------------------------------------------------

#[test]
#[ignore]
fn w3a_locale_de_parses_decimal_comma_in_formula() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.set_locale(Locale::De);
    let reg = default_registry();
    let stored = {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(s, 0, 0, "1,5+2,5");
        println!("[W3A] de-locale formula '1,5+2,5' result: {v:?}");
        match v {
            Ok(Value::Number(n)) => {
                if (n - 4.0).abs() < 1e-9 {
                    println!("[W3A OK] parsed as 1.5+2.5 = 4.0");
                } else {
                    println!("[W3A FINDING] de-locale '1,5+2,5' = {n}, expected 4.0");
                }
            }
            other => println!(
                "[W3A FINDING] de-locale '1,5+2,5' failed: {other:?} — \
                expected Ok(4.0). Phase 4.9 locale parsing not applied \
                at runtime entry."
            ),
        }
        ()
    };
    let _ = stored;
    let stored_text = wb.formula_at(s, 0, 0).map(|s| s.as_ref().to_owned());
    println!("[W3A] stored formula: {stored_text:?}");
    if let Some(text) = stored_text {
        if text.contains(',') {
            println!(
                "[W3A FINDING] stored formula contains comma: {text:?} — \
                canonicalize step (4.9.K) should have rewritten."
            );
        }
    }
}

#[test]
#[ignore]
fn w3b_locale_de_with_semicolon_arg_separator() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    wb.set_locale(Locale::De);
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let v = rt.set_formula(s, 0, 0, "SUM(1;2;3)");
    println!("[W3B] de-locale SUM(1;2;3) = {v:?}");
    if !matches!(v, Ok(Value::Number(n)) if (n - 6.0).abs() < 1e-9) {
        println!(
            "[W3B FINDING] de-locale semicolon arg-separator not honored. \
            Expected SUM(1;2;3) = 6.0, got {v:?}"
        );
    }
}

// ---------------------------------------------------------------------
// W4: op-log replay round trip
// ---------------------------------------------------------------------

#[test]
#[ignore]
fn w4_oplog_replay_mixed_mutations_reproduces_state() {
    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    let reg = default_registry();
    let mut oplog = OpLog::new();
    {
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
        rt.set_value(0, 0, 0, Value::Number(10.0)).unwrap();
        rt.set_value(0, 0, 1, Value::Number(20.0)).unwrap();
        rt.set_value(0, 0, 2, Value::Number(30.0)).unwrap();
        let _ = rt.set_formula(0, 1, 0, "SUM(A1, B1, C1)").unwrap();
        let s2 = rt.add_sheet("S2", 16).unwrap();
        rt.set_value(s2, 0, 0, Value::Number(100.0)).unwrap();
        rt.set_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let _ = rt.set_formula(0, 2, 0, "Rate*A1").unwrap();
        rt.create_table(
            "T1",
            0,
            5,
            0,
            3,
            2,
            true,
            false,
            vec!["a".to_owned(), "b".to_owned()],
        )
        .unwrap();
        rt.set_value(0, 5, 0, Value::Text("a".into())).unwrap();
        rt.set_value(0, 5, 1, Value::Text("b".into())).unwrap();
        rt.set_value(0, 6, 0, Value::Number(1.0)).unwrap();
        rt.set_value(0, 6, 1, Value::Number(2.0)).unwrap();
        rt.set_value(0, 7, 0, Value::Number(3.0)).unwrap();
        rt.set_value(0, 7, 1, Value::Number(4.0)).unwrap();
        let fmt_id = rt.intern_format("0.0000").unwrap();
        rt.set_cell_format(0, 2, 0, Some(fmt_id)).unwrap();
        rt.rename_sheet(s2, "Renamed2").unwrap();
        rt.set_sheet_scoped_name(0, "Local", NamedTarget::Constant(Value::Number(99.0)))
            .unwrap();
        rt.set_value(0, 3, 0, Value::Number(7.0)).unwrap();
        rt.clear_formula(0, 2, 0).unwrap();
        rt.drop_table("T1").unwrap();
    }

    let src_a1 = wb.read(Address::new(0, 0, 0));
    let src_b1 = wb.read(Address::new(0, 1, 0));
    let src_sheet1_name = wb.sheet(0).map(|s| s.name().to_owned());
    let src_sheet2_name = wb.sheet(1).map(|s| s.name().to_owned());
    let src_has_t1 = wb.tables().lookup("T1").is_some();
    let src_has_k = wb.names().lookup_ci("Rate").is_some();
    println!(
        "[W4] src: A1={src_a1:?}, A2={src_b1:?}, s1={src_sheet1_name:?}, \
        s2={src_sheet2_name:?}, T1={src_has_t1}, K={src_has_k}"
    );

    let mut replayed = Workbook::new();
    // Note: source wb was constructed by `Workbook::new(); wb.add_sheet("Sheet1")`
    // before runtime attachment, so the `AddSheet("Sheet1")` mutation was
    // never op-logged. Replaying into an empty workbook would fail with
    // InvalidSheet. We mirror the source's pre-attachment initial state.
    replayed.add_sheet("Sheet1");
    replay_into(&oplog, &mut replayed, &reg).unwrap();
    {
        let mut rt2 = WorkbookRuntime::new(&mut replayed, &reg);
        let _ = rt2.recompute_all();
    }

    let r_a1 = replayed.read(Address::new(0, 0, 0));
    let r_b1 = replayed.read(Address::new(0, 1, 0));
    let r_sheet1_name = replayed.sheet(0).map(|s| s.name().to_owned());
    let r_sheet2_name = replayed.sheet(1).map(|s| s.name().to_owned());
    let r_has_t1 = replayed.tables().lookup("T1").is_some();
    let r_has_k = replayed.names().lookup_ci("Rate").is_some();
    println!(
        "[W4] replay: A1={r_a1:?}, A2={r_b1:?}, s1={r_sheet1_name:?}, \
        s2={r_sheet2_name:?}, T1={r_has_t1}, K={r_has_k}"
    );

    let mut findings = Vec::<&str>::new();
    if src_a1 != r_a1 {
        findings.push("A1 diverged");
    }
    if src_b1 != r_b1 {
        findings.push("A2 (formula result) diverged");
    }
    if src_sheet1_name != r_sheet1_name {
        findings.push("Sheet1 name diverged");
    }
    if src_sheet2_name != r_sheet2_name {
        findings.push("Sheet2 name diverged");
    }
    if src_has_t1 != r_has_t1 {
        findings.push("T1 table presence diverged");
    }
    if src_has_k != r_has_k {
        findings.push("K name presence diverged");
    }
    if !findings.is_empty() {
        println!("[W4 FINDING] replay divergence: {findings:?}");
    }
}

// ---------------------------------------------------------------------
// W5: recompute graph stress
// ---------------------------------------------------------------------

#[test]
#[ignore]
fn w5_long_cross_sheet_chain_recomputes_downstream_after_source_change() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("S1");
    let s2 = wb.add_sheet("S2");
    let reg = default_registry();
    let mut graph = CalcgraphSession::new();
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(s1, 0, 0, Value::Number(1.0)).unwrap();
        for r in 1..500u32 {
            let txt = format!("A{}+1", r);
            rt.set_formula(s1, r, 0, txt).unwrap();
        }
        rt.set_formula(s2, 0, 0, "S1!A500+1").unwrap();
        for r in 1..500u32 {
            let txt = format!("S2!A{}+1", r);
            rt.set_formula(s2, r, 0, txt).unwrap();
        }
    }
    let initial_s1_a500 = wb.read(Address::new(s1, 499, 0));
    let initial_s2_a500 = wb.read(Address::new(s2, 499, 0));
    println!("[W5] initial: S1!A500={initial_s1_a500:?}, S2!A500={initial_s2_a500:?}");

    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(s1, 0, 0, Value::Number(101.0)).unwrap();
        let report = rt.recompute_dirty();
        println!("[W5] recompute_dirty report: {report:?}");
    }

    let after_s1_a500 = wb.read(Address::new(s1, 499, 0));
    let after_s2_a500 = wb.read(Address::new(s2, 499, 0));
    println!("[W5] after: S1!A500={after_s1_a500:?}, S2!A500={after_s2_a500:?}");

    if after_s1_a500 != Value::Number(600.0) {
        println!(
            "[W5 FINDING] S1 chain end {after_s1_a500:?} != expected 600.0 \
            after source change — recompute not propagating along chain"
        );
    }
    if after_s2_a500 != Value::Number(1100.0) {
        println!(
            "[W5 FINDING] S2 chain end {after_s2_a500:?} != expected 1100.0 \
            after source change — cross-sheet recompute leak"
        );
    }
}

// ---------------------------------------------------------------------
// Specific cross-sub-phase interaction probes
// ---------------------------------------------------------------------

#[test]
#[ignore]
fn i1_drop_table_invalidates_dependent_formulas() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let reg = default_registry();
    let mut graph = CalcgraphSession::new();
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(s, 0, 0, Value::Text("Q".into())).unwrap();
        rt.set_value(s, 1, 0, Value::Number(1.0)).unwrap();
        rt.set_value(s, 2, 0, Value::Number(2.0)).unwrap();
        rt.create_table("T", s, 0, 0, 3, 1, true, false, vec!["Q".to_owned()])
            .unwrap();
        let v = rt.set_formula(s, 10, 0, "SUM(T[Q])").unwrap();
        assert_eq!(v, Value::Number(3.0));
        rt.drop_table("T").unwrap();
        let _ = rt.recompute_dirty();
    }
    let after = wb.read(Address::new(s, 10, 0));
    println!("[I1] after drop_table: {after:?}");
    match after {
        Value::Error(ErrorValue::Name) | Value::Error(ErrorValue::Ref) => {
            println!("[I1 OK] dropped-table dependent → #NAME?/#REF!");
        }
        _ => println!(
            "[I1 FINDING] dropped table didn't invalidate dependent formula: \
            got {after:?}, expected #NAME?/#REF!"
        ),
    }
}

#[test]
#[ignore]
fn i2_sheet_scoped_name_shadows_workbook_scoped() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("S1");
    let s2 = wb.add_sheet("S2");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
        .unwrap();
    rt.set_sheet_scoped_name(s2, "Rate", NamedTarget::Constant(Value::Number(0.20)))
        .unwrap();
    let v_s1 = rt.set_formula(s1, 0, 0, "Rate*100").unwrap();
    println!("[I2] S1 Rate*100 = {v_s1:?}");
    let v_s2 = rt.set_formula(s2, 0, 0, "Rate*100").unwrap();
    println!("[I2] S2 Rate*100 = {v_s2:?}");
    if v_s2 != Value::Number(20.0) {
        println!(
            "[I2 FINDING] sheet-scoped Rate did not shadow workbook-scoped \
            on S2: got {v_s2:?}, expected 20.0 (per XS-4-03 spec)"
        );
    }
    if v_s1 != Value::Number(5.0) {
        println!(
            "[I2 FINDING] workbook-scoped Rate broken on S1: got {v_s1:?}, \
            expected 5.0"
        );
    }
}

#[test]
#[ignore]
fn i3_format_overlay_refresh_after_recompute() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut graph = CalcgraphSession::new();
    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
    rt.set_value(s, 0, 0, Value::Number(100.0)).unwrap();
    rt.set_formula(s, 1, 0, "A1*2").unwrap();
    let fmt_id = rt.intern_format("0.00").unwrap();
    rt.set_cell_format(s, 1, 0, Some(fmt_id)).unwrap();
    let d1 = rt.read_display(s, 1, 0);
    println!("[I3] initial A2 display: {d1:?}");
    rt.set_value(s, 0, 0, Value::Number(50.0)).unwrap();
    let _ = rt.recompute_dirty();
    let d2 = rt.read_display(s, 1, 0);
    println!("[I3] post-recompute A2 display: {d2:?}");
    if !d2.starts_with("100") {
        println!(
            "[I3 FINDING] format display not refreshed after recompute: \
            got {d2:?}, expected '100.00'"
        );
    }
}

#[test]
#[ignore]
fn i4_array_formula_spill_downstream_visibility() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let anchor = rt.set_formula(s, 0, 0, "SEQUENCE(5)");
    println!("[I4] SEQUENCE(5) anchor: {anchor:?}");
    let downstream = rt.set_formula(s, 10, 0, "A3*100").unwrap();
    println!("[I4] downstream A11 = A3*100 = {downstream:?}");
    if downstream != Value::Number(300.0) {
        println!(
            "[I4 FINDING] downstream cell did not see spilled A3=3: \
            got {downstream:?}, expected 300.0"
        );
    }
}

#[test]
#[ignore]
fn i5_rename_sheet_with_formulas_referencing_old_sheet() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Old");
    let reg = default_registry();
    let mut graph = CalcgraphSession::new();
    let stored_text;
    {
        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
        rt.set_value(s, 0, 0, Value::Number(1.0)).unwrap();
        rt.set_formula(s, 1, 0, "Old!A1*100").unwrap();
        rt.rename_sheet(s, "New").unwrap();
        let _ = rt.recompute_dirty();
    }
    stored_text = wb.formula_at(s, 1, 0).map(|s| s.as_ref().to_owned());
    println!("[I5] post-rename formula text at A2: {stored_text:?}");
    if let Some(text) = &stored_text {
        if text.contains("Old!") {
            println!(
                "[I5 FINDING] formula text still references old sheet name \
                'Old' after rename: {text:?}"
            );
        }
    }
    let val_after = wb.read(Address::new(s, 1, 0));
    println!("[I5] post-rename A2 value = {val_after:?}");
    if val_after != Value::Number(100.0) {
        println!(
            "[I5 FINDING] post-rename formula broken: got {val_after:?}, \
            expected 100.0"
        );
    }
}

#[test]
#[ignore]
fn i6_name_target_range_inside_table_after_resize() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s, 0, 0, Value::Text("X".into())).unwrap();
        rt.set_value(s, 1, 0, Value::Number(1.0)).unwrap();
        rt.set_value(s, 2, 0, Value::Number(2.0)).unwrap();
        rt.create_table("T", s, 0, 0, 3, 1, true, false, vec!["X".to_owned()])
            .unwrap();
        rt.set_name("DataAlias", NamedTarget::Range(Range::new(s, 1, 0, 2, 0)))
            .unwrap();
        rt.set_formula(s, 10, 0, "SUM(DataAlias)").unwrap();
        rt.set_value(s, 3, 0, Value::Number(3.0)).unwrap();
        rt.resize_table("T", 4, 1, vec![], vec![]).unwrap();
        let _ = rt.recompute_all();
    }
    let v_after = wb.read(Address::new(s, 10, 0));
    println!("[I6] after resize, SUM(DataAlias) = {v_after:?}");
    if v_after != Value::Number(3.0) {
        println!(
            "[I6 FINDING] name target range changed after table resize \
            (got {v_after:?}, expected 3.0 — name should NOT auto-extend)"
        );
    }
}

#[test]
#[ignore]
fn i7_clear_formula_dissolves_spill() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s, 0, 0, "SEQUENCE(3)").unwrap();
    }
    for r in 0..3u32 {
        let v = wb.read(Address::new(s, r, 0));
        println!("[I7] pre-clear A{} = {v:?}", r + 1);
    }
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.clear_formula(s, 0, 0).unwrap();
    }
    for r in 0..3u32 {
        let v = wb.read(Address::new(s, r, 0));
        println!("[I7] post-clear A{} = {v:?}", r + 1);
        if r > 0 && v != Value::Blank {
            println!(
                "[I7 FINDING] spill target A{} still holds value after \
                anchor clear: {v:?}, expected Blank",
                r + 1
            );
        }
    }
}

#[test]
#[ignore]
fn i8_rename_table_collides_with_existing_name() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s, 0, 0, Value::Text("A".into())).unwrap();
    rt.set_value(s, 1, 0, Value::Number(10.0)).unwrap();
    rt.create_table("T1", s, 0, 0, 2, 1, true, false, vec!["A".to_owned()])
        .unwrap();
    rt.set_name("ALIAS", NamedTarget::Constant(Value::Number(99.0)))
        .unwrap();
    let res = rt.rename_table("T1", "ALIAS");
    println!("[I8] rename_table T1->ALIAS result: {res:?}");
    if res.is_ok() {
        println!(
            "[I8 FINDING] rename_table succeeded into existing defined-name \
            namespace — shared-namespace invariant violated"
        );
    }
}

#[test]
#[ignore]
fn i9_locale_change_after_canonicalization_preserves_formulas() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s, 0, 0, Value::Number(1.5)).unwrap();
        let v = rt.set_formula(s, 1, 0, "A1+0.5").unwrap();
        assert_eq!(v, Value::Number(2.0));
        rt.set_locale(Locale::De).unwrap();
    }
    let stored = wb.formula_at(s, 1, 0).map(|s| s.as_ref().to_owned());
    println!("[I9] stored formula after locale switch: {stored:?}");
    if let Some(text) = &stored {
        if text.contains(",") {
            println!(
                "[I9 FINDING] stored form contains comma — \
                canonicalize-on-write didn't fire: {text:?}"
            );
        }
    }
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let _ = rt.recompute_all();
    }
    let val = wb.read(Address::new(s, 1, 0));
    if val != Value::Number(2.0) {
        println!("[I9 FINDING] post-locale-switch recompute broken: {val:?}");
    }
}

#[test]
#[ignore]
fn i10_rename_sheet_to_table_name_collision() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("S1");
    let _s2 = wb.add_sheet("S2");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s1, 0, 0, Value::Text("X".into())).unwrap();
    rt.set_value(s1, 1, 0, Value::Number(1.0)).unwrap();
    rt.create_table("MyTable", s1, 0, 0, 2, 1, true, false, vec!["X".to_owned()])
        .unwrap();
    let res = rt.rename_sheet(s1, "MyTable");
    println!("[I10] rename_sheet to existing table name: {res:?}");
    if res.is_ok() {
        let v = rt.set_formula(s1, 5, 0, "SUM(MyTable[X])");
        println!("[I10] formula SUM(MyTable[X]) post-collision = {v:?}");
    }
}

/// I11: scoped name `Old!Local` survives rename of `Old` to `New`.
/// Does the sheet-scoped namespace follow the rename?
#[test]
#[ignore]
fn i11_sheet_scoped_name_survives_sheet_rename() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Old");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_sheet_scoped_name(s, "Local", NamedTarget::Constant(Value::Number(42.0)))
        .unwrap();
    let v_before = rt.set_formula(s, 0, 0, "Local*2").unwrap();
    assert_eq!(v_before, Value::Number(84.0));
    rt.rename_sheet(s, "New").unwrap();
    let _ = rt.recompute_all();
    // Read the cell; should still be 84 since the sheet-scoped name moves with the sheet.
    let v_after = {
        let _ = rt.recompute_all();
        Address::new(s, 0, 0)
    };
    let val = wb.read(v_after);
    println!("[I11] after rename, =Local*2 = {val:?}");
    if val != Value::Number(84.0) {
        println!(
            "[I11 FINDING] sheet-scoped name 'Local' broke after parent \
            sheet rename: got {val:?}, expected 84.0"
        );
    }
}

/// I12: drop table that contains data referenced by a name pointing
/// into its data range. Does the name keep working?
#[test]
#[ignore]
fn i12_drop_table_name_pointing_into_data_range_still_works() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s, 0, 0, Value::Text("X".into())).unwrap();
        rt.set_value(s, 1, 0, Value::Number(10.0)).unwrap();
        rt.set_value(s, 2, 0, Value::Number(20.0)).unwrap();
        rt.create_table("T", s, 0, 0, 3, 1, true, false, vec!["X".to_owned()])
            .unwrap();
        rt.set_name("MyData", NamedTarget::Range(Range::new(s, 1, 0, 2, 0)))
            .unwrap();
        rt.set_formula(s, 5, 0, "SUM(MyData)").unwrap();
        assert_eq!(wb.read(Address::new(s, 5, 0)), Value::Number(30.0));
    }
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.drop_table("T").unwrap();
        let _ = rt.recompute_all();
    }
    let v = wb.read(Address::new(s, 5, 0));
    println!("[I12] after drop_table, SUM(MyData) = {v:?}");
    if v != Value::Number(30.0) {
        println!(
            "[I12 FINDING] dropping table broke a sibling Name pointing into \
            its old data area: got {v:?}, expected 30.0"
        );
    }
}

/// I13: very large name table — register 1000 names, look up each.
/// Performance + bounds check.
#[test]
#[ignore]
fn i13_many_names_lookup_does_not_blow_up() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    for i in 0..1000u32 {
        let n = format!("Name{i}");
        rt.set_name(&n, NamedTarget::Constant(Value::Number(i as f64)))
            .unwrap();
    }
    let v = rt.set_formula(s, 0, 0, "Name999+Name500").unwrap();
    println!("[I13] Name999+Name500 = {v:?}");
    assert_eq!(v, Value::Number(1499.0));
}

/// I14: format intern + register: register a custom format with an
/// id collision possibility? Verify intern of identical strings is
/// idempotent.
#[test]
#[ignore]
fn i14_format_intern_collision() {
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let id1 = rt.intern_format("0.0000").unwrap();
    let id2 = rt.intern_format("0.0000").unwrap();
    let id3 = rt.intern_format("0.0000").unwrap();
    println!("[I14] three interns of same string: {id1:?} {id2:?} {id3:?}");
    if id1 != id2 || id2 != id3 {
        println!("[I14 FINDING] intern not idempotent: {id1:?} {id2:?} {id3:?}");
    }
    // Also try one byte different
    let id_a = rt.intern_format("0.000").unwrap();
    if id_a == id1 {
        println!("[I14 FINDING] different format strings got same id");
    }
}

/// I25: range-aware functions with literal ranges. SUMIF, AVERAGEIF
/// etc. — does Phase 4.10 allow literal range arg or require named range?
#[test]
#[ignore]
fn i25_range_aware_fn_with_literal_range_arg() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s, 0, 0, Value::Number(1.0)).unwrap();
    rt.set_value(s, 1, 0, Value::Number(2.0)).unwrap();
    rt.set_value(s, 2, 0, Value::Number(3.0)).unwrap();
    rt.set_value(s, 0, 1, Value::Number(10.0)).unwrap();
    rt.set_value(s, 1, 1, Value::Number(20.0)).unwrap();
    rt.set_value(s, 2, 1, Value::Number(30.0)).unwrap();
    // SUMIF with literal range
    let v1 = rt.set_formula(s, 5, 0, "SUMIF(A1:A3, \">1\")");
    println!("[I25] SUMIF(A1:A3, \">1\") = {v1:?}");
    let v2 = rt.set_formula(s, 5, 1, "SUMIF(A1:A3, \">1\", B1:B3)");
    println!("[I25] SUMIF(A1:A3, \">1\", B1:B3) = {v2:?}");
    let v3 = rt.set_formula(s, 5, 2, "VLOOKUP(1, A1:B3, 2, FALSE)");
    println!("[I25] VLOOKUP(1, A1:B3, 2, FALSE) = {v3:?}");
    if v1.is_err() || v2.is_err() || v3.is_err() {
        println!(
            "[I25 FINDING] range-aware fn (SUMIF/VLOOKUP) with literal range arg \
            failed: SUMIF={v1:?}, SUMIF(3-arg)={v2:?}, VLOOKUP={v3:?}"
        );
    }
}

/// I26: structured ref to a column on a different sheet via the
/// (canonical) `Table[Col]` syntax. Verify cross-sheet structured-ref
/// binding from any sheet works.
#[test]
#[ignore]
fn i26_structured_ref_from_third_sheet() {
    let mut wb = Workbook::new();
    let s_table = wb.add_sheet("TableHost");
    let _s_unrelated = wb.add_sheet("Other");
    let s_report = wb.add_sheet("Report");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s_table, 0, 0, Value::Text("X".into()))
        .unwrap();
    rt.set_value(s_table, 1, 0, Value::Number(5.0)).unwrap();
    rt.set_value(s_table, 2, 0, Value::Number(10.0)).unwrap();
    rt.create_table(
        "Sales",
        s_table,
        0,
        0,
        3,
        1,
        true,
        false,
        vec!["X".to_owned()],
    )
    .unwrap();
    let v = rt.set_formula(s_report, 0, 0, "SUM(Sales[X])");
    println!("[I26] SUM(Sales[X]) from third sheet: {v:?}");
    assert_eq!(v.unwrap(), Value::Number(15.0));
}

/// I27: name covering a range that becomes invalid after sheet rename
/// — does the binder still resolve it?
#[test]
#[ignore]
fn i27_named_range_survives_sheet_rename() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("Data");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s, 0, 0, Value::Number(10.0)).unwrap();
    rt.set_value(s, 1, 0, Value::Number(20.0)).unwrap();
    rt.set_name("MyRange", NamedTarget::Range(Range::new(s, 0, 0, 1, 0)))
        .unwrap();
    rt.set_formula(s, 5, 0, "SUM(MyRange)").unwrap();
    rt.rename_sheet(s, "RenamedData").unwrap();
    let _ = rt.recompute_all();
    let v = wb.read(Address::new(s, 5, 0));
    println!("[I27] post-rename SUM(MyRange) = {v:?}");
    if v != Value::Number(30.0) {
        println!(
            "[I27 FINDING] named range broken after host sheet rename: {v:?}, \
            expected 30.0"
        );
    }
}

/// I23: TRANSPOSE over a structured ref — should spill across columns and
/// match TRANSPOSE over the equivalent named range.
///
/// **MEGAUDIT 2026-05-29 (Codex-A HIGH / Opus-marshal MED) — FIXED + un-ignored.**
/// This was a parked investigative test documenting a real bug: `TRANSPOSE(T[X])`
/// returned `#CALC!` while `TRANSPOSE(TRange)` over the same cells worked, because
/// `eval_at_cell_boundary`'s Unified arm was MISSING the `StructuredRef`
/// materialization that the scalar Unified arm had (W5-116) — so the structured
/// ref was scalar-evaluated to `#CALC!` and TRANSPOSE got a 1×1 error instead of
/// the column. The 6.4-3c audit-fix later routed array-capable UDF args through
/// this same boundary arm, widening the blast radius (`=MYUDF(TRANSPOSE(T[X]))`),
/// which is how the megaudit surfaced it. The fix adds the `StructuredRef` arm to
/// the boundary materializer; the two forms now agree.
#[test]
fn i23_transpose_over_structured_ref() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("Data");
    let s2 = wb.add_sheet("Report");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s1, 0, 0, Value::Text("X".into())).unwrap();
    rt.set_value(s1, 1, 0, Value::Number(1.0)).unwrap();
    rt.set_value(s1, 2, 0, Value::Number(2.0)).unwrap();
    rt.set_value(s1, 3, 0, Value::Number(3.0)).unwrap();
    rt.create_table("T", s1, 0, 0, 4, 1, true, false, vec!["X".to_owned()])
        .unwrap();
    // TRANSPOSE over the column's data body [1;2;3] → a 1×3 row; anchor = 1.0.
    let v_struct = rt.set_formula(s2, 0, 0, "TRANSPOSE(T[X])");
    // Compare with TRANSPOSE over a named range covering the same cells.
    rt.set_name("TRange", NamedTarget::Range(Range::new(s1, 1, 0, 3, 0)))
        .unwrap();
    let v_named = rt.set_formula(s2, 2, 0, "TRANSPOSE(TRange)");

    // Both must compute (NOT #CALC!) and agree on the anchor.
    assert!(
        !matches!(v_struct, Ok(Value::Error(_))),
        "TRANSPOSE(T[X]) must no longer be a #CALC! error (got {v_struct:?})"
    );
    assert_eq!(
        v_struct.unwrap(),
        Value::Number(1.0),
        "TRANSPOSE(T[X]) anchor = first transposed cell = 1.0"
    );
    assert_eq!(
        v_named.unwrap(),
        Value::Number(1.0),
        "TRANSPOSE(TRange) anchor = 1.0 (the structured-ref form must match this)"
    );
}

/// I24: BLANK cell vs Number(0) in SUM — Excel treats blank as 0
/// for SUM but skips for COUNT.
#[test]
#[ignore]
fn i24_blank_vs_zero_aggregate_skipping() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s, 0, 0, Value::Number(10.0)).unwrap();
    // Leave A2 blank (no value set)
    rt.set_value(s, 2, 0, Value::Number(30.0)).unwrap();
    rt.set_name("Vals", NamedTarget::Range(Range::new(s, 0, 0, 2, 0)))
        .unwrap();
    let s_v = rt.set_formula(s, 10, 0, "SUM(Vals)").unwrap();
    let c_v = rt.set_formula(s, 11, 0, "COUNT(Vals)").unwrap();
    let ca_v = rt.set_formula(s, 12, 0, "COUNTA(Vals)").unwrap();
    println!("[I24] SUM(Vals)={s_v:?}, COUNT={c_v:?}, COUNTA={ca_v:?}");
    assert_eq!(s_v, Value::Number(40.0), "SUM should treat blank as 0");
    assert_eq!(c_v, Value::Number(2.0), "COUNT should count only numbers");
    assert_eq!(ca_v, Value::Number(2.0), "COUNTA should count non-blanks");
}

/// I22: a single-letter / column-letter-shaped name (`K`, `XFC`) used to be
/// shadowed by the bare-column-letter lex — `=K*A1` summed the empty column `K`
/// instead of resolving the named constant. **FE-10 (2026-06-14)** fixed this: a
/// standalone bare token resolves as a NAME (Excel/Sheets parity). This probe was
/// `#[ignore]`d while the bug was open; it is now a HARD-ASSERTING regression test
/// (exercises the `NamedTarget::Constant` resolution path — a runtime-API-only kind;
/// the product/session creates Range names only).
///
/// This asserts INITIAL binding. The retarget/delete dirty-path for scalar names is
/// covered by `fe10_scalar_constant_name_redirties_on_{delete,retarget}` (session.rs):
/// a scalar (`Constant`/`Cell`) name now binds to `ExprPlan::ScalarNameRef`, which
/// PRESERVES the name so the dep graph records it and `delete_name`/retarget re-dirty
/// dependents (→ `#NAME?` / the new value), instead of leaving a stale value. (This
/// closes a pre-existing dep gap that affected scalar names of all lengths and was
/// reachable via loaded `.qbook` / imported `.xlsx` documents — Codex FE-10 audit HIGH.)
#[test]
fn i22_single_letter_named_constant_vs_column_letter() {
    let reg = default_registry();

    // `K` (a valid column letter AND a legal Excel name) registered as a constant.
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(0, 0, 0, Value::Number(100.0)).unwrap(); // A1 = 100
    rt.set_name("K", NamedTarget::Constant(Value::Number(2.0)))
        .unwrap();
    let v = rt.set_formula(0, 1, 0, "K*A1").unwrap();
    assert_eq!(
        v,
        Value::Number(200.0),
        "FE-10: `K` must resolve as the named Constant(2), so K*A1 = 2*100 = 200 \
         (pre-FE-10 `K` was shadowed by the bare-column lex)"
    );

    // `XFC` (3 letters, a valid column ≤ XFD) registered as a constant.
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(0, 0, 0, Value::Number(100.0)).unwrap();
    rt.set_name("XFC", NamedTarget::Constant(Value::Number(7.0)))
        .unwrap();
    let v = rt.set_formula(0, 1, 0, "XFC*A1").unwrap();
    assert_eq!(
        v,
        Value::Number(700.0),
        "FE-10: `XFC` (a valid column ≤ XFD) must resolve as the named Constant(7), \
         so XFC*A1 = 7*100 = 700"
    );
}

/// I16: read_display cache + locale switch — does a per-cell format
/// render under the NEW locale or stale under the OLD one after
/// set_locale?
#[test]
#[ignore]
fn i16_read_display_stale_after_locale_switch() {
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(0, 0, 0, Value::Number(1234.5)).unwrap();
    let fmt = rt.intern_format("#,##0.00").unwrap();
    rt.set_cell_format(0, 0, 0, Some(fmt)).unwrap();
    let d_en = rt.read_display(0, 0, 0);
    println!("[I16] en display: {d_en:?}");
    rt.set_locale(Locale::De).unwrap();
    let d_de = rt.read_display(0, 0, 0);
    println!("[I16] de display: {d_de:?}");
    // After de-locale switch, the rendered value SHOULD use de
    // grouping (1.234,50) NOT en (1,234.50).
    if d_de == d_en {
        println!(
            "[I16 FINDING] read_display cached output ignored locale change. \
            en={d_en:?}, de={d_de:?} — expected localized digit grouping after switch"
        );
    }
}

/// I17: set_format then read_display then set_date_system —
/// does the cache invalidate?
#[test]
#[ignore]
fn i17_read_display_stale_after_date_system_switch() {
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(0, 0, 0, Value::Number(0.0)).unwrap();
    let fmt = rt.intern_format("yyyy-mm-dd").unwrap();
    rt.set_cell_format(0, 0, 0, Some(fmt)).unwrap();
    let d1 = rt.read_display(0, 0, 0);
    println!("[I17] date1900 display of serial 0: {d1:?}");
    // Now switch the workbook to date1904.
    {
        // set_date_system is on Workbook, not runtime.
        drop(rt);
        wb.set_date_system(DateSystem::Excel1904);
    }
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let d2 = rt.read_display(0, 0, 0);
    println!("[I17] date1904 display of serial 0: {d2:?}");
    if d1 == d2 {
        println!(
            "[I17 FINDING] date_system change didn't affect rendered date \
            display. Got identical '{d1}' before/after switch — cache \
            staleness or renderer not honoring date_system"
        );
    }
}

/// I18: `=SUM(A:A)` whole-column reference.
#[test]
#[ignore]
fn i18_whole_column_sum() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s, 0, 0, Value::Number(1.0)).unwrap();
    rt.set_value(s, 1, 0, Value::Number(2.0)).unwrap();
    rt.set_value(s, 2, 0, Value::Number(3.0)).unwrap();
    let v = rt.set_formula(s, 5, 0, "SUM(A:A)");
    println!("[I18] SUM(A:A) = {v:?}");
    if let Err(e) = &v {
        println!("[I18 FINDING] SUM(A:A) whole-column literal range failed: {e}");
    }
}

/// I19: `=Sheet2!A:A` cross-sheet whole-column with a name.
#[test]
#[ignore]
fn i19_cross_sheet_whole_column_via_name() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("S1");
    let s2 = wb.add_sheet("S2");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    rt.set_value(s2, 0, 0, Value::Number(10.0)).unwrap();
    rt.set_value(s2, 1, 0, Value::Number(20.0)).unwrap();
    rt.set_value(s2, 2, 0, Value::Number(30.0)).unwrap();
    rt.set_name("ColA", NamedTarget::Range(Range::new(s2, 0, 0, 0xFFFFE, 0)))
        .unwrap();
    let v = rt.set_formula(s1, 0, 0, "SUM(ColA)").unwrap();
    println!("[I19] SUM(ColA) cross-sheet column = {v:?}");
    if v != Value::Number(60.0) {
        println!("[I19 FINDING] cross-sheet whole-column-ish via name lost values: {v:?}");
    }
}

/// I20: Stress test — recompute cascade after sheet rename of host
/// of structured-ref formula.
#[test]
#[ignore]
fn i20_structured_ref_after_host_sheet_rename_stress() {
    let mut wb = Workbook::new();
    let s1 = wb.add_sheet("DataSheet");
    let s2 = wb.add_sheet("Report");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_value(s1, 0, 0, Value::Text("X".into())).unwrap();
        for i in 1..50u32 {
            rt.set_value(s1, i, 0, Value::Number(i as f64)).unwrap();
        }
        rt.create_table("Big", s1, 0, 0, 50, 1, true, false, vec!["X".to_owned()])
            .unwrap();
        // Many formulas referencing the table
        for i in 0..10u32 {
            rt.set_formula(s2, i, 0, "SUM(Big[X])").unwrap();
        }
    }
    // Rename the data sheet
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.rename_sheet(s1, "DataSheetRenamed").unwrap();
        let _ = rt.recompute_all();
    }
    for i in 0..10u32 {
        let v = wb.read(Address::new(s2, i, 0));
        if v != Value::Number(1225.0) {
            println!(
                "[I20 FINDING] structured-ref formula on row {i} broke after host sheet \
                rename: {v:?}, expected 1225"
            );
            return;
        }
    }
    println!("[I20 OK] all structured-ref formulas survived host rename");
}

/// I21: cross-sheet formula referencing a sheet that gets deleted.
/// add a third sheet, formula on S1 reads S3, delete S3 - well, we
/// don't have delete_sheet yet. Try add+rename instead.
#[test]
#[ignore]
fn i21_delete_sheet_not_supported() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    // Look for an API to delete sheet.
    rt.set_value(s, 0, 0, Value::Number(1.0)).unwrap();
    println!("[I21] If WorkbookRuntime exposes no delete_sheet API, that's a Phase 4 IDE gap.");
}

/// I15: cross-sheet reference to a NON-EXISTENT sheet errors cleanly.
#[test]
#[ignore]
fn i15_cross_sheet_ref_to_nonexistent_sheet() {
    let mut wb = Workbook::new();
    let s = wb.add_sheet("S1");
    let reg = default_registry();
    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    let v = rt.set_formula(s, 0, 0, "Phantom!A1+1");
    println!("[I15] Phantom!A1+1 (no such sheet) = {v:?}");
    // Should resolve to a runtime error or #REF! sentinel value,
    // not panic.
}
