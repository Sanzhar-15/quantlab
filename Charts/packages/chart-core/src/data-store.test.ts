import { describe, expect, it } from 'vitest';

import { DataStore } from './data-store';

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

describe('DataStore', () => {
  it('stores NaN for null values', () => {
    const store = new DataStore();
    store.setData([
      { t: 1, v: 10 },
      { t: 2, v: null },
    ]);

    const values = store.values();
    expect(Number.isNaN(values[1])).toBe(true);
  });

  it('enforces monotonic time on append', () => {
    const store = new DataStore();
    store.setData([
      { t: 1, v: 10 },
      { t: 2, v: 11 },
    ]);

    expect(() => store.append({ t: 2, v: 12 })).toThrow();
    expect(() => store.append({ t: 1, v: 12 })).toThrow();
  });

  it('appends batches and enforces monotonic time', () => {
    const store = new DataStore();
    store.setData([{ t: 1, v: 10 }]);
    store.appendBatch([
      { t: 2, v: 11 },
      { t: 3, v: null },
    ]);

    expect(store.length).toBe(3);
    expect(Number.isNaN(store.values()[2])).toBe(true);
    expect(() => store.appendBatch([{ t: 3, v: 12 }])).toThrow();
    expect(() =>
      store.appendBatch([
        { t: 4, v: 12 },
        { t: 4, v: 13 },
      ]),
    ).toThrow();
  });

  it('patches existing points only', () => {
    const store = new DataStore();
    store.setData([
      { t: 1, v: 10 },
      { t: 2, v: 20 },
      { t: 3, v: 30 },
    ]);

    const result = store.patchExisting([
      { t: 2, v: 99 },
      { t: 4, v: 40 },
    ]);

    expect(result?.updated).toBe(1);
    expect(store.length).toBe(3);
    expect(store.values()[1]).toBe(99);
  });

  it('updates last or appends when time is equal or greater', () => {
    const store = new DataStore();
    store.setData([
      { t: 1, v: 10 },
      { t: 2, v: 11 },
    ]);

    store.updateLast({ t: 2, v: 99 });
    expect(store.values()[1]).toBe(99);

    store.updateLast({ t: 3, v: 12 });
    expect(store.length).toBe(3);
    expect(store.times()[2]).toBe(3);
  });

  it('replaces duplicate timestamps when configured', () => {
    const store = new DataStore({ duplicates: 'replace' });
    store.append({ t: 1, v: 10 });
    store.append({ t: 1, v: 22 });
    expect(store.length).toBe(1);
    expect(store.values()[0]).toBe(22);
  });

  it('ignores duplicate timestamps when configured', () => {
    const store = new DataStore({ duplicates: 'ignore' });
    store.append({ t: 1, v: 10 });
    store.append({ t: 1, v: 22 });
    expect(store.length).toBe(1);
    expect(store.values()[0]).toBe(10);
  });

  it('treats non-finite values as gaps when configured', () => {
    const store = new DataStore({ nonFinite: 'gap' });
    store.setData([
      { t: 1, v: Number.POSITIVE_INFINITY },
      { t: 2, v: Number.NEGATIVE_INFINITY },
      { t: 3, v: Number.NaN },
    ]);
    const values = store.values();
    expect(Number.isNaN(values[0])).toBe(true);
    expect(Number.isNaN(values[1])).toBe(true);
    expect(Number.isNaN(values[2])).toBe(true);
  });

  it('provides lowerBound/upperBound helpers', () => {
    const store = new DataStore();
    store.setData([
      { t: 1, v: 10 },
      { t: 2, v: 11 },
      { t: 4, v: 12 },
      { t: 7, v: 13 },
    ]);

    expect(store.lowerBound(0)).toBe(0);
    expect(store.lowerBound(3)).toBe(2);
    expect(store.upperBound(4)).toBe(3);
  });

  it('returns typed arrays for time/value', () => {
    const store = new DataStore();
    store.setData([{ t: 1, v: 10 }]);
    expect(store.times() instanceof Float64Array).toBe(true);
    expect(store.values() instanceof Float64Array).toBe(true);
  });

  it('fuzzes ingestion policy with out-of-order, duplicates, and non-finite values', () => {
    const rng = mulberry32(0x2b7d6a41);

    for (let run = 0; run < 18; run += 1) {
      const store = new DataStore({ outOfOrder: 'drop', duplicates: 'replace', nonFinite: 'gap' });
      const points: Array<{ t: number; v: number | null }> = [];
      let t = Math.floor(rng() * 250);

      const count = 120 + Math.floor(rng() * 60);
      for (let i = 0; i < count; i += 1) {
        const drift = rng();
        let delta = Math.floor(rng() * 4);
        if (drift < 0.18) {
          delta = -1 * (1 + Math.floor(rng() * 3));
        } else if (drift < 0.38) {
          delta = 0;
        }
        t += delta;

        const valueRoll = rng();
        let v: number | null;
        if (valueRoll < 0.08) {
          v = null;
        } else if (valueRoll < 0.12) {
          v = Number.POSITIVE_INFINITY;
        } else if (valueRoll < 0.16) {
          v = Number.NaN;
        } else {
          v = Math.round(rng() * 200 - 100);
        }
        points.push({ t, v });
      }

      const expectedTimes: number[] = [];
      const expectedValues: number[] = [];
      let lastTime = Number.NEGATIVE_INFINITY;
      for (const point of points) {
        if (point.t < lastTime) {
          continue;
        }
        const sanitized =
          point.v === null || !Number.isFinite(point.v) ? Number.NaN : point.v;
        if (point.t === lastTime) {
          expectedValues[expectedValues.length - 1] = sanitized;
          continue;
        }
        expectedTimes.push(point.t);
        expectedValues.push(sanitized);
        lastTime = point.t;
      }

      store.setData(points);
      expect(store.length).toBe(expectedTimes.length);
      const times = store.times();
      const values = store.values();
      for (let i = 0; i < expectedTimes.length; i += 1) {
        expect(times[i]).toBe(expectedTimes[i]);
        expect(Object.is(values[i]!, expectedValues[i]!)).toBe(true);
      }
    }
  });

  it('fuzzes patchExisting updates deterministically', () => {
    const rng = mulberry32(0x51f3a7d1);

    for (let run = 0; run < 20; run += 1) {
      const store = new DataStore();
      const count = 60 + Math.floor(rng() * 120);
      const points: Array<{ t: number; v: number | null }> = [];
      let t = Math.floor(rng() * 500);
      for (let i = 0; i < count; i += 1) {
        t += 1 + Math.floor(rng() * 5);
        const v = rng() < 0.12 ? null : Math.round(rng() * 200 - 100);
        points.push({ t, v });
      }
      store.setData(points);

      const times = Array.from(store.times());
      const expected = Array.from(store.values());
      const patches: Array<{ t: number; v: number | null }> = [];
      let expectedUpdated = 0;
      let expectedMin = Number.POSITIVE_INFINITY;
      let expectedMax = Number.NEGATIVE_INFINITY;

      const patchCount = Math.floor(count * 0.7);
      for (let i = 0; i < patchCount; i += 1) {
        const useExisting = rng() < 0.7;
        if (useExisting) {
          const index = Math.floor(rng() * count);
          const time = times[index]!;
          const v = rng() < 0.2 ? null : Math.round(rng() * 200 - 100);
          patches.push({ t: time, v });
          const nextValue = v === null ? Number.NaN : v;
          if (!Object.is(expected[index]!, nextValue)) {
            expectedUpdated += 1;
            expectedMin = Math.min(expectedMin, time);
            expectedMax = Math.max(expectedMax, time);
            expected[index] = nextValue;
          }
        } else {
          const index = Math.floor(rng() * count);
          const time = times[index]! + (rng() < 0.5 ? 0.25 : -0.25);
          const v = rng() < 0.2 ? null : Math.round(rng() * 200 - 100);
          patches.push({ t: time, v });
        }
      }

      const result = store.patchExisting(patches);
      if (expectedUpdated === 0) {
        expect(result).toBeNull();
      } else {
        expect(result?.updated).toBe(expectedUpdated);
        expect(result?.minTime).toBe(expectedMin);
        expect(result?.maxTime).toBe(expectedMax);
      }

      expect(store.length).toBe(count);
      const actualValues = store.values();
      for (let i = 0; i < count; i += 1) {
        expect(Object.is(actualValues[i]!, expected[i]!)).toBe(true);
      }
    }
  });
});
