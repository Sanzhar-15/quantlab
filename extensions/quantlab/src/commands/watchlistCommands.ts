/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { resolveRenderedWatchlistItemNode, resolveRenderedWatchlistNode } from '../panels/data/watchlistNodes';
import { WatchlistManager } from '../panels/data/WatchlistManager';

/**
 * Watchlist CRUD commands (megaudit H1: WatchlistManager implemented
 * add/rename/remove/removeSymbol but nothing in the UI could reach them).
 *
 * The rename/delete/removeSymbol commands are tree-context-menu commands:
 * VS Code passes the right-clicked tree element as the first argument. They
 * are hidden from the Command Palette in package.json because they are
 * meaningless without a tree selection. They are still public commands, so
 * each first resolves its argument to a node the data tree rendered
 * (watchlistNodes.ts) and is refused with a named error otherwise, before
 * any input box, modal or WatchlistManager call (F-HOST-WATCHLIST-SYNC-1).
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

		vscode.commands.registerCommand('quantlab.watchlist.rename', async (node: unknown) => {
			const rendered = resolveRenderedWatchlistNode('quantlab.watchlist.rename', node);
			const name = await vscode.window.showInputBox({
				prompt: `Rename watchlist "${rendered.watchlist.name}"`,
				value: rendered.watchlist.name,
				validateInput: value => value.trim() ? undefined : 'Watchlist name is required'
			});
			if (name === undefined) {
				return; // user cancelled
			}
			watchlistManager.renameWatchlist(rendered.watchlist.id, name);
		}),

		vscode.commands.registerCommand('quantlab.watchlist.delete', async (node: unknown) => {
			const rendered = resolveRenderedWatchlistNode('quantlab.watchlist.delete', node);
			const choice = await vscode.window.showWarningMessage(
				`Delete watchlist "${rendered.watchlist.name}" (${rendered.watchlist.symbols.length} symbols)?`,
				{ modal: true },
				'Delete'
			);
			if (choice !== 'Delete') {
				return;
			}
			watchlistManager.removeWatchlist(rendered.watchlist.id);
		}),

		vscode.commands.registerCommand('quantlab.watchlist.removeSymbol', (node: unknown) => {
			const rendered = resolveRenderedWatchlistItemNode('quantlab.watchlist.removeSymbol', node);
			watchlistManager.removeSymbol(rendered.watchlistId, rendered.symbol);
		}),
	);
}
