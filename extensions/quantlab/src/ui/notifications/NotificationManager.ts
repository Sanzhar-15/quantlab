/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HistoryState } from '../../core/state/HistoryState';
import { SessionManager } from '../../core/trading/SessionManager';
import { HistoryEntry } from '../../types/history';
import { Fill, RiskAlert, SessionInfo } from '../../types/trading';
import { QuantlabNotification, QuantlabNotificationAction, QuantlabToastPayload } from '../../types/notifications';
import { ToastService } from './ToastService';
import { SoundPlayer } from './SoundPlayer';

const MAX_HISTORY = 200;

interface NotificationSettings {
	showJobComplete: boolean;
	showJobFailed: boolean;
	showTradeExecuted: boolean;
	showRiskAlerts: boolean;
	showSessionStatus: boolean;
	soundEnabled: boolean;
	playFillSound: boolean;
	playAlertSound: boolean;
	playCompleteSound: boolean;
}

export class NotificationManager {
	private static instance: NotificationManager | undefined;

	private readonly toastService = new ToastService();
	private readonly soundPlayer: SoundPlayer;
	private readonly history: QuantlabNotification[] = [];
	private readonly lastRunStatus = new Map<string, string>();
	private readonly lastSessionStatus = new Map<string, string>();
	private settings: NotificationSettings;

	private constructor(
		context: vscode.ExtensionContext,
		private readonly historyState: HistoryState,
		private readonly sessionManager: SessionManager
	) {
		this.soundPlayer = new SoundPlayer(context);
		this.settings = this.readSettings();

		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('quantlab.notifications')) {
					this.settings = this.readSettings();
				}
			}),
			this.historyState.onDidAdd(entry => this.handleRunUpdate(entry)),
			this.historyState.onDidUpdate(entry => this.handleRunUpdate(entry)),
			this.sessionManager.onFill(event => this.handleFill(event.sessionId, event.fill)),
			this.sessionManager.onRiskAlert(event => this.handleRiskAlert(event.sessionId, event.alert)),
			this.sessionManager.onSessionStarted(session => this.handleSessionStatus(session)),
			this.sessionManager.onSessionUpdated(session => this.handleSessionStatus(session)),
			this.sessionManager.onSessionStopped(event => this.handleSessionStopped(event.sessionId, event.reason))
		);

		for (const entry of this.historyState.query()) {
			this.lastRunStatus.set(entry.id, entry.status);
		}
	}

	static initialize(context: vscode.ExtensionContext, historyState: HistoryState, sessionManager: SessionManager): NotificationManager {
		if (!NotificationManager.instance) {
			NotificationManager.instance = new NotificationManager(context, historyState, sessionManager);
		}
		return NotificationManager.instance;
	}

	static getInstance(): NotificationManager {
		if (!NotificationManager.instance) {
			throw new Error('NotificationManager not initialized');
		}
		return NotificationManager.instance;
	}

	private handleRunUpdate(entry: HistoryEntry): void {
		const previous = this.lastRunStatus.get(entry.id);
		this.lastRunStatus.set(entry.id, entry.status);

		if (entry.status === previous) {
			return;
		}

		if (entry.status === 'completed' && this.settings.showJobComplete) {
			this.emitNotification({
				id: `run-complete-${entry.id}`,
				kind: 'success',
				title: `${this.formatRunType(entry.type)} complete`,
				message: this.formatStrategyLabel(entry.strategyPath),
				actions: [this.buildAction('View Results', 'quantlab.openHistoryEntry', [entry.id], true)]
			}, this.settings.playCompleteSound ? 'complete' : undefined);
		}

		if (entry.status === 'failed' && this.settings.showJobFailed) {
			this.emitNotification({
				id: `run-failed-${entry.id}`,
				kind: 'error',
				title: `${this.formatRunType(entry.type)} failed`,
				message: entry.errorMessage ?? this.formatStrategyLabel(entry.strategyPath),
				actions: [this.buildAction('View Logs', 'quantlab.openHistoryEntry', [entry.id], true)],
				persistent: true
			});
		}
	}

	private handleFill(_sessionId: string, fill: Fill): void {
		if (!this.settings.showTradeExecuted) {
			return;
		}

		const label = `${fill.symbol} ${fill.side.toUpperCase()} ${fill.quantity} @ $${fill.price.toFixed(2)}`;
		this.emitNotification({
			id: `fill-${fill.id}`,
			kind: 'success',
			title: 'Trade executed',
			message: label,
			actions: [this.buildAction('View Trade Panel', 'quantlab.focusTradePanel', [])]
		}, this.settings.playFillSound ? 'fill' : undefined);
	}

	private handleRiskAlert(sessionId: string, alert: RiskAlert): void {
		void sessionId;
		if (!this.settings.showRiskAlerts) {
			return;
		}

		this.emitNotification({
			id: `risk-${alert.id}`,
			kind: alert.level === 'critical' ? 'error' : 'warning',
			title: alert.level === 'critical' ? 'Critical risk alert' : 'Risk alert',
			message: alert.message,
			actions: [this.buildAction('View Trade Panel', 'quantlab.focusTradePanel', [])],
			persistent: alert.level === 'critical'
		}, this.settings.playAlertSound ? 'alert' : undefined);
	}

	private handleSessionStatus(session: SessionInfo): void {
		if (!this.settings.showSessionStatus) {
			return;
		}

		const previous = this.lastSessionStatus.get(session.id);
		this.lastSessionStatus.set(session.id, session.status);
		if (previous === session.status) {
			return;
		}

		if (session.status === 'running') {
			this.emitNotification({
				id: `session-start-${session.id}`,
				kind: 'info',
				title: `${session.type === 'paper' ? 'Paper' : 'Live'} session running`,
				message: this.formatStrategyLabel(session.strategyPath),
				actions: [this.buildAction('View Trade Panel', 'quantlab.focusTradePanel', [])]
			});
		}

		if (session.status === 'paused') {
			this.emitNotification({
				id: `session-paused-${session.id}`,
				kind: 'warning',
				title: 'Session paused',
				message: this.formatStrategyLabel(session.strategyPath)
			});
		}
	}

	private handleSessionStopped(sessionId: string, reason?: string): void {
		if (!this.settings.showSessionStatus) {
			return;
		}

		this.emitNotification({
			id: `session-stopped-${sessionId}`,
			kind: 'info',
			title: 'Session stopped',
			message: reason ?? 'Trading session ended'
		});
	}

	private emitNotification(notification: Omit<QuantlabNotification, 'createdAt'> & { createdAt?: number }, sound?: 'fill' | 'alert' | 'complete'): void {
		const fullNotification: QuantlabNotification = {
			...notification,
			createdAt: notification.createdAt ?? Date.now()
		};

		this.history.push(fullNotification);
		if (this.history.length > MAX_HISTORY) {
			this.history.splice(0, this.history.length - MAX_HISTORY);
		}

		const payload: QuantlabToastPayload = {
			id: fullNotification.id,
			kind: fullNotification.kind,
			title: fullNotification.title,
			message: fullNotification.message,
			actions: fullNotification.actions,
			durationMs: fullNotification.persistent || fullNotification.kind === 'error' ? 0 : 5000
		};

		void this.toastService.showToast(payload);

		if (sound && this.settings.soundEnabled) {
			void this.soundPlayer.play(sound);
		}
	}

	private buildAction(label: string, command: string, args: unknown[], primary = false): QuantlabNotificationAction {
		return {
			id: `${command}-${label.toLowerCase().replace(/\s+/g, '-')}`,
			label,
			command,
			args,
			primary
		};
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

	private formatStrategyLabel(path: string): string {
		return path.split(/[/\\]/).pop() ?? path;
	}

	private readSettings(): NotificationSettings {
		const config = vscode.workspace.getConfiguration('quantlab.notifications');
		return {
			showJobComplete: config.get('showJobComplete', true),
			showJobFailed: config.get('showJobFailed', true),
			showTradeExecuted: config.get('showTradeExecuted', true),
			showRiskAlerts: config.get('showRiskAlerts', true),
			showSessionStatus: config.get('showSessionStatus', true),
			soundEnabled: config.get('soundEnabled', false),
			playFillSound: config.get('playFillSound', false),
			playAlertSound: config.get('playAlertSound', false),
			playCompleteSound: config.get('playCompleteSound', false)
		};
	}
}
