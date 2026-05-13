import { describe, expect, it } from 'vitest';

import { OhlcDataStore } from './ohlc-data-store';

const ohlc = (t: number, v = 1): { t: number; o: number; h: number; l: number; c: number } => ({
  t, o: v, h: v + 0.1, l: v - 0.1, c: v,
});

describe('OhlcDataStore — Front 5 enriched monotonicity diagnostics', () => {

  it('setData: out-of-order error includes row indices', () => {
    const store = new OhlcDataStore({ outOfOrder: 'error' });
    expect(() => store.setData([
      ohlc(100, 1), ohlc(200, 2), ohlc(150, 3),
    ])).toThrow(/row 2 has timestamp 150 < row 1 timestamp 200/);
  });

  it('setData: duplicate error includes row indices', () => {
    const store = new OhlcDataStore({ duplicates: 'error' });
    expect(() => store.setData([
      ohlc(100, 1), ohlc(200, 2), ohlc(200, 3),
    ])).toThrow(/rows 1 and 2 share timestamp 200/);
  });

  it('setData: Unix-seconds detector fires when both ts in [1e9, 1e10]', () => {
    const store = new OhlcDataStore({ duplicates: 'error' });
    // 1.7e9 = 2023-11-15 in Unix seconds. Chart expects ms.
    expect(() => store.setData([
      ohlc(1_700_000_000, 1), ohlc(1_700_000_000, 2),
    ])).toThrow(/Unix SECONDS.*MILLISECONDS/);
  });

  it('setData: ms-shaped timestamps do NOT trigger the seconds hint', () => {
    const store = new OhlcDataStore({ duplicates: 'error' });
    // 1.7e12 = 2023-11-15 in Unix ms.
    expect(() => store.setData([
      ohlc(1_700_000_000_000, 1), ohlc(1_700_000_000_000, 2),
    ])).toThrow(/share timestamp 1700000000000/);
    expect(() => store.setData([
      ohlc(1_700_000_000_000, 1), ohlc(1_700_000_000_000, 2),
    ])).not.toThrow(/Unix SECONDS/);
  });

  it('append: out-of-order error reports against existing last index', () => {
    const store = new OhlcDataStore({ outOfOrder: 'error' });
    store.setData([ohlc(100, 1), ohlc(200, 2), ohlc(300, 3)]);
    // Now _length === 3. Trying to append t=150 should report
    // "row 3 has timestamp 150 < row 2 timestamp 300".
    expect(() => store.append(ohlc(150, 4))).toThrow(
      /row 3 has timestamp 150 < row 2 timestamp 300/,
    );
  });

  it('append: duplicate error reports against existing last index', () => {
    const store = new OhlcDataStore({ duplicates: 'error' });
    store.setData([ohlc(100, 1), ohlc(200, 2)]);
    expect(() => store.append(ohlc(200, 3))).toThrow(
      /rows 1 and 2 share timestamp 200/,
    );
  });

  it('appendBatch: first-row-conflict against existing store reports correct prevIndex (audit H2 fix)', () => {
    // Front 5 audit H2: the previous version passed prevIndex = i - 1 = -1
    // when the FIRST point in the batch conflicted with the last existing
    // row. User saw "row 0 < row -1" — nonsense. The fix tracks prevIndex
    // in the COMBINED stream (existing + appended), so the first-row
    // conflict correctly reports the EXISTING last index.
    const store = new OhlcDataStore({ outOfOrder: 'error' });
    store.setData([ohlc(100, 1), ohlc(200, 2)]);
    // store has 2 rows (indices 0,1). Batch with t=150 first should
    // throw "row 2 ... < row 1 timestamp 200".
    expect(() => store.appendBatch([ohlc(150, 3), ohlc(250, 4)])).toThrow(
      /row 2 has timestamp 150 < row 1 timestamp 200/,
    );
  });

  it('appendBatch: duplicate against existing last row reports correct prevIndex', () => {
    const store = new OhlcDataStore({ duplicates: 'error' });
    store.setData([ohlc(100, 1), ohlc(200, 2)]);
    expect(() => store.appendBatch([ohlc(200, 3), ohlc(300, 4)])).toThrow(
      /rows 1 and 2 share timestamp 200/,
    );
  });

  it('appendBatch: drop policy correctly skips out-of-order points without throwing', () => {
    const store = new OhlcDataStore({ outOfOrder: 'drop' });
    store.setData([ohlc(100, 1), ohlc(200, 2)]);
    // Drop the t=150 point silently.
    store.appendBatch([ohlc(150, 3), ohlc(300, 4)]);
    expect(store.length).toBe(3);  // 100, 200, 300 — 150 dropped
  });

  it('appendBatch: error suggests sort/groupby remediation', () => {
    const store = new OhlcDataStore({ duplicates: 'error' });
    expect(() => store.setData([ohlc(100, 1), ohlc(100, 2)])).toThrow(
      /Add a `sort` transform .* deduplicate upstream/,
    );
  });

});
