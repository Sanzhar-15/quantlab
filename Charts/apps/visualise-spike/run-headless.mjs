// Headless runner for the visualise spike. Uses the perf-harness's
// installed Playwright. Captures window.__spikeResult and prints as JSON.

import { chromium } from 'playwright';

const url = process.env.SPIKE_URL ?? 'http://localhost:5176/';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

const consoleLines = [];
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));

await page.goto(url, { waitUntil: 'load' });

await page.waitForFunction(() => (window).__spikeDone === true, { timeout: 60_000 });

const result = await page.evaluate(() => (window).__spikeResult);
console.log('=== SPIKE A RESULT ===');
console.log(JSON.stringify(result, null, 2));

if (result?.errors?.length) {
  console.log('\n=== console transcript ===');
  console.log(consoleLines.join('\n'));
}

await browser.close();
