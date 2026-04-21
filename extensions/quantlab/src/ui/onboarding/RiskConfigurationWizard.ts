/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Risk Configuration Wizard (FIX-CGP-013).
 *
 * First-run wizard for configuring risk limits before trading.
 */

import * as vscode from 'vscode';

export class RiskConfigurationWizard {
	static async shouldShow(): Promise<boolean> {
		const config = vscode.workspace.getConfiguration('quantlab');
		return !config.get<boolean>('onboarding.riskConfigured', false);
	}

	static async show(): Promise<boolean> {
		const proceed = await vscode.window.showInformationMessage(
			'Welcome to Quantlab! Before trading, please configure your risk limits.',
			'Configure Now', 'Skip (Use Defaults)'
		);

		if (proceed === 'Skip (Use Defaults)') {
			await this.markCompleted();
			return true;
		}

		if (!proceed) {
			return false;
		}

		const dailyLoss = await vscode.window.showInputBox({
			prompt: 'Maximum daily loss as percentage of equity (e.g., 2 for 2%)',
			value: '2',
			validateInput: (v) => {
				const n = parseFloat(v);
				if (isNaN(n) || n <= 0 || n > 100) {
					return 'Enter a number between 0 and 100';
				}
				return null;
			},
		});
		if (!dailyLoss) { return false; }

		const maxDD = await vscode.window.showInputBox({
			prompt: 'Maximum drawdown percentage (e.g., 5 for 5%)',
			value: '5',
			validateInput: (v) => {
				const n = parseFloat(v);
				if (isNaN(n) || n <= 0 || n > 100) {
					return 'Enter a number between 0 and 100';
				}
				return null;
			},
		});
		if (!maxDD) { return false; }

		const consLoss = await vscode.window.showInputBox({
			prompt: 'Maximum consecutive losing trades before halt',
			value: '3',
			validateInput: (v) => {
				const n = parseInt(v);
				if (isNaN(n) || n < 1 || n > 50) {
					return 'Enter a number between 1 and 50';
				}
				return null;
			},
		});
		if (!consLoss) { return false; }

		const tradingConfig = vscode.workspace.getConfiguration('quantlab.trading');
		await tradingConfig.update('dailyLossLimitPercent', parseFloat(dailyLoss) / 100, true);
		await tradingConfig.update('maxDrawdownPercent', parseFloat(maxDD) / 100, true);
		await tradingConfig.update('consecutiveLossLimit', parseInt(consLoss), true);

		await this.markCompleted();
		void vscode.window.showInformationMessage(
			`Risk limits configured: ${dailyLoss}% daily loss, ${maxDD}% max drawdown, ${consLoss} consecutive losses`
		);
		return true;
	}

	private static async markCompleted(): Promise<void> {
		const config = vscode.workspace.getConfiguration('quantlab');
		await config.update('onboarding.riskConfigured', true, true);
	}
}
