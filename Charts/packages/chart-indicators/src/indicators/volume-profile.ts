/**
 * Volume Profile Indicator
 * 
 * Displays volume distribution across price levels.
 * Identifies Point of Control (POC) and Value Area (VAH/VAL).
 */

import type { IndicatorComputation, IndicatorResult, IndicatorState } from './base';
import { createIndicatorState } from './utils';

export interface VolumeProfileBin {
  price: number;
  volume: number;
}

export interface VolumeProfileData {
  bins: VolumeProfileBin[];
  poc: number;           // Point of Control (price with highest volume)
  vah: number;           // Value Area High
  val: number;           // Value Area Low
  totalVolume: number;
}

export class VolumeProfileIndicator implements IndicatorComputation {
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
    const numBins = (params.numBins as number) ?? 24;
    const valueAreaPercent = (params.valueAreaPercent as number) ?? 70;

    const { high, low, close, volume } = data;
    const length = endIdx - startIdx + 1;

    // Find price range
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (let i = startIdx; i <= endIdx; i++) {
      const h = high?.[i] ?? close[i]!;
      const l = low?.[i] ?? close[i]!;
      if (h > maxPrice) maxPrice = h;
      if (l < minPrice) minPrice = l;
    }

    // Create bins
    const binSize = (maxPrice - minPrice) / numBins;
    const bins: number[] = new Array(numBins).fill(0);

    // Distribute volume into bins
    let totalVolume = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      const h = high?.[i] ?? close[i]!;
      const l = low?.[i] ?? close[i]!;
      const vol = volume?.[i] ?? 1;

      // Distribute volume across bins that this bar touches
      const lowBin = Math.floor((l - minPrice) / binSize);
      const highBin = Math.floor((h - minPrice) / binSize);

      const touchedBins = highBin - lowBin + 1;
      const volPerBin = vol / touchedBins;

      for (let bin = lowBin; bin <= highBin && bin < numBins; bin++) {
        if (bin >= 0 && bin < bins.length) {
          bins[bin] = (bins[bin] ?? 0) + volPerBin;
        }
      }

      totalVolume += vol;
    }

    // Find POC (bin with highest volume)
    let pocBin = 0;
    let maxVol = bins[0] ?? 0;
    for (let i = 1; i < numBins; i++) {
      const vol = bins[i] ?? 0;
      if (vol > maxVol) {
        maxVol = vol;
        pocBin = i;
      }
    }

    const poc = minPrice + (pocBin + 0.5) * binSize;

    // Calculate Value Area (70% of volume around POC)
    const valueAreaVolume = totalVolume * (valueAreaPercent / 100);
    let accumulatedVolume = bins[pocBin] ?? 0;
    let lowBin = pocBin;
    let highBin = pocBin;

    while (accumulatedVolume < valueAreaVolume && (lowBin > 0 || highBin < numBins - 1)) {
      const volBelow = lowBin > 0 ? (bins[lowBin - 1] ?? 0) : 0;
      const volAbove = highBin < numBins - 1 ? (bins[highBin + 1] ?? 0) : 0;

      if (volBelow > volAbove) {
        lowBin--;
        accumulatedVolume += bins[lowBin] ?? 0;
      } else {
        highBin++;
        accumulatedVolume += bins[highBin] ?? 0;
      }
    }

    const vah = minPrice + (highBin + 1) * binSize;
    const val = minPrice + lowBin * binSize;

    // Output arrays (one value per bar, but constant across the range)
    const pocArray = new Float32Array(length).fill(poc);
    const vahArray = new Float32Array(length).fill(vah);
    const valArray = new Float32Array(length).fill(val);

    // Volume profile bins as a single array (for rendering)
    const profileArray = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) {
      profileArray[i] = bins[i] ?? 0;
    }

    const result: IndicatorResult = {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        poc: pocArray,
        vah: vahArray,
        val: valArray,
        profile: profileArray,
      },
      validFrom: startIdx,
      revision: (state?.outputs.get('poc') ? state.outputs.get('poc')!.length : 0) + 1,
    };

    const newState = createIndicatorState(state?.instanceId || '', result);

    return { result, newState };
  }

  public getLookbackBars(): number {
    return 0; // Volume profile uses all data in range
  }
}

