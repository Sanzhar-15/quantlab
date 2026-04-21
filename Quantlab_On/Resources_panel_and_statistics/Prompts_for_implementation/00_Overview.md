# Implementation Prompts Overview

This folder contains focused implementation prompts for the Resources Panel & Statistics feature.

## Prompt Structure

Each prompt is designed to be:
- **Self-contained** - All necessary context included
- **Focused** - One logical unit of work
- **Testable** - Clear verification steps
- **Sequential** - Build on previous prompts

## Execution Order

```
Phase 0: Foundation
├── 01_Types_Foundation.md          # Create type definitions

Phase 1: Data File Detection
├── 02_Context_Keys.md              # VS Code core - data file detection
├── 03_Button_Rendering.md          # VS Code core - RHS buttons
├── 04_DataViewManager.md           # Extension - view management
├── 05_Data_Commands.md             # Extension - command registration

Phase 2: Resources Panel
├── 06_Resources_Panel_Webview.md   # Convert to WebviewViewProvider
├── 07_Resources_Webview_Script.md  # Frontend for Resources panel
├── 08_Stats_Catalog.md             # Define all statistical tests

Phase 3: Stats View
├── 09_Stats_View_Provider.md       # StatsViewProvider implementation
├── 10_Stats_Webview_Script.md      # Frontend for Stats view

Phase 4: Stats Execution
├── 11_Stats_Engine.md              # TypeScript engine interface
├── 12_Python_Stats_Runner.md       # Python execution scripts
├── 13_DataService_Extension.md     # Add loadDataFrame

Phase 5: Visualise View
├── 14_Visualise_View_Provider.md   # VisualiseViewProvider implementation
├── 15_Visualise_Webview_Script.md  # Plotly-based frontend

Phase 6: Integration
├── 16_Package_Json_Updates.md      # All package.json changes
├── 17_Extension_Registration.md    # Wire everything in extension.ts
├── 18_Final_Testing.md             # Verification checklist
```

## How to Use These Prompts

1. Start with `01_Types_Foundation.md`
2. Complete each prompt in order
3. Verify the "Test" section before moving on
4. If blocked, check dependencies from previous prompts

## Key Files Reference

| Component | Path |
|-----------|------|
| VS Code Core Context Keys | `src/vs/workbench/browser/parts/editor/quantlabContextKeys.ts` |
| VS Code Core Button Rendering | `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts` |
| Extension Types | `extensions/quantlab/src/types/` |
| Extension Views | `extensions/quantlab/src/views/` |
| Extension Panels | `extensions/quantlab/src/panels/` |
| Webview Source | `extensions/quantlab/webview/` |
| Webview Build | `extensions/quantlab/esbuild-webview.mjs` |
| Package Config | `extensions/quantlab/package.json` |
