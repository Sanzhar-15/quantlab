import type { DataPoint, VisibleTimeRange } from './api';

export type OutOfOrderPolicy = 'reject' | 'drop';
export type DuplicatePolicy = 'reject' | 'replace' | 'ignore';
export type NonFinitePolicy = 'allow' | 'gap';

export type DataChunk = {
  time: Float64Array;
  value: Float64Array;
  length: number;
};

export type DataProviderUpdate =
  | { type: 'append'; point: DataPoint }
  | { type: 'appendBatch'; points: DataPoint[] }
  | { type: 'updateLast'; point: DataPoint }
  | { type: 'reset'; chunk: DataChunk; range: VisibleTimeRange };

export type DataProvider = {
  getRange: (range: VisibleTimeRange, options?: { paddingMs?: number }) => Promise<DataChunk>;
  subscribe?: (cb: (update: DataProviderUpdate) => void) => () => void;
  getExtents?: () => Promise<VisibleTimeRange | null>;
};

export type DataProviderOptions = {
  prefetchMs?: number;
  maxPendingUpdates?: number;
  backpressure?: 'drop' | 'coalesce';
  outOfOrder?: OutOfOrderPolicy;
  duplicates?: DuplicatePolicy;
  nonFinite?: NonFinitePolicy;
  chunkSize?: number;
  maxChunks?: number;
  maxBytes?: number;
};
