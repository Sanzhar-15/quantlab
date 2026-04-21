/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IQicStateService, QuotaState } from '../../common/state/qicStateService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/**
 * Extended quota state for UI with breakdown
 */
export interface ExtendedQuotaState extends QuotaState {
	costUsed?: number;
	costLimit?: number;
	breakdown?: {
		chat?: number;
		completion?: number;
		embeddings?: number;
	};
}

/**
 * Quick Pick item with optional action
 */
interface QuotaQuickPickItem extends IQuickPickItem {
	action?: string;
}

/**
 * Quota Quick Pick - shows token usage, costs, and quota management
 * Phase 3 - Prompt 03-08
 */
export class QuotaQuickPick extends Disposable {
	constructor(
		private readonly quickInputService: IQuickInputService,
		private readonly stateService: IQicStateService,
		private readonly commandService: ICommandService,
		private readonly openerService: IOpenerService,
	) {
		super();
	}

	async show(): Promise<void> {
		const state = this.stateService.state;
		const quota = state.quota as ExtendedQuotaState | undefined;

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
			const remaining = Math.max(0, quota.costLimit - quota.costUsed);
			items.push({
				label: `$(credit-card) $${quota.costUsed.toFixed(2)} used · $${remaining.toFixed(2)} remaining`,
			});
		}

		// Reset date
		if (quota.resetDate) {
			const resetIn = this.formatResetTime(quota.resetDate);
			items.push({
				label: `$(calendar) Resets ${resetIn}`,
			});
		}

		items.push({ type: 'separator', label: localize('qic.quota.breakdown', 'Breakdown') });

		// Usage breakdown by type
		if (quota.breakdown) {
			if (quota.breakdown.chat !== undefined) {
				items.push({
					label: `$(comment-discussion) Chat: ${this.formatTokens(quota.breakdown.chat)}`,
				});
			}
			if (quota.breakdown.completion !== undefined) {
				items.push({
					label: `$(code) Completions: ${this.formatTokens(quota.breakdown.completion)}`,
				});
			}
			if (quota.breakdown.embeddings !== undefined) {
				items.push({
					label: `$(search) Embeddings: ${this.formatTokens(quota.breakdown.embeddings)}`,
				});
			}
		} else {
			items.push({
				label: `$(info) No detailed breakdown available`,
			});
		}

		items.push({ type: 'separator', label: localize('qic.quota.actions', 'Actions') });

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
			description: localize('qic.quota.localInference', 'Local inference'),
		});

		// Show Quick Pick
		const quickPick = this.quickInputService.createQuickPick<QuotaQuickPickItem>();
		quickPick.items = items as any;
		quickPick.placeholder = localize('qic.quota.placeholder', 'Orion Token Usage');
		quickPick.canSelectMany = false;

		quickPick.onDidAccept(() => {
			const selected = quickPick.selectedItems[0];
			if (selected?.action) {
				this.executeAction(selected.action);
			}
			quickPick.hide();
		});

		quickPick.onDidHide(() => {
			quickPick.dispose();
		});

		quickPick.show();
	}

	private showNoQuotaMessage(): void {
		this.quickInputService.pick([
			{
				label: `$(info) ${localize('qic.quota.notAvailable', 'Quota information not available')}`,
				description: localize('qic.quota.localProvider', 'Using local or unlimited provider'),
			}
		], {
			placeHolder: localize('qic.quota.placeholder', 'Orion Token Usage'),
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
		const total = 20; // 20 segments
		const filled = Math.min(Math.round(percentage / 5), total);
		const empty = total - filled;

		let bar = '';
		for (let i = 0; i < filled; i++) bar += '\u2588'; // Full block
		for (let i = 0; i < empty; i++) bar += '\u2591'; // Light shade

		return bar;
	}

	private formatResetTime(resetDate: string | number): string {
		const now = Date.now();
		const resetMs = typeof resetDate === 'string' ? new Date(resetDate).getTime() : resetDate;
		const diff = resetMs - now;

		if (diff <= 0) {
			return localize('qic.quota.resetSoon', 'soon');
		}

		const days = Math.floor(diff / (1000 * 60 * 60 * 24));
		const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

		if (days > 0) {
			return localize('qic.quota.resetInDays', 'in {0} day(s)', days);
		}
		if (hours > 0) {
			return localize('qic.quota.resetInHours', 'in {0} hour(s)', hours);
		}
		return localize('qic.quota.resetLessThanHour', 'in less than an hour');
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

/**
 * Factory function for showing quota Quick Pick
 */
export function showQuotaQuickPick(
	quickInputService: IQuickInputService,
	stateService: IQicStateService,
	commandService: ICommandService,
	openerService: IOpenerService,
): Promise<void> {
	const picker = new QuotaQuickPick(
		quickInputService,
		stateService,
		commandService,
		openerService
	);
	return picker.show();
}
