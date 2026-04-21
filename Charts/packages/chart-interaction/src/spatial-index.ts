/**
 * Spatial index for efficient drawing queries.
 * Uses grid-based binning for O(1) average-case queries.
 */

import type { Rect } from '@charts-plus/chart-core';

export type Point = {
  x: number;
  y: number;
};

/**
 * Drawing interface (minimal for spatial index).
 */
export interface Drawing {
  id: string;
  bounds: Rect;
  handles?: Point[]; // Anchor points for hit testing
}

/**
 * Grid cell key.
 */
type CellKey = string;

/**
 * Spatial index using grid-based binning.
 */
export class SpatialIndex {
  private grid = new Map<CellKey, Drawing[]>();
  private cellSize: number;
  private drawings = new Map<string, Drawing>();

  /**
   * Create spatial index.
   * @param cellSize Size of grid cells in pixels (default: 100)
   */
  public constructor(cellSize: number = 100) {
    this.cellSize = Math.max(1, cellSize);
  }

  /**
   * Get cell key for a point.
   */
  private getCellKey(x: number, y: number): CellKey {
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    return `${cellX},${cellY}`;
  }

  /**
   * Get all cell keys that a rectangle intersects.
   */
  private getCellKeys(rect: Rect): CellKey[] {
    const minX = Math.floor(rect.x / this.cellSize);
    const maxX = Math.floor((rect.x + rect.width) / this.cellSize);
    const minY = Math.floor(rect.y / this.cellSize);
    const maxY = Math.floor((rect.y + rect.height) / this.cellSize);

    const keys: CellKey[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        keys.push(`${x},${y}`);
      }
    }
    return keys;
  }

  /**
   * Insert a drawing into the index.
   */
  public insert(drawing: Drawing): void {
    // Remove if already exists
    this.remove(drawing.id);

    // Add to drawings map
    this.drawings.set(drawing.id, drawing);

    // Add to all intersecting cells
    const cellKeys = this.getCellKeys(drawing.bounds);
    for (const key of cellKeys) {
      let cell = this.grid.get(key);
      if (!cell) {
        cell = [];
        this.grid.set(key, cell);
      }
      cell.push(drawing);
    }
  }

  /**
   * Remove a drawing from the index.
   */
  public remove(drawingId: string): void {
    const drawing = this.drawings.get(drawingId);
    if (!drawing) {
      return;
    }

    this.drawings.delete(drawingId);

    // Remove from all cells
    const cellKeys = this.getCellKeys(drawing.bounds);
    for (const key of cellKeys) {
      const cell = this.grid.get(key);
      if (cell) {
        const index = cell.indexOf(drawing);
        if (index >= 0) {
          cell.splice(index, 1);
        }
        // Clean up empty cells
        if (cell.length === 0) {
          this.grid.delete(key);
        }
      }
    }
  }

  /**
   * Update a drawing in the index.
   * More efficient than remove + insert if bounds changed slightly.
   */
  public update(drawing: Drawing): void {
    const existing = this.drawings.get(drawing.id);
    if (!existing) {
      this.insert(drawing);
      return;
    }

    // Check if bounds changed significantly
    const oldKeys = this.getCellKeys(existing.bounds);
    const newKeys = this.getCellKeys(drawing.bounds);

    // If cells are the same, just update the drawing reference
    if (oldKeys.length === newKeys.length && oldKeys.every((k, i) => k === newKeys[i])) {
      this.drawings.set(drawing.id, drawing);
      // Update references in cells
      for (const key of oldKeys) {
        const cell = this.grid.get(key);
        if (cell) {
          const index = cell.indexOf(existing);
          if (index >= 0) {
            cell[index] = drawing;
          }
        }
      }
    } else {
      // Bounds changed significantly, reinsert
      this.remove(drawing.id);
      this.insert(drawing);
    }
  }

  /**
   * Query drawings that intersect a rectangle.
   */
  public query(rect: Rect): Drawing[] {
    const cellKeys = this.getCellKeys(rect);
    const candidates = new Set<Drawing>();

    // Collect candidates from relevant cells
    for (const key of cellKeys) {
      const cell = this.grid.get(key);
      if (cell) {
        for (const drawing of cell) {
          candidates.add(drawing);
        }
      }
    }

    // Filter to actual intersections
    const results: Drawing[] = [];
    for (const drawing of candidates) {
      if (this.intersects(rect, drawing.bounds)) {
        results.push(drawing);
      }
    }

    return results;
  }

  /**
   * Find nearest drawing to a point.
   */
  public nearest(point: Point, maxDistance: number = Infinity): Drawing | null {
    // Expand search radius until we find something
    let radius = this.cellSize;
    let best: Drawing | null = null;
    let bestDistance = maxDistance;

    while (radius <= maxDistance * 2) {
      const rect: Rect = {
        x: point.x - radius,
        y: point.y - radius,
        width: radius * 2,
        height: radius * 2,
      };

      const candidates = this.query(rect);
      for (const drawing of candidates) {
        const distance = this.distanceToDrawing(point, drawing);
        if (distance < bestDistance) {
          best = drawing;
          bestDistance = distance;
        }
      }

      if (best && bestDistance <= radius) {
        // Found something within current radius
        break;
      }

      radius += this.cellSize;
    }

    return best;
  }

  /**
   * Check if two rectangles intersect.
   */
  private intersects(a: Rect, b: Rect): boolean {
    return !(
      a.x + a.width < b.x ||
      b.x + b.width < a.x ||
      a.y + a.height < b.y ||
      b.y + b.height < a.y
    );
  }

  /**
   * Calculate distance from point to drawing.
   */
  private distanceToDrawing(point: Point, drawing: Drawing): number {
    const bounds = drawing.bounds;

    // Distance to rectangle (0 if inside)
    const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
    const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));

    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Clear all drawings.
   */
  public clear(): void {
    this.grid.clear();
    this.drawings.clear();
  }

  /**
   * Get all drawings.
   */
  public getAll(): Drawing[] {
    return Array.from(this.drawings.values());
  }

  /**
   * Get statistics.
   */
  public getStats(): {
    totalDrawings: number;
    totalCells: number;
    avgDrawingsPerCell: number;
  } {
    let totalInCells = 0;
    for (const cell of this.grid.values()) {
      totalInCells += cell.length;
    }

    return {
      totalDrawings: this.drawings.size,
      totalCells: this.grid.size,
      avgDrawingsPerCell: this.grid.size > 0 ? totalInCells / this.grid.size : 0,
    };
  }
}

