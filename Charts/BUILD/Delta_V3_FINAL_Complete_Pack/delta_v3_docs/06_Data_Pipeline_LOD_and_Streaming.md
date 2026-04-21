# Data Pipeline, LOD, and Streaming (V3)
**Goal:** deliver render-ready buffers with minimal main-thread work and stable performance.

---

## 1) Columnar storage (typed arrays)
Use struct-of-arrays (SoA):
- time: f64 or u64 split (hi/lo)
- prices: f32 (open/high/low/close)
- volume: f32

Avoid per-bar JS objects in hot paths.

---

## 2) Chunking strategy
- Immutable chunks for historical data (e.g., 8k–64k bars per chunk)
- Live ring buffer for streaming updates (e.g., last 2k–10k bars)

Benefits:
- avoids reallocations on updates
- supports cheap sharing/transfers
- helps LOD building and caching

---

## 3) LOD pyramid
Maintain multiple aggregated levels (OHLC):
- L0 raw
- L1 5-min
- L2 1-hour
- L3 4-hour
- L4 1-day

Selection rule:
- never render more samples than ~2× viewport pixel width

---

## 4) Envelope generation (Stage 0)
For Stage 0 silhouette:
- compute min/max per pixel column in the visible window
- can be built per LOD chunk and combined

Implementation options:
- CPU (fast enough for typical sizes)
- GPU compute (parallel-friendly) when scaling demands it

---

## 5) Streaming updates
### 5.1 Update types
- append tick into current bar
- close bar, open new bar
- batch append (catch-up)

### 5.2 Invalidation granularity
- only last N bars are dirty
- only tiles covering last N bars are invalidated
- axis labels recomputed only if scale changes

---

## 6) GPU upload strategy
- small updates: `queue.writeBuffer`
- large chunk updates:
  - stage in a pooled ArrayBuffer and upload during non-critical frames
- keep “upload budget” per frame to prevent stutter

---

## 7) Indicator compute
V3 baseline:
- CPU/WASM indicators in Data Worker
- compute only when indicator settings change or new data arrives
- cache results per LOD when possible

GPU indicators are optional later and only for parallelizable workloads (benchmark-gated).

---

## 8) Tests
- correctness tests for LOD aggregation
- stress tests for 1M bars ingestion
- soak tests for streaming over hours
