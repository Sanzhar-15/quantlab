/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { resetDom } from '../../test/helpers/jsdom-shim';
import { createMarketHeader } from '../../webview/chart/marketHeader';
import type { OhlcvBar } from '../../webview/chart/chartApi';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeBars(count: number, endT: number): OhlcvBar[] {
	const bars: OhlcvBar[] = [];
	for (let i = 0; i < count; i++) {
		const t = endT - (count - 1 - i) * DAY_MS;
		bars.push({ t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 + i });
	}
	return bars;
}

suite('chart marketHeader (data mode)', () => {
	let posted: unknown[] = [];

	setup(() => {
		resetDom();
		posted = [];
	});

	function build() {
		const header = createMarketHeader(message => posted.push(message));
		document.body.appendChild(header.root);
		return header;
	}

	function presetButton(header: ReturnType<typeof createMarketHeader>, label: string): HTMLButtonElement {
		const buttons = Array.from(header.root.querySelectorAll('.mh-preset')) as HTMLButtonElement[];
		const btn = buttons.find(b => b.textContent === label);
		assert.ok(btn, `preset button ${label} must exist`);
		return btn;
	}

	function activeLabels(header: ReturnType<typeof createMarketHeader>): string[] {
		return (Array.from(header.root.querySelectorAll('.mh-preset.active')) as HTMLButtonElement[])
			.map(b => b.textContent ?? '');
	}

	test('presets are disabled until bars arrive, enabled after', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.');
		assert.ok(presetButton(header, '1Y').disabled, 'disabled before bars');

		header.updateFromBars(makeBars(800, Date.UTC(2026, 3, 7)));
		assert.ok(!presetButton(header, '1Y').disabled, 'enabled after bars');
	});

	test('W4.4: no date-range override shows All as the active default preset', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.');
		header.updateFromBars(makeBars(800, Date.UTC(2026, 3, 7)));

		// The host echoes the toolbar with no override on first load.
		header.setRange(undefined);
		assert.deepStrictEqual(activeLabels(header), ['All'], 'All must be active by default');
	});

	test('preset click posts a last-bar-anchored range and stays active across the toolbar echo', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.');
		const endT = Date.UTC(2026, 3, 7);
		header.updateFromBars(makeBars(800, endT));

		presetButton(header, '1Y').click();

		assert.strictEqual(posted.length, 1);
		const message = posted[0] as { type: string; range?: { start: string; end: string } };
		assert.strictEqual(message.type, 'overrideDateRange');
		assert.ok(message.range, 'preset must post a concrete range');
		// Anchored to the LAST BAR (one day past it), not wall-clock now.
		assert.strictEqual(message.range.end, new Date(endT + DAY_MS).toISOString().slice(0, 10));
		assert.strictEqual(message.range.start, new Date(endT - 365 * DAY_MS).toISOString().slice(0, 10));
		assert.deepStrictEqual(activeLabels(header), ['1Y']);

		// Host writes the override and echoes it back via setToolbar.
		header.setRange(message.range);
		assert.deepStrictEqual(activeLabels(header), ['1Y'], '1Y must stay active after the echo');
	});

	test('a range the header did not post clears the active preset', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.');
		header.updateFromBars(makeBars(800, Date.UTC(2026, 3, 7)));

		header.setRange({ start: '2023-02-14', end: '2024-02-14' });
		assert.deepStrictEqual(activeLabels(header), [], 'custom range matches no preset');
	});

	test('All click clears the override and setRange(undefined) keeps it active', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.');
		header.updateFromBars(makeBars(800, Date.UTC(2026, 3, 7)));

		presetButton(header, 'All').click();
		const message = posted[0] as { type: string; range?: unknown };
		assert.strictEqual(message.type, 'overrideDateRange');
		assert.strictEqual(message.range, undefined, 'All clears the override');

		header.setRange(undefined);
		assert.deepStrictEqual(activeLabels(header), ['All']);
	});

	test('crypto sources hide the preset group entirely', () => {
		const header = build();
		header.setSource('BTC', 'Bitcoin', 'crypto');
		const group = header.root.querySelector('.mh-presets') as HTMLElement;
		assert.strictEqual(group.style.display, 'none');

		header.setSource('AAPL', 'Apple Inc.', 'equity');
		assert.notStrictEqual(group.style.display, 'none');
	});

	function tfButton(header: ReturnType<typeof createMarketHeader>, label: string): HTMLButtonElement {
		const buttons = Array.from(header.root.querySelectorAll('.mh-tf')) as HTMLButtonElement[];
		const btn = buttons.find(b => b.textContent === label);
		assert.ok(btn, `timeframe button ${label} must exist`);
		return btn;
	}

	function activeTfLabels(header: ReturnType<typeof createMarketHeader>): string[] {
		return (Array.from(header.root.querySelectorAll('.mh-tf.active')) as HTMLButtonElement[])
			.map(b => b.textContent ?? '');
	}

	test('M30: timeframe switcher renders exactly the server-supported intervals, default 1D active', () => {
		const header = build();
		const labels = (Array.from(header.root.querySelectorAll('.mh-tf')) as HTMLButtonElement[])
			.map(b => b.textContent ?? '');
		// LIVE SERVER TRUTH (2026-06-11): equities serve 1h/1D/1W/1M only.
		assert.deepStrictEqual(labels, ['1H', '1D', '1W', '1M']);
		assert.deepStrictEqual(activeTfLabels(header), ['1D'], '1D is the default interval');
	});

	test('M30: timeframe buttons are disabled until a source exists, enabled after', () => {
		const header = build();
		assert.ok(tfButton(header, '1H').disabled, 'disabled before a source');

		header.setSource('AAPL', 'Apple Inc.', 'equity');
		assert.ok(!tfButton(header, '1H').disabled, 'enabled once a symbol is set');

		header.setSource(undefined, undefined);
		assert.ok(tfButton(header, '1H').disabled, 'disabled again when the source clears');
	});

	test('M30: clicking an interval posts overrideTimeframe and the echo keeps it active', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.', 'equity');

		tfButton(header, '1H').click();

		assert.strictEqual(posted.length, 1);
		assert.deepStrictEqual(posted[0], { type: 'overrideTimeframe', timeframe: '1H' });
		assert.deepStrictEqual(activeTfLabels(header), ['1H'], 'optimistic highlight');

		// Host stores the override and echoes it back via setToolbar.
		header.setTimeframe('1H');
		assert.deepStrictEqual(activeTfLabels(header), ['1H'], '1H stays active after the echo');

		// Clicking the already-active interval must not re-post (no redundant reload).
		tfButton(header, '1H').click();
		assert.strictEqual(posted.length, 1, 'no duplicate post for the active interval');
	});

	test('M30: a timeframe click does not touch the date-range presets', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.', 'equity');
		const endT = Date.UTC(2026, 3, 7);
		header.updateFromBars(makeBars(800, endT));

		presetButton(header, '1Y').click();
		assert.deepStrictEqual(activeLabels(header), ['1Y']);

		tfButton(header, '1W').click();
		header.setTimeframe('1W');
		assert.deepStrictEqual(activeLabels(header), ['1Y'], 'range preset survives an interval switch');
		assert.deepStrictEqual(activeTfLabels(header), ['1W']);
	});

	test('M30: crypto hides 1W/1M intervals but keeps 1H/1D (while presets hide entirely)', () => {
		const header = build();
		header.setSource('BTC', 'Bitcoin', 'crypto');

		assert.ok(!tfButton(header, '1H').classList.contains('mh-preset-hidden'), '1H offered for crypto');
		assert.ok(!tfButton(header, '1D').classList.contains('mh-preset-hidden'), '1D offered for crypto');
		assert.ok(tfButton(header, '1W').classList.contains('mh-preset-hidden'), '1W hidden for crypto');
		assert.ok(tfButton(header, '1M').classList.contains('mh-preset-hidden'), '1M hidden for crypto');

		header.setSource('AAPL', 'Apple Inc.', 'equity');
		assert.ok(!tfButton(header, '1W').classList.contains('mh-preset-hidden'), '1W back for equities');
		assert.ok(!tfButton(header, '1M').classList.contains('mh-preset-hidden'), '1M back for equities');
	});

	test('M30: as-of meta shows the bar time on intraday intervals, date-only otherwise', () => {
		const HOUR_MS = 60 * 60 * 1000;
		const header = build();
		header.setSource('AAPL', 'Apple Inc.', 'equity');

		const endT = Date.UTC(2026, 3, 7, 15, 0, 0);
		const bars: ReturnType<typeof makeBars> = [];
		for (let i = 0; i < 10; i++) {
			const t = endT - (9 - i) * HOUR_MS;
			bars.push({ t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 + i });
		}

		header.setTimeframe('1H');
		header.updateFromBars(bars);

		const meta = header.root.querySelector('.mh-meta') as HTMLElement;
		assert.ok(meta.textContent?.startsWith('1H'), `meta names the interval: ${meta.textContent}`);
		assert.ok(/15:00 UTC$/.test(meta.textContent ?? ''), `intraday meta includes the bar time: ${meta.textContent}`);

		// Echoing a daily interval re-renders the meta date-only immediately.
		header.setTimeframe('1D');
		assert.ok(meta.textContent?.startsWith('1D'), `meta tracks the echo: ${meta.textContent}`);
		assert.ok(!/UTC$/.test(meta.textContent ?? ''), `daily meta is date-only: ${meta.textContent}`);
	});

	test('quote renders from the last bar with up/down change chip', () => {
		const header = build();
		header.setSource('AAPL', 'Apple Inc.');
		header.updateFromBars(makeBars(10, Date.UTC(2026, 3, 7)));

		const price = header.root.querySelector('.mh-price') as HTMLElement;
		const change = header.root.querySelector('.mh-change') as HTMLElement;
		assert.strictEqual(price.textContent, '109.50', 'last close, 2-decimal');
		assert.ok(change.classList.contains('up'), 'rising close = up chip');
		assert.ok(change.textContent?.includes('+1.00'), `delta rendered: ${change.textContent}`);
	});
});
