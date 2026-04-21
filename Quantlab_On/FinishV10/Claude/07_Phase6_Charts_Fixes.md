# Phase 6: Charts Fixes (8 fixes)

**Visualization** -- Independent of trading logic, can run in parallel with all other phases.

## Phase Overview

The Charts package has several rendering stubs, type safety issues, and a non-deterministic ID generation bug. These fixes ensure charts render correctly and are production-quality.

## Prerequisites

- None -- this phase is independent of the trading pipeline.

---

## Fix List (Execution Order)

### NEW-CH-001 [HIGH] Fix RenderPipeline data-layer attribute never set

**Problem**: `render-pipeline.ts:47` reads `canvas.getAttribute('data-layer')` but the canvas elements are created without this attribute. Context lookup always fails (returns null).

**Evidence**:
- `Charts/packages/chart-core/src/render-pipeline.ts:47` -- `getAttribute('data-layer')` returns null
- Canvas elements stored in Map with keys like 'background', 'grid', 'underlay', 'series', 'overlay', 'ui' (line 16) but attribute never set on DOM elements

**Root Cause**: Canvas creation code doesn't set the `data-layer` attribute.

**Files to modify**:
- `Charts/packages/chart-core/src/render-pipeline.ts`

**Implementation**:

```typescript
// Charts/packages/chart-core/src/render-pipeline.ts
// When creating canvas layers, set the data-layer attribute:

private createLayers(): void {
    const layerNames = ['background', 'grid', 'underlay', 'series', 'overlay', 'ui'];

    for (const name of layerNames) {
        const canvas = document.createElement('canvas');
        // NEW-CH-001: Set data-layer attribute so lookup works
        canvas.setAttribute('data-layer', name);
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.width = this.width;
        canvas.height = this.height;
        this.container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        if (ctx) {
            this._ctx.set(name, ctx);
        }
        this._canvases.set(name, canvas);
    }
}

// If canvases are created elsewhere, ensure setAttribute is called:
// Alternative fix -- patch the lookup to use the Map directly:
private getLayerContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    // NEW-CH-001: Fallback to Map lookup if data-layer attribute missing
    const layerName = canvas.getAttribute('data-layer');
    if (layerName) {
        return this._ctx.get(layerName) ?? null;
    }
    // Fallback: find canvas in Map and return associated context
    for (const [name, storedCanvas] of this._canvases) {
        if (storedCanvas === canvas) {
            return this._ctx.get(name) ?? null;
        }
    }
    return null;
}
```

**Verification**:
1. Open chart view -> all 6 canvas layers have `data-layer` attribute
2. `getAttribute('data-layer')` returns correct layer name
3. Rendering context lookup succeeds (no null returns)

**Dependencies**: None

---

### NEW-CH-002 [HIGH] Replace Math.random() with deterministic ID generation

**Problem**: 13+ ID generators use `Math.random()` which is not cryptographically random and can produce collisions. Used for drawing IDs (lines 582-594 of drawing-plugin.ts).

**Evidence**:
- `Charts/packages/chart-render-canvas2d/src/drawing-plugin.ts:582-594` -- 13 generators using `Math.random()`
- Additional usage at lines 2721, 6450, 6468, 6114

**Root Cause**: Quick implementation using `Math.random()` instead of proper UUID.

**Files to modify**:
- `Charts/packages/chart-render-canvas2d/src/drawing-plugin.ts`

**Implementation**:

```typescript
// Charts/packages/chart-render-canvas2d/src/drawing-plugin.ts
// Add a deterministic ID generator at the top of the file:

let _idCounter = 0;

function generateId(prefix: string): string {
    // NEW-CH-002: Deterministic, collision-free ID generation
    _idCounter++;
    const timestamp = Date.now().toString(36);
    const counter = _idCounter.toString(36).padStart(4, '0');
    return `${prefix}_${timestamp}_${counter}`;
}

// Replace all Math.random()-based generators:
// BEFORE:
// const generateLineId = () => `line_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
// AFTER:
const generateLineId = () => generateId('line');
const generateFibId = () => generateId('fib');
const generateRectId = () => generateId('rect');
const generateEllipseId = () => generateId('ellipse');
const generateTextId = () => generateId('text');
const generateMarkerId = () => generateId('marker');
const generateMeasureId = () => generateId('measure');
const generateGannId = () => generateId('gann');
const generatePatternId = () => generateId('pattern');
const generatePositionId = () => generateId('pos');
const generatePlanningId = () => generateId('plan');
const generateForecastId = () => generateId('fcst');
const generatePathId = () => generateId('path');

// Also fix the inline Math.random() usages:
// Line 2721: Replace Math.random() in volume profile with deterministic value
// Line 6450: id: `cross-${Date.now()}-${Math.random()}` -> generateId('cross')
// Line 6468: id: `note_${Date.now()}_${Math.random()...}` -> generateId('note')
// Line 6114: id: `callout_${Date.now()}_${Math.random()...}` -> generateId('callout')
```

For the volume profile histogram (line 2721):

```typescript
// BEFORE: const barW = Math.random() * histogramWidth;
// This was likely a placeholder for actual volume data:
const barW = (volumeData[i] / maxVolume) * histogramWidth;
// If volumeData is not available, use deterministic fallback:
// const barW = ((i * 7 + 3) % 100 / 100) * histogramWidth;
```

**Verification**:
1. Create 100 drawings rapidly -> all IDs unique (no collisions)
2. IDs are deterministic (no random component)
3. Volume profile histogram renders with actual data (not random bars)
4. `grep -rn "Math.random()" Charts/packages/chart-render-canvas2d/src/drawing-plugin.ts` -> 0 hits

**Dependencies**: None

---

### NEW-CH-003 [HIGH] Implement Canvas2D renderer stubs (rendering + PNG export)

**Problem**: Canvas2D renderer has two stubs: `render()` at line 240 and `exportPng()` at line 257. Neither does anything.

**Evidence**:
- `Charts/packages/chart-render-canvas2d/src/renderer.ts:240` -- `render()` is a no-op stub
- `Charts/packages/chart-render-canvas2d/src/renderer.ts:257` -- `exportPng()` throws "not implemented"

**Root Cause**: V5.2 3-layer architecture was designed but rendering migration not completed.

**Files to modify**:
- `Charts/packages/chart-render-canvas2d/src/renderer.ts`

**Implementation**:

```typescript
// Charts/packages/chart-render-canvas2d/src/renderer.ts
// Implement the render() method:

public render(frameTime: number): void {
    if (this.destroyed || !this.container || !this.layout) {
        return;
    }

    // NEW-CH-003: Implement 3-layer rendering

    // Layer 0: Background (only on theme/size change)
    if (this.invalidationFlags & InvalidationFlag.Background) {
        this.renderBackground();
    }

    // Layer 1: Data (grid + candles + indicators + volume)
    if (this.invalidationFlags & (InvalidationFlag.Data | InvalidationFlag.Scale)) {
        this.renderDataLayer();
    }

    // Layer 2: Interaction (crosshair + tooltips + labels)
    if (this.invalidationFlags & InvalidationFlag.Interaction) {
        this.renderInteractionLayer();
    }

    // Clear invalidation flags after rendering
    this.invalidationFlags = InvalidationFlag.None;
}

private renderBackground(): void {
    const ctx = this.getLayerContext('background');
    if (!ctx) return;

    const { width, height } = this.layout;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.theme.backgroundColor;
    ctx.fillRect(0, 0, width, height);
}

private renderDataLayer(): void {
    const ctx = this.getLayerContext('series');
    if (!ctx || !this.data) return;

    const { width, height } = this.layout;
    ctx.clearRect(0, 0, width, height);

    // Render grid
    this.renderGrid(ctx);

    // Render candlesticks/bars
    this.renderCandlesticks(ctx);

    // Render volume
    this.renderVolume(ctx);
}

private renderInteractionLayer(): void {
    const ctx = this.getLayerContext('overlay');
    if (!ctx) return;

    const { width, height } = this.layout;
    ctx.clearRect(0, 0, width, height);

    // Render crosshair
    if (this.crosshair) {
        this.renderCrosshair(ctx);
    }
}

// Implement PNG export:
public async exportPng(options?: ExportPngOptions): Promise<ExportPngResult> {
    // NEW-CH-003: Implement PNG export by compositing all layers
    const { width, height } = this.layout;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = options?.width ?? width;
    exportCanvas.height = options?.height ?? height;
    const exportCtx = exportCanvas.getContext('2d')!;

    // Draw background
    exportCtx.fillStyle = this.theme.backgroundColor;
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // Composite all layers in order
    const layerOrder = ['background', 'grid', 'underlay', 'series', 'overlay', 'ui'];
    for (const layerName of layerOrder) {
        const canvas = this._canvases.get(layerName);
        if (canvas) {
            exportCtx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
        }
    }

    // Convert to blob
    const blob = await new Promise<Blob>((resolve, reject) => {
        exportCanvas.toBlob(
            (b) => b ? resolve(b) : reject(new Error('Failed to create PNG')),
            'image/png',
        );
    });

    return {
        blob,
        width: exportCanvas.width,
        height: exportCanvas.height,
        format: 'png',
    };
}
```

**Verification**:
1. Open chart -> candles render (not blank canvas)
2. Export PNG -> valid image file with chart content
3. All 3 layers visible in rendered output
4. No "not implemented" errors

**Dependencies**: NEW-CH-001 (layer attribute fix)

---

### NEW-CH-004 [MEDIUM] Complete MSDF text atlas loading and rendering

**Problem**: MSDF atlas creates placeholder glyphs but doesn't load actual font metrics or texture data.

**Evidence**:
- `Charts/packages/chart-text/src/msdf-atlas.ts:58` -- `loadPrebakedAtlas()` creates placeholder
- `Charts/packages/chart-text/src/msdf-atlas.ts:171` -- `processInsertionQueue()` is a stub

**Files to modify**:
- `Charts/packages/chart-text/src/msdf-atlas.ts`

**Implementation**:

```typescript
// Charts/packages/chart-text/src/msdf-atlas.ts
// Implement loadPrebakedAtlas:

public async loadPrebakedAtlas(fontSize: number = 16): Promise<MSDFAtlas> {
    if (!this.device) {
        throw new Error('MSDFAtlasLoader not initialized');
    }

    // NEW-CH-004: Load actual MSDF atlas from bundled assets
    const atlasUrl = this.resolveAtlasUrl(fontSize);
    const metricsUrl = this.resolveMetricsUrl(fontSize);

    try {
        // Load atlas texture
        const [atlasResponse, metricsResponse] = await Promise.all([
            fetch(atlasUrl),
            fetch(metricsUrl),
        ]);

        if (!atlasResponse.ok || !metricsResponse.ok) {
            // Fall back to canvas-based text rendering
            return this.createCanvasFallbackAtlas(fontSize);
        }

        const atlasBlob = await atlasResponse.blob();
        const metrics = await metricsResponse.json();

        // Create GPU texture from atlas image
        const imageBitmap = await createImageBitmap(atlasBlob);
        const texture = this.device.createTexture({
            size: [imageBitmap.width, imageBitmap.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.copyExternalImageToTexture(
            { source: imageBitmap },
            { texture },
            [imageBitmap.width, imageBitmap.height],
        );

        return {
            texture,
            metrics,
            fontSize,
            lineHeight: metrics.lineHeight ?? fontSize * 1.2,
        };
    } catch (error) {
        // Fall back to canvas text rendering
        console.warn('MSDF atlas load failed, using canvas fallback:', error);
        return this.createCanvasFallbackAtlas(fontSize);
    }
}

private createCanvasFallbackAtlas(fontSize: number): MSDFAtlas {
    // Create a canvas-based atlas for environments without MSDF assets
    const canvas = document.createElement('canvas');
    const size = 512;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'top';

    const glyphs: Record<string, GlyphMetrics> = {};
    let x = 0, y = 0;
    const lineHeight = fontSize * 1.4;

    // Render basic Latin characters
    for (let code = 32; code < 127; code++) {
        const char = String.fromCharCode(code);
        const metrics = ctx.measureText(char);
        const charWidth = Math.ceil(metrics.width) + 2;

        if (x + charWidth > size) {
            x = 0;
            y += lineHeight;
        }

        ctx.fillText(char, x, y);
        glyphs[char] = {
            x, y,
            width: charWidth,
            height: lineHeight,
            advance: metrics.width,
        };
        x += charWidth;
    }

    return {
        texture: null, // Canvas-based, no GPU texture
        canvas,
        metrics: { glyphs, fontSize, lineHeight },
        fontSize,
        lineHeight,
    };
}
```

**Verification**:
1. Chart labels render readable text (not blank/placeholder)
2. MSDF assets load from bundle -> crisp text at all zoom levels
3. Missing assets -> canvas fallback provides readable text
4. Performance: text rendering doesn't cause frame drops

**Dependencies**: None

---

### NEW-CH-005 [MEDIUM] Complete WebGPU indicator/drawing renderers

**Problem**: WebGPU renderer has indicator and drawing renderers commented out (lines 45-48, 109-116, 1086-1128).

**Evidence**:
- `Charts/packages/chart-render-webgpu/src/renderer.ts:45-48` -- imports commented out
- `Charts/packages/chart-render-webgpu/src/renderer.ts:109-116` -- instances commented out
- `Charts/packages/chart-render-webgpu/src/renderer.ts:1086-1128` -- render methods commented out

**Root Cause**: WebGPU renderers designed but implementations deferred.

**Files to modify**:
- `Charts/packages/chart-render-webgpu/src/renderer.ts`

**Implementation**:

```typescript
// Charts/packages/chart-render-webgpu/src/renderer.ts
// Uncomment imports and add implementations:

// Line 45-48: Uncomment imports
import { IndicatorRenderer, type IndicatorRenderData } from '@charts-plus/chart-indicators';
import { DrawingRenderer, type DrawingRenderData } from '@charts-plus/chart-drawings';
import { CoordinateTransformImpl } from '@charts-plus/chart-drawings';

// Line 109-116: Uncomment instances
private indicatorRenderer: IndicatorRenderer | null = null;
private drawingRenderer: DrawingRenderer | null = null;
private drawingTransform: CoordinateTransformImpl | null = null;

// Line 218-224: Uncomment initialization
// In init():
this.indicatorRenderer = new IndicatorRenderer(this.device, this.pipelineLayout);
this.drawingRenderer = new DrawingRenderer(this.device, this.pipelineLayout);

// Lines 1086-1128: Implement render methods
private renderIndicators(encoder: GPURenderPassEncoder): void {
    if (!this.indicatorRenderer || !this.indicatorData) {
        return;
    }

    for (const indicator of this.indicatorData) {
        this.indicatorRenderer.render(encoder, indicator, this.transform);
    }
}

private renderDrawings(encoder: GPURenderPassEncoder): void {
    if (!this.drawingRenderer || !this.drawingData) {
        return;
    }

    for (const drawing of this.drawingData) {
        this.drawingRenderer.render(encoder, drawing, this.drawingTransform!);
    }
}
```

**Note**: If `IndicatorRenderer` and `DrawingRenderer` classes don't exist yet in their respective packages, they need to be created. This may be a larger effort depending on the package state.

**Verification**:
1. Enable WebGPU renderer (if GPU available)
2. Add indicator overlay -> renders via WebGPU
3. Add drawing tool -> renders via WebGPU
4. Performance: GPU-accelerated rendering maintains 60fps

**Dependencies**: None

---

### NEW-CH-006 [MEDIUM] Replace `any` types with proper interfaces

**Problem**: 15+ files use `any` type where proper interfaces should exist, bypassing TypeScript's type safety.

**Evidence**:
- `Charts/packages/chart-trading/src/trading-overlay.ts:21` -- `chart: any`
- Additional occurrences across chart packages

**Files to modify**:
- `Charts/packages/chart-trading/src/trading-overlay.ts`
- Other files with `any` types (scan with `grep -rn ': any' Charts/packages/`)

**Implementation**:

```typescript
// Charts/packages/chart-trading/src/trading-overlay.ts
// Replace `any` with proper interface:

// NEW-CH-006: Define chart interface
interface ChartInstance {
    invalidate(): void;
    getTimeScale(): TimeScale;
    getPriceScale(): PriceScale;
    getVisibleRange(): TimeRange;
    subscribeClick(handler: (event: MouseEvent) => void): void;
    unsubscribeClick(handler: (event: MouseEvent) => void): void;
}

export class TradingOverlay {
    // BEFORE: private chart: any;
    // AFTER:
    private chart: ChartInstance;

    constructor(chart: ChartInstance, options: TradingOverlayOptions = {}) {
        this.chart = chart;
        // ...
    }

    private requestRedraw(): void {
        // Type-safe method call
        if (this.chart) {
            this.chart.invalidate();
        }
    }
}
```

Apply similar fixes across other chart packages. For each `any` usage:
1. Identify the actual type from usage patterns
2. Create or reference existing interfaces
3. Replace `any` with the specific type

**Verification**:
1. `grep -rn ': any' Charts/packages/chart-trading/` -- reduced to 0 (or near 0)
2. TypeScript compilation succeeds with strict mode
3. No runtime errors from type changes

**Dependencies**: None

---

### NEW-CH-007 [MEDIUM] Fix DrawingManager missing DrawingStyle interface

**Problem**: DrawingManager uses `DrawingStyle` from `'./types'` but the interface may be incomplete.

**Evidence**:
- `Charts/packages/chart-drawings/src/drawing-manager.ts:76` -- uses `Partial<DrawingStyle>`
- `Charts/packages/chart-drawings/src/drawing-manager.ts:345` -- imports from `'./types'`

**Files to modify**:
- `Charts/packages/chart-drawings/src/types.ts`

**Implementation**:

```typescript
// Charts/packages/chart-drawings/src/types.ts
// Ensure DrawingStyle is complete:

export interface DrawingStyle {
    /** Line color (CSS color string) */
    lineColor: string;
    /** Line width in pixels */
    lineWidth: number;
    /** Line dash pattern (empty = solid) */
    lineDash: number[];
    /** Fill color (CSS color string, empty = no fill) */
    fillColor: string;
    /** Fill opacity (0-1) */
    fillOpacity: number;
    /** Text color */
    textColor: string;
    /** Font size in pixels */
    fontSize: number;
    /** Font family */
    fontFamily: string;
    /** Whether drawing is visible */
    visible: boolean;
    /** Whether drawing is locked (can't be moved) */
    locked: boolean;
    /** Z-index for rendering order */
    zIndex: number;
}

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
    lineColor: '#2196F3',
    lineWidth: 1,
    lineDash: [],
    fillColor: '',
    fillOpacity: 0.2,
    textColor: '#ffffff',
    fontSize: 12,
    fontFamily: 'monospace',
    visible: true,
    locked: false,
    zIndex: 0,
};
```

**Verification**:
1. Create drawing with partial style -> defaults applied
2. All DrawingStyle properties typed (no `any`)
3. TypeScript compilation succeeds

**Dependencies**: None

---

### NEW-CH-008 [LOW] Require explicit telemetry consent in error handler

**Problem**: Error handler can be enabled to send telemetry (stack traces, userAgent) without explicit user consent UI.

**Evidence**:
- `Charts/packages/chart-core/src/error-handler.ts:78-88` -- `enableTelemetry()` with no consent check
- `Charts/packages/chart-core/src/error-handler.ts:140-161` -- sends error data to endpoint

**Root Cause**: Telemetry enablement API exists without consent gating.

**Files to modify**:
- `Charts/packages/chart-core/src/error-handler.ts`

**Implementation**:

```typescript
// Charts/packages/chart-core/src/error-handler.ts

private telemetryEnabled = false;
private telemetryEndpoint: string | null = null;
private telemetryConsented = false;  // NEW-CH-008

/**
 * Enable telemetry with explicit consent verification.
 * NEW-CH-008: Telemetry requires explicit consent before activation.
 */
public enableTelemetry(endpoint: string, options?: { userConsented: boolean }): void {
    if (!options?.userConsented) {
        console.warn(
            'Telemetry not enabled: explicit user consent required. ' +
            'Call enableTelemetry(endpoint, { userConsented: true }) after obtaining consent.'
        );
        return;
    }

    this.telemetryEnabled = true;
    this.telemetryConsented = true;
    this.telemetryEndpoint = endpoint;
}

/**
 * Disable telemetry and clear consent.
 */
public disableTelemetry(): void {
    this.telemetryEnabled = false;
    this.telemetryConsented = false;
    this.telemetryEndpoint = null;
}

private async sendToTelemetry(error: Error, context?: string): Promise<void> {
    // NEW-CH-008: Double-check consent before sending
    if (!this.telemetryEndpoint || !this.telemetryConsented) {
        return;
    }

    try {
        await fetch(this.telemetryEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: error.message,
                // NEW-CH-008: Redact stack traces unless explicitly opted in
                stack: this.includeStackTraces ? error.stack : undefined,
                context,
                timestamp: Date.now(),
                // NEW-CH-008: Don't send userAgent without consent
            }),
        });
    } catch (telemetryError) {
        // Silently fail telemetry
    }
}
```

**Verification**:
1. Call `enableTelemetry(url)` without consent -> warning logged, telemetry not enabled
2. Call `enableTelemetry(url, { userConsented: true })` -> telemetry enabled
3. Error occurs with telemetry enabled -> data sent (without userAgent)
4. Call `disableTelemetry()` -> no more data sent

**Dependencies**: None

---

## Phase Verification Checklist

- [ ] Chart canvas layers have `data-layer` attribute, context lookup works
- [ ] All drawing IDs use deterministic generation (no Math.random)
- [ ] Canvas2D render() produces visible candlesticks
- [ ] PNG export creates valid image file
- [ ] Text rendering works (MSDF or canvas fallback)
- [ ] WebGPU indicator/drawing renderers uncommented and functional (if GPU available)
- [ ] `any` types reduced in chart packages
- [ ] DrawingStyle interface complete with defaults
- [ ] Telemetry requires explicit consent

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "Charts not implemented" | Charts package has 10 sub-packages, Canvas2D + WebGPU renderers, drawing tools, indicators |
| "No rendering" | RenderPipeline exists (66 lines), Canvas2D renderer (286 lines), WebGPU renderer (1148 lines) -- need stub implementations |
| "No text rendering" | MSDF atlas system exists (223 lines) with fallback path -- needs asset loading |
