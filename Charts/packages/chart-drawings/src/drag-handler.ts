/**
 * Handle dragging logic with real-time updates and constraints.
 */

import type { Drawing, AnchorPoint, Point } from './types';
import type { CoordinateTransform } from './coordinate-transform';
import type { SnappingSystem } from './snapping';

/**
 * Drag handler.
 */
export class DragHandler {
  private transform: CoordinateTransform | null = null;
  private snapping: SnappingSystem | null = null;

  /**
   * Set coordinate transform.
   */
  public setTransform(transform: CoordinateTransform): void {
    this.transform = transform;
  }

  /**
   * Set snapping system.
   */
  public setSnapping(snapping: SnappingSystem): void {
    this.snapping = snapping;
  }

  /**
   * Start dragging a handle.
   */
  public startDrag(drawing: Drawing, handleIndex: number, startPoint: Point): void {
    // Drag state is managed by interaction state machine
    // This method is for initialization if needed
  }

  /**
   * Update dragging handle position.
   */
  public updateDrag(
    drawing: Drawing,
    handleIndex: number,
    currentPoint: Point,
    allDrawings: Drawing[],
  ): AnchorPoint {
    if (!this.transform) {
      throw new Error('Coordinate transform not set');
    }

    // Convert screen point to data coordinates
    let anchor: AnchorPoint = this.transform.screenToData(currentPoint);

    // Apply constraints based on drawing type
    anchor = this.applyConstraints(drawing, handleIndex, anchor);

    // Apply snapping
    if (this.snapping) {
      anchor = this.snapping.snapAnchor(anchor, drawing, handleIndex, allDrawings, this.transform);
    }

    return anchor;
  }

  /**
   * Apply constraints to anchor based on drawing type.
   */
  private applyConstraints(
    drawing: Drawing,
    handleIndex: number,
    anchor: AnchorPoint,
  ): AnchorPoint {
    switch (drawing.type) {
      case 'horizontal_line':
        // Horizontal line: only price can change, time stays fixed
        if (drawing.anchors.length > 0) {
          return {
            time: drawing.anchors[0]!.time,
            price: anchor.price,
          };
        }
        break;

      case 'vertical_line':
        // Vertical line: only time can change, price stays fixed
        if (drawing.anchors.length > 0) {
          return {
            time: anchor.time,
            price: drawing.anchors[0]!.price,
          };
        }
        break;

      case 'parallel_channel':
        // Parallel channel: maintain parallel constraint
        // TODO: Implement parallel constraint
        break;

      // Other drawing types may have constraints
      default:
        break;
    }

    return anchor;
  }

  /**
   * Finish dragging.
   */
  public finishDrag(): void {
    // Cleanup if needed
  }
}

