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
//! Coverage of the 8-row matrix at `crdt-data-model.md:320-329`:
//! - Row 1: PutValue × PutValue same address — pinned here
//! - Row 2: PutFormula × PutFormula same address — pinned here
//! - Row 3: PutValue × PutFormula same address — pinned here
//! - Row 4: ClearFormula × PutFormula same address — pinned here
//! - Row 5: SetName concurrent same name — pinned here
//! - Row 6: AddSheet × AddSheet same name (D-2 auto-rename) — pinned here
//! - Row 7: RenameSheet × concurrent edit on sheet — **pinned here as
//!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
//!   step 3 ships the rename-repair pass which will MODIFY this test
//!   to assert the post-fix behavior (formula text rewritten,
//!   correct value resolves).
//! - Row 8: DropTable × concurrent edit referencing T — pinned here
//!   (D-3 → #NAME?; no repair planned — drop is destructive)
//!
//! "Last-in-causal-order wins" means the CRDT picks ONE value
//! deterministically; both merge directions converge to the same
//! state. The tests verify CONVERGENCE (both peers see the same
//! final state) — they don't predict WHICH op wins (that depends
//! on Loro's internal peer-id tiebreaker, which we don't pin).
//!
//! Audit-discipline NOTE (step 1 audit closure, both Codex HIGH
//! and Opus HIGH-1): value-only assertions are NOT load-bearing.
//! A test that checks `Value::Number(7.0)` after concurrent
//! literal-7 and formula-3+4 cannot distinguish which op won
//! (both produce 7.0) AND would pass even if structural state
//! diverges (e.g. peer A has formula_at=None, peer B has
//! formula_at=Some). Convergence tests at the same address MUST
//! additionally assert `formula_at` convergence to pin structural
//! state, and SHOULD use distinct observable values (literal=7
//! and formula="99-50"=49).

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
fn fork_apply_merge_both_directions(base_bytes: &[u8], op_a: Op, op_b: Op) -> (Workbook, Workbook) {
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
///
/// **Audit closure (Codex MEDIUM-2):** strengthened with `formula_at`
/// convergence so a regression that breaks structural state (e.g.,
/// peer A keeps "1+1" while peer B keeps "2+2") trips the test even
/// if both happen to evaluate to the same value.
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
    let f_a = wb_a.formula_at(0, 0, 0).map(|s| s.to_string());
    let f_b = wb_b.formula_at(0, 0, 0).map(|s| s.to_string());

    assert_eq!(a1_a, a1_b, "convergence on A1 value");
    assert_eq!(
        f_a, f_b,
        "convergence on A1 formula text (both peers must agree on which formula won)"
    );
    // Formula evaluates: =1+1 → 2.0 or =2+2 → 4.0.
    assert!(
        matches!(a1_a, Value::Number(n) if n == 2.0 || n == 4.0),
        "A1 must be 2.0 (from 1+1) or 4.0 (from 2+2); got {a1_a:?}"
    );
    // Structural: formula_at must be Some(winner-text) — both peers
    // agree on which formula won and store the same text.
    let f_text = f_a.expect("PutFormula winner must leave formula_at = Some(text)");
    assert!(
        f_text == "1+1" || f_text == "2+2",
        "formula_at must be one of the two raced texts; got {f_text:?}"
    );
}

// ===== Row 3: PutValue × PutFormula same address =====

/// **Conflict-matrix row 3:** peer A writes literal at A1, peer B
/// writes formula at A1. The design-doc claim: "replay applies both
/// and recompute observes final state."
///
/// **Audit closure (Codex HIGH + Opus HIGH-1):** the original test
/// used literal=7.0 + formula="3+4" — both collapsed to Value::Number(7.0)
/// so the assertion couldn't distinguish winners. WORSE, replay
/// `PutValue` does NOT clear `formula_cells` (workbook.rs put_at
/// preserves formula text by design), so the cell can have BOTH
/// user_overlay=7.0 AND formula_at=Some("3+4") regardless of causal
/// order. Recompute then resolves based on read-cascade priority,
/// hiding structural divergence behind the same observable value.
///
/// Closure: use DISTINCT values (literal=7.0; formula="99-50"=49.0)
/// AND assert structural `formula_at` convergence so a regression
/// where peers diverge on structural state trips the test even if
/// values happen to match.
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
            text: "99-50".to_owned(),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));
    let f_a = wb_a.formula_at(0, 0, 0).map(|s| s.to_string());
    let f_b = wb_b.formula_at(0, 0, 0).map(|s| s.to_string());

    // Convergence on VALUE — both peers compute the same A1.
    assert_eq!(a1_a, a1_b, "convergence on A1 value");
    // Convergence on STRUCTURAL STATE — both peers agree on whether
    // a formula is attached, and if so its text. This is the load-
    // bearing assertion the original test was missing.
    assert_eq!(
        f_a, f_b,
        "convergence on A1 formula_at (peers must agree on structural state, \
         not just observable value)"
    );

    // Now disambiguate: distinct values let us reason about which won.
    // - Literal wins → A1 read = 7.0
    // - Formula wins → A1 read = 49.0
    match a1_a {
        Value::Number(7.0) => {
            // Literal-wins case. NOTE: `formula_at` may STILL be
            // Some("99-50") because put_at doesn't clear formula text
            // (workbook.rs:809-814 — intentional, supports formula+value
            // coexistence). The read-cascade prefers user_overlay over
            // computed-overlay when both are present. This is structural
            // "accumulation" not "divergence" — both peers see the same
            // accumulation.
        }
        Value::Number(49.0) => {
            // Formula-wins case. formula_at MUST be Some("99-50").
            assert_eq!(
                f_a.as_deref(),
                Some("99-50"),
                "formula-wins case requires formula_at=Some(\"99-50\"); got {f_a:?}"
            );
        }
        other => panic!(
            "A1 must be Number(7.0) (literal wins) or Number(49.0) (formula wins); got {other:?}"
        ),
    }
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
    let f_a = wb_a.formula_at(0, 0, 0).map(|s| s.to_string());
    let f_b = wb_b.formula_at(0, 0, 0).map(|s| s.to_string());

    assert_eq!(a1_a, a1_b, "convergence on A1 value");
    // Audit closure (Codex MEDIUM-2): also pin structural convergence
    // — peers must agree on whether the formula was cleared.
    assert_eq!(
        f_a, f_b,
        "convergence on A1 formula_at (peers must agree on whether the formula \
         was cleared or overwritten)"
    );

    // Disambiguate structurally:
    // - ClearFormula wins → formula_at == None, value == Blank
    // - PutFormula wins → formula_at == Some("10+10"), value == 20.0
    match (a1_a.clone(), f_a.as_deref()) {
        (Value::Blank, None) => { /* ClearFormula won */ }
        (Value::Number(20.0), Some("10+10")) => { /* PutFormula won */ }
        (val, ftext) => panic!(
            "A1 must be (Blank, None) for ClearFormula-wins OR \
             (Number(20.0), Some(\"10+10\")) for PutFormula-wins; \
             got ({val:?}, {ftext:?})"
        ),
    }
}

// ===== Row 5: SetName concurrent same name =====

/// **Conflict-matrix row 5:** two peers concurrently SetName the
/// same name "TaxRate" with different constant values. Last-in-
/// causal-order wins; convergent across merge directions.
///
/// **Audit closure (Codex LOW-2 + Opus MEDIUM-3):** the original
/// test bundled SetName + PutFormula per peer in a BatchCommit,
/// which changes the Loro conflict unit. The cleaner pattern (and
/// what the matrix row LITERALLY describes) is racing only the
/// SetName ops — the PutFormula `=TaxRate` lives in the BASE log
/// as a shared causal ancestor.
#[test]
fn row5_setname_concurrent_same_name_converges() {
    // Bake the `=TaxRate` reference at A1 into the base log so the
    // formula text is identical across peers and only the SetName
    // ops race.
    let mut base_log = base_with_sheet();
    base_log
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "TaxRate".to_owned(),
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::SetName {
            scope: None,
            name: "TaxRate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.21),
            },
        },
        Op::SetName {
            scope: None,
            name: "TaxRate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.42),
            },
        },
    );

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

    // **Audit closure (Codex LOW-1):** assert exact convergence on
    // the name set + ordering, not just "both names present in each
    // peer's view." A regression that left peers with different
    // sheet-id → name mappings would pass the looser check.
    let names_a: Vec<String> = (0..wb_a.sheet_count() as u16)
        .map(|i| wb_a.sheet(i).unwrap().name().to_owned())
        .collect();
    let names_b: Vec<String> = (0..wb_b.sheet_count() as u16)
        .map(|i| wb_b.sheet(i).unwrap().name().to_owned())
        .collect();

    assert_eq!(
        names_a, names_b,
        "convergence: both peers' sheet-id → name mappings must match exactly"
    );
    // After D-2 auto-rename, exact result is {Calc, Calc(2)} in
    // sheet-id order. Loro's causal merge picks the same first-wins
    // outcome for both peers (we don't predict WHICH peer became
    // Calc(2), but both peers agree).
    assert_eq!(
        names_a,
        vec!["Calc".to_string(), "Calc(2)".to_string()],
        "D-2 auto-rename: sheets must be [Calc, Calc(2)] in id order; got {names_a:?}"
    );
}

// ===== Row 7: RenameSheet × concurrent edit on sheet (POST-STEP-3) =====

/// **Conflict-matrix row 7 (Phase 5.3 step 3 — REPAIR PASS APPLIED):**
/// peer A renames sheet "S" to "S2"; peer B concurrently writes a
/// formula at A2 referencing "S!A1" (the old name). After merge +
/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
/// text is REWRITTEN to "S2!A1" and the cell resolves to 42.0 (the
/// literal at S2!A1, originally at S!A1 before rename).
///
/// **Pre-step-3 behavior** (kept here as historical context):
/// without the repair pass, the formula bind-failed at recompute →
/// `Value::Error(ErrorValue::Name)` per the D-3 V1 limitation. Step
/// 3's rename-repair pass closes that limitation.
///
/// **Test is intentionally bidirectional via `fork_apply_merge_both_directions`**
/// — both peers, after merge + repair, must converge to the same
/// formula text + resolved value.
#[test]
fn row7_rename_sheet_concurrent_edit_resolves_via_repair_pass() {
    // Base: sheet S with a literal at S!A1 = 42.0.
    let mut base_log = base_with_sheet();
    base_log
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    // Use the bidirectional helper to fork the two peers + apply
    // their concurrent ops + cross-merge — but we have to interpose
    // the repair pass between replay and recompute. The fork helper
    // doesn't know about repair (it's a step-2-and-earlier helper),
    // so we duplicate its logic inline here for the step 3 case.
    let mut peer_a = OpLog::import_bytes(&base).unwrap();
    peer_a.set_peer_id(1).unwrap();
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
    peer_b_for_a.set_peer_id(2).unwrap();
    peer_b_for_a
        .append(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();

    // Symmetric peer B view.
    let mut peer_b = OpLog::import_bytes(&base).unwrap();
    peer_b.set_peer_id(2).unwrap();
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();
    let mut peer_a_for_b = OpLog::import_bytes(&base).unwrap();
    peer_a_for_b.set_peer_id(1).unwrap();
    peer_a_for_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .unwrap();

    // Replay + REPAIR PASS (Phase 5.3 step 3 work) + recompute.
    let replay_repair_recompute = |log: &OpLog| -> Workbook {
        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(log, &mut wb, &reg).expect("replay must succeed");
        // **Step 3 closure point**: the repair pass rewrites concurrent
        // formula text referencing pre-rename sheet names. Without
        // this call, recompute would surface #NAME? (D-3 V1 limitation).
        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
            .expect("repair_sheet_rename_chain must succeed");
        assert_eq!(
            report.formulas_rewritten, 1,
            "exactly 1 formula (peer B's =S!A1) must be rewritten"
        );
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.recompute_all();
        }
        wb
    };

    let wb_a = replay_repair_recompute(&peer_a);
    let wb_b = replay_repair_recompute(&peer_b);

    let a2_a = wb_a.read(Address::new(0, 1, 0));
    let a2_b = wb_b.read(Address::new(0, 1, 0));

    assert_eq!(a2_a, a2_b, "convergence on S2!A2 across merge directions");
    // **POST-STEP-3 assertion**: repair rewrote `S!A1` → `S2!A1`; the
    // cell at S2!A1 is the literal 42.0 from the base log.
    assert_eq!(
        a2_a,
        Value::Number(42.0),
        "post-repair: formula resolves correctly via rewritten text (S!A1 → S2!A1); \
         got {a2_a:?}. Without the repair pass, this would be #NAME? (D-3 V1 limitation)."
    );

    // Pin the formula text directly to confirm the repair did its job.
    assert_eq!(
        wb_a.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("S2!A1".to_string()),
        "formula text post-repair must reference current sheet name (S2)"
    );
}

// ===== Row 8: DropTable × concurrent edit referencing T =====

/// **Conflict-matrix row 8:** peer A drops table T; peer B
/// concurrently writes a formula referencing T at A5 (outside the
/// table footprint). After merge: T is dropped + formula's
/// `T[X]` reference binds to UnknownTable → recompute emits
/// `#NAME?` (D-3 mapping `e71312d4bcd` shipped).
///
/// **Audit closure (Codex finding on row 7→8 numbering)**: this
/// test was originally labeled "row 7" but the design doc has
/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).
/// Renumbered to match the design doc.
///
/// **Audit closure (Codex finding on direction-independence)**:
/// the original test claimed "DropTable wins deterministically"
/// — imprecise. The correct statement: BOTH ops apply (DropTable
/// removes the table; PutFormula adds the formula text). At
/// recompute, the formula binds against current table table (which
/// no longer contains T) regardless of causal order → #NAME? is
/// direction-independent.
#[test]
fn row8_droptable_vs_concurrent_table_ref_yields_name_error() {
    let base = base_with_sheet_and_table().export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::DropTable {
            name: "T".to_owned(),
        },
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

/// **Determinism boost:** after a same-address PutValue merge,
/// export the merged log and reload into a fresh `Workbook`. The
/// reload must produce the same A1 value — pins that the merged
/// log is replay-stable (matches D-4's
/// `d4_replay_of_merged_log_is_deterministic_across_runs` pattern).
///
/// **Audit closure (Opus LOW-1):** switched to `fork_with_peer` for
/// discipline consistency. The original test used raw
/// `OpLog::import_bytes` without `set_peer_id` — it happened to pass
/// because the assertion is single-direction (no bidirectional
/// merge), but a future maintainer copy-pasting this as a bidirec-
/// tional test template would silently get random peer-ids and trip
/// convergence. Using `fork_with_peer` makes the pattern uniform.
#[test]
fn merged_log_round_trips_deterministically() {
    let base = base_with_sheet().export_bytes().unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
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
