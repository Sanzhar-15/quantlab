/**
 * Snapping system for drawings.
 */

import type { Drawing, AnchorPoint, Point } from './types';
import type { CoordinateTransform } from './coordinate-transform';

/**
 * Snapping system.
 */
export class SnappingSystem {
  private snapToBars = true;
  private snapToPriceLevels = true;
  private snapToDrawings = true;
  private snapThreshold = 5; // pixels

  /**
   * Snap anchor to nearest valid position.
   */
  public snapAnchor(
    anchor: AnchorPoint,
    drawing: Drawing,
    handleIndex: number,
    allDrawings: Drawing[],
    transform: CoordinateTransform,
  ): AnchorPoint {
    const screenPoint = transform.dataToScreen(anchor);
    let snappedPoint = { ...screenPoint };

    // Snap to bar timestamps
    if (this.snapToBars) {
      snappedPoint = this.snapToBarTimestamp(snappedPoint, transform);
    }

    // Snap to price levels
    if (this.snapToPriceLevels) {
      snappedPoint = this.snapToPriceLevel(snappedPoint, transform);
    }

    // Snap to other drawings
    if (this.snapToDrawings) {
      snappedPoint = this.snapToDrawingAnchors(
        snappedPoint,
        drawing,
        handleIndex,
        allDrawings,
        transform,
      );
    }

    // Convert back to data coordinates
    return transform.screenToData(snappedPoint);
  }

  /**
   * Snap to nearest bar timestamp.
   */
  private snapToBarTimestamp(point: Point, transform: CoordinateTransform): Point {
    // TODO: Get bar timestamps from series data
    // For now, snap to nearest time grid line
    const time = transform.xToTime(point.x);
    const snappedTime = this.snapToTimeGrid(time, transform);
    const snappedX = transform.timeToX(snappedTime);

    if (Math.abs(snappedX - point.x) <= this.snapThreshold) {
      return { x: snappedX, y: point.y };
    }

    return point;
  }

  /**
   * Snap time to grid.
   */
  private snapToTimeGrid(time: number, transform: CoordinateTransform): number {
    // Simple grid snapping (can be enhanced with actual bar timestamps)
    // For now, snap to nearest minute/hour/day based on zoom level
    const timeSpan = transform.timeScale.max - transform.timeScale.min;
    let gridSize: number;

    if (timeSpan < 3600000) {
      // Less than 1 hour: snap to nearest minute
      gridSize = 60000;
    } else if (timeSpan < 86400000) {
      // Less than 1 day: snap to nearest hour
      gridSize = 3600000;
    } else {
      // More than 1 day: snap to nearest day
      gridSize = 86400000;
    }

    return Math.round(time / gridSize) * gridSize;
  }

  /**
   * Snap to price level.
   */
  private snapToPriceLevel(point: Point, transform: CoordinateTransform): Point {
    const price = transform.yToPrice(point.y);
    const snappedPrice = this.snapToPriceGrid(price);
    const snappedY = transform.priceToY(snappedPrice);

    if (Math.abs(snappedY - point.y) <= this.snapThreshold) {
      return { x: point.x, y: snappedY };
    }

    return point;
  }

  /**
   * Snap price to grid.
   */
  private snapToPriceGrid(price: number): number {
    // Snap to round numbers (10, 100, 1000, etc.)
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(price))));
    const gridSize = magnitude;
    return Math.round(price / gridSize) * gridSize;
  }

  /**
   * Snap to other drawing anchor points.
   */
  private snapToDrawingAnchors(
    point: Point,
    currentDrawing: Drawing,
    handleIndex: number,
    allDrawings: Drawing[],
    transform: CoordinateTransform,
  ): Point {
    let bestPoint = point;
    let bestDistance = this.snapThreshold;

    for (const drawing of allDrawings) {
      if (drawing.id === currentDrawing.id || !drawing.visible) {
        continue;
      }

      for (const anchor of drawing.anchors) {
        const anchorScreen = transform.dataToScreen(anchor);
        const distance = Math.sqrt(
          Math.pow(point.x - anchorScreen.x, 2) + Math.pow(point.y - anchorScreen.y, 2),
        );

        if (distance < bestDistance) {
          bestDistance = distance;
          bestPoint = anchorScreen;
        }
      }
    }

    return bestPoint;
  }

  /**
   * Set snap options.
   */
  public setOptions(options: {
    snapToBars?: boolean;
    snapToPriceLevels?: boolean;
    snapToDrawings?: boolean;
    snapThreshold?: number;
  }): void {
    if (options.snapToBars !== undefined) this.snapToBars = options.snapToBars;
    if (options.snapToPriceLevels !== undefined) this.snapToPriceLevels = options.snapToPriceLevels;
    if (options.snapToDrawings !== undefined) this.snapToDrawings = options.snapToDrawings;
    if (options.snapThreshold !== undefined) this.snapThreshold = options.snapThreshold;
  }
}

// Fix: Add transform reference for snapToTimeGrid
// This is a placeholder - in real implementation, transform would be passed or stored
let transform: CoordinateTransform | null = null;

