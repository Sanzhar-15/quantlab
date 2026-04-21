# Prompt 03-05: Status Bar Update

**Phase:** 3 - Native Integration
**Dependencies:** Phase 2 Complete
**Estimated Effort:** 1.5 sessions
**Critical Path:** Yes

---

## Objective

Update the VS Code status bar integration to reflect the dual state model (GAP-01), show quota information, and provide quick access to common actions. The status bar is always visible and provides at-a-glance QIC status.

---

## Context

The status bar should show:
1. **Service status** - Ready/degraded/error with color indicator
2. **Agent state** - Processing indicator when active
3. **Quota usage** - Token/cost usage with progress
4. **Quick actions** - Click to open panel, right-click for menu

Per the spec, the status bar items are:
- Left: QIC logo + status
- Right: Quota usage

The existing status bar item needs updating to:
- Use the new dual state model
- Show processing spinner during agent activity
- Display quota from state service
- Open Quick Picks on click

Reference: `QIC_UI_SPEC/Optimal_plan/07-NATIVE-INTEGRATION.md`

---

## Scope

### In Scope
- Update `qicStatusBarItem.ts`
- Implement dual state display (service + agent)
- Add quota display
- Add processing spinner
- Add click/context menu actions
- Subscribe to state service

### Out of Scope
- Quota Quick Pick details (use notification for now)
- Complex status bar menus
- Multiple status bar items

---

## Pre-Conditions

- [ ] Phase 2 complete
- [ ] State service with dual state
- [ ] Git branch created: `qic-ui/03-05-status-bar`

---

## Tasks

### 1. Update Status Bar Item

```typescript
// src/vs/workbench/contrib/qic/browser/qicStatusBarItem.ts

import { Disposable } from 'vs/base/common/lifecycle';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from 'vs/workbench/services/statusbar/browser/statusbar';
import { IQicStateService, ServiceStatus, AgentState, QuotaState } from '../common/state/qicStateService.js';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { localize } from 'vs/nls';
import { ThemeColor } from 'vs/base/common/themables';

const STATUS_BAR_ID = 'qic.statusBar';
const QUOTA_BAR_ID = 'qic.quotaBar';

interface StatusBarConfig {
    text: string;
    tooltip: string;
    color?: ThemeColor;
    backgroundColor?: ThemeColor;
    showSpinner?: boolean;
}

export class QicStatusBarItem extends Disposable {
    private statusEntry: IStatusbarEntryAccessor | null = null;
    private quotaEntry: IStatusbarEntryAccessor | null = null;

    constructor(
        @IStatusbarService private readonly statusbarService: IStatusbarService,
        @IQicStateService private readonly stateService: IQicStateService,
        @ICommandService private readonly commandService: ICommandService,
    ) {
        super();

        this.createStatusBarItems();
        this.subscribeToStateChanges();
        this.updateStatusBar();
        this.updateQuotaBar();
    }

    private createStatusBarItems(): void {
        // Main status item (left side)
        this.statusEntry = this.statusbarService.addEntry(
            {
                name: localize('qic.statusBar.name', 'QIC Status'),
                text: '$(sparkle) QIC',
                tooltip: localize('qic.statusBar.tooltip', 'QIC - Click to open panel'),
                command: 'qic.togglePanel',
                ariaLabel: localize('qic.statusBar.ariaLabel', 'QIC Status'),
            },
            STATUS_BAR_ID,
            StatusbarAlignment.LEFT,
            100 // Priority
        );

        // Quota item (right side)
        this.quotaEntry = this.statusbarService.addEntry(
            {
                name: localize('qic.quotaBar.name', 'QIC Quota'),
                text: '',
                tooltip: '',
                command: 'qic.showQuotaDetails',
                ariaLabel: localize('qic.quotaBar.ariaLabel', 'QIC Token Usage'),
            },
            QUOTA_BAR_ID,
            StatusbarAlignment.RIGHT,
            50
        );

        this._register(this.statusEntry);
        this._register(this.quotaEntry);
    }

    private subscribeToStateChanges(): void {
        this._register(this.stateService.onDidChangeState((patch) => {
            if (patch.path === '*' || patch.path === 'serviceStatus' || patch.path === 'agentState') {
                this.updateStatusBar();
            }
            if (patch.path === '*' || patch.path === 'quota') {
                this.updateQuotaBar();
            }
        }));
    }

    private updateStatusBar(): void {
        if (!this.statusEntry) return;

        const serviceStatus = this.stateService.state.serviceStatus;
        const agentState = this.stateService.state.agentState;

        const config = this.getStatusBarConfig(serviceStatus, agentState);

        this.statusEntry.update({
            text: config.text,
            tooltip: config.tooltip,
            color: config.color,
            backgroundColor: config.backgroundColor,
            command: 'qic.togglePanel',
        });
    }

    private getStatusBarConfig(serviceStatus: ServiceStatus, agentState: AgentState): StatusBarConfig {
        // Base config by service status
        let text: string;
        let tooltip: string;
        let color: ThemeColor | undefined;
        let backgroundColor: ThemeColor | undefined;

        switch (serviceStatus) {
            case 'initializing':
                text = '$(loading~spin) QIC';
                tooltip = localize('qic.status.initializing', 'QIC is starting up...');
                color = new ThemeColor('statusBarItem.warningForeground');
                break;

            case 'ready':
                text = '$(sparkle) QIC';
                tooltip = localize('qic.status.ready', 'QIC is ready');
                color = undefined; // Default color
                break;

            case 'degraded':
                text = '$(warning) QIC';
                tooltip = localize('qic.status.degraded', 'QIC is running with limited functionality');
                color = new ThemeColor('statusBarItem.warningForeground');
                backgroundColor = new ThemeColor('statusBarItem.warningBackground');
                break;

            case 'error':
                text = '$(error) QIC';
                tooltip = localize('qic.status.error', 'QIC encountered an error - click to retry');
                color = new ThemeColor('statusBarItem.errorForeground');
                backgroundColor = new ThemeColor('statusBarItem.errorBackground');
                break;

            default:
                text = '$(sparkle) QIC';
                tooltip = 'QIC';
        }

        // Overlay agent state on ready service
        if (serviceStatus === 'ready') {
            switch (agentState) {
                case 'processing':
                    text = '$(loading~spin) QIC';
                    tooltip = localize('qic.status.processing', 'QIC is processing your request...');
                    break;

                case 'waiting_approval':
                    text = '$(bell) QIC';
                    tooltip = localize('qic.status.waitingApproval', 'QIC is waiting for your approval');
                    color = new ThemeColor('statusBarItem.warningForeground');
                    break;

                case 'error':
                    text = '$(error) QIC';
                    tooltip = localize('qic.status.agentError', 'Request failed - click to see details');
                    color = new ThemeColor('statusBarItem.errorForeground');
                    break;

                case 'suspended':
                    text = '$(debug-pause) QIC';
                    tooltip = localize('qic.status.suspended', 'QIC conversation is suspended');
                    color = new ThemeColor('statusBarItem.warningForeground');
                    break;
            }
        }

        return { text, tooltip, color, backgroundColor };
    }

    private updateQuotaBar(): void {
        if (!this.quotaEntry) return;

        const quota = this.stateService.state.quota;

        if (!quota || quota.limit === 0) {
            this.quotaEntry.update({
                text: '',
                tooltip: '',
            });
            return;
        }

        const percentage = Math.round((quota.used / quota.limit) * 100);
        const text = this.formatQuotaText(quota, percentage);
        const tooltip = this.formatQuotaTooltip(quota, percentage);
        const color = this.getQuotaColor(percentage);

        this.quotaEntry.update({
            text,
            tooltip,
            color,
        });
    }

    private formatQuotaText(quota: QuotaState, percentage: number): string {
        if (quota.estimatedCost > 0) {
            return `$(pulse) $${quota.estimatedCost.toFixed(2)}`;
        }

        const used = this.formatTokenCount(quota.used);
        const limit = this.formatTokenCount(quota.limit);
        return `$(pulse) ${used}/${limit}`;
    }

    private formatQuotaTooltip(quota: QuotaState, percentage: number): string {
        const lines = [
            localize('qic.quota.title', 'QIC Usage'),
            '',
            localize('qic.quota.tokens', 'Tokens: {0} / {1} ({2}%)',
                this.formatTokenCount(quota.used),
                this.formatTokenCount(quota.limit),
                percentage
            ),
        ];

        if (quota.estimatedCost > 0) {
            lines.push(localize('qic.quota.cost', 'Estimated cost: ${0}', quota.estimatedCost.toFixed(4)));
        }

        if (quota.resetDate) {
            const resetDate = new Date(quota.resetDate);
            lines.push('');
            lines.push(localize('qic.quota.resets', 'Resets: {0}', resetDate.toLocaleDateString()));
        }

        return lines.join('\n');
    }

    private formatTokenCount(count: number): string {
        if (count >= 1_000_000) {
            return `${(count / 1_000_000).toFixed(1)}M`;
        }
        if (count >= 1_000) {
            return `${(count / 1_000).toFixed(1)}K`;
        }
        return count.toString();
    }

    private getQuotaColor(percentage: number): ThemeColor | undefined {
        if (percentage >= 90) {
            return new ThemeColor('statusBarItem.errorForeground');
        }
        if (percentage >= 75) {
            return new ThemeColor('statusBarItem.warningForeground');
        }
        return undefined;
    }
}
```

### 2. Register Commands for Status Bar Actions

```typescript
// In qic.contribution.ts

// Toggle panel command
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.togglePanel',
            title: localize('qic.togglePanel', 'QIC: Toggle Panel'),
            category: 'QIC',
            keybinding: {
                weight: KeybindingWeight.WorkbenchContrib,
                primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyQ,
            },
        });
    }

    run(accessor: ServicesAccessor): void {
        const viewsService = accessor.get(IViewsService);
        viewsService.toggleViewVisibility('qic.chatView');
    }
});

// Show quota details command
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.showQuotaDetails',
            title: localize('qic.showQuotaDetails', 'QIC: Show Usage Details'),
            category: 'QIC',
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const stateService = accessor.get(IQicStateService);
        const notificationService = accessor.get(INotificationService);

        const quota = stateService.state.quota;
        const percentage = quota.limit > 0 ? Math.round((quota.used / quota.limit) * 100) : 0;

        const message = [
            `**Token Usage:** ${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} (${percentage}%)`,
            quota.estimatedCost > 0 ? `**Estimated Cost:** $${quota.estimatedCost.toFixed(4)}` : '',
            quota.resetDate ? `**Resets:** ${new Date(quota.resetDate).toLocaleDateString()}` : '',
        ].filter(Boolean).join('\n\n');

        notificationService.info(message);
    }
});
```

### 3. Register Status Bar Item

```typescript
// In qic.contribution.ts

import { QicStatusBarItem } from './qicStatusBarItem.js';

// Register the status bar item
workbench.registerWorkbenchContribution2(
    'qic.statusBarItem',
    QicStatusBarItem,
    WorkbenchPhase.AfterRestored
);
```

### 4. Add Context Menu (Optional)

```typescript
// Add context menu to status bar item
MenuRegistry.appendMenuItem(MenuId.StatusBarItem, {
    submenu: MenuId.QicStatusBarContext,
    title: localize('qic.statusBar.menu', 'QIC'),
    when: ContextKeyExpr.equals('statusBarItemId', STATUS_BAR_ID),
});

MenuRegistry.appendMenuItems([
    {
        id: MenuId.QicStatusBarContext,
        item: {
            command: { id: 'qic.togglePanel', title: localize('qic.openPanel', 'Open Panel') },
        }
    },
    {
        id: MenuId.QicStatusBarContext,
        item: {
            command: { id: 'qic.newChat', title: localize('qic.newChat', 'New Chat') },
        }
    },
    {
        id: MenuId.QicStatusBarContext,
        item: {
            command: { id: 'qic.showHistory', title: localize('qic.showHistory', 'History') },
        }
    },
    {
        id: MenuId.QicStatusBarContext,
        item: {
            command: { id: 'qic.showCheckpoints', title: localize('qic.showCheckpoints', 'Checkpoints') },
        }
    },
]);
```

---

## Verification

### Success Criteria
- [ ] Status bar shows QIC status
- [ ] Status updates when service state changes
- [ ] Spinner shows during processing
- [ ] Warning icon shows for degraded
- [ ] Error icon shows for error
- [ ] Bell icon shows for waiting approval
- [ ] Quota displays token usage
- [ ] Quota changes color at thresholds
- [ ] Click opens panel
- [ ] Ctrl+Shift+Q toggles panel
- [ ] Quota click shows details

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Ready state | Service ready | Sparkle icon, default color |
| Processing | Send message | Spinner icon |
| Degraded | Degrade service | Warning icon + background |
| Error | Trigger error | Error icon + background |
| Approval | Trigger approval | Bell icon |
| Quota normal | < 75% used | Default color |
| Quota warning | 75-90% used | Yellow color |
| Quota error | > 90% used | Red color |
| Click status | Click status bar | Panel opens |
| Keyboard | Ctrl+Shift+Q | Panel toggles |
| Quota click | Click quota | Details notification |

### State Transition Test

```typescript
// Test all state combinations
const states: [ServiceStatus, AgentState][] = [
    ['initializing', 'idle'],
    ['ready', 'idle'],
    ['ready', 'processing'],
    ['ready', 'waiting_approval'],
    ['ready', 'error'],
    ['ready', 'suspended'],
    ['degraded', 'processing'],
    ['error', 'idle'],
];

for (const [service, agent] of states) {
    stateService.setServiceStatus(service);
    stateService.setAgentState(agent);
    // Verify status bar updates correctly
}
```

---

## Rollback

```bash
git checkout src/vs/workbench/contrib/qic/browser/qicStatusBarItem.ts
```

---

## Amendment: Code Completion Status Indicator

The status bar should indicate when code completion features are degraded or disabled, providing users visibility into the full QIC capability state.

### Add Completion Status to State

```typescript
// In qicStateService.ts - extend state interface

interface CompletionStatus {
  enabled: boolean;
  status: 'active' | 'degraded' | 'disabled' | 'error';
  lastResponseMs?: number;
  errorMessage?: string;
  disabledReason?: 'quota_exceeded' | 'provider_unavailable' | 'user_disabled' | 'rate_limited';
}

interface QicState {
  // ... existing fields ...
  completionStatus: CompletionStatus;
}
```

### Add Completion Status Bar Item

```typescript
// In qicStatusBarItem.ts

const COMPLETION_BAR_ID = 'qic.completionBar';

export class QicStatusBarItem extends Disposable {
  private completionEntry: IStatusbarEntryAccessor | null = null;

  private createStatusBarItems(): void {
    // ... existing items ...

    // Completion status item (right side, before quota)
    this.completionEntry = this.statusbarService.addEntry(
      {
        name: localize('qic.completionBar.name', 'QIC Completions'),
        text: '',
        tooltip: '',
        command: 'qic.toggleCompletions',
        ariaLabel: localize('qic.completionBar.ariaLabel', 'QIC Code Completion Status'),
      },
      COMPLETION_BAR_ID,
      StatusbarAlignment.RIGHT,
      60 // Between status and quota
    );

    this._register(this.completionEntry);
  }

  private subscribeToStateChanges(): void {
    this._register(this.stateService.onDidChangeState((patch) => {
      // ... existing handlers ...
      if (patch.path === '*' || patch.path === 'completionStatus') {
        this.updateCompletionBar();
      }
    }));
  }

  private updateCompletionBar(): void {
    if (!this.completionEntry) return;

    const completion = this.stateService.state.completionStatus;

    if (!completion.enabled) {
      // Don't show if completions are disabled by user
      this.completionEntry.update({ text: '', tooltip: '' });
      return;
    }

    const { text, tooltip, color } = this.getCompletionConfig(completion);

    this.completionEntry.update({
      text,
      tooltip,
      color,
      command: 'qic.toggleCompletions',
    });
  }

  private getCompletionConfig(completion: CompletionStatus): StatusBarConfig {
    switch (completion.status) {
      case 'active':
        return {
          text: '$(zap)',
          tooltip: localize('qic.completion.active',
            'Code completions active{0}',
            completion.lastResponseMs ? ` • ${completion.lastResponseMs}ms` : ''
          ),
        };

      case 'degraded':
        return {
          text: '$(zap)',
          tooltip: localize('qic.completion.degraded',
            'Code completions degraded - slower responses'
          ),
          color: new ThemeColor('statusBarItem.warningForeground'),
        };

      case 'disabled':
        const reasons: Record<string, string> = {
          'quota_exceeded': 'Quota exceeded',
          'provider_unavailable': 'Provider unavailable',
          'user_disabled': 'Disabled by user',
          'rate_limited': 'Rate limited',
        };
        return {
          text: '$(circle-slash)',
          tooltip: localize('qic.completion.disabled',
            'Code completions disabled: {0}',
            reasons[completion.disabledReason || ''] || 'Unknown'
          ),
          color: new ThemeColor('statusBarItem.warningForeground'),
        };

      case 'error':
        return {
          text: '$(error)',
          tooltip: localize('qic.completion.error',
            'Code completions error: {0}',
            completion.errorMessage || 'Unknown error'
          ),
          color: new ThemeColor('statusBarItem.errorForeground'),
        };

      default:
        return { text: '', tooltip: '' };
    }
  }
}
```

### Register Toggle Command

```typescript
// In qic.contribution.ts

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'qic.toggleCompletions',
      title: localize('qic.toggleCompletions', 'QIC: Toggle Code Completions'),
      category: 'QIC',
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const stateService = accessor.get(IQicStateService);
    const notificationService = accessor.get(INotificationService);

    const current = stateService.state.completionStatus;

    if (current.status === 'disabled' && current.disabledReason === 'user_disabled') {
      // Re-enable
      await stateService.updateCompletionStatus({
        enabled: true,
        status: 'active',
        disabledReason: undefined
      });
      notificationService.info(localize('qic.completions.enabled', 'Code completions enabled'));
    } else if (current.enabled) {
      // Disable
      await stateService.updateCompletionStatus({
        enabled: true,
        status: 'disabled',
        disabledReason: 'user_disabled'
      });
      notificationService.info(localize('qic.completions.disabled', 'Code completions disabled'));
    } else {
      // Show detailed status
      notificationService.info(
        localize('qic.completions.status',
          'Completions: {0}\nReason: {1}',
          current.status,
          current.disabledReason || current.errorMessage || 'N/A'
        )
      );
    }
  }
});
```

### Verification for Code Completion Status

- [ ] Zap icon shows when completions active
- [ ] Warning color when degraded
- [ ] Circle-slash icon when disabled
- [ ] Error icon when completion service errors
- [ ] Click toggles completions on/off
- [ ] Tooltip shows reason for disabled state
- [ ] Latency shown when completions active
- [ ] Item hidden when user disables completions entirely

---

## Notes

- Status bar is always visible - keep it clean and informative
- Spinner animation uses VS Code's built-in `$(loading~spin)`
- Consider adding "time since last activity" to tooltip
- Quota display should respect user's preference for tokens vs cost
- Context menu provides quick access without opening panel
- **Code completion status provides visibility into inline completion health**
