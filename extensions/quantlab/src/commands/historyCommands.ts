/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HistoryDropdown } from '../panels/history/HistoryDropdown';
import { HistoryState } from '../core/state/HistoryState';
import { EngineHost } from '../core/engine/EngineHost';
import { HistoryEntry } from '../types/history';

/**
 * Shape of the History tree's entry node as VS Code passes it to
 * view/item/context menu commands (M56). The same commands stay
 * callable with a plain entry-id string from code paths that already
 * do so (dropdown buttons, webview bridges).
 */
interface HistoryEntryTreeNodeArg {
	readonly type?: string;
	readonly entry?: HistoryEntry;
}

function resolveEntryId(arg?: string | HistoryEntryTreeNodeArg): string | undefined {
	if (typeof arg === 'string') {
		return arg;
	}
	if (arg && arg.type === 'entry' && arg.entry && typeof arg.entry.id === 'string') {
		return arg.entry.id;
	}
	return undefined;
}

export function registerHistoryCommands(context: vscode.ExtensionContext): void {
	const dropdown = HistoryDropdown.getInstance();
	const historyState = HistoryState.getInstance();

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.toggleHistoryDropdown', () => dropdown.toggle()),
		vscode.commands.registerCommand('quantlab.openHistoryEntry', async (arg?: string | HistoryEntryTreeNodeArg) => {
			const entryId = resolveEntryId(arg);
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
		vscode.commands.registerCommand('quantlab.cancelHistoryRun', (arg?: string | HistoryEntryTreeNodeArg) => {
			const entryId = resolveEntryId(arg);
			if (!entryId) {
				return;
			}
			// History entry ids ARE EngineHost job ids (ActionViewProvider seeds both from runId).
			const cancelled = EngineHost.getInstance().cancelJob(entryId);
			if (cancelled) {
				// Update HistoryState directly: the engine's terminal event only
				// reaches HistoryState through an OPEN Action tab, and the tab may
				// be closed when cancelling from the History dropdown/tree (H33).
				console.log(`historyCommands: run ${entryId} cancelled by user; marking history entry cancelled.`);
				historyState.updateEntry(entryId, { status: 'cancelled', completedAt: new Date(), errorMessage: 'Job cancelled by user.' });
				void vscode.window.showInformationMessage(`Run ${entryId} cancelled.`);
				return;
			}
			const entry = historyState.getEntry(entryId);
			if (entry && (entry.status === 'running' || entry.status === 'queued')) {
				// No live engine job but a non-terminal history status: the entry
				// is definitionally stale. Resolve it on the user's cancel request
				// instead of leaving a phantom running entry.
				console.warn(`historyCommands: run ${entryId} has no active engine job but history status '${entry.status}'; marking it cancelled.`);
				historyState.updateEntry(entryId, { status: 'cancelled', completedAt: new Date(), errorMessage: 'Cancelled (no active engine job).' });
				void vscode.window.showInformationMessage(`Run ${entryId} was not active -- marked cancelled.`);
				return;
			}
			void vscode.window.showWarningMessage(`Run ${entryId} is not active -- nothing to cancel.`);
		}),
		// M56: History-tree right-click wrappers. The tree passes its node
		// object; the existing quantlab.action.* commands take a string run
		// id and would silently misfire on a node, so resolve the id here
		// and delegate to the already-registered implementations.
		vscode.commands.registerCommand('quantlab.history.pinRun', async (arg?: string | HistoryEntryTreeNodeArg) => {
			const entryId = resolveEntryId(arg);
			if (!entryId) {
				console.warn('quantlab.history.pinRun: no history entry id in command argument; nothing to pin.');
				return;
			}
			await vscode.commands.executeCommand('quantlab.action.pinRun', entryId);
		}),
		vscode.commands.registerCommand('quantlab.history.addToCompare', async (arg?: string | HistoryEntryTreeNodeArg) => {
			const entryId = resolveEntryId(arg);
			if (!entryId) {
				console.warn('quantlab.history.addToCompare: no history entry id in command argument; nothing to add.');
				return;
			}
			await vscode.commands.executeCommand('quantlab.action.addToCompare', entryId);
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
