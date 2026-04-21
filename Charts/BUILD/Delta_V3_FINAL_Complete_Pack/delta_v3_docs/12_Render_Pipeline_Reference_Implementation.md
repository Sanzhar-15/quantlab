# Render Pipeline Reference Implementation (V3 Add‑On)
**Purpose:** Provide a concrete pseudo-code reference for:
- frame scheduling & budgeting
- tile rebuild queue & priority scoring
- bind group & pipeline caching
- resource pooling and per-frame allocators
- device loss recovery & tier downgrade

This document is intentionally specific so the implementation team can build without reinventing patterns.

---

## 0) Conventions
- “Renderer” refers to Tier A (worker) or Tier B (main-thread) runtime.
- “Now” refers to `performance.now()` milliseconds.
- Time budgeting uses a rolling estimate of encode+GPU cost to stabilize p95/p99.

---

## 1) Main thread: Input capture and coalescing

### 1.1 Coalesced pointer loop
```ts
let lastInput: InputState = defaultInput();
let seq = 0;

function onPointerMove(ev: PointerEvent) {
  // Use coalesced events when available:
  const events = (ev.getCoalescedEvents?.() ?? [ev]) as PointerEvent[];
  const last = events[events.length - 1];

  lastInput.pointer.x = last.clientX;
  lastInput.pointer.y = last.clientY;
  lastInput.pointer.buttons = last.buttons;
  lastInput.pointer.mods = modsBitmask(last);
  lastInput.pointer.kind = pointerKind(last.pointerType);
  lastInput.pointer.id = last.pointerId;
  lastInput.pointer.inBounds = true;
  lastInput.tMs = performance.now();

  // For message-mode: queue but do not post every event (coalesce).
  queueInputForNextRAF();
}

function onWheel(ev: WheelEvent) {
  // Accumulate wheel for next frame (do not send per wheel event):
  lastInput.wheel.dx += ev.deltaX;
  lastInput.wheel.dy += ev.deltaY;
  lastInput.wheel.mode = ev.deltaMode;
  lastInput.tMs = performance.now();
  queueInputForNextRAF();
}

function flushInputToRenderer() {
  if (transport.mode === "SAB") {
    sabWriteInput(lastInput); // atomic seq write last
  } else {
    postMessageInput(lastInput); // transferable JSON or small binary
  }
}
```
**Key rule:** send at most once per animation frame in message mode.

---

## 2) Renderer init sequence (Tier B baseline)

### 2.1 Init steps
```ts
async function initRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, opts: InitOpts) {
  // 1) Acquire GPU device (or WebGL2/Canvas2D fallback in tier selection)
  const device = await createWebGPUDeviceOrThrow(opts);

  // 2) Create swapchain/context targets
  const context = configureCanvas(device, canvas, preferredFormat());

  // 3) Initialize managers
  this.resource = new GPUResourceManager(device, opts.budgets);
  this.bindGroupCache = new BindGroupCache(device);
  this.pipelineCache = new PipelineCache(device);
  this.tileCache = new TileCache(this.resource, opts.tileConfig);
  this.scheduler = new FrameScheduler(opts.frameBudgets);

  // 4) Pipeline warmup: compile only essential pipelines
  await this.pipelineCache.warmupEssential();

  // 5) Create static bundles (optional)
  this.gridBundle = buildGridBundle(device, this.pipelineCache);

  // 6) Start render loop
  startFrameLoop();
}
```

### 2.2 Why Tier B first
Tier B avoids early dependency on OffscreenCanvas WebGPU worker paths; Tier A becomes an optimization after the core is stable.

---

## 3) Frame loop (the heart of smoothness)

### 3.1 Frame loop skeleton
```ts
function frame(nowMs: number) {
  // --- Phase 0: read latest input (fast) ---
  const input = transport.mode === "SAB" ? sabReadLatestInput() : drainInputQueue();

  // --- Phase 1: update interaction state and camera ---
  const cameraDelta = gestureEngine.update(input, nowMs);
  if (cameraDelta.changed) {
    camera.apply(cameraDelta);
    damage.markCameraChanged();
  }

  // --- Phase 2: compute dirty scope ---
  // Determine what needs redraw (tiles, text, overlays).
  const dirty = damage.evaluate(camera, scene, nowMs);

  // --- Phase 3: schedule tile work (budgeted) ---
  // Reproject existing tiles immediately.
  tileCache.updatePlacement(camera);

  // Enqueue rebuild jobs for newly exposed / invalid tiles.
  if (dirty.tilesChanged) {
    enqueueTileJobs(dirty, nowMs);
  }

  // Run limited tile jobs within this frame's budget.
  scheduler.beginFrame(nowMs);
  runScheduledJobsWithinBudget(nowMs);

  // --- Phase 4: encode and submit GPU commands ---
  const cmd = encodeFrameCommands(nowMs);
  device.queue.submit([cmd]);

  // --- Phase 5: present ---
  // Present is implicit via canvas context / swapchain.

  // --- Phase 6: telemetry ---
  statsRecorder.recordFrame(nowMs, scheduler, tileCache, resource);

  requestNextFrame();
}
```

### 3.2 Budget philosophy
- Interaction overlay must always run.
- Reprojection draw must always run.
- Tile rebuild and refinement is opportunistic within remaining budget.

---

## 4) Tile job queue & priority scoring

### 4.1 Job structure
```ts
type TileJobStage = 0 | 1 | 2;

type TileJob = {
  key: TileKey;
  stage: TileJobStage;
  priority: number;
  enqueuedAtMs: number;
  revSnapshot: { themeRev: number; seriesRev: number; overlayRev: number; };
};
```

### 4.2 Priority scoring (example)
```ts
function scoreTile(tile: TileKey, pointerPx: Vec2, viewport: RectPx): number {
  const tileCenter = tileCenterPx(tile);
  const dPointer = dist(tileCenter, pointerPx);
  const dCenter = dist(tileCenter, viewport.center);

  // Newly exposed tiles get a bonus.
  const exposureBonus = isNewlyExposed(tile) ? 5000 : 0;

  // Stage weighting: Stage 0 highest.
  const stageWeight = tile.stage === 0 ? 3000 : tile.stage === 1 ? 1500 : 0;

  // Prefer near pointer and near viewport center.
  return exposureBonus + stageWeight - (dPointer * 0.5 + dCenter * 0.2);
}
```

### 4.3 Enqueue policy
- Enqueue Stage 0 jobs first for all invalid tiles.
- Enqueue Stage 1 for tiles visible in viewport.
- Enqueue Stage 2 only when idle or when frame time is stable.

### 4.4 Cancellation policy
If tile’s `revSnapshot` no longer matches current revisions, drop the job (it’s stale).

---

## 5) Running jobs within budget

### 5.1 Scheduler interface
```ts
class FrameScheduler {
  beginFrame(nowMs: number) { /* reset per-frame budget counters */ }
  timeRemainingMs(nowMs: number): number { /* budget - elapsed */ }
  canRunJob(jobCostEstimateMs: number, nowMs: number): boolean { /* ... */ }
  account(jobCostMs: number) { /* ... */ }
}
```

### 5.2 Job loop
```ts
function runScheduledJobsWithinBudget(nowMs: number) {
  while (jobQueue.notEmpty()) {
    const job = jobQueue.popMaxPriority();
    const est = estimates.costMs(job.stage);

    if (!scheduler.canRunJob(est, nowMs)) break;

    const t0 = performance.now();
    buildTile(job);
    const cost = performance.now() - t0;

    scheduler.account(cost);
    estimates.update(job.stage, cost);
  }
}
```

### 5.3 buildTile(job)
- Render into a tile render target (atlas page or array slice).
- Use a minimal pass set depending on stage:
  - Stage 0: envelope only
  - Stage 1: candles/LOD geometry + grid
  - Stage 2: full overlays + polish

**Rule:** do not rebuild text on every tile unless necessary; text can be separate (see text pipeline).

---

## 6) Encoding the frame (GPU commands)

### 6.1 Core idea
Frame composition is:
1) draw cached tiles (textured quads) in correct placement  
2) draw any uncached live layers (interaction overlay)  
3) optional: draw dynamic overlays being edited (handles)

### 6.2 Encode pseudocode
```ts
function encodeFrameCommands(nowMs: number): GPUCommandBuffer {
  const encoder = device.createCommandEncoder();

  // Main render pass:
  const pass = encoder.beginRenderPass(renderPassDescForCanvas());

  // 1) Draw cached tiles
  tileCache.draw(pass, pipelineCache, bindGroupCache, camera);

  // 2) Draw dynamic series (only if we choose uncached path for some content)
  // (Usually tiles cover it; this is optional.)
  if (damage.requiresDirectSeriesDraw) {
    drawSeries(pass);
  }

  // 3) Text (lane A: MSDF) if needed
  if (damage.textDirty) {
    textSystem.drawMSDF(pass);
  }

  // 4) Interaction overlay always
  interaction.draw(pass, camera, scene);

  pass.end();
  return encoder.finish();
}
```

---

## 7) Bind group caching and uniform updates

### 7.1 Bind group cache key
Bind groups are expensive; cache them aggressively.

Key fields:
- pipelineLayoutId
- textureViewIds
- samplerIds
- bufferIds + dynamic offsets pattern

### 7.2 Update strategy
- Use a small uniform ring buffer per frame:
  - allocate per draw group (camera/theme)
  - write via `queue.writeBuffer` into a mapped staging view (or direct)

### 7.3 Example
```ts
const camOffset = uniformRing.alloc(sizeof(CameraUniform), 256);
uniformRing.write(camOffset, cameraUniformBytes);
const bg = bindGroupCache.getOrCreate("SeriesPass", { camOffset, atlasView, sampler });
pass.setBindGroup(0, bg, [camOffset]);
```

---

## 8) Pipeline cache & warmup

### 8.1 Pipeline cache responsibilities
- create and store pipelines by descriptor hash
- label pipelines for debugging
- warm up essential pipelines at init to avoid first-interaction hitch

### 8.2 Warmup strategy
- compile: grid, candles, tile blit, MSDF, interaction overlay
- defer: exotic overlays, rare drawing types

---

## 9) GPU resource manager & pools

### 9.1 Texture atlas pages (tiles)
- allocate pages lazily
- keep free list of regions/slices
- enforce MB budget; evict LRU tiles

### 9.2 Buffer pools
- per-frame ring buffers for dynamic instance/text quads
- pooled staging buffers for large uploads
- avoid frequent allocation to reduce GC

---

## 10) Device lost recovery & tier downgrade

### 10.1 Recovery
```ts
device.lost.then(async info => {
  telemetry.logDeviceLost(info);
  const ok = await attemptReinit();
  if (!ok) downgradeTier();
});
```

### 10.2 Downgrade ladder
Tier A → Tier B → Tier C → Tier D

**Rule:** never loop upgrades rapidly. Use cooldown + remote config.

---

## 11) Minimal reference folder structure

```text
src/
  renderer/
    frameLoop.ts
    scheduler.ts
    tileCache.ts
    pipelineCache.ts
    bindGroupCache.ts
    resourceManager.ts
  transport/
    sab.ts
    message.ts
    codec.ts
  data/
    store.ts
    lod.ts
    envelope.ts
  text/
    msdf.ts
    fallbackCanvas.ts
```

---

## 12) Implementation checklist
- [ ] Build Tier B frame loop with interaction-first budgets
- [ ] Implement tile cache + reprojection before adding complex features
- [ ] Add bind group + pipeline caching early (avoid death by overhead)
- [ ] Add device lost recovery early (test with forced loss)
- [ ] Add perf harness and watch p95/p99 from day 1
