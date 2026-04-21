/**
 * Canvas2D renderer implementation of the ChartRenderer interface.
 * 
 * V5.2 Architecture: 3-Layer Model (Conceptual)
 * ==============================================
 * Layer 0 (background): Static background + grid + axes, updates on theme/layout change
 * Layer 1 (data): Candles, indicators, volume - updates on viewport/data change
 * Layer 2 (interaction): Crosshair, tooltips, labels - updates every frame
 * 
 * Implementation Note:
 * The production implementation in index.ts uses a 4-canvas approach where the data
 * layer is split into seriesLayer + panLayer for pan caching optimization. This is
 * an acceptable variation per V5.2 spec: "Profile after V1 — add 4th layer only if
 * data proves it's needed." The panLayer provides 4-6ms savings per pan frame, which
 * is critical for maintaining 60fps during rapid panning. See LAYER_ARCHITECTURE.md
 * for detailed justification and performance analysis.
 * 
 * This Canvas2DRenderer class is a simplified interface for the V5.2 specification.
 * For production use, see createChart() in index.ts which implements the full rendering.
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

import { CanvasSurface } from './canvas-surface';
import { getChartRuntime, type RuntimeHandle } from './chart-runtime';

/**
 * Canvas2D renderer implementation (Tier D).
 * This renderer uses HTML5 Canvas 2D API for rendering.
 * It's the fallback renderer that works in all browsers.
 * 
 * Uses a 3-layer architecture for optimal performance:
 * - Background layer: Static, rarely redrawn
 * - Data layer: Grid + series data, redrawn on pan/zoom/data changes
 * - Interaction layer: Crosshair/tooltips, redrawn every frame during interaction
 */
export class Canvas2DRenderer implements ChartRenderer {
  public readonly tier: RendererTier = 'D';

  private container: HTMLElement | null = null;
  private options: RendererOptions | null = null;
  private theme: ThemeTokens | null = null;
  private layout: LayoutResult | null = null;
  private visibleTimeRange: VisibleTimeRange | null = null;
  private crosshairState: CrosshairState | null = null;
  private invalidationFlags: InvalidationFlag = InvalidationFlag.All;
  private seriesMap = new Map<string, SeriesRenderData>();
  private plugins: ChartPlugin[] = [];

  // V5.2 3-Layer Architecture
  // Layer 0: Background (static, theme changes only)
  private backgroundLayer: CanvasSurface | null = null;
  // Layer 1: Data (grid + candles + indicators + volume)
  private dataLayer: CanvasSurface | null = null;
  // Layer 2: Interaction (crosshair + tooltips + labels)
  private interactionLayer: CanvasSurface | null = null;

  // Frame scheduling
  private runtimeHandle: RuntimeHandle | null = null;
  private frameHandle: number | null = null;
  private destroyed = false;

  public initialize(container: HTMLElement, options: RendererOptions): void {
    if (this.container) {
      throw new Error('Canvas2DRenderer already initialized');
    }

    this.container = container;
    this.options = options;
    this.theme = options.theme ?? null;

    // Set up container styles
    if (typeof window !== 'undefined') {
      const position = window.getComputedStyle(container).position;
      if (position === 'static') {
        container.style.position = 'relative';
      }
    }
    container.style.overflow = 'hidden';

    // V5.2: Create 3-layer canvas architecture
    const surfaceWidth = options.width;
    const surfaceHeight = options.height;
    const sizeOptions = {
      ...(surfaceWidth !== undefined && { width: surfaceWidth }),
      ...(surfaceHeight !== undefined && { height: surfaceHeight }),
    };

    // Layer 0: Background (static, rarely redrawn)
    this.backgroundLayer = new CanvasSurface(container, {
      autoSize: false,
      absolute: true,
      zIndex: 0,
      pointerEvents: 'none',
      ...sizeOptions,
    });

    // Layer 1: Data (grid + candles + indicators + volume)
    // Uses desynchronized for lower latency during pan/zoom
    this.dataLayer = new CanvasSurface(container, {
      autoSize: false,
      absolute: true,
      zIndex: 1,
      pointerEvents: 'none',
      contextAttributes: { desynchronized: true },
      ...sizeOptions,
    });

    // Layer 2: Interaction (crosshair + tooltips + labels)
    // Handles pointer events, uses desynchronized for low-latency crosshair
    this.interactionLayer = new CanvasSurface(container, {
      autoSize: false,
      absolute: true,
      zIndex: 2,
      pointerEvents: 'auto',
      contextAttributes: { desynchronized: true },
      ...sizeOptions,
    });

    if (this.interactionLayer.canvas) {
      this.interactionLayer.canvas.style.touchAction = 'none';
    }

    // Set up frame scheduling
    const runtime = getChartRuntime();
    this.runtimeHandle = runtime.createHandle(container);
    this.runtimeHandle.setPriority(1); // Normal priority

    // Start render loop
    this.scheduleRender();
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    // Cancel pending frame
    if (this.frameHandle !== null && this.runtimeHandle) {
      this.runtimeHandle.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }

    // Destroy runtime handle
    if (this.runtimeHandle) {
      this.runtimeHandle.destroy();
      this.runtimeHandle = null;
    }

    // Clean up V5.2 3-layer canvas surfaces
    this.backgroundLayer?.destroy();
    this.dataLayer?.destroy();
    this.interactionLayer?.destroy();

    this.backgroundLayer = null;
    this.dataLayer = null;
    this.interactionLayer = null;

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
    this.visibleTimeRange = range;
    this.invalidate(InvalidationFlag.Series);
  }

  public setCrosshair(state: CrosshairState | null): void {
    this.crosshairState = state;
    this.invalidate(InvalidationFlag.Overlay);
  }

  public render(frameTime: number): void {
    if (this.destroyed || !this.container || !this.layout) {
      return;
    }

    // NEW-CH-003: 3-layer rendering implementation
    // Layer 0: Background (only on theme/size change)
    if (this.invalidationFlags & InvalidationFlag.All) {
      this.renderBackground();
    }

    // Layer 1: Data (grid + candles + indicators + volume)
    if (this.invalidationFlags & (InvalidationFlag.Series | InvalidationFlag.Layout)) {
      this.renderDataLayer();
    }

    // Layer 2: Interaction (crosshair + tooltips + labels)
    if (this.invalidationFlags & InvalidationFlag.Overlay) {
      this.renderInteractionLayer();
    }

    // Render plugins on the interaction layer
    if (this.plugins.length > 0 && this.interactionLayer) {
      const ctx = this.interactionLayer.getContext();
      if (ctx) {
        for (const plugin of this.plugins) {
          if (plugin.render) {
            plugin.render(ctx, this.layout, frameTime);
          }
        }
      }
    }

    // Clear invalidation flags after rendering
    this.invalidationFlags = InvalidationFlag.None;

    // Schedule next frame if there's active interaction
    if (this.crosshairState) {
      this.scheduleRender();
    }
  }

  private renderBackground(): void {
    if (!this.backgroundLayer || !this.layout || !this.theme) {
      return;
    }
    const ctx = this.backgroundLayer.getContext();
    if (!ctx) return;

    const { width, height } = this.layout;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.theme.backgroundColor ?? '#1e1e1e';
    ctx.fillRect(0, 0, width, height);
  }

  private renderDataLayer(): void {
    if (!this.dataLayer || !this.layout || !this.theme) {
      return;
    }
    const ctx = this.dataLayer.getContext();
    if (!ctx) return;

    const { width, height } = this.layout;
    ctx.clearRect(0, 0, width, height);

    // Render grid lines
    this.renderGrid(ctx, width, height);

    // Render each series
    for (const [, series] of this.seriesMap) {
      this.renderSeries(ctx, series);
    }
  }

  private renderGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.theme) return;

    ctx.strokeStyle = this.theme.gridColor ?? 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;

    // Horizontal grid lines (price levels)
    const hLines = 8;
    for (let i = 1; i < hLines; i++) {
      const y = Math.round(height * (i / hLines)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Vertical grid lines (time divisions)
    const vLines = 6;
    for (let i = 1; i < vLines; i++) {
      const x = Math.round(width * (i / vLines)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  private renderSeries(ctx: CanvasRenderingContext2D, series: SeriesRenderData): void {
    if (!series.data || !this.layout || !this.visibleTimeRange) {
      return;
    }

    // Delegate to series-specific renderer based on type
    // The actual candlestick/line/area rendering is in the production createChart()
    // This provides a minimal implementation for the V5.2 interface
    const { width, height } = this.layout;
    const data = series.data;

    if (!data.length) return;

    // Basic line rendering for series data
    ctx.strokeStyle = series.color ?? '#2196F3';
    ctx.lineWidth = series.lineWidth ?? 1;
    ctx.beginPath();

    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * width;
      const value = typeof data[i] === 'number' ? (data[i] as number) : (data[i] as { close?: number })?.close ?? 0;
      const y = height - (value / (series.priceRange?.max ?? 1)) * height;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  private renderInteractionLayer(): void {
    if (!this.interactionLayer || !this.layout) {
      return;
    }
    const ctx = this.interactionLayer.getContext();
    if (!ctx) return;

    const { width, height } = this.layout;
    ctx.clearRect(0, 0, width, height);

    // Render crosshair
    if (this.crosshairState) {
      this.renderCrosshair(ctx, width, height);
    }
  }

  private renderCrosshair(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.crosshairState || !this.theme) return;

    const { x, y } = this.crosshairState;
    ctx.strokeStyle = this.theme.crosshairColor ?? 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    ctx.setLineDash([]);
  }

  public invalidate(flags: InvalidationFlag): void {
    this.invalidationFlags |= flags;
    this.scheduleRender();
  }

  public async exportPng(options?: ExportPngOptions): Promise<ExportPngResult> {
    // NEW-CH-003: PNG export by compositing all canvas layers
    if (!this.layout) {
      throw new Error('Cannot export: renderer not initialized');
    }

    const width = options?.width ?? this.layout.width;
    const height = options?.height ?? this.layout.height;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext('2d');
    if (!exportCtx) {
      throw new Error('Failed to create export canvas context');
    }

    // Draw background
    exportCtx.fillStyle = this.theme?.backgroundColor ?? '#1e1e1e';
    exportCtx.fillRect(0, 0, width, height);

    // Composite all layers in order
    const layers = [this.backgroundLayer, this.dataLayer, this.interactionLayer];
    for (const layer of layers) {
      if (layer?.canvas) {
        exportCtx.drawImage(layer.canvas, 0, 0, width, height);
      }
    }

    // Convert to blob
    const blob = await new Promise<Blob>((resolve, reject) => {
      exportCanvas.toBlob(
        (b) => b ? resolve(b) : reject(new Error('Failed to create PNG blob')),
        'image/png',
      );
    });

    return {
      blob,
      width,
      height,
      format: 'png',
    };
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

  private scheduleRender(): void {
    if (this.destroyed || !this.runtimeHandle || this.frameHandle !== null) {
      return;
    }

    this.frameHandle = this.runtimeHandle.requestFrame((frameTime) => {
      this.frameHandle = null;
      this.render(frameTime);
    });
  }
}

