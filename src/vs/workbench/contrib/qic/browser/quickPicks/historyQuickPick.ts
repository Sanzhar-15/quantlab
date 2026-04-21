/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator, IQuickInputButton } from '../../../../../platform/quickinput/common/quickInput.js';
import { IQicStateService } from '../../common/state/qicStateService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/**
 * Conversation summary for Quick Pick display
 */
export interface ConversationSummary {
	id: string;
	title: string;
	timestamp: string;
	messageCount: number;
	preview?: string;
}

/**
 * Quick Pick item for conversations
 */
interface ConversationQuickPickItem extends IQuickPickItem {
	conversationId: string;
	timestamp: Date;
	messageCount: number;
}

/**
 * History Quick Pick - shows conversation history with search, delete, and export
 * Phase 3 - Prompt 03-02
 */
export class HistoryQuickPick extends Disposable {
	constructor(
		private readonly quickInputService: IQuickInputService,
		private readonly stateService: IQicStateService,
		private readonly dialogService: IDialogService,
		private readonly notificationService: INotificationService,
	) {
		super();
	}

	async show(): Promise<string | undefined> {
		const conversations = await this.loadConversations();

		if (conversations.length === 0) {
			this.notificationService.info(localize('qic.history.empty', 'No conversation history yet.'));
			return undefined;
		}

		const items = this.buildQuickPickItems(conversations);

		return new Promise<string | undefined>((resolve) => {
			const picker = this.quickInputService.createQuickPick<ConversationQuickPickItem>();

			picker.title = localize('qic.history.title', 'Conversation History');
			picker.placeholder = localize('qic.history.placeholder', 'Search conversations...');
			picker.matchOnDescription = true;
			picker.matchOnDetail = true;
			picker.items = items as any;
			picker.sortByLabel = false; // Preserve our date-based ordering

			// Action buttons on each item
			picker.onDidTriggerItemButton(async (e) => {
				const item = e.item as ConversationQuickPickItem;
				const buttonIndex = this.getButtonIndex(item, e.button);

				if (buttonIndex === 0) {
					// Delete button
					await this.confirmDelete(item);
					// Refresh list
					const refreshed = await this.loadConversations();
					picker.items = this.buildQuickPickItems(refreshed) as any;
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

	private getButtonIndex(item: ConversationQuickPickItem, button: IQuickInputButton): number {
		const buttons = item.buttons;
		if (!buttons) {
			return -1;
		}
		for (let i = 0; i < buttons.length; i++) {
			if (buttons[i] === button) {
				return i;
			}
		}
		return -1;
	}

	private async loadConversations(): Promise<ConversationSummary[]> {
		// Get from state service or database
		try {
			const summaries = await this.stateService.getConversationSummaries?.();
			return summaries ?? [];
		} catch {
			return [];
		}
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
		const detailParts: string[] = [];
		detailParts.push(`${conv.messageCount} message${conv.messageCount !== 1 ? 's' : ''}`);
		if (conv.preview) {
			detailParts.push(conv.preview.substring(0, 60) + (conv.preview.length > 60 ? '...' : ''));
		}

		return {
			conversationId: conv.id,
			label: conv.title || localize('qic.history.untitled', 'Untitled Conversation'),
			description: this.formatRelativeTime(new Date(conv.timestamp)),
			detail: detailParts.join(' • '),
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
			return localize('qic.time.minsAgo', '{0}m ago', diffMins);
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
			try {
				await this.stateService.deleteConversation?.(item.conversationId);
				this.notificationService.info(localize('qic.history.deleted', 'Conversation deleted.'));
			} catch {
				this.notificationService.error(localize('qic.history.deleteError', 'Failed to delete conversation.'));
			}
		}
	}

	private async exportConversation(conversationId: string): Promise<void> {
		try {
			const data = await this.stateService.exportConversation?.(conversationId);
			if (data) {
				// Copy to clipboard as JSON
				await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
				this.notificationService.info(localize('qic.history.exported', 'Conversation copied to clipboard as JSON.'));
			}
		} catch {
			this.notificationService.error(localize('qic.history.exportError', 'Failed to export conversation.'));
		}
	}
}

/**
 * Factory function for showing history Quick Pick
 */
export function showHistoryQuickPick(
	quickInputService: IQuickInputService,
	stateService: IQicStateService,
	dialogService: IDialogService,
	notificationService: INotificationService,
): Promise<string | undefined> {
	const picker = new HistoryQuickPick(quickInputService, stateService, dialogService, notificationService);
	return picker.show();
}
