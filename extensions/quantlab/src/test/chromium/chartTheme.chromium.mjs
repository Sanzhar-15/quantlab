/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-CHARTS-FB2 (F-CHARTS-FB c1 S2): the chart's theme reads in headless Chromium against the product's media/tokens.css
// and representative --vscode-* host variables (the webview host sets them on <html>).
// usage (from extensions/quantlab): node src/test/chromium/chartTheme.chromium.mjs
// Exit 0 = every scenario as expected; 1 = one was not (named); 2 = the harness itself failed (bundle, browser).
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '../../..');
const stub = path.join(extension, 'test/helpers/applier-stub.ts');

const HOST = {
	'--vscode-editor-background': '#1e1e1e',
	'--vscode-editor-foreground': '#d4d4d4',
	'--vscode-font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
	'--vscode-editorGroup-border': '#444444',
	'--vscode-editorWidget-border': '#454545',
	'--vscode-focusBorder': '#007fd4',
	'--vscode-editor-inactiveSelectionBackground': '#3a3d41',
	'--vscode-editorHoverWidget-background': '#252526',
	'--vscode-editorHoverWidget-foreground': '#cccccc',
	'--vscode-editorHoverWidget-border': '#454545',
};

const SCENARIOS = [
	['valid', r => r.ok && r.created === 1
		&& r.theme.background === 'rgb(30, 30, 30)' && r.theme.axisText === 'rgb(212, 212, 212)'
		&& r.theme.seriesTertiary === 'rgb(68, 191, 110)' && r.theme.fontSizePx === 12
		// Chromium's computed font-family normalises keywords (BlinkMacSystemFont → "system-ui").
		&& r.theme.fontFamily === '-apple-system, "system-ui", sans-serif'],
	['host-background-removed', r => !r.ok && r.error === 'chart theme: token --ql-bg is not set' && r.created === 0],
	['host-font-removed', r => !r.ok && r.error === 'chart theme: token --ql-font-family is not set' && r.created === 0],
	['invalid-colour-after-valid', r => !r.ok && r.error === 'chart theme: token --vscode-focusBorder is "notacolour", not a CSS colour'],
	// The first entry is createChart clearing the (absent) watermark; while hidden, setWatermark sets nothing; the real
	// ResizeObserver applies it once the 600 px container is shown.
	['watermark-hidden-then-shown', r => r.ok && r.watermarks.length === 2 && r.watermarks[0] === null
		&& r.watermarks[1].text === 'AAPL' && r.watermarks[1].fontSizePx === 100],
];

let bundle;
let browser;
try {
	const out = await build({
		entryPoints: [path.join(here, 'chartTheme.entry.ts')],
		bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
		plugins: [{
			name: 'charts-plus-stub',
			setup(b) { b.onResolve({ filter: /^@charts-plus\// }, () => ({ path: stub })); },
		}],
	});
	bundle = out.outputFiles[0].text;
	browser = await chromium.launch({ headless: true });
} catch (error) {
	console.error(`chartTheme.chromium: harness failed: ${error.stack}`);
	process.exit(2);
}

const tokens = readFileSync(path.join(extension, 'media/tokens.css'), 'utf8');
const hostStyle = Object.entries(HOST).map(([k, v]) => `${k}: ${v}`).join('; ');
const html = `<!DOCTYPE html><html style="${hostStyle}"><head><style>${tokens}</style></head>`
	+ '<body><div id="chart" style="width: 600px; height: 300px"></div></body></html>';

let failed = 0;
try {
	console.log(`chromium ${browser.version()}`);
	for (const [name, expect] of SCENARIOS) {
		const page = await browser.newPage();
		await page.setContent(html);
		await page.addScriptTag({ content: bundle });
		const result = await page.evaluate(scenario => window.chartThemeRun(scenario), name);
		await page.close();
		const pass = expect(result);
		if (!pass) {
			failed++;
		}
		console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(result)}`);
	}
} finally {
	await browser.close();
}
console.log(`chartTheme.chromium: ${SCENARIOS.length - failed} of ${SCENARIOS.length} as expected`);
process.exit(failed === 0 ? 0 : 1);
