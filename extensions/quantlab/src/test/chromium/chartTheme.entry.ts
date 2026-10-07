/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-CHARTS-FB2 (F-CHARTS-FB c1 S2): the page side of chartTheme.chromium.mjs. Bundled by esbuild with `@charts-plus/*`
// routed to the test stub, loaded in headless Chromium next to the product's media/tokens.css, so ChartClient reads its
// theme through Chromium's real CSS variable resolution. One scenario per page load.

import { setTestChartFactory, type Chart } from '../../../test/helpers/applier-stub';
import { ChartClient } from '../../../webview/chart/chartApi';

interface ScenarioResult {
	ok: boolean;
	error?: string;
	theme?: Record<string, unknown>;
	watermarks: Array<{ fontSizePx: number; text: string } | null>;
	created: number;
}

async function run(scenario: string): Promise<ScenarioResult> {
	const result: ScenarioResult = { ok: false, watermarks: [], created: 0 };
	const series = () => ({ setData() { }, setMarkers() { }, setVisible() { } });
	setTestChartFactory(() => {
		result.created++;
		const fake = {
			addPlugin() { },
			addCandlestickSeries: series,
			addHistogramSeries: series,
			addLineSeries: series,
			getPanes: () => [],
			getPane: () => null,
			addPane: () => 'pane-1',
			setPaneAxisOptions() { },
			onCrosshairMove: () => () => { },
			setVisibleTimeRange() { },
			getVisibleTimeRange: () => ({ from: 0, to: 0 }),
			batch: (fn: () => void) => fn(),
			setTheme: (theme: Record<string, unknown>) => { result.theme = theme; },
			setWatermark: (options: { fontSizePx: number; text: string } | null) => { result.watermarks.push(options); },
			destroy() { },
		};
		return fake as unknown as Chart;
	});
	const root = document.documentElement.style;
	if (scenario === 'host-background-removed') {
		root.removeProperty('--vscode-editor-background');
	} else if (scenario === 'host-font-removed') {
		root.removeProperty('--vscode-font-family');
	} else if (scenario === 'invalid-colour-after-valid') {
		// Read after several valid colours (the status colours, --ql-bg, --ql-fg ...): an uncleared probe would keep the
		// previous colour and return it for this token.
		root.setProperty('--vscode-focusBorder', 'notacolour');
	} else if (scenario !== 'valid' && scenario !== 'watermark-hidden-then-shown') {
		throw new Error(`chartTheme.entry: unknown scenario ${scenario}`);
	}
	const container = document.getElementById('chart') as HTMLElement;
	if (scenario === 'watermark-hidden-then-shown') {
		container.style.display = 'none';
	}
	const client = new ChartClient(container);
	try {
		await client.initialize('dark');
		if (scenario === 'watermark-hidden-then-shown') {
			client.setWatermark('AAPL');
			container.style.display = 'block';
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		result.ok = true;
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
	}
	return result;
}

(window as unknown as { chartThemeRun: typeof run }).chartThemeRun = run;
