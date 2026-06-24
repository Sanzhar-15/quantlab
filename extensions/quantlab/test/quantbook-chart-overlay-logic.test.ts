/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave Q2a "basic charts from a selected range" -- tests for the vscode/DOM/renderer-FREE chart data core
// (chartDataLogic.ts): the QvizSpec + ColumnData a ChartObject's source range projects to. Covers:
//   - 2-column numeric range -> single-series spec (x = col0, y = col1; no colour encoding);
//   - header detection (top row has text + no number/boolean -> column names; a numeric/boolean top-row cell -> no header, A1 letters);
//   - single-column range -> a synthesised 1-based "Index" x + one series;
//   - >2 columns -> long-form multi-series (x repeated, `value`/`series` keys, a colour encoding), incl. WITH a header row;
//   - a header colliding with the synthetic `value`/`series` keys does not corrupt the ColumnData;
//   - x-axis type inference (all-numeric -> quantitative; any text -> nominal);
//   - blank / non-number Y cells -> null (the ColumnData null contract);
//   - the No-Fallbacks error returns: unsupported type, off-active-sheet source, activeSheet null;
//   - the data signature changes with data + type and is stable when nothing changed (the re-embed memo).
// The DOM/Vega-Lite embed lives in chartOverlay.ts (the ChartOverlayManager); this is the column maths.

import * as assert from 'assert';

import { buildChartData, ALLOWED_CHART_TYPES, type BuiltChart } from '../webview/sheets-webview/chartDataLogic';
import type { ChartJson, QuantbookCellValue } from '../src/quantbook/types';

// A tiny grid: keyed "row,col" -> computed value. Absent keys read as blank (undefined), like the snapshot.
type Grid = Map<string, QuantbookCellValue>;
function gridOf(cells: Record<string, QuantbookCellValue>): Grid {
	return new Map(Object.entries(cells));
}
function readerFor(grid: Grid): (row: number, col: number) => QuantbookCellValue | undefined {
	return (row, col) => grid.get(row + ',' + col);
}
function colLabel(col: number): string {
	// 0 -> "A", 25 -> "Z", 26 -> "AA" (enough for the small ranges under test).
	let n = col;
	let s = '';
	do {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return s;
}
const num = (value: number): QuantbookCellValue => ({ kind: 'number', value });
const text = (value: string): QuantbookCellValue => ({ kind: 'text', value });

// A ChartJson with sensible defaults; `over` sets the source rectangle (anchor sheet == source sheet == 0).
function chart(over: Partial<ChartJson> & { srcStartRow: number; srcStartCol: number; srcEndRow: number; srcEndCol: number }): ChartJson {
	return {
		id: 1,
		name: 'Chart 1',
		chartType: 'line',
		sheet: 0,
		anchorRow: 0,
		anchorCol: 5,
		widthPx: 480,
		heightPx: 300,
		srcSheet: 0,
		title: undefined,
		...over,
	};
}
function asBuilt(r: ReturnType<typeof buildChartData>): BuiltChart {
	if (!r.ok) {
		assert.fail('expected a built chart, got error: ' + r.error);
	}
	return r;
}

suite('Quantbook chart overlay data logic', () => {
	test('the engine/host chart-type whitelist is exactly line|bar|scatter', () => {
		assert.deepStrictEqual([...ALLOWED_CHART_TYPES].sort(), ['bar', 'line', 'scatter']);
	});

	test('2-column numeric range with a text header -> single-series spec, header names the columns', () => {
		// Month | Return ; three data rows.
		const grid = gridOf({
			'0,0': text('Month'), '0,1': text('Return'),
			'1,0': num(1), '1,1': num(0.1),
			'2,0': num(2), '2,1': num(0.2),
			'3,0': num(3), '3,1': num(0.3),
		});
		const built = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 3, srcEndCol: 1 }), 0, readerFor(grid), colLabel));
		assert.strictEqual(built.spec.chart.family, 'general');
		assert.strictEqual(built.spec.chart.type, 'line');
		assert.strictEqual(built.spec.chart.encodings.x?.field, 'Month');
		assert.strictEqual(built.spec.chart.encodings.y?.field, 'Return');
		assert.strictEqual(built.spec.chart.encodings.color, undefined, 'single series -> no colour encoding');
		// First row is the header, so the data is the 3 rows below it.
		assert.deepStrictEqual(Array.from(built.columns['Month'] as ArrayLike<number | null>), [1, 2, 3]);
		assert.deepStrictEqual(Array.from(built.columns['Return'] as ArrayLike<number | null>), [0.1, 0.2, 0.3]);
		assert.strictEqual(built.spec.chart.encodings.x?.type, 'quantitative');
	});

	test('a numeric top-row cell defeats header detection -> A1 column letters, all rows are data', () => {
		// No text in the top row -> not a header; columns named by their A1 letter (A, B).
		const grid = gridOf({
			'0,0': num(10), '0,1': num(100),
			'1,0': num(20), '1,1': num(200),
		});
		const built = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 1 }), 0, readerFor(grid), colLabel));
		assert.strictEqual(built.spec.chart.encodings.x?.field, 'A');
		assert.strictEqual(built.spec.chart.encodings.y?.field, 'B');
		assert.deepStrictEqual(Array.from(built.columns['A'] as ArrayLike<number | null>), [10, 20]);
		assert.deepStrictEqual(Array.from(built.columns['B'] as ArrayLike<number | null>), [100, 200]);
	});

	test('single-column range -> synthesised 1-based Index x + one series', () => {
		const grid = gridOf({ '0,0': num(5), '1,0': num(6), '2,0': num(7) });
		const built = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 2, srcEndCol: 0 }), 0, readerFor(grid), colLabel));
		assert.strictEqual(built.spec.chart.encodings.x?.field, 'Index');
		assert.strictEqual(built.spec.chart.encodings.x?.type, 'quantitative');
		assert.deepStrictEqual(Array.from(built.columns['Index'] as ArrayLike<number | null>), [1, 2, 3]);
		assert.strictEqual(built.spec.chart.encodings.y?.field, 'A');
		assert.deepStrictEqual(Array.from(built.columns['A'] as ArrayLike<number | null>), [5, 6, 7]);
	});

	test('>2 columns -> long-form multi-series with a colour encoding', () => {
		// x | s1 | s2 (no header -> A/B/C). 2 data rows x 2 series = 4 long rows.
		const grid = gridOf({
			'0,0': num(1), '0,1': num(10), '0,2': num(100),
			'1,0': num(2), '1,1': num(20), '1,2': num(200),
		});
		const built = asBuilt(buildChartData(chart({ chartType: 'bar', srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 2 }), 0, readerFor(grid), colLabel));
		const colorField = built.spec.chart.encodings.color?.field;
		const yField = built.spec.chart.encodings.y?.field;
		assert.ok(colorField !== undefined, 'multi-series -> a colour encoding');
		assert.strictEqual(built.spec.chart.encodings.x?.field, 'A');
		// x repeated per series: [1,2, 1,2]; values: [10,20, 100,200]; series: [B,B, C,C].
		assert.deepStrictEqual(Array.from(built.columns['A'] as ArrayLike<number | null>), [1, 2, 1, 2]);
		assert.deepStrictEqual(Array.from(built.columns[yField as string] as ArrayLike<number | null>), [10, 20, 100, 200]);
		assert.deepStrictEqual(Array.from(built.columns[colorField as string] as ArrayLike<string>), ['B', 'B', 'C', 'C']);
		assert.strictEqual(built.spec.chart.options?.show_legend, true);
	});

	test('>2 columns WITH a header row -> multi-series, header names label the series, data offset by 1', () => {
		// Date | A | B header, then 2 data rows. Pins the dataR0 = r0+1 offset in the long-form path.
		const grid = gridOf({
			'0,0': text('Date'), '0,1': text('Alpha'), '0,2': text('Beta'),
			'1,0': num(1), '1,1': num(10), '1,2': num(100),
			'2,0': num(2), '2,1': num(20), '2,2': num(200),
		});
		const built = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 2, srcEndCol: 2 }), 0, readerFor(grid), colLabel));
		assert.strictEqual(built.spec.chart.encodings.x?.field, 'Date');
		const colorField = built.spec.chart.encodings.color?.field as string;
		const yField = built.spec.chart.encodings.y?.field as string;
		// x repeated per series: [1,2, 1,2]; values: Alpha then Beta; series labels from the header.
		assert.deepStrictEqual(Array.from(built.columns['Date'] as ArrayLike<number | null>), [1, 2, 1, 2]);
		assert.deepStrictEqual(Array.from(built.columns[yField] as ArrayLike<number | null>), [10, 20, 100, 200]);
		assert.deepStrictEqual(Array.from(built.columns[colorField] as ArrayLike<string>), ['Alpha', 'Alpha', 'Beta', 'Beta']);
	});

	test('a header colliding with the synthetic value/series keys does not corrupt the ColumnData', () => {
		// Headers literally named "value" and "series" (the synthetic long-form keys). uniqueKey/nameFor must
		// keep the encoding fields pointing at the ACTUAL columns dict keys, never overwriting data.
		const grid = gridOf({
			'0,0': text('x'), '0,1': text('value'), '0,2': text('series'),
			'1,0': num(1), '1,1': num(10), '1,2': num(100),
			'2,0': num(2), '2,1': num(20), '2,2': num(200),
		});
		const built = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 2, srcEndCol: 2 }), 0, readerFor(grid), colLabel));
		const yField = built.spec.chart.encodings.y?.field as string;
		const colorField = built.spec.chart.encodings.color?.field as string;
		// Every encoding field must resolve to a real ColumnData key, and the three keys must be distinct.
		const keys = Object.keys(built.columns);
		assert.ok(keys.includes(built.spec.chart.encodings.x?.field as string));
		assert.ok(keys.includes(yField));
		assert.ok(keys.includes(colorField));
		assert.strictEqual(new Set([built.spec.chart.encodings.x?.field, yField, colorField]).size, 3, 'x/value/series keys are distinct');
		// The Y values are intact (not clobbered by the colliding header names) -- the key correctness property.
		assert.deepStrictEqual(Array.from(built.columns[yField] as ArrayLike<number | null>), [10, 20, 100, 200]);
		// The synthetic value/series KEYS were reserved first, so the colliding header TEXTS dedupe to
		// 'value (2)'/'series (2)' as the legend labels (cosmetic only; the values + keys are uncorrupted).
		assert.deepStrictEqual(Array.from(built.columns[colorField] as ArrayLike<string>), ['value (2)', 'value (2)', 'series (2)', 'series (2)']);
	});

	test('a boolean in the top row defeats header detection (treated as data, A1 letters)', () => {
		const grid = gridOf({
			'0,0': text('Flag'), '0,1': { kind: 'boolean', value: true },
			'1,0': text('a'), '1,1': num(1),
		});
		const built = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 1 }), 0, readerFor(grid), colLabel));
		// Top row has a boolean -> NOT a header -> A1 letters + both rows are data.
		assert.strictEqual(built.spec.chart.encodings.x?.field, 'A');
		assert.strictEqual(built.spec.chart.encodings.y?.field, 'B');
		assert.deepStrictEqual(Array.from(built.columns['A'] as ArrayLike<string>), ['Flag', 'a']);
	});

	test('non-numeric x column -> nominal x type; numeric x -> quantitative', () => {
		const nominalGrid = gridOf({
			'0,0': text('Jan'), '0,1': num(1),
			'1,0': text('Feb'), '1,1': num(2),
		});
		// Top row has text in col0 AND a number in col1 -> NOT a header; col0 is a nominal x.
		const nominal = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 1 }), 0, readerFor(nominalGrid), colLabel));
		assert.strictEqual(nominal.spec.chart.encodings.x?.type, 'nominal');
		assert.deepStrictEqual(Array.from(nominal.columns['A'] as ArrayLike<string>), ['Jan', 'Feb']);
	});

	test('blank / non-number Y cells become null (the ColumnData null contract)', () => {
		const grid = gridOf({
			'0,0': num(1), '0,1': num(10),
			'1,0': num(2), /* B2 blank */
			'2,0': num(3), '2,1': text('n/a'),
		});
		const built = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 2, srcEndCol: 1 }), 0, readerFor(grid), colLabel));
		assert.deepStrictEqual(Array.from(built.columns['B'] as ArrayLike<number | null>), [10, null, null]);
	});

	test('No-Fallbacks: unsupported type and off-active-sheet source return an error', () => {
		const grid = gridOf({ '0,0': num(1), '1,0': num(2) });
		const reader = readerFor(grid);
		assert.ok(!buildChartData(chart({ chartType: 'pie', srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 0 }), 0, reader, colLabel).ok);
		// Source sheet 0 but the active sheet is 1 -> not in this snapshot.
		assert.ok(!buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 0 }), 1, reader, colLabel).ok);
		// activeSheet null (before the first render) -> error rather than fabricated data.
		assert.ok(!buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 0 }), null, reader, colLabel).ok);
	});

	test('the re-embed signature is stable for identical data+type and changes when a value changes', () => {
		const g1 = gridOf({ '0,0': num(1), '0,1': num(10), '1,0': num(2), '1,1': num(20) });
		const a = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 1 }), 0, readerFor(g1), colLabel));
		const b = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 1 }), 0, readerFor(g1), colLabel));
		assert.strictEqual(a.sig, b.sig, 'identical data + type -> identical signature (skip re-embed)');
		const g2 = gridOf({ '0,0': num(1), '0,1': num(10), '1,0': num(2), '1,1': num(99) });
		const c = asBuilt(buildChartData(chart({ srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 1 }), 0, readerFor(g2), colLabel));
		assert.notStrictEqual(a.sig, c.sig, 'a changed value -> a changed signature (re-embed)');
		// And a type change re-embeds even with identical data.
		const d = asBuilt(buildChartData(chart({ chartType: 'scatter', srcStartRow: 0, srcStartCol: 0, srcEndRow: 1, srcEndCol: 1 }), 0, readerFor(g1), colLabel));
		assert.notStrictEqual(a.sig, d.sig, 'a changed chart type -> a changed signature');
	});
});
