/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Apache Arrow IPC -> ColumnData extractor.
 *
 * The query daemon emits aggregated results in two encodings (per
 * python/qviz/ipc.py):
 *
 *   - JSON  (encoding == 'json', payload <= 256 KB): a list of row objects
 *   - Arrow IPC (encoding == 'arrow', binary payload):  Apache Arrow stream
 *
 * `extract.ts` handles the JSON path. This module handles the Arrow path,
 * closing audit finding #1 (the "binary extractor missing" gap that
 * blocked Phase 5).
 *
 * Time-axis correctness: apache-arrow JS already converts Timestamp.get(i)
 * to milliseconds-since-epoch for every TimeUnit (see
 * node_modules/apache-arrow/visitor/get.js -- ns/us/ms/s all surface as
 * a ms-domain Number). We do NOT re-convert by unit; that would be a 10^N
 * scale error.
 *
 * Null preservation: numeric/temporal columns return (number | null)[]
 * with explicit nulls (cheaper for renderers than NaN sentinels). String
 * columns coerce nulls to '' to match the JSON-rows extractor's contract.
 *
 * Performance: for dense numeric columns (nullCount == 0) we take the
 * typed-array fast path; for nullable columns we iterate via vector.get(i).
 *
 * Type coverage (audit-fix slate AF14-AF19):
 *   - Float / Int (signed & unsigned, 8-64 bit) -> numeric
 *   - Bool                                      -> 0/1 numeric
 *   - Timestamp[s|ms|us|ns]                     -> ms
 *   - Date32 / Date64                           -> ms
 *   - Utf8 / LargeUtf8                          -> string
 *   - Dictionary<value_type>                    -> dispatched recursively
 *                                                  on the dictionary's
 *                                                  value type
 *
 * Explicitly rejected (loud error, not silent fallback):
 *   - Decimal                                   -> requires scale handling
 *                                                  not yet implemented
 *   - Binary / FixedSizeBinary / LargeBinary    -> opaque bytes, no
 *                                                  meaningful render
 *   - List / FixedSizeList / LargeList          -> nested data
 *   - Struct / Map / Union                      -> nested data
 *   - Time                                      -> time-of-day, not
 *                                                  ms-since-epoch (would
 *                                                  silently look like ms)
 *   - Duration / Interval                       -> deltas, not absolute
 *
 * Adding support for any of the rejected types is a deliberate choice
 * and goes here, not in a default branch.
 */

import {
	type DataType, type Table, type Vector,
	Type, tableFromIPC,
} from 'apache-arrow';
import type { ColumnData } from './types';

export class ExtractArrowError extends Error {
	constructor(message: string) { super(message); this.name = 'ExtractArrowError'; }
}

/**
 * Extract every column from an Arrow IPC stream/file payload into a ColumnData.
 *
 * Accepts both Uint8Array and ArrayBuffer; both shapes show up in our wire
 * path (Uint8Array from Node Buffer slices, ArrayBuffer from fetch in webview).
 *
 * Throws ExtractArrowError on:
 *   - malformed Arrow IPC bytes
 *   - non-empty input that yields zero schema fields (apache-arrow's lenient
 *     parser otherwise silently swallows truncated input)
 *   - unsupported Arrow types (see module docstring)
 *   - Int64 values exceeding Number.MAX_SAFE_INTEGER (silent precision loss)
 */
export function extractColumnsFromArrowIpc(
	buffer: Uint8Array | ArrayBuffer
): ColumnData {
	const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
	let table: Table;
	try {
		table = tableFromIPC(bytes);
	} catch (e) {
		throw new ExtractArrowError(
			`failed to parse Arrow IPC: ${(e as Error).message ?? String(e)}`
		);
	}

	// apache-arrow's parser is lenient: it accepts truncated/garbage bytes
	// and returns an empty Table with no schema rather than throwing. For a
	// non-empty input that yields no fields, this is almost certainly
	// malformed data we'd otherwise silently swallow. Reject loudly.
	//
	// A LEGITIMATE empty Arrow stream (a zero-row result with a known
	// schema) still has fields.length > 0 -- the schema metadata is part
	// of the stream prefix even when no record batches follow. So the
	// rejection here only fires on actually-malformed bytes.
	if (bytes.byteLength > 0 && table.schema.fields.length === 0) {
		throw new ExtractArrowError(
			`Arrow IPC yielded an empty schema for ${bytes.byteLength} input bytes -- ` +
			'likely malformed payload'
		);
	}

	const out: Record<string, ArrayLike<number | null> | ArrayLike<string>> = {};
	for (const field of table.schema.fields) {
		const name = field.name;
		const vec = table.getChild(name);
		if (vec === null || vec === undefined) {
			throw new ExtractArrowError(`column '${name}' not found in Arrow table`);
		}
		out[name] = extractVector(name, field.type, vec);
	}
	return out as ColumnData;
}

/** Phase 6 audit M-34 (2026-05-11): inspector-safe variant that catches
 *  per-column extraction errors and renders the column as stringified
 *  values instead of failing the entire table. The chart-render path
 *  still uses the strict `extractColumnsFromArrowIpc` because mis-typed
 *  encodings should fail loudly; the inspector is a free-form viewer
 *  that should never refuse to display a row because one auxiliary
 *  column has an unsupported dtype. */
export function extractColumnsFromArrowIpcSafe(
	buffer: Uint8Array | ArrayBuffer,
): ColumnData {
	const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
	let table: Table;
	try {
		table = tableFromIPC(bytes);
	} catch (e) {
		throw new ExtractArrowError(
			`failed to parse Arrow IPC: ${(e as Error).message ?? String(e)}`,
		);
	}
	if (bytes.byteLength > 0 && table.schema.fields.length === 0) {
		throw new ExtractArrowError(
			`Arrow IPC yielded an empty schema for ${bytes.byteLength} input bytes -- `
			+ 'likely malformed payload',
		);
	}
	const out: Record<string, ArrayLike<number | null> | ArrayLike<string>> = {};
	for (const field of table.schema.fields) {
		const name = field.name;
		const vec = table.getChild(name);
		if (vec === null || vec === undefined) {
			// Skip rather than throw — the inspector keeps rendering other
			// columns. The skipped column won't appear in the output map.
			continue;
		}
		try {
			out[name] = extractVector(name, field.type, vec);
		} catch (e) {
			// Audit M-34: fall back to per-row vec.get(i) + String() so
			// the user sees SOMETHING in the cell. Loses precision /
			// type information but preserves table readability.
			const stringified = new Array<string>(vec.length);
			for (let i = 0; i < vec.length; i++) {
				let v: unknown;
				try { v = vec.get(i); } catch { v = `<unreadable: ${(e as Error).message}>`; }
				stringified[i] = v === null || v === undefined ? '' : String(v);
			}
			out[name] = stringified;
		}
	}
	return out as ColumnData;
}

/**
 * Lower-level entry: extract a single named column from an already-parsed
 * Arrow Table. Useful when the caller already has a Table reference (e.g.
 * the query client may decode once and dispatch).
 */
export function extractColumnFromArrowTable(
	table: Table,
	name: string
): ArrayLike<number | null> | ArrayLike<string> {
	const field = table.schema.fields.find(f => f.name === name);
	if (field === undefined) {
		throw new ExtractArrowError(`column '${name}' not in Arrow schema`);
	}
	const vec = table.getChild(name);
	if (vec === null || vec === undefined) {
		throw new ExtractArrowError(`column '${name}' not found in Arrow table`);
	}
	return extractVector(name, field.type, vec);
}

// ---------------------------------------------------------------------------
// dispatch by Arrow type id
// ---------------------------------------------------------------------------

function extractVector(
	name: string,
	type: DataType,
	vec: Vector
): ArrayLike<number | null> | ArrayLike<string> {
	switch (type.typeId) {
		case Type.Timestamp:
			return extractTimestampToMs(name, vec);
		case Type.Date:
			return extractDateToMs(name, vec);
		case Type.Float:
		case Type.Int:
			return extractNumeric(name, vec);
		case Type.Bool:
			return extractBool(vec);
		case Type.Utf8:
		case Type.LargeUtf8:
			return extractString(vec);
		case Type.Dictionary: {
			// Recursively dispatch on the dictionary's value type. apache-arrow
			// JS resolves vec.get(i) to the underlying dictionary value
			// (string / number / etc), so the handlers below see the
			// resolved values directly.
			const dictType = (type as DataType & { dictionary?: DataType }).dictionary;
			if (!dictType) {
				throw new ExtractArrowError(
					`column '${name}': Dictionary type missing value type metadata`
				);
			}
			return extractVector(name, dictType, vec);
		}
		case Type.Decimal:
			throw new ExtractArrowError(
				`column '${name}': Arrow Decimal columns are not supported (would require ` +
				`per-row scale application; planned for a follow-up). Convert to float64 ` +
				`upstream (e.g., CAST in DuckDB) until then.`
			);
		case Type.Binary:
		case Type.LargeBinary:
		case Type.FixedSizeBinary:
			throw new ExtractArrowError(
				`column '${name}': Arrow Binary columns are not extractable -- they are ` +
				`opaque byte blobs. Decode upstream (e.g., to utf8 via DuckDB).`
			);
		case Type.List:
		case Type.FixedSizeList:
			throw new ExtractArrowError(
				`column '${name}': Arrow List columns are nested data -- flatten ` +
				`upstream (e.g., DuckDB UNNEST) before visualizing.`
			);
		case Type.Struct:
		case Type.Map:
		case Type.Union:
		case Type.DenseUnion:
		case Type.SparseUnion:
			throw new ExtractArrowError(
				`column '${name}': Arrow nested type (Struct/Map/Union) is not extractable. ` +
				`Project to scalar columns upstream.`
			);
		case Type.Time:
		case Type.TimeSecond:
		case Type.TimeMillisecond:
		case Type.TimeMicrosecond:
		case Type.TimeNanosecond:
			throw new ExtractArrowError(
				`column '${name}': Arrow Time (time-of-day) is not Timestamp ` +
				`(absolute epoch). If your data is meant to be a Timestamp, fix the ` +
				`upstream type. Time-of-day rendering is unimplemented.`
			);
		case Type.Duration:
		case Type.DurationSecond:
		case Type.DurationMillisecond:
		case Type.DurationMicrosecond:
		case Type.DurationNanosecond:
		case Type.Interval:
		case Type.IntervalDayTime:
		case Type.IntervalYearMonth:
		case Type.IntervalMonthDayNano:
			throw new ExtractArrowError(
				`column '${name}': Arrow Duration/Interval columns are deltas, not ` +
				`renderable as scalar values. Convert to numeric (e.g., milliseconds) ` +
				`upstream.`
			);
		case Type.Null:
			// All-null column: return an array of nulls of the right length.
			return new Array<number | null>(vec.length).fill(null);
		default:
			// Loud failure for genuinely unknown type IDs (e.g., a future
			// Arrow type ID we haven't enumerated). NOT a silent coercion.
			throw new ExtractArrowError(
				`column '${name}': unsupported Arrow type id ${(type as DataType).typeId}; ` +
				`extend extract-arrow.ts:extractVector to handle it`
			);
	}
}

// ---------------------------------------------------------------------------
// per-kind extractors
// ---------------------------------------------------------------------------

/**
 * Convert an Arrow Timestamp column to milliseconds-since-epoch numbers.
 *
 * apache-arrow JS already normalizes Timestamp.get(i) to milliseconds for
 * every unit. We just propagate the Number, with explicit handling for the
 * unlikely bigint/Date branches Arrow may surface in edge cases.
 */
function extractTimestampToMs(name: string, vec: Vector): (number | null)[] {
	const n = vec.length;
	const out = new Array<number | null>(n);
	for (let i = 0; i < n; i++) {
		const v = vec.get(i);
		if (v === null || v === undefined) { out[i] = null; continue; }
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) {
				throw new ExtractArrowError(
					`column '${name}'[${i}]: timestamp non-finite number: ${v}`
				);
			}
			out[i] = v;
		} else if (typeof v === 'bigint') {
			out[i] = bigIntToSafeNumber(name, i, v);
		} else if (v instanceof Date) {
			out[i] = v.getTime();
		} else {
			throw new ExtractArrowError(
				`column '${name}'[${i}]: unexpected timestamp value type ${typeof v}`
			);
		}
	}
	return out;
}

/**
 * Date32 (days) and Date64 (ms) are surfaced as Date by apache-arrow JS.
 * Audit-fix AF19: previously this fell through to silent null on unexpected
 * types. Now we throw so data corruption is visible.
 */
function extractDateToMs(name: string, vec: Vector): (number | null)[] {
	const n = vec.length;
	const out = new Array<number | null>(n);
	for (let i = 0; i < n; i++) {
		const v = vec.get(i);
		if (v === null || v === undefined) { out[i] = null; continue; }
		if (v instanceof Date) { out[i] = v.getTime(); continue; }
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) {
				throw new ExtractArrowError(
					`column '${name}'[${i}]: date non-finite number: ${v}`
				);
			}
			out[i] = v;
			continue;
		}
		if (typeof v === 'bigint') { out[i] = bigIntToSafeNumber(name, i, v); continue; }
		throw new ExtractArrowError(
			`column '${name}'[${i}]: unexpected date value type ${typeof v}`
		);
	}
	return out;
}

/**
 * Numeric extraction: floats / signed-int / unsigned-int. Fast path uses
 * the column's underlying typed array when there are no nulls; otherwise
 * we iterate. Audit-fix AF15: BigInt -> Number conversions are guarded by
 * Number.isSafeInteger so silent truncation past 2^53 throws instead.
 */
function extractNumeric(name: string, vec: Vector): (number | null)[] {
	const n = vec.length;
	// Megaudit CRITICAL-12: refuse to silently null non-finite values.
	// The previous `Number.isFinite(x) ? x : null` collapsed NaN /
	// Infinity into missing points; the chart hid the data-quality
	// issue. Throwing surfaces it.
	if (vec.nullCount === 0) {
		const arr = vec.toArray();
		const out = new Array<number | null>(n);
		if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
			for (let i = 0; i < n; i++) {
				out[i] = bigIntToSafeNumber(name, i, arr[i]);
			}
		} else {
			for (let i = 0; i < n; i++) {
				const x = arr[i] as number;
				if (!Number.isFinite(x)) {
					throw new ExtractArrowError(
						`column '${name}'[${i}]: non-finite value ${x}; refusing to coerce to null`,
					);
				}
				out[i] = x;
			}
		}
		return out;
	}
	const out = new Array<number | null>(n);
	for (let i = 0; i < n; i++) {
		const v = vec.get(i);
		if (v === null || v === undefined) { out[i] = null; continue; }
		if (typeof v === 'bigint') {
			out[i] = bigIntToSafeNumber(name, i, v);
			continue;
		}
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) {
				throw new ExtractArrowError(
					`column '${name}'[${i}]: non-finite value ${v}; refusing to coerce to null`,
				);
			}
			out[i] = v;
			continue;
		}
		throw new ExtractArrowError(
			`column '${name}'[${i}]: unexpected numeric value type ${typeof v}`
		);
	}
	return out;
}

/** Bool -> 0/1 numeric, with null preserved.
 *
 *  Megaudit-2 A5-MAJOR-3.1: throw on anything that isn't strictly
 *  `true | false | null | undefined`. The previous `v === true ? 1 : 0`
 *  silently mapped unexpected types (number, string) to 0 — defeating
 *  CRITICAL-12's refuse-to-coerce principle for the Bool extractor. */
function extractBool(vec: Vector): (number | null)[] {
	const n = vec.length;
	const out = new Array<number | null>(n);
	for (let i = 0; i < n; i++) {
		const v = vec.get(i);
		if (v === null || v === undefined) { out[i] = null; continue; }
		if (v === true) { out[i] = 1; continue; }
		if (v === false) { out[i] = 0; continue; }
		throw new ExtractArrowError(
			`bool column[${i}]: expected boolean, got ${typeof v}`,
		);
	}
	return out;
}

/**
 * String extraction. Nulls coerce to '' to match the JSON-rows extractor
 * contract (which also returns '' for missing string fields).
 */
function extractString(vec: Vector): string[] {
	const n = vec.length;
	const out = new Array<string>(n);
	for (let i = 0; i < n; i++) {
		const v = vec.get(i);
		out[i] = v === null || v === undefined ? '' : String(v);
	}
	return out;
}

/**
 * Convert a BigInt to a Number, throwing if precision would be lost.
 *
 * 2^53 (Number.MAX_SAFE_INTEGER) is the largest exactly-representable
 * integer. Volume columns, ID columns, and far-future timestamps can
 * exceed this. Without a guard, `Number(bigint)` silently rounds and
 * the renderer shows wrong values -- audit finding (Codex + self).
 */
function bigIntToSafeNumber(name: string, index: number, v: bigint): number {
	const n = Number(v);
	if (!Number.isSafeInteger(n)) {
		throw new ExtractArrowError(
			`column '${name}'[${index}]: BigInt value ${v.toString()} exceeds ` +
			`Number.MAX_SAFE_INTEGER (2^53). Cast upstream to float64 if approximate ` +
			`representation is acceptable, or extend extract-arrow.ts to keep BigInt.`
		);
	}
	return n;
}
