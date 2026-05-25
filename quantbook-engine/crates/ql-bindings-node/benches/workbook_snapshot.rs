//! **Phase 5.7 V3.6.0.7 D6 profiling spike (2026-05-25)** — measure
//! `workbookSnapshot` post-D2 + post-D4 cost so the V3.6.0.1 decision
//! lock can be resolved (`> 50 ms / call` → ship D6; `<= 50 ms / call`
//! → defer to V3.7+).
//!
//! The bench REPLICATES the body of `crates/ql-bindings-node/src/lib.rs
//! :1802 workbook_snapshot` rather than calling it through the napi
//! surface (napi methods can't be invoked from Rust without bootstrapping
//! a Node runtime, and the spike is time-boxed). An assertion at setup
//! time guards against silent drift: the replicated path's cell count
//! must match the count of `(sheet, row, col)` triples emitted by the
//! workload generator.
//!
//! Workload matrix (12 combinations):
//!
//! | grid        | cells   | format % | sheets |
//! |-------------|---------|----------|--------|
//! | 100×10      | 1 000   | 0, 50    | 1, 5   |
//! | 100×100     | 10 000  | 0, 50    | 1, 5   |
//! | 1000×100    | 100 000 | 0, 50    | 1, 5   |
//!
//! Decision combo: `cells=100 000, format=50 %, sheets=1`. Median wall
//! time decides D6 ship-vs-defer.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use ql_collab::CollabSession;
use ql_functions::default_registry;
use ql_oplog::wire::FormatIdWire;
use ql_oplog::{CellWireValue, Op};
use ql_types::PeerId;

/// Generate a session with `n_sheets` sheets each holding `rows × cols`
/// cells. `format_pct` is the percentage of cells (0..=100) bound to a
/// FormatId via `Op::SetCellFormat`. Three Builtin format ids are used
/// in rotation so the post-D4 per-snapshot `parsed_format_cache`
/// exercises both cache hits (same id within a snapshot) and parse
/// work (3 distinct ids per snapshot).
///
/// One sheet name = `S{n}`; cells are laid out row-major.
fn build_session(rows: u32, cols: u32, n_sheets: u16, format_pct: u8) -> CollabSession {
    let mut s = CollabSession::new(PeerId::new(1)).expect("PeerId(1) is non-zero");
    // Add sheets.  `new()` creates a session with zero sheets; the
    // bench needs explicit `Op::AddSheet` for each.
    for sheet_idx in 0..n_sheets {
        s.append_op(Op::AddSheet {
            name: format!("S{sheet_idx}"),
            chunk_rows: 16_384,
        })
        .expect("AddSheet apply");
    }
    // Builtin format ids used in rotation.  Builtin(1) = "0" (integer),
    // Builtin(9) = "0%" (percent), Builtin(14) = "m/d/yy" (date).  All
    // three are pre-registered in the FormatTable so no
    // `Op::RegisterFormat` is needed.
    let builtin_ids = [
        FormatIdWire::Builtin { id: 1 },
        FormatIdWire::Builtin { id: 9 },
        FormatIdWire::Builtin { id: 14 },
    ];
    let format_threshold = format_pct as u32;
    for sheet_id in 0..n_sheets {
        for row in 0..rows {
            for col in 0..cols {
                // Deterministic value seeded by (sheet, row, col) so the
                // formatted output isn't trivially zero.
                let value = (sheet_id as f64) * 1_000_000.0 + (row as f64) * 100.0 + col as f64;
                s.append_op(Op::PutValue {
                    sheet: sheet_id,
                    row,
                    col,
                    value: CellWireValue::Number(value),
                })
                .expect("PutValue apply");
                // 50% format = first 50 of every 100 cells get a format
                // (deterministic; not random; avoids RNG cost in setup).
                if format_threshold > 0 && ((row * cols + col) % 100) < format_threshold {
                    let fmt_id = builtin_ids[((row * cols + col) % 3) as usize].clone();
                    s.append_op(Op::SetCellFormat {
                        sheet: sheet_id,
                        row,
                        col,
                        id: Some(fmt_id),
                    })
                    .expect("SetCellFormat apply");
                }
            }
        }
    }
    s
}

/// Replicate the body of `crates/ql-bindings-node/src/lib.rs:1802
/// workbook_snapshot` (V3.6.0.6 D5 surface; post-D2 + post-D4 cost).
/// Returns total cell count for the assertion check at setup time.
fn snapshot_equivalent(
    session: &CollabSession,
    registry: &ql_functions::FunctionRegistry,
) -> usize {
    let (workbook, _report) = session.rebuild_workbook(registry).expect("rebuild_workbook");
    let workbook_date_system = workbook.date_system();
    let eval_ctx = ql_types::EvalContext {
        date_system: workbook_date_system,
        locale: workbook.locale(),
        now_provider: ql_types::NowProvider::System,
    };
    let mut parsed_format_cache: std::collections::HashMap<
        ql_storage::FormatId,
        ql_functions::format::FormatString,
    > = std::collections::HashMap::new();
    let sheet_count = workbook.sheet_count();
    let display = workbook.sheet_display_order().to_vec();
    let mut all_ids: Vec<u16> = display.clone();
    for sheet_id in 0u16..(sheet_count as u16) {
        if !display.contains(&sheet_id) {
            all_ids.push(sheet_id);
        }
    }
    let mut total_cells: usize = 0;
    let mut sheets_out: Vec<(u16, String, usize)> = Vec::with_capacity(sheet_count);
    for sheet_id in all_ids {
        if workbook.is_sheet_removed(sheet_id) {
            continue;
        }
        let name = workbook
            .sheet(sheet_id)
            .map(|s| s.name().to_string())
            .unwrap_or_default();
        let cells_for_sheet: Vec<usize> = session
            .snapshot_cells(sheet_id)
            .into_iter()
            .map(|((row, col), state)| {
                let _repaired_formula = workbook
                    .formula_at(sheet_id, row, col)
                    .map(|s| s.as_ref().to_string());
                let _rendered: Option<String> =
                    match (state.format.as_ref(), state.value.as_ref()) {
                        (Some(fmt_id), Some(wire_value)) if !wire_value.is_pending() => {
                            let fmt_id_copy = *fmt_id;
                            wire_value.to_value().ok().and_then(|value| {
                                if let Some(fmt) = parsed_format_cache.get(&fmt_id_copy) {
                                    return Some(ql_functions::format::render(
                                        &value, fmt, &eval_ctx,
                                    ));
                                }
                                let fmt_str = workbook.formats().lookup(fmt_id_copy)?;
                                let fmt = ql_functions::format::parse(fmt_str).ok()?;
                                let rendered_str =
                                    ql_functions::format::render(&value, &fmt, &eval_ctx);
                                parsed_format_cache.insert(fmt_id_copy, fmt);
                                Some(rendered_str)
                            })
                        }
                        _ => None,
                    };
                // Track ONE per cell so callers can sum cell counts.
                1
            })
            .collect();
        let cell_count: usize = cells_for_sheet.iter().sum();
        total_cells += cell_count;
        sheets_out.push((sheet_id, name, cell_count));
    }
    let mut format_pairs: Vec<(ql_storage::FormatId, &str)> =
        workbook.formats().iter().collect();
    format_pairs.sort_by_key(|(id, _)| *id);
    let _formats: Vec<(ql_storage::FormatId, String)> = format_pairs
        .into_iter()
        .map(|(id, s)| (id, s.to_string()))
        .collect();
    let _date_system = match workbook_date_system {
        ql_types::DateSystem::Excel1900 => "Excel1900".to_string(),
        ql_types::DateSystem::Excel1904 => "Excel1904".to_string(),
    };
    black_box(sheets_out);
    total_cells
}

fn bench_workbook_snapshot(c: &mut Criterion) {
    let registry = default_registry();
    let mut group = c.benchmark_group("workbook_snapshot");
    group.sample_size(10);
    group.measurement_time(std::time::Duration::from_secs(15));
    group.warm_up_time(std::time::Duration::from_secs(2));

    // grid (rows × cols) → total cells (per sheet)
    let grids: &[(u32, u32)] = &[(100, 10), (100, 100), (1000, 100)];
    let format_pcts: &[u8] = &[0, 50];
    let sheet_counts: &[u16] = &[1, 5];

    for &(rows, cols) in grids {
        for &format_pct in format_pcts {
            for &n_sheets in sheet_counts {
                let session = build_session(rows, cols, n_sheets, format_pct);
                let expected_cells = (rows as usize) * (cols as usize) * (n_sheets as usize);
                // Setup-time assertion -- not on hot path -- closes the
                // bench-vs-napi drift risk.  If the replicated body
                // diverges from napi (e.g., field added; semantics
                // shifted), the assertion fires on every benchmark run.
                let observed = snapshot_equivalent(&session, &registry);
                assert_eq!(
                    observed, expected_cells,
                    "bench setup drift: expected {expected_cells} cells, got {observed} (rows={rows} cols={cols} sheets={n_sheets} fmt={format_pct}%)"
                );
                let label = format!(
                    "cells={} fmt={}% sheets={}",
                    expected_cells, format_pct, n_sheets
                );
                group.bench_with_input(
                    BenchmarkId::from_parameter(&label),
                    &session,
                    |b, s| {
                        b.iter(|| {
                            let n = snapshot_equivalent(s, &registry);
                            black_box(n);
                        });
                    },
                );
            }
        }
    }
    group.finish();
}

criterion_group!(benches, bench_workbook_snapshot);
criterion_main!(benches);
