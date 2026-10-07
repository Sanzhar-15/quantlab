/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-CHARTS-FB3 (F-CHARTS-FB2 c2 MUST C2-3): a bar's volume keeps its absence through the provider -> webview binary
// transfer. Absent stays absent (no histogram point), an explicit 0 stays 0, and a null or non-finite volume or a
// non-finite t/o/h/l/c is a named error before anything is encoded or changed.

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
import { ChartClient } from '../../webview/chart/chartApi';
import { createMessageHandler } from '../../webview/chart/messageHandler';
import { ChartViewProvider } from '../views/chart/ChartViewProvider';
import { decodeOhlcvBuffer, encodeOhlcvBars } from '../utils/binaryTransfer';
import type { OhlcvBar } from '../types/chart';

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

const T0 = Date.UTC(2024, 0, 2);
const DAY = 86_400_000;

/** Three bars: a volume, an explicit zero, and no volume at all. */
const MIXED: OhlcvBar[] = [
	{ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
	{ t: T0 + DAY, o: 1.5, h: 2, l: 1, c: 1.2, v: 0 },
	{ t: T0 + 2 * DAY, o: 1.2, h: 2.5, l: 1, c: 2 },
];

function matches(error: unknown, expected: string | RegExp): boolean {
	assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
	if (typeof expected === 'string') {
		assert.strictEqual(error.message, expected);
	} else {
		assert.match(error.message, expected);
	}
	return true;
}

/** Run fn with console.error silenced (a named error is logged before it is shown; the tests assert the shown one). */
async function withQuietConsole<T>(fn: () => Promise<T>): Promise<T> {
	const real = console.error;
	console.error = () => { /* silenced for fn only */ };
	try {
		return await fn();
	} finally {
		console.error = real;
	}
}

// ---------------------------------------------------------------------------------------------
// The encoder and the decoder
// ---------------------------------------------------------------------------------------------

suite('binaryTransfer: volume absence survives the transfer (F-CHARTS-FB3)', () => {
	test('a round trip keeps an absent volume absent (no v property) and an explicit 0 as 0', () => {
		const encoded = encodeOhlcvBars(MIXED);
		assert.strictEqual(encoded.count, 3);
		assert.strictEqual(encoded.buffer.byteLength, 3 * 6 * Float64Array.BYTES_PER_ELEMENT, 'the stride stays 6');
		const decoded = decodeOhlcvBuffer(encoded.buffer, encoded.count);
		assert.deepStrictEqual(decoded, MIXED);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(decoded[2], 'v'), false, 'the absent volume has no v property at all');
		assert.strictEqual(decoded[1].v, 0, 'an explicit 0 is a 0');
	});

	test('the absent volume is written as NaN in the volume slot and nothing else is', () => {
		const view = new Float64Array(encodeOhlcvBars(MIXED).buffer);
		assert.strictEqual(view[5], 100);
		assert.strictEqual(view[11], 0);
		assert.ok(Number.isNaN(view[17]));
		assert.ok([...view].every((value, i) => i === 17 || Number.isFinite(value)), 'every other slot is a finite number');
	});

	const BAR = { t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 };
	const REJECTED: Array<[string, OhlcvBar[], string]> = [
		['a null volume', [BAR, { ...BAR, v: null as unknown as number }], 'binaryTransfer: bar 1 has an invalid volume (v = null; a volume is absent or a finite number)'],
		['a NaN volume', [{ ...BAR, v: Number.NaN }], 'binaryTransfer: bar 0 has an invalid volume (v = NaN; a volume is absent or a finite number)'],
		['an infinite volume', [{ ...BAR, v: Infinity }], 'binaryTransfer: bar 0 has an invalid volume (v = Infinity; a volume is absent or a finite number)'],
		['a negative-infinite volume', [{ ...BAR, v: -Infinity }], 'binaryTransfer: bar 0 has an invalid volume (v = -Infinity; a volume is absent or a finite number)'],
		['a string volume', [{ ...BAR, v: '5' as unknown as number }], 'binaryTransfer: bar 0 has an invalid volume (v = 5; a volume is absent or a finite number)'],
		['a NaN time', [BAR, BAR, { ...BAR, t: Number.NaN }], 'binaryTransfer: bar 2 has no finite t (t = NaN)'],
		['an infinite open', [{ ...BAR, o: Infinity }], 'binaryTransfer: bar 0 has no finite o (o = Infinity)'],
		['a NaN high', [{ ...BAR, h: Number.NaN }], 'binaryTransfer: bar 0 has no finite h (h = NaN)'],
		['a missing low', [{ ...BAR, l: undefined as unknown as number }], 'binaryTransfer: bar 0 has no finite l (l = undefined)'],
		['a null close', [{ ...BAR, c: null as unknown as number }], 'binaryTransfer: bar 0 has no finite c (c = null)'],
		['a string close', [{ ...BAR, c: '1' as unknown as number }], 'binaryTransfer: bar 0 has no finite c (c = 1)'],
		['a null bar', [BAR, null as unknown as OhlcvBar], 'binaryTransfer: bar 1 is not an object (null)'],
	];

	for (const [label, bars, expected] of REJECTED) {
		test(`the encoder rejects ${label} by name, the bar index and the field`, () => {
			assert.throws(() => encodeOhlcvBars(bars), (error: unknown) => matches(error, expected));
		});
	}

	test('the encoder checks every bar before it writes any: a late bad bar fails the whole encoding', () => {
		const many = Array.from({ length: 50 }, (_, i) => ({ ...BAR, t: T0 + i * DAY }));
		many.push({ ...BAR, v: Infinity });
		assert.throws(() => encodeOhlcvBars(many), (error: unknown) => matches(error, 'binaryTransfer: bar 50 has an invalid volume (v = Infinity; a volume is absent or a finite number)'));
	});

	test('an empty list encodes to an empty buffer', () => {
		const encoded = encodeOhlcvBars([]);
		assert.strictEqual(encoded.count, 0);
		assert.strictEqual(encoded.buffer.byteLength, 0);
		assert.deepStrictEqual(decodeOhlcvBuffer(encoded.buffer, 0), []);
	});
});

// ---------------------------------------------------------------------------------------------
// Provider-produced binary messages, driven into the real message handler and the real ChartClient
// ---------------------------------------------------------------------------------------------

interface ChartLog {
	calls: string[];
	candleData: unknown[][];
	volumeData: Array<Array<{ t: number; v: number }>>;
}

suite('provider binary messages -> the real messageHandler -> the real ChartClient (F-CHARTS-FB3)', () => {
	let rec: ChartLog;
	let handler: (message: unknown) => Promise<void>;
	let dom: HTMLElement[];
	const g = globalThis as Record<string, unknown>;
	const realResizeObserver = g.ResizeObserver;

	setup(async () => {
		resetDom();
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
		rec = { calls: [], candleData: [], volumeData: [] };
		const series = (kind: string) => ({
			setData(data: unknown[]) {
				rec.calls.push(`${kind}.setData`);
				if (kind === 'candle') { rec.candleData.push(data); }
				if (kind === 'histogram') { rec.volumeData.push(data as Array<{ t: number; v: number }>); }
			},
			setMarkers() { rec.calls.push(`${kind}.setMarkers`); },
			setVisible(visible: boolean) { rec.calls.push(`${kind}.setVisible(${visible})`); }
		});
		const fake = {
			addPlugin() { },
			addCandlestickSeries: () => series('candle'),
			addHistogramSeries: () => series('histogram'),
			addLineSeries: () => series('line'),
			addAreaSeries: () => series('area'),
			getPanes: () => [],
			getPane: () => ({ setPreserveEmptyPane() { }, setStretchFactor() { }, setHeight() { } }),
			addPane: () => 'pane-1',
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

		const host = document.createElement('div');
		document.body.appendChild(host);
		const chart = new ChartClient(host);
		chart.setTimeframe('1D');
		await chart.initialize('dark');
		chart.setVolumeEnabled(true);

		const noop = () => { /* not under test */ };
		dom = ['banner', 'loading', 'emptyState', 'errorOverlay', 'errorMessage', 'errorActions', 'panelRoot', 'noViz'].map(() => document.createElement('div'));
		const [banner, loading, emptyState, errorOverlay, errorMessage, errorActions, panelRoot, noViz] = dom;
		handler = createMessageHandler({
			postMessage: noop,
			chart,
			parameterPanel: { render: noop, setOverrides: noop },
			banner,
			noViz,
			applyMode: noop,
			marketHeader: { setSource: noop, setTimeframe: noop, updateFromBars: noop, setRange: noop },
			legend: { setSymbol: noop, setBars: noop },
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
			panelRoot,
			errorOverlay,
			errorMessage,
			errorActions
		} as unknown as Parameters<typeof createMessageHandler>[0]) as (message: unknown) => Promise<void>;
	});

	teardown(() => {
		setTestChartFactory(undefined);
		g.ResizeObserver = realResizeObserver;
	});

	/** The message the provider posts for these bars: encodeOhlcvBars' output, as reloadData builds it. */
	function providerMessage(requestId: number, bars: OhlcvBar[]): { type: 'setDataBinary'; requestId: number; buffer: ArrayBuffer; count: number } {
		const { buffer, count } = encodeOhlcvBars(bars);
		return { type: 'setDataBinary', requestId, buffer, count };
	}

	test('an absent volume gets no histogram point; an explicit 0 gets a 0 point; the candles are all drawn', async () => {
		await handler(providerMessage(1, MIXED));
		const volume = rec.volumeData[rec.volumeData.length - 1];
		// The chart remaps bar times onto its own axis, so the points are told apart by their volume and count.
		assert.deepStrictEqual(volume.map(point => point.v), [100, 0], 'the third bar has no point, the second has a 0 point');
		assert.strictEqual(rec.candleData[rec.candleData.length - 1].length, 3);
	});

	test('bars that all lack a volume give an empty histogram, not zeros', async () => {
		await handler(providerMessage(1, MIXED.map(({ v: _volume, ...bar }) => bar)));
		assert.deepStrictEqual(rec.volumeData[rec.volumeData.length - 1], []);
	});

	test('a buffer whose volume slot is infinite is a named error and nothing is changed', async () => {
		await handler(providerMessage(1, MIXED));
		const calls = rec.calls.slice();
		const frame = providerMessage(2, MIXED);
		new Float64Array(frame.buffer)[5] = Infinity;
		await assert.rejects(handler(frame), (error: unknown) => matches(error, 'chart: bar 0 has a non-finite volume (v = Infinity)'));
		assert.deepStrictEqual(rec.calls, calls, 'no series was filled');
	});

	test('a malformed buffer (the wrong length for its count) is a named error and nothing is changed', async () => {
		await handler(providerMessage(1, MIXED));
		const calls = rec.calls.slice();
		const frame = providerMessage(2, MIXED);
		await assert.rejects(handler({ ...frame, count: 4 }), (error: unknown) => matches(error, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 144 bytes does not hold count 4 bars (192 bytes))'));
		await assert.rejects(handler({ ...frame, buffer: frame.buffer.slice(0, 100) }), (error: unknown) => matches(error, 'chart: malformed setDataBinary message (buffer ArrayBuffer of 100 bytes does not hold count 3 bars (144 bytes))'));
		assert.deepStrictEqual(rec.calls, calls, 'no series was filled');
		await handler(providerMessage(2, MIXED));
		assert.ok(rec.calls.length > calls.length, 'request 2 still applies: the rejected ones did not advance the request counter');
	});

	test('a null volume never reaches the chart: the encoder rejects it, so there is no message to send', async () => {
		await handler(providerMessage(1, MIXED));
		const calls = rec.calls.slice();
		assert.throws(() => providerMessage(2, [MIXED[0], { ...MIXED[1], v: null as unknown as number }]), (error: unknown) => matches(error, 'binaryTransfer: bar 1 has an invalid volume (v = null; a volume is absent or a finite number)'));
		assert.deepStrictEqual(rec.calls, calls);
	});
});

// ---------------------------------------------------------------------------------------------
// The real ChartViewProvider.reloadData
// ---------------------------------------------------------------------------------------------

suite('ChartViewProvider.reloadData: a bar with a null volume is shown as an error, never sent (F-CHARTS-FB3)', () => {
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

	interface Posted { type: string; message?: string; detail?: string; buffer?: ArrayBuffer; count?: number }

	/** The provider's toolbar timeframe is 1D; `effectiveTimeframe` is what the loaded bars are, and the tab is an active one. */
	function makeFlow(initial: OhlcvBar[], effectiveTimeframe: string): {
		reload(): Promise<void>;
		setBars(bars: OhlcvBar[]): void;
		posted: Posted[];
		stateUpdates: Array<[string, unknown]>;
	} {
		const posted: Posted[] = [];
		const stateUpdates: Array<[string, unknown]> = [];
		let data = initial;
		let requestId = 0;
		const session = {
			key: 'session-1',
			tabInstanceId: 'tab-1',
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
			stateManager: { getChartState: () => undefined, updateChartState: (tab: string, update: unknown) => { stateUpdates.push([tab, update]); } },
			globalState: { getTimeframe: () => undefined },
			buildToolbarState: () => ({
				dataSource: { kind: 'localFile', filePath: '/ws/data.csv', displayName: 'data.csv' }, timeframe: '1D',
				complexity: { level: 'safe', score: 0, reasons: [] }, hasVisualization: false, viewOnly: true, mode: 'data'
			}),
			loadBars: async () => ({ data, effectiveTimeframe, dsKey: 'k' }),
			setBanner() { },
			refreshVisualization: async () => { /* not under test */ }
		});
		const reloadData = (provider as unknown as { reloadData(session: unknown): Promise<void> }).reloadData.bind(provider);
		return { reload: () => reloadData(session), setBars: bars => { data = bars; }, posted, stateUpdates };
	}

	test('bars with an absent and an explicit 0 volume are posted as a binary message that decodes with the absence kept', async () => {
		const flow = makeFlow(MIXED, '1D');
		await flow.reload();
		const bars = flow.posted.filter(message => message.type === 'setDataBinary');
		assert.strictEqual(bars.length, 1);
		assert.deepStrictEqual(decodeOhlcvBuffer(bars[0].buffer!, bars[0].count!), MIXED);
	});

	test('a null volume posts a showError naming the bar and no bars', async () => {
		const flow = makeFlow([MIXED[0], { ...MIXED[1], v: null as unknown as number }], '1D');
		await withQuietConsole(() => flow.reload());
		assert.strictEqual(flow.posted.filter(message => message.type === 'setDataBinary').length, 0, 'no bars were sent');
		const errors = flow.posted.filter(message => message.type === 'showError');
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].detail?.includes('binaryTransfer: bar 1 has an invalid volume (v = null;'), `the error carries the named cause (${String(errors[0].detail)})`);
	});

	test('invalid bars with a changed effective timeframe persist no timeframe, post no toolbar and no bars; the next valid load persists it', async () => {
		const flow = makeFlow([MIXED[0], { ...MIXED[1], v: null as unknown as number }], '1H');
		await withQuietConsole(() => flow.reload());
		assert.deepStrictEqual(flow.posted.map(message => message.type), ['showLoading', 'showError'], 'one named error, no toolbar and no bars');
		assert.ok(flow.posted[1].detail?.includes('binaryTransfer: bar 1 has an invalid volume (v = null;'), 'the error names the cause');
		assert.deepStrictEqual(flow.stateUpdates, [], 'the tab\'s timeframe was not persisted');
		flow.setBars(MIXED);
		await flow.reload();
		assert.deepStrictEqual(flow.stateUpdates, [['tab-1', { timeframe: '1H' }]], 'a valid load persists the effective timeframe');
		assert.deepStrictEqual(flow.posted.slice(-2).map(message => message.type), ['setToolbar', 'setDataBinary']);
	});
});
