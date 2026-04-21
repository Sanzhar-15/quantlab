import type { DataPoint } from './api';
import { lowerBound, upperBound } from './binary-search';
import type { DataChunk, DuplicatePolicy, NonFinitePolicy, OutOfOrderPolicy } from './data-provider';

export type ChunkStats = {
  min: number;
  max: number;
  minPositive: number;
  mean: number;
  variance: number;
  count: number;
  gapCount: number;
};

type ChunkStatsState = {
  min: number;
  max: number;
  minPositive: number;
  mean: number;
  m2: number;
  count: number;
  gapCount: number;
};

type Chunk = {
  time: Float64Array;
  value: Float64Array;
  length: number;
  startTime: number;
  endTime: number;
  stats: ChunkStatsState;
  byteSize: number;
};

export type ChunkView = {
  time: Float64Array;
  value: Float64Array;
  length: number;
  startIndex: number;
  startTime: number;
  endTime: number;
  stats: ChunkStats;
};

export type ChunkedDataStoreOptions = {
  chunkSize?: number;
  maxChunks?: number;
  maxBytes?: number;
  outOfOrder?: OutOfOrderPolicy;
  duplicates?: DuplicatePolicy;
  nonFinite?: NonFinitePolicy;
  onEvict?: (chunk: ChunkView) => void;
};

const DEFAULT_CHUNK_SIZE = 4096;

const sanitizeValue = (value: number | null, nonFinite: NonFinitePolicy): number => {
  if (value === null) return Number.NaN;
  if (!Number.isFinite(value)) {
    return nonFinite === 'gap' ? Number.NaN : value;
  }
  return value;
};

const sanitizeNumeric = (value: number, nonFinite: NonFinitePolicy): number => {
  if (!Number.isFinite(value)) {
    return nonFinite === 'gap' ? Number.NaN : value;
  }
  return value;
};

const createStats = (): ChunkStatsState => ({
  min: Number.POSITIVE_INFINITY,
  max: Number.NEGATIVE_INFINITY,
  minPositive: Number.POSITIVE_INFINITY,
  mean: 0,
  m2: 0,
  count: 0,
  gapCount: 0,
});

const finalizeStats = (stats: ChunkStatsState): ChunkStats => {
  if (stats.count === 0) {
    return {
      min: Number.NaN,
      max: Number.NaN,
      minPositive: Number.NaN,
      mean: Number.NaN,
      variance: Number.NaN,
      count: 0,
      gapCount: stats.gapCount,
    };
  }
  return {
    min: stats.min,
    max: stats.max,
    minPositive: Number.isFinite(stats.minPositive) ? stats.minPositive : Number.NaN,
    mean: stats.mean,
    variance: stats.count > 1 ? stats.m2 / (stats.count - 1) : 0,
    count: stats.count,
    gapCount: stats.gapCount,
  };
};

const updateStats = (stats: ChunkStatsState, value: number): void => {
  if (Number.isNaN(value)) {
    stats.gapCount += 1;
    return;
  }
  stats.count += 1;
  if (stats.count === 1) {
    stats.min = value;
    stats.max = value;
    if (value > 0) stats.minPositive = value;
    stats.mean = value;
    stats.m2 = 0;
    return;
  }
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
  if (value > 0) stats.minPositive = Math.min(stats.minPositive, value);
  const delta = value - stats.mean;
  stats.mean += delta / stats.count;
  const delta2 = value - stats.mean;
  stats.m2 += delta * delta2;
};

const recomputeStats = (chunk: Chunk): void => {
  const next = createStats();
  for (let i = 0; i < chunk.length; i += 1) {
    updateStats(next, chunk.value[i]!);
  }
  chunk.stats = next;
};

const createChunk = (size: number): Chunk => {
  const time = new Float64Array(size);
  const value = new Float64Array(size);
  return {
    time,
    value,
    length: 0,
    startTime: Number.NaN,
    endTime: Number.NaN,
    stats: createStats(),
    byteSize: time.byteLength + value.byteLength,
  };
};

export class ChunkedDataStore {
  private readonly _chunkSize: number;
  private readonly _maxChunks: number | null;
  private readonly _maxBytes: number | null;
  private readonly _outOfOrder: OutOfOrderPolicy;
  private readonly _duplicates: DuplicatePolicy;
  private readonly _nonFinite: NonFinitePolicy;
  private readonly _onEvict: ((chunk: ChunkView) => void) | undefined;
  private _chunks: Chunk[] = [];
  private _chunkOffsets: number[] = [];
  private _offsetBase = 0;
  private _length = 0;
  private _lastTime = Number.NEGATIVE_INFINITY;
  private _bytesUsed = 0;
  private _version = 0;

  public constructor(options: ChunkedDataStoreOptions = {}) {
    this._chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
    this._maxChunks = options.maxChunks && options.maxChunks > 0 ? Math.floor(options.maxChunks) : null;
    const requestedBytes =
      typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? Math.floor(options.maxBytes)
        : null;
    const minBytesPerChunk = this._chunkSize * Float64Array.BYTES_PER_ELEMENT * 2;
    this._maxBytes = requestedBytes ? Math.max(requestedBytes, minBytesPerChunk) : null;
    this._outOfOrder = options.outOfOrder ?? 'reject';
    this._duplicates = options.duplicates ?? (this._outOfOrder === 'drop' ? 'ignore' : 'reject');
    this._nonFinite = options.nonFinite ?? 'allow';
    this._onEvict = options.onEvict;
  }

  public get length(): number {
    return this._length;
  }

  public get chunkCount(): number {
    return this._chunks.length;
  }

  public get bytesUsed(): number {
    return this._bytesUsed;
  }

  public get version(): number {
    return this._version;
  }

  public clear(): void {
    this._reset();
    this._markChanged();
  }

  public appendChunk(chunk: DataChunk): void {
    const length = Math.min(chunk.length, chunk.time.length, chunk.value.length);
    if (length <= 0) return;
    let last = this._lastTime;
    let appended = 0;
    let replaced = false;
    for (let i = 0; i < length; i += 1) {
      const t = chunk.time[i]!;
      if (t < last) {
        if (this._outOfOrder === 'drop') continue;
        throw new Error('ChunkedDataStore.appendChunk requires increasing time values.');
      }
      if (t === last) {
        if (this._duplicates === 'ignore') continue;
        if (this._duplicates === 'replace') {
          replaced = this._replaceLastValue(chunk.value[i]!) || replaced;
          continue;
        }
        throw new Error('ChunkedDataStore.appendChunk requires increasing time values.');
      }
      this._appendValue(t, sanitizeNumeric(chunk.value[i]!, this._nonFinite));
      last = t;
      appended += 1;
    }
    if (appended > 0 || replaced) {
      this._markChanged();
    }
  }

  public setData(points: DataPoint[]): void {
    this._reset();
    if (points.length === 0) {
      this._markChanged();
      return;
    }

    let prevTime = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      if (point.t < prevTime) {
        if (this._outOfOrder === 'drop') continue;
        throw new Error('ChunkedDataStore.setData requires strictly increasing time values.');
      }
      if (point.t === prevTime) {
        if (this._duplicates === 'ignore') continue;
        if (this._duplicates === 'replace') {
          this._replaceLastValue(point.v ?? Number.NaN);
          continue;
        }
        throw new Error('ChunkedDataStore.setData requires strictly increasing time values.');
      }
      this._appendValue(point.t, sanitizeValue(point.v, this._nonFinite));
      prevTime = point.t;
    }
    this._markChanged();
  }

  public append(point: DataPoint): void {
    if (this._length > 0 && point.t <= this._lastTime) {
      if (point.t < this._lastTime) {
        if (this._outOfOrder === 'drop') return;
        throw new Error('ChunkedDataStore.append requires time greater than the last value.');
      }
      if (this._duplicates === 'ignore') return;
      if (this._duplicates === 'replace') {
        const didReplace = this._replaceLastValue(point.v ?? Number.NaN);
        if (didReplace) this._markChanged();
        return;
      }
      throw new Error('ChunkedDataStore.append requires time greater than the last value.');
    }
    this._appendValue(point.t, sanitizeValue(point.v, this._nonFinite));
    this._markChanged();
  }

  public patchExisting(
    points: DataPoint[],
  ): { updated: number; minTime: number; maxTime: number; chunks: number[] } | null {
    if (points.length === 0 || this._length === 0) return null;
    let updated = 0;
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    const touched = new Set<number>();

    for (const point of points) {
      const index = this.lowerBound(point.t);
      if (index >= this._length) continue;
      const globalIndex = index + this._offsetBase;
      const chunkIndex = this._findChunkByOffset(globalIndex);
      if (chunkIndex < 0) continue;
      const chunk = this._chunks[chunkIndex];
      if (!chunk) continue;
      const localIndex = globalIndex - this._chunkOffsets[chunkIndex]!;
      if (localIndex < 0 || localIndex >= chunk.length) continue;
      if (chunk.time[localIndex] !== point.t) continue;
      const nextValue = sanitizeValue(point.v, this._nonFinite);
      if (Object.is(chunk.value[localIndex], nextValue)) continue;
      chunk.value[localIndex] = nextValue;
      updated += 1;
      minTime = Math.min(minTime, point.t);
      maxTime = Math.max(maxTime, point.t);
      touched.add(chunkIndex);
    }

    if (updated === 0) return null;
    for (const index of touched) {
      const chunk = this._chunks[index];
      if (chunk) recomputeStats(chunk);
    }
    this._markChanged();
    const chunks: number[] = [];
    for (const index of touched) {
      const chunk = this._chunks[index];
      if (chunk) chunks.push(chunk.startTime);
    }
    return { updated, minTime, maxTime, chunks };
  }

  public appendBatch(points: DataPoint[]): void {
    if (points.length === 0) return;
    let last = this._lastTime;
    let appended = 0;
    let replaced = false;
    for (const point of points) {
      if (point.t < last) {
        if (this._outOfOrder === 'drop') continue;
        throw new Error('ChunkedDataStore.appendBatch requires time greater than the last value.');
      }
      if (point.t === last) {
        if (this._duplicates === 'ignore') continue;
        if (this._duplicates === 'replace') {
          replaced = this._replaceLastValue(point.v ?? Number.NaN) || replaced;
          continue;
        }
        throw new Error('ChunkedDataStore.appendBatch requires time greater than the last value.');
      }
      this._appendValue(point.t, sanitizeValue(point.v, this._nonFinite));
      last = point.t;
      appended += 1;
    }
    if (appended > 0 || replaced) {
      this._markChanged();
    }
  }

  public updateLast(point: DataPoint): void {
    if (this._length === 0) {
      this.append(point);
      return;
    }

    if (point.t < this._lastTime) {
      if (this._outOfOrder === 'drop') return;
      throw new Error('ChunkedDataStore.updateLast requires time >= last value.');
    }

    if (point.t > this._lastTime) {
      this._appendValue(point.t, sanitizeValue(point.v, this._nonFinite));
      this._markChanged();
      return;
    }

    const lastChunk = this._chunks[this._chunks.length - 1];
    if (!lastChunk) return;
    const lastIndex = lastChunk.length - 1;
    if (lastIndex < 0) return;
    lastChunk.value[lastIndex] = sanitizeValue(point.v, this._nonFinite);
    recomputeStats(lastChunk);
    this._markChanged();
  }

  public lowerBound(time: number): number {
    if (this._length === 0) return 0;
    const chunkIndex = this._findChunkIndex(time, true);
    if (chunkIndex >= this._chunks.length) return this._length;
    const chunk = this._chunks[chunkIndex]!;
    const localIndex = lowerBound(chunk.time, chunk.length, time);
    return this._chunkOffsets[chunkIndex]! - this._offsetBase + localIndex;
  }

  public upperBound(time: number): number {
    if (this._length === 0) return 0;
    const chunkIndex = this._findChunkIndex(time, false);
    if (chunkIndex >= this._chunks.length) return this._length;
    const chunk = this._chunks[chunkIndex]!;
    const localIndex = upperBound(chunk.time, chunk.length, time);
    return this._chunkOffsets[chunkIndex]! - this._offsetBase + localIndex;
  }

  public getTimeAt(index: number): number | null {
    const chunk = this._getChunkByIndex(index);
    if (!chunk) return null;
    return chunk.time[chunk.localIndex] ?? null;
  }

  public getValueAt(index: number): number | null {
    const chunk = this._getChunkByIndex(index);
    if (!chunk) return null;
    return chunk.value[chunk.localIndex] ?? null;
  }

  public getChunk(index: number): ChunkView | null {
    const chunk = this._chunks[index];
    if (!chunk) return null;
    const startIndex = this._chunkOffsets[index]! - this._offsetBase;
    return {
      time: chunk.time.subarray(0, chunk.length),
      value: chunk.value.subarray(0, chunk.length),
      length: chunk.length,
      startIndex,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      stats: finalizeStats(chunk.stats),
    };
  }

  public getChunks(): ChunkView[] {
    return this._chunks.map((_, index) => this.getChunk(index)!);
  }

  public evictOutsideRange(range: { from: number; to: number }, paddingMs = 0): number {
    if (this._chunks.length === 0) return 0;
    const minTime = range.from - paddingMs;
    const maxTime = range.to + paddingMs;
    let removed = 0;

    while (this._chunks.length > 0 && this._chunks[0]!.endTime < minTime) {
      this._evictFirst();
      removed += 1;
    }

    while (this._chunks.length > 0 && this._chunks[this._chunks.length - 1]!.startTime > maxTime) {
      this._evictLast();
      removed += 1;
    }

    if (removed > 0) {
      this._syncLastTime();
      this._markChanged();
    }
    return removed;
  }

  private _appendValue(time: number, value: number): void {
    const chunk = this._getWritableChunk();
    chunk.time[chunk.length] = time;
    chunk.value[chunk.length] = value;
    if (chunk.length === 0) {
      chunk.startTime = time;
    }
    chunk.endTime = time;
    chunk.length += 1;
    updateStats(chunk.stats, value);
    this._length += 1;
    this._lastTime = time;
  }

  private _replaceLastValue(nextValue: number): boolean {
    const lastChunk = this._chunks[this._chunks.length - 1];
    if (!lastChunk) return false;
    const lastIndex = lastChunk.length - 1;
    if (lastIndex < 0) return false;
    const sanitized = sanitizeNumeric(nextValue, this._nonFinite);
    if (Object.is(lastChunk.value[lastIndex], sanitized)) return false;
    lastChunk.value[lastIndex] = sanitized;
    recomputeStats(lastChunk);
    return true;
  }

  private _getWritableChunk(): Chunk {
    const last = this._chunks[this._chunks.length - 1];
    if (last && last.length < this._chunkSize) {
      return last;
    }

    this._evictForIncoming(1);

    const chunk = createChunk(this._chunkSize);
    this._chunks.push(chunk);
    this._chunkOffsets.push(this._offsetBase + this._length);
    this._bytesUsed += chunk.byteSize;
    return chunk;
  }

  private _evictForIncoming(incomingChunks: number): void {
    const targetMaxChunks = this._maxChunks;
    const targetMaxBytes = this._maxBytes;
    const incomingBytes = incomingChunks * this._chunkSize * 16;
    if (!targetMaxChunks && !targetMaxBytes) return;

    while (
      (targetMaxChunks && this._chunks.length + incomingChunks > targetMaxChunks) ||
      (targetMaxBytes && this._bytesUsed + incomingBytes > targetMaxBytes)
    ) {
      this._evictFirst();
    }
    this._syncLastTime();
  }

  private _findChunkIndex(time: number, inclusive: boolean): number {
    let low = 0;
    let high = this._chunks.length - 1;
    let result = this._chunks.length;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const endTime = this._chunks[mid]!.endTime;
      if (inclusive ? endTime >= time : endTime > time) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return result;
  }

  private _findChunkByOffset(globalIndex: number): number {
    let low = 0;
    let high = this._chunkOffsets.length - 1;
    let result = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const offset = this._chunkOffsets[mid]!;
      if (offset <= globalIndex) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  }

  private _getChunkByIndex(index: number): { time: Float64Array; value: Float64Array; localIndex: number } | null {
    if (index < 0 || index >= this._length) return null;
    const globalIndex = index + this._offsetBase;
    const chunkIndex = this._findChunkByOffset(globalIndex);
    if (chunkIndex < 0) return null;
    const chunk = this._chunks[chunkIndex];
    if (!chunk) return null;
    const localIndex = globalIndex - this._chunkOffsets[chunkIndex]!;
    if (localIndex < 0 || localIndex >= chunk.length) return null;
    return { time: chunk.time, value: chunk.value, localIndex };
  }

  private _evictFirst(): void {
    const removed = this._chunks.shift();
    const removedOffset = this._chunkOffsets.shift();
    if (!removed || removedOffset === undefined) return;
    this._emitEviction(removed, removedOffset);
    this._offsetBase += removed.length;
    this._length -= removed.length;
    this._bytesUsed -= removed.byteSize;
  }

  private _evictLast(): void {
    const removed = this._chunks.pop();
    const removedOffset = this._chunkOffsets.pop();
    if (!removed || removedOffset === undefined) return;
    this._emitEviction(removed, removedOffset);
    this._length -= removed.length;
    this._bytesUsed -= removed.byteSize;
    this._syncLastTime();
  }

  private _emitEviction(chunk: Chunk, offset: number): void {
    if (!this._onEvict) return;
    const startIndex = offset - this._offsetBase;
    const view: ChunkView = {
      time: chunk.time.subarray(0, chunk.length),
      value: chunk.value.subarray(0, chunk.length),
      length: chunk.length,
      startIndex,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      stats: finalizeStats(chunk.stats),
    };
    this._onEvict(view);
  }

  private _syncLastTime(): void {
    if (this._chunks.length === 0) {
      this._lastTime = Number.NEGATIVE_INFINITY;
      return;
    }
    this._lastTime = this._chunks[this._chunks.length - 1]!.endTime;
  }

  private _reset(): void {
    this._chunks = [];
    this._chunkOffsets = [];
    this._offsetBase = 0;
    this._length = 0;
    this._lastTime = Number.NEGATIVE_INFINITY;
    this._bytesUsed = 0;
  }

  private _markChanged(): void {
    this._version += 1;
  }
}
