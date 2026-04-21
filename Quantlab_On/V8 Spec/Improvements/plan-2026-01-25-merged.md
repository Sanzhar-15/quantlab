# Quantlab Improvements Plan (Merged, Optimal)

**Date:** 2026-01-25
**Goal:** Combine the strongest parts of both plans: precise root-cause hypotheses + rigorous verification + minimal-risk implementation sequencing.

## Principles
- Verify before refactor: instrument first, then fix.
- Prefer localized fixes over new core APIs.
- Keep chart-core changes minimal and gated (DOM‑safe).
- Every change must have a concrete repro + acceptance criteria.

---

## Phase 0 — Repro + Instrumentation (Non‑Negotiable)
**Why:** Prevents chasing wrong layer; resolves disputed assumptions.

**Add temporary diagnostics (remove later):**
- **Visibility + size**: Log `plotRect`, `container size`, `visibleRange`, tick count on:
  - tab activation
  - resize
  - chart render/layout invalidations
- **Render pipeline**: Track underlay/series/overlay render counts per second.
- **Pan state**: Log `panActive`, `inertiaActive`, `panOverscrollPx`.
- **Tick cache**: Log `tickCoordinator cache hit/miss` and span/width deltas.

**Repro checklist:**
1) Fullscreen → switch away and back to chart → X‑axis labels.
2) Drag chart + axes with Entry/Exit visible → verify tracking.
3) Quick pan start/stop → candlestick jitter.
4) Strategy pane appears/disappears after indicator refresh.

**Exit criterion:** Deterministic repro + logs that reveal the *exact* invalidation or offset issue.

---

## Phase 1 — X‑Axis “Random Hours” in Fullscreen/Tab Switch
**Hypothesis (validated):** stale tick cache + hidden‑tab sizing.

**Implementation steps (minimal risk first):**
1) **Webview activation hook (preferred):**
   - On tab visibility restore, schedule a resize + full invalidate (next animation frame).
   - If `ResizeObserver` doesn’t fire on visibility change, force it.
2) **Tick cache invalidation on width change:**
   - Track last `plotRect.width`; invalidate ticks when width delta exceeds threshold (e.g., 10%).
3) **(Optional) DOM visibility handler in renderer:**
   - Only if webview‑level fix insufficient.
   - Must be guarded for DOM presence.

**Acceptance:**
- After tab switch or fullscreen, X‑axis labels are correct without zoom.

---

## Phase 2 — Entry/Exit Levels Lag During Drag
**Primary hypothesis:** overscroll offset missing from rendering path for Entry/Exit.

**Verification first:**
- Confirm whether Entry/Exit levels are rendered via **drawing plugin state** or **series markers**.

**If drawing plugin state:**
- Pass `panOverscrollPx` into `timeToX` for plugin render state.
- Ensure overlay invalidation occurs every drag frame.

**If series markers:**
- Verify marker rendering uses same pan offset as series layer.
- Ensure marker layer invalidation on pan is not suppressed.

**Acceptance:**
- Entry/Exit markers/lines remain locked to candles during drag and axis zoom.

---

## Phase 3 — Candlestick Jitter at Drag Start/End
**Do not refactor until root cause is measured.**

**Likely sources (test with instrumentation):**
- Coordinate stabilizer snapping mode transition.
- Frame budget skipping at pan start/end.
- Inconsistent invalidation between series/underlay on the first/last pan frame.

**Measured fixes (choose based on evidence):**
- If stabilizer causes jumps: add a 2–3 frame blend between snapped and raw.
- If invalidation timing is mismatched: force underlay + series render for first/last pan frame.
- If frame budget skips: temporarily boost priority or lower budget sensitivity during first/last pan frame.

**Acceptance:**
- No blink/jump at pan start or pan end.

---

## Phase 4 — Strategy Pane Stability + Toggle Button
**Clarify pane type:**
- Strategy pane == indicator pane in chart renderer (likely).
- Parameter pane == separate bottom UI (handled in Phase 5).

**Stability fixes (minimal change):**
- Preserve pane even if indicator series temporarily empty.
- Store last pane height; restore on re‑show.
- Avoid auto‑remove on empty series unless explicitly toggled off.

**Toggle button (top panel):**
- Add a compact toggle near timeframe controls.
- Implement as a **webview‑level** state first (hide pane, store height).
- Only add core API if no existing pane visibility mechanisms are adequate.

**Acceptance:**
- Strategy pane never disappears unexpectedly.
- Toggle reliably hides/shows and restores height across sessions.

---

## Phase 5 — Parameters Bottom Pane Optimization
**Low risk; can be parallel once Phase 1–2 stable.**

**Improvements:**
- Group parameters (e.g., “Risk”, “Execution”, “Indicators”).
- Collapsible groups.
- Sticky Apply/Reset footer.
- Fixed label widths to prevent layout shift.
- Debounce or “apply‑only” to reduce heavy redraws.

**Acceptance:**
- No jitter; clear grouping; Apply only when dirty.

---

## Sequencing (Optimized)
1) Phase 0 (Instrument) — required.
2) Phase 2 (Entry/Exit) — likely surgical fix, high impact.
3) Phase 1 (X‑axis) — low risk, visible bug.
4) Phase 4 (Strategy pane + toggle).
5) Phase 5 (Parameters pane).
6) Phase 3 (Jitter) — only after measuring root cause.

---

## Deliverables
- Measured root cause per issue with evidence.
- Minimal patch per phase.
- Regression checklist for each fix.

