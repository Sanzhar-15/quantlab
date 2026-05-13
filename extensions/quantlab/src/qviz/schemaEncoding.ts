/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema-aware encoding-type inference — Pattern B (post-smoke
 * builder-coherence pass, 2026-05-13).
 *
 * Single source of truth for "given this column from this schema,
 * what `encoding.type` should the assignment use?" Replaces the
 * historical `defaults.ts:classifyColumn` as the primitive that every
 * assignment site flows through (column-panel click, encoding-shelf
 * drag-drop, Front 1's chart-type fitter controller).
 *
 * Vega-Lite temporal trap notes (per Codex pre-flight):
 *   - Numeric temporal values in Vega-Lite are MILLISECONDS, not
 *     seconds. If the daemon emits Unix-seconds timestamps, the
 *     chart will silently misrender by a factor of 1000. The
 *     daemon normalizes pyarrow timestamps to ms before Arrow IPC
 *     egress; that contract holds at this layer.
 *   - We do NOT auto-classify `utf8` as temporal even if values
 *     parse as dates. Schema dtype is the only signal we trust.
 *     This prevents surprising coercion of user-typed string
 *     columns that happen to contain date-like strings.
 *   - ISO 8601 strings are the safe interchange format for
 *     temporal values that survive the JSON-clone round trip.
 *
 * For future channel-aware inference (e.g., `color` channel may
 * prefer `ordinal` over `quantitative` for low-cardinality numeric
 * columns), use `inferEncodingTypeForChannel`. The plain
 * `classifyColumn` stays channel-agnostic.
 */

import type { SchemaColumn, SchemaInfo } from './messageProtocol';
import type { EncodingType } from './spec';

/** Encoding type vocabulary, matched by the Vega-Lite-side renderer.
 *  `ordinal` is intentionally absent today from classification — only
 *  user-set encodings carry that type. */
export type ClassifiedColumnType = 'temporal' | 'quantitative' | 'nominal' | 'ordinal';

/**
 * Map a pyarrow dtype string to the qviz EncodingType vocabulary.
 * Unknown / unsupported dtypes fall through to `'nominal'`.
 *
 * Extracted from `defaults.ts:classifyColumn` in the post-smoke
 * builder-coherence pass; `defaults.ts` re-exports for back-compat
 * so existing call sites don't break.
 */
export function classifyColumn(col: SchemaColumn): ClassifiedColumnType {
	const dt = col.dtype.toLowerCase();
	if (dt.startsWith('timestamp') || dt === 'date32[day]' || dt === 'date64[ms]') {
		return 'temporal';
	}
	if (
		dt.startsWith('int') || dt.startsWith('uint')
		|| dt.startsWith('float') || dt === 'double' || dt === 'half_float'
		|| dt.startsWith('decimal')
	) {
		return 'quantitative';
	}
	if (dt === 'utf8' || dt === 'large_utf8' || dt === 'string'
		|| dt.startsWith('dictionary')
		|| dt === 'bool' || dt === 'boolean'
	) {
		return 'nominal';
	}
	return 'nominal';
}

/**
 * Channel-aware encoding-type inference. Given a schema, a column
 * name, and a target channel, return the encoding type that should
 * be persisted on assignment.
 *
 * Today the channel hint doesn't change the result vs `classifyColumn`,
 * but the API shape is reserved for future heuristics:
 *
 *   - `color` channel: prefer `ordinal` for low-cardinality numeric
 *     columns (categorical color scale instead of sequential), once
 *     we wire cardinality stats into the schema.
 *   - `size` / `shape` channels: same.
 *   - `x` / `y` channels: pass through `classifyColumn` (no
 *     re-interpretation; quantitative→quantitative, temporal→
 *     temporal).
 *
 * Returns `null` if the column is not in the schema. Caller can
 * then refuse the assignment or show a "column not found"
 * diagnostic.
 */
export function inferEncodingTypeForChannel(
	schema: SchemaInfo,
	columnName: string,
	_channel: 'x' | 'y' | 'y2' | 'color' | 'size' | 'shape' | 'facet_row' | 'facet_col',
): EncodingType | null {
	const col = schema.columns.find(c => c.name === columnName);
	if (col === undefined) { return null; }
	return classifyColumn(col);
}
