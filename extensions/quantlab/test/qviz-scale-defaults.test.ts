/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 4 (2026-05-14): scale-default semantics for the Vega-Lite-backed
 * `general` renderer. Pure-function tests on `getDefaultScaleOptions` plus
 * end-to-end tests that the renderer applies the precedence
 *   (explicit chart.options.{x,y}_axis_zero  >  scaleDefaults default)
 * and that old saved specs render byte-identically when the user has set
 * explicit options.
 */

import * as assert from 'assert';
import { getDefaultScaleOptions } from '../src/qviz/scaleDefaults';
import type { QvizSpec } from '../src/qviz/spec';
import { compileGeneralPlan } from '../src/qviz/render/general';
import { compileTimeseriesPlan } from '../src/qviz/render/timeseries';
import { validate } from '../src/qviz/validate';
import type { ColumnData, QvizTheme, VegaLiteFieldDef } from '../src/qviz/render/types';

const TEST_THEME: QvizTheme = {
	background: '#101820',
	foreground: '#fff',
	grid: '#333',
	axisText: '#aaa',
	seriesPalette: ['#aabbcc', '#ddeeff'],
	upColor: '#26a69a',
	downColor: '#ef5350',
};

function makeSpec(partial: Partial<QvizSpec> & { chart: QvizSpec['chart'] }): QvizSpec {
	return {
		qviz_version: 1 as const,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		provenance: {
			generated_at: '2026-05-14T00:00:00Z',
			generator: 'test',
			query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
		...partial,
	};
}

function fieldScale(def: VegaLiteFieldDef | undefined): Record<string, unknown> | undefined {
	if (def === undefined) { return undefined; }
	return (def as unknown as { scale?: Record<string, unknown> }).scale;
}

suite('scaleDefaults -- pure-function semantics', () => {

	test('bar y-quantitative gets zero=true (Tufte: bars need zero baseline)', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('bar', 'y', 'quantitative'),
			{ zero: true },
		);
	});

	test('histogram y-quantitative (count axis) gets zero=true', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('histogram', 'y', 'quantitative'),
			{ zero: true },
		);
	});

	test('bar x is empty (numeric bins / nominal categories handle their own baseline)', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('bar', 'x', 'quantitative'),
			{},
		);
	});

	test('scatter x and y quantitative both get zero=false (auto-fit)', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('scatter', 'x', 'quantitative'),
			{ zero: false },
		);
		assert.deepStrictEqual(
			getDefaultScaleOptions('scatter', 'y', 'quantitative'),
			{ zero: false },
		);
	});

	test('line quantitative axes get zero=false (auto-fit to data range)', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('line', 'x', 'quantitative'),
			{ zero: false },
		);
		assert.deepStrictEqual(
			getDefaultScaleOptions('line', 'y', 'quantitative'),
			{ zero: false },
		);
	});

	test('area, baseline, heatmap quantitative axes get zero=false', () => {
		for (const type of ['area', 'baseline', 'heatmap'] as const) {
			assert.deepStrictEqual(
				getDefaultScaleOptions(type, 'y', 'quantitative'),
				{ zero: false },
				`${type} y default`,
			);
		}
	});

	test('temporal encodings get NO zero default — anchoring at Unix 0 squishes 2024 dates', () => {
		// This is the exact symptom Front 4 exists to prevent: the smoke
		// session showed scatter points cluster top-right because temporal
		// x was forced to include the year 1970.
		assert.deepStrictEqual(
			getDefaultScaleOptions('scatter', 'x', 'temporal'),
			{},
		);
		assert.deepStrictEqual(
			getDefaultScaleOptions('line', 'x', 'temporal'),
			{},
		);
	});

	test('nominal/ordinal axes get no zero default', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('bar', 'x', 'nominal'),
			{},
		);
		assert.deepStrictEqual(
			getDefaultScaleOptions('scatter', 'y', 'ordinal'),
			{},
		);
	});

	test('pie + candlestick return empty (no cartesian x/y)', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('pie', 'y', 'quantitative'),
			{},
		);
		assert.deepStrictEqual(
			getDefaultScaleOptions('candlestick', 'y', 'quantitative'),
			{},
		);
	});

	test('non-x/y/y2 channels return empty (color / size / shape / facets)', () => {
		assert.deepStrictEqual(
			getDefaultScaleOptions('scatter', 'color', 'quantitative'),
			{},
		);
		assert.deepStrictEqual(
			getDefaultScaleOptions('bar', 'size', 'quantitative'),
			{},
		);
		assert.deepStrictEqual(
			getDefaultScaleOptions('scatter', 'facet_row', 'nominal'),
			{},
		);
	});

});

suite('scaleDefaults -- renderer wiring', () => {

	test('scatter quantitative-x/y compiles to scale.zero=false on both axes', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = { a: [1, 2, 3], b: [10, 20, 30] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.x), { zero: false });
		assert.deepStrictEqual(fieldScale(enc.y), { zero: false });
	});

	test('bar quantitative-y compiles to scale.zero=true on y, no scale on x', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'cat', type: 'nominal' },
					y: { field: 'v', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = { cat: ['a', 'b', 'c'], v: [1, 2, 3] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.y), { zero: true });
		// Nominal x channel: no scale wrapper at all.
		assert.strictEqual(fieldScale(enc.x), undefined);
	});

	test('scatter on temporal-x: x has NO scale.zero (Unix-0 anti-symptom)', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = {
			t: [1_700_000_000_000, 1_700_100_000_000],
			v: [100, 200],
		};
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		// Temporal x: scaleDefaults returns {}, so no scale object at all.
		assert.strictEqual(fieldScale(enc.x), undefined);
		// y is quantitative scatter → zero=false.
		assert.deepStrictEqual(fieldScale(enc.y), { zero: false });
	});

	test('precedence: chart.options.y_axis_zero=true overrides scatter default of zero=false', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
				options: { y_axis_zero: true },
			},
		});
		const columns: ColumnData = { a: [1, 2], b: [10, 20] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		// User override wins on y; x still gets the default.
		assert.deepStrictEqual(fieldScale(enc.y), { zero: true });
		assert.deepStrictEqual(fieldScale(enc.x), { zero: false });
	});

	test('precedence: chart.options.x_axis_zero=true overrides bar default (which was empty on x)', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'binEdge', type: 'quantitative' },
					y: { field: 'count', type: 'quantitative' },
				},
				options: { x_axis_zero: true },
			},
		});
		const columns: ColumnData = { binEdge: [1, 2], count: [5, 7] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.x), { zero: true });
		assert.deepStrictEqual(fieldScale(enc.y), { zero: true });
	});

	test('precedence: chart.options.y_axis_zero=false overrides bar default of zero=true', () => {
		// Tufte canon aside: an explicit user opt-out must win. Otherwise
		// we are auto-mutating spec semantics (Codex constraint).
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'cat', type: 'nominal' },
					y: { field: 'v', type: 'quantitative' },
				},
				options: { y_axis_zero: false },
			},
		});
		const columns: ColumnData = { cat: ['a', 'b'], v: [1, 2] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.y), { zero: false });
	});

	test('encoding.scale=log SUPPRESSES default zero (Cycle 2 audit MEDIUM: log+zero is incoherent)', () => {
		// Per Vega-Lite: a log scale anchored at zero is mathematically
		// invalid (log(0) = -∞). The renderer used to combine
		// `{ type: 'log', zero: false }`, which Vega-Lite warned about
		// and dropped — visually fine, log-wise noisy. We now drop
		// `zero` from the default path when scale is log/pow. An
		// explicit `chart.options.y_axis_zero` STILL takes precedence
		// (user choice wins with a Vega-Lite warning) — see next test.
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative', scale: 'log' },
				},
			},
		});
		const columns: ColumnData = {
			t: [1, 2, 3],
			v: [1, 10, 100],
		};
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.y), { type: 'log' });
	});

	test('encoding.scale=log + explicit chart.options.y_axis_zero=true: user override still wins', () => {
		// Documented exception: explicit chart-option survives the
		// log/pow suppression. Vega-Lite warns; the user asked.
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative', scale: 'log' },
				},
				options: { y_axis_zero: true },
			},
		});
		const columns: ColumnData = { t: [1, 2], v: [1, 10] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.y), { type: 'log', zero: true });
	});

	test('quantitative heatmap x and y get scale.zero=false (Cycle 2 audit HIGH-2)', () => {
		// Heatmap renderer previously bypassed Front 4 defaults.
		// A quantitative-axis heatmap would cluster in a corner the
		// same way the smoke-session scatter did. Fixed by wiring
		// `resolveAxisZero` into `buildHeatmapEncoding`.
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'heatmap',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'c', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = { a: [1, 2], b: [3, 4], c: [5, 6] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as {
			x: VegaLiteFieldDef; y: VegaLiteFieldDef;
		};
		assert.deepStrictEqual(fieldScale(enc.x), { zero: false });
		assert.deepStrictEqual(fieldScale(enc.y), { zero: false });
	});

	test('heatmap chart.options.x_axis_zero=true overrides heatmap default', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'heatmap',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'c', type: 'quantitative' },
				},
				options: { x_axis_zero: true },
			},
		});
		const columns: ColumnData = { a: [1, 2], b: [3, 4], c: [5, 6] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.x), { zero: true });
		// y still gets the default.
		assert.deepStrictEqual(fieldScale(enc.y), { zero: false });
	});

	test('back-compat: nominal-y bar leaves y with no scale wrapper (no defaults for non-quantitative)', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'v', type: 'quantitative' },
					y: { field: 'cat', type: 'nominal' },
				},
			},
		});
		const columns: ColumnData = { v: [1, 2], cat: ['a', 'b'] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		// Nominal y: no scale.
		assert.strictEqual(fieldScale(enc.y), undefined);
		// Quantitative x on a bar: default is empty (the canon zeroes the
		// VALUE axis, not the category axis).
		assert.strictEqual(fieldScale(enc.x), undefined);
	});

	test('chart.options.x_axis_zero round-trips through the validator (Cycle 2 audit HIGH-1 Codex)', () => {
		// Front 4 added x_axis_zero to ChartOptions in spec.ts and
		// wired it into general.ts, but the validator's
		// parseChartOptions arm was forgotten. Without parsing, the
		// field is silently dropped on every save/load — user's
		// explicit override never survives. This test pins the fix.
		const spec = {
			qviz_version: 1,
			dataset: {
				uri: 'data/x.parquet',
				schema_hash: 'sha256:' + 'a'.repeat(64),
				mtime_ns: 1,
			},
			transforms: [],
			chart: {
				family: 'general' as const,
				type: 'scatter' as const,
				encodings: {
					x: { field: 'a', type: 'quantitative' as const },
					y: { field: 'b', type: 'quantitative' as const },
				},
				options: { x_axis_zero: true, y_axis_zero: false },
			},
			provenance: {
				generated_at: '2026-05-14T00:00:00Z',
				generator: 'test',
				query_hash: 'sha256:' + '0'.repeat(64),
				tool_versions: { qviz_schema: 1 },
			},
		};
		const result = validate(spec);
		assert.strictEqual(result.ok, true, 'spec must parse');
		if (!result.ok) { return; }
		assert.strictEqual(result.value.chart.options?.x_axis_zero, true,
			'x_axis_zero must survive the validator');
		assert.strictEqual(result.value.chart.options?.y_axis_zero, false);
	});

	test('back-compat: spec saved before Front 4 with no options renders SAME on quantitative scatter', () => {
		// This is the contract for saved specs: post-Front-4, an unchanged
		// scatter on quantitative x/y now emits zero=false (NEW behavior —
		// fixes the smoke-session top-right cluster). Old behavior was
		// Vega-Lite implicit zero=true. Document the migration in the test
		// so future debuggers know this changed deliberately.
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = { a: [1, 2], b: [3, 4] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const enc = plan.spec.encoding as { x: VegaLiteFieldDef; y: VegaLiteFieldDef };
		assert.deepStrictEqual(fieldScale(enc.x), { zero: false });
		assert.deepStrictEqual(fieldScale(enc.y), { zero: false });
	});

});

suite('scaleDefaults -- timeseries renderer wiring (Cycle 2 audit HIGH-3)', () => {

	// The timeseries renderer historically only forwarded the explicit
	// `chart.options.y_axis_zero`. Cycle 2 wires per-chart-type defaults
	// so timeseries `bar`/`histogram` anchor at zero (Tufte canon)
	// without the user manually setting the option, and line/area/
	// baseline auto-fit by default.

	function tsSpec(chartType: 'line' | 'area' | 'bar' | 'histogram' | 'baseline', options?: { y_axis_zero?: boolean }) {
		return makeSpec({
			chart: {
				family: 'timeseries',
				type: chartType,
				encodings: {
					x: { field: 'date', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' },
				},
				...(options !== undefined ? { options } : {}),
			},
		});
	}
	const COLS: ColumnData = { date: [1, 2], v: [10, 20] };

	test('timeseries bar without options: yAxisZero=true by default', () => {
		const plan = compileTimeseriesPlan(tsSpec('bar'), COLS, TEST_THEME);
		assert.strictEqual(plan.chart.yAxisZero, true);
	});

	test('timeseries histogram without options: yAxisZero=true by default', () => {
		const plan = compileTimeseriesPlan(tsSpec('histogram'), COLS, TEST_THEME);
		assert.strictEqual(plan.chart.yAxisZero, true);
	});

	test('timeseries line without options: yAxisZero=false by default', () => {
		const plan = compileTimeseriesPlan(tsSpec('line'), COLS, TEST_THEME);
		assert.strictEqual(plan.chart.yAxisZero, false);
	});

	test('timeseries area without options: yAxisZero=false by default', () => {
		const plan = compileTimeseriesPlan(tsSpec('area'), COLS, TEST_THEME);
		assert.strictEqual(plan.chart.yAxisZero, false);
	});

	test('timeseries baseline without options: yAxisZero=false by default', () => {
		const plan = compileTimeseriesPlan(tsSpec('baseline'), COLS, TEST_THEME);
		assert.strictEqual(plan.chart.yAxisZero, false);
	});

	test('timeseries bar with explicit y_axis_zero=false: user override wins', () => {
		const plan = compileTimeseriesPlan(tsSpec('bar', { y_axis_zero: false }), COLS, TEST_THEME);
		assert.strictEqual(plan.chart.yAxisZero, false);
	});

	test('timeseries line with explicit y_axis_zero=true: user override wins', () => {
		const plan = compileTimeseriesPlan(tsSpec('line', { y_axis_zero: true }), COLS, TEST_THEME);
		assert.strictEqual(plan.chart.yAxisZero, true);
	});

});
