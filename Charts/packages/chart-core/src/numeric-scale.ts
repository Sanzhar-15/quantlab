import { clamp } from './index';
import { DataStore } from './data-store';
import type { HorizontalScale, VisibleRange } from './horizontal-scale';

const DEFAULT_TICK_COUNT = 6;
const TICK_HYSTERESIS_RATIO = 0.2;
const ZOOM_WHEEL_STEP = 100;
const ZOOM_WHEEL_INTENSITY = Math.log(1.1) / ZOOM_WHEEL_STEP;

export type NumericScaleOptions = {
  minRangeMs?: number;
  maxRangeMs?: number;
  clampToData?: boolean;
  paddingMs?: number;
  elasticClamp?: boolean;
  elasticMaxRatio?: number;
  fixLeftEdge?: boolean;
  fixRightEdge?: boolean;
  tickCount?: number;
  tickSteps?: number[];
};

type ResolvedNumericScaleOptions = {
  minRangeMs: number;
  maxRangeMs: number;
  clampToData: boolean;
  paddingMs: number;
  elasticClamp: boolean;
  elasticMaxRatio: number;
  fixLeftEdge: boolean;
  fixRightEdge: boolean;
  tickCount: number;
};

const normalizeTickSteps = (steps?: number[]): number[] | null => {
  if (!steps || steps.length === 0) return null;
  const filtered = steps
    .filter((step) => Number.isFinite(step) && step > 0)
    .map((step) => Math.abs(step));
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a - b);
  return filtered;
};

const buildTicks = (range: VisibleRange, step: number): number[] => {
  if (!Number.isFinite(step) || step <= 0) return [range.from];
  const start = Math.floor(range.from / step) * step;
  const end = Math.ceil(range.to / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 0.5; v += step) {
    const normalized = Object.is(v, -0) ? 0 : v;
    ticks.push(normalized);
  }
  return ticks;
};

export class NumericScale implements HorizontalScale<NumericScaleOptions> {
  private readonly _data: DataStore;
  private _plotWidth = 1;
  private _visible: VisibleRange;
  private _options: ResolvedNumericScaleOptions;
  private _elasticActive = false;
  private _lastStep = 1;
  private _tickSteps: number[] | null;

  public constructor(data: DataStore, initialRange: VisibleRange, options: NumericScaleOptions = {}) {
    this._data = data;
    this._visible = { ...initialRange };
    const elasticMaxRatio =
      typeof options.elasticMaxRatio === 'number' && Number.isFinite(options.elasticMaxRatio)
        ? clamp(options.elasticMaxRatio, 0, 0.5)
        : 0.12;
    this._options = {
      minRangeMs: options.minRangeMs ?? 1,
      maxRangeMs: options.maxRangeMs ?? 1_000_000,
      clampToData: options.clampToData ?? true,
      paddingMs: Math.max(0, options.paddingMs ?? 0),
      elasticClamp: options.elasticClamp ?? false,
      elasticMaxRatio,
      fixLeftEdge: options.fixLeftEdge ?? true,
      fixRightEdge: options.fixRightEdge ?? true,
      tickCount: options.tickCount ?? DEFAULT_TICK_COUNT,
    };
    this._tickSteps = normalizeTickSteps(options.tickSteps);
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

  public setOptions(options: Partial<NumericScaleOptions>): void {
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
    if (typeof options.tickCount === 'number' && Number.isFinite(options.tickCount) && options.tickCount > 1) {
      next.tickCount = Math.floor(options.tickCount);
    }
    if (options.tickSteps) {
      this._tickSteps = normalizeTickSteps(options.tickSteps);
    }
    if (next.maxRangeMs < next.minRangeMs) {
      next.minRangeMs = next.maxRangeMs;
    }
    this._options = next;
    this._clampRange();
  }

  public getClampedRange(range?: VisibleRange): VisibleRange {
    const target = range ?? this._visible;
    return this._clampRangeTo(target, false);
  }

  public getTicksForRange(range: VisibleRange, desiredCount?: number): number[] {
    const safeRange =
      Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from
        ? range
        : this._visible;
    const count = Math.max(2, Math.floor(desiredCount ?? this._options.tickCount));
    const span = safeRange.to - safeRange.from;
    if (!Number.isFinite(span) || span <= 0) {
      return [safeRange.from];
    }
    const step = this._pickStableStep(span, count);
    return buildTicks(safeRange, step);
  }

  public getTicks(desiredCount?: number): number[] {
    return this.getTicksForRange(this._visible, desiredCount);
  }

  public timeToX(time: number): number {
    const span = this._visible.to - this._visible.from;
    if (span <= 0) return 0;
    return ((time - this._visible.from) / span) * this._plotWidth;
  }

  public xToTime(x: number): number {
    const span = this._visible.to - this._visible.from;
    const clampedX = clamp(x, 0, this._plotWidth);
    return this._visible.from + (clampedX / this._plotWidth) * span;
  }

  public getVisibleIndices(): { from: number; to: number } {
    const fromValue = this._visible.from;
    const toValue = this._visible.to;
    const from = this._data.lowerBound(fromValue);
    const to = this._data.upperBound(toValue);
    return { from, to };
  }

  public panByPixels(deltaX: number): void {
    const span = this._visible.to - this._visible.from;
    if (span <= 0) return;
    const deltaValue = (-deltaX / this._plotWidth) * span;
    this._visible = {
      from: this._visible.from + deltaValue,
      to: this._visible.to + deltaValue,
    };
    this._clampRange();
  }

  public zoomByWheel(deltaY: number, anchorX: number): void {
    const span = this._visible.to - this._visible.from;
    if (span <= 0) return;

    const scale = Math.exp(deltaY * ZOOM_WHEEL_INTENSITY);
    const anchorValue = this.xToTime(anchorX);
    const newSpan = clamp(span * scale, this._options.minRangeMs, this._options.maxRangeMs);

    const leftPortion = (anchorValue - this._visible.from) / span;
    const rightPortion = 1 - leftPortion;

    this._visible = {
      from: anchorValue - newSpan * leftPortion,
      to: anchorValue + newSpan * rightPortion,
    };
    this._clampRange();
  }

  public zoomByScale(scale: number, anchorX: number): void {
    const span = this._visible.to - this._visible.from;
    if (span <= 0 || !Number.isFinite(scale) || scale <= 0 || scale === 1) return;

    const anchorValue = this.xToTime(anchorX);
    const newSpan = clamp(span / scale, this._options.minRangeMs, this._options.maxRangeMs);

    const leftPortion = (anchorValue - this._visible.from) / span;
    const rightPortion = 1 - leftPortion;

    this._visible = {
      from: anchorValue - newSpan * leftPortion,
      to: anchorValue + newSpan * rightPortion,
    };
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

    if (this._options.clampToData && this._data.length > 0) {
      const values = this._data.times();
      const minValue = values[0]!;
      const maxValue = values[this._data.length - 1]!;
      const pad = this._options.paddingMs;
      const minAllowed = minValue - pad;
      const maxAllowed = maxValue + pad;
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

  private _pickStableStep(span: number, desiredCount: number): number {
    const target = span / Math.max(1, desiredCount - 1);
    if (!Number.isFinite(target) || target <= 0) {
      this._lastStep = 1;
      return 1;
    }
    const candidate = this._pickStep(target);
    if (!Number.isFinite(this._lastStep) || this._lastStep <= 0) {
      this._lastStep = candidate;
      return candidate;
    }
    const lower = this._lastStep * (1 - TICK_HYSTERESIS_RATIO);
    const upper = this._lastStep * (1 + TICK_HYSTERESIS_RATIO);
    if (target >= lower && target <= upper) {
      return this._lastStep;
    }
    this._lastStep = candidate;
    return candidate;
  }

  private _pickStep(target: number): number {
    if (this._tickSteps && this._tickSteps.length > 0) {
      let candidate = this._tickSteps[this._tickSteps.length - 1]!;
      for (const step of this._tickSteps) {
        if (step >= target) {
          candidate = step;
          break;
        }
      }
      return candidate;
    }
    return this._niceStep(target);
  }

  private _niceStep(step: number): number {
    if (step <= 0) return 1;
    const exponent = Math.floor(Math.log10(step));
    const fraction = step / Math.pow(10, exponent);
    let niceFraction = 1;

    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 2.25) niceFraction = 2;
    else if (fraction < 3.25) niceFraction = 2.5;
    else if (fraction < 7.5) niceFraction = 5;
    else niceFraction = 10;

    return niceFraction * Math.pow(10, exponent);
  }

  private _fallbackRange(): VisibleRange {
    if (this._data.length >= 2) {
      const values = this._data.times();
      const from = values[0]!;
      const to = values[this._data.length - 1]!;
      return { from, to };
    }
    return { from: 0, to: 1 };
  }
}
