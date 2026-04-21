# Plan — Fix Drag Regression + Taskbar Icon (2026-01-26)

## Goal
Restore smooth, accurate pan/drag behavior (candles move 1:1 with grid; no “zoom‑out snap” at drag start) and make the Quantlab taskbar icon reliable in dev mode.

---

## 1) Chart Drag Regression — Diagnose & Fix

### A. Reproduce + Capture (must be deterministic)
- Repro in a minimal chart: 1 main pane, no indicators, stable dataset (e.g., fixed OHLC sample).
- Record 3 behaviors:
  1) Initial drag frame: does visible range change or only pan overscroll?
  2) During drag: does `xScale.getVisibleRange()` move each frame?
  3) On drag end: does visible range “snap back” or normalize?

### B. Instrumentation (temporary diagnostics)
Add a lightweight debug overlay or console logs for these values **per frame while dragging**:
- `range.from / range.to` (xScale visible range)
- `panOverscrollPx`, `panOverscrollRaw`
- `panActive`, `elasticActive`, `panBaseRange`
- `rangeChanged` and `overscrollChanged` from `applyPanIntent`
- `plotRect.width` and `timeSpan`
- `barWidthRange` and `barPlotWidth` used in `renderSeriesToContext`

Expected signals:
- **Healthy pan:** `rangeChanged = true` each frame, overscroll ~0 unless at bounds.
- **Broken pan:** `rangeChanged = false`, overscroll non‑zero → grid moves but series sticks or compresses.

### C. Isolation Matrix (binary toggles)
Test each change independently to identify the regression source:
1) **Pan overscroll / elastic return**
   - Temporarily disable overscroll for pointer pan.
   - Observe if “zoom‑out snap” disappears.
2) **Frame budget series skipping**
   - Force `renderSeries()` during interaction (if not already).
   - Validate candles move continuously.
3) **TickCoordinator caching**
   - Force regenerate ticks on pan start.
   - Ensure X labels still correct but verify no side‑effect on series.
4) **Coordinate stabilization**
   - Temporarily bypass stabilizer during pan only for underlay *and* series layers.
   - Watch for aliasing/jitter vs. frozen movement.

### D. Likely Root Causes (based on symptoms)
- **Range not updating on initial drag:** pan logic enters overscroll branch with `rangeChanged = false` → grid shifts, series appears “stuck.”
- **Wrong visible range for series width:** bar width or range mismatch causes instant “zoom‑out to point” (candles compressed left, empty right).
- **Pan cache / render order mismatch:** series reuses old range while underlay uses live pan offset.

### E. Targeted Fix Strategy (pick the minimal change that corrects behavior)
1) **Ensure range changes on drag**
   - In `applyPanIntent`, if the pan is within bounds, guarantee `xScale.panByPixels()` runs and returns `rangeChanged = true`.
   - Only allow overscroll to dominate when strictly beyond bounds.
2) **Align series + grid state**
   - If `panOverscrollPx` is non‑zero, ensure *both* underlay and series use the same `panOffset` and **same visible range snapshot**.
3) **Stabilize pan start**
   - Prevent any auto‑fit or auto‑scroll from firing during pointer pan start (no `fitToData` or `syncTimeScaleToData` while dragging).
4) **Reduce snap artifact**
   - If “snap zoom‑out” is caused by cached bar width, recompute bar width from current visible span each drag frame.

### F. Acceptance Checks
- No initial “zoom‑out snap” when starting drag.
- Candles move smoothly and proportionally with grid at all times.
- After drag end, visible range remains consistent (no snap‑back).
- Behavior consistent at full‑screen and windowed widths.

---

## 2) Taskbar Icon Still Missing — Diagnose & Fix

### A. Verify Runtime WM_CLASS
- Use `xprop` or `wmctrl -lx` to read the running Quantlab window’s `WM_CLASS`.
- Record exact class value (case‑sensitive).

### B. Validate Desktop Entry
- Check `~/.local/share/applications/quantlab-dev.desktop`:
  - `Exec=` points to `scripts/code.sh` (or dev script) with correct `--user-data-dir`.
  - `Icon=` points to an absolute path for `resources/linux/quantlab.png`.
  - `StartupWMClass=` matches the runtime WM_CLASS.

### C. Fix Paths + Class Mismatch
- If WM_CLASS differs, update `.desktop` and dev launch script so **both** match.
- If icon file path moved, update `Icon=` to the new absolute path.

### D. Refresh Shell Caches
- Run `update-desktop-database ~/.local/share/applications`.
- Restart GNOME shell (if applicable) or log out/in to clear cached icons.

### E. Acceptance Checks
- Quantlab shows the correct icon in taskbar/dock after launch.
- Icon persists across restarts and rebuilds.

---

## Deliverables
- Minimal code changes that restore pan stability and prevent the “zoom‑out snap.”
- Corrected desktop entry + script with matching `StartupWMClass` and icon path.
- Verification notes + repro steps confirmed fixed.
