# Prompt 03-01: Quick Pick Infrastructure

**Phase:** 3 - Native Integration
**Dependencies:** Phase 2 Complete
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Create the infrastructure for VS Code Quick Picks that will replace the floating panels for history, checkpoints, provider selection, and status display.

---

## Context

The spec mandates using native VS Code Quick Picks instead of custom floating panels:
- Better accessibility
- Consistent UX with VS Code
- Less code to maintain
- Proper keyboard navigation

Quick Picks triggered from webview via messages like `quickPick:history`.

Reference: `QIC_UI_SPEC/Optimal_plan/07-NATIVE-INTEGRATION.md`

---

## Scope

### In Scope
- Create base Quick Pick handler
- Wire message types to Quick Pick triggers
- Create utility functions for Quick Pick items
- Handle Quick Pick selection callbacks
- Create Quick Pick command registrations

### Out of Scope
- Specific Quick Pick implementations (next prompts)
- Removing floating panels (after Quick Picks work)
- UI changes to webview

---

## Pre-Conditions

- [ ] Phase 2 complete
- [ ] Message protocol supports quickPick messages
- [ ] Git branch created: `qic-ui/03-01-quick-picks`

---

## Tasks

### 1. Create Quick Pick Handler

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/qicQuickPicks.ts

import { IQuickInputService, IQuickPickItem, QuickPickInput } from 'vs/platform/quickinput/common/quickInput';
import { Disposable } from 'vs/base/common/lifecycle';
import { IQicStateService } from '../common/state/qicStateService.js';

export interface QicQuickPickItem extends IQuickPickItem {
    id?: string;
    action?: string;
    data?: unknown;
}

export class QicQuickPickHandler extends Disposable {
    constructor(
        @IQuickInputService private readonly quickInputService: IQuickInputService,
        @IQicStateService private readonly stateService: IQicStateService,
    ) {
        super();
    }

    /**
     * Show a quick pick with QIC styling
     */
    async showQuickPick<T extends QicQuickPickItem>(
        items: T[] | Promise<T[]>,
        options: {
            title: string;
            placeholder?: string;
            canPickMany?: boolean;
            matchOnDescription?: boolean;
            matchOnDetail?: boolean;
        }
    ): Promise<T | undefined> {
        return this.quickInputService.pick(items, {
            title: options.title,
            placeHolder: options.placeholder,
            canPickMany: options.canPickMany ?? false,
            matchOnDescription: options.matchOnDescription ?? true,
            matchOnDetail: options.matchOnDetail ?? true,
        }) as Promise<T | undefined>;
    }

    /**
     * Show a quick pick with sections (using separators)
     */
    async showQuickPickWithSections<T extends QicQuickPickItem>(
        sections: Array<{
            label: string;
            items: T[];
        }>,
        options: {
            title: string;
            placeholder?: string;
        }
    ): Promise<T | undefined> {
        const items: QuickPickInput<T>[] = [];

        for (const section of sections) {
            // Add separator
            items.push({ type: 'separator', label: section.label });
            // Add items
            items.push(...section.items);
        }

        return this.quickInputService.pick(items, {
            title: options.title,
            placeHolder: options.placeholder,
        }) as Promise<T | undefined>;
    }

    /**
     * Format relative time for display
     */
    formatRelativeTime(timestamp: string | number | Date): string {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    }

    /**
     * Create a "no items" placeholder
     */
    createEmptyItem(message: string): QicQuickPickItem {
        return {
            label: `$(info) ${message}`,
            description: '',
            alwaysShow: true,
        };
    }
}
```

### 2. Create Quick Pick Message Handler

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/quickPickMessageHandler.ts

import { Disposable } from 'vs/base/common/lifecycle';
import { QicQuickPickHandler } from './qicQuickPicks.js';

// Import specific handlers (created in subsequent prompts)
import { HistoryQuickPick } from './historyQuickPick.js';
import { CheckpointsQuickPick } from './checkpointsQuickPick.js';
import { ProviderQuickPick } from './providerQuickPick.js';
import { StatusQuickPick } from './statusQuickPick.js';

export class QuickPickMessageHandler extends Disposable {
    private readonly historyPicker: HistoryQuickPick;
    private readonly checkpointsPicker: CheckpointsQuickPick;
    private readonly providerPicker: ProviderQuickPick;
    private readonly statusPicker: StatusQuickPick;

    constructor(
        private readonly baseHandler: QicQuickPickHandler,
        // ... other dependencies
    ) {
        super();

        this.historyPicker = new HistoryQuickPick(baseHandler);
        this.checkpointsPicker = new CheckpointsQuickPick(baseHandler);
        this.providerPicker = new ProviderQuickPick(baseHandler);
        this.statusPicker = new StatusQuickPick(baseHandler);
    }

    /**
     * Handle quick pick messages from webview
     */
    async handleMessage(msg: { type: string }): Promise<boolean> {
        switch (msg.type) {
            case 'quickPick:history':
                await this.historyPicker.show();
                return true;

            case 'quickPick:checkpoints':
                await this.checkpointsPicker.show();
                return true;

            case 'quickPick:provider':
                await this.providerPicker.show();
                return true;

            case 'quickPick:status':
                await this.statusPicker.show();
                return true;

            default:
                return false;
        }
    }
}
```

### 3. Create Quick Pick Interface Stubs

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/historyQuickPick.ts

import { QicQuickPickHandler, QicQuickPickItem } from './qicQuickPicks.js';

export class HistoryQuickPick {
    constructor(private readonly handler: QicQuickPickHandler) {}

    async show(): Promise<void> {
        // Implemented in 03-02
        console.log('[HistoryQuickPick] Not yet implemented');
    }
}

// Similar stubs for:
// - checkpointsQuickPick.ts
// - providerQuickPick.ts
// - statusQuickPick.ts
```

### 4. Register Commands

```typescript
// Add to qic.contribution.ts

import { registerAction2, Action2 } from 'vs/platform/actions/common/actions';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';

// History Quick Pick command
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showHistory',
            title: { value: 'QIC: Show Conversation History', original: 'QIC: Show Conversation History' },
            keybinding: {
                weight: KeybindingWeight.WorkbenchContrib,
                primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyH,
            },
            f1: true,
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const qicService = accessor.get(IQicService);
        qicService.showHistoryQuickPick();
    }
});

// Checkpoints Quick Pick command
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showCheckpoints',
            title: { value: 'QIC: Show Checkpoints', original: 'QIC: Show Checkpoints' },
            f1: true,
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const qicService = accessor.get(IQicService);
        qicService.showCheckpointsQuickPick();
    }
});
```

### 5. Wire to Panel

In `QicChatViewPane`:

```typescript
private quickPickHandler: QuickPickMessageHandler;

protected override renderBody(container: HTMLElement): void {
    // ... existing code ...

    // Initialize quick pick handler
    this.quickPickHandler = this._register(new QuickPickMessageHandler(
        new QicQuickPickHandler(this.quickInputService, this.stateService),
        // ... other deps
    ));
}

private handleWebviewMessage(msg: any): void {
    // Try quick pick handler
    if (msg.type?.startsWith('quickPick:')) {
        this.quickPickHandler.handleMessage(msg);
        return;
    }

    // ... other handling
}
```

---

## Verification

### Success Criteria
- [ ] Infrastructure compiles without errors
- [ ] Quick pick commands registered
- [ ] Message routing works
- [ ] Base handler utilities work
- [ ] Ready for specific implementations

### Verification Commands
```bash
# Build
npm run compile

# Check command registration
grep -r "qic.showHistory" out/
```

### Manual Test
1. Build and run extension
2. Open command palette
3. Search for "QIC: Show"
4. Verify commands appear
5. Run command (will show "not implemented" for now)

---

## Rollback

```bash
rm -rf src/vs/workbench/contrib/qic/browser/quickPicks/
```

---

## Notes

- This is infrastructure - specific pickers in next prompts
- Commands provide keyboard shortcuts
- Handler pattern allows easy testing
- Follow VS Code quick pick patterns for consistency
