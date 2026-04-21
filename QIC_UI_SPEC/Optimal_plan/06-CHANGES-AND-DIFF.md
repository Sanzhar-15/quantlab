# Phase 5: Changes & Diff System

**Duration:** 2 weeks | **Depends on:** Phase 4 (Context)

---

## Overview

This phase implements the change summary, diff preview, CodeLens integration, and unified review mode as specified in sections 6 and 7 of the UI spec.

---

## 1. Change Summary Card

### 1.1 Single File (File Open)

When the changed file is already open, show summary only:

```html
<div class="qic-change-summary">
    <div class="qic-change-file">
        <span class="qic-change-icon">📄</span>
        <span class="qic-change-name">risk_metrics.py</span>
        <span class="qic-change-stats">
            <span class="qic-stat-add">+12</span>
            <span class="qic-stat-del">-3</span>
        </span>
    </div>
    <button class="qic-change-action" data-action="jump">Jump to code</button>
</div>
```

### 1.2 Single File (File Closed)

When file is closed, show inline diff:

```html
<div class="qic-change-card">
    <div class="qic-change-header">
        <span class="qic-change-icon">📄</span>
        <span class="qic-change-name">risk_metrics.py</span>
        <span class="qic-change-stats">
            <span class="qic-stat-add">+12</span>
            <span class="qic-stat-del">-3</span>
        </span>
    </div>
    <div class="qic-diff-preview">
        <pre class="qic-diff-content">
<span class="qic-diff-del">-    return returns.mean() / returns.std()</span>
<span class="qic-diff-add">+    excess = returns - risk_free_rate</span>
<span class="qic-diff-add">+    return excess.mean() / excess.std()</span>
        </pre>
    </div>
    <div class="qic-change-actions">
        <button class="qic-btn qic-btn-primary" data-action="accept">Accept</button>
        <button class="qic-btn qic-btn-secondary" data-action="reject">Reject</button>
        <button class="qic-btn qic-btn-ghost" data-action="open">Open file</button>
    </div>
</div>
```

### 1.3 Multi-File with Groups

```html
<div class="qic-change-group-card">
    <!-- Core Logic Group -->
    <div class="qic-change-group">
        <div class="qic-group-header">
            <span class="qic-group-name">CORE LOGIC</span>
            <button class="qic-btn qic-btn-sm" data-action="accept-group">Accept group</button>
        </div>
        <ul class="qic-group-files">
            <li class="qic-group-file" data-status="pending">
                <span class="qic-file-status">→</span>
                <span class="qic-file-name">risk_metrics.py</span>
                <span class="qic-file-stats">+12 -3</span>
            </li>
            <li class="qic-group-file" data-status="pending">
                <span class="qic-file-status">○</span>
                <span class="qic-file-name">models/position.py</span>
                <span class="qic-file-stats">+5 -2</span>
            </li>
        </ul>
    </div>

    <!-- Tests Group -->
    <div class="qic-change-group">
        <div class="qic-group-header">
            <span class="qic-group-name">TESTS</span>
            <button class="qic-btn qic-btn-sm" data-action="accept-group">Accept group</button>
        </div>
        <ul class="qic-group-files">
            <li class="qic-group-file" data-status="pending">
                <span class="qic-file-status">○</span>
                <span class="qic-file-name">tests/test_risk.py</span>
                <span class="qic-file-stats">+45 -0</span>
            </li>
        </ul>
    </div>

    <!-- Global Actions -->
    <div class="qic-change-footer">
        <button class="qic-btn qic-btn-primary" data-action="accept-all">Accept all</button>
        <button class="qic-btn qic-btn-danger" data-action="reject-all">Reject all</button>
        <button class="qic-btn qic-btn-secondary" data-action="review">Review all</button>
    </div>
</div>
```

### 1.4 Partial Failure

```html
<div class="qic-change-failure">
    <div class="qic-failure-header">
        <span class="qic-failure-icon">⚠</span>
        <span class="qic-failure-text">2 of 4 files applied. 2 failed:</span>
    </div>
    <ul class="qic-failure-list">
        <li class="qic-failure-item">
            <span class="qic-failure-status">✗</span>
            <span class="qic-failure-name">config.json</span>
            <span class="qic-failure-reason">— File is locked</span>
        </li>
        <li class="qic-failure-item">
            <span class="qic-failure-status">✗</span>
            <span class="qic-failure-name">utils.py</span>
            <span class="qic-failure-reason">— Merge conflict</span>
        </li>
    </ul>
    <div class="qic-failure-actions">
        <button class="qic-btn" data-action="retry-failed">Retry failed</button>
        <button class="qic-btn" data-action="skip-failed">Skip failed</button>
        <button class="qic-btn qic-btn-ghost" data-action="view-details">View details</button>
    </div>
</div>
```

---

## 2. CSS for Change Cards

```css
/* Change Summary */
.qic-change-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--qic-space-2) var(--qic-space-3);
    background: var(--qic-bg-secondary);
    border-radius: var(--qic-radius-md);
    border-left: 3px solid var(--qic-status-success);
}

.qic-change-file {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
}

.qic-change-stats {
    display: flex;
    gap: var(--qic-space-1);
    font-size: var(--qic-text-xs);
    font-variant-numeric: tabular-nums;
}

.qic-stat-add { color: var(--qic-status-success); }
.qic-stat-del { color: var(--qic-status-error); }

/* Change Card */
.qic-change-card {
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
    overflow: hidden;
}

.qic-change-header {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    background: var(--qic-bg-secondary);
    border-bottom: 1px solid var(--qic-border-default);
}

.qic-diff-preview {
    max-height: 200px;
    overflow-y: auto;
    background: var(--qic-bg-primary);
}

.qic-diff-content {
    margin: 0;
    padding: var(--qic-space-2) var(--qic-space-3);
    font-family: var(--qic-font-mono);
    font-size: var(--qic-text-sm);
    line-height: 1.5;
}

.qic-diff-add {
    display: block;
    background: var(--qic-diff-add-line);
    color: var(--qic-status-success);
}

.qic-diff-del {
    display: block;
    background: var(--qic-diff-remove-line);
    color: var(--qic-status-error);
}

.qic-change-actions {
    display: flex;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    border-top: 1px solid var(--qic-border-default);
}

/* Change Groups */
.qic-change-group-card {
    border: 1px solid var(--qic-border-default);
    border-radius: var(--qic-radius-md);
}

.qic-change-group {
    padding: var(--qic-space-2) var(--qic-space-3);
}

.qic-change-group:not(:last-child) {
    border-bottom: 1px solid var(--qic-border-default);
}

.qic-group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--qic-space-2);
}

.qic-group-name {
    font-size: var(--qic-text-xs);
    font-weight: 600;
    color: var(--qic-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.qic-group-files {
    list-style: none;
    padding: 0;
    margin: 0;
}

.qic-group-file {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-1) 0;
    font-size: var(--qic-text-sm);
}

.qic-file-status {
    width: 16px;
    text-align: center;
    color: var(--qic-fg-muted);
}

.qic-group-file[data-status="accepted"] .qic-file-status {
    color: var(--qic-status-success);
}

.qic-group-file[data-status="rejected"] .qic-file-status {
    color: var(--qic-status-error);
}

.qic-file-name {
    flex: 1;
}

.qic-file-stats {
    font-size: var(--qic-text-xs);
    color: var(--qic-fg-muted);
}

.qic-change-footer {
    display: flex;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    border-top: 1px solid var(--qic-border-default);
}

/* Failure Card */
.qic-change-failure {
    padding: var(--qic-space-3);
    background: var(--qic-status-warning-bg);
    border: 1px solid var(--qic-status-warning);
    border-radius: var(--qic-radius-md);
}

.qic-failure-header {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    margin-bottom: var(--qic-space-2);
    font-weight: 500;
}

.qic-failure-list {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--qic-space-2);
}

.qic-failure-item {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-1) 0;
    font-size: var(--qic-text-sm);
}

.qic-failure-status {
    color: var(--qic-status-error);
}

.qic-failure-reason {
    color: var(--qic-fg-muted);
}

.qic-failure-actions {
    display: flex;
    gap: var(--qic-space-2);
}
```

---

## 3. CodeLens Integration

### 3.1 CodeLens Provider

```typescript
// src/vs/workbench/contrib/qic/browser/codeLens/qicCodeLensProvider.ts

import * as vscode from 'vscode';
import { IQicStateService } from '../../common/state/qicStateService';

export class QicCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(private readonly stateService: IQicStateService) {
        stateService.onDidChangeState(patch => {
            if (patch.path.includes('pendingChanges')) {
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const pendingChanges = this.stateService.state.conversation.pendingChanges;
        if (!pendingChanges) return [];

        const fileChange = pendingChanges.changes.find(
            c => c.file === document.uri.fsPath && c.status === 'pending'
        );
        if (!fileChange) return [];

        const lenses: vscode.CodeLens[] = [];

        // Add lens at each hunk
        for (const hunk of fileChange.hunks) {
            const range = new vscode.Range(
                hunk.newStart - 1, 0,
                hunk.newStart - 1, 0
            );

            lenses.push(
                new vscode.CodeLens(range, {
                    title: '✓ Accept',
                    command: 'qic.acceptHunk',
                    arguments: [pendingChanges.id, fileChange.id, hunk]
                }),
                new vscode.CodeLens(range, {
                    title: '✗ Reject',
                    command: 'qic.rejectHunk',
                    arguments: [pendingChanges.id, fileChange.id, hunk]
                }),
                new vscode.CodeLens(range, {
                    title: '? Explain',
                    command: 'qic.explainHunk',
                    arguments: [pendingChanges.id, fileChange.id, hunk]
                })
            );
        }

        // Add file-level lens at top
        lenses.unshift(
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: `QIC: ${fileChange.description || 'Pending changes'}`,
                command: ''
            })
        );

        return lenses;
    }
}
```

### 3.2 Diff Decorations

```typescript
// src/vs/workbench/contrib/qic/browser/decorations/qicDiffDecorations.ts

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'var(--qic-diff-add-line)',
    isWholeLine: true,
    gutterIconPath: /* + icon */,
    gutterIconSize: '75%'
});

const removedLineDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'var(--qic-diff-remove-line)',
    isWholeLine: true,
    gutterIconPath: /* - icon */,
    gutterIconSize: '75%'
});

const addedWordDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'var(--qic-diff-add-word)'
});

const removedWordDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'var(--qic-diff-remove-word)'
});

export function applyDiffDecorations(
    editor: vscode.TextEditor,
    hunks: DiffHunk[]
): void {
    const addedLines: vscode.Range[] = [];
    const removedLines: vscode.Range[] = [];

    for (const hunk of hunks) {
        // Parse hunk content and create ranges
        // ... implementation
    }

    editor.setDecorations(addedLineDecoration, addedLines);
    editor.setDecorations(removedLineDecoration, removedLines);
}
```

---

## 4. Unified Review Mode

### 4.1 Review Mode Command

```typescript
// src/vs/workbench/contrib/qic/browser/reviewMode/reviewModeController.ts

export class ReviewModeController {
    private currentFileIndex = 0;
    private currentHunkIndex = 0;
    private files: Change[] = [];

    constructor(
        private readonly stateService: IQicStateService,
        private readonly editorService: IEditorService
    ) {}

    async enterReviewMode(): Promise<void> {
        const pendingChanges = this.stateService.state.conversation.pendingChanges;
        if (!pendingChanges) return;

        this.files = pendingChanges.changes.filter(c => c.status === 'pending');
        if (this.files.length === 0) return;

        this.currentFileIndex = 0;
        this.currentHunkIndex = 0;

        await this.openCurrentFile();
        this.registerKeyBindings();
    }

    private async openCurrentFile(): Promise<void> {
        const file = this.files[this.currentFileIndex];
        const editor = await this.editorService.openEditor({
            resource: URI.file(file.file)
        });

        // Apply decorations
        applyDiffDecorations(editor, file.hunks);

        // Jump to first hunk
        this.jumpToHunk(0);
    }

    private jumpToHunk(index: number): void {
        const file = this.files[this.currentFileIndex];
        const hunk = file.hunks[index];
        if (!hunk) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const position = new vscode.Position(hunk.newStart - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    }

    // Navigation
    nextFile(): void {
        if (this.currentFileIndex < this.files.length - 1) {
            this.currentFileIndex++;
            this.currentHunkIndex = 0;
            this.openCurrentFile();
        }
    }

    previousFile(): void {
        if (this.currentFileIndex > 0) {
            this.currentFileIndex--;
            this.currentHunkIndex = 0;
            this.openCurrentFile();
        }
    }

    nextHunk(): void {
        const file = this.files[this.currentFileIndex];
        if (this.currentHunkIndex < file.hunks.length - 1) {
            this.currentHunkIndex++;
            this.jumpToHunk(this.currentHunkIndex);
        } else {
            this.nextFile();
        }
    }

    previousHunk(): void {
        if (this.currentHunkIndex > 0) {
            this.currentHunkIndex--;
            this.jumpToHunk(this.currentHunkIndex);
        } else {
            this.previousFile();
        }
    }

    // Actions
    acceptCurrentFile(): void {
        const file = this.files[this.currentFileIndex];
        this.stateService.updateChangeStatus(
            this.stateService.state.conversation.pendingChanges!.id,
            file.id,
            'accepted'
        );
        this.nextFile();
    }

    rejectCurrentFile(): void {
        const file = this.files[this.currentFileIndex];
        this.stateService.updateChangeStatus(
            this.stateService.state.conversation.pendingChanges!.id,
            file.id,
            'rejected'
        );
        this.nextFile();
    }

    acceptAll(): void {
        for (const file of this.files) {
            this.stateService.updateChangeStatus(
                this.stateService.state.conversation.pendingChanges!.id,
                file.id,
                'accepted'
            );
        }
        this.exitReviewMode();
    }

    exitReviewMode(): void {
        // Clear decorations, unregister keybindings
    }
}
```

### 4.2 Review Mode Keybindings

```typescript
// Register keybindings when in review mode
const reviewModeContext = ContextKeyExpr.equals('qicReviewModeActive', true);

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.reviewMode.nextFile',
            title: 'Next File',
            keybinding: {
                primary: KeyCode.F7,
                weight: KeybindingWeight.WorkbenchContrib,
                when: reviewModeContext
            }
        });
    }
    run(accessor: ServicesAccessor): void {
        accessor.get(IReviewModeController).nextFile();
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.reviewMode.previousFile',
            title: 'Previous File',
            keybinding: {
                primary: KeyMod.Shift | KeyCode.F7,
                weight: KeybindingWeight.WorkbenchContrib,
                when: reviewModeContext
            }
        });
    }
    run(accessor: ServicesAccessor): void {
        accessor.get(IReviewModeController).previousFile();
    }
});

// Tab/Shift+Tab for hunks
// J/K for vim-style navigation
// A to accept, R to reject
// Cmd+Enter to accept all
// Escape to exit
```

---

## 5. Strategy File Warning

### 5.1 Warning Banner

```html
<div class="qic-strategy-warning" role="alert">
    <span class="qic-warning-icon">⚠</span>
    <span class="qic-warning-text">Strategy File — Changes may affect live trading</span>
</div>
```

### 5.2 CSS

```css
.qic-strategy-warning {
    display: flex;
    align-items: center;
    gap: var(--qic-space-2);
    padding: var(--qic-space-2) var(--qic-space-3);
    background: var(--qic-strategy-bg);
    border: 1px solid var(--qic-strategy-border);
    border-radius: var(--qic-radius-md);
    font-size: var(--qic-text-sm);
    color: var(--qic-strategy-border);
}

.qic-warning-icon {
    font-size: 16px;
}
```

---

## 6. Checklist

### Change Summary UI
- [ ] Single file summary (file open)
- [ ] Single file with diff (file closed)
- [ ] Multi-file grouped view
- [ ] Partial failure handling
- [ ] Accept/reject actions

### CodeLens
- [ ] CodeLens provider implementation
- [ ] Accept/Reject/Explain commands
- [ ] Hunk-level and file-level lenses
- [ ] Update on state changes

### Diff Decorations
- [ ] Added line decoration
- [ ] Removed line decoration
- [ ] Word-level highlighting
- [ ] Gutter icons

### Review Mode
- [ ] Enter review mode command (Cmd+Shift+R)
- [ ] File navigation (F7/Shift+F7)
- [ ] Hunk navigation (Tab/Shift+Tab)
- [ ] Accept/reject actions
- [ ] Exit review mode

### Strategy Warning
- [ ] Detect strategy files
- [ ] Show warning banner
- [ ] Confirmation modal
- [ ] "Don't ask again" option
