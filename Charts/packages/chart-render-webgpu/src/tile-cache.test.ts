/**
 * Unit tests for tile cache.
 */

import { describe, it, expect } from 'vitest';
import { TileCache } from './tile-cache';
import type { TileKey } from './tile-types';
import { tileKeyToString } from './tile-types';

describe('TileCache', () => {
  it('should store and retrieve tiles', () => {
    const cache = new TileCache();
    const key: TileKey = {
      paneId: 'pane-0',
      tileX: 0,
      tileY: 0,
      lodLevel: 0,
      stage: 0,
      themeRev: 0,
      seriesRev: 0,
      dprBucket: 1,
    };

    const slot = {
      pageId: 1,
      slotIndex: 0,
      xPx: 0,
      yPx: 0,
      uvOffset: [0, 0] as [number, number],
      uvScale: [1, 1] as [number, number],
    };

    cache.setTile(key, slot);
    const entry = cache.getTile(key);

    expect(entry).not.toBeNull();
    expect(entry?.key).toEqual(key);
    expect(entry?.slot).toEqual(slot);
  });

  it('should invalidate tiles by theme', () => {
    const cache = new TileCache();
    const key: TileKey = {
      paneId: 'pane-0',
      tileX: 0,
      tileY: 0,
      lodLevel: 0,
      stage: 0,
      themeRev: 0,
      seriesRev: 0,
      dprBucket: 1,
    };

    cache.setTile(key, { pageId: 1, slotIndex: 0, xPx: 0, yPx: 0, uvOffset: [0, 0], uvScale: [1, 1] });
    cache.invalidateByTheme();

    const entry = cache.getTile(key);
    expect(entry).toBeNull();
  });

  it('should invalidate tiles by series revision', () => {
    const cache = new TileCache();
    const seriesId = 'series-1';
    
    const key1: TileKey = {
      paneId: 'pane-0',
      tileX: 0,
      tileY: 0,
      lodLevel: 0,
      stage: 0,
      themeRev: 0,
      seriesRev: 0,
      dprBucket: 1,
    };

    cache.setTile(key1, { pageId: 1, slotIndex: 0, xPx: 0, yPx: 0, uvOffset: [0, 0], uvScale: [1, 1] });
    
    const rev = cache.incrementSeriesRevision(seriesId);
    cache.invalidateByRevision(seriesId, rev);

    const entry = cache.getTile(key1);
    expect(entry).toBeNull();
  });

  it('should evict LRU tiles', () => {
    const cache = new TileCache();
    const viewportTiles = new Set<string>();

    // Add multiple tiles
    for (let i = 0; i < 10; i++) {
      const key: TileKey = {
        paneId: 'pane-0',
        tileX: i,
        tileY: 0,
        lodLevel: 0,
        stage: 0,
        themeRev: 0,
        seriesRev: 0,
        dprBucket: 1,
      };
      cache.setTile(key, { pageId: 1, slotIndex: i, xPx: i * 256, yPx: 0, uvOffset: [0, 0], uvScale: [1, 1] });
      if (i < 5) {
        viewportTiles.add(tileKeyToString(key));
      }
    }

    // Evict to keep only 5 tiles
    const evicted = cache.evictLRU(viewportTiles, 5);
    expect(evicted.length).toBeGreaterThan(0);
    expect(cache.getAllTiles().length).toBeLessThanOrEqual(5);
  });

  it('should get tiles in viewport', () => {
    const cache = new TileCache();
    const viewport = { x: 0, y: 0, width: 1024, height: 768 };
    const tiles = cache.getTilesInViewport(
      viewport,
      'pane-0',
      0,
      256, // tileSize
      0,   // lodLevel
      1,   // dprBucket
      1,   // overscan
    );

    expect(tiles.length).toBeGreaterThan(0);
    // Should include overscan tiles
    expect(tiles.some(t => t.tileX < 0 || t.tileY < 0)).toBe(true);
  });
});

