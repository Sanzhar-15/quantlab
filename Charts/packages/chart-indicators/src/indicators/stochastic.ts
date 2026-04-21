/**
 * Stochastic Oscillator Indicator
 * 
 * %K = (Close - Lowest Low) / (Highest High - Lowest Low) × 100
 * %K (smoothed) = SMA(%K, smoothK)
 * %D = SMA(%K, dPeriod)
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class StochasticIndicator implements IndicatorComputation {
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
    const kPeriod = (params.kPeriod as number) ?? 14;
    const dPeriod = (params.dPeriod as number) ?? 3;
    const smoothK = (params.smoothK as number) ?? 3;

    const { high, low, close } = data;
    const length = endIdx - startIdx + 1;

    const kLine = new Float32Array(length);
    const dLine = new Float32Array(length);

    const rawKValues: number[] = [];
    const smoothedKValues: number[] = [];

    for (let i = startIdx; i <= endIdx; i++) {
      const idx = i - startIdx;

      if (i >= kPeriod - 1) {
        // Find highest high and lowest low in period
        let highestHigh = high![i]!;
        let lowestLow = low![i]!;
        for (let j = i - kPeriod + 1; j <= i; j++) {
          if (high![j]! > highestHigh) highestHigh = high![j]!;
          if (low![j]! < lowestLow) lowestLow = low![j]!;
        }

        // Raw %K
        const rawK =
          highestHigh === lowestLow
            ? 50
            : ((close[i]! - lowestLow) / (highestHigh - lowestLow)) * 100;

        rawKValues.push(rawK);

        // Smooth %K
        if (rawKValues.length >= smoothK) {
          const kSum = rawKValues.slice(-smoothK).reduce((a, b) => a + b, 0);
          const k = kSum / smoothK;
          kLine[idx] = k;

          smoothedKValues.push(k);

          // %D (SMA of smoothed %K)
          if (smoothedKValues.length >= dPeriod) {
            const dSum = smoothedKValues.slice(-dPeriod).reduce((a, b) => a + b, 0);
            const d = dSum / dPeriod;
            dLine[idx] = d;
          } else {
            dLine[idx] = NaN;
          }
        } else {
          kLine[idx] = NaN;
          dLine[idx] = NaN;
        }
      } else {
        // Not enough data
        kLine[idx] = NaN;
        dLine[idx] = NaN;
      }
    }

    const validFrom = startIdx + kPeriod + smoothK + dPeriod - 3;

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        k: kLine,
        d: dLine,
      },
      validFrom: Math.max(startIdx, validFrom),
      revision: (state?.outputs.get('k') ? state.outputs.get('k')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(params: Record<string, any>): number {
    const kPeriod = (params.kPeriod as number) ?? 14;
    const dPeriod = (params.dPeriod as number) ?? 3;
    const smoothK = (params.smoothK as number) ?? 3;
    return kPeriod + smoothK + dPeriod;
  }
}

