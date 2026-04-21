# Quantlab Improvements Plan (Merged + Tightened)

**Date:** 2026-01-25
**Objective:** Implement the most reliable fixes with minimal risk, anchored to specific code locations and explicit verification steps.

---

## Phase 0 — Instrumentation (Required, then remove)
**Purpose:** eliminate guesswork, resolve disputed assumptions.

**Where to add temporary logging (exact targets):**
- `extensions/quantlab/webview/chart/index.ts`
  - On webview mount + tab re‑activation:
    - log container size
    - log `document.visibilityState`
- `extensions/quantlab/webview/chart/chartApi.ts`
  - On `createChart()` and `applyVisualization()`:
    - log visible range and pane count
- `Charts/packages/chart-render-canvas2d/src/index.ts`
  - In scheduler frame function:
    - log flags per frame (underlay/series/overlay)
    - log `panActive`, `inertiaActive`, `panOverscrollPx`
- `Charts/packages/chart-render-canvas2d/src/tick-coordinator.ts`
  - log cache hit/miss + plotRect width

**Verification actions:**
- Fullscreen → tab away/back → check logs for resize + invalidation.
- Pan start/stop → ensure underlay + series render events occur.

**Exit criteria:** deterministic repro + evidence showing which layer is stale.

---

## Phase 1 — X‑Axis “Random Hours” on Fullscreen/Tab Switch
**Fix priority:** high. Low risk with webview‑level hooks.

**A. Webview visibility hook (preferred location)**
- Add in `extensions/quantlab/webview/chart/index.ts`:
  - `document.addEventListener('visibilitychange', ...)`
  - On `visible` → `requestAnimationFrame(() => chart.resize + chart.invalidateAll)`

**B. Tick cache invalidation on width change**
- Add in `Charts/packages/chart-render-canvas2d/src/tick-coordinator.ts`:
  - Track `lastPlotWidth` and invalidate caches if width delta > 10%.

**Acceptance:**
- X‑axis labels correct after tab switch and fullscreen without zoom.

---

## Phase 2 — Entry/Exit Levels Track During Drag
**Fix priority:** highest if verified.

**Verification step (explicit):**
- Add a temporary debug log in `buildPluginState()` to confirm Entry/Exit rendering path.
  - If Entry/Exit move with plugin overlays, proceed with plugin fix.

**If Entry/Exit are plugin overlays:**
- In `Charts/packages/chart-render-canvas2d/src/index.ts`:
  - Pass `panOverscrollPx` into `buildPluginState()`.
  - Ensure `timeToX` includes `+ panOverscrollPx`.

**If Entry/Exit are series markers:**
- Ensure marker render uses the same pan offset and that overlay invalidation triggers on every pan frame.

**Acceptance:**
- Entry/Exit markers/lines move continuously while panning/axis‑dragging.

---

## Phase 3 — Candlestick Jitter at Drag Start/End
**Fix only after evidence.**

**Minimal experiment (quick test):**
- Force underlay + series render for 2 frames after `beginPan()` and `endPan()`.
  - If jitter disappears → keep minimal fix.

**If jitter persists:**
- Instrument coordinate stabilizer transitions (`coordinate-stabilizer.ts`).
- If confirmed, add a 2–3 frame blend between snapped and raw coordinates.

**Acceptance:**
- No visible flicker when drag starts/ends.

---

## Phase 4 — Strategy Pane Stability + Toggle Button

**A. Stability (minimal change):**
- Preserve pane even if indicator series are empty.
- Store last pane height in webview state.

**B. Toggle button (explicit location):**
- Add to `extensions/quantlab/webview/chart/index.ts` toolbar:
  - New toggle button near timeframe controls.
  - On click: hide/show strategy pane + persist state.

**C. Fallback if no pane visibility API exists:**
- Hide pane by setting height to minimal + hide series.
- Restore stored height on show.

**Acceptance:**
- Strategy pane never disappears unless toggled.
- Toggle restores previous height.

---

## Phase 5 — Parameters Bottom Pane Optimization

**Specific improvements (explicit locations):**
- `extensions/quantlab/webview/chart/parameterPanel.ts`
  - Group parameters by `group`.
  - Add dirty state and Apply/Reset controls.
- `extensions/quantlab/webview/chart/chart.css`
  - Sticky footer for Apply/Reset.
  - Fixed label widths to prevent layout shifts.

**Acceptance:**
- Stable layout, clear groups, Apply only when dirty.

---

## Sequencing (Optimized)
1) Phase 0 (Instrumentation)
2) Phase 2 (Entry/Exit tracking)
3) Phase 1 (X‑axis bug)
4) Phase 4 (Strategy pane + toggle)
5) Phase 5 (Parameters pane)
6) Phase 3 (Jitter) – only after evidence

---

## Rollback Criteria
- If X‑axis fix reduces tick density or breaks labels, revert width‑invalidate logic.
- If Entry/Exit fix causes misalignment when not panning, revert and re‑instrument.
- If strategy pane toggle breaks layout state, revert to hide‑by‑series only.

---

## Deliverables
- Evidence logs (Phase 0) + clear root cause per issue.
- Minimal patch per phase.
- Regression checklist per change.

