import { test, expect } from '@playwright/test';

test('mount/unmount leak smoke', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__chartsPlusTest);

  const result = await page.evaluate(async () => {
    const api = (window as typeof window & { __chartsPlusTest?: any }).__chartsPlusTest;
    if (!api) {
      return { samples: [], canMeasure: false, canvasCount: 0, missingApi: true };
    }

    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    const canMeasure = typeof memory?.usedJSHeapSize === 'number';
    const samples: number[] = [];

    const readMemory = () => (performance as { memory?: { usedJSHeapSize: number } }).memory!.usedJSHeapSize;
    const tick = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const maybeGc = () => {
      const gc = (window as typeof window & { gc?: () => void }).gc;
      if (typeof gc === 'function') gc();
    };

    for (let i = 0; i < 50; i += 1) {
      api.unmount();
      maybeGc();
      await tick();
      api.mount();
      await tick();
      if (canMeasure && (i % 10 === 0 || i === 49)) {
        maybeGc();
        await tick();
        samples.push(readMemory());
      }
    }

    api.unmount();
    maybeGc();
    await tick();

    return {
      samples,
      canMeasure,
      canvasCount: api.getCanvasCount(),
      missingApi: false,
    };
  });

  expect(result.missingApi).toBe(false);
  expect(result.canvasCount).toBe(0);

  if (result.canMeasure && result.samples.length >= 2) {
    const start = result.samples[0]!;
    const peak = Math.max(...result.samples);
    const limit = start * 2 + 12 * 1024 * 1024;
    expect(peak).toBeLessThan(limit);
  }
});
