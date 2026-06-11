/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { resetDom } from '../../test/helpers/jsdom-shim';
import { createMessageHandler } from '../../webview/chart/messageHandler';
import type { ChartClient, OhlcvBar, SignalPoint } from '../../webview/chart/chartApi';
import type { ParameterPanel } from '../../webview/chart/parameterPanel';

interface Recorded {
	setDataBars: OhlcvBar[][];
	addedSignals: SignalPoint[];
	watermarks: Array<string | null>;
	timeframes: string[];
}

function encodeBars(bars: OhlcvBar[]): ArrayBuffer {
	const view = new Float64Array(bars.length * 6);
	bars.forEach((bar, i) => {
		view[i * 6] = bar.t;
		view[i * 6 + 1] = bar.o;
		view[i * 6 + 2] = bar.h;
		view[i * 6 + 3] = bar.l;
		view[i * 6 + 4] = bar.c;
		view[i * 6 + 5] = bar.v ?? 0;
	});
	return view.buffer;
}

const BARS: OhlcvBar[] = [
	{ t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
	{ t: 2000, o: 1.5, h: 3, l: 1, c: 2.5, v: 20 },
];

const SAFE_COMPLEXITY = { level: 'safe' as const, score: 0, reasons: [] };

function dataToolbar(overrides: Record<string, unknown> = {}) {
	return {
		dataSource: { kind: 'server', symbol: 'AAPL', displayName: 'Apple Inc.' },
		timeframe: '1D',
		complexity: SAFE_COMPLEXITY,
		hasVisualization: false,
		viewOnly: false,
		mode: 'data',
		...overrides
	};
}

suite('chart messageHandler: loading / empty / addSignal (H15+H17)', () => {
	let recorded: Recorded;
	let setRanges: Array<{ start: string; end: string } | undefined>;
	let headerTimeframes: Array<string | undefined>;
	let legendSymbols: Array<string | undefined>;
	let legendBars: OhlcvBar[][];
	let handler: (message: unknown) => void;
	let loading: HTMLElement;
	let emptyState: HTMLElement;
	let errorOverlay: HTMLElement;
	let noViz: HTMLElement;

	setup(() => {
		resetDom();
		recorded = { setDataBars: [], addedSignals: [], watermarks: [], timeframes: [] };
		setRanges = [];
		headerTimeframes = [];
		legendSymbols = [];
		legendBars = [];

		const fakeChart = {
			initialize: async () => { /* no-op */ },
			setData: async (bars: OhlcvBar[]) => { recorded.setDataBars.push(bars); },
			addSignal: async (signal: SignalPoint) => { recorded.addedSignals.push(signal); },
			setWatermark: (text: string | null) => { recorded.watermarks.push(text); },
			setTimeframe: (tf: string) => { recorded.timeframes.push(tf); },
			setSignals: async () => { /* no-op */ },
			setEquityCurve: async () => { /* no-op */ },
			applyVisualization: async () => { /* no-op */ },
			setTradeOrders: async () => { /* no-op */ },
			setTradePositions: async () => { /* no-op */ },
			setTradeFills: async () => { /* no-op */ },
			clearTradeOverlays: () => { /* no-op */ },
			setTheme: () => { /* no-op */ }
		} as unknown as ChartClient;

		const fakeParameterPanel = {
			render: () => { /* no-op */ },
			setOverrides: () => { /* no-op */ }
		} as unknown as ParameterPanel;

		loading = document.createElement('div');
		emptyState = document.createElement('div');
		errorOverlay = document.createElement('div');
		noViz = document.createElement('div');
		const errorMessage = document.createElement('div');
		const errorActions = document.createElement('div');

		handler = createMessageHandler({
			postMessage: () => { /* no-op */ },
			chart: fakeChart,
			parameterPanel: fakeParameterPanel,
			banner: document.createElement('div'),
			noViz,
			applyMode: () => { /* no-op */ },
			marketHeader: {
				setSource: () => { /* no-op */ },
				setTimeframe: timeframe => headerTimeframes.push(timeframe),
				updateFromBars: () => { /* no-op */ },
				setRange: range => setRanges.push(range)
			},
			legend: {
				setSymbol: symbol => legendSymbols.push(symbol),
				setBars: bars => legendBars.push(bars)
			},
			loading,
			emptyState,
			toolbar: {
				dataSourceButton: document.createElement('button'),
				dataSourceDropdown: document.createElement('div'),
				timeframeLabel: document.createElement('span'),
				dateStart: document.createElement('input'),
				dateEnd: document.createElement('input'),
				complexity: document.createElement('div')
			},
			panelRoot: document.createElement('div'),
			errorOverlay,
			errorMessage,
			errorActions
		});
	});

	const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

	test('showLoading -> setDataBinary resolves the pill into data (no infinite spinner)', async () => {
		handler({ type: 'showLoading', requestId: 1 });
		assert.ok(loading.classList.contains('show'), 'pill armed');

		handler({ type: 'setDataBinary', requestId: 1, buffer: encodeBars(BARS), count: BARS.length });
		await flush();

		assert.ok(!loading.classList.contains('show'), 'pill cleared by data');
		assert.strictEqual(recorded.setDataBars.length, 1);
		assert.strictEqual(recorded.setDataBars[0].length, 2);
		assert.strictEqual(legendBars.length, 1, 'legend received the decoded bars');
		assert.strictEqual(legendBars[0][1].c, 2.5);
	});

	test('showLoading -> showError resolves the pill into the error overlay', async () => {
		handler({ type: 'showLoading', requestId: 1 });
		handler({ type: 'showError', message: 'Unable to load data from server.', actions: ['reload'] });
		await flush();

		assert.ok(!loading.classList.contains('show'), 'pill cleared by error');
		assert.ok(errorOverlay.classList.contains('show'), 'error overlay shown');
	});

	test('stale showLoading (older than rendered data) is ignored', async () => {
		handler({ type: 'setDataBinary', requestId: 5, buffer: encodeBars(BARS), count: BARS.length });
		await flush();
		handler({ type: 'showLoading', requestId: 3 });
		assert.ok(!loading.classList.contains('show'), 'stale pill must not arm');
	});

	test('showEmptyState shows the get-started placeholder and clears on next load', async () => {
		handler({ type: 'showEmptyState' });
		assert.ok(emptyState.classList.contains('show'));
		assert.ok(!loading.classList.contains('show'));

		handler({ type: 'showLoading', requestId: 1 });
		assert.ok(!emptyState.classList.contains('show'), 'loading hides the placeholder');
	});

	test('H15: addSignal routes the live fill into the chart marker pipeline', async () => {
		handler({ type: 'addSignal', signal: { t: 1234, type: 'entry', label: 'BUY 5 @ 1.5', price: 1.5 } });
		await flush();
		assert.strictEqual(recorded.addedSignals.length, 1);
		assert.strictEqual(recorded.addedSignals[0].label, 'BUY 5 @ 1.5');

		// Malformed payloads are dropped, not crashed on.
		handler({ type: 'addSignal', signal: { type: 'entry' } });
		await flush();
		assert.strictEqual(recorded.addedSignals.length, 1);
	});

	test('M32: the noViz bar yields to the error overlay and returns when it clears', async () => {
		// A strategy tab without visualize(): the noViz prompt shows.
		handler({ type: 'setToolbar', toolbar: dataToolbar({ mode: 'strategy', hasVisualization: false }) });
		assert.ok(noViz.classList.contains('show'), 'noViz shows on a viz-less strategy tab');

		// An error overlay supersedes it -- the two must not stack.
		handler({ type: 'showError', message: 'Visualization failed to render.', actions: ['editVisualization'] });
		assert.ok(errorOverlay.classList.contains('show'), 'error overlay shown');
		assert.ok(!noViz.classList.contains('show'), 'noViz hidden while the error overlay is up');

		// A toolbar refresh while the error is still up must NOT re-show it.
		handler({ type: 'setToolbar', toolbar: dataToolbar({ mode: 'strategy', hasVisualization: false }) });
		assert.ok(!noViz.classList.contains('show'), 'toolbar refresh does not re-stack noViz over the error');

		// Clearing the error restores the toolbar-desired state.
		handler({ type: 'showError', message: '' });
		assert.ok(!errorOverlay.classList.contains('show'), 'error cleared');
		assert.ok(noViz.classList.contains('show'), 'noViz returns after the error clears');

		// Data resolves the error path too (clearError runs in setDataBinary).
		handler({ type: 'showError', message: 'boom' });
		handler({ type: 'setDataBinary', requestId: 9, buffer: encodeBars(BARS), count: BARS.length });
		await flush();
		assert.ok(noViz.classList.contains('show'), 'data arrival clears the error and restores noViz');
	});

	test('M30: data-mode toolbar echoes the timeframe into the market header and chart', () => {
		handler({ type: 'setToolbar', toolbar: dataToolbar({ timeframe: '1H' }) });
		assert.deepStrictEqual(headerTimeframes, ['1H'], 'market header receives the echoed interval');
		assert.deepStrictEqual(recorded.timeframes, ['1H'], 'chart axis formatter follows the toolbar timeframe');
	});

	test('data-mode toolbar wires watermark + legend symbol; strategy mode clears both', async () => {
		handler({ type: 'setToolbar', toolbar: dataToolbar({ dateRange: { start: '2025-01-01', end: '2026-01-01' } }) });
		assert.deepStrictEqual(recorded.watermarks, ['AAPL']);
		assert.deepStrictEqual(legendSymbols, ['AAPL']);
		assert.deepStrictEqual(setRanges, [{ start: '2025-01-01', end: '2026-01-01' }]);

		handler({ type: 'setToolbar', toolbar: dataToolbar({ mode: 'strategy' }) });
		assert.deepStrictEqual(recorded.watermarks, ['AAPL', null]);
		assert.deepStrictEqual(legendSymbols, ['AAPL', undefined]);
	});
});
