/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { QvizSpec } from '../src/qviz/spec';
import { compileTimeseriesPlan, CompilePlanError } from '../src/qviz/render/timeseries';
import type { CandlestickPlan, ColumnData, LinePlan, QvizTheme } from '../src/qviz/render/types';

const TEST_THEME: QvizTheme = {
	background: '#000',
	foreground: '#fff',
	grid: '#333',
	axisText: '#aaa',
	seriesPalette: ['#aabbcc', '#ddeeff'],
	upColor: '#26a69a',
	downColor: '#ef5350',
};

function makeSpec(partial: Partial<QvizSpec> & {
	chart: QvizSpec['chart'];
}): QvizSpec {
	return {
		qviz_version: 1 as const,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		provenance: {
			generated_at: '2026-04-29T00:00:00Z',
			generator: 'test',
			query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
		...partial,
	};
}

suite('compileTimeseriesPlan — line family', () => {

	test('compiles a basic line chart', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 'time', type: 'temporal' },
					y: { field: 'value', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = {
			time: [1000, 2000, 3000, 4000],
			value: [10, 20, 15, 25],
		};
		const plan = compileTimeseriesPlan(spec, columns, TEST_THEME);

		assert.strictEqual(plan.series.length, 1);
		const s = plan.series[0] as LinePlan;
		assert.strictEqual(s.kind, 'line');
		assert.deepStrictEqual(s.data, [
			{ t: 1000, v: 10 },
			{ t: 2000, v: 20 },
			{ t: 3000, v: 15 },
			{ t: 4000, v: 25 },
		]);
	});

	test('preserves null v values (gaps)', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 'time', type: 'temporal' },
					y: { field: 'value', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = {
			time: [1000, 2000, 3000],
			value: [10, null, 15],
		};
		const plan = compileTimeseriesPlan(spec, columns, TEST_THEME);
		const s = plan.series[0] as LinePlan;
		assert.strictEqual(s.data[1].v, null);
		assert.ok(plan.diagnostics.some(d => d.includes('1 of 3 rows have null')));
	});

	test('treats NaN/Infinity as null', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 'time', type: 'temporal' },
					y: { field: 'value', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = {
			time: [1000, 2000, 3000, 4000],
			value: [10, NaN, Infinity, -Infinity],
		};
		const plan = compileTimeseriesPlan(spec, columns, TEST_THEME);
		const s = plan.series[0] as LinePlan;
		assert.strictEqual(s.data[0].v, 10);
		assert.strictEqual(s.data[1].v, null);
		assert.strictEqual(s.data[2].v, null);
		assert.strictEqual(s.data[3].v, null);
	});

	test('rejects mismatched column lengths', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 'time', type: 'temporal' },
					y: { field: 'value', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = {
			time: [1, 2, 3],
			value: [1, 2],
		};
		assert.throws(
			() => compileTimeseriesPlan(spec, columns, TEST_THEME),
			(e: Error) => e instanceof CompilePlanError && /mismatched lengths/.test(e.message)
		);
	});

	test('rejects missing column reference', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 'time', type: 'temporal' },
					y: { field: 'ghost', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = { time: [1] };
		assert.throws(
			() => compileTimeseriesPlan(spec, columns, TEST_THEME),
			(e: Error) => e instanceof CompilePlanError && /'ghost'/.test(e.message)
		);
	});

	test('compiles area, bar, histogram, baseline using the same scalar path', () => {
		const columns: ColumnData = { t: [1, 2, 3], v: [10, 20, 30] };
		for (const type of ['area', 'bar', 'histogram', 'baseline'] as const) {
			const spec = makeSpec({
				chart: {
					family: 'timeseries',
					type,
					encodings: {
						x: { field: 't', type: 'temporal' },
						y: { field: 'v', type: 'quantitative' },
					},
				},
			});
			const plan = compileTimeseriesPlan(spec, columns, TEST_THEME);
			assert.strictEqual(plan.series.length, 1);
			assert.strictEqual(plan.series[0].kind, type);
			assert.strictEqual(plan.series[0].data.length, 3);
		}
	});

	test('uses palette[0] for default series color', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' },
				},
			},
		});
		const plan = compileTimeseriesPlan(
			spec,
			{ t: [1], v: [1] },
			TEST_THEME
		);
		const s = plan.series[0] as LinePlan;
		assert.strictEqual(s.color, '#aabbcc');
	});

});

suite('compileTimeseriesPlan — candlestick', () => {

	test('compiles OHLCV candlestick', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'candlestick',
				encodings: {
					ohlcv: {
						time: 'ts', open: 'o', high: 'h', low: 'l', close: 'c', volume: 'v',
					},
				},
			},
		});
		const columns: ColumnData = {
			ts: [1000, 2000, 3000],
			o: [10, 11, 12],
			h: [12, 13, 14],
			l: [9, 10, 11],
			c: [11, 12, 13],
			v: [100, 200, 300],
		};
		const plan = compileTimeseriesPlan(spec, columns, TEST_THEME);
		assert.strictEqual(plan.series.length, 1);
		const s = plan.series[0] as CandlestickPlan;
		assert.strictEqual(s.kind, 'candlestick');
		assert.strictEqual(s.data.length, 3);
		assert.deepStrictEqual(s.data[0], { t: 1000, o: 10, h: 12, l: 9, c: 11 });
	});

	test('drops candles violating OHLC invariants (h<l, o/c outside [l,h])', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'candlestick',
				encodings: {
					ohlcv: { time: 'ts', open: 'o', high: 'h', low: 'l', close: 'c' },
				},
			},
		});
		const columns: ColumnData = {
			ts: [1000, 2000, 3000, 4000, 5000],
			//      OK   h<l  o>h  c<l  OK
			o: [10, 11, 50, 12, 13],
			h: [12, 5, 20, 14, 15],
			l: [9, 8, 5, 11, 10],
			c: [11, 9, 19, 8, 14],
		};
		const plan = compileTimeseriesPlan(spec, columns, TEST_THEME);
		const s = plan.series[0] as CandlestickPlan;
		assert.strictEqual(s.data.length, 2, 'only 2 of 5 candles satisfy OHLC invariants');
		assert.ok(plan.diagnostics.some(d => /OHLC invariants/.test(d)));
	});

	test('drops candles with NaN or null OHLC', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'candlestick',
				encodings: {
					ohlcv: { time: 'ts', open: 'o', high: 'h', low: 'l', close: 'c' },
				},
			},
		});
		const columns: ColumnData = {
			ts: [1000, 2000, 3000],
			o: [10, NaN, 12],
			h: [12, 13, 14],
			l: [9, 10, 11],
			c: [11, 12, 13],
		};
		const plan = compileTimeseriesPlan(spec, columns, TEST_THEME);
		const s = plan.series[0] as CandlestickPlan;
		assert.strictEqual(s.data.length, 2);
		assert.ok(plan.diagnostics.some(d => /dropped 1 rows/.test(d)));
	});

	test('rejects candlestick without ohlcv encoding', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'candlestick',
				encodings: {},
			},
		});
		assert.throws(
			() => compileTimeseriesPlan(spec, {}, TEST_THEME),
			(e: Error) => e instanceof CompilePlanError && /requires encodings\.ohlcv/.test(e.message)
		);
	});

	test('emits LOUD diagnostic when ALL y values are null (audit #11)', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' },
				},
			},
		});
		const plan = compileTimeseriesPlan(
			spec,
			{ t: [1, 2, 3], v: [null, null, null] },
			TEST_THEME
		);
		assert.ok(
			plan.diagnostics.some(d => /ALL 3 rows are null/.test(d)),
			`expected loud all-null diagnostic, got: ${JSON.stringify(plan.diagnostics)}`
		);
	});

	test('rejects candlestick with mismatched column lengths', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'candlestick',
				encodings: {
					ohlcv: { time: 'ts', open: 'o', high: 'h', low: 'l', close: 'c' },
				},
			},
		});
		const columns: ColumnData = {
			ts: [1, 2], o: [1, 2], h: [1, 2], l: [1, 2], c: [1, 2, 3],
		};
		assert.throws(
			() => compileTimeseriesPlan(spec, columns, TEST_THEME),
			(e: Error) => /mismatched lengths/.test(e.message)
		);
	});

});

suite('compileTimeseriesPlan — chart options', () => {

	test('threads timezone from trading_options into chart options', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' },
				},
			},
			trading_options: {
				timezone: 'America/New_York',
				session: 'regular',
			},
		});
		const plan = compileTimeseriesPlan(spec, { t: [1], v: [1] }, TEST_THEME);
		assert.strictEqual(plan.chart.timezone, 'America/New_York');
	});

	test('respects show_grid option', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' },
				},
				options: { show_grid: false },
			},
		});
		const plan = compileTimeseriesPlan(spec, { t: [1], v: [1] }, TEST_THEME);
		assert.strictEqual(plan.chart.showGrid, false);
	});

	test('attaches the theme to chart options', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'v', type: 'quantitative' },
				},
			},
		});
		const plan = compileTimeseriesPlan(spec, { t: [1], v: [1] }, TEST_THEME);
		assert.strictEqual(plan.chart.theme, TEST_THEME);
	});

});

suite('compileTimeseriesPlan — error gates', () => {

	test('rejects general family', () => {
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
		assert.throws(
			() => compileTimeseriesPlan(spec, { t: [1], v: [1] }, TEST_THEME),
			(e: Error) => /family='timeseries'/.test(e.message)
		);
	});

	test('rejects scatter chart type (general family only)', () => {
		const spec = {
			...makeSpec({
				chart: {
					family: 'timeseries',
					type: 'line',
					encodings: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } },
				},
			}),
			chart: {
				family: 'timeseries' as const,
				// Cast: validator would reject this at parse time, but the
				// compileToPlan layer is defensive against it too.
				type: 'scatter' as const,
				encodings: {
					x: { field: 't' as const, type: 'quantitative' as const },
					y: { field: 'v' as const, type: 'quantitative' as const },
				},
			},
		};
		assert.throws(
			() => compileTimeseriesPlan(spec as unknown as QvizSpec, { t: [1], v: [1] }, TEST_THEME),
			(e: Error) => /not supported by timeseries renderer/.test(e.message)
		);
	});

});
