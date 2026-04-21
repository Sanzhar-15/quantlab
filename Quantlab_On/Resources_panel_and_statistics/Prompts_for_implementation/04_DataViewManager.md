# Prompt 04: DataViewManager

## Objective
Create the DataViewManager class that handles view switching for data files.

## Context
The existing `ViewManager` is tightly coupled to strategy validation. We need a separate manager for data files that handles the Visualise/Stats view switching and the "pending test" pattern.

## File to Create

### `extensions/quantlab/src/views/DataViewManager.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  DataViewManager - Handles view switching for data files
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { DataFileType, DataViewType } from '../types/data';

export class DataViewManager {
    private static instance: DataViewManager;

    // Track which data file was active when Action was clicked
    private lastActiveDataFile: vscode.Uri | undefined;

    // Pending test to configure (solves race condition when opening Stats view)
    private readonly pendingTestByUri = new Map<string, string>();

    private constructor() {}

    static getInstance(): DataViewManager {
        if (!DataViewManager.instance) {
            DataViewManager.instance = new DataViewManager();
        }
        return DataViewManager.instance;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View Switching
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Switch to Visualise view for a data file
     */
    async switchToVisualise(resource: vscode.Uri): Promise<void> {
        if (!this.isDataFile(resource)) {
            void vscode.window.showWarningMessage('This file is not a supported data file.');
            return;
        }

        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.visualiseView');
        this.updateContextKeys('visualise', this.getDataFileType(resource));
    }

    /**
     * Open Data Action - focuses Resources panel with Pure Stats section
     * Does NOT open Stats view immediately (waits for test selection)
     */
    async openDataAction(resource: vscode.Uri): Promise<void> {
        if (!this.isDataFile(resource)) {
            void vscode.window.showWarningMessage('This file is not a supported data file.');
            return;
        }

        // Remember which data file was active
        this.lastActiveDataFile = resource;

        // Switch Resources panel to Pure Stats section
        await vscode.commands.executeCommand('quantlab.setResourcesSection', 'stats');

        // Focus the Resources panel
        await vscode.commands.executeCommand('workbench.view.extension.quantlab-resources');
    }

    /**
     * Open a specific stats test - called when user clicks test in Resources panel
     */
    async openStatsTest(testId: string): Promise<void> {
        const resource = this.lastActiveDataFile ?? this.getActiveDataFileFromEditor();

        if (!resource) {
            void vscode.window.showWarningMessage(
                'No data file selected. Please open a data file first.'
            );
            return;
        }

        // Store pending test BEFORE opening editor (solves race condition)
        this.pendingTestByUri.set(resource.toString(), testId);

        // Open Stats view as custom editor
        await vscode.commands.executeCommand('vscode.openWith', resource, 'quantlab.statsView');

        this.updateContextKeys('stats', this.getDataFileType(resource));
    }

    /**
     * Switch to Editor view for a data file (with binary file handling)
     */
    async switchToEditor(resource: vscode.Uri): Promise<void> {
        const fileType = this.getDataFileType(resource);

        // Binary files can't be viewed as text
        if (fileType === 'parquet' || fileType === 'xlsx') {
            const choice = await vscode.window.showWarningMessage(
                'Binary data files cannot be viewed as text. Use Visualise view to explore the data.',
                'Open Visualise',
                'Cancel'
            );
            if (choice === 'Open Visualise') {
                await this.switchToVisualise(resource);
            }
            return;
        }

        // CSV can be viewed as text
        await vscode.commands.executeCommand('vscode.openWith', resource, 'default');
        this.updateContextKeys('editor', fileType);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pending Test Pattern (for Stats view initialization)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Consume pending test for a resource
     * Called by StatsViewProvider when the view initializes
     */
    consumePendingTest(resource: vscode.Uri): string | undefined {
        const key = resource.toString();
        const testId = this.pendingTestByUri.get(key);
        if (testId) {
            this.pendingTestByUri.delete(key);
        }
        return testId;
    }

    /**
     * Check if there's a pending test for a resource
     */
    hasPendingTest(resource: vscode.Uri): boolean {
        return this.pendingTestByUri.has(resource.toString());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Get the data file type from URI
     */
    getDataFileType(resource: vscode.Uri): DataFileType | null {
        const ext = path.extname(resource.path).toLowerCase();
        switch (ext) {
            case '.csv': return 'csv';
            case '.parquet': return 'parquet';
            case '.xlsx': return 'xlsx';
            default: return null;
        }
    }

    /**
     * Check if a resource is a data file
     */
    isDataFile(resource: vscode.Uri): boolean {
        return this.getDataFileType(resource) !== null;
    }

    /**
     * Get the currently active data file from editor (if any)
     */
    getActiveDataFile(): vscode.Uri | undefined {
        return this.lastActiveDataFile ?? this.getActiveDataFileFromEditor();
    }

    private getActiveDataFileFromEditor(): vscode.Uri | undefined {
        const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
        if (!activeTab) return undefined;

        let uri: vscode.Uri | undefined;

        if (activeTab.input instanceof vscode.TabInputText) {
            uri = activeTab.input.uri;
        } else if (activeTab.input instanceof vscode.TabInputCustom) {
            uri = activeTab.input.uri;
        }

        if (uri && this.isDataFile(uri)) {
            return uri;
        }

        return undefined;
    }

    private updateContextKeys(view: DataViewType, fileType: DataFileType | null): void {
        void vscode.commands.executeCommand('setContext', 'quantlab.currentView', view);
        void vscode.commands.executeCommand('setContext', 'quantlab.isDataFile', Boolean(fileType));
        void vscode.commands.executeCommand('setContext', 'quantlab.dataFileType', fileType);
        // Clear strategy flag when on data file
        void vscode.commands.executeCommand('setContext', 'quantlab.isStrategy', false);
    }
}
```

## Test

1. Import should work:
   ```typescript
   import { DataViewManager } from './views/DataViewManager';
   const manager = DataViewManager.getInstance();
   ```

2. Type checking should pass:
   ```bash
   cd extensions/quantlab && npx tsc --noEmit
   ```

## Dependencies
- Prompt 01 (types) must be complete
- This provides the foundation for command registration

## Next
Proceed to `05_Data_Commands.md`
