/**
 * Base indicator computation interface.
 */

import type { IndicatorResult, IndicatorState } from '../types';

// Re-export types for use by indicator implementations
export type { IndicatorResult, IndicatorState };

/**
 * Base indicator computation interface.
 */
export interface IndicatorComputation {
  /**
   * Compute indicator for a range of bars.
   * @param data Input data (OHLCV arrays)
   * @param params Indicator parameters
   * @param startIdx Start index (inclusive)
   * @param endIdx End index (inclusive)
   * @param state Previous state for incremental computation (null for full recompute)
   * @returns Computation result
   */
  compute(
    data: {
      time: Float64Array;
      open?: Float64Array;
      high?: Float64Array;
      low?: Float64Array;
      close: Float64Array;
      volume?: Float64Array;
    },
    params: Record<string, any>,
    startIdx: number,
    endIdx: number,
    state: IndicatorState | null,
  ): {
    result: IndicatorResult;
    newState: IndicatorState;
  };

  /**
   * Get lookback bars required for this indicator.
   */
  getLookbackBars(params: Record<string, any>): number;
}

