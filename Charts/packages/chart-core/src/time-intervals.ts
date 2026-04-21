/**
 * Delta Charting Engine: Time Interval Definitions
 * 
 * Provides calendar-aware time intervals for time axis tick generation.
 * Supports major and minor ticks (e.g., hourly ticks with 15-minute minors).
 */

import type { StepProviderResult } from './tick-types';

/**
 * Represents a time interval with major and minor step sizes.
 */
export interface TimeInterval {
  /** Major step in milliseconds */
  stepMs: number;
  
  /** Minor step in milliseconds (optional) */
  minorStepMs?: number;
  
  /** Interval classification */
  kind: 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
  
  /** Human-readable label */
  label: string;
}

// Time constants
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS; // Approximate
const YEAR_MS = 365 * DAY_MS; // Approximate

/**
 * Standard time intervals with major and minor tick configurations.
 * Ordered from smallest to largest for optimal selection algorithm.
 */
export const TIME_INTERVALS: TimeInterval[] = [
  // Milliseconds (for very short timeframes)
  { stepMs: 100, minorStepMs: 20, kind: 'millisecond', label: '100ms' },
  { stepMs: 250, minorStepMs: 50, kind: 'millisecond', label: '250ms' },
  { stepMs: 500, minorStepMs: 100, kind: 'millisecond', label: '500ms' },
  
  // Seconds
  { stepMs: 1 * SECOND_MS, minorStepMs: 200, kind: 'second', label: '1s' },
  { stepMs: 2 * SECOND_MS, minorStepMs: 500, kind: 'second', label: '2s' },
  { stepMs: 5 * SECOND_MS, minorStepMs: 1 * SECOND_MS, kind: 'second', label: '5s' },
  { stepMs: 10 * SECOND_MS, minorStepMs: 2 * SECOND_MS, kind: 'second', label: '10s' },
  { stepMs: 15 * SECOND_MS, minorStepMs: 5 * SECOND_MS, kind: 'second', label: '15s' },
  { stepMs: 30 * SECOND_MS, minorStepMs: 10 * SECOND_MS, kind: 'second', label: '30s' },
  
  // Minutes
  { stepMs: 1 * MINUTE_MS, minorStepMs: 15 * SECOND_MS, kind: 'minute', label: '1m' },
  { stepMs: 2 * MINUTE_MS, minorStepMs: 30 * SECOND_MS, kind: 'minute', label: '2m' },
  { stepMs: 5 * MINUTE_MS, minorStepMs: 1 * MINUTE_MS, kind: 'minute', label: '5m' },
  { stepMs: 10 * MINUTE_MS, minorStepMs: 2 * MINUTE_MS, kind: 'minute', label: '10m' },
  { stepMs: 15 * MINUTE_MS, minorStepMs: 5 * MINUTE_MS, kind: 'minute', label: '15m' },
  { stepMs: 30 * MINUTE_MS, minorStepMs: 10 * MINUTE_MS, kind: 'minute', label: '30m' },
  
  // Hours
  { stepMs: 1 * HOUR_MS, minorStepMs: 15 * MINUTE_MS, kind: 'hour', label: '1h' },
  { stepMs: 2 * HOUR_MS, minorStepMs: 30 * MINUTE_MS, kind: 'hour', label: '2h' },
  { stepMs: 3 * HOUR_MS, minorStepMs: 1 * HOUR_MS, kind: 'hour', label: '3h' },
  { stepMs: 4 * HOUR_MS, minorStepMs: 1 * HOUR_MS, kind: 'hour', label: '4h' },
  { stepMs: 6 * HOUR_MS, minorStepMs: 2 * HOUR_MS, kind: 'hour', label: '6h' },
  { stepMs: 12 * HOUR_MS, minorStepMs: 3 * HOUR_MS, kind: 'hour', label: '12h' },
  
  // Days
  { stepMs: 1 * DAY_MS, minorStepMs: 6 * HOUR_MS, kind: 'day', label: '1d' },
  { stepMs: 2 * DAY_MS, minorStepMs: 12 * HOUR_MS, kind: 'day', label: '2d' },
  { stepMs: 3 * DAY_MS, minorStepMs: 1 * DAY_MS, kind: 'day', label: '3d' },
  { stepMs: 5 * DAY_MS, minorStepMs: 1 * DAY_MS, kind: 'day', label: '5d' },
  { stepMs: 7 * DAY_MS, minorStepMs: 1 * DAY_MS, kind: 'week', label: '1w' },
  { stepMs: 14 * DAY_MS, minorStepMs: 7 * DAY_MS, kind: 'week', label: '2w' },
  
  // Months (approximate - will be aligned to calendar months)
  { stepMs: 1 * MONTH_MS, minorStepMs: 7 * DAY_MS, kind: 'month', label: '1mo' },
  { stepMs: 2 * MONTH_MS, minorStepMs: 14 * DAY_MS, kind: 'month', label: '2mo' },
  { stepMs: 3 * MONTH_MS, minorStepMs: 1 * MONTH_MS, kind: 'month', label: '3mo' },
  { stepMs: 6 * MONTH_MS, minorStepMs: 1 * MONTH_MS, kind: 'month', label: '6mo' },
  
  // Years
  { stepMs: 1 * YEAR_MS, minorStepMs: 3 * MONTH_MS, kind: 'year', label: '1y' },
  { stepMs: 2 * YEAR_MS, minorStepMs: 6 * MONTH_MS, kind: 'year', label: '2y' },
  { stepMs: 5 * YEAR_MS, minorStepMs: 1 * YEAR_MS, kind: 'year', label: '5y' },
  { stepMs: 10 * YEAR_MS, minorStepMs: 2 * YEAR_MS, kind: 'year', label: '10y' },
];

/**
 * Creates a step provider function for time-based axes.
 * 
 * This provider selects optimal time intervals based on the visible range
 * and desired tick count, ensuring readable time markers.
 * 
 * @returns A step provider function compatible with TickGenerator
 */
export function createTimeStepProvider(): (
  range: { min: number; max: number },
  targetCount: number
) => StepProviderResult {
  return (range, targetCount) => {
    const spanMs = range.max - range.min;
    
    if (!Number.isFinite(spanMs) || spanMs <= 0 || targetCount <= 0) {
      return {
        majorStep: DAY_MS,
        minorStep: 6 * HOUR_MS,
      };
    }
    
    // Calculate ideal step size
    const targetStepMs = spanMs / Math.max(2, targetCount);
    
    // Find the best matching interval
    let bestInterval = TIME_INTERVALS[TIME_INTERVALS.length - 1]!;
    
    for (const interval of TIME_INTERVALS) {
      if (interval.stepMs >= targetStepMs) {
        bestInterval = interval;
        break;
      }
    }
    
    return {
      majorStep: bestInterval.stepMs,
      minorStep: bestInterval.minorStepMs ?? bestInterval.stepMs / 4,
    };
  };
}

/**
 * Formats a timestamp for display on the time axis.
 * 
 * Uses context-aware formatting:
 * - Sub-second: HH:MM:SS.mmm
 * - Second: HH:MM:SS
 * - Minute: HH:MM
 * - Hour: HH:MM
 * - Day: MMM DD
 * - Month: MMM YYYY
 * - Year: YYYY
 * 
 * @param timeMs - Timestamp in milliseconds
 * @param stepMs - Current major step size (used to determine format precision)
 * @returns Formatted time string
 */
export function formatTimeLabel(timeMs: number, stepMs: number): string {
  if (!Number.isFinite(timeMs)) return '';
  
  const date = new Date(timeMs);
  
  // Sub-second precision
  if (stepMs < SECOND_MS) {
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const seconds = date.getUTCSeconds().toString().padStart(2, '0');
    const ms = date.getUTCMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
  }
  
  // Second precision
  if (stepMs < MINUTE_MS) {
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    const seconds = date.getUTCSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }
  
  // Minute/Hour precision
  if (stepMs < DAY_MS) {
    const hours = date.getUTCHours().toString().padStart(2, '0');
    const minutes = date.getUTCMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  
  // Day precision
  if (stepMs < MONTH_MS) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getUTCMonth()];
    const day = date.getUTCDate();
    return `${month} ${day}`;
  }
  
  // Month precision
  if (stepMs < YEAR_MS) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getUTCMonth()];
    const year = date.getUTCFullYear();
    return `${month} ${year}`;
  }
  
  // Year precision
  return date.getUTCFullYear().toString();
}

