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
/// Pinned to catch any regression that breaks the "second op finds
/// current == new_name → no-op" path (case 1 in the post-step-2
/// classification).
#[test]
fn step2_concurrent_rename_identical_targets_is_idempotent() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Renamed".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let wb = replay_into_fresh(&peer_a);
    assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
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
#[test]
fn step2_concurrent_rename_plus_literal_write_both_apply() {
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

    // Peer B (concurrent, no knowledge of rename): PutValue at S!A1.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();

    peer_a
        .merge_bytes(&peer_b.export_bytes().unwrap())
        .expect("merge must succeed even with concurrent rename + edit");
    let wb = replay_into_fresh(&peer_a);

    // Sheet is renamed (peer A's intent applied).
    assert_eq!(
        wb.sheet(0).unwrap().name(),
        "S2",
        "rename applied; literal write doesn't block rename"
    );
    // PutValue at sheet 0 row 0 col 0 still applied — addresses by
    // sheet ID, not sheet NAME (sheet ID is stable across rename).
    let val = wb.read(Address::new(0, 0, 0));
    assert_eq!(
        val,
        ql_types::Value::Number(42.0),
        "concurrent PutValue at sheet 0 must apply; got {val:?}"
    );
}

/// **Step 2:** triple-peer concurrent rename. All three peers
/// concurrently rename the same sheet to DIFFERENT targets. After
/// pairwise merge, all peers must converge on the same name (one
/// of the three targets).
///
/// **Why this test matters**: the audit at step 2 should consider
/// peer counts beyond 2. Loro's causal order is transitive across
/// peer counts, but the test pins the property explicitly.
#[test]
fn step2_three_peer_concurrent_rename_converges() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    const PEER_C_ID: u64 = 3;

    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Apple".to_owned(),
        })
        .unwrap();
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Banana".to_owned(),
        })
        .unwrap();
    let mut peer_c = fork_with_peer(&base, PEER_C_ID);
    peer_c
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "Cherry".to_owned(),
        })
        .unwrap();

    // Star-merge: every peer pulls every other peer's bytes.
    let bytes_a = peer_a.export_bytes().unwrap();
    let bytes_b = peer_b.export_bytes().unwrap();
    let bytes_c = peer_c.export_bytes().unwrap();
    peer_a.merge_bytes(&bytes_b).unwrap();
    peer_a.merge_bytes(&bytes_c).unwrap();
    peer_b.merge_bytes(&bytes_a).unwrap();
    peer_b.merge_bytes(&bytes_c).unwrap();
    peer_c.merge_bytes(&bytes_a).unwrap();
    peer_c.merge_bytes(&bytes_b).unwrap();

    let wb_a = replay_into_fresh(&peer_a);
    let wb_b = replay_into_fresh(&peer_b);
    let wb_c = replay_into_fresh(&peer_c);

    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
    let name_c = wb_c.sheet(0).unwrap().name().to_owned();

    assert_eq!(name_a, name_b, "three-peer convergence A == B");
    assert_eq!(name_b, name_c, "three-peer convergence B == C");
    assert!(
        ["Apple", "Banana", "Cherry"].contains(&name_a.as_str()),
        "winner must be one of the three concurrent renames; got {name_a:?}"
    );
}
