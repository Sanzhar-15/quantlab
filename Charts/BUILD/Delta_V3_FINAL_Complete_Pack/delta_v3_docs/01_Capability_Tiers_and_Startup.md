# Capability Tiers and Startup (V3)
**Goal:** deterministic tier selection + fast recovery/downgrade when needed.

---

## 1) Inputs to tier selection

### 1.1 Feature detection
- WebGPU presence: `navigator.gpu` (Tier B) and/or `WorkerNavigator.gpu` (Tier A)
- OffscreenCanvas transfer support (Tier A path)
- WebGL2 presence (Tier C)
- Canvas2D presence (Tier D)

### 1.2 Adapter limits & features
When requesting an adapter/device, read limits/features and compare to what we need:
- max texture dimension (tile size × DPR)
- max bind groups / bindings (pipeline complexity)
- storage buffer sizes
- preferred canvas format

### 1.3 Micro-benchmark (fast, deterministic)
A microbench helps select quality knobs and avoid known “supports but slow/broken” scenarios.

**Requirements**
- Must run in < 30–60ms total
- Must not allocate large buffers
- Must be safe on mobile

**Suggested bench steps**
1. Create small device + pipeline (if not already)
2. Upload a tiny instance buffer (e.g., 2048 candles)
3. Render 10 frames to an offscreen target or canvas
4. Record CPU timing (and GPU timestamp if available)
5. Produce a `score` used to choose:
   - tile size (256 vs 512)
   - max effective DPR
   - MSAA on/off
   - cache budgets scaling

### 1.4 Remote config guardrails
Use a server config to:
- blocklist known problematic cohorts
- force downgrade during incidents
- roll out Tier A gradually
- adjust budgets/knobs without redeploy

---

## 2) Tier selection algorithm

Pseudo-logic:

```text
if remoteConfig.forceTier:
  choose it

if WebGPU available:
  if worker-path viable and benchmark ok and not blocklisted:
    Tier A
  else:
    Tier B

else if WebGL2 available:
  Tier C
else:
  Tier D
```

Also compute a **QualityProfile** per tier:
- tileSizePx
- maxEffectiveDpr
- budgets (tiles/atlas/buffers)
- frame refinement budget (ms per frame)

---

## 3) Auto downgrade rules

Downgrade triggers:
- repeated device/context loss (N times within M minutes)
- repeated uncaptured GPU errors
- frame pacing collapse (p99 beyond threshold for sustained period)
- memory budget overrun despite eviction

Downgrade ladder:
Tier A → Tier B → Tier C → Tier D

Recovery policy:
- allow “try upgrade” only after a cooldown and only for a subset of sessions (to avoid loops)

---

## 4) Startup sequencing

### 4.1 Fast time-to-first-frame
- Create renderer with minimal pipelines first (grid + candles + text blit)
- Display first frame quickly
- Defer expensive work:
  - tile cache warmup
  - MSDF dynamic glyph pages
  - optional post-processing pipelines

### 4.2 Progressive initialization
After first frame:
- start LOD building worker
- begin tile cache fill for visible region
- precompile secondary pipelines

---

## 5) Debug & introspection
Expose a debug panel (dev only) showing:
- chosen tier and why
- benchmark score
- quality profile
- budgets and usage
- device lost counts
