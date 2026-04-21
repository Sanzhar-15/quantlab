/**
 * Relative Strength Index (RSI) indicator.
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class RSIIndicator implements IndicatorComputation {
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

    // Calculate price changes
    const changes: number[] = [];
    for (let i = Math.max(1, startIdx); i <= endIdx; i++) {
      const change = data.close[i]! - data.close[i - 1]!;
      changes.push(change);
    }

    // Calculate initial average gain and loss
    let avgGain = 0;
    let avgLoss = 0;
    let gainCount = 0;
    let lossCount = 0;

    const initialStart = Math.max(startIdx, period);
    for (let i = Math.max(1, startIdx); i < initialStart; i++) {
      const change = data.close[i]! - data.close[i - 1]!;
      if (change > 0) {
        avgGain += change;
        gainCount++;
      } else if (change < 0) {
        avgLoss += Math.abs(change);
        lossCount++;
      }
    }

    if (gainCount > 0) avgGain /= gainCount;
    if (lossCount > 0) avgLoss /= lossCount;

    // Compute RSI using Wilder's smoothing
    for (let i = initialStart; i <= endIdx; i++) {
      const change = data.close[i]! - data.close[i - 1]!;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      if (i === initialStart) {
        // Initial average
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      } else {
        // Wilder's smoothing
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }

      if (avgLoss === 0) {
        values[i - startIdx] = 100;
      } else {
        const rs = avgGain / avgLoss;
        values[i - startIdx] = 100 - (100 / (1 + rs));
      }
    }

    // Fill invalid values with NaN
    for (let i = startIdx; i < initialStart; i++) {
      values[i - startIdx] = NaN;
    }

    const validFrom = startIdx + period;

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        value: values,
      },
      validFrom,
      revision: (state?.outputs.get('value') ? state.outputs.get('value')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(params: Record<string, any>): number {
    return (params.period as number) + 1;
  }
}

