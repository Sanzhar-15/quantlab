# Prompt 02: Data File Context Keys

## Objective
Add context key detection for data files (CSV, Parquet, XLSX) in the VS Code workbench core.

## Context
Currently, `quantlabContextKeys.ts` detects Python strategy files and sets `quantlab.isStrategy`. We need to add parallel detection for data files.

## File to Modify

### `src/vs/workbench/browser/parts/editor/quantlabContextKeys.ts`

#### 1. Add new context key definitions (after line ~19)

```typescript
// Existing
const QUANTLAB_CURRENT_VIEW = new RawContextKey<QuantlabViewType>('quantlab.currentView', 'editor');
const QUANTLAB_IS_STRATEGY = new RawContextKey<boolean>('quantlab.isStrategy', false);

// NEW: Add these
const QUANTLAB_IS_DATA_FILE = new RawContextKey<boolean>('quantlab.isDataFile', false);
const QUANTLAB_DATA_FILE_TYPE = new RawContextKey<string | null>('quantlab.dataFileType', null);
```

#### 2. Add key bindings in the controller class (after line ~29)

```typescript
// Existing
private readonly currentViewKey = QUANTLAB_CURRENT_VIEW.bindTo(this.contextKeyService);
private readonly isStrategyKey = QUANTLAB_IS_STRATEGY.bindTo(this.contextKeyService);

// NEW: Add these
private readonly isDataFileKey = QUANTLAB_IS_DATA_FILE.bindTo(this.contextKeyService);
private readonly dataFileTypeKey = QUANTLAB_DATA_FILE_TYPE.bindTo(this.contextKeyService);
```

#### 3. Add data file detection constants (after line ~23)

```typescript
// Existing strategy patterns
const VECTOR_PATTERN = /def\s+strategy\s*\(\s*data\s*\)/;
const EVENT_PATTERN = /def\s+on_bar\s*\(\s*ctx\s*\)/;
const CLASS_PATTERN = /class\s+(\w+)\s*\(\s*ql\.Strategy\s*\)/;

// NEW: Data file extensions
const DATA_FILE_EXTENSIONS = ['.csv', '.parquet', '.xlsx'];
```

#### 4. Add data file detection methods (after `isPythonModel` method)

```typescript
private isDataFile(resource: URI): boolean {
    const path = resource.path.toLowerCase();
    return DATA_FILE_EXTENSIONS.some(ext => path.endsWith(ext));
}

private getDataFileType(resource: URI): string | null {
    const path = resource.path.toLowerCase();
    if (path.endsWith('.csv')) return 'csv';
    if (path.endsWith('.parquet')) return 'parquet';
    if (path.endsWith('.xlsx')) return 'xlsx';
    return null;
}
```

#### 5. Modify `updateContext` method (replace existing ~line 86)

```typescript
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

    // Check for data file FIRST
    const isDataFile = this.isDataFile(active.resource);
    this.isDataFileKey.set(isDataFile);
    this.dataFileTypeKey.set(isDataFile ? this.getDataFileType(active.resource) : null);

    // Only check for strategy if NOT a data file (mutually exclusive)
    if (!isDataFile) {
        const model = this.modelService.getModel(active.resource);
        const isStrategy = model ? this.isStrategyModel(model) : false;
        this.isStrategyKey.set(isStrategy);
    } else {
        this.isStrategyKey.set(false);
    }
}
```

#### 6. Update `detectViewTypeFromEditor` to handle new view types

```typescript
private detectViewTypeFromEditor(): QuantlabViewType {
    const group = this.editorGroupsService.activeGroup;
    const editor = group?.activeEditor;

    if (!editor) {
        return 'editor';
    }

    if (editor instanceof CustomEditorInput) {
        return customEditorViewTypeToQuantlabView(editor.viewType);
    }

    return 'editor';
}
```

## Also Modify

### `src/vs/workbench/browser/parts/editor/quantlabViewStateService.ts`

Update `QuantlabViewType` and `customEditorViewTypeToQuantlabView`:

```typescript
// Update type
export type QuantlabViewType = 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats';

// Update function
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

## Test

1. Open a CSV file - verify in DevTools (F12 → Console):
   ```javascript
   // Run in console
   const ctx = workbench.getWorkbenchState().contextKeyService;
   ctx.getContextKeyValue('quantlab.isDataFile');  // Should be true
   ctx.getContextKeyValue('quantlab.dataFileType'); // Should be 'csv'
   ctx.getContextKeyValue('quantlab.isStrategy');   // Should be false
   ```

2. Open a Python strategy file - verify `isStrategy` is true, `isDataFile` is false.

3. Switch between tabs - verify context keys update.

## Dependencies
- Prompt 01 (types) should be complete

## Next
Proceed to `03_Button_Rendering.md`
