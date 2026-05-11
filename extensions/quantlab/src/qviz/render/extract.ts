/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Column extraction from daemon responses.
 *
 * The daemon emits aggregated results in two encodings (per qviz/ipc.py):
 *
 *   - JSON  (encoding == 'json', payload <= 256 KB): a list of row objects
 *   - Arrow IPC (encoding == 'arrow', binary payload):  Apache Arrow stream
 *
 * This file handles the JSON path. The Arrow IPC path requires the
 * `apache-arrow` npm package (a known dependency for Phase 5 -- the webview
 * client that wires daemon -> renderer is where it'll be installed).
 *
 * Time-axis correctness:
 *
 * The daemon reads parquet via pyarrow. Default parquet timestamps are
 * `datetime64[ns]` (nanosecond precision). When DuckDB serializes a
 * temporal column to JSON, it emits ISO 8601 strings; when it stays binary
 * via Arrow IPC, it preserves nanoseconds. @charts-plus consumes
 * milliseconds since epoch (TimeMs).
 *
 * extractTemporalColumn() is the single point of truth for the conversion:
 *   - ISO 8601 string  -> Date.parse() (already ms)
 *   - bigint nanoseconds -> Number(bigint / 1_000_000n)
 *   - number nanoseconds -> Math.floor(value / 1_000_000)
 *   - number microseconds (CSV inferred) -> Math.floor(value / 1000)
 *   - number milliseconds (already TimeMs) -> identity
 *
 * Refusing to guess the unit silently was a deliberate choice in audit
 * findings #2: passing ns timestamps to a chart that expects ms is a
 * 10^6x scale error. The caller MUST tell us the unit.
 */

import type { ColumnData } from './types';

export type TemporalUnit = 'ms' | 'us' | 'ns' | 'iso';

export class ExtractError extends Error {
	constructor(message: string) { super(message); this.name = 'ExtractError'; }
}

/**
 * A column descriptor sufficient to extract one column from JSON rows.
 *
 * `temporalUnit` is required for temporal columns. It must match what the
 * daemon emits -- which depends on the source format and the spec
 * transforms applied. A future version of the daemon may report this in
 * the response metadata; until then, the extension-side caller derives it
 * from the spec / schema.
 */
export interface ColumnSpec {
	readonly name: string;
	readonly kind: 'temporal' | 'numeric' | 'string';
	readonly temporalUnit?: TemporalUnit;
}

/**
 * Extract columns from a JSON rows response. The daemon's JSON encoding
 * shape is `{ rows: [{...}, ...], n: N }`.
 *
 * Returns a ColumnData where:
 *   - temporal columns are number[] of milliseconds since epoch
 *   - numeric columns are number[] (null preserved)
 *   - string columns are string[]
 */
export function extractColumnsFromJsonRows(
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
	specs: readonly ColumnSpec[]
): ColumnData {
	const out: Record<string, (number | null)[] | string[]> = {};
	const n = rows.length;

	for (const spec of specs) {
		if (spec.kind === 'temporal') {
			// Megaudit CRITICAL-12: the module docstring explicitly
			// forbids unit-guessing; the `?? 'iso'` fallback was
			// contradicting that contract. If the caller didn't
			// supply a temporalUnit, refuse to extract.
			if (spec.temporalUnit === undefined) {
				throw new ExtractError(
					`temporal column '${spec.name}' has no temporalUnit; unit guessing is forbidden`,
				);
			}
			out[spec.name] = extractTemporalColumn(rows, spec.name, spec.temporalUnit);
		} else if (spec.kind === 'numeric') {
			out[spec.name] = extractNumericColumn(rows, spec.name);
		} else if (spec.kind === 'string') {
			out[spec.name] = extractStringColumn(rows, spec.name);
		}
	}

	void n;
	return out as ColumnData;
}

// ---------------------------------------------------------------------------
// Per-kind extractors
// ---------------------------------------------------------------------------

function extractTemporalColumn(
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
	name: string,
	unit: TemporalUnit
): (number | null)[] {
	const out = new Array<number | null>(rows.length);
	for (let i = 0; i < rows.length; i++) {
		const v = rows[i][name];
		if (v === null || v === undefined) { out[i] = null; continue; }
		out[i] = convertToMs(v, unit, name, i);
	}
	return out;
}

function extractNumericColumn(
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
	name: string
): (number | null)[] {
	// Megaudit CRITICAL-12: refuse to guess. The previous behavior
	// silently mapped NaN/Infinity, unparseable strings, bigints
	// outside safe-integer range, and any-other-type to `null`. Bad
	// data showed as missing points in the chart with no signal. New
	// contract: throw `ExtractError` with column/index/value context
	// so the user sees the upstream data-quality issue.
	const out = new Array<number | null>(rows.length);
	for (let i = 0; i < rows.length; i++) {
		const v = rows[i][name];
		if (v === null || v === undefined) { out[i] = null; continue; }
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) {
				throw new ExtractError(
					`numeric column '${name}' row ${i}: non-finite value ${v}; refusing to coerce to null`,
				);
			}
			out[i] = v;
			continue;
		}
		if (typeof v === 'string') {
			const parsed = Number(v);
			if (!Number.isFinite(parsed)) {
				throw new ExtractError(
					`numeric column '${name}' row ${i}: unparseable string ${JSON.stringify(v)}`,
				);
			}
			out[i] = parsed;
			continue;
		}
		if (typeof v === 'bigint') {
			// Safe-integer check — silent truncation hid data quality
			// issues for values beyond 2^53.
			if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
				throw new ExtractError(
					`numeric column '${name}' row ${i}: bigint ${v} exceeds safe-integer range`,
				);
			}
			out[i] = Number(v);
			continue;
		}
		throw new ExtractError(
			`numeric column '${name}' row ${i}: unsupported value type ${typeof v}`,
		);
	}
	return out;
}


function extractStringColumn(
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
	name: string
): string[] {
	// Megaudit-2 A5-MAJOR-2.1: refuse to silently `String(v)` arbitrary
	// types. The numeric extractor (CRITICAL-12) throws ExtractError
	// for unsupported values; the string extractor was inconsistent —
	// `{ nested: 'x' }` would render as `[object Object]` with no
	// diagnostic. Now: accept string/number/bigint/boolean (with an
	// explicit String() coercion documented), but throw on objects
	// and arrays.
	const out = new Array<string>(rows.length);
	for (let i = 0; i < rows.length; i++) {
		const v = rows[i][name];
		if (v === null || v === undefined) { out[i] = ''; continue; }
		if (typeof v === 'string') { out[i] = v; continue; }
		if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
			out[i] = String(v);
			continue;
		}
		throw new ExtractError(
			`string column '${name}' row ${i}: unsupported value type ${typeof v} (must be string/number/bigint/boolean/null)`,
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Unit conversion to milliseconds
// ---------------------------------------------------------------------------

/**
 * Convert a single temporal value to milliseconds since epoch.
 *
 * `unit` is required and explicit -- we deliberately don't guess. Audit
 * finding #2 calls out that silent ns -> ms passthrough is a 10^6x error.
 *
 * Throws on invalid combinations (e.g., 'iso' with non-string input).
 */
export function convertToMs(value: unknown, unit: TemporalUnit, name = '?', index = 0): number {
	if (unit === 'iso') {
		if (typeof value !== 'string') {
			throw new ExtractError(
				`column ${name}[${index}]: expected ISO string for unit='iso', got ${typeof value}`
			);
		}
		const parsed = Date.parse(value);
		if (Number.isNaN(parsed)) {
			throw new ExtractError(`column ${name}[${index}]: unparseable ISO timestamp: ${value}`);
		}
		return parsed;
	}
	if (unit === 'ms') {
		const n = numberOf(value, name, index);
		return n;
	}
	if (unit === 'us') {
		const n = numberOf(value, name, index);
		return Math.floor(n / 1_000);
	}
	if (unit === 'ns') {
		// Nanoseconds may overflow Number for far-future dates; bigint path is safer.
		if (typeof value === 'bigint') {
			return Number(value / 1_000_000n);
		}
		const n = numberOf(value, name, index);
		return Math.floor(n / 1_000_000);
	}
	throw new ExtractError(`unknown temporal unit: ${String(unit)}`);
}

function numberOf(value: unknown, name: string, index: number): number {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new ExtractError(`column ${name}[${index}]: non-finite number: ${value}`);
		}
		return value;
	}
	if (typeof value === 'bigint') { return Number(value); }
	if (typeof value === 'string') {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			throw new ExtractError(`column ${name}[${index}]: unparseable numeric string: ${value}`);
		}
		return parsed;
	}
	throw new ExtractError(`column ${name}[${index}]: expected number/bigint/string, got ${typeof value}`);
}

/**
 * Bulk convert an entire numeric column from a non-ms time unit to ms,
 * preserving null. Convenience wrapper for the case where the caller already
 * has a typed array (e.g., produced by the future Arrow extractor) and needs
 * to normalize without re-walking row objects.
 */
export function convertColumnToMs(
	values: ReadonlyArray<number | bigint | null>,
	unit: TemporalUnit,
	name = '?'
): (number | null)[] {
	if (unit === 'iso') {
		throw new ExtractError(`convertColumnToMs: unit='iso' is per-row only, use extractColumnsFromJsonRows`);
	}
	const out = new Array<number | null>(values.length);
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v === null) { out[i] = null; continue; }
		out[i] = convertToMs(v, unit, name, i);
	}
	return out;
}
