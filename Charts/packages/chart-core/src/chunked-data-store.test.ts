import { describe, expect, it } from 'vitest';

import { ChunkedDataStore } from './chunked-data-store';

const point = (t: number, v: number | null) => ({ t, v });

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const computeStats = (values: number[]) => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let minPositive = Number.POSITIVE_INFINITY;
  let count = 0;
  let gapCount = 0;

  values.forEach((value) => {
    if (!Number.isFinite(value)) {
      gapCount += 1;
      return;
    }
    count += 1;
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (value > 0) minPositive = Math.min(minPositive, value);
  });

  return { min, max, minPositive, count, gapCount };
};

describe('ChunkedDataStore', () => {
  it('rejects out-of-order setData', () => {
    const store = new ChunkedDataStore();
    expect(() =>
      store.setData([
        point(2, 1),
        point(1, 2),
      ]),
    ).toThrow();
  });

  it('drops out-of-order append when configured', () => {
    const store = new ChunkedDataStore({ outOfOrder: 'drop' });
    store.append(point(2, 1));
    store.append(point(1, 2));
    expect(store.length).toBe(1);
  });

  it('appends batches and respects out-of-order policy', () => {
    const store = new ChunkedDataStore({ outOfOrder: 'drop', chunkSize: 2 });
    store.appendBatch([point(1, 1), point(2, 2), point(2, 3), point(3, 4)]);

    expect(store.length).toBe(3);
    expect(store.getTimeAt(2)).toBe(3);
    expect(() => new ChunkedDataStore().appendBatch([point(2, 1), point(1, 2)])).toThrow();
  });

  it('replaces duplicate timestamps when configured', () => {
    const store = new ChunkedDataStore({ duplicates: 'replace' });
    store.appendBatch([point(1, 1), point(1, 4), point(2, 2)]);
    expect(store.length).toBe(2);
    expect(store.getValueAt(0)).toBe(4);
  });

  it('ignores duplicate timestamps when configured', () => {
    const store = new ChunkedDataStore({ duplicates: 'ignore' });
    store.appendBatch([point(1, 1), point(1, 4), point(2, 2)]);
    expect(store.length).toBe(2);
    expect(store.getValueAt(0)).toBe(1);
  });

  it('treats non-finite values as gaps when configured', () => {
    const store = new ChunkedDataStore({ nonFinite: 'gap' });
    store.append(point(1, Number.POSITIVE_INFINITY));
    store.append(point(2, Number.NEGATIVE_INFINITY));
    const chunk = store.getChunk(0);
    expect(Number.isNaN(chunk?.value[0] ?? 0)).toBe(true);
    expect(Number.isNaN(chunk?.value[1] ?? 0)).toBe(true);
    expect(chunk?.stats.gapCount).toBe(2);
  });

  it('patches existing values and recomputes stats', () => {
    const store = new ChunkedDataStore({ chunkSize: 2 });
    store.setData([point(1, 1), point(2, 2), point(3, 3)]);

    const result = store.patchExisting([point(2, null), point(99, 5)]);

    expect(result?.updated).toBe(1);
    const chunk = store.getChunk(0);
    expect(Number.isNaN(chunk?.value[1] ?? 0)).toBe(true);
    expect(chunk?.stats.gapCount).toBe(1);
    expect(chunk?.stats.count).toBe(1);
  });

  it('updates last value and stats', () => {
    const store = new ChunkedDataStore({ chunkSize: 4 });
    store.append(point(1, 1));
    store.append(point(2, 3));
    store.updateLast(point(2, 5));

    const chunk = store.getChunk(0);
    expect(chunk).not.toBeNull();
    expect(chunk?.value[chunk.length - 1]).toBe(5);
    expect(chunk?.stats.max).toBe(5);
    expect(chunk?.stats.min).toBe(1);
  });

  it('supports binary search across chunks', () => {
    const store = new ChunkedDataStore({ chunkSize: 2 });
    store.setData([point(1, 1), point(2, 2), point(3, 3), point(4, 4), point(5, 5)]);

    expect(store.lowerBound(3)).toBe(2);
    expect(store.upperBound(3)).toBe(3);
    expect(store.lowerBound(0)).toBe(0);
    expect(store.upperBound(0)).toBe(0);
    expect(store.lowerBound(6)).toBe(5);
    expect(store.upperBound(6)).toBe(5);
  });

  it('appends data chunks and respects out-of-order drop', () => {
    const store = new ChunkedDataStore({ chunkSize: 2, outOfOrder: 'drop' });
    store.appendChunk({
      time: Float64Array.from([1, 2, 3]),
      value: Float64Array.from([10, 20, 30]),
      length: 3,
    });
    store.appendChunk({
      time: Float64Array.from([2, 4]),
      value: Float64Array.from([22, 40]),
      length: 2,
    });

    expect(store.length).toBe(4);
    expect(store.getTimeAt(0)).toBe(1);
    expect(store.getValueAt(3)).toBe(40);
  });

  it('evicts oldest chunks in ring-buffer mode', () => {
    const store = new ChunkedDataStore({ chunkSize: 2, maxChunks: 2 });
    store.append(point(1, 1));
    store.append(point(2, 2));
    store.append(point(3, 3));
    store.append(point(4, 4));
    store.append(point(5, 5));

    expect(store.length).toBe(3);
    const first = store.getChunk(0);
    expect(first?.time[0]).toBe(3);
    expect(store.lowerBound(3)).toBe(0);
    expect(store.upperBound(5)).toBe(3);
    expect(store.getTimeAt(0)).toBe(3);
    expect(store.getValueAt(2)).toBe(5);
  });

  it('evicts by byte budget and reports evictions', () => {
    const evictedStarts: number[] = [];
    const store = new ChunkedDataStore({
      chunkSize: 2,
      maxBytes: 64,
      onEvict: (chunk) => evictedStarts.push(chunk.startIndex),
    });

    store.append(point(1, 1));
    store.append(point(2, 2));
    store.append(point(3, 3));
    store.append(point(4, 4));
    store.append(point(5, 5));

    expect(store.bytesUsed).toBeLessThanOrEqual(64);
    expect(evictedStarts.length).toBeGreaterThan(0);
    expect(evictedStarts[0]).toBe(0);
  });

  it('retains a visible range with padding', () => {
    const store = new ChunkedDataStore({ chunkSize: 2 });
    store.setData([
      point(1, 1),
      point(2, 2),
      point(3, 3),
      point(4, 4),
      point(5, 5),
      point(6, 6),
      point(7, 7),
      point(8, 8),
    ]);

    const removed = store.evictOutsideRange({ from: 3, to: 6 });
    expect(removed).toBe(2);
    expect(store.length).toBe(4);
    expect(store.lowerBound(3)).toBe(0);
    expect(store.upperBound(6)).toBe(4);
  });

  it('tracks stats with gaps', () => {
    const store = new ChunkedDataStore({ chunkSize: 4 });
    store.setData([point(1, 1), point(2, 3), point(3, null), point(4, 5)]);

    const chunk = store.getChunk(0);
    expect(chunk?.stats.count).toBe(3);
    expect(chunk?.stats.gapCount).toBe(1);
    expect(chunk?.stats.min).toBe(1);
    expect(chunk?.stats.max).toBe(5);
    expect(chunk?.stats.minPositive).toBe(1);
    expect(chunk?.stats.mean).toBe(3);
    expect(chunk?.stats.variance).toBeCloseTo(4, 5);
  });

  it('tracks minPositive across mixed sign data', () => {
    const store = new ChunkedDataStore({ chunkSize: 4 });
    store.setData([point(1, -2), point(2, 0), point(3, 5), point(4, 2)]);

    const chunk = store.getChunk(0);
    expect(chunk?.stats.min).toBe(-2);
    expect(chunk?.stats.max).toBe(5);
    expect(chunk?.stats.minPositive).toBe(2);
  });

  it('increments version on mutation', () => {
    const store = new ChunkedDataStore({ chunkSize: 2 });
    const v0 = store.version;
    store.append(point(1, 1));
    expect(store.version).toBe(v0 + 1);
    store.updateLast(point(1, 2));
    expect(store.version).toBe(v0 + 2);
    store.evictOutsideRange({ from: 1, to: 1 });
    expect(store.version).toBe(v0 + 2);
    store.clear();
    expect(store.version).toBe(v0 + 3);
  });

  it('fuzzes patchExisting with gap stats', () => {
    const rng = mulberry32(0x3f6a1c9b);

    for (let run = 0; run < 12; run += 1) {
      const chunkSize = 8 + Math.floor(rng() * 12);
      const store = new ChunkedDataStore({ chunkSize });
      const count = 80 + Math.floor(rng() * 120);
      const points: Array<{ t: number; v: number | null }> = [];
      let t = Math.floor(rng() * 500);
      for (let i = 0; i < count; i += 1) {
        t += 1 + Math.floor(rng() * 4);
        const v = rng() < 0.15 ? null : Math.round(rng() * 180 - 90);
        points.push({ t, v });
      }
      store.setData(points);

      const times = points.map((entry) => entry.t);
      const expectedValues = points.map((entry) =>
        entry.v === null ? Number.NaN : entry.v,
      );
      let expectedUpdated = 0;
      let expectedMin = Number.POSITIVE_INFINITY;
      let expectedMax = Number.NEGATIVE_INFINITY;
      const touchedChunks = new Set<number>();
      const patches: Array<{ t: number; v: number | null }> = [];

      const patchCount = Math.floor(count * 0.6);
      for (let i = 0; i < patchCount; i += 1) {
        const useExisting = rng() < 0.7;
        if (useExisting) {
          const index = Math.floor(rng() * count);
          const time = times[index]!;
          const v = rng() < 0.2 ? null : Math.round(rng() * 200 - 100);
          patches.push({ t: time, v });
          const nextValue = v === null ? Number.NaN : v;
          if (!Object.is(expectedValues[index]!, nextValue)) {
            expectedValues[index] = nextValue;
            expectedUpdated += 1;
            expectedMin = Math.min(expectedMin, time);
            expectedMax = Math.max(expectedMax, time);
            touchedChunks.add(Math.floor(index / chunkSize));
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
        const expectedChunks = Array.from(touchedChunks).map(
          (chunkIndex) => times[chunkIndex * chunkSize]!,
        );
        const actualChunks = Array.from(result?.chunks ?? []).sort((a, b) => a - b);
        expect(actualChunks).toEqual(expectedChunks.sort((a, b) => a - b));
      }

      const chunkCount = Math.ceil(count / chunkSize);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const chunk = store.getChunk(chunkIndex);
        if (!chunk) continue;
        const start = chunkIndex * chunkSize;
        const end = Math.min(count, start + chunkSize);
        const stats = computeStats(expectedValues.slice(start, end));
        expect(chunk.stats.count).toBe(stats.count);
        expect(chunk.stats.gapCount).toBe(stats.gapCount);
        if (stats.count === 0) {
          expect(Number.isNaN(chunk.stats.min)).toBe(true);
          expect(Number.isNaN(chunk.stats.max)).toBe(true);
          expect(Number.isNaN(chunk.stats.minPositive)).toBe(true);
        } else {
          expect(chunk.stats.min).toBe(stats.min);
          expect(chunk.stats.max).toBe(stats.max);
          if (stats.minPositive === Number.POSITIVE_INFINITY) {
            expect(Number.isNaN(chunk.stats.minPositive)).toBe(true);
          } else {
            expect(chunk.stats.minPositive).toBe(stats.minPositive);
          }
        }
      }
    }
  });
});
