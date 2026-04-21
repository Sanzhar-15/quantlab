# Prompt 05: Data Commands Registration

## Objective
Register VS Code commands for data file view switching.

## Context
The DataViewManager (Prompt 04) provides the logic. Now we register the commands that the RHS buttons call.

## File to Create

### `extensions/quantlab/src/commands/dataCommands.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Data file commands for QuantLab
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DataViewManager } from '../views/DataViewManager';

export function registerDataCommands(context: vscode.ExtensionContext): void {
    const manager = DataViewManager.getInstance();

    // Switch to Visualise view
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.switchToVisualise', async () => {
            const resource = getActiveDataResource();
            if (resource) {
                await manager.switchToVisualise(resource);
            }
        })
    );

    // Open Data Action (focuses Resources panel with Pure Stats)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.openDataAction', async () => {
            const resource = getActiveDataResource();
            if (resource) {
                await manager.openDataAction(resource);
            }
        })
    );

    // Switch to Editor view for data files
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.switchToDataEditor', async () => {
            const resource = getActiveDataResource();
            if (resource) {
                await manager.switchToEditor(resource);
            }
        })
    );

    // Open specific stats test (called from Resources panel)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.openStatsTest', async (testId: string) => {
            await manager.openStatsTest(testId);
        })
    );

    // Set Resources panel section (called by DataViewManager)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.setResourcesSection', async (section: 'strategy' | 'stats') => {
            // This will be handled by ResourcesPanelProvider
            // For now, just emit the command - implementation in Prompt 06
            void vscode.commands.executeCommand('quantlab.resources.setSection', section);
        })
    );
}

/**
 * Get the active data file resource from the current editor
 */
function getActiveDataResource(): vscode.Uri | undefined {
    const manager = DataViewManager.getInstance();

    // First check if there's a tracked active data file
    const tracked = manager.getActiveDataFile();
    if (tracked) {
        return tracked;
    }

    // Fall back to checking the active tab
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
        void vscode.window.showWarningMessage('No data file is open.');
        return undefined;
    }

    let uri: vscode.Uri | undefined;

    if (activeTab.input instanceof vscode.TabInputText) {
        uri = activeTab.input.uri;
    } else if (activeTab.input instanceof vscode.TabInputCustom) {
        uri = activeTab.input.uri;
    }

    if (!uri) {
        void vscode.window.showWarningMessage('Cannot determine file from current editor.');
        return undefined;
    }

    if (!manager.isDataFile(uri)) {
        void vscode.window.showWarningMessage('Current file is not a supported data file.');
        return undefined;
    }

    return uri;
}
```

## File to Modify

### `extensions/quantlab/src/commands/index.ts`

Add export for data commands:

```typescript
// Existing exports
export * from './strategyCommands';

// NEW: Add this
export * from './dataCommands';
```

## Test

1. After registration, commands should appear in Command Palette:
   - `quantlab.switchToVisualise`
   - `quantlab.openDataAction`
   - `quantlab.switchToDataEditor`
   - `quantlab.openStatsTest`

2. Test command execution (commands registered, views not implemented yet):
   ```typescript
   // In extension developer console
   vscode.commands.executeCommand('quantlab.switchToVisualise');
   // Should show warning about no data file or attempt to open view
   ```

## Dependencies
- Prompt 04 (DataViewManager) must be complete

## Next
Proceed to `06_Resources_Panel_Webview.md`
