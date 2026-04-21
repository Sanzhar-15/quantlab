# Phase 0: Architecture Bridge Design

## Overview

The architecture bridge enables **multi-backend rendering** while maintaining a unified API. Both Canvas2D (Tier D) and WebGPU (Tier A/B) backends implement the same `ChartRenderer` interface, allowing seamless backend selection based on capability tier.

---

## 1. Renderer Abstraction Layer

### 1.1 Core Interface: `ChartRenderer`

```typescript
// packages/chart-core/src/renderer-interface.ts

export type RendererTier = 'A' | 'B' | 'C' | 'D';

export interface ChartRenderer {
  readonly tier: RendererTier;
  
  // Lifecycle
  initialize(container: HTMLElement, options: RendererOptions): void;
  destroy(): void;
  
  // Theme
  setTheme(theme: ThemeTokens): void;
  
  // Layout
  setLayout(layout: LayoutResult): void;
  
  // Series
  addSeries(series: InternalSeries): void;
  removeSeries(seriesId: string): void;
  updateSeries(seriesId: string, data: SeriesData): void;
  
  // Axes
  setAxisOptions(axis: AxisId, options: AxisOptions): void;
  setPaneAxisOptions(paneId: PaneId, axis: AxisId, options: AxisOptions): void;
  
  // Time Range
  setVisibleTimeRange(range: VisibleTimeRange): void;
  
  // Crosshair
  setCrosshair(state: CrosshairState | null): void;
  
  // Rendering
  render(frameTime: number): void;
  invalidate(flags: InvalidationFlag): void;
  
  // Export
  exportPng(options: ExportPngOptions): Promise<ExportPngResult>;
  
  // Plugins
  addPlugin(plugin: ChartPlugin): void;
  removePlugin(plugin: ChartPlugin): void;
}
```

### 1.2 Renderer Options

```typescript
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
```

---

## 2. Backend Selection Logic

### 2.1 Capability Tier Detection

```typescript
// packages/chart-core/src/tier-detection.ts

export async function detectCapabilityTier(): Promise<RendererTier> {
  // Tier A: WebGPU in Worker (SharedArrayBuffer available)
  if (await canUseWebGPUWorker()) {
    return 'A';
  }
  
  // Tier B: WebGPU on Main Thread
  if (await canUseWebGPU()) {
    return 'B';
  }
  
  // Tier C: WebGL2 (future)
  if (await canUseWebGL2()) {
    return 'C';
  }
  
  // Tier D: Canvas2D (always available)
  return 'D';
}

async function canUseWebGPUWorker(): Promise<boolean> {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (!('gpu' in navigator)) return false;
  
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    
    // Micro-benchmark: Can we create a device and run a simple compute shader?
    const device = await adapter.requestDevice();
    // ... run micro-benchmark ...
    return true;
  } catch {
    return false;
  }
}

async function canUseWebGPU(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}
```

### 2.2 Renderer Factory

```typescript
// packages/chart-core/src/renderer-factory.ts

import { Canvas2DRenderer } from '@charts-plus/chart-render-canvas2d';
import { WebGPURenderer } from '@charts-plus/chart-render-webgpu';

export async function createRenderer(
  tier: RendererTier,
  container: HTMLElement,
  options: RendererOptions
): Promise<ChartRenderer> {
  switch (tier) {
    case 'A':
    case 'B':
      return new WebGPURenderer(tier);
    case 'C':
      // Future: WebGL2Renderer
      throw new Error('WebGL2 backend not yet implemented');
    case 'D':
      return new Canvas2DRenderer();
    default:
      throw new Error(`Unknown renderer tier: ${tier}`);
  }
}
```

---

## 3. Package Structure

```
Advanced/
├── packages/
│   ├── chart-core/                    # Shared foundation
│   │   ├── src/
│   │   │   ├── renderer-interface.ts  # NEW: ChartRenderer interface
│   │   │   ├── renderer-factory.ts    # NEW: Backend selection
│   │   │   ├── tier-detection.ts      # NEW: Capability detection
│   │   │   ├── data-store.ts          # Existing (reuse)
│   │   │   ├── lod-pyramid.ts         # Existing (reuse)
│   │   │   ├── price-scale.ts         # Existing (reuse)
│   │   │   └── ...                    # All existing core logic
│   │
│   ├── chart-render-canvas2d/         # Tier D (existing, refactor)
│   │   ├── src/
│   │   │   ├── renderer.ts            # NEW: Implements ChartRenderer
│   │   │   ├── canvas-surface.ts      # Existing
│   │   │   ├── line-series-renderer.ts # Existing
│   │   │   └── ...                    # All existing renderers
│   │
│   ├── chart-render-webgpu/            # NEW: Tier A/B
│   │   ├── src/
│   │   │   ├── renderer.ts            # Implements ChartRenderer
│   │   │   ├── device-manager.ts       # GPU device management
│   │   │   ├── pipeline-cache.ts      # Shader pipeline cache
│   │   │   ├── candlestick-shader.wgsl # WGSL shaders
│   │   │   ├── grid-shader.wgsl
│   │   │   └── ...
│   │
│   └── chart/                          # Public API (evolve from Medium)
│       ├── src/
│       │   ├── index.ts                # createChart() factory
│       │   └── chart-impl.ts           # Chart interface implementation
```

---

## 4. Data Flow

### 4.1 Unified Data Pipeline

```
Data (CSV/API/Stream)
    ↓
DataStore (columnar Float64Array)
    ↓
LOD Pyramid (multi-resolution)
    ↓
[Renderer Backend]
    ├── Canvas2D: Decimation → Canvas2D rendering
    └── WebGPU: Tile Cache → GPU rendering
```

**Key Insight**: Both backends consume the same `DataStore` and `LodPyramid` instances. The renderer abstraction is purely about **how** data is rendered, not **what** data is rendered.

---

## 5. Migration Path

### 5.1 Phase 1: Interface Creation

1. Create `ChartRenderer` interface in `chart-core`
2. Refactor `chart-render-canvas2d` to implement interface
3. Create stub `chart-render-webgpu` that implements interface
4. Update `createChart()` to use renderer factory

### 5.2 Phase 2: WebGPU Implementation

1. Implement WebGPU device manager
2. Implement basic rendering (candles, grid, crosshair)
3. Test tier selection and fallback

### 5.3 Phase 3: Feature Parity

1. Implement all series types in WebGPU
2. Implement axes, crosshair, plugins
3. Performance optimization

---

## 6. Backward Compatibility

### 6.1 API Compatibility

- ✅ `createChart()` signature unchanged
- ✅ `Chart` interface unchanged
- ✅ Series APIs unchanged
- ✅ All options unchanged

### 6.2 Behavior Compatibility

- ✅ Canvas2D backend behaves identically to Medium tier
- ✅ WebGPU backend produces visually identical output
- ✅ Performance characteristics may differ (expected)

---

## 7. Implementation Notes

### 7.1 Renderer State Management

Each renderer maintains its own state:
- **Canvas2D**: Canvas contexts, pan cache, label cache
- **WebGPU**: GPU device, pipelines, tile cache, texture atlas

The `Chart` implementation coordinates between `chart-core` (data/layout) and the renderer (visualization).

### 7.2 Invalidation System

Both backends use the same `InvalidationFlag` system:
- `Layout` - Recalculate layout
- `Series` - Redraw series
- `Axes` - Redraw axes
- `Crosshair` - Update crosshair
- `Theme` - Theme changed

WebGPU adds:
- `TileCache` - Invalidate tile cache
- `Pipeline` - Rebuild shader pipelines

### 7.3 Frame Scheduling

Both backends use the same `FrameScheduler` from `chart-core`:
- Input coalescing
- Frame budget enforcement
- Priority system

The renderer's `render()` method is called by the frame scheduler.

---

## 8. Testing Strategy

### 8.1 Visual Regression

- Render same data with Canvas2D and WebGPU
- Compare outputs pixel-by-pixel (allow small differences for anti-aliasing)
- Ensure identical behavior for all series types

### 8.2 Performance Regression

- Benchmark both backends on same datasets
- Ensure WebGPU meets or exceeds Canvas2D performance
- Monitor memory usage

### 8.3 Tier Fallback

- Test tier selection logic
- Test graceful degradation (A → B → C → D)
- Test device loss recovery

---

## Conclusion

The architecture bridge enables **incremental evolution** from Canvas2D to WebGPU while maintaining full backward compatibility. The renderer abstraction layer is the key enabler, allowing both backends to coexist and be selected based on capability tier.

**Next Steps:**
1. Implement `ChartRenderer` interface
2. Refactor Canvas2D to implement interface
3. Create WebGPU renderer stub
4. Update `createChart()` factory

