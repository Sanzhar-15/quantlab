/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HistoryDropdown } from '../panels/history/HistoryDropdown';
import { HistoryState } from '../core/state/HistoryState';
import { EngineHost } from '../core/engine/EngineHost';

export function registerHistoryCommands(context: vscode.ExtensionContext): void {
	const dropdown = HistoryDropdown.getInstance();
	const historyState = HistoryState.getInstance();

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.toggleHistoryDropdown', () => dropdown.toggle()),
		vscode.commands.registerCommand('quantlab.openHistoryEntry', async (entryId?: string) => {
			if (!entryId) {
				return;
			}

			const entry = historyState.getEntry(entryId);
			if (!entry) {
				void vscode.window.showWarningMessage('Run not found.');
				return;
			}

			historyState.markAsViewed(entryId);
			await vscode.commands.executeCommand('quantlab.action.openRun', entryId);
		}),
		vscode.commands.registerCommand('quantlab.cancelHistoryRun', (entryId?: string) => {
			if (!entryId) {
				return;
			}
			// History entry ids ARE EngineHost job ids (ActionViewProvider seeds both from runId).
			const cancelled = EngineHost.getInstance().cancelJob(entryId);
			if (cancelled) {
				void vscode.window.showInformationMessage(`Run ${entryId} cancelled.`);
			} else {
				void vscode.window.showWarningMessage(`Run ${entryId} is not active -- nothing to cancel.`);
			}
		}),
		vscode.commands.registerCommand('quantlab.searchHistory', async () => {
			// CODEX-009: Implement actual history search
			const query = await vscode.window.showInputBox({
				prompt: 'Search history (strategy name, symbol, date)',
				placeHolder: 'e.g., "momentum" or "AAPL" or "2024-01"',
			});

			if (!query) {
				return;
			}

			const allEntries = historyState.query();
			const queryLower = query.toLowerCase();
			const results = allEntries.filter(entry => {
				const searchableFields = [
					entry.strategyPath ?? '',
					entry.type ?? '',
					entry.status ?? '',
					entry.id ?? '',
				].map(f => f.toLowerCase());

				return searchableFields.some(field => field.includes(queryLower));
			});

			if (results.length === 0) {
				void vscode.window.showInformationMessage(`No history entries matching "${query}"`);
				return;
			}

			const items = results.map(entry => ({
				label: entry.type ?? 'Unknown',
				description: `${entry.strategyPath ?? ''} | ${entry.startedAt?.toISOString() ?? ''}`,
				detail: `Status: ${entry.status ?? 'unknown'}`,
				entryId: entry.id,
			}));

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: `${results.length} results for "${query}"`,
				matchOnDescription: true,
				matchOnDetail: true,
			});

			if (selected) {
				await vscode.commands.executeCommand(
					'quantlab.action.openRun',
					selected.entryId
				);
			}
		})
	);
}
