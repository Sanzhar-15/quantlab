import { createHash } from 'crypto';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContextOptions } from '@playwright/test';

const exportHash = async (browser: Browser, contextOptions: BrowserContextOptions) => {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 540 });
  await page.goto('/?scenario=A&lib=charts-plus');
  await page.waitForFunction(() => {
    const perf = (window as any).__chartsPlusPerf;
    return Boolean(perf && typeof perf.getLayout === 'function' && perf.getLayout());
  });
  const dataUrl = await page.evaluate(async (options) => {
    const perf = (window as any).__chartsPlusPerf;
    if (!perf || typeof perf.exportPng !== 'function') return null;
    return perf.exportPng(options);
  }, {
    deterministic: true,
    pixelRatio: 1,
    timeZone: 'utc',
    locale: 'en-US',
  });
  await context.close();
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new Error('Deterministic export returned no data.');
  }
  return createHash('sha256').update(dataUrl).digest('hex');
};

test('deterministic export is stable across timezone and DPR', async ({ browser }) => {
  const hashA = await exportHash(browser, {
    timezoneId: 'UTC',
    locale: 'en-US',
    deviceScaleFactor: 1,
  });
  const hashB = await exportHash(browser, {
    timezoneId: 'America/New_York',
    locale: 'fr-FR',
    deviceScaleFactor: 2,
  });
  expect(hashA).toBe(hashB);
});
