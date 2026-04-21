/**
 * Main exports for @charts-plus/chart-core package.
 */

// Utility function
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// API Types
export type {
  TimeMs,
  DataPoint,
  OhlcDataPoint,
  HistogramDataPoint,
  VisibleTimeRange,
  CrosshairMode,
  SeriesMarker,
  SeriesMarkerShape,
  SeriesMarkerPosition,
  WatermarkOptions,
  WatermarkPosition,
  SeriesRendererMode,
  AxisId,
  TimeZone,
  PaneId,
  LineRenderMode,
  SeriesSampleMode,
  PriceLineStyle,
  PriceLineSource,
  AxisOptions,
  InertiaOptions,
  PanOptions,
  HandleScrollOptions,
  HandleScaleOptions,
  InteractionOptions,
  CrosshairOptions,
  PaneResizeOptions,
  PaneOptions,
  TimeScaleConfig,
  MemoryBudgetOptions,
  ThemeTokens,
  ThemeTokensInput,
  CrosshairState,
  CrosshairMoveEvent,
  ExportPngOptions,
  ExportPngResult,
  ChartPlugin,
  CreateChartOptions,
  CustomSeriesRenderer,
  // V7 Phase 4: Scroll boundaries
  DataExtent,
  ScrollBounds,
  PluginPointerEvent,
  PluginRenderState,
  LineSeriesOptions,
  AreaSeriesOptions,
  BaselineSeriesOptions,
  HistogramSeriesOptions,
  CandlestickSeriesOptions,
  BarSeriesOptions,
  CustomSeriesOptions,
  LineSeries,
  AreaSeries,
  BaselineSeries,
  HistogramSeries,
  CandlestickSeries,
  BarSeries,
  CustomSeries,
  PaneApi,
  Chart,
  GridOptions,
} from './api';

// Renderer Interface
export type {
  RendererTier,
  RendererOptions,
  SeriesRenderData,
  ChartRenderer,
} from './renderer-interface';

// Tier Detection
export {
  detectCapabilityTier,
  getTierDescription,
} from './tier-detection';

// Renderer Factory
export {
  createRenderer,
  createRendererSync,
} from './renderer-factory';

// Multi-chart synchronization
export { SyncController, getGlobalSyncController, resetGlobalSyncController } from './sync-controller';
export type { SyncMode, SyncGroupConfig, SyncEvent } from './sync-controller';

// Time Intervals (new for unified axis system)
export type { TimeInterval } from './time-intervals';
export { TIME_INTERVALS, createTimeStepProvider, formatTimeLabel } from './time-intervals';

// Axis Scale Interface (new for unified axis system)
export type { IAxisScale } from './axis-scale';

// StepProviderResult (new for unified axis system)
export type { StepProviderResult } from './tick-types';

// Spring physics
export {
  advanceSpring,
  createSpringState,
  setSpringTarget,
  snapSpring,
  SpringPresets,
  SpringAnimation,
  Spring2D,
} from './spring';
export type { SpringConfig, SpringState } from './spring';

// Rubber-band overscroll
export {
  applyRubberBandResistance,
  rubberBandClamp,
  getOverscrollAmount,
  isOverscrolled,
  getSnapBackTarget,
  RubberBandPresets,
  RubberBandController,
} from './rubber-band';
export type { RubberBandConfig, RubberBandControllerConfig } from './rubber-band';

// Accessibility
export {
  getAccessibilityManager,
  prefersReducedMotion,
  adjustSpringForAccessibility,
  adjustRubberBandForAccessibility,
  adjustFrictionForAccessibility,
  adjustDurationForAccessibility,
  getMomentumFriction,
  getMinVelocity,
  shouldSmoothCrosshair,
  shouldUseRubberBand,
  getAnimationMultiplier,
  AccessibilityDefaults,
} from './accessibility';
export type { AccessibilityConfig } from './accessibility';

// Instrumentation
export {
  PerformanceMonitor,
  DebugOverlay,
  getInstrumentation,
  installDebugAPI,
} from './instrumentation';
export type { FrameMetrics, PerformanceStats } from './instrumentation';

// Invalidation
export {
  InvalidationFlag,
  mergeInvalidation,
  hasInvalidation,
} from './invalidation';

// Performance & Memory (legacy - use instrumentation instead)
export {
  type PerformanceMetrics,
} from './performance-monitor';

export {
  MemoryManager,
  type MemoryBudgetOptions as MemoryBudgetOptionsType,
} from './memory-manager';

// Error Handling
export {
  ErrorScope,
  GlobalErrorHandler,
  globalErrorHandler,
} from './error-handler';

// Feature Flags
export {
  FeatureFlagsManager,
  featureFlags,
  type FeatureFlagsConfig,
  type FeatureFlagValue,
} from './feature-flags';

// Data Structures
export {
  DataStore,
  type DataStoreOptions,
} from './data-store';

export {
  OhlcDataStore,
  type OhlcDataStoreOptions,
} from './ohlc-data-store';

export {
  ChunkedDataStore,
  type ChunkedDataStoreOptions,
  type ChunkStats,
} from './chunked-data-store';

// LOD
export {
  LodPyramid,
  type LodPyramidOptions,
} from './lod-pyramid';

export {
  OhlcLodPyramid,
  type OhlcLodPyramidOptions,
} from './ohlc-lod-pyramid';

// Scales
export {
  TimeScale,
  type TimeScaleOptions,
} from './time-scale';

export {
  PriceScale,
  type PriceScaleOptions,
  type PriceScaleMode,
  applyPriceScaleMode,
} from './price-scale';

export {
  NumericScale,
  type NumericScaleOptions,
} from './numeric-scale';

// Horizontal Scale
export type {
  HorizontalScale,
  HorizontalScaleOptions,
} from './horizontal-scale';

// Layout
export {
  LayoutEngine,
  type LayoutOptions,
  type LayoutResult,
  type Rect,
} from './layout-engine';

// Decimation
export {
  LineDecimator,
  type LineDecimatorOptions,
} from './line-decimator';

export {
  OhlcDecimator,
  type OhlcDecimatorOptions,
} from './ohlc-decimator';

export {
  ChunkedLineDecimator,
  type ChunkedLineDecimatorOptions,
} from './chunked-line-decimator';

// Frame Scheduler
export {
  FrameScheduler,
  type FrameSchedulerOptions,
  type InputIntent,
} from './frame-scheduler';

// Theme
export {
  normalizeThemeTokens,
  type ThemeTokenKey,
  DEFAULT_THEME_TOKENS,
  THEME_TOKEN_KEYS,
} from './theme';

// Theme Presets
export {
  getThemePreset,
  type ThemePresetName,
} from './presets';

// Binary Search
export {
  lowerBound,
  upperBound,
} from './binary-search';

// Data Provider
export type {
  DataProvider,
  DataProviderOptions,
  DataProviderUpdate,
} from './data-provider';

// Unified Tick System
export type {
  Tick,
  HysteresisConfig,
  TickGeneratorState,
  TickGeneratorConfig,
} from './tick-types';

export {
  DEFAULT_PRICE_HYSTERESIS,
  DEFAULT_TIME_HYSTERESIS,
  DEFAULT_TICK_CONFIG,
} from './tick-types';

export {
  niceStep,
  financialNiceStep,
  quantizeToTickSize,
  getStepBase,
  getMinorCount,
  getMinorStep,
} from './nice-numbers';

export {
  pickStepWithHysteresis,
  TickGenerator,
} from './tick-generator';

// V7 Phase 4: Scroll Boundaries
export type { DataExtent, ScrollBounds } from './scroll-bounds';
export { calculateScrollBounds, clampToBounds, MIN_VISIBLE_BARS } from './scroll-bounds';
