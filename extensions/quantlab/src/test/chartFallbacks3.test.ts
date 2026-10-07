/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-CHARTS-FB2 (2/n): the remaining substitutes and swallowed errors in the chart webview, the chart host provider,
// the debugger and the jsdom reset (inventory: hub folds/F-CHARTS-FB2/inventory.md, DECISIONS.md "TO DO (2/n)").
// Each test removes or invalidates the value a site needs and expects a named error (or the defined behaviour that
// substitutes nothing); where natural, the valid path is asserted unchanged.

import { Module } from 'module';

interface ModuleWithResolve {
	_resolveFilename(request: string, parent: NodeJS.Module | null, isMain?: boolean, options?: { paths?: string[] }): string;
}

(() => {
	const M = Module as unknown as ModuleWithResolve;
	const original = M._resolveFilename;
	const stubPath = require.resolve('../../test/helpers/applier-stub');
	M._resolveFilename = function (request, parent, isMain, options) {
		if (request.startsWith('@charts-plus/')) {
			return stubPath;
		}
		return original.call(this, request, parent, isMain, options);
	};
})();

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscodeShim from '../../test/helpers/vscode-shim';
import { resetDom } from '../../test/helpers/jsdom-shim';
import { setTestChartFactory, type Chart } from '../../test/helpers/applier-stub';
import { ChartClient, type OhlcvBar, type SignalPoint, type VisualizationCommand } from '../../webview/chart/chartApi';
import { createMessageHandler } from '../../webview/chart/messageHandler';
import { ParameterPanel } from '../../webview/chart/parameterPanel';
import { createOhlcLegend } from '../../webview/chart/ohlcLegend';
import { ChartViewProvider } from '../views/chart/ChartViewProvider';
import { DebuggerService } from '../views/chart/DebuggerService';
import { CodeSyncManager } from '../views/chart/CodeSync';
// Type-only: puts the webview entry into the tsc program so out/ has it; the suite requires it after its globals exist.
import type {} from '../../webview/chart/index';

const TOKENS: Record<string, string> = {
	'--ql-status-positive': '#44BF6E',
	'--ql-status-negative': '#FF6B6B',
	'--ql-status-warning': '#F5A623',
	'--ql-status-info': '#2563eb',
	'--ql-status-neutral': '#767679',
	'--vscode-editorGroup-border': '#444444',
	'--ql-bg': '#1e1e1e',
	'--ql-fg': '#d4d4d4',
	'--vscode-editorWidget-border': '#454545',
	'--vscode-focusBorder': '#007fd4',
	'--vscode-editor-inactiveSelectionBackground': '#3a3d41',
	'--vscode-editorHoverWidget-background': '#252526',
	'--vscode-editorHoverWidget-foreground': '#cccccc',
	'--vscode-editorHoverWidget-border': '#454545',
	'--ql-font-family': 'Menlo, monospace',
	'--ql-font-size-base': '13px',
};

const DAY = 86_400_000;

const TWO_BARS: OhlcvBar[] = [
	{ t: Date.UTC(2024, 0, 2), o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
	{ t: Date.UTC(2024, 0, 3), o: 1.5, h: 2, l: 1, c: 1.2, v: 200 },
];

/** Run fn with console.error silenced (a named error is logged before it is shown; the tests assert the shown one). */
function withQuietConsole<T>(fn: () => T): T {
	const real = console.error;
	console.error = () => { /* silenced for fn only */ };
	let result: T;
	try {
		result = fn();
	} catch (error) {
		console.error = real;
		throw error;
	}
	if (result instanceof Promise) {
		return result.finally(() => { console.error = real; }) as T;
	}
	console.error = real;
	return result;
}

// ---------------------------------------------------------------------------------------------
// chartApi.ts
// ---------------------------------------------------------------------------------------------

interface Recorded {
	lineOptions: Array<Record<string, unknown>>;
	crosshair: ((event: { time: number }) => void) | undefined;
}

suite('chartApi: visualization commands, hover, series options (F-CHARTS-FB2 2/n)', () => {
	let rec: Recorded;
	const g = globalThis as Record<string, unknown>;
	const realResizeObserver = g.ResizeObserver;

	setup(() => {
		resetDom();
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
		rec = { lineOptions: [], crosshair: undefined };
		const series = () => ({ setData() { }, setMarkers() { }, setVisible() { } });
		const fake = {
			addPlugin() { },
			addCandlestickSeries: series,
			addHistogramSeries: series,
			addLineSeries: (options: Record<string, unknown>) => { rec.lineOptions.push(options); return series(); },
			addAreaSeries: series,
			getPanes: () => [],
			getPane: () => null,
			addPane: () => 'pane-1',
			setPaneAxisOptions() { },
			onCrosshairMove: (cb: (event: { time: number }) => void) => { rec.crosshair = cb; return () => { }; },
			setVisibleTimeRange() { },
			getVisibleTimeRange: () => ({ from: 0, to: 0 }),
			batch: (fn: () => void) => fn(),
			setTheme() { },
			setWatermark() { },
			destroy() { },
		};
		setTestChartFactory(() => fake as unknown as Chart);
		g.ResizeObserver = class { observe() { } disconnect() { } };
	});

	teardown(() => {
		setTestChartFactory(undefined);
		g.ResizeObserver = realResizeObserver;
	});

	async function client(): Promise<ChartClient> {
		const el = document.createElement('div');
		document.body.appendChild(el);
		const c = new ChartClient(el);
		c.setTimeframe('1D');
		await c.initialize('dark');
		return c;
	}

	function plot(options: Record<string, unknown> | undefined): VisualizationCommand {
		return { type: 'plotSeries', series: 'line', data: [{ t: 1, v: 2 }], options };
	}

	test('a visualization command asking for an indicator, or an unknown one, is named; the drawn commands pass', async () => {
		const c = await client();
		await assert.rejects(c.applyVisualization([{ type: 'addIndicator', indicator: 'sma', params: {} }]),
			new Error('chart: the chart draws no indicators (addIndicator)'));
		await assert.rejects(c.applyVisualization([{ type: 'removeIndicator', id: 'sma-1' }]),
			new Error('chart: the chart draws no indicators (removeIndicator)'));
		await assert.rejects(c.applyVisualization([{ type: 'zigzag' } as unknown as VisualizationCommand]),
			new Error('chart: unknown visualization command (zigzag)'));
		await c.applyVisualization([plot(undefined), { type: 'clear', target: 'indicators' }]);
		assert.strictEqual(rec.lineOptions.length, 1, 'the plotted series was created');
	});

	test('the crosshair outside the bars (or at a NaN time) is the pointer-left state, not the edge bar', async () => {
		const c = await client();
		const seen: Array<number | null> = [];
		c.setHoverListener(index => seen.push(index));
		await c.setData(TWO_BARS);
		const move = (time: number) => rec.crosshair!({ time });
		move(0);
		move(DAY);
		move(0.4 * DAY);
		move(-DAY);
		move(5 * DAY);
		move(Number.NaN);
		assert.deepStrictEqual(seen, [0, 1, 0, null, null, null]);
	});

	test('a lineWidth that is present but not a finite number is named; absent is not set; valid is applied', async () => {
		const c = await client();
		await assert.rejects(c.applyVisualization([plot({ lineWidth: 'abc' })]),
			new Error('chart: series option lineWidth must be a finite number (abc)'));
		await assert.rejects(c.applyVisualization([plot({ lineWidth: Number.NaN })]),
			new Error('chart: series option lineWidth must be a finite number (NaN)'));
		await assert.rejects(c.applyVisualization([plot({ lineWidth: null })]),
			new Error('chart: series option lineWidth must be a finite number (null)'));
		assert.strictEqual(rec.lineOptions.length, 0, 'no series was created for a bad option');
		await c.applyVisualization([plot({ color: '#ff0000' })]);
		assert.ok(!Object.prototype.hasOwnProperty.call(rec.lineOptions[0], 'width'), 'absent lineWidth sets no width');
		await c.applyVisualization([plot({ lineWidth: 3 })]);
		assert.strictEqual(rec.lineOptions[1].width, 3);
		await c.applyVisualization([plot({ width: 2 })]);
		assert.strictEqual(rec.lineOptions[2].width, 2, 'the alternative option name is read when lineWidth is absent');
	});

	test('a lineStyle is solid only when it says so; an unknown one is named', async () => {
		const c = await client();
		await assert.rejects(c.applyVisualization([plot({ lineStyle: 'zigzag' })]),
			new Error('chart: unknown series lineStyle (zigzag; expected solid, dashed or dotted)'));
		await assert.rejects(c.applyVisualization([plot({ lineStyle: 5 })]),
			new Error('chart: unknown series lineStyle (5; expected solid, dashed or dotted)'));
		assert.strictEqual(rec.lineOptions.length, 0, 'no series was created for a bad option');
		await c.applyVisualization([plot({ lineStyle: 'solid' })]);
		assert.ok(!Object.prototype.hasOwnProperty.call(rec.lineOptions[0], 'dash'), 'solid sets no dash');
		await c.applyVisualization([plot({ lineStyle: 'Dashed' })]);
		assert.deepStrictEqual(rec.lineOptions[1].dash, [6, 4]);
		await c.applyVisualization([plot({ lineStyle: 'dotted' })]);
		assert.deepStrictEqual(rec.lineOptions[2].dash, [2, 4]);
	});
});

// ---------------------------------------------------------------------------------------------
// messageHandler.ts
// ---------------------------------------------------------------------------------------------

type Handler = (message: unknown) => Promise<void>;

interface HandlerHarness {
	handler: Handler;
	banner: HTMLElement;
	timeframes: string[];
	modes: string[];
	initialized: number;
	signals: SignalPoint[];
}

function makeHandler(): HandlerHarness {
	const harness = { timeframes: [] as string[], modes: [] as string[], initialized: 0, signals: [] as SignalPoint[] } as HandlerHarness;
	const chart = {
		initialize: async () => { harness.initialized++; },
		setData: async () => { /* no-op */ },
		addSignal: async (signal: SignalPoint) => { harness.signals.push(signal); },
		setWatermark: () => { /* no-op */ },
		setTimeframe: (tf: string) => { harness.timeframes.push(tf); },
		setSignals: async () => { /* no-op */ },
		setEquityCurve: async () => { /* no-op */ },
		applyVisualization: async () => { /* no-op */ },
		setTheme: () => { /* no-op */ }
	};
	const panel = { render: () => { /* no-op */ }, setOverrides: () => { /* no-op */ } };
	harness.banner = document.createElement('div');
	harness.handler = createMessageHandler({
		postMessage: () => { /* no-op */ },
		chart,
		parameterPanel: panel,
		banner: harness.banner,
		noViz: document.createElement('div'),
		applyMode: (mode: string) => { harness.modes.push(mode); },
		marketHeader: {
			setSource: () => { /* no-op */ },
			setTimeframe: () => { /* no-op */ },
			updateFromBars: () => { /* no-op */ },
			setRange: () => { /* no-op */ }
		},
		legend: { setSymbol: () => { /* no-op */ }, setBars: () => { /* no-op */ } },
		loading: document.createElement('div'),
		emptyState: document.createElement('div'),
		toolbar: {
			dataSourceButton: document.createElement('button'),
			dataSourceDropdown: document.createElement('div'),
			timeframeLabel: document.createElement('span'),
			dateStart: document.createElement('input'),
			dateEnd: document.createElement('input'),
			complexity: document.createElement('div')
		},
		panelRoot: document.createElement('div'),
		errorOverlay: document.createElement('div'),
		errorMessage: document.createElement('div'),
		errorActions: document.createElement('div')
	} as unknown as Parameters<typeof createMessageHandler>[0]) as Handler;
	return harness;
}

const COMPLEXITY = { level: 'safe' as const, score: 0, reasons: [] };

function toolbar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dataSource: { kind: 'server', symbol: 'AAPL', displayName: 'Apple Inc.' },
		timeframe: '1D',
		complexity: COMPLEXITY,
		hasVisualization: true,
		viewOnly: false,
		mode: 'data',
		...overrides
	};
}

suite('chart messageHandler: no invented values, no silent drops (F-CHARTS-FB2 2/n)', () => {
	let h: HandlerHarness;

	setup(() => {
		resetDom();
		h = makeHandler();
	});

	test('a banner without a tone sets no tone (and drops the previous banner\'s); with a tone, it is set', async () => {
		await h.handler({ type: 'showBanner', message: 'careful', tone: 'warning' });
		assert.strictEqual(h.banner.dataset.tone, 'warning');
		await h.handler({ type: 'showBanner', message: 'plain' });
		assert.ok(!h.banner.hasAttribute('data-tone'), 'no data-tone on an un-toned banner');
		assert.strictEqual(h.banner.textContent, 'plain');
	});

	test('a toolbar without a mode is named; with one it is applied', async () => {
		const noMode = toolbar();
		delete noMode.mode;
		await assert.rejects(h.handler({ type: 'setToolbar', toolbar: noMode }),
			new Error('chart: the toolbar has no valid mode (undefined)'));
		await assert.rejects(h.handler({ type: 'setToolbar', toolbar: toolbar({ mode: 'both' }) }),
			new Error('chart: the toolbar has no valid mode (both)'));
		assert.deepStrictEqual(h.modes, [], 'no mode was applied');
		await h.handler({ type: 'setToolbar', toolbar: toolbar({ mode: 'strategy' }) });
		assert.deepStrictEqual(h.modes, ['strategy']);
	});

	test('a malformed message is named, not dropped', async () => {
		await assert.rejects(h.handler(null), new Error('chart: malformed message (null)'));
		await assert.rejects(h.handler('setData'), new Error('chart: malformed message ("setData")'));
		await assert.rejects(h.handler({ requestId: 1 }), new Error('chart: malformed message ({"requestId":1})'));
		await assert.rejects(h.handler({ type: 7 }), new Error('chart: malformed message ({"type":7})'));
	});

	test('a malformed setDataBinary or addSignal is named; a valid one is applied', async () => {
		await assert.rejects(h.handler({ type: 'setDataBinary', requestId: 1, buffer: 'not a buffer', count: 1 }),
			new Error('chart: malformed setDataBinary message (buffer "not a buffer", count 1)'));
		await assert.rejects(h.handler({ type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48), count: -1 }),
			new Error('chart: malformed setDataBinary message (buffer ArrayBuffer of 48 bytes, count -1)'));
		await assert.rejects(h.handler({ type: 'addSignal', signal: { type: 'entry' } }),
			new Error('chart: malformed addSignal message (signal {"type":"entry"})'));
		await assert.rejects(h.handler({ type: 'addSignal' }),
			new Error('chart: malformed addSignal message (signal undefined)'));
		assert.strictEqual(h.signals.length, 0);
		await h.handler({ type: 'addSignal', signal: { t: 5, type: 'entry' } });
		assert.strictEqual(h.signals.length, 1);
	});

	test('the chart is given a timeframe only when the host sends one (no 1D is invented)', async () => {
		await h.handler({ type: 'setToolbar', toolbar: toolbar({ timeframe: undefined }) });
		await h.handler({ type: 'init', payload: { theme: 'dark', toolbar: toolbar({ timeframe: undefined }), parameters: [], overrides: {} } });
		assert.deepStrictEqual(h.timeframes, []);
		assert.strictEqual(h.initialized, 1, 'init still creates the chart');
		await h.handler({ type: 'setToolbar', toolbar: toolbar({ timeframe: '1W' }) });
		await h.handler({ type: 'init', payload: { theme: 'dark', toolbar: toolbar({ timeframe: '4H' }), parameters: [], overrides: {} } });
		assert.deepStrictEqual(h.timeframes, ['1W', '4H']);
	});

	test('an unknown message type is named', async () => {
		await assert.rejects(h.handler({ type: 'bogus' }), new Error('chart: unknown message type (bogus)'));
	});

	test('every type the host posts to the chart webview is a case (none is "unknown")', async () => {
		// The host's posts (ChartViewProvider session.webview.postMessage) except 'theme' and 'reducedMotion',
		// which index.ts handles before the handler.
		const hostMessages: Array<Record<string, unknown>> = [
			{ type: 'init', payload: { theme: 'dark', toolbar: toolbar(), parameters: [], overrides: {} } },
			{ type: 'setToolbar', toolbar: toolbar() },
			{ type: 'setRecentSources', sources: [] },
			{ type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48), count: 1 },
			{ type: 'setSignals', requestId: 0, signals: [] },
			{ type: 'setEquityCurve', requestId: 0, equity: [] },
			{ type: 'setVisualization', requestId: 1, commands: [] },
			{ type: 'setParameters', parameters: [] },
			{ type: 'setOverrides', overrides: {} },
			{ type: 'setComplexity', complexity: COMPLEXITY },
			{ type: 'setTheme', theme: 'dark' },
			{ type: 'toggleParameters', collapsed: true },
			{ type: 'showBanner', message: 'x' },
			{ type: 'showError', message: '' },
			{ type: 'showLoading', requestId: 1 },
			{ type: 'showEmptyState' },
		];
		for (const message of hostMessages) {
			await h.handler(message);
		}
	});
});

// ---------------------------------------------------------------------------------------------
// parameterPanel.ts
// ---------------------------------------------------------------------------------------------

suite('parameterPanel: numeric entries (F-CHARTS-FB2 2/n)', () => {
	let container: HTMLElement;
	let changes: Array<[string, unknown]>;

	setup(() => {
		resetDom();
		container = document.createElement('div');
		document.body.appendChild(container);
		changes = [];
	});

	function render(params: Array<Record<string, unknown>>): ParameterPanel {
		const panel = new ParameterPanel(container, (id, value) => changes.push([id, value]), () => { }, () => { });
		panel.render(params as unknown as Parameters<ParameterPanel['render']>[0], {});
		return panel;
	}

	function enter(input: HTMLInputElement, value: string): void {
		input.value = value;
		input.dispatchEvent(new window.Event('change'));
	}

	test('an empty or non-numeric entry is not committed (the box shows invalid); a number is', () => {
		render([{ id: 'period', default: 5, min: 1, max: 10 }]);
		const numeric = container.querySelector<HTMLInputElement>('input[type="number"]')!;
		enter(numeric, '');
		enter(numeric, 'abc');
		assert.deepStrictEqual(changes, [], 'nothing was committed (not even 0)');
		assert.strictEqual(numeric.getAttribute('aria-invalid'), 'true');
		assert.strictEqual(numeric.validationMessage, 'period needs a number');
		enter(numeric, '7');
		assert.deepStrictEqual(changes, [['period', 7]]);
		assert.strictEqual(numeric.getAttribute('aria-invalid'), null);
		assert.strictEqual(numeric.validationMessage, '');
	});

	test('a numeric parameter with a full range keeps its range and number inputs; one without a max has no range and writes no "undefined"', () => {
		render([{ id: 'ranged', default: 5, min: 1, max: 10 }]);
		const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
		assert.strictEqual(range.min, '1');
		assert.strictEqual(range.max, '10');
		render([{ id: 'open', default: 5, min: 1 }]);
		assert.strictEqual(container.querySelector('input[type="range"]'), null);
		assert.ok(!container.innerHTML.includes('undefined'), 'no attribute or text says "undefined"');
	});
});

// ---------------------------------------------------------------------------------------------
// ohlcLegend.ts
// ---------------------------------------------------------------------------------------------

suite('ohlcLegend: hover index (F-CHARTS-FB2 2/n)', () => {
	setup(() => {
		resetDom();
	});

	const BARS: OhlcvBar[] = [
		{ t: 1000, o: 100, h: 105, l: 99, c: 104, v: 10 },
		{ t: 2000, o: 104, h: 106, l: 101, c: 102, v: 20 },
		{ t: 3000, o: 102, h: 110, l: 102, c: 109.5, v: 30 },
	];

	test('an index outside the bars is named, not clamped to an edge bar; inside, and null, are unchanged', () => {
		const legend = createOhlcLegend();
		legend.setSymbol('AAPL');
		legend.setBars(BARS);
		assert.throws(() => legend.showBar(3), new Error('chart: legend index outside the bars (3, 3 bars)'));
		assert.throws(() => legend.showBar(-1), new Error('chart: legend index outside the bars (-1, 3 bars)'));
		assert.throws(() => legend.showBar(1.5), new Error('chart: legend index outside the bars (1.5, 3 bars)'));
		assert.throws(() => legend.showBar(Number.NaN), new Error('chart: legend index outside the bars (NaN, 3 bars)'));
		legend.showBar(1);
		assert.strictEqual(legend.root.querySelectorAll('.ol-value')[3].textContent, '102.00');
		legend.showBar(null);
		assert.strictEqual(legend.root.querySelectorAll('.ol-value')[3].textContent, '109.50');
	});
});

// ---------------------------------------------------------------------------------------------
// index.ts (the chart webview's entry: loaded once, its window listeners are the product's)
// ---------------------------------------------------------------------------------------------

suite('chart webview entry: reducedMotion message (F-CHARTS-FB2 2/n)', () => {
	const g = globalThis as Record<string, unknown>;
	let root: HTMLElement;
	const posted: unknown[] = [];
	const win = () => window as unknown as { MessageEvent: typeof MessageEvent; matchMedia?: unknown };

	suiteSetup(() => {
		resetDom();
		root = document.createElement('div');
		root.id = 'chart-root';
		document.body.appendChild(root);
		g.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => { posted.push(message); } });
		win().matchMedia = () => ({ matches: false });
		require('../../webview/chart/index');
	});

	suiteTeardown(() => {
		delete g.acquireVsCodeApi;
		delete win().matchMedia;
		document.documentElement.classList.remove('ql-reduced-motion');
	});

	function post(data: unknown): void {
		window.dispatchEvent(new (win().MessageEvent)('message', { data }));
	}

	test('a reducedMotion message without a valid mode reaches the error overlay by name; with one it is applied', () => {
		assert.deepStrictEqual(posted, [{ type: 'ready' }]);
		const errorText = () => root.querySelector('.error-message')!.textContent;
		withQuietConsole(() => post({ type: 'reducedMotion' }));
		assert.strictEqual(errorText(), 'chart: the reducedMotion message has no valid mode (undefined)');
		withQuietConsole(() => post({ type: 'reducedMotion', mode: 'sometimes' }));
		assert.strictEqual(errorText(), 'chart: the reducedMotion message has no valid mode (sometimes)');
		assert.ok(!document.documentElement.classList.contains('ql-reduced-motion'));
		post({ type: 'reducedMotion', mode: 'always' });
		assert.ok(document.documentElement.classList.contains('ql-reduced-motion'));
		post({ type: 'reducedMotion', mode: 'never' });
		assert.ok(!document.documentElement.classList.contains('ql-reduced-motion'));
	});
});

// ---------------------------------------------------------------------------------------------
// ChartViewProvider.ts
// ---------------------------------------------------------------------------------------------

suite('ChartViewProvider: webview messages, server timeframe, operation errors (F-CHARTS-FB2 2/n)', () => {
	setup(() => {
		vscodeShim._resetShimState();
	});

	function makeProvider(fields: Record<string, unknown> = {}): Record<string, unknown> {
		// Object.create skips the class-field initializers (their singletons need the real VS Code runtime).
		const provider = Object.create(ChartViewProvider.prototype) as Record<string, unknown>;
		return Object.assign(provider, fields);
	}

	const onMessage = (provider: Record<string, unknown>, message: unknown) =>
		(provider as unknown as { onMessage(session: unknown, message: unknown): Promise<void> }).onMessage({}, message);

	test('a malformed or unknown webview message is shown to the user by name; a known one is not an error', async () => {
		const provider = makeProvider();
		await withQuietConsole(async () => {
			await onMessage(provider, null);
			await onMessage(provider, 'refresh');
			await onMessage(provider, { type: 'bogus' });
			await onMessage(provider, {});
		});
		assert.deepStrictEqual(vscodeShim._errorMessagesSnapshot(), [
			'quantlab chart: malformed webview message (null)',
			'quantlab chart: malformed webview message ("refresh")',
			'quantlab chart: unknown webview message type (bogus)',
			'quantlab chart: unknown webview message type (undefined)',
		]);
		vscodeShim._resetShimState();
		await onMessage(provider, { type: 'selectTool', tool: null });
		assert.deepStrictEqual(vscodeShim._errorMessagesSnapshot(), []);
	});

	test('a server load whose toolbar has no timeframe is named; with one, the server is asked for that timeframe', async () => {
		const asked: unknown[][] = [];
		const provider = makeProvider({
			dataService: {
				getOHLCVFromServer: async (symbol: string, timeframe: string) => {
					asked.push([symbol, timeframe]);
					return { data: [], meta: { effectiveTimeframe: timeframe } };
				}
			}
		});
		const loadBars = (toolbarState: Record<string, unknown>) =>
			(provider as unknown as { loadBars(source: unknown, toolbar: unknown, token: unknown): Promise<unknown> })
				.loadBars({ kind: 'server', symbol: 'AAPL', displayName: 'Apple' }, toolbarState, {});
		await assert.rejects(loadBars({}), new Error('quantlab chart: the toolbar has no timeframe for the server source AAPL'));
		assert.deepStrictEqual(asked, []);
		await loadBars({ timeframe: '1W' });
		assert.deepStrictEqual(asked, [['AAPL', '1W']]);
	});

	test('the clamped server timeframe is a defined behaviour (it is what the toolbar and header show): unsupported -> 1D, supported kept', () => {
		const clamp = (ChartViewProvider as unknown as { clampServerTimeframe(tf: string | undefined, assetClass: string | undefined): string }).clampServerTimeframe;
		assert.strictEqual(clamp('1m', undefined), '1D');
		assert.strictEqual(clamp(undefined, undefined), '1D');
		assert.strictEqual(clamp('1W', 'crypto'), '1D');
		assert.strictEqual(clamp('1W', undefined), '1W');
		assert.strictEqual(clamp('1H', 'Crypto'), '1H');
	});

	test('every failed fire-and-forget operation is shown to the user, not only those named "load"', async () => {
		const provider = makeProvider();
		const run = (name: string) => (provider as unknown as {
			executeWithErrorBoundary(operation: () => Promise<void>, operationName: string): void;
		}).executeWithErrorBoundary(async () => { throw new Error('boom'); }, name);
		await withQuietConsole(async () => {
			run('refreshVisualization');
			run('reloadData');
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		});
		assert.deepStrictEqual(vscodeShim._errorMessagesSnapshot(), [
			'Failed to refreshVisualization: boom',
			'Failed to reloadData: boom',
		]);
	});
});

// ---------------------------------------------------------------------------------------------
// DebuggerService.ts
// ---------------------------------------------------------------------------------------------

suite('DebuggerService: loading a debug file (F-CHARTS-FB2 2/n)', () => {
	const commands = vscodeShim.commands as { executeCommand: (command: string, ...args: unknown[]) => Promise<unknown> };
	const realExecute = commands.executeCommand;
	let scratch: string;

	setup(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-debugger-'));
	});

	teardown(() => {
		commands.executeCommand = realExecute;
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	const DEBUG_FILE = { metadata: { barCount: 2 }, states: [], conditions: [], signals: [], fills: [], tradeBarIndices: [1] };

	function makeService(): DebuggerService {
		const service = Object.create(DebuggerService.prototype) as Record<string, unknown>;
		Object.assign(service, {
			enabled: false,
			metadata: null,
			currentBarIndex: 0,
			totalBars: 0,
			tradeBarIndices: [],
			statesCache: new Map(),
			conditionsCache: new Map(),
			signalsCache: new Map(),
			fillsCache: new Map(),
			codeSyncManager: { setStrategyFile() { }, loadConditions() { } },
			_onStateChange: { fire() { } }
		});
		return service as unknown as DebuggerService;
	}

	test('an engine that returns nothing is named (not false); one that returns the parsed file enables the debugger', async () => {
		const service = makeService();
		commands.executeCommand = async () => undefined;
		await assert.rejects(service.loadDebugFile('/runs/a.debug'),
			new Error('quantlab debugger: the engine returned no debug data for /runs/a.debug'));
		assert.strictEqual(service.isEnabled(), false);
		// The registered command returns the parsed object (extension.ts quantlab.engine.readDebugFile), not a string.
		commands.executeCommand = async () => DEBUG_FILE;
		await service.loadDebugFile('/runs/a.debug');
		assert.strictEqual(service.isEnabled(), true);
		assert.strictEqual(service.getTotalBars(), 2);
		assert.deepStrictEqual(service.getTradeBarIndices(), [1]);
	});

	test('an engine failure is the failure, even for a readable .json file (no second reader); a text result is named', async () => {
		const file = path.join(scratch, 'run.json');
		fs.writeFileSync(file, JSON.stringify(DEBUG_FILE));
		const service = makeService();
		commands.executeCommand = async () => { throw new Error('engine down'); };
		await assert.rejects(service.loadDebugFile(file), (error: Error) => {
			assert.strictEqual(error.message, `quantlab debugger: the engine could not read the debug file ${file}: engine down`);
			assert.strictEqual((error.cause as Error).message, 'engine down');
			return true;
		});
		assert.strictEqual(service.isEnabled(), false, 'the file was not read behind the engine\'s back');
		commands.executeCommand = async () => '{not json';
		await assert.rejects(service.loadDebugFile('/runs/b.debug'),
			new Error('quantlab debugger: the debug data for /runs/b.debug is invalid (expected the parsed debug file object, got string)'));
	});
});

// ---------------------------------------------------------------------------------------------
// CodeSync.ts
// ---------------------------------------------------------------------------------------------

suite('CodeSyncManager: engine line numbers (F-CHARTS-FB2 2/n)', () => {
	const shimExports = vscodeShim as unknown as Record<string, unknown>;
	const hadMarkdown = Object.prototype.hasOwnProperty.call(shimExports, 'MarkdownString');
	const previousMarkdown = shimExports.MarkdownString;

	suiteSetup(() => {
		shimExports.MarkdownString = class { appendMarkdown(): this { return this; } };
	});

	suiteTeardown(() => {
		if (hadMarkdown) {
			shimExports.MarkdownString = previousMarkdown;
		} else {
			delete shimExports.MarkdownString;
		}
	});

	function makeSync(lineCount: number): { sync: CodeSyncManager; decorated: unknown[][] } {
		const decorated: unknown[][] = [];
		const editor = {
			document: { uri: { fsPath: '/ws/strategy.py' }, lineCount, lineAt: (line: number) => ({ range: { line } }) },
			setDecorations: (_type: unknown, ranges: unknown[]) => { decorated.push(ranges); },
			revealRange() { }
		};
		const sync = Object.create(CodeSyncManager.prototype) as Record<string, unknown>;
		Object.assign(sync, {
			strategyUri: { fsPath: '/ws/strategy.py' },
			editor,
			conditions: new Map(),
			currentBarIndex: 0,
			trueDecorationType: 'true',
			falseDecorationType: 'false',
			highlightDecorationType: 'highlight'
		});
		return { sync: sync as unknown as CodeSyncManager, decorated };
	}

	function condition(lineNumber: number) {
		return { barIndex: 0, lineNumber, expression: 'a > b', leftValue: '1', operator: '>', rightValue: '0', result: true };
	}

	test('a condition on line < 1 is named, not clamped to line 0; a valid line is decorated', () => {
		for (const bad of [0, -3, 1.5]) {
			const { sync } = makeSync(3);
			sync.loadConditions([condition(bad)]);
			assert.throws(() => sync.setBarIndex(0),
				new Error(`quantlab code sync: the engine reported an invalid line number (${bad}; lines start at 1)`));
		}
		const { sync, decorated } = makeSync(3);
		sync.loadConditions([condition(2)]);
		sync.setBarIndex(0);
		assert.strictEqual(decorated[0].length, 1, 'the true decoration list has the condition');
		assert.deepStrictEqual((decorated[0][0] as { range: unknown }).range, { line: 1 });
	});

	test('a condition on a line past the end of the file is named, not skipped', () => {
		const { sync, decorated } = makeSync(3);
		sync.loadConditions([condition(4)]);
		assert.throws(() => sync.setBarIndex(0),
			new Error('quantlab code sync: the engine reported a condition on line 4, but the strategy file has 3 lines'));
		assert.deepStrictEqual(decorated, [], 'no decoration pass ran on a bad line');
		const last = makeSync(3);
		last.sync.loadConditions([condition(3)]);
		last.sync.setBarIndex(0);
		assert.strictEqual(last.decorated.length, 2, 'the last line is inside the file');
	});

	test('highlightLine of line < 1 is named before any editor is opened', async () => {
		const { sync } = makeSync(3);
		await assert.rejects(sync.highlightLine(0),
			new Error('quantlab code sync: the engine reported an invalid line number (0; lines start at 1)'));
	});
});

// ---------------------------------------------------------------------------------------------
// test/helpers/jsdom-shim.ts
// ---------------------------------------------------------------------------------------------

suite('jsdom-shim resetDom (F-CHARTS-FB2 2/n)', () => {
	setup(() => {
		resetDom();
	});

	test('a document listener that cannot be removed fails the reset with an aggregate, after the others were tried', () => {
		const doc = document as unknown as { removeEventListener: unknown };
		const listener = () => { };
		const ok = () => { };
		document.addEventListener('click', listener);
		document.addEventListener('keydown', ok);
		const wrapper = doc.removeEventListener as (type: string, l: () => void, capture?: boolean) => void;
		const removed: string[] = [];
		doc.removeEventListener = (type: string, l: () => void, capture?: boolean) => {
			if (type === 'click') {
				throw new Error('remove refused');
			}
			removed.push(type);
			wrapper(type, l, capture);
		};
		try {
			assert.throws(() => resetDom(), (error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.strictEqual(error.message, 'jsdom-shim.resetDom: 1 document listener(s) could not be removed: remove refused');
				assert.strictEqual(error.errors.length, 1);
				return true;
			});
			assert.deepStrictEqual(removed, ['keydown'], 'the listener after the failing one was still removed');
		} finally {
			doc.removeEventListener = wrapper;
			document.removeEventListener('click', listener);
		}
	});

	test('a reset with nothing failing does not throw', () => {
		document.addEventListener('click', () => { });
		resetDom();
	});
});
