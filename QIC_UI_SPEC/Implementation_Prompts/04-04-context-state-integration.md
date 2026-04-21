# Prompt 04-04: Context State Integration

**Phase:** 4 - Context System
**Dependencies:** 04-01, 04-02, 04-03
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Integrate the context system components (chips, drawer, autocomplete) with the state service, ensuring context items are persisted, synchronized between webview and extension, and included in LLM requests.

---

## Context

The context state integration provides:
- Context items stored in state service
- Synchronization between webview and extension
- Persistence across sessions
- Context included in LLM messages
- Recent context tracking
- Token budget management

This prompt connects all the context UI components to the backend state management.

Reference: `QIC_UI_SPEC/Optimal_plan/08-CONTEXT-SYSTEM.md`

---

## Scope

### In Scope
- Add context state to IQicStateService
- Implement context CRUD operations
- Sync context between webview and extension
- Include context in message construction
- Track recent context items
- Implement context persistence
- Handle context token budgets
- Wire context to LLM request builder

### Out of Scope
- Context UI changes (done in 04-01..03)
- Context picker UI (done in 04-03)
- Token counting accuracy (approximate is fine)

---

## Pre-Conditions

- [ ] 04-01 complete (Context Chips)
- [ ] 04-02 complete (Context Drawer)
- [ ] 04-03 complete (Mention Autocomplete)
- [ ] State service implemented (01-02)
- [ ] Git branch created: `qic-ui/04-04-context-state`

---

## Tasks

### 1. Extend State Service Interface

In `qicStateService.ts`, add context types and methods:

```typescript
// ========================================
// Context Types
// ========================================

export type ContextItemType = 'file' | 'selection' | 'symbol' | 'url' | 'image';

export interface ContextItem {
  id: string;
  type: ContextItemType;
  label: string;

  // File/Selection/Symbol
  path?: string;
  startLine?: number;
  endLine?: number;
  content?: string;

  // Symbol specific
  name?: string;
  symbolKind?: string;

  // URL specific
  url?: string;

  // Image specific
  dataUrl?: string;

  // Metadata
  addedAt: number;
  tokenEstimate?: number;
  state?: 'loading' | 'ready' | 'error';
  error?: string;
}

export interface ContextState {
  items: ContextItem[];
  totalTokens: number;
  maxTokens: number;
}

// ========================================
// Extended State Interface
// ========================================

export interface QicState {
  // ... existing state properties ...

  // Context
  contextItems: ContextItem[];
  recentContext: ContextItem[];
  contextTokenBudget: number;
}

// ========================================
// Context Methods on IQicStateService
// ========================================

export interface IQicStateService {
  // ... existing methods ...

  // Context management
  addContextItem(item: Omit<ContextItem, 'addedAt' | 'tokenEstimate'>): void;
  removeContextItem(id: string): void;
  clearContextItems(): void;
  updateContextItem(id: string, updates: Partial<ContextItem>): void;

  // Recent context
  addToRecentContext(item: ContextItem): void;
  getRecentContext(): ContextItem[];

  // Token management
  getContextTokenCount(): number;
  setContextTokenBudget(budget: number): void;
  isWithinTokenBudget(): boolean;
}
```

### 2. Implement Context State Methods

In `qicStateServiceImpl.ts`:

```typescript
// ========================================
// Context State Implementation
// ========================================

private readonly MAX_RECENT_ITEMS = 20;
private readonly DEFAULT_TOKEN_BUDGET = 100000; // 100k tokens

// Add initial context state
private getInitialState(): QicState {
  return {
    // ... existing initial state ...
    contextItems: [],
    recentContext: [],
    contextTokenBudget: this.DEFAULT_TOKEN_BUDGET,
  };
}

// ========================================
// Context Item CRUD
// ========================================

addContextItem(item: Omit<ContextItem, 'addedAt' | 'tokenEstimate'>): void {
  const fullItem: ContextItem = {
    ...item,
    addedAt: Date.now(),
    tokenEstimate: this.estimateTokens(item),
    state: 'loading',
  };

  // Check for duplicates
  const existingIndex = this._state.contextItems.findIndex(
    i => this.isSameContext(i, fullItem)
  );

  if (existingIndex >= 0) {
    // Update existing instead of duplicate
    this.updateContextItem(this._state.contextItems[existingIndex].id, fullItem);
    return;
  }

  // Check token budget
  const newTotal = this.getContextTokenCount() + (fullItem.tokenEstimate || 0);
  if (newTotal > this._state.contextTokenBudget) {
    this.notificationService.warn(
      localize('qic.context.overBudget',
        'Adding this context would exceed the token budget. Consider removing some items.')
    );
    // Still add, but warn
  }

  this._state.contextItems.push(fullItem);
  this.emitPatch('contextItems', this._state.contextItems);

  // Add to recent
  this.addToRecentContext(fullItem);

  // Load content asynchronously
  this.loadContextContent(fullItem.id);
}

removeContextItem(id: string): void {
  const index = this._state.contextItems.findIndex(i => i.id === id);
  if (index >= 0) {
    this._state.contextItems.splice(index, 1);
    this.emitPatch('contextItems', this._state.contextItems);
  }
}

clearContextItems(): void {
  this._state.contextItems = [];
  this.emitPatch('contextItems', []);
}

updateContextItem(id: string, updates: Partial<ContextItem>): void {
  const item = this._state.contextItems.find(i => i.id === id);
  if (item) {
    Object.assign(item, updates);

    // Recalculate token estimate if content changed
    if (updates.content !== undefined) {
      item.tokenEstimate = this.estimateTokens(item);
    }

    this.emitPatch('contextItems', this._state.contextItems);
  }
}

// ========================================
// Recent Context
// ========================================

addToRecentContext(item: ContextItem): void {
  // Remove if already in recent
  const existingIndex = this._state.recentContext.findIndex(
    i => this.isSameContext(i, item)
  );
  if (existingIndex >= 0) {
    this._state.recentContext.splice(existingIndex, 1);
  }

  // Add to front
  this._state.recentContext.unshift({
    ...item,
    content: undefined, // Don't store content in recent
  });

  // Trim to max
  if (this._state.recentContext.length > this.MAX_RECENT_ITEMS) {
    this._state.recentContext = this._state.recentContext.slice(0, this.MAX_RECENT_ITEMS);
  }

  // Persist recent context
  this.persistRecentContext();
}

getRecentContext(): ContextItem[] {
  return this._state.recentContext;
}

// ========================================
// Token Management
// ========================================

getContextTokenCount(): number {
  return this._state.contextItems.reduce(
    (sum, item) => sum + (item.tokenEstimate || 0),
    0
  );
}

setContextTokenBudget(budget: number): void {
  this._state.contextTokenBudget = budget;
  this.emitPatch('contextTokenBudget', budget);
}

isWithinTokenBudget(): boolean {
  return this.getContextTokenCount() <= this._state.contextTokenBudget;
}

// ========================================
// Helper Methods
// ========================================

private estimateTokens(item: Partial<ContextItem>): number {
  // Rough estimate: ~4 characters per token
  const CHARS_PER_TOKEN = 4;

  if (item.content) {
    return Math.ceil(item.content.length / CHARS_PER_TOKEN);
  }

  // Estimate based on type
  switch (item.type) {
    case 'file':
      // Assume average file is ~5000 tokens
      return 5000;
    case 'selection':
      // Based on line count
      const lines = (item.endLine || 0) - (item.startLine || 0) + 1;
      return Math.ceil(lines * 50); // ~50 tokens per line
    case 'symbol':
      return 500; // Symbols are typically smaller
    case 'url':
      return 2000; // Web content varies
    case 'image':
      return 1000; // Image description tokens
    default:
      return 500;
  }
}

private isSameContext(a: Partial<ContextItem>, b: Partial<ContextItem>): boolean {
  // Same if type and identifying properties match
  if (a.type !== b.type) return false;

  switch (a.type) {
    case 'file':
      return a.path === b.path &&
             a.startLine === b.startLine &&
             a.endLine === b.endLine;
    case 'selection':
      return a.path === b.path &&
             a.startLine === b.startLine &&
             a.endLine === b.endLine;
    case 'symbol':
      return a.path === b.path && a.name === b.name;
    case 'url':
      return a.url === b.url;
    case 'image':
      return a.dataUrl === b.dataUrl || a.path === b.path;
    default:
      return false;
  }
}

private async loadContextContent(id: string): Promise<void> {
  const item = this._state.contextItems.find(i => i.id === id);
  if (!item) return;

  try {
    let content = '';

    if (item.type === 'file' || item.type === 'selection' || item.type === 'symbol') {
      if (item.path) {
        const uri = vscode.Uri.file(item.path);
        const document = await vscode.workspace.openTextDocument(uri);

        if (item.startLine !== undefined && item.endLine !== undefined) {
          const lines: string[] = [];
          for (let i = item.startLine - 1; i < item.endLine && i < document.lineCount; i++) {
            lines.push(document.lineAt(i).text);
          }
          content = lines.join('\n');
        } else {
          content = document.getText();
        }
      }
    } else if (item.type === 'url' && item.url) {
      // URL content would be fetched separately
      content = `[Content from ${item.url}]`;
    }

    this.updateContextItem(id, {
      content,
      state: 'ready',
      tokenEstimate: this.estimateTokens({ ...item, content }),
    });

  } catch (error) {
    this.updateContextItem(id, {
      state: 'error',
      error: error.message,
    });
  }
}

// ========================================
// Persistence
// ========================================

private persistRecentContext(): void {
  // Store in VS Code global state
  this.storageService.store(
    'qic.recentContext',
    JSON.stringify(this._state.recentContext),
    StorageScope.WORKSPACE,
    StorageTarget.USER
  );
}

private restoreRecentContext(): void {
  const stored = this.storageService.get(
    'qic.recentContext',
    StorageScope.WORKSPACE
  );

  if (stored) {
    try {
      this._state.recentContext = JSON.parse(stored);
    } catch (e) {
      this._state.recentContext = [];
    }
  }
}
```

### 3. Integrate Context with Message Construction

Create a context builder for LLM messages:

```typescript
// src/vs/workbench/contrib/qic/common/contextBuilder.ts

import { ContextItem } from './state/qicStateService.js';

export interface ContextBlock {
  type: 'file' | 'code' | 'url' | 'image';
  content: string;
  metadata: {
    path?: string;
    language?: string;
    startLine?: number;
    endLine?: number;
    url?: string;
  };
}

export class ContextBuilder {
  /**
   * Build context blocks from context items for LLM message
   */
  static buildContextBlocks(items: ContextItem[]): ContextBlock[] {
    return items
      .filter(item => item.state === 'ready' && item.content)
      .map(item => this.itemToBlock(item));
  }

  /**
   * Build context string for system message
   */
  static buildContextString(items: ContextItem[]): string {
    const blocks = this.buildContextBlocks(items);

    if (blocks.length === 0) {
      return '';
    }

    const sections = blocks.map(block => {
      switch (block.type) {
        case 'file':
          return this.formatFileBlock(block);
        case 'code':
          return this.formatCodeBlock(block);
        case 'url':
          return this.formatUrlBlock(block);
        case 'image':
          return this.formatImageBlock(block);
        default:
          return '';
      }
    });

    return `
## Attached Context

The user has attached the following context to this conversation:

${sections.join('\n\n')}

---
`;
  }

  private static itemToBlock(item: ContextItem): ContextBlock {
    const language = item.path ? this.getLanguageFromPath(item.path) : undefined;

    switch (item.type) {
      case 'file':
        return {
          type: item.startLine ? 'code' : 'file',
          content: item.content || '',
          metadata: {
            path: item.path,
            language,
            startLine: item.startLine,
            endLine: item.endLine,
          },
        };

      case 'selection':
      case 'symbol':
        return {
          type: 'code',
          content: item.content || '',
          metadata: {
            path: item.path,
            language,
            startLine: item.startLine,
            endLine: item.endLine,
          },
        };

      case 'url':
        return {
          type: 'url',
          content: item.content || '',
          metadata: { url: item.url },
        };

      case 'image':
        return {
          type: 'image',
          content: item.dataUrl || '',
          metadata: { path: item.path },
        };

      default:
        return {
          type: 'file',
          content: item.content || '',
          metadata: {},
        };
    }
  }

  private static formatFileBlock(block: ContextBlock): string {
    const header = block.metadata.path
      ? `### File: ${block.metadata.path}`
      : '### File';

    const lang = block.metadata.language || '';

    return `${header}

\`\`\`${lang}
${block.content}
\`\`\``;
  }

  private static formatCodeBlock(block: ContextBlock): string {
    const location = block.metadata.path || 'unknown';
    const lines = block.metadata.startLine && block.metadata.endLine
      ? ` (lines ${block.metadata.startLine}-${block.metadata.endLine})`
      : '';

    const header = `### Code from ${location}${lines}`;
    const lang = block.metadata.language || '';

    return `${header}

\`\`\`${lang}
${block.content}
\`\`\``;
  }

  private static formatUrlBlock(block: ContextBlock): string {
    return `### Web Content: ${block.metadata.url}

${block.content}`;
  }

  private static formatImageBlock(block: ContextBlock): string {
    return `### Image: ${block.metadata.path || 'Attached image'}

[Image content attached]`;
  }

  private static getLanguageFromPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'java': 'java',
      'cs': 'csharp',
      'cpp': 'cpp',
      'c': 'c',
      'h': 'c',
      'hpp': 'cpp',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'php': 'php',
      'sql': 'sql',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'less': 'less',
      'md': 'markdown',
    };
    return langMap[ext] || ext;
  }
}
```

### 4. Wire Context to Message Sending

Update the message handler to include context:

```typescript
// In qicPanel.ts or message handler

private async sendMessage(content: string): Promise<void> {
  // Get current context
  const contextItems = this.stateService.state.contextItems;
  const contextString = ContextBuilder.buildContextString(contextItems);

  // Build message with context
  const messageWithContext = contextString
    ? `${contextString}\n\n${content}`
    : content;

  // For multimodal (images), build structured content
  const hasImages = contextItems.some(i => i.type === 'image');

  if (hasImages) {
    const messageContent = this.buildMultimodalContent(content, contextItems);
    await this.llmService.sendMessage(messageContent);
  } else {
    await this.llmService.sendMessage(messageWithContext);
  }

  // Don't clear context after send (user might want to continue)
}

private buildMultimodalContent(text: string, contextItems: ContextItem[]): MessageContent {
  const parts: ContentPart[] = [];

  // Add images first
  for (const item of contextItems) {
    if (item.type === 'image' && item.dataUrl) {
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: this.getImageMediaType(item.dataUrl),
          data: item.dataUrl.split(',')[1], // Remove data URL prefix
        },
      });
    }
  }

  // Add text content (includes non-image context)
  const textContext = contextItems.filter(i => i.type !== 'image');
  const contextString = ContextBuilder.buildContextString(textContext);
  const fullText = contextString ? `${contextString}\n\n${text}` : text;

  parts.push({
    type: 'text',
    text: fullText,
  });

  return parts;
}
```

### 5. Sync Context with Webview

Update panel to sync context state:

```typescript
// In qicPanel.ts

private syncContextToWebview(): void {
  this.postMessage({
    type: 'context:set',
    items: this.stateService.state.contextItems,
  });
}

// On state change
private setupStateSync(): void {
  this._register(this.stateService.onDidChangeState((patch) => {
    if (patch.path === 'contextItems' || patch.path === '*') {
      this.syncContextToWebview();
    }
  }));
}

// Handle webview context messages
case 'context:add':
  this.stateService.addContextItem(message.item);
  return;

case 'context:remove':
  this.stateService.removeContextItem(message.id);
  return;

case 'context:clear':
  this.stateService.clearContextItems();
  return;
```

### 6. Add Context from Editor Commands

```typescript
// Register commands for adding context from editor

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.addFileToContext',
      title: localize('qic.addFileToContext', 'QIC: Add File to Context'),
      category: 'QIC',
      menu: [{
        id: MenuId.ExplorerContext,
        group: 'qic',
      }, {
        id: MenuId.EditorTitleContext,
        group: 'qic',
      }],
    });
  }

  async run(accessor: ServicesAccessor, uri?: vscode.Uri): Promise<void> {
    const stateService = accessor.get(IQicStateService);
    const editorService = accessor.get(IEditorService);

    const targetUri = uri || editorService.activeEditor?.resource;
    if (!targetUri) return;

    stateService.addContextItem({
      id: `file_${Date.now()}`,
      type: 'file',
      label: path.basename(targetUri.fsPath),
      path: targetUri.fsPath,
    });
  }
});

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.addSelectionToContext',
      title: localize('qic.addSelectionToContext', 'QIC: Add Selection to Context'),
      category: 'QIC',
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC,
        when: EditorContextKeys.hasNonEmptySelection,
      },
      menu: {
        id: MenuId.EditorContext,
        group: 'qic',
        when: EditorContextKeys.hasNonEmptySelection,
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const stateService = accessor.get(IQicStateService);
    const editorService = accessor.get(IEditorService);

    const editor = editorService.activeTextEditorControl;
    const model = editor?.getModel();
    const selection = editor?.getSelection();

    if (!model || !selection || selection.isEmpty()) return;

    const content = model.getValueInRange(selection);
    const uri = model.uri;

    stateService.addContextItem({
      id: `selection_${Date.now()}`,
      type: 'selection',
      label: `Selection in ${path.basename(uri.fsPath)}`,
      path: uri.fsPath,
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      content,
    });
  }
});
```

---

## Verification

### Success Criteria
- [ ] Context items stored in state service
- [ ] Adding context updates chips
- [ ] Removing context updates chips
- [ ] Context persists in recent list
- [ ] Recent context loads on startup
- [ ] Context included in LLM messages
- [ ] Token estimates calculated
- [ ] Token budget warning shown
- [ ] Editor commands add context
- [ ] Ctrl+Shift+C adds selection
- [ ] Right-click adds file

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Add file | Right-click file → Add to Context | Chip appears |
| Add selection | Select code, Ctrl+Shift+C | Selection chip |
| Remove context | Click × on chip | Item removed |
| Clear all | Open drawer, clear | All removed |
| Send with context | Add file, send message | Context in message |
| Token warning | Add large files | Warning shown |
| Recent | Add item, check autocomplete | In recent list |
| Restart | Add context, reload | Recent preserved |

### State Sync Tests

| Test | Expected |
|------|----------|
| Add in webview | Extension state updated |
| Add in extension | Webview chips updated |
| Clear in webview | Extension cleared |
| Clear in extension | Webview cleared |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/common/state/qicStateService.ts
git checkout src/vs/workbench/contrib/qic/browser/qicPanel.ts
```

---

## Notes

- Token estimates are approximate (4 chars/token)
- Context is NOT cleared after sending (user decides)
- Recent context limited to 20 items
- Images sent as base64 in multimodal messages
- Consider adding context to conversation history for reference
- Large files may need chunking strategy in future

