# WebGPU Render Graph and Passes (V3)
**Goal:** define passes, pipelines, bind groups, and buffer layouts for Tier A/B.

---

## 1) Preferred canvas format + color management
- Use `navigator.gpu.getPreferredCanvasFormat()` for the swapchain.
- Treat all authored colors as sRGB; be explicit about conversions if using linear math in shaders.
- Keep blending rules consistent across passes to avoid “halo” artifacts.

---

## 2) Render graph overview (Tier A/B)

Pass order:
1. Clear/Background
2. Grid (analytic shader)
3. Series (candles / line / area)
4. Overlays (markers / drawings static)
5. Text (MSDF lane + fallback composite)
6. Interaction overlay (crosshair, selection) — always last, always cheap
7. Present/Blit

Optional:
- MSAA resolve for select passes
- Post pass (very subtle) only if proven useful

---

## 3) Common uniform/state buffers

### 3.1 CameraUniform (per pane)
```wgsl
struct CameraUniform {
  // world->screen mapping
  timeOrigin: f32;
  timeScale: f32;
  priceOrigin: f32;
  priceScale: f32;

  // screen sizes
  screenW: f32;
  screenH: f32;
  dpr: f32;
  _pad: f32;
};
```

### 3.2 ThemeUniform
Keep small. Pack colors as `vec4<f32>` or `u32` ABGR packed.

---

## 4) Series pipelines

### 4.1 Candles (instanced)
Instance buffer layout (recommended; 32 bytes aligned):
- `x: f32` (screen-space x or time-relative)
- `o: f32`
- `h: f32`
- `l: f32`
- `c: f32`
- `flags: u32` (color/up/down/highlight bits)
- `pad: u32`

Option: store ohlc as price-relative and apply scale in shader.

Vertex shader expands to wick/body quads.
Fragment shader applies:
- base color (up/down)
- optional highlight style for hovered/selected

### 4.2 Lines
Baseline approach:
- build polyline segments into a vertex buffer with per-segment data
- render as screen-space quads
- fragment shader computes distance to segment for AA edge

---

## 5) Grid pass (analytic)
- Draw a single quad (two triangles) covering pane.
- Fragment shader computes grid lines given tick spacing.
- Support theme variations:
  - major/minor grid
  - dotted vs solid (optional)

---

## 6) Text pass (MSDF lane)
- Glyph atlas is a sampled texture.
- Vertex buffer for glyph quads:
  - xy position in screen pixels
  - uv coords in atlas
  - color
- Fragment shader samples MSDF, computes median, and uses derivatives for crisp edges.

Text stability rules (implemented on CPU):
- baseline snapping
- label hysteresis

---

## 7) Interaction overlay pass
- Crosshair lines + highlight marker
- Tooltip background (rect) and text handled either via text system or separate UI layer

Rules:
- This pass must be extremely cheap.
- Avoid any expensive resource transitions or pipeline switches.

---

## 8) Render bundles
Use render bundles for:
- static grid when unchanged
- static historical geometry segments (if caching is beneficial)
Avoid bundling rapidly changing content.

---

## 9) Command encoding strategy
- Encode passes in consistent order.
- Minimize pipeline/bind group changes via batching:
  - batch series draws by pipeline
  - group per-pane passes
- Keep a “frame allocator” to reuse encoder-related objects and avoid GC churn.

---

## 10) GPU synchronization rules
- Avoid `mapAsync` in hot paths.
- Prefer `queue.writeBuffer` for small updates.
- For large uploads:
  - use staging buffers and copy, but schedule outside interaction-critical frames.
