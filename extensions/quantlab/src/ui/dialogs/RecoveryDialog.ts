/*---------------------------------------------------------------------------------------------
 *  Recovery Dialog.
 *
 *  Prompts user when crashed sessions are detected with recovery options.
 *
 *  Spec Reference: Technical Spec §12.3 (Safety Layer)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Crashed session information.
 */
export interface CrashedSession {
	sessionId: string;
	strategyName: string;
	symbol: string;
	mode: 'paper' | 'live';
	lastHeartbeat: Date;
	positionCount: number;
	hasOpenOrders: boolean;
	checkpointPath: string;
}

/**
 * Recovery action options.
 */
export type RecoveryAction = 'reconnect' | 'flatten_close' | 'close_only' | 'ignore';

/**
 * Recovery dialog result.
 */
export interface RecoveryDialogResult {
	action: RecoveryAction;
	sessionId: string;
	cancelled: boolean;
}

/**
 * Shows recovery dialog for crashed sessions.
 *
 * This dialog appears when:
 * - VS Code restarts and finds orphaned daemon processes
 * - Daemon heartbeat times out
 * - Extension detects checkpoint files for sessions
 */
export async function showRecoveryDialog(
	crashedSessions: CrashedSession[]
): Promise<RecoveryDialogResult[]> {
	const results: RecoveryDialogResult[] = [];

	for (const session of crashedSessions) {
		const result = await showSingleSessionRecovery(session);
		results.push(result);

		// Stop if user explicitly cancels
		if (result.cancelled) {
			break;
		}
	}

	return results;
}

/**
 * Show recovery options for a single session.
 */
async function showSingleSessionRecovery(
	session: CrashedSession
): Promise<RecoveryDialogResult> {
	const modeLabel = session.mode === 'live' ? '(LIVE)' : '(Paper)';
	const positionWarning = session.positionCount > 0
		? `\n\nWARNING: ${session.positionCount} open position(s) detected!`
		: '';
	const orderWarning = session.hasOpenOrders
		? '\nWARNING: Has pending orders!'
		: '';

	// Message for future use if needed for information dialog
	const _message = vscode.l10n.t(
		'Crashed trading session detected:\n\n' +
		'Strategy: {0} {1}\n' +
		'Symbol: {2}\n' +
		'Last heartbeat: {3}' +
		'{4}{5}',
		session.strategyName,
		modeLabel,
		session.symbol,
		session.lastHeartbeat.toLocaleString(),
		positionWarning,
		orderWarning
	);
	void _message; // Suppress unused variable warning

	// Build options based on session state
	const options: vscode.QuickPickItem[] = [];

	// Reconnect option - always available
	options.push({
		label: '$(debug-continue) Reconnect to Session',
		description: 'Attempt to reconnect and resume trading',
		detail: 'Recommended if session is still valid',
	});

	// Flatten and close - only if has positions
	if (session.positionCount > 0) {
		options.push({
			label: '$(warning) Flatten All & Close',
			description: 'Close all positions and stop session',
			detail: session.mode === 'live'
				? 'CAUTION: Will execute market orders to close positions'
				: 'Will close simulated positions',
		});
	}

	// Close without flattening
	options.push({
		label: '$(close) Close Session',
		description: session.positionCount > 0
			? 'Stop session WITHOUT closing positions'
			: 'Stop the session',
		detail: session.positionCount > 0
			? 'WARNING: Positions will remain open at broker!'
			: 'Clean shutdown',
	});

	// Ignore option
	options.push({
		label: '$(pass) Ignore',
		description: 'Leave session state as-is',
		detail: 'You can recover later via command palette',
	});

	const selected = await vscode.window.showQuickPick(options, {
		title: vscode.l10n.t('Session Recovery: {0}', session.strategyName),
		placeHolder: vscode.l10n.t('Choose recovery action'),
		ignoreFocusOut: true,
	});

	if (!selected) {
		return {
			action: 'ignore',
			sessionId: session.sessionId,
			cancelled: true,
		};
	}

	// Map selection to action
	let action: RecoveryAction = 'ignore';
	if (selected.label.includes('Reconnect')) {
		action = 'reconnect';
	} else if (selected.label.includes('Flatten')) {
		// Confirm flatten for live sessions
		if (session.mode === 'live') {
			const confirmed = await confirmFlatten(session);
			if (!confirmed) {
				return showSingleSessionRecovery(session); // Re-show dialog
			}
		}
		action = 'flatten_close';
	} else if (selected.label.includes('Close Session')) {
		// Warn about open positions
		if (session.positionCount > 0 && session.mode === 'live') {
			const confirmed = await confirmCloseWithPositions(session);
			if (!confirmed) {
				return showSingleSessionRecovery(session);
			}
		}
		action = 'close_only';
	}

	return {
		action,
		sessionId: session.sessionId,
		cancelled: false,
	};
}

/**
 * Confirm flatten action for live sessions.
 */
async function confirmFlatten(session: CrashedSession): Promise<boolean> {
	const result = await vscode.window.showWarningMessage(
		vscode.l10n.t(
			'This will execute MARKET ORDERS to close {0} position(s) in LIVE trading.\n\n' +
			'Strategy: {1}\n' +
			'Symbol: {2}\n\n' +
			'Are you sure?',
			session.positionCount,
			session.strategyName,
			session.symbol
		),
		{ modal: true },
		vscode.l10n.t('Flatten All'),
		vscode.l10n.t('Cancel')
	);

	return result === vscode.l10n.t('Flatten All');
}

/**
 * Confirm closing session with open positions.
 */
async function confirmCloseWithPositions(session: CrashedSession): Promise<boolean> {
	const result = await vscode.window.showWarningMessage(
		vscode.l10n.t(
			'Closing this LIVE session will leave {0} position(s) open at the broker!\n\n' +
			'You will need to manage these positions manually.\n\n' +
			'Are you sure?',
			session.positionCount
		),
		{ modal: true },
		vscode.l10n.t('Close Anyway'),
		vscode.l10n.t('Cancel')
	);

	return result === vscode.l10n.t('Close Anyway');
}

/**
 * Show notification about recovered sessions.
 */
export async function showRecoveryNotification(
	recoveredCount: number,
	failedCount: number
): Promise<void> {
	if (recoveredCount > 0 && failedCount === 0) {
		vscode.window.showInformationMessage(
			vscode.l10n.t('Successfully recovered {0} trading session(s)', recoveredCount)
		);
	} else if (failedCount > 0) {
		const action = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'Recovered {0} session(s), but {1} failed to recover',
				recoveredCount,
				failedCount
			),
			vscode.l10n.t('View Details')
		);

		if (action === vscode.l10n.t('View Details')) {
			vscode.commands.executeCommand('quantlab.showRecoveryLog');
		}
	}
}

/**
 * Show startup recovery prompt if sessions need attention.
 */
export async function showStartupRecoveryPrompt(
	sessionCount: number
): Promise<boolean> {
	const result = await vscode.window.showWarningMessage(
		vscode.l10n.t(
			'{0} trading session(s) were running when VS Code closed.\n' +
			'Would you like to review and recover them?',
			sessionCount
		),
		{ modal: true },
		vscode.l10n.t('Review Sessions'),
		vscode.l10n.t('Ignore All')
	);

	return result === vscode.l10n.t('Review Sessions');
}
