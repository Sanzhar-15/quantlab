/**
 * Drawing rendering orchestrator.
 */

import type { Drawing } from './types';
import type { CoordinateTransform } from './coordinate-transform';

/**
 * Drawing render data for GPU rendering.
 */
export interface DrawingRenderData {
  drawing: Drawing;
  screenPoints: Array<{ x: number; y: number }>;
  style: Drawing['style'];
}

/**
 * Drawing renderer.
 */
export class DrawingRenderer {
  private renderData: DrawingRenderData[] = [];

  /**
   * Prepare drawings for rendering.
   */
  public prepareDrawings(
    drawings: Drawing[],
    transform: CoordinateTransform,
  ): DrawingRenderData[] {
    this.renderData = [];

    for (const drawing of drawings) {
      if (!drawing.visible) {
        continue;
      }

      const screenPoints = drawing.anchors.map((anchor) => transform.dataToScreen(anchor));

      this.renderData.push({
        drawing,
        screenPoints,
        style: drawing.style,
      });
    }

    return this.renderData;
  }

  /**
   * Get render data.
   */
  public getRenderData(): DrawingRenderData[] {
    return this.renderData;
  }

  /**
   * Clear render data.
   */
  public clear(): void {
    this.renderData = [];
  }
}

