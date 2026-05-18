//! Phase 4.12 defensive probes for the op-log layer.
//!
//! Marked `#[ignore]` — invoked by hand via
//! `cargo test -p ql-oplog --test p412_defensive_oplog_probes -- --ignored
//! --nocapture --test-threads=1`.
//!
//! Each probe records what happens when the op-log API or replay path is
//! fed pathological input. Outcomes: typed error, panic, hang, OOM.

use std::panic;

use ql_io::CellWireValue;
use ql_oplog::{replay_into, Op, OpLog};

fn try_catch<R>(f: impl FnOnce() -> R + std::panic::UnwindSafe) -> Result<R, String> {
    panic::catch_unwind(f).map_err(|payload| {
        if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_owned()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_owned()
        }
    })
}

// ─── 1. Loro import — malformed snapshots ────────────────────────────────

#[test]
#[ignore]
fn import_random_bytes() {
    // 1 KiB of pseudo-random bytes.
    let bytes: Vec<u8> = (0..1024u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 24) as u8)
        .collect();
    let r = try_catch(|| OpLog::import_bytes(&bytes));
    eprintln!("import_random_bytes: {r:?}");
}

#[test]
#[ignore]
fn import_truncated_snapshot() {
    // Build a real snapshot, then truncate.
    let mut log = OpLog::new();
    log.append(Op::PutValue {
        sheet: 0,
        row: 0,
        col: 0,
        value: CellWireValue::Number(1.0),
    })
    .unwrap();
    let bytes = log.export_bytes().unwrap();
    for cut in [1usize, 4, 16, 64, bytes.len().saturating_sub(1)] {
        let truncated = &bytes[..cut.min(bytes.len())];
        let r = try_catch(|| OpLog::import_bytes(truncated));
        eprintln!(
            "import_truncated_snapshot[cut={cut}]: ok={:?}",
            r.as_ref().map(|x| x.is_ok())
        );
    }
}

#[test]
#[ignore]
fn import_byte_flipped_snapshot() {
    let mut log = OpLog::new();
    for i in 0..10 {
        log.append(Op::PutValue {
            sheet: 0,
            row: i,
            col: 0,
            value: CellWireValue::Number(i as f64),
        })
        .unwrap();
    }
    let original = log.export_bytes().unwrap();
    // Flip every 7th byte.
    for stride in [7usize, 13, 31] {
        let mut bytes = original.clone();
        for i in (0..bytes.len()).step_by(stride) {
            bytes[i] ^= 0xFF;
        }
        let r = try_catch(|| OpLog::import_bytes(&bytes));
        eprintln!(
            "import_byte_flipped[stride={stride}]: ok={:?}",
            r.as_ref().map(|x| x.is_ok())
        );
    }
}

#[test]
#[ignore]
fn import_zero_length() {
    let r = try_catch(|| OpLog::import_bytes(&[]));
    eprintln!("import_zero_length: {r:?}");
}

#[test]
#[ignore]
fn import_giant_zero_buffer() {
    // 16 MiB of zeros — does the Loro decoder over-allocate / DoS on giant
    // declared-length values?
    let bytes = vec![0u8; 16 * 1024 * 1024];
    let r = try_catch(|| OpLog::import_bytes(&bytes));
    eprintln!("import_giant_zero_buffer: {r:?}");
}

// ─── 2. Replay — deep nesting / out-of-bounds ────────────────────────────

/// Replay a BatchCommit nested 10_000 levels deep. `apply_op` calls itself
/// on every inner op, so this is a direct probe of recursive replay.
/// We construct the op tree by hand (NOT via append/iter, which would
/// serialize and bounce through Loro — JSON depth limits would block us
/// before we hit the recursion).
#[test]
#[ignore]
fn replay_deeply_nested_batch_commit() {
    use ql_functions::default_registry;
    use ql_storage::Workbook;

    // Build a nested BatchCommit tree of depth N around a single inner
    // PutValue. apply_op recurses through Op::BatchCommit. Built
    // iteratively (NOT recursively) so the test-data construction itself
    // doesn't stack-overflow before replay runs.
    fn nest(depth: usize) -> Op {
        let mut op = Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        };
        for _ in 0..depth {
            op = Op::BatchCommit { ops: vec![op] };
        }
        op
    }

    for depth in [10usize, 100, 1000, 5000, 10_000] {
        // Spawn with a generous stack so a stack-overflow shows up as a
        // panic rather than killing the binary.
        let handle = std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(move || {
                let registry = default_registry();
                let mut wb = Workbook::new();
                wb.add_sheet("S");
                // We build the OpLog by directly inserting a Vec — but
                // the public API only takes Op::append. Use that — depth
                // is encoded structurally inside ONE op.
                let mut log = OpLog::new();
                let outer = nest(depth);
                if let Err(e) = log.append(outer) {
                    return Err(format!("append failed at depth {depth}: {e}"));
                }
                match panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    replay_into(&log, &mut wb, &registry)
                })) {
                    Ok(Ok(n)) => Ok(format!("ok ({n} ops applied)")),
                    Ok(Err(e)) => Err(format!("ReplayError: {e}")),
                    Err(p) => Err(format!("PANIC: {:?}", p.type_id())),
                }
            })
            .unwrap();
        let outcome = handle.join();
        eprintln!("replay_deeply_nested_batch_commit[depth={depth}]: {outcome:?}");
    }
}

#[test]
#[ignore]
fn replay_giant_batch_commit_flat() {
    use ql_functions::default_registry;
    use ql_storage::Workbook;

    // 1M ops in a single BatchCommit (flat). Probes memory / iteration
    // bounds, not recursion.
    let registry = default_registry();
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let inner: Vec<Op> = (0..1_000_000u32)
        .map(|i| Op::PutValue {
            sheet: 0,
            row: i % 1000,
            col: i / 1000,
            value: CellWireValue::Number(i as f64),
        })
        .collect();
    let mut log = OpLog::new();
    log.append(Op::BatchCommit { ops: inner }).unwrap();
    let outcome = panic::catch_unwind(panic::AssertUnwindSafe(|| {
        replay_into(&log, &mut wb, &registry)
    }));
    eprintln!(
        "replay_giant_batch_commit_flat: ok={:?}",
        outcome
            .as_ref()
            .map(|r| r.as_ref().map(|n| *n).unwrap_or(0))
    );
}

#[test]
#[ignore]
fn replay_op_with_extreme_coords() {
    use ql_functions::default_registry;
    use ql_storage::Workbook;

    let registry = default_registry();
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let mut log = OpLog::new();
    // u32::MAX row/col — well outside MAX_ROW / MAX_COLUMN.
    log.append(Op::PutValue {
        sheet: 0,
        row: u32::MAX,
        col: u32::MAX,
        value: CellWireValue::Number(1.0),
    })
    .unwrap();
    let r = replay_into(&log, &mut wb, &registry);
    eprintln!("replay_op_with_extreme_coords: {r:?}");
}

#[test]
#[ignore]
fn replay_op_referring_to_nonexistent_sheet() {
    use ql_functions::default_registry;
    use ql_storage::Workbook;

    let registry = default_registry();
    let mut wb = Workbook::new();
    // No sheet added.
    let mut log = OpLog::new();
    log.append(Op::PutValue {
        sheet: 5,
        row: 0,
        col: 0,
        value: CellWireValue::Number(1.0),
    })
    .unwrap();
    let r = replay_into(&log, &mut wb, &registry);
    eprintln!("replay_op_referring_to_nonexistent_sheet: {r:?}");
}

#[test]
#[ignore]
fn replay_set_cell_format_without_register() {
    use ql_functions::default_registry;
    use ql_storage::Workbook;

    let registry = default_registry();
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let mut log = OpLog::new();
    // Reference an unregistered format id directly (no preceding
    // RegisterFormat).
    log.append(Op::SetCellFormat {
        sheet: 0,
        row: 0,
        col: 0,
        id: Some(99999),
    })
    .unwrap();
    let r = replay_into(&log, &mut wb, &registry);
    eprintln!("replay_set_cell_format_without_register: {r:?}");
}
