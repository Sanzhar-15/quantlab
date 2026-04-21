/**
 * WASM computation interface (optional optimization).
 */

import type { IndicatorResult, IndicatorState } from '../types';

/**
 * CPU-WASM computation interface.
 */
export interface CPUWASMComputeInterface {
  /**
   * Check if WASM is available.
   */
  isAvailable(): boolean;

  /**
   * Execute WASM computation for an indicator.
   */
  compute(
    indicatorId: string,
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
  ): Promise<IndicatorResult>;
}

/**
 * CPU-WASM computation implementation (placeholder).
 * For MVP, this falls back to CPU-JS.
 */
export class CPUWASMCompute implements CPUWASMComputeInterface {
  private available = false;

  public constructor() {
    // Check WASM availability
    this.available = typeof WebAssembly !== 'undefined';
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public async compute(
    indicatorId: string,
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
  ): Promise<IndicatorResult> {
    // For MVP, fallback to CPU-JS
    // TODO: Implement actual WASM computation
    throw new Error('WASM computation not yet implemented, use CPU-JS fallback');
  }
}

