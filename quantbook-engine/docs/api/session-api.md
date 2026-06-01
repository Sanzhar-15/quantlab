# Engine Session API — Stable Contract (Phase 6.1A)

> ## 🔒 FROZEN v1 — 2026-05-31 (Phase 6.3-5 exit gate)
> The `EngineSession` binding contract is **FROZEN v1** as of 6.3-5. Its DTO shapes
> (field names + camelCase keys), the `EngineError` taxonomy + structured-error
> own-properties (`code`/`class`/`retryable`/`details`/`source`), the **u64 = decimal
> string** wire encoding (§4.2), the `OperationState.Failed.error` nested-object shape
> (§ below), and the `Buffer`/`BigInt` conventions are a forward-compatibility
> commitment: additive changes only; any breaking change requires a new schema version.
> **Basis for the freeze:** ≥2 structurally-different binding rows (Node napi + the
> thin `quantbook-py` pyo3 facade) pass one canonical 22-step golden flow byte-identical
> (`crates/quantbook-py/tests/parity_matrix.py` — PARITY OK, now 23 steps incl. the
> deterministic unmasked u64 witness), plus a 3-lane closure megaudit (Codex + engine
> Opus + IDE-aware Opus) clean after fold-all
> (`docs/audits/2026-05-31-6-3-5-closure-megaudit/`). WASM/C rows are v1.5-deferred
> (decision-lock §2 item 8) and add a matrix row when built — purely additive.

**Status:** ✅ v2 — REVISED 2026-05-26 after the Codex 6.1A contract review (gpt-5.5 xhigh,
verdict REVISE → all 5 HIGH / 5 MED / 2 LOW / 1 INFO resolved in this revision). Full review:
`docs/api/codex-6-1a-review.md`. This is the API6-01 deliverable — the contract **6.1B**
(`WorkbookSession`) implements, **6.3** bindings bind to, and **6.2** service exposes — and the gate
document for the mandatory **6.1C** security/design audit.

**Basis:** Phase 6 decision-lock (`docs/phase6/decision-lock.md`) §3/§4/§5 + MASTER-PLAN §725-790.

**What is proven-now vs new (INFO-1 — do not under/over-state implementation risk):**
- **Proven / extracted from real code now:** cell/sheet/format/name/table edits, full + delta
  snapshots, `.qbook` persistence, the `[kind]` error-code workaround, the `flushPendingToTransport`
  detach pattern, the single-writer `WorkbookRuntime` compute path (`recompute_all`/`recompute_dirty`).
- **New in 6.1B (must be built):** the `EngineSession` trait, the owning `WorkbookSession`, the
  cancellation registry + operation lifecycle, the event/diagnostic queue, the `Busy`/`Faulted`
  lifecycle states, the common `EngineError`, session-owned `PlanCache`, and fail-loud single-writer
  `delete/restore/move sheet` wrappers.
- **New in 6.4-0:** `FunctionMetadata` + the graph metadata derivation (`functions_used` reverse
  index, registration invalidation).

**Scope discipline (load-bearing):** this contract defines the **product session** — a *single-writer*
owning session (`WorkbookSession`) around `WorkbookRuntime` + a **mandatory single-writer `OpLog`**
(see §4.0). The multi-user **collaborative layer** (`CollabSession` CRDT *merge* / transport / presence
/ cross-peer undo-group) is **v1.5-deferred** (Engine Phase 5 = Product Phase 9) and rides *on top of
the same op-log*. The existing napi surface is `CollabSession` because the IDE vertical slice was built
on collab; 6.1B **re-founds the command shapes on `WorkbookSession`** — do **not** freeze the
`CollabSession` CRDT surface as the stable contract (decision-lock §1 D1).

---

## 0. Acceptance criteria

| ID | Criterion (MASTER-PLAN §730) | Where addressed |
|----|------------------------------|-----------------|
| **API6-01** | One Rust trait/API backs all bindings | §2 (trait), §3 (commands), §11 (per-binding obligations + golden-flow matrix) |
| **API6-02** | Cancellation is first-class | §6 (operation lifecycle + scoped cancellation guarantees) |
| **API6-03** | Errors are structured | §5 + Appendix A (variant→code mapping) |

---

## 1. Design principles

1. **One contract, many transports.** The session is a Rust trait (`EngineSession`) + versioned DTOs.
   Bindings (Node/WASM/C/Python) and the service (HTTP/gRPC) are thin adapters marshalling the same
   DTOs and mapping the same `EngineError`. No binding invents its own command/error/event semantics.
2. **Transport-neutral** (decision-lock §1 D2): no napi-only/HTTP-only/gRPC-only assumption. IDs,
   version tokens, cancellation handles, error envelopes are plain owned data. The HTTP-vs-gRPC pick
   was DECIDED 2026-06-01 — **HTTP/1.1 + SSE on hyper** (`ql-service`, Phase 6.2; see §13). Transport
   neutrality still holds (a future gRPC adapter would marshal the same DTOs).
3. **Opaque handles, owned results.** FFI holds an opaque session handle. **No borrowed Rust ref
   crosses FFI** (this is why §3.4 uses an opaque transaction *handle*, not an RAII scope). Results are
   owned snapshots/buffers/Arrow handles with explicit release; version tokens + operation IDs are
   opaque blobs the caller round-trips without interpreting.
4. **Bottom-up, then trimmed** — extracted from the IDE-exercised napi workflows, generalized, and
   extended with the cancellation/diagnostics/function-metadata machinery v1 product surfaces need.
5. **Errors are visible, never swallowed** (project No-Fallbacks rule): every fallible command returns
   `Result<_, EngineError>`. The **only** structured "recovery" signal is `full_rebuild_required`, and
   it is locked to an enumerated set of legitimate delta-cache states (§4.3) — a *malformed* token is a
   **fail-loud `Protocol` error**, never a silent resync (MED-2).
6. **Shape the future now** (decision-lock §5): event/diagnostic/provenance/operation-state DTOs +
   the bulk publish/bind/materialize command *shapes* (§3.5) are versioned and reserved in 6.1 so
   UDF/SQL/AI extend an existing contract rather than fork it.

---

## 2. Ownership & lifetime model

### 2.1 The owning session (`WorkbookSession`)

The engine already anticipates this consolidation — `crates/ql-exec/src/calcgraph_session.rs:69-71`:

> *"Phase 6.1 `WorkbookSession` will absorb Workbook + OpLog + CalcgraphSession + PlanCache +
> FunctionRegistry into ONE owning struct that the binding crate can wrap cleanly (per GAP-PS-09)."*

`WorkbookSession` (built in 6.1B) **owns**:

| Owned component | Source today | Role |
|-----------------|--------------|------|
| `Workbook` | `ql-storage` | Cell/sheet/table/name/format storage |
| `OpLog` (**mandatory, single-writer** — §4.0) | `ql-oplog` | Edit history → version token, undo/redo, save/load |
| `CalcgraphSession` | `ql-exec/src/calcgraph_session.rs` | Dependency graph + dirty propagation |
| `PlanCache` | `ql-exec` | Compiled formula plans — **see LOW-1 below** |
| `FunctionRegistry` (+ `FunctionMetadata`, §10) | `ql-functions/src/registry.rs` | Built-in + custom (UDF) dispatch + metadata |
| **Cancellation registry** *(new)* | — | op-id → token/deadline/terminal-state (§6) |
| **Event queue** *(new)* | — | structured diagnostics/events (§9) |

Today these are constructed per-edit via `WorkbookRuntime::with_oplog_and_graph(...)` (a per-edit
borrow window). 6.1B inverts it: the session owns them; the per-edit `WorkbookRuntime` borrow is
constructed *internally* so it never crosses FFI.

**LOW-1 — `PlanCache` is an explicit 6.1B refactor, not free.** `WorkbookRuntime::new` /
`with_oplog_and_graph` (`workbook_runtime/mod.rs:140/162/225`) each allocate a *fresh private*
`plan_cache`. Constructing a runtime per command would reset the cache and make `cache_stats`
meaningless. 6.1B MUST refactor `WorkbookRuntime` to borrow a **session-owned** `PlanCache` (or move
the runtime methods onto `WorkbookSession`). This is flagged work, not an emergent property.

### 2.2 FFI handle contract

- A binding holds an **opaque handle** to a `WorkbookSession` (Node: `#[napi]` over
  `Arc<Mutex<WorkbookSession>>`; C: opaque ptr + `qb_session_free`; WASM: JS handle; Python: PyO3
  class). **No method returns a borrowed Rust ref across FFI.** Tabular results are owned buffers or
  Arrow `RecordBatch` handles with explicit release (C: `qb_release_*`; managed: GC).
  - **✅ Node realized (6.1B inc.2d, 2026-05-28):** `ql-bindings-node` exposes the **`Session`** `#[napi]`
    class over `Arc<parking_lot::Mutex<ql_exec::WorkbookSession>>` (the smoke surface: `new`/`addSheet`/
    `setValue`/`setFormula`/`clear`/`recalcDirty`/`recalcAll`/`snapshot`/`cell`/`listSheets`), proving
    this contract over FFI (edit→recalc→snapshot smoke passes). `WorkbookSession: Send` is compile-proven;
    every method returns owned data (no guard/ref escapes); `EngineError` maps via `engine_error_to_napi`
    (`"[code] message"`). The richer surface (batch/txn/import/export/undo/delta, register_function) is the
    6.3 follow-up.
  - **✅ IDE consumer wiring realized (cross-repo, 2026-05-28, IDE `feat/visualise-v1` `c24222315ed`):**
    the VS Code fork now consumes the `Session` class through its real Node load path —
    `extensions/quantlab/src/quantbook/{types.ts,loader.ts,session.ts}` (typed `SessionInstance`, a
    `Session` fail-at-boundary shape-check in `loadQuantbookEngine()`, a `createWorkbookSession()`
    factory) + a mocha suite (`test/quantbook-session.test.ts`) proving edit→recalc→snapshot through
    `loadQuantbookEngine()`. The rebuilt cdylib also made the source-only `CollabSession` fixes B#1 +
    S2-01 live, now backed by regression tests. Full IDE suite 1435/0/25. Synthesis
    `docs/audits/2026-05-28-6-1b-ide-node-migration/`. **Driving the live `CellGridPanel` off `Session`
    stays deferred** (the panel needs `workbookSnapshotDelta`/presence/transport, none yet on `Session`).
- Long-running / multi-call state (transactions §3.4, operations §6) is referenced by **opaque IDs**,
  never by a borrowed runtime object.

### 2.3 Lifecycle states

```
New ──open/import──▶ Ready ──(edit/recalc/query)──▶ Ready
  │                    │  ╲
  │                    │   ╲──start long op──▶ Busy ──(complete/cancel)──▶ Ready
  │                    ├──save/export──▶ Ready (persisted)
  │                    └──close────────▶ Closed (terminal)
  └──(error before Ready)──▶ Faulted (terminal; only diagnostics + close)
```

- **`Busy`** *(new — HIGH-1)*: the session is executing a long operation that owns mutable engine
  state (in-engine recalc, a staged op). Commands that mutate or recalc are rejected with
  `EngineError{class:Lifecycle, code:"session_busy", details:{op_id}}`; read-only snapshot/query of the
  *last committed* state and `cancel(op_id)`/`operation_status(op_id)` remain legal. This is what makes
  the cancellation/lock story implementable over the synchronous compute core (§6/§7).
- **`Closed`/`Faulted`** are terminal. Illegal-state calls return `Lifecycle`/`invalid_state`, never panic.

---

## 3. Command surface

Product commands (not collab `Op` variants — decision-lock §3.2). **v1** = in the 6.1 lock;
**v1.5** = collab-only, deferred; **reserved** = shape locked now, implemented in 6.4/6.5.

### 3.1 Lifecycle / persistence
| Command | Tier | Backed by |
|---------|------|-----------|
| `new(options)` | v1 | `WorkbookRuntime::new` + fresh `OpLog` |
| `open(path)` | v1 ✅ (inc.2c-9) | `ql_io::load_workbook_with_oplog` → **Option 1**: reconstruct the workbook from the `.qbook` envelope, adopt with a FRESH op-log + undo history (`baseline = loaded wb`), recompute on open (saved computed values may be stale). The loaded op-log is validated (incl. per-op payloads) then **discarded** — its history is not carried (re-save writes only this session's edits). Legal in `New` **or** `Ready` (re-open replaces the document + re-mints the epoch → outstanding tokens force full rebuild). |
| `import(bytes, "xlsx")` | v1 ✅ (inc.2c-10) | `ql_io_xlsx::import_xlsx_bytes` (BestEffort recompute via the injected `EngineXlsxRecomputer` — `ql-io-xlsx` is pure I/O, the recompute is dependency-inverted) → **Option 1** adoption (same as `open`: fresh op-log/undo, registry preserved, epoch re-minted; no second recompute). Import-report fidelity caveats (dropped features from `feature_inventory`, soft warnings, formula recompute failures) surface as `Warning` diagnostics. |
| `import(bytes, "csv")` | v1 ✅ (inc.2c-11) | `ql_io_csv::import_csv_bytes` (pure-I/O leaf; type inference: empty→blank, TRUE/FALSE→bool, finite f64→number, else text; leading `=` stays text — injection-safe; UTF-8 + BOM-stripped; engine-limit-guarded) → **Option 1** adoption, **no recompute** (CSV has no formulas). |
| `import(bytes, other)` | `BadArgument` | unknown format → loud `BadArgument` |
| `save(path)` | v1 ✅ (inc.2c-9) | `ql_io::save_workbook_with_oplog(&wb, &oplog, name, path)`; workbook name derived from the path file-stem (no document-name metadata in v1; `None` → loud `BadArgument`). `&self`, legal in `Ready`/`Busy`. |
| `export("csv") -> bytes` | v1 ✅ (inc.2c-11) | `ql_io_csv::export_csv_bytes` — **single live sheet** only (`>1` → loud `BadArgument`, no silent sheet drop; `export` is `&self`, no warn channel); 0 sheets → empty bytes. Verbatim/value-only (cells via `Value` `Display`; no formula-trigger escaping). **M7 (6.3-2b):** uses `Sheet::effective_value_bounds` (the non-blank-value extent) — interior blanks preserved, trailing all-blank rows/cols trimmed (the one serializer whose OUTPUT was genuinely blank-inflated; xlsx/.qbook already skipped blank cells and only narrowed their iteration range / envelope footprint). |
| `export("xlsx") -> bytes` | v1 ✅ (inc.2c-12, feature `xlsx-write`) | `ql_io_xlsx::export_xlsx_bytes` (`NewWorkbook` mode; umya 2.2.0 `write_writer` → in-memory `Vec<u8>`, post-process pass in memory — no tempfile). Exports the **whole workbook** (xlsx is multi-sheet, unlike csv). The umya writer (+ its image/rav1e/exr/tiff codecs) is behind ql-io-xlsx's `write` feature; `ql-exec` depends `default-features = false` and gates this path on its own `xlsx-write` feature so the **default reader-only build (and WASM/bindings through it) stays lean**. Without the feature → honest `Capability/not_implemented_in_v1_core` (No-Fallbacks). `&self`, so export-fidelity caveats are not surfaced (same as csv); errors map via `map_xlsx_err` (Appendix A). |
| `export(other) -> bytes` | `BadArgument` | unknown format → loud `BadArgument` |
| `close()` | v1 | handle free → `Closed` |

### 3.2 Mutation — single edits
| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `set_value(addr, value)` | v1 | `WorkbookRuntime::set_value` ↔ `appendPutValue` | clears formula |
| `set_formula(addr, text)` | v1 | `set_formula` ↔ `appendPutFormula` | lex+parse+bind+eval; parse/bind failure → `Compute` error **or** `Diagnostic` (§5.5) |
| `clear(addr)` | v1 | `clear_formula` | per-field clear |
| `set_format(addr, format_id)` | v1 | `SetCellFormat` | |
| `register_format(format_string) -> format_id` | v1 | `RegisterFormat` | session-wide table |
| `validate_formula(addr, text) -> [Diagnostic]` | v1 | `WorkbookRuntime::validate_formula` | parse+bind, **no mutation** |

### 3.3 Mutation — structure (MED-3: explicit single-writer fail-loud semantics)
| Command | Tier | Backed by | v1 single-writer semantics (NOT the collab no-op/clamp) |
|---------|------|-----------|--------------------------------------------------------|
| `add_sheet(name, chunk_rows)` | v1 | `addSheet` | duplicate name → `Conflict`; invalid `chunk_rows` → `BadArgument` |
| `rename_sheet(id, name)` | v1 | `renameSheet` | unknown id → `NotFound`; duplicate name → `Conflict` |
| `delete_sheet(id)` | v1 | `deleteSheet` | unknown id → **`NotFound`** (storage `remove_sheet` `workbook.rs:749` silently no-ops — 6.1B MUST wrap fail-loud). Deletion is a **tombstone** (preserves cells for restore); document refs-to-deleted-sheet behavior (`#REF!` vs preserved) as a locked decision in 6.1B. |
| `restore_sheet(id)` | v1 | `restoreSheet` | not-tombstoned / unknown id → `NotFound`/`Conflict` (storage `restore_sheet` `:781` silently no-ops — wrap fail-loud) |
| `move_sheet(id, index)` | v1 | `moveSheet` | unknown id → `NotFound`; out-of-range index → **`BadArgument`** (storage `move_sheet` `:809` silently clamps — wrap fail-loud, do not inherit clamp) |
| `set_name(name, target)` | v1 | `SetName` / names | redefinition policy locked in 6.1B |
| table ops `create/rename/rename_column/resize/drop_table` | v1 (single-writer) | `workbook_runtime/tables.rs` | **single-writer only**; collaborative table-merge DEFERRED (Phase 5 EC#2 — no collaborative producer; a future one MUST land conflict-resolution + `removed_cells`) |

### 3.4 Batch / transaction (HIGH-3 — transport-neutral; atomicity defined per layer)
| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `batch(ops, options) -> BatchResult` | v1 | `WorkbookTransaction` + `Op::BatchCommit` | **Request-scoped, single call.** `options` = `{undo_group_id?, undo_label?}`. The whole batch is one undo unit. |
| `begin_transaction() -> txn_id` / `txn_add(txn_id, op)` / `commit_transaction(txn_id) -> result` / `rollback_transaction(txn_id)` | v1 | opaque handle owning **buffered DTOs** | For multi-call grouping. The handle owns buffered ops + an undo-group + optional deadline — **never** a borrowed `WorkbookTransaction<'_>` (`transaction.rs:80` holds `&mut Workbook`, which cannot cross FFI). |

**Atomicity, defined per layer (the word "atomic" was conflated):**
- **Validation + local commit:** all-or-nothing. The producer validates/buffers, appends
  `Op::BatchCommit` *before* mutating the workbook (`transaction.rs:293`), so an append/validation
  failure leaves the workbook unchanged. ✅ atomic.
- **Op-log append:** the `BatchCommit` op is a single atomic log entry. ✅ atomic.
- **Replay from a persisted log:** **NOT rollback-atomic.** `Op::BatchCommit` replay applies inner ops
  sequentially and returns on the first inner failure with no rollback of earlier inner effects
  (`crates/ql-oplog/src/replay.rs:889-895`). The contract states this **honestly**: replay is
  *fail-loud but not transactional*. (Making replay rollback-atomic requires staged/clone replay —
  out of v1 scope; tracked for the collaborative producer work.)
- **Undo grouping:** the batch is one undo unit.

**Multi-call transaction handle — v1 implementation (inc.2c-5, `WorkbookSession`):**
- The handle is a **pure `SessionOp` buffer holding NO engine borrow** (`txns:
  HashMap<TransactionId, Vec<SessionOp>>`). `begin_transaction` allocates an empty
  buffer; `txn_add` appends; `commit_transaction` drains it through the **same**
  `batch` machinery (so a transaction inherits batch's validation-atomicity, graph
  consistency, one `Op::BatchCommit`, single state tick, and the same-cell
  value/formula conflict guard — two value/formula ops on one cell →
  `conflicting_batch_ops` at commit); `rollback_transaction` drops the buffer.
- **No lock between `begin` and `commit`:** interleaved single edits / other
  transactions are permitted; the buffer is validated against the workbook state
  **at commit time** (a sheet deleted after `txn_add` → `sheet_not_found` at commit),
  not at add time. This is the no-borrow-across-FFI consequence (a borrowed
  `WorkbookTransaction<'_>` cannot cross FFI).
- **Lifecycle:** `begin`/`txn_add`/`commit` require `Ready` (forward progress →
  `invalid_state` on Busy/terminal). `rollback` is ungated (cleanup is always
  permitted). `close` drops all open buffers.
- **Failed commit leaves the transaction OPEN** (the buffer is restored): `batch`
  is validation-atomic, so a rejected commit applied nothing — the caller may
  fix-and-retry or `rollback`. A successful commit consumes the handle. Unknown
  handle → fail-loud `NotFound`/`transaction_not_found` (never a silent no-op).
- **v1 limitations:** `txns` grows unbounded if callers `begin` without
  commit/rollback (same as `ops`/`events`); `options.undo_label`/`undo_group` and
  optional deadline are accepted-but-not-yet-consumed (land with undo/redo).

### 3.5 Bulk data / publish / bind (HIGH-4 — reserved-stable shapes; implemented 6.4/6.5)
Reserved now so 6.4 (Python UDFs) and 6.5 (SQL/connectors) extend the shared trait instead of forking
product-specific APIs (the #1 risk). Dirtying + provenance behavior is part of the lock:

| Command | Tier | Purpose / dirtying |
|---------|------|--------------------|
| `write_range(range, values) -> WriteRangeResult` | **v1 ✅ (6.5-0)** | Bulk write a rectangular `Vec<Vec<CellValue>>` matrix; dirties dependents of the written range. **6.5-0:** validates the rectangle (inverted-range / out-of-grid / `1<<20`-cell cap / exact shape, all loud `bad_argument` pre-mutation), then lowers to one `SetValue` op per cell and applies via `batch` — so the whole write is ONE `Op::BatchCommit` (one undo unit; `undo` reverts the entire range) and the version token advances exactly once. `Blank` clears a cell. Returns `WriteRangeResult { written, version }`. (`options` deferred; Arrow-batch input form is a later increment.) |
| `publish_dataset(name, data, target, provenance) -> PublishedRef` | reserved (6.4) | `qb.publish()` — materialize a DataFrame/table into a sheet/table; dirties dependents; carries provenance (§9) |
| `bind_range(binding_id, target, schema, options) -> BoundRange` | reserved (6.4) | `qb.bind()` — overlay a `BoundFrame` onto a range/table; overlay edits dirty bound-range formulas |
| `refresh_source(source_id, revision) -> DirtyResult` | **v1 ✅ (6.5-2)** | **6.5-2:** re-runs the recorded `materialize_query` producer for `source_id` and re-materializes its result via the `write_range` substrate, dirtying dependents. Revision-gated: a `revision` ≤ the stored revision is a no-op. An unknown `source_id` (never materialized in this session) is a loud `source_not_found` (404; No-Fallbacks). Returns `DirtyResult { dirtied, version }`. Backed by the dual provenance index (per-cell `cell→{source_id, revision}` + per-source `source_id→produced cells`). |
| `materialize_query(query_id, target, data) -> PublishedRef` | **v1 ✅ (6.5-1)** | **6.5-1:** `data` = `{"sql": "<query>"}`. Runs the SQL OFF the hot path (DataFusion, via the pure `ql-sql` crate) over the workbook's tables (by display name, named columns) + sheets (by name, A1-letter columns over the effective value bounds), case-preserving identifiers. The result is written as a block anchored at `target`'s top-left via the `write_range` substrate (one `Op::BatchCommit`, dirties dependents); it must FIT within `target` (else loud `bad_argument`), a 0-row result writes nothing, and surplus target cells are untouched. Read-only: DDL/DML/statements are forbidden (no `COPY`/`CREATE EXTERNAL TABLE`/`SET`). Input + result are capped at 1<<20 cells/rows (loud over-cap). Returns `PublishedRef { id: query_id }`. **6.5-2:** records dual provenance (per-cell `cell→{source_id, revision}` + per-source `source_id→produced cells` reverse index) consumed by `refresh_source`. |

### 3.6 Query / snapshot (MED-5: `RangeResult` is a first-class DTO — see §4.2)
| Command | Tier | Backed by |
|---------|------|-----------|
| `query_range(range, options) -> RangeResult` | v1 | snapshot accessors / Arrow; **columnar**, dimensions explicit, value/formula/format inclusion via `options` (§4.2) |
| `snapshot() -> WorkbookSnapshot` | v1 | `workbookSnapshot` (`lib.rs:2141`); carries the opaque `version` token (§4.0) |
| `snapshot_delta(last_version) -> WorkbookSnapshotDelta` | v1 | `workbookSnapshotDelta` (`lib.rs:2498`); `full_rebuild_required` rules in §4.3 |
| `cell(addr) -> CellSnapshot?` | v1 | `snapshot_cell` |
| `list_sheets() -> [SheetInfo]` | v1 | `listSheets` |

### 3.7 Recalculation (HIGH-1 — cancellation scoped honestly; see §6)
| Command | Tier | Backed by | v1 cancellation |
|---------|------|-----------|-----------------|
| `recalc_dirty() -> op_id` | v1 | `WorkbookRuntime::recompute_dirty` (synchronous, Tarjan-SCC) | **pre-start cancel only** in v1 (§6.4) — convenience = `start_recalc(Dirty)`+`await_recalc` in one call (no window) |
| `recalc_all() -> op_id` | v1 | `WorkbookRuntime::recompute_all` (synchronous) | **pre-start cancel only** in v1 (§6.4) — convenience = `start_recalc(All)`+`await_recalc` |
| `start_recalc(kind) -> op_id` | v1 | reserve-only (no compute) | **M2 (6.3-1b) SHIPPED.** Returns the op-id, sets `Busy`, opens the pre-start cancel window; the lock releases so `cancel(op)` can land before `await_recalc` (§6.4). |
| `await_recalc(op)` | v1 | `WorkbookRuntime::recompute_*` via the shared executor | **M2 (6.3-1b) SHIPPED.** Runs the reserved recalc, or SKIPS it (op → `Canceled`) if a `cancel` won the window; rejects a terminal session (`invalid_state`). |
| `mark_volatiles_dirty()` | v1 | volatile pass (`calcgraph_session.rs:149`) | — |

### 3.8 Undo / redo (MED-4 — explicit v1 commands)
| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `undo() -> UndoResult{consumed, op_id?, version}` | v1 | `CollabSession::undo` (`lib.rs:1888`) | empty stack → `consumed:false` (NOT an error); **clears the delta cache** (force full rebuild next snapshot_delta) |
| `redo() -> RedoResult{consumed, op_id?, version}` | v1 | `redo` (`lib.rs:1901`) | same |
| `can_undo() -> bool` / `can_redo() -> bool` | v1 | stack depth | for product UI |

*(Single-writer undo is v1; cross-peer undo-group **merge** semantics are the v1.5 part.)*

**Implemented in `WorkbookSession` (inc.2c-7).** A long-lived `loro::UndoManager` field (built in
`from_workbook`, `set_merge_interval(0)` → each Loro commit is one undo unit; every command emits exactly
one commit — single op or one `Op::BatchCommit` — except `rename_table`/`rename_column`, which are
bracketed in a Loro undo group so the rename + its per-cell formula rewrites collapse to one unit).
`undo`/`redo` revert/replay the commit, then **re-materialize wholesale**: replay the (post-undo) op-log
onto a clone of the construction-time **baseline workbook** → `rebuild_from_workbook` → `recompute_all`
(op-log detached) → `bump_epoch` (so any outstanding `snapshot_delta` token gets `EpochMismatch`/full
rebuild — undo/redo do NOT incrementally patch the delta cache; they reseed it). Empty stack →
`consumed:false`. Errors: `undo_manager_failed`/`replay_failed` (both `Internal` — engine faults, never a
silent `consumed:false`). **v1 depth cap = 100 undo steps** (Loro default). Linear single-writer replay
reproduces sheet/table/column renames WITHOUT the ql-collab rename-repair passes (those are
concurrency-only). undo of a `set_value(Blank)` clear correctly restores the prior value (depends on the
inc.2c-6 `Op::ClearValue` durability fix). Audit: `docs/audits/2026-05-27-inc2c67-undo-audit/SYNTHESIS.md`.

### 3.9 Functions / diagnostics / events / cancellation
| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `register_function(metadata, impl_handle)` | v1 ✅ (6.4-2) | `FunctionRegistry::register_udf` + §10 | collision + invalidation rules in §10; validates canonical_name → `bad_argument` |
| `unregister_function(canonical_name)` | v1 ✅ (6.4-2) | `FunctionRegistry::unregister_metadata` | dirties referencing formulas (§10); symmetric handle clear |
| `list_functions() -> [FunctionMetadata]` | v1 ✅ (6.4-2) | `FunctionRegistry::sorted_metadata` | built-ins + UDFs; deterministic order |
| `subscribe_events() -> EventStream` / `poll_events(cursor) -> EventPage` | v1 | *new* event queue (§9) | cursor + backpressure rules in §9 |
| `cancel(op_id) -> bool` / `operation_status(op_id) -> OperationState` | v1 | *new* cancellation registry (§6) | |

### 3.10 NOT in the v1 product contract (collab / v1.5, feature-gated — §4.0)
`attachTransport`/`detachTransport`/`flush*ToTransport`/`pollRemote*`/`exportBytes`/`mergeBytes`
(transport + CRDT *merge*), `updatePresence`/`peerPresence`/`clearPresence`/`sweepPresence`
(presence), `setAutoFlushPolicy`. These ride on the same op-log but are the multi-user layer.

---

## 4. DTOs, versioning, and the session-version model

### 4.0 `SessionVersion` — the single-writer version-token model (HIGH-2; axis D)

**The contradiction this resolves:** today the *only* version-token producer is the collab/op-log Loro
`VersionVector` (`lib.rs:903` = `VersionVector::encode()`; `:2153/:2416` snapshot; `:2502/:2527` delta).
The draft simultaneously called the op-log "optional" and deferred collab to v1.5 — leaving no defined
v1 token source. **Resolution (locked):**

- The single-writer **`OpLog` is MANDATORY** for a v1 `WorkbookSession` (it already underpins undo +
  save/load). What is v1.5-deferred is the *collaborative* layer on top (transport, CRDT *merge*,
  presence) — **not** the op-log itself.
- **The token is an engine-owned `{session_epoch, op_count}`, encoded as bytes** (24 bytes: 16-byte
  big-endian epoch + 8-byte big-endian op_count). `op_count` is `OpLog::len()` at snapshot time;
  `session_epoch` is a fresh id minted at `new`/`open`/`import` (and on any cache-clearing / undo event).
  - **Correction (6.1B inc.2 grounding — supersedes the earlier "no VV" claim):** `ql-oplog::OpLog` is
    **Loro-backed and DOES expose a version vector** via `oplog_vv()` (`crates/ql-oplog/src/log.rs:424`),
    plus `new_undo_manager()`, `export_delta_bytes(from: &VV)`, `fork_at_vv`. The prior revision wrongly
    asserted it had none. We still choose `{epoch, op_count}` **deliberately**, for two real reasons:
    (1) `op_count = OpLog::len()` is the simplest monotonic single-writer counter and index-walking ops
    `[last.op_count .. current)` for a *semantic* delta (changed cells) is far simpler than decoding a
    Loro VV delta blob; (2) `OpLog::len()` is **NOT monotonic** — it reads the live Loro list, which
    *shrinks* when an `UndoManager` retracts ops (`log.rs:142-150`), so the `epoch` (bumped on
    undo/reload/cache-clear) is what makes tokens sound. The Loro VV is reserved for the v1.5
    `CollabSession` delta-sync path; its adapter maps the VV into this same opaque-token slot.
  - Bindings round-trip the bytes verbatim and MUST NOT interpret them; the engine is the sole
    producer/validator.
- **⚠️ `op_count` does NOT advance on recompute (6.1B inc.2c grounding — load-bearing for delta
  design):** `recompute_dirty`/`recompute_all` write recomputed dependent values via
  `Workbook::put_computed_at` and append **no** ops, so the token is unchanged across a recalc even
  though cell values changed. This is fine for `snapshot()` (it returns full current state regardless),
  but it means `snapshot_delta` **cannot** be a pure op-walk — see §4.3.
- **✅ RESOLVED (6.1B inc.2c-3, `20427b1c4c7`): the token counter is a session `state_seq`, NOT
  `OpLog::len()`.** `state_seq` is a monotonic clock that advances on every committed mutation AND every
  recompute that changed ≥1 cell (and on a `set_value(Blank)` clear, which also appends no op) — so two
  distinct visible states never share a token. The opaque 24-byte `{epoch, state_seq}` shape is
  unchanged (binding-invisible; only the counter's *meaning* changed). `snapshot_delta` is implemented
  as **design (a)**: a bounded session change-log keyed by `state_seq` (each mutator records its touched
  cells/sheets/formats; `RecomputeResult.changed_cells` feeds recompute's set), keeping
  `snapshot_delta(&self)`. The `epoch` is bumped for states the delta DTO cannot incrementally express
  (`move_sheet` reorder, `restore_sheet` reposition, all table ops), forcing `EpochMismatch` full
  rebuild. The Loro VV remains reserved for the v1.5 collab path.
- **Validity rules (locked):**
  - A token is valid only within the **same live session + epoch**. Single-writer sessions advance
    `op_count` purely by local appends; undo/redo bumps the epoch (so the non-monotonic `len()` after a
    retract can never produce a stale-but-accepted token).
  - `new`/`open`/`import` (and any cache-clearing event) mint a **new `session_epoch`**; an old token
    whose epoch ≠ current is `full_rebuild_required` reason `epoch_mismatch` (§4.3), not silently accepted.
  - `snapshot_delta` MUST attempt an incremental delta for a well-formed, same-epoch, non-stale token;
    it MAY return `full_rebuild_required` **only** for the enumerated reasons in §4.3. A malformed /
    unsupported-schema token is the fail-loud `invalid_version_token` error (§4.3 / MED-2).

### 4.1 Versioning rule
Every DTO crossing the contract carries `schema_version` (or the envelope's `protocol_version`).
A version a binding doesn't understand → `EngineError{class:Protocol, code:"unsupported_schema_version"}`,
never silent coercion (generalizes `.qbook snapshot_format_version` + the op wire `deny_unknown_fields`).

**6.3-1c (M5) — SHIPPED for the snapshot DTOs over napi (Node).** `WorkbookSnapshotJson` +
`WorkbookSnapshotDeltaJson` now carry `schemaVersion` (= engine `SCHEMA_VERSION`); the IDE's
`assertSupportedSchemaVersion` at the snapshot AND delta ingest boundaries is the producer of
`unsupported_schema_version` (previously a producerless code). `full_rebuild_reason` (§4.3) is also
threaded on the delta DTO. `RangeResult` gained `schemaVersion` when it bound in 6.3-2a (below); the
remaining DTOs (`TableSpec`/`BatchResult`/`UndoRedoResult`/transaction) gain it as they bind in the
later 6.3-2 sub-increments / 6.3-3.

**6.3-2a — SHIPPED over napi (Node).** The read/lifecycle/format/validate cluster is bound on the
owning `Session`: `lifecycleState` (§2.3 wire string), `validateFormula` (§3.2 — diagnostics-as-data,
never throws on a bad formula), `queryRange` → `RangeResultJson` (§3.6 — columnar; carries
`schemaVersion` forwarded from the engine DTO; `include_*` → loud `not_implemented_in_v1_core`),
`markVolatilesDirty`, `setFormat` / `registerFormat` (§3.2 — `FormatIdJson` round-trips both
directions). `TableSpec`/`BatchResult`/transaction DTOs ride later 6.3-2 sub-increments;
`UndoRedoResult` rides 6.3-3.

**6.3-2b — SHIPPED over napi (Node).** The persistence cluster is bound on the owning `Session`:
`open(path)` / `save(path)` (§3.1 — `.qbook`), `import(bytes, format)` / `export(format) -> Uint8Array`
(§3.1 — `"xlsx"`/`"csv"`; byte payloads as `Uint8Array`). No new DTOs — strings + byte buffers only;
each inherits the locked 6.3-1 contract (`guarded(env,…)` + native `engine_error_to_napi`). `export("xlsx")`
in the default (reader-only) cdylib returns the honest `not_implemented_in_v1_core` (the `xlsx-write`
feature is off). **M7 effective-extent landed with this increment** (CSV output fix + .qbook/xlsx tight
extent; see the `export("csv")` row in §3.1 and `Sheet::effective_value_bounds`). `TableSpec`/`BatchResult`/transaction
DTOs ride later 6.3-2 sub-increments; `UndoRedoResult` rides 6.3-3.

**6.3-2c — SHIPPED over napi (Node).** The structure / sheets cluster is bound on the owning `Session`:
`renameSheet(id, newName)` / `deleteSheet(id)` / `restoreSheet(id)` / `moveSheet(id, newIndex)` / `setName(name, target)`
(§3.3; `addSheet` was bound earlier). No new DTOs — sheet ids validated to u16 (`validate_u16_index`), the move
index to u32 (`validate_u32_index`), and `setName`'s `target` reuses the 6.3-2a `CellRangeJson` / `session_range_from_json`.
Each inherits the locked 6.3-1 contract (`guarded(env,…)` + native `engine_error_to_napi`): unknown id →
`sheet_not_found`, duplicate name → `sheet_name_duplicate`, out-of-range move index → `bad_argument`, restore of a
live sheet → `sheet_not_deleted`, move-to-current-index → silent no-op. **`setName` orientation:** an inverted
`target` is normalized to `start ≤ end` per axis (engine `Range::new`, Excel named-range semantics) — deliberately
unlike `queryRange`, which rejects inversion (its `end - start + 1` span arithmetic would underflow). This
`query_range`-vs-`set_name` inversion asymmetry is an engine-side API choice (filed forward), not a binding defect.

**6.3-2d — SHIPPED over napi (Node).** The tables cluster is bound on the owning `Session`:
`createTable(spec)` / `renameTable(oldName, newName)` / `renameColumn(table, oldCol, newCol)` /
`resizeTable(name, newRows, newCols, addedColumns, removedColumns)` / `dropTable(name)` (§3.3). The FIRST 6.3-2
sub-increment with a new DTO: `TableSpecJson` (mirrors `ql_session::TableSpec`), converted by
`session_table_spec_from_json` (`sheet` → u16, `topRow`/`topCol`/`rows`/`cols` → u32 via the same boundary
validators as `session_range_from_json`; the u32 validator permits `0`, so a zero-dim spec reaches the engine and
surfaces `table_create_rejected` rather than a boundary `bad_argument` — faithful). Each inherits the locked 6.3-1
contract: duplicate name / zero dims / overlap / footprint / column-name issues → `table_create_rejected`
(Conflict); unknown table → `table_not_found`; unknown column → `table_column_not_found`; rename-column target
collision / empty name → `table_column_rejected`; invalid resize dims → `table_resize_rejected`; create on a
non-live sheet → `sheet_not_found`. Table ops are not delta-expressible (they rewrite cells the session cannot
enumerate) → the engine bumps the epoch (consumers reseed from a fresh snapshot).

**6.3-2e — SHIPPED over napi (Node) — 6.3-2 COMPLETE.** The atomic-group cluster + the reserved §3.5 stubs are
bound on the owning `Session`. Atomic groups (§3.4): `batch(ops, options)` / `beginTransaction()` /
`txnAdd(txn, op)` / `commitTransaction(txn)` / `rollbackTransaction(txn)`. New DTOs: `SessionOpJson` (a
`kind`-tagged STRICT mirror of the 4-variant `SessionOp` — `setValue`/`setFormula`/`clear`/`setFormat`, each
admitting ONLY its own payload; an extraneous-for-kind field → `bad_argument`), `BatchOptionsJson`
(`undoLabel?`), `BatchResultJson` (`applied` + `version` = the opaque `SessionVersion` as a `Buffer`).
`TransactionId` (u64) is a JS `BigInt` (sign/lossless-validated like `OperationId`). Semantics: `batch` /
`commitTransaction` are all-or-nothing (validated pre-mutation) — a same-cell value/formula conflict →
`conflicting_batch_ops` (Conflict), a non-finite value → `bad_argument`; an unknown txn id →
`transaction_not_found` (NotFound); a FAILED commit restores the buffer (txn stays open), a successful commit
consumes the handle; `rollbackTransaction` discards + consumes. The 5 reserved §3.5 stubs `writeRange` /
`publishDataset` / `bindRange` / `refreshSource` / `materializeQuery` are bound as thin loud-Capability
forwarders (declared `-> void`, always `not_implemented_in_v1_core`; `publishDataset`/`materializeQuery` take
`data` as a JSON string since the napi `serde-json` feature is off) — their FULL input contract (e.g.
`writeRange`'s matrix-shape rule) lands with the real impl in 6.4/6.5.

**6.3-2 is now COMPLETE** — all 32 `EngineSession` methods are bound across sub-increments a–e.

**6.3-3 — SHIPPED over napi (Node).** The live-grid + ops cluster is bound on the owning `Session`:
`snapshotDelta(lastVersion)` / `undo()` / `redo()` / `canUndo()` / `canRedo()` (`cancel`/`operationStatus`/
`pollEvents` landed earlier). New DTO `UndoRedoResultJson { consumed, version }` (mirrors `UndoRedoResult`;
`consumed:false` on an empty stack is a normal return, NOT an error). `snapshotDelta` takes the opaque
`SessionVersion` as a `Buffer` and returns `WorkbookSnapshotDeltaJson` via the new
`workbook_snapshot_delta_json_from_session` converter (forwards the engine delta's `schema_version`; distinct
from the legacy CollabSession CRDT delta path). A first/stale/cross-epoch token is NOT an error — the result
carries `fullRebuildRequired = true` with a `fullRebuildReason` (`no_prior_version`/`epoch_mismatch`/
`stale_horizon`/`cache_cleared`); a future-seq token fails loud with `invalid_version_token`. `undo`/`redo`
clear the delta cache, so the next `snapshotDelta` against an older token full-rebuilds; both gate
`ensure_ready` (→ `invalid_state` post-close). `canUndo`/`canRedo` are ungated pure reads.

**6.3-4 — a SECOND binding row (Python) over pyo3.** The thin pyo3 `Session` facade (`quantbook._quantbook`) SHIPPED 2026-05-31 (engine `38f4f51dfac`), wrapping the SAME `EngineSession` contract this document specifies. A cross-binding **golden parity matrix** (`crates/quantbook-py/tests/parity_matrix.py`) runs one canonical 22-step flow through Node AND Python and asserts byte-identical DTOs + error codes (masking only the opaque `version`/`nextCursor` tokens) -- so the contract is now exercised by two structurally-different bindings, not Node self-consistency alone. The Python facade is THIN (golden-flow methods only); the 5 reserved §2c bulk methods stay Capability-erroring (6.5). Errors cross as a `QuantbookError(Exception)` carrying the same `code`/`class`/`retryable`/`details`/`source` the napi native error carries. NEXT = 6.3-5 (declare the contract frozen on ≥ 2 passing rows).

### 4.2 Core DTOs (extracted from the proven `#[napi(object)]` structs; `+` = added/clarified)

**u64 wire encoding (FROZEN — 6.3-5 HIGH-A):** Every `u64`-typed wire field —
operation ids, transaction ids, format `customPeer`, event cursors (`nextCursor`),
recalc op-ids, and the `recalc_progress` `op`/`done`/`total` counters — crosses as
a **decimal STRING** in the canonical JSON projection. In-process a binding MAY use
its native big-int (napi `BigInt`; the harness `stableStringify` renders a `BigInt`
to a quoted decimal string), but the **serialized form is a decimal string**. The
pyo3 facade therefore emits `str(value)` for these fields (a Python `int` would
serialize as a JSON number → a cross-binding mismatch). A binding that emits a JSON
**number** for a `u64` is **non-conformant**. (`u32`-typed fields — e.g. format
`customCounter`, `RangeResult.n_rows`/`n_cols` — stay JSON numbers; only `u64`
crosses as a string.)

- **`CellValue`** (← `CellValueJson`, `lib.rs:580`): a **discriminated union** on `kind`
  (`number`/`boolean`/`text`/`error`/`blank`/`pending`), exactly one payload. Bindings narrow on `kind`.
  `blank` (added 6.1B inc.2c) maps from `ql_types::Value::Blank` — needed so a columnar `query_range`
  read can represent empty cells in a fixed-size column; snapshots still omit blanks
  (`CellSnapshot.value: None`). *(TS mirror retype scoped: closures.md §5 item 2 — must add `blank`.)*
- **`CellAddress`** `{sheet,row,col}`, **`Range`** `{sheet,start_row,start_col,end_row,end_col}`.
- **`FormatId`** (← `FormatIdJson`): `builtin(u32)` | `custom(peer,counter)`. **`FormatDef`** `{id,string}`.
- **`CellSnapshot`** (← `CellSnapshotJson`): `{row,col,value?,formula?,format?,rendered?}`.
- **`SheetSnapshot`** / **`SheetInfo`** `{id,name}`.
- **`WorkbookSnapshot`** (← `WorkbookSnapshotJson`): `{schema_version,sheets[],formats[],date_system,version}`.
- **`WorkbookSnapshotDelta`** (← `WorkbookSnapshotDeltaJson`): `{changed_cells[],removed_cells[],
  sheets_changed[],sheets_removed[],formats_added[],version,full_rebuild_required,full_rebuild_reason?}`
  *(+`full_rebuild_reason`, MED-2)*.
- **`RangeResult`** *(+ MED-5)*: `{schema_version, range, n_rows, n_cols, columns:[{values: CellValue[]}]}`
  (the FROZEN shape — matches `RangeResultJson`/`RangeResultWire`). **Columnar** (`columns.len()==n_cols`,
  each column's `values.len()==n_rows`); null/pending/error/blank encoded inside `CellValue`. One shape
  across all bindings. (The query OPTIONS — `include_formulas`/`include_formats`/`include_rendered` — are
  an `RangeQueryOptions` INPUT, not a field of the result; an Arrow-handle column layout is a future option,
  not in the v1 wire.)
- **`WriteRangeResult`/`PublishedRef`/`BoundRange`/`DirtyResult`** (§3.5 reserved).
- **`FunctionMetadata`** (§10).
- **`Diagnostic`/`Event`/`EventPage`/`OperationState`/`EngineError`** (§5/§6/§9).

### 4.3 `full_rebuild_required` — locked cases (MED-2; No-Fallbacks)
`full_rebuild_required:true` (+ `full_rebuild_reason`) is reserved for these **enumerated, designed**
states — never for malformed input:
1. **Empty token** (first call) → reason `"no_prior_version"`.
2. **No prior delta cache** (cache force-cleared by merge/undo) → `"cache_cleared"`.
3. **Stale but well-formed** token older than the cache horizon → `"stale_horizon"`.
4. **Different session/epoch** (e.g., post-reload token) → `"epoch_mismatch"`.

A **malformed / unsupported-schema** token is **fail-loud**:
`EngineError{class:Protocol, code:"invalid_version_token"}`. This closes the current silent-resync
fallback: `lib.rs` today returns `fullRebuildRequired=true` on Loro decode error (`~:2529`) while its
own docstring (`:2495`) claims `[bad_argument]` — a real drift. 6.1B fixes the code to match this
contract (fail-loud) and corrects the docstring.

---

## 5. `EngineError` — structured taxonomy (API6-03)

### 5.1 The DTO
```
EngineError { code: String, class: ErrorClass, message: String,
              details: Map<String,Value>?, retryable: bool, source: String? }
```
Replaces the `[<kind>]`-prefix-on-Display workaround (`lib.rs:306-349`, forced because napi-rs's
`Error` `Status` is an enum with no custom string code). `code` is carried as **data**, not parsed from
a message.

**6.3-1c — SHIPPED over napi (Node).** Engine-taxonomy errors (`EngineSession` results) now reach JS
as a NATIVE `Error` with `.code` / `.class` / `.retryable` (+ `.details` as a JSON string, `.source`)
own-properties. napi-rs 3.9.0's `Result<T>` path can't carry a custom `.code`, so the binding builds the
error via `Env::create_error` + `Object::set` and `Env::throw`s it, returning `Status::PendingException`
(napi's `throw_into` short-circuits → the augmented object propagates verbatim). The single throw point
is the `guarded(env, …)` boundary. **Scope:** FFI argument-validation `bad_argument` (the binding's own
`validate_*` / `bad_argument_error`) + collab + udf-spawn KEEP the `[<code>]`-prefix string (uniform
`class=BadArgument`, no details); the IDE's `parseQuantbookError` reads the native `.code` when present
and falls back to the prefix otherwise (dual-format, monotonic). `details` as a native nested object
(rather than a JSON string) awaits enabling napi-rs's `serde-json` feature — filed forward.

### 5.2 `ErrorClass`
`BadArgument` · `Lifecycle` (incl. `session_busy`, `invalid_state`) · `NotFound` · `Conflict` ·
`Compute` · `Persistence` · `Protocol` · `Canceled` · `Capability` · `Internal`.

### 5.3 Code stability
`code` strings are **stable across releases** (public contract). Adding a code is compatible;
rename/remove is breaking → `protocol_version` bump. **No catch-all "unknown" code may leak to a
caller** — the current `qbook_unknown` wildcard arm (`lib.rs:496`) must map every real variant
explicitly (Appendix A); an unmapped variant is an `Internal` bug to fix, not a stable public code.

### 5.4 Variant→code mapping is mandatory (MED-1)
Bindings MUST NOT infer codes from classes. **Appendix A** maps every current public error variant
(`RuntimeError`, `RecomputeFailure`, `ReplayError`, `OpLogError`, `PersistenceError`, `TransportError`,
`CollabSessionError`) to `{class, code, retryable}`. **Implementation note (6.1B inc.2):** this mapping
is a set of **free conversion functions** in the owning layer (`ql-exec::session::map_runtime_err` /
`map_oplog_err`), **NOT** `impl From<…> for EngineError` — Rust orphan rules forbid `impl From<Local>
for Foreign` when the foreign type (`EngineError`, from `ql-session`) is `Self`. The `RuntimeError` match
is in-crate + **exhaustive (no wildcard)**, so a newly-added variant is a *compile* error — stronger
than a runtime catch-all. (`RuntimeError` + `OpLogError` are mapped as of inc.2; `ReplayError` /
`PersistenceError` land with snapshot_delta-replay / persistence in a later increment.)

### 5.5 Formula errors: value vs error
A formula that *evaluates to* an error (`#REF!`, `#DIV/0!`) is a **`CellValue{kind:"error"}`**, not an
`EngineError`. A *malformed* `set_formula` (parse/bind failure) returns either `Compute` `EngineError`
or a `Diagnostic` (via `validate_formula`/events) — locked per command in 6.1B, but never silently
dropped.

---

## 6. Operation lifecycle & cancellation (API6-02) — scoped honestly

**HIGH-1 reality:** `recompute_all`/`recompute_dirty` (`workbook_runtime/recompute.rs:61/252`) are
**synchronous `&mut self` loops that commit each cell as they go** (`put_computed_at` at `:140/:168/
:197/:344/:445/:610`); `CalcgraphSession` is **not `Clone`** (`calcgraph_session.rs:445`). So
"compute on a clone, swap atomically" and "discard partial results mid-flight" are **not available in
v1** without a compute-core refactor. The contract is scoped to what is implementable:

### 6.1 Universal: every long op has an identity
`recalc_*`, `query_range` over large ranges, UDF (6.4), SQL (6.5), AI (6.6) return an **operation ID**
and register `{optional deadline, cancel token, terminal state}`. `OperationState`: `Running` →
`Completed | Canceled | Failed(EngineError)` (terminal, immutable). The session is `Busy` (§2.3) while
an op owns mutable engine state.

### 6.2 Out-of-process work: hard no-late-commit (UDF/SQL/AI)
A canceled/timed-out **UDF** is hard-canceled by **killing the worker process** (decision-lock §5.2);
its result is discarded and the cell gets a deterministic `Canceled` diagnostic. The same applies to
SQL/AI (cancel the outstanding request). **No late commit** — guaranteed because the work is off-engine.

### 6.3 Staged in-engine work (future): commit-once
When a staged-recalc protocol lands (compute into a write-set, check the token before a single commit),
in-engine recalc also gets hard mid-flight cancel + no-late-commit. This requires the compute-core
refactor and is **explicitly post-6.1** (a `recompute_into(write_set)` API + a `Clone`/snapshot of
`CalcgraphSession`).

### 6.4 In-engine recalc TODAY: pre-start cancel only (v1 guarantee)
For `recalc_dirty`/`recalc_all` in v1: `cancel(op_id)` **before execution begins** prevents the run;
**once running, the synchronous pass completes** (it is fast — incremental dirty recalc is the common
path) and commits, then transitions to `Completed`. The contract does **not** promise mid-flight
abort or partial-result rollback for in-engine recalc in v1, and bindings MUST NOT claim it (this is
the exact wording that prevents the binding fork). Sync FFI: `start→poll/wait/cancel`; async bindings
`await` the same op; both surface `Canceled` identically when the pre-start cancel wins.

**M2 (6.3-1b) — SHIPPED.** This is now implemented via the `start_recalc(kind) -> op_id` /
`await_recalc(op)` split (the convenience `recalc_dirty`/`recalc_all` are start+await in one locked
call → no window). `start_recalc` reserves the op (`Running`, session `Busy`) and returns WITHOUT
computing; because the binding releases the lock on return, a `cancel(op)` lands in the gap and
`await_recalc` then SKIPS the recompute (no commit, no change-log/epoch advance) and surfaces
`Canceled`. A `close()` during the window terminalizes the reserved op as `Canceled`; `await_recalc`
rejects a terminal session (`invalid_state`) — never resurrects it. napi binds `startRecalcDirty`/
`startRecalcAll`/`awaitRecalc`/`cancel`; `operation_status` over napi lands with the M5/§4b DTO sweep
(6.3-1c).

---

## 7. Sync/async & concurrency discipline

**Rule: locks guard state transitions, not arbitrary waiting** (decision-lock §3.5). Canonical lesson:
`flushPendingToTransport` (`lib.rs:~3421-3445`) extracts the ack handle *under* the lock, **drops the
lock**, then `spawn_blocking(|| handle.wait_for_drain())`. Obligations:

1. A binding wraps the session in its lock (`Arc<Mutex<..>>` Node; GIL-aware Python). Mutating/querying
   commands hold the lock for the **state transition only**.
2. No command holds the session lock across a blocking wait, an `await`, or a round-trip into user code
   (UDF/AI). Long ops use the §2.3 `Busy` state: acquire lock → mark `Busy` + register op → **release
   lock** → execute → re-acquire to commit + clear `Busy`. (For v1 in-engine recalc the execute step is
   the synchronous pass per §6.4; for UDF/SQL it is genuinely off-lock.)
3. Soundness closures carried forward: V2.4 (no `&mut self` UB across napi) + V2.5 (no event-loop
   block). New long-op surfaces replicate the detach-then-off-lock shape.

---

## 8. Panic & validation boundary

1. **Validation at the boundary** before engine work (NaN/Inf/negative/fractional coords, oversize
   indices, bad UTF-8) → `EngineError{class:BadArgument}` (generalizes today's `appendPut*` validation
   + `[bad_argument]`). Lives once in the common layer.
2. **Panic catch** (LOW-2 specifics): FFI crates MUST build with **`panic = "unwind"`** (else abort
   remains possible and this guarantee is void). A single shared `catch_unwind` wraps the common
   command dispatcher **before** any FFI boundary observes unwinding, converting a panic to
   `EngineError{class:Internal, code:"panic"}`. Because the Node wrapper uses `parking_lot::Mutex`
   (no poisoning, `lib.rs:1121`), the conservative rule is: **any panic during a mutating command marks
   the session `Faulted`**; read-only command panics are surfaced as `Internal` without faulting (the
   committed state is intact). A panic is never a silent crash, never a swallowed fallback.
3. C ABI: no `panic` unwinds across `extern "C"` (UB) — verified by BND-6-02.

---

## 9. Event & diagnostic stream (MED-5: cursor + backpressure locked)

- **`Event`** (versioned union): `RecalcProgress{op_id,done,total}`,
  `CellDiagnostic{addr,severity,code,message}`, `OperationCompleted{op_id,state}`,
  `Provenance{addr,source}` (shaped now for UDF/SQL/AI), `StructureChanged{kind,target}`.
- **Queue model (locked):** a single **append-only ring** with a **monotonic global cursor**.
  `poll_events(cursor) -> EventPage{events[], next_cursor, dropped?}` **reads** (does not drain) from
  the cursor — so pull pollers and push subscribers never starve each other. Retention is a bounded
  window; if a consumer falls behind the horizon, the page carries `dropped:true` + a
  `FullResyncRequired` event (the consumer reseeds via `snapshot()`), rather than silently losing
  events. Ordering: an `OperationCompleted{op_id}` event never precedes the events produced by that op.
- `Diagnostic` is the same DTO whether returned synchronously (`validate_formula`) or via the stream.

---

## 10. Function metadata & graph-invalidation contract (R-P6-4 / 6.4-0)

### 10.1 The gap (CLOSED by 6.4-0 substrate + 6.4-1 substrate-completion, 2026-05-28; commits `ac20a432c63` + audit-fix `63592126afe` + `1a7dfee12b0` + audit-fix `befcd0d34cc`)
**Pre-substrate (historical):** `FunctionRegistry` (`ql-functions/src/registry.rs`) stored **dispatch only**.
Volatility + reference-shape lived in **two hardcoded whitelists** in `calcgraph_session.rs`
(`is_volatile_function` `:149-164`; `is_address_only_reference_fn` `:201-203`); `FormulaDeps`
had no `functions_used` reverse index. A Python UDF couldn't be added to a hardcoded match,
and a registration/metadata change couldn't dirty its callers → silent graph bypass.

**Post-substrate (6.4-0 SHIPPED 2026-05-28):**
- `FunctionRegistry` carries a first-class `metadata: HashMap<String, FunctionMetadata>` keyed by
  canonical (ASCII-uppercase) name; populated for every builtin via `register_builtin_metadata`
  at `default_registry()` tail. Public API: `metadata(name)` / `register_metadata(meta)` /
  `unregister_metadata(name)` / `iter_metadata()` / `metadata_count()`. Dispatched-builtin
  unregister is REFUSED (`FunctionRegistryError::Conflict`) — preserves the migration-shim
  invariant. Boot-time `assert!` enforces "every dispatched fn has metadata."
- `FormulaDeps` gained `functions_used: Vec<Arc<str>>`; walker pushes at the TOP of the
  `ExprPlan::Function` arm so address-only / ISREF / nested-function paths all record uniformly.
- `CalcgraphSession` gained `functions_used: HashMap<Arc<str>, HashSet<NodeId>>` (mirror of
  `name_to_formulas`) + two hooks `on_function_registered(name)` / `on_function_unregistered(name)`
  with transitive BFS-fanout (same Phase 3.10 H2 pattern as `on_set_name`). Storage gate was
  widened to also store `formula_deps` when only `names`/`tables`/`functions_used` are populated
  (closes the latent `ROW(MyName)` cleanup bug).
- The two prior whitelists are now thin migration shims (`is_volatile_function(registry, name)` →
  `metadata.volatility ∈ {Volatile, Dynamic}`; `is_address_only_reference_fn(registry, name)` →
  `metadata.dep_shape == AddressOnly`). Behavior is preserved byte-for-byte against the prior
  matchers.

**6.4-1 substrate-completion (SHIPPED 2026-05-28; commits `1a7dfee12b0` cycle 1 + `befcd0d34cc` cycle-2 audit-fix) — closes H1 + H3 + 5 filed items:**
- **H1 CLOSED** — new `ArgContext` axis on `FunctionMetadata` (`Scalar` / `Aggregate` / `Reference`,
  orthogonal to `BatchShape`); `register_builtin_metadata` Phase 1 sets the 7 reference-aware names'
  `arg_context: Reference` and Phase 1.5 sets the ~66 aggregate / range-aware / array-tier names'
  `arg_context: Aggregate` mirroring the pre-6.4-1 `is_aggregate_function` `matches!` BYTE-FOR-BYTE.
  `ql-exec::plan::is_aggregate_function` + `is_reference_aware_function` drop the hardcoded
  `matches!` and read metadata; every binder entry point threads `&FunctionRegistry`. UDFs
  registering `ArgContext::Aggregate` admit range args at bind time (no
  `BindError::NamedRangeInScalarContext` for `=MYUDF(MyNamedRange)`).
- **H3 CLOSED via option (a)** — `FunctionRegistry::fn_gen: u64` counter mirrors `name_gen` exactly;
  bump on every `register_metadata` / `unregister_metadata` success via `saturating_add(1)`
  (Conflict / NotFound / builtin-guard return BEFORE the bump). `PlanCacheKey` carries `fn_gen`;
  5 production call sites read it. Cache miss on bump → re-bind → fresh `FormulaDeps` against
  current metadata. See §10.3 for the full closure rationale (and why option (a) was chosen over
  option (b) per the Opus I1-OPUS audit finding).
- **M1 (substrate-completion)** — `FormulaDeps::is_empty/len` widened to span ALL 6 tracked-dep
  fields (`cells`, `named_ranges`, `names`, `tables`, `functions_used`, `is_volatile`); the
  substrate audit-fix's 5-clause `||`-chain storage gate collapses to `!deps.is_empty()`. The
  pre-6.4-1 API was a 2-of-6 lie that the substrate gate papered over.
- **M3 (substrate-completion)** — new `FunctionRegistry::sorted_metadata() -> Vec<&FunctionMetadata>`
  returning the metadata table sorted by `canonical_name` ascending. Matches the 6.1C H2
  deterministic-ordering discipline; the 6.4-2 `EngineSession::list_functions` mapper reads it at
  the DTO seam (✅ wired).
- **M5 (substrate-completion)** — new `map_function_registry_err` closed-enum exhaustive mapper at
  `crates/ql-exec/src/session.rs` translates `Conflict { name } → function_exists` and
  `NotFound { name } → function_not_found` per Appendix A. ✅ 6.4-2 wired this into
  `register_function` / `unregister_function` (the `#[allow(dead_code)]` was removed).
- **I1 (substrate-completion)** — new `DepShape::LazyShape` variant; ISREF moves to LazyShape;
  new `is_lazy_shape_reference_fn` migration shim parallel to `is_address_only_reference_fn`.
  Walker checks LazyShape FIRST in the `ExprPlan::Function` arm (the strictest skip-arg-walking
  branch), then AddressOnly, then normal. The two shims are DISJOINT — `arg_context: Reference`
  is the only axis they share.
- **I2 (substrate-completion)** — `function_meta.rs` module header documents the two-step v1
  atomicity policy (`unregister_metadata` then `register_metadata`); the cycle-2 audit-fix's H2
  doc-honesty rewrite describes the actual substrate-v1 transient-gap behavior in detail
  (formula re-binds as NOT volatile during the gap because the substrate's
  `is_volatile_function` returns `false` for unknown names — see §10.3's
  "Unknown-function policy" sub-section for the contract §10.3 deferral note).

**Cycle-2 audit-fix `befcd0d34cc` (2 net-new HIGH Opus surfaced + cycle-1 doc + test polish):**
- **H1-OPUS (HIGH)** — `WorkbookSession::from_workbook` (`session.rs:304`) + `rematerialize`
  (`:739`) were using zero-arg `rebuild_from_workbook(&workbook)` → silent registry divergence at
  TWO more sites the 6.4-0 H2 audit-fix didn't close. Audit-fix threads
  `self.registry` through both. Behavior-preserving today; prevents future UDF divergence.
- **H2-OPUS / Codex M1 (HIGH doc-honesty)** — the cycle-1 I2 docstring claimed `Volatility::Dynamic`
  during the transient gap (contract §10.3 desired behavior); both lanes verified at source the
  substrate explicitly defers honoring §10.3's unknown-fn policy. Rewrite describes what the
  substrate ACTUALLY does (formula re-binds as NOT volatile, binder arg_ctx falls back to Scalar,
  dispatch surfaces `#NAME?`).
- **M1 / M2 / L1** — new `different_function_generation_misses` plan-cache test pins H3 cache-miss
  invariant; new `phase_1_5_aggregate_overrides_byte_for_byte_against_pre_6_4_1_whitelist`
  enumerates all 66 Phase-1.5 names verbatim; 5-site stale-docstring sweep.

**Filed for 6.4-2 (non-blocking):** M3-OPUS Reference+ArrayBatch forward-compat smoke; M4-OPUS
UDF-flow binder integration test; L2-OPUS `DepShape::LazyShape` `#[serde(alias)]`; I2-OPUS Phase-1.5
overlap `debug_assert`. **Filed for 6.4 perf backlog (joint with 6.4-0 L1):** L3-OPUS walker hot-path
2x HashMap-lookup collapse + `to_ascii_uppercase` allocation. Full inventory at
`docs/audits/2026-05-28-6-4-1-substrate-completion-audit/SYNTHESIS.md`.

### 10.2 `FunctionMetadata` (built in 6.4-0; extended at 6.4-1; v1 DTO now)
```
FunctionMetadata {
  canonical_name: String,        // ASCII-UPPERCASE, matches parser canonicalization (ast.rs:54)
  display_name: String?, aliases: [String]?,   // documented Unicode/alias policy
  arity: Arity, volatility: Volatility,         // Pure | Volatile | Dynamic
  determinism: bool, dep_shape: DepShape,       // Value-deps | AddressOnly | LazyShape | Custom
  batch_shape: BatchShape,                       // Scalar | Arrow/array batch (UDFs: batch from day one)
  arg_policy: ArgPolicy, cancellation: CancelPolicy,  // cooperative | worker-kill
  arg_context: ArgContext,                       // Scalar | Aggregate | Reference (6.4-1 H1; #[serde(default)])
  provenance_tags: [String],
}
```
**6.4-0 + 6.4-1 axes (full taxonomy):**
- `dep_shape: DepShape` now has THREE variants: `ValueDeps` (default — normal value-deps),
  `AddressOnly` (ROW / COLUMN / ROWS / COLUMNS — depends on address/shape, not value), and
  **`LazyShape`** (ISREF — function never evaluates its arg, walker skips arg subtree entirely;
  added at 6.4-1 I1 to replace the pre-substrate hardcoded `name == "ISREF"` walker short-circuit).
  `Custom` is reserved for `register_formula_function(.., deps=[...])` explicit deps.
- `arg_context: ArgContext` is the NEW 6.4-1 H1 axis the binder consults at the
  `ExprPlan::Function` arm:
  - `Scalar` (default) — binder rejects range args (`BindError::NamedRangeInScalarContext`).
    All pure-scalar builtins (`ABS` / `SQRT` / `IF` / etc.) and any unknown function name land
    here. The `#[serde(default)]` attribute provides v0-wire compat with snapshots taken before
    the 6.4-1 cycle 1 (which had no `arg_context` field).
  - `Aggregate` — binder admits named-range / range-aware args under `BindContext::AggregateArg`.
    The ~66 names that pre-6.4-1 lived as the `is_aggregate_function` `matches!` whitelist
    (`SUM` / `AVERAGE` / `VLOOKUP` / `SUMIFS` / `TRANSPOSE` / `FILTER` / `SUBTOTAL` /
    `CORREL` / `XIRR` / `XLOOKUP` / `PERCENTILE.INC` / `MINIFS` / `TEXTJOIN` / … verified
    66/66 at the 6.4-1 cycle-2 audit). Python UDFs taking a column / range argument MUST
    register `ArgContext::Aggregate` to bind range args.
  - `Reference` — binder admits literal references (CellRef / RangeRef / NameRef) under
    `BindContext::ReferenceArg`. The 7 names that pre-6.4-1 lived as the
    `is_reference_aware_function` `matches!` whitelist (ROW / COLUMN / ROWS / COLUMNS / ISREF
    / ISFORMULA / FORMULATEXT).
- `ArgContext` is ORTHOGONAL to `BatchShape`: a builtin aggregate like `SUM` is
  `ArgContext::Aggregate` AND `BatchShape::Scalar` (binder admits range args; eval is per-cell
  `fn(&[Value]) -> Value` after the named-range cache hit). A Python UDF taking a Range arg
  would declare `ArgContext::Aggregate` AND `BatchShape::ArrayBatch` (binder admits range;
  eval is Arrow IPC). The two axes are kept distinct because conflating them would force UDFs
  that want range args to declare `BatchShape::ArrayBatch` even when they don't need the Arrow
  IPC ABI.

The pre-substrate hardcoded whitelists (4 total: `is_volatile_function`,
`is_address_only_reference_fn` at `calcgraph_session.rs` from 6.4-0 + `is_aggregate_function`,
`is_reference_aware_function` at `plan.rs` from 6.4-1) all became **derived** from registered
metadata (built-ins register their true metadata; the engine-side functions are now thin
migration shims that delegate to `FunctionRegistry::metadata(name)`).

### 10.3 Registration + invalidation rules (HIGH-5)
- **Canonical name:** ASCII-uppercase; `register_function` **validates** (6.4-2 cycle-2 audit-fix
  H1): an empty or non-ASCII-upper-case `canonical_name` returns `EngineError{class:BadArgument,
  code:"bad_argument"}` rather than reaching the registry's internal `assert!`s (which would panic
  across the catch_unwind-free napi boundary and seal the session). It validates-and-rejects (does
  NOT silently normalize — No-Fallbacks); callers/IDE upper-case before the call. Unicode/alias
  policy documented.
- **Collision rules:** `register_function` **returns an error** (not a panic) on collision with a
  built-in, an existing UDF, or (if applicable) a name/table — `EngineError{class:Conflict,
  code:"function_exists"}`. Symmetric: `unregister_function` returns
  `EngineError{class:NotFound, code:"function_not_found"}` for a name not in the registry. Both
  codes are listed in Appendix A (6.4-1 cycle 1 added the M5 `map_function_registry_err` closed-enum
  exhaustive mapper at `crates/ql-exec/src/session.rs`; ✅ 6.4-2 wired it into the two trait methods
  and removed the `#[allow(dead_code)]` — both codes are now wire-live to the IDE allowlist).
- **`functions_used` reverse index** *(new `FormulaDeps` field + graph map)*: the dep walker records
  each function a formula calls; the graph keeps `function -> [formula nodes]`. Built at 6.4-0
  substrate; the storage gate that admits a `FormulaDeps` instance into the per-formula table now
  spans ALL six tracked-dep fields (cells / named_ranges / names / tables / functions_used /
  is_volatile) post-6.4-1 M1 (the cycle-1 commit collapsed the substrate audit-fix's 5-clause
  `||`-chain back to a single `!deps.is_empty()` once `FormulaDeps::is_empty/len` honestly span
  all 6 fields).
- **Invalidation:** `register_function` / `unregister_function` / metadata-update **dirties every
  formula referencing that canonical name** (re-extract deps + reschedule). This also covers formulas
  that bound while the name was **unknown** and become valid on registration.
- **How re-extract is implemented (6.4-0 substrate + 6.4-1 H3):** the substrate's
  `on_function_registered` / `on_function_unregistered` hooks satisfy the "dirty every formula"
  + "reschedule" halves via `mark_dirty_from_cell_write`'s transitive BFS-fanout. The
  "re-extract deps" half is closed at 6.4-1 by a `fn_gen: u64` counter on `FunctionRegistry`,
  mirroring the established `name_gen` pattern at `crates/ql-storage::names::NameTable::generation()`.
  Every `register_metadata` / `unregister_metadata` success bumps `fn_gen` via `saturating_add(1)`
  (Conflict / NotFound failures leave the counter untouched — the metadata table is unchanged so
  the cache stays valid). `PlanCacheKey` carries `fn_gen` alongside `name_gen`; the 5 production
  call sites (`cells.rs:116`, `cells.rs:521`, `recompute.rs:547`, `recompute.rs:753`,
  `tables.rs:825`) read `self.registry.fn_generation()` at bind time. A subsequent
  `register_metadata` bump invalidates the bind cache → next eval re-binds → fresh
  `FormulaDeps` against current metadata → `is_volatile` flag + `functions_used` reverse index
  reflect the new registration. **Design choice (Opus I1-OPUS, 6.4-1 cycle-2 audit):** the
  cache-invalidation route was chosen over per-dependent `reextract_deps` calls in the
  `WorkbookSession::register_function` orchestrator because one cache-counter bump invalidates
  every plan in one HashMap lookup vs. N walks of the dependent set, and the pattern mirrors
  `name_gen` exactly — fewer moving parts for the same result.
- **Unknown-function policy (substrate v1 deferral):** the contract specifies "a formula
  referencing an unregistered name is **graph-visible and treated Volatile/Dynamic** (never
  silently Pure), so it recomputes once the UDF appears." **6.4-0 substrate + 6.4-1/6.4-2 cycles
  HONESTLY DEFER the Volatile/Dynamic tightening to 6.4-3 (or later) — 6.4-2 trait wiring did not
  change it:** the
  migration shim `is_volatile_function` at `crates/ql-exec/src/calcgraph_session.rs:202-207`
  returns `false` for unknown names (preserves pre-substrate behavior); the formula stays
  graph-visible via the normal cell-dep + name-dep paths, but its `is_volatile` flag is the
  conservative `false` rather than the contract's prescribed Volatile/Dynamic. The transient
  unregister→register window therefore can serve a result computed against the unknown-fn
  fallback until the new metadata lands and `fn_gen` invalidates the cache. The substrate-v1
  reasoning is that workspace-trust elevation makes the gap small and predictable (UDFs
  register at trusted-reload events, not live edits); 6.4 will tighten this when UDF metadata
  becomes truly session-scoped. The 6.4-1 cycle-2 audit's H2 doc-honesty correction at
  `function_meta.rs:35-100` describes the actual substrate-v1 gap behavior in detail.

### 10.4 Graph-invalidation model + exit tests (decision-lock §4)
A UDF formula is a normal graph node; args walked + registered as deps via `mark_dirty_from_cell_write`
(fanout `calcgraph_session.rs:~1396-1431`). Default Python UDFs are `Volatile`/`Dynamic` unless
registered pure. `qb.publish()`/`qb.bind()` is the authoritative reactivity contract; `BoundFrame`
edits dirty the **overlay** nodes; connector/file refresh dirties by **source revision**. **Exit tests
(before 6.4 closes):** (1) pure UDF recomputes on referenced-input change; (2) pure UDF does NOT
recompute on unrelated edit; (3) volatile UDF recomputes on recalc/volatile pass; (4) `publish` dirties
dependents; (5) `BoundFrame` overlay edit dirties bound-range formulas; (6) canceled/timed-out UDF
does not commit a late result; (7) failed UDF → deterministic `CellDiagnostic`; **(8, new)** registering
a UDF dirties formulas that referenced its (previously-unknown) name.

> **✅ SHIPPED 2026-05-29 (6.4-4, engine `6b1fdb36578`; 5-way closure megaudit, 0 HIGH).** Proven in
> `crates/ql-exec/tests/udf_exit_tests.rs` as 6 positive exits — (1) `exit_test_1_*` (scalar
> input-change recompute, invocation-counted), (2) `exit_test_2_*` (unrelated-edit no-recompute),
> (3) `exit_test_3_*` (`mark_volatiles_dirty`+`recalc_dirty` re-eval, isolated from a plain recalc),
> (6) `exit_test_6_*` (`Timeout`→`#TIMEOUT!` committed atomically; the process-half kill+drop-late-RETURN
> is enforced in `ql-udf` + exercised by `process_smoke.rs`), (7) `exit_test_7_*` (all 8 diagnostic
> codes incl. `udf_worker_died`/`udf_codec`/`udf_protocol`/`udf_handshake`/`udf_cancelled`, at `Error`
> severity), (8) `exit_test_8_*` (register→dirty→recalc, airtight: `#NAME?`+`calls==0` before
> `recalc_dirty`, `==42`+`calls==1` after). **Tests (4) `publish` and (5) `BoundFrame` are
> reserved-tier capability guards** — `publish_dataset`/`bind_range` are `not_implemented_in_v1_core`
> (§11), so the suite asserts the fail-loud status; the positive dirty-dependents proof lands when
> those producers ship (the cell-dep fanout they generalize is proven by (1)/(8)). v1 reaches the
> timeout half of (6); the cooperative-CANCEL route is not yet driven from the session (its diagnostic
> code IS covered by (7)).

---

> **6.4B code cycle 1 (2026-05-30, engine `fee55b8c719`) -- two new UDF cell-diagnostic codes** beyond the eight proven by exit test 7: **`udf_budget_exhausted`** (cell value `#TIMEOUT!`) -- the operation-level UDF time budget for a recalc pass was spent before this cell, so its UDF was skipped rather than dispatched (bounds the aggregate N x per-call stall; the per-pass budget defaults to 120s, armed only when a worker is attached); and **`udf_grid_too_large`** (cell value `#VALUE!`) -- a UDF arg or return grid exceeded the cell cap (5M cells) or byte cap (64 MiB) and was rejected before allocation. Both at `Error` severity, via the same `CellDiagnostic` sink. Grid caps live in `ql-udf` (`encode_grid`/`decode_grid`); the budget lives in `ql-exec` (`run_recalc` arms it, `scalar::effective_udf_deadline` clamps each call). A host-configurable budget + per-function deadlines over napi are filed forward.

## 11. Per-binding obligations

All bindings are adapters over the same `EngineSession` trait + DTOs; the existing `ql-bindings-node`
becomes an adapter in 6.3.

| Binding | Handle | Async | Error mapping | Release |
|---------|--------|-------|---------------|---------|
| **Node** | `#[napi]` / `Arc<Mutex<WorkbookSession>>` | `async`⇒`Promise`; long ops via op-id | `EngineError`→JS `Error` w/ `.code`/`.class`/`.details` (replaces `[kind]` parse) | GC |
| **Python** (`quantbook-py`) | PyO3 class, GIL-aware | `asyncio` await | → typed exception hierarchy keyed on `class` | GC |
| **C** | opaque ptr + `qb_session_free` | start/poll/wait/cancel | `code`+`class` ints + `qb_last_error()` | **explicit** `qb_release_*` |
| **WASM** | JS handle | Promise | `EngineError`→JS object | JS GC |
| **Service** (6.2 · `ql-service`, HTTP/1.1+SSE on hyper) | session-per-connection (opaque id) | SSE event stream + op-id cancel over the wire | →HTTP `application/problem+json` | connection close + idle-TTL reaping + pluggable auth (6.2-3b) |

**Golden-flow matrix (BND-6-01 / API6-01 enforcement):** one scripted flow — open → set_value →
set_formula → recalc → snapshot → snapshot_delta → register UDF → recalc → cancel a long op →
structured error on bad input → malformed version token → `invalid_version_token` — runs across **every**
binding and must produce byte-identical DTOs + identical `EngineError.code`. This is the concrete test
that one contract backs all bindings.

---

## 12. What 6.1B / 6.1C must do

**6.1B (implement `WorkbookSession`):**
1. Define the `EngineSession` trait (§3) + binding-neutral DTO module (§4) with `schema_version`.
2. Implement `WorkbookSession` owning §2.1; construct `WorkbookRuntime` per-edit internally; **refactor
   `WorkbookRuntime` to borrow a session-owned `PlanCache`** (LOW-1).
3. Make the single-writer `OpLog` mandatory; wire the VV token + the §4.3 `full_rebuild` rules
   (fixing the malformed-token code + docstring drift).
4. Implement `EngineError` + **fill Appendix A exhaustively**; cancellation registry + `Busy` state +
   the §6.4 pre-start-cancel guarantee; panic/validation boundary (§8, `panic="unwind"`); event ring (§9).
5. Wrap `delete/restore/move sheet` fail-loud (MED-3); implement `batch(ops,options)` + the opaque
   transaction handle (HIGH-3); add explicit `undo/redo` (MED-4).
6. **Migrate the Node smoke path** onto `WorkbookSession` (don't freeze the `CollabSession` façade);
   leave collab/transport/presence feature-gated (§3.10).

**6.1C (mandatory security/design audit):** FFI handle safety (no borrowed refs escape; release
discipline), panic-boundary completeness + `Faulted` correctness, lock discipline under concurrent +
`Busy` calls, `EngineError` leaks no internals/secrets, **no silent fallback** (malformed token is
fail-loud), cancellation soundness (UDF worker-kill no-late-commit; in-engine pre-start honored), DTO
version-rejection is fail-loud, and the trait truly backs the Node adapter with no semantic divergence.

---

## 13. Explicitly deferred / open
- **Transport pick (HTTP vs gRPC):** DECIDED 2026-06-01 -- **HTTP/1.1 + SSE on hyper** (`crates/ql-service`, Phase 6.2; the third contract consumer after napi + pyo3). Realizes this contract over the wire with serde DTOs reproducing the napi `FooJson` shapes. 6.2-0 (golden-flow slice) + 6.2-1a (read/format/validate/query + persistence) + 6.2-1b (structure/sheets + tables) + 6.2-1c (atomic/txn + reserved §3.5 bulk Capability stubs + undo/redo + `snapshotDelta` via `hex_decode` + functions) + 6.2-2 (the operations/events surface: the M2 split-recalc `startRecalc`/`awaitRecalc`, op-id `cancel`/`operationStatus`, `pollEvents`, and the SVC-6-02 long-lived `text/event-stream` events endpoint) shipped -- **6.2-1 COMPLETE + SVC-6-02/SVC-6-03 closed; ALL 53 contract methods now reachable over the wire**; 6.2-3a (request-path hardening: a request-body size cap on both read paths + a Content-Length preflight, x-ql-schema-version echo + mismatch -> unsupported_schema_version, RFC-correct 405 + Allow) shipped; 6.2-3b (pluggable auth trait + unguessable CSPRNG session ids + idle-TTL reaping) shipped -- 6.2-3 COMPLETE; **6.2-4 (golden-parity 3rd "service" row + ECMAScript number serializer + closure megaudit) shipped -- Phase 6.2 COMPLETE.** Reserved-bulk `data` crosses as JSON TEXT (a string), mirroring the napi `serde-json`-off convention; the SSE stream forwards the event ring via a poll-based loop (`poll_events` cursor; a push/notify upgrade is future work). See `docs/phase6/6-2-entry-plan.md`. **Number-encoding divergence RESOLVED (6.2-4):** integer-valued `number` fields now render `6` (was serde `6.0`), signed zero `0` (was `-0.0`), and `1e+21`/`1e-7` at the ECMAScript exponent boundaries -- via the `ryu-js` crate (V8-faithful, including the shortest-decimal tie-break) emitted as an unquoted token through a `serde_json::RawValue` adapter on `CellValueWire.number`; the service wire is byte-identical to the napi row (proven by the parity matrix's service-vs-node byte gate). Non-finite → serde error → 500.
- **`AI()`:** deferred; `AINotAvailable` sentinel + reserved provider boundary; `=AI()` **cell function
  is v2-aligned**. Provenance DTOs (§9) shaped now.
- **Collaborative multi-user layer (CRDT merge/transport/presence):** v1.5 (Product Phase 9), on top of
  the same op-log. A future collaborative table producer MUST land conflict-resolution + `removed_cells`
  (Phase 5 EC#2).
- **Staged in-engine recalc** (mid-flight hard cancel, §6.3) + **rollback-atomic replay** (§3.4): post-6.1
  compute-core refactors.
- **`CellValueJson` discriminated-union retype** (TS): closures.md §5 item 2.

---

## Appendix A — error variant → code mapping (MED-1; 6.1B fills exhaustively)

Skeleton; 6.1B enumerates every variant from the real enums and locks `{class, code, retryable}`.
Ambiguities Codex flagged, resolved here:

| Source enum (variant) | class | code | retryable |
|-----------------------|-------|------|-----------|
| `RuntimeError::InvalidSheet` | `NotFound` | `sheet_not_found` | no |
| `RuntimeError::InvalidCell` | `BadArgument` | `bad_cell` | no |
| `RuntimeError::TableCreateRejected` | `Conflict` | `table_create_rejected` | no |
| `RuntimeError::TableResizeRejected` | `BadArgument` | `table_resize_rejected` | no |
| `RuntimeError::TableColumnRejected` | `Conflict` | `table_column_rejected` | no |
| `ReplayError::FormatNotRegistered` | `Protocol` | `format_not_registered` | no |
| `ReplayError::InvalidSheet`/`InvalidCell` | `Protocol` | `replay_invalid_target` | no |
| `OpLogError::{Serialize}` | `BadArgument` | `oplog_serialize` | no |
| `OpLogError::{Deserialize,SchemaMismatch,InvalidVersionVector}` | `Protocol` | `oplog_*` | no |
| `OpLogError::{Loro,LoroEncode}` | `Internal` | `oplog_loro` | no |
| `OpLogError` (future `#[non_exhaustive]` variant) | `Internal` | `unmapped_oplog_error` | no |
| `PersistenceError::{Qbook, OpLog, OplogUnsupportedVersion, OplogTruncatedHeader}` | `Persistence` | `qbook_error` / `session_oplog` / `qbook_unsupported_version` / `qbook_truncated_header` | no |
| `PersistenceError` (foreign `#[non_exhaustive]` future variant) | `Internal` | `unmapped_persistence_error` (loud — never a generic `qbook_unknown` to callers) | no |
| `XlsxError::{Io, Zip, Calamine, XmlParse, MalformedOoxml, UnsupportedFeature}` (inc.2c-10 xlsx `import`; inc.2c-12 xlsx `export`) | `Persistence` | `xlsx_io` / `xlsx_zip` / `xlsx_calamine` / `xlsx_xml_parse` / `xlsx_malformed_ooxml` / `xlsx_unsupported_feature` | no |
| `XlsxError::{Export, Engine}` (incl. inc.2c-12 `export("xlsx")` umya-write failures) | `Internal` | `xlsx_export` / `xlsx_engine` | no |
| `XlsxError` (foreign `#[non_exhaustive]` future variant) | `Internal` | `unmapped_xlsx_error` (loud) | no |
| `CsvError::{Io, Parse}` (inc.2c-11, csv `import`/`export`) | `Persistence` | `csv_io` / `csv_parse` (non-UTF-8 surfaces as `csv_parse`) | no |
| `CsvError::ExceedsSheetLimits` | `BadArgument` | `csv_exceeds_limits` (CSV larger than `MAX_ROW`/`MAX_COLUMN`) | no |
| `CsvError::SheetNotFound` | `Internal` | `csv_sheet_not_found` (session selects the sheet → invariant break) | no |
| `CsvError` (foreign `#[non_exhaustive]` future variant) | `Internal` | `unmapped_csv_error` (loud) | no |
| `FunctionRegistryError::Conflict` (6.4-1 cycle-1; ✅ wired by 6.4-2 `register_function`/`unregister_function` — wire-live to IDE allowlist) | `Conflict` | `function_exists` | no |
| `FunctionRegistryError::NotFound` (6.4-1 cycle-1; ✅ wired by 6.4-2 `unregister_function` — wire-live to IDE allowlist) | `NotFound` | `function_not_found` | no |
| `TransportError::*` | `Capability`/`Internal` | `transport_*` (e.g. `transport_closed`) | maybe |
| `CollabSessionError::{OpLog,Presence,Undo,Replay,Transport}` | per inner | `session_*` / inner kind | per inner |
| version token decode failure | `Protocol` | `invalid_version_token` | no |
| panic caught at boundary | `Internal` | `panic` | no |
| operation canceled / deadline | `Canceled` | `canceled` / `deadline_exceeded` | yes |
| batch/txn: >1 value/formula op on one cell (inc.2c-4) | `Conflict` | `conflicting_batch_ops` | no |
| txn handle not open: unknown / already committed / rolled-back / dropped at close (inc.2c-5) | `NotFound` | `transaction_not_found` | no |
| txn id space exhausted — 2^64 `begin`s in one session (inc.2c-5; loud, never wraps) | `Internal` | `transaction_id_exhausted` | no |
| Loro `UndoManager::undo`/`redo` internal failure (inc.2c-7; empty stack is `consumed:false`, NOT this) | `Internal` | `undo_manager_failed` | no |
| op-log replay failure during undo/redo re-materialization (inc.2c-7) | `Internal` | `replay_failed` | no |

**Implementation-reality note (6.1B inc.2 audit, 2026-05-27 — F8):** the earlier draft
split `InvalidSheet` and `TableCreateRejected` by *cause*, but the real enums do not
carry that context, so the mapping is honest about what it can distinguish:
- **`InvalidSheet` → `NotFound`/`sheet_not_found` uniformly.** The variant is
  `{sheet, sheet_count}` with no producer context. The "FFI arg coercion →
  `BadArgument`" case is caught at the **binding boundary** (argument validation,
  `bad_argument`) and never produces `RuntimeError::InvalidSheet`, so a uniform
  `NotFound` at the engine layer is correct. The session's own
  `require_live_sheet`/range guards reject most bad ids before the runtime.
- **`TableCreateRejected` → `Conflict`/`table_create_rejected` uniformly.** The
  variant carries only `reason: &'static str`; a dup-name-vs-bad-spec split would
  require string-matching the reason (brittle). TRACKED follow-up: introduce typed
  `TableCreateRejected` sub-variants, then split to `table_exists` (Conflict) vs
  `bad_table_spec` (BadArgument).
- **`OpLogError` `#[non_exhaustive]` wildcard.** Rust *requires* a wildcard arm for a
  foreign `#[non_exhaustive]` enum, so a future variant cannot be matched exhaustively.
  The wildcard maps to a **coded** `Internal`/`unmapped_oplog_error` (loud, never a
  generic `qbook_unknown`) — No-Fallbacks-compliant: it surfaces as a bug to fix, not
  a silent swallow. All *current* `OpLogError` variants are mapped explicitly above.
- Implemented as the free fns `ql-exec::session::{map_runtime_err, map_oplog_err}`
  (orphan rules forbid `impl From<…> for EngineError`); the `RuntimeError` match is
  in-crate + exhaustive (no wildcard) → a new variant is a compile error.

---

## 14. Appendix B — existing napi method → contract command (bottom-up provenance)

| napi (`CollabSession`) | Contract command | Tier |
|------------------------|------------------|------|
| `appendPutValue`/`appendPutFormula` | `set_value`/`set_formula` | v1 |
| `addSheet`/`renameSheet`/`deleteSheet`/`restoreSheet`/`moveSheet` | §3.3 structure ops (fail-loud) | v1 |
| `workbookSnapshot`/`workbookSnapshotDelta` | `snapshot`/`snapshot_delta` | v1 |
| `exportSnapshot` | (legacy; subsumed by `snapshot`/`query_range`) | deprecate |
| `listSheets` | `list_sheets` | v1 |
| `undo`/`redo` | `undo`/`redo` (§3.8) | v1 |
| `from_qbook`/`to_qbook` | `open`/`save` | v1 |
| `attach/detach/flush*/pollRemote*`/`export/mergeBytes` | (collab transport) | v1.5 (§3.10) |
| `updatePresence`/`peerPresence`/`clearPresence`/`sweepPresence` | (collab presence) | v1.5 (§3.10) |
| `setAutoFlushPolicy`/`autoFlushPolicy` | (collab policy) | v1.5 (§3.10) |
| *(none today)* | `cancel`/`operation_status`/`subscribe_events`/`poll_events` | v1 (new) |
| `registerFunction`/`unregisterFunction`/`listFunctions` (owning `Session`) | `register_function`/`unregister_function`/`list_functions` | v1 ✅ (6.4-2) |
| *(none today)* | `write_range`/`materialize_query`/`refresh_source` | v1 ✅ (6.5-0 / 6.5-1 / 6.5-2) |
| *(none today)* | `publish_dataset`/`bind_range` | reserved (6.4 — `qb.publish()`/`qb.bind()`) |
| *(none today)* | `begin/commit/rollback_transaction`, `query_range` | v1 |
