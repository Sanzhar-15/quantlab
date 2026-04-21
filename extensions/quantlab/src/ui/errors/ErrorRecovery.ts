/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { QuantlabError, QuantlabRecoveryAction } from '../../types/errors';
import { TradeErrorState } from '../../types/trading';
import { ToastService } from '../notifications/ToastService';

const DEDUPE_WINDOW_MS = 5000;

export class ErrorRecovery {
	private static instance: ErrorRecovery | undefined;

	private readonly recent = new Map<string, number>();
	private readonly toastService = new ToastService();

	private constructor(_context: vscode.ExtensionContext) {
		void _context;
	}

	static initialize(context: vscode.ExtensionContext): ErrorRecovery {
		if (!ErrorRecovery.instance) {
			ErrorRecovery.instance = new ErrorRecovery(context);
		}
		return ErrorRecovery.instance;
	}

	static getInstance(): ErrorRecovery {
		if (!ErrorRecovery.instance) {
			throw new Error('ErrorRecovery not initialized');
		}
		return ErrorRecovery.instance;
	}

	async report(error: QuantlabError): Promise<void> {
		if (this.isDuplicate(error)) {
			return;
		}

		if (error.severity === 'critical') {
			const labels = error.actions?.map(action => action.label) ?? [];
			const selection = await vscode.window.showErrorMessage(error.message, { modal: true }, ...labels);
			if (selection && error.actions) {
				const action = error.actions.find(item => item.label === selection);
				if (action?.command) {
					await vscode.commands.executeCommand(action.command, ...(action.args ?? []));
				}
			}
			return;
		}

		await this.toastService.showToast({
			id: error.id,
			kind: error.severity === 'warning' ? 'warning' : 'error',
			title: error.message,
			message: error.detail,
			actions: error.actions,
			durationMs: 5000
		});
	}

	buildTradeError(sessionId: string, error: TradeErrorState): QuantlabError {
		const actions: QuantlabRecoveryAction[] = [
			{
				id: 'trade-logs',
				label: 'View Logs',
				command: 'quantlab.trade.openLogs',
				args: [sessionId]
			}
		];

		if (error.recoverable) {
			actions.push(
				{
					id: 'trade-retry',
					label: 'Retry',
					command: 'quantlab.trade.retrySession',
					args: [sessionId],
					primary: true
				},
				{
					id: 'trade-settings',
					label: 'Open Broker Settings',
					command: 'quantlab.openBrokerSettings',
					args: []
				}
			);
		} else {
			actions.push({
				id: 'trade-restart',
				label: 'Restart Session',
				command: 'quantlab.trade.restartSession',
				args: [sessionId],
				primary: true
			});
		}

		return {
			id: `trade-${sessionId}-${error.code}`,
			source: 'trade',
			code: error.code,
			message: error.message,
			detail: error.detail,
			severity: error.recoverable ? 'warning' : 'error',
			actions,
			createdAt: Date.now()
		};
	}

	private isDuplicate(error: QuantlabError): boolean {
		const key = `${error.source}:${error.code}:${error.context ? JSON.stringify(error.context) : ''}`;
		const now = Date.now();
		const last = this.recent.get(key);
		this.recent.set(key, now);
		if (!last) {
			return false;
		}
		return now - last < DEDUPE_WINDOW_MS;
	}
}
