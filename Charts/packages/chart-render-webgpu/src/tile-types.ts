/**
 * Type definitions for tile cache system.
 * Defines tile keys, entries, slots, and related structures.
 */

import type { PaneId } from '@charts-plus/chart-core';

/**
 * Tile key uniquely identifies a cached tile.
 * Must include all appearance determinants.
 */
export type TileKey = {
  paneId: PaneId;
  tileX: number;        // Tile X coordinate (physical pixels / tileSize)
  tileY: number;        // Tile Y coordinate
  lodLevel: number;     // LOD level (0 = full, 1+ = decimated)
  stage: 0 | 1 | 2;     // Refinement stage (0=envelope, 1=LOD, 2=full)
  themeRev: number;     // Theme revision counter
  seriesRev: number;    // Series data revision
  dprBucket: number;    // DPR bucket (1, 2, etc.)
};

/**
 * String representation of a tile key for Map lookups.
 */
export function tileKeyToString(key: TileKey): string {
  return `${key.paneId}|${key.tileX}|${key.tileY}|${key.lodLevel}|${key.stage}|${key.themeRev}|${key.seriesRev}|${key.dprBucket}`;
}

/**
 * Parse a tile key string back to TileKey.
 */
export function tileKeyFromString(str: string): TileKey {
  const parts = str.split('|');
  return {
    paneId: parts[0]!,
    tileX: parseInt(parts[1]!, 10),
    tileY: parseInt(parts[2]!, 10),
    lodLevel: parseInt(parts[3]!, 10),
    stage: parseInt(parts[4]!, 10) as 0 | 1 | 2,
    themeRev: parseInt(parts[5]!, 10),
    seriesRev: parseInt(parts[6]!, 10),
    dprBucket: parseInt(parts[7]!, 10),
  };
}

/**
 * Tile slot in the texture atlas.
 * Specifies which page and where within that page.
 */
export type TileSlot = {
  pageId: number;
  slotIndex: number;
  xPx: number;          // X pixel offset in page
  yPx: number;          // Y pixel offset in page
  uvOffset: [number, number];  // UV offset for sampling (xPx/pageW, yPx/pageH)
  uvScale: [number, number];    // UV scale for sampling (tileSize/pageW, tileSize/pageH)
};

/**
 * Tile entry in the cache.
 * Contains the tile data and metadata.
 */
export type TileEntry = {
  key: TileKey;
  slot: TileSlot;
  lastUsedFrame: number;  // Frame number when last used
  createdAt: number;      // Timestamp when created
  isValid: boolean;       // True if tile matches current view state
  isNewlyExposed: boolean; // True if tile was just exposed by panning
};

/**
 * Tile screen state for reprojection.
 * Tracks where tiles are currently rendered on screen.
 */
export type TileScreenState = {
  key: TileKey;
  slot: TileSlot;
  screenX: number;      // Current screen position (physical pixels)
  screenY: number;
  isValid: boolean;     // True if tile matches current view
  stage: 0 | 1 | 2;     // Current refinement stage
};

/**
 * Tile job for refinement scheduler.
 * Represents a tile that needs to be rendered or refined.
 */
export type TileJob = {
  key: TileKey;
  stage: 0 | 1 | 2;     // Target stage to render
  priority: number;     // Job priority score
  scheduledAt: number;  // Timestamp when scheduled
};

/**
 * Viewport rectangle in physical pixels.
 */
export type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Point in physical pixels.
 */
export type Point = {
  x: number;
  y: number;
};

/**
 * Tile coordinate utilities.
 */
export class TileCoordinates {
  /**
   * Convert physical pixel coordinates to tile coordinates.
   */
  static pxToTile(px: number, tileSize: number): number {
    return Math.floor(px / tileSize);
  }

  /**
   * Convert tile coordinate to physical pixel (start of tile).
   */
  static tileToPx(tile: number, tileSize: number): number {
    return tile * tileSize;
  }

  /**
   * Get tile bounds in physical pixels.
   */
  static getTileBounds(tileX: number, tileY: number, tileSize: number): ViewportRect {
    return {
      x: tileX * tileSize,
      y: tileY * tileSize,
      width: tileSize,
      height: tileSize,
    };
  }

  /**
   * Get tiles that intersect a viewport rectangle.
   */
  static getTilesInViewport(
    viewport: ViewportRect,
    tileSize: number,
    overscan: number = 1,
  ): Array<{ tileX: number; tileY: number }> {
    const minTileX = this.pxToTile(viewport.x - overscan * tileSize, tileSize);
    const maxTileX = this.pxToTile(viewport.x + viewport.width + overscan * tileSize, tileSize);
    const minTileY = this.pxToTile(viewport.y - overscan * tileSize, tileSize);
    const maxTileY = this.pxToTile(viewport.y + viewport.height + overscan * tileSize, tileSize);

    const tiles: Array<{ tileX: number; tileY: number }> = [];
    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        tiles.push({ tileX, tileY });
      }
    }
    return tiles;
  }

  /**
   * Get center point of a tile in physical pixels.
   */
  static getTileCenter(tileX: number, tileY: number, tileSize: number): Point {
    return {
      x: (tileX + 0.5) * tileSize,
      y: (tileY + 0.5) * tileSize,
    };
  }
}

