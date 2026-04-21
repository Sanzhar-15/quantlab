// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { PriceScale } from '@charts-plus/chart-core';

import { renderHistogramSeries } from './histogram-series-renderer';

const createStubContext = (fills: Array<{ color: string }>) => {
  const ctx = {
    canvas: document.createElement('canvas'),
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    fillRect: (_x: number, _y: number, _w: number, _h: number) => {
      fills.push({ color: ctx.fillStyle as string });
    },
    fillStyle: '',
    globalAlpha: 1,
  };
  return ctx as unknown as CanvasRenderingContext2D;
};

const createSnapSurface = () => ({
  snapX: (x: number) => x,
  snapY: (y: number) => y,
  alignLineWidth: (width: number) => width,
});

describe('renderHistogramSeries', () => {
  it('applies per-point color overrides', () => {
    const fills: Array<{ color: string }> = [];
    const ctx = createStubContext(fills);
    const priceScale = new PriceScale();
    priceScale.setHeight(100);
    priceScale.setRange(0, 10);

    renderHistogramSeries({
      ctx,
      surface: createSnapSurface(),
      plotRect: { x: 0, y: 0, width: 100, height: 100 },
      visibleRange: { from: 0, to: 2 },
      time: new Float64Array([0, 1, 2]),
      value: new Float64Array([2, 4, 3]),
      priceScale,
      options: {},
      defaultColor: '#888888',
      baseValue: 0,
      barWidth: 12,
      dpr: 1,
      colorResolver: (time, _index) => (time === 1 ? '#ff9900' : null),
    });

    expect(fills).toHaveLength(3);
    expect(fills[0]?.color).toBe('#888888');
    expect(fills[1]?.color).toBe('#ff9900');
    expect(fills[2]?.color).toBe('#888888');
  });
});
