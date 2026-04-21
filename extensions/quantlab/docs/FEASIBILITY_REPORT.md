# Quantlab V8.1 Feasibility Report

Date: 2026-01-20
Author: Quantlab Spike (automated)
Duration: Phase 0 (code + expected outcome analysis)

Note: Spike code lives under `extensions/quantlab/src/spike`. Manual UI validation is still required; results below reflect expected behavior based on VS Code extension API constraints.

## Executive Summary

- Extension APIs cover command wiring, custom editors, and basic state persistence.
- V8.1-critical UX elements (tab bar buttons, tab stripes, title bar controls, stable tab IDs, native Monaco in-place switching) require workbench patches.
- Recommended architecture: thin fork with a built-in Quantlab extension.

## Spike Results

### 0.1 View Button Placement
- Extension approach: PARTIAL (buttons appear in editor title area, not the tab bar RHS).
- Patch needed: `src/vs/workbench/browser/parts/editor/editorTabsControl.ts` (or `multiEditorTabsControl.ts`/`singleEditorTabsControl.ts`) to insert Quantlab buttons into the tab strip and relocate layout buttons.

### 0.2 Tab Indicator Stripe Styling
- Extension approach: FAIL (FileDecorationProvider only affects explorer, not tabs).
- Fallback (badge/emoji): NOT ACCEPTABLE for V8.1.
- Patch needed:
  - CSS: `src/vs/workbench/browser/parts/editor/media/tabstitlecontrol.css` (or `multieditortabscontrol.css`/`singleeditortabscontrol.css`).
  - TS: `src/vs/workbench/browser/parts/editor/tabsTitleControl.ts` (or `multiEditorTabsControl.ts`) to apply data attributes per tab.

### 0.3 In-Place View Switching
- Extension approach: PARTIAL via CustomTextEditorProvider (single tab, webview). Native Monaco is not preserved.
- Chosen approach for spike: CustomTextEditorProvider (webview) to validate switching behavior.
- Patch needed for spec-level UX: `src/vs/workbench/browser/parts/editor/editorPanes.ts` (and potentially `editorService.ts`) to swap editor panes in-place while preserving Monaco for Editor view.

### 0.4 Window Chrome Elements
- Extension approach: FAIL (no title bar injection API).
- Fallback: Status bar items are functional but not spec-compliant.
- Patch needed: `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` and `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css`.

### 0.5 macOS Ctrl+Q Keybinding
- Cmd+Q prefix: Expected FAIL (OS-level quit shortcut).
- Ctrl+Q on macOS: Expected PASS (Control key), requires validation.
- Decision (proposed): Use Ctrl+Q on macOS. If blocked, fall back to Cmd+K Q.
- Patch candidate (if remapping Quit): `src/vs/workbench/electron-browser/desktop.contribution.ts`.

### 0.6 Tab Instance Identity
- Extension approach: PARTIAL (per-session IDs via WeakMap). No stable ID across reload or reorder.
- Patch needed: expose a stable tab instance ID in workbench tab model or editor input layer.

### 0.7 Tab View State Persistence
- Extension approach: PARTIAL (workspaceState works, but depends on stable tab IDs).
- Cleanup on tab close: feasible once stable tab IDs exist.
- Patch needed: same as 0.6.

## Fork Patch Summary

1. `src/vs/workbench/browser/parts/editor/editorTabsControl.ts` (or `multiEditorTabsControl.ts`/`singleEditorTabsControl.ts`) - render Quantlab view buttons in tab strip and adjust layout buttons.
2. `src/vs/workbench/browser/parts/editor/media/tabstitlecontrol.css` (or multi/single tabs CSS) - add 3px view stripe styles.
3. `src/vs/workbench/browser/parts/editor/tabsTitleControl.ts` - apply per-tab view attributes for stripe styling.
4. `src/vs/workbench/browser/parts/editor/editorPanes.ts` (and possibly `editorService.ts`) - in-place view switching with native Monaco.
5. `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` + `titlebarpart.css` - add symbol/timeframe selectors and history button.
6. `src/vs/workbench/electron-browser/desktop.contribution.ts` - optional quit remap for macOS Cmd+Q conflicts.
7. Workbench tab model (TBD) - expose stable tab instance IDs for per-tab persistence.

## Architecture Recommendation

Thin fork + built-in Quantlab extension. The extension handles commands, state, and custom editors; the fork supplies tab bar buttons, tab stripes, title bar controls, stable tab IDs, and native Monaco in-place switching.

## Decision Log (Phase 1 Inputs)

- Extension location: `extensions/quantlab` (built-in).
- In-place switching approach: CustomTextEditorProvider for spike; native Monaco switching requires fork patch.
- Tab identity strategy: per-session IDs are possible; stable IDs require fork patch.
- macOS keybinding: prefer Ctrl+Q on macOS; if blocked, use Cmd+K Q fallback.
