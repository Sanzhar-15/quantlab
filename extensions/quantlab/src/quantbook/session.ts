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
import type { CollabSessionInstance } from './types';

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
