# V6 Phase 0 — Canvas2D-Only Enforcement (Cursor Session)

**Goal:** Make it impossible for V6 runtime to select WebGPU/WebGL renderers.

---

## Why this phase exists
The current system includes a capability tier model (WebGPU worker, WebGPU main, WebGL2 future, Canvas2D fallback). For V6, we are intentionally shipping **Canvas2D only**.

This phase ensures:
- fewer dependencies
- smaller bundles
- fewer performance cliffs and driver variance
- simpler QA matrix

---

## Deliverables

### 1) Update tier detection
**File(s):**
- `packages/chart-core/src/tier-detection.ts`
- `packages/chart-core/src/renderer-factory.ts`

**Change:**
- Replace tier detection with a single capability: Canvas2D available.
- Remove references to `navigator.gpu`, WebGPU worker, WebGL2 checks.

**Implementation approach:**
- Option A (simplest): delete tier detection and return Canvas2D unconditionally.
- Option B (keep interface): `detectCapabilityTier()` always returns `'D'`.

Pick A unless something external depends on tier reporting.

---

### 2) Update renderer factory to never import WebGPU/WebGL packages
**Change:**
- Ensure `createRenderer()` does not `import` WebGPU classes (even conditionally).
- If the WebGPU package must remain in the repo, it must not be reachable from the default build graph.

**Note:** This is critical for tree-shaking. Even conditional imports can retain code depending on bundler behavior.

---

### 3) Update public exports to align with Canvas2D-only
**File(s):**
- `packages/chart/src/...` (public API wrapper)
- root `exports` map if any

**Change:**
- The default `createChart` should resolve to Canvas2D renderer only.

---

### 4) Add tests
**Test file:** `packages/chart-core/src/__tests__/renderer-factory.test.ts` (or repo convention)

**Cases:**
1. `createRenderer()` returns Canvas2D renderer in normal environment.
2. If test environment provides a fake `navigator.gpu`, renderer is still Canvas2D.

---

## Definition of Done checklist
- [ ] Running demo still works
- [ ] `pnpm test` passes
- [ ] perf harness still passes
- [ ] build output has no WebGPU imports in the default bundle

---

## Acceptance note
This phase should be **purely architectural**. No changes to rendering output, interaction feel, or perf targets—just removal of renderer selection complexity.
