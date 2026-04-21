import { describe, expect, it } from 'vitest';

import { DataStore } from './data-store';
import { NumericScale } from './numeric-scale';

describe('NumericScale', () => {
  it('round-trips timeToX and xToTime', () => {
    const store = new DataStore();
    store.setData([
      { t: 1, v: 1 },
      { t: 5, v: 2 },
      { t: 9, v: 3 },
    ]);
    const scale = new NumericScale(store, { from: 1, to: 9 });
    scale.setPlotWidth(200);

    const x = scale.timeToX(4);
    const t = scale.xToTime(x);
    expect(Math.abs(t - 4)).toBeLessThan(1e-6);
  });

  it('uses tickSteps for numeric ticks', () => {
    const store = new DataStore();
    store.setData([
      { t: 0, v: 0 },
      { t: 10, v: 1 },
    ]);
    const scale = new NumericScale(store, { from: 0, to: 10 }, { tickSteps: [1, 2, 5], tickCount: 6 });

    const ticks = scale.getTicksForRange({ from: 0, to: 10 }, 6);
    expect(ticks).toEqual([0, 2, 4, 6, 8, 10]);
  });
});
