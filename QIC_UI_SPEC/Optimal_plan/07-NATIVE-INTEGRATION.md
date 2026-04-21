# Phase 6: Native VS Code Integration

**Duration:** 1 week | **Depends on:** Phase 3 (Conversation)

---

## Overview

This phase implements native VS Code UI components: Quick Picks, Status Bar, and Modals. These replace the current floating webview panels with proper VS Code patterns.

---

## 1. Quick Picks

### 1.1 History Quick Pick

**Trigger:** Menu → "Conversation history" or `Cmd+Shift+H`

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/historyQuickPick.ts

import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { IQicStateService } from '../../common/state/qicStateService';

interface HistoryQuickPickItem extends IQuickPickItem {
    conversationId: string;
}

export async function showHistoryQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService,
    conversationService: IConversationService
): Promise<void> {
    const conversations = await conversationService.getConversationSummaries();

    // Group by date
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    const items: (HistoryQuickPickItem | IQuickPickSeparator)[] = [];
    let currentGroup = '';

    for (const conv of conversations) {
        const date = new Date(conv.timestamp);
        const group = date.toDateString() === today ? 'TODAY'
            : date.toDateString() === yesterday ? 'YESTERDAY'
            : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

        if (group !== currentGroup) {
            items.push({ type: 'separator', label: group });
            currentGroup = group;
        }

        items.push({
            label: conv.title,
            description: formatTime(date),
            detail: `${conv.messageCount} messages`,
            conversationId: conv.id,
            buttons: [
                {
                    iconClass: 'codicon-trash',
                    tooltip: 'Delete conversation'
                },
                {
                    iconClass: 'codicon-export',
                    tooltip: 'Export conversation'
                }
            ]
        });
    }

    const quickPick = quickInputService.createQuickPick<HistoryQuickPickItem>();
    quickPick.items = items;
    quickPick.placeholder = 'Search conversations...';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (selected?.conversationId) {
            conversationService.loadConversation(selected.conversationId);
        }
        quickPick.hide();
    });

    quickPick.onDidTriggerItemButton(({ item, button }) => {
        if (button.iconClass === 'codicon-trash') {
            conversationService.deleteConversation(item.conversationId);
            // Refresh list
            quickPick.items = quickPick.items.filter(i =>
                'conversationId' in i ? i.conversationId !== item.conversationId : true
            );
        } else if (button.iconClass === 'codicon-export') {
            conversationService.exportConversation(item.conversationId, 'markdown');
        }
    });

    quickPick.show();
}
```

### 1.2 Checkpoint Quick Pick

**Trigger:** Menu → "View checkpoints" or `Cmd+Ctrl+Z`

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/checkpointQuickPick.ts

interface CheckpointQuickPickItem extends IQuickPickItem {
    checkpointId: string;
}

export async function showCheckpointQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService,
    checkpointManager: ICheckpointManager
): Promise<void> {
    const checkpoints = stateService.state.checkpoints;

    const items: (CheckpointQuickPickItem | IQuickPickSeparator)[] = [
        {
            label: '$(add) Create checkpoint now',
            alwaysShow: true,
            checkpointId: '__create__'
        },
        { type: 'separator', label: 'Recent Checkpoints' }
    ];

    for (const cp of checkpoints) {
        const age = formatRelativeTime(cp.timestamp);
        items.push({
            label: cp.description || `Before: ${cp.changeSetId?.slice(0, 8)}`,
            description: age,
            detail: `${cp.files.length} files${cp.isManual ? ' · Manual' : ''}`,
            checkpointId: cp.id,
            buttons: [
                {
                    iconClass: 'codicon-discard',
                    tooltip: 'Restore this checkpoint'
                },
                {
                    iconClass: 'codicon-trash',
                    tooltip: 'Delete checkpoint'
                }
            ]
        });
    }

    // Add footer actions
    items.push(
        { type: 'separator', label: '' },
        { label: '$(export) Export all checkpoints', checkpointId: '__export__' },
        { label: '$(trash) Clear old checkpoints', checkpointId: '__clear__' }
    );

    const quickPick = quickInputService.createQuickPick<CheckpointQuickPickItem>();
    quickPick.items = items;
    quickPick.placeholder = 'Select checkpoint to restore...';

    quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (!selected) return;

        if (selected.checkpointId === '__create__') {
            checkpointManager.createCheckpoint();
        } else if (selected.checkpointId === '__export__') {
            checkpointManager.exportAll();
        } else if (selected.checkpointId === '__clear__') {
            checkpointManager.clearOld();
        } else {
            checkpointManager.restore(selected.checkpointId);
        }
        quickPick.hide();
    });

    quickPick.onDidTriggerItemButton(({ item, button }) => {
        if (button.iconClass === 'codicon-discard') {
            checkpointManager.restore(item.checkpointId);
            quickPick.hide();
        } else if (button.iconClass === 'codicon-trash') {
            checkpointManager.delete(item.checkpointId);
            quickPick.items = quickPick.items.filter(i =>
                'checkpointId' in i ? i.checkpointId !== item.checkpointId : true
            );
        }
    });

    quickPick.show();
}
```

### 1.3 Provider Quick Pick

**Trigger:** Menu → "Switch provider" or Status bar click

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/providerQuickPick.ts

interface ProviderQuickPickItem extends IQuickPickItem {
    providerId: string;
}

export async function showProviderQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService,
    providerGateway: IProviderGateway
): Promise<void> {
    const currentProvider = stateService.state.connection.provider;
    const providers = await providerGateway.getAvailableProviders();

    const items: ProviderQuickPickItem[] = providers.map(p => ({
        label: `${p.id === currentProvider ? '$(check) ' : '$(circle-outline) '}${p.name}`,
        description: p.status,
        detail: p.detail,
        providerId: p.id,
        picked: p.id === currentProvider
    }));

    // Add offline option
    items.push({
        label: currentProvider === 'offline' ? '$(check) Offline Mode' : '$(circle-outline) Offline Mode',
        description: 'No AI features',
        providerId: 'offline'
    });

    const selected = await quickInputService.pick(items, {
        placeHolder: 'Select AI provider',
        title: 'Switch Provider'
    });

    if (selected) {
        await providerGateway.setProvider(selected.providerId);
    }
}
```

### 1.4 Status Quick Pick

**Trigger:** Click on status indicator in header

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/statusQuickPick.ts

export async function showStatusQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService
): Promise<void> {
    const conn = stateService.state.connection;
    const statusIcon = getStatusIcon(conn.status);
    const statusText = getStatusText(conn.status);

    const items: IQuickPickItem[] = [
        {
            label: `${statusIcon} ${statusText}`,
            description: `${conn.provider} · ${conn.latencyMs}ms`,
            alwaysShow: true
        },
        { type: 'separator', label: '' },
        { label: '$(server-process) Switch provider' },
        { label: '$(debug-restart) Test connection' },
        { label: '$(link-external) View status page' }
    ];

    if (conn.degradationLevel > 0) {
        items.splice(1, 0, {
            label: `$(warning) Degradation Level ${conn.degradationLevel}`,
            description: getDegradationDescription(conn.degradationLevel)
        });
    }

    const selected = await quickInputService.pick(items, {
        placeHolder: 'QIC Status'
    });

    if (selected?.label.includes('Switch provider')) {
        showProviderQuickPick(quickInputService, stateService, providerGateway);
    } else if (selected?.label.includes('Test connection')) {
        await providerGateway.testConnection();
    } else if (selected?.label.includes('View status page')) {
        openerService.open(URI.parse('https://status.quantlab.io'));
    }
}
```

### 1.5 Quota Quick Pick

**Trigger:** Click on quota in status bar

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/quotaQuickPick.ts

export async function showQuotaQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService
): Promise<void> {
    const quota = stateService.state.quota;
    const percentage = Math.round((quota.used / quota.limit) * 100);
    const progressBar = createProgressBar(percentage);

    const items: IQuickPickItem[] = [
        {
            label: `${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} (${percentage}%)`,
            description: progressBar,
            alwaysShow: true
        },
        {
            label: `Est: $${quota.estimatedCost.toFixed(2)} used`,
            description: `Resets ${formatRelativeTime(quota.resetDate)}`
        },
        { type: 'separator', label: '' },
        { label: '$(graph) View usage history' },
        { label: '$(arrow-up) Upgrade plan' },
        { label: '$(server) Switch to Ollama (unlimited)' }
    ];

    const selected = await quickInputService.pick(items, {
        placeHolder: 'Token Quota'
    });

    // Handle selections...
}

function createProgressBar(percentage: number): string {
    const filled = Math.round(percentage / 4);
    const empty = 25 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}
```

---

## 2. Status Bar

### 2.1 Refactored Status Bar Item

```typescript
// src/vs/workbench/contrib/qic/browser/qicStatusBarItem.ts

import { IStatusbarService, StatusbarAlignment, IStatusbarEntry } from 'vs/workbench/services/statusbar/browser/statusbar';
import { IQicStateService } from '../common/state/qicStateService';
import { Disposable } from 'vs/base/common/lifecycle';

export class QicStatusBarItem extends Disposable {
    private statusEntry: IStatusbarEntryAccessor | null = null;
    private quotaEntry: IStatusbarEntryAccessor | null = null;
    private checkpointEntry: IStatusbarEntryAccessor | null = null;

    constructor(
        @IStatusbarService private readonly statusbarService: IStatusbarService,
        @IQicStateService private readonly stateService: IQicStateService,
        @ICommandService private readonly commandService: ICommandService
    ) {
        super();
        this.createStatusItems();
        this._register(stateService.onDidChangeState(patch => this.handleStateChange(patch)));
    }

    private createStatusItems(): void {
        // Main status item
        this.statusEntry = this.statusbarService.addEntry(
            this.getStatusEntry(),
            'qic.status',
            StatusbarAlignment.RIGHT,
            100
        );

        // Quota item
        this.quotaEntry = this.statusbarService.addEntry(
            this.getQuotaEntry(),
            'qic.quota',
            StatusbarAlignment.RIGHT,
            99
        );

        // Checkpoint item
        this.checkpointEntry = this.statusbarService.addEntry(
            this.getCheckpointEntry(),
            'qic.checkpoints',
            StatusbarAlignment.RIGHT,
            98
        );
    }

    private getStatusEntry(): IStatusbarEntry {
        const conn = this.stateService.state.connection;
        const icon = this.getStatusIcon(conn.status);
        const color = this.getStatusColor(conn.status);

        return {
            name: 'QIC Status',
            text: `QIC ${icon}`,
            tooltip: `${conn.status} - ${conn.provider} · ${conn.latencyMs}ms`,
            ariaLabel: `QIC ${conn.status}`,
            command: 'qic.showStatusQuickPick',
            color
        };
    }

    private getQuotaEntry(): IStatusbarEntry {
        const quota = this.stateService.state.quota;
        const percentage = Math.round((quota.used / quota.limit) * 100);
        const color = percentage > 95 ? 'statusBarItem.errorForeground'
            : percentage > 80 ? 'statusBarItem.warningForeground'
            : undefined;

        return {
            name: 'QIC Quota',
            text: `${this.formatTokens(quota.used)}/${this.formatTokens(quota.limit)}`,
            tooltip: `Token usage: ${percentage}%\nResets ${formatRelativeTime(quota.resetDate)}`,
            ariaLabel: `Token quota ${percentage} percent used`,
            command: 'qic.showQuotaQuickPick',
            color
        };
    }

    private getCheckpointEntry(): IStatusbarEntry {
        const checkpoints = this.stateService.state.checkpoints;
        return {
            name: 'QIC Checkpoints',
            text: `⟳ ${checkpoints.length}`,
            tooltip: `${checkpoints.length} checkpoints available`,
            ariaLabel: `${checkpoints.length} checkpoints`,
            command: 'qic.showCheckpointQuickPick'
        };
    }

    private handleStateChange(patch: QICStatePatch): void {
        if (patch.path.startsWith('connection')) {
            this.statusEntry?.update(this.getStatusEntry());
        }
        if (patch.path.startsWith('quota')) {
            this.quotaEntry?.update(this.getQuotaEntry());
        }
        if (patch.path === 'checkpoints') {
            this.checkpointEntry?.update(this.getCheckpointEntry());
        }
    }

    private getStatusIcon(status: string): string {
        switch (status) {
            case 'connected': return '●';
            case 'connecting': return '◐';
            case 'degraded': return '◐';
            case 'disconnected': return '○';
            case 'blocked': return '●';
            default: return '◇';
        }
    }

    private getStatusColor(status: string): string | undefined {
        switch (status) {
            case 'connected': return 'terminal.ansiGreen';
            case 'connecting': return 'terminal.ansiBlue';
            case 'degraded': return 'terminal.ansiYellow';
            case 'disconnected':
            case 'blocked': return 'terminal.ansiRed';
            default: return undefined;
        }
    }

    private formatTokens(n: number): string {
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${Math.round(n / 1000)}K`;
        return n.toString();
    }
}
```

---

## 3. Modals & Dialogs

### 3.1 Help Modal

**Trigger:** Menu → "Help & shortcuts" or `Cmd+/`

```typescript
// src/vs/workbench/contrib/qic/browser/modals/helpModal.ts

import { IDialogService } from 'vs/platform/dialogs/common/dialogs';

export async function showHelpModal(dialogService: IDialogService): Promise<void> {
    const shortcuts = `
**GLOBAL**
Cmd+L          Focus QIC input
Cmd+Shift+N    New conversation
Cmd+Shift+H    Open history
Cmd+Shift+C    Create checkpoint
Cmd+Ctrl+Z     Restore checkpoint

**PANEL**
Cmd+Enter      Send message
Escape         Cancel / Clear
@              Mention file/symbol

**DIFF REVIEW**
Cmd+Enter      Accept change
Escape         Reject change
F7             Next file
Cmd+Shift+R    Open review mode
    `.trim();

    await dialogService.show(
        Severity.Info,
        'Help & Shortcuts',
        ['Documentation', 'Report Issue', 'Close'],
        {
            detail: shortcuts,
            cancelId: 2
        }
    );
}
```

### 3.2 Confirmation Dialogs

```typescript
// src/vs/workbench/contrib/qic/browser/modals/confirmations.ts

export async function confirmClearContext(dialogService: IDialogService): Promise<boolean> {
    const result = await dialogService.confirm({
        title: 'Clear Context?',
        message: 'This will remove all files, selections, and terminal output from context.',
        detail: 'Pinned items will also be unpinned.',
        primaryButton: 'Clear',
        type: 'warning'
    });
    return result.confirmed;
}

export async function confirmClearHistory(
    dialogService: IDialogService,
    count: number
): Promise<boolean> {
    const result = await dialogService.confirm({
        title: 'Clear All History?',
        message: `This will permanently delete all ${count} conversations.`,
        detail: 'This cannot be undone.',
        primaryButton: 'Delete All',
        type: 'warning'
    });
    return result.confirmed;
}

export async function confirmDeleteConversation(
    dialogService: IDialogService,
    title: string
): Promise<boolean> {
    const result = await dialogService.confirm({
        title: 'Delete Conversation?',
        message: `"${title}" will be permanently deleted.`,
        primaryButton: 'Delete',
        type: 'warning'
    });
    return result.confirmed;
}

export async function confirmStrategyChange(
    dialogService: IDialogService
): Promise<{ confirmed: boolean; dontAskAgain: boolean }> {
    const result = await dialogService.show(
        Severity.Warning,
        'Strategy File Change',
        ['Cancel', 'Simulate First', 'Apply'],
        {
            detail: 'Changes may affect live trading. Please review carefully.',
            checkbox: {
                label: "Don't ask again this session",
                checked: false
            },
            cancelId: 0
        }
    );

    return {
        confirmed: result.choice === 2,
        dontAskAgain: result.checkboxChecked ?? false
    };
}
```

---

## 4. Command Registration

### 4.1 Register Quick Pick Commands

```typescript
// src/vs/workbench/contrib/qic/browser/qic.contribution.ts

// Add to command registration section:

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showHistoryQuickPick',
            title: localize('qic.showHistory', "QIC: Conversation History"),
            keybinding: {
                primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyH,
                weight: KeybindingWeight.WorkbenchContrib
            }
        });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
        const quickInputService = accessor.get(IQuickInputService);
        const stateService = accessor.get(IQicStateService);
        const conversationService = accessor.get(IConversationService);
        await showHistoryQuickPick(quickInputService, stateService, conversationService);
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showCheckpointQuickPick',
            title: localize('qic.showCheckpoints', "QIC: Checkpoints"),
            keybinding: {
                primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyZ,
                weight: KeybindingWeight.WorkbenchContrib
            }
        });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
        const quickInputService = accessor.get(IQuickInputService);
        const stateService = accessor.get(IQicStateService);
        const checkpointManager = accessor.get(ICheckpointManager);
        await showCheckpointQuickPick(quickInputService, stateService, checkpointManager);
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showStatusQuickPick',
            title: localize('qic.showStatus', "QIC: Status")
        });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
        const quickInputService = accessor.get(IQuickInputService);
        const stateService = accessor.get(IQicStateService);
        await showStatusQuickPick(quickInputService, stateService);
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showQuotaQuickPick',
            title: localize('qic.showQuota', "QIC: Token Quota")
        });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
        const quickInputService = accessor.get(IQuickInputService);
        const stateService = accessor.get(IQicStateService);
        await showQuotaQuickPick(quickInputService, stateService);
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showProviderQuickPick',
            title: localize('qic.switchProvider', "QIC: Switch Provider")
        });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
        const quickInputService = accessor.get(IQuickInputService);
        const stateService = accessor.get(IQicStateService);
        const providerGateway = accessor.get(IProviderGateway);
        await showProviderQuickPick(quickInputService, stateService, providerGateway);
    }
});

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showHelp',
            title: localize('qic.help', "QIC: Help & Shortcuts"),
            keybinding: {
                primary: KeyMod.CtrlCmd | KeyCode.Slash,
                weight: KeybindingWeight.WorkbenchContrib,
                when: ContextKeyExpr.equals('qicPanelVisible', true)
            }
        });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
        const dialogService = accessor.get(IDialogService);
        await showHelpModal(dialogService);
    }
});
```

---

## 5. Checklist

### Quick Picks
- [ ] History quick pick with grouping
- [ ] Checkpoint quick pick with actions
- [ ] Provider quick pick
- [ ] Status quick pick
- [ ] Quota quick pick

### Status Bar
- [ ] Refactor status item with state service
- [ ] Add quota item
- [ ] Add checkpoint item
- [ ] Handle state changes reactively

### Modals
- [ ] Help & shortcuts modal
- [ ] Clear context confirmation
- [ ] Clear history confirmation
- [ ] Delete conversation confirmation
- [ ] Strategy change confirmation

### Commands
- [ ] Register all quick pick commands
- [ ] Add keybindings
- [ ] Add menu contributions

### Migration
- [ ] Remove floating checkpoint panel
- [ ] Remove floating settings panel
- [ ] Update menu to trigger quick picks
- [ ] Test all flows
