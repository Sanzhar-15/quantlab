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
 * Set of `QuantbookErrorCode` values, used by the `parseQuantbookError`
 * runtime validator to reject unknown codes (which would otherwise
 * mask an engine-binding drift).
 *
 * **Codex M3 closure note**: keeping this set in sync with the
 * union type {@link QuantbookErrorCode} is a manual discipline.
 * V2 backlog: codegen this set from the union (or use a const enum)
 * to eliminate the drift hazard.
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
	'unknown',
]);

/**
 * Bracket-prefix regex: `[<code>] <message>` where `<code>` is
 * snake_case alphabetics + underscores. Matches the napi binding's
 * `[{kind}] {Display}` convention from
 * `crates/ql-bindings-node/src/lib.rs::{collab_session,transport,websocket}_error_to_napi`.
 */
const QUANTBOOK_ERROR_PREFIX_RE = /^\[([a-z][a-z_]*)\]\s*(.*)$/s;

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
 * **Returns**: a `QuantbookErrorInfo` with `code = 'unknown'` if:
 * - the value is not an `Error` instance,
 * - the `Error.message` has no `[<code>] ` prefix, OR
 * - the prefix code is not a recognized `QuantbookErrorCode` (which
 *   means the IDE binding is older than the engine; a build refresh
 *   is in order).
 *
 * Closes V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards.
 */
export function parseQuantbookError(err: unknown): QuantbookErrorInfo {
	if (!(err instanceof Error)) {
		return {
			code: 'unknown',
			message: typeof err === 'string' ? err : String(err),
			cause: err,
		};
	}
	const match = QUANTBOOK_ERROR_PREFIX_RE.exec(err.message);
	if (!match) {
		return { code: 'unknown', message: err.message, cause: err };
	}
	const rawCode = match[1];
	const rest = match[2];
	if (KNOWN_QUANTBOOK_ERROR_CODES.has(rawCode as QuantbookErrorCode)) {
		return { code: rawCode as QuantbookErrorCode, message: rest, cause: err };
	}
	// Unknown code: preserve the full original message (so the
	// user can see the actual prefix) and return 'unknown'.
	// Caller can then escalate this as a binding-drift signal.
	return { code: 'unknown', message: err.message, cause: err };
}

/**
 * Type guard for `QuantbookErrorCode`. Mirrors `isAutoFlushPolicy`'s
 * defensive shape -- use when reading codes from external config or
 * persisted error logs.
 */
export function isQuantbookErrorCode(value: unknown): value is QuantbookErrorCode {
	return typeof value === 'string' && KNOWN_QUANTBOOK_ERROR_CODES.has(value as QuantbookErrorCode);
}
