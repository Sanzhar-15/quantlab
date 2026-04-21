import { clamp } from './index';
import { DataStore } from './data-store';
import type { HorizontalScale, VisibleRange } from './horizontal-scale';
import type { Tick, TickGeneratorConfig } from './tick-types';
import { TickGenerator } from './tick-generator';
import { createTimeStepProvider, formatTimeLabel } from './time-intervals';
import type { IAxisScale } from './axis-scale';
import type { DataExtent } from './scroll-bounds';
import { calculateScrollBounds, clampToBounds, MIN_VISIBLE_BARS } from './scroll-bounds';

const DEFAULT_TICK_COUNT = 6;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TICK_HYSTERESIS_RATIO = 0.2;
const ZOOM_WHEEL_STEP = 100;
const ZOOM_WHEEL_INTENSITY = Math.log(1.1) / ZOOM_WHEEL_STEP;

type TickStep = { kind: 'fixed'; stepMs: number; approxMs: number } | { kind: 'month'; stepMonths: number; approxMs: number };

const TICK_STEPS: TickStep[] = [
  { kind: 'fixed', stepMs: 1 * SECOND_MS, approxMs: 1 * SECOND_MS },
  { kind: 'fixed', stepMs: 2 * SECOND_MS, approxMs: 2 * SECOND_MS },
  { kind: 'fixed', stepMs: 5 * SECOND_MS, approxMs: 5 * SECOND_MS },
  { kind: 'fixed', stepMs: 10 * SECOND_MS, approxMs: 10 * SECOND_MS },
  { kind: 'fixed', stepMs: 15 * SECOND_MS, approxMs: 15 * SECOND_MS },
  { kind: 'fixed', stepMs: 30 * SECOND_MS, approxMs: 30 * SECOND_MS },
  { kind: 'fixed', stepMs: 1 * MINUTE_MS, approxMs: 1 * MINUTE_MS },
  { kind: 'fixed', stepMs: 2 * MINUTE_MS, approxMs: 2 * MINUTE_MS },
  { kind: 'fixed', stepMs: 5 * MINUTE_MS, approxMs: 5 * MINUTE_MS },
  { kind: 'fixed', stepMs: 10 * MINUTE_MS, approxMs: 10 * MINUTE_MS },
  { kind: 'fixed', stepMs: 15 * MINUTE_MS, approxMs: 15 * MINUTE_MS },
  { kind: 'fixed', stepMs: 30 * MINUTE_MS, approxMs: 30 * MINUTE_MS },
  { kind: 'fixed', stepMs: 1 * HOUR_MS, approxMs: 1 * HOUR_MS },
  { kind: 'fixed', stepMs: 2 * HOUR_MS, approxMs: 2 * HOUR_MS },
  { kind: 'fixed', stepMs: 4 * HOUR_MS, approxMs: 4 * HOUR_MS },
  { kind: 'fixed', stepMs: 6 * HOUR_MS, approxMs: 6 * HOUR_MS },
  { kind: 'fixed', stepMs: 12 * HOUR_MS, approxMs: 12 * HOUR_MS },
  { kind: 'fixed', stepMs: 1 * DAY_MS, approxMs: 1 * DAY_MS },
  { kind: 'fixed', stepMs: 2 * DAY_MS, approxMs: 2 * DAY_MS },
  { kind: 'fixed', stepMs: 3 * DAY_MS, approxMs: 3 * DAY_MS },
  { kind: 'fixed', stepMs: 5 * DAY_MS, approxMs: 5 * DAY_MS },
  { kind: 'fixed', stepMs: 7 * DAY_MS, approxMs: 7 * DAY_MS },
  { kind: 'fixed', stepMs: 14 * DAY_MS, approxMs: 14 * DAY_MS },
  { kind: 'month', stepMonths: 1, approxMs: 30 * DAY_MS },
  { kind: 'month', stepMonths: 2, approxMs: 60 * DAY_MS },
  { kind: 'month', stepMonths: 3, approxMs: 90 * DAY_MS },
  { kind: 'month', stepMonths: 6, approxMs: 180 * DAY_MS },
  { kind: 'month', stepMonths: 12, approxMs: 365 * DAY_MS },
  { kind: 'month', stepMonths: 24, approxMs: 730 * DAY_MS },
  { kind: 'month', stepMonths: 60, approxMs: 1825 * DAY_MS },
  { kind: 'month', stepMonths: 120, approxMs: 3650 * DAY_MS },
];

const pickTickStep = (spanMs: number, desiredCount: number): TickStep => {
  const target = spanMs / Math.max(1, desiredCount - 1);
  let selected = TICK_STEPS[TICK_STEPS.length - 1]!;
  for (const candidate of TICK_STEPS) {
    if (candidate.approxMs >= target) {
      selected = candidate;
      break;
    }
  }
  return selected;
};

const monthIndexFromTime = (timeMs: number): number => {
  const date = new Date(timeMs);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};

const timeFromMonthIndex = (index: number): number => {
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  return Date.UTC(year, month, 1, 0, 0, 0, 0);
};

const buildFixedTicks = (range: VisibleRange, stepMs: number): number[] => {
  if (!Number.isFinite(stepMs) || stepMs <= 0) return [];
  const start = Math.floor(range.from / stepMs) * stepMs;
  const end = Math.ceil(range.to / stepMs) * stepMs;
  const ticks: number[] = [];
  for (let t = start; t <= end + stepMs * 0.5; t += stepMs) {
    ticks.push(t);
  }
  return ticks;
};

const buildMonthTicks = (range: VisibleRange, stepMonths: number): number[] => {
  const ticks: number[] = [];
  if (!Number.isFinite(stepMonths) || stepMonths <= 0) return ticks;
  const fromIndex = monthIndexFromTime(range.from);
  const toIndex = monthIndexFromTime(range.to);
  const startIndex = Math.floor(fromIndex / stepMonths) * stepMonths;
  const endIndex = Math.ceil(toIndex / stepMonths) * stepMonths + stepMonths;
  const maxTicks = 10_000;
  for (let idx = startIndex; idx <= endIndex && ticks.length < maxTicks; idx += stepMonths) {
    ticks.push(timeFromMonthIndex(idx));
  }
  return ticks;
};

export type { VisibleRange } from './horizontal-scale';

export type TimeScaleOptions = {
  minRangeMs?: number;
  minVisibleBars?: number;
  maxRangeMs?: number;
  clampToData?: boolean;
  paddingMs?: number;
  elasticClamp?: boolean;
  elasticMaxRatio?: number;
  timeVisible?: boolean;
  secondsVisible?: boolean;
  barSpacing?: number;
  rightOffset?: number;
  fitContent?: boolean;
  fixLeftEdge?: boolean;
  fixRightEdge?: boolean;
  lockVisibleTimeRangeOnResize?: boolean;
  tickMarkFormatter?: (time: number) => string;
};

type ResolvedTimeScaleOptions = {
  minRangeMs: number;
  maxRangeMs: number;
  clampToData: boolean;
  paddingMs: number;
  elasticClamp: boolean;
  elasticMaxRatio: number;
  fixLeftEdge: boolean;
  fixRightEdge: boolean;
};

export class TimeScale implements HorizontalScale<TimeScaleOptions>, IAxisScale {
  private readonly _data: DataStore;
  private _plotWidth = 1;
  private _visible: VisibleRange;
  private _options: ResolvedTimeScaleOptions;
  private _elasticActive = false;
  private _lastTickStep: TickStep | null = null;
  private _tickGenerator: TickGenerator | null = null;
  // V7: Label format stability - track last format level and step for hysteresis
  private _lastFormatLevel: 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years' | null = null;
  private _lastFormatStepMs: number | null = null;
  private _barIntervalMs: number | null = null;

  public constructor(data: DataStore, initialRange: VisibleRange, options: TimeScaleOptions = {}) {
    this._data = data;
    this._visible = { ...initialRange };
    const elasticMaxRatio =
      typeof options.elasticMaxRatio === 'number' && Number.isFinite(options.elasticMaxRatio)
        ? clamp(options.elasticMaxRatio, 0, 0.5)
        : 0.12;
    this._options = {
      minRangeMs: options.minRangeMs ?? 1,
      maxRangeMs: options.maxRangeMs ?? 10 * 365 * 24 * 60 * 60 * 1000,
      clampToData: options.clampToData ?? true,
      paddingMs: options.paddingMs ?? 0,
      elasticClamp: options.elasticClamp ?? false,
      elasticMaxRatio,
      fixLeftEdge: options.fixLeftEdge ?? true,
      fixRightEdge: options.fixRightEdge ?? true,
    };
    this._clampRange();
  }

  public setPlotWidth(width: number): void {
    this._plotWidth = Math.max(1, Math.round(width));
  }

  public setVisibleRange(range: VisibleRange): void {
    this._visible = { ...range };
    this._clampRange();
  }

  public getVisibleRange(): VisibleRange {
    return { ...this._visible };
  }

  public setElasticActive(active: boolean): void {
    this._elasticActive = active;
    if (!active) {
      this._visible = this._clampRangeTo(this._visible, false);
    }
  }

  public setOptions(options: Partial<TimeScaleOptions>): void {
    const next = { ...this._options };
    if (typeof options.minRangeMs === 'number' && Number.isFinite(options.minRangeMs) && options.minRangeMs > 0) {
      next.minRangeMs = options.minRangeMs;
    }
    if (typeof options.maxRangeMs === 'number' && Number.isFinite(options.maxRangeMs) && options.maxRangeMs > 0) {
      next.maxRangeMs = options.maxRangeMs;
    }
    if (typeof options.paddingMs === 'number' && Number.isFinite(options.paddingMs)) {
      next.paddingMs = Math.max(0, options.paddingMs);
    }
    if (typeof options.clampToData === 'boolean') {
      next.clampToData = options.clampToData;
    }
    if (typeof options.elasticClamp === 'boolean') {
      next.elasticClamp = options.elasticClamp;
    }
    if (typeof options.elasticMaxRatio === 'number' && Number.isFinite(options.elasticMaxRatio)) {
      next.elasticMaxRatio = clamp(options.elasticMaxRatio, 0, 0.5);
    }
    if (typeof options.fixLeftEdge === 'boolean') {
      next.fixLeftEdge = options.fixLeftEdge;
    }
    if (typeof options.fixRightEdge === 'boolean') {
      next.fixRightEdge = options.fixRightEdge;
    }
    if (next.maxRangeMs < next.minRangeMs) {
      next.minRangeMs = next.maxRangeMs;
    }
    this._options = next;
    this._clampRange();
  }

  public setBarIntervalMs(interval: number | null): void {
    const next =
      typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : null;
    const current = this._barIntervalMs;
    const changed =
      (next === null) !== (current === null) ||
      (next !== null && current !== null && Math.abs(next - current) > 1e-6);
    if (!changed) return;
    this._barIntervalMs = next;
    this._lastFormatLevel = null;
    this._lastFormatStepMs = null;
  }

  public getClampedRange(range?: VisibleRange): VisibleRange {
    const target = range ?? this._visible;
    return this._clampRangeTo(target, false);
  }

  private _pickStableTickStep(spanMs: number, desiredCount: number): TickStep {
    const target = spanMs / Math.max(1, desiredCount - 1);
    const candidate = pickTickStep(spanMs, desiredCount);
    const current = this._lastTickStep;
    if (!current) {
      this._lastTickStep = candidate;
      return candidate;
    }
    if (
      current.kind === candidate.kind &&
      ('stepMs' in current ? current.stepMs : current.stepMonths) ===
        ('stepMs' in candidate ? candidate.stepMs : candidate.stepMonths)
    ) {
      return current;
    }
    const lower = current.approxMs * (1 - TICK_HYSTERESIS_RATIO);
    const upper = current.approxMs * (1 + TICK_HYSTERESIS_RATIO);
    if (target >= lower && target <= upper) {
      return current;
    }
    this._lastTickStep = candidate;
    return candidate;
  }

  public getTicksForRange(range: VisibleRange, desiredCount?: number): number[] {
    const safeRange =
      Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from
        ? range
        : this._visible;
    const count = Math.max(2, Math.floor(desiredCount ?? DEFAULT_TICK_COUNT));
    const span = safeRange.to - safeRange.from;
    if (!Number.isFinite(span) || span <= 0) {
      return [safeRange.from];
    }
    const step = this._pickStableTickStep(span, count);
    if (step.kind === 'fixed') {
      return buildFixedTicks(safeRange, step.stepMs);
    }
    return buildMonthTicks(safeRange, step.stepMonths);
  }

  public getTicks(desiredCount?: number): number[] {
    return this.getTicksForRange(this._visible, desiredCount);
  }

  /**
   * Generates unified ticks for grid, axis, and crosshair using TickGenerator.
   * 
   * This is the new unified tick generation system that provides:
   * - Major ticks with calendar-aware intervals (1s, 5s, 1m, 5m, 1h, 1d, etc.)
   * - Minor ticks for finer grid subdivisions
   * - Hysteresis to prevent jitter during zoom
   * 
   * @param timeToPxFn - Function to convert timestamp to pixel position
   * @param config - Tick generator configuration (optional)
   * @returns Array of Tick objects with pre-snapped pixel positions
   */
  public generateTicks(
    timeToPxFn: (time: number) => number,
    config?: Partial<TickGeneratorConfig>,
  ): Tick[] {
    // Initialize TickGenerator with time-aware step provider
    if (!this._tickGenerator) {
      this._tickGenerator = new TickGenerator({
        targetMajorPx: 100,
        minMajorPx: 60,
        maxMajorPx: 150,
        showMinors: true,
        minMinorPx: 20,
        tickSize: 0,
        useFinancialNice: false,
        showEdgeTicks: false,
        stepProvider: createTimeStepProvider(),
      });
    }
    
    // Apply runtime config overrides if provided
    if (config) {
      this._tickGenerator.setConfig(config);
    }
    
    // Use current visible range
    const range = this._visible;
    const span = range.to - range.from;
    
    if (!Number.isFinite(span) || span <= 0) {
      return [{
        value: range.from,
        px: timeToPxFn(range.from),
        kind: 'major',
        label: formatTimeLabel(range.from, DAY_MS),
      }];
    }
    
    // Generate ticks using TickGenerator
    // V7: Use instance method with hysteresis for format stability
    const ticks = this._tickGenerator.generate(
      range.from,
      range.to,
      this._plotWidth,
      timeToPxFn,
      (value, step) => {
        // Convert step (number) to TickStep format for _formatTimeLabel
        const tickStep: TickStep = step < 2592000000 // Less than 1 month
          ? { kind: 'fixed', stepMs: step, approxMs: step }
          : { kind: 'month', stepMonths: Math.floor(step / (30 * 24 * 60 * 60 * 1000)), approxMs: step };
        return this._formatTimeLabel(value, tickStep);
      },
    );
    
    return ticks;
  }

  /**
   * Formats a time label based on the current tick step.
   * 
   * Uses step-aware formatting with hysteresis (V7) to prevent flip-flopping:
   * - If step < 1 minute: show seconds (HH:MM:SS)
   * - If step < 1 hour: show time (HH:MM)
   * - If step < 1 day: show time (HH:MM)
   * - If step < 1 month: show date (MMM DD)
   * - If step >= 1 month: show month/year (MMM YYYY or YYYY)
   * 
   * V7: Format selection uses 15% hysteresis to prevent oscillation during zoom.
   */
  private _formatTimeLabel(time: number, step: TickStep | null): string {
    const date = new Date(time);
    
    if (!step) {
      // Fallback: show date and time
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    
    const stepMs = step.kind === 'fixed' ? step.stepMs : step.approxMs;
    
    // V8: Check actual data bar interval, not just tick step
    // If data is daily (bar interval >= 1 day), force date format regardless of tick step
    // This fixes the issue where daily data shows "11:00" instead of "MMM DD"
    const dataExtent = this.getDataExtent();
    const barInterval = dataExtent?.barInterval ?? null;
    const isDailyData = barInterval !== null && barInterval >= 86400000; // >= 1 day
    
    // V7: Determine format level with hysteresis to prevent flip-flopping during zoom
    // Thresholds: 60s, 1h, 1d, 1 month
    const LABEL_FORMAT_HYSTERESIS_RATIO = 0.15; // 15% hysteresis (per V7 spec)
    
    // Determine what format current step would give (without hysteresis)
    const getFormatLevelForStep = (stepMs: number): 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years' => {
      if (stepMs < 60000) return 'seconds';
      if (stepMs < 3600000) return 'minutes';
      if (stepMs < 86400000) return 'hours';
      if (stepMs < 2592000000) return 'days';
      if (step.kind === 'month' && step.stepMonths >= 12) return 'years';
      return 'months';
    };
    
    // V8: If daily data but tick step is < 1 day, force date format to match data granularity
    // This ensures daily data always shows dates, not times (e.g., "Jan 15" not "11:00")
    let effectiveFormatLevel = getFormatLevelForStep(stepMs);
    if (isDailyData && stepMs < 86400000) {
      // Daily data but tick step is < 1 day (e.g., 12h for 6 months view)
      // Force date format to match data granularity
      effectiveFormatLevel = 'days';
    }
    
    // V8: If we detect daily data and previously initialized with wrong format, force correction
    // This fixes the issue where initial page load shows wrong time format before data is fully loaded
    // Must happen BEFORE hysteresis logic to ensure correct format is applied immediately
    // This handles the case where format was initialized to 'hours' before data was available
    if (isDailyData && this._lastFormatLevel !== null && this._lastFormatLevel !== 'days' && stepMs < 86400000) {
      // Force correction: reset to days format immediately, bypassing hysteresis for this correction
      this._lastFormatLevel = 'days';
      this._lastFormatStepMs = stepMs;
      effectiveFormatLevel = 'days';
    }
    
    const currentFormatLevel = effectiveFormatLevel;
    
    // V7: Apply hysteresis to prevent format flip-flopping during zoom
    // Only change format when step crosses threshold by more than 15%
    if (this._lastFormatLevel !== null && this._lastFormatStepMs !== null) {
      // Use effectiveFormatLevel (which may have been corrected for daily data) for comparison
      if (effectiveFormatLevel === this._lastFormatLevel) {
        // Same format level - keep it, update step for next comparison
        this._lastFormatStepMs = stepMs;
      } else {
        // Different format level detected - check if change is significant enough
        // Find the threshold between last and current format levels
        const thresholds: Array<{ ms: number; level: typeof currentFormatLevel }> = [
          { ms: 60000, level: 'seconds' },
          { ms: 3600000, level: 'minutes' },
          { ms: 86400000, level: 'hours' },
          { ms: 2592000000, level: 'days' },
        ];
        
        // Get threshold for format transition (the boundary between levels)
        const getThresholdForTransition = (
          from: typeof currentFormatLevel,
          to: typeof currentFormatLevel
        ): number | null => {
          const levelOrder = ['seconds', 'minutes', 'hours', 'days', 'months', 'years'] as const;
          const fromIdx = levelOrder.indexOf(from);
          const toIdx = levelOrder.indexOf(to);
          
          if (fromIdx === -1 || toIdx === -1) return null;
          
          // Find threshold between from and to
          const lowerIdx = Math.min(fromIdx, toIdx);
          const upperIdx = Math.max(fromIdx, toIdx);
          
          if (upperIdx < thresholds.length) {
            return thresholds[upperIdx]?.ms ?? null;
          }
          
          // Months/years transition - use month threshold
          if (from === 'months' || to === 'months') {
            return 2592000000; // 1 month in ms
          }
          
          return null;
        };
        
        // Use effectiveFormatLevel (corrected for daily data) for transition check
        const transitionThreshold = getThresholdForTransition(this._lastFormatLevel, effectiveFormatLevel);
        
        if (transitionThreshold !== null) {
          // Apply hysteresis: only change if step crossed threshold by more than 15%
          const hysteresisLower = transitionThreshold * (1 - LABEL_FORMAT_HYSTERESIS_RATIO);
          const hysteresisUpper = transitionThreshold * (1 + LABEL_FORMAT_HYSTERESIS_RATIO);
          
          // Check if current step is outside hysteresis range (significant change)
          if (stepMs < hysteresisLower || stepMs > hysteresisUpper) {
            // Step crossed threshold significantly - update format
            // Use effectiveFormatLevel (corrected for daily data) instead of currentFormatLevel
            this._lastFormatLevel = effectiveFormatLevel;
            this._lastFormatStepMs = stepMs;
          }
          // Otherwise keep last format (hysteresis applied - prevents flip-flop)
        } else {
          // No threshold found (edge case) - update format conservatively
          // Use effectiveFormatLevel (corrected for daily data) instead of currentFormatLevel
          this._lastFormatLevel = effectiveFormatLevel;
          this._lastFormatStepMs = stepMs;
        }
      }
    } else {
      // First time - initialize format
      // Use effectiveFormatLevel (corrected for daily data) instead of currentFormatLevel
      this._lastFormatLevel = effectiveFormatLevel;
      this._lastFormatStepMs = stepMs;
    }
    
    // Use last format level (may be different from current if hysteresis applied)
    // But if we corrected for daily data, use effectiveFormatLevel directly
    const formatLevel = (isDailyData && stepMs < 86400000) ? effectiveFormatLevel : this._lastFormatLevel;
    
    // Format based on determined level
    switch (formatLevel) {
      case 'seconds':
        return date.toLocaleTimeString(undefined, { 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit' 
        });
      case 'minutes':
        return date.toLocaleTimeString(undefined, { 
          hour: '2-digit', 
          minute: '2-digit' 
        });
      case 'hours':
        return date.toLocaleTimeString(undefined, { 
          hour: '2-digit', 
          minute: '2-digit' 
        });
      case 'days':
        return date.toLocaleDateString(undefined, { 
          month: 'short', 
          day: 'numeric' 
        });
      case 'months':
        return date.toLocaleDateString(undefined, { 
          month: 'short', 
          year: 'numeric' 
        });
      case 'years':
        return date.toLocaleDateString(undefined, { year: 'numeric' });
      default:
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }

  /**
   * Format a timestamp for display (required by IAxisScale interface).
   * 
   * @param value - Timestamp in milliseconds
   * @returns Formatted time string
   */
  public format(value: number): string {
    // Use a reasonable default step for formatting
    return formatTimeLabel(value, HOUR_MS);
  }

  public timeToX(time: number): number {
    const span = this._visible.to - this._visible.from;
    if (span <= 0) return 0;
    
    // Calculate pixel position from time value.
    // Formula: (time - from) / span * width
    // Using intermediate variable for readability.
    const ratio = (time - this._visible.from) / span;
    return ratio * this._plotWidth;
  }

  public xToTime(x: number): number {
    const span = this._visible.to - this._visible.from;
    const clampedX = clamp(x, 0, this._plotWidth);
    return this._visible.from + (clampedX / this._plotWidth) * span;
  }

  public getVisibleIndices(): { from: number; to: number } {
    const fromTime = this._visible.from;
    const toTime = this._visible.to;
    const from = this._data.lowerBound(fromTime);
    const to = this._data.upperBound(toTime);
    return { from, to };
  }

  /**
   * Get data extent for scroll boundaries calculation (V7 Phase 4).
   */
  public getDataExtent(): DataExtent | null {
    if (this._data.length === 0) return null;
    
    const times = this._data.times();
    const firstBarTime = times[0]!;
    const lastBarTime = times[this._data.length - 1]!;
    
    // Calculate bar interval from override or first two bars
    let barInterval = this._barIntervalMs;
    if (!Number.isFinite(barInterval) || (barInterval ?? 0) <= 0) {
      barInterval = null;
    }
    if (barInterval === null && this._data.length >= 2) {
      const delta = times[1]! - times[0]!;
      if (Number.isFinite(delta) && delta > 0) {
        barInterval = delta;
      }
    }
    if (barInterval === null) {
      barInterval = 60000; // default 1 minute
    }
    
    return {
      firstBarTime,
      lastBarTime,
      barInterval,
    };
  }

  public panByPixels(deltaX: number): void {
    const span = this._visible.to - this._visible.from;
    if (span <= 0) return;
    
    // === KEEP EXISTING PAN LOGIC ===
    const deltaTime = (-deltaX / this._plotWidth) * span;
    const proposedFrom = this._visible.from + deltaTime;
    const proposedTo = this._visible.to + deltaTime;
    
    // === V7: Apply scroll boundaries ONLY during pan (not in clamp) ===
    if (this._options.clampToData && this._data.length > 0) {
      const extent = this.getDataExtent();
      if (extent) {
        const bounds = calculateScrollBounds(extent, span, MIN_VISIBLE_BARS);
        const result = clampToBounds(proposedFrom, proposedTo, bounds);
        this._visible = {
          from: result.from,
          to: result.to,
        };
        // Still call _clampRange for other constraints (min/max span, etc.)
        this._clampRange();
        return;
      }
    }
    
    // No boundaries or no data - use proposed values
    this._visible = {
      from: proposedFrom,
      to: proposedTo,
    };
    this._clampRange();
  }

  // V7: Right-edge zoom - anchor to right edge by default, cursor when Ctrl pressed
  public zoomByWheel(deltaY: number, anchorX: number, anchorToRightEdge: boolean = false): void {
    const span = this._visible.to - this._visible.from;
    if (span <= 0) return;

    const scale = Math.exp(deltaY * ZOOM_WHEEL_INTENSITY);
    const newSpan = clamp(span * scale, this._options.minRangeMs, this._options.maxRangeMs);

    // V7: Right-edge zoom - anchor to right edge by default, cursor when Ctrl pressed
    if (anchorToRightEdge) {
      // Anchor to right edge (default behavior)
      const rightEdge = this._visible.to;
      this._visible = {
        from: rightEdge - newSpan,
        to: rightEdge,
      };
    } else {
      // Anchor to cursor position (Ctrl pressed)
      const anchorTime = this.xToTime(anchorX);
      const leftPortion = (anchorTime - this._visible.from) / span;
      const rightPortion = 1 - leftPortion;

      this._visible = {
        from: anchorTime - newSpan * leftPortion,
        to: anchorTime + newSpan * rightPortion,
      };
    }
    this._clampRange();
  }

  // V7: Right-edge zoom - anchor to right edge by default, cursor when Ctrl pressed
  public zoomByScale(scale: number, anchorX: number, anchorToRightEdge: boolean = false): void {
    const span = this._visible.to - this._visible.from;
    if (span <= 0 || !Number.isFinite(scale) || scale <= 0 || scale === 1) return;

    const newSpan = clamp(span / scale, this._options.minRangeMs, this._options.maxRangeMs);

    // V7: Right-edge zoom - anchor to right edge by default, cursor when Ctrl pressed
    if (anchorToRightEdge) {
      // Anchor to right edge (default behavior)
      const rightEdge = this._visible.to;
      this._visible = {
        from: rightEdge - newSpan,
        to: rightEdge,
      };
    } else {
      // Anchor to cursor position (Ctrl pressed)
      const anchorTime = this.xToTime(anchorX);
      const leftPortion = (anchorTime - this._visible.from) / span;
      const rightPortion = 1 - leftPortion;

      this._visible = {
        from: anchorTime - newSpan * leftPortion,
        to: anchorTime + newSpan * rightPortion,
      };
    }
    this._clampRange();
  }

  private _clampRange(): void {
    this._visible = this._clampRangeTo(this._visible, this._elasticActive);
  }

  private _clampRangeTo(range: VisibleRange, allowElastic: boolean): VisibleRange {
    let from = range.from;
    let to = range.to;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      const fallback = this._fallbackRange();
      from = fallback.from;
      to = fallback.to;
    }

    let span = to - from;
    const clampedSpan = clamp(span, this._options.minRangeMs, this._options.maxRangeMs);
    if (clampedSpan !== span) {
      const mid = (from + to) * 0.5;
      span = clampedSpan;
      from = mid - span * 0.5;
      to = mid + span * 0.5;
    }

    // Traditional clamping (V7: boundaries are applied in pan handler, not here)
    if (this._options.clampToData && this._data.length > 0) {
      const times = this._data.times();
      const minTime = times[0]!;
      const maxTime = times[this._data.length - 1]!;
      const pad = this._options.paddingMs;
      const minAllowed = minTime - pad;
      const maxAllowed = maxTime + pad;
      const maxSpan = maxAllowed - minAllowed;
      const elasticEnabled = allowElastic && this._options.elasticClamp;
      const clampLeft = this._options.fixLeftEdge;
      const clampRight = this._options.fixRightEdge;
      const limit = elasticEnabled ? maxSpan * this._options.elasticMaxRatio : 0;

      if (Number.isFinite(maxSpan) && maxSpan > 0) {
        if (!elasticEnabled || limit <= 0) {
          if (span > maxSpan) {
            const mid = (from + to) * 0.5;
            span = maxSpan;
            from = mid - span * 0.5;
            to = mid + span * 0.5;
          }
          if (clampLeft && from < minAllowed) {
            const shift = minAllowed - from;
            from += shift;
            to += shift;
          }
          if (clampRight && to > maxAllowed) {
            const shift = to - maxAllowed;
            from -= shift;
            to -= shift;
          }
        } else {
          const overLeft = clampLeft ? minAllowed - from : 0;
          const overRight = clampRight ? to - maxAllowed : 0;
          if (span <= maxSpan) {
            if (overLeft > 0 && overRight <= 0) {
              const offset = this._rubberBand(overLeft, limit);
              from = minAllowed - offset;
              to = from + span;
            } else if (overRight > 0 && overLeft <= 0) {
              const offset = this._rubberBand(overRight, limit);
              to = maxAllowed + offset;
              from = to - span;
            } else if (overLeft > 0 && overRight > 0) {
              from = minAllowed - this._rubberBand(overLeft, limit);
              to = maxAllowed + this._rubberBand(overRight, limit);
            }
          } else {
            if (overLeft > 0) {
              from = minAllowed - this._rubberBand(overLeft, limit);
            }
            if (overRight > 0) {
              to = maxAllowed + this._rubberBand(overRight, limit);
            }
          }
        }
      }
    }

    return { from, to };
  }

  private _rubberBand(delta: number, limit: number): number {
    if (!Number.isFinite(delta) || delta <= 0) return 0;
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    return (delta * limit) / (delta + limit);
  }

  private _fallbackRange(): VisibleRange {
    if (this._data.length >= 2) {
      const times = this._data.times();
      const from = times[0]!;
      const to = times[this._data.length - 1]!;
      return { from, to };
    }
    const now = Date.now();
    return { from: now - 60_000, to: now };
  }
}
