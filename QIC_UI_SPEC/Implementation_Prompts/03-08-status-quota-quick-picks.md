# Prompt 03-08: Status & Quota Quick Picks

**Phase:** 3 - Native Integration
**Dependencies:** 03-01 (Quick Pick Infrastructure), 03-05 (Status Bar)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Implement dedicated Status and Quota Quick Picks that provide detailed information and quick actions. These are triggered from the status bar and provide deeper insights than the status bar alone can show.

---

## Context

The spec (Section 9) defines two specialized Quick Picks:

1. **Status Quick Pick** - Shows connection details, provider info, latency, and quick actions
2. **Quota Quick Pick** - Shows token usage, cost, reset date, and quota management options

These complement the status bar by providing detailed drill-down information.

Reference: `QIC_UI_SPEC/QIC-UI-Specification-v1.4.md` Section 9

---

## Scope

### In Scope
- Status Quick Pick implementation
- Quota Quick Pick implementation
- Progress bar rendering for quota
- Quick actions for both
- Keyboard shortcuts
- Status bar click integration

### Out of Scope
- Status bar item itself (03-05)
- Provider switching logic (03-04)
- Billing/payment integration

---

## Pre-Conditions

- [ ] 03-01 complete (Quick Pick infrastructure)
- [ ] 03-05 complete (Status bar exists)
- [ ] State service with connection/quota data
- [ ] Git branch created: `qic-ui/03-08-status-quota`

---

## Tasks

### 1. Create Status Quick Pick

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/statusQuickPick.ts

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { IQicStateService, ServiceStatus, ConnectionInfo } from '../../common/state/qicStateService.js';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';

interface StatusQuickPickItem extends IQuickPickItem {
    action?: string;
}

export class StatusQuickPick {
    constructor(
        @IQuickInputService private readonly quickInputService: IQuickInputService,
        @IQicStateService private readonly stateService: IQicStateService,
        @ICommandService private readonly commandService: ICommandService,
        @IOpenerService private readonly openerService: IOpenerService,
    ) {}

    async show(): Promise<void> {
        const state = this.stateService.getState();
        const connection = state.connection;

        const items: (StatusQuickPickItem | IQuickPickSeparator)[] = [];

        // Current status header
        items.push({
            label: this.getStatusLabel(state.serviceStatus, connection),
            description: this.getStatusDescription(state.serviceStatus),
            detail: this.getStatusDetail(connection),
            alwaysShow: true,
        });

        items.push({ type: 'separator', label: '' });

        // Connection details
        if (connection) {
            items.push({
                label: `$(cloud) Provider: ${connection.provider}`,
                description: connection.model || '',
            });

            if (connection.latencyMs !== undefined) {
                items.push({
                    label: `$(dashboard) Latency: ${connection.latencyMs}ms`,
                    description: this.getLatencyRating(connection.latencyMs),
                });
            }

            if (state.degradationLevel > 0) {
                items.push({
                    label: `$(warning) Degradation Level: ${state.degradationLevel}`,
                    description: this.getDegradationDescription(state.degradationLevel),
                });
            }
        }

        items.push({ type: 'separator', label: 'Actions' });

        // Quick actions
        items.push({
            label: '$(sync) Test connection',
            action: 'test-connection',
        });

        items.push({
            label: '$(arrow-swap) Switch provider',
            action: 'switch-provider',
        });

        items.push({
            label: '$(globe) View status page',
            action: 'status-page',
        });

        items.push({
            label: '$(gear) Open QIC settings',
            action: 'settings',
        });

        // Show Quick Pick
        const quickPick = this.quickInputService.createQuickPick<StatusQuickPickItem>();
        quickPick.items = items;
        quickPick.placeholder = localize('qic.status.placeholder', 'QIC Connection Status');
        quickPick.canSelectMany = false;

        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0];
            if (selected?.action) {
                this.executeAction(selected.action);
            }
            quickPick.hide();
        });

        quickPick.show();
    }

    private getStatusLabel(status: ServiceStatus, connection?: ConnectionInfo): string {
        const icon = this.getStatusIcon(status);
        const statusText = this.getStatusText(status);
        const provider = connection?.provider || 'Not connected';

        return `${icon} ${statusText} — ${provider}`;
    }

    private getStatusIcon(status: ServiceStatus): string {
        switch (status) {
            case 'ready': return '$(circle-filled)';
            case 'degraded': return '$(circle-outline)';
            case 'error': return '$(error)';
            case 'initializing': return '$(loading~spin)';
            default: return '$(circle-outline)';
        }
    }

    private getStatusText(status: ServiceStatus): string {
        switch (status) {
            case 'ready': return 'Connected';
            case 'degraded': return 'Degraded';
            case 'error': return 'Error';
            case 'initializing': return 'Connecting...';
            default: return 'Unknown';
        }
    }

    private getStatusDescription(status: ServiceStatus): string {
        switch (status) {
            case 'ready': return 'All systems operational';
            case 'degraded': return 'Some features limited';
            case 'error': return 'Connection failed';
            case 'initializing': return 'Please wait...';
            default: return '';
        }
    }

    private getStatusDetail(connection?: ConnectionInfo): string | undefined {
        if (!connection) return undefined;

        const parts: string[] = [];
        if (connection.latencyMs) {
            parts.push(`${connection.latencyMs}ms`);
        }
        if (connection.region) {
            parts.push(connection.region);
        }
        return parts.join(' · ');
    }

    private getLatencyRating(ms: number): string {
        if (ms < 100) return 'Excellent';
        if (ms < 300) return 'Good';
        if (ms < 500) return 'Fair';
        return 'Slow';
    }

    private getDegradationDescription(level: number): string {
        switch (level) {
            case 1: return 'High latency detected';
            case 2: return 'Context reduced to 16K';
            case 3: return 'Limited features only';
            case 4: return 'Text-only mode';
            default: return '';
        }
    }

    private async executeAction(action: string): Promise<void> {
        switch (action) {
            case 'test-connection':
                await this.commandService.executeCommand('qic.testConnection');
                break;
            case 'switch-provider':
                await this.commandService.executeCommand('qic.showProviderQuickPick');
                break;
            case 'status-page':
                await this.openerService.open(URI.parse('https://status.quantlab.io'));
                break;
            case 'settings':
                await this.commandService.executeCommand('workbench.action.openSettings', 'qic');
                break;
        }
    }
}
```

### 2. Create Quota Quick Pick

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/quotaQuickPick.ts

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { IQicStateService, QuotaState } from '../../common/state/qicStateService.js';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';

interface QuotaQuickPickItem extends IQuickPickItem {
    action?: string;
}

export class QuotaQuickPick {
    constructor(
        @IQuickInputService private readonly quickInputService: IQuickInputService,
        @IQicStateService private readonly stateService: IQicStateService,
        @ICommandService private readonly commandService: ICommandService,
        @IOpenerService private readonly openerService: IOpenerService,
    ) {}

    async show(): Promise<void> {
        const state = this.stateService.getState();
        const quota = state.quota;

        if (!quota) {
            // No quota info available
            this.showNoQuotaMessage();
            return;
        }

        const items: (QuotaQuickPickItem | IQuickPickSeparator)[] = [];

        // Usage header with progress
        const percentage = Math.round((quota.used / quota.limit) * 100);
        const progressBar = this.createProgressBar(percentage);

        items.push({
            label: `${this.formatTokens(quota.used)} / ${this.formatTokens(quota.limit)} (${percentage}%)`,
            description: progressBar,
            alwaysShow: true,
        });

        // Cost estimate
        if (quota.costUsed !== undefined && quota.costLimit !== undefined) {
            items.push({
                label: `$(credit-card) Est: $${quota.costUsed.toFixed(2)} used · $${(quota.costLimit - quota.costUsed).toFixed(2)} remaining`,
            });
        }

        // Reset date
        if (quota.resetDate) {
            const resetIn = this.formatResetTime(quota.resetDate);
            items.push({
                label: `$(calendar) Resets ${resetIn}`,
            });
        }

        items.push({ type: 'separator', label: 'Breakdown' });

        // Usage breakdown by type
        if (quota.breakdown) {
            if (quota.breakdown.chat) {
                items.push({
                    label: `$(comment-discussion) Chat: ${this.formatTokens(quota.breakdown.chat)}`,
                });
            }
            if (quota.breakdown.completion) {
                items.push({
                    label: `$(code) Completions: ${this.formatTokens(quota.breakdown.completion)}`,
                });
            }
            if (quota.breakdown.embeddings) {
                items.push({
                    label: `$(search) Embeddings: ${this.formatTokens(quota.breakdown.embeddings)}`,
                });
            }
        }

        items.push({ type: 'separator', label: 'Actions' });

        // Actions
        items.push({
            label: '$(graph) View usage history',
            action: 'usage-history',
        });

        items.push({
            label: '$(arrow-up) Upgrade plan',
            action: 'upgrade',
        });

        items.push({
            label: '$(server) Switch to Ollama (unlimited)',
            action: 'switch-ollama',
            description: 'Local inference',
        });

        // Show Quick Pick
        const quickPick = this.quickInputService.createQuickPick<QuotaQuickPickItem>();
        quickPick.items = items;
        quickPick.placeholder = localize('qic.quota.placeholder', 'QIC Token Usage');
        quickPick.canSelectMany = false;

        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0];
            if (selected?.action) {
                this.executeAction(selected.action);
            }
            quickPick.hide();
        });

        quickPick.show();
    }

    private showNoQuotaMessage(): void {
        this.quickInputService.pick([
            {
                label: '$(info) Quota information not available',
                description: 'Using local or unlimited provider',
            }
        ], {
            placeHolder: 'QIC Token Usage',
        });
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(1)}M`;
        }
        if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(0)}K`;
        }
        return tokens.toString();
    }

    private createProgressBar(percentage: number): string {
        const filled = Math.round(percentage / 5); // 20 segments
        const empty = 20 - filled;

        let bar = '';
        for (let i = 0; i < filled; i++) bar += '█';
        for (let i = 0; i < empty; i++) bar += '░';

        return bar;
    }

    private formatResetTime(resetDate: number): string {
        const now = Date.now();
        const diff = resetDate - now;

        if (diff <= 0) {
            return 'soon';
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

        if (days > 0) {
            return `in ${days} day${days > 1 ? 's' : ''}`;
        }
        if (hours > 0) {
            return `in ${hours} hour${hours > 1 ? 's' : ''}`;
        }
        return 'in less than an hour';
    }

    private async executeAction(action: string): Promise<void> {
        switch (action) {
            case 'usage-history':
                await this.openerService.open(URI.parse('https://quantlab.io/usage'));
                break;
            case 'upgrade':
                await this.openerService.open(URI.parse('https://quantlab.io/upgrade'));
                break;
            case 'switch-ollama':
                await this.commandService.executeCommand('qic.switchProvider', 'ollama');
                break;
        }
    }
}
```

### 3. Register Commands

```typescript
// In qic.contribution.ts or quickPickCommands.ts

import { StatusQuickPick } from './quickPicks/statusQuickPick.js';
import { QuotaQuickPick } from './quickPicks/quotaQuickPick.js';

// Register commands
CommandsRegistry.registerCommand('qic.showStatusQuickPick', async (accessor) => {
    const quickPick = accessor.get(IInstantiationService).createInstance(StatusQuickPick);
    await quickPick.show();
});

CommandsRegistry.registerCommand('qic.showQuotaQuickPick', async (accessor) => {
    const quickPick = accessor.get(IInstantiationService).createInstance(QuotaQuickPick);
    await quickPick.show();
});

// Register keybindings
KeybindingsRegistry.registerKeybindingRule({
    id: 'qic.showStatusQuickPick',
    weight: KeybindingWeight.WorkbenchContrib,
    when: undefined,
    primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
});
```

### 4. Wire to Status Bar

```typescript
// Update qicStatusBarItem.ts to use these Quick Picks

// Status item click handler
private createStatusBarItems(): void {
    this.statusEntry = this.statusbarService.addEntry(
        {
            name: localize('qic.statusBar.name', 'QIC Status'),
            text: '$(sparkle) QIC',
            tooltip: localize('qic.statusBar.tooltip', 'QIC - Click for details'),
            command: 'qic.showStatusQuickPick',  // Opens Status Quick Pick
            ariaLabel: localize('qic.statusBar.ariaLabel', 'QIC Status'),
        },
        STATUS_BAR_ID,
        StatusbarAlignment.LEFT,
        100
    );

    // Quota item click handler
    this.quotaEntry = this.statusbarService.addEntry(
        {
            name: localize('qic.quotaBar.name', 'QIC Quota'),
            text: '',
            tooltip: '',
            command: 'qic.showQuotaQuickPick',  // Opens Quota Quick Pick
            ariaLabel: localize('qic.quotaBar.ariaLabel', 'QIC Token Usage'),
        },
        QUOTA_BAR_ID,
        StatusbarAlignment.RIGHT,
        50
    );
}
```

---

## Verification

### Success Criteria
- [ ] Status Quick Pick shows connection info
- [ ] Status Quick Pick shows latency
- [ ] Status Quick Pick shows degradation level
- [ ] Quota Quick Pick shows usage
- [ ] Quota Quick Pick shows progress bar
- [ ] Quota Quick Pick shows cost estimate
- [ ] All actions work correctly
- [ ] Keyboard shortcut works
- [ ] Status bar clicks open Quick Picks

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Status click | Click status bar item | Status Quick Pick opens |
| Quota click | Click quota item | Quota Quick Pick opens |
| Test connection | Select action | Connection tested |
| Switch provider | Select action | Provider Quick Pick opens |
| Usage history | Select action | Browser opens |
| Progress bar | Check at various levels | Accurate representation |

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/quickPicks/statusQuickPick.ts
git checkout src/vs/workbench/contrib/qic/browser/quickPicks/quotaQuickPick.ts
```

---

## Notes

- Progress bar uses Unicode block characters
- Cost estimates are approximations
- Ollama switch requires Ollama to be running
- Status page URL should be configurable
- Consider caching quota data to reduce API calls
