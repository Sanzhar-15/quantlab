# Phase 1: Data File Detection - Detailed Implementation

## Objective

Add context key detection for data files (xlsx, parquet, csv) and implement conditional RHS button rendering.

---

## 1. Context Key Changes

### File: `src/vs/workbench/browser/parts/editor/quantlabContextKeys.ts`

#### Add New Context Keys

```typescript
// Add after existing context key definitions (line ~18)
const QUANTLAB_IS_DATA_FILE = new RawContextKey<boolean>('quantlab.isDataFile', false);
const QUANTLAB_DATA_FILE_TYPE = new RawContextKey<string | null>('quantlab.dataFileType', null);
const QUANTLAB_RESOURCES_SECTION = new RawContextKey<string>('quantlab.resourcesSection', 'strategy');
```

#### Bind Keys in Controller

```typescript
// In QuantlabContextKeyController class, add after existing bindings (line ~29)
private readonly isDataFileKey = QUANTLAB_IS_DATA_FILE.bindTo(this.contextKeyService);
private readonly dataFileTypeKey = QUANTLAB_DATA_FILE_TYPE.bindTo(this.contextKeyService);
private readonly resourcesSectionKey = QUANTLAB_RESOURCES_SECTION.bindTo(this.contextKeyService);
```

#### Add Detection Methods

```typescript
// Add after isStrategyModel method (line ~154)

private readonly DATA_FILE_EXTENSIONS = ['.xlsx', '.parquet', '.csv'];

private isDataFile(resource: URI): boolean {
    const path = resource.path.toLowerCase();
    return this.DATA_FILE_EXTENSIONS.some(ext => path.endsWith(ext));
}

private getDataFileType(resource: URI): 'xlsx' | 'parquet' | 'csv' | null {
    const path = resource.path.toLowerCase();
    if (path.endsWith('.xlsx')) return 'xlsx';
    if (path.endsWith('.parquet')) return 'parquet';
    if (path.endsWith('.csv')) return 'csv';
    return null;
}
```

#### Update Context Method

```typescript
// Modify updateContext method (line ~86)
private updateContext(): void {
    const active = this.getActiveEditorInfo();
    if (!active) {
        this.currentViewKey.set('editor');
        this.isStrategyKey.set(false);
        this.isDataFileKey.set(false);
        this.dataFileTypeKey.set(null);
        return;
    }

    // Detect view type directly from editor (authoritative source)
    const view = this.detectViewTypeFromEditor();
    this.currentViewKey.set(view);

    // Check for data file first (takes precedence)
    const isDataFile = this.isDataFile(active.resource);
    this.isDataFileKey.set(isDataFile);
    this.dataFileTypeKey.set(isDataFile ? this.getDataFileType(active.resource) : null);

    // Only check for strategy if not a data file
    if (!isDataFile) {
        const model = this.modelService.getModel(active.resource);
        const isStrategy = model ? this.isStrategyModel(model) : false;
        this.isStrategyKey.set(isStrategy);
    } else {
        this.isStrategyKey.set(false);
    }
}
```

---

## 2. Button Rendering Changes

### File: `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`

#### Add Data File View Types

```typescript
// Add near the top of the file, after existing type imports
export type DataViewType = 'editor' | 'visualise' | 'action';

function formatDataViewLabel(view: DataViewType): string {
    switch (view) {
        case 'visualise': return 'Visualise';
        case 'action': return 'Action';
        default: return 'Editor';
    }
}
```

#### Add Data File Detection Method

```typescript
// Add after isQuantlabStrategy method (line ~306)
private isQuantlabDataFile(): boolean {
    return this.contextKeyService.getContextKeyValue<boolean>('quantlab.isDataFile') === true;
}

private getQuantlabDataFileType(): string | null {
    return this.contextKeyService.getContextKeyValue<string | null>('quantlab.dataFileType') ?? null;
}
```

#### Update Button Rendering

```typescript
// Replace updateQuantlabActions method (line ~243)
private updateQuantlabActions(): void {
    if (!this.quantlabActionsContainer) {
        return;
    }

    const disposables = this.ensureQuantlabActionsDisposables();
    disposables.clear();
    clearNode(this.quantlabActionsContainer);

    const currentView = this.getQuantlabCurrentView();
    const isStrategy = this.isQuantlabStrategy();
    const isDataFile = this.isQuantlabDataFile();

    // Determine which button set to render
    if (isStrategy) {
        // Strategy files: Chart, Action, Trade
        for (const view of this.getQuantlabButtonOrder(currentView)) {
            this.renderStrategyButton(view, disposables);
        }
    } else if (isDataFile) {
        // Data files: Visualise, Action
        for (const view of this.getDataFileButtonOrder(currentView as DataViewType)) {
            this.renderDataFileButton(view, disposables);
        }
    }
    // No buttons for other file types
}

private renderStrategyButton(view: QuantlabViewType, disposables: DisposableStore): void {
    const button = document.createElement('button');
    button.className = 'quantlab-view-button';
    button.type = 'button';
    button.textContent = formatQuantlabViewLabel(view);
    button.setAttribute('aria-label', `${formatQuantlabViewLabel(view)} view button`);
    button.setAttribute('data-ql-anchor', `quantlab-view-${view}`);

    const isStrategy = this.isQuantlabStrategy();
    if (view !== 'editor' && !isStrategy) {
        button.classList.add('is-disabled');
        button.setAttribute('aria-disabled', 'true');
    }

    disposables.add(addDisposableListener(button, EventType.CLICK, e => {
        EventHelper.stop(e, true);
        void this.commandService.executeCommand(this.getQuantlabCommandId(view));
    }));

    this.quantlabActionsContainer!.appendChild(button);
}

private renderDataFileButton(view: DataViewType, disposables: DisposableStore): void {
    const button = document.createElement('button');
    button.className = 'quantlab-view-button quantlab-data-button';
    button.type = 'button';
    button.textContent = formatDataViewLabel(view);
    button.setAttribute('aria-label', `${formatDataViewLabel(view)} view button`);
    button.setAttribute('data-ql-anchor', `quantlab-data-${view}`);

    disposables.add(addDisposableListener(button, EventType.CLICK, e => {
        EventHelper.stop(e, true);
        void this.commandService.executeCommand(this.getDataFileCommandId(view));
    }));

    this.quantlabActionsContainer!.appendChild(button);
}

private getDataFileButtonOrder(currentView: DataViewType): DataViewType[] {
    switch (currentView) {
        case 'visualise':
            return ['editor', 'action'];
        case 'action':
            return ['visualise', 'editor'];
        default:
            return ['visualise', 'action'];
    }
}

private getDataFileCommandId(view: DataViewType): string {
    switch (view) {
        case 'visualise':
            return 'quantlab.switchToVisualise';
        case 'action':
            return 'quantlab.switchToDataAction';
        default:
            return 'quantlab.switchToEditor';
    }
}
```

---

## 3. View Type Service Changes

### File: `src/vs/workbench/browser/parts/editor/quantlabViewStateService.ts`

#### Extend View Types

```typescript
// Update QuantlabViewType to include new views
export type QuantlabViewType = 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats';

// Update customEditorViewTypeToQuantlabView function
export function customEditorViewTypeToQuantlabView(viewType: string): QuantlabViewType {
    switch (viewType) {
        case 'quantlab.chartView':
            return 'chart';
        case 'quantlab.actionView':
            return 'action';
        case 'quantlab.tradeView':
            return 'trade';
        case 'quantlab.visualiseView':
            return 'visualise';
        case 'quantlab.statsView':
            return 'stats';
        default:
            return 'editor';
    }
}
```

---

## 4. Extension Types Changes

### File: `extensions/quantlab/src/types/views.ts`

```typescript
// Update ViewType
export type ViewType = 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats';

// Add DataViewType
export type DataViewType = 'editor' | 'visualise' | 'stats';
```

---

## 5. Commands Registration

### File: `extensions/quantlab/src/commands/viewCommands.ts`

```typescript
// Add after existing command registrations
context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.switchToVisualise', () => switchToDataView('visualise')),
    vscode.commands.registerCommand('quantlab.switchToDataAction', () => switchToDataAction())
);

async function switchToDataView(view: 'visualise' | 'stats'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        // For data files, we need a different view manager
        const dataViewManager = DataViewManager.getInstance();
        await dataViewManager.switchView(editor.document.uri, view);
    }
}

async function switchToDataAction(): Promise<void> {
    // Set resources section to 'stats' before opening
    await vscode.commands.executeCommand('setContext', 'quantlab.resourcesSection', 'stats');
    await vscode.commands.executeCommand('quantlab.focusResourcesPanel', { section: 'stats' });
}
```

---

## 6. Package.json Updates

### Add Context Key Contributions

```json
{
  "contributes": {
    "commands": [
      {
        "command": "quantlab.switchToVisualise",
        "title": "Switch to Visualise View",
        "category": "QuantLab"
      },
      {
        "command": "quantlab.switchToDataAction",
        "title": "Switch to Data Action View",
        "category": "QuantLab"
      }
    ],
    "keybindings": [
      {
        "command": "quantlab.switchToVisualise",
        "key": "ctrl+q v",
        "when": "quantlab.isDataFile"
      },
      {
        "command": "quantlab.switchToDataAction",
        "key": "ctrl+q a",
        "when": "quantlab.isDataFile"
      }
    ],
    "menus": {
      "editor/title": [
        {
          "command": "quantlab.switchToVisualise",
          "when": "quantlab.isDataFile",
          "group": "navigation"
        }
      ]
    }
  }
}
```

---

## 7. Testing Checklist

### Unit Tests

```typescript
// test/unit/quantlabContextKeys.test.ts

describe('QuantlabContextKeyController', () => {
    describe('data file detection', () => {
        it('should detect xlsx files', () => {
            const uri = URI.file('/path/to/data.xlsx');
            expect(controller.isDataFile(uri)).toBe(true);
            expect(controller.getDataFileType(uri)).toBe('xlsx');
        });

        it('should detect parquet files', () => {
            const uri = URI.file('/path/to/data.parquet');
            expect(controller.isDataFile(uri)).toBe(true);
            expect(controller.getDataFileType(uri)).toBe('parquet');
        });

        it('should detect csv files', () => {
            const uri = URI.file('/path/to/data.csv');
            expect(controller.isDataFile(uri)).toBe(true);
            expect(controller.getDataFileType(uri)).toBe('csv');
        });

        it('should not detect python files as data files', () => {
            const uri = URI.file('/path/to/strategy.py');
            expect(controller.isDataFile(uri)).toBe(false);
            expect(controller.getDataFileType(uri)).toBeNull();
        });

        it('should handle case insensitivity', () => {
            const uri = URI.file('/path/to/DATA.XLSX');
            expect(controller.isDataFile(uri)).toBe(true);
        });
    });
});
```

### Manual Testing

1. [ ] Open an xlsx file - verify Visualise and Action buttons appear
2. [ ] Open a parquet file - verify buttons appear
3. [ ] Open a csv file - verify buttons appear
4. [ ] Open a Python strategy file - verify Chart, Action, Trade buttons appear
5. [ ] Open a regular text file - verify no quantlab buttons appear
6. [ ] Switch between tabs - verify buttons update correctly
7. [ ] Test keyboard shortcuts (Ctrl+Q V, Ctrl+Q A) on data files

---

## 8. Edge Cases to Handle

1. **Mixed tabs**: User has both strategy and data files open
   - Buttons should change based on active tab
   - Context keys should update on tab switch

2. **File rename**: User renames file from .txt to .csv
   - Should trigger re-evaluation of context keys

3. **Unsaved new file**: New untitled file
   - Should not show data file buttons until saved with data extension

4. **Large files**: Very large data files
   - Button rendering should not be affected by file size
   - Loading indicators should be handled elsewhere

---

## 9. File Changes Summary

| File | Action | Changes |
|------|--------|---------|
| `quantlabContextKeys.ts` | Modify | Add data file context keys and detection |
| `multiEditorTabsControl.ts` | Modify | Add data file button rendering |
| `quantlabViewStateService.ts` | Modify | Extend view types |
| `types/views.ts` | Modify | Add new view types |
| `viewCommands.ts` | Modify | Add new commands |
| `package.json` | Modify | Add commands and keybindings |
