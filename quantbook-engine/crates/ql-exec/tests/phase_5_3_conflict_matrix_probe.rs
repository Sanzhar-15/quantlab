//! Phase 5.3 conflict-matrix probe tests — pin the audit-locked
//! "last-in-causal-order wins" defaults from `crdt-data-model.md`
//! § Conflict resolution semantics (Phase 5.3 preview).
//!
//! Most rows in the matrix are correct by Loro's underlying CRDT
//! merge (Fugue/origin-based with peer-id tiebreaker). These tests
//! make that load-bearing — any future regression in either Loro's
//! semantics OR our op-replay path trips a test.
//!
//! Pattern: D-4's `phase_5_2_d4_spill_2peer_probe.rs` template.
//! Each test:
//!   1. Build a shared base log (common causal ancestor).
//!   2. Fork peer A + peer B by `import_bytes(&base_bytes)`.
//!   3. Each peer appends its local op.
//!   4. Exchange via `export_bytes` + `merge_bytes` — in BOTH
//!      directions when the test verifies convergence.
//!   5. Replay + recompute via `replay_and_recompute`.
//!   6. Assert final workbook state.
//!
//! Coverage matches the design doc table at `crdt-data-model.md:320-329`:
//! - Row 1: PutValue × PutValue same address
//! - Row 2: PutFormula × PutFormula same address
//! - Row 3: PutValue × PutFormula same address
//! - Row 4: ClearFormula × PutFormula same address
//! - Row 5: SetName concurrent same name
//! - Row 6: AddSheet × AddSheet same name (D-2 auto-rename — pin)
//! - Row 7: DropTable × concurrent edit referencing T (D-3 → #NAME?)
//!
//! "Last-in-causal-order wins" means the CRDT picks ONE value
//! deterministically; both merge directions converge to the same
//! state. The tests verify CONVERGENCE (both peers see the same
//! final state) — they don't predict WHICH op wins (that depends
//! on Loro's internal peer-id tiebreaker, which we don't pin).

use ql_exec::WorkbookRuntime;
use ql_functions::default_registry;
use ql_oplog::{replay_into, CellWireValue, NamedTargetWire, Op, OpLog};
use ql_storage::Workbook;
use ql_types::{Address, ErrorValue, Value};

/// Build a base op log carrying `AddSheet("S")`. Most tests fork
/// from this; the AddSheet × AddSheet test bypasses it (since it
/// needs to test sheet-name collision directly).
fn base_with_sheet() -> OpLog {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log
}

/// Build a base op log with sheet "S" + a `CreateTable("T")`
/// covering A1:B3 with header row. Used by the DropTable conflict
/// test (row 7).
fn base_with_sheet_and_table() -> OpLog {
    let mut log = base_with_sheet();
    log.append(Op::CreateTable {
        name: "T".to_owned(),
        sheet: 0,
        top_row: 0,
        top_col: 0,
        rows: 3,
        cols: 2,
        has_header: true,
        has_totals: false,
        column_names: vec!["X".to_owned(), "Y".to_owned()],
    })
    .unwrap();
    log
}

/// Replay log into a fresh workbook + recompute. Mirror of D-4's
/// helper.
fn replay_and_recompute(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    let reg = default_registry();
    replay_into(log, &mut wb, &reg).expect("replay should succeed");
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.recompute_all();
    }
    wb
}

/// Stable peer ids for the two-peer fork. Loro's CRDT tiebreaker
/// picks deterministic order ONLY when peer-ids are stable across
/// the merge — if both directions use random `LoroDoc::new()` ids,
/// the (peer-id pair) differs across directions and convergence
/// breaks. PEER_A_ID < PEER_B_ID makes the order observable.
///
/// Both ids are non-zero (LEGACY_PEER reservation — `set_peer_id(0)`
/// asserts post-step-8 audit closure).
const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

/// Build a freshly-forked `OpLog` carrying `base_bytes` and a fixed
/// peer-id. New ops appended to this log carry `peer_id` in their
/// Loro op-ids; the imported base ops retain their original peer-id
/// (Loro semantic — import preserves origin).
fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    log.set_peer_id(peer_id)
        .expect("set_peer_id with non-zero id must succeed");
    log
}

/// Fork two peers from `base_bytes` with STABLE peer-ids, apply
/// `op_a` on peer A (id = `PEER_A_ID`) and `op_b` on peer B
/// (id = `PEER_B_ID`), then merge bidirectionally. Returns the two
/// replayed+recomputed workbooks `(wb_after_a_merges_b,
/// wb_after_b_merges_a)`. The convergence property asserts these
/// produce identical observable state.
fn fork_apply_merge_both_directions(
    base_bytes: &[u8],
    op_a: Op,
    op_b: Op,
) -> (Workbook, Workbook) {
    // Peer A's view: id=1, appends op_a, merges peer B's bytes.
    let mut peer_a = fork_with_peer(base_bytes, PEER_A_ID);
    peer_a.append(op_a.clone()).unwrap();

    let mut peer_b_for_a = fork_with_peer(base_bytes, PEER_B_ID);
    peer_b_for_a.append(op_b.clone()).unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();

    // Peer B's view: id=2, appends op_b, merges peer A's bytes.
    let mut peer_b = fork_with_peer(base_bytes, PEER_B_ID);
    peer_b.append(op_b).unwrap();

    let mut peer_a_for_b = fork_with_peer(base_bytes, PEER_A_ID);
    peer_a_for_b.append(op_a).unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .unwrap();

    (replay_and_recompute(&peer_a), replay_and_recompute(&peer_b))
}

// ===== Row 1: PutValue × PutValue same address =====

/// **Conflict-matrix row 1:** two peers each write a literal at A1.
/// Loro's Fugue/origin-based merge picks one deterministically; both
/// merge directions converge to the same final value.
#[test]
fn row1_putvalue_concurrent_same_address_converges() {
    let base = base_with_sheet().export_bytes().unwrap();
    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        },
        Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(2.0),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));

    assert_eq!(
        a1_a, a1_b,
        "convergence: both merge directions must produce the same A1 value"
    );
    // The winner is one of {1.0, 2.0}; we don't predict which.
    assert!(
        matches!(a1_a, Value::Number(n) if n == 1.0 || n == 2.0),
        "A1 must be one of the concurrently-written values; got {a1_a:?}"
    );
}

// ===== Row 2: PutFormula × PutFormula same address =====

/// **Conflict-matrix row 2:** two peers each write a formula at A1.
/// Last-in-causal-order wins; convergent across merge directions.
#[test]
fn row2_putformula_concurrent_same_address_converges() {
    let base = base_with_sheet().export_bytes().unwrap();
    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "1+1".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "2+2".to_owned(),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));

    assert_eq!(a1_a, a1_b, "convergence on A1");
    // Formula evaluates: =1+1 → 2.0 or =2+2 → 4.0.
    assert!(
        matches!(a1_a, Value::Number(n) if n == 2.0 || n == 4.0),
        "A1 must be 2.0 (from 1+1) or 4.0 (from 2+2); got {a1_a:?}"
    );
}

// ===== Row 3: PutValue × PutFormula same address =====

/// **Conflict-matrix row 3:** peer A writes literal at A1, peer B
/// writes formula at A1. The design-doc claim: "replay applies both
/// and recompute observes final state." Concretely — either the
/// literal wins (final value = the literal) or the formula wins
/// (final value = the formula's evaluation). Convergent across
/// merge directions.
#[test]
fn row3_putvalue_vs_putformula_same_address_converges() {
    let base = base_with_sheet().export_bytes().unwrap();
    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(7.0),
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "3+4".to_owned(),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));

    assert_eq!(a1_a, a1_b, "convergence on A1");
    // Both winners produce 7.0 (the literal OR the formula 3+4=7).
    assert_eq!(
        a1_a,
        Value::Number(7.0),
        "A1 should resolve to 7.0 (literal=7 OR formula=3+4); got {a1_a:?}"
    );
}

// ===== Row 4: ClearFormula × PutFormula same address =====

/// **Conflict-matrix row 4:** peer A writes formula at A1 then
/// clears it; peer B writes a different formula at A1 concurrently.
/// Last-in-causal-order wins. After convergence, A1 is either Blank
/// (cleared) or the peer-B formula's evaluation.
///
/// Note: ClearFormula needs a prior PutFormula to clear. We bake
/// the prior PutFormula into the BASE log (both peers see it as
/// causal ancestor), then peer A clears + peer B overwrites
/// concurrently.
#[test]
fn row4_clearformula_vs_putformula_same_address_converges() {
    let mut base_log = base_with_sheet();
    base_log
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "1+1".to_owned(),
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::ClearFormula {
            sheet: 0,
            row: 0,
            col: 0,
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "10+10".to_owned(),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));

    assert_eq!(a1_a, a1_b, "convergence on A1");
    // ClearFormula wins → cell is Blank (the prior PutFormula's
    // text is removed, no other literal exists).
    // PutFormula wins → cell evaluates to 20.0.
    assert!(
        matches!(a1_a, Value::Blank) || a1_a == Value::Number(20.0),
        "A1 must be Blank (ClearFormula wins) or 20.0 (PutFormula wins); got {a1_a:?}"
    );
}

// ===== Row 5: SetName concurrent same name =====

/// **Conflict-matrix row 5:** two peers concurrently SetName the
/// same name "TaxRate" with different constant values. Last-in-
/// causal-order wins; convergent across merge directions.
///
/// Verification: we route TaxRate through a formula `=TaxRate` at
/// A1 (the test writes the PutFormula on each peer post-fork too,
/// so the formula text is uniformly present and recompute can read
/// the final NameTable value).
#[test]
fn row5_setname_concurrent_same_name_converges() {
    let base = base_with_sheet().export_bytes().unwrap();

    // Each peer concurrently SetName "TaxRate" to a different
    // constant. We bundle the PutFormula `=TaxRate` at A1 into both
    // peers' op streams so it lands in the merged log identically
    // — its value at recompute time depends on whichever SetName
    // wins.
    let op_a = Op::BatchCommit {
        ops: vec![
            Op::SetName {
                scope: None,
                name: "TaxRate".to_owned(),
                target: NamedTargetWire::Constant {
                    value: CellWireValue::Number(0.21),
                },
            },
            Op::PutFormula {
                sheet: 0,
                row: 0,
                col: 0,
                text: "TaxRate".to_owned(),
            },
        ],
    };
    let op_b = Op::BatchCommit {
        ops: vec![
            Op::SetName {
                scope: None,
                name: "TaxRate".to_owned(),
                target: NamedTargetWire::Constant {
                    value: CellWireValue::Number(0.42),
                },
            },
            Op::PutFormula {
                sheet: 0,
                row: 0,
                col: 0,
                text: "TaxRate".to_owned(),
            },
        ],
    };
    let (wb_a, wb_b) = fork_apply_merge_both_directions(&base, op_a, op_b);

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));

    assert_eq!(a1_a, a1_b, "convergence on TaxRate value");
    assert!(
        matches!(a1_a, Value::Number(n) if (n - 0.21).abs() < 1e-9 || (n - 0.42).abs() < 1e-9),
        "TaxRate resolves to 0.21 or 0.42; got {a1_a:?}"
    );
}

// ===== Row 6: AddSheet × AddSheet same name (D-2 auto-rename) =====

/// **Conflict-matrix row 6:** two peers each AddSheet with the
/// same name. Phase 5.2 D-2 (`1ca19e2fa37`) shipped the auto-
/// rename behavior — the second add in causal order becomes
/// `<name>(2)`. This test pins it: after merge, BOTH sheets exist
/// (no rejection); the second carries `(2)` suffix.
#[test]
fn row6_addsheet_same_name_auto_renames_via_d2() {
    // Empty base — no AddSheet here; both peers contribute one.
    let base = OpLog::new().export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::AddSheet {
            name: "Calc".to_owned(),
            chunk_rows: 16384,
        },
        Op::AddSheet {
            name: "Calc".to_owned(),
            chunk_rows: 16384,
        },
    );

    // After merge, both peers have 2 sheets named "Calc" and
    // "Calc(2)" in some order. Sheet count must be 2; both names
    // must be present in the final workbook.
    assert_eq!(wb_a.sheet_count(), 2, "after merge wb_a should have 2 sheets");
    assert_eq!(wb_b.sheet_count(), 2, "after merge wb_b should have 2 sheets");

    let names_a: Vec<String> = (0..wb_a.sheet_count() as u16)
        .map(|i| wb_a.sheet(i).unwrap().name().to_owned())
        .collect();
    let names_b: Vec<String> = (0..wb_b.sheet_count() as u16)
        .map(|i| wb_b.sheet(i).unwrap().name().to_owned())
        .collect();

    assert!(
        names_a.contains(&"Calc".to_owned()) && names_a.contains(&"Calc(2)".to_owned()),
        "wb_a sheet names must be {{Calc, Calc(2)}}; got {names_a:?}"
    );
    assert!(
        names_b.contains(&"Calc".to_owned()) && names_b.contains(&"Calc(2)".to_owned()),
        "wb_b sheet names must be {{Calc, Calc(2)}}; got {names_b:?}"
    );
}

// ===== Row 7: DropTable × concurrent edit referencing T =====

/// **Conflict-matrix row 7:** peer A drops table T; peer B
/// concurrently writes a formula referencing T at A5 (outside the
/// table footprint). After merge: T is dropped + formula's
/// `T[X]` reference binds to UnknownTable → recompute emits
/// `#NAME?` (D-3 mapping `e71312d4bcd` shipped).
///
/// This test pins D-3 under multi-peer merge. Direction-independent
/// because DropTable wins deterministically (Loro causal order
/// over BOTH peer ops).
#[test]
fn row7_droptable_vs_concurrent_table_ref_yields_name_error() {
    let base = base_with_sheet_and_table().export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::DropTable { name: "T".to_owned() },
        Op::PutFormula {
            sheet: 0,
            row: 4,
            col: 0,
            text: "T[X]".to_owned(),
        },
    );

    let a5_a = wb_a.read(Address::new(0, 4, 0));
    let a5_b = wb_b.read(Address::new(0, 4, 0));

    assert_eq!(a5_a, a5_b, "convergence on A5");

    // T is dropped (DropTable always applies — there's no
    // concurrent "create T" op); formula references T → bind
    // fails → #NAME? per D-3.
    assert_eq!(
        a5_a,
        Value::Error(ErrorValue::Name),
        "A5 must emit #NAME? (D-3: BindError::UnknownTable → ErrorValue::Name); got {a5_a:?}"
    );
}

// ===== Additional: convergence via export round-trip =====

/// **Determinism boost:** after the row 1 merge, export the merged
/// log and reload into a fresh `Workbook`. The reload must produce
/// the same A1 value — pins that the merged log is replay-stable
/// (matches D-4's `d4_replay_of_merged_log_is_deterministic_across_runs`
/// pattern).
#[test]
fn merged_log_round_trips_deterministically() {
    let base = base_with_sheet().export_bytes().unwrap();

    let mut peer_a = OpLog::import_bytes(&base).unwrap();
    peer_a
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        })
        .unwrap();
    let mut peer_b = OpLog::import_bytes(&base).unwrap();
    peer_b
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(2.0),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let wb_first = replay_and_recompute(&peer_a);

    let merged_bytes = peer_a.export_bytes().unwrap();
    let reloaded = OpLog::import_bytes(&merged_bytes).unwrap();
    let wb_second = replay_and_recompute(&reloaded);

    assert_eq!(
        wb_first.read(Address::new(0, 0, 0)),
        wb_second.read(Address::new(0, 0, 0)),
        "merged log replay must be deterministic across export/import round-trip"
    );
}
