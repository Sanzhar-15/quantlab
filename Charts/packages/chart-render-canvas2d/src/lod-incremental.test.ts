// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createChart } from './index';

type LodInfo = { id: string; levelCount: number; building: boolean; levels: Array<{ length: number }> };
type DebugChart = {
  __chartsPlusDebug?: {
    getSeriesLodInfo?: () => LodInfo[];
  };
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
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = () => createStubContext();
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
};

const createContainer = (width = 360, height = 220) => {
  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  return container;
};

const buildPoints = (start: number, count: number, step = 1) =>
  Array.from({ length: count }, (_, i) => ({
    t: start + i * step,
    v: 100 + i * 0.1,
  }));

describe('LOD incremental updates', () => {
  it('keeps LOD populated after append and patch', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, { width: 360, height: 220 });
      const series = chart.addLineSeries({ id: 'Series' });
      const points = buildPoints(0, 3000, 1);
      series.setData(points);

      const debug = chart as DebugChart;
      await waitFor(() => {
        const info = debug.__chartsPlusDebug?.getSeriesLodInfo?.().find((entry) => entry.id === 'Series');
        return !!info && info.levelCount > 0 && !info.building;
      });

      const before = debug.__chartsPlusDebug?.getSeriesLodInfo?.().find((entry) => entry.id === 'Series')!;
      expect(before.levelCount).toBeGreaterThan(0);

      const append = buildPoints(points[points.length - 1]!.t + 1, 50, 1);
      series.appendBatch(append);

      await waitFor(() => {
        const info = debug.__chartsPlusDebug?.getSeriesLodInfo?.().find((entry) => entry.id === 'Series');
        return !!info && info.levelCount > 0 && !info.building;
      });

      const afterAppend = debug.__chartsPlusDebug?.getSeriesLodInfo?.().find((entry) => entry.id === 'Series')!;
      expect(afterAppend.levelCount).toBeGreaterThan(0);

      series.patchExisting([{ t: points[100]!.t, v: 150 }]);

      await waitFor(() => {
        const info = debug.__chartsPlusDebug?.getSeriesLodInfo?.().find((entry) => entry.id === 'Series');
        return !!info && info.levelCount > 0 && !info.building;
      });

      const afterPatch = debug.__chartsPlusDebug?.getSeriesLodInfo?.().find((entry) => entry.id === 'Series')!;
      expect(afterPatch.levelCount).toBeGreaterThan(0);
      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });
});
