//! **Phase 5.2 D-1 step 8 megaudit closure (Opus-B HIGH-3 + Opus-A insight,
//! 2026-05-20):** pin the legacy `oplog.bin` failure mode for pre-step-4
//! op shapes via direct LoroList JSON injection.
//!
//! Step 7 audit Codex HIGH-1 identified the limitation: pre-step-4
//! raw Loro `oplog.bin` files load at Loro framing level but the
//! deserialization of `Op::RegisterFormat` / `Op::SetCellFormat` fails
//! at `OpLog::iter()` because those ops now carry `FormatIdWire`
//! tagged-tuple ids instead of bare `u32`. Step 7 closure documented
//! the limitation but DEFERRED the adversarial test (synthesizing
//! pre-step-4 op JSON requires bypassing the current Op enum's serde
//! shape — fragile).
//!
//! Step 8 megaudit Opus-A proved the test IS feasible via direct
//! `LoroDoc::get_list("ops").push(LoroValue::String(json))` calls,
//! and ran the probes successfully. This file ports those probes to
//! permanent regression tests.
//!
//! Test names map to the Step 7 audit closure docstring reference at
//! `crates/ql-io/src/oplog_persistence.rs` (the docstring's stale
//! reference is corrected in the step 8 megaudit closure commit too).

use loro::{LoroDoc, LoroList, LoroValue};
use ql_oplog::{FormatIdWire, Op, OpLog, OpLogError};

/// Diagnostic probe: print the serde JSON shape that the current `Op`
/// enum produces. Used to verify the test fixtures match reality. Run
/// with `cargo test -p ql-oplog --test d1_step8_legacy_op_shape -- --nocapture probe_current_op_json_shape`.
#[test]
fn probe_current_op_json_shape() {
    let op = Op::RegisterFormat {
        id: FormatIdWire::Builtin { id: 14 },
        string: "m/d/yy".to_string(),
    };
    let json = serde_json::to_string(&op).unwrap();
    eprintln!("CURRENT_SHAPE: {json}");
    // Don't assert — this is a diagnostic; the assertion is the
    // round-trip test below that uses the same shape.
}

/// Helper: construct an OpLog by directly pushing JSON strings into the
/// underlying LoroDoc's "ops" list. Bypasses the typed `Op` serde shape
/// so we can inject pre-step-4-shaped op JSON.
///
/// Returns the raw Loro snapshot bytes (pre-Tier-D3 — no QLOL prefix).
fn synthesize_raw_loro_snapshot_with_op_jsons(op_jsons: &[&str]) -> Vec<u8> {
    let doc = LoroDoc::new();
    let list: LoroList = doc.get_list("ops");
    for json in op_jsons {
        list.push(LoroValue::from(*json))
            .expect("LoroList push must succeed");
    }
    doc.commit();
    doc.export(loro::ExportMode::Snapshot)
        .expect("LoroDoc snapshot export must succeed")
}

/// **Codex step-7 HIGH-1 / Step 8 megaudit closure:** a pre-step-4
/// `Op::RegisterFormat` op (bare `u32` id) loads as a Loro doc at
/// framing level but `iter()` surfaces `OpLogError::Deserialize` on
/// the first format op — NOT silent data loss.
///
/// `Op` enum is internally tagged via `#[serde(tag = "kind")]`.
///
/// Pre-step-4 op JSON shape (bare u32 id; verified via diagnostic probe):
///   `{"kind":"RegisterFormat","id":14,"string":"m/d/yy"}`
///
/// Current op shape (post-step-4, FormatIdWire tagged tuple):
///   `{"kind":"RegisterFormat","id":{"kind":"builtin","id":14},"string":"m/d/yy"}`
#[test]
fn legacy_path_with_pre_step_4_register_format_op_fails_loudly_at_iter() {
    let pre_step4_json = r#"{"kind":"RegisterFormat","id":14,"string":"m/d/yy"}"#;
    let bytes = synthesize_raw_loro_snapshot_with_op_jsons(&[pre_step4_json]);

    // Phase 1: Loro framing accepts the bytes.
    let log = OpLog::import_bytes(&bytes).expect(
        "Loro framing of synthesized snapshot must succeed — only per-op deserialize fails",
    );
    assert_eq!(
        log.len(),
        1,
        "the single injected op must be visible at framing level"
    );

    // Phase 2: iter() fails LOUDLY on the first op with Deserialize.
    let mut iter = log.iter();
    let first = iter
        .next()
        .expect("iter must yield one Result for the injected op");
    match first {
        Err(OpLogError::Deserialize { index, source }) => {
            assert_eq!(index, 0);
            // Error message should reference the expected shape so consumers
            // can recognize a pre-step-4 file in error logs.
            let msg = source.to_string();
            assert!(
                msg.contains("FormatIdWire") || msg.contains("expected"),
                "Deserialize error must reference expected shape; got {msg:?}"
            );
        }
        other => panic!("expected OpLogError::Deserialize for pre-step-4 op shape; got {other:?}"),
    }
}

/// Symmetric test for `Op::SetCellFormat` (pre-step-4 `Option<u32>` vs
/// current `Option<FormatIdWire>`).
#[test]
fn legacy_path_with_pre_step_4_set_cell_format_op_fails_loudly_at_iter() {
    let pre_step4_json = r#"{"kind":"SetCellFormat","sheet":0,"row":0,"col":0,"id":14}"#;
    let bytes = synthesize_raw_loro_snapshot_with_op_jsons(&[pre_step4_json]);

    let log = OpLog::import_bytes(&bytes).expect("framing succeeds");
    let first = log.iter().next().unwrap();
    assert!(
        matches!(first, Err(OpLogError::Deserialize { index: 0, .. })),
        "pre-step-4 SetCellFormat shape must fail at iter; got {first:?}"
    );
}

/// Sanity: the CURRENT FormatIdWire-shaped op succeeds through the same
/// direct-LoroList path. Pins the test fixture's correctness — if the
/// current shape's JSON were ALSO failing, the prior tests would be
/// false positives.
#[test]
fn current_step_4_register_format_op_shape_round_trips_via_direct_loro_writes() {
    let current_json =
        r#"{"kind":"RegisterFormat","id":{"kind":"builtin","id":14},"string":"m/d/yy"}"#;
    let bytes = synthesize_raw_loro_snapshot_with_op_jsons(&[current_json]);

    let log = OpLog::import_bytes(&bytes).expect("framing succeeds");
    let first = log.iter().next().unwrap();
    assert!(
        first.is_ok(),
        "current FormatIdWire shape must round-trip via direct LoroList writes; got {first:?}"
    );
}

/// Mixed-shape log: index 0 is current (valid), index 1 is pre-step-4
/// (invalid). iter() yields `Ok` for 0, `Err(Deserialize { index: 1 })`
/// for 1 — confirms iter doesn't silently skip bad entries and the
/// index field is correct.
#[test]
fn mixed_current_and_pre_step_4_shapes_iter_succeeds_then_fails_with_correct_index() {
    let good_json =
        r#"{"kind":"RegisterFormat","id":{"kind":"builtin","id":14},"string":"m/d/yy"}"#;
    let bad_json = r#"{"kind":"RegisterFormat","id":99,"string":"0.00"}"#;
    let bytes = synthesize_raw_loro_snapshot_with_op_jsons(&[good_json, bad_json]);

    let log = OpLog::import_bytes(&bytes).expect("framing succeeds");
    assert_eq!(log.len(), 2);

    let mut iter = log.iter();
    let first = iter.next().unwrap();
    assert!(first.is_ok(), "index 0 must succeed; got {first:?}");
    let second = iter.next().unwrap();
    match second {
        Err(OpLogError::Deserialize { index, .. }) => assert_eq!(index, 1),
        other => panic!("expected Err(Deserialize {{ index: 1 }}); got {other:?}"),
    }
}
