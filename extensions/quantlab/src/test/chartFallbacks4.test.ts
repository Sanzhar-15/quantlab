/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-CHARTS-FB2 (c1 review fixes): M1 the debugger command's real return shape, M2 every message type validated in both
// directions before any state changes (a malformed one is a named error; a VALID older request is the one deliberate
// ignore), M3 absent optional option omitted / present invalid option named before any series or pane changes, S4 the
// slider repairs the number box, S5 bars validated at the data boundary, S6 an unsupported explicit timeframe announced,
// S7 the host sends a bars load's timeframe before its bars.

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
import * as vscodeShim from '../../test/helpers/vscode-shim';
import { resetDom } from '../../test/helpers/jsdom-shim';
import { setTestChartFactory, type Chart } from '../../test/helpers/applier-stub';
import { ChartClient, type OhlcvBar, type VisualizationCommand } from '../../webview/chart/chartApi';
import { createMessageHandler } from '../../webview/chart/messageHandler';
import { ParameterPanel } from '../../webview/chart/parameterPanel';
import { ChartViewProvider } from '../views/chart/ChartViewProvider';
import { DebuggerService } from '../views/chart/DebuggerService';
import { parseChartInboundMessage } from '../views/chart/chartInboundValidation';
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

const BARS: OhlcvBar[] = [
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

function matches(error: unknown, expected: string | RegExp): boolean {
	assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
	if (typeof expected === 'string') {
		assert.strictEqual(error.message, expected);
	} else {
		assert.match(error.message, expected);
	}
	return true;
}

// ---------------------------------------------------------------------------------------------
// M1: DebuggerService reads the command's real return shape (the parsed object)
// ---------------------------------------------------------------------------------------------

suite('DebuggerService: the engine command returns the parsed debug file (F-CHARTS-FB2 c1 M1)', () => {
	const commands = vscodeShim.commands as { executeCommand: (command: string, ...args: unknown[]) => Promise<unknown> };
	const realExecute = commands.executeCommand;

	teardown(() => {
		commands.executeCommand = realExecute;
	});

	const state = (barIndex: number) => ({
		barIndex, timestamp: '2024-01-02', cash: '1000', equity: '1000', positions: {}, pendingOrders: 0,
		unrealizedPnl: '0', realizedPnl: '0', grossExposure: '0'
	});

	/** The parsed fixture, as quantlab.engine.readDebugFile returns it (JSON.parse of the file). */
	function debugFile(): Record<string, unknown> {
		return JSON.parse(JSON.stringify({
			metadata: { barCount: 3, strategyPath: '/ws/strategy.py' },
			states: [state(0), state(1), state(2)],
			conditions: [{ barIndex: 1, lineNumber: 4, expression: 'a > b', leftValue: '1', operator: '>', rightValue: '0', result: true }],
			signals: [{ barIndex: 1, signalId: 's1', symbol: 'AAPL', side: 'buy', quantity: '1', orderType: 'market' }],
			fills: [{ barIndex: 2, fillId: 'f1', orderId: 'o1', symbol: 'AAPL', side: 'buy', quantity: '1', price: '10', commission: '0' }],
			tradeBarIndices: [1, 2]
		}));
	}

	interface Spied {
		service: DebuggerService;
		strategyFiles: string[];
		loadedConditions: unknown[][];
		events: string[];
	}

	function makeService(): Spied {
		const spied = { strategyFiles: [] as string[], loadedConditions: [] as unknown[][], events: [] as string[] } as Spied;
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
			codeSyncManager: {
				setStrategyFile: (file: string) => { spied.strategyFiles.push(file); },
				loadConditions: (conditions: unknown[]) => { spied.loadedConditions.push(conditions); }
			},
			_onStateChange: { fire: (event: { type: string }) => { spied.events.push(event.type); } }
		});
		spied.service = service as unknown as DebuggerService;
		return spied;
	}

	function assertUntouched(spied: Spied): void {
		const { service } = spied;
		assert.strictEqual(service.isEnabled(), false, 'the debugger stays disabled');
		assert.strictEqual(service.getTotalBars(), 0);
		assert.deepStrictEqual(service.getTradeBarIndices(), []);
		assert.strictEqual(service.getMetadata(), null);
		assert.strictEqual(service.getBarData(0), null, 'no cache was filled');
		assert.deepStrictEqual(spied.events, []);
		assert.deepStrictEqual(spied.strategyFiles, []);
	}

	test('the command\'s parsed object enables the debugger and fills every cache', async () => {
		const spied = makeService();
		commands.executeCommand = async (command: string, ...args: unknown[]) => {
			assert.strictEqual(command, 'quantlab.engine.readDebugFile');
			assert.deepStrictEqual(args, ['/runs/valid.json']);
			return debugFile();
		};
		await spied.service.loadDebugFile('/runs/valid.json');
		const { service } = spied;
		assert.strictEqual(service.isEnabled(), true);
		assert.strictEqual(service.getTotalBars(), 3);
		assert.deepStrictEqual(service.getTradeBarIndices(), [1, 2]);
		assert.strictEqual(service.getMetadata()!.barCount, 3);
		assert.strictEqual(service.getBarData(0)!.state.barIndex, 0);
		assert.strictEqual(service.getBarData(1)!.conditions.length, 1, 'conditions cache');
		assert.strictEqual(service.getBarData(1)!.signals.length, 1, 'signals cache');
		assert.strictEqual(service.getBarData(2)!.fills.length, 1, 'fills cache');
		assert.deepStrictEqual(spied.strategyFiles, ['/ws/strategy.py']);
		assert.deepStrictEqual(spied.events, ['enabled', 'dataLoaded']);
	});

	test('a rejected command, a null or absent result are named and leave the debugger untouched', async () => {
		const rejected = makeService();
		commands.executeCommand = async () => { throw new Error('engine down'); };
		await assert.rejects(rejected.service.loadDebugFile('/runs/a.json'),
			new Error('quantlab debugger: the engine could not read the debug file /runs/a.json: engine down'));
		assertUntouched(rejected);
		for (const result of [null, undefined]) {
			const spied = makeService();
			commands.executeCommand = async () => result;
			await assert.rejects(spied.service.loadDebugFile('/runs/b.json'),
				new Error('quantlab debugger: the engine returned no debug data for /runs/b.json'));
			assertUntouched(spied);
		}
	});

	test('a result that is not the parsed file, or lacks a required field, is named and leaves the debugger untouched', async () => {
		const without = (field: string): Record<string, unknown> => { const file = debugFile(); delete file[field]; return file; };
		const withMeta = (meta: Record<string, unknown>): Record<string, unknown> => ({ ...debugFile(), metadata: meta });
		const withEntry = (field: string, entry: unknown): Record<string, unknown> => ({ ...debugFile(), [field]: [entry] });
		const table: Array<[string, unknown, string]> = [
			['a text result (the old string contract)', JSON.stringify(debugFile()), 'expected the parsed debug file object, got string'],
			['an array', [], 'expected the parsed debug file object, got an array'],
			['a number', 7, 'expected the parsed debug file object, got number'],
			['no metadata', without('metadata'), 'metadata is missing'],
			['barCount missing', withMeta({}), 'metadata.barCount is undefined, not a whole number of bars'],
			['barCount NaN', withMeta({ barCount: Number.NaN }), 'metadata.barCount is NaN, not a whole number of bars'],
			['barCount fractional', withMeta({ barCount: 1.5 }), 'metadata.barCount is 1.5, not a whole number of bars'],
			['barCount negative', withMeta({ barCount: -1 }), 'metadata.barCount is -1, not a whole number of bars'],
			['strategyPath a number', withMeta({ barCount: 3, strategyPath: 5 }), 'metadata.strategyPath is 5, not a path'],
			['no states', without('states'), 'states is missing'],
			['no conditions', without('conditions'), 'conditions is missing'],
			['no signals', without('signals'), 'signals is missing'],
			['no fills', without('fills'), 'fills is missing'],
			['a state without barIndex', withEntry('states', {}), 'states[0] has no whole barIndex (undefined)'],
			['a signal with a fractional barIndex', withEntry('signals', { barIndex: 0.5 }), 'signals[0] has no whole barIndex (0.5)'],
			['a fill that is not an object', withEntry('fills', 'f'), 'fills[0] has no whole barIndex (undefined)'],
			['no tradeBarIndices', without('tradeBarIndices'), 'tradeBarIndices is missing'],
			['a fractional trade bar index', { ...debugFile(), tradeBarIndices: [1.5] }, 'tradeBarIndices[0] is 1.5, not a bar index'],
		];
		for (const [label, result, problem] of table) {
			const spied = makeService();
			commands.executeCommand = async () => result;
			await assert.rejects(spied.service.loadDebugFile('/runs/c.json'),
				new Error(`quantlab debugger: the debug data for /runs/c.json is invalid (${problem})`), label);
			assertUntouched(spied);
		}
	});
});

// ---------------------------------------------------------------------------------------------
// M2 (webview side): every host message validated before any state changes
// ---------------------------------------------------------------------------------------------

const COMPLEXITY = { level: 'safe' as const, score: 0, reasons: [] as string[] };

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

function binary(bars: Array<[number, number, number, number, number, number]>): ArrayBuffer {
	const view = new Float64Array(bars.length * 6);
	bars.forEach((bar, i) => view.set(bar, i * 6));
	return view.buffer;
}

interface Observed {
	handler: (message: unknown) => Promise<void>;
	log: unknown[][];
	/** Everything the handler can change: the stub calls and the DOM it owns. */
	snapshot(): string;
}

function makeObserved(): Observed {
	const log: unknown[][] = [];
	const rec = (name: string) => (...args: unknown[]) => { log.push([name, ...args]); };
	const recAsync = (name: string) => async (...args: unknown[]) => { log.push([name, ...args]); };
	const chart = {
		initialize: recAsync('chart.initialize'),
		setData: recAsync('chart.setData'),
		addSignal: recAsync('chart.addSignal'),
		setWatermark: rec('chart.setWatermark'),
		setTimeframe: rec('chart.setTimeframe'),
		setSignals: recAsync('chart.setSignals'),
		setEquityCurve: recAsync('chart.setEquityCurve'),
		applyVisualization: recAsync('chart.applyVisualization'),
		setTheme: rec('chart.setTheme')
	};
	const banner = document.createElement('div');
	const loading = document.createElement('div');
	const emptyState = document.createElement('div');
	const errorOverlay = document.createElement('div');
	const errorMessage = document.createElement('div');
	const errorActions = document.createElement('div');
	const panelRoot = document.createElement('div');
	const noViz = document.createElement('div');
	const dataSourceButton = document.createElement('button');
	const dataSourceDropdown = document.createElement('div');
	const timeframeLabel = document.createElement('span');
	const dateStart = document.createElement('input');
	const dateEnd = document.createElement('input');
	const complexity = document.createElement('div');
	const handler = createMessageHandler({
		postMessage: rec('postMessage'),
		chart,
		parameterPanel: { render: rec('panel.render'), setOverrides: rec('panel.setOverrides') },
		banner,
		noViz,
		applyMode: rec('applyMode'),
		marketHeader: {
			setSource: rec('header.setSource'),
			setTimeframe: rec('header.setTimeframe'),
			updateFromBars: rec('header.updateFromBars'),
			setRange: rec('header.setRange')
		},
		legend: { setSymbol: rec('legend.setSymbol'), setBars: rec('legend.setBars') },
		loading,
		emptyState,
		toolbar: { dataSourceButton, dataSourceDropdown, timeframeLabel, dateStart, dateEnd, complexity },
		panelRoot,
		errorOverlay,
		errorMessage,
		errorActions
	} as unknown as Parameters<typeof createMessageHandler>[0]) as (message: unknown) => Promise<void>;
	const snapshot = () => JSON.stringify([
		log.length,
		[banner, loading, emptyState, errorOverlay, errorMessage, errorActions, panelRoot, noViz, dataSourceButton, dataSourceDropdown, timeframeLabel, complexity]
			.map(el => el.outerHTML),
		dateStart.value, dateEnd.value
	]);
	return { handler, log, snapshot };
}

const SIGNAL = { t: 5, type: 'entry' as const, label: 'buy', price: 10 };
const PLOT_OK = { type: 'plotSeries', series: 'line', data: [{ t: 1, v: 2 }], options: { color: '#ff0000', lineWidth: 2 } };
const PLOT_BAD = { type: 'plotSeries', series: 'line', data: [{ t: 1, v: 2 }], options: { lineWidth: 'abc' } };
const FRAME = (id: number) => ({ type: 'setDataBinary', requestId: id, buffer: binary([[1000, 1, 2, 0.5, 1.5, 10]]), count: 1 });

/** Every type the host posts to the chart webview (except 'theme' and 'reducedMotion', which index.ts handles), in full valid shape. */
const VALID: Array<Record<string, unknown>> = [
	{ type: 'init', payload: { theme: 'dark', toolbar: toolbar({ dateRange: { start: '2024-01-01', end: '2024-02-01' }, recentSources: [{ kind: 'localFile', filePath: '/a.csv', displayName: 'a' }, { kind: 'server', symbol: 'BTC', displayName: 'Bitcoin', assetClass: 'crypto' }] }), parameters: [{ id: 'period', default: 5 }], overrides: { period: 7 } } },
	{ type: 'setToolbar', toolbar: toolbar({ timeframe: undefined, dataSource: undefined }) },
	{ type: 'setRecentSources', sources: [{ kind: 'server', symbol: 'AAPL', displayName: 'Apple' }] },
	{ type: 'setData', requestId: 1, data: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5 }] },
	FRAME(1),
	{ type: 'showLoading', requestId: 1 },
	{ type: 'showEmptyState' },
	{ type: 'addSignal', signal: SIGNAL },
	{ type: 'setSignals', requestId: 0, signals: [SIGNAL, { t: 6, type: 'exit' }] },
	{ type: 'setEquityCurve', requestId: 0, equity: [{ t: 1, v: 100 }] },
	{ type: 'setVisualization', requestId: 1, commands: [PLOT_OK, { type: 'clear', target: 'signals' }] },
	{ type: 'setParameters', parameters: [{ id: 'period', default: 5 }] },
	{ type: 'setOverrides', overrides: {} },
	{ type: 'setComplexity', complexity: COMPLEXITY },
	{ type: 'setTheme', theme: 'light' },
	{ type: 'toggleParameters', collapsed: true },
	{ type: 'showBanner', message: 'careful', tone: 'warning' },
	{ type: 'showBanner', message: 'plain' },
	{ type: 'showError', message: 'boom', detail: 'because', actions: ['reload', 'selectData', 'editVisualization'] },
	{ type: 'showError', message: '' },
];



const MALFORMED: Array<[string, unknown, string | RegExp]> = [
	// init
	['init without a payload', { type: 'init' }, 'chart: malformed init message (payload undefined)'],
	['init with an unknown theme', { type: 'init', payload: { theme: 'purple', toolbar: toolbar(), parameters: [], overrides: {} } }, 'chart: malformed init message (theme "purple")'],
	['init without a toolbar', { type: 'init', payload: { theme: 'dark', parameters: [], overrides: {} } }, 'chart: malformed init message (toolbar undefined)'],
	['init with a toolbar without a mode', { type: 'init', payload: { theme: 'dark', toolbar: toolbar({ mode: undefined }), parameters: [], overrides: {} } }, 'chart: the toolbar has no valid mode (undefined)'],
	['init with an unknown timeframe', { type: 'init', payload: { theme: 'dark', toolbar: toolbar({ timeframe: 'bogus' }), parameters: [], overrides: {} } }, 'chart: unknown timeframe "bogus" (expected one of 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M)'],
	['init without parameters', { type: 'init', payload: { theme: 'dark', toolbar: toolbar(), overrides: {} } }, 'chart: malformed init message (parameters undefined)'],
	['init with null overrides', { type: 'init', payload: { theme: 'dark', toolbar: toolbar(), parameters: [], overrides: null } }, 'chart: malformed init message (overrides null)'],
	// setToolbar
	['setToolbar without a toolbar', { type: 'setToolbar' }, 'chart: malformed setToolbar message (toolbar undefined)'],
	['setToolbar without complexity', { type: 'setToolbar', toolbar: toolbar({ complexity: undefined }) }, 'chart: malformed setToolbar message (complexity undefined)'],
	['setToolbar with an unknown data source kind', { type: 'setToolbar', toolbar: toolbar({ dataSource: { kind: 'ftp' } }) }, 'chart: malformed setToolbar message (dataSource {"kind":"ftp"})'],
	['setToolbar with a non-boolean viewOnly', { type: 'setToolbar', toolbar: toolbar({ viewOnly: 'no' }) }, 'chart: malformed setToolbar message (viewOnly "no")'],
	['setToolbar with a half date range', { type: 'setToolbar', toolbar: toolbar({ dateRange: { start: '2024-01-01' } }) }, 'chart: malformed setToolbar message (dateRange {"start":"2024-01-01"})'],
	// setRecentSources
	['setRecentSources without sources', { type: 'setRecentSources' }, 'chart: malformed setRecentSources message (sources undefined)'],
	['setRecentSources with a local file without a path', { type: 'setRecentSources', sources: [{ kind: 'localFile', displayName: 'a' }] }, 'chart: malformed setRecentSources message (sources[0] {"kind":"localFile","displayName":"a"})'],
	['setRecentSources with a bad entry', { type: 'setRecentSources', sources: [{ kind: 'server' }] }, 'chart: malformed setRecentSources message (sources[0] {"kind":"server"})'],
	// setData (the reviewer's cases first)
	['setData requestId=1 data=undefined', { type: 'setData', requestId: 1 }, 'chart: malformed setData message (data undefined)'],
	['setData requestId=undefined data=undefined', { type: 'setData' }, 'chart: malformed setData message (requestId undefined)'],
	['setData with a NaN request id', { type: 'setData', requestId: Number.NaN, data: [] }, 'chart: malformed setData message (requestId NaN)'],
	['setData with a fractional request id', { type: 'setData', requestId: 1.5, data: [] }, 'chart: malformed setData message (requestId 1.5)'],
	['setData with a negative request id', { type: 'setData', requestId: -1, data: [] }, 'chart: malformed setData message (requestId -1)'],
	['setData with a string request id', { type: 'setData', requestId: '1', data: [] }, 'chart: malformed setData message (requestId "1")'],
	['setData with non-array data', { type: 'setData', requestId: 1, data: 'x' }, 'chart: malformed setData message (data "x")'],
	['setData with a NaN close (S5)', { type: 'setData', requestId: 1, data: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1 }, { t: 2, o: 1, h: 2, l: 0.5, c: Number.NaN }] }, 'chart: bar 1 has no finite c (c = NaN)'],
	['setData with an infinite volume (S5)', { type: 'setData', requestId: 1, data: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1, v: Infinity }] }, 'chart: bar 0 has a non-finite volume (v = Infinity)'],
	['setData with a bar missing its open', { type: 'setData', requestId: 1, data: [{ t: 1, h: 2, l: 0.5, c: 1 }] }, 'chart: bar 0 has no finite o (o = undefined)'],
	['setData with a null bar', { type: 'setData', requestId: 1, data: [null] }, 'chart: bar 0 is not an object (null)'],
	// setDataBinary
	['setDataBinary requestId=undefined count=0', { type: 'setDataBinary', buffer: new ArrayBuffer(0), count: 0 }, 'chart: malformed setDataBinary message (requestId undefined)'],
	['setDataBinary requestId=1 count=NaN', { type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48), count: Number.NaN }, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 48 bytes, count NaN)'],
	['setDataBinary requestId=NaN count=0', { type: 'setDataBinary', requestId: Number.NaN, buffer: new ArrayBuffer(0), count: 0 }, 'chart: malformed setDataBinary message (requestId NaN)'],
	['setDataBinary with an infinite count', { type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48), count: Infinity }, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 48 bytes, count Infinity)'],
	['setDataBinary with a fractional count', { type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48), count: 1.5 }, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 48 bytes, count 1.5)'],
	['setDataBinary with a negative count', { type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48), count: -1 }, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 48 bytes, count -1)'],
	['setDataBinary with a missing count', { type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48) }, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 48 bytes, count undefined)'],
	['setDataBinary whose buffer is shorter than its count', { type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(48), count: 2 }, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 48 bytes does not hold count 2 bars (96 bytes))'],
	['setDataBinary whose buffer is longer than its count', { type: 'setDataBinary', requestId: 1, buffer: new ArrayBuffer(96), count: 1 }, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 96 bytes does not hold count 1 bars (48 bytes))'],
	['setDataBinary whose buffer is not a buffer', { type: 'setDataBinary', requestId: 1, buffer: 'x', count: 1 }, 'chart: malformed setDataBinary message (buffer "x", count 1)'],
	['setDataBinary with a NaN close (S5)', { type: 'setDataBinary', requestId: 1, buffer: binary([[1000, 1, 2, 0.5, Number.NaN, 10]]), count: 1 }, 'chart: bar 0 has no finite c (c = NaN)'],
	['setDataBinary with an infinite volume (S5)', { type: 'setDataBinary', requestId: 1, buffer: binary([[1000, 1, 2, 0.5, 1.5, Infinity]]), count: 1 }, 'chart: bar 0 has a non-finite volume (v = Infinity)'],
	['setDataBinary with a NaN time', { type: 'setDataBinary', requestId: 1, buffer: binary([[Number.NaN, 1, 2, 0.5, 1.5, 10]]), count: 1 }, 'chart: bar 0 has no finite time (t = NaN)'],
	// showLoading
	['showLoading requestId=undefined', { type: 'showLoading' }, 'chart: malformed showLoading message (requestId undefined)'],
	['showLoading with a NaN request id', { type: 'showLoading', requestId: Number.NaN }, 'chart: malformed showLoading message (requestId NaN)'],
	['showLoading with a string request id', { type: 'showLoading', requestId: '1' }, 'chart: malformed showLoading message (requestId "1")'],
	// addSignal
	['addSignal without a signal', { type: 'addSignal' }, 'chart: malformed addSignal message (signal undefined)'],
	['addSignal without a type', { type: 'addSignal', signal: { t: 5 } }, 'chart: malformed addSignal message (signal {"t":5})'],
	['addSignal with a NaN time', { type: 'addSignal', signal: { t: Number.NaN, type: 'entry' } }, /^chart: malformed addSignal message \(signal /],
	['addSignal with an infinite time', { type: 'addSignal', signal: { t: Infinity, type: 'entry' } }, /^chart: malformed addSignal message \(signal /],
	['addSignal with an unknown type', { type: 'addSignal', signal: { t: 5, type: 'hold' } }, 'chart: malformed addSignal message (signal {"t":5,"type":"hold"})'],
	['addSignal with a numeric label', { type: 'addSignal', signal: { t: 5, type: 'entry', label: 7 } }, 'chart: malformed addSignal message (signal {"t":5,"type":"entry","label":7})'],
	['addSignal with a NaN price', { type: 'addSignal', signal: { t: 5, type: 'entry', price: Number.NaN } }, /^chart: malformed addSignal message \(signal /],
	// setSignals
	['setSignals without a request id', { type: 'setSignals', signals: [] }, 'chart: malformed setSignals message (requestId undefined)'],
	['setSignals without signals', { type: 'setSignals', requestId: 0 }, 'chart: malformed setSignals message (signals undefined)'],
	['setSignals with a bad entry', { type: 'setSignals', requestId: 0, signals: [{ t: 1, type: 'hold' }] }, 'chart: malformed setSignals message (signals[0] {"t":1,"type":"hold"})'],
	// setEquityCurve
	['setEquityCurve without a request id', { type: 'setEquityCurve', equity: [] }, 'chart: malformed setEquityCurve message (requestId undefined)'],
	['setEquityCurve without equity', { type: 'setEquityCurve', requestId: 0 }, 'chart: malformed setEquityCurve message (equity undefined)'],
	['setEquityCurve with a NaN value', { type: 'setEquityCurve', requestId: 0, equity: [{ t: 1, v: Number.NaN }] }, /^chart: malformed setEquityCurve message \(equity\[0\] /],
	// setVisualization
	['setVisualization without a request id', { type: 'setVisualization', commands: [] }, 'chart: malformed setVisualization message (requestId undefined)'],
	['setVisualization without commands', { type: 'setVisualization', requestId: 1 }, 'chart: visualization commands must be an array (undefined)'],
	['setVisualization with a bad option after a good command', { type: 'setVisualization', requestId: 1, commands: [PLOT_OK, PLOT_BAD] }, 'chart: series option lineWidth must be a finite number (abc)'],
	['setVisualization asking for an indicator', { type: 'setVisualization', requestId: 1, commands: [{ type: 'addIndicator', indicator: 'sma', params: {} }] }, 'chart: the chart draws no indicators (addIndicator)'],
	// setParameters, setOverrides, setComplexity, setTheme, toggleParameters, showBanner, showError
	['setParameters without parameters', { type: 'setParameters' }, 'chart: malformed setParameters message (parameters undefined)'],
	['setParameters with an id-less parameter', { type: 'setParameters', parameters: [{}] }, 'chart: malformed setParameters message (parameters[0] {})'],
	['setOverrides without overrides', { type: 'setOverrides' }, 'chart: malformed setOverrides message (overrides undefined)'],
	['setOverrides with an array', { type: 'setOverrides', overrides: [] }, 'chart: malformed setOverrides message (overrides [])'],
	['setComplexity without complexity', { type: 'setComplexity' }, 'chart: malformed setComplexity message (complexity undefined)'],
	['setComplexity with a non-numeric score', { type: 'setComplexity', complexity: { level: 'safe', score: 'x', reasons: [] } }, 'chart: malformed setComplexity message (complexity {"level":"safe","score":"x","reasons":[]})'],
	['setComplexity with an unknown level', { type: 'setComplexity', complexity: { level: 'x', score: 0, reasons: [] } }, 'chart: malformed setComplexity message (complexity {"level":"x","score":0,"reasons":[]})'],
	['setTheme with an unknown theme', { type: 'setTheme', theme: 'blue' }, 'chart: malformed setTheme message (theme "blue")'],
	['toggleParameters with a string', { type: 'toggleParameters', collapsed: 'yes' }, 'chart: malformed toggleParameters message (collapsed "yes")'],
	['showBanner without a message', { type: 'showBanner' }, 'chart: malformed showBanner message (message undefined)'],
	['showBanner with an unknown tone', { type: 'showBanner', message: 'x', tone: 'loud' }, 'chart: malformed showBanner message (tone "loud")'],
	['showError without a message', { type: 'showError' }, 'chart: malformed showError message (message undefined)'],
	['showError with a numeric detail', { type: 'showError', message: 'x', detail: 5 }, 'chart: malformed showError message (detail 5)'],
	['showError with an unknown action', { type: 'showError', message: 'x', actions: ['explode'] }, 'chart: malformed showError message (actions[0] "explode")'],
];

suite('chart messageHandler: every host message is validated before any state changes (F-CHARTS-FB2 c1 M2, S5)', () => {
	setup(() => {
		resetDom();
	});

	test('every type the host posts, in its full valid shape, is accepted', async () => {
		const h = makeObserved();
		for (const message of VALID) {
			await h.handler(message);
		}
	});

	for (const [label, message, expected] of MALFORMED) {
		test(`${label}: a named error, nothing changed, the next valid request still applies`, async () => {
			const h = makeObserved();
			// Prime: bars of request 3 are rendered, so a malformed message that advanced the request counter would show below.
			await h.handler(FRAME(3));
			const before = h.snapshot();
			await assert.rejects(h.handler(message), (error: unknown) => matches(error, expected));
			assert.strictEqual(h.snapshot(), before, 'no stub was called and no DOM changed');
			const calls = h.log.length;
			await h.handler(FRAME(4));
			assert.ok(h.log.length > calls, 'request 4 was applied (the counter was not advanced by the malformed message)');
		});
	}

	test('a valid request older than the rendered data is a deliberate silent ignore, for data, the loading pill and the visualization', async () => {
		const h = makeObserved();
		await h.handler(FRAME(3));
		await h.handler({ type: 'setVisualization', requestId: 5, commands: [] });
		const before = h.snapshot();
		await h.handler(FRAME(2));
		await h.handler({ type: 'setData', requestId: 1, data: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1 }] });
		await h.handler({ type: 'showLoading', requestId: 2 });
		await h.handler({ type: 'setVisualization', requestId: 4, commands: [] });
		assert.strictEqual(h.snapshot(), before, 'nothing changed and nothing threw');
		await h.handler({ type: 'showLoading', requestId: 3 });
		assert.notStrictEqual(h.snapshot(), before, 'an id equal to the rendered one is not stale');
	});

	test('absent optional fields are omitted: a toolbar without timeframe, range or sources, a bar without volume', async () => {
		const h = makeObserved();
		const bare = toolbar();
		delete bare.timeframe;
		delete bare.dataSource;
		await h.handler({ type: 'setToolbar', toolbar: bare });
		await h.handler({ type: 'setData', requestId: 1, data: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1 }] });
		assert.deepStrictEqual(h.log.filter(entry => entry[0] === 'chart.setTimeframe'), [], 'no timeframe is invented');
		assert.strictEqual(h.log.filter(entry => entry[0] === 'chart.setData').length, 1);
	});

	test('the table covers every message type the handler has a case for', () => {
		const covered = new Set(MALFORMED.map(([, message]) => (message as { type: string }).type));
		const valid = new Set(VALID.map(message => message.type));
		for (const type of valid) {
			assert.ok(covered.has(type as string) || type === 'showEmptyState', `no malformed case for ${String(type)}`);
		}
	});
});

// ---------------------------------------------------------------------------------------------
// M2 (webview entry): the 'theme' message
// ---------------------------------------------------------------------------------------------

suite('chart webview entry: theme message (F-CHARTS-FB2 c1 M2)', () => {
	const g = globalThis as Record<string, unknown>;
	const win = () => window as unknown as { MessageEvent: typeof MessageEvent; matchMedia?: unknown };
	const errors: string[] = [];
	const onError = (event: ErrorEvent) => { errors.push(event.message); event.preventDefault(); };

	suiteSetup(() => {
		resetDom();
		const root = document.createElement('div');
		root.id = 'chart-root';
		document.body.appendChild(root);
		g.acquireVsCodeApi = () => ({ postMessage: () => { /* the entry's 'ready' */ } });
		win().matchMedia = () => ({ matches: false });
		require('../../webview/chart/index');
		window.addEventListener('error', onError);
	});

	suiteTeardown(() => {
		window.removeEventListener('error', onError);
		delete g.acquireVsCodeApi;
		delete win().matchMedia;
	});

	function post(data: unknown): void {
		window.dispatchEvent(new (win().MessageEvent)('message', { data }));
	}

	test('a theme message without a whole theme is a named error and changes nothing; a whole one is applied', () => {
		const attr = () => document.documentElement.getAttribute('data-ql-theme');
		post({ type: 'theme', theme: { kind: 'dark', variant: 'dark', highContrast: false } });
		assert.strictEqual(attr(), 'dark');
		errors.length = 0;
		post({ type: 'theme' });
		post({ type: 'theme', theme: { kind: 'neon', variant: 'dark', highContrast: false } });
		post({ type: 'theme', theme: { kind: 'light', variant: 'dark', highContrast: 'no' } });
		assert.strictEqual(errors.length, 3);
		assert.ok(errors.every(message => message.startsWith('chart: malformed theme message (theme ')), errors.join(' | '));
		assert.strictEqual(attr(), 'dark', 'the applied theme is unchanged');
		post({ type: 'theme', theme: { kind: 'high-contrast', variant: 'light', highContrast: true } });
		assert.strictEqual(attr(), 'high-contrast');
	});
});

// ---------------------------------------------------------------------------------------------
// M2 (host side): every message the webview posts is validated before the provider changes state
// ---------------------------------------------------------------------------------------------

suite('ChartViewProvider: every webview message is validated before any state changes (F-CHARTS-FB2 c1 M2)', () => {
	setup(() => {
		vscodeShim._resetShimState();
	});

	/** Any property read on it fails the test: a validated-and-rejected message must not reach the provider's state. */
	const untouchable = (name: string) => new Proxy({}, { get: (_target, property) => { throw new Error(`${name}.${String(property)} was touched by a malformed message`); } });

	function makeProvider(): Record<string, unknown> {
		const provider = Object.create(ChartViewProvider.prototype) as Record<string, unknown>;
		return Object.assign(provider, {
			chartStateStore: untouchable('chartStateStore'),
			globalState: untouchable('globalState'),
			stateManager: untouchable('stateManager'),
			artifactCache: untouchable('artifactCache')
		});
	}

	const onMessage = (provider: Record<string, unknown>, message: unknown) =>
		(provider as unknown as { onMessage(session: unknown, message: unknown): Promise<void> }).onMessage(untouchable('session'), message);

	const MALFORMED_INBOUND: Array<[string, unknown, string]> = [
		['parameterChange without an id', { type: 'parameterChange', value: 1 }, 'quantlab chart: malformed parameterChange message (id undefined)'],
		['parameterChange with an empty id', { type: 'parameterChange', id: '', value: 1 }, 'quantlab chart: malformed parameterChange message (id "")'],
		['parameterChange without a value', { type: 'parameterChange', id: 'period' }, 'quantlab chart: malformed parameterChange message (value undefined)'],
		['selectDataSource without a path', { type: 'selectDataSource' }, 'quantlab chart: malformed selectDataSource message (filePath undefined)'],
		['selectDataSource with a numeric path', { type: 'selectDataSource', filePath: 5 }, 'quantlab chart: malformed selectDataSource message (filePath 5)'],
		['selectServerSymbol without a symbol', { type: 'selectServerSymbol', displayName: 'Apple' }, 'quantlab chart: malformed selectServerSymbol message (symbol undefined)'],
		['selectServerSymbol with a numeric display name', { type: 'selectServerSymbol', symbol: 'AAPL', displayName: 5 }, 'quantlab chart: malformed selectServerSymbol message (displayName 5)'],
		['selectServerSymbol with a numeric asset class', { type: 'selectServerSymbol', symbol: 'AAPL', displayName: 'Apple', assetClass: 5 }, 'quantlab chart: malformed selectServerSymbol message (assetClass 5)'],
		['overrideDateRange with a string', { type: 'overrideDateRange', range: 'x' }, 'quantlab chart: malformed overrideDateRange message (range "x")'],
		['overrideDateRange without an end', { type: 'overrideDateRange', range: { start: '2024-01-01' } }, 'quantlab chart: malformed overrideDateRange message (range {"start":"2024-01-01"})'],
		['overrideDateRange with an impossible date', { type: 'overrideDateRange', range: { start: '2024-13-45', end: '2024-02-01' } }, 'quantlab chart: malformed overrideDateRange message (range {"start":"2024-13-45","end":"2024-02-01"})'],
		['overrideTimeframe with an unknown interval', { type: 'overrideTimeframe', timeframe: '2D' }, 'quantlab chart: malformed overrideTimeframe message (timeframe "2D")'],
		['overrideTimeframe without an interval', { type: 'overrideTimeframe' }, 'quantlab chart: malformed overrideTimeframe message (timeframe undefined)'],
		['toggleParameters with a string', { type: 'toggleParameters', collapsed: 'yes' }, 'quantlab chart: malformed toggleParameters message (collapsed "yes")'],
		['dropFile without a path', { type: 'dropFile' }, 'quantlab chart: malformed dropFile message (filePath undefined)'],
		['dropFile with an empty path', { type: 'dropFile', filePath: '' }, 'quantlab chart: malformed dropFile message (filePath "")'],
		['dropRun without a run id', { type: 'dropRun' }, 'quantlab chart: malformed dropRun message (runId undefined)'],
		['selectTool with a number', { type: 'selectTool', tool: 5 }, 'quantlab chart: malformed selectTool message (tool 5)'],
		['chartDrawn with NaN bars', { type: 'chartDrawn', bars: Number.NaN, width: 1, height: 1 }, 'quantlab chart: malformed chartDrawn message (bars NaN)'],
		['chartDrawn with fractional bars', { type: 'chartDrawn', bars: 1.5, width: 1, height: 1 }, 'quantlab chart: malformed chartDrawn message (bars 1.5)'],
		['chartDrawn with a negative width', { type: 'chartDrawn', bars: 1, width: -1, height: 1 }, 'quantlab chart: malformed chartDrawn message (width -1)'],
		['chartDrawn with an infinite height', { type: 'chartDrawn', bars: 1, width: 1, height: Infinity }, 'quantlab chart: malformed chartDrawn message (height Infinity)'],
		['dropFile of a file the chart cannot load', { type: 'dropFile', filePath: '/ws/notes.txt' }, 'quantlab chart: only .csv and .parquet files can be dropped on the chart (notes.txt)'],
	];

	for (const [label, message, expected] of MALFORMED_INBOUND) {
		test(`${label}: shown to the user by name, no state touched`, async () => {
			await withQuietConsole(() => onMessage(makeProvider(), message));
			assert.deepStrictEqual(vscodeShim._errorMessagesSnapshot(), [expected]);
		});
	}

	test('every type the webview posts, in its real shape, is accepted by the parser unchanged', () => {
		const valid: Array<Record<string, unknown>> = [
			{ type: 'ready' }, { type: 'resetDefaults' }, { type: 'applyToCode' }, { type: 'requestFilePicker' }, { type: 'refresh' },
			{ type: 'screenshot' }, { type: 'openSettings' }, { type: 'addVisualization' }, { type: 'generateVisualization' },
			{ type: 'editVisualization' }, { type: 'toggleFullscreen' },
			{ type: 'parameterChange', id: 'period', value: 0 },
			{ type: 'parameterChange', id: 'flag', value: false },
			{ type: 'selectDataSource', filePath: '/a.csv' },
			{ type: 'selectServerSymbol', symbol: 'AAPL', displayName: 'Apple' },
			{ type: 'selectServerSymbol', symbol: 'BTC', displayName: 'Bitcoin', assetClass: 'crypto' },
			{ type: 'overrideDateRange', range: undefined },
			{ type: 'overrideDateRange', range: { start: '2024-01-01', end: '2024-02-01' } },
			{ type: 'overrideTimeframe', timeframe: '1W' },
			{ type: 'toggleParameters', collapsed: false },
			{ type: 'dropFile', filePath: '/a.parquet' },
			{ type: 'dropRun', runId: 'run-1' },
			{ type: 'selectTool', tool: null }, { type: 'selectTool', tool: 'line' },
			{ type: 'chartDrawn', bars: 0, width: 800, height: 400.5 },
		];
		for (const message of valid) {
			assert.strictEqual(parseChartInboundMessage(message), message);
		}
	});

	test('a non-object or untyped message is named, as before', async () => {
		await withQuietConsole(async () => {
			await onMessage(makeProvider(), null);
			await onMessage(makeProvider(), 'refresh');
			await onMessage(makeProvider(), { type: 'bogus' });
			await onMessage(makeProvider(), {});
		});
		assert.deepStrictEqual(vscodeShim._errorMessagesSnapshot(), [
			'quantlab chart: malformed webview message (null)',
			'quantlab chart: malformed webview message ("refresh")',
			'quantlab chart: unknown webview message type (bogus)',
			'quantlab chart: unknown webview message type (undefined)',
		]);
	});
});

// ---------------------------------------------------------------------------------------------
// M3, S5: ChartClient visualization options and the bars boundary
// ---------------------------------------------------------------------------------------------

interface ChartLog {
	calls: string[];
	lineOptions: Array<Record<string, unknown>>;
	panes: string[];
	paneHeights: Array<[string, string, number]>;
	candleData: unknown[][];
	volumeData: unknown[][];
}

suite('chartApi: visualization options and bars are validated before the chart changes (F-CHARTS-FB2 c1 M3, S5)', () => {
	let rec: ChartLog;
	const g = globalThis as Record<string, unknown>;
	const realResizeObserver = g.ResizeObserver;

	setup(() => {
		resetDom();
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
		rec = { calls: [], lineOptions: [], panes: [], paneHeights: [], candleData: [], volumeData: [] };
		const series = (kind: string) => ({
			setData(data: unknown[]) { rec.calls.push(`${kind}.setData`); if (kind === 'candle') { rec.candleData.push(data); } if (kind === 'histogram') { rec.volumeData.push(data); } },
			setMarkers() { rec.calls.push(`${kind}.setMarkers`); },
			setVisible(visible: boolean) { rec.calls.push(`${kind}.setVisible(${visible})`); }
		});
		const fake = {
			addPlugin() { },
			addCandlestickSeries: () => series('candle'),
			addHistogramSeries: () => series('histogram'),
			addLineSeries: (options: Record<string, unknown>) => { rec.calls.push('addLineSeries'); rec.lineOptions.push(options); return series('line'); },
			addAreaSeries: () => { rec.calls.push('addAreaSeries'); return series('area'); },
			getPanes: () => [],
			getPane: (id: string) => ({
				setPreserveEmptyPane() { },
				setStretchFactor: (value: number) => { rec.paneHeights.push([id, 'stretch', value]); },
				setHeight: (value: number) => { rec.paneHeights.push([id, 'height', value]); }
			}),
			addPane: () => { const id = `pane-${rec.panes.length + 1}`; rec.panes.push(id); rec.calls.push('addPane'); return id; },
			setPaneAxisOptions() { },
			onCrosshairMove: () => () => { },
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

	const plot = (options: unknown): VisualizationCommand =>
		({ type: 'plotSeries', series: 'line', data: [{ t: 1, v: 2 }], options } as unknown as VisualizationCommand);

	const INVALID_OPTIONS: Array<[string, unknown, string]> = [
		['width abc', { width: 'abc' }, 'chart: series option width must be a finite number (abc)'],
		['width NaN', { width: Number.NaN }, 'chart: series option width must be a finite number (NaN)'],
		['width Infinity', { width: Infinity }, 'chart: series option width must be a finite number (Infinity)'],
		['lineWidth abc', { lineWidth: 'abc' }, 'chart: series option lineWidth must be a finite number (abc)'],
		['lineWidth Infinity', { lineWidth: Infinity }, 'chart: series option lineWidth must be a finite number (Infinity)'],
		['paneId a number', { paneId: 5 }, 'chart: series option paneId must be a non-empty string (5)'],
		['paneId empty', { paneId: '' }, 'chart: series option paneId must be a non-empty string ("")'],
		['paneId null', { paneId: null }, 'chart: series option paneId must be a non-empty string (null)'],
		['color a number', { color: 5 }, 'chart: series option color must be a non-empty string (5)'],
		['color empty', { color: '' }, 'chart: series option color must be a non-empty string ("")'],
		['title a number', { title: 5 }, 'chart: series option title must be a string (5)'],
		['opacity a string', { opacity: 'half' }, 'chart: series option opacity must be a finite number (half)'],
		['opacity NaN', { opacity: Number.NaN }, 'chart: series option opacity must be a finite number (NaN)'],
		['opacity Infinity', { opacity: Infinity }, 'chart: series option opacity must be a finite number (Infinity)'],
		['priceLineVisible a string', { priceLineVisible: 'yes' }, 'chart: series option priceLineVisible must be a boolean ("yes")'],
		['priceLineVisible a number', { priceLineVisible: 1 }, 'chart: series option priceLineVisible must be a boolean (1)'],
		['lineStyle unknown', { lineStyle: 'zigzag' }, 'chart: unknown series lineStyle (zigzag; expected solid, dashed or dotted)'],
		['options a string', 'x', 'chart: plotSeries options must be an object ("x")'],
		['options null', null, 'chart: plotSeries options must be an object (null)'],
		['options an array', [], 'chart: plotSeries options must be an object ([])'],
	];

	for (const [label, options, expected] of INVALID_OPTIONS) {
		test(`a present invalid option (${label}) is named before any series or pane changes`, async () => {
			const c = await client();
			await c.applyVisualization([plot({ paneId: 'strategy-1', color: '#00ff00' })]);
			const before = rec.calls.slice();
			const panes = rec.panes.length;
			const lines = rec.lineOptions.length;
			const heights = rec.paneHeights.length;
			// A valid first command precedes the bad one: a per-command check would already have changed the chart.
			const batch: VisualizationCommand[] = [{ type: 'addPane', id: 'extra', height: 0.3 }, plot({ paneId: 'other', color: '#0000ff' }), plot(options)];
			await assert.rejects(c.applyVisualization(batch), (error: unknown) => matches(error, expected));
			assert.deepStrictEqual(rec.calls, before, 'no series was created, hidden, shown or filled');
			assert.strictEqual(rec.panes.length, panes, 'no pane was created');
			assert.strictEqual(rec.lineOptions.length, lines);
			assert.strictEqual(rec.paneHeights.length, heights, 'no pane was resized');
		});
	}

	const INVALID_COMMANDS: Array<[string, unknown, string | RegExp]> = [
		['addPane height NaN', { type: 'addPane', id: 'p', height: Number.NaN }, 'chart: addPane height must be a finite number above 0 (NaN)'],
		['addPane height Infinity', { type: 'addPane', id: 'p', height: Infinity }, 'chart: addPane height must be a finite number above 0 (Infinity)'],
		['addPane height 0', { type: 'addPane', id: 'p', height: 0 }, 'chart: addPane height must be a finite number above 0 (0)'],
		['addPane height negative', { type: 'addPane', id: 'p', height: -2 }, 'chart: addPane height must be a finite number above 0 (-2)'],
		['addPane height a string', { type: 'addPane', id: 'p', height: 'tall' }, 'chart: addPane height must be a finite number above 0 ("tall")'],
		['addPane height null', { type: 'addPane', id: 'p', height: null }, 'chart: addPane height must be a finite number above 0 (null)'],
		['addPane without an id', { type: 'addPane' }, 'chart: addPane id must be a non-empty string (undefined)'],
		['plotSeries of an unknown kind', { type: 'plotSeries', series: 'bar', data: [] }, 'chart: plotSeries series must be line, histogram or area ("bar")'],
		['plotSeries without data', { type: 'plotSeries', series: 'line' }, 'chart: plotSeries data must be an array (undefined)'],
		['plotSeries with an infinite value', { type: 'plotSeries', series: 'line', data: [{ t: 1, v: Infinity }] }, /^chart: plotSeries data\[0\] needs a finite t and a v that is a number/],
		['plotSeries with a null value', { type: 'plotSeries', series: 'line', data: [{ t: 1, v: null }] }, 'chart: plotSeries data[0] needs a finite t and a v that is a number, NaN being a gap ({"t":1,"v":null})'],
		['plotSeries with a NaN time', { type: 'plotSeries', series: 'line', data: [{ t: Number.NaN, v: 1 }] }, /^chart: plotSeries data\[0\] needs a finite t and a v that is a number/],
		['markEntries with a NaN time', { type: 'markEntries', entries: [{ t: Number.NaN }] }, /^chart: markEntries entries\[0\] needs a finite t/],
		['markEntries with a NaN price', { type: 'markEntries', entries: [{ t: 1, price: Number.NaN }] }, /^chart: markEntries entries\[0\] needs a finite t/],
		['markExits with a numeric label', { type: 'markExits', exits: [{ t: 1, label: 5 }] }, /^chart: markExits exits\[0\] needs a finite t/],
		['markExits without exits', { type: 'markExits' }, 'chart: markExits exits must be an array (undefined)'],
		['setEquityCurve with a NaN value', { type: 'setEquityCurve', equity: [{ t: 1, v: Number.NaN }] }, /^chart: setEquityCurve equity\[0\] needs a finite t and v /],
		['clear with an unknown target', { type: 'clear', target: 'everything' }, 'chart: clear target must be signals, equity, indicators or all ("everything")'],
		['a command without a type', {}, 'chart: visualization command 1 has no type ({})'],
	];

	for (const [label, command, expected] of INVALID_COMMANDS) {
		test(`an invalid command (${label}) is named before the chart changes`, async () => {
			const c = await client();
			await c.applyVisualization([plot(undefined)]);
			const before = rec.calls.slice();
			await assert.rejects(c.applyVisualization([plot(undefined), command as VisualizationCommand]), (error: unknown) => matches(error, expected));
			assert.deepStrictEqual(rec.calls, before);
			assert.strictEqual(rec.panes.length, 0);
			assert.strictEqual(rec.paneHeights.length, 0);
		});
	}

	test('absent options are omitted; present valid ones are applied; a valid pane height resizes', async () => {
		const c = await client();
		await c.applyVisualization([plot(undefined)]);
		assert.deepStrictEqual(rec.lineOptions[0], { priceLineVisible: false, axis: 'right' }, 'nothing is added for an absent option');
		await c.applyVisualization([plot({ color: '#112233', title: '', width: 3, opacity: 0.5, priceLineVisible: true, lineStyle: 'dotted', paneId: 'alpha' })]);
		assert.deepStrictEqual(rec.lineOptions[1], {
			priceLineVisible: true, axis: 'right', paneId: 'pane-1', color: '#112233', title: '', width: 3, opacity: 0.5, dash: [2, 4]
		});
		await c.applyVisualization([{ type: 'addPane', id: 'beta', height: 0.4 }, { type: 'addPane', id: 'gamma', height: 120 }]);
		assert.deepStrictEqual(rec.paneHeights.slice(-2), [['pane-2', 'stretch', 0.4], ['pane-3', 'height', 120]]);
		await c.applyVisualization([{ type: 'addPane', id: 'delta' }]);
		assert.deepStrictEqual(rec.paneHeights.slice(-1), [['pane-4', 'stretch', 0.25]], 'an absent height on a strategy pane is its documented 0.25');
	});

	test('a plotted NaN value is a gap (the visualization runner\'s warm-up bars), not an error', async () => {
	const c = await client();
	await c.applyVisualization([{ type: 'plotSeries', series: 'line', data: [{ t: 1, v: Number.NaN }, { t: 2, v: 5 }] }]);
	assert.strictEqual(rec.lineOptions.length, 1, 'the series was created and filled');
});

test('an options object that lacks an option omits it: no key is set to undefined, the defaults stand', async () => {
		const c = await client();
		await c.applyVisualization([plot({})]);
		assert.deepStrictEqual(rec.lineOptions[0], { priceLineVisible: false, axis: 'right' });
		await c.applyVisualization([plot({ lineWidth: 2 })]);
		assert.deepStrictEqual(rec.lineOptions[1], { priceLineVisible: false, axis: 'right', width: 2 });
		await c.applyVisualization([plot({ title: 'fast', priceLineVisible: true })]);
		assert.deepStrictEqual(rec.lineOptions[2], { priceLineVisible: true, axis: 'right', title: 'fast' });
		await c.applyVisualization([plot({ opacity: 0.4, color: '#010203' })]);
		assert.deepStrictEqual(rec.lineOptions[3], { priceLineVisible: false, axis: 'right', opacity: 0.4, color: '#010203' });
	});

	test('the pane helpers refuse an invalid height themselves (the command check is not their only guard)', async () => {
		const c = await client();
		const panes = c as unknown as { ensurePane(key: string, height?: number): string; applyPaneHeight(paneId: string, height: number): void };
		assert.throws(() => panes.ensurePane('x', Number.NaN), new Error('chart: pane height must be a finite number above 0 (NaN)'));
		assert.strictEqual(rec.panes.length, 0, 'no pane was created for an invalid height');
		assert.throws(() => panes.applyPaneHeight('pane-9', Infinity), new Error('chart: pane height must be a finite number above 0 (Infinity)'));
		assert.strictEqual(rec.paneHeights.length, 0);
	});

	test('bars: a NaN close or an infinite volume is a named error before the chart changes; an absent volume is fine', async () => {
		const c = await client();
		c.setVolumeEnabled(true);
		await c.setData(BARS);
		const before = rec.calls.slice();
		await assert.rejects(c.setData([BARS[0], { ...BARS[1], c: Number.NaN }]), new Error('chart: bar 1 has no finite c (c = NaN)'));
		await assert.rejects(c.setData([{ ...BARS[0], v: Infinity }]), new Error('chart: bar 0 has a non-finite volume (v = Infinity)'));
		await assert.rejects(c.setData([{ ...BARS[0], o: undefined as unknown as number }]), new Error('chart: bar 0 has no finite o (o = undefined)'));
		assert.deepStrictEqual(rec.calls, before, 'no series was filled by a rejected load');
		const noVolume = BARS.map(({ v: _volume, ...bar }) => bar);
		await c.setData(noVolume);
		assert.deepStrictEqual(rec.volumeData[rec.volumeData.length - 1], [], 'a bar without volume has no histogram point');
		assert.strictEqual(rec.candleData[rec.candleData.length - 1]!.length, 2, 'the candles are drawn');
	});

	test('signals and the equity curve are validated at the chart too (no silent drop of a bad signal)', async () => {
		const c = await client();
		await assert.rejects(c.setSignals([{ t: Number.NaN, type: 'entry' }]), /malformed setSignals message \(signals\[0\] /);
		await assert.rejects(c.addSignal({ t: 1, type: 'hold' } as never), /malformed addSignal message \(signal /);
		await assert.rejects(c.setEquityCurve([{ t: 1, v: Infinity }]), /malformed setEquityCurve message \(equity\[0\] /);
		assert.strictEqual(rec.calls.filter(call => call.endsWith('setMarkers')).length, 0, 'no marker pass ran');
	});
});

// ---------------------------------------------------------------------------------------------
// S4: the slider repairs the number box
// ---------------------------------------------------------------------------------------------

suite('parameterPanel: the slider repairs an invalid number entry (F-CHARTS-FB2 c1 S4)', () => {
	setup(() => {
		resetDom();
	});

	test('after an empty entry, moving the slider clears the invalid mark and commits the slider value', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const changes: Array<[string, unknown]> = [];
		const panel = new ParameterPanel(container, (id, value) => changes.push([id, value]), () => { }, () => { });
		panel.render([{ id: 'period', default: 5, min: 1, max: 10 }] as unknown as Parameters<ParameterPanel['render']>[0], {});
		const numeric = container.querySelector<HTMLInputElement>('input[type="number"]')!;
		const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
		numeric.value = '';
		numeric.dispatchEvent(new window.Event('change'));
		assert.strictEqual(numeric.getAttribute('aria-invalid'), 'true');
		assert.strictEqual(numeric.validationMessage, 'period needs a number');
		range.value = '7';
		range.dispatchEvent(new window.Event('input'));
		assert.strictEqual(numeric.value, '7');
		assert.strictEqual(numeric.getAttribute('aria-invalid'), null, 'no longer marked invalid');
		assert.strictEqual(numeric.validationMessage, '', 'no custom validity left');
		await new Promise<void>(resolve => setTimeout(resolve, 260));
		assert.deepStrictEqual(changes, [['period', 7]]);
	});
});

// ---------------------------------------------------------------------------------------------
// S6, S7: ChartViewProvider.reloadData
// ---------------------------------------------------------------------------------------------

suite('ChartViewProvider.reloadData: timeframe flow and announcement (F-CHARTS-FB2 c1 S6, S7)', () => {
	const shimExports = vscodeShim as unknown as Record<string, unknown>;
	const hadTokenSource = Object.prototype.hasOwnProperty.call(shimExports, 'CancellationTokenSource');
	const previousTokenSource = shimExports.CancellationTokenSource;

	suiteSetup(() => {
		shimExports.CancellationTokenSource = class {
			readonly token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose(): void { /* none kept */ } }) };
			cancel(): void { /* never cancelled here */ }
			dispose(): void { /* nothing held */ }
		};
	});

	suiteTeardown(() => {
		if (hadTokenSource) {
			shimExports.CancellationTokenSource = previousTokenSource;
		} else {
			delete shimExports.CancellationTokenSource;
		}
	});

	interface Posted { type: string; toolbar?: { timeframe?: string }; requestId?: number }

	interface Flow {
		reload(): Promise<void>;
		posted: Posted[];
		banners: Array<[string, string, string | undefined]>;
	}

	/**
	 * A provider whose toolbar, load and state are stubbed; reloadData, refreshToolbar, requestedTimeframe and
	 * serverTimeframeNotice are the real ones.
	 */
	function makeFlow(options: { dataSource: unknown; requested: string | undefined; toolbarTimeframe: string | undefined; effective: string }): Flow {
		const posted: Posted[] = [];
		const banners: Array<[string, string, string | undefined]> = [];
		let requestId = 0;
		const session = {
			key: 'session-1',
			document: { uri: { scheme: 'file', fsPath: '/ws/data.csv' } },
			webview: { postMessage: (message: Posted) => { posted.push(message); return true; } }
		};
		const provider = Object.create(ChartViewProvider.prototype) as Record<string, unknown>;
		Object.assign(provider, {
			sessions: new Map([[session.key, session]]),
			chartStateStore: {
				nextDataRequestId: () => ++requestId,
				isDataRequestCurrent: (_key: string, id: number) => id === requestId,
				setLastDataKey() { }
			},
			stateManager: { getChartState: () => undefined, updateChartState() { } },
			globalState: { getTimeframe: () => options.requested },
			buildToolbarState: () => ({ dataSource: options.dataSource, timeframe: options.toolbarTimeframe, complexity: COMPLEXITY, hasVisualization: false, viewOnly: true, mode: 'data' }),
			loadBars: async () => ({ data: BARS, effectiveTimeframe: options.effective, dsKey: 'k' }),
			setBanner: (_session: unknown, kind: string, message: string, tone?: string) => { banners.push([kind, message, tone]); },
			refreshVisualization: async () => { /* not under test */ }
		});
		const reloadData = (provider as unknown as { reloadData(session: unknown): Promise<void> }).reloadData.bind(provider);
		return { reload: () => reloadData(session), posted, banners };
	}

	const LOCAL = { kind: 'localFile', filePath: '/ws/data.csv', displayName: 'data.csv' };

	test('S7: a local file with no timeframe yet gets its inferred timeframe BEFORE its bars', async () => {
		const flow = makeFlow({ dataSource: LOCAL, requested: undefined, toolbarTimeframe: undefined, effective: '1H' });
		await flow.reload();
		assert.deepStrictEqual(flow.posted.map(message => message.type), ['showLoading', 'setToolbar', 'setDataBinary']);
		assert.strictEqual(flow.posted[1].toolbar!.timeframe, '1H', 'the toolbar carries the inferred timeframe, not undefined');
	});

	test('S7: switching to a source with a different inferred interval sends that interval before the new bars', async () => {
		const first = makeFlow({ dataSource: LOCAL, requested: '1D', toolbarTimeframe: '1D', effective: '1D' });
		await first.reload();
		assert.strictEqual(first.posted[1].toolbar!.timeframe, '1D');
		// The switch: the toolbar the provider builds still holds the previous source's 1D; the new bars are 15m.
		const switched = makeFlow({ dataSource: { ...LOCAL, filePath: '/ws/intraday.csv' }, requested: '1D', toolbarTimeframe: '1D', effective: '15m' });
		await switched.reload();
		assert.deepStrictEqual(switched.posted.map(message => message.type), ['showLoading', 'setToolbar', 'setDataBinary']);
		assert.strictEqual(switched.posted[1].toolbar!.timeframe, '15m');
		assert.strictEqual(switched.posted.filter(message => message.type === 'setToolbar').length, 1, 'one toolbar, not a second one after the bars');
	});

	test('S6: an explicit crypto 1W selection is announced when it is replaced by 1D; no selection, a supported one, and equities 1W are not', async () => {
		const crypto = { kind: 'server', symbol: 'BTC', displayName: 'Bitcoin', assetClass: 'crypto' };
		const equity = { kind: 'server', symbol: 'AAPL', displayName: 'Apple' };
		const announced = makeFlow({ dataSource: crypto, requested: '1W', toolbarTimeframe: '1D', effective: '1D' });
		await announced.reload();
		assert.deepStrictEqual(announced.banners, [['data', '1W bars are not available for BTC; showing 1D.', 'warning']]);
		for (const quiet of [
			makeFlow({ dataSource: crypto, requested: undefined, toolbarTimeframe: '1D', effective: '1D' }),
			makeFlow({ dataSource: crypto, requested: '1H', toolbarTimeframe: '1H', effective: '1H' }),
			makeFlow({ dataSource: equity, requested: '1W', toolbarTimeframe: '1W', effective: '1W' }),
		]) {
			await quiet.reload();
			assert.deepStrictEqual(quiet.banners, [['data', '', undefined]], 'the data banner is cleared, nothing announced');
		}
	});
});
