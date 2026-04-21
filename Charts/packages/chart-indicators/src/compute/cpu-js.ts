/**
 * CPU-JS computation interface (baseline implementation).
 */

import type { IndicatorResult, IndicatorState } from '../types';
import { getIndicatorComputation } from '../indicators';

/**
 * CPU-JS computation interface.
 */
export interface CPUJSComputeInterface {
  /**
   * Execute CPU-JS computation for an indicator.
   */
  compute(
    indicatorId: string,
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
  ): { result: IndicatorResult; newState: IndicatorState };
}

/**
 * CPU-JS computation implementation.
 */
export class CPUJSCompute implements CPUJSComputeInterface {
  public compute(
    indicatorId: string,
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
  ): { result: IndicatorResult; newState: IndicatorState } {
    const computation = getIndicatorComputation(indicatorId);
    if (!computation) {
      throw new Error(`No computation implementation for ${indicatorId}`);
    }

    return computation.compute(data, params, startIdx, endIdx, state);
  }
}

