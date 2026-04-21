/**
 * Indicator rendering orchestrator.
 * Integrates with WebGPU renderer for indicator overlays and separate panes.
 */

import type { IndicatorResult, IndicatorInstance, IndicatorStyle } from './types';
import type { IndicatorDefinition } from './types';

/**
 * Indicator render data for GPU rendering.
 */
export interface IndicatorRenderData {
  instanceId: string;
  indicatorId: string;
  result: IndicatorResult;
  style: IndicatorStyle;
  overlay: boolean;                    // Render in price pane or separate pane
  outputFields: IndicatorDefinition['outputFields'];
}

/**
 * Indicator renderer.
 * Orchestrates indicator rendering integration.
 */
export class IndicatorRenderer {
  private renderData = new Map<string, IndicatorRenderData>();

  /**
   * Add indicator render data.
   */
  public addIndicator(
    instance: IndicatorInstance,
    definition: IndicatorDefinition,
    result: IndicatorResult,
  ): void {
    this.renderData.set(instance.instanceId, {
      instanceId: instance.instanceId,
      indicatorId: instance.indicatorId,
      result,
      style: instance.style || definition.defaultStyle,
      overlay: definition.overlay,
      outputFields: definition.outputFields,
    });
  }

  /**
   * Remove indicator render data.
   */
  public removeIndicator(instanceId: string): void {
    this.renderData.delete(instanceId);
  }

  /**
   * Update indicator render data.
   */
  public updateIndicator(
    instance: IndicatorInstance,
    definition: IndicatorDefinition,
    result: IndicatorResult,
  ): void {
    this.addIndicator(instance, definition, result);
  }

  /**
   * Get all render data.
   */
  public getAllRenderData(): IndicatorRenderData[] {
    return Array.from(this.renderData.values());
  }

  /**
   * Get render data for overlay indicators (price pane).
   */
  public getOverlayRenderData(): IndicatorRenderData[] {
    return Array.from(this.renderData.values()).filter((data) => data.overlay);
  }

  /**
   * Get render data for separate pane indicators.
   */
  public getSeparatePaneRenderData(): IndicatorRenderData[] {
    return Array.from(this.renderData.values()).filter((data) => !data.overlay);
  }

  /**
   * Clear all render data.
   */
  public clear(): void {
    this.renderData.clear();
  }
}

