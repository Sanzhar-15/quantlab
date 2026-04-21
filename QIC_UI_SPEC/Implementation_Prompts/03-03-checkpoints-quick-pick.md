# Prompt 03-03: Checkpoints Quick Pick

**Phase:** 3 - Native Integration
**Dependencies:** 03-01 (Quick Pick Infrastructure)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement the checkpoints Quick Pick: display available checkpoints with file counts, support restore and delete actions, show checkpoint details, and integrate with the existing CheckpointManager.

---

## Context

The checkpoints Quick Pick replaces the floating checkpoint panel with a native VS Code experience:
- Shows available checkpoints with descriptions and file counts
- Allows restoring to a previous checkpoint
- Supports deleting old checkpoints
- Shows which files would be affected before restore

Checkpoints are created automatically before QIC makes changes and can be restored if something goes wrong.

Reference: `QIC_UI_SPEC/Optimal_plan/07-NATIVE-INTEGRATION.md`

---

## Scope

### In Scope
- Create `checkpointQuickPick.ts`
- Implement checkpoint list loading
- Implement checkpoint detail view
- Implement restore action (with confirmation)
- Implement delete action
- Wire to menu and keyboard shortcut
- Handle empty state
- Show affected files preview

### Out of Scope
- Checkpoint creation (existing in CheckpointManager)
- Checkpoint diffing (Phase 5)
- Partial restore (restore full checkpoint only)

---

## Pre-Conditions

- [ ] 03-01 complete (Quick Pick infrastructure)
- [ ] CheckpointManager exists and works
- [ ] Git branch created: `qic-ui/03-03-checkpoints-quick-pick`

---

## Tasks

### 1. Create Checkpoints Quick Pick

```bash
touch src/vs/workbench/contrib/qic/browser/quickPicks/checkpointQuickPick.ts
```

### 2. Implement Checkpoints Quick Pick

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/checkpointQuickPick.ts

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator, QuickPickInput } from 'vs/platform/quickinput/common/quickInput';
import { IQicStateService, Checkpoint } from '../common/state/qicStateService.js';
import { CheckpointManager } from '../common/crashSafe/checkpointManager.js';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { localize } from 'vs/nls';
import { ThemeIcon } from 'vs/base/common/themables';
import { Codicon } from 'vs/base/common/codicons';

interface CheckpointQuickPickItem extends IQuickPickItem {
    checkpoint: Checkpoint;
}

export class CheckpointQuickPick {
    constructor(
        @IQuickInputService private readonly quickInputService: IQuickInputService,
        @IQicStateService private readonly stateService: IQicStateService,
        private readonly checkpointManager: CheckpointManager,
        @IDialogService private readonly dialogService: IDialogService,
        @INotificationService private readonly notificationService: INotificationService,
    ) {}

    async show(): Promise<{ action: 'restore' | 'delete'; checkpointId: string } | undefined> {
        const checkpoints = this.stateService.state.checkpoints || [];

        if (checkpoints.length === 0) {
            this.notificationService.info(localize('qic.checkpoints.empty', 'No checkpoints available. Checkpoints are created automatically when QIC makes changes.'));
            return undefined;
        }

        return new Promise((resolve) => {
            const picker = this.quickInputService.createQuickPick<CheckpointQuickPickItem>();

            picker.title = localize('qic.checkpoints.title', 'Checkpoints');
            picker.placeholder = localize('qic.checkpoints.placeholder', 'Select a checkpoint to restore...');
            picker.items = this.buildQuickPickItems(checkpoints);
            picker.sortByLabel = false;

            // Action buttons
            picker.onDidTriggerItemButton(async (e) => {
                const item = e.item as CheckpointQuickPickItem;
                const isDeleteButton = e.button.tooltip?.includes('Delete');

                if (isDeleteButton) {
                    await this.confirmDelete(item.checkpoint);
                    // Refresh list
                    picker.items = this.buildQuickPickItems(this.stateService.state.checkpoints || []);
                } else {
                    // Preview button - show affected files
                    await this.showCheckpointDetails(item.checkpoint);
                }
            });

            picker.onDidAccept(async () => {
                const selected = picker.selectedItems[0] as CheckpointQuickPickItem;
                if (selected?.checkpoint) {
                    const confirmed = await this.confirmRestore(selected.checkpoint);
                    if (confirmed) {
                        resolve({ action: 'restore', checkpointId: selected.checkpoint.id });
                    } else {
                        resolve(undefined);
                    }
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

    private buildQuickPickItems(checkpoints: Checkpoint[]): CheckpointQuickPickItem[] {
        // Sort by timestamp descending (newest first)
        const sorted = [...checkpoints].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        return sorted.map((checkpoint, index) => ({
            checkpoint,
            label: this.getCheckpointLabel(checkpoint, index),
            description: this.formatRelativeTime(new Date(checkpoint.timestamp)),
            detail: this.getCheckpointDetail(checkpoint),
            iconClass: ThemeIcon.asClassName(Codicon.history),
            buttons: [
                {
                    iconClass: ThemeIcon.asClassName(Codicon.eye),
                    tooltip: localize('qic.checkpoints.preview', 'Preview files'),
                },
                {
                    iconClass: ThemeIcon.asClassName(Codicon.trash),
                    tooltip: localize('qic.checkpoints.delete', 'Delete checkpoint'),
                },
            ],
        }));
    }

    private getCheckpointLabel(checkpoint: Checkpoint, index: number): string {
        if (checkpoint.description) {
            return checkpoint.description;
        }
        if (checkpoint.changeSetId) {
            return localize('qic.checkpoints.beforeChange', 'Before change #{0}', checkpoint.changeSetId.substring(0, 8));
        }
        return localize('qic.checkpoints.checkpoint', 'Checkpoint #{0}', index + 1);
    }

    private getCheckpointDetail(checkpoint: Checkpoint): string {
        const fileCount = checkpoint.files.length;
        const fileWord = fileCount === 1 ? 'file' : 'files';

        if (fileCount <= 3) {
            return `${fileCount} ${fileWord}: ${checkpoint.files.join(', ')}`;
        } else {
            const shown = checkpoint.files.slice(0, 2).join(', ');
            return `${fileCount} ${fileWord}: ${shown}, +${fileCount - 2} more`;
        }
    }

    private formatRelativeTime(date: Date): string {
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

        if (diffMins < 1) {
            return localize('qic.time.justNow', 'Just now');
        } else if (diffMins < 60) {
            return localize('qic.time.minsAgo', '{0} min ago', diffMins);
        } else if (diffHours < 24) {
            return localize('qic.time.hoursAgo', '{0}h ago', diffHours);
        } else {
            return date.toLocaleString();
        }
    }

    private async showCheckpointDetails(checkpoint: Checkpoint): Promise<void> {
        const items: QuickPickInput[] = [
            { type: 'separator', label: localize('qic.checkpoints.filesIncluded', 'Files in this checkpoint') },
            ...checkpoint.files.map(file => ({
                label: file,
                iconClass: ThemeIcon.asClassName(Codicon.file),
            })),
        ];

        const picker = this.quickInputService.createQuickPick();
        picker.title = checkpoint.description || localize('qic.checkpoints.details', 'Checkpoint Details');
        picker.placeholder = localize('qic.checkpoints.detailsPlaceholder', 'Files that will be restored');
        picker.items = items;
        picker.canSelectMany = false;

        picker.onDidAccept(() => {
            picker.dispose();
        });

        picker.onDidHide(() => {
            picker.dispose();
        });

        picker.show();
    }

    private async confirmRestore(checkpoint: Checkpoint): Promise<boolean> {
        const result = await this.dialogService.confirm({
            message: localize('qic.checkpoints.confirmRestore', 'Restore checkpoint?'),
            detail: localize(
                'qic.checkpoints.confirmRestoreDetail',
                'This will restore {0} file(s) to their state from {1}. Current changes will be overwritten.\n\nFiles:\n{2}',
                checkpoint.files.length,
                new Date(checkpoint.timestamp).toLocaleString(),
                checkpoint.files.slice(0, 5).join('\n') + (checkpoint.files.length > 5 ? `\n...and ${checkpoint.files.length - 5} more` : '')
            ),
            primaryButton: localize('qic.checkpoints.restoreBtn', 'Restore'),
            type: 'warning',
        });

        return result.confirmed;
    }

    private async confirmDelete(checkpoint: Checkpoint): Promise<void> {
        const result = await this.dialogService.confirm({
            message: localize('qic.checkpoints.confirmDelete', 'Delete checkpoint?'),
            detail: localize(
                'qic.checkpoints.confirmDeleteDetail',
                'This checkpoint contains {0} file(s). This action cannot be undone.',
                checkpoint.files.length
            ),
            primaryButton: localize('qic.checkpoints.deleteBtn', 'Delete'),
            type: 'warning',
        });

        if (result.confirmed) {
            this.stateService.removeCheckpoint(checkpoint.id);
            await this.checkpointManager.deleteCheckpoint?.(checkpoint.id);
            this.notificationService.info(localize('qic.checkpoints.deleted', 'Checkpoint deleted.'));
        }
    }
}

// Factory function
export async function showCheckpointQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService,
    checkpointManager: CheckpointManager,
    dialogService: IDialogService,
    notificationService: INotificationService,
): Promise<{ action: 'restore' | 'delete'; checkpointId: string } | undefined> {
    const picker = new CheckpointQuickPick(
        quickInputService,
        stateService,
        checkpointManager,
        dialogService,
        notificationService
    );
    return picker.show();
}
```

### 3. Register Command

In `qic.contribution.ts`:

```typescript
import { showCheckpointQuickPick } from './quickPicks/checkpointQuickPick.js';

registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showCheckpoints',
            title: localize('qic.showCheckpoints', 'QIC: Show Checkpoints'),
            category: 'QIC',
            menu: {
                id: MenuId.CommandPalette,
            },
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const quickInputService = accessor.get(IQuickInputService);
        const stateService = accessor.get(IQicStateService);
        const checkpointManager = accessor.get(CheckpointManager);
        const dialogService = accessor.get(IDialogService);
        const notificationService = accessor.get(INotificationService);

        const result = await showCheckpointQuickPick(
            quickInputService,
            stateService,
            checkpointManager,
            dialogService,
            notificationService
        );

        if (result?.action === 'restore') {
            try {
                await checkpointManager.restore(result.checkpointId);
                notificationService.info(
                    localize('qic.checkpoints.restored', 'Checkpoint restored successfully.')
                );
            } catch (error) {
                notificationService.error(
                    localize('qic.checkpoints.restoreError', 'Failed to restore checkpoint: {0}', error.message)
                );
            }
        }
    }
});
```

### 4. Wire to Panel Menu

Update `qicPanel.ts`:

```typescript
case 'quickPick:checkpoints':
    this.showCheckpointQuickPick();
    return;

private async showCheckpointQuickPick(): Promise<void> {
    const result = await showCheckpointQuickPick(
        this.quickInputService,
        this.stateService,
        this.checkpointManager,
        this.dialogService,
        this.notificationService
    );

    if (result?.action === 'restore') {
        try {
            await this.checkpointManager.restore(result.checkpointId);
            this.notificationService.info('Checkpoint restored successfully.');

            // Notify webview of potential file changes
            this.postMessage({
                type: 'checkpoint:restored',
                revision: this.stateService.revision,
                payload: { id: result.checkpointId, filesChanged: 0 }
            });
        } catch (error) {
            this.notificationService.error(`Failed to restore checkpoint: ${error.message}`);
        }
    }
}
```

### 5. Add Create Checkpoint to Menu

Add a way to manually create checkpoints:

```typescript
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.createCheckpoint',
            title: localize('qic.createCheckpoint', 'QIC: Create Checkpoint'),
            category: 'QIC',
            menu: {
                id: MenuId.CommandPalette,
            },
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const checkpointManager = accessor.get(CheckpointManager);
        const notificationService = accessor.get(INotificationService);
        const quickInputService = accessor.get(IQuickInputService);

        const description = await quickInputService.input({
            title: localize('qic.checkpoints.descriptionTitle', 'Checkpoint Description'),
            placeHolder: localize('qic.checkpoints.descriptionPlaceholder', 'Optional description...'),
        });

        try {
            await checkpointManager.createCheckpoint(description);
            notificationService.info(localize('qic.checkpoints.created', 'Checkpoint created.'));
        } catch (error) {
            notificationService.error(
                localize('qic.checkpoints.createError', 'Failed to create checkpoint: {0}', error.message)
            );
        }
    }
});
```

---

## Verification

### Success Criteria
- [ ] Quick Pick opens from menu "Checkpoints" item
- [ ] Quick Pick opens from Command Palette
- [ ] Checkpoints sorted by date (newest first)
- [ ] Preview button shows file list
- [ ] Selecting checkpoint shows restore confirmation
- [ ] Restore confirmation shows affected files
- [ ] Restore works and shows success notification
- [ ] Delete button shows confirmation
- [ ] Delete removes checkpoint
- [ ] Empty state shows helpful message
- [ ] Manual checkpoint creation works

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Open from menu | Click menu → Checkpoints | Quick Pick opens |
| Empty state | No checkpoints exist | Notification shown |
| Preview files | Click eye icon | File list shown |
| Select checkpoint | Click checkpoint | Confirmation dialog |
| Confirm restore | Click Restore | Files restored |
| Cancel restore | Click Cancel | No change |
| Delete | Click trash icon | Confirmation dialog |
| Confirm delete | Click Delete | Checkpoint removed |
| Create manual | Run create command | Checkpoint created |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/quickPicks/checkpointQuickPick.ts
git checkout src/vs/workbench/contrib/qic/browser/qic.contribution.ts
```

---

## Notes

- Checkpoints are stored in the quarantine directory
- Restore overwrites current file state - warn user clearly
- Consider adding "Create before restore" option
- Checkpoint cleanup could be automated (e.g., keep last 10)
- Integration with git could show diff between checkpoint and current
