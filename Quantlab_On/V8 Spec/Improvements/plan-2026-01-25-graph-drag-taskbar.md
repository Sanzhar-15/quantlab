# Plan — Chart Drag Instability + Taskbar Icon Regression (2026-01-25)

## Goal
Stabilize chart drag behavior (series should track grid smoothly during pan/axis drag) and restore the Quantlab taskbar icon in dev mode.

---

## 1) Chart Drag Instability — Diagnose & Fix

### A. Reproduce + Capture
- Reproduce the drag issue in the latest build and record:
  - Does the candle series freeze while grid moves? Does it “zoom out to a point” during drag?
  - Is the issue tied to horizontal pan only, vertical axis drag, or both?
  - Does it happen with/without indicators? (main pane only vs. strategy pane active)
- Enable debug tracing temporarily:
  - Log visible range (`xScale.getVisibleRange()`), `panOverscrollPx`, and `renderQualityLevel` per frame while dragging.
  - Log whether the series layer renders each frame (to confirm “grid-only” renders).

### B. Likely Regression Sources (based on recent changes)
1. **Pan/series coherence forcing** (`forceCoherentFrames`): may be causing stale series cache or repeated invalidation loops.
2. **Plugin transform change**: `timeToX/xToTime` now includes `panOffset`, but other parts may still assume raw `xScale.timeToX` offsets.
3. **Pan-layer/series-layer interaction**: when pan cache is used, series is drawn via cached blit; if cache invalidation timing is off, series can appear “stuck.”
4. **Rendering frequency vs. frame budget**: removing “skip markers during pan” + forcing overlay might be starving series renders.

### C. Isolation Steps
- Temporarily disable (one at a time) and retest:
  1) `forceCoherentFrames` mechanism (leave pan markers enabled).
  2) `panOffset` application in plugin state (`timeToX/xToTime`) and pointer conversion.
  3) Marker rendering during pan.
- Compare behavior with previous “good” build to identify which delta introduced the instability.

### D. Targeted Fix Strategy
- If **series rendering is skipped during pan**: ensure series invalidation always includes `InvalidationFlag.Series` on pan updates and that `FrameScheduler` isn’t skipping it due to budget.
- If **pan cache blit is misaligned**: inspect `panOverscrollPx` usage in `renderSeriesToContext` and confirm cache base range aligns with visible range.
- If **plugin state offset is incorrect**: only apply `panOffset` to plugin-space transforms, not core series calculations; ensure pointer conversion uses the same coordinate space.
- If **overlay work is starving series**: throttle overlay or marker rendering during pan (e.g., every other frame) while keeping marker position smooth.

### E. Acceptance Checks
- Candles move continuously during pan; no “zoom-to-point” behavior.
- Grid and series move together without desync.
- Axis drag maintains smooth motion; markers track live.

---

## 2) Taskbar Icon Regression — Diagnose & Fix

### A. Verify Dev Desktop Entry
- Check `~/.local/share/applications/quantlab-dev.desktop`:
  - `Icon=` path exists and points to `resources/linux/quantlab.png` (or another valid icon path).
  - `Exec=` points to the current dev launch script and has the correct `--user-data-dir`.
- Confirm `CHROME_DESKTOP=quantlab-dev.desktop` is set (script already sets this in dev mode).

### B. Likely Regression Sources
- Desktop entry removed or overwritten (user cleanup, reinstall, or post-build script changes).
- Icon file path moved/renamed or missing from build output.
- GNOME/Wayland cache stale.

### C. Fix Strategy
- Recreate and install the dev desktop entry (reuse `scripts/install-dev-desktop.sh`).
- Ensure `resources/linux/quantlab.png` exists and is referenced by absolute path in the `.desktop` file.
- Refresh desktop database and icon cache:
  - `update-desktop-database ~/.local/share/applications`
  - Restart shell (or `killall -3 gnome-shell` on GNOME if needed).

### D. Acceptance Checks
- Quantlab icon appears in taskbar/dock after launch.
- Icon persists across restarts and rebuilds.

---

## Deliverables
- Code changes to restore stable pan behavior.
- Updated (or regenerated) dev desktop entry if needed.
- Short verification notes after fixes applied.
