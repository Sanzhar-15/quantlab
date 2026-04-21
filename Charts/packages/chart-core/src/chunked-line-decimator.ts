import type { VisibleTimeRange } from './api';
import { lowerBound, upperBound } from './binary-search';
import { resolveConflationPlotWidth } from './decimation-utils';
import type { LodPyramid } from './lod-pyramid';

export type ChunkedDecimationResult = {
  time: Float64Array;
  value: Float64Array;
};

export type ChunkedDecimationChunk = {
  time: Float64Array;
  value: Float64Array;
  length: number;
  lod?: LodPyramid;
};

export type ChunkedDecimationInput = {
  seriesId: string;
  version: number;
  visibleRange: VisibleTimeRange;
  plotWidth: number;
  scaleType: 'linear' | 'log';
  chunks: ChunkedDecimationChunk[];
};

export type ChunkedLineDecimatorOptions = {
  maxEntries?: number;
  maxBytes?: number;
};

type CacheKey = {
  seriesId: string;
  version: number;
  visibleRange: VisibleTimeRange;
  plotWidth: number;
  scaleType: 'linear' | 'log';
};

type PooledDecimationResult = {
  result: ChunkedDecimationResult;
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

class ChunkedDecimatorCache {
  private readonly _entries = new Map<
    string,
    { result: ChunkedDecimationResult; bytes: number; timeBuffer: Float64Array; valueBuffer: Float64Array }
  >();
  private readonly _maxEntries: number;
  private readonly _maxBytes: number | null;
  private _bytesUsed = 0;

  public constructor(private readonly _pool: Float64ArrayPool, maxEntries = 32, maxBytes?: number) {
    this._maxEntries = Math.max(1, Math.floor(maxEntries));
    this._maxBytes =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : null;
  }

  public get(key: CacheKey): ChunkedDecimationResult | undefined {
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
    const { seriesId, version, visibleRange, plotWidth, scaleType } = key;
    return `${seriesId}|${version}|${visibleRange.from}|${visibleRange.to}|${plotWidth}|${scaleType}`;
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

export class ChunkedLineDecimator {
  private readonly _cache: ChunkedDecimatorCache;
  private readonly _pool: Float64ArrayPool;

  public constructor(options: ChunkedLineDecimatorOptions = {}) {
    this._pool = new Float64ArrayPool(Math.max(16, (options.maxEntries ?? 32) * 2));
    this._cache = new ChunkedDecimatorCache(this._pool, options.maxEntries, options.maxBytes);
  }

  public decimate(input: ChunkedDecimationInput): ChunkedDecimationResult {
    const plotWidth = Math.max(0, Math.round(input.plotWidth));
    const cacheKey: CacheKey = {
      seriesId: input.seriesId,
      version: input.version,
      visibleRange: input.visibleRange,
      plotWidth,
      scaleType: input.scaleType,
    };
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const result = decimateChunkedLine({ ...input, plotWidth, pool: this._pool });
    this._cache.set(cacheKey, result);
    return result.result;
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

type DecimationInput = ChunkedDecimationInput & {
  plotWidth: number;
  pool: Float64ArrayPool;
};

const isFiniteValue = (value: number): boolean => Number.isFinite(value);

type BufferBuilder = { buffer: Float64Array; length: number };
type ResolvedChunk = { time: Float64Array; value: Float64Array; from: number; to: number };

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

function decimateChunkedLine(input: DecimationInput): PooledDecimationResult {
  const { chunks, visibleRange } = input;
  if (input.plotWidth <= 0 || visibleRange.to <= visibleRange.from || chunks.length === 0) {
    return buildEmptyResult(input.pool);
  }

  const plotWidth = input.plotWidth;
  const span = visibleRange.to - visibleRange.from;
  const resolvedChunks: ResolvedChunk[] = [];
  let visibleCount = 0;

  for (const chunk of chunks) {
    if (chunk.length <= 0) continue;
    const baseTime = chunk.time;
    const baseValue = chunk.value;
    const baseLength = Math.min(chunk.length, baseTime.length, baseValue.length);
    if (baseLength <= 0) continue;

    const startTime = baseTime[0]!;
    const endTime = baseTime[baseLength - 1]!;
    if (endTime < visibleRange.from || startTime > visibleRange.to) continue;

    let time = baseTime;
    let value = baseValue;
    let length = baseLength;
    let from = lowerBound(time, length, visibleRange.from);
    let to = upperBound(time, length, visibleRange.to);
    if (from >= to) continue;

    const baseVisibleCount = to - from;
    if (chunk.lod) {
      const level = chunk.lod.pickLevel(baseVisibleCount, plotWidth);
      if (level && level.length > 0) {
        time = level.time;
        value = level.value;
        length = level.length;
        from = lowerBound(time, length, visibleRange.from);
        to = upperBound(time, length, visibleRange.to);
        if (from >= to) continue;
      }
    }

    const count = to - from;
    if (count <= 0) continue;
    visibleCount += count;
    resolvedChunks.push({ time, value, from, to });
  }

  if (resolvedChunks.length === 0) {
    return buildEmptyResult(input.pool);
  }

  const effectivePlotWidth = resolveConflationPlotWidth(plotWidth, visibleCount);
  if (effectivePlotWidth <= 0) {
    return buildEmptyResult(input.pool);
  }

  const pxPerMs = effectivePlotWidth / span;
  const baseColumn = Math.floor(visibleRange.from * pxPerMs);
  const estimated = Math.max(16, effectivePlotWidth * 5);
  const timeBuffer = input.pool.take(estimated);
  const valueBuffer = input.pool.take(estimated);
  const outTime: BufferBuilder = { buffer: timeBuffer, length: 0 };
  const outValue: BufferBuilder = { buffer: valueBuffer, length: 0 };

  let currentColumn = -1;
  let bucketHasPoint = false;
  let bucketHasValue = false;
  let firstTime = 0;
  let firstValue = 0;
  let lastTime = 0;
  let lastValue = 0;
  let minTime = 0;
  let minValue = 0;
  let maxTime = 0;
  let maxValue = 0;
  let firstNaNTime: number | null = null;
  let inGap = false;
  let resumeTime: number | null = null;

  const resetBucket = (): void => {
    bucketHasPoint = false;
    bucketHasValue = false;
    firstTime = 0;
    firstValue = 0;
    lastTime = 0;
    lastValue = 0;
    minTime = 0;
    minValue = 0;
    maxTime = 0;
    maxValue = 0;
    firstNaNTime = null;
    inGap = false;
    resumeTime = null;
  };

  const flushBucket = (): void => {
    if (!bucketHasPoint) return;
    if (!bucketHasValue) {
      if (firstNaNTime !== null) {
        pushValue(input.pool, outTime, firstNaNTime);
        pushValue(input.pool, outValue, Number.NaN);
      }
      resetBucket();
      return;
    }

    const entries: Array<{ time: number; value: number }> = [
      { time: firstTime, value: firstValue },
      { time: minTime, value: minValue },
      { time: maxTime, value: maxValue },
      { time: lastTime, value: lastValue },
    ];
    entries.sort((a, b) => a.time - b.time);

    let previousTime: number | null = null;
    let insertedGap = false;
    for (const entry of entries) {
      if (previousTime !== null && entry.time === previousTime) continue;
      if (resumeTime !== null && !insertedGap && entry.time >= resumeTime) {
        pushValue(input.pool, outTime, resumeTime);
        pushValue(input.pool, outValue, Number.NaN);
        insertedGap = true;
      }
      pushValue(input.pool, outTime, entry.time);
      pushValue(input.pool, outValue, entry.value);
      previousTime = entry.time;
    }
    if (!insertedGap && inGap && firstNaNTime !== null) {
      pushValue(input.pool, outTime, firstNaNTime);
      pushValue(input.pool, outValue, Number.NaN);
    }
    resetBucket();
  };

  const pushSample = (time: number, value: number): void => {
    bucketHasPoint = true;
    if (!isFiniteValue(value)) {
      if (firstNaNTime === null) firstNaNTime = time;
      if (bucketHasValue) inGap = true;
      return;
    }

    if (!bucketHasValue) {
      bucketHasValue = true;
      firstTime = time;
      firstValue = value;
      lastTime = time;
      lastValue = value;
      minTime = time;
      minValue = value;
      maxTime = time;
      maxValue = value;
    } else {
      lastTime = time;
      lastValue = value;
      if (value < minValue) {
        minTime = time;
        minValue = value;
      }
      if (value > maxValue) {
        maxTime = time;
        maxValue = value;
      }
    }

    if (inGap && resumeTime === null) {
      resumeTime = time;
    }
    inGap = false;
  };

  for (const chunk of resolvedChunks) {
    const { time, value, from, to } = chunk;
    for (let i = from; i < to; i += 1) {
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

      pushSample(t, value[i]!);
    }
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
