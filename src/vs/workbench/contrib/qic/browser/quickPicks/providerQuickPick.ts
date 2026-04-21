/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IQicStateService } from '../../common/state/qicStateService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/**
 * Provider types
 */
export type ProviderType = 'qic-cloud' | 'byok' | 'anthropic' | 'openai' | 'ollama' | 'offline';

/**
 * Provider information for display
 */
interface ProviderInfo {
	id: ProviderType;
	name: string;
	description: string;
	icon: typeof Codicon[keyof typeof Codicon];
	models: string[];
	requiresApiKey: boolean;
	isCloud: boolean;
}

/**
 * Provider status information
 */
export interface ProviderStatus {
	available: boolean;
	latencyMs?: number;
	degraded: boolean;
	error?: string;
	needsSetup?: boolean;
}

/**
 * Available providers list
 */
const PROVIDERS: ProviderInfo[] = [
	{
		id: 'qic-cloud',
		name: 'Orion Cloud',
		description: 'Managed service with automatic provider selection',
		icon: Codicon.cloud,
		models: ['Auto (Best available)'],
		requiresApiKey: false,
		isCloud: true,
	},
	{
		id: 'byok',
		name: 'Your API Key (BYOK)',
		description: 'Use your own OpenAI or Anthropic API key',
		icon: Codicon.key,
		models: ['Configured model'],
		requiresApiKey: true,
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

/**
 * Quick Pick item for providers
 */
interface ProviderQuickPickItem extends IQuickPickItem {
	providerId: ProviderType;
	providerInfo: ProviderInfo;
}

/**
 * Provider selection Quick Pick - shows available LLM providers with status
 * Phase 3 - Prompt 03-04
 */
export class ProviderQuickPick extends Disposable {
	constructor(
		private readonly quickInputService: IQuickInputService,
		private readonly stateService: IQicStateService,
		private readonly notificationService: INotificationService,
		private readonly getProviderStatus: (provider: ProviderType) => Promise<ProviderStatus>,
	) {
		super();
	}

	async show(): Promise<ProviderType | undefined> {
		const currentProvider = this.stateService.state.connection?.provider ?? 'qic-cloud';
		const currentModel = this.stateService.state.connection?.currentModel ?? '';

		// Get status for all providers (in parallel)
		const statusPromises = PROVIDERS.map(async (p) => ({
			id: p.id,
			status: await this.getProviderStatus(p.id).catch(() => ({
				available: false,
				degraded: false,
				error: 'Failed to check status',
				needsSetup: false
			})),
		}));
		const statuses = await Promise.all(statusPromises);
		const statusMap = new Map(statuses.map(s => [s.id, s.status]));

		return new Promise((resolve) => {
			const picker = this.quickInputService.createQuickPick<ProviderQuickPickItem>();

			picker.title = localize('qic.provider.title', 'Select Provider');
			picker.placeholder = localize('qic.provider.placeholder', 'Choose an LLM provider...');
			picker.items = this.buildQuickPickItems(currentProvider, currentModel, statusMap) as any;
			picker.sortByLabel = false;

			picker.onDidAccept(async () => {
				const selected = picker.selectedItems[0] as ProviderQuickPickItem;
				if (selected?.providerId && selected.providerId !== currentProvider) {
					const status = statusMap.get(selected.providerId);
					if (!status?.available && !status?.needsSetup) {
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
			description = `${currentModel} - ${provider.description}`;
		}

		let detail = '';
		if (status) {
			if (status.needsSetup) {
				detail = '$(gear) Click to configure';
			} else if (!status.available) {
				detail = `$(error) ${status.error || 'Unavailable'}`;
			} else if (status.degraded) {
				detail = `$(warning) Degraded${status.latencyMs ? ` - ${status.latencyMs}ms` : ''}`;
			} else if (status.latencyMs) {
				detail = `$(check) Connected - ${status.latencyMs}ms`;
			} else {
				detail = '$(check) Available';
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

/**
 * Factory function for showing provider Quick Pick
 */
export function showProviderQuickPick(
	quickInputService: IQuickInputService,
	stateService: IQicStateService,
	notificationService: INotificationService,
	getProviderStatus: (provider: ProviderType) => Promise<ProviderStatus>,
): Promise<ProviderType | undefined> {
	const picker = new ProviderQuickPick(
		quickInputService,
		stateService,
		notificationService,
		getProviderStatus
	);
	return picker.show();
}
