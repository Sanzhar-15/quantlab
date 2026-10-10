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
 *
 * Another extension's menu command on this view can receive (and mutate) the
 * same rendered node, so the resolver returns a frozen snapshot taken at
 * render time, and each command acts only after the user accepts a QuantLab
 * modal naming that snapshot, using the snapshot's ids only; a dismissed or
 * cancelled modal writes nothing and sends nothing (F-HOST-WATCHLIST-SYNC-2).
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
			const target = resolveRenderedWatchlistNode('quantlab.watchlist.rename', node);
			const name = await vscode.window.showInputBox({
				prompt: `Rename watchlist "${target.name}"`,
				value: target.name,
				validateInput: value => value.trim() ? undefined : 'Watchlist name is required'
			});
			if (name === undefined) {
				return; // user cancelled
			}
			const newName = name.trim();
			const choice = await vscode.window.showWarningMessage(
				`Rename watchlist "${target.name}" to "${newName}"?`,
				{ modal: true },
				'Rename'
			);
			if (choice !== 'Rename') {
				return; // dismissed or cancelled: nothing is written or sent
			}
			watchlistManager.renameWatchlist(target.id, newName);
		}),

		vscode.commands.registerCommand('quantlab.watchlist.delete', async (node: unknown) => {
			const target = resolveRenderedWatchlistNode('quantlab.watchlist.delete', node);
			const choice = await vscode.window.showWarningMessage(
				`Delete watchlist "${target.name}" (${target.symbolCount} symbols)?`,
				{ modal: true },
				'Delete'
			);
			if (choice !== 'Delete') {
				return; // dismissed or cancelled: nothing is written or sent
			}
			watchlistManager.removeWatchlist(target.id);
		}),

		vscode.commands.registerCommand('quantlab.watchlist.removeSymbol', async (node: unknown) => {
			const target = resolveRenderedWatchlistItemNode('quantlab.watchlist.removeSymbol', node);
			const choice = await vscode.window.showWarningMessage(
				`Remove "${target.symbol}" from watchlist "${target.watchlistName}"?`,
				{ modal: true },
				'Remove'
			);
			if (choice !== 'Remove') {
				return; // dismissed or cancelled: nothing is written or sent
			}
			watchlistManager.removeSymbol(target.watchlistId, target.symbol);
		}),
	);
}
