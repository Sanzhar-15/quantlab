import { describe, expect, it } from 'vitest';

import { OhlcLodPyramid } from './ohlc-lod-pyramid';

describe('OhlcLodPyramid', () => {
  it('aggregates OHLC buckets on rebuild', () => {
    const time = new Float64Array([1, 2, 3, 4]);
    const open = new Float64Array([10, 11, 12, 13]);
    const high = new Float64Array([12, 13, 14, 15]);
    const low = new Float64Array([9, 10, 11, 12]);
    const close = new Float64Array([11, 12, 13, 14]);

    const pyramid = new OhlcLodPyramid({ maxLevels: 2, minPoints: 2 });
    pyramid.rebuild(time, open, high, low, close, time.length);

    const level0 = pyramid.levels[0]!;
    expect(level0.bucketSize).toBe(2);
    expect(level0.length).toBe(2);
    expect(level0.time[0]).toBe(1);
    expect(level0.open[0]).toBe(10);
    expect(level0.high[0]).toBe(13);
    expect(level0.low[0]).toBe(9);
    expect(level0.close[0]).toBe(12);
    expect(level0.time[1]).toBe(3);
    expect(level0.open[1]).toBe(12);
    expect(level0.high[1]).toBe(15);
    expect(level0.low[1]).toBe(11);
    expect(level0.close[1]).toBe(14);

    const level1 = pyramid.levels[1]!;
    expect(level1.bucketSize).toBe(4);
    expect(level1.length).toBe(1);
    expect(level1.time[0]).toBe(1);
    expect(level1.open[0]).toBe(10);
    expect(level1.high[0]).toBe(15);
    expect(level1.low[0]).toBe(9);
    expect(level1.close[0]).toBe(14);
  });

  it('updates the trailing bucket on append', () => {
    const time = new Float64Array([1, 2, 3, 4]);
    const open = new Float64Array([10, 11, 12, 13]);
    const high = new Float64Array([12, 13, 14, 16]);
    const low = new Float64Array([9, 10, 11, 12]);
    const close = new Float64Array([11, 12, 13, 15]);

    const pyramid = new OhlcLodPyramid({ maxLevels: 2, minPoints: 2 });
    pyramid.rebuild(time, open, high, low, close, 3);

    pyramid.append(time, open, high, low, close, 4);

    const level0 = pyramid.levels[0]!;
    expect(level0.length).toBe(2);
    expect(level0.open[1]).toBe(12);
    expect(level0.high[1]).toBe(16);
    expect(level0.low[1]).toBe(11);
    expect(level0.close[1]).toBe(15);
  });
});
