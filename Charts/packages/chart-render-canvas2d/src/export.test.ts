// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

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
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = () => createStubContext();
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
};

const stubCanvasOutput = () => {
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toDataURL = function toDataURLStub() {
    return `data:${this.width}x${this.height}`;
  };
  HTMLCanvasElement.prototype.toBlob = function toBlobStub(
    callback: BlobCallback,
  ) {
    callback(null);
  };
  return () => {
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
  };
};

const setDevicePixelRatio = (value: number) => {
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  Object.defineProperty(window, 'devicePixelRatio', {
    value,
    configurable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(window, 'devicePixelRatio', original);
    } else {
      delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    }
  };
};

const ensureRaf = () => {
  const original = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  if (typeof original === 'function') return () => {};
  let handle = 0;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    handle += 1;
    setTimeout(() => cb(Date.now()), 0);
    return handle;
  };
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    if (original) {
      globalThis.requestAnimationFrame = original;
    } else {
      delete (globalThis as { requestAnimationFrame?: FrameRequestCallback }).requestAnimationFrame;
    }
    if (originalCancel) {
      globalThis.cancelAnimationFrame = originalCancel;
    } else {
      delete (globalThis as { cancelAnimationFrame?: (handle: number) => void })
        .cancelAnimationFrame;
    }
  };
};

const createContainer = (width = 320, height = 200) => {
  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  return container;
};

describe('deterministic export', () => {
  it('ignores devicePixelRatio when deterministic', async () => {
    const restoreContext = stubCanvasContext();
    const restoreOutput = stubCanvasOutput();
    const restoreRaf = ensureRaf();
    const container = createContainer(320, 200);

    try {
      const chart = createChart(container, { width: 320, height: 200 });
      const series = chart.addLineSeries({ id: 'Series' });
      const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
      const t1 = Date.UTC(2024, 0, 1, 1, 0, 0);
      series.setData([
        { t: t0, v: 10 },
        { t: t1, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: t0, to: t1 });

      const restoreDprHigh = setDevicePixelRatio(2);
      const first = await chart.exportPng({ deterministic: true });
      restoreDprHigh();
      const restoreDprLow = setDevicePixelRatio(1);
      const second = await chart.exportPng({ deterministic: true });
      restoreDprLow();

      expect(first).toBe('data:320x200');
      expect(second).toBe('data:320x200');
    } finally {
      container.remove();
      restoreRaf();
      restoreOutput();
      restoreContext();
    }
  });

  it('uses export locale and timezone for deterministic formatter', async () => {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return;
    const restoreContext = stubCanvasContext();
    const restoreOutput = stubCanvasOutput();
    const restoreRaf = ensureRaf();
    const container = createContainer(320, 200);
    const originalFormatter = Intl.DateTimeFormat;
    const calls: Array<{ locale: string | string[] | undefined; timeZone?: string }> = [];
    const stubFormatter = function (
      locale?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      calls.push({ locale, timeZone: options?.timeZone });
      return {
        format: () => '00:00:00',
        resolvedOptions: () => ({ locale: 'en-US', timeZone: options?.timeZone }),
      } as Intl.DateTimeFormat;
    };

    try {
      Intl.DateTimeFormat = stubFormatter as unknown as typeof Intl.DateTimeFormat;
      const chart = createChart(container, { width: 320, height: 200 });
      const series = chart.addLineSeries({ id: 'Series' });
      const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
      const t1 = Date.UTC(2024, 0, 1, 1, 0, 0);
      series.setData([
        { t: t0, v: 10 },
        { t: t1, v: 12 },
      ]);
      chart.setVisibleTimeRange({ from: t0, to: t1 });

      await chart.exportPng({ deterministic: true, locale: 'fr-FR', timeZone: 'utc' });
      await chart.exportPng({ deterministic: true, locale: 'en-GB', timeZone: 'local' });

      const utcCall = calls.find((entry) => entry.locale === 'fr-FR');
      const localCall = calls.find((entry) => entry.locale === 'en-GB');
      expect(utcCall?.timeZone).toBe('UTC');
      expect(localCall?.timeZone).toBeUndefined();
    } finally {
      Intl.DateTimeFormat = originalFormatter;
      container.remove();
      restoreRaf();
      restoreOutput();
      restoreContext();
    }
  });
});
