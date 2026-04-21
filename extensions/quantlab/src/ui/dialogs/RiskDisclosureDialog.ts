/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Risk Disclosure Dialog (NEW-UI-001).
 *
 * Shows a formal risk acknowledgment before first live trade.
 */

import * as vscode from 'vscode';

const RISK_DISCLOSURE_TEXT =
	'RISK DISCLOSURE: Trading financial instruments involves substantial risk of loss. ' +
	'By proceeding, you acknowledge: (1) You understand the risks of algorithmic trading, ' +
	'(2) You have tested your strategy in paper trading mode, ' +
	'(3) You accept full responsibility for trading decisions made by your strategy, ' +
	'(4) Past backtest performance does not guarantee future results.';

export class RiskDisclosureDialog {
	static async show(context: vscode.ExtensionContext): Promise<boolean> {
		const acknowledged = context.globalState.get<boolean>(
			'quantlab.riskDisclosure.acknowledged', false
		);
		if (acknowledged) {
			return true;
		}

		const result = await vscode.window.showWarningMessage(
			RISK_DISCLOSURE_TEXT,
			{ modal: true },
			'I Acknowledge the Risks',
			'Cancel'
		);

		if (result === 'I Acknowledge the Risks') {
			await context.globalState.update('quantlab.riskDisclosure.acknowledged', true);
			await context.globalState.update(
				'quantlab.riskDisclosure.acknowledgedAt',
				new Date().toISOString()
			);
			return true;
		}

		return false;
	}
}
