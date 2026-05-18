Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/sanzhar/.codex/memories]
reasoning effort: xhigh
reasoning summaries: none
session id: 019e3c3c-8784-7c33-a1dc-ae94971fa133
--------
user
Audit commit 3451d90a03f on `feat/quantbook-engine` at `~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`.

The commit closes Phase 4.12 Opus-B HIGH-2: `WorkbookRuntime::recompute_all` previously had NO cycle detection. For `=A1+1` in A1, HashMap-order eval just re-read A1's prior value, producing 1, then 2, then 3 on successive calls instead of `#CIRC!`. This is the `.qbook` load + replay path. Phase 5 CRDT collaboration inherits the bug if not closed.

The fix:
- Before HashMap-order eval, build ephemeral `CalcgraphSession` via `rebuild_from_workbook(self.workbook).session`.
- Iterate workbook formulas, mark each node dirty.
- Call `session.schedule_dirty()` → `Schedule { sorted, cycled }`.
- Collect cycled cell addresses into `HashSet<(SheetId, RowId, ColId)>`.
- In the eval loop, cycled cells short-circuit to `Value::Error(ErrorValue::Circ)` (counted in `attempted`, NOT `succeeded`) and skip bind/eval.

Read:
- `crates/ql-exec/src/workbook_runtime.rs` lines 2994-3110 (patched recompute_all)
- `crates/ql-exec/src/workbook_runtime.rs` lines 3060-3260 (recompute_dirty, the proven reference)
- `crates/ql-exec/src/workbook_runtime.rs` end-of-file (4 new tests)
- `crates/ql-exec/src/calcgraph_session.rs` lines 858-945 (rebuild_from_workbook)
- `crates/ql-exec/src/calcgraph_session.rs` lines 1647-1760 (schedule_dirty + range supplemental)

Find HIGH/MEDIUM/LOW issues with file:line references:

1. Correctness edge cases: deleted-name refs, parse errors, spill anchors, self-ref via SUM(A:A), named-range cycles, cross-sheet cycles.
2. Determinism: HashSet ordering (only `.contains()`, OK), cell_address_for None handling.
3. Performance: rebuild_from_workbook parses every formula once; existing loop parses again. 2x cost on cold load — measurable on 10K-formula workbooks?
4. Test coverage: 4 new tests cover direct + 2-cycle. Missing: 3-cycle, SUM(A:A), named-range cycle, table-col cycle, cross-sheet cycle, mid-replay cycles.
5. Replay path: `crates/ql-exec/src/loader.rs::load_workbook_and_recompute` calls `recompute_all` — confirm fix propagates. `crates/ql-oplog/src/replay.rs` — does replay end with recompute_all?
6. Aggregate cache: rebuild_from_workbook clears its session's cache (line ~934); ephemeral session is dropped — verify no spillover.

Output: punch list with severity tag (H/M/L), file:line, problem, recommended fix. Be thorough — list every concern, not just the first few.

Limit to a single deep pass; don't dispatch sub-agents.
codex
I’ll audit the target commit locally and keep this to a review pass: first I’ll inspect the exact patch and surrounding code, then verify load/replay call paths and tests.
exec
/bin/zsh -lc "rg -n \"fn recompute_all|fn recompute_dirty|load_workbook_and_recompute|recompute_all\\(|schedule_dirty|rebuild_from_workbook|ErrorValue::Circ|CIRC|cycle\" crates/ql-exec/src/workbook_runtime.rs crates/ql-exec/src/calcgraph_session.rs crates/ql-exec/src/loader.rs crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/loader.rs:1://! `load_workbook_and_recompute` — Phase 2A.4 convenience.
crates/ql-exec/src/loader.rs:5://! was saved before its last edit cycle). Callers that want the formula cells
crates/ql-exec/src/loader.rs:10://! 3. `let _ = rt.recompute_all();`
crates/ql-exec/src/loader.rs:56:pub fn load_workbook_and_recompute(
crates/ql-exec/src/loader.rs:63:        runtime.recompute_all()
crates/ql-exec/src/loader.rs:86:        // changing A1 before the load). load_workbook_and_recompute should
crates/ql-exec/src/loader.rs:104:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:125:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:136:        let result = load_workbook_and_recompute(missing, &reg);
crates/ql-exec/src/loader.rs:150:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:173:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:201:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:262:        let (workbook, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:314:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:360:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/loader.rs:411:        let (loaded, result) = load_workbook_and_recompute(&path, &reg).unwrap();
crates/ql-exec/src/workbook_runtime.rs:16://! - `recompute_all()` — legacy HashMap-order full pass; no graph awareness.
crates/ql-exec/src/workbook_runtime.rs:18://!   Runs Tarjan SCC over the attached `CalcgraphSession`'s dirty set; cycled
crates/ql-exec/src/workbook_runtime.rs:19://!   members get `Value::Error(ErrorValue::Circ)`. Phase 3.6 routes aggregates
crates/ql-exec/src/workbook_runtime.rs:2994:    pub fn recompute_all(&mut self) -> RecomputeResult {
crates/ql-exec/src/workbook_runtime.rs:2996:        // cycle detection. `recompute_all` is the no-session-attached
crates/ql-exec/src/workbook_runtime.rs:3004:        // SCC via `schedule_dirty`, and write `#CIRC!` for every
crates/ql-exec/src/workbook_runtime.rs:3005:        // cell in a cycle. The acyclic remainder evaluates through
crates/ql-exec/src/workbook_runtime.rs:3008:        // `rebuild_from_workbook` parses every formula a second
crates/ql-exec/src/workbook_runtime.rs:3013:        let cycled_cells: std::collections::HashSet<(SheetId, RowId, ColId)> = {
crates/ql-exec/src/workbook_runtime.rs:3015:            let mut session = CalcgraphSession::rebuild_from_workbook(self.workbook).session;
crates/ql-exec/src/workbook_runtime.rs:3026:            let sched = session.schedule_dirty();
crates/ql-exec/src/workbook_runtime.rs:3028:                .cycled
crates/ql-exec/src/workbook_runtime.rs:3045:            // Tier C1: cycled cells short-circuit to #CIRC! without
crates/ql-exec/src/workbook_runtime.rs:3047:            // (cycled cells contribute to `attempted` but not
crates/ql-exec/src/workbook_runtime.rs:3050:            if cycled_cells.contains(&(sheet, row, col)) {
crates/ql-exec/src/workbook_runtime.rs:3052:                    .put_computed_at(sheet, row, col, Value::Error(ErrorValue::Circ));
crates/ql-exec/src/workbook_runtime.rs:3114:    /// written as `Value::Error(ErrorValue::Circ)`. Everything else
crates/ql-exec/src/workbook_runtime.rs:3129:    pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> {
crates/ql-exec/src/workbook_runtime.rs:3144:        //   3. evaluate cycled + sorted.
crates/ql-exec/src/workbook_runtime.rs:3192:            let sched = session.schedule_dirty();
crates/ql-exec/src/workbook_runtime.rs:3199:            for n in sched.sorted.iter().chain(sched.cycled.iter()) {
crates/ql-exec/src/workbook_runtime.rs:3209:            // Cycled nodes get `#CIRC!` regardless of whether the
crates/ql-exec/src/workbook_runtime.rs:3212:            let circ = Value::Error(ErrorValue::Circ);
crates/ql-exec/src/workbook_runtime.rs:3213:            for node in &sched.cycled {
crates/ql-exec/src/workbook_runtime.rs:3673:        // a producer-alias self-loop (Tarjan → #CIRC!) so the gap was
crates/ql-exec/src/workbook_runtime.rs:4011:    fn recompute_all_on_empty_workbook_is_noop() {
crates/ql-exec/src/workbook_runtime.rs:4016:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4023:    fn recompute_all_refreshes_formula_values() {
crates/ql-exec/src/workbook_runtime.rs:4041:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4054:    fn recompute_all_handles_multiple_formulas() {
crates/ql-exec/src/workbook_runtime.rs:4068:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4132:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4302:    fn recompute_all_resolves_named_constant() {
crates/ql-exec/src/workbook_runtime.rs:4314:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4572:    fn recompute_all_does_not_emit_ops() {
crates/ql-exec/src/workbook_runtime.rs:4589:            let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4615:    /// path) must detect cycles and emit `#CIRC!` for cycled cells.
crates/ql-exec/src/workbook_runtime.rs:4620:    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
crates/ql-exec/src/workbook_runtime.rs:4626:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4627:            // Repeated calls stay at #CIRC! — they don't drift.
crates/ql-exec/src/workbook_runtime.rs:4628:            let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4637:            Value::Error(ErrorValue::Circ),
crates/ql-exec/src/workbook_runtime.rs:4638:            "self-referential A1 = A1+1 must resolve to #CIRC!, not a stale incremented value"
crates/ql-exec/src/workbook_runtime.rs:4642:    /// 2-cycle: A1 = B1 + 1, B1 = A1 - 1. Both cells in the SCC must
crates/ql-exec/src/workbook_runtime.rs:4643:    /// resolve to `#CIRC!`. Mirrors the existing `recompute_dirty`
crates/ql-exec/src/workbook_runtime.rs:4644:    /// reference test (`recompute_dirty_writes_circ_error_for_cycle_members`).
crates/ql-exec/src/workbook_runtime.rs:4646:    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
crates/ql-exec/src/workbook_runtime.rs:4653:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4661:            Value::Error(ErrorValue::Circ),
crates/ql-exec/src/workbook_runtime.rs:4662:            "A1 in 2-cycle must be #CIRC!"
crates/ql-exec/src/workbook_runtime.rs:4666:            Value::Error(ErrorValue::Circ),
crates/ql-exec/src/workbook_runtime.rs:4667:            "B1 in 2-cycle must be #CIRC!"
crates/ql-exec/src/workbook_runtime.rs:4671:    /// Acyclic mix with a cycle: A1 = 5, B1 = A1 * 2, C1 = C1 + 1
crates/ql-exec/src/workbook_runtime.rs:4673:    /// `#CIRC!`. Verifies cycle detection doesn't pollute the
crates/ql-exec/src/workbook_runtime.rs:4676:    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
crates/ql-exec/src/workbook_runtime.rs:4684:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4688:        assert_eq!(succeeded, 1, "B1 evaluates; C1 is cycled");
crates/ql-exec/src/workbook_runtime.rs:4696:            Value::Error(ErrorValue::Circ)
crates/ql-exec/src/workbook_runtime.rs:4702:    /// `A1 = A1 + 1` returned 1, 2, 3, … instead of #CIRC! each time.
crates/ql-exec/src/workbook_runtime.rs:4704:    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
crates/ql-exec/src/workbook_runtime.rs:4711:                rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4716:            Value::Error(ErrorValue::Circ),
crates/ql-exec/src/workbook_runtime.rs:4717:            "cycle value must remain #CIRC! across repeated recompute_all calls (no drift)"
crates/ql-exec/src/workbook_runtime.rs:4727:    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
crates/ql-exec/src/workbook_runtime.rs:4737:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4757:    fn recompute_all_does_not_short_circuit_on_first_failure() {
crates/ql-exec/src/workbook_runtime.rs:4770:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4792:    fn recompute_all_does_not_panic_on_invalid_persisted_formulas() {
crates/ql-exec/src/workbook_runtime.rs:4802:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4814:    fn recompute_all_eval_time_error_values_count_as_succeeded() {
crates/ql-exec/src/workbook_runtime.rs:4821:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4835:    fn recompute_all_failed_cells_preserve_prior_state() {
crates/ql-exec/src/workbook_runtime.rs:4842:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4859:    fn recompute_all_second_pass_is_all_cache_hits() {
crates/ql-exec/src/workbook_runtime.rs:4870:        let r1 = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4879:        let r2 = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4903:            let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4918:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4935:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4959:            let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4980:        let _ = rt.recompute_all(); // 1 miss
crates/ql-exec/src/workbook_runtime.rs:4981:        let _ = rt.recompute_all(); // 1 hit
crates/ql-exec/src/workbook_runtime.rs:5009:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:5710:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:5952:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:6053:        let rebuild = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/workbook_runtime.rs:6125:    fn recompute_dirty_returns_none_when_no_graph_attached() {
crates/ql-exec/src/workbook_runtime.rs:6136:    fn recompute_dirty_cascades_dependency_chain() {
crates/ql-exec/src/workbook_runtime.rs:6174:    /// SCH-3-02 end-to-end: cycles get `#CIRC!`. Build A1 = B1 + 1
crates/ql-exec/src/workbook_runtime.rs:6175:    /// and B1 = A1 + 1 (a 2-cycle), then trigger a recompute. Every
crates/ql-exec/src/workbook_runtime.rs:6176:    /// cell in the SCC must be `Value::Error(ErrorValue::Circ)`.
crates/ql-exec/src/workbook_runtime.rs:6178:    /// Note: we build the cycle directly via the workbook's low-level
crates/ql-exec/src/workbook_runtime.rs:6180:    /// `WorkbookRuntime::set_formula` for the second cycle member
crates/ql-exec/src/workbook_runtime.rs:6181:    /// would re-evaluate A1 mid-cycle and write a non-cycle value,
crates/ql-exec/src/workbook_runtime.rs:6186:    fn recompute_dirty_writes_circ_error_for_cycle_members() {
crates/ql-exec/src/workbook_runtime.rs:6194:        let rebuild = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/workbook_runtime.rs:6199:        // Mark the cycle dirty. on_set_value(A1) → cell_to_formulas[A1]
crates/ql-exec/src/workbook_runtime.rs:6202:        // the cycle.
crates/ql-exec/src/workbook_runtime.rs:6208:        // Both members are in cycled (not sorted); attempted == 2.
crates/ql-exec/src/workbook_runtime.rs:6216:            Value::Error(ErrorValue::Circ),
crates/ql-exec/src/workbook_runtime.rs:6217:            "A1 in cycle → #CIRC!"
crates/ql-exec/src/workbook_runtime.rs:6221:            Value::Error(ErrorValue::Circ),
crates/ql-exec/src/workbook_runtime.rs:6222:            "B1 in cycle → #CIRC!"
crates/ql-exec/src/workbook_runtime.rs:6229:    fn recompute_dirty_skips_unrelated_formulas() {
crates/ql-exec/src/workbook_runtime.rs:6465:        let rebuild = crate::CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/workbook_runtime.rs:6879:        let r3 = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7018:        let r_all = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7507:    fn recompute_dirty_twice_in_a_row_is_idempotent() {
crates/ql-exec/src/workbook_runtime.rs:7772:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7787:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7802:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7821:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7844:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7881:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7907:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7984:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:8161:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9178:    fn recompute_all_materializes_spill_for_array_formula() {
crates/ql-exec/src/workbook_runtime.rs:9188:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9210:    fn recompute_all_scalar_formula_unchanged() {
crates/ql-exec/src/workbook_runtime.rs:9216:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9230:    fn recompute_all_out_of_bounds_spill_writes_spill_error() {
crates/ql-exec/src/workbook_runtime.rs:9236:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9252:    fn recompute_all_array_formula_idempotent_across_two_passes() {
crates/ql-exec/src/workbook_runtime.rs:9257:        rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9258:        rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9497:    fn recompute_all_materializes_sequence_spill() {
crates/ql-exec/src/workbook_runtime.rs:9502:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9812:    fn recompute_dirty_transpose_with_named_range_updates_on_value_change() {
crates/ql-exec/src/workbook_runtime.rs:9864:    fn recompute_dirty_filter_with_named_ranges_grows_footprint() {
crates/ql-exec/src/workbook_runtime.rs:9938:    fn recompute_dirty_sequence_grows_footprint() {
crates/ql-exec/src/workbook_runtime.rs:9975:    fn recompute_dirty_sequence_shrinks_footprint() {
crates/ql-exec/src/workbook_runtime.rs:10018:    fn recompute_dirty_aliased_reader_sees_target_value_change_when_anchor_unchanged() {
crates/ql-exec/src/workbook_runtime.rs:10065:    fn recompute_dirty_dissolution_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime.rs:10128:    fn recompute_dirty_sequence_grows_dirties_new_target_readers() {
crates/ql-exec/src/workbook_runtime.rs:10826:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:10995:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:11081:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:11332:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:11442:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:12154:        let _ = rt.recompute_all();
crates/ql-exec/src/calcgraph_session.rs:17://! - `rebuild_from_workbook` adds a `CellNode` per formula cell in
crates/ql-exec/src/calcgraph_session.rs:30://! - `rebuild_from_workbook` lex+parse+binds every formula and runs
crates/ql-exec/src/calcgraph_session.rs:327:        //     `name == "ISREF"` branch SHORT-CIRCUITS all arg walking.
crates/ql-exec/src/calcgraph_session.rs:439:/// or `rebuild_from_workbook` to build from an existing workbook's
crates/ql-exec/src/calcgraph_session.rs:461:    /// recompute cycle to schedule re-evaluation regardless of
crates/ql-exec/src/calcgraph_session.rs:496:    /// Per-recompute-cycle scoped — the caller clears the set after
crates/ql-exec/src/calcgraph_session.rs:539:/// Phase 3.2: aggregate outcome of `rebuild_from_workbook`. Parallel
crates/ql-exec/src/calcgraph_session.rs:627:    /// cycle in Phase 3.7.
crates/ql-exec/src/calcgraph_session.rs:633:    /// 3.7 reads this every recompute cycle.
crates/ql-exec/src/calcgraph_session.rs:683:        // create false `#CIRC!` cycles (megaudit H3) and stale stripe
crates/ql-exec/src/calcgraph_session.rs:713:        // **Lifecycle handoff (Codex W5-102 HIGH-1, design § 10.5):**
crates/ql-exec/src/calcgraph_session.rs:758:        // `#CIRC!` cycles can no longer occur. See
crates/ql-exec/src/calcgraph_session.rs:768:                // `=A1` at A1 (self-cycle), and the Phase 0 W3-3
crates/ql-exec/src/calcgraph_session.rs:770:                // SCC as `cycled`.
crates/ql-exec/src/calcgraph_session.rs:872:    pub fn rebuild_from_workbook(wb: &Workbook) -> RebuildResult {
crates/ql-exec/src/calcgraph_session.rs:925:        // the workbook (e.g. `load_workbook_and_recompute`), so the
crates/ql-exec/src/calcgraph_session.rs:945:    /// workbook's NameTable. Used by `rebuild_from_workbook` and by
crates/ql-exec/src/calcgraph_session.rs:1049:            // persist and the next schedule_dirty can rediscover the
crates/ql-exec/src/calcgraph_session.rs:1051:            // deps (or as a Tarjan cycle participant if it pointed
crates/ql-exec/src/calcgraph_session.rs:1383:    /// most once → cycles in the dep graph are safe.
crates/ql-exec/src/calcgraph_session.rs:1464:    /// cycle. Returning `HashSet<NodeId>` rather than a slice lets
crates/ql-exec/src/calcgraph_session.rs:1636:    /// - `cycled`: nodes in a non-trivial strongly connected component
crates/ql-exec/src/calcgraph_session.rs:1638:    ///   `Value::Error(ErrorValue::Circ)`.
crates/ql-exec/src/calcgraph_session.rs:1647:    pub fn schedule_dirty(&mut self) -> Schedule {
crates/ql-exec/src/calcgraph_session.rs:1651:        // Tarjan can see range-induced ordering / cycles. The Phase 0
crates/ql-exec/src/calcgraph_session.rs:1664:    /// self-range cycles) dirty formula `G` whose cell address falls
crates/ql-exec/src/calcgraph_session.rs:1786:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:1797:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:1824:            let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:1909:    // machinery via the public `rebuild_from_workbook` /
crates/ql-exec/src/calcgraph_session.rs:1923:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:1963:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2009:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2034:    /// recompute cycle.
crates/ql-exec/src/calcgraph_session.rs:2042:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2130:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2163:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2229:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2346:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2370:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2449:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2527:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2561:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2607:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2635:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:2704:    // — creating false `#CIRC!` cycles (H3) and false-positive dirty
crates/ql-exec/src/calcgraph_session.rs:2769:    /// false `A1 ↔ B1` cycle.
crates/ql-exec/src/calcgraph_session.rs:2782:    /// dirty set covering both, it must not fabricate a cycle.
crates/ql-exec/src/calcgraph_session.rs:2826:            sched.cycled.is_empty(),
crates/ql-exec/src/calcgraph_session.rs:2827:            "H3 closure: no false #CIRC! after rebind. cycled={:?}",
crates/ql-exec/src/calcgraph_session.rs:2828:            sched.cycled
crates/ql-exec/src/calcgraph_session.rs:2920:    // scheduler edges — Tarjan can't see range-induced cycles or
crates/ql-exec/src/calcgraph_session.rs:2922:    // at `schedule_dirty` time: for each dirty formula F with range
crates/ql-exec/src/calcgraph_session.rs:2929:    // and assert on schedule_dirty's output.
crates/ql-exec/src/calcgraph_session.rs:2932:    /// W5-50 / megaudit H1 example #1 — range-induced cycle:
crates/ql-exec/src/calcgraph_session.rs:2936:    /// in `cycled` (the cycle is `A1 → B1 → A1` via supplemental +
crates/ql-exec/src/calcgraph_session.rs:2939:    fn h1_range_induced_cycle_detected() {
crates/ql-exec/src/calcgraph_session.rs:2981:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:2984:            "all in cycled, sorted={:?}",
crates/ql-exec/src/calcgraph_session.rs:2987:        let cycled: HashSet<NodeId> = sched.cycled.iter().copied().collect();
crates/ql-exec/src/calcgraph_session.rs:2989:            cycled,
crates/ql-exec/src/calcgraph_session.rs:2991:            "H1: range-induced cycle detected"
crates/ql-exec/src/calcgraph_session.rs:2996:    /// cycle):
crates/ql-exec/src/calcgraph_session.rs:3046:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3048:            sched.cycled.is_empty(),
crates/ql-exec/src/calcgraph_session.rs:3049:            "no cycle, cycled={:?}",
crates/ql-exec/src/calcgraph_session.rs:3050:            sched.cycled
crates/ql-exec/src/calcgraph_session.rs:3055:    /// W5-50 / self-range cycle: `A1 = "=SUM(A1:A1)"`. Single dirty
crates/ql-exec/src/calcgraph_session.rs:3057:    /// Tarjan emits A1 in `cycled`.
crates/ql-exec/src/calcgraph_session.rs:3059:    fn self_range_cycle_via_supplemental() {
crates/ql-exec/src/calcgraph_session.rs:3088:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3089:        assert!(sched.sorted.is_empty(), "self-cycle, sorted empty");
crates/ql-exec/src/calcgraph_session.rs:3090:        assert_eq!(sched.cycled, vec![a1], "self-range cycle detected");
crates/ql-exec/src/calcgraph_session.rs:3133:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3139:        assert!(sched.cycled.is_empty());
crates/ql-exec/src/calcgraph_session.rs:3264:    /// range cycle), clear A1, then write A1 as a literal. The stale
crates/ql-exec/src/calcgraph_session.rs:3266:    /// anymore. schedule_dirty must NOT emit A1 in `cycled`.
crates/ql-exec/src/calcgraph_session.rs:3268:    fn clear_formula_then_no_phantom_cycle() {
crates/ql-exec/src/calcgraph_session.rs:3295:        // schedule_dirty would build supplemental A1→A1 from the
crates/ql-exec/src/calcgraph_session.rs:3297:        // `cycled` — producing a false #CIRC! on a cell that's no
crates/ql-exec/src/calcgraph_session.rs:3326:        // schedule_dirty must emit an empty schedule (no dirty
crates/ql-exec/src/calcgraph_session.rs:3327:        // formulas) — definitely no phantom cycle on A1.
crates/ql-exec/src/calcgraph_session.rs:3328:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3329:        assert!(sched.cycled.is_empty(), "no phantom cycle");
crates/ql-exec/src/calcgraph_session.rs:3391:        // directly. The `schedule_dirty` drain uses self.dirty.
crates/ql-exec/src/calcgraph_session.rs:3394:        // via schedule_dirty's output instead.
crates/ql-exec/src/calcgraph_session.rs:3402:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3403:        // Sched contains both nodes. Sanity: no false cycle (B1
crates/ql-exec/src/calcgraph_session.rs:3405:        // B1, so no cycle).
crates/ql-exec/src/calcgraph_session.rs:3406:        assert!(sched.cycled.is_empty());
crates/ql-exec/src/calcgraph_session.rs:3447:    fn rebuild_from_workbook_starts_clean_no_dirty() {
crates/ql-exec/src/calcgraph_session.rs:3449:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:3462:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:3475:    // discover the dep graph; schedule_dirty consumes the session's
crates/ql-exec/src/calcgraph_session.rs:3476:    // dirty set and returns (sorted, cycled).
crates/ql-exec/src/calcgraph_session.rs:3481:    // the schedule's `sorted` order and writes `#CIRC!` for the
crates/ql-exec/src/calcgraph_session.rs:3482:    // `cycled` set).
crates/ql-exec/src/calcgraph_session.rs:3505:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:3524:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3525:        assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
crates/ql-exec/src/calcgraph_session.rs:3534:        // dirty set is cleared after schedule_dirty.
crates/ql-exec/src/calcgraph_session.rs:3538:    /// SCH-3-02: cycles surface in `Schedule::cycled` carrying every
crates/ql-exec/src/calcgraph_session.rs:3539:    /// SCC member. Build a 2-cycle (A1 = B1 + 1; B1 = A1 + 1) and a
crates/ql-exec/src/calcgraph_session.rs:3540:    /// self-loop (D1 = D1 + 1) and verify the cycle reporter sees
crates/ql-exec/src/calcgraph_session.rs:3543:    fn sch_3_02_cycles_report_all_scc_members() {
crates/ql-exec/src/calcgraph_session.rs:3551:        // Self-cycle at D1.
crates/ql-exec/src/calcgraph_session.rs:3554:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:3561:        // Force the cycle into dirty: edit any of A1/B1, the dirty
crates/ql-exec/src/calcgraph_session.rs:3562:        // walk picks up the cycle members via direct-cell-dep reverse
crates/ql-exec/src/calcgraph_session.rs:3568:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3570:            sched.cycled.contains(&a1),
crates/ql-exec/src/calcgraph_session.rs:3571:            "A1 must surface in cycled — part of the 2-cycle"
crates/ql-exec/src/calcgraph_session.rs:3574:            sched.cycled.contains(&b1),
crates/ql-exec/src/calcgraph_session.rs:3575:            "B1 must surface in cycled — part of the 2-cycle"
crates/ql-exec/src/calcgraph_session.rs:3578:            sched.cycled.contains(&d1),
crates/ql-exec/src/calcgraph_session.rs:3579:            "D1 must surface in cycled — self-loop"
crates/ql-exec/src/calcgraph_session.rs:3582:        // a cycle).
crates/ql-exec/src/calcgraph_session.rs:3593:            let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:3596:            let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3597:            (sched.sorted, sched.cycled)
crates/ql-exec/src/calcgraph_session.rs:3622:        let r = CalcgraphSession::rebuild_from_workbook(&wb);
crates/ql-exec/src/calcgraph_session.rs:3631:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3635:            .chain(sched.cycled.iter())
crates/ql-exec/src/calcgraph_session.rs:3648:    fn schedule_dirty_with_empty_dirty_is_empty_schedule() {
crates/ql-exec/src/calcgraph_session.rs:3650:        let sched = s.schedule_dirty();
crates/ql-exec/src/calcgraph_session.rs:3661:        let r = CalcgraphSession::rebuild_from_workbook(&wb);

exec
/bin/zsh -lc 'git show --stat --oneline --decorate --no-renames 3451d90a03f' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3451d90a03f (HEAD -> feat/quantbook-engine) Tier C1 / Phase 5 prep — cycle detection in recompute_all (Opus-B H-2 closure)
 .../crates/ql-exec/src/workbook_runtime.rs         | 158 +++++++++++++++++++++
 1 file changed, 158 insertions(+)

exec
/bin/zsh -lc 'git status --short && git rev-parse --show-toplevel && git rev-parse HEAD && git branch --show-current' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 927ms:
?? ../2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt
?? ../2026-05-13-003338-this-session-is-being-continued-from-a-previous-c.txt
?? ../node_modules
?? .codex/prompts/2026-05-14-AA-design-review.md
?? .codex/prompts/2026-05-14-J-127-verify.md
?? .codex/prompts/2026-05-14-J-128-verify.md
?? .codex/prompts/2026-05-14-J-129-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-132-133followup-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-HIGH3-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-LOW-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-MEDIUM4-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-MEDIUM5-verify.md
?? .codex/prompts/2026-05-14-K-verify.md
?? .codex/prompts/2026-05-14-L-verify.md
?? .codex/prompts/2026-05-14-M-verify.md
?? .codex/prompts/2026-05-14-N-verify.md
?? .codex/prompts/2026-05-14-O-closure-verify.md
?? .codex/prompts/2026-05-14-O-megaudit.md
?? .codex/prompts/2026-05-14-phase-4.7.I-review.md
?? .codex/prompts/2026-05-14-phase-4.7.J-megaudit-pass2.md
?? .codex/prompts/2026-05-14-phase-4.7.J-review.md
?? .codex/prompts/2026-05-15-phase-4.8-closing-megaudit.md
?? .codex/prompts/2026-05-15-phase-4.8-closure-verify.md
?? .codex/prompts/2026-05-15-phase-4.8-final-reverify.md
?? .codex/prompts/2026-05-15-phase-4.9-design-review.md
?? .codex/prompts/2026-05-15-phase-4.9-mid-arc-audit.md
?? .plans/
?? 2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? 2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt
?? docs/audits/.codex-4.10-pre-review-prompt.md
?? docs/audits/.codex-4.8.G.3-megaudit-prompt.md
?? docs/audits/.codex-reference-tier-design-prompt.md
?? docs/audits/.codex-rt-step-1-prompt.md
?? docs/audits/.codex-rt-step-2-prompt.md
?? docs/audits/.codex-rt-step-3-prompt.md
?? docs/audits/.codex-rt-step-4-prompt.md
?? docs/audits/.codex-w5-d-1-prompt.md
?? docs/audits/.codex-w5155-prompt.md
?? docs/audits/.codex-w5170-megaudit-prompt.md
?? docs/audits/2026-05-14-phase-4.7.H-codex-review.txt
?? docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md
?? docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md
?? docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md
?? docs/audits/2026-05-15-phase-4.8-final-reverify-codex.md
?? docs/audits/2026-05-15-phase-4.9-design-review-codex.md
?? docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md
?? docs/audits/2026-05-15-w5155-audit-codex.md
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
3451d90a03f4e4b3cc577b3557c4f965dd696ce3
feat/quantbook-engine

codex
The branch is already at `3451d90a03f` on `feat/quantbook-engine`; the worktree has unrelated untracked files outside this audit. I’m reading the changed runtime code and the scheduler/replay paths now.
exec
/bin/zsh -lc "awk 'NR>=858 && NR<=955 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "awk 'NR>=3120 && NR<=3275 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
858:    /// **G3-01 acceptance.** Deterministic rebuild from an existing
859:    /// `Workbook`. Walks every formula cell in sorted `(sheet, row, col)`
860:    /// order, adds a `CellNode` per cell, populates the cell index,
861:    /// and (Phase 3.2) lex+parse+binds each formula to extract
862:    /// dependencies.
863:    ///
864:    /// Determinism: same workbook → same node IDs in the same order.
865:    /// Workbook's underlying `formula_cells` is a `HashMap` (arbitrary
866:    /// iteration order), so we sort before adding nodes.
867:    ///
868:    /// Failures aggregate into [`RebuildResult::failures`] rather than
869:    /// short-circuiting — the returned session is usable, just with
870:    /// some formulas missing dep info. Matches Phase 2B.2's
871:    /// `RecomputeResult` shape.
872:    pub fn rebuild_from_workbook(wb: &Workbook) -> RebuildResult {
873:        let mut session = Self::new();
874:
875:        // Snapshot + sort the formula list for determinism.
876:        let mut formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = wb
877:            .iter_formulas()
878:            .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
879:            .collect();
880:        formulas.sort_by_key(|a| (a.0, a.1, a.2));
881:
882:        let attempted = formulas.len();
883:        let mut succeeded = 0;
884:        let mut failures: Vec<RebuildFailure> = Vec::new();
885:
886:        // Phase 3.4: pre-pass — insert a CellNode for every formula
887:        // before any extract runs. The Tarjan-side forward edges
888:        // require `cell_index` to be COMPLETE at extract time so
889:        // formula `=A1` at C1 can see A1's node and add the edge
890:        // (otherwise late-arriving deps would be missed). Done in
891:        // sorted order so node IDs stay deterministic.
892:        for (sheet, row, col, _) in &formulas {
893:            session.or_insert_cell_node(*sheet, *row, *col);
894:        }
895:
896:        for (sheet, row, col, text) in formulas {
897:            let node = session
898:                .cell_node_for(sheet, row, col)
899:                .expect("pre-pass inserted every formula's node");
900:
901:            // Phase 3.2: lex + parse + bind + extract deps. Failure
902:            // accumulates; we keep going. Phase 3.3 passes the
903:            // formula's owning sheet so the stripe register can use
904:            // the correct fallback for any range with `sheet: None`.
905:            match Self::bind_text(
906:                &text,
907:                BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
908:                wb,
909:            ) {
910:                Ok(plan) => {
911:                    session.extract_and_register_deps(node, sheet, &plan, wb);
912:                    succeeded += 1;
913:                }
914:                Err(error) => failures.push(RebuildFailure {
915:                    sheet,
916:                    row,
917:                    col,
918:                    formula_text: text,
919:                    error,
920:                }),
921:            }
922:        }
923:        // Phase 3.3: a fresh rebuild starts with NO dirty formulas —
924:        // the caller has presumably already evaluated every cell into
925:        // the workbook (e.g. `load_workbook_and_recompute`), so the
926:        // session is in a clean state.
927:        session.dirty.clear();
928:        // Phase 3.6: aggregate cache also starts empty. Even if the
929:        // caller pre-populated the workbook with computed values, those
930:        // values aren't keyed by `(range, function)` and don't unlock
931:        // a cache hit on next eval. `clear_all` is a no-op on a fresh
932:        // session (the Default impl initializes empty), but keeping
933:        // it makes the contract explicit.
934:        session.aggregate_cache.clear_all();
935:
936:        RebuildResult {
937:            session,
938:            attempted,
939:            succeeded,
940:            failures,
941:        }
942:    }
943:
944:    /// Internal: lex + parse + bind a formula text against the
945:    /// workbook's NameTable. Used by `rebuild_from_workbook` and by
946:    /// `on_set_formula`'s text-only fallback. Phase 3.3 may add a
947:    /// cached version that integrates with `PlanCache`.
948:    ///
949:    /// **W5-114 (Phase 4.8.E):** signature now takes `BindSite` so
950:    /// the formula's cell address flows through for structured-ref
951:    /// `[@Col]` resolution (4.8.F).
952:    fn bind_text(text: &str, site: BindSite, wb: &Workbook) -> Result<ExprPlan, RuntimeError> {
953:        let tokens = lex(text)?;
954:        let expr = parse(tokens)?;
955:        // W5-92 (Phase 4.6.D): pass `wb` for names so the two-tier

 succeeded in 0ms:
3120:    /// dirty-set lives on the session, so we can't do incremental
3121:    /// recompute without it. Callers in that mode should use
3122:    /// `recompute_all` for a full HashMap-order pass instead.
3123:    ///
3124:    /// Returns `Some(RecomputeResult)` otherwise, matching the
3125:    /// aggregation shape of `recompute_all`: per-cell failures
3126:    /// (parse / bind issues that have somehow surfaced post-bind,
3127:    /// e.g. a name was deleted between extract and recompute) are
3128:    /// collected, the rest succeed.
3129:    pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> {
3130:        // The session lives behind an `Option<&'a mut CalcgraphSession>`
3131:        // — take it out for the duration of this call so we can borrow
3132:        // both the workbook and the session simultaneously. Reattach
3133:        // before returning.
3134:        let mut session_slot = self.graph.take();
3135:        let session = session_slot.as_deref_mut()?;
3136:
3137:        // **W5-106 (Phase 4.7.M / task #136 closure)**: fixed-point
3138:        // loop. Each iteration:
3139:        //   1. claim + schedule the current dirty set.
3140:        //   2. snapshot prior + originally_dirty for newly-seen nodes
3141:        //      (carry across iterations so VEQ short-circuit still
3142:        //      works on second-iter D1's that depend on iter-1
3143:        //      formulas).
3144:        //   3. evaluate cycled + sorted.
3145:        //   4. if write_spill fired during the sorted loop, it called
3146:        //      on_set_value at spill-footprint cells, adding to dirty.
3147:        //   5. loop until session.dirty is empty.
3148:        //
3149:        // Bounded by `MAX_ITERATIONS` to prevent runaway in pathological
3150:        // cases (a workbook configuration that would not terminate).
3151:        // 100 is generous — any single set_value edit normally needs
3152:        // ≤ 2 iterations (one for the initial dirty set, one for spill
3153:        // shape-transition follow-ups).
3154:        const MAX_ITERATIONS: usize = 100;
3155:        let mut attempted: usize = 0;
3156:        let mut succeeded = 0;
3157:        let mut failures: Vec<RecomputeFailure> = Vec::new();
3158:        let mut skipped_value_equality: usize = 0;
3159:        // Phase 3.9 (W5-42): SIMD-eligibility profile. V1 observability
3160:        // only.
3161:        let mut simd_classified: usize = 0;
3162:
3163:        // Phase 3.8 (W5-41, VEQ-3-01..03) — value-equality short-
3164:        // circuit. State accumulates across fixed-point iterations:
3165:        //   - `prior`: workbook value at each first-seen node, captured
3166:        //     BEFORE that iteration's evaluation. Carries across iters
3167:        //     so VEQ comparisons stay anchored to the pre-recompute
3168:        //     value, not intermediate spill-write values.
3169:        //   - `originally_dirty`: NodeIds claimed by ANY iteration's
3170:        //     schedule. Used to distinguish "top-level dirty" from
3171:        //     "downstream dirty" for the VEQ decision.
3172:        //   - `changed`: addresses whose value differs from `prior`
3173:        //     after any iteration's write. Built up across iters.
3174:        use std::collections::{HashMap, HashSet};
3175:        let mut prior: HashMap<(SheetId, RowId, ColId), Value> = HashMap::new();
3176:        let mut originally_dirty: HashSet<ql_calcgraph::NodeId> = HashSet::new();
3177:        let mut changed: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
3178:        // **Codex audit MEDIUM closure**: surface iteration-cap hits
3179:        // instead of silently breaking. After the loop, if `iter_count`
3180:        // reached MAX_ITERATIONS AND session.dirty() is still non-empty,
3181:        // surface a synthetic failure so the caller's `is_complete()`
3182:        // check (which inspects `failures.is_empty()`) signals the
3183:        // problem.
3184:        let mut iter_count: usize = 0;
3185:
3186:        for _iter in 0..MAX_ITERATIONS {
3187:            iter_count += 1;
3188:            // Phase 3.4: claim dirty + topo-sort. Edges in the graph
3189:            // model the dep direction (`outgoing(F) = what F depends on`).
3190:            // Tarjan emits SCCs in reverse-topo of the condensation
3191:            // which, for our edge orientation, is dependency-first order.
3192:            let sched = session.schedule_dirty();
3193:            if sched.total_count() == 0 {
3194:                break; // Fixed point reached.
3195:            }
3196:            attempted += sched.total_count();
3197:
3198:            // Snapshot prior + originally_dirty for newly-seen nodes.
3199:            for n in sched.sorted.iter().chain(sched.cycled.iter()) {
3200:                originally_dirty.insert(*n);
3201:                if let Some(addr) = session.cell_address_for(*n) {
3202:                    prior.entry(addr).or_insert_with(|| {
3203:                        self.workbook
3204:                            .read(ql_types::Address::new(addr.0, addr.1, addr.2))
3205:                    });
3206:                }
3207:            }
3208:
3209:            // Cycled nodes get `#CIRC!` regardless of whether the
3210:            // formula still binds. Phase 3.5: routes to the computed
3211:            // overlay. Phase 3.8: still apply value-equality.
3212:            let circ = Value::Error(ErrorValue::Circ);
3213:            for node in &sched.cycled {
3214:                let Some((sheet, row, col)) = session.cell_address_for(*node) else {
3215:                    continue;
3216:                };
3217:                let prior_val = prior.get(&(sheet, row, col));
3218:                if prior_val == Some(&circ) {
3219:                    skipped_value_equality += 1;
3220:                } else {
3221:                    self.workbook.put_computed_at(sheet, row, col, circ.clone());
3222:                    changed.insert((sheet, row, col));
3223:                }
3224:            }
3225:
3226:            // Sorted nodes evaluate in dependency-first order.
3227:            for node in &sched.sorted {
3228:                let Some((sheet, row, col)) = session.cell_address_for(*node) else {
3229:                    continue;
3230:                };
3231:                let Some(text) = self.workbook.formula_at(sheet, row, col).cloned() else {
3232:                    continue;
3233:                };
3234:
3235:                // Phase 3.8: VEQ decision — does any upstream of `node`
3236:                // have a reason to recompute? Cases:
3237:                //   a) Volatile (NOW/RAND/etc.) — always re-eval (its
3238:                //      value can change without any cell edit).
3239:                //   b) Has named-range deps — V1 conservatively re-evals
3240:                //      (we don't track per-cell-in-range changes yet).
3241:                //   c) Has at least one direct-cell dep that's a
3242:                //      formula in the original dirty set AND that
3243:                //      formula's value changed → re-eval.
3244:                //   d) Has NO direct-cell dep that's in the original
3245:                //      dirty set (top-level dirty; came from an external
3246:                //      edit) → re-eval.
3247:                //   e) All direct-cell deps are in the dirty set but
3248:                //      none ended up in `changed` → SKIP.
3249:                let is_volatile = session.is_volatile(*node);
3250:                let needs_eval = if is_volatile {
3251:                    true
3252:                } else if let Some(deps) = session.formula_deps(*node) {
3253:                    if !deps.named_ranges.is_empty() {
3254:                        true
3255:                    } else {
3256:                        let mut had_dirty_dep = false;
3257:                        let mut had_changed_dep = false;
3258:                        // **Codex audit HIGH-1 closure**: VEQ-defeat for
3259:                        // producer-aliased deps. A dep that resolves to a
3260:                        // current spill ANCHOR may have target-value
3261:                        // changes that the VEQ "changed[anchor]" set
3262:                        // doesn't capture (anchor value can be invariant
3263:                        // while target values change — e.g.
3264:                        // SEQUENCE(3,1,1,A1)'s start=1 is fixed but
3265:                        // step depends on A1, so C2/C3 vary). Force
3266:                        // re-eval whenever a dep is a CURRENT spill
3267:                        // anchor and was dirty in some iteration.
3268:                        let mut had_aliased_dirty_dep = false;
3269:                        for &(ds, dr, dc) in &deps.cells {
3270:                            if let Some(dep_node) = session.cell_node_for(ds, dr, dc) {
3271:                                if originally_dirty.contains(&dep_node) {
3272:                                    had_dirty_dep = true;
3273:                                    if changed.contains(&(ds, dr, dc)) {
3274:                                        had_changed_dep = true;
3275:                                        break;

exec
/bin/zsh -lc "awk 'NR>=2990 && NR<=3120 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
2990:            crate::eval_result::EvalResult::Array(a) => a.at(0, 0).clone(),
2991:        })
2992:    }
2993:
2994:    pub fn recompute_all(&mut self) -> RecomputeResult {
2995:        // **Tier C1 (2026-05-18 — Phase 4.12 Opus-B H-2 closure):**
2996:        // cycle detection. `recompute_all` is the no-session-attached
2997:        // fallback used by `.qbook` load + replay. Before this fix,
2998:        // cyclic formulas like `=A1+1` in A1 silently produced
2999:        // wrong values on each call (1, then 2, then 3, …) because
3000:        // HashMap-order evaluation just re-read the prior value.
3001:        //
3002:        // Strategy: build an ephemeral `CalcgraphSession` from the
3003:        // current workbook, mark every formula dirty, run Tarjan
3004:        // SCC via `schedule_dirty`, and write `#CIRC!` for every
3005:        // cell in a cycle. The acyclic remainder evaluates through
3006:        // the existing HashMap-order loop unchanged.
3007:        //
3008:        // `rebuild_from_workbook` parses every formula a second
3009:        // time (the existing loop below also parses each via
3010:        // `try_recompute_one_cached`). Acceptable cost for the
3011:        // load/replay path; `recompute_dirty` is the performance
3012:        // path with session-attached callers.
3013:        let cycled_cells: std::collections::HashSet<(SheetId, RowId, ColId)> = {
3014:            use crate::calcgraph_session::CalcgraphSession;
3015:            let mut session = CalcgraphSession::rebuild_from_workbook(self.workbook).session;
3016:            let formula_addrs: Vec<(SheetId, RowId, ColId)> = self
3017:                .workbook
3018:                .iter_formulas()
3019:                .map(|(s, r, c, _)| (s, r, c))
3020:                .collect();
3021:            for (s, r, c) in &formula_addrs {
3022:                if let Some(node) = session.cell_node_for(*s, *r, *c) {
3023:                    session.mark_dirty(node);
3024:                }
3025:            }
3026:            let sched = session.schedule_dirty();
3027:            sched
3028:                .cycled
3029:                .into_iter()
3030:                .filter_map(|n| session.cell_address_for(n))
3031:                .collect()
3032:        };
3033:
3034:        // Snapshot the formula list so we don't hold a borrow during eval.
3035:        let entries: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
3036:            .workbook
3037:            .iter_formulas()
3038:            .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
3039:            .collect();
3040:        let attempted = entries.len();
3041:        let mut succeeded = 0;
3042:        let mut failures: Vec<RecomputeFailure> = Vec::new();
3043:
3044:        for (sheet, row, col, formula_text) in entries {
3045:            // Tier C1: cycled cells short-circuit to #CIRC! without
3046:            // running bind/eval. Matches `recompute_dirty`'s contract
3047:            // (cycled cells contribute to `attempted` but not
3048:            // `succeeded` — `succeeded` is reserved for sorted-path
3049:            // evaluations).
3050:            if cycled_cells.contains(&(sheet, row, col)) {
3051:                self.workbook
3052:                    .put_computed_at(sheet, row, col, Value::Error(ErrorValue::Circ));
3053:                continue;
3054:            }
3055:            match self.try_recompute_one_cached(sheet, row, col, &formula_text) {
3056:                Ok(value) => {
3057:                    // Phase 3.5 (CORR-25): formula outputs route to the
3058:                    // COMPUTED overlay, never the user lane.
3059:                    self.workbook.put_computed_at(sheet, row, col, value);
3060:                    succeeded += 1;
3061:                }
3062:                Err(error) => {
3063:                    // **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):**
3064:                    // mirror `recompute_dirty`'s table-bind-error
3065:                    // mapping so the recompute_all path (used by
3066:                    // replay + headless callers) also honors
3067:                    // design § 12.4 — dropped-table refs emit
3068:                    // `#NAME?`, not a recompute failure with a
3069:                    // stale cell value.
3070:                    if let RuntimeError::Bind(
3071:                        BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
3072:                    ) = &error
3073:                    {
3074:                        self.workbook.put_computed_at(
3075:                            sheet,
3076:                            row,
3077:                            col,
3078:                            Value::Error(ErrorValue::Name),
3079:                        );
3080:                        succeeded += 1;
3081:                    } else {
3082:                        failures.push(RecomputeFailure {
3083:                            sheet,
3084:                            row,
3085:                            col,
3086:                            formula_text,
3087:                            error,
3088:                        });
3089:                    }
3090:                }
3091:            }
3092:        }
3093:
3094:        RecomputeResult {
3095:            attempted,
3096:            succeeded,
3097:            failures,
3098:            // Phase 3.8: `recompute_all` doesn't run the VEQ check —
3099:            // it's the HashMap-order legacy path that always
3100:            // re-evaluates everything. `recompute_dirty` is the path
3101:            // that benefits from value-equality short-circuit.
3102:            skipped_value_equality: 0,
3103:            // Phase 3.9: SIMD-eligibility profile is recompute_dirty-
3104:            // only. `recompute_all` is the legacy full-pass path.
3105:            simd_classified: 0,
3106:        }
3107:    }
3108:
3109:    /// **Engine Phase 3.4 (2026-05-12) — W5-37 SCH-3-01..04 entry
3110:    /// point.** Recompute only the formulas the attached
3111:    /// [`CalcgraphSession`] has marked dirty since the last call.
3112:    /// The scheduler runs iterative Tarjan SCC over the dirty
3113:    /// subset; nodes in non-trivial SCCs (or with self-loops) are
3114:    /// written as `Value::Error(ErrorValue::Circ)`. Everything else
3115:    /// is evaluated in topological order via the existing PlanCache
3116:    /// pipeline.
3117:    ///
3118:    /// Returns `None` when no `CalcgraphSession` is attached (the
3119:    /// runtime was constructed via `new` or `with_oplog`); the
3120:    /// dirty-set lives on the session, so we can't do incremental

exec
/bin/zsh -lc "awk 'NR>=1640 && NR<=1775 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1640:    /// The dirty set is cleared by this call. Edges to non-dirty
1641:    /// nodes are not traversed (those nodes aren't being recomputed;
1642:    /// their current values are read as-is). Input ordering is
1643:    /// sorted-by-NodeId before the scheduler runs so SCH-3-03
1644:    /// determinism holds: same workbook + same edits → same schedule
1645:    /// across runs (the underlying scheduler is already deterministic
1646:    /// in its input slice order; we just normalize HashSet iteration).
1647:    pub fn schedule_dirty(&mut self) -> Schedule {
1648:        let mut dirty_vec: Vec<NodeId> = self.dirty.drain().collect();
1649:        dirty_vec.sort();
1650:        // W5-50 (GAP-G-03 closure): inject supplemental adjacency so
1651:        // Tarjan can see range-induced ordering / cycles. The Phase 0
1652:        // graph stores range deps in stripes + `formula_to_range_deps`
1653:        // rather than as `add_edge` edges (the A4 acceptance: SUM(A:A)
1654:        // must compress to ONE RangeRef, not 25M edges). For Tarjan we
1655:        // expand range deps lazily into temp edges F → G where G is a
1656:        // dirty formula inside one of F's ranges.
1657:        let supplemental = self.build_range_supplemental(&dirty_vec);
1658:        schedule_with_supplemental(&self.graph, &dirty_vec, &supplemental)
1659:    }
1660:
1661:    /// W5-50 — build the supplemental adjacency for
1662:    /// `topo::schedule_with_supplemental`. For each dirty formula `F`
1663:    /// with at least one range dep, and each OTHER (or same — for
1664:    /// self-range cycles) dirty formula `G` whose cell address falls
1665:    /// inside one of F's ranges, emit a temp edge `F → G`.
1666:    ///
1667:    /// Per Codex (W5-49 review): scope is **dirty formula nodes only**.
1668:    /// Non-formula cells (literals) inside the range are read as
1669:    /// current values during recompute, NOT scheduled — adding edges
1670:    /// to them would just produce no-op Tarjan filtering.
1671:    ///
1672:    /// Determinism: `dirty_vec` is sorted by NodeId before this call
1673:    /// runs, so the supplemental Vec entries land in a deterministic
1674:    /// order (same dirty set + same graph → same supplemental → same
1675:    /// Schedule).
1676:    ///
1677:    /// Complexity: O(|dirty_vec|² × avg_ranges_per_formula). Typical
1678:    /// edits have small dirty sets; the inner loop is a tight
1679:    /// `range_contains_rowcol` check. If profiling later shows pain,
1680:    /// switching to per-range bucketing (build a per-stripe index of
1681:    /// dirty formulas, intersect with range bounds) is the path.
1682:    fn build_range_supplemental(&self, dirty_vec: &[NodeId]) -> HashMap<NodeId, Vec<NodeId>> {
1683:        // Resolve cell addresses for every dirty FORMULA node. Non-
1684:        // formula NodeIds (none exist today — the graph only adds Cell
1685:        // nodes for formula cells) filter out via cell_address_for
1686:        // returning None.
1687:        let dirty_addrs: Vec<(NodeId, SheetId, RowId, ColId)> = dirty_vec
1688:            .iter()
1689:            .filter_map(|&n| self.cell_address_for(n).map(|(s, r, c)| (n, s, r, c)))
1690:            .collect();
1691:
1692:        let mut supplemental: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
1693:        for &(f, fs, _, _) in &dirty_addrs {
1694:            let ranges = self.graph.range_deps_for(f);
1695:            if ranges.is_empty() {
1696:                continue;
1697:            }
1698:            // W5-52 (audit closure, Sonnet MEDIUM): deduplicate G across
1699:            // F's multiple ranges. Without this, a formula with two
1700:            // overlapping ranges (e.g., SUM(A1:A10) + SUM(A1:A5)) that
1701:            // both contain the same dirty G would push G twice into
1702:            // `supplemental[F]`. Tarjan handles duplicate edges
1703:            // correctly, but the Vec growth is wasted work — and this
1704:            // gets worse as Phase 4.3 V2 adds multi-range functions.
1705:            // `added.insert(g)` returns `true` on first add only.
1706:            let mut added: HashSet<NodeId> = HashSet::new();
1707:            for range in ranges {
1708:                let resolved_sheet = Graph::range_ref_sheet(range).unwrap_or(fs);
1709:                for &(g, gs, gr, gc) in &dirty_addrs {
1710:                    if gs != resolved_sheet {
1711:                        continue;
1712:                    }
1713:                    if range_contains_rowcol(range, gr, gc) && added.insert(g) {
1714:                        supplemental.entry(f).or_default().push(g);
1715:                    }
1716:                }
1717:            }
1718:        }
1719:        supplemental
1720:    }
1721:}
1722:
1723:#[cfg(test)]
1724:mod tests {
1725:    use super::*;
1726:    use crate::plan::BindError;
1727:    use ql_types::Value;
1728:
1729:    /// **W5-RT-1 / Step 1.1 (S1-MED-ζ closure):** pin the address-only
1730:    /// reference-aware fn list against the design's explicit enumeration.
1731:    /// Spelling drift in `is_address_only_reference_fn` is caught here;
1732:    /// adding ISFORMULA or FORMULATEXT to the list by accident (the design
1733:    /// reserves them for value-dep / formula-status-dep over-recompute
1734:    /// per § 8 R8) would also fail.
1735:    #[test]
1736:    fn dep_suppressed_reference_fns_match_design() {
1737:        // Address-only — value-deps suppressed for these.
1738:        for name in &["ROW", "COLUMN", "ROWS", "COLUMNS", "ISREF"] {
1739:            assert!(
1740:                is_address_only_reference_fn(name),
1741:                "design § 5.3 lists {name:?} as address-only but matcher returns false"
1742:            );
1743:        }
1744:        // Reference-aware but NOT address-only — value-deps kept as v1 cost.
1745:        for name in &["ISFORMULA", "FORMULATEXT"] {
1746:            assert!(
1747:                !is_address_only_reference_fn(name),
1748:                "{name:?} should keep value-deps (formula-status / source-text \
1749:                 access) — must not be in is_address_only_reference_fn"
1750:            );
1751:        }
1752:        // Typo guards.
1753:        for name in &["RAW", "COLUM", "ISREFENCE", "SUM", "IF"] {
1754:            assert!(
1755:                !is_address_only_reference_fn(name),
1756:                "{name:?} is not reference-aware; must not be in the suppressed list"
1757:            );
1758:        }
1759:    }
1760:
1761:    fn workbook_with_formulas(formulas: &[(SheetId, RowId, ColId, &str)]) -> Workbook {
1762:        let mut wb = Workbook::new();
1763:        // Ensure enough sheets exist.
1764:        let max_sheet = formulas.iter().map(|(s, _, _, _)| *s).max().unwrap_or(0);
1765:        for i in 0..=max_sheet {
1766:            wb.add_sheet(format!("S{i}"));
1767:        }
1768:        for (sheet, row, col, text) in formulas {
1769:            wb.put_at(*sheet, *row, *col, Value::Blank);
1770:            wb.put_formula(*sheet, *row, *col, *text);
1771:        }
1772:        wb
1773:    }
1774:
1775:    #[test]

exec
/bin/zsh -lc "awk 'NR>=56 && NR<=90 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/loader.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
56:pub fn load_workbook_and_recompute(
57:    path: &Path,
58:    registry: &FunctionRegistry,
59:) -> Result<(Workbook, RecomputeResult), QbookError> {
60:    let mut workbook = ql_io::load_workbook(path)?;
61:    let recompute = {
62:        let mut runtime = WorkbookRuntime::new(&mut workbook, registry);
63:        runtime.recompute_all()
64:    };
65:    Ok((workbook, recompute))
66:}
67:
68:#[cfg(test)]
69:mod tests {
70:    use super::*;
71:    use ql_functions::default_registry;
72:    use ql_io::save_workbook;
73:    use ql_types::{Address, Value};
74:    use tempfile::TempDir;
75:
76:    fn temp_path(name: &str) -> (TempDir, std::path::PathBuf) {
77:        let dir = TempDir::new().unwrap();
78:        let path = dir.path().join(name);
79:        (dir, path)
80:    }
81:
82:    #[test]
83:    fn load_and_recompute_refreshes_formula_values() {
84:        // Save a workbook with a formula; then tamper with the on-disk cached
85:        // value (simulated by computing a formula against one A1 value, then
86:        // changing A1 before the load). load_workbook_and_recompute should
87:        // re-evaluate so the formula reflects the new A1.
88:        let (_dir, path) = temp_path("refresh.qbook");
89:
90:        let mut wb = Workbook::new();

exec
/bin/zsh -lc "awk 'NR>=3268 && NR<=3375 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3268:                        let mut had_aliased_dirty_dep = false;
3269:                        for &(ds, dr, dc) in &deps.cells {
3270:                            if let Some(dep_node) = session.cell_node_for(ds, dr, dc) {
3271:                                if originally_dirty.contains(&dep_node) {
3272:                                    had_dirty_dep = true;
3273:                                    if changed.contains(&(ds, dr, dc)) {
3274:                                        had_changed_dep = true;
3275:                                        break;
3276:                                    }
3277:                                    if self.workbook.spill_anchor_at(ds, dr, dc).is_some() {
3278:                                        had_aliased_dirty_dep = true;
3279:                                    }
3280:                                }
3281:                            }
3282:                        }
3283:                        // Re-eval if: top-level dirty (no dirty dep),
3284:                        // OR a dirty dep value-changed,
3285:                        // OR a dirty dep is a spill anchor (target
3286:                        //    values may have changed even if anchor
3287:                        //    value didn't).
3288:                        !had_dirty_dep || had_changed_dep || had_aliased_dirty_dep
3289:                    }
3290:                } else {
3291:                    // No tracked deps (e.g., `=1+1`). Treat as top-level.
3292:                    true
3293:                };
3294:
3295:                if !needs_eval {
3296:                    skipped_value_equality += 1;
3297:                    continue;
3298:                }
3299:
3300:                // Phase 3.6 (W5-39): route through the session's aggregate
3301:                // cache so `SUM(Sales)`-style formulas hit the cache when
3302:                // no cell inside `Sales` changed (AGG-3-01).
3303:                // Phase 3.9 (W5-42): also classify the plan for SIMD
3304:                // eligibility (SIMD-3-03 profile). We need the plan
3305:                // post-bind — call a slightly-expanded helper that
3306:                // returns the value AND the SimdShape classification.
3307:                let agg_cache = session.aggregate_cache();
3308:                match self.try_recompute_with_simd_profile(sheet, row, col, &text, agg_cache) {
3309:                    Ok((value, simd_eligible, old_spill_shape, new_spill_shape)) => {
3310:                        if simd_eligible {
3311:                            simd_classified += 1;
3312:                        }
3313:                        // Phase 3.8: value-equality check. If the freshly-
3314:                        // computed value matches the snapshot, suppress
3315:                        // the write entirely and don't record this cell
3316:                        // as `changed` — downstream formulas that depend
3317:                        // only on this one will skip too.
3318:                        let prior_val = prior.get(&(sheet, row, col));
3319:                        if prior_val == Some(&value) {
3320:                            skipped_value_equality += 1;
3321:                        } else {
3322:                            self.workbook.put_computed_at(sheet, row, col, value);
3323:                            changed.insert((sheet, row, col));
3324:                        }
3325:                        // **Task #136 hook pass (recompute_dirty side)**: if
3326:                        // the formula's spill shape changed (or was a new
3327:                        // spill, or just dissolved), fire on_set_value at
3328:                        // each non-anchor cell in the UNION of (old, new)
3329:                        // footprints. Readers indexed under those cells
3330:                        // get marked dirty; the fixed-point loop picks them
3331:                        // up in a follow-up iteration.
3332:                        //
3333:                        // **Codex audit HIGH-1 closure**: ALSO fire
3334:                        // on_set_value(anchor) — `cell_to_formulas[anchor]`
3335:                        // holds readers producer-aliased to this spill
3336:                        // (4.7.I). They need to dirty even if the anchor's
3337:                        // OWN value is VEQ-unchanged, because TARGET values
3338:                        // may have changed (e.g. SEQUENCE(3,1,1,A1): anchor
3339:                        // value = start = 1 invariant, but C2/C3 vary with
3340:                        // A1). Over-conservative for direct readers of the
3341:                        // anchor (they'd re-eval to the same value and
3342:                        // VEQ-skip the write), but correct.
3343:                        if old_spill_shape.is_some() || new_spill_shape.is_some() {
3344:                            use std::collections::HashSet;
3345:                            let mut affected: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
3346:                            for shape in [old_spill_shape, new_spill_shape].into_iter().flatten() {
3347:                                for dr in 0..shape.rows {
3348:                                    for dc in 0..shape.cols {
3349:                                        if dr == 0 && dc == 0 {
3350:                                            continue;
3351:                                        }
3352:                                        affected.insert((sheet, row + dr, col + dc));
3353:                                    }
3354:                                }
3355:                            }
3356:                            for (s, r, c) in affected {
3357:                                session.on_set_value(s, r, c);
3358:                            }
3359:                            // Anchor cell — dirties aliased readers.
3360:                            session.on_set_value(sheet, row, col);
3361:
3362:                            // **Codex audit HIGH-2 closure**: re-extract
3363:                            // readers in the (old, new) footprint. Mirrors
3364:                            // set_formula's 4.7.J.4 pattern. Required for
3365:                            // dissolution-via-recompute: aliased readers'
3366:                            // deps stay pointing at the dissolved anchor;
3367:                            // future writes to actually-read cells (e.g.
3368:                            // user typing into a now-free target) miss
3369:                            // the reader without re-extraction.
3370:                            //
3371:                            // Inlined (can't call self.reextract_spill_footprint_readers
3372:                            // because it accesses self.graph which is None
3373:                            // during recompute_dirty's session_slot window).
3374:                            let mut seen: HashSet<ql_calcgraph::NodeId> = HashSet::new();
3375:                            let mut readers: Vec<(

exec
/bin/zsh -lc "awk 'NR>=3375 && NR<=3475 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3375:                            let mut readers: Vec<(
3376:                                ql_calcgraph::NodeId,
3377:                                SheetId,
3378:                                RowId,
3379:                                ColId,
3380:                                Arc<str>,
3381:                            )> = Vec::new();
3382:                            for shape in [old_spill_shape, new_spill_shape].into_iter().flatten() {
3383:                                for n in
3384:                                    session.readers_in_rect(sheet, row, col, shape.rows, shape.cols)
3385:                                {
3386:                                    if !seen.insert(n) {
3387:                                        continue;
3388:                                    }
3389:                                    let Some((s, r, c)) = session.cell_address_for(n) else {
3390:                                        continue;
3391:                                    };
3392:                                    if (s, r, c) == (sheet, row, col) {
3393:                                        continue;
3394:                                    }
3395:                                    let Some(text) = self.workbook.formula_at(s, r, c).cloned()
3396:                                    else {
3397:                                        continue;
3398:                                    };
3399:                                    readers.push((n, s, r, c, text));
3400:                                }
3401:                            }
3402:                            for (rn, reader_sheet, reader_row, reader_col, reader_text) in readers {
3403:                                let name_gen = self.workbook.names().generation();
3404:                                // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
3405:                                // is present.
3406:                                let cell_anchor = if reader_text.contains('@') {
3407:                                    Some((reader_row, reader_col))
3408:                                } else {
3409:                                    None
3410:                                };
3411:                                let cache_key = PlanCacheKey {
3412:                                    text: Arc::clone(&reader_text),
3413:                                    sheet: reader_sheet,
3414:                                    name_gen,
3415:                                    cell_anchor,
3416:                                };
3417:                                let workbook: &Workbook = self.workbook;
3418:                                let plan: Arc<crate::plan::ExprPlan> =
3419:                                    match self.plan_cache.get_or_insert::<_, RuntimeError>(
3420:                                        cache_key,
3421:                                        || {
3422:                                            let tokens = lex(reader_text.as_ref())?;
3423:                                            let expr = parse(tokens)?;
3424:                                            // **W5-114 (Phase 4.8.E):** reader cell addr.
3425:                                            Ok(bind_with_site(
3426:                                                &expr,
3427:                                                BindSite::at_cell(ql_types::Address::new(
3428:                                                    reader_sheet,
3429:                                                    reader_row,
3430:                                                    reader_col,
3431:                                                )),
3432:                                                workbook,
3433:                                                workbook,
3434:                                                workbook,
3435:                                            )?)
3436:                                        },
3437:                                    ) {
3438:                                        Ok(p) => p,
3439:                                        Err(_) => {
3440:                                            // No-fallbacks rule: bind failure
3441:                                            // here mirrors set_formula path's
3442:                                            // mark_dirty handling — surface at
3443:                                            // reader's own recompute next time.
3444:                                            session.mark_dirty(rn);
3445:                                            continue;
3446:                                        }
3447:                                    };
3448:                                session.reextract_deps(rn, plan.as_ref(), self.workbook);
3449:                                session.mark_dirty(rn);
3450:                            }
3451:                        }
3452:                        succeeded += 1;
3453:                    }
3454:                    Err(error) => {
3455:                        // **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):**
3456:                        // table-related bind failures during recompute
3457:                        // emit `#NAME?` per design § 12.4 ("re-bind to
3458:                        // BindError::UnknownTable → emit #NAME?") and
3459:                        // the `plan.rs:260` UnknownTable docstring.
3460:                        // Typical trigger: `drop_table` invalidates the
3461:                        // plan cache (W5-156 HIGH-1 fix), the on_table_drop
3462:                        // hook marks the reader dirty, recompute re-binds
3463:                        // and discovers the table is gone. Without this
3464:                        // mapping the cell would keep its pre-drop value
3465:                        // (failures collection only surfaces the error
3466:                        // to the caller; the cell overlay stays stale).
3467:                        // Counts as `succeeded` because the formula
3468:                        // evaluated to a well-defined error value, not
3469:                        // a structural recompute failure.
3470:                        if let RuntimeError::Bind(
3471:                            BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
3472:                        ) = &error
3473:                        {
3474:                            let v = Value::Error(ErrorValue::Name);
3475:                            let prior_val = prior.get(&(sheet, row, col));

exec
/bin/zsh -lc "awk 'NR>=4600 && NR<=4735 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
4600:    #[test]
4601:    fn runtime_without_oplog_set_value_and_set_formula_still_work() {
4602:        // Regression guard for the existing public API.
4603:        let mut wb = make_runtime_workbook();
4604:        let reg = default_registry();
4605:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
4606:
4607:        rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
4608:        let v = rt.set_formula(0, 1, 0, "A1 + 10").unwrap();
4609:        assert_eq!(v, Value::Number(15.0));
4610:    }
4611:
4612:    // ===== Tier C1 (2026-05-18) — Phase 4.12 Opus-B H-2 closure =====
4613:
4614:    /// `recompute_all` (no session attached — the `.qbook` load / replay
4615:    /// path) must detect cycles and emit `#CIRC!` for cycled cells.
4616:    /// Before this fix, a self-referential formula like `A1 = A1 + 1`
4617:    /// silently produced 1, then 2, then 3, … on successive calls
4618:    /// because HashMap-order evaluation just re-read the prior value.
4619:    #[test]
4620:    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
4621:        let mut wb = make_runtime_workbook();
4622:        let reg = default_registry();
4623:        wb.put_formula(0, 0, 0, "A1 + 1");
4624:        let (attempted, succeeded, failed_count) = {
4625:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
4626:            let r = rt.recompute_all();
4627:            // Repeated calls stay at #CIRC! — they don't drift.
4628:            let _ = rt.recompute_all();
4629:            (r.attempted, r.succeeded, r.failures.len())
4630:        };
4631:        // Cycled cells contribute to attempted but not succeeded.
4632:        assert_eq!(attempted, 1);
4633:        assert_eq!(succeeded, 0);
4634:        assert_eq!(failed_count, 0);
4635:        assert_eq!(
4636:            wb.read(ql_types::Address::new(0, 0, 0)),
4637:            Value::Error(ErrorValue::Circ),
4638:            "self-referential A1 = A1+1 must resolve to #CIRC!, not a stale incremented value"
4639:        );
4640:    }
4641:
4642:    /// 2-cycle: A1 = B1 + 1, B1 = A1 - 1. Both cells in the SCC must
4643:    /// resolve to `#CIRC!`. Mirrors the existing `recompute_dirty`
4644:    /// reference test (`recompute_dirty_writes_circ_error_for_cycle_members`).
4645:    #[test]
4646:    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
4647:        let mut wb = make_runtime_workbook();
4648:        let reg = default_registry();
4649:        wb.put_formula(0, 0, 0, "B1 + 1");
4650:        wb.put_formula(0, 0, 1, "A1 - 1");
4651:        let (attempted, succeeded, failed_count) = {
4652:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
4653:            let r = rt.recompute_all();
4654:            (r.attempted, r.succeeded, r.failures.len())
4655:        };
4656:        assert_eq!(attempted, 2);
4657:        assert_eq!(succeeded, 0);
4658:        assert_eq!(failed_count, 0);
4659:        assert_eq!(
4660:            wb.read(ql_types::Address::new(0, 0, 0)),
4661:            Value::Error(ErrorValue::Circ),
4662:            "A1 in 2-cycle must be #CIRC!"
4663:        );
4664:        assert_eq!(
4665:            wb.read(ql_types::Address::new(0, 0, 1)),
4666:            Value::Error(ErrorValue::Circ),
4667:            "B1 in 2-cycle must be #CIRC!"
4668:        );
4669:    }
4670:
4671:    /// Acyclic mix with a cycle: A1 = 5, B1 = A1 * 2, C1 = C1 + 1
4672:    /// (self-referential). A1 and B1 evaluate normally; C1 emits
4673:    /// `#CIRC!`. Verifies cycle detection doesn't pollute the
4674:    /// acyclic remainder.
4675:    #[test]
4676:    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
4677:        let mut wb = make_runtime_workbook();
4678:        let reg = default_registry();
4679:        wb.put_at(0, 0, 0, Value::Number(5.0));
4680:        wb.put_formula(0, 0, 1, "A1 * 2");
4681:        wb.put_formula(0, 0, 2, "C1 + 1");
4682:        let (attempted, succeeded, failed_count) = {
4683:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
4684:            let r = rt.recompute_all();
4685:            (r.attempted, r.succeeded, r.failures.len())
4686:        };
4687:        assert_eq!(attempted, 2, "B1 + C1 are the formulas");
4688:        assert_eq!(succeeded, 1, "B1 evaluates; C1 is cycled");
4689:        assert_eq!(failed_count, 0);
4690:        assert_eq!(
4691:            wb.read(ql_types::Address::new(0, 0, 1)),
4692:            Value::Number(10.0)
4693:        );
4694:        assert_eq!(
4695:            wb.read(ql_types::Address::new(0, 0, 2)),
4696:            Value::Error(ErrorValue::Circ)
4697:        );
4698:    }
4699:
4700:    /// Cycle value must be stable across repeated `recompute_all`
4701:    /// calls — no drift between iterations. Before this fix, A1 in
4702:    /// `A1 = A1 + 1` returned 1, 2, 3, … instead of #CIRC! each time.
4703:    #[test]
4704:    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
4705:        let mut wb = make_runtime_workbook();
4706:        let reg = default_registry();
4707:        wb.put_formula(0, 0, 0, "A1 + 1");
4708:        {
4709:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
4710:            for _ in 0..5 {
4711:                rt.recompute_all();
4712:            }
4713:        }
4714:        assert_eq!(
4715:            wb.read(ql_types::Address::new(0, 0, 0)),
4716:            Value::Error(ErrorValue::Circ),
4717:            "cycle value must remain #CIRC! across repeated recompute_all calls (no drift)"
4718:        );
4719:    }
4720:
4721:    // ===== Phase 2B.2 — RecomputeResult contract =====
4722:
4723:    /// R2B-01: a structural failure surfaces with the exact cell address +
4724:    /// formula text + underlying RuntimeError. No information is lost going
4725:    /// from "failed cell" to "RecomputeFailure entry".
4726:    #[test]
4727:    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
4728:        let mut wb = make_runtime_workbook();
4729:        // Seed an unparseable formula by hand-writing it into the workbook
4730:        // (bypassing the runtime's set_formula which would reject it
4731:        // up-front). This simulates the on-disk-corruption scenario the
4732:        // loader handles.
4733:        wb.put_formula(0, 3, 5, "(((");
4734:
4735:        let reg = default_registry();

exec
/bin/zsh -lc "awk 'NR>=3470 && NR<=3545 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "awk 'NR>=1 && NR<=260 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"recompute_all\\(|recompute_dirty\\(|load_workbook_and_recompute|WorkbookRuntime::new|with_oplog|Runtime\" crates/ql-oplog/src/replay.rs crates/ql-oplog/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3470:                        if let RuntimeError::Bind(
3471:                            BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
3472:                        ) = &error
3473:                        {
3474:                            let v = Value::Error(ErrorValue::Name);
3475:                            let prior_val = prior.get(&(sheet, row, col));
3476:                            if prior_val == Some(&v) {
3477:                                skipped_value_equality += 1;
3478:                            } else {
3479:                                self.workbook.put_computed_at(sheet, row, col, v);
3480:                                changed.insert((sheet, row, col));
3481:                            }
3482:                            succeeded += 1;
3483:                        } else {
3484:                            failures.push(RecomputeFailure {
3485:                                sheet,
3486:                                row,
3487:                                col,
3488:                                formula_text: text,
3489:                                error,
3490:                            });
3491:                        }
3492:                    }
3493:                }
3494:            }
3495:        } // end MAX_ITERATIONS loop
3496:
3497:        // **Codex audit MEDIUM closure**: if we hit MAX_ITERATIONS
3498:        // AND session.dirty() is still non-empty, the fixed point
3499:        // wasn't reached. Surface as a synthetic RecomputeFailure
3500:        // so the caller's is_complete() check signals the problem
3501:        // instead of silently returning what looks like a clean
3502:        // recompute. Per CLAUDE.md no-fallbacks rule.
3503:        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
3504:            failures.push(RecomputeFailure {
3505:                sheet: 0,
3506:                row: 0,
3507:                col: 0,
3508:                formula_text: Arc::from(format!(
3509:                    "recompute_dirty hit MAX_ITERATIONS={MAX_ITERATIONS} \
3510:                     with {} cells still dirty — possible runaway spill \
3511:                     shape transition or workbook misconfiguration",
3512:                    session.dirty_formulas().len()
3513:                )),
3514:                error: RuntimeError::RecomputeIterationCap,
3515:            });
3516:        }
3517:
3518:        self.graph = session_slot;
3519:        Some(RecomputeResult {
3520:            attempted,
3521:            succeeded,
3522:            failures,
3523:            skipped_value_equality,
3524:            simd_classified,
3525:        })
3526:    }
3527:
3528:    /// Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
3529:    /// before doing lex/parse/bind work, then evaluate. Failures (lex /
3530:    /// parse / bind) propagate as `RuntimeError`; the caller bundles them
3531:    /// into a `RecomputeFailure`. Successful binds are cached so a
3532:    /// subsequent recompute (or a `set_formula` editing a nearby cell
3533:    /// with the same text) hits.
3534:    ///
3535:    /// Phase 3.6 (W5-39): this is the no-aggregate-cache wrapper. The
3536:    /// `recompute_dirty` path uses
3537:    /// [`Self::try_recompute_with_aggregate_cache`] which threads the
3538:    /// session's aggregate cache through the evaluator.
3539:    fn try_recompute_one_cached(
3540:        &mut self,
3541:        sheet: SheetId,
3542:        row: RowId,
3543:        col: ColId,
3544:        formula_text: &Arc<str>,
3545:    ) -> Result<Value, RuntimeError> {

 succeeded in 0ms:
1://! Replay an `OpLog` against a `Workbook`.
2://!
3://! Phase 2A.3.a (2026-05-12): single entry point `replay_into(&OpLog, &mut
4://! Workbook, &FunctionRegistry) -> Result<usize, ReplayError>`. Returns the
5://! count of ops successfully applied; on failure, returns
6://! `ReplayError::At { index, kind }` carrying the position of the failing
7://! op and the underlying failure. The workbook is left in a partial state
8://! on failure (callers decide whether to discard, recover, or recompute).
9://!
10://! ## Replay semantics
11://!
12://! Each `Op` variant maps to one `Workbook` mutation:
13://!
14://! - `PutValue` → `Workbook::put_at` (after row/col bounds check).
15://! - `PutFormula` → `Workbook::put_formula` (text only; replay does NOT
16://!   re-evaluate — that's a separate step the caller drives via
17://!   `WorkbookRuntime::recompute_all`).
18://! - `ClearFormula` → `Workbook::clear_formula`.
19://! - `SetName` → `Workbook::set_name`. Reserved names (e.g. `AI`) surface
20://!   as `ReplayError::NameRejected`.
21://! - `AddSheet` → `Workbook::add_sheet_with_chunk_rows`.
22://! - `BatchCommit` → recurse on each inner op. Index reporting flattens:
23://!   a failure inside a BatchCommit reports the inner op's overall
24://!   position (current outer index + offset).
25://!
26://! ## Idempotence
27://!
28://! `replay_into` is idempotent only in the trivial sense: replaying twice
29://! against the same starting workbook produces the same final state IFF
30://! the underlying mutation methods are themselves idempotent (and they
31://! are — `put_at` / `put_formula` / `clear_formula` / `set_name` /
32://! `add_sheet` all are). Callers wanting at-most-once semantics across
33://! sessions track replay state themselves (Phase 5+ work).
34://!
35://! ## `registry` parameter
36://!
37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
38://! 2A.3.a's replay doesn't use it (formula evaluation is deferred to a
39://! separate `recompute_all` call), but keeping the parameter stable here
40://! avoids a breaking signature change in 2A.3.b/c when the eval path
41://! could land inside replay.
42:
43:use ql_functions::FunctionRegistry;
44:use ql_storage::Workbook;
45:use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
46:use thiserror::Error;
47:
48:use crate::log::OpLog;
49:use crate::op::Op;
50:
51:/// Errors emitted by `replay_into`.
52:#[derive(Debug, Error)]
53:#[non_exhaustive]
54:pub enum ReplayError {
55:    /// An op-log entry failed to deserialize (corrupted log data).
56:    #[error("replay deserialize error at op index {0}: {1}")]
57:    Deserialize(usize, #[source] crate::error::OpLogError),
58:
59:    /// The op referenced an out-of-range sheet id.
60:    #[error(
61:        "replay invalid sheet at op index {index}: sheet {sheet} (workbook has {sheet_count})"
62:    )]
63:    InvalidSheet {
64:        index: usize,
65:        sheet: SheetId,
66:        sheet_count: usize,
67:    },
68:
69:    /// The op carried out-of-range row/col coordinates.
70:    #[error("replay invalid cell at op index {index}: row={row} col={col} ({why})")]
71:    InvalidCell {
72:        index: usize,
73:        row: RowId,
74:        col: ColId,
75:        why: &'static str,
76:    },
77:
78:    /// Decoding the on-wire `CellWireValue` failed (e.g., unknown error sigil).
79:    #[error("replay value-decode error at op index {index}: {source}")]
80:    ValueDecode {
81:        index: usize,
82:        #[source]
83:        source: ql_io::QbookError,
84:    },
85:
86:    /// Decoding the on-wire `NamedTargetWire` failed.
87:    #[error("replay named-target decode error at op index {index}: {source}")]
88:    NamedTargetDecode {
89:        index: usize,
90:        #[source]
91:        source: ql_io::QbookError,
92:    },
93:
94:    /// `Workbook::set_name` refused the name (reserved per CORR-06).
95:    #[error("replay name rejected at op index {index}: {name:?} ({source})")]
96:    NameRejected {
97:        index: usize,
98:        name: String,
99:        #[source]
100:        source: ql_storage::NameTableError,
101:    },
102:
103:    /// `FormatTable::register_at` refused the registration — the id is
104:    /// already taken with a different string, or the string is already
105:    /// at a different id. **W5-80 (Phase 4.5.D part 4).**
106:    #[error("replay format rejected at op index {index}: {source:?}")]
107:    FormatRejected {
108:        index: usize,
109:        #[source]
110:        source: FormatRejectedSource,
111:    },
112:
113:    /// `Op::SetCellFormat` referenced a format id that hasn't been
114:    /// registered yet. The producer SHOULD always emit `RegisterFormat`
115:    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
116:    /// **W5-80.**
117:    #[error("replay set-cell-format references unregistered format id {id} at op index {index}")]
118:    FormatNotRegistered { index: usize, id: u32 },
119:
120:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
121:    /// whose current name matches neither `old_name` nor `new_name`
122:    /// (i.e. the replay state has diverged from what the op recorded).
123:    /// Surfaces a clean error rather than silently renaming a different
124:    /// sheet.
125:    #[error(
126:        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
127:         expected current name {expected:?}, found {found:?}"
128:    )]
129:    SheetRenameNameMismatch {
130:        index: usize,
131:        id: SheetId,
132:        expected: String,
133:        found: String,
134:    },
135:
136:    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
137:    /// new name (duplicate, reserved character, empty).
138:    #[error(
139:        "replay rename-sheet rejected at op index {index}: sheet {id} \
140:         from {old_name:?} to {new_name:?} ({source})"
141:    )]
142:    SheetRenameRejected {
143:        index: usize,
144:        id: SheetId,
145:        old_name: String,
146:        new_name: String,
147:        #[source]
148:        source: ql_storage::SheetNameError,
149:    },
150:
151:    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
152:    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
153:    /// under canonical comparison, or an Excel-reserved character.
154:    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
155:    /// accepted any name, so an op log produced against a buggy
156:    /// storage path could let conflicting sheets enter replay state.
157:    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
158:    SheetNameRejected {
159:        index: usize,
160:        name: String,
161:        #[source]
162:        source: ql_storage::SheetNameError,
163:    },
164:
165:    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
166:    /// the producer should have validated. Catches snapshot-vs-replay
167:    /// divergence (e.g. snapshot already has the table; another producer
168:    /// raced).
169:    #[error("replay create-table rejected at op index {index}: {reason}")]
170:    TableCreateRejected {
171:        index: usize,
172:        name: String,
173:        reason: &'static str,
174:    },
175:
176:    /// **W5-118 (Phase 4.8.H):** `DropTable` op references a missing
177:    /// table. Surfaces snapshot-vs-replay divergence loudly per
178:    /// no-fallbacks doctrine.
179:    #[error("replay drop-table at op index {index}: table {name:?} not found")]
180:    TableNotFound { index: usize, name: String },
181:
182:    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op references a column
183:    /// that doesn't exist in the target table (case-insensitive). Either
184:    /// the source column was already dropped/renamed before this op, or
185:    /// the op log has diverged from the snapshot.
186:    #[error(
187:        "replay rename-column at op index {index}: table {table:?} \
188:         has no column {column:?}"
189:    )]
190:    TableColumnNotFound {
191:        index: usize,
192:        table: String,
193:        column: String,
194:    },
195:
196:    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op was rejected by a
197:    /// validation rule (target name already in the table, empty, etc.).
198:    /// `reason` is a static string describing which invariant fired.
199:    #[error("replay rename-column rejected at op index {index}: table {table:?} column {column:?} ({reason})")]
200:    TableColumnRejected {
201:        index: usize,
202:        table: String,
203:        column: String,
204:        reason: &'static str,
205:    },
206:
207:    /// **W5-122 (Phase 4.8.J):** `ResizeTable` op was rejected by a
208:    /// validation rule (arithmetic mismatch, trailing-columns
209:    /// mismatch, column-name collision, footprint overlap, etc.).
210:    /// `reason` is a static string describing which invariant fired.
211:    #[error("replay resize-table rejected at op index {index}: table {name:?} ({reason})")]
212:    TableResizeRejected {
213:        index: usize,
214:        name: String,
215:        reason: &'static str,
216:    },
217:
218:    /// **W5-146 (Phase 4.9.J):** `Op::SetLocale` wire value didn't
219:    /// match any known locale code. Mirrors qbook v7's
220:    /// `QbookError::UnknownLocale` (W5-145) — a forward-compat
221:    /// op-log file with an unrecognized locale string surfaces this
222:    /// instead of silently substituting EnUs (closes Sonnet L-10).
223:    /// Captures the offending string for the IDE diagnostic.
224:    #[error("replay unknown locale at op index {index}: {found:?}")]
225:    UnknownLocale { index: usize, found: String },
226:
227:    /// **W5-151 (Phase 4.9.O MEDIUM-2 closure):** `Op::SetReferenceMode`
228:    /// wire value didn't match `A1` or `R1C1`. Per design § 4.9.J,
229:    /// the forward-compat path captures unknown strings into
230:    /// `ReferenceModeWire::Unknown(_)` and replay surfaces this
231:    /// distinct error rather than letting the op silently no-op.
232:    /// Parallels `UnknownLocale` above.
233:    #[error("replay unknown reference mode at op index {index}: {found:?}")]
234:    UnknownReferenceMode { index: usize, found: String },
235:}
236:
237:/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
238:/// so `ReplayError` can stay `Clone + std::error::Error` without
239:/// borrowing into the table.
240:#[derive(Clone, Debug, thiserror::Error)]
241:#[non_exhaustive]
242:pub enum FormatRejectedSource {
243:    #[error("format id {id} already bound to {existing:?}, can't re-bind to {attempted:?}")]
244:    IdCollision {
245:        id: u32,
246:        existing: String,
247:        attempted: String,
248:    },
249:    #[error(
250:        "format string {string:?} already at id {existing_id}, can't bind to id {attempted_id}"
251:    )]
252:    StringCollision {
253:        string: String,
254:        existing_id: u32,
255:        attempted_id: u32,
256:    },
257:}
258:
259:impl From<ql_storage::FormatTableError> for FormatRejectedSource {
260:    fn from(e: ql_storage::FormatTableError) -> Self {

 succeeded in 0ms:
crates/ql-oplog/src/replay.rs:17://!   `WorkbookRuntime::recompute_all`).
crates/ql-oplog/src/replay.rs:37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
crates/ql-oplog/src/replay.rs:293:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
crates/ql-oplog/src/replay.rs:880:/// (mirror via `WorkbookRuntime::create_table`).
crates/ql-oplog/src/replay.rs:17://!   `WorkbookRuntime::recompute_all`).
crates/ql-oplog/src/replay.rs:37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
crates/ql-oplog/src/replay.rs:293:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
crates/ql-oplog/src/replay.rs:880:/// (mirror via `WorkbookRuntime::create_table`).
crates/ql-oplog/src/lib.rs:21://! `WorkbookRuntime` / `WorkbookTransaction` to emit ops. 2A.3.c (this
crates/ql-oplog/src/lib.rs:23://! via [`persistence::save_workbook_with_oplog`] /
crates/ql-oplog/src/lib.rs:24://! [`persistence::load_workbook_with_oplog`].
crates/ql-oplog/src/lib.rs:48:    load_workbook_with_oplog, save_workbook_with_oplog, PersistenceError, OPLOG_FILENAME,
crates/ql-oplog/src/persistence.rs:4://! sidecar is written by `save_workbook_with_oplog` using the closure-based
crates/ql-oplog/src/persistence.rs:18://! - `save_workbook_with_oplog` writes BOTH the workbook AND `oplog.bin`.
crates/ql-oplog/src/persistence.rs:20://! - `load_workbook_with_oplog` reads BOTH. If `oplog.bin` is missing,
crates/ql-oplog/src/persistence.rs:25://!   MUST use `save_workbook_with_oplog`. Loud: pinned by the test
crates/ql-oplog/src/persistence.rs:64:pub fn save_workbook_with_oplog(
crates/ql-oplog/src/persistence.rs:94:pub fn load_workbook_with_oplog(path: &Path) -> Result<(Workbook, OpLog), PersistenceError> {
crates/ql-oplog/src/persistence.rs:155:        save_workbook_with_oplog(&wb, &oplog, "rt", &path).unwrap();
crates/ql-oplog/src/persistence.rs:157:        let (loaded_wb, loaded_log) = load_workbook_with_oplog(&path).unwrap();
crates/ql-oplog/src/persistence.rs:166:    fn load_with_oplog_when_oplog_missing_returns_missing_file_error() {
crates/ql-oplog/src/persistence.rs:173:        let result = load_workbook_with_oplog(&path);
crates/ql-oplog/src/persistence.rs:186:        let path = dir.path().join("with_oplog.qbook");
crates/ql-oplog/src/persistence.rs:189:        save_workbook_with_oplog(&wb, &oplog, "test", &path).unwrap();
crates/ql-oplog/src/persistence.rs:201:        // an oplog.bin will NOT preserve it. The next load_workbook_with_oplog
crates/ql-oplog/src/persistence.rs:207:        save_workbook_with_oplog(&wb, &oplog, "v1", &path).unwrap();
crates/ql-oplog/src/persistence.rs:227:    fn save_with_oplog_overwrites_existing_oplog_bin() {
crates/ql-oplog/src/persistence.rs:232:        save_workbook_with_oplog(&wb, &oplog_a, "v1", &path).unwrap();
crates/ql-oplog/src/persistence.rs:244:        save_workbook_with_oplog(&wb, &oplog_b, "v2", &path).unwrap();
crates/ql-oplog/src/persistence.rs:246:        let (_, loaded_log) = load_workbook_with_oplog(&path).unwrap();
crates/ql-oplog/src/persistence.rs:269:        save_workbook_with_oplog(&wb, &oplog, "empty", &path).unwrap();
crates/ql-oplog/src/persistence.rs:271:        let (_, loaded_log) = load_workbook_with_oplog(&path).unwrap();
crates/ql-oplog/src/persistence.rs:277:    fn load_with_oplog_when_oplog_bin_is_corrupted_returns_oplog_error() {
crates/ql-oplog/src/persistence.rs:283:        save_workbook_with_oplog(&wb, &oplog, "corrupt", &path).unwrap();
crates/ql-oplog/src/persistence.rs:288:        let result = load_workbook_with_oplog(&path);
crates/ql-oplog/src/op.rs:4://! `WorkbookRuntime` and `WorkbookTransaction` can mutate through their
crates/ql-oplog/src/op.rs:44:    /// Single literal cell write. Mirrors `WorkbookRuntime::set_value`.
crates/ql-oplog/src/op.rs:53:    /// caller's `WorkbookRuntime::recompute_all`, not via replay itself).
crates/ql-oplog/src/op.rs:54:    /// Mirrors `WorkbookRuntime::set_formula` for the persistence side.
crates/ql-oplog/src/op.rs:116:    /// `WorkbookRuntime::intern_format` allocates a NEW id; idempotent
crates/ql-oplog/src/op.rs:148:    /// Mirrors `WorkbookRuntime::create_table`. Replay inserts the
crates/ql-oplog/src/op.rs:173:    /// recompute. Mirrors `WorkbookRuntime::drop_table`.
crates/ql-oplog/src/op.rs:248:    /// this op via `WorkbookRuntime::set_reference_mode`; replay calls

exec
/bin/zsh -lc 'git show --no-ext-diff --unified=80 --no-renames 3451d90a03f -- crates/ql-exec/src/workbook_runtime.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
commit 3451d90a03f4e4b3cc577b3557c4f965dd696ce3
Author: steppen0mad <nurtaymergaliyev@gmail.com>
Date:   Mon May 18 18:46:18 2026 +0100

    Tier C1 / Phase 5 prep — cycle detection in recompute_all (Opus-B H-2 closure)
    
    The `recompute_all` path (no CalcgraphSession attached — used by
    .qbook load + replay) silently produced wrong values for cyclic
    formulas. `=A1+1` in A1 returned 1, then 2, then 3 on successive
    calls because HashMap-order evaluation just re-read the prior value
    of A1. This is the Phase 5 replay-correctness gap flagged in the
    Phase 4.12 megaudit (Opus-B HIGH-2) — Phase 5 inherits the bug
    through every replay path.
    
    Fix: before the HashMap-order eval loop, build an ephemeral
    `CalcgraphSession` via `rebuild_from_workbook`, mark every formula
    dirty, run Tarjan SCC via `schedule_dirty`, and collect cycled cell
    addresses. The eval loop writes `Value::Error(ErrorValue::Circ)`
    for cycled cells and skips bind/eval for them; the acyclic
    remainder runs through the existing path unchanged.
    
    Cost: rebuild_from_workbook parses every formula once more. Real
    overhead but bounded — `recompute_all` is the no-session fallback
    that callers use when performance isn't critical;
    `recompute_dirty` remains the session-attached performance path.
    
    Semantics: cycled cells contribute to `attempted` but not
    `succeeded` (matches `recompute_dirty`'s contract per the existing
    `recompute_dirty_writes_circ_error_for_cycle_members` reference
    test). Acyclic formulas still run through HashMap order (the
    known stale-intermediate caveat documented as GAP-R-01 is
    unchanged — this commit fixes cycles ONLY).
    
    Regression tests added:
    - recompute_all_emits_circ_for_self_referential_a1_plus_one
    - recompute_all_emits_circ_for_two_cycle_a1_b1
    - recompute_all_isolates_cycle_from_acyclic_formulas
    - recompute_all_repeated_calls_are_idempotent_on_cycle
    
    Gates: 4139 workspace tests passing (4135 baseline + 4 new). fmt
    + clippy --workspace --all-targets -D warnings clean. doc warnings
    unchanged.
    
    Backlog: closes Tier C1 in docs/PHASE-4-V2-BACKLOG.md.
    Source: Phase 4.12 megaudit Opus-B HIGH-2 (cf.
    `docs/audits/2026-05-18-phase-4-12-megaudit-opus-b.md`).
    
    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

diff --git a/quantbook-engine/crates/ql-exec/src/workbook_runtime.rs b/quantbook-engine/crates/ql-exec/src/workbook_runtime.rs
index d0c87830020..228e8bbd477 100644
--- a/quantbook-engine/crates/ql-exec/src/workbook_runtime.rs
+++ b/quantbook-engine/crates/ql-exec/src/workbook_runtime.rs
@@ -2915,171 +2915,220 @@ impl<'a> WorkbookRuntime<'a> {
     /// RuntimeError>` to `RecomputeResult` (always returns; no Result
     /// wrapper). The prior shape short-circuited on first failure and
     /// dropped per-cell context; the new shape continues past failures
     /// and aggregates them. See [`RecomputeResult`] for the contract.
     ///
     /// Cells that fail structurally (lex/parse/bind) keep their
     /// pre-recompute values and formula text. Cells that succeed have
     /// their value replaced. Cells whose evaluation produces an Excel-
     /// canon error value (`#DIV/0!`, `#VALUE!`, etc.) are counted as
     /// succeeded — those error values are normal cell contents per
     /// Excel canon, not structural failures.
     /// Phase 2B.7 (2026-05-12) — dry-run formula validation for IDE
     /// on-keystroke diagnostics. Runs the full lex → parse → bind → eval
     /// pipeline against the current workbook state, returns the would-be
     /// evaluated value (or `RuntimeError`), but does NOT:
     ///
     /// - write to the workbook,
     /// - append to the op log,
     /// - pollute the bind-plan cache (this avoids a transient cache entry
     ///   keyed on a formula text the user hasn't actually committed —
     ///   would inflate the cache miss count and waste a `name_gen` slot).
     ///
     /// Use case: the IDE wants to highlight syntax errors as the user types
     /// in the formula bar, without committing the formula until Enter.
     /// Each keystroke can call `validate_formula(sheet, row, col, draft)`
     /// safely — N calls per keystroke add no engine state.
     ///
     /// Closes GAP-I-04 from `docs/known-gaps.md`.
     pub fn validate_formula(
         &self,
         sheet: SheetId,
         row: RowId,
         col: ColId,
         formula_text: &str,
     ) -> Result<Value, RuntimeError> {
         validate_cell(self.workbook, sheet, row, col)?;
         let tokens = lex(formula_text)?;
         let expr = parse(tokens)?;
         // W5-92 (Phase 4.6.D): pass `&Workbook` for names so the
         // two-tier sheet-then-workbook scope chain fires.
         // **W5-114 (Phase 4.8.E):** carry the (proposed) cell address so
         // structured-ref `[@Col]` validation works.
         let plan = bind_with_site(
             &expr,
             BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
             self.workbook,
             self.workbook,
             self.workbook,
         )?;
         // **W5-117 (Phase 4.8.G.2):** carry cell for `[@Col]` narrowing.
         let env =
             WorkbookEnv::with_formula_cell(self.workbook, ql_types::Address::new(sheet, row, col));
         // **W5-103 megaudit MEDIUM-3 closure (#129):** route through
         // `eval_at_cell_boundary` so a top-level array literal like
         // `{1, 2, 3}` returns the anchor value (array.at(0,0)) instead
         // of `#CALC!` (which is what `eval_scalar_with_registry` would
         // give per the scalar-context contract at scalar.rs:95).
         //
         // Previously the validate path used scalar eval directly, which
         // made the IDE preview inconsistent with `set_formula`'s actual
         // spill behavior. With this change, validate and set_formula
         // produce equivalent anchor-value previews. The IDE doesn't get
         // the SHAPE of the spill from validate; that would need a
         // dedicated `ValidationResult` enum (deferred — see GAP-I-04).
         let nc = crate::aggregate_cache::NoAggregateCache;
         let result = crate::scalar::eval_at_cell_boundary(&plan, &env, self.registry, &nc);
         Ok(match result {
             crate::eval_result::EvalResult::Scalar(v) => v,
             // Anchor cell preview = array.at(0,0). Degenerate arrays
             // surface as `#CALC!` per the existing scalar-context
             // contract (preserved via `into_scalar_for_test`-style
             // logic inlined here to avoid the cfg(test) gate).
             crate::eval_result::EvalResult::Array(a) if a.is_degenerate() => {
                 Value::Error(ErrorValue::Calc)
             }
             crate::eval_result::EvalResult::Array(a) => a.at(0, 0).clone(),
         })
     }
 
     pub fn recompute_all(&mut self) -> RecomputeResult {
+        // **Tier C1 (2026-05-18 — Phase 4.12 Opus-B H-2 closure):**
+        // cycle detection. `recompute_all` is the no-session-attached
+        // fallback used by `.qbook` load + replay. Before this fix,
+        // cyclic formulas like `=A1+1` in A1 silently produced
+        // wrong values on each call (1, then 2, then 3, …) because
+        // HashMap-order evaluation just re-read the prior value.
+        //
+        // Strategy: build an ephemeral `CalcgraphSession` from the
+        // current workbook, mark every formula dirty, run Tarjan
+        // SCC via `schedule_dirty`, and write `#CIRC!` for every
+        // cell in a cycle. The acyclic remainder evaluates through
+        // the existing HashMap-order loop unchanged.
+        //
+        // `rebuild_from_workbook` parses every formula a second
+        // time (the existing loop below also parses each via
+        // `try_recompute_one_cached`). Acceptable cost for the
+        // load/replay path; `recompute_dirty` is the performance
+        // path with session-attached callers.
+        let cycled_cells: std::collections::HashSet<(SheetId, RowId, ColId)> = {
+            use crate::calcgraph_session::CalcgraphSession;
+            let mut session = CalcgraphSession::rebuild_from_workbook(self.workbook).session;
+            let formula_addrs: Vec<(SheetId, RowId, ColId)> = self
+                .workbook
+                .iter_formulas()
+                .map(|(s, r, c, _)| (s, r, c))
+                .collect();
+            for (s, r, c) in &formula_addrs {
+                if let Some(node) = session.cell_node_for(*s, *r, *c) {
+                    session.mark_dirty(node);
+                }
+            }
+            let sched = session.schedule_dirty();
+            sched
+                .cycled
+                .into_iter()
+                .filter_map(|n| session.cell_address_for(n))
+                .collect()
+        };
+
         // Snapshot the formula list so we don't hold a borrow during eval.
         let entries: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
             .workbook
             .iter_formulas()
             .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
             .collect();
         let attempted = entries.len();
         let mut succeeded = 0;
         let mut failures: Vec<RecomputeFailure> = Vec::new();
 
         for (sheet, row, col, formula_text) in entries {
+            // Tier C1: cycled cells short-circuit to #CIRC! without
+            // running bind/eval. Matches `recompute_dirty`'s contract
+            // (cycled cells contribute to `attempted` but not
+            // `succeeded` — `succeeded` is reserved for sorted-path
+            // evaluations).
+            if cycled_cells.contains(&(sheet, row, col)) {
+                self.workbook
+                    .put_computed_at(sheet, row, col, Value::Error(ErrorValue::Circ));
+                continue;
+            }
             match self.try_recompute_one_cached(sheet, row, col, &formula_text) {
                 Ok(value) => {
                     // Phase 3.5 (CORR-25): formula outputs route to the
                     // COMPUTED overlay, never the user lane.
                     self.workbook.put_computed_at(sheet, row, col, value);
                     succeeded += 1;
                 }
                 Err(error) => {
                     // **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):**
                     // mirror `recompute_dirty`'s table-bind-error
                     // mapping so the recompute_all path (used by
                     // replay + headless callers) also honors
                     // design § 12.4 — dropped-table refs emit
                     // `#NAME?`, not a recompute failure with a
                     // stale cell value.
                     if let RuntimeError::Bind(
                         BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
                     ) = &error
                     {
                         self.workbook.put_computed_at(
                             sheet,
                             row,
                             col,
                             Value::Error(ErrorValue::Name),
                         );
                         succeeded += 1;
                     } else {
                         failures.push(RecomputeFailure {
                             sheet,
                             row,
                             col,
                             formula_text,
                             error,
                         });
                     }
                 }
             }
         }
 
         RecomputeResult {
             attempted,
             succeeded,
             failures,
             // Phase 3.8: `recompute_all` doesn't run the VEQ check —
             // it's the HashMap-order legacy path that always
             // re-evaluates everything. `recompute_dirty` is the path
             // that benefits from value-equality short-circuit.
             skipped_value_equality: 0,
             // Phase 3.9: SIMD-eligibility profile is recompute_dirty-
             // only. `recompute_all` is the legacy full-pass path.
             simd_classified: 0,
         }
     }
 
     /// **Engine Phase 3.4 (2026-05-12) — W5-37 SCH-3-01..04 entry
     /// point.** Recompute only the formulas the attached
     /// [`CalcgraphSession`] has marked dirty since the last call.
     /// The scheduler runs iterative Tarjan SCC over the dirty
     /// subset; nodes in non-trivial SCCs (or with self-loops) are
     /// written as `Value::Error(ErrorValue::Circ)`. Everything else
     /// is evaluated in topological order via the existing PlanCache
     /// pipeline.
     ///
     /// Returns `None` when no `CalcgraphSession` is attached (the
     /// runtime was constructed via `new` or `with_oplog`); the
     /// dirty-set lives on the session, so we can't do incremental
     /// recompute without it. Callers in that mode should use
     /// `recompute_all` for a full HashMap-order pass instead.
     ///
     /// Returns `Some(RecomputeResult)` otherwise, matching the
     /// aggregation shape of `recompute_all`: per-cell failures
     /// (parse / bind issues that have somehow surfaced post-bind,
     /// e.g. a name was deleted between extract and recompute) are
     /// collected, the rest succeed.
     pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> {
         // The session lives behind an `Option<&'a mut CalcgraphSession>`
         // — take it out for the duration of this call so we can borrow
         // both the workbook and the session simultaneously. Reattach
         // before returning.
         let mut session_slot = self.graph.take();
@@ -4483,160 +4532,269 @@ mod tests {
             // **W5-143 (Phase 4.9.G):** `@` is now the implicit-
             // intersection operator. Backtick is still rejected by
             // the lexer as unexpected char.
             let result = rt.set_formula(0, 0, 0, "`foo");
             assert!(matches!(result, Err(RuntimeError::Lex(_))));
         }
         assert!(
             oplog.is_empty(),
             "lex error must not append; got {} ops",
             oplog.len()
         );
     }
 
     #[test]
     fn set_formula_parse_error_does_not_emit_op() {
         let mut wb = make_runtime_workbook();
         let reg = default_registry();
         let mut oplog = OpLog::new();
         {
             let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
             let result = rt.set_formula(0, 0, 0, "(1 + 2");
             assert!(matches!(result, Err(RuntimeError::Parse(_))));
         }
         assert!(oplog.is_empty());
     }
 
     #[test]
     fn set_formula_invalid_cell_does_not_emit_op() {
         let mut wb = make_runtime_workbook();
         let reg = default_registry();
         let mut oplog = OpLog::new();
         {
             let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
             let result = rt.set_formula(99, 0, 0, "1 + 1");
             assert!(matches!(result, Err(RuntimeError::InvalidSheet { .. })));
         }
         assert!(oplog.is_empty());
     }
 
     #[test]
     fn recompute_all_does_not_emit_ops() {
         // recompute_all is idempotent re-evaluation; it shouldn't show up in
         // the op log as a producer mutation. (The op log records user-intent
         // edits, not derived recomputes.)
         let mut wb = make_runtime_workbook();
         let reg = default_registry();
         // Seed via the runtime so 2 ops land (1 PutValue + 1 PutFormula);
         // then recompute_all must not add more.
         let mut oplog = OpLog::new();
         {
             let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
             rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
             rt.set_formula(0, 1, 0, "A1 * 3").unwrap();
         }
         let len_before_recompute = oplog.len();
         {
             let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
             let result = rt.recompute_all();
             assert!(result.is_complete());
         }
         assert_eq!(
             oplog.len(),
             len_before_recompute,
             "recompute_all must not append ops"
         );
         assert_eq!(len_before_recompute, 2);
     }
 
     #[test]
     fn runtime_without_oplog_set_value_and_set_formula_still_work() {
         // Regression guard for the existing public API.
         let mut wb = make_runtime_workbook();
         let reg = default_registry();
         let mut rt = WorkbookRuntime::new(&mut wb, &reg);
 
         rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
         let v = rt.set_formula(0, 1, 0, "A1 + 10").unwrap();
         assert_eq!(v, Value::Number(15.0));
     }
 
+    // ===== Tier C1 (2026-05-18) — Phase 4.12 Opus-B H-2 closure =====
+
+    /// `recompute_all` (no session attached — the `.qbook` load / replay
+    /// path) must detect cycles and emit `#CIRC!` for cycled cells.
+    /// Before this fix, a self-referential formula like `A1 = A1 + 1`
+    /// silently produced 1, then 2, then 3, … on successive calls
+    /// because HashMap-order evaluation just re-read the prior value.
+    #[test]
+    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
+        let mut wb = make_runtime_workbook();
+        let reg = default_registry();
+        wb.put_formula(0, 0, 0, "A1 + 1");
+        let (attempted, succeeded, failed_count) = {
+            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+            let r = rt.recompute_all();
+            // Repeated calls stay at #CIRC! — they don't drift.
+            let _ = rt.recompute_all();
+            (r.attempted, r.succeeded, r.failures.len())
+        };
+        // Cycled cells contribute to attempted but not succeeded.
+        assert_eq!(attempted, 1);
+        assert_eq!(succeeded, 0);
+        assert_eq!(failed_count, 0);
+        assert_eq!(
+            wb.read(ql_types::Address::new(0, 0, 0)),
+            Value::Error(ErrorValue::Circ),
+            "self-referential A1 = A1+1 must resolve to #CIRC!, not a stale incremented value"
+        );
+    }
+
+    /// 2-cycle: A1 = B1 + 1, B1 = A1 - 1. Both cells in the SCC must
+    /// resolve to `#CIRC!`. Mirrors the existing `recompute_dirty`
+    /// reference test (`recompute_dirty_writes_circ_error_for_cycle_members`).
+    #[test]
+    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
+        let mut wb = make_runtime_workbook();
+        let reg = default_registry();
+        wb.put_formula(0, 0, 0, "B1 + 1");
+        wb.put_formula(0, 0, 1, "A1 - 1");
+        let (attempted, succeeded, failed_count) = {
+            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+            let r = rt.recompute_all();
+            (r.attempted, r.succeeded, r.failures.len())
+        };
+        assert_eq!(attempted, 2);
+        assert_eq!(succeeded, 0);
+        assert_eq!(failed_count, 0);
+        assert_eq!(
+            wb.read(ql_types::Address::new(0, 0, 0)),
+            Value::Error(ErrorValue::Circ),
+            "A1 in 2-cycle must be #CIRC!"
+        );
+        assert_eq!(
+            wb.read(ql_types::Address::new(0, 0, 1)),
+            Value::Error(ErrorValue::Circ),
+            "B1 in 2-cycle must be #CIRC!"
+        );
+    }
+
+    /// Acyclic mix with a cycle: A1 = 5, B1 = A1 * 2, C1 = C1 + 1
+    /// (self-referential). A1 and B1 evaluate normally; C1 emits
+    /// `#CIRC!`. Verifies cycle detection doesn't pollute the
+    /// acyclic remainder.
+    #[test]
+    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
+        let mut wb = make_runtime_workbook();
+        let reg = default_registry();
+        wb.put_at(0, 0, 0, Value::Number(5.0));
+        wb.put_formula(0, 0, 1, "A1 * 2");
+        wb.put_formula(0, 0, 2, "C1 + 1");
+        let (attempted, succeeded, failed_count) = {
+            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+            let r = rt.recompute_all();
+            (r.attempted, r.succeeded, r.failures.len())
+        };
+        assert_eq!(attempted, 2, "B1 + C1 are the formulas");
+        assert_eq!(succeeded, 1, "B1 evaluates; C1 is cycled");
+        assert_eq!(failed_count, 0);
+        assert_eq!(
+            wb.read(ql_types::Address::new(0, 0, 1)),
+            Value::Number(10.0)
+        );
+        assert_eq!(
+            wb.read(ql_types::Address::new(0, 0, 2)),
+            Value::Error(ErrorValue::Circ)
+        );
+    }
+
+    /// Cycle value must be stable across repeated `recompute_all`
+    /// calls — no drift between iterations. Before this fix, A1 in
+    /// `A1 = A1 + 1` returned 1, 2, 3, … instead of #CIRC! each time.
+    #[test]
+    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
+        let mut wb = make_runtime_workbook();
+        let reg = default_registry();
+        wb.put_formula(0, 0, 0, "A1 + 1");
+        {
+            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
+            for _ in 0..5 {
+                rt.recompute_all();
+            }
+        }
+        assert_eq!(
+            wb.read(ql_types::Address::new(0, 0, 0)),
+            Value::Error(ErrorValue::Circ),
+            "cycle value must remain #CIRC! across repeated recompute_all calls (no drift)"
+        );
+    }
+
     // ===== Phase 2B.2 — RecomputeResult contract =====
 
     /// R2B-01: a structural failure surfaces with the exact cell address +
     /// formula text + underlying RuntimeError. No information is lost going
     /// from "failed cell" to "RecomputeFailure entry".
     #[test]
     fn recompute_all_failure_carries_exact_cell_and_formula_text() {
         let mut wb = make_runtime_workbook();
         // Seed an unparseable formula by hand-writing it into the workbook
         // (bypassing the runtime's set_formula which would reject it
         // up-front). This simulates the on-disk-corruption scenario the
         // loader handles.
         wb.put_formula(0, 3, 5, "(((");
 
         let reg = default_registry();
         let mut rt = WorkbookRuntime::new(&mut wb, &reg);
         let result = rt.recompute_all();
         assert!(!result.is_complete());
         assert_eq!(result.failed_count(), 1);
         let failure = &result.failures[0];
         assert_eq!(failure.sheet, 0);
         assert_eq!(failure.row, 3);
         assert_eq!(failure.col, 5);
         assert_eq!(failure.formula_text.as_ref(), "(((");
         // Underlying error is a parse error (unclosed paren).
         assert!(
             matches!(failure.error, RuntimeError::Parse(_)),
             "expected Parse error, got {:?}",
             failure.error
         );
     }
 
     /// R2B-02: a failure does not short-circuit. Cells whose formulas DO
     /// parse cleanly get re-evaluated and counted as succeeded, regardless
     /// of iteration order.
     #[test]
     fn recompute_all_does_not_short_circuit_on_first_failure() {
         let mut wb = make_runtime_workbook();
         // 3 good formulas + 2 bad ones. We don't know iteration order, but
         // we know exactly 3 should succeed and exactly 2 should fail.
         wb.put_at(0, 0, 0, Value::Number(10.0));
         wb.put_formula(0, 1, 0, "A1 + 1"); // good
         wb.put_formula(0, 2, 0, "A1 * 2"); // good
         wb.put_formula(0, 3, 0, "A1 - 5"); // good
         wb.put_formula(0, 4, 0, "((("); // parse error
         wb.put_formula(0, 5, 0, "@bogus"); // lex error
 
         let reg = default_registry();
         let mut rt = WorkbookRuntime::new(&mut wb, &reg);
         let result = rt.recompute_all();
         assert_eq!(result.attempted, 5);
         assert_eq!(result.succeeded, 3);
         assert_eq!(result.failed_count(), 2);
         assert!(!result.is_complete());
 
         // Good cells were updated regardless of order.
         assert_eq!(
             wb.read(ql_types::Address::new(0, 1, 0)),
             Value::Number(11.0)
         );
         assert_eq!(
             wb.read(ql_types::Address::new(0, 2, 0)),
             Value::Number(20.0)
         );
         assert_eq!(wb.read(ql_types::Address::new(0, 3, 0)), Value::Number(5.0));
     }
 
     /// R2B-03: invalid persisted formulas do NOT panic the runtime. Every
     /// kind of structural failure (lex / parse / bind) surfaces as a
     /// `RecomputeFailure` entry; the runtime stays alive.
     #[test]
     fn recompute_all_does_not_panic_on_invalid_persisted_formulas() {
         let mut wb = make_runtime_workbook();
         wb.put_formula(0, 0, 0, "@@@"); // lex error
         wb.put_formula(0, 0, 1, "1 +"); // parse error (trailing operator)
         wb.put_formula(0, 0, 2, "UnknownName + 1"); // bind error (UnresolvedName)
 
         let reg = default_registry();
         let mut rt = WorkbookRuntime::new(&mut wb, &reg);
         // Just calling this must not panic — the assertion is the absence

codex
The patch does exactly what the prompt describes in `recompute_all`: ephemeral rebuild, dirty every formula node, `schedule_dirty`, then `HashSet::contains` in the legacy eval loop. The next question is whether the graph builder’s dependency coverage matches the edge cases the review prompt calls out.
exec
/bin/zsh -lc "awk 'NR>=280 && NR<=440 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
280:            _ => unreachable!(
281:                "FormatTableError gained a variant — extend FormatRejectedSource::From"
282:            ),
283:        }
284:    }
285:}
286:
287:/// Replay every op in `log` against `workbook` in append order.
288:///
289:/// Returns the total count of ops applied on success. On failure, the
290:/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
291:/// the caller how far replay got.
292:///
293:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
294:/// and is unused in 2A.3.a (replay persists formula text without
295:/// re-evaluating; callers drive evaluation through `recompute_all`).
296:pub fn replay_into(
297:    log: &OpLog,
298:    workbook: &mut Workbook,
299:    _registry: &FunctionRegistry,
300:) -> Result<usize, ReplayError> {
301:    let mut count = 0;
302:    for (index, op_result) in log.iter().enumerate() {
303:        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
304:        apply_op(&op, workbook, index)?;
305:        count += 1;
306:    }
307:    Ok(count)
308:}
309:
310:/// Recursive helper. `index` is the op's position in the outer log (or
311:/// the synthetic position of the enclosing BatchCommit for nested ops —
312:/// 2A.3.a flattens by reporting the parent's index for nested failures).
313:fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
314:    match op {
315:        Op::PutValue {
316:            sheet,
317:            row,
318:            col,
319:            value,
320:        } => {
321:            validate_cell(workbook, *sheet, *row, *col, index)?;
322:            let v: Value = value
323:                .to_value()
324:                .map_err(|source| ReplayError::ValueDecode { index, source })?;
325:            workbook.put_at(*sheet, *row, *col, v);
326:            Ok(())
327:        }
328:        Op::PutFormula {
329:            sheet,
330:            row,
331:            col,
332:            text,
333:        } => {
334:            validate_cell(workbook, *sheet, *row, *col, index)?;
335:            workbook.put_formula(*sheet, *row, *col, text.as_str());
336:            Ok(())
337:        }
338:        Op::ClearFormula { sheet, row, col } => {
339:            // clear_formula is idempotent on missing entries; we still
340:            // validate bounds so a corrupted op-log can't sneak past.
341:            validate_cell(workbook, *sheet, *row, *col, index)?;
342:            workbook.clear_formula(*sheet, *row, *col);
343:            Ok(())
344:        }
345:        Op::SetName {
346:            scope,
347:            name,
348:            target,
349:        } => {
350:            let target = target
351:                .to_target(name)
352:                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
353:            match scope {
354:                None => {
355:                    // Workbook-scoped (historical path).
356:                    workbook.set_name(name, target).map_err(|source| {
357:                        ReplayError::NameRejected {
358:                            index,
359:                            name: name.clone(),
360:                            source,
361:                        }
362:                    })?;
363:                }
364:                Some(sheet) => {
365:                    // **W5-92 (Phase 4.6.D):** sheet-scoped. Validate sheet
366:                    // first so an unknown id surfaces as InvalidSheet, not
367:                    // a panicking out-of-bounds index.
368:                    let sheet_count = workbook.sheet_count();
369:                    let sheet_ref =
370:                        workbook
371:                            .sheet_mut(*sheet)
372:                            .ok_or(ReplayError::InvalidSheet {
373:                                index,
374:                                sheet: *sheet,
375:                                sheet_count,
376:                            })?;
377:                    sheet_ref.set_scoped_name(name, target).map_err(|source| {
378:                        ReplayError::NameRejected {
379:                            index,
380:                            name: name.clone(),
381:                            source,
382:                        }
383:                    })?;
384:                }
385:            }
386:            Ok(())
387:        }
388:        Op::AddSheet { name, chunk_rows } => {
389:            // **W5-93 (Phase 4.6.E closure):** route through the fallible
390:            // `try_add_sheet_with_chunk_rows` and surface a clean
391:            // `ReplayError::SheetNameRejected` on validation failure.
392:            // Codex HIGH-1 flagged that the prior infallible path
393:            // silently accepted duplicate-canonical names + reserved
394:            // characters at the replay boundary too.
395:            workbook
396:                .try_add_sheet_with_chunk_rows(name.clone(), *chunk_rows)
397:                .map_err(|source| ReplayError::SheetNameRejected {
398:                    index,
399:                    name: name.clone(),
400:                    source,
401:                })?;
402:            Ok(())
403:        }
404:        Op::RenameSheet {
405:            id,
406:            old_name,
407:            new_name,
408:        } => {
409:            // **W5-91 (Phase 4.6.C):** snapshot-vs-replay reconciliation
410:            // per design § 3.3. Three cases:
411:            //   1. Current sheet name == old_name → fresh rename; apply.
412:            //   2. Current sheet name == new_name → already-renamed (likely
413:            //      replay-on-top-of-snapshot where the snapshot captured
414:            //      the post-rename state). No-op; success.
415:            //   3. Current sheet name == neither → divergent state; treat as
416:            //      InvalidSheet for the op-log's safety contract.
417:            let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
418:                ReplayError::InvalidSheet {
419:                    index,
420:                    sheet: *id,
421:                    sheet_count: workbook.sheet_count(),
422:                },
423:            )?;
424:            let canonical = |s: &str| ql_storage::Workbook::canonical_sheet_name(s);
425:            let cur_c = canonical(&current);
426:            let old_c = canonical(old_name);
427:            let new_c = canonical(new_name);
428:            if cur_c == new_c {
429:                // Already renamed (snapshot-authoritative path). No-op.
430:                Ok(())
431:            } else if cur_c == old_c {
432:                workbook
433:                    .rename_sheet(*id, new_name.clone())
434:                    .map_err(|source| ReplayError::SheetRenameRejected {
435:                        index,
436:                        id: *id,
437:                        old_name: old_name.clone(),
438:                        new_name: new_name.clone(),
439:                        source,
440:                    })?;

exec
/bin/zsh -lc "rg -n \"replay_into\\(|load_workbook_with_oplog|save_workbook_with_oplog|recompute_all\\(\\)\" crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-oplog/src/replay.rs:3://! Phase 2A.3.a (2026-05-12): single entry point `replay_into(&OpLog, &mut
crates/ql-oplog/src/replay.rs:296:pub fn replay_into(
crates/ql-oplog/src/replay.rs:1064:        let n = replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1081:        let n = replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1099:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1132:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1150:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1168:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1196:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1222:        let result = replay_into(&log, &mut wb, &reg);
crates/ql-oplog/src/replay.rs:1252:        let result = replay_into(&log, &mut wb, &reg);
crates/ql-oplog/src/replay.rs:1280:        let result = replay_into(&log, &mut wb, &reg);
crates/ql-oplog/src/replay.rs:1307:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1327:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1347:        match replay_into(&log, &mut wb, &reg) {
crates/ql-oplog/src/replay.rs:1377:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1410:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1428:        match replay_into(&log, &mut wb, &reg) {
crates/ql-oplog/src/replay.rs:1450:        match replay_into(&log, &mut wb, &reg) {
crates/ql-oplog/src/replay.rs:1472:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1499:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1518:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1536:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1552:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1580:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1625:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1654:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1680:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1703:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1725:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1752:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1772:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1789:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1802:        replay_into(&log, &mut wb, &reg).unwrap();
crates/ql-oplog/src/replay.rs:1819:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/replay.rs:1842:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
crates/ql-oplog/src/lib.rs:23://! via [`persistence::save_workbook_with_oplog`] /
crates/ql-oplog/src/lib.rs:24://! [`persistence::load_workbook_with_oplog`].
crates/ql-oplog/src/lib.rs:48:    load_workbook_with_oplog, save_workbook_with_oplog, PersistenceError, OPLOG_FILENAME,
crates/ql-oplog/src/persistence.rs:4://! sidecar is written by `save_workbook_with_oplog` using the closure-based
crates/ql-oplog/src/persistence.rs:18://! - `save_workbook_with_oplog` writes BOTH the workbook AND `oplog.bin`.
crates/ql-oplog/src/persistence.rs:20://! - `load_workbook_with_oplog` reads BOTH. If `oplog.bin` is missing,
crates/ql-oplog/src/persistence.rs:25://!   MUST use `save_workbook_with_oplog`. Loud: pinned by the test
crates/ql-oplog/src/persistence.rs:64:pub fn save_workbook_with_oplog(
crates/ql-oplog/src/persistence.rs:94:pub fn load_workbook_with_oplog(path: &Path) -> Result<(Workbook, OpLog), PersistenceError> {
crates/ql-oplog/src/persistence.rs:155:        save_workbook_with_oplog(&wb, &oplog, "rt", &path).unwrap();
crates/ql-oplog/src/persistence.rs:157:        let (loaded_wb, loaded_log) = load_workbook_with_oplog(&path).unwrap();
crates/ql-oplog/src/persistence.rs:173:        let result = load_workbook_with_oplog(&path);
crates/ql-oplog/src/persistence.rs:189:        save_workbook_with_oplog(&wb, &oplog, "test", &path).unwrap();
crates/ql-oplog/src/persistence.rs:201:        // an oplog.bin will NOT preserve it. The next load_workbook_with_oplog
crates/ql-oplog/src/persistence.rs:207:        save_workbook_with_oplog(&wb, &oplog, "v1", &path).unwrap();
crates/ql-oplog/src/persistence.rs:232:        save_workbook_with_oplog(&wb, &oplog_a, "v1", &path).unwrap();
crates/ql-oplog/src/persistence.rs:244:        save_workbook_with_oplog(&wb, &oplog_b, "v2", &path).unwrap();
crates/ql-oplog/src/persistence.rs:246:        let (_, loaded_log) = load_workbook_with_oplog(&path).unwrap();
crates/ql-oplog/src/persistence.rs:269:        save_workbook_with_oplog(&wb, &oplog, "empty", &path).unwrap();
crates/ql-oplog/src/persistence.rs:271:        let (_, loaded_log) = load_workbook_with_oplog(&path).unwrap();
crates/ql-oplog/src/persistence.rs:283:        save_workbook_with_oplog(&wb, &oplog, "corrupt", &path).unwrap();
crates/ql-oplog/src/persistence.rs:288:        let result = load_workbook_with_oplog(&path);
crates/ql-oplog/tests/producer_replay_equivalence.rs:394:    let count = replay_into(&log, &mut replay_wb, &reg).unwrap();
crates/ql-oplog/tests/producer_replay_equivalence.rs:438:    replay_into(&log, &mut wb_in_memory, &reg).unwrap();
crates/ql-oplog/tests/producer_replay_equivalence.rs:445:    replay_into(&restored, &mut wb_via_disk, &reg).unwrap();
crates/ql-oplog/tests/producer_replay_equivalence.rs:487:    replay_into(&log_flat, &mut wb_flat, &reg).unwrap();
crates/ql-oplog/tests/producer_replay_equivalence.rs:495:    replay_into(&log_batched, &mut wb_batched, &reg).unwrap();
crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:156:                    replay_into(&log, &mut wb, &registry)
crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:191:        replay_into(&log, &mut wb, &registry)
crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:219:    let r = replay_into(&log, &mut wb, &registry);
crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:240:    let r = replay_into(&log, &mut wb, &registry);
crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:263:    let r = replay_into(&log, &mut wb, &registry);
crates/ql-exec/src/loader.rs:10://! 3. `let _ = rt.recompute_all();`
crates/ql-exec/src/loader.rs:63:        runtime.recompute_all()
crates/ql-exec/src/workbook_runtime.rs:16://! - `recompute_all()` — legacy HashMap-order full pass; no graph awareness.
crates/ql-exec/src/workbook_runtime.rs:4016:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4041:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4068:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4132:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4314:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4589:            let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4626:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4628:            let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4653:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4684:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4711:                rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4737:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4770:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4802:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4821:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4842:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4870:        let r1 = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4879:        let r2 = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4903:            let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4918:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4935:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4959:            let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:4980:        let _ = rt.recompute_all(); // 1 miss
crates/ql-exec/src/workbook_runtime.rs:4981:        let _ = rt.recompute_all(); // 1 hit
crates/ql-exec/src/workbook_runtime.rs:5009:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:5710:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:5948:        replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/src/workbook_runtime.rs:5952:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:6879:        let r3 = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7018:        let r_all = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7746:        ql_oplog::replay_into(&log, &mut replay_wb, &reg).unwrap();
crates/ql-exec/src/workbook_runtime.rs:7772:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7787:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7802:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7821:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7844:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7881:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7907:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:7984:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:8161:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9188:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9216:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9236:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9257:        rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9258:        rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:9502:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:10826:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:10995:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:11081:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:11332:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:11442:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime.rs:11977:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/src/workbook_runtime.rs:12143:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/src/workbook_runtime.rs:12154:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime.rs:12180:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/src/workbook_runtime.rs:12210:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:121:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:127:            rt.recompute_all().is_complete(),
crates/ql-exec/tests/oplog_e2e.rs:160:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:164:            rt.recompute_all().is_complete(),
crates/ql-exec/tests/oplog_e2e.rs:198:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:202:            rt.recompute_all().is_complete(),
crates/ql-exec/tests/oplog_e2e.rs:230:    replay_into(&restored, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:234:            rt.recompute_all().is_complete(),
crates/ql-exec/tests/oplog_e2e.rs:280:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:284:            rt.recompute_all().is_complete(),
crates/ql-exec/tests/oplog_e2e.rs:300:/// → save_workbook_with_oplog → load_workbook_with_oplog → replay → recompute
crates/ql-exec/tests/oplog_e2e.rs:304:    use ql_oplog::{load_workbook_with_oplog, save_workbook_with_oplog};
crates/ql-exec/tests/oplog_e2e.rs:324:    save_workbook_with_oplog(&producer_wb, &producer_oplog, "e2e", &path).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:327:    let (_loaded_wb, loaded_oplog) = load_workbook_with_oplog(&path).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:336:    replay_into(&loaded_oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:340:            rt.recompute_all().is_complete(),
crates/ql-exec/tests/oplog_e2e.rs:350:    let (loaded_wb_alone, _) = load_workbook_with_oplog(&path).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:381:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:415:        let _ = rt.recompute_all();
crates/ql-exec/tests/oplog_e2e.rs:510:    replay_into(&oplog, &mut wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:516:            rt.recompute_all().is_complete(),
crates/ql-exec/tests/oplog_e2e.rs:558:    replay_into(&oplog, &mut wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:561:        assert!(rt.recompute_all().is_complete());
crates/ql-exec/tests/oplog_e2e.rs:600:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:609:        assert!(rt.recompute_all().is_complete(), "recompute failures");
crates/ql-exec/tests/oplog_e2e.rs:635:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:669:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:692:        assert!(rt.recompute_all().is_complete());
crates/ql-exec/tests/oplog_e2e.rs:730:        assert!(rt.recompute_all().is_complete());
crates/ql-exec/tests/oplog_e2e.rs:739:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:752:        assert!(rt.recompute_all().is_complete());
crates/ql-exec/tests/oplog_e2e.rs:840:    let err = replay_into(&oplog, &mut wb, &reg).unwrap_err();
crates/ql-exec/tests/oplog_e2e.rs:882:    let err = replay_into(&oplog, &mut wb, &reg).unwrap_err();
crates/ql-exec/tests/oplog_e2e.rs:933:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
crates/ql-exec/tests/oplog_e2e.rs:981:        assert!(rt.recompute_all().is_complete());
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:209:        rt.recompute_all();
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:230:        rt.recompute_all();
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:246:        rt.recompute_all();
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:287:        rt.recompute_all();
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:290:        rt.recompute_all();
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:369:        rt.recompute_all();
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:373:        rt.recompute_all();
crates/ql-io/src/qbook_format.rs:946:/// atomic `rename(temp → target)`. Used by `ql_oplog::save_workbook_with_oplog`
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:128:        let _ = rt.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:356:    replay_into(&oplog, &mut replayed, &reg).unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:359:        let _ = rt2.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:615:        let _ = rt.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:706:        let _ = rt.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:748:    let _ = rt.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:751:        let _ = rt.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:787:        let _ = rt.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:920:    let _ = rt.recompute_all();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1157:        let _ = rt.recompute_all();
crates/ql-exec/tests/ide_simulation.rs:19:use ql_oplog::{load_workbook_with_oplog, save_workbook_with_oplog, OpLog};
crates/ql-exec/tests/ide_simulation.rs:260:        save_workbook_with_oplog(&wb, &oplog, "ide-roundtrip", &path).unwrap();
crates/ql-exec/tests/ide_simulation.rs:266:    let (reloaded_wb, reloaded_oplog) = load_workbook_with_oplog(&path).unwrap();
crates/ql-exec/tests/ide_simulation.rs:332:        rt.recompute_all()
crates/ql-exec/tests/ide_simulation.rs:362:    let _r1 = rt.recompute_all();
crates/ql-exec/tests/ide_simulation.rs:364:    let _r2 = rt.recompute_all();
crates/ql-exec/tests/p412_function_arg_fuzz.rs:217:    let _ = rt.recompute_all();
crates/ql-exec/tests/p412_function_arg_fuzz.rs:230:    let _ = rt.recompute_all();
crates/ql-exec/tests/p412_function_arg_fuzz.rs:261:    let _ = rt.recompute_all();
crates/ql-exec/tests/p412_function_arg_fuzz.rs:291:    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| rt.recompute_all()));
crates/ql-exec/tests/p412_function_arg_fuzz.rs:320:    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| rt.recompute_all()));
crates/ql-exec/tests/p412_function_arg_fuzz.rs:413:    let _ = rt.recompute_all();
crates/ql-exec/tests/p412_function_arg_fuzz.rs:433:    let _ = rt.recompute_all();
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:676:    use ql_oplog::{load_workbook_with_oplog, save_workbook_with_oplog, OpLog};
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:727:    save_workbook_with_oplog(&wb2, &oplog2, "opus-a-ide", &qbook_dir).unwrap();
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:731:    let (mut wb3, _ol3) = load_workbook_with_oplog(&qbook_dir).unwrap();
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:734:        let _ = rt.recompute_all();
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:852:    use ql_oplog::{load_workbook_with_oplog, save_workbook_with_oplog, OpLog};
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:876:    save_workbook_with_oplog(&wb, &oplog, "opus-a-full-feature", &qbook).unwrap();
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:878:    let (mut wb2, _ol2) = load_workbook_with_oplog(&qbook).unwrap();
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:893:        let _ = rt.recompute_all();
crates/ql-io-xlsx/src/read/convert.rs:127:    let result = rt.recompute_all();

exec
/bin/zsh -lc "awk 'NR>=440 && NR<=760 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "awk 'NR>=1 && NR<=140 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-oplog/src/persistence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
440:                    })?;
441:                Ok(())
442:            } else {
443:                Err(ReplayError::SheetRenameNameMismatch {
444:                    index,
445:                    id: *id,
446:                    expected: old_name.clone(),
447:                    found: current,
448:                })
449:            }
450:        }
451:        Op::RegisterFormat { id, string } => {
452:            // **W5-80:** route through `FormatTable::register_at` so
453:            // collisions surface as `FormatRejected` (rather than the
454:            // panic-on-duplicate behavior `intern` would have via the
455:            // by_string fast path; `register_at` is the explicit-id form).
456:            let fid = ql_storage::FormatId(*id);
457:            workbook
458:                .formats_mut()
459:                .register_at(fid, string.as_str())
460:                .map_err(|e| ReplayError::FormatRejected {
461:                    index,
462:                    source: e.into(),
463:                })?;
464:            Ok(())
465:        }
466:        Op::SetCellFormat {
467:            sheet,
468:            row,
469:            col,
470:            id,
471:        } => {
472:            validate_cell(workbook, *sheet, *row, *col, index)?;
473:            // **W5-80:** require the id to be registered. Catches
474:            // producer bugs where `SetCellFormat` was emitted without
475:            // a preceding `RegisterFormat`. `None` means clear.
476:            if let Some(raw_id) = id {
477:                let fid = ql_storage::FormatId(*raw_id);
478:                if workbook.formats().lookup(fid).is_none() {
479:                    return Err(ReplayError::FormatNotRegistered { index, id: *raw_id });
480:                }
481:                workbook
482:                    .sheet_mut(*sheet)
483:                    .expect("sheet validated above")
484:                    .format_overlay_mut()
485:                    .set(*row, *col, fid);
486:            } else {
487:                workbook
488:                    .sheet_mut(*sheet)
489:                    .expect("sheet validated above")
490:                    .format_overlay_mut()
491:                    .clear(*row, *col);
492:            }
493:            Ok(())
494:        }
495:        Op::BatchCommit { ops } => {
496:            for inner_op in ops {
497:                // Phase 2A.3.a: nested ops flatten to the parent's index
498:                // for error reporting. Phase 5+ may extend with
499:                // (outer, inner) tuple indexing once the producer side
500:                // emits nested commits in practice.
501:                apply_op(inner_op, workbook, index)?;
502:            }
503:            Ok(())
504:        }
505:        Op::CreateTable {
506:            name,
507:            sheet,
508:            top_row,
509:            top_col,
510:            rows,
511:            cols,
512:            has_header,
513:            has_totals,
514:            column_names,
515:        } => apply_create_table(
516:            workbook,
517:            index,
518:            name,
519:            *sheet,
520:            *top_row,
521:            *top_col,
522:            *rows,
523:            *cols,
524:            *has_header,
525:            *has_totals,
526:            column_names,
527:        ),
528:        Op::DropTable { name } => {
529:            let canonical = name.to_ascii_uppercase();
530:            if workbook.tables_mut().remove(canonical.as_str()).is_none() {
531:                return Err(ReplayError::TableNotFound {
532:                    index,
533:                    name: name.clone(),
534:                });
535:            }
536:            Ok(())
537:        }
538:        Op::RenameTable { old_name, new_name } => {
539:            apply_rename_table(workbook, index, old_name, new_name)
540:        }
541:        Op::RenameColumn {
542:            table,
543:            old_name,
544:            new_name,
545:        } => apply_rename_column(workbook, index, table, old_name, new_name),
546:        Op::ResizeTable {
547:            name,
548:            new_rows,
549:            new_cols,
550:            added_columns,
551:            removed_columns,
552:        } => apply_resize_table(
553:            workbook,
554:            index,
555:            name,
556:            *new_rows,
557:            *new_cols,
558:            added_columns,
559:            removed_columns,
560:        ),
561:        // **W5-146 (Phase 4.9.J) + W5-151 (4.9.O MEDIUM-2 closure):**
562:        // workbook-scope reference-mode change. Forward-compat
563:        // unknown wire values surface `ReplayError::UnknownReferenceMode`
564:        // with the captured string (mirrors the `LocaleWire::Unknown`
565:        // path below).
566:        Op::SetReferenceMode { mode } => match mode.clone().to_runtime() {
567:            Ok(m) => {
568:                workbook.set_reference_mode(m);
569:                Ok(())
570:            }
571:            Err(found) => Err(ReplayError::UnknownReferenceMode { index, found }),
572:        },
573:        // **W5-146 (Phase 4.9.J):** workbook-scope locale change.
574:        // Unknown wire values (forward-compat op-log file) surface
575:        // `ReplayError::UnknownLocale` with the captured string.
576:        Op::SetLocale { locale } => match locale.clone().to_runtime() {
577:            Ok(loc) => {
578:                workbook.set_locale(loc);
579:                Ok(())
580:            }
581:            Err(found) => Err(ReplayError::UnknownLocale { index, found }),
582:        },
583:    }
584:}
585:
586:/// **W5-119 (Phase 4.8.I):** replay a `RenameTable`. Validates source
587:/// exists, target name is available (TableTable + NameTable shared
588:/// namespace), then re-keys the entry. Note: formula text rewrites
589:/// arrive as accompanying `Op::PutFormula` ops; this arm doesn't
590:/// touch formula cells.
591:fn apply_rename_table(
592:    workbook: &mut Workbook,
593:    index: usize,
594:    old_name: &str,
595:    new_name: &str,
596:) -> Result<(), ReplayError> {
597:    let old_canonical = old_name.to_ascii_uppercase();
598:    let new_canonical: std::sync::Arc<str> =
599:        std::sync::Arc::from(new_name.to_ascii_uppercase().as_str());
600:
601:    // Verify source.
602:    if workbook.tables().lookup(&old_canonical).is_none() {
603:        return Err(ReplayError::TableNotFound {
604:            index,
605:            name: old_name.to_owned(),
606:        });
607:    }
608:    // Verify target availability (skip the no-op same-name case).
609:    if !old_canonical.eq_ignore_ascii_case(new_name) {
610:        if workbook.tables().lookup(&new_canonical).is_some() {
611:            return Err(ReplayError::TableCreateRejected {
612:                index,
613:                name: new_name.to_owned(),
614:                reason: "table with this canonical name already exists (rename target)",
615:            });
616:        }
617:        if workbook.names().lookup_ci(&new_canonical).is_some() {
618:            return Err(ReplayError::TableCreateRejected {
619:                index,
620:                name: new_name.to_owned(),
621:                reason: "defined-name with this canonical name already exists (rename target)",
622:            });
623:        }
624:    }
625:    // Take the entry out, mutate name + display, reinsert under new key.
626:    let mut meta = workbook
627:        .tables_mut()
628:        .remove(&old_canonical)
629:        .expect("verified above");
630:    meta.name = std::sync::Arc::clone(&new_canonical);
631:    meta.display_name = std::sync::Arc::from(new_name);
632:    workbook.tables_mut().insert(new_canonical, meta);
633:    Ok(())
634:}
635:
636:/// **W5-121 (Phase 4.8.I.2):** replay a `RenameColumn`. Validates the
637:/// target table exists, the source column exists (case-insensitive), and
638:/// the target column name is available within the table. Mutates the
639:/// matching `TableColumn`'s `name` (lowercase canonical) and `display`
640:/// (case-preserving). Bumps the `TableTable` generation so plan caches
641:/// invalidate. Same-canonical column renames are rejected — the producer
642:/// side treats those as a no-op and doesn't emit the op, so receiving
643:/// one indicates log divergence.
644:fn apply_rename_column(
645:    workbook: &mut ql_storage::Workbook,
646:    index: usize,
647:    table: &str,
648:    old_name: &str,
649:    new_name: &str,
650:) -> Result<(), ReplayError> {
651:    let table_canonical = table.to_ascii_uppercase();
652:    let meta = workbook
653:        .tables_mut()
654:        .get_mut(&table_canonical)
655:        .ok_or_else(|| ReplayError::TableNotFound {
656:            index,
657:            name: table.to_owned(),
658:        })?;
659:    let (col_idx, _) =
660:        meta.lookup_column(old_name)
661:            .ok_or_else(|| ReplayError::TableColumnNotFound {
662:                index,
663:                table: table.to_owned(),
664:                column: old_name.to_owned(),
665:            })?;
666:    if new_name.is_empty() {
667:        return Err(ReplayError::TableColumnRejected {
668:            index,
669:            table: table.to_owned(),
670:            column: new_name.to_owned(),
671:            reason: "column name cannot be empty",
672:        });
673:    }
674:    let old_lower = old_name.to_ascii_lowercase();
675:    let new_lower = new_name.to_ascii_lowercase();
676:    if old_lower == new_lower {
677:        return Err(ReplayError::TableColumnRejected {
678:            index,
679:            table: table.to_owned(),
680:            column: new_name.to_owned(),
681:            reason: "rename to same canonical column name (producer should not emit)",
682:        });
683:    }
684:    if meta.lookup_column(new_name).is_some() {
685:        return Err(ReplayError::TableColumnRejected {
686:            index,
687:            table: table.to_owned(),
688:            column: new_name.to_owned(),
689:            reason: "column with this canonical name already exists (rename target)",
690:        });
691:    }
692:    meta.columns[col_idx as usize].name = std::sync::Arc::from(new_lower.as_str());
693:    meta.columns[col_idx as usize].display = std::sync::Arc::from(new_name);
694:    workbook.tables_mut().bump_generation();
695:    Ok(())
696:}
697:
698:/// **W5-122 (Phase 4.8.J):** replay a `ResizeTable`. Validates the
699:/// target table exists, the arithmetic invariant
700:/// (`new_cols == old_cols + added.len() - removed.len()`),
701:/// `removed_columns` exactly match the current trailing columns
702:/// (case-insensitive on display), the final column roster has unique
703:/// canonical names, and the new footprint cells outside the old
704:/// footprint don't overlap other tables. Mutates the table metadata
705:/// in place (rows/cols + columns vec). Bumps `TableTable` generation.
706:fn apply_resize_table(
707:    workbook: &mut ql_storage::Workbook,
708:    index: usize,
709:    name: &str,
710:    new_rows: u32,
711:    new_cols: u32,
712:    added_columns: &[String],
713:    removed_columns: &[String],
714:) -> Result<(), ReplayError> {
715:    use ql_storage::TableColumn;
716:    let canonical = name.to_ascii_uppercase();
717:    // Snapshot the immutable bits we need to validate before mutating.
718:    let (sheet, top_row, top_col, old_rows, old_cols, old_displays) = {
719:        let meta =
720:            workbook
721:                .tables()
722:                .lookup(&canonical)
723:                .ok_or_else(|| ReplayError::TableNotFound {
724:                    index,
725:                    name: name.to_owned(),
726:                })?;
727:        (
728:            meta.sheet,
729:            meta.top_row,
730:            meta.top_col,
731:            meta.rows,
732:            meta.cols,
733:            meta.columns
734:                .iter()
735:                .map(|c| c.display.as_ref().to_owned())
736:                .collect::<Vec<_>>(),
737:        )
738:    };
739:    if new_rows == 0 || new_cols == 0 {
740:        return Err(ReplayError::TableResizeRejected {
741:            index,
742:            name: name.to_owned(),
743:            reason: "table rows and cols must both be > 0",
744:        });
745:    }
746:    // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
747:    // upper bound mirrors producer side.
748:    if let Err(reason) =
749:        ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, new_rows, new_cols)
750:    {
751:        return Err(ReplayError::TableResizeRejected {
752:            index,
753:            name: name.to_owned(),
754:            reason,
755:        });
756:    }
757:    let added_len = added_columns.len() as u32;
758:    let removed_len = removed_columns.len() as u32;
759:    if removed_len > old_cols {
760:        return Err(ReplayError::TableResizeRejected {

 succeeded in 0ms:
1://! Phase 2A.3.c (2026-05-12) — `.qbook/` ↔ op-log persistence.
2://!
3://! Adds `oplog.bin` as a sidecar file inside the `.qbook/` directory. The
4://! sidecar is written by `save_workbook_with_oplog` using the closure-based
5://! extension hook `ql_io::save_workbook_extending`, so it rides the same
6://! atomic-rename protocol as the envelope + sheet JSONLs. Crash recovery
7://! works transparently — `oplog.bin` lives inside the backup directory
8://! alongside the rest and recovers via `recover_from_crashed_save`.
9://!
10://! ## Sidecar filename
11://!
12://! `oplog.bin` — binary `Loro::ExportMode::Snapshot` blob (per
13://! [`OpLog::export_bytes`]). Versioning is handled inside the Loro snapshot
14://! format; this layer is content-agnostic.
15://!
16://! ## Documented behavior
17://!
18://! - `save_workbook_with_oplog` writes BOTH the workbook AND `oplog.bin`.
19://!   Any previously-present `oplog.bin` in the target is overwritten.
20://! - `load_workbook_with_oplog` reads BOTH. If `oplog.bin` is missing,
21://!   returns [`PersistenceError::Qbook(QbookError::MissingFile {..})`] —
22://!   no silent fallback to an empty op log per the no-fallbacks rule.
23://! - The plain `ql_io::save_workbook` (no oplog parameter) DROPS any
24://!   existing `oplog.bin` in the target. Callers that want to keep history
25://!   MUST use `save_workbook_with_oplog`. Loud: pinned by the test
26://!   `save_workbook_drops_existing_oplog_bin`.
27://! - The plain `ql_io::load_workbook` ignores any `oplog.bin` that's
28://!   present (returns the workbook only). Forward-compatible: a v2 reader
29://!   without op-log support can still read a workbook saved with an op log.
30:
31:use std::fs;
32:use std::path::Path;
33:
34:use ql_io::{load_workbook, save_workbook_extending, QbookError};
35:use ql_storage::Workbook;
36:use thiserror::Error;
37:
38:use crate::log::OpLog;
39:use crate::OpLogError;
40:
41:/// Filename used for the op-log sidecar inside a `.qbook/` directory.
42:pub const OPLOG_FILENAME: &str = "oplog.bin";
43:
44:/// Combined error type for the persistence functions in this module. Wraps
45:/// both [`QbookError`] (from the underlying workbook persistence) and
46:/// [`OpLogError`] (from Loro snapshot encode/decode).
47:#[derive(Debug, Error)]
48:#[non_exhaustive]
49:pub enum PersistenceError {
50:    /// Workbook persistence layer error (I/O, schema, malformed cell, etc.).
51:    #[error("workbook persistence error: {0}")]
52:    Qbook(#[from] QbookError),
53:
54:    /// Op-log encode/decode error (Loro internal, serde_json, etc.).
55:    #[error("op log error: {0}")]
56:    OpLog(#[from] OpLogError),
57:}
58:
59:/// Save a workbook AND its op log to `path` atomically. Both files land
60:/// together via the `.qbook/` atomic-rename protocol — there's no window in
61:/// which the workbook is updated but the op log isn't (or vice versa).
62:///
63:/// Overwrites any prior `oplog.bin` in the target.
64:pub fn save_workbook_with_oplog(
65:    wb: &Workbook,
66:    oplog: &OpLog,
67:    name: &str,
68:    path: &Path,
69:) -> Result<(), PersistenceError> {
70:    // Export the Loro snapshot bytes FIRST. Failing here (e.g., a
71:    // serde_json NaN/Inf rejection nested inside an Op::PutValue) surfaces
72:    // before we touch the filesystem.
73:    let bytes = oplog.export_bytes()?;
74:
75:    // Hand off to ql-io. The closure writes `oplog.bin` into the temp
76:    // directory; the atomic rename then moves it into place with the rest
77:    // of the workbook.
78:    save_workbook_extending(wb, name, path, |temp_dir| {
79:        fs::write(temp_dir.join(OPLOG_FILENAME), &bytes).map_err(QbookError::Io)
80:    })?;
81:    Ok(())
82:}
83:
84:/// Load a workbook AND its op log from `path`. Both files must be present.
85:///
86:/// Errors:
87:/// - [`PersistenceError::Qbook`] if the workbook itself fails to load
88:///   (missing envelope, schema mismatch, malformed cell, etc.).
89:/// - [`PersistenceError::Qbook(QbookError::MissingFile)`] specifically when
90:///   `oplog.bin` is missing — the caller asked for the op log; surfacing
91:///   the absence loudly is the no-fallbacks-rule answer.
92:/// - [`PersistenceError::OpLog`] if `oplog.bin` is present but Loro can't
93:///   decode it (corruption, version mismatch in the Loro snapshot format).
94:pub fn load_workbook_with_oplog(path: &Path) -> Result<(Workbook, OpLog), PersistenceError> {
95:    let wb = load_workbook(path)?;
96:    let oplog_path = path.join(OPLOG_FILENAME);
97:    if !oplog_path.is_file() {
98:        return Err(PersistenceError::Qbook(QbookError::MissingFile {
99:            file: oplog_path,
100:        }));
101:    }
102:    let bytes = fs::read(&oplog_path).map_err(QbookError::Io)?;
103:    let oplog = OpLog::import_bytes(&bytes)?;
104:    Ok((wb, oplog))
105:}
106:
107:#[cfg(test)]
108:mod tests {
109:    use super::*;
110:    use ql_io::CellWireValue;
111:    use ql_types::{Address, Value};
112:    use tempfile::TempDir;
113:
114:    use crate::Op;
115:
116:    fn fresh_workbook_with_cell() -> Workbook {
117:        let mut wb = Workbook::new();
118:        wb.add_sheet("S");
119:        wb.put_at(0, 0, 0, Value::Number(42.0));
120:        wb
121:    }
122:
123:    fn oplog_with_three_ops() -> OpLog {
124:        let mut log = OpLog::new();
125:        log.append(Op::PutValue {
126:            sheet: 0,
127:            row: 0,
128:            col: 0,
129:            value: CellWireValue::Number(42.0),
130:        })
131:        .unwrap();
132:        log.append(Op::PutValue {
133:            sheet: 0,
134:            row: 0,
135:            col: 1,
136:            value: CellWireValue::Number(43.0),
137:        })
138:        .unwrap();
139:        log.append(Op::PutFormula {
140:            sheet: 0,

exec
/bin/zsh -lc "rg -n \"struct FormulaDeps|formula_deps|extract_and_register_deps|reextract_deps|named_ranges|range_deps|cells|producer|spill|alias|NamedTarget|NameTarget|Target\" crates/ql-exec/src/calcgraph_session.rs crates/ql-exec/src/plan.rs crates/ql-storage/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/plan.rs:31://! - `Spill(Box<Expr>)` — reserved for Excel's `A1#` spill-range-ref
crates/ql-exec/src/plan.rs:71:    /// Phase 2B.4 (2026-05-12): a `NameRef` resolving to a `NamedTarget::Range`
crates/ql-exec/src/plan.rs:91:    /// Row-major; outer `Vec` is rows, inner `Vec` is cells. Element-arity
crates/ql-exec/src/plan.rs:107:    /// boundary spill path (cell context) or `#CALC!` (scalar context),
crates/ql-exec/src/plan.rs:115:    /// literals inside `Expr::Array` cells.
crates/ql-exec/src/plan.rs:165:/// `NamedTargetIs{Blank,Error}`; Phase 2A.11 audit M16 switched to
crates/ql-exec/src/plan.rs:175:    /// - `NamedTarget::Range` in scalar position (lands on the more
crates/ql-exec/src/plan.rs:181:    /// shapes as `ArrayRowArityMismatch`, non-literal cells as
crates/ql-exec/src/plan.rs:191:    /// A `NameRef` resolved to a `NamedTarget::Constant(Value::Blank)`. Phase 2A.6
crates/ql-exec/src/plan.rs:196:    NamedTargetIsBlank(Arc<str>),
crates/ql-exec/src/plan.rs:197:    /// A `NameRef` resolved to a `NamedTarget::Constant(Value::Error(_))`. Phase 2A.6
crates/ql-exec/src/plan.rs:209:    NamedTargetIsError(Arc<str>, ErrorValue),
crates/ql-exec/src/plan.rs:210:    /// Phase 2B.4 (2026-05-12): a `NameRef` resolving to a `NamedTarget::Range`
crates/ql-exec/src/plan.rs:223:    /// `NamedTarget::Formula` in a scalar-context position. Named formulas
crates/ql-exec/src/plan.rs:263:    /// is degenerate — zero rows OR row 0 has zero cells. The parser
crates/ql-exec/src/plan.rs:268:    #[error("array literal is degenerate (zero rows or zero cells per row)")]
crates/ql-exec/src/plan.rs:357:/// per-name-ref decisions about whether a `NamedTarget::Range` is acceptable
crates/ql-exec/src/plan.rs:546:/// - `Expr::NameRef` resolving to a `NamedTarget::Range` →
crates/ql-exec/src/plan.rs:811:            // degenerate shapes — zero rows OR zero cells in row 0.
crates/ql-exec/src/plan.rs:914:                Some(ResolvedName::Blank) => Err(BindError::NamedTargetIsBlank(name.clone())),
crates/ql-exec/src/plan.rs:916:                    Err(BindError::NamedTargetIsError(name.clone(), e))
crates/ql-exec/src/plan.rs:1031:        // a known v1 gap (deferred to cell-boundary spill rewiring).
crates/ql-exec/src/plan.rs:1070:        //     resolve to single cells / multi-axis ranges. The
crates/ql-exec/src/plan.rs:1119:             eval-side spill-range expansion is deferred.",
crates/ql-exec/src/plan.rs:1305:/// Variant describing a resolved name's target, mapped from `ql_storage::NamedTarget`.
crates/ql-exec/src/plan.rs:1307:/// import ql-storage directly, so the lookup trait projects NamedTarget into this
crates/ql-exec/src/plan.rs:1320:    /// `NamedTarget::Range(_)` resolved with payload. Phase 2B.4 (2026-05-12):
crates/ql-exec/src/plan.rs:1325:    /// `NamedTarget::Formula(_)` resolved with payload. Phase 2B.4 added the
crates/ql-exec/src/plan.rs:1329:    /// `NamedTarget::Constant(Value::Blank)`. The binder rejects this loudly so
crates/ql-exec/src/plan.rs:1332:    /// `NamedTarget::Constant(Value::Error(...))`. The binder rejects with a
crates/ql-exec/src/plan.rs:1697:/// range `0..=MAX_ROW`, whole-row to `0..=MAX_COLUMN`. R1C1 cells inside `@`
crates/ql-exec/src/plan.rs:2282:        // — `Expr::Array(vec![vec![]])` (one row, zero cells) was
crates/ql-exec/src/calcgraph_session.rs:4://! dependency tracking (cells / ranges / volatile / names). It lives
crates/ql-exec/src/calcgraph_session.rs:28://!   The session updates per-formula `formula_deps`, the volatile
crates/ql-exec/src/calcgraph_session.rs:209:/// `cells`, `named_ranges`, and `names` are deduplicated by the
crates/ql-exec/src/calcgraph_session.rs:210:/// `extract_and_register_deps` orchestrator (the walker emits
crates/ql-exec/src/calcgraph_session.rs:213:pub struct FormulaDeps {
crates/ql-exec/src/calcgraph_session.rs:216:    pub cells: Vec<(SheetId, RowId, ColId)>,
crates/ql-exec/src/calcgraph_session.rs:220:    pub named_ranges: Vec<(Arc<str>, Range)>,
crates/ql-exec/src/calcgraph_session.rs:228:    /// mutation hooks. Populated alongside `named_ranges` (the
crates/ql-exec/src/calcgraph_session.rs:237:    /// Total dependency count (cells + named ranges). Useful for
crates/ql-exec/src/calcgraph_session.rs:241:        self.cells.len() + self.named_ranges.len()
crates/ql-exec/src/calcgraph_session.rs:245:        self.cells.is_empty() && self.named_ranges.is_empty()
crates/ql-exec/src/calcgraph_session.rs:260:            deps.cells.push((*sheet, *row, *col));
crates/ql-exec/src/calcgraph_session.rs:316:            deps.named_ranges.push((Arc::clone(name), *range));
crates/ql-exec/src/calcgraph_session.rs:338:        // `__rt_literal_range__` into `named_ranges` here, which leaked
crates/ql-exec/src/calcgraph_session.rs:339:        // a private marker through the public `FormulaDeps.named_ranges`
crates/ql-exec/src/calcgraph_session.rs:343:        // `deps.cells` directly (no synthetic marker), only when the
crates/ql-exec/src/calcgraph_session.rs:347:                deps.cells
crates/ql-exec/src/calcgraph_session.rs:352:        // have NO dependencies — they're pure constants. Array cells
crates/ql-exec/src/calcgraph_session.rs:354:        // so even walking the inner cells would yield zero deps.
crates/ql-exec/src/calcgraph_session.rs:373:            deps.named_ranges.push((Arc::clone(table_name), *resolved));
crates/ql-exec/src/calcgraph_session.rs:398:///   `named_ranges` (no cell-stripe registration; range values don't
crates/ql-exec/src/calcgraph_session.rs:458:    formula_deps: HashMap<NodeId, FormulaDeps>,
crates/ql-exec/src/calcgraph_session.rs:548:/// `CalcgraphSession` is usable; cells whose formulas failed simply
crates/ql-exec/src/calcgraph_session.rs:621:    pub fn formula_deps(&self, node: NodeId) -> Option<&FormulaDeps> {
crates/ql-exec/src/calcgraph_session.rs:622:        self.formula_deps.get(&node)
crates/ql-exec/src/calcgraph_session.rs:657:    /// `Graph::clear_range_deps_for_formula`. Prior comments here
crates/ql-exec/src/calcgraph_session.rs:670:    fn extract_and_register_deps(
crates/ql-exec/src/calcgraph_session.rs:680:        self.remove_formula_deps(formula_node);
crates/ql-exec/src/calcgraph_session.rs:687:        self.graph.clear_range_deps_for_formula(formula_node);
crates/ql-exec/src/calcgraph_session.rs:694:        // § 10.1: if a CellRef points to a spill TARGET, reroute the
crates/ql-exec/src/calcgraph_session.rs:701:        // spill-target writes uniformly with regular cell writes.
crates/ql-exec/src/calcgraph_session.rs:706:        // Hot-path note: this loop runs one `spill_target_anchor`
crates/ql-exec/src/calcgraph_session.rs:707:        // HashMap lookup PER cell-dep on EVERY `extract_and_register_deps`
crates/ql-exec/src/calcgraph_session.rs:708:        // call, even when the workbook has zero spills. A future
crates/ql-exec/src/calcgraph_session.rs:709:        // optimization could add a `Workbook::has_any_spills()` short-
crates/ql-exec/src/calcgraph_session.rs:714:        // this rewrite only fires for formulas bound AFTER the spill is
crates/ql-exec/src/calcgraph_session.rs:715:        // registered. If a reader B1=A2 was bound BEFORE A1 spilled to
crates/ql-exec/src/calcgraph_session.rs:719:        // Phase 4.7.J.4 (`reextract_spill_footprint_readers` in
crates/ql-exec/src/calcgraph_session.rs:721:        // `reextract_deps` for every reader indexed under any cell
crates/ql-exec/src/calcgraph_session.rs:722:        // in the OLD or NEW spill footprint after a spill registers
crates/ql-exec/src/calcgraph_session.rs:723:        // or dissolves. See `workbook_runtime.rs:reextract_spill_footprint_readers`.
crates/ql-exec/src/calcgraph_session.rs:724:        for cell in deps.cells.iter_mut() {
crates/ql-exec/src/calcgraph_session.rs:725:            if let Some(anchor) = workbook.spill_target_anchor(cell.0, cell.1, cell.2) {
crates/ql-exec/src/calcgraph_session.rs:732:        // each cell once). Also dedupe across producer-alias rewrites
crates/ql-exec/src/calcgraph_session.rs:734:        let mut seen_cells: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
crates/ql-exec/src/calcgraph_session.rs:735:        deps.cells.retain(|c| seen_cells.insert(*c));
crates/ql-exec/src/calcgraph_session.rs:738:        // named_ranges may contain the same name twice — that's
crates/ql-exec/src/calcgraph_session.rs:743:        // reverse index. We do NOT create CellNodes for dep cells (no
crates/ql-exec/src/calcgraph_session.rs:756:        // `extract_and_register_deps` entry (line 453) and from
crates/ql-exec/src/calcgraph_session.rs:760:        for &(s, r, c) in &deps.cells {
crates/ql-exec/src/calcgraph_session.rs:776:        // the stripe map AND the `formula_to_range_deps` precision-check
crates/ql-exec/src/calcgraph_session.rs:780:        for (_, range) in &deps.named_ranges {
crates/ql-exec/src/calcgraph_session.rs:807:            self.formula_deps.insert(formula_node, deps);
crates/ql-exec/src/calcgraph_session.rs:813:    /// deps) or cleared. Cleans `formula_deps`, the volatile set, the
crates/ql-exec/src/calcgraph_session.rs:817:    /// `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula`
crates/ql-exec/src/calcgraph_session.rs:818:    /// (W5-50). **Both callers** (`extract_and_register_deps` for
crates/ql-exec/src/calcgraph_session.rs:822:    fn remove_formula_deps(&mut self, formula_node: NodeId) {
crates/ql-exec/src/calcgraph_session.rs:823:        if let Some(prior) = self.formula_deps.remove(&formula_node) {
crates/ql-exec/src/calcgraph_session.rs:832:            for cell in &prior.cells {
crates/ql-exec/src/calcgraph_session.rs:865:    /// Workbook's underlying `formula_cells` is a `HashMap` (arbitrary
crates/ql-exec/src/calcgraph_session.rs:911:                    session.extract_and_register_deps(node, sheet, &plan, wb);
crates/ql-exec/src/calcgraph_session.rs:973:    /// exist for FORMULA cells only; dep lookups for plain literal
crates/ql-exec/src/calcgraph_session.rs:974:    /// cells go through the (sheet, row, col) tuple in both indices.
crates/ql-exec/src/calcgraph_session.rs:1019:        self.extract_and_register_deps(node, sheet, plan, workbook);
crates/ql-exec/src/calcgraph_session.rs:1029:    /// session-side dep state (formula_deps, volatile, name reverse
crates/ql-exec/src/calcgraph_session.rs:1036:    /// `clear_outgoing` (direct cell edges) + `clear_range_deps_for_formula`
crates/ql-exec/src/calcgraph_session.rs:1037:    /// (range deps in stripes + `formula_to_range_deps`). W5-50 wired
crates/ql-exec/src/calcgraph_session.rs:1038:    /// this into `extract_and_register_deps` (the rebind path) but
crates/ql-exec/src/calcgraph_session.rs:1046:            self.remove_formula_deps(node);
crates/ql-exec/src/calcgraph_session.rs:1054:            self.graph.clear_range_deps_for_formula(node);
crates/ql-exec/src/calcgraph_session.rs:1126:    /// hook's dirty fanout actually materializes as `#NAME?` cells.
crates/ql-exec/src/calcgraph_session.rs:1163:    /// 2. `formula_deps[F].tables` still contains the Arc<str> for
crates/ql-exec/src/calcgraph_session.rs:1164:    ///    `OLD` — a later re-bind of F would call `remove_formula_deps`
crates/ql-exec/src/calcgraph_session.rs:1173:    /// data cells), so VEQ will typically suppress the value write —
crates/ql-exec/src/calcgraph_session.rs:1204:            if let Some(deps) = self.formula_deps.get_mut(&n) {
crates/ql-exec/src/calcgraph_session.rs:1254:    /// `table_to_formulas` keys + `formula_deps[F].tables` Arcs are
crates/ql-exec/src/calcgraph_session.rs:1322:    /// re-extraction pattern mirrors the spill-mutation choreography
crates/ql-exec/src/calcgraph_session.rs:1323:    /// (`reextract_spill_footprint_readers`).
crates/ql-exec/src/calcgraph_session.rs:1448:    /// Used by `WorkbookRuntime::reextract_spill_footprint_readers`
crates/ql-exec/src/calcgraph_session.rs:1520:    /// Phase 3.3 introspection: how many cells have at least one
crates/ql-exec/src/calcgraph_session.rs:1533:    /// Phase 4 may add Range/Region nodes that aren't formula cells).
crates/ql-exec/src/calcgraph_session.rs:1546:    /// Use case: the runtime spill-writeback path (4.7.J.4) calls this
crates/ql-exec/src/calcgraph_session.rs:1547:    /// AFTER `register_spill` succeeds to find every formula whose dep
crates/ql-exec/src/calcgraph_session.rs:1548:    /// extraction was done BEFORE the spill registered. Those readers
crates/ql-exec/src/calcgraph_session.rs:1550:    /// re-extraction so the producer-alias rewrite fires and the
crates/ql-exec/src/calcgraph_session.rs:1567:    /// spill-mutation choreography (callers must follow with
crates/ql-exec/src/calcgraph_session.rs:1568:    /// `reextract_deps` + dirty/cache invalidation). External callers
crates/ql-exec/src/calcgraph_session.rs:1596:    /// wrapper around `extract_and_register_deps` for external callers
crates/ql-exec/src/calcgraph_session.rs:1597:    /// (notably `WorkbookRuntime`'s spill-writeback path) that need to
crates/ql-exec/src/calcgraph_session.rs:1600:    /// affects the producer-alias rewrite (i.e. a spill registered or
crates/ql-exec/src/calcgraph_session.rs:1616:    /// of `WorkbookRuntime`'s spill-mutation choreography.
crates/ql-exec/src/calcgraph_session.rs:1617:    pub(crate) fn reextract_deps(
crates/ql-exec/src/calcgraph_session.rs:1626:        self.extract_and_register_deps(reader_node, reader_sheet, plan, workbook);
crates/ql-exec/src/calcgraph_session.rs:1652:        // graph stores range deps in stripes + `formula_to_range_deps`
crates/ql-exec/src/calcgraph_session.rs:1668:    /// Non-formula cells (literals) inside the range are read as
crates/ql-exec/src/calcgraph_session.rs:1685:        // nodes for formula cells) filter out via cell_address_for
crates/ql-exec/src/calcgraph_session.rs:1694:            let ranges = self.graph.range_deps_for(f);
crates/ql-exec/src/calcgraph_session.rs:1806:        // Non-formula cells do not.
crates/ql-exec/src/calcgraph_session.rs:1910:    // `formula_deps` / `is_volatile` / `formulas_referencing_name` API.
crates/ql-exec/src/calcgraph_session.rs:1916:    /// `FormulaDeps::cells` exactly once each, even when the formula
crates/ql-exec/src/calcgraph_session.rs:1927:        let deps = s.formula_deps(node).expect("dep view present");
crates/ql-exec/src/calcgraph_session.rs:1928:        assert_eq!(deps.cells.len(), 2, "A1 and B1 — deduped, A1 appears once");
crates/ql-exec/src/calcgraph_session.rs:1929:        assert!(deps.cells.contains(&(0, 0, 0)), "A1 captured");
crates/ql-exec/src/calcgraph_session.rs:1930:        assert!(deps.cells.contains(&(0, 0, 1)), "B1 captured");
crates/ql-exec/src/calcgraph_session.rs:1931:        assert!(deps.named_ranges.is_empty());
crates/ql-exec/src/calcgraph_session.rs:1940:    fn dep_3_02_range_deps_remain_compressed() {
crates/ql-exec/src/calcgraph_session.rs:1950:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:1967:        let deps = s.formula_deps(node).expect("dep view present");
crates/ql-exec/src/calcgraph_session.rs:1969:            deps.cells.is_empty(),
crates/ql-exec/src/calcgraph_session.rs:1973:            deps.named_ranges.len(),
crates/ql-exec/src/calcgraph_session.rs:1977:        let (name, range) = &deps.named_ranges[0];
crates/ql-exec/src/calcgraph_session.rs:1995:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2060:        assert!(s.formula_deps(n_now).unwrap().is_volatile);
crates/ql-exec/src/calcgraph_session.rs:2061:        assert!(s.formula_deps(n_rand).unwrap().is_volatile);
crates/ql-exec/src/calcgraph_session.rs:2071:        // First plan: =A1+B1 — two cells.
crates/ql-exec/src/calcgraph_session.rs:2091:        assert_eq!(s.formula_deps(node).unwrap().cells.len(), 2);
crates/ql-exec/src/calcgraph_session.rs:2102:        let deps = s.formula_deps(node).unwrap();
crates/ql-exec/src/calcgraph_session.rs:2103:        assert_eq!(deps.cells, vec![(0, 0, 2)]);
crates/ql-exec/src/calcgraph_session.rs:2107:    /// `formula_deps`, the volatile set, and the name→formulas reverse
crates/ql-exec/src/calcgraph_session.rs:2118:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2135:        assert!(s.formula_deps(node).is_some());
crates/ql-exec/src/calcgraph_session.rs:2141:        assert!(s.formula_deps(node).is_none(), "dep entry evicted");
crates/ql-exec/src/calcgraph_session.rs:2176:        assert!(r.session.formula_deps(n_ok).is_none());
crates/ql-exec/src/calcgraph_session.rs:2177:        assert!(r.session.formula_deps(n_bad1).is_none());
crates/ql-exec/src/calcgraph_session.rs:2178:        assert!(r.session.formula_deps(n_bad2).is_none());
crates/ql-exec/src/calcgraph_session.rs:2215:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2272:        assert_eq!(a.cells.len(), 1);
crates/ql-exec/src/calcgraph_session.rs:2325:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2409:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2421:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2433:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2515:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2538:        // map + formula_to_range_deps, not as Graph edges.
crates/ql-exec/src/calcgraph_session.rs:2590:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2673:        // must be evicted by `remove_formula_deps`.
crates/ql-exec/src/calcgraph_session.rs:2706:    // `Graph::clear_range_deps_for_formula` into
crates/ql-exec/src/calcgraph_session.rs:2707:    // `extract_and_register_deps` so the graph is wholesale revoked
crates/ql-exec/src/calcgraph_session.rs:2712:    // wiring: `on_set_formula` → `extract_and_register_deps` actually
crates/ql-exec/src/calcgraph_session.rs:2722:        // Add A1 and B1 as formula cells so cell_index has nodes for
crates/ql-exec/src/calcgraph_session.rs:2723:        // them (extract_and_register_deps only adds forward edges to
crates/ql-exec/src/calcgraph_session.rs:2724:        // dep cells that already have nodes).
crates/ql-exec/src/calcgraph_session.rs:3146:    // `on_clear_formula` only called `remove_formula_deps` (session-
crates/ql-exec/src/calcgraph_session.rs:3147:    // side) and never `graph.clear_outgoing` / `graph.clear_range_deps_
crates/ql-exec/src/calcgraph_session.rs:3151:    // `on_clear_formula` after `remove_formula_deps`.
crates/ql-exec/src/calcgraph_session.rs:3213:    /// registrations + `formula_to_range_deps` entry. Writes to the
crates/ql-exec/src/calcgraph_session.rs:3293:        // + formula_to_range_deps[A1] = [A1:A1] in place; a subsequent
crates/ql-exec/src/calcgraph_session.rs:3296:        // stale range_deps_for(A1), and Tarjan would emit A1 in
crates/ql-exec/src/calcgraph_session.rs:3307:            s.graph().range_deps_for(a1).is_empty(),
crates/ql-exec/src/calcgraph_session.rs:3473:    // ql-calcgraph::topo. Phase 3.4 wires it: extract_and_register_deps
crates/ql-exec/src/calcgraph_session.rs:3512:        // in the graph (extract_and_register_deps added it on the
crates/ql-exec/src/calcgraph_session.rs:3713:    // ===== W5-102 (Phase 4.7.I) — producer-alias dep extraction =====
crates/ql-exec/src/calcgraph_session.rs:3716:    // references a spill TARGET cell, dep extraction must reroute the
crates/ql-exec/src/calcgraph_session.rs:3718:    // every cell in the spill rectangle. See design doc § 10.1.
crates/ql-exec/src/calcgraph_session.rs:3720:    /// Reader formula `B1 = A2` where A2 is the spill TARGET of an
crates/ql-exec/src/calcgraph_session.rs:3725:    fn producer_alias_reroutes_target_dep_to_anchor() {
crates/ql-exec/src/calcgraph_session.rs:3728:        wb.register_spill((0, 0, 0), ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/calcgraph_session.rs:3729:            .expect("register_spill must succeed on empty workbook");
crates/ql-exec/src/calcgraph_session.rs:3732:        // B1 = A2 (CellRef to the spill target).
crates/ql-exec/src/calcgraph_session.rs:3743:        let deps = s.formula_deps(b1).expect("B1 must have deps recorded");
crates/ql-exec/src/calcgraph_session.rs:3745:            deps.cells,
crates/ql-exec/src/calcgraph_session.rs:3752:    /// in the SAME spill rectangle, must both end up dependent on the
crates/ql-exec/src/calcgraph_session.rs:3757:    /// `producer_alias_single_formula_two_targets_collapse` for that.)
crates/ql-exec/src/calcgraph_session.rs:3759:    fn producer_alias_two_readers_one_anchor_both_dirty_together() {
crates/ql-exec/src/calcgraph_session.rs:3761:        // Anchor A1 with shape (3, 1) → A1, A2, A3 all part of spill.
crates/ql-exec/src/calcgraph_session.rs:3762:        wb.register_spill((0, 0, 0), ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/calcgraph_session.rs:3763:            .expect("register_spill must succeed");
crates/ql-exec/src/calcgraph_session.rs:3787:        assert_eq!(s.formula_deps(c1).unwrap().cells, vec![(0, 0, 0)]);
crates/ql-exec/src/calcgraph_session.rs:3788:        assert_eq!(s.formula_deps(d1).unwrap().cells, vec![(0, 0, 0)]);
crates/ql-exec/src/calcgraph_session.rs:3795:        // the producer-alias rewrite.
crates/ql-exec/src/calcgraph_session.rs:3802:    /// A formula referencing the SAME spill target twice (e.g. `=A2+A2`)
crates/ql-exec/src/calcgraph_session.rs:3804:    /// two `(0, 1, 0)` entries; producer-alias rewrites both to
crates/ql-exec/src/calcgraph_session.rs:3807:    fn producer_alias_dedupe_same_target_twice() {
crates/ql-exec/src/calcgraph_session.rs:3810:        wb.register_spill((0, 0, 0), ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/calcgraph_session.rs:3811:            .expect("register_spill must succeed");
crates/ql-exec/src/calcgraph_session.rs:3834:        let deps = s.formula_deps(b1).unwrap();
crates/ql-exec/src/calcgraph_session.rs:3836:            deps.cells,
crates/ql-exec/src/calcgraph_session.rs:3838:            "A2+A2 must collapse to a single anchor dep after producer-alias rewrite + dedupe"
crates/ql-exec/src/calcgraph_session.rs:3842:    /// SINGLE formula referencing TWO different cells in the SAME spill
crates/ql-exec/src/calcgraph_session.rs:3844:    /// after producer-alias rewrite handles two distinct targets
crates/ql-exec/src/calcgraph_session.rs:3847:    fn producer_alias_single_formula_two_targets_collapse() {
crates/ql-exec/src/calcgraph_session.rs:3850:        wb.register_spill((0, 0, 0), ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/calcgraph_session.rs:3851:            .expect("register_spill must succeed");
crates/ql-exec/src/calcgraph_session.rs:3874:        let deps = s.formula_deps(b1).unwrap();
crates/ql-exec/src/calcgraph_session.rs:3876:            deps.cells,
crates/ql-exec/src/calcgraph_session.rs:3878:            "A2 and A3 both alias to A1; single formula must collapse to one anchor dep"
crates/ql-exec/src/calcgraph_session.rs:3882:    /// LOW-1 regression: bind B1 = A2 (alias to anchor A1 via spill),
crates/ql-exec/src/calcgraph_session.rs:3883:    /// then rebind B1 = Z1 (no alias). Writing the anchor must NOT
crates/ql-exec/src/calcgraph_session.rs:3884:    /// dirty B1 anymore. Proves remove_formula_deps correctly evicts
crates/ql-exec/src/calcgraph_session.rs:3888:    fn producer_alias_rebind_to_non_alias_evicts_anchor_dep() {
crates/ql-exec/src/calcgraph_session.rs:3890:        wb.register_spill((0, 0, 0), ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/calcgraph_session.rs:3891:            .expect("register_spill must succeed");
crates/ql-exec/src/calcgraph_session.rs:3894:        // v1: B1 = A2 (aliases to A1).
crates/ql-exec/src/calcgraph_session.rs:3904:        assert_eq!(s.formula_deps(b1).unwrap().cells, vec![(0, 0, 0)]);
crates/ql-exec/src/calcgraph_session.rs:3906:        // v2: B1 = Z1 (cell far outside any spill).
crates/ql-exec/src/calcgraph_session.rs:3916:            s.formula_deps(b1).unwrap().cells,
crates/ql-exec/src/calcgraph_session.rs:3918:            "rebind must overwrite deps, dropping the prior anchor alias"
crates/ql-exec/src/calcgraph_session.rs:3924:        // alias dep was evicted.
crates/ql-exec/src/calcgraph_session.rs:3928:            "evicted alias dep must not fire on anchor writes after rebind"
crates/ql-exec/src/calcgraph_session.rs:3933:    /// spill rectangle must be left unchanged by the producer-alias
crates/ql-exec/src/calcgraph_session.rs:3937:    fn producer_alias_leaves_non_target_dep_unchanged() {
crates/ql-exec/src/calcgraph_session.rs:3939:        // Register a spill far away from the cell B1 reads.
crates/ql-exec/src/calcgraph_session.rs:3940:        wb.register_spill((0, 10, 10), ql_storage::SpillShape::new(2, 2))
crates/ql-exec/src/calcgraph_session.rs:3941:            .expect("register_spill must succeed");
crates/ql-exec/src/calcgraph_session.rs:3944:        // B1 = A2 — A2 is NOT in any spill.
crates/ql-exec/src/calcgraph_session.rs:3955:            s.formula_deps(b1).unwrap().cells,
crates/ql-exec/src/calcgraph_session.rs:3957:            "non-spill-target deps must be left alone"
crates/ql-exec/src/calcgraph_session.rs:3972:    /// formulas. `extract_and_register_deps` reads
crates/ql-exec/src/calcgraph_session.rs:3994:        let deps = s.formula_deps(node).unwrap();
crates/ql-exec/src/calcgraph_session.rs:4193:    /// **W5-157:** `formula_deps[F].tables` is updated in-place so a
crates/ql-exec/src/calcgraph_session.rs:4194:    /// subsequent `remove_formula_deps(F)` (rebind / clear) cleans up
crates/ql-exec/src/calcgraph_session.rs:4197:    fn on_table_rename_updates_formula_deps_tables_in_place() {
crates/ql-exec/src/calcgraph_session.rs:4214:        let deps = s.formula_deps(f1).expect("deps registered");
crates/ql-exec/src/calcgraph_session.rs:4283:    /// `formula_deps[F].tables` (table name unchanged → no Arc
crates/ql-exec/src/calcgraph_session.rs:4304:        let deps = s.formula_deps(f1).unwrap();
crates/ql-exec/src/calcgraph_session.rs:4445:        let deps = s.formula_deps(f1).unwrap();
crates/ql-storage/src/sheet.rs:11:use crate::workbook::{NameTable, NameTableError, NamedTarget};
crates/ql-storage/src/sheet.rs:104:        target: NamedTarget,
crates/ql-storage/src/sheet.rs:223:    /// the formula text is removed. No-op for out-of-bounds cells.
crates/ql-storage/src/sheet.rs:306:        // Empty cells in the new columns:
crates/ql-storage/src/sheet.rs:384:        s.set_scoped_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-storage/src/sheet.rs:390:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
crates/ql-storage/src/sheet.rs:398:        s.set_scoped_name("X", NamedTarget::Constant(Value::Number(1.0)))
crates/ql-storage/src/sheet.rs:410:            .set_scoped_name("AI", NamedTarget::Constant(Value::Number(42.0)))
crates/ql-storage/src/sheet.rs:420:        s1.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-storage/src/sheet.rs:422:        s2.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.10)))
crates/ql-storage/src/sheet.rs:427:        assert!(matches!(r1, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21));
crates/ql-storage/src/sheet.rs:428:        assert!(matches!(r2, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.10));
crates/ql-storage/src/format_overlay.rs:3://! Cells with a non-General format live in this overlay; cells without an
crates/ql-storage/src/format_overlay.rs:6://! Per design doc § 7.2: most cells have General format, so a per-cell
crates/ql-storage/src/format_overlay.rs:7://! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
crates/ql-storage/src/format_overlay.rs:9://! number of cells with actual custom formats — a small fraction in
crates/ql-storage/src/format_overlay.rs:62:    /// True iff no cells carry a custom format.
crates/ql-storage/src/tables.rs:232:    ///    can register cells beyond the addressable grid, causing
crates/ql-storage/src/tables.rs:233:    ///    `Sheet::put` panics later on writes into those cells.
crates/ql-storage/src/tables.rs:236:    ///    range (skipping all overlap / spill-anchor checks) or runs
crates/ql-storage/src/column.rs:83:///   `put_computed` is only called for formula cells (which have no user-overlay entry).
crates/ql-storage/src/column.rs:353:    /// Compat alias for `user_overlay` — pre-Phase 3.5 callers asked for "the overlay";
crates/ql-storage/src/column.rs:703:        // Construct 3 chunks of 16 each (=48 rows), populate at boundary cells.
crates/ql-storage/src/workbook.rs:30:pub enum NamedTarget {
crates/ql-storage/src/workbook.rs:61:    entries: HashMap<Arc<str>, NamedTarget>,
crates/ql-storage/src/workbook.rs:73:/// `wb.set_name("AI", NamedTarget::Constant(...))` then writing `=AI` bypassed
crates/ql-storage/src/workbook.rs:126:/// will reject these names at the producer once the binder's
crates/ql-storage/src/workbook.rs:174:        target: NamedTarget,
crates/ql-storage/src/workbook.rs:182:        // (`K`, `XFC`, `A1`) at the producer, but existing tests
crates/ql-storage/src/workbook.rs:239:    pub fn lookup(&self, name: &str) -> Option<NamedTarget> {
crates/ql-storage/src/workbook.rs:246:    pub fn lookup_ci(&self, name: &str) -> Option<NamedTarget> {
crates/ql-storage/src/workbook.rs:260:    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &NamedTarget)> + '_ {
crates/ql-storage/src/workbook.rs:267:/// Phase 1 W5-9 adds `formula_cells`: a HashMap keyed by `(sheet, row, col)` mapping
crates/ql-storage/src/workbook.rs:268:/// formula-bearing cells to their formula source text (e.g. `"A1 + B1"`). The cell's
crates/ql-storage/src/workbook.rs:299:    formula_cells: HashMap<(SheetId, RowId, ColId), Arc<str>>,
crates/ql-storage/src/workbook.rs:313:    /// **W5-101 (Phase 4.7.H):** spill-anchor table. Workbook-level
crates/ql-storage/src/workbook.rs:314:    /// because spills can theoretically span sheets (rare in Excel; v1
crates/ql-storage/src/workbook.rs:316:    /// design; mutation goes through `register_spill` / `clear_spill_at`
crates/ql-storage/src/workbook.rs:319:    /// `crates/ql-storage/src/spill.rs` module docs.
crates/ql-storage/src/workbook.rs:320:    spill_anchors: crate::SpillAnchorTable,
crates/ql-storage/src/workbook.rs:467:    /// `formula_cells` and `NamedTarget::Formula` entries continue to
crates/ql-storage/src/workbook.rs:574:    /// - `write_spill` to block spill anchors inside table footprints
crates/ql-storage/src/workbook.rs:599:    pub fn set_name(&mut self, name: &str, target: NamedTarget) -> Result<(), NameTableError> {
crates/ql-storage/src/workbook.rs:683:    // ===== W5-101 (Phase 4.7.H) spill-anchor API =====
crates/ql-storage/src/workbook.rs:685:    /// **W5-101 (Phase 4.7.H):** read access to the spill-anchor table.
crates/ql-storage/src/workbook.rs:688:    pub fn spill_anchors(&self) -> &crate::SpillAnchorTable {
crates/ql-storage/src/workbook.rs:689:        &self.spill_anchors
crates/ql-storage/src/workbook.rs:693:    /// active spill anchor? Returns `Some(&shape)` iff yes. Delegates to
crates/ql-storage/src/workbook.rs:695:    pub fn spill_anchor_at(
crates/ql-storage/src/workbook.rs:701:        self.spill_anchors.anchor_at(sheet, row, col)
crates/ql-storage/src/workbook.rs:705:    /// is a spill target (anchor or any non-anchor target cell), return
crates/ql-storage/src/workbook.rs:706:    /// the anchor. `O(1)`. Used by the runtime spill-invalidation path
crates/ql-storage/src/workbook.rs:707:    /// (4.7.K) on `set_value` to detect user writes into spill ranges.
crates/ql-storage/src/workbook.rs:708:    pub fn spill_target_anchor(
crates/ql-storage/src/workbook.rs:714:        self.spill_anchors.target_anchor(sheet, row, col)
crates/ql-storage/src/workbook.rs:717:    /// **W5-101 (Phase 4.7.H):** register a new spill. Map-only — does
crates/ql-storage/src/workbook.rs:718:    /// NOT touch computed overlays. The runtime spill-writeback path
crates/ql-storage/src/workbook.rs:720:    /// target cell value AFTER `register_spill` succeeds.
crates/ql-storage/src/workbook.rs:721:    pub fn register_spill(
crates/ql-storage/src/workbook.rs:726:        self.spill_anchors.register(anchor, shape)
crates/ql-storage/src/workbook.rs:732:    /// spill before re-eval" step (design § 8.3) and when clearing a
crates/ql-storage/src/workbook.rs:738:    ///   `spill_anchor_at(...).is_some()`.
crates/ql-storage/src/workbook.rs:739:    pub fn clear_spill_at(
crates/ql-storage/src/workbook.rs:743:        let shape = self.spill_anchors.unregister(anchor)?;
crates/ql-storage/src/workbook.rs:745:        // This is the coupling reason `clear_spill_at` lives on
crates/ql-storage/src/workbook.rs:760:    /// `clear_spill_at`. Returns `true` if a spill was cleared, `false`
crates/ql-storage/src/workbook.rs:762:    /// runtime spill-writeback path (Phase 4.7.J) which calls "clear
crates/ql-storage/src/workbook.rs:763:    /// before re-eval" regardless of whether a prior spill existed.
crates/ql-storage/src/workbook.rs:764:    /// Equivalent to `clear_spill_at(anchor).is_ok()` semantically.
crates/ql-storage/src/workbook.rs:765:    pub fn clear_spill_if_present(&mut self, anchor: (SheetId, RowId, ColId)) -> bool {
crates/ql-storage/src/workbook.rs:766:        self.clear_spill_at(anchor).is_ok()
crates/ql-storage/src/workbook.rs:870:    /// bypassable: a `formula_cells` entry with an out-of-bounds coord would
crates/ql-storage/src/workbook.rs:898:        self.formula_cells.insert((sheet, row, col), formula.into());
crates/ql-storage/src/workbook.rs:915:        self.formula_cells.remove(&(sheet, row, col));
crates/ql-storage/src/workbook.rs:921:        self.formula_cells.get(&(sheet, row, col))
crates/ql-storage/src/workbook.rs:924:    /// Count of formula cells across the workbook.
crates/ql-storage/src/workbook.rs:926:        self.formula_cells.len()
crates/ql-storage/src/workbook.rs:932:        self.formula_cells
crates/ql-storage/src/workbook.rs:976:        // Each sheet maintains its own cells.
crates/ql-storage/src/workbook.rs:1008:        let target = NamedTarget::Constant(Value::Number(0.21));
crates/ql-storage/src/workbook.rs:1035:        let cell = NamedTarget::Cell(Address::new(0, 0, 0));
crates/ql-storage/src/workbook.rs:1036:        let rng = NamedTarget::Range(ql_types::Range::new(0, 0, 0, 9, 0));
crates/ql-storage/src/workbook.rs:1037:        let con = NamedTarget::Constant(Value::Number(0.21));
crates/ql-storage/src/workbook.rs:1038:        let frm = NamedTarget::Formula(std::sync::Arc::from("=A1+B1"));
crates/ql-storage/src/workbook.rs:1123:    // ===== W5-9: formula_cells =====
crates/ql-storage/src/workbook.rs:1126:    fn formula_cells_default_empty() {
crates/ql-storage/src/workbook.rs:1213:        let result = wb.set_name("AI", NamedTarget::Constant(Value::Number(42.0)));
crates/ql-storage/src/workbook.rs:1227:        let result = wb.set_name("ai", NamedTarget::Constant(Value::Number(42.0)));
crates/ql-storage/src/workbook.rs:1229:        let result_mixed = wb.set_name("Ai", NamedTarget::Constant(Value::Number(42.0)));
crates/ql-storage/src/workbook.rs:1237:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-storage/src/workbook.rs:1471:    // ===== W5-101 (Phase 4.7.H) Workbook spill-anchor integration =====
crates/ql-storage/src/workbook.rs:1474:    fn workbook_register_spill_round_trip() {
crates/ql-storage/src/workbook.rs:1477:        // Register a 2x3 spill at (0, 1, 1) — covers B2:D3.
crates/ql-storage/src/workbook.rs:1478:        wb.register_spill((0, 1, 1), crate::SpillShape::new(2, 3))
crates/ql-storage/src/workbook.rs:1481:            wb.spill_anchor_at(0, 1, 1),
crates/ql-storage/src/workbook.rs:1488:                    wb.spill_target_anchor(0, 1 + dr, 1 + dc),
crates/ql-storage/src/workbook.rs:1499:    fn workbook_clear_spill_at_clears_computed_overlays() {
crates/ql-storage/src/workbook.rs:1502:        // Register a 1x3 spill at (0, 0, 0) covering A1:C1.
crates/ql-storage/src/workbook.rs:1503:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
crates/ql-storage/src/workbook.rs:1513:        // clear_spill_at: unregisters AND clears overlays at every target.
crates/ql-storage/src/workbook.rs:1514:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/workbook.rs:1516:        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
crates/ql-storage/src/workbook.rs:1517:        assert!(wb.spill_target_anchor(0, 0, 1).is_none());
crates/ql-storage/src/workbook.rs:1525:    fn workbook_register_spill_rejects_collision_with_existing() {
crates/ql-storage/src/workbook.rs:1528:        wb.register_spill((0, 0, 0), crate::SpillShape::new(3, 1))
crates/ql-storage/src/workbook.rs:1530:        // Second spill at (0, 1, 0) would overlap A2/A3 of the first.
crates/ql-storage/src/workbook.rs:1532:            .register_spill((0, 1, 0), crate::SpillShape::new(3, 1))
crates/ql-storage/src/workbook.rs:1536:            crate::SpillBlockError::TargetCellOccupied { .. }
crates/ql-storage/src/workbook.rs:1541:    fn workbook_clear_spill_at_unknown_anchor_errors() {
crates/ql-storage/src/workbook.rs:1544:        let err = wb.clear_spill_at((0, 5, 5)).unwrap_err();
crates/ql-storage/src/workbook.rs:1550:    fn workbook_clear_spill_at_preserves_user_overlays_outside_rectangle() {
crates/ql-storage/src/workbook.rs:1551:        // A user-typed value outside the spill rectangle must survive
crates/ql-storage/src/workbook.rs:1552:        // clear_spill_at. Verifies the clear loop is bounded to the
crates/ql-storage/src/workbook.rs:1556:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
crates/ql-storage/src/workbook.rs:1561:        // User value at A2 (row 1, col 0) — OUTSIDE the 1x3 spill.
crates/ql-storage/src/workbook.rs:1563:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/workbook.rs:1571:    fn workbook_spill_anchors_accessor_returns_table() {
crates/ql-storage/src/workbook.rs:1574:        assert_eq!(wb.spill_anchors().len(), 0);
crates/ql-storage/src/workbook.rs:1575:        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 2))
crates/ql-storage/src/workbook.rs:1577:        wb.register_spill((0, 5, 5), crate::SpillShape::new(1, 1))
crates/ql-storage/src/workbook.rs:1579:        assert_eq!(wb.spill_anchors().len(), 2);
crates/ql-storage/src/workbook.rs:1582:    // ===== W5-101-AUDIT (Codex LOW-3) — clear_spill_if_present =====
crates/ql-storage/src/workbook.rs:1585:    fn workbook_clear_spill_if_present_returns_true_when_cleared() {
crates/ql-storage/src/workbook.rs:1588:        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 1))
crates/ql-storage/src/workbook.rs:1590:        let cleared = wb.clear_spill_if_present((0, 0, 0));
crates/ql-storage/src/workbook.rs:1592:        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
crates/ql-storage/src/workbook.rs:1596:    fn workbook_clear_spill_if_present_returns_false_when_missing() {
crates/ql-storage/src/workbook.rs:1600:        let cleared = wb.clear_spill_if_present((0, 5, 5));
crates/ql-storage/src/workbook.rs:1605:    fn workbook_clear_spill_at_clears_anchor_own_computed_overlay() {
crates/ql-storage/src/workbook.rs:1607:        // (the (0,0) of its own spill range) gets its computed
crates/ql-storage/src/workbook.rs:1611:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 1))
crates/ql-storage/src/workbook.rs:1615:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/spill.rs:1://! Spill-anchor storage — workbook-level table mapping anchor cells to
crates/ql-storage/src/spill.rs:2://! their spill shapes, with a reverse map from each spilled-into cell
crates/ql-storage/src/spill.rs:6://! dynamic-array spills. Per design doc § 7:
crates/ql-storage/src/spill.rs:7://! `docs/architecture/2026-05-14-array-formulas-and-spills.md` § 7.
crates/ql-storage/src/spill.rs:18://! - `anchors` — one entry per spilling formula. Key is the anchor cell
crates/ql-storage/src/spill.rs:19://!   (top-left of the spill rectangle); value is the rectangle's
crates/ql-storage/src/spill.rs:22://!   spill?" lookup at user-write / dep-extraction time. Key is each
crates/ql-storage/src/spill.rs:23://!   cell in the spill rectangle (including the anchor itself); value
crates/ql-storage/src/spill.rs:34://!    spill-detection logic at user-write time — a single map lookup
crates/ql-storage/src/spill.rs:35://!    answers "is this cell part of a spill (anchor or otherwise)?".
crates/ql-storage/src/spill.rs:42://! intentionally map-only. Overlay clearing on spill removal lives in
crates/ql-storage/src/spill.rs:43://! `Workbook::clear_spill_at`, which couples the table mutation with
crates/ql-storage/src/spill.rs:76:/// would collide with an existing spill OR overlap an existing anchor.
crates/ql-storage/src/spill.rs:78:/// The runtime spill-writeback path (Phase 4.7.J) maps these into
crates/ql-storage/src/spill.rs:84:    /// A non-anchor cell inside the proposed spill rectangle is
crates/ql-storage/src/spill.rs:85:    /// already a target of a DIFFERENT existing spill. The runtime
crates/ql-storage/src/spill.rs:88:        "spill blocked: cell ({sheet},{row},{col}) is already a target of \
crates/ql-storage/src/spill.rs:91:    TargetCellOccupied {
crates/ql-storage/src/spill.rs:100:    /// The proposed anchor cell IS an existing spill anchor (different
crates/ql-storage/src/spill.rs:102:    /// The runtime should call `clear_spill_at(anchor)` before re-
crates/ql-storage/src/spill.rs:105:        "spill blocked: cell ({sheet},{row},{col}) is already an anchor; \
crates/ql-storage/src/spill.rs:106:         clear it first via clear_spill_at"
crates/ql-storage/src/spill.rs:119:        "spill blocked: degenerate shape ({rows} rows, {cols} cols) — both \
crates/ql-storage/src/spill.rs:124:    /// **W5-101-AUDIT (Codex MEDIUM-2):** spill rectangle would extend
crates/ql-storage/src/spill.rs:127:    /// release-build u32 arithmetic and can register cells at impossible
crates/ql-storage/src/spill.rs:128:    /// coordinates. The runtime spill-writeback path (Phase 4.7.J) maps
crates/ql-storage/src/spill.rs:131:        "spill blocked: rectangle from ({sheet},{row},{col}) sized \
crates/ql-storage/src/spill.rs:146:#[error("no spill anchor at ({sheet},{row},{col})")]
crates/ql-storage/src/spill.rs:153:/// Workbook-level spill-anchor table.
crates/ql-storage/src/spill.rs:157:/// (`Workbook::clear_spill_at`). See module-level docs for the
crates/ql-storage/src/spill.rs:172:    /// an active spill anchor. `O(1)`.
crates/ql-storage/src/spill.rs:180:    /// the runtime spill-invalidation path (Phase 4.7.K) — when a user
crates/ql-storage/src/spill.rs:191:    /// Register a new spill: `anchor` is the top-left cell, `shape` is
crates/ql-storage/src/spill.rs:198:    /// - `TargetCellOccupied` — some cell inside the rectangle is in
crates/ql-storage/src/spill.rs:199:    ///   `targets` already (a DIFFERENT spill claims it).
crates/ql-storage/src/spill.rs:219:        // touch cells at impossible row/col coordinates. The check
crates/ql-storage/src/spill.rs:253:                    return Err(SpillBlockError::TargetCellOccupied {
crates/ql-storage/src/spill.rs:292:    /// Remove a spill anchor + all its targets. Returns the cleared
crates/ql-storage/src/spill.rs:293:    /// shape so callers (e.g. `Workbook::clear_spill_at`) can iterate
crates/ql-storage/src/spill.rs:313:    /// Iterator over `(anchor_cell, shape)` for every registered spill.
crates/ql-storage/src/spill.rs:351:    fn register_1x1_spill() {
crates/ql-storage/src/spill.rs:361:    fn register_5x1_spill_populates_targets() {
crates/ql-storage/src/spill.rs:362:        // `=SEQUENCE(5)` at A1 spills A1..A5.
crates/ql-storage/src/spill.rs:375:    fn register_2x3_spill_populates_all_cells() {
crates/ql-storage/src/spill.rs:405:        // First spill at A1: 3x1. Second spill at A2: 3x1 — would
crates/ql-storage/src/spill.rs:406:        // overlap A2, A3 with the first spill. Reject; no partial
crates/ql-storage/src/spill.rs:414:            SpillBlockError::TargetCellOccupied {
crates/ql-storage/src/spill.rs:426:            other => panic!("expected TargetCellOccupied, got {other:?}"),
crates/ql-storage/src/spill.rs:463:        // All four target cells gone.
crates/ql-storage/src/spill.rs:504:    fn two_disjoint_spills_coexist() {
crates/ql-storage/src/spill.rs:518:    fn spills_on_different_sheets_are_independent() {
crates/ql-storage/src/spill.rs:539:        let cells: std::collections::HashSet<_> = anchors.iter().map(|(c, _)| *c).collect();
crates/ql-storage/src/spill.rs:540:        assert!(cells.contains(&at(0, 0, 0)));
crates/ql-storage/src/spill.rs:541:        assert!(cells.contains(&at(0, 5, 5)));
crates/ql-storage/src/spill.rs:545:    fn spill_shape_cell_count() {
crates/ql-storage/src/spill.rs:554:    fn register_rejects_spill_extending_past_max_row() {
crates/ql-storage/src/spill.rs:568:    fn register_rejects_spill_extending_past_max_column() {
crates/ql-storage/src/spill.rs:576:    fn register_accepts_spill_ending_exactly_at_max_row() {
crates/ql-storage/src/spill.rs:577:        // Last row of the spill == MAX_ROW exactly — should be allowed.
crates/ql-storage/src/lib.rs:22://! enums (`NamedTarget`, `TotalsFunction`) are exhaustive by design;
crates/ql-storage/src/lib.rs:31:pub mod spill;
crates/ql-storage/src/lib.rs:40:pub use spill::{SpillAnchorTable, SpillBlockError, SpillNotFoundError, SpillShape};
crates/ql-storage/src/lib.rs:42:pub use workbook::{NameTable, NameTableError, NamedTarget, SheetNameError, Workbook};
crates/ql-storage/src/format.rs:6://! of built-ins (mini-spec § 10) so cells with the most common formats
crates/ql-storage/src/format.rs:23:    /// Excel built-in id 0 — "General". Default for cells with no explicit format.

exec
/bin/zsh -lc "rg -n \"pub enum Named|enum Name|struct Name|NameTarget|NamedTarget|ScopedName|set_name|lookup_ci|names\\(\\)|formula_to_range|range_contains_rowcol|RangeRef|sheet:\" crates/ql-storage/src crates/ql-types/src crates/ql-exec/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/lower.rs:30://! - `Function { name: "SUM" | "AVERAGE", args: [RangeRef(...)] }` → reduction kernel.
crates/ql-exec/src/lower.rs:207:            sheet: 0,
crates/ql-storage/src/sheet.rs:11:use crate::workbook::{NameTable, NameTableError, NamedTarget};
crates/ql-storage/src/sheet.rs:98:    /// `Workbook::set_name` (validate, append, propagate generation).
crates/ql-storage/src/sheet.rs:104:        target: NamedTarget,
crates/ql-storage/src/sheet.rs:120:    pub fn set_name(&mut self, new_name: impl Into<String>) {
crates/ql-storage/src/sheet.rs:378:        assert!(s.scoped_names().is_empty());
crates/ql-storage/src/sheet.rs:384:        s.set_scoped_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-storage/src/sheet.rs:389:            s.scoped_names().lookup_ci("taxrate"),
crates/ql-storage/src/sheet.rs:390:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
crates/ql-storage/src/sheet.rs:392:        assert_eq!(s.scoped_names().len(), 1);
crates/ql-storage/src/sheet.rs:398:        s.set_scoped_name("X", NamedTarget::Constant(Value::Number(1.0)))
crates/ql-storage/src/sheet.rs:400:        assert_eq!(s.scoped_names().len(), 1);
crates/ql-storage/src/sheet.rs:402:        assert_eq!(s.scoped_names().len(), 0);
crates/ql-storage/src/sheet.rs:403:        assert!(s.scoped_names().lookup_ci("X").is_none());
crates/ql-storage/src/sheet.rs:410:            .set_scoped_name("AI", NamedTarget::Constant(Value::Number(42.0)))
crates/ql-storage/src/sheet.rs:420:        s1.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-storage/src/sheet.rs:422:        s2.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.10)))
crates/ql-storage/src/sheet.rs:425:        let r1 = s1.scoped_names().lookup_ci("Rate");
crates/ql-storage/src/sheet.rs:426:        let r2 = s2.scoped_names().lookup_ci("Rate");
crates/ql-storage/src/sheet.rs:427:        assert!(matches!(r1, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21));
crates/ql-storage/src/sheet.rs:428:        assert!(matches!(r2, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.10));
crates/ql-exec/src/loader.rs:188:        use ql_storage::NamedTarget;
crates/ql-exec/src/loader.rs:192:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/loader.rs:215:            loaded.names().lookup("TAXRATE"),
crates/ql-exec/src/loader.rs:216:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
crates/ql-exec/src/loader.rs:386:        use ql_storage::NamedTarget;
crates/ql-exec/src/loader.rs:393:        wb.set_name("MyRow", NamedTarget::Range(Range::new(s, 0, 0, 0, 2)))
crates/ql-exec/src/loader.rs:424:        assert!(loaded.names().lookup_ci("MYROW").is_some());
crates/ql-storage/src/tables.rs:92:    pub sheet: SheetId,
crates/ql-storage/src/tables.rs:412:            sheet: 0,
crates/ql-storage/src/tables.rs:480:            sheet: 0,
crates/ql-storage/src/tables.rs:579:                sheet: 0,
crates/ql-storage/src/tables.rs:604:                sheet: 0,
crates/ql-storage/src/tables.rs:619:                sheet: 0,
crates/ql-storage/src/tables.rs:648:                sheet: 0,
crates/ql-types/src/address.rs:36:    pub sheet: SheetId,
crates/ql-types/src/address.rs:42:    pub const fn new(sheet: SheetId, row: RowId, col: ColId) -> Self {
crates/ql-types/src/address.rs:48:    /// Render in `sheet:row,col` form (0-indexed). The Excel-style A1 form lives in
crates/ql-types/src/address.rs:60:    pub sheet: SheetId,
crates/ql-types/src/address.rs:73:    pub fn new(sheet: SheetId, row1: RowId, col1: ColId, row2: RowId, col2: ColId) -> Self {
crates/ql-exec/src/calcgraph_session.rs:78:    range_contains_rowcol, schedule_with_supplemental, CellNode, Graph, Node, NodeId, Schedule,
crates/ql-exec/src/calcgraph_session.rs:80:use ql_formula_syntax::{lex, parse, RangeRef, SheetRef};
crates/ql-exec/src/calcgraph_session.rs:89:/// `ExprPlan::AggregateNameRef`) to a `ql_formula_syntax::RangeRef`
crates/ql-exec/src/calcgraph_session.rs:103:fn range_to_rangeref(r: Range) -> RangeRef {
crates/ql-exec/src/calcgraph_session.rs:107:        RangeRef::WholeColumn {
crates/ql-exec/src/calcgraph_session.rs:108:            sheet: SheetRef::Id(r.sheet),
crates/ql-exec/src/calcgraph_session.rs:115:        RangeRef::WholeRow {
crates/ql-exec/src/calcgraph_session.rs:116:            sheet: SheetRef::Id(r.sheet),
crates/ql-exec/src/calcgraph_session.rs:125:        RangeRef::Cells {
crates/ql-exec/src/calcgraph_session.rs:126:            sheet: SheetRef::Id(r.sheet),
crates/ql-exec/src/calcgraph_session.rs:193:/// **shape-aware** suppression — only direct `CellRef` / `RangeRef` args
crates/ql-exec/src/calcgraph_session.rs:287:            //    direct CellRef/RangeRef (their address is the input,
crates/ql-exec/src/calcgraph_session.rs:320:        // literal range refs bind to `ExprPlan::RangeRef { range }`
crates/ql-exec/src/calcgraph_session.rs:324:        //     `RangeRef` arm (no-op — addresses don't change without
crates/ql-exec/src/calcgraph_session.rs:345:        ExprPlan::RangeRef { range } => {
crates/ql-exec/src/calcgraph_session.rs:393:/// - `RangeRef { range }` — no value-dep. ROWS/COLUMNS read `start_row` /
crates/ql-exec/src/calcgraph_session.rs:420:        ExprPlan::CellRef { .. } | ExprPlan::RangeRef { .. } => {}
crates/ql-exec/src/calcgraph_session.rs:520:    pub set_name: u64,
crates/ql-exec/src/calcgraph_session.rs:521:    pub add_sheet: u64,
crates/ql-exec/src/calcgraph_session.rs:563:    pub sheet: SheetId,
crates/ql-exec/src/calcgraph_session.rs:594:    pub fn cell_node_for(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<NodeId> {
crates/ql-exec/src/calcgraph_session.rs:601:    fn or_insert_cell_node(&mut self, sheet: SheetId, row: RowId, col: ColId) -> NodeId {
crates/ql-exec/src/calcgraph_session.rs:640:    /// occurrences. Phase 3.3 reads this from `on_set_name` to mark
crates/ql-exec/src/calcgraph_session.rs:673:        formula_sheet: SheetId,
crates/ql-exec/src/calcgraph_session.rs:776:        // the stripe map AND the `formula_to_range_deps` precision-check
crates/ql-exec/src/calcgraph_session.rs:904:            // the correct fallback for any range with `sheet: None`.
crates/ql-exec/src/calcgraph_session.rs:956:        // sheet-then-workbook scope chain fires; was `wb.names()`
crates/ql-exec/src/calcgraph_session.rs:975:    pub fn on_set_value(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-exec/src/calcgraph_session.rs:993:        sheet: SheetId,
crates/ql-exec/src/calcgraph_session.rs:1037:    /// (range deps in stripes + `formula_to_range_deps`). W5-50 wired
crates/ql-exec/src/calcgraph_session.rs:1043:    pub fn on_clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-exec/src/calcgraph_session.rs:1064:    /// `WorkbookRuntime::set_name`. Phase 3.3 (2026-05-12): marks all
crates/ql-exec/src/calcgraph_session.rs:1076:    pub fn on_set_name(&mut self, name: &str) {
crates/ql-exec/src/calcgraph_session.rs:1077:        self.hook_counts.set_name = self.hook_counts.set_name.saturating_add(1);
crates/ql-exec/src/calcgraph_session.rs:1103:    pub fn on_add_sheet(&mut self, _new_sheet: SheetId) {
crates/ql-exec/src/calcgraph_session.rs:1111:    /// the W5-91 / `on_set_name` H2 fix — directly-affected formulas
crates/ql-exec/src/calcgraph_session.rs:1235:        // 4. Dirty-fan (same pattern as on_table_drop / on_set_name).
crates/ql-exec/src/calcgraph_session.rs:1384:    fn mark_dirty_from_cell_write(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-exec/src/calcgraph_session.rs:1575:        anchor_sheet: SheetId,
crates/ql-exec/src/calcgraph_session.rs:1652:        // graph stores range deps in stripes + `formula_to_range_deps`
crates/ql-exec/src/calcgraph_session.rs:1654:        // must compress to ONE RangeRef, not 25M edges). For Tarjan we
crates/ql-exec/src/calcgraph_session.rs:1679:    /// `range_contains_rowcol` check. If profiling later shows pain,
crates/ql-exec/src/calcgraph_session.rs:1713:                    if range_contains_rowcol(range, gr, gc) && added.insert(g) {
crates/ql-exec/src/calcgraph_session.rs:1852:        s.on_set_name("Tax");
crates/ql-exec/src/calcgraph_session.rs:1853:        s.on_set_name("Discount");
crates/ql-exec/src/calcgraph_session.rs:1860:        assert_eq!(counts.set_name, 2);
crates/ql-exec/src/calcgraph_session.rs:1948:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:1950:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:1951:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:1993:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:1995:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:1996:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2075:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2082:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2095:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2116:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2118:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2119:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2202:    /// Phase 3.10 megaudit H2 regression: `on_set_name` must propagate
crates/ql-exec/src/calcgraph_session.rs:2207:    fn h2_set_name_propagates_dirty_transitively() {
crates/ql-exec/src/calcgraph_session.rs:2213:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2215:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2216:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2236:        s.on_set_name("Sales");
crates/ql-exec/src/calcgraph_session.rs:2255:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2323:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2325:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2326:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2404:        // 3.3 `range_to_rangeref` converter produces `RangeRef::
crates/ql-exec/src/calcgraph_session.rs:2407:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2409:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2410:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2419:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2421:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2422:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2431:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2433:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2434:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2513:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2515:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2516:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2538:        // map + formula_to_range_deps, not as Graph edges.
crates/ql-exec/src/calcgraph_session.rs:2581:    /// `on_set_name` fans out via `name_to_formulas` (Phase 3.2
crates/ql-exec/src/calcgraph_session.rs:2585:    fn set_name_dirties_all_referencing_formulas() {
crates/ql-exec/src/calcgraph_session.rs:2588:        wb.set_name(
crates/ql-exec/src/calcgraph_session.rs:2590:            ql_storage::NamedTarget::Range(Range {
crates/ql-exec/src/calcgraph_session.rs:2591:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2614:        s.on_set_name("discount"); // case-insensitive
crates/ql-exec/src/calcgraph_session.rs:2662:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2675:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2729:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2744:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2792:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2805:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2839:    /// appropriate `RangeRef` variant — `start_row: 0, end_row: MAX`
crates/ql-exec/src/calcgraph_session.rs:2850:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2874:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2947:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:2964:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3011:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3028:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3066:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3106:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3170:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3177:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3213:    /// registrations + `formula_to_range_deps` entry. Writes to the
crates/ql-exec/src/calcgraph_session.rs:3223:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3275:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3293:        // + formula_to_range_deps[A1] = [A1:A1] in place; a subsequent
crates/ql-exec/src/calcgraph_session.rs:3349:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3356:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3421:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3686:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3734:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3768:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3777:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3818:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3825:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3858:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3865:                sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3896:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3908:            sheet: 0,
crates/ql-exec/src/calcgraph_session.rs:3946:            sheet: 0,
crates/ql-storage/src/lib.rs:22://! enums (`NamedTarget`, `TotalsFunction`) are exhaustive by design;
crates/ql-storage/src/lib.rs:39:pub use sheet::{Bounds, Sheet};
crates/ql-storage/src/lib.rs:42:pub use workbook::{NameTable, NameTableError, NamedTarget, SheetNameError, Workbook};
crates/ql-storage/src/workbook.rs:6://!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
crates/ql-storage/src/workbook.rs:15:use crate::sheet::Sheet;
crates/ql-storage/src/workbook.rs:30:pub enum NamedTarget {
crates/ql-storage/src/workbook.rs:48:/// the parser, which already canonicalizes); `lookup_ci` exists as a
crates/ql-storage/src/workbook.rs:60:pub struct NameTable {
crates/ql-storage/src/workbook.rs:61:    entries: HashMap<Arc<str>, NamedTarget>,
crates/ql-storage/src/workbook.rs:73:/// `wb.set_name("AI", NamedTarget::Constant(...))` then writing `=AI` bypassed
crates/ql-storage/src/workbook.rs:79:pub enum NameTableError {
crates/ql-storage/src/workbook.rs:110:/// here cannot be registered via `NameTable::set` or `Workbook::set_name`.
crates/ql-storage/src/workbook.rs:174:        target: NamedTarget,
crates/ql-storage/src/workbook.rs:187:        // column→range and `A1` as a cell → `RangeRef × CellRef`
crates/ql-storage/src/workbook.rs:189:        // shared with HIGH-1 (literal RangeRef in non-Function
crates/ql-storage/src/workbook.rs:219:    /// `WorkbookRuntime::set_name` wrapper run validate-then-append-then-
crates/ql-storage/src/workbook.rs:237:    /// External callers should prefer `lookup_ci` unless they've already
crates/ql-storage/src/workbook.rs:239:    pub fn lookup(&self, name: &str) -> Option<NamedTarget> {
crates/ql-storage/src/workbook.rs:246:    pub fn lookup_ci(&self, name: &str) -> Option<NamedTarget> {
crates/ql-storage/src/workbook.rs:260:    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &NamedTarget)> + '_ {
crates/ql-storage/src/workbook.rs:467:    /// `formula_cells` and `NamedTarget::Formula` entries continue to
crates/ql-storage/src/workbook.rs:500:        // Swap the name. `Sheet::set_name` is private; mutate through
crates/ql-storage/src/workbook.rs:503:            sheet.set_name(new_name);
crates/ql-storage/src/workbook.rs:578:        sheet: SheetId,
crates/ql-storage/src/workbook.rs:594:    /// attached `OpLog` must go through `ql_exec::WorkbookRuntime::set_name`
crates/ql-storage/src/workbook.rs:595:    /// instead. Direct `Workbook::set_name` callers are: (a) the qbook
crates/ql-storage/src/workbook.rs:599:    pub fn set_name(&mut self, name: &str, target: NamedTarget) -> Result<(), NameTableError> {
crates/ql-storage/src/workbook.rs:625:                "Workbook::add_sheet: name validation failed (empty / duplicate / reserved char)",
crates/ql-storage/src/workbook.rs:697:        sheet: SheetId,
crates/ql-storage/src/workbook.rs:710:        sheet: SheetId,
crates/ql-storage/src/workbook.rs:816:    pub fn put_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
crates/ql-storage/src/workbook.rs:830:    pub fn put_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
crates/ql-storage/src/workbook.rs:843:    pub fn clear_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-storage/src/workbook.rs:853:    pub fn clear_user_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-storage/src/workbook.rs:878:        sheet: SheetId,
crates/ql-storage/src/workbook.rs:914:    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-storage/src/workbook.rs:920:    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
crates/ql-storage/src/workbook.rs:996:        assert!(wb.names().lookup("MyName").is_none());
crates/ql-storage/src/workbook.rs:997:        assert!(wb.names().lookup_ci("MyName").is_none());
crates/ql-storage/src/workbook.rs:1002:    /// target)` and `Workbook::set_name("MIXEDCASE", target)` produce the same
crates/ql-storage/src/workbook.rs:1004:    /// on canonical form) and `lookup_ci` (case-insensitive query).
crates/ql-storage/src/workbook.rs:1008:        let target = NamedTarget::Constant(Value::Number(0.21));
crates/ql-storage/src/workbook.rs:1013:        assert!(wb.names().lookup("MIXEDCASE").is_some());
crates/ql-storage/src/workbook.rs:1015:        assert!(wb.names().lookup("MixedCase").is_none());
crates/ql-storage/src/workbook.rs:1016:        // … but lookup_ci uppercases the query and does.
crates/ql-storage/src/workbook.rs:1017:        assert!(wb.names().lookup_ci("MixedCase").is_some());
crates/ql-storage/src/workbook.rs:1018:        assert!(wb.names().lookup_ci("mixedcase").is_some());
crates/ql-storage/src/workbook.rs:1020:        // Path B: convenience set_name accepts any case and produces the same
crates/ql-storage/src/workbook.rs:1022:        wb.set_name("anothername", target.clone()).unwrap();
crates/ql-storage/src/workbook.rs:1023:        assert!(wb.names().lookup("ANOTHERNAME").is_some());
crates/ql-storage/src/workbook.rs:1027:        assert!(wb.names().lookup_ci("MixedCase").is_none());
crates/ql-storage/src/workbook.rs:1029:        assert!(wb.names().lookup_ci("anothername").is_none());
crates/ql-storage/src/workbook.rs:1035:        let cell = NamedTarget::Cell(Address::new(0, 0, 0));
crates/ql-storage/src/workbook.rs:1036:        let rng = NamedTarget::Range(ql_types::Range::new(0, 0, 0, 9, 0));
crates/ql-storage/src/workbook.rs:1037:        let con = NamedTarget::Constant(Value::Number(0.21));
crates/ql-storage/src/workbook.rs:1038:        let frm = NamedTarget::Formula(std::sync::Arc::from("=A1+B1"));
crates/ql-storage/src/workbook.rs:1208:    /// `Workbook::set_name("AI", ...)` is refused — the AI sentinel per
crates/ql-storage/src/workbook.rs:1211:    fn set_name_rejects_reserved_ai_canonical_upper() {
crates/ql-storage/src/workbook.rs:1213:        let result = wb.set_name("AI", NamedTarget::Constant(Value::Number(42.0)));
crates/ql-storage/src/workbook.rs:1219:        assert!(wb.names().is_empty());
crates/ql-storage/src/workbook.rs:1222:    /// Case-insensitive: `Workbook::set_name("ai", ...)` also refused (the
crates/ql-storage/src/workbook.rs:1225:    fn set_name_rejects_reserved_ai_case_insensitive() {
crates/ql-storage/src/workbook.rs:1227:        let result = wb.set_name("ai", NamedTarget::Constant(Value::Number(42.0)));
crates/ql-storage/src/workbook.rs:1229:        let result_mixed = wb.set_name("Ai", NamedTarget::Constant(Value::Number(42.0)));
crates/ql-storage/src/workbook.rs:1235:    fn set_name_accepts_non_reserved() {
crates/ql-storage/src/workbook.rs:1237:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-storage/src/workbook.rs:1239:        assert!(wb.names().lookup("TAXRATE").is_some());
crates/ql-storage/src/workbook.rs:1342:    fn validate_sheet_name_accepts_valid_names() {
crates/ql-exec/src/aggregate_cache.rs:117:    pub fn invalidate_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-exec/src/aggregate_cache.rs:170:    fn mk_range(sheet: SheetId, sr: RowId, sc: ColId, er: RowId, ec: ColId) -> Range {
crates/ql-storage/src/spill.rs:92:        sheet: SheetId,
crates/ql-storage/src/spill.rs:95:        anchor_sheet: SheetId,
crates/ql-storage/src/spill.rs:109:        sheet: SheetId,
crates/ql-storage/src/spill.rs:136:        sheet: SheetId,
crates/ql-storage/src/spill.rs:148:    pub sheet: SheetId,
crates/ql-storage/src/spill.rs:173:    pub fn anchor_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&SpillShape> {
crates/ql-storage/src/spill.rs:184:        sheet: SheetId,
crates/ql-storage/src/spill.rs:229:                sheet: asheet,
crates/ql-storage/src/spill.rs:239:                sheet: asheet,
crates/ql-storage/src/spill.rs:254:                        sheet: cell.0,
crates/ql-storage/src/spill.rs:257:                        anchor_sheet: existing_anchor.0,
crates/ql-storage/src/spill.rs:300:            sheet: anchor.0,
crates/ql-storage/src/spill.rs:482:                sheet: 0,
crates/ql-exec/src/scalar.rs:86:        ExprPlan::RangeRef { .. } => Value::Error(ErrorValue::Calc),
crates/ql-exec/src/scalar.rs:472:        // (e.g., a stray RangeRef arg to a non-reference-aware fn that
crates/ql-exec/src/scalar.rs:475:        // context that produces `ExprPlan::RangeRef`.
crates/ql-exec/src/scalar.rs:476:        ExprPlan::RangeRef { .. } => Value::Error(ErrorValue::Calc),
crates/ql-exec/src/scalar.rs:545:/// Coordinate-only path for `AggregateNameRef`/`RangeRef`/`StructuredRef`:
crates/ql-exec/src/scalar.rs:601:        ExprPlan::RangeRef { range } => RefArg::Range {
crates/ql-exec/src/scalar.rs:652:        | ExprPlan::RangeRef { .. }
crates/ql-exec/src/scalar.rs:653:        | ExprPlan::StructuredRef { .. } => PlanKind::RangeRef,
crates/ql-exec/src/scalar.rs:842:        // RangeRef / AggregateNameRef / Array; `ROW(Sales[Qty])` bypassed
crates/ql-exec/src/scalar.rs:857:                ExprPlan::RangeRef { range } => {
crates/ql-exec/src/scalar.rs:1084:            sheet: SheetRef::Current,
crates/ql-exec/src/scalar.rs:1766:                sheet: ql_types::SheetId,
crates/ql-exec/src/plan.rs:5://! `bind()` walks the Expr tree and resolves every `CellAddr.sheet: Option<SheetId>` to a
crates/ql-exec/src/plan.rs:24://! - `RangeRef` — single range used inside a Function call (e.g. `SUM(A:A)`)
crates/ql-exec/src/plan.rs:48:        sheet: SheetId,
crates/ql-exec/src/plan.rs:71:    /// Phase 2B.4 (2026-05-12): a `NameRef` resolving to a `NamedTarget::Range`
crates/ql-exec/src/plan.rs:119:    /// from `Expr::RangeRef` in `BindContext::ReferenceArg`. Carries the
crates/ql-exec/src/plan.rs:124:    /// that reaches this variant today is `Expr::RangeRef` bound in
crates/ql-exec/src/plan.rs:126:    RangeRef {
crates/ql-exec/src/plan.rs:165:/// `NamedTargetIs{Blank,Error}`; Phase 2A.11 audit M16 switched to
crates/ql-exec/src/plan.rs:173:    /// - `Expr::RangeRef` outside a Function context (Phase 4+ region binder).
crates/ql-exec/src/plan.rs:175:    /// - `NamedTarget::Range` in scalar position (lands on the more
crates/ql-exec/src/plan.rs:191:    /// A `NameRef` resolved to a `NamedTarget::Constant(Value::Blank)`. Phase 2A.6
crates/ql-exec/src/plan.rs:196:    NamedTargetIsBlank(Arc<str>),
crates/ql-exec/src/plan.rs:197:    /// A `NameRef` resolved to a `NamedTarget::Constant(Value::Error(_))`. Phase 2A.6
crates/ql-exec/src/plan.rs:209:    NamedTargetIsError(Arc<str>, ErrorValue),
crates/ql-exec/src/plan.rs:210:    /// Phase 2B.4 (2026-05-12): a `NameRef` resolving to a `NamedTarget::Range`
crates/ql-exec/src/plan.rs:223:    /// `NamedTarget::Formula` in a scalar-context position. Named formulas
crates/ql-exec/src/plan.rs:357:/// per-name-ref decisions about whether a `NamedTarget::Range` is acceptable
crates/ql-exec/src/plan.rs:377:    /// (NEW) accepts literal `Expr::RangeRef` lowering to
crates/ql-exec/src/plan.rs:378:    /// `ExprPlan::RangeRef { range }`. CellRef args bind as
crates/ql-exec/src/plan.rs:379:    /// `ExprPlan::CellRef` unchanged. The scope of the `RangeRef`
crates/ql-exec/src/plan.rs:384:    /// range-aware / unified) would also need new `RangeRef` arms.
crates/ql-exec/src/plan.rs:544:/// - `Expr::RangeRef` → `ExprPlan::RangeRef { range }` (NEW; the only context
crates/ql-exec/src/plan.rs:546:/// - `Expr::NameRef` resolving to a `NamedTarget::Range` →
crates/ql-exec/src/plan.rs:579:pub fn bind(expr: &Expr, owning_sheet: SheetId) -> Result<ExprPlan, BindError> {
crates/ql-exec/src/plan.rs:590:    owning_sheet: SheetId,
crates/ql-exec/src/plan.rs:598:/// `CalcgraphSession`) pass `self.workbook.names()` for `names` and
crates/ql-exec/src/plan.rs:610:    owning_sheet: SheetId,
crates/ql-exec/src/plan.rs:617:            sheet: owning_sheet,
crates/ql-exec/src/plan.rs:634:    pub sheet: SheetId,
crates/ql-exec/src/plan.rs:640:    pub fn sheet_only(sheet: SheetId) -> Self {
crates/ql-exec/src/plan.rs:647:            sheet: addr.sheet,
crates/ql-exec/src/plan.rs:685:    owning_sheet: SheetId,
crates/ql-exec/src/plan.rs:715:            sheet: resolve_sheet_ref(&addr.sheet, owning_sheet, sheets)?,
crates/ql-exec/src/plan.rs:754:        Expr::RangeRef(rr) => {
crates/ql-exec/src/plan.rs:757:            // — they lower to `ExprPlan::RangeRef { range }`. Outside that
crates/ql-exec/src/plan.rs:763:            // would also need new `ExprPlan::RangeRef` handling, which is
crates/ql-exec/src/plan.rs:768:                Ok(ExprPlan::RangeRef { range })
crates/ql-exec/src/plan.rs:771:                    "literal RangeRef in non-Function context is unsupported in v1; \
crates/ql-exec/src/plan.rs:776:                     RangeRef support inside reference-aware fn arg lists only.)",
crates/ql-exec/src/plan.rs:782:            // `ReferenceArg` context (literal RangeRef + range NameRef both
crates/ql-exec/src/plan.rs:914:                Some(ResolvedName::Blank) => Err(BindError::NamedTargetIsBlank(name.clone())),
crates/ql-exec/src/plan.rs:916:                    Err(BindError::NamedTargetIsError(name.clone(), e))
crates/ql-exec/src/plan.rs:954:                sheet: resolve_sheet_ref(sheet, owning_sheet, sheets)?,
crates/ql-exec/src/plan.rs:1007:    owning_sheet: SheetId,
crates/ql-exec/src/plan.rs:1051:        Expr::RangeRef(rr) => {
crates/ql-exec/src/plan.rs:1125:/// `RangeRef` inner with a formula-cell anchor (`site.cell`).
crates/ql-exec/src/plan.rs:1127:    rr: &ql_formula_syntax::RangeRef,
crates/ql-exec/src/plan.rs:1128:    owning_sheet: SheetId,
crates/ql-exec/src/plan.rs:1132:    use ql_formula_syntax::RangeRef;
crates/ql-exec/src/plan.rs:1137:        RangeRef::Cells {
crates/ql-exec/src/plan.rs:1154:                    sheet: sheet_id,
crates/ql-exec/src/plan.rs:1164:                            sheet: sheet_id,
crates/ql-exec/src/plan.rs:1180:                            sheet: sheet_id,
crates/ql-exec/src/plan.rs:1195:        RangeRef::WholeColumn {
crates/ql-exec/src/plan.rs:1206:                    sheet: sheet_id,
crates/ql-exec/src/plan.rs:1219:        RangeRef::WholeRow {
crates/ql-exec/src/plan.rs:1229:                    sheet: sheet_id,
crates/ql-exec/src/plan.rs:1242:        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
crates/ql-exec/src/plan.rs:1243:            "RangeRef::R1C1Cells inside @ is parser-intermediate; storage canon \
crates/ql-exec/src/plan.rs:1305:/// Variant describing a resolved name's target, mapped from `ql_storage::NamedTarget`.
crates/ql-exec/src/plan.rs:1307:/// import ql-storage directly, so the lookup trait projects NamedTarget into this
crates/ql-exec/src/plan.rs:1320:    /// `NamedTarget::Range(_)` resolved with payload. Phase 2B.4 (2026-05-12):
crates/ql-exec/src/plan.rs:1325:    /// `NamedTarget::Formula(_)` resolved with payload. Phase 2B.4 added the
crates/ql-exec/src/plan.rs:1329:    /// `NamedTarget::Constant(Value::Blank)`. The binder rejects this loudly so
crates/ql-exec/src/plan.rs:1332:    /// `NamedTarget::Constant(Value::Error(...))`. The binder rejects with a
crates/ql-exec/src/plan.rs:1346:    fn lookup_named_target(&self, name: &str, owning_sheet: SheetId) -> Option<ResolvedName>;
crates/ql-exec/src/plan.rs:1354:    fn lookup_named_target(&self, _name: &str, _owning_sheet: SheetId) -> Option<ResolvedName> {
crates/ql-exec/src/plan.rs:1369:/// Default empty-resolver. Used by the legacy `bind()` / `bind_with_names()`
crates/ql-exec/src/plan.rs:1659:        Expr::RangeRef(_) => "RangeRef",
crates/ql-exec/src/plan.rs:1681:    sheet: &SheetRef,
crates/ql-exec/src/plan.rs:1682:    owning_sheet: SheetId,
crates/ql-exec/src/plan.rs:1694:/// **W5-RT-1 (RT-V1-01):** resolve `Expr::RangeRef` to a [`Range`] WITHOUT
crates/ql-exec/src/plan.rs:1700:    rr: &ql_formula_syntax::RangeRef,
crates/ql-exec/src/plan.rs:1701:    owning_sheet: SheetId,
crates/ql-exec/src/plan.rs:1704:    use ql_formula_syntax::RangeRef;
crates/ql-exec/src/plan.rs:1706:        RangeRef::Cells {
crates/ql-exec/src/plan.rs:1719:        RangeRef::WholeColumn {
crates/ql-exec/src/plan.rs:1728:        RangeRef::WholeRow {
crates/ql-exec/src/plan.rs:1737:        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
crates/ql-exec/src/plan.rs:1738:            "RangeRef::R1C1Cells in reference-aware fn arg is parser-intermediate; \
crates/ql-exec/src/plan.rs:1747:    use ql_formula_syntax::{CellAddr, RangeRef, SheetRef};
crates/ql-exec/src/plan.rs:1878:            sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:1888:                sheet: 7,
crates/ql-exec/src/plan.rs:1901:            sheet: SheetRef::Id(2),
crates/ql-exec/src/plan.rs:1908:        assert!(matches!(p, ExprPlan::CellRef { sheet: 2, .. }));
crates/ql-exec/src/plan.rs:1917:                sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:1932:                assert!(matches!(*lhs, ExprPlan::CellRef { sheet: 0, .. }));
crates/ql-exec/src/plan.rs:1957:        let expr = Expr::RangeRef(RangeRef::WholeColumn {
crates/ql-exec/src/plan.rs:1958:            sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:1996:                    sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:2003:                    sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:2017:                        sheet: 7,
crates/ql-exec/src/plan.rs:2026:                        sheet: 7,
crates/ql-exec/src/plan.rs:2062:            sheet: SheetRef::Name(Arc::from("Sheet2")),
crates/ql-exec/src/plan.rs:2079:            sheet: SheetRef::Name(Arc::from("sheet1")),
crates/ql-exec/src/plan.rs:2096:            sheet: SheetRef::Name(Arc::from("Nonexistent")),
crates/ql-exec/src/plan.rs:2111:    fn bind_empty_sheet_resolver_rejects_all_sheet_names() {
crates/ql-exec/src/plan.rs:2112:        // The legacy `bind()` / `bind_with_names()` entry points use an
crates/ql-exec/src/plan.rs:2115:            sheet: SheetRef::Name(Arc::from("AnySheet")),
crates/ql-exec/src/plan.rs:2128:            sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:2149:                sheet: SheetRef::Name(Arc::from("Sheet2")),
crates/ql-exec/src/plan.rs:2236:                sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:2395:            sheet: 0,
crates/ql-exec/src/plan.rs:2666:            sheet: SheetRef::Current,
crates/ql-exec/src/plan.rs:2700:                sheet: 0,
crates/ql-exec/src/plan.rs:2733:                sheet: 0,
crates/ql-exec/src/plan.rs:2763:                sheet: 0,
crates/ql-exec/src/plan.rs:2787:                sheet: 0,
crates/ql-exec/src/plan.rs:2843:                sheet: 0,
crates/ql-exec/src/plan.rs:2865:                sheet: 0,
crates/ql-exec/src/plan.rs:2881:    /// `CellRef { sheet: 7, .. }`.
crates/ql-exec/src/plan.rs:2895:            sheet: SheetRef::Name(Arc::from("Sheet1")),
crates/ql-exec/src/plan.rs:2902:                sheet: 0,
crates/ql-exec/src/plan.rs:2922:            sheet: SheetRef::Name(Arc::from("Missing")),
crates/ql-exec/src/plan.rs:2993:                sheet: 0,
crates/ql-exec/src/plan.rs:3008:                sheet: 0,
crates/ql-exec/src/plan.rs:3023:                sheet: 0,
crates/ql-exec/src/plan.rs:3045:                sheet: 0,
crates/ql-exec/src/plan.rs:3066:                sheet: 0,
crates/ql-exec/src/plan.rs:3082:                sheet: 0,
crates/ql-exec/src/plan.rs:3103:                sheet: 0,
crates/ql-exec/src/plan.rs:3118:                sheet: 0,
crates/ql-exec/src/plan.rs:3133:                sheet: 0,
crates/ql-exec/src/plan.rs:3154:                sheet: 0,
crates/ql-exec/src/plan.rs:3175:                sheet: 0,
crates/ql-exec/src/plan.rs:3196:                sheet: 0,
crates/ql-exec/src/plan.rs:3211:                sheet: 0,
crates/ql-exec/src/plan.rs:3227:                sheet: 0,
crates/ql-exec/src/plan.rs:3249:                sheet: 0,
crates/ql-exec/src/plan.rs:3285:                sheet: 0,
crates/ql-exec/src/plan.rs:3319:                sheet: 0,
crates/ql-exec/src/plan.rs:3352:                sheet: 0,
crates/ql-exec/src/simd.rs:249:                    sheet: 0,
crates/ql-exec/src/lib.rs:10://!   `NamedTargetIs{Blank,Error}`, `NamedRangeInScalarContext`,
crates/ql-exec/src/lib.rs:40://!   producer wrappers (`set_name` / `add_sheet` / `clear_formula`)
crates/ql-exec/src/transaction.rs:62:        sheet: SheetId,
crates/ql-exec/src/transaction.rs:68:        sheet: SheetId,
crates/ql-exec/src/transaction.rs:160:        sheet: SheetId,
crates/ql-exec/src/transaction.rs:198:        sheet: SheetId,
crates/ql-exec/src/transaction.rs:216:        // sheet-then-workbook scope chain fires; was `self.workbook.names()`
crates/ql-exec/src/transaction.rs:241:        sheet: SheetId,
crates/ql-exec/src/transaction.rs:305:                                sheet: *sheet,
crates/ql-exec/src/transaction.rs:314:                                sheet: *sheet,
crates/ql-exec/src/transaction.rs:328:                            sheet: *sheet,
crates/ql-exec/src/transaction.rs:403:    use ql_storage::NamedTarget;
crates/ql-exec/src/transaction.rs:631:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/transaction.rs:715:                    sheet: 5,
crates/ql-exec/src/transaction.rs:736:                    sheet: 0,
crates/ql-exec/src/transaction.rs:797:        wb.set_name("MyBlank", NamedTarget::Constant(Value::Blank))
crates/ql-exec/src/transaction.rs:804:            Err(RuntimeError::Bind(BindError::NamedTargetIsBlank(name))) => {
crates/ql-exec/src/transaction.rs:808:            other => panic!("expected Bind(NamedTargetIsBlank), got {other:?}"),
crates/ql-exec/src/transaction.rs:816:        wb.set_name(
crates/ql-exec/src/transaction.rs:818:            NamedTarget::Constant(Value::Error(ErrorValue::DivZero)),
crates/ql-exec/src/transaction.rs:826:            Err(RuntimeError::Bind(BindError::NamedTargetIsError(name, err))) => {
crates/ql-exec/src/transaction.rs:830:            other => panic!("expected Bind(NamedTargetIsError), got {other:?}"),
crates/ql-exec/src/env.rs:16:use ql_storage::{NameTable, NamedTarget};
crates/ql-exec/src/env.rs:25:    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value;
crates/ql-exec/src/env.rs:169:    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value {
crates/ql-exec/src/env.rs:308:    fn is_formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> bool {
crates/ql-exec/src/env.rs:312:    fn formula_text_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<String> {
crates/ql-exec/src/env.rs:334:    pub fn put(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
crates/ql-exec/src/env.rs:340:    fn read_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Value {
crates/ql-exec/src/env.rs:353:// Phase 2A.6 audit H2: use `lookup_ci` so the binder is robust against callers
crates/ql-exec/src/env.rs:366:        _owning_sheet: ql_types::SheetId,
crates/ql-exec/src/env.rs:368:        named_target_to_resolved(self.lookup_ci(name)?)
crates/ql-exec/src/env.rs:383:/// passed `self.workbook.names()` get workbook-only behavior (no chain
crates/ql-exec/src/env.rs:389:        owning_sheet: ql_types::SheetId,
crates/ql-exec/src/env.rs:393:            if let Some(target) = sheet.scoped_names().lookup_ci(name) {
crates/ql-exec/src/env.rs:398:        named_target_to_resolved(self.names().lookup_ci(name)?)
crates/ql-exec/src/env.rs:425:/// Project a `NamedTarget` into the binder-side `ResolvedName` vocabulary. Phase
crates/ql-exec/src/env.rs:430:fn named_target_to_resolved(target: NamedTarget) -> Option<ResolvedName> {
crates/ql-exec/src/env.rs:432:        NamedTarget::Cell(addr) => Some(ResolvedName::Cell(
crates/ql-exec/src/env.rs:434:            // NamedTarget::Cell stores Address (sheet/row/col) but not abs flags.
crates/ql-exec/src/env.rs:439:        NamedTarget::Constant(Value::Number(n)) => Some(ResolvedName::Number(n)),
crates/ql-exec/src/env.rs:440:        NamedTarget::Constant(Value::Boolean(b)) => Some(ResolvedName::Bool(b)),
crates/ql-exec/src/env.rs:441:        NamedTarget::Constant(Value::Text(s)) => Some(ResolvedName::Text(s)),
crates/ql-exec/src/env.rs:442:        NamedTarget::Constant(Value::Blank) => Some(ResolvedName::Blank),
crates/ql-exec/src/env.rs:443:        NamedTarget::Constant(Value::Error(e)) => Some(ResolvedName::ErrorValue(e)),
crates/ql-exec/src/env.rs:447:        NamedTarget::Range(range) => Some(ResolvedName::Range(range)),
crates/ql-exec/src/env.rs:448:        NamedTarget::Formula(text) => Some(ResolvedName::Formula(text)),
crates/ql-exec/src/env.rs:530:        wb.set_name("R", NamedTarget::Constant(Value::Number(0.5)))
crates/ql-exec/src/env.rs:542:            .set_scoped_name("R", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/env.rs:555:        wb.set_name("R", NamedTarget::Constant(Value::Number(0.05)))
crates/ql-exec/src/env.rs:559:            .set_scoped_name("R", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/env.rs:592:        wb.set_name("R", NamedTarget::Constant(Value::Number(7.0)))
crates/ql-exec/src/plan_cache.rs:71:    pub sheet: SheetId,
crates/ql-exec/src/plan_cache.rs:188:    fn key(text: &str, sheet: SheetId, name_gen: u64) -> PlanCacheKey {
crates/ql-exec/src/workbook_runtime.rs:58:pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime.rs:116:    sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:174:    InvalidSheet { sheet: SheetId, sheet_count: usize },
crates/ql-exec/src/workbook_runtime.rs:181:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:192:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:206:    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
crates/ql-exec/src/workbook_runtime.rs:319:    pub sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:537:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:600:        let name_gen = self.workbook.names().generation();
crates/ql-exec/src/workbook_runtime.rs:954:        anchor_sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:1005:            let name_gen = self.workbook.names().generation();
crates/ql-exec/src/workbook_runtime.rs:1015:                sheet: reader_sheet,
crates/ql-exec/src/workbook_runtime.rs:1104:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:1231:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:1250:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:1431:    /// op-log-recording wrapper for `Workbook::set_name`; product code SHOULD
crates/ql-exec/src/workbook_runtime.rs:1434:    /// Direct callers of `Workbook::set_name` bypass the op log silently —
crates/ql-exec/src/workbook_runtime.rs:1439:    pub fn set_name(
crates/ql-exec/src/workbook_runtime.rs:1442:        target: ql_storage::NamedTarget,
crates/ql-exec/src/workbook_runtime.rs:1460:        self.workbook.names().would_accept(name)?;
crates/ql-exec/src/workbook_runtime.rs:1462:            let target_wire = ql_io::NamedTargetWire::from_target(&target);
crates/ql-exec/src/workbook_runtime.rs:1470:        // `set_name` returns Result for forward-compat with future
crates/ql-exec/src/workbook_runtime.rs:1473:        self.workbook.set_name(name, target)?;
crates/ql-exec/src/workbook_runtime.rs:1478:            g.on_set_name(name);
crates/ql-exec/src/workbook_runtime.rs:1490:    /// Validation matches `set_name`:
crates/ql-exec/src/workbook_runtime.rs:1500:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:1502:        target: ql_storage::NamedTarget,
crates/ql-exec/src/workbook_runtime.rs:1513:        self.workbook.names().would_accept(name)?;
crates/ql-exec/src/workbook_runtime.rs:1516:            let target_wire = ql_io::NamedTargetWire::from_target(&target);
crates/ql-exec/src/workbook_runtime.rs:1535:            g.on_set_name(name);
crates/ql-exec/src/workbook_runtime.rs:1579:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:1644:        if self.workbook.names().lookup_ci(&canonical).is_some() {
crates/ql-exec/src/workbook_runtime.rs:1855:        if self.workbook.names().lookup_ci(&new_canonical).is_some() {
crates/ql-exec/src/workbook_runtime.rs:1897:                    sheet: s,
crates/ql-exec/src/workbook_runtime.rs:2044:                    sheet: s,
crates/ql-exec/src/workbook_runtime.rs:2368:            let name_gen = self.workbook.names().generation();
crates/ql-exec/src/workbook_runtime.rs:2477:    /// stored formula in `formula_cells` and every `NamedTarget::Formula`
crates/ql-exec/src/workbook_runtime.rs:2508:                sheet: id,
crates/ql-exec/src/workbook_runtime.rs:2531:        // (Phase 4.6.D / future): walk NamedTarget::Formula entries for
crates/ql-exec/src/workbook_runtime.rs:2542:                    sheet: *s,
crates/ql-exec/src/workbook_runtime.rs:2592:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:2754:        // matching set_name / set_value).
crates/ql-exec/src/workbook_runtime.rs:2781:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:2852:    pub fn read_display(&mut self, sheet: SheetId, row: RowId, col: ColId) -> String {
crates/ql-exec/src/workbook_runtime.rs:2945:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:3403:                                let name_gen = self.workbook.names().generation();
crates/ql-exec/src/workbook_runtime.rs:3413:                                    sheet: reader_sheet,
crates/ql-exec/src/workbook_runtime.rs:3505:                sheet: 0,
crates/ql-exec/src/workbook_runtime.rs:3541:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:3566:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:3585:        sheet: SheetId,
crates/ql-exec/src/workbook_runtime.rs:3591:        let name_gen = self.workbook.names().generation();
crates/ql-exec/src/workbook_runtime.rs:3609:        // (for `names()` inside the closure) while holding a mutable
crates/ql-exec/src/workbook_runtime.rs:3986:                    sheet: 5,
crates/ql-exec/src/workbook_runtime.rs:4144:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4150:        wb.set_name("MyRef", NamedTarget::Cell(Address::new(0, 0, 0)))
crates/ql-exec/src/workbook_runtime.rs:4163:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4167:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:4178:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4181:        wb.set_name("UseFancy", NamedTarget::Constant(Value::Boolean(true)))
crates/ql-exec/src/workbook_runtime.rs:4194:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4197:        wb.set_name("Greeting", NamedTarget::Constant(Value::text("hello")))
crates/ql-exec/src/workbook_runtime.rs:4282:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4286:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
crates/ql-exec/src/workbook_runtime.rs:4303:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4306:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:4324:    fn set_name_uppercases_for_canonical_lookup() {
crates/ql-exec/src/workbook_runtime.rs:4325:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4330:        wb.set_name("MixedCaseName", NamedTarget::Constant(Value::Number(5.0)))
crates/ql-exec/src/workbook_runtime.rs:4891:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:4909:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:4923:        let old_gen = wb.names().generation();
crates/ql-exec/src/workbook_runtime.rs:4924:        wb.set_name("ExtraName", NamedTarget::Constant(Value::Number(1.0)))
crates/ql-exec/src/workbook_runtime.rs:4927:            wb.names().generation() > old_gen,
crates/ql-exec/src/workbook_runtime.rs:5024:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5029:        wb.set_name("MyConstant", NamedTarget::Constant(Value::Number(0.42)))
crates/ql-exec/src/workbook_runtime.rs:5049:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5053:        wb.set_name("MyRef", NamedTarget::Cell(Address::new(0, 0, 0)))
crates/ql-exec/src/workbook_runtime.rs:5075:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5078:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
crates/ql-exec/src/workbook_runtime.rs:5101:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5104:        wb.set_name("Block", NamedTarget::Range(Range::new(0, 0, 0, 5, 5)))
crates/ql-exec/src/workbook_runtime.rs:5134:    /// Named formulas (NamedTarget::Formula) surface a distinct
crates/ql-exec/src/workbook_runtime.rs:5139:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5144:                NamedTarget::Formula(std::sync::Arc::from("Revenue - Costs")),
crates/ql-exec/src/workbook_runtime.rs:5199:                    sheet: 99,
crates/ql-exec/src/workbook_runtime.rs:5453:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5460:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
crates/ql-exec/src/workbook_runtime.rs:5475:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5482:        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
crates/ql-exec/src/workbook_runtime.rs:5518:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5530:        wb.set_name("XValues", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
crates/ql-exec/src/workbook_runtime.rs:5532:        wb.set_name("YValues", NamedTarget::Range(Range::new(0, 0, 1, 3, 1)))
crates/ql-exec/src/workbook_runtime.rs:5572:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5580:        wb.set_name("XData", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
crates/ql-exec/src/workbook_runtime.rs:5582:        wb.set_name("YData", NamedTarget::Range(Range::new(0, 0, 1, 2, 1)))
crates/ql-exec/src/workbook_runtime.rs:5631:        for &name in reg.range_aware_names() {
crates/ql-exec/src/workbook_runtime.rs:5658:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5661:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
crates/ql-exec/src/workbook_runtime.rs:5679:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5682:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
crates/ql-exec/src/workbook_runtime.rs:5723:    /// OPL-2B-01 (part 1): `WorkbookRuntime::set_name` records `Op::SetName`
crates/ql-exec/src/workbook_runtime.rs:5726:    /// `Workbook::set_name` (no recording).
crates/ql-exec/src/workbook_runtime.rs:5728:    fn runtime_set_name_emits_op_into_attached_oplog() {
crates/ql-exec/src/workbook_runtime.rs:5730:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5736:            rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:5741:            wb.names().lookup_ci("TaxRate"),
crates/ql-exec/src/workbook_runtime.rs:5742:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
crates/ql-exec/src/workbook_runtime.rs:5757:                // Wire form is NamedTargetWire::Constant for a constant target.
crates/ql-exec/src/workbook_runtime.rs:5758:                assert!(matches!(target, ql_io::NamedTargetWire::Constant { .. }));
crates/ql-exec/src/workbook_runtime.rs:5854:    fn runtime_set_name_add_sheet_clear_formula_work_without_oplog() {
crates/ql-exec/src/workbook_runtime.rs:5855:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5862:        rt.set_name("MyValue", NamedTarget::Constant(Value::Number(7.0)))
crates/ql-exec/src/workbook_runtime.rs:5879:    /// OPL-2B-01 (reserved name): `WorkbookRuntime::set_name` propagates
crates/ql-exec/src/workbook_runtime.rs:5882:    /// for set_name specifically because NameTable::set has its own failure
crates/ql-exec/src/workbook_runtime.rs:5885:    fn runtime_set_name_reserved_name_does_not_append_op() {
crates/ql-exec/src/workbook_runtime.rs:5887:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5893:            rt.set_name("AI", NamedTarget::Constant(Value::Number(0.0)))
crates/ql-exec/src/workbook_runtime.rs:5902:            "rejected set_name must not leave a ghost op in the log; got {} ops",
crates/ql-exec/src/workbook_runtime.rs:5914:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:5922:            rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:5960:            replay_wb.names().lookup_ci("TaxRate"),
crates/ql-exec/src/workbook_runtime.rs:5961:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
crates/ql-exec/src/workbook_runtime.rs:5997:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:6015:            // set_name → on_set_name
crates/ql-exec/src/workbook_runtime.rs:6016:            rt.set_name("Rate", NamedTarget::Constant(Value::Number(0.5)))
crates/ql-exec/src/workbook_runtime.rs:6030:        assert_eq!(counts.set_name, 1);
crates/ql-exec/src/workbook_runtime.rs:6452:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:6458:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:6460:            NamedTarget::Range(Range::new(0, 0, 0, size - 1, 0)),
crates/ql-exec/src/workbook_runtime.rs:6476:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:6482:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
crates/ql-exec/src/workbook_runtime.rs:6600:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:6607:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:6609:            NamedTarget::Range(Range {
crates/ql-exec/src/workbook_runtime.rs:6610:                sheet: 0,
crates/ql-exec/src/workbook_runtime.rs:6981:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:6987:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
crates/ql-exec/src/workbook_runtime.rs:7042:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7050:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
crates/ql-exec/src/workbook_runtime.rs:7062:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7069:        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
crates/ql-exec/src/workbook_runtime.rs:7080:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7088:        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
crates/ql-exec/src/workbook_runtime.rs:7101:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7117:        wb.set_name("Labels", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
crates/ql-exec/src/workbook_runtime.rs:7119:        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 1, 4, 1)))
crates/ql-exec/src/workbook_runtime.rs:7137:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7143:        wb.set_name("Vals", NamedTarget::Range(Range::new(0, 0, 0, 4, 0)))
crates/ql-exec/src/workbook_runtime.rs:7173:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7186:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7188:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 2, 1)),
crates/ql-exec/src/workbook_runtime.rs:7203:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7218:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7220:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 4, 1)),
crates/ql-exec/src/workbook_runtime.rs:7233:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7243:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7245:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 1, 2)),
crates/ql-exec/src/workbook_runtime.rs:7261:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7269:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7271:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 3, 0)),
crates/ql-exec/src/workbook_runtime.rs:7274:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7276:            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 3, 1)),
crates/ql-exec/src/workbook_runtime.rs:7310:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7317:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7319:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 1, 1)),
crates/ql-exec/src/workbook_runtime.rs:7340:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7345:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7347:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 4, 0)),
crates/ql-exec/src/workbook_runtime.rs:7360:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7374:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7376:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 3, 0)),
crates/ql-exec/src/workbook_runtime.rs:7379:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7381:            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 3, 1)),
crates/ql-exec/src/workbook_runtime.rs:7384:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7386:            NamedTarget::Range(ql_types::Range::new(0, 0, 2, 3, 2)),
crates/ql-exec/src/workbook_runtime.rs:7401:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7407:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7409:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 4, 0)),
crates/ql-exec/src/workbook_runtime.rs:7421:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7427:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7429:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 2, 0)),
crates/ql-exec/src/workbook_runtime.rs:7432:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7434:            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 2, 1)),
crates/ql-exec/src/workbook_runtime.rs:7449:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:7464:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7466:            NamedTarget::Range(ql_types::Range::new(0, 0, 0, 2, 0)),
crates/ql-exec/src/workbook_runtime.rs:7469:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7471:            NamedTarget::Range(ql_types::Range::new(0, 0, 1, 2, 1)),
crates/ql-exec/src/workbook_runtime.rs:7474:        wb.set_name(
crates/ql-exec/src/workbook_runtime.rs:7476:            NamedTarget::Range(ql_types::Range::new(0, 0, 2, 2, 2)),
crates/ql-exec/src/workbook_runtime.rs:7829:    // Phase 4.7 feature — the binder currently rejects `Expr::RangeRef`
crates/ql-exec/src/workbook_runtime.rs:7997:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:8002:        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:8006:            wb.sheet(s0).unwrap().scoped_names().lookup_ci("R"),
crates/ql-exec/src/workbook_runtime.rs:8007:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
crates/ql-exec/src/workbook_runtime.rs:8010:        assert!(wb.names().is_empty());
crates/ql-exec/src/workbook_runtime.rs:8015:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:8021:            .set_sheet_scoped_name(42, "R", NamedTarget::Constant(Value::Number(1.0)))
crates/ql-exec/src/workbook_runtime.rs:8023:        assert!(matches!(err, RuntimeError::InvalidSheet { sheet: 42, .. }));
crates/ql-exec/src/workbook_runtime.rs:8028:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:8034:            .set_sheet_scoped_name(s0, "AI", NamedTarget::Constant(Value::Number(42.0)))
crates/ql-exec/src/workbook_runtime.rs:8039:        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
crates/ql-exec/src/workbook_runtime.rs:8045:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:8051:        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:8064:                assert!(matches!(target, ql_io::NamedTargetWire::Constant { .. }));
crates/ql-exec/src/workbook_runtime.rs:8075:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:8079:        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
crates/ql-exec/src/workbook_runtime.rs:8083:            .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:8146:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:8149:        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
crates/ql-exec/src/workbook_runtime.rs:8157:        rt.set_sheet_scoped_name(s0, "Rate", NamedTarget::Constant(Value::Number(0.21)))
crates/ql-exec/src/workbook_runtime.rs:9735:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:9738:        wb.set_name("MyRow", NamedTarget::Range(Range::new(0, 0, 0, 0, 2)))
crates/ql-exec/src/workbook_runtime.rs:9771:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:9774:        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 0, 3)))
crates/ql-exec/src/workbook_runtime.rs:9776:        wb.set_name("Mask", NamedTarget::Range(Range::new(0, 1, 0, 1, 3)))
crates/ql-exec/src/workbook_runtime.rs:9814:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:9818:        // `AAA`) — those lex as a `BareColumn` and produce `Expr::RangeRef`
crates/ql-exec/src/workbook_runtime.rs:9821:        wb.set_name("SrcRow", NamedTarget::Range(Range::new(0, 0, 0, 0, 1)))
crates/ql-exec/src/workbook_runtime.rs:9866:        use ql_storage::NamedTarget;
crates/ql-exec/src/workbook_runtime.rs:9869:        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 0, 3)))
crates/ql-exec/src/workbook_runtime.rs:9871:        wb.set_name("Mask", NamedTarget::Range(Range::new(0, 1, 0, 1, 3)))
crates/ql-exec/src/workbook_runtime.rs:10188:            sheet: 0,
crates/ql-exec/src/workbook_runtime.rs:10227:            sheet: 0,
crates/ql-exec/src/workbook_runtime.rs:10280:            sheet: 0,
crates/ql-exec/src/workbook_runtime.rs:10625:        wb.set_name("FOO", ql_storage::NamedTarget::Constant(Value::Number(1.0)))
crates/ql-exec/src/workbook_runtime.rs:11814:            sheet: 0,
crates/ql-exec/src/workbook_runtime.rs:12020:            sheet: 0,

exec
/bin/zsh -lc "awk 'NR>=3528 && NR<=3655 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3528:    /// Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
3529:    /// before doing lex/parse/bind work, then evaluate. Failures (lex /
3530:    /// parse / bind) propagate as `RuntimeError`; the caller bundles them
3531:    /// into a `RecomputeFailure`. Successful binds are cached so a
3532:    /// subsequent recompute (or a `set_formula` editing a nearby cell
3533:    /// with the same text) hits.
3534:    ///
3535:    /// Phase 3.6 (W5-39): this is the no-aggregate-cache wrapper. The
3536:    /// `recompute_dirty` path uses
3537:    /// [`Self::try_recompute_with_aggregate_cache`] which threads the
3538:    /// session's aggregate cache through the evaluator.
3539:    fn try_recompute_one_cached(
3540:        &mut self,
3541:        sheet: SheetId,
3542:        row: RowId,
3543:        col: ColId,
3544:        formula_text: &Arc<str>,
3545:    ) -> Result<Value, RuntimeError> {
3546:        self.try_recompute_with_aggregate_cache(
3547:            sheet,
3548:            row,
3549:            col,
3550:            formula_text,
3551:            &crate::aggregate_cache::NoAggregateCache,
3552:        )
3553:    }
3554:
3555:    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
3556:    /// threads an `AggregateCache` through the scalar evaluator so
3557:    /// `SUM(Sales)` / `AVERAGE(Sales)` calls consult + populate the
3558:    /// cache. Used by `recompute_dirty` which owns a session-side
3559:    /// `InMemAggregateCache`.
3560:    ///
3561:    /// **W5-103 (#128):** also takes `row, col` so the spill-writeback
3562:    /// branch inside `try_recompute_with_simd_profile` can materialize
3563:    /// arrays at the correct anchor cell.
3564:    fn try_recompute_with_aggregate_cache(
3565:        &mut self,
3566:        sheet: SheetId,
3567:        row: RowId,
3568:        col: ColId,
3569:        formula_text: &Arc<str>,
3570:        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
3571:    ) -> Result<Value, RuntimeError> {
3572:        self.try_recompute_with_simd_profile(sheet, row, col, formula_text, agg_cache)
3573:            .map(|(v, _, _, _)| v)
3574:    }
3575:
3576:    /// Phase 3.9 (W5-42): like `try_recompute_with_aggregate_cache`
3577:    /// but ALSO returns a `bool` for whether the formula's bound plan
3578:    /// was SIMD-eligible per `crate::lower::classify`. The bool is
3579:    /// pure observability — the actual SIMD dispatch via `simd::*`
3580:    /// happens at the bench / FormulaRegion path. `recompute_dirty`
3581:    /// uses this to populate `RecomputeResult.simd_classified` so the
3582:    /// IDE profile can show where region optimization would help.
3583:    fn try_recompute_with_simd_profile(
3584:        &mut self,
3585:        sheet: SheetId,
3586:        row: RowId,
3587:        col: ColId,
3588:        formula_text: &Arc<str>,
3589:        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
3590:    ) -> Result<(Value, bool, Option<SpillShape>, Option<SpillShape>), RuntimeError> {
3591:        let name_gen = self.workbook.names().generation();
3592:        // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
3593:        // is present in the stored formula text. This is the
3594:        // recompute path — same canonical text at different cells
3595:        // would otherwise share the cell-specific `@`-narrowed
3596:        // plan from the first bind, leaking the wrong cell ref.
3597:        let cell_anchor = if formula_text.contains('@') {
3598:            Some((row, col))
3599:        } else {
3600:            None
3601:        };
3602:        let cache_key = PlanCacheKey {
3603:            text: Arc::clone(formula_text),
3604:            sheet,
3605:            name_gen,
3606:            cell_anchor,
3607:        };
3608:        // Borrow split: we need an immutable view of the workbook
3609:        // (for `names()` inside the closure) while holding a mutable
3610:        // borrow on `self.plan_cache`. Re-borrow the workbook reference
3611:        // by name so Rust's borrow checker can split them — both fields
3612:        // are disjoint subfields of `self`.
3613:        let workbook: &Workbook = self.workbook;
3614:        let plan: Arc<crate::plan::ExprPlan> =
3615:            self.plan_cache
3616:                .get_or_insert::<_, RuntimeError>(cache_key, || {
3617:                    // **W5-147 (Phase 4.9.K):** formula_text here is the
3618:                    // CANONICAL (A1+EnUs) text stored at set_formula
3619:                    // time. Lex with the canonical mode/locale —
3620:                    // regardless of the workbook's current
3621:                    // reference_mode + locale settings, the stored text
3622:                    // is always A1+EnUs per design § 4.4.
3623:                    let tokens = lex_with(
3624:                        formula_text.as_ref(),
3625:                        ql_types::ReferenceMode::A1,
3626:                        ql_types::Locale::EnUs,
3627:                    )?;
3628:                    let expr = parse(tokens)?;
3629:                    // W5-92 (Phase 4.6.D): pass `workbook` for names so
3630:                    // the two-tier sheet-then-workbook scope chain fires.
3631:                    // **W5-114 (Phase 4.8.E):** carry recomputed cell address.
3632:                    Ok(bind_with_site(
3633:                        &expr,
3634:                        BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
3635:                        workbook,
3636:                        workbook,
3637:                        workbook,
3638:                    )?)
3639:                })?;
3640:
3641:        // Phase 3.9: classify the plan against the SIMD kernel set.
3642:        // Pure function over the plan tree; no allocation.
3643:        let simd_eligible = crate::lower::classify(plan.as_ref()).is_applicable();
3644:
3645:        // **W5-103 megaudit HIGH-2 closure (#128, all 3 reviewers
3646:        // cross-confirmed):** route through `eval_at_cell_boundary`
3647:        // (same entry set_formula uses) so a top-level
3648:        // `ExprPlan::Array` produces an `EvalResult::Array` here and
3649:        // materializes via `write_spill` — instead of collapsing to
3650:        // `#CALC!` (which `eval_scalar_with_cache` returns per the
3651:        // scalar-context contract at scalar.rs:95).
3652:        //
3653:        // Without this, op-log replay of `PutFormula { text: "{1,2,3}" }`
3654:        // followed by `recompute_all` would write #CALC! at the
3655:        // anchor instead of spilling — design § 7.3/§ 12.3

exec
/bin/zsh -lc "rg -n \"SUM\\(|SUM\\(|range|A:A|A1:A1|full column|full-column|Column\" crates/ql-exec/src/calcgraph_session.rs crates/ql-exec/src/workbook_runtime.rs crates/ql-exec/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/calcgraph_session.rs:4://! dependency tracking (cells / ranges / volatile / names). It lives
crates/ql-exec/src/calcgraph_session.rs:24://!   (b) named-range refs (from `AggregateNameRef`), (c) names
crates/ql-exec/src/calcgraph_session.rs:78:    range_contains_rowcol, schedule_with_supplemental, CellNode, Graph, Node, NodeId, Schedule,
crates/ql-exec/src/calcgraph_session.rs:90:/// (used by `Graph::register_range_dependency`). The conversion picks
crates/ql-exec/src/calcgraph_session.rs:94:/// - `start_row == 0 && end_row == RowId::MAX` → `WholeColumn` (one
crates/ql-exec/src/calcgraph_session.rs:95:///   stripe per column in the range).
crates/ql-exec/src/calcgraph_session.rs:103:fn range_to_rangeref(r: Range) -> RangeRef {
crates/ql-exec/src/calcgraph_session.rs:107:        RangeRef::WholeColumn {
crates/ql-exec/src/calcgraph_session.rs:174:/// - `ROWS(A1:B3)` / `COLUMNS(A1:B3)`: result = range dimensions; cell
crates/ql-exec/src/calcgraph_session.rs:209:/// `cells`, `named_ranges`, and `names` are deduplicated by the
crates/ql-exec/src/calcgraph_session.rs:217:    /// Named-range references (`ExprPlan::AggregateNameRef`). Each
crates/ql-exec/src/calcgraph_session.rs:220:    pub named_ranges: Vec<(Arc<str>, Range)>,
crates/ql-exec/src/calcgraph_session.rs:222:    /// resolve to ranges populate this (via `AggregateNameRef`); see
crates/ql-exec/src/calcgraph_session.rs:228:    /// mutation hooks. Populated alongside `named_ranges` (the
crates/ql-exec/src/calcgraph_session.rs:229:    /// resolved range still goes there for stripe registration).
crates/ql-exec/src/calcgraph_session.rs:237:    /// Total dependency count (cells + named ranges). Useful for
crates/ql-exec/src/calcgraph_session.rs:241:        self.cells.len() + self.named_ranges.len()
crates/ql-exec/src/calcgraph_session.rs:245:        self.cells.is_empty() && self.named_ranges.is_empty()
crates/ql-exec/src/calcgraph_session.rs:315:        ExprPlan::AggregateNameRef { name, range } => {
crates/ql-exec/src/calcgraph_session.rs:316:            deps.named_ranges.push((Arc::clone(name), *range));
crates/ql-exec/src/calcgraph_session.rs:320:        // literal range refs bind to `ExprPlan::RangeRef { range }`
crates/ql-exec/src/calcgraph_session.rs:330:        //     through the normal walker AND can take 1×1-range args
crates/ql-exec/src/calcgraph_session.rs:331:        //     (treated as single-cell per design § 2.4). When the range
crates/ql-exec/src/calcgraph_session.rs:334:        //     Multi-cell ranges → `#N/A` per Microsoft canon (value-
crates/ql-exec/src/calcgraph_session.rs:338:        // `__rt_literal_range__` into `named_ranges` here, which leaked
crates/ql-exec/src/calcgraph_session.rs:339:        // a private marker through the public `FormulaDeps.named_ranges`
crates/ql-exec/src/calcgraph_session.rs:341:        // also dropped the legitimate 1×1 dep for `ISFORMULA(A1:A1)`.
crates/ql-exec/src/calcgraph_session.rs:344:        // range collapses to a single cell.
crates/ql-exec/src/calcgraph_session.rs:345:        ExprPlan::RangeRef { range } => {
crates/ql-exec/src/calcgraph_session.rs:346:            if range.start_row == range.end_row && range.start_col == range.end_col {
crates/ql-exec/src/calcgraph_session.rs:348:                    .push((range.sheet, range.start_row, range.start_col));
crates/ql-exec/src/calcgraph_session.rs:359:        // Treat the resolved range as a range dep (same path as
crates/ql-exec/src/calcgraph_session.rs:373:            deps.named_ranges.push((Arc::clone(table_name), *resolved));
crates/ql-exec/src/calcgraph_session.rs:393:/// - `RangeRef { range }` — no value-dep. ROWS/COLUMNS read `start_row` /
crates/ql-exec/src/calcgraph_session.rs:394:///   `end_row` / `start_col` / `end_col` from the resolved range; cell
crates/ql-exec/src/calcgraph_session.rs:396:/// - `AggregateNameRef { name, range }` — register the NAME dep so name
crates/ql-exec/src/calcgraph_session.rs:398:///   `named_ranges` (no cell-stripe registration; range values don't
crates/ql-exec/src/calcgraph_session.rs:402:///   resolved range.
crates/ql-exec/src/calcgraph_session.rs:422:        // formula, but cell-stripe values inside the range don't.
crates/ql-exec/src/calcgraph_session.rs:467:    /// in Phase 3.3 to mark formulas dirty when a named range
crates/ql-exec/src/calcgraph_session.rs:500:    /// per-`(range, function_name)` aggregate results so a recompute
crates/ql-exec/src/calcgraph_session.rs:501:    /// that didn't touch any cell inside the range returns the cached
crates/ql-exec/src/calcgraph_session.rs:503:    /// invalidates entries whose range contains the written cell
crates/ql-exec/src/calcgraph_session.rs:650:    /// reverse index (Phase 3.3) + the Graph's stripe-index ranges
crates/ql-exec/src/calcgraph_session.rs:657:    /// `Graph::clear_range_deps_for_formula`. Prior comments here
crates/ql-exec/src/calcgraph_session.rs:667:    /// `StripeIndex` uses when a range's own `sheet` is `None` (today
crates/ql-exec/src/calcgraph_session.rs:668:    /// every named-range conversion sets `Some(_)` so the fallback is
crates/ql-exec/src/calcgraph_session.rs:684:        // entries falsely dirty the formula on writes to the OLD range
crates/ql-exec/src/calcgraph_session.rs:687:        self.graph.clear_range_deps_for_formula(formula_node);
crates/ql-exec/src/calcgraph_session.rs:738:        // named_ranges may contain the same name twice — that's
crates/ql-exec/src/calcgraph_session.rs:739:        // legitimate (`SUM(Sales) + AVERAGE(Sales)` references the
crates/ql-exec/src/calcgraph_session.rs:740:        // same range from two arg positions) — leave as-is.
crates/ql-exec/src/calcgraph_session.rs:774:        // Phase 3.3: register named-range deps with the Graph's stripe
crates/ql-exec/src/calcgraph_session.rs:775:        // index. The Graph's `register_range_dependency` populates BOTH
crates/ql-exec/src/calcgraph_session.rs:776:        // the stripe map AND the `formula_to_range_deps` precision-check
crates/ql-exec/src/calcgraph_session.rs:778:        // fallback (today every conversion sets `range.sheet =
crates/ql-exec/src/calcgraph_session.rs:780:        for (_, range) in &deps.named_ranges {
crates/ql-exec/src/calcgraph_session.rs:781:            let range_ref = range_to_rangeref(*range);
crates/ql-exec/src/calcgraph_session.rs:783:                .register_range_dependency(formula_node, range_ref, formula_sheet);
crates/ql-exec/src/calcgraph_session.rs:817:    /// `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula`
crates/ql-exec/src/calcgraph_session.rs:904:            // the correct fallback for any range with `sheet: None`.
crates/ql-exec/src/calcgraph_session.rs:930:        // values aren't keyed by `(range, function)` and don't unlock
crates/ql-exec/src/calcgraph_session.rs:982:    /// walks the bound plan to register cell + range + name + volatile
crates/ql-exec/src/calcgraph_session.rs:1036:    /// `clear_outgoing` (direct cell edges) + `clear_range_deps_for_formula`
crates/ql-exec/src/calcgraph_session.rs:1037:    /// (range deps in stripes + `formula_to_range_deps`). W5-50 wired
crates/ql-exec/src/calcgraph_session.rs:1054:            self.graph.clear_range_deps_for_formula(node);
crates/ql-exec/src/calcgraph_session.rs:1090:            // reverse-dep + stripe path so any chain or range dep is
crates/ql-exec/src/calcgraph_session.rs:1250:    /// resolved range), (c) bumped `TableTable::generation` and
crates/ql-exec/src/calcgraph_session.rs:1259:    /// index, same data range) so VEQ suppresses the writes — but
crates/ql-exec/src/calcgraph_session.rs:1260:    /// the formula's cached plan stays at the OLD `BareColumn(...)`
crates/ql-exec/src/calcgraph_session.rs:1271:    /// design § 8.1 "a table ref is just a range ref, period" —
crates/ql-exec/src/calcgraph_session.rs:1313:    /// holds — and the calcgraph's range stripes for those readers
crates/ql-exec/src/calcgraph_session.rs:1314:    /// were registered at the OLD range, so cell writes inside the
crates/ql-exec/src/calcgraph_session.rs:1315:    /// NEW (e.g. grown) range but OUTSIDE the old range would
crates/ql-exec/src/calcgraph_session.rs:1320:    /// graph's stripe state reflects the new range. See
crates/ql-exec/src/calcgraph_session.rs:1327:    /// not just those whose resolved range overlaps the resized
crates/ql-exec/src/calcgraph_session.rs:1328:    /// region. The reverse index doesn't track ranges; precision
crates/ql-exec/src/calcgraph_session.rs:1329:    /// would need a range-bucketed index. Coarse matches design
crates/ql-exec/src/calcgraph_session.rs:1354:    /// that changed the resolved range (today: resize). Case-
crates/ql-exec/src/calcgraph_session.rs:1373:    /// 1. `Graph::dependents_for_cell` returns range-dep candidates,
crates/ql-exec/src/calcgraph_session.rs:1389:        // range contains this cell. Done BEFORE the dirty fanout so a
crates/ql-exec/src/calcgraph_session.rs:1392:        // writes outside every cached range are O(cache_size) with no
crates/ql-exec/src/calcgraph_session.rs:1488:            // dep + stripe path, so any chain or range dep is reached.
crates/ql-exec/src/calcgraph_session.rs:1506:    /// `set_formula` so aggregate-over-range evals hit the cache when
crates/ql-exec/src/calcgraph_session.rs:1507:    /// nothing in the range changed since the last computation.
crates/ql-exec/src/calcgraph_session.rs:1651:        // Tarjan can see range-induced ordering / cycles. The Phase 0
crates/ql-exec/src/calcgraph_session.rs:1652:        // graph stores range deps in stripes + `formula_to_range_deps`
crates/ql-exec/src/calcgraph_session.rs:1653:        // rather than as `add_edge` edges (the A4 acceptance: SUM(A:A)
crates/ql-exec/src/calcgraph_session.rs:1655:        // expand range deps lazily into temp edges F → G where G is a
crates/ql-exec/src/calcgraph_session.rs:1656:        // dirty formula inside one of F's ranges.
crates/ql-exec/src/calcgraph_session.rs:1657:        let supplemental = self.build_range_supplemental(&dirty_vec);
crates/ql-exec/src/calcgraph_session.rs:1663:    /// with at least one range dep, and each OTHER (or same — for
crates/ql-exec/src/calcgraph_session.rs:1664:    /// self-range cycles) dirty formula `G` whose cell address falls
crates/ql-exec/src/calcgraph_session.rs:1665:    /// inside one of F's ranges, emit a temp edge `F → G`.
crates/ql-exec/src/calcgraph_session.rs:1668:    /// Non-formula cells (literals) inside the range are read as
crates/ql-exec/src/calcgraph_session.rs:1677:    /// Complexity: O(|dirty_vec|² × avg_ranges_per_formula). Typical
crates/ql-exec/src/calcgraph_session.rs:1679:    /// `range_contains_rowcol` check. If profiling later shows pain,
crates/ql-exec/src/calcgraph_session.rs:1680:    /// switching to per-range bucketing (build a per-stripe index of
crates/ql-exec/src/calcgraph_session.rs:1681:    /// dirty formulas, intersect with range bounds) is the path.
crates/ql-exec/src/calcgraph_session.rs:1682:    fn build_range_supplemental(&self, dirty_vec: &[NodeId]) -> HashMap<NodeId, Vec<NodeId>> {
crates/ql-exec/src/calcgraph_session.rs:1694:            let ranges = self.graph.range_deps_for(f);
crates/ql-exec/src/calcgraph_session.rs:1695:            if ranges.is_empty() {
crates/ql-exec/src/calcgraph_session.rs:1699:            // F's multiple ranges. Without this, a formula with two
crates/ql-exec/src/calcgraph_session.rs:1700:            // overlapping ranges (e.g., SUM(A1:A10) + SUM(A1:A5)) that
crates/ql-exec/src/calcgraph_session.rs:1704:            // gets worse as Phase 4.3 V2 adds multi-range functions.
crates/ql-exec/src/calcgraph_session.rs:1707:            for range in ranges {
crates/ql-exec/src/calcgraph_session.rs:1708:                let resolved_sheet = Graph::range_ref_sheet(range).unwrap_or(fs);
crates/ql-exec/src/calcgraph_session.rs:1713:                    if range_contains_rowcol(range, gr, gc) && added.insert(g) {
crates/ql-exec/src/calcgraph_session.rs:1931:        assert!(deps.named_ranges.is_empty());
crates/ql-exec/src/calcgraph_session.rs:1935:    /// DEP-3-02: a SUM-over-named-range stays as one `named_range`
crates/ql-exec/src/calcgraph_session.rs:1937:    /// HyperFormula-style range-as-single-edge optimization that lets
crates/ql-exec/src/calcgraph_session.rs:1940:    fn dep_3_02_range_deps_remain_compressed() {
crates/ql-exec/src/calcgraph_session.rs:1961:        wb.put_formula(0, 0, 5, "SUM(Block)");
crates/ql-exec/src/calcgraph_session.rs:1964:        assert!(r.is_complete(), "SUM(Block) must bind");
crates/ql-exec/src/calcgraph_session.rs:1970:            "named range must not expand to per-cell deps"
crates/ql-exec/src/calcgraph_session.rs:1973:            deps.named_ranges.len(),
crates/ql-exec/src/calcgraph_session.rs:1975:            "one entry per named range reference"
crates/ql-exec/src/calcgraph_session.rs:1977:        let (name, range) = &deps.named_ranges[0];
crates/ql-exec/src/calcgraph_session.rs:1979:        assert_eq!(range.end_row, 9, "range payload preserved");
crates/ql-exec/src/calcgraph_session.rs:2006:        wb.put_formula(0, 0, 5, "SUM(Sales)");
crates/ql-exec/src/calcgraph_session.rs:2007:        wb.put_formula(0, 1, 5, "AVERAGE(Sales) + SUM(Sales)");
crates/ql-exec/src/calcgraph_session.rs:2128:        wb.put_formula(0, 0, 5, "SUM(MyRange) + NOW()");
crates/ql-exec/src/calcgraph_session.rs:2161:            (0, 0, 2, "SUM(MyUnknownName1)"), // bind fail (UnresolvedName)
crates/ql-exec/src/calcgraph_session.rs:2203:    /// dirty TRANSITIVELY. A chain `Sales → B1 = SUM(Sales) → C1 = B1+1`:
crates/ql-exec/src/calcgraph_session.rs:2226:        wb.put_formula(0, 0, 1, "SUM(Sales)");
crates/ql-exec/src/calcgraph_session.rs:2309:    // depend on that cell (directly or via range), and re-bind cleans
crates/ql-exec/src/calcgraph_session.rs:2313:    /// Helper: build a workbook with a single named-range formula. The
crates/ql-exec/src/calcgraph_session.rs:2314:    /// named range covers `MyRange` for rows in `range_rows`, and a
crates/ql-exec/src/calcgraph_session.rs:2316:    fn workbook_with_named_range_sum(
crates/ql-exec/src/calcgraph_session.rs:2317:        range_start_row: RowId,
crates/ql-exec/src/calcgraph_session.rs:2318:        range_end_row: RowId,
crates/ql-exec/src/calcgraph_session.rs:2327:                start_row: range_start_row,
crates/ql-exec/src/calcgraph_session.rs:2328:                end_row: range_end_row,
crates/ql-exec/src/calcgraph_session.rs:2335:        wb.put_formula(0, formula_cell.0, formula_cell.1, "SUM(MyRange)");
crates/ql-exec/src/calcgraph_session.rs:2339:    /// DIR-3-01: a write to a cell INSIDE a formula's named-range
crates/ql-exec/src/calcgraph_session.rs:2343:    fn dir_3_01_write_inside_range_dirties_dependent() {
crates/ql-exec/src/calcgraph_session.rs:2344:        // MyRange = A1:A1000; formula =SUM(MyRange) at B1.
crates/ql-exec/src/calcgraph_session.rs:2345:        let wb = workbook_with_named_range_sum(0, 999, (0, 1));
crates/ql-exec/src/calcgraph_session.rs:2352:        // Write to A500 — inside the range. Formula should dirty.
crates/ql-exec/src/calcgraph_session.rs:2354:        assert!(s.is_dirty(formula_node), "SUM(MyRange) marked dirty");
crates/ql-exec/src/calcgraph_session.rs:2363:    /// DIR-3-02: a write OUTSIDE a formula's range does NOT dirty,
crates/ql-exec/src/calcgraph_session.rs:2365:    /// check filters the false positive). MyRange = A1:A10; write to
crates/ql-exec/src/calcgraph_session.rs:2366:    /// A500 hits Column 0 stripe but A500 is not in [A1:A10].
crates/ql-exec/src/calcgraph_session.rs:2368:    fn dir_3_02_write_outside_range_filtered_by_precision_check() {
crates/ql-exec/src/calcgraph_session.rs:2369:        let wb = workbook_with_named_range_sum(0, 9, (0, 1));
crates/ql-exec/src/calcgraph_session.rs:2375:        // Write to A500 — outside [A1:A10]. Stripe matches Column 0,
crates/ql-exec/src/calcgraph_session.rs:2380:            "A500 outside [A1:A10] must not dirty SUM(MyRange)"
crates/ql-exec/src/calcgraph_session.rs:2384:        // Sanity: a write INSIDE [A1:A10] still works.
crates/ql-exec/src/calcgraph_session.rs:2389:    /// DIR-3-03: whole-column, whole-row, and bounded named ranges all
crates/ql-exec/src/calcgraph_session.rs:2391:    /// distinct named ranges and verify each fires on the right writes
crates/ql-exec/src/calcgraph_session.rs:2396:    /// `WholeColumnA` / `WholeRowFive` / `BoundedRect` to force the
crates/ql-exec/src/calcgraph_session.rs:2402:        // WholeColumn: A:A — `start_row=0, end_row=u32::MAX` sentinel
crates/ql-exec/src/calcgraph_session.rs:2404:        // 3.3 `range_to_rangeref` converter produces `RangeRef::
crates/ql-exec/src/calcgraph_session.rs:2405:        // WholeColumn` for this shape; the stripe insertion is O(1)
crates/ql-exec/src/calcgraph_session.rs:2408:            "WholeColumnA",
crates/ql-exec/src/calcgraph_session.rs:2445:        wb.put_formula(0, 0, 10, "SUM(WholeColumnA)");
crates/ql-exec/src/calcgraph_session.rs:2446:        wb.put_formula(0, 1, 10, "SUM(WholeRowFive)");
crates/ql-exec/src/calcgraph_session.rs:2447:        wb.put_formula(0, 2, 10, "SUM(BoundedRect)");
crates/ql-exec/src/calcgraph_session.rs:2456:        // Sanity: 3 distinct stripes registered (Column 0, Row 5,
crates/ql-exec/src/calcgraph_session.rs:2457:        // Column 2 — Bounded's height > width so it goes on column).
crates/ql-exec/src/calcgraph_session.rs:2460:        // Write to A9999 — should hit WholeColumnA.
crates/ql-exec/src/calcgraph_session.rs:2462:        assert!(s.is_dirty(n_cola), "WholeColumnA: A9999 in whole column");
crates/ql-exec/src/calcgraph_session.rs:2470:        // WholeColumnA shouldn't fire — col=50, not col=0.
crates/ql-exec/src/calcgraph_session.rs:2482:        // Write to (row=50, col=50) — outside ALL three ranges.
crates/ql-exec/src/calcgraph_session.rs:2483:        // WholeColumnA wants col 0; WholeRowFive wants row 5;
crates/ql-exec/src/calcgraph_session.rs:2490:            "(50,50) outside all three named ranges"
crates/ql-exec/src/calcgraph_session.rs:2505:    /// per-cell graph edges. A formula `=SUM(ColA)` over A:A registers
crates/ql-exec/src/calcgraph_session.rs:2507:    /// compressed-range optimization. Verify by counting the stripe
crates/ql-exec/src/calcgraph_session.rs:2525:        wb.put_formula(0, 0, 1, "SUM(ColA)");
crates/ql-exec/src/calcgraph_session.rs:2531:        // Exactly one stripe entry (Column 0 on Sheet 0).
crates/ql-exec/src/calcgraph_session.rs:2535:            "WholeColumn must register exactly one Column stripe"
crates/ql-exec/src/calcgraph_session.rs:2538:        // map + formula_to_range_deps, not as Graph edges.
crates/ql-exec/src/calcgraph_session.rs:2542:            "no per-cell edges for whole-column named range"
crates/ql-exec/src/calcgraph_session.rs:2544:        // The formula's range registration count is 1.
crates/ql-exec/src/calcgraph_session.rs:2545:        assert_eq!(s.graph().range_dependency_count(), 1);
crates/ql-exec/src/calcgraph_session.rs:2582:    /// reverse index from named-range deps). Every formula that
crates/ql-exec/src/calcgraph_session.rs:2602:        wb.put_formula(0, 0, 5, "SUM(Discount)");
crates/ql-exec/src/calcgraph_session.rs:2706:    // `Graph::clear_range_deps_for_formula` into
crates/ql-exec/src/calcgraph_session.rs:2834:    /// range-dep formula from SUM(A:A) to SUM(B:B) clears the Column A
crates/ql-exec/src/calcgraph_session.rs:2838:    /// `ql_types`) which `range_to_rangeref` (line 101) maps to the
crates/ql-exec/src/calcgraph_session.rs:2840:    /// becomes `WholeColumn`.
crates/ql-exec/src/calcgraph_session.rs:2842:    fn h4_rebind_clears_stale_range_stripe_dirty() {
crates/ql-exec/src/calcgraph_session.rs:2847:        // Step 1: B1 = SUM(Sales_A) where Sales_A → A:A.
crates/ql-exec/src/calcgraph_session.rs:2848:        // Construct a whole-column-A range (start_row=0, end_row=MAX).
crates/ql-exec/src/calcgraph_session.rs:2858:            range: sales_a,
crates/ql-exec/src/calcgraph_session.rs:2869:            "Column A stripe registered"
crates/ql-exec/src/calcgraph_session.rs:2872:        // Step 2: rebind to SUM(Sales_B) where Sales_B → B:B.
crates/ql-exec/src/calcgraph_session.rs:2882:            range: sales_b,
crates/ql-exec/src/calcgraph_session.rs:2890:        // Stripe map: ONLY Column B now (Column A was cleared).
crates/ql-exec/src/calcgraph_session.rs:2894:            "A5 write must NOT find B1 — Column A stripe revoked"
crates/ql-exec/src/calcgraph_session.rs:2899:            "B5 write finds B1 via new Column B stripe"
crates/ql-exec/src/calcgraph_session.rs:2908:            "H4 closure: stale Column A stripe must not fire"
crates/ql-exec/src/calcgraph_session.rs:2919:    // Phase 3.10 megaudit H1 found that range-dep formulas don't create
crates/ql-exec/src/calcgraph_session.rs:2920:    // scheduler edges — Tarjan can't see range-induced cycles or
crates/ql-exec/src/calcgraph_session.rs:2922:    // at `schedule_dirty` time: for each dirty formula F with range
crates/ql-exec/src/calcgraph_session.rs:2923:    // deps and a dirty formula G inside one of F's ranges, the session
crates/ql-exec/src/calcgraph_session.rs:2932:    /// W5-50 / megaudit H1 example #1 — range-induced cycle:
crates/ql-exec/src/calcgraph_session.rs:2933:    ///   A1 = "=SUM(B1:B1)"   → range dep on B1
crates/ql-exec/src/calcgraph_session.rs:2939:    fn h1_range_induced_cycle_detected() {
crates/ql-exec/src/calcgraph_session.rs:2945:        // A1 = SUM(B1:B1)
crates/ql-exec/src/calcgraph_session.rs:2946:        let b1_range = ql_types::Range {
crates/ql-exec/src/calcgraph_session.rs:2957:                range: b1_range,
crates/ql-exec/src/calcgraph_session.rs:2975:        s.on_set_value(0, 0, 1); // dirties A1 (via Column B stripe)
crates/ql-exec/src/calcgraph_session.rs:2991:            "H1: range-induced cycle detected"
crates/ql-exec/src/calcgraph_session.rs:2995:    /// W5-50 / megaudit H1 example #2 — range-induced ordering (no
crates/ql-exec/src/calcgraph_session.rs:2997:    ///   A1 = "=SUM(B1:B1)"   → range dep on B1
crates/ql-exec/src/calcgraph_session.rs:3000:    /// (A1 depends on B1 via the range, so B1 must compute first).
crates/ql-exec/src/calcgraph_session.rs:3002:    fn h1_range_induced_ordering_via_supplemental() {
crates/ql-exec/src/calcgraph_session.rs:3009:        // A1 = SUM(B1:B1)
crates/ql-exec/src/calcgraph_session.rs:3010:        let b1_range = ql_types::Range {
crates/ql-exec/src/calcgraph_session.rs:3021:                range: b1_range,
crates/ql-exec/src/calcgraph_session.rs:3037:        // depends on C1 (direct cell), A1 depends on B1 (via range).
crates/ql-exec/src/calcgraph_session.rs:3040:        s.on_set_value(0, 0, 2); // write to C1 → B1 dirty → A1 dirty (Column B stripe + transitive BFS)
crates/ql-exec/src/calcgraph_session.rs:3055:    /// W5-50 / self-range cycle: `A1 = "=SUM(A1:A1)"`. Single dirty
crates/ql-exec/src/calcgraph_session.rs:3056:    /// formula whose range covers itself. Supplemental injects A1 → A1.
crates/ql-exec/src/calcgraph_session.rs:3059:    fn self_range_cycle_via_supplemental() {
crates/ql-exec/src/calcgraph_session.rs:3064:        // A1 = SUM(A1:A1)
crates/ql-exec/src/calcgraph_session.rs:3065:        let a1_range = ql_types::Range {
crates/ql-exec/src/calcgraph_session.rs:3076:                range: a1_range,
crates/ql-exec/src/calcgraph_session.rs:3090:        assert_eq!(sched.cycled, vec![a1], "self-range cycle detected");
crates/ql-exec/src/calcgraph_session.rs:3093:    /// W5-50 — partial dirty: B1 in A1's range is a LITERAL (not a
crates/ql-exec/src/calcgraph_session.rs:3098:    fn partial_dirty_literal_in_range_no_supplemental() {
crates/ql-exec/src/calcgraph_session.rs:3104:        // A1 = SUM(B1:B1) where B1 is a literal.
crates/ql-exec/src/calcgraph_session.rs:3105:        let b1_range = ql_types::Range {
crates/ql-exec/src/calcgraph_session.rs:3116:                range: b1_range,
crates/ql-exec/src/calcgraph_session.rs:3127:        assert!(s.is_dirty(a1), "A1 dirty via Column B stripe");
crates/ql-exec/src/calcgraph_session.rs:3147:    // side) and never `graph.clear_outgoing` / `graph.clear_range_deps_
crates/ql-exec/src/calcgraph_session.rs:3212:    /// W5-52: clearing a range-dep formula must revoke its stripe
crates/ql-exec/src/calcgraph_session.rs:3213:    /// registrations + `formula_to_range_deps` entry. Writes to the
crates/ql-exec/src/calcgraph_session.rs:3214:    /// old range must not falsely dirty the cleared formula.
crates/ql-exec/src/calcgraph_session.rs:3216:    fn clear_formula_revokes_range_stripes() {
crates/ql-exec/src/calcgraph_session.rs:3221:        // B1 = SUM(A:A) — Column A whole-col range.
crates/ql-exec/src/calcgraph_session.rs:3233:                range: col_a,
crates/ql-exec/src/calcgraph_session.rs:3241:            "Column A stripe registered"
crates/ql-exec/src/calcgraph_session.rs:3260:        assert!(!s.is_dirty(b1), "stale range stripe must not fire");
crates/ql-exec/src/calcgraph_session.rs:3263:    /// W5-52: the Codex/Sonnet reproduction — A1=SUM(A1:A1) (self-
crates/ql-exec/src/calcgraph_session.rs:3264:    /// range cycle), clear A1, then write A1 as a literal. The stale
crates/ql-exec/src/calcgraph_session.rs:3273:        // A1 = SUM(A1:A1) — self-range.
crates/ql-exec/src/calcgraph_session.rs:3274:        let a1_range = ql_types::Range {
crates/ql-exec/src/calcgraph_session.rs:3285:                range: a1_range,
crates/ql-exec/src/calcgraph_session.rs:3292:        // Clear the formula. Pre-W5-52 this left the Column A stripe
crates/ql-exec/src/calcgraph_session.rs:3293:        // + formula_to_range_deps[A1] = [A1:A1] in place; a subsequent
crates/ql-exec/src/calcgraph_session.rs:3296:        // stale range_deps_for(A1), and Tarjan would emit A1 in
crates/ql-exec/src/calcgraph_session.rs:3307:            s.graph().range_deps_for(a1).is_empty(),
crates/ql-exec/src/calcgraph_session.rs:3308:            "range deps must be revoked"
crates/ql-exec/src/calcgraph_session.rs:3320:        // anymore and its own range dep was revoked).
crates/ql-exec/src/calcgraph_session.rs:3333:    /// W5-53 (audit closure gap): when F has two overlapping ranges
crates/ql-exec/src/calcgraph_session.rs:3334:    /// (both containing the same dirty G), `build_range_supplemental`
crates/ql-exec/src/calcgraph_session.rs:3340:    fn build_range_supplemental_dedups_overlapping_ranges() {
crates/ql-exec/src/calcgraph_session.rs:3344:        s.or_insert_cell_node(0, 2, 0); // A3 (the G that's in both ranges)
crates/ql-exec/src/calcgraph_session.rs:3346:        // B1 = SUM(A1:A10) + SUM(A1:A5). Both ranges contain A3.
crates/ql-exec/src/calcgraph_session.rs:3367:                    range: r1_10,
crates/ql-exec/src/calcgraph_session.rs:3371:                    range: r1_5,
crates/ql-exec/src/calcgraph_session.rs:3386:        s.on_set_value(0, 0, 0); // dirties B1 via Column A stripe + any formulas referring to A1
crates/ql-exec/src/calcgraph_session.rs:3387:        s.on_set_value(0, 2, 0); // dirties B1 via Column A stripe (A3 cell) + A3 if it has dependents
crates/ql-exec/src/calcgraph_session.rs:3392:        // Easier path: call build_range_supplemental directly via a
crates/ql-exec/src/calcgraph_session.rs:3404:        // depends on A3 via range, but A3 has no outgoing edge to
crates/ql-exec/src/calcgraph_session.rs:3448:        let wb = workbook_with_named_range_sum(0, 99, (0, 1));
crates/ql-exec/src/calcgraph_session.rs:3461:        let wb = workbook_with_named_range_sum(0, 9, (0, 1));
crates/ql-exec/src/calcgraph_session.rs:3985:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4009:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4041:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4072:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4082:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4134:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4175:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4203:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4251:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4259:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4293:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4334:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4358:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4399:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/calcgraph_session.rs:4426:            source: Arc::new(ql_formula_syntax::TableSpecSubtree::BareColumn(Arc::from(
crates/ql-exec/src/workbook_runtime.rs:27://! - GAP-G-01 / GAP-G-03 — append-only graph rebind staleness + range-deps-
crates/ql-exec/src/workbook_runtime.rs:54:/// Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
crates/ql-exec/src/workbook_runtime.rs:142:/// a sheet id outside the workbook's range get a clean error instead of a panic
crates/ql-exec/src/workbook_runtime.rs:266:    TableColumnNotFound { table: String, column: String },
crates/ql-exec/src/workbook_runtime.rs:273:    TableColumnRejected {
crates/ql-exec/src/workbook_runtime.rs:360:/// which has no range deps or volatile flag, is skipped entirely during
crates/ql-exec/src/workbook_runtime.rs:564:        //   - `SUM(A1; B2)` (DE) → `SUM(A1, B2)` (EN).
crates/ql-exec/src/workbook_runtime.rs:599:        // the SUM(A1:A10)-across-rows fast path).
crates/ql-exec/src/workbook_runtime.rs:735:        // aggregate-range results land in the session's cache.
crates/ql-exec/src/workbook_runtime.rs:785:        // for cell/range/name + volatile deps without re-binding. The
crates/ql-exec/src/workbook_runtime.rs:809:        // - NEW (self): range-stripe deps over a target need to dirty
crates/ql-exec/src/workbook_runtime.rs:811:        //   only handles `deps.cells`; range deps go through the
crates/ql-exec/src/workbook_runtime.rs:1564:    /// - Column count matches `column_names.len()`.
crates/ql-exec/src/workbook_runtime.rs:1565:    /// - Column names are non-empty and unique case-insensitively.
crates/ql-exec/src/workbook_runtime.rs:1624:        // Column-name uniqueness (case-insensitive).
crates/ql-exec/src/workbook_runtime.rs:1689:        use ql_storage::{TableColumn, TableMetadata};
crates/ql-exec/src/workbook_runtime.rs:1690:        let columns: Vec<TableColumn> = column_names
crates/ql-exec/src/workbook_runtime.rs:1692:            .map(|cn| TableColumn {
crates/ql-exec/src/workbook_runtime.rs:1727:    /// reading the (now-untyped) cell range until something else
crates/ql-exec/src/workbook_runtime.rs:1760:        // (`ExprPlan::StructuredRef { resolved: <pre-drop range> }`)
crates/ql-exec/src/workbook_runtime.rs:1946:    /// 2. Op-log append `Op::RenameColumn` (before any mutation).
crates/ql-exec/src/workbook_runtime.rs:1951:    /// 4. Mutate the matching `TableColumn` entry's lowercase canonical
crates/ql-exec/src/workbook_runtime.rs:1975:            return Err(RuntimeError::TableColumnNotFound {
crates/ql-exec/src/workbook_runtime.rs:1982:            return Err(RuntimeError::TableColumnRejected {
crates/ql-exec/src/workbook_runtime.rs:1998:            return Err(RuntimeError::TableColumnRejected {
crates/ql-exec/src/workbook_runtime.rs:2004:        // Op-log append BEFORE mutation (W5-103 atomicity). RenameColumn
crates/ql-exec/src/workbook_runtime.rs:2008:            oplog.append(Op::RenameColumn {
crates/ql-exec/src/workbook_runtime.rs:2117:    /// Re-binding picks up the new range/columns on next eval via the
crates/ql-exec/src/workbook_runtime.rs:2122:    /// (via [`Self::reextract_table_readers`] so range stripes reflect
crates/ql-exec/src/workbook_runtime.rs:2123:    /// the new range — critical: pre-W5-159 a write into the new growth
crates/ql-exec/src/workbook_runtime.rs:2139:        use ql_storage::TableColumn;
crates/ql-exec/src/workbook_runtime.rs:2306:            meta.columns.push(TableColumn {
crates/ql-exec/src/workbook_runtime.rs:2315:        // range/column roster on next eval. Targeted `table_gen`-keyed
crates/ql-exec/src/workbook_runtime.rs:2321:        // **W5-159 (Phase 4.8.G.3):** the resolved range each reader
crates/ql-exec/src/workbook_runtime.rs:2323:        // deps for every reader so the calcgraph's range stripes
crates/ql-exec/src/workbook_runtime.rs:2324:        // reflect the new range — without this, cell writes inside
crates/ql-exec/src/workbook_runtime.rs:2325:        // the NEW range but OUTSIDE the OLD range would silently miss
crates/ql-exec/src/workbook_runtime.rs:2338:    /// calcgraph's range-stripe state matches the new resolved range.
crates/ql-exec/src/workbook_runtime.rs:2433:        // by a process-killing panic from `ColumnStore::with_chunk_rows` or
crates/ql-exec/src/workbook_runtime.rs:3071:                        BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
crates/ql-exec/src/workbook_runtime.rs:3239:                //   b) Has named-range deps — V1 conservatively re-evals
crates/ql-exec/src/workbook_runtime.rs:3240:                //      (we don't track per-cell-in-range changes yet).
crates/ql-exec/src/workbook_runtime.rs:3253:                    if !deps.named_ranges.is_empty() {
crates/ql-exec/src/workbook_runtime.rs:3301:                // cache so `SUM(Sales)`-style formulas hit the cache when
crates/ql-exec/src/workbook_runtime.rs:3471:                            BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
crates/ql-exec/src/workbook_runtime.rs:3557:    /// `SUM(Sales)` / `AVERAGE(Sales)` calls consult + populate the
crates/ql-exec/src/workbook_runtime.rs:3672:        // reads (named ranges, aggregates). Direct self-reads create
crates/ql-exec/src/workbook_runtime.rs:3779:        // =SUM(A1, A2, A3) → 60
crates/ql-exec/src/workbook_runtime.rs:3780:        let v = rt.set_formula(0, 0, 1, "SUM(A1, A2, A3)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:4140:    // ===== Phase 2A.1 — named-range resolution =====
crates/ql-exec/src/workbook_runtime.rs:4275:    /// Phase 2B.4 (2026-05-12): named range in a bare scalar position now
crates/ql-exec/src/workbook_runtime.rs:4278:    /// `=SUM(Sales)`) is now accepted and binds to `ExprPlan::AggregateNameRef`.
crates/ql-exec/src/workbook_runtime.rs:4281:    fn set_formula_named_range_in_scalar_context_errors() {
crates/ql-exec/src/workbook_runtime.rs:5015:    // ===== Phase 2B.4 — named-range aggregate context prep =====
crates/ql-exec/src/workbook_runtime.rs:5040:            .set_formula(0, 0, 1, "SUM(MyConstant, MyConstant, MyConstant)")
crates/ql-exec/src/workbook_runtime.rs:5063:        // resolves as a single cell, not as a range.
crates/ql-exec/src/workbook_runtime.rs:5064:        let v_aggregate = rt.set_formula(0, 1, 1, "SUM(MyRef, MyRef)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:5070:    /// a bind error). Phase 3.6 (W5-39, 2026-05-12) wired aggregate-range
crates/ql-exec/src/workbook_runtime.rs:5072:    /// range here covers A2:A11 (no values populated) → SUM = 0.
crates/ql-exec/src/workbook_runtime.rs:5074:    fn nag_03_named_range_in_aggregate_function_binds_to_explicit_variant() {
crates/ql-exec/src/workbook_runtime.rs:5083:        // SUM(Sales) — Phase 3.6: actual evaluation. Empty range sums to 0.
crates/ql-exec/src/workbook_runtime.rs:5084:        let v = rt.set_formula(0, 0, 0, "SUM(Sales)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:5091:            Some("SUM(SALES)")
crates/ql-exec/src/workbook_runtime.rs:5097:    /// (The pre-existing `set_formula_named_range_in_scalar_context_errors`
crates/ql-exec/src/workbook_runtime.rs:5100:    fn nag_04_named_range_in_scalar_positions_errors_precisely() {
crates/ql-exec/src/workbook_runtime.rs:5330:        // W5-53 (GAP-F-05 closure) + W5-54 (lookup family): range-
crates/ql-exec/src/workbook_runtime.rs:5332:        // the parallel range_aware_fns table; check via
crates/ql-exec/src/workbook_runtime.rs:5333:        // lookup_range_aware.
crates/ql-exec/src/workbook_runtime.rs:5361:            // closure:** SUBTOTAL is range-aware (dispatches to scalar
crates/ql-exec/src/workbook_runtime.rs:5363:            // is_aggregate_function so range args bind as
crates/ql-exec/src/workbook_runtime.rs:5364:            // AggregateNameRef. Eval-side routes via lookup_range_aware.
crates/ql-exec/src/workbook_runtime.rs:5367:            // 28 additional range-aware fns admitted to
crates/ql-exec/src/workbook_runtime.rs:5401:                reg.lookup_range_aware(name).is_some(),
crates/ql-exec/src/workbook_runtime.rs:5402:                "is_aggregate_function lists {name:?} (range-aware variant) but \
crates/ql-exec/src/workbook_runtime.rs:5403:                 it's not in default_registry's range_aware_fns table"
crates/ql-exec/src/workbook_runtime.rs:5407:                "{name:?} is range-aware ONLY; must not also appear in the scalar table"
crates/ql-exec/src/workbook_runtime.rs:5412:        // is_aggregate_function so the binder routes named-range args
crates/ql-exec/src/workbook_runtime.rs:5415:        // scalar/range_aware tables.
crates/ql-exec/src/workbook_runtime.rs:5427:                reg.lookup_range_aware(name).is_none(),
crates/ql-exec/src/workbook_runtime.rs:5428:                "{name:?} is unified ONLY; must not appear in the range-aware table"
crates/ql-exec/src/workbook_runtime.rs:5434:        // a NameRef to a range used inside IF surfaces
crates/ql-exec/src/workbook_runtime.rs:5436:        // That behaviour is pinned by `nag_04_named_range_in_scalar_positions_errors_precisely`.
crates/ql-exec/src/workbook_runtime.rs:5440:    /// Opus HIGH-1 / HIGH-3):** prove that the 28 range-aware fns
crates/ql-exec/src/workbook_runtime.rs:5442:    /// route range args through `AggregateNameRef` end-to-end, not just
crates/ql-exec/src/workbook_runtime.rs:5447:    /// Each test sets up a named range, then drives a formula through
crates/ql-exec/src/workbook_runtime.rs:5452:    fn w5_d_13_1_subtotal_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime.rs:5464:        // SUBTOTAL(9, Sales) = SUM(Sales) = 6. The Codex W5-D-12
crates/ql-exec/src/workbook_runtime.rs:5474:    fn w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime.rs:5517:    fn w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime.rs:5528:        // patterns (e.g. `Ys` lexes as BareColumn col=668). Use names
crates/ql-exec/src/workbook_runtime.rs:5606:    /// without anyone noticing that 28 other range-aware fns had the
crates/ql-exec/src/workbook_runtime.rs:5609:    /// This invariant fills the gap: every range-aware-registered fn
crates/ql-exec/src/workbook_runtime.rs:5610:    /// MUST be admitted by `is_aggregate_function`. Some range-aware
crates/ql-exec/src/workbook_runtime.rs:5611:    /// fns may legitimately NOT need range args (none currently), so
crates/ql-exec/src/workbook_runtime.rs:5613:    /// range-aware-registered but deliberately not admitted.
crates/ql-exec/src/workbook_runtime.rs:5615:    /// If a future range-aware fn is registered with scalar-only args
crates/ql-exec/src/workbook_runtime.rs:5616:    /// (no range args needed at all), it must be added to
crates/ql-exec/src/workbook_runtime.rs:5617:    /// `range_aware_fns_that_do_not_need_aggregate_admission` below
crates/ql-exec/src/workbook_runtime.rs:5620:    fn every_range_aware_fn_is_admitted_to_is_aggregate_function() {
crates/ql-exec/src/workbook_runtime.rs:5623:        // Allowlist: range-aware fns that DO NOT need is_aggregate_function
crates/ql-exec/src/workbook_runtime.rs:5624:        // admission because they don't accept range/named-range args.
crates/ql-exec/src/workbook_runtime.rs:5625:        // **Empty as of W5-D-13.1** — every range-aware-registered fn
crates/ql-exec/src/workbook_runtime.rs:5631:        for &name in reg.range_aware_names() {
crates/ql-exec/src/workbook_runtime.rs:5641:            "W5-D-13.1 invariant: every range-aware fn must be admitted to \
crates/ql-exec/src/workbook_runtime.rs:5642:             is_aggregate_function (binder admission gate for named-range \
crates/ql-exec/src/workbook_runtime.rs:5652:    /// tests don't exercise nested aggregates with named ranges. Ensure
crates/ql-exec/src/workbook_runtime.rs:5653:    /// `SUM(AVERAGE(Sales))` (both aggregate; inner is the named-range arg)
crates/ql-exec/src/workbook_runtime.rs:5654:    /// and `ROUND(SUM(Sales), 2)` (outer scalar, inner aggregate with the
crates/ql-exec/src/workbook_runtime.rs:5655:    /// named range) both bind cleanly to the appropriate plan shapes.
crates/ql-exec/src/workbook_runtime.rs:5657:    fn nag_05_nested_aggregates_with_named_range_bind_cleanly() {
crates/ql-exec/src/workbook_runtime.rs:5666:        // SUM(AVERAGE(Sales)) — outer SUM passes aggregate context to its
crates/ql-exec/src/workbook_runtime.rs:5670:        // Phase 3.6 (W5-39): empty range. AVERAGE over empty = #DIV/0!
crates/ql-exec/src/workbook_runtime.rs:5673:        let v = rt.set_formula(0, 0, 0, "SUM(AVERAGE(Sales))").unwrap();
crates/ql-exec/src/workbook_runtime.rs:5678:    fn nag_06_round_with_nested_sum_of_named_range_binds_cleanly() {
crates/ql-exec/src/workbook_runtime.rs:5688:        // FIRST arg here is SUM(Sales), which is itself a Function call —
crates/ql-exec/src/workbook_runtime.rs:5692:        // Phase 3.6 (W5-39): SUM(Sales) = 0 over empty range; ROUND(0, 2)
crates/ql-exec/src/workbook_runtime.rs:5694:        let v = rt.set_formula(0, 0, 0, "ROUND(SUM(Sales), 2)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:6448:    /// Helper: build a workbook with a named range `BigRange` over A1:A`size`
crates/ql-exec/src/workbook_runtime.rs:6449:    /// pre-populated with values 1..=size, and a SUM(BigRange) formula at B1.
crates/ql-exec/src/workbook_runtime.rs:6464:        wb.put_formula(0, 0, 1, "SUM(BigRange)");
crates/ql-exec/src/workbook_runtime.rs:6471:    /// over a named range produce the same result as the scalar baseline.
crates/ql-exec/src/workbook_runtime.rs:6488:            rt.set_formula(0, 0, 1, "SUM(Sales)").unwrap(),
crates/ql-exec/src/workbook_runtime.rs:6513:    /// AGG-3-01: `SUM(BigRange)` does NOT rescan the range on an unrelated
crates/ql-exec/src/workbook_runtime.rs:6514:    /// write. We use a 1000-row range to make the cost asymmetric; a write
crates/ql-exec/src/workbook_runtime.rs:6515:    /// to a cell OUTSIDE the range, followed by `recompute_dirty`, should
crates/ql-exec/src/workbook_runtime.rs:6527:            rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:6550:            rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:6570:            let v = rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:6582:            "AGG-3-02: write inside range must invalidate"
crates/ql-exec/src/workbook_runtime.rs:6588:            let v = rt.set_formula(0, 0, 1, "SUM(BigRange)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:6593:    /// AGG-3-03: full-column aggregate remains compressed. We register a
crates/ql-exec/src/workbook_runtime.rs:6594:    /// `SUM(WholeCol)` where WholeCol is start_row=0, end_row=RowId::MAX
crates/ql-exec/src/workbook_runtime.rs:6622:            rt.set_formula(0, 0, 1, "SUM(WholeCol)").unwrap()
crates/ql-exec/src/workbook_runtime.rs:6627:        // Stripe still compressed: ONE Column-0 entry (verified at DIR-
crates/ql-exec/src/workbook_runtime.rs:6632:            "AGG-3-03: full-column dep registers a single stripe"
crates/ql-exec/src/workbook_runtime.rs:6977:    /// and `=SUM(Sales)` (not SIMD-eligible aggregate) edits then
crates/ql-exec/src/workbook_runtime.rs:6995:            rt.set_formula(0, 2, 1, "SUM(Sales)").unwrap(); // NotApplicable
crates/ql-exec/src/workbook_runtime.rs:7026:    // W5-53 — Phase 4.3 V2 range-aware dispatch (GAP-F-05 closure).
crates/ql-exec/src/workbook_runtime.rs:7031:    // `registry.lookup_range_aware` first and constructs `Vec<FnArg>`
crates/ql-exec/src/workbook_runtime.rs:7032:    // with per-arg range/scalar variants. These tests verify the
crates/ql-exec/src/workbook_runtime.rs:7034:    // `range_fns`).
crates/ql-exec/src/workbook_runtime.rs:7037:    /// SUMIF over a named range with numeric criteria.
crates/ql-exec/src/workbook_runtime.rs:7041:    fn w5_53_sumif_named_range_numeric_criteria() {
crates/ql-exec/src/workbook_runtime.rs:7077:    /// COUNTIF over a named range. `=COUNTIF(Sales, ">=5")` → 4 cells.
crates/ql-exec/src/workbook_runtime.rs:7079:    fn w5_53_countif_named_range() {
crates/ql-exec/src/workbook_runtime.rs:7096:    /// SUMIF with a 3-arg call: separate `sum_range`. Criteria range
crates/ql-exec/src/workbook_runtime.rs:7097:    /// holds labels; sum range holds the values. Demonstrates the
crates/ql-exec/src/workbook_runtime.rs:7098:    /// per-arg range distinction the W5-53 infra was built for.
crates/ql-exec/src/workbook_runtime.rs:7100:    fn w5_53_sumif_with_separate_sum_range() {
crates/ql-exec/src/workbook_runtime.rs:7131:    /// aggregate cache is BYPASSED for range-aware functions — they
crates/ql-exec/src/workbook_runtime.rs:7133:    /// on every edit). When a cell in the criteria range changes,
crates/ql-exec/src/workbook_runtime.rs:7136:    fn w5_53_sumif_recomputes_on_range_cell_change() {
crates/ql-exec/src/workbook_runtime.rs:7166:    // pipeline. The 2D shape from `read_range_with_shape` flows
crates/ql-exec/src/workbook_runtime.rs:7199:    /// VLOOKUP with approximate match (default range_lookup=TRUE) on
crates/ql-exec/src/workbook_runtime.rs:7336:    /// AVERAGEIF: range [1, 2, 3, 4, 5], criteria ">2" → matches 3, 4,
crates/ql-exec/src/workbook_runtime.rs:7828:    // NOTE: `SUM(Sheet2!A1:A3)` (range literal as function arg) is a
crates/ql-exec/src/workbook_runtime.rs:7831:    // the AggregateNameRef path. Cross-sheet ranges through named
crates/ql-exec/src/workbook_runtime.rs:7832:    // ranges DO work; verified by the named-target tests below.
crates/ql-exec/src/workbook_runtime.rs:8174:    //   2. Array literal at A1 → spills to A1:A1+rows-1 × A1:A1+cols-1.
crates/ql-exec/src/workbook_runtime.rs:8362:        // Anchor cell validation passes (MAX_ROW is in range). Eval
crates/ql-exec/src/workbook_runtime.rs:8428:            // Spill A1:A1+3 horizontally.
crates/ql-exec/src/workbook_runtime.rs:9730:    /// range must bind cleanly — `is_aggregate_function` claims TRANSPOSE
crates/ql-exec/src/workbook_runtime.rs:9731:    /// so the binder routes the named-range arg through Range context.
crates/ql-exec/src/workbook_runtime.rs:9734:    fn set_formula_transpose_with_named_range_arg_binds_and_spills() {
crates/ql-exec/src/workbook_runtime.rs:9767:    /// ranges must bind. The binder previously rejected this with
crates/ql-exec/src/workbook_runtime.rs:9770:    fn set_formula_filter_with_named_range_args_binds_and_spills() {
crates/ql-exec/src/workbook_runtime.rs:9808:    /// range must update through recompute_dirty when the source cells
crates/ql-exec/src/workbook_runtime.rs:9812:    fn recompute_dirty_transpose_with_named_range_updates_on_value_change() {
crates/ql-exec/src/workbook_runtime.rs:9818:        // `AAA`) — those lex as a `BareColumn` and produce `Expr::RangeRef`
crates/ql-exec/src/workbook_runtime.rs:9819:        // BEFORE name resolution, shadowing the named range entirely.
crates/ql-exec/src/workbook_runtime.rs:9864:    fn recompute_dirty_filter_with_named_ranges_grows_footprint() {
crates/ql-exec/src/workbook_runtime.rs:10165:    /// table `Sales` with a `Qty` column; write `SUM(Sales[Qty])`; assert
crates/ql-exec/src/workbook_runtime.rs:10169:    /// - 4.8.C: parser Expr::StructuredRef + Combination/BareColumn.
crates/ql-exec/src/workbook_runtime.rs:10176:        use ql_storage::{TableColumn, TableMetadata};
crates/ql-exec/src/workbook_runtime.rs:10179:        let col = |id, name: &str| TableColumn {
crates/ql-exec/src/workbook_runtime.rs:10212:        let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:10214:        assert_eq!(v, Value::Number(100.0), "SUM(Sales[Qty]) = 10+20+30+40");
crates/ql-exec/src/workbook_runtime.rs:10222:        use ql_storage::{TableColumn, TableMetadata};
crates/ql-exec/src/workbook_runtime.rs:10235:                TableColumn {
crates/ql-exec/src/workbook_runtime.rs:10241:                TableColumn {
crates/ql-exec/src/workbook_runtime.rs:10272:    /// `narrow_structured_ref` out-of-range guard.
crates/ql-exec/src/workbook_runtime.rs:10275:        use ql_storage::{TableColumn, TableMetadata};
crates/ql-exec/src/workbook_runtime.rs:10287:            columns: vec![TableColumn {
crates/ql-exec/src/workbook_runtime.rs:10676:    /// served the pre-drop range and eval read the same data cells).
crates/ql-exec/src/workbook_runtime.rs:10686:        // column Qty, values 10/20, and B1 = SUM(Sales[Qty]).
crates/ql-exec/src/workbook_runtime.rs:10693:            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:10719:            "B1 = SUM(Sales[Qty]) must be dirty after Sales is dropped"
crates/ql-exec/src/workbook_runtime.rs:10739:            "B1 = SUM(Sales[Qty]) must produce #NAME? after Sales is dropped"
crates/ql-exec/src/workbook_runtime.rs:10744:    /// fanout. C1 = B1 + 1 depends on B1 = SUM(Sales[Qty]). Dropping
crates/ql-exec/src/workbook_runtime.rs:10760:            rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap(); // B1 = 30
crates/ql-exec/src/workbook_runtime.rs:10801:            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:10871:            rt.set_formula(0, 5, 0, "SUM(S[Q])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:10905:            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:10964:            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11026:                .set_formula(0, 10, 0, "SUM(Sales[[#Data], [Qty]])")
crates/ql-exec/src/workbook_runtime.rs:11105:            rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11106:            rt.set_formula(0, 11, 0, "SUM(Orders[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11145:            RuntimeError::TableColumnRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime.rs:11148:            other => panic!("expected TableColumnRejected, got {other:?}"),
crates/ql-exec/src/workbook_runtime.rs:11161:            RuntimeError::TableColumnNotFound { table, column } => {
crates/ql-exec/src/workbook_runtime.rs:11165:            other => panic!("expected TableColumnNotFound, got {other:?}"),
crates/ql-exec/src/workbook_runtime.rs:11190:            RuntimeError::TableColumnRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime.rs:11193:            other => panic!("expected TableColumnRejected, got {other:?}"),
crates/ql-exec/src/workbook_runtime.rs:11213:        // Only the CreateTable op landed; no RenameColumn op emitted.
crates/ql-exec/src/workbook_runtime.rs:11227:            rt.set_formula(0, 5, 0, "SUM(S[Q])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11232:        // CreateTable + PutFormula + RenameColumn + PutFormula (rewrite).
crates/ql-exec/src/workbook_runtime.rs:11235:            matches!(&ops[2], Op::RenameColumn { table, old_name, new_name }
crates/ql-exec/src/workbook_runtime.rs:11251:    /// data range; VEQ suppresses the write) but the hook
crates/ql-exec/src/workbook_runtime.rs:11265:            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11310:    fn resize_table_grow_rows_extends_sum_range() {
crates/ql-exec/src/workbook_runtime.rs:11323:            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11346:    /// re-extract closes. After `resize_table` grows the data range,
crates/ql-exec/src/workbook_runtime.rs:11347:    /// a cell write into the NEW row (outside the OLD range) must
crates/ql-exec/src/workbook_runtime.rs:11348:    /// dirty the formula via the calcgraph's range stripe and
crates/ql-exec/src/workbook_runtime.rs:11350:    /// stayed registered at the OLD range; the write silently missed;
crates/ql-exec/src/workbook_runtime.rs:11357:    fn resize_table_grow_then_recompute_dirty_picks_up_new_range_writes() {
crates/ql-exec/src/workbook_runtime.rs:11369:            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11389:        // (inside the new range, outside the old range). The formula's
crates/ql-exec/src/workbook_runtime.rs:11420:    fn resize_table_shrink_rows_truncates_sum_range() {
crates/ql-exec/src/workbook_runtime.rs:11435:            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11522:    /// (re-bind fails with UnknownTableColumn → mark_dirty), and
crates/ql-exec/src/workbook_runtime.rs:11525:    /// `UnknownTableColumn` in addition to `UnknownTable`.
crates/ql-exec/src/workbook_runtime.rs:11548:            let v = rt.set_formula(0, 0, 3, "SUM(Sales[Price])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11560:                "UnknownTableColumn must map to #NAME?, not RecomputeFailure — got: {:?}",
crates/ql-exec/src/workbook_runtime.rs:11567:            "SUM(Sales[Price]) → #NAME? after Price is removed by resize"
crates/ql-exec/src/workbook_runtime.rs:11788:    /// SUM(Sales[Qty]) using the just-created table works. Validates
crates/ql-exec/src/workbook_runtime.rs:11801:        let v = rt.set_formula(0, 5, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11809:        use ql_storage::{TableColumn, TableMetadata};
crates/ql-exec/src/workbook_runtime.rs:11821:            columns: vec![TableColumn {
crates/ql-exec/src/workbook_runtime.rs:11935:    /// **DE locale input canonicalizes to EN.** `SUM(2,5; 3,5)`
crates/ql-exec/src/workbook_runtime.rs:11936:    /// (DE — `,` decimal, `;` arg sep) → `SUM(2.5, 3.5)` (EN canon).
crates/ql-exec/src/workbook_runtime.rs:11943:        rt.set_formula(0, 0, 0, "SUM(2,5; 3,5)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:11947:            Some("SUM(2.5, 3.5)")
crates/ql-exec/src/workbook_runtime.rs:11992:    /// **Mixed-relativity R1C1 range REJECTED at parse time.**
crates/ql-exec/src/workbook_runtime.rs:11997:    fn mixed_relativity_r1c1_range_rejected_at_set_formula() {
crates/ql-exec/src/workbook_runtime.rs:12015:        use ql_storage::{TableColumn, TableMetadata};
crates/ql-exec/src/workbook_runtime.rs:12027:            columns: vec![TableColumn {
crates/ql-exec/src/workbook_runtime.rs:12055:    /// **`@A:A` (whole-column inside `@`) evals at formula's row.**
crates/ql-exec/src/workbook_runtime.rs:12056:    /// `@A:A` at cell (3, 1) → reads A4 (row 3, col 0).
crates/ql-exec/src/workbook_runtime.rs:12067:        let v = rt.set_formula(0, 3, 1, "@A:A").unwrap();
crates/ql-exec/src/workbook_runtime.rs:12163:    /// `SUM(2,5; 3,5)` in DE locale → canonical `SUM(2.5, 3.5)` in
crates/ql-exec/src/workbook_runtime.rs:12175:            rt.set_formula(0, 0, 0, "SUM(2,5; 3,5)").unwrap()
crates/ql-exec/src/workbook_runtime.rs:12184:            Some("SUM(2.5, 3.5)")
crates/ql-exec/src/workbook_runtime.rs:12252:            rt.set_formula(0, 0, 0, "SUM(1.5, 2.5)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:12276:    /// **`@SUM(scalar args)` evaluates identically to `SUM(scalar args)`.**
crates/ql-exec/src/workbook_runtime.rs:12279:    /// (Literal `SUM(A1:A3)` over a Range needs aggregate-arg binding
crates/ql-exec/src/workbook_runtime.rs:12280:    /// which v1 routes via named ranges only; using scalar args here
crates/ql-exec/src/workbook_runtime.rs:12287:        let v_no_at = rt.set_formula(0, 5, 0, "SUM(1, 2, 3)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:12288:        let v_with_at = rt.set_formula(0, 5, 1, "@SUM(1, 2, 3)").unwrap();
crates/ql-exec/src/workbook_runtime.rs:12370:            input: "@SUM(1, 2)",
crates/ql-exec/src/workbook_runtime.rs:12371:            expected_canonical: "@SUM(1, 2)",
crates/ql-exec/src/workbook_runtime.rs:12376:            input: "@SUM(1; 2)",
crates/ql-exec/src/workbook_runtime.rs:12377:            expected_canonical: "@SUM(1, 2)",
crates/ql-exec/src/workbook_runtime.rs:12382:            input: "@SUM(1; 2)",
crates/ql-exec/src/workbook_runtime.rs:12383:            expected_canonical: "@SUM(1, 2)",
crates/ql-exec/src/workbook_runtime.rs:12388:            input: "@SUM(R1C1, R2C2)",
crates/ql-exec/src/workbook_runtime.rs:12389:            expected_canonical: "@SUM($A$1, $B$2)",
crates/ql-exec/src/workbook_runtime.rs:12394:            input: "@SUM(R1C1; R2C2)",
crates/ql-exec/src/workbook_runtime.rs:12395:            expected_canonical: "@SUM($A$1, $B$2)",
crates/ql-exec/src/workbook_runtime.rs:12400:            input: "@SUM(R1C1; R2C2)",
crates/ql-exec/src/workbook_runtime.rs:12401:            expected_canonical: "@SUM($A$1, $B$2)",
crates/ql-exec/src/workbook_runtime.rs:12408:            input: "SUM(@A1, B2)",
crates/ql-exec/src/workbook_runtime.rs:12409:            expected_canonical: "SUM(@A1, B2)",
crates/ql-exec/src/workbook_runtime.rs:12414:            input: "SUM(@A1; B2)",
crates/ql-exec/src/workbook_runtime.rs:12415:            expected_canonical: "SUM(@A1, B2)",
crates/ql-exec/src/workbook_runtime.rs:12420:            input: "SUM(@A1; B2)",
crates/ql-exec/src/workbook_runtime.rs:12421:            expected_canonical: "SUM(@A1, B2)",
crates/ql-exec/src/workbook_runtime.rs:12426:            input: "SUM(@R1C1, R2C2)",
crates/ql-exec/src/workbook_runtime.rs:12427:            expected_canonical: "SUM(@$A$1, $B$2)",
crates/ql-exec/src/workbook_runtime.rs:12432:            input: "SUM(@R1C1; R2C2)",
crates/ql-exec/src/workbook_runtime.rs:12433:            expected_canonical: "SUM(@$A$1, $B$2)",
crates/ql-exec/src/workbook_runtime.rs:12438:            input: "SUM(@R1C1; R2C2)",
crates/ql-exec/src/workbook_runtime.rs:12439:            expected_canonical: "SUM(@$A$1, $B$2)",
crates/ql-exec/src/workbook_runtime.rs:12519:    /// `@<range>` is used at multiple cells in the same runtime
crates/ql-exec/src/workbook_runtime.rs:12520:    /// session. The W5-144 binder narrows `@A:A` at bind time using
crates/ql-exec/src/workbook_runtime.rs:12524:    /// canonical text `@A:A` would hit the cache and get the FIRST
crates/ql-exec/src/workbook_runtime.rs:12528:    /// "same `@<range>` formula at multiple cells" workload.
crates/ql-exec/src/workbook_runtime.rs:12530:    fn plan_cache_at_range_collision_across_cells_regression() {
crates/ql-exec/src/workbook_runtime.rs:12542:        let v1 = rt.set_formula(0, 3, 1, "@A:A").unwrap();
crates/ql-exec/src/workbook_runtime.rs:12546:            "first @A:A at row 3 must read A4"
crates/ql-exec/src/workbook_runtime.rs:12548:        let v2 = rt.set_formula(0, 5, 1, "@A:A").unwrap();
crates/ql-exec/src/workbook_runtime.rs:12552:            "second @A:A at row 5 must read A6, NOT the cached A4 plan"
crates/ql-exec/tests/reference_fns_step3_e2e.rs:56:fn isref_of_literal_range_returns_true() {
crates/ql-exec/tests/reference_fns_step3_e2e.rs:81:    // Using scalar args to avoid the SUM(A1:A3) bind-fail (S2-HIGH-3 /
crates/ql-exec/tests/reference_fns_step3_e2e.rs:83:    assert_eq!(eval_with_map("ISREF(SUM(1, 2))"), Value::Boolean(false));
crates/ql-exec/tests/reference_fns_step3_e2e.rs:115:fn isref_of_named_range_returns_true() {
crates/ql-exec/tests/reference_fns_step3_e2e.rs:187:fn isformula_of_multi_cell_range_returns_na() {
crates/ql-exec/tests/reference_fns_step3_e2e.rs:251:    // Named cell pointing at A1 (1×1 range).
crates/ql-exec/tests/reference_fns_step3_e2e.rs:260:    // 1×1 range → treated as single-cell → ISFORMULA queries A1 →
crates/ql-exec/tests/reference_fns_step3_e2e.rs:272:/// **S3-HIGH-4 closure:** ISREF with literal-range SUM arg bind-fails per
crates/ql-exec/tests/reference_fns_step3_e2e.rs:276:fn isref_of_sum_literal_range_bind_fails_v1_scope() {
crates/ql-exec/tests/reference_fns_step3_e2e.rs:277:    let tokens = lex("ISREF(SUM(A1:A3))").expect("lex");
crates/ql-exec/tests/reference_fns_step3_e2e.rs:282:        "v1 scope: ISREF(SUM(A1:A3)) bind-fails per S1-MED-γ AggregateArg \
crates/ql-exec/tests/reference_fns_step3_e2e.rs:287:/// **S3-HIGH-4 closure:** ISFORMULA with literal-range SUM arg bind-fails.
crates/ql-exec/tests/reference_fns_step3_e2e.rs:289:fn isformula_of_sum_literal_range_bind_fails_v1_scope() {
crates/ql-exec/tests/reference_fns_step3_e2e.rs:290:    let tokens = lex("ISFORMULA(SUM(A1:A3))").expect("lex");
crates/ql-exec/tests/reference_fns_step3_e2e.rs:295:        "v1 scope: ISFORMULA(SUM(A1:A3)) bind-fails per S1-MED-γ \
crates/ql-exec/tests/oplog_e2e.rs:591:        let _ = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/tests/oplog_e2e.rs:614:        "post-replay SUM(Sales[Qty]) matches producer"
crates/ql-exec/tests/oplog_e2e.rs:643:/// `Op::RenameColumn` + `Op::PutFormula` for each rewritten cell;
crates/ql-exec/tests/oplog_e2e.rs:659:        let _ = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/tests/oplog_e2e.rs:670:    // Column metadata reflects rename.
crates/ql-exec/tests/oplog_e2e.rs:697:        "post-replay SUM(Sales[Quantity]) matches producer"
crates/ql-exec/tests/oplog_e2e.rs:704:/// range and evaluates SUM correctly.
crates/ql-exec/tests/oplog_e2e.rs:721:        let _ = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/tests/oplog_e2e.rs:729:        // the SUM picks up the new range.
crates/ql-exec/tests/oplog_e2e.rs:749:    // Post-replay recompute confirms SUM picks up the new range.
crates/ql-exec/tests/oplog_e2e.rs:778:        let v = rt.set_formula(0, 5, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/tests/oplog_e2e.rs:805:    assert_eq!(text.as_ref(), "SUM(Sales[Qty])");
crates/ql-exec/tests/oplog_e2e.rs:810:        "post-load SUM(Sales[Qty]) matches pre-save"
crates/ql-exec/tests/oplog_e2e.rs:961:        let v = rt.set_formula(0, 5, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/tests/oplog_e2e.rs:984:    assert_eq!(text.as_ref(), "SUM(Sales[Quantity])");
crates/ql-exec/tests/oplog_e2e.rs:988:        "post-rename SUM(Sales[Quantity]) value preserved"
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:5://! - Implicit-intersection (`=@ROW(A1:A10)`).
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:91:    // data range top is row 1 (0-indexed) → 2 (1-indexed).
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:98:    // Top-left of `Sales[Qty]` data range — exact row depends on
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:103:        other => panic!("expected ROW = data range top-left (2..=6), got {other:?}"),
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:144:    // `Sales[@Qty]` narrowed to the formula's row → 1×1 range → ROWS = 1.
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:149:// Implicit-intersection (`=@ROW(A1:A10)`)
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:153:fn at_prefix_on_row_with_range_arg_returns_top_left() {
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:154:    // `@ROW(A1:A10)` — `@` is implicit-intersection on the OUTER fn call's
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:155:    // result. ROW(A1:A10) in scalar context returns top-left = 1. `@1` is
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:160:    let tokens = lex("@ROW(A1:A10)").expect("lex");
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:173:fn at_prefix_on_columns_with_range_arg_returns_columns() {
crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:307:    let tokens = lex("ROWS(A:A)").expect("lex");
crates/ql-exec/tests/error_precedence.rs:40:// §3.3 Row 1: =SUM(A1, B1) where A1=#REF!, B1=#NUM! → #REF! (first arg wins)
crates/ql-exec/tests/error_precedence.rs:55:    // =SUM(A1, B1) — both args are errors. Left wins.
crates/ql-exec/tests/error_precedence.rs:56:    let v = eval(&mut rt, 0, 1, 0, "SUM(A1, B1)");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:33://     named ranges + custom format codes; then mutate and verify
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:75:        let v1 = rt.set_formula(s2, 0, 0, "SUM(Sales[Qty])").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:77:        let v2 = rt.set_formula(s2, 0, 1, "SUM(QtyRange)").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:78:        println!("[W1A pre-resize] structured-ref={v1:?} named-range={v2:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:99:            "[W1A FINDING] resize_table did not re-fire SUM(Sales[Qty]); \
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:104:        println!("[W1A] named range surprisingly auto-extended: got {v2_after:?}, expected 60.0");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:124:        let before = rt.set_formula(s2, 0, 0, "SUM(T[Qty])").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:134:    assert_eq!(after, Value::Number(30.0), "post-rename SUM(T[Qty])");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:279:    let v = rt.set_formula(s, 0, 0, "SUM(1;2;3)");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:280:    println!("[W3B] de-locale SUM(1;2;3) = {v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:284:            Expected SUM(1;2;3) = 6.0, got {v:?}"
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:305:        let _ = rt.set_formula(0, 1, 0, "SUM(A1, B1, C1)").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:469:        let v = rt.set_formula(s, 10, 0, "SUM(T[Q])").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:599:fn i6_name_target_range_inside_table_after_resize() {
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:612:        rt.set_formula(s, 10, 0, "SUM(DataAlias)").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:618:    println!("[I6] after resize, SUM(DataAlias) = {v_after:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:621:            "[I6 FINDING] name target range changed after table resize \
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:729:        let v = rt.set_formula(s1, 5, 0, "SUM(MyTable[X])");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:730:        println!("[I10] formula SUM(MyTable[X]) post-collision = {v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:765:/// into its data range. Does the name keep working?
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:768:fn i12_drop_table_name_pointing_into_data_range_still_works() {
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:781:        rt.set_formula(s, 5, 0, "SUM(MyData)").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:790:    println!("[I12] after drop_table, SUM(MyData) = {v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:842:/// I25: range-aware functions with literal ranges. SUMIF, AVERAGEIF
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:843:/// etc. — does Phase 4.10 allow literal range arg or require named range?
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:846:fn i25_range_aware_fn_with_literal_range_arg() {
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:857:    // SUMIF with literal range
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:866:            "[I25 FINDING] range-aware fn (SUMIF/VLOOKUP) with literal range arg \
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:900:    let v = rt.set_formula(s_report, 0, 0, "SUM(Sales[X])");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:901:    println!("[I26] SUM(Sales[X]) from third sheet: {v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:905:/// I27: name covering a range that becomes invalid after sheet rename
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:909:fn i27_named_range_survives_sheet_rename() {
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:918:    rt.set_formula(s, 5, 0, "SUM(MyRange)").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:922:    println!("[I27] post-rename SUM(MyRange) = {v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:925:            "[I27 FINDING] named range broken after host sheet rename: {v:?}, \
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:951:    // Compare with TRANSPOSE over a named range covering the same cells.
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:959:            but TRANSPOSE over named range works ({v_named:?}). Phase 4.7 \
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:979:    let s_v = rt.set_formula(s, 10, 0, "SUM(Vals)").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:982:    println!("[I24] SUM(Vals)={s_v:?}, COUNT={c_v:?}, COUNTA={ca_v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1092:/// I18: `=SUM(A:A)` whole-column reference.
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1103:    let v = rt.set_formula(s, 5, 0, "SUM(A:A)");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1104:    println!("[I18] SUM(A:A) = {v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1106:        println!("[I18 FINDING] SUM(A:A) whole-column literal range failed: {e}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1110:/// I19: `=Sheet2!A:A` cross-sheet whole-column with a name.
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1124:    let v = rt.set_formula(s1, 0, 0, "SUM(ColA)").unwrap();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1125:    println!("[I19] SUM(ColA) cross-sheet column = {v:?}");
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1150:            rt.set_formula(s2, i, 0, "SUM(Big[X])").unwrap();
crates/ql-exec/tests/p412_function_arg_fuzz.rs:11://! massive magnitudes, empty / single-cell / 1M-cell ranges, all-error
crates/ql-exec/tests/p412_function_arg_fuzz.rs:12://! ranges, mixed-type ranges, and self-referential ranges.
crates/ql-exec/tests/p412_function_arg_fuzz.rs:191:        ("PERCENTILE({1}, -0.1)", "k out of range"),
crates/ql-exec/tests/p412_function_arg_fuzz.rs:192:        ("PERCENTILE({1}, 1.1)", "k out of range"),
crates/ql-exec/tests/p412_function_arg_fuzz.rs:206:// ─── Self-referential ranges ───────────────────────────────────────────────
crates/ql-exec/tests/p412_function_arg_fuzz.rs:222:/// SUM(A:A) inside A1 — self-referential range.
crates/ql-exec/tests/p412_function_arg_fuzz.rs:228:    let outcome = try_set_formula(&mut rt, 0, 0, "SUM(A:A)");
crates/ql-exec/tests/p412_function_arg_fuzz.rs:331:// ─── Huge range fan-in ─────────────────────────────────────────────────────
crates/ql-exec/tests/p412_function_arg_fuzz.rs:333:/// SUM over a 1M-cell whole-column range with sparse data.
crates/ql-exec/tests/p412_function_arg_fuzz.rs:344:        rt.set_formula(0, 0, 5, "SUM(A:A)")
crates/ql-exec/tests/p412_function_arg_fuzz.rs:389:    let mut s = String::from("SUM(1");
crates/ql-exec/tests/region_mul2_e2e.rs:126:    // =SUM(A1, A2, A3) with values 10, 20, 30 → 60
crates/ql-exec/tests/region_mul2_e2e.rs:128:        "SUM(A1, A2, A3)",
crates/ql-exec/tests/region_mul2_e2e.rs:222:// These functions take Range args which need named-range or table-ref
crates/ql-exec/tests/region_mul2_e2e.rs:224:// helper. The unit tests in range_fns::tests cover the function
crates/ql-exec/tests/region_mul2_e2e.rs:233:        registry.lookup_range_aware("MINIFS").is_some(),
crates/ql-exec/tests/region_mul2_e2e.rs:237:        registry.lookup_range_aware("MAXIFS").is_some(),
crates/ql-exec/tests/region_mul2_e2e.rs:241:        registry.lookup_range_aware("COUNTBLANK").is_some(),
crates/ql-exec/tests/region_mul2_e2e.rs:361:    // named-range bindings; unit tests in range_fns cover the
crates/ql-exec/tests/region_mul2_e2e.rs:364:    assert!(registry.lookup_range_aware("SUMX2MY2").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:365:    assert!(registry.lookup_range_aware("SUMX2PY2").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:366:    assert!(registry.lookup_range_aware("SUMXMY2").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:389:    assert!(registry.lookup_range_aware("NPV").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:390:    assert!(registry.lookup_range_aware("IRR").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:445:    assert!(registry.lookup_range_aware("TEXTJOIN").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:498:    // through the lightweight `bind(&ast, 0)` test helper (no range
crates/ql-exec/tests/region_mul2_e2e.rs:520:    assert!(registry.lookup_range_aware("PEARSON").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:521:    assert!(registry.lookup_range_aware("pearson").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:522:    assert!(registry.lookup_range_aware("RSQ").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:523:    assert!(registry.lookup_range_aware("rsq").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:524:    assert!(registry.lookup_range_aware("STEYX").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:525:    assert!(registry.lookup_range_aware("steyx").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:531:    // smoke check per the W5-176 / W5-177 pattern (range-arg
crates/ql-exec/tests/region_mul2_e2e.rs:533:    // named-range scaffolding).
crates/ql-exec/tests/region_mul2_e2e.rs:535:    assert!(registry.lookup_range_aware("SLOPE").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:536:    assert!(registry.lookup_range_aware("slope").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:537:    assert!(registry.lookup_range_aware("INTERCEPT").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:538:    assert!(registry.lookup_range_aware("intercept").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:543:    // W5-177: CORREL is RangeAwareFn; range-arg construction can't go
crates/ql-exec/tests/region_mul2_e2e.rs:545:    // named-range / table-ref scaffolding. Smoke-check via registry
crates/ql-exec/tests/region_mul2_e2e.rs:548:    assert!(registry.lookup_range_aware("CORREL").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:549:    assert!(registry.lookup_range_aware("correl").is_some()); // case-insensitive
crates/ql-exec/tests/region_mul2_e2e.rs:673:    // financial range-aware fns (NPV / IRR / MIRR). Verifies
crates/ql-exec/tests/region_mul2_e2e.rs:677:    assert!(registry.lookup_range_aware("XNPV").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:678:    assert!(registry.lookup_range_aware("xnpv").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:679:    assert!(registry.lookup_range_aware("XIRR").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:680:    assert!(registry.lookup_range_aware("xirr").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:694:    assert!(registry.lookup_range_aware("COVARIANCE.P").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:695:    assert!(registry.lookup_range_aware("covariance.p").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:696:    assert!(registry.lookup_range_aware("Covariance.P").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:697:    assert!(registry.lookup_range_aware("COVARIANCE.S").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:698:    assert!(registry.lookup_range_aware("covariance.s").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:699:    assert!(registry.lookup_range_aware("Covariance.S").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:720:    let p_inc = registry.lookup_range_aware("PERCENTILE.INC");
crates/ql-exec/tests/region_mul2_e2e.rs:721:    let p_exc = registry.lookup_range_aware("PERCENTILE.EXC");
crates/ql-exec/tests/region_mul2_e2e.rs:722:    let q_inc = registry.lookup_range_aware("QUARTILE.INC");
crates/ql-exec/tests/region_mul2_e2e.rs:723:    let q_exc = registry.lookup_range_aware("QUARTILE.EXC");
crates/ql-exec/tests/region_mul2_e2e.rs:724:    let p_alias = registry.lookup_range_aware("PERCENTILE");
crates/ql-exec/tests/region_mul2_e2e.rs:725:    let q_alias = registry.lookup_range_aware("QUARTILE");
crates/ql-exec/tests/region_mul2_e2e.rs:759:    assert!(registry.lookup_range_aware("percentile.inc").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:760:    assert!(registry.lookup_range_aware("Percentile.Exc").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:761:    assert!(registry.lookup_range_aware("quartile.inc").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:762:    assert!(registry.lookup_range_aware("Quartile.Exc").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:763:    assert!(registry.lookup_range_aware("percentile").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:764:    assert!(registry.lookup_range_aware("quartile").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:774:    assert!(registry.lookup_range_aware("SUBTOTAL").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:775:    assert!(registry.lookup_range_aware("subtotal").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:776:    assert!(registry.lookup_range_aware("SubTotal").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:818:    // W5-174: MIRR is RangeAwareFn; range-arg construction can't go
crates/ql-exec/tests/region_mul2_e2e.rs:820:    // named-range / table-ref scaffolding, so we smoke-check via
crates/ql-exec/tests/region_mul2_e2e.rs:823:    assert!(registry.lookup_range_aware("MIRR").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:824:    assert!(registry.lookup_range_aware("mirr").is_some()); // case-insensitive
crates/ql-exec/tests/region_mul2_e2e.rs:860:    assert!(registry.lookup_range_aware("XLOOKUP").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:861:    assert!(registry.lookup_range_aware("XMATCH").is_some());
crates/ql-exec/tests/region_mul2_e2e.rs:914:    // =IF(SUM(A1, A2) > 50, "big", AVERAGE(A1, A2) * 2)
crates/ql-exec/tests/region_mul2_e2e.rs:917:        r#"IF(SUM(A1, A2) > 50, "big", AVERAGE(A1, A2) * 2)"#,
crates/ql-exec/tests/region_mul2_e2e.rs:927:        r#"IF(SUM(A1, A2) > 50, "big", AVERAGE(A1, A2) * 2)"#,
crates/ql-exec/tests/region_mul2_e2e.rs:942:    // bare column A becomes a WholeColumn range, but the classifier currently expects
crates/ql-exec/tests/region_mul2_e2e.rs:972:    // =A * 2 — bare column lexes to BareColumn → parser produces RangeRef::WholeColumn,
crates/ql-exec/tests/region_mul2_e2e.rs:978:    // use SUM(A:A) / etc. for whole-column references.
crates/ql-exec/tests/region_mul2_e2e.rs:1005:fn rangeref_reexport_compiles() {
crates/ql-exec/tests/region_mul2_e2e.rs:1008:    let _ = RangeRef::WholeColumn {
crates/ql-exec/tests/ide_simulation.rs:115:    // A named-range scalar misuse surfaces a specific precise variant
crates/ql-exec/tests/ide_simulation.rs:192:        // Summary formula at (3, 0): SUM(A1, A2, A3) — using individual
crates/ql-exec/tests/ide_simulation.rs:193:        // cell refs since SUM(A1:A3) range syntax isn't yet supported in
crates/ql-exec/tests/ide_simulation.rs:195:        tx.put_formula(0, 3, 0, "SUM(A1, A2, A3)").unwrap();
crates/ql-exec/tests/ide_simulation.rs:219:        Some("SUM(A1, A2, A3)")
crates/ql-exec/tests/ide_simulation.rs:224:/// text, named ranges, and op log length. The full round-trip works
crates/ql-exec/tests/distribution_fns_e2e.rs:406:    // range check but `inverse_cdf(1.0)` is non-finite → `#NUM!` via
crates/ql-exec/tests/distribution_fns_e2e.rs:575:fn binom_dist_range_full_through_dispatcher_returns_one() {
crates/ql-exec/tests/distribution_fns_e2e.rs:580:fn binom_dist_range_three_arg_form_through_dispatcher() {
crates/ql-exec/tests/distribution_fns_e2e.rs:586:fn binom_dist_range_reversed_through_dispatcher_returns_num_error() {
crates/ql-exec/tests/distribution_fns_e2e.rs:608:    // `(0.0..1.0)` half-open range incorrectly rejected this.
crates/ql-exec/tests/reference_fns_step4_e2e.rs:80:    wb.put_formula(0, 1, 1, "SUM(B1:B3)+1");
crates/ql-exec/tests/reference_fns_step4_e2e.rs:95:            assert_eq!(text.as_ref(), "=SUM(B1:B3)+1");
crates/ql-exec/tests/reference_fns_step4_e2e.rs:133:fn formulatext_of_1x1_range_pointing_at_formula_returns_text() {
crates/ql-exec/tests/reference_fns_step4_e2e.rs:137:    // FORMULATEXT(A1:A1) — 1×1 range → treated as single-cell.
crates/ql-exec/tests/reference_fns_step4_e2e.rs:138:    let tokens = lex("FORMULATEXT(A1:A1)").expect("lex");
crates/ql-exec/tests/reference_fns_step4_e2e.rs:151:fn formulatext_of_multi_cell_range_returns_na() {
crates/ql-exec/tests/reference_fns_step4_e2e.rs:240:// Cross-sheet + named-range paths
crates/ql-exec/tests/reference_fns_step4_e2e.rs:279:fn formulatext_of_sum_literal_range_bind_fails_v1_scope() {
crates/ql-exec/tests/reference_fns_step4_e2e.rs:280:    // S2-HIGH-3 propagation: literal-range nested SUM bind-fails per
crates/ql-exec/tests/reference_fns_step4_e2e.rs:282:    let tokens = lex("FORMULATEXT(SUM(A1:A3))").expect("lex");
crates/ql-exec/tests/reference_fns_step4_e2e.rs:287:        "v1 scope: FORMULATEXT(SUM(A1:A3)) bind-fails per S1-MED-γ \
crates/ql-exec/tests/reference_tier_dispatcher_smoke.rs:42:        RefArg::Range { range, values } => {
crates/ql-exec/tests/reference_tier_dispatcher_smoke.rs:48:            let rows = range.end_row - range.start_row + 1;
crates/ql-exec/tests/reference_tier_dispatcher_smoke.rs:49:            let cols = range.end_col - range.start_col + 1;
crates/ql-exec/tests/reference_tier_dispatcher_smoke.rs:216:    // Function (SUM with scalar literal args — avoids the SUM(A1:A3)
crates/ql-exec/tests/reference_tier_dispatcher_smoke.rs:222:        bind_and_eval("__RT_LAZY__(SUM(1, 2, 3))", &env, &reg),
crates/ql-exec/tests/reference_fns_e2e.rs:44:fn row_of_literal_range_returns_top_left_row() {
crates/ql-exec/tests/reference_fns_e2e.rs:103:fn column_of_literal_range_returns_top_left_col() {
crates/ql-exec/tests/reference_fns_e2e.rs:145:    // LibreOffice cross-check: ROWS(A:A) = 1_048_576.
crates/ql-exec/tests/reference_fns_e2e.rs:146:    assert_eq!(eval_with_map("ROWS(A:A)"), Value::number(1_048_576.0));
crates/ql-exec/tests/reference_fns_e2e.rs:215:fn row_of_multi_cell_range_at_cell_boundary_returns_calc_error() {
crates/ql-exec/tests/reference_fns_e2e.rs:231:fn row_of_single_cell_range_at_cell_boundary_returns_top_left() {
crates/ql-exec/tests/reference_fns_e2e.rs:232:    // Single-cell range A5:A5 → not multi-cell → guard doesn't fire →
crates/ql-exec/tests/reference_fns_e2e.rs:246:fn column_of_multi_cell_range_at_cell_boundary_returns_calc_error() {
crates/ql-exec/tests/reference_fns_e2e.rs:259:fn row_in_scalar_context_with_range_returns_top_left() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:2://! S2-HIGH-1 closure (named-range + cross-sheet + workbook-runtime
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:3://! formula-cell paths) and S2-HIGH-3 closure (pin `ROW(SUM(A1:A3))`
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:10://! Structured-ref and implicit-intersection (`@ROW(A1:A10)`) coverage
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:37:// Named-range coverage (S2-HIGH-1)
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:41:fn rows_of_named_range_returns_range_height() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:43:    // NamedRange `Sales` covers Sheet1!A1:A10 → ROWS(Sales) = 10.
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:44:    let range = Range::new(0, 0, 0, 9, 0);
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:45:    wb.set_name("Sales", NamedTarget::Range(range)).unwrap();
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:55:fn columns_of_named_range_returns_range_width() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:57:    let range = Range::new(0, 0, 0, 0, 4);
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:58:    wb.set_name("Headers", NamedTarget::Range(range)).unwrap();
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:70:fn row_of_named_range_returns_top_left_row() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:72:    // Named range Sheet1!C3:E10 → ROW(MyRange) = 3 (top-left row 0-indexed → 2+1).
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:73:    let range = Range::new(0, 2, 2, 9, 4);
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:74:    wb.set_name("MyRange", NamedTarget::Range(range)).unwrap();
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:86:fn column_of_named_range_returns_top_left_col() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:88:    let range = Range::new(0, 2, 2, 9, 4);
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:89:    wb.set_name("MyRange", NamedTarget::Range(range)).unwrap();
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:131:fn rows_of_cross_sheet_range_returns_height() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:144:fn columns_of_cross_sheet_range_returns_width() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:232:// S2-HIGH-3 closure: pin `ROW(SUM(A1:A3))` as a documented v1 bind-error
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:236:fn row_of_sum_literal_range_bind_fails_v1_scope() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:238:    // `ROW(SUM(A1:A3)) → #VALUE!` does NOT work in v1. The inner
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:245:    let tokens = lex("ROW(SUM(A1:A3))").expect("lex");
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:250:        "v1 scope: ROW(SUM(A1:A3)) bind-fails per S1-MED-γ AggregateArg defer; \
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:256:fn row_of_sum_named_range_works_via_existing_aggregate_path() {
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:257:    // The named-range form DOES work — `AggregateNameRef` is the
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:258:    // existing path. SUM(Sales) eagerly evaluates; ROW receives a Scalar
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:261:    let range = Range::new(0, 0, 0, 2, 0);
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:262:    wb.set_name("Sales", NamedTarget::Range(range)).unwrap();
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:264:    let plan = parse_and_bind_with_workbook("ROW(SUM(Sales))", &wb);
crates/ql-exec/tests/reference_fns_coverage_extensions.rs:267:    // SUM(Sales) = 0 (empty cells). ROW(Scalar) = #VALUE!.

exec
/bin/zsh -lc "awk 'NR>=180 && NR<=425 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
180:/// of the referenced cell. They keep value-deps as a v1 cost (the right
181:/// fix is a `formula_status_deps` dep kind that fires only on
182:/// `on_set_formula` / `on_clear_formula`, not on `set_value` — out of v1
183:/// scope per design § 8 R8).
184:///
185:/// **Audit context (S1-HIGH-A from `2026-05-17-rt-step-1-codex.md`):** the
186:/// initial Step 1 implementation suppressed *all* arg walking by fn name,
187:/// which dropped value-deps for non-reference arg shapes too — e.g.,
188:/// `ROW(A1+1)` lost A1's dep because the walker never descended into the
189:/// `Binary` arm even though the eager materializer evaluated A1+1 at
190:/// dispatch time. This pinned a false invariant ("ref-aware fn result
191:/// depends only on its arg's address") that the materializer doesn't
192:/// honor for non-reference shapes. The Step 1.1 closure switches to
193:/// **shape-aware** suppression — only direct `CellRef` / `RangeRef` args
194:/// skip value-deps; everything else (Binary / Unary / Function / etc.)
195:/// walks normally. See [`walk_plan_for_address_only_deps`] for the
196:/// per-shape rules.
197:///
198:/// **Invariant pin:** the `dep_suppressed_reference_fns_match_design`
199:/// test (S1-MED-ζ closure) asserts the list contents against the design's
200:/// explicit enumeration; spelling drift will surface there.
201:pub(crate) fn is_address_only_reference_fn(name: &str) -> bool {
202:    matches!(name, "ROW" | "COLUMN" | "ROWS" | "COLUMNS" | "ISREF")
203:}
204:
205:/// Phase 3.2 — direct-dep collection extracted from walking a bound
206:/// `ExprPlan`. Fields are owned (no borrows) so the caller can pass
207:/// the collection around or store it without lifetime ceremony.
208:///
209:/// `cells`, `named_ranges`, and `names` are deduplicated by the
210:/// `extract_and_register_deps` orchestrator (the walker emits
211:/// duplicates; the orchestrator collapses).
212:#[derive(Clone, Debug, Default, PartialEq)]
213:pub struct FormulaDeps {
214:    /// Direct cell references (`ExprPlan::CellRef`). Resolved sheet
215:    /// is included.
216:    pub cells: Vec<(SheetId, RowId, ColId)>,
217:    /// Named-range references (`ExprPlan::AggregateNameRef`). Each
218:    /// entry pairs the canonical (uppercase) name with the resolved
219:    /// `Range` payload.
220:    pub named_ranges: Vec<(Arc<str>, Range)>,
221:    /// Names referenced by the formula. Currently only names that
222:    /// resolve to ranges populate this (via `AggregateNameRef`); see
223:    /// module docs for the limitation around scalar-resolved names.
224:    pub names: Vec<Arc<str>>,
225:    /// **W5-154 (Phase 4.8.G.3 foundation):** table names referenced by
226:    /// the formula (via `ExprPlan::StructuredRef.table_name`). Used by
227:    /// the `table_to_formulas` reverse index for `on_table_*`
228:    /// mutation hooks. Populated alongside `named_ranges` (the
229:    /// resolved range still goes there for stripe registration).
230:    pub tables: Vec<Arc<str>>,
231:    /// `true` iff any volatile function appears anywhere in the
232:    /// plan tree.
233:    pub is_volatile: bool,
234:}
235:
236:impl FormulaDeps {
237:    /// Total dependency count (cells + named ranges). Useful for
238:    /// summary metrics; Phase 3.10 megaudit / ql-profile will surface
239:    /// per-formula dep counts in the graph-profile JSON.
240:    pub fn len(&self) -> usize {
241:        self.cells.len() + self.named_ranges.len()
242:    }
243:
244:    pub fn is_empty(&self) -> bool {
245:        self.cells.is_empty() && self.named_ranges.is_empty()
246:    }
247:}
248:
249:/// Phase 3.2 — recursive walker. Accumulates dependencies + volatile-
250:/// function presence by descending the `ExprPlan` tree. Does not
251:/// allocate any nodes or touch any graph state; pure read.
252:pub(crate) fn walk_plan_for_deps(plan: &ExprPlan, deps: &mut FormulaDeps) {
253:    match plan {
254:        ExprPlan::Number(_) | ExprPlan::Bool(_) | ExprPlan::String(_) => {
255:            // Leaf literals carry no dependencies.
256:        }
257:        ExprPlan::CellRef {
258:            sheet, row, col, ..
259:        } => {
260:            deps.cells.push((*sheet, *row, *col));
261:        }
262:        ExprPlan::Binary { lhs, rhs, .. } => {
263:            walk_plan_for_deps(lhs, deps);
264:            walk_plan_for_deps(rhs, deps);
265:        }
266:        ExprPlan::Unary { operand, .. } => {
267:            walk_plan_for_deps(operand, deps);
268:        }
269:        ExprPlan::Function { name, args } => {
270:            if is_volatile_function(name) {
271:                deps.is_volatile = true;
272:            }
273:            // **W5-RT-3.1 (S3-HIGH-2 closure — Codex MEDIUM-1 + Opus
274:            // HIGH-S3-O-2 convergent):** the dep walker now distinguishes
275:            // THREE policies per fn-name:
276:            //
277:            // 1. **ISREF** (LazyShape contract): NO arg walking at all.
278:            //    ISREF inspects the syntactic shape of its arg via
279:            //    `materialize_ref_arg_lazy` — it never evaluates Binary
280:            //    / Unary / Function subtrees, so registering their inner
281:            //    value-deps / volatility is pure waste. `ISREF(NOW())`
282:            //    must NOT mark the formula volatile; `ISREF(A1+1)` must
283:            //    NOT register A1's dep.
284:            //
285:            // 2. **ROW / COLUMN / ROWS / COLUMNS** (Eager + address-only):
286:            //    `walk_plan_for_address_only_deps` — skips value-deps on
287:            //    direct CellRef/RangeRef (their address is the input,
288:            //    addresses don't change without structural events), but
289:            //    recurses normally on Binary/Unary/Function subtrees
290:            //    because the eager materializer DOES evaluate those.
291:            //    `ROW(A1+1)` must keep A1's dep.
292:            //
293:            // 3. **ISFORMULA / FORMULATEXT** (Eager + workbook query):
294:            //    normal walker — value-deps as v1 cost per design § 8
295:            //    R8. A future `formula_status_deps` kind would
296:            //    differentiate; out of v1 scope.
297:            //
298:            // The previous Step 1.1 design routed ISREF through path 2,
299:            // which produced wrong behavior under LazyShape (Step 3
300:            // audit caught this).
301:            if name.as_ref() == "ISREF" {
302:                // LazyShape contract: NO arg walking. The args' inner
303:                // value-deps / volatility / structural deps don't
304:                // affect ISREF's result.
305:            } else if is_address_only_reference_fn(name) {
306:                for arg in args {
307:                    walk_plan_for_address_only_deps(arg, deps);
308:                }
309:            } else {
310:                for arg in args {
311:                    walk_plan_for_deps(arg, deps);
312:                }
313:            }
314:        }
315:        ExprPlan::AggregateNameRef { name, range } => {
316:            deps.named_ranges.push((Arc::clone(name), *range));
317:            deps.names.push(Arc::clone(name));
318:        }
319:        // **W5-RT-3.1 (S3-HIGH-3 / Codex Step 3 HIGH-2 closure):**
320:        // literal range refs bind to `ExprPlan::RangeRef { range }`
321:        // inside reference-aware fn arg lists. Consumers:
322:        //   - ROW/COLUMN/ROWS/COLUMNS: route through
323:        //     `walk_plan_for_address_only_deps`, which has its own
324:        //     `RangeRef` arm (no-op — addresses don't change without
325:        //     structural events). This arm is NOT reached for those.
326:        //   - ISREF (LazyShape): the `ExprPlan::Function` arm's
327:        //     `name == "ISREF"` branch SHORT-CIRCUITS all arg walking.
328:        //     This arm is NOT reached for ISREF either.
329:        //   - **ISFORMULA / FORMULATEXT (W5-RT-3 / W5-RT-4):** route
330:        //     through the normal walker AND can take 1×1-range args
331:        //     (treated as single-cell per design § 2.4). When the range
332:        //     is 1×1, push a cell-dep so the formula correctly dirties
333:        //     when the referenced cell's value/formula-status changes.
334:        //     Multi-cell ranges → `#N/A` per Microsoft canon (value-
335:        //     independent), so no dep is needed.
336:        //
337:        // The initial Step 1 implementation pushed a synthetic name
338:        // `__rt_literal_range__` into `named_ranges` here, which leaked
339:        // a private marker through the public `FormulaDeps.named_ranges`
340:        // field. Step 1.1 (S1-MED-δ) dropped that push, but in doing so
341:        // also dropped the legitimate 1×1 dep for `ISFORMULA(A1:A1)`.
342:        // Step 3.1 restores the 1×1 cell-dep narrowly — pushed into
343:        // `deps.cells` directly (no synthetic marker), only when the
344:        // range collapses to a single cell.
345:        ExprPlan::RangeRef { range } => {
346:            if range.start_row == range.end_row && range.start_col == range.end_col {
347:                deps.cells
348:                    .push((range.sheet, range.start_row, range.start_col));
349:            }
350:        }
351:        // **W5-99 (Phase 4.7.F):** array-literal and error-literal plans
352:        // have NO dependencies — they're pure constants. Array cells
353:        // are also restricted to literals (Number/Bool/String/Error),
354:        // so even walking the inner cells would yield zero deps.
355:        ExprPlan::Array(_) | ExprPlan::Error(_) => {
356:            // No deps; leaf literals.
357:        }
358:        // **W5-115 (Phase 4.8.F):** structured-ref dep extraction.
359:        // Treat the resolved range as a range dep (same path as
360:        // `AggregateNameRef`); the calcgraph stripe index handles
361:        // invalidation when any cell inside the table footprint
362:        // changes.
363:        //
364:        // **W5-154 (Phase 4.8.G.3 foundation):** ALSO push the table
365:        // name into `deps.tables` so the `table_to_formulas` reverse
366:        // index can find this formula when `on_table_*` mutation
367:        // hooks fire (table rename / drop / column rename / resize).
368:        ExprPlan::StructuredRef {
369:            table_name,
370:            resolved,
371:            ..
372:        } => {
373:            deps.named_ranges.push((Arc::clone(table_name), *resolved));
374:            deps.tables.push(Arc::clone(table_name));
375:        }
376:    }
377:}
378:
379:/// **W5-RT-1 / Step 1.1 (S1-HIGH-A closure):** shape-aware dep walker for
380:/// args of address-only reference-aware functions (ROW/COLUMN/ROWS/COLUMNS/
381:/// ISREF — see [`is_address_only_reference_fn`]). The default walker
382:/// [`walk_plan_for_deps`] would register value-deps on every direct
383:/// reference; this walker preserves the dep-suppress semantics for the
384:/// shapes that *truly* don't affect the calling fn's result, while still
385:/// recursing into eagerly-evaluated subtrees whose inputs DO affect it.
386:///
387:/// **Per-shape policy:**
388:///
389:/// - `CellRef` — no value-dep. The fn returns the cell's row/col index;
390:///   the cell's value is irrelevant. Addresses are stable under value
391:///   edits (only structural row/col-insert events change them, which
392:///   would be tracked separately by a future structural-dep mechanism).
393:/// - `RangeRef { range }` — no value-dep. ROWS/COLUMNS read `start_row` /
394:///   `end_row` / `start_col` / `end_col` from the resolved range; cell
395:///   values inside are irrelevant.
396:/// - `AggregateNameRef { name, range }` — register the NAME dep so name
397:///   rename / retarget invalidates this formula, but do NOT push to
398:///   `named_ranges` (no cell-stripe registration; range values don't
399:///   affect the result).
400:/// - `StructuredRef { table_name, resolved }` — register the TABLE name
401:///   dep so `on_table_*` mutation hooks fire, but no value-dep on the
402:///   resolved range.
403:/// - Everything else (Binary / Unary / Function / Array / Error / Number
404:///   / Bool / String) — walk normally via [`walk_plan_for_deps`]. The
405:///   eager materializer evaluates these args at dispatch time, so their
406:///   inner inputs DO affect the (typically `#VALUE!`) result class and
407:///   any error propagation. `ROW(A1+1)` MUST keep A1's dep; `ROW(NOW())`
408:///   MUST mark the formula volatile.
409:///
410:/// **Audit context (Codex S1-HIGH-1 / Opus S1-HIGH-3):** the initial
411:/// Step 1 implementation suppressed *all* arg walking by fn name, which
412:/// broke this invariant for non-reference arg shapes — `ROW(A1+1)` lost
413:/// A1's dep entirely. The Codex audit caught the asymmetry between
414:/// materializer eager-eval and walker suppression; the Opus audit
415:/// documented the resulting volatile re-firing under suppressed deps.
416:/// Step 1.1 closes both by making the walker shape-aware.
417:fn walk_plan_for_address_only_deps(plan: &ExprPlan, deps: &mut FormulaDeps) {
418:    match plan {
419:        // Direct reference shapes: skip value-deps. Address is the input.
420:        ExprPlan::CellRef { .. } | ExprPlan::RangeRef { .. } => {}
421:        // Structural-dep only: rename / retarget invalidates this
422:        // formula, but cell-stripe values inside the range don't.
423:        ExprPlan::AggregateNameRef { name, .. } => {
424:            deps.names.push(Arc::clone(name));
425:        }

exec
/bin/zsh -lc "awk 'NR>=650 && NR<=815 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
650:    /// reverse index (Phase 3.3) + the Graph's stripe-index ranges
651:    /// (Phase 3.3). Replaces any prior entry for the same formula
652:    /// node wholesale so re-bind cleanly drops stale session-side
653:    /// deps even though the Phase 0 graph's edges are append-only.
654:    ///
655:    /// **W5-50 (GAP-G-01 closure):** graph + stripe state is wholesale
656:    /// revoked before re-registration via `Graph::clear_outgoing` +
657:    /// `Graph::clear_range_deps_for_formula`. Prior comments here
658:    /// claimed stripe-side stale entries accumulated on re-bind; that
659:    /// was the Phase 0 append-only trade-off and is now fixed. The
660:    /// revocation is the documented exception to the append-only
661:    /// invariant — see `docs/architecture/2026-05-13-graph-storage-decision.md`.
662:    ///
663:    /// Internal — public callers go through `on_set_formula` or
664:    /// rebuild. `formula_node` MUST already exist in the graph (call
665:    /// `or_insert_cell_node` first if necessary). `formula_sheet` is
666:    /// the owning sheet of the formula cell; it's the fallback the
667:    /// `StripeIndex` uses when a range's own `sheet` is `None` (today
668:    /// every named-range conversion sets `Some(_)` so the fallback is
669:    /// inert, but the parameter is part of the stable graph API).
670:    fn extract_and_register_deps(
671:        &mut self,
672:        formula_node: NodeId,
673:        formula_sheet: SheetId,
674:        plan: &ExprPlan,
675:        workbook: &Workbook,
676:    ) {
677:        // First, evict any prior deps for this formula. Required so
678:        // re-binding a formula whose text changed (e.g. `=A1` → `=B1`)
679:        // doesn't leave the old cell-dep stamped on the session.
680:        self.remove_formula_deps(formula_node);
681:        // W5-50 (GAP-G-01 closure): also revoke prior graph edges +
682:        // stripe registrations. Without this, stale forward edges
683:        // create false `#CIRC!` cycles (megaudit H3) and stale stripe
684:        // entries falsely dirty the formula on writes to the OLD range
685:        // (megaudit H4). Idempotent on first-time bind.
686:        self.graph.clear_outgoing(formula_node);
687:        self.graph.clear_range_deps_for_formula(formula_node);
688:
689:        // Walk and collect.
690:        let mut deps = FormulaDeps::default();
691:        walk_plan_for_deps(plan, &mut deps);
692:
693:        // **W5-102 (Phase 4.7.I) — PRODUCER-ALIAS REWRITE.** Per design
694:        // § 10.1: if a CellRef points to a spill TARGET, reroute the
695:        // dependency to the ANCHOR's formula node. The anchor's
696:        // formula owns the computed value at the target cell; when
697:        // the anchor recomputes, every downstream reader of any
698:        // target cell must dirty. By rewriting the dep BEFORE
699:        // dedupe + register, the existing cell-dep machinery
700:        // (cell_to_formulas reverse index + graph.add_edge) handles
701:        // spill-target writes uniformly with regular cell writes.
702:        //
703:        // No new node types. Multiple targets of the same anchor
704:        // collapse to one dep via the dedupe step that follows.
705:        //
706:        // Hot-path note: this loop runs one `spill_target_anchor`
707:        // HashMap lookup PER cell-dep on EVERY `extract_and_register_deps`
708:        // call, even when the workbook has zero spills. A future
709:        // optimization could add a `Workbook::has_any_spills()` short-
710:        // circuit; W5-102 keeps it unconditional for simplicity. (See
711:        // W5-102 Codex audit LOW-3.)
712:        //
713:        // **Lifecycle handoff (Codex W5-102 HIGH-1, design § 10.5):**
714:        // this rewrite only fires for formulas bound AFTER the spill is
715:        // registered. If a reader B1=A2 was bound BEFORE A1 spilled to
716:        // A1:A3, its dep stays on (0,1,0) and won't get a graph edge
717:        // to the anchor — at registration time, only the writeback
718:        // caller can trigger re-extraction. This is closed by
719:        // Phase 4.7.J.4 (`reextract_spill_footprint_readers` in
720:        // `WorkbookRuntime::set_formula`), which calls
721:        // `reextract_deps` for every reader indexed under any cell
722:        // in the OLD or NEW spill footprint after a spill registers
723:        // or dissolves. See `workbook_runtime.rs:reextract_spill_footprint_readers`.
724:        for cell in deps.cells.iter_mut() {
725:            if let Some(anchor) = workbook.spill_target_anchor(cell.0, cell.1, cell.2) {
726:                *cell = anchor;
727:            }
728:        }
729:
730:        // Register: deduplicate (the walker emits duplicates if the
731:        // formula references the same cell twice; the session stores
732:        // each cell once). Also dedupe across producer-alias rewrites
733:        // — multiple targets of the same anchor collapse to one.
734:        let mut seen_cells: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
735:        deps.cells.retain(|c| seen_cells.insert(*c));
736:        let mut seen_names: HashSet<Arc<str>> = HashSet::new();
737:        deps.names.retain(|n| seen_names.insert(Arc::clone(n)));
738:        // named_ranges may contain the same name twice — that's
739:        // legitimate (`SUM(Sales) + AVERAGE(Sales)` references the
740:        // same range from two arg positions) — leave as-is.
741:
742:        // Phase 3.3: register direct cell deps on the session-side
743:        // reverse index. We do NOT create CellNodes for dep cells (no
744:        // need — the lookup at `on_set_value` is by (sheet, row, col)
745:        // tuple, not by NodeId).
746:        //
747:        // Phase 3.4: ALSO add a forward `graph.add_edge(formula_node,
748:        // dep_node)` when the dep cell is ITSELF a formula cell. The
749:        // Tarjan scheduler walks `graph.outgoing(formula_node)` to
750:        // discover the dep set; without this edge it can't order a
751:        // chain like `=A1`, `=B1=A1+1`, `=C1=B1+1` correctly.
752:        //
753:        // **W5-50 / W5-52 closure (GAP-G-01):** the original Phase 0
754:        // append-only contract HAS been relaxed. Re-bind now revokes
755:        // stale edges via `Graph::clear_outgoing` called from
756:        // `extract_and_register_deps` entry (line 453) and from
757:        // `on_clear_formula` (W5-52 audit closure). Stale-edge false
758:        // `#CIRC!` cycles can no longer occur. See
759:        // `docs/architecture/2026-05-13-graph-storage-decision.md`.
760:        for &(s, r, c) in &deps.cells {
761:            self.cell_to_formulas
762:                .entry((s, r, c))
763:                .or_default()
764:                .insert(formula_node);
765:            if let Some(&dep_node) = self.cell_index.get(&(s, r, c)) {
766:                // Note: self-edges (formula_node == dep_node) are
767:                // ALLOWED here — they're the canonical way to model
768:                // `=A1` at A1 (self-cycle), and the Phase 0 W3-3
769:                // Tarjan scheduler treats a self-looped single-node
770:                // SCC as `cycled`.
771:                self.graph.add_edge(formula_node, dep_node);
772:            }
773:        }
774:        // Phase 3.3: register named-range deps with the Graph's stripe
775:        // index. The Graph's `register_range_dependency` populates BOTH
776:        // the stripe map AND the `formula_to_range_deps` precision-check
777:        // map atomically. We pass the formula's owning sheet as the
778:        // fallback (today every conversion sets `range.sheet =
779:        // Some(_)`, so the fallback is unused).
780:        for (_, range) in &deps.named_ranges {
781:            let range_ref = range_to_rangeref(*range);
782:            self.graph
783:                .register_range_dependency(formula_node, range_ref, formula_sheet);
784:        }
785:
786:        if deps.is_volatile {
787:            self.volatile_formulas.insert(formula_node);
788:        }
789:        for name in &deps.names {
790:            self.name_to_formulas
791:                .entry(Arc::clone(name))
792:                .or_default()
793:                .insert(formula_node);
794:        }
795:        // **W5-154 (Phase 4.8.G.3 foundation):** populate
796:        // `table_to_formulas` for every StructuredRef table dep.
797:        // Mirrors the `name_to_formulas` pattern above — the
798:        // `on_table_*` hooks (drop today; rename/column/resize in
799:        // follow-up commits) walk this index to BFS-fan dirty.
800:        for table_name in &deps.tables {
801:            self.table_to_formulas
802:                .entry(Arc::clone(table_name))
803:                .or_default()
804:                .insert(formula_node);
805:        }
806:        if !deps.is_empty() || deps.is_volatile {
807:            self.formula_deps.insert(formula_node, deps);
808:        }
809:    }
810:
811:    /// Internal: remove all session-side dep state for `formula_node`.
812:    /// Used when a formula is re-bound (different text → different
813:    /// deps) or cleared. Cleans `formula_deps`, the volatile set, the
814:    /// name→formulas reverse index, and the cell→formulas reverse
815:    /// index. Does NOT touch the `Graph`'s stripe state or edges —

exec
/bin/zsh -lc "awk 'NR>=30 && NR<=60 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
30:pub enum NamedTarget {
31:    /// Named single cell (`SalesRow1 = $A$1`).
32:    Cell(Address),
33:    /// Named range (`Sales = $A$2:$A$1000`).
34:    Range(Range),
35:    /// Named constant (`TaxRate = 0.21`).
36:    Constant(Value),
37:    /// Named formula (`Profit = Revenue - Costs`). Stored as the raw formula source; the
38:    /// binder re-parses + evaluates in the use-site context. Phase 3+ feature.
39:    Formula(std::sync::Arc<str>),
40:}
41:
42:/// Defined-names table.
43:///
44:/// Phase 2A.1 (2026-05-12): real workbook-scope storage. Phase 2A.6 audit fix
45:/// (H2/M6/D5): canonicalization is enforced at the **insert** boundary — `set`
46:/// uppercases the key on write, so every entry lives at its canonical
47:/// upper-case form. `lookup` is case-sensitive on canonical form (fast path for
48:/// the parser, which already canonicalizes); `lookup_ci` exists as a
49:/// belt-and-suspenders entry point for callers that bypass the parser
50:/// canonicalization. Sheet-scope names (Excel's `Sheet1!Local`) are deferred to
51:/// Phase 3+ ql-formula-semantics.
52:///
53:/// ## Generation counter (Phase 2B.3)
54:///
55:/// `generation` is bumped on every successful `set` / `clear`. Bind-plan
56:/// caches in `ql-exec` key cached plans by `(formula_text, sheet,
57:/// generation)` so a name registration / rename invalidates affected plans
58:/// without an explicit cache-flush call — the next lookup just misses.
59:#[derive(Clone, Debug, Default)]
60:pub struct NameTable {

exec
/bin/zsh -lc "awk 'NR>=1300 && NR<=1340 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/plan.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1300:            Ok(resolved as u32)
1301:        }
1302:    }
1303:}
1304:
1305:/// Variant describing a resolved name's target, mapped from `ql_storage::NamedTarget`.
1306:/// Phase 2A.1: this is the binder's intermediate vocabulary — the binder doesn't
1307:/// import ql-storage directly, so the lookup trait projects NamedTarget into this
1308:/// enum first. Phase 2 supports Cell + Constant; Range and Formula return
1309:/// unsupported errors.
1310:///
1311:/// Phase 2A.6 audit M2/M3: added `Blank` and `ErrorValue` so the binder can
1312:/// surface them as distinct `BindError` variants instead of either coercing
1313:/// silently or returning the wrong error class.
1314:#[derive(Clone, Debug, PartialEq)]
1315:pub enum ResolvedName {
1316:    Cell(SheetId, RowId, ColId, bool, bool),
1317:    Number(f64),
1318:    Bool(bool),
1319:    Text(Arc<str>),
1320:    /// `NamedTarget::Range(_)` resolved with payload. Phase 2B.4 (2026-05-12):
1321:    /// previously carried no data; now threads the underlying `Range` so the
1322:    /// binder can pre-resolve into `ExprPlan::AggregateNameRef` without
1323:    /// asking the name table again at eval time.
1324:    Range(Range),
1325:    /// `NamedTarget::Formula(_)` resolved with payload. Phase 2B.4 added the
1326:    /// formula text payload; the binder rejects this for now (named-formula
1327:    /// resolution is Engine Phase 4) but the shape is in place.
1328:    Formula(Arc<str>),
1329:    /// `NamedTarget::Constant(Value::Blank)`. The binder rejects this loudly so
1330:    /// the caller can fix the data binding.
1331:    Blank,
1332:    /// `NamedTarget::Constant(Value::Error(...))`. The binder rejects with a
1333:    /// distinct error carrying the underlying `ErrorValue`.
1334:    ErrorValue(ErrorValue),
1335:}
1336:
1337:/// Name-resolution interface. `ql-exec` stays decoupled from `ql-storage`;
1338:/// the production caller wires a `Workbook` through this trait.
1339:///
1340:/// **W5-92 (Phase 4.6.D):** the trait now takes `owning_sheet` so impls

exec
/bin/zsh -lc "awk 'NR>=356 && NR<=395 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/plan.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "awk 'NR>=900 && NR<=970 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/plan.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
356:/// Phase 2B.4 (2026-05-12): bind-time context for a sub-expression. Drives
357:/// per-name-ref decisions about whether a `NamedTarget::Range` is acceptable
358:/// (aggregate-arg) or surfaces as `BindError::NamedRangeInScalarContext`
359:/// (scalar). Internal to the binder; not exposed in the public API yet.
360:#[derive(Clone, Copy, Debug, PartialEq, Eq)]
361:enum BindContext {
362:    /// Default. NameRefs resolving to ranges or formulas are rejected with
363:    /// precise errors.
364:    Scalar,
365:    /// Inside the argument list of an aggregate function (SUM, AVERAGE,
366:    /// MIN, MAX, COUNT, etc. — see `is_aggregate_function`). NameRefs
367:    /// resolving to ranges bind to `ExprPlan::AggregateNameRef`; named
368:    /// formulas still error (Engine Phase 4 work). Step 1.1 closure
369:    /// (S1-LOW-2): the design v2 proposed renaming the matcher to
370:    /// `accepts_special_arg_at_bind`; that rename did not ship (see
371:    /// S1-HIGH-D — parallel-matcher approach kept instead). Doc-comment
372:    /// reverted to reference the actual matcher.
373:    AggregateArg,
374:    /// **W5-RT-1 (RT-V1-01):** inside the argument list of a reference-aware
375:    /// function (ROW, COLUMN, ROWS, COLUMNS, ISREF, ISFORMULA, FORMULATEXT).
376:    /// Same shape as `AggregateArg` for NameRef-resolves-to-range AND
377:    /// (NEW) accepts literal `Expr::RangeRef` lowering to
378:    /// `ExprPlan::RangeRef { range }`. CellRef args bind as
379:    /// `ExprPlan::CellRef` unchanged. The scope of the `RangeRef`
380:    /// lowering is intentionally narrow in v1: only this context accepts
381:    /// literal ranges. `AggregateArg`-side enabling (which would make
382:    /// `SUM(A1:B3)` work — currently a `BindError::UnsupportedVariant`)
383:    /// is a separate follow-up since the multi-tier dispatcher (scalar /
384:    /// range-aware / unified) would also need new `RangeRef` arms.
385:    ReferenceArg,
386:}
387:
388:/// Phase 2B.4 (2026-05-12): hardcoded list of functions whose arguments
389:/// accept aggregate-range / named-range inputs. The function name is
390:/// historical — this list is now better understood as "names for which
391:/// the binder allows `AggregateNameRef` in arg positions"; both scalar
392:/// aggregates (SUM, AVERAGE) AND range-aware functions (SUMIF, VLOOKUP,
393:/// LARGE, ...) live here. The `is_aggregate_function_lists_only_registered_aggregates`
394:/// test invariant pins the cross-table sync.
395:///

 succeeded in 0ms:
900:                        Ok(ExprPlan::AggregateNameRef {
901:                            name: name.clone(),
902:                            range,
903:                        })
904:                    }
905:                    BindContext::Scalar => Err(BindError::NamedRangeInScalarContext(name.clone())),
906:                },
907:                // Phase 2B.4: named formulas still unsupported (Engine Phase 4).
908:                // We surface a distinct error rather than the generic
909:                // UnsupportedVariant so the IDE can render a specific hint.
910:                Some(ResolvedName::Formula(_)) => {
911:                    Err(BindError::NamedFormulaUnsupported(name.clone()))
912:                }
913:                // Phase 2A.6 audit M2/M3: surface Blank- and Error-targets loudly.
914:                Some(ResolvedName::Blank) => Err(BindError::NamedTargetIsBlank(name.clone())),
915:                Some(ResolvedName::ErrorValue(e)) => {
916:                    Err(BindError::NamedTargetIsError(name.clone(), e))
917:                }
918:                None => Err(BindError::UnresolvedName(name.clone())),
919:            }
920:        }
921:        // **W5-115 (Phase 4.8.F):** resolve structured ref against
922:        // TableLookup. The `[@Col]` form returns a column-wide range
923:        // plus `is_this_row: true`; eval narrows to a single cell.
924:        Expr::StructuredRef { table_name, spec } => {
925:            resolve_structured_ref(table_name, spec, tables)
926:        }
927:        // **W5-140 (Phase 4.9.C binder):** lower the intermediate
928:        // R1C1 reference to an absolute `ExprPlan::CellRef`.
929:        // Absolute axes (`AxisSpec::Abs(n)`) drop straight in as
930:        // 0-indexed `n - 1` (R1C1 is 1-indexed in source per Excel
931:        // canon; both axis bounds are already enforced at lex time
932:        // and re-checked here for defense-in-depth). Relative axes
933:        // (`AxisSpec::Rel(offset)`) resolve against the formula's
934:        // anchor cell from `site.cell`; without a cell anchor we
935:        // fail with `BindError::R1C1RequiresAnchor` rather than
936:        // silently substituting `Address::ORIGIN`.
937:        //
938:        // `abs_col` / `abs_row` flags on the resulting `CellRef`
939:        // are derived from the source axis: `Abs(_)` → true,
940:        // `Rel(_)` → false. This is exactly what the printer will
941:        // need at 4.9.D to re-emit canonical A1 (with `$`
942:        // prefixes) vs R1C1 (with brackets), and the canonical-
943:        // storage flow at 4.9.K relies on it.
944:        Expr::R1C1Ref {
945:            sheet,
946:            row_axis,
947:            col_axis,
948:        } => {
949:            let anchor_row = site.cell.map(|a| a.row);
950:            let anchor_col = site.cell.map(|a| a.col);
951:            let row = resolve_r1c1_axis(*row_axis, anchor_row, R1C1Axis::Row)?;
952:            let col = resolve_r1c1_axis(*col_axis, anchor_col, R1C1Axis::Col)?;
953:            Ok(ExprPlan::CellRef {
954:                sheet: resolve_sheet_ref(sheet, owning_sheet, sheets)?,
955:                row,
956:                col,
957:                abs_col: matches!(col_axis, AxisSpec::Abs(_)),
958:                abs_row: matches!(row_axis, AxisSpec::Abs(_)),
959:            })
960:        }
961:        // **W5-144 (Phase 4.9.H):** implicit-intersection binding.
962:        // Strategy: narrow at BIND TIME wherever the inner shape
963:        // allows it, dropping the wrapper. The AST keeps
964:        // `Expr::ImplicitIntersection` for round-trip print (per
965:        // design § 4.2 "NOT surface-only"); the ExprPlan never
966:        // needs a parallel variant because every reachable narrow
967:        // case collapses to a normal ExprPlan shape.
968:        //
969:        // Narrowing rules per design § 3.3 (anchor = `site.cell`):
970:        //   1. Scalar / CellRef inner → drop wrapper.

exec
/bin/zsh -lc "rg -n \"NamedTarget::Formula|ResolvedName::Formula|NamedFormula|Named formula|named formula|Formula\\(\" crates/ql-exec/src/plan.rs crates/ql-exec/src/workbook_runtime.rs crates/ql-exec/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/plan.rs:223:    /// `NamedTarget::Formula` in a scalar-context position. Named formulas
crates/ql-exec/src/plan.rs:228:        "named formula {0:?} cannot be used in this position; \
crates/ql-exec/src/plan.rs:231:    NamedFormulaUnsupported(Arc<str>),
crates/ql-exec/src/plan.rs:907:                // Phase 2B.4: named formulas still unsupported (Engine Phase 4).
crates/ql-exec/src/plan.rs:910:                Some(ResolvedName::Formula(_)) => {
crates/ql-exec/src/plan.rs:911:                    Err(BindError::NamedFormulaUnsupported(name.clone()))
crates/ql-exec/src/plan.rs:1325:    /// `NamedTarget::Formula(_)` resolved with payload. Phase 2B.4 added the
crates/ql-exec/src/plan.rs:1328:    Formula(Arc<str>),
crates/ql-exec/src/workbook_runtime.rs:2477:    /// stored formula in `formula_cells` and every `NamedTarget::Formula`
crates/ql-exec/src/workbook_runtime.rs:2531:        // (Phase 4.6.D / future): walk NamedTarget::Formula entries for
crates/ql-exec/src/workbook_runtime.rs:2532:        // the same rewrite. Today named formulas are deferred so
crates/ql-exec/src/workbook_runtime.rs:2537:        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
crates/ql-exec/src/workbook_runtime.rs:5134:    /// Named formulas (NamedTarget::Formula) surface a distinct
crates/ql-exec/src/workbook_runtime.rs:5135:    /// `NamedFormulaUnsupported` error rather than the generic
crates/ql-exec/src/workbook_runtime.rs:5144:                NamedTarget::Formula(std::sync::Arc::from("Revenue - Costs")),
crates/ql-exec/src/workbook_runtime.rs:5151:            Err(RuntimeError::Bind(BindError::NamedFormulaUnsupported(n))) => {
crates/ql-exec/src/workbook_runtime.rs:5154:            other => panic!("expected NamedFormulaUnsupported, got {other:?}"),

exec
/bin/zsh -lc "rg -n \"UnknownName|UnresolvedName|deleted name|name was deleted|clear_name|on_set_name|on_clear_name|delete.*name|Deleted\" crates/ql-exec/src crates/ql-storage/src crates/ql-oplog/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/lower.rs:64:    // `classify`. Deleted here along with the kernel itself.
crates/ql-exec/src/calcgraph_session.rs:640:    /// occurrences. Phase 3.3 reads this from `on_set_name` to mark
crates/ql-exec/src/calcgraph_session.rs:1076:    pub fn on_set_name(&mut self, name: &str) {
crates/ql-exec/src/calcgraph_session.rs:1111:    /// the W5-91 / `on_set_name` H2 fix — directly-affected formulas
crates/ql-exec/src/calcgraph_session.rs:1235:        // 4. Dirty-fan (same pattern as on_table_drop / on_set_name).
crates/ql-exec/src/calcgraph_session.rs:1852:        s.on_set_name("Tax");
crates/ql-exec/src/calcgraph_session.rs:1853:        s.on_set_name("Discount");
crates/ql-exec/src/calcgraph_session.rs:2161:            (0, 0, 2, "SUM(MyUnknownName1)"), // bind fail (UnresolvedName)
crates/ql-exec/src/calcgraph_session.rs:2194:                RuntimeError::Bind(BindError::UnresolvedName(_))
crates/ql-exec/src/calcgraph_session.rs:2202:    /// Phase 3.10 megaudit H2 regression: `on_set_name` must propagate
crates/ql-exec/src/calcgraph_session.rs:2236:        s.on_set_name("Sales");
crates/ql-exec/src/calcgraph_session.rs:2581:    /// `on_set_name` fans out via `name_to_formulas` (Phase 3.2
crates/ql-exec/src/calcgraph_session.rs:2614:        s.on_set_name("discount"); // case-insensitive
crates/ql-exec/src/plan.rs:164:/// Error during binding. Phase 2A.1 added `UnresolvedName`; Phase 2A.6 added
crates/ql-exec/src/plan.rs:190:    UnresolvedName(Arc<str>),
crates/ql-exec/src/plan.rs:198:    /// audit M3: previously silently mapped to `UnresolvedName` (wrong error class —
crates/ql-exec/src/plan.rs:575:/// `BindError::UnresolvedName`; any cross-sheet ref (`SheetRef::Name`)
crates/ql-exec/src/plan.rs:918:                None => Err(BindError::UnresolvedName(name.clone())),
crates/ql-exec/src/plan.rs:1350:/// returns `None`, so any NameRef becomes `BindError::UnresolvedName`.
crates/ql-exec/src/lib.rs:9://!   `BindError` variants including `UnresolvedName`,
crates/ql-exec/src/transaction.rs:213:        // safe and surfaces UnresolvedName / UnsupportedVariant before any
crates/ql-exec/src/transaction.rs:517:        // No name registered → bind-time UnresolvedName surfaces here.
crates/ql-exec/src/transaction.rs:518:        let result = tx.put_formula(0, 0, 0, "UnknownName + 1");
crates/ql-exec/src/transaction.rs:522:                Err(RuntimeError::Bind(crate::plan::BindError::UnresolvedName(
crates/ql-exec/src/transaction.rs:526:            "expected Bind(UnresolvedName), got {result:?}"
crates/ql-exec/src/workbook_runtime.rs:1478:            g.on_set_name(name);
crates/ql-exec/src/workbook_runtime.rs:1535:            g.on_set_name(name);
crates/ql-exec/src/workbook_runtime.rs:3127:    /// e.g. a name was deleted between extract and recompute) are
crates/ql-exec/src/workbook_runtime.rs:4212:        // No name registered → bind-time UnresolvedName, surfaced as RuntimeError::Bind.
crates/ql-exec/src/workbook_runtime.rs:4213:        let result = rt.set_formula(0, 0, 0, "UnknownName + 1");
crates/ql-exec/src/workbook_runtime.rs:4215:            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
crates/ql-exec/src/workbook_runtime.rs:4218:            other => panic!("expected Bind(UnresolvedName), got {other:?}"),
crates/ql-exec/src/workbook_runtime.rs:4228:    /// UnresolvedName(\"X\")" — Rust debug format with an awkward bracket+
crates/ql-exec/src/workbook_runtime.rs:4236:            .set_formula(0, 0, 0, "UnknownName + 1")
crates/ql-exec/src/workbook_runtime.rs:4240:        // debug-syntax markers like `UnresolvedName(...)`.
crates/ql-exec/src/workbook_runtime.rs:4246:            !display.contains("UnresolvedName"),
crates/ql-exec/src/workbook_runtime.rs:4796:        wb.put_formula(0, 0, 2, "UnknownName + 1"); // bind error (UnresolvedName)
crates/ql-exec/src/workbook_runtime.rs:6015:            // set_name → on_set_name

exec
/bin/zsh -lc "awk 'NR>=1090 && NR<=1115 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "awk 'NR>=206 && NR<=238 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/tests/p412_function_arg_fuzz.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1090:}
1091:
1092:/// I18: `=SUM(A:A)` whole-column reference.
1093:#[test]
1094:#[ignore]
1095:fn i18_whole_column_sum() {
1096:    let mut wb = Workbook::new();
1097:    let s = wb.add_sheet("S1");
1098:    let reg = default_registry();
1099:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
1100:    rt.set_value(s, 0, 0, Value::Number(1.0)).unwrap();
1101:    rt.set_value(s, 1, 0, Value::Number(2.0)).unwrap();
1102:    rt.set_value(s, 2, 0, Value::Number(3.0)).unwrap();
1103:    let v = rt.set_formula(s, 5, 0, "SUM(A:A)");
1104:    println!("[I18] SUM(A:A) = {v:?}");
1105:    if let Err(e) = &v {
1106:        println!("[I18 FINDING] SUM(A:A) whole-column literal range failed: {e}");
1107:    }
1108:}
1109:
1110:/// I19: `=Sheet2!A:A` cross-sheet whole-column with a name.
1111:#[test]
1112:#[ignore]
1113:fn i19_cross_sheet_whole_column_via_name() {
1114:    let mut wb = Workbook::new();
1115:    let s1 = wb.add_sheet("S1");

 succeeded in 0ms:
206:// ─── Self-referential ranges ───────────────────────────────────────────────
207:
208:/// Function arg is the cell that holds the function — direct self-reference.
209:#[test]
210:#[ignore]
211:fn self_referential_formula_direct() {
212:    let (mut wb, reg) = build_wb();
213:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
214:    let outcome = try_set_formula(&mut rt, 0, 0, "A1 + 1");
215:    eprintln!("self_referential_formula_direct: {outcome}");
216:    // Outcome should be #CIRC! after recompute.
217:    let _ = rt.recompute_all();
218:    let v = wb.read(ql_types::Address::new(0, 0, 0));
219:    eprintln!("post-recompute A1 = {v:?}");
220:}
221:
222:/// SUM(A:A) inside A1 — self-referential range.
223:#[test]
224:#[ignore]
225:fn self_referential_sum_whole_column() {
226:    let (mut wb, reg) = build_wb();
227:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
228:    let outcome = try_set_formula(&mut rt, 0, 0, "SUM(A:A)");
229:    eprintln!("self_referential_sum_whole_column: {outcome}");
230:    let _ = rt.recompute_all();
231:    let v = wb.read(ql_types::Address::new(0, 0, 0));
232:    eprintln!("post-recompute A1 = {v:?}");
233:}
234:
235:/// 2-cycle with `with_graph` (Tarjan SCC active). Should yield #CIRC!.
236:#[test]
237:#[ignore]
238:fn two_cycle_a1_b1_with_graph() {

exec
/bin/zsh -lc 'rg -n "UnsupportedVariant|RangeRef|Expr::RangeRef|AggregateArg|ReferenceArg|is_aggregate_function" crates/ql-exec/src/plan.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
24://! - `RangeRef` — single range used inside a Function call (e.g. `SUM(A:A)`)
119:    /// from `Expr::RangeRef` in `BindContext::ReferenceArg`. Carries the
124:    /// that reaches this variant today is `Expr::RangeRef` bound in
125:    /// `ReferenceArg` context. See design § 5.4.
126:    RangeRef {
173:    /// - `Expr::RangeRef` outside a Function context (Phase 4+ region binder).
184:    UnsupportedVariant(&'static str),
214:    /// Distinct from the generic `UnsupportedVariant` so callers can render a
366:    /// MIN, MAX, COUNT, etc. — see `is_aggregate_function`). NameRefs
373:    AggregateArg,
376:    /// Same shape as `AggregateArg` for NameRef-resolves-to-range AND
377:    /// (NEW) accepts literal `Expr::RangeRef` lowering to
378:    /// `ExprPlan::RangeRef { range }`. CellRef args bind as
379:    /// `ExprPlan::CellRef` unchanged. The scope of the `RangeRef`
381:    /// literal ranges. `AggregateArg`-side enabling (which would make
382:    /// `SUM(A1:B3)` work — currently a `BindError::UnsupportedVariant`)
384:    /// range-aware / unified) would also need new `RangeRef` arms.
385:    ReferenceArg,
393:/// LARGE, ...) live here. The `is_aggregate_function_lists_only_registered_aggregates`
406:pub(crate) fn is_aggregate_function(name: &str) -> bool {
410:    // `is_aggregate_function_lists_only_registered_aggregates` test pins
540:/// These functions take their args under `BindContext::ReferenceArg` rather
541:/// than `Scalar` or `AggregateArg`. ReferenceArg context accepts:
544:/// - `Expr::RangeRef` → `ExprPlan::RangeRef { range }` (NEW; the only context
547:///   `ExprPlan::AggregateNameRef` (same as `AggregateArg` semantics).
754:        Expr::RangeRef(rr) => {
756:            // a reference-aware function arg list (`BindContext::ReferenceArg`)
757:            // — they lower to `ExprPlan::RangeRef { range }`. Outside that
761:            // AggregateArg-side enabling (which would let `SUM(A1:B3)` bind)
763:            // would also need new `ExprPlan::RangeRef` handling, which is
766:            if ctx == BindContext::ReferenceArg {
768:                Ok(ExprPlan::RangeRef { range })
770:                Err(BindError::UnsupportedVariant(
771:                    "literal RangeRef in non-Function context is unsupported in v1; \
776:                     RangeRef support inside reference-aware fn arg lists only.)",
782:            // `ReferenceArg` context (literal RangeRef + range NameRef both
784:            // unified-tier fns keep the existing `AggregateArg` context.
787:                BindContext::ReferenceArg
788:            } else if is_aggregate_function(name) {
789:                BindContext::AggregateArg
861:        Expr::Spill(_) => Err(BindError::UnsupportedVariant(
899:                    BindContext::AggregateArg | BindContext::ReferenceArg => {
909:                // UnsupportedVariant so the IDE can render a specific hint.
986:        // Out-of-range narrow → `BindError::UnsupportedVariant` to
1051:        Expr::RangeRef(rr) => {
1116:        Expr::Spill(_) => Err(BindError::UnsupportedVariant(
1125:/// `RangeRef` inner with a formula-cell anchor (`site.cell`).
1127:    rr: &ql_formula_syntax::RangeRef,
1132:    use ql_formula_syntax::RangeRef;
1137:        RangeRef::Cells {
1195:        RangeRef::WholeColumn {
1219:        RangeRef::WholeRow {
1242:        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
1243:            "RangeRef::R1C1Cells inside @ is parser-intermediate; storage canon \
1659:        Expr::RangeRef(_) => "RangeRef",
1694:/// **W5-RT-1 (RT-V1-01):** resolve `Expr::RangeRef` to a [`Range`] WITHOUT
1700:    rr: &ql_formula_syntax::RangeRef,
1704:    use ql_formula_syntax::RangeRef;
1706:        RangeRef::Cells {
1719:        RangeRef::WholeColumn {
1728:        RangeRef::WholeRow {
1737:        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
1738:            "RangeRef::R1C1Cells in reference-aware fn arg is parser-intermediate; \
1747:    use ql_formula_syntax::{CellAddr, RangeRef, SheetRef};
1804:    /// `is_aggregate_function_lists_only_registered_aggregates` pattern
1957:        let expr = Expr::RangeRef(RangeRef::WholeColumn {
1966:            Err(BindError::UnsupportedVariant(_))
2273:        // EmptyArrayLiteral variant (was UnsupportedVariant pre-closure).

exec
/bin/zsh -lc "awk 'NR>=780 && NR<=900 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/plan.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
780:        Expr::Function { name, args } => {
781:            // **W5-RT-1 (RT-V1-01):** reference-aware fns take args under
782:            // `ReferenceArg` context (literal RangeRef + range NameRef both
783:            // accepted; CellRef passes through). Aggregate/range-aware/
784:            // unified-tier fns keep the existing `AggregateArg` context.
785:            // Plain scalar fns get `Scalar` (rejects range args).
786:            let arg_ctx = if is_reference_aware_function(name) {
787:                BindContext::ReferenceArg
788:            } else if is_aggregate_function(name) {
789:                BindContext::AggregateArg
790:            } else {
791:                BindContext::Scalar
792:            };
793:            let mut bound_args = Vec::with_capacity(args.len());
794:            for a in args {
795:                bound_args.push(bind_with_context_v2(
796:                    a, site, names, sheets, tables, arg_ctx,
797:                )?);
798:            }
799:            Ok(ExprPlan::Function {
800:                name: name.clone(),
801:                args: bound_args,
802:            })
803:        }
804:        // **W5-99 (Phase 4.7.F):** lower `Expr::Array` to
805:        // `ExprPlan::Array`. Per design § 5, this is element-wise +
806:        // enforces uniform row arity AND the restricted cell-kind subset
807:        // (Number / Bool / String / Error). The parser already validates
808:        // both; this is defense in depth against direct AST construction.
809:        Expr::Array(rows) => {
810:            // **W5-99 closure (Codex MEDIUM-7 / Sonnet L-1):** reject
811:            // degenerate shapes — zero rows OR zero cells in row 0.
812:            // The parser rejects `{}` via `ParseError::EmptyArrayLiteral`,
813:            // but `Expr::Array(vec![])` and `Expr::Array(vec![vec![]])`
814:            // are directly-constructible; the latter would otherwise
815:            // bind with `expected_arity = 0` and produce a degenerate
816:            // ExprPlan::Array(vec![vec![]]) that downstream code would
817:            // need a special case for.
818:            if rows.is_empty() || rows[0].is_empty() {
819:                return Err(BindError::EmptyArrayLiteral);
820:            }
821:            let expected_arity = rows[0].len() as u32;
822:            let mut bound_rows: Vec<Vec<ExprPlan>> = Vec::with_capacity(rows.len());
823:            for (row_idx, row) in rows.iter().enumerate() {
824:                let found_arity = row.len() as u32;
825:                if found_arity != expected_arity {
826:                    return Err(BindError::ArrayRowArityMismatch {
827:                        expected: expected_arity,
828:                        found: found_arity,
829:                        row: row_idx as u32,
830:                    });
831:                }
832:                let mut bound_row: Vec<ExprPlan> = Vec::with_capacity(row.len());
833:                for (col_idx, cell) in row.iter().enumerate() {
834:                    let bound_cell = match cell {
835:                        Expr::Number(n) => ExprPlan::Number(*n),
836:                        Expr::Bool(b) => ExprPlan::Bool(*b),
837:                        Expr::String(s) => ExprPlan::String(s.clone()),
838:                        Expr::Error(ev) => ExprPlan::Error(*ev),
839:                        // Per design § 3.3 / parser restriction: only the
840:                        // four literal kinds are allowed inside an array
841:                        // cell. Reject everything else loudly so a future
842:                        // test that constructs `Expr::Array(vec![vec![
843:                        // Expr::CellRef(_)]])` directly surfaces a clean
844:                        // error rather than silently producing a corrupt
845:                        // ExprPlan.
846:                        other => {
847:                            return Err(BindError::ArrayCellNotLiteral {
848:                                row: row_idx as u32,
849:                                col: col_idx as u32,
850:                                got: variant_kind(other),
851:                            });
852:                        }
853:                    };
854:                    bound_row.push(bound_cell);
855:                }
856:                bound_rows.push(bound_row);
857:            }
858:            Ok(ExprPlan::Array(bound_rows))
859:        }
860:
861:        Expr::Spill(_) => Err(BindError::UnsupportedVariant(
862:            "Spill-range-ref `A1#` syntax is Phase 4.9",
863:        )),
864:
865:        // **W5-99 (Phase 4.7.F):** error literal — mechanical lowering.
866:        // No resolution, no context. The evaluator returns
867:        // `Value::Error(ev)` directly.
868:        Expr::Error(ev) => Ok(ExprPlan::Error(*ev)),
869:        Expr::NameRef(name) => {
870:            // Phase 2A.6 audit M1: parser-emitted `NameRef` must always carry a
871:            // non-empty canonical name. An empty name here means the parser is
872:            // broken; panic to surface the upstream bug per the no-fallbacks rule.
873:            assert!(
874:                !name.is_empty(),
875:                "bind_with_context: Expr::NameRef carries an empty string — parser invariant violated"
876:            );
877:            // Phase 2A.1: resolve the name via the active NameTable; Phase 2A.6
878:            // audit H2 uses case-insensitive lookup in the `NameTable` impl so
879:            // every entry point canonicalizes uniformly.
880:            match names.lookup_named_target(name, owning_sheet) {
881:                Some(ResolvedName::Cell(sheet, row, col, abs_col, abs_row)) => {
882:                    Ok(ExprPlan::CellRef {
883:                        sheet,
884:                        row,
885:                        col,
886:                        abs_col,
887:                        abs_row,
888:                    })
889:                }
890:                Some(ResolvedName::Number(n)) => Ok(ExprPlan::Number(n)),
891:                Some(ResolvedName::Bool(b)) => Ok(ExprPlan::Bool(b)),
892:                Some(ResolvedName::Text(s)) => Ok(ExprPlan::String(s)),
893:                // Phase 2B.4: context-aware Range handling.
894:                // W5-RT-1 (RT-V1-01): reference-aware fn arg context
895:                // accepts named ranges with the same shape as aggregate
896:                // arg — the materializer treats `AggregateNameRef` as a
897:                // `RefArg::Range` consumer.
898:                Some(ResolvedName::Range(range)) => match ctx {
899:                    BindContext::AggregateArg | BindContext::ReferenceArg => {
900:                        Ok(ExprPlan::AggregateNameRef {

exec
/bin/zsh -lc "awk 'NR>=742 && NR<=777 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/plan.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
742:        }),
743:        Expr::Unary { op, operand } => Ok(ExprPlan::Unary {
744:            op: *op,
745:            operand: Box::new(bind_with_context_v2(
746:                operand,
747:                site,
748:                names,
749:                sheets,
750:                tables,
751:                BindContext::Scalar,
752:            )?),
753:        }),
754:        Expr::RangeRef(rr) => {
755:            // **W5-RT-1 (RT-V1-01):** literal range args are accepted inside
756:            // a reference-aware function arg list (`BindContext::ReferenceArg`)
757:            // — they lower to `ExprPlan::RangeRef { range }`. Outside that
758:            // context the rejection stands (W5-108 / Phase 4.7.O message
759:            // preserved).
760:            //
761:            // AggregateArg-side enabling (which would let `SUM(A1:B3)` bind)
762:            // is deferred: every Scalar/RangeAware/Unified dispatcher arm
763:            // would also need new `ExprPlan::RangeRef` handling, which is
764:            // out of scope for the reference-tier mini-phase. Tracked as a
765:            // follow-up in the design doc § 5.4.
766:            if ctx == BindContext::ReferenceArg {
767:                let range = resolve_range_ref_to_range(rr, owning_sheet, sheets)?;
768:                Ok(ExprPlan::RangeRef { range })
769:            } else {
770:                Err(BindError::UnsupportedVariant(
771:                    "literal RangeRef in non-Function context is unsupported in v1; \
772:                     use a named range (Phase 2B.4 AggregateNameRef) or wrap in an \
773:                     aggregate function. (Updated W5-108 / Phase 4.7.O; original \
774:                     Phase 0 W4-1 message referenced \"no function dispatch yet\" \
775:                     which has been in place since Phase 2A. W5-RT-1 added literal \
776:                     RangeRef support inside reference-aware fn arg lists only.)",
777:                ))

exec
/bin/zsh -lc "awk 'NR>=388 && NR<=430 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/plan.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
388:/// Phase 2B.4 (2026-05-12): hardcoded list of functions whose arguments
389:/// accept aggregate-range / named-range inputs. The function name is
390:/// historical — this list is now better understood as "names for which
391:/// the binder allows `AggregateNameRef` in arg positions"; both scalar
392:/// aggregates (SUM, AVERAGE) AND range-aware functions (SUMIF, VLOOKUP,
393:/// LARGE, ...) live here. The `is_aggregate_function_lists_only_registered_aggregates`
394:/// test invariant pins the cross-table sync.
395:///
396:/// **Re-target:** the planned replacement with per-function metadata
397:/// (`FunctionRegistry` attributes) is no longer Phase 4.3 work — Phase
398:/// 4.3 wave 1 closed W5-58 with this matcher still in place. The right
399:/// time to replace this is **Phase 4.7 (array formulas) or Phase 4.10
400:/// (function library wave 2)**, whichever introduces richer per-
401:/// function metadata first.
402:///
403:/// Aggregate detection is binary in V0 (all args are aggregate or no args
404:/// are). Per-arg-position decisions (e.g. IF's then/else accept arrays in
405:/// some contexts) land alongside Engine Phase 4.7 array formulas.
406:pub(crate) fn is_aggregate_function(name: &str) -> bool {
407:    // Phase 2B.7 audit (correctness M1): MEDIAN removed — it was listed
408:    // here but not registered in `ql_functions::default_registry`. Keeping
409:    // the list synced with the registry is a hard rule; the
410:    // `is_aggregate_function_lists_only_registered_aggregates` test pins
411:    // it. When Engine Phase 4.3 expands the function library, the metadata
412:    // moves to per-function FunctionRegistry attributes and this hardcoded
413:    // matcher goes away entirely.
414:    //
415:    // W5-53 (GAP-F-05 closure): SUMIF + COUNTIF are NOT scalar aggregates
416:    // (they return a scalar but take range + criteria) — they live in the
417:    // parallel `range_aware_fns` table. But the binder uses this list to
418:    // decide whether `NamedRangeInScalarContext` should fire on
419:    // `=SUMIF(NamedRange, 5)`. Since SUMIF NEEDS a range arg, we add it
420:    // here so the binder allows the AggregateNameRef in arg position. The
421:    // eval-side dispatch routes correctly via `lookup_range_aware` first.
422:    matches!(
423:        name,
424:        "SUM"
425:            | "AVERAGE"
426:            | "AVG"
427:            | "COUNT"
428:            | "COUNTA"
429:            | "MIN"
430:            | "MAX"

exec
/bin/zsh -lc "awk 'NR>=1688 && NR<=1738 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/plan.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1688:        SheetRef::Name(n) => sheets
1689:            .resolve_sheet(n)
1690:            .ok_or_else(|| BindError::UnknownSheet(n.clone())),
1691:    }
1692:}
1693:
1694:/// **W5-RT-1 (RT-V1-01):** resolve `Expr::RangeRef` to a [`Range`] WITHOUT
1695:/// implicit-intersection narrowing. Used by the reference-aware binder path
1696:/// for ROW/COLUMN/ROWS/COLUMNS args. Whole-column resolves to the full row
1697:/// range `0..=MAX_ROW`, whole-row to `0..=MAX_COLUMN`. R1C1 cells inside `@`
1698:/// is parser-intermediate (storage canon is A1) and is rejected here too.
1699:fn resolve_range_ref_to_range(
1700:    rr: &ql_formula_syntax::RangeRef,
1701:    owning_sheet: SheetId,
1702:    sheets: &dyn SheetResolver,
1703:) -> Result<Range, BindError> {
1704:    use ql_formula_syntax::RangeRef;
1705:    match rr {
1706:        RangeRef::Cells {
1707:            sheet,
1708:            start_col,
1709:            start_row,
1710:            end_col,
1711:            end_row,
1712:            ..
1713:        } => {
1714:            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
1715:            Ok(Range::new(
1716:                sheet_id, *start_row, *start_col, *end_row, *end_col,
1717:            ))
1718:        }
1719:        RangeRef::WholeColumn {
1720:            sheet,
1721:            start_col,
1722:            end_col,
1723:            ..
1724:        } => {
1725:            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
1726:            Ok(Range::new(sheet_id, 0, *start_col, MAX_ROW, *end_col))
1727:        }
1728:        RangeRef::WholeRow {
1729:            sheet,
1730:            start_row,
1731:            end_row,
1732:            ..
1733:        } => {
1734:            let sheet_id = resolve_sheet_ref(sheet, owning_sheet, sheets)?;
1735:            Ok(Range::new(sheet_id, *start_row, 0, *end_row, MAX_COLUMN))
1736:        }
1737:        RangeRef::R1C1Cells { .. } => Err(BindError::UnsupportedVariant(
1738:            "RangeRef::R1C1Cells in reference-aware fn arg is parser-intermediate; \

exec
/bin/zsh -lc "awk 'NR>=90 && NR<=130 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
90:/// (used by `Graph::register_range_dependency`). The conversion picks
91:/// the most precise variant available so the stripe index stays
92:/// efficient:
93:///
94:/// - `start_row == 0 && end_row == RowId::MAX` → `WholeColumn` (one
95:///   stripe per column in the range).
96:/// - `start_col == 0 && end_col == ColId::MAX` → `WholeRow` (one
97:///   stripe per row).
98:/// - Otherwise → `Cells` (StripeIndex picks the smaller axis).
99:///
100:/// The Phase 0 `StripeIndex::register` panics on reversed bounds; this
101:/// helper trusts `Range` to be normalized (per `Range::new` which
102:/// sorts via `min/max`).
103:fn range_to_rangeref(r: Range) -> RangeRef {
104:    let whole_rows = r.start_row == 0 && r.end_row == RowId::MAX;
105:    let whole_cols = r.start_col == 0 && r.end_col == ColId::MAX;
106:    if whole_rows && !whole_cols {
107:        RangeRef::WholeColumn {
108:            sheet: SheetRef::Id(r.sheet),
109:            start_col: r.start_col,
110:            end_col: r.end_col,
111:            abs_start: false,
112:            abs_end: false,
113:        }
114:    } else if whole_cols && !whole_rows {
115:        RangeRef::WholeRow {
116:            sheet: SheetRef::Id(r.sheet),
117:            start_row: r.start_row,
118:            end_row: r.end_row,
119:            abs_start: false,
120:            abs_end: false,
121:        }
122:    } else {
123:        // Bounded rectangle (or fully-saturated rectangle, which the
124:        // stripe index handles by picking the smaller axis).
125:        RangeRef::Cells {
126:            sheet: SheetRef::Id(r.sheet),
127:            start_col: r.start_col,
128:            start_row: r.start_row,
129:            end_col: r.end_col,
130:            end_row: r.end_row,

exec
/bin/zsh -lc "awk 'NR>=880 && NR<=920 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
880:        col: ColId,
881:        formula: impl Into<Arc<str>>,
882:    ) {
883:        assert!(
884:            (sheet as usize) < self.sheets.len(),
885:            "Workbook::put_formula: sheet {sheet} does not exist (have {})",
886:            self.sheets.len()
887:        );
888:        assert!(
889:            row <= ql_types::MAX_ROW,
890:            "Workbook::put_formula: row {row} exceeds MAX_ROW {}",
891:            ql_types::MAX_ROW
892:        );
893:        assert!(
894:            col <= ql_types::MAX_COLUMN,
895:            "Workbook::put_formula: col {col} exceeds MAX_COLUMN {}",
896:            ql_types::MAX_COLUMN
897:        );
898:        self.formula_cells.insert((sheet, row, col), formula.into());
899:    }
900:
901:    /// Remove any formula association for a cell. Used when a formula cell becomes a
902:    /// literal (e.g. user types over the formula with a value). Idempotent: removing
903:    /// a non-existent entry is a no-op.
904:    ///
905:    /// Phase 3.5 (CORR-25): ALSO drops any computed-overlay entry at this cell. A
906:    /// cell without a formula text has no business carrying a formula output; the
907:    /// invariant the rest of the engine relies on is "computed overlay populated ⇒
908:    /// formula text present", and `clear_formula` is the only path that breaks the
909:    /// formula→computed pair, so the storage layer enforces both sides here.
910:    ///
911:    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log. Use
912:    /// `ql_exec::WorkbookRuntime::clear_formula` to record `Op::ClearFormula`
913:    /// in an attached log. GAP-O-03.
914:    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
915:        self.formula_cells.remove(&(sheet, row, col));
916:        self.clear_computed_at(sheet, row, col);
917:    }
918:
919:    /// Borrow the formula source for a cell, if it has one.
920:    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {

exec
/bin/zsh -lc "awk 'NR>=3645 && NR<=3765 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"clear_spill_if_present|clear_spill_at|write_spill|SpillShape|register_spill|put_formula\\(\" crates/ql-exec/src/workbook_runtime.rs crates/ql-storage/src/workbook.rs crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3645:        // **W5-103 megaudit HIGH-2 closure (#128, all 3 reviewers
3646:        // cross-confirmed):** route through `eval_at_cell_boundary`
3647:        // (same entry set_formula uses) so a top-level
3648:        // `ExprPlan::Array` produces an `EvalResult::Array` here and
3649:        // materializes via `write_spill` — instead of collapsing to
3650:        // `#CALC!` (which `eval_scalar_with_cache` returns per the
3651:        // scalar-context contract at scalar.rs:95).
3652:        //
3653:        // Without this, op-log replay of `PutFormula { text: "{1,2,3}" }`
3654:        // followed by `recompute_all` would write #CALC! at the
3655:        // anchor instead of spilling — design § 7.3/§ 12.3
3656:        // "load → recompute re-derives spills" contract broken,
3657:        // persistence layer (4.7.L) hard-blocked.
3658:        //
3659:        // The clear-old + write_spill sequence mirrors set_formula's
3660:        // 4.7.J.2 pattern. Unlike set_formula, we DO NOT fire
3661:        // on_set_formula / on_set_value / re-extract hooks: recompute
3662:        // doesn't change a formula's identity, only its computed
3663:        // value. Downstream readers were already dirtied by whatever
3664:        // made THIS formula dirty in the first place.
3665:        //
3666:        // **W5-108 (Phase 4.7.O) — Codex MEDIUM-5 closure**: clear
3667:        // the OLD spill footprint BEFORE eval, matching design § 10.3
3668:        // step 4 ("clear-old-before-eval") and `set_formula`'s
3669:        // identical ordering at line 621. Pre-fix ordering was
3670:        // eval → clear → write, which let a formula's eval observe
3671:        // its own OLD spill-target computed overlays through indirect
3672:        // reads (named ranges, aggregates). Direct self-reads create
3673:        // a producer-alias self-loop (Tarjan → #CIRC!) so the gap was
3674:        // narrow, but the design contract is "clear-before-eval" and
3675:        // bringing the code into alignment removes a latent
3676:        // composition footgun.
3677:        //
3678:        // We capture old_spill_shape BEFORE clear so the caller
3679:        // (recompute_dirty's fixed-point loop) can fire hooks for the
3680:        // dissolved footprint after eval+write_spill complete.
3681:        let old_spill_shape = self.workbook.spill_anchor_at(sheet, row, col).copied();
3682:        self.workbook.clear_spill_if_present((sheet, row, col));
3683:
3684:        let result: crate::eval_result::EvalResult = {
3685:            // **W5-117 (Phase 4.8.G.2):** carry recomputed cell for
3686:            // structured-ref `[@Col]` row narrowing.
3687:            let env = WorkbookEnv::with_formula_cell(
3688:                self.workbook,
3689:                ql_types::Address::new(sheet, row, col),
3690:            );
3691:            crate::scalar::eval_at_cell_boundary(plan.as_ref(), &env, self.registry, agg_cache)
3692:        };
3693:
3694:        // **Note (Sonnet #128 LOW-1, deferred):** the Array arm here
3695:        // writes the anchor via `write_spill`; the caller also
3696:        // `put_computed_at(anchor, anchor_value)` — a no-op duplicate
3697:        // write. Deferred; harmless.
3698:        //
3699:        // **W5-106 (Phase 4.7.M / task #136 closure)**: capture the
3700:        // NEW shape via write_spill's return. We DON'T fire
3701:        // on_set_value hooks here — the caller (recompute_dirty in
3702:        // particular) owns the session reference at this scope
3703:        // (recompute_dirty `take()`s `self.graph` into a local, so
3704:        // `self.graph` is `None` during the sorted loop). Bubble the
3705:        // shape info up via the return; the caller fires hooks
3706:        // against its session.
3707:        let (anchor_value, new_spill_shape) = match result {
3708:            crate::eval_result::EvalResult::Scalar(v) => (v, None),
3709:            crate::eval_result::EvalResult::Array(array) => {
3710:                let formula_text_arc = self
3711:                    .workbook
3712:                    .formula_at(sheet, row, col)
3713:                    .cloned()
3714:                    .expect("recompute: formula_at MUST be Some — we're recomputing this cell");
3715:                self.write_spill(sheet, row, col, array, formula_text_arc)
3716:            }
3717:        };
3718:
3719:        Ok((
3720:            anchor_value,
3721:            simd_eligible,
3722:            old_spill_shape,
3723:            new_spill_shape,
3724:        ))
3725:    }
3726:}
3727:
3728:#[cfg(test)]
3729:mod tests {
3730:    use super::*;
3731:    use ql_functions::default_registry;
3732:    use ql_types::ErrorValue;
3733:
3734:    fn make_runtime_workbook() -> Workbook {
3735:        let mut wb = Workbook::new();
3736:        wb.add_sheet("S");
3737:        wb
3738:    }
3739:
3740:    // ===== set_formula =====
3741:
3742:    #[test]
3743:    fn set_formula_literal_arithmetic() {
3744:        let mut wb = make_runtime_workbook();
3745:        let reg = default_registry();
3746:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
3747:
3748:        let v = rt.set_formula(0, 0, 0, "1 + 2 * 3").unwrap();
3749:        assert_eq!(v, Value::Number(7.0));
3750:        // Persisted: both the formula and the value.
3751:        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(7.0));
3752:        assert_eq!(
3753:            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
3754:            Some("1 + 2 * 3")
3755:        );
3756:    }
3757:
3758:    #[test]
3759:    fn set_formula_reads_existing_cell() {
3760:        let mut wb = make_runtime_workbook();
3761:        wb.put_at(0, 0, 0, Value::Number(10.0));
3762:        let reg = default_registry();
3763:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
3764:
3765:        // =A1 * 2 → 20

 succeeded in 0ms:
crates/ql-oplog/src/replay.rs:335:            workbook.put_formula(*sheet, *row, *col, text.as_str());
crates/ql-storage/src/workbook.rs:316:    /// design; mutation goes through `register_spill` / `clear_spill_at`
crates/ql-storage/src/workbook.rs:574:    /// - `write_spill` to block spill anchors inside table footprints
crates/ql-storage/src/workbook.rs:700:    ) -> Option<&crate::SpillShape> {
crates/ql-storage/src/workbook.rs:720:    /// target cell value AFTER `register_spill` succeeds.
crates/ql-storage/src/workbook.rs:721:    pub fn register_spill(
crates/ql-storage/src/workbook.rs:724:        shape: crate::SpillShape,
crates/ql-storage/src/workbook.rs:739:    pub fn clear_spill_at(
crates/ql-storage/src/workbook.rs:745:        // This is the coupling reason `clear_spill_at` lives on
crates/ql-storage/src/workbook.rs:760:    /// `clear_spill_at`. Returns `true` if a spill was cleared, `false`
crates/ql-storage/src/workbook.rs:764:    /// Equivalent to `clear_spill_at(anchor).is_ok()` semantically.
crates/ql-storage/src/workbook.rs:765:    pub fn clear_spill_if_present(&mut self, anchor: (SheetId, RowId, ColId)) -> bool {
crates/ql-storage/src/workbook.rs:766:        self.clear_spill_at(anchor).is_ok()
crates/ql-storage/src/workbook.rs:876:    pub fn put_formula(
crates/ql-storage/src/workbook.rs:1062:        wb.put_formula(5, 0, 0, "A1 + 1");
crates/ql-storage/src/workbook.rs:1070:        wb.put_formula(0, 1_048_576, 0, "A1 + 1");
crates/ql-storage/src/workbook.rs:1078:        wb.put_formula(0, 0, 16_384, "A1 + 1");
crates/ql-storage/src/workbook.rs:1085:        wb.put_formula(0, 1_048_575, 16_383, "boundary");
crates/ql-storage/src/workbook.rs:1136:        wb.put_formula(s, 0, 0, "A1 + B1");
crates/ql-storage/src/workbook.rs:1146:        wb.put_formula(s, 0, 0, "A1 + 1");
crates/ql-storage/src/workbook.rs:1165:        wb.put_formula(s, 0, 0, "A1 + 1");
crates/ql-storage/src/workbook.rs:1166:        wb.put_formula(s, 0, 0, "B1 * 2");
crates/ql-storage/src/workbook.rs:1175:        wb.put_formula(s, 0, 0, "f1");
crates/ql-storage/src/workbook.rs:1176:        wb.put_formula(s, 1, 0, "f2");
crates/ql-storage/src/workbook.rs:1177:        wb.put_formula(s, 5, 3, "f3");
crates/ql-storage/src/workbook.rs:1200:        wb.put_formula(s, 0, 0, "A1 + 1");
crates/ql-storage/src/workbook.rs:1474:    fn workbook_register_spill_round_trip() {
crates/ql-storage/src/workbook.rs:1478:        wb.register_spill((0, 1, 1), crate::SpillShape::new(2, 3))
crates/ql-storage/src/workbook.rs:1482:            Some(&crate::SpillShape::new(2, 3))
crates/ql-storage/src/workbook.rs:1499:    fn workbook_clear_spill_at_clears_computed_overlays() {
crates/ql-storage/src/workbook.rs:1503:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
crates/ql-storage/src/workbook.rs:1513:        // clear_spill_at: unregisters AND clears overlays at every target.
crates/ql-storage/src/workbook.rs:1514:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/workbook.rs:1525:    fn workbook_register_spill_rejects_collision_with_existing() {
crates/ql-storage/src/workbook.rs:1528:        wb.register_spill((0, 0, 0), crate::SpillShape::new(3, 1))
crates/ql-storage/src/workbook.rs:1532:            .register_spill((0, 1, 0), crate::SpillShape::new(3, 1))
crates/ql-storage/src/workbook.rs:1541:    fn workbook_clear_spill_at_unknown_anchor_errors() {
crates/ql-storage/src/workbook.rs:1544:        let err = wb.clear_spill_at((0, 5, 5)).unwrap_err();
crates/ql-storage/src/workbook.rs:1550:    fn workbook_clear_spill_at_preserves_user_overlays_outside_rectangle() {
crates/ql-storage/src/workbook.rs:1552:        // clear_spill_at. Verifies the clear loop is bounded to the
crates/ql-storage/src/workbook.rs:1556:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
crates/ql-storage/src/workbook.rs:1563:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/workbook.rs:1575:        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 2))
crates/ql-storage/src/workbook.rs:1577:        wb.register_spill((0, 5, 5), crate::SpillShape::new(1, 1))
crates/ql-storage/src/workbook.rs:1582:    // ===== W5-101-AUDIT (Codex LOW-3) — clear_spill_if_present =====
crates/ql-storage/src/workbook.rs:1585:    fn workbook_clear_spill_if_present_returns_true_when_cleared() {
crates/ql-storage/src/workbook.rs:1588:        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 1))
crates/ql-storage/src/workbook.rs:1590:        let cleared = wb.clear_spill_if_present((0, 0, 0));
crates/ql-storage/src/workbook.rs:1596:    fn workbook_clear_spill_if_present_returns_false_when_missing() {
crates/ql-storage/src/workbook.rs:1600:        let cleared = wb.clear_spill_if_present((0, 5, 5));
crates/ql-storage/src/workbook.rs:1605:    fn workbook_clear_spill_at_clears_anchor_own_computed_overlay() {
crates/ql-storage/src/workbook.rs:1611:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 1))
crates/ql-storage/src/workbook.rs:1615:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-exec/src/workbook_runtime.rs:43:use ql_storage::{FormatId, SpillShape, Workbook};
crates/ql-exec/src/workbook_runtime.rs:580:        // **W5-147:** downstream code (put_formula, write_spill, the
crates/ql-exec/src/workbook_runtime.rs:679:        //     footprint isn't covered by `clear_spill_if_present` below.
crates/ql-exec/src/workbook_runtime.rs:682:        //     `write_spill`'s blocking check doesn't see it as occupied.
crates/ql-exec/src/workbook_runtime.rs:686:        let dissolved_host: Option<((SheetId, RowId, ColId), SpillShape)> = {
crates/ql-exec/src/workbook_runtime.rs:696:                    // Idempotent — `clear_spill_at` errors with
crates/ql-exec/src/workbook_runtime.rs:699:                    let _ = self.workbook.clear_spill_at(host_anchor);
crates/ql-exec/src/workbook_runtime.rs:717:        // `clear_spill_if_present` is a no-op when no spill exists.
crates/ql-exec/src/workbook_runtime.rs:726:        self.workbook.clear_spill_if_present((sheet, row, col));
crates/ql-exec/src/workbook_runtime.rs:776:                self.workbook.put_formula(sheet, row, col, formula_text);
crates/ql-exec/src/workbook_runtime.rs:779:            EvalResult::Array(array) => self.write_spill(sheet, row, col, array, formula_text),
crates/ql-exec/src/workbook_runtime.rs:957:        old_shape: Option<SpillShape>,
crates/ql-exec/src/workbook_runtime.rs:958:        new_shape: Option<SpillShape>,
crates/ql-exec/src/workbook_runtime.rs:1091:    /// 4. Happy path: `register_spill` then `put_computed_at` for every
crates/ql-exec/src/workbook_runtime.rs:1097:    /// Returns `(anchor_value, Option<SpillShape>)`. `Some(shape)` only
crates/ql-exec/src/workbook_runtime.rs:1102:    fn write_spill(
crates/ql-exec/src/workbook_runtime.rs:1109:    ) -> (Value, Option<SpillShape>) {
crates/ql-exec/src/workbook_runtime.rs:1115:        // ONCE at the top of `write_spill` so it fires uniformly even
crates/ql-exec/src/workbook_runtime.rs:1124:            .expect("write_spill: sheet validated at set_formula entry");
crates/ql-exec/src/workbook_runtime.rs:1160:                // Sheet existence is asserted at the top of `write_spill`;
crates/ql-exec/src/workbook_runtime.rs:1166:                    .expect("write_spill: sheet asserted at function entry");
crates/ql-exec/src/workbook_runtime.rs:1174:                // letting register_spill panic at a collision later).
crates/ql-exec/src/workbook_runtime.rs:1192:        // `register_spill` enforces invariants (no anchor collision,
crates/ql-exec/src/workbook_runtime.rs:1195:        let shape = SpillShape::new(array.rows(), array.cols());
crates/ql-exec/src/workbook_runtime.rs:1196:        match self.workbook.register_spill((sheet, row, col), shape) {
crates/ql-exec/src/workbook_runtime.rs:1199:                "W5-103: register_spill failed after blocker check passed — \
crates/ql-exec/src/workbook_runtime.rs:1215:        self.workbook.put_formula(sheet, row, col, formula_text);
crates/ql-exec/src/workbook_runtime.rs:1223:    /// write helper. The three blocked-spill arms in `write_spill`
crates/ql-exec/src/workbook_runtime.rs:1236:    ) -> (Value, Option<SpillShape>) {
crates/ql-exec/src/workbook_runtime.rs:1240:        self.workbook.put_formula(sheet, row, col, formula_text);
crates/ql-exec/src/workbook_runtime.rs:1308:        // The host-vs-self distinction matters because `clear_spill_at`
crates/ql-exec/src/workbook_runtime.rs:1309:        // is anchor-keyed: case (a) needs `clear_spill_at(host_anchor)`,
crates/ql-exec/src/workbook_runtime.rs:1310:        // case (b) needs `clear_spill_at((sheet, row, col))`. Both can
crates/ql-exec/src/workbook_runtime.rs:1315:        let dissolved_host: Option<((SheetId, RowId, ColId), SpillShape)> = {
crates/ql-exec/src/workbook_runtime.rs:1325:                    let _ = self.workbook.clear_spill_at(host_anchor);
crates/ql-exec/src/workbook_runtime.rs:1339:            let _ = self.workbook.clear_spill_at((sheet, row, col));
crates/ql-exec/src/workbook_runtime.rs:1653:        // Previously enforced only at `write_spill` time (the write-side
crates/ql-exec/src/workbook_runtime.rs:1906:            self.workbook.put_formula(s, r, c, new_text);
crates/ql-exec/src/workbook_runtime.rs:2050:            self.workbook.put_formula(s, r, c, new_text);
crates/ql-exec/src/workbook_runtime.rs:2112:    /// `write_spill` time today; closing this uniformly across
crates/ql-exec/src/workbook_runtime.rs:2561:            self.workbook.put_formula(s, r, c, new_text.as_str());
crates/ql-exec/src/workbook_runtime.rs:2611:        // mirror the HIGH-3 fix for set_formula. clear_spill_at MUST
crates/ql-exec/src/workbook_runtime.rs:2616:        // the actual `clear_spill_at` mutation AFTER the op-log
crates/ql-exec/src/workbook_runtime.rs:2677:            // `clear_spill_at` returns SpillNotFoundError only if the
crates/ql-exec/src/workbook_runtime.rs:2680:            let _ = self.workbook.clear_spill_at((sheet, row, col));
crates/ql-exec/src/workbook_runtime.rs:3145:        //   4. if write_spill fired during the sorted loop, it called
crates/ql-exec/src/workbook_runtime.rs:3590:    ) -> Result<(Value, bool, Option<SpillShape>, Option<SpillShape>), RuntimeError> {
crates/ql-exec/src/workbook_runtime.rs:3649:        // materializes via `write_spill` — instead of collapsing to
crates/ql-exec/src/workbook_runtime.rs:3659:        // The clear-old + write_spill sequence mirrors set_formula's
crates/ql-exec/src/workbook_runtime.rs:3680:        // dissolved footprint after eval+write_spill complete.
crates/ql-exec/src/workbook_runtime.rs:3682:        self.workbook.clear_spill_if_present((sheet, row, col));
crates/ql-exec/src/workbook_runtime.rs:3695:        // writes the anchor via `write_spill`; the caller also
crates/ql-exec/src/workbook_runtime.rs:3700:        // NEW shape via write_spill's return. We DON'T fire
crates/ql-exec/src/workbook_runtime.rs:3715:                self.write_spill(sheet, row, col, array, formula_text_arc)
crates/ql-exec/src/workbook_runtime.rs:4029:        wb.put_formula(0, 0, 1, "A1 * 2");
crates/ql-exec/src/workbook_runtime.rs:4060:        wb.put_formula(0, 1, 0, "A1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4062:        wb.put_formula(0, 2, 0, "A1 * 10");
crates/ql-exec/src/workbook_runtime.rs:4064:        wb.put_formula(0, 3, 0, "A1 - 100");
crates/ql-exec/src/workbook_runtime.rs:4310:        wb.put_formula(0, 0, 0, "1000 * TaxRate");
crates/ql-exec/src/workbook_runtime.rs:4420:        wb.put_formula(0, 0, 0, "1 + 4");
crates/ql-exec/src/workbook_runtime.rs:4623:        wb.put_formula(0, 0, 0, "A1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4649:        wb.put_formula(0, 0, 0, "B1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4650:        wb.put_formula(0, 0, 1, "A1 - 1");
crates/ql-exec/src/workbook_runtime.rs:4680:        wb.put_formula(0, 0, 1, "A1 * 2");
crates/ql-exec/src/workbook_runtime.rs:4681:        wb.put_formula(0, 0, 2, "C1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4707:        wb.put_formula(0, 0, 0, "A1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4733:        wb.put_formula(0, 3, 5, "(((");
crates/ql-exec/src/workbook_runtime.rs:4762:        wb.put_formula(0, 1, 0, "A1 + 1"); // good
crates/ql-exec/src/workbook_runtime.rs:4763:        wb.put_formula(0, 2, 0, "A1 * 2"); // good
crates/ql-exec/src/workbook_runtime.rs:4764:        wb.put_formula(0, 3, 0, "A1 - 5"); // good
crates/ql-exec/src/workbook_runtime.rs:4765:        wb.put_formula(0, 4, 0, "((("); // parse error
crates/ql-exec/src/workbook_runtime.rs:4766:        wb.put_formula(0, 5, 0, "@bogus"); // lex error
crates/ql-exec/src/workbook_runtime.rs:4794:        wb.put_formula(0, 0, 0, "@@@"); // lex error
crates/ql-exec/src/workbook_runtime.rs:4795:        wb.put_formula(0, 0, 1, "1 +"); // parse error (trailing operator)
crates/ql-exec/src/workbook_runtime.rs:4796:        wb.put_formula(0, 0, 2, "UnknownName + 1"); // bind error (UnresolvedName)
crates/ql-exec/src/workbook_runtime.rs:4817:        wb.put_formula(0, 1, 0, "A1 / 0"); // evaluates to #DIV/0!
crates/ql-exec/src/workbook_runtime.rs:4838:        wb.put_formula(0, 0, 0, "(((");
crates/ql-exec/src/workbook_runtime.rs:4862:        wb.put_formula(0, 1, 0, "A1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4863:        wb.put_formula(0, 2, 0, "A1 * 2");
crates/ql-exec/src/workbook_runtime.rs:4864:        wb.put_formula(0, 3, 0, "A1 - 3");
crates/ql-exec/src/workbook_runtime.rs:4894:        wb.put_formula(0, 1, 0, "A1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4895:        wb.put_formula(0, 2, 0, "A1 * 2");
crates/ql-exec/src/workbook_runtime.rs:4952:        wb.put_formula(0, 1, 0, "A1 + 1");
crates/ql-exec/src/workbook_runtime.rs:4976:        wb.put_formula(0, 1, 0, "A1 + 100");
crates/ql-exec/src/workbook_runtime.rs:5705:        wb.put_formula(0, 0, 1, "A1 + 1"); // good
crates/ql-exec/src/workbook_runtime.rs:5706:        wb.put_formula(0, 0, 2, "((("); // bad
crates/ql-exec/src/workbook_runtime.rs:5940:                tx.put_formula(sheet_id, 0, 1, "A1 * 2").unwrap();
crates/ql-exec/src/workbook_runtime.rs:6192:        wb.put_formula(0, 0, 0, "B1 + 1");
crates/ql-exec/src/workbook_runtime.rs:6193:        wb.put_formula(0, 0, 1, "A1 + 1");
crates/ql-exec/src/workbook_runtime.rs:6464:        wb.put_formula(0, 0, 1, "SUM(BigRange)");
crates/ql-exec/src/workbook_runtime.rs:8203:            Some(ql_storage::SpillShape::new(1, 3))
crates/ql-exec/src/workbook_runtime.rs:8225:            Some(ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/workbook_runtime.rs:8275:            Some(ql_storage::SpillShape::new(1, 1))
crates/ql-exec/src/workbook_runtime.rs:8533:            Some(ql_storage::SpillShape::new(1, 3))
crates/ql-exec/src/workbook_runtime.rs:8537:    // ===== W5-103 (Phase 4.7.J.4) — register_spill re-extraction =====
crates/ql-exec/src/workbook_runtime.rs:8733:        // clear_spill_at when the host dissolved.
crates/ql-exec/src/workbook_runtime.rs:8748:    /// clear_spill_at twice (which would error the second time).
crates/ql-exec/src/workbook_runtime.rs:8758:        // guard prevents a double-clear. Then clear_spill_if_present
crates/ql-exec/src/workbook_runtime.rs:8765:            Some(ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:8797:            Some(ql_storage::SpillShape::new(1, 2))
crates/ql-exec/src/workbook_runtime.rs:8822:            Some(ql_storage::SpillShape::new(1, 3))
crates/ql-exec/src/workbook_runtime.rs:9007:        // Target cells: computed overlays cleared by clear_spill_at.
crates/ql-exec/src/workbook_runtime.rs:9038:            Some(ql_storage::SpillShape::new(1, 3))
crates/ql-exec/src/workbook_runtime.rs:9054:    /// append happens BEFORE clear_spill_at).
crates/ql-exec/src/workbook_runtime.rs:9169:    // dispatches Array results through `write_spill`, materializing
crates/ql-exec/src/workbook_runtime.rs:9184:        wb.put_formula(0, 0, 0, "{1, 2, 3}");
crates/ql-exec/src/workbook_runtime.rs:9197:            Some(ql_storage::SpillShape::new(1, 3)),
crates/ql-exec/src/workbook_runtime.rs:9213:        wb.put_formula(0, 1, 0, "A1 * 2");
crates/ql-exec/src/workbook_runtime.rs:9233:        wb.put_formula(0, MAX_ROW, 0, "{1; 2; 3}");
crates/ql-exec/src/workbook_runtime.rs:9249:    /// `clear_spill_if_present` inside the recompute path correctly
crates/ql-exec/src/workbook_runtime.rs:9254:        wb.put_formula(0, 0, 0, "{1, 2, 3}");
crates/ql-exec/src/workbook_runtime.rs:9262:            Some(ql_storage::SpillShape::new(1, 3))
crates/ql-exec/src/workbook_runtime.rs:9337:            Some(ql_storage::SpillShape::new(1, 3))
crates/ql-exec/src/workbook_runtime.rs:9448:            Some(ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/workbook_runtime.rs:9466:            Some(ql_storage::SpillShape::new(2, 3))
crates/ql-exec/src/workbook_runtime.rs:9480:    /// ArrayValue which write_spill mapped to `#CALC!`; design says
crates/ql-exec/src/workbook_runtime.rs:9499:        wb.put_formula(0, 0, 0, "SEQUENCE(3)");
crates/ql-exec/src/workbook_runtime.rs:9509:            Some(ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/workbook_runtime.rs:9543:            Some(ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/workbook_runtime.rs:9560:            Some(ql_storage::SpillShape::new(1, 3))
crates/ql-exec/src/workbook_runtime.rs:9577:            Some(ql_storage::SpillShape::new(2, 2))
crates/ql-exec/src/workbook_runtime.rs:9663:            Some(ql_storage::SpillShape::new(1, 2))
crates/ql-exec/src/workbook_runtime.rs:9681:            Some(ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:9719:            Some(ql_storage::SpillShape::new(1, 1))
crates/ql-exec/src/workbook_runtime.rs:9750:            Some(ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/workbook_runtime.rs:9795:            Some(ql_storage::SpillShape::new(1, 2))
crates/ql-exec/src/workbook_runtime.rs:9833:            Some(ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:9848:            Some(ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:9892:            Some(ql_storage::SpillShape::new(1, 2))
crates/ql-exec/src/workbook_runtime.rs:9914:            Some(ql_storage::SpillShape::new(1, 3)),
crates/ql-exec/src/workbook_runtime.rs:9935:    /// → write_spill clears old 3x1 footprint, registers new 5x1, writes
crates/ql-exec/src/workbook_runtime.rs:9951:            Some(ql_storage::SpillShape::new(3, 1))
crates/ql-exec/src/workbook_runtime.rs:9965:            Some(ql_storage::SpillShape::new(5, 1)),
crates/ql-exec/src/workbook_runtime.rs:9987:            Some(ql_storage::SpillShape::new(5, 1))
crates/ql-exec/src/workbook_runtime.rs:9998:            Some(ql_storage::SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:10124:    /// after write_spill; (b) `recompute_dirty` wraps schedule+eval in
crates/ql-exec/src/workbook_runtime.rs:10347:        use ql_storage::SpillShape;
crates/ql-exec/src/workbook_runtime.rs:10351:        wb.register_spill((0, 2, 1), SpillShape::new(3, 1))
crates/ql-exec/src/workbook_runtime.rs:10352:            .expect("register_spill must succeed on empty workbook");
crates/ql-exec/src/workbook_runtime.rs:10378:        use ql_storage::SpillShape;
crates/ql-exec/src/workbook_runtime.rs:10382:        wb.register_spill((0, 0, 10), SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:10383:            .expect("register_spill must succeed");
crates/ql-exec/src/workbook_runtime.rs:10402:        use ql_storage::SpillShape;
crates/ql-exec/src/workbook_runtime.rs:10412:        wb.register_spill((0, 5, 0), SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:10413:            .expect("register_spill must succeed");
crates/ql-exec/src/workbook_runtime.rs:10427:        use ql_storage::SpillShape;
crates/ql-exec/src/workbook_runtime.rs:10436:        wb.register_spill((0, 20, 0), SpillShape::new(2, 1))
crates/ql-exec/src/workbook_runtime.rs:10437:            .expect("register_spill must succeed");

exec
/bin/zsh -lc "awk 'NR>=430 && NR<=470 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
430:    /// Excel canonical: sheet names compare case-insensitively (so
431:    /// `"Sheet1"` and `"SHEET1"` are the same sheet) but the DISPLAY
432:    /// form preserves user-supplied case. This function returns the
433:    /// canonical form used for lookup / duplicate-detection ONLY;
434:    /// display goes through `Sheet::name()`.
435:    ///
436:    /// V1 simplification: ASCII-only uppercase. `"Café"` and `"café"`
437:    /// canonicalize to different forms (the non-ASCII `é` is not
438:    /// folded). Excel itself uses Unicode casefolding here; if a real
439:    /// workbook with non-ASCII sheet names surfaces a collision, this
440:    /// gets revisited.
441:    pub fn canonical_sheet_name(name: &str) -> String {
442:        name.to_ascii_uppercase()
443:    }
444:
445:    /// **Phase 4.6.AA (W5-86):** find a sheet by name (case-insensitive
446:    /// per `canonical_sheet_name`). Returns the first match in id order.
447:    ///
448:    /// Lookup cost: O(sheet_count). Acceptable for typical workbooks
449:    /// (low double-digits of sheets). If profiling shows pain, a
450:    /// canonical-name → id index can be added without changing this
451:    /// API surface.
452:    pub fn sheet_id_by_name(&self, name: &str) -> Option<SheetId> {
453:        let canonical = Self::canonical_sheet_name(name);
454:        for (idx, sheet) in self.sheets.iter().enumerate() {
455:            if Self::canonical_sheet_name(sheet.name()) == canonical {
456:                return Some(idx as SheetId);
457:            }
458:        }
459:        None
460:    }
461:
462:    /// **Phase 4.6.C (W5-91):** rename a sheet by id. Validates the new
463:    /// name via [`validate_sheet_name`] (rejects empty, Excel-reserved
464:    /// chars, canonical duplicates) and swaps the sheet's display name.
465:    ///
466:    /// **DOES NOT touch formula text.** Stored formulas in
467:    /// `formula_cells` and `NamedTarget::Formula` entries continue to
468:    /// reference the OLD sheet name. The runtime wrapper
469:    /// `WorkbookRuntime::rename_sheet` (`ql-exec`) owns the
470:    /// tokenization-aware text rewrite + op-log recording per the

exec
/bin/zsh -lc "awk 'NR>=560 && NR<=795 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "awk 'NR>=1220 && NR<=1360 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1220:    }
1221:
1222:    /// **W5-103 megaudit LOW (Codex pass 2 finding):** anchor-error
1223:    /// write helper. The three blocked-spill arms in `write_spill`
1224:    /// (degenerate → `#CALC!`, bounds → `#SPILL!`, blocking →
1225:    /// `#SPILL!`) all do the same five lines: clear user, write error
1226:    /// to computed, persist formula text, return `(err, None)`.
1227:    /// Factor into one helper so a future fix can't update one arm
1228:    /// and miss another.
1229:    fn write_anchor_error(
1230:        &mut self,
1231:        sheet: SheetId,
1232:        row: RowId,
1233:        col: ColId,
1234:        error: ErrorValue,
1235:        formula_text: Arc<str>,
1236:    ) -> (Value, Option<SpillShape>) {
1237:        let err = Value::Error(error);
1238:        self.workbook.clear_user_at(sheet, row, col);
1239:        self.workbook.put_computed_at(sheet, row, col, err.clone());
1240:        self.workbook.put_formula(sheet, row, col, formula_text);
1241:        (err, None)
1242:    }
1243:
1244:    /// Set a cell to a literal value (no formula). Clears any existing formula
1245:    /// association at the cell — typing a value over a formula cell deletes the
1246:    /// formula per Excel canon. Phase 2A.7 audit H1: validates sheet + row/col
1247:    /// bounds; returns `RuntimeError` instead of panicking on out-of-grid input.
1248:    pub fn set_value(
1249:        &mut self,
1250:        sheet: SheetId,
1251:        row: RowId,
1252:        col: ColId,
1253:        value: Value,
1254:    ) -> Result<(), RuntimeError> {
1255:        validate_cell(self.workbook, sheet, row, col)?;
1256:
1257:        // Phase 2A.3.b: emit ops BEFORE mutating, so a serialization failure
1258:        // (NaN/Inf) leaves the workbook unchanged. `CellWireValue::from_value`
1259:        // returns None for `Value::Blank`; we skip the `PutValue` in that case
1260:        // (documented limitation — replaying a Blank write won't reset a
1261:        // prior non-Blank value; rare enough that the wire-format expansion
1262:        // is deferred to Phase 5+). The `ClearFormula` still fires below if
1263:        // the cell had a formula, so the produced log captures the formula
1264:        // removal even when the literal value is Blank.
1265:        //
1266:        // Phase 2B.7 audit H2 (2026-05-12): when BOTH PutValue and
1267:        // ClearFormula need to land, wrap them in a single `Op::BatchCommit`
1268:        // so the pair is atomic at the Loro level — partial-pair failure
1269:        // (first appended, second fails) is now impossible.
1270:        let had_formula = self.workbook.formula_at(sheet, row, col).is_some();
1271:        if let Some(oplog) = self.oplog.as_deref_mut() {
1272:            let mut log_ops: Vec<Op> = Vec::with_capacity(2);
1273:            if let Some(wire) = CellWireValue::from_value(&value) {
1274:                log_ops.push(Op::PutValue {
1275:                    sheet,
1276:                    row,
1277:                    col,
1278:                    value: wire,
1279:                });
1280:            }
1281:            if had_formula {
1282:                log_ops.push(Op::ClearFormula { sheet, row, col });
1283:            }
1284:            match log_ops.len() {
1285:                0 => {} // Blank value on a non-formula cell — no-op.
1286:                1 => oplog.append(log_ops.into_iter().next().unwrap())?,
1287:                _ => oplog.append(Op::BatchCommit { ops: log_ops })?,
1288:            }
1289:        }
1290:
1291:        // **W5-104 (Phase 4.7.K): spill-aware set_value via
1292:        // immediate-dissolve.** Mirrors set_formula's 4.7.J.5 path.
1293:        // Per design § 10.2 (updated to document both immediate and
1294:        // deferred algorithms — we ship immediate for consistency
1295:        // with set_formula).
1296:        //
1297:        // Two spill-relevant scenarios:
1298:        //
1299:        // a) This cell is a TARGET of someone else's spill: dissolve
1300:        //    that host spill so its anchor re-emits #SPILL! next
1301:        //    recompute and the new user value isn't shadowed by the
1302:        //    host's prior computed-overlay write.
1303:        //
1304:        // b) This cell is itself a SPILL ANCHOR (had a formula like
1305:        //    `={1,2,3}`): dissolve its own spill so the targets become
1306:        //    Blank when the new literal lands at the anchor.
1307:        //
1308:        // The host-vs-self distinction matters because `clear_spill_at`
1309:        // is anchor-keyed: case (a) needs `clear_spill_at(host_anchor)`,
1310:        // case (b) needs `clear_spill_at((sheet, row, col))`. Both can
1311:        // happen for the same write only if (sheet, row, col) is both
1312:        // an anchor of its own spill and a target of another — which
1313:        // `SpillAnchorTable::register` prevents (no overlapping
1314:        // rectangles).
1315:        let dissolved_host: Option<((SheetId, RowId, ColId), SpillShape)> = {
1316:            if let Some(host_anchor) = self.workbook.spill_target_anchor(sheet, row, col) {
1317:                if host_anchor != (sheet, row, col) {
1318:                    let host_shape = self
1319:                        .workbook
1320:                        .spill_anchor_at(host_anchor.0, host_anchor.1, host_anchor.2)
1321:                        .copied()
1322:                        .expect(
1323:                            "spill_target_anchor returned Some — anchor MUST be in anchors table",
1324:                        );
1325:                    let _ = self.workbook.clear_spill_at(host_anchor);
1326:                    Some((host_anchor, host_shape))
1327:                } else {
1328:                    None
1329:                }
1330:            } else {
1331:                None
1332:            }
1333:        };
1334:        // Case (b): self-anchored spill — dissolve before write.
1335:        // Captures the OLD shape so the calcgraph hook pass can fire
1336:        // on_set_value at the dissolved footprint (mirrors 4.7.J.3).
1337:        let dissolved_self_shape = self.workbook.spill_anchor_at(sheet, row, col).copied();
1338:        if dissolved_self_shape.is_some() {
1339:            let _ = self.workbook.clear_spill_at((sheet, row, col));
1340:        }
1341:
1342:        self.workbook.put_at(sheet, row, col, value);
1343:        self.workbook.clear_formula(sheet, row, col);
1344:
1345:        // Phase 3.1: notify calcgraph. `set_value` always fires
1346:        // `on_set_value`; if the cell had a formula that we just cleared,
1347:        // also fires `on_clear_formula` so the graph can detach old deps
1348:        // when Phase 3.3 wires that path.
1349:        if let Some(g) = self.graph.as_deref_mut() {
1350:            g.on_set_value(sheet, row, col);
1351:            if had_formula {
1352:                g.on_clear_formula(sheet, row, col);
1353:            }
1354:        }
1355:
1356:        // **W5-104**: dirty-propagation + re-extraction for dissolved
1357:        // spill footprints. Mirrors set_formula's 4.7.J.3 + 4.7.J.4
1358:        // patterns. Skip the entire pass if no spill state changed.
1359:        let any_dissolution = dissolved_host.is_some() || dissolved_self_shape.is_some();
1360:        if any_dissolution {

 succeeded in 0ms:
560:        //
561:        // The `parse → print_with` round-trip canonicalizes:
562:        //   - R1C1Ref → `$E$3` / `A1` (abs flags from AxisSpec).
563:        //   - `2,5` (DE) → `2.5` (EN).
564:        //   - `SUM(A1; B2)` (DE) → `SUM(A1, B2)` (EN).
565:        //   - `@A1` stays `@A1` (implicit intersection is locale + mode
566:        //     invariant; preserved through canonicalization).
567:        let mode = self.workbook.reference_mode();
568:        let locale = self.workbook.locale();
569:        let addr = ql_types::Address::new(sheet, row, col);
570:        let site = FormulaSite::at_cell(addr);
571:
572:        let tokens = lex_with(raw_text.as_ref(), mode, locale)?;
573:        let expr = parse(tokens)?;
574:        let canonical_text: Arc<str> = Arc::from(print_with(
575:            &expr,
576:            ql_types::ReferenceMode::A1,
577:            ql_types::Locale::EnUs,
578:            Some(site),
579:        )?);
580:        // **W5-147:** downstream code (put_formula, write_spill, the
581:        // failure-tracking path that reads `formula_text` by name) all
582:        // expect a single `formula_text` Arc<str>. Rebind here so the
583:        // canonical form propagates through unchanged code paths.
584:        let formula_text: Arc<str> = Arc::clone(&canonical_text);
585:
586:        // Phase 2B.3: consult the bind-plan cache. **W5-147 update**:
587:        // the cache key now uses `canonical_text` (not the raw input)
588:        // so two writes with different RAW text (`A1` vs `R1C1` for
589:        // the same anchor; `2.5` vs `2,5`) but the same canonical form
590:        // share a single plan. The NameTable-generation slot still
591:        // invalidates on name registration.
592:        //
593:        // **W5-150 (Phase 4.9.O HIGH-1 closure):** `@`-bearing
594:        // canonical text narrows AT BIND TIME using the formula's
595:        // own cell (W5-144). The bound plan is cell-specific, so
596:        // include the cell anchor in the cache key when `@` is
597:        // present. Non-`@` formulas keep `cell_anchor: None` so the
598:        // cache continues to share plans across cells (preserves
599:        // the SUM(A1:A10)-across-rows fast path).
600:        let name_gen = self.workbook.names().generation();
601:        let cell_anchor = if canonical_text.contains('@') {
602:            Some((row, col))
603:        } else {
604:            None
605:        };
606:        let cache_key = PlanCacheKey {
607:            text: Arc::clone(&canonical_text),
608:            sheet,
609:            name_gen,
610:            cell_anchor,
611:        };
612:        let plan: Arc<crate::plan::ExprPlan> =
613:            self.plan_cache
614:                .get_or_insert::<_, RuntimeError>(cache_key, || {
615:                    // We already have the parsed `expr` — bind directly.
616:                    // **W5-114 (Phase 4.8.E):** carry the formula's own cell
617:                    // address through BindSite; 4.8.F's structured-ref
618:                    // `[@Col]` resolution reads it.
619:                    Ok(bind_with_site(
620:                        &expr,
621:                        BindSite::at_cell(addr),
622:                        self.workbook,
623:                        self.workbook,
624:                        self.workbook,
625:                    )?)
626:                })?;
627:
628:        // **Phase 2A.3.b op-log emission, BEFORE any storage mutation.**
629:        // The contract on this method ("On error, the workbook is unchanged")
630:        // requires that op-log append fail BEFORE we touch workbook state.
631:        // We emit `PutFormula` only — the evaluated value isn't recorded
632:        // because replay re-derives it via `WorkbookRuntime::recompute_all`
633:        // (see replay.rs module docs).
634:        //
635:        // **W5-103 megaudit HIGH-3 closure** (Codex pass-2 finding): pre-4.7.J
636:        // ordering had this append BEFORE mutation. The 4.7.J.5 +
637:        // 4.7.J.2 clear_spill calls were inserted between bind and append,
638:        // which broke atomicity — a failing append would leave the host
639:        // spill / old self-spill already dissolved. Restored ordering:
640:        // bind → append → (only then) clear_spill mutations.
641:        if let Some(oplog) = self.oplog.as_deref_mut() {
642:            oplog.append(Op::PutFormula {
643:                sheet,
644:                row,
645:                col,
646:                // **W5-147 (Phase 4.9.K):** persist CANONICAL (A1+EnUs)
647:                // text per design § 4.4. Replay against a fresh
648:                // workbook re-applies the canonical text regardless
649:                // of the original user-typed mode / locale.
650:                text: canonical_text.as_ref().to_owned(),
651:            })?;
652:        }
653:
654:        // **W5-103 (Phase 4.7.J.5 / Codex W5-102 MEDIUM-3):** if the
655:        // target cell is currently a non-anchor cell of someone else's
656:        // spill, dissolve THAT spill first. Per design § 10.2 (user
657:        // write into spill target): typing into a spilled cell breaks
658:        // the host spill — the host's anchor formula stays put, but
659:        // re-eval at the host (next recompute) will see this cell as
660:        // a blocker and emit #SPILL!.
661:        //
662:        // **W5-103 megaudit HIGH-1 closure (#127, all 3 reviewers
663:        // cross-confirmed):** capture the host's footprint BEFORE
664:        // clearing it so the on_set_value + re-extract passes below
665:        // can also walk the host's old footprint. Without this:
666:        //   - Readers of OTHER host-target cells (siblings of the
667:        //     edited cell) don't dirty.
668:        //   - Readers producer-aliased to the host anchor stay
669:        //     stale (their alias dep should re-route post-dissolution).
670:        //   - The host anchor's formula node is NEVER marked dirty,
671:        //     so recompute_dirty leaves it indefinitely stale. The
672:        //     storage layer (no spill) and dirty set (anchor not
673:        //     dirty) diverge until an unrelated edit touches the
674:        //     anchor cell. Sonnet's sharp framing in the megaudit.
675:        //
676:        // We perform this dissolution UP FRONT (before the
677:        // self-spill clear below) because:
678:        //   - The host spill's anchor is at a DIFFERENT cell, so its
679:        //     footprint isn't covered by `clear_spill_if_present` below.
680:        //   - The new formula at (sheet, row, col) needs the host's
681:        //     prior computed-overlay value cleared from this cell so
682:        //     `write_spill`'s blocking check doesn't see it as occupied.
683:        //
684:        // Records (host_anchor, host_shape) when dissolution happens;
685:        // the on_set_value + re-extract passes consume this below.
686:        let dissolved_host: Option<((SheetId, RowId, ColId), SpillShape)> = {
687:            if let Some(host_anchor) = self.workbook.spill_target_anchor(sheet, row, col) {
688:                if host_anchor != (sheet, row, col) {
689:                    let host_shape = self
690:                        .workbook
691:                        .spill_anchor_at(host_anchor.0, host_anchor.1, host_anchor.2)
692:                        .copied()
693:                        .expect(
694:                            "spill_target_anchor returned Some — anchor MUST be in anchors table",
695:                        );
696:                    // Idempotent — `clear_spill_at` errors with
697:                    // SpillNotFoundError if the anchor isn't registered,
698:                    // which can't happen here (target_anchor returned Some).
699:                    let _ = self.workbook.clear_spill_at(host_anchor);
700:                    Some((host_anchor, host_shape))
701:                } else {
702:                    None
703:                }
704:            } else {
705:                None
706:            }
707:        };
708:
709:        // **W5-103 (Phase 4.7.J.2 / Codex W5-102 MEDIUM-4):** clear any
710:        // PRIOR spill anchored at this cell BEFORE eval. Per design § 8.3:
711:        // every re-eval at an anchor cell starts by dissolving the old
712:        // footprint, EVEN IF the new result will block. Without this,
713:        // a 3-row spill shrinking to 1 row would leave the old A2/A3
714:        // computed entries in place; or a re-eval that blocks would
715:        // self-block against its own old footprint.
716:        //
717:        // `clear_spill_if_present` is a no-op when no spill exists.
718:        //
719:        // **W5-103 (Phase 4.7.J.3 / Codex W5-102 MEDIUM-1):** capture
720:        // the OLD footprint BEFORE we clear it so the calcgraph hook
721:        // pass below can fire `on_set_value` for each cell that lost
722:        // its previous spilled value. Otherwise pre-existing readers
723:        // indexed under target cells (HIGH-1 problem) won't see that
724:        // their dep cell is now Blank.
725:        let old_spill_shape = self.workbook.spill_anchor_at(sheet, row, col).copied();
726:        self.workbook.clear_spill_if_present((sheet, row, col));
727:
728:        // Evaluate at the cell boundary. Returns `EvalResult::Scalar`
729:        // for every plan whose outermost node is non-Array; returns
730:        // `EvalResult::Array` for top-level `ExprPlan::Array(_)` (and,
731:        // later, array-returning functions — Phase 4.7.M/N).
732:        //
733:        // Phase 3.6 (W5-39): when a session is attached, route through
734:        // `eval_scalar_with_cache` (inside `eval_at_cell_boundary`) so
735:        // aggregate-range results land in the session's cache.
736:        let result: EvalResult = {
737:            // **W5-117 (Phase 4.8.G.2):** carry the formula's cell for
738:            // structured-ref `[@Col]` row narrowing at eval time.
739:            let env = WorkbookEnv::with_formula_cell(
740:                self.workbook,
741:                ql_types::Address::new(sheet, row, col),
742:            );
743:            match self.graph.as_deref() {
744:                Some(session) => crate::scalar::eval_at_cell_boundary(
745:                    plan.as_ref(),
746:                    &env,
747:                    self.registry,
748:                    session.aggregate_cache(),
749:                ),
750:                None => {
751:                    // No session attached: synthesize a no-op cache.
752:                    // The legacy `eval_scalar_with_registry` did the
753:                    // equivalent through `NoAggregateCache`; we do the
754:                    // same here for cell-boundary parity.
755:                    let nc = crate::aggregate_cache::NoAggregateCache;
756:                    crate::scalar::eval_at_cell_boundary(plan.as_ref(), &env, self.registry, &nc)
757:                }
758:            }
759:        };
760:
761:        // **Route by EvalResult variant.** Scalar takes the existing
762:        // single-cell write path; Array routes to spill writeback.
763:        // The Array path also returns the SHAPE of the spill on the
764:        // happy path (None on degenerate/bounds/blocked outcomes) so
765:        // the calcgraph hook pass below can fire `on_set_value` at
766:        // each target cell.
767:        let (anchor_value, new_spill_shape) = match result {
768:            EvalResult::Scalar(v) => {
769:                // Existing scalar persistence path. Phase 3.5 (CORR-25):
770:                // a formula's output goes to the COMPUTED overlay, not
771:                // the user overlay; clear any stale user-overlay entry
772:                // first so the user-first read cascade doesn't mask
773:                // the new output.
774:                self.workbook.clear_user_at(sheet, row, col);
775:                self.workbook.put_computed_at(sheet, row, col, v.clone());
776:                self.workbook.put_formula(sheet, row, col, formula_text);
777:                (v, None)
778:            }
779:            EvalResult::Array(array) => self.write_spill(sheet, row, col, array, formula_text),
780:        };
781:
782:        // Phase 3.1: notify calcgraph after the workbook mutation
783:        // succeeds. Phase 3.2 (2026-05-12): pass the already-bound
784:        // `ExprPlan` straight from the PlanCache so the hook walks it
785:        // for cell/range/name + volatile deps without re-binding. The
786:        // plan is shared by Arc; the hook only needs `&ExprPlan`.
787:        // **W5-102 (Phase 4.7.I):** also pass `&Workbook` so the dep
788:        // extractor can rewrite spill-target CellRefs to point at the
789:        // anchor's formula node (producer-alias model, design § 10.1).
790:        if let Some(g) = self.graph.as_deref_mut() {
791:            g.on_set_formula(sheet, row, col, plan.as_ref(), self.workbook);
792:        }
793:
794:        // **W5-103 (Phase 4.7.J.3 / Codex W5-102 MEDIUM-1):** fire
795:        // `on_set_value` at every NON-ANCHOR cell in:

exec
/bin/zsh -lc "awk 'NR>=720 && NR<=775 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
720:    /// target cell value AFTER `register_spill` succeeds.
721:    pub fn register_spill(
722:        &mut self,
723:        anchor: (SheetId, RowId, ColId),
724:        shape: crate::SpillShape,
725:    ) -> Result<(), crate::SpillBlockError> {
726:        self.spill_anchors.register(anchor, shape)
727:    }
728:
729:    /// **W5-101 (Phase 4.7.H):** workbook-layer convenience: unregister
730:    /// the anchor + clear the computed overlay at every target cell.
731:    /// This is the function the runtime calls during the "clear old
732:    /// spill before re-eval" step (design § 8.3) and when clearing a
733:    /// formula at an anchor cell (design § 10.3).
734:    ///
735:    /// Errors:
736:    /// - `SpillNotFoundError` — the cell isn't an anchor. Callers that
737:    ///   want a no-op-on-miss behavior should pre-check
738:    ///   `spill_anchor_at(...).is_some()`.
739:    pub fn clear_spill_at(
740:        &mut self,
741:        anchor: (SheetId, RowId, ColId),
742:    ) -> Result<(), crate::SpillNotFoundError> {
743:        let shape = self.spill_anchors.unregister(anchor)?;
744:        // Iterate the cleared rectangle and clear computed overlays.
745:        // This is the coupling reason `clear_spill_at` lives on
746:        // `Workbook` (which owns sheet access) rather than on the
747:        // map-only `SpillAnchorTable`.
748:        let (asheet, arow, acol) = anchor;
749:        if let Some(sheet) = self.sheets.get_mut(asheet as usize) {
750:            for dr in 0..shape.rows {
751:                for dc in 0..shape.cols {
752:                    sheet.clear_computed(arow + dr, acol + dc);
753:                }
754:            }
755:        }
756:        Ok(())
757:    }
758:
759:    /// **W5-101-AUDIT (Codex LOW-3):** idempotent variant of
760:    /// `clear_spill_at`. Returns `true` if a spill was cleared, `false`
761:    /// if no anchor was registered at the cell. Friendlier API for the
762:    /// runtime spill-writeback path (Phase 4.7.J) which calls "clear
763:    /// before re-eval" regardless of whether a prior spill existed.
764:    /// Equivalent to `clear_spill_at(anchor).is_ok()` semantically.
765:    pub fn clear_spill_if_present(&mut self, anchor: (SheetId, RowId, ColId)) -> bool {
766:        self.clear_spill_at(anchor).is_ok()
767:    }
768:
769:    /// Read by `Address`.
770:    ///
771:    /// - **Missing sheet** (sheet id ≥ `sheet_count()`) → `Value::Error(Ref)`
772:    ///   (Excel canon: `#REF!`).
773:    /// - **Within-sheet missing row/col** → `Value::Blank` (Excel canon: empty
774:    ///   cell coerces to 0 / "" / FALSE in arithmetic / text / logical
775:    ///   contexts).

exec
/bin/zsh -lc "awk 'NR>=9168 && NR<=9270 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
9168:    // directly. With the cell-boundary refactor, recompute now
9169:    // dispatches Array results through `write_spill`, materializing
9170:    // the full footprint on every recompute pass.
9171:
9172:    /// HIGH-2 acceptance: op-log replay of `PutFormula { text:
9173:    /// "{1, 2, 3}" }` followed by `recompute_all` MUST produce the
9174:    /// spill, not `#CALC!`. This is the canonical persistence
9175:    /// round-trip — the design § 7.3 / § 12.3 "load → recompute
9176:    /// re-derives spills" contract.
9177:    #[test]
9178:    fn recompute_all_materializes_spill_for_array_formula() {
9179:        let mut wb = make_runtime_workbook();
9180:        // Simulate the post-replay state: formula text installed, no
9181:        // computed values, no spill anchor entry. (Op::PutFormula's
9182:        // replay handler at crates/ql-oplog/src/replay.rs only sets
9183:        // the formula text; recompute is left to the caller.)
9184:        wb.put_formula(0, 0, 0, "{1, 2, 3}");
9185:        let reg = default_registry();
9186:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
9187:
9188:        let result = rt.recompute_all();
9189:        drop(rt);
9190:        assert_eq!(result.attempted, 1);
9191:        assert_eq!(result.succeeded, 1);
9192:        assert!(result.failures.is_empty());
9193:
9194:        // Spill registered + targets materialized.
9195:        assert_eq!(
9196:            wb.spill_anchor_at(0, 0, 0).copied(),
9197:            Some(ql_storage::SpillShape::new(1, 3)),
9198:            "recompute_all must register the spill anchor"
9199:        );
9200:        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(1.0));
9201:        assert_eq!(wb.read(ql_types::Address::new(0, 0, 1)), Value::Number(2.0));
9202:        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
9203:    }
9204:
9205:    /// recompute_all on a SCALAR formula keeps its existing behavior
9206:    /// — pre-fix this case used `eval_scalar_with_cache` directly,
9207:    /// which is what the refactor preserves for non-Array results.
9208:    /// Regression check.
9209:    #[test]
9210:    fn recompute_all_scalar_formula_unchanged() {
9211:        let mut wb = make_runtime_workbook();
9212:        wb.put_at(0, 0, 0, Value::Number(10.0));
9213:        wb.put_formula(0, 1, 0, "A1 * 2");
9214:        let reg = default_registry();
9215:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
9216:        let result = rt.recompute_all();
9217:        drop(rt);
9218:        assert_eq!(result.succeeded, 1);
9219:        assert_eq!(
9220:            wb.read(ql_types::Address::new(0, 1, 0)),
9221:            Value::Number(20.0)
9222:        );
9223:    }
9224:
9225:    /// recompute_all on an array formula that would spill out of
9226:    /// bounds writes #SPILL! at the anchor — same as set_formula's
9227:    /// bounds-check arm. Pre-fix this case produced #CALC! too
9228:    /// (silent corruption); post-fix it produces #SPILL!.
9229:    #[test]
9230:    fn recompute_all_out_of_bounds_spill_writes_spill_error() {
9231:        let mut wb = make_runtime_workbook();
9232:        // Anchor at MAX_ROW with 3-row vertical array → out of bounds.
9233:        wb.put_formula(0, MAX_ROW, 0, "{1; 2; 3}");
9234:        let reg = default_registry();
9235:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
9236:        let result = rt.recompute_all();
9237:        drop(rt);
9238:        assert_eq!(result.succeeded, 1);
9239:        assert_eq!(
9240:            wb.read(ql_types::Address::new(0, MAX_ROW, 0)),
9241:            Value::Error(ErrorValue::Spill)
9242:        );
9243:        assert_eq!(wb.spill_anchor_at(0, MAX_ROW, 0), None);
9244:    }
9245:
9246:    /// Re-run of recompute_all on an already-spilled formula must
9247:    /// be idempotent: the spill stays registered with the same
9248:    /// shape, the target values match. Validates that
9249:    /// `clear_spill_if_present` inside the recompute path correctly
9250:    /// dissolves the old footprint before re-spilling.
9251:    #[test]
9252:    fn recompute_all_array_formula_idempotent_across_two_passes() {
9253:        let mut wb = make_runtime_workbook();
9254:        wb.put_formula(0, 0, 0, "{1, 2, 3}");
9255:        let reg = default_registry();
9256:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
9257:        rt.recompute_all();
9258:        rt.recompute_all();
9259:        drop(rt);
9260:        assert_eq!(
9261:            wb.spill_anchor_at(0, 0, 0).copied(),
9262:            Some(ql_storage::SpillShape::new(1, 3))
9263:        );
9264:        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(3.0));
9265:    }
9266:
9267:    // ===== W5-104 (Phase 4.7.K) — set_value spill invalidation =====
9268:    //
9269:    // Per design § 10.2 (immediate-dissolve variant, matching
9270:    // set_formula's 4.7.J.5): typing a literal value into a spill

exec
/bin/zsh -lc "awk 'NR>=330 && NR<=430 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/tests/oplog_e2e.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
330:        producer_oplog.len(),
331:        "oplog op count mismatch after save/load"
332:    );
333:
334:    // ===== Replay against fresh workbook + recompute =====
335:    let mut replay_wb = fresh_wb();
336:    replay_into(&loaded_oplog, &mut replay_wb, &reg).unwrap();
337:    {
338:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
339:        assert!(
340:            rt.recompute_all().is_complete(),
341:            "recompute on replay-side workbook had failures"
342:        );
343:    }
344:
345:    // ===== Equivalence =====
346:    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
347:
348:    // And the loaded workbook ALONE (without replay) matches the producer —
349:    // it was saved with the materialized values intact.
350:    let (loaded_wb_alone, _) = load_workbook_with_oplog(&path).unwrap();
351:    // After load_workbook, formula values are Pending (Blank) — the
352:    // loaded workbook has the formula TEXT and the SAVED value. The saved
353:    // value was the producer's evaluated result, so it should still match.
354:    assert_eq!(
355:        loaded_wb_alone.read(Address::new(0, 0, 2)),
356:        Value::Number(7.0)
357:    );
358:    assert_eq!(
359:        loaded_wb_alone.read(Address::new(0, 0, 3)),
360:        Value::Number(99.0)
361:    );
362:}
363:
364:/// Sanity check: ensure `WorkbookTransaction::with_oplog` standalone (no
365:/// enclosing runtime) also produces valid ops.
366:#[test]
367:fn standalone_transaction_with_oplog_produces_batch_commit() {
368:    let mut wb = fresh_wb();
369:    let reg = default_registry();
370:    let mut oplog = OpLog::new();
371:    {
372:        let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
373:        tx.put_value(0, 0, 0, Value::Number(42.0)).unwrap();
374:        tx.put_value(0, 0, 1, Value::Number(43.0)).unwrap();
375:        tx.commit().unwrap();
376:    }
377:    // One BatchCommit with 2 inner ops.
378:    assert_eq!(oplog.len(), 1);
379:
380:    let mut replay_wb = fresh_wb();
381:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
382:    assert_eq!(replay_wb.read(Address::new(0, 0, 0)), Value::Number(42.0));
383:    assert_eq!(replay_wb.read(Address::new(0, 0, 1)), Value::Number(43.0));
384:}
385:
386:// ===== W5-84 closure (Codex MEDIUM + Sonnet MEDIUM I.2):
387://       E2E format persistence round-trip =====
388:
389:/// Real producer → save to `.qbook` → load → recompute → `read_display`.
390:/// This is the full end-to-end persistence + display path for the
391:/// Phase 4.5.D + 4.5.E arc. Prior tests covered the layers in
392:/// isolation but never the combined flow.
393:#[test]
394:fn format_persistence_round_trip_through_qbook() {
395:    use ql_storage::FormatId;
396:
397:    let dir = tempfile::TempDir::new().unwrap();
398:    let path = dir.path().join("formats_e2e.qbook");
399:    let reg = default_registry();
400:
401:    // ===== Producer side =====
402:    let mut producer_wb = fresh_wb();
403:    let custom_id;
404:    {
405:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
406:        // Number value with built-in date format.
407:        rt.set_value(0, 0, 0, Value::Number(45477.0)).unwrap(); // 2024-07-04
408:        rt.set_cell_format(0, 0, 0, Some(FormatId(14))).unwrap();
409:        // Number value with custom format.
410:        rt.set_value(0, 1, 0, Value::Number(1234.5)).unwrap();
411:        custom_id = rt.intern_format("#,##0.00").unwrap();
412:        rt.set_cell_format(0, 1, 0, Some(custom_id)).unwrap();
413:        // Formula that uses TEXT() — value should be the rendered string.
414:        rt.set_formula(0, 2, 0, "TEXT(A1, \"yyyy-mm-dd\")").unwrap();
415:        let _ = rt.recompute_all();
416:    }
417:    // Snapshot expected display values on the producer side.
418:    let producer_display_a1 = {
419:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
420:        rt.read_display(0, 0, 0)
421:    };
422:    let producer_display_a2 = {
423:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
424:        rt.read_display(0, 1, 0)
425:    };
426:    assert_eq!(producer_display_a1, "7/4/2024");
427:    assert_eq!(producer_display_a2, "1,234.50");
428:
429:    // ===== Save =====
430:    ql_io::save_workbook(&producer_wb, "formats_e2e", &path).unwrap();

exec
/bin/zsh -lc "rg -n \"spill|Spill|spill_anchor|spill_anchors|register_spill|clear_spill\" crates/ql-io/src crates/ql-storage/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-storage/src/tables.rs:236:    ///    range (skipping all overlap / spill-anchor checks) or runs
crates/ql-io/src/qbook_format.rs:910:        "#SPILL!" => ErrorValue::Spill,
crates/ql-io/src/qbook_format.rs:1474:                // non-anchor spill TARGET cells. Their computed values are
crates/ql-io/src/qbook_format.rs:1478:                // `write_spill`). Saving target cells would emit
crates/ql-io/src/qbook_format.rs:1479:                // `CellRecord { value: <spilled>, formula: None }` records
crates/ql-io/src/qbook_format.rs:1481:                // re-spill — the very issue Codex W5-94 design HIGH-5
crates/ql-io/src/qbook_format.rs:1486:                if let Some(anchor) = wb.spill_target_anchor(sheet_id, row, col) {
crates/ql-io/src/qbook_format.rs:3390:    /// **W5-105 (Phase 4.7.L)**: spill TARGET cells must NOT be saved
crates/ql-io/src/qbook_format.rs:3396:    fn spill_target_cells_skipped_on_save() {
crates/ql-io/src/qbook_format.rs:3398:        let path = dir.path().join("spill-skip.qbook");
crates/ql-io/src/qbook_format.rs:3405:        //   - Spill anchor registered with shape (1, 3).
crates/ql-io/src/qbook_format.rs:3410:        wb.register_spill((s, 0, 0), ql_storage::SpillShape::new(1, 3))
crates/ql-io/src/qbook_format.rs:3413:        save_workbook(&wb, "spill-skip", &path).unwrap();
crates/ql-io/src/qbook_format.rs:3434:                "{name} record must NOT appear in saved JSONL (spill target). got:\n{content}"
crates/ql-io/src/qbook_format.rs:3440:    /// spill, load it back, verify:
crates/ql-io/src/qbook_format.rs:3447:    ///   - the SpillAnchorTable + target cells (B1, C1) are EMPTY.
crates/ql-io/src/qbook_format.rs:3450:    fn spill_targets_load_as_blank_pending_recompute() {
crates/ql-io/src/qbook_format.rs:3452:        let path = dir.path().join("spill-load.qbook");
crates/ql-io/src/qbook_format.rs:3460:        wb.register_spill((s, 0, 0), ql_storage::SpillShape::new(1, 3))
crates/ql-io/src/qbook_format.rs:3463:        save_workbook(&wb, "spill-load", &path).unwrap();
crates/ql-io/src/qbook_format.rs:3474:        // then routes through write_spill → clear_user_at → put_computed_at
crates/ql-io/src/qbook_format.rs:3480:        // SpillAnchorTable does NOT round-trip — it's runtime-derived
crates/ql-io/src/qbook_format.rs:3482:        // no spill state until recompute fires.
crates/ql-io/src/qbook_format.rs:3483:        assert_eq!(loaded.spill_anchor_at(s, 0, 0), None);
crates/ql-storage/src/lib.rs:20://! `SheetNameError`, `SpillBlockError`) — downstream consumers must
crates/ql-storage/src/lib.rs:31:pub mod spill;
crates/ql-storage/src/lib.rs:40:pub use spill::{SpillAnchorTable, SpillBlockError, SpillNotFoundError, SpillShape};
crates/ql-storage/src/workbook.rs:313:    /// **W5-101 (Phase 4.7.H):** spill-anchor table. Workbook-level
crates/ql-storage/src/workbook.rs:314:    /// because spills can theoretically span sheets (rare in Excel; v1
crates/ql-storage/src/workbook.rs:316:    /// design; mutation goes through `register_spill` / `clear_spill_at`
crates/ql-storage/src/workbook.rs:319:    /// `crates/ql-storage/src/spill.rs` module docs.
crates/ql-storage/src/workbook.rs:320:    spill_anchors: crate::SpillAnchorTable,
crates/ql-storage/src/workbook.rs:574:    /// - `write_spill` to block spill anchors inside table footprints
crates/ql-storage/src/workbook.rs:683:    // ===== W5-101 (Phase 4.7.H) spill-anchor API =====
crates/ql-storage/src/workbook.rs:685:    /// **W5-101 (Phase 4.7.H):** read access to the spill-anchor table.
crates/ql-storage/src/workbook.rs:688:    pub fn spill_anchors(&self) -> &crate::SpillAnchorTable {
crates/ql-storage/src/workbook.rs:689:        &self.spill_anchors
crates/ql-storage/src/workbook.rs:693:    /// active spill anchor? Returns `Some(&shape)` iff yes. Delegates to
crates/ql-storage/src/workbook.rs:694:    /// `SpillAnchorTable::anchor_at`.
crates/ql-storage/src/workbook.rs:695:    pub fn spill_anchor_at(
crates/ql-storage/src/workbook.rs:700:    ) -> Option<&crate::SpillShape> {
crates/ql-storage/src/workbook.rs:701:        self.spill_anchors.anchor_at(sheet, row, col)
crates/ql-storage/src/workbook.rs:705:    /// is a spill target (anchor or any non-anchor target cell), return
crates/ql-storage/src/workbook.rs:706:    /// the anchor. `O(1)`. Used by the runtime spill-invalidation path
crates/ql-storage/src/workbook.rs:707:    /// (4.7.K) on `set_value` to detect user writes into spill ranges.
crates/ql-storage/src/workbook.rs:708:    pub fn spill_target_anchor(
crates/ql-storage/src/workbook.rs:714:        self.spill_anchors.target_anchor(sheet, row, col)
crates/ql-storage/src/workbook.rs:717:    /// **W5-101 (Phase 4.7.H):** register a new spill. Map-only — does
crates/ql-storage/src/workbook.rs:718:    /// NOT touch computed overlays. The runtime spill-writeback path
crates/ql-storage/src/workbook.rs:720:    /// target cell value AFTER `register_spill` succeeds.
crates/ql-storage/src/workbook.rs:721:    pub fn register_spill(
crates/ql-storage/src/workbook.rs:724:        shape: crate::SpillShape,
crates/ql-storage/src/workbook.rs:725:    ) -> Result<(), crate::SpillBlockError> {
crates/ql-storage/src/workbook.rs:726:        self.spill_anchors.register(anchor, shape)
crates/ql-storage/src/workbook.rs:732:    /// spill before re-eval" step (design § 8.3) and when clearing a
crates/ql-storage/src/workbook.rs:736:    /// - `SpillNotFoundError` — the cell isn't an anchor. Callers that
crates/ql-storage/src/workbook.rs:738:    ///   `spill_anchor_at(...).is_some()`.
crates/ql-storage/src/workbook.rs:739:    pub fn clear_spill_at(
crates/ql-storage/src/workbook.rs:742:    ) -> Result<(), crate::SpillNotFoundError> {
crates/ql-storage/src/workbook.rs:743:        let shape = self.spill_anchors.unregister(anchor)?;
crates/ql-storage/src/workbook.rs:745:        // This is the coupling reason `clear_spill_at` lives on
crates/ql-storage/src/workbook.rs:747:        // map-only `SpillAnchorTable`.
crates/ql-storage/src/workbook.rs:760:    /// `clear_spill_at`. Returns `true` if a spill was cleared, `false`
crates/ql-storage/src/workbook.rs:762:    /// runtime spill-writeback path (Phase 4.7.J) which calls "clear
crates/ql-storage/src/workbook.rs:763:    /// before re-eval" regardless of whether a prior spill existed.
crates/ql-storage/src/workbook.rs:764:    /// Equivalent to `clear_spill_at(anchor).is_ok()` semantically.
crates/ql-storage/src/workbook.rs:765:    pub fn clear_spill_if_present(&mut self, anchor: (SheetId, RowId, ColId)) -> bool {
crates/ql-storage/src/workbook.rs:766:        self.clear_spill_at(anchor).is_ok()
crates/ql-storage/src/workbook.rs:1471:    // ===== W5-101 (Phase 4.7.H) Workbook spill-anchor integration =====
crates/ql-storage/src/workbook.rs:1474:    fn workbook_register_spill_round_trip() {
crates/ql-storage/src/workbook.rs:1477:        // Register a 2x3 spill at (0, 1, 1) — covers B2:D3.
crates/ql-storage/src/workbook.rs:1478:        wb.register_spill((0, 1, 1), crate::SpillShape::new(2, 3))
crates/ql-storage/src/workbook.rs:1481:            wb.spill_anchor_at(0, 1, 1),
crates/ql-storage/src/workbook.rs:1482:            Some(&crate::SpillShape::new(2, 3))
crates/ql-storage/src/workbook.rs:1488:                    wb.spill_target_anchor(0, 1 + dr, 1 + dc),
crates/ql-storage/src/workbook.rs:1499:    fn workbook_clear_spill_at_clears_computed_overlays() {
crates/ql-storage/src/workbook.rs:1502:        // Register a 1x3 spill at (0, 0, 0) covering A1:C1.
crates/ql-storage/src/workbook.rs:1503:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
crates/ql-storage/src/workbook.rs:1513:        // clear_spill_at: unregisters AND clears overlays at every target.
crates/ql-storage/src/workbook.rs:1514:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/workbook.rs:1516:        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
crates/ql-storage/src/workbook.rs:1517:        assert!(wb.spill_target_anchor(0, 0, 1).is_none());
crates/ql-storage/src/workbook.rs:1525:    fn workbook_register_spill_rejects_collision_with_existing() {
crates/ql-storage/src/workbook.rs:1528:        wb.register_spill((0, 0, 0), crate::SpillShape::new(3, 1))
crates/ql-storage/src/workbook.rs:1530:        // Second spill at (0, 1, 0) would overlap A2/A3 of the first.
crates/ql-storage/src/workbook.rs:1532:            .register_spill((0, 1, 0), crate::SpillShape::new(3, 1))
crates/ql-storage/src/workbook.rs:1536:            crate::SpillBlockError::TargetCellOccupied { .. }
crates/ql-storage/src/workbook.rs:1541:    fn workbook_clear_spill_at_unknown_anchor_errors() {
crates/ql-storage/src/workbook.rs:1544:        let err = wb.clear_spill_at((0, 5, 5)).unwrap_err();
crates/ql-storage/src/workbook.rs:1550:    fn workbook_clear_spill_at_preserves_user_overlays_outside_rectangle() {
crates/ql-storage/src/workbook.rs:1551:        // A user-typed value outside the spill rectangle must survive
crates/ql-storage/src/workbook.rs:1552:        // clear_spill_at. Verifies the clear loop is bounded to the
crates/ql-storage/src/workbook.rs:1556:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 3))
crates/ql-storage/src/workbook.rs:1561:        // User value at A2 (row 1, col 0) — OUTSIDE the 1x3 spill.
crates/ql-storage/src/workbook.rs:1563:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/workbook.rs:1564:        // Spill range cleared.
crates/ql-storage/src/workbook.rs:1571:    fn workbook_spill_anchors_accessor_returns_table() {
crates/ql-storage/src/workbook.rs:1574:        assert_eq!(wb.spill_anchors().len(), 0);
crates/ql-storage/src/workbook.rs:1575:        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 2))
crates/ql-storage/src/workbook.rs:1577:        wb.register_spill((0, 5, 5), crate::SpillShape::new(1, 1))
crates/ql-storage/src/workbook.rs:1579:        assert_eq!(wb.spill_anchors().len(), 2);
crates/ql-storage/src/workbook.rs:1582:    // ===== W5-101-AUDIT (Codex LOW-3) — clear_spill_if_present =====
crates/ql-storage/src/workbook.rs:1585:    fn workbook_clear_spill_if_present_returns_true_when_cleared() {
crates/ql-storage/src/workbook.rs:1588:        wb.register_spill((0, 0, 0), crate::SpillShape::new(2, 1))
crates/ql-storage/src/workbook.rs:1590:        let cleared = wb.clear_spill_if_present((0, 0, 0));
crates/ql-storage/src/workbook.rs:1592:        assert!(wb.spill_anchor_at(0, 0, 0).is_none());
crates/ql-storage/src/workbook.rs:1596:    fn workbook_clear_spill_if_present_returns_false_when_missing() {
crates/ql-storage/src/workbook.rs:1600:        let cleared = wb.clear_spill_if_present((0, 5, 5));
crates/ql-storage/src/workbook.rs:1605:    fn workbook_clear_spill_at_clears_anchor_own_computed_overlay() {
crates/ql-storage/src/workbook.rs:1607:        // (the (0,0) of its own spill range) gets its computed
crates/ql-storage/src/workbook.rs:1611:        wb.register_spill((0, 0, 0), crate::SpillShape::new(1, 1))
crates/ql-storage/src/workbook.rs:1615:        wb.clear_spill_at((0, 0, 0)).unwrap();
crates/ql-storage/src/spill.rs:1://! Spill-anchor storage — workbook-level table mapping anchor cells to
crates/ql-storage/src/spill.rs:2://! their spill shapes, with a reverse map from each spilled-into cell
crates/ql-storage/src/spill.rs:6://! dynamic-array spills. Per design doc § 7:
crates/ql-storage/src/spill.rs:7://! `docs/architecture/2026-05-14-array-formulas-and-spills.md` § 7.
crates/ql-storage/src/spill.rs:12://! SpillAnchorTable {
crates/ql-storage/src/spill.rs:13://!     anchors:  HashMap<(SheetId, RowId, ColId), SpillShape>,
crates/ql-storage/src/spill.rs:18://! - `anchors` — one entry per spilling formula. Key is the anchor cell
crates/ql-storage/src/spill.rs:19://!   (top-left of the spill rectangle); value is the rectangle's
crates/ql-storage/src/spill.rs:22://!   spill?" lookup at user-write / dep-extraction time. Key is each
crates/ql-storage/src/spill.rs:23://!   cell in the spill rectangle (including the anchor itself); value
crates/ql-storage/src/spill.rs:34://!    spill-detection logic at user-write time — a single map lookup
crates/ql-storage/src/spill.rs:35://!    answers "is this cell part of a spill (anchor or otherwise)?".
crates/ql-storage/src/spill.rs:41://! Per Codex W5-94 design review MEDIUM (§ 7): `SpillAnchorTable` is
crates/ql-storage/src/spill.rs:42://! intentionally map-only. Overlay clearing on spill removal lives in
crates/ql-storage/src/spill.rs:43://! `Workbook::clear_spill_at`, which couples the table mutation with
crates/ql-storage/src/spill.rs:52:/// Spill-rectangle dimensions. `rows * cols` is the total cell count;
crates/ql-storage/src/spill.rs:55:/// `SpillAnchorTable::register` requires both `rows >= 1` and `cols >= 1`
crates/ql-storage/src/spill.rs:58:pub struct SpillShape {
crates/ql-storage/src/spill.rs:63:impl SpillShape {
crates/ql-storage/src/spill.rs:75:/// Errors emitted by `SpillAnchorTable::register` when the rectangle
crates/ql-storage/src/spill.rs:76:/// would collide with an existing spill OR overlap an existing anchor.
crates/ql-storage/src/spill.rs:78:/// The runtime spill-writeback path (Phase 4.7.J) maps these into
crates/ql-storage/src/spill.rs:79:/// `Value::Error(ErrorValue::Spill)` at the anchor cell; the storage
crates/ql-storage/src/spill.rs:83:pub enum SpillBlockError {
crates/ql-storage/src/spill.rs:84:    /// A non-anchor cell inside the proposed spill rectangle is
crates/ql-storage/src/spill.rs:85:    /// already a target of a DIFFERENT existing spill. The runtime
crates/ql-storage/src/spill.rs:88:        "spill blocked: cell ({sheet},{row},{col}) is already a target of \
crates/ql-storage/src/spill.rs:100:    /// The proposed anchor cell IS an existing spill anchor (different
crates/ql-storage/src/spill.rs:102:    /// The runtime should call `clear_spill_at(anchor)` before re-
crates/ql-storage/src/spill.rs:105:        "spill blocked: cell ({sheet},{row},{col}) is already an anchor; \
crates/ql-storage/src/spill.rs:106:         clear it first via clear_spill_at"
crates/ql-storage/src/spill.rs:114:    /// Spill rectangle has zero rows or zero cols. Degenerate-shape
crates/ql-storage/src/spill.rs:119:        "spill blocked: degenerate shape ({rows} rows, {cols} cols) — both \
crates/ql-storage/src/spill.rs:124:    /// **W5-101-AUDIT (Codex MEDIUM-2):** spill rectangle would extend
crates/ql-storage/src/spill.rs:128:    /// coordinates. The runtime spill-writeback path (Phase 4.7.J) maps
crates/ql-storage/src/spill.rs:129:    /// this to `Value::Error(ErrorValue::Spill)` at the anchor.
crates/ql-storage/src/spill.rs:131:        "spill blocked: rectangle from ({sheet},{row},{col}) sized \
crates/ql-storage/src/spill.rs:146:#[error("no spill anchor at ({sheet},{row},{col})")]
crates/ql-storage/src/spill.rs:147:pub struct SpillNotFoundError {
crates/ql-storage/src/spill.rs:153:/// Workbook-level spill-anchor table.
crates/ql-storage/src/spill.rs:157:/// (`Workbook::clear_spill_at`). See module-level docs for the
crates/ql-storage/src/spill.rs:160:pub struct SpillAnchorTable {
crates/ql-storage/src/spill.rs:161:    anchors: HashMap<(SheetId, RowId, ColId), SpillShape>,
crates/ql-storage/src/spill.rs:165:impl SpillAnchorTable {
crates/ql-storage/src/spill.rs:172:    /// an active spill anchor. `O(1)`.
crates/ql-storage/src/spill.rs:173:    pub fn anchor_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&SpillShape> {
crates/ql-storage/src/spill.rs:180:    /// the runtime spill-invalidation path (Phase 4.7.K) — when a user
crates/ql-storage/src/spill.rs:191:    /// Register a new spill: `anchor` is the top-left cell, `shape` is
crates/ql-storage/src/spill.rs:195:    /// Errors per `SpillBlockError`:
crates/ql-storage/src/spill.rs:199:    ///   `targets` already (a DIFFERENT spill claims it).
crates/ql-storage/src/spill.rs:208:        shape: SpillShape,
crates/ql-storage/src/spill.rs:209:    ) -> Result<(), SpillBlockError> {
crates/ql-storage/src/spill.rs:211:            return Err(SpillBlockError::DegenerateShape {
crates/ql-storage/src/spill.rs:228:            return Err(SpillBlockError::OutOfBounds {
crates/ql-storage/src/spill.rs:238:            return Err(SpillBlockError::AnchorAlreadyExists {
crates/ql-storage/src/spill.rs:253:                    return Err(SpillBlockError::TargetCellOccupied {
crates/ql-storage/src/spill.rs:292:    /// Remove a spill anchor + all its targets. Returns the cleared
crates/ql-storage/src/spill.rs:293:    /// shape so callers (e.g. `Workbook::clear_spill_at`) can iterate
crates/ql-storage/src/spill.rs:298:    ) -> Result<SpillShape, SpillNotFoundError> {
crates/ql-storage/src/spill.rs:299:        let shape = self.anchors.remove(&anchor).ok_or(SpillNotFoundError {
crates/ql-storage/src/spill.rs:313:    /// Iterator over `(anchor_cell, shape)` for every registered spill.
crates/ql-storage/src/spill.rs:319:    ) -> impl Iterator<Item = ((SheetId, RowId, ColId), &SpillShape)> + '_ {
crates/ql-storage/src/spill.rs:343:        let t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:351:    fn register_1x1_spill() {
crates/ql-storage/src/spill.rs:352:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:353:        t.register(at(0, 5, 3), SpillShape::new(1, 1)).unwrap();
crates/ql-storage/src/spill.rs:354:        assert_eq!(t.anchor_at(0, 5, 3), Some(&SpillShape::new(1, 1)));
crates/ql-storage/src/spill.rs:361:    fn register_5x1_spill_populates_targets() {
crates/ql-storage/src/spill.rs:362:        // `=SEQUENCE(5)` at A1 spills A1..A5.
crates/ql-storage/src/spill.rs:363:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:365:        t.register(anchor, SpillShape::new(5, 1)).unwrap();
crates/ql-storage/src/spill.rs:375:    fn register_2x3_spill_populates_all_cells() {
crates/ql-storage/src/spill.rs:377:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:379:        t.register(anchor, SpillShape::new(2, 3)).unwrap();
crates/ql-storage/src/spill.rs:396:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:398:        t.register(anchor, SpillShape::new(3, 1)).unwrap();
crates/ql-storage/src/spill.rs:399:        let err = t.register(anchor, SpillShape::new(3, 1)).unwrap_err();
crates/ql-storage/src/spill.rs:400:        assert!(matches!(err, SpillBlockError::AnchorAlreadyExists { .. }));
crates/ql-storage/src/spill.rs:405:        // First spill at A1: 3x1. Second spill at A2: 3x1 — would
crates/ql-storage/src/spill.rs:406:        // overlap A2, A3 with the first spill. Reject; no partial
crates/ql-storage/src/spill.rs:408:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:409:        t.register(at(0, 0, 0), SpillShape::new(3, 1)).unwrap();
crates/ql-storage/src/spill.rs:412:        let err = t.register(at(0, 1, 0), SpillShape::new(3, 1)).unwrap_err();
crates/ql-storage/src/spill.rs:414:            SpillBlockError::TargetCellOccupied {
crates/ql-storage/src/spill.rs:436:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:437:        let err = t.register(at(0, 0, 0), SpillShape::new(0, 3)).unwrap_err();
crates/ql-storage/src/spill.rs:440:            SpillBlockError::DegenerateShape { rows: 0, cols: 3 }
crates/ql-storage/src/spill.rs:446:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:447:        let err = t.register(at(0, 0, 0), SpillShape::new(3, 0)).unwrap_err();
crates/ql-storage/src/spill.rs:450:            SpillBlockError::DegenerateShape { rows: 3, cols: 0 }
crates/ql-storage/src/spill.rs:456:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:458:        t.register(anchor, SpillShape::new(2, 2)).unwrap();
crates/ql-storage/src/spill.rs:460:        assert_eq!(shape, SpillShape::new(2, 2));
crates/ql-storage/src/spill.rs:477:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:481:            SpillNotFoundError {
crates/ql-storage/src/spill.rs:493:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:495:        t.register(anchor, SpillShape::new(3, 1)).unwrap();
crates/ql-storage/src/spill.rs:497:        t.register(anchor, SpillShape::new(5, 1)).unwrap();
crates/ql-storage/src/spill.rs:498:        assert_eq!(t.anchor_at(0, 0, 0), Some(&SpillShape::new(5, 1)));
crates/ql-storage/src/spill.rs:504:    fn two_disjoint_spills_coexist() {
crates/ql-storage/src/spill.rs:505:        // Spill A: 2x2 at (0,0). Spill B: 2x2 at (5,5).
crates/ql-storage/src/spill.rs:506:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:509:        t.register(a, SpillShape::new(2, 2)).unwrap();
crates/ql-storage/src/spill.rs:510:        t.register(b, SpillShape::new(2, 2)).unwrap();
crates/ql-storage/src/spill.rs:518:    fn spills_on_different_sheets_are_independent() {
crates/ql-storage/src/spill.rs:519:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:522:        t.register(a, SpillShape::new(3, 3)).unwrap();
crates/ql-storage/src/spill.rs:523:        t.register(b, SpillShape::new(3, 3)).unwrap();
crates/ql-storage/src/spill.rs:533:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:534:        t.register(at(0, 0, 0), SpillShape::new(1, 1)).unwrap();
crates/ql-storage/src/spill.rs:535:        t.register(at(0, 5, 5), SpillShape::new(2, 2)).unwrap();
crates/ql-storage/src/spill.rs:545:    fn spill_shape_cell_count() {
crates/ql-storage/src/spill.rs:546:        assert_eq!(SpillShape::new(5, 1).cell_count(), 5);
crates/ql-storage/src/spill.rs:547:        assert_eq!(SpillShape::new(3, 4).cell_count(), 12);
crates/ql-storage/src/spill.rs:548:        assert_eq!(SpillShape::new(1, 1).cell_count(), 1);
crates/ql-storage/src/spill.rs:554:    fn register_rejects_spill_extending_past_max_row() {
crates/ql-storage/src/spill.rs:557:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:559:        let err = t.register(anchor, SpillShape::new(3, 1)).unwrap_err();
crates/ql-storage/src/spill.rs:561:            matches!(err, SpillBlockError::OutOfBounds { .. }),
crates/ql-storage/src/spill.rs:568:    fn register_rejects_spill_extending_past_max_column() {
crates/ql-storage/src/spill.rs:569:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:571:        let err = t.register(anchor, SpillShape::new(1, 2)).unwrap_err();
crates/ql-storage/src/spill.rs:572:        assert!(matches!(err, SpillBlockError::OutOfBounds { .. }));
crates/ql-storage/src/spill.rs:576:    fn register_accepts_spill_ending_exactly_at_max_row() {
crates/ql-storage/src/spill.rs:577:        // Last row of the spill == MAX_ROW exactly — should be allowed.
crates/ql-storage/src/spill.rs:578:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:580:        t.register(anchor, SpillShape::new(5, 1)).unwrap();
crates/ql-storage/src/spill.rs:581:        assert_eq!(t.anchor_at(0, MAX_ROW - 4, 0), Some(&SpillShape::new(5, 1)));
crates/ql-storage/src/spill.rs:590:        let mut t = SpillAnchorTable::new();
crates/ql-storage/src/spill.rs:592:        let err = t.register(anchor, SpillShape::new(2, 1)).unwrap_err();
crates/ql-storage/src/spill.rs:593:        assert!(matches!(err, SpillBlockError::OutOfBounds { .. }));

exec
/bin/zsh -lc "awk 'NR>=380 && NR<=430 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/tests/oplog_e2e.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
380:    let mut replay_wb = fresh_wb();
381:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
382:    assert_eq!(replay_wb.read(Address::new(0, 0, 0)), Value::Number(42.0));
383:    assert_eq!(replay_wb.read(Address::new(0, 0, 1)), Value::Number(43.0));
384:}
385:
386:// ===== W5-84 closure (Codex MEDIUM + Sonnet MEDIUM I.2):
387://       E2E format persistence round-trip =====
388:
389:/// Real producer → save to `.qbook` → load → recompute → `read_display`.
390:/// This is the full end-to-end persistence + display path for the
391:/// Phase 4.5.D + 4.5.E arc. Prior tests covered the layers in
392:/// isolation but never the combined flow.
393:#[test]
394:fn format_persistence_round_trip_through_qbook() {
395:    use ql_storage::FormatId;
396:
397:    let dir = tempfile::TempDir::new().unwrap();
398:    let path = dir.path().join("formats_e2e.qbook");
399:    let reg = default_registry();
400:
401:    // ===== Producer side =====
402:    let mut producer_wb = fresh_wb();
403:    let custom_id;
404:    {
405:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
406:        // Number value with built-in date format.
407:        rt.set_value(0, 0, 0, Value::Number(45477.0)).unwrap(); // 2024-07-04
408:        rt.set_cell_format(0, 0, 0, Some(FormatId(14))).unwrap();
409:        // Number value with custom format.
410:        rt.set_value(0, 1, 0, Value::Number(1234.5)).unwrap();
411:        custom_id = rt.intern_format("#,##0.00").unwrap();
412:        rt.set_cell_format(0, 1, 0, Some(custom_id)).unwrap();
413:        // Formula that uses TEXT() — value should be the rendered string.
414:        rt.set_formula(0, 2, 0, "TEXT(A1, \"yyyy-mm-dd\")").unwrap();
415:        let _ = rt.recompute_all();
416:    }
417:    // Snapshot expected display values on the producer side.
418:    let producer_display_a1 = {
419:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
420:        rt.read_display(0, 0, 0)
421:    };
422:    let producer_display_a2 = {
423:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
424:        rt.read_display(0, 1, 0)
425:    };
426:    assert_eq!(producer_display_a1, "7/4/2024");
427:    assert_eq!(producer_display_a2, "1,234.50");
428:
429:    // ===== Save =====
430:    ql_io::save_workbook(&producer_wb, "formats_e2e", &path).unwrap();

exec
/bin/zsh -lc "awk 'NR>=385 && NR<=405 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-oplog/tests/producer_replay_equivalence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
385:    // Replay side: build an OpLog, replay against an empty workbook with
386:    // the same pre-existing sheet 0.
387:    let mut log = OpLog::new();
388:    for op in &ops {
389:        log.append(op.clone()).unwrap();
390:    }
391:    let mut replay_wb = Workbook::new();
392:    replay_wb.add_sheet("S");
393:    let reg = default_registry();
394:    let count = replay_into(&log, &mut replay_wb, &reg).unwrap();
395:    assert_eq!(count, ops.len());
396:
397:    // Observational equality.
398:    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
399:
400:    // Sanity-spot-check some cells / names by hand.
401:    assert_eq!(
402:        replay_wb.read(Address::new(0, 2, 2)),
403:        Value::Number(22.0),
404:        "spot-check: (2,2) in the 5x5 paste block"
405:    );

exec
/bin/zsh -lc "awk 'NR>=585 && NR<=625 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
585:    /// Borrow the underlying `Graph` (read-only). Used by tests and by
586:    /// the eventual `ql-profile` graph-profile export.
587:    pub fn graph(&self) -> &Graph {
588:        &self.graph
589:    }
590:
591:    /// `NodeId` representing the cell at `(sheet, row, col)`, if any.
592:    /// `None` if the cell has never been touched by the runtime nor
593:    /// added by rebuild.
594:    pub fn cell_node_for(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<NodeId> {
595:        self.cell_index.get(&(sheet, row, col)).copied()
596:    }
597:
598:    /// Get the existing `NodeId` for this cell, or create a new
599:    /// `CellNode` and return its id. The cell index is updated in
600:    /// either case.
601:    fn or_insert_cell_node(&mut self, sheet: SheetId, row: RowId, col: ColId) -> NodeId {
602:        if let Some(id) = self.cell_index.get(&(sheet, row, col)) {
603:            return *id;
604:        }
605:        let id = self.graph.add_cell_node(sheet, row, col);
606:        self.cell_index.insert((sheet, row, col), id);
607:        id
608:    }
609:
610:    /// Cumulative hook-invocation counters. Phase 3.1 uses these for
611:    /// observability and tests; Phase 3.10 megaudit wires them into
612:    /// `ql_profile::Timings` alongside `bind_plan_cache_*` and
613:    /// `fingerprint_cache_*`.
614:    pub fn hook_counts(&self) -> HookCounts {
615:        self.hook_counts
616:    }
617:
618:    /// Phase 3.2: live dependency view for a formula cell. `None` if
619:    /// the cell has no formula or hasn't been bound yet (rebuild
620:    /// failed to lex/parse, or the cell isn't a formula at all).
621:    pub fn formula_deps(&self, node: NodeId) -> Option<&FormulaDeps> {
622:        self.formula_deps.get(&node)
623:    }
624:
625:    /// Phase 3.2: is this formula's plan marked volatile? Volatile

exec
/bin/zsh -lc "rg -n \"pub fn cell_address_for|cell_address_for\\(\" crates/ql-exec/src/calcgraph_session.rs crates/ql-calcgraph/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/calcgraph_session.rs:1092:            if let Some((s, r, c)) = self.cell_address_for(n) {
crates/ql-exec/src/calcgraph_session.rs:1147:            if let Some((s, r, c)) = self.cell_address_for(n) {
crates/ql-exec/src/calcgraph_session.rs:1238:            if let Some((s, r, c)) = self.cell_address_for(n) {
crates/ql-exec/src/calcgraph_session.rs:1301:            if let Some((s, r, c)) = self.cell_address_for(n) {
crates/ql-exec/src/calcgraph_session.rs:1344:            if let Some((s, r, c)) = self.cell_address_for(n) {
crates/ql-exec/src/calcgraph_session.rs:1415:            let Some((ns, nr, nc)) = self.cell_address_for(node) else {
crates/ql-exec/src/calcgraph_session.rs:1489:            if let Some((s, r, c)) = self.cell_address_for(v) {
crates/ql-exec/src/calcgraph_session.rs:1534:    pub fn cell_address_for(&self, node: NodeId) -> Option<(SheetId, RowId, ColId)> {
crates/ql-exec/src/calcgraph_session.rs:1560:    /// a caller filtering by `cell_address_for(node) == anchor` is
crates/ql-exec/src/calcgraph_session.rs:1604:    /// `cell_address_for(reader_node)`. The caller is responsible for
crates/ql-exec/src/calcgraph_session.rs:1623:        let Some((reader_sheet, _, _)) = self.cell_address_for(reader_node) else {
crates/ql-exec/src/calcgraph_session.rs:1689:            .filter_map(|&n| self.cell_address_for(n).map(|(s, r, c)| (n, s, r, c)))
crates/ql-exec/src/calcgraph_session.rs:3665:            let addr = s.cell_address_for(node).unwrap();

exec
/bin/zsh -lc "awk 'NR>=1 && NR<=130 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-calcgraph/src/graph.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1://! The top-level `Graph` — append-only node + adjacency container.
2://!
3://! Phase 0 scope (Week 3):
4://! - Insert nodes (Cell, Range, FormulaRegion). No delete; vertex IDs append-only.
5://! - Insert directed edges between existing nodes.
6://! - Revision counter bumped on every structural change (salsa-inspired) so callers can
7://!   detect "did the graph change since I last looked?" cheaply.
8://!
9://! Out of W3-1 scope (later commits):
10://! - W3-2 `dirty.rs` — per-chunk dirty bitmap + propagation walk.
11://! - W3-3 `topo.rs` — iterative Tarjan SCC scheduler (CORR-23).
12://! - W3-4 `fingerprint.rs` — Expr → u64 hash for formula-region memoization.
13://! - W3-5 `stripes.rs` — stripe-index registration per CORR-21.
14://! - W3-6 typed `#[cfg(test)]` accessors for the A4 assertions (CORR-24).
15://!
16://! ## Node + edge semantics (recap)
17://!
18://! Outgoing edge `u -> v` means **"u depends on v"** — recomputing u requires v's value.
19://! When v changes, the dirty walk traverses `incoming(v)` (the reverse direction) to mark
20://! dependents.
21://!
22://! ## Same-sheet only in Phase 0
23://!
24://! Every node carries a concrete `SheetId`. AST nodes (`Expr::CellRef`, `RangeRef::*`)
25://! may carry `Option<SheetId>` for sheet-qualification deferred to Phase 3+; the graph
26://! constructor (callers in `ql-exec` Week 4) is responsible for resolving the optional
27://! to a concrete sheet before calling `add_*_node`.
28:
29:use std::collections::HashMap;
30:
31:use ql_formula_syntax::RangeRef;
32:use ql_types::{ColId, RowId, SheetId};
33:
34:use crate::edges::AdjacencyVectors;
35:use crate::node::{CellNode, FormulaRegionNode, Node, NodeId, RangeNode};
36:use crate::stats::GraphStats;
37:use crate::stripes::{range_contains_rowcol, StripeIndex};
38:
39:/// The calc-graph container.
40:///
41:/// Append-only in Phase 0 (no removal). Borrows nothing — every node payload is owned by
42:/// the graph (Range/FormulaRegion carry their full payload by value). This keeps lifetime
43:/// management trivial at the cost of cloning small structs when callers query nodes; the
44:/// payload sizes are bounded (Cell = 12 bytes; FormulaRegion ≈ 36 bytes) so the cloning
45:/// cost is negligible compared to the hash/compare work in the dirty walk.
46:///
47:/// ## Range-dependency tracking (W3-5)
48:///
49:/// Two sidecar structures alongside nodes + edges:
50:///
51:/// - `stripes: StripeIndex` — per CORR-21, the per-row / per-column stripe map that lets
52:///   `dependents_for_cell` answer in O(touched_stripes) instead of O(formula_count).
53:/// - `formula_to_range_deps: HashMap<NodeId, Vec<RangeRef>>` — the canonical range list
54:///   per formula node. Used by `dependents_for_cell` for the precision-check that drops
55:///   stripe-match false positives (the stripe map is coarser than the actual range).
56:///
57:/// `register_range_dependency` populates BOTH atomically. Don't call them separately.
58:#[derive(Clone, Debug, Default)]
59:pub struct Graph {
60:    nodes: Vec<Node>,
61:    edges: AdjacencyVectors,
62:    revision: u64,
63:    stripes: StripeIndex,
64:    formula_to_range_deps: HashMap<NodeId, Vec<RangeRef>>,
65:    stats: GraphStats,
66:}
67:
68:/// Count of nodes by `Node` variant. Used by `graph-profile.json` export so a reader can
69:/// see at a glance how the graph mass distributes across leaf cells, compressed ranges,
70:/// dense formula regions, and (Phase 3+) spill anchors.
71:#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
72:pub struct NodeCountsByVariant {
73:    pub cell: u64,
74:    pub range: u64,
75:    pub formula_region: u64,
76:    pub spill: u64,
77:}
78:
79:impl NodeCountsByVariant {
80:    pub fn total(&self) -> u64 {
81:        self.cell + self.range + self.formula_region + self.spill
82:    }
83:}
84:
85:impl Graph {
86:    pub fn new() -> Self {
87:        Self::default()
88:    }
89:
90:    /// Total nodes added. Always equal to `revision_after_last_node_add` minus the count
91:    /// of edge-only revisions — but Phase 0 doesn't distinguish, since both bump revision.
92:    pub fn node_count(&self) -> usize {
93:        debug_assert_eq!(self.nodes.len(), self.edges.node_count());
94:        self.nodes.len()
95:    }
96:
97:    pub fn edge_count(&self) -> usize {
98:        self.edges.edge_count()
99:    }
100:
101:    /// Monotonic version counter. Bumped on every structural change (node add, edge add).
102:    /// Callers comparing graph state across operations rely on this — e.g. the dirty walk
103:    /// re-runs only if `graph.revision() != self.last_walked_revision`.
104:    pub fn revision(&self) -> u64 {
105:        self.revision
106:    }
107:
108:    /// Borrow a node by id. Panics on out-of-bounds — graph callers should never construct
109:    /// `NodeId`s by hand; ids only come from `add_*_node` return values.
110:    pub fn node(&self, id: NodeId) -> &Node {
111:        &self.nodes[id.index()]
112:    }
113:
114:    /// Iterate `node` -> dependencies (what `node` depends on).
115:    pub fn outgoing(&self, node: NodeId) -> &[NodeId] {
116:        self.edges.outgoing(node)
117:    }
118:
119:    /// Iterate dependents -> `node` (what depends on `node`). The dirty walk uses this.
120:    pub fn incoming(&self, node: NodeId) -> &[NodeId] {
121:        self.edges.incoming(node)
122:    }
123:
124:    fn push_node(&mut self, node: Node) -> NodeId {
125:        let id = NodeId(
126:            self.nodes
127:                .len()
128:                .try_into()
129:                .expect("Graph::push_node: node count exceeds u32::MAX"),
130:        );

exec
/bin/zsh -lc "rg -n \"pub enum Node|struct CellNode|CellNode|RangeNode|NodeId|add_node|node\\(\" crates/ql-calcgraph/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-calcgraph/src/stripes.rs:1://! Stripe index — `(sheet, axis, index) → set of dependent NodeIds`. The A5 acceptance
crates/ql-calcgraph/src/stripes.rs:13://! - `stripe_to_dependents: HashMap<StripeKey, HashSet<NodeId>>`.
crates/ql-calcgraph/src/stripes.rs:39:use crate::node::NodeId;
crates/ql-calcgraph/src/stripes.rs:66:/// `formula_to_stripe_keys: HashMap<NodeId, Vec<StripeKey>>` records, per formula
crates/ql-calcgraph/src/stripes.rs:75:    stripe_to_dependents: HashMap<StripeKey, HashSet<NodeId>>,
crates/ql-calcgraph/src/stripes.rs:79:    formula_to_stripe_keys: HashMap<NodeId, Vec<StripeKey>>,
crates/ql-calcgraph/src/stripes.rs:101:    pub(crate) fn raw_map(&self) -> &HashMap<StripeKey, HashSet<NodeId>> {
crates/ql-calcgraph/src/stripes.rs:116:    pub fn register(&mut self, formula_node: NodeId, range: &RangeRef, sheet_id: SheetId) {
crates/ql-calcgraph/src/stripes.rs:215:    fn insert(&mut self, key: StripeKey, formula_node: NodeId) {
crates/ql-calcgraph/src/stripes.rs:248:    pub fn clear_for_formula(&mut self, formula_node: NodeId) {
crates/ql-calcgraph/src/stripes.rs:266:    pub(crate) fn stripe_keys_for_formula(&self, formula_node: NodeId) -> Option<&Vec<StripeKey>> {
crates/ql-calcgraph/src/stripes.rs:274:    pub fn candidates_for_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> HashSet<NodeId> {
crates/ql-calcgraph/src/stripes.rs:377:        idx.register(NodeId(1), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:381:        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
crates/ql-calcgraph/src/stripes.rs:388:        idx.register(NodeId(1), &whole_row(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:391:        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
crates/ql-calcgraph/src/stripes.rs:398:        idx.register(NodeId(1), &cells(0, 0, 0, 999), 0);
crates/ql-calcgraph/src/stripes.rs:402:        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
crates/ql-calcgraph/src/stripes.rs:409:        idx.register(NodeId(1), &cells(0, 0, 25, 0), 0);
crates/ql-calcgraph/src/stripes.rs:413:        assert_eq!(candidates, [NodeId(1)].into_iter().collect());
crates/ql-calcgraph/src/stripes.rs:420:        idx.register(NodeId(1), &cells(0, 0, 1, 1), 0);
crates/ql-calcgraph/src/stripes.rs:426:            [NodeId(1)].into_iter().collect()
crates/ql-calcgraph/src/stripes.rs:430:            [NodeId(1)].into_iter().collect()
crates/ql-calcgraph/src/stripes.rs:440:        idx.register(NodeId(1), &whole_col(0, 2), 0);
crates/ql-calcgraph/src/stripes.rs:446:                [NodeId(1)].into_iter().collect()
crates/ql-calcgraph/src/stripes.rs:458:            idx.register(NodeId(i), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:471:        idx.register(NodeId(1), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:472:        idx.register(NodeId(2), &whole_col(0, 0), 1);
crates/ql-calcgraph/src/stripes.rs:476:            [NodeId(1)].into_iter().collect()
crates/ql-calcgraph/src/stripes.rs:480:            [NodeId(2)].into_iter().collect()
crates/ql-calcgraph/src/stripes.rs:527:            idx.register(NodeId(i), &cells(0, 0, 0, i - 1), 0);
crates/ql-calcgraph/src/stripes.rs:549:        idx.register(NodeId(1), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:550:        idx.register(NodeId(1), &whole_col(0, 0), 0); // duplicate
crates/ql-calcgraph/src/stripes.rs:573:        idx.register(NodeId(1), &bad, 0);
crates/ql-calcgraph/src/stripes.rs:591:        idx.register(NodeId(1), &bad, 0);
crates/ql-calcgraph/src/stripes.rs:605:        idx.register(NodeId(1), &bad, 0);
crates/ql-calcgraph/src/stripes.rs:619:        idx.register(NodeId(1), &bad, 0);
crates/ql-calcgraph/src/stripes.rs:626:        idx.register(NodeId(1), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:627:        idx.register(NodeId(2), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:637:            &[NodeId(1), NodeId(2)].into_iter().collect::<HashSet<_>>()
crates/ql-calcgraph/src/stripes.rs:646:        idx.register(NodeId(7), &whole_col(0, 0), 0); // Col 0 stripe
crates/ql-calcgraph/src/stripes.rs:647:        idx.register(NodeId(7), &whole_row(5, 5), 0); // Row 5 stripe
crates/ql-calcgraph/src/stripes.rs:648:        let keys = idx.stripe_keys_for_formula(NodeId(7)).expect("present");
crates/ql-calcgraph/src/stripes.rs:668:        idx.register(NodeId(7), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:669:        idx.register(NodeId(7), &cells(0, 0, 0, 9), 0); // A1:A10 → Col 0 (height>width)
crates/ql-calcgraph/src/stripes.rs:670:        let keys = idx.stripe_keys_for_formula(NodeId(7)).expect("present");
crates/ql-calcgraph/src/stripes.rs:679:        idx.register(NodeId(7), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:680:        idx.register(NodeId(7), &whole_row(5, 5), 0);
crates/ql-calcgraph/src/stripes.rs:684:        idx.clear_for_formula(NodeId(7));
crates/ql-calcgraph/src/stripes.rs:688:        assert!(idx.stripe_keys_for_formula(NodeId(7)).is_none());
crates/ql-calcgraph/src/stripes.rs:698:            idx.register(NodeId(i), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:702:        idx.clear_for_formula(NodeId(42));
crates/ql-calcgraph/src/stripes.rs:709:        assert!(!candidates.contains(&NodeId(42)));
crates/ql-calcgraph/src/stripes.rs:715:        idx.register(NodeId(7), &whole_col(0, 0), 0);
crates/ql-calcgraph/src/stripes.rs:716:        idx.clear_for_formula(NodeId(7));
crates/ql-calcgraph/src/stripes.rs:717:        idx.clear_for_formula(NodeId(7)); // no-op
crates/ql-calcgraph/src/stripes.rs:718:        idx.clear_for_formula(NodeId(999)); // never registered, no-op
crates/ql-calcgraph/src/stripes.rs:728:        idx.register(NodeId(7), &whole_col(0, 0), 0); // A:A
crates/ql-calcgraph/src/stripes.rs:729:        idx.clear_for_formula(NodeId(7));
crates/ql-calcgraph/src/stripes.rs:730:        idx.register(NodeId(7), &whole_col(1, 1), 0); // B:B
crates/ql-calcgraph/src/stripes.rs:737:            [NodeId(7)].into_iter().collect()
crates/ql-calcgraph/src/stripes.rs:745:        let b1 = NodeId(1);
crates/ql-calcgraph/src/stripes.rs:746:        let c1 = NodeId(2);
crates/ql-calcgraph/src/node.rs:27:pub struct NodeId(pub u32);
crates/ql-calcgraph/src/node.rs:29:impl NodeId {
crates/ql-calcgraph/src/node.rs:41:pub enum Node {
crates/ql-calcgraph/src/node.rs:42:    Cell(CellNode),
crates/ql-calcgraph/src/node.rs:43:    Range(RangeNode),
crates/ql-calcgraph/src/node.rs:55:pub struct CellNode {
crates/ql-calcgraph/src/node.rs:72:pub struct RangeNode {
crates/ql-calcgraph/src/node.rs:108:    pub anchor: NodeId,
crates/ql-calcgraph/src/node.rs:120:        assert_eq!(NodeId(0).index(), 0);
crates/ql-calcgraph/src/node.rs:121:        assert_eq!(NodeId(7).index(), 7);
crates/ql-calcgraph/src/node.rs:122:        assert_eq!(NodeId(u32::MAX).index(), u32::MAX as usize);
crates/ql-calcgraph/src/node.rs:127:        let a = CellNode {
crates/ql-calcgraph/src/node.rs:132:        let b = CellNode {
crates/ql-calcgraph/src/node.rs:137:        let c = CellNode {
crates/ql-calcgraph/src/node.rs:148:        let rn = RangeNode {
crates/ql-calcgraph/src/node.rs:182:            anchor: NodeId(7),
crates/ql-calcgraph/src/node.rs:186:        assert_eq!(sn.anchor, NodeId(7));
crates/ql-calcgraph/src/node.rs:193:        let c = Node::Cell(CellNode {
crates/ql-calcgraph/src/node.rs:198:        let r = Node::Range(RangeNode {
crates/ql-calcgraph/src/topo.rs:27://! - `dfs_stack: Vec<(NodeId, usize)>` — explicit DFS frame: (node, next-child-index).
crates/ql-calcgraph/src/topo.rs:29://! - `scc_stack: Vec<NodeId>` — the Tarjan SCC stack of "currently-being-explored" nodes
crates/ql-calcgraph/src/topo.rs:44://! `dirty: HashSet<NodeId>` membership check filters `graph.outgoing(v)`.
crates/ql-calcgraph/src/topo.rs:56:use crate::node::NodeId;
crates/ql-calcgraph/src/topo.rs:64:    pub sorted: Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:65:    pub cycled: Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:87:pub fn schedule(graph: &Graph, dirty_subset: &[NodeId]) -> Schedule {
crates/ql-calcgraph/src/topo.rs:88:    let empty: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/topo.rs:114:    dirty_subset: &[NodeId],
crates/ql-calcgraph/src/topo.rs:115:    supplemental: &HashMap<NodeId, Vec<NodeId>>,
crates/ql-calcgraph/src/topo.rs:117:    let dirty: HashSet<NodeId> = dirty_subset.iter().copied().collect();
crates/ql-calcgraph/src/topo.rs:122:    let mut indices: HashMap<NodeId, u32> = HashMap::with_capacity(dirty.len());
crates/ql-calcgraph/src/topo.rs:123:    let mut lowlinks: HashMap<NodeId, u32> = HashMap::with_capacity(dirty.len());
crates/ql-calcgraph/src/topo.rs:124:    let mut on_scc_stack: HashMap<NodeId, bool> = HashMap::with_capacity(dirty.len());
crates/ql-calcgraph/src/topo.rs:125:    let mut scc_stack: Vec<NodeId> = Vec::with_capacity(dirty.len());
crates/ql-calcgraph/src/topo.rs:128:    let mut sorted: Vec<NodeId> = Vec::with_capacity(dirty.len());
crates/ql-calcgraph/src/topo.rs:129:    let mut cycled: Vec<NodeId> = Vec::new();
crates/ql-calcgraph/src/topo.rs:158:    seed: NodeId,
crates/ql-calcgraph/src/topo.rs:160:    supplemental: &HashMap<NodeId, Vec<NodeId>>,
crates/ql-calcgraph/src/topo.rs:161:    dirty: &HashSet<NodeId>,
crates/ql-calcgraph/src/topo.rs:162:    indices: &mut HashMap<NodeId, u32>,
crates/ql-calcgraph/src/topo.rs:163:    lowlinks: &mut HashMap<NodeId, u32>,
crates/ql-calcgraph/src/topo.rs:164:    on_scc_stack: &mut HashMap<NodeId, bool>,
crates/ql-calcgraph/src/topo.rs:165:    scc_stack: &mut Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:167:    sorted: &mut Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:168:    cycled: &mut Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:179:    let mut dfs_stack: Vec<(NodeId, usize)> = Vec::new();
crates/ql-calcgraph/src/topo.rs:187:        let supp: &[NodeId] = supplemental.get(&v).map(|v| v.as_slice()).unwrap_or(&[]);
crates/ql-calcgraph/src/topo.rs:191:        let mut next_child: Option<NodeId> = None;
crates/ql-calcgraph/src/topo.rs:240:                let mut scc: Vec<NodeId> = Vec::new();
crates/ql-calcgraph/src/topo.rs:288:    v: NodeId,
crates/ql-calcgraph/src/topo.rs:290:    indices: &mut HashMap<NodeId, u32>,
crates/ql-calcgraph/src/topo.rs:291:    lowlinks: &mut HashMap<NodeId, u32>,
crates/ql-calcgraph/src/topo.rs:292:    on_scc_stack: &mut HashMap<NodeId, bool>,
crates/ql-calcgraph/src/topo.rs:293:    scc_stack: &mut Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:310:    fn n_cells(g: &mut Graph, n: u32) -> Vec<NodeId> {
crates/ql-calcgraph/src/topo.rs:311:        (0..n).map(|c| g.add_cell_node(0, 0, c)).collect()
crates/ql-calcgraph/src/topo.rs:325:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/topo.rs:334:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/topo.rs:428:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/topo.rs:440:        let ids: Vec<NodeId> = (0..N).map(|i| g.add_cell_node(0, i, 0)).collect();
crates/ql-calcgraph/src/topo.rs:488:        // it — but that's a contrived case since `NodeId` identity is global. Test the
crates/ql-calcgraph/src/topo.rs:491:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/topo.rs:522:        let supp: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/topo.rs:538:        let mut supp: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/topo.rs:558:        let mut supp: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/topo.rs:571:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/topo.rs:572:        let mut supp: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/topo.rs:588:        let mut supp: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/topo.rs:606:        let mut supp: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/topo.rs:623:        let mut supp: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
crates/ql-calcgraph/src/dirty.rs:44:use crate::node::{Node, NodeId};
crates/ql-calcgraph/src/dirty.rs:225:/// In practice callers seed with `CellNode`s (the binder feeds cell writes). The
crates/ql-calcgraph/src/dirty.rs:228:pub fn propagate_from_cells(graph: &Graph, dirty: &mut ChunkDirtySet, seeds: &[NodeId]) {
crates/ql-calcgraph/src/dirty.rs:229:    let mut visited: HashSet<NodeId> = HashSet::new();
crates/ql-calcgraph/src/dirty.rs:230:    let mut queue: VecDeque<NodeId> = VecDeque::new();
crates/ql-calcgraph/src/dirty.rs:249:fn mark_node_chunks(graph: &Graph, dirty: &mut ChunkDirtySet, node_id: NodeId) {
crates/ql-calcgraph/src/dirty.rs:250:    match graph.node(node_id) {
crates/ql-calcgraph/src/dirty.rs:285:    use crate::node::RangeNode;
crates/ql-calcgraph/src/dirty.rs:419:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/dirty.rs:431:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/dirty.rs:432:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/dirty.rs:450:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/dirty.rs:451:        let a500 = g.add_cell_node(0, 500, 0);
crates/ql-calcgraph/src/dirty.rs:452:        let col_a = g.add_range_node(RangeNode {
crates/ql-calcgraph/src/dirty.rs:462:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/dirty.rs:483:    fn propagate_through_formula_region_node() {
crates/ql-calcgraph/src/dirty.rs:487:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/dirty.rs:488:        let frn = g.add_formula_region_node(FormulaRegionNode {
crates/ql-calcgraph/src/dirty.rs:517:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/dirty.rs:518:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/dirty.rs:519:        let c1 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/dirty.rs:520:        let d1 = g.add_cell_node(0, 0, 3);
crates/ql-calcgraph/src/dirty.rs:542:            cells.push((row, g.add_cell_node(0, row, 0)));
crates/ql-calcgraph/src/dirty.rs:561:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/dirty.rs:562:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/dirty.rs:576:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/dirty.rs:577:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/dirty.rs:578:        let c1 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/dirty.rs:579:        let d1 = g.add_cell_node(0, 0, 3);
crates/ql-calcgraph/src/dirty.rs:593:        g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/lib.rs:64:pub use node::{CellNode, FormulaRegionNode, Node, NodeId, RangeNode, SpillNode};
crates/ql-calcgraph/src/lib.rs:90:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/lib.rs:91:        let a2 = g.add_cell_node(0, 1, 0);
crates/ql-calcgraph/src/lib.rs:92:        let a3 = g.add_cell_node(0, 2, 0);
crates/ql-calcgraph/src/lib.rs:93:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/lib.rs:94:        let c1 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/lib.rs:96:        let col_a_range = g.add_range_node(RangeNode {
crates/ql-calcgraph/src/lib.rs:133:        let region = g.add_formula_region_node(FormulaRegionNode {
crates/ql-calcgraph/src/lib.rs:143:        match g.node(region) {
crates/ql-calcgraph/src/lib.rs:165:        let formula = g.add_cell_node(0, 0, 1); // B1 = SUM(A:A)
crates/ql-calcgraph/src/lib.rs:206:            let id = g.add_cell_node(0, 0, col);
crates/ql-calcgraph/src/lib.rs:274:        let f1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/lib.rs:275:        let f2 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/graph.rs:35:use crate::node::{CellNode, FormulaRegionNode, Node, NodeId, RangeNode};
crates/ql-calcgraph/src/graph.rs:53:/// - `formula_to_range_deps: HashMap<NodeId, Vec<RangeRef>>` — the canonical range list
crates/ql-calcgraph/src/graph.rs:64:    formula_to_range_deps: HashMap<NodeId, Vec<RangeRef>>,
crates/ql-calcgraph/src/graph.rs:109:    /// `NodeId`s by hand; ids only come from `add_*_node` return values.
crates/ql-calcgraph/src/graph.rs:110:    pub fn node(&self, id: NodeId) -> &Node {
crates/ql-calcgraph/src/graph.rs:115:    pub fn outgoing(&self, node: NodeId) -> &[NodeId] {
crates/ql-calcgraph/src/graph.rs:120:    pub fn incoming(&self, node: NodeId) -> &[NodeId] {
crates/ql-calcgraph/src/graph.rs:124:    fn push_node(&mut self, node: Node) -> NodeId {
crates/ql-calcgraph/src/graph.rs:125:        let id = NodeId(
crates/ql-calcgraph/src/graph.rs:132:        self.edges.push_node();
crates/ql-calcgraph/src/graph.rs:140:    pub fn add_cell_node(&mut self, sheet: SheetId, row: RowId, col: ColId) -> NodeId {
crates/ql-calcgraph/src/graph.rs:141:        self.push_node(Node::Cell(CellNode { sheet, row, col }))
crates/ql-calcgraph/src/graph.rs:144:    pub fn add_range_node(&mut self, range: RangeNode) -> NodeId {
crates/ql-calcgraph/src/graph.rs:145:        self.push_node(Node::Range(range))
crates/ql-calcgraph/src/graph.rs:148:    pub fn add_formula_region_node(&mut self, region: FormulaRegionNode) -> NodeId {
crates/ql-calcgraph/src/graph.rs:149:        self.push_node(Node::FormulaRegion(region))
crates/ql-calcgraph/src/graph.rs:154:    pub fn add_spill_node(&mut self, _anchor: NodeId, _shape: (RowId, ColId)) -> NodeId {
crates/ql-calcgraph/src/graph.rs:163:    pub fn add_edge(&mut self, from: NodeId, to: NodeId) {
crates/ql-calcgraph/src/graph.rs:182:        formula_node: NodeId,
crates/ql-calcgraph/src/graph.rs:232:    pub fn clear_outgoing(&mut self, node: NodeId) {
crates/ql-calcgraph/src/graph.rs:260:    pub fn clear_range_deps_for_formula(&mut self, formula_node: NodeId) {
crates/ql-calcgraph/src/graph.rs:291:    /// Returns the precise dependent set, **sorted ascending by `NodeId`** so callers
crates/ql-calcgraph/src/graph.rs:296:    pub fn dependents_for_cell(&self, sheet: SheetId, row: RowId, col: ColId) -> Vec<NodeId> {
crates/ql-calcgraph/src/graph.rs:298:        let mut out: Vec<NodeId> = candidates
crates/ql-calcgraph/src/graph.rs:320:    pub fn range_deps_for(&self, formula_node: NodeId) -> &[RangeRef] {
crates/ql-calcgraph/src/graph.rs:382:    pub(crate) fn formula_to_range_deps(&self) -> &HashMap<NodeId, Vec<RangeRef>> {
crates/ql-calcgraph/src/graph.rs:404:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:405:        assert_eq!(a, NodeId(0));
crates/ql-calcgraph/src/graph.rs:409:        let b = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:410:        assert_eq!(b, NodeId(1));
crates/ql-calcgraph/src/graph.rs:418:        let id = g.add_range_node(RangeNode {
crates/ql-calcgraph/src/graph.rs:428:        match g.node(id) {
crates/ql-calcgraph/src/graph.rs:440:        let id = g.add_formula_region_node(FormulaRegionNode {
crates/ql-calcgraph/src/graph.rs:449:        match g.node(id) {
crates/ql-calcgraph/src/graph.rs:461:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:462:        let b = g.add_cell_node(0, 1, 0);
crates/ql-calcgraph/src/graph.rs:476:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:479:        let _ = g.node(a);
crates/ql-calcgraph/src/graph.rs:489:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:490:        let a2 = g.add_cell_node(0, 1, 0);
crates/ql-calcgraph/src/graph.rs:491:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:503:        let anchor = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:504:        g.add_spill_node(anchor, (3, 3));
crates/ql-calcgraph/src/graph.rs:512:            ids.push(g.add_cell_node(0, r, 0));
crates/ql-calcgraph/src/graph.rs:515:            assert_eq!(*id, NodeId(i as u32));
crates/ql-calcgraph/src/graph.rs:524:            let _ = g.node(NodeId(0));
crates/ql-calcgraph/src/graph.rs:532:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:536:            g2.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:537:            g2.add_edge(a, NodeId(5));
crates/ql-calcgraph/src/graph.rs:545:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:546:        let b = g.add_cell_node(0, 1, 0);
crates/ql-calcgraph/src/graph.rs:547:        let c = g.add_cell_node(0, 2, 0);
crates/ql-calcgraph/src/graph.rs:548:        let d = g.add_cell_node(0, 3, 0);
crates/ql-calcgraph/src/graph.rs:560:        let b1 = g.add_cell_node(0, 0, 1); // formula cell
crates/ql-calcgraph/src/graph.rs:583:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:584:        let c1 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/graph.rs:612:        let mut expected: Vec<NodeId> = [b1, c1].to_vec();
crates/ql-calcgraph/src/graph.rs:622:    /// Audit H2 (2026-05-12): `dependents_for_cell` must return a Vec sorted by NodeId
crates/ql-calcgraph/src/graph.rs:632:            let id = g.add_cell_node(0, 0, col + 1);
crates/ql-calcgraph/src/graph.rs:648:        // Strictly increasing by NodeId.
crates/ql-calcgraph/src/graph.rs:657:        g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:665:        g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:667:            NodeId(99),
crates/ql-calcgraph/src/graph.rs:683:        let c1 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/graph.rs:714:        let cell_a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:715:        let range = g.add_range_node(RangeNode {
crates/ql-calcgraph/src/graph.rs:725:        let region = g.add_formula_region_node(FormulaRegionNode {
crates/ql-calcgraph/src/graph.rs:735:        assert!(matches!(g.node(cell_a), Node::Cell(_)));
crates/ql-calcgraph/src/graph.rs:736:        assert!(matches!(g.node(range), Node::Range(_)));
crates/ql-calcgraph/src/graph.rs:737:        assert!(matches!(g.node(region), Node::FormulaRegion(_)));
crates/ql-calcgraph/src/graph.rs:746:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:747:        let a2 = g.add_cell_node(0, 1, 0);
crates/ql-calcgraph/src/graph.rs:748:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:768:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:769:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:770:        let c1 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/graph.rs:784:        let a = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:796:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:839:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:840:        let c1 = g.add_cell_node(0, 0, 2);
crates/ql-calcgraph/src/graph.rs:870:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:871:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:892:        let b1 = g.add_cell_node(0, 0, 1);
crates/ql-calcgraph/src/graph.rs:923:        let a1 = g.add_cell_node(0, 0, 0);
crates/ql-calcgraph/src/graph.rs:924:        let b1 = g.add_cell_node(0, 1, 0);
crates/ql-calcgraph/src/graph.rs:925:        let c1 = g.add_cell_node(0, 2, 0);
crates/ql-calcgraph/src/graph.rs:926:        let f = g.add_cell_node(0, 0, 3);
crates/ql-calcgraph/src/edges.rs:7://! Phase 0 uses plain `Vec<NodeId>` per direction per node. The Week 3 plan flagged
crates/ql-calcgraph/src/edges.rs:8://! `SmallVec<[NodeId; 4]>` as an option (most cells depend on ≤4 things, inline storage
crates/ql-calcgraph/src/edges.rs:17://! `FxHashSet<NodeId>` per node is a localized change.
crates/ql-calcgraph/src/edges.rs:19:use crate::node::NodeId;
crates/ql-calcgraph/src/edges.rs:28:///   maintains this via `push_node()` calls below.
crates/ql-calcgraph/src/edges.rs:33:    outgoing: Vec<Vec<NodeId>>,
crates/ql-calcgraph/src/edges.rs:34:    incoming: Vec<Vec<NodeId>>,
crates/ql-calcgraph/src/edges.rs:48:    /// `add_*_node` so adjacency lookups by `NodeId` are always in bounds.
crates/ql-calcgraph/src/edges.rs:49:    pub fn push_node(&mut self) {
crates/ql-calcgraph/src/edges.rs:58:    /// calling `push_node()` before any edge that references the new id.
crates/ql-calcgraph/src/edges.rs:62:    pub fn add_edge(&mut self, from: NodeId, to: NodeId) {
crates/ql-calcgraph/src/edges.rs:67:            "add_edge: from NodeId({from_idx}) out of bounds (have {} nodes)",
crates/ql-calcgraph/src/edges.rs:72:            "add_edge: to NodeId({to_idx}) out of bounds (have {} nodes)",
crates/ql-calcgraph/src/edges.rs:81:    pub fn outgoing(&self, node: NodeId) -> &[NodeId] {
crates/ql-calcgraph/src/edges.rs:86:    pub fn incoming(&self, node: NodeId) -> &[NodeId] {
crates/ql-calcgraph/src/edges.rs:90:    pub fn outgoing_count(&self, node: NodeId) -> usize {
crates/ql-calcgraph/src/edges.rs:94:    pub fn incoming_count(&self, node: NodeId) -> usize {
crates/ql-calcgraph/src/edges.rs:113:    /// Returns the drained `Vec<NodeId>` so the caller can iterate to clean
crates/ql-calcgraph/src/edges.rs:117:    pub fn clear_outgoing(&mut self, from: NodeId) -> Vec<NodeId> {
crates/ql-calcgraph/src/edges.rs:121:            "clear_outgoing: NodeId({idx}) out of bounds (have {} nodes)",
crates/ql-calcgraph/src/edges.rs:138:    pub fn remove_back_pointer(&mut self, target: NodeId, from: NodeId) {
crates/ql-calcgraph/src/edges.rs:142:            "remove_back_pointer: NodeId({idx}) out of bounds (have {} nodes)",
crates/ql-calcgraph/src/edges.rs:163:        a.push_node();
crates/ql-calcgraph/src/edges.rs:165:        a.push_node();
crates/ql-calcgraph/src/edges.rs:166:        a.push_node();
crates/ql-calcgraph/src/edges.rs:168:        assert!(a.outgoing(NodeId(0)).is_empty());
crates/ql-calcgraph/src/edges.rs:169:        assert!(a.incoming(NodeId(2)).is_empty());
crates/ql-calcgraph/src/edges.rs:175:        a.push_node(); // 0
crates/ql-calcgraph/src/edges.rs:176:        a.push_node(); // 1
crates/ql-calcgraph/src/edges.rs:177:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:178:        assert_eq!(a.outgoing(NodeId(0)), &[NodeId(1)]);
crates/ql-calcgraph/src/edges.rs:179:        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0)]);
crates/ql-calcgraph/src/edges.rs:180:        assert_eq!(a.outgoing(NodeId(1)), &[]); // 1 doesn't depend on anything
crates/ql-calcgraph/src/edges.rs:181:        assert_eq!(a.incoming(NodeId(0)), &[]); // nothing depends on 0
crates/ql-calcgraph/src/edges.rs:190:            a.push_node();
crates/ql-calcgraph/src/edges.rs:192:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:193:        a.add_edge(NodeId(0), NodeId(2));
crates/ql-calcgraph/src/edges.rs:194:        a.add_edge(NodeId(1), NodeId(3));
crates/ql-calcgraph/src/edges.rs:195:        a.add_edge(NodeId(2), NodeId(3));
crates/ql-calcgraph/src/edges.rs:197:        assert_eq!(a.outgoing_count(NodeId(0)), 2);
crates/ql-calcgraph/src/edges.rs:198:        assert_eq!(a.incoming_count(NodeId(3)), 2);
crates/ql-calcgraph/src/edges.rs:200:        let out0: &[NodeId] = a.outgoing(NodeId(0));
crates/ql-calcgraph/src/edges.rs:201:        assert_eq!(out0, &[NodeId(1), NodeId(2)]);
crates/ql-calcgraph/src/edges.rs:208:        a.push_node();
crates/ql-calcgraph/src/edges.rs:209:        a.push_node();
crates/ql-calcgraph/src/edges.rs:210:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:211:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:212:        assert_eq!(a.outgoing(NodeId(0)), &[NodeId(1), NodeId(1)]);
crates/ql-calcgraph/src/edges.rs:213:        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0), NodeId(0)]);
crates/ql-calcgraph/src/edges.rs:220:        a.push_node();
crates/ql-calcgraph/src/edges.rs:221:        a.add_edge(NodeId(5), NodeId(0));
crates/ql-calcgraph/src/edges.rs:228:        a.push_node();
crates/ql-calcgraph/src/edges.rs:229:        a.add_edge(NodeId(0), NodeId(5));
crates/ql-calcgraph/src/edges.rs:238:            a.push_node();
crates/ql-calcgraph/src/edges.rs:240:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:241:        a.add_edge(NodeId(0), NodeId(2));
crates/ql-calcgraph/src/edges.rs:242:        assert_eq!(a.outgoing(NodeId(0)).len(), 2);
crates/ql-calcgraph/src/edges.rs:244:        let drained = a.clear_outgoing(NodeId(0));
crates/ql-calcgraph/src/edges.rs:245:        assert_eq!(drained, vec![NodeId(1), NodeId(2)]);
crates/ql-calcgraph/src/edges.rs:246:        assert!(a.outgoing(NodeId(0)).is_empty());
crates/ql-calcgraph/src/edges.rs:248:        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0)]);
crates/ql-calcgraph/src/edges.rs:254:        a.push_node();
crates/ql-calcgraph/src/edges.rs:255:        let drained = a.clear_outgoing(NodeId(0));
crates/ql-calcgraph/src/edges.rs:257:        assert!(a.outgoing(NodeId(0)).is_empty());
crates/ql-calcgraph/src/edges.rs:264:        a.push_node();
crates/ql-calcgraph/src/edges.rs:265:        let _ = a.clear_outgoing(NodeId(5));
crates/ql-calcgraph/src/edges.rs:272:        a.push_node();
crates/ql-calcgraph/src/edges.rs:273:        a.push_node();
crates/ql-calcgraph/src/edges.rs:274:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:275:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:276:        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0), NodeId(0)]);
crates/ql-calcgraph/src/edges.rs:278:        a.remove_back_pointer(NodeId(1), NodeId(0));
crates/ql-calcgraph/src/edges.rs:279:        assert!(a.incoming(NodeId(1)).is_empty());
crates/ql-calcgraph/src/edges.rs:287:            a.push_node();
crates/ql-calcgraph/src/edges.rs:289:        a.add_edge(NodeId(0), NodeId(1));
crates/ql-calcgraph/src/edges.rs:290:        a.add_edge(NodeId(2), NodeId(1));
crates/ql-calcgraph/src/edges.rs:291:        assert_eq!(a.incoming(NodeId(1)), &[NodeId(0), NodeId(2)]);
crates/ql-calcgraph/src/edges.rs:293:        a.remove_back_pointer(NodeId(1), NodeId(0));
crates/ql-calcgraph/src/edges.rs:294:        assert_eq!(a.incoming(NodeId(1)), &[NodeId(2)]);

exec
/bin/zsh -lc "awk 'NR>=1528 && NR<=1542 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1528:
1529:    /// Phase 3.4: address lookup for a formula node. The graph's
1530:    /// `Node::Cell` payload carries `(sheet, row, col)` — this is the
1531:    /// inverse of `cell_node_for`. Returns `None` if the node is not
1532:    /// a Cell variant (today every NodeId in `cell_index` is a Cell;
1533:    /// Phase 4 may add Range/Region nodes that aren't formula cells).
1534:    pub fn cell_address_for(&self, node: NodeId) -> Option<(SheetId, RowId, ColId)> {
1535:        match self.graph.node(node) {
1536:            Node::Cell(CellNode { sheet, row, col }) => Some((*sheet, *row, *col)),
1537:            _ => None,
1538:        }
1539:    }
1540:
1541:    /// **W5-103 (Phase 4.7.J.4 / Codex W5-102 HIGH-1)** — readers whose
1542:    /// `cell_to_formulas` reverse index points at ANY cell in the

exec
/bin/zsh -lc "rg -n \"3-cycle|three-cycle|three cycle|A1 = B1|C1 = A1|cycled.*3|3-cycle|cycle\" crates/ql-exec/src/calcgraph_session.rs crates/ql-exec/src/workbook_runtime.rs crates/ql-calcgraph/src/topo.rs crates/ql-exec/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-calcgraph/src/topo.rs:9://!    (goes to `cycled`). Kahn would need a separate "did all dirty nodes emit?" check
crates/ql-calcgraph/src/topo.rs:10://!    after the toposort to identify cycle membership.
crates/ql-calcgraph/src/topo.rs:12://! 2. **Direct API for the Phase 0 cycle policy.** The spec's Phase 0 minimum: cycled
crates/ql-calcgraph/src/topo.rs:13://!    cells become `CellError(Cycle)`; non-cycled cells evaluate in topological order.
crates/ql-calcgraph/src/topo.rs:14://!    The `(sorted, cycled)` partition is exactly what the evaluator wants.
crates/ql-calcgraph/src/topo.rs:20://! 4. **Phase 0 minimum is non-iteration**: cycles are terminal errors, not states to
crates/ql-calcgraph/src/topo.rs:61:/// etc. `cycled` is unordered — every cycled node should be assigned a cycle error.
crates/ql-calcgraph/src/topo.rs:65:    pub cycled: Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:70:        self.sorted.is_empty() && self.cycled.is_empty()
crates/ql-calcgraph/src/topo.rs:74:        self.sorted.len() + self.cycled.len()
crates/ql-calcgraph/src/topo.rs:78:/// Schedule the given dirty subset for evaluation. Returns `(sorted, cycled)` where
crates/ql-calcgraph/src/topo.rs:79:/// `sorted` is in dependency-first topological order and `cycled` contains all nodes in
crates/ql-calcgraph/src/topo.rs:99:/// cycle.
crates/ql-calcgraph/src/topo.rs:106:/// Self-loops via supplemental ARE recognized as cycles (e.g.
crates/ql-calcgraph/src/topo.rs:108:/// dirty formula gets emitted into `cycled`).
crates/ql-calcgraph/src/topo.rs:129:    let mut cycled: Vec<NodeId> = Vec::new();
crates/ql-calcgraph/src/topo.rs:149:            &mut cycled,
crates/ql-calcgraph/src/topo.rs:153:    Schedule { sorted, cycled }
crates/ql-calcgraph/src/topo.rs:168:    cycled: &mut Vec<NodeId>,
crates/ql-calcgraph/src/topo.rs:173:    // pre-allocate filtered child vectors per node (the hot path under no-cycles is one
crates/ql-calcgraph/src/topo.rs:253:                // OR the supplemental map — both count as cycles.
crates/ql-calcgraph/src/topo.rs:254:                let is_cycle = scc.len() > 1
crates/ql-calcgraph/src/topo.rs:267:                if is_cycle {
crates/ql-calcgraph/src/topo.rs:268:                    cycled.extend(scc);
crates/ql-calcgraph/src/topo.rs:328:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:332:    fn single_node_with_self_loop_goes_to_cycled() {
crates/ql-calcgraph/src/topo.rs:338:        assert_eq!(s.cycled, vec![a]);
crates/ql-calcgraph/src/topo.rs:351:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:372:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:376:    fn two_node_cycle_goes_to_cycled() {
crates/ql-calcgraph/src/topo.rs:385:        assert_eq!(s.cycled.len(), 2);
crates/ql-calcgraph/src/topo.rs:386:        let cycled: std::collections::HashSet<_> = s.cycled.iter().copied().collect();
crates/ql-calcgraph/src/topo.rs:387:        assert_eq!(cycled, [a, b].into_iter().collect());
crates/ql-calcgraph/src/topo.rs:391:    fn mixed_cycle_and_acyclic_in_same_dirty_subset() {
crates/ql-calcgraph/src/topo.rs:397:        g.add_edge(b, a); // cycle
crates/ql-calcgraph/src/topo.rs:402:        let cycled: std::collections::HashSet<_> = s.cycled.iter().copied().collect();
crates/ql-calcgraph/src/topo.rs:403:        assert_eq!(cycled, [a, b].into_iter().collect());
crates/ql-calcgraph/src/topo.rs:419:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:422:        assert!(!s.cycled.contains(&c));
crates/ql-calcgraph/src/topo.rs:446:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:454:    fn three_node_cycle() {
crates/ql-calcgraph/src/topo.rs:464:        assert_eq!(s.cycled.len(), 3);
crates/ql-calcgraph/src/topo.rs:468:    fn cycle_with_acyclic_dependent() {
crates/ql-calcgraph/src/topo.rs:469:        // {A, B} cycle, plus C -> A. C should be in sorted (depends on a cycled SCC, but
crates/ql-calcgraph/src/topo.rs:470:        // C itself is not in the cycle).
crates/ql-calcgraph/src/topo.rs:478:        // a, b cycled; c sorted.
crates/ql-calcgraph/src/topo.rs:479:        let cycled: std::collections::HashSet<_> = s.cycled.iter().copied().collect();
crates/ql-calcgraph/src/topo.rs:480:        assert_eq!(cycled, [a, b].into_iter().collect());
crates/ql-calcgraph/src/topo.rs:485:    fn self_loop_in_dirty_subset_only_cycles_if_target_also_dirty() {
crates/ql-calcgraph/src/topo.rs:486:        // Self-loop A -> A. If A is in dirty, it's cycled. If A's "self" edge target
crates/ql-calcgraph/src/topo.rs:487:        // happened to point to a non-dirty version of itself, the cycle detection skips
crates/ql-calcgraph/src/topo.rs:489:        // straightforward case: self-loop + dirty = cycled.
crates/ql-calcgraph/src/topo.rs:494:        assert_eq!(s.cycled, vec![a]);
crates/ql-calcgraph/src/topo.rs:529:    fn supplemental_edge_produces_cycle() {
crates/ql-calcgraph/src/topo.rs:530:        // GAP-G-03 / H1 scenario #1 (cycle):
crates/ql-calcgraph/src/topo.rs:533:        // Both dirty → 2-SCC → cycled.
crates/ql-calcgraph/src/topo.rs:542:        assert!(s.sorted.is_empty(), "should be all cycled");
crates/ql-calcgraph/src/topo.rs:543:        let cycled: HashSet<_> = s.cycled.iter().copied().collect();
crates/ql-calcgraph/src/topo.rs:544:        assert_eq!(cycled, [a, b].into_iter().collect());
crates/ql-calcgraph/src/topo.rs:562:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:567:    fn supplemental_self_loop_is_cycled() {
crates/ql-calcgraph/src/topo.rs:568:        // Self-range cycle: A1 = SUM(A1:A1). Single dirty formula,
crates/ql-calcgraph/src/topo.rs:569:        // supplemental edge A → A. Must be cycled.
crates/ql-calcgraph/src/topo.rs:577:        assert_eq!(s.cycled, vec![a]);
crates/ql-calcgraph/src/topo.rs:593:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:600:        // the same back-edge. The cycle classification still must be
crates/ql-calcgraph/src/topo.rs:601:        // correct (here: no cycle, just a chain).
crates/ql-calcgraph/src/topo.rs:612:        assert!(s.cycled.is_empty());
crates/ql-calcgraph/src/topo.rs:616:    fn supplemental_three_node_cycle_via_mixed_edges() {
crates/ql-calcgraph/src/topo.rs:628:        assert_eq!(s.cycled.len(), 3);
crates/ql-exec/src/calcgraph_session.rs:461:    /// recompute cycle to schedule re-evaluation regardless of
crates/ql-exec/src/calcgraph_session.rs:496:    /// Per-recompute-cycle scoped — the caller clears the set after
crates/ql-exec/src/calcgraph_session.rs:627:    /// cycle in Phase 3.7.
crates/ql-exec/src/calcgraph_session.rs:633:    /// 3.7 reads this every recompute cycle.
crates/ql-exec/src/calcgraph_session.rs:683:        // create false `#CIRC!` cycles (megaudit H3) and stale stripe
crates/ql-exec/src/calcgraph_session.rs:713:        // **Lifecycle handoff (Codex W5-102 HIGH-1, design § 10.5):**
crates/ql-exec/src/calcgraph_session.rs:758:        // `#CIRC!` cycles can no longer occur. See
crates/ql-exec/src/calcgraph_session.rs:768:                // `=A1` at A1 (self-cycle), and the Phase 0 W3-3
crates/ql-exec/src/calcgraph_session.rs:770:                // SCC as `cycled`.
crates/ql-exec/src/calcgraph_session.rs:1051:            // deps (or as a Tarjan cycle participant if it pointed
crates/ql-exec/src/calcgraph_session.rs:1383:    /// most once → cycles in the dep graph are safe.
crates/ql-exec/src/calcgraph_session.rs:1464:    /// cycle. Returning `HashSet<NodeId>` rather than a slice lets
crates/ql-exec/src/calcgraph_session.rs:1636:    /// - `cycled`: nodes in a non-trivial strongly connected component
crates/ql-exec/src/calcgraph_session.rs:1651:        // Tarjan can see range-induced ordering / cycles. The Phase 0
crates/ql-exec/src/calcgraph_session.rs:1664:    /// self-range cycles) dirty formula `G` whose cell address falls
crates/ql-exec/src/calcgraph_session.rs:2034:    /// recompute cycle.
crates/ql-exec/src/calcgraph_session.rs:2625:        // C1 = A1 + B1; D1 = C1 + 1. Clearing C1 dirties D1 but not C1.
crates/ql-exec/src/calcgraph_session.rs:2704:    // — creating false `#CIRC!` cycles (H3) and false-positive dirty
crates/ql-exec/src/calcgraph_session.rs:2769:    /// false `A1 ↔ B1` cycle.
crates/ql-exec/src/calcgraph_session.rs:2782:    /// dirty set covering both, it must not fabricate a cycle.
crates/ql-exec/src/calcgraph_session.rs:2826:            sched.cycled.is_empty(),
crates/ql-exec/src/calcgraph_session.rs:2827:            "H3 closure: no false #CIRC! after rebind. cycled={:?}",
crates/ql-exec/src/calcgraph_session.rs:2828:            sched.cycled
crates/ql-exec/src/calcgraph_session.rs:2920:    // scheduler edges — Tarjan can't see range-induced cycles or
crates/ql-exec/src/calcgraph_session.rs:2932:    /// W5-50 / megaudit H1 example #1 — range-induced cycle:
crates/ql-exec/src/calcgraph_session.rs:2936:    /// in `cycled` (the cycle is `A1 → B1 → A1` via supplemental +
crates/ql-exec/src/calcgraph_session.rs:2939:    fn h1_range_induced_cycle_detected() {
crates/ql-exec/src/calcgraph_session.rs:2984:            "all in cycled, sorted={:?}",
crates/ql-exec/src/calcgraph_session.rs:2987:        let cycled: HashSet<NodeId> = sched.cycled.iter().copied().collect();
crates/ql-exec/src/calcgraph_session.rs:2989:            cycled,
crates/ql-exec/src/calcgraph_session.rs:2991:            "H1: range-induced cycle detected"
crates/ql-exec/src/calcgraph_session.rs:2996:    /// cycle):
crates/ql-exec/src/calcgraph_session.rs:3048:            sched.cycled.is_empty(),
crates/ql-exec/src/calcgraph_session.rs:3049:            "no cycle, cycled={:?}",
crates/ql-exec/src/calcgraph_session.rs:3050:            sched.cycled
crates/ql-exec/src/calcgraph_session.rs:3055:    /// W5-50 / self-range cycle: `A1 = "=SUM(A1:A1)"`. Single dirty
crates/ql-exec/src/calcgraph_session.rs:3057:    /// Tarjan emits A1 in `cycled`.
crates/ql-exec/src/calcgraph_session.rs:3059:    fn self_range_cycle_via_supplemental() {
crates/ql-exec/src/calcgraph_session.rs:3089:        assert!(sched.sorted.is_empty(), "self-cycle, sorted empty");
crates/ql-exec/src/calcgraph_session.rs:3090:        assert_eq!(sched.cycled, vec![a1], "self-range cycle detected");
crates/ql-exec/src/calcgraph_session.rs:3139:        assert!(sched.cycled.is_empty());
crates/ql-exec/src/calcgraph_session.rs:3264:    /// range cycle), clear A1, then write A1 as a literal. The stale
crates/ql-exec/src/calcgraph_session.rs:3266:    /// anymore. schedule_dirty must NOT emit A1 in `cycled`.
crates/ql-exec/src/calcgraph_session.rs:3268:    fn clear_formula_then_no_phantom_cycle() {
crates/ql-exec/src/calcgraph_session.rs:3297:        // `cycled` — producing a false #CIRC! on a cell that's no
crates/ql-exec/src/calcgraph_session.rs:3327:        // formulas) — definitely no phantom cycle on A1.
crates/ql-exec/src/calcgraph_session.rs:3329:        assert!(sched.cycled.is_empty(), "no phantom cycle");
crates/ql-exec/src/calcgraph_session.rs:3403:        // Sched contains both nodes. Sanity: no false cycle (B1
crates/ql-exec/src/calcgraph_session.rs:3405:        // B1, so no cycle).
crates/ql-exec/src/calcgraph_session.rs:3406:        assert!(sched.cycled.is_empty());
crates/ql-exec/src/calcgraph_session.rs:3476:    // dirty set and returns (sorted, cycled).
crates/ql-exec/src/calcgraph_session.rs:3482:    // `cycled` set).
crates/ql-exec/src/calcgraph_session.rs:3525:        assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
crates/ql-exec/src/calcgraph_session.rs:3538:    /// SCH-3-02: cycles surface in `Schedule::cycled` carrying every
crates/ql-exec/src/calcgraph_session.rs:3539:    /// SCC member. Build a 2-cycle (A1 = B1 + 1; B1 = A1 + 1) and a
crates/ql-exec/src/calcgraph_session.rs:3540:    /// self-loop (D1 = D1 + 1) and verify the cycle reporter sees
crates/ql-exec/src/calcgraph_session.rs:3543:    fn sch_3_02_cycles_report_all_scc_members() {
crates/ql-exec/src/calcgraph_session.rs:3551:        // Self-cycle at D1.
crates/ql-exec/src/calcgraph_session.rs:3561:        // Force the cycle into dirty: edit any of A1/B1, the dirty
crates/ql-exec/src/calcgraph_session.rs:3562:        // walk picks up the cycle members via direct-cell-dep reverse
crates/ql-exec/src/calcgraph_session.rs:3570:            sched.cycled.contains(&a1),
crates/ql-exec/src/calcgraph_session.rs:3571:            "A1 must surface in cycled — part of the 2-cycle"
crates/ql-exec/src/calcgraph_session.rs:3574:            sched.cycled.contains(&b1),
crates/ql-exec/src/calcgraph_session.rs:3575:            "B1 must surface in cycled — part of the 2-cycle"
crates/ql-exec/src/calcgraph_session.rs:3578:            sched.cycled.contains(&d1),
crates/ql-exec/src/calcgraph_session.rs:3579:            "D1 must surface in cycled — self-loop"
crates/ql-exec/src/calcgraph_session.rs:3582:        // a cycle).
crates/ql-exec/src/calcgraph_session.rs:3597:            (sched.sorted, sched.cycled)
crates/ql-exec/src/calcgraph_session.rs:3635:            .chain(sched.cycled.iter())
crates/ql-exec/src/workbook_runtime.rs:18://!   Runs Tarjan SCC over the attached `CalcgraphSession`'s dirty set; cycled
crates/ql-exec/src/workbook_runtime.rs:2996:        // cycle detection. `recompute_all` is the no-session-attached
crates/ql-exec/src/workbook_runtime.rs:3005:        // cell in a cycle. The acyclic remainder evaluates through
crates/ql-exec/src/workbook_runtime.rs:3013:        let cycled_cells: std::collections::HashSet<(SheetId, RowId, ColId)> = {
crates/ql-exec/src/workbook_runtime.rs:3028:                .cycled
crates/ql-exec/src/workbook_runtime.rs:3045:            // Tier C1: cycled cells short-circuit to #CIRC! without
crates/ql-exec/src/workbook_runtime.rs:3047:            // (cycled cells contribute to `attempted` but not
crates/ql-exec/src/workbook_runtime.rs:3050:            if cycled_cells.contains(&(sheet, row, col)) {
crates/ql-exec/src/workbook_runtime.rs:3144:        //   3. evaluate cycled + sorted.
crates/ql-exec/src/workbook_runtime.rs:3199:            for n in sched.sorted.iter().chain(sched.cycled.iter()) {
crates/ql-exec/src/workbook_runtime.rs:3213:            for node in &sched.cycled {
crates/ql-exec/src/workbook_runtime.rs:4615:    /// path) must detect cycles and emit `#CIRC!` for cycled cells.
crates/ql-exec/src/workbook_runtime.rs:4642:    /// 2-cycle: A1 = B1 + 1, B1 = A1 - 1. Both cells in the SCC must
crates/ql-exec/src/workbook_runtime.rs:4644:    /// reference test (`recompute_dirty_writes_circ_error_for_cycle_members`).
crates/ql-exec/src/workbook_runtime.rs:4646:    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
crates/ql-exec/src/workbook_runtime.rs:4662:            "A1 in 2-cycle must be #CIRC!"
crates/ql-exec/src/workbook_runtime.rs:4667:            "B1 in 2-cycle must be #CIRC!"
crates/ql-exec/src/workbook_runtime.rs:4671:    /// Acyclic mix with a cycle: A1 = 5, B1 = A1 * 2, C1 = C1 + 1
crates/ql-exec/src/workbook_runtime.rs:4673:    /// `#CIRC!`. Verifies cycle detection doesn't pollute the
crates/ql-exec/src/workbook_runtime.rs:4676:    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
crates/ql-exec/src/workbook_runtime.rs:4688:        assert_eq!(succeeded, 1, "B1 evaluates; C1 is cycled");
crates/ql-exec/src/workbook_runtime.rs:4704:    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
crates/ql-exec/src/workbook_runtime.rs:4717:            "cycle value must remain #CIRC! across repeated recompute_all calls (no drift)"
crates/ql-exec/src/workbook_runtime.rs:6174:    /// SCH-3-02 end-to-end: cycles get `#CIRC!`. Build A1 = B1 + 1
crates/ql-exec/src/workbook_runtime.rs:6175:    /// and B1 = A1 + 1 (a 2-cycle), then trigger a recompute. Every
crates/ql-exec/src/workbook_runtime.rs:6178:    /// Note: we build the cycle directly via the workbook's low-level
crates/ql-exec/src/workbook_runtime.rs:6180:    /// `WorkbookRuntime::set_formula` for the second cycle member
crates/ql-exec/src/workbook_runtime.rs:6181:    /// would re-evaluate A1 mid-cycle and write a non-cycle value,
crates/ql-exec/src/workbook_runtime.rs:6186:    fn recompute_dirty_writes_circ_error_for_cycle_members() {
crates/ql-exec/src/workbook_runtime.rs:6199:        // Mark the cycle dirty. on_set_value(A1) → cell_to_formulas[A1]
crates/ql-exec/src/workbook_runtime.rs:6202:        // the cycle.
crates/ql-exec/src/workbook_runtime.rs:6208:        // Both members are in cycled (not sorted); attempted == 2.
crates/ql-exec/src/workbook_runtime.rs:6217:            "A1 in cycle → #CIRC!"
crates/ql-exec/src/workbook_runtime.rs:6222:            "B1 in cycle → #CIRC!"
crates/ql-exec/tests/reference_fns_step3_e2e.rs:366:/// `RT-V1-followup` cycle adds the replay-side check.
crates/ql-exec/tests/p412_function_arg_fuzz.rs:235:/// 2-cycle with `with_graph` (Tarjan SCC active). Should yield #CIRC!.
crates/ql-exec/tests/p412_function_arg_fuzz.rs:238:fn two_cycle_a1_b1_with_graph() {
crates/ql-exec/tests/p412_function_arg_fuzz.rs:245:    eprintln!("two_cycle_a1_b1_with_graph: A1={r1} B1={r2}");
crates/ql-exec/tests/p412_function_arg_fuzz.rs:252:/// 2-cycle: A1 = B1+1, B1 = A1-1.
crates/ql-exec/tests/p412_function_arg_fuzz.rs:255:fn two_cycle_a1_b1() {
crates/ql-exec/tests/p412_function_arg_fuzz.rs:260:    eprintln!("two_cycle_a1_b1: A1={r1} B1={r2}");
crates/ql-exec/tests/p412_function_arg_fuzz.rs:398:// ─── Name-resolution cycle via defined names ───────────────────────────────

exec
/bin/zsh -lc "awk 'NR>=924 && NR<=940 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
924:    /// Count of formula cells across the workbook.
925:    pub fn formula_count(&self) -> usize {
926:        self.formula_cells.len()
927:    }
928:
929:    /// Iterate every formula cell as `(sheet, row, col, formula)`. Iteration order is
930:    /// HashMap-arbitrary; callers that need determinism (qbook save) should sort first.
931:    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
932:        self.formula_cells
933:            .iter()
934:            .map(|((s, r, c), f)| (*s, *r, *c, f))
935:    }
936:}
937:
938:#[cfg(test)]
939:mod tests {
940:    use super::*;

exec
/bin/zsh -lc "awk 'NR>=1 && NR<=25 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1://! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
2://!
3://! Ties the lex → parse → bind → eval → put pipeline together so callers (IDE,
4://! tests, future REPL) get one method that does the right thing for a user-typed
5://! formula. Plus a `recompute_all` method that re-evaluates every formula cell in
6://! the workbook — used after loading a `.qbook/` directory where formula values
7://! were left as `#NULL!` sentinels.
8://!
9://! Phase 1 W5-10 scope:
10://! - `set_formula(sheet, row, col, text)` — parse + eval + persist formula text +
11://!   evaluated value. Phase 3.5: routes the evaluated value to the COMPUTED
12://!   overlay; clears any stale user-overlay entry at the cell first.
13://! - `set_value(sheet, row, col, value)` — literal-only write; clears any existing
14://!   formula association. Phase 3.5: `clear_formula` cascades to drop the
15://!   computed-overlay entry too.
16://! - `recompute_all()` — legacy HashMap-order full pass; no graph awareness.
17://! - `recompute_dirty()` (Phase 3.4 W5-37) — incremental graph-driven recompute.
18://!   Runs Tarjan SCC over the attached `CalcgraphSession`'s dirty set; cycled
19://!   members get `Value::Error(ErrorValue::Circ)`. Phase 3.6 routes aggregates
20://!   through the session's `InMemAggregateCache`; Phase 3.8 applies value-
21://!   equality short-circuit; Phase 3.9 V1 tallies SIMD-eligible formulas in
22://!   `RecomputeResult.simd_classified`.
23://! - `validate_formula(sheet, row, col, text)` (Phase 2B.7) — full pipeline
24://!   without mutation; IDE on-keystroke validation entry.
25://!

exec
/bin/zsh -lc "awk 'NR>=3710 && NR<=3765 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/calcgraph_session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3710:        );
3711:    }
3712:
3713:    // ===== W5-102 (Phase 4.7.I) — producer-alias dep extraction =====
3714:    //
3715:    // Spill targets are NOT separate graph nodes. When a reader formula
3716:    // references a spill TARGET cell, dep extraction must reroute the
3717:    // dependency to the anchor — the anchor's formula owns the value at
3718:    // every cell in the spill rectangle. See design doc § 10.1.
3719:
3720:    /// Reader formula `B1 = A2` where A2 is the spill TARGET of an
3721:    /// anchor at A1 (shape 2×1). Dep extraction must record A1, NOT A2,
3722:    /// as the cell dep — so when A1's anchor recomputes, B1 dirties via
3723:    /// the regular `on_set_value(anchor)` path.
3724:    #[test]
3725:    fn producer_alias_reroutes_target_dep_to_anchor() {
3726:        let mut wb = ql_storage::Workbook::new();
3727:        // Spill anchor at A1 with shape (2 rows, 1 col) → claims A1+A2.
3728:        wb.register_spill((0, 0, 0), ql_storage::SpillShape::new(2, 1))
3729:            .expect("register_spill must succeed on empty workbook");
3730:
3731:        let mut s = CalcgraphSession::new();
3732:        // B1 = A2 (CellRef to the spill target).
3733:        let plan_b1 = ExprPlan::CellRef {
3734:            sheet: 0,
3735:            row: 1, // A2
3736:            col: 0,
3737:            abs_col: false,
3738:            abs_row: false,
3739:        };
3740:        s.on_set_formula(0, 0, 1, &plan_b1, &wb);
3741:        let b1 = s.cell_node_for(0, 0, 1).unwrap();
3742:
3743:        let deps = s.formula_deps(b1).expect("B1 must have deps recorded");
3744:        assert_eq!(
3745:            deps.cells,
3746:            vec![(0, 0, 0)],
3747:            "B1's dep must be the anchor A1, not the target A2"
3748:        );
3749:    }
3750:
3751:    /// Two SEPARATE reader formulas, each pointing at a different cell
3752:    /// in the SAME spill rectangle, must both end up dependent on the
3753:    /// anchor — AND writing to the anchor must dirty both readers in
3754:    /// one pass. Tests the cell_to_formulas reverse-index keying.
3755:    /// (Per Codex W5-102 LOW-2: renamed to clarify this is two-readers,
3756:    /// not single-formula-two-targets — see
3757:    /// `producer_alias_single_formula_two_targets_collapse` for that.)
3758:    #[test]
3759:    fn producer_alias_two_readers_one_anchor_both_dirty_together() {
3760:        let mut wb = ql_storage::Workbook::new();
3761:        // Anchor A1 with shape (3, 1) → A1, A2, A3 all part of spill.
3762:        wb.register_spill((0, 0, 0), ql_storage::SpillShape::new(3, 1))
3763:            .expect("register_spill must succeed");
3764:
3765:        let mut s = CalcgraphSession::new();

exec
/bin/zsh -lc "awk 'NR>=10010 && NR<=10170 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-exec/src/workbook_runtime.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
10010:    /// C1=SEQUENCE(3,1,1,A1), D1=C3. The anchor's value (start=1) is
10011:    /// invariant across A1 changes; only C2 and C3 change.
10012:    /// D1 is producer-aliased to C1 (4.7.I); D1 indexed at C1's
10013:    /// address. Without the fix, recompute_dirty leaves D1 stale.
10014:    ///
10015:    /// Closed by: hook pass ALSO fires on_set_value at the anchor
10016:    /// cell, so aliased readers (cell_to_formulas[anchor]) get dirtied.
10017:    #[test]
10018:    fn recompute_dirty_aliased_reader_sees_target_value_change_when_anchor_unchanged() {
10019:        use crate::CalcgraphSession;
10020:        let mut wb = make_runtime_workbook();
10021:        let reg = default_registry();
10022:        let mut graph = CalcgraphSession::new();
10023:        {
10024:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
10025:            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap(); // A1 = 1
10026:                                                                // C1 = SEQUENCE(3, 1, 1, A1) → spill at C1 with step = A1.
10027:                                                                // C1 = 1, C2 = 1+A1, C3 = 1+2*A1.
10028:            rt.set_formula(0, 0, 2, "SEQUENCE(3, 1, 1, A1)").unwrap();
10029:            // D1 = C3 — aliased to C1 via producer-alias rewrite.
10030:            rt.set_formula(0, 0, 3, "C3").unwrap();
10031:        }
10032:        // Initial: A1=1, so C3=1+2*1=3. D1=3.
10033:        assert_eq!(wb.read(ql_types::Address::new(0, 0, 3)), Value::Number(3.0));
10034:
10035:        // Change A1 to 2. SEQUENCE result: C1=1 (unchanged!), C2=3, C3=5.
10036:        {
10037:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
10038:            rt.set_value(0, 0, 0, Value::Number(2.0)).unwrap();
10039:            let result = rt.recompute_dirty().expect("graph attached");
10040:            assert!(result.is_complete(), "recompute failures: {result:?}");
10041:        }
10042:        // C1's anchor value is still 1.
10043:        assert_eq!(wb.read(ql_types::Address::new(0, 0, 2)), Value::Number(1.0));
10044:        // C3's value changed.
10045:        assert_eq!(wb.read(ql_types::Address::new(0, 2, 2)), Value::Number(5.0));
10046:        // D1 = C3 should reflect the new C3 = 5.
10047:        assert_eq!(
10048:            wb.read(ql_types::Address::new(0, 0, 3)),
10049:            Value::Number(5.0),
10050:            "D1 must reflect C3's new value even though C1 anchor is unchanged"
10051:        );
10052:    }
10053:
10054:    /// **Codex audit HIGH-2**: after recompute-time spill dissolution,
10055:    /// aliased readers don't get re-extracted. Subsequent user writes
10056:    /// to the (now-free) target cells don't dirty the readers.
10057:    ///
10058:    /// A1=3, B1=SEQUENCE(A1) (spill B1..B3). X1=B2 (aliased to B1).
10059:    /// A1=0 → B1=#CALC!, spill dissolved.
10060:    /// User set_value(B2, 99). X1 should see B2=99.
10061:    ///
10062:    /// Closed by: recompute_dirty calls reextract_spill_footprint_readers
10063:    /// for the (old, new) footprints, mirroring set_formula 4.7.J.4.
10064:    #[test]
10065:    fn recompute_dirty_dissolution_reextracts_aliased_readers() {
10066:        use crate::CalcgraphSession;
10067:        let mut wb = make_runtime_workbook();
10068:        let reg = default_registry();
10069:        let mut graph = CalcgraphSession::new();
10070:        {
10071:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
10072:            rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap();
10073:            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap();
10074:            rt.set_formula(0, 0, 4, "B2").unwrap(); // X1 = B2, aliased to B1.
10075:        }
10076:        let x1 = graph.cell_node_for(0, 0, 4).unwrap();
10077:        assert_eq!(
10078:            graph.formula_deps(x1).unwrap().cells,
10079:            vec![(0, 0, 1)],
10080:            "X1 starts aliased to B1"
10081:        );
10082:
10083:        // Change A1 to 0 — SEQUENCE(0) → #NUM! per design § 13.1
10084:        // (W5-108 / Phase 4.7.O Codex M2 closure). The recompute
10085:        // surfaces a scalar error at B1, the spill dissolves, and
10086:        // host dissolution still triggers the re-extraction we're
10087:        // pinning here. Whether B1 ends as #NUM! or #CALC! is
10088:        // orthogonal to this test's invariant.
10089:        {
10090:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
10091:            rt.set_value(0, 0, 0, Value::Number(0.0)).unwrap();
10092:            let result = rt.recompute_dirty().expect("graph attached");
10093:            assert!(result.is_complete(), "recompute failures: {result:?}");
10094:        }
10095:        // X1's dep must be RE-EXTRACTED to literal B2 after the
10096:        // host dissolution.
10097:        assert_eq!(
10098:            graph.formula_deps(x1).unwrap().cells,
10099:            vec![(0, 1, 1)],
10100:            "X1's dep re-extracted to literal B2 after spill dissolves"
10101:        );
10102:
10103:        // Canonical test: user writes B2 = 99. X1 should see it.
10104:        {
10105:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
10106:            rt.set_value(0, 1, 1, Value::Number(99.0)).unwrap();
10107:            let result = rt.recompute_dirty().expect("graph attached");
10108:            assert!(result.is_complete(), "recompute failures: {result:?}");
10109:        }
10110:        assert_eq!(
10111:            wb.read(ql_types::Address::new(0, 0, 4)),
10112:            Value::Number(99.0),
10113:            "X1 must see B2's user write after dissolution + re-extract"
10114:        );
10115:    }
10116:
10117:    /// **#136 closure**: A1 = 3, B1 = SEQUENCE(A1) (spills B1..B3),
10118:    /// D1 = B5 (currently Blank — references a cell OUTSIDE the spill
10119:    /// footprint). Change A1 to 5; B1 now spills B1..B5. D1 should see
10120:    /// B5 = 5 and update.
10121:    ///
10122:    /// Closed by: (a) `try_recompute_with_simd_profile` now fires
10123:    /// on_set_value for non-anchor cells in (old ∪ new) spill footprint
10124:    /// after write_spill; (b) `recompute_dirty` wraps schedule+eval in
10125:    /// a fixed-point loop so mid-pass dirties (D1 dirtied by B1's
10126:    /// recompute writing B5) get picked up in a follow-up iteration.
10127:    #[test]
10128:    fn recompute_dirty_sequence_grows_dirties_new_target_readers() {
10129:        use crate::CalcgraphSession;
10130:        let mut wb = make_runtime_workbook();
10131:        let reg = default_registry();
10132:        let mut graph = CalcgraphSession::new();
10133:        {
10134:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
10135:            rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap();
10136:            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap();
10137:            // D1 = B5 — currently Blank (outside the 3x1 spill).
10138:            rt.set_formula(0, 0, 3, "B5").unwrap();
10139:        }
10140:        assert_eq!(
10141:            wb.read(ql_types::Address::new(0, 0, 3)),
10142:            Value::Blank,
10143:            "D1 = B5 evaluates to Blank initially (B5 outside footprint)"
10144:        );
10145:
10146:        // Grow the spill.
10147:        {
10148:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
10149:            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
10150:            let result = rt.recompute_dirty().expect("graph attached");
10151:            assert!(result.is_complete(), "recompute failures: {result:?}");
10152:        }
10153:
10154:        // After recompute_dirty: D1 should see B5 = 5.
10155:        assert_eq!(
10156:            wb.read(ql_types::Address::new(0, 0, 3)),
10157:            Value::Number(5.0),
10158:            "D1 must update to B5's new value after spill grows"
10159:        );
10160:    }
10161:
10162:    // ===== W5-116 (Phase 4.8.G) — structured-ref eval through aggregate =====
10163:
10164:    /// **First end-to-end test for Phase 4.8 structured refs.** Set up a
10165:    /// table `Sales` with a `Qty` column; write `SUM(Sales[Qty])`; assert
10166:    /// the result matches a hand-summed value. Exercises:
10167:    /// - 4.8.A: TableMetadata + Workbook::tables_mut().insert.
10168:    /// - 4.8.B: lexer Token::StructuredRef.
10169:    /// - 4.8.C: parser Expr::StructuredRef + Combination/BareColumn.
10170:    /// - 4.8.E: BindSite plumbing (cell address carried).

exec
/bin/zsh -lc "awk 'NR>=3440 && NR<=3488 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-io/src/qbook_format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3440:    /// spill, load it back, verify:
3441:    ///   - the anchor's formula text survives.
3442:    ///   - the anchor's computed value survives in the COMPUTED lane
3443:    ///     (the loader at qbook_format.rs:1449-1453 routes formula
3444:    ///     cells' non-Blank saved values through `put_computed_at`,
3445:    ///     preserving the formula-owned-cell invariant "no user-overlay
3446:    ///     entry on a formula cell").
3447:    ///   - the SpillAnchorTable + target cells (B1, C1) are EMPTY.
3448:    ///     `recompute_all` re-derives them per design § 12.3.
3449:    #[test]
3450:    fn spill_targets_load_as_blank_pending_recompute() {
3451:        let dir = TempDir::new().unwrap();
3452:        let path = dir.path().join("spill-load.qbook");
3453:
3454:        let mut wb = Workbook::new();
3455:        let s = wb.add_sheet("S");
3456:        wb.put_formula(s, 0, 0, "{1, 2, 3}");
3457:        wb.put_computed_at(s, 0, 0, Value::Number(1.0));
3458:        wb.put_computed_at(s, 0, 1, Value::Number(2.0));
3459:        wb.put_computed_at(s, 0, 2, Value::Number(3.0));
3460:        wb.register_spill((s, 0, 0), ql_storage::SpillShape::new(1, 3))
3461:            .unwrap();
3462:
3463:        save_workbook(&wb, "spill-load", &path).unwrap();
3464:        let loaded = load_workbook(&path).unwrap();
3465:
3466:        // Anchor formula text survives.
3467:        assert_eq!(
3468:            loaded.formula_at(s, 0, 0).map(|s| s.as_ref()),
3469:            Some("{1, 2, 3}")
3470:        );
3471:        // Anchor's value at load: Number(1.0) in user lane. (Per design
3472:        // § 12.2: anchors save normally — formula + value. The
3473:        // pre-recompute state has the value in user lane; recompute_all
3474:        // then routes through write_spill → clear_user_at → put_computed_at
3475:        // to correct the lane.)
3476:        assert_eq!(loaded.read(Address::new(s, 0, 0)), Value::Number(1.0));
3477:        // B1 and C1 are Blank — they weren't saved.
3478:        assert_eq!(loaded.read(Address::new(s, 0, 1)), Value::Blank);
3479:        assert_eq!(loaded.read(Address::new(s, 0, 2)), Value::Blank);
3480:        // SpillAnchorTable does NOT round-trip — it's runtime-derived
3481:        // by recompute_all from the formula text. Loaded workbook has
3482:        // no spill state until recompute fires.
3483:        assert_eq!(loaded.spill_anchor_at(s, 0, 0), None);
3484:    }
3485:
3486:    /// Phase 2A.8 backward-compat test: a hand-crafted v1 envelope (no `names`
3487:    /// section, legacy `Error("#NULL!")` placeholder for formula-bearing Blank
3488:    /// cells) loads cleanly on the v2 reader. The legacy `#NULL!` + formula

exec
/bin/zsh -lc "awk 'NR>=1470 && NR<=1492 {printf \"%d:%s\\n\", NR, "'$0}'"' crates/ql-io/src/qbook_format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1470:        // are skipped. Phase 2 may optimize via direct chunk-walking; not on hot path.
1471:        for row in 0..bounds.row_extent {
1472:            for col in 0..bounds.col_extent {
1473:                // **W5-105 (Phase 4.7.L) — design § 12.2 closure**: skip
1474:                // non-anchor spill TARGET cells. Their computed values are
1475:                // runtime-derived from the anchor's formula via the
1476:                // load → recompute_all pipeline (Phase 4.7.J #128 made
1477:                // recompute_all dispatch top-level arrays through
1478:                // `write_spill`). Saving target cells would emit
1479:                // `CellRecord { value: <spilled>, formula: None }` records
1480:                // that on reload look like user-typed values BLOCKING the
1481:                // re-spill — the very issue Codex W5-94 design HIGH-5
1482:                // identified as motivating the schema-skip approach.
1483:                //
1484:                // The anchor cell itself still saves (its formula text is
1485:                // what replay + recompute_all needs).
1486:                if let Some(anchor) = wb.spill_target_anchor(sheet_id, row, col) {
1487:                    if anchor != (sheet_id, row, col) {
1488:                        continue;
1489:                    }
1490:                }
1491:
1492:                let v = sheet.read(row, col);

codex
A key behavioral gap is emerging: `recompute_all` records which cells are cyclic, but it writes `#CIRC!` only when that cell happens to appear in the later HashMap-order loop. That means non-cyclic dependents can still read a stale cyclic cell before it has been overwritten.
exec
/bin/zsh -lc 'cargo test -p ql-exec --test p412_function_arg_fuzz self_referential_sum_whole_column -- --ignored --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 exited 127 in 0ms:
zsh:1: command not found: cargo

exec
/bin/zsh -lc "awk 'NR>=1 && NR<=220 {printf \"%d:%s\\n\", NR, "'$0}'"' .github/copilot-instructions.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 exited 2 in 0ms:
awk: can't open file .github/copilot-instructions.md
 source line number 1

exec
/bin/zsh -lc "awk 'NR>=1 && NR<=220 {printf \"%d:%s\\n\", NR, "'$0}'"' ../.github/copilot-instructions.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1:# VS Code Copilot Instructions
2:
3:## Project Overview
4:
5:Visual Studio Code is built with a layered architecture using TypeScript, web APIs and Electron, combining web technologies with native app capabilities. The codebase is organized into key architectural layers:
6:
7:### Root Folders
8:- `src/`: Main TypeScript source code with unit tests in `src/vs/*/test/` folders
9:- `build/`: Build scripts and CI/CD tools
10:- `extensions/`: Built-in extensions that ship with VS Code
11:- `test/`: Integration tests and test infrastructure
12:- `scripts/`: Development and build scripts
13:- `resources/`: Static resources (icons, themes, etc.)
14:- `out/`: Compiled JavaScript output (generated during build)
15:
16:### Core Architecture (`src/` folder)
17:- `src/vs/base/` - Foundation utilities and cross-platform abstractions
18:- `src/vs/platform/` - Platform services and dependency injection infrastructure
19:- `src/vs/editor/` - Text editor implementation with language services, syntax highlighting, and editing features
20:- `src/vs/workbench/` - Main application workbench for web and desktop
21:  - `workbench/browser/` - Core workbench UI components (parts, layout, actions)
22:  - `workbench/services/` - Service implementations
23:  - `workbench/contrib/` - Feature contributions (git, debug, search, terminal, etc.)
24:  - `workbench/api/` - Extension host and VS Code API implementation
25:- `src/vs/code/` - Electron main process specific implementation
26:- `src/vs/server/` - Server specific implementation
27:
28:The core architecture follows these principles:
29:- **Layered architecture** - from `base`, `platform`, `editor`, to `workbench`
30:- **Dependency injection** - Services are injected through constructor parameters
31:- **Contribution model** - Features contribute to registries and extension points
32:- **Cross-platform compatibility** - Abstractions separate platform-specific code
33:
34:### Built-in Extensions (`extensions/` folder)
35:The `extensions/` directory contains first-party extensions that ship with VS Code:
36:- **Language support** - `typescript-language-features/`, `html-language-features/`, `css-language-features/`, etc.
37:- **Core features** - `git/`, `debug-auto-launch/`, `emmet/`, `markdown-language-features/`
38:- **Themes** - `theme-*` folders for default color themes
39:- **Development tools** - `extension-editing/`, `vscode-api-tests/`
40:
41:Each extension follows the standard VS Code extension structure with `package.json`, TypeScript sources, and contribution points to extend the workbench through the Extension API.
42:
43:### Finding Related Code
44:1. **Semantic search first**: Use file search for general concepts
45:2. **Grep for exact strings**: Use grep for error messages or specific function names
46:3. **Follow imports**: Check what files import the problematic module
47:4. **Check test files**: Often reveal usage patterns and expected behavior
48:
49:## Validating TypeScript changes
50:
51:MANDATORY: Always check the `VS Code - Build` watch task output via #runTasks/getTaskOutput for compilation errors before running ANY script or declaring work complete, then fix all compilation errors before moving forward.
52:
53:- NEVER run tests if there are compilation errors
54:- NEVER use `npm run compile` to compile TypeScript files but call #runTasks/getTaskOutput instead
55:
56:### TypeScript compilation steps
57:- Monitor the `VS Code - Build` task outputs for real-time compilation errors as you make changes
58:- This task runs `Core - Build` and `Ext - Build` to incrementally compile VS Code TypeScript sources and built-in extensions
59:- Start the task if it's not already running in the background
60:
61:### TypeScript validation steps
62:- Use the run test tool if you need to run tests. If that tool is not available, then you can use `scripts/test.sh` (or `scripts\test.bat` on Windows) for unit tests (add `--grep <pattern>` to filter tests) or `scripts/test-integration.sh` (or `scripts\test-integration.bat` on Windows) for integration tests (integration tests end with .integrationTest.ts or are in /extensions/).
63:- Use `npm run valid-layers-check` to check for layering issues
64:
65:## Coding Guidelines
66:
67:### Indentation
68:
69:We use tabs, not spaces.
70:
71:### Naming Conventions
72:
73:- Use PascalCase for `type` names
74:- Use PascalCase for `enum` values
75:- Use camelCase for `function` and `method` names
76:- Use camelCase for `property` names and `local variables`
77:- Use whole words in names when possible
78:
79:### Types
80:
81:- Do not export `types` or `functions` unless you need to share it across multiple components
82:- Do not introduce new `types` or `values` to the global namespace
83:
84:### Comments
85:
86:- Use JSDoc style comments for `functions`, `interfaces`, `enums`, and `classes`
87:
88:### Strings
89:
90:- Use "double quotes" for strings shown to the user that need to be externalized (localized)
91:- Use 'single quotes' otherwise
92:- All strings visible to the user need to be externalized using the `vs/nls` module
93:- Externalized strings must not use string concatenation. Use placeholders instead (`{0}`).
94:
95:### UI labels
96:- Use title-style capitalization for command labels, buttons and menu items (each word is capitalized).
97:- Don't capitalize prepositions of four or fewer letters unless it's the first or last word (e.g. "in", "with", "for").
98:
99:### Style
100:
101:- Use arrow functions `=>` over anonymous function expressions
102:- Only surround arrow function parameters when necessary. For example, `(x) => x + x` is wrong but the following are correct:
103:
104:```typescript
105:x => x + x
106:(x, y) => x + y
107:<T>(x: T, y: T) => x === y
108:```
109:
110:- Always surround loop and conditional bodies with curly braces
111:- Open curly braces always go on the same line as whatever necessitates them
112:- Parenthesized constructs should have no surrounding whitespace. A single space follows commas, colons, and semicolons in those constructs. For example:
113:
114:```typescript
115:for (let i = 0, n = str.length; i < 10; i++) {
116:    if (x < 10) {
117:        foo();
118:    }
119:}
120:function f(x: number, y: string): void { }
121:```
122:
123:- Whenever possible, use in top-level scopes `export function x(…) {…}` instead of `export const x = (…) => {…}`. One advantage of using the `function` keyword is that the stack-trace shows a good name when debugging.
124:
125:### Code Quality
126:
127:- All files must include Microsoft copyright header
128:- Prefer `async` and `await` over `Promise` and `then` calls
129:- All user facing messages must be localized using the applicable localization framework (for example `nls.localize()` method)
130:- Don't add tests to the wrong test suite (e.g., adding to end of file instead of inside relevant suite)
131:- Look for existing test patterns before creating new structures
132:- Use `describe` and `test` consistently with existing patterns
133:- Prefer regex capture groups with names over numbered capture groups.
134:- If you create any temporary new files, scripts, or helper files for iteration, clean up these files by removing them at the end of the task
135:- Never duplicate imports. Always reuse existing imports if they are present.
136:- Do not use `any` or `unknown` as the type for variables, parameters, or return values unless absolutely necessary. If they need type annotations, they should have proper types or interfaces defined.
137:- When adding file watching, prefer correlated file watchers (via fileService.createWatcher) to shared ones.
138:- When adding tooltips to UI elements, prefer the use of IHoverService service.

codex
**Punch List**
- **H** `crates/ql-exec/src/workbook_runtime.rs:3044`  
  Cycled cells are written only when the HashMap-order eval loop reaches them. A non-cycled dependent, e.g. `B1=A1+1` with `A1=A1+1`, can evaluate before `A1` is overwritten to `#CIRC!` and read A1’s stale prior value. `iter_formulas()` is explicitly arbitrary order at `crates/ql-storage/src/workbook.rs:929`.  
  **Fix:** write all `cycled_cells` to `#CIRC!` in a pre-pass before evaluating any non-cycled formulas, matching `recompute_dirty`’s cycle-first behavior at `crates/ql-exec/src/workbook_runtime.rs:3209`.

- **H** `crates/ql-exec/src/workbook_runtime.rs:3050`  
  The cycle short-circuit bypasses `try_recompute_with_simd_profile`, so it also bypasses old-spill dissolution at `crates/ql-exec/src/workbook_runtime.rs:3681`. If a previously spilling anchor is replayed or overwritten into a circular formula, stale spill anchors/target overlays can survive while the anchor shows `#CIRC!`.  
  **Fix:** before writing `#CIRC!`, call `clear_spill_if_present((sheet,row,col))` for cycled cells, and add a regression where an old array/spill formula becomes circular.

- **M** `crates/ql-exec/src/workbook_runtime.rs:3015`  
  Spill-target producer-alias cycles are only detected if spill anchors already exist when `rebuild_from_workbook` runs. `.qbook` load intentionally does not restore spill state (`crates/ql-io/src/qbook_format.rs:3480`), while producer-alias extraction depends on `workbook.spill_target_anchor` (`crates/ql-exec/src/calcgraph_session.rs:724`). Dynamic cycles through re-derived spill targets can therefore be missed on cold load.  
  **Fix:** run `recompute_all` through the same fixed-point spill/reextract machinery as `recompute_dirty`, or rebuild/reschedule after spill materialization when spill footprints change.

- **M** `crates/ql-oplog/src/replay.rs:296`  
  `replay_into` still does not end with `recompute_all`; it only installs formula text (`crates/ql-oplog/src/replay.rs:335`) and returns. The fix propagates to callers that explicitly recompute, but not to any Phase 5 caller that reads workbook values immediately after replay.  
  **Fix:** add a `replay_into_and_recompute` entry point or make Phase 5 replay wrappers call `WorkbookRuntime::recompute_all` before exposing values. Add an oplog cycle replay test.

- **M** `crates/ql-exec/src/calcgraph_session.rs:1677`  
  The new cold-load path marks every formula dirty, then `build_range_supplemental` is `O(|dirty|² × avg_ranges)`. On 10K formula workbooks with range/table/named-range refs, this can dwarf the documented 2x parse cost.  
  **Fix:** add a full-dirty optimized scheduler path using per-sheet row/col buckets or stripe lookups for dirty formulas inside ranges; benchmark 10K formulas with named/table ranges.

- **M** `crates/ql-exec/src/workbook_runtime.rs:3008`  
  The patch parses/binds every formula in `rebuild_from_workbook`, then parses/binds again in `try_recompute_one_cached`. That is measurable on large cold-load/replay workbooks even before the quadratic range supplemental cost.  
  **Fix:** have `rebuild_from_workbook` optionally return bound plans or seed the runtime `PlanCache`, so the eval loop reuses successful binds.

- **L** `crates/ql-exec/src/workbook_runtime.rs:4619`  
  The four new tests cover direct self-cycle, 2-cycle, mixed acyclic/self-cycle, and repeated self-cycle only. Missing direct coverage for 3-cycle, cross-sheet cycle, named-range/table-column/self-range cycles, cycle dependents reading `#CIRC!`, old-spill-to-cycle, and loader/oplog replay integration.  
  **Fix:** add focused `recompute_all` tests for those cases, especially the dependent-of-cycle ordering case.

- **L** `crates/ql-exec/src/workbook_runtime.rs:16`  
  Module docs still say `recompute_all()` has “no graph awareness,” which is now false after the ephemeral `CalcgraphSession` rebuild.  
  **Fix:** update the doc comment to say it uses an ephemeral graph only for cycle detection, while evaluation remains legacy full-pass.

No issue found with aggregate cache spillover: `rebuild_from_workbook` clears the ephemeral session cache at `crates/ql-exec/src/calcgraph_session.rs:934`, and that session is dropped before evaluation. I could not run Rust tests locally because `cargo` is not on PATH in this environment.
tokens used
224,819
**Punch List**
- **H** `crates/ql-exec/src/workbook_runtime.rs:3044`  
  Cycled cells are written only when the HashMap-order eval loop reaches them. A non-cycled dependent, e.g. `B1=A1+1` with `A1=A1+1`, can evaluate before `A1` is overwritten to `#CIRC!` and read A1’s stale prior value. `iter_formulas()` is explicitly arbitrary order at `crates/ql-storage/src/workbook.rs:929`.  
  **Fix:** write all `cycled_cells` to `#CIRC!` in a pre-pass before evaluating any non-cycled formulas, matching `recompute_dirty`’s cycle-first behavior at `crates/ql-exec/src/workbook_runtime.rs:3209`.

- **H** `crates/ql-exec/src/workbook_runtime.rs:3050`  
  The cycle short-circuit bypasses `try_recompute_with_simd_profile`, so it also bypasses old-spill dissolution at `crates/ql-exec/src/workbook_runtime.rs:3681`. If a previously spilling anchor is replayed or overwritten into a circular formula, stale spill anchors/target overlays can survive while the anchor shows `#CIRC!`.  
  **Fix:** before writing `#CIRC!`, call `clear_spill_if_present((sheet,row,col))` for cycled cells, and add a regression where an old array/spill formula becomes circular.

- **M** `crates/ql-exec/src/workbook_runtime.rs:3015`  
  Spill-target producer-alias cycles are only detected if spill anchors already exist when `rebuild_from_workbook` runs. `.qbook` load intentionally does not restore spill state (`crates/ql-io/src/qbook_format.rs:3480`), while producer-alias extraction depends on `workbook.spill_target_anchor` (`crates/ql-exec/src/calcgraph_session.rs:724`). Dynamic cycles through re-derived spill targets can therefore be missed on cold load.  
  **Fix:** run `recompute_all` through the same fixed-point spill/reextract machinery as `recompute_dirty`, or rebuild/reschedule after spill materialization when spill footprints change.

- **M** `crates/ql-oplog/src/replay.rs:296`  
  `replay_into` still does not end with `recompute_all`; it only installs formula text (`crates/ql-oplog/src/replay.rs:335`) and returns. The fix propagates to callers that explicitly recompute, but not to any Phase 5 caller that reads workbook values immediately after replay.  
  **Fix:** add a `replay_into_and_recompute` entry point or make Phase 5 replay wrappers call `WorkbookRuntime::recompute_all` before exposing values. Add an oplog cycle replay test.

- **M** `crates/ql-exec/src/calcgraph_session.rs:1677`  
  The new cold-load path marks every formula dirty, then `build_range_supplemental` is `O(|dirty|² × avg_ranges)`. On 10K formula workbooks with range/table/named-range refs, this can dwarf the documented 2x parse cost.  
  **Fix:** add a full-dirty optimized scheduler path using per-sheet row/col buckets or stripe lookups for dirty formulas inside ranges; benchmark 10K formulas with named/table ranges.

- **M** `crates/ql-exec/src/workbook_runtime.rs:3008`  
  The patch parses/binds every formula in `rebuild_from_workbook`, then parses/binds again in `try_recompute_one_cached`. That is measurable on large cold-load/replay workbooks even before the quadratic range supplemental cost.  
  **Fix:** have `rebuild_from_workbook` optionally return bound plans or seed the runtime `PlanCache`, so the eval loop reuses successful binds.

- **L** `crates/ql-exec/src/workbook_runtime.rs:4619`  
  The four new tests cover direct self-cycle, 2-cycle, mixed acyclic/self-cycle, and repeated self-cycle only. Missing direct coverage for 3-cycle, cross-sheet cycle, named-range/table-column/self-range cycles, cycle dependents reading `#CIRC!`, old-spill-to-cycle, and loader/oplog replay integration.  
  **Fix:** add focused `recompute_all` tests for those cases, especially the dependent-of-cycle ordering case.

- **L** `crates/ql-exec/src/workbook_runtime.rs:16`  
  Module docs still say `recompute_all()` has “no graph awareness,” which is now false after the ephemeral `CalcgraphSession` rebuild.  
  **Fix:** update the doc comment to say it uses an ephemeral graph only for cycle detection, while evaluation remains legacy full-pass.

No issue found with aggregate cache spillover: `rebuild_from_workbook` clears the ephemeral session cache at `crates/ql-exec/src/calcgraph_session.rs:934`, and that session is dropped before evaluation. I could not run Rust tests locally because `cargo` is not on PATH in this environment.
