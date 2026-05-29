  2143	    /// Schedule).
  2144	    ///
  2145	    /// Complexity: O(|dirty_vec|² × avg_ranges_per_formula). Typical
  2146	    /// edits have small dirty sets; the inner loop is a tight
  2147	    /// `range_contains_rowcol` check. If profiling later shows pain,
  2148	    /// switching to per-range bucketing (build a per-stripe index of
  2149	    /// dirty formulas, intersect with range bounds) is the path.
  2150	    fn build_range_supplemental(&self, dirty_vec: &[NodeId]) -> HashMap<NodeId, Vec<NodeId>> {
  2151	        // Resolve cell addresses for every dirty FORMULA node. Non-
  2152	        // formula NodeIds (none exist today — the graph only adds Cell
  2153	        // nodes for formula cells) filter out via cell_address_for
  2154	        // returning None.
  2155	        let dirty_addrs: Vec<(NodeId, SheetId, RowId, ColId)> = dirty_vec

exec
/bin/bash -lc "nl -ba quantbook-engine/crates/ql-exec/src/calcgraph_session.rs | sed -n '2150,2190p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  2150	    fn build_range_supplemental(&self, dirty_vec: &[NodeId]) -> HashMap<NodeId, Vec<NodeId>> {
  2151	        // Resolve cell addresses for every dirty FORMULA node. Non-
  2152	        // formula NodeIds (none exist today — the graph only adds Cell
  2153	        // nodes for formula cells) filter out via cell_address_for
  2154	        // returning None.
  2155	        let dirty_addrs: Vec<(NodeId, SheetId, RowId, ColId)> = dirty_vec
  2156	            .iter()
  2157	            .filter_map(|&n| self.cell_address_for(n).map(|(s, r, c)| (n, s, r, c)))
  2158	            .collect();
  2159	
  2160	        let mut supplemental: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
  2161	        for &(f, fs, _, _) in &dirty_addrs {
  2162	            let ranges = self.graph.range_deps_for(f);
  2163	            if ranges.is_empty() {
  2164	                continue;
  2165	            }
  2166	            // W5-52 (audit closure, Sonnet MEDIUM): deduplicate G across
  2167	            // F's multiple ranges. Without this, a formula with two
  2168	            // overlapping ranges (e.g., SUM(A1:A10) + SUM(A1:A5)) that
  2169	            // both contain the same dirty G would push G twice into
  2170	            // `supplemental[F]`. Tarjan handles duplicate edges
  2171	            // correctly, but the Vec growth is wasted work — and this
  2172	            // gets worse as Phase 4.3 V2 adds multi-range functions.
  2173	            // `added.insert(g)` returns `true` on first add only.
  2174	            let mut added: HashSet<NodeId> = HashSet::new();
  2175	            for range in ranges {
  2176	                let resolved_sheet = Graph::range_ref_sheet(range).unwrap_or(fs);
  2177	                for &(g, gs, gr, gc) in &dirty_addrs {
  2178	                    if gs != resolved_sheet {
  2179	                        continue;
  2180	                    }
  2181	                    if range_contains_rowcol(range, gr, gc) && added.insert(g) {
  2182	                        supplemental.entry(f).or_default().push(g);
  2183	                    }
  2184	                }
  2185	            }
  2186	        }
  2187	        supplemental
  2188	    }
  2189	}
  2190	

codex
1. HIGH — `quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:201`, `quantbook-engine/crates/ql-exec/src/session.rs:877`, `quantbook-engine/crates/ql-exec/src/session.rs:2227`  
   Trigger: ordinary `recalc_all()` and undo/redo rematerialization both call `recompute_all()`, which now always preserves UDF values when no worker exists. That is not load-only. A user can open a saved UDF value without a worker, edit an input, then call `recalcAll`; the stale saved UDF value is kept instead of becoming `#CALC!`.  
   Fix: split `recompute_all` into an explicit load-preserving mode and a normal recompute mode. `open`/raw load can pass `true`; user `recalc_all` and most rematerialize paths should not blindly preserve.

2. HIGH — `quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:871` plus qbook persistence behavior at `quantbook-engine/crates/ql-io/src/qbook_format.rs:1424` and `:4050`  
   Trigger: saved UDF spills cannot be preserved by the D2 early return. `.qbook` intentionally skips spill target cells and does not reload `SpillAnchorTable`; only the anchor cached value survives. Opening `=MYUDF(A1)` that previously spilled `{10;20}` with no worker leaves the anchor as `10`, target cell blank, and no spill registration.  
   Fix: either persist enough spill shape/target cache to restore saved UDF spills, or do not claim spill preservation without a worker. A safe fallback is to mark the anchor `#CALC!` for array-returning UDFs when no worker can re-materialize the spill.

3. MEDIUM — `quantbook-engine/crates/ql-exec/src/session.rs:1255`, `quantbook-engine/crates/ql-exec/src/xlsx_recompute.rs:38`  
   Trigger: XLSX import recomputes before the session worker is preserved/restored, and `EngineXlsxRecomputer` uses `WorkbookRuntime::new`, which has no UDF worker. A session with a live worker importing an XLSX containing registered UDF formulas keeps the XLSX cached values instead of recomputing through the live worker.  
   Fix: make the XLSX recomputer carry the session’s worker, or adopt first, restore the worker, then run a session runtime recompute.

4. MEDIUM — `quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:875`  
   Trigger: D2 reads `workbook.read(addr)`, not the formula computed lane. For XLSX raw load, formula cached values are written via `put_at` before `put_formula`, so `read()` can return a user-overlay value. Later `put_computed_at` does not clear that user overlay, so stale cached values can mask future recomputes.  
   Fix: read the computed/formula-output lane directly, or normalize imported formula cached values into the computed lane and clear user overlays before recompute writes.

5. HIGH — `quantbook-engine/crates/ql-bindings-node/src/lib.rs:4933`, `quantbook-engine/crates/ql-exec/src/session.rs:423`, `quantbook-engine/crates/ql-exec/src/session.rs:1421`  
   Trigger: `setUdfWorker` has no lifecycle gate, and `close()` does not drop the worker. `close(); setUdfWorker(validConfig)` can spawn and install a Python child into a Closed session; `setUdfWorker` racing with `close` has the same issue because startup happens outside the lock.  
   Fix: add a checked `WorkbookSession::set_udf_worker` that calls `ensure_ready`, re-check under the lock after spawn, and clear/shutdown `udf_worker` in `close()`.

6. LOW — `quantbook-engine/crates/ql-bindings-node/src/lib.rs:4946`  
   Trigger: `handshakeTimeoutMs` accepts any non-negative finite `f64` and casts with `as u64`. Fractional values truncate, and huge finite values saturate into effectively unbounded waits.  
   Fix: require an integer JS number within a documented range, preferably also capped to a sane maximum.

7. LOW — `quantbook-engine/crates/ql-exec/src/transaction.rs:429`  
   Trigger: `WorkbookTransaction` still uses `with_formula_cell_and_worker`, so UDF failures in that transaction path emit only cell values, no `CellDiagnostic`. This is a silent gap if any caller uses `WorkbookRuntime::transaction()` expecting the new G diagnostic behavior.  
   Fix: thread `Option<&RefCell<Vec<UdfCellDiagnostic>>>` into `WorkbookTransaction` and use `with_formula_cell_worker_and_diagnostics`.

No concrete C1 registration/cleanup defect found: literal ranges use the existing range-dep stripe path and rebind cleanup clears it. No normal-path G borrow/drain panic found in `with_runtime`/`with_runtime_no_oplog`. The C1 test is actually non-volatile; the D test is too narrow because it only covers scalar `.qbook open`, not spills, `recalcAll`, undo/redo, or XLSX.
tokens used
266,875
1. HIGH — `quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:201`, `quantbook-engine/crates/ql-exec/src/session.rs:877`, `quantbook-engine/crates/ql-exec/src/session.rs:2227`  
   Trigger: ordinary `recalc_all()` and undo/redo rematerialization both call `recompute_all()`, which now always preserves UDF values when no worker exists. That is not load-only. A user can open a saved UDF value without a worker, edit an input, then call `recalcAll`; the stale saved UDF value is kept instead of becoming `#CALC!`.  
   Fix: split `recompute_all` into an explicit load-preserving mode and a normal recompute mode. `open`/raw load can pass `true`; user `recalc_all` and most rematerialize paths should not blindly preserve.

2. HIGH — `quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:871` plus qbook persistence behavior at `quantbook-engine/crates/ql-io/src/qbook_format.rs:1424` and `:4050`  
   Trigger: saved UDF spills cannot be preserved by the D2 early return. `.qbook` intentionally skips spill target cells and does not reload `SpillAnchorTable`; only the anchor cached value survives. Opening `=MYUDF(A1)` that previously spilled `{10;20}` with no worker leaves the anchor as `10`, target cell blank, and no spill registration.  
   Fix: either persist enough spill shape/target cache to restore saved UDF spills, or do not claim spill preservation without a worker. A safe fallback is to mark the anchor `#CALC!` for array-returning UDFs when no worker can re-materialize the spill.

3. MEDIUM — `quantbook-engine/crates/ql-exec/src/session.rs:1255`, `quantbook-engine/crates/ql-exec/src/xlsx_recompute.rs:38`  
   Trigger: XLSX import recomputes before the session worker is preserved/restored, and `EngineXlsxRecomputer` uses `WorkbookRuntime::new`, which has no UDF worker. A session with a live worker importing an XLSX containing registered UDF formulas keeps the XLSX cached values instead of recomputing through the live worker.  
   Fix: make the XLSX recomputer carry the session’s worker, or adopt first, restore the worker, then run a session runtime recompute.

4. MEDIUM — `quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:875`  
   Trigger: D2 reads `workbook.read(addr)`, not the formula computed lane. For XLSX raw load, formula cached values are written via `put_at` before `put_formula`, so `read()` can return a user-overlay value. Later `put_computed_at` does not clear that user overlay, so stale cached values can mask future recomputes.  
   Fix: read the computed/formula-output lane directly, or normalize imported formula cached values into the computed lane and clear user overlays before recompute writes.

5. HIGH — `quantbook-engine/crates/ql-bindings-node/src/lib.rs:4933`, `quantbook-engine/crates/ql-exec/src/session.rs:423`, `quantbook-engine/crates/ql-exec/src/session.rs:1421`  
   Trigger: `setUdfWorker` has no lifecycle gate, and `close()` does not drop the worker. `close(); setUdfWorker(validConfig)` can spawn and install a Python child into a Closed session; `setUdfWorker` racing with `close` has the same issue because startup happens outside the lock.  
   Fix: add a checked `WorkbookSession::set_udf_worker` that calls `ensure_ready`, re-check under the lock after spawn, and clear/shutdown `udf_worker` in `close()`.

6. LOW — `quantbook-engine/crates/ql-bindings-node/src/lib.rs:4946`  
   Trigger: `handshakeTimeoutMs` accepts any non-negative finite `f64` and casts with `as u64`. Fractional values truncate, and huge finite values saturate into effectively unbounded waits.  
   Fix: require an integer JS number within a documented range, preferably also capped to a sane maximum.

7. LOW — `quantbook-engine/crates/ql-exec/src/transaction.rs:429`  
   Trigger: `WorkbookTransaction` still uses `with_formula_cell_and_worker`, so UDF failures in that transaction path emit only cell values, no `CellDiagnostic`. This is a silent gap if any caller uses `WorkbookRuntime::transaction()` expecting the new G diagnostic behavior.  
   Fix: thread `Option<&RefCell<Vec<UdfCellDiagnostic>>>` into `WorkbookTransaction` and use `with_formula_cell_worker_and_diagnostics`.

No concrete C1 registration/cleanup defect found: literal ranges use the existing range-dep stripe path and rebind cleanup clears it. No normal-path G borrow/drain panic found in `with_runtime`/`with_runtime_no_oplog`. The C1 test is actually non-volatile; the D test is too narrow because it only covers scalar `.qbook open`, not spills, `recalcAll`, undo/redo, or XLSX.
