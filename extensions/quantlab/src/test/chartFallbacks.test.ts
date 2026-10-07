/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-CHARTS-FB: the chart webview (webview/chart/chartApi.ts) and the qviz applier (src/qviz/render/applier.ts) read
// values that must exist. A missing theme token, an unresolvable colour, font or size, or a chart without a disposal
// method is a named error; a not-yet-laid-out container defers the watermark; empty data is a defined empty chart.

// `chartApi.ts` and `applier.ts` import `@charts-plus/*`, which are not on the plain-mocha path: route them to the
// stub before those imports resolve (the same hook as qviz-renderer-host.test.ts).
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

import 'mocha';
import * as assert from 'assert';
import { resetDom } from '../../test/helpers/jsdom-shim';
import { setTestChartFactory, type Chart, type CreateChartOptions } from '../../test/helpers/applier-stub';
import { ChartClient } from '../../webview/chart/chartApi';
import { disposeChart } from '../qviz/render/applier';

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

function setTokens(tokens: Record<string, string>): void {
	for (const [name, value] of Object.entries(tokens)) {
		document.documentElement.style.setProperty(name, value);
	}
}

interface FakeChart {
	chart: Chart;
	themes: unknown[];
	watermarks: Array<{ fontSizePx: number; text: string; color: string } | null>;
	options: CreateChartOptions | undefined;
	created: number;
	seriesWrites: number;
}

function fakeChart(): FakeChart {
	const record: FakeChart = { chart: undefined as unknown as Chart, themes: [], watermarks: [], options: undefined, created: 0, seriesWrites: 0 };
	const series = () => ({ setData() { record.seriesWrites++; }, setMarkers() { }, setVisible() { } });
	record.chart = {
		addPlugin() { },
		addCandlestickSeries: series,
		addHistogramSeries: series,
		addLineSeries: series,
		addAreaSeries: series,
		getPanes: () => [],
		getPane: () => null,
		addPane: () => 'pane-1',
		setPaneAxisOptions() { },
		onCrosshairMove: () => () => { },
		setVisibleTimeRange() { },
		getVisibleTimeRange: () => ({ from: 0, to: 0 }),
		batch: (fn: () => void) => fn(),
		setTheme: (theme: unknown) => { record.themes.push(theme); },
		setWatermark: (options: { fontSizePx: number; text: string; color: string } | null) => { record.watermarks.push(options); },
		destroy() { },
	} as unknown as Chart;
	return record;
}

suite('chart fallbacks (F-CHARTS-FB)', () => {
	let fake: FakeChart;
	let resizeCallbacks: Array<() => void>;
	const g = globalThis as Record<string, unknown>;
	const realGetComputedStyle = g.getComputedStyle as typeof getComputedStyle;
	const realResizeObserver = g.ResizeObserver;

	function container(width: number): HTMLElement & { width: number } {
		const el = document.createElement('div') as unknown as HTMLElement & { width: number };
		el.width = width;
		Object.defineProperty(el, 'clientWidth', { get: () => el.width, configurable: true });
		document.body.appendChild(el);
		return el;
	}

	/** Replaces one computed property of the probe span (the chart's theme probe) with `value`. */
	function computedOnSpans(property: 'color' | 'fontFamily' | 'fontSize', value: string): void {
		g.getComputedStyle = (el: Element) => {
			const real = realGetComputedStyle(el);
			if (el.tagName !== 'SPAN') {
				return real;
			}
			return { color: real.color, fontFamily: real.fontFamily, fontSize: real.fontSize, [property]: value };
		};
	}

	setup(() => {
		resetDom();
		setTokens(TOKENS);
		fake = fakeChart();
		setTestChartFactory((_container, options) => {
			fake.options = options;
			fake.created++;
			return fake.chart;
		});
		resizeCallbacks = [];
		g.ResizeObserver = class {
			constructor(cb: () => void) { resizeCallbacks.push(cb); }
			observe() { }
			disconnect() { }
		};
	});

	teardown(() => {
		setTestChartFactory(undefined);
		g.getComputedStyle = realGetComputedStyle;
		g.ResizeObserver = realResizeObserver;
	});

	test('every token set: the chart theme is the tokens\' computed values', async () => {
		const client = new ChartClient(container(600));
		await client.initialize('dark');
		const theme = fake.themes[fake.themes.length - 1] as Record<string, unknown>;
		assert.strictEqual(theme.background, 'rgb(30, 30, 30)');
		assert.strictEqual(theme.axisText, 'rgb(212, 212, 212)');
		assert.strictEqual(theme.crosshair, 'rgb(0, 127, 212)');
		assert.strictEqual(theme.tooltipBorder, 'rgb(69, 69, 69)');
		assert.strictEqual(theme.seriesPrimary, 'rgb(37, 99, 235)');
		assert.strictEqual(theme.fontFamily, 'Menlo, monospace');
		assert.strictEqual(theme.fontSizePx, 13);
	});

	for (const name of Object.keys(TOKENS)) {
		test(`token ${name} removed: initialize and every later data call name it; no chart is created`, async () => {
			document.documentElement.style.removeProperty(name);
			const client = new ChartClient(container(600));
			const named = new Error(`chart theme: token ${name} is not set`);
			await assert.rejects(client.initialize('dark'), named);
			await assert.rejects(client.setData([{ t: 1, o: 1, h: 1, l: 1, c: 1 }]), named);
			assert.strictEqual(fake.created, 0, 'no engine chart is created without a complete theme');
			assert.strictEqual(fake.seriesWrites, 0, 'no series is written');
		});
	}

	test('token removed before a theme change: setTheme names it', async () => {
		const client = new ChartClient(container(600));
		await client.initialize('dark');
		document.documentElement.style.removeProperty('--vscode-editorGroup-border');
		assert.throws(() => client.setTheme('light'), new Error('chart theme: token --vscode-editorGroup-border is not set'));
	});

	test('a token that is not a colour is named, not replaced by the previous colour', async () => {
		document.documentElement.style.setProperty('--ql-status-negative', 'not-a-colour');
		const client = new ChartClient(container(600));
		await assert.rejects(client.initialize('dark'),
			new Error('chart theme: token --ql-status-negative is "not-a-colour", not a CSS colour'));
	});

	test('a colour with no computed value is named', async () => {
		computedOnSpans('color', '');
		const client = new ChartClient(container(600));
		await assert.rejects(client.initialize('dark'),
			new Error('chart theme: token --ql-status-positive ("#44BF6E") has no computed colour'));
	});

	test('a font family with no computed value is named', async () => {
		computedOnSpans('fontFamily', '');
		const client = new ChartClient(container(600));
		await assert.rejects(client.initialize('dark'),
			new Error('chart theme: token --ql-font-family ("Menlo, monospace") has no computed font family'));
	});

	test('a font size that is not a CSS size is named', async () => {
		document.documentElement.style.setProperty('--ql-font-size-base', 'banana');
		const client = new ChartClient(container(600));
		await assert.rejects(client.initialize('dark'),
			new Error('chart theme: token --ql-font-size-base is "banana", not a CSS font size'));
	});

	test('a font size with no computed pixel value is named', async () => {
		computedOnSpans('fontSize', 'medium');
		const client = new ChartClient(container(600));
		await assert.rejects(client.initialize('dark'),
			new Error('chart theme: token --ql-font-size-base ("13px") has no computed pixel size (got "medium")'));
	});

	test('watermark: a container with no width yet gets none; it is applied, sized from the width, once laid out', async () => {
		const el = container(0);
		const client = new ChartClient(el);
		await client.initialize('dark');
		client.setWatermark('AAPL');
		assert.deepStrictEqual(fake.watermarks.filter(w => w !== null), [], 'no watermark before the container has a width');
		el.width = 600;
		for (const cb of resizeCallbacks) {
			cb();
		}
		const applied = fake.watermarks[fake.watermarks.length - 1];
		assert.strictEqual(applied?.text, 'AAPL');
		assert.strictEqual(applied?.fontSizePx, 100);
		assert.strictEqual(applied?.color, 'rgb(212, 212, 212)');
	});

	test('watermark: a laid-out container sizes it as before (clamped 48..160)', async () => {
		const el = container(1200);
		const client = new ChartClient(el);
		await client.initialize('dark');
		client.setWatermark('AAPL');
		assert.strictEqual(fake.watermarks[fake.watermarks.length - 1]?.fontSizePx, 160);
		el.width = 120;
		client.setWatermark('MSFT');
		assert.strictEqual(fake.watermarks[fake.watermarks.length - 1]?.fontSizePx, 48);
	});

	test('setData([]) is a defined empty chart: the time axis formats, and data after it maps again', async () => {
		const client = new ChartClient(container(600));
		client.setTimeframe('1D');
		await client.initialize('dark');
		const timeFormatter = fake.options?.timeFormatter as (time: number) => string;
		await client.setData([]);
		assert.strictEqual(typeof timeFormatter(0), 'string');
		await client.setData([
			{ t: Date.UTC(2024, 0, 2), o: 1, h: 2, l: 0.5, c: 1.5 },
			{ t: Date.UTC(2024, 0, 3), o: 1.5, h: 2, l: 1, c: 1.8 },
		]);
		assert.match(timeFormatter(0), /2024/);
	});
});

suite('qviz disposeChart (F-CHARTS-FB)', () => {
	setup(() => {
		resetDom();
	});

	test('destroys the chart, then clears the container', () => {
		const el = document.createElement('div');
		el.appendChild(document.createElement('canvas'));
		let destroyed = 0;
		disposeChart({ destroy: () => { destroyed++; } } as unknown as Chart, el);
		assert.strictEqual(destroyed, 1);
		assert.strictEqual(el.childNodes.length, 0);
	});

	test('a chart without destroy() is named, and the container is left as it was', () => {
		const el = document.createElement('div');
		el.appendChild(document.createElement('canvas'));
		assert.throws(() => disposeChart({} as unknown as Chart, el), new Error('qviz disposeChart: the chart has no destroy() method'));
		assert.strictEqual(el.childNodes.length, 1);
	});
});
