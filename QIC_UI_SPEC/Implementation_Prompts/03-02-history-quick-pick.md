# Prompt 03-02: History Quick Pick

**Phase:** 3 - Native Integration
**Dependencies:** 03-01 (Quick Pick Infrastructure)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement the conversation history Quick Pick: display past conversations grouped by date, support search, enable load/delete/export actions, and integrate with the state service.

---

## Context

The history Quick Pick replaces the floating history panel with a native VS Code experience:
- Shows past conversations grouped by date (Today, Yesterday, This Week, etc.)
- Supports fuzzy search across titles and content
- Allows loading, deleting, and exporting conversations
- Uses action buttons for secondary actions

Per ADR-005, we use the QuickInput API for native feel and built-in features.

Reference: `QIC_UI_SPEC/Optimal_plan/07-NATIVE-INTEGRATION.md`

---

## Scope

### In Scope
- Create `historyQuickPick.ts`
- Implement conversation list loading
- Implement date grouping
- Implement search filtering
- Implement load conversation action
- Implement delete action (with confirmation)
- Implement export action
- Wire to menu and keyboard shortcut
- Handle empty state

### Out of Scope
- Conversation persistence (existing)
- Export format selection (use JSON for now)
- Bulk operations

---

## Pre-Conditions

- [ ] 03-01 complete (Quick Pick infrastructure)
- [ ] Phase 2 complete
- [ ] Git branch created: `qic-ui/03-02-history-quick-pick`

---

## Tasks

### 1. Create History Quick Pick

```bash
touch src/vs/workbench/contrib/qic/browser/quickPicks/historyQuickPick.ts
```

### 2. Implement History Quick Pick

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/historyQuickPick.ts

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { IQicStateService, ConversationSummary } from '../common/state/qicStateService.js';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { localize } from 'vs/nls';
import { ThemeIcon } from 'vs/base/common/themables';
import { Codicon } from 'vs/base/common/codicons';

interface ConversationQuickPickItem extends IQuickPickItem {
    conversationId: string;
    timestamp: Date;
    messageCount: number;
}

export class HistoryQuickPick {
    constructor(
        @IQuickInputService private readonly quickInputService: IQuickInputService,
        @IQicStateService private readonly stateService: IQicStateService,
        @IDialogService private readonly dialogService: IDialogService,
        @INotificationService private readonly notificationService: INotificationService,
    ) {}

    async show(): Promise<string | undefined> {
        const conversations = await this.loadConversations();

        if (conversations.length === 0) {
            this.notificationService.info(localize('qic.history.empty', 'No conversation history yet.'));
            return undefined;
        }

        const items = this.buildQuickPickItems(conversations);

        const disposables: IDisposable[] = [];

        return new Promise<string | undefined>((resolve) => {
            const picker = this.quickInputService.createQuickPick<ConversationQuickPickItem>();

            picker.title = localize('qic.history.title', 'Conversation History');
            picker.placeholder = localize('qic.history.placeholder', 'Search conversations...');
            picker.matchOnDescription = true;
            picker.matchOnDetail = true;
            picker.items = items;
            picker.sortByLabel = false; // Preserve our date-based ordering

            // Action buttons on each item
            picker.onDidTriggerItemButton(async (e) => {
                const item = e.item as ConversationQuickPickItem;
                const buttonIndex = picker.items
                    .filter((i): i is ConversationQuickPickItem => 'conversationId' in i)
                    .find(i => i.conversationId === item.conversationId)
                    ?.buttons?.indexOf(e.button) ?? -1;

                if (buttonIndex === 0) {
                    // Delete button
                    await this.confirmDelete(item);
                    // Refresh list
                    const refreshed = await this.loadConversations();
                    picker.items = this.buildQuickPickItems(refreshed);
                } else if (buttonIndex === 1) {
                    // Export button
                    await this.exportConversation(item.conversationId);
                }
            });

            picker.onDidAccept(() => {
                const selected = picker.selectedItems[0] as ConversationQuickPickItem;
                if (selected?.conversationId) {
                    resolve(selected.conversationId);
                } else {
                    resolve(undefined);
                }
                picker.dispose();
            });

            picker.onDidHide(() => {
                resolve(undefined);
                picker.dispose();
            });

            picker.show();
        });
    }

    private async loadConversations(): Promise<ConversationSummary[]> {
        // Get from state service or database
        return this.stateService.getConversationSummaries?.() ?? [];
    }

    private buildQuickPickItems(conversations: ConversationSummary[]): (ConversationQuickPickItem | IQuickPickSeparator)[] {
        const items: (ConversationQuickPickItem | IQuickPickSeparator)[] = [];
        const grouped = this.groupByDate(conversations);

        const groups = [
            { key: 'today', label: localize('qic.history.today', 'Today') },
            { key: 'yesterday', label: localize('qic.history.yesterday', 'Yesterday') },
            { key: 'thisWeek', label: localize('qic.history.thisWeek', 'This Week') },
            { key: 'thisMonth', label: localize('qic.history.thisMonth', 'This Month') },
            { key: 'older', label: localize('qic.history.older', 'Older') },
        ];

        for (const group of groups) {
            const groupItems = grouped[group.key];
            if (groupItems && groupItems.length > 0) {
                items.push({ type: 'separator', label: group.label });
                items.push(...groupItems.map(conv => this.createQuickPickItem(conv)));
            }
        }

        return items;
    }

    private createQuickPickItem(conv: ConversationSummary): ConversationQuickPickItem {
        return {
            conversationId: conv.id,
            label: conv.title || localize('qic.history.untitled', 'Untitled Conversation'),
            description: this.formatRelativeTime(new Date(conv.timestamp)),
            detail: conv.preview
                ? `${conv.messageCount} messages • ${conv.preview.substring(0, 60)}...`
                : `${conv.messageCount} messages`,
            timestamp: new Date(conv.timestamp),
            messageCount: conv.messageCount,
            iconClass: ThemeIcon.asClassName(Codicon.comment),
            buttons: [
                {
                    iconClass: ThemeIcon.asClassName(Codicon.trash),
                    tooltip: localize('qic.history.delete', 'Delete'),
                },
                {
                    iconClass: ThemeIcon.asClassName(Codicon.export),
                    tooltip: localize('qic.history.export', 'Export'),
                },
            ],
        };
    }

    private groupByDate(conversations: ConversationSummary[]): Record<string, ConversationSummary[]> {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        const thisWeekStart = new Date(today.getTime() - today.getDay() * 24 * 60 * 60 * 1000);
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const groups: Record<string, ConversationSummary[]> = {
            today: [],
            yesterday: [],
            thisWeek: [],
            thisMonth: [],
            older: [],
        };

        // Sort by timestamp descending
        const sorted = [...conversations].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        for (const conv of sorted) {
            const date = new Date(conv.timestamp);

            if (date >= today) {
                groups.today.push(conv);
            } else if (date >= yesterday) {
                groups.yesterday.push(conv);
            } else if (date >= thisWeekStart) {
                groups.thisWeek.push(conv);
            } else if (date >= thisMonthStart) {
                groups.thisMonth.push(conv);
            } else {
                groups.older.push(conv);
            }
        }

        return groups;
    }

    private formatRelativeTime(date: Date): string {
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) {
            return localize('qic.time.justNow', 'Just now');
        } else if (diffMins < 60) {
            return localize('qic.time.minsAgo', '{0} min ago', diffMins);
        } else if (diffHours < 24) {
            return localize('qic.time.hoursAgo', '{0}h ago', diffHours);
        } else if (diffDays < 7) {
            return localize('qic.time.daysAgo', '{0}d ago', diffDays);
        } else {
            return date.toLocaleDateString();
        }
    }

    private async confirmDelete(item: ConversationQuickPickItem): Promise<void> {
        const result = await this.dialogService.confirm({
            message: localize('qic.history.confirmDelete', 'Delete "{0}"?', item.label),
            detail: localize('qic.history.confirmDeleteDetail', 'This conversation has {0} messages. This action cannot be undone.', item.messageCount),
            primaryButton: localize('qic.history.deleteBtn', 'Delete'),
            type: 'warning',
        });

        if (result.confirmed) {
            await this.stateService.deleteConversation?.(item.conversationId);
            this.notificationService.info(localize('qic.history.deleted', 'Conversation deleted.'));
        }
    }

    private async exportConversation(conversationId: string): Promise<void> {
        try {
            const data = await this.stateService.exportConversation?.(conversationId);
            if (data) {
                // Trigger download or save dialog
                // For now, copy to clipboard
                await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                this.notificationService.info(localize('qic.history.exported', 'Conversation copied to clipboard as JSON.'));
            }
        } catch (error) {
            this.notificationService.error(localize('qic.history.exportError', 'Failed to export conversation.'));
        }
    }
}

// Factory function for registration
export function showHistoryQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService,
    dialogService: IDialogService,
    notificationService: INotificationService,
): Promise<string | undefined> {
    const picker = new HistoryQuickPick(quickInputService, stateService, dialogService, notificationService);
    return picker.show();
}
```

### 3. Register Command

In `qic.contribution.ts`:

```typescript
import { showHistoryQuickPick } from './quickPicks/historyQuickPick.js';

// Register command
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showHistory',
            title: localize('qic.showHistory', 'QIC: Show Conversation History'),
            category: 'QIC',
            keybinding: {
                weight: KeybindingWeight.WorkbenchContrib,
                primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyH,
            },
            menu: {
                id: MenuId.CommandPalette,
            },
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const quickInputService = accessor.get(IQuickInputService);
        const stateService = accessor.get(IQicStateService);
        const dialogService = accessor.get(IDialogService);
        const notificationService = accessor.get(INotificationService);

        const conversationId = await showHistoryQuickPick(
            quickInputService,
            stateService,
            dialogService,
            notificationService
        );

        if (conversationId) {
            // Load the selected conversation
            const panelService = accessor.get(IQicPanelService);
            await panelService.loadConversation(conversationId);
        }
    }
});
```

### 4. Wire to Panel Menu

Update `qicPanel.ts` to handle the Quick Pick trigger:

```typescript
// In handleWebviewMessage
case 'quickPick:history':
    this.showHistoryQuickPick();
    return;

private async showHistoryQuickPick(): Promise<void> {
    const conversationId = await showHistoryQuickPick(
        this.quickInputService,
        this.stateService,
        this.dialogService,
        this.notificationService
    );

    if (conversationId) {
        await this.loadConversation(conversationId);
    }
}
```

### 5. Add State Service Methods

Ensure state service has required methods:

```typescript
// In IQicStateService interface
getConversationSummaries(): Promise<ConversationSummary[]>;
deleteConversation(id: string): Promise<void>;
exportConversation(id: string): Promise<ConversationExport | null>;

// ConversationSummary type
export interface ConversationSummary {
    id: string;
    title: string;
    timestamp: string;
    messageCount: number;
    preview?: string;
}

export interface ConversationExport {
    id: string;
    title: string;
    messages: Message[];
    createdAt: string;
    exportedAt: string;
}
```

---

## Verification

### Success Criteria
- [ ] Quick Pick opens from menu "History" item
- [ ] Quick Pick opens with Ctrl+Shift+H
- [ ] Conversations grouped by date
- [ ] Search filters conversations
- [ ] Selecting conversation loads it
- [ ] Delete button shows confirmation
- [ ] Delete removes conversation
- [ ] Export copies JSON to clipboard
- [ ] Empty state shows notification
- [ ] Escape closes picker

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Open from menu | Click menu → History | Quick Pick opens |
| Open with shortcut | Press Ctrl+Shift+H | Quick Pick opens |
| Search | Type in search box | List filters |
| Select | Click conversation | Conversation loads |
| Delete | Click trash icon | Confirmation dialog |
| Confirm delete | Click Delete | Conversation removed |
| Cancel delete | Click Cancel | No change |
| Export | Click export icon | JSON copied |
| Empty state | No history | Notification shown |
| Escape | Press Escape | Picker closes |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/quickPicks/historyQuickPick.ts
# Revert registration changes
git checkout src/vs/workbench/contrib/qic/browser/qic.contribution.ts
```

---

## Notes

- Date grouping uses user's locale for formatting
- Search uses fuzzy matching on title, description, and detail
- Export currently copies to clipboard - file save can be added later
- Consider adding "Clear All History" option in future
- Consider pagination for very large history sets
