/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { HistoryEntry, RunType } from '../../types/history';
import { HistoryState } from '../../core/state/HistoryState';

const FILTER_KEY = 'quantlab.historyFilter';
const FILTER_OPTIONS: Array<{ id: HistoryFilter; label: string }> = [
	{ id: 'all', label: 'All' },
	{ id: 'backtest', label: 'Backtest' },
	{ id: 'wfa', label: 'WFA' },
	{ id: 'paper', label: 'Paper' },
	{ id: 'live', label: 'Live' },
	{ id: 'optimize', label: 'Optimize' },
	{ id: 'monteCarlo', label: 'Monte Carlo' }
];

type HistoryFilter = 'all' | RunType;

interface HistoryQuickPickItem extends vscode.QuickPickItem {
	readonly itemType: 'filter' | 'entry' | 'openPanel' | 'separator';
	readonly entryId?: string;
	readonly filterId?: HistoryFilter;
}

export class HistoryDropdown {
	private static instance: HistoryDropdown | undefined;
	private quickPick: vscode.QuickPick<HistoryQuickPickItem> | undefined;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly historyState: HistoryState
	) { }

	static initialize(context: vscode.ExtensionContext, historyState: HistoryState): HistoryDropdown {
		if (!HistoryDropdown.instance) {
			HistoryDropdown.instance = new HistoryDropdown(context, historyState);
		}
		return HistoryDropdown.instance;
	}

	static getInstance(): HistoryDropdown {
		if (!HistoryDropdown.instance) {
			throw new Error('HistoryDropdown not initialized');
		}
		return HistoryDropdown.instance;
	}

	toggle(): void {
		if (this.quickPick) {
			this.quickPick.hide();
			return;
		}

		void this.show();
	}

	private async show(): Promise<void> {
		const quickPick = vscode.window.createQuickPick<HistoryQuickPickItem>();
		this.quickPick = quickPick;
		quickPick.title = 'History';
		quickPick.matchOnDescription = true;
		quickPick.items = await this.buildItems();

		quickPick.onDidAccept(async () => {
			const selected = quickPick.selectedItems[0];
			if (!selected) {
				return;
			}

			if (selected.itemType === 'filter') {
				await this.selectFilter();
				quickPick.items = await this.buildItems();
				return;
			}

			if (selected.itemType === 'openPanel') {
				void vscode.commands.executeCommand('quantlab.focusHistoryPanel');
				quickPick.hide();
				return;
			}

			if (selected.itemType === 'entry' && selected.entryId) {
				void vscode.commands.executeCommand('quantlab.action.openRun', selected.entryId);
				this.historyState.markAsViewed(selected.entryId);
				quickPick.hide();
			}
		});

		quickPick.onDidTriggerItemButton(e => {
			if (e.item.itemType !== 'entry' || !e.item.entryId) {
				return;
			}

			if (e.button.tooltip === 'Cancel') {
				void vscode.commands.executeCommand('quantlab.cancelHistoryRun', e.item.entryId);
			}

			if (e.button.tooltip === 'Prioritize') {
				void vscode.commands.executeCommand('quantlab.prioritizeHistoryRun', e.item.entryId);
			}
		});

		quickPick.onDidHide(() => {
			quickPick.dispose();
			this.quickPick = undefined;
		});

		quickPick.show();
	}

	private async buildItems(): Promise<HistoryQuickPickItem[]> {
		const filter = this.getFilter();
		const items: HistoryQuickPickItem[] = [];

		items.push({
			label: `Filter: ${this.getFilterLabel(filter)} (change)`,
			itemType: 'filter',
			filterId: filter
		});

		const running = this.filterEntries(this.historyState.getRunningJobs(), filter);
		if (running.length) {
			items.push({ label: 'RUNNING', itemType: 'separator', kind: vscode.QuickPickItemKind.Separator });
			for (const entry of running) {
				items.push(this.createEntryItem(entry, true));
			}
		}

		const recent = this.filterEntries(this.historyState.getRecent(50), filter)
			.filter(entry => entry.status !== 'running' && entry.status !== 'queued');

		const grouped = this.groupByDay(recent);
		for (const [label, entries] of grouped) {
			if (!entries.length) {
				continue;
			}
			items.push({ label, itemType: 'separator', kind: vscode.QuickPickItemKind.Separator });
			for (const entry of entries) {
				items.push(this.createEntryItem(entry, false));
			}
		}

		items.push({ label: '', itemType: 'separator', kind: vscode.QuickPickItemKind.Separator });
		items.push({ label: 'Open History Panel', itemType: 'openPanel' });

		return items;
	}

	private createEntryItem(entry: HistoryEntry, isRunning: boolean): HistoryQuickPickItem {
		const label = `${this.formatRunType(entry.type)} — ${path.basename(entry.strategyPath)}`;
		const description = entry.status;
		const detail = entry.progressMessage ?? (entry.progress !== undefined ? `Progress ${entry.progress}%` : undefined);
		const buttons = isRunning
			? [
				{ iconPath: new vscode.ThemeIcon('close'), tooltip: 'Cancel' },
				{ iconPath: new vscode.ThemeIcon('chevron-up'), tooltip: 'Prioritize' }
			]
			: undefined;

		return {
			label,
			description,
			detail,
			itemType: 'entry',
			entryId: entry.id,
			buttons
		};
	}

	private getFilter(): HistoryFilter {
		const stored = this.context.workspaceState.get<string>(FILTER_KEY, 'all');
		if (stored === 'all') {
			return 'all';
		}
		const match = FILTER_OPTIONS.find(option => option.id === stored);
		return match ? match.id : 'all';
	}

	private async selectFilter(): Promise<void> {
		const pick = await vscode.window.showQuickPick(
			FILTER_OPTIONS.map(option => ({ label: option.label, value: option.id })),
			{ placeHolder: 'Filter history by type' }
		);

		if (!pick) {
			return;
		}

		await this.context.workspaceState.update(FILTER_KEY, pick.value);
	}

	private getFilterLabel(filter: HistoryFilter): string {
		return FILTER_OPTIONS.find(option => option.id === filter)?.label ?? 'All';
	}

	private filterEntries(entries: HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
		if (filter === 'all') {
			return entries;
		}
		return entries.filter(entry => entry.type === filter);
	}

	private groupByDay(entries: HistoryEntry[]): Array<[string, HistoryEntry[]]> {
		const today: HistoryEntry[] = [];
		const yesterday: HistoryEntry[] = [];
		const earlier: HistoryEntry[] = [];

		const now = new Date();
		const todayKey = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const yesterdayKey = todayKey - 24 * 60 * 60 * 1000;

		for (const entry of entries) {
			const entryKey = new Date(entry.startedAt.getFullYear(), entry.startedAt.getMonth(), entry.startedAt.getDate()).getTime();
			if (entryKey === todayKey) {
				today.push(entry);
			} else if (entryKey === yesterdayKey) {
				yesterday.push(entry);
			} else {
				earlier.push(entry);
			}
		}

		return [
			['TODAY', today],
			['YESTERDAY', yesterday],
			['EARLIER', earlier]
		];
	}

	private formatRunType(type: string): string {
		return type.charAt(0).toUpperCase() + type.slice(1);
	}
}
