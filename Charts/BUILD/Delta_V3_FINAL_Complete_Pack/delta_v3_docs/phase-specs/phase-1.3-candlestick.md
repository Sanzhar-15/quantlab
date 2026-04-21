# Phase 1.3: Candlestick Renderer

## Objective
Implement GPU-accelerated instanced candlestick rendering capable of 100k+ candles at 60fps.

## Dependencies
- `@anthropic/delta-chart-core` (types: BarData, Viewport)
- `@anthropic/delta-chart-webgpu` (GPUDeviceManager, PipelineCache)

## File Structure
```
packages/webgpu/src/
├── shaders/
│   └── candle.wgsl        # Candlestick shader
├── renderers/
│   ├── index.ts
│   └── candles.ts         # CandleRenderer class
└── __tests__/
    └── candles.test.ts
```

---

## shaders/candle.wgsl

```wgsl
// ============================================================
// CANDLESTICK SHADER
// Instanced rendering: one instance per candle
// Vertex shader expands each instance to body + wick geometry
// ============================================================

// Camera/viewport uniform
struct Camera {
    viewProjection: mat4x4<f32>,
    canvasSize: vec2<f32>,
    timeRange: vec2<f32>,      // [timeStart, timeEnd] in seconds
    priceRange: vec2<f32>,     // [priceMin, priceMax]
    candleWidthPx: f32,        // Width of candle body in pixels
    wickWidthPx: f32,          // Width of wick in pixels
}

// Theme colors
struct Theme {
    upBodyColor: vec4<f32>,
    downBodyColor: vec4<f32>,
    upWickColor: vec4<f32>,
    downWickColor: vec4<f32>,
    upBorderColor: vec4<f32>,
    downBorderColor: vec4<f32>,
}

// Per-instance data (one per candle)
struct CandleInstance {
    time: f32,                 // Candle timestamp (seconds)
    open: f32,
    high: f32,
    low: f32,
    close: f32,
    flags: u32,                // Bit 0: 1=up, 0=down; Bit 1: highlighted
}

// Vertex output
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) localPos: vec2<f32>,    // For potential AA
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> theme: Theme;
@group(0) @binding(2) var<storage, read> instances: array<CandleInstance>;

// Vertex indices for candle geometry:
// 0-3: Body quad (2 triangles)
// 4-7: Upper wick quad
// 8-11: Lower wick quad
// Total: 12 vertices per instance, drawn as 4 triangles (12 indices)

@vertex
fn vs_main(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
    let candle = instances[instanceIndex];
    
    // Determine if up or down candle
    let isUp = (candle.flags & 1u) != 0u;
    let bodyTop = select(candle.open, candle.close, isUp);
    let bodyBottom = select(candle.close, candle.open, isUp);
    
    // Convert time to normalized X [-1, 1]
    let timeNorm = (candle.time - camera.timeRange.x) / (camera.timeRange.y - camera.timeRange.x);
    let centerX = timeNorm * 2.0 - 1.0;
    
    // Price to normalized Y [-1, 1] (inverted: higher price = higher on screen)
    let priceToY = fn(price: f32) -> f32 {
        let norm = (price - camera.priceRange.x) / (camera.priceRange.y - camera.priceRange.x);
        return norm * 2.0 - 1.0;
    };
    
    // Pixel sizes in normalized coordinates
    let pxToNormX = 2.0 / camera.canvasSize.x;
    let pxToNormY = 2.0 / camera.canvasSize.y;
    
    let halfBodyWidth = camera.candleWidthPx * 0.5 * pxToNormX;
    let halfWickWidth = camera.wickWidthPx * 0.5 * pxToNormX;
    
    var pos: vec2<f32>;
    var localPos: vec2<f32>;
    
    // Determine which part of the candle this vertex belongs to
    let localVertexIndex = vertexIndex % 12u;
    
    if (localVertexIndex < 6u) {
        // Body (6 vertices = 2 triangles)
        let bodyTopY = priceToY(bodyTop);
        let bodyBottomY = priceToY(bodyBottom);
        
        // Quad vertices: 0=TL, 1=TR, 2=BL, 3=BR
        // Triangle 1: 0,1,2  Triangle 2: 1,3,2
        let quadIndex = select(
            select(
                select(3u, 2u, localVertexIndex == 2u || localVertexIndex == 5u),
                1u, localVertexIndex == 1u || localVertexIndex == 3u
            ),
            0u, localVertexIndex == 0u
        );
        
        let isLeft = (quadIndex == 0u) || (quadIndex == 2u);
        let isTop = (quadIndex == 0u) || (quadIndex == 1u);
        
        pos.x = centerX + select(halfBodyWidth, -halfBodyWidth, isLeft);
        pos.y = select(bodyBottomY, bodyTopY, isTop);
        localPos = vec2<f32>(select(1.0, -1.0, isLeft), select(-1.0, 1.0, isTop));
        
    } else if (localVertexIndex < 9u) {
        // Upper wick (3 vertices = 1 triangle as degenerate quad)
        // Actually use a thin quad for the wick
        let wickTop = priceToY(candle.high);
        let wickBottom = priceToY(bodyTop);
        
        let quadIndex = localVertexIndex - 6u;
        let isLeft = (quadIndex == 0u) || (quadIndex == 2u);
        let isTop = (quadIndex == 0u) || (quadIndex == 1u);
        
        pos.x = centerX + select(halfWickWidth, -halfWickWidth, isLeft);
        pos.y = select(wickBottom, wickTop, isTop);
        localPos = vec2<f32>(0.0, 0.0);
        
    } else {
        // Lower wick
        let wickTop = priceToY(bodyBottom);
        let wickBottom = priceToY(candle.low);
        
        let quadIndex = localVertexIndex - 9u;
        let isLeft = (quadIndex == 0u) || (quadIndex == 2u);
        let isTop = (quadIndex == 0u) || (quadIndex == 1u);
        
        pos.x = centerX + select(halfWickWidth, -halfWickWidth, isLeft);
        pos.y = select(wickBottom, wickTop, isTop);
        localPos = vec2<f32>(0.0, 0.0);
    }
    
    // Select color based on up/down and part (body vs wick)
    var color: vec4<f32>;
    if (localVertexIndex < 6u) {
        // Body color
        color = select(theme.downBodyColor, theme.upBodyColor, isUp);
    } else {
        // Wick color
        color = select(theme.downWickColor, theme.upWickColor, isUp);
    }
    
    var output: VertexOutput;
    output.position = vec4<f32>(pos, 0.0, 1.0);
    output.color = color;
    output.localPos = localPos;
    
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}
```

---

## renderers/candles.ts

```typescript
import type { GPUDeviceManager } from '../device/manager';
import type { PipelineCache } from '../pipelines/cache';
import type { BarData, Viewport } from '@anthropic/delta-chart-core';

// Import shader as string (configure bundler for .wgsl imports)
import candleShaderSource from '../shaders/candle.wgsl?raw';

export interface CandleTheme {
  upBodyColor: [number, number, number, number];
  downBodyColor: [number, number, number, number];
  upWickColor: [number, number, number, number];
  downWickColor: [number, number, number, number];
  upBorderColor: [number, number, number, number];
  downBorderColor: [number, number, number, number];
}

const DEFAULT_THEME: CandleTheme = {
  upBodyColor: [0.18, 0.8, 0.44, 1.0],      // Green
  downBodyColor: [0.91, 0.3, 0.24, 1.0],    // Red
  upWickColor: [0.18, 0.8, 0.44, 1.0],
  downWickColor: [0.91, 0.3, 0.24, 1.0],
  upBorderColor: [0.18, 0.8, 0.44, 1.0],
  downBorderColor: [0.91, 0.3, 0.24, 1.0],
};

// Camera uniform layout (must match shader)
const CAMERA_UNIFORM_SIZE = 64; // 16 floats * 4 bytes

// Theme uniform layout
const THEME_UNIFORM_SIZE = 96; // 6 vec4 * 4 floats * 4 bytes

// Instance data layout
const INSTANCE_SIZE = 24; // 5 floats + 1 u32 = 24 bytes

export class CandleRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  
  private instanceBuffer: GPUBuffer | null = null;
  private instanceCount = 0;
  
  private cameraUniformBuffer: GPUBuffer;
  private themeUniformBuffer: GPUBuffer;
  
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout;
  
  private pipelineCache: PipelineCache;
  private format: GPUTextureFormat;
  
  constructor(deviceManager: GPUDeviceManager, pipelineCache: PipelineCache) {
    this.device = deviceManager.device;
    this.format = deviceManager.format;
    this.pipelineCache = pipelineCache;
    
    // Create uniform buffers
    this.cameraUniformBuffer = this.device.createBuffer({
      label: 'Candle Camera Uniform',
      size: CAMERA_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    this.themeUniformBuffer = this.device.createBuffer({
      label: 'Candle Theme Uniform',
      size: THEME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Candle Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
    
    // Set default theme
    this.setTheme(DEFAULT_THEME);
  }
  
  async init(): Promise<void> {
    // Create shader module
    const shaderModule = this.device.createShaderModule({
      label: 'Candle Shader',
      code: candleShaderSource,
    });
    
    // Create pipeline
    this.pipeline = await this.pipelineCache.getOrCreateRender('candle', () => ({
      label: 'Candle Pipeline',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    }));
  }
  
  setData(candles: BarData[]): void {
    if (candles.length === 0) {
      this.instanceCount = 0;
      return;
    }
    
    // Create instance buffer
    const bufferSize = candles.length * INSTANCE_SIZE;
    
    // Recreate buffer if needed
    if (!this.instanceBuffer || this.instanceBuffer.size < bufferSize) {
      this.instanceBuffer?.destroy();
      this.instanceBuffer = this.device.createBuffer({
        label: 'Candle Instance Buffer',
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    
    // Pack instance data
    const data = new ArrayBuffer(bufferSize);
    const floatView = new Float32Array(data);
    const uintView = new Uint32Array(data);
    
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const offset = i * 6; // 6 values per instance (5 floats + 1 uint)
      
      // Convert time to seconds
      const time = typeof candle.time === 'number' 
        ? candle.time 
        : new Date(candle.time as string).getTime() / 1000;
      
      floatView[offset + 0] = time;
      floatView[offset + 1] = candle.open;
      floatView[offset + 2] = candle.high;
      floatView[offset + 3] = candle.low;
      floatView[offset + 4] = candle.close;
      
      // Flags: bit 0 = up candle
      const isUp = candle.close >= candle.open;
      uintView[offset + 5] = isUp ? 1 : 0;
    }
    
    // Upload to GPU
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    this.instanceCount = candles.length;
    
    // Recreate bind group with new buffer
    this.updateBindGroup();
  }
  
  setTheme(theme: CandleTheme): void {
    const data = new Float32Array([
      ...theme.upBodyColor,
      ...theme.downBodyColor,
      ...theme.upWickColor,
      ...theme.downWickColor,
      ...theme.upBorderColor,
      ...theme.downBorderColor,
    ]);
    
    this.device.queue.writeBuffer(this.themeUniformBuffer, 0, data);
  }
  
  updateCamera(viewport: Viewport): void {
    // Calculate candle width based on visible bars
    const visibleTimeSpan = viewport.timeEnd - viewport.timeStart;
    const pixelsPerSecond = viewport.width / visibleTimeSpan;
    
    // Assume 1-minute candles (60 seconds) for width calculation
    // Adjust based on actual data timeframe
    const candleWidthPx = Math.max(1, Math.min(20, pixelsPerSecond * 60 * 0.8));
    const wickWidthPx = Math.max(1, candleWidthPx * 0.15);
    
    // Pack uniform data
    // mat4x4 (identity for now, direct NDC) + canvasSize + timeRange + priceRange + widths
    const data = new Float32Array([
      // viewProjection (identity 4x4)
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
      // canvasSize
      viewport.width * viewport.dpr,
      viewport.height * viewport.dpr,
      // timeRange
      viewport.timeStart,
      viewport.timeEnd,
      // priceRange
      viewport.priceMin,
      viewport.priceMax,
      // candleWidthPx, wickWidthPx
      candleWidthPx,
      wickWidthPx,
    ]);
    
    this.device.queue.writeBuffer(this.cameraUniformBuffer, 0, data);
  }
  
  private updateBindGroup(): void {
    if (!this.instanceBuffer) return;
    
    this.bindGroup = this.device.createBindGroup({
      label: 'Candle Bind Group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
        { binding: 1, resource: { buffer: this.themeUniformBuffer } },
        { binding: 2, resource: { buffer: this.instanceBuffer } },
      ],
    });
  }
  
  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || this.instanceCount === 0) {
      return;
    }
    
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    
    // 12 vertices per candle (body quad + upper wick quad + lower wick quad)
    // Each quad = 2 triangles = 6 vertices
    // Body: 6 vertices, upper wick: 3 vertices (degenerate), lower wick: 3 vertices
    // Simplified: use 6 vertices for body only initially
    const verticesPerInstance = 6; // Start with body only
    pass.draw(verticesPerInstance, this.instanceCount, 0, 0);
  }
  
  destroy(): void {
    this.instanceBuffer?.destroy();
    this.cameraUniformBuffer.destroy();
    this.themeUniformBuffer.destroy();
  }
}
```

---

## Tests

### __tests__/candles.test.ts
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GPUDeviceManager } from '../device/manager';
import { PipelineCache } from '../pipelines/cache';
import { CandleRenderer } from '../renderers/candles';
import type { BarData } from '@anthropic/delta-chart-core';

// Generate test data
function generateCandles(count: number, startTime: number = 1700000000): BarData[] {
  const candles: BarData[] = [];
  let price = 100;
  
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 5;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * 2;
    const low = Math.min(open, close) - Math.random() * 2;
    
    candles.push({
      time: startTime + i * 60, // 1-minute candles
      open,
      high,
      low,
      close,
      volume: Math.random() * 1000000,
    });
    
    price = close;
  }
  
  return candles;
}

describe('CandleRenderer', () => {
  let manager: GPUDeviceManager;
  let pipelineCache: PipelineCache;
  let renderer: CandleRenderer;
  let canvas: HTMLCanvasElement;
  
  beforeAll(async () => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    
    manager = new GPUDeviceManager();
    await manager.init(canvas);
    
    pipelineCache = new PipelineCache(manager.device);
    renderer = new CandleRenderer(manager, pipelineCache);
    await renderer.init();
  });
  
  afterAll(() => {
    renderer.destroy();
    manager.destroy();
    canvas.remove();
  });
  
  it('handles empty data', () => {
    renderer.setData([]);
    // Should not throw
  });
  
  it('handles small dataset', () => {
    const candles = generateCandles(100);
    renderer.setData(candles);
    // Should not throw
  });
  
  it('handles large dataset (100k candles)', () => {
    const start = performance.now();
    const candles = generateCandles(100000);
    const genTime = performance.now() - start;
    
    const uploadStart = performance.now();
    renderer.setData(candles);
    const uploadTime = performance.now() - uploadStart;
    
    console.log(`Generated 100k candles in ${genTime.toFixed(2)}ms`);
    console.log(`Uploaded 100k candles in ${uploadTime.toFixed(2)}ms`);
    
    // Upload should be fast (< 100ms)
    expect(uploadTime).toBeLessThan(100);
  });
  
  it('renders frame', () => {
    const candles = generateCandles(1000);
    renderer.setData(candles);
    
    renderer.updateCamera({
      timeStart: candles[0].time as number,
      timeEnd: candles[candles.length - 1].time as number,
      priceMin: 80,
      priceMax: 120,
      width: 800,
      height: 600,
      dpr: 1,
    });
    
    // Create render pass
    const encoder = manager.createCommandEncoder('Test');
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: manager.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
      }],
    });
    
    renderer.render(pass);
    pass.end();
    
    manager.device.queue.submit([encoder.finish()]);
    
    // Should not throw
  });
  
  it('renders 100k candles under 5ms', async () => {
    const candles = generateCandles(100000);
    renderer.setData(candles);
    
    renderer.updateCamera({
      timeStart: candles[0].time as number,
      timeEnd: candles[candles.length - 1].time as number,
      priceMin: 50,
      priceMax: 150,
      width: 800,
      height: 600,
      dpr: 1,
    });
    
    // Warm up
    for (let i = 0; i < 5; i++) {
      const encoder = manager.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: manager.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
        }],
      });
      renderer.render(pass);
      pass.end();
      manager.device.queue.submit([encoder.finish()]);
    }
    
    // Wait for GPU to finish warm-up
    await manager.device.queue.onSubmittedWorkDone();
    
    // Measure
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      
      const encoder = manager.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: manager.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
        }],
      });
      renderer.render(pass);
      pass.end();
      manager.device.queue.submit([encoder.finish()]);
      
      await manager.device.queue.onSubmittedWorkDone();
      times.push(performance.now() - start);
    }
    
    const avgTime = times.reduce((a, b) => a + b) / times.length;
    console.log(`Average render time for 100k candles: ${avgTime.toFixed(2)}ms`);
    
    expect(avgTime).toBeLessThan(5);
  });
});
```

---

## Definition of Done
- [ ] Shader compiles without errors
- [ ] CandleRenderer initializes successfully
- [ ] setData() uploads candle data to GPU
- [ ] updateCamera() updates viewport uniforms
- [ ] render() draws candles to render pass
- [ ] 100k candles upload < 100ms
- [ ] 100k candles render < 5ms
- [ ] Up candles are green, down candles are red
- [ ] Candle width scales with zoom level
