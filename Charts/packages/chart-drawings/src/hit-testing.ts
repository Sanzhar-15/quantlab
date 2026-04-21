/**
 * Drawing hit testing using spatial index.
 */

import type { Drawing, Point, HitTestResult } from './types';
import type { CoordinateTransform } from './coordinate-transform';
import { SpatialIndex, type Drawing as SpatialDrawing } from '@charts-plus/chart-interaction';
import { getTrendLineHandles, hitTestTrendLine } from './drawings/trend-line';
import { getHorizontalLineHandles, hitTestHorizontalLine } from './drawings/horizontal-line';

/**
 * Drawing hit testing manager.
 */
export class DrawingHitTesting {
  private spatialIndex: SpatialIndex;
  private drawings = new Map<string, Drawing>();
  private transform: CoordinateTransform | null = null;

  public constructor() {
    this.spatialIndex = new SpatialIndex(50); // 50px cell size
  }

  /**
   * Set coordinate transform.
   */
  public setTransform(transform: CoordinateTransform): void {
    this.transform = transform;
    this.rebuildIndex();
  }

  /**
   * Add drawing.
   */
  public addDrawing(drawing: Drawing): void {
    this.drawings.set(drawing.id, drawing);
    this.updateDrawingInIndex(drawing);
  }

  /**
   * Remove drawing.
   */
  public removeDrawing(drawingId: string): void {
    this.drawings.delete(drawingId);
    this.spatialIndex.remove(drawingId);
  }

  /**
   * Update drawing.
   */
  public updateDrawing(drawing: Drawing): void {
    this.drawings.set(drawing.id, drawing);
    this.updateDrawingInIndex(drawing);
  }

  /**
   * Hit test at a point.
   */
  public hitTest(point: Point, tolerance: number = 5): {
    drawing: Drawing;
    result: HitTestResult;
  } | null {
    if (!this.transform) {
      return null;
    }

    // Query spatial index for candidates
    const candidates = this.spatialIndex.query(
      { x: point.x, y: point.y, width: tolerance * 2, height: tolerance * 2 },
    );

    let bestResult: { drawing: Drawing; result: HitTestResult } | null = null;
    let bestDistance = Infinity;

    // Test handles first (higher priority)
    for (const candidate of candidates) {
      const drawing = this.drawings.get(candidate.id);
      if (!drawing || !drawing.visible) {
        continue;
      }

      // Get handles and test them
      const handles = this.getHandles(drawing);
      for (const handle of handles) {
        const distance = Math.sqrt(
          Math.pow(point.x - handle.position.x, 2) + Math.pow(point.y - handle.position.y, 2),
        );
        if (distance <= tolerance && distance < bestDistance) {
          bestResult = {
            drawing,
            result: {
              type: 'handle',
              handleIndex: handle.anchorIndex,
              distance,
            },
          };
          bestDistance = distance;
        }
      }
    }

    if (bestResult) {
      return bestResult;
    }

    // Test drawing segments/bodies
    for (const candidate of candidates) {
      const drawing = this.drawings.get(candidate.id);
      if (!drawing || !drawing.visible) {
        continue;
      }

      const result = this.hitTestDrawing(drawing, point, tolerance);
      if (result && result.distance < bestDistance) {
        bestResult = { drawing, result };
        bestDistance = result.distance;
      }
    }

    return bestResult;
  }

  /**
   * Hit test a specific drawing.
   */
  private hitTestDrawing(
    drawing: Drawing,
    point: Point,
    tolerance: number,
  ): HitTestResult | null {
    if (!this.transform) {
      return null;
    }

    // Delegate to type-specific hit testing
    switch (drawing.type) {
      case 'trend_line':
        return hitTestTrendLine(drawing, point, tolerance, this.transform);
      case 'horizontal_line':
        return hitTestHorizontalLine(drawing, point, tolerance, this.transform);
      // TODO: Add more drawing types
      default:
        return null;
    }
  }

  /**
   * Get handles for a drawing.
   */
  private getHandles(drawing: Drawing): Array<{ anchorIndex: number; position: Point }> {
    if (!this.transform) {
      return [];
    }

    switch (drawing.type) {
      case 'trend_line':
        return getTrendLineHandles(drawing, this.transform);
      case 'horizontal_line':
        return getHorizontalLineHandles(drawing, this.transform);
      // TODO: Add more drawing types
      default:
        return [];
    }
  }

  /**
   * Update drawing in spatial index.
   */
  private updateDrawingInIndex(drawing: Drawing): void {
    if (!this.transform) {
      return;
    }

    // Calculate screen bounds
    const bounds = this.calculateScreenBounds(drawing);
    if (bounds) {
      const spatialDrawing: SpatialDrawing = {
        id: drawing.id,
        bounds,
        handles: drawing.anchors.map((anchor) => this.transform!.dataToScreen(anchor)),
      };
      this.spatialIndex.update(spatialDrawing);
    }
  }

  /**
   * Calculate screen bounds for a drawing.
   */
  private calculateScreenBounds(drawing: Drawing): { x: number; y: number; width: number; height: number } | null {
    if (!this.transform || drawing.anchors.length === 0) {
      return null;
    }

    const points = drawing.anchors.map((anchor) => this.transform!.dataToScreen(anchor));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // Add padding for hit testing
    const padding = 5;
    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }

  /**
   * Rebuild spatial index.
   */
  private rebuildIndex(): void {
    this.spatialIndex.clear();
    for (const drawing of this.drawings.values()) {
      this.updateDrawingInIndex(drawing);
    }
  }

  /**
   * Clear all drawings.
   */
  public clear(): void {
    this.drawings.clear();
    this.spatialIndex.clear();
  }
}

