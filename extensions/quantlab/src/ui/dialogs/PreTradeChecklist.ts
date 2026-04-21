/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pre-Trade Checklist Dialog.
 *
 * Validates strategy settings, risk limits, and confirms trading mode
 * before starting a live or paper trading session.
 */

import * as vscode from 'vscode';
import { SessionManager } from '../../core/trading/SessionManager';
import type { RequirementsCheck } from '../../types/trading';

/**
 * Checklist item status.
 */
export interface ChecklistItem {
	id: string;
	label: string;
	status: 'pass' | 'warn' | 'fail' | 'pending';
	message?: string;
	required: boolean;
}

/**
 * Pre-trade checklist result.
 */
export interface ChecklistResult {
	approved: boolean;
	items: ChecklistItem[];
	overriddenWarnings: string[];
}

/**
 * Session configuration for checklist validation.
 */
export interface PreTradeSessionConfig {
	strategyPath: string;
	symbol: string;
	timeframe: string;
	type: 'paper' | 'live';
	riskLimits?: {
		maxExposure?: number;
		maxPositionSize?: number;
		maxDailyLoss?: number;
	};
}

/**
 * Pre-Trade Checklist Dialog.
 */
export class PreTradeChecklist {
	private static instance: PreTradeChecklist | undefined;

	static getInstance(): PreTradeChecklist {
		if (!PreTradeChecklist.instance) {
			PreTradeChecklist.instance = new PreTradeChecklist();
		}
		return PreTradeChecklist.instance;
	}

	/**
	 * Show the pre-trade checklist dialog.
	 */
	async show(config: PreTradeSessionConfig): Promise<ChecklistResult> {
		const items = await this.buildChecklist(config);
		const hasFailures = items.some(item => item.status === 'fail' && item.required);
		const hasWarnings = items.some(item => item.status === 'warn');

		// If all required items pass and no warnings, auto-approve
		if (!hasFailures && !hasWarnings) {
			return { approved: true, items, overriddenWarnings: [] };
		}

		// Show dialog for user confirmation
		return this.showDialog(config, items);
	}

	/**
	 * Build the checklist items.
	 */
	private async buildChecklist(config: PreTradeSessionConfig): Promise<ChecklistItem[]> {
		const items: ChecklistItem[] = [];
		const sessionManager = SessionManager.getInstance();

		// 1. Strategy file exists and is readable
		items.push(await this.checkStrategyFile(config.strategyPath));

		// 2. Strategy requirements check
		const requirements = await sessionManager.getRequirementsCheck(config.strategyPath);
		items.push(this.checkRequirements(requirements));

		// 3. Risk limits configured
		items.push(this.checkRiskLimits(config));

		// 4. Trading mode confirmation
		items.push(this.checkTradingMode(config));

		// 5. Symbol validity
		items.push(this.checkSymbol(config.symbol));

		// 6. Market hours (warning only)
		items.push(await this.checkMarketHours());

		return items;
	}

	/**
	 * Check if strategy file exists.
	 */
	private async checkStrategyFile(strategyPath: string): Promise<ChecklistItem> {
		try {
			const uri = vscode.Uri.file(strategyPath);
			await vscode.workspace.fs.stat(uri);
			return {
				id: 'strategy-file',
				label: 'Strategy File',
				status: 'pass',
				message: 'Strategy file exists and is readable',
				required: true
			};
		} catch {
			return {
				id: 'strategy-file',
				label: 'Strategy File',
				status: 'fail',
				message: 'Strategy file not found or not readable',
				required: true
			};
		}
	}

	/**
	 * Check strategy requirements.
	 */
	private checkRequirements(requirements: RequirementsCheck): ChecklistItem {
		const issues: string[] = [];

		if (!requirements.validStrategy) {
			issues.push('Invalid strategy entrypoint');
		}
		if (!requirements.brokerConfigured) {
			issues.push('No broker configured');
		}

		if (issues.length === 0) {
			return {
				id: 'requirements',
				label: 'Strategy Requirements',
				status: 'pass',
				message: 'All strategy requirements met',
				required: true
			};
		}

		return {
			id: 'requirements',
			label: 'Strategy Requirements',
			status: 'fail',
			message: issues.join(', '),
			required: true
		};
	}

	/**
	 * Check risk limits configuration.
	 */
	private checkRiskLimits(config: PreTradeSessionConfig): ChecklistItem {
		const hasLimits = config.riskLimits &&
			(config.riskLimits.maxExposure !== undefined ||
			 config.riskLimits.maxPositionSize !== undefined ||
			 config.riskLimits.maxDailyLoss !== undefined);

		if (config.type === 'paper') {
			// Paper trading: risk limits optional but recommended
			return {
				id: 'risk-limits',
				label: 'Risk Limits',
				status: hasLimits ? 'pass' : 'warn',
				message: hasLimits ? 'Risk limits configured' : 'No risk limits set (recommended for paper trading)',
				required: false
			};
		}

		// Live trading: risk limits required
		if (!hasLimits) {
			return {
				id: 'risk-limits',
				label: 'Risk Limits',
				status: 'fail',
				message: 'Risk limits required for live trading',
				required: true
			};
		}

		return {
			id: 'risk-limits',
			label: 'Risk Limits',
			status: 'pass',
			message: `Max exposure: ${config.riskLimits?.maxExposure ?? 'N/A'}, Max position: ${config.riskLimits?.maxPositionSize ?? 'N/A'}, Max daily loss: ${config.riskLimits?.maxDailyLoss ?? 'N/A'}`,
			required: true
		};
	}

	/**
	 * Check trading mode.
	 */
	private checkTradingMode(config: PreTradeSessionConfig): ChecklistItem {
		if (config.type === 'paper') {
			return {
				id: 'trading-mode',
				label: 'Trading Mode',
				status: 'pass',
				message: 'Paper trading mode - no real money at risk',
				required: true
			};
		}

		return {
			id: 'trading-mode',
			label: 'Trading Mode',
			status: 'warn',
			message: 'LIVE TRADING - Real money at risk!',
			required: true
		};
	}

	/**
	 * Check symbol validity.
	 */
	private checkSymbol(symbol: string): ChecklistItem {
		if (!symbol || symbol.trim() === '') {
			return {
				id: 'symbol',
				label: 'Symbol',
				status: 'fail',
				message: 'No symbol specified',
				required: true
			};
		}

		// Basic symbol validation (alphanumeric, 1-10 chars)
		const isValid = /^[A-Z0-9]{1,10}$/i.test(symbol);
		if (!isValid) {
			return {
				id: 'symbol',
				label: 'Symbol',
				status: 'warn',
				message: `Symbol "${symbol}" may not be valid`,
				required: true
			};
		}

		return {
			id: 'symbol',
			label: 'Symbol',
			status: 'pass',
			message: `Trading ${symbol}`,
			required: true
		};
	}

	/**
	 * Check market hours.
	 */
	private async checkMarketHours(): Promise<ChecklistItem> {
		const now = new Date();
		const hour = now.getUTCHours();
		const dayOfWeek = now.getUTCDay();

		// Weekend check
		if (dayOfWeek === 0 || dayOfWeek === 6) {
			return {
				id: 'market-hours',
				label: 'Market Hours',
				status: 'warn',
				message: 'Markets are closed (weekend)',
				required: false
			};
		}

		// US market hours (9:30 AM - 4:00 PM ET, roughly 14:30 - 21:00 UTC)
		const isMarketOpen = hour >= 14 && hour < 21;
		if (!isMarketOpen) {
			return {
				id: 'market-hours',
				label: 'Market Hours',
				status: 'warn',
				message: 'US equity markets may be closed',
				required: false
			};
		}

		return {
			id: 'market-hours',
			label: 'Market Hours',
			status: 'pass',
			message: 'US equity markets are open',
			required: false
		};
	}

	/**
	 * Show the dialog and get user confirmation.
	 */
	private async showDialog(config: PreTradeSessionConfig, items: ChecklistItem[]): Promise<ChecklistResult> {
		const hasFailures = items.some(item => item.status === 'fail' && item.required);

		// If there are required failures, show error and deny
		if (hasFailures) {
			const failedItems = items.filter(item => item.status === 'fail' && item.required);
			const message = `Cannot start session:\n${failedItems.map(i => `- ${i.label}: ${i.message}`).join('\n')}`;
			await vscode.window.showErrorMessage(message, { modal: true });
			return { approved: false, items, overriddenWarnings: [] };
		}

		// Show warning dialog with checklist summary
		const warnings = items.filter(item => item.status === 'warn');
		const modeLabel = config.type === 'live' ? 'LIVE TRADING' : 'Paper Trading';

		let message = `Pre-Trade Checklist for ${modeLabel}\n\n`;
		message += items.map(item => {
			const icon = item.status === 'pass' ? '✓' : item.status === 'warn' ? '⚠' : '✗';
			return `${icon} ${item.label}: ${item.message ?? ''}`;
		}).join('\n');

		if (warnings.length > 0) {
			message += `\n\nWarnings:\n${warnings.map(w => `- ${w.message}`).join('\n')}`;
		}

		const confirm = config.type === 'live' ? 'Start Live Trading' : 'Start Paper Trading';
		const result = await vscode.window.showWarningMessage(
			message,
			{ modal: true },
			confirm,
			'Cancel'
		);

		if (result === confirm) {
			return {
				approved: true,
				items,
				overriddenWarnings: warnings.map(w => w.id)
			};
		}

		return { approved: false, items, overriddenWarnings: [] };
	}
}
