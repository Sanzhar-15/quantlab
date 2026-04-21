import type {
  AxisId,
  AxisOptions,
  ChartPlugin,
  CrosshairState,
  ExportPngOptions,
  ExportPngResult,
  MemoryBudgetOptions,
  PaneId,
  ThemeTokens,
  TimeMs,
  VisibleTimeRange,
} from './api';
import type { LayoutResult, Rect } from './layout-engine';
import type { InvalidationFlag } from './invalidation';

/**
 * Renderer capability tier.
 * - Tier A: WebGPU in Worker (SharedArrayBuffer available)
 * - Tier B: WebGPU on Main Thread
 * - Tier C: WebGL2 (future)
 * - Tier D: Canvas2D (always available)
 */
export type RendererTier = 'A' | 'B' | 'C' | 'D';

/**
 * Options for initializing a renderer.
 */
export interface RendererOptions {
  width?: number;
  height?: number;
  autoSize?: boolean;
  pixelRatio?: number;
  theme?: ThemeTokens;
  timeFormatter?: (time: TimeMs) => string;
  gapThresholdMs?: number;
  rawRetentionMs?: number;
  memory?: MemoryBudgetOptions;
}

/**
 * Series data snapshot for rendering.
 * This is a simplified view of series data that renderers can consume.
 */
export interface SeriesRenderData {
  id: string;
  seriesType: 'line' | 'area' | 'baseline' | 'histogram' | 'candlestick' | 'bar' | 'custom';
  paneId: PaneId;
  axis: AxisId;
  visible: boolean;
  // Data arrays (columnar format, optimal for GPU)
  time: Float64Array;
  value: Float64Array | null; // null for OHLC series
  open?: Float64Array;
  high?: Float64Array;
  low?: Float64Array;
  close?: Float64Array;
  volume?: Float64Array;
  color?: Float32Array; // Per-point colors (for histograms)
  length: number;
  // Options
  options: Record<string, unknown>; // Series-specific options
}

/**
 * Core renderer interface that all backends must implement.
 * This abstraction enables multi-backend support (Canvas2D, WebGPU, WebGL2).
 */
export interface ChartRenderer {
  /** The capability tier of this renderer. */
  readonly tier: RendererTier;

  /**
   * Initialize the renderer with a container element and options.
   * Called once when the chart is created.
   */
  initialize(container: HTMLElement, options: RendererOptions): void;

  /**
   * Destroy the renderer and clean up resources.
   * Called when the chart is destroyed.
   */
  destroy(): void;

  /**
   * Update the theme.
   * Called when theme changes.
   */
  setTheme(theme: ThemeTokens): void;

  /**
   * Update the layout (panes, axes, plot areas).
   * Called when layout changes.
   */
  setLayout(layout: LayoutResult): void;

  /**
   * Add a series to the renderer.
   * Called when a new series is added to the chart.
   */
  addSeries(series: SeriesRenderData): void;

  /**
   * Remove a series from the renderer.
   * Called when a series is removed from the chart.
   */
  removeSeries(seriesId: string): void;

  /**
   * Update series data.
   * Called when series data changes (append, patch, etc.).
   */
  updateSeries(seriesId: string, data: SeriesRenderData): void;

  /**
   * Set axis options for a global axis (left/right).
   * Called when axis options change.
   */
  setAxisOptions(axis: AxisId, options: AxisOptions): void;

  /**
   * Set axis options for a pane-specific axis.
   * Called when pane axis options change.
   */
  setPaneAxisOptions(paneId: PaneId, axis: AxisId, options: AxisOptions): void;

  /**
   * Set the visible time range.
   * Called when the user pans/zooms or programmatically sets the range.
   */
  setVisibleTimeRange(range: VisibleTimeRange): void;

  /**
   * Set the crosshair state.
   * Called when the crosshair moves or is hidden.
   */
  setCrosshair(state: CrosshairState | null): void;

  /**
   * Render a frame.
   * Called by the frame scheduler on each animation frame.
   * @param frameTime The current frame time (performance.now()).
   */
  render(frameTime: number): void;

  /**
   * Invalidate specific parts of the renderer.
   * Called when data or state changes that require a redraw.
   * @param flags Bit flags indicating what needs to be invalidated.
   */
  invalidate(flags: InvalidationFlag): void;

  /**
   * Export the chart as a PNG image.
   * @param options Export options (pixel ratio, deterministic, etc.).
   * @returns A promise that resolves to the PNG blob or data URL.
   */
  exportPng(options?: ExportPngOptions): Promise<ExportPngResult>;

  /**
   * Add a plugin to the renderer.
   * Plugins can hook into render passes (underlay, overlay) and pointer events.
   */
  addPlugin(plugin: ChartPlugin): void;

  /**
   * Remove a plugin from the renderer.
   */
  removePlugin(plugin: ChartPlugin): void;
}

