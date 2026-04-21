# Quantlab Phase 1 Workbench Patches

Status: Draft
Owner: Quantlab PM/Eng

Purpose: Track all fork-level changes required to implement Phase 1 (Core View System). Keep this list current with file paths and rationale.

## Patch Checklist

- [x] `src/vs/workbench/browser/parts/editor/quantlabViewStateService.ts`
  - Add per-tab view state storage, workspace persistence, and change events.
- [x] `src/vs/workbench/browser/parts/editor/quantlabViewEditorInput.ts`
  - Wrap resource inputs to apply view suffixes (e.g., `filename.py (Chart)`), allow duplicates.
- [x] `src/vs/workbench/browser/parts/editor/editor.contribution.ts`
  - Register Quantlab service and editor input.
  - Register workbench-only command `quantlab.openAsView`.
  - Trim `MenuId.EditorTitle` layout buttons from the tab bar.
- [x] `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`
  - Add Quantlab actions container (Chart/Action/Trade/Editor).
  - Apply `data-ql-view` attribute to tabs based on `QuantlabTabViewService`.
  - Update tab ARIA labels to include the view name.
- [x] `src/vs/workbench/browser/parts/editor/singleEditorTabsControl.ts`
  - Mirror multi-tab behavior for the single-tab layout.
- [x] `src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css`
  - Add 3px left stripe styles using `--ql-view-*` tokens.
  - Reserve space for the Quantlab actions container.
- [x] `src/vs/workbench/browser/parts/editor/media/singleeditortabscontrol.css`
  - Add stripe styles and layout spacing for single-tab mode.
- [x] `src/vs/workbench/browser/media/style.css`
  - Add view stripe tokens: `--ql-view-chart`, `--ql-view-action`, `--ql-view-trade`, `--ql-view-stripe-width`.
- [x] `src/vs/workbench/electron-browser/desktop.contribution.ts`
  - Remap `workbench.action.quit` to `Cmd+Shift+Q` on macOS.

## Notes
- All changes must preserve upstream VS Code behaviors unless explicitly overridden by V8.1.
- Keep view switching state-only in Phase 1. No webviews or editor replacement yet.
- Update this file if additional patch points are discovered during implementation.
