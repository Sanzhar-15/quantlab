// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createChart } from './index';

type DebugChart = { __chartsPlusDebug?: { getLayout?: () => { plotRect: { x: number; y: number; width: number; height: number } } | null; getCrosshairState?: () => { x: number; y: number; time: number; paneId: string } | null } };

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
    drawImage: () => {},
    transform: () => {},
    imageSmoothingEnabled: false,
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

const createContainer = () => {
  const container = document.createElement('div');
  container.style.width = '400px';
  container.style.height = '240px';
  document.body.appendChild(container);
  return container;
};

const dispatchKey = (target: HTMLElement, key: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...options });
  target.dispatchEvent(event);
};

const getLayout = (chart: DebugChart) => chart.__chartsPlusDebug?.getLayout?.() ?? null;
const getCrosshair = (chart: DebugChart) => chart.__chartsPlusDebug?.getCrosshairState?.() ?? null;

describe('keyboard interactions', () => {
  it('pans and zooms when focused', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, {
        width: 400,
        height: 240,
        timeScale: { minRangeMs: 1 },
      });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 12 },
        { t: 2000, v: 11 },
        { t: 3000, v: 13 },
      ]);
      chart.setVisibleTimeRange({ from: 500, to: 2500 });
      await waitFor(() => getLayout(chart as DebugChart) !== null);

      container.focus();
      const before = chart.getVisibleTimeRange();
      dispatchKey(container, 'ArrowLeft');
      await waitFor(() => chart.getVisibleTimeRange().from !== before.from);
      const afterPan = chart.getVisibleTimeRange();
      expect(afterPan.from).toBeLessThan(before.from);

      const spanBefore = afterPan.to - afterPan.from;
      dispatchKey(container, '=');
      await waitFor(() => chart.getVisibleTimeRange().to - chart.getVisibleTimeRange().from < spanBefore);
    } finally {
      container.remove();
      restore();
    }
  });

  it('toggles crosshair with keyboard', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 400, height: 240 });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1000, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1000 });
      await waitFor(() => getLayout(chart as DebugChart) !== null);

      container.focus();
      expect(getCrosshair(chart as DebugChart)).toBeNull();
      dispatchKey(container, 'c');
      await waitFor(() => getCrosshair(chart as DebugChart) !== null);
      dispatchKey(container, 'Escape');
      await waitFor(() => getCrosshair(chart as DebugChart) === null);
    } finally {
      container.remove();
      restore();
    }
  });
});
