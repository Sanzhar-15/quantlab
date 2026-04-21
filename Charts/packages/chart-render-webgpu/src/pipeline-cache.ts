/**
 * Pipeline cache for WebGPU shader pipelines.
 * Caches compiled pipelines to avoid recompilation.
 */

export interface PipelineCacheEntry {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

/**
 * Pipeline cache for WebGPU render pipelines.
 * Caches compiled pipelines to improve performance.
 */
export class PipelineCache {
  private cache = new Map<string, PipelineCacheEntry>();
  private device: GPUDevice;

  public constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Get or create a render pipeline.
   * @param key Unique key for the pipeline.
   * @param createFn Function to create the pipeline if not cached.
   * @returns The cached or newly created pipeline entry.
   */
  public getOrCreate(
    key: string,
    createFn: (device: GPUDevice) => PipelineCacheEntry,
  ): PipelineCacheEntry {
    let entry = this.cache.get(key);
    if (!entry) {
      entry = createFn(this.device);
      this.cache.set(key, entry);
    }
    return entry;
  }

  /**
   * Clear the pipeline cache.
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached pipelines.
   */
  public size(): number {
    return this.cache.size;
  }
}

