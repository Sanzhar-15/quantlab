/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { GlobalState } from '../core/state/GlobalState';
import { HistoryState } from '../core/state/HistoryState';
import { DataSourceDescriptor, isLocalFileSource } from '../types/market';

export class GlobalSelectors {
	private static instance: GlobalSelectors | undefined;

	private readonly historyItem: vscode.StatusBarItem;
	private titlebarAvailable = true;
	private lastTitlebarState = { historyCount: -1 };

	private constructor(
		context: vscode.ExtensionContext,
		private readonly globalState: GlobalState,
		private readonly historyState: HistoryState
	) {
		this.historyItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
		this.historyItem.command = 'quantlab.toggleHistoryDropdown';

		context.subscriptions.push(this.historyItem);

		context.subscriptions.push(
			this.globalState.onDidChange(() => this.updateUI()),
			this.historyState.onDidChange(() => this.updateUI())
		);

		this.updateUI();
	}

	static initialize(context: vscode.ExtensionContext, globalState: GlobalState, historyState: HistoryState): GlobalSelectors {
		if (!GlobalSelectors.instance) {
			GlobalSelectors.instance = new GlobalSelectors(context, globalState, historyState);
		}
		return GlobalSelectors.instance;
	}

	static getInstance(): GlobalSelectors {
		if (!GlobalSelectors.instance) {
			throw new Error('GlobalSelectors not initialized');
		}
		return GlobalSelectors.instance;
	}

	async selectDataSource(): Promise<void> {
		const recents = this.globalState.getRecentDataSources();
		const items: vscode.QuickPickItem[] = recents.map(source => {
			if (isLocalFileSource(source)) {
				return {
					label: source.displayName,
					description: source.filePath,
					detail: 'Local File'
				};
			}
			// Must be ServerDataSource since DataSourceDescriptor is a union of only these two types
			return {
				label: source.displayName,
				description: source.symbol,
				detail: 'Server Symbol'
			};
		});
		items.push({ label: 'Browse Local Files...' });

		const pick = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a data source'
		});

		if (!pick) {
			return;
		}

		if (pick.label === 'Browse Local Files...') {
			const uris = await vscode.window.showOpenDialog({
				canSelectMany: false,
				filters: { 'Data Files': ['csv', 'parquet'] },
				openLabel: 'Select Data File'
			});
			if (!uris || !uris.length) {
				return;
			}
			const filePath = uris[0].fsPath;
			const displayName = path.basename(filePath);
			const source: DataSourceDescriptor = { kind: 'localFile', filePath, displayName };
			this.globalState.setDataSource(source);
			return;
		}

		// Match by display name and the unique identifier (filePath for local, symbol for server)
		const matched = recents.find(s => {
			if (s.displayName !== pick.label) {
				return false;
			}
			if (isLocalFileSource(s)) {
				return s.filePath === pick.description;
			}
			// Must be ServerDataSource
			return s.symbol === pick.description;
		});
		if (matched) {
			this.globalState.setDataSource(matched);
		}
	}

	private async updateTitlebar(historyCount: number): Promise<void> {
		if (!this.titlebarAvailable) {
			return;
		}

		if (historyCount === this.lastTitlebarState.historyCount) {
			return;
		}

		try {
			await vscode.commands.executeCommand('quantlab.updateTitlebarState', { historyCount });
			this.lastTitlebarState = { historyCount };
		} catch {
			this.titlebarAvailable = false;
			this.showFallbackStatusBar(true);
		}
	}

	private updateUI(): void {
		const historyCount = this.historyState.getUnviewedCount();

		void this.updateTitlebar(historyCount);

		if (!this.titlebarAvailable) {
			this.historyItem.text = historyCount > 0 ? `History (${historyCount})` : 'History';
			this.historyItem.tooltip = 'History';
			this.showFallbackStatusBar(true);
		} else {
			this.showFallbackStatusBar(false);
		}
	}

	private showFallbackStatusBar(show: boolean): void {
		if (show) {
			this.historyItem.show();
		} else {
			this.historyItem.hide();
		}
	}
}
