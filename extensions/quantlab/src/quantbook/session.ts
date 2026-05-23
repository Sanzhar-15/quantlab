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
	QuantbookCellSnapshot,
	QuantbookErrorCode,
	QuantbookErrorInfo,
	TransportInstance,
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
