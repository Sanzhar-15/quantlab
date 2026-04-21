# Indicator Computation Architecture (V3 Add-On)
**Purpose:** Define how indicators are computed, cached, invalidated, and rendered—enabling 50+ simultaneous indicators at 60fps.

This document covers:
- computation tiers (CPU baseline → GPU compute acceleration)
- indicator registry and dependency model
- incremental recalculation on streaming data
- result buffer formats and flow to renderer
- parameter change invalidation

> Design goal: **Indicators never block interaction.** Compute is scheduled around crosshair/pan/zoom.

---

## 0) Core requirements

1. Support **50+ simultaneous indicators** without frame drops during interaction.
2. **Incremental updates**: new ticks should not trigger full recalculation.
3. **Parameter changes** (e.g., EMA period 20→50) should feel responsive (<500ms).
4. Results must flow efficiently to the renderer without excessive copying.
5. GPU compute is an optimization; CPU baseline must always work.

---

## 1) Indicator computation tiers

### 1.1 Tier model (mirrors renderer tiers)

| Compute Tier | Runtime | Use Case |
|---|---|---|
| **CPU-JS** | Data Worker (JavaScript) | Baseline; always available |
| **CPU-WASM** | Data Worker (WebAssembly) | 2-5x faster for heavy math |
| **GPU-Compute** | Render Worker (WebGPU compute shaders) | 10-50x faster for parallelizable indicators |

### 1.2 Selection logic
```
if (rendererTier === "A" || rendererTier === "B") && indicator.isGPUAccelerable:
    use GPU-Compute
else if (wasmAvailable && indicator.hasWasmImpl):
    use CPU-WASM
else:
    use CPU-JS
```

### 1.3 Fallback guarantee
Every indicator **must** have a CPU-JS implementation. GPU and WASM are optimizations.

---

## 2) Indicator registry

### 2.1 Indicator definition schema
```typescript
interface IndicatorDefinition {
  id: string;                          // "ema", "rsi", "macd", etc.
  name: string;                        // Display name
  category: IndicatorCategory;         // "trend", "momentum", "volume", "volatility"
  
  // Parameters
  params: ParameterDefinition[];       // Configurable parameters
  defaultParams: Record<string, any>;  // Default values
  
  // Computation metadata
  inputFields: ("close" | "open" | "high" | "low" | "volume")[];
  outputFields: OutputFieldDefinition[];
  lookbackBars: number | ((params: any) => number);  // How much history needed
  
  // Implementation availability
  hasGPUCompute: boolean;
  hasWASM: boolean;
  
  // Rendering hints
  overlay: boolean;                    // true = overlay on price, false = separate pane
  defaultStyle: IndicatorStyle;
}

interface ParameterDefinition {
  key: string;
  type: "int" | "float" | "enum" | "color";
  min?: number;
  max?: number;
  step?: number;
  options?: string[];  // for enum
  default: any;
}

interface OutputFieldDefinition {
  key: string;                         // "value", "upper", "lower", "histogram", etc.
  type: "line" | "histogram" | "fill" | "marker";
  defaultColor: string;
}
```

### 2.2 Core indicator set (MVP: 15 indicators)

| ID | Name | Category | GPU-Accelerable | Lookback |
|---|---|---|---|---|
| `sma` | Simple Moving Average | Trend | ✓ | period |
| `ema` | Exponential Moving Average | Trend | ✓ | period × 3 |
| `wma` | Weighted Moving Average | Trend | ✓ | period |
| `bollinger` | Bollinger Bands | Volatility | ✓ | period |
| `rsi` | Relative Strength Index | Momentum | ✓ | period + 1 |
| `macd` | MACD | Momentum | ✓ | slow + signal |
| `stochastic` | Stochastic Oscillator | Momentum | ✓ | %K + %D periods |
| `atr` | Average True Range | Volatility | ✓ | period |
| `adx` | Average Directional Index | Trend | ✓ | period × 2 |
| `cci` | Commodity Channel Index | Momentum | ✓ | period |
| `obv` | On-Balance Volume | Volume | ✓ | 1 |
| `vwap` | Volume Weighted Avg Price | Volume | ✓ | session |
| `ichimoku` | Ichimoku Cloud | Trend | ✓ | 52 (default) |
| `pivots` | Pivot Points | Support/Resistance | ✗ | 1 day |
| `volume` | Volume Bars | Volume | ✓ | 0 |

---

## 3) Computation pipeline

### 3.1 Data flow overview
```
┌─────────────────────────────────────────────────────────────────────────┐
│                        INDICATOR COMPUTATION FLOW                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────────────┐  │
│  │ Series Data  │─────►│ Indicator    │─────►│ Result Buffers       │  │
│  │ (OHLCV)      │      │ Engine       │      │ (per indicator)      │  │
│  └──────────────┘      └──────────────┘      └──────────────────────┘  │
│         │                     │                        │               │
│         │              ┌──────┴──────┐                 │               │
│         │              │             │                 │               │
│         ▼              ▼             ▼                 ▼               │
│  ┌─────────────┐ ┌──────────┐ ┌──────────┐    ┌──────────────────┐   │
│  │ Data Worker │ │ CPU-JS   │ │ CPU-WASM │    │ Render Worker    │   │
│  │ (storage)   │ │ compute  │ │ compute  │    │ (GPU compute)    │   │
│  └─────────────┘ └──────────┘ └──────────┘    └──────────────────┘   │
│                                                        │               │
│                                                        ▼               │
│                                               ┌──────────────────┐    │
│                                               │ Indicator Pass   │    │
│                                               │ (render to tile) │    │
│                                               └──────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Computation scheduling

**Priority rules:**
1. **Interaction** (crosshair/pan/zoom) — highest priority, never blocked
2. **Visible viewport indicators** — compute within frame budget
3. **Offscreen indicators** — compute in idle time

**Budget allocation:**
- Per-frame indicator compute budget: 4ms (of ~10ms total frame budget)
- If budget exceeded, defer remaining indicators to next frame
- Tooltip values computed from cached results (no compute on hover)

### 3.3 Job queue structure
```typescript
interface IndicatorJob {
  indicatorId: string;
  instanceId: string;           // Unique instance (same indicator can be added multiple times)
  seriesId: string;
  priority: number;
  
  // Computation scope
  computeRange: {
    startIdx: number;           // First bar to compute
    endIdx: number;             // Last bar to compute
  };
  
  // Invalidation reason
  reason: "initial" | "param_change" | "data_append" | "data_replace";
  
  // Tier selection
  computeTier: "CPU-JS" | "CPU-WASM" | "GPU-Compute";
}
```

---

## 4) Incremental computation model

### 4.1 The problem with naive recalculation
If EMA(200) requires 200 bars of lookback, and we receive 1 new tick, naive approach recalculates all 200+ bars. This is wasteful.

### 4.2 Incremental update patterns

**Pattern A: Stateless indicators (SMA, Bollinger)**
- Store intermediate state: running sum, sum of squares
- On new bar: subtract oldest bar contribution, add new bar contribution
- Complexity: O(1) per new bar

**Pattern B: Recursive indicators (EMA, RSI)**
- Store last computed value
- On new bar: apply recurrence relation
- Complexity: O(1) per new bar

**Pattern C: Multi-output indicators (MACD, Stochastic)**
- Chain incremental updates through dependency graph
- MACD: EMA(fast) → EMA(slow) → MACD line → Signal line → Histogram

### 4.3 Incremental state storage
```typescript
interface IndicatorState {
  instanceId: string;
  lastComputedIdx: number;      // Index of last computed bar
  
  // Indicator-specific intermediate state
  intermediateState: ArrayBuffer;  // Opaque, indicator-defined
  
  // Output buffers
  outputs: Map<string, Float32Array>;  // "value", "upper", "lower", etc.
}
```

### 4.4 Invalidation triggers

| Trigger | Scope | Action |
|---|---|---|
| New tick (same bar) | Last bar only | Update in-place |
| New bar appended | Last bar + new bar | Incremental extend |
| Historical data loaded | Full range | Full recompute |
| Parameter changed | Full range | Full recompute |
| Theme changed | None | Re-render only (no recompute) |

---

## 5) Result buffer format

### 5.1 Columnar output buffers
Each indicator output is a typed array aligned with the series data:
```typescript
interface IndicatorResultBuffers {
  instanceId: string;
  seriesId: string;
  
  // Aligned with series bars
  startIdx: number;
  length: number;
  
  // Output arrays (one per output field)
  outputs: {
    [fieldKey: string]: Float32Array;
  };
  
  // Validity mask (handles NaN for lookback period)
  validFrom: number;  // First valid index
  
  // Revision for cache invalidation
  revision: number;
}
```

### 5.2 Binary message format (for cross-thread transfer)
```
SET_INDICATOR_RESULT (msgType: 0x0305)

Payload header (32 bytes):
| Offset | Size | Type | Name |
|---:|---:|---|---|
| 0 | 8 | u64 | instanceId (hash) |
| 8 | 8 | u64 | seriesId |
| 16 | 4 | u32 | startIdx |
| 20 | 4 | u32 | length |
| 24 | 4 | u32 | validFrom |
| 28 | 4 | u32 | revision |

Then offsets table + output arrays (same pattern as series chunks)
```

### 5.3 GPU buffer layout (for GPU-computed indicators)
```wgsl
// Storage buffer for indicator output (written by compute shader)
struct IndicatorOutput {
    values: array<f32>,
}

@group(0) @binding(0) var<storage, read> prices: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: IndicatorOutput;
@group(0) @binding(2) var<uniform> params: IndicatorParams;
```

---

## 6) GPU compute implementation

### 6.1 Which indicators benefit from GPU?
GPU compute excels when:
- Large dataset (>10k bars)
- Parallelizable computation (independent per-bar after warmup)
- Multiple indicators computed simultaneously

**Good GPU candidates:** SMA, EMA, Bollinger, RSI, ATR
**Poor GPU candidates:** Ichimoku (complex logic), Pivots (daily aggregation)

### 6.2 EMA compute shader (reference)
```wgsl
// EMA Compute Shader
// Note: EMA has serial dependency; we use parallel prefix pattern

struct Params {
    period: u32,
    length: u32,
    alpha: f32,      // 2 / (period + 1)
    oneMinusAlpha: f32,
}

@group(0) @binding(0) var<storage, read> close: array<f32>;
@group(0) @binding(1) var<storage, read_write> ema: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

// Phase 1: Compute per-workgroup partial sums
@compute @workgroup_size(256)
fn ema_phase1(@builtin(global_invocation_id) gid: vec3<u32>,
              @builtin(local_invocation_id) lid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.length) { return; }
    
    // For EMA, we need serial dependency
    // Use workgroup shared memory for local prefix
    var<workgroup> shared: array<f32, 256>;
    
    shared[lid.x] = close[i];
    workgroupBarrier();
    
    // Local EMA within workgroup
    if (lid.x == 0u) {
        var acc = shared[0];
        ema[i] = acc;
        for (var j = 1u; j < 256u && (i + j) < params.length; j++) {
            acc = params.alpha * shared[j] + params.oneMinusAlpha * acc;
            ema[i + j] = acc;
        }
    }
}

// Phase 2: Stitch workgroups (run on CPU or separate pass)
// This handles the boundary between workgroups
```

### 6.3 Bollinger Bands compute shader (reference)
```wgsl
// Bollinger requires: SMA + rolling standard deviation

struct BollingerParams {
    period: u32,
    stdDevMult: f32,
    length: u32,
}

@group(0) @binding(0) var<storage, read> close: array<f32>;
@group(0) @binding(1) var<storage, read_write> middle: array<f32>;
@group(0) @binding(2) var<storage, read_write> upper: array<f32>;
@group(0) @binding(3) var<storage, read_write> lower: array<f32>;
@group(0) @binding(4) var<uniform> params: BollingerParams;

@compute @workgroup_size(256)
fn bollinger(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i < params.period - 1u || i >= params.length) { return; }
    
    // Compute SMA
    var sum = 0.0;
    for (var j = 0u; j < params.period; j++) {
        sum += close[i - j];
    }
    let sma = sum / f32(params.period);
    middle[i] = sma;
    
    // Compute standard deviation
    var sqSum = 0.0;
    for (var j = 0u; j < params.period; j++) {
        let diff = close[i - j] - sma;
        sqSum += diff * diff;
    }
    let stdDev = sqrt(sqSum / f32(params.period));
    
    upper[i] = sma + params.stdDevMult * stdDev;
    lower[i] = sma - params.stdDevMult * stdDev;
}
```

### 6.4 Compute dispatch strategy
```typescript
function dispatchIndicatorCompute(
  device: GPUDevice,
  indicator: IndicatorDefinition,
  dataLength: number
): GPUCommandBuffer {
  const workgroupSize = 256;
  const numWorkgroups = Math.ceil(dataLength / workgroupSize);
  
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  
  pass.setPipeline(indicatorPipelines.get(indicator.id)!);
  pass.setBindGroup(0, createIndicatorBindGroup(indicator));
  pass.dispatchWorkgroups(numWorkgroups);
  
  pass.end();
  return encoder.finish();
}
```

---

## 7) Indicator rendering

### 7.1 Indicator render pass
Indicators render after series, before overlays:
```
1. Background / clear
2. Grid
3. Series (candles/lines)
4. **Indicators** ← here
5. Overlays (drawings)
6. Text
7. Interaction overlay
```

### 7.2 Indicator geometry types

**Line indicators (EMA, SMA, Bollinger bands)**
- Render as anti-aliased line strips
- Use analytic distance-based AA
- Instance buffer: x positions + y values from result buffer

**Histogram indicators (MACD histogram, Volume)**
- Render as instanced quads
- Color based on positive/negative

**Fill indicators (Bollinger fill, Ichimoku cloud)**
- Render as triangle strips between upper/lower bounds
- Alpha blending for translucency

**Marker indicators (Pivot points, signals)**
- Render as instanced shapes at specific bars

### 7.3 Indicator instance buffer layout
```wgsl
struct IndicatorLineVertex {
    x: f32,           // screen X (from bar index + camera)
    y: f32,           // screen Y (from indicator value + price scale)
    color: u32,       // packed RGBA
    thickness: f32,
}
```

---

## 8) Dependency graph for complex indicators

### 8.1 Why dependencies matter
MACD depends on two EMAs and a signal line. Ichimoku has 5 components with interdependencies.

### 8.2 Dependency declaration
```typescript
const macdDefinition: IndicatorDefinition = {
  id: "macd",
  // ...
  dependencies: [
    { indicatorId: "ema", params: { period: "${fastPeriod}" }, outputKey: "fast" },
    { indicatorId: "ema", params: { period: "${slowPeriod}" }, outputKey: "slow" },
  ],
  compute: (inputs, params) => {
    const macdLine = subtract(inputs.fast, inputs.slow);
    const signalLine = ema(macdLine, params.signalPeriod);
    const histogram = subtract(macdLine, signalLine);
    return { macdLine, signalLine, histogram };
  }
};
```

### 8.3 Topological execution order
The indicator engine resolves dependencies and executes in topological order:
1. Compute all leaf dependencies first
2. Then compute dependent indicators
3. Cache intermediate results to avoid redundant computation

---

## 9) Tooltip value computation

### 9.1 No-compute-on-hover rule
Tooltip values must come from cached result buffers, never from on-demand computation.

### 9.2 Value lookup
```typescript
function getIndicatorValueAtBar(
  instanceId: string,
  barIndex: number,
  outputKey: string
): number | null {
  const result = indicatorCache.get(instanceId);
  if (!result) return null;
  
  const localIdx = barIndex - result.startIdx;
  if (localIdx < 0 || localIdx >= result.length) return null;
  if (barIndex < result.validFrom) return null;  // NaN period
  
  return result.outputs[outputKey][localIdx];
}
```

### 9.3 Tooltip formatting
Each indicator defines its own formatting:
```typescript
interface IndicatorDefinition {
  // ...
  formatValue: (value: number, params: any) => string;
  // e.g., RSI: "RSI(14): 65.32"
  // e.g., MACD: "MACD: 0.0234 / Signal: 0.0198 / Hist: 0.0036"
}
```

---

## 10) Memory management

### 10.1 Result buffer pooling
Pre-allocate result buffer pools to avoid allocation churn:
```typescript
class IndicatorBufferPool {
  private pools: Map<number, Float32Array[]> = new Map();
  
  acquire(length: number): Float32Array {
    const bucket = this.bucketFor(length);
    const pool = this.pools.get(bucket) || [];
    return pool.pop() || new Float32Array(bucket);
  }
  
  release(buffer: Float32Array): void {
    const bucket = this.bucketFor(buffer.length);
    const pool = this.pools.get(bucket) || [];
    if (pool.length < 10) pool.push(buffer);  // Cap pool size
    this.pools.set(bucket, pool);
  }
  
  private bucketFor(length: number): number {
    // Round up to power of 2
    return 1 << Math.ceil(Math.log2(Math.max(length, 1024)));
  }
}
```

### 10.2 GPU buffer reuse
For GPU-computed indicators:
- Maintain a pool of GPU storage buffers
- Reuse buffers across indicator recomputes
- Size buffers to max expected series length

### 10.3 Memory budget
Indicator result memory budget (included in overall budget):
- Desktop: 64 MB for indicator results
- Mobile: 32 MB for indicator results

---

## 11) Implementation checklist

- [ ] Indicator registry with 15 MVP indicators
- [ ] CPU-JS baseline implementations for all indicators
- [ ] Incremental computation state management
- [ ] Result buffer format and transfer protocol
- [ ] GPU compute shaders for parallelizable indicators
- [ ] Dependency graph resolution
- [ ] Tooltip value lookup (no-compute)
- [ ] Indicator render pass integration
- [ ] Buffer pooling and memory management
- [ ] Parameter change invalidation
- [ ] Streaming data incremental updates
