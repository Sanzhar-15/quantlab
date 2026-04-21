/**
 * ATR (Average True Range) Indicator
 * 
 * True Range = max(high - low, abs(high - prevClose), abs(low - prevClose))
 * ATR = Wilder's smoothed average of True Range
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class ATRIndicator implements IndicatorComputation {
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
    const period = (params.period as number) ?? 14;
    const { high, low, close } = data;
    const length = endIdx - startIdx + 1;

    const atrValues = new Float32Array(length);

    let atr = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const idx = i - startIdx;

      if (i === 0) {
        // First bar: TR = high - low
        atrValues[idx] = high![i]! - low![i]!;
        atr = atrValues[idx];
      } else if (i < period) {
        // Accumulating initial ATR
        const tr = Math.max(
          high![i]! - low![i]!,
          Math.abs(high![i]! - close[i - 1]!),
          Math.abs(low![i]! - close[i - 1]!)
        );
        atr = ((atr * (i - 1)) + tr) / i;
        atrValues[idx] = atr;
      } else {
        // Wilder's smoothing
        const tr = Math.max(
          high![i]! - low![i]!,
          Math.abs(high![i]! - close[i - 1]!),
          Math.abs(low![i]! - close[i - 1]!)
        );
        atr = (atr * (period - 1) + tr) / period;
        atrValues[idx] = atr;
      }
    }

    const validFrom = startIdx + period - 1;

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        atr: atrValues,
      },
      validFrom: Math.max(startIdx, validFrom),
      revision: (state?.outputs.get('atr') ? state.outputs.get('atr')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(params: Record<string, any>): number {
    return (params.period as number) ?? 14;
  }
}

