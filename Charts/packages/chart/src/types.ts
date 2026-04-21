/**
 * Public API types for Charts+ Advanced.
 */

import type {
  TimeMs,
  VisibleTimeRange,
  CrosshairState,
  ThemeTokens,
  DataPoint,
  OhlcDataPoint,
  HistogramDataPoint,
  AxisOptions,
  PaneId,
} from '@charts-plus/chart-core';
import type {
  IndicatorInstance,
  IndicatorResult,
  IndicatorStyle,
} from '@charts-plus/chart-indicators';
import type {
  Drawing,
  DrawingType,
  AnchorPoint,
  DrawingStyle,
} from '@charts-plus/chart-drawings';

/**
 * Chart options for creating a chart.
 */
export interface ChartOptions {
  container: HTMLElement;
  width?: number;
  height?: number;
  theme?: ThemeTokens | 'light' | 'dark';
  autoSize?: boolean;
  timeFormatter?: (time: TimeMs) => string;
  gapThresholdMs?: number;
  rawRetentionMs?: number;
}

/**
 * Series type.
 */
export type SeriesType = 'candlestick' | 'line' | 'area' | 'histogram' | 'bar';

/**
 * Series options.
 */
export interface SeriesOptions {
  paneId?: PaneId;
  axis?: 'left' | 'right';
  visible?: boolean;
  title?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  priceLineVisible?: boolean;
  priceLineSource?: 'last' | 'close';
  // Type-specific options
  upColor?: string;
  downColor?: string;
  wickColor?: string;
  borderVisible?: boolean;
  [key: string]: any;
}

/**
 * Indicator options.
 */
export interface IndicatorOptions {
  type: string;
  params: Record<string, any>;
  style?: IndicatorStyle;
  overlay?: boolean;
  paneId?: PaneId;
}

/**
 * Drawing options.
 */
export interface DrawingOptions {
  type: DrawingType;
  anchors: AnchorPoint[];
  style?: Partial<DrawingStyle>;
  paneId?: PaneId;
  seriesId?: string;
}

/**
 * Chart event types.
 */
export type ChartEventType =
  | 'crosshair'
  | 'timeRangeChange'
  | 'drawingCreated'
  | 'drawingUpdated'
  | 'drawingDeleted'
  | 'seriesAdded'
  | 'seriesRemoved'
  | 'indicatorAdded'
  | 'indicatorRemoved';

/**
 * Chart event handlers.
 */
export interface ChartEventHandlers {
  crosshair?: (state: CrosshairState | null) => void;
  timeRangeChange?: (range: VisibleTimeRange) => void;
  drawingCreated?: (drawing: Drawing) => void;
  drawingUpdated?: (drawing: Drawing) => void;
  drawingDeleted?: (drawingId: string) => void;
  seriesAdded?: (seriesId: string) => void;
  seriesRemoved?: (seriesId: string) => void;
  indicatorAdded?: (instanceId: string) => void;
  indicatorRemoved?: (instanceId: string) => void;
}

/**
 * Chart API interface.
 */
export interface ChartApi {
  // Series API
  addSeries(type: SeriesType, options?: SeriesOptions): Promise<string>;
  removeSeries(seriesId: string): Promise<void>;
  updateSeries(seriesId: string, data: DataPoint[] | OhlcDataPoint[] | HistogramDataPoint[]): Promise<void>;
  setSeriesVisible(seriesId: string, visible: boolean): Promise<void>;

  // Indicator API
  addIndicator(type: string, params: Record<string, any>, style?: IndicatorStyle): string;
  removeIndicator(instanceId: string): void;
  updateIndicatorParams(instanceId: string, params: Record<string, any>): void;
  getIndicatorResult(instanceId: string): IndicatorResult | null;

  // Drawing API
  addDrawing(type: DrawingType, anchors: AnchorPoint[], style?: Partial<DrawingStyle>): string;
  removeDrawing(drawingId: string): void;
  updateDrawing(drawingId: string, updates: Partial<Drawing>): void;
  getAllDrawings(): Drawing[];
  getSelectedDrawings(): Drawing[];

  // Event API
  on(event: ChartEventType, handler: Function): void;
  off(event: ChartEventType, handler: Function): void;

  // Control API
  setVisibleTimeRange(range: VisibleTimeRange): void;
  getVisibleTimeRange(): VisibleTimeRange;
  setTheme(theme: ThemeTokens | 'light' | 'dark'): void;
  resize(width: number, height: number): void;

  // Lifecycle
  destroy(): void;
}

