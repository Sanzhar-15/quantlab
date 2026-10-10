/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { DataTreeProvider, WatchlistItemNode, WatchlistNode } from '../panels/data/DataTreeProvider';
import { Watchlist, WatchlistManager } from '../panels/data/WatchlistManager';
import { CryptoSymbol, ServerApiClient, ServerSymbol, ServerWatchlist } from '../core/server/ServerApiClient';
import type { GlobalState } from '../core/state/GlobalState';
import { registerWatchlistCommands } from '../commands/watchlistCommands';

// F-HOST-WATCHLIST-SYNC-1 (PLAN-FINAL §3.5 rule 2): `quantlab.watchlist.rename`, `.delete` and `.removeSymbol` are public
// commands. Each accepts only a node object DataTreeProvider rendered (watchlistNodes.ts); a caller-shaped node naming a
// REAL list (and symbol) is refused by name before any prompt, Memento write or server request. The commands run as
// registered by registerWatchlistCommands against the real WatchlistManager and DataTreeProvider, a fake ServerApiClient,
// a fake globalState and a manual clock (the manager debounces its Memento write by 200 ms and its server push by 1 s).
// Planted negative control: delete the resolver call from any one command (or restore its old nodeKind check): that
// command's A1 test fails with "Missing expected rejection: <command> accepted ...".

const STORAGE_KEY = 'quantlab.watchlists';
const PERSIST_AND_PUSH_MS = 200 + 1000 + 100;

/** setTimeout/clearTimeout under the test's control. Mocha keeps its own timer references, so its timeouts are unaffected. */
class ManualClock {
	private now = 0;
	private nextId = 1;
	private pending: Array<{ id: number; at: number; fn: () => void }> = [];
	private readonly timers = globalThis as unknown as { setTimeout: unknown; clearTimeout: unknown };
	private readonly realSetTimeout = this.timers.setTimeout;
	private readonly realClearTimeout = this.timers.clearTimeout;

	install(): void {
		this.timers.setTimeout = (fn: (...args: unknown[]) => void, ms: number | undefined, ...args: unknown[]): number => {
			if (typeof ms !== 'number') {
				throw new Error('ManualClock: setTimeout called without a delay');
			}
			const id = this.nextId++;
			this.pending.push({ id, at: this.now + ms, fn: () => fn(...args) });
			return id;
		};
		this.timers.clearTimeout = (id: unknown): void => {
			this.pending = this.pending.filter(timer => timer.id !== id);
		};
	}

	uninstall(): void {
		this.timers.setTimeout = this.realSetTimeout;
		this.timers.clearTimeout = this.realClearTimeout;
	}

	/** Runs every timer due within `ms`, in due order, draining promise jobs after each. */
	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		await drainPromiseJobs();
		for (let due = this.nextDue(target); due; due = this.nextDue(target)) {
			this.pending.splice(this.pending.indexOf(due), 1);
			this.now = due.at;
			due.fn();
			await drainPromiseJobs();
		}
		this.now = target;
	}

	private nextDue(target: number): { id: number; at: number; fn: () => void } | undefined {
		let next: { id: number; at: number; fn: () => void } | undefined;
		for (const timer of this.pending) {
			if (timer.at <= target && (next === undefined || timer.at < next.at)) {
				next = timer;
			}
		}
		return next;
	}
}

function drainPromiseJobs(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

type ServerCall =
	| { op: 'getWatchlists' }
	| { op: 'create'; name: string; symbols: string[] }
	| { op: 'update'; id: string; name: string; symbols: string[] }
	| { op: 'delete'; id: string };

/** The watchlist half of ServerApiClient records every call; the tree's symbol loads answer with empty lists. */
function makeFakeServer(lists: ServerWatchlist[]): { client: ServerApiClient; calls: ServerCall[] } {
	const calls: ServerCall[] = [];
	const raw = {
		onAuthStateChange(_listener: (signedIn: boolean) => void): vscode.Disposable {
			return new vscode.Disposable(() => undefined);
		},
		async getSymbols(): Promise<ServerSymbol[]> {
			return [];
		},
		async getCryptoSymbols(): Promise<CryptoSymbol[]> {
			return [];
		},
		async getWatchlists(): Promise<ServerWatchlist[]> {
			calls.push({ op: 'getWatchlists' });
			return lists.map(list => ({ ...list, symbols: [...list.symbols] }));
		},
		async createWatchlist(name: string, symbols: string[]): Promise<ServerWatchlist> {
			calls.push({ op: 'create', name, symbols: [...symbols] });
			return { id: 'srv-created', name, symbols: [...symbols], is_default: false, sort_order: 0 };
		},
		async updateWatchlist(id: string, body: { name: string; symbols: string[] }): Promise<void> {
			calls.push({ op: 'update', id, name: body.name, symbols: [...body.symbols] });
		},
		async deleteWatchlist(id: string): Promise<void> {
			calls.push({ op: 'delete', id });
		},
	};
	return { client: raw as unknown as ServerApiClient, calls };
}

function makeFakeGlobalState(): GlobalState {
	const raw = {
		getDataSource(): undefined {
			return undefined;
		},
		onDidChangeDataSource(_listener: (source: unknown) => void): vscode.Disposable {
			return new vscode.Disposable(() => undefined);
		},
	};
	return raw as unknown as GlobalState;
}

suite('F-HOST-WATCHLIST-SYNC-1: watchlist rename/delete/removeSymbol accept only a node the data tree rendered', () => {
	const originalGetInstance = ServerApiClient.getInstance;
	const commandsShim = vscode.commands as unknown as Record<string, unknown>;
	const windowShim = vscode.window as unknown as Record<string, unknown>;
	const savedShim = {
		registerCommand: commandsShim.registerCommand,
		showInputBox: windowShim.showInputBox,
		showWarningMessage: windowShim.showWarningMessage,
	};

	let clock: ManualClock;
	let server: { client: ServerApiClient; calls: ServerCall[] };
	let mementoUpdates: unknown[];
	let subscriptions: vscode.Disposable[];
	let manager: WatchlistManager;
	let provider: DataTreeProvider;
	let handlers: Map<string, (...args: unknown[]) => unknown>;
	let ui: { inputBoxValues: Array<string | undefined>; inputBoxAnswer: string | undefined; warnings: string[]; warningAnswer: string | undefined };
	let rendered: { list: WatchlistNode; items: WatchlistItemNode[] };

	function restoreShim(target: Record<string, unknown>, key: 'registerCommand' | 'showInputBox' | 'showWarningMessage'): void {
		if (savedShim[key] === undefined) {
			delete target[key];
		} else {
			target[key] = savedShim[key];
		}
	}

	async function invoke(command: string, arg: unknown): Promise<void> {
		const handler = handlers.get(command);
		if (!handler) {
			throw new Error(`${command} was not registered by registerWatchlistCommands`);
		}
		await handler(arg);
	}

	/** The watchlist and item nodes the tree returns for the one stored list (the objects VS Code hands a context menu). */
	async function renderWatchlists(): Promise<{ list: WatchlistNode; items: WatchlistItemNode[] }> {
		const roots = await Promise.resolve(provider.getChildren());
		const category = roots.find(node => node.nodeKind === 'category' && node.categoryId === 'watchlists');
		if (!category) {
			throw new Error('the Watchlists category is missing from the root nodes');
		}
		const lists = (await Promise.resolve(provider.getChildren(category))).filter((node): node is WatchlistNode => node.nodeKind === 'watchlist');
		assert.strictEqual(lists.length, 1, 'the tree must render the one stored list');
		const items = (await Promise.resolve(provider.getChildren(lists[0]))).filter((node): node is WatchlistItemNode => node.nodeKind === 'watchlistItem');
		assert.deepStrictEqual(items.map(item => item.symbol), ['AAPL', 'MSFT']);
		return { list: lists[0], items };
	}

	function listsNow(): Array<{ id: string; name: string; symbols: string[] }> {
		return manager.getWatchlists().map(list => ({ id: list.id, name: list.name, symbols: list.symbols }));
	}

	/** Every argument is refused by name; after both debounces nothing changed, nothing was written, sent or prompted. */
	async function assertRefusedWithoutEffect(command: string, kind: 'watchlist' | 'watchlistItem', untrusted: Array<[string, unknown]>): Promise<void> {
		const refusal = new RegExp(`${command.replace(/\./g, '\\.')} refused: its argument is not a ${kind} node rendered by the QuantLab data tree`);
		for (const [label, arg] of untrusted) {
			await assert.rejects(invoke(command, arg), refusal, `${command} accepted ${label}`);
		}
		await clock.advance(PERSIST_AND_PUSH_MS);
		assert.deepStrictEqual(listsNow(), [{ id: 'local-1', name: 'Core', symbols: ['AAPL', 'MSFT'] }], `${command} changed the stored list`);
		assert.deepStrictEqual(server.calls, [], `${command} reached the server`);
		assert.strictEqual(mementoUpdates.length, 0, `${command} wrote globalState`);
		assert.deepStrictEqual(ui.inputBoxValues, [], `${command} opened an input box`);
		assert.deepStrictEqual(ui.warnings, [], `${command} opened a modal`);
	}

	setup(async () => {
		clock = new ManualClock();
		clock.install();
		server = makeFakeServer([{ id: 'srv-1', name: 'Core', symbols: ['AAPL', 'MSFT'], is_default: false, sort_order: 0 }]);
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => server.client;

		const stored: Watchlist[] = [{ id: 'local-1', name: 'Core', symbols: ['AAPL', 'MSFT'], serverId: 'srv-1' }];
		const store = new Map<string, unknown>([[STORAGE_KEY, stored]]);
		mementoUpdates = [];
		const globalState = {
			get<T>(key: string, defaultValue: T): T {
				return store.has(key) ? store.get(key) as T : defaultValue;
			},
			async update(key: string, value: unknown): Promise<void> {
				mementoUpdates.push(value);
				store.set(key, value);
			},
		};
		subscriptions = [];
		const context = { subscriptions, globalState } as unknown as vscode.ExtensionContext;

		ui = { inputBoxValues: [], inputBoxAnswer: undefined, warnings: [], warningAnswer: undefined };
		windowShim.showInputBox = async (options: { value?: string }): Promise<string | undefined> => {
			ui.inputBoxValues.push(options.value);
			return ui.inputBoxAnswer;
		};
		windowShim.showWarningMessage = async (message: string): Promise<string | undefined> => {
			ui.warnings.push(message);
			return ui.warningAnswer;
		};
		handlers = new Map();
		commandsShim.registerCommand = (command: string, handler: (...args: unknown[]) => unknown): vscode.Disposable => {
			handlers.set(command, handler);
			return new vscode.Disposable(() => handlers.delete(command));
		};

		manager = new WatchlistManager(context);
		provider = new DataTreeProvider(makeFakeGlobalState(), manager);
		registerWatchlistCommands(context, manager);
		await clock.advance(0);
		rendered = await renderWatchlists();

		// The startup pull matched the stored list: nothing is pending. Count from here.
		assert.deepStrictEqual(listsNow(), [{ id: 'local-1', name: 'Core', symbols: ['AAPL', 'MSFT'] }]);
		assert.strictEqual(mementoUpdates.length, 0, 'the startup pull must not rewrite an unchanged list');
		server.calls.splice(0);
	});

	teardown(() => {
		provider.dispose();
		manager.dispose();
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
		restoreShim(commandsShim, 'registerCommand');
		restoreShim(windowShim, 'showInputBox');
		restoreShim(windowShim, 'showWarningMessage');
		clock.uninstall();
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
	});

	test('A1 removeSymbol: a forged item node naming a real list and symbol is refused by name; no write, no server call, no prompt', async () => {
		await assertRefusedWithoutEffect('quantlab.watchlist.removeSymbol', 'watchlistItem', [
			['a forged item node naming list local-1 and AAPL', { nodeKind: 'watchlistItem', id: 'quantlab.watchlist.local-1.AAPL', label: 'AAPL', symbol: 'AAPL', watchlistId: 'local-1', collapsibleState: 0 }],
			['a field-for-field copy of a rendered item node', { ...rendered.items[0] }],
			['a rendered watchlist node (wrong kind)', rendered.list],
			['undefined', undefined],
		]);
	});

	test('A1 rename: a forged watchlist node naming a real list is refused by name; no write, no server call, no prompt', async () => {
		ui.inputBoxAnswer = 'Renamed by caller';
		await assertRefusedWithoutEffect('quantlab.watchlist.rename', 'watchlist', [
			['a forged watchlist node naming list local-1', { nodeKind: 'watchlist', id: 'quantlab.watchlist.local-1', label: 'Core', watchlist: { id: 'local-1', name: 'Core', symbols: [] }, collapsibleState: 1 }],
			['a field-for-field copy of a rendered watchlist node', { ...rendered.list }],
			['a rendered item node (wrong kind)', rendered.items[0]],
			['undefined', undefined],
		]);
	});

	test('A1 delete: a forged watchlist node naming a real list under another name is refused by name; no write, no server call, no modal', async () => {
		ui.warningAnswer = 'Delete';
		await assertRefusedWithoutEffect('quantlab.watchlist.delete', 'watchlist', [
			['a forged watchlist node naming list local-1 as "Harmless"', { nodeKind: 'watchlist', id: 'quantlab.watchlist.local-1', label: 'Harmless', watchlist: { id: 'local-1', name: 'Harmless', symbols: [] }, collapsibleState: 1 }],
			['a field-for-field copy of a rendered watchlist node', { ...rendered.list }],
			['a rendered item node (wrong kind)', rendered.items[0]],
			['undefined', undefined],
		]);
	});

	test('A2 removeSymbol: the item node the tree returned removes the symbol and pushes once', async () => {
		await invoke('quantlab.watchlist.removeSymbol', rendered.items[0]);
		assert.deepStrictEqual(listsNow(), [{ id: 'local-1', name: 'Core', symbols: ['MSFT'] }]);
		await clock.advance(PERSIST_AND_PUSH_MS);
		assert.deepStrictEqual(server.calls, [{ op: 'update', id: 'srv-1', name: 'Core', symbols: ['MSFT'] }]);
		assert.strictEqual(mementoUpdates.length, 1);
	});

	test('A2 rename: the watchlist node the tree returned renames the list and pushes once', async () => {
		ui.inputBoxAnswer = 'Mega Caps';
		await invoke('quantlab.watchlist.rename', rendered.list);
		assert.deepStrictEqual(ui.inputBoxValues, ['Core']);
		assert.deepStrictEqual(listsNow(), [{ id: 'local-1', name: 'Mega Caps', symbols: ['AAPL', 'MSFT'] }]);
		await clock.advance(PERSIST_AND_PUSH_MS);
		assert.deepStrictEqual(server.calls, [{ op: 'update', id: 'srv-1', name: 'Mega Caps', symbols: ['AAPL', 'MSFT'] }]);
		assert.strictEqual(mementoUpdates.length, 1);
	});

	test('A2 delete: the watchlist node the tree returned deletes the list and its server copy once', async () => {
		ui.warningAnswer = 'Delete';
		await invoke('quantlab.watchlist.delete', rendered.list);
		assert.deepStrictEqual(ui.warnings, ['Delete watchlist "Core" (2 symbols)?']);
		assert.deepStrictEqual(listsNow(), []);
		await clock.advance(PERSIST_AND_PUSH_MS);
		assert.deepStrictEqual(server.calls, [{ op: 'delete', id: 'srv-1' }]);
		assert.strictEqual(mementoUpdates.length, 1);
	});
});
