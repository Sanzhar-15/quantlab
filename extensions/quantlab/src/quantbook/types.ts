/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- TypeScript declarations mirroring the
 * `ql-bindings-node` napi-rs surface (Rust crate at
 * `quantlab-quantbook/quantbook-engine/crates/ql-bindings-node`).
 *
 * **Source of truth**: the Rust crate. If you edit this file, also
 * update `crates/ql-bindings-node/src/lib.rs` (and vice versa). V2
 * will add a generator (`@napi-rs/cli typegen`) to keep them in sync
 * automatically.
 *
 * **V1 surface**: a single class `CollabSession` exposing the minimum
 * round-trip methods. See the Rust crate's module docs for V1 surface
 * rationale + V2 deferred list.
 */

/**
 * A peer-to-peer collaboration session. Wraps the engine's
 * `ql_collab::CollabSession`.
 *
 * **Failure modes** (constructors throw JS `Error`):
 * - `peerId == 0n` -- PeerId reserves 0 (Loro sentinel)
 * - `peerId < 0n` -- PeerId is u64-domain
 * - `peerId` exceeds u64 -- lossy BigInt conversion
 *
 * Method failures (engine-level errors, e.g., merge of malformed
 * bytes) surface as JS `Error` exceptions with the engine's error
 * message string.
 */

/**
 * **Phase 5.7 V3.4.0.5 (2026-05-23) -- JS-side mirror of the engine
 * `PresenceState` struct.**
 *
 * All fields are required.  Cursor coords are `(sheet, row, col)`;
 * selection-rectangle opposite corner is `(selectionEndRow,
 * selectionEndCol)`.  When no range is selected, set `selectionEnd*`
 * to match the cursor coords (collapsed selection).
 *
 * `typing` is a soft hint for IDE cursor styling (true while peer is
 * mid-edit, e.g., formula bar focused or in-cell edit mode).
 *
 * Engine pairs this type with napi conversion at the FFI boundary
 * (`crates/ql-bindings-node/src/lib.rs` `PresenceStateJson` struct +
 * `From<CorePresenceState>` impls).
 */
export interface PresenceStateJson {
	sheet: number;
	row: number;
	col: number;
	selectionEndRow: number;
	selectionEndCol: number;
	typing: boolean;
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- JS-side mirror of the engine
 * `CellValueJson` napi struct.**
 *
 * Discriminated-union shape: `kind` is one of `"number" | "boolean" |
 * "text" | "error" | "pending"`; exactly one of the optional payload
 * fields is set per non-pending variant; `pending` has all four
 * payloads absent (napi-rs serializes Rust `Option::None` as ABSENT
 * properties; the fields are `undefined`, NOT `null`).  Mirrors the
 * V3.4.0.2 `exportSnapshot` JSON output's per-cell value discriminator,
 * promoted to a typed napi(object) at V3.5.0.2 for the
 * `WorkbookSnapshotJson` surface.
 */
export interface CellValueJson {
	kind: 'number' | 'boolean' | 'text' | 'error' | 'pending';
	// napi-rs serializes Rust Option<T>::None as ABSENT (undefined) at the JS
	// layer, NOT null.  Declared as optional (?:) to reflect this.  IDE
	// consumers MUST switch on `kind` to know which payload field is set.
	number?: number;
	boolean?: boolean;
	text?: string;
	error?: string;
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- one cell entry in a sheet snapshot.**
 *
 * `value` absent = formula-only cell (formula text, no cached literal).
 * `formula` absent = pure literal cell (PutValue, no formula text).
 * Both present = formula evaluated to a literal (formula text + cached
 * value coexist).  All three (value + formula + format) absent cannot
 * occur (V3.4.0.X MEDIUM-1 closure extended at V3.5.0.5 to format --
 * such empty CellState entries are removed from the cache).
 *
 * **napi-rs absence convention** (V3.5.0.X audit-closure A-LOW-1 doc
 * hygiene, 2026-05-24): Rust `Option<T>::None` serializes to ABSENT
 * JS properties (the field is `undefined`, NOT `null`).  Tests assert
 * `=== undefined`.  Use TypeScript's optional `?:` syntax to model
 * this contract.
 */
export interface CellSnapshotJson {
	row: number;
	col: number;
	// napi-rs Option<T>::None -> absent (undefined) at the JS layer.  Declared
	// as optional (?:) to reflect this.  `value: undefined` = formula-only
	// cell; `formula: undefined` = pure literal cell; ALL THREE undefined
	// cannot occur (V3.4.0.X MEDIUM-1 closure extended at V3.5.0.5 -- such
	// empty CellState entries are removed from the cache).
	value?: CellValueJson;
	formula?: string;
	/**
	 * **Phase 5.7 V3.5.0.5 (2026-05-24)** -- per-cell format passthrough.
	 *
	 * `undefined` = no explicit format (cell renders with FormatId::GENERAL
	 * default per the engine).  Set via `Op::SetCellFormat { id: Some(_) }`;
	 * cleared via `Op::SetCellFormat { id: None }`.  V3.5.0.5 ships
	 * passthrough only -- the IDE webview (buildHtml) does NOT consume
	 * format yet; the field round-trips for V3.6+ format-aware rendering.
	 */
	format?: FormatIdJson;
}

/**
 * **Phase 5.7 V3.5.0.5 (2026-05-24)** -- JS-side mirror of the engine
 * `FormatIdJson` napi struct (which mirrors `ql_storage::FormatId`).
 *
 * Discriminated-union shape: `kind` is `"builtin"` or `"custom"`; for
 * builtin the `builtin` field is set (other fields absent); for custom
 * the `customPeer` (bigint -- u64 widened) and `customCounter` (u32)
 * fields are set.
 *
 * napi-rs Option<T>::None -> absent JS property; the alternative-variant
 * fields are `undefined` (not null).  Discriminate via `kind`.
 */
export interface FormatIdJson {
	kind: 'builtin' | 'custom';
	/** Set when `kind === 'builtin'`; undefined otherwise. */
	builtin?: number;
	/** Set when `kind === 'custom'`; undefined otherwise.  u64 widened to bigint. */
	customPeer?: bigint;
	/** Set when `kind === 'custom'`; undefined otherwise. */
	customCounter?: number;
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- one sheet entry in the workbook snapshot.**
 *
 * `id` is the sheet's u16 SheetId widened to JS number (lossless;
 * 0..65535 range fits in JS number safely).  `name` is the sheet's
 * display name (carries the latest RenameSheet effect).  `cells` is
 * sorted (row, col) ascending per snapshot_cells contract.  Empty
 * sheets (created via addSheet but no PutValue/PutFormula) DO appear
 * with `cells: []` (V3.5.0.2 enumerates via Workbook::sheet_count(),
 * not list_sheets_from_cache).
 */
export interface SheetSnapshotJson {
	id: number;
	name: string;
	cells: CellSnapshotJson[];
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- flattened workbook snapshot for
 * IDE-side rendering.**
 *
 * Returned by {@link CollabSessionInstance.workbookSnapshot}.  Per
 * V3.5.0.1 D3: chosen over the alternative (mirror full ql-storage
 * Workbook API across FFI) because the flattened view is pre-shaped
 * for the IDE renderer.
 *
 * **V3.5.0.2 ship**: `sheets` only.  V3.5.0.5 will add `names: NamedRangeJson[]`
 * + `formats: FormatDefJson[]` once the session-wide caches land;
 * additive (no shape break for V3.5.0.2 consumers that destructure
 * `.sheets` only).
 *
 * **Performance note (R-V3.5-1)**: large workbooks produce large JSON.
 * Callers MUST batch (do NOT call per-keystroke); the napi method's
 * per-call cost is O(N) in op count from rebuild_workbook.  V3.6+ may
 * add incremental deltas.
 */
export interface WorkbookSnapshotJson {
	sheets: SheetSnapshotJson[];
}

export interface CollabSessionInstance {
	/**
	 * V1 convenience: append a `PutValue` op with a numeric value.
	 * Full Op enum binding is V2 work; V1 exposes this single variant
	 * because it's the minimum that demonstrates the round-trip.
	 */
	appendPutValue(sheet: number, row: number, col: number, value: number): void;

	/**
	 * **Phase 5.7 V3.4.0.4a (2026-05-23)** -- append an `Op::AddSheet`
	 * to the session.  Sheet ids are deterministic + assigned by the
	 * engine on replay in op-log append order (first `addSheet` call
	 * creates sheet 0, second creates sheet 1, ...).
	 *
	 * Surfaced at V3.4.0.4a because `to_qbook` -> `rebuild_workbook`
	 * replay requires sheets to exist before any `PutValue` on them.
	 * Callers building sessions for .qbook persistence MUST `addSheet`
	 * before `appendPutValue` for that sheet.
	 *
	 * `chunkRows`: per-sheet row partition size for the Workbook's
	 * internal storage (Phase 2A optimization).  Pass 1000 for typical
	 * V3.4 scale.
	 */
	addSheet(name: string, chunkRows: number): void;

	/**
	 * **Phase 5.7 V3.5.0.3a (2026-05-24)** -- append an `Op::RenameSheet`
	 * to this session.  The sheet at `id` is renamed to `newName` at
	 * replay time.  `id` is the current u16 sheet id (the index assigned
	 * by `addSheet` in append order).
	 *
	 * **Contract divergence from engine `WorkbookRuntime::rename_sheet`**:
	 * this napi is a THIN wrapper that appends ONLY `Op::RenameSheet` --
	 * formula text referencing the old sheet name stays stale in the
	 * cache until the next `workbookSnapshot` / `exportToQbook` call,
	 * which triggers Phase 5.3 `repair_sheet_rename_chain` at
	 * rebuild_workbook time.  For V3.5.0.3a scope this is acceptable
	 * (IDE flow always reads through workbookSnapshot).
	 *
	 * **CRDT convergence**: cross-peer renames converge via Phase 5.3
	 * step 3 chain repair; concurrent renames to different names
	 * produce deterministic post-merge state.
	 *
	 * @throws `[bad_argument]` if `id` exceeds u16 range OR refers to
	 *         a non-existent sheet.
	 * @throws `[session_oplog]` / `[session_replay]` per engine errors.
	 */
	renameSheet(id: number, newName: string): void;

	/**
	 * **Phase 5.7 V3.5.0.3b (2026-05-24)** -- append an `Op::RemoveSheet`
	 * to this session (tombstone the sheet at `id`).
	 *
	 * **CRDT semantic (V3.5.0.3b decision lock)**: tombstone preserves
	 * the sheet's id slot (subsequent ops can still reference it by id;
	 * the cell-keyed apply_op handlers silently no-op writes to
	 * tombstoned sheets).  Concurrent re-delete is idempotent.
	 *
	 * **workbookSnapshot filter**: tombstoned sheets are SKIPPED in
	 * the returned snapshot (the IDE renderer doesn't see deleted
	 * sheets).
	 *
	 * **Formula references**: V3.5.0.3b leaves cross-sheet formula
	 * text intact (no `#REF!` substitution).  V3.6+ may extend
	 * repair_sheet_rename_chain to rewrite references to deleted
	 * sheets.
	 *
	 * **No restore**: V3.5.0.3b does not support undo-delete.  Cell
	 * storage is preserved internally but no `restoreSheet` napi
	 * exists.  V3.6+ may add this if a user-facing flow is justified.
	 *
	 * Use the typed wrapper {@link deleteSheet} from `./session`.
	 *
	 * @throws `[bad_argument]` if `id` exceeds u16 range OR refers to
	 *         a non-existent sheet (already-tombstoned is OK -- the
	 *         second delete is an idempotent no-op).
	 * @throws `[session_oplog]` / `[session_replay]` per engine errors.
	 */
	deleteSheet(id: number): void;

	/**
	 * **Phase 5.7 V3.5.0.3c (2026-05-24)** -- append an `Op::MoveSheet`
	 * to this session (reorder sheet's display position; id stays
	 * stable).
	 *
	 * **CRDT semantic (V3.5.0.3c decision lock)**: display-order
	 * overlay -- the underlying `Workbook.sheets` vec is UNCHANGED;
	 * only a separate `sheet_display_order: Vec<SheetId>` is mutated.
	 * Subsequent ops referencing the moved sheet by id keep landing
	 * on the correct sheet (id stability preserved like V3.5.0.3b
	 * tombstone).
	 *
	 * **`newIndex` semantics**: 0-based position in the post-move
	 * display order.  Out-of-range values clamp to end (CRDT
	 * idempotency).
	 *
	 * **Move-tombstoned-sheet**: silently applies (display order
	 * remembers the user's intent even for deleted sheets; snapshot
	 * filters tombstones after display-order resolution).
	 *
	 * **workbookSnapshot**: iterates `sheet_display_order` so the
	 * IDE renderer sees sheets in the user's reorder order.
	 *
	 * Use the typed wrapper {@link moveSheet} from `./session`.
	 *
	 * @throws `[bad_argument]` if `id` exceeds u16 range OR refers to
	 *         a non-existent sheet.  `newIndex >= sheet_count` is OK
	 *         (clamped at replay time).  Tombstoned sheets are OK.
	 * @throws `[session_oplog]` / `[session_replay]` per engine errors.
	 */
	moveSheet(id: number, newIndex: number): void;

	/** Full snapshot export. Use for initial sync / handshake. */
	exportBytes(): Uint8Array;

	/**
	 * **Phase 5.7 V3.2.a (2026-05-22) -- cell-snapshot export for the
	 * IDE grid widget.**
	 *
	 * Returns a JSON-serialized snapshot of the latest `PutValue` per
	 * `(row, col)` on the requested sheet. Use `exportCellSnapshot()`
	 * from `./session` to parse the return value into the typed
	 * {@link QuantbookCellSnapshot} shape.
	 *
	 * V3.2.a scope: PutValue ops only (the only Op variant V1 binding
	 * exposes). V3.2.b+ may upgrade to route through
	 * `rebuild_workbook` when the full Op enum lands.
	 *
	 * Entries are sorted by `(row, col)` for deterministic output.
	 *
	 * @param sheet u16 sheet ID (0-based).
	 * @returns JSON string conforming to {@link QuantbookCellSnapshot}.
	 * @throws Error with `parseQuantbookError(err).code === 'bad_argument'`
	 *         if the op log iterator or JSON serializer fails.
	 */
	exportSnapshot(sheet: number): string;

	/**
	 * **Phase 5.7 V3.3.0.2 (2026-05-22) -- enumerate distinct sheets
	 * present in the local op log.**
	 *
	 * Returns a sorted ascending array of u16 sheet IDs that have at
	 * least one `PutValue` op in the local op log.  Use the typed
	 * wrapper {@link listSheets} from `./session` rather than calling
	 * this method directly -- the wrapper returns `number[]` with
	 * proper TS typing on the array contents.
	 *
	 * V3.3.0 design decision D3 (LOCKED): u16-only return.  Display
	 * name + color + hidden flags wait for V3.4+'s `SheetMetadata` Op
	 * variant + a separate `listSheetsMetadata()` accessor.
	 *
	 * @returns sorted ascending Vec<u16> of distinct sheets referenced
	 *          by `PutValue` ops; empty array if no `PutValue` ops have
	 *          been appended.
	 * @throws Error with `parseQuantbookError(err).code === 'bad_argument'`
	 *         if the op log iterator fails.
	 */
	listSheets(): number[];

	/**
	 * Merge a snapshot (or delta) from another peer. Returns the
	 * session's `opCount` AFTER the merge (NOT the number of newly
	 * merged ops -- duplicates are deduped by Loro but the return
	 * value is the post-merge total).
	 *
	 * **V1 audit closure (Codex M2, 2026-05-22)**: the original
	 * docstring claimed "count of ops actually merged" implying a
	 * delta. Verified empirically by calling `mergeBytes` twice with
	 * the same snapshot: both calls return the same `opCount` value.
	 * V2 may add a `mergeBytesDelta` companion that returns just the
	 * newly merged count, once the use case (e.g., "warn if peer
	 * sent us X new ops") materializes.
	 */
	mergeBytes(bytes: Uint8Array): number;

	/** Local op log length (visible LoroList). */
	opCount(): number;

	/**
	 * V2 V4 V1 step 2 helper: count of ops added since the last
	 * successful flush. Uses VV math (monotonic under undo). Sibling
	 * invariant: `pendingOpCount() > 0` iff `hasPendingFlush() === true`.
	 *
	 * V1 has no Transport binding, so this returns the count vs the
	 * empty baseline (same as `opCount()` for a never-flushed session).
	 * V2 makes this interesting once Transport surface is bound.
	 */
	pendingOpCount(): number;

	/** V2 V3 step 3 helper: `true` when local ops haven't been flushed. */
	hasPendingFlush(): boolean;

	/** Peer ID of this session, as a BigInt (u64-domain). */
	peerId(): bigint;

	/**
	 * **Phase 5.7 V3.4.0.3 (2026-05-23) -- undo the session's last
	 * local op.**
	 *
	 * Returns `true` if the Loro `UndoManager` stack item was consumed
	 * (an inverse op got appended to the visible log) and `false` if
	 * the stack was empty (caller's "Cmd-Z when nothing to undo"
	 * no-op).  LOCAL-ONLY: remote ops merged via `mergeBytes` /
	 * `pollRemote` are NOT affected.
	 *
	 * **Post-consumed invariant**: the V3.3.0.X HIGH-1 closure ensures
	 * the engine rebuilds `last_snapshot` (V3.4.0.2 `CellState` shape)
	 * BEFORE returning, so a subsequent `exportSnapshot` reads the
	 * post-undo view atomically.
	 *
	 * **Auto-flush**: if a transport is attached via `attachTransport`
	 * + `setAutoFlushPolicy('onAppend')`, a consumed undo triggers
	 * auto-flush (peers receive the inverse op).  Empty-stack undo
	 * never attempts the flush -- closed transport cannot turn
	 * "nothing to undo" into a spurious error.
	 *
	 * Use the typed wrapper {@link undo} from `./session`.
	 *
	 * @throws Error with `parseQuantbookError(err).code` per the
	 *         engine's CollabSessionError kind (e.g., `transport_closed`
	 *         during auto-flush after a consumed undo).
	 */
	undo(): boolean;

	/**
	 * **Phase 5.7 V3.4.0.3 (2026-05-23) -- redo the last undone op.**
	 *
	 * Mirrors {@link undo} for the redo direction; same consumed-bool
	 * return + cache + auto-flush + error semantics.
	 *
	 * Use the typed wrapper {@link redo} from `./session`.
	 */
	redo(): boolean;

	// =====================================================================
	// Phase 5.7 V3.4.0.5 (2026-05-23) -- presence surface (engine napi only)
	// IDE wiring (cell-grid decoration, sweep cadence, race guard) lands in
	// V3.4.0.5 IDE follow-up.
	// =====================================================================

	/**
	 * Write this session's own presence state into the shared LoroMap.
	 *
	 * Uses the session's PeerId as the map key (16-hex Display form).
	 * Subsequent calls overwrite the prior value (LWW per peer); merges
	 * with other peers' presence writes preserve all distinct peers.
	 *
	 * Use the typed wrapper {@link updatePresence} from `./session`.
	 */
	updatePresence(state: PresenceStateJson): void;

	/**
	 * Read a peer's most recent presence state.
	 *
	 * Returns `null` if the peer has never updated presence in this
	 * session (or was removed via {@link clearPresence} /
	 * {@link sweepPresence}).
	 */
	peerPresence(peer: bigint): PresenceStateJson | null;

	/**
	 * Remove this session's own presence entry from the shared map.
	 *
	 * Use when the peer leaves the session (window close, disconnect).
	 * After removal, other peers' `peerPresence(selfId)` returns `null`.
	 */
	clearPresence(): void;

	/**
	 * Remove ALL presence entries from the shared map.  Returns the
	 * count of peers removed.
	 *
	 * V1 contract: sweeps every entry unconditionally (no threshold).
	 * Use after {@link fromSnapshot} for "rejoin with clean presence":
	 * presence persists in the LoroDoc snapshot (V1 known limitation).
	 *
	 * Auto-flush triggers ONCE after the batch removal (not per-key).
	 */
	sweepPresence(): number;

	/**
	 * Enumerate peer-ids that have presence entries.
	 *
	 * Iteration order is Loro-internal (NOT guaranteed sorted).
	 * Callers needing determinism should `.sort((a, b) => a < b ? -1 :
	 * a > b ? 1 : 0)` (BigInt comparison).
	 *
	 * Use as the enumeration primitive for "who's here" panels: first
	 * call this, then call {@link peerPresence} per returned id.
	 */
	peersWithPresence(): bigint[];

	// =====================================================================
	// Phase 5.7 V3.5.0.2 (2026-05-24) -- workbook snapshot napi (D3)
	// =====================================================================

	/**
	 * Return the full workbook flattened to a JSON-serializable
	 * snapshot for IDE rendering.  See {@link WorkbookSnapshotJson}.
	 *
	 * Per-call cost is O(N) in op count (rebuild_workbook materializes
	 * a fresh Workbook to enumerate sheet names + count); per-sheet
	 * cells come from the V3.3.0.3 incremental cache.
	 *
	 * Use the typed wrapper {@link workbookSnapshot} from `./session`.
	 *
	 * @throws Error with `parseQuantbookError(err).code === 'session_oplog'`
	 *         if rebuild_workbook fails (replay error / rename-repair).
	 */
	workbookSnapshot(): WorkbookSnapshotJson;

	// =====================================================================
	// Phase 5.7 V3.4.0.4a (2026-05-23) -- .qbook persistence (save side)
	// (load side is the {@link CollabSessionConstructor.fromQbook} factory).
	// =====================================================================

	/**
	 * Save this session to a `.qbook` directory at `path`.
	 *
	 * Atomic two-file write (workbook.toml + oplog.bin) via the Tier
	 * D3 envelope format.  The persistence helper requires a fully-
	 * rebuilt Workbook; the napi impl calls `rebuild_workbook` +
	 * `default_registry` internally (V3.4.0.4 plan note: engine-side
	 * Workbook materialization at save IS allowed even though
	 * IDE-side Workbook consumption stays V3.5+ scope).
	 *
	 * Throws engine errors with structured codes via parseQuantbookError:
	 * - `[session_oplog]` rebuild_workbook failure (replay or repair)
	 * - `[qbook_error]` persistence layer failure (I/O, schema)
	 */
	toQbook(path: string): void;

	// =====================================================================
	// Phase 5.7 V2.1 (2026-05-22) -- Transport surface (sync portion)
	// =====================================================================

	/**
	 * Attach a Transport to this session. The `transport` instance is
	 * CONSUMED -- subsequent calls with the same wrapper throw.
	 *
	 * Resets the session's per-transport VV baseline (Phase 5.5 V2 V3
	 * step 1 contract): the next flush sends from empty VV, delivering
	 * all local ops including any appended while no transport was
	 * attached. Loro's CRDT op log IS the implicit offline queue.
	 *
	 * @throws Error if `transport` has already been consumed.
	 */
	attachTransport(transport: TransportInstance): void;

	/**
	 * Detach the currently-attached transport. Returns `true` if one
	 * was attached (now released, its background tasks dropped),
	 * `false` if there was nothing to detach.
	 *
	 * V2.1 drops the returned `Box<dyn Transport>` Rust-side -- JS
	 * does not receive the prior transport.
	 */
	detachTransport(): boolean;

	/** `true` iff a transport is currently attached. */
	hasTransport(): boolean;

	/**
	 * Full-snapshot flush to the attached transport. Returns `true` if
	 * bytes were sent, `false` if no transport is attached.
	 *
	 * **Use the upcoming `flushDeltaToTransport` instead in production**
	 * once V2.2 ships -- delta flushes are O(per-op delta) vs O(full
	 * state).
	 *
	 * @throws Error if the transport's `send` returns an error.
	 */
	flushToTransport(): boolean;

	/**
	 * Drain inbound BLOBS from the attached transport (single-pass).
	 * Returns the count of BLOBS drained (NOT the count of ops),
	 * capped by the engine's default poll limit (`DEFAULT_POLL_REMOTE_LIMIT
	 * = 64`). Each blob is one snapshot/delta that may contain many ops;
	 * to count ops, compare `opCount()` before vs after.
	 *
	 * `0` if no transport is attached or no bytes were queued.
	 *
	 * **V2.1 audit closure (Codex MEDIUM-1, 2026-05-22)**: the prior
	 * docstring said "count of ops merged" which contradicted the
	 * engine's semantics (`poll_remote_with_limit` returns `merged <=
	 * max_blobs`). Mocha test "three-mutation chain across LoopbackPair"
	 * empirically discovered this and now pins the blob-count contract.
	 *
	 * @throws Error if the transport's `try_recv` or the merge step
	 *               returns an error.
	 */
	pollRemote(): number;

	// =====================================================================
	// Phase 5.7 V2.2 (2026-05-22) -- full sync Transport surface
	// =====================================================================

	/**
	 * Delta flush to the attached transport. Sends ONLY the ops added
	 * since the last successful flush. Returns `true` if bytes were
	 * actually sent.
	 *
	 * **Production default**. Prefer this over `flushToTransport`
	 * (full-snapshot) which is O(full state). Delta flushes are
	 * O(per-op delta).
	 *
	 * Idempotency: no state changed since last flush -> returns
	 * `false` without invoking `transport.send` (closes the V2 V2
	 * audit echo-loop concern).
	 *
	 * Per V2 V3 step 1: `attachTransport` resets the per-transport
	 * VV baseline, so the next `flushDeltaToTransport` after an attach
	 * sends from empty -- delivering ALL ops including any appended
	 * while offline (Loro's op log IS the implicit offline queue).
	 *
	 * @throws Error if the transport's `send` returns an error.
	 */
	flushDeltaToTransport(): boolean;

	/**
	 * Like `pollRemote` but with an explicit per-call cap on the
	 * number of blobs to drain. Returns the blob count, `<= limit`.
	 *
	 * Returned-count semantics:
	 * - `limit === 0` -> always returns 0 (no-op even if blobs queued).
	 * - Returned count `=== limit` -> more blobs may be queued; call again.
	 * - Returned count `< limit` -> queue drained.
	 *
	 * @param limit Non-negative integer in `[0, u32::MAX]`. NaN /
	 *              Infinity / fractional / negative throw.
	 *
	 * @throws Error if `limit` is invalid OR transport `try_recv` errors.
	 */
	pollRemoteWithLimit(limit: number): number;

	/**
	 * The attached transport's most recent error message, or `null` if
	 * no transport is attached OR the transport reports no error.
	 *
	 * **Use case**: after a mutator throws `Error("transport closed")`
	 * (or similar), call this to distinguish underlying causes (peer
	 * reset vs auth rejection vs capacity exceeded for V2.3+
	 * WebSocketTransport) and pick the reconnect strategy.
	 *
	 * **V2.2 audit-deferred caveat (Opus MEDIUM-3)**: error strings are
	 * lossy `Display` projections of the underlying enum. IDE callers
	 * today must substring-match to distinguish categories. V2.3+ will
	 * add structured discrimination via napi `Error.code`.
	 */
	transportLastError(): string | null;

	/**
	 * Set the auto-flush policy. Returns the prior policy as a string.
	 *
	 * Accepted: `'disabled'` (default) or `'onAppend'`. Other strings
	 * throw with a precise error.
	 *
	 * `'onAppend'` semantics (V2 V2 + V2 V3 steps 1+2): every public
	 * mutator auto-fires a delta flush after the mutation. Idempotency
	 * short-circuits no-op state changes; `pollRemote*` fires once
	 * after the batch (not per-blob).
	 *
	 * @throws Error on unknown policy string.
	 */
	setAutoFlushPolicy(policy: AutoFlushPolicy): AutoFlushPolicy;

	/**
	 * Read the current auto-flush policy. `'disabled'` is the default.
	 *
	 * **V2.2 audit closure (Opus HIGH-1, 2026-05-22)**: throws if the
	 * engine reports a variant unknown to this binding (forward-compat
	 * skew -- engine ships a new variant ahead of the binding crate
	 * being upgraded). Prior version returned `'unknown'` as a silent
	 * sentinel; per CLAUDE.md no-fallback rule that was wrong (JS
	 * `policy === 'onAppend'` would silently fall through to the
	 * `disabled` branch). Throwing surfaces the skew loudly and forces
	 * a binding upgrade.
	 *
	 * @throws Error if the engine variant is unknown to this binding.
	 */
	autoFlushPolicy(): AutoFlushPolicy;

	// =====================================================================
	// Phase 5.7 V2.5 (2026-05-22) -- async Transport surface, V8-BLOCK CLOSED
	// =====================================================================

	/**
	 * Async flush-pending. Waits for the attached transport's writer
	 * task to drain blobs queued AT THIS CALL (Codex M1 contract:
	 * target captured at handle extraction, NOT at wait-start).
	 *
	 * **V2.5 V8-block closure (2026-05-22)**: V2.4 reintroduced this
	 * soundly (closed V2.3 UB + tokio-starvation HIGHs via the
	 * `Arc<parking_lot::Mutex<...>>` refactor) BUT held the session
	 * lock during the Condvar wait -- Opus V2.4 HIGH-1 flagged the
	 * resulting V8-block UX hazard. V2.5 closes it: the binding now
	 * extracts a detached `FlushAck` handle while holding the session
	 * lock, drops the lock, then performs the Condvar wait without
	 * the session lock held. Concurrent JS sync method calls on the
	 * same session acquire the lock immediately -- the V8 event loop
	 * stays responsive.
	 *
	 * **V2.3 + V2.4 soundness retained**:
	 * - `&self`, not `&mut self`. napi-rs codegen produces shared `&`;
	 *   no aliasing UB possible.
	 * - `spawn_blocking` runs the wait on tokio's blocking pool, NOT
	 *   the worker pool. No runtime starvation.
	 *
	 * **Resolution / rejection contract** (V2.8 megaudit Codex Lane A
	 * MEDIUM-1 closure, 2026-05-22):
	 *
	 * Resolves when:
	 * - the writer has completed `send` for every blob queued AT THIS
	 *   CALL (V2.5 Codex M1: target captured at handle extraction);
	 * - there is no attached transport, OR the attached transport
	 *   returns `None` from `ack_handle()` (Loopback, Noop -- no
	 *   async-drain semantics; flush is synchronous-on-attach).
	 *
	 * Rejects with:
	 * - `parseQuantbookError(err).code === 'transport_closed'` if the
	 *   transport's closed flag is set on entry to the wait OR is
	 *   tripped while waiting. This is the correct reconnect signal.
	 * - `'transport_io'` for non-closed transport errors surfaced by
	 *   the underlying handle.
	 * - `'unknown'` (with `parseQuantbookError` walking the
	 *   `Error.cause` chain via V2.8 closure) if the `spawn_blocking`
	 *   task panics -- the wrapper Error has no bracket prefix, but
	 *   the cause does.
	 *
	 * @throws Error -- see the rejection contract above.
	 */
	flushPendingToTransport(): Promise<void>;
}

// ============================================================================
// Phase 5.7 V3.2.a (2026-05-22) -- cell-snapshot types for IDE grid widget
// ============================================================================

/**
 * Tagged-union mirror of the engine's `ql_oplog::CellWireValue`.
 *
 * Used inside {@link QuantbookCellSnapshot.entries[].value}. The
 * `kind` discriminator + `value` payload pattern matches the engine's
 * `serde_json` serialization at
 * `crates/ql-bindings-node/src/lib.rs::CollabSession::export_snapshot`.
 *
 * **Pending**: cell has a formula but no evaluated value yet
 * (recompute pending). V3.2.a binding does not emit formulas (V1
 * binding's only Op variant is `PutValue`), so `pending` is
 * structurally defined but not currently produced; V3.2.b+ will
 * surface it once formula support is added.
 */
export type QuantbookCellValue =
	| { kind: 'number'; value: number }
	| { kind: 'boolean'; value: boolean }
	| { kind: 'text'; value: string }
	| { kind: 'error'; value: string }
	| { kind: 'pending' };

/**
 * Decoded shape of `CollabSession.exportSnapshot(sheet)` (V3.2.a).
 *
 * Use {@link exportCellSnapshot} in `./session` rather than parsing
 * by hand -- the helper handles JSON parsing + type narrowing.
 *
 * **snapshot_format_version = 1**: the engine pins this; future
 * changes must bump the version and the IDE must check it. Treat
 * any non-1 version as a binding-drift error.
 *
 * Entries are sorted by `(row, col)` ascending; virtualized grid
 * renderers can rely on this ordering for stable row-based slicing.
 */
export interface QuantbookCellSnapshot {
	readonly snapshot_format_version: 1;
	readonly sheet: number;
	readonly entries: ReadonlyArray<{
		readonly row: number;
		readonly col: number;
		readonly value: QuantbookCellValue;
	}>;
}

// ============================================================================
// Phase 5.7 V2.6 (2026-05-22) -- BlockingTransportFixture (test fixture)
// ============================================================================

/**
 * V2.6 test fixture for V2.5 contract testing. Wraps the engine-side
 * `BlockingTransport` (feature-gated behind `test-fixtures` on ql-collab).
 *
 * **NOT for production use** -- the underlying transport blocks
 * `flush_pending` indefinitely until `release()` is called (or the
 * constructor's `blockMs` upper bound elapses). Production callers
 * would deadlock.
 *
 * Mirrors V2.1 `LoopbackPair`'s single-use take pattern: construct
 * the fixture, call `takeTransport()` once to obtain a `Transport`
 * for `attachTransport(t)`, then drive `release()` + `waitUntilBlocked()`
 * from test code.
 */
export interface BlockingTransportFixtureInstance {
	/**
	 * Take ownership of the inner `BlockingTransport`, wrapped in a
	 * `Transport` instance attachable to a `CollabSession`.
	 *
	 * Single-use: errors on the second call. The fixture controller
	 * retains its `release` + `blocked` Condvars after the take so
	 * `release()` + `waitUntilBlocked()` can drive the transport
	 * that now lives inside a `CollabSession`.
	 *
	 * @throws Error on the second call.
	 */
	takeTransport(): TransportInstance;

	/**
	 * Flip the release Condvar so any in-progress `flush_pending`
	 * or `wait_for_drain` exits. Idempotent (calling twice is safe).
	 */
	release(): void;

	/**
	 * Async wait until the fixture's wait routine has actually
	 * entered the Condvar wait (engine-side `wait_blocked` set the
	 * `blocked` flag + notified).
	 *
	 * **Codex M3 fix (2026-05-22)**: deterministic synchronization
	 * point for V2.5 contract tests. Without it, an `opCount()` call
	 * during a pending `flushPendingToTransport` could race ahead of
	 * the `spawn_blocking` task and pass vacuously.
	 */
	waitUntilBlocked(): Promise<void>;
}

export interface BlockingTransportFixtureConstructor {
	/**
	 * Construct a fresh `BlockingTransportFixture`.
	 *
	 * @param blockMs Upper-bound wait duration in milliseconds. Must be
	 *                a finite integer in `[1, u32::MAX]` (strictly
	 *                positive). `0` is REJECTED at the napi boundary
	 *                with a `[bad_argument]` error (V2.5 audit closure
	 *                Codex MEDIUM-1: zero would allow indefinite
	 *                blocking from JS -- bounded self-DoS footgun).
	 *                The engine-side `BlockingTransport::new(0, ...)`
	 *                remains for Rust unit tests that explicitly want
	 *                the indefinite-wait path; the napi fixture caps
	 *                the surface to `[1, u32::MAX]`.
	 * @throws Error with code `'bad_argument'` if `blockMs` is `0`,
	 *               non-finite, negative, fractional, or out-of-u32.
	 */
	new(blockMs: number): BlockingTransportFixtureInstance;
}

/**
 * Auto-flush policy string union. Mirrors `ql_collab::AutoFlushPolicy`
 * (Rust enum), bound as JS strings via the napi
 * `setAutoFlushPolicy` / `autoFlushPolicy` methods.
 *
 * - `'disabled'`: explicit-drive (V2 V1 behavior). Caller invokes
 *   `flushDeltaToTransport` + `pollRemote*` on a tick.
 * - `'onAppend'`: every mutator + `pollRemote*` auto-fires a delta
 *   flush.
 *
 * The engine's underlying enum is `#[non_exhaustive]`. Future variants
 * require this union to be widened AND the napi binding's
 * `parse_auto_flush_policy` + `auto_flush_policy_to_string` helpers to
 * be updated. Until both layers are upgraded, `autoFlushPolicy()`
 * throws on the new variant (V2.2 closure of Opus HIGH-1: no
 * silent-sentinel fall-through).
 */
export type AutoFlushPolicy = 'disabled' | 'onAppend';

export interface CollabSessionConstructor {
	new(peerId: bigint): CollabSessionInstance;

	/** Reconstruct a session from a previously-exported snapshot. */
	fromSnapshot(peerId: bigint, bytes: Uint8Array): CollabSessionInstance;

	/**
	 * **Phase 5.7 V3.4.0.4a (2026-05-23) -- load a session from a
	 * `.qbook` directory at `path`.**
	 *
	 * `peerIdOverride` MUST be a fresh / stored-previously BigInt
	 * peer-id.  V3.4.0.4a engine layer is peer-id-agnostic;
	 * V3.4.0.4b IDE commands generate UUID-derived BigInts via
	 * `crypto.randomUUID()` for cross-restart collision-resistance
	 * (closes R-V3.3-5 / V3.4.0.1 D5).
	 *
	 * Throws engine errors with structured codes via parseQuantbookError:
	 * - `[bad_argument]` peerIdOverride zero / negative / exceeds u64
	 * - `[qbook_error]` workbook.toml missing/malformed/schema mismatch
	 * - `[qbook_unsupported_version]` / `[qbook_truncated_header]`
	 *    oplog.bin Tier D3 header issues
	 * - `[session_oplog]` Loro snapshot decode failure
	 */
	fromQbook(path: string, peerIdOverride: bigint): CollabSessionInstance;
}

// =====================================================================
// Phase 5.7 V2.1 (2026-05-22) -- Transport binding type declarations
// =====================================================================

/**
 * Opaque wrapper for a `Box<dyn ql_collab::Transport + Send>`.
 *
 * **Single-use semantics**: an instance owns its boxed trait object.
 * `CollabSession.attachTransport(t)` MOVES the box out, leaving the
 * wrapper consumed. After consumption, `isAttachable()` returns
 * `false` and subsequent `attachTransport` calls with the same
 * wrapper throw.
 *
 * Instances are obtained from factory classes (V2.1: `LoopbackPair`;
 * V2.3+: `Transport.websocketConnect(url)`).
 */
export interface TransportInstance {
	/**
	 * `true` while this wrapper still owns its inner transport.
	 * `false` after passing to `attachTransport` (or any other
	 * future API that consumes the wrapper).
	 *
	 * Useful for branching without exception handling:
	 * ```ts
	 * if (transport.isAttachable()) {
	 *   session.attachTransport(transport);
	 * }
	 * ```
	 */
	isAttachable(): boolean;
}

/**
 * Two-ended in-process Transport pair (`LoopbackTransport`).
 *
 * **V2.1 entry point** for obtaining paired Transport instances. The
 * pair's two ends share an in-process queue: bytes sent on end A
 * arrive at end B's `try_recv` and vice versa.
 *
 * Each end can be `take`-n once. Calling `takeA` (or `takeB`) a
 * second time on the same pair throws. The two takes are
 * independent (taking A doesn't affect taking B).
 */
export interface LoopbackPairInstance {
	/**
	 * Take ownership of end A. Each `LoopbackPair` instance can have
	 * `takeA` called once.
	 * @throws Error on the second call.
	 */
	takeA(): TransportInstance;

	/**
	 * Take ownership of end B. Each `LoopbackPair` instance can have
	 * `takeB` called once.
	 * @throws Error on the second call.
	 */
	takeB(): TransportInstance;
}

export interface LoopbackPairConstructor {
	new(): LoopbackPairInstance;
}

/**
 * Top-level exports from the native `.dylib` / `.so` / `.dll`. Loaded
 * via {@link loadQuantbookEngine} in `./loader`.
 */
export interface QuantbookNativeModule {
	/** Smoke method exposing the binding crate's own version. */
	version(): string;

	/** Session class -- see {@link CollabSessionInstance}. */
	readonly CollabSession: CollabSessionConstructor;

	/**
	 * V2.1: opaque Transport wrapper. JS-side this is mostly used
	 * as a parameter type to `CollabSession.attachTransport`.
	 * The constructor is NOT directly exposed -- obtain instances
	 * via factories like `LoopbackPair`.
	 *
	 * **V2.3 (2026-05-22)**: added `websocketConnect(url)` static
	 * async factory that resolves with a Transport wrapping a
	 * `WebSocketTransport`. See `flushPendingToTransport` for the
	 * matching async drain helper.
	 */
	readonly Transport: {
		prototype: TransportInstance;
		/**
		 * Async factory: connect to a WebSocket peer and return a
		 * Transport wrapping the live connection.
		 *
		 * @param url `ws://host:port` URL. No TLS in V2.3.
		 * @returns Promise resolving with the Transport (single-use;
		 *          pass to `attachTransport` once).
		 * @throws  Error with WebSocket failure category in the
		 *          message (`WebSocket connection failed`,
		 *          `WebSocket handshake failed`, `invalid WebSocket URL`).
		 */
		websocketConnect(url: string): Promise<TransportInstance>;
	};

	/**
	 * V2.1: LoopbackPair class -- factory for paired in-process
	 * Transport ends.
	 */
	readonly LoopbackPair: LoopbackPairConstructor;

	/**
	 * V2.6 (2026-05-22): BlockingTransportFixture class -- test
	 * fixture for V2.5 V8-block contract testing. See
	 * {@link BlockingTransportFixtureInstance}.
	 *
	 * **NOT for production code** -- the underlying transport blocks
	 * `flush_pending` indefinitely until released.
	 *
	 * **V2.8 megaudit closure (Opus-B Lane C HIGH-1 + Lane A LOW-1
	 * convergent, 2026-05-22)**: this constructor is now OPTIONAL on
	 * the loaded module. Production cdylib builds (built without
	 * `--features test-fixtures` on `ql-bindings-node`) do NOT carry
	 * `BlockingTransportFixture` -- eliminating the self-DoS surface
	 * where in-process JS could park tokio blocking-pool threads for
	 * u32::MAX milliseconds via `attachTransport(fixture.takeTransport())`.
	 * Mocha + contention contract tests MUST rebuild the cdylib with
	 * `cargo build -p ql-bindings-node --release --features test-fixtures`
	 * and check `if (engine.BlockingTransportFixture) { ... }` before
	 * use. Production runtime code MUST NOT touch this constructor.
	 */
	readonly BlockingTransportFixture?: BlockingTransportFixtureConstructor;
}

// ============================================================================
// Phase 5.7 V2.7 (2026-05-22) -- structured error-code discrimination
// ============================================================================

/**
 * Stable string identifier for an engine error variant, extracted from
 * the bracketed prefix that the napi binding prepends to thrown
 * `Error.message`. IDE reconnect logic can switch on these codes
 * without substring-matching the human-readable `Display` text.
 *
 * **Codes are SemVer-stable.** Engine-side
 * `crates/ql-collab/src/transport.rs::TransportError::kind`,
 * `crates/ql-collab-ws/src/lib.rs::WebSocketError::kind`, and
 * `crates/ql-collab/src/session.rs::CollabSessionError::kind` are
 * the authoritative sources; this union mirrors them.
 *
 * **Closes V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards**: prior to
 * V2.7, IDE callers had to substring-match error messages to
 * distinguish transport-closed from transport-io etc. This was
 * lossy and fragile across Display-string edits.
 */
export type QuantbookErrorCode =
	// Transport-layer errors (`TransportError::kind`)
	| 'transport_io'
	| 'transport_closed'
	// WebSocket-layer errors (`WebSocketError::kind`).
	// Surfaced by `Transport.websocketConnect` on rejection.
	//
	// **V2.7 audit note (Codex LOW-1 + Opus LOW-3)**: today's only
	// reachable websocket codes via napi rejection paths are
	// invalid_url, connect_failed, handshake_failed. The
	// `websocket_runtime_error` code is structurally defined for
	// when V2 backlog adds a structured `transportLastError()`
	// accessor that produces the prefix; today, runtime task
	// failures surface as raw strings via the unstructured
	// `transportLastError()` method (no prefix). Reachability
	// boundary documented at engine `WebSocketTransport::last_error`.
	| 'websocket_invalid_url'
	| 'websocket_connect_failed'
	| 'websocket_handshake_failed'
	| 'websocket_runtime_error'
	// Session-layer errors (`CollabSessionError::kind`).
	// Note: `Transport(_)` passes through to the inner transport
	// kind (e.g. `transport_closed`), not a wrapper string. IDE
	// callers branching on transport state get the same code
	// whether the path was direct Transport call or wrapped via
	// session method (see Opus V2.7 MEDIUM-3 for the contractual
	// trade-off + documented passthrough rationale).
	| 'session_oplog'
	| 'session_presence'
	| 'session_undo'
	| 'session_replay'
	// **V3.4.0.4a (2026-05-23)**: persistence-layer errors emitted by
	// the napi `toQbook` / `fromQbook` wrappers via
	// `persistence_error_to_napi`.  The PersistenceError enum is
	// `#[non_exhaustive]` so a `qbook_unknown` sentinel covers future
	// variants until this list is extended.
	| 'qbook_error'
	| 'qbook_unsupported_version'
	| 'qbook_truncated_header'
	| 'qbook_unknown'
	// **V2.7 audit closure (Opus MEDIUM-2, 2026-05-22)**: napi-layer
	// argument validation + single-use violation errors that are
	// NOT engine error types (peerId range check, blockMs > 0,
	// LoopbackPair takeA/B exhaustion, Transport wrapper consumed,
	// AutoFlushPolicy parse, validate_u32_index for direct callers).
	// V2.7 ship surfaced these as raw `Error::from_reason("...")`
	// strings (no prefix), silently bucketing under `'unknown'` and
	// re-opening V2.1+V2.2+V2.3 MEDIUM-3 at the binding boundary.
	// Closure: all such errors now carry the `[bad_argument]` prefix
	// per the napi binding's `bad_argument_error_to_napi` helper.
	| 'bad_argument'
	// Fallback when the message has no recognizable code prefix.
	// Typically means the error came from non-engine, non-binding
	// code (napi task panic, JS-side throw, runtime task error
	// surfaced via the prefix-less `transportLastError()` path).
	// **NOTE**: `'unknown'` is the parser fallback sentinel; the
	// engine binding NEVER emits a literal `[unknown]` prefix per
	// the V2.7 audit closure (Opus MEDIUM-1). See
	// `KNOWN_QUANTBOOK_ERROR_CODES` set comment in session.ts.
	| 'unknown';

/**
 * Structured view of a Quantbook engine error, extracted from the
 * `[<code>] <message>` convention that the napi binding uses.
 *
 * Use [`parseQuantbookError`] to construct from a caught `unknown`.
 */
export interface QuantbookErrorInfo {
	/**
	 * Stable code identifier; one of the {@link QuantbookErrorCode}
	 * values. `'unknown'` if the error message had no recognizable
	 * code prefix.
	 */
	readonly code: QuantbookErrorCode;
	/**
	 * Human-readable message; the original `Error.message` with the
	 * `[<code>] ` prefix stripped. For `'unknown'` errors, the full
	 * original message.
	 */
	readonly message: string;
	/**
	 * The original caught value, for callers that need to re-throw
	 * or inspect non-Error throwables (strings, numbers, custom
	 * classes, etc.).
	 */
	readonly cause: unknown;
}
