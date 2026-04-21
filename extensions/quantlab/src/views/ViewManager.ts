/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StrategyValidator } from '../core/strategy/StrategyValidator';
import { TabViewStateManager } from '../core/state/TabViewState';
import { StrategyValidationResult } from '../types/strategy';
import { ViewType } from '../types/views';
import { updateContextKeys } from '../utils/contextKeys';
import { SessionManager } from '../core/trading/SessionManager';
import * as path from 'path';

const STRATEGY_DOCS_URL = 'https://docs.quantlab.dev/strategies';

export class ViewManager {
	private static instance: ViewManager | undefined;

	private readonly validator = StrategyValidator.getInstance();
	private readonly stateManager = TabViewStateManager.getInstance();

	private constructor() { }

	static getInstance(): ViewManager {
		if (!ViewManager.instance) {
			ViewManager.instance = new ViewManager();
		}
		return ViewManager.instance;
	}

	async switchView(editor: vscode.TextEditor, view: ViewType): Promise<void> {
		const validation = this.validator.validateDocument(editor.document);

		if (view === 'trade' && !this.isTradeEnabled()) {
			await this.showTradeUnavailableToast();
			return;
		}

		if (!this.canSwitchToView(view, validation, editor.document.uri)) {
			await this.showIncompatibleToast(view, validation);
			return;
		}

		if (view === 'trade' && !validation.isValid) {
			await this.showTradeBlockedToast(validation);
			return;
		}

		await this.reopenEditorIfNeeded(view, editor.document.uri);
		await this.finalizeViewChange(view, editor.document.uri, validation);
	}

	async switchViewForResource(resource: vscode.Uri, view: ViewType): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(resource);
		const validation = this.validator.validateDocument(doc);

		if (view === 'trade' && !this.isTradeEnabled()) {
			await this.showTradeUnavailableToast();
			return;
		}

		if (!this.canSwitchToView(view, validation, resource)) {
			await this.showIncompatibleToast(view, validation);
			return;
		}

		if (view === 'trade' && !validation.isValid) {
			await this.showTradeBlockedToast(validation);
			return;
		}

		await this.reopenEditorIfNeeded(view, resource);
		await this.finalizeViewChange(view, resource, validation);
	}

	async openAsView(uri: vscode.Uri, view: ViewType, options?: { openInSideGroup?: boolean }): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(uri);
		const validation = this.validator.validateDocument(doc);

		if (view === 'trade' && !this.isTradeEnabled()) {
			await this.showTradeUnavailableToast();
			return;
		}

		if (!this.canSwitchToView(view, validation, uri)) {
			await this.showIncompatibleToast(view, validation);
			return;
		}

		if (view === 'trade' && !validation.isValid) {
			await this.showTradeBlockedToast(validation);
			return;
		}

		const viewColumn = options?.openInSideGroup ? vscode.ViewColumn.Beside : undefined;
		await vscode.commands.executeCommand('quantlab.openAsView', { resource: uri, view, viewColumn });
		await this.reopenEditorIfNeeded(view, uri);
		await this.finalizeViewChange(view, uri, validation, { autoExpandPanel: false });
	}

	private canSwitchToView(view: ViewType, validation: StrategyValidationResult, resource?: vscode.Uri): boolean {
		if (view === 'editor') {
			return true;
		}

		// Server symbols always allow chart and action views (data comes from GlobalState, not the file)
		if (resource?.scheme === 'quantlab-server') {
			return view !== 'trade' || this.isTradeEnabled();
		}

		// Action view is allowed for data files (csv, parquet, xlsx)
		if (view === 'action' && resource && this.isDataFile(resource)) {
			return true;
		}

		if (view === 'trade' && !this.isTradeEnabled()) {
			return false;
		}

		return Boolean(validation.entrypoint);
	}

	private isDataFile(resource: vscode.Uri): boolean {
		const ext = path.extname(resource.fsPath).toLowerCase();
		return ext === '.csv' || ext === '.parquet' || ext === '.xlsx';
	}

	private async showIncompatibleToast(view: ViewType, validation: StrategyValidationResult): Promise<void> {
		const viewLabel = this.formatViewLabel(view);
		const message = vscode.l10n.t('{0} view is not available for this file.', viewLabel);
		const isNotPython = validation.errors.some(error => error.code === 'NOT_PYTHON');
		const detail = isNotPython
			? vscode.l10n.t('{0} view requires a Python strategy file.', viewLabel)
			: vscode.l10n.t('{0} view requires a Python file with a valid strategy. This file appears to be a utility module.', viewLabel);
		const learn = vscode.l10n.t('Learn about strategies');
		const dismiss = vscode.l10n.t('Dismiss');

		const selection = await vscode.window.showWarningMessage(message, { detail }, learn, dismiss);
		if (selection === learn) {
			await vscode.env.openExternal(vscode.Uri.parse(STRATEGY_DOCS_URL));
		}
	}

	private async showTradeBlockedToast(validation: StrategyValidationResult): Promise<void> {
		const message = vscode.l10n.t('Trade view is not available for this strategy.');
		const detail = this.buildValidationDetail(validation);
		const learn = vscode.l10n.t('Learn about strategies');
		const dismiss = vscode.l10n.t('Dismiss');

		const selection = await vscode.window.showWarningMessage(message, { detail }, learn, dismiss);
		if (selection === learn) {
			await vscode.env.openExternal(vscode.Uri.parse(STRATEGY_DOCS_URL));
		}
	}

	private async showTradeUnavailableToast(): Promise<void> {
		const message = vscode.l10n.t('Trade view requires a configured broker account.');
		const openSettings = vscode.l10n.t('Open Broker Settings');
		const dismiss = vscode.l10n.t('Dismiss');

		const selection = await vscode.window.showWarningMessage(message, openSettings, dismiss);
		if (selection === openSettings) {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'quantlab.trading');
		}
	}

	private async showValidationNoticeIfNeeded(view: ViewType, validation: StrategyValidationResult): Promise<void> {
		if (validation.isValid || validation.errors.length === 0) {
			return;
		}

		const viewLabel = this.formatViewLabel(view);
		const message = vscode.l10n.t('{0} view detected validation errors.', viewLabel);
		const detail = this.buildValidationDetail(validation);
		const learn = vscode.l10n.t('Learn about strategies');
		const dismiss = vscode.l10n.t('Dismiss');

		const selection = await vscode.window.showWarningMessage(message, { detail }, learn, dismiss);
		if (selection === learn) {
			await vscode.env.openExternal(vscode.Uri.parse(STRATEGY_DOCS_URL));
		}
	}

	private buildValidationDetail(validation: StrategyValidationResult): string {
		if (!validation.errors.length) {
			return vscode.l10n.t('Fix validation errors to continue.');
		}

		const lines = validation.errors.slice(0, 5).map(error => {
			const line = error.line > 0 ? error.line : 1;
			return vscode.l10n.t('Line {0}: {1}', line, error.message);
		});

		return lines.join('\n');
	}

	private autoExpandPanel(_view: ViewType): void {
		switch (_view) {
			case 'action':
				void vscode.commands.executeCommand('quantlab.focusResourcesPanel');
				break;
			case 'trade':
				void vscode.commands.executeCommand('quantlab.focusTradePanel');
				break;
			default:
				break;
		}
	}

	private async reopenEditorIfNeeded(view: ViewType, resource?: vscode.Uri): Promise<void> {
		const viewId = this.resolveViewId(view);
		const target = resource ?? this.getActiveResource();

		if (target) {
			try {
				await vscode.commands.executeCommand('vscode.openWith', target, viewId);
				return;
			} catch {
				// Fallback to legacy reopen command if openWith fails.
			}
		}

		await vscode.commands.executeCommand('reopenActiveEditorWith', viewId);
	}

	private async finalizeViewChange(
		view: ViewType,
		resource: vscode.Uri,
		validation: StrategyValidationResult,
		options?: { autoExpandPanel?: boolean }
	): Promise<void> {
		// Set context keys immediately - workbench will also detect from editor type
		updateContextKeys(view, validation);

		// State storage is now only for view-specific settings (chart params, etc.)
		// Not for tracking current view type
		const tabInstanceId = await this.resolveTabInstanceId(resource, view);
		if (tabInstanceId) {
			this.stateManager.setCurrentView(tabInstanceId, resource.toString(), view);
		}

		if (view === 'chart' || view === 'action') {
			await this.showValidationNoticeIfNeeded(view, validation);
		}

		if (options?.autoExpandPanel !== false) {
			this.autoExpandPanel(view);
		}
	}

	private async resolveTabInstanceId(resource: vscode.Uri, view: ViewType): Promise<string | undefined> {
		const resolved = this.findTabInstanceId(resource, view);
		if (resolved) {
			return resolved;
		}

		return new Promise(resolve => {
			const disposables: vscode.Disposable[] = [];
			const disposeAll = (): void => {
				while (disposables.length) {
					disposables.pop()?.dispose();
				}
			};

			const timeout = setTimeout(() => {
				disposeAll();
				resolve(this.findTabInstanceId(resource, view));
			}, 1500);

			const onTabsChanged = vscode.window.tabGroups.onDidChangeTabs(() => {
				const found = this.findTabInstanceId(resource, view);
				if (!found) {
					return;
				}
				clearTimeout(timeout);
				disposeAll();
				resolve(found);
			});

			disposables.push(onTabsChanged);
		});
	}

	private findTabInstanceId(resource: vscode.Uri, view: ViewType): string | undefined {
		const groups = vscode.window.tabGroups.all;
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
			const group = groups[groupIndex];
			for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
				const tab = group.tabs[tabIndex];
				const tabResource = this.getTabResource(tab);
				if (!tabResource || tabResource.toString() !== resource.toString()) {
					continue;
				}

				if (!this.tabMatchesView(tab, view)) {
					continue;
				}

				return `${tabResource.toString()}::${groupIndex}::${tabIndex}`;
			}
		}

		return undefined;
	}

	private tabMatchesView(tab: vscode.Tab, view: ViewType): boolean {
		if (view === 'editor') {
			return tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputTextDiff;
		}

		if (tab.input instanceof vscode.TabInputCustom) {
			return tab.input.viewType === this.resolveViewId(view);
		}

		return false;
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

	private resolveViewId(view: ViewType): string {
		switch (view) {
			case 'chart':
				return 'quantlab.chartView';
			case 'action':
				return 'quantlab.actionView';
			case 'trade':
				return 'quantlab.tradeView';
			default:
				return 'default';
		}
	}

	private getActiveResource(): vscode.Uri | undefined {
		const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
		if (!tab) {
			return undefined;
		}

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

	private isTradeEnabled(): boolean {
		try {
			return SessionManager.getInstance().hasBrokerConfigured();
		} catch {
			return false;
		}
	}

	private formatViewLabel(view: ViewType): string {
		switch (view) {
			case 'chart':
				return 'Chart';
			case 'action':
				return 'Action';
			case 'trade':
				return 'Trade';
			default:
				return 'Editor';
		}
	}
}
