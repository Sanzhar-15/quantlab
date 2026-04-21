import { describe, expect, it } from 'vitest';

import { ChunkedLineDecimator } from './chunked-line-decimator';
import { CONFLATION_POINTS_PER_PX, resolveConflationPlotWidth } from './decimation-utils';
import { LodPyramid } from './lod-pyramid';

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const buildChunk = (start: number, values: Array<number | null>) => {
  const time = new Float64Array(values.length);
  const value = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    time[i] = start + i;
    const v = values[i];
    value[i] = v === null ? Number.NaN : v;
  }
  return { time, value, length: values.length };
};

describe('ChunkedLineDecimator', () => {
  it('preserves min/max values across chunks', () => {
    const chunkA = buildChunk(0, [1, 5, 3, 2, -1]);
    const chunkB = buildChunk(5, [4, 7, 0, 6, 10]);

    const decimator = new ChunkedLineDecimator();
    const plotWidth = 3;
    const visibleRange = { from: 0, to: 9 };

    const result = decimator.decimate({
      seriesId: 'chunked',
      version: 1,
      visibleRange,
      plotWidth,
      scaleType: 'linear',
      chunks: [chunkA, chunkB],
    });

    const pxPerMs = plotWidth / (visibleRange.to - visibleRange.from);
    const expected = new Map<number, { min: number; max: number }>();
    const points = [...chunkA.value, ...chunkB.value].map((v, i) => ({
      t: i,
      v,
    }));
    points.forEach(({ t, v }) => {
      if (!Number.isFinite(v)) return;
      const col = Math.floor((t - visibleRange.from) * pxPerMs);
      const clamped = col >= plotWidth ? plotWidth - 1 : Math.max(0, col);
      const entry = expected.get(clamped);
      if (entry) {
        entry.min = Math.min(entry.min, v);
        entry.max = Math.max(entry.max, v);
      } else {
        expected.set(clamped, { min: v, max: v });
      }
    });

    const buckets = new Map<number, Set<number>>();
    for (let i = 0; i < result.time.length; i += 1) {
      const t = result.time[i]!;
      const v = result.value[i]!;
      if (!Number.isFinite(v)) continue;
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

  it('emits gaps across chunk boundaries', () => {
    const chunkA = buildChunk(0, [1, null]);
    const chunkB = buildChunk(2, [2, 3]);

    const decimator = new ChunkedLineDecimator();
    const result = decimator.decimate({
      seriesId: 'gap',
      version: 1,
      visibleRange: { from: 0, to: 3 },
      plotWidth: 2,
      scaleType: 'linear',
      chunks: [chunkA, chunkB],
    });

    expect(result.value.some((v) => Number.isNaN(v))).toBe(true);
    expect(result.value.some((v) => Number.isFinite(v))).toBe(true);
  });

  it('bounds output size by plot width', () => {
    const chunks = [] as Array<{ time: Float64Array; value: Float64Array; length: number }>;
    for (let c = 0; c < 4; c += 1) {
      const values = new Array<number>(1000).fill(0).map((_, i) => Math.sin((i + c) / 12));
      chunks.push(buildChunk(c * 1000, values));
    }

    const decimator = new ChunkedLineDecimator();
    const plotWidth = 200;
    const result = decimator.decimate({
      seriesId: 'bound',
      version: 2,
      visibleRange: { from: 0, to: 3999 },
      plotWidth,
      scaleType: 'linear',
      chunks,
    });

    const maxPoints = plotWidth * 5;
    expect(result.time.length).toBe(result.value.length);
    expect(result.time.length).toBeLessThanOrEqual(maxPoints);
  });

  it('uses LOD levels when available', () => {
    const values = new Array<number>(512).fill(0).map((_, i) => Math.sin(i / 7));
    const chunk = buildChunk(0, values);
    const lod = new LodPyramid({ maxLevels: 4, minPoints: 16 });
    lod.rebuild(chunk.time, chunk.value, chunk.length);

    const decimator = new ChunkedLineDecimator();
    const result = decimator.decimate({
      seriesId: 'lod',
      version: 3,
      visibleRange: { from: 0, to: 511 },
      plotWidth: 40,
      scaleType: 'linear',
      chunks: [{ ...chunk, lod }],
    });

    expect(result.time.length).toBeGreaterThan(0);
    expect(result.time.length).toBeLessThan(chunk.length);
  });

  it('conflates at deep zoom across chunks', () => {
    const plotWidth = 120;
    const length = plotWidth * CONFLATION_POINTS_PER_PX * 4;
    const chunkSize = Math.floor(length / 2);
    const rng = mulberry32(0x1234abcd);
    const valuesA = new Array<number | null>(chunkSize);
    const valuesB = new Array<number | null>(length - chunkSize);
    for (let i = 0; i < valuesA.length; i += 1) {
      valuesA[i] = (rng() * 2 - 1) * 25 + Math.sin(i / 9) * 5;
    }
    for (let i = 0; i < valuesB.length; i += 1) {
      valuesB[i] = (rng() * 2 - 1) * 25 + Math.cos(i / 7) * 6;
    }
    valuesA[40] = null;
    valuesA[41] = null;

    const chunkA = buildChunk(0, valuesA);
    const chunkB = buildChunk(chunkSize, valuesB);
    const visibleRange = { from: 0, to: length - 1 };

    const effectiveWidth = resolveConflationPlotWidth(plotWidth, length);
    expect(effectiveWidth).toBeLessThan(plotWidth);

    const decimator = new ChunkedLineDecimator();
    const result = decimator.decimate({
      seriesId: 'conflation',
      version: 1,
      visibleRange,
      plotWidth,
      scaleType: 'linear',
      chunks: [chunkA, chunkB],
    });

    expect(result.time.length).toBeLessThanOrEqual(effectiveWidth * 5);
    expect(result.value.some((v) => Number.isNaN(v))).toBe(true);
  });
});
