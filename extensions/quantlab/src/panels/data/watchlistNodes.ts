/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WatchlistItemNode, WatchlistNode } from './DataTreeProvider';

// HOST review (F-HOST-WATCHLIST-SYNC-1, PLAN-FINAL section 3.5 rule 2): `quantlab.watchlist.rename`, `.delete` and `.removeSymbol`
// are public commands, so their argument is caller-controlled; each can end in an authorised server request (the debounced
// push, or the server delete). They take only a node object DataTreeProvider rendered: VS Code hands a context-menu command
// the tree element object itself, so object identity is the carrier. A caller-shaped look-alike (same nodeKind, ids, symbol)
// is refused by a named error before any input box, modal, Memento write or sync.
//
// F-HOST-WATCHLIST-SYNC-2 (c1 M1): identity is not provenance. VS Code also hands that same element object to another
// extension's menu command on this view, and that extension can mutate it. So marking takes a frozen snapshot of the
// target when the tree renders the node, and the resolvers return that snapshot, never a field of the argument. The
// commands act on the snapshot only, and only after the user accepts a QuantLab modal naming it. The snapshots and the
// name index are private to this module and are never part of the extension's exported API.

/** The watchlist a rendered watchlist node named when the tree rendered it. */
export interface WatchlistTarget {
	readonly id: string;
	readonly name: string;
	readonly symbolCount: number;
}

/** The watchlist symbol a rendered watchlist-item node named when the tree rendered it. */
export interface WatchlistItemTarget {
	readonly watchlistId: string;
	readonly watchlistName: string;
	readonly symbol: string;
}

type RenderedSnapshot =
	| { readonly kind: 'watchlist'; readonly target: WatchlistTarget }
	| { readonly kind: 'watchlistItem'; readonly target: WatchlistItemTarget };

const renderedSnapshots = new WeakMap<object, RenderedSnapshot>();

// Watchlist id -> name as last rendered. An item node carries only its list id; the tree renders a list's node before
// its items, so the item snapshot takes the list name from here.
const renderedWatchlistNames = new Map<string, string>();

function snapshotOf(node: WatchlistNode | WatchlistItemNode): RenderedSnapshot {
	if (node.nodeKind === 'watchlist') {
		const target: WatchlistTarget = Object.freeze({
			id: node.watchlist.id,
			name: node.watchlist.name,
			symbolCount: node.watchlist.symbols.length,
		});
		renderedWatchlistNames.set(target.id, target.name);
		return Object.freeze({ kind: 'watchlist' as const, target });
	}
	const watchlistName = renderedWatchlistNames.get(node.watchlistId);
	if (watchlistName === undefined) {
		throw new Error(`watchlist item '${node.symbol}' cannot be marked: its watchlist '${node.watchlistId}' was not rendered by the QuantLab data tree first`);
	}
	const target: WatchlistItemTarget = Object.freeze({
		watchlistId: node.watchlistId,
		watchlistName,
		symbol: node.symbol,
	});
	return Object.freeze({ kind: 'watchlistItem' as const, target });
}

/** Records a frozen snapshot of a watchlist or watchlist-item node DataTreeProvider is about to return; returns the same object. */
export function markRenderedWatchlistNode<T extends WatchlistNode | WatchlistItemNode>(node: T): T {
	renderedSnapshots.set(node, snapshotOf(node));
	return node;
}

function refusal(command: string, kind: 'watchlist' | 'watchlistItem', got: string): Error {
	return new Error(`${command} refused: its argument is not a ${kind} node rendered by the QuantLab data tree (got ${got})`);
}

function renderedSnapshot(command: string, kind: 'watchlist' | 'watchlistItem', node: unknown): RenderedSnapshot {
	if (typeof node !== 'object' || node === null) {
		throw refusal(command, kind, typeof node);
	}
	const snapshot = renderedSnapshots.get(node);
	if (snapshot === undefined) {
		throw refusal(command, kind, typeof node);
	}
	return snapshot;
}

/** The snapshot of the rendered watchlist node a rename/delete was invoked on; throws a named error for anything the data tree did not render. */
export function resolveRenderedWatchlistNode(command: 'quantlab.watchlist.rename' | 'quantlab.watchlist.delete', node: unknown): WatchlistTarget {
	const snapshot = renderedSnapshot(command, 'watchlist', node);
	if (snapshot.kind !== 'watchlist') {
		throw refusal(command, 'watchlist', `a rendered '${snapshot.kind}' node`);
	}
	return snapshot.target;
}

/** The snapshot of the rendered watchlist-item node a removeSymbol was invoked on; throws a named error for anything the data tree did not render. */
export function resolveRenderedWatchlistItemNode(command: 'quantlab.watchlist.removeSymbol', node: unknown): WatchlistItemTarget {
	const snapshot = renderedSnapshot(command, 'watchlistItem', node);
	if (snapshot.kind !== 'watchlistItem') {
		throw refusal(command, 'watchlistItem', `a rendered '${snapshot.kind}' node`);
	}
	return snapshot.target;
}
