/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { QvizSpec } from '../src/qviz/spec';
import { validate, validateOrThrow } from '../src/qviz/validate';

const EXAMPLES_DIR = path.join(__dirname, '..', 'src', 'qviz', 'examples');

function readExample(name: string): unknown {
	return JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name), 'utf8'));
}

suite('qviz validation', () => {

	test('all bundled examples pass validation', () => {
		const examples = fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.qviz.json'));
		assert.ok(examples.length >= 4, `expected ≥4 example specs, got ${examples.length}`);
		for (const fileName of examples) {
			const raw = readExample(fileName);
			const result = validate(raw);
			if (!result.ok) {
				const summary = result.issues.map(i => `  ${i.path}: ${i.message}`).join('\n');
				assert.fail(`${fileName} failed validation:\n${summary}`);
			}
		}
	});

	test('round-trip preserves spec content', () => {
		const raw = readExample('timeseries-line-volume.qviz.json');
		const parsed = validateOrThrow(raw);
		const reSerialized = JSON.parse(JSON.stringify(parsed)) as unknown;
		const reParsed = validateOrThrow(reSerialized);
		// JSON.stringify normalizes ordering; comparing the second pair is sufficient.
		assert.deepStrictEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(reParsed)));
	});

	test('rejects wrong qviz_version', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const tampered = { ...raw, qviz_version: 2 };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path === '$.qviz_version'),
			'expected version mismatch error'
		);
	});

	test('rejects absolute dataset paths', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const tampered = { ...raw, dataset: { ...(raw.dataset as object), uri: '/etc/passwd' } };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path === '$.dataset.uri'),
			'expected absolute-path rejection'
		);
	});

	test('rejects ".." in dataset paths', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const tampered = { ...raw, dataset: { ...(raw.dataset as object), uri: '../../etc/passwd' } };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path === '$.dataset.uri'),
			'expected workspace-escape rejection'
		);
	});

	test('rejects malformed schema_hash', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const tampered = { ...raw, dataset: { ...(raw.dataset as object), schema_hash: 'not-a-hash' } };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path === '$.dataset.schema_hash'),
			'expected hash format rejection'
		);
	});

	test('rejects unknown transform kind', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const tampered = {
			...raw,
			transforms: [{ kind: 'eval', code: '__import__("os").system("rm -rf /")' }]
		};
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path === '$.transforms[0].kind'),
			'expected unknown-transform rejection'
		);
	});

	test('rejects candlestick chart without ohlcv encoding', () => {
		const raw = readExample('timeseries-candlestick.qviz.json') as Record<string, unknown>;
		const chart = raw.chart as Record<string, unknown>;
		const tampered = {
			...raw,
			chart: { ...chart, encodings: {} }
		};
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path.endsWith('encodings.ohlcv') || i.message.includes('ohlcv')),
			'expected ohlcv-required rejection'
		);
	});

	test('rejects chart type not allowed in family', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const chart = raw.chart as Record<string, unknown>;
		const tampered = { ...raw, chart: { ...chart, type: 'heatmap' } };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path === '$.chart.type'),
			'expected family/type mismatch rejection'
		);
	});

	test('rejects empty groupby columns', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const transforms = (raw.transforms as readonly unknown[]).slice();
		transforms[2] = { kind: 'groupby', columns: [] };
		const tampered = { ...raw, transforms };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path.includes('groupby') || i.path.includes('columns')),
			'expected empty groupby rejection'
		);
	});

	test('requires provenance', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const tampered = { ...raw, provenance: undefined };
		delete (tampered as { provenance?: unknown }).provenance;
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		assert.ok(
			result.ok === false && result.issues.some(i => i.path.startsWith('$.provenance')),
			'expected provenance-required rejection'
		);
	});

	test('reports multiple issues at once', () => {
		const garbage = {
			qviz_version: 'one',
			dataset: { uri: '/abs', schema_hash: 'no', mtime_ns: 'when' },
			transforms: 'not-array',
			chart: { family: 'unknown', type: 'unknown', encodings: 'no' },
			provenance: 42
		};
		const result = validate(garbage);
		assert.strictEqual(result.ok, false);
		assert.ok(result.ok === false && result.issues.length >= 5, `expected multi-issue reporting, got ${result.ok === false ? result.issues.length : 0}`);
	});

	test('accepts spec with only required fields', () => {
		const minimal: QvizSpec = {
			qviz_version: 1,
			dataset: {
				uri: 'data/x.parquet',
				schema_hash: 'sha256:' + 'a'.repeat(64),
				mtime_ns: 1
			},
			transforms: [],
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' }
				}
			},
			provenance: {
				generated_at: '2026-04-29T00:00:00Z',
				generator: 'test',
				query_hash: 'sha256:0',
				tool_versions: { qviz_schema: 1 }
			}
		};
		const result = validate(minimal);
		assert.strictEqual(result.ok, true);
	});
});
