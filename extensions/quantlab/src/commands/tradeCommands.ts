/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager } from '../core/trading/SessionManager';
import { StrategyValidator } from '../core/strategy/StrategyValidator';
import { ChartViewProvider } from '../views/chart/ChartViewProvider';
import { TradeViewProvider } from '../views/trade/TradeViewProvider';
import { ViewManager } from '../views/ViewManager';
import { KillSwitch } from '../views/trade/KillSwitch';
import { SessionInfo } from '../types/trading';

export function registerTradeCommands(context: vscode.ExtensionContext): void {
	const sessionManager = SessionManager.getInstance();
	const validator = StrategyValidator.getInstance();
	const viewManager = ViewManager.getInstance();

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.startPaperSession', async () => {
			const strategyPath = await resolveActiveStrategyPath(validator);
			if (!strategyPath) {
				void vscode.window.showWarningMessage('Select a strategy file to start paper trading.');
				return;
			}
			await sessionManager.startSession(strategyPath, 'paper');
		}),
		vscode.commands.registerCommand('quantlab.startLiveSession', async () => {
			const strategyPath = await resolveActiveStrategyPath(validator);
			if (!strategyPath) {
				void vscode.window.showWarningMessage('Select a strategy file to start live trading.');
				return;
			}
			// CODEX-006: Route live trading through daemon for safety controls
			// (circuit breaker, exposure management, reconciliation, audit logging).
			await sessionManager.startDaemonSession(strategyPath, 'live');
		}),
		vscode.commands.registerCommand('quantlab.pauseSession', async (session?: SessionInfo | string) => {
			const sessionId = resolveSessionId(session);
			if (sessionId) {
				await sessionManager.pauseSession(sessionId);
			}
		}),
		vscode.commands.registerCommand('quantlab.resumeSession', async (session?: SessionInfo | string) => {
			const sessionId = resolveSessionId(session);
			if (sessionId) {
				await sessionManager.resumeSession(sessionId);
			}
		}),
		vscode.commands.registerCommand('quantlab.stopSession', async (session?: SessionInfo | string) => {
			const sessionId = resolveSessionId(session);
			if (sessionId) {
				await sessionManager.stopSession(sessionId);
			}
		}),
		vscode.commands.registerCommand('quantlab.viewSession', async (session?: SessionInfo | string) => {
			const sessionInfo = resolveSessionInfo(session, sessionManager);
			if (!sessionInfo) {
				return;
			}
			const tradeView = TradeViewProvider.getInstance();
			await tradeView.openSession(sessionInfo);
		}),
		vscode.commands.registerCommand('quantlab.trade.viewInChart', async (sessionId?: string) => {
			if (!sessionId) {
				return;
			}
			const info = sessionManager.getSession(sessionId);
			if (!info) {
				void vscode.window.showWarningMessage('Trade session not found.');
				return;
			}

			const uri = vscode.Uri.file(info.strategyPath);
			await viewManager.openAsView(uri, 'chart', { openInSideGroup: false });
			ChartViewProvider.getInstance().attachLiveSession(sessionId, uri);
		}),
		vscode.commands.registerCommand('quantlab.trade.openLogs', () => {
			sessionManager.getOutputChannel().show(true);
		}),
		vscode.commands.registerCommand('quantlab.trade.retrySession', async (session?: SessionInfo | string) => {
			const sessionInfo = resolveSessionInfo(session, sessionManager);
			if (!sessionInfo) {
				void vscode.window.showWarningMessage('No active trade session found.');
				return;
			}
			await sessionManager.refreshSession(sessionInfo.id);
		}),
		vscode.commands.registerCommand('quantlab.trade.restartSession', async (session?: SessionInfo | string) => {
			const sessionInfo = resolveSessionInfo(session, sessionManager);
			if (!sessionInfo) {
				void vscode.window.showWarningMessage('No active trade session found.');
				return;
			}
			if (sessionInfo.type === 'live') {
				const confirm = await vscode.window.showWarningMessage(
					'Restart live session? Open orders will be refreshed.',
					{ modal: true },
					'Restart'
				);
				if (confirm !== 'Restart') {
					return;
				}
			}
			await sessionManager.restartSession(sessionInfo.id);
		}),
		vscode.commands.registerCommand('quantlab.killSwitch', async () => {
			const sessionInfo = resolveSessionInfo(undefined, sessionManager);
			if (!sessionInfo) {
				void vscode.window.showWarningMessage('No active trade session found.');
				return;
			}
			await executeKillSwitch(sessionInfo.id, sessionManager);
		}),
		vscode.commands.registerCommand('quantlab.openRiskSettings', async () => {
			const strategyPath = await resolveActiveStrategyPath(validator);
			if (strategyPath) {
				sessionManager.markRiskReviewed(strategyPath);
			}
			await vscode.commands.executeCommand('workbench.action.openSettings', 'quantlab.trading');
		}),
		vscode.commands.registerCommand('quantlab.openBrokerSettings', async () => {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'quantlab.trading');
		})
	);
}

async function resolveActiveStrategyPath(validator: StrategyValidator): Promise<string | undefined> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	const doc = editor.document;
	// Virtual docs (quantlab-server:// symbol tabs) are not on-disk strategies;
	// their fsPath points at a nonexistent file:// path.
	if (doc.uri.scheme !== 'file' || !validator.isStrategyFile(doc)) {
		return undefined;
	}
	return doc.uri.fsPath;
}

function resolveSessionId(session?: SessionInfo | string): string | undefined {
	if (!session) {
		return undefined;
	}
	if (typeof session === 'string') {
		return session;
	}
	return session.id;
}

function resolveSessionInfo(session: SessionInfo | string | undefined, manager: SessionManager): SessionInfo | undefined {
	if (session) {
		return typeof session === 'string' ? manager.getSession(session) : session;
	}

	const activeStrategy = getActiveStrategyPath();
	if (!activeStrategy) {
		return undefined;
	}
	return manager.getSessionForStrategy(activeStrategy);
}

function getActiveStrategyPath(): string | undefined {
	// Only file:// resources are on-disk strategies -- virtual tabs (e.g.
	// quantlab-server:// symbols) must not leak their fsPath into SessionManager.
	const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
	if (tab?.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') {
		return tab.input.uri.fsPath;
	}
	if (tab?.input instanceof vscode.TabInputCustom && tab.input.uri.scheme === 'file') {
		return tab.input.uri.fsPath;
	}
	const activeDoc = vscode.window.activeTextEditor?.document;
	return activeDoc?.uri.scheme === 'file' ? activeDoc.uri.fsPath : undefined;
}

async function executeKillSwitch(sessionId: string, manager: SessionManager): Promise<void> {
	const record = manager.getSessionRecord(sessionId);
	if (!record) {
		return;
	}

	const killSwitch = KillSwitch.getInstance();
	const config = killSwitch.getConfig();
	const output = manager.getOutputChannel();

	if (record.info.type === 'live') {
		const confirm = await vscode.window.showWarningMessage(
			'Confirm Kill Switch for live trading. This will close positions and cancel orders.',
			{ modal: true },
			'Execute'
		);
		if (confirm !== 'Execute') {
			return;
		}
	}

	await killSwitch.execute(record.info, record.broker, config, output);
	await manager.stopSession(sessionId, 'killSwitch');
}
