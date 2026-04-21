/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { HistoryEntry } from '../../types/history';
import { HistoryState } from '../../core/state/HistoryState';

type HistoryNode = SectionNode | EntryNode | StrategyNode | PlaceholderNode;

const SECTION_IDS = {
	search: 'quantlab.history.section.search',
	pinned: 'quantlab.history.section.pinned',
	recent: 'quantlab.history.section.recent',
	byStrategy: 'quantlab.history.section.byStrategy',
	compare: 'quantlab.history.section.compare'
};

interface SectionNode {
	id: string;
	label: string;
	type: 'section';
}

interface EntryNode {
	id: string;
	label: string;
	type: 'entry';
	entry: HistoryEntry;
}

interface StrategyNode {
	id: string;
	label: string;
	type: 'strategy';
	strategyPath: string;
}

interface PlaceholderNode {
	id: string;
	label: string;
	type: 'placeholder';
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<HistoryNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly historyState: HistoryState) {
		this.historyState.onDidChange(() => this.refresh());
	}

	getTreeItem(element: HistoryNode): vscode.TreeItem {
		if (element.type === 'entry') {
			const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
			item.id = element.id;
			item.description = element.entry.status;
			item.contextValue = 'quantlab.history.entry';
			item.command = {
				command: 'quantlab.openHistoryEntry',
				title: 'Open History Entry',
				arguments: [element.entry.id]
			};
			item.accessibilityInformation = {
				label: this.buildAccessibilityLabel(element.entry)
			};
			return item;
		}

		const collapsible = element.type === 'section' && element.id === SECTION_IDS.search
			? vscode.TreeItemCollapsibleState.None
			: vscode.TreeItemCollapsibleState.Collapsed;

		const item = new vscode.TreeItem(element.label, collapsible);
		item.id = element.id;
		if (element.type === 'section' && element.id === SECTION_IDS.search) {
			item.command = { command: 'quantlab.searchHistory', title: 'Search History' };
		}
		if (element.type === 'section' && element.id === SECTION_IDS.compare) {
			const count = this.historyState.getCompareCount();
			item.description = count ? `${count} selected` : 'No runs';
		}
		if (element.type === 'strategy') {
			item.contextValue = 'quantlab.history.strategy';
		}
		if (element.type === 'placeholder') {
			item.contextValue = 'quantlab.history.placeholder';
		}
		return item;
	}

	getChildren(element?: HistoryNode): HistoryNode[] {
		if (!element) {
			return [
				{ id: SECTION_IDS.search, label: 'Search', type: 'section' },
				{ id: SECTION_IDS.pinned, label: 'Pinned', type: 'section' },
				{ id: SECTION_IDS.recent, label: 'Recent', type: 'section' },
				{ id: SECTION_IDS.byStrategy, label: 'By Strategy', type: 'section' },
				{ id: SECTION_IDS.compare, label: 'Compare', type: 'section' }
			];
		}

		if (element.type === 'section' && element.id === SECTION_IDS.pinned) {
			const pinned = this.historyState.query({ pinned: true });
			if (!pinned.length) {
				return [this.createPlaceholder('quantlab.history.pinned.empty', 'No pinned runs')];
			}
			return pinned.map(entry => this.createEntryNode(entry));
		}

		if (element.type === 'section' && element.id === SECTION_IDS.recent) {
			const recent = this.historyState.getRecent(25);
			if (!recent.length) {
				return [this.createPlaceholder('quantlab.history.recent.empty', 'No recent runs')];
			}
			return recent.map(entry => this.createEntryNode(entry));
		}

		if (element.type === 'section' && element.id === SECTION_IDS.byStrategy) {
			const all = this.historyState.getRecent(200);
			if (!all.length) {
				return [this.createPlaceholder('quantlab.history.byStrategy.empty', 'No history yet')];
			}

			const grouped = new Map<string, HistoryEntry[]>();
			for (const entry of all) {
				const list = grouped.get(entry.strategyPath) ?? [];
				list.push(entry);
				grouped.set(entry.strategyPath, list);
			}

			return Array.from(grouped.keys()).map(strategyPath => ({
				id: `quantlab.history.strategy.${strategyPath}`,
				label: path.basename(strategyPath),
				type: 'strategy',
				strategyPath
			}));
		}

		if (element.type === 'strategy') {
			const entries = this.historyState.getByStrategy(element.strategyPath);
			if (!entries.length) {
				return [this.createPlaceholder(`quantlab.history.strategy.${element.strategyPath}.empty`, 'No runs')];
			}
			return entries.map(entry => this.createEntryNode(entry));
		}

		if (element.type === 'section' && element.id === SECTION_IDS.compare) {
			const compare = this.historyState.getCompareEntries();
			if (!compare.length) {
				return [this.createPlaceholder('quantlab.history.compare.empty', 'No runs selected')];
			}
			return compare.map(entry => this.createEntryNode(entry));
		}

		return [];
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private createEntryNode(entry: HistoryEntry): EntryNode {
		const label = `${this.formatRunType(entry.type)} — ${path.basename(entry.strategyPath)}`;
		return {
			id: `quantlab.history.entry.${entry.id}`,
			label,
			type: 'entry',
			entry
		};
	}

	private createPlaceholder(id: string, label: string): PlaceholderNode {
		return {
			id,
			label,
			type: 'placeholder'
		};
	}

	private buildAccessibilityLabel(entry: HistoryEntry): string {
		const strategyName = path.basename(entry.strategyPath);
		const metric = this.pickMetric(entry.metrics);
		const metricPart = metric ? `, ${metric.label} ${metric.value.toFixed(2)}` : '';
		return `${this.formatRunType(entry.type)} run ${entry.id}, ${entry.status}, strategy ${strategyName}${metricPart}`;
	}

	private pickMetric(metrics?: Record<string, number>): { label: string; value: number } | undefined {
		if (!metrics) {
			return undefined;
		}
		const entries = Object.entries(metrics);
		if (!entries.length) {
			return undefined;
		}

		const preferredKeys = ['Return', 'Sharpe', 'PnL', 'WinRate'];
		for (const key of preferredKeys) {
			const match = entries.find(([label]) => label.toLowerCase() === key.toLowerCase());
			if (match) {
				return { label: match[0], value: match[1] };
			}
		}

		const [label, value] = entries[0];
		return { label, value };
	}

	private formatRunType(type: string): string {
		if (type === 'monteCarlo') {
			return 'Monte Carlo';
		}
		if (type === 'wfa') {
			return 'Walk-forward';
		}
		return type.charAt(0).toUpperCase() + type.slice(1);
	}
}
