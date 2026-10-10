/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WatchlistItemNode, WatchlistNode } from './DataTreeProvider';

// HOST review (F-HOST-WATCHLIST-SYNC-1, PLAN-FINAL §3.5 rule 2): `quantlab.watchlist.rename`, `.delete` and `.removeSymbol`
// are public commands, so their argument is caller-controlled; each can end in an authorised server request (the debounced
// push, or the server delete). They take only a node object DataTreeProvider rendered: VS Code hands a context-menu command
// the tree element object itself, so object identity is the carrier. A caller-shaped look-alike (same nodeKind, ids, symbol)
// is refused by a named error before any input box, modal, Memento write or sync. The set is private to this module and is
// never part of the extension's exported API.

const renderedNodes = new WeakSet<object>();

/** Records a watchlist or watchlist-item node DataTreeProvider is about to return; returns the same object. */
export function markRenderedWatchlistNode<T extends WatchlistNode | WatchlistItemNode>(node: T): T {
	renderedNodes.add(node);
	return node;
}

function resolveRendered(command: string, kind: 'watchlist' | 'watchlistItem', node: unknown): WatchlistNode | WatchlistItemNode {
	if (typeof node !== 'object' || node === null || !renderedNodes.has(node)) {
		throw new Error(`${command} refused: its argument is not a ${kind} node rendered by the QuantLab data tree (got ${typeof node})`);
	}
	// Only markRenderedWatchlistNode adds to the set, and it accepts only these two node types.
	const rendered = node as WatchlistNode | WatchlistItemNode;
	if (rendered.nodeKind !== kind) {
		throw new Error(`${command} refused: its argument is not a ${kind} node rendered by the QuantLab data tree (got a rendered '${rendered.nodeKind}' node)`);
	}
	return rendered;
}

/** The rendered watchlist node a rename/delete was invoked on; throws a named error for anything the data tree did not render. */
export function resolveRenderedWatchlistNode(command: 'quantlab.watchlist.rename' | 'quantlab.watchlist.delete', node: unknown): WatchlistNode {
	return resolveRendered(command, 'watchlist', node) as WatchlistNode;
}

/** The rendered watchlist-item node a removeSymbol was invoked on; throws a named error for anything the data tree did not render. */
export function resolveRenderedWatchlistItemNode(command: 'quantlab.watchlist.removeSymbol', node: unknown): WatchlistItemNode {
	return resolveRendered(command, 'watchlistItem', node) as WatchlistItemNode;
}
