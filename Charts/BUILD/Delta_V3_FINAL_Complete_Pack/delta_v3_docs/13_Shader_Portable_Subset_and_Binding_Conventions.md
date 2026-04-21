# Shader Portable Subset & Binding Conventions (V3 Add‑On)
**Purpose:** Define strict rules for writing WGSL so it can:
- run efficiently in WebGPU (Tier A/B)
- optionally translate to GLSL ES 3.0 for WebGL2 (Tier C)
- keep shaders maintainable and debuggable

This doc is a **policy**: it constrains shader authors so the codebase does not fragment.

---

## 0) Canonical stance
- **WGSL is the source of truth.**
- Tier C is optional but supported: we aim for a portable subset where feasible.
- If a shader cannot be made portable, it must be clearly marked:
  - `@tier WebGPU_ONLY` and have a Tier C fallback path.

---

## 1) Binding model conventions (portable-friendly)

### 1.1 Bind group layout conventions
We standardize bind group indices by pass:

- Group 0: global state
  - camera uniform
  - theme uniform
  - time/price scale constants
- Group 1: pass-specific resources
  - series instance buffers
  - tile textures + samplers
  - MSDF atlas + sampler
- Group 2: optional extras
  - debug textures
  - lookup tables

### 1.2 Samplers & textures
Portable rule:
- prefer explicit `texture_2d<f32>` + `sampler`
- keep sampling modes simple (linear/nearest; clamp)
- avoid uncommon sampler features until proven portable

### 1.3 Storage buffers
- Keep storage buffer structs aligned to 16 bytes.
- Avoid nested arrays-of-structs that are hard to translate.
- Use SoA layouts for large data (better cache and easier translation).

---

## 2) WGSL coding rules (portable subset)

### 2.1 Disallowed or restricted constructs (Tier C target)
- advanced texture formats that lack WebGL2 equivalents
- storage textures in fragment stage (unless Tier A/B only)
- non-uniform control flow that depends on derivatives (careful with MSDF)
- dynamic indexing into arrays of resources (depends on translation)

### 2.2 Allowed constructs (recommended)
- basic arithmetic, vec/mat ops
- simple loops with compile-time bounds where possible
- structs with scalar/vec fields
- `@builtin(position)` and standard vertex/fragment pipeline IO

### 2.3 Precision practices
- Use float32-friendly normalization:
  - time: origin + relative offset
  - price: base + scale
- Keep values within reasonable ranges to avoid precision loss.

---

## 3) Pass-specific conventions

### 3.1 Candles shader
- Instance record is 32 bytes aligned.
- Vertex expands geometry; fragment applies style flags.
- Avoid branching per-pixel for minor style differences; prefer flags and simple math.

### 3.2 Grid shader (analytic)
- Fullscreen quad; compute line intensity analytically.
- Use `fwidth()`/derivatives carefully and consistently.

### 3.3 MSDF shader
- Keep MSDF code isolated in one module.
- Provide quality knobs:
  - sharpness
  - gamma
  - threshold
- Ensure MSDF shader remains stable under translation or mark as WebGPU-only and supply Tier C alternative (bitmap glyphs).

---

## 4) Debuggability requirements
- Label all pipelines and bind groups in debug builds.
- Provide a `DEBUG` uniform to enable:
  - tile bounds visualization
  - overdraw heatmap (optional)
  - stage display (0/1/2)

---

## 5) Build pipeline rules
- Shaders must compile in CI for all enabled tiers.
- Provide a “shader lint” step:
  - checks alignment rules
  - checks banned features
  - checks group/binding conventions

---

## 6) Checklist for new shaders
- [ ] Does it obey group/binding conventions?
- [ ] Is it within portable subset? If not, mark WebGPU-only.
- [ ] Are buffer structs aligned?
- [ ] Are value ranges normalized for float32?
- [ ] Are debug labels and toggles in place?
