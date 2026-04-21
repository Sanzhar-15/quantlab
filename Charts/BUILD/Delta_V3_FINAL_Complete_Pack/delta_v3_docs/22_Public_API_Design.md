# Public API Design (V3 Add-On)
**Purpose:** Define the complete public API surface for Delta Charting Engine—how consumers instantiate, configure, control, and extend the chart.

This document covers:
- chart instantiation and lifecycle
- configuration and theming
- data management (series, indicators, drawings)
- event system and callbacks
- programmatic control
- plugin/extension architecture

> Design goal: **API feels familiar to TradingView Lightweight Charts users** while exposing Delta's advanced capabilities.

---

## 0) Core design principles

1. **Declarative configuration**: Pass options object, not imperative setup calls
2. **Chainable methods**: Return `this` for fluent API where appropriate
3. **Event-driven**: Use typed event emitters, not callbacks in options
4. **Immutable updates**: Configuration changes via new options object, not mutation
5. **TypeScript-first**: Full type definitions with generics where useful
6. **Tree-shakeable**: Modular exports for bundle size optimization

---

## 1) Package structure

### 1.1 NPM packages
```
@anthropic/delta-chart         # Main chart package
@anthropic/delta-chart-react   # React wrapper
@anthropic/delta-chart-vue     # Vue wrapper (future)
@anthropic/delta-chart-angular # Angular wrapper (future)
```

### 1.2 Main package exports
```typescript
// Core
export { createChart } from "./chart";
export type { ChartApi, ChartOptions } from "./chart";

// Series
export type { 
  SeriesApi, 
  CandlestickSeriesOptions,
  LineSeriesOptions,
  AreaSeriesOptions,
  BaselineSeriesOptions,
  HistogramSeriesOptions,
} from "./series";

// Indicators
export type { IndicatorApi, IndicatorOptions } from "./indicators";
export { IndicatorType } from "./indicators";

// Drawings
export type { DrawingApi, DrawingOptions } from "./drawings";
export { DrawingType } from "./drawings";

// Data types
export type { 
  BarData, 
  LineData, 
  HistogramData,
  Time,
  UTCTimestamp,
  BusinessDay,
} from "./data";

// Events
export type { 
  MouseEventParams,
  CrosshairMoveEventParams,
  TimeRangeChangeEventParams,
  ClickEventParams,
} from "./events";

// Utilities
export { isBusinessDay, isUTCTimestamp } from "./utils";
```

---

## 2) Chart instantiation

### 2.1 createChart function
```typescript
/**
 * Creates a new chart instance attached to the specified container.
 * 
 * @param container - HTML element or CSS selector for the chart container
 * @param options - Chart configuration options
 * @returns ChartApi instance for controlling the chart
 * 
 * @example
 * ```ts
 * const chart = createChart(document.getElementById('chart'), {
 *   width: 800,
 *   height: 600,
 *   theme: 'dark',
 * });
 * ```
 */
export function createChart(
  container: HTMLElement | string,
  options?: DeepPartial<ChartOptions>
): ChartApi;
```

### 2.2 ChartOptions
```typescript
interface ChartOptions {
  // Dimensions
  width: number;                      // CSS pixels (0 = auto from container)
  height: number;                     // CSS pixels (0 = auto from container)
  autoSize: boolean;                  // Resize with container
  
  // Rendering
  renderer: RendererOptions;
  
  // Layout
  layout: LayoutOptions;
  
  // Time scale (x-axis)
  timeScale: TimeScaleOptions;
  
  // Price scale (y-axis)
  priceScale: PriceScaleOptions;
  
  // Grid
  grid: GridOptions;
  
  // Crosshair
  crosshair: CrosshairOptions;
  
  // Theming
  theme: "light" | "dark" | ThemeOptions;
  
  // Interaction
  handleScroll: boolean | HandleScrollOptions;
  handleScale: boolean | HandleScaleOptions;
  kineticScroll: KineticScrollOptions;
  
  // Localization
  localization: LocalizationOptions;
  
  // Watermark
  watermark: WatermarkOptions;
}

interface RendererOptions {
  // Tier preference
  preferredTier: "A" | "B" | "C" | "D" | "auto";
  
  // Device pixel ratio
  pixelRatio: number | "auto";
  
  // Quality settings
  antialias: boolean;
  
  // Debug
  debug: boolean;
  showFps: boolean;
}

interface LayoutOptions {
  // Background
  background: ColorType;
  
  // Text
  textColor: ColorType;
  fontSize: number;
  fontFamily: string;
  
  // Padding
  padding: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

interface TimeScaleOptions {
  // Visibility
  visible: boolean;
  
  // Range
  rightOffset: number;            // Bars of empty space on right
  minBarSpacing: number;          // Minimum pixels per bar
  maxBarSpacing: number;          // Maximum pixels per bar
  fixLeftEdge: boolean;           // Prevent scrolling past left edge
  fixRightEdge: boolean;          // Prevent scrolling past right edge
  
  // Appearance
  borderVisible: boolean;
  borderColor: ColorType;
  
  // Ticks
  timeVisible: boolean;
  secondsVisible: boolean;
  tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => string;
}

interface PriceScaleOptions {
  // Position
  position: "left" | "right" | "none";
  
  // Mode
  mode: "normal" | "logarithmic" | "percentage" | "indexedTo100";
  
  // Auto scale
  autoScale: boolean;
  
  // Range
  entireTextOnly: boolean;
  
  // Appearance
  borderVisible: boolean;
  borderColor: ColorType;
  
  // Labels
  drawTicks: boolean;
  ticksVisible: boolean;
  
  // Formatting
  priceFormatter: (price: number) => string;
}

interface CrosshairOptions {
  // Mode
  mode: "normal" | "magnet";
  
  // Vertical line
  vertLine: CrosshairLineOptions;
  
  // Horizontal line
  horzLine: CrosshairLineOptions;
}

interface CrosshairLineOptions {
  visible: boolean;
  color: ColorType;
  width: number;
  style: LineStyle;
  labelVisible: boolean;
  labelBackgroundColor: ColorType;
}
```

### 2.3 ThemeOptions
```typescript
interface ThemeOptions {
  // Backgrounds
  background: ColorType;
  
  // Text
  textColor: ColorType;
  
  // Grid
  gridLinesColor: ColorType;
  
  // Scales
  scaleBackground: ColorType;
  scaleBorderColor: ColorType;
  
  // Crosshair
  crosshairColor: ColorType;
  crosshairLabelBackground: ColorType;
  crosshairLabelTextColor: ColorType;
  
  // Series defaults
  upColor: ColorType;
  downColor: ColorType;
  wickUpColor: ColorType;
  wickDownColor: ColorType;
  borderUpColor: ColorType;
  borderDownColor: ColorType;
  
  // Indicators
  indicatorColors: ColorType[];
  
  // Watermark
  watermarkColor: ColorType;
}

// Preset themes
const LIGHT_THEME: ThemeOptions = {
  background: "#ffffff",
  textColor: "#191919",
  gridLinesColor: "#e1e3eb",
  // ...
};

const DARK_THEME: ThemeOptions = {
  background: "#131722",
  textColor: "#d1d4dc",
  gridLinesColor: "#363c4e",
  // ...
};
```

---

## 3) ChartApi interface

### 3.1 Core methods
```typescript
interface ChartApi {
  // ============ LIFECYCLE ============
  
  /**
   * Removes the chart from DOM and releases all resources.
   * After calling remove(), the chart instance is no longer usable.
   */
  remove(): void;
  
  /**
   * Resizes the chart to the specified dimensions.
   * If dimensions are not provided, resizes to fit container.
   */
  resize(width?: number, height?: number): void;
  
  // ============ OPTIONS ============
  
  /**
   * Updates chart options. Only provided fields are updated.
   */
  applyOptions(options: DeepPartial<ChartOptions>): void;
  
  /**
   * Returns current chart options (read-only copy).
   */
  options(): Readonly<ChartOptions>;
  
  // ============ SERIES ============
  
  /**
   * Adds a candlestick series to the chart.
   */
  addCandlestickSeries(options?: DeepPartial<CandlestickSeriesOptions>): CandlestickSeriesApi;
  
  /**
   * Adds a line series to the chart.
   */
  addLineSeries(options?: DeepPartial<LineSeriesOptions>): LineSeriesApi;
  
  /**
   * Adds an area series to the chart.
   */
  addAreaSeries(options?: DeepPartial<AreaSeriesOptions>): AreaSeriesApi;
  
  /**
   * Adds a baseline series to the chart.
   */
  addBaselineSeries(options?: DeepPartial<BaselineSeriesOptions>): BaselineSeriesApi;
  
  /**
   * Adds a histogram series to the chart.
   */
  addHistogramSeries(options?: DeepPartial<HistogramSeriesOptions>): HistogramSeriesApi;
  
  /**
   * Removes a series from the chart.
   */
  removeSeries(series: SeriesApi<any>): void;
  
  // ============ INDICATORS ============
  
  /**
   * Adds an indicator to the chart.
   * @param type - Indicator type (e.g., "ema", "rsi", "macd")
   * @param options - Indicator parameters and styling
   * @param targetSeries - Series to compute indicator from (optional, defaults to main series)
   */
  addIndicator(
    type: IndicatorType,
    options?: DeepPartial<IndicatorOptions>,
    targetSeries?: SeriesApi<any>
  ): IndicatorApi;
  
  /**
   * Removes an indicator from the chart.
   */
  removeIndicator(indicator: IndicatorApi): void;
  
  /**
   * Returns all indicators on the chart.
   */
  indicators(): IndicatorApi[];
  
  // ============ DRAWINGS ============
  
  /**
   * Enables drawing mode for the specified tool.
   * User can then draw on the chart.
   */
  enableDrawingMode(type: DrawingType): void;
  
  /**
   * Disables drawing mode.
   */
  disableDrawingMode(): void;
  
  /**
   * Programmatically adds a drawing to the chart.
   */
  addDrawing(type: DrawingType, options: DrawingOptions): DrawingApi;
  
  /**
   * Removes a drawing from the chart.
   */
  removeDrawing(drawing: DrawingApi): void;
  
  /**
   * Returns all drawings on the chart.
   */
  drawings(): DrawingApi[];
  
  /**
   * Clears all drawings from the chart.
   */
  clearDrawings(): void;
  
  // ============ TIME SCALE ============
  
  /**
   * Returns the time scale API for controlling the x-axis.
   */
  timeScale(): TimeScaleApi;
  
  // ============ PRICE SCALE ============
  
  /**
   * Returns the price scale API for the specified position.
   */
  priceScale(position?: "left" | "right"): PriceScaleApi;
  
  // ============ EVENTS ============
  
  /**
   * Subscribes to crosshair move events.
   */
  subscribeCrosshairMove(handler: CrosshairMoveEventHandler): void;
  
  /**
   * Unsubscribes from crosshair move events.
   */
  unsubscribeCrosshairMove(handler: CrosshairMoveEventHandler): void;
  
  /**
   * Subscribes to click events on the chart.
   */
  subscribeClick(handler: ClickEventHandler): void;
  
  /**
   * Unsubscribes from click events.
   */
  unsubscribeClick(handler: ClickEventHandler): void;
  
  /**
   * Subscribes to double-click events on the chart.
   */
  subscribeDblClick(handler: DblClickEventHandler): void;
  
  /**
   * Unsubscribes from double-click events.
   */
  unsubscribeDblClick(handler: DblClickEventHandler): void;
  
  // ============ SCREENSHOTS ============
  
  /**
   * Takes a screenshot of the chart and returns as a data URL.
   */
  takeScreenshot(): string;
  
  /**
   * Takes a screenshot and returns as a Blob.
   */
  takeScreenshotAsBlob(): Promise<Blob>;
  
  // ============ CONVERSION ============
  
  /**
   * Converts a time value to x coordinate.
   */
  timeToCoordinate(time: Time): number | null;
  
  /**
   * Converts an x coordinate to time value.
   */
  coordinateToTime(x: number): Time | null;
  
  /**
   * Converts a price value to y coordinate.
   */
  priceToCoordinate(price: number, series?: SeriesApi<any>): number | null;
  
  /**
   * Converts a y coordinate to price value.
   */
  coordinateToPrice(y: number, series?: SeriesApi<any>): number | null;
}
```

---

## 4) Series API

### 4.1 Base SeriesApi
```typescript
interface SeriesApi<TData> {
  // ============ DATA ============
  
  /**
   * Sets the complete data for this series.
   * Replaces any existing data.
   */
  setData(data: TData[]): void;
  
  /**
   * Updates the last data point or adds a new one.
   * More efficient than setData for streaming updates.
   */
  update(data: TData): void;
  
  /**
   * Returns all data points for this series.
   */
  data(): readonly TData[];
  
  // ============ OPTIONS ============
  
  /**
   * Updates series options.
   */
  applyOptions(options: DeepPartial<SeriesOptionsMap[SeriesType]>): void;
  
  /**
   * Returns current series options.
   */
  options(): Readonly<SeriesOptionsMap[SeriesType]>;
  
  // ============ MARKERS ============
  
  /**
   * Sets markers for this series.
   */
  setMarkers(markers: SeriesMarker[]): void;
  
  /**
   * Returns current markers.
   */
  markers(): readonly SeriesMarker[];
  
  // ============ PRICE LINES ============
  
  /**
   * Creates a horizontal price line.
   */
  createPriceLine(options: PriceLineOptions): PriceLine;
  
  /**
   * Removes a price line.
   */
  removePriceLine(priceLine: PriceLine): void;
  
  // ============ VISIBILITY ============
  
  /**
   * Returns the series type.
   */
  seriesType(): SeriesType;
  
  /**
   * Returns bounding prices for visible data.
   */
  priceRange(): PriceRange | null;
}
```

### 4.2 Candlestick series
```typescript
interface CandlestickSeriesApi extends SeriesApi<CandlestickData> {
  seriesType(): "Candlestick";
}

interface CandlestickSeriesOptions {
  // Colors
  upColor: ColorType;
  downColor: ColorType;
  wickUpColor: ColorType;
  wickDownColor: ColorType;
  borderUpColor: ColorType;
  borderDownColor: ColorType;
  
  // Appearance
  borderVisible: boolean;
  wickVisible: boolean;
  
  // Price scale
  priceScaleId: string;
  
  // Labels
  title: string;
  visible: boolean;
  
  // Last price
  lastValueVisible: boolean;
  priceLineVisible: boolean;
  priceLineWidth: number;
  priceLineColor: ColorType;
  priceLineStyle: LineStyle;
}

interface CandlestickData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
```

### 4.3 Line series
```typescript
interface LineSeriesApi extends SeriesApi<LineData> {
  seriesType(): "Line";
}

interface LineSeriesOptions {
  color: ColorType;
  lineWidth: number;
  lineStyle: LineStyle;
  lineType: LineType;           // 0 = simple, 1 = step, 2 = curved
  
  // Points
  pointMarkersVisible: boolean;
  pointMarkersRadius: number;
  
  // Crosshair marker
  crosshairMarkerVisible: boolean;
  crosshairMarkerRadius: number;
  crosshairMarkerBorderColor: ColorType;
  crosshairMarkerBackgroundColor: ColorType;
  
  // Price scale
  priceScaleId: string;
  
  // Labels
  title: string;
  visible: boolean;
  
  // Last price
  lastValueVisible: boolean;
  priceLineVisible: boolean;
}

interface LineData {
  time: Time;
  value: number;
}
```

---

## 5) Indicator API

### 5.1 IndicatorApi
```typescript
interface IndicatorApi {
  // ============ IDENTITY ============
  
  /**
   * Returns the indicator type.
   */
  type(): IndicatorType;
  
  /**
   * Returns the unique instance ID.
   */
  id(): string;
  
  // ============ OPTIONS ============
  
  /**
   * Updates indicator parameters.
   * Triggers recalculation.
   */
  applyOptions(options: DeepPartial<IndicatorOptions>): void;
  
  /**
   * Returns current indicator options.
   */
  options(): Readonly<IndicatorOptions>;
  
  // ============ VALUES ============
  
  /**
   * Returns the indicator value at the specified time.
   */
  valueAt(time: Time): IndicatorValue | null;
  
  /**
   * Returns all computed values.
   */
  values(): readonly IndicatorValue[];
  
  // ============ PANE ============
  
  /**
   * Returns whether this indicator is an overlay (on price chart)
   * or in a separate pane.
   */
  isOverlay(): boolean;
  
  /**
   * Moves the indicator to a separate pane.
   */
  moveToPane(paneIndex: number): void;
  
  // ============ VISIBILITY ============
  
  /**
   * Shows/hides the indicator.
   */
  setVisible(visible: boolean): void;
  
  /**
   * Returns visibility state.
   */
  visible(): boolean;
}

interface IndicatorOptions {
  // Parameters (indicator-specific)
  params: Record<string, number | string | boolean>;
  
  // Style
  style: IndicatorStyleOptions;
  
  // Display
  visible: boolean;
  showInLegend: boolean;
  title: string;
  
  // Pane
  overlay: boolean;             // true = overlay on price, false = separate pane
  paneIndex: number;            // Which pane (if not overlay)
  paneHeight: number;           // Pane height in pixels
}

interface IndicatorStyleOptions {
  // Lines (for line-based indicators)
  colors: ColorType[];
  lineWidths: number[];
  lineStyles: LineStyle[];
  
  // Fills (for band indicators)
  fillColor: ColorType;
  fillOpacity: number;
  
  // Histogram (for histogram indicators)
  histogramBase: number;
  positiveColor: ColorType;
  negativeColor: ColorType;
}

// Indicator-specific value types
interface IndicatorValue {
  time: Time;
  values: Record<string, number>;  // e.g., { value: 50.5 } or { macd: 0.5, signal: 0.3, histogram: 0.2 }
}
```

### 5.2 Indicator type registry
```typescript
type IndicatorType =
  // Trend
  | "sma"
  | "ema"
  | "wma"
  | "dema"
  | "tema"
  // Momentum
  | "rsi"
  | "macd"
  | "stochastic"
  | "cci"
  | "momentum"
  | "roc"
  // Volatility
  | "bollinger"
  | "atr"
  | "keltner"
  | "donchian"
  // Volume
  | "volume"
  | "obv"
  | "vwap"
  | "mfi"
  // Other
  | "ichimoku"
  | "pivots"
  | "adx"
  | "parabolic_sar";

// Parameter schemas per indicator type
const INDICATOR_PARAMS: Record<IndicatorType, ParameterSchema[]> = {
  ema: [
    { key: "period", type: "int", default: 20, min: 1, max: 500 },
    { key: "source", type: "enum", default: "close", options: ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"] },
  ],
  rsi: [
    { key: "period", type: "int", default: 14, min: 1, max: 100 },
    { key: "source", type: "enum", default: "close", options: ["open", "high", "low", "close"] },
  ],
  macd: [
    { key: "fastPeriod", type: "int", default: 12, min: 1, max: 100 },
    { key: "slowPeriod", type: "int", default: 26, min: 1, max: 200 },
    { key: "signalPeriod", type: "int", default: 9, min: 1, max: 50 },
  ],
  bollinger: [
    { key: "period", type: "int", default: 20, min: 1, max: 200 },
    { key: "stdDev", type: "float", default: 2.0, min: 0.1, max: 5.0 },
  ],
  // ... more indicators
};
```

---

## 6) Drawing API

### 6.1 DrawingApi
```typescript
interface DrawingApi {
  // ============ IDENTITY ============
  
  /**
   * Returns the drawing type.
   */
  type(): DrawingType;
  
  /**
   * Returns the unique drawing ID.
   */
  id(): string;
  
  // ============ OPTIONS ============
  
  /**
   * Updates drawing options (style, properties).
   */
  applyOptions(options: DeepPartial<DrawingOptions>): void;
  
  /**
   * Returns current drawing options.
   */
  options(): Readonly<DrawingOptions>;
  
  // ============ ANCHORS ============
  
  /**
   * Returns the anchor points of the drawing.
   */
  anchors(): readonly AnchorPoint[];
  
  /**
   * Updates anchor points.
   */
  setAnchors(anchors: AnchorPoint[]): void;
  
  // ============ STATE ============
  
  /**
   * Returns whether the drawing is selected.
   */
  isSelected(): boolean;
  
  /**
   * Selects/deselects the drawing.
   */
  setSelected(selected: boolean): void;
  
  /**
   * Returns whether the drawing is locked (not editable).
   */
  isLocked(): boolean;
  
  /**
   * Locks/unlocks the drawing.
   */
  setLocked(locked: boolean): void;
  
  /**
   * Returns visibility state.
   */
  visible(): boolean;
  
  /**
   * Shows/hides the drawing.
   */
  setVisible(visible: boolean): void;
  
  // ============ SERIALIZATION ============
  
  /**
   * Returns a JSON-serializable representation of the drawing.
   */
  toJSON(): SerializedDrawing;
}

interface DrawingOptions {
  // Anchor points (in data coordinates)
  anchors: AnchorPoint[];
  
  // Style
  style: DrawingStyleOptions;
  
  // State
  visible: boolean;
  locked: boolean;
  
  // Type-specific options
  [key: string]: any;
}

interface DrawingStyleOptions {
  strokeColor: ColorType;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
  fillColor?: ColorType;
  fillOpacity?: number;
  fontSize?: number;
  fontFamily?: string;
  textColor?: ColorType;
}

interface AnchorPoint {
  time: Time;
  price: number;
}
```

### 6.2 Programmatic drawing creation
```typescript
// Example: Create a trend line programmatically
const trendLine = chart.addDrawing("trend_line", {
  anchors: [
    { time: 1700000000, price: 100 },
    { time: 1700100000, price: 120 },
  ],
  style: {
    strokeColor: "#ff0000",
    strokeWidth: 2,
    strokeStyle: "solid",
  },
  extendLeft: false,
  extendRight: true,
});

// Example: Create Fibonacci retracement
const fib = chart.addDrawing("fib_retracement", {
  anchors: [
    { time: 1700000000, price: 100 },
    { time: 1700100000, price: 150 },
  ],
  levels: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  showPrices: true,
  showPercentages: true,
  style: {
    strokeColor: "#808080",
    strokeWidth: 1,
  },
});
```

---

## 7) Event system

### 7.1 Event types
```typescript
// Crosshair move event
interface CrosshairMoveEventParams {
  time: Time | null;
  point: { x: number; y: number } | null;
  seriesData: Map<SeriesApi<any>, BarData | LineData | null>;
  indicatorData: Map<IndicatorApi, IndicatorValue | null>;
  hoveredSeries: SeriesApi<any> | null;
}

type CrosshairMoveEventHandler = (params: CrosshairMoveEventParams) => void;

// Click event
interface ClickEventParams {
  time: Time | null;
  price: number | null;
  point: { x: number; y: number };
  seriesData: Map<SeriesApi<any>, BarData | LineData | null>;
  hoveredSeries: SeriesApi<any> | null;
  hoveredDrawing: DrawingApi | null;
}

type ClickEventHandler = (params: ClickEventParams) => void;

// Double-click event
interface DblClickEventParams extends ClickEventParams {}

type DblClickEventHandler = (params: DblClickEventParams) => void;

// Time range change event
interface TimeRangeChangeEventParams {
  from: Time;
  to: Time;
  visibleBars: number;
}

type TimeRangeChangeEventHandler = (params: TimeRangeChangeEventParams) => void;

// Visible range change (logical range)
interface VisibleLogicalRangeChangeEventParams {
  from: number | null;
  to: number | null;
}

type VisibleLogicalRangeChangeEventHandler = (params: VisibleLogicalRangeChangeEventParams) => void;

// Drawing events
interface DrawingEventParams {
  drawing: DrawingApi;
  action: "created" | "modified" | "deleted" | "selected" | "deselected";
}

type DrawingEventHandler = (params: DrawingEventParams) => void;
```

### 7.2 Time scale events
```typescript
interface TimeScaleApi {
  // ... other methods ...
  
  /**
   * Subscribes to visible time range changes.
   */
  subscribeVisibleTimeRangeChange(handler: TimeRangeChangeEventHandler): void;
  
  /**
   * Unsubscribes from visible time range changes.
   */
  unsubscribeVisibleTimeRangeChange(handler: TimeRangeChangeEventHandler): void;
  
  /**
   * Subscribes to visible logical range changes.
   */
  subscribeVisibleLogicalRangeChange(handler: VisibleLogicalRangeChangeEventHandler): void;
  
  /**
   * Unsubscribes from visible logical range changes.
   */
  unsubscribeVisibleLogicalRangeChange(handler: VisibleLogicalRangeChangeEventHandler): void;
}
```

---

## 8) Time scale API

```typescript
interface TimeScaleApi {
  // ============ OPTIONS ============
  
  /**
   * Updates time scale options.
   */
  applyOptions(options: DeepPartial<TimeScaleOptions>): void;
  
  /**
   * Returns current time scale options.
   */
  options(): Readonly<TimeScaleOptions>;
  
  // ============ VISIBLE RANGE ============
  
  /**
   * Returns the currently visible time range.
   */
  getVisibleRange(): TimeRange | null;
  
  /**
   * Sets the visible time range.
   */
  setVisibleRange(range: TimeRange): void;
  
  /**
   * Returns the visible logical range (bar indices).
   */
  getVisibleLogicalRange(): LogicalRange | null;
  
  /**
   * Sets the visible logical range.
   */
  setVisibleLogicalRange(range: LogicalRange): void;
  
  // ============ NAVIGATION ============
  
  /**
   * Scrolls the chart to show the specified time.
   */
  scrollToTime(time: Time, animated?: boolean): void;
  
  /**
   * Scrolls the chart by the specified number of bars.
   */
  scrollBy(bars: number, animated?: boolean): void;
  
  /**
   * Resets the time scale to show all data.
   */
  fitContent(): void;
  
  /**
   * Resets zoom to default bar spacing.
   */
  resetZoom(): void;
  
  // ============ CONVERSION ============
  
  /**
   * Converts time to x coordinate.
   */
  timeToCoordinate(time: Time): number | null;
  
  /**
   * Converts x coordinate to time.
   */
  coordinateToTime(x: number): Time | null;
  
  /**
   * Converts logical index to x coordinate.
   */
  logicalToCoordinate(logical: number): number | null;
  
  /**
   * Converts x coordinate to logical index.
   */
  coordinateToLogical(x: number): number | null;
}

interface TimeRange {
  from: Time;
  to: Time;
}

interface LogicalRange {
  from: number;
  to: number;
}
```

---

## 9) React wrapper

### 9.1 Component API
```typescript
import { ChartOptions, SeriesApi, IndicatorApi } from "@anthropic/delta-chart";

interface ChartProps {
  // Options
  options?: DeepPartial<ChartOptions>;
  
  // Data
  data?: CandlestickData[] | LineData[];
  seriesType?: "candlestick" | "line" | "area" | "baseline";
  
  // Indicators
  indicators?: IndicatorConfig[];
  
  // Drawings
  drawings?: DrawingConfig[];
  
  // Callbacks
  onCrosshairMove?: (params: CrosshairMoveEventParams) => void;
  onClick?: (params: ClickEventParams) => void;
  onDblClick?: (params: DblClickEventParams) => void;
  onTimeRangeChange?: (params: TimeRangeChangeEventParams) => void;
  
  // Ref
  chartRef?: React.RefObject<ChartApi>;
  
  // Container
  className?: string;
  style?: React.CSSProperties;
}

interface IndicatorConfig {
  type: IndicatorType;
  options?: DeepPartial<IndicatorOptions>;
}

interface DrawingConfig {
  type: DrawingType;
  options: DrawingOptions;
}
```

### 9.2 Usage example
```tsx
import { Chart } from "@anthropic/delta-chart-react";

function TradingChart() {
  const chartRef = useRef<ChartApi>(null);
  const [data, setData] = useState<CandlestickData[]>([]);
  
  // Streaming updates
  useEffect(() => {
    const ws = new WebSocket("wss://feed.example.com");
    ws.onmessage = (event) => {
      const tick = JSON.parse(event.data);
      chartRef.current?.series().update(tick);
    };
    return () => ws.close();
  }, []);
  
  return (
    <Chart
      chartRef={chartRef}
      options={{
        theme: "dark",
        timeScale: {
          rightOffset: 10,
        },
      }}
      data={data}
      seriesType="candlestick"
      indicators={[
        { type: "ema", options: { params: { period: 20 } } },
        { type: "rsi", options: { params: { period: 14 }, overlay: false } },
      ]}
      onCrosshairMove={(params) => {
        console.log("Crosshair:", params.time, params.seriesData);
      }}
      onClick={(params) => {
        console.log("Click:", params.time, params.price);
      }}
      className="trading-chart"
      style={{ width: "100%", height: 600 }}
    />
  );
}
```

### 9.3 Hooks
```typescript
// Hook for accessing chart API
function useChart(): ChartApi | null;

// Hook for subscribing to crosshair
function useCrosshair(): CrosshairMoveEventParams | null;

// Hook for subscribing to visible range
function useVisibleRange(): TimeRange | null;

// Example usage
function ChartTooltip() {
  const crosshair = useCrosshair();
  
  if (!crosshair?.time) return null;
  
  const mainSeriesData = crosshair.seriesData.values().next().value;
  
  return (
    <div className="tooltip">
      <div>O: {mainSeriesData?.open}</div>
      <div>H: {mainSeriesData?.high}</div>
      <div>L: {mainSeriesData?.low}</div>
      <div>C: {mainSeriesData?.close}</div>
    </div>
  );
}
```

---

## 10) Error handling

### 10.1 Error types
```typescript
class DeltaChartError extends Error {
  constructor(
    message: string,
    public readonly code: DeltaChartErrorCode,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = "DeltaChartError";
  }
}

enum DeltaChartErrorCode {
  // Initialization
  CONTAINER_NOT_FOUND = "CONTAINER_NOT_FOUND",
  WEBGPU_NOT_SUPPORTED = "WEBGPU_NOT_SUPPORTED",
  DEVICE_LOST = "DEVICE_LOST",
  
  // Data
  INVALID_DATA = "INVALID_DATA",
  DATA_OUT_OF_ORDER = "DATA_OUT_OF_ORDER",
  
  // Series
  SERIES_NOT_FOUND = "SERIES_NOT_FOUND",
  SERIES_TYPE_MISMATCH = "SERIES_TYPE_MISMATCH",
  
  // Indicators
  INDICATOR_NOT_FOUND = "INDICATOR_NOT_FOUND",
  INVALID_INDICATOR_PARAMS = "INVALID_INDICATOR_PARAMS",
  
  // Drawings
  DRAWING_NOT_FOUND = "DRAWING_NOT_FOUND",
  INVALID_ANCHOR_POINTS = "INVALID_ANCHOR_POINTS",
}
```

### 10.2 Error callbacks
```typescript
interface ChartOptions {
  // ... other options ...
  
  /**
   * Called when an error occurs.
   * Return true to suppress the error, false to throw.
   */
  onError?: (error: DeltaChartError) => boolean;
  
  /**
   * Called when the renderer tier changes (e.g., downgrade on device loss).
   */
  onTierChange?: (newTier: "A" | "B" | "C" | "D", reason: string) => void;
}
```

---

## 11) TypeScript utilities

### 11.1 Type helpers
```typescript
// Deep partial type for options
type DeepPartial<T> = T extends object ? {
  [P in keyof T]?: DeepPartial<T[P]>;
} : T;

// Color type (accepts string or gradient)
type ColorType = string | GradientColor;

interface GradientColor {
  type: "linear" | "radial";
  stops: Array<{ offset: number; color: string }>;
  angle?: number;  // for linear
}

// Time type (accepts multiple formats)
type Time = UTCTimestamp | BusinessDay | string;

type UTCTimestamp = number;  // Unix timestamp in seconds

interface BusinessDay {
  year: number;
  month: number;
  day: number;
}

// Line style
type LineStyle = 
  | 0  // Solid
  | 1  // Dotted
  | 2  // Dashed
  | 3  // Large dashed
  | 4; // Sparse dotted
```

---

## 12) Implementation checklist

- [ ] Core `createChart` function and ChartApi
- [ ] ChartOptions with all configuration groups
- [ ] Theme system (light/dark/custom)
- [ ] Series API (candlestick, line, area, baseline, histogram)
- [ ] Series data management (setData, update)
- [ ] Indicator API with 15 MVP indicators
- [ ] Drawing API with 15 MVP tools
- [ ] Event system (crosshair, click, dblclick, range change)
- [ ] Time scale API (navigation, conversion)
- [ ] Price scale API
- [ ] React wrapper component
- [ ] React hooks (useChart, useCrosshair, useVisibleRange)
- [ ] TypeScript definitions with full documentation
- [ ] Error handling and error types
- [ ] Screenshot functionality
