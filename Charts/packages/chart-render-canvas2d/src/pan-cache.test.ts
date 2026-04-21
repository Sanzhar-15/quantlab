// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createChart } from './index';

type PanCacheState = { active: boolean; seriesHidden: boolean; panActive: boolean };
type DebugChart = {
  __chartsPlusDebug?: {
    getLayout?: () =>
      | { plotRect: { x: number; y: number; width: number; height: number } }
      | null;
    getPanCacheState?: () => PanCacheState;
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

const createContainer = (width = 360, height = 220) => {
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

describe('pan cache stability', () => {
  it('activates cache during pan and clears after release', async () => {
    const restoreContext = stubCanvasContext();
    const container = createContainer();

    try {
      const chart = createChart(container, {
        width: 360,
        height: 220,
        pan: { overscanRatio: 0.25 },
      });
      const series = chart.addLineSeries({ id: 'Series' });
      const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
      const points = Array.from({ length: 40 }, (_, i) => ({
        t: t0 + i * 60_000,
        v: 100 + i * 0.2,
      }));
      series.setData(points);
      chart.setVisibleTimeRange({ from: points[0]!.t, to: points[points.length - 1]!.t });

      const debugChart = chart as DebugChart;
      await waitFor(() => debugChart.__chartsPlusDebug?.getLayout?.() !== null);
      const overlay = container.querySelectorAll('canvas')[3] as HTMLCanvasElement;
      const layout = debugChart.__chartsPlusDebug?.getLayout?.();
      const plot = layout!.plotRect;
      const centerX = plot.x + plot.width * 0.5;
      const centerY = plot.y + plot.height * 0.5;

      dispatchPointerEvent(overlay, 'pointerdown', centerX, centerY);
      dispatchPointerEvent(overlay, 'pointermove', centerX + 30, centerY);

      await waitFor(() => {
        const state = debugChart.__chartsPlusDebug?.getPanCacheState?.();
        return !!state && state.panActive && state.active && state.seriesHidden;
      });

      dispatchPointerEvent(overlay, 'pointerup', centerX + 30, centerY);

      await waitFor(() => {
        const state = debugChart.__chartsPlusDebug?.getPanCacheState?.();
        return !!state && !state.panActive && !state.active && !state.seriesHidden;
      });

      chart.destroy();
    } finally {
      container.remove();
      restoreContext();
    }
  });
});
