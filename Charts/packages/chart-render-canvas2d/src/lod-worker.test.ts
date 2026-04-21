// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import './worker';
import type { DataChunk, DataProvider, VisibleTimeRange } from '@charts-plus/chart-core';

import { createChart } from './index';

type LodInfo = {
  id: string;
  levelCount: number;
  levels: Array<{ bucketSize: number; length: number }>;
  building: boolean;
};

type ChunkLodInfo = {
  id: string;
  chunks: Array<{
    startTime: number;
    endTime: number;
    length: number;
    levelCount: number;
    levels: Array<{ bucketSize: number; length: number }>;
    pendingWorker: boolean;
    pendingBuild: boolean;
  }>;
};

type DebugApi = {
  getSeriesLodInfo: () => LodInfo[];
  getChunkLodInfo: () => ChunkLodInfo[];
};

const buildPoints = (count: number) => {
  const points = new Array(count);
  let time = 0;
  for (let i = 0; i < count; i += 1) {
    time += 60_000;
    points[i] = { t: time, v: Math.sin(i / 10) * 100 };
  }
  return points;
};

const buildChunk = (count: number): { chunk: DataChunk; range: VisibleTimeRange } => {
  const time = new Float64Array(count);
  const value = new Float64Array(count);
  let current = 0;
  for (let i = 0; i < count; i += 1) {
    current += 60_000;
    time[i] = current;
    value[i] = Math.sin(i / 10) * 100;
  }
  return {
    chunk: { time, value, length: count },
    range: { from: time[0]!, to: time[count - 1]! },
  };
};

const createProvider = (chunk: DataChunk, range: VisibleTimeRange): DataProvider => ({
  getRange: async () => chunk,
  getExtents: async () => range,
});

const waitFor = async (
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) => {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 10;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition.');
};

const getDebug = (chart: unknown): DebugApi => {
  const debug = (chart as { __chartsPlusDebug?: DebugApi }).__chartsPlusDebug;
  if (!debug) {
    throw new Error('Missing __chartsPlusDebug hook.');
  }
  return debug;
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
    drawImage: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
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

describe('LOD worker pipeline', () => {
  it('builds LOD progressively without a Worker', async () => {
    const restoreCanvas = stubCanvasContext();
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    try {
      (globalThis as { Worker?: undefined }).Worker = undefined;

      const container = document.createElement('div');
      container.style.width = '800px';
      container.style.height = '400px';
      document.body.appendChild(container);

      const chart = createChart(container, { width: 800, height: 400 });
      const series = chart.addLineSeries();
      const pointCount = 120_000;
      series.setData(buildPoints(pointCount));

      const debug = getDebug(chart);
      expect(debug.getSeriesLodInfo()[0]?.building).toBe(true);

      await waitFor(() => (debug.getSeriesLodInfo()[0]?.levelCount ?? 0) > 0);
      await waitFor(() => debug.getSeriesLodInfo()[0]?.building === false);

      const expectedLevels = Math.min(8, Math.floor(Math.log2(pointCount)));
      expect(debug.getSeriesLodInfo()[0]?.levelCount).toBe(expectedLevels);

      chart.destroy();
      container.remove();
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
      restoreCanvas();
    }
  });

  it('applies progressive updates from a Worker', async () => {
    const restoreCanvas = stubCanvasContext();
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    const originalBlob = (globalThis as { Blob?: typeof Blob }).Blob;
    const originalCreateObjectURL = (globalThis as { URL?: URL }).URL?.createObjectURL;
    const originalRevokeObjectURL = (globalThis as { URL?: URL }).URL?.revokeObjectURL;

    const makeLevel = (bucketSize: number) => {
      const time = new Float64Array([0, 1]);
      const value = new Float64Array([1, 2]);
      return { bucketSize, time, value, length: time.length };
    };

    class FakeWorker {
      public onmessage: ((event: MessageEvent) => void) | null = null;
      private _terminated = false;

      public constructor(_url: string) {}

      public postMessage(data: any): void {
        if (this._terminated) return;
        const { requestId, length } = data;
        const first = makeLevel(256);
        const second = makeLevel(128);
        setTimeout(() => {
          this._emit({ requestId, length, levels: [first], done: false });
        }, 0);
        setTimeout(() => {
          this._emit({ requestId, length, levels: [second], done: true });
        }, 5);
      }

      public terminate(): void {
        this._terminated = true;
      }

      private _emit(payload: any): void {
        this.onmessage?.({ data: payload } as MessageEvent);
      }
    }

    try {
      if (!(globalThis as { URL?: URL }).URL) {
        (globalThis as { URL?: any }).URL = {} as any;
      }
      const url = (globalThis as { URL: URL }).URL;
      if (!url.createObjectURL) {
        url.createObjectURL = () => 'blob:lod-worker';
      }
      if (!url.revokeObjectURL) {
        url.revokeObjectURL = () => {};
      }
      if (!(globalThis as { Blob?: typeof Blob }).Blob) {
        (globalThis as { Blob?: any }).Blob = class FakeBlob {} as any;
      }
      (globalThis as { Worker?: typeof Worker }).Worker = FakeWorker as unknown as typeof Worker;

      const container = document.createElement('div');
      container.style.width = '800px';
      container.style.height = '400px';
      document.body.appendChild(container);

      const chart = createChart(container, { width: 800, height: 400 });
      const series = chart.addLineSeries();
      const pointCount = 120_000;
      series.setData(buildPoints(pointCount));

      const debug = getDebug(chart);
      await waitFor(() => (debug.getSeriesLodInfo()[0]?.levelCount ?? 0) >= 1);
      await waitFor(() => (debug.getSeriesLodInfo()[0]?.levelCount ?? 0) >= 2);
      await waitFor(() => debug.getSeriesLodInfo()[0]?.building === false);

      chart.destroy();
      container.remove();
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
      if (originalBlob) {
        (globalThis as { Blob?: typeof Blob }).Blob = originalBlob;
      } else {
        delete (globalThis as { Blob?: typeof Blob }).Blob;
      }
      const url = (globalThis as { URL?: URL }).URL;
      if (url) {
        if (originalCreateObjectURL) {
          url.createObjectURL = originalCreateObjectURL;
        } else {
          delete (url as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
        }
        if (originalRevokeObjectURL) {
          url.revokeObjectURL = originalRevokeObjectURL;
        } else {
          delete (url as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
        }
      }
      restoreCanvas();
    }
  });

  it('builds chunked LOD progressively without a Worker', async () => {
    const restoreCanvas = stubCanvasContext();
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    try {
      (globalThis as { Worker?: undefined }).Worker = undefined;

      const container = document.createElement('div');
      container.style.width = '800px';
      container.style.height = '400px';
      document.body.appendChild(container);

      const chart = createChart(container, { width: 800, height: 400 });
      const series = chart.addLineSeries();
      const pointCount = 60_000;
      const { chunk, range } = buildChunk(pointCount);
      series.setDataProvider(createProvider(chunk, range), { chunkSize: pointCount });

      const debug = getDebug(chart);
      await waitFor(() => (debug.getChunkLodInfo()[0]?.chunks.length ?? 0) > 0);
      await waitFor(() => (debug.getChunkLodInfo()[0]?.chunks[0]?.levelCount ?? 0) > 0);
      await waitFor(() => {
        const info = debug.getChunkLodInfo()[0]?.chunks[0];
        return info ? !info.pendingBuild && !info.pendingWorker : false;
      });

      const expectedLevels = Math.min(8, Math.floor(Math.log2(pointCount)));
      expect(debug.getChunkLodInfo()[0]?.chunks[0]?.levelCount).toBe(expectedLevels);

      chart.destroy();
      container.remove();
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
      restoreCanvas();
    }
  });

  it('applies progressive chunk LOD updates from a Worker', async () => {
    const restoreCanvas = stubCanvasContext();
    const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
    const originalBlob = (globalThis as { Blob?: typeof Blob }).Blob;
    const originalCreateObjectURL = (globalThis as { URL?: URL }).URL?.createObjectURL;
    const originalRevokeObjectURL = (globalThis as { URL?: URL }).URL?.revokeObjectURL;

    const makeLevel = (bucketSize: number) => {
      const time = new Float64Array([0, 1]);
      const value = new Float64Array([1, 2]);
      return { bucketSize, time, value, length: time.length };
    };

    class FakeWorker {
      public onmessage: ((event: MessageEvent) => void) | null = null;
      private _terminated = false;

      public constructor(_url: string) {}

      public postMessage(data: any): void {
        if (this._terminated) return;
        const { requestId, length } = data;
        const first = makeLevel(256);
        const second = makeLevel(128);
        setTimeout(() => {
          this._emit({ requestId, length, levels: [first], done: false });
        }, 0);
        setTimeout(() => {
          this._emit({ requestId, length, levels: [second], done: true });
        }, 5);
      }

      public terminate(): void {
        this._terminated = true;
      }

      private _emit(payload: any): void {
        this.onmessage?.({ data: payload } as MessageEvent);
      }
    }

    try {
      if (!(globalThis as { URL?: URL }).URL) {
        (globalThis as { URL?: any }).URL = {} as any;
      }
      const url = (globalThis as { URL: URL }).URL;
      if (!url.createObjectURL) {
        url.createObjectURL = () => 'blob:lod-worker';
      }
      if (!url.revokeObjectURL) {
        url.revokeObjectURL = () => {};
      }
      if (!(globalThis as { Blob?: typeof Blob }).Blob) {
        (globalThis as { Blob?: any }).Blob = class FakeBlob {} as any;
      }
      (globalThis as { Worker?: typeof Worker }).Worker = FakeWorker as unknown as typeof Worker;

      const container = document.createElement('div');
      container.style.width = '800px';
      container.style.height = '400px';
      document.body.appendChild(container);

      const chart = createChart(container, { width: 800, height: 400 });
      const series = chart.addLineSeries();
      const pointCount = 60_000;
      const { chunk, range } = buildChunk(pointCount);
      series.setDataProvider(createProvider(chunk, range), { chunkSize: pointCount });

      const debug = getDebug(chart);
      await waitFor(() => (debug.getChunkLodInfo()[0]?.chunks[0]?.levelCount ?? 0) >= 1);
      await waitFor(() => (debug.getChunkLodInfo()[0]?.chunks[0]?.levelCount ?? 0) >= 2);
      await waitFor(() => {
        const info = debug.getChunkLodInfo()[0]?.chunks[0];
        return info ? !info.pendingBuild && !info.pendingWorker : false;
      });

      chart.destroy();
      container.remove();
    } finally {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
      if (originalBlob) {
        (globalThis as { Blob?: typeof Blob }).Blob = originalBlob;
      } else {
        delete (globalThis as { Blob?: typeof Blob }).Blob;
      }
      const url = (globalThis as { URL?: URL }).URL;
      if (url) {
        if (originalCreateObjectURL) {
          url.createObjectURL = originalCreateObjectURL;
        } else {
          delete (url as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
        }
        if (originalRevokeObjectURL) {
          url.revokeObjectURL = originalRevokeObjectURL;
        } else {
          delete (url as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
        }
      }
      restoreCanvas();
    }
  });
});
