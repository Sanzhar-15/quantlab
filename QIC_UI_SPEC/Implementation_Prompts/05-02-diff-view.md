# Prompt 05-02: Diff View

**Phase:** 5 - Changes & Diff
**Dependencies:** 05-01 (Change Cards UI)
**Estimated Effort:** 2 sessions
**Critical Path:** Yes

---

## Objective

Implement the diff view that shows detailed side-by-side or inline comparison of proposed changes. Users can view the full diff in VS Code's native diff editor, with syntax highlighting and navigation.

---

## Context

When users click "View Diff" on a change card, they should see:
- Full diff in VS Code's diff editor
- Side-by-side or inline view (user preference)
- Syntax highlighting for the file type
- Navigation between hunks
- Option to apply/reject from diff view

The diff view integrates with VS Code's native diff infrastructure for the best experience.

Reference: `QIC_UI_SPEC/Optimal_plan/09-CHANGES-DIFF.md`

---

## Scope

### In Scope
- Open VS Code diff editor for changes
- Create virtual documents for original/modified
- Support side-by-side and inline modes
- Add navigation commands
- Show change summary in diff title
- Handle new files (no original)
- Handle deleted files (no modified)
- Add Apply/Reject actions in diff editor

### Out of Scope
- Custom diff renderer (use VS Code's)
- Partial apply (apply individual hunks)
- Three-way merge
- Conflict resolution UI

---

## Pre-Conditions

- [ ] 05-01 complete (Change Cards)
- [ ] Change types defined
- [ ] Git branch created: `qic-ui/05-02-diff-view`

---

## Tasks

### 1. Create Virtual Document Provider

```typescript
// src/vs/workbench/contrib/qic/browser/diffDocumentProvider.ts

import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { ITextModelService, ITextModelContentProvider } from 'vs/editor/common/services/resolverService';
import { IModelService } from 'vs/editor/common/services/model';
import { IQicStateService, FileChange } from '../common/state/qicStateService.js';

export const QIC_ORIGINAL_SCHEME = 'qic-original';
export const QIC_MODIFIED_SCHEME = 'qic-modified';

/**
 * Provides virtual document content for diff views
 */
export class QicDiffDocumentProvider extends Disposable implements ITextModelContentProvider {
  constructor(
    @ITextModelService private readonly textModelService: ITextModelService,
    @IModelService private readonly modelService: IModelService,
    @IQicStateService private readonly stateService: IQicStateService,
  ) {
    super();

    // Register content providers for our schemes
    this._register(
      this.textModelService.registerTextModelContentProvider(QIC_ORIGINAL_SCHEME, this)
    );
    this._register(
      this.textModelService.registerTextModelContentProvider(QIC_MODIFIED_SCHEME, this)
    );
  }

  /**
   * Provide content for virtual documents
   */
  async provideTextContent(resource: URI): Promise<ITextModel | null> {
    const changeId = resource.path.substring(1); // Remove leading /
    const change = this.getChange(changeId);

    if (!change) {
      return null;
    }

    let content: string;

    if (resource.scheme === QIC_ORIGINAL_SCHEME) {
      // Original content
      content = change.originalContent || '';
    } else {
      // Modified content
      content = change.newContent || '';
    }

    // Get language from file extension
    const languageId = this.getLanguageId(change.path);

    // Create model
    const model = this.modelService.createModel(
      content,
      { languageId },
      resource
    );

    return model;
  }

  private getChange(changeId: string): FileChange | undefined {
    // Search through all change sets
    for (const changeSet of this.stateService.state.changeSets || []) {
      const change = changeSet.changes.find(c => c.id === changeId);
      if (change) {
        return change;
      }
    }
    return undefined;
  }

  private getLanguageId(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      cs: 'csharp',
      cpp: 'cpp',
      c: 'c',
      h: 'c',
      swift: 'swift',
      kt: 'kotlin',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      md: 'markdown',
      sql: 'sql',
      sh: 'shellscript',
    };
    return languageMap[ext] || 'plaintext';
  }
}
```

### 2. Create Diff Editor Service

```typescript
// src/vs/workbench/contrib/qic/browser/qicDiffService.ts

import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { URI } from 'vs/base/common/uri';
import { IQicStateService, FileChange } from '../common/state/qicStateService.js';
import { QIC_ORIGINAL_SCHEME, QIC_MODIFIED_SCHEME } from './diffDocumentProvider.js';
import { localize } from 'vs/nls';

export interface IQicDiffService {
  showDiff(changeId: string): Promise<void>;
  showDiffForChange(change: FileChange): Promise<void>;
}

export class QicDiffService implements IQicDiffService {
  constructor(
    @IEditorService private readonly editorService: IEditorService,
    @IQicStateService private readonly stateService: IQicStateService,
  ) {}

  /**
   * Show diff for a change by ID
   */
  async showDiff(changeId: string): Promise<void> {
    const change = this.findChange(changeId);
    if (!change) {
      throw new Error(`Change not found: ${changeId}`);
    }
    await this.showDiffForChange(change);
  }

  /**
   * Show diff for a change object
   */
  async showDiffForChange(change: FileChange): Promise<void> {
    const originalUri = this.getOriginalUri(change);
    const modifiedUri = this.getModifiedUri(change);

    const title = this.getDiffTitle(change);
    const description = this.getDiffDescription(change);

    // Open diff editor
    await this.editorService.openEditor({
      original: { resource: originalUri },
      modified: { resource: modifiedUri },
      label: title,
      description,
      options: {
        pinned: false,
        preserveFocus: false,
      }
    });
  }

  private getOriginalUri(change: FileChange): URI {
    if (change.type === 'create') {
      // New file - empty original
      return URI.from({
        scheme: QIC_ORIGINAL_SCHEME,
        path: `/${change.id}`,
        query: 'empty=true'
      });
    }

    return URI.from({
      scheme: QIC_ORIGINAL_SCHEME,
      path: `/${change.id}`
    });
  }

  private getModifiedUri(change: FileChange): URI {
    if (change.type === 'delete') {
      // Deleted file - empty modified
      return URI.from({
        scheme: QIC_MODIFIED_SCHEME,
        path: `/${change.id}`,
        query: 'empty=true'
      });
    }

    return URI.from({
      scheme: QIC_MODIFIED_SCHEME,
      path: `/${change.id}`
    });
  }

  private getDiffTitle(change: FileChange): string {
    const filename = change.path.split('/').pop() || change.path;

    switch (change.type) {
      case 'create':
        return localize('qic.diff.create', '{0} (New File)', filename);
      case 'delete':
        return localize('qic.diff.delete', '{0} (Delete)', filename);
      case 'rename':
        const newFilename = change.newPath?.split('/').pop() || change.newPath;
        return localize('qic.diff.rename', '{0} → {1}', filename, newFilename);
      default:
        return filename;
    }
  }

  private getDiffDescription(change: FileChange): string {
    return `QIC: +${change.additions} -${change.deletions}`;
  }

  private findChange(changeId: string): FileChange | undefined {
    for (const changeSet of this.stateService.state.changeSets || []) {
      const change = changeSet.changes.find(c => c.id === changeId);
      if (change) {
        return change;
      }
    }
    return undefined;
  }
}
```

### 3. Register Diff Commands

```typescript
// In qic.contribution.ts

import { IQicDiffService } from './qicDiffService.js';

// Show diff command
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.showDiff',
      title: localize('qic.showDiff', 'QIC: Show Diff'),
      category: 'QIC',
    });
  }

  async run(accessor: ServicesAccessor, changeId?: string): Promise<void> {
    if (!changeId) return;

    const diffService = accessor.get(IQicDiffService);
    await diffService.showDiff(changeId);
  }
});

// Navigate to next change
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.nextChange',
      title: localize('qic.nextChange', 'QIC: Next Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.Alt | KeyCode.BracketRight,
        when: ContextKeyExpr.equals('qic.inDiffView', true),
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const diffService = accessor.get(IQicDiffService);
    // Navigate to next change in current diff or next file
    // Implementation depends on diff navigation API
  }
});

// Navigate to previous change
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.previousChange',
      title: localize('qic.previousChange', 'QIC: Previous Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.Alt | KeyCode.BracketLeft,
        when: ContextKeyExpr.equals('qic.inDiffView', true),
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const diffService = accessor.get(IQicDiffService);
    // Navigate to previous change
  }
});

// Apply from diff view
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.applyFromDiff',
      title: localize('qic.applyFromDiff', 'QIC: Apply This Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
        when: ContextKeyExpr.equals('qic.inDiffView', true),
      },
      menu: {
        id: MenuId.EditorTitle,
        when: ContextKeyExpr.equals('qic.inDiffView', true),
        group: 'qic',
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService);
    const stateService = accessor.get(IQicStateService);

    // Get change ID from current diff editor
    const activeEditor = editorService.activeEditor;
    if (activeEditor instanceof DiffEditorInput) {
      const modifiedUri = activeEditor.modified.resource;
      if (modifiedUri?.scheme === QIC_MODIFIED_SCHEME) {
        const changeId = modifiedUri.path.substring(1);
        // Apply the change
        await stateService.applyChange(changeId);
      }
    }
  }
});

// Reject from diff view
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.rejectFromDiff',
      title: localize('qic.rejectFromDiff', 'QIC: Reject This Change'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
        when: ContextKeyExpr.equals('qic.inDiffView', true),
      },
      menu: {
        id: MenuId.EditorTitle,
        when: ContextKeyExpr.equals('qic.inDiffView', true),
        group: 'qic',
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService);
    const stateService = accessor.get(IQicStateService);

    const activeEditor = editorService.activeEditor;
    if (activeEditor instanceof DiffEditorInput) {
      const modifiedUri = activeEditor.modified.resource;
      if (modifiedUri?.scheme === QIC_MODIFIED_SCHEME) {
        const changeId = modifiedUri.path.substring(1);
        stateService.rejectChange(changeId);
        // Close the diff editor
        await editorService.closeEditor(activeEditor);
      }
    }
  }
});
```

### 4. Add Diff Toolbar Actions

```typescript
// Add toolbar buttons to diff editor when viewing QIC changes

MenuRegistry.appendMenuItems([
  {
    id: MenuId.EditorTitle,
    item: {
      command: {
        id: 'qic.applyFromDiff',
        title: localize('qic.apply', 'Apply'),
      },
      group: 'qic',
      order: 1,
      when: ContextKeyExpr.equals('qic.inDiffView', true),
    },
  },
  {
    id: MenuId.EditorTitle,
    item: {
      command: {
        id: 'qic.rejectFromDiff',
        title: localize('qic.reject', 'Reject'),
      },
      group: 'qic',
      order: 2,
      when: ContextKeyExpr.equals('qic.inDiffView', true),
    },
  },
]);
```

### 5. Track Diff View Context

```typescript
// Set context key when in QIC diff view

class QicDiffContextTracker extends Disposable {
  private readonly inDiffViewKey: IContextKey<boolean>;

  constructor(
    @IEditorService private readonly editorService: IEditorService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super();

    this.inDiffViewKey = contextKeyService.createKey('qic.inDiffView', false);

    this._register(
      this.editorService.onDidActiveEditorChange(() => {
        this.updateContext();
      })
    );
  }

  private updateContext(): void {
    const activeEditor = this.editorService.activeEditor;

    if (activeEditor instanceof DiffEditorInput) {
      const modifiedUri = activeEditor.modified.resource;
      const isQicDiff = modifiedUri?.scheme === QIC_MODIFIED_SCHEME ||
                        modifiedUri?.scheme === QIC_ORIGINAL_SCHEME;
      this.inDiffViewKey.set(isQicDiff);
    } else {
      this.inDiffViewKey.set(false);
    }
  }
}
```

### 6. Add Inline Preview in Panel (Optional)

For quick preview without opening editor:

```typescript
// In qicPanel.ts - Add inline diff preview

private async showInlineDiffPreview(changeId: string): Promise<void> {
  const change = this.findChange(changeId);
  if (!change) return;

  // Generate unified diff
  const unifiedDiff = this.generateUnifiedDiff(change);

  // Send to webview for display
  this.postMessage({
    type: 'change:inlinePreview',
    changeId,
    diff: unifiedDiff,
  });
}

private generateUnifiedDiff(change: FileChange): string {
  if (!change.hunks || change.hunks.length === 0) {
    return '';
  }

  const header = `--- a/${change.path}\n+++ b/${change.newPath || change.path}\n`;
  const hunks = change.hunks.map(hunk => {
    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    return hunkHeader + hunk.content;
  }).join('\n');

  return header + hunks;
}
```

---

## Verification

### Success Criteria
- [ ] View Diff opens VS Code diff editor
- [ ] Original content shows on left
- [ ] Modified content shows on right
- [ ] Syntax highlighting works
- [ ] New file shows empty left side
- [ ] Deleted file shows empty right side
- [ ] Rename shows both paths in title
- [ ] Apply button in diff toolbar works
- [ ] Reject button in diff toolbar works
- [ ] Keyboard shortcuts work in diff
- [ ] Diff closes after apply/reject
- [ ] Changes stats show in description

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Open diff | Click View Diff | Diff editor opens |
| New file | View diff for create | Empty left, content right |
| Modified | View diff for modify | Both sides show |
| Deleted | View diff for delete | Content left, empty right |
| Renamed | View diff for rename | Both paths in title |
| Apply from diff | Ctrl+Shift+A | Change applied |
| Reject from diff | Ctrl+Shift+R | Change rejected, editor closes |
| Syntax highlight | Open .ts diff | TypeScript highlighting |
| Large file | Open big file diff | Performs well |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/
rm src/vs/workbench/contrib/qic/browser/diffDocumentProvider.ts
rm src/vs/workbench/contrib/qic/browser/qicDiffService.ts
```

---

## Notes

- Uses VS Code's native diff editor for best experience
- Virtual documents avoid writing temp files
- Content is cached in state service
- Consider adding inline diff view in panel for quick preview
- Keyboard shortcuts match VS Code's diff navigation
- Apply/Reject buttons appear in editor title bar

