/**
 * Horizontal line drawing implementation.
 */

import type { Drawing, Point, HitTestResult, Handle } from '../types';
import type { CoordinateTransform } from '../coordinate-transform';

/**
 * Get handles for horizontal line.
 */
export function getHorizontalLineHandles(
  drawing: Drawing,
  transform: CoordinateTransform,
): Handle[] {
  if (drawing.anchors.length < 1) {
    return [];
  }

  const anchor = drawing.anchors[0]!;
  const screenPos = transform.dataToScreen(anchor);

  return [
    {
      anchorIndex: 0,
      position: screenPos,
      visible: true,
    },
  ];
}

/**
 * Hit test horizontal line.
 */
export function hitTestHorizontalLine(
  drawing: Drawing,
  point: Point,
  tolerance: number,
  transform: CoordinateTransform,
): HitTestResult | null {
  if (drawing.anchors.length < 1) {
    return null;
  }

  // Test handle
  const handles = getHorizontalLineHandles(drawing, transform);
  const handle = handles[0]!;
  const distance = Math.sqrt(
    Math.pow(point.x - handle.position.x, 2) + Math.pow(point.y - handle.position.y, 2),
  );
  if (distance <= tolerance) {
    return {
      type: 'handle',
      handleIndex: 0,
      distance,
    };
  }

  // Test line (horizontal line spans entire width)
  const anchor = drawing.anchors[0]!;
  const y = transform.priceToY(anchor.price);
  const distanceY = Math.abs(point.y - y);

  if (distanceY <= tolerance) {
    return {
      type: 'body',
      distance: distanceY,
    };
  }

  return null;
}

