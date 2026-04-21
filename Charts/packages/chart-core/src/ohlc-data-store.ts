import type { OhlcDataPoint } from './api';
import type { DuplicatePolicy, NonFinitePolicy, OutOfOrderPolicy } from './data-provider';
import { lowerBound, upperBound } from './binary-search';

export type OhlcDataStoreArrays = {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
};

export type OhlcDataStoreOptions = {
  outOfOrder?: OutOfOrderPolicy;
  duplicates?: DuplicatePolicy;
  nonFinite?: NonFinitePolicy;
};

const sanitizeValue = (value: number, nonFinite: NonFinitePolicy): number => {
  if (!Number.isFinite(value)) {
    return nonFinite === 'gap' ? Number.NaN : value;
  }
  return value;
};

const sanitizePoint = (
  point: OhlcDataPoint,
  nonFinite: NonFinitePolicy,
): { o: number; h: number; l: number; c: number } => {
  const o = sanitizeValue(point.o, nonFinite);
  const h = sanitizeValue(point.h, nonFinite);
  const l = sanitizeValue(point.l, nonFinite);
  const c = sanitizeValue(point.c, nonFinite);
  if (
    nonFinite === 'gap' &&
    (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c))
  ) {
    return { o: Number.NaN, h: Number.NaN, l: Number.NaN, c: Number.NaN };
  }
  return { o, h, l, c };
};

export class OhlcDataStore {
  private _time: Float64Array;
  private _open: Float64Array;
  private _high: Float64Array;
  private _low: Float64Array;
  private _close: Float64Array;
  private _length = 0;
  private readonly _outOfOrder: OutOfOrderPolicy;
  private readonly _duplicates: DuplicatePolicy;
  private readonly _nonFinite: NonFinitePolicy;

  public constructor(initialCapacity: number);
  public constructor(options?: OhlcDataStoreOptions);
  public constructor(initialCapacity?: number, options?: OhlcDataStoreOptions);
  public constructor(
    initialCapacityOrOptions: number | OhlcDataStoreOptions = 0,
    options?: OhlcDataStoreOptions,
  ) {
    const hasCapacity = typeof initialCapacityOrOptions === 'number';
    const capacity = Math.max(0, hasCapacity ? initialCapacityOrOptions : 0);
    const resolvedOptions = (hasCapacity ? options : initialCapacityOrOptions) ?? {};
    this._time = new Float64Array(capacity);
    this._open = new Float64Array(capacity);
    this._high = new Float64Array(capacity);
    this._low = new Float64Array(capacity);
    this._close = new Float64Array(capacity);
    this._outOfOrder = resolvedOptions.outOfOrder ?? 'reject';
    this._duplicates =
      resolvedOptions.duplicates ?? (this._outOfOrder === 'drop' ? 'ignore' : 'reject');
    this._nonFinite = resolvedOptions.nonFinite ?? 'allow';
  }

  public get length(): number {
    return this._length;
  }

  public setData(points: OhlcDataPoint[]): void {
    const count = points.length;
    const capacity = Math.max(count, 16);
    const time = new Float64Array(capacity);
    const open = new Float64Array(capacity);
    const high = new Float64Array(capacity);
    const low = new Float64Array(capacity);
    const close = new Float64Array(capacity);
    let length = 0;
    let prevTime = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < count; i += 1) {
      const point = points[i]!;
      const t = point.t;
      if (t < prevTime) {
        if (this._outOfOrder === 'drop') continue;
        throw new Error('OhlcDataStore.setData requires strictly increasing time values.');
      }
      if (t === prevTime) {
        if (this._duplicates === 'ignore') continue;
        if (this._duplicates === 'replace') {
          if (length > 0) {
            const sanitized = sanitizePoint(point, this._nonFinite);
            open[length - 1] = sanitized.o;
            high[length - 1] = sanitized.h;
            low[length - 1] = sanitized.l;
            close[length - 1] = sanitized.c;
          }
          continue;
        }
        throw new Error('OhlcDataStore.setData requires strictly increasing time values.');
      }
      const sanitized = sanitizePoint(point, this._nonFinite);
      time[length] = t;
      open[length] = sanitized.o;
      high[length] = sanitized.h;
      low[length] = sanitized.l;
      close[length] = sanitized.c;
      length += 1;
      prevTime = t;
    }

    this._time = time;
    this._open = open;
    this._high = high;
    this._low = low;
    this._close = close;
    this._length = length;
  }

  public append(point: OhlcDataPoint): void {
    if (this._length > 0) {
      const last = this._time[this._length - 1]!;
      if (point.t < last) {
        if (this._outOfOrder === 'drop') return;
        throw new Error('OhlcDataStore.append requires time greater than the last value.');
      }
      if (point.t === last) {
        if (this._duplicates === 'ignore') return;
        if (this._duplicates === 'replace') {
          const sanitized = sanitizePoint(point, this._nonFinite);
          this._open[this._length - 1] = sanitized.o;
          this._high[this._length - 1] = sanitized.h;
          this._low[this._length - 1] = sanitized.l;
          this._close[this._length - 1] = sanitized.c;
          return;
        }
        throw new Error('OhlcDataStore.append requires time greater than the last value.');
      }
    }

    this._ensureCapacity(this._length + 1);
    const sanitized = sanitizePoint(point, this._nonFinite);
    this._time[this._length] = point.t;
    this._open[this._length] = sanitized.o;
    this._high[this._length] = sanitized.h;
    this._low[this._length] = sanitized.l;
    this._close[this._length] = sanitized.c;
    this._length += 1;
  }

  public appendBatch(points: OhlcDataPoint[]): void {
    if (points.length === 0) return;

    let prevTime = this._length > 0 ? this._time[this._length - 1]! : Number.NEGATIVE_INFINITY;
    this._ensureCapacity(this._length + points.length);

    for (const point of points) {
      if (point.t < prevTime) {
        if (this._outOfOrder === 'drop') continue;
        throw new Error('OhlcDataStore.appendBatch requires strictly increasing time values.');
      }
      if (point.t === prevTime) {
        if (this._duplicates === 'ignore') continue;
        if (this._duplicates === 'replace') {
          if (this._length > 0) {
            const sanitized = sanitizePoint(point, this._nonFinite);
            this._open[this._length - 1] = sanitized.o;
            this._high[this._length - 1] = sanitized.h;
            this._low[this._length - 1] = sanitized.l;
            this._close[this._length - 1] = sanitized.c;
          }
          continue;
        }
        throw new Error('OhlcDataStore.appendBatch requires strictly increasing time values.');
      }
      const sanitized = sanitizePoint(point, this._nonFinite);
      this._time[this._length] = point.t;
      this._open[this._length] = sanitized.o;
      this._high[this._length] = sanitized.h;
      this._low[this._length] = sanitized.l;
      this._close[this._length] = sanitized.c;
      this._length += 1;
      prevTime = point.t;
    }
  }

  public updateLast(point: OhlcDataPoint): void {
    if (this._length === 0) {
      this.append(point);
      return;
    }

    const lastIndex = this._length - 1;
    const lastTime = this._time[lastIndex]!;
    if (point.t < lastTime) {
      if (this._outOfOrder === 'drop') return;
      throw new Error('OhlcDataStore.updateLast requires time >= last value.');
    }

    if (point.t === lastTime) {
      const sanitized = sanitizePoint(point, this._nonFinite);
      this._open[lastIndex] = sanitized.o;
      this._high[lastIndex] = sanitized.h;
      this._low[lastIndex] = sanitized.l;
      this._close[lastIndex] = sanitized.c;
      return;
    }

    this.append(point);
  }

  public patchExisting(
    points: OhlcDataPoint[],
  ): { updated: number; minTime: number; maxTime: number } | null {
    if (points.length === 0 || this._length === 0) return null;
    let updated = 0;
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;

    for (const point of points) {
      const index = lowerBound(this._time, this._length, point.t);
      if (index >= this._length) continue;
      if (this._time[index] !== point.t) continue;
      const sanitized = sanitizePoint(point, this._nonFinite);
      const hasChange =
        !Object.is(this._open[index], sanitized.o) ||
        !Object.is(this._high[index], sanitized.h) ||
        !Object.is(this._low[index], sanitized.l) ||
        !Object.is(this._close[index], sanitized.c);
      if (!hasChange) continue;
      this._open[index] = sanitized.o;
      this._high[index] = sanitized.h;
      this._low[index] = sanitized.l;
      this._close[index] = sanitized.c;
      updated += 1;
      minTime = Math.min(minTime, point.t);
      maxTime = Math.max(maxTime, point.t);
    }

    if (updated === 0) return null;
    return { updated, minTime, maxTime };
  }

  public times(): Float64Array {
    return this._time.subarray(0, this._length);
  }

  public opens(): Float64Array {
    return this._open.subarray(0, this._length);
  }

  public highs(): Float64Array {
    return this._high.subarray(0, this._length);
  }

  public lows(): Float64Array {
    return this._low.subarray(0, this._length);
  }

  public closes(): Float64Array {
    return this._close.subarray(0, this._length);
  }

  public lowerBound(time: number): number {
    return lowerBound(this._time, this._length, time);
  }

  public upperBound(time: number): number {
    return upperBound(this._time, this._length, time);
  }

  public snapshot(): OhlcDataStoreArrays {
    return {
      time: this._time.subarray(0, this._length),
      open: this._open.subarray(0, this._length),
      high: this._high.subarray(0, this._length),
      low: this._low.subarray(0, this._length),
      close: this._close.subarray(0, this._length),
    };
  }

  private _ensureCapacity(nextLength: number): void {
    if (nextLength <= this._time.length) return;

    let nextCapacity = Math.max(this._time.length, 16);
    while (nextCapacity < nextLength) {
      nextCapacity *= 2;
    }

    const nextTime = new Float64Array(nextCapacity);
    const nextOpen = new Float64Array(nextCapacity);
    const nextHigh = new Float64Array(nextCapacity);
    const nextLow = new Float64Array(nextCapacity);
    const nextClose = new Float64Array(nextCapacity);

    nextTime.set(this._time.subarray(0, this._length));
    nextOpen.set(this._open.subarray(0, this._length));
    nextHigh.set(this._high.subarray(0, this._length));
    nextLow.set(this._low.subarray(0, this._length));
    nextClose.set(this._close.subarray(0, this._length));

    this._time = nextTime;
    this._open = nextOpen;
    this._high = nextHigh;
    this._low = nextLow;
    this._close = nextClose;
  }
}
