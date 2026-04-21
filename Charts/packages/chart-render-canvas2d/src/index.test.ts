// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createChart, createOptionsChart, createSyncGroup, createYieldCurveChart } from './index';

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
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalSetPointerCapture = HTMLCanvasElement.prototype.setPointerCapture;
  const originalReleasePointerCapture = HTMLCanvasElement.prototype.releasePointerCapture;
  const originalHasPointerCapture = HTMLCanvasElement.prototype.hasPointerCapture;
  const hasSetPointerCapture = typeof originalSetPointerCapture === 'function';
  const hasReleasePointerCapture = typeof originalReleasePointerCapture === 'function';
  const hasHasPointerCapture = typeof originalHasPointerCapture === 'function';

  HTMLCanvasElement.prototype.getContext = () => createStubContext();
  if (!hasSetPointerCapture) {
    HTMLCanvasElement.prototype.setPointerCapture = () => {};
  }
  if (!hasReleasePointerCapture) {
    HTMLCanvasElement.prototype.releasePointerCapture = () => {};
  }
  if (!hasHasPointerCapture) {
    HTMLCanvasElement.prototype.hasPointerCapture = () => false;
  }
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    if (hasSetPointerCapture) {
      HTMLCanvasElement.prototype.setPointerCapture = originalSetPointerCapture;
    } else {
      delete (HTMLCanvasElement.prototype as { setPointerCapture?: (pointerId: number) => void })
        .setPointerCapture;
    }
    if (hasReleasePointerCapture) {
      HTMLCanvasElement.prototype.releasePointerCapture = originalReleasePointerCapture;
    } else {
      delete (HTMLCanvasElement.prototype as { releasePointerCapture?: (pointerId: number) => void })
        .releasePointerCapture;
    }
    if (hasHasPointerCapture) {
      HTMLCanvasElement.prototype.hasPointerCapture = originalHasPointerCapture;
    } else {
      delete (HTMLCanvasElement.prototype as { hasPointerCapture?: (pointerId: number) => boolean })
        .hasPointerCapture;
    }
  };
};

const createContainer = (width = 400, height = 240) => {
  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  return container;
};

const dispatchPointerEvent = (
  canvas: HTMLCanvasElement,
  type: string,
  x: number,
  y: number,
  pointerId = 1,
) => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'offsetX', { value: x });
  Object.defineProperty(event, 'offsetY', { value: y });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'button', { value: 0 });
  canvas.dispatchEvent(event);
};

const dispatchPointerMove = (canvas: HTMLCanvasElement, x: number, y: number, pointerId = 1) =>
  dispatchPointerEvent(canvas, 'pointermove', x, y, pointerId);
const dispatchPointerDown = (canvas: HTMLCanvasElement, x: number, y: number, pointerId = 1) =>
  dispatchPointerEvent(canvas, 'pointerdown', x, y, pointerId);
const dispatchPointerUp = (canvas: HTMLCanvasElement, x: number, y: number, pointerId = 1) =>
  dispatchPointerEvent(canvas, 'pointerup', x, y, pointerId);

const dispatchWheel = (
  canvas: HTMLCanvasElement,
  deltaX: number,
  deltaY: number,
  x: number,
  y: number,
) => {
  let event: Event;
  if (typeof WheelEvent === 'function') {
    event = new WheelEvent('wheel', { bubbles: true, deltaX, deltaY });
  } else {
    event = new Event('wheel', { bubbles: true });
    Object.defineProperty(event, 'deltaX', { value: deltaX });
    Object.defineProperty(event, 'deltaY', { value: deltaY });
  }
  Object.defineProperty(event, 'offsetX', { value: x });
  Object.defineProperty(event, 'offsetY', { value: y });
  canvas.dispatchEvent(event);
};

type DebugRect = { x: number; y: number; width: number; height: number };
type DebugPaneLayout = {
  id: string;
  plotRect: DebugRect;
  leftAxisRect: DebugRect | null;
  rightAxisRect: DebugRect | null;
};
type DebugLayout = {
  plotRect: DebugRect;
  panes?: DebugPaneLayout[];
};

type DebugAxisRange = { min: number; max: number; minPositive: number };
type DebugAxisRanges = Array<{ id: string; left: DebugAxisRange; right: DebugAxisRange }>;

type DebugChart = {
  __chartsPlusDebug?: {
    getLayout?: () => DebugLayout | null;
    getAxisRanges?: () => DebugAxisRanges;
    getCrosshairState?: () =>
      | { x: number; y: number; paneId: string; time: number }
      | null;
  };
};

const getLayout = (chart: DebugChart) => chart.__chartsPlusDebug?.getLayout?.() ?? null;
const getAxisRanges = (chart: DebugChart) => chart.__chartsPlusDebug?.getAxisRanges?.() ?? [];
const getCrosshairState = (chart: DebugChart) =>
  chart.__chartsPlusDebug?.getCrosshairState?.() ?? null;

describe('createChart (placeholder)', () => {
  it('mounts and destroys canvases', () => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    // jsdom does not implement CanvasRenderingContext2D without extra deps.
    // The placeholder draw is not under test here.
    HTMLCanvasElement.prototype.getContext = (() => null) as any;

    const container = document.createElement('div');
    container.style.width = '300px';
    container.style.height = '200px';
    document.body.appendChild(container);

    try {
      const chart = createChart(container, { width: 300, height: 200 });
      expect(container.querySelectorAll('canvas')).toHaveLength(4);

      chart.destroy();
      expect(container.querySelector('canvas')).toBeFalsy();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});

describe('sync group', () => {
  it('syncs visible time range', async () => {
    const restore = stubCanvasContext();
    const containerA = createContainer();
    const containerB = createContainer();

    try {
      const chartA = createChart(containerA, { width: 300, height: 200 });
      const chartB = createChart(containerB, { width: 300, height: 200 });
      const group = createSyncGroup();
      group.add(chartA);
      group.add(chartB);

      chartA.setVisibleTimeRange({ from: 0, to: 1000 });
      await waitFor(() => {
        const range = chartB.getVisibleTimeRange();
        return range.from === 0 && range.to === 1000;
      });

      group.destroy();
      chartA.destroy();
      chartB.destroy();
    } finally {
      containerA.remove();
      containerB.remove();
      restore();
    }
  });

  it('syncs crosshair time', async () => {
    const restore = stubCanvasContext();
    const containerA = createContainer();
    const containerB = createContainer();

    try {
      const chartA = createChart(containerA, { width: 300, height: 200 });
      const chartB = createChart(containerB, { width: 300, height: 200 });
      const seriesA = chartA.addLineSeries({ id: 'A' });
      const seriesB = chartB.addLineSeries({ id: 'B' });
      seriesA.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      seriesB.setData([
        { t: 0, v: 5 },
        { t: 1000, v: 15 },
      ]);
      chartA.setVisibleTimeRange({ from: 0, to: 1000 });
      chartB.setVisibleTimeRange({ from: 0, to: 1000 });

      const group = createSyncGroup();
      group.add(chartA);
      group.add(chartB);

      await waitFor(() => getLayout(chartA as DebugChart) !== null);
      const layout = getLayout(chartA as DebugChart)!;
      const canvases = containerA.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      const x = layout.plotRect.x + layout.plotRect.width * 0.4;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);

      await waitFor(() => getCrosshairState(chartA as DebugChart) !== null);
      await waitFor(() => getCrosshairState(chartB as DebugChart) !== null);

      const stateA = getCrosshairState(chartA as DebugChart)!;
      const stateB = getCrosshairState(chartB as DebugChart)!;
      expect(Math.abs(stateA.time - stateB.time)).toBeLessThan(1);

      group.destroy();
      chartA.destroy();
      chartB.destroy();
    } finally {
      containerA.remove();
      containerB.remove();
      restore();
    }
  });

  it('uses tickMarkFormatter for default time formatting', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();
    const tickFormatter = (time: number) => `t=${Math.round(time)}`;

    try {
      const chart = createChart(container, {
        width: 300,
        height: 200,
        timeScale: { tickMarkFormatter: tickFormatter },
      });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 1000, v: 10 },
        { t: 2000, v: 20 },
      ]);
      chart.setVisibleTimeRange({ from: 1000, to: 2000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let lastEvent: { time: number; formattedTime: string } | null = null;
      chart.onCrosshairMove((ev) => {
        lastEvent = { time: ev.time, formattedTime: ev.formattedTime };
      });

      const x = layout.plotRect.x + layout.plotRect.width * 0.4;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);

      await waitFor(() => lastEvent !== null);
      expect(lastEvent?.formattedTime).toBe(tickFormatter(lastEvent!.time));

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('formats crosshair values for yield curve charts', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();
    const formatter = (value: number) => `m=${Math.round(value)}`;

    try {
      const chart = createYieldCurveChart(container, {
        width: 300,
        height: 200,
        timeFormatter: formatter,
      });
      const series = chart.addLineSeries({ id: 'Curve' });
      series.setData([
        { t: 1, v: 3.4 },
        { t: 12, v: 4.1 },
        { t: 60, v: 4.8 },
      ]);
      chart.setVisibleTimeRange({ from: 1, to: 60 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let lastEvent: { time: number; formattedTime: string } | null = null;
      chart.onCrosshairMove((ev) => {
        lastEvent = { time: ev.time, formattedTime: ev.formattedTime };
      });

      const x = layout.plotRect.x;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);

      await waitFor(() => lastEvent !== null);
      expect(lastEvent?.formattedTime).toBe(formatter(lastEvent!.time));

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('formats crosshair values for options charts', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();
    const formatter = (value: number) => `k=${value.toFixed(1)}`;

    try {
      const chart = createOptionsChart(container, {
        width: 300,
        height: 200,
        xFormatter: formatter,
      });
      const series = chart.addLineSeries({ id: 'Smile' });
      series.setData([
        { t: 90, v: 0.32 },
        { t: 100, v: 0.28 },
        { t: 110, v: 0.3 },
      ]);
      chart.setVisibleTimeRange({ from: 90, to: 110 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;

      let lastEvent: { time: number; formattedTime: string } | null = null;
      chart.onCrosshairMove((ev) => {
        lastEvent = { time: ev.time, formattedTime: ev.formattedTime };
      });

      const x = layout.plotRect.x + layout.plotRect.width * 0.5;
      const y = layout.plotRect.y + layout.plotRect.height * 0.5;
      dispatchPointerMove(overlay, x, y);

      await waitFor(() => lastEvent !== null);
      expect(lastEvent?.formattedTime).toBe(formatter(lastEvent!.time));

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('resubscribes when re-added', async () => {
    const restore = stubCanvasContext();
    const containerA = createContainer();
    const containerB = createContainer();

    try {
      const chartA = createChart(containerA, { width: 300, height: 200 });
      const chartB = createChart(containerB, { width: 300, height: 200 });
      const group = createSyncGroup();
      group.add(chartA);
      const removeB = group.add(chartB);

      removeB();
      group.add(chartB);

      chartA.setVisibleTimeRange({ from: 0, to: 500 });
      await waitFor(() => {
        const range = chartB.getVisibleTimeRange();
        return range.from === 0 && range.to === 500;
      });

      group.destroy();
      chartA.destroy();
      chartB.destroy();
    } finally {
      containerA.remove();
      containerB.remove();
      restore();
    }
  });
});

describe('pane api', () => {
  it('reorders panes with moveTo', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(400, 300);

    try {
      const chart = createChart(container, { width: 400, height: 300 });
      const paneA = chart.addPane();
      const paneB = chart.addPane();
      const handleA = chart.getPane(paneA);
      const handleB = chart.getPane(paneB);
      expect(handleA).toBeTruthy();
      expect(handleB).toBeTruthy();

      handleB?.moveTo(1);
      await waitFor(() => {
        const layout = getLayout(chart as DebugChart);
        return layout?.panes && layout.panes.length === 3;
      });

      const layout = getLayout(chart as DebugChart)!;
      const paneIds = layout.panes?.map((pane) => pane.id) ?? [];
      expect(paneIds).toEqual(['pane-0', paneB, paneA]);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('applies fixed pane heights', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(400, 320);

    try {
      const chart = createChart(container, { width: 400, height: 320 });
      const paneId = chart.addPane();
      const handle = chart.getPane(paneId);
      expect(handle).toBeTruthy();

      handle?.setHeight(120);
      await waitFor(() => {
        const layout = getLayout(chart as DebugChart);
        return layout?.panes && layout.panes.length === 2;
      });

      const layout = getLayout(chart as DebugChart)!;
      const pane = layout.panes?.find((entry) => entry.id === paneId);
      expect(pane?.plotRect.height).toBe(120);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('resizes panes via drag handle', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(400, 320);

    try {
      const chart = createChart(container, {
        width: 400,
        height: 320,
        panes: { resize: { enabled: true, minHeightPx: 60, handleHeightPx: 8 } },
      });
      const paneA = chart.addPane();
      const paneB = chart.addPane();
      const seriesA = chart.addLineSeries({ id: 'A', paneId: paneA });
      const seriesB = chart.addLineSeries({ id: 'B', paneId: paneB });
      seriesA.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
      ]);
      seriesB.setData([
        { t: 0, v: 5 },
        { t: 1000, v: 15 },
      ]);

      await waitFor(() => {
        const layout = getLayout(chart as DebugChart);
        return layout?.panes && layout.panes.length === 3;
      });

      const layout = getLayout(chart as DebugChart)!;
      const panes = layout.panes!;
      const topPane = panes[0]!;
      const nextPane = panes[1]!;
      const dividerY = topPane.plotRect.y + topPane.plotRect.height;
      const x = layout.plotRect.x + layout.plotRect.width * 0.5;

      const canvases = container.querySelectorAll('canvas');
      const overlay = canvases[canvases.length - 1] as HTMLCanvasElement;
      dispatchPointerDown(overlay, x, dividerY, 1);
      dispatchPointerMove(overlay, x, dividerY + 20, 1);
      dispatchPointerUp(overlay, x, dividerY + 20, 1);

      await waitFor(() => {
        const updated = getLayout(chart as DebugChart);
        if (!updated?.panes) return false;
        return updated.panes[0]!.plotRect.height !== topPane.plotRect.height;
      });

      const updated = getLayout(chart as DebugChart)!;
      const updatedTop = updated.panes![0]!.plotRect.height;
      const updatedNext = updated.panes![1]!.plotRect.height;
      expect(updatedTop).toBeGreaterThan(topPane.plotRect.height);
      expect(updatedNext).toBeLessThan(nextPane.plotRect.height);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('honors preserveEmptyPane', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(400, 300);

    try {
      const chart = createChart(container, { width: 400, height: 300 });
      const paneId = chart.addPane(false);
      const handle = chart.getPane(paneId);
      expect(handle?.preserveEmptyPane()).toBe(false);

      await waitFor(() => {
        const layout = getLayout(chart as DebugChart);
        return layout?.panes && layout.panes.length === 1;
      });

      const layout = getLayout(chart as DebugChart)!;
      const paneIds = layout.panes?.map((pane) => pane.id) ?? [];
      expect(paneIds).toEqual(['pane-0']);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });
});

describe('axis interactions', () => {
  it('scales the price axis on drag when enabled', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(420, 300);

    try {
      const chart = createChart(container, {
        width: 420,
        height: 300,
        interaction: { handleScale: { axisDrag: true } },
      });
      const series = chart.addLineSeries();
      series.setData([
        { t: 0, v: 100 },
        { t: 1000, v: 120 },
        { t: 2000, v: 90 },
      ]);

      await waitFor(() => {
        const layout = getLayout(chart as DebugChart);
        return layout?.panes && layout.panes.length === 1;
      });

      const layout = getLayout(chart as DebugChart)!;
      const paneLayout = layout.panes![0]!;
      const axisRect = paneLayout.leftAxisRect;
      expect(axisRect).toBeTruthy();

      const before = getAxisRanges(chart as DebugChart).find((entry) => entry.id === 'pane-0')?.left;
      expect(before).toBeTruthy();
      const beforeSpan = before!.max - before!.min;

      const x = axisRect!.x + axisRect!.width * 0.5;
      const y = axisRect!.y + axisRect!.height * 0.5;
      const overlay = container.querySelectorAll('canvas')[3] as HTMLCanvasElement;

      dispatchPointerDown(overlay, x, y, 1);
      dispatchPointerMove(overlay, x, y - 40, 1);
      dispatchPointerUp(overlay, x, y - 40, 1);

      await waitFor(() => {
        const after = getAxisRanges(chart as DebugChart).find((entry) => entry.id === 'pane-0')?.left;
        return !!after && Math.abs(after.max - after.min - beforeSpan) > 1e-6;
      });

      const after = getAxisRanges(chart as DebugChart).find((entry) => entry.id === 'pane-0')?.left;
      expect(after).toBeTruthy();
      expect(after!.max - after!.min).toBeLessThan(beforeSpan);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('respects handleScale.axisDrag = false', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(420, 300);

    try {
      const chart = createChart(container, {
        width: 420,
        height: 300,
        interaction: { handleScale: { axisDrag: false } },
      });
      const series = chart.addLineSeries();
      series.setData([
        { t: 0, v: 50 },
        { t: 1000, v: 80 },
        { t: 2000, v: 60 },
      ]);

      await waitFor(() => {
        const layout = getLayout(chart as DebugChart);
        return layout?.panes && layout.panes.length === 1;
      });

      const layout = getLayout(chart as DebugChart)!;
      const paneLayout = layout.panes![0]!;
      const axisRect = paneLayout.leftAxisRect;
      expect(axisRect).toBeTruthy();

      const before = getAxisRanges(chart as DebugChart).find((entry) => entry.id === 'pane-0')?.left;
      expect(before).toBeTruthy();

      const x = axisRect!.x + axisRect!.width * 0.5;
      const y = axisRect!.y + axisRect!.height * 0.5;
      const overlay = container.querySelectorAll('canvas')[3] as HTMLCanvasElement;

      dispatchPointerDown(overlay, x, y, 1);
      dispatchPointerMove(overlay, x, y - 40, 1);
      dispatchPointerUp(overlay, x, y - 40, 1);

      await new Promise((resolve) => setTimeout(resolve, 40));
      const after = getAxisRanges(chart as DebugChart).find((entry) => entry.id === 'pane-0')?.left;
      expect(after).toBeTruthy();
      expect(after!.min).toBeCloseTo(before!.min, 6);
      expect(after!.max).toBeCloseTo(before!.max, 6);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('respects scroll/scale interaction toggles', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(420, 300);

    try {
      const chart = createChart(container, {
        width: 420,
        height: 300,
        interaction: {
          handleScroll: { pressedMouseMove: false },
          handleScale: { mouseWheel: false },
        },
      });
      const series = chart.addLineSeries();
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
        { t: 2000, v: 15 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 2000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const plotRect = layout.plotRect;
      const x = plotRect.x + plotRect.width * 0.5;
      const y = plotRect.y + plotRect.height * 0.5;
      const overlay = container.querySelectorAll('canvas')[3] as HTMLCanvasElement;

      const before = chart.getVisibleTimeRange();
      dispatchWheel(overlay, 0, -120, x, y);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const afterWheel = chart.getVisibleTimeRange();
      expect(afterWheel.from).toBeCloseTo(before.from, 6);
      expect(afterWheel.to).toBeCloseTo(before.to, 6);

      dispatchPointerDown(overlay, x, y, 1);
      dispatchPointerMove(overlay, x + 80, y, 1);
      dispatchPointerUp(overlay, x + 80, y, 1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const afterDrag = chart.getVisibleTimeRange();
      expect(afterDrag.from).toBeCloseTo(before.from, 6);
      expect(afterDrag.to).toBeCloseTo(before.to, 6);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('ignores wheel zoom while dragging', async () => {
    const restore = stubCanvasContext();
    const container = createContainer(420, 300);

    try {
      const chart = createChart(container, { width: 420, height: 300 });
      const series = chart.addLineSeries();
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 20 },
        { t: 2000, v: 15 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 2000 });

      await waitFor(() => getLayout(chart as DebugChart) !== null);
      const layout = getLayout(chart as DebugChart)!;
      const plotRect = layout.plotRect;
      const x = plotRect.x + plotRect.width * 0.5;
      const y = plotRect.y + plotRect.height * 0.5;
      const overlay = container.querySelectorAll('canvas')[3] as HTMLCanvasElement;

      const before = chart.getVisibleTimeRange();
      const beforeSpan = before.to - before.from;

      dispatchPointerDown(overlay, x, y, 1);
      dispatchWheel(overlay, 0, -120, x, y);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const during = chart.getVisibleTimeRange();
      expect(during.from).toBeCloseTo(before.from, 6);
      expect(during.to).toBeCloseTo(before.to, 6);

      dispatchPointerUp(overlay, x, y, 1);
      dispatchWheel(overlay, 0, -120, x, y);
      await waitFor(() => {
        const after = chart.getVisibleTimeRange();
        return Math.abs(after.to - after.from - beforeSpan) > 1e-6;
      });
      const after = chart.getVisibleTimeRange();
      expect(after.to - after.from).not.toBeCloseTo(beforeSpan, 6);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });
});

describe('series api additions', () => {
  it('accepts OHLC and histogram series APIs', () => {
    const restore = stubCanvasContext();
    const container = createContainer(360, 240);

    try {
      const chart = createChart(container, { width: 360, height: 240 });
      const candle = chart.addCandlestickSeries({ id: 'OHLC' });
      const bar = chart.addBarSeries({ id: 'Bars' });
      const hist = chart.addHistogramSeries({ id: 'Hist' });
      const area = chart.addAreaSeries({ id: 'Area' });
      const baseline = chart.addBaselineSeries({ id: 'Base' });

      candle.setData([
        { t: 0, o: 10, h: 12, l: 9, c: 11 },
        { t: 1, o: 11, h: 13, l: 10, c: 12 },
      ]);
      bar.append({ t: 2, o: 12, h: 14, l: 11, c: 13 });
      hist.appendBatch([
        { t: 0, v: 100 },
        { t: 1, v: 120 },
      ]);
      area.setData([
        { t: 0, v: 5 },
        { t: 1, v: 6 },
      ]);
      baseline.setData([
        { t: 0, v: 4 },
        { t: 1, v: 7 },
      ]);

      expect(candle.id).toBe('OHLC');
      expect(bar.getVisible()).toBe(true);
      expect(hist.getVisible()).toBe(true);

      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });
});
