# Phase 1.2: WebGPU Device Initialization

## Objective
Create WebGPU device management with proper initialization, error handling, and device loss recovery.

## Dependencies
- `@anthropic/delta-chart-core` (types)

## File Structure
```
packages/webgpu/src/
├── index.ts
├── device/
│   ├── index.ts
│   ├── manager.ts          # GPUDeviceManager class
│   ├── detection.ts        # Feature detection
│   └── tier.ts             # Tier selection
├── pipelines/
│   ├── index.ts
│   └── cache.ts            # Pipeline cache
└── __tests__/
    └── device.test.ts
```

---

## device/detection.ts

```typescript
export interface WebGPUCapabilities {
  available: boolean;
  reason?: string;
  
  // Adapter info
  adapterInfo?: GPUAdapterInfo;
  
  // Features
  features: Set<string>;
  
  // Limits
  maxTextureSize: number;
  maxBufferSize: number;
  maxBindGroups: number;
}

export async function detectWebGPU(): Promise<WebGPUCapabilities> {
  // Check navigator.gpu exists
  if (!navigator.gpu) {
    return {
      available: false,
      reason: 'WebGPU not supported in this browser',
      features: new Set(),
      maxTextureSize: 0,
      maxBufferSize: 0,
      maxBindGroups: 0,
    };
  }
  
  try {
    // Request adapter
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    
    if (!adapter) {
      return {
        available: false,
        reason: 'No WebGPU adapter available',
        features: new Set(),
        maxTextureSize: 0,
        maxBufferSize: 0,
        maxBindGroups: 0,
      };
    }
    
    return {
      available: true,
      adapterInfo: await adapter.requestAdapterInfo(),
      features: adapter.features,
      maxTextureSize: adapter.limits.maxTextureDimension2D,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxBindGroups: adapter.limits.maxBindGroups,
    };
  } catch (error) {
    return {
      available: false,
      reason: `WebGPU detection failed: ${error}`,
      features: new Set(),
      maxTextureSize: 0,
      maxBufferSize: 0,
      maxBindGroups: 0,
    };
  }
}

export function checkOffscreenCanvasSupport(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    // Try to get WebGPU context on OffscreenCanvas
    // This may fail in some browsers even if WebGPU works on regular canvas
    return 'getContext' in canvas;
  } catch {
    return false;
  }
}
```

---

## device/tier.ts

```typescript
export type RendererTier = 'A' | 'B' | 'C' | 'D';

export interface TierSelectionResult {
  tier: RendererTier;
  reason: string;
  capabilities: WebGPUCapabilities;
}

export async function selectTier(): Promise<TierSelectionResult> {
  const capabilities = await detectWebGPU();
  
  // No WebGPU at all
  if (!capabilities.available) {
    // Check WebGL2
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    
    if (gl) {
      return {
        tier: 'C',
        reason: `WebGL2 fallback: ${capabilities.reason}`,
        capabilities,
      };
    }
    
    return {
      tier: 'D',
      reason: `Canvas2D fallback: ${capabilities.reason}`,
      capabilities,
    };
  }
  
  // WebGPU available - check for worker support
  const workerSupport = checkOffscreenCanvasSupport() && 
                        typeof Worker !== 'undefined';
  const crossOriginIsolated = self.crossOriginIsolated === true;
  
  // Tier A: WebGPU in worker
  if (workerSupport && crossOriginIsolated) {
    return {
      tier: 'A',
      reason: 'Full WebGPU with worker rendering',
      capabilities,
    };
  }
  
  // Tier B: WebGPU on main thread
  return {
    tier: 'B',
    reason: workerSupport 
      ? 'WebGPU main-thread (no cross-origin isolation for SAB)'
      : 'WebGPU main-thread (OffscreenCanvas not available)',
    capabilities,
  };
}
```

---

## device/manager.ts

```typescript
export interface DeviceManagerEvents {
  deviceLost: (info: GPUDeviceLostInfo) => void;
  error: (error: GPUError) => void;
  tierChange: (newTier: RendererTier, reason: string) => void;
}

export interface DeviceManagerConfig {
  powerPreference?: GPUPowerPreference;
  requiredFeatures?: GPUFeatureName[];
  onDeviceLost?: (info: GPUDeviceLostInfo) => void;
  onError?: (error: GPUError) => void;
}

export class GPUDeviceManager {
  private _device: GPUDevice | null = null;
  private _adapter: GPUAdapter | null = null;
  private _context: GPUCanvasContext | null = null;
  private _format: GPUTextureFormat = 'bgra8unorm';
  private _canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  
  private config: DeviceManagerConfig;
  private deviceLostCount = 0;
  private readonly MAX_DEVICE_LOST_RETRIES = 3;
  
  constructor(config: DeviceManagerConfig = {}) {
    this.config = config;
  }
  
  get device(): GPUDevice {
    if (!this._device) {
      throw new Error('GPUDevice not initialized. Call init() first.');
    }
    return this._device;
  }
  
  get context(): GPUCanvasContext {
    if (!this._context) {
      throw new Error('GPUCanvasContext not initialized. Call init() first.');
    }
    return this._context;
  }
  
  get format(): GPUTextureFormat {
    return this._format;
  }
  
  get isInitialized(): boolean {
    return this._device !== null && this._context !== null;
  }
  
  async init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    this._canvas = canvas;
    
    // Request adapter
    this._adapter = await navigator.gpu.requestAdapter({
      powerPreference: this.config.powerPreference ?? 'high-performance',
    });
    
    if (!this._adapter) {
      throw new Error('Failed to get WebGPU adapter');
    }
    
    // Request device
    this._device = await this._adapter.requestDevice({
      requiredFeatures: this.config.requiredFeatures,
    });
    
    // Set up device lost handler
    this._device.lost.then((info) => this.handleDeviceLost(info));
    
    // Set up error handler
    this._device.addEventListener('uncapturederror', (event) => {
      this.config.onError?.(event.error);
      console.error('Uncaptured GPU error:', event.error);
    });
    
    // Configure canvas context
    this._context = canvas.getContext('webgpu') as GPUCanvasContext;
    if (!this._context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }
    
    this._format = navigator.gpu.getPreferredCanvasFormat();
    
    this._context.configure({
      device: this._device,
      format: this._format,
      alphaMode: 'premultiplied',
    });
  }
  
  private async handleDeviceLost(info: GPUDeviceLostInfo): Promise<void> {
    console.warn('WebGPU device lost:', info.reason, info.message);
    this.config.onDeviceLost?.(info);
    
    // Attempt recovery if not destroyed intentionally
    if (info.reason !== 'destroyed') {
      this.deviceLostCount++;
      
      if (this.deviceLostCount <= this.MAX_DEVICE_LOST_RETRIES) {
        console.log(`Attempting device recovery (${this.deviceLostCount}/${this.MAX_DEVICE_LOST_RETRIES})`);
        
        try {
          await this.reinitialize();
          console.log('Device recovery successful');
        } catch (error) {
          console.error('Device recovery failed:', error);
        }
      } else {
        console.error('Max device lost retries exceeded');
        // Signal tier downgrade needed
      }
    }
  }
  
  private async reinitialize(): Promise<void> {
    if (!this._canvas) {
      throw new Error('Cannot reinitialize: no canvas reference');
    }
    
    // Clean up old resources
    this._device?.destroy();
    this._device = null;
    this._context = null;
    
    // Wait a bit before retrying
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Re-initialize
    await this.init(this._canvas);
  }
  
  destroy(): void {
    this._context?.unconfigure();
    this._device?.destroy();
    this._device = null;
    this._context = null;
    this._adapter = null;
    this._canvas = null;
  }
  
  /** Create a command encoder with error handling */
  createCommandEncoder(label?: string): GPUCommandEncoder {
    return this.device.createCommandEncoder({
      label: label ?? 'Command Encoder',
    });
  }
  
  /** Get current texture to render to */
  getCurrentTexture(): GPUTexture {
    return this.context.getCurrentTexture();
  }
}
```

---

## pipelines/cache.ts

```typescript
export interface PipelineCacheEntry {
  pipeline: GPURenderPipeline | GPUComputePipeline;
  createdAt: number;
  useCount: number;
}

export class PipelineCache {
  private cache = new Map<string, PipelineCacheEntry>();
  private device: GPUDevice;
  
  constructor(device: GPUDevice) {
    this.device = device;
  }
  
  /** Get or create a render pipeline */
  async getOrCreateRender(
    key: string,
    descriptorFn: () => GPURenderPipelineDescriptor
  ): Promise<GPURenderPipeline> {
    const existing = this.cache.get(key);
    if (existing) {
      existing.useCount++;
      return existing.pipeline as GPURenderPipeline;
    }
    
    const descriptor = descriptorFn();
    const pipeline = await this.device.createRenderPipelineAsync(descriptor);
    
    this.cache.set(key, {
      pipeline,
      createdAt: Date.now(),
      useCount: 1,
    });
    
    return pipeline;
  }
  
  /** Get or create a compute pipeline */
  async getOrCreateCompute(
    key: string,
    descriptorFn: () => GPUComputePipelineDescriptor
  ): Promise<GPUComputePipeline> {
    const existing = this.cache.get(key);
    if (existing) {
      existing.useCount++;
      return existing.pipeline as GPUComputePipeline;
    }
    
    const descriptor = descriptorFn();
    const pipeline = await this.device.createComputePipelineAsync(descriptor);
    
    this.cache.set(key, {
      pipeline,
      createdAt: Date.now(),
      useCount: 1,
    });
    
    return pipeline;
  }
  
  /** Pre-compile essential pipelines */
  async warmup(essentialPipelines: Array<{
    key: string;
    type: 'render' | 'compute';
    descriptor: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor;
  }>): Promise<void> {
    const promises = essentialPipelines.map(async ({ key, type, descriptor }) => {
      if (type === 'render') {
        await this.getOrCreateRender(key, () => descriptor as GPURenderPipelineDescriptor);
      } else {
        await this.getOrCreateCompute(key, () => descriptor as GPUComputePipelineDescriptor);
      }
    });
    
    await Promise.all(promises);
  }
  
  /** Clear the cache */
  clear(): void {
    this.cache.clear();
  }
  
  /** Get cache statistics */
  getStats(): { entries: number; totalUseCount: number } {
    let totalUseCount = 0;
    for (const entry of this.cache.values()) {
      totalUseCount += entry.useCount;
    }
    return { entries: this.cache.size, totalUseCount };
  }
}
```

---

## Tests

### __tests__/device.test.ts
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { detectWebGPU, checkOffscreenCanvasSupport } from '../device/detection';
import { selectTier } from '../device/tier';
import { GPUDeviceManager } from '../device/manager';

// Note: These tests need to run in a browser environment
// Use vitest browser mode or playwright

describe('WebGPU Detection', () => {
  it('returns capabilities object', async () => {
    const caps = await detectWebGPU();
    expect(caps).toHaveProperty('available');
    expect(caps).toHaveProperty('features');
    expect(caps).toHaveProperty('maxTextureSize');
  });
});

describe('Tier Selection', () => {
  it('selects valid tier', async () => {
    const result = await selectTier();
    expect(['A', 'B', 'C', 'D']).toContain(result.tier);
    expect(result.reason).toBeTruthy();
  });
});

describe('GPUDeviceManager', () => {
  let manager: GPUDeviceManager;
  let canvas: HTMLCanvasElement;
  
  beforeAll(async () => {
    // Skip if WebGPU not available
    const caps = await detectWebGPU();
    if (!caps.available) {
      console.log('Skipping WebGPU tests: not available');
      return;
    }
    
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    
    manager = new GPUDeviceManager();
    await manager.init(canvas);
  });
  
  afterAll(() => {
    manager?.destroy();
    canvas?.remove();
  });
  
  it('initializes successfully', () => {
    expect(manager.isInitialized).toBe(true);
  });
  
  it('provides device', () => {
    expect(manager.device).toBeDefined();
  });
  
  it('provides context', () => {
    expect(manager.context).toBeDefined();
  });
  
  it('provides format', () => {
    expect(manager.format).toBeTruthy();
  });
  
  it('can create command encoder', () => {
    const encoder = manager.createCommandEncoder('Test');
    expect(encoder).toBeDefined();
  });
});
```

---

## Definition of Done
- [ ] `detectWebGPU()` returns valid capabilities
- [ ] `selectTier()` correctly identifies available tier
- [ ] `GPUDeviceManager` initializes on WebGPU-capable browser
- [ ] Device loss handler logs and attempts recovery
- [ ] `PipelineCache` deduplicates pipelines
- [ ] All tests pass in browser environment
- [ ] Graceful failure message on non-WebGPU browsers
