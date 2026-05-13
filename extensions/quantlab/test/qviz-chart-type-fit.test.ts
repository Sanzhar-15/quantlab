/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 1 (2026-05-14): per-chart-type integration tests for the
 * `fitChartTypeTransition` controller.
 *
 * Schema is a synthetic BTC daily OHLCV CSV — the smoke-session
 * dataset shape. Tests assert four invariants per chart type:
 *
 *   1. Required channels are populated after the fit.
 *   2. Compatible channels from the previous chart type are preserved.
 *   3. The transition produces exactly ONE history entry when piped
 *      through the reducer.
 *   4. The resulting spec passes the daemon validator.
 */

import * as assert from 'assert';
import { fitChartTypeTransition } from '../webview/qviz/controllers/chartTypeFit';
import { INITIAL_SPEC_STATE, reduceSpec } from '../webview/qviz/state/specState';
import { validate as validateSpec, type Issue } from '../src/qviz/validate';
import type { SchemaInfo } from '../src/qviz/messageProtocol';
import type {
	ChartFamily, ChartType, Encodings, QvizSpec,
} from '../src/qviz/spec';
import { CHART_CHANNELS } from '../src/qviz/chartChannels';

// Synthetic BTC daily OHLCV schema (the smoke-session shape).
const BTC_SCHEMA: SchemaInfo = {
	uri: 'data/btc.parquet',
	schema_hash: 'sha256:' + 'a'.repeat(64),
	mtime_ns: 1,
	row_count: 1000,
	columns: [
		{ name: 'date', dtype: 'timestamp[ns]', nullable: false },
		{ name: 'open', dtype: 'double', nullable: false },
		{ name: 'high', dtype: 'double', nullable: false },
		{ name: 'low', dtype: 'double', nullable: false },
		{ name: 'close', dtype: 'double', nullable: false },
		{ name: 'volume', dtype: 'int64', nullable: false },
		{ name: 'exchange', dtype: 'utf8', nullable: false },
	],
};

function makeSpec(family: ChartFamily, type: ChartType, enc: Encodings): QvizSpec {
	return {
		qviz_version: 1 as const,
		dataset: {
			uri: 'data/btc.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		chart: { family, type, encodings: enc },
		provenance: {
			generated_at: '2026-05-14T00:00:00Z',
			generator: 'quantlab-visualise/builder',
			query_hash: 'sha256:' + '0'.repeat(64),
			tool_versions: { qviz_schema: 1 },
			source: 'user-built',
		},
	};
}

/** Drive the action through the reducer + assert ONE history entry. */
function applyViaReducer(spec: QvizSpec, fit: ReturnType<typeof fitChartTypeTransition>) {
	const initialSpecState = {
		...INITIAL_SPEC_STATE,
		current: spec,
		currentHash: 'sha256:' + 'b'.repeat(64),
		lastSavedHash: 'sha256:' + 'b'.repeat(64),
	};
	const next = reduceSpec(initialSpecState, {
		type: 'applyChartTypeWithFit',
		family: fit.family,
		chartType: fit.chartType,
		encodings: fit.encodings,
	});
	// One history entry: state advanced exactly once (currentHash changed once).
	assert.notStrictEqual(next.current, initialSpecState.current,
		'reducer must produce a new spec (single advance)');
	assert.notStrictEqual(next.currentHash, initialSpecState.currentHash,
		'specHash must change exactly once');
	return next;
}

function assertRequiredFilled(spec: QvizSpec, target: ChartType) {
	if (target === 'candlestick') {
		assert.ok(spec.chart.encodings.ohlcv,
			'candlestick: OHLCV cluster must be present');
		return;
	}
	const cfg = CHART_CHANNELS[target as Exclude<ChartType, 'candlestick'>];
	for (const ch of cfg.required) {
		assert.ok(
			(spec.chart.encodings as Record<string, unknown>)[ch] !== undefined,
			`${target}: required channel '${ch}' must be filled after fit`,
		);
	}
}

function assertValidatorPasses(spec: QvizSpec) {
	const result = validateSpec(spec);
	assert.strictEqual(result.ok, true,
		`spec failed validation: ${result.ok ? '' : (result as { issues: readonly Issue[] }).issues.map(i => i.message).join('; ')}`);
}

// ---------------------------------------------------------------------------
// Per-chart tests
// ---------------------------------------------------------------------------

suite('fitChartTypeTransition -- per-chart contract', () => {

	// Common starting point: a complete `line` spec on date × close.
	function lineStart(): QvizSpec {
		return makeSpec('timeseries', 'line', {
			x: { field: 'date', type: 'temporal' },
			y: { field: 'close', type: 'quantitative' },
		});
	}

	test('line → line: identity transition (no fill, reducer short-circuits)', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'line', 'timeseries');
		assert.deepStrictEqual(fit.filledChannels, []);
		// Reducer is a no-op on equal target.
		const initialSpecState = {
			...INITIAL_SPEC_STATE,
			current: start,
			currentHash: 'sha256:' + 'b'.repeat(64),
			lastSavedHash: 'sha256:' + 'b'.repeat(64),
		};
		const next = reduceSpec(initialSpecState, {
			type: 'applyChartTypeWithFit',
			family: fit.family,
			chartType: fit.chartType,
			encodings: fit.encodings,
		});
		// Identity-preserve when nothing changes.
		assert.strictEqual(next.current, initialSpecState.current);
	});

	test('line → area: preserves x, y; no new fill', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'area', 'timeseries');
		assert.deepStrictEqual(fit.filledChannels, []);
		assert.strictEqual(fit.encodings.x?.field, 'date');
		assert.strictEqual(fit.encodings.y?.field, 'close');
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'area');
		assertValidatorPasses(next.current!);
	});

	test('line → bar: preserves x, y (bar accepts both)', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'bar', 'timeseries');
		assert.deepStrictEqual(fit.filledChannels, []);
		assert.strictEqual(fit.encodings.x?.field, 'date');
		assert.strictEqual(fit.encodings.y?.field, 'close');
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'bar');
		assertValidatorPasses(next.current!);
	});

	test('line → histogram: preserves x, y; both required filled', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'histogram', 'timeseries');
		assert.deepStrictEqual(fit.filledChannels, []);
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'histogram');
		assertValidatorPasses(next.current!);
	});

	test('line → baseline: preserves x, y (baseline accepts both)', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'baseline', 'timeseries');
		assert.deepStrictEqual(fit.filledChannels, []);
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'baseline');
		assertValidatorPasses(next.current!);
	});

	test('line → scatter: preserves x, y (scatter accepts both)', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'scatter', 'general');
		assert.deepStrictEqual(fit.filledChannels, []);
		assert.strictEqual(fit.encodings.x?.field, 'date');
		assert.strictEqual(fit.encodings.y?.field, 'close');
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'scatter');
		assertValidatorPasses(next.current!);
	});

	test('line → heatmap: fills the new required `color` channel via Pattern B', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'heatmap', 'general');
		// x and y preserved; color is the NEW required channel.
		assert.ok(fit.filledChannels.includes('color'),
			`expected color to be auto-filled, got [${fit.filledChannels.join(', ')}]`);
		assert.strictEqual(fit.encodings.x?.field, 'date');
		assert.strictEqual(fit.encodings.y?.field, 'close');
		assert.ok(fit.encodings.color, 'color must be set');
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'heatmap');
		assertValidatorPasses(next.current!);
	});

	test('scatter → pie: preserves y, fills the new required `color` channel', () => {
		const start = makeSpec('general', 'scatter', {
			x: { field: 'open', type: 'quantitative' },
			y: { field: 'close', type: 'quantitative' },
		});
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'pie', 'general');
		// pie's required = [color, y]. y already filled (close);
		// scatter's x is dropped (pie doesn't allow x); color fills
		// with a nominal-preferred column.
		assert.strictEqual(fit.encodings.y?.field, 'close',
			'y preserved across scatter → pie');
		assert.ok(fit.encodings.color, 'pie color must be auto-filled');
		assert.ok(fit.filledChannels.includes('color'));
		// x is not in pie's channel list and is dropped.
		assert.strictEqual(fit.encodings.x, undefined);
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'pie');
		assertValidatorPasses(next.current!);
	});

	test('line → candlestick: detects OHLCV cluster from schema', () => {
		const start = lineStart();
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'candlestick', 'timeseries');
		assert.deepStrictEqual(fit.filledChannels, ['ohlcv']);
		assert.ok(fit.encodings.ohlcv, 'candlestick must auto-detect OHLCV');
		assert.strictEqual(fit.encodings.ohlcv?.time, 'date');
		assert.strictEqual(fit.encodings.ohlcv?.open, 'open');
		assert.strictEqual(fit.encodings.ohlcv?.high, 'high');
		assert.strictEqual(fit.encodings.ohlcv?.low, 'low');
		assert.strictEqual(fit.encodings.ohlcv?.close, 'close');
		assert.strictEqual(fit.encodings.ohlcv?.volume, 'volume');
		// candlestick drops x/y (not allowed in its channels).
		assert.strictEqual(fit.encodings.x, undefined);
		assert.strictEqual(fit.encodings.y, undefined);
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'candlestick');
		assertValidatorPasses(next.current!);
	});

});

suite('fitChartTypeTransition -- edge cases', () => {

	test('null schema: preserves compatible encodings, fills nothing', () => {
		// Daemon hasn't responded yet (schema not loaded). Picker
		// must not crash; legacy filter-only behavior must hold.
		const start = makeSpec('timeseries', 'line', {
			x: { field: 'date', type: 'temporal' },
			y: { field: 'close', type: 'quantitative' },
		});
		const fit = fitChartTypeTransition(null, start, 'heatmap', 'general');
		assert.deepStrictEqual(fit.filledChannels, []);
		// x, y preserved (allowed on heatmap); color empty (would
		// have been filled with schema).
		assert.strictEqual(fit.encodings.x?.field, 'date');
		assert.strictEqual(fit.encodings.y?.field, 'close');
		assert.strictEqual(fit.encodings.color, undefined);
	});

	test('candlestick → line: preserves nothing from OHLCV cluster, fills via schema', () => {
		// OHLCV → x,y. Schema-driven defaults pick date (temporal)
		// for x and the first quantitative column (open) for y.
		// Note: detectOhlcv path doesn't run on non-candlestick
		// targets, so OHLCV cluster is dropped.
		const start = makeSpec('timeseries', 'candlestick', {
			ohlcv: {
				time: 'date', open: 'open', high: 'high', low: 'low',
				close: 'close', volume: 'volume',
			},
		});
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'line', 'timeseries');
		assert.strictEqual(fit.encodings.x?.field, 'date',
			'temporal-preferred fill for x');
		assert.strictEqual(fit.encodings.x?.type, 'temporal');
		assert.strictEqual(fit.encodings.y?.type, 'quantitative');
		// y picks the first NON-USED quantitative column (open, since date is taken by x).
		assert.ok(['open', 'high', 'low', 'close', 'volume'].includes(fit.encodings.y!.field));
		assert.ok(fit.filledChannels.includes('x'));
		assert.ok(fit.filledChannels.includes('y'));
		const next = applyViaReducer(start, fit);
		assertRequiredFilled(next.current!, 'line');
		assertValidatorPasses(next.current!);
	});

	test('user-set encoding NOT overwritten when target preserves the channel', () => {
		const start = makeSpec('general', 'scatter', {
			x: { field: 'volume', type: 'quantitative' },  // user picked volume on x
			y: { field: 'close', type: 'quantitative' },
		});
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'line', 'timeseries');
		// line accepts x (any type) and y (quantitative). User's x and y
		// are preserved verbatim — the fitter does NOT replace x with
		// the temporal 'date' even though that would be the new default.
		assert.strictEqual(fit.encodings.x?.field, 'volume');
		assert.strictEqual(fit.encodings.y?.field, 'close');
		assert.deepStrictEqual(fit.filledChannels, []);
	});

	test('pie with NO quantitative column: y stays empty (Cycle 2 audit MEDIUM)', () => {
		// Schema has temporal + nominal only — no quantitative. Pie y
		// (theta/slice-angle) MUST stay empty rather than be filled
		// with a nominal column (which would render incoherently).
		const noQuantSchema: SchemaInfo = {
			...BTC_SCHEMA,
			columns: [
				{ name: 'date', dtype: 'timestamp[ns]', nullable: false },
				{ name: 'exchange', dtype: 'utf8', nullable: false },
				{ name: 'symbol', dtype: 'utf8', nullable: false },
			],
		};
		const start = makeSpec('general', 'scatter', {});
		const fit = fitChartTypeTransition(noQuantSchema, start, 'pie', 'general');
		// color fills with nominal (exchange), y stays empty.
		assert.ok(fit.encodings.color, 'color must fill from nominal');
		assert.strictEqual(fit.encodings.y, undefined,
			'pie y must stay empty when no quantitative column exists');
		assert.ok(!fit.filledChannels.includes('y'),
			'filledChannels must NOT include y when y was skipped');
	});

	test('histogram with NO quantitative column: y stays empty (Cycle 2 audit MEDIUM)', () => {
		const noQuantSchema: SchemaInfo = {
			...BTC_SCHEMA,
			columns: [
				{ name: 'date', dtype: 'timestamp[ns]', nullable: false },
				{ name: 'category', dtype: 'utf8', nullable: false },
			],
		};
		const start = makeSpec('general', 'scatter', {});
		const fit = fitChartTypeTransition(noQuantSchema, start, 'histogram', 'timeseries');
		assert.strictEqual(fit.encodings.y, undefined,
			'histogram y (count axis) must stay empty without a quantitative column');
	});

	test('pie WITH quantitative column: y fills with quantitative (regression check)', () => {
		const start = makeSpec('general', 'scatter', {});
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'pie', 'general');
		assert.ok(fit.encodings.y, 'pie y must fill when quant is available');
		assert.strictEqual(fit.encodings.y!.type, 'quantitative');
	});

	test('column de-dup: fitter never assigns the same column to two channels', () => {
		// Empty starting encodings → heatmap requires x, y, color.
		// All three must be different columns.
		const start = makeSpec('general', 'scatter', {});
		const fit = fitChartTypeTransition(BTC_SCHEMA, start, 'heatmap', 'general');
		const fields = new Set<string>();
		for (const ch of ['x', 'y', 'color'] as const) {
			const enc = fit.encodings[ch];
			if (enc) {
				assert.ok(!fields.has(enc.field),
					`channel ${ch} reused field '${enc.field}' — fitter must dedupe`);
				fields.add(enc.field);
			}
		}
	});

});
