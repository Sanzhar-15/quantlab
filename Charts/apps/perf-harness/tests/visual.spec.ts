import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const waitForLodIdle = async (page: Page) => {
  await page.waitForFunction(
    () => {
      const scene = (window as any).__chartsPlusScene;
      if (!scene?.getSeriesLodInfo) return true;
      const info = scene.getSeriesLodInfo();
      if (!Array.isArray(info) || info.length === 0) return true;
      return info.every((entry: { building?: boolean }) => entry?.building === false);
    },
    undefined,
    { timeout: 8000 },
  );
};

const waitForRenderIdle = async (page: Page) => {
  const maxAttempts = 12;
  const delayMs = 80;
  let stableTicks = 0;
  let lastSnapshot: {
    frames: number;
    layout: number;
    series: number;
    overlay: number;
    underlay: number;
  } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await page.evaluate(() => {
      const stats = (window as any).__chartsPlusScene?.getRenderStats?.() ?? null;
      if (!stats) return null;
      return {
        frames: stats.frames ?? 0,
        layout: stats.layout ?? 0,
        series: stats.series ?? 0,
        overlay: stats.overlay ?? 0,
        underlay: stats.underlay ?? 0,
      };
    });
    if (snapshot && lastSnapshot) {
      const unchanged =
        snapshot.frames === lastSnapshot.frames &&
        snapshot.layout === lastSnapshot.layout &&
        snapshot.series === lastSnapshot.series &&
        snapshot.overlay === lastSnapshot.overlay &&
        snapshot.underlay === lastSnapshot.underlay;
      stableTicks = unchanged ? stableTicks + 1 : 0;
      if (stableTicks >= 1) return;
    }
    lastSnapshot = snapshot;
    await page.waitForTimeout(delayMs);
  }
};

const scenes = [
  { name: 'theme-dark', query: 'scene=theme-dark' },
  { name: 'theme-light', query: 'scene=theme-light' },
  { name: 'theme-neutral', query: 'scene=theme-neutral' },
  { name: 'gaps', query: 'scene=gaps' },
  { name: 'multi-series', query: 'scene=multi-series' },
  { name: 'multi-series-worker', query: 'scene=multi-series&seriesRenderer=worker' },
  { name: 'area-series', query: 'scene=area-series' },
  { name: 'baseline-series', query: 'scene=baseline-series' },
  { name: 'histogram-series', query: 'scene=histogram-series' },
  { name: 'candlestick-series', query: 'scene=candlestick-series' },
  { name: 'bar-series', query: 'scene=bar-series' },
  { name: 'axis-dense', query: 'scene=axis-dense' },
  { name: 'axis-sparse', query: 'scene=axis-sparse' },
  { name: 'custom-series', query: 'scene=custom-series' },
  { name: 'candlestick-series-worker', query: 'scene=candlestick-series&seriesRenderer=worker' },
  { name: 'bar-series-worker', query: 'scene=bar-series&seriesRenderer=worker' },
  { name: 'yield-curve', query: 'scene=yield-curve' },
  { name: 'options-chain', query: 'scene=options-chain' },
  { name: 'price-line', query: 'scene=price-line' },
  { name: 'multi-axis', query: 'scene=multi-axis' },
  { name: 'overlays', query: 'scene=overlays' },
  { name: 'annotations', query: 'scene=annotations' },
  { name: 'dense-tooltip', query: 'scene=dense-tooltip' },
  { name: 'pan-cache', query: 'scene=pan-cache' },
  { name: 'live-mode', query: 'scene=live-mode' },
  { name: 'streaming', query: 'scene=streaming' },
  { name: 'multi-pane', query: 'scene=multi-pane' },
  { name: 'sync-multi-pane', query: 'scene=sync-multi-pane' },
  { name: 'revisions', query: 'scene=revisions' },
];

test.describe('visual regression', () => {
  scenes.forEach((scene) => {
    test(scene.name, async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 600 });
      await page.goto(`/?${scene.query}`);
      await page.waitForFunction(() => (window as any).__chartsPlusSceneReady === true);
      await waitForLodIdle(page);
      await waitForRenderIdle(page);
      if (scene.name === 'pan-cache') {
        const box = await page.locator('#chart').boundingBox();
        if (!box) {
          throw new Error('Perf harness chart not found.');
        }
        const centerX = box.x + box.width * 0.5;
        const centerY = box.y + box.height * 0.5;
        await page.mouse.move(centerX, centerY);
        await page.mouse.down();
        await page.mouse.move(centerX + box.width * 0.2, centerY, { steps: 12 });
        await page.waitForTimeout(100);
        await expect(page.locator('#chart')).toHaveScreenshot(`${scene.name}.png`, {
          animations: 'disabled',
        });
        await page.mouse.up();
        return;
      }
      if (scene.name === 'dense-tooltip') {
        const box = await page.locator('#chart').boundingBox();
        if (!box) {
          throw new Error('Perf harness chart not found.');
        }
        const x = box.x + box.width * 0.55;
        const y = box.y + box.height * 0.45;
        await page.mouse.move(x, y);
        await page.waitForTimeout(80);
        await expect(page.locator('#chart')).toHaveScreenshot(`${scene.name}.png`, {
          animations: 'disabled',
        });
        return;
      }
      if (scene.name === 'multi-pane') {
        const box = await page.locator('#chart').boundingBox();
        if (!box) {
          throw new Error('Perf harness chart not found.');
        }
        const x = box.x + box.width * 0.5;
        const y = box.y + box.height * 0.55;
        await page.mouse.move(x, y);
        await page.waitForTimeout(60);
      }
      if (scene.name === 'sync-multi-pane') {
        await page.setViewportSize({ width: 1200, height: 800 });
        const box = await page.locator('#chart').boundingBox();
        if (!box) {
          throw new Error('Perf harness chart not found.');
        }
        const x = box.x + box.width * 0.5;
        const y = box.y + box.height * 0.4;
        await page.mouse.move(x, y);
        await page.waitForTimeout(60);
      }
      await expect(page.locator('#chart')).toHaveScreenshot(`${scene.name}.png`, {
        animations: 'disabled',
      });
    });
  });
});
