import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scenarios = [
  'SCENARIO_A',
  'SCENARIO_B',
  'SCENARIO_C',
  'SCENARIO_D',
  'SCENARIO_E',
  'SCENARIO_F',
] as const;
const scenarioFilterRaw = process.env.PERF_SCENARIOS;
const scenarioFilter = scenarioFilterRaw
  ? new Set(
      scenarioFilterRaw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
  : null;
const scenariosToRun = scenarioFilter
  ? scenarios.filter(
      (scenario): scenario is (typeof scenarios)[number] => scenarioFilter.has(scenario),
    )
  : scenarios;
const libraries = ['charts-plus', 'lightweight'] as const;
const chartsPlusOnly = ['charts-plus'] as const;
const scenarioLibraries: Record<(typeof scenarios)[number], readonly (typeof libraries)[number][]> = {
  SCENARIO_A: libraries,
  SCENARIO_B: libraries,
  SCENARIO_C: libraries,
  SCENARIO_D: chartsPlusOnly,
  SCENARIO_E: chartsPlusOnly,
  SCENARIO_F: chartsPlusOnly,
};

type Summary = {
  sampleCount: number;
  median: number;
  p95: number;
  mean: number;
  max: number;
};

type RenderStats = {
  frames: number;
  layout: number;
  series: number;
  overlay: number;
  underlay?: number;
  raf?: number;
  frameMsTotal?: number;
  frameMsMax?: number;
  frameMsLast?: number;
  axisLabelMeasures?: number;
  axisLabelDraws?: number;
  gridMajorLines?: number;
  gridMinorLines?: number;
  qualityLevel?: 0 | 1 | 2;
  lodMsLast?: number;
  lodMsMax?: number;
  lodMsTotal?: number;
  lodOps?: number;
};
type AllocationStats = { frame: number; total: number; pooled: number };
type DecimatorAllocationStats = { line: AllocationStats; chunked: AllocationStats };
type WorkerQueueStats = { queueDepth: number; totalMs: number; completed: number };
type WorkerStats = { lod: WorkerQueueStats; chunkLod: WorkerQueueStats };

type InputLatencySamples = {
  pointerMove: number[];
  drag: number[];
  wheel: number[];
};

type HeapSample = {
  t: number;
  used: number | null;
  total: number | null;
  limit: number | null;
};

type WorkingSetSample = {
  t: number;
  bytes: number | null;
};

type MemorySamples = {
  heap: { intervalMs: number; samples: HeapSample[] };
  workingSet: { intervalMs: number; samples: WorkingSetSample[] };
};

type PerfSample = {
  frameTimes: number[];
  longTasks: number[];
  inputLatency: InputLatencySamples;
  eventTiming: InputLatencySamples;
  memory: MemorySamples;
  renderStats: RenderStats;
  workerStats: WorkerStats;
  allocationStats: DecimatorAllocationStats;
  sampleWindow: { start: number; end: number; durationMs: number };
};

type PerfPayload = {
  scenario: string;
  library: string;
  browser: string;
  timestamp: string;
  meta: {
    scenario: Record<string, unknown>;
    environment: Record<string, unknown>;
    sampling: {
      warmupMs: number;
      minDurationMs: number;
      window: { start: number; end: number; durationMs: number };
    };
  };
  metrics: {
    frameTimes: Summary;
    longTasks: Summary;
    inputLatency: {
      pointerMove: Summary;
      drag: Summary;
      wheel: Summary;
    };
    eventTiming: {
      pointerMove: Summary;
      drag: Summary;
      wheel: Summary;
    };
    renderStats: RenderStats;
    workerStats: WorkerStats;
    allocationStats: DecimatorAllocationStats;
  };
  samples: {
    frameTimesMs: number[];
    longTasksMs: number[];
    inputLatencyMs: InputLatencySamples;
    eventTimingMs: InputLatencySamples;
    memory: MemorySamples;
  };
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const perfRoot = path.join(repoRoot, 'perf');
const record = process.env.PERF_RECORD === '1';
const skipCompare = process.env.PERF_SKIP_COMPARE === '1';
const budgetRatio = 1.15;
const compareRatio = 1.05;
const perfTestTimeoutMs = (() => {
  const raw = process.env.PERF_TEST_TIMEOUT_MS;
  if (!raw) return 240_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000;
})();
const inputLatencySlackMs = (() => {
  const raw = process.env.PERF_INPUT_LATENCY_SLACK_MS;
  if (!raw) return 0.25;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.25;
})();
const heavyInputLatencySlackMs = (() => {
  const raw = process.env.PERF_INPUT_LATENCY_SLACK_MS_HEAVY;
  if (!raw) return inputLatencySlackMs;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : inputLatencySlackMs;
})();
const warmupMs = 1500;
const minSampleMs = 5500;
const resolvePerfRuns = (scenario: string): number => {
  const raw = process.env.PERF_RUNS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return scenario === 'SCENARIO_B' ? 2 : 1;
};
const resolveMinWheelSamples = (scenario: string): number => {
  const raw = process.env.PERF_MIN_WHEEL_SAMPLES;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (scenario === 'SCENARIO_B') return 80;
  if (scenario === 'SCENARIO_D' || scenario === 'SCENARIO_E' || scenario === 'SCENARIO_F') return 60;
  return 60;
};

const summarize = (samples: number[]): Summary => {
  if (samples.length === 0) {
    return { sampleCount: 0, median: 0, p95: 0, mean: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Index]!;
  const total = samples.reduce((sum, value) => sum + value, 0);
  const max = sorted[sorted.length - 1]!;
  return {
    sampleCount: samples.length,
    median,
    p95,
    mean: total / samples.length,
    max,
  };
};

const compareSummary = (
  label: string,
  current: Summary,
  baseline: Summary,
  ratio: number,
  absoluteSlackMs = 0,
) => {
  if (current.sampleCount === 0 || baseline.sampleCount === 0) return;
  const resolveLimit = (value: number) => {
    const ratioLimit = value * ratio;
    if (absoluteSlackMs <= 0) return ratioLimit;
    return Math.max(ratioLimit, value + absoluteSlackMs);
  };
  const medianLimit = resolveLimit(baseline.median);
  const p95Limit = resolveLimit(baseline.p95);

  expect(
    current.median,
    `${label} median ${current.median.toFixed(2)}ms exceeds ${medianLimit.toFixed(2)}ms`,
  ).toBeLessThanOrEqual(medianLimit);
  expect(
    current.p95,
    `${label} p95 ${current.p95.toFixed(2)}ms exceeds ${p95Limit.toFixed(2)}ms`,
  ).toBeLessThanOrEqual(p95Limit);
};

const compareToBaseline = (label: string, current: Summary, baseline: Summary) =>
  compareSummary(label, current, baseline, budgetRatio);

const compareToTradingView = (label: string, current: Summary, baseline: Summary) =>
  compareSummary(label, current, baseline, compareRatio);

const compareInputLatencyToBaseline = (
  label: string,
  current: Summary,
  baseline: Summary,
  slackMs = inputLatencySlackMs,
) => compareSummary(label, current, baseline, budgetRatio, slackMs);

const compareInputLatencyToTradingView = (label: string, current: Summary, baseline: Summary) =>
  compareSummary(label, current, baseline, compareRatio, inputLatencySlackMs);

const resolveInputLatencySlack = (scenario: string): number => {
  if (scenario === 'SCENARIO_D' || scenario === 'SCENARIO_E' || scenario === 'SCENARIO_F') {
    return heavyInputLatencySlackMs;
  }
  return inputLatencySlackMs;
};

const writeJson = async (filePath: string, payload: PerfPayload) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const runInteractions = async (
  page: any,
  box: { x: number; y: number; width: number; height: number },
) => {
  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;
  const left = box.x + 16;
  const right = box.x + box.width - 16;

  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -480);
  await page.waitForTimeout(120);
  await page.mouse.wheel(0, 480);
  await page.waitForTimeout(120);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(120);

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + box.width * 0.25, centerY, { steps: 24 });
  await page.mouse.move(centerX - box.width * 0.25, centerY, { steps: 24 });
  await page.mouse.up();
  await page.waitForTimeout(120);

  const sweepSteps = 32;
  for (let i = 0; i <= sweepSteps; i += 1) {
    const x = left + ((right - left) * i) / sweepSteps;
    await page.mouse.move(x, centerY);
  }
};

const runScenarioOnce = async (page: any, scenario: string, library: string, browserName: string) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto(`/?scenario=${scenario}&lib=${library}`);
  await page.waitForFunction(() => (window as any).__chartsPlusScenarioReady === true);
  const scenarioError = await page.evaluate(() => (window as any).__chartsPlusScenarioError);
  if (scenarioError) {
    throw new Error(`Scenario setup error (${library} ${scenario}): ${scenarioError}`);
  }

  const box = await page.locator('#chart').boundingBox();
  if (!box) {
    throw new Error('Perf harness chart not found.');
  }

  await runInteractions(page, box);
  await page.waitForTimeout(warmupMs);

  await page.evaluate(() => (window as any).__chartsPlusPerf.startSampling());
  const startSample = Date.now();
  const minWheelSamples = resolveMinWheelSamples(scenario);
  let wheelSamples = 0;
  while (true) {
    await runInteractions(page, box);
    wheelSamples = await page.evaluate(() => {
      const perf = (window as any).__chartsPlusPerf;
      if (!perf || typeof perf.getSampleCounts !== 'function') return -1;
      const counts = perf.getSampleCounts();
      return typeof counts?.inputLatency?.wheel === 'number' ? counts.inputLatency.wheel : -1;
    });
    const elapsed = Date.now() - startSample;
    const hasCounts = wheelSamples >= 0;
    if (elapsed < minSampleMs) continue;
    if (hasCounts && wheelSamples < minWheelSamples) continue;
    break;
  }
  await page.waitForTimeout(250);
  const sample: PerfSample = await page.evaluate(() => (window as any).__chartsPlusPerf.stopSampling());
  const scenarioMeta = await page.evaluate(() => (window as any).__chartsPlusPerf.getScenarioMeta());
  const environment = await page.evaluate(() => (window as any).__chartsPlusPerf.getEnvironmentMeta());

  expect(sample.sampleWindow.durationMs).toBeGreaterThanOrEqual(5000);

  const frameSummary = summarize(sample.frameTimes);
  const longSummary = summarize(sample.longTasks);
  const pointerSummary = summarize(sample.inputLatency.pointerMove);
  const dragSummary = summarize(sample.inputLatency.drag);
  const wheelSummary = summarize(sample.inputLatency.wheel);
  const eventPointerSummary = summarize(sample.eventTiming.pointerMove);
  const eventDragSummary = summarize(sample.eventTiming.drag);
  const eventWheelSummary = summarize(sample.eventTiming.wheel);

  const payload: PerfPayload = {
    scenario,
    library,
    browser: browserName,
    timestamp: new Date().toISOString(),
    meta: {
      scenario: scenarioMeta ?? {},
      environment: environment ?? {},
      sampling: {
        warmupMs,
        minDurationMs: minSampleMs,
        window: sample.sampleWindow,
      },
    },
    metrics: {
      frameTimes: frameSummary,
      longTasks: longSummary,
      inputLatency: {
        pointerMove: pointerSummary,
        drag: dragSummary,
        wheel: wheelSummary,
      },
      eventTiming: {
        pointerMove: eventPointerSummary,
        drag: eventDragSummary,
        wheel: eventWheelSummary,
      },
      renderStats: sample.renderStats,
      workerStats: sample.workerStats,
      allocationStats: sample.allocationStats,
    },
    samples: {
      frameTimesMs: sample.frameTimes,
      longTasksMs: sample.longTasks,
      inputLatencyMs: sample.inputLatency,
      eventTimingMs: sample.eventTiming,
      memory: sample.memory,
    },
  };

  return payload;
};

const aggregatePayloads = (payloads: PerfPayload[]): PerfPayload => {
  if (payloads.length === 1) return payloads[0]!;
  const base = payloads[payloads.length - 1]!;

  const frameTimesMs = payloads.flatMap((payload) => payload.samples.frameTimesMs);
  const longTasksMs = payloads.flatMap((payload) => payload.samples.longTasksMs);
  const inputLatencyMs = {
    pointerMove: payloads.flatMap((payload) => payload.samples.inputLatencyMs.pointerMove),
    drag: payloads.flatMap((payload) => payload.samples.inputLatencyMs.drag),
    wheel: payloads.flatMap((payload) => payload.samples.inputLatencyMs.wheel),
  };
  const eventTimingMs = {
    pointerMove: payloads.flatMap((payload) => payload.samples.eventTimingMs.pointerMove),
    drag: payloads.flatMap((payload) => payload.samples.eventTimingMs.drag),
    wheel: payloads.flatMap((payload) => payload.samples.eventTimingMs.wheel),
  };
  const memory = {
    heap: {
      intervalMs: base.samples.memory.heap.intervalMs,
      samples: payloads.flatMap((payload) => payload.samples.memory.heap.samples),
    },
    workingSet: {
      intervalMs: base.samples.memory.workingSet.intervalMs,
      samples: payloads.flatMap((payload) => payload.samples.memory.workingSet.samples),
    },
  };

  const totalDuration = payloads.reduce(
    (sum, payload) => sum + payload.meta.sampling.window.durationMs,
    0,
  );
  const windowStart = payloads[0]?.meta.sampling.window.start ?? base.meta.sampling.window.start;
  const windowEnd = windowStart + totalDuration;

  return {
    ...base,
    timestamp: new Date().toISOString(),
    meta: {
      ...base.meta,
      sampling: {
        ...base.meta.sampling,
        window: { start: windowStart, end: windowEnd, durationMs: totalDuration },
      },
    },
    metrics: {
      frameTimes: summarize(frameTimesMs),
      longTasks: summarize(longTasksMs),
      inputLatency: {
        pointerMove: summarize(inputLatencyMs.pointerMove),
        drag: summarize(inputLatencyMs.drag),
        wheel: summarize(inputLatencyMs.wheel),
      },
      eventTiming: {
        pointerMove: summarize(eventTimingMs.pointerMove),
        drag: summarize(eventTimingMs.drag),
        wheel: summarize(eventTimingMs.wheel),
      },
      renderStats: base.metrics.renderStats,
      workerStats: base.metrics.workerStats,
      allocationStats: base.metrics.allocationStats,
    },
    samples: {
      frameTimesMs,
      longTasksMs,
      inputLatencyMs,
      eventTimingMs,
      memory,
    },
  };
};

const runScenario = async (page: any, scenario: string, library: string, browserName: string) => {
  const runs = resolvePerfRuns(scenario);
  const payloads: PerfPayload[] = [];
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    payloads.push(await runScenarioOnce(page, scenario, library, browserName));
  }
  const payload = aggregatePayloads(payloads);

  const resultsPath = path.join(perfRoot, 'results', browserName, library, `${scenario}.json`);
  await writeJson(resultsPath, payload);

  const baselinePath = path.join(perfRoot, 'baselines', browserName, library, `${scenario}.json`);
  if (record) {
    await writeJson(baselinePath, payload);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[perf] ${library} ${scenario} runs=${runs} samples wheel=${payload.metrics.inputLatency.wheel.sampleCount}`,
  );

  if (record || skipCompare) {
    return payload;
  }

  if (library === 'lightweight') {
    return payload;
  }

  let baseline: PerfPayload | null = null;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8')) as PerfPayload;
  } catch {
    throw new Error(
      `Missing perf baseline for ${library} ${scenario}. Run "npm run perf:record" to create it.`,
    );
  }

  if (!baseline.metrics?.inputLatency) {
    throw new Error(
      `Perf baseline for ${library} ${scenario} is missing input latency metrics. ` +
        `Run "npm run perf:record" to refresh baselines.`,
    );
  }

  const currentMedian = payload.metrics.frameTimes.median;
  const baselineMedian = baseline.metrics.frameTimes.median;
  const allowed = baselineMedian * budgetRatio;

  // eslint-disable-next-line no-console
  console.log(
    `[perf] ${library} ${scenario} median=${currentMedian.toFixed(2)}ms ` +
      `baseline=${baselineMedian.toFixed(2)}ms limit=${allowed.toFixed(2)}ms ` +
      `frames=${payload.metrics.renderStats.frames} series=${payload.metrics.renderStats.series} ` +
      `overlay=${payload.metrics.renderStats.overlay} longTasks=${payload.metrics.longTasks.sampleCount}`,
  );

  expect(
    currentMedian,
    `${library} ${scenario} median frame time ${currentMedian.toFixed(2)}ms exceeds ` +
      `budget ${allowed.toFixed(2)}ms (baseline ${baselineMedian.toFixed(2)}ms)`,
  ).toBeLessThanOrEqual(allowed);

  compareToBaseline(`${library} ${scenario} frame`, payload.metrics.frameTimes, baseline.metrics.frameTimes);
  const inputLatencySlack = resolveInputLatencySlack(scenario);
  compareInputLatencyToBaseline(
    `${library} ${scenario} pointermove`,
    payload.metrics.inputLatency.pointerMove,
    baseline.metrics.inputLatency.pointerMove,
    inputLatencySlack,
  );
  compareInputLatencyToBaseline(
    `${library} ${scenario} drag`,
    payload.metrics.inputLatency.drag,
    baseline.metrics.inputLatency.drag,
    inputLatencySlack,
  );
  compareInputLatencyToBaseline(
    `${library} ${scenario} wheel`,
    payload.metrics.inputLatency.wheel,
    baseline.metrics.inputLatency.wheel,
    inputLatencySlack,
  );

  return payload;
};

test.describe('perf harness', () => {
  test.setTimeout(perfTestTimeoutMs);
  test.describe.configure({ mode: 'serial' });

  scenariosToRun.forEach((scenario) => {
    test(scenario, async ({ page, browserName }) => {
      const results: Record<string, PerfPayload> = {};
      const libs = scenarioLibraries[scenario];
      for (const library of libs) {
        results[library] = await runScenario(page, scenario, library, browserName);
      }

      if (record || skipCompare) return;
      if (libs.length < 2) return;

      const chartsPayload = results['charts-plus'];
      const tvPayload = results.lightweight;
      if (!chartsPayload || !tvPayload) return;

      const chartsMedian = chartsPayload.metrics.frameTimes.median;
      const tvMedian = tvPayload.metrics.frameTimes.median;
      const allowed = tvMedian * compareRatio;

      // eslint-disable-next-line no-console
      console.log(
        `[perf] compare ${scenario} charts-plus=${chartsMedian.toFixed(2)}ms ` +
          `lightweight=${tvMedian.toFixed(2)}ms limit=${allowed.toFixed(2)}ms`,
      );

      expect(
        chartsMedian,
        `charts-plus ${scenario} median ${chartsMedian.toFixed(2)}ms is slower than ` +
          `lightweight (${tvMedian.toFixed(2)}ms)`,
      ).toBeLessThanOrEqual(allowed);

      compareToTradingView(
        `compare ${scenario} frame`,
        chartsPayload.metrics.frameTimes,
        tvPayload.metrics.frameTimes,
      );
      compareInputLatencyToTradingView(
        `compare ${scenario} pointermove`,
        chartsPayload.metrics.inputLatency.pointerMove,
        tvPayload.metrics.inputLatency.pointerMove,
      );
      compareInputLatencyToTradingView(
        `compare ${scenario} drag`,
        chartsPayload.metrics.inputLatency.drag,
        tvPayload.metrics.inputLatency.drag,
      );
      compareInputLatencyToTradingView(
        `compare ${scenario} wheel`,
        chartsPayload.metrics.inputLatency.wheel,
        tvPayload.metrics.inputLatency.wheel,
      );
    });
  });
});
