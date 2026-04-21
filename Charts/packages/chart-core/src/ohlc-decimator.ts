import type { VisibleTimeRange } from './api';
import { resolveConflationPlotWidth } from './decimation-utils';

export type OhlcDecimationRange = {
  from: number;
  to: number;
};

export type OhlcDecimationResult = {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
};

export type OhlcDecimationInput = {
  seriesId: string;
  visibleRange: VisibleTimeRange;
  visibleIndices: OhlcDecimationRange;
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  plotWidth: number;
  scaleType: 'linear' | 'log';
};

export type OhlcDecimatorOptions = {
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
  result: OhlcDecimationResult;
  timeBuffer: Float64Array;
  openBuffer: Float64Array;
  highBuffer: Float64Array;
  lowBuffer: Float64Array;
  closeBuffer: Float64Array;
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

class OhlcDecimatorCache {
  private readonly _entries = new Map<
    string,
    { result: OhlcDecimationResult; bytes: number; buffers: Float64Array[] }
  >();
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

  public get(key: CacheKey): OhlcDecimationResult | undefined {
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
        for (const buffer of existing.buffers) {
          this._pool.release(buffer);
        }
      }
      this._entries.delete(id);
    }
    const bytes =
      value.timeBuffer.byteLength +
      value.openBuffer.byteLength +
      value.highBuffer.byteLength +
      value.lowBuffer.byteLength +
      value.closeBuffer.byteLength;
    this._entries.set(id, {
      result: value.result,
      bytes,
      buffers: [
        value.timeBuffer,
        value.openBuffer,
        value.highBuffer,
        value.lowBuffer,
        value.closeBuffer,
      ],
    });
    this._bytesUsed += bytes;
    this._enforceLimits();
  }

  public clear(): void {
    for (const entry of this._entries.values()) {
      for (const buffer of entry.buffers) {
        this._pool.release(buffer);
      }
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
        for (const buffer of entry.buffers) {
          this._pool.release(buffer);
        }
      }
      this._entries.delete(oldestKey);
    }
  }
}

export class OhlcDecimator {
  private readonly _cache: OhlcDecimatorCache;
  private readonly _pool: Float64ArrayPool;

  public constructor(options: OhlcDecimatorOptions = {}) {
    this._pool = new Float64ArrayPool(Math.max(16, (options.maxEntries ?? 32) * 2));
    this._cache = new OhlcDecimatorCache(this._pool, options.maxEntries, options.maxBytes);
  }

  public decimate(input: OhlcDecimationInput): OhlcDecimationResult {
    const plotWidth = Math.max(0, Math.round(input.plotWidth));
    const cacheKey: CacheKey = {
      seriesId: input.seriesId,
      visibleRange: input.visibleRange,
      plotWidth,
      scaleType: input.scaleType,
    };
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;
    const result = decimateOhlc({
      ...input,
      plotWidth,
      pool: this._pool,
    });
    this._cache.set(cacheKey, result);
    return result.result;
  }

  public decimateTransient(
    input: OhlcDecimationInput,
  ): { result: OhlcDecimationResult; release: () => void } {
    const plotWidth = Math.max(0, Math.round(input.plotWidth));
    const pooled = decimateOhlc({
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
        this._pool.release(pooled.openBuffer);
        this._pool.release(pooled.highBuffer);
        this._pool.release(pooled.lowBuffer);
        this._pool.release(pooled.closeBuffer);
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

type OhlcBuilder = {
  time: BufferBuilder;
  open: BufferBuilder;
  high: BufferBuilder;
  low: BufferBuilder;
  close: BufferBuilder;
};

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
  const openBuffer = pool.take(1);
  const highBuffer = pool.take(1);
  const lowBuffer = pool.take(1);
  const closeBuffer = pool.take(1);
  return {
    result: {
      time: timeBuffer.subarray(0, 0),
      open: openBuffer.subarray(0, 0),
      high: highBuffer.subarray(0, 0),
      low: lowBuffer.subarray(0, 0),
      close: closeBuffer.subarray(0, 0),
    },
    timeBuffer,
    openBuffer,
    highBuffer,
    lowBuffer,
    closeBuffer,
  };
};

const isFiniteOhlc = (o: number, h: number, l: number, c: number): boolean =>
  Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c);

function decimateOhlc(
  input: OhlcDecimationInput & { plotWidth: number; pool: Float64ArrayPool },
): PooledDecimationResult {
  const { time, open, high, low, close, visibleIndices, visibleRange } = input;
  const length = Math.min(time.length, open.length, high.length, low.length, close.length);
  const fromIndex = Math.max(0, Math.min(length, visibleIndices.from));
  const toIndex = Math.max(fromIndex, Math.min(length, visibleIndices.to));

  if (input.plotWidth <= 0 || visibleRange.to <= visibleRange.from || fromIndex >= toIndex) {
    return buildEmptyResult(input.pool);
  }

  const plotWidth = input.plotWidth;
  const visibleCount = toIndex - fromIndex;
  const effectivePlotWidth = resolveConflationPlotWidth(plotWidth, visibleCount, 1.0);
  const span = visibleRange.to - visibleRange.from;
  const pxPerMs = effectivePlotWidth / span;
  const baseColumn = Math.floor(visibleRange.from * pxPerMs);

  const estimated = Math.max(16, Math.min(effectivePlotWidth * 2, visibleCount));
  const out: OhlcBuilder = {
    time: { buffer: input.pool.take(estimated), length: 0 },
    open: { buffer: input.pool.take(estimated), length: 0 },
    high: { buffer: input.pool.take(estimated), length: 0 },
    low: { buffer: input.pool.take(estimated), length: 0 },
    close: { buffer: input.pool.take(estimated), length: 0 },
  };

  let currentColumn = -1;
  let bucketHasPoint = false;
  let bucketHasValue = false;
  let bucketTime = Number.NaN;
  let bucketOpen = Number.NaN;
  let bucketHigh = Number.NaN;
  let bucketLow = Number.NaN;
  let bucketClose = Number.NaN;

  const resetBucket = (): void => {
    bucketHasPoint = false;
    bucketHasValue = false;
    bucketTime = Number.NaN;
    bucketOpen = Number.NaN;
    bucketHigh = Number.NaN;
    bucketLow = Number.NaN;
    bucketClose = Number.NaN;
  };

  const flushBucket = (): void => {
    if (!bucketHasPoint) return;
    if (!bucketHasValue) {
      pushValue(input.pool, out.time, bucketTime);
      pushValue(input.pool, out.open, Number.NaN);
      pushValue(input.pool, out.high, Number.NaN);
      pushValue(input.pool, out.low, Number.NaN);
      pushValue(input.pool, out.close, Number.NaN);
      resetBucket();
      return;
    }
    pushValue(input.pool, out.time, bucketTime);
    pushValue(input.pool, out.open, bucketOpen);
    pushValue(input.pool, out.high, bucketHigh);
    pushValue(input.pool, out.low, bucketLow);
    pushValue(input.pool, out.close, bucketClose);
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

    const o = open[i]!;
    const h = high[i]!;
    const l = low[i]!;
    const c = close[i]!;
    bucketHasPoint = true;
    if (!isFiniteOhlc(o, h, l, c)) {
      if (!Number.isFinite(bucketTime)) {
        bucketTime = t;
      }
      continue;
    }

    if (!bucketHasValue) {
      bucketTime = t;
      bucketOpen = o;
      bucketHigh = h;
      bucketLow = l;
      bucketClose = c;
      bucketHasValue = true;
    } else {
      if (h > bucketHigh) bucketHigh = h;
      if (l < bucketLow) bucketLow = l;
      bucketClose = c;
    }
  }

  flushBucket();

  return {
    result: {
      time: out.time.buffer.subarray(0, out.time.length),
      open: out.open.buffer.subarray(0, out.open.length),
      high: out.high.buffer.subarray(0, out.high.length),
      low: out.low.buffer.subarray(0, out.low.length),
      close: out.close.buffer.subarray(0, out.close.length),
    },
    timeBuffer: out.time.buffer,
    openBuffer: out.open.buffer,
    highBuffer: out.high.buffer,
    lowBuffer: out.low.buffer,
    closeBuffer: out.close.buffer,
  };
}
