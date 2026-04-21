// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { DataProvider } from '@charts-plus/chart-core';

import { createChart } from './index';

type RetentionStats = { dataChunks: number; lodOnlyChunks: number };
type DebugChart = {
  __chartsPlusDebug?: {
    readRenderStats?: () => { retention?: RetentionStats };
    getSeriesDataInfo?: () => Array<{ id: string; length: number }>;
  };
};

const waitFor = async (
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) => {
  const timeoutMs = options.timeoutMs ?? 1500;
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

const buildChunk = (count: number, stepMs: number) => {
  const time = new Float64Array(count);
  const value = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    time[i] = i * stepMs;
    value[i] = 100 + i * 0.2;
  }
  return { time, value, length: count };
};

describe('memory policy retention', () => {
  it('keeps LOD-only chunks when raw retention evicts data', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();

    try {
      const chunkSize = 10;
      const length = 100;
      const stepMs = 1000;
      const totalChunks = Math.ceil(length / chunkSize);
      const chunk = buildChunk(length, stepMs);
      const provider: DataProvider = {
        getRange: async () => chunk,
      };

      const chart = createChart(container, {
        width: 360,
        height: 220,
        rawRetentionMs: 5000,
      });
      const series = chart.addLineSeries({ id: 'Series' });
      series.setDataProvider(provider, { chunkSize });

      const debug = chart as DebugChart;
      await waitFor(() => {
        const info = debug.__chartsPlusDebug?.getSeriesDataInfo?.() ?? [];
        return info.find((entry) => entry.id === 'Series')?.length === length;
      });

      chart.setVisibleTimeRange({ from: 30 * stepMs, to: 35 * stepMs });

      await waitFor(() => {
        const retention = debug.__chartsPlusDebug?.readRenderStats?.().retention;
        return !!retention && retention.lodOnlyChunks > 0 && retention.dataChunks < totalChunks;
      });

      const retention = debug.__chartsPlusDebug?.readRenderStats?.().retention!;
      expect(retention.lodOnlyChunks).toBeGreaterThan(0);
      expect(retention.dataChunks).toBeLessThan(totalChunks);
      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });
});
