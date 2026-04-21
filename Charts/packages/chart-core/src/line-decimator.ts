import type { VisibleTimeRange } from './api';
import { resolveConflationPlotWidth } from './decimation-utils';

export type LineDecimationRange = {
  from: number;
  to: number;
};

export type LineDecimationResult = {
  time: Float64Array;
  value: Float64Array;
};

export type LineDecimationInput = {
  seriesId: string;
  visibleRange: VisibleTimeRange;
  visibleIndices: LineDecimationRange;
  time: Float64Array;
  value: Float64Array;
  plotWidth: number;
  scaleType: 'linear' | 'log';
};

export type LineDecimatorOptions = {
  maxEntries?: number;
  maxBytes?: number;
};

type CacheKey = {
  seriesId: string;
  visibleRange: VisibleTimeRange;
  plotWidth: number;
  scaleType: 'linear' | 'log';
};

type PooledDecimationResult = {
  result: LineDecimationResult;
  timeBuffer: Float64Array;
  valueBuffer: Float64Array;
};

class Float64ArrayPool {
  private readonly _pool: Float64Array[] = [];
  private readonly _maxEntries: number;
  private _totalAllocations = 0;
  private _frameAllocations = 0;

  public constructor(maxEntries = 64) {
    this._maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  public take(minLength: number): Float64Array {
    const target = Math.max(1, Math.floor(minLength));
    let bestIndex = -1;
    let bestLength = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this._pool.length; i += 1) {
      const candidate = this._pool[i]!;
      if (candidate.length >= target && candidate.length < bestLength) {
        bestIndex = i;
        bestLength = candidate.length;
      }
    }
    if (bestIndex >= 0) {
      const [reuse] = this._pool.splice(bestIndex, 1);
      return reuse!;
    }
    this._totalAllocations += 1;
    this._frameAllocations += 1;
    return new Float64Array(target);
  }

  public release(array: Float64Array): void {
    if (this._pool.length >= this._maxEntries) return;
    this._pool.push(array);
  }

  public resetFrameAllocations(): void {
    this._frameAllocations = 0;
  }

  public getAllocationStats(): { frame: number; total: number; pooled: number } {
    return {
      frame: this._frameAllocations,
      total: this._totalAllocations,
      pooled: this._pool.length,
    };
  }

  public clear(): void {
    this._pool.length = 0;
  }
}

class LineDecimatorCache {
  private readonly _entries = new Map<string, { result: LineDecimationResult; bytes: number; timeBuffer: Float64Array; valueBuffer: Float64Array }>();
  private readonly _maxEntries: number;
  private readonly _maxBytes: number | null;
  private _bytesUsed = 0;
  private readonly _pool: Float64ArrayPool;

  public constructor(pool: Float64ArrayPool, maxEntries = 32, maxBytes?: number) {
    this._pool = pool;
    this._maxEntries = Math.max(1, Math.floor(maxEntries));
    this._maxBytes =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : null;
  }

  public get(key: CacheKey): LineDecimationResult | undefined {
    const id = this._makeKey(key);
    const cached = this._entries.get(id);
    if (!cached) return undefined;
    this._entries.delete(id);
    this._entries.set(id, cached);
    return cached.result;
  }

  public set(key: CacheKey, value: PooledDecimationResult): void {
    const id = this._makeKey(key);
    if (this._entries.has(id)) {
      const existing = this._entries.get(id);
      if (existing) {
        this._bytesUsed -= existing.bytes;
        this._pool.release(existing.timeBuffer);
        this._pool.release(existing.valueBuffer);
      }
      this._entries.delete(id);
    }
    const bytes = value.timeBuffer.byteLength + value.valueBuffer.byteLength;
    this._entries.set(id, {
      result: value.result,
      bytes,
      timeBuffer: value.timeBuffer,
      valueBuffer: value.valueBuffer,
    });
    this._bytesUsed += bytes;
    this._enforceLimits();
  }

  public clear(): void {
    for (const entry of this._entries.values()) {
      this._pool.release(entry.timeBuffer);
      this._pool.release(entry.valueBuffer);
    }
    this._entries.clear();
    this._bytesUsed = 0;
  }

  private _makeKey(key: CacheKey): string {
    const { seriesId, visibleRange, plotWidth, scaleType } = key;
    return `${seriesId}|${visibleRange.from}|${visibleRange.to}|${plotWidth}|${scaleType}`;
  }

  private _enforceLimits(): void {
    const overEntryLimit = () => this._entries.size > this._maxEntries;
    const overByteLimit = () => this._maxBytes !== null && this._bytesUsed > this._maxBytes;

    while (overEntryLimit() || overByteLimit()) {
      const oldestKey = this._entries.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this._entries.get(oldestKey);
      if (entry) {
        this._bytesUsed -= entry.bytes;
        this._pool.release(entry.timeBuffer);
        this._pool.release(entry.valueBuffer);
      }
      this._entries.delete(oldestKey);
    }
  }
}

export class LineDecimator {
  private readonly _cache: LineDecimatorCache;
  private readonly _pool: Float64ArrayPool;

  public constructor(options: LineDecimatorOptions = {}) {
    this._pool = new Float64ArrayPool(Math.max(16, (options.maxEntries ?? 32) * 2));
    this._cache = new LineDecimatorCache(this._pool, options.maxEntries, options.maxBytes);
  }

  public decimate(input: LineDecimationInput): LineDecimationResult {
    const plotWidth = Math.max(0, Math.round(input.plotWidth));
    const cacheKey: CacheKey = {
      seriesId: input.seriesId,
      visibleRange: input.visibleRange,
      plotWidth,
      scaleType: input.scaleType,
    };
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;
    const result = decimateLine({
      ...input,
      plotWidth,
      pool: this._pool,
    });
    this._cache.set(cacheKey, result);
    return result.result;
  }

  public decimateTransient(
    input: LineDecimationInput,
  ): { result: LineDecimationResult; release: () => void } {
    const plotWidth = Math.max(0, Math.round(input.plotWidth));
    const pooled = decimateLine({
      ...input,
      plotWidth,
      pool: this._pool,
    });
    let released = false;
    return {
      result: pooled.result,
      release: () => {
        if (released) return;
        released = true;
        this._pool.release(pooled.timeBuffer);
        this._pool.release(pooled.valueBuffer);
      },
    };
  }

  public clearCache(): void {
    this._cache.clear();
  }

  public resetFrameAllocations(): void {
    this._pool.resetFrameAllocations();
  }

  public getAllocationStats(): { frame: number; total: number; pooled: number } {
    return this._pool.getAllocationStats();
  }
}

type BufferBuilder = { buffer: Float64Array; length: number };

const ensureCapacity = (pool: Float64ArrayPool, builder: BufferBuilder, nextLength: number): void => {
  if (nextLength <= builder.buffer.length) return;
  let nextCapacity = Math.max(builder.buffer.length, 16);
  while (nextCapacity < nextLength) {
    nextCapacity *= 2;
  }
  const next = pool.take(nextCapacity);
  next.set(builder.buffer.subarray(0, builder.length));
  pool.release(builder.buffer);
  builder.buffer = next;
};

const pushValue = (pool: Float64ArrayPool, builder: BufferBuilder, value: number): void => {
  ensureCapacity(pool, builder, builder.length + 1);
  builder.buffer[builder.length] = value;
  builder.length += 1;
};

const buildEmptyResult = (pool: Float64ArrayPool): PooledDecimationResult => {
  const timeBuffer = pool.take(1);
  const valueBuffer = pool.take(1);
  return {
    result: { time: timeBuffer.subarray(0, 0), value: valueBuffer.subarray(0, 0) },
    timeBuffer,
    valueBuffer,
  };
};

function decimateLine(
  input: LineDecimationInput & { plotWidth: number; pool: Float64ArrayPool },
): PooledDecimationResult {
  const { time, value, visibleIndices, visibleRange } = input;
  const length = Math.min(time.length, value.length);
  const fromIndex = Math.max(0, Math.min(length, visibleIndices.from));
  const toIndex = Math.max(fromIndex, Math.min(length, visibleIndices.to));

  if (input.plotWidth <= 0 || visibleRange.to <= visibleRange.from || fromIndex >= toIndex) {
    return buildEmptyResult(input.pool);
  }

  const plotWidth = input.plotWidth;
  const visibleCount = toIndex - fromIndex;
  const effectivePlotWidth = resolveConflationPlotWidth(plotWidth, visibleCount);
  const span = visibleRange.to - visibleRange.from;
  const pxPerMs = effectivePlotWidth / span;
  const baseColumn = Math.floor(visibleRange.from * pxPerMs);

  const estimated = Math.max(16, Math.min(effectivePlotWidth * 5, visibleCount * 4));
  const timeBuffer = input.pool.take(estimated);
  const valueBuffer = input.pool.take(estimated);
  const outTime: BufferBuilder = { buffer: timeBuffer, length: 0 };
  const outValue: BufferBuilder = { buffer: valueBuffer, length: 0 };

  let currentColumn = -1;
  let bucketHasPoint = false;
  let bucketHasValue = false;
  let firstIndex = -1;
  let lastIndex = -1;
  let minIndex = -1;
  let maxIndex = -1;
  let minValue = 0;
  let maxValue = 0;
  let inGap = false;
  let resumeIndex = -1;
  let firstNaNIndex = -1;

  const resetBucket = (): void => {
    bucketHasPoint = false;
    bucketHasValue = false;
    firstIndex = -1;
    lastIndex = -1;
    minIndex = -1;
    maxIndex = -1;
    minValue = 0;
    maxValue = 0;
    inGap = false;
    resumeIndex = -1;
    firstNaNIndex = -1;
  };

  const flushBucket = (): void => {
    if (!bucketHasPoint) return;
    if (!bucketHasValue) {
      if (firstNaNIndex >= 0) {
        pushValue(input.pool, outTime, time[firstNaNIndex]!);
        pushValue(input.pool, outValue, Number.NaN);
      }
      resetBucket();
      return;
    }

    const indices = [firstIndex, minIndex, maxIndex, lastIndex];
    indices.sort((a, b) => a - b);
    let previous = -1;
    let insertedGap = false;
    for (const idx of indices) {
      if (idx === previous) continue;
      if (resumeIndex >= 0 && !insertedGap && idx >= resumeIndex) {
        pushValue(input.pool, outTime, time[resumeIndex]!);
        pushValue(input.pool, outValue, Number.NaN);
        insertedGap = true;
      }
      pushValue(input.pool, outTime, time[idx]!);
      pushValue(input.pool, outValue, value[idx]!);
      previous = idx;
    }
    if (!insertedGap && inGap && firstNaNIndex >= 0) {
      pushValue(input.pool, outTime, time[firstNaNIndex]!);
      pushValue(input.pool, outValue, Number.NaN);
    }
    resetBucket();
  };

  for (let i = fromIndex; i < toIndex; i += 1) {
    const t = time[i]!;
    const rawColumn = Math.floor(t * pxPerMs) - baseColumn;
    const column =
      rawColumn < 0
        ? 0
        : rawColumn >= effectivePlotWidth
          ? Math.max(0, effectivePlotWidth - 1)
          : rawColumn;

    if (column !== currentColumn) {
      flushBucket();
      currentColumn = column;
    }

    const v = value[i]!;
    bucketHasPoint = true;
    if (Number.isNaN(v)) {
      if (firstNaNIndex < 0) firstNaNIndex = i;
      if (bucketHasValue) {
        inGap = true;
      }
      continue;
    }

    if (!bucketHasValue) {
      firstIndex = i;
      lastIndex = i;
      minIndex = i;
      maxIndex = i;
      minValue = v;
      maxValue = v;
      bucketHasValue = true;
    } else {
      lastIndex = i;
      if (v < minValue) {
        minValue = v;
        minIndex = i;
      }
      if (v > maxValue) {
        maxValue = v;
        maxIndex = i;
      }
    }

    if (inGap && resumeIndex < 0) {
      resumeIndex = i;
    }
    inGap = false;
  }

  flushBucket();

  return {
    result: {
      time: outTime.buffer.subarray(0, outTime.length),
      value: outValue.buffer.subarray(0, outValue.length),
    },
    timeBuffer: outTime.buffer,
    valueBuffer: outValue.buffer,
  };
}
