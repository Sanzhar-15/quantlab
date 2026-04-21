import type { AxisId, ChunkStats, PriceScaleMode, VisibleTimeRange } from '@charts-plus/chart-core';
import {
  ChunkedDataStore,
  DataStore,
  OhlcDataStore,
  applyPriceScaleMode,
  lowerBound,
  upperBound,
} from '@charts-plus/chart-core';

export type AxisScaleChunk = {
  time: Float64Array;
  value: Float64Array;
  length: number;
  startTime: number;
  endTime: number;
  stats: ChunkStats;
};

export type AxisScaleSource = {
  axis: AxisId;
  visible: boolean;
  data: DataStore | ChunkedDataStore;
  ohlc?: {
    data: OhlcDataStore;
    bucketSize?: number;
    buckets?: AxisBucketStats[];
  };
  lodChunks?: AxisScaleChunk[];
  bucketSize?: number;
  buckets?: AxisBucketStats[];
  baseValue?: number | null;
};

export type AxisScaleRange = {
  min: number;
  max: number;
  minPositive: number;
  hasData: boolean;
};

export type AxisBucketStats = {
  min: number;
  max: number;
  minPositive: number;
  hasData: boolean;
};

export type ScaleMargins = {
  top?: number;
  bottom?: number;
};

const clampMargin = (value: number): number => Math.min(0.95, Math.max(0, value));

export const applyAxisMargins = (
  range: AxisScaleRange,
  margins: ScaleMargins | undefined,
  axisType: 'linear' | 'log',
): AxisScaleRange => {
  if (!range.hasData) return range;
  if (!margins) return range;
  const top = Number.isFinite(margins.top) ? clampMargin(margins.top ?? 0) : 0;
  const bottom = Number.isFinite(margins.bottom) ? clampMargin(margins.bottom ?? 0) : 0;
  if (top <= 0 && bottom <= 0) return range;
  if (top + bottom >= 1) return range;

  let { min, max, minPositive } = range;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return range;

  if (axisType === 'log' && min > 0 && max > 0) {
    const logMin = Math.log10(min);
    const logMax = Math.log10(max);
    const span = logMax - logMin;
    if (!Number.isFinite(span) || span <= 0) return range;
    const totalSpan = span / (1 - top - bottom);
    const paddedMin = Math.pow(10, logMin - totalSpan * bottom);
    const paddedMax = Math.pow(10, logMax + totalSpan * top);
    if (!Number.isFinite(paddedMin) || !Number.isFinite(paddedMax) || paddedMax <= paddedMin) {
      return range;
    }
    min = paddedMin;
    max = paddedMax;
    if (Number.isFinite(minPositive) && minPositive > 0) {
      minPositive = Math.min(minPositive, min);
    } else {
      minPositive = min;
    }
    return { min, max, minPositive, hasData: true };
  }

  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return range;
  const totalSpan = span / (1 - top - bottom);
  const paddedMin = min - totalSpan * bottom;
  const paddedMax = max + totalSpan * top;
  if (!Number.isFinite(paddedMin) || !Number.isFinite(paddedMax) || paddedMax <= paddedMin) {
    return range;
  }
  min = paddedMin;
  max = paddedMax;
  if (!Number.isFinite(minPositive) || minPositive <= 0) {
    minPositive = min > 0 ? min : 1;
  }
  return { min, max, minPositive, hasData: true };
};

export const applyAxisPadding = (
  range: AxisScaleRange,
  padRatio: number | undefined,
  axisType: 'linear' | 'log',
): AxisScaleRange => {
  if (!range.hasData) return range;
  if (!Number.isFinite(padRatio)) return range;
  const ratio = Math.min(0.5, Math.max(0, padRatio ?? 0));
  if (ratio <= 0) return range;

  let { min, max, minPositive } = range;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return range;

  if (axisType === 'log' && min > 0 && max > 0) {
    const logMin = Math.log10(min);
    const logMax = Math.log10(max);
    const span = logMax - logMin;
    if (Number.isFinite(span) && span > 0) {
      const pad = span * ratio;
      const paddedMin = Math.pow(10, logMin - pad);
      const paddedMax = Math.pow(10, logMax + pad);
      if (Number.isFinite(paddedMin) && Number.isFinite(paddedMax) && paddedMax > paddedMin) {
        min = paddedMin;
        max = paddedMax;
        if (Number.isFinite(minPositive) && minPositive > 0) {
          minPositive = Math.min(minPositive, min);
        } else {
          minPositive = min;
        }
        return { min, max, minPositive, hasData: true };
      }
    }
  }

  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return range;
  const pad = span * ratio;
  if (!Number.isFinite(pad) || pad <= 0) return range;
  const paddedMin = min - pad;
  const paddedMax = max + pad;
  if (!Number.isFinite(paddedMin) || !Number.isFinite(paddedMax) || paddedMax <= paddedMin) {
    return range;
  }
  min = paddedMin;
  max = paddedMax;
  if (!Number.isFinite(minPositive) || minPositive <= 0) {
    minPositive = min > 0 ? min : 1;
  }
  return { min, max, minPositive, hasData: true };
};

const isChunked = (data: DataStore | ChunkedDataStore): data is ChunkedDataStore =>
  data instanceof ChunkedDataStore;

export const computeAxisRange = (
  seriesList: AxisScaleSource[],
  range: VisibleTimeRange,
  axis: AxisId,
  mode: PriceScaleMode = 'normal',
): AxisScaleRange => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let minPositive = Number.POSITIVE_INFINITY;
  let hasData = false;

  const applyValue = (value: number, baseValue: number | null): void => {
    if (!Number.isFinite(value)) return;
    const nextValue = mode === 'normal' ? value : applyPriceScaleMode(value, mode, baseValue);
    if (!Number.isFinite(nextValue)) return;
    if (nextValue < min) min = nextValue;
    if (nextValue > max) max = nextValue;
    if (nextValue > 0 && nextValue < minPositive) minPositive = nextValue;
    hasData = true;
  };

  const applyStats = (stats: AxisBucketStats, baseValue: number | null): void => {
    if (!stats.hasData) return;
    if (mode === 'normal') {
      if (Number.isFinite(stats.min)) min = Math.min(min, stats.min);
      if (Number.isFinite(stats.max)) max = Math.max(max, stats.max);
      if (Number.isFinite(stats.minPositive) && stats.minPositive > 0) {
        minPositive = Math.min(minPositive, stats.minPositive);
      }
      hasData = true;
      return;
    }
    const minValue = applyPriceScaleMode(stats.min, mode, baseValue);
    const maxValue = applyPriceScaleMode(stats.max, mode, baseValue);
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return;
    const nextMin = Math.min(minValue, maxValue);
    const nextMax = Math.max(minValue, maxValue);
    if (Number.isFinite(nextMin)) min = Math.min(min, nextMin);
    if (Number.isFinite(nextMax)) max = Math.max(max, nextMax);
    if (nextMin > 0) minPositive = Math.min(minPositive, nextMin);
    if (nextMax > 0) minPositive = Math.min(minPositive, nextMax);
    hasData = true;
  };

  const applyOhlcPoint = (
    o: number,
    h: number,
    l: number,
    c: number,
    baseValue: number | null,
  ): void => {
    applyValue(o, baseValue);
    applyValue(h, baseValue);
    applyValue(l, baseValue);
    applyValue(c, baseValue);
  };

  const applyChunks = (chunks: AxisScaleChunk[], baseValue: number | null): void => {
    if (chunks.length === 0) return;
    let first = -1;
    let last = -1;
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      if (chunk.endTime < range.from || chunk.startTime > range.to) continue;
      if (first === -1) first = i;
      last = i;
    }
    if (first < 0 || last < 0) return;

    for (let i = first; i <= last; i += 1) {
      const chunk = chunks[i]!;
      if (i !== first && i !== last) {
        if (chunk.stats.count > 0 && Number.isFinite(chunk.stats.min) && Number.isFinite(chunk.stats.max)) {
          min = Math.min(min, chunk.stats.min);
          max = Math.max(max, chunk.stats.max);
          if (Number.isFinite(chunk.stats.minPositive) && chunk.stats.minPositive > 0) {
            minPositive = Math.min(minPositive, chunk.stats.minPositive);
          }
          hasData = true;
        }
        continue;
      }

      const from = lowerBound(chunk.time, chunk.length, range.from);
      const to = upperBound(chunk.time, chunk.length, range.to);
      for (let j = from; j < to; j += 1) {
        applyValue(chunk.value[j]!, baseValue);
      }
    }
  };

  for (const series of seriesList) {
    if (!series.visible || series.axis !== axis) continue;
    const baseValue = mode === 'normal' ? null : series.baseValue ?? null;

    if (series.ohlc && series.ohlc.data.length > 0) {
      const store = series.ohlc.data;
      const open = store.opens();
      const high = store.highs();
      const low = store.lows();
      const close = store.closes();
      const from = store.lowerBound(range.from);
      const to = store.upperBound(range.to);
      if (from < to && series.ohlc.bucketSize && series.ohlc.buckets && series.ohlc.buckets.length > 0) {
        const bucketSize = series.ohlc.bucketSize;
        const endIndex = Math.min(store.length, to) - 1;
        if (endIndex >= 0 && bucketSize > 0) {
          const startBucket = Math.floor(from / bucketSize);
          const endBucket = Math.floor(endIndex / bucketSize);
          if (series.ohlc.buckets.length > endBucket) {
            if (startBucket + 1 <= endBucket - 1) {
              const leftEnd = Math.min(to, (startBucket + 1) * bucketSize);
              for (let i = from; i < leftEnd; i += 1) {
                applyOhlcPoint(open[i]!, high[i]!, low[i]!, close[i]!, baseValue);
              }
              const rightStart = Math.max(from, endBucket * bucketSize);
              for (let i = rightStart; i < to; i += 1) {
                applyOhlcPoint(open[i]!, high[i]!, low[i]!, close[i]!, baseValue);
              }
              for (let bucketIndex = startBucket + 1; bucketIndex <= endBucket - 1; bucketIndex += 1) {
                const stats = series.ohlc.buckets[bucketIndex];
                if (stats) {
                  applyStats(stats, baseValue);
                } else {
                  const start = bucketIndex * bucketSize;
                  const end = Math.min(store.length, start + bucketSize);
                  for (let i = start; i < end; i += 1) {
                    applyOhlcPoint(open[i]!, high[i]!, low[i]!, close[i]!, baseValue);
                  }
                }
              }
              continue;
            }
          }
        }
      }
      for (let i = from; i < to; i += 1) {
        applyOhlcPoint(open[i]!, high[i]!, low[i]!, close[i]!, baseValue);
      }
      continue;
    }

    if (!isChunked(series.data)) {
      if (series.data.length === 0) continue;
      const values = series.data.values();
      const from = series.data.lowerBound(range.from);
      const to = series.data.upperBound(range.to);
      if (from < to && series.bucketSize && series.buckets && series.buckets.length > 0) {
        const bucketSize = series.bucketSize;
        const endIndex = Math.min(series.data.length, to) - 1;
        if (endIndex >= 0 && bucketSize > 0) {
          const startBucket = Math.floor(from / bucketSize);
          const endBucket = Math.floor(endIndex / bucketSize);
          if (series.buckets.length > endBucket) {
            if (startBucket + 1 <= endBucket - 1) {
              const leftEnd = Math.min(to, (startBucket + 1) * bucketSize);
              for (let i = from; i < leftEnd; i += 1) {
                applyValue(values[i]!, baseValue);
              }
              const rightStart = Math.max(from, endBucket * bucketSize);
              for (let i = rightStart; i < to; i += 1) {
                applyValue(values[i]!, baseValue);
              }
              for (let bucketIndex = startBucket + 1; bucketIndex <= endBucket - 1; bucketIndex += 1) {
                const stats = series.buckets[bucketIndex];
                if (stats) {
                  applyStats(stats, baseValue);
                } else {
                  const start = bucketIndex * bucketSize;
                  const end = Math.min(series.data.length, start + bucketSize);
                  for (let i = start; i < end; i += 1) {
                    applyValue(values[i]!, baseValue);
                  }
                }
              }
              continue;
            }
          }
        }
      }
      for (let i = from; i < to; i += 1) {
        applyValue(values[i]!, baseValue);
      }
      continue;
    }

    const chunks = series.data.getChunks();
    const lodChunks = series.lodChunks ?? [];
    if (chunks.length === 0 && lodChunks.length === 0) continue;
    applyChunks(chunks, baseValue);
    applyChunks(lodChunks, baseValue);
  }

  if (!hasData || !Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, minPositive: 1, hasData: false };
  }

  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.05);
    min -= pad;
    max += pad;
  }

  if (!Number.isFinite(minPositive) || minPositive <= 0) {
    minPositive = min > 0 ? min : 1;
  }

  return { min, max, minPositive, hasData: true };
};
