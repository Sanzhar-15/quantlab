/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChartState, TabViewState, TradeState, ViewType } from '../../types/views';

export class TabViewStateManager {
	private static instance: TabViewStateManager | undefined;

	private readonly states = new Map<string, TabViewState>();
	private readonly tabStates = new WeakMap<vscode.Tab, TabViewState>();
	private workbenchState = new Map<string, ViewType>();
	private workbenchFailureCount = 0;
	private workbenchDisabledUntil = 0;

	private readonly _onDidChangeView = new vscode.EventEmitter<{
		tabInstanceId: string;
		uri: vscode.Uri;
		view: ViewType;
	}>();

	readonly onDidChangeView = this._onDidChangeView.event;

	private constructor() { }

	static initialize(): TabViewStateManager {
		if (!TabViewStateManager.instance) {
			TabViewStateManager.instance = new TabViewStateManager();
		}
		return TabViewStateManager.instance;
	}

	static getInstance(): TabViewStateManager {
		if (!TabViewStateManager.instance) {
			throw new Error('TabViewStateManager not initialized');
		}
		return TabViewStateManager.instance;
	}

	dispose(): void {
		this._onDidChangeView.dispose();
		this.states.clear();
	}

	static resetInstance(): void {
		if (TabViewStateManager.instance) {
			TabViewStateManager.instance.dispose();
			TabViewStateManager.instance = undefined;
		}
	}

	async hydrateFromWorkbench(): Promise<void> {
		const saved = await this.runWorkbenchCommand<Record<string, { view: ViewType }>>('quantlab.getTabViewState');
		if (!saved) {
			return;
		}

		this.workbenchState = new Map(Object.entries(saved).map(([tabInstanceId, state]) => [tabInstanceId, state.view]));
	}

	async syncTabs(): Promise<void> {
		const tabGroups = vscode.window.tabGroups.all;
		const currentTabIds = new Set<string>();

		for (const group of tabGroups) {
			const groupIndex = tabGroups.indexOf(group);
			for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
				const tab = group.tabs[tabIndex];
				const resource = this.getTabResource(tab);
				if (!resource) {
					continue;
				}

				const tabInstanceId = this.buildTabInstanceId(resource, groupIndex, tabIndex);
				currentTabIds.add(tabInstanceId);

				const existing = this.tabStates.get(tab) ?? this.states.get(tabInstanceId);
				if (existing) {
					if (existing.tabInstanceId !== tabInstanceId) {
						this.states.delete(existing.tabInstanceId);
						existing.tabInstanceId = tabInstanceId;
						existing.filePath = resource.toString();
						this.states.set(tabInstanceId, existing);
						this.tabStates.set(tab, existing);
						this.workbenchState.set(tabInstanceId, existing.currentView);
						void this.runWorkbenchCommand('quantlab.setTabViewState', {
							tabInstanceId,
							view: existing.currentView,
							resource
						});
					} else {
						existing.filePath = resource.toString();
						this.states.set(tabInstanceId, existing);
						this.tabStates.set(tab, existing);
					}
					continue;
				}

				const savedView = this.workbenchState.get(tabInstanceId);
				const view = savedView ?? 'editor';
				const state: TabViewState = {
					tabInstanceId,
					filePath: resource.toString(),
					currentView: view
				};

				this.states.set(tabInstanceId, state);
				this.tabStates.set(tab, state);

				if (!savedView) {
					this.workbenchState.set(tabInstanceId, view);
					void this.runWorkbenchCommand('quantlab.setTabViewState', {
						tabInstanceId,
						view,
						resource
					});
				}
			}
		}

		for (const tabInstanceId of Array.from(this.states.keys())) {
			if (currentTabIds.has(tabInstanceId)) {
				continue;
			}

			this.states.delete(tabInstanceId);
			this.workbenchState.delete(tabInstanceId);
			void this.runWorkbenchCommand('quantlab.clearTabViewState', tabInstanceId);
		}
	}

	getState(tabInstanceId: string): TabViewState | undefined {
		return this.states.get(tabInstanceId);
	}

	getCurrentView(tabInstanceId: string): ViewType {
		return this.states.get(tabInstanceId)?.currentView ?? 'editor';
	}

	getCurrentViewForEditor(editor: vscode.TextEditor): ViewType {
		const tabInstanceId = this.getTabInstanceId(editor);
		if (!tabInstanceId) {
			return 'editor';
		}

		return this.getCurrentView(tabInstanceId);
	}

	getChartState(tabInstanceId: string): ChartState | undefined {
		return this.states.get(tabInstanceId)?.chartState;
	}

	updateChartState(tabInstanceId: string, update: Partial<ChartState>): ChartState | undefined {
		const existing = this.states.get(tabInstanceId);
		if (!existing) {
			return undefined;
		}

		const chartState: ChartState = {
			parameterOverrides: existing.chartState?.parameterOverrides ?? {},
			...existing.chartState,
			...update
		};

		const next: TabViewState = {
			...existing,
			chartState
		};

		this.states.set(tabInstanceId, next);
		return chartState;
	}

	getTradeState(tabInstanceId: string): TradeState | undefined {
		return this.states.get(tabInstanceId)?.tradeState;
	}

	updateTradeState(tabInstanceId: string, update: Partial<TradeState>): TradeState | undefined {
		const existing = this.states.get(tabInstanceId);
		if (!existing) {
			return undefined;
		}

		const tradeState: TradeState = {
			sessionId: existing.tradeState?.sessionId ?? null,
			...existing.tradeState,
			...update
		};

		const next: TabViewState = {
			...existing,
			tradeState
		};

		this.states.set(tabInstanceId, next);
		return tradeState;
	}

	setCurrentView(tabInstanceId: string, filePath: string, view: ViewType): void {
		const existing = this.states.get(tabInstanceId);
		const state: TabViewState = {
			tabInstanceId,
			filePath,
			currentView: view,
			chartState: existing?.chartState,
			actionState: existing?.actionState,
			tradeState: existing?.tradeState
		};

		this.states.set(tabInstanceId, state);
		this.workbenchState.set(tabInstanceId, view);
		void this.runWorkbenchCommand('quantlab.setTabViewState', {
			tabInstanceId,
			view,
			resource: filePath
		});

		this._onDidChangeView.fire({
			tabInstanceId,
			uri: vscode.Uri.parse(filePath),
			view
		});
	}

	removeState(tabInstanceId: string): void {
		this.states.delete(tabInstanceId);
		this.workbenchState.delete(tabInstanceId);
		void this.runWorkbenchCommand('quantlab.clearTabViewState', tabInstanceId);
	}

	getTabInstanceId(editor: vscode.TextEditor): string | undefined {
		const uri = editor.document.uri;
		let fallback: string | undefined;

		const groups = vscode.window.tabGroups.all;
		for (const group of groups) {
			const groupIndex = groups.indexOf(group);
			for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
				const tab = group.tabs[tabIndex];
				const tabUri = this.getTabResource(tab);
				if (!tabUri || tabUri.toString() !== uri.toString()) {
					continue;
				}

				const tabInstanceId = this.buildTabInstanceId(tabUri, groupIndex, tabIndex);
				if (tab.isActive) {
					return tabInstanceId;
				}
				fallback = tabInstanceId;
			}
		}

		return fallback;
	}

	getTabInstanceIdForResource(resource: vscode.Uri, preferActive = true): string | undefined {
		let fallback: string | undefined;

		const groups = vscode.window.tabGroups.all;
		for (const group of groups) {
			const groupIndex = groups.indexOf(group);
			for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
				const tab = group.tabs[tabIndex];
				const tabUri = this.getTabResource(tab);
				if (!tabUri || tabUri.toString() !== resource.toString()) {
					continue;
				}

				const tabInstanceId = this.buildTabInstanceId(tabUri, groupIndex, tabIndex);
				if (preferActive && tab.isActive) {
					return tabInstanceId;
				}
				fallback = tabInstanceId;
			}
		}

		return fallback;
	}

	private buildTabInstanceId(uri: vscode.Uri, groupIndex: number, tabIndex: number): string {
		return `${uri.toString()}::${groupIndex}::${tabIndex}`;
	}

	private getTabResource(tab: vscode.Tab): vscode.Uri | undefined {
		if (tab.input instanceof vscode.TabInputText) {
			return tab.input.uri;
		}

		if (tab.input instanceof vscode.TabInputCustom) {
			return tab.input.uri;
		}

		if (tab.input instanceof vscode.TabInputTextDiff) {
			return tab.input.modified;
		}

		return undefined;
	}

	private async runWorkbenchCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
		if (Date.now() < this.workbenchDisabledUntil) {
			return undefined;
		}

		try {
			const result = await vscode.commands.executeCommand<T>(command, ...args);
			this.workbenchFailureCount = 0;
			this.workbenchDisabledUntil = 0;
			return result;
		} catch {
			this.workbenchFailureCount = Math.min(this.workbenchFailureCount + 1, 5);
			const backoffMs = Math.min(1000 * Math.pow(2, this.workbenchFailureCount - 1), 30000);
			this.workbenchDisabledUntil = Date.now() + backoffMs;
			return undefined;
		}
	}
}
