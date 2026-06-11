/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { WatchlistManager, Watchlist } from '../panels/data/WatchlistManager';
import { ServerApiClient, ServerWatchlist } from '../core/server/ServerApiClient';

// W1.3 (megaudit H1/M1/M4/M5): WatchlistManager CRUD round-trip + lifecycle.
// The manager is exercised against a fake ServerApiClient and a fake
// globalState so the full local CRUD surface, the Round-5 restore() field
// preservation (serverId/isDefault/sortOrder), the server push engagement,
// the sync-error surfacing, and the auth-listener lifecycle are all covered
// without a VS Code runtime.
suite('WatchlistManager CRUD and lifecycle', () => {
	const STORAGE_KEY = 'quantlab.watchlists';

	interface FakeClient {
		client: ServerApiClient;
		getWatchlistsCalls: () => number;
		setPullError: (err: Error | null) => void;
		setServerLists: (lists: ServerWatchlist[]) => void;
		created: () => ReadonlyArray<{ name: string; symbols: string[] }>;
		updated: () => ReadonlyArray<{ id: string; name: string; symbols: string[] }>;
		deleted: () => ReadonlyArray<string>;
		fireAuth: (signedIn: boolean) => void;
		authListenerCount: () => number;
	}

	function makeFakeClient(): FakeClient {
		const authListeners: Array<(signedIn: boolean) => void> = [];
		let pullError: Error | null = null;
		let serverLists: ServerWatchlist[] = [];
		let pullCalls = 0;
		let nextServerId = 1;
		const created: Array<{ name: string; symbols: string[] }> = [];
		const updated: Array<{ id: string; name: string; symbols: string[] }> = [];
		const deleted: string[] = [];

		const raw = {
			onAuthStateChange(listener: (signedIn: boolean) => void): vscode.Disposable {
				authListeners.push(listener);
				return new vscode.Disposable(() => {
					const idx = authListeners.indexOf(listener);
					if (idx >= 0) { authListeners.splice(idx, 1); }
				});
			},
			async getWatchlists(): Promise<ServerWatchlist[]> {
				pullCalls++;
				if (pullError) { throw pullError; }
				return serverLists.map(list => ({ ...list, symbols: [...list.symbols] }));
			},
			async createWatchlist(name: string, symbols: string[]): Promise<ServerWatchlist> {
				created.push({ name, symbols: [...symbols] });
				return { id: `srv-${nextServerId++}`, name, symbols: [...symbols], is_default: false, sort_order: 0 };
			},
			async updateWatchlist(id: string, body: { name: string; symbols: string[] }): Promise<void> {
				updated.push({ id, name: body.name, symbols: [...body.symbols] });
			},
			async deleteWatchlist(id: string): Promise<void> {
				deleted.push(id);
			}
		};

		return {
			client: raw as unknown as ServerApiClient,
			getWatchlistsCalls: () => pullCalls,
			setPullError: err => { pullError = err; },
			setServerLists: lists => { serverLists = lists; },
			created: () => created,
			updated: () => updated,
			deleted: () => deleted,
			fireAuth: signedIn => { for (const l of [...authListeners]) { l(signedIn); } },
			authListenerCount: () => authListeners.length
		};
	}

	function makeContext(initial?: Watchlist[]): { context: vscode.ExtensionContext; store: Map<string, unknown> } {
		const store = new Map<string, unknown>();
		if (initial) { store.set(STORAGE_KEY, initial); }
		const globalState = {
			get<T>(key: string, defaultValue: T): T {
				return store.has(key) ? store.get(key) as T : defaultValue;
			},
			async update(key: string, value: unknown): Promise<void> {
				store.set(key, value);
			}
		};
		return { context: { globalState } as unknown as vscode.ExtensionContext, store };
	}

	function settle(ms = 20): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	const originalGetInstance = ServerApiClient.getInstance;
	let fake: FakeClient;

	setup(() => {
		fake = makeFakeClient();
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fake.client;
	});

	teardown(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
	});

	test('create / rename / addSymbol / removeSymbol / delete round-trip fires onDidChange and updates getWatchlists()', async () => {
		const { context } = makeContext();
		const manager = new WatchlistManager(context);
		await settle();

		let changeEvents = 0;
		manager.onDidChange(() => { changeEvents++; });

		const created = manager.addWatchlist('Tech Leaders');
		assert.strictEqual(changeEvents, 1);
		assert.strictEqual(manager.getWatchlists().length, 1);
		assert.strictEqual(manager.getWatchlists()[0].name, 'Tech Leaders');

		manager.renameWatchlist(created.id, 'Mega Caps');
		assert.strictEqual(changeEvents, 2);
		assert.strictEqual(manager.getWatchlists()[0].name, 'Mega Caps');

		manager.addSymbol(created.id, 'aapl');
		assert.strictEqual(changeEvents, 3);
		assert.deepStrictEqual(manager.getWatchlists()[0].symbols, ['AAPL']);

		// Duplicate add is a no-op: no event, no second entry.
		manager.addSymbol(created.id, 'AAPL');
		assert.strictEqual(changeEvents, 3);
		assert.deepStrictEqual(manager.getWatchlists()[0].symbols, ['AAPL']);

		manager.removeSymbol(created.id, 'AAPL');
		assert.strictEqual(changeEvents, 4);
		assert.deepStrictEqual(manager.getWatchlists()[0].symbols, []);

		manager.removeWatchlist(created.id);
		assert.strictEqual(changeEvents, 5);
		assert.strictEqual(manager.getWatchlists().length, 0);

		manager.dispose();
	});

	test('restore() preserves serverId / isDefault / sortOrder and rename keeps them intact', async () => {
		const stored: Watchlist[] = [{
			id: 'local-1',
			name: 'Server Backed',
			symbols: ['msft'],
			isDefault: true,
			sortOrder: 3,
			serverId: 'srv-42'
		}];
		// Keep the startup pull from running a merge (the signed-out state),
		// so getWatchlists() reflects restore() output alone.
		fake.setPullError(new Error('Not signed in'));
		const { context } = makeContext(stored);
		const manager = new WatchlistManager(context);
		await settle();

		const restored = manager.getWatchlists();
		assert.strictEqual(restored.length, 1);
		assert.strictEqual(restored[0].serverId, 'srv-42');
		assert.strictEqual(restored[0].isDefault, true);
		assert.strictEqual(restored[0].sortOrder, 3);
		assert.deepStrictEqual(restored[0].symbols, ['MSFT']);

		manager.renameWatchlist('local-1', 'Renamed');
		const renamed = manager.getWatchlists()[0];
		assert.strictEqual(renamed.name, 'Renamed');
		assert.strictEqual(renamed.serverId, 'srv-42');
		assert.strictEqual(renamed.isDefault, true);
		assert.strictEqual(renamed.sortOrder, 3);

		manager.dispose();
	});

	test('removeWatchlist deletes the server copy when serverId is set', async () => {
		const stored: Watchlist[] = [{
			id: 'local-1', name: 'Server Backed', symbols: [], serverId: 'srv-9'
		}];
		// The server must still report the list, otherwise the startup merge
		// treats it as deleted-on-another-device and drops the local copy.
		fake.setServerLists([
			{ id: 'srv-9', name: 'Server Backed', symbols: [], is_default: false, sort_order: 0 }
		]);
		const { context } = makeContext(stored);
		const manager = new WatchlistManager(context);
		await settle();

		manager.removeWatchlist('local-1');
		await settle();
		assert.deepStrictEqual([...fake.deleted()], ['srv-9']);

		manager.dispose();
	});

	test('addWatchlist engages the debounced server push and records the assigned serverId', async function () {
		this.timeout(8000);
		const { context } = makeContext();
		const manager = new WatchlistManager(context);
		await settle();

		manager.addWatchlist('Push Me');
		// persistSoon debounce (200ms) + scheduleServerSync debounce (1000ms)
		await settle(2000);

		assert.strictEqual(fake.created().length, 1);
		assert.strictEqual(fake.created()[0].name, 'Push Me');
		const synced = manager.getWatchlists()[0];
		assert.ok(synced.serverId, 'serverId must be recorded after the push');

		manager.dispose();
	});

	test('pull failure surfaces via onSyncError for non-auth errors and stays quiet for the routine signed-out state', async () => {
		const { context } = makeContext();
		const manager = new WatchlistManager(context);
		await settle();

		const syncErrors: string[] = [];
		manager.onSyncError(message => { syncErrors.push(message); });

		// Routine signed-out pull: logged, not surfaced. Uses the exact message
		// ServerApiClient.ensureAuthenticated throws today (M15 reword kept the
		// 'Not signed in' prefix the /not signed in/i classifier matches on).
		fake.setPullError(new Error('Not signed in. Sign in via the account menu to load live data.'));
		fake.fireAuth(true);
		await settle();
		assert.strictEqual(syncErrors.length, 0);

		// Real failure: surfaced.
		fake.setPullError(new Error('HTTP 500 internal'));
		fake.fireAuth(false);
		fake.fireAuth(true);
		await settle();
		assert.strictEqual(syncErrors.length, 1);
		assert.ok(syncErrors[0].includes('HTTP 500 internal'));

		manager.dispose();
	});

	test('auth listener only reacts to signed-in transitions, not token-refresh re-fires (M119)', async () => {
		const { context } = makeContext();
		const manager = new WatchlistManager(context);
		await settle();
		const baseline = fake.getWatchlistsCalls();

		fake.fireAuth(true);
		await settle();
		assert.strictEqual(fake.getWatchlistsCalls(), baseline + 1, 'first sign-in pulls');

		fake.fireAuth(true); // token refresh re-fire: no transition
		await settle();
		assert.strictEqual(fake.getWatchlistsCalls(), baseline + 1, 'refresh re-fire must not pull');

		fake.fireAuth(false);
		await settle();
		assert.strictEqual(fake.getWatchlistsCalls(), baseline + 1, 'sign-out does not pull');

		fake.fireAuth(true);
		await settle();
		assert.strictEqual(fake.getWatchlistsCalls(), baseline + 2, 'fresh sign-in pulls again');

		manager.dispose();
	});

	test('dispose() unhooks the auth listener so later auth events cannot reach the manager (M1)', async () => {
		const { context } = makeContext();
		const manager = new WatchlistManager(context);
		await settle();
		assert.strictEqual(fake.authListenerCount(), 1);

		manager.dispose();
		assert.strictEqual(fake.authListenerCount(), 0, 'dispose must remove the auth listener');

		const baseline = fake.getWatchlistsCalls();
		fake.fireAuth(true);
		await settle();
		assert.strictEqual(fake.getWatchlistsCalls(), baseline, 'no pull after dispose');
	});

	test('server pull merges by serverId without duplicating restored server-backed lists', async () => {
		const stored: Watchlist[] = [{
			id: 'local-1', name: 'Old Name', symbols: ['aapl'], serverId: 'srv-7', isDefault: false, sortOrder: 1
		}];
		fake.setServerLists([
			{ id: 'srv-7', name: 'Server Name', symbols: ['AAPL', 'MSFT'], is_default: true, sort_order: 2 }
		]);
		const { context } = makeContext(stored);
		const manager = new WatchlistManager(context);
		await settle();

		const lists = manager.getWatchlists();
		assert.strictEqual(lists.length, 1, 'restored serverId must prevent duplication on merge');
		assert.strictEqual(lists[0].id, 'local-1');
		assert.strictEqual(lists[0].name, 'Server Name');
		assert.deepStrictEqual(lists[0].symbols, ['AAPL', 'MSFT']);
		assert.strictEqual(lists[0].isDefault, true);
		assert.strictEqual(lists[0].sortOrder, 2);
		assert.strictEqual(lists[0].serverId, 'srv-7');

		manager.dispose();
	});
});
