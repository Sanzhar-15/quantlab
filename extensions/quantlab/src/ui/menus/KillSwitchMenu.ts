/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kill Switch Menu.
 *
 * Status bar item with emergency controls for managing trading sessions.
 * Provides quick access to flatten positions, stop sessions, and pause trading.
 */

import * as vscode from 'vscode';
import { SessionManager } from '../../core/trading/SessionManager';
import type { SessionInfo, OrderSide } from '../../types/trading';

/**
 * Kill switch menu action.
 */
export type KillSwitchAction = 'flattenAll' | 'flattenSession' | 'stopAll' | 'stopSession' | 'pauseAll' | 'pauseSession';

/**
 * Kill Switch Menu - Status bar emergency controls.
 */
export class KillSwitchMenu implements vscode.Disposable {
	private static instance: KillSwitchMenu | undefined;

	private readonly sessionManager = SessionManager.getInstance();
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];
	private hasActiveSessions = false;
	private hasLiveSessions = false;

	private constructor() {
		// Create status bar item with high priority (far right)
		this.statusBarItem = vscode.window.createStatusBarItem(
			'quantlab.killSwitch',
			vscode.StatusBarAlignment.Right,
			1000
		);

		this.statusBarItem.command = 'quantlab.killSwitch.showMenu';
		this.updateStatusBar();

		// Subscribe to session events
		this.disposables.push(
			this.sessionManager.onSessionStarted(() => this.updateStatusBar()),
			this.sessionManager.onSessionStopped(() => this.updateStatusBar()),
			this.sessionManager.onSessionUpdated(() => this.updateStatusBar())
		);
	}

	static getInstance(): KillSwitchMenu {
		if (!KillSwitchMenu.instance) {
			KillSwitchMenu.instance = new KillSwitchMenu();
		}
		return KillSwitchMenu.instance;
	}

	/**
	 * Register commands and show status bar.
	 */
	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			this.statusBarItem,
			vscode.commands.registerCommand('quantlab.killSwitch.showMenu', () => this.showMenu()),
			vscode.commands.registerCommand('quantlab.killSwitch.flattenAll', () => this.flattenAll()),
			vscode.commands.registerCommand('quantlab.killSwitch.stopAll', () => this.stopAllSessions()),
			vscode.commands.registerCommand('quantlab.killSwitch.pauseAll', () => this.pauseAllSessions()),
			...this.disposables
		);

		this.statusBarItem.show();
	}

	/**
	 * Flatten all positions across all active sessions.
	 */
	async flattenAll(): Promise<void> {
		const sessions = this.getActiveSessions();
		if (sessions.length === 0) {
			void vscode.window.showInformationMessage('No active trading sessions.');
			return;
		}

		const liveSessions = sessions.filter(s => s.type === 'live');
		if (liveSessions.length > 0) {
			const confirm = await vscode.window.showWarningMessage(
				`This will flatten ALL positions in ${liveSessions.length} LIVE trading session(s). This action cannot be undone.`,
				{ modal: true },
				'Flatten All'
			);
			if (confirm !== 'Flatten All') {
				return;
			}
		}

		const outputChannel = this.sessionManager.getOutputChannel();
		outputChannel.appendLine(`[Kill Switch] Flattening all positions across ${sessions.length} session(s)...`);
		outputChannel.show();

		const results = await Promise.allSettled(
			sessions.map(session => this.flattenSession(session.id))
		);

		const succeeded = results.filter(r => r.status === 'fulfilled').length;
		const failed = results.filter(r => r.status === 'rejected').length;

		if (failed > 0) {
			void vscode.window.showErrorMessage(`Flatten completed with errors: ${succeeded} succeeded, ${failed} failed`);
		} else {
			void vscode.window.showInformationMessage(`All positions flattened across ${succeeded} session(s)`);
		}
	}

	/**
	 * Stop all active sessions.
	 */
	async stopAllSessions(): Promise<void> {
		const sessions = this.getActiveSessions();
		if (sessions.length === 0) {
			void vscode.window.showInformationMessage('No active trading sessions.');
			return;
		}

		const liveSessions = sessions.filter(s => s.type === 'live');
		if (liveSessions.length > 0) {
			const confirm = await vscode.window.showWarningMessage(
				`This will STOP ${sessions.length} trading session(s) including ${liveSessions.length} LIVE session(s). Open positions will remain open.`,
				{ modal: true },
				'Stop All'
			);
			if (confirm !== 'Stop All') {
				return;
			}
		}

		const outputChannel = this.sessionManager.getOutputChannel();
		outputChannel.appendLine(`[Kill Switch] Stopping all ${sessions.length} session(s)...`);

		const results = await Promise.allSettled(
			sessions.map(session => this.sessionManager.stopSession(session.id, 'killSwitch'))
		);

		const succeeded = results.filter(r => r.status === 'fulfilled').length;
		void vscode.window.showInformationMessage(`Stopped ${succeeded} of ${sessions.length} session(s)`);
	}

	/**
	 * Pause all active sessions.
	 */
	async pauseAllSessions(): Promise<void> {
		const sessions = this.getActiveSessions().filter(s => s.status === 'running');
		if (sessions.length === 0) {
			void vscode.window.showInformationMessage('No running sessions to pause.');
			return;
		}

		const outputChannel = this.sessionManager.getOutputChannel();
		outputChannel.appendLine(`[Kill Switch] Pausing ${sessions.length} session(s)...`);

		const results = await Promise.allSettled(
			sessions.map(session => this.sessionManager.pauseSession(session.id))
		);

		const succeeded = results.filter(r => r.status === 'fulfilled').length;
		void vscode.window.showInformationMessage(`Paused ${succeeded} of ${sessions.length} session(s)`);
	}

	/**
	 * Flatten positions for a specific session.
	 */
	private async flattenSession(sessionId: string): Promise<void> {
		const outputChannel = this.sessionManager.getOutputChannel();

		try {
			// Use daemon-aware flatten if available
			if (this.sessionManager.isUsingDaemon(sessionId)) {
				await this.sessionManager.flattenAllPositions(sessionId);
			} else {
				// Direct broker flatten
				const record = this.sessionManager.getSessionRecord(sessionId);
				if (!record) {
					throw new Error('Session not found');
				}

				const positions = record.positions.filter(p => p.quantity !== 0);
				for (const position of positions) {
					const request = {
						symbol: position.symbol,
						side: (position.quantity > 0 ? 'sell' : 'buy') as OrderSide,
						type: 'market' as const,
						quantity: Math.abs(position.quantity),
						timeInForce: 'day' as const
					};
					await record.broker.placeOrder(request);
					outputChannel.appendLine(`[${sessionId}] Flattened ${position.symbol}`);
				}
			}
			outputChannel.appendLine(`[${sessionId}] Flatten complete`);
		} catch (error) {
			outputChannel.appendLine(`[${sessionId}] Flatten failed: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Show the kill switch quick pick menu.
	 */
	private async showMenu(): Promise<void> {
		const sessions = this.getActiveSessions();
		const liveSessions = sessions.filter(s => s.type === 'live');
		const runningCount = sessions.filter(s => s.status === 'running').length;

		const items: vscode.QuickPickItem[] = [];

		// Global actions
		if (sessions.length > 0) {
			items.push({
				label: '$(flame) Flatten All Positions',
				description: `Flatten all positions across ${sessions.length} session(s)`,
				detail: liveSessions.length > 0 ? `WARNING: Includes ${liveSessions.length} LIVE session(s)` : undefined
			});

			if (runningCount > 0) {
				items.push({
					label: '$(debug-pause) Pause All Sessions',
					description: `Pause ${runningCount} running session(s)`
				});
			}

			items.push({
				label: '$(stop-circle) Stop All Sessions',
				description: `Stop all ${sessions.length} session(s)`
			});

			items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
		}

		// Per-session actions
		for (const session of sessions) {
			const icon = session.type === 'live' ? '$(zap)' : '$(beaker)';
			const modeLabel = session.type === 'live' ? 'LIVE' : 'Paper';

			items.push({
				label: `${icon} ${session.id}`,
				description: `${modeLabel} - ${session.symbol} - ${session.status}`
			});
		}

		if (sessions.length === 0) {
			items.push({
				label: '$(info) No Active Sessions',
				description: 'Start a trading session to enable kill switch controls'
			});
		}

		const selected = await vscode.window.showQuickPick(items, {
			title: 'Kill Switch',
			placeHolder: 'Select an action'
		});

		if (!selected) {
			return;
		}

		// Handle selection
		if (selected.label.includes('Flatten All')) {
			await this.flattenAll();
		} else if (selected.label.includes('Pause All')) {
			await this.pauseAllSessions();
		} else if (selected.label.includes('Stop All')) {
			await this.stopAllSessions();
		} else if (selected.label.startsWith('$(zap)') || selected.label.startsWith('$(beaker)')) {
			// Per-session action - show sub-menu
			const sessionId = selected.label.replace(/^\$\([^)]+\)\s*/, '');
			await this.showSessionMenu(sessionId);
		}
	}

	/**
	 * Show menu for a specific session.
	 */
	private async showSessionMenu(sessionId: string): Promise<void> {
		const session = this.sessionManager.getSession(sessionId);
		if (!session) {
			return;
		}

		const items: vscode.QuickPickItem[] = [
			{
				label: '$(flame) Flatten Positions',
				description: `Close all positions for ${sessionId}`
			},
			{
				label: session.status === 'running' ? '$(debug-pause) Pause Session' : '$(play) Resume Session',
				description: session.status === 'running' ? 'Pause strategy execution' : 'Resume strategy execution'
			},
			{
				label: '$(stop-circle) Stop Session',
				description: 'Stop and disconnect session'
			}
		];

		const selected = await vscode.window.showQuickPick(items, {
			title: `Session: ${sessionId}`,
			placeHolder: 'Select an action'
		});

		if (!selected) {
			return;
		}

		if (selected.label.includes('Flatten')) {
			if (session.type === 'live') {
				const confirm = await vscode.window.showWarningMessage(
					'This will flatten all positions in a LIVE trading session. This action cannot be undone.',
					{ modal: true },
					'Flatten'
				);
				if (confirm !== 'Flatten') {
					return;
				}
			}
			await this.flattenSession(sessionId);
			void vscode.window.showInformationMessage(`Positions flattened for ${sessionId}`);
		} else if (selected.label.includes('Pause')) {
			await this.sessionManager.pauseSession(sessionId);
		} else if (selected.label.includes('Resume')) {
			await this.sessionManager.resumeSession(sessionId);
		} else if (selected.label.includes('Stop')) {
			await this.sessionManager.stopSession(sessionId, 'killSwitch');
		}
	}

	/**
	 * Update status bar appearance based on session state.
	 */
	private updateStatusBar(): void {
		const sessions = this.getActiveSessions();
		this.hasActiveSessions = sessions.length > 0;
		this.hasLiveSessions = sessions.some(s => s.type === 'live');

		if (!this.hasActiveSessions) {
			this.statusBarItem.text = '$(shield) Kill Switch';
			this.statusBarItem.tooltip = 'No active trading sessions';
			this.statusBarItem.backgroundColor = undefined;
		} else if (this.hasLiveSessions) {
			const liveCount = sessions.filter(s => s.type === 'live').length;
			this.statusBarItem.text = `$(flame) Kill Switch (${liveCount} LIVE)`;
			this.statusBarItem.tooltip = `${liveCount} LIVE session(s) active - Click for emergency controls`;
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			this.statusBarItem.text = `$(beaker) Kill Switch (${sessions.length})`;
			this.statusBarItem.tooltip = `${sessions.length} paper session(s) active - Click for controls`;
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	/**
	 * Get all active sessions.
	 */
	private getActiveSessions(): SessionInfo[] {
		return this.sessionManager.getAllSessions().filter(
			s => s.status === 'running' || s.status === 'paused' || s.status === 'starting'
		);
	}

	/**
	 * Dispose resources.
	 */
	dispose(): void {
		this.statusBarItem.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
