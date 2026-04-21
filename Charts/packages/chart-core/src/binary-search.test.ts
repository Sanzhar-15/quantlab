import { describe, expect, it } from 'vitest';

import { lowerBound, upperBound } from './binary-search';

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const linearLowerBound = (values: number[], length: number, target: number): number => {
  for (let i = 0; i < length; i += 1) {
    if (values[i]! >= target) return i;
  }
  return length;
};

const linearUpperBound = (values: number[], length: number, target: number): number => {
  for (let i = 0; i < length; i += 1) {
    if (values[i]! > target) return i;
  }
  return length;
};

describe('binary-search', () => {
  it('handles empty arrays', () => {
    const values: number[] = [];
    expect(lowerBound(values, 0, 10)).toBe(0);
    expect(upperBound(values, 0, 10)).toBe(0);
  });

  it('fuzzes lowerBound/upperBound', () => {
    const rng = mulberry32(0xdecafbad);
    for (let i = 0; i < 200; i += 1) {
      const length = Math.floor(rng() * 64);
      const values: number[] = [];
      let current = Math.floor(rng() * 5);
      for (let j = 0; j < length; j += 1) {
        current += Math.floor(rng() * 4);
        values.push(current);
      }

      const target = current + Math.floor((rng() - 0.5) * 20);
      const lb = lowerBound(values, values.length, target);
      const ub = upperBound(values, values.length, target);

      expect(lb).toBe(linearLowerBound(values, values.length, target));
      expect(ub).toBe(linearUpperBound(values, values.length, target));
      expect(lb).toBeLessThanOrEqual(ub);
    }
  });
});
