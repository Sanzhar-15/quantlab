// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { DataChunk, DataProvider, DataProviderUpdate } from '@charts-plus/chart-core';

import { createChart } from './index';

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

const createContainer = (width = 320, height = 180) => {
  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  return container;
};

const nextFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(() => resolve(), 16);
  });

type DebugChart = {
  __chartsPlusDebug?: {
    getSeriesDataInfo?: () => Array<{
      id: string;
      mode: 'chunked' | 'static';
      length: number;
      chunks: number;
      bytesUsed: number | null;
    }>;
  };
};

const getSeriesLength = (chart: DebugChart, id: string): number => {
  const info = chart.__chartsPlusDebug?.getSeriesDataInfo?.() ?? [];
  return info.find((entry) => entry.id === id)?.length ?? 0;
};

describe('streaming backpressure', () => {
  it('applies all provider updates by default', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();
    let subscriber: ((update: DataProviderUpdate) => void) | null = null;
    const emptyChunk: DataChunk = { time: new Float64Array(0), value: new Float64Array(0), length: 0 };
    const provider: DataProvider = {
      getRange: async () => emptyChunk,
      subscribe: (cb) => {
        subscriber = cb;
        return () => {
          subscriber = null;
        };
      },
    };

    try {
      const chart = createChart(container, { width: 320, height: 180 });
      const seriesId = 's-default';
      const series = chart.addLineSeries({ id: seriesId });
      series.setDataProvider(provider);
      await nextFrame();

      for (let i = 0; i < 5; i += 1) {
        subscriber?.({ type: 'append', point: { t: i, v: i + 10 } });
      }
      await nextFrame();

      expect(getSeriesLength(chart as DebugChart, seriesId)).toBe(5);
      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('drops updates when backpressure is drop', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();
    let subscriber: ((update: DataProviderUpdate) => void) | null = null;
    const emptyChunk: DataChunk = { time: new Float64Array(0), value: new Float64Array(0), length: 0 };
    const provider: DataProvider = {
      getRange: async () => emptyChunk,
      subscribe: (cb) => {
        subscriber = cb;
        return () => {
          subscriber = null;
        };
      },
    };

    try {
      const chart = createChart(container, { width: 320, height: 180 });
      const seriesId = 's-drop';
      const series = chart.addLineSeries({ id: seriesId });
      series.setDataProvider(provider, { maxPendingUpdates: 1, backpressure: 'drop' });
      await nextFrame();

      for (let i = 0; i < 4; i += 1) {
        subscriber?.({ type: 'append', point: { t: i, v: 20 + i } });
      }
      await nextFrame();

      expect(getSeriesLength(chart as DebugChart, seriesId)).toBe(1);
      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });

  it('coalesces updates when backpressure is coalesce', async () => {
    const restore = stubCanvasContext();
    const container = createContainer();
    let subscriber: ((update: DataProviderUpdate) => void) | null = null;
    const emptyChunk: DataChunk = { time: new Float64Array(0), value: new Float64Array(0), length: 0 };
    const provider: DataProvider = {
      getRange: async () => emptyChunk,
      subscribe: (cb) => {
        subscriber = cb;
        return () => {
          subscriber = null;
        };
      },
    };

    try {
      const chart = createChart(container, { width: 320, height: 180 });
      const seriesId = 's-coalesce';
      const series = chart.addLineSeries({ id: seriesId });
      series.setDataProvider(provider, { maxPendingUpdates: 1, backpressure: 'coalesce' });
      await nextFrame();

      for (let i = 0; i < 6; i += 1) {
        subscriber?.({ type: 'append', point: { t: i, v: 30 + i } });
      }
      await nextFrame();

      expect(getSeriesLength(chart as DebugChart, seriesId)).toBe(6);
      chart.destroy();
    } finally {
      container.remove();
      restore();
    }
  });
});
