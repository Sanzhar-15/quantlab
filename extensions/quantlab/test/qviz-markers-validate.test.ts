/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Marker validation tests — Theme A megaudit (A6, A7, A8).
 *
 * A6: `time` is required (was optional → padded to empty string)
 * A7: `time` accepts string OR finite number (was rejected when numeric)
 * A8: `MARKER_SHAPES` enum aligned with `Marker.shape` type (4 shapes,
 *     not 6 — 'diamond' and 'triangle' don't exist in the type and the
 *     renderer doesn't handle them).
 */

import * as assert from 'assert';

import { validate } from '../src/qviz/validate';
import type { QvizSpec } from '../src/qviz/spec';

function specWithMarkers(markers: unknown[]): unknown {
	const base: QvizSpec = {
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
			options: {
				markers: markers as never,
			},
		},
		provenance: {
			generated_at: '2026-05-13T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
	};
	return base;
}

suite('marker validator -- A6: time is required', () => {

	test('marker without time field rejected', () => {
		const r = validate(specWithMarkers([{ label: 'x' }]));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /markers\[0\]\.time/.test(i.path)),
			`expected error at chart.options.markers[0].time, got: ${JSON.stringify(r.issues)}`);
	});

	test('marker with time: null rejected', () => {
		const r = validate(specWithMarkers([{ time: null, label: 'x' }]));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /markers\[0\]\.time/.test(i.path)));
	});

	test('marker with string time accepted', () => {
		const r = validate(specWithMarkers([{ time: '2024-01-01T00:00:00Z', label: 'open' }]));
		assert.strictEqual(r.ok, true, !r.ok ? JSON.stringify(r.issues) : '');
	});

});

suite('marker validator -- A7: time accepts finite number', () => {

	test('numeric epoch ms time accepted', () => {
		const r = validate(specWithMarkers([{ time: 1700000000000, label: 'epoch' }]));
		assert.strictEqual(r.ok, true, !r.ok ? JSON.stringify(r.issues) : '');
		if (!r.ok) { return; }
		const marker = r.value.chart.options!.markers![0];
		assert.strictEqual(marker.time, 1700000000000);
		assert.strictEqual(typeof marker.time, 'number');
	});

	test('numeric finite negative time accepted', () => {
		const r = validate(specWithMarkers([{ time: -1, label: 'pre-epoch' }]));
		assert.strictEqual(r.ok, true);
	});

	test('time: Infinity rejected', () => {
		const r = validate(specWithMarkers([{ time: Number.POSITIVE_INFINITY }]));
		assert.strictEqual(r.ok, false);
	});

	test('time: NaN rejected', () => {
		const r = validate(specWithMarkers([{ time: Number.NaN }]));
		assert.strictEqual(r.ok, false);
	});

	test('time: boolean rejected', () => {
		const r = validate(specWithMarkers([{ time: true }]));
		assert.strictEqual(r.ok, false);
	});

	test('time: object rejected', () => {
		const r = validate(specWithMarkers([{ time: { ms: 100 } }]));
		assert.strictEqual(r.ok, false);
	});

});

suite('marker validator -- A8: MARKER_SHAPES aligned to Marker.shape', () => {

	test('shape: diamond rejected (was previously accepted)', () => {
		const r = validate(specWithMarkers([{ time: '2024-01-01', shape: 'diamond' }]));
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.issues.some(i => /markers\[0\]\.shape/.test(i.path)));
	});

	test('shape: triangle rejected', () => {
		const r = validate(specWithMarkers([{ time: '2024-01-01', shape: 'triangle' }]));
		assert.strictEqual(r.ok, false);
	});

	test('all 4 supported shapes accepted', () => {
		for (const shape of ['arrowUp', 'arrowDown', 'circle', 'square']) {
			const r = validate(specWithMarkers([{ time: '2024-01-01', shape }]));
			assert.strictEqual(r.ok, true,
				`shape ${shape} should validate: ${!r.ok ? JSON.stringify(r.issues) : ''}`);
		}
	});

});
