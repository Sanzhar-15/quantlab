# Engine Session API — Stable Contract (Phase 6.1A)

**Status:** ✅ DRAFTED 2026-05-26 (6.1A, design-before-code). This is the canonical
contract that **6.1B** (`WorkbookSession` implementation) builds against and that **6.3**
bindings (Node/WASM/C/Python) + **6.2** service all bind to. It is the API6-01 deliverable
("one Rust trait/API backs all bindings") and the gate document for 6.1C (security/design audit).

**Basis:** Phase 6 decision-lock (`docs/phase6/decision-lock.md`) §3 (7 things 6.1 must lock) + §4
(UDF graph-invalidation model) + MASTER-PLAN §725-728 (6.1 sub-item) + §778-782 (Phase 6 exit
criteria). Bottom-up-extracted from the **proven napi `CollabSession` surface** + the single-writer
`WorkbookRuntime` compute path — NOT invented. Every design claim below is anchored to real code.

**Scope discipline (load-bearing):** this contract defines the **product session** — a *single-writer*
owning session (`WorkbookSession`) around `WorkbookRuntime`. The multi-user collaborative layer
(`CollabSession` CRDT / op-log / transport / presence / undo-group) is **v1.5-deferred** (Engine
Phase 5 = Product Phase 9). The existing napi surface happens to be `CollabSession` because the IDE
vertical slice was built on collab for the multi-window demo; 6.1B **re-founds the command shapes on
`WorkbookSession`** and the collab façade becomes an *optional capability*, not the v1 product API.
Do **not** freeze the `CollabSession` CRDT surface as the stable contract (decision-lock §1 D1, §2.3).

---

## 0. Acceptance criteria (what this contract must satisfy)

| ID | Criterion (MASTER-PLAN §730) | Where addressed |
|----|------------------------------|-----------------|
| **API6-01** | One Rust trait/API backs all bindings | §2 (trait), §3 (commands), §11 (per-binding obligations) |
| **API6-02** | Cancellation is a first-class part of the API | §6 (operation lifecycle + cancellation) |
| **API6-03** | Errors are structured | §5 (`EngineError` taxonomy) |

Additional locks the decision-lock requires this doc to carry (§3): ownership/lifetime (§2),
command surface ≠ collab op variants (§3), sync-vs-async discipline (§7), panic/validation boundary
(§8), versioned DTOs (§4), function-metadata + graph-invalidation contract (§10).

---

## 1. Design principles

1. **One contract, many transports.** The session is defined by a Rust trait (`EngineSession`) +
   a set of versioned DTOs. Bindings (Node/WASM/C/Python) and the service (HTTP/gRPC) are *thin
   adapters* that marshal the same DTOs and map the same `EngineError`. No binding invents its own
   command, error, or event semantics.
2. **Transport-neutral.** The contract bakes in **no** napi-only / HTTP-only / gRPC-only assumption
   (decision-lock §1 D2). Identifiers, version tokens, cancellation handles, and error envelopes are
   plain owned data that survive any wire. The HTTP-vs-gRPC pick is deferred to 6.2.
3. **Opaque handles, owned results.** FFI holds an opaque session handle. **No borrowed Rust
   reference crosses an FFI boundary.** Every result is an owned snapshot / buffer / Arrow handle
   with explicit lifetime; version tokens and operation IDs are opaque byte/integer blobs the caller
   round-trips without interpreting.
4. **Bottom-up, then trimmed.** The command set is extracted from the workflows the IDE already
   exercises through napi (`appendPutValue`, `workbookSnapshot`, `workbookSnapshotDelta`, sheet ops,
   undo/redo), then generalized to a product-neutral shape and extended with the cancellation /
   diagnostics / function-metadata machinery that v1 product surfaces (UDF/SQL/AI) require.
5. **Errors are visible, never swallowed.** Per the project No-Fallbacks rule: every fallible command
   returns `Result<_, EngineError>`. The only structured "recovery" signal is the *explicit, designed*
   `full_rebuild_required` re-fetch protocol on snapshot-delta (§4.3) — that is a protocol state, not
   a swallowed error.
6. **Shape the future now.** Event / diagnostic / provenance / operation-state DTOs are versioned and
   shaped in 6.1 even though UDF (6.4) / SQL (6.5) / AI (6.6) are later — so those surfaces extend an
   existing tracing contract rather than inventing incompatible ones (decision-lock §5).

---

## 2. Ownership & lifetime model

### 2.1 The owning session (`WorkbookSession`)

The engine code already anticipates this exact consolidation. From
`crates/ql-exec/src/calcgraph_session.rs:69-71`:

> *"Phase 6.1 `WorkbookSession` will absorb Workbook + OpLog + CalcgraphSession + PlanCache +
> FunctionRegistry into ONE owning struct that the binding crate can wrap cleanly (per GAP-PS-09).
> Today they're separate to keep refactor scope bounded."*

`WorkbookSession` (implemented in 6.1B, in `ql-exec` or a new `ql-session` crate) **owns**:

| Owned component | Source today | Role |
|-----------------|--------------|------|
| `Workbook` | `ql-storage` | Cell/sheet/table/name/format storage |
| `OpLog` (optional) | `ql-oplog` | Edit history → undo/redo, save/load, optional collab |
| `CalcgraphSession` | `ql-exec/src/calcgraph_session.rs` | Dependency graph + dirty propagation |
| `PlanCache` | `ql-exec` (bind-plan cache) | Compiled formula plans (`cache_stats`) |
| `FunctionRegistry` | `ql-functions/src/registry.rs` | Built-in + custom (UDF) function dispatch + metadata (§10) |
| **Cancellation registry** | *new in 6.1* | Operation-ID → cancel-token / deadline / terminal-state map (§6) |
| **Event queue** | *new in 6.1* | Structured diagnostics/events drained by subscribers (§9) |

Today these are constructed per-edit via `WorkbookRuntime::with_oplog_and_graph(workbook, registry,
oplog, graph)` (a per-edit borrow window, `workbook_runtime/mod.rs`). 6.1B inverts that: the session
owns them for its lifetime and constructs the per-edit `WorkbookRuntime` borrow *internally*, so the
borrow window never crosses FFI.

### 2.2 FFI handle contract

- A binding obtains an **opaque handle** to a `WorkbookSession` (Node: a `#[napi]` class wrapping
  `Arc<Mutex<WorkbookSession>>`, mirroring today's `CollabSession`; C: an opaque pointer + explicit
  `qb_session_free`; WASM: a JS-owned handle; Python: a PyO3 class).
- **No method returns a borrowed Rust ref across FFI.** Snapshots/ranges are owned DTOs; large
  tabular results are owned buffers or Arrow `RecordBatch` handles with explicit release (the C ABI
  must expose `qb_release_*`; managed bindings release on GC).
- Handles are **not** `Send` across threads by accident: the session is single-owner; concurrency is
  mediated by the binding's lock (§7), never by sharing a raw `&WorkbookSession`.

### 2.3 Lifecycle states

A session is always in exactly one lifecycle state; commands are gated on it:

```
New ──open/import──▶ Ready ──(edit/recalc/query)──▶ Ready
  │                    │
  │                    ├──save/export──▶ Ready (persisted)
  │                    └──close────────▶ Closed (handle freed)
  └──(error before Ready)──▶ Faulted (terminal; only diagnostics + close)
```

`Closed` and `Faulted` are terminal. Every command documents which states it is legal in; calling a
command in an illegal state returns `EngineError { class: Lifecycle, code: "invalid_state", … }`
(§5), never a panic.

---

## 3. Command surface

The command set is **product commands**, not collab `Op` variants (decision-lock §3.2). It maps onto
the proven `WorkbookRuntime` mutators + the napi workflows the IDE exercises. Columns:
**v1** = in the 6.1 stable contract; **v1.5** = collab-only, deferred; **future** = reserved shape only.

### 3.1 Lifecycle / persistence

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `new(options)` | v1 | `CollabSession::new` / `WorkbookRuntime::new` | Fresh empty workbook |
| `open(path)` / `import(bytes, format)` | v1 | `from_qbook` (`lib.rs:2883`), Phase 4 importers | `.qbook`, xlsx/csv via Phase 4 |
| `save(path)` / `export(format) -> bytes` | v1 | `to_qbook` (`lib.rs:2076`), exporters | Owned bytes result |
| `close()` | v1 | handle free | → `Closed` |

### 3.2 Mutation (single edits)

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `set_value(addr, value)` | v1 | `WorkbookRuntime::set_value` ↔ `appendPutValue` (`lib.rs:1578`) | Literal; clears formula |
| `set_formula(addr, text)` | v1 | `WorkbookRuntime::set_formula` ↔ `appendPutFormula` (`lib.rs:1651`) | lex+parse+bind+eval |
| `clear(addr)` | v1 | `WorkbookRuntime::clear_formula` | Clears formula, keeps/clears value per spec |
| `set_format(addr, format_id)` | v1 | `SetCellFormat` op / format table | |
| `register_format(format_string) -> format_id` | v1 | `RegisterFormat` op | Session-wide format table |
| `validate_formula(addr, text) -> diagnostics` | v1 | `WorkbookRuntime::validate_formula` | Parse+bind, **no mutation** (keystroke path) |

### 3.3 Mutation (structure)

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `add_sheet(name, chunk_rows)` | v1 | `addSheet` (`lib.rs:1257`) | |
| `rename_sheet(id, name)` | v1 | `renameSheet` (`lib.rs:1328`) | |
| `delete_sheet(id)` | v1 | `deleteSheet` (`lib.rs:1409`) | Tombstone |
| `restore_sheet(id)` | v1 | `restoreSheet` (`lib.rs:1473`) | |
| `move_sheet(id, index)` | v1 | `moveSheet` (`lib.rs:1548`) | Display-order overlay |
| `set_name(name, target)` | v1 | `SetName` op / `WorkbookRuntime` names | Defined names |
| table ops: `create_table`/`rename_table`/`rename_column`/`resize_table`/`drop_table` | v1 (single-writer) | `WorkbookRuntime` tables (`workbook_runtime/tables.rs`) | **Single-writer only.** Collaborative table-merge is DEFERRED (Phase 5 EC#2 amendment) — no collaborative table producer exists; a future one MUST land conflict-resolution + `removed_cells`. |

### 3.4 Batch / transaction

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `batch(ops) -> result` | v1 | `BatchCommit` op | **Atomic**: all-or-nothing; on any error the whole batch is rejected with the failing op's `EngineError` + its index in `details`. No partial application. |
| `transaction(scope)` | v1 | undo-group machinery (`start/end_undo_group`) | Groups edits into one undo unit; RAII `UndoGroupGuard` analog (`session.rs` scoped guard). |

### 3.5 Recalculation

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `recalc_dirty() -> op_id` | v1 | `WorkbookRuntime::recompute_dirty` (Tarjan-SCC incremental) | Long op → cancellable (§6) |
| `recalc_all() -> op_id` | v1 | `WorkbookRuntime::recompute_all` | Long op → cancellable |
| `mark_volatiles_dirty()` | v1 | volatile pass (`calcgraph_session.rs:149`) | Forces NOW/RAND/etc. re-eval |

### 3.6 Query / snapshot

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `query_range(range) -> RangeResult` | v1 | snapshot accessors / Arrow | Owned; batch-shaped (never per-cell) |
| `snapshot() -> WorkbookSnapshot` | v1 | `workbookSnapshot` (`lib.rs:2141`) | Full; carries opaque `version` token |
| `snapshot_delta(last_version) -> WorkbookSnapshotDelta` | v1 | `workbookSnapshotDelta` (`lib.rs:2498`) | Incremental; `full_rebuild_required` re-fetch (§4.3) |
| `cell(addr) -> CellSnapshot?` | v1 | `snapshot_cell` (`session.rs`) | O(1) single cell |
| `list_sheets() -> [SheetId]` | v1 | `listSheets` (`lib.rs:1839`) | |

### 3.7 Custom functions (UDF) — registration surface, executed in 6.4

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `register_function(metadata, impl_handle)` | v1 contract / 6.4 impl | `FunctionRegistry` + §10 metadata | Batch-shaped call ABI from day one |
| `unregister_function(name)` | v1 contract / 6.4 impl | `FunctionRegistry` | |
| `list_functions() -> [FunctionMetadata]` | v1 contract / 6.4 impl | `FunctionRegistry` | Includes built-ins + UDFs |

### 3.8 Diagnostics / events / cancellation

| Command | Tier | Backed by | Notes |
|---------|------|-----------|-------|
| `subscribe_events() -> EventStream` | v1 | *new* event queue (§9) | Diagnostics, recalc progress, cell errors, provenance |
| `poll_events(since) -> [Event]` | v1 | *new* event queue | Pull model for sync FFI (§9) |
| `cancel(op_id) -> bool` | v1 | *new* cancellation registry (§6) | Cooperative cancel |
| `operation_status(op_id) -> OperationState` | v1 | *new* cancellation registry | `Running`/`Completed`/`Canceled`/`Failed` |

### 3.9 Explicitly NOT in the v1 product contract (collab / v1.5)

These exist on today's napi `CollabSession` but are **collaborative-layer** concerns, deferred to
v1.5 (Product Phase 9). They are an *optional capability* (feature-gated), not the product API:
`attachTransport`/`detachTransport`/`flush*ToTransport`/`pollRemote*`/`exportBytes`/`mergeBytes`
(transport+CRDT sync), `updatePresence`/`peerPresence`/`clearPresence`/`sweepPresence`
(presence), `setAutoFlushPolicy` (transport policy). Undo/redo **is** v1 (single-writer undo);
the cross-peer undo-group merge semantics are the v1.5 part.

---

## 4. DTOs & versioning

### 4.1 Versioning rule

Every DTO crossing the contract carries an explicit schema version (a `schema_version: u16` field,
or the envelope's `protocol_version`). Bindings reject a DTO whose version they don't understand with
`EngineError { class: Protocol, code: "unsupported_schema_version" }` — never silently coerce. This
generalizes the `.qbook` `snapshot_format_version` already used for on-disk forward-compat and the
op wire sub-enum `Unknown` arms (Phase 5 megaudit: top-level `Op` uses `deny_unknown_fields`, so
unknown op kinds reject at decode by design — the same fail-loud posture).

### 4.2 Core DTOs (extracted from the proven napi `#[napi(object)]` structs)

The existing JSON DTOs are the v1 starting shapes; 6.1B adds `schema_version` and re-homes them in a
binding-neutral module. Listed with their current source struct:

- **`CellValue`** (← `CellValueJson`, `lib.rs:580`): a **discriminated union** on `kind`
  (`number`/`boolean`/`text`/`error`/`pending`) with exactly one payload. *Contract note:* the
  TS mirror is currently a loose bag (kind + 4 optional payloads); the discriminated-union retype is
  scoped (megaudit closures.md §5 item 2). The contract specifies the **union** as authoritative —
  bindings must narrow on `kind`.
- **`CellAddress`** (`{sheet, row, col}`) and **`Range`** (`{sheet, start_row, start_col, end_row,
  end_col}`): versioned address/range DTOs (today implicit in op args; promoted to first-class).
- **`FormatId`** (← `FormatIdJson`, `lib.rs:660`): discriminated union `builtin(u32)` | `custom(peer,
  counter)`. **`FormatDef`** (← `FormatDefJson`): `{id, string}`.
- **`CellSnapshot`** (← `CellSnapshotJson`, `lib.rs:719`): `{row, col, value?, formula?, format?,
  rendered?}`.
- **`SheetSnapshot`** (← `SheetSnapshotJson`): `{id, name, cells[]}`.
- **`WorkbookSnapshot`** (← `WorkbookSnapshotJson`, `lib.rs:843`): `{sheets[], formats[], date_system,
  version}`. `version` is an **opaque** byte token (today a Loro `VersionVector` `Buffer`) — callers
  round-trip it verbatim; the contract forbids interpreting it.
- **`WorkbookSnapshotDelta`** (← `WorkbookSnapshotDeltaJson`, `lib.rs:1018`): `{changed_cells[],
  removed_cells[], sheets_changed[], sheets_removed[], formats_added[], version,
  full_rebuild_required}`.
- **`FunctionMetadata`** (§10): the new per-function descriptor.
- **`Diagnostic` / `Event` / `OperationState` / `EngineError`** (§5/§6/§9): the new tracing DTOs.

### 4.3 The `full_rebuild_required` re-fetch protocol (a designed state, not a fallback)

`snapshot_delta(last_version)` returns `full_rebuild_required: true` when the engine cannot produce a
sound incremental delta from `last_version` (e.g., the cache was force-cleared by a merge/undo, or
the version is older than the cache horizon). The caller MUST then call `snapshot()` and reseed.
This is an explicit protocol branch (the IDE already implements it in `acquireWorkbookSnapshotViaDelta`),
**not** an error and **not** a hidden resync — there is deliberately no periodic background resync that
would mask divergence.

---

## 5. `EngineError` — structured error taxonomy (API6-03)

### 5.1 Why a taxonomy (the pattern being generalized)

Today each engine error enum has a `kind() -> &'static str` and the napi layer prepends `[<kind>]` to
the Display string, because **napi-rs's `Error` has no custom string status code** — from
`lib.rs:336-340`:

> *"napi-rs 3.9.0's `Error` uses `Status: enum` (no `Status::Custom(String)`)… Prefix-encoding in the
> message is the canonical workaround… until a future custom-code API lands."*

The IDE then re-parses the bracket via `parseQuantbookError` (`session.ts`). This works but is
string-fragile and per-binding. 6.1 replaces it with a **structured `EngineError` carried as data**.

### 5.2 The `EngineError` DTO

```
EngineError {
    code:        String,       // stable, machine-matchable (e.g. "bad_argument")
    class:       ErrorClass,   // coarse source category (below)
    message:     String,       // human-readable; stable Display preserved
    details:     Map<String,Value>?,  // structured context (failing op index, addr, limit, …)
    retryable:   bool,         // is a naive retry meaningful?
    source:      String?,      // optional upstream cause chain (debug)
}
```

### 5.3 `ErrorClass` (coarse categories — bindings map these to JS/Python/C/HTTP/gRPC)

| Class | Meaning | Seeds from |
|-------|---------|------------|
| `BadArgument` | FFI-boundary validation failure | `[bad_argument]` (`lib.rs` validation) |
| `Lifecycle` | Illegal command for current state | new (§2.3) |
| `NotFound` | Sheet/cell/name/function/format absent | new + replay errors |
| `Conflict` | Op/structure conflict (e.g. duplicate name) | `WorkbookRuntime`/replay |
| `Compute` | Formula/eval error surfaced as a value or op failure | eval layer |
| `Persistence` | Save/load/`.qbook` I/O | `PersistenceError::kind` (`qbook_error`, `session_oplog`, `qbook_unsupported_version`, `qbook_truncated_header`) |
| `Protocol` | DTO/version/decoding mismatch | `deny_unknown_fields`, schema version |
| `Canceled` | Operation canceled / deadline exceeded | §6 |
| `Capability` | Feature not available (e.g. collab disabled, `AINotAvailable`) | sentinel + feature gates |
| `Internal` | Bug / invariant violation (should be rare; never a swallowed fallback) | panic boundary (§8) |

### 5.4 Code stability contract

`code` strings are **stable across releases** (they are part of the public contract; the existing
`kind()` codes — `transport_closed`, `session_oplog`, `bad_argument`, etc. — carry forward). Adding a
code is backward-compatible; renaming/removing one is a breaking change requiring a `protocol_version`
bump. Bindings branch on `code`; humans read `message`; tooling reads `details`.

---

## 6. Operation lifecycle & cancellation (API6-02)

Cancellation is an **acceptance item**, designed in, not bolted on. Today the only async path is
`flushPendingToTransport`; there is **no** operation-ID or cancel surface — 6.1 introduces it.

### 6.1 Model

- Every **long** command (`recalc_dirty`, `recalc_all`, `query_range` over large ranges, UDF
  execution in 6.4, SQL in 6.5, AI in 6.6) returns an **operation ID** (opaque `u64`/uuid) and
  registers in the session's cancellation registry with: an optional **deadline**, a **cancel token**,
  and a **terminal state**.
- `OperationState`: `Running` → one of `Completed` / `Canceled` / `Failed(EngineError)`. Terminal
  states are immutable.
- **A canceled/timed-out operation MUST NOT commit a late result** (decision-lock §4 exit test). For
  UDFs this is enforced by killing the worker process (§10 / decision-lock §5.2); for in-engine recalc
  by checking the cancel token at SCC/chunk boundaries and discarding partial results atomically.

### 6.2 Sync vs async FFI shapes (same operation, two ergonomics)

- **Sync FFI** (C, blocking Node calls): `start_*() -> op_id`, then `wait(op_id, timeout?)` /
  `poll(op_id) -> OperationState` / `cancel(op_id)`. The call returns control so a watchdog/UI thread
  can cancel.
- **Async bindings** (Node `async`, Python `asyncio`, service): `await` the same operation; the
  awaitable resolves to the result or rejects with `EngineError{class:Canceled}`. Internally this is
  the same op-id machinery.

### 6.3 Cancellation is cooperative + bounded

Cancel is cooperative (checked at safe points) with a **bounded** worst-case latency documented per
command. For un-cooperative work (a CPU-bound Python UDF holding the GIL) the only honest hard-cancel
is **process kill/restart** (decision-lock §5.2) — in-process PyO3 cannot preempt it. v1 therefore
runs UDFs in a managed worker process (§10).

---

## 7. Sync/async & concurrency discipline

**Rule: locks guard state transitions, NOT arbitrary waiting** (decision-lock §3.5). The canonical
lesson is `flushPendingToTransport` (`lib.rs:~3421-3445`): extract the ack handle *while holding the
lock*, **drop the lock**, then `tokio::task::spawn_blocking(move || handle.wait_for_drain())`. Holding
the session lock across an `await`/blocking wait would freeze every other binding call (and block the
JS event loop / Python GIL).

Contract obligations:

1. A binding wraps the session in its lock (`Arc<Mutex<WorkbookSession>>` for Node, GIL-aware for
   Python). Mutating/querying commands acquire the lock for the **duration of the state transition
   only**.
2. No command holds the session lock across a blocking wait, an `await`, or an FFI round-trip into
   user code (UDF/AI). Long ops detach the cancel token + result channel, release the lock, and
   complete off-lock — mirroring the flush pattern.
3. Two earlier soundness closures are part of this contract: V2.4 (no `&mut self` UB across the napi
   boundary) and V2.5 (no event-loop block). New long-op surfaces (UDF/SQL/AI) must replicate the
   detach-then-off-lock shape.

---

## 8. Panic & validation boundary

napi-rs does **not** catch Rust panics (today this is per-binding folklore). 6.1 makes it a **common
API-layer guarantee**:

1. **Input validation at the boundary** before any engine work: reject NaN/Inf/negative/fractional
   coordinate coercions, oversize indices, malformed UTF-8, etc., returning
   `EngineError{class:BadArgument}` (generalizing today's `appendPutValue`/`appendPutFormula`
   validation + `[bad_argument]` prefix). Validation lives once in the common layer, not re-invented
   per binding.
2. **Panic catch** in the common entry layer (`std::panic::catch_unwind` around the engine call in
   each binding shim, or a single shared shim) converting a panic into
   `EngineError{class:Internal, code:"panic", message:<payload>}` and marking the session `Faulted` if
   the panic could have left inconsistent state. A panic is never a silent crash and never a swallowed
   fallback — it is surfaced as a loud `Internal` error.
3. The C ABI additionally guarantees no `panic` unwinds across the `extern "C"` boundary (UB);
   `BND-6-02` (C ABI guardrails) verifies this.

---

## 9. Event & diagnostic stream

A versioned, **pull-or-push** stream so service + bindings share one tracing contract (and so UDF/SQL/AI
extend it rather than invent their own — decision-lock §5).

- **`Event`** (versioned discriminated union): `RecalcProgress{op_id, done, total}`,
  `CellDiagnostic{addr, severity, code, message}`, `OperationCompleted{op_id, state}`,
  `Provenance{addr, source}` (shaped now for UDF/SQL/AI even though emitters land later),
  `StructureChanged{kind, target}`.
- **Pull** (`poll_events(since_cursor) -> [Event]`) for sync FFI (C, blocking Node); **push**
  (`subscribe_events() -> stream`) for async bindings + the 6.2 service streaming-diagnostics
  requirement (SVC-6-02). Both drain the same internal queue; `since_cursor` is opaque.
- `Diagnostic` (the per-cell formula error/warning shape) is the same DTO whether it arrives via
  `validate_formula` (synchronous) or the event stream (post-recalc).

---

## 10. Function metadata & graph-invalidation contract (R-P6-4)

This is the **6.4-0 prerequisite** and the hard part of "UDF/SQL/AI must not bypass graph
invalidation" (Phase 6 exit criterion). The contract is shaped here; the substrate is built in 6.4-0.

### 10.1 The gap today

`FunctionRegistry` (`ql-functions/src/registry.rs`) stores **dispatch only** — `RegisteredFn` is an
enum of fn-pointer tiers (`Scalar`/`RangeAware`/`ContextAware`/`Unified`/`ReferenceAware`), no
per-function metadata. Volatility + reference-shape are **two hardcoded whitelists** in
`calcgraph_session.rs`:

- `is_volatile_function` (`:149-164`) — `NOW`/`TODAY`/`RAND`/`RANDBETWEEN`/`RANDARRAY`/`INDIRECT`/
  `OFFSET`/`INFO`/`CELL`. Its own doc comment says it should become *"per-function metadata on
  `FunctionRegistry`"*.
- `is_address_only_reference_fn` (`:201-203`) — `ROW`/`COLUMN`/`ROWS`/`COLUMNS`/`ISREF`.

A Python UDF cannot be added to a hardcoded `match`, so without metadata it cannot participate
correctly in dirty propagation — it would silently bypass the graph.

### 10.2 `FunctionMetadata` (built in 6.4-0; carried as a v1 DTO now)

```
FunctionMetadata {
    name:            String,
    arity:           Arity,          // fixed / range / variadic
    volatility:      Volatility,     // Pure | Volatile | Dynamic(structure-dependent)
    determinism:     bool,           // same args ⇒ same result?
    dep_shape:       DepShape,       // Value-deps | AddressOnly | Custom(explicit deps)
    batch_shape:     BatchShape,     // Scalar | Array/Arrow batch (UDFs: batch from day one)
    arg_policy:      ArgPolicy,      // strictness/coercion
    cancellation:    CancelPolicy,   // cooperative | worker-kill (UDF/AI)
    provenance_tags: [String],       // for §9 Provenance events
}
```

The two hardcoded whitelists become *derived* from registered metadata (built-ins register with their
true metadata; the whitelists are kept only as a compatibility shim until migration completes).

### 10.3 Graph-invalidation model (decision-lock §4)

- A UDF formula is a **normal graph node**; its formula args are walked + registered as deps exactly
  like a built-in (via `mark_dirty_from_cell_write`, BFS fanout at `calcgraph_session.rs:1396-1431`).
- **Default Python UDFs are `Volatile`/`Dynamic`** unless registered with explicit purity:
  `register_formula_function(..., deterministic=True, volatile=False, deps=[...])`.
- `qb.publish()` / `qb.bind()` is the **authoritative Python reactivity contract** (explicit publish
  stays clean; post-run fingerprinting is secondary).
- `BoundFrame` edits dirty the **overlay** sheet/table/range nodes, not the original Python object.
- Connector/file refresh dirties dependents by **source revision** (6.5).

### 10.4 Exit tests (must exist before 6.4 closes — decision-lock §4)

1. Pure UDF **recomputes** when a referenced input changes.
2. Pure UDF **does NOT recompute** on an unrelated edit.
3. Volatile UDF recomputes on recalc / volatile pass.
4. `qb.publish("returns", df)` dirties dependents.
5. `BoundFrame` overlay edit dirties bound-range formulas.
6. Canceled/timed-out UDF **does not commit** a late result.
7. Failed UDF → deterministic structured cell diagnostics (`CellDiagnostic`, §9).

---

## 11. Per-binding obligations

All bindings are **adapters** over the same `EngineSession` trait + DTOs. The existing Node binding
(`ql-bindings-node`) becomes an adapter in 6.3, not a separate semantic surface.

| Binding | Handle | Async model | Error mapping | Release | Notes |
|---------|--------|-------------|---------------|---------|-------|
| **Node** (`ql-bindings-node`) | `#[napi]` class over `Arc<Mutex<WorkbookSession>>` | `async` ⇒ `Promise`; long ops via op-id | `EngineError` → JS `Error` w/ `.code`/`.class`/`.details` (replaces `[kind]` string-parse) | GC | Migrate the IDE smoke path first (catches missing commands early) |
| **Python** (`quantbook-py`) | PyO3 class | `asyncio` await; GIL-aware lock | → typed exception hierarchy keyed on `class` | GC | UDF host; managed worker process for execution (§10/§6.3) |
| **C** (`ql-bindings-c`) | opaque ptr + `qb_session_free` | start/poll/wait/cancel (sync) | `code`+`class` ints + `qb_last_error()` string | **explicit** `qb_release_*` | No panic unwinds across `extern "C"` (BND-6-02) |
| **WASM** (`ql-bindings-wasm`) | JS-owned handle | Promise | `EngineError` → JS object | JS GC | Single-threaded; no transport |
| **Service** (`ql-service`, 6.2) | session-per-connection | streaming (SSE/gRPC); op-id cancel over the wire | `EngineError` → HTTP problem+json / gRPC status+details | connection close | Transport pick deferred (HTTP+SSE default lean) |

**Golden flow matrix (BND-6-01 / API6-01 enforcement):** one identical scripted flow —
open → set_value → set_formula → recalc → snapshot → snapshot_delta → register UDF → recalc →
cancel a long recalc → structured error on bad input — runs across **every** binding and must produce
byte-identical DTOs + identical `EngineError.code`. This is the concrete test that "one contract backs
all bindings."

---

## 12. What 6.1B / 6.1C must do against this contract

**6.1B (implement `WorkbookSession`):**
1. Define the `EngineSession` trait (the §3 commands) + the binding-neutral DTO module (§4) with
   `schema_version`.
2. Implement `WorkbookSession` owning the §2.1 components; construct `WorkbookRuntime` per-edit
   internally (borrow never crosses FFI).
3. Implement the `EngineError` taxonomy (§5), the cancellation registry + op lifecycle (§6), the
   panic/validation boundary (§8), and the event queue (§9 — at least the emitters that exist today:
   recalc + cell diagnostics + structure changes).
4. **Migrate the Node smoke path** onto `WorkbookSession` far enough to prove IDE edit/recalc/snapshot
   end-to-end (don't freeze the `CollabSession` façade).
5. Leave collab/transport/presence behind a feature gate (§3.9) — not in the v1 trait.

**6.1C (mandatory security/design audit before broader exposure — both plans require it):** FFI
handle safety (no borrowed refs escape; release discipline), panic boundary completeness, lock
discipline (§7) under concurrent calls, `EngineError` doesn't leak internals/secrets, cancellation
soundness (no late commits), DTO version-rejection is fail-loud, and the trait truly backs the Node
adapter with no semantic divergence.

---

## 13. Explicitly deferred / open (carried from the decision-lock)

- **Transport pick (HTTP vs gRPC):** deferred to 6.2 (decision-lock §1 D2). 6.1 stays transport-neutral;
  default lean HTTP+SSE if forced.
- **`AI()`:** deferred (decision-lock §1 D3). Keep the `AINotAvailable` sentinel + reserve the provider
  boundary; the `=AI()` **cell function is v2-aligned**, not v1. Provenance DTOs (§9) are shaped now.
- **Collaborative multi-user layer:** v1.5 (Product Phase 9). Single-writer `WorkbookSession` is v1.
  A future collaborative table producer MUST land conflict-resolution + `removed_cells` (Phase 5 EC#2).
- **`CellValueJson` discriminated-union retype** (TS-side): scoped, recipe in
  `docs/phase5/megaudit-5-8/closures.md` §5 item 2. The contract specifies the union as authoritative.

---

## 14. Appendix — existing napi method → contract command (bottom-up provenance)

| napi (`CollabSession`) | Contract command | Tier |
|------------------------|------------------|------|
| `appendPutValue` | `set_value` | v1 |
| `appendPutFormula` | `set_formula` | v1 |
| `addSheet`/`renameSheet`/`deleteSheet`/`restoreSheet`/`moveSheet` | sheet structure ops (§3.3) | v1 |
| `workbookSnapshot` | `snapshot` | v1 |
| `workbookSnapshotDelta` | `snapshot_delta` | v1 |
| `exportSnapshot` | (legacy single-sheet; subsumed by `snapshot`/`query_range`) | deprecate |
| `listSheets` | `list_sheets` | v1 |
| `undo`/`redo` | `transaction`/undo (§3.4) | v1 (single-writer) |
| `from_qbook`/`to_qbook` | `open`/`save` | v1 |
| `attach/detach/flush*/pollRemote*`/`export/mergeBytes` | (collab transport) | v1.5 (§3.9) |
| `updatePresence`/`peerPresence`/`clearPresence`/`sweepPresence` | (collab presence) | v1.5 (§3.9) |
| `setAutoFlushPolicy`/`autoFlushPolicy` | (collab policy) | v1.5 (§3.9) |
| *(none today)* | `cancel`/`operation_status`/`subscribe_events`/`poll_events` | v1 (new in 6.1) |
| *(none today)* | `register_function`/`unregister_function`/`list_functions` | v1 contract / 6.4 impl |
