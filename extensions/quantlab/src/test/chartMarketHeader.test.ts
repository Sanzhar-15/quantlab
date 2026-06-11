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
