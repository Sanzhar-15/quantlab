# Tile Cache and Scheduler (V3)
**Goal:** instant pan + stable frame pacing via tile reuse and progressive refinement.

---

## 1) Tile cache principles
- Tiles are **physical pixel** regions.
- Tiles are cached **per pane** and optionally per layer (background/series/overlays).
- Interaction overlay is never cached.

---

## 2) Tile coordinate system
Define a tile grid in physical pixels:
- `tileSizePx` = 256 or 512 (tier dependent)
- `tileX = floor(pxX / tileSizePx)`
- `tileY = floor(pxY / tileSizePx)`

Use overscan (e.g. +1 tile on each side).

---

## 3) Tile key and invalidation

### 3.1 Key (must include appearance determinants)
```ts
type TileKey = {
  paneId: number;
  tileX: number;
  tileY: number;
  lodLevel: number;
  themeRev: number;
  seriesRev: number;   // increments when data changes affecting range
  overlayRev: number;  // increments when overlays in tile change
  dprBucket: number;   // discretized DPR bucket (e.g. 1, 2)
  layerMask: number;   // which layers are inside this tile texture
}
```

### 3.2 Invalidation rules
Invalidate tiles when:
- data revision touches the bar range that maps into the tile
- zoom LOD changes
- themeRev changes
- overlayRev changes for that tile bounds
- DPR bucket changes

---

## 4) Reprojection pan algorithm

When pan delta occurs:
1. Keep existing tiles
2. Shift their screen placement by delta (no re-render)
3. Mark newly exposed tiles as `Invalid`
4. Schedule rebuild jobs for invalid tiles

This provides “instant pan” even under heavy data.

---

## 5) Progressive refinement scheduling

### 5.1 Stage definitions
- Stage 0: envelope silhouette
- Stage 1: LOD candles
- Stage 2: full quality

### 5.2 Scheduler priority
Priority order (highest → lowest):
1. Interaction overlay
2. Reprojection draw
3. Stage 0 tiles in newly exposed regions
4. Stage 1 tiles in newly exposed regions
5. Stage 2 tiles and polish

### 5.3 Job priority scoring
Score tiles by:
- distance to pointer (higher priority near pointer)
- distance to viewport center
- whether tile is newly exposed
- whether tile is in an overscan band

---

## 6) Tile cache storage design

### Option A: One texture per tile
Pros: simpler logic  
Cons: too many textures, descriptor overhead

### Option B: Texture atlas pages (recommended)
- allocate pages of fixed size storing many tiles
- each tile occupies a region (or slice)
- maintain free list and LRU

### Option C: Texture array slices (good for fixed tile size)
- one `texture_2d_array` with N slices
- each slice is a tile
- page when slices fill

Choose B or C for Tier A/B; choose A for Tier C/D simplicity if needed.

---

## 7) Eviction policy
- LRU weighted by viewport proximity
- Always keep:
  - current viewport tiles
  - overscan tiles (small band)
- When over budget:
  - drop farthest tiles first
  - degrade to Stage 0 if needed

---

## 8) Debugging tools
- Tile overlay debug: color tiles by state (valid/stale/invalid)
- Show cache hit % and rebuild queue length
- Show memory usage estimate
