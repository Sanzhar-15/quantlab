/**
 * Utility functions for indicator computation.
 */

import type { IndicatorResult, IndicatorState } from '../types';

/**
 * Create indicator state from result.
 */
export function createIndicatorState(
  instanceId: string,
  result: IndicatorResult,
): IndicatorState {
  const outputs = new Map<string, Float32Array>();
  for (const [key, value] of Object.entries(result.outputs)) {
    outputs.set(key, value);
  }

  return {
    instanceId,
    lastComputedIdx: result.startIdx + result.length - 1,
    intermediateState: new ArrayBuffer(0), // Placeholder
    outputs,
  };
}

/**
 * Merge indicator results (for incremental updates).
 */
export function mergeIndicatorResults(
  existing: IndicatorResult,
  newResult: IndicatorResult,
): IndicatorResult {
  // Combine outputs
  const mergedOutputs: { [key: string]: Float32Array } = {};

  for (const key of Object.keys(existing.outputs)) {
    const existingArray = existing.outputs[key]!;
    const newArray = newResult.outputs[key];

    if (newArray) {
      // Merge arrays (new data overwrites old data in overlapping range)
      const merged = new Float32Array(
        Math.max(existing.startIdx + existing.length, newResult.startIdx + newResult.length) -
        Math.min(existing.startIdx, newResult.startIdx),
      );
      merged.fill(NaN);

      // Copy existing data
      const existingOffset = Math.max(0, existing.startIdx - Math.min(existing.startIdx, newResult.startIdx));
      merged.set(existingArray, existingOffset);

      // Overwrite with new data
      const newOffset = Math.max(0, newResult.startIdx - Math.min(existing.startIdx, newResult.startIdx));
      merged.set(newArray, newOffset);

      mergedOutputs[key] = merged;
    } else {
      mergedOutputs[key] = existingArray;
    }
  }

  // Add any new output fields
  for (const [key, value] of Object.entries(newResult.outputs)) {
    if (!mergedOutputs[key]) {
      mergedOutputs[key] = value;
    }
  }

  return {
    instanceId: newResult.instanceId,
    seriesId: newResult.seriesId,
    startIdx: Math.min(existing.startIdx, newResult.startIdx),
    length: Math.max(existing.startIdx + existing.length, newResult.startIdx + newResult.length) -
      Math.min(existing.startIdx, newResult.startIdx),
    outputs: mergedOutputs,
    validFrom: Math.min(existing.validFrom, newResult.validFrom),
    revision: newResult.revision,
  };
}

