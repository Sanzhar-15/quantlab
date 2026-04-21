/**
 * Chart class implementation with public API.
 */

import type {
  ChartApi,
  ChartOptions,
  SeriesOptions,
  SeriesType,
  IndicatorOptions,
  DrawingOptions,
  ChartEventType,
  ChartEventHandlers,
} from './types';
import type {
  TimeMs,
  VisibleTimeRange,
  CrosshairState,
  ThemeTokens,
  DataPoint,
  OhlcDataPoint,
  HistogramDataPoint,
  SeriesRenderData,
  RendererOptions,
} from '@charts-plus/chart-core';
import type { ChartRenderer, RendererTier } from '@charts-plus/chart-core';
import { createRenderer, detectCapabilityTier } from '@charts-plus/chart-core';
import type { IndicatorInstance, IndicatorResult, IndicatorStyle } from '@charts-plus/chart-indicators';
import {
  IndicatorRegistry,
  createDefaultRegistry,
  ComputationEngine,
} from '@charts-plus/chart-indicators';
import type { Drawing, DrawingType, AnchorPoint, DrawingStyle } from '@charts-plus/chart-drawings';
import { DrawingManager } from '@charts-plus/chart-drawings';
import { CoordinateTransformImpl } from '@charts-plus/chart-drawings';

/**
 * Chart class implementing ChartApi.
 */
export class Chart implements ChartApi {
  private container: HTMLElement;
  private renderer: ChartRenderer | null = null;
  private options: ChartOptions;
  private eventHandlers = new Map<ChartEventType, Set<Function>>();
  private seriesMap = new Map<string, { type: SeriesType; options: SeriesOptions }>();
  private indicatorRegistry!: IndicatorRegistry;
  private computationEngine!: ComputationEngine;
  private drawingManager!: DrawingManager;
  private visibleTimeRange: VisibleTimeRange | null = null;
  private crosshairState: CrosshairState | null = null;

  private initPromise: Promise<void> | null = null;
  private initialized = false;

  public constructor(container: HTMLElement, options: ChartOptions) {
    this.container = container;
    this.options = options;

    // Start async initialization
    this.initPromise = this.initializeAsync();
  }

  private async initializeAsync(): Promise<void> {
    // Detect renderer tier
    const tier = await detectCapabilityTier();
    
    const rendererOptions: RendererOptions = {
      autoSize: this.options.autoSize ?? true,
      theme: this.normalizeTheme(this.options.theme),
      ...(this.options.width !== undefined && { width: this.options.width }),
      ...(this.options.height !== undefined && { height: this.options.height }),
      ...(this.options.timeFormatter !== undefined && { timeFormatter: this.options.timeFormatter }),
      ...(this.options.gapThresholdMs !== undefined && { gapThresholdMs: this.options.gapThresholdMs }),
      ...(this.options.rawRetentionMs !== undefined && { rawRetentionMs: this.options.rawRetentionMs }),
    };
    
    this.renderer = await createRenderer(this.container, rendererOptions, tier);

    // Initialize renderer
    this.renderer.initialize(this.container, rendererOptions);

    // Initialize indicator system
    this.indicatorRegistry = createDefaultRegistry();
    this.computationEngine = new ComputationEngine(this.indicatorRegistry);
    this.computationEngine.setRendererTier(tier);

    // Initialize drawing manager
    this.drawingManager = new DrawingManager();

    // Set up event forwarding
    this.setupEventForwarding();

    this.initialized = true;
  }

  /**
   * Wait for initialization to complete.
   */
  public async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Add a series.
   */
  public async addSeries(type: SeriesType, options: SeriesOptions = {}): Promise<string> {
    await this.waitForInit();
    
    if (!this.renderer) {
      throw new Error('Renderer not initialized');
    }
    
    const seriesId = `series-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.seriesMap.set(seriesId, { type, options });

    // Convert to render data
    const renderData: SeriesRenderData = {
      id: seriesId,
      seriesType: type,
      paneId: options.paneId || 'main',
      axis: options.axis || 'right',
      visible: options.visible ?? true,
      time: new Float64Array(0),
      value: null,
      length: 0,
      options,
    };

    this.renderer.addSeries(renderData);
    this.emitEvent('seriesAdded', seriesId);
    return seriesId;
  }

  /**
   * Remove a series.
   */
  public async removeSeries(seriesId: string): Promise<void> {
    await this.waitForInit();
    
    if (!this.seriesMap.has(seriesId)) {
      return;
    }

    if (!this.renderer) {
      throw new Error('Renderer not initialized');
    }

    this.seriesMap.delete(seriesId);
    this.renderer.removeSeries(seriesId);
    this.emitEvent('seriesRemoved', seriesId);
  }

  /**
   * Update series data.
   */
  public async updateSeries(
    seriesId: string,
    data: DataPoint[] | OhlcDataPoint[] | HistogramDataPoint[],
  ): Promise<void> {
    await this.waitForInit();
    
    const series = this.seriesMap.get(seriesId);
    if (!series) {
      throw new Error(`Series ${seriesId} not found`);
    }

    // Convert data to render format
    const time = new Float64Array(data.length);
    let value: Float64Array | null = null;
    let open: Float64Array | undefined;
    let high: Float64Array | undefined;
    let low: Float64Array | undefined;
    let close: Float64Array | undefined;
    let volume: Float64Array | undefined;

    if ('t' in data[0]! && 'v' in data[0]!) {
      // DataPoint or HistogramDataPoint
      value = new Float64Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const point = data[i]!;
        time[i] = point.t;
        if ('v' in point) {
          value[i] = point.v ?? NaN;
        }
      }
    } else if ('t' in data[0]! && 'o' in data[0]!) {
      // OhlcDataPoint
      open = new Float64Array(data.length);
      high = new Float64Array(data.length);
      low = new Float64Array(data.length);
      close = new Float64Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const point = data[i]! as OhlcDataPoint;
        time[i] = point.t;
        open[i] = point.o;
        high[i] = point.h;
        low[i] = point.l;
        close[i] = point.c;
      }
    }

    if (!this.renderer) {
      throw new Error('Renderer not initialized');
    }

    const renderData: SeriesRenderData = {
      id: seriesId,
      seriesType: series.type,
      paneId: series.options.paneId || 'main',
      axis: series.options.axis || 'right',
      visible: series.options.visible ?? true,
      time,
      value,
      length: data.length,
      options: series.options,
      ...(open !== undefined && { open }),
      ...(high !== undefined && { high }),
      ...(low !== undefined && { low }),
      ...(close !== undefined && { close }),
      ...(volume !== undefined && { volume }),
    };

    this.renderer.updateSeries(seriesId, renderData);
  }

  /**
   * Set series visibility.
   */
  public async setSeriesVisible(seriesId: string, visible: boolean): Promise<void> {
    await this.waitForInit();
    
    const series = this.seriesMap.get(seriesId);
    if (!series) {
      return;
    }

    series.options.visible = visible;
    // Get current series data and update visibility
    // For now, we'll need to track the current render data
    // This is a simplified version - in production, we'd cache render data
    const currentData = this.seriesMap.get(seriesId);
    if (currentData) {
      // Re-fetch or reconstruct render data with updated visibility
      // This is a placeholder - proper implementation would cache render data
    }
  }

  /**
   * Add an indicator.
   */
  public addIndicator(type: string, params: Record<string, any>, style?: IndicatorStyle): string {
    const definition = this.indicatorRegistry.get(type);
    if (!definition) {
      throw new Error(`Indicator type ${type} not found`);
    }

    // Validate params
    const validatedParams = this.indicatorRegistry.validateParams(type, params);

    const instance: IndicatorInstance = {
      instanceId: `indicator-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      indicatorId: type,
      seriesId: 'main', // TODO: Get from context
      params: validatedParams,
      ...(style !== undefined && { style }),
    };

    this.computationEngine.addInstance(instance);
    this.emitEvent('indicatorAdded', instance.instanceId);
    return instance.instanceId;
  }

  /**
   * Remove an indicator.
   */
  public removeIndicator(instanceId: string): void {
    this.computationEngine.removeInstance(instanceId);
    this.emitEvent('indicatorRemoved', instanceId);
  }

  /**
   * Update indicator parameters.
   */
  public updateIndicatorParams(instanceId: string, params: Record<string, any>): void {
    this.computationEngine.updateInstanceParams(instanceId, params);
  }

  /**
   * Get indicator result.
   */
  public getIndicatorResult(instanceId: string): IndicatorResult | null {
    return this.computationEngine.getResult(instanceId);
  }

  /**
   * Add a drawing.
   */
  public addDrawing(type: DrawingType, anchors: AnchorPoint[], style?: Partial<DrawingStyle>): string {
    const drawing = this.drawingManager.createDrawing(type, anchors, style);
    this.emitEvent('drawingCreated', drawing);
    return drawing.id;
  }

  /**
   * Remove a drawing.
   */
  public removeDrawing(drawingId: string): void {
    this.drawingManager.deleteDrawing(drawingId);
    this.emitEvent('drawingDeleted', drawingId);
  }

  /**
   * Update a drawing.
   */
  public updateDrawing(drawingId: string, updates: Partial<Drawing>): void {
    const drawing = this.drawingManager.getDrawing(drawingId);
    if (!drawing) {
      throw new Error(`Drawing ${drawingId} not found`);
    }

    const updated = { ...drawing, ...updates };
    this.drawingManager.updateDrawing(updated);
    this.emitEvent('drawingUpdated', updated);
  }

  /**
   * Get all drawings.
   */
  public getAllDrawings(): Drawing[] {
    return this.drawingManager.getAllDrawings();
  }

  /**
   * Get selected drawings.
   */
  public getSelectedDrawings(): Drawing[] {
    return this.drawingManager.getSelectedDrawings();
  }

  /**
   * Register event handler.
   */
  public on(event: ChartEventType, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unregister event handler.
   */
  public off(event: ChartEventType, handler: Function): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Set visible time range.
   */
  public setVisibleTimeRange(range: VisibleTimeRange): void {
    this.visibleTimeRange = range;
    if (this.renderer) {
      this.renderer.setVisibleTimeRange(range);
    }
    this.emitEvent('timeRangeChange', range);
  }

  /**
   * Get visible time range.
   */
  public getVisibleTimeRange(): VisibleTimeRange {
    return this.visibleTimeRange || { from: 0, to: Date.now() };
  }

  /**
   * Set theme.
   */
  public setTheme(theme: ThemeTokens | 'light' | 'dark'): void {
    this.options.theme = theme;
    const normalized = this.normalizeTheme(theme);
    if (this.renderer) {
      this.renderer.setTheme(normalized);
    }
  }

  /**
   * Resize chart.
   */
  public resize(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;
    // Renderer handles resize automatically if autoSize is enabled
  }

  /**
   * Destroy chart.
   */
  public destroy(): void {
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
    this.eventHandlers.clear();
    this.seriesMap.clear();
    this.computationEngine = null as any;
    this.drawingManager = null as any;
  }

  /**
   * Normalize theme.
   */
  private normalizeTheme(theme?: ThemeTokens | 'light' | 'dark'): ThemeTokens {
    if (typeof theme === 'string') {
      // TODO: Load predefined themes
      return this.getDefaultTheme(theme);
    }
    return theme || this.getDefaultTheme('dark');
  }

  /**
   * Get default theme.
   */
  private getDefaultTheme(name: 'light' | 'dark'): ThemeTokens {
    if (name === 'light') {
      return {
        background: '#ffffff',
        gridMajor: '#e0e0e0',
        gridMinor: '#f0f0f0',
        axisText: '#000000',
        crosshair: '#2962ff',
        focusBand: 'rgba(41, 98, 255, 0.1)',
        seriesPrimary: '#2962ff',
        seriesSecondary: '#f23645',
        seriesTertiary: '#089981',
        seriesQuaternary: '#ff6d00',
        seriesQuinary: '#9c27b0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSizePx: 12,
      };
    } else {
      return {
        background: '#1e1e1e',
        gridMajor: '#2d2d2d',
        gridMinor: '#262626',
        axisText: '#ffffff',
        crosshair: '#2962ff',
        focusBand: 'rgba(41, 98, 255, 0.1)',
        seriesPrimary: '#2962ff',
        seriesSecondary: '#f23645',
        seriesTertiary: '#089981',
        seriesQuaternary: '#ff6d00',
        seriesQuinary: '#9c27b0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSizePx: 12,
      };
    }
  }

  /**
   * Setup event forwarding from renderer and subsystems.
   */
  private setupEventForwarding(): void {
    // Forward drawing manager events
    this.drawingManager.addEventListener((event: { type: string; drawing?: unknown; drawingId?: string }) => {
      if (event.type === 'drawingCreated') {
        this.emitEvent('drawingCreated', event.drawing);
      } else if (event.type === 'drawingUpdated') {
        this.emitEvent('drawingUpdated', event.drawing);
      } else if (event.type === 'drawingDeleted') {
        this.emitEvent('drawingDeleted', event.drawingId);
      }
    });
  }

  /**
   * Emit event.
   */
  private emitEvent(event: ChartEventType, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (error) {
          console.error(`Error in event handler for ${event}:`, error);
        }
      }
    }
  }

}

