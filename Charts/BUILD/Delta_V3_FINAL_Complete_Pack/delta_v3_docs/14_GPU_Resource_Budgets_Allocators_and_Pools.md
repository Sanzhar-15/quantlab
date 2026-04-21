# GPU Resource Budgets, Allocators, and Pools (V3 Add‑On)
**Purpose:** Make GPU memory and allocations predictable so smoothness does not degrade over time.

---

## 0) Core principles
- **No unbounded growth**: tiles/atlas/buffers must plateau.
- **Avoid allocation churn**: allocate from pools; reuse buffers; prefer ring allocators for per-frame data.
- **Degrade quality before stuttering**: if memory pressure hits, reduce cache fidelity/size.

---

## 1) Budget model (tiered defaults)

Budgets should be expressed in **MB** and can be scaled by device class.

### 1.1 Suggested defaults
**Tier A/B desktop**
- Tile cache: 192 MB
- Text atlas (MSDF + dynamic pages): 48 MB
- Dynamic buffers (instances/text quads): 64 MB
- Staging/upload buffers: 64 MB
- Total soft cap: ~368 MB

**Tier A/B mobile**
- Tile cache: 96 MB
- Text atlas: 24 MB
- Dynamic buffers: 32 MB
- Staging/upload: 32 MB
- Total soft cap: ~184 MB

**Tier C**
- Lower caps; prioritize stability (e.g., tiles 64 MB)

**Tier D**
- CPU memory budgeting (not GPU), but still cap cached bitmaps.

### 1.2 Scaling heuristics
Scale budgets based on:
- chosen tier
- microbench score
- device memory hint (if available)
- viewport size × effective DPR

---

## 2) Tile cache storage strategies

### 2.1 Atlas pages (recommended)
Allocate large pages (e.g., 4096×4096) and sub-allocate tile regions.

- Pros: fewer textures, fewer bindings
- Cons: fragmentation; needs allocator

**Allocator choices**
- fixed-grid allocator (tile-aligned, simplest)
- buddy allocator (more complex)

### 2.2 Texture array slices (good option)
Allocate `texture_2d_array` where each slice is a tile.

- Pros: simple indexing
- Cons: need to manage slice counts and page arrays

---

## 3) Eviction policy (tile LRU)

### 3.1 LRU scoring
Compute eviction score:
- far from viewport = higher eviction priority
- not recently used = higher eviction priority
- stage 0 tiles are cheapest; evict them first if needed

### 3.2 What must never be evicted
- currently visible tiles (unless device is failing)
- overscan band tiles (small buffer for fast pan)

---

## 4) Per-frame dynamic buffer allocator

### 4.1 Ring allocator
Use a large GPUBuffer for per-frame dynamic data:
- camera/theme uniforms (small)
- instance data (if direct draw)
- text quad vertices

Pattern:
- allocate sequentially with alignment
- wrap around when reaching end
- ensure GPU is done reading previous regions before overwriting

### 4.2 Multi-buffering
Use 2–3 ring buffers (triple buffer) to avoid overwriting in-flight data.

---

## 5) Upload and staging buffers

### 5.1 Small uploads
Use `queue.writeBuffer` for small updates (uniforms, small arrays).

### 5.2 Large uploads
Use pooled staging buffers and `copyBufferToBuffer`:
- allocate staging buffers from pool
- schedule upload work outside interaction-critical frames

**Upload budget rule**
- cap per-frame upload bytes and time (avoid stutter)

---

## 6) Text atlas budgets

### 6.1 Static vs dynamic pages
- static page: digits/Latin shipped
- dynamic pages: created rarely, budgeted, evictable

### 6.2 Eviction
Evict least-used dynamic pages when:
- atlas budget exceeded
- tile cache needs memory headroom

Fallback:
- render rare glyphs via Canvas2D lane temporarily

---

## 7) Memory accounting instrumentation
Track counters in debug build:
- allocated textures bytes (estimated)
- tile count by stage
- atlas pages
- dynamic buffer usage high-water marks
- staging pool usage

Expose to:
- debug overlay
- telemetry (sampled)

---

## 8) Checklist
- [ ] Budgets enforced with evictions
- [ ] Ring allocators used for per-frame data
- [ ] Upload budget prevents large mid-interaction copies
- [ ] Instrumentation shows plateau in long-session tests
