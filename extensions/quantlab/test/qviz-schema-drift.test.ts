/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for `schemaDrift.ts` — Phase 5 step 5.C.2.
 *
 * Pure tests: no I/O, no daemon. Each test feeds a `QvizSpec` and a
 * `SchemaInfo` snapshot to `detectDrift` and asserts which of the
 * three branches fires plus which fields are missing.
 */

import * as assert from 'assert';

import { collectReferencedFields, detectDrift } from '../src/qviz/schemaDrift';
import type { QvizSpec } from '../src/qviz/spec';
import type { SchemaInfo } from '../src/qviz/messageProtocol';

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

function spec(overrides: Partial<QvizSpec> = {}): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: HASH_A,
			mtime_ns: 1,
		},
		transforms: [],
		chart: {
			family: 'general', type: 'scatter',
			encodings: {
				x: { field: 'a', type: 'quantitative' },
				y: { field: 'b', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-10T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
		...overrides,
	};
}

function schemaInfo(args: {
	hash?: string;
	columns: { name: string; dtype?: string; nullable?: boolean }[];
}): SchemaInfo {
	return {
		uri: 'data/x.parquet',
		schema_hash: args.hash ?? HASH_A,
		mtime_ns: 1,
		row_count: 100,
		columns: args.columns.map(c => ({
			name: c.name,
			dtype: c.dtype ?? 'float64',
			nullable: c.nullable ?? false,
		})),
	};
}

// ---------------------------------------------------------------------------
// branch 1: same-hash
// ---------------------------------------------------------------------------

suite('schemaDrift -- same-hash branch', () => {

	test('same hash returns same-hash drift with empty missingFields', () => {
		const result = detectDrift(spec(), schemaInfo({
			hash: HASH_A, columns: [{ name: 'a' }, { name: 'b' }],
		}));
		assert.strictEqual(result.drift, 'same-hash');
		assert.strictEqual(result.oldHash, HASH_A);
		assert.strictEqual(result.newHash, HASH_A);
		assert.deepStrictEqual(result.missingFields, []);
	});

	test('same-hash branch does NOT walk fields (cheap path)', () => {
		// Even if the schema doesn't include the spec's referenced
		// columns, a same-hash result is taken at face value.
		const result = detectDrift(spec(), schemaInfo({
			hash: HASH_A, columns: [],
		}));
		assert.strictEqual(result.drift, 'same-hash');
	});

});

// ---------------------------------------------------------------------------
// branch 2: fields-preserved
// ---------------------------------------------------------------------------

suite('schemaDrift -- fields-preserved branch', () => {

	test('hash differs but every referenced field still exists', () => {
		const result = detectDrift(spec(), schemaInfo({
			hash: HASH_B,
			columns: [
				{ name: 'a' }, { name: 'b' },
				{ name: 'c' }, // new column the user could pick up
			],
		}));
		assert.strictEqual(result.drift, 'fields-preserved');
		assert.strictEqual(result.oldHash, HASH_A);
		assert.strictEqual(result.newHash, HASH_B);
		assert.deepStrictEqual(result.missingFields, []);
	});

	test('encoding fields preserved, dtype changed → still preserved', () => {
		// Drift detector compares NAMES, not dtypes. dtype changes are
		// fine here -- spec semantics will catch dtype mismatches at
		// daemon-compile time (timeseries x = temporal field, etc.).
		const result = detectDrift(spec(), schemaInfo({
			hash: HASH_B,
			columns: [
				{ name: 'a', dtype: 'string' },
				{ name: 'b', dtype: 'int64' },
			],
		}));
		assert.strictEqual(result.drift, 'fields-preserved');
	});

});

// ---------------------------------------------------------------------------
// branch 3: fields-missing
// ---------------------------------------------------------------------------

suite('schemaDrift -- fields-missing branch', () => {

	test('encoding x missing from new schema', () => {
		const result = detectDrift(spec(), schemaInfo({
			hash: HASH_B, columns: [{ name: 'b' }, { name: 'c' }],
		}));
		assert.strictEqual(result.drift, 'fields-missing');
		assert.deepStrictEqual([...result.missingFields], ['a']);
	});

	test('multiple missing fields are reported in encounter order', () => {
		const result = detectDrift(
			spec({
				transforms: [
					{ kind: 'filter', column: 'price', op: '>', value: 0 },
				],
				chart: {
					family: 'general', type: 'scatter',
					encodings: {
						x: { field: 'volume', type: 'quantitative' },
						y: { field: 'price', type: 'quantitative' },
						color: { field: 'sector', type: 'nominal' },
					},
				},
			}),
			schemaInfo({ hash: HASH_B, columns: [{ name: 'unrelated' }] }),
		);
		assert.strictEqual(result.drift, 'fields-missing');
		// transforms walk first (price), then encodings (volume, price, sector).
		// Dedupe should drop the second `price`.
		assert.deepStrictEqual([...result.missingFields], ['price', 'volume', 'sector']);
	});

	test('ohlcv cluster: every member checked', () => {
		const ohlcvSpec = spec({
			chart: {
				family: 'timeseries', type: 'candlestick',
				encodings: {
					ohlcv: {
						time: 't', open: 'o', high: 'h', low: 'l', close: 'c',
						volume: 'v',
					},
				},
			},
		});
		const result = detectDrift(ohlcvSpec, schemaInfo({
			hash: HASH_B,
			columns: [{ name: 't' }, { name: 'o' }, { name: 'h' }],
			// missing l, c, v
		}));
		assert.strictEqual(result.drift, 'fields-missing');
		assert.deepStrictEqual([...result.missingFields], ['l', 'c', 'v']);
	});

	test('transform-produced names DO NOT count as missing', () => {
		// `bin` produces `price_bin`; encoding x references that
		// produced name. The schema doesn't have `price_bin` (it
		// shouldn't — produced names are synthesized at run time),
		// but that's not a drift issue.
		const transformSpec = spec({
			transforms: [
				{ kind: 'bin', column: 'price', n_bins: 10, as: 'price_bin' },
			],
			chart: {
				family: 'general', type: 'bar',
				encodings: {
					x: { field: 'price_bin', type: 'ordinal' },
					y: { field: 'count', type: 'quantitative' },
				},
			},
		});
		// `count` is NOT produced (no aggregate transform here), so it
		// SHOULD show as missing if the schema lacks it.
		const result = detectDrift(transformSpec, schemaInfo({
			hash: HASH_B, columns: [{ name: 'price' }, { name: 'count' }],
		}));
		assert.strictEqual(result.drift, 'fields-preserved',
			'price_bin (transform-produced) must not count as missing');
	});

	test('aggregate-produced names recognized', () => {
		const transformSpec = spec({
			transforms: [
				{ kind: 'groupby', columns: ['day'] },
				{
					kind: 'aggregate', aggs: [
						{ column: 'volume', fn: 'sum', as: 'vol_sum' },
					],
				},
			],
			chart: {
				family: 'general', type: 'bar',
				encodings: {
					x: { field: 'day', type: 'nominal' },
					y: { field: 'vol_sum', type: 'quantitative' },
				},
			},
		});
		const result = detectDrift(transformSpec, schemaInfo({
			hash: HASH_B, columns: [{ name: 'day' }, { name: 'volume' }],
		}));
		assert.strictEqual(result.drift, 'fields-preserved');
	});

	test('window/math/date_trunc produced names recognized', () => {
		const transformSpec = spec({
			transforms: [
				{ kind: 'date_trunc', column: 'ts', unit: 'day', as: 'day' },
				{ kind: 'window', column: 'price', fn: 'rolling_mean', window: 5, as: 'sma5' },
				{ kind: 'math', column: 'price', fn: 'log_returns', as: 'log_r' },
			],
			chart: {
				family: 'general', type: 'scatter',
				encodings: {
					x: { field: 'day', type: 'temporal' },
					y: { field: 'sma5', type: 'quantitative' },
					color: { field: 'log_r', type: 'quantitative' },
				},
			},
		});
		const result = detectDrift(transformSpec, schemaInfo({
			hash: HASH_B, columns: [{ name: 'ts' }, { name: 'price' }],
		}));
		assert.strictEqual(result.drift, 'fields-preserved');
	});

	test('sort transform with missing column', () => {
		const transformSpec = spec({
			transforms: [
				{ kind: 'sort', columns: [
					{ column: 'a' }, { column: 'b', desc: true },
					{ column: 'gone' },
				] },
			],
		});
		const result = detectDrift(transformSpec, schemaInfo({
			hash: HASH_B, columns: [{ name: 'a' }, { name: 'b' }],
		}));
		assert.strictEqual(result.drift, 'fields-missing');
		assert.deepStrictEqual([...result.missingFields], ['gone']);
	});

	test('filter / tz_convert / resample / limit', () => {
		const transformSpec = spec({
			transforms: [
				{ kind: 'filter', column: 'p', op: '>', value: 0 },
				{ kind: 'tz_convert', column: 'ts', to_tz: 'UTC' },
				{ kind: 'resample', time_column: 'ts', freq: '1m', fill: 'forward' },
				{ kind: 'limit', n: 100 },
			],
		});
		// All required source columns present except the encoding ones.
		const result = detectDrift(transformSpec, schemaInfo({
			hash: HASH_B, columns: [
				{ name: 'p' }, { name: 'ts' },
				{ name: 'a' }, { name: 'b' },
			],
		}));
		assert.strictEqual(result.drift, 'fields-preserved');
	});

});

// ---------------------------------------------------------------------------
// collectReferencedFields direct tests
// ---------------------------------------------------------------------------

suite('schemaDrift -- collectReferencedFields', () => {

	test('reports only source-column references (not produced names)', () => {
		const fields = collectReferencedFields(spec({
			transforms: [
				{ kind: 'date_trunc', column: 'ts', unit: 'day', as: 'day' },
				{ kind: 'groupby', columns: ['day'] },
				{
					kind: 'aggregate', aggs: [
						{ column: 'volume', fn: 'sum', as: 'vol_sum' },
					],
				},
			],
			chart: {
				family: 'general', type: 'bar',
				encodings: {
					x: { field: 'day', type: 'nominal' },
					y: { field: 'vol_sum', type: 'quantitative' },
				},
			},
		}));
		// Source-only references: ts, volume. day is groupby's input,
		// but date_trunc PRODUCES day before groupby runs, so it's a
		// produced name and should be excluded.
		assert.deepStrictEqual([...fields].sort(), ['ts', 'volume']);
	});

	test('limit transform contributes no references', () => {
		const fields = collectReferencedFields(spec({
			transforms: [{ kind: 'limit', n: 100, offset: 5 }],
		}));
		// Only the encoding refs (a, b) make it through.
		assert.deepStrictEqual([...fields].sort(), ['a', 'b']);
	});

	test('SD2 shadow-alias: later alias must NOT hide earlier source-column reference', () => {
		// Step C megaudit Critical SD2: prior implementation collected
		// all references first then filtered against the FULL produced
		// set. So a LATER transform's `as: 'X'` could mask an EARLIER
		// transform's reference to a source column literally named `X`.
		//
		// Scenario: filter references source column 'price'. THEN bin
		// produces an alias 'price' (col=other → as=price). The `price`
		// reference in filter MUST still count as a source-column ref.
		const spec1 = spec({
			transforms: [
				// First: filter references SOURCE column 'price'.
				{ kind: 'filter', column: 'price', op: '>', value: 0 },
				// Then: bin produces an alias literally called 'price'
				// (sketchy but legal — the spec validator doesn't reject
				// this name collision).
				{ kind: 'bin', column: 'volume', n_bins: 10, as: 'price' },
			],
			chart: {
				family: 'general', type: 'scatter',
				encodings: {
					x: { field: 'price', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		// Drift schema lacks 'price'. The filter's reference to source
		// 'price' MUST be flagged. The encoding x={field:'price'} comes
		// AFTER the bin alias and thus references the alias (not source).
		const result = detectDrift(spec1, schemaInfo({
			hash: HASH_B, columns: [{ name: 'volume' }, { name: 'b' }],
		}));
		assert.strictEqual(result.drift, 'fields-missing',
			'filter\'s reference to source-column price must be flagged even though a later bin produces an alias also named price');
		assert.ok([...result.missingFields].includes('price'),
			`missingFields must include 'price'; got ${JSON.stringify(result.missingFields)}`);
	});

});
