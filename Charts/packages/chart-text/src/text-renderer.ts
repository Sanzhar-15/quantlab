/**
 * MSDF text renderer.
 * GPU text rendering pipeline with Canvas2D fallback.
 */

import type { GlyphMetrics } from './msdf-atlas';
import { MSDFAtlasLoader } from './msdf-atlas';
import { TextLayoutEngine, type TextLayoutOptions, type TextLayoutResult } from './text-layout';

/**
 * Text renderer interface.
 */
export interface TextRenderer {
  renderText(
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: [number, number, number, number],
    baseline?: 'top' | 'middle' | 'bottom',
    align?: 'left' | 'center' | 'right',
  ): void;
}

/**
 * MSDF text renderer.
 * Renders text using GPU with MSDF atlas.
 */
export class MSDFTextRenderer implements TextRenderer {
  private device: GPUDevice | null = null;
  private atlasLoader: MSDFAtlasLoader;
  private layoutEngine: TextLayoutEngine;
  private pipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexData: Float32Array | null = null;
  private vertexCount = 0;
  private maxVertices = 10000; // Max glyphs * 4 vertices per glyph

  public constructor(device: GPUDevice) {
    this.device = device;
    this.atlasLoader = new MSDFAtlasLoader();
    this.atlasLoader.initialize(device);
    this.layoutEngine = new TextLayoutEngine();
  }

  /**
   * Initialize renderer (load atlas, create pipeline).
   */
  public async initialize(fontSize: number = 16): Promise<void> {
    if (!this.device) {
      throw new Error('MSDFTextRenderer not initialized with device');
    }

    // Load prebaked atlas
    await this.atlasLoader.loadPrebakedAtlas(fontSize);

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      code: `
        struct VertexInput {
          @location(0) position: vec2<f32>,
          @location(1) uv: vec2<f32>,
          @location(2) color: vec4<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) uv: vec2<f32>,
          @location(1) color: vec4<f32>,
        }

        struct TextUniforms {
          viewportSize: vec2<f32>,
        }

        @group(0) @binding(0) var<uniform> uniforms: TextUniforms;
        @group(0) @binding(1) var atlasTexture: texture_2d<f32>;
        @group(0) @binding(2) var atlasSampler: sampler;

        @vertex
        fn vs_main(input: VertexInput) -> VertexOutput {
          let clipX = (input.position.x / uniforms.viewportSize.x) * 2.0 - 1.0;
          let clipY = 1.0 - (input.position.y / uniforms.viewportSize.y) * 2.0;
          return VertexOutput(
            vec4<f32>(clipX, clipY, 0.0, 1.0),
            input.uv,
            input.color
          );
        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
          let msdf = textureSample(atlasTexture, atlasSampler, input.uv);
          let distance = msdf.r - 0.5;
          let width = length(vec2<f32>(
            dpdx(input.uv.x) * uniforms.viewportSize.x,
            dpdy(input.uv.y) * uniforms.viewportSize.y
          ));
          let alpha = 1.0 - smoothstep(-width * 0.5, width * 0.5, distance);
          return vec4<f32>(input.color.rgb, input.color.a * alpha);
        }
      `,
    });

    // Create bind group layout
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: {},
        },
      ],
    });

    // Create pipeline
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 8 * 4, // position(2) + uv(2) + color(4) = 8 floats * 4 bytes
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },      // position
              { shaderLocation: 1, offset: 8, format: 'float32x2' },      // uv
              { shaderLocation: 2, offset: 16, format: 'float32x4' },     // color
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'bgra8unorm' }],
      },
      primitive: {
        topology: 'triangle-strip',
      },
    });

    // Create vertex buffer
    this.vertexBuffer = this.device.createBuffer({
      size: this.maxVertices * 8 * 4, // 8 floats * 4 bytes per vertex
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.vertexData = new Float32Array(this.maxVertices * 8);
  }

  /**
   * Render text.
   */
  public renderText(
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: [number, number, number, number],
    baseline: 'top' | 'middle' | 'bottom' = 'bottom',
    align: 'left' | 'center' | 'right' = 'left',
  ): void {
    if (!this.device || !this.pipeline || !this.vertexBuffer || !this.vertexData) {
      return;
    }

    // Get glyph metrics
    const glyphMetrics = new Map<string, GlyphMetrics>();
    for (const char of text) {
      const metrics = this.atlasLoader.getGlyphMetrics(char);
      if (metrics) {
        glyphMetrics.set(char, metrics);
      }
    }

    // Layout text
    const options: TextLayoutOptions = {
      fontSize,
      baseline,
      align,
      color,
      snapToPixel: true,
      hysteresis: 0.5,
    };

    const layout = this.layoutEngine.layoutText(text, x, y, glyphMetrics, options);

    // Check if we need fallback (missing glyphs)
    const needsFallback = text.split('').some((char) => !glyphMetrics.has(char));
    if (needsFallback) {
      // TODO: Render using Canvas2D fallback
      return;
    }

    // Upload vertices to buffer
    let offset = 0;
    for (const vertex of layout.vertices) {
      if (offset >= this.maxVertices * 8) {
        break; // Buffer full
      }

      // position
      this.vertexData[offset++] = vertex.position[0];
      this.vertexData[offset++] = vertex.position[1];
      // uv
      this.vertexData[offset++] = vertex.uv[0];
      this.vertexData[offset++] = vertex.uv[1];
      // color
      this.vertexData[offset++] = vertex.color[0];
      this.vertexData[offset++] = vertex.color[1];
      this.vertexData[offset++] = vertex.color[2];
      this.vertexData[offset++] = vertex.color[3];
    }

    this.vertexCount = layout.vertices.length;

    // Upload to GPU
    const dataToUpload = this.vertexData.subarray(0, this.vertexCount * 8);
    this.device.queue.writeBuffer(
      this.vertexBuffer,
      0,
      dataToUpload.buffer,
      dataToUpload.byteOffset,
      dataToUpload.byteLength,
    );
  }

  /**
   * Render text to a render pass.
   */
  public renderToPass(
    pass: GPURenderPassEncoder,
    viewportWidth: number,
    viewportHeight: number,
    uniformBuffer: GPUBuffer,
    bindGroup: GPUBindGroup,
  ): void {
    if (!this.pipeline || !this.vertexBuffer || this.vertexCount === 0) {
      return;
    }

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount, 1);

    // Reset vertex count for next frame
    this.vertexCount = 0;
  }

  /**
   * Create uniform buffer and bind group for text rendering.
   */
  public createUniforms(viewportWidth: number, viewportHeight: number): {
    buffer: GPUBuffer;
    bindGroup: GPUBindGroup;
  } {
    if (!this.device || !this.pipeline) {
      throw new Error('MSDFTextRenderer not initialized');
    }

    const atlasTexture = this.atlasLoader.getAtlasTexture();
    if (!atlasTexture) {
      throw new Error('Atlas texture not loaded');
    }

    // Create uniform buffer
    const uniformData = new Float32Array([viewportWidth, viewportHeight]);
    const uniformBuffer = this.device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Create sampler
    const sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Create bind group
    const bindGroupLayout = this.pipeline.getBindGroupLayout(0);
    const bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: atlasTexture.createView() },
        { binding: 2, resource: sampler },
      ],
    });

    return { buffer: uniformBuffer, bindGroup };
  }

  /**
   * Destroy and clean up resources.
   */
  public destroy(): void {
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy();
      this.vertexBuffer = null;
    }
    this.atlasLoader.destroy();
    this.layoutEngine.clearCache();
    this.device = null;
    this.pipeline = null;
  }
}

