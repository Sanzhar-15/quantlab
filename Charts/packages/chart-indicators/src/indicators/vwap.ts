/**
 * VWAP (Volume Weighted Average Price) Indicator
 * 
 * Typical Price = (High + Low + Close) / 3
 * VWAP = Cumulative(Typical Price × Volume) / Cumulative(Volume)
 * 
 * Resets at session boundaries (configurable).
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export class VWAPIndicator implements IndicatorComputation {
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
    const sessionReset = (params.sessionReset as boolean) ?? true;
    const { time, high, low, close, volume } = data;
    const length = endIdx - startIdx + 1;

    const vwapValues = new Float32Array(length);

    let cumulativeTPV = 0;
    let cumulativeVolume = 0;
    let sessionStart = getSessionStart(time[startIdx]!);

    for (let i = startIdx; i <= endIdx; i++) {
      // Check for session reset (e.g., new trading day)
      if (sessionReset && isNewSession(time[i]!, sessionStart)) {
        cumulativeTPV = 0;
        cumulativeVolume = 0;
        sessionStart = getSessionStart(time[i]!);
      }

      // Typical price = (High + Low + Close) / 3
      const typicalPrice = (high![i]! + low![i]! + close[i]!) / 3;

      // Cumulative values
      const vol = volume?.[i] ?? 1;
      cumulativeTPV += typicalPrice * vol;
      cumulativeVolume += vol;

      // VWAP
      vwapValues[i - startIdx] =
        cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice;
    }

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        vwap: vwapValues,
      },
      validFrom: startIdx,
      revision: (state?.outputs.get('vwap') ? state.outputs.get('vwap')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(): number {
    return 0; // Starts from session start
  }
}

// Helper functions
function getSessionStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function isNewSession(timestamp: number, lastSessionStart: number): boolean {
  return getSessionStart(timestamp) !== lastSessionStart;
}

