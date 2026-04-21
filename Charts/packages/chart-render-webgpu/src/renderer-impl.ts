/**
 * WebGPU rendering implementation.
 * Handles actual rendering of series, grid, and crosshair.
 */

import type { LayoutResult, Rect, ThemeTokens, VisibleTimeRange } from '@charts-plus/chart-core';
import type { SeriesRenderData } from '@charts-plus/chart-core';
import { DeviceManager } from './device-manager';
import { PipelineCache } from './pipeline-cache';

export interface RenderContext {
  device: GPUDevice;
  deviceManager: DeviceManager;
  pipelineCache: PipelineCache;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  theme: ThemeTokens;
  layout: LayoutResult;
  visibleTimeRange: VisibleTimeRange;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Create render pipelines for WebGPU rendering.
 */
export function createRenderPipelines(device: GPUDevice): {
  gridPipeline: GPURenderPipeline;
  candlestickPipeline: GPURenderPipeline;
  crosshairPipeline: GPURenderPipeline;
} {
  // Grid shader (full-screen quad)
  const gridShader = device.createShaderModule({
    code: `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      }

      struct GridUniforms {
        viewportSize: vec2<f32>,
        plotRect: vec4<f32>,
        gridColor: vec4<f32>,
        gridSpacing: vec2<f32>,
        gridOffset: vec2<f32>,
      }

      @group(0) @binding(0) var<uniform> uniforms: GridUniforms;

      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        let x = f32((vertexIndex << 1u) & 2u) * 2.0 - 1.0;
        let y = f32(vertexIndex & 2u) * 2.0 - 1.0;
        return VertexOutput(
          vec4<f32>(x, y, 0.0, 1.0),
          vec2<f32>(x * 0.5 + 0.5, y * 0.5 + 0.5)
        );
      }

      @fragment
      fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        let screenPos = input.uv * uniforms.viewportSize;
        if (screenPos.x < uniforms.plotRect.x || screenPos.x > uniforms.plotRect.x + uniforms.plotRect.z ||
            screenPos.y < uniforms.plotRect.y || screenPos.y > uniforms.plotRect.y + uniforms.plotRect.w) {
          discard;
        }
        let plotPos = screenPos - uniforms.plotRect.xy;
        let gridPos = plotPos - uniforms.gridOffset;
        let distX = abs(fract(gridPos.x / uniforms.gridSpacing.x) - 0.5) * uniforms.gridSpacing.x;
        let distY = abs(fract(gridPos.y / uniforms.gridSpacing.y) - 0.5) * uniforms.gridSpacing.y;
        let dist = min(distX, distY);
        let alpha = 1.0 - smoothstep(0.0, 1.0, dist);
        return vec4<f32>(uniforms.gridColor.rgb, uniforms.gridColor.a * alpha);
      }
    `,
  });

  // Candlestick shader (instanced rendering)
  const candlestickShader = device.createShaderModule({
    code: `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      }

      struct CandlestickData {
        time: f32,
        open: f32,
        high: f32,
        low: f32,
        close: f32,
        bodyWidth: f32,
        upColor: vec4<f32>,
        downColor: vec4<f32>,
      }

      struct CameraUniforms {
        viewportSize: vec2<f32>,
        plotRect: vec4<f32>,
        timeRange: vec2<f32>,
        priceRange: vec2<f32>,
      }

      @group(0) @binding(0) var<uniform> camera: CameraUniforms;
      @group(0) @binding(1) var<storage, read> candlesticks: array<CandlestickData>;

      const QUAD_VERTICES: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
        vec2<f32>(-0.5, -0.5),
        vec2<f32>(0.5, -0.5),
        vec2<f32>(-0.5, 0.5),
        vec2<f32>(0.5, 0.5),
      );

      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
        let candle = candlesticks[instanceIndex];
        let isUp = candle.close >= candle.open;
        let color = select(candle.downColor, candle.upColor, isUp);
        let quadPos = QUAD_VERTICES[vertexIndex];
        
        let bodyTop = min(candle.open, candle.close);
        let bodyBottom = max(candle.open, candle.close);
        let bodyHeight = max(bodyBottom - bodyTop, 0.001);
        
        let timeX = candle.time * (camera.timeRange.y - camera.timeRange.x) + camera.timeRange.x;
        let screenX = camera.plotRect.x + timeX * camera.plotRect.z;
        let screenY = camera.plotRect.y + (1.0 - bodyTop) * camera.plotRect.w;
        
        let worldPos = vec2<f32>(
          screenX + quadPos.x * candle.bodyWidth,
          screenY + quadPos.y * bodyHeight * camera.plotRect.w
        );
        
        let clipX = (worldPos.x / camera.viewportSize.x) * 2.0 - 1.0;
        let clipY = 1.0 - (worldPos.y / camera.viewportSize.y) * 2.0;
        
        return VertexOutput(
          vec4<f32>(clipX, clipY, 0.0, 1.0),
          color
        );
      }

      @fragment
      fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        return input.color;
      }
    `,
  });

  // Crosshair shader
  const crosshairShader = device.createShaderModule({
    code: `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      }

      struct CrosshairUniforms {
        viewportSize: vec2<f32>,
        plotRect: vec4<f32>,
        crosshairPos: vec2<f32>,
        color: vec4<f32>,
        lineWidth: f32,
      }

      @group(0) @binding(0) var<uniform> uniforms: CrosshairUniforms;

      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        let x = f32((vertexIndex << 1u) & 2u) * 2.0 - 1.0;
        let y = f32(vertexIndex & 2u) * 2.0 - 1.0;
        let screenPos = vec2<f32>(x * 0.5 + 0.5, y * 0.5 + 0.5) * uniforms.viewportSize;
        let distX = abs(screenPos.x - uniforms.crosshairPos.x);
        let distY = abs(screenPos.y - uniforms.crosshairPos.y);
        let inPlot = screenPos.x >= uniforms.plotRect.x && screenPos.x <= uniforms.plotRect.x + uniforms.plotRect.z &&
                     screenPos.y >= uniforms.plotRect.y && screenPos.y <= uniforms.plotRect.y + uniforms.plotRect.w;
        let nearLine = (distX < uniforms.lineWidth * 2.0 && screenPos.y >= uniforms.plotRect.y && screenPos.y <= uniforms.plotRect.y + uniforms.plotRect.w) ||
                       (distY < uniforms.lineWidth * 2.0 && screenPos.x >= uniforms.plotRect.x && screenPos.x <= uniforms.plotRect.x + uniforms.plotRect.z);
        return VertexOutput(
          vec4<f32>(x, y, 0.0, 1.0),
          vec4<f32>(f32(select(0.0, 1.0, inPlot && nearLine)), distX, distY, 0.0)
        );
      }

      @fragment
      fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        if (input.color.x < 0.5) {
          discard;
        }
        let dist = min(input.color.y, input.color.z);
        let alpha = 1.0 - smoothstep(0.0, uniforms.lineWidth, dist);
        return vec4<f32>(uniforms.color.rgb, uniforms.color.a * alpha);
      }
    `,
  });

  // Create bind group layouts
  const gridBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  });

  const candlestickBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      },
    ],
  });

  const crosshairBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  });

  // Create pipelines
  const gridPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [gridBindGroupLayout],
    }),
    vertex: {
      module: gridShader,
      entryPoint: 'vs_main',
    },
    fragment: {
      module: gridShader,
      entryPoint: 'fs_main',
      targets: [{ format: 'bgra8unorm' }],
    },
    primitive: {
      topology: 'triangle-strip',
    },
  });

  const candlestickPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [candlestickBindGroupLayout],
    }),
    vertex: {
      module: candlestickShader,
      entryPoint: 'vs_main',
    },
    fragment: {
      module: candlestickShader,
      entryPoint: 'fs_main',
      targets: [{ format: 'bgra8unorm' }],
    },
    primitive: {
      topology: 'triangle-strip',
    },
  });

  const crosshairPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [crosshairBindGroupLayout],
    }),
    vertex: {
      module: crosshairShader,
      entryPoint: 'vs_main',
    },
    fragment: {
      module: crosshairShader,
      entryPoint: 'fs_main',
      targets: [{ format: 'bgra8unorm' }],
    },
    primitive: {
      topology: 'triangle-strip',
    },
  });

  return {
    gridPipeline,
    candlestickPipeline,
    crosshairPipeline,
  };
}

/**
 * Parse a color string to RGBA.
 */
export function parseColor(color: string): { r: number; g: number; b: number; a: number } {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  // TODO: Parse rgba() and rgb() formats
  return { r: 0, g: 0, b: 0, a: 1 };
}

