# Delta Charting Engine V3 — Cursor-Optimized Implementation Plan

## Philosophy: Why This Approach

Cursor/AI coding assistants work best with:
- **Bounded scope**: One module, one concern per session
- **Clear context**: Small, focused spec snippets, not 200KB docs
- **Testable outputs**: Each session produces something you can verify
- **Explicit dependencies**: AI knows what exists and what to import

This plan breaks V3 into **18 implementation phases** across **6 milestones**.
Each phase has a "Phase Spec" document you'll feed to Cursor.

---

## Project Structure (Create First)

```
delta-chart/
├── packages/
│   ├── core/                 # Math, types, utilities
│   ├── data/                 # Data pipeline, LOD, streaming
│   ├── render/               # Renderer abstraction, scene graph
│   ├── webgpu/               # WebGPU backend
│   ├── webgl2/               # WebGL2 fallback (later)
│   ├── canvas2d/             # Canvas2D fallback (later)
│   ├── text/                 # MSDF + fallback text
│   ├── indicators/           # Indicator engine
│   ├── drawings/             # Drawing tools
│   ├── interaction/          # Gestures, hit testing
│   ├── transport/            # SAB + Message transport
│   └── chart/                # Public API, integration
├── apps/
│   ├── demo/                 # Demo application
│   └── benchmark/            # Performance benchmarks
├── tests/
│   ├── unit/
│   ├── integration/
│   └── visual/               # Golden image tests
└── docs/
    └── phase-specs/          # Cursor-optimized phase docs
```

---

## Milestone 0: Foundation (Week 1-2)

### Phase 0.1: Project Scaffolding
**Time**: 2-4 hours
**Cursor prompt**: "Set up a TypeScript monorepo with pnpm workspaces"

```
Create:
- pnpm-workspace.yaml
- tsconfig.json (base + package configs)
- Package scaffolds with package.json
- Vitest config
- ESLint + Prettier
```

**DoD**: `pnpm install && pnpm build` succeeds

---

### Phase 0.2: Core Types and Math
**Time**: 4-6 hours
**Feed to Cursor**: Phase spec below + relevant V3 excerpts

**Phase Spec (copy this to Cursor):**
```markdown
# Phase 0.2: Core Types and Math

Create @anthropic/delta-chart-core package with:

## Types (src/types.ts)
- Time types: UTCTimestamp, BusinessDay, Time union
- Coordinate types: Point, Rect, Viewport
- Color types: ColorType (string | gradient)
- Series types: BarData, LineData, CandlestickData
- Range types: TimeRange, PriceRange, LogicalRange

## Math utilities (src/math/)
- clamp, lerp, inverseLerp
- distance, normalize
- Rect operations: contains, intersects, union, expand

## Scale utilities (src/scales/)
- LinearScale: domain/range mapping with invert
- LogScale: logarithmic mapping
- TimeScale: time-to-pixel with timezone support

## Formatting (src/format/)
- formatPrice(price, precision): string
- formatTime(time, format): string
- formatVolume(volume): string with K/M/B suffixes

## Tests
- Unit tests for all math functions
- Scale inversion tests (forward then backward = identity)
```

**DoD**: All tests pass, types export correctly

---

### Phase 0.3: Transport Layer
**Time**: 4-6 hours
**Feed to Cursor**: Phase spec + Doc 02 + Doc 11 excerpts

**Phase Spec:**
```markdown
# Phase 0.3: Transport Layer

Create @anthropic/delta-chart-transport package.

## Transport Interface (src/types.ts)
interface Transport {
  readonly mode: "SAB" | "Message";
  writeInput(state: InputState): void;
  readInput(): InputState;
  sendData(buffer: ArrayBuffer): void;
  onData(callback: (buffer: ArrayBuffer) => void): () => void;
  destroy(): void;
}

## InputState struct (for both modes)
- pointerX, pointerY (f32)
- buttons, modifiers (i32)
- wheelDeltaX, wheelDeltaY (f32)
- pinchScale, pinchCenterX, pinchCenterY (f32)
- timestamp (f64)
- sequence number (i32)

## MessageTransport (src/message.ts)
- Uses postMessage with transferable ArrayBuffers
- Coalesces input events (max 1 per frame)
- Implements Transport interface

## SABTransport (src/sab.ts)
- Uses SharedArrayBuffer when crossOriginIsolated
- Atomic writes with sequence number for torn read detection
- InputState in fixed struct layout (64 bytes)
- Implements Transport interface

## Factory (src/index.ts)
function createTransport(options?: { preferSAB?: boolean }): Transport
- Detects crossOriginIsolated
- Returns SABTransport if available and preferred
- Falls back to MessageTransport

## Tests
- MessageTransport round-trip test
- SABTransport torn read prevention test
- Factory selection logic test
```

**DoD**: Both transports work, factory selects correctly

---

### Phase 0.4: Binary Codec
**Time**: 6-8 hours
**Feed to Cursor**: Phase spec + Doc 11 + Doc 16

**Phase Spec:**
```markdown
# Phase 0.4: Binary Codec

Create binary encoder/decoder in @anthropic/delta-chart-transport.

## Packet Header (32 bytes)
- magic: u32 (0x444C5441 "DLTA")
- protocolVersion: u16
- msgType: u16
- seq: u32
- flags: u32
- tMs: f64
- payloadBytes: u32
- headerCrc32: u32

## Message Types (implement these)
- 0x0200 SET_VIEWPORT
- 0x0201 SET_THEME
- 0x0301 SET_SERIES_CHUNK
- 0x0302 APPEND_TICKS

## Series Chunk Codec
- Columnar layout: time[], open[], high[], low[], close[], volume[]
- Offsets table for self-describing payload
- Zero-copy decode (return typed array views)

## Implementation
- src/codec/header.ts: readHeader, writeHeader
- src/codec/series.ts: encodeSeriesChunk, decodeSeriesChunk
- src/codec/viewport.ts: encodeViewport, decodeViewport
- src/codec/index.ts: exports

## Tests
- Round-trip encode/decode equality
- Alignment verification (arrays at 16-byte boundaries)
- Large chunk performance test (100k bars < 10ms)
```

**DoD**: Codec tests pass, 100k bar encode/decode < 10ms

---

## Milestone 1: Basic Rendering (Week 2-4)

### Phase 1.1: Renderer Abstraction
**Time**: 4-6 hours

**Phase Spec:**
```markdown
# Phase 1.1: Renderer Abstraction

Create @anthropic/delta-chart-render with renderer interface.

## Renderer Interface (src/types.ts)
interface ChartRenderer {
  readonly tier: "A" | "B" | "C" | "D";
  
  init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void>;
  destroy(): void;
  
  resize(width: number, height: number, dpr: number): void;
  setViewport(viewport: Viewport): void;
  setTheme(theme: ThemeTokens): void;
  
  setSeriesData(seriesId: string, data: SeriesBuffers): void;
  updateTick(seriesId: string, tick: TickData): void;
  
  setInputState(state: InputState): void;
  renderFrame(timestamp: number): void;
  
  getStats(): RendererStats;
}

## Viewport type
interface Viewport {
  // Visible time range
  timeStart: number;
  timeEnd: number;
  
  // Visible price range (auto-scaled or fixed)
  priceMin: number;
  priceMax: number;
  
  // Canvas dimensions
  width: number;
  height: number;
  dpr: number;
}

## Theme tokens (minimal for now)
interface ThemeTokens {
  background: string;
  gridColor: string;
  textColor: string;
  upColor: string;
  downColor: string;
  crosshairColor: string;
}

## RendererStats
interface RendererStats {
  fps: number;
  frameTimeMs: number;
  gpuMemoryMB: number;
  tileCount: number;
  cacheHitRate: number;
}

## Stub implementation (src/stub.ts)
Create a stub that implements interface but just logs calls.
This lets other packages develop against the interface.
```

**DoD**: Interface compiles, stub implementation works

---

### Phase 1.2: WebGPU Device Init
**Time**: 6-8 hours
**Feed to Cursor**: Phase spec + Doc 00 section 7 + Doc 01

**Phase Spec:**
```markdown
# Phase 1.2: WebGPU Device Initialization

Create @anthropic/delta-chart-webgpu package.

## Device Manager (src/device.ts)
class GPUDeviceManager {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  
  async init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void>
  // 1. Check navigator.gpu exists
  // 2. Request adapter with powerPreference: "high-performance"
  // 3. Request device with required features/limits
  // 4. Configure canvas context with preferred format
  // 5. Set up device.lost handler
  
  get device(): GPUDevice
  get context(): GPUCanvasContext
  get format(): GPUTextureFormat
  
  destroy(): void
  
  // Device loss handling
  private onDeviceLost(info: GPUDeviceLostInfo): void
  // Log, attempt reinit, emit event if failed
}

## Tier Detection (src/tier.ts)
async function detectTier(): Promise<"A" | "B" | "C" | "D">
// 1. Check WebGPU availability
// 2. Check OffscreenCanvas + worker viability (for Tier A)
// 3. Run micro-benchmark (tiny instanced draw)
// 4. Return appropriate tier

## Pipeline Cache (src/pipelines.ts)
class PipelineCache {
  private cache: Map<string, GPURenderPipeline> = new Map();
  
  async getOrCreate(
    key: string, 
    descriptor: GPURenderPipelineDescriptor
  ): Promise<GPURenderPipeline>
  
  async warmup(device: GPUDevice): Promise<void>
  // Pre-compile essential pipelines: candles, grid, crosshair
}

## Tests
- Device init succeeds (or gracefully fails with reason)
- Tier detection returns valid tier
- Pipeline cache deduplicates
```

**DoD**: Device initializes on WebGPU-capable browser, tier detected

---

### Phase 1.3: Candlestick Renderer
**Time**: 8-12 hours
**Feed to Cursor**: Phase spec + Doc 12 section on candles

**Phase Spec:**
```markdown
# Phase 1.3: Candlestick Renderer

Add instanced candlestick rendering to webgpu package.

## Candle Shader (src/shaders/candle.wgsl)
Vertex shader:
- Input: instance buffer with (x, open, high, low, close, colorFlags)
- Expand to body quad + wick line geometry
- Output: position, color

Fragment shader:
- Simple color output (no texturing yet)

## Instance Buffer Layout
struct CandleInstance {
  x: f32,           // Center X in clip space
  open: f32,        // Open price (normalized)
  high: f32,
  low: f32,
  close: f32,
  flags: u32,       // Bit 0: up/down, other bits reserved
}
// 24 bytes per candle, 16-byte aligned

## Camera Uniform
struct Camera {
  viewProjection: mat4x4<f32>,
  timeRange: vec2<f32>,      // visible time start/end
  priceRange: vec2<f32>,     // visible price min/max
  canvasSize: vec2<f32>,
  candleWidth: f32,          // in pixels
  _padding: f32,
}

## CandleRenderer class (src/candles.ts)
class CandleRenderer {
  private pipeline: GPURenderPipeline;
  private instanceBuffer: GPUBuffer;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  
  constructor(device: GPUDevice, format: GPUTextureFormat)
  
  setData(candles: CandlestickData[]): void
  // Convert to instance buffer format
  // Upload to GPU
  
  updateCamera(viewport: Viewport, theme: ThemeTokens): void
  // Update uniform buffer
  
  render(pass: GPURenderPassEncoder): void
  // Set pipeline, bindgroup
  // Draw instanced (6 vertices per candle for body+wick)
}

## Integration
- Wire into main renderer class
- Render 1000 candles as test

## Tests
- Visual test: render known data, compare to golden image
- Performance: 100k candles render < 5ms
```

**DoD**: Candles render correctly, 100k candles < 5ms

---

### Phase 1.4: Grid Renderer
**Time**: 4-6 hours

**Phase Spec:**
```markdown
# Phase 1.4: Analytic Grid Renderer

Add grid rendering (no geometry, pure shader).

## Grid Shader (src/shaders/grid.wgsl)
Full-screen quad, compute grid lines analytically:

struct GridUniforms {
  canvasSize: vec2<f32>,
  timeRange: vec2<f32>,
  priceRange: vec2<f32>,
  gridColor: vec4<f32>,
  majorSpacingTime: f32,    // pixels between major time lines
  majorSpacingPrice: f32,   // pixels between major price lines
  minorDivisions: u32,      // minor lines per major
}

Fragment shader:
- Compute distance to nearest grid line
- Use smoothstep for anti-aliased lines
- Major lines slightly thicker/darker than minor

## GridRenderer class (src/grid.ts)
class GridRenderer {
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  
  updateUniforms(viewport: Viewport, theme: ThemeTokens): void
  render(pass: GPURenderPassEncoder): void
}

## Tick Generation (src/ticks.ts)
function generatePriceTicks(min: number, max: number, targetCount: number): number[]
// "Nice numbers" algorithm: round to 1, 2, 5 multiples

function generateTimeTicks(start: number, end: number, targetCount: number): number[]
// Snap to sensible intervals: 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M

## Tests
- Grid lines at correct positions
- Nice numbers produce readable values
```

**DoD**: Grid renders with properly spaced lines

---

### Phase 1.5: Crosshair Overlay
**Time**: 4-6 hours

**Phase Spec:**
```markdown
# Phase 1.5: Crosshair Overlay

Add crosshair that follows pointer.

## Crosshair Shader (src/shaders/crosshair.wgsl)
Two line quads (horizontal + vertical):

struct CrosshairUniforms {
  position: vec2<f32>,      // crosshair center in pixels
  canvasSize: vec2<f32>,
  color: vec4<f32>,
  thickness: f32,
}

## CrosshairRenderer class (src/crosshair.ts)
class CrosshairRenderer {
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  
  setPosition(x: number, y: number): void
  setVisible(visible: boolean): void
  render(pass: GPURenderPassEncoder): void
}

## Tooltip Data (CPU-side)
Given crosshair position, compute:
- Nearest bar index from X coordinate
- OHLCV values from data arrays (no GPU readback!)
- Price value from Y coordinate

function getCrosshairData(
  x: number, 
  y: number, 
  viewport: Viewport, 
  data: CandlestickData[]
): CrosshairData | null

## Integration
- Crosshair renders LAST (always on top)
- Crosshair updates don't invalidate tiles
- Return tooltip data for UI layer

## Tests
- Crosshair follows pointer
- Tooltip data correct for given position
```

**DoD**: Crosshair follows mouse, tooltip data accurate

---

### Phase 1.6: Frame Loop Integration
**Time**: 6-8 hours

**Phase Spec:**
```markdown
# Phase 1.6: Frame Loop and Renderer Integration

Wire everything together into working frame loop.

## WebGPURenderer class (src/renderer.ts)
Implements ChartRenderer interface from render package.

class WebGPURenderer implements ChartRenderer {
  readonly tier = "B";  // Main thread for now
  
  private deviceManager: GPUDeviceManager;
  private candleRenderer: CandleRenderer;
  private gridRenderer: GridRenderer;
  private crosshairRenderer: CrosshairRenderer;
  
  private viewport: Viewport;
  private theme: ThemeTokens;
  private inputState: InputState;
  private seriesData: Map<string, CandlestickData[]>;
  
  async init(canvas: HTMLCanvasElement): Promise<void>
  destroy(): void
  
  // Data
  setSeriesData(seriesId: string, data: SeriesBuffers): void
  updateTick(seriesId: string, tick: TickData): void
  
  // State
  setViewport(viewport: Viewport): void
  setTheme(theme: ThemeTokens): void
  setInputState(state: InputState): void
  
  // Render
  renderFrame(timestamp: number): void {
    // 1. Read latest input state
    // 2. Update crosshair position
    // 3. Begin render pass
    // 4. Render grid
    // 5. Render candles
    // 6. Render crosshair
    // 7. End pass, submit
  }
  
  getStats(): RendererStats
}

## Input Processing
- Convert pointer position to chart coordinates
- Handle wheel for zoom (update viewport)
- Handle drag for pan (update viewport)

## Basic Interaction (no gestures yet)
- Mouse move → crosshair update
- Wheel → zoom around cursor
- Mouse drag → pan

## Demo App
Create apps/demo with:
- HTML page with canvas
- Load sample data (1000 candles)
- Initialize renderer
- Start frame loop
- Show FPS counter

## Tests
- Demo renders without errors
- Pan/zoom works
- FPS stays above 30
```

**DoD**: Demo app shows candles with working pan/zoom/crosshair

---

## Milestone 2: Tile Caching (Week 4-6)

### Phase 2.1: Tile Cache Manager
**Time**: 8-12 hours
**Feed to Cursor**: Phase spec + Doc 04 + Doc 17

**Phase Spec:**
```markdown
# Phase 2.1: Tile Cache Manager

Implement tile-based caching for smooth pan.

## Tile Key (src/tile-key.ts)
interface TileKey {
  paneId: string;
  tileX: number;        // Tile column index
  tileY: number;        // Tile row index
  lodLevel: number;     // Level of detail
  themeRev: number;     // Theme revision
  dataRev: number;      // Data revision
}

function tileKeyToString(key: TileKey): string
function tileKeyFromString(str: string): TileKey

## Tile Entry (src/tile-entry.ts)
interface TileEntry {
  key: TileKey;
  slot: AtlasSlot;           // Position in atlas
  stage: 0 | 1 | 2;          // Refinement stage
  lastUsedFrame: number;
  bounds: Rect;              // World bounds this tile covers
}

## Atlas Allocator (src/atlas.ts)
Fixed-grid allocator for tile textures.

class TileAtlas {
  private pages: AtlasPage[] = [];
  private freeSlots: AtlasSlot[] = [];
  
  constructor(
    device: GPUDevice,
    tileSize: number,      // 256 or 512
    pageSize: number,      // 2048 or 4096
    maxPages: number
  )
  
  allocate(): AtlasSlot | null
  free(slot: AtlasSlot): void
  getTexture(slot: AtlasSlot): GPUTexture
  getUVTransform(slot: AtlasSlot): { offset: vec2, scale: vec2 }
}

## Tile Cache (src/tile-cache.ts)
class TileCache {
  private tiles: Map<string, TileEntry> = new Map();
  private atlas: TileAtlas;
  private budgetMB: number;
  
  constructor(device: GPUDevice, config: TileCacheConfig)
  
  // Query
  getTile(key: TileKey): TileEntry | null
  getVisibleTiles(viewport: Viewport): TileEntry[]
  
  // Lifecycle
  insert(key: TileKey, stage: number): TileEntry
  touch(key: TileKey, frame: number): void
  invalidate(predicate: (key: TileKey) => boolean): void
  
  // Memory management
  evictLRU(count: number): void
  enforeBudget(): void
  
  getStats(): { tileCount: number, memoryMB: number, hitRate: number }
}

## Tests
- Allocate/free cycles don't leak
- LRU eviction removes oldest
- Budget enforcement works
```

**DoD**: Tile cache manages memory within budget

---

### Phase 2.2: Tile Rendering
**Time**: 8-12 hours

**Phase Spec:**
```markdown
# Phase 2.2: Render to Tiles

Render candles into tile textures instead of directly to screen.

## Tile Renderer (src/tile-renderer.ts)
class TileRenderer {
  private renderTarget: GPUTexture;     // Temporary render target
  private candleRenderer: CandleRenderer;
  private gridRenderer: GridRenderer;
  
  renderTile(
    tile: TileEntry,
    data: CandlestickData[],
    viewport: Viewport,
    theme: ThemeTokens
  ): void {
    // 1. Begin render pass to tile's atlas slot
    // 2. Set viewport/scissor to tile bounds
    // 3. Render grid for this region
    // 4. Render candles in this region
    // 5. End pass
  }
}

## Tile Compositor (src/tile-compositor.ts)
Draws cached tiles to screen.

class TileCompositor {
  private pipeline: GPURenderPipeline;
  
  render(
    pass: GPURenderPassEncoder,
    tiles: TileEntry[],
    atlas: TileAtlas,
    viewport: Viewport
  ): void {
    // Draw each tile as a textured quad
    // UV coordinates from atlas slot
    // Position from tile world bounds → screen
  }
}

## Reprojection Pan
When viewport pans:
1. Existing tiles shift position (just change UV/position)
2. Newly exposed tiles queued for render
3. Show shifted tiles immediately, refine in background

## Integration
Update WebGPURenderer to use tile system:
1. Determine visible tile keys
2. Check cache for each
3. Queue missing tiles for render
4. Composite cached tiles to screen
5. Render crosshair on top (not cached)

## Tests
- Pan shows content immediately (reprojection)
- Tile render produces correct content
- Memory stays bounded
```

**DoD**: Pan feels instant via reprojection

---

### Phase 2.3: Progressive Refinement
**Time**: 6-8 hours

**Phase Spec:**
```markdown
# Phase 2.3: Progressive Refinement (Stage 0/1/2)

Implement multi-stage tile refinement.

## Stages
- Stage 0: Envelope (min/max silhouette) - instant
- Stage 1: LOD candles - fast
- Stage 2: Full quality - complete

## Envelope Generator (data package)
function generateEnvelope(
  data: CandlestickData[],
  pixelWidth: number
): { min: Float32Array, max: Float32Array }

// Per-pixel-column min/max
// For zoomed-out views where bars < 1 pixel

## LOD Pyramid (data package)
interface LODLevel {
  level: number;           // 0 = raw, 1 = 5min, 2 = hourly, etc.
  data: CandlestickData[];
  timeResolution: number;  // ms per bar
}

class LODPyramid {
  private levels: LODLevel[] = [];
  
  build(rawData: CandlestickData[]): void
  getLevel(pixelsPerBar: number): LODLevel
}

## Scheduler Integration
class TileScheduler {
  private queue: PriorityQueue<TileJob>;
  
  enqueue(tile: TileKey, stage: number, priority: number): void
  
  processWithinBudget(budgetMs: number): void {
    while (this.queue.notEmpty() && budget > 0) {
      const job = this.queue.pop();
      const start = performance.now();
      this.renderTile(job);
      budget -= performance.now() - start;
    }
  }
}

## Priority Scoring
function scoreTile(tile: TileKey, pointer: Point, viewport: Rect): number
// Higher priority for:
// - Near pointer
// - Near viewport center
// - Lower stage (Stage 0 > Stage 1 > Stage 2)
// - Newly exposed

## Tests
- Stage 0 renders in < 1ms per tile
- Stage transitions visible in demo
- Priority queue orders correctly
```

**DoD**: Tiles refine progressively, Stage 0 instant

---

## Milestone 3: Text & Interaction (Week 6-8)

### Phase 3.1: MSDF Text System
**Time**: 8-12 hours
**Feed to Cursor**: Phase spec + Doc 05

### Phase 3.2: Axis Labels
**Time**: 6-8 hours

### Phase 3.3: Gesture Engine
**Time**: 8-12 hours
**Feed to Cursor**: Phase spec + Doc 21 (Mobile Strategy)

### Phase 3.4: Hit Testing
**Time**: 6-8 hours
**Feed to Cursor**: Phase spec + Doc 07

---

## Milestone 4: Indicators (Week 8-10)

### Phase 4.1: Indicator Engine Core
**Time**: 8-12 hours
**Feed to Cursor**: Phase spec + Doc 19

### Phase 4.2: CPU Indicator Implementations
**Time**: 8-12 hours
Implement 15 MVP indicators in JavaScript

### Phase 4.3: GPU Compute Indicators
**Time**: 8-12 hours
Implement EMA, Bollinger, RSI as compute shaders

### Phase 4.4: Indicator Rendering
**Time**: 6-8 hours

---

## Milestone 5: Drawings (Week 10-12)

### Phase 5.1: Drawing Object Model
**Time**: 6-8 hours
**Feed to Cursor**: Phase spec + Doc 20 sections 1-3

### Phase 5.2: Hit Testing & Selection
**Time**: 6-8 hours
**Feed to Cursor**: Phase spec + Doc 20 sections 4-5

### Phase 5.3: Drawing Tools (Lines)
**Time**: 6-8 hours

### Phase 5.4: Drawing Tools (Fibonacci & Shapes)
**Time**: 8-12 hours

### Phase 5.5: Undo/Redo & Persistence
**Time**: 6-8 hours
**Feed to Cursor**: Phase spec + Doc 20 sections 7-8

---

## Milestone 6: Integration & Polish (Week 12-14)

### Phase 6.1: Public API
**Time**: 8-12 hours
**Feed to Cursor**: Phase spec + Doc 22

### Phase 6.2: React Wrapper
**Time**: 6-8 hours
**Feed to Cursor**: Phase spec + Doc 22 section 9

### Phase 6.3: Fallback Renderers (Tier C/D)
**Time**: 8-12 hours
Only if needed for browser coverage

### Phase 6.4: Performance Optimization
**Time**: 8-12 hours
Profile, optimize hot paths, add render bundles

### Phase 6.5: Testing & Documentation
**Time**: 8-12 hours

---

## Cursor Session Best Practices

### Before Each Session
1. **State the phase**: "I'm implementing Phase 1.3: Candlestick Renderer"
2. **Provide context**: Paste the phase spec + any relevant existing code
3. **Show dependencies**: "These types already exist in @anthropic/delta-chart-core: ..."
4. **Be explicit about output**: "Create src/shaders/candle.wgsl and src/candles.ts"

### During Session
1. **One file at a time**: Don't ask for all files at once
2. **Test immediately**: Run tests after each file
3. **Fix before continuing**: Don't accumulate broken code
4. **Save context**: If session gets long, summarize what's done

### After Each Session
1. **Verify DoD**: Check definition of done criteria
2. **Run full test suite**: Ensure no regressions
3. **Commit**: Clean commits per phase
4. **Update imports**: Ensure new exports are added to index.ts

### Example Cursor Prompt
```
I'm implementing Phase 1.3: Candlestick Renderer for Delta Chart V3.

Context:
- @anthropic/delta-chart-webgpu package exists with GPUDeviceManager
- Types from @anthropic/delta-chart-core: CandlestickData, Viewport, Point

Phase Spec:
[paste phase spec]

Existing code to reference:
[paste GPUDeviceManager class]

Please create src/shaders/candle.wgsl with:
1. CandleInstance struct (x, open, high, low, close, flags)
2. Camera uniform struct
3. Vertex shader that expands instances to body + wick geometry
4. Fragment shader with simple color output

Use instanced rendering. Target 100k candles at 60fps.
```

---

## Time Estimates Summary

| Milestone | Phases | Estimated Time |
|-----------|--------|----------------|
| M0: Foundation | 4 phases | 16-24 hours |
| M1: Basic Rendering | 6 phases | 32-46 hours |
| M2: Tile Caching | 3 phases | 22-32 hours |
| M3: Text & Interaction | 4 phases | 28-40 hours |
| M4: Indicators | 4 phases | 30-44 hours |
| M5: Drawings | 5 phases | 32-44 hours |
| M6: Integration | 5 phases | 38-56 hours |
| **Total** | **31 phases** | **198-286 hours** |

At 6-8 productive hours/day: **25-48 days** (~5-10 weeks)

With realistic interruptions and debugging: **8-14 weeks**

---

## Critical Path

The minimum viable demo path:
1. Phase 0.1-0.2 (scaffolding + types)
2. Phase 1.1-1.6 (basic rendering)
3. Phase 3.3 (gestures for mobile)
4. Phase 6.1 (public API)

This gets you a **working chart in ~4-5 weeks** that can:
- Render candles
- Pan and zoom
- Show crosshair
- Work on mobile

Then add tiles, indicators, drawings incrementally.
