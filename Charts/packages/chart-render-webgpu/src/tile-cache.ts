/**
 * Tile cache manager for WebGPU renderer.
 * Handles tile storage, invalidation, and LRU eviction.
 */

import type { PaneId, Rect } from '@charts-plus/chart-core';
import type { TileKey, TileEntry, ViewportRect, Point } from './tile-types';
import { tileKeyToString, TileCoordinates } from './tile-types';

/**
 * Tile cache manager.
 * Manages cached tiles with LRU eviction and viewport proximity weighting.
 */
export class TileCache {
  private tiles = new Map<string, TileEntry>();
  private revisionCounters = {
    theme: 0,
    series: new Map<string, number>(),
  };
  private frameCounter = 0;

  /**
   * Get a tile from the cache.
   * Updates lastUsedFrame if found.
   */
  public getTile(key: TileKey): TileEntry | null {
    const keyStr = tileKeyToString(key);
    const entry = this.tiles.get(keyStr);
    if (entry) {
      entry.lastUsedFrame = this.frameCounter;
      entry.isValid = this.isKeyValid(key, entry.key);
    }
    return entry ?? null;
  }

  /**
   * Set a tile in the cache.
   */
  public setTile(key: TileKey, slot: TileEntry['slot']): TileEntry {
    const keyStr = tileKeyToString(key);
    const now = Date.now();
    const entry: TileEntry = {
      key,
      slot,
      lastUsedFrame: this.frameCounter,
      createdAt: now,
      isValid: true,
      isNewlyExposed: false,
    };
    this.tiles.set(keyStr, entry);
    return entry;
  }

  /**
   * Invalidate a specific tile.
   */
  public invalidateTile(key: TileKey): void {
    const keyStr = tileKeyToString(key);
    this.tiles.delete(keyStr);
  }

  /**
   * Invalidate all tiles for a specific series revision.
   */
  public invalidateByRevision(seriesId: string, revision: number): void {
    const currentRev = this.revisionCounters.series.get(seriesId) ?? 0;
    if (revision > currentRev) {
      this.revisionCounters.series.set(seriesId, revision);
      // Invalidate all tiles with old revision
      for (const [keyStr, entry] of this.tiles.entries()) {
        if (entry.key.seriesRev < revision) {
          this.tiles.delete(keyStr);
        }
      }
    }
  }

  /**
   * Invalidate all tiles due to theme change.
   */
  public invalidateByTheme(): void {
    this.revisionCounters.theme++;
    // Invalidate all tiles with old theme revision
    const currentThemeRev = this.revisionCounters.theme;
    for (const [keyStr, entry] of this.tiles.entries()) {
      if (entry.key.themeRev < currentThemeRev) {
        this.tiles.delete(keyStr);
      }
    }
  }

  /**
   * Invalidate tiles by LOD level change.
   */
  public invalidateByLodLevel(lodLevel: number): void {
    for (const [keyStr, entry] of this.tiles.entries()) {
      if (entry.key.lodLevel !== lodLevel) {
        this.tiles.delete(keyStr);
      }
    }
  }

  /**
   * Invalidate tiles by DPR bucket change.
   */
  public invalidateByDprBucket(dprBucket: number): void {
    for (const [keyStr, entry] of this.tiles.entries()) {
      if (entry.key.dprBucket !== dprBucket) {
        this.tiles.delete(keyStr);
      }
    }
  }

  /**
   * Get all tiles in a viewport for a specific pane and stage.
   */
  public getTilesInViewport(
    viewport: ViewportRect,
    paneId: PaneId,
    stage: 0 | 1 | 2,
    tileSize: number,
    lodLevel: number,
    dprBucket: number,
    overscan: number = 1,
  ): TileKey[] {
    const tiles = TileCoordinates.getTilesInViewport(viewport, tileSize, overscan);
    const themeRev = this.revisionCounters.theme;
    const seriesRev = Math.max(...Array.from(this.revisionCounters.series.values()), 0);

    return tiles.map(({ tileX, tileY }) => ({
      paneId,
      tileX,
      tileY,
      lodLevel,
      stage,
      themeRev,
      seriesRev,
      dprBucket,
    }));
  }

  /**
   * Evict tiles using LRU with viewport proximity weighting.
   * @param viewportTiles Set of tile key strings that should be kept (viewport + overscan)
   * @param maxTiles Maximum number of tiles to keep
   * @returns Array of evicted tile keys
   */
  public evictLRU(viewportTiles: Set<string>, maxTiles: number): TileKey[] {
    if (this.tiles.size <= maxTiles) {
      return [];
    }

    // Score all tiles for eviction priority
    const scoredTiles: Array<{ key: string; entry: TileEntry; score: number }> = [];

    for (const [keyStr, entry] of this.tiles.entries()) {
      // Never evict viewport tiles
      if (viewportTiles.has(keyStr)) {
        continue;
      }

      // Calculate eviction score (higher = more likely to evict)
      let score = 0;

      // Age (older = higher score)
      const ageFrames = this.frameCounter - entry.lastUsedFrame;
      score += ageFrames * 10;

      // Stage penalty (Stage 2 is more expensive, prefer keeping Stage 0)
      // Actually, we want to evict Stage 2 first (it's more expensive to keep)
      score += entry.key.stage * 100;

      // Invalid tiles are high priority for eviction
      if (!entry.isValid) {
        score += 1000;
      }

      scoredTiles.push({ key: keyStr, entry, score });
    }

    // Sort by score (highest first = evict first)
    scoredTiles.sort((a, b) => b.score - a.score);

    // Evict excess tiles
    const toEvict = this.tiles.size - maxTiles;
    const evicted: TileKey[] = [];

    for (let i = 0; i < toEvict && i < scoredTiles.length; i++) {
      const { key, entry } = scoredTiles[i]!;
      this.tiles.delete(key);
      evicted.push(entry.key);
    }

    return evicted;
  }

  /**
   * Mark tiles as newly exposed (for panning).
   */
  public markNewlyExposed(tileKeys: TileKey[]): void {
    for (const key of tileKeys) {
      const keyStr = tileKeyToString(key);
      const entry = this.tiles.get(keyStr);
      if (entry) {
        entry.isNewlyExposed = true;
      }
    }
  }

  /**
   * Clear newly exposed flags.
   */
  public clearNewlyExposed(): void {
    for (const entry of this.tiles.values()) {
      entry.isNewlyExposed = false;
    }
  }

  /**
   * Update frame counter (call once per frame).
   */
  public tickFrame(): void {
    this.frameCounter++;
  }

  /**
   * Get current theme revision.
   */
  public getThemeRevision(): number {
    return this.revisionCounters.theme;
  }

  /**
   * Get current series revision for a series.
   */
  public getSeriesRevision(seriesId: string): number {
    return this.revisionCounters.series.get(seriesId) ?? 0;
  }

  /**
   * Increment series revision.
   */
  public incrementSeriesRevision(seriesId: string): number {
    const current = this.revisionCounters.series.get(seriesId) ?? 0;
    const next = current + 1;
    this.revisionCounters.series.set(seriesId, next);
    return next;
  }

  /**
   * Get all cached tiles.
   */
  public getAllTiles(): TileEntry[] {
    return Array.from(this.tiles.values());
  }

  /**
   * Get cache statistics.
   */
  public getStats(): {
    totalTiles: number;
    validTiles: number;
    newlyExposedTiles: number;
    tilesByStage: Record<0 | 1 | 2, number>;
  } {
    let validTiles = 0;
    let newlyExposedTiles = 0;
    const tilesByStage: Record<0 | 1 | 2, number> = { 0: 0, 1: 0, 2: 0 };

    for (const entry of this.tiles.values()) {
      if (entry.isValid) validTiles++;
      if (entry.isNewlyExposed) newlyExposedTiles++;
      tilesByStage[entry.key.stage]++;
    }

    return {
      totalTiles: this.tiles.size,
      validTiles,
      newlyExposedTiles,
      tilesByStage,
    };
  }

  /**
   * Clear all tiles.
   */
  public clear(): void {
    this.tiles.clear();
  }

  /**
   * Check if a key is still valid (matches current revision state).
   */
  private isKeyValid(key: TileKey, cachedKey: TileKey): boolean {
    return (
      key.themeRev === cachedKey.themeRev &&
      key.seriesRev === cachedKey.seriesRev &&
      key.lodLevel === cachedKey.lodLevel &&
      key.dprBucket === cachedKey.dprBucket
    );
  }
}

