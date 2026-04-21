/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HistoryEntry } from '../../types/history';
import { QuantlabNotificationAction } from '../../types/notifications';
import { HistoryState } from '../../core/state/HistoryState';
import { ToastService } from '../notifications/ToastService';
import { OnboardingManager } from './OnboardingManager';

const TEN_RUNS_THRESHOLD = 10;

const TIP_IDS = {
	backtestComplete: 'tip.backtest.complete',
	parameterEdit: 'tip.parameter.edit',
	tradeChecklist: 'tip.trade.checklist',
	pinRuns: 'tip.history.pin'
};

export class FeatureDiscovery {
	private static instance: FeatureDiscovery | undefined;

	private readonly toastService = new ToastService();

	private constructor(
		private readonly onboarding: OnboardingManager,
		private readonly historyState: HistoryState
	) { }

	static resetInstance(): void {
		FeatureDiscovery.instance = undefined;
	}

	static initialize(
		context: vscode.ExtensionContext,
		onboarding: OnboardingManager,
		historyState: HistoryState
	): FeatureDiscovery {
		if (!FeatureDiscovery.instance) {
			const instance = new FeatureDiscovery(onboarding, historyState);
			FeatureDiscovery.instance = instance;

			context.subscriptions.push(
				historyState.onDidAdd(entry => instance.handleHistoryEntry(entry)),
				historyState.onDidUpdate(entry => instance.handleHistoryEntry(entry))
			);

			instance.maybeNotifyTenRuns();
		}

		return FeatureDiscovery.instance;
	}

	static getInstance(): FeatureDiscovery {
		if (!FeatureDiscovery.instance) {
			throw new Error('FeatureDiscovery not initialized');
		}
		return FeatureDiscovery.instance;
	}

	notifyParameterEdit(): void {
		this.showTip(
			TIP_IDS.parameterEdit,
			'Parameters updated',
			'Apply parameter changes back to your strategy code when you are ready.',
			[
				this.buildAction('apply-to-code', 'Apply to Code', 'quantlab.chart.applyParameters', [], true)
			]
		);
	}

	notifyTradeView(): void {
		this.showTip(
			TIP_IDS.tradeChecklist,
			'Trade checklist',
			'Complete the checklist in the Trade panel before going live.',
			[
				this.buildAction('open-trade-panel', 'Open Trade Panel', 'quantlab.focusTradePanel', [], true)
			]
		);
	}

	private handleHistoryEntry(entry: HistoryEntry): void {
		if (entry.type === 'backtest' && entry.status === 'completed') {
			this.showTip(
				TIP_IDS.backtestComplete,
				'Backtest complete',
				'Review the run artifacts in Chart view.',
				[
					this.buildAction('view-in-chart', 'View in Chart', 'quantlab.action.viewInChart', [entry.id], true)
				]
			);
		}

		this.maybeNotifyTenRuns();
	}

	private maybeNotifyTenRuns(): void {
		if (!this.onboarding.shouldShowTip(TIP_IDS.pinRuns)) {
			return;
		}

		const count = this.historyState.query().length;
		if (count < TEN_RUNS_THRESHOLD) {
			return;
		}

		this.showTip(
			TIP_IDS.pinRuns,
			'Pin important runs',
			'You have a growing history. Pin key runs to keep them handy.',
			[
				this.buildAction('open-history-panel', 'Open History Panel', 'quantlab.focusHistoryPanel', [], true)
			]
		);
	}

	private showTip(
		id: string,
		title: string,
		message: string,
		actions?: QuantlabNotificationAction[]
	): void {
		if (!this.onboarding.shouldShowTip(id)) {
			return;
		}

		void this.toastService.showToast({
			id,
			kind: 'info',
			title,
			message,
			actions,
			durationMs: 5000
		});

		this.onboarding.markTipDismissed(id);
	}

	private buildAction(id: string, label: string, command: string, args: unknown[], primary = false): QuantlabNotificationAction {
		return { id: `tip-${id}`, label, command, args, primary };
	}
}
