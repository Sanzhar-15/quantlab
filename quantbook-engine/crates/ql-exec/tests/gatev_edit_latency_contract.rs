//! GATE-V / Finding F-1 (w103, 2026-06-20) — deterministic edit-latency guard.
//!
//! DoD #4 requires a single-cell edit to recalc in < 15ms. The wall-clock side
//! of that lives in the `gatev_recalc_contract` criterion bench. THIS test is the
//! deterministic, CI-safe complement: it pins the *structural* invariant the
//! latency depends on — **a single-cell edit recomputes only its dirty-set, not
//! the whole graph.**
//!
//! Background: the original F-1 bench reported ~106ms for a one-cell edit on a 1M
//! grid and concluded edit latency was O(graph). That number was a criterion
//! drop-timing artifact (the bench closures dropped the 1M-cell workbook INSIDE
//! the timed region); the real edit path is O(dirty-set). See
//! `docs/fe/2026-06-20-gatev-validation-report.md` (Finding F-1) and the header of
//! `benches/gatev_recalc_contract.rs`.
//!
//! Why structural, not timing: a wall-clock assertion in `cargo test` (debug,
//! shared CI) is flaky. `recompute_dirty().attempted` is exact and deterministic.
//! Scope of what it catches (precise — per Codex audit): `attempted` counts the
//! formula nodes *scheduled + recomputed*, so this guard fails loudly if a
//! regression made an edit RECOMPUTE the whole graph (attempted 1 -> ~N). It would
//! NOT, by itself, catch a hypothetical regression that *scanned* all nodes while
//! still scheduling one — that class is ruled out by the wall-clock bench
//! (`gatev_recalc_contract`, ~9µs) plus source tracing of the edit path, not by
//! this count. Within its scope it is the right deterministic, machine-independent
//! signal for "edit work tracks the dirty-set, not the grid."

use ql_exec::{CalcgraphSession, WorkbookRuntime};
use ql_functions::{default_registry, FunctionRegistry};
use ql_storage::Workbook;
use ql_types::Value;

/// Independent input→formula pairs: column A holds literals, column B holds
/// `=A*2`. Editing one A-cell dirties exactly one B-cell. Mirrors the bench's
/// `build_independent_grid` so the test and the bench exercise the same shape.
/// Returns `(wb, session, registry)`; the registry is returned so the caller can
/// attach a fresh runtime for the edit.
fn build_independent_grid(n: u32) -> (Workbook, CalcgraphSession, FunctionRegistry) {
    let mut wb = Workbook::new();
    wb.add_sheet("S");
    let reg = default_registry();
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        for r in 0..n {
            rt.set_value(0, r, 0, Value::Number(r as f64)).unwrap();
            let text = format!("A{} * 2", r + 1); // internal row r -> "A{r+1}"
            rt.set_formula(0, r, 1, text.as_str()).unwrap();
        }
    }
    let rebuilt = CalcgraphSession::rebuild_from_workbook(&wb);
    assert!(
        rebuilt.is_complete(),
        "{} build failures",
        rebuilt.failures.len()
    );
    (wb, rebuilt.session, reg)
}

/// Edit one A-cell on an `n`-row independent grid and return how many formula
/// nodes the incremental recompute actually attempted.
fn recompute_count_after_single_edit(n: u32) -> usize {
    let (mut wb, mut graph, reg) = build_independent_grid(n);
    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
    rt.set_value(0, 0, 0, Value::Number(999.0)).unwrap();
    let result = rt.recompute_dirty().expect("graph attached");
    result.attempted
}

/// THE GUARD: a single-cell edit recomputes exactly its one dependent, and that
/// count is INDEPENDENT of how large the grid is. If the edit path ever regresses
/// to O(graph) (recomputing/scanning all nodes), `attempted` would scale with the
/// grid and this assertion would fail.
#[test]
fn single_cell_edit_recompute_is_o_dirty_not_o_graph() {
    let small = recompute_count_after_single_edit(1_000);
    let large = recompute_count_after_single_edit(25_000);

    assert_eq!(small, 1, "1k grid: exactly one dependent (B1) recomputed");
    assert_eq!(
        large, 1,
        "25k grid: still exactly one dependent — recompute work is O(dirty-set), \
         not O(graph); a 25x larger graph did NOT increase the work"
    );
}
