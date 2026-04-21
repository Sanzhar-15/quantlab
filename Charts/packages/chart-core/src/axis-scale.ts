/**
 * Delta Charting Engine: Axis Scale Interface
 * 
 * Common interface for all axis scales (price, time, numeric, etc.)
 * Ensures consistent behavior across different scale types.
 */

import type { Tick, TickGeneratorConfig } from './tick-types';

/**
 * Common interface for all axis scales.
 * 
 * This interface defines the contract that all scale types must follow,
 * ensuring they can be used interchangeably in the rendering pipeline.
 * 
 * Implementations:
 * - PriceScale: Vertical axis for price/value data
 * - TimeScale: Horizontal axis for timestamp data
 * - NumericScale: Generic numeric axis
 */
export interface IAxisScale {
  /**
   * Generate unified ticks for grid, axis labels, and crosshair.
   * 
   * Returns a complete Tick[] array with:
   * - Major ticks: Grid lines + axis labels
   * - Minor ticks: Subtle grid subdivisions
   * - Pre-snapped pixel positions
   * 
   * @param dataToPxFn - Converts data value to pixel position
   * @param config - Tick generation configuration (optional)
   * @returns Array of Tick objects with pre-snapped pixel positions
   */
  generateTicks(
    dataToPxFn: (value: number) => number,
    config?: Partial<TickGeneratorConfig>,
  ): Tick[];
  
  /**
   * Format a data value as a string for display.
   * 
   * @param value - Data value to format
   * @returns Formatted string suitable for axis labels
   */
  format(value: number): string;
}

