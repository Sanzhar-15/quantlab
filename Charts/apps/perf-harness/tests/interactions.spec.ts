import { expect, test } from '@playwright/test';

const waitForScenario = async (page: any) => {
  await page.waitForFunction(() => (window as any).__chartsPlusScenarioReady === true);
  const scenarioError = await page.evaluate(() => (window as any).__chartsPlusScenarioError);
  if (scenarioError) {
    throw new Error(`Scenario setup error: ${scenarioError}`);
  }
};

const getVisibleRange = (page: any) =>
  page.evaluate(() => (window as any).__chartsPlusPerf.getVisibleTimeRange());

test('drag pan continues with inertia', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/?scenario=SCENARIO_A&inertiaFriction=0.9');
  await waitForScenario(page);

  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('Perf harness chart not found.');

  const before = await getVisibleRange(page);
  const startX = box.x + box.width * 0.6;
  const endX = startX + 160;
  const y = box.y + box.height * 0.5;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    const x = startX + ((endX - startX) * i) / 8;
    await page.mouse.move(x, y);
  }
  await page.mouse.up();

  const afterDrag = await getVisibleRange(page);
  await page.waitForTimeout(160);
  const afterInertia = await getVisibleRange(page);

  expect(afterDrag.from).not.toBe(before.from);
  expect(afterInertia.from).not.toBe(afterDrag.from);
  expect(afterInertia.from).toBeLessThan(afterDrag.from);
});

test('wheel zoom stays anchored at cursor time', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/?scenario=SCENARIO_A');
  await waitForScenario(page);

  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('Perf harness chart not found.');

  const before = await getVisibleRange(page);
  const beforeSpan = before.to - before.from;
  const beforeMid = (before.from + before.to) * 0.5;

  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(80);

  const after = await getVisibleRange(page);
  const afterSpan = after.to - after.from;
  const afterMid = (after.from + after.to) * 0.5;

  expect(afterSpan).toBeLessThan(beforeSpan);
  expect(Math.abs(afterMid - beforeMid)).toBeLessThan(beforeSpan * 0.02);
});

test('crosshair interpolates when requested', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/?scenario=SCENARIO_A&crosshair=interpolate');
  await waitForScenario(page);

  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('Perf harness chart not found.');

  const target = await page.evaluate(() => {
    const perf = (window as any).__chartsPlusPerf;
    const data = perf.getScenarioData?.();
    const range = perf.getVisibleTimeRange?.();
    const layout = perf.getLayout?.();
    if (!data || !range || !layout) return null;

    const series = data.series[0];
    const points = series?.points ?? [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!a || !b) continue;
      if (a.v === null || b.v === null) continue;
      if (a.v === b.v) continue;
      if (a.t < range.from || b.t > range.to) continue;
      const midTime = (a.t + b.t) * 0.5;
      const expectedInterpolated = a.v + (b.v - a.v) * 0.5;
      const ratio = (midTime - range.from) / (range.to - range.from);
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      return {
        id: series.preset.id,
        x,
        y,
        expectedInterpolated,
      };
    }
    return null;
  });

  if (!target) {
    throw new Error('Unable to locate a suitable interpolation segment.');
  }

  const x = box.x + target.x;
  const y = box.y + target.y;

  await page.mouse.move(x, y);
  await page.waitForFunction(() => (window as any).__chartsPlusPerf.getCrosshairState() !== null);

  const snapshot = await page.evaluate(() => (window as any).__chartsPlusPerf.getCrosshairState());
  const series = snapshot.seriesValues.find((entry: any) => entry.id === target.id);
  expect(series).toBeTruthy();
  expect(series.value).toBeCloseTo(target.expectedInterpolated, 2);
});

test('crosshair snaps to nearest by default', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/?scenario=SCENARIO_A&crosshair=nearest');
  await waitForScenario(page);

  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('Perf harness chart not found.');

  const target = await page.evaluate(() => {
    const perf = (window as any).__chartsPlusPerf;
    const data = perf.getScenarioData?.();
    const range = perf.getVisibleTimeRange?.();
    const layout = perf.getLayout?.();
    if (!data || !range || !layout) return null;

    const series = data.series[0];
    const points = series?.points ?? [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!a || !b) continue;
      if (a.v === null || b.v === null) continue;
      if (a.v === b.v) continue;
      if (a.t < range.from || b.t > range.to) continue;
      const midTime = (a.t + b.t) * 0.5;
      const ratio = (midTime - range.from) / (range.to - range.from);
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      return {
        id: series.preset.id,
        x,
        y,
        expectedNearest: a.v,
      };
    }
    return null;
  });

  if (!target) {
    throw new Error('Unable to locate a suitable nearest segment.');
  }

  const x = box.x + target.x;
  const y = box.y + target.y;

  await page.mouse.move(x, y);
  await page.waitForFunction(() => (window as any).__chartsPlusPerf.getCrosshairState() !== null);

  const snapshot = await page.evaluate(() => (window as any).__chartsPlusPerf.getCrosshairState());
  const series = snapshot.seriesValues.find((entry: any) => entry.id === target.id);
  expect(series).toBeTruthy();
  expect(series.value).toBeCloseTo(target.expectedNearest, 2);
});
