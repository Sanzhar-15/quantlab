import { lowerBound, upperBound } from './binary-search';

export type LodPyramidOptions = {
  maxLevels?: number;
  minPoints?: number;
  maxBytes?: number;
};

export type LodLevel = {
  bucketSize: number;
  time: Float64Array;
  value: Float64Array;
  length: number;
  offsets?: Int32Array;
};

type BucketState = {
  bucketIndex: number;
  outputStart: number;
  hasFinite: boolean;
  firstIndex: number;
  lastIndex: number;
  minIndex: number;
  maxIndex: number;
  minValue: number;
  maxValue: number;
  firstNaNIndex: number;
};

const DEFAULT_MAX_LEVELS = 8;
const DEFAULT_MIN_POINTS = 2048;
const LOD_SAMPLE_THRESHOLD = 2;
const LOD_BUCKET_BIAS = 0.8;
const LOD_HYSTERESIS_RATIO = 0.15;

class LodLevelBuffer implements LodLevel {
  public bucketSize: number;
  public time: Float64Array;
  public value: Float64Array;
  public length = 0;

  public constructor(bucketSize: number, capacity: number) {
    this.bucketSize = bucketSize;
    const safeCapacity = Math.max(0, Math.floor(capacity));
    this.time = new Float64Array(safeCapacity);
    this.value = new Float64Array(safeCapacity);
  }

  public ensureCapacity(nextLength: number): void {
    if (nextLength <= this.time.length) return;

    let nextCapacity = Math.max(this.time.length, 16);
    while (nextCapacity < nextLength) {
      nextCapacity *= 2;
    }

    const nextTime = new Float64Array(nextCapacity);
    const nextValue = new Float64Array(nextCapacity);
    nextTime.set(this.time.subarray(0, this.length));
    nextValue.set(this.value.subarray(0, this.length));
    this.time = nextTime;
    this.value = nextValue;
  }

  public truncate(nextLength: number): void {
    this.length = Math.max(0, Math.min(Math.floor(nextLength), this.length));
  }

  public push(time: number, value: number): void {
    this.ensureCapacity(this.length + 1);
    this.time[this.length] = time;
    this.value[this.length] = value;
    this.length += 1;
  }
}

type OffsetBuffer = {
  data: Int32Array;
  length: number;
};

const createOffsetBuffer = (capacity: number): OffsetBuffer => ({
  data: new Int32Array(Math.max(0, Math.floor(capacity))),
  length: 0,
});

const ensureOffsetCapacity = (offsets: OffsetBuffer, nextLength: number): void => {
  if (nextLength <= offsets.data.length) return;
  let nextCapacity = Math.max(offsets.data.length, 16);
  while (nextCapacity < nextLength) {
    nextCapacity *= 2;
  }
  const next = new Int32Array(nextCapacity);
  next.set(offsets.data.subarray(0, offsets.length));
  offsets.data = next;
};

const setOffset = (offsets: OffsetBuffer, index: number, value: number): void => {
  ensureOffsetCapacity(offsets, index + 1);
  offsets.data[index] = value;
  if (index >= offsets.length) {
    offsets.length = index + 1;
  }
};

const getOffset = (offsets: OffsetBuffer, index: number): number =>
  index < offsets.length ? offsets.data[index]! : 0;

const createState = (): BucketState => ({
  bucketIndex: -1,
  outputStart: 0,
  hasFinite: false,
  firstIndex: -1,
  lastIndex: -1,
  minIndex: -1,
  maxIndex: -1,
  minValue: 0,
  maxValue: 0,
  firstNaNIndex: -1,
});

const cloneState = (state: BucketState): BucketState => ({ ...state });

const resetState = (state: BucketState, bucketIndex: number, outputStart: number): void => {
  state.bucketIndex = bucketIndex;
  state.outputStart = outputStart;
  state.hasFinite = false;
  state.firstIndex = -1;
  state.lastIndex = -1;
  state.minIndex = -1;
  state.maxIndex = -1;
  state.minValue = 0;
  state.maxValue = 0;
  state.firstNaNIndex = -1;
};

const updateState = (state: BucketState, index: number, value: number): void => {
  if (Number.isNaN(value)) {
    if (state.firstNaNIndex < 0) state.firstNaNIndex = index;
    return;
  }

  if (!state.hasFinite) {
    state.hasFinite = true;
    state.firstIndex = index;
    state.lastIndex = index;
    state.minIndex = index;
    state.maxIndex = index;
    state.minValue = value;
    state.maxValue = value;
    return;
  }

  state.lastIndex = index;
  if (value < state.minValue) {
    state.minValue = value;
    state.minIndex = index;
  }
  if (value > state.maxValue) {
    state.maxValue = value;
    state.maxIndex = index;
  }
};

const writeBucketOutput = (
  level: LodLevelBuffer,
  state: BucketState,
  time: Float64Array,
  value: Float64Array,
  outputStart: number,
): number => {
  if (!state.hasFinite) {
    if (state.firstNaNIndex >= 0) {
      level.ensureCapacity(outputStart + 1);
      level.time[outputStart] = time[state.firstNaNIndex]!;
      level.value[outputStart] = Number.NaN;
      return 1;
    }
    return 0;
  }

  const indices: number[] = [state.firstIndex, state.minIndex, state.maxIndex, state.lastIndex];
  if (state.firstNaNIndex >= 0) {
    indices.push(state.firstNaNIndex);
  }

  indices.sort((a, b) => a - b);

  let previous = -1;
  let count = 0;
  level.ensureCapacity(outputStart + indices.length);
  for (const idx of indices) {
    if (idx === previous) continue;
    const v = value[idx]!;
    level.time[outputStart + count] = time[idx]!;
    level.value[outputStart + count] = Number.isNaN(v) ? Number.NaN : v;
    count += 1;
    previous = idx;
  }
  return count;
};

const countBucketOutput = (state: BucketState): number => {
  if (!state.hasFinite) {
    return state.firstNaNIndex >= 0 ? 1 : 0;
  }

  const indices: number[] = [state.firstIndex, state.minIndex, state.maxIndex, state.lastIndex];
  if (state.firstNaNIndex >= 0) {
    indices.push(state.firstNaNIndex);
  }

  indices.sort((a, b) => a - b);
  let count = 0;
  let previous = -1;
  for (const idx of indices) {
    if (idx === previous) continue;
    count += 1;
    previous = idx;
  }
  return count;
};

const buildOffsetsForLevel = (
  time: Float64Array,
  value: Float64Array,
  length: number,
  bucketSize: number,
): OffsetBuffer => {
  const bucketCount = Math.ceil(length / bucketSize);
  const offsets = createOffsetBuffer(bucketCount + 1);
  offsets.length = bucketCount + 1;

  const state = createState();
  let outputCount = 0;
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    offsets.data[bucketIndex] = outputCount;
    resetState(state, bucketIndex, 0);
    const start = bucketIndex * bucketSize;
    const end = Math.min(length, start + bucketSize);
    for (let i = start; i < end; i += 1) {
      updateState(state, i, value[i]!);
    }
    outputCount += countBucketOutput(state);
  }
  offsets.data[bucketCount] = outputCount;
  return offsets;
};

const pow2Ceil = (value: number): number => {
  if (value <= 1) return 1;
  return Math.pow(2, Math.ceil(Math.log2(value)));
};

const resolveLevelCount = (length: number, maxLevels: number): number => {
  if (length <= 1) return 0;
  const maxByLength = Math.floor(Math.log2(length));
  return Math.max(0, Math.min(maxLevels, maxByLength));
};

export class LodPyramid {
  private readonly _options: Required<LodPyramidOptions>;
  private _levels: LodLevelBuffer[] = [];
  private _states: BucketState[] = [];
  private _offsets: OffsetBuffer[] = [];
  private _length = 0;
  private _bytesUsed = 0;
  private _lastLevel: LodLevelBuffer | null = null;

  public constructor(options: LodPyramidOptions = {}) {
    this._options = {
      maxLevels: options.maxLevels ?? DEFAULT_MAX_LEVELS,
      minPoints: options.minPoints ?? DEFAULT_MIN_POINTS,
      maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY,
    };
  }

  public get length(): number {
    return this._length;
  }

  public get levels(): ReadonlyArray<LodLevel> {
    return this._levels;
  }

  public get bytesUsed(): number {
    return this._bytesUsed;
  }

  public clear(): void {
    this._levels = [];
    this._states = [];
    this._offsets = [];
    this._length = 0;
    this._bytesUsed = 0;
    this._lastLevel = null;
  }

  public loadLevels(levels: LodLevel[], time: Float64Array, value: Float64Array, length: number): void {
    this._length = length;
    if (levels.length === 0) {
      this._levels = [];
      this._states = [];
      this._offsets = [];
      this._lastLevel = null;
      return;
    }

    const sorted = [...levels].sort((a, b) => a.bucketSize - b.bucketSize);
    const nextLevels = sorted.map((level) => {
      const buffer = new LodLevelBuffer(level.bucketSize, 0);
      buffer.time = level.time;
      buffer.value = level.value;
      buffer.length = level.length;
      return buffer;
    });

    const nextOffsets = sorted.map((level) => {
      if (level.offsets) {
        return { data: level.offsets, length: level.offsets.length };
      }
      return buildOffsetsForLevel(time, value, length, level.bucketSize);
    });

    const nextStates = nextLevels.map((level, index) => {
      const state = createState();
      if (length <= 0) return state;

      const bucketIndex = Math.floor((length - 1) / level.bucketSize);
      const start = bucketIndex * level.bucketSize;
      const end = Math.min(length, start + level.bucketSize);
      const outputStart = getOffset(nextOffsets[index]!, bucketIndex);
      resetState(state, bucketIndex, outputStart);
      for (let i = start; i < end; i += 1) {
        updateState(state, i, value[i]!);
      }
      return state;
    });

    this._levels = nextLevels;
    this._states = nextStates;
    this._offsets = nextOffsets;
    this._lastLevel = null;
    this._recalculateBytes();
    this._applyBudget();
  }

  public rebuild(time: Float64Array, value: Float64Array, length: number): void {
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

    const nextLevels: LodLevelBuffer[] = [];
    const nextStates: BucketState[] = [];
    const nextOffsets: OffsetBuffer[] = [];

    for (let levelIndex = 0; levelIndex < levelCount; levelIndex += 1) {
      const bucketSize = Math.pow(2, levelIndex + 1);
      const bucketCount = Math.ceil(length / bucketSize);
      const capacity = bucketCount * 5;
      const level = new LodLevelBuffer(bucketSize, capacity);
      const offsets = createOffsetBuffer(bucketCount + 1);
      offsets.length = bucketCount + 1;
      const state = createState();
      let lastState = createState();

      for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
        offsets.data[bucketIndex] = level.length;
        resetState(state, bucketIndex, level.length);
        const start = bucketIndex * bucketSize;
        const end = Math.min(length, start + bucketSize);
        for (let i = start; i < end; i += 1) {
          updateState(state, i, value[i]!);
        }
        const count = writeBucketOutput(level, state, time, value, level.length);
        level.length += count;
        if (bucketIndex === bucketCount - 1) {
          lastState = cloneState(state);
        }
        offsets.data[bucketIndex + 1] = level.length;
      }

      nextLevels.push(level);
      nextStates.push(lastState);
      nextOffsets.push(offsets);
    }

    this._levels = nextLevels;
    this._states = nextStates;
    this._offsets = nextOffsets;
    this._lastLevel = null;
    this._recalculateBytes();
    this._applyBudget();
  }

  public append(time: Float64Array, value: Float64Array, length: number): void {
    this._length = length;
    if (length <= 0) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, value, length);
      }
      return;
    }

    const lastIndex = length - 1;

    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const state = this._states[levelIndex]!;
      const offsets = this._offsets[levelIndex];
      if (!offsets) {
        this.rebuild(time, value, length);
        return;
      }
      const bucketIndex = Math.floor(lastIndex / level.bucketSize);

      const bucketCount = Math.max(0, offsets.length - 1);
      const isNewBucket = bucketIndex >= bucketCount;
      const outputStart = isNewBucket ? level.length : getOffset(offsets, bucketIndex);

      if (bucketIndex !== state.bucketIndex || isNewBucket) {
        resetState(state, bucketIndex, outputStart);
      }

      updateState(state, lastIndex, value[lastIndex]!);
      const count = writeBucketOutput(level, state, time, value, state.outputStart);
      level.length = state.outputStart + count;
      setOffset(offsets, bucketIndex, state.outputStart);
      setOffset(offsets, bucketIndex + 1, level.length);
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  public appendBatch(
    time: Float64Array,
    value: Float64Array,
    prevLength: number,
    length: number,
  ): void {
    this._length = length;
    if (length <= 0 || length <= prevLength) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, value, length);
      }
      return;
    }

    if (prevLength <= 0) {
      this.rebuild(time, value, length);
      return;
    }

    const startIndex = Math.max(0, prevLength - 1);

    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const offsets = this._offsets[levelIndex];
      if (!offsets) {
        this.rebuild(time, value, length);
        return;
      }
      const bucketSize = level.bucketSize;
      const startBucket = Math.floor(startIndex / bucketSize);
      this._rebuildLevelFrom(levelIndex, time, value, length, startBucket);
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  public updateLast(time: Float64Array, value: Float64Array, length: number): void {
    this._length = length;
    if (length <= 0) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, value, length);
      }
      return;
    }

    const lastIndex = length - 1;

    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const state = this._states[levelIndex]!;
      const offsets = this._offsets[levelIndex];
      if (!offsets) {
        this.rebuild(time, value, length);
        return;
      }
      const bucketIndex = Math.floor(lastIndex / level.bucketSize);

      if (bucketIndex !== state.bucketIndex) {
        this.rebuild(time, value, length);
        return;
      }

      const outputStart = getOffset(offsets, bucketIndex);
      resetState(state, bucketIndex, outputStart);
      const start = bucketIndex * level.bucketSize;
      const end = Math.min(length, start + level.bucketSize);
      for (let i = start; i < end; i += 1) {
        updateState(state, i, value[i]!);
      }
      const count = writeBucketOutput(level, state, time, value, outputStart);
      level.length = outputStart + count;
      setOffset(offsets, bucketIndex + 1, level.length);
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  public patchExisting(
    time: Float64Array,
    value: Float64Array,
    length: number,
    range: { from: number; to: number },
  ): void {
    this._length = length;
    if (length <= 0) return;

    if (this._levels.length === 0) {
      if (length >= this._options.minPoints) {
        this.rebuild(time, value, length);
      }
      return;
    }

    const fromIndex = lowerBound(time, length, range.from);
    const toIndex = upperBound(time, length, range.to) - 1;
    if (fromIndex > toIndex) return;

    for (let levelIndex = 0; levelIndex < this._levels.length; levelIndex += 1) {
      const level = this._levels[levelIndex]!;
      const offsets = this._offsets[levelIndex];
      if (!offsets) {
        this.rebuild(time, value, length);
        return;
      }
      const bucketSize = level.bucketSize;
      const bucketCount = Math.ceil(length / bucketSize);
      if (offsets.length < bucketCount + 1) {
        this.rebuild(time, value, length);
        return;
      }
      const lastBucket = bucketCount - 1;
      const startBucket = Math.floor(fromIndex / bucketSize);
      const endBucket = Math.min(lastBucket, Math.floor(toIndex / bucketSize));
      if (startBucket > lastBucket) continue;

      let rebuildFrom = -1;
      const state = createState();
      for (let bucketIndex = startBucket; bucketIndex <= endBucket; bucketIndex += 1) {
        const outputStart = getOffset(offsets, bucketIndex);
        resetState(state, bucketIndex, outputStart);
        const start = bucketIndex * bucketSize;
        const end = Math.min(length, start + bucketSize);
        for (let i = start; i < end; i += 1) {
          updateState(state, i, value[i]!);
        }
        const nextCount = writeBucketOutput(level, state, time, value, outputStart);
        const prevCount = getOffset(offsets, bucketIndex + 1) - outputStart;
        if (nextCount !== prevCount) {
          if (bucketIndex === lastBucket) {
            this._states[levelIndex] = cloneState(state);
            const nextLength = outputStart + nextCount;
            level.length = nextLength;
            setOffset(offsets, bucketIndex + 1, nextLength);
            break;
          }
          rebuildFrom = bucketIndex;
          break;
        }
        if (bucketIndex === lastBucket) {
          this._states[levelIndex] = cloneState(state);
          const nextLength = outputStart + nextCount;
          level.length = nextLength;
          setOffset(offsets, bucketIndex + 1, nextLength);
        }
      }

      if (rebuildFrom >= 0) {
        this._rebuildLevelFrom(levelIndex, time, value, length, rebuildFrom);
      }
    }

    this._recalculateBytes();
    this._applyBudget();
  }

  private _rebuildLevelFrom(
    levelIndex: number,
    time: Float64Array,
    value: Float64Array,
    length: number,
    startBucket: number,
  ): void {
    const level = this._levels[levelIndex];
    const offsets = this._offsets[levelIndex];
    if (!level || !offsets) {
      this.rebuild(time, value, length);
      return;
    }
    const bucketSize = level.bucketSize;
    const bucketCount = Math.ceil(length / bucketSize);
    if (bucketCount <= 0 || startBucket >= bucketCount) return;

    const outputStart = getOffset(offsets, startBucket);
    level.truncate(outputStart);

    const state = createState();
    for (let bucketIndex = startBucket; bucketIndex < bucketCount; bucketIndex += 1) {
      const bucketOutputStart = level.length;
      resetState(state, bucketIndex, bucketOutputStart);
      const start = bucketIndex * bucketSize;
      const end = Math.min(length, start + bucketSize);
      for (let i = start; i < end; i += 1) {
        updateState(state, i, value[i]!);
      }
      const count = writeBucketOutput(level, state, time, value, bucketOutputStart);
      level.length = bucketOutputStart + count;
      setOffset(offsets, bucketIndex, bucketOutputStart);
      setOffset(offsets, bucketIndex + 1, level.length);
      if (bucketIndex === bucketCount - 1) {
        this._states[levelIndex] = cloneState(state);
      }
    }
    offsets.length = bucketCount + 1;
  }

  public pickLevel(visibleCount: number, plotWidth: number): LodLevel | null {
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

  private _recalculateBytes(): void {
    let total = 0;
    for (const level of this._levels) {
      total += level.time.byteLength + level.value.byteLength;
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
      this._offsets.shift();
      this._recalculateBytes();
    }
  }
}
