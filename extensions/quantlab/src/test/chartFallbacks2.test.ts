/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-CHARTS-FB2: the remaining substitutes in the chart webview and the qviz applier (inventory: hub
// folds/F-CHARTS-FB2/inventory.md). Each test removes the value a site needs and expects a named error or the defined
// behaviour that substitutes nothing; with the value present the behaviour is unchanged.

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
import { applyTimeseriesPlan } from '../qviz/render/applier';
import type { TimeseriesPlan } from '../qviz/render/types';

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

interface Recorded {
	options: CreateChartOptions | undefined;
	histogramWrites: unknown[][];
	plugins: Array<{ onRenderOverlay?: (ctx: unknown, state: unknown) => void }>;
}

suite('chart fallbacks, rest of the chart files (F-CHARTS-FB2)', () => {
	let rec: Recorded;
	const g = globalThis as Record<string, unknown>;
	const realGetComputedStyle = g.getComputedStyle as typeof getComputedStyle;
	const realResizeObserver = g.ResizeObserver;

	setup(() => {
		resetDom();
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
		rec = { options: undefined, histogramWrites: [], plugins: [] };
		const series = () => ({ setData() { }, setMarkers() { }, setVisible() { } });
		const fake = {
			addPlugin: (plugin: Recorded['plugins'][number]) => { rec.plugins.push(plugin); },
			addCandlestickSeries: series,
			addHistogramSeries: () => ({ setData: (data: unknown[]) => { rec.histogramWrites.push(data); }, setMarkers() { }, setVisible() { } }),
			addLineSeries: series,
			getPanes: () => [],
			getPane: () => null,
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
		setTestChartFactory((_container, options) => {
			rec.options = options;
			return fake as unknown as Chart;
		});
		g.ResizeObserver = class { observe() { } disconnect() { } };
	});

	teardown(() => {
		setTestChartFactory(undefined);
		g.getComputedStyle = realGetComputedStyle;
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

	function formatter(): (time: number) => string {
		return rec.options?.timeFormatter as (time: number) => string;
	}

	test('volume: a bar without volume gets no histogram point (a gap), not a zero bar', async () => {
		const c = await client();
		c.setVolumeEnabled(true);
		await c.setData([
			{ t: Date.UTC(2024, 0, 2), o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
			{ t: Date.UTC(2024, 0, 3), o: 1.5, h: 2, l: 1, c: 1.2 },
			{ t: Date.UTC(2024, 0, 4), o: 1.2, h: 2, l: 1, c: 1.8, v: 300 },
		]);
		const last = rec.histogramWrites[rec.histogramWrites.length - 1] as Array<{ t: number; v: number }>;
		assert.deepStrictEqual(last.map(p => [p.t, p.v]), [[0, 100], [2 * DAY, 300]]);
	});

	test('a bar without a finite time is named', async () => {
		const c = await client();
		await assert.rejects(c.setData([
			{ t: Date.UTC(2024, 0, 2), o: 1, h: 1, l: 1, c: 1 },
			{ t: Number.NaN, o: 1, h: 1, l: 1, c: 1 },
		]), new Error('chart: bar 1 has no finite time (t = NaN)'));
	});

	test('an unknown or empty timeframe is named; every host timeframe is accepted', async () => {
		const c = await client();
		assert.throws(() => c.setTimeframe('2D'), new Error('chart: unknown timeframe "2D" (expected one of 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M)'));
		assert.throws(() => c.setTimeframe(''), new Error('chart: unknown timeframe "" (expected one of 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M)'));
		for (const tf of ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']) {
			c.setTimeframe(tf);
		}
	});

	test('the time axis before any timeframe is named', async () => {
		const el = document.createElement('div');
		document.body.appendChild(el);
		const c = new ChartClient(el);
		await c.initialize('dark');
		assert.throws(() => formatter()(0), new Error('chart: the time axis was formatted before the host set a timeframe'));
	});

	test('an empty navigator.language is named, not replaced by en-US', async () => {
		await client();
		const nav = navigator as unknown as Record<string, unknown>;
		const own = Object.getOwnPropertyDescriptor(nav, 'language');
		Object.defineProperty(nav, 'language', { get: () => '', configurable: true });
		try {
			assert.throws(() => formatter()(0), new Error('chart: navigator.language is empty; the time axis has no locale'));
		} finally {
			if (own) {
				Object.defineProperty(nav, 'language', own);
			} else {
				delete nav.language;
			}
		}
	});

	test('an axis position outside the bars has no label (not the edge bar\'s date); inside, the nearest bar\'s', async () => {
		const c = await client();
		await c.setData([
			{ t: Date.UTC(2024, 0, 2), o: 1, h: 1, l: 1, c: 1 },
			{ t: Date.UTC(2024, 0, 3), o: 1, h: 1, l: 1, c: 1 },
		]);
		assert.strictEqual(formatter()(-DAY), '');
		assert.strictEqual(formatter()(5 * DAY), '');
		assert.match(formatter()(DAY), /3/);
	});

	test('a theme colour withAlpha cannot read is named, not drawn at full opacity', async () => {
		g.getComputedStyle = (el: Element) => {
			const real = realGetComputedStyle(el);
			if (el.tagName !== 'SPAN') {
				return real;
			}
			return { color: 'oklch(0.7 0.1 150)', fontFamily: real.fontFamily, fontSize: real.fontSize };
		};
		const c = await client();
		c.setVolumeEnabled(true);
		await assert.rejects(c.setData([
			{ t: Date.UTC(2024, 0, 2), o: 1, h: 2, l: 0.5, c: 1.5, v: 100 },
			{ t: Date.UTC(2024, 0, 3), o: 1.5, h: 2, l: 1, c: 1.2, v: 200 },
		]), new Error('chart: cannot apply alpha to colour "oklch(0.7 0.1 150)" (not #rgb, #rrggbb, rgb() or rgba())'));
	});

	test('an engine render state without a pane layout is named', async () => {
		await client();
		const overlay = rec.plugins.find(p => p.onRenderOverlay)?.onRenderOverlay;
		assert.ok(overlay, 'the pane divider plugin is installed');
		assert.throws(() => overlay!({}, { layout: {}, plotRect: { x: 0, y: 0, width: 1, height: 1 } }),
			new Error('chart: the engine render state has no pane layout'));
	});
});

suite('qviz applier autoSize (F-CHARTS-FB2)', () => {
	test('a timeseries plan without chart.autoSize is named, and no chart is created', () => {
		let created = 0;
		setTestChartFactory(() => {
			created++;
			return {} as unknown as Chart;
		});
		try {
			const plan = { chart: { theme: undefined }, series: [], diagnostics: [] } as unknown as TimeseriesPlan;
			assert.throws(() => applyTimeseriesPlan(document.createElement('div'), plan),
				new Error('qviz applier: the timeseries plan has no chart.autoSize'));
			assert.strictEqual(created, 0);
		} finally {
			setTestChartFactory(undefined);
		}
	});
});
