/**
 * Main computation orchestrator with incremental updates and result buffer management.
 */

import type {
  IndicatorInstance,
  IndicatorResult,
  IndicatorState,
  IndicatorJob,
  ComputeTier,
  IndicatorDefinition,
} from './types';
import type { IndicatorRegistry } from './registry';
import { DependencyGraph } from './dependency-graph';
import { getIndicatorComputation } from './indicators';
import { mergeIndicatorResults } from './indicators/utils';

/**
 * Computation engine for indicators.
 */
export class ComputationEngine {
  private registry: IndicatorRegistry;
  private dependencyGraph: DependencyGraph;
  private instances = new Map<string, IndicatorInstance>();
  private states = new Map<string, IndicatorState>();
  private results = new Map<string, IndicatorResult>();
  private jobQueue: IndicatorJob[] = [];
  private rendererTier: 'A' | 'B' | 'C' | 'D' = 'D';
  private wasmAvailable = false;

  public constructor(registry: IndicatorRegistry) {
    this.registry = registry;
    this.dependencyGraph = new DependencyGraph(registry);
  }

  /**
   * Set renderer tier (affects compute tier selection).
   */
  public setRendererTier(tier: 'A' | 'B' | 'C' | 'D'): void {
    this.rendererTier = tier;
  }

  /**
   * Set WASM availability.
   */
  public setWasmAvailable(available: boolean): void {
    this.wasmAvailable = available;
  }

  /**
   * Add indicator instance.
   */
  public addInstance(instance: IndicatorInstance): void {
    this.instances.set(instance.instanceId, instance);
    this.dependencyGraph.addInstance(instance);

    // Schedule initial computation
    this.scheduleJob(instance.instanceId, 'initial');
  }

  /**
   * Remove indicator instance.
   */
  public removeInstance(instanceId: string): void {
    this.instances.delete(instanceId);
    this.states.delete(instanceId);
    this.results.delete(instanceId);
    this.dependencyGraph.removeInstance(instanceId);

    // Remove jobs for this instance
    this.jobQueue = this.jobQueue.filter((job) => job.instanceId !== instanceId);
  }

  /**
   * Update indicator parameters.
   */
  public updateInstanceParams(instanceId: string, params: Record<string, any>): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.params = params;
    this.states.delete(instanceId); // Clear state for full recompute
    this.scheduleJob(instanceId, 'param_change');
  }

  /**
   * Handle new data appended to series.
   */
  public onDataAppended(seriesId: string, newBarCount: number): void {
    // Schedule incremental updates for all instances on this series
    for (const instance of this.instances.values()) {
      if (instance.seriesId === seriesId) {
        this.scheduleJob(instance.instanceId, 'data_append');
      }
    }
  }

  /**
   * Handle data replacement (full recompute needed).
   */
  public onDataReplaced(seriesId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.seriesId === seriesId) {
        this.states.delete(instance.instanceId);
        this.scheduleJob(instance.instanceId, 'data_replace');
      }
    }
  }

  /**
   * Process computation jobs (within frame budget).
   */
  public processJobs(
    dataProvider: (seriesId: string) => {
      time: Float64Array;
      open?: Float64Array;
      high?: Float64Array;
      low?: Float64Array;
      close: Float64Array;
      volume?: Float64Array;
    },
    frameBudgetMs: number = 4,
  ): void {
    const startTime = performance.now();
    const deadline = startTime + frameBudgetMs;

    // Sort jobs by priority (higher first)
    this.jobQueue.sort((a, b) => b.priority - a.priority);

    while (this.jobQueue.length > 0 && performance.now() < deadline) {
      const job = this.jobQueue.shift()!;
      this.executeJob(job, dataProvider);
    }
  }

  /**
   * Get computation result for an instance.
   */
  public getResult(instanceId: string): IndicatorResult | null {
    return this.results.get(instanceId) || null;
  }

  /**
   * Get all results.
   */
  public getAllResults(): Map<string, IndicatorResult> {
    return new Map(this.results);
  }

  /**
   * Schedule a computation job.
   */
  private scheduleJob(instanceId: string, reason: IndicatorJob['reason']): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return;
    }

    const definition = this.registry.get(instance.indicatorId);
    if (!definition) {
      return;
    }

    // Determine compute tier
    const computeTier = this.selectComputeTier(definition);

    // Determine priority
    const priority = reason === 'initial' ? 1000 : reason === 'param_change' ? 800 : 500;

    // Determine compute range (for now, full range; optimize later)
    const job: IndicatorJob = {
      indicatorId: instance.indicatorId,
      instanceId,
      seriesId: instance.seriesId,
      priority,
      computeRange: {
        startIdx: 0,
        endIdx: 0, // Will be set based on data length
      },
      reason,
      computeTier,
    };

    // Remove existing jobs for this instance
    this.jobQueue = this.jobQueue.filter((j) => j.instanceId !== instanceId);
    this.jobQueue.push(job);
  }

  /**
   * Execute a computation job.
   */
  private executeJob(
    job: IndicatorJob,
    dataProvider: (seriesId: string) => {
      time: Float64Array;
      open?: Float64Array;
      high?: Float64Array;
      low?: Float64Array;
      close: Float64Array;
      volume?: Float64Array;
    },
  ): void {
    const instance = this.instances.get(job.instanceId);
    if (!instance) {
      return;
    }

    const definition = this.registry.get(job.indicatorId);
    if (!definition) {
      return;
    }

    // Get data
    const data = dataProvider(job.seriesId);
    if (!data || data.close.length === 0) {
      return;
    }

    // Determine compute range
    const dataLength = data.close.length;
    let startIdx = job.computeRange.startIdx;
    let endIdx = job.computeRange.endIdx;

    if (endIdx === 0 || endIdx >= dataLength) {
      endIdx = dataLength - 1;
    }

    // Get previous state for incremental computation
    const previousState = job.reason === 'data_append' ? (this.states.get(job.instanceId) ?? null) : null;

    // Get computation implementation
    const computation = getIndicatorComputation(job.indicatorId);
    if (!computation) {
      console.warn(`No computation implementation for ${job.indicatorId}`);
      return;
    }

    // Execute computation
    try {
      const { result, newState } = computation.compute(
        data,
        instance.params,
        startIdx,
        endIdx,
        previousState,
      );

      // Set series ID
      result.seriesId = job.seriesId;
      result.instanceId = job.instanceId;

      // Merge with existing result if incremental
      if (previousState && job.reason === 'data_append') {
        const existingResult = this.results.get(job.instanceId);
        if (existingResult) {
          const merged = mergeIndicatorResults(existingResult, result);
          this.results.set(job.instanceId, merged);
        } else {
          this.results.set(job.instanceId, result);
        }
      } else {
        this.results.set(job.instanceId, result);
      }

      // Update state
      this.states.set(job.instanceId, newState);
    } catch (error) {
      console.error(`Error computing indicator ${job.indicatorId}:`, error);
    }
  }

  /**
   * Select compute tier for an indicator.
   */
  private selectComputeTier(definition: IndicatorDefinition): ComputeTier {
    if ((this.rendererTier === 'A' || this.rendererTier === 'B') && definition.hasGPUCompute) {
      return 'GPU-Compute';
    } else if (this.wasmAvailable && definition.hasWASM) {
      return 'CPU-WASM';
    } else {
      return 'CPU-JS';
    }
  }

  /**
   * Get topological order for computation.
   */
  public getComputationOrder(): string[] {
    return this.dependencyGraph.getTopologicalOrder();
  }
}

