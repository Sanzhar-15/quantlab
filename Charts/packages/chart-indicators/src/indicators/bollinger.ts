/**
 * Bollinger Bands Indicator
 * 
 * Middle Band = SMA(close, period)
 * Upper Band = Middle Band + (stdDev * standard deviation)
 * Lower Band = Middle Band - (stdDev * standard deviation)
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class BollingerIndicator implements IndicatorComputation {
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
    const period = (params.period as number) ?? 20;
    const stdDevMult = (params.stdDev as number) ?? 2;

    const { close } = data;
    const length = endIdx - startIdx + 1;

    const upper = new Float32Array(length);
    const middle = new Float32Array(length);
    const lower = new Float32Array(length);

    for (let i = startIdx; i <= endIdx; i++) {
      const idx = i - startIdx;

      if (i >= period - 1) {
        // Calculate SMA
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) {
          sum += close[j]!;
        }
        const sma = sum / period;

        // Calculate standard deviation
        let squaredDiffSum = 0;
        for (let j = i - period + 1; j <= i; j++) {
          squaredDiffSum += Math.pow(close[j]! - sma, 2);
        }
        const variance = squaredDiffSum / period;
        const std = Math.sqrt(variance);

        middle[idx] = sma;
        upper[idx] = sma + stdDevMult * std;
        lower[idx] = sma - stdDevMult * std;
      } else {
        // Not enough data yet
        middle[idx] = NaN;
        upper[idx] = NaN;
        lower[idx] = NaN;
      }
    }

    const validFrom = startIdx + period - 1;

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        upper,
        middle,
        lower,
      },
      validFrom: Math.max(startIdx, validFrom),
      revision: (state?.outputs.get('middle') ? state.outputs.get('middle')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(params: Record<string, any>): number {
    return (params.period as number) ?? 20;
  }
}

