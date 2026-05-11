// Headless runner for the qviz general (Vega-Lite) demo.
// Mirrors run-qviz-demo.mjs; targets the Phase 4 integration page.

import { chromium } from 'playwright';

const url = process.env.QVIZ_GENERAL_DEMO_URL ?? 'http://localhost:5176/qviz-general-demo.html';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

const consoleLines = [];
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));

await page.goto(url, { waitUntil: 'load' });

await page.waitForFunction(() => (window).__qvizGeneralDemoDone === true, { timeout: 60_000 });

const result = await page.evaluate(() => (window).__qvizGeneralDemoResult);
console.log('=== QVIZ GENERAL DEMO RESULT ===');
console.log(JSON.stringify(result, null, 2));

if (result?.error) {
	console.log('\n=== console transcript ===');
	console.log(consoleLines.join('\n'));
	process.exitCode = 1;
}

if (!result?.hasCanvas) {
	console.log('\n=== canvas not painted ===');
	console.log(consoleLines.join('\n'));
	process.exitCode = 1;
}

await browser.close();
