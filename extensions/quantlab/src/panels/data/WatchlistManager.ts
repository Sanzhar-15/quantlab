/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ServerApiClient, ServerWatchlist } from '../../core/server/ServerApiClient';

const STORAGE_KEY = 'quantlab.watchlists';

export interface Watchlist {
	id: string;
	name: string;
	symbols: string[];
	isDefault?: boolean;
	sortOrder?: number;
	serverId?: string; // Maps to server watchlist ID
}

export class WatchlistManager {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private watchlists: Watchlist[] = [];
	private pendingPersist: NodeJS.Timeout | undefined;
	private pendingServerSync: NodeJS.Timeout | undefined;
	private serverSyncEnabled: boolean = true;
	private serverSyncPromise: Promise<void> | null = null;
	private localVersion: number = 0; // Track local changes

	constructor(private readonly context: vscode.ExtensionContext) {
		this.watchlists = this.restore();
		// Sync with server on initialization (non-blocking)
		void this.syncFromServer();
	}

	getWatchlists(): Watchlist[] {
		return this.watchlists.map(list => ({ ...list, symbols: [...list.symbols] }));
	}

	addWatchlist(name: string): Watchlist {
		const watchlist: Watchlist = {
			id: this.createId(),
			name: name.trim() || 'Watchlist',
			symbols: []
		};
		this.watchlists = [...this.watchlists, watchlist];
		this.localVersion++;
		this.persistSoon();
		this._onDidChange.fire();
		return watchlist;
	}

	renameWatchlist(id: string, name: string): void {
		this.watchlists = this.watchlists.map(list => list.id === id ? { ...list, name: name.trim() || list.name } : list);
		this.localVersion++;
		this.persistSoon();
		this._onDidChange.fire();
	}

	removeWatchlist(id: string): void {
		const watchlist = this.watchlists.find(list => list.id === id);
		if (watchlist?.serverId) {
			// Delete from server asynchronously
			void this.deleteWatchlistOnServer(watchlist.serverId);
		}
		this.watchlists = this.watchlists.filter(list => list.id !== id);
		this.localVersion++;
		this.persistSoon();
		this._onDidChange.fire();
	}

	addSymbol(id: string, symbol: string): void {
		const normalized = symbol.trim().toUpperCase();
		if (!normalized) {
			return;
		}

		let changed = false;
		this.watchlists = this.watchlists.map(list => {
			if (list.id !== id) {
				return list;
			}

			if (list.symbols.includes(normalized)) {
				return list;
			}

			changed = true;
			return { ...list, symbols: [...list.symbols, normalized] };
		});

		if (changed) {
			this.localVersion++;
			this.persistSoon();
			this._onDidChange.fire();
		}
	}

	removeSymbol(id: string, symbol: string): void {
		const normalized = symbol.trim().toUpperCase();
		let changed = false;
		this.watchlists = this.watchlists.map(list => {
			if (list.id !== id) {
				return list;
			}

			const newSymbols = list.symbols.filter(item => item !== normalized);
			if (newSymbols.length !== list.symbols.length) {
				changed = true;
			}
			return { ...list, symbols: newSymbols };
		});

		if (changed) {
			this.localVersion++;
			this.persistSoon();
			this._onDidChange.fire();
		}
	}

	private restore(): Watchlist[] {
		const stored = this.context.globalState.get<Watchlist[]>(STORAGE_KEY, []);
		if (!Array.isArray(stored)) {
			return [];
		}

		return stored.map(list => ({
			id: list.id ?? this.createId(),
			name: list.name ?? 'Watchlist',
			symbols: Array.isArray(list.symbols) ? list.symbols.map(symbol => symbol.toUpperCase()) : []
		}));
	}

	private persistSoon(): void {
		if (this.pendingPersist) {
			clearTimeout(this.pendingPersist);
		}

		this.pendingPersist = setTimeout(() => {
			this.pendingPersist = undefined;
			void this.context.globalState.update(STORAGE_KEY, this.watchlists);
			// Schedule server sync after local persist
			this.scheduleServerSync();
		}, 200);
	}

	private createId(): string {
		return `watchlist-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	// Server synchronization methods
	async syncFromServer(): Promise<void> {
		if (!this.serverSyncEnabled) {
			return;
		}

		// If sync is already in progress, wait for it
		if (this.serverSyncPromise) {
			return this.serverSyncPromise;
		}

		this.serverSyncPromise = this.doSyncFromServer();

		try {
			await this.serverSyncPromise;
		} finally {
			this.serverSyncPromise = null;
		}
	}

	private async doSyncFromServer(): Promise<void> {
		// Capture local version before sync
		const versionBeforeSync = this.localVersion;

		try {
			const client = ServerApiClient.getInstance();
			const serverWatchlists = await client.getWatchlists();

			// Check if local changes occurred during fetch
			if (this.localVersion !== versionBeforeSync) {
				// Local changes happened during sync — schedule deferred re-sync
				setTimeout(() => void this.syncFromServer(), 2000);
				return;
			}

			// Merge server watchlists with local ones
			const mergedWatchlists = this.mergeWatchlists(serverWatchlists);

			if (this.hasWatchlistsChanged(mergedWatchlists)) {
				this.watchlists = mergedWatchlists;
				await this.context.globalState.update(STORAGE_KEY, this.watchlists);
				this._onDidChange.fire();
			}
		} catch (error) {
			// Log for debugging but don't interrupt - offline mode will use local watchlists
			const message = error instanceof Error ? error.message : String(error);
			console.debug(`WatchlistManager: Server sync failed - ${message}`);
		}
	}

	private mergeWatchlists(serverWatchlists: ServerWatchlist[]): Watchlist[] {
		const result: Watchlist[] = [];
		const localByServerId = new Map<string, Watchlist>();

		// Index local watchlists by server ID
		for (const local of this.watchlists) {
			if (local.serverId) {
				localByServerId.set(local.serverId, local);
			}
		}

		// Process server watchlists
		for (const server of serverWatchlists) {
			const local = localByServerId.get(server.id);
			if (local) {
				// Update existing local watchlist with server data
				result.push({
					...local,
					name: server.name,
					symbols: server.symbols.map(s => s.toUpperCase()),
					isDefault: server.is_default,
					sortOrder: server.sort_order,
					serverId: server.id
				});
				localByServerId.delete(server.id);
			} else {
				// Create new local watchlist from server
				result.push({
					id: this.createId(),
					name: server.name,
					symbols: server.symbols.map(s => s.toUpperCase()),
					isDefault: server.is_default,
					sortOrder: server.sort_order,
					serverId: server.id
				});
			}
		}

		// Keep local-only watchlists (not on server)
		for (const local of this.watchlists) {
			if (!local.serverId) {
				result.push(local);
			}
		}

		// Sort by sortOrder (server watchlists first), then local watchlists
		result.sort((a, b) => {
			if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
				return a.sortOrder - b.sortOrder;
			}
			if (a.sortOrder !== undefined) { return -1; }
			if (b.sortOrder !== undefined) { return 1; }
			return 0;
		});

		return result;
	}

	private hasWatchlistsChanged(newWatchlists: Watchlist[]): boolean {
		if (this.watchlists.length !== newWatchlists.length) {
			return true;
		}

		for (let i = 0; i < this.watchlists.length; i++) {
			const old = this.watchlists[i];
			const updated = newWatchlists[i];
			if (old.id !== updated.id ||
				old.name !== updated.name ||
				old.symbols.length !== updated.symbols.length ||
				old.symbols.some((s, j) => s !== updated.symbols[j])) {
				return true;
			}
		}

		return false;
	}

	private scheduleServerSync(): void {
		if (!this.serverSyncEnabled) {
			return;
		}

		if (this.pendingServerSync) {
			clearTimeout(this.pendingServerSync);
		}

		// Debounce server sync to avoid too many requests
		this.pendingServerSync = setTimeout(() => {
			this.pendingServerSync = undefined;
			void this.syncToServer();
		}, 1000);
	}

	private async syncToServer(): Promise<void> {
		if (!this.serverSyncEnabled || this.serverSyncPromise) {
			return;
		}

		try {
			const client = ServerApiClient.getInstance();
			let hasChanges = false;

			// Snapshot version before async work — used to detect concurrent user edits
			const versionAtStart = this.localVersion;

			// Process each local watchlist (create new array to avoid mutation)
			const updatedWatchlists = await Promise.all(
				this.watchlists.map(async (local) => {
					if (local.serverId) {
						// Update existing server watchlist
						await client.updateWatchlist(local.serverId, {
							name: local.name,
							symbols: local.symbols
						});
						return local;
					} else {
						// Create new watchlist on server
						const serverWatchlist = await client.createWatchlist(local.name, local.symbols);
						hasChanges = true;
						// Return new object with serverId (immutable update)
						return { ...local, serverId: serverWatchlist.id };
					}
				})
			);

			// Update watchlists only if no user edits happened during await
			if (hasChanges && this.localVersion === versionAtStart) {
				this.watchlists = updatedWatchlists;
				this.localVersion++; // Track mutation to prevent syncFromServer race
				// Persist the updated serverId mappings
				await this.context.globalState.update(STORAGE_KEY, this.watchlists);
			}
		} catch (error) {
			// Log for debugging but don't interrupt - offline mode will queue changes for later
			const message = error instanceof Error ? error.message : String(error);
			console.debug(`WatchlistManager: Server sync to failed - ${message}`);
		}
	}

	async deleteWatchlistOnServer(serverId: string): Promise<void> {
		if (!this.serverSyncEnabled) {
			return;
		}

		try {
			const client = ServerApiClient.getInstance();
			await client.deleteWatchlist(serverId);
		} catch (error) {
			// Log for debugging but don't interrupt
			const message = error instanceof Error ? error.message : String(error);
			console.debug(`WatchlistManager: Failed to delete watchlist on server - ${message}`);
		}
	}

	setServerSyncEnabled(enabled: boolean): void {
		this.serverSyncEnabled = enabled;
		if (enabled) {
			void this.syncFromServer();
		}
	}

	isServerSyncEnabled(): boolean {
		return this.serverSyncEnabled;
	}

	dispose(): void {
		// Flush any pending local write before clearing the timer
		if (this.pendingPersist) {
			clearTimeout(this.pendingPersist);
			this.pendingPersist = undefined;
			void this.context.globalState.update(STORAGE_KEY, this.watchlists);
		}
		if (this.pendingServerSync) {
			clearTimeout(this.pendingServerSync);
			this.pendingServerSync = undefined;
		}
		// Dispose EventEmitter
		this._onDidChange.dispose();
	}
}
