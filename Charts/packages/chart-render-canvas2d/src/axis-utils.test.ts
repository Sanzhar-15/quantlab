import { describe, expect, it } from 'vitest';

import { ChunkedDataStore, DataStore } from '@charts-plus/chart-core';

import { applyAxisMargins, applyAxisPadding, computeAxisRange, type AxisScaleSource } from './axis-utils';

const buildSeries = (axis: 'left' | 'right', points: Array<{ t: number; v: number | null }>): AxisScaleSource => {
  const store = new DataStore();
  store.setData(points);
  return {
    axis,
    visible: true,
    data: store,
  };
};

const buildChunkedSeries = (
  axis: 'left' | 'right',
  points: Array<{ t: number; v: number | null }>,
): AxisScaleSource => {
  const store = new ChunkedDataStore({ chunkSize: 2 });
  store.setData(points);
  return {
    axis,
    visible: true,
    data: store,
  };
};

describe('computeAxisRange', () => {
  it('scales each axis from its own visible series', () => {
    const leftSeries = buildSeries('left', [
      { t: 0, v: 10 },
      { t: 1000, v: 12 },
    ]);
    const rightSeries = buildSeries('right', [
      { t: 0, v: 100 },
      { t: 1000, v: 110 },
    ]);

    const range = { from: 0, to: 1000 };
    const left = computeAxisRange([leftSeries, rightSeries], range, 'left');
    const right = computeAxisRange([leftSeries, rightSeries], range, 'right');

    expect(left.min).toBe(10);
    expect(left.max).toBe(12);
    expect(right.min).toBe(100);
    expect(right.max).toBe(110);
  });

  it('reports no data when the axis only has gaps', () => {
    const leftSeries = buildSeries('left', [
      { t: 0, v: 10 },
      { t: 1000, v: 12 },
    ]);
    const rightSeries = buildSeries('right', [
      { t: 0, v: null },
      { t: 1000, v: null },
    ]);

    const range = { from: 0, to: 1000 };
    const right = computeAxisRange([leftSeries, rightSeries], range, 'right');

    expect(right.hasData).toBe(false);
    expect(right.min).toBe(0);
    expect(right.max).toBe(1);
  });

  it('uses chunk stats for chunked stores', () => {
    const chunked = buildChunkedSeries('left', [
      { t: 0, v: -2 },
      { t: 1, v: 5 },
      { t: 2, v: 1 },
      { t: 3, v: 3 },
      { t: 4, v: 10 },
      { t: 5, v: 8 },
    ]);

    const range = { from: 0, to: 5 };
    const left = computeAxisRange([chunked], range, 'left');

    expect(left.min).toBe(-2);
    expect(left.max).toBe(10);
    expect(left.minPositive).toBe(1);
  });

  it('uses lod-only chunks when raw data is missing', () => {
    const source = new ChunkedDataStore({ chunkSize: 4 });
    source.setData([
      { t: 0, v: -2 },
      { t: 1, v: 5 },
      { t: 2, v: 1 },
      { t: 3, v: 4 },
    ]);
    const lodChunk = source.getChunk(0)!;

    const emptyStore = new ChunkedDataStore({ chunkSize: 4 });
    const series: AxisScaleSource = {
      axis: 'left',
      visible: true,
      data: emptyStore,
      lodChunks: [lodChunk],
    };

    const range = { from: 0, to: 3 };
    const left = computeAxisRange([series], range, 'left');

    expect(left.min).toBe(-2);
    expect(left.max).toBe(5);
  });

  it('uses bucket stats for interior ranges on non-chunked stores', () => {
    const store = new DataStore();
    store.setData(
      Array.from({ length: 10 }, (_, index) => ({
        t: index,
        v: index,
      })),
    );
    const buckets = [
      { min: 0, max: 1, minPositive: 1, hasData: true },
      { min: 2, max: 3, minPositive: 2, hasData: true },
      { min: -5, max: 50, minPositive: 2, hasData: true },
      { min: 6, max: 7, minPositive: 6, hasData: true },
      { min: 8, max: 9, minPositive: 8, hasData: true },
    ];
    const series: AxisScaleSource = {
      axis: 'left',
      visible: true,
      data: store,
      bucketSize: 2,
      buckets,
    };

    const range = { from: 0, to: 9 };
    const left = computeAxisRange([series], range, 'left');

    expect(left.min).toBe(-5);
    expect(left.max).toBe(50);
    expect(left.minPositive).toBe(1);
    expect(left.hasData).toBe(true);
  });
});

describe('applyAxisPadding', () => {
  it('pads linear ranges symmetrically', () => {
    const range = { min: 10, max: 20, minPositive: 10, hasData: true };
    const padded = applyAxisPadding(range, 0.1, 'linear');
    expect(padded.min).toBeCloseTo(9, 6);
    expect(padded.max).toBeCloseTo(21, 6);
  });

  it('pads log ranges in log space', () => {
    const range = { min: 10, max: 1000, minPositive: 10, hasData: true };
    const padded = applyAxisPadding(range, 0.1, 'log');
    expect(padded.min).toBeCloseTo(6.31, 2);
    expect(padded.max).toBeCloseTo(1584.9, 1);
    expect(padded.minPositive).toBeLessThan(range.minPositive);
  });

  it('returns unchanged for invalid ratios', () => {
    const range = { min: 1, max: 2, minPositive: 1, hasData: true };
    expect(applyAxisPadding(range, -1, 'linear')).toEqual(range);
    expect(applyAxisPadding(range, Number.NaN, 'linear')).toEqual(range);
  });
});

describe('applyAxisMargins', () => {
  it('expands range based on top/bottom margins', () => {
    const range = { min: 10, max: 20, minPositive: 10, hasData: true };
    const padded = applyAxisMargins(range, { top: 0.2, bottom: 0.1 }, 'linear');
    expect(padded.min).toBeCloseTo(8.5714, 4);
    expect(padded.max).toBeCloseTo(22.8571, 4);
  });

  it('returns unchanged when margins are empty', () => {
    const range = { min: 1, max: 2, minPositive: 1, hasData: true };
    expect(applyAxisMargins(range, { top: 0, bottom: 0 }, 'linear')).toEqual(range);
  });
});
