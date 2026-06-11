/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager } from '../../core/trading/SessionManager';
import { TabViewStateManager } from '../../core/state/TabViewState';
import { TradeInboundMessage, TradeOutboundMessage } from '../../types/tradeMessages';
import { OrderModification, RequirementsCheck, SessionInfo } from '../../types/trading';
import { TradeWebview } from './TradeWebview';
import { KillSwitch } from './KillSwitch';
import { OrderRequest as BrokerOrderRequest } from '../../core/broker/BrokerAdapter';
import { OrderRequest as DaemonOrderRequest } from '../../core/ipc';
import { ViewManager } from '../ViewManager';
import { ThemeProvider } from '../../ui/tokens/ThemeProvider';
import { ReducedMotion } from '../../ui/accessibility/ReducedMotion';
import { ErrorRecovery } from '../../ui/errors/ErrorRecovery';

interface TradeEditorSession {
	key: string;
	tabInstanceId?: string;
	document: vscode.TextDocument;
	panel: vscode.WebviewPanel;
	webview: TradeWebview;
	disposables: vscode.Disposable[];
	sessionId?: string;
}

export class TradeViewProvider implements vscode.CustomTextEditorProvider {
	static readonly viewType = 'quantlab.tradeView';
	private static instance: TradeViewProvider | undefined;

	private readonly sessions = new Map<string, TradeEditorSession>();
	private readonly sessionManager = SessionManager.getInstance();
	private readonly tabStateManager = TabViewStateManager.getInstance();
	private readonly viewManager = ViewManager.getInstance();
	private readonly pendingSessionByUri = new Map<string, string>();
	private readonly themeProvider = ThemeProvider.getInstance();
	private readonly reducedMotion = ReducedMotion.getInstance();
	private readonly errorRecovery = ErrorRecovery.getInstance();

	constructor(private readonly context: vscode.ExtensionContext) {
		TradeViewProvider.instance = this;

		context.subscriptions.push(
			this.sessionManager.onSessionStarted(session => this.onSessionStarted(session)),
			this.sessionManager.onSessionUpdated(session => this.onSessionUpdated(session)),
			this.sessionManager.onSessionStopped(event => this.onSessionStopped(event.sessionId, event.reason)),
			this.sessionManager.onPositionsUpdate(update => this.broadcast(update.sessionId, {
				type: 'positionsUpdate',
				sessionId: update.sessionId,
				positions: update.positions,
				seq: update.seq
			})),
			this.sessionManager.onOrdersUpdate(update => this.broadcast(update.sessionId, {
				type: 'ordersUpdate',
				sessionId: update.sessionId,
				orders: update.orders,
				seq: update.seq
			})),
			this.sessionManager.onFill(update => this.broadcast(update.sessionId, {
				type: 'fill',
				sessionId: update.sessionId,
				fill: update.fill,
				seq: update.seq
			})),
			this.sessionManager.onPerformanceUpdate(update => this.broadcast(update.sessionId, {
				type: 'performanceUpdate',
				sessionId: update.sessionId,
				performance: update.performance,
				seq: update.seq
			})),
			this.sessionManager.onActivity(update => this.broadcast(update.sessionId, {
				type: 'activity',
				sessionId: update.sessionId,
				entry: update.entry,
				seq: update.seq
			})),
			this.sessionManager.onHeartbeat(update => this.broadcast(update.sessionId, {
				type: 'heartbeat',
				sessionId: update.sessionId,
				status: update.status,
				lastSeen: update.lastSeen
			})),
			this.sessionManager.onRiskAlert(update => this.broadcast(update.sessionId, {
				type: 'riskAlert',
				sessionId: update.sessionId,
				alert: update.alert
			})),
			this.sessionManager.onError(update => {
				this.broadcast(update.sessionId, {
					type: 'errorState',
					sessionId: update.sessionId,
					error: update.error
				});
				void this.errorRecovery.report(this.errorRecovery.buildTradeError(update.sessionId, update.error));
			}),
			this.sessionManager.onRequirementsChanged(update => this.broadcastRequirements(update.strategyPath, update.requirements)),
			vscode.window.tabGroups.onDidChangeTabs(() => this.resolveMissingTabIds()),
			this.reducedMotion.onDidChange(() => this.broadcastReducedMotion())
		);
	}

	static getInstance(): TradeViewProvider {
		if (!TradeViewProvider.instance) {
			throw new Error('TradeViewProvider not initialized');
		}
		return TradeViewProvider.instance;
	}

	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider(TradeViewProvider.viewType, this, {
				supportsMultipleEditorsPerDocument: true
			})
		);
	}

	async openSession(session: SessionInfo): Promise<void> {
		const uri = vscode.Uri.file(session.strategyPath);
		this.pendingSessionByUri.set(uri.toString(), session.id);
		await this.viewManager.openAsView(uri, 'trade', { openInSideGroup: false });

		const existing = this.findSessionForDocument(uri);
		if (existing) {
			this.bindSession(existing, session.id);
			this.sendSnapshot(existing, session.id);
		}
	}

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		panel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this.context.extensionUri,
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
			]
		};

		const html = TradeWebview.buildHtml(panel.webview, this.context.extensionUri);
		const webview = new TradeWebview(panel);
		webview.initialize(html);

		const session: TradeEditorSession = {
			key: `${document.uri.toString()}::${Date.now()}`,
			tabInstanceId: this.resolveTabInstanceId(document, panel),
			document,
			panel,
			webview,
			disposables: []
		};

		this.sessions.set(session.key, session);

		session.disposables.push(
			// onMessage drops the promise, so a rejection inside any handler
			// (stop, restart, kill switch, ...) would otherwise vanish as an
			// unhandled rejection. Surface it loudly -- these are trade
			// actions; a silent failure is a safety bug.
			webview.onMessage(message => {
				void this.onMessage(session, message).catch((error: Error) => {
					this.sessionManager.getOutputChannel().appendLine(`[trade-view] Message handling failed: ${error.message}`);
					void vscode.window.showErrorMessage(`Trade action failed: ${error.message}`);
				});
			}),
			panel.onDidDispose(() => this.disposeSession(session))
		);

		this.themeProvider.registerWebview(session.key, webview);
		this.sendReducedMotion(session);

		if (!session.tabInstanceId) {
			this.resolveMissingTabIds();
		}
	}

	private disposeSession(session: TradeEditorSession): void {
		this.themeProvider.unregisterWebview(session.key);
		this.sessions.delete(session.key);
		for (const disposable of session.disposables) {
			disposable.dispose();
		}
	}

	private async onMessage(session: TradeEditorSession, message: unknown): Promise<void> {
		const payload = message as TradeInboundMessage;
		if (!payload || typeof payload !== 'object' || typeof (payload as { type?: unknown }).type !== 'string') {
			return;
		}

		switch (payload.type) {
			case 'ready':
				session.webview.markReady();
				await this.initializeSession(session);
				return;
			case 'openTradePanel':
				void vscode.commands.executeCommand('quantlab.focusTradePanel');
				return;
			case 'openBrokerSettings':
				void vscode.commands.executeCommand('quantlab.openBrokerSettings');
				return;
			case 'openTradeLogs':
				void vscode.commands.executeCommand('quantlab.trade.openLogs', payload.sessionId);
				return;
			case 'retryBroker':
				await this.sessionManager.refreshSession(payload.sessionId);
				return;
			case 'restartSession':
				await this.sessionManager.restartSession(payload.sessionId);
				return;
			case 'pauseSession':
				await this.sessionManager.pauseSession(payload.sessionId);
				return;
			case 'resumeSession':
				await this.sessionManager.resumeSession(payload.sessionId);
				return;
			case 'stopSession':
				await this.sessionManager.stopSession(payload.sessionId);
				return;
			case 'killSwitch':
				await this.executeKillSwitch(payload.sessionId, Boolean(payload.confirmed));
				return;
			case 'viewInChart':
				await vscode.commands.executeCommand('quantlab.trade.viewInChart', payload.sessionId);
				return;
			case 'modifyOrder':
				await this.modifyOrder(payload.sessionId, payload.orderId, payload.changes);
				return;
			case 'cancelOrder':
				await this.cancelOrder(payload.sessionId, payload.orderId);
				return;
			case 'closePosition':
				await this.closePosition(payload.sessionId, payload.symbol);
				return;
			case 'openSessionSettings':
				await vscode.commands.executeCommand('quantlab.openRiskSettings');
				return;
			case 'scrollPosition':
				this.updateScrollPosition(session, payload.value);
				return;
			default:
				return;
		}
	}

	private async initializeSession(session: TradeEditorSession): Promise<void> {
		const tabId = this.getSessionTabId(session);
		const tradeState = tabId ? this.tabStateManager.getTradeState(tabId) : undefined;
		const strategyPath = session.document.uri.fsPath;
		const requirements = await this.sessionManager.getRequirementsCheck(strategyPath);
		const requirementsPolicy = this.sessionManager.getRequirementsPolicy();
		const killSwitchPolicy = KillSwitch.getInstance().getConfig().policy;

		void vscode.commands.executeCommand('quantlab.focusTradePanel');

		let sessionInfo: SessionInfo | undefined;
		if (tradeState?.sessionId) {
			sessionInfo = this.sessionManager.getSession(tradeState.sessionId);
		}

		if (!sessionInfo) {
			sessionInfo = this.sessionManager.getSessionForStrategy(strategyPath);
		}

		const pending = this.pendingSessionByUri.get(session.document.uri.toString());
		if (pending) {
			this.pendingSessionByUri.delete(session.document.uri.toString());
			sessionInfo = this.sessionManager.getSession(pending) ?? sessionInfo;
		}

		if (sessionInfo) {
			this.bindSession(session, sessionInfo.id);
		} else {
			this.bindSession(session, undefined);
		}

		const initMessage: TradeOutboundMessage = {
			type: 'init',
			session: sessionInfo ?? null,
			requirements,
			requirementsPolicy,
			killSwitchPolicy,
			scrollPosition: tradeState?.scrollPosition
		};
		session.webview.postMessage(initMessage);
		this.sendReducedMotion(session);

		if (sessionInfo) {
			this.sendSnapshot(session, sessionInfo.id);
		}
	}

	private sendReducedMotion(session: TradeEditorSession): void {
		session.webview.postMessage({ type: 'reducedMotion', mode: this.reducedMotion.getMode() });
	}

	private broadcastReducedMotion(): void {
		for (const session of this.sessions.values()) {
			this.sendReducedMotion(session);
		}
	}

	private bindSession(session: TradeEditorSession, sessionId?: string): void {
		session.sessionId = sessionId;

		const tabId = this.getSessionTabId(session);
		if (!tabId) {
			return;
		}

		this.tabStateManager.updateTradeState(tabId, {
			sessionId: sessionId ?? null
		});
	}

	private sendSnapshot(session: TradeEditorSession, sessionId: string): void {
		const snapshot = this.sessionManager.getSessionSnapshot(sessionId);
		if (!snapshot) {
			return;
		}

		session.webview.postMessage({
			type: 'sessionStarted',
			session: snapshot.session
		});
		session.webview.postMessage({
			type: 'positionsUpdate',
			sessionId,
			positions: snapshot.positions
		});
		session.webview.postMessage({
			type: 'ordersUpdate',
			sessionId,
			orders: snapshot.orders
		});
		session.webview.postMessage({
			type: 'performanceUpdate',
			sessionId,
			performance: snapshot.performance
		});
		for (const entry of snapshot.activity) {
			session.webview.postMessage({
				type: 'activity',
				sessionId,
				entry
			});
		}
		session.webview.postMessage({
			type: 'heartbeat',
			sessionId,
			status: snapshot.heartbeat.status,
			lastSeen: snapshot.heartbeat.lastSeen
		});
	}

	private broadcast(sessionId: string, message: TradeOutboundMessage): void {
		for (const session of this.sessions.values()) {
			if (session.sessionId !== sessionId) {
				continue;
			}
			session.webview.postMessage(message);
		}
	}

	private broadcastRequirements(strategyPath: string, requirements: RequirementsCheck): void {
		const requirementsPolicy = this.sessionManager.getRequirementsPolicy();
		for (const session of this.sessions.values()) {
			if (session.document.uri.fsPath !== strategyPath) {
				continue;
			}
			session.webview.postMessage({ type: 'requirementsUpdate', requirements, requirementsPolicy });
		}
	}

	private onSessionStarted(sessionInfo: SessionInfo): void {
		for (const session of this.sessions.values()) {
			if (session.document.uri.fsPath !== sessionInfo.strategyPath) {
				continue;
			}
			if (!session.sessionId) {
				this.bindSession(session, sessionInfo.id);
			}
			this.sendSnapshot(session, sessionInfo.id);
		}
	}

	private onSessionUpdated(sessionInfo: SessionInfo): void {
		this.broadcast(sessionInfo.id, { type: 'sessionUpdated', session: sessionInfo });
	}

	private onSessionStopped(sessionId: string, reason?: string): void {
		for (const session of this.sessions.values()) {
			if (session.sessionId !== sessionId) {
				continue;
			}
			session.webview.postMessage({ type: 'sessionStopped', sessionId, reason });
			this.bindSession(session, undefined);
		}
	}

	private async executeKillSwitch(sessionId: string, confirmed: boolean): Promise<void> {
		const record = this.sessionManager.getSessionRecord(sessionId);
		if (!record) {
			return;
		}

		if (record.info.type === 'live' && !confirmed) {
			const confirm = await vscode.window.showWarningMessage(
				'Confirm Kill Switch for live trading. This will close positions and cancel orders.',
				{ modal: true },
				'Execute'
			);
			if (confirm !== 'Execute') {
				return;
			}
		}

		const killSwitch = KillSwitch.getInstance();

		// Flatten stage. A failure is surfaced loudly but must NOT abort the
		// teardown stage below: after a kill switch the session (and, for
		// daemon sessions, the Python daemon process) must come down even if
		// flattening failed.
		if (this.sessionManager.isUsingDaemon(sessionId)) {
			try {
				await this.sessionManager.flattenAllPositions(sessionId);
			} catch (error) {
				this.sessionManager.getOutputChannel().appendLine(`[${sessionId}] Kill switch flatten failed: ${(error as Error).message}`);
				void vscode.window.showErrorMessage(`Kill switch flatten failed: ${(error as Error).message}`);
			}
		} else {
			try {
				await killSwitch.execute(record.info, record.broker, killSwitch.getConfig(), this.sessionManager.getOutputChannel());
			} catch (error) {
				this.sessionManager.getOutputChannel().appendLine(`[${sessionId}] Kill switch execute failed: ${(error as Error).message}`);
				void vscode.window.showErrorMessage(`Kill switch failed: ${(error as Error).message}`);
			}
		}

		// Teardown stage (H27): stopSession() itself now routes daemon-backed
		// sessions through stopDaemonSession(), so the daemon process is torn
		// down on every stop path. A teardown failure must never be silent on
		// the kill switch -- surface it via showErrorMessage AND the log.
		try {
			await this.sessionManager.stopSession(sessionId, 'killSwitch');
		} catch (error) {
			this.sessionManager.getOutputChannel().appendLine(`[${sessionId}] Kill switch session teardown FAILED: ${(error as Error).message}`);
			void vscode.window.showErrorMessage(`Kill switch failed to stop session: ${(error as Error).message}. The strategy may still be running -- check the Quantlab Trading log.`);
		}
	}

	private async modifyOrder(sessionId: string, orderId: string, changes: OrderModification): Promise<void> {
		const record = this.sessionManager.getSessionRecord(sessionId);
		if (!record) {
			return;
		}

		try {
			await record.broker.modifyOrder(orderId, {
				quantity: changes.quantity,
				price: changes.price,
				stopPrice: changes.stopPrice
			});
		} catch (error) {
			void vscode.window.showErrorMessage(`Failed to modify order: ${(error as Error).message}`);
		}
	}

	private async cancelOrder(sessionId: string, orderId: string): Promise<void> {
		const record = this.sessionManager.getSessionRecord(sessionId);
		if (!record) {
			return;
		}

		try {
			// Use daemon-aware cancelOrder if using daemon, otherwise direct broker
			if (this.sessionManager.isUsingDaemon(sessionId)) {
				await this.sessionManager.cancelOrder(sessionId, orderId);
			} else {
				await record.broker.cancelOrder(orderId);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Failed to cancel order: ${(error as Error).message}`);
		}
	}

	private async closePosition(sessionId: string, symbol: string): Promise<void> {
		const record = this.sessionManager.getSessionRecord(sessionId);
		if (!record) {
			return;
		}

		const position = record.positions.find(pos => pos.symbol === symbol);
		if (!position || !position.quantity) {
			return;
		}

		const side = position.quantity > 0 ? 'sell' : 'buy';
		const quantity = Math.abs(position.quantity);

		try {
			// Use daemon-aware submitOrder if using daemon, otherwise direct broker
			if (this.sessionManager.isUsingDaemon(sessionId)) {
				const daemonRequest: DaemonOrderRequest = {
					symbol,
					side,
					orderType: 'market',
					quantity,
					timeInForce: 'day'
				};
				await this.sessionManager.submitOrder(sessionId, daemonRequest);
			} else {
				const brokerRequest: BrokerOrderRequest = {
					symbol,
					side,
					type: 'market',
					quantity,
					timeInForce: 'day'
				};
				await record.broker.placeOrder(brokerRequest);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Failed to close position: ${(error as Error).message}`);
		}
	}

	private updateScrollPosition(session: TradeEditorSession, value: number): void {
		const tabId = this.getSessionTabId(session);
		if (!tabId) {
			return;
		}

		this.tabStateManager.updateTradeState(tabId, { scrollPosition: value });
	}

	private resolveTabInstanceId(document: vscode.TextDocument, panel: vscode.WebviewPanel): string | undefined {
		const groups = vscode.window.tabGroups.all;
		for (const group of groups) {
			const groupIndex = groups.indexOf(group);
			if (panel.viewColumn && group.viewColumn !== panel.viewColumn) {
				continue;
			}
			for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
				const tab = group.tabs[tabIndex];
				if (tab.input instanceof vscode.TabInputCustom &&
					tab.input.viewType === TradeViewProvider.viewType &&
					tab.input.uri.toString() === document.uri.toString()) {
					return `${document.uri.toString()}::${groupIndex}::${tabIndex}`;
				}
			}
		}
		return undefined;
	}

	private resolveMissingTabIds(): void {
		for (const session of this.sessions.values()) {
			if (!session.tabInstanceId) {
				const resolved = this.resolveTabInstanceId(session.document, session.panel);
				if (resolved) {
					session.tabInstanceId = resolved;
				}
			}
		}
	}

	private getSessionTabId(session: TradeEditorSession): string | undefined {
		return session.tabInstanceId ?? this.tabStateManager.getTabInstanceIdForResource(session.document.uri);
	}

	private findSessionForDocument(uri: vscode.Uri): TradeEditorSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.document.uri.toString() === uri.toString()) {
				return session;
			}
		}
		return undefined;
	}
}
