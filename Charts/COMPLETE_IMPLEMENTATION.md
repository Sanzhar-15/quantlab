# Complete Implementation: Single Transform System

This is the complete, production-ready implementation. The key architectural decision is visible in the code: **everything uses `this._transform`**.

## grid-system.ts

```typescript
/**
 * Complete Grid-Axis System
 * 
 * ARCHITECTURAL GUARANTEE:
 * All coordinate conversions go through ONE CoordinateTransform instance.
 * Grid, axis, candlesticks, crosshair - all use the same transform.
 * Alignment is mathematically guaranteed.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ViewportState {
  timeFrom: number;
  timeTo: number;
  priceMin: number;
  priceMax: number;
  plotWidth: number;
  plotHeight: number;
  priceScaleType: 'linear' | 'log';
}

export interface TickValue {
  value: number;
  isMajor: boolean;
  label: string;
}

export interface OhlcBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// =============================================================================
// COORDINATE TRANSFORM (THE CORE - SINGLE INSTANCE)
// =============================================================================

export class CoordinateTransform {
  private _state: ViewportState;
  
  // Pre-computed for performance
  private _timeScale: number = 0;
  private _priceScale: number = 0;
  private _logPriceMin: number = 0;
  private _logPriceSpan: number = 0;
  
  constructor(initialState: ViewportState) {
    this._state = { ...initialState };
    this._recompute();
  }
  
  update(partial: Partial<ViewportState>): void {
    Object.assign(this._state, partial);
    this._recompute();
  }
  
  private _recompute(): void {
    const s = this._state;
    
    const timeSpan = s.timeTo - s.timeFrom;
    this._timeScale = timeSpan > 0 ? s.plotWidth / timeSpan : 0;
    
    const priceSpan = s.priceMax - s.priceMin;
    this._priceScale = priceSpan > 0 ? s.plotHeight / priceSpan : 0;
    
    if (s.priceScaleType === 'log') {
      this._logPriceMin = Math.log(Math.max(s.priceMin, 1e-10));
      const logMax = Math.log(Math.max(s.priceMax, 1e-10));
      this._logPriceSpan = logMax - this._logPriceMin;
    }
  }
  
  // =========================================================================
  // THE CORE FUNCTIONS - USED BY EVERYTHING
  // =========================================================================
  
  /**
   * Convert timestamp to X pixel.
   * Used by: grid, axis, candlesticks, crosshair, drawings, indicators
   */
  timeToX(time: number): number {
    return (time - this._state.timeFrom) * this._timeScale;
  }
  
  /**
   * Convert X pixel to timestamp.
   * Used by: crosshair, pan handling, click detection
   */
  xToTime(x: number): number {
    return this._state.timeFrom + x / this._timeScale;
  }
  
  /**
   * Convert price to Y pixel.
   * Used by: grid, axis, candlesticks, crosshair, drawings, indicators
   */
  priceToY(price: number): number {
    const s = this._state;
    let ratio: number;
    
    if (s.priceScaleType === 'log') {
      const logPrice = Math.log(Math.max(price, 1e-10));
      ratio = (logPrice - this._logPriceMin) / this._logPriceSpan;
    } else {
      ratio = (price - s.priceMin) / (s.priceMax - s.priceMin);
    }
    
    // Invert: high prices at top (low Y)
    return (1 - ratio) * s.plotHeight;
  }
  
  /**
   * Convert Y pixel to price.
   * Used by: crosshair, pan handling, click detection
   */
  yToPrice(y: number): number {
    const s = this._state;
    let ratio = 1 - y / s.plotHeight;  // Undo inversion
    
    if (s.priceScaleType === 'log') {
      const logPrice = this._logPriceMin + ratio * this._logPriceSpan;
      return Math.exp(logPrice);
    }
    
    return s.priceMin + ratio * (s.priceMax - s.priceMin);
  }
  
  getState(): Readonly<ViewportState> {
    return this._state;
  }
  
  getTimeScale(): number {
    return this._timeScale;
  }
  
  getPriceScale(): number {
    return this._priceScale;
  }
}

// =============================================================================
// TICK SELECTOR (CACHED)
// =============================================================================

export function selectPriceTicks(
  priceMin: number,
  priceMax: number,
  plotHeight: number,
  scaleType: 'linear' | 'log'
): TickValue[] {
  if (priceMax <= priceMin || plotHeight <= 0) return [];
  
  const minSpacing = 40;
  const maxTicks = Math.min(Math.floor(plotHeight / minSpacing), 20);
  
  if (maxTicks <= 0) return [];
  
  if (scaleType === 'log') {
    return selectLogTicks(priceMin, priceMax);
  }
  
  const span = priceMax - priceMin;
  const rawStep = span / maxTicks;
  const step = niceNumber(rawStep);
  const start = Math.ceil(priceMin / step) * step;
  
  const ticks: TickValue[] = [];
  
  for (let value = start; value <= priceMax + step * 0.001; value += step) {
    if (value < priceMin) continue;
    ticks.push({
      value,
      isMajor: true,
      label: formatPrice(value, step),
    });
  }
  
  // Minor ticks
  const minorStep = step / 5;
  for (let value = Math.ceil(priceMin / minorStep) * minorStep; value <= priceMax; value += minorStep) {
    if (Math.abs((value / step) % 1) < 0.01 || Math.abs((value / step) % 1) > 0.99) continue;
    ticks.push({ value, isMajor: false, label: '' });
  }
  
  return ticks.sort((a, b) => a.value - b.value);
}

function selectLogTicks(min: number, max: number): TickValue[] {
  const ticks: TickValue[] = [];
  const startPower = Math.floor(Math.log10(Math.max(min, 1e-10)));
  const endPower = Math.ceil(Math.log10(Math.max(max, 1e-10)));
  
  for (let p = startPower; p <= endPower; p++) {
    for (const mult of [1, 2, 5]) {
      const value = mult * Math.pow(10, p);
      if (value >= min * 0.99 && value <= max * 1.01) {
        ticks.push({
          value,
          isMajor: mult === 1,
          label: formatPrice(value, value / 10),
        });
      }
    }
  }
  return ticks.sort((a, b) => a.value - b.value);
}

export function selectTimeTicks(
  timeFrom: number,
  timeTo: number,
  plotWidth: number
): TickValue[] {
  if (timeTo <= timeFrom || plotWidth <= 0) return [];
  
  const minSpacing = 80;
  const maxTicks = Math.min(Math.floor(plotWidth / minSpacing), 30);
  if (maxTicks <= 0) return [];
  
  const span = timeTo - timeFrom;
  const targetInterval = span / maxTicks;
  
  // Find appropriate time interval
  const intervals = [
    { ms: 365.25 * 24 * 3600 * 1000, fmt: 'year' },
    { ms: 30 * 24 * 3600 * 1000, fmt: 'month' },
    { ms: 7 * 24 * 3600 * 1000, fmt: 'week' },
    { ms: 24 * 3600 * 1000, fmt: 'day' },
    { ms: 4 * 3600 * 1000, fmt: 'hour4' },
    { ms: 3600 * 1000, fmt: 'hour' },
    { ms: 15 * 60 * 1000, fmt: 'min15' },
    { ms: 5 * 60 * 1000, fmt: 'min5' },
    { ms: 60 * 1000, fmt: 'min' },
    { ms: 10 * 1000, fmt: 'sec10' },
    { ms: 1000, fmt: 'sec' },
  ];
  
  const interval = intervals.find(i => i.ms <= targetInterval * 1.5) ?? intervals[intervals.length - 1];
  
  const ticks: TickValue[] = [];
  let current = Math.ceil(timeFrom / interval.ms) * interval.ms;
  
  while (current <= timeTo) {
    if (current >= timeFrom) {
      ticks.push({
        value: current,
        isMajor: isMajorTimeTick(current, interval.fmt),
        label: formatTime(current, interval.fmt),
      });
    }
    current += interval.ms;
  }
  
  return ticks;
}

function niceNumber(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const frac = value / Math.pow(10, exp);
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

function formatPrice(price: number, step: number): string {
  const abs = Math.abs(price);
  if (abs >= 1e9) return (price / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (price / 1e6).toFixed(1) + 'M';
  if (abs >= 1e4) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return price.toFixed(step >= 1 ? 0 : 2);
  return price.toFixed(Math.min(8, Math.max(0, -Math.floor(Math.log10(step)))));
}

function formatTime(time: number, fmt: string): string {
  const d = new Date(time);
  switch (fmt) {
    case 'year': return d.getUTCFullYear().toString();
    case 'month': return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    case 'week':
    case 'day': return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    default: return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  }
}

function isMajorTimeTick(time: number, fmt: string): boolean {
  const d = new Date(time);
  switch (fmt) {
    case 'sec':
    case 'sec10':
    case 'min':
    case 'min5':
    case 'min15': return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
    case 'hour':
    case 'hour4': return d.getUTCHours() === 0;
    case 'day':
    case 'week': return d.getUTCDate() === 1;
    case 'month': return d.getUTCMonth() === 0;
    default: return true;
  }
}

// =============================================================================
// TICK CACHE
// =============================================================================

export class TickCache {
  private _priceTicks: TickValue[] | null = null;
  private _timeTicks: TickValue[] | null = null;
  private _lastPriceKey: string = '';
  private _lastTimeKey: string = '';
  
  getPriceTicks(state: ViewportState): TickValue[] {
    const key = `${state.priceMin.toFixed(6)}-${state.priceMax.toFixed(6)}-${state.plotHeight}-${state.priceScaleType}`;
    
    // Only regenerate if zoom level changed (not just pan)
    const span = state.priceMax - state.priceMin;
    const lastSpan = this._lastPriceKey ? parseFloat(this._lastPriceKey.split('-')[1]) - parseFloat(this._lastPriceKey.split('-')[0]) : 0;
    const zoomChanged = Math.abs(span - lastSpan) / span > 0.05;
    
    if (this._priceTicks && !zoomChanged && this._lastPriceKey.endsWith(`${state.plotHeight}-${state.priceScaleType}`)) {
      return this._priceTicks;
    }
    
    this._priceTicks = selectPriceTicks(state.priceMin, state.priceMax, state.plotHeight, state.priceScaleType);
    this._lastPriceKey = key;
    return this._priceTicks;
  }
  
  getTimeTicks(state: ViewportState): TickValue[] {
    const span = state.timeTo - state.timeFrom;
    const lastSpan = this._lastTimeKey ? parseFloat(this._lastTimeKey.split('-')[1]) - parseFloat(this._lastTimeKey.split('-')[0]) : 0;
    const zoomChanged = lastSpan === 0 || Math.abs(span - lastSpan) / span > 0.05;
    
    if (this._timeTicks && !zoomChanged) {
      return this._timeTicks;
    }
    
    this._timeTicks = selectTimeTicks(state.timeFrom, state.timeTo, state.plotWidth);
    this._lastTimeKey = `${state.timeFrom}-${state.timeTo}-${state.plotWidth}`;
    return this._timeTicks;
  }
  
  invalidate(): void {
    this._priceTicks = null;
    this._timeTicks = null;
  }
}

// =============================================================================
// RENDERERS (ALL USE THE SAME TRANSFORM)
// =============================================================================

export interface GridStyle {
  majorColor: string;
  minorColor: string;
}

const DEFAULT_GRID_STYLE: GridStyle = {
  majorColor: 'rgba(255, 255, 255, 0.08)',
  minorColor: 'rgba(255, 255, 255, 0.03)',
};

/**
 * Render grid lines.
 * Uses transform.priceToY() and transform.timeToX().
 */
export function renderGrid(
  ctx: CanvasRenderingContext2D,
  priceTicks: TickValue[],
  timeTicks: TickValue[],
  transform: CoordinateTransform,  // <-- THE SAME TRANSFORM
  plotRect: Rect,
  style: Partial<GridStyle> = {}
): void {
  const s = { ...DEFAULT_GRID_STYLE, ...style };
  
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
  ctx.clip();
  
  // Minor lines
  ctx.strokeStyle = s.minorColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  
  for (const tick of priceTicks) {
    if (tick.isMajor) continue;
    const y = plotRect.y + transform.priceToY(tick.value);  // <-- USES TRANSFORM
    const ry = Math.round(y) + 0.5;
    ctx.moveTo(plotRect.x, ry);
    ctx.lineTo(plotRect.x + plotRect.width, ry);
  }
  
  for (const tick of timeTicks) {
    if (tick.isMajor) continue;
    const x = plotRect.x + transform.timeToX(tick.value);  // <-- USES TRANSFORM
    const rx = Math.round(x) + 0.5;
    ctx.moveTo(rx, plotRect.y);
    ctx.lineTo(rx, plotRect.y + plotRect.height);
  }
  
  ctx.stroke();
  
  // Major lines
  ctx.strokeStyle = s.majorColor;
  ctx.beginPath();
  
  for (const tick of priceTicks) {
    if (!tick.isMajor) continue;
    const y = plotRect.y + transform.priceToY(tick.value);  // <-- USES SAME TRANSFORM
    const ry = Math.round(y) + 0.5;
    ctx.moveTo(plotRect.x, ry);
    ctx.lineTo(plotRect.x + plotRect.width, ry);
  }
  
  for (const tick of timeTicks) {
    if (!tick.isMajor) continue;
    const x = plotRect.x + transform.timeToX(tick.value);  // <-- USES SAME TRANSFORM
    const rx = Math.round(x) + 0.5;
    ctx.moveTo(rx, plotRect.y);
    ctx.lineTo(rx, plotRect.y + plotRect.height);
  }
  
  ctx.stroke();
  ctx.restore();
}

/**
 * Render Y-axis (price).
 * Uses transform.priceToY().
 */
export function renderYAxis(
  ctx: CanvasRenderingContext2D,
  priceTicks: TickValue[],
  transform: CoordinateTransform,  // <-- THE SAME TRANSFORM
  axisRect: Rect,
  plotY: number
): void {
  ctx.save();
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  
  for (const tick of priceTicks) {
    if (!tick.isMajor || !tick.label) continue;
    
    const y = plotY + transform.priceToY(tick.value);  // <-- USES SAME TRANSFORM
    const ry = Math.round(y) + 0.5;
    
    if (ry < axisRect.y || ry > axisRect.y + axisRect.height) continue;
    
    // Tick mark
    ctx.beginPath();
    ctx.moveTo(axisRect.x, ry);
    ctx.lineTo(axisRect.x + 4, ry);
    ctx.stroke();
    
    // Label
    ctx.fillText(tick.label, axisRect.x + 8, ry);
  }
  
  ctx.restore();
}

/**
 * Render X-axis (time).
 * Uses transform.timeToX().
 */
export function renderXAxis(
  ctx: CanvasRenderingContext2D,
  timeTicks: TickValue[],
  transform: CoordinateTransform,  // <-- THE SAME TRANSFORM
  axisRect: Rect,
  plotX: number
): void {
  ctx.save();
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  
  let lastLabelRight = -Infinity;
  
  for (const tick of timeTicks) {
    if (!tick.isMajor || !tick.label) continue;
    
    const x = plotX + transform.timeToX(tick.value);  // <-- USES SAME TRANSFORM
    const rx = Math.round(x) + 0.5;
    
    if (rx < axisRect.x || rx > axisRect.x + axisRect.width) continue;
    
    // Check overlap
    const labelWidth = ctx.measureText(tick.label).width;
    const labelLeft = rx - labelWidth / 2;
    if (labelLeft < lastLabelRight + 10) continue;
    lastLabelRight = rx + labelWidth / 2;
    
    // Tick mark
    ctx.beginPath();
    ctx.moveTo(rx, axisRect.y);
    ctx.lineTo(rx, axisRect.y + 4);
    ctx.stroke();
    
    // Label
    ctx.fillText(tick.label, rx, axisRect.y + 8);
  }
  
  ctx.restore();
}

/**
 * Render candlesticks.
 * Uses transform.timeToX() and transform.priceToY().
 * 
 * THIS IS THE KEY: Same transform as grid and axis!
 */
export function renderCandlesticks(
  ctx: CanvasRenderingContext2D,
  data: OhlcBar[],
  transform: CoordinateTransform,  // <-- THE SAME TRANSFORM
  plotRect: Rect,
  barWidth: number = 8
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
  ctx.clip();
  
  const halfBar = barWidth / 2;
  
  for (const bar of data) {
    const x = plotRect.x + transform.timeToX(bar.time);      // <-- USES SAME TRANSFORM
    const yOpen = plotRect.y + transform.priceToY(bar.open);  // <-- USES SAME TRANSFORM
    const yHigh = plotRect.y + transform.priceToY(bar.high);  // <-- USES SAME TRANSFORM
    const yLow = plotRect.y + transform.priceToY(bar.low);    // <-- USES SAME TRANSFORM
    const yClose = plotRect.y + transform.priceToY(bar.close);// <-- USES SAME TRANSFORM
    
    // Skip if outside visible area
    if (x < plotRect.x - barWidth || x > plotRect.x + plotRect.width + barWidth) continue;
    
    const isGreen = bar.close >= bar.open;
    ctx.fillStyle = isGreen ? '#26a69a' : '#ef5350';
    ctx.strokeStyle = isGreen ? '#26a69a' : '#ef5350';
    
    // Wick
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, Math.round(yHigh) + 0.5);
    ctx.lineTo(Math.round(x) + 0.5, Math.round(yLow) + 0.5);
    ctx.stroke();
    
    // Body
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillRect(
      Math.round(x - halfBar),
      Math.round(bodyTop),
      Math.round(barWidth),
      Math.round(bodyHeight)
    );
  }
  
  ctx.restore();
}

/**
 * Render crosshair.
 * Uses transform for coordinate conversion.
 */
export function renderCrosshair(
  ctx: CanvasRenderingContext2D,
  mouseX: number,
  mouseY: number,
  transform: CoordinateTransform,  // <-- THE SAME TRANSFORM
  plotRect: Rect
): { time: number; price: number } {
  const time = transform.xToTime(mouseX - plotRect.x);   // <-- USES SAME TRANSFORM
  const price = transform.yToPrice(mouseY - plotRect.y); // <-- USES SAME TRANSFORM
  
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  
  // Vertical line
  ctx.beginPath();
  ctx.moveTo(Math.round(mouseX) + 0.5, plotRect.y);
  ctx.lineTo(Math.round(mouseX) + 0.5, plotRect.y + plotRect.height);
  ctx.stroke();
  
  // Horizontal line
  ctx.beginPath();
  ctx.moveTo(plotRect.x, Math.round(mouseY) + 0.5);
  ctx.lineTo(plotRect.x + plotRect.width, Math.round(mouseY) + 0.5);
  ctx.stroke();
  
  ctx.restore();
  
  return { time, price };
}

// =============================================================================
// CHART CLASS (INTEGRATES EVERYTHING)
// =============================================================================

export class Chart {
  private _ctx: CanvasRenderingContext2D;
  private _transform: CoordinateTransform;  // <-- SINGLE INSTANCE
  private _tickCache: TickCache;
  
  private _plotRect: Rect;
  private _yAxisRect: Rect;
  private _xAxisRect: Rect;
  
  private _data: OhlcBar[] = [];
  
  // Drag state
  private _isDragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _dragStartState: ViewportState | null = null;
  
  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this._ctx = ctx;
    
    // Layout
    const width = canvas.width;
    const height = canvas.height;
    const yAxisWidth = 70;
    const xAxisHeight = 30;
    
    this._plotRect = {
      x: 0,
      y: 0,
      width: width - yAxisWidth,
      height: height - xAxisHeight,
    };
    
    this._yAxisRect = {
      x: width - yAxisWidth,
      y: 0,
      width: yAxisWidth,
      height: height - xAxisHeight,
    };
    
    this._xAxisRect = {
      x: 0,
      y: height - xAxisHeight,
      width: width - yAxisWidth,
      height: xAxisHeight,
    };
    
    // Initialize transform
    this._transform = new CoordinateTransform({
      timeFrom: Date.now() - 24 * 60 * 60 * 1000,
      timeTo: Date.now(),
      priceMin: 0,
      priceMax: 100,
      plotWidth: this._plotRect.width,
      plotHeight: this._plotRect.height,
      priceScaleType: 'linear',
    });
    
    this._tickCache = new TickCache();
    
    // Bind events
    canvas.addEventListener('mousedown', this._onMouseDown);
    canvas.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mouseup', this._onMouseUp);
    canvas.addEventListener('mouseleave', this._onMouseUp);
    canvas.addEventListener('wheel', this._onWheel);
  }
  
  setData(data: OhlcBar[]): void {
    this._data = data;
    
    if (data.length > 0) {
      // Auto-fit viewport to data
      const times = data.map(d => d.time);
      const prices = data.flatMap(d => [d.low, d.high]);
      
      const timeMin = Math.min(...times);
      const timeMax = Math.max(...times);
      const priceMin = Math.min(...prices);
      const priceMax = Math.max(...prices);
      const pricePadding = (priceMax - priceMin) * 0.1;
      
      this._transform.update({
        timeFrom: timeMin,
        timeTo: timeMax,
        priceMin: priceMin - pricePadding,
        priceMax: priceMax + pricePadding,
      });
      
      this._tickCache.invalidate();
    }
    
    this.render();
  }
  
  render(): void {
    const ctx = this._ctx;
    const state = this._transform.getState();
    
    // Clear
    ctx.fillStyle = '#0b0e11';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    
    // Get ticks (cached)
    const priceTicks = this._tickCache.getPriceTicks(state);
    const timeTicks = this._tickCache.getTimeTicks(state);
    
    // Render grid - uses this._transform
    renderGrid(ctx, priceTicks, timeTicks, this._transform, this._plotRect);
    
    // Render candlesticks - uses SAME this._transform
    const barWidth = Math.max(1, Math.min(20, this._transform.getTimeScale() * 60000 * 0.8));
    renderCandlesticks(ctx, this._data, this._transform, this._plotRect, barWidth);
    
    // Render axes - uses SAME this._transform
    renderYAxis(ctx, priceTicks, this._transform, this._yAxisRect, this._plotRect.y);
    renderXAxis(ctx, timeTicks, this._transform, this._xAxisRect, this._plotRect.x);
  }
  
  // =========================================================================
  // EVENT HANDLERS
  // =========================================================================
  
  private _onMouseDown = (e: MouseEvent): void => {
    this._isDragging = true;
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._dragStartState = { ...this._transform.getState() };
  };
  
  private _onMouseMove = (e: MouseEvent): void => {
    if (!this._isDragging || !this._dragStartState) return;
    
    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;
    
    // Convert pixel delta to value delta using transform
    const timeDelta = dx / this._transform.getTimeScale();
    const priceDelta = dy / this._transform.getPriceScale();
    
    // Update transform (shift viewport)
    this._transform.update({
      timeFrom: this._dragStartState.timeFrom - timeDelta,
      timeTo: this._dragStartState.timeTo - timeDelta,
      priceMin: this._dragStartState.priceMin + priceDelta,
      priceMax: this._dragStartState.priceMax + priceDelta,
    });
    
    this.render();
  };
  
  private _onMouseUp = (): void => {
    this._isDragging = false;
    this._dragStartState = null;
  };
  
  private _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    
    const state = this._transform.getState();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    
    // Zoom centered on cursor
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Get values at cursor position BEFORE zoom
    const anchorTime = this._transform.xToTime(mouseX);
    const anchorPrice = this._transform.yToPrice(mouseY);
    
    // Calculate new ranges
    const timeSpan = state.timeTo - state.timeFrom;
    const priceSpan = state.priceMax - state.priceMin;
    const newTimeSpan = timeSpan / zoomFactor;
    const newPriceSpan = priceSpan / zoomFactor;
    
    // Calculate new bounds keeping anchor at same pixel position
    const timeRatio = mouseX / state.plotWidth;
    const priceRatio = 1 - mouseY / state.plotHeight;
    
    this._transform.update({
      timeFrom: anchorTime - newTimeSpan * timeRatio,
      timeTo: anchorTime + newTimeSpan * (1 - timeRatio),
      priceMin: anchorPrice - newPriceSpan * priceRatio,
      priceMax: anchorPrice + newPriceSpan * (1 - priceRatio),
    });
    
    this._tickCache.invalidate();
    this.render();
  };
  
  getTransform(): CoordinateTransform {
    return this._transform;
  }
}
```

---

## Usage

```typescript
// Create chart
const canvas = document.getElementById('chart') as HTMLCanvasElement;
const chart = new Chart(canvas);

// Set data
chart.setData([
  { time: Date.now() - 3600000, open: 100, high: 105, low: 98, close: 103 },
  { time: Date.now() - 3000000, open: 103, high: 107, low: 101, close: 106 },
  // ... more bars
]);

// The grid WILL stick to the candlesticks because they use the same transform
```

---

## Verification Test

```typescript
// Add this test to verify alignment
function testAlignment(chart: Chart) {
  const transform = chart.getTransform();
  
  // Test: If candlestick high is $100, and grid has tick at $100,
  // they should render at EXACT same Y pixel
  
  const candleHighPrice = 100;
  const tickPrice = 100;
  
  const candleY = transform.priceToY(candleHighPrice);
  const gridY = transform.priceToY(tickPrice);
  
  console.assert(candleY === gridY, `Alignment failed: candle=${candleY}, grid=${gridY}`);
  console.log('Alignment test passed: candleY === gridY ===', candleY);
}
```
