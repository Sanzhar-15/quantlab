# Engine Session API — Stable Contract (Phase 6.1A)

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
   is deferred to 6.2.
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
| `open(path)` / `import(bytes, format)` | v1 | `from_qbook` (`lib.rs:2883`), Phase 4 importers |
| `save(path)` / `export(format) -> bytes` | v1 | `to_qbook` (`lib.rs:2076`), exporters |
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

### 3.5 Bulk data / publish / bind (HIGH-4 — reserved-stable shapes; implemented 6.4/6.5)
Reserved now so 6.4 (Python UDFs) and 6.5 (SQL/connectors) extend the shared trait instead of forking
product-specific APIs (the #1 risk). Dirtying + provenance behavior is part of the lock:

| Command | Tier | Purpose / dirtying |
|---------|------|--------------------|
| `write_range(range, values, options) -> WriteRangeResult` | reserved (6.4/6.5) | Bulk write a rectangular value matrix / Arrow batch; dirties dependents of the written range |
| `publish_dataset(name, data, target, provenance) -> PublishedRef` | reserved (6.4) | `qb.publish()` — materialize a DataFrame/table into a sheet/table; dirties dependents; carries provenance (§9) |
| `bind_range(binding_id, target, schema, options) -> BoundRange` | reserved (6.4) | `qb.bind()` — overlay a `BoundFrame` onto a range/table; overlay edits dirty bound-range formulas |
| `refresh_source(source_id, revision) -> DirtyResult` | reserved (6.5) | external source refresh; dirties dependents by **source revision** |
| `materialize_query(query_id, target, data, provenance) -> PublishedRef` | reserved (6.5) | SQL result → sheet/table with provenance |

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
| `recalc_dirty() -> op_id` | v1 | `WorkbookRuntime::recompute_dirty` (synchronous, Tarjan-SCC) | **pre-start cancel only** in v1 (§6.4) |
| `recalc_all() -> op_id` | v1 | `WorkbookRuntime::recompute_all` (synchronous) | **pre-start cancel only** in v1 (§6.4) |
| `mark_volatiles_dirty()` | v1 | volatile pass (`calcgraph_session.rs:149`) | — |

### 3.8 Undo / redo (MED-4 — explicit v1 commands)
| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `undo() -> UndoResult{consumed, op_id?, version}` | v1 | `CollabSession::undo` (`lib.rs:1888`) | empty stack → `consumed:false` (NOT an error); **clears the delta cache** (force full rebuild next snapshot_delta) |
| `redo() -> RedoResult{consumed, op_id?, version}` | v1 | `redo` (`lib.rs:1901`) | same |
| `can_undo() -> bool` / `can_redo() -> bool` | v1 | stack depth | for product UI |

*(Single-writer undo is v1; cross-peer undo-group **merge** semantics are the v1.5 part.)*

### 3.9 Functions / diagnostics / events / cancellation
| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `register_function(metadata, impl_handle)` | v1 contract / 6.4 impl | `FunctionRegistry` + §10 | collision + invalidation rules in §10 |
| `unregister_function(canonical_name)` | v1 contract / 6.4 impl | `FunctionRegistry` | dirties referencing formulas (§10) |
| `list_functions() -> [FunctionMetadata]` | v1 contract / 6.4 impl | `FunctionRegistry` | built-ins + UDFs |
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

### 4.2 Core DTOs (extracted from the proven `#[napi(object)]` structs; `+` = added/clarified)
- **`CellValue`** (← `CellValueJson`, `lib.rs:580`): a **discriminated union** on `kind`
  (`number`/`boolean`/`text`/`error`/`blank`/`pending`), exactly one payload. Bindings narrow on `kind`.
  `blank` (added 6.1B inc.2c) maps from `ql_types::Value::Blank` — needed so a columnar `query_range`
  read can represent empty cells in a fixed-size column; snapshots still omit blanks
  (`CellSnapshot.value: None`). *(TS mirror retype scoped: closures.md §5 item 2 — must add `blank`.)*
- **`CellAddress`** `{sheet,row,col}`, **`Range`** `{sheet,start_row,start_col,end_row,end_col}`.
- **`FormatId`** (← `FormatIdJson`): `builtin(u32)` | `custom(peer,counter)`. **`FormatDef`** `{id,string}`.
- **`CellSnapshot`** (← `CellSnapshotJson`): `{row,col,value?,formula?,format?,rendered?}`.
- **`SheetSnapshot`** / **`SheetInfo`** `{id,name}`.
- **`WorkbookSnapshot`** (← `WorkbookSnapshotJson`): `{sheets[],formats[],date_system,version}`.
- **`WorkbookSnapshotDelta`** (← `WorkbookSnapshotDeltaJson`): `{changed_cells[],removed_cells[],
  sheets_changed[],sheets_removed[],formats_added[],version,full_rebuild_required,full_rebuild_reason?}`
  *(+`full_rebuild_reason`, MED-2)*.
- **`RangeResult`** *(+ MED-5)*: `{schema_version, range, n_rows, n_cols, layout:"columnar",
  columns:[{values: CellValue[] | ArrowHandle}], include:{formulas?,formats?,rendered?}}`. **Columnar**
  (Arrow-friendly); null/pending/error encoded inside `CellValue`. One shape across all bindings.
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
`CollabSessionError`) to `{class, code, retryable}`. 6.1B fills it exhaustively from the real enums.

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

### 10.1 The gap today
`FunctionRegistry` (`ql-functions/src/registry.rs`) stores **dispatch only** (`RegisteredFn` enum;
panics on duplicate at `:188`, uppercases lookups at `:281`). Volatility + reference-shape are **two
hardcoded whitelists** in `calcgraph_session.rs` (`is_volatile_function` `:149-164`;
`is_address_only_reference_fn` `:201-203`). Critically, `FormulaDeps` (`calcgraph_session.rs:~213`) has
`cells/named_ranges/names/tables/is_volatile` but **no `functions_used`** — so there is no reverse
index from a function name to the formulas that call it. A Python UDF cannot be added to a hardcoded
`match`, and a registration/metadata change cannot dirty its callers → silent graph bypass.

### 10.2 `FunctionMetadata` (built in 6.4-0; v1 DTO now)
```
FunctionMetadata {
  canonical_name: String,        // ASCII-UPPERCASE, matches parser canonicalization (ast.rs:54)
  display_name: String?, aliases: [String]?,   // documented Unicode/alias policy
  arity: Arity, volatility: Volatility,         // Pure | Volatile | Dynamic
  determinism: bool, dep_shape: DepShape,       // Value-deps | AddressOnly | Custom(explicit deps)
  batch_shape: BatchShape,                       // Scalar | Arrow/array batch (UDFs: batch from day one)
  arg_policy: ArgPolicy, cancellation: CancelPolicy,  // cooperative | worker-kill
  provenance_tags: [String],
}
```
The two hardcoded whitelists become **derived** from registered metadata (built-ins register their
true metadata; the whitelists remain only as a migration shim).

### 10.3 Registration + invalidation rules (HIGH-5)
- **Canonical name:** ASCII-uppercase; `register_function` normalizes + validates against the parser's
  canonicalization. Unicode/alias policy documented.
- **Collision rules:** `register_function` **returns an error** (not a panic) on collision with a
  built-in, an existing UDF, or (if applicable) a name/table — `EngineError{class:Conflict,
  code:"function_exists"}`.
- **`functions_used` reverse index** *(new `FormulaDeps` field + graph map)*: the dep walker records
  each function a formula calls; the graph keeps `function -> [formula nodes]`.
- **Invalidation:** `register_function` / `unregister_function` / metadata-update **dirties every
  formula referencing that canonical name** (re-extract deps + reschedule). This also covers formulas
  that bound while the name was **unknown** and become valid on registration.
- **Unknown-function policy:** a formula referencing an unregistered name is **graph-visible and
  treated Volatile/Dynamic** (never silently Pure), so it recomputes once the UDF appears.

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

---

## 11. Per-binding obligations

All bindings are adapters over the same `EngineSession` trait + DTOs; the existing `ql-bindings-node`
becomes an adapter in 6.3.

| Binding | Handle | Async | Error mapping | Release |
|---------|--------|-------|---------------|---------|
| **Node** | `#[napi]` / `Arc<Mutex<WorkbookSession>>` | `async`⇒`Promise`; long ops via op-id | `EngineError`→JS `Error` w/ `.code`/`.class`/`.details` (replaces `[kind]` parse) | GC |
| **Python** (`quantbook-py`) | PyO3 class, GIL-aware | `asyncio` await | → typed exception hierarchy keyed on `class` | GC |
| **C** | opaque ptr + `qb_session_free` | start/poll/wait/cancel | `code`+`class` ints + `qb_last_error()` | **explicit** `qb_release_*` |
| **WASM** | JS handle | Promise | `EngineError`→JS object | JS GC |
| **Service** (6.2) | session-per-connection | streaming (SSE/gRPC); op-id cancel over the wire | →HTTP problem+json / gRPC status+details | connection close |

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
- **Transport pick (HTTP vs gRPC):** 6.2 (default HTTP+SSE if forced).
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
| `RuntimeError::InvalidSheet` (mutation target absent) | `NotFound` | `sheet_not_found` | no |
| `RuntimeError::InvalidSheet` (FFI arg coercion) | `BadArgument` | `bad_argument` | no |
| `RuntimeError::TableCreateRejected` (dup name) | `Conflict` | `table_exists` | no |
| `RuntimeError::TableCreateRejected` (bad spec) | `BadArgument` | `bad_table_spec` | no |
| `ReplayError::FormatNotRegistered` | `Protocol` | `format_not_registered` | no |
| `ReplayError::InvalidSheet`/`InvalidCell` | `Protocol` | `replay_invalid_target` | no |
| `OpLogError::*` | `Persistence`/`Protocol` | `oplog_*` | no |
| `PersistenceError::{Qbook,Oplog,UnsupportedVersion,TruncatedHeader}` | `Persistence` | `qbook_error`/`session_oplog`/`qbook_unsupported_version`/`qbook_truncated_header` | no |
| `PersistenceError` (any future variant) | — | **must be added explicitly** (no `qbook_unknown` to callers) | — |
| `TransportError::*` | `Capability`/`Internal` | `transport_*` (e.g. `transport_closed`) | maybe |
| `CollabSessionError::{OpLog,Presence,Undo,Replay,Transport}` | per inner | `session_*` / inner kind | per inner |
| version token decode failure | `Protocol` | `invalid_version_token` | no |
| panic caught at boundary | `Internal` | `panic` | no |
| operation canceled / deadline | `Canceled` | `canceled` / `deadline_exceeded` | yes |

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
| *(none today)* | `register_function`/`unregister_function`/`list_functions` | v1 contract / 6.4 impl |
| *(none today)* | `write_range`/`publish_dataset`/`bind_range`/`refresh_source`/`materialize_query` | reserved (6.4/6.5) |
| *(none today)* | `begin/commit/rollback_transaction`, `query_range` | v1 |
