/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { resetDom } from '../../test/helpers/jsdom-shim';
import { createOhlcLegend } from '../../webview/chart/ohlcLegend';
import { formatCompactVolume, formatPrice } from '../../webview/chart/formatters';
import type { OhlcvBar } from '../../webview/chart/chartApi';

const BARS: OhlcvBar[] = [
	{ t: 1000, o: 100, h: 105, l: 99, c: 104, v: 12_345_678 },
	{ t: 2000, o: 104, h: 106, l: 101, c: 102, v: 9_876_543 },
	{ t: 3000, o: 102, h: 110, l: 102, c: 109.5, v: 22_000_000 },
];

suite('chart OHLC legend (W4.1)', () => {
	setup(() => {
		resetDom();
	});

	function text(root: HTMLElement, selector: string): string {
		return (root.querySelector(selector) as HTMLElement | null)?.textContent ?? '';
	}

	test('hidden until both symbol and bars are present', () => {
		const legend = createOhlcLegend();
		assert.ok(!legend.root.classList.contains('show'));
		legend.setSymbol('AAPL');
		assert.ok(!legend.root.classList.contains('show'), 'no bars yet');
		legend.setBars(BARS);
		assert.ok(legend.root.classList.contains('show'));
	});

	test('falls back to the LAST bar when no crosshair index', () => {
		const legend = createOhlcLegend();
		legend.setSymbol('AAPL');
		legend.setBars(BARS);

		assert.strictEqual(text(legend.root, '.ol-symbol'), 'AAPL');
		const values = Array.from(legend.root.querySelectorAll('.ol-value')).map(el => el.textContent);
		assert.deepStrictEqual(values, ['102.00', '110.00', '102.00', '109.50', formatCompactVolume(22_000_000)]);
		assert.ok(legend.root.classList.contains('up'), 'c >= o = up');
		// Change vs previous close: 109.5 - 102 = +7.50 (+7.35%).
		assert.strictEqual(text(legend.root, '.ol-change'), '+7.50 (+7.35%)');
	});

	test('showBar tracks the crosshair index and colors by bar direction', () => {
		const legend = createOhlcLegend();
		legend.setSymbol('AAPL');
		legend.setBars(BARS);

		legend.showBar(1); // o=104 c=102 -> down bar
		assert.ok(legend.root.classList.contains('down'));
		assert.ok(!legend.root.classList.contains('up'));
		const values = Array.from(legend.root.querySelectorAll('.ol-value')).map(el => el.textContent);
		assert.deepStrictEqual(values, ['104.00', '106.00', '101.00', '102.00', formatCompactVolume(9_876_543)]);

		legend.showBar(null); // pointer left -> last bar again
		assert.strictEqual(text(legend.root, '.ol-change'), '+7.50 (+7.35%)');
	});

	test('first bar has no previous close -- change hidden', () => {
		const legend = createOhlcLegend();
		legend.setSymbol('AAPL');
		legend.setBars(BARS);
		legend.showBar(0);
		const change = legend.root.querySelector('.ol-change') as HTMLElement;
		assert.strictEqual(change.style.display, 'none');
	});

	test('clearing the symbol hides the legend', () => {
		const legend = createOhlcLegend();
		legend.setSymbol('AAPL');
		legend.setBars(BARS);
		legend.setSymbol(undefined);
		assert.ok(!legend.root.classList.contains('show'));
	});

	test('formatters: shared precision and compact volume', () => {
		assert.strictEqual(formatPrice(1234.5), '1,234.50');
		assert.strictEqual(formatPrice(0.12345), '0.1235');
		assert.strictEqual(formatCompactVolume(950), '950');
		assert.strictEqual(formatCompactVolume(12_345), '12.3K');
		assert.strictEqual(formatCompactVolume(12_345_678), '12.3M');
		assert.strictEqual(formatCompactVolume(1_234_567_890), '1.2B');
	});
});
