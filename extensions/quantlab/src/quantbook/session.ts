/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- thin TypeScript wrapper over the napi
 * `CollabSession` class.
 *
 * The wrapper exists so:
 * 1. Consumer code imports a STABLE TS-side identifier
 *    (`QuantbookSession`) instead of reaching into a dynamically-loaded
 *    module. The loader is hot-pathed once at startup; the wrapper
 *    holds the resolved native class.
 * 2. We can attach JSDoc + IDE-side validation that the napi layer
 *    doesn't (e.g., reject negative `sheet` integers before the BigInt
 *    boundary makes the error less actionable).
 * 3. V2 / V3 can grow the wrapper without changing the napi surface
 *    (e.g., add async retry wrappers around `mergeBytes`).
 *
 * **Per V1 scope:** no Transport, no presence, no undo, no formula
 * support. See engine repo's `docs/phase5/5-7-v1-exit-packet.md`
 * section "V1 deferred to V2" for the full V1 deferred list
 * (engine + IDE).
 */

import { loadQuantbookEngine } from './loader';
import type {
	AutoFlushPolicy,
	CollabSessionInstance,
	LoopbackPairInstance,
	PresenceStateJson,
	QuantbookCellSnapshot,
	QuantbookErrorCode,
	QuantbookErrorInfo,
	TransportInstance,
	WorkbookSnapshotDeltaJson,
	WorkbookSnapshotJson,
} from './types';

/**
 * Construct a fresh `CollabSession` for the given peer.
 *
 * @param peerId Non-zero u64-domain peer identifier. Throws if `0n`,
 *               negative, or doesn't fit in u64.
 */
export function createSession(peerId: bigint): CollabSessionInstance {
	const engine = loadQuantbookEngine();
	return new engine.CollabSession(peerId);
}

/**
 * Append a `PutValue` op with JS-side input validation that the napi
 * layer cannot perform (due to ECMAScript ToUint32 coercion happening
 * BEFORE the Rust code sees the value).
 *
 * **V1 audit closure (Opus H2 + Codex H3, 2026-05-22)**: napi-rs's
 * `napi_get_value_uint32` applies ECMAScript ToUint32 to JS Number
 * arguments. That converts:
 *   - `-1` to `0xFFFFFFFF` (silent wrap)
 *   - `NaN` to `0` (silent coercion)
 *   - `Infinity` to `0` (silent coercion)
 *   - `2.5` to `2` (silent floor-toward-zero)
 *
 * The Rust binding sees the post-ToUint32 value and has no way to
 * detect the original JS-side intent. Validate at the TS layer
 * BEFORE the call so each failure surfaces a precise error.
 *
 * @throws Error if sheet/row/col aren't non-negative integers in range,
 *               or if value isn't a finite number.
 */
export function appendPutValueValidated(
	session: CollabSessionInstance,
	sheet: number,
	row: number,
	col: number,
	value: number,
): void {
	// V3.2.d HIGH-2 closure (2026-05-22): all IDE-side validator
	// throws carry the `[bad_argument]` bracketed prefix so
	// `parseQuantbookError(err).code` resolves to `'bad_argument'` --
	// matching the engine-side validator contract from V2.7.
	// Pre-V3.2.d these threw plain `Error` strings without the prefix,
	// which `parseQuantbookError` bucketed under `'unknown'`,
	// breaking webview consumers that switch on the code to
	// differentiate bad-input from generic errors.
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 0xFFFF) {
		throw new Error(`[bad_argument] appendPutValue: sheet must be an integer in [0, 65535], got ${sheet}`);
	}
	if (!Number.isInteger(row) || row < 0 || row > 0xFFFFFFFF) {
		throw new Error(`[bad_argument] appendPutValue: row must be an integer in [0, 4294967295], got ${row}`);
	}
	if (!Number.isInteger(col) || col < 0 || col > 0xFFFFFFFF) {
		throw new Error(`[bad_argument] appendPutValue: col must be an integer in [0, 4294967295], got ${col}`);
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`[bad_argument] appendPutValue: value must be a finite number, got ${value}`);
	}
	session.appendPutValue(sheet, row, col, value);
}

/**
 * **Phase 5.7 V3.6.0.6 D5 (2026-05-24)** -- typed wrapper for
 * `CollabSession.appendPutFormula` with JS-side validation.
 *
 * Mirrors {@link appendPutValueValidated}'s discipline (validate
 * sheet/row/col BEFORE the napi boundary so `parseQuantbookError(err)
 * .code` surfaces `bad_argument` consistently; ToUint32 coercion at
 * the FFI layer would silently wrap negative/non-integer values
 * otherwise).
 *
 * **No `text` validation here**: any string is a valid formula at
 * the wire level.  Engine-side evaluation surfaces parse errors via
 * `Workbook::formula_at` / `recompute_all` -- the IDE renders those
 * as `#NAME?` / `#REF!` / etc. in cell snapshots, NOT as
 * `[bad_argument]` throws on append.  This matches `appendPutValue`'s
 * "value-must-be-finite" pattern: the wire accepts any finite
 * number; the IDE pre-rejects only what the wire layer can't.
 *
 * @throws Error with `parseQuantbookError(err).code === 'bad_argument'`
 *         if sheet/row/col are out of range or non-integer.
 */
export function appendPutFormulaValidated(
	session: CollabSessionInstance,
	sheet: number,
	row: number,
	col: number,
	text: string,
): void {
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 0xFFFF) {
		throw new Error(`[bad_argument] appendPutFormula: sheet must be an integer in [0, 65535], got ${sheet}`);
	}
	if (!Number.isInteger(row) || row < 0 || row > 0xFFFFFFFF) {
		throw new Error(`[bad_argument] appendPutFormula: row must be an integer in [0, 4294967295], got ${row}`);
	}
	if (!Number.isInteger(col) || col < 0 || col > 0xFFFFFFFF) {
		throw new Error(`[bad_argument] appendPutFormula: col must be an integer in [0, 4294967295], got ${col}`);
	}
	if (typeof text !== 'string') {
		throw new Error(`[bad_argument] appendPutFormula: text must be a string, got ${typeof text}`);
	}
	session.appendPutFormula(sheet, row, col, text);
}

/**
 * Reconstruct a `CollabSession` from a previously-exported snapshot.
 *
 * @param peerId Non-zero u64-domain peer identifier for THIS session
 *               (need not match the snapshot's origin peer; CRDT will
 *               author new ops under this id).
 * @param bytes  Snapshot bytes from another session's `exportBytes()`.
 */
export function sessionFromSnapshot(peerId: bigint, bytes: Uint8Array): CollabSessionInstance {
	const engine = loadQuantbookEngine();
	return engine.CollabSession.fromSnapshot(peerId, bytes);
}

/**
 * **Phase 5.7 V3.4.0.4a (2026-05-23) -- typed wrapper for
 * `CollabSession.toQbook`.**
 *
 * Save the session to a `.qbook` directory at `path`.  Atomic two-file
 * write (workbook.toml + oplog.bin); readers cannot observe a partial
 * workbook.  Internally calls `rebuild_workbook` + `default_registry`
 * inside the engine layer (V3.4.0.4 plan note on the engine-side
 * Workbook materialization at save).
 *
 * Single-line indirection mirrors `sessionFromSnapshot` pattern for
 * API surface stability across future engine signature changes.
 */
export function exportToQbook(session: CollabSessionInstance, path: string): void {
	session.toQbook(path);
}

/**
 * **Phase 5.7 V3.4.0.4a (2026-05-23) -- typed wrapper for
 * `CollabSession.fromQbook`.**
 *
 * Load a session from a `.qbook` directory at `path`.  Caller MUST pass
 * `peerIdOverride` -- always a FRESH BigInt generated via
 * {@link generateUuidPeerId} per V3.4.0.4b D5 DEVIATION (the V3.4.0.1
 * lock originally specified persisted-per-workbook PeerId, but
 * implementation discovery surfaced an unsolvable two-windows-same-
 * workspace collision; resolution = fresh-UUID-per-session, NOT a stash).
 * V3.4.0.X LOW-1 closure (cross-lane Codex L1 + Opus M1 doc-accuracy:
 * pre-closure this docstring + the napi `fromQbook` docstring both
 * mentioned a "stored-previously" / per-workbook stash path that the
 * implementation intentionally rejected).
 */
export function sessionFromQbook(path: string, peerIdOverride: bigint): CollabSessionInstance {
	const engine = loadQuantbookEngine();
	return engine.CollabSession.fromQbook(path, peerIdOverride);
}

/**
 * **Phase 5.7 V3.4.0.4a (2026-05-23) -- typed wrapper for
 * `CollabSession.addSheet`.**
 *
 * Append an `Op::AddSheet` so subsequent `appendPutValue` ops can
 * replay successfully via `rebuild_workbook` (which `to_qbook` calls
 * internally).
 *
 * Sheet ids assigned in append order: first call -> sheet 0, second
 * -> 1, etc.  `chunkRows` is the per-sheet row partition size for
 * Workbook storage; 1000 is a sane default at V3.4 scale.
 */
export function addSheet(session: CollabSessionInstance, name: string, chunkRows = 1000): void {
	session.addSheet(name, chunkRows);
}

/**
 * **Phase 5.7 V3.5.0.3a (2026-05-24) -- typed wrapper for
 * `CollabSession.renameSheet`.**
 *
 * Append an `Op::RenameSheet` to the session.  See the engine napi
 * docstring (mirrored in {@link CollabSessionInstance.renameSheet}) for
 * the contract divergence vs `WorkbookRuntime::rename_sheet` (formula
 * text rewriting deferred to `repair_sheet_rename_chain` at next
 * rebuild_workbook).
 *
 * Single-line indirection mirrors `addSheet` / `workbookSnapshot` for
 * API surface stability.
 */
export function renameSheet(session: CollabSessionInstance, id: number, newName: string): void {
	session.renameSheet(id, newName);
}

/**
 * **Phase 5.7 V3.5.0.3b (2026-05-24) -- typed wrapper for
 * `CollabSession.deleteSheet`.**
 *
 * Append an `Op::RemoveSheet` to the session (tombstone the sheet at `id`).
 * See the engine napi docstring (mirrored in
 * {@link CollabSessionInstance.deleteSheet}) for the CRDT semantic
 * (tombstone preserves id slot; cell writes to tombstoned sheet
 * silently dropped; workbookSnapshot filters tombstones).
 *
 * Single-line indirection mirrors the addSheet / renameSheet /
 * workbookSnapshot pattern for API surface stability.
 */
export function deleteSheet(session: CollabSessionInstance, id: number): void {
	session.deleteSheet(id);
}

/**
 * **Phase 5.7 V3.6.0.10 D8 (2026-05-25) -- typed wrapper for
 * `CollabSession.restoreSheet`.**
 *
 * Un-tombstone a sheet previously tombstoned via `deleteSheet`.
 * Pre-tombstone cells reappear (V3.5.0.3b tombstone storage
 * preservation); cells silently-no-op'd while tombstoned do not.
 *
 * **Delta cache interaction**: next `workbookSnapshotDelta` call after
 * `restoreSheet` returns `fullRebuildRequired=true`; IDE should call
 * `workbookSnapshot()` to fetch the restored cells.
 *
 * Single-line indirection mirrors addSheet / renameSheet / deleteSheet /
 * workbookSnapshot for API surface stability.
 */
export function restoreSheet(session: CollabSessionInstance, id: number): void {
	session.restoreSheet(id);
}

/**
 * **Phase 5.7 V3.5.0.3c (2026-05-24) -- typed wrapper for
 * `CollabSession.moveSheet`.**
 *
 * Reorder sheet's display position via a display-order overlay (id
 * stays stable; underlying Sheet storage unchanged).  See engine napi
 * docstring (mirrored in {@link CollabSessionInstance.moveSheet}) for
 * the CRDT semantic (display overlay; out-of-range new_index clamps;
 * move-on-tombstoned-sheet silently applies).
 *
 * Single-line indirection mirrors addSheet / renameSheet / deleteSheet /
 * workbookSnapshot for API surface stability.
 */
export function moveSheet(session: CollabSessionInstance, id: number, newIndex: number): void {
	session.moveSheet(id, newIndex);
}

/**
 * **Phase 5.7 V3.5.0.2 (2026-05-24) -- typed wrapper for
 * `CollabSession.workbookSnapshot`.**
 *
 * Return the full workbook flattened to a {@link WorkbookSnapshotJson}
 * for IDE-side rendering.  Per-call cost is O(N) in op count
 * (rebuild_workbook materializes a fresh Workbook); IDE callers MUST
 * batch (do NOT call per-keystroke).  See {@link WorkbookSnapshotJson}
 * docstring for the shape contract + V3.5.0.5 forward-extend note.
 *
 * Single-line indirection mirrors `exportToQbook` / `sessionFromQbook`
 * pattern for API surface stability across future engine signature
 * changes.
 */
export function workbookSnapshot(session: CollabSessionInstance): WorkbookSnapshotJson {
	return session.workbookSnapshot();
}

/**
 * **Phase 5.7 V3.6.1 (2026-05-26) -- typed wrapper for
 * `CollabSession.workbookSnapshotDelta` (OPUS-PT-B10).**
 *
 * Incremental counterpart to {@link workbookSnapshot}.  Given the
 * `lastSeenVersion` token the caller captured from a prior reply's
 * `version` field (either a {@link WorkbookSnapshotJson.version} or a
 * previous {@link WorkbookSnapshotDeltaJson.version}), the engine
 * returns ONLY the cells / sheets / formats that changed since then --
 * 228x faster than a full snapshot at 100 new cells (V3.6.0.8.4 bench).
 *
 * **Two-call protocol** (see the napi docstring on
 * {@link CollabSessionInstance.workbookSnapshotDelta} for the full
 * contract): the FIRST acquisition for a session must come from
 * `workbookSnapshot()` (to seed the engine cache + capture a version);
 * subsequent acquisitions call this.  When the engine cannot produce a
 * delta it returns `fullRebuildRequired=true` (cache miss / staleness /
 * rename / malformed version) and the caller MUST re-fetch via
 * `workbookSnapshot()`.  `fullRebuildRequired` is an explicit, designed
 * protocol signal -- NOT an error to swallow.
 *
 * **`lastSeenVersion` MUST be a real captured `Buffer`** (never
 * `undefined`): the seed path uses `workbookSnapshot()` instead of
 * passing an empty/absent token here.  See
 * `CellGridPanel.acquireWorkbookSnapshot` for the orchestration.
 *
 * Single-line indirection mirrors `workbookSnapshot` for API surface
 * stability across future engine signature changes.
 */
export function workbookSnapshotDelta(
	session: CollabSessionInstance,
	lastSeenVersion: Buffer,
): WorkbookSnapshotDeltaJson {
	return session.workbookSnapshotDelta(lastSeenVersion);
}

/**
 * **Phase 5.7 V3.4.0.4b (2026-05-23) -- UUID-derived 64-bit PeerId.**
 *
 * Generates a fresh `bigint` PeerId for {@link createSession} or
 * {@link sessionFromQbook} (where the engine layer is peer-id-agnostic
 * + the caller is responsible for ensuring uniqueness).
 *
 * **Source**: `crypto.randomUUID()` (Node 14.17+; Electron/VS Code well
 * past that floor).  UUIDv4 has 122 bits of randomness across 16 bytes
 * with 6 deterministic bits (4 bits for version `0100` at hex-char
 * position 12 + 2 bits for variant `10` at hex-char position 16).
 * Truncating to the first 16 hex chars (the first 64 bits) keeps ~60
 * bits of entropy after extracting the version nibble at position 12
 * (which is ALWAYS the literal hex `4`).  Birthday-paradox collision
 * probability is therefore ~2^30 sessions before first collision --
 * still effectively zero for real workbook usage (a user spawning ~1
 * billion sessions in one workbook is not the threat model).  V3.4.0.X
 * LOW-2 closure (cross-lane Codex L2 + Opus M3 doc-accuracy: the
 * docstring previously claimed ~64 bits / ~2^32 collision).
 *
 * **Non-zero guarantee**: `PeerId(0)` is the engine's `LEGACY_PEER`
 * sentinel + would assert-fail `CollabSession::new`.  Under spec-
 * compliant UUIDv4, the first 16 hex chars CANNOT be all-zero (the
 * version nibble at position 12 is the literal `4`, not `0`), so the
 * all-zero outcome is IMPOSSIBLE.  The retry loop + 8-attempt cap is
 * defense against a NON-SPEC `crypto.randomUUID` (entropy broken /
 * unexpected impl); per CLAUDE.md No-Fallbacks, 8 consecutive non-spec
 * UUIDs surface loudly via thrown error.
 *
 * **D5 deviation (V3.4.0.4b plan note)**: V3.4.0.1 D5 originally
 * specified UUID-derived PeerId PERSISTED per workbook (via envelope
 * v3 OR per-machine config file).  Implementation discovery: persisted
 * PeerId per workbook has unsolvable problems -- two windows of the
 * SAME vscode workspace opening the SAME workbook would both read the
 * same persisted PeerId + collide.  Fresh-UUID-per-session is
 * CRDT-correct (each session is a distinct Loro peer; future ops get
 * unique attribution) + closes R-V3.3-5 cross-restart PID collision
 * fully.  Trade-off: loses "this peer is User A across sessions"
 * attribution.  V3.4.1+ may add per-workbook stash IF a user-facing
 * feature (e.g., "show my contributions") surfaces; for V3.4.0.4b
 * scope it's deferred.
 */
export function generateUuidPeerId(): bigint {
	// Loop on the (astronomically rare) all-zero result.
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const uuid = crypto.randomUUID();
		// UUID format: 8-4-4-4-12 hex digits with dashes.  Strip
		// dashes; take first 16 hex chars (= 64 bits).
		const hex16 = uuid.replace(/-/g, '').slice(0, 16);
		const value = BigInt('0x' + hex16);
		if (value !== 0n) {
			return value;
		}
	}
	// 8 consecutive all-zero UUIDs is so improbable (~2^-512) that
	// reaching here means the crypto.randomUUID source is broken;
	// surface loudly per No-Fallbacks.
	throw new Error('[bad_argument] generateUuidPeerId: 8 consecutive zero-truncated UUIDs from crypto.randomUUID -- entropy source broken');
}

/**
 * Return the engine binding crate's version string. For diagnostics
 * + the V2 version-mismatch error path.
 */
export function quantbookEngineVersion(): string {
	return loadQuantbookEngine().version();
}

/**
 * **Phase 5.7 V3.2.a (2026-05-22) -- typed wrapper for
 * `CollabSession.exportSnapshot`.**
 *
 * Parses the engine's JSON return value into the
 * {@link QuantbookCellSnapshot} shape. Validates the
 * `snapshot_format_version` field; throws a `bad_argument`-coded
 * error if the engine emits a future format the IDE binding
 * doesn't recognize (binding-drift signal).
 *
 * @param session A live {@link CollabSessionInstance}.
 * @param sheet   u16 sheet ID (0-based). The engine validates the
 *                range; an out-of-range value throws.
 * @returns the decoded snapshot.
 * @throws Error if the engine throws (passed through unchanged so
 *               `parseQuantbookError` can route on `code`) OR if
 *               the snapshot's `snapshot_format_version` is not 1.
 */
export function exportCellSnapshot(
	session: CollabSessionInstance,
	sheet: number,
): QuantbookCellSnapshot {
	const raw = session.exportSnapshot(sheet);
	const parsed = JSON.parse(raw) as { snapshot_format_version?: number };
	if (parsed.snapshot_format_version !== 1) {
		throw new Error(
			`[bad_argument] exportCellSnapshot: unrecognized snapshot_format_version ` +
			`${parsed.snapshot_format_version} (IDE binding supports v1 only). ` +
			`Engine + IDE binding may be out of sync -- rebuild the engine cdylib ` +
			`and the IDE extension together.`,
		);
	}
	return parsed as QuantbookCellSnapshot;
}

/**
 * **Phase 5.7 V3.3.0.2 (2026-05-22) -- typed wrapper for
 * `CollabSession.listSheets`.**
 *
 * Enumerates distinct u16 sheets present in the local op log.  The
 * underlying napi method returns `Vec<u16>` which surfaces as a
 * `number[]` in JS; this wrapper exists as a single-line indirection
 * so callers can hold a stable IDE-side API surface even if the
 * engine method's signature changes (e.g., V3.4+ adds an optional
 * filter param, or migrates to an incremental-cache-backed read).
 *
 * V3.3.0 design decision D3 (LOCKED): u16-only return.  V3.4+ will
 * add a separate `listSheetsMetadata(): SheetMetadata[]` accessor
 * once the engine ships a `SheetMetadata` Op variant.
 *
 * Returned array is **sorted ascending** by the engine + does not
 * mutate across calls within the same op-log generation; callers can
 * rely on stable iteration order.
 *
 * @param session A live {@link CollabSessionInstance}.
 * @returns sorted ascending list of sheet IDs (0-based); empty array
 *          if no `PutValue` ops have been appended yet.
 * @throws Error with `parseQuantbookError(err).code === 'bad_argument'`
 *         if the engine's op log iterator emits a decode error.
 */
export function listSheets(session: CollabSessionInstance): number[] {
	return session.listSheets();
}

/**
 * **Phase 5.7 V3.4.0.3 (2026-05-23) -- typed wrapper for
 * `CollabSession.undo`.**
 *
 * Returns `true` if the Loro UndoManager stack item was consumed
 * (inverse op appended to the visible log) and `false` if the stack
 * was empty (Cmd-Z no-op).  LOCAL-ONLY: remote ops merged via
 * `mergeBytes` / `pollRemote` are NOT affected.
 *
 * Single-line indirection mirrors the {@link listSheets} pattern so
 * callers hold a stable IDE-side API surface across future engine
 * signature changes (e.g., V3.4.1+ may add an optional group-id
 * parameter for multi-cell undo groups).
 *
 * @param session A live {@link CollabSessionInstance}.
 * @returns `true` on consumed undo; `false` on empty stack.
 * @throws Error with `parseQuantbookError(err).code` per the engine's
 *         CollabSessionError kind (e.g., `transport_closed` during
 *         auto-flush after a consumed undo).
 */
export function undo(session: CollabSessionInstance): boolean {
	return session.undo();
}

/**
 * **Phase 5.7 V3.4.0.3 (2026-05-23) -- typed wrapper for
 * `CollabSession.redo`.**
 *
 * Mirrors {@link undo} for the redo direction.
 */
export function redo(session: CollabSessionInstance): boolean {
	return session.redo();
}

// ============================================================================
// Phase 5.7 V3.4.0.5 (2026-05-23) -- presence typed wrappers (engine napi only)
// ============================================================================

/**
 * **Phase 5.7 V3.4.0.5 (2026-05-23) -- typed wrapper for
 * `CollabSession.updatePresence`.**
 *
 * Writes this session's own presence state into the shared LoroMap.
 * Subsequent calls overwrite per-peer (LWW).  Auto-flush per
 * `setAutoFlushPolicy` if a transport is attached.
 */
export function updatePresence(session: CollabSessionInstance, state: PresenceStateJson): void {
	session.updatePresence(state);
}

/**
 * **Phase 5.7 V3.4.0.5 (2026-05-23) -- typed wrapper for
 * `CollabSession.peerPresence`.**
 *
 * Returns the peer's most recent presence state, or `null` if the
 * peer has never updated (or was removed via {@link clearPresence}
 * / {@link sweepPresence}).
 */
export function peerPresence(session: CollabSessionInstance, peer: bigint): PresenceStateJson | null {
	return session.peerPresence(peer);
}

/**
 * **Phase 5.7 V3.4.0.5 (2026-05-23) -- typed wrapper for
 * `CollabSession.clearPresence`.**
 *
 * Removes THIS session's own presence entry.  Other peers'
 * `peerPresence(selfId)` returns `null` after.
 */
export function clearPresence(session: CollabSessionInstance): void {
	session.clearPresence();
}

/**
 * **Phase 5.7 V3.4.0.5 (2026-05-23) -- typed wrapper for
 * `CollabSession.sweepPresence`.**
 *
 * Removes ALL presence entries.  Returns the count of peers removed.
 * Use after {@link sessionFromSnapshot} for "rejoin with clean
 * presence" (presence persists in the LoroDoc snapshot per V1
 * limitation).
 */
export function sweepPresence(session: CollabSessionInstance): number {
	return session.sweepPresence();
}

/**
 * **Phase 5.7 V3.4.0.5 (2026-05-23) -- typed wrapper for
 * `CollabSession.peersWithPresence`.**
 *
 * Returns the peer-id list (Loro iteration order; NOT sorted).
 * Callers needing determinism should sort the returned array (BigInt
 * comparison: `(a, b) => a < b ? -1 : a > b ? 1 : 0`).
 *
 * Use as the enumeration primitive: first call this, then call
 * {@link peerPresence} per returned id.
 */
export function peersWithPresence(session: CollabSessionInstance): bigint[] {
	return session.peersWithPresence();
}

// ============================================================================
// Phase 5.7 V3.4.0.5b (2026-05-23) -- IDE cell-grid presence-snapshot helper
// ============================================================================

/**
 * One peer's entry in the panel-render presence snapshot.  Carries the
 * peer-id as a STRING (16-hex per engine `presence::peer_key` convention)
 * because:
 *  - The snapshot is JSON-serialized into the HTML data block; BigInt is
 *    not JSON-native (would need `BigInt.toString()` anyway).
 *  - DOM attribute values must be strings; this matches the
 *    `data-peer-${peerId}` attribute encoding the webview script sets.
 *  - 16-hex is the same encoding the engine uses internally in the
 *    "presence" LoroMap key namespace, so cross-peer references stay
 *    bit-identical.
 */
export interface PresenceSnapshotPeer {
	peerId: string;
	sheet: number;
	row: number;
	col: number;
	selectionEndRow: number;
	selectionEndCol: number;
	typing: boolean;
}

/**
 * Panel-render presence snapshot embedded by V3.4.0.5b in the
 * `cell-grid-presence` data block.  `selfPeerId` is the panel's own
 * session peer id (also 16-hex string); the webview script EXCLUDES
 * self from decoration (the cursor IS the cell edit input, no extra
 * border needed).
 */
export interface PresencePanelSnapshot {
	selfPeerId: string;
	peers: PresenceSnapshotPeer[];
}

/**
 * **Phase 5.7 V3.4.0.5b (2026-05-23) -- build the IDE presence
 * snapshot for the cell-grid data block.**
 *
 * Enumerates peers via {@link peersWithPresence}, fetches each peer's
 * state via {@link peerPresence}, builds the JSON-ready
 * {@link PresencePanelSnapshot}.  Filters:
 *
 *  - **Skip self**: self-peer's own cursor doesn't need decoration; the
 *    cell input IS the cursor.  Removing self also avoids the cell
 *    flashing during active edit (V3.4.0.1 D4 race-guard category).
 *  - **Skip None / null**: peers in `peersWithPresence` but whose
 *    `peerPresence` returns null (race window: peer cleared between the
 *    enumeration and the per-peer fetch) are silently dropped.
 *  - **Sheet filter**: peers whose `sheet` differs from `panelSheet`
 *    are still included (a future multi-sheet UI may want to surface
 *    "this peer is on sheet 3 cell A1"); decoration filtering happens
 *    webview-side per V3.4.0.5b D2-panel-per-sheet decision.  Today's
 *    webview script ignores peers on other sheets.
 *
 * O(peers-with-presence) per render.  At V3.4 scale (small-team collab,
 * single-digit-to-low-double-digit peers), this is sub-millisecond.
 */
export function buildPresenceSnapshotJson(
	session: CollabSessionInstance,
	_panelSheet: number,
): PresencePanelSnapshot {
	const selfPeerId = formatPeerIdHex(session.peerId());
	const peers: PresenceSnapshotPeer[] = [];
	const allPeers = peersWithPresence(session);
	for (const peerBig of allPeers) {
		const peerHex = formatPeerIdHex(peerBig);
		if (peerHex === selfPeerId) {
			continue; // skip self
		}
		const state = peerPresence(session, peerBig);
		if (state === null) {
			continue; // race window: enumerated but cleared between calls
		}
		peers.push({
			peerId: peerHex,
			sheet: state.sheet,
			row: state.row,
			col: state.col,
			selectionEndRow: state.selectionEndRow,
			selectionEndCol: state.selectionEndCol,
			typing: state.typing,
		});
	}
	return { selfPeerId, peers };
}

/**
 * **Phase 5.7 V3.4.0.5b helper** -- format a BigInt peer-id as 16-hex
 * lowercase (matches engine `presence::peer_key` convention).  Used to
 * build the `data-peer-${peerId}` attribute encoding on `<td>` cells
 * + the `selfPeerId` field of {@link PresencePanelSnapshot}.
 */
function formatPeerIdHex(peer: bigint): string {
	// BigInt.toString(16) drops leading zeros; pad to 16 hex chars.
	return peer.toString(16).padStart(16, '0');
}

// =====================================================================
// Phase 5.7 V2.1 (2026-05-22) -- Transport binding wrappers
// =====================================================================

/**
 * Construct a fresh `LoopbackPair` and immediately take both ends.
 * Returns the two Transport instances ready to attach to a session
 * each.
 *
 * Combines `new LoopbackPair()` + `takeA()` + `takeB()` into a single
 * call because the typical use case wants both ends. For cases where
 * one end is created independently (e.g., delayed peer connection),
 * use `createLoopbackPair()` instead and call `takeA` / `takeB`
 * separately.
 *
 * @returns `[transportA, transportB]` where bytes sent on A arrive
 *           at B's `pollRemote` and vice versa.
 *
 * @example
 * ```ts
 * const [tA, tB] = loopbackTransportPair();
 * sessionA.attachTransport(tA);
 * sessionB.attachTransport(tB);
 * // mutate sessionA, flushToTransport, pollRemote on sessionB
 * ```
 */
export function loopbackTransportPair(): [TransportInstance, TransportInstance] {
	const engine = loadQuantbookEngine();
	const pair = new engine.LoopbackPair();
	return [pair.takeA(), pair.takeB()];
}

/**
 * Construct an empty `LoopbackPair` without taking either end. Use
 * when the two takes need to happen at different times.
 */
export function createLoopbackPair(): LoopbackPairInstance {
	const engine = loadQuantbookEngine();
	return new engine.LoopbackPair();
}

// =====================================================================
// Phase 5.7 V2.2 (2026-05-22) -- AutoFlushPolicy helpers
// =====================================================================

/**
 * Type guard for the camelCase string union `AutoFlushPolicy`. Returns
 * `true` for `'disabled'` or `'onAppend'`. Note: the engine's
 * `setAutoFlushPolicy` also accepts variant aliases (`'Disabled'`,
 * `'OnAppend'`, `'on-append'`) -- this guard is the STRICT camelCase
 * check for IDE-side validation; the engine is the loose parser.
 */
export function isAutoFlushPolicy(value: unknown): value is AutoFlushPolicy {
	return value === 'disabled' || value === 'onAppend';
}

// =====================================================================
// Phase 5.7 V2.7 (2026-05-22) -- structured error-code discrimination
// =====================================================================

/**
 * Compile-time-enforced map of every `QuantbookErrorCode` the engine
 * binding emits (the union minus the `'unknown'` parser fallback).
 *
 * **V2.9 hardening (Opus-B Lane C MEDIUM-3 closure, 2026-05-22)**:
 * pre-V2.9 the `KNOWN_QUANTBOOK_ERROR_CODES` Set below was a manually-
 * maintained string list. Adding a new code to {@link QuantbookErrorCode}
 * without also adding it to the Set silently bucketed engine emissions
 * of the new code under `'unknown'` in {@link parseQuantbookError} --
 * defeating the V2.7 structured-discrimination contract for that code
 * until the IDE binding was patched. The Lane C megaudit flagged this
 * as required-pre-V3 because V3 will add more kinds (presence, undo
 * groups, FormatId binding) and the drift surface widens.
 *
 * The `Record<Exclude<QuantbookErrorCode, 'unknown'>, true>` shape
 * below enforces the invariant at TypeScript compile time:
 * - adding a code to {@link QuantbookErrorCode} without adding a key
 *   here fails compile with "Property 'new_code' is missing in type ...";
 * - adding a key here that isn't in {@link QuantbookErrorCode} fails
 *   compile with "Object literal may only specify known properties".
 *
 * `'unknown'` is INTENTIONALLY excluded via the `Exclude<>` -- it is
 * the parser's fallback sentinel, NOT a code the engine ever emits.
 * If a future engine variant accidentally returned `"unknown"` as its
 * kind, treating `"[unknown] foo"` as a recognized prefix would strip
 * it (turning `message` into `"foo"`) while a less misleading
 * `"[future_kind] foo"` would preserve `message` intact. Excluding
 * `'unknown'` from this record keeps `parseQuantbookError`'s fallback
 * behavior symmetric across both cases (V2.7 Opus MEDIUM-1 invariant).
 */
const KNOWN_QUANTBOOK_ERROR_CODE_RECORD: Record<Exclude<QuantbookErrorCode, 'unknown'>, true> = {
	transport_io: true,
	transport_closed: true,
	websocket_invalid_url: true,
	websocket_connect_failed: true,
	websocket_handshake_failed: true,
	websocket_runtime_error: true,
	session_oplog: true,
	session_presence: true,
	session_undo: true,
	session_replay: true,
	bad_argument: true,
	// V3.4.0.4a persistence codes (matching `persistence_error_to_napi`
	// in `crates/ql-bindings-node/src/lib.rs`).
	qbook_error: true,
	qbook_unsupported_version: true,
	qbook_truncated_header: true,
	qbook_unknown: true,
};

/**
 * Runtime view of {@link KNOWN_QUANTBOOK_ERROR_CODE_RECORD}, derived
 * via `Object.keys`. Used by {@link parseQuantbookError} to validate
 * bracket-prefix codes. The Set is structurally guaranteed to match
 * the record's keys -- no manual sync required.
 */
const KNOWN_QUANTBOOK_ERROR_CODES: ReadonlySet<QuantbookErrorCode> = new Set(
	Object.keys(KNOWN_QUANTBOOK_ERROR_CODE_RECORD) as Array<Exclude<QuantbookErrorCode, 'unknown'>>,
);

/**
 * Bracket-prefix regex: `[<code>] <message>` where `<code>` starts
 * with a lowercase letter and is composed of lowercase alphabetics,
 * digits, and underscores. Matches the napi binding's
 * `[{kind}] {Display}` convention from
 * `crates/ql-bindings-node/src/lib.rs::{collab_session,transport,websocket}_error_to_napi`.
 *
 * **V2.7 audit closure (Opus LOW-1, 2026-05-22)**: extended
 * character class to `[a-z0-9_]*` (was `[a-z_]*`) for future-proofing.
 * Today's kinds use only letters + underscores, but a future variant
 * like `transport_io_v2` would have parsed already (alpha + _); the
 * extension future-proofs digit-bearing variants like `http2_failed`.
 */
const QUANTBOOK_ERROR_PREFIX_RE = /^\[([a-z][a-z0-9_]*)\]\s*(.*)$/s;

/**
 * Maximum depth for walking `Error.cause` chains in
 * {@link parseQuantbookError}. Defends against pathological
 * self-referencing caches or accidental cycles while still allowing
 * realistic napi wrapper chains (typically 1-3 levels).
 */
const QUANTBOOK_ERROR_CAUSE_MAX_DEPTH = 8;

/**
 * Extract the structured code + message from a caught error.
 *
 * **Usage**:
 * ```ts
 * try {
 *   session.flushPendingToTransport();
 * } catch (err) {
 *   const info = parseQuantbookError(err);
 *   if (info.code === 'transport_closed') {
 *     // reconnect logic
 *   }
 * }
 * ```
 *
 * **Cause-chain walking (V2.8 megaudit closure -- Opus-B Lane C
 * MEDIUM-4, 2026-05-22)**: when no `[<code>]` prefix is found on
 * the top-level `Error.message`, this function walks the
 * `Error.cause` chain (max depth {@link QUANTBOOK_ERROR_CAUSE_MAX_DEPTH},
 * self-cycle guard) looking for a bracket-prefixed engine error.
 * Required because napi `spawn_blocking` task-panic paths wrap the
 * engine's structured error in a generic Node `Error` whose
 * `.message` has no bracket -- without the cause walk these were
 * silently bucketed under `'unknown'`, defeating the V2.7 closure.
 * The returned `code` reflects the deepest matched engine prefix;
 * `cause` always points at the original top-level throwable so
 * callers can still log the full wrapper context.
 *
 * **Returns**: a `QuantbookErrorInfo` with `code = 'unknown'` if:
 * - the value is not an `Error` instance (e.g., a `throw 'string'`
 *   from non-engine code; **the structured discriminant is lost**
 *   in this case -- callers handling external code paths should
 *   wrap their throws in an `Error` to preserve the discriminant),
 * - no `Error` in the cause chain has a `[<code>] ` prefix, OR
 * - a prefix is found but its code is not a recognized
 *   `QuantbookErrorCode` (which means the IDE binding is older than
 *   the engine; a build refresh is in order).
 *
 * For the unrecognized-prefix case (binding drift), the `message`
 * field preserves the FULL original top-level `Error.message`
 * including the bracket prefix, so callers can log it for diagnosis.
 *
 * Closes V2.1 Opus MEDIUM-3 carryforward (lossy Display projection,
 * carried as V2.2 Opus MEDIUM-4 and re-flagged in V2.3), V2.7 Opus
 * LOW-4 (non-Error throwable JSDoc clarity), and V2.8 Opus-B Lane C
 * MEDIUM-4 (Error.cause chain walking for napi wrapper paths).
 */
export function parseQuantbookError(err: unknown): QuantbookErrorInfo {
	if (!(err instanceof Error)) {
		return {
			code: 'unknown',
			message: typeof err === 'string' ? err : String(err),
			cause: err,
		};
	}
	// Walk Error.cause looking for the first bracket-prefixed engine
	// error message. Self-cycle guard via Set of visited Errors.
	const visited = new Set<Error>();
	let current: unknown = err;
	let depth = 0;
	while (current instanceof Error && depth < QUANTBOOK_ERROR_CAUSE_MAX_DEPTH) {
		if (visited.has(current)) {
			break;
		}
		visited.add(current);
		const match = QUANTBOOK_ERROR_PREFIX_RE.exec(current.message);
		if (match) {
			const rawCode = match[1];
			const rest = match[2];
			if (KNOWN_QUANTBOOK_ERROR_CODES.has(rawCode as QuantbookErrorCode)) {
				return { code: rawCode as QuantbookErrorCode, message: rest, cause: err };
			}
			// Unknown code prefix: preserve the original top-level
			// message (so the user sees the literal prefix) and
			// signal 'unknown'. Caller can escalate this as a
			// binding-drift signal.
			return { code: 'unknown', message: err.message, cause: err };
		}
		current = (current as { cause?: unknown }).cause;
		depth += 1;
	}
	// No bracket prefix anywhere in the chain → genuinely unknown.
	return { code: 'unknown', message: err.message, cause: err };
}

/**
 * Set including the `'unknown'` fallback sentinel; used by the
 * `isQuantbookErrorCode` type guard. Distinct from
 * `KNOWN_QUANTBOOK_ERROR_CODES` (parser-only, no `'unknown'`)
 * per the V2.7 audit closure (Opus MEDIUM-1): the parser must
 * NOT treat literal `[unknown]` prefixes as recognized codes,
 * but the type guard SHOULD accept `'unknown'` because the parser
 * returns it on fallback.
 */
const ALL_QUANTBOOK_ERROR_CODES: ReadonlySet<QuantbookErrorCode> = new Set<QuantbookErrorCode>([
	...KNOWN_QUANTBOOK_ERROR_CODES,
	'unknown',
]);

/**
 * Type guard for `QuantbookErrorCode`. Mirrors `isAutoFlushPolicy`'s
 * defensive shape -- use when reading codes from external config or
 * persisted error logs.
 *
 * Accepts ALL `QuantbookErrorCode` values including `'unknown'`
 * (the parser fallback). See `ALL_QUANTBOOK_ERROR_CODES` vs
 * `KNOWN_QUANTBOOK_ERROR_CODES` for the role split.
 */
export function isQuantbookErrorCode(value: unknown): value is QuantbookErrorCode {
	return typeof value === 'string' && ALL_QUANTBOOK_ERROR_CODES.has(value as QuantbookErrorCode);
}
