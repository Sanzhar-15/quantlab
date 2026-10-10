/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { ServerDataSource } from '../../types/market';

// HOST review c1 M1: `quantlab.openServerSymbol` is a public command, so its arguments are caller-controlled. It takes only
// an opaque handle that DataTreeProvider minted for an item it rendered; a symbol, a display name or a forged handle is
// refused before any state changes (no server request can follow from it). The map is private to this module and is never
// part of the extension's exported API.

const sourcesByHandle = new Map<string, ServerDataSource>();
const handlesByKey = new Map<string, string>();

/**
 * The display name of an ETF or index item. The server contract has no name for some of them (`EtfItem.name` and
 * `IndexItem.name` are optional, core/server/ServerApiClient.ts:114 and :123); such an item is labelled by its ticker.
 */
export function etfOrIndexDisplayName(ticker: string, name: string | undefined): string {
	if (name === undefined) {
		return ticker;
	}

	return name;
}

/** Mints (or returns the existing) handle for a server symbol the data tree renders. */
export function mintServerSymbolHandle(symbol: string, displayName: string, assetClass?: string): string {
	const key = JSON.stringify([symbol, displayName, assetClass ?? null]);
	const existing = handlesByKey.get(key);
	if (existing) {
		return existing;
	}

	const handle = randomUUID();
	handlesByKey.set(key, handle);
	sourcesByHandle.set(handle, { kind: 'server', symbol, displayName, assetClass });
	return handle;
}

/** The server source a minted handle stands for; throws a named error for anything DataTreeProvider did not mint. */
export function resolveServerSymbolHandle(handle: unknown): ServerDataSource {
	const source = typeof handle === 'string' ? sourcesByHandle.get(handle) : undefined;
	if (!source) {
		throw new Error(`quantlab.openServerSymbol refused: its argument is not a handle minted by the QuantLab data tree (got ${typeof handle})`);
	}

	return source;
}
