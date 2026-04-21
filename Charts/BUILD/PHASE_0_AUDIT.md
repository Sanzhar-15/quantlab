# Phase 0: Current State Audit - Charts+ Medium Tier

## Executive Summary

Charts+ Medium tier has a **production-ready Canvas2D-based charting engine** with excellent foundations that can be leveraged for Advanced tier evolution. The architecture is clean, performant, and well-structured.

---

## 1. Core Architecture Components

### 1.1 Data Pipeline (`chart-core`)

**Strengths:**
- ✅ **Columnar storage**: `DataStore` uses `Float64Array` for time and value (optimal for GPU)
- ✅ **LOD Pyramid**: `LodPyramid` and `OhlcLodPyramid` already implement multi-resolution data
- ✅ **Chunked storage**: `ChunkedDataStore` supports virtualized data with backpressure
- ✅ **Data Provider**: Abstract interface for streaming/async data loading
- ✅ **Decimation**: `LineDecimator` and `OhlcDecimator` for viewport-optimized rendering

**Key Files:**
- `packages/chart-core/src/data-store.ts` - Columnar data storage
- `packages/chart-core/src/lod-pyramid.ts` - Multi-resolution LOD system
- `packages/chart-core/src/chunked-data-store.ts` - Virtualized chunks
- `packages/chart-core/src/data-provider.ts` - Streaming data interface

**Reusability**: **100%** - These are already optimal and can be shared between Canvas2D and WebGPU backends.

---

### 1.2 Scale System (`chart-core`)

**Strengths:**
- ✅ **TimeScale**: Linear time-to-pixel mapping with binary search
- ✅ **PriceScale**: Linear/logarithmic scaling with smart tick generation
- ✅ **NumericScale**: Generic numeric scaling
- ✅ **HorizontalScale**: Base scale abstraction

**Key Files:**
- `packages/chart-core/src/time-scale.ts`
- `packages/chart-core/src/price-scale.ts`
- `packages/chart-core/src/numeric-scale.ts`

**Reusability**: **100%** - Scales are backend-agnostic and work perfectly for WebGPU.

---

### 1.3 Layout Engine (`chart-core`)

**Strengths:**
- ✅ **Pane management**: Multi-pane support with stretch factors
- ✅ **Axis layout**: Calculates axis rectangles, plot areas
- ✅ **Layout invalidation**: Efficient dirty flag system

**Key Files:**
- `packages/chart-core/src/layout-engine.ts`

**Reusability**: **100%** - Layout is pure computation, backend-agnostic.

---

### 1.4 Frame Scheduler (`chart-core`)

**Strengths:**
- ✅ **Input coalescing**: Collects events into per-frame intent
- ✅ **Priority system**: Runtime priority levels (0, 1, 2)
- ✅ **Frame budget**: Enforces 10ms frame budget
- ✅ **Intersection Observer**: Pauses when offscreen

**Key Files:**
- `packages/chart-core/src/frame-scheduler.ts`
- `packages/chart-core/src/chart-runtime.ts`

**Reusability**: **100%** - Frame scheduling is backend-agnostic.

---

### 1.5 Rendering System (`chart-render-canvas2d`)

**Current Implementation:**
- ✅ **Layered Canvas**: Underlay, Series, Pan, Overlay layers
- ✅ **Series Renderers**: Line, Candlestick, Area, Histogram, Bar
- ✅ **Grid Renderer**: Analytic grid with crisp lines
- ✅ **Axis Renderer**: Price and time axis with labels
- ✅ **Crosshair**: Smooth crosshair with tooltip
- ✅ **Worker Support**: Optional worker rendering for series

**Key Files:**
- `packages/chart-render-canvas2d/src/index.ts` - Main chart factory
- `packages/chart-render-canvas2d/src/chart-runtime.ts` - Frame loop
- `packages/chart-render-canvas2d/src/canvas-surface.ts` - Canvas management
- `packages/chart-render-canvas2d/src/line-series-renderer.ts`
- `packages/chart-render-canvas2d/src/candlestick-series-renderer.ts`

**Reusability**: **Architecture patterns** - The layered approach and renderer patterns can be adapted for WebGPU.

---

## 2. API Surface Analysis

### 2.1 Public API (`Chart` interface)

**Current Methods:**
```typescript
- addLineSeries(options)
- addCandlestickSeries(options)
- addAreaSeries(options)
- addHistogramSeries(options)
- addBaselineSeries(options)
- addBarSeries(options)
- addCustomSeries(options)
- addPane()
- getPane(id)
- setVisibleTimeRange(range)
- getVisibleTimeRange()
- setTheme(theme)
- setAxisOptions(axis, options)
- setPaneAxisOptions(paneId, axis, options)
- setCrosshair(state)
- onCrosshairMove(callback)
- setCrosshairMode(mode)
- exportPng(options)
- addPlugin(plugin)
- destroy()
```

**Compatibility Requirement**: **MUST MAINTAIN** - This API is the contract. WebGPU backend must implement the same interface.

---

### 2.2 Series API

**Current Methods (all series types):**
```typescript
- setData(points)
- append(point)
- appendBatch(points)
- patchExisting(points)
- updateLast(point)
- setDataProvider(provider, options)
- setMarkers(markers)
- setVisible(visible)
- getVisible()
```

**Compatibility Requirement**: **MUST MAINTAIN** - Series API is stable and well-designed.

---

## 3. Performance Characteristics

### 3.1 Current Performance (from docs)

**Frame Times:**
- SCENARIO_A (3 x 10k): < 6 / 12 ms (median/p95)
- SCENARIO_B (2 x 200k): < 10 / 20 ms
- SCENARIO_C (1 x 2M): < 14 / 28 ms

**Memory:**
- SCENARIO_B: <= 200 MB
- SCENARIO_C: <= 400 MB

**Interaction Latency:**
- Pointermove: < 8 ms p95
- Wheel zoom: < 20 ms
- Drag pan: < 18 ms

**Target for Advanced**: Maintain or improve these metrics with WebGPU backend.

---

## 4. Key Reusable Assets

### 4.1 Data Structures
- ✅ `DataPoint`, `OhlcDataPoint`, `HistogramDataPoint` - Already optimal
- ✅ `VisibleTimeRange` - Time range abstraction
- ✅ `ThemeTokens` - Theme system
- ✅ `LayoutResult`, `Rect` - Geometry types

### 4.2 Algorithms
- ✅ Binary search (`lowerBound`, `upperBound`) - For time lookups
- ✅ LOD pyramid building - Multi-resolution data
- ✅ Decimation - Viewport-optimized rendering
- ✅ Tick generation - Smart axis ticks

### 4.3 Utilities
- ✅ `clamp()` - Math utilities
- ✅ Theme normalization - Theme token validation
- ✅ Invalidation flags - Efficient dirty tracking

---

## 5. Gaps to Address for Advanced Tier

### 5.1 Missing Components (to be built)
- ❌ WebGPU renderer backend
- ❌ Tile cache system
- ❌ Progressive refinement (Stage 0/1/2)
- ❌ MSDF text system
- ❌ Indicator computation engine
- ❌ Drawing tools system
- ❌ Enhanced gesture engine (inertia, pinch)
- ❌ GPU compute for indicators

### 5.2 Enhancements Needed
- ⚠️ Renderer abstraction layer (currently Canvas2D-specific)
- ⚠️ Transport layer (SAB + Message) for worker communication
- ⚠️ Device loss recovery
- ⚠️ Tier selection logic
- ⚠️ Resource budget management

---

## 6. Architecture Patterns to Preserve

### 6.1 Layered Rendering
**Current**: Underlay → Series → Pan → Overlay  
**Advanced**: Same concept, but with tile cache layer

### 6.2 Frame Budgeting
**Current**: 10ms frame budget enforced  
**Advanced**: Same, but with tile refinement scheduling

### 6.3 Input Coalescing
**Current**: Events → Intent → State update  
**Advanced**: Same pattern, enhanced with high-frequency sampling

### 6.4 Invalidation System
**Current**: Dirty flags for layout/series/axes  
**Advanced**: Extend to tile invalidation

---

## 7. Migration Strategy

### 7.1 Backward Compatibility
- Keep `chart-core` as shared foundation
- Keep `chart-render-canvas2d` as Tier D fallback
- New `chart-render-webgpu` implements same `Chart` interface
- Factory function selects backend based on capability tier

### 7.2 Incremental Evolution
- Phase 1: Add WebGPU backend alongside Canvas2D
- Phase 2: Add tile caching to WebGPU backend
- Phase 3: Add advanced features (indicators, drawings)
- Canvas2D remains functional throughout

---

## 8. Performance Baseline

**Current Charts+ Medium:**
- ✅ Excellent frame pacing
- ✅ Low memory usage
- ✅ Smooth interaction
- ✅ Crisp rendering

**Target Advanced:**
- Maintain all current performance characteristics
- Add tile caching for instant pan
- Add GPU acceleration for indicators
- Support 50+ simultaneous indicators

---

## Conclusion

Charts+ Medium tier provides an **excellent foundation** for Advanced tier evolution. The data pipeline, scales, layout, and frame scheduling are already production-ready and backend-agnostic. The main work is:

1. **Add WebGPU backend** (new package, parallel to Canvas2D)
2. **Implement tile caching** (WebGPU-specific optimization)
3. **Add advanced features** (indicators, drawings as new subsystems)
4. **Maintain API compatibility** (same `Chart` interface)

This incremental approach minimizes risk while maximizing reuse of proven components.

