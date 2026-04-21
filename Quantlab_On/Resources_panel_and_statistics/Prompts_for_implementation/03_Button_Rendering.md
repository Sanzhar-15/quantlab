# Prompt 03: Data File Button Rendering

## Objective
Add RHS tab button rendering for data files: [Visualise] [Action]

## Context
Currently `multiEditorTabsControl.ts` renders [Chart] [Action] [Trade] for strategy files. We need parallel rendering for data files.

**IMPORTANT DISTINCTION:**
- `DataViewType` ('editor' | 'visualise' | 'stats') represents actual VIEW states
- The [Action] button is a COMMAND that opens the Resources panel - it's NOT a view
- When in Stats view, the user got there via Resources panel, not via a button

## File to Modify

### `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`

#### 1. Import DataViewType from extension types (near top of file, after imports)

```typescript
// Use the same DataViewType as defined in extension
// 'editor' | 'visualise' | 'stats' - these are actual views
// 'action' is a button/command, not a view
type DataViewType = 'editor' | 'visualise' | 'stats';

function formatDataViewLabel(view: DataViewType | 'action'): string {
    switch (view) {
        case 'visualise': return 'Visualise';
        case 'action': return 'Action';
        case 'stats': return 'Stats';
        default: return 'Editor';
    }
}
```

#### 2. Add data file detection method (after `isQuantlabStrategy` ~line 306)

```typescript
private isQuantlabDataFile(): boolean {
    return this.contextKeyService.getContextKeyValue<boolean>('quantlab.isDataFile') === true;
}
```

#### 3. Replace `updateQuantlabActions` method (~line 243)

```typescript
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

    if (isStrategy) {
        // Strategy files: Chart, Action, Trade (existing behavior)
        for (const view of this.getQuantlabButtonOrder(currentView)) {
            this.renderStrategyButton(view, currentView, disposables);
        }
    } else if (isDataFile) {
        // Data files: render view buttons + Action button
        this.renderDataFileButtons(currentView as DataViewType, disposables);
    }
    // Other files: no buttons rendered
}
```

#### 4. Add strategy button rendering method (extract from existing code)

```typescript
private renderStrategyButton(
    view: QuantlabViewType,
    currentView: QuantlabViewType,
    disposables: DisposableStore
): void {
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

    if (view === currentView) {
        button.classList.add('is-current');
    }

    disposables.add(addDisposableListener(button, EventType.CLICK, e => {
        EventHelper.stop(e, true);
        void this.commandService.executeCommand(this.getQuantlabCommandId(view));
    }));

    this.quantlabActionsContainer!.appendChild(button);
}
```

#### 5. Add data file button methods (NEW)

```typescript
/**
 * Render buttons for data files.
 * Shows view switcher buttons based on current view, plus the Action button.
 */
private renderDataFileButtons(
    currentView: DataViewType,
    disposables: DisposableStore
): void {
    // Render view switcher buttons
    const viewButtons = this.getDataFileViewButtons(currentView);
    for (const view of viewButtons) {
        this.renderDataFileViewButton(view, currentView, disposables);
    }

    // Always render the Action button (opens Resources panel)
    this.renderDataFileActionButton(disposables);
}

/**
 * Get which view buttons to show based on current view.
 * Always shows buttons to switch to OTHER views (not current).
 */
private getDataFileViewButtons(currentView: DataViewType): DataViewType[] {
    switch (currentView) {
        case 'editor':
            return ['visualise'];  // Can switch to visualise
        case 'visualise':
            return ['editor'];     // Can switch back to editor
        case 'stats':
            return ['visualise', 'editor'];  // Can switch to either
        default:
            return ['visualise'];
    }
}

/**
 * Render a view switcher button for data files
 */
private renderDataFileViewButton(
    view: DataViewType,
    currentView: DataViewType,
    disposables: DisposableStore
): void {
    const button = document.createElement('button');
    button.className = 'quantlab-view-button quantlab-data-button';
    button.type = 'button';
    button.textContent = formatDataViewLabel(view);
    button.setAttribute('aria-label', `${formatDataViewLabel(view)} view button`);
    button.setAttribute('data-ql-anchor', `quantlab-data-${view}`);

    // View buttons are never "current" since we only show buttons to OTHER views
    // But mark as current if somehow we're showing the current view
    if (view === currentView) {
        button.classList.add('is-current');
    }

    disposables.add(addDisposableListener(button, EventType.CLICK, e => {
        EventHelper.stop(e, true);
        void this.commandService.executeCommand(this.getDataFileViewCommandId(view));
    }));

    this.quantlabActionsContainer!.appendChild(button);
}

/**
 * Render the Action button (opens Resources panel with Pure Stats)
 */
private renderDataFileActionButton(disposables: DisposableStore): void {
    const button = document.createElement('button');
    button.className = 'quantlab-view-button quantlab-data-button quantlab-action-button';
    button.type = 'button';
    button.textContent = 'Action';
    button.setAttribute('aria-label', 'Open Resources panel with statistics tests');
    button.setAttribute('data-ql-anchor', 'quantlab-data-action');

    disposables.add(addDisposableListener(button, EventType.CLICK, e => {
        EventHelper.stop(e, true);
        void this.commandService.executeCommand('quantlab.openDataAction');
    }));

    this.quantlabActionsContainer!.appendChild(button);
}

/**
 * Get command ID for data file view switching
 */
private getDataFileViewCommandId(view: DataViewType): string {
    switch (view) {
        case 'visualise':
            return 'quantlab.switchToVisualise';
        case 'stats':
            return 'quantlab.switchToStats';  // Rarely used - usually via Resources
        default:
            return 'quantlab.switchToDataEditor';
    }
}
```

## CSS Addition

### `src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css`

Add after existing `.quantlab-view-button` styles:

```css
/* Data file button variant */
.monaco-workbench .part.editor > .content .editor-group-container > .title .quantlab-actions .quantlab-data-button {
    /* Same styling as strategy buttons, can customize if needed */
}

/* Action button - slightly different styling to indicate it's not a view */
.monaco-workbench .part.editor > .content .editor-group-container > .title .quantlab-actions .quantlab-action-button {
    border-left: 1px solid var(--vscode-panel-border);
    margin-left: 4px;
    padding-left: 8px;
}

/* Current view indicator */
.monaco-workbench .part.editor > .content .editor-group-container > .title .quantlab-actions .quantlab-view-button.is-current {
    background: var(--vscode-button-secondaryBackground);
    border-color: var(--vscode-button-secondaryBackground);
}
```

## Test

1. Open a CSV file:
   - [Visualise] and [Action] buttons should appear on RHS
   - Clicking [Visualise] should switch to Visualise view
   - Clicking [Action] should open Resources panel with Pure Stats

2. In Visualise view:
   - [Editor] and [Action] buttons should appear
   - Clicking [Editor] should switch back to text editor

3. In Stats view (after selecting a test from Resources):
   - [Visualise], [Editor], and [Action] buttons should appear

4. Open a Python strategy file:
   - [Chart] [Action] [Trade] buttons should appear (unchanged)

5. Open a plain text file:
   - No QuantLab buttons should appear

6. Switch tabs between data file and strategy:
   - Buttons should update accordingly

## Dependencies
- Prompt 02 (context keys) must be complete

## Next
Proceed to `04_DataViewManager.md`
