/**
 * Simple Moving Average (SMA) indicator.
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class SMAIndicator implements IndicatorComputation {
  public compute(
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
    const period = params.period as number;
    const length = endIdx - startIdx + 1;
    const values = new Float32Array(length);

    // For incremental update, we can optimize by maintaining a running sum
    // For now, use simple sliding window
    let sum = 0;
    let count = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const value = data.close[i]!;
      if (!Number.isFinite(value)) {
        values[i - startIdx] = NaN;
        continue;
      }

      // Add current value
      sum += value;
      count++;

      // Remove value that falls out of window
      if (i >= period) {
        const oldValue = data.close[i - period]!;
        if (Number.isFinite(oldValue)) {
          sum -= oldValue;
          count--;
        }
      }

      // Compute SMA
      if (count >= period) {
        values[i - startIdx] = sum / period;
      } else {
        values[i - startIdx] = NaN;
      }
    }

    const validFrom = startIdx + period - 1;

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        value: values,
      },
      validFrom: Math.max(startIdx, validFrom),
      revision: (state?.outputs.get('value') ? state.outputs.get('value')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(params: Record<string, any>): number {
    return params.period as number;
  }
}

