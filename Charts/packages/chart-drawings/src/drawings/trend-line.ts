/**
 * Trend line drawing implementation.
 */

import type { Drawing, Point, HitTestResult, Handle } from '../types';
import type { CoordinateTransform } from '../coordinate-transform';

/**
 * Get handles for trend line.
 */
export function getTrendLineHandles(
  drawing: Drawing,
  transform: CoordinateTransform,
): Handle[] {
  if (drawing.anchors.length < 2) {
    return [];
  }

  return drawing.anchors.map((anchor, index) => {
    const screenPos = transform.dataToScreen(anchor);
    return {
      anchorIndex: index,
      position: screenPos,
      visible: true,
    };
  });
}

/**
 * Hit test trend line.
 */
export function hitTestTrendLine(
  drawing: Drawing,
  point: Point,
  tolerance: number,
  transform: CoordinateTransform,
): HitTestResult | null {
  if (drawing.anchors.length < 2) {
    return null;
  }

  // Test handles first
  const handles = getTrendLineHandles(drawing, transform);
  for (const handle of handles) {
    const distance = Math.sqrt(
      Math.pow(point.x - handle.position.x, 2) + Math.pow(point.y - handle.position.y, 2),
    );
    if (distance <= tolerance) {
      return {
        type: 'handle',
        handleIndex: handle.anchorIndex,
        distance,
      };
    }
  }

  // Test line segment
  const p1 = transform.dataToScreen(drawing.anchors[0]!);
  const p2 = transform.dataToScreen(drawing.anchors[1]!);

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const distance = Math.sqrt(Math.pow(point.x - p1.x, 2) + Math.pow(point.y - p1.y, 2));
    if (distance <= tolerance) {
      return { type: 'body', distance };
    }
    return null;
  }

  // Parameter t along line segment [0, 1]
  let t = ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const closest = { x: p1.x + t * dx, y: p1.y + t * dy };
  const distance = Math.sqrt(
    Math.pow(point.x - closest.x, 2) + Math.pow(point.y - closest.y, 2),
  );

  if (distance <= tolerance) {
    return {
      type: 'segment',
      distance,
      t,
    };
  }

  return null;
}

