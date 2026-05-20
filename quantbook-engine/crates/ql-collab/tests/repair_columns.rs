//! Phase 5.3 step 5c — column rename-repair integration tests.
//! 2026-05-20.
//!
//! Closes Phase 5.3 step 5 megaudit Opus-A V1 LIM #3 HIGH (the column
//! repair pass was the largest single V1 limitation post step 4).
//!
//! Mirrors `repair_tables.rs` (table repair) pattern for column
//! rename scenarios. Covers:
//! - Primary case: concurrent column rename + concurrent formula
//!   referencing old column name → rewritten.
//! - Per-table scoping: only same-table refs are rewritten.
//! - Safety guard: skip rules where (table, old_col_canonical) is
//!   currently held by another column (cascade + resurrection
//!   corruption mirror of step 3 audit closure).
//! - Chain: T.A → T.B → T.C resolves to C from any historic.
//! - BatchCommit traversal.
//! - No-rename log → no-op.

use ql_collab::repair_column_rename_chain;
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

/// Build a base log: AddSheet("S") + CreateTable(table_name) with
/// the given column names over A1:_3 (rows=3, cols=N).
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

fn replay_to_workbook(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    let reg = ql_functions::default_registry();
    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    wb
}

// ===== Test 1: PRIMARY — concurrent column rename + concurrent formula =====

/// **Step 5c PRIMARY property**: peer A renames column `T.A → T.AA`;
/// peer B (concurrent) writes formula `=T[A]+1` referencing the old
/// column name. After merge + `repair_column_rename_chain`, the
/// formula must be rewritten to `T[AA]+1`.
#[test]
fn step5c_concurrent_column_rename_plus_edit_rewrites_formula() {
    let base = base_with_table("T", vec!["A".to_owned(), "B".to_owned()])
        .export_bytes()
        .unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();

    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 5,
            col: 5,
            text: "T[A]+1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let report = repair_column_rename_chain(&mut wb, &peer_a).unwrap();

    assert_eq!(
        report.formulas_rewritten, 1,
        "exactly 1 formula must be rewritten"
    );
    // The column rename applied at replay time (step 4 fix), so the
    // table has only column AA now.
    let meta = wb.tables().lookup("T").unwrap();
    assert!(meta.lookup_column("AA").is_some());
    assert!(meta.lookup_column("A").is_none());

    let formula = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    // Printer canonicalizes `+` to ` + ` (Opus-A step 5 audit L1 —
    // whitespace canonicalization side effect on repair-rewritten text).
    assert_eq!(
        formula,
        Some("T[AA] + 1".to_string()),
        "formula text MUST be rewritten by column repair pass"
    );
}

// ===== Test 2: Per-table scoping — column-A rename only affects T's refs =====

/// **Step 5c scoping property**: column A is renamed in table Sales to
/// AA. A SEPARATE table Revenue also has a column A. Repair must
/// rewrite `Sales[A]` → `Sales[AA]` but leave `Revenue[A]` UNCHANGED.
///
/// Note on table naming: table names MUST NOT contain ASCII digits.
/// The lexer reads `letters → digits` as CellRef (e.g., `T2` is
/// column T row 2; `Tbl2` is column Tbl row 2). Any `[` after such a
/// token is `UnexpectedChar('[')`. Real Excel producers enforce
/// non-cell-ref-looking table names; the test follows it.
#[test]
fn step5c_column_rename_scoped_to_owning_table_only() {
    // Base: Sales (with A, B) + Revenue (with A, C).
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::CreateTable {
            name: "Sales".to_owned(),
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
    base_log
        .append(Op::CreateTable {
            name: "Revenue".to_owned(),
            sheet: 0,
            top_row: 10,
            top_col: 0,
            rows: 3,
            cols: 2,
            has_header: true,
            has_totals: false,
            column_names: vec!["A".to_owned(), "C".to_owned()],
        })
        .unwrap();
    base_log
        .append(Op::PutFormula {
            sheet: 0,
            row: 20,
            col: 0,
            text: "Sales[A]+Revenue[A]".to_owned(),
        })
        .unwrap();
    base_log
        .append(Op::RenameColumn {
            table: "Sales".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();

    let mut wb = replay_to_workbook(&base_log);
    let report = repair_column_rename_chain(&mut wb, &base_log).unwrap();

    // Only Sales' reference should be rewritten; Revenue[A] must stay.
    let formula = wb.formula_at(0, 20, 0).map(|s| s.to_string());
    assert_eq!(
        formula,
        Some("Sales[AA] + Revenue[A]".to_string()),
        "column repair MUST be scoped: Sales[A] → Sales[AA]; Revenue[A] preserved. report = {report:?}"
    );
    assert_eq!(report.formulas_rewritten, 1);
}

// ===== Test 3: Safety guard — column-name reused by another rename =====

/// **Step 5c safety-guard property** (mirror of step 3 audit closure
/// for sheets): in a table with columns [A, B], rename B → A. The
/// historic rule `B → A` would, if applied naively, rewrite `T[B]` to
/// `T[A]` — but if a formula refs `T[A]` originally and another peer
/// did this rename, the rewrite would corrupt it. The safety guard
/// skips rules where the historic canonical is currently held.
#[test]
fn step5c_safety_guard_skips_rule_when_historic_is_current_holder() {
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::CreateTable {
            name: "T".to_owned(),
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
    // Rename A → AA. Then rename B → A. Now table has columns [AA, A].
    base_log
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();
    base_log
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "B".to_owned(),
            new_name: "A".to_owned(),
        })
        .unwrap();
    let mut wb = replay_to_workbook(&base_log);

    let report = repair_column_rename_chain(&mut wb, &base_log).unwrap();

    // The rule B → A (current = A) is fine — A is currently held by
    // the renamed column. The rule A → AA (current = AA) is problematic:
    // the historic name "a" is now held by a different column.
    let a_to_aa_skipped: Vec<_> = report
        .ambiguous_rules_skipped
        .iter()
        .filter(|s| s.historic_canonical == "a")
        .collect();
    assert_eq!(
        a_to_aa_skipped.len(),
        1,
        "rule (T, a) → AA must be skipped because 'a' is currently held \
         by a different column (the renamed-from-B column). Report: {:?}",
        report.ambiguous_rules_skipped
    );
}

// ===== Test 4: Chain T.A → T.B → T.C =====

/// **Step 5c chain property**: sequential renames `A → B → C`. A
/// formula referencing the ORIGINAL `T[A]` must be rewritten to
/// `T[C]` (skipping the intermediate `B`).
#[test]
fn step5c_transitive_column_chain_rewrites_to_final() {
    let mut log = base_with_table("T", vec!["A".to_owned(), "X".to_owned()]);
    log.append(Op::PutFormula {
        sheet: 0,
        row: 5,
        col: 5,
        text: "T[A]+1".to_owned(),
    })
    .unwrap();
    log.append(Op::RenameColumn {
        table: "T".to_owned(),
        old_name: "A".to_owned(),
        new_name: "B".to_owned(),
    })
    .unwrap();
    log.append(Op::RenameColumn {
        table: "T".to_owned(),
        old_name: "B".to_owned(),
        new_name: "C".to_owned(),
    })
    .unwrap();

    let mut wb = replay_to_workbook(&log);
    let _report = repair_column_rename_chain(&mut wb, &log).unwrap();

    // Producer-side rename rewrites incrementally (A → B → C), so by
    // the end of replay the formula already reads T[C]. The repair
    // pass's job in this single-writer path is to be a no-op safety
    // net. Assert the final state.
    let formula = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    // Printer canonicalizes `+` to ` + ` (Opus-A step 5 audit L1).
    assert_eq!(
        formula,
        Some("T[C] + 1".to_string()),
        "transitive chain A → B → C must end at T[C]"
    );
}

// ===== Test 5: BatchCommit traversal =====

/// **Step 5c BatchCommit property**: the chain walker recurses into
/// nested `Op::BatchCommit { ops: [...] }`.
#[test]
fn step5c_batchcommit_nested_column_rename_traverses_correctly() {
    let base = base_with_table("T", vec!["A".to_owned(), "B".to_owned()])
        .export_bytes()
        .unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::BatchCommit {
            ops: vec![Op::RenameColumn {
                table: "T".to_owned(),
                old_name: "A".to_owned(),
                new_name: "AA".to_owned(),
            }],
        })
        .unwrap();

    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 5,
            col: 5,
            text: "T[A]".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);
    let report = repair_column_rename_chain(&mut wb, &peer_a).unwrap();

    assert_eq!(
        report.formulas_rewritten, 1,
        "BatchCommit-nested RenameColumn must be discovered by chain walker"
    );
    assert_eq!(
        wb.formula_at(0, 5, 5).map(|s| s.to_string()),
        Some("T[AA]".to_string())
    );
}

// ===== Test 6: No-op when no renames =====

#[test]
fn step5c_repair_with_no_renames_is_noop() {
    let mut log = base_with_table("T", vec!["A".to_owned(), "B".to_owned()]);
    log.append(Op::PutFormula {
        sheet: 0,
        row: 5,
        col: 5,
        text: "T[A]+T[B]".to_owned(),
    })
    .unwrap();

    let mut wb = replay_to_workbook(&log);
    let pre_text = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    let report = repair_column_rename_chain(&mut wb, &log).unwrap();

    assert_eq!(report.formulas_rewritten, 0);
    assert!(report.column_rewrites.is_empty());
    assert_eq!(wb.formula_at(0, 5, 5).map(|s| s.to_string()), pre_text);
}

// ===== Test 7: Idempotency =====

/// Calling the repair pass twice should produce the same result on
/// both calls (no double-application of rules).
#[test]
fn step5c_repair_is_idempotent() {
    let base = base_with_table("T", vec!["A".to_owned(), "B".to_owned()])
        .export_bytes()
        .unwrap();
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 5,
            col: 5,
            text: "T[A]".to_owned(),
        })
        .unwrap();
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let report_1 = repair_column_rename_chain(&mut wb, &peer_a).unwrap();
    let text_after_1 = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    let report_2 = repair_column_rename_chain(&mut wb, &peer_a).unwrap();
    let text_after_2 = wb.formula_at(0, 5, 5).map(|s| s.to_string());

    assert_eq!(report_1.formulas_rewritten, 1);
    assert_eq!(report_2.formulas_rewritten, 0);
    assert_eq!(text_after_1, text_after_2);
    assert_eq!(text_after_1, Some("T[AA]".to_string()));
}

/// **Phase 5.3 step 5c (Codex+Opus megaudit Opus-A V1 LIM #3
/// closure):** the canonical D-3 column-rename closure scenario.
/// Peer A renames `T.A → T.AA`; peer B writes `=T[A]+1` concurrently.
/// After merge + `repair_column_rename_chain`, the formula MUST
/// reference `T[AA]+1`.
///
/// This is the "real users would have seen `#NAME?`" scenario the V1
/// limitation #3 was tracking. Closed by step 5c.
#[test]
fn step5c_d3_closure_column_concurrent_rename_resolves() {
    let base = base_with_table("T", vec!["A".to_owned()])
        .export_bytes()
        .unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameColumn {
            table: "T".to_owned(),
            old_name: "A".to_owned(),
            new_name: "AA".to_owned(),
        })
        .unwrap();

    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 5,
            col: 5,
            text: "T[A]+1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    // Pre-repair: formula text references old column "A" (peer B
    // wrote it verbatim, no parse/print round-trip yet).
    let pre = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    assert_eq!(
        pre,
        Some("T[A]+1".to_string()),
        "pre-repair: formula text refers to old column A"
    );

    let report = repair_column_rename_chain(&mut wb, &peer_a).unwrap();

    assert_eq!(report.formulas_rewritten, 1);
    let post = wb.formula_at(0, 5, 5).map(|s| s.to_string());
    // Post-repair: printer canonicalizes `+` to ` + ` (Opus-A step 5 audit L1).
    assert_eq!(
        post,
        Some("T[AA] + 1".to_string()),
        "post-repair: formula references current column AA"
    );
}
