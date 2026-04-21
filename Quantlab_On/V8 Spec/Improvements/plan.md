# Quantlab Improvements Plan (No Code Changes Yet)

## Scope
Focus only on optimizing and validating what already exists:
- RHS view buttons (Chart/Action/Trade/Editor) behavior and state styling
- Taskbar icon not showing (Linux dev run)
- Chart drag rendering (axes/gridlines during drag)
- Strategy pane layout and grid/axis quality
- Overall code-quality and implementation optimality for already‑implemented features

## Guiding Principles
- Avoid new features; improve correctness, performance, and UX of existing behavior
- Minimize architectural change; prefer targeted fixes with clear ownership
- Ensure changes are testable, measurable, and reversible

---

## 1) Validate Current Implementations (Baseline Audit)
**Goal:** Confirm that the existing changes are correct and identify any regressions or weak spots.

### A) RHS Button State System
- **Files to review**
  - `src/vs/workbench/browser/parts/editor/quantlabContextKeys.ts`
  - `src/vs/workbench/browser/parts/editor/quantlabViewStateService.ts`
  - `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`
  - `src/vs/workbench/browser/parts/editor/singleEditorTabsControl.ts`
  - `src/vs/workbench/browser/parts/editor/media/*.css`
- **Checks**
  - Verify current view detection is driven by `CustomEditorInput.viewType` only
  - Ensure view switches update context keys in all editor layouts (single/multi tabs)
  - Confirm CSS state/hover/active styles are consistent before and after switching
  - Confirm when switching to Chart/Action/Trade the Editor button replaces the active view button as intended

### B) Split Editor Toolbar Regression Check
- **Files to review**
  - `src/vs/workbench/browser/parts/editor/editor.contribution.ts`
- **Checks**
  - Ensure the Editor Title toolbar contains Split and Toggle Layout actions
  - Verify command availability in normal and compact modes

### C) Taskbar Icon (Linux)
- **Files to review**
  - `src/vs/code/electron-main/main.ts`
  - `src/vs/code/electron-main/app.ts`
  - `resources/linux/code.desktop` (or Quantlab equivalent)
  - `product.json`
- **Checks**
  - Confirm WM_CLASS is set early (before window creation)
  - Confirm `StartupWMClass` (desktop file) matches WM_CLASS
  - Confirm the desktop icon path and name match Quantlab
  - Verify the exec name in `code.desktop`/desktop entry uses Quantlab

### Deliverable from Audit
- A short checklist of items that are already optimal vs. those needing change

---

## 2) Taskbar Icon Fix (Linux)
**Goal:** Ensure Quantlab icon appears in the taskbar for dev runs and packaged builds.

### Investigation Steps
1. Validate WM_CLASS is set **before** `BrowserWindow` creation.
2. Verify `StartupWMClass` in `resources/linux/code.desktop` matches `product.json` naming.
3. Confirm icon paths in Linux resources point to Quantlab assets.

### Likely Fix Path
- Adjust WM_CLASS set-up in the earliest initialization point
- Ensure desktop entry values align with `product.json.applicationName`
- Verify `resources/linux/quantlab.png` is referenced where needed

### Success Criteria
- Taskbar icon consistently shows on GNOME/Wayland/X11 dev runs

---

## 3) Chart Drag Rendering (Axes/Gridlines During Drag)
**Goal:** Axes/gridlines update continuously during drag, not only on mouse release.

### Investigation Steps
- Locate chart rendering implementation in Quantlab extension:
  - Likely `extensions/quantlab` webview source (JS/TS) and/or charting library integration
- Identify current drag events (`mousemove`/`pointermove`) and rendering schedule
- Verify whether layout/rendering is gated by debounce or mouseup

### Likely Root Causes
- Rendering tied to `mouseup` or throttled too aggressively
- Drag handling uses stale chart layout state until drag ends
- Grid/axis layers updated in a different pass than plot layer

### Optimization Approach (Plan Only)
- Move axis/grid updates into the same animation/tick loop as drag updates
- Use `requestAnimationFrame` for continuous redraw during drag
- If the chart library supports “live drag” rendering, enable it
- Avoid expensive re-layout per drag tick; cache axis metrics and only update dirty ranges

### Success Criteria
- During drag, gridlines and both axes stay visually correct and continuous

---

## 4) Strategy Pane Optimization (Bottom Pane)
**Goal:** Improve visual separation and y-axis/gridline readability without changing the overall feature set.

### Investigation Steps
- Locate strategy pane rendering/layout file(s) in Quantlab extension
- Identify y-axis placement and gridline drawing logic

### Proposed Enhancements (Plan Only)
- Move **strategy pane y‑axis to RHS** (consistent with main chart UX)
- Add stronger visual separation between main chart and strategy pane:
  - Slight divider line or padding adjustment
- Optimize **horizontal** gridlines for strategy pane:
  - Tune density and opacity for lower-height pane
  - Keep vertical gridlines unchanged (per request)

### Success Criteria
- Strategy pane is legible, clearly separated, and axis/gridlines are visually consistent

---

## 5) Code-Quality/Architecture Review
**Goal:** Ensure current implementation is robust and maintainable.

### Audit Checklist
- No unused services or context keys
- No unreachable or unused code paths
- Avoid duplicated logic across tab controls (extract shared helpers if needed)
- Ensure CSS classes and context keys are consistent
- Verify the Open‑As‑View workflow uses correct override type and does not regress editor behavior

### Output
- Targeted refactor list (if any)
- No new features beyond what already exists

---

## 6) Validation Plan (Post-Change)
**Note:** For execution later, not now.

- Manual checks:
  - Taskbar icon visibility
  - RHS buttons show correct “swap” behavior and colors
  - Chart drag shows grid/axes continuously
  - Strategy pane layout clarity
- Optional profiling:
  - Confirm drag rendering doesn’t introduce lag or high CPU

---

## Next Step After Approval
- Proceed to implement changes in small, testable commits
- Provide a concise test checklist for you to verify in Quantlab
