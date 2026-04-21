# Quantlab Phase 0 Feasibility Spike - Full Implementation Plan

Version: 2.0
Owner: Quantlab PM/Eng
Timebox: 3-5 days
Goal: Validate extension vs fork feasibility for V8.1-critical UX elements and lock the Phase 1 architecture boundary.

## References (Source of Truth)
- Quantlab V8.1 UI/UX Spec: `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`
- General implementation plan: `Quantlab_On/General_Implementation_plan/Quantlab_Implementation.md`
- Deeper Phase 0 plan: `Quantlab_On/Deeper_implementation_plan/Phase_0_Feasibility_Spike.md`
- Charting engine and docs (Phase 3+): `Charts/`

Note: The path `/home/s/quantlab/Complete_spec/Start_antigravity` was not present in this repo. Phase 0 uses the V8.1 spec in `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`.

## Phase 0 Objectives
1. Prove or disprove that V8.1 tab UI elements can be implemented via extension APIs.
2. Prove that view switching can be done in-place per tab (same tab identity).
3. Establish a reliable per-tab instance identity strategy for multiple tabs of the same file.
4. Validate persistent per-tab view state across reloads.
5. Determine macOS keybinding feasibility for the Ctrl+Q (Cmd+Q) prefix.
6. Produce a concrete, file-level fork patch list or confirm extension-only feasibility.

## Non-Negotiable V8.1 Requirements to Validate
- View buttons appear on the right side of the tab bar and replace layout buttons (Spec 2.3.2).
- Tab indicator stripe is a 3px left border with view color (Spec 2.3.4, 6.5, 8.1).
- View switching is in-place per active tab (Spec 3.2).
- "Open as [View]" creates independent tab state for same file (Spec 3.3.2).
- Global Symbol/Timeframe selectors and History button live in window chrome (Spec 2.2.2, 2.2.3).
- All Quantlab shortcuts use Ctrl+Q prefix and do not conflict with VS Code defaults (Spec 7).

## Scope
In scope:
- Spikes 0.1 to 0.7 from the deeper plan (extension-first attempts + fallback patch analysis).
- Architecture boundary decision (thin fork vs extension).
- Temporary spike code only; no production feature development.

Out of scope:
- Chart, Action, Trade feature UIs (beyond basic spike webviews).
- Engine integration or data pipelines.
- Full automation or unit testing (manual validation only).

## Deliverables
1. `quantlab-extension/docs/FEASIBILITY_REPORT.md` with pass/fail per spike and patch list.
2. Temporary spike code under `quantlab-extension/src/spike/` (removed after Phase 0).
3. Decision log: extension vs fork boundary and macOS keybinding decision.

## Success Criteria (Exit Gates)
- At least one in-place view switching approach is demonstrated (even if hacky).
- Per-tab instance identity works for multiple tabs of the same file.
- Per-tab view state persists across reloads.
- Fork patch list is documented with exact file paths and rationale.
- macOS keybinding decision is made and documented.

## Implementation Strategy
- Extension-first for each spike.
- If extension APIs fail, identify the minimal workbench patch target and the smallest viable change.
- Use throwaway spike code and capture all results in the feasibility report.

## Phase 0 Work Plan

### 0.0 Setup and Scaffolding (Day 0)
Objective: Create a minimal extension shell to host spikes and logging.

Spec references: V8.1 overall; no UI behavior validation yet.

Steps:
1. Confirm the Quantlab VS Code fork builds and launches.
2. Decide the extension location:
   - Option A: repo root `quantlab-extension/` (preferred for isolation).
   - Option B: `extensions/quantlab/` (if we want to ship as built-in).
3. Scaffold extension structure:
   - `quantlab-extension/src/extension.ts`
   - `quantlab-extension/src/spike/` (spike modules)
   - `quantlab-extension/docs/FEASIBILITY_REPORT.md` (skeleton)
4. Add an OutputChannel named "Quantlab Spike" and a helper logger.
5. Add a single activation event for development (ex: `onStartupFinished` or a dedicated command).

Artifacts:
- `quantlab-extension/src/extension.ts`
- `quantlab-extension/src/spike/` (empty placeholder modules)
- `quantlab-extension/docs/FEASIBILITY_REPORT.md` (template)

Validation:
- Extension loads in the fork.
- Running a spike command writes to the output channel.

Decision:
- Confirm extension location and update all subsequent paths accordingly.

### 0.1 View Button Placement
Objective: Verify if view buttons can live at the right side of the tab bar.

Spec references:
- 2.3.2 View Buttons Position
- 2.3.3 View Buttons Appearance

Approach (extension-first):
1. Contribute commands: chart, action, trade.
2. Contribute `contributes.menus["editor/title"]` entries with `group` ordering.
3. Filter on `.py` using `resourceExtname == .py`.

Validation checklist:
- Buttons appear for `.py` tabs only.
- Buttons are placed in tab bar right side, not in editor title area.
- Buttons trigger commands.

If fail:
- Document patch target(s):
  - `src/vs/workbench/browser/parts/editor/editorTabsControl.ts`
  - `src/vs/workbench/browser/parts/editor/editorTitleBarControl.ts`

Artifacts:
- `quantlab-extension/src/spike/viewButtonTest.ts`
- Feasibility report entry with pass/fail and patch candidate.

### 0.2 Tab Indicator Stripe Styling
Objective: Determine feasibility of per-tab 3px left stripe via extension APIs.

Spec references:
- 2.3.4 Tab Indicator Stripe
- 6.5 Tab Indicator Colors
- 8.1 View Indicators

Approach (extension-first):
1. Test `FileDecorationProvider` as a visual fallback.
2. Attempt CSS injection (expected to fail; record outcome).

Validation checklist:
- Stripe (or any tab-level indicator) is visible in the tab bar.
- Indicator reflects view state (chart/action/trade).
- Works across multiple tabs of the same file.

If fail:
- Document patch target(s):
  - CSS: `src/vs/workbench/browser/parts/editor/media/tabstitlecontrol.css`
  - TS: `src/vs/workbench/browser/parts/editor/tabsTitleControl.ts` (set data attribute for view).

Artifacts:
- `quantlab-extension/src/spike/tabStripeTest.ts`
- Feasibility report entry with patch plan and exact selectors.

### 0.3 In-Place View Switching
Objective: Find a compliant method for in-place view switching within a single tab.

Spec references:
- 3.2 View Switching
- 3.3.2 Open as [View] Behavior

Approach options to test:
- A: CustomTextEditorProvider (single tab, webview content).
- B: Workbench patch to swap editor pane while preserving tab identity (native Monaco).
- C: Webview overlay (likely non-compliant; test only to confirm).

Validation checklist:
- Switch Editor -> Chart -> Editor within the same tab.
- No new tab creation, no tab flicker.
- View state retained when switching back.
- If possible, native Monaco remains intact in Editor view.

Decision criteria:
- Compliance with in-place switching requirement.
- Preservation of native Monaco (preferred).
- Acceptable complexity and maintenance cost.

If extension approach fails:
- Document patch target(s):
  - `src/vs/workbench/browser/parts/editor/editorPanes.ts`
  - `src/vs/workbench/browser/parts/editor/editorService.ts` (if needed)

Artifacts:
- `quantlab-extension/src/spike/viewSwitchTest.ts`
- Feasibility report entry with chosen approach and tradeoffs.

### 0.4 Window Chrome Elements
Objective: Verify if Symbol/Timeframe selectors and History button can live in the title bar.

Spec references:
- 2.2.2 Global Symbol/Timeframe Selector
- 2.2.3 History Button

Approach (extension-first):
1. Baseline: StatusBarItem prototype for symbol, timeframe, history.
2. Confirm no supported extension API for title bar injection.

Validation checklist:
- Controls appear in title bar (center-right / right).
- Dropdowns open and update state.

If fail:
- Document patch target(s):
  - `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`
  - `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css`

Artifacts:
- `quantlab-extension/src/spike/windowChromeTest.ts`
- Feasibility report entry with pass/fail and fallback recommendation.

### 0.5 macOS Ctrl+Q / Cmd+Q Keybinding Feasibility
Objective: Validate the Ctrl+Q prefix across OSes and document macOS behavior.

Spec references:
- 7 Keyboard Shortcuts (especially 7.1)

Approach:
1. Test Ctrl+Q prefix on Windows and Linux.
2. Test Cmd+Q prefix on macOS (spec says it must be intercepted).
3. Test Ctrl+Q on macOS as a fallback.
4. Identify collisions with standard VS Code keybindings.

Validation checklist:
- Ctrl+Q prefix works on Windows and Linux.
- Cmd+Q prefix is interceptable on macOS (or not).
- No collisions with default bindings.

Decision:
- If Cmd+Q cannot be intercepted, document deviation proposal and fallback (e.g., Ctrl+K Q).

Artifacts:
- `quantlab-extension/src/spike/keybindingTest.ts`
- Feasibility report entry with macOS decision.

### 0.6 Tab Instance Identity
Objective: Establish a stable per-tab instance identity for same-file multi-tab usage.

Spec references:
- 3.3.2 Open as [View] Behavior
- 2.7.2 View State Per Tab

Approach:
1. Inspect `vscode.window.tabGroups` and `TabInputText`.
2. Evaluate candidate identity strategies:
   - URI + group index + tab index (unstable when reordering).
   - URI + view type + open timestamp (stable within session, weak across restart).
   - Custom editor route (if used) with internal mapping.
3. Determine whether a fork patch is needed to expose a stable tab ID.

Validation checklist:
- Open same file twice, confirm distinct IDs.
- Reorder tabs and ensure IDs remain stable (if possible).
- Close one tab, confirm other remains intact.

If fail:
- Document patch target to expose stable tab IDs from workbench internals.

Artifacts:
- `quantlab-extension/src/spike/tabInstanceTest.ts`
- Feasibility report entry with chosen identity scheme.

### 0.7 Tab View State Persistence
Objective: Verify per-tab view state persists across reloads and restarts.

Spec references:
- 2.7.2 View State Per Tab

Approach:
1. Store per-tab state in `workspaceState` keyed by tab instance ID.
2. Restore on activation.
3. Handle cleanup when tabs close.

Validation checklist:
- State persists across Reload Window.
- State persists across full restart.
- Multiple tabs of the same file restore independently.
- Closed tab state is removed.

Artifacts:
- `quantlab-extension/src/spike/statePersistenceTest.ts`
- Feasibility report entry with pass/fail.

### 0.8 Optional: Chart Webview Smoke Test (If Time Permits)
Objective: Confirm the charting package can render inside a VS Code webview.

Spec reference:
- 3.1.2 Chart View (rendering viability)

Approach:
1. Create a webview that loads a bundled chart demo from `Charts/`.
2. Use static OHLCV data.
3. Validate basic render and interaction.

Validation checklist:
- Webview renders without CSP errors.
- Basic pan/zoom works.

Artifacts:
- `quantlab-extension/src/spike/chartWebviewTest.ts`
- Feasibility report note if run.

### 0.9 Documentation and Cleanup
Objective: Finalize report and prepare Phase 1 inputs.

Steps:
1. Complete `quantlab-extension/docs/FEASIBILITY_REPORT.md` with:
   - Pass/fail per spike.
   - Patch list with exact file paths.
   - Screenshots or notes per spike.
   - Architecture recommendation (thin fork vs extension).
2. Summarize macOS keybinding decision.
3. Flag all spike code as temporary for later removal.

Artifacts:
- Final feasibility report.
- Decision log for Phase 1.

## Validation Matrix
- Platforms: Windows, Linux, macOS (macOS required for keybinding decision).
- File types: `.py` (primary), non-.py (negative control).
- Tab scenarios: single tab, multiple tabs same file, tab reorder, tab close.

## Risks and Mitigations
- In-place view switching may require deep fork patches.
  - Mitigation: test CustomTextEditorProvider first; document Monaco tradeoffs.
- Tab identity may not be exposed by API.
  - Mitigation: propose minimal workbench API to expose tab IDs.
- Cmd+Q on macOS may be non-interceptable.
  - Mitigation: define fallback and log deviation request.
- Title bar injection likely requires patch.
  - Mitigation: prototype StatusBarItem fallback while documenting spec deviation.

## Phase 1 Inputs (Required Outputs)
- Confirmed architecture boundary: extension-only vs thin fork.
- Exact patch list with file locations and rationale.
- Chosen in-place view switching approach.
- Tab identity strategy.
- macOS keybinding decision.

## Appendices

### A. Feasibility Report Template (Skeleton)
```
# Quantlab V8.1 Feasibility Report

Date:
Author:
Duration:

## Executive Summary
- What works via extension API
- What requires fork patches

## Spike Results
0.1 View Button Placement: [PASS/FAIL]
- Notes:
- Patch needed:

0.2 Tab Indicator Stripe: [PASS/FAIL]
- Notes:
- Patch needed:

0.3 In-Place View Switching: [PASS/FAIL]
- Approach chosen:
- Tradeoffs:
- Patch needed:

0.4 Window Chrome Elements: [PASS/FAIL]
- Notes:
- Patch needed:

0.5 Keybinding Feasibility: [PASS/FAIL]
- macOS decision:

0.6 Tab Instance Identity: [PASS/FAIL]
- Strategy:
- Stability caveats:

0.7 Tab View State Persistence: [PASS/FAIL]
- Notes:

## Fork Patch Summary
1. [File path] - [Change summary]
2. [File path] - [Change summary]

## Architecture Recommendation
- Thin fork vs extension-only decision and rationale.
```
