/**
 * GPU compute shader interface and WebGPU compute pipeline setup.
 */

import type { IndicatorResult, IndicatorState } from '../types';

/**
 * GPU compute interface.
 */
export interface GPUComputeInterface {
  /**
   * Execute GPU compute for an indicator.
   */
  compute(
    indicatorId: string,
    data: {
      time: Float64Array;
      open?: Float64Array;
      high?: Float64Array;
      low?: Float64Array;
      close: Float64Array;
      volume?: Float64Array;
    },
    params: Record<string, any>,
    startIdx: number,
    endIdx: number,
    state: IndicatorState | null,
  ): Promise<IndicatorResult>;
}

/**
 * GPU compute implementation using WebGPU.
 */
export class WebGPUCompute implements GPUComputeInterface {
  private device: GPUDevice;
  private pipelines = new Map<string, GPUComputePipeline>();
  private shaderModules = new Map<string, GPUShaderModule>();

  public constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Load shader module.
   */
  public async loadShader(name: string, code: string): Promise<void> {
    const module = this.device.createShaderModule({
      code,
      label: `indicator-${name}`,
    });
    this.shaderModules.set(name, module);
  }

  /**
   * Create compute pipeline for an indicator.
   */
  public async createPipeline(indicatorId: string, shaderName: string): Promise<void> {
    const shaderModule = this.shaderModules.get(shaderName);
    if (!shaderModule) {
      throw new Error(`Shader ${shaderName} not loaded`);
    }

    const pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    this.pipelines.set(indicatorId, pipeline);
  }

  /**
   * Execute GPU compute.
   */
  public async compute(
    indicatorId: string,
    data: {
      time: Float64Array;
      open?: Float64Array;
      high?: Float64Array;
      low?: Float64Array;
      close: Float64Array;
      volume?: Float64Array;
    },
    params: Record<string, any>,
    startIdx: number,
    endIdx: number,
    state: IndicatorState | null,
  ): Promise<IndicatorResult> {
    const pipeline = this.pipelines.get(indicatorId);
    if (!pipeline) {
      throw new Error(`Pipeline for ${indicatorId} not found`);
    }

    const length = endIdx - startIdx + 1;

    // Create input buffer (prices)
    const priceBuffer = this.device.createBuffer({
      size: data.close.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      priceBuffer,
      0,
      data.close.buffer,
      data.close.byteOffset,
      data.close.byteLength,
    );

    // Create output buffer
    const outputBuffer = this.device.createBuffer({
      size: length * 4, // f32 = 4 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Create uniform buffer (indicator-specific)
    const uniformBuffer = this.createUniformBuffer(indicatorId, params, startIdx, endIdx, length);

    // Create state buffer (for incremental computation)
    const stateBuffer = this.createStateBuffer(state);

    // Create bind group
    const bindGroup = this.createBindGroup(
      indicatorId,
      uniformBuffer,
      priceBuffer,
      outputBuffer,
      stateBuffer,
    );

    // Dispatch compute
    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);

    const workgroupCount = Math.ceil(length / 64); // 64 threads per workgroup
    pass.dispatchWorkgroups(workgroupCount);

    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    // Read result
    const result = await this.readResult(outputBuffer, length);

    // Cleanup
    priceBuffer.destroy();
    outputBuffer.destroy();
    uniformBuffer.destroy();
    if (stateBuffer) stateBuffer.destroy();

    return {
      instanceId: state?.instanceId || '',
      seriesId: '',
      startIdx,
      length,
      outputs: {
        value: result,
      },
      validFrom: startIdx,
      revision: (state?.outputs.get('value') ? state.outputs.get('value')!.length : 0) + 1,
    };
  }

  /**
   * Create uniform buffer (indicator-specific).
   */
  private createUniformBuffer(
    indicatorId: string,
    params: Record<string, any>,
    startIdx: number,
    endIdx: number,
    length: number,
  ): GPUBuffer {
    // Indicator-specific uniform creation
    // For now, create a generic buffer
    const uniformData = new Float32Array([
      params.period || 20,
      startIdx,
      endIdx,
      length,
    ]);

    const buffer = this.device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.device.queue.writeBuffer(buffer, 0, uniformData);
    return buffer;
  }

  /**
   * Create state buffer for incremental computation.
   */
  private createStateBuffer(state: IndicatorState | null): GPUBuffer | null {
    if (!state || state.intermediateState.byteLength === 0) {
      return null;
    }

    const buffer = this.device.createBuffer({
      size: state.intermediateState.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.device.queue.writeBuffer(buffer, 0, state.intermediateState);
    return buffer;
  }

  /**
   * Create bind group.
   */
  private createBindGroup(
    indicatorId: string,
    uniformBuffer: GPUBuffer,
    priceBuffer: GPUBuffer,
    outputBuffer: GPUBuffer,
    stateBuffer: GPUBuffer | null,
  ): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: priceBuffer } },
      { binding: 2, resource: { buffer: outputBuffer } },
    ];

    if (stateBuffer) {
      entries.push({ binding: 3, resource: { buffer: stateBuffer } });
    }

    const pipeline = this.pipelines.get(indicatorId);
    if (!pipeline) {
      throw new Error(`Pipeline for ${indicatorId} not found`);
    }

    const layout = pipeline.getBindGroupLayout(0);
    return this.device.createBindGroup({
      layout,
      entries,
    });
  }

  /**
   * Read result from GPU buffer.
   */
  private async readResult(outputBuffer: GPUBuffer, length: number): Promise<Float32Array> {
    // Create staging buffer
    const stagingBuffer = this.device.createBuffer({
      size: length * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // Copy to staging
    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, length * 4);
    this.device.queue.submit([commandEncoder.finish()]);

    // Map and read
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mapped = stagingBuffer.getMappedRange();
    const result = new Float32Array(mapped);
    const copy = new Float32Array(result);
    stagingBuffer.unmap();

    stagingBuffer.destroy();
    return copy;
  }

  /**
   * Destroy and clean up resources.
   */
  public destroy(): void {
    // Pipelines and shader modules are automatically cleaned up when device is destroyed
    this.pipelines.clear();
    this.shaderModules.clear();
  }
}

