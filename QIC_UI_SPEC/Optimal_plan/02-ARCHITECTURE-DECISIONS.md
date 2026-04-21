# Architecture Decisions

**Status:** Proposed | **Decision Authority:** Tech Lead

---

## Overview

This document captures key architectural decisions required before implementing the UI spec. Each decision includes context, options, recommendation, and consequences.

---

## ADR-001: Webview vs Native UI Split

### Context
The spec uses both webview (panel content) and native VS Code UI (Quick Picks, modals, status bar). We need to decide the boundary.

### Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A: All webview | Everything in webview including dialogs | Full control, consistent | Poor native feel, accessibility harder |
| B: Hybrid (recommended) | Conversation in webview, dialogs/pickers native | Best of both, native feel | Two UI paradigms, state sync |
| C: All native | Use VS Code views throughout | Perfect integration | Limited styling, complex conversation UI |

### Decision: **Option B - Hybrid**

### Boundaries

| Component | Implementation |
|-----------|----------------|
| Panel header | Webview (custom styling) |
| Conversation area | Webview (virtualized) |
| Context chips/drawer | Webview |
| Input area | Webview (custom textarea) |
| History picker | Native Quick Pick |
| Checkpoint picker | Native Quick Pick |
| Provider picker | Native Quick Pick |
| Status quick pick | Native Quick Pick |
| Quota quick pick | Native Quick Pick |
| Help modal | Native VS Code modal |
| Confirmation dialogs | Native VS Code dialog |
| Audit log viewer | **Webview modal** (complex filtering) |
| Settings | Native VS Code settings |
| Status bar | Native StatusBarItem |

### Consequences
- Need to implement Quick Pick data providers
- State must be accessible from both webview and extension host
- Focus management between webview and native UI

---

## ADR-002: State Management Architecture

### Context
The spec defines a unified `QICState` interface. Current implementation has state fragmented across services.

### Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A: Single state store | One source of truth in extension host | Simple, predictable | Large state object |
| B: Federated state | Each service owns its slice | Separation of concerns | Complex coordination |
| C: Event-driven | State derived from event stream | Audit-friendly | Complex reconstruction |

### Decision: **Option A - Single State Store**

### Implementation

```typescript
// src/vs/workbench/contrib/qic/common/state/qicStateService.ts

interface IQicStateService {
    readonly state: QICState;
    readonly onDidChangeState: Event<QICStatePatch>;

    // Mutations (return new revision)
    updateConnection(connection: Partial<ConnectionState>): number;
    updateContext(items: ContextItem[]): number;
    updateConversation(patch: Partial<ConversationState>): number;
    // ... etc

    // Serialization
    serialize(): string;
    restore(serialized: string): void;
}

class QicStateService implements IQicStateService {
    private _state: QICState;
    private _revision = 0;

    private readonly _onDidChangeState = new Emitter<QICStatePatch>();
    readonly onDidChangeState = this._onDidChangeState.event;

    // All mutations increment revision and emit
    updateConnection(connection: Partial<ConnectionState>): number {
        this._state = {
            ...this._state,
            revision: ++this._revision,
            connection: { ...this._state.connection, ...connection }
        };
        this._onDidChangeState.fire({ revision: this._revision, path: 'connection', value: this._state.connection });
        return this._revision;
    }
}
```

### State Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Extension Host                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                  QicStateService                        │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐  │  │
│  │  │Connection│  │Conversa-│  │ Context │  │Checkpoint│  │  │
│  │  │  State   │  │  tion   │  │  State  │  │  State   │  │  │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬─────┘  │  │
│  │       │            │            │            │         │  │
│  │       └────────────┴────────────┴────────────┘         │  │
│  │                         │                               │  │
│  │              onDidChangeState                           │  │
│  └─────────────────────────┼──────────────────────────────┘  │
│                            │                                  │
│         ┌──────────────────┼──────────────────────┐          │
│         │                  │                      │          │
│         ▼                  ▼                      ▼          │
│   ┌──────────┐      ┌──────────┐          ┌──────────┐      │
│   │StatusBar │      │Quick Pick│          │ Webview  │      │
│   │  Item    │      │ Provider │          │ Bridge   │      │
│   └──────────┘      └──────────┘          └────┬─────┘      │
│                                                 │            │
└─────────────────────────────────────────────────┼────────────┘
                                                  │
                                    postMessage(state:patch)
                                                  │
                                                  ▼
                                           ┌──────────┐
                                           │ Webview  │
                                           │  State   │
                                           └──────────┘
```

### Consequences
- QicStateService becomes the single source of truth
- All services write to state service, not their own state
- Webview receives state patches with revisions
- Can reconstruct state from any point

---

## ADR-003: Message Protocol Version

### Context
Current message protocol (messageProtocol.ts) doesn't have revisions. Spec requires revision-based sync for reliability.

### Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A: Full replacement | Replace all message types | Clean, spec-compliant | Breaking, risky |
| B: Versioned migration | Add v2 messages alongside v1 | Gradual, safe | Temporary complexity |
| C: Adapter layer | Keep internal, transform at boundary | No backend changes | Extra transformation |

### Decision: **Option B - Versioned Migration**

### Implementation

```typescript
// Phase 1: Add revision to existing messages
type HostToWebviewMessage =
    | { type: 'stream-token'; text: string; revision?: number }  // Optional initially
    | { type: 'message-complete'; messageId: string; revision?: number }
    // ...existing types with optional revision

// Phase 2: Add new message types alongside
type HostToWebviewMessageV2 =
    | { type: 'state:full'; revision: number; payload: QICState }
    | { type: 'state:patch'; revision: number; payload: Partial<QICState> }
    // ...spec message types

// Phase 3: Webview handles both
function handleMessage(msg: HostToWebviewMessage | HostToWebviewMessageV2) {
    if (msg.type.startsWith('state:')) {
        // V2 handler
    } else {
        // V1 handler (legacy)
    }
}

// Phase 4: Remove V1 after full migration
```

### Consequences
- Gradual migration reduces risk
- Both protocols work during transition
- Clear deprecation path
- Testing can verify both paths

---

## ADR-004: Virtualization Strategy

### Context
Spec mentions react-window for conversation virtualization. Current implementation is vanilla JS with no virtualization.

### Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A: React + react-window | Full React rewrite | Battle-tested, ecosystem | Major rewrite, bundle size |
| B: Custom virtualization | Vanilla JS virtualization | Small bundle, control | Implementation effort |
| C: Lazy loading | Load messages on scroll | Simple, no rewrite | Not true virtualization |
| D: Defer | No virtualization initially | Ship faster | Performance risk |

### Decision: **Option C first, then B**

### Rationale
- 500 message limit (per spec) is manageable without virtualization
- Lazy loading (pagination) handles most cases
- True virtualization can be added later if needed
- Avoids React dependency and major rewrite

### Implementation (Lazy Loading)

```javascript
// chat.js - Lazy loading implementation
const MESSAGE_BATCH_SIZE = 50;
let loadedMessages = [];
let hasMore = true;

function loadMoreMessages() {
    if (!hasMore) return;
    vscode.postMessage({
        type: 'messages:loadMore',
        payload: { offset: loadedMessages.length, limit: MESSAGE_BATCH_SIZE }
    });
}

// Intersection Observer for infinite scroll
const sentinel = document.getElementById('load-more-sentinel');
const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
        loadMoreMessages();
    }
}, { rootMargin: '100px' });
observer.observe(sentinel);
```

### Consequences
- Faster initial implementation
- Performance acceptable for typical usage
- Can upgrade to true virtualization later
- Bundle size stays small

---

## ADR-005: Quick Pick Implementation

### Context
Spec uses VS Code Quick Picks for history, checkpoints, provider selection, etc. Need to decide implementation approach.

### Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A: QuickPickProvider | Implement IQuickPickDataSource | Full VS Code integration | Limited customization |
| B: QuickInput API | Use showQuickPick directly | Simple, flexible | Less integrated |
| C: Custom views | WebviewView for pickers | Full control | Not native feel |

### Decision: **Option B - QuickInput API**

### Implementation

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/historyQuickPick.ts

async function showHistoryQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService
): Promise<string | undefined> {
    const conversations = await stateService.getConversationSummaries();

    const items: IQuickPickItem[] = conversations.map(c => ({
        id: c.id,
        label: c.title,
        description: formatRelativeTime(c.timestamp),
        detail: `${c.messageCount} messages`,
        buttons: [
            { iconClass: 'codicon-trash', tooltip: 'Delete' },
            { iconClass: 'codicon-export', tooltip: 'Export' }
        ]
    }));

    // Group by date
    const grouped = groupByDate(items);

    const pick = await quickInputService.pick(grouped, {
        placeHolder: 'Search conversations...',
        matchOnDescription: true,
        matchOnDetail: true
    });

    return pick?.id;
}
```

### Quick Picks to Implement

| Pick | Trigger | Data Source |
|------|---------|-------------|
| History | Menu → History / Cmd+Shift+H | ConversationService |
| Checkpoints | Menu → Checkpoints | CheckpointManager |
| Provider | Menu → Switch provider | ProviderGateway |
| Status | Logo click | ConnectionState |
| Quota | Status bar quota click | QuotaState |

### Consequences
- Native VS Code look and feel
- Built-in fuzzy search
- Action buttons supported
- Keyboard navigation automatic

---

## ADR-006: Context Chips Data Source

### Context
Spec defines context chips with types (file, selection, terminal, folder, symbol, docs). Need to determine data sources.

### Decision: Leverage Existing Services

| Chip Type | Data Source | Implementation |
|-----------|-------------|----------------|
| File | IEditorService.activeEditor | Auto-include when focused |
| Selection | IEditorService.activeTextEditorControl.getSelection() | Include when non-empty |
| Terminal | ITerminalService.activeInstance.xterm | Last 100 lines |
| Folder | Workspace folders | Via @ mention |
| Symbol | ISymbolNavigationService | Via @ mention |
| Docs | Custom docs index | Via @ mention |

### Token Counting

```typescript
// Use existing tokenizer or simple approximation
function estimateTokens(text: string): number {
    // GPT-4 approximation: ~4 chars per token
    return Math.ceil(text.length / 4);
}

// Or use tiktoken if available
import { encoding_for_model } from 'tiktoken';
const encoder = encoding_for_model('gpt-4');
function countTokens(text: string): number {
    return encoder.encode(text).length;
}
```

### Consequences
- Leverages existing VS Code services
- Real-time token counting
- Consistent with spec's context model

---

## ADR-007: Diff/CodeLens Integration

### Context
Spec requires CodeLens for Accept/Reject on pending changes. Need to integrate with editor.

### Decision: Use VS Code CodeLens API

```typescript
// src/vs/workbench/contrib/qic/browser/codeLens/qicCodeLensProvider.ts

class QicCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(private stateService: IQicStateService) {
        stateService.onDidChangeState(patch => {
            if (patch.path === 'conversation.pendingChanges') {
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const changes = this.stateService.state.conversation.pendingChanges;
        if (!changes) return [];

        const fileChange = changes.changes.find(c => c.file === document.uri.fsPath);
        if (!fileChange || fileChange.status !== 'pending') return [];

        return fileChange.hunks.map(hunk => new vscode.CodeLens(
            new vscode.Range(hunk.newStart - 1, 0, hunk.newStart - 1, 0),
            {
                title: '✓ Accept',
                command: 'qic.acceptChange',
                arguments: [changes.id, fileChange.id]
            }
        ));
    }
}
```

### Consequences
- Native editor integration
- Keyboard shortcuts work (Cmd+Enter)
- Consistent with VS Code patterns

---

## Summary of Decisions

| ADR | Decision | Impact |
|-----|----------|--------|
| ADR-001 | Hybrid webview/native | Medium - clear boundaries |
| ADR-002 | Single state store | High - foundational |
| ADR-003 | Versioned protocol migration | Medium - safe migration |
| ADR-004 | Lazy loading → virtualization | Low - can defer |
| ADR-005 | QuickInput API | Low - straightforward |
| ADR-006 | Leverage existing services | Low - integration work |
| ADR-007 | VS Code CodeLens API | Medium - editor integration |
