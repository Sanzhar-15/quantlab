import { describe, expect, it } from 'vitest';

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

const isPowerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0;

const findValueAtTime = (level: { time: Float64Array; value: Float64Array; length: number }, t: number) => {
  for (let i = 0; i < level.length; i += 1) {
    if (level.time[i] === t) return level.value[i]!;
  }
  return null;
};

const expectLevelsMatch = (a: LodPyramid, b: LodPyramid) => {
  expect(b.levels.length).toBe(a.levels.length);
  for (let levelIndex = 0; levelIndex < a.levels.length; levelIndex += 1) {
    const left = a.levels[levelIndex]!;
    const right = b.levels[levelIndex]!;
    expect(right.bucketSize).toBe(left.bucketSize);
    expect(right.length).toBe(left.length);
    for (let i = 0; i < left.length; i += 1) {
      const leftTime = left.time[i]!;
      const rightTime = right.time[i]!;
      const leftValue = left.value[i]!;
      const rightValue = right.value[i]!;
      expect(rightTime).toBe(leftTime);
      if (Number.isNaN(leftValue) || Number.isNaN(rightValue)) {
        expect(Number.isNaN(leftValue)).toBe(Number.isNaN(rightValue));
      } else {
        expect(rightValue).toBe(leftValue);
      }
    }
  }
};

describe('LodPyramid', () => {
  it('drops levels to respect maxBytes', () => {
    const length = 256;
    const time = new Float64Array(length);
    const value = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      time[i] = i;
      value[i] = Math.sin(i / 10);
    }

    const pyramid = new LodPyramid({ maxLevels: 4, minPoints: 2, maxBytes: 12_000 });
    pyramid.rebuild(time, value, length);

    expect(pyramid.levels.length).toBeGreaterThan(0);
    expect(pyramid.bytesUsed).toBeLessThanOrEqual(12_000);
    expect(pyramid.levels[0]?.bucketSize).toBeGreaterThan(2);
  });

  it('fuzzes level boundaries and output bounds', () => {
    const rng = mulberry32(0x4c55e1);
    const iterations = 80;

    for (let i = 0; i < iterations; i += 1) {
      const length = Math.floor(rng() * 5000);
      const minPoints = 2 + Math.floor(rng() * 64);
      const maxLevels = 1 + Math.floor(rng() * 8);
      const time = new Float64Array(length);
      const value = new Float64Array(length);
      let t = Math.floor(rng() * 1000);
      for (let j = 0; j < length; j += 1) {
        t += 1 + Math.floor(rng() * 10);
        time[j] = t;
        value[j] = rng() < 0.08 ? Number.NaN : Math.sin(j / 11) * 12;
      }

      const pyramid = new LodPyramid({
        maxLevels,
        minPoints,
        maxBytes: Number.POSITIVE_INFINITY,
      });
      pyramid.rebuild(time, value, length);

      const expectedLevels =
        length < minPoints ? 0 : Math.min(maxLevels, Math.floor(Math.log2(length)));
      expect(pyramid.levels.length).toBe(expectedLevels);

      pyramid.levels.forEach((level, index) => {
        expect(isPowerOfTwo(level.bucketSize)).toBe(true);
        expect(level.bucketSize).toBe(Math.pow(2, index + 1));
        const bucketCount = Math.ceil(length / level.bucketSize);
        const maxPoints = bucketCount * 5;
        expect(level.length).toBeLessThanOrEqual(maxPoints);
      });
    }
  });

  it('patches existing values in-place when output counts are stable', () => {
    const length = 64;
    const time = new Float64Array(length);
    const value = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      time[i] = i;
      value[i] = i;
    }

    const pyramid = new LodPyramid({ maxLevels: 3, minPoints: 2 });
    pyramid.rebuild(time, value, length);
    const level = pyramid.levels[0]!;

    const before = findValueAtTime(level, 10);
    expect(before).toBe(10);

    value[10] = 999;
    pyramid.patchExisting(time, value, length, { from: 10, to: 10 });

    const after = findValueAtTime(pyramid.levels[0]!, 10);
    expect(after).toBe(999);
  });

  it('patches gaps and updates level output', () => {
    const length = 16;
    const time = new Float64Array(length);
    const value = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      time[i] = i;
      value[i] = i + 1;
    }

    const pyramid = new LodPyramid({ maxLevels: 3, minPoints: 2 });
    pyramid.rebuild(time, value, length);
    const level = pyramid.levels[1]!;
    const beforeLength = level.length;

    value[1] = Number.NaN;
    pyramid.patchExisting(time, value, length, { from: 1, to: 1 });

    const patched = pyramid.levels[1]!;
    const valueAt = findValueAtTime(patched, 1);
    expect(Number.isNaN(valueAt ?? 0)).toBe(true);
    expect(patched.length).toBeGreaterThanOrEqual(beforeLength);
  });

  it('appendBatch matches per-point append output', () => {
    const total = 512;
    const baseLength = 128;
    const time = new Float64Array(total);
    const value = new Float64Array(total);
    for (let i = 0; i < total; i += 1) {
      time[i] = i + 1;
      value[i] = Math.sin(i / 7) * 50;
    }

    const pyramidA = new LodPyramid({ maxLevels: 6, minPoints: 2 });
    pyramidA.rebuild(time, value, baseLength);
    for (let i = baseLength; i < total; i += 1) {
      pyramidA.append(time, value, i + 1);
    }

    const pyramidB = new LodPyramid({ maxLevels: 6, minPoints: 2 });
    pyramidB.rebuild(time, value, baseLength);
    pyramidB.appendBatch(time, value, baseLength, total);

    expect(pyramidB.levels.length).toBe(pyramidA.levels.length);
    for (let levelIndex = 0; levelIndex < pyramidA.levels.length; levelIndex += 1) {
      const a = pyramidA.levels[levelIndex]!;
      const b = pyramidB.levels[levelIndex]!;
      expect(b.bucketSize).toBe(a.bucketSize);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i += 1) {
        const timeA = a.time[i]!;
        const timeB = b.time[i]!;
        const valueA = a.value[i]!;
        const valueB = b.value[i]!;
        expect(timeB).toBe(timeA);
        if (Number.isNaN(valueA) || Number.isNaN(valueB)) {
          expect(Number.isNaN(valueA)).toBe(Number.isNaN(valueB));
        } else {
          expect(valueB).toBe(valueA);
        }
      }
    }
  });

  it('updateLast matches rebuild output', () => {
    const length = 256;
    const time = new Float64Array(length);
    const value = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      time[i] = i + 1;
      value[i] = Math.sin(i / 9) * 25;
    }

    const pyramid = new LodPyramid({ maxLevels: 5, minPoints: 2 });
    pyramid.rebuild(time, value, length);
    value[length - 1] = 1234;
    pyramid.updateLast(time, value, length);

    const rebuilt = new LodPyramid({ maxLevels: 5, minPoints: 2 });
    rebuilt.rebuild(time, value, length);

    expectLevelsMatch(pyramid, rebuilt);
  });
});
