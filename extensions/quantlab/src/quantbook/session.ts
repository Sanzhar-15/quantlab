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
	if (!Number.isInteger(sheet) || sheet < 0 || sheet > 0xFFFF) {
		throw new Error(`appendPutValue: sheet must be an integer in [0, 65535], got ${sheet}`);
	}
	if (!Number.isInteger(row) || row < 0 || row > 0xFFFFFFFF) {
		throw new Error(`appendPutValue: row must be an integer in [0, 4294967295], got ${row}`);
	}
	if (!Number.isInteger(col) || col < 0 || col > 0xFFFFFFFF) {
		throw new Error(`appendPutValue: col must be an integer in [0, 4294967295], got ${col}`);
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`appendPutValue: value must be a finite number, got ${value}`);
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
 * Set of `QuantbookErrorCode` values **emitted by the engine binding**.
 *
 * **V2.7 audit closure (Opus MEDIUM-1, 2026-05-22)**: `'unknown'` is
 * INTENTIONALLY OMITTED from this set. It is the parser's fallback
 * sentinel, NOT a code the engine ever emits. If a future engine
 * variant accidentally returned `"unknown"` as its kind, treating
 * the resulting `"[unknown] foo"` prefix as a recognized code would
 * strip the prefix (turning `message` into `"foo"`) while a less
 * misleading `"[future_kind] foo"` would preserve `message` intact.
 * Removing `'unknown'` from the set keeps `parseQuantbookError`'s
 * fallback behavior symmetric across both cases.
 *
 * **Codex M3 closure note**: keeping this set in sync with the
 * union type {@link QuantbookErrorCode} (minus `'unknown'`) is a
 * manual discipline. V2 backlog: codegen this set from the union
 * (or use a const enum) to eliminate the drift hazard.
 */
const KNOWN_QUANTBOOK_ERROR_CODES: ReadonlySet<QuantbookErrorCode> = new Set<QuantbookErrorCode>([
	'transport_io',
	'transport_closed',
	'websocket_invalid_url',
	'websocket_connect_failed',
	'websocket_handshake_failed',
	'websocket_runtime_error',
	'session_oplog',
	'session_presence',
	'session_undo',
	'session_replay',
	'bad_argument',
	// 'unknown' is the parser fallback sentinel; NOT in the set per
	// Opus V2.7 MEDIUM-1. If the engine ever returns a literal
	// `"unknown"` kind, the bracket prefix is preserved in `message`
	// alongside `code='unknown'`, signaling binding drift.
]);

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
