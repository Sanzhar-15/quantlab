import { describe, expect, it } from 'vitest';

import { CONFLATION_POINTS_PER_PX, resolveConflationPlotWidth } from './decimation-utils';
import { LineDecimator } from './line-decimator';

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

describe('LineDecimator', () => {
  it('preserves min/max values per pixel column', () => {
    const time = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const value = Float64Array.from([1, 5, 3, 2, -1, 4, 7, 0, 6, 10]);
    const decimator = new LineDecimator();
    const plotWidth = 3;
    const visibleRange = { from: 0, to: 9 };
    const result = decimator.decimate({
      seriesId: 's1',
      visibleRange,
      visibleIndices: { from: 0, to: time.length },
      time,
      value,
      plotWidth,
      scaleType: 'linear',
    });

    const pxPerMs = plotWidth / (visibleRange.to - visibleRange.from);
    const expected = new Map<number, { min: number; max: number }>();
    for (let i = 0; i < time.length; i += 1) {
      const col = Math.floor((time[i]! - visibleRange.from) * pxPerMs);
      const clamped = col >= plotWidth ? plotWidth - 1 : Math.max(0, col);
      const v = value[i]!;
      const entry = expected.get(clamped);
      if (entry) {
        entry.min = Math.min(entry.min, v);
        entry.max = Math.max(entry.max, v);
      } else {
        expected.set(clamped, { min: v, max: v });
      }
    }

    const buckets = new Map<number, Set<number>>();
    for (let i = 0; i < result.time.length; i += 1) {
      const t = result.time[i]!;
      const v = result.value[i]!;
      if (Number.isNaN(v)) continue;
      const col = Math.floor((t - visibleRange.from) * pxPerMs);
      const clamped = col >= plotWidth ? plotWidth - 1 : Math.max(0, col);
      const set = buckets.get(clamped) ?? new Set<number>();
      set.add(v);
      buckets.set(clamped, set);
    }

    expected.forEach((range, col) => {
      const values = buckets.get(col);
      expect(values?.has(range.min)).toBe(true);
      expect(values?.has(range.max)).toBe(true);
    });
  });

  it('inserts gap markers for NaN sequences', () => {
    const time = Float64Array.from([0, 1, 2, 3]);
    const value = Float64Array.from([1, Number.NaN, 2, 3]);
    const decimator = new LineDecimator();
    const result = decimator.decimate({
      seriesId: 'gap-seq',
      visibleRange: { from: 0, to: 3 },
      visibleIndices: { from: 0, to: time.length },
      time,
      value,
      plotWidth: 1,
      scaleType: 'linear',
    });

    const gapIndex = result.value.findIndex((v) => Number.isNaN(v));
    expect(gapIndex).toBeGreaterThanOrEqual(0);
    expect(result.time[gapIndex]).toBe(2);
    expect(Number.isFinite(result.value[0]!)).toBe(true);
    expect(Number.isFinite(result.value[result.value.length - 1]!)).toBe(true);
  });

  it('emits a NaN when a bucket contains only gaps', () => {
    const time = Float64Array.from([0, 1, 2]);
    const value = Float64Array.from([Number.NaN, Number.NaN, Number.NaN]);
    const decimator = new LineDecimator();
    const result = decimator.decimate({
      seriesId: 'gap-only',
      visibleRange: { from: 0, to: 2 },
      visibleIndices: { from: 0, to: time.length },
      time,
      value,
      plotWidth: 1,
      scaleType: 'linear',
    });

    expect(result.value.length).toBe(1);
    expect(Number.isNaN(result.value[0]!)).toBe(true);
    expect(result.time[0]).toBe(0);
  });

  it('fuzzes gap insertion when a NaN run splits finite values', () => {
    const rng = mulberry32(0x9e3779b9);
    const decimator = new LineDecimator();
    const iterations = 80;

    for (let i = 0; i < iterations; i += 1) {
      const length = 6 + Math.floor(rng() * 20);
      const time = new Float64Array(length);
      const value = new Float64Array(length);
      for (let j = 0; j < length; j += 1) {
        time[j] = j;
        value[j] = Math.sin(j / 5) * 10 + 100;
      }

      const gapStart = 1 + Math.floor(rng() * (length - 3));
      const gapLength = 1 + Math.floor(rng() * Math.min(4, length - gapStart - 1));
      for (let j = 0; j < gapLength; j += 1) {
        value[gapStart + j] = Number.NaN;
      }

      const result = decimator.decimate({
        seriesId: `gap-fuzz-${i}`,
        visibleRange: { from: 0, to: length - 1 },
        visibleIndices: { from: 0, to: length },
        time,
        value,
        plotWidth: 1,
        scaleType: 'linear',
      });

      const hasGap = Array.from(result.value).some((v) => Number.isNaN(v));
      expect(hasGap).toBe(true);
    }
  });

  it('bounds output size by plot width', () => {
    const length = 5000;
    const time = new Float64Array(length);
    const value = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      time[i] = i;
      value[i] = i % 37 === 0 ? Number.NaN : Math.sin(i / 12) * 20;
    }

    const decimator = new LineDecimator();
    const visibleRange = { from: 0, to: length - 1 };
    const widths = [1, 2, 12, 64, 200, 400];

    widths.forEach((plotWidth) => {
      const result = decimator.decimate({
        seriesId: `bound-${plotWidth}`,
        visibleRange,
        visibleIndices: { from: 0, to: length },
        time,
        value,
        plotWidth,
        scaleType: 'linear',
      });

      const maxPoints = Math.max(0, Math.round(plotWidth)) * 5;
      expect(result.time.length).toBe(result.value.length);
      expect(result.time.length).toBeLessThanOrEqual(maxPoints);
    });
  });

  it('conflates at deep zoom when density is high', () => {
    const buildSeries = (length: number, seed: number) => {
      const rng = mulberry32(seed);
      const time = new Float64Array(length);
      const value = new Float64Array(length);
      for (let i = 0; i < length; i += 1) {
        time[i] = i;
        value[i] = (rng() * 2 - 1) * 50 + Math.sin(i / 11) * 7;
      }
      return { time, value };
    };

    const plotWidth = 100;
    const normalLength = plotWidth * Math.max(1, CONFLATION_POINTS_PER_PX - 2);
    const denseLength = plotWidth * CONFLATION_POINTS_PER_PX * 5;
    const visibleRangeNormal = { from: 0, to: normalLength - 1 };
    const visibleRangeDense = { from: 0, to: denseLength - 1 };

    const decimator = new LineDecimator();
    const normal = buildSeries(normalLength, 11);
    const dense = buildSeries(denseLength, 19);

    const normalWidth = resolveConflationPlotWidth(plotWidth, normalLength);
    const denseWidth = resolveConflationPlotWidth(plotWidth, denseLength);
    expect(normalWidth).toBe(plotWidth);
    expect(denseWidth).toBeLessThan(plotWidth);

    const normalResult = decimator.decimate({
      seriesId: 'normal-density',
      visibleRange: visibleRangeNormal,
      visibleIndices: { from: 0, to: normal.time.length },
      time: normal.time,
      value: normal.value,
      plotWidth,
      scaleType: 'linear',
    });
    const denseResult = decimator.decimate({
      seriesId: 'dense-density',
      visibleRange: visibleRangeDense,
      visibleIndices: { from: 0, to: dense.time.length },
      time: dense.time,
      value: dense.value,
      plotWidth,
      scaleType: 'linear',
    });

    expect(normalResult.time.length).toBeLessThanOrEqual(normalWidth * 5);
    expect(denseResult.time.length).toBeLessThanOrEqual(denseWidth * 5);
    expect(denseResult.time.length).toBeLessThan(normalResult.time.length);
  });

  it('preserves gap markers under conflation', () => {
    const plotWidth = 120;
    const length = plotWidth * CONFLATION_POINTS_PER_PX * 4;
    const time = new Float64Array(length);
    const value = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      time[i] = i;
      value[i] = Math.cos(i / 5) * 10 + 100;
    }
    for (let i = 200; i < 240; i += 1) {
      value[i] = Number.NaN;
    }

    const decimator = new LineDecimator();
    const result = decimator.decimate({
      seriesId: 'gap-conflation',
      visibleRange: { from: 0, to: length - 1 },
      visibleIndices: { from: 0, to: length },
      time,
      value,
      plotWidth,
      scaleType: 'linear',
    });

    expect(Array.from(result.value).some((v) => Number.isNaN(v))).toBe(true);
  });

  it('caches results by key and evicts old entries', () => {
    const time = Float64Array.from([0, 1, 2, 3]);
    const value = Float64Array.from([1, 2, 3, 4]);
    const visibleRange = { from: 0, to: 3 };
    const baseInput = {
      seriesId: 's-cache',
      visibleRange,
      visibleIndices: { from: 0, to: time.length },
      time,
      value,
      scaleType: 'linear' as const,
    };

    const decimator = new LineDecimator({ maxEntries: 2 });
    const first = decimator.decimate({ ...baseInput, plotWidth: 2 });
    const second = decimator.decimate({ ...baseInput, plotWidth: 2 });
    expect(second).toBe(first);

    decimator.decimate({ ...baseInput, plotWidth: 3 });
    decimator.decimate({ ...baseInput, plotWidth: 4 });

    const refreshed = decimator.decimate({ ...baseInput, plotWidth: 2 });
    expect(refreshed).not.toBe(first);
  });

  it('evicts cache entries when maxBytes is exceeded', () => {
    const length = 1200;
    const time = new Float64Array(length);
    const value = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      time[i] = i;
      value[i] = Math.sin(i / 10);
    }
    const visibleRange = { from: 0, to: length - 1 };
    const baseInput = {
      seriesId: 's-bytes',
      visibleRange,
      visibleIndices: { from: 0, to: time.length },
      time,
      value,
      scaleType: 'linear' as const,
    };

    const temp = new LineDecimator({ maxEntries: 8 });
    const sampleA = temp.decimate({ ...baseInput, plotWidth: 120 });
    const sampleB = temp.decimate({ ...baseInput, plotWidth: 140 });
    const bytesA = sampleA.time.byteLength + sampleA.value.byteLength;
    const bytesB = sampleB.time.byteLength + sampleB.value.byteLength;
    const maxBytes = bytesA + Math.max(1, Math.floor(bytesB / 2));

    const decimator = new LineDecimator({ maxEntries: 8, maxBytes });
    const first = decimator.decimate({ ...baseInput, plotWidth: 120 });
    decimator.decimate({ ...baseInput, plotWidth: 140 });
    const refreshed = decimator.decimate({ ...baseInput, plotWidth: 120 });

    expect(refreshed).not.toBe(first);
  });
});
