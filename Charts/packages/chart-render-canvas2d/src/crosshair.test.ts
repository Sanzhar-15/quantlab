// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createChart } from './index';

type LayoutDebug = {
  getLayout?: () =>
    | {
        plotRect: { x: number; y: number; width: number; height: number };
        panes?: { id: string; plotRect: { x: number; y: number; width: number; height: number } }[];
      }
    | null;
};

type DebugChart = { __chartsPlusDebug?: LayoutDebug };

type CrosshairSnapshot = {
  time: number;
  formattedTime: string;
  paneId?: string;
  seriesValues: Map<string, { value: number | null; formatted: string }>;
};

const waitFor = async (
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) => {
  const timeoutMs = options.timeoutMs ?? 1200;
  const intervalMs = options.intervalMs ?? 10;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition.');
};

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const createStubContext = () => {
  const ctx = {
    canvas: document.createElement('canvas'),
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    stroke: (_path?: Path2D) => {},
    strokeRect: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    fill: () => {},
    fillText: () => {},
    measureText: (text: string) => ({ width: text.length * 6 } as TextMetrics),
    setLineDash: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };
  return ctx as unknown as CanvasRenderingContext2D;
};

const stubCanvasContext = () => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = () => createStubContext();
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
};

const dispatchPointerMove = (canvas: HTMLCanvasElement, x: number, y: number) => {
  const event = new Event('pointermove', { bubbles: true });
  Object.defineProperty(event, 'offsetX', { value: x });
  Object.defineProperty(event, 'offsetY', { value: y });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  canvas.dispatchEvent(event);
};

const getLayout = (chart: DebugChart) => chart.__chartsPlusDebug?.getLayout?.() ?? null;

const createContainer = () => {
  const container = document.createElement('div');
  container.style.width = '400px';
  container.style.height = '240px';
  document.body.appendChild(container);
  return container;
};

describe('crosshair formatting and gaps', () => {
  it('uses axis formatter when no series formatter is set', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, {
        width: 400,
        height: 240,
        axis: {
          left: {
            formatter: (value) => `AX:${value.toFixed(1)}`,
          },
        },
      });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const x = layout.plotRect.x + 1;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      const entry = snapshot!.seriesValues.get('Series');
      expect(entry?.formatted.startsWith('AX:')).toBe(true);
    } finally {
      container.remove();
      restore();
    }
  });

  it('uses timeFormatter for formattedTime', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, {
        width: 400,
        height: 240,
        timeFormatter: (time) => (Number.isFinite(time) ? `T:${time}` : ''),
      });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const x = layout.plotRect.x + 1;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      expect(snapshot?.formattedTime.startsWith('T:')).toBe(true);
    } finally {
      container.remove();
      restore();
    }
  });

  it('series valueFormatter overrides axis formatting', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, {
        width: 400,
        height: 240,
        axis: {
          left: {
            formatter: (value) => `AX:${value.toFixed(1)}`,
          },
        },
      });
      const series = chart.addLineSeries({
        id: 'Series',
        valueFormatter: (value) => `S:${value.toFixed(2)}`,
      });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const x = layout.plotRect.x + 1;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      const entry = snapshot!.seriesValues.get('Series');
      expect(entry?.formatted.startsWith('S:')).toBe(true);
    } finally {
      container.remove();
      restore();
    }
  });

  it('formats UTC and local time zones with the default formatter', async () => {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return;
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? 'en-US';
    const utcFormatter = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'UTC',
    });
    const localFormatter = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const t0 = Date.UTC(2024, 2, 10, 6, 30, 0);
    const t1 = t0 + 60 * 60 * 1000;

    const restore = stubCanvasContext();
    const containerUtc = createContainer();
    try {
      const chartUtc = createChart(containerUtc, {
        width: 400,
        height: 240,
        timeZone: 'utc',
      });
      const seriesUtc = chartUtc.addLineSeries({ id: 'UTC' });
      seriesUtc.setData([
        { t: t0, v: 10 },
        { t: t1, v: 12 },
      ]);
      chartUtc.setVisibleTimeRange({ from: t0, to: t1 });
      await waitFor(() => getLayout(chartUtc as DebugChart) !== null);
      const layoutUtc = getLayout(chartUtc as DebugChart)!;
      const overlayUtc = containerUtc.querySelectorAll('canvas')[
        containerUtc.querySelectorAll('canvas').length - 1
      ] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      const unsub = chartUtc.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });
      dispatchPointerMove(overlayUtc, layoutUtc.plotRect.x, layoutUtc.plotRect.y + 2);
      await waitFor(() => snapshot !== null);
      expect(snapshot?.formattedTime).toBe(utcFormatter.format(new Date(t0)));
      unsub();
      chartUtc.destroy();
    } finally {
      containerUtc.remove();
      restore();
    }

    const restoreLocal = stubCanvasContext();
    const containerLocal = createContainer();
    try {
      const chartLocal = createChart(containerLocal, {
        width: 400,
        height: 240,
        timeZone: 'local',
      });
      const seriesLocal = chartLocal.addLineSeries({ id: 'Local' });
      seriesLocal.setData([
        { t: t0, v: 10 },
        { t: t1, v: 12 },
      ]);
      chartLocal.setVisibleTimeRange({ from: t0, to: t1 });
      await waitFor(() => getLayout(chartLocal as DebugChart) !== null);
      const layoutLocal = getLayout(chartLocal as DebugChart)!;
      const overlayLocal = containerLocal.querySelectorAll('canvas')[
        containerLocal.querySelectorAll('canvas').length - 1
      ] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      const unsub = chartLocal.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });
      dispatchPointerMove(overlayLocal, layoutLocal.plotRect.x, layoutLocal.plotRect.y + 2);
      await waitFor(() => snapshot !== null);
      expect(snapshot?.formattedTime).toBe(localFormatter.format(new Date(t0)));
      unsub();
      chartLocal.destroy();
    } finally {
      containerLocal.remove();
      restoreLocal();
    }
  });

  it('respects formatter across DST boundary', async () => {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return;
    const restore = stubCanvasContext();
    const container = createContainer();
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    });
    const tBefore = Date.UTC(2024, 2, 10, 6, 30, 0);
    const tAfter = Date.UTC(2024, 2, 10, 7, 30, 0);

    try {
      const chart = createChart(container, {
        width: 400,
        height: 240,
        timeFormatter: (time) => (Number.isFinite(time) ? formatter.format(new Date(time)) : ''),
      });
      const series = chart.addLineSeries({ id: 'DST' });
      series.setData([
        { t: tBefore, v: 10 },
        { t: tAfter, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: tBefore, to: tAfter });
      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const overlay = container.querySelectorAll('canvas')[
        container.querySelectorAll('canvas').length - 1
      ] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      const unsub = chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });
      dispatchPointerMove(overlay, layout.plotRect.x, layout.plotRect.y + 2);
      await waitFor(() => snapshot !== null);
      const before = snapshot?.formattedTime ?? '';
      snapshot = null;
      dispatchPointerMove(
        overlay,
        layout.plotRect.x + layout.plotRect.width,
        layout.plotRect.y + 2,
      );
      await waitFor(() => snapshot !== null);
      const after = snapshot?.formattedTime ?? '';
      expect(before).toBe(formatter.format(new Date(tBefore)));
      expect(after).toBe(formatter.format(new Date(tAfter)));
      expect(before).not.toBe(after);
      unsub();
      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('supports locale-specific formatting with explicit formatters', async () => {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return;
    const restore = stubCanvasContext();
    const container = createContainer();
    const t0 = Date.UTC(2024, 4, 12, 14, 5, 0);
    const t1 = t0 + 30 * 60 * 1000;
    const enFormatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });
    const frFormatter = new Intl.DateTimeFormat('fr-FR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });

    try {
      const chart = createChart(container, {
        width: 400,
        height: 240,
        timeFormatter: (time) => (Number.isFinite(time) ? enFormatter.format(new Date(time)) : ''),
      });
      const series = chart.addLineSeries({ id: 'Locale' });
      series.setData([
        { t: t0, v: 10 },
        { t: t1, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: t0, to: t1 });
      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const overlay = container.querySelectorAll('canvas')[
        container.querySelectorAll('canvas').length - 1
      ] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      const unsub = chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });
      dispatchPointerMove(overlay, layout.plotRect.x, layout.plotRect.y + 2);
      await waitFor(() => snapshot !== null);
      const enValue = snapshot?.formattedTime ?? '';
      expect(enValue).toBe(enFormatter.format(new Date(t0)));
      unsub();
      chart.destroy();
    } finally {
      container.remove();
      restore();
    }

    const restoreFr = stubCanvasContext();
    const containerFr = createContainer();
    try {
      const chart = createChart(containerFr, {
        width: 400,
        height: 240,
        timeFormatter: (time) => (Number.isFinite(time) ? frFormatter.format(new Date(time)) : ''),
      });
      const series = chart.addLineSeries({ id: 'LocaleFR' });
      series.setData([
        { t: t0, v: 10 },
        { t: t1, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: t0, to: t1 });
      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const overlay = containerFr.querySelectorAll('canvas')[
        containerFr.querySelectorAll('canvas').length - 1
      ] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      const unsub = chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });
      dispatchPointerMove(overlay, layout.plotRect.x, layout.plotRect.y + 2);
      await waitFor(() => snapshot !== null);
      const frValue = snapshot?.formattedTime ?? '';
      expect(frValue).toBe(frFormatter.format(new Date(t0)));
      unsub();
      chart.destroy();
      expect(frValue).not.toBe(enFormatter.format(new Date(t0)));
    } finally {
      containerFr.remove();
      restoreFr();
    }
  });

  it('reports paneId for active pane', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240 });
      const paneId = chart.addPane();
      const seriesA = chart.addLineSeries({ id: 'A' });
      const seriesB = chart.addLineSeries({ id: 'B', paneId });
      seriesA.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      seriesB.setData([
        { t: 0, v: 30 },
        { t: 1000, v: 40 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const panes = layout.panes ?? [];
      const pane = panes.find((entry) => entry.id === paneId);
      expect(pane).toBeTruthy();
      const panesRect = pane!.plotRect;

      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const x = layout.plotRect.x + 1;
      const y = panesRect.y + panesRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      expect(snapshot?.paneId).toBe(paneId);
    } finally {
      container.remove();
      restore();
    }
  });

  it('respects series sampleMode overrides', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240, crosshairMode: 'interpolate' });
      const seriesNearest = chart.addLineSeries({ id: 'Nearest', sampleMode: 'nearest' });
      const seriesLinear = chart.addLineSeries({ id: 'Linear', sampleMode: 'linear' });
      const points = [
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ];
      seriesNearest.setData(points);
      seriesLinear.setData(points);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const targetTime = 500;
      const ratio = targetTime / 1000;
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      expect(snapshot!.seriesValues.get('Nearest')?.value).toBe(10);
      expect(snapshot!.seriesValues.get('Linear')?.value).toBe(15);
    } finally {
      container.remove();
      restore();
    }
  });

  it('supports hold sampling for crosshair', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240, crosshairMode: 'interpolate' });
      const series = chart.addLineSeries({ id: 'Hold', sampleMode: 'hold' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const targetTime = 600;
      const ratio = targetTime / 1000;
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      expect(snapshot!.seriesValues.get('Hold')?.value).toBe(10);
    } finally {
      container.remove();
      restore();
    }
  });

  it('snaps to nearest data time in magnet mode', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240, crosshairMode: 'magnet' });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const targetTime = 600;
      const ratio = targetTime / 1000;
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      expect(snapshot!.time).toBe(1000);
    } finally {
      container.remove();
      restore();
    }
  });

  it('formats OHLC values when crosshair mode is ohlc', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240, crosshairMode: 'ohlc' });
      const series = chart.addCandlestickSeries({ id: 'Candles' });
      series.setData([
        { t: 0, o: 10, h: 12, l: 9, c: 11 },
        { t: 1000, o: 11, h: 14, l: 10, c: 13 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const targetTime = 800;
      const ratio = targetTime / 1000;
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      const entry = snapshot!.seriesValues.get('Candles');
      expect(snapshot!.time).toBe(1000);
      expect(entry?.value).toBe(13);
      expect(entry?.formatted.includes('O:')).toBe(true);
      expect(entry?.formatted.includes('H:')).toBe(true);
      expect(entry?.formatted.includes('L:')).toBe(true);
      expect(entry?.formatted.includes('C:')).toBe(true);
    } finally {
      container.remove();
      restore();
    }
  });

  it('snaps to nearest bar inside gapThresholdMs windows', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240, gapThresholdMs: 500 });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 2000, v: 20 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 2000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const targetTime = 1000;
      const ratio = targetTime / 2000;
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      const entry = snapshot!.seriesValues.get('Series');
      expect(snapshot!.time).toBe(0);
      expect(entry?.value).toBe(10);
    } finally {
      container.remove();
      restore();
    }
  });

  it('returns null when the nearest samples are both gaps', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240 });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: null },
        { t: 2000, v: null },
        { t: 3000, v: 30 },
        { t: 4000, v: 40 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 4000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const targetTime = 2000;
      const ratio = (targetTime - 0) / 4000;
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      const entry = snapshot!.seriesValues.get('Series');
      expect(entry?.value).toBeNull();
      expect(entry?.formatted).toBe('');
    } finally {
      container.remove();
      restore();
    }
  });

  it('keeps crosshair stable under extreme zoom ranges', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const base = 1_700_000_000_000;
      const chart = createChart(container, { width: 400, height: 240, crosshairMode: 'nearest' });
      const series = chart.addLineSeries({ id: 'Zoom' });
      series.setData([
        { t: base, v: 10 },
        { t: base + 1, v: 12 },
        { t: base + 2, v: 8 },
      ]);
      const from = base + 0.5;
      const to = base + 1.5;
      chart.setVisibleTimeRange({ from, to });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const x = layout.plotRect.x + layout.plotRect.width * 0.5;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);

      expect(Number.isFinite(snapshot!.time)).toBe(true);
      expect(snapshot!.time).toBeGreaterThanOrEqual(from);
      expect(snapshot!.time).toBeLessThanOrEqual(to);
      expect(snapshot!.seriesValues.get('Zoom')?.value).not.toBeNull();
    } finally {
      container.remove();
      restore();
    }
  });

  it('reflects patchExisting updates', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240 });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
        { t: 2000, v: 30 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 2000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const targetTime = 1000;
      const ratio = (targetTime - 0) / 2000;
      const x = layout.plotRect.x + ratio * layout.plotRect.width;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot !== null);
      expect(snapshot!.seriesValues.get('Series')?.value).toBe(20);

      series.patchExisting([{ t: 1000, v: 42 }]);
      snapshot = null;
      dispatchPointerMove(overlay, x, y);
      await waitFor(() => snapshot?.seriesValues.get('Series')?.value === 42);
      expect(snapshot!.seriesValues.get('Series')?.value).toBe(42);
    } finally {
      container.remove();
      restore();
    }
  });

  it('tracks streaming updates with gaps and patchExisting', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240, crosshairMode: 'nearest' });
      const series = chart.addLineSeries({ id: 'Stream', sampleMode: 'nearest' });
      const rng = mulberry32(0x7d2c5b11);

      const start = 1_000;
      const step = 1_000;
      const baseCount = 20;
      const appendCount = 12;
      const expected = new Map<number, number | null>();

      const base: Array<{ t: number; v: number | null }> = [];
      for (let i = 0; i < baseCount; i += 1) {
        const t = start + i * step;
        const v = rng() < 0.16 ? null : Math.round(rng() * 80 + 40);
        base.push({ t, v });
        expected.set(t, v);
      }
      series.setData(base);

      const appended: Array<{ t: number; v: number | null }> = [];
      for (let i = 0; i < appendCount; i += 1) {
        const t = start + (baseCount + i) * step;
        const v = rng() < 0.2 ? null : Math.round(rng() * 90 + 20);
        appended.push({ t, v });
        expected.set(t, v);
      }
      series.appendBatch(appended);

      const times = Array.from(expected.keys());
      const patches: Array<{ t: number; v: number | null }> = [];
      for (let i = 0; i < 6; i += 1) {
        const time = times[Math.floor(rng() * times.length)]!;
        const v = rng() < 0.5 ? null : Math.round(rng() * 120 + 10);
        patches.push({ t: time, v });
        expected.set(time, v);
      }
      series.patchExisting(patches);

      const sortedTimes = Array.from(expected.keys()).sort((a, b) => a - b);
      const sortedValues = sortedTimes.map((time) => expected.get(time) ?? null);
      const lowerBound = (values: number[], target: number) => {
        let low = 0;
        let high = values.length;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if (values[mid]! < target) {
            low = mid + 1;
          } else {
            high = mid;
          }
        }
        return low;
      };
      const resolveNearestNonNull = (time: number): number | null => {
        const idx = lowerBound(sortedTimes, time);
        let bestValue: number | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        let bestIndex = Number.POSITIVE_INFINITY;
        const consider = (index: number) => {
          if (index < 0 || index >= sortedTimes.length) return;
          const value = sortedValues[index];
          if (value === null || !Number.isFinite(value)) return;
          const distance = Math.abs(sortedTimes[index]! - time);
          if (distance < bestDistance || (distance === bestDistance && index < bestIndex)) {
            bestDistance = distance;
            bestValue = value;
            bestIndex = index;
          }
        };
        consider(idx - 1);
        consider(idx);
        return bestValue;
      };

      const from = start;
      const to = start + (baseCount + appendCount - 1) * step;
      chart.setVisibleTimeRange({ from, to });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      const sampleTimes = [
        start,
        start + step * 3,
        start + step * (baseCount - 1),
        start + step * baseCount,
        patches[0]!.t,
        patches[1]!.t,
      ];

      for (const targetTime of sampleTimes) {
        snapshot = null;
        const ratio = (targetTime - from) / (to - from);
        const x = layout.plotRect.x + ratio * layout.plotRect.width;
        const y = layout.plotRect.y + layout.plotRect.height * 0.5;
        dispatchPointerMove(overlay, x, y);
        await waitFor(() => snapshot !== null);
        const expectedValue = resolveNearestNonNull(snapshot!.time);
        expect(snapshot!.seriesValues.get('Stream')?.value ?? null).toBe(expectedValue);
      }
    } finally {
      container.remove();
      restore();
    }
  });

  it('fuzzes sampling modes across random times', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    const lowerBound = (values: number[], target: number) => {
      let low = 0;
      let high = values.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (values[mid]! < target) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return low;
    };

    const resolveNearest = (times: number[], values: number[], time: number) => {
      const idx = lowerBound(times, time);
      const leftIndex = idx - 1;
      const rightIndex = idx;
      let bestValue: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestIndex = Number.POSITIVE_INFINITY;
      if (leftIndex >= 0) {
        const distance = Math.abs(times[leftIndex]! - time);
        if (distance < bestDistance || (distance === bestDistance && leftIndex < bestIndex)) {
          bestDistance = distance;
          bestValue = values[leftIndex]!;
          bestIndex = leftIndex;
        }
      }
      if (rightIndex < times.length) {
        const distance = Math.abs(times[rightIndex]! - time);
        if (distance < bestDistance || (distance === bestDistance && rightIndex < bestIndex)) {
          bestDistance = distance;
          bestValue = values[rightIndex]!;
          bestIndex = rightIndex;
        }
      }
      return bestValue;
    };

    const resolveHold = (times: number[], values: number[], time: number) => {
      const idx = lowerBound(times, time);
      if (idx < times.length && times[idx] === time) {
        return values[idx]!;
      }
      if (idx - 1 >= 0) {
        return values[idx - 1]!;
      }
      return values[idx] ?? null;
    };

    const resolveLinear = (times: number[], values: number[], time: number) => {
      const idx = lowerBound(times, time);
      if (idx - 1 < 0 || idx >= times.length) {
        return resolveNearest(times, values, time);
      }
      const t0 = times[idx - 1]!;
      const t1 = times[idx]!;
      const v0 = values[idx - 1]!;
      const v1 = values[idx]!;
      if (t1 === t0) return v1;
      const ratio = (time - t0) / (t1 - t0);
      return v0 + (v1 - v0) * ratio;
    };

    try {
      const chart = createChart(container, { width: 400, height: 240, crosshairMode: 'nearest' });
      const seriesNearest = chart.addLineSeries({ id: 'Nearest', sampleMode: 'nearest' });
      const seriesLinear = chart.addLineSeries({ id: 'Linear', sampleMode: 'linear' });
      const seriesHold = chart.addLineSeries({ id: 'Hold', sampleMode: 'hold' });
      const points = [
        { t: 0, v: 10 },
        { t: 120, v: 16 },
        { t: 260, v: 8 },
        { t: 520, v: 22 },
        { t: 900, v: 30 },
      ];
      seriesNearest.setData(points);
      seriesLinear.setData(points);
      seriesHold.setData(points);
      chart.setVisibleTimeRange({ from: 0, to: 900 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      const times = points.map((point) => point.t);
      const values = points.map((point) => point.v);
      const sampleTimes = [
        times[0]!,
        times[0]! + (times[1]! - times[0]!) * 0.33,
        times[1]! + (times[2]! - times[1]!) * 0.33,
        times[2]! + (times[3]! - times[2]!) * 0.33,
        times[3]! + (times[4]! - times[3]!) * 0.33,
        times[4]!,
      ];

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      for (const targetTime of sampleTimes) {
        snapshot = null;
        const ratio = targetTime / 900;
        const x = layout.plotRect.x + ratio * layout.plotRect.width;
        const y = layout.plotRect.y + layout.plotRect.height * 0.5;
        dispatchPointerMove(overlay, x, y);
        await waitFor(() => snapshot !== null);

        const eventTime = snapshot!.time;
        const expectedNearest = resolveNearest(times, values, eventTime);
        const expectedHold = resolveHold(times, values, eventTime);
        const expectedLinear = resolveLinear(times, values, eventTime);

        expect(snapshot!.seriesValues.get('Nearest')?.value).toBe(expectedNearest);
        expect(snapshot!.seriesValues.get('Hold')?.value).toBe(expectedHold);
        expect(snapshot!.seriesValues.get('Linear')?.value).toBeCloseTo(expectedLinear, 5);
      }
    } finally {
      container.remove();
      restore();
    }
  });

  it('fuzzes gapThresholdMs with nearest sampling', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    const lowerBound = (values: number[], target: number) => {
      let low = 0;
      let high = values.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (values[mid]! < target) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return low;
    };

    const resolveNearest = (times: number[], values: number[], time: number) => {
      const idx = lowerBound(times, time);
      const leftIndex = idx - 1;
      const rightIndex = idx;
      let bestValue: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestIndex = Number.POSITIVE_INFINITY;
      if (leftIndex >= 0) {
        const distance = Math.abs(times[leftIndex]! - time);
        if (distance < bestDistance || (distance === bestDistance && leftIndex < bestIndex)) {
          bestDistance = distance;
          bestValue = values[leftIndex]!;
          bestIndex = leftIndex;
        }
      }
      if (rightIndex < times.length) {
        const distance = Math.abs(times[rightIndex]! - time);
        if (distance < bestDistance || (distance === bestDistance && rightIndex < bestIndex)) {
          bestDistance = distance;
          bestValue = values[rightIndex]!;
          bestIndex = rightIndex;
        }
      }
      return bestValue;
    };

    const isGapBetween = (times: number[], time: number, gapThreshold: number) => {
      const idx = lowerBound(times, time);
      const leftIndex = idx - 1;
      const rightIndex = idx;
      if (leftIndex < 0 || rightIndex >= times.length) return false;
      const left = times[leftIndex]!;
      const right = times[rightIndex]!;
      return right - left > gapThreshold && time > left && time < right;
    };

    const mulberry32 = (seed: number) => {
      let t = seed >>> 0;
      return () => {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
    };

    try {
      const gapThreshold = 60;
      const chart = createChart(container, {
        width: 400,
        height: 240,
        gapThresholdMs: gapThreshold,
        crosshairMode: 'nearest',
      });
      const series = chart.addLineSeries({ id: 'Nearest', sampleMode: 'nearest' });

      const rng = mulberry32(42);
      const times: number[] = [];
      const values: number[] = [];
      let t = 0;
      for (let i = 0; i < 140; i += 1) {
        const bigGap = rng() < 0.12;
        t += bigGap ? gapThreshold * (2 + rng() * 3) : 10 + rng() * 20;
        times.push(t);
        values.push(90 + rng() * 20);
      }
      series.setData(times.map((time, index) => ({ t: time, v: values[index]! })));
      chart.setVisibleTimeRange({ from: times[0]!, to: times[times.length - 1]! });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let snapshot: CrosshairSnapshot | null = null;
      chart.onCrosshairMove((event) => {
        snapshot = event as CrosshairSnapshot;
      });

      for (let i = 0; i < 24; i += 1) {
        snapshot = null;
        const ratio = rng();
        const x = layout.plotRect.x + ratio * layout.plotRect.width;
        const y = layout.plotRect.y + layout.plotRect.height * 0.5;
        dispatchPointerMove(overlay, x, y);
        await waitFor(() => snapshot !== null);

        const eventTime = snapshot!.time;
        const expected = isGapBetween(times, eventTime, gapThreshold)
          ? null
          : resolveNearest(times, values, eventTime);
        expect(snapshot!.seriesValues.get('Nearest')?.value).toBe(expected);
      }
    } finally {
      container.remove();
      restore();
    }
  });
});
