/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { QvizSpec } from '../src/qviz/spec';
import { validate, validateOrThrow } from '../src/qviz/validate';

// At runtime, __dirname is out/test, so two `..` segments are needed
// to climb back to the package root before descending into src/.
const EXAMPLES_DIR = path.join(__dirname, '..', '..', 'src', 'qviz', 'examples');

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

	test('candlestick without ohlcv encoding is rejected (B3 megaudit)', () => {
		// Megaudit Theme B (B3, 2026-05-13): the validator now enforces
		// the candlestick ↔ ohlcv cross-validation rule. Previously per-
		// encoding completeness was deferred to compile time to avoid
		// builder-time error noise; the OHLCV CLUSTER specifically is a
		// structural invariant of candlestick charts and is checked at
		// the validator boundary.
		//
		// The wider "x must be present, y must be present, etc." checks
		// remain at compile time per the 2026-05-11 cure.
		const raw = readExample('timeseries-candlestick.qviz.json') as Record<string, unknown>;
		const chart = raw.chart as Record<string, unknown>;
		const tampered = {
			...raw,
			chart: { ...chart, encodings: {} }
		};
		const result = validate(tampered);
		assert.strictEqual(result.ok, false,
			'candlestick without ohlcv is structurally invalid');
		if (!result.ok) {
			assert.ok(result.issues.some(i => /ohlcv/.test(i.path)),
				`expected ohlcv-missing issue, got ${JSON.stringify(result.issues)}`);
		}
	});

	test('B3: non-candlestick chart with stray ohlcv encoding is rejected', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const chart = raw.chart as Record<string, unknown>;
		const encodings = chart.encodings as Record<string, unknown>;
		const tampered = {
			...raw,
			chart: { ...chart, encodings: { ...encodings,
				ohlcv: { time: 't', open: 'o', high: 'h', low: 'l', close: 'c' } } },
		};
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.ok(result.issues.some(i => /ohlcv/.test(i.path)));
		}
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

	test('validator-compiler coordination: rejects ema window fn', () => {
		// The daemon's compiler does not implement ema (needs recursive
		// CTE). The validator must reject so users don't save a spec
		// the daemon will reject at first aggregate.
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const transforms = (raw.transforms as readonly unknown[]).slice();
		transforms[transforms.length - 1] = {
			kind: 'window', column: 'close', fn: 'ema', window: 14, order_by: 'timestamp', as: 'ema14',
		};
		const tampered = { ...raw, transforms };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		if (result.ok) { return; }
		assert.ok(
			result.issues.some(i => /ema/i.test(i.message) && /not yet implemented/i.test(i.message)),
			`expected ema-not-implemented rejection; got ${JSON.stringify(result.issues)}`,
		);
	});

	test('validator-compiler coordination: rejects bin.strategy=equal_freq', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const transforms = (raw.transforms as readonly unknown[]).slice();
		transforms[transforms.length - 1] = {
			kind: 'bin', column: 'close', n_bins: 10, strategy: 'equal_freq', as: 'price_bin',
		};
		const tampered = { ...raw, transforms };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		if (result.ok) { return; }
		assert.ok(
			result.issues.some(i => /equal_freq/.test(i.message) && /not yet implemented/i.test(i.message)),
			`expected equal_freq-not-implemented rejection; got ${JSON.stringify(result.issues)}`,
		);
	});

	test('validator-compiler coordination: rejects resample transform', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const transforms = (raw.transforms as readonly unknown[]).slice();
		transforms[transforms.length - 1] = {
			kind: 'resample', time_column: 'timestamp', freq: '1h', fill: 'forward',
		};
		const tampered = { ...raw, transforms };
		const result = validate(tampered);
		assert.strictEqual(result.ok, false);
		if (result.ok) { return; }
		assert.ok(
			result.issues.some(i => /resample/.test(i.message) && /not yet implemented/i.test(i.message)),
			`expected resample-not-implemented rejection; got ${JSON.stringify(result.issues)}`,
		);
	});

	test('validator-compiler coordination: rolling_mean STILL accepted (gate is fn-specific)', () => {
		// Ensure the ema gate doesn't accidentally reject other window fns.
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const transforms = (raw.transforms as readonly unknown[]).slice();
		transforms[transforms.length - 1] = {
			kind: 'window', column: 'close', fn: 'rolling_mean', window: 5, order_by: 'timestamp', as: 'sma5',
		};
		const tampered = { ...raw, transforms };
		const result = validate(tampered);
		assert.strictEqual(result.ok, true, `rolling_mean should validate; got ${JSON.stringify(result.ok === false ? result.issues : 'ok')}`);
	});

	test('validator-compiler coordination: bin without strategy STILL accepted (gate is strategy-specific)', () => {
		const raw = readExample('timeseries-line-volume.qviz.json') as Record<string, unknown>;
		const transforms = (raw.transforms as readonly unknown[]).slice();
		transforms[transforms.length - 1] = {
			kind: 'bin', column: 'close', n_bins: 10, as: 'price_bin',
		};
		const tampered = { ...raw, transforms };
		const result = validate(tampered);
		assert.strictEqual(result.ok, true);
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
