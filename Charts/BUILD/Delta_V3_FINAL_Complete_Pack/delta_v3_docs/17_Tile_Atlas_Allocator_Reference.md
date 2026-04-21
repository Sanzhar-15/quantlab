# Tile Atlas Allocator Reference (V3 Add‑On)
**Purpose:** Provide a concrete design for storing many tiles efficiently in GPU memory and managing fragmentation, eviction, and reuse.

This doc covers:
- the atlas/page model (recommended)
- allocators:
  - fixed grid allocator (best baseline)
  - buddy allocator (optional advanced)
  - free-list by row/column (hybrid)
- fragmentation handling
- how allocation interacts with LRU eviction and progressive refinement

> Goal: **predictable performance** and **bounded memory** with minimal complexity.

---

## 0) Core requirements

1. Allocate storage for **N tiles** (each tile is a fixed size in physical pixels: 256 or 512).
2. Return a mapping from **TileKey → AtlasSlot**:
   - which page
   - x/y pixel offset in page
   - UV transform for sampling
3. Support fast reallocation after eviction (avoid creating/destroying many textures).
4. Enforce a strict memory budget (MB), and evict when over budget.
5. Work with Tier A/B WebGPU, and be adaptable to Tier C WebGL2 (conceptually the same).

---

## 1) Recommended storage model: pages + fixed tile size

### 1.1 Define a “tile page”
A **tile page** is a large GPU texture (e.g., 4096×4096) subdivided into a grid of fixed tile slots.

Example (tileSize=512):
- page 4096×4096 can hold 8×8 = 64 tiles per page.

Example (tileSize=256):
- page holds 16×16 = 256 tiles per page.

### 1.2 Why fixed-size slots are best
- tiles are always the same size for a tier (256 or 512)
- fixed slots eliminate complex fragmentation
- allocation is O(1) with a bitmap
- eviction is trivial

**Conclusion:** Use a **fixed grid allocator** unless you have a strong reason not to.

---

## 2) Fixed grid allocator (baseline — recommended)

### 2.1 Slot addressing
- `slotsPerRow = pageW / tileSize`
- `slotIndex = row * slotsPerRow + col`
- store allocation state in a bitset:
  - 0 = free
  - 1 = used

### 2.2 Data structures
```ts
type TileSlot = {
  pageId: number;
  slotIndex: number;
  xPx: number;
  yPx: number;
  uvScale: [number, number];
  uvOffset: [number, number];
};

class FixedGridPage {
  texture: GPUTexture;
  slotsPerRow: number;
  slotsPerCol: number;
  usedBitset: Uint32Array; // bitmap
  freeCount: number;
}
```

### 2.3 Allocation algorithm (O(1..nWords))
- find first 0-bit in bitset
- set it to 1
- decrement freeCount
- compute xPx/yPx from slotIndex

**Optimization:** keep a list of pages with `freeCount > 0` to avoid scanning full pages.

### 2.4 Free algorithm
- clear the bit
- increment freeCount
- return slot to free pool

### 2.5 UV mapping
Tile occupies region `[xPx, xPx+tileSize] × [yPx, yPx+tileSize]`.

UV conversion:
- `uvOffset = (xPx / pageW, yPx / pageH)`
- `uvScale  = (tileSize / pageW, tileSize / pageH)`

Shader samples: `uv = uvOffset + localUV * uvScale`

### 2.6 Pros/cons
**Pros**
- fastest
- simplest
- minimal fragmentation risk
- easiest debug overlays

**Cons**
- page size is constrained to multiples of tileSize
- wasted space if you ever wanted variable tile sizes (we avoid that by tiering)

---

## 3) Buddy allocator (advanced, optional)

A buddy allocator allows variable-sized allocations (powers of two). It is only needed if:
- you want multiple tile sizes simultaneously within same tier, or
- you want to pack non-tile resources (e.g., text atlases) into same texture (not recommended).

### 3.1 Why it’s usually not worth it
- tile sizes are fixed per tier
- buddy adds fragmentation and complex merge logic
- debugability drops significantly

**Recommendation:** Do not use buddy for tiles unless you have a special constraint.

---

## 4) Hybrid allocator: fixed-grid per page + multiple page sizes

If you need multiple tile sizes (e.g., 256 for stage0 envelopes and 512 for stage2):
- keep separate page pools per tileSize
- never mix them

This keeps the fixed-grid allocator and avoids buddy complexity.

---

## 5) Page sizing guidelines

### 5.1 Choose page dimensions
Common choices:
- 2048×2048 (smaller memory footprint; more textures)
- 4096×4096 (fewer textures; larger single allocations)

Recommended default: **4096×4096** for desktop Tier A/B.
Mobile may choose 2048×2048 depending on budget and device constraints.

### 5.2 Memory accounting
Approx memory for one RGBA8 page:
- 4096×4096×4 bytes ≈ 67 MB (too large for many pages)
So for tile pages you likely want:
- `rgba8unorm` (4 bytes) is expensive at 4k²
- Consider smaller pages or lower bit-depth formats depending on content needs.

**Important:** tile textures do not necessarily need RGBA8. Options:
- R8 / RG8 / RGBA8 depending on how you encode tiles
- But if you store fully composited color tiles, RGBA8 is simplest.

### 5.3 Practical recommendation
- Use 2048×2048 pages for RGBA8 on many devices (16 MB per page)
  - 2048×2048×4 = 16 MB
- With tileSize=512 => 4×4 = 16 tiles/page (OK)
- With tileSize=256 => 8×8 = 64 tiles/page

This yields more pages but keeps per-page allocation safe.

---

## 6) Eviction and allocator integration

### 6.1 LRU is the authoritative eviction policy
The allocator itself should not decide eviction. It provides slots. The tile cache decides what to evict.

Maintain:
- `TileEntry` with:
  - key
  - slot
  - lastUsedFrame
  - stage (0/1/2)
  - revision snapshot

### 6.2 Eviction sequence (typical)
1. If allocating and no free slots exist, ask cache to evict:
   - evict farthest tiles
   - evict Stage 2 before Stage 0? **Not necessarily**; Stage 0 is cheap to rebuild.
2. Free their slots back to allocator
3. Allocate slot for new tile
4. Render tile into slot

### 6.3 Partial eviction by stage
If over budget:
- reduce Stage 2 tiles first (higher memory + more expensive to keep perfect)
- keep Stage 0 tiles for instant feedback near viewport edges

---

## 7) Fragmentation handling

With fixed-grid pages, fragmentation is not a problem in the classic sense, but you can have:
- many pages half-full

Mitigations:
- allocate new tiles preferentially from the **most-filled page** that still has a free slot
- periodically (idle only) compact by:
  - re-rendering a small set of tiles into fewer pages
  - freeing now-empty pages

**Important:** compaction must be done only when idle; never block interaction.

---

## 8) Debugging and instrumentation

Add dev overlays:
- draw tile boundaries
- color tiles by stage and state
- show page fill levels (% used)
- show eviction counters and alloc/free rates

Telemetry:
- pages allocated
- avg page fill
- alloc failures (pre-eviction)
- evictions per minute

---

## 9) Reference pseudo-code

### 9.1 Allocate tile slot
```ts
function allocTileSlot(tileSize: number): TileSlot {
  const pool = pagePools.get(tileSize);
  let page = pool.findPageWithFreeSlot();
  if (!page) page = pool.createNewPage();

  const slotIndex = page.allocBit();
  const col = slotIndex % page.slotsPerRow;
  const row = Math.floor(slotIndex / page.slotsPerRow);
  const xPx = col * tileSize;
  const yPx = row * tileSize;

  return {
    pageId: page.id,
    slotIndex,
    xPx,
    yPx,
    uvOffset: [xPx / page.width, yPx / page.height],
    uvScale: [tileSize / page.width, tileSize / page.height],
  };
}
```

### 9.2 Free tile slot
```ts
function freeTileSlot(slot: TileSlot): void {
  const page = findPage(slot.pageId);
  page.freeBit(slot.slotIndex);
}
```

---

## 10) Checklist (implementation readiness)
- [ ] Page pools per tileSize
- [ ] Fixed-grid bitmap allocator
- [ ] Budget accounting by page format
- [ ] Tile cache eviction triggers slot freeing
- [ ] Debug overlays for page fill and tile states
