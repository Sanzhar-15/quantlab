import type { DataPoint } from './api';
import type { DuplicatePolicy, NonFinitePolicy, OutOfOrderPolicy } from './data-provider';
import { lowerBound, upperBound } from './binary-search';

export type DataStoreArrays = {
  time: Float64Array;
  value: Float64Array;
};

export type DataStoreOptions = {
  outOfOrder?: OutOfOrderPolicy;
  duplicates?: DuplicatePolicy;
  nonFinite?: NonFinitePolicy;
};

const sanitizeValue = (value: number | null, nonFinite: NonFinitePolicy): number => {
  if (value === null) return Number.NaN;
  if (!Number.isFinite(value)) {
    return nonFinite === 'gap' ? Number.NaN : value;
  }
  return value;
};

export class DataStore {
  private _time: Float64Array;
  private _value: Float64Array;
  private _length = 0;
  private readonly _outOfOrder: OutOfOrderPolicy;
  private readonly _duplicates: DuplicatePolicy;
  private readonly _nonFinite: NonFinitePolicy;

  public constructor(initialCapacity: number);
  public constructor(options?: DataStoreOptions);
  public constructor(initialCapacity?: number, options?: DataStoreOptions);
  public constructor(
    initialCapacityOrOptions: number | DataStoreOptions = 0,
    options?: DataStoreOptions,
  ) {
    const hasCapacity = typeof initialCapacityOrOptions === 'number';
    const capacity = Math.max(0, hasCapacity ? initialCapacityOrOptions : 0);
    const resolvedOptions = (hasCapacity ? options : initialCapacityOrOptions) ?? {};
    this._time = new Float64Array(capacity);
    this._value = new Float64Array(capacity);
    this._outOfOrder = resolvedOptions.outOfOrder ?? 'reject';
    this._duplicates =
      resolvedOptions.duplicates ?? (this._outOfOrder === 'drop' ? 'ignore' : 'reject');
    this._nonFinite = resolvedOptions.nonFinite ?? 'allow';
  }

  public get length(): number {
    return this._length;
  }

  public setData(points: DataPoint[]): void {
    const count = points.length;
    const capacity = Math.max(count, 16);
    const time = new Float64Array(capacity);
    const value = new Float64Array(capacity);
    let length = 0;
    let prevTime = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const point = points[i]!;
      const t = point.t;
      if (t < prevTime) {
        if (this._outOfOrder === 'drop') continue;
        throw new Error('DataStore.setData requires strictly increasing time values.');
      }
      if (t === prevTime) {
        if (this._duplicates === 'ignore') continue;
        if (this._duplicates === 'replace') {
          if (length > 0) {
            value[length - 1] = sanitizeValue(point.v, this._nonFinite);
          }
          continue;
        }
        throw new Error('DataStore.setData requires strictly increasing time values.');
      }
      time[length] = t;
      value[length] = sanitizeValue(point.v, this._nonFinite);
      length += 1;
      prevTime = t;
    }

    this._time = time;
    this._value = value;
    this._length = length;
  }

  public append(point: DataPoint): void {
    if (this._length > 0) {
      const last = this._time[this._length - 1]!;
      if (point.t < last) {
        if (this._outOfOrder === 'drop') return;
        throw new Error('DataStore.append requires time greater than the last value.');
      }
      if (point.t === last) {
        if (this._duplicates === 'ignore') return;
        if (this._duplicates === 'replace') {
          this._value[this._length - 1] = sanitizeValue(point.v, this._nonFinite);
          return;
        }
        throw new Error('DataStore.append requires time greater than the last value.');
      }
    }

    this._ensureCapacity(this._length + 1);
    this._time[this._length] = point.t;
    this._value[this._length] = sanitizeValue(point.v, this._nonFinite);
    this._length += 1;
  }

  public patchExisting(
    points: DataPoint[],
  ): { updated: number; minTime: number; maxTime: number } | null {
    if (points.length === 0 || this._length === 0) return null;
    let updated = 0;
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;

    for (const point of points) {
      const index = lowerBound(this._time, this._length, point.t);
      if (index >= this._length) continue;
      if (this._time[index] !== point.t) continue;
      const nextValue = sanitizeValue(point.v, this._nonFinite);
      if (Object.is(this._value[index], nextValue)) continue;
      this._value[index] = nextValue;
      updated += 1;
      minTime = Math.min(minTime, point.t);
      maxTime = Math.max(maxTime, point.t);
    }

    if (updated === 0) return null;
    return { updated, minTime, maxTime };
  }

  public appendBatch(points: DataPoint[]): void {
    if (points.length === 0) return;

    let prevTime = this._length > 0 ? this._time[this._length - 1]! : Number.NEGATIVE_INFINITY;
    this._ensureCapacity(this._length + points.length);

    for (const point of points) {
      if (point.t < prevTime) {
        if (this._outOfOrder === 'drop') continue;
        throw new Error('DataStore.appendBatch requires strictly increasing time values.');
      }
      if (point.t === prevTime) {
        if (this._duplicates === 'ignore') continue;
        if (this._duplicates === 'replace') {
          if (this._length > 0) {
            this._value[this._length - 1] = sanitizeValue(point.v, this._nonFinite);
          }
          continue;
        }
        throw new Error('DataStore.appendBatch requires strictly increasing time values.');
      }
      this._time[this._length] = point.t;
      this._value[this._length] = sanitizeValue(point.v, this._nonFinite);
      this._length += 1;
      prevTime = point.t;
    }
  }

  public updateLast(point: DataPoint): void {
    if (this._length === 0) {
      this.append(point);
      return;
    }

    const lastIndex = this._length - 1;
    const lastTime = this._time[lastIndex]!;
    if (point.t < lastTime) {
      if (this._outOfOrder === 'drop') return;
      throw new Error('DataStore.updateLast requires time >= last value.');
    }

    if (point.t === lastTime) {
      this._value[lastIndex] = sanitizeValue(point.v, this._nonFinite);
      return;
    }

    this.append(point);
  }

  public times(): Float64Array {
    return this._time.subarray(0, this._length);
  }

  public values(): Float64Array {
    return this._value.subarray(0, this._length);
  }

  public lowerBound(time: number): number {
    return lowerBound(this._time, this._length, time);
  }

  public upperBound(time: number): number {
    return upperBound(this._time, this._length, time);
  }

  public snapshot(): DataStoreArrays {
    return {
      time: this._time.subarray(0, this._length),
      value: this._value.subarray(0, this._length),
    };
  }

  private _ensureCapacity(nextLength: number): void {
    if (nextLength <= this._time.length) return;

    let nextCapacity = Math.max(this._time.length, 16);
    while (nextCapacity < nextLength) {
      nextCapacity *= 2;
    }

    const nextTime = new Float64Array(nextCapacity);
    const nextValue = new Float64Array(nextCapacity);
    nextTime.set(this._time.subarray(0, this._length));
    nextValue.set(this._value.subarray(0, this._length));

    this._time = nextTime;
    this._value = nextValue;
  }
}
