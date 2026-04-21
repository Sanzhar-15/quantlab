/**
 * Exponential Moving Average (EMA) indicator.
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class EMAIndicator implements IndicatorComputation {
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
    const multiplier = 2 / (period + 1);
    const length = endIdx - startIdx + 1;
    const values = new Float32Array(length);

    // For incremental update, use previous EMA value from state
    let ema: number | null = null;

    if (state && state.lastComputedIdx >= startIdx - 1) {
      // Get last EMA value from state
      const lastOutput = state.outputs.get('value');
      if (lastOutput && state.lastComputedIdx >= 0) {
        const lastIdx = state.lastComputedIdx - (state.lastComputedIdx >= startIdx ? startIdx : 0);
        if (lastIdx >= 0 && lastIdx < lastOutput.length) {
          ema = lastOutput[lastIdx]!;
        }
      }
    }

    // If no previous EMA, initialize with SMA
    if (ema === null || !Number.isFinite(ema)) {
      let sum = 0;
      let count = 0;
      for (let i = Math.max(0, startIdx - period + 1); i < startIdx; i++) {
        const value = data.close[i]!;
        if (Number.isFinite(value)) {
          sum += value;
          count++;
        }
      }
      if (count > 0) {
        ema = sum / count;
      }
    }

    // Compute EMA
    for (let i = startIdx; i <= endIdx; i++) {
      const value = data.close[i]!;
      if (!Number.isFinite(value)) {
        values[i - startIdx] = NaN;
        continue;
      }

      if (ema === null || !Number.isFinite(ema)) {
        // Initialize with first value
        ema = value;
      } else {
        // EMA formula: EMA = (Close - EMA_prev) * multiplier + EMA_prev
        ema = (value - ema) * multiplier + ema;
      }

      values[i - startIdx] = ema;
    }

    const validFrom = startIdx;

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
    // Store last EMA value in intermediate state for next incremental update
    if (ema !== null && Number.isFinite(ema)) {
      const emaBuffer = new Float32Array([ema]);
      newState.intermediateState = emaBuffer.buffer;
    }

    return { result, newState };
  }

  public getLookbackBars(params: Record<string, any>): number {
    return (params.period as number) * 3; // EMA needs more lookback for warmup
  }
}

