/**
 * MACD (Moving Average Convergence Divergence) Indicator
 * 
 * MACD Line = Fast EMA - Slow EMA
 * Signal Line = EMA of MACD Line
 * Histogram = MACD Line - Signal Line
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class MACDIndicator implements IndicatorComputation {
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
    const fastPeriod = (params.fastPeriod as number) ?? 12;
    const slowPeriod = (params.slowPeriod as number) ?? 26;
    const signalPeriod = (params.signalPeriod as number) ?? 9;

    const { close } = data;
    const length = endIdx - startIdx + 1;

    const macdLine = new Float32Array(length);
    const signalLine = new Float32Array(length);
    const histogram = new Float32Array(length);

    // EMA multipliers
    const fastMult = 2 / (fastPeriod + 1);
    const slowMult = 2 / (slowPeriod + 1);
    const signalMult = 2 / (signalPeriod + 1);

    // Initialize EMAs
    let fastEMA = close[startIdx]!;
    let slowEMA = close[startIdx]!;
    let signalEMA = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const price = close[i]!;
      if (!Number.isFinite(price)) {
        const idx = i - startIdx;
        macdLine[idx] = NaN;
        signalLine[idx] = NaN;
        histogram[idx] = NaN;
        continue;
      }

      // Calculate EMAs
      fastEMA = (price - fastEMA) * fastMult + fastEMA;
      slowEMA = (price - slowEMA) * slowMult + slowEMA;

      // MACD line
      const macd = fastEMA - slowEMA;
      const idx = i - startIdx;
      macdLine[idx] = macd;

      // Signal line (EMA of MACD)
      if (i === startIdx) {
        signalEMA = macd;
      } else {
        signalEMA = (macd - signalEMA) * signalMult + signalEMA;
      }
      signalLine[idx] = signalEMA;

      // Histogram
      histogram[idx] = macd - signalEMA;
    }

    const validFrom = startIdx + slowPeriod + signalPeriod - 1;

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        macd: macdLine,
        signal: signalLine,
        histogram,
      },
      validFrom: Math.max(startIdx, validFrom),
      revision: (state?.outputs.get('macd') ? state.outputs.get('macd')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(params: Record<string, any>): number {
    const slowPeriod = (params.slowPeriod as number) ?? 26;
    const signalPeriod = (params.signalPeriod as number) ?? 9;
    return slowPeriod + signalPeriod;
  }
}

