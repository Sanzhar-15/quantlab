import { expect, test } from '@playwright/test';

test('pointermove renders overlay only', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/?scenario=SCENARIO_A');
  await page.waitForFunction(() => (window as any).__chartsPlusScenarioReady === true);
  const scenarioError = await page.evaluate(() => (window as any).__chartsPlusScenarioError);
  if (scenarioError) {
    throw new Error(`Scenario setup error: ${scenarioError}`);
  }

  const box = await page.locator('#chart').boundingBox();
  if (!box) {
    throw new Error('Perf harness chart not found.');
  }

  await page.evaluate(() => (window as any).__chartsPlusPerf.getRenderStats(true));

  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;
  const left = box.x + 16;
  const right = box.x + box.width - 16;

  await page.mouse.move(centerX, centerY);
  await page.waitForTimeout(50);

  const steps = 16;
  for (let i = 0; i <= steps; i += 1) {
    const x = left + ((right - left) * i) / steps;
    await page.mouse.move(x, centerY);
  }
  await page.waitForTimeout(120);

  const stats = await page.evaluate(() => (window as any).__chartsPlusPerf.getRenderStats(true));
  expect(stats.overlay).toBeGreaterThan(0);
  expect(stats.series).toBe(0);
  expect(stats.layout).toBe(0);
});

test('pointermove renders overlay only with series worker', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/?scenario=SCENARIO_A&seriesRenderer=worker');

  const supportsWorker = await page.evaluate(
    () =>
      typeof OffscreenCanvas !== 'undefined' &&
      typeof Worker !== 'undefined' &&
      'transferControlToOffscreen' in HTMLCanvasElement.prototype,
  );
  test.skip(!supportsWorker, 'OffscreenCanvas worker not supported');

  await page.waitForFunction(() => (window as any).__chartsPlusScenarioReady === true);
  const scenarioError = await page.evaluate(() => (window as any).__chartsPlusScenarioError);
  if (scenarioError) {
    throw new Error(`Scenario setup error: ${scenarioError}`);
  }

  const rendererInfo = await page.evaluate(() =>
    (window as any).__chartsPlusPerf?.getSeriesRendererInfo?.(),
  );
  expect(rendererInfo?.active).toBe('worker');

  const box = await page.locator('#chart').boundingBox();
  if (!box) {
    throw new Error('Perf harness chart not found.');
  }

  await page.evaluate(() => (window as any).__chartsPlusPerf.getRenderStats(true));

  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;
  const left = box.x + 16;
  const right = box.x + box.width - 16;

  await page.mouse.move(centerX, centerY);
  await page.waitForTimeout(50);

  const steps = 16;
  for (let i = 0; i <= steps; i += 1) {
    const x = left + ((right - left) * i) / steps;
    await page.mouse.move(x, centerY);
  }
  await page.waitForTimeout(120);

  const stats = await page.evaluate(() => (window as any).__chartsPlusPerf.getRenderStats(true));
  expect(stats.overlay).toBeGreaterThan(0);
  expect(stats.series).toBe(0);
  expect(stats.layout).toBe(0);
});

test('input latency samples are captured', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/?scenario=SCENARIO_A');
  await page.waitForFunction(() => (window as any).__chartsPlusScenarioReady === true);
  const scenarioError = await page.evaluate(() => (window as any).__chartsPlusScenarioError);
  if (scenarioError) {
    throw new Error(`Scenario setup error: ${scenarioError}`);
  }

  const box = await page.locator('#chart').boundingBox();
  if (!box) {
    throw new Error('Perf harness chart not found.');
  }

  await page.evaluate(() => (window as any).__chartsPlusPerf.startSampling());

  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;

  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(50);

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + box.width * 0.2, centerY, { steps: 12 });
  await page.mouse.up();

  const steps = 12;
  const left = box.x + 16;
  const right = box.x + box.width - 16;
  for (let i = 0; i <= steps; i += 1) {
    const x = left + ((right - left) * i) / steps;
    await page.mouse.move(x, centerY);
  }
  await page.waitForTimeout(120);

  const sample = await page.evaluate(() => (window as any).__chartsPlusPerf.stopSampling());

  expect(sample.inputLatency.pointerMove.length).toBeGreaterThan(0);
  expect(sample.inputLatency.drag.length).toBeGreaterThan(0);
  expect(sample.inputLatency.wheel.length).toBeGreaterThan(0);
  const allSamples = [
    ...sample.inputLatency.pointerMove,
    ...sample.inputLatency.drag,
    ...sample.inputLatency.wheel,
  ];
  allSamples.forEach((value: number) => {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});

test('dashboard offscreen charts stay idle', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto('/?scenario=SCENARIO_F');
  await page.waitForFunction(
    () =>
      (window as any).__chartsPlusScenarioReady === true ||
      (window as any).__chartsPlusScenarioError,
  );
  const scenarioError = await page.evaluate(() => (window as any).__chartsPlusScenarioError);
  if (scenarioError) {
    throw new Error(`Scenario setup error: ${scenarioError}`);
  }

  const supportsObserver = await page.evaluate(() => 'IntersectionObserver' in window);
  test.skip(!supportsObserver, 'IntersectionObserver not supported');

  await page.evaluate(() => (window as any).__chartsPlusPerf.getDashboardRenderStats(true));
  await page.waitForTimeout(200);

  const box = await page.locator('#chart').boundingBox();
  if (!box) {
    throw new Error('Perf harness chart not found.');
  }

  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(200);

  const stats = await page.evaluate(() => (window as any).__chartsPlusPerf.getDashboardRenderStats());
  expect(stats.length).toBeGreaterThanOrEqual(8);

  const activeCharts = stats.filter((entry: any) => entry.frames > 0);
  const idleCharts = stats.filter(
    (entry: any) => entry.frames === 0 && entry.series === 0 && entry.layout === 0,
  );

  expect(activeCharts.length).toBeLessThanOrEqual(6);
  expect(idleCharts.length).toBeGreaterThanOrEqual(4);
});
