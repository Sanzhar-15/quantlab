/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Theme B megaudit tests — validator drift / validator-compiler agreement.
 *
 * B4: tool_versions.qviz_schema must equal QVIZ_SCHEMA_VERSION
 * B6: ohlcv.volume present-but-wrong-type hard-fails
 * B7: sort.columns[].desc must be a real boolean
 * B8: trading_options.precision must be integer in [0, 18]
 */

import * as assert from 'assert';

import { validate } from '../src/qviz/validate';
import type { QvizSpec } from '../src/qviz/spec';

function base(): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
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
			generated_at: '2026-05-13T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
	};
}

suite('B4: tool_versions.qviz_schema equals top-level version', () => {

	test('matching qviz_schema accepted', () => {
		const r = validate(base());
		assert.strictEqual(r.ok, true, !r.ok ? JSON.stringify(r.issues) : '');
	});

	test('mismatched qviz_schema rejected', () => {
		const spec = base();
		const bad: unknown = {
			...spec,
			provenance: {
				...spec.provenance,
				tool_versions: { qviz_schema: 999 },
			},
		};
		const r = validate(bad);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /tool_versions\.qviz_schema/.test(i.path)));
	});

});

suite('B6: ohlcv.volume present-but-wrong-type hard-fails', () => {

	function specWithVolume(volume: unknown): unknown {
		const spec = base();
		return {
			...spec,
			chart: {
				family: 'timeseries' as const, type: 'candlestick' as const,
				encodings: {
					ohlcv: {
						time: 't', open: 'o', high: 'h', low: 'l', close: 'c',
						...(volume === '__omit__' ? {} : { volume }),
					},
				},
			},
		};
	}

	test('volume: 42 (number) rejected', () => {
		const r = validate(specWithVolume(42));
		assert.strictEqual(r.ok, false);
	});

	test('volume omitted accepted', () => {
		const r = validate(specWithVolume('__omit__'));
		assert.strictEqual(r.ok, true, !r.ok ? JSON.stringify(r.issues) : '');
	});

	test('volume: "v" (string) accepted', () => {
		const r = validate(specWithVolume('v'));
		assert.strictEqual(r.ok, true);
	});

});

suite('B7: sort.columns[].desc must be a real boolean', () => {

	function specWithSort(desc: unknown): unknown {
		const spec = base();
		return {
			...spec,
			transforms: [{
				kind: 'sort',
				columns: [{ column: 'a', desc }],
			}],
		};
	}

	test('desc: true accepted', () => {
		const r = validate(specWithSort(true));
		assert.strictEqual(r.ok, true, !r.ok ? JSON.stringify(r.issues) : '');
	});

	test('desc: false accepted', () => {
		const r = validate(specWithSort(false));
		assert.strictEqual(r.ok, true);
	});

	test('desc: "yes" rejected (no silent coercion)', () => {
		const r = validate(specWithSort('yes'));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /\.desc/.test(i.path)));
	});

	test('desc: 1 rejected', () => {
		const r = validate(specWithSort(1));
		assert.strictEqual(r.ok, false);
	});

});

suite('B8: trading_options.precision must be safe integer [0, 18]', () => {

	function specWithPrecision(price: unknown, quantity: unknown): unknown {
		const spec = base();
		return {
			...spec,
			trading_options: {
				precision: { price, quantity },
			},
		};
	}

	test('valid integers accepted', () => {
		const r = validate(specWithPrecision(4, 2));
		assert.strictEqual(r.ok, true, !r.ok ? JSON.stringify(r.issues) : '');
	});

	test('zero accepted', () => {
		const r = validate(specWithPrecision(0, 0));
		assert.strictEqual(r.ok, true);
	});

	test('negative rejected', () => {
		const r = validate(specWithPrecision(-1, 2));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /precision\.price/.test(i.path)));
	});

	test('fractional rejected', () => {
		const r = validate(specWithPrecision(1.5, 2));
		assert.strictEqual(r.ok, false);
	});

	test('above-cap rejected', () => {
		const r = validate(specWithPrecision(19, 2));
		assert.strictEqual(r.ok, false);
	});

});
