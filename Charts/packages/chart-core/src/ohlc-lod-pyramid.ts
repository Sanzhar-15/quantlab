import { lowerBound, upperBound } from './binary-search';

export type OhlcLodPyramidOptions = {
  maxLevels?: number;
  minPoints?: number;
  maxBytes?: number;
};

export type OhlcLodLevel = {
  bucketSize: number;
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  length: number;
};

type BucketState = {
  bucketIndex: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  hasValue: boolean;
};

const DEFAULT_MAX_LEVELS = 8;
const DEFAULT_MIN_POINTS = 2048;
const LOD_SAMPLE_THRESHOLD = 2;
const LOD_BUCKET_BIAS = 0.8;
const LOD_HYSTERESIS_RATIO = 0.15;

class OhlcLevelBuffer implements OhlcLodLevel {
  public bucketSize: number;
  public time: Float64Array;
  public open: Float64Array;
  public high: Float64Array;
  public low: Float64Array;
  public close: Float64Array;
  public length = 0;

  public constructor(bucketSize: number, capacity: number) {
    this.bucketSize = bucketSize;
    const safeCapacity = Math.max(0, Math.floor(capacity));
    this.time = new Float64Array(safeCapacity);
    this.open = new Float64Array(safeCapacity);
    this.high = new Float64Array(safeCapacity);
    this.low = new Float64Array(safeCapacity);
    this.close = new Float64Array(safeCapacity);
  }

  public ensureCapacity(nextLength: number): void {
    if (nextLength <= this.time.length) return;

    let nextCapacity = Math.max(this.time.length, 16);
    while (nextCapacity < nextLength) {
      nextCapacity *= 2;
    }

    const nextTime = new Float64Array(nextCapacity);
    const nextOpen = new Float64Array(nextCapacity);
    const nextHigh = new Float64Array(nextCapacity);
    const nextLow = new Float64Array(nextCapacity);
    const nextClose = new Float64Array(nextCapacity);

    nextTime.set(this.time.subarray(0, this.length));
    nextOpen.set(this.open.subarray(0, this.length));
    nextHigh.set(this.high.subarray(0, this.length));
    nextLow.set(this.low.subarray(0, this.length));
    nextClose.set(this.close.subarray(0, this.length));

    this.time = nextTime;
    this.open = nextOpen;
    this.high = nextHigh;
    this.low = nextLow;
    this.close = nextClose;
  }

  public truncate(nextLength: number): void {
    this.length = Math.max(0, Math.min(Math.floor(nextLength), this.length));
  }
}

const pow2Ceil = (value: number): number => {
  if (value <= 1) return 1;
  return Math.pow(2, Math.ceil(Math.log2(value)));
};

const resolveLevelCount = (length: number, maxLevels: number): number => {
  if (length <= 1) return 0;
  const maxByLength = Math.floor(Math.log2(length));
  return Math.max(0, Math.min(maxLevels, maxByLength));
};

const isFiniteOhlc = (o: number, h: number, l: number, c: number): boolean =>
  Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c);

const buildBucketState = (
  bucketIndex: number,
  time: Float64Array,
  open: Float64Array,
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  start: number,
  end: number,
): BucketState => {
  let bucketTime = time[start] ?? Number.NaN;
  let bucketOpen = Number.NaN;
  let bucketHigh = Number.NaN;
  let bucketLow = Number.NaN;
  let bucketClose = Number.NaN;
  let hasValue = false;

  const safeEnd = Math.max(start, Math.min(end, time.length));
  for (let i = start; i < safeEnd; i += 1) {
    const o = open[i]!;
    const h = high[i]!;
    const l = low[i]!;
    const c = close[i]!;
    if (!isFiniteOhlc(o, h, l, c)) continue;
    if (!hasValue) {
      bucketTime = time[i] ?? bucketTime;
      bucketOpen = o;
      bucketHigh = h;
      bucketLow = l;
      bucketClose = c;
      hasValue = true;
      continue;
    }
    if (h > bucketHigh) bucketHigh = h;
    if (l < bucketLow) bucketLow = l;
    bucketClose = c;
  }

  return {
    bucketIndex,
    time: bucketTime,
    open: bucketOpen,
    high: bucketHigh,
    low: bucketLow,
    close: bucketClose,
    hasValue,
  };
};

const applyBucketToLevel = (level: OhlcLevelBuffer, state: BucketState): void => {
  const index = state.bucketIndex;
  level.ensureCapacity(index + 1);
  level.time[index] = state.time;
  if (state.hasValue) {
    level.open[index] = state.open;
    level.high[index] = state.high;
    level.low[index] = state.low;
    level.close[index] = state.close;
  } else {
    level.open[index] = Number.NaN;
    level.high[index] = Number.NaN;
    level.low[index] = Number.NaN;
    level.close[index] = Number.NaN;
  }
  if (index >= level.length) {
    level.length = index + 1;
  }
};

export class OhlcLodPyramid {
  private readonly _options: Required<OhlcLodPyramidOptions>;
  private _levels: OhlcLevelBuffer[] = [];
  private _states: BucketState[] = [];
  private _length = 0;
  private _bytesUsed = 0;
  private _lastLevel: OhlcLevelBuffer | null = null;

  public constructor(options: OhlcLodPyramidOptions = {}) {
    this._options = {
      maxLevels: options.maxLevels ?? DEFAULT_MAX_LEVELS,
      minPoints: options.minPoints ?? DEFAULT_MIN_POINTS,
      maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY,
    };
  }

  public get length(): number {
    return this._length;
  }

  public get levels(): ReadonlyArray<OhlcLodLevel> {
    return this._levels;
  }

  public get bytesUsed(): number {
    return this._bytesUsed;
  }

  public clear(): void {
    this._levels = [];
    this._states = [];
    this._length = 0;
    this._bytesUsed = 0;
    this._lastLevel = null;
  }

  public rebuild(
    time: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    length: number,
  ): void {
    this._length = length;
    if (length < this._options.minPoints) {
      this.clear();
      return;
    }

    const levelCount = resolveLevelCount(length, this._options.maxLevels);
    if (levelCount === 0) {
      this.clear();
      return;
    }

    const nextLevels: OhlcLevelBuffer[] = [];
    const nextStates: BucketState[] = [];

    for (let levelIndex = 0; levelIndex < levelCount; levelIndex += 1) {
      const bucketSize = Math.pow(2, levelIndex + 1);
      const bucketCount = Math.ceil(length / bucketSize);
      const level = new OhlcLevelBuffer(bucketSize, bucketCount);
      let lastState: BucketState = {
        bucketIndex: -1,
        time: Number.NaN,
        open: Number.NaN,
        high: Number.NaN,
        low: Number.NaN,
        close: Number.NaN,
        hasValue: false,
      };

      for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
        const start = bucketIndex * bucketSize;
        const end = Math.min(length, start + bucketSize);
        const state = buildBucketState(
          bucketIndex,
          time,
          open,
          high,
          low,
          close,
          start,
          end,
        );
        applyBucketToLevel(level, state);
        if (bucketIndex === bucketCount - 1) {
          lastState = state;
        }
      }

      nextLevels.push(level);
      nextStates.push(lastState);
    }

    this._levels = nextLevels;
    this._states = nextStates;
    this._lastLevel = null;
    this._recalculateBytes();
    this._applyBudget();
  }

  public append(
    time: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    length: number,
  ): void {
    this._length = length;
    if (length <= 0) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, open, high, low, close, length);
      }
      return;
    }

    const lastIndex = length - 1;
    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const bucketSize = level.bucketSize;
      const bucketIndex = Math.floor(lastIndex / bucketSize);
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);

      let state = this._states[levelIndex];
      if (!state || state.bucketIndex !== bucketIndex) {
        state = buildBucketState(bucketIndex, time, open, high, low, close, start, end);
        this._states[levelIndex] = state;
      } else {
        const o = open[lastIndex]!;
        const h = high[lastIndex]!;
        const l = low[lastIndex]!;
        const c = close[lastIndex]!;
        if (isFiniteOhlc(o, h, l, c)) {
          if (!state.hasValue) {
            state.time = time[lastIndex] ?? state.time;
            state.open = o;
            state.high = h;
            state.low = l;
            state.close = c;
            state.hasValue = true;
          } else {
            if (h > state.high) state.high = h;
            if (l < state.low) state.low = l;
            state.close = c;
          }
        }
      }

      applyBucketToLevel(level, state);
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  public appendBatch(
    time: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    prevLength: number,
    length: number,
  ): void {
    this._length = length;
    if (length <= 0 || length <= prevLength) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, open, high, low, close, length);
      }
      return;
    }

    if (prevLength <= 0) {
      this.rebuild(time, open, high, low, close, length);
      return;
    }

    const startIndex = Math.max(0, prevLength - 1);

    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const bucketSize = level.bucketSize;
      const startBucket = Math.floor(startIndex / bucketSize);
      this._rebuildLevelFrom(levelIndex, time, open, high, low, close, length, startBucket);
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  public updateLast(
    time: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    length: number,
  ): void {
    this._length = length;
    if (length <= 0) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, open, high, low, close, length);
      }
      return;
    }

    const lastIndex = length - 1;
    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const bucketSize = level.bucketSize;
      const bucketIndex = Math.floor(lastIndex / bucketSize);
      const state = this._states[levelIndex];
      if (!state || state.bucketIndex !== bucketIndex) {
        this.rebuild(time, open, high, low, close, length);
        return;
      }
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);
      const nextState = buildBucketState(
        bucketIndex,
        time,
        open,
        high,
        low,
        close,
        start,
        end,
      );
      this._states[levelIndex] = nextState;
      applyBucketToLevel(level, nextState);
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  public patchExisting(
    time: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    length: number,
    range: { from: number; to: number },
  ): void {
    this._length = length;
    if (length <= 0) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, open, high, low, close, length);
      }
      return;
    }

    const fromIndex = lowerBound(time, length, range.from);
    const toIndex = upperBound(time, length, range.to) - 1;
    if (fromIndex > toIndex) return;

    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const bucketSize = level.bucketSize;
      const bucketCount = Math.ceil(length / bucketSize);
      if (bucketCount <= 0) continue;
      const lastBucket = bucketCount - 1;
      const startBucket = Math.floor(fromIndex / bucketSize);
      const endBucket = Math.min(lastBucket, Math.floor(toIndex / bucketSize));

      for (let bucketIndex = startBucket; bucketIndex <= endBucket; bucketIndex += 1) {
        const start = bucketIndex * bucketSize;
        const end = Math.min(length, start + bucketSize);
        const state = buildBucketState(
          bucketIndex,
          time,
          open,
          high,
          low,
          close,
          start,
          end,
        );
        applyBucketToLevel(level, state);
        if (bucketIndex === lastBucket) {
          this._states[levelIndex] = state;
        }
      }
      if (level.length !== bucketCount) {
        level.length = bucketCount;
      }
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  public pickLevel(visibleCount: number, plotWidth: number): OhlcLodLevel | null {
    if (this._levels.length === 0 || plotWidth <= 0 || visibleCount <= 0) return null;
    const samplesPerPixel = visibleCount / plotWidth;
    if (this._lastLevel && !this._levels.includes(this._lastLevel)) {
      this._lastLevel = null;
    }
    if (samplesPerPixel <= LOD_SAMPLE_THRESHOLD) {
      if (
        this._lastLevel &&
        samplesPerPixel >= LOD_SAMPLE_THRESHOLD * (1 - LOD_HYSTERESIS_RATIO)
      ) {
        return this._lastLevel;
      }
      this._lastLevel = null;
      return null;
    }

    if (this._lastLevel) {
      const bucket = this._lastLevel.bucketSize;
      const upper = (bucket / LOD_BUCKET_BIAS) * (1 + LOD_HYSTERESIS_RATIO);
      const lower = (bucket / (2 * LOD_BUCKET_BIAS)) * (1 - LOD_HYSTERESIS_RATIO);
      if (samplesPerPixel < upper && samplesPerPixel > lower) {
        return this._lastLevel;
      }
    }

    const targetBucket = pow2Ceil(samplesPerPixel * LOD_BUCKET_BIAS);
    for (const level of this._levels) {
      if (level.bucketSize >= targetBucket) {
        this._lastLevel = level;
        return level;
      }
    }
    const fallback = this._levels[this._levels.length - 1] ?? null;
    this._lastLevel = fallback;
    return fallback;
  }

  private _rebuildLevelFrom(
    levelIndex: number,
    time: Float64Array,
    open: Float64Array,
    high: Float64Array,
    low: Float64Array,
    close: Float64Array,
    length: number,
    startBucket: number,
  ): void {
    const level = this._levels[levelIndex];
    if (!level) return;
    const bucketSize = level.bucketSize;
    const bucketCount = Math.ceil(length / bucketSize);
    if (bucketCount <= 0 || startBucket >= bucketCount) return;

    level.ensureCapacity(bucketCount);

    for (let bucketIndex = startBucket; bucketIndex < bucketCount; bucketIndex += 1) {
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);
      const state = buildBucketState(
        bucketIndex,
        time,
        open,
        high,
        low,
        close,
        start,
        end,
      );
      applyBucketToLevel(level, state);
      if (bucketIndex === bucketCount - 1) {
        this._states[levelIndex] = state;
      }
    }

    level.length = bucketCount;
  }

  private _recalculateBytes(): void {
    let total = 0;
    for (const level of this._levels) {
      total +=
        level.time.byteLength +
        level.open.byteLength +
        level.high.byteLength +
        level.low.byteLength +
        level.close.byteLength;
    }
    this._bytesUsed = total;
  }

  private _applyBudget(): void {
    const budget = this._options.maxBytes;
    if (!Number.isFinite(budget) || budget <= 0) return;
    if (this._bytesUsed <= budget) return;

    while (this._levels.length > 0 && this._bytesUsed > budget) {
      this._levels.shift();
      this._states.shift();
      this._recalculateBytes();
    }
  }
}
