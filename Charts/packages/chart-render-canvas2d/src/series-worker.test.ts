// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createChart } from './index';
import { getSeriesWorkerFactory, registerWorkerFactories } from './worker-registry';

type SeriesRendererInfo = { requested: string; active: string; supported: boolean };
type DebugChart = {
  __chartsPlusDebug?: {
    getSeriesRendererInfo?: () => SeriesRendererInfo;
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
    bezierCurveTo: () => {},
    arc: () => {},
    arcTo: () => {},
    fill: () => {},
    fillText: () => {},
    measureText: (text: string) => ({ width: text.length * 6 } as TextMetrics),
    setLineDash: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: () => {},
    scale: () => {},
    translate: () => {},
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt' as CanvasLineCap,
  };
  return ctx as unknown as CanvasRenderingContext2D;
};

const stubCanvasContext = () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = () => createStubContext();
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  };
};

const createContainer = (width = 320, height = 200) => {
  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  return container;
};

const getSeriesRendererInfo = (chart: DebugChart) =>
  chart.__chartsPlusDebug?.getSeriesRendererInfo?.() ?? null;

class FakeWorker {
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  postMessage(_message: unknown, _transfer?: Transferable[]) {}
  terminate() {}
}

const withWorkerStubs = (options: { throwOnTransfer?: boolean }) => {
  const originalWorker = (globalThis as { Worker?: typeof Worker }).Worker;
  const originalOffscreen = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  const originalTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;

  (globalThis as { Worker?: typeof Worker }).Worker = FakeWorker as unknown as typeof Worker;
  (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas = class {};

  HTMLCanvasElement.prototype.transferControlToOffscreen = function transferControlToOffscreenStub() {
    if (options.throwOnTransfer) {
      throw new Error('transfer failed');
    }
    return {} as OffscreenCanvas;
  };

  return () => {
    if (originalWorker) {
      (globalThis as { Worker?: typeof Worker }).Worker = originalWorker;
    } else {
      delete (globalThis as { Worker?: typeof Worker }).Worker;
    }
    if (originalOffscreen) {
      (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas = originalOffscreen;
    } else {
      delete (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
    }
    if (originalTransfer) {
      HTMLCanvasElement.prototype.transferControlToOffscreen = originalTransfer;
    } else {
      delete (HTMLCanvasElement.prototype as { transferControlToOffscreen?: () => OffscreenCanvas })
        .transferControlToOffscreen;
    }
  };
};

describe('series worker stability', () => {
  it('falls back to main when worker factory is not registered', () => {
    const restoreContext = stubCanvasContext();
    const container = createContainer();
    const previousFactory = getSeriesWorkerFactory();
    registerWorkerFactories({ series: null });

    try {
      const chart = createChart(container, {
        width: 320,
        height: 200,
        seriesRenderer: 'worker',
      }) as DebugChart;
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1 });

      const info = getSeriesRendererInfo(chart);
      expect(info?.requested).toBe('worker');
      expect(info?.supported).toBe(false);
      expect(info?.active).toBe('main');
      chart.destroy();
    } finally {
      registerWorkerFactories({ series: previousFactory ?? null });
      container.remove();
      restoreContext();
    }
  });

  it('falls back to main when worker init fails', () => {
    const restoreContext = stubCanvasContext();
    const restoreWorker = withWorkerStubs({ throwOnTransfer: true });
    const container = createContainer();
    const previousFactory = getSeriesWorkerFactory();
    registerWorkerFactories({ series: () => new FakeWorker() as unknown as Worker });

    try {
      const chart = createChart(container, {
        width: 320,
        height: 200,
        seriesRenderer: 'worker',
      }) as DebugChart;
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1 });

      const info = getSeriesRendererInfo(chart);
      expect(info?.requested).toBe('worker');
      expect(info?.supported).toBe(true);
      expect(info?.active).toBe('main');
      chart.destroy();
    } finally {
      registerWorkerFactories({ series: previousFactory ?? null });
      container.remove();
      restoreWorker();
      restoreContext();
    }
  });

  it('uses worker when supported and init succeeds', () => {
    const restoreContext = stubCanvasContext();
    const restoreWorker = withWorkerStubs({ throwOnTransfer: false });
    const container = createContainer();
    const previousFactory = getSeriesWorkerFactory();
    registerWorkerFactories({ series: () => new FakeWorker() as unknown as Worker });

    try {
      const chart = createChart(container, {
        width: 320,
        height: 200,
        seriesRenderer: 'worker',
      }) as DebugChart;
      const series = chart.addLineSeries({ id: 'Series' });
      series.setData([
        { t: 0, v: 10 },
        { t: 1, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: 0, to: 1 });

      const info = getSeriesRendererInfo(chart);
      expect(info?.requested).toBe('worker');
      expect(info?.supported).toBe(true);
      expect(info?.active).toBe('worker');
      chart.destroy();
    } finally {
      registerWorkerFactories({ series: previousFactory ?? null });
      container.remove();
      restoreWorker();
      restoreContext();
    }
  });
});
