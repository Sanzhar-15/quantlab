//! Phase 5.3 step 2 — concurrent RenameSheet replay convergence.
//!
//! Pre-step-2: replay's RenameSheet handler at `replay.rs:486-532`
//! had three cases. Case 3 ("current name matches neither old nor
//! new") returned `ReplayError::SheetRenameNameMismatch`, which
//! **hard-failed replay** under CRDT merge of concurrent renames.
//! E.g., peer A: `RenameSheet { id, old: "S", new: "S2" }`; peer B
//! concurrently issues `RenameSheet { id, old: "S", new: "S3" }`.
//! After Loro's causal merge, whichever rename replays SECOND finds
//! `current != "S"` (already renamed by the first) and `current !=
//! its own new_name` — case 3 — replay errored.
//!
//! Post-step-2: case 3 applies the rename to whatever the sheet
//! currently is. The audit-locked policy from `crdt-data-model.md`
//! § 311-334 — "last-in-causal-order wins" — produces deterministic
//! convergence: both peers, after merging each other's ops, observe
//! the same final sheet name (the winner's new_name).
//!
//! These probes pin the property via the D-4 / step-1 test pattern.
//! `fork_with_peer(base, peer_id)` inlined here because it lives in
//! a different test target (ql-exec); the helper is small enough to
//! duplicate, and keeping these tests in ql-oplog avoids pulling in
//! ql-exec for a replay-layer concern.
//!
//! Convergence still requires stable non-zero peer-ids per
//! `crdt-data-model.md` § "Peer-id stability is a precondition for
//! CRDT convergence" (added by Phase 5.3 step 1 audit closure).

use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
use ql_storage::Workbook;
use ql_types::Address;

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

/// Replay log into a fresh workbook. NOTE: unlike the step 1 probes
/// in `phase_5_3_conflict_matrix_probe.rs`, these tests don't need
/// recompute (we're checking the sheet-name layer, not formula
/// evaluation). So we use `replay_into` directly without pulling in
/// `WorkbookRuntime` / ql-exec.
fn replay_into_fresh(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    // default_registry would require ql-functions; pass an empty
    // registry — replay doesn't call into the function registry
    // anyway (it stores formulas as text, recomputes on demand).
    let reg = ql_functions::default_registry();
    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    wb
}

/// **Step 2 PRIMARY property:** two peers concurrently rename the
/// same sheet to DIFFERENT targets. Replay must NOT hard-fail. The
/// merged log's final sheet name converges across merge directions.
#[test]
fn step2_concurrent_rename_different_targets_converges() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A's view: id=1 renames S → S2, then merges peer B's bytes.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    peer_b_for_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S3".to_owned(),
        })
        .unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .expect("merge_bytes must succeed");

    // Peer B's view: symmetric — id=2 renames S → S3, then merges A.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S3".to_owned(),
        })
        .unwrap();
    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
    peer_a_for_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .expect("merge_bytes must succeed (reverse direction)");

    // **The critical assertion**: replay must succeed (no
    // SheetRenameNameMismatch hard-fail).
    let wb_a = replay_into_fresh(&peer_a);
    let wb_b = replay_into_fresh(&peer_b);

    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
    let name_b = wb_b.sheet(0).unwrap().name().to_owned();

    assert_eq!(
        name_a, name_b,
        "convergence: both peers must observe the same final sheet name"
    );
    // The winner is one of {S2, S3}; we don't predict WHICH (depends
    // on Loro's tiebreaker).
    assert!(
        name_a == "S2" || name_a == "S3",
        "sheet name must be one of the concurrently-written targets; got {name_a:?}"
    );
}

/// **Step 2:** two peers concurrently rename to the SAME target.
/// Trivially idempotent — both ops fold into the same final state.
///
/// **Audit closure (Opus LOW-1):** added bidirectional merge check
/// for discipline consistency with test #1. Pre-closure only checked
/// peer A's view after pulling peer B; symmetric direction omitted.
#[test]
fn step2_concurrent_rename_identical_targets_is_idempotent() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A's view: id=1, rename, then merge B's bytes.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();
    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    peer_b_for_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();

    // Peer B's view: symmetric — id=2, rename, then merge A's bytes.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();
    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
    peer_a_for_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .unwrap();

    let wb_a = replay_into_fresh(&peer_a);
    let wb_b = replay_into_fresh(&peer_b);
    assert_eq!(wb_a.sheet(0).unwrap().name(), "Renamed");
    assert_eq!(wb_b.sheet(0).unwrap().name(), "Renamed");
    assert_eq!(
        wb_a.sheet(0).unwrap().name(),
        wb_b.sheet(0).unwrap().name(),
        "bidirectional convergence: both peers must observe the same final name"
    );
}

/// **Step 2:** sequential rename across peers (peer B SAW peer A's
/// rename before issuing its own). No concurrency — peer B's op has
/// `old_name = "S2"` matching the post-A-rename state. Pinned as a
/// regression baseline: the policy change must NOT break the
/// non-concurrent case.
#[test]
fn step2_sequential_rename_across_peers_converges() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A: rename S → S2.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();

    // Peer B receives peer A's bytes FIRST (sees S2), then renames
    // S2 → S3. This is the sequential (not concurrent) path.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
    peer_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S2".to_owned(),
            new_name: "S3".to_owned(),
        })
        .unwrap();

    // Peer A then receives peer B's full log.
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();

    let wb_a = replay_into_fresh(&peer_a);
    let wb_b = replay_into_fresh(&peer_b);
    assert_eq!(wb_a.sheet(0).unwrap().name(), "S3");
    assert_eq!(wb_b.sheet(0).unwrap().name(), "S3");
}

/// **Step 2:** concurrent rename + concurrent literal write at the
/// renamed sheet. Both ops apply (no hard-fail on either). The
/// literal lives at the renamed sheet's address; sheet name is
/// the rename winner. This is the test row 7 of the conflict
/// matrix pinned ONLY for the rename-doesn't-fail property — full
/// row-7 formula behavior (rewrite to new name) is step 3's work.
///
/// **Audit closure (Opus MEDIUM-2):** added bidirectional merge
/// check. Pre-closure only verified peer A's view after pulling B;
/// symmetric (B merges A) direction omitted. A future regression
/// breaking symmetry would have passed the looser check.
#[test]
fn step2_concurrent_rename_plus_literal_write_both_apply() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A's view: id=1, rename S→S2, then merge B's PutValue.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    peer_b_for_a
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .expect("merge must succeed (A's view)");

    // Peer B's view: id=2, PutValue, then merge A's RenameSheet.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();
    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
    peer_a_for_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .expect("merge must succeed (B's view)");

    let wb_a = replay_into_fresh(&peer_a);
    let wb_b = replay_into_fresh(&peer_b);

    // Bidirectional convergence: sheet name + cell value.
    assert_eq!(
        wb_a.sheet(0).unwrap().name(),
        wb_b.sheet(0).unwrap().name(),
        "bidirectional convergence on sheet name"
    );
    assert_eq!(
        wb_a.read(Address::new(0, 0, 0)),
        wb_b.read(Address::new(0, 0, 0)),
        "bidirectional convergence on cell value"
    );
    // Specific final state: rename applied + literal at sheet 0.
    assert_eq!(wb_a.sheet(0).unwrap().name(), "S2");
    assert_eq!(
        wb_a.read(Address::new(0, 0, 0)),
        ql_types::Value::Number(42.0)
    );
}

/// **Step 2:** triple-peer concurrent rename. All three peers
/// concurrently rename the same sheet to DIFFERENT targets. After
/// merge, all peers must converge on the same name.
///
/// **Audit closure (Opus MEDIUM-3):** the original test used star-
/// merge (every peer pulls every other peer's bytes), but star-merge
/// gives all three peers byte-equivalent merged logs — assertions
/// A==B and B==C are a tautology under that pattern. A real
/// transitivity test exercises DIFFERENT merge sequences (e.g. A
/// merges B then C; B merges C then A; C merges A then B) and
/// asserts the final state still converges. Loro's CRDT semantic
/// SHOULD make this hold via commutativity + associativity of the
/// underlying op apply — but the test must exercise that, not
/// merely the star case.
#[test]
fn step2_three_peer_concurrent_rename_converges() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    const PEER_C_ID: u64 = 3;

    let mk_peer = |peer_id: u64, target: &str| -> OpLog {
        let mut log = fork_with_peer(&base, peer_id);
        log.append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: target.to_owned(),
        })
        .unwrap();
        log
    };

    // Peer A merges B then C (order: BC).
    let mut peer_a_bc = mk_peer(PEER_A_ID, "Apple");
    peer_a_bc
        .merge_bytes(&mk_peer(PEER_B_ID, "Banana").export_bytes().unwrap())
        .unwrap();
    peer_a_bc
        .merge_bytes(&mk_peer(PEER_C_ID, "Cherry").export_bytes().unwrap())
        .unwrap();

    // Peer B merges C then A (order: CA).
    let mut peer_b_ca = mk_peer(PEER_B_ID, "Banana");
    peer_b_ca
        .merge_bytes(&mk_peer(PEER_C_ID, "Cherry").export_bytes().unwrap())
        .unwrap();
    peer_b_ca
        .merge_bytes(&mk_peer(PEER_A_ID, "Apple").export_bytes().unwrap())
        .unwrap();

    // Peer C merges A then B (order: AB).
    let mut peer_c_ab = mk_peer(PEER_C_ID, "Cherry");
    peer_c_ab
        .merge_bytes(&mk_peer(PEER_A_ID, "Apple").export_bytes().unwrap())
        .unwrap();
    peer_c_ab
        .merge_bytes(&mk_peer(PEER_B_ID, "Banana").export_bytes().unwrap())
        .unwrap();

    let wb_a = replay_into_fresh(&peer_a_bc);
    let wb_b = replay_into_fresh(&peer_b_ca);
    let wb_c = replay_into_fresh(&peer_c_ab);

    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
    let name_c = wb_c.sheet(0).unwrap().name().to_owned();

    // **Genuine transitivity test**: 3 peers, 3 different merge
    // orderings (BC vs CA vs AB), all converge to the same final
    // state. Pre-closure star-merge made this assertion trivial.
    assert_eq!(name_a, name_b, "transitivity A(BC) == B(CA)");
    assert_eq!(name_b, name_c, "transitivity B(CA) == C(AB)");
    assert!(
        ["Apple", "Banana", "Cherry"].contains(&name_a.as_str()),
        "winner must be one of the three concurrent renames; got {name_a:?}"
    );
}

/// **Step 2 audit closure (Codex + Opus convergent HIGH-1):** two
/// peers concurrently rename DIFFERENT sheets to the SAME target
/// name. Pre-closure this hard-failed replay via
/// `SheetRenameRejected { source: Duplicate }` — same blast radius
/// as the original step-2 bug it was meant to close, just shifted
/// to a different concurrent scenario.
///
/// Post-closure: replay auto-disambiguates via D-2-style suffix
/// walk (`X` → `X(2)`). Final state has both sheets renamed (one
/// to `X`, the other to `X(2)`), depending on which causal order
/// the merged log applies.
#[test]
fn step2_audit_concurrent_rename_to_same_target_auto_disambiguates() {
    // Base: 3 sheets — peer A renames sheet 0; peer B renames sheet 1.
    // Sheet 2 unused; gives the base "two sheets with distinct names".
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

    // Peer A renames sheet 0 (S1) → X. Peer B (concurrent) renames
    // sheet 1 (S3) → X. Both valid locally; merge must auto-disambiguate.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S1".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    peer_b_for_a
        .append(Op::RenameSheet {
            id: 1,
            old_name: "S3".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .expect("merge must succeed; auto-disambiguation prevents hard-fail");

    // Symmetric direction.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameSheet {
            id: 1,
            old_name: "S3".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
    peer_a_for_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S1".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .expect("merge must succeed (symmetric)");

    let wb_a = replay_into_fresh(&peer_a);
    let wb_b = replay_into_fresh(&peer_b);

    // After merge: one sheet gets "X", the other gets "X(2)". Both
    // peers must converge on the same id→name mapping.
    let names_a: Vec<String> = (0..wb_a.sheet_count() as u16)
        .map(|i| wb_a.sheet(i).unwrap().name().to_owned())
        .collect();
    let names_b: Vec<String> = (0..wb_b.sheet_count() as u16)
        .map(|i| wb_b.sheet(i).unwrap().name().to_owned())
        .collect();

    assert_eq!(
        names_a, names_b,
        "bidirectional convergence: same sheet-id → name mapping"
    );
    // Both X and X(2) must be present (no rename was rejected).
    let mut sorted = names_a.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        vec!["X".to_string(), "X(2)".to_string()],
        "auto-disambiguation: {{X, X(2)}} present; got {names_a:?}"
    );
}

/// **Step 2 audit closure (Codex MEDIUM-1):** case-only renames
/// (e.g., "Sheet1" → "SHEET1") must update the display name even
/// though canonical equality holds. Pre-closure the idempotency
/// check used canonical comparison and silently dropped case-only
/// renames; storage layer does accept them.
#[test]
fn step2_audit_case_only_rename_updates_display_name() {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "Sheet1".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log.append(Op::RenameSheet {
        id: 0,
        old_name: "Sheet1".to_owned(),
        new_name: "SHEET1".to_owned(),
    })
    .unwrap();

    let wb = replay_into_fresh(&log);
    assert_eq!(
        wb.sheet(0).unwrap().name(),
        "SHEET1",
        "case-only rename must update display name (Codex MEDIUM-1 closure); \
         pre-closure replay no-op'd because canonical equality, leaving 'Sheet1'"
    );
}
