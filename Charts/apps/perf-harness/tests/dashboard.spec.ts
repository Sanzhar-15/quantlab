import { expect, test } from '@playwright/test';

const waitForScenario = async (page: any) => {
  await page.waitForFunction(() => (window as any).__chartsPlusScenarioReady === true);
  const scenarioError = await page.evaluate(() => (window as any).__chartsPlusScenarioError);
  if (scenarioError) {
    throw new Error(`Scenario setup error: ${scenarioError}`);
  }
};

const waitForScene = async (page: any) => {
  await page.waitForFunction(() => (window as any).__chartsPlusSceneReady === true);
};

const getDashboardStats = (page: any, reset = false) =>
  page.evaluate((resetFlag: boolean) => {
    const perf = (window as any).__chartsPlusPerf;
    const scene = (window as any).__chartsPlusScene;
    const getter = perf?.getDashboardRenderStats ?? scene?.getDashboardRenderStats;
    return getter ? getter(resetFlag) : [];
  }, reset);

const getDashboardRanges = (page: any) =>
  page.evaluate(() => {
    const perf = (window as any).__chartsPlusPerf;
    const scene = (window as any).__chartsPlusScene;
    const getter = perf?.getDashboardVisibleRanges ?? scene?.getDashboardVisibleRanges;
    return getter ? getter() : [];
  });

test('dashboard offscreen charts remain idle during interaction', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/?scenario=SCENARIO_F');
  await waitForScenario(page);
  await page.waitForTimeout(80);

  const meta = await page.evaluate(() => (window as any).__chartsPlusPerf?.getScenarioMeta?.());
  const visibleCount = meta?.visibleCharts ?? 4;

  await getDashboardStats(page, true);
  await page.waitForTimeout(60);
  await getDashboardStats(page, true);

  const firstChart = page.locator('#chart > div > div').first();
  const box = await firstChart.boundingBox();
  if (!box) throw new Error('Dashboard chart not found.');

  const startX = box.x + box.width * 0.4;
  const endX = box.x + box.width * 0.6;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(startX, y);
  for (let i = 0; i < 10; i += 1) {
    const x = startX + ((endX - startX) * i) / 9;
    await page.mouse.move(x, y);
  }
  await page.waitForTimeout(120);

  const stats = await getDashboardStats(page, false);
  expect(stats.length).toBeGreaterThan(visibleCount);
  const visibleStats = stats.slice(0, visibleCount);
  const offscreenStats = stats.slice(visibleCount);

  expect(visibleStats.some((stat: any) => stat.frames > 0 || stat.overlay > 0)).toBe(true);
  offscreenStats.forEach((stat: any) => {
    expect(stat.frames).toBe(0);
    expect(stat.series).toBe(0);
    expect(stat.overlay).toBe(0);
  });
});

test('sync group updates all charts without render amplification', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/?scene=sync-multi-pane');
  await waitForScene(page);
  await page.waitForTimeout(80);

  await getDashboardStats(page, true);
  await page.waitForTimeout(60);
  await getDashboardStats(page, true);

  const chartBoxes = page.locator('#chart > div > div');
  const firstBox = await chartBoxes.first().boundingBox();
  if (!firstBox) throw new Error('Sync group chart not found.');

  const x = firstBox.x + firstBox.width * 0.55;
  const y = firstBox.y + firstBox.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(140);

  const stats = await getDashboardStats(page, false);
  expect(stats.length).toBeGreaterThan(1);
  stats.forEach((stat: any) => {
    expect(stat.frames > 0 || stat.series > 0 || stat.layout > 0).toBe(true);
  });

  const maxFrames = Math.max(...stats.map((stat: any) => stat.frames));
  expect(maxFrames).toBeLessThanOrEqual(40);

  const ranges = await getDashboardRanges(page);
  expect(ranges.length).toBeGreaterThan(1);
  const reference = ranges[0];
  ranges.forEach((range: any) => {
    expect(range).toBeTruthy();
    expect(Math.abs(range.from - reference.from)).toBeLessThan(1);
    expect(Math.abs(range.to - reference.to)).toBeLessThan(1);
  });

  await getDashboardStats(page, true);
  await page.waitForTimeout(220);
  const idleStats = await getDashboardStats(page, false);
  idleStats.forEach((stat: any) => {
    expect(stat.frames).toBe(0);
  });
});
