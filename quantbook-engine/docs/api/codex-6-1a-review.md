# Codex 6.1A API Contract Review

Verdict: REVISE

Scope: audit of `docs/api/session-api.md` against the Phase 6 decision lock, MASTER-PLAN Phase 6 excerpt, and the current Rust engine/binding code. This is an adversarial API-lock review for binding-fork, implementability, hidden-fallback, and source-drift risk.

The contract is directionally aligned with the Phase 6 decision lock, but it is not ready to freeze. The main problem is that several v1 promises are still written as desired end-state behavior rather than as an implementable contract over the current engine. The highest-risk areas are cancellable/off-lock recompute, the snapshot version-token source after collab is deferred, transaction/batch semantics across FFI, and missing UDF/SQL bulk publish surfaces.

Single most dangerous binding-fork risk: the v1 `snapshot()` / `snapshot_delta()` version-token contract is still effectively the current `CollabSession`/Loro VersionVector protocol while the contract declares `CollabSession` and the CRDT/op-log layer v1.5-deferred. If 6.1B does not define one binding-neutral `WorkbookSession` version source, Node will naturally keep Loro VV buffers while WASM/C/Python/service will invent counters, cache epochs, or "always full rebuild" behavior. That is exactly the decision-lock #1 failure mode.

Axis D verdict: the version-token contradiction is real. It is not fatal if fixed now, because the contract already says tokens are opaque. But the source, validity rules, and delta-cache semantics must be locked before implementation.

## Findings

### HIGH-1 - Cancellation/no-late-commit is overpromised for the current recompute core

References:
- `docs/api/session-api.md:318` promises op IDs for long recompute/query/UDF/SQL/AI operations.
- `docs/api/session-api.md:324` says a canceled/timed-out op MUST NOT commit a late result.
- `docs/api/session-api.md:326` says in-engine recalc can check at SCC/chunk boundaries and discard partial results atomically.
- `docs/api/session-api.md:348` says locks guard state transitions, not arbitrary waiting.
- `docs/api/session-api.md:360` says long ops detach token/result channel, release the lock, and complete off-lock.
- `crates/ql-exec/src/workbook_runtime/recompute.rs:61` exposes synchronous `recompute_all(&mut self) -> RecomputeResult`.
- `crates/ql-exec/src/workbook_runtime/recompute.rs:137` writes `#CIRC!` directly into the workbook before the main eval loop.
- `crates/ql-exec/src/workbook_runtime/recompute.rs:153` loops formulas and commits each successful cell with `put_computed_at`.
- `crates/ql-exec/src/workbook_runtime/recompute.rs:252` exposes synchronous `recompute_dirty(&mut self) -> Option<RecomputeResult>`.
- `crates/ql-exec/src/workbook_runtime/recompute.rs:315` claims and schedules the dirty set.
- `crates/ql-exec/src/workbook_runtime/recompute.rs:431` evaluates sorted nodes and `:445` commits each changed value immediately.
- `crates/ql-exec/src/workbook_runtime/recompute.rs:649` only reattaches the graph after the loop completes.
- `crates/ql-exec/src/calcgraph_session.rs:445` defines `CalcgraphSession` without `Clone`, so "compute on a cloned session, then atomically swap" is not available today.

Problem:
The current recompute APIs are synchronous, mutating loops. They write partial results as they progress, mutate/consume dirty state, and borrow `&mut Workbook` plus `&mut CalcgraphSession`. There is no cancel token parameter, no safe checkpoint API, no staged result buffer, and no rollback. The contract's "discard partial results atomically" guarantee cannot be honored by simply wrapping these calls in an operation registry. Similarly, "release the session lock while recompute continues" is not achievable without either moving the whole workbook/graph out of the session into a worker-owned busy state or cloning/staging state. In either case the contract needs a `Busy`/operation-owned-state model that it does not currently define.

Why this forks bindings:
Node async may implement a `spawn_blocking` wrapper around the existing synchronous call and mark cancellation best-effort/status-only. C/Python/WASM might block and ignore cancel until completion. The service might expose true cancel for SQL/UDF but not recalc. All would claim the same API but commit different late-result behavior.

Recommended change:
Revise sections 6 and 7 to state an implementable recalc contract. Pick one:

1. Define a real staged recalc protocol for 6.1B: compute on a cloned/staged workbook+graph or a write-set, check cancel before each commit boundary, and commit only once if the token is still live. Add a `Busy` lifecycle state and define which commands are legal while the operation owns mutable engine state.
2. Or narrow 6.1B: op IDs and terminal states exist, but existing in-engine recalc cancellation is only pre-start/pre-commit until a compute-core refactor lands. Keep hard no-late-commit only for UDF worker kill, SQL, and future staged recalc.

Do not freeze the current wording as a v1 guarantee.

### HIGH-2 - The v1 version-token/delta protocol is still collab-specific even though collab is deferred

References:
- `docs/api/session-api.md:13` defines the product session as single-writer `WorkbookSession`.
- `docs/api/session-api.md:15` defers `CollabSession` CRDT/op-log/transport/presence to v1.5.
- `docs/api/session-api.md:75` says `WorkbookSession` owns components including optional `OpLog`.
- `docs/api/session-api.md:179` makes `snapshot()` v1 and says it carries an opaque version token.
- `docs/api/session-api.md:180` makes `snapshot_delta(last_version)` v1.
- `docs/api/session-api.md:240` defines `WorkbookSnapshot.version` as an opaque byte token and notes today's token is a Loro `VersionVector` buffer.
- `crates/ql-bindings-node/src/lib.rs:903` documents the current token as `loro::VersionVector::encode()`.
- `crates/ql-bindings-node/src/lib.rs:2153` captures `inner.oplog_vv()` for snapshot.
- `crates/ql-bindings-node/src/lib.rs:2416` returns the encoded VV as the snapshot version.
- `crates/ql-bindings-node/src/lib.rs:2502` obtains `current_vv` from the op log for delta.
- `crates/ql-bindings-node/src/lib.rs:2527` decodes caller input as `ql_oplog::VersionVector`.

Problem:
The only implemented version-token source is the collab/op-log Loro VersionVector. The contract simultaneously says op-log is optional and collab is v1.5-deferred. It never says what produces a v1 single-writer token when op-log/collab is off, what token invalidation means, whether tokens are per-session only, whether tokens survive save/load, or whether `snapshot_delta` is allowed to always report `full_rebuild_required` in no-op-log mode.

Opaque-to-callers is not enough. The binding adapters still need one shared producer/validator and one shared delta-cache semantic.

Recommended change:
Lock a `SessionVersion` model in section 4 before 6.1B:

- Either make a single-writer `OpLog` mandatory for v1 `WorkbookSession` even when transport/collab is disabled, and explicitly use its VV as the token.
- Or define an engine-owned non-Loro token, for example `{session_epoch, revision, cache_epoch}` encoded as bytes, and make Node migrate to it.
- State whether tokens are only valid for the same live session or are portable after save/load.
- State malformed-token behavior.
- State whether `snapshot_delta` is required to attempt incremental deltas in v1 or may return `full_rebuild_required` for specific, enumerated reasons only.

### HIGH-3 - `transaction(scope)` is not transport-neutral, and `batch` atomicity is not defined against real `BatchCommit`

References:
- `docs/api/session-api.md:46` forbids borrowed Rust references across FFI.
- `docs/api/session-api.md:163` defines `batch(ops)` as atomic all-or-nothing.
- `docs/api/session-api.md:164` defines `transaction(scope)` via undo-group machinery and an RAII guard analog.
- `crates/ql-exec/src/transaction.rs:76` defines `WorkbookTransaction`.
- `crates/ql-exec/src/transaction.rs:80` says the transaction holds `&mut Workbook` for its lifetime.
- `crates/ql-exec/src/transaction.rs:273` consumes the transaction on commit.
- `crates/ql-exec/src/transaction.rs:293` appends `Op::BatchCommit` before workbook mutation for producer-side atomicity.
- `crates/ql-oplog/src/replay.rs:889` replays `Op::BatchCommit` by applying each inner op sequentially.
- `crates/ql-oplog/src/replay.rs:895` returns on first inner failure with no rollback of earlier inner effects.

Problem:
An RAII transaction scope is a Rust borrow pattern, not a transport-neutral FFI contract. C, service, Python, and WASM cannot safely hold a `WorkbookTransaction<'_>` across calls without violating the "no borrowed ref crosses FFI" rule. An opaque transaction handle could own buffered operations, but that is a different API and must be specified.

The word "atomic" also conflates two different layers:

- Producer-side `WorkbookTransaction` validates/buffers and appends `BatchCommit` before mutating, so append failure leaves the workbook unchanged.
- Replay-side `BatchCommit` is not rollback-atomic if an inner op mutates and a later inner op fails.

The contract currently promises all-or-nothing without saying whether that applies to producer validation, local commit, op-log append, replay, undo grouping, or all of them.

Recommended change:
Replace `transaction(scope)` with one transport-neutral shape:

- `batch(ops, options) -> BatchResult`, where options include `undo_group_id`/`undo_label`, and the whole batch is request-scoped.
- If multi-call transactions are required, define an opaque transaction handle that owns only buffered DTOs, not a borrowed runtime, with explicit `commit`/`rollback`/timeout semantics.
- Define atomicity per layer: validation phase, op-log append, workbook mutation, replay from persisted logs, and undo grouping.
- If replay rollback is required, implement staging/clone replay. If not, say replay is fail-loud but not rollback-atomic.

### HIGH-4 - The stable v1 command surface lacks the bulk publish/bind/materialize commands Phase 6.4 and 6.5 need

References:
- `docs/phase6/decision-lock.md:13` says the Python kill-gate includes `qb.show`, `publish`, `bind`, `register_formula_function`, `BoundFrame`, Arrow batch exchange, and transactions.
- `docs/phase6/decision-lock.md:32` repeats that 6.4A pulls forward a minimal Python authoring bridge with `qb.show`/`publish`/`bind` and `BoundFrame.refresh`.
- `docs/phase6/decision-lock.md:54` defines UDF graph invalidation, including `qb.publish()` / `qb.bind()`.
- `docs/phase6/decision-lock.md:62` lists exit tests for publish, BoundFrame overlay edits, cancellation, and structured diagnostics.
- `docs/MASTER-PLAN.md:747` scopes Python UDFs.
- `docs/MASTER-PLAN.md:753` scopes SQL/connectors, materialization, Arrow interop, and refresh dirtying.
- `docs/api/session-api.md:178` has only `query_range(range) -> RangeResult` for batch-shaped range reads.
- `docs/api/session-api.md:188` has UDF registration but not Python publish/bind/range materialization.
- `docs/api/session-api.md:450` mentions `qb.publish()` / `qb.bind()` only in the graph model, not the command surface.
- `docs/api/session-api.md:460` makes publish dirtying an exit test.

Problem:
6.4/6.5 need to bulk materialize external data into sheet/table/range state and dirty dependents by source revision. The contract has `set_value`, `batch`, and table metadata ops, but no stable command for:

- bulk write of a rectangular value matrix or Arrow batch,
- publish a DataFrame/table/range into the workbook,
- bind a Python object/BoundFrame overlay to a sheet range/table,
- refresh an external source revision and dirty formulas depending on it,
- materialize SQL query results to a sheet/table with provenance.

If this is left to 6.4/6.5, Python and service surfaces will add product-specific APIs outside the shared `EngineSession` trait. That is a binding fork.

Recommended change:
Add reserved-but-stable command shapes now, even if implemented later:

- `write_range(range, values, options) -> WriteRangeResult`
- `publish_dataset(name, data, target, provenance) -> PublishedRef`
- `bind_range(binding_id, target, schema, options) -> BoundRange`
- `refresh_source(source_id, revision) -> DirtyResult`
- `materialize_query(query_id, target, data, provenance) -> PublishedRef`

Define their dirtying behavior and event/provenance DTOs in the same contract.

### HIGH-5 - Function metadata is not enough to prevent UDF graph bypass on registration/change

References:
- `docs/api/session-api.md:427` defines `FunctionMetadata`.
- `docs/api/session-api.md:431` includes volatility.
- `docs/api/session-api.md:433` includes `dep_shape`.
- `docs/api/session-api.md:441` says the hardcoded whitelists become derived from registered metadata.
- `docs/api/session-api.md:446` says a UDF formula is a normal graph node and its args are walked like built-ins.
- `docs/api/session-api.md:448` says default Python UDFs are volatile/dynamic unless registered with explicit purity metadata.
- `crates/ql-formula-syntax/src/ast.rs:54` says parser uppercases function names for canonical comparison.
- `crates/ql-functions/src/registry.rs:184` requires canonical uppercase registration keys.
- `crates/ql-functions/src/registry.rs:188` panics on bad/duplicate built-in registration rather than returning a dynamic registration error.
- `crates/ql-functions/src/registry.rs:281` uppercases lookups.
- `crates/ql-exec/src/calcgraph_session.rs:213` defines `FormulaDeps` with cells, ranges, names, tables, and `is_volatile`, but no `functions_used`.
- `crates/ql-exec/src/calcgraph_session.rs:269` computes volatility during plan walking from the current hardcoded whitelist.

Problem:
The shape describes per-function metadata, but it does not define the invalidation behavior when metadata changes. This matters because formulas can already bind with an unknown function name and later become valid when a UDF is registered. Also, registering a UDF as volatile vs pure changes graph scheduling behavior, but the current graph stores only a boolean `is_volatile` snapshot and has no reverse index from function name to formula nodes.

The contract also omits canonical-name rules for metadata. The parser and registry both canonicalize/require uppercase names today; a dynamic UDF API must define whether `name` is normalized, whether aliases exist, how collisions with built-ins are rejected, and how registration errors surface without panics.

Recommended change:
Extend section 10 with:

- `canonical_name` and optional `display_name`/aliases, with ASCII uppercase or documented Unicode policy.
- `register_function` collision rules against built-ins, existing UDFs, names/tables if applicable.
- A graph-maintained `functions_used` reverse index.
- `register_function`, `unregister_function`, and metadata-update invalidation rules: re-extract or dirty all formulas referencing that canonical function.
- Unknown function policy before registration. The conservative rule should be graph-visible and volatile/dynamic, not silently pure.

### MED-1 - The EngineError taxonomy is too coarse to guarantee one binding mapping

References:
- `docs/api/session-api.md:287` defines the `ErrorClass` set.
- `docs/api/session-api.md:302` promises stable `code` strings across releases.
- `crates/ql-exec/src/workbook_runtime/error.rs:30` defines `RuntimeError` with many user-facing variants.
- `crates/ql-collab/src/session.rs:381` maps all collab errors to only five wrapper codes plus transport pass-through.
- `crates/ql-oplog/src/replay.rs:54` defines replay errors such as invalid sheet/cell, decode, rejected names, and missing formats.
- `crates/ql-bindings-node/src/lib.rs:495` maps `PersistenceError` variants to string codes.
- `crates/ql-bindings-node/src/lib.rs:496` uses a wildcard future arm that maps to `qbook_unknown`.

Problem:
The contract defines classes but not the required variant-to-code mapping. The current real code has at least four error sources with different granularity: runtime, replay, collab/session, transport, and persistence. Several mappings are ambiguous:

- `RuntimeError::InvalidSheet` could be `BadArgument`, `NotFound`, or `Lifecycle` depending on command.
- `RuntimeError::TableCreateRejected` could be `BadArgument` or `Conflict`.
- `ReplayError::FormatNotRegistered` could be `Protocol`, `NotFound`, or `Persistence`.
- Formula parse/bind errors from `set_formula` could be `BadArgument`, `Compute`, or structured diagnostics.
- Future `PersistenceError` variants currently fall through to `qbook_unknown`, which conflicts with "code strings are stable" as a public contract.

Recommended change:
Add an appendix table mapping every current public error variant to `{class, code, retryable, details}`. Include `RuntimeError`, `RecomputeFailure`, `ReplayError`, `OpLogError`, `PersistenceError`, `TransportError`, and `CollabSessionError`. Do not rely on binding authors to infer this from classes.

### MED-2 - `full_rebuild_required` risks becoming a silent-resync fallback unless malformed-token behavior is locked

References:
- `docs/api/session-api.md:54` says errors are visible and never swallowed.
- `docs/api/session-api.md:56` names `full_rebuild_required` as the only structured recovery signal.
- `docs/api/session-api.md:249` defines the full-rebuild protocol.
- `crates/ql-bindings-node/src/lib.rs:1060` says malformed `lastSeenVersion` is one source of full rebuild.
- `crates/ql-bindings-node/src/lib.rs:2495` says malformed `last_seen_version` is a `[bad_argument]` error.
- `crates/ql-bindings-node/src/lib.rs:2527` decodes the caller VV.
- `crates/ql-bindings-node/src/lib.rs:2529` returns `fullRebuildRequired=true` on decode error instead of an error.

Problem:
The current Node code and comments already disagree on malformed token behavior. The contract's no-fallback framing is honest only if the full-rebuild branch is reserved for known, designed delta-cache states. If malformed/corrupt caller tokens also become full rebuild, clients can pass garbage forever and still "work" by silently resyncing. That masks protocol bugs and opens per-binding divergence.

Recommended change:
Lock exact cases:

- Empty token on first call: full rebuild.
- Stale but well-formed token from same session/cache epoch: full rebuild.
- Expired cache horizon: full rebuild.
- Malformed token or unsupported token schema: `EngineError { class: Protocol, code: "invalid_version_token" }`.
- Token from different session, if detectable: either `invalid_version_token` or an explicitly named `full_rebuild_required` reason.

Add `full_rebuild_reason` or an event/diagnostic if the branch is intentionally non-error.

### MED-3 - Several v1 sheet commands are currently collab/storage semantics, not single-writer runtime semantics

References:
- `docs/api/session-api.md:151` through `:155` mark add/rename/delete/restore/move sheet as v1.
- `crates/ql-exec/src/workbook_runtime/sheets.rs:9` lists runtime sheet methods as add and rename only.
- `crates/ql-bindings-node/src/lib.rs:1408` implements `deleteSheet` by appending `Op::RemoveSheet`.
- `crates/ql-bindings-node/src/lib.rs:1472` implements `restoreSheet` by appending `Op::RestoreSheet`.
- `crates/ql-bindings-node/src/lib.rs:1548` implements `moveSheet` by appending `Op::MoveSheet`.
- `crates/ql-storage/src/workbook.rs:749` `remove_sheet` silently no-ops for out-of-range ids.
- `crates/ql-storage/src/workbook.rs:781` `restore_sheet` silently no-ops for out-of-range ids.
- `crates/ql-storage/src/workbook.rs:809` `move_sheet` silently no-ops/clamps.

Problem:
For a single-writer product API, delete/restore/move need explicit fail-loud semantics. The current implementations are either thin collab op appenders or low-level storage methods with CRDT-friendly idempotency/no-op/clamping behavior. If Node inherits the collab semantics while the new C/Python/WASM/service bindings implement strict single-writer errors, the v1 command surface forks.

Recommended change:
For each structural command, define the v1 single-writer semantics:

- invalid id: `NotFound` or `BadArgument`, not silent no-op;
- tombstoned-sheet behavior for read/write/rename/move/restore;
- out-of-range move index: clamp or error;
- whether delete is tombstone or hard delete;
- whether formula refs to deleted sheets become `#REF!`, `#NAME?`, diagnostics, or preserved text.

Then implement `WorkbookRuntime`/`WorkbookSession` wrappers for delete/restore/move instead of freezing the collab facade behavior by accident.

### MED-4 - `undo`/`redo` are declared v1 in prose but not actually in the command surface

References:
- `docs/api/session-api.md:163` lists `batch`.
- `docs/api/session-api.md:164` lists `transaction`.
- `docs/api/session-api.md:207` says undo/redo is v1.
- `docs/api/session-api.md:534` maps napi `undo`/`redo` to `transaction`/undo.
- `crates/ql-bindings-node/src/lib.rs:1888` exposes `undo()`.
- `crates/ql-bindings-node/src/lib.rs:1901` exposes `redo()`.

Problem:
The contract never defines `undo()` or `redo()` as stable commands even though it says undo/redo are v1. It also does not define return values, empty-stack behavior, error mapping, or whether undo/redo participate in snapshot delta invalidation. This invites each binding to expose its own shape.

Recommended change:
Add explicit v1 commands:

- `undo(scope?) -> UndoResult { consumed, op_id?, version? }`
- `redo(scope?) -> RedoResult { consumed, op_id?, version? }`
- Optional `can_undo`/`can_redo` if product UI needs them.

Define empty-stack as a non-error and define whether undo/redo clear delta caches or emit structured events.

### MED-5 - `RangeResult`, event cursors, and backpressure are not specified enough for binding parity

References:
- `docs/api/session-api.md:178` defines `query_range(range) -> RangeResult` but no `RangeResult` DTO appears in section 4.
- `docs/api/session-api.md:247` lists DTOs but omits `RangeResult`.
- `docs/api/session-api.md:393` defines event variants.
- `docs/api/session-api.md:397` says `poll_events(since_cursor)` and `subscribe_events()` drain the same queue.
- `docs/api/session-api.md:399` says `since_cursor` is opaque.

Problem:
Range reads and events are cross-binding hot spots. Without a concrete `RangeResult` shape, one binding may return row-major `CellValue[]`, another may return Arrow, and another may include formulas/formats/rendered strings. Similarly, event cursor semantics need retention, ordering, replay, and overflow rules. "Both drain the same internal queue" is especially ambiguous: if push subscribers and pull pollers both drain, they can starve each other.

Recommended change:
Define:

- `RangeResult` schema: row-major vs columnar, dimensions, value/formula/format inclusion, Arrow handle rules, null/pending/error encoding.
- Event cursor semantics: monotonic cursor, per-subscriber vs global queue, retention window, overflow error vs full resync event, ordering relative to operation terminal states.
- Whether polling drains or reads from an append-only ring.

### LOW-1 - `PlanCache` ownership is promised but not yet implementable without a runtime refactor

References:
- `docs/api/session-api.md:82` says `WorkbookSession` owns `PlanCache`.
- `docs/api/session-api.md:87` says today runtime is constructed per edit.
- `docs/api/session-api.md:89` says 6.1B constructs per-edit `WorkbookRuntime` internally.
- `crates/ql-exec/src/workbook_runtime/mod.rs:133` defines `WorkbookRuntime`.
- `crates/ql-exec/src/workbook_runtime/mod.rs:140` stores a private `plan_cache: PlanCache`.
- `crates/ql-exec/src/workbook_runtime/mod.rs:162` initializes a new cache in `new`.
- `crates/ql-exec/src/workbook_runtime/mod.rs:225` initializes a new cache in `with_oplog_and_graph`.

Problem:
The contract says the session owns a stable plan cache, but the current runtime constructors allocate a fresh private cache per runtime. If 6.1B simply constructs a new `WorkbookRuntime` per command, the cache will reset and `cache_stats`/recompute behavior will diverge from the contract's ownership model.

Recommended change:
Make 6.1B explicitly refactor `WorkbookRuntime` to borrow a session-owned `PlanCache`, or move runtime methods onto `WorkbookSession` so cache ownership is real. This is not a binding-blocker if called out as implementation work, but the contract should not imply it already falls out naturally.

### LOW-2 - Panic-boundary guarantee needs build/profile and faulting specifics

References:
- `docs/api/session-api.md:378` requires `catch_unwind`.
- `docs/api/session-api.md:380` converts panic to `EngineError{class:Internal, code:"panic"}` and may mark `Faulted`.
- `crates/ql-bindings-node/src/lib.rs:243` through `:272` documents a real Node-aborting panic when peer id zero reached Loro/engine asserts.
- `crates/ql-bindings-node/src/lib.rs:1121` notes the current Node wrapper uses `parking_lot::Mutex`, which does not poison.

Problem:
The guarantee is correct in spirit, but underspecified. `catch_unwind` only works with `panic = "unwind"` and must be inside the Rust entrypoint before unwind crosses FFI. Some captured state may not be `UnwindSafe`, and `parking_lot` not poisoning means a panic can leave a mutex-unlocked but inconsistent session. The contract says mark `Faulted` if the panic could have left inconsistent state, but does not define how that determination is made. In practice the conservative rule should be "any panic during a mutating command faults the session."

Recommended change:
State:

- FFI crates must build with `panic = "unwind"` if this guarantee is relied on; otherwise panic abort remains possible.
- `catch_unwind` wraps the common command dispatcher before any FFI boundary can observe unwinding.
- Any panic in a mutating command marks the session `Faulted`.
- Read-only command panic behavior is either also faulting or explicitly classified.

### INFO-1 - The contract overstates "bottom-up extracted from real code" for new surfaces

References:
- `docs/api/session-api.md:10` says every design claim is anchored to real code.
- `docs/api/session-api.md:196` through `:199` define new event/cancellation commands.
- `docs/api/session-api.md:318` through `:326` define new cancellation behavior.
- `docs/api/session-api.md:425` through `:438` define new function metadata.
- `docs/api/session-api.md:539` acknowledges no current napi surface for cancel/status/events.

Observation:
It is fine for 6.1A to shape new surfaces, but the text should separate "extracted from real code" from "new substrate to build in 6.1B/6.4-0". As written, reviewers may under-estimate implementation risk.

Recommended change:
Change the status/basis language to explicitly list:

- proven/extracted now: cell/sheet/format/name/table edits, snapshots, qbook persistence, current error-code workaround, flush detach pattern;
- new in 6.1B: `EngineSession`, cancellation registry, event queue, lifecycle/faulted state, common `EngineError`;
- new in 6.4-0: function metadata and graph metadata derivation.

## Approval Gate

Do not use `docs/api/session-api.md` as the binding lock until the HIGH findings are resolved in the document. The most important fixes are:

1. Define an implementable recalc cancellation/off-lock model or narrow the v1 guarantee.
2. Define the single-writer version-token producer and delta validity rules independent of the collab facade.
3. Replace RAII `transaction(scope)` with transport-neutral batch/transaction semantics and add explicit undo/redo.
4. Add the bulk publish/bind/materialize/source-refresh command shapes needed by 6.4/6.5.
5. Add function-registration invalidation rules and an exhaustive error-code mapping appendix.

After those changes, the contract can likely move to APPROVE-WITH-CHANGES rather than a full redesign.
