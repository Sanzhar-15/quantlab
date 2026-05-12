# Known engine gaps — checklist with target phases

**Status:** Living document, updated at each phase boundary  
**Date last touched:** 2026-05-12 (Engine Phase 2B.1 close-out)  
**Companion:** `docs/MASTER-PLAN.md`

Every gap below carries a target Engine phase per `docs/MASTER-PLAN.md`. When a gap is closed, move its row to the "Closed" section at the bottom and reference the closing commit.

## Open gaps (post-Phase 2A.3)

### Runtime / evaluation

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-R-01 | `recompute_all` walks formulas in `HashMap`-arbitrary order; dependency chains may compute stale values mid-recompute | `ql-exec/src/workbook_runtime.rs:316-345` — see comment "Iteration order is HashMap-arbitrary" | Engine | Engine Phase 3 (graph-driven recompute) |
| GAP-R-02 | `recompute_all` short-circuits on first failure (no partial-state visibility, no per-cell error tracking) | `ql-exec/src/workbook_runtime.rs::recompute_all` returns `Result<usize, RuntimeError>` | Engine | Engine Phase 2B.2 (`RecomputeResult` contract) |
| GAP-R-03 | Bind-plan re-derived from formula text on every recompute (lex + parse + bind cost paid N times) | `ql-exec/src/workbook_runtime.rs::recompute_all` calls `lex` → `parse` → `bind_with_names` per formula | Engine | Engine Phase 2B.3 (bind-plan cache V0) |
| GAP-R-04 | Volatile functions (`NOW`, `RAND`, `TODAY`) parse but have no invalidation model | `ql-functions/src/registry.rs` registers volatile fns; no dirty propagation on recompute cycle | Engine | Engine Phase 3.7 (volatile invalidation) |
| GAP-R-05 | Value-equality short-circuit not implemented; unchanged upstream still dirties downstream | None — pure missing optimization | Engine | Engine Phase 3.8 |

### Bind / semantics

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-B-01 | Named-range targets in aggregate context (`SUM(Sales)`) surface as `BindError::UnsupportedVariant` | `ql-exec/src/workbook_runtime.rs::tests::set_formula_named_range_target_unsupported` | Engine | Engine Phase 2B.4 (aggregate context prep) → Phase 3.6 (aggregate cache) |
| GAP-B-02 | Named-formula targets (`Profit = Revenue - Costs`) — same `UnsupportedVariant` | None tested yet; parser doesn't even encounter | Engine | Engine Phase 4 |
| GAP-B-03 | Sheet-scoped names (`Sheet1!Local`) — NameTable has no per-sheet scope | `ql-storage/src/workbook.rs::NameTable` is workbook-flat | Engine | Engine Phase 4.6 |
| GAP-B-04 | Cross-sheet cell references (`Sheet2!A1`) — parser supports, binder does not resolve | `ql-formula-syntax::Expr::CellRef` carries sheet id but binder ignores cross-sheet at eval | Engine | Engine Phase 4.6 |
| GAP-B-05 | Bare range as scalar operand (`A1:A10`) surfaces as `UnsupportedVariant` — correct in scalar context, wrong if aggregate caller | `ql-exec/src/workbook_runtime.rs::tests::set_formula_named_range_target_unsupported` | Engine | Engine Phase 4.7 (array context) |

### Op log

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-O-01 | `Workbook::set_name` mutation bypasses op log | `ql-storage/src/workbook.rs::set_name`; runtime has no wrapper | Engine | Engine Phase 2B.5 (op-log producer coverage audit) |
| GAP-O-02 | `Workbook::add_sheet` mutation bypasses op log | `ql-storage/src/workbook.rs::add_sheet`; runtime has no wrapper | Engine | Engine Phase 2B.5 |
| GAP-O-03 | Direct `Workbook::put_at` callable from product code; bypasses op log | All product paths SHOULD go through `WorkbookRuntime::set_value`, but `put_at` is `pub` | Engine | Engine Phase 2B.5 |
| GAP-O-04 | `set_value(Value::Blank)` emits no `PutValue` (CellWireValue lacks Blank variant) — documented limitation | `ql-exec/src/workbook_runtime.rs::set_value` comment cites this | Engine | Engine Phase 5 (CRDT model) or earlier if forced |
| GAP-O-05 | NaN / Inf in `PutValue` — `serde_json` refuses; surfaces as `RuntimeError::OpLog` | `ql-oplog/src/log.rs::append` serialization path | Engine | Engine Phase 5 or earlier |

### Storage

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-S-01 | Single overlay per chunk (user + formula outputs share state) | `ql-storage/src/column.rs::SparseOverlay` is a single map | Engine | Engine Phase 3.5 (computed-overlay separation, CORR-25) |
| GAP-S-02 | Float64-only base lane; no Boolean/Text/Error/DateTime column types | `ql-storage/src/column.rs::ColumnStore` holds `Vec<ArrayRef>` typed Float64 | Engine | Engine Phase 4.5 (date/time + format) onward, finalized in Phase 4 |
| GAP-S-03 | No type-tag byte per row; cell type comes from `Value` overlay only | Same — base array is Float64, overlay is `Value` | Engine | Engine Phase 4 (mixed types) |
| GAP-S-04 | No table metadata in storage; `Table[Column]` parse → bind path absent | `ql-storage` has no `Table` type | Engine | Engine Phase 4.8 (tables + structured refs) |
| GAP-S-05 | No styles / formatting / conditional formatting in storage | None — feature absent | Engine | Engine Phase 4 (formatting) + Canonical Phase 7 (UI) |

### Persistence

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-P-01 | Plain `save_workbook` (no oplog) drops existing `oplog.bin` if present in target — documented behavior | `ql-oplog/src/persistence.rs::tests::save_workbook_without_oplog_drops_existing_oplog_bin` | Engine | Documented limitation; revisit if IDE forces preservation policy |
| GAP-P-02 | xlsx import / export not implemented (stub crates only) | `ql-io-xlsx`, `ql-io-ods` are 15-line stubs | Engine | Engine Phase 4.11 (xlsx) + post-v1 (ods) |
| GAP-P-03 | NamedTarget::Constant(Value::Blank) wire-format ambiguity (conflates with formula-Pending) — cycle-3 audit M7 deferred | `ql-io/src/qbook_format.rs::NamedTargetWire::Constant` | Engine | Engine Phase 4 (when wire format gets a freeze pass) |
| GAP-P-04 | Concurrent save-from-two-processes — only temp-suffix isolation; no inter-process file locking | `ql-io/src/qbook_format.rs::save_session_suffix` | Engine | Post-v1 unless real users hit it |

### Function library

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-F-01 | 22 of ~260 v1 target functions implemented (8.4%) | `ql-functions/src/registry.rs::default_registry` count | Engine | Engine Phase 4.3 (wave 1, 100 fns) + 4.10 (wave 2, 260) |
| GAP-F-02 | `IF` / `IFERROR` evaluate both branches eagerly (no lazy arg semantics) | `ql-functions/src/registry.rs` — no lazy arg support; megaudit M7 deferred | Engine | Engine Phase 4.3 |
| GAP-F-03 | No Excel compatibility matrix (functions, coercions, errors, dates) | Doc absence | Engine | Engine Phase 4.2 (matrix harness) |
| GAP-F-04 | No NIST `numacc4` extreme test fixture for Welford stats | `ql-functions/src/welford.rs` covers numacc3 only | Engine | Post-v1 stats hardening |

### Parser / syntax

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-X-01 | IronCalc parser never deep-read; expansion into structured refs / R1C1 / array literals / localization is unjustified without it | `docs/phase0/references-reading-log.md:530` (CORR-20) | Engine | Engine Phase 4.1 (IronCalc read + parser gap matrix) BEFORE any parser expansion |
| GAP-X-02 | Array formulas / spill anchors — AST has `Expr::Array` and `Expr::Spill` placeholders, no implementation | `ql-formula-syntax/src/ast.rs` placeholder variants | Engine | Engine Phase 4.7 |
| GAP-X-03 | Structured references (`Table[Column]`) not parsed | No lexer support; depends on GAP-S-04 | Engine | Engine Phase 4.8 |
| GAP-X-04 | R1C1 mode not supported | No mode flag in parser | Engine | Engine Phase 4.9 |
| GAP-X-05 | Localization (separators, function names) not supported | Hardcoded `,` / English fn names | Engine | Engine Phase 4.9 |
| GAP-X-06 | Implicit intersection not implemented | Excel-canon feature absent | Engine | Engine Phase 4.9 |

### Collaboration

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-C-01 | Loro op log is single-writer history, not multi-user CRDT state | `ql-oplog/src/log.rs` is append-only log only | Engine | Engine Phase 5.1 (collab data model decision) |
| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
| GAP-C-03 | `ql-collab` is a 15-line stub | `ql-collab/src/lib.rs` | Engine | Engine Phase 5.2 |
| GAP-C-04 | No undo/redo model defined; transactions exist but command grouping is informal | `ql-exec/src/transaction.rs` doesn't expose inverse ops | Engine | Engine Phase 5.4 |
| GAP-C-05 | No transport layer (WebSocket / offline sync) | Stub crate `ql-collab` empty | Engine | Engine Phase 5.5 |

### Product surfaces

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-PS-01 | `quantbook-py` Python binding stub only | `quantbook-py/src/lib.rs:15` | Engine | Engine Phase 6.3 |
| GAP-PS-02 | `ql-bindings-{wasm,node,c}` stubs only | Three stub crates | Engine | Engine Phase 6.3 |
| GAP-PS-03 | `ql-udf` (Python UDF execution) stub | `ql-udf/src/lib.rs:15` | Engine | Engine Phase 6.4 |
| GAP-PS-04 | `ql-sql` (DuckDB integration, `=DUCKDB(...)`) stub | `ql-sql/src/lib.rs` | Engine | Engine Phase 6.5 |
| GAP-PS-05 | `ql-connectors` (external data refresh) stub | `ql-connectors/src/lib.rs:15` | Engine | Engine Phase 6.5 |
| GAP-PS-06 | `ql-ai` (real AI() provider) stub; `AI()` returns AINotAvailable sentinel | `ql-ai/src/lib.rs:15`; `ql-functions::registry::AI` returns `Value::Error(ErrorValue::AINotAvailable)` | Engine | Engine Phase 6.6 |
| GAP-PS-07 | `ql-service` (engine-as-service transport) stub | `ql-service/src/lib.rs` | Engine | Engine Phase 6.2 |
| GAP-PS-08 | `ql-terminal` crate exists; product fit unclear (terminal-side surface for Delta Plus?) | `ql-terminal/src/lib.rs` | Product | Decide by Phase 6 entry |

### IDE integration

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-I-01 | `extensions/quantlab/` has never been exercised against the engine | No vertical-slice test exists | Engine + IDE | Engine Phase 2B.6 (first slice) |
| GAP-I-02 | No engine-side test harness simulating IDE consumption (paste-of-1000, edit-cancel, error display) | Absence | Engine | Engine Phase 2B.6 |
| GAP-I-03 | Diagnostic shape not designed for IDE consumption (lex/parse/bind/recompute errors are typed but not formatted for end-user display) | `RuntimeError::Display` outputs are dev-facing | Engine | Engine Phase 2B.6 + Phase 7.4 (IDE polish) |

### Documentation

| ID | Gap | Reproduce | Owner | Target phase |
|---|---|---|---|---|
| GAP-D-01 | Phase 2 docs had STALE wording about 2A.3 being deferred — banner-patched but not rewritten | `docs/phase2/{entry-plan,exit-packet}.md` banners | Engine | Closed as banner; full rewrite if needed in Engine Phase 2B exit |
| GAP-D-02 | Phase 3 / 4 / 5 / 6 / 7 `entry-plan.md` and `exit-packet.md` don't exist yet | Files absent under `docs/phase{3,4,5,6,7}/` | Engine | Created per phase as work begins |
| GAP-D-03 | No `docs/architecture/` directory; calcgraph-runtime, parser-and-semantics, collaboration-crdt all referenced in MASTER-PLAN.md but don't exist | Files absent | Engine | Each created when its phase begins |
| GAP-D-04 | Excel compatibility matrix (`docs/compat/excel-matrix.md`) doesn't exist | File absent | Engine | Engine Phase 4.2 |
| GAP-D-05 | Legal / provenance notes for adopted reference patterns not collected | `docs/legal/` absent | Engine | Engine Phase 7 ship prep |

## Closed gaps

(none yet — populate as gaps are closed and reference the closing commit.)

---

## How to use this doc

- **Adding a gap:** new row in the relevant section. Always include reproduce path + target Engine phase.
- **Closing a gap:** move the row to `Closed gaps` with closing commit SHA + date.
- **At every phase exit:** sweep this list, move closed items, add any new ones surfaced during the phase.
- **No gap stays untargeted.** If a gap can't fit any planned phase, that's a planning problem — escalate to MASTER-PLAN.md edit.
