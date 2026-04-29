// Headless runner for the qviz spec->chart demo. Captures __qvizDemoResult.

import { chromium } from 'playwright';

const url = process.env.QVIZ_DEMO_URL ?? 'http://localhost:5176/qviz-demo.html';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

const consoleLines = [];
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));

await page.goto(url, { waitUntil: 'load' });

await page.waitForFunction(() => (window).__qvizDemoDone === true, { timeout: 60_000 });

const result = await page.evaluate(() => (window).__qvizDemoResult);
console.log('=== QVIZ DEMO RESULT ===');
console.log(JSON.stringify(result, null, 2));

if (result?.error) {
	console.log('\n=== console transcript ===');
	console.log(consoleLines.join('\n'));
	process.exitCode = 1;
}

await browser.close();
