import { describe, expect, it } from 'vitest';

import { DataStore } from './data-store';
import { TimeScale } from './time-scale';

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

describe('TimeScale', () => {
  it('round-trips timeToX and xToTime', () => {
    const store = new DataStore();
    store.setData([
      { t: 1000, v: 1 },
      { t: 2000, v: 2 },
      { t: 3000, v: 3 },
    ]);
    const scale = new TimeScale(store, { from: 1000, to: 3000 });
    scale.setPlotWidth(100);

    const x = scale.timeToX(1500);
    const t = scale.xToTime(x);
    expect(Math.abs(t - 1500)).toBeLessThan(1e-6);
  });

  it('computes visible indices via binary search', () => {
    const store = new DataStore();
    store.setData([
      { t: 1000, v: 1 },
      { t: 2000, v: 2 },
      { t: 3000, v: 3 },
      { t: 4000, v: 4 },
    ]);
    const scale = new TimeScale(store, { from: 1500, to: 3500 });
    const range = scale.getVisibleIndices();
    expect(range.from).toBe(1);
    expect(range.to).toBe(3);
  });

  it('clamps zoom range to min/max', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 100000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 0, to: 100000 }, { minRangeMs: 1000 });
    scale.setPlotWidth(100);
    scale.zoomByWheel(-10000, 50);
    const range = scale.getVisibleRange();
    expect(range.to - range.from).toBeGreaterThanOrEqual(1000);
  });

  it('prevents zooming out past data bounds when clamped', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 200, to: 400 }, { clampToData: true });
    scale.setPlotWidth(100);

    scale.zoomByWheel(20000, 50);
    const range = scale.getVisibleRange();
    const epsilon = 1e-6;
    expect(range.from).toBeGreaterThanOrEqual(0 - epsilon);
    expect(range.to).toBeLessThanOrEqual(1000 + epsilon);
    expect(range.to - range.from).toBeLessThanOrEqual(1000 + epsilon);
  });

  it('allows right overscroll when fixRightEdge is false', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 200, to: 600 }, {
      clampToData: true,
      fixLeftEdge: true,
      fixRightEdge: false,
    });
    scale.setPlotWidth(100);

    scale.panByPixels(-200);
    const range = scale.getVisibleRange();
    expect(range.to).toBeGreaterThan(1000);
    expect(range.from).toBeGreaterThanOrEqual(0);
  });

  it('allows left overscroll when fixLeftEdge is false', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 400, to: 800 }, {
      clampToData: true,
      fixLeftEdge: false,
      fixRightEdge: true,
    });
    scale.setPlotWidth(100);

    scale.panByPixels(200);
    const range = scale.getVisibleRange();
    expect(range.from).toBeLessThan(0);
    expect(range.to).toBeLessThanOrEqual(1000);
  });

  it('allows elastic overscroll while active', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 200, to: 400 }, { clampToData: true, elasticClamp: true, elasticMaxRatio: 0.1 });
    scale.setPlotWidth(100);
    scale.setElasticActive(true);

    scale.zoomByWheel(20000, 50);
    const range = scale.getVisibleRange();
    const epsilon = 1e-6;
    const limit = 1000 * 0.1;
    expect(range.from).toBeGreaterThanOrEqual(-limit - epsilon);
    expect(range.to).toBeLessThanOrEqual(1000 + limit + epsilon);
    expect(range.from).toBeLessThan(0);
    expect(range.to).toBeGreaterThan(1000);
  });

  it('keeps span while elastic panning at bounds', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 200, to: 400 }, { clampToData: true, elasticClamp: true, elasticMaxRatio: 0.1 });
    scale.setPlotWidth(100);
    scale.setElasticActive(true);

    const before = scale.getVisibleRange();
    scale.panByPixels(1000);
    const after = scale.getVisibleRange();
    expect(after.from).toBeLessThan(0);
    expect(after.to - after.from).toBeCloseTo(before.to - before.from, 6);
  });

  it('pans by pixel delta', () => {
    const store = new DataStore();
    store.setData([
      { t: 1000, v: 1 },
      { t: 2000, v: 2 },
      { t: 3000, v: 3 },
    ]);
    const scale = new TimeScale(store, { from: 1000, to: 3000 }, { clampToData: false });
    scale.setPlotWidth(100);
    scale.panByPixels(50);
    const range = scale.getVisibleRange();
    expect(Math.round(range.from)).toBe(0);
    expect(Math.round(range.to)).toBe(2000);
  });

  it('zooms by scale around anchor', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 1000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 0, to: 1000 }, { clampToData: false });
    scale.setPlotWidth(100);

    const before = scale.getVisibleRange();
    scale.zoomByScale(2, 50);
    const after = scale.getVisibleRange();

    expect(after.to - after.from).toBeLessThan(before.to - before.from);
  });

  it('generates stable tick steps for small range changes', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 1 },
      { t: 4 * 60 * 60 * 1000, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: 0, to: 4 * 60 * 60 * 1000 }, { clampToData: false });
    const ticksA = scale.getTicks(6);
    const stepA = ticksA[1]! - ticksA[0]!;

    scale.setVisibleRange({ from: 0, to: 4 * 60 * 60 * 1000 + 60_000 });
    const ticksB = scale.getTicks(6);
    const stepB = ticksB[1]! - ticksB[0]!;

    expect(stepA).toBe(stepB);
  });

  it('aligns month ticks to calendar boundaries', () => {
    const start = Date.UTC(2023, 0, 15, 12, 0, 0);
    const end = Date.UTC(2023, 6, 20, 12, 0, 0);
    const store = new DataStore();
    store.setData([
      { t: start, v: 1 },
      { t: end, v: 2 },
    ]);
    const scale = new TimeScale(store, { from: start, to: end }, { clampToData: false });
    const ticks = scale.getTicks(6);
    const inRange = ticks.filter((time) => time >= start && time <= end);

    for (const time of inRange) {
      const date = new Date(time);
      expect(date.getUTCDate()).toBe(1);
      expect(date.getUTCHours()).toBe(0);
      expect(date.getUTCMinutes()).toBe(0);
      expect(date.getUTCSeconds()).toBe(0);
    }
  });

  it('fuzzes timeToX/xToTime round-trips', () => {
    const rng = mulberry32(0x1a2b3c4d);
    const iterations = 200;
    const samplesPerIteration = 8;
    const epsilon = 1e-6;

    for (let i = 0; i < iterations; i += 1) {
      const length = 2 + Math.floor(rng() * 40);
      const points: Array<{ t: number; v: number }> = [];
      let time = Math.floor(rng() * 10_000) - 5_000;
      for (let j = 0; j < length; j += 1) {
        time += 1 + Math.floor(rng() * 200);
        points.push({ t: time, v: Math.sin(j / 3) * 10 });
      }

      const store = new DataStore();
      store.setData(points);

      const left = Math.floor(rng() * (length - 1));
      const right = left + 1 + Math.floor(rng() * (length - left - 1));
      const from = points[left]!.t;
      const to = points[right]!.t;

      const scale = new TimeScale(store, { from, to }, { clampToData: false });
      const width = 20 + Math.floor(rng() * 900);
      scale.setPlotWidth(width);

      for (let j = 0; j < samplesPerIteration; j += 1) {
        const t = from + rng() * (to - from);
        const x = scale.timeToX(t);
        const roundTrip = scale.xToTime(x);
        if (Math.abs(roundTrip - t) > epsilon) {
          throw new Error(
            `Round-trip time mismatch (iter=${i}, t=${t}, x=${x}, out=${roundTrip})`,
          );
        }
      }

      for (let j = 0; j < samplesPerIteration; j += 1) {
        const rawX = (rng() - 0.25) * width * 1.5;
        const t = scale.xToTime(rawX);
        const roundTrip = scale.timeToX(t);
        const clamped = Math.max(0, Math.min(width, rawX));
        if (Math.abs(roundTrip - clamped) > epsilon) {
          throw new Error(
            `Round-trip x mismatch (iter=${i}, x=${rawX}, t=${t}, out=${roundTrip})`,
          );
        }
      }
    }
  });

  it('keeps visible range inside data bounds when clamped', () => {
    const rng = mulberry32(0x5e1e7b1d);
    const length = 120;
    const points: Array<{ t: number; v: number }> = [];
    let time = 1_700_000_000_000;
    for (let i = 0; i < length; i += 1) {
      time += 60_000 + Math.floor(rng() * 4_000);
      points.push({ t: time, v: Math.sin(i / 5) * 12 });
    }

    const store = new DataStore();
    store.setData(points);

    const padding = 120_000;
    const minTime = points[0]!.t;
    const maxTime = points[points.length - 1]!.t;
    const scale = new TimeScale(store, { from: minTime, to: maxTime }, {
      clampToData: true,
      paddingMs: padding,
      minRangeMs: 5_000,
      maxRangeMs: maxTime - minTime + padding * 2,
    });
    scale.setPlotWidth(800);

    for (let i = 0; i < 120; i += 1) {
      if (rng() > 0.5) {
        const delta = (rng() - 0.5) * 1200;
        scale.panByPixels(delta);
      } else {
        const delta = (rng() - 0.5) * 800;
        const anchor = rng() * 800;
        scale.zoomByWheel(delta, anchor);
      }

      const range = scale.getVisibleRange();
      if (range.from < minTime - padding - 1e-6 || range.to > maxTime + padding + 1e-6) {
        throw new Error(
          `Range escaped data bounds (from=${range.from}, to=${range.to})`,
        );
      }
    }
  });
});
