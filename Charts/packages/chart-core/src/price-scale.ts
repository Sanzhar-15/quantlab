import { clamp } from './index';
import type { Tick, TickGeneratorConfig } from './tick-types';
import { TickGenerator } from './tick-generator';
import type { IAxisScale } from './axis-scale';

export type PriceScaleFormat = 'decimal' | 'percent' | 'bps';
export type PriceScaleMode = 'normal' | 'percentage' | 'indexedTo100';

export const applyPriceScaleMode = (
  value: number,
  mode: PriceScaleMode,
  baseValue: number | null | undefined,
): number => {
  if (!Number.isFinite(value)) return Number.NaN;
  if (mode === 'normal') return value;
  const base = typeof baseValue === 'number' && Number.isFinite(baseValue) ? baseValue : Number.NaN;
  if (!Number.isFinite(base) || base === 0) return Number.NaN;
  if (mode === 'percentage') return value / base - 1;
  if (mode === 'indexedTo100') return (value / base) * 100;
  return value;
};

export type PriceFormatOptions = {
  precision?: number;
  minMove?: number;
};

export type ScaleMargins = {
  top?: number;
  bottom?: number;
};

export type PriceScaleOptions = {
  type?: 'linear' | 'log';
  mode?: PriceScaleMode;
  format?: PriceScaleFormat;
  formatter?: (value: number) => string;
  tickCount?: number;
  decimals?: number;
  autoScalePadding?: number;
  scaleMargins?: ScaleMargins;
  invertScale?: boolean;
  alignLabels?: boolean;
  entireTextOnly?: boolean;
  minWidth?: number;
  borderVisible?: boolean;
  ticksVisible?: boolean;
  priceFormat?: PriceFormatOptions;
};

export type PriceScaleRange = {
  min: number;
  max: number;
};

type EffectiveType = 'linear' | 'log';

const DEFAULT_TICK_COUNT = 6;
const TICK_HYSTERESIS_RATIO = 0.2;

export class PriceScale implements IAxisScale {
  private _options: Required<Omit<PriceScaleOptions, 'priceFormat' | 'scaleMargins'>> & {
    priceFormat: PriceFormatOptions | null;
    scaleMargins: Required<ScaleMargins>;
  };
  private _formatExplicit = false;
  private _usesDefaultFormatter = true;
  private _defaultFormatter: (value: number) => string;
  private _height = 1;
  private _range: PriceScaleRange = { min: 0, max: 1 };
  private _effectiveType: EffectiveType = 'linear';
  private _minPositive = 1;
  private _lastStep = 1;
  private _lastTickType: EffectiveType | null = null;
  private _tickGenerator: TickGenerator | null = null;

  public constructor(options: PriceScaleOptions = {}) {
    const mode = options.mode ?? 'normal';
    const format = options.format ?? (mode === 'percentage' ? 'percent' : 'decimal');
    this._formatExplicit = options.format !== undefined;
    this._defaultFormatter = (value) => this._defaultFormat(value);
    this._usesDefaultFormatter = options.formatter === undefined;
    this._options = {
      type: options.type ?? 'linear',
      mode,
      format,
      formatter: options.formatter ?? this._defaultFormatter,
      tickCount: options.tickCount ?? DEFAULT_TICK_COUNT,
      decimals: options.decimals ?? -1,
      autoScalePadding: options.autoScalePadding ?? 0,
      scaleMargins: {
        top: options.scaleMargins?.top ?? 0,
        bottom: options.scaleMargins?.bottom ?? 0,
      },
      invertScale: options.invertScale ?? false,
      alignLabels: options.alignLabels ?? true,
      entireTextOnly: options.entireTextOnly ?? false,
      minWidth: Math.max(0, options.minWidth ?? 0),
      borderVisible: options.borderVisible ?? false,
      ticksVisible: options.ticksVisible ?? true,
      priceFormat: options.priceFormat ?? null,
    };
  }

  public setOptions(options: PriceScaleOptions): void {
    if (options.type !== undefined) this._options.type = options.type;
    if (options.mode !== undefined) {
      this._options.mode = options.mode;
      if (!this._formatExplicit && this._usesDefaultFormatter && options.format === undefined) {
        this._options.format = options.mode === 'percentage' ? 'percent' : 'decimal';
      }
    }
    if (options.format !== undefined) {
      this._options.format = options.format;
      this._formatExplicit = true;
    }
    if (options.formatter !== undefined) {
      this._options.formatter = options.formatter;
      this._usesDefaultFormatter = false;
    }
    if (options.tickCount !== undefined) this._options.tickCount = options.tickCount;
    if (options.decimals !== undefined) this._options.decimals = options.decimals;
    if (options.autoScalePadding !== undefined) {
      this._options.autoScalePadding = options.autoScalePadding;
    }
    if (options.scaleMargins) {
      if (options.scaleMargins.top !== undefined) {
        this._options.scaleMargins.top = options.scaleMargins.top;
      }
      if (options.scaleMargins.bottom !== undefined) {
        this._options.scaleMargins.bottom = options.scaleMargins.bottom;
      }
    }
    if (options.invertScale !== undefined) this._options.invertScale = options.invertScale;
    if (options.alignLabels !== undefined) this._options.alignLabels = options.alignLabels;
    if (options.entireTextOnly !== undefined) this._options.entireTextOnly = options.entireTextOnly;
    if (options.minWidth !== undefined) this._options.minWidth = Math.max(0, options.minWidth);
    if (options.borderVisible !== undefined) this._options.borderVisible = options.borderVisible;
    if (options.ticksVisible !== undefined) this._options.ticksVisible = options.ticksVisible;
    if (options.priceFormat !== undefined) {
      this._options.priceFormat = options.priceFormat;
    }
  }

  public getOptions(): PriceScaleOptions {
    const { priceFormat, scaleMargins, ...rest } = this._options;
    return {
      ...rest,
      scaleMargins: { ...scaleMargins },
      ...(priceFormat ? { priceFormat } : {}),
    };
  }

  public getMode(): PriceScaleMode {
    return this._options.mode;
  }

  public toScaleValue(value: number, baseValue?: number | null): number {
    return applyPriceScaleMode(value, this._options.mode, baseValue ?? null);
  }

  public formatValue(value: number, baseValue?: number | null): string {
    const scaled = this.toScaleValue(value, baseValue ?? null);
    if (!Number.isFinite(scaled)) return '';
    return this.format(scaled);
  }

  public setHeight(height: number): void {
    this._height = Math.max(1, Math.round(height));
  }

  public setRange(min: number, max: number, minPositive?: number): void {
    this._range = this._normalizeRange(min, max);
    let resolvedMinPositive = minPositive;
    if (
      resolvedMinPositive === undefined ||
      !Number.isFinite(resolvedMinPositive) ||
      resolvedMinPositive <= 0
    ) {
      resolvedMinPositive = this._range.min > 0 ? this._range.min : 1;
    }
    this._minPositive = resolvedMinPositive;
    this._effectiveType = this._options.type === 'log' && this._range.min > 0 ? 'log' : 'linear';
  }

  public getRange(): PriceScaleRange {
    return { ...this._range };
  }

  public getEffectiveType(): EffectiveType {
    return this._effectiveType;
  }

  public getMinPositive(): number {
    return this._minPositive;
  }

  public autoScale(values: ArrayLike<number>, from: number, to: number): void {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let minPositive = Number.POSITIVE_INFINITY;

    const end = Math.min(to, values.length);
    for (let i = from; i < end; i += 1) {
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v > 0 && v < minPositive) minPositive = v;
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }

    if (min === max) {
      const pad = Math.max(1, Math.abs(min) * 0.05);
      min -= pad;
      max += pad;
    }

    this._minPositive = Number.isFinite(minPositive) ? minPositive : 1;
    this._range = this._normalizeRange(min, max);
    this._effectiveType = this._options.type === 'log' && this._range.min > 0 ? 'log' : 'linear';
  }

  public valueToY(value: number): number {
    if (!Number.isFinite(value)) return Number.NaN;
    const range = this._range;
    if (this._effectiveType === 'log') {
      if (value <= 0) return Number.NaN;
      const logMin = Math.log10(this._minPositive);
      const logMax = Math.log10(range.max);
      if (logMax === logMin) return this._height * 0.5;
      const ratio = (Math.log10(value) - logMin) / (logMax - logMin);
      return this._options.invertScale ? ratio * this._height : (1 - ratio) * this._height;
    }
    if (range.max === range.min) return this._height * 0.5;
    const ratio = (value - range.min) / (range.max - range.min);
    return this._options.invertScale ? ratio * this._height : (1 - ratio) * this._height;
  }

  public yToValue(y: number): number {
    const clamped = clamp(y, 0, this._height);
    const ratio = this._options.invertScale ? clamped / this._height : 1 - clamped / this._height;
    const range = this._range;
    if (this._effectiveType === 'log') {
      const logMin = Math.log10(this._minPositive);
      const logMax = Math.log10(range.max);
      return Math.pow(10, logMin + ratio * (logMax - logMin));
    }
    return range.min + ratio * (range.max - range.min);
  }

  public getTicks(desiredCount?: number): number[] {
    const count = Math.max(2, desiredCount ?? this._options.tickCount);
    const range = this._range;
    if (this._effectiveType === 'log') {
      return this._logTicks(range.min, range.max, count);
    }
    return this._linearTicks(range.min, range.max, count);
  }

  public format(value: number): string {
    return this._options.formatter(value);
  }

  /**
   * Generates unified ticks for grid, axis, and crosshair.
   * 
   * This is the new unified tick generation system that replaces
   * the separate grid/axis generation logic.
   * 
   * @param dataToPxFn - Function to convert data value to pixel position
   * @param config - Tick generator configuration (hysteresis, minors, etc.)
   * @returns Array of Tick objects with {value, px, kind, label}
   */
  public generateTicks(
    dataToPxFn: (value: number) => number,
    config?: Partial<TickGeneratorConfig>,
  ): Tick[] {
    const range = this._range;
    
    // Initialize tick generator if needed
    if (!this._tickGenerator) {
      this._tickGenerator = new TickGenerator({
        targetMajorPx: 80,
        minMajorPx: 50,
        maxMajorPx: 120,
        showMinors: true,
        minMinorPx: 12,
        tickSize: this._options.priceFormat?.minMove ?? 0,
        useFinancialNice: true,
        showEdgeTicks: false,
        ...config,
      });
    } else if (config) {
      this._tickGenerator.setConfig(config);
    }
    
    // Format function that respects step precision
    const formatFn = (value: number, step: number): string => {
      return this.format(value);
    };
    
    // Height is used as pxSize for vertical axis
    const pxSize = this._height;
    
    // Generate ticks using the unified generator
    return this._tickGenerator.generate(
      range.min,
      range.max,
      pxSize,
      dataToPxFn,
      formatFn,
    );
  }

  /**
   * Resets the tick generator hysteresis cache.
   * Call when data changes significantly or scale type changes.
   */
  public resetTickGenerator(): void {
    if (this._tickGenerator) {
      this._tickGenerator.reset();
    }
  }

  private _linearTicks(min: number, max: number, count: number): number[] {
    const span = max - min;
    if (span <= 0) return [min];

    const target = span / (count - 1);
    const step = this._pickStableStep(target, 'linear');

    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;

    const ticks: number[] = [];
    for (let v = start; v <= end + step * 0.5; v += step) {
      const normalized = Object.is(v, -0) ? 0 : v;
      ticks.push(normalized);
    }
    return ticks;
  }

  private _logTicks(min: number, max: number, count: number): number[] {
    const safeMin = Math.max(min, this._minPositive);
    const logMin = Math.log10(safeMin);
    const logMax = Math.log10(max);
    if (!Number.isFinite(logMin) || !Number.isFinite(logMax) || logMax <= logMin) {
      return [safeMin];
    }

    const decades = logMax - logMin;
    if (decades > count * 0.5) {
      // Many decades, use powers of 10
      const target = decades / (count - 1);
      const logStep = Math.max(1, Math.round(target));
      const start = Math.ceil(logMin / logStep) * logStep;
      const ticks: number[] = [];
      for (let v = start; v <= logMax + 0.01; v += logStep) {
        ticks.push(Math.pow(10, v));
      }
      return ticks;
    }

    // Narrow range, use nice numbers in linear space
    const span = max - safeMin;
    const target = span / (count - 1);
    const step = this._niceStep(target);
    const start = Math.ceil(safeMin / step) * step;
    const ticks: number[] = [];
    for (let v = start; v <= max + step * 0.1; v += step) {
      if (v <= 0) continue;
      ticks.push(v);
    }
    return ticks;
  }

  private _pickStableStep(target: number, type: EffectiveType): number {
    if (!Number.isFinite(target) || target <= 0) {
      this._lastTickType = type;
      this._lastStep = 1;
      return 1;
    }
    let candidate = this._niceStep(target);
    const minMove = this._options.priceFormat?.minMove;
    if (typeof minMove === 'number' && Number.isFinite(minMove) && minMove > 0) {
      candidate = Math.max(candidate, minMove);
      candidate = Math.ceil(candidate / minMove) * minMove;
    }
    if (this._lastTickType !== type || !Number.isFinite(this._lastStep) || this._lastStep <= 0) {
      this._lastTickType = type;
      this._lastStep = candidate;
      return candidate;
    }
    const lower = this._lastStep * (1 - TICK_HYSTERESIS_RATIO);
    const upper = this._lastStep * (1 + TICK_HYSTERESIS_RATIO);
    if (target >= lower && target <= upper) {
      return this._lastStep;
    }
    this._lastTickType = type;
    this._lastStep = candidate;
    return candidate;
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

  private _normalizeRange(min: number, max: number): PriceScaleRange {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    if (min > max) return { min: max, max: min };
    if (min === max) return { min: min - 1, max: max + 1 };
    return { min, max };
  }

  private _defaultFormat(value: number): string {
    const format = this._options.format;
    const decimals = this._resolveDecimals();
    if (format === 'percent') {
      return `${(value * 100).toFixed(decimals)}%`;
    }
    if (format === 'bps') {
      return `${(value * 10000).toFixed(decimals)} bps`;
    }

    // Smart Large Number Suffixes (K, M, B)
    const absValue = Math.abs(value);
    if (absValue >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (absValue >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (absValue >= 10_000) {
      // Use K for values above 10,000 to avoid long labels on axis
      return `${(value / 1_000).toFixed(1)}K`;
    }

    // Thousands separator for readability (e.g. 87,301)
    const formattedValue = value.toFixed(decimals);
    const parts = formattedValue.split('.');
    parts[0] = parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  private _resolveDecimals(): number {
    const priceFormat = this._options.priceFormat;
    if (priceFormat) {
      if (typeof priceFormat.precision === 'number' && Number.isFinite(priceFormat.precision)) {
        return Math.max(0, Math.floor(priceFormat.precision));
      }
      if (typeof priceFormat.minMove === 'number' && Number.isFinite(priceFormat.minMove)) {
        const minMove = Math.abs(priceFormat.minMove);
        if (minMove >= 1) return 0;
        let decimals = 0;
        let scaled = minMove;
        while (decimals < 8 && Math.abs(Math.round(scaled) - scaled) > 1e-6) {
          scaled *= 10;
          decimals += 1;
        }
        return decimals;
      }
    }
    if (this._options.decimals >= 0) return this._options.decimals;
    const step = Math.abs(this._lastStep);
    if (step >= 100) return 0;
    if (step >= 1) return 2;
    if (step >= 0.01) return 4;
    return 6;
  }
}
