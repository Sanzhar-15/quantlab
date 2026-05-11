/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Default-spec derivation — Phase 5 step 5.C.3.
 *
 * Pure module. No vscode imports. No I/O. Given a `SchemaInfo` and a
 * dataset URI, produce a fully-valid `QvizSpec` with reasonable
 * defaults so the user lands on a working chart at file-open time
 * instead of a blank canvas.
 *
 * Defaulting policy (per the plan):
 *   - First temporal column → `x` encoding (type 'temporal').
 *   - First numeric column → `y` encoding (type 'quantitative').
 *   - Family + chart type:
 *       - temporal x AND numeric y → `timeseries` family, `line` type.
 *       - no temporal but ≥2 numerics → `general` family, `scatter`
 *         type with first numeric x and second numeric y.
 *       - no temporal AND only nominal/ordinal columns → returns an
 *         error (the user must build a non-trivial pipeline; defaults
 *         can't pick a sensible chart).
 *   - Empty transforms.
 *   - Provenance: `generator='quantlab-visualise/builder'`,
 *     `source='user-built'`, `generated_at=nowIso`,
 *     `query_hash='sha256:0…0'` (no aggregate has been run yet),
 *     `tool_versions={ qviz_schema: 1 }`.
 *
 * The result passes `validate()` from `qviz/validate.ts`. Caller can
 * dispatch it as the initial state for the spec editor.
 *
 * Dtype classification: pyarrow dtypes that the daemon emits
 * (`schema` op, `python/qviz/reader.py`) are mapped to one of:
 *   - `temporal`     → starts with `timestamp`.
 *   - `quantitative` → numeric (int*, uint*, float*, decimal).
 *   - `nominal`      → string-like (utf8, large_utf8, dictionary<...>).
 *   - `ordinal`      → never auto-detected; Y2 / future use.
 *
 * The classification is resilient to unknown dtypes (treated as
 * nominal — they won't be picked as x or y by the defaults but they
 * remain visible in the column panel).
 */

import type {
	QvizSpec, ChartFamily, ChartType, Encoding, Encodings, Provenance,
} from './spec';
import type { SchemaColumn, SchemaInfo } from './messageProtocol';

const QVIZ_VERSION = 1 as const;
const ZERO_HASH = 'sha256:' + '0'.repeat(64);
const BUILDER_GENERATOR = 'quantlab-visualise/builder';

export type DeriveDefaultSpecResult =
	| { readonly ok: true; readonly spec: QvizSpec }
	| { readonly ok: false; readonly error: string };

export interface DeriveDefaultSpecArgs {
	readonly datasetUri: string;
	readonly schema: SchemaInfo;
	readonly nowIso: string;
}

/**
 * Build a complete, validator-passing default spec from a schema.
 *
 * Returns `{ ok: false, error }` when the schema can't drive a sensible
 * default (no usable columns). The caller should surface the error
 * verbatim — it names the actionable shortfall ("no columns",
 * "no numeric column", etc.).
 */
export function deriveDefaultSpec(args: DeriveDefaultSpecArgs): DeriveDefaultSpecResult {
	const cols = args.schema.columns;
	if (cols.length === 0) {
		return { ok: false, error: 'schema has no columns; cannot derive default spec' };
	}

	const classified = cols.map(c => ({ col: c, type: classifyColumn(c) }));
	const temporal = classified.find(c => c.type === 'temporal');
	const numerics = classified.filter(c => c.type === 'quantitative');

	let family: ChartFamily;
	let chartType: ChartType;
	let encodings: Encodings;

	// Per the plan: line if temporal-x else scatter, empty transforms.
	// Step C megaudit D1: the prior "1 numeric + nominal → bar" branch
	// was beyond the documented scope and produced specs without an
	// aggregation pipeline (raw bars over potentially thousands of
	// duplicate categories). Revert to two cases only — caller picks
	// chart type manually if neither applies.
	if (temporal && numerics.length >= 1) {
		family = 'timeseries';
		chartType = 'line';
		encodings = {
			x: makeEncoding(temporal.col, 'temporal'),
			y: makeEncoding(numerics[0].col, 'quantitative'),
		};
	} else if (numerics.length >= 2) {
		family = 'general';
		chartType = 'scatter';
		encodings = {
			x: makeEncoding(numerics[0].col, 'quantitative'),
			y: makeEncoding(numerics[1].col, 'quantitative'),
		};
	} else {
		return {
			ok: false,
			error: 'schema has no temporal column AND fewer than two numeric columns; '
				+ 'cannot derive a default chart. Pick columns and chart type manually.',
		};
	}

	const provenance: Provenance = {
		generated_at: args.nowIso,
		generator: BUILDER_GENERATOR,
		query_hash: ZERO_HASH,
		tool_versions: { qviz_schema: 1 },
		source: 'user-built',
	};

	return {
		ok: true,
		spec: {
			qviz_version: QVIZ_VERSION,
			dataset: {
				uri: args.datasetUri,
				schema_hash: args.schema.schema_hash,
				mtime_ns: args.schema.mtime_ns,
				...(args.schema.row_count !== null ? { row_count: args.schema.row_count } : {}),
			},
			transforms: [],
			chart: { family, type: chartType, encodings },
			provenance,
		},
	};
}

// ---------------------------------------------------------------------------
// dtype classification
// ---------------------------------------------------------------------------

export type ClassifiedColumnType = 'temporal' | 'quantitative' | 'nominal' | 'ordinal';

/** Map a pyarrow dtype string to the qviz EncodingType vocabulary.
 *  Unknown / unsupported dtypes fall through to 'nominal'. */
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

function makeEncoding(col: SchemaColumn, type: ClassifiedColumnType): Encoding {
	// Drop 'ordinal' fallback for unused enum -- temporal/quantitative/
	// nominal are what the defaults emit. If a future caller wants
	// ordinal it can construct manually.
	const encType = type === 'ordinal' ? 'ordinal' : type;
	return { field: col.name, type: encType };
}
