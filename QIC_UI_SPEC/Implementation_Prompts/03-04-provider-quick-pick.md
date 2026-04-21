# Prompt 03-04: Provider Quick Pick

**Phase:** 3 - Native Integration
**Dependencies:** 03-01 (Quick Pick Infrastructure)
**Estimated Effort:** 1 session
**Critical Path:** No

---

## Objective

Implement the provider selection Quick Pick: display available LLM providers with their status, support switching providers, show current model info, and integrate with the Provider Gateway.

---

## Context

The provider Quick Pick replaces the header provider dropdown with a native VS Code experience:
- Shows available providers (QIC Cloud, Anthropic, OpenAI, Ollama, Offline)
- Indicates current provider with checkmark
- Shows provider status (connected, degraded, unavailable)
- Allows switching between providers
- Shows current model for each provider

The backend supports multiple providers through the Provider Gateway with automatic fallback.

Reference: `QIC_UI_SPEC/Optimal_plan/07-NATIVE-INTEGRATION.md`

---

## Scope

### In Scope
- Create `providerQuickPick.ts`
- Implement provider list with status
- Implement provider switching
- Show current model info
- Wire to menu item
- Handle provider unavailability

### Out of Scope
- Provider configuration (use VS Code settings)
- API key management (use VS Code secrets)
- Model selection within provider (future enhancement)
- Provider health checking (existing in Gateway)

---

## Pre-Conditions

- [ ] 03-01 complete (Quick Pick infrastructure)
- [ ] Provider Gateway exists
- [ ] Git branch created: `qic-ui/03-04-provider-quick-pick`

---

## Tasks

### 1. Create Provider Quick Pick

```bash
touch src/vs/workbench/contrib/qic/browser/quickPicks/providerQuickPick.ts
```

### 2. Implement Provider Quick Pick

```typescript
// src/vs/workbench/contrib/qic/browser/quickPicks/providerQuickPick.ts

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { IQicStateService, ConnectionState } from '../common/state/qicStateService.js';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { localize } from 'vs/nls';
import { ThemeIcon } from 'vs/base/common/themables';
import { Codicon } from 'vs/base/common/codicons';

type ProviderType = ConnectionState['provider'];

interface ProviderInfo {
    id: ProviderType;
    name: string;
    description: string;
    icon: typeof Codicon[keyof typeof Codicon];
    models: string[];
    requiresApiKey: boolean;
    isCloud: boolean;
}

const PROVIDERS: ProviderInfo[] = [
    {
        id: 'qic-cloud',
        name: 'QIC Cloud',
        description: 'Managed service with automatic provider selection',
        icon: Codicon.cloud,
        models: ['Auto (Best available)'],
        requiresApiKey: false,
        isCloud: true,
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        description: 'Claude models via Anthropic API',
        icon: Codicon.sparkle,
        models: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
        requiresApiKey: true,
        isCloud: true,
    },
    {
        id: 'openai',
        name: 'OpenAI',
        description: 'GPT models via OpenAI API',
        icon: Codicon.hubot,
        models: ['gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
        requiresApiKey: true,
        isCloud: true,
    },
    {
        id: 'ollama',
        name: 'Ollama (Local)',
        description: 'Run models locally with Ollama',
        icon: Codicon.server,
        models: ['llama3', 'codellama', 'mistral'],
        requiresApiKey: false,
        isCloud: false,
    },
    {
        id: 'offline',
        name: 'Offline Mode',
        description: 'Limited functionality without LLM',
        icon: Codicon.circleSlash,
        models: ['None'],
        requiresApiKey: false,
        isCloud: false,
    },
];

interface ProviderQuickPickItem extends IQuickPickItem {
    providerId: ProviderType;
    providerInfo: ProviderInfo;
}

interface ProviderStatus {
    available: boolean;
    latencyMs?: number;
    degraded: boolean;
    error?: string;
}

export class ProviderQuickPick {
    constructor(
        @IQuickInputService private readonly quickInputService: IQuickInputService,
        @IQicStateService private readonly stateService: IQicStateService,
        @INotificationService private readonly notificationService: INotificationService,
        private readonly getProviderStatus: (provider: ProviderType) => Promise<ProviderStatus>,
        private readonly switchProvider: (provider: ProviderType) => Promise<void>,
    ) {}

    async show(): Promise<ProviderType | undefined> {
        const currentProvider = this.stateService.state.connection.provider;
        const currentModel = this.stateService.state.connection.currentModel;

        // Get status for all providers (in parallel)
        const statusPromises = PROVIDERS.map(async (p) => ({
            id: p.id,
            status: await this.getProviderStatus(p.id).catch(() => ({
                available: false,
                degraded: false,
                error: 'Failed to check status'
            })),
        }));
        const statuses = await Promise.all(statusPromises);
        const statusMap = new Map(statuses.map(s => [s.id, s.status]));

        return new Promise((resolve) => {
            const picker = this.quickInputService.createQuickPick<ProviderQuickPickItem>();

            picker.title = localize('qic.provider.title', 'Select Provider');
            picker.placeholder = localize('qic.provider.placeholder', 'Choose an LLM provider...');
            picker.items = this.buildQuickPickItems(currentProvider, currentModel, statusMap);
            picker.sortByLabel = false;

            picker.onDidAccept(async () => {
                const selected = picker.selectedItems[0] as ProviderQuickPickItem;
                if (selected?.providerId && selected.providerId !== currentProvider) {
                    const status = statusMap.get(selected.providerId);
                    if (!status?.available) {
                        this.notificationService.warn(
                            localize('qic.provider.unavailable', '{0} is currently unavailable.', selected.providerInfo.name)
                        );
                        resolve(undefined);
                    } else {
                        resolve(selected.providerId);
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

    private buildQuickPickItems(
        currentProvider: ProviderType,
        currentModel: string,
        statusMap: Map<ProviderType, ProviderStatus>
    ): (ProviderQuickPickItem | IQuickPickSeparator)[] {
        const items: (ProviderQuickPickItem | IQuickPickSeparator)[] = [];

        // Cloud providers
        items.push({ type: 'separator', label: localize('qic.provider.cloud', 'Cloud Providers') });

        for (const provider of PROVIDERS.filter(p => p.isCloud)) {
            items.push(this.createProviderItem(provider, currentProvider, currentModel, statusMap));
        }

        // Local providers
        items.push({ type: 'separator', label: localize('qic.provider.local', 'Local / Offline') });

        for (const provider of PROVIDERS.filter(p => !p.isCloud)) {
            items.push(this.createProviderItem(provider, currentProvider, currentModel, statusMap));
        }

        return items;
    }

    private createProviderItem(
        provider: ProviderInfo,
        currentProvider: ProviderType,
        currentModel: string,
        statusMap: Map<ProviderType, ProviderStatus>
    ): ProviderQuickPickItem {
        const isCurrent = provider.id === currentProvider;
        const status = statusMap.get(provider.id);

        let description = provider.description;
        if (isCurrent && currentModel) {
            description = `${currentModel} • ${provider.description}`;
        }

        let detail = '';
        if (status) {
            if (!status.available) {
                detail = `$(error) ${status.error || 'Unavailable'}`;
            } else if (status.degraded) {
                detail = `$(warning) Degraded • ${status.latencyMs}ms`;
            } else if (status.latencyMs) {
                detail = `$(check) Connected • ${status.latencyMs}ms`;
            }
        }

        return {
            providerId: provider.id,
            providerInfo: provider,
            label: `${isCurrent ? '$(check) ' : ''}${provider.name}`,
            description,
            detail,
            iconClass: ThemeIcon.asClassName(provider.icon),
            picked: isCurrent,
        };
    }
}

// Factory function
export async function showProviderQuickPick(
    quickInputService: IQuickInputService,
    stateService: IQicStateService,
    notificationService: INotificationService,
    getProviderStatus: (provider: ProviderType) => Promise<ProviderStatus>,
    switchProvider: (provider: ProviderType) => Promise<void>,
): Promise<ProviderType | undefined> {
    const picker = new ProviderQuickPick(
        quickInputService,
        stateService,
        notificationService,
        getProviderStatus,
        switchProvider
    );
    return picker.show();
}
```

### 3. Wire to Panel

```typescript
// In qicPanel.ts
case 'quickPick:provider':
    this.showProviderQuickPick();
    return;

private async showProviderQuickPick(): Promise<void> {
    const newProvider = await showProviderQuickPick(
        this.quickInputService,
        this.stateService,
        this.notificationService,
        async (provider) => this.gateway.getProviderStatus(provider),
        async (provider) => this.gateway.switchProvider(provider)
    );

    if (newProvider) {
        try {
            await this.gateway.switchProvider(newProvider);
            this.stateService.updateConnection({ provider: newProvider });
            this.notificationService.info(
                localize('qic.provider.switched', 'Switched to {0}', newProvider)
            );
        } catch (error) {
            this.notificationService.error(
                localize('qic.provider.switchError', 'Failed to switch provider: {0}', error.message)
            );
        }
    }
}
```

### 4. Register Command

```typescript
registerAction2(class extends Action2 {
    constructor() {
        super({
            id: 'qic.switchProvider',
            title: localize('qic.switchProvider', 'QIC: Switch Provider'),
            category: 'QIC',
            menu: {
                id: MenuId.CommandPalette,
            },
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        const panelService = accessor.get(IQicPanelService);
        await panelService.showProviderQuickPick();
    }
});
```

---

## Verification

### Success Criteria
- [ ] Quick Pick opens from menu "Switch Provider" item
- [ ] Current provider shown with checkmark
- [ ] Provider status indicators correct
- [ ] Selecting different provider switches
- [ ] Selecting current provider does nothing
- [ ] Unavailable provider shows warning
- [ ] State updates after switch
- [ ] Latency shown for connected providers

### Manual Tests

| Test | Steps | Expected |
|------|-------|----------|
| Open picker | Click menu → Provider | Quick Pick opens |
| Current shown | Check list | Current has checkmark |
| Status shown | Check items | Latency/status visible |
| Switch | Select different | Provider switches |
| Same provider | Select current | No change |
| Unavailable | Select unavailable | Warning shown |

---

## Rollback

```bash
rm src/vs/workbench/contrib/qic/browser/quickPicks/providerQuickPick.ts
```

---

## Amendment: BYOK (Bring Your Own Key) Support

The provider list must include BYOK mode for users who want to use their own API keys directly.

### Add BYOK Provider

Update the PROVIDERS array to include BYOK option:

```typescript
const PROVIDERS: ProviderInfo[] = [
    {
        id: 'qic-cloud',
        name: 'QIC Cloud',
        description: 'Managed service with automatic provider selection',
        icon: Codicon.cloud,
        models: ['Auto (Best available)'],
        requiresApiKey: false,
        isCloud: true,
    },
    // ADD THIS NEW PROVIDER
    {
        id: 'byok',
        name: 'Your API Key (BYOK)',
        description: 'Use your own OpenAI or Anthropic API key',
        icon: Codicon.key,
        models: ['Configured model'],
        requiresApiKey: true,
        isCloud: true,
        configurable: true,  // Flag for special handling
    },
    {
        id: 'anthropic',
        // ... existing
    },
    // ... rest of providers
];
```

### BYOK Configuration Flow

When BYOK is selected but not configured, show configuration prompt:

```typescript
private async handleBYOKSelection(): Promise<boolean> {
    const config = this.configService.getValue<BYOKConfig>('qic.byok');

    if (!config?.apiKey) {
        // Show configuration quick pick
        const result = await this.showBYOKSetup();
        if (!result) {
            return false; // User cancelled
        }
    }

    return true;
}

private async showBYOKSetup(): Promise<boolean> {
    // Step 1: Choose provider type
    const providerType = await this.quickInputService.pick([
        { label: 'OpenAI', id: 'openai' },
        { label: 'Anthropic', id: 'anthropic' },
    ], { placeHolder: 'Select API provider' });

    if (!providerType) return false;

    // Step 2: Enter API key
    const apiKey = await this.quickInputService.input({
        prompt: `Enter your ${providerType.label} API key`,
        password: true,
        validateInput: (value) => {
            if (!value || value.length < 20) {
                return 'Please enter a valid API key';
            }
            return undefined;
        }
    });

    if (!apiKey) return false;

    // Store in VS Code secrets
    await this.secretStorageService.store(
        `qic.byok.${providerType.id}.apiKey`,
        apiKey
    );

    // Update configuration
    await this.configService.updateValue('qic.byok', {
        provider: providerType.id,
        configured: true,
    });

    this.notificationService.info('BYOK configured successfully');
    return true;
}
```

### Update Quick Pick Item for BYOK

```typescript
private createProviderItem(provider: ProviderInfo, ...): ProviderQuickPickItem {
    // ... existing code ...

    // Special handling for BYOK
    if (provider.id === 'byok') {
        const byokConfig = this.configService.getValue<BYOKConfig>('qic.byok');
        if (byokConfig?.configured) {
            description = `Using ${byokConfig.provider} API • Your key`;
            // Add "Configure" button
            item.buttons = [{
                iconClass: 'codicon-gear',
                tooltip: 'Configure BYOK',
            }];
        } else {
            description = 'Click to configure your API key';
            detail = 'Not configured';
        }
    }

    return item;
}
```

### BYOK Status Check

```typescript
private async getBYOKStatus(): Promise<ProviderStatus> {
    const config = this.configService.getValue<BYOKConfig>('qic.byok');

    if (!config?.configured) {
        return {
            available: true,  // Available but needs setup
            degraded: false,
            needsSetup: true,
        };
    }

    // Test the configured API key
    try {
        const response = await this.testBYOKConnection(config);
        return {
            available: true,
            degraded: false,
            latencyMs: response.latency,
        };
    } catch (error) {
        return {
            available: false,
            degraded: false,
            error: 'API key validation failed',
        };
    }
}
```

This enables users to use their own API keys while keeping the managed QIC Cloud option as the recommended default.

---

## Notes

- Provider status checking should be cached/debounced
- BYOK requires secure storage of API keys via VS Code secrets
- Model selection per provider could be added later
- Offline mode should clearly explain limitations
- **BYOK configuration persists across sessions**
