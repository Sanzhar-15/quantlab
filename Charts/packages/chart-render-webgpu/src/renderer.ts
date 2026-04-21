/**
 * WebGPU renderer implementation of the ChartRenderer interface.
 * This renderer uses WebGPU for high-performance GPU-accelerated rendering.
 * Supports Tier A (Worker) and Tier B (Main Thread).
 */

import type {
  AxisId,
  AxisOptions,
  ChartPlugin,
  CrosshairState,
  ExportPngOptions,
  ExportPngResult,
  LayoutResult,
  PaneId,
  ThemeTokens,
  VisibleTimeRange,
} from '@charts-plus/chart-core';
import type {
  ChartRenderer,
  RendererOptions,
  RendererTier,
  SeriesRenderData,
} from '@charts-plus/chart-core';
import { InvalidationFlag } from '@charts-plus/chart-core';

import { DeviceManager, type DeviceManagerOptions } from './device-manager';
import { createRenderPipelines, parseColor } from './renderer-impl';
import { PipelineCache } from './pipeline-cache';
import { TileCache } from './tile-cache';
import { TileAtlasManager } from './tile-atlas';
import { RefinementScheduler } from './refinement-scheduler';
import type { TileKey, TileScreenState, ViewportRect, Point } from './tile-types';
import { tileKeyToString, TileCoordinates } from './tile-types';
import { MSDFTextRenderer } from '@charts-plus/chart-text';
import { 
  GestureEngine, 
  type GestureResult,
  HitTestingManager,
  normalizePointerEvent,
  normalizeWheelEvent,
  normalizeTouchEvent,
  type InputState,
} from '@charts-plus/chart-interaction';
// NEW-CH-005: Indicator and drawing renderer imports (enabled)
import { IndicatorRenderer, type IndicatorRenderData } from '@charts-plus/chart-indicators';
import { DrawingRenderer, type DrawingRenderData } from '@charts-plus/chart-drawings';
import { CoordinateTransformImpl } from '@charts-plus/chart-drawings';

/**
 * WebGPU renderer implementation (Tier A or B).
 * - Tier A: WebGPU in Worker (SharedArrayBuffer available)
 * - Tier B: WebGPU on Main Thread
 */
export class WebGPURenderer implements ChartRenderer {
  public readonly tier: RendererTier;

  private container: HTMLElement | null = null;
  private options: RendererOptions | null = null;
  private theme: ThemeTokens | null = null;
  private layout: LayoutResult | null = null;
  private visibleTimeRange: VisibleTimeRange | null = null;
  private crosshairState: CrosshairState | null = null;
  private invalidationFlags: InvalidationFlag = InvalidationFlag.All;
  private seriesMap = new Map<string, SeriesRenderData>();
  private plugins: ChartPlugin[] = [];

  // WebGPU resources
  private deviceManager: DeviceManager | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: GPUCanvasContext | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private destroyed = false;
  private pipelineCache: PipelineCache | null = null;
  private pipelines: {
    grid: GPURenderPipeline | null;
    candlestick: GPURenderPipeline | null;
    crosshair: GPURenderPipeline | null;
  } = {
    grid: null,
    candlestick: null,
    crosshair: null,
  };
  private uniformBuffers = new Map<string, GPUBuffer>();
  private storageBuffers = new Map<string, GPUBuffer>();

  // Tile cache system
  private tileCache: TileCache | null = null;
  private tileAtlas: TileAtlasManager | null = null;
  private refinementScheduler: RefinementScheduler | null = null;
  private tileScreenStates = new Map<string, TileScreenState>();
  private previousViewport: ViewportRect | null = null;
  private previousTimeRange: VisibleTimeRange | null = null;
  private tileSize = 256; // Physical pixels
  private dprBucket = 1;

  // Text rendering
  private textRenderer: MSDFTextRenderer | null = null;
  private textUniformBuffer: GPUBuffer | null = null;
  private textBindGroup: GPUBindGroup | null = null;

  // Interaction
  private gestureEngine: GestureEngine | null = null;
  private hitTesting: HitTestingManager | null = null;
  private inputSequence = 0;
  private canvasRect: DOMRect | null = null;

  // NEW-CH-005: Indicator and drawing renderers (enabled)
  private indicatorRenderer: IndicatorRenderer | null = null;
  private drawingRenderer: DrawingRenderer | null = null;
  private drawingTransform: CoordinateTransformImpl | null = null;

  public constructor(tier: RendererTier) {
    if (tier !== 'A' && tier !== 'B') {
      throw new Error(`WebGPURenderer only supports Tier A or B, got ${tier}`);
    }
    this.tier = tier;
  }

  public initialize(container: HTMLElement, options: RendererOptions): void {
    if (this.container) {
      throw new Error('WebGPURenderer already initialized');
    }

    this.container = container;
    this.options = options;
    this.theme = options.theme ?? null;

    // Start async initialization (lazy)
    this.initPromise = this.initializeAsync();
  }

  private async initializeAsync(): Promise<void> {
    const container = this.container;
    if (!container) {
      throw new Error('Container not set');
    }

    // Initialize device manager
    this.deviceManager = new DeviceManager();
    const deviceOptions: DeviceManagerOptions = {
      forceTier: this.tier === 'A' ? 'A' : 'B',
    };
    await this.deviceManager.initialize(deviceOptions);

    const deviceInfo = this.deviceManager.getDeviceInfo();

    // Set up device loss callback
    this.deviceManager.onDeviceLoss(() => {
      // Invalidate everything on device loss
      this.invalidate(InvalidationFlag.All);
      // Re-initialize
      this.initPromise = this.initializeAsync();
    });

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);

    // Get WebGPU context
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('Failed to get WebGPU context');
    }

    // Configure canvas format
    this.context.configure({
      device: deviceInfo.device,
      format: deviceInfo.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Set up container styles
    if (typeof window !== 'undefined') {
      const position = window.getComputedStyle(container).position;
      if (position === 'static') {
        container.style.position = 'relative';
      }
    }
    container.style.overflow = 'hidden';

    // Initialize pipeline cache
    this.pipelineCache = new PipelineCache(deviceInfo.device);

    // Create render pipelines
    const pipelines = createRenderPipelines(deviceInfo.device);
    this.pipelines.grid = pipelines.gridPipeline;
    this.pipelines.candlestick = pipelines.candlestickPipeline;
    this.pipelines.crosshair = pipelines.crosshairPipeline;

    // Initialize tile cache system
    this.tileCache = new TileCache();
    this.tileAtlas = new TileAtlasManager(192); // 192 MB budget for desktop
    this.tileAtlas.initialize(deviceInfo.device);
    this.refinementScheduler = new RefinementScheduler();

    // Initialize text renderer
    this.textRenderer = new MSDFTextRenderer(deviceInfo.device);
    await this.textRenderer.initialize(16); // 16px default font size

    // Initialize gesture engine
    this.gestureEngine = new GestureEngine({
      enableInertia: true,
      enablePinch: true,
    });

    // Initialize hit testing
    this.hitTesting = new HitTestingManager();

    // NEW-CH-005: Initialize indicator and drawing renderers
    this.indicatorRenderer = new IndicatorRenderer();
    this.drawingRenderer = new DrawingRenderer();

    // Determine DPR bucket
    const dpr = window.devicePixelRatio || 1;
    this.dprBucket = Math.floor(dpr);

    // Set up input handlers
    this.setupInputHandlers();

    this.initialized = true;
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    // Clean up text renderer
    if (this.textRenderer) {
      this.textRenderer.destroy();
      this.textRenderer = null;
    }

    // Clean up device manager
    if (this.deviceManager) {
      this.deviceManager.destroy();
      this.deviceManager = null;
    }

    // Remove canvas
    if (this.canvas && this.container) {
      this.container.removeChild(this.canvas);
      this.canvas = null;
    }

    this.context = null;

    // Clear state
    this.container = null;
    this.options = null;
    this.theme = null;
    this.layout = null;
    this.visibleTimeRange = null;
    this.crosshairState = null;
    this.seriesMap.clear();
    this.plugins = [];
  }

  public setTheme(theme: ThemeTokens): void {
    this.theme = theme;
    if (this.tileCache) {
      this.tileCache.invalidateByTheme();
    }
    this.invalidate(InvalidationFlag.All);
  }

  public setLayout(layout: LayoutResult): void {
    this.layout = layout;
    this.invalidate(InvalidationFlag.Layout);
  }

  public addSeries(series: SeriesRenderData): void {
    this.seriesMap.set(series.id, series);
    this.invalidate(InvalidationFlag.Series);
  }

  public removeSeries(seriesId: string): void {
    this.seriesMap.delete(seriesId);
    this.invalidate(InvalidationFlag.Series);
  }

  public updateSeries(seriesId: string, data: SeriesRenderData): void {
    this.seriesMap.set(seriesId, data);
    if (this.tileCache) {
      const rev = this.tileCache.incrementSeriesRevision(seriesId);
      this.tileCache.invalidateByRevision(seriesId, rev);
    }
    this.invalidate(InvalidationFlag.Series);
  }

  public setAxisOptions(axis: AxisId, options: AxisOptions): void {
    // TODO: Store axis options and use in rendering
    this.invalidate(InvalidationFlag.Overlay);
  }

  public setPaneAxisOptions(paneId: PaneId, axis: AxisId, options: AxisOptions): void {
    // TODO: Store pane axis options and use in rendering
    this.invalidate(InvalidationFlag.Overlay);
  }

  public setVisibleTimeRange(range: VisibleTimeRange): void {
    const wasPanning = this.previousTimeRange !== null && 
                       this.visibleTimeRange !== null &&
                       (range.from !== this.visibleTimeRange.from || range.to !== this.visibleTimeRange.to);
    
    this.previousTimeRange = this.visibleTimeRange;
    this.visibleTimeRange = range;
    
    // If panning, we'll handle reprojection in render()
    if (!wasPanning) {
      this.invalidate(InvalidationFlag.Series);
    }
  }

  public setCrosshair(state: CrosshairState | null): void {
    this.crosshairState = state;
    this.invalidate(InvalidationFlag.Overlay);
  }

  public render(frameTime: number): void {
    if (this.destroyed || !this.initialized || !this.deviceManager || !this.context || !this.layout) {
      // If not initialized yet, wait for initialization
      if (this.initPromise && !this.initialized) {
        // Initialization in progress, skip this frame
        return;
      }
      return;
    }

    // Check device validity
    if (!this.deviceManager.isDeviceValid()) {
      // Device lost, skip rendering
      return;
    }

    const device = this.deviceManager.getDevice();
    const format = this.deviceManager.getFormat();

    if (!this.pipelines.grid || !this.pipelines.candlestick || !this.pipelines.crosshair) {
      // Pipelines not ready yet
      return;
    }

    // Update canvas size if needed
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas!.getBoundingClientRect();
    const width = Math.floor(rect.width * dpr);
    const height = Math.floor(rect.height * dpr);

    if (this.canvas!.width !== width || this.canvas!.height !== height) {
      this.canvas!.width = width;
      this.canvas!.height = height;
    }

    const commandEncoder = device.createCommandEncoder();
    const textureView = this.context!.getCurrentTexture().createView();

    const bgColor = this.theme?.background
      ? parseColor(this.theme.background)
      : { r: 0, g: 0, b: 0, a: 1 };

    const renderPassDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: bgColor,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    const pass = commandEncoder.beginRenderPass(renderPassDescriptor);

    // Get the first pane's plot rect (simplified for now)
    const panes = this.layout.panes;
    if (panes && panes.length > 0 && this.tileCache && this.tileAtlas && this.refinementScheduler) {
      const plotRect = panes[0]!.plotRect;
      const paneId = panes[0]!.id;

      // Update frame counters
      this.tileCache.tickFrame();
      this.refinementScheduler.tickFrame();

      // Detect pan delta
      const viewport: ViewportRect = {
        x: plotRect.x,
        y: plotRect.y,
        width: plotRect.width,
        height: plotRect.height,
      };

      const panDelta = this.detectPanDelta(viewport);
      const isPanning = panDelta !== null && (panDelta.x !== 0 || panDelta.y !== 0);

      if (isPanning && panDelta) {
        // Reprojection pan: shift existing tiles
        this.reprojectTiles(panDelta, viewport, paneId);
      } else {
        // No panning: update tile screen states normally
        this.updateTileScreenStates(viewport, paneId);
      }

      // Schedule refinement jobs for invalid/missing tiles
      this.scheduleRefinementJobs(viewport, paneId);

      // Process refinement jobs (up to frame budget)
      this.processRefinementJobs(device, frameTime);

      // Render cached tiles (reprojection or normal)
      this.renderCachedTiles(device, pass, width, height, viewport);

      // Render grid (always live)
      this.renderGrid(device, pass, width, height, plotRect);

      // Render axis labels (using MSDF text)
      this.renderAxisLabels(device, pass, width, height, plotRect);

      // Render crosshair (always live)
      if (this.crosshairState) {
        this.renderCrosshair(device, pass, width, height, plotRect);
        // Render crosshair labels (using MSDF text)
        this.renderCrosshairLabels(device, pass, width, height, plotRect);
      }
    } else if (panes && panes.length > 0) {
      // Fallback: render without tile cache
      const plotRect = panes[0]!.plotRect;
      this.renderGrid(device, pass, width, height, plotRect);
      for (const series of this.seriesMap.values()) {
        if (series.seriesType === 'candlestick' && series.visible) {
          this.renderCandlestickSeries(device, pass, width, height, plotRect, series);
        }
      }
      if (this.crosshairState) {
        this.renderCrosshair(device, pass, width, height, plotRect);
      }
    }

    pass.end();
    device.queue.submit([commandEncoder.finish()]);

    // Clear invalidation flags after rendering
    this.invalidationFlags = InvalidationFlag.None;
  }

  /**
   * Detect pan delta from previous viewport.
   */
  private detectPanDelta(viewport: ViewportRect): { x: number; y: number } | null {
    if (!this.previousViewport) {
      this.previousViewport = viewport;
      return null;
    }

    const deltaX = viewport.x - this.previousViewport.x;
    const deltaY = viewport.y - this.previousViewport.y;

    this.previousViewport = viewport;

    // Only consider it panning if delta is significant (>= 1 pixel)
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
      return null;
    }

    return { x: deltaX, y: deltaY };
  }

  /**
   * Reproject tiles by shifting their screen positions.
   */
  private reprojectTiles(
    panDelta: { x: number; y: number },
    viewport: ViewportRect,
    paneId: PaneId,
  ): void {
    if (!this.tileCache || !this.visibleTimeRange) return;

    // Shift all tile screen positions
    for (const state of this.tileScreenStates.values()) {
      if (state.key.paneId === paneId) {
        state.screenX += panDelta.x;
        state.screenY += panDelta.y;
      }
    }

    // Get tiles that should be visible now
    const lodLevel = 0; // TODO: Calculate from zoom level
    const stage = 0; // Start with Stage 0
    const themeRev = this.tileCache.getThemeRevision();
    const seriesRev = Math.max(...Array.from(this.seriesMap.keys()).map(id => 
      this.tileCache!.getSeriesRevision(id)
    ), 0);

    const requiredTiles = this.tileCache.getTilesInViewport(
      viewport,
      paneId,
      stage,
      this.tileSize,
      lodLevel,
      this.dprBucket,
      1, // overscan
    );

    // Mark newly exposed tiles
    const newlyExposed: TileKey[] = [];
    for (const key of requiredTiles) {
      const keyStr = tileKeyToString(key);
      if (!this.tileScreenStates.has(keyStr)) {
        newlyExposed.push(key);
      }
    }

    if (newlyExposed.length > 0) {
      this.tileCache.markNewlyExposed(newlyExposed);
    }

    // Update tile screen states for newly exposed tiles
    for (const key of newlyExposed) {
      const tileBounds = TileCoordinates.getTileBounds(key.tileX, key.tileY, this.tileSize);
      const state: TileScreenState = {
        key,
        slot: { pageId: 0, slotIndex: 0, xPx: 0, yPx: 0, uvOffset: [0, 0], uvScale: [1, 1] }, // Placeholder
        screenX: tileBounds.x,
        screenY: tileBounds.y,
        isValid: false,
        stage: 0,
      };
      this.tileScreenStates.set(tileKeyToString(key), state);
    }
  }

  /**
   * Update tile screen states for current viewport.
   */
  private updateTileScreenStates(viewport: ViewportRect, paneId: PaneId): void {
    if (!this.tileCache || !this.visibleTimeRange) return;

    const lodLevel = 0;
    const stage = 0;
    const themeRev = this.tileCache.getThemeRevision();
    const seriesRev = Math.max(...Array.from(this.seriesMap.keys()).map(id => 
      this.tileCache!.getSeriesRevision(id)
    ), 0);

    const requiredTiles = this.tileCache.getTilesInViewport(
      viewport,
      paneId,
      stage,
      this.tileSize,
      lodLevel,
      this.dprBucket,
      1,
    );

    // Update or create screen states
    for (const key of requiredTiles) {
      const keyStr = tileKeyToString(key);
      const tileBounds = TileCoordinates.getTileBounds(key.tileX, key.tileY, this.tileSize);
      
      let state = this.tileScreenStates.get(keyStr);
      if (!state) {
        state = {
          key,
          slot: { pageId: 0, slotIndex: 0, xPx: 0, yPx: 0, uvOffset: [0, 0], uvScale: [1, 1] },
          screenX: tileBounds.x,
          screenY: tileBounds.y,
          isValid: false,
          stage: 0,
        };
        this.tileScreenStates.set(keyStr, state);
      } else {
        state.screenX = tileBounds.x;
        state.screenY = tileBounds.y;
      }
    }
  }

  /**
   * Schedule refinement jobs for invalid or missing tiles.
   */
  private scheduleRefinementJobs(viewport: ViewportRect, paneId: PaneId): void {
    if (!this.tileCache || !this.refinementScheduler || !this.visibleTimeRange) return;

    const lodLevel = 0;
    const pointer: Point | null = null; // TODO: Get from crosshair state
    const themeRev = this.tileCache.getThemeRevision();
    const seriesRev = Math.max(...Array.from(this.seriesMap.keys()).map(id => 
      this.tileCache!.getSeriesRevision(id)
    ), 0);

    // Schedule jobs for each stage (0, 1, 2)
    for (let stage = 0; stage <= 2; stage++) {
      const requiredTiles = this.tileCache.getTilesInViewport(
        viewport,
        paneId,
        stage as 0 | 1 | 2,
        this.tileSize,
        lodLevel,
        this.dprBucket,
        1,
      );

      for (const key of requiredTiles) {
        const keyStr = tileKeyToString(key);
        const entry = this.tileCache.getTile(key);

        if (!entry || !entry.isValid) {
          // Tile missing or invalid, schedule job
          const priority = RefinementScheduler.scoreTileJob(key, viewport, pointer, this.tileSize);
          this.refinementScheduler.scheduleJob(key, stage as 0 | 1 | 2, priority);
        }
      }
    }
  }

  /**
   * Process refinement jobs up to frame budget.
   */
  private processRefinementJobs(device: GPUDevice, frameTime: number): void {
    if (!this.refinementScheduler || !this.tileCache || !this.tileAtlas) return;

    const jobs = this.refinementScheduler.processJobs(frameTime);
    
    // TODO: Actually render tiles to atlas
    // For now, just mark jobs as complete
    for (const job of jobs) {
      // Placeholder: allocate slot and mark as complete
      const slot = this.tileAtlas.allocateSlot(this.tileSize);
      if (slot) {
        const entry = this.tileCache.setTile(job.key, slot);
        const state = this.tileScreenStates.get(tileKeyToString(job.key));
        if (state) {
          state.slot = slot;
          state.isValid = true;
          state.stage = job.stage;
        }
      }
      this.refinementScheduler.completeJob(job.key);
    }
  }

  /**
   * Render cached tiles to screen.
   */
  private renderCachedTiles(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    viewport: ViewportRect,
  ): void {
    if (!this.tileAtlas) return;

    // TODO: Implement tile compositor rendering
    // For now, this is a placeholder
    // In full implementation, would:
    // 1. Create tile compositor pipeline
    // 2. Upload tile instance data (screen positions, UV transforms)
    // 3. Render instanced quads from atlas texture
  }

  public invalidate(flags: InvalidationFlag): void {
    this.invalidationFlags |= flags;
    // TODO: Schedule render frame
  }

  public async exportPng(options?: ExportPngOptions): Promise<ExportPngResult> {
    // TODO: Implement PNG export
    throw new Error('PNG export not yet implemented in WebGPURenderer');
  }

  public addPlugin(plugin: ChartPlugin): void {
    this.plugins.push(plugin);
    this.invalidate(InvalidationFlag.Overlay);
  }

  public removePlugin(plugin: ChartPlugin): void {
    const index = this.plugins.indexOf(plugin);
    if (index >= 0) {
      this.plugins.splice(index, 1);
      this.invalidate(InvalidationFlag.Overlay);
    }
  }

  private renderGrid(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    plotRect: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.pipelines.grid || !this.theme) return;

    // Create or update grid uniform buffer
    const gridSpacing = { x: 100, y: 50 }; // TODO: Calculate from axis ticks
    const gridOffset = { x: 0, y: 0 };
    const gridColor = parseColor(this.theme.gridMajor || '#333333');

    const uniformData = new Float32Array([
      width,
      height, // viewportSize
      plotRect.x,
      plotRect.y,
      plotRect.width,
      plotRect.height, // plotRect
      gridColor.r,
      gridColor.g,
      gridColor.b,
      gridColor.a, // gridColor
      gridSpacing.x,
      gridSpacing.y, // gridSpacing
      gridOffset.x,
      gridOffset.y, // gridOffset
    ]);

    let buffer = this.uniformBuffers.get('grid');
    if (!buffer || buffer.size < uniformData.byteLength) {
      if (buffer) buffer.destroy();
      buffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uniformBuffers.set('grid', buffer);
    }

    device.queue.writeBuffer(buffer, 0, uniformData);

    const bindGroup = device.createBindGroup({
      layout: this.pipelines.grid.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }],
    });

    pass.setPipeline(this.pipelines.grid);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4, 1);
  }

  private renderCandlestickSeries(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    plotRect: { x: number; y: number; width: number; height: number },
    series: SeriesRenderData,
  ): void {
    if (!this.pipelines.candlestick || !this.visibleTimeRange || !series.open || !series.close) return;

    const time = series.time;
    const open = series.open;
    const high = series.high;
    const low = series.low;
    const close = series.close;

    if (!time || !open || !high || !low || !close || time.length === 0) return;

    // Get visible range
    const visibleFrom = this.visibleTimeRange.from;
    const visibleTo = this.visibleTimeRange.to;
    const timeSpan = visibleTo - visibleFrom;

    // Find visible indices
    const visibleIndices: number[] = [];
    for (let i = 0; i < time.length; i++) {
      const t = time[i]!;
      if (t >= visibleFrom && t <= visibleTo) {
        visibleIndices.push(i);
      }
    }

    if (visibleIndices.length === 0) return;

    // Calculate price range
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const i of visibleIndices) {
      const h = high[i]!;
      const l = low[i]!;
      if (Number.isFinite(h)) maxPrice = Math.max(maxPrice, h);
      if (Number.isFinite(l)) minPrice = Math.min(minPrice, l);
    }

    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice === maxPrice) return;

    const priceSpan = maxPrice - minPrice;

    // Prepare candlestick data
    const options = series.options as any;
    const upColor = parseColor(options.upColor || '#089981');
    const downColor = parseColor(options.downColor || '#f23645');
    const barWidth = options.width || 4;

    // Create candlestick data array
    // Structure: time, open, high, low, close, bodyWidth, upColor(4), downColor(4) = 13 floats per candle
    const floatsPerCandle = 13;
    const candlestickData = new Float32Array(visibleIndices.length * floatsPerCandle);
    let offset = 0;
    let candleCount = 0;

    const writeCandleData = (normalizedTime: number, normalizedOpen: number, normalizedHigh: number, normalizedLow: number, normalizedClose: number) => {
      candlestickData[offset++] = normalizedTime;
      candlestickData[offset++] = normalizedOpen;
      candlestickData[offset++] = normalizedHigh;
      candlestickData[offset++] = normalizedLow;
      candlestickData[offset++] = normalizedClose;
      candlestickData[offset++] = barWidth;
      candlestickData[offset++] = upColor.r;
      candlestickData[offset++] = upColor.g;
      candlestickData[offset++] = upColor.b;
      candlestickData[offset++] = upColor.a;
      candlestickData[offset++] = downColor.r;
      candlestickData[offset++] = downColor.g;
      candlestickData[offset++] = downColor.b;
      candlestickData[offset++] = downColor.a;
      candleCount++;
    };

    for (const i of visibleIndices) {
      const t = time[i]!;
      const o = open[i]!;
      const h = high[i]!;
      const l = low[i]!;
      const c = close[i]!;

      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;

      // Normalize time and price (0-1 range)
      const normalizedTime = (t - visibleFrom) / timeSpan;
      const normalizedOpen = (o - minPrice) / priceSpan;
      const normalizedHigh = (h - minPrice) / priceSpan;
      const normalizedLow = (l - minPrice) / priceSpan;
      const normalizedClose = (c - minPrice) / priceSpan;

      writeCandleData(normalizedTime, normalizedOpen, normalizedHigh, normalizedLow, normalizedClose);
    }

    if (candleCount === 0) return;

    // Create storage buffer for candlesticks
    const storageSize = candleCount * floatsPerCandle * 4; // floats * 4 bytes
    let storageBuffer = this.storageBuffers.get(`candlestick-${series.id}`);
    if (!storageBuffer || storageBuffer.size < storageSize) {
      if (storageBuffer) storageBuffer.destroy();
      storageBuffer = device.createBuffer({
        size: storageSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.storageBuffers.set(`candlestick-${series.id}`, storageBuffer);
    }

    device.queue.writeBuffer(storageBuffer, 0, candlestickData.subarray(0, candleCount * floatsPerCandle));

    // Create camera uniform buffer
    const cameraData = new Float32Array([
      width,
      height, // viewportSize (2 floats)
      plotRect.x,
      plotRect.y,
      plotRect.width,
      plotRect.height, // plotRect (4 floats)
      0,
      1, // timeRange (normalized) (2 floats)
      (minPrice - minPrice) / priceSpan,
      (maxPrice - minPrice) / priceSpan, // priceRange (normalized) (2 floats)
    ]);

    let cameraBuffer = this.uniformBuffers.get('camera');
    if (!cameraBuffer || cameraBuffer.size < cameraData.byteLength) {
      if (cameraBuffer) cameraBuffer.destroy();
      cameraBuffer = device.createBuffer({
        size: cameraData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uniformBuffers.set('camera', cameraBuffer);
    }

    device.queue.writeBuffer(cameraBuffer, 0, cameraData);

    const bindGroup = device.createBindGroup({
      layout: this.pipelines.candlestick.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: cameraBuffer } },
        { binding: 1, resource: { buffer: storageBuffer } },
      ],
    });

    pass.setPipeline(this.pipelines.candlestick);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4, candleCount); // 4 vertices per quad, candleCount instances
  }

  private renderCrosshair(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    plotRect: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.pipelines.crosshair || !this.crosshairState || !this.theme) return;

    // Calculate crosshair position in screen space
    // TODO: Convert crosshairState.time to screen X, crosshairState.yRatio to screen Y
    const crosshairX = plotRect.x + plotRect.width * 0.5; // Placeholder
    const crosshairY = plotRect.y + plotRect.height * 0.5; // Placeholder

    const crosshairColor = parseColor(this.theme.crosshair || '#2962ff');

    const uniformData = new Float32Array([
      width,
      height, // viewportSize
      plotRect.x,
      plotRect.y,
      plotRect.width,
      plotRect.height, // plotRect
      crosshairX,
      crosshairY, // crosshairPos
      crosshairColor.r,
      crosshairColor.g,
      crosshairColor.b,
      crosshairColor.a, // color
      1.0, // lineWidth
    ]);

    let buffer = this.uniformBuffers.get('crosshair');
    if (!buffer || buffer.size < uniformData.byteLength) {
      if (buffer) buffer.destroy();
      buffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uniformBuffers.set('crosshair', buffer);
    }

    device.queue.writeBuffer(buffer, 0, uniformData);

    const bindGroup = device.createBindGroup({
      layout: this.pipelines.crosshair.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }],
    });

    pass.setPipeline(this.pipelines.crosshair);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4, 1);
  }

  /**
   * Setup input handlers for gesture engine.
   */
  private setupInputHandlers(): void {
    if (!this.canvas) return;

    // Pointer events
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.canvasRect || !this.gestureEngine) return;
      const inputs = normalizePointerEvent(e, this.canvasRect, this.inputSequence++);
      for (const input of inputs) {
        this.gestureEngine.processInput(input);
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.canvasRect || !this.gestureEngine) return;
      const inputs = normalizePointerEvent(e, this.canvasRect, this.inputSequence++);
      for (const input of inputs) {
        const result = this.gestureEngine.processInput(input);
        if (result && result.type === 'pan') {
          // TODO: Apply pan to visible time range
        }
      }
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (!this.canvasRect || !this.gestureEngine) return;
      const inputs = normalizePointerEvent(e, this.canvasRect, this.inputSequence++);
      for (const input of inputs) {
        this.gestureEngine.processInput(input);
      }
    });

    // Wheel events
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.canvasRect || !this.gestureEngine) return;
      e.preventDefault();
      const input = normalizeWheelEvent(e, this.canvasRect, this.inputSequence++);
      const result = this.gestureEngine.processInput(input);
      if (result && result.type === 'zoom') {
        // TODO: Apply zoom to visible time range
      }
    });

    // Touch events (for pinch)
    this.canvas.addEventListener('touchstart', (e) => {
      if (!this.canvasRect || !this.gestureEngine) return;
      const input = normalizeTouchEvent(e, this.canvasRect, this.inputSequence++);
      this.gestureEngine.processInput(input);
    });

    this.canvas.addEventListener('touchmove', (e) => {
      if (!this.canvasRect || !this.gestureEngine) return;
      e.preventDefault();
      const input = normalizeTouchEvent(e, this.canvasRect, this.inputSequence++);
      const result = this.gestureEngine.processInput(input);
      if (result && result.type === 'zoom') {
        // TODO: Apply pinch zoom
      }
    });

    this.canvas.addEventListener('touchend', (e) => {
      if (!this.canvasRect || !this.gestureEngine) return;
      const input = normalizeTouchEvent(e, this.canvasRect, this.inputSequence++);
      this.gestureEngine.processInput(input);
    });
  }

  /**
   * Render axis labels using MSDF text renderer.
   */
  private renderAxisLabels(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    plotRect: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.textRenderer || !this.textUniformBuffer || !this.textBindGroup || !this.layout || !this.visibleTimeRange) {
      return;
    }

    // TODO: Calculate axis label positions and text
    // For now, render placeholder labels
    const fontSize = 12;
    const color: [number, number, number, number] = this.theme?.axisText ? 
      this.parseColorToRGBA(this.theme.axisText) : [1, 1, 1, 1];

    // Render price labels on right axis
    if (this.layout.rightAxisRect) {
      const axisRect = this.layout.rightAxisRect;
      // TODO: Get price scale and calculate label positions
      // For now, skip actual rendering
    }

    // Render time labels on bottom axis
    if (this.layout.timeAxisRect) {
      const axisRect = this.layout.timeAxisRect;
      // TODO: Get time scale and calculate label positions
      // For now, skip actual rendering
    }
  }

  /**
   * Render crosshair labels using MSDF text renderer.
   */
  private renderCrosshairLabels(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    plotRect: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.textRenderer || !this.textUniformBuffer || !this.textBindGroup || !this.crosshairState || !this.visibleTimeRange) {
      return;
    }

    // TODO: Calculate crosshair label positions and text
    // For now, skip actual rendering
    // Would render:
    // - Time label on time axis
    // - Price label on price axis
    // - Series values if multiple series
  }

  // NEW-CH-005: Indicator rendering methods (enabled)
  /**
   * Render indicators (overlay and separate panes).
   */
  private renderIndicators(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    plotRect: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.indicatorRenderer || !this.visibleTimeRange) {
      return;
    }

    // Get overlay indicators (render in price pane)
    const overlayIndicators = this.indicatorRenderer.getOverlayRenderData();

    for (const indicatorData of overlayIndicators) {
      this.renderIndicatorLine(device, pass, width, height, plotRect, indicatorData);
    }

    // Separate pane indicators are rendered in their own panes
    // via the layout engine and separate render passes
  }

  /**
   * Render line indicator.
   */
  private renderIndicatorLine(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    width: number,
    height: number,
    plotRect: { x: number; y: number; width: number; height: number },
    indicatorData: IndicatorRenderData,
  ): void {
    // Line indicator rendering uses the same GPU pipeline as line series
    // but reads from indicator result buffers instead of price data
    if (!indicatorData.vertexBuffer || !indicatorData.vertexCount) {
      return;
    }

    pass.setVertexBuffer(0, indicatorData.vertexBuffer);
    pass.draw(indicatorData.vertexCount);
  }

  /**
   * Parse color string to RGBA array.
   */
  private parseColorToRGBA(color: string): [number, number, number, number] {
    // Simple hex color parser
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    // Default white
    return [1, 1, 1, 1];
  }
}

