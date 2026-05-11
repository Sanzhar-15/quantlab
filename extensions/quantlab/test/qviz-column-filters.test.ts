/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for columnFilters -- Phase 9 step B.
 *
 * Phase 6 added popup filter widgets to the inspector header cells (range
 * slider for numeric/temporal, contains text for high-cardinality strings,
 * checkbox set for low-cardinality nominal). The Phase 6 megaudit cure
 * tightened the popup ARIA / focus / position story (M-K cleanup leak,
 * Tier-6 role="group", viewport-clamp + flip-above, glyph + aria-pressed
 * for active filter, Esc-to-close). Phase 9 jsdom coverage hits those
 * invariants directly:
 *
 *   - Chip button renders with default glyph, aria-haspopup, aria-pressed=false.
 *   - Active filter switches the glyph to "⏷•" and aria-pressed=true.
 *   - Clicking the chip opens a popup; clicking again closes it.
 *   - Popup has role="group" and aria-label; not role="dialog".
 *   - First-open dispatches `columnStatsRequested` so the spinner state
 *     fires and a second open doesn't re-request.
 *   - Esc inside the popup closes it (test fakes a stats-ready cache so
 *     the popup body renders).
 *   - dispose() tears everything down and removes the chip.
 */

// DOM globals installed by `out/test/helpers/mocha-setup.js` via mocha --require.
import { resetDom } from './helpers/jsdom-shim';

import * as assert from 'assert';

import { mountColumnFilter } from '../webview/qviz/components/columnFilters';
import { createStore } from '../webview/qviz/state/store';
import type { ColumnStats } from '../src/qviz/messageProtocol';

interface PostedMessage { type: string; column?: string; protocolVersion?: number; requestId?: number; }

function mkRoot(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

function fakeVscode(): {
	posted: PostedMessage[];
	bridge: { postMessage(value: unknown): void };
} {
	const posted: PostedMessage[] = [];
	return {
		posted,
		bridge: { postMessage(value: unknown): void { posted.push(value as PostedMessage); } },
	};
}

const NUMERIC_STATS: ColumnStats = {
	kind: 'numeric',
	cardinality: 100,
	cardinalityIsExact: false,
	nullCount: 0,
	total: 1000,
	min: 0,
	max: 100,
};

const SET_STATS: ColumnStats = {
	kind: 'nominal',
	cardinality: 3,
	cardinalityIsExact: true,
	nullCount: 0,
	total: 100,
	distinct: ['A', 'B', 'C'],
};

suite('columnFilters -- Phase 9 jsdom coverage', () => {
	setup(() => { resetDom(); });

	test('chip button installed with default glyph + aria-pressed=false', () => {
		const root = mkRoot();
		const store = createStore();
		const { bridge } = fakeVscode();
		const handle = mountColumnFilter(root, 'price', store, { vscode: bridge });

		const btn = root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!;
		assert.ok(btn, 'filter chip should be inserted');
		assert.strictEqual(btn.textContent, '⏷', 'default glyph');
		assert.strictEqual(btn.getAttribute('aria-pressed'), 'false');
		assert.strictEqual(btn.getAttribute('aria-haspopup'), 'true');
		assert.strictEqual(btn.getAttribute('aria-label'), 'Filter column price');

		handle.dispose();
		assert.strictEqual(root.querySelector('.qviz-col-filter-btn'), null,
			'dispose should remove the chip');
	});

	test('setting an active filter switches glyph to ⏷• and aria-pressed=true', () => {
		const root = mkRoot();
		const store = createStore();
		const { bridge } = fakeVscode();
		mountColumnFilter(root, 'price', store, { vscode: bridge });

		store.dispatch({
			type: 'setColumnFilter',
			column: 'price',
			filter: { kind: 'range', column: 'price', min: 0, max: 50 },
		});

		const btn = root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!;
		assert.strictEqual(btn.textContent, '⏷•',
			'glyph should change to active form (megaudit Tier-6 cure)');
		assert.strictEqual(btn.getAttribute('aria-pressed'), 'true');
		assert.strictEqual(btn.getAttribute('aria-label'), 'Filter column price (active)');

		store.dispatch({ type: 'setColumnFilter', column: 'price', filter: null });
		assert.strictEqual(btn.textContent, '⏷',
			'glyph reverts when filter is cleared');
		assert.strictEqual(btn.getAttribute('aria-pressed'), 'false');
	});

	test('clicking the chip toggles a popup with role=group (NOT role=dialog)', () => {
		const root = mkRoot();
		const store = createStore();
		const { bridge } = fakeVscode();
		mountColumnFilter(root, 'price', store, { vscode: bridge });
		const btn = root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!;

		assert.strictEqual(document.querySelector('.qviz-col-filter-popup'), null,
			'popup absent before click');

		btn.click();
		const popup = document.querySelector<HTMLElement>('.qviz-col-filter-popup')!;
		assert.ok(popup, 'popup should appear after click');

		// Megaudit Codex MINOR cure: role is "group" not "dialog".
		assert.strictEqual(popup.getAttribute('role'), 'group',
			'popup should use role=group (not dialog) -- megaudit MINOR cure');
		assert.strictEqual(popup.getAttribute('aria-label'), 'Filter price');
		assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');

		btn.click();
		assert.strictEqual(document.querySelector('.qviz-col-filter-popup'), null,
			'second click closes popup');
		assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
	});

	test('first popup open dispatches columnStatsRequested + posts requestColumnStats', () => {
		const root = mkRoot();
		const store = createStore();
		const { posted, bridge } = fakeVscode();
		mountColumnFilter(root, 'price', store, { vscode: bridge });
		const btn = root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!;

		btn.click();
		assert.strictEqual(
			store.getState().inspector.statsCache.price?.status, 'pending',
			'stats cache should mark "price" as pending on first open',
		);
		assert.strictEqual(posted.length, 1, 'one postMessage on first open');
		assert.strictEqual(posted[0].type, 'requestColumnStats');
		assert.strictEqual(posted[0].column, 'price');

		// Close and reopen -- should NOT refetch (entry is pending).
		btn.click(); // close
		btn.click(); // reopen
		assert.strictEqual(posted.length, 1,
			'reopening while stats are still pending should not refetch');
	});

	test('popup shows loading placeholder until stats arrive', () => {
		const root = mkRoot();
		const store = createStore();
		const { bridge } = fakeVscode();
		mountColumnFilter(root, 'price', store, { vscode: bridge });
		root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!.click();

		const popup1 = document.querySelector<HTMLElement>('.qviz-col-filter-popup')!;
		assert.ok(
			popup1.querySelector('.qviz-col-filter-loading'),
			'popup should show loading placeholder while stats pending',
		);

		store.dispatch({
			type: 'columnStatsReceived', column: 'price', stats: NUMERIC_STATS,
		});

		// Loading placeholder gone; range UI rendered.
		const popup2 = document.querySelector<HTMLElement>('.qviz-col-filter-popup')!;
		assert.strictEqual(
			popup2.querySelector('.qviz-col-filter-loading'), null,
			'loading placeholder removed once stats arrive',
		);
		assert.ok(
			popup2.querySelector('.qviz-col-filter-range'),
			'numeric stats should yield range-slider widget',
		);
	});

	test('low-cardinality nominal stats render a checkbox set widget', () => {
		const root = mkRoot();
		const store = createStore();
		const { bridge } = fakeVscode();
		mountColumnFilter(root, 'sym', store, { vscode: bridge });
		root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!.click();
		store.dispatch({
			type: 'columnStatsReceived', column: 'sym', stats: SET_STATS,
		});

		const popup = document.querySelector<HTMLElement>('.qviz-col-filter-popup')!;
		assert.ok(popup.querySelector('.qviz-col-filter-set'),
			'set stats should yield checkbox-set widget');
		const checkboxes = popup.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		assert.strictEqual(checkboxes.length, 3,
			'three distinct values → three checkboxes');
	});

	test('dispose() removes the chip and any open popup', () => {
		const root = mkRoot();
		const store = createStore();
		const { bridge } = fakeVscode();
		const handle = mountColumnFilter(root, 'price', store, { vscode: bridge });
		root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!.click();
		assert.ok(document.querySelector('.qviz-col-filter-popup'),
			'popup open before dispose');

		handle.dispose();
		assert.strictEqual(root.querySelector('.qviz-col-filter-btn'), null,
			'chip removed by dispose');
		assert.strictEqual(document.querySelector('.qviz-col-filter-popup'), null,
			'open popup removed by dispose (M-K cure)');
	});

	test('clicking outside the popup closes it', () => {
		const root = mkRoot();
		const store = createStore();
		const { bridge } = fakeVscode();
		mountColumnFilter(root, 'price', store, { vscode: bridge });
		root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!.click();
		store.dispatch({
			type: 'columnStatsReceived', column: 'price', stats: NUMERIC_STATS,
		});

		assert.ok(document.querySelector('.qviz-col-filter-popup'),
			'popup is open');

		// Dispatch a mousedown outside the popup and outside the chip.
		const outside = document.createElement('div');
		document.body.appendChild(outside);
		const ev = new MouseEvent('mousedown', { bubbles: true });
		outside.dispatchEvent(ev);

		assert.strictEqual(document.querySelector('.qviz-col-filter-popup'), null,
			'mousedown outside should close the popup');
	});

	// Megaudit B-6 cure: Esc handler + focus restore on popup close.
	test('Esc inside the popup closes it and restores focus to the chip', () => {
		const root = mkRoot();
		const store = createStore();
		const bridge = { postMessage: () => undefined };
		const handle = mountColumnFilter(root, 'close', store, { vscode: bridge });
		const chip = root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!;
		chip.click();
		// Stub stats so the popup body renders.
		store.dispatch({
			type: 'columnStatsReceived', column: 'close',
			stats: NUMERIC_STATS,
		});

		const popup = document.querySelector<HTMLElement>('.qviz-col-filter-popup');
		assert.ok(popup, 'popup is open');

		// Dispatch Esc on the popup.
		popup!.dispatchEvent(new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', {
			key: 'Escape', bubbles: true,
		}));

		assert.strictEqual(document.querySelector('.qviz-col-filter-popup'), null,
			'Esc inside the popup must close it');
		// Focus restored to the chip.
		assert.strictEqual(document.activeElement, chip,
			'closing the popup must restore focus to the chip button');

		handle.dispose();
	});

	// Megaudit B-6 cure: range slider min/max inputs dispatch
	// setColumnFilter with the typed values.
	test('range widget min/max change dispatches setColumnFilter with typed values', () => {
		const root = mkRoot();
		const store = createStore();
		const bridge = { postMessage: () => undefined };
		const handle = mountColumnFilter(root, 'close', store, { vscode: bridge });
		const chip = root.querySelector<HTMLButtonElement>('.qviz-col-filter-btn')!;
		chip.click();
		store.dispatch({
			type: 'columnStatsReceived', column: 'close',
			stats: NUMERIC_STATS,
		});

		// Find the range widget. Both min and max use the same
		// `qviz-form-input` class on numeric inputs, ordered min-then-max
		// in the DOM (per columnFilters.ts:147-157).
		const popup = document.querySelector<HTMLElement>('.qviz-col-filter-popup');
		assert.ok(popup);
		const rangeWrap = popup!.querySelector<HTMLElement>('.qviz-col-filter-range');
		assert.ok(rangeWrap, 'numeric column must render the range widget');
		const inputs = Array.from(
			rangeWrap!.querySelectorAll<HTMLInputElement>('input.qviz-form-input'),
		);
		assert.strictEqual(inputs.length, 2,
			'numeric range widget must render exactly 2 inputs (min, max)');
		const minInput = inputs[0];

		// Set min to 25 and dispatch change.
		minInput.value = '25';
		minInput.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));

		// The store's filter for 'close' must be updated.
		const filter = store.getState().inspector.filters.close;
		assert.ok(filter, 'setColumnFilter must have populated the filter slot');
		assert.strictEqual(filter!.kind, 'range');
		if (filter!.kind === 'range') {
			assert.strictEqual(filter!.min, 25);
		}

		handle.dispose();
	});
});
