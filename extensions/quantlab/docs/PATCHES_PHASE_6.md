# Quantlab Phase 6 Workbench Patches

Status: Draft
Owner: Quantlab PM/Eng

Purpose: Track all fork-level changes required to implement Phase 6 (Polish + Compliance). Keep this list current with file paths and rationale.

## Patch Checklist

- [x] `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`
  - Add drag-and-drop handling for the symbol selector (accept `application/quantlab-symbol`).
  - Update History button ARIA label to include unviewed count.
  - Add onboarding anchor attribute on History button.
- [x] `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css`
  - Style symbol drop target highlight.
- [x] `src/vs/workbench/browser/parts/editor/quantlabToast.ts`
  - Add Quantlab toast host controller (bottom-right stack, actions, dismiss).
- [x] `src/vs/workbench/browser/parts/editor/editorPart.ts`
  - Instantiate Quantlab toast host and expose show/dismiss helpers.
- [x] `src/vs/workbench/browser/parts/editor/editor.contribution.ts`
  - Register `quantlab.showToast` and `quantlab.dismissToast` commands.
- [x] `src/vs/workbench/browser/media/style.css`
  - Wire Quantlab tokens to theme colors and add toast container styles.
- [x] `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`
  - Add onboarding anchor attributes to Quantlab view buttons.
- [x] `src/vs/workbench/browser/parts/editor/singleEditorTabsControl.ts`
  - Add onboarding anchor attributes to Quantlab view buttons.

## Notes
- Toasts are isolated to the editor area and do not alter the native VS Code notification system.
- History badge remains extension-driven; workbench only renders the count and ARIA label.
