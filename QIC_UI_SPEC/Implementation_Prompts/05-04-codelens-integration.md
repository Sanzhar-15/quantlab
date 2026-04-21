# Prompt 05-04: CodeLens Integration

**Phase:** 5 - Changes & Diff
**Dependencies:** 05-02 (Diff View)
**Estimated Effort:** 1 session
**Critical Path:** No

---

## Objective

Add CodeLens indicators to files that have pending QIC changes, showing inline actions to view diff, apply, or reject changes directly from the editor without opening the QIC panel.

---

## Context

CodeLens provides inline actions above code sections:
- Shows "QIC: View Changes" above modified sections
- Quick Apply/Reject without leaving the editor
- Visual indicator of pending changes
- Links to the relevant change card

This improves the workflow for users who prefer staying in the editor.

Reference: `QIC_UI_SPEC/Optimal_plan/09-CHANGES-DIFF.md`

---

## Scope

### In Scope
- Create CodeLens provider for QIC changes
- Show CodeLens above changed sections
- Add View/Apply/Reject actions
- Track which files have pending changes
- Update CodeLens when changes are applied/rejected
- Support multiple changes per file

### Out of Scope
- CodeLens for other QIC features
- Gutter decorations (future)
- Inline change preview

---

## Pre-Conditions

- [ ] 05-02 complete (Diff View)
- [ ] Change cards and state working
- [ ] Git branch created: `qic-ui/05-04-codelens`

---

## Tasks

### 1. Create CodeLens Provider

```typescript
// src/vs/workbench/contrib/qic/browser/qicCodeLensProvider.ts

import { Disposable } from 'vs/base/common/lifecycle';
import { ICodeLensProvider, CodeLens } from 'vs/editor/common/languages';
import { ITextModel } from 'vs/editor/common/model';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IQicStateService, FileChange, ChangeSet } from '../common/state/qicStateService.js';
import { Range } from 'vs/editor/common/core/range';
import { localize } from 'vs/nls';
import { URI } from 'vs/base/common/uri';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';

interface QicCodeLens extends CodeLens {
  changeId: string;
  changeType: string;
}

export class QicCodeLensProvider extends Disposable implements ICodeLensProvider {
  private readonly onDidChangeEmitter = new Emitter<this>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    @IQicStateService private readonly stateService: IQicStateService,
    @ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
  ) {
    super();

    // Register the provider
    this._register(
      languageFeaturesService.codeLensProvider.register(
        { pattern: '**/*' }, // All files
        this
      )
    );

    // Update CodeLens when changes update
    this._register(
      this.stateService.onDidChangeState((patch) => {
        if (patch.path === 'changeSets' || patch.path === '*') {
          this.onDidChangeEmitter.fire(this);
        }
      })
    );
  }

  /**
   * Provide CodeLens for a document
   */
  provideCodeLenses(model: ITextModel, token: CancellationToken): CodeLens[] {
    const uri = model.uri;
    const filePath = uri.fsPath;

    // Find pending changes for this file
    const pendingChanges = this.getPendingChangesForFile(filePath);

    if (pendingChanges.length === 0) {
      return [];
    }

    const lenses: QicCodeLens[] = [];

    for (const change of pendingChanges) {
      // Determine the line to show CodeLens
      const line = this.getCodeLensLine(change, model);

      // Create the CodeLens
      const range = new Range(line, 1, line, 1);

      // View changes lens
      lenses.push({
        range,
        changeId: change.id,
        changeType: change.type,
        command: {
          id: 'qic.showDiff',
          title: this.getViewTitle(change),
          arguments: [change.id],
        },
      });

      // Apply lens
      lenses.push({
        range,
        changeId: change.id,
        changeType: change.type,
        command: {
          id: 'qic.applyChange',
          title: localize('qic.codelens.apply', 'Apply'),
          arguments: [change.id],
        },
      });

      // Reject lens
      lenses.push({
        range,
        changeId: change.id,
        changeType: change.type,
        command: {
          id: 'qic.rejectChange',
          title: localize('qic.codelens.reject', 'Reject'),
          arguments: [change.id],
        },
      });
    }

    return lenses;
  }

  /**
   * Resolve CodeLens (add tooltip etc.)
   */
  resolveCodeLens(model: ITextModel, codeLens: CodeLens, token: CancellationToken): CodeLens {
    // CodeLens is already complete
    return codeLens;
  }

  /**
   * Get pending changes for a file path
   */
  private getPendingChangesForFile(filePath: string): FileChange[] {
    const changes: FileChange[] = [];

    for (const changeSet of this.stateService.state.changeSets || []) {
      for (const change of changeSet.changes) {
        if (change.status === 'pending' && this.matchesPath(change, filePath)) {
          changes.push(change);
        }
      }
    }

    return changes;
  }

  /**
   * Check if change matches file path
   */
  private matchesPath(change: FileChange, filePath: string): boolean {
    // Normalize paths for comparison
    const changePath = change.path.replace(/\\/g, '/');
    const normalizedFilePath = filePath.replace(/\\/g, '/');

    return changePath === normalizedFilePath ||
           changePath.endsWith(normalizedFilePath) ||
           normalizedFilePath.endsWith(changePath);
  }

  /**
   * Determine which line to show CodeLens
   */
  private getCodeLensLine(change: FileChange, model: ITextModel): number {
    // For modifications, show at the first changed line
    if (change.hunks && change.hunks.length > 0) {
      const firstHunk = change.hunks[0];
      return Math.max(1, firstHunk.newStart);
    }

    // For new files, show at line 1
    if (change.type === 'create') {
      return 1;
    }

    // For deletions, show at line 1
    if (change.type === 'delete') {
      return 1;
    }

    // Default to line 1
    return 1;
  }

  /**
   * Get title for view changes lens
   */
  private getViewTitle(change: FileChange): string {
    const stats = `+${change.additions} -${change.deletions}`;

    switch (change.type) {
      case 'create':
        return localize('qic.codelens.newFile', 'QIC: New file ({0})', stats);
      case 'modify':
        return localize('qic.codelens.modified', 'QIC: Modified ({0})', stats);
      case 'delete':
        return localize('qic.codelens.delete', 'QIC: Delete this file');
      case 'rename':
        return localize('qic.codelens.rename', 'QIC: Rename to {0}', change.newPath);
      default:
        return localize('qic.codelens.changes', 'QIC: View changes ({0})', stats);
    }
  }
}
```

### 2. Register CodeLens Commands

```typescript
// In qic.contribution.ts

// Apply change command (for CodeLens)
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.applyChange',
      title: localize('qic.applyChange', 'QIC: Apply Change'),
      category: 'QIC',
    });
  }

  async run(accessor: ServicesAccessor, changeId?: string): Promise<void> {
    if (!changeId) return;

    const stateService = accessor.get(IQicStateService);
    const notificationService = accessor.get(INotificationService);

    try {
      await stateService.applyChange(changeId);
      notificationService.info(localize('qic.changeApplied', 'Change applied successfully.'));
    } catch (error) {
      notificationService.error(
        localize('qic.applyError', 'Failed to apply change: {0}', error.message)
      );
    }
  }
});

// Reject change command (for CodeLens)
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.rejectChange',
      title: localize('qic.rejectChange', 'QIC: Reject Change'),
      category: 'QIC',
    });
  }

  async run(accessor: ServicesAccessor, changeId?: string): Promise<void> {
    if (!changeId) return;

    const stateService = accessor.get(IQicStateService);
    const notificationService = accessor.get(INotificationService);

    stateService.rejectChange(changeId);
    notificationService.info(localize('qic.changeRejected', 'Change rejected.'));
  }
});
```

### 3. Register CodeLens Provider

```typescript
// In qic.contribution.ts

import { QicCodeLensProvider } from './qicCodeLensProvider.js';

// Register as workbench contribution
workbench.registerWorkbenchContribution2(
  'qic.codeLensProvider',
  QicCodeLensProvider,
  WorkbenchPhase.AfterRestored
);
```

### 4. Add Configuration Option

```typescript
// Allow users to disable CodeLens

// In qic.configuration.ts
const configuration: IConfigurationNode = {
  id: 'qic',
  title: 'QIC',
  properties: {
    'qic.enableCodeLens': {
      type: 'boolean',
      default: true,
      description: localize('qic.enableCodeLens', 'Show CodeLens for pending QIC changes'),
    },
  },
};

// In QicCodeLensProvider
private isEnabled(): boolean {
  return this.configurationService.getValue('qic.enableCodeLens') ?? true;
}

provideCodeLenses(model: ITextModel, token: CancellationToken): CodeLens[] {
  if (!this.isEnabled()) {
    return [];
  }
  // ... rest of implementation
}
```

### 5. Add Editor Decorations (Enhancement)

```typescript
// Optional: Add gutter decorations for changed lines

class QicEditorDecorations extends Disposable {
  private decorations = new Map<string, string[]>();

  constructor(
    @ICodeEditorService private readonly codeEditorService: ICodeEditorService,
    @IQicStateService private readonly stateService: IQicStateService,
  ) {
    super();

    // Watch for editor changes
    this._register(
      this.codeEditorService.onCodeEditorAdd((editor) => {
        this.updateDecorations(editor);
      })
    );

    // Watch for state changes
    this._register(
      this.stateService.onDidChangeState(() => {
        this.updateAllDecorations();
      })
    );
  }

  private updateAllDecorations(): void {
    for (const editor of this.codeEditorService.listCodeEditors()) {
      this.updateDecorations(editor);
    }
  }

  private updateDecorations(editor: ICodeEditor): void {
    const model = editor.getModel();
    if (!model) return;

    const filePath = model.uri.fsPath;
    const changes = this.getPendingChangesForFile(filePath);

    if (changes.length === 0) {
      // Clear decorations
      const existing = this.decorations.get(filePath);
      if (existing) {
        editor.deltaDecorations(existing, []);
        this.decorations.delete(filePath);
      }
      return;
    }

    // Build decorations for changed lines
    const newDecorations: IModelDeltaDecoration[] = [];

    for (const change of changes) {
      if (change.hunks) {
        for (const hunk of change.hunks) {
          // Mark each changed line
          for (let i = 0; i < hunk.newLines; i++) {
            const line = hunk.newStart + i;
            newDecorations.push({
              range: new Range(line, 1, line, 1),
              options: {
                isWholeLine: true,
                glyphMarginClassName: 'qic-change-glyph',
                overviewRuler: {
                  color: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
                  position: OverviewRulerLane.Left,
                },
              },
            });
          }
        }
      }
    }

    // Apply decorations
    const existing = this.decorations.get(filePath) || [];
    const ids = editor.deltaDecorations(existing, newDecorations);
    this.decorations.set(filePath, ids);
  }
}
```

### 6. Add CSS for Decorations

```css
/* In qic.css or editor styles */

.qic-change-glyph {
  background-color: var(--vscode-gitDecoration-modifiedResourceForeground);
  width: 3px !important;
  margin-left: 3px;
}

.qic-change-glyph::before {
  content: '';
  display: block;
  width: 3px;
  height: 100%;
  background: var(--vscode-gitDecoration-modifiedResourceForeground);
}
```

---

## Verification

### Success Criteria
- [ ] CodeLens appears above changed sections
- [ ] Shows change type (New/Modified/Delete/Rename)
- [ ] Shows addition/deletion stats
- [ ] "View" opens diff view
- [ ] "Apply" applies the change
- [ ] "Reject" rejects the change
- [ ] CodeLens disappears after apply/reject
- [ ] Multiple changes show multiple CodeLens
- [ ] Works with renamed files
- [ ] Can be disabled via settings

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| CodeLens appears | Open file with pending change | CodeLens visible |
| View from lens | Click "View" in CodeLens | Diff opens |
| Apply from lens | Click "Apply" | Change applied, lens gone |
| Reject from lens | Click "Reject" | Change rejected, lens gone |
| Multiple changes | File with 2 changes | 2 CodeLens sections |
| Disable setting | Set qic.enableCodeLens=false | No CodeLens |
| New file | Create new file via QIC | "New file" CodeLens |
| Delete file | Delete via QIC | "Delete" CodeLens |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/qicCodeLensProvider.ts
git checkout src/vs/workbench/contrib/qic/browser/qic.contribution.ts
```

---

## Notes

- CodeLens refresh automatically when state changes
- Positioned at first changed line or line 1
- Consider adding inline diff preview on hover
- Users can disable via settings if too noisy
- Works alongside other CodeLens providers
- Gutter decorations are optional enhancement

