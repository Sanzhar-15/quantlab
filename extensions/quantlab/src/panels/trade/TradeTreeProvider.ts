/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager } from '../../core/trading/SessionManager';
import { StrategyValidator } from '../../core/strategy/StrategyValidator';
import { SessionInfo } from '../../types/trading';

type TradeNode = TradePanelItem;

export class TradeTreeProvider implements vscode.TreeDataProvider<TradeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TradeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly sessionManager = SessionManager.getInstance();
	private readonly validator = StrategyValidator.getInstance();

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			this.sessionManager.onSessionsChanged(() => this.refresh()),
			this.sessionManager.onAccountsChanged(() => this.refresh()),
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
		);
	}

	getTreeItem(element: TradeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TradeNode): Promise<TradeNode[]> {
		if (!element) {
			return [
				new TradePanelItem('Session Control', vscode.TreeItemCollapsibleState.Expanded, 'section.sessionControl', 'quantlab.trade.section.session'),
				new TradePanelItem('Active Sessions', vscode.TreeItemCollapsibleState.Expanded, 'section.activeSessions', 'quantlab.trade.section.sessions'),
				new TradePanelItem('Positions (All)', vscode.TreeItemCollapsibleState.Expanded, 'section.positions', 'quantlab.trade.section.positions'),
				new TradePanelItem('Open Orders', vscode.TreeItemCollapsibleState.Expanded, 'section.orders', 'quantlab.trade.section.orders'),
				new TradePanelItem('Risk Status', vscode.TreeItemCollapsibleState.Expanded, 'section.risk', 'quantlab.trade.section.risk'),
				new TradePanelItem('Connections', vscode.TreeItemCollapsibleState.Expanded, 'section.connections', 'quantlab.trade.section.connections')
			];
		}

		switch (element.contextValue) {
			case 'section.sessionControl':
				return this.getSessionControlItems();
			case 'section.activeSessions':
				return this.getActiveSessionItems();
			case 'section.positions':
				return this.getPositionItems();
			case 'section.orders':
				return this.getOrderItems();
			case 'section.risk':
				return this.getRiskItems();
			case 'section.connections':
				return this.getConnectionItems();
			default:
				return [];
		}
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private async getSessionControlItems(): Promise<TradePanelItem[]> {
		const strategyPath = this.getActiveStrategyPath();
		const strategyLabel = strategyPath ? this.getFileName(strategyPath) : 'No strategy selected';

		const selectedAccountId = this.sessionManager.getSelectedAccountId();
		const account = selectedAccountId
			? this.sessionManager.getAccounts().find(acc => acc.id === selectedAccountId)
			: this.sessionManager.getAccounts()[0];
		const accountLabel = account ? `${account.name} (${account.type})` : 'No account configured';

		const items: TradePanelItem[] = [
			new TradePanelItem(`Strategy: ${strategyLabel}`, vscode.TreeItemCollapsibleState.None, 'strategy'),
			new TradePanelItem(`Account: ${accountLabel}`, vscode.TreeItemCollapsibleState.None, 'account', 'quantlab.trade.account')
		];
		items[1].command = { command: 'quantlab.openBrokerSettings', title: 'Open Broker Settings' };

		const requirements = strategyPath ? await this.sessionManager.getRequirementsCheck(strategyPath) : undefined;
		const policy = this.sessionManager.getRequirementsPolicy();

		items.push(this.buildStartItem('paper', strategyPath, requirements, policy));
		items.push(this.buildStartItem('live', strategyPath, requirements, policy));

		return items;
	}

	private buildStartItem(
		type: 'paper' | 'live',
		strategyPath: string | undefined,
		requirements: Awaited<ReturnType<SessionManager['getRequirementsCheck']>> | undefined,
		policy: { requireBacktest: boolean; requirePaperTrading: boolean; requireRiskReview: boolean }
	): TradePanelItem {
		const label = type === 'paper' ? 'Start Paper' : 'Start Live';
		const item = new TradePanelItem(label, vscode.TreeItemCollapsibleState.None, `start.${type}`, `quantlab.trade.start.${type}`);

		if (!strategyPath || !requirements) {
			item.description = 'Select a strategy';
			return item;
		}

		const reason = this.getEligibilityReason(type, requirements, policy);
		if (reason) {
			item.description = 'Blocked';
			item.tooltip = reason;
			return item;
		}

		item.command = {
			command: type === 'paper' ? 'quantlab.startPaperSession' : 'quantlab.startLiveSession',
			title: label
		};
		return item;
	}

	private getEligibilityReason(
		type: 'paper' | 'live',
		requirements: Awaited<ReturnType<SessionManager['getRequirementsCheck']>>,
		policy: { requireBacktest: boolean; requirePaperTrading: boolean; requireRiskReview: boolean }
	): string | undefined {
		if (!requirements.validStrategy) {
			return 'Invalid strategy entrypoint.';
		}
		if (!requirements.brokerConfigured) {
			return 'No broker accounts configured.';
		}
		const hasAccount = this.sessionManager.getAccounts().some(account => account.type === type);
		if (!hasAccount) {
			return `No ${type} broker account configured.`;
		}
		if (type === 'live' && requirements.complexity === 'viewOnly') {
			return 'View-only strategies cannot trade live.';
		}
		if (type === 'live') {
			if (policy.requireBacktest && !requirements.hasBacktest) {
				return 'Backtest required before live trading.';
			}
			if (policy.requirePaperTrading && !requirements.hasPaperTrading) {
				return 'Paper trading required before live trading.';
			}
			if (policy.requireRiskReview && !requirements.riskReviewed) {
				return 'Risk review required before live trading.';
			}
		}
		return undefined;
	}

	private getActiveSessionItems(): TradePanelItem[] {
		const sessions = this.sessionManager.getActiveSessions();
		if (!sessions.length) {
			return [new TradePanelItem('No active sessions', vscode.TreeItemCollapsibleState.None, 'empty')];
		}

		return sessions.map(session => this.createSessionItem(session));
	}

	private createSessionItem(session: SessionInfo): TradePanelItem {
		const duration = this.formatDuration(Date.now() - session.startedAt);
		const pnl = this.sessionManager.getSessionPnL(session.id);
		const pnlLabel = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
		const label = `${this.getFileName(session.strategyPath)} (${session.type === 'paper' ? 'Paper' : 'Live'})`;

		const item = new TradePanelItem(label, vscode.TreeItemCollapsibleState.None, 'activeSession', session.id);
		item.description = `${session.status === 'paused' ? 'Paused' : 'Running'} ${duration} - ${pnlLabel}`;
		item.tooltip = `Session: ${session.id}\nStarted: ${new Date(session.startedAt).toLocaleString()}`;
		item.command = {
			command: 'quantlab.viewSession',
			title: 'View Session',
			arguments: [session]
		};
		item.contextValue = session.status === 'paused' ? 'activeSessionPaused' : 'activeSession';
		return item;
	}

	private getPositionItems(): TradePanelItem[] {
		const positions = this.sessionManager.getAllPositions();
		if (!positions.length) {
			return [new TradePanelItem('No open positions', vscode.TreeItemCollapsibleState.None, 'empty')];
		}

		return positions.map(position => {
			const pnl = position.unrealizedPnL >= 0 ? `+$${position.unrealizedPnL.toFixed(2)}` : `-$${Math.abs(position.unrealizedPnL).toFixed(2)}`;
			const item = new TradePanelItem(`${position.symbol}: ${position.quantity} (${pnl})`, vscode.TreeItemCollapsibleState.None, 'position');
			item.tooltip = `Avg: $${position.avgPrice.toFixed(2)} | Current: $${position.currentPrice.toFixed(2)}`;
			return item;
		});
	}

	private getOrderItems(): TradePanelItem[] {
		const orders = this.sessionManager.getAllOpenOrders();
		if (!orders.length) {
			return [new TradePanelItem('No open orders', vscode.TreeItemCollapsibleState.None, 'empty')];
		}

		return orders.map(order => {
			const price = order.type === 'market' ? 'Market' : `@ $${order.price?.toFixed(2) ?? '--'}`;
			const item = new TradePanelItem(`${order.symbol}: ${order.side.toUpperCase()} ${order.quantity} ${price}`, vscode.TreeItemCollapsibleState.None, 'order');
			item.tooltip = `Order ${order.id} - ${order.status}`;
			return item;
		});
	}

	private getRiskItems(): TradePanelItem[] {
		const risk = this.sessionManager.getRiskStatus();
		const loss = `${risk.dailyLossPercent.toFixed(1)}% of daily limit`;
		const status = new TradePanelItem(`Daily Loss: ${loss}`, vscode.TreeItemCollapsibleState.None, 'risk');
		const openSettings = new TradePanelItem('Open Risk Settings', vscode.TreeItemCollapsibleState.None, 'riskSettings');
		openSettings.command = {
			command: 'quantlab.openRiskSettings',
			title: 'Open Risk Settings'
		};
		return [status, openSettings];
	}

	private getConnectionItems(): TradePanelItem[] {
		const accounts = this.sessionManager.getAccounts();
		if (!accounts.length) {
			const item = new TradePanelItem('No broker accounts configured', vscode.TreeItemCollapsibleState.None, 'empty');
			item.command = { command: 'quantlab.openBrokerSettings', title: 'Open Broker Settings' };
			return [item];
		}

		const items = accounts.map(account => {
			const label = `${account.name} (${account.type})`;
			const status = account.connected ? 'Connected' : 'Disconnected';
			const item = new TradePanelItem(`${label} - ${status}`, vscode.TreeItemCollapsibleState.None, 'connection');
			item.tooltip = account.lastConnected ? `Last connected: ${new Date(account.lastConnected).toLocaleString()}` : undefined;
			return item;
		});

		const settings = new TradePanelItem('Open Broker Settings', vscode.TreeItemCollapsibleState.None, 'brokerSettings');
		settings.command = { command: 'quantlab.openBrokerSettings', title: 'Open Broker Settings' };
		return [...items, settings];
	}

	private getActiveStrategyPath(): string | undefined {
		const editor = vscode.window.activeTextEditor;
		if (editor && this.validator.isStrategyFile(editor.document)) {
			return editor.document.uri.fsPath;
		}

		const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
		if (tab?.input instanceof vscode.TabInputCustom || tab?.input instanceof vscode.TabInputText) {
			const uri = tab.input.uri;
			const doc = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
			if (doc && this.validator.isStrategyFile(doc)) {
				return doc.uri.fsPath;
			}
		}

		return undefined;
	}

	private getFileName(path: string): string {
		return path.split(/[/\\]/).pop() ?? path;
	}

	private formatDuration(ms: number): string {
		const totalSeconds = Math.max(0, Math.floor(ms / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}m ${seconds}s`;
	}
}

class TradePanelItem extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		contextValue: string,
		id?: string
	) {
		super(label, collapsibleState);
		this.contextValue = contextValue;
		if (id) {
			this.id = id;
		}
	}
}
