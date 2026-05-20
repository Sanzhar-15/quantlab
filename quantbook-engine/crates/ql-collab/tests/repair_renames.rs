//! Phase 5.3 step 3 (CORE 5.3 work) — `ql_collab::repair_sheet_rename_chain`
//! integration tests. 2026-05-20.
//!
//! Covers the user-visible property step 3 ships: after merging
//! concurrent ops, formulas authored against pre-rename sheet names
//! get rewritten to the current name. The repair pass closes the V1
//! limitation documented at `crdt-data-model.md:615-648` (D-3 →
//! `#NAME?`).
//!
//! Test pattern follows Phase 5.3 step 2's `phase_5_3_step2_rename_concurrent.rs`:
//! 2-peer fork with stable peer-ids. Each test:
//!   1. Build shared base log.
//!   2. Fork peer A + peer B via `fork_with_peer`.
//!   3. Each peer appends its local op.
//!   4. Exchange via `export_bytes` + `merge_bytes`.
//!   5. Replay into fresh workbook.
//!   6. `repair_sheet_rename_chain(&mut wb, &log)`.
//!   7. Assert formula text + (optionally) recomputed value.
//!
//! NOTE: these tests don't recompute (no ql-functions in ql-collab's
//! dev-deps). They assert the FORMULA TEXT after repair, which is the
//! load-bearing property. Recompute correctness is a downstream concern
//! pinned at the row-7 test in `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs`.

use ql_collab::{repair_sheet_rename_chain, RepairReport};
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

fn base_with_sheet(name: &str) -> OpLog {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: name.to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log
}

/// Replay `log` into a fresh workbook. We use the registry from
/// ql-functions (already a ql-collab dep) since `replay_into` requires
/// it; we don't recompute (that's a downstream test concern).
fn replay_to_workbook(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    let reg = ql_functions::default_registry();
    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    wb
}

/// Helper: build a merged log from two peers + apply concurrent ops.
/// Mirrors the step-2 pattern; peer A is the merger.
fn merged_log_with_concurrent_ops(base: &[u8], op_a: Op, op_b: Op) -> OpLog {
    let mut peer_a = fork_with_peer(base, PEER_A_ID);
    peer_a.append(op_a).unwrap();
    let mut peer_b = fork_with_peer(base, PEER_B_ID);
    peer_b.append(op_b).unwrap();
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    peer_a
}

// ===== Test 1: PRIMARY — concurrent rename + concurrent formula edit =====

/// **Step 3 PRIMARY property**: peer A renames sheet S → S2;
/// peer B (concurrent, no knowledge of rename) writes `=S!A1` at B1.
/// After merge + repair, the formula text is rewritten to `=S2!A1`.
///
/// This is the canonical bug case from `crdt-data-model.md` row 7:
/// pre-step-3 the formula would bind-fail (S no longer exists) and
/// recompute → #NAME?. Post-step-3 the formula references the current
/// sheet name and resolves correctly.
#[test]
fn repair_rewrites_concurrent_formula_referencing_old_name() {
    // Base: sheet S exists.
    let base = base_with_sheet("S").export_bytes().unwrap();

    let log = merged_log_with_concurrent_ops(
        &base,
        Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0, // B2... actually row 1, col 0 = A2
            text: "S!A1".to_owned(),
        },
    );

    let mut wb = replay_to_workbook(&log);
    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
    // Pre-repair: formula at (1,0) is "S!A1".
    assert_eq!(
        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("S!A1".to_string()),
        "pre-repair formula text is the raw merge state (S!A1, referencing old name)"
    );

    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair must succeed");

    // Post-repair: formula rewritten to reference current sheet name.
    assert_eq!(
        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("S2!A1".to_string()),
        "post-repair formula text references current sheet name (S2)"
    );
    assert_eq!(
        report.formulas_rewritten, 1,
        "exactly 1 formula rewritten (B's =S!A1)"
    );
    assert_eq!(report.sheet_rewrites.len(), 1);
    assert_eq!(report.sheet_rewrites[0].sheet, 0);
    assert_eq!(report.sheet_rewrites[0].current_display_name, "S2");
    assert_eq!(report.sheet_rewrites[0].historic_canonicals, vec!["S"]);
}

// ===== Test 2: Transitive chain (sequential renames) =====

/// **Step 3:** sequential rename chain S → S2 → S3 (single peer
/// across multiple ops). Peer B (forked at base) writes `=S!A1`.
/// Repair should rewrite the formula to `=S3!A1` (the final name)
/// since "S" is no longer current.
#[test]
fn repair_handles_transitive_chain_to_final_name() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A: chain S → S2 → S3.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S2".to_owned(),
            new_name: "S3".to_owned(),
        })
        .unwrap();

    // Peer B: concurrent formula referencing original name.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // Formula rewritten directly to the final name S3 (skipping S2).
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S3!A1".to_string()),
        "transitive chain: S → S2 → S3 rewrites S references directly to S3"
    );
}

// ===== Test 3: Rename-back (chain collapses) =====

/// **Step 3:** rename-back chain S → S2 → S. Peer B writes
/// `=S2!A1` (referencing the intermediate). After repair:
/// formula references S (the current name), because S2 is now a
/// historic name in the chain.
#[test]
fn repair_handles_rename_back_intermediate_reference() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A: S → S2 → S (final = original).
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S2".to_owned(),
            new_name: "S".to_owned(),
        })
        .unwrap();

    // Peer B references the INTERMEDIATE name S2.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S2!A1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    assert_eq!(wb.sheet(0).unwrap().name(), "S");

    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // S2 was historic; repair rewrites S2 → S (current name).
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S!A1".to_string()),
        "rename-back: S2 references rewritten to current name S"
    );
}

// ===== Test 4: No-op case — formula references unrenamed sheet =====

/// **Step 3:** formula references a sheet that was NEVER renamed.
/// Repair must be a no-op for that formula. Pins idempotency of the
/// helper's None-on-no-change return.
#[test]
fn repair_leaves_unrelated_formulas_unchanged() {
    // Base: two sheets S (id 0) + T (id 1).
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::AddSheet {
            name: "T".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    // Peer A: rename S → S2 (id 0).
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();

    // Peer B: formula on T referencing T (unrelated to rename).
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 1,
            row: 0,
            col: 0,
            text: "T!B1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // T!B1 untouched.
    assert_eq!(
        wb.formula_at(1, 0, 0).map(|s| s.to_string()),
        Some("T!B1".to_string()),
        "formula on unrenamed sheet must NOT be rewritten"
    );
    assert_eq!(
        report.formulas_rewritten, 0,
        "no formula references the renamed sheet's old name"
    );
}

// ===== Test 5: Idempotency =====

/// **Step 3:** running repair TWICE produces the same result as
/// running it once. Pins the no-op-on-no-change property — critical
/// for callers that might invoke repair multiple times during a
/// session.
#[test]
fn repair_is_idempotent() {
    let base = base_with_sheet("S").export_bytes().unwrap();
    let log = merged_log_with_concurrent_ops(
        &base,
        Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S!A1".to_owned(),
        },
    );

    let mut wb = replay_to_workbook(&log);
    let first = repair_sheet_rename_chain(&mut wb, &log).unwrap();
    let after_first = wb.formula_at(0, 0, 0).map(|s| s.to_string());

    let second = repair_sheet_rename_chain(&mut wb, &log).unwrap();
    let after_second = wb.formula_at(0, 0, 0).map(|s| s.to_string());

    assert_eq!(first.formulas_rewritten, 1);
    assert_eq!(
        second.formulas_rewritten, 0,
        "second repair pass must be a no-op (helper returns None on no-change)"
    );
    assert_eq!(
        after_first, after_second,
        "formula text stable across repeated repair calls"
    );
}

// ===== Test 6: Empty log =====

/// **Step 3:** no rename ops in the log → repair is trivial no-op.
#[test]
fn repair_with_no_renames_is_noop() {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log.append(Op::PutFormula {
        sheet: 0,
        row: 0,
        col: 0,
        text: "S!A1".to_owned(),
    })
    .unwrap();

    let mut wb = replay_to_workbook(&log);
    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair on no-rename log");

    assert_eq!(report.formulas_rewritten, 0);
    assert!(report.sheet_rewrites.is_empty());
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S!A1".to_string())
    );
}

// ===== Test 7: Step 2 auto-disambiguation chain =====

/// **Step 3 + step-2-audit interaction**: two peers concurrently
/// rename DIFFERENT sheets to the SAME target. Step 2's auto-
/// disambiguation suffixes the second to `X(2)`. Peer C writes
/// `=S3!A1` referencing sheet 1's original name. After merge +
/// repair, the formula should rewrite to the current name of
/// sheet 1, which is `X(2)`.
#[test]
fn repair_handles_step2_auto_disambiguation_suffix() {
    // Base: 2 sheets (S1 = id 0, S3 = id 1).
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::AddSheet {
            name: "S3".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    // Peer A: rename sheet 0 (S1) → X.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S1".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    // Peer B: rename sheet 1 (S3) → X (concurrent, target collision
    // triggers step 2 auto-rename to X(2)). Also writes a formula
    // referencing the OLD name S3.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameSheet {
            id: 1,
            old_name: "S3".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    peer_b
        .append(Op::PutFormula {
            sheet: 1,
            row: 0,
            col: 0,
            text: "S3!B1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    // Sheet 0 = "X" (peer A's rename), sheet 1 = "X(2)" (auto-disambig).
    assert_eq!(wb.sheet(0).unwrap().name(), "X");
    assert_eq!(wb.sheet(1).unwrap().name(), "X(2)");

    repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // Sheet 1's formula referencing old S3 → rewritten to current X(2).
    // Formula syntax requires quoting sheet names containing `(` or `)`,
    // so the printer emits `'X(2)'!B1` (single-quoted), NOT `X(2)!B1`.
    // This is correct canonical form for the formula language.
    let formula_text = wb.formula_at(1, 0, 0).map(|s| s.to_string());
    assert_eq!(
        formula_text,
        Some("'X(2)'!B1".to_string()),
        "repair must rewrite to the auto-disambiguated current name X(2) \
         (single-quoted because '(' requires quoting in formula syntax)"
    );
}

// ===== Test 8: BatchCommit-wrapped rename =====

/// **Step 3:** the producer-side rename emits in a `BatchCommit`
/// (rename + formula rewrites together). Our repair must traverse
/// BatchCommits to find nested `Op::RenameSheet`.
#[test]
fn repair_walks_batchcommit_nested_renames() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A: rename via BatchCommit (mirrors producer pattern).
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::BatchCommit {
            ops: vec![Op::RenameSheet {
                id: 0,
                old_name: "S".to_owned(),
                new_name: "Renamed".to_owned(),
            }],
        })
        .unwrap();

    // Peer B: concurrent formula referencing old name.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
    assert_eq!(
        report.formulas_rewritten, 1,
        "BatchCommit-nested RenameSheet must be discovered by the chain walker"
    );
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("Renamed!A1".to_string())
    );
}

// ===== Test 9: Bidirectional merge convergence =====

/// **Step 3:** repair must be deterministic across merge directions.
/// Both peers, after merging each other's bytes + running repair,
/// must observe identical formula text.
#[test]
fn repair_converges_across_merge_directions() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A's view: rename + put_value (for cell to reference).
    // Peer B's view: formula referencing S.
    let op_a = Op::RenameSheet {
        id: 0,
        old_name: "S".to_owned(),
        new_name: "S2".to_owned(),
    };
    let op_b = Op::PutFormula {
        sheet: 0,
        row: 0,
        col: 0,
        text: "S!A1".to_owned(),
    };

    // Direction 1: A merges B.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a.append(op_a.clone()).unwrap();
    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    peer_b_for_a.append(op_b.clone()).unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();
    let mut wb_a = replay_to_workbook(&peer_a);
    repair_sheet_rename_chain(&mut wb_a, &peer_a).unwrap();

    // Direction 2: B merges A.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b.append(op_b).unwrap();
    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
    peer_a_for_b.append(op_a).unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .unwrap();
    let mut wb_b = replay_to_workbook(&peer_b);
    repair_sheet_rename_chain(&mut wb_b, &peer_b).unwrap();

    assert_eq!(
        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
        wb_b.formula_at(0, 0, 0).map(|s| s.to_string()),
        "bidirectional convergence: formula text matches across merge directions"
    );
    assert_eq!(
        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S2!A1".to_string())
    );
}

// ===== Test 10: RepairReport structure =====

/// **Step 3:** verify the report's structure carries useful diagnostic
/// information for callers (no-fallback rule — surface what was done).
#[test]
fn repair_report_carries_diagnostic_information() {
    let base = base_with_sheet("Sheet1").export_bytes().unwrap();

    let log = merged_log_with_concurrent_ops(
        &base,
        Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Calculations".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "Sheet1!A1+Sheet1!B2".to_owned(),
        },
    );

    let mut wb = replay_to_workbook(&log);
    let report: RepairReport = repair_sheet_rename_chain(&mut wb, &log).unwrap();

    assert_eq!(report.formulas_rewritten, 1);
    assert_eq!(report.sheet_rewrites.len(), 1);
    let summary = &report.sheet_rewrites[0];
    assert_eq!(summary.sheet, 0);
    assert_eq!(summary.current_display_name, "Calculations");
    // historic_canonicals contains "SHEET1" (canonical uppercase).
    assert_eq!(summary.historic_canonicals, vec!["SHEET1"]);

    // Verify the formula now references "Calculations" (both occurrences).
    let f = wb.formula_at(0, 0, 0).unwrap();
    assert!(f.contains("Calculations"), "got: {f}");
    assert!(!f.contains("Sheet1"), "got: {f}");
}
