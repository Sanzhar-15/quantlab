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
import type { QvizSpec, Transform } from '../src/qviz/spec';
import type { ExprAst } from '../src/qviz/exprAst';
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

	test('expr produced name recognized, references flagged when missing', () => {
		// expr references = ['high', 'low']; output = 'mid'.
		const exprSpec = spec({
			transforms: [
				{
					kind: 'expr',
					as: 'mid',
					expression: {
						kind: 'binary', op: '+',
						left: { kind: 'col', name: 'high' },
						right: { kind: 'col', name: 'low' },
					},
					references: ['high', 'low'],
				},
			],
			chart: {
				family: 'general', type: 'scatter',
				encodings: {
					x: { field: 'mid', type: 'quantitative' },
					y: { field: 'high', type: 'quantitative' },
				},
			},
		});

		// All source columns present → preserved.
		assert.strictEqual(
			detectDrift(exprSpec, schemaInfo({
				hash: HASH_B, columns: [{ name: 'high' }, { name: 'low' }],
			})).drift,
			'fields-preserved',
		);

		// Drop `low` → missing-field drift on the expr's references.
		const missing = detectDrift(exprSpec, schemaInfo({
			hash: HASH_B, columns: [{ name: 'high' }],
		}));
		assert.strictEqual(missing.drift, 'fields-missing');
		assert.ok(missing.missingFields.includes('low'),
			`'low' should be in missingFields, got: ${[...missing.missingFields]}`);
	});

	test('window/math/date_trunc produced names recognized', () => {
		const transformSpec = spec({
			transforms: [
				{ kind: 'date_trunc', column: 'ts', unit: 'day', as: 'day' },
				{ kind: 'window', column: 'price', fn: 'rolling_mean', window: 5, order_by: 'ts', as: 'sma5' },
				{ kind: 'math', column: 'price', fn: 'log_returns', order_by: 'ts', as: 'log_r' },
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

	// Megaudit F4 (2026-05-13): one case per transform kind so the
	// walker can't lose a case in a future refactor without a failing
	// test. Cases use default chart encodings (x:a, y:b) so each
	// `expected` is unioned with ['a','b'].
	test('walkTransformReferences pins one case per transform kind', () => {
		const exprAst: ExprAst = {
			kind: 'binary', op: '+',
			left: { kind: 'col', name: 'a' },
			right: { kind: 'col', name: 'b' },
		};
		const cases: Array<[string, Transform[], string[]]> = [
			['filter',
				[{ kind: 'filter', column: 'p', op: '>', value: 0 }],
				['p']],
			['date_trunc',
				[{ kind: 'date_trunc', column: 'ts', unit: 'day', as: 'day' }],
				['ts']],
			['bin',
				[{ kind: 'bin', column: 'v', n_bins: 10, as: 'vb' }],
				['v']],
			['groupby',
				[{ kind: 'groupby', columns: ['c1', 'c2'] }],
				['c1', 'c2']],
			['aggregate',
				[{
					kind: 'aggregate', aggs: [
						{ column: 'x', fn: 'sum', as: 'xs' },
						{ column: 'y', fn: 'mean', as: 'ym' },
					],
				}],
				['x', 'y']],
			['window+order_by',
				[{
					kind: 'window', column: 'price', fn: 'rolling_mean',
					window: 20, order_by: 'ts', as: 'sma20',
				}],
				['price', 'ts']],
			['math+order_by (log_returns)',
				[{
					kind: 'math', column: 'close', fn: 'log_returns',
					order_by: 'ts', as: 'r',
				}],
				['close', 'ts']],
			['math no order_by (log)',
				[{ kind: 'math', column: 'close', fn: 'log', as: 'lc' }],
				['close']],
			['resample',
				[{ kind: 'resample', time_column: 'ts', freq: '1m', fill: 'forward' }],
				['ts']],
			['tz_convert',
				[{ kind: 'tz_convert', column: 'ts', to_tz: 'UTC' }],
				['ts']],
			['sort',
				[{ kind: 'sort', columns: [{ column: 'a' }, { column: 'b', desc: true }] }],
				['a', 'b']],
			['limit',
				[{ kind: 'limit', n: 100 }],
				[]],
			['expr (uses references field verbatim)',
				[{
					kind: 'expr', as: 'sum_ab',
					expression: exprAst,
					references: ['a', 'b'],
				}],
				['a', 'b']],
		];
		for (const [name, transforms, expectedTransformRefs] of cases) {
			const fields = collectReferencedFields(spec({ transforms }));
			// `collectReferencedFields` returns a list without dedup
			// (drift detection AND-s against schema name set, so
			// multiplicities are irrelevant). Dedup before asserting.
			// Default spec encodings always inject 'a','b' from x,y.
			const got = [...new Set(fields)].sort();
			const want = [...new Set([...expectedTransformRefs, 'a', 'b'])].sort();
			assert.deepStrictEqual(got, want, `case: ${name}`);
		}
	});

	test('produced-name reference from downstream expr is filtered out', () => {
		// A window produces 'sma20'; an expr that references it via
		// the AST + references list must NOT surface 'sma20' as a
		// source-column reference (the walker filters produced names).
		const ast: ExprAst = {
			kind: 'binary', op: '*',
			left: { kind: 'col', name: 'sma20' },
			right: { kind: 'num', value: 2 },
		};
		const fields = collectReferencedFields(spec({
			transforms: [
				{
					kind: 'window', column: 'price', fn: 'rolling_mean',
					window: 20, order_by: 'ts', as: 'sma20',
				},
				{
					kind: 'expr', as: 'doubled',
					expression: ast, references: ['sma20'],
				},
			],
		}));
		// Source refs: price, ts (from window) + a, b (encodings).
		// 'sma20' produced; expr's reference filtered.
		assert.deepStrictEqual([...new Set(fields)].sort(),
			['a', 'b', 'price', 'ts']);
	});

	test('expr collector reads .references verbatim, not the AST', () => {
		// Deliberately skew: AST says 'ast_only' but references says 'ref_only'.
		// Use encodings that mention NEITHER — otherwise the encoding's
		// own 'a'/'b' would mask whether the walker incorrectly re-derived
		// from the AST.
		// (Validator would reject this skewed spec at parseExpr; we're
		// testing the collector's contract in isolation.)
		const ast: ExprAst = { kind: 'col', name: 'ast_only' };
		const fields = collectReferencedFields(spec({
			transforms: [{
				kind: 'expr', as: 'derived',
				expression: ast, references: ['ref_only'],
			}],
			chart: {
				family: 'general', type: 'scatter',
				encodings: {
					x: { field: 'enc_x', type: 'quantitative' },
					y: { field: 'enc_y', type: 'quantitative' },
				},
			},
		}));
		// 'ref_only' surfaces (verbatim use); 'ast_only' is NOT independently
		// re-collected. The encoding refs 'enc_x' and 'enc_y' also come through.
		const deduped = [...new Set(fields)].sort();
		assert.deepStrictEqual(deduped, ['enc_x', 'enc_y', 'ref_only'],
			`walker must read references field verbatim, not the AST; got ${JSON.stringify(fields)}`);
		assert.ok(!deduped.includes('ast_only'),
			'ast_only must NOT surface — walker reads .references, not the AST');
	});

	test('window order_by missing in schema is flagged as fields-missing', () => {
		// Codex F4 audit (2026-05-13): pin the actual user-visible
		// regression path that motivated the walker fix. A spec where
		// the window column exists but order_by doesn't would previously
		// have classified as fields-preserved (silent drift); now it
		// must classify as fields-missing.
		const spec1 = spec({
			transforms: [{
				kind: 'window', column: 'price', fn: 'rolling_mean',
				window: 20, order_by: 'ts', as: 'sma20',
			}],
			chart: {
				family: 'general', type: 'line',
				encodings: {
					x: { field: 'sma20', type: 'quantitative' },
					y: { field: 'price', type: 'quantitative' },
				},
			},
		});
		const result = detectDrift(spec1, schemaInfo({
			hash: HASH_B,
			// Schema includes price but NOT ts (order_by source).
			columns: [{ name: 'price' }],
		}));
		assert.strictEqual(result.drift, 'fields-missing',
			'window.order_by missing must be flagged');
		assert.ok([...result.missingFields].includes('ts'),
			`missingFields must include 'ts'; got ${JSON.stringify(result.missingFields)}`);
	});

	test('window order_by referencing produced name is correctly filtered', () => {
		// Realistic post-Theme-A pattern: date_trunc produces 'day',
		// then window orders by 'day'. The walker pushes 'day' for
		// window, but it's already in `produced` by then (date_trunc
		// runs first), so the per-step filter at schemaDrift.ts:134
		// strips it. No 'day' source-reference should appear.
		const spec1 = spec({
			transforms: [
				{ kind: 'date_trunc', column: 'ts', unit: 'day', as: 'day' },
				{
					kind: 'window', column: 'price', fn: 'rolling_mean',
					window: 5, order_by: 'day', as: 'sma5',
				},
			],
			chart: {
				family: 'general', type: 'line',
				encodings: {
					x: { field: 'day', type: 'temporal' },
					y: { field: 'sma5', type: 'quantitative' },
				},
			},
		});
		const fields = collectReferencedFields(spec1);
		// Source refs: ts (from date_trunc), price (from window).
		// 'day' is produced — must NOT surface.
		const deduped = [...new Set(fields)].sort();
		assert.deepStrictEqual(deduped, ['price', 'ts'],
			`order_by referencing produced name must be filtered; got ${JSON.stringify(fields)}`);
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
