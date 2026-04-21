/**
 * Delta Charting Engine: Unified Tick System
 * 
 * Core type definitions for the unified tick generation system.
 * Grid lines, axis labels, and crosshair snapping all consume the same Tick[] array.
 */

/**
 * Represents a single tick mark in data space with its screen position.
 * 
 * This is the fundamental unit shared by:
 * - Grid renderer (draws lines at tick.px)
 * - Axis renderer (draws labels at tick.px with tick.label)
 * - Crosshair snapping (snaps to nearest tick.value)
 */
export interface Tick {
  /** Data value (price or timestamp) */
  value: number;
  
  /** Screen position in pixels (already transformed) */
  px: number;
  
  /** Tick classification */
  kind: 'major' | 'minor' | 'edge';
  
  /** Formatted label text (only for major/edge ticks) */
  label?: string;
}

/**
 * Hysteresis configuration for preventing jitter during zoom.
 * 
 * Instead of a single target spacing, uses a band [minPx, maxPx].
 * Current step is kept as long as spacing stays within band.
 */
export interface HysteresisConfig {
  /** Ideal spacing between major ticks (e.g., 80px) */
  targetPx: number;
  
  /** Minimum acceptable spacing (e.g., 50px) */
  minPx: number;
  
  /** Maximum acceptable spacing (e.g., 120px) */
  maxPx: number;
}

/**
 * State maintained by tick generator for hysteresis.
 */
export interface TickGeneratorState {
  /** Previously used major step (cached for hysteresis) */
  majorStep: number | null;
}

/**
 * Result from a step provider function.
 */
export interface StepProviderResult {
  /** Major step size in data units */
  majorStep: number;
  
  /** Optional minor step size in data units */
  minorStep?: number;
  
  /** Optional formatter for tick labels */
  formatter?: (value: number) => string;
}

/**
 * Configuration for tick generation.
 */
export interface TickGeneratorConfig {
  // Hysteresis settings for major ticks
  targetMajorPx: number;
  minMajorPx: number;
  maxMajorPx: number;
  
  // Minor grid settings
  showMinors: boolean;
  minMinorPx: number;  // Don't show minors if spacing < this
  
  // Financial settings
  tickSize: number;    // Instrument minimum tick (0 = none)
  useFinancialNice: boolean;
  
  // Edge ticks (TradingView's ensureEdgeTickMarksVisible feature)
  showEdgeTicks: boolean;
  
  /**
   * Custom step provider for non-linear data (e.g., time intervals).
   * If provided, overrides the default nice numbers algorithm.
   * 
   * @param range - { min, max } of visible data range
   * @param targetCount - Desired number of ticks
   * @returns Step configuration with major/minor steps and optional formatter
   */
  stepProvider?: (range: { min: number; max: number }, targetCount: number) => StepProviderResult;
}

/**
 * Default hysteresis configuration for price axis.
 */
export const DEFAULT_PRICE_HYSTERESIS: HysteresisConfig = {
  targetPx: 80,
  minPx: 50,
  maxPx: 120,
};

/**
 * Default hysteresis configuration for time axis.
 */
export const DEFAULT_TIME_HYSTERESIS: HysteresisConfig = {
  targetPx: 100,
  minPx: 60,
  maxPx: 150,
};

/**
 * Default tick generator configuration.
 */
export const DEFAULT_TICK_CONFIG: TickGeneratorConfig = {
  targetMajorPx: 80,
  minMajorPx: 50,
  maxMajorPx: 120,
  showMinors: true,
  minMinorPx: 12,
  tickSize: 0,
  useFinancialNice: true,
  showEdgeTicks: false,
};

