/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DataNode } from '../panels/data/DataTreeProvider';
import { WatchlistManager } from '../panels/data/WatchlistManager';

/**
 * Watchlist CRUD commands (megaudit H1: WatchlistManager implemented
 * add/rename/remove/removeSymbol but nothing in the UI could reach them).
 *
 * The rename/delete/removeSymbol commands are tree-context-menu commands:
 * VS Code passes the right-clicked tree element as the first argument. They
 * are hidden from the Command Palette in package.json because they are
 * meaningless without a tree selection.
 */
export function registerWatchlistCommands(context: vscode.ExtensionContext, watchlistManager: WatchlistManager): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.watchlist.create', async () => {
			const name = await vscode.window.showInputBox({
				prompt: 'Name for the new watchlist',
				placeHolder: 'e.g. Tech Leaders',
				validateInput: value => value.trim() ? undefined : 'Watchlist name is required'
			});
			if (name === undefined) {
				return; // user cancelled
			}
			watchlistManager.addWatchlist(name);
		}),

		vscode.commands.registerCommand('quantlab.watchlist.rename', async (node?: DataNode) => {
			if (!node || node.nodeKind !== 'watchlist') {
				void vscode.window.showErrorMessage('Rename Watchlist: right-click a watchlist in the Data panel.');
				return;
			}
			const name = await vscode.window.showInputBox({
				prompt: `Rename watchlist "${node.watchlist.name}"`,
				value: node.watchlist.name,
				validateInput: value => value.trim() ? undefined : 'Watchlist name is required'
			});
			if (name === undefined) {
				return; // user cancelled
			}
			watchlistManager.renameWatchlist(node.watchlist.id, name);
		}),

		vscode.commands.registerCommand('quantlab.watchlist.delete', async (node?: DataNode) => {
			if (!node || node.nodeKind !== 'watchlist') {
				void vscode.window.showErrorMessage('Delete Watchlist: right-click a watchlist in the Data panel.');
				return;
			}
			const choice = await vscode.window.showWarningMessage(
				`Delete watchlist "${node.watchlist.name}" (${node.watchlist.symbols.length} symbols)?`,
				{ modal: true },
				'Delete'
			);
			if (choice !== 'Delete') {
				return;
			}
			watchlistManager.removeWatchlist(node.watchlist.id);
		}),

		vscode.commands.registerCommand('quantlab.watchlist.removeSymbol', (node?: DataNode) => {
			if (!node || node.nodeKind !== 'watchlistItem') {
				void vscode.window.showErrorMessage('Remove from Watchlist: right-click a symbol inside a watchlist in the Data panel.');
				return;
			}
			watchlistManager.removeSymbol(node.watchlistId, node.symbol);
		}),
	);
}
