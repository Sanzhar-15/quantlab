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

// F-HOST-WATCHLIST-SYNC-1 (PLAN-FINAL section 3.5 rule 2): `quantlab.watchlist.rename`, `.delete` and `.removeSymbol` are public
// commands. Each accepts only a node object DataTreeProvider rendered (watchlistNodes.ts); a caller-shaped node naming a
// REAL list (and symbol) is refused by name before any prompt, Memento write or server request (B1).
// F-HOST-WATCHLIST-SYNC-2 (c1 M1): another extension can receive and mutate the same rendered node, so each command acts
// only on the frozen snapshot taken at render time, and only after the user accepts a QuantLab modal naming it.
// B2: modal dismissed or cancelled -> no debounce, no Memento write, no server call. B3: the rendered Core node is
// retargeted in place at Growth (or Core/AAPL at Growth/TSLA) -> the modal still names Core and only Core changes.
// B4: the genuine context-menu path still works. The commands run as registered by registerWatchlistCommands against
// the real WatchlistManager and DataTreeProvider, a fake ServerApiClient, a counting fake globalState and a manual
// clock (the manager debounces its Memento write by 200 ms and its server push by 1 s).
// Planted negative controls (B5): (a) skip the `choice !== <accept>` return in one command -> its B2 test fails with
// "<command> started a debounce although the user did not accept its modal (...)"; (b) read the target from the
// argument (node.watchlist.id / node.watchlistId / node.symbol) in one command -> its B3 test fails with
// "<command> ... (B3: ...retargeted...)". Deleting the resolver call -> its B1 test fails with "<command> accepted ...".

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

	/** Timers scheduled and not yet run: a debounce start shows up here before any time passes. */
	pendingCount(): number {
		return this.pending.length;
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

type ListView = { id: string; name: string; symbols: string[] };

const CORE: ListView = { id: 'local-1', name: 'Core', symbols: ['AAPL', 'MSFT'] };
const GROWTH: ListView = { id: 'local-2', name: 'Growth', symbols: ['TSLA', 'NVDA', 'AMD'] };
/** One push = one syncToServer run = one update per server-linked list; this is Growth's (unchanged) share of it. */
const GROWTH_PUSH: ServerCall = { op: 'update', id: 'srv-2', name: 'Growth', symbols: ['TSLA', 'NVDA', 'AMD'] };
const DECLINES: ReadonlyArray<readonly [string, string | undefined]> = [['dismissed', undefined], ['Cancel', 'Cancel']];

/** The nodes the tree returns for the two stored lists (the objects VS Code hands a context menu, or another extension). */
interface RenderedTree {
	core: WatchlistNode;
	growth: WatchlistNode;
	coreItems: WatchlistItemNode[];
	growthItems: WatchlistItemNode[];
}

/** One confirming command, invoked on the rendered Core node (or Core/AAPL), with what it must show and do. */
interface ConfirmCase {
	readonly command: 'quantlab.watchlist.rename' | 'quantlab.watchlist.delete' | 'quantlab.watchlist.removeSymbol';
	readonly accept: string;
	readonly node: (tree: RenderedTree) => WatchlistNode | WatchlistItemNode;
	/** Changes that same node's shared fields in place so that they name Growth (or Growth/TSLA) instead. */
	readonly retarget: (tree: RenderedTree) => void;
	readonly inputBoxAnswer: string | undefined;
	readonly inputBoxValues: Array<string | undefined>;
	readonly modal: string;
	readonly listsAfter: ListView[];
	readonly callsAfter: ServerCall[];
}

function retargetCoreNodeAtGrowth(tree: RenderedTree): void {
	Object.assign(tree.core, { id: 'quantlab.watchlist.local-2', label: 'Growth', description: '3 symbols' });
	Object.assign(tree.core.watchlist, { id: 'local-2', name: 'Growth', symbols: [...GROWTH.symbols], serverId: 'srv-2' });
}

const CONFIRM_CASES: ConfirmCase[] = [
	{
		command: 'quantlab.watchlist.removeSymbol',
		accept: 'Remove',
		node: tree => tree.coreItems[0],
		retarget: tree => {
			Object.assign(tree.coreItems[0], { id: 'quantlab.watchlist.local-2.TSLA', label: 'TSLA', symbol: 'TSLA', watchlistId: 'local-2' });
		},
		inputBoxAnswer: undefined,
		inputBoxValues: [],
		modal: 'Remove "AAPL" from watchlist "Core"?',
		listsAfter: [{ ...CORE, symbols: ['MSFT'] }, GROWTH],
		callsAfter: [{ op: 'update', id: 'srv-1', name: 'Core', symbols: ['MSFT'] }, GROWTH_PUSH],
	},
	{
		command: 'quantlab.watchlist.rename',
		accept: 'Rename',
		node: tree => tree.core,
		retarget: retargetCoreNodeAtGrowth,
		inputBoxAnswer: 'Mega Caps',
		inputBoxValues: ['Core'],
		modal: 'Rename watchlist "Core" to "Mega Caps"?',
		listsAfter: [{ ...CORE, name: 'Mega Caps' }, GROWTH],
		callsAfter: [{ op: 'update', id: 'srv-1', name: 'Mega Caps', symbols: ['AAPL', 'MSFT'] }, GROWTH_PUSH],
	},
	{
		command: 'quantlab.watchlist.delete',
		accept: 'Delete',
		node: tree => tree.core,
		retarget: retargetCoreNodeAtGrowth,
		inputBoxAnswer: undefined,
		inputBoxValues: [],
		modal: 'Delete watchlist "Core" (2 symbols)?',
		listsAfter: [GROWTH],
		callsAfter: [{ op: 'delete', id: 'srv-1' }, GROWTH_PUSH],
	},
];

suite('F-HOST-WATCHLIST-SYNC-1/2: watchlist rename/delete/removeSymbol act only on a rendered node\'s snapshot, after an accepted modal', () => {
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
	let store: Map<string, unknown>;
	let mementoUpdates: unknown[];
	let subscriptions: vscode.Disposable[];
	let manager: WatchlistManager;
	let provider: DataTreeProvider;
	let handlers: Map<string, (...args: unknown[]) => unknown>;
	let ui: {
		inputBoxValues: Array<string | undefined>;
		inputBoxAnswer: string | undefined;
		modals: Array<{ message: string; options: unknown; items: string[] }>;
		modalAnswer: string | undefined;
	};
	let rendered: RenderedTree;

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

	async function renderWatchlists(): Promise<RenderedTree> {
		const roots = await Promise.resolve(provider.getChildren());
		const category = roots.find(node => node.nodeKind === 'category' && node.categoryId === 'watchlists');
		if (!category) {
			throw new Error('the Watchlists category is missing from the root nodes');
		}
		const lists = (await Promise.resolve(provider.getChildren(category))).filter((node): node is WatchlistNode => node.nodeKind === 'watchlist');
		assert.deepStrictEqual(lists.map(list => list.label), ['Core', 'Growth'], 'the tree must render the two stored lists');
		const itemsOf = async (list: WatchlistNode): Promise<WatchlistItemNode[]> =>
			(await Promise.resolve(provider.getChildren(list))).filter((node): node is WatchlistItemNode => node.nodeKind === 'watchlistItem');
		const coreItems = await itemsOf(lists[0]);
		const growthItems = await itemsOf(lists[1]);
		assert.deepStrictEqual(coreItems.map(item => item.symbol), CORE.symbols);
		assert.deepStrictEqual(growthItems.map(item => item.symbol), GROWTH.symbols);
		return { core: lists[0], growth: lists[1], coreItems, growthItems };
	}

	function listsNow(): ListView[] {
		return manager.getWatchlists().map(list => ({ id: list.id, name: list.name, symbols: list.symbols }));
	}

	/** The manager's whole record of one list (serverId and all), serialised. */
	function listBytes(id: string): string {
		const list = manager.getWatchlists().find(candidate => candidate.id === id);
		if (!list) {
			throw new Error(`list ${id} is missing from the manager`);
		}
		return JSON.stringify(list);
	}

	/** The last value written to globalState for one list, serialised. */
	function storedListBytes(id: string): string {
		const stored = store.get(STORAGE_KEY);
		if (!Array.isArray(stored)) {
			throw new Error(`globalState holds no watchlist array under ${STORAGE_KEY}`);
		}
		const list = (stored as Watchlist[]).find(candidate => candidate.id === id);
		if (!list) {
			throw new Error(`list ${id} is missing from the written globalState`);
		}
		return JSON.stringify(list);
	}

	/** Every argument is refused by name; after both debounces nothing changed, nothing was written, sent or prompted. */
	async function assertRefusedWithoutEffect(command: string, kind: 'watchlist' | 'watchlistItem', untrusted: Array<[string, unknown]>): Promise<void> {
		const refusal = new RegExp(`${command.replace(/\./g, '\\.')} refused: its argument is not a ${kind} node rendered by the QuantLab data tree`);
		for (const [label, arg] of untrusted) {
			await assert.rejects(invoke(command, arg), refusal, `${command} accepted ${label}`);
		}
		await clock.advance(PERSIST_AND_PUSH_MS);
		assert.deepStrictEqual(listsNow(), [CORE, GROWTH], `${command} changed the stored lists`);
		assert.deepStrictEqual(server.calls, [], `${command} reached the server`);
		assert.strictEqual(mementoUpdates.length, 0, `${command} wrote globalState`);
		assert.deepStrictEqual(ui.inputBoxValues, [], `${command} opened an input box`);
		assert.deepStrictEqual(ui.modals, [], `${command} opened a modal`);
	}

	/** The input box (rename) was prefilled from the snapshot, and exactly one QuantLab modal named the snapshot target. */
	function assertConfirmation(c: ConfirmCase, when: string): void {
		assert.deepStrictEqual(ui.inputBoxValues, c.inputBoxValues, `${c.command} did not prefill its input box from its render-time snapshot (${when})`);
		assert.deepStrictEqual(ui.modals, [{ message: c.modal, options: { modal: true }, items: [c.accept] }],
			`${c.command} did not show exactly one QuantLab modal naming its render-time snapshot target (${when})`);
	}

	/** Accepts the modal on the case's node; only Core changes, Growth stays byte-equal, one write, one push (and one delete). */
	async function assertAcceptedActsOnSnapshot(c: ConfirmCase, when: string): Promise<void> {
		const growthBefore = listBytes('local-2');
		ui.inputBoxAnswer = c.inputBoxAnswer;
		ui.modalAnswer = c.accept;
		await invoke(c.command, c.node(rendered));
		assertConfirmation(c, when);
		await clock.advance(PERSIST_AND_PUSH_MS);
		assert.deepStrictEqual(listsNow(), c.listsAfter, `${c.command} changed the wrong list (${when})`);
		assert.strictEqual(listBytes('local-2'), growthBefore, `${c.command} touched Growth in the manager (${when})`);
		assert.strictEqual(storedListBytes('local-2'), growthBefore, `${c.command} touched Growth in the written globalState (${when})`);
		assert.strictEqual(mementoUpdates.length, 1, `${c.command} must write globalState exactly once (${when})`);
		assert.deepStrictEqual(server.calls, c.callsAfter,
			`${c.command} must send exactly one push (one update per server-linked list), plus one server delete of Core for delete (${when})`);
	}

	setup(async () => {
		clock = new ManualClock();
		clock.install();
		server = makeFakeServer([
			{ id: 'srv-1', name: 'Core', symbols: [...CORE.symbols], is_default: false, sort_order: 0 },
			{ id: 'srv-2', name: 'Growth', symbols: [...GROWTH.symbols], is_default: false, sort_order: 1 },
		]);
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => server.client;

		const stored: Watchlist[] = [
			{ id: 'local-1', name: 'Core', symbols: [...CORE.symbols], serverId: 'srv-1' },
			{ id: 'local-2', name: 'Growth', symbols: [...GROWTH.symbols], serverId: 'srv-2' },
		];
		store = new Map<string, unknown>([[STORAGE_KEY, stored]]);
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

		ui = { inputBoxValues: [], inputBoxAnswer: undefined, modals: [], modalAnswer: undefined };
		windowShim.showInputBox = async (options: { value?: string }): Promise<string | undefined> => {
			ui.inputBoxValues.push(options.value);
			return ui.inputBoxAnswer;
		};
		windowShim.showWarningMessage = async (message: string, options: unknown, ...items: string[]): Promise<string | undefined> => {
			ui.modals.push({ message, options, items });
			return ui.modalAnswer;
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

		// The startup pull matched the stored lists: nothing is pending. Count from here.
		assert.deepStrictEqual(listsNow(), [CORE, GROWTH]);
		assert.strictEqual(mementoUpdates.length, 0, 'the startup pull must not rewrite unchanged lists');
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

	test('B1 removeSymbol: a forged item node naming a real list and symbol is refused by name; no write, no server call, no prompt', async () => {
		await assertRefusedWithoutEffect('quantlab.watchlist.removeSymbol', 'watchlistItem', [
			['a forged item node naming list local-1 and AAPL', { nodeKind: 'watchlistItem', id: 'quantlab.watchlist.local-1.AAPL', label: 'AAPL', symbol: 'AAPL', watchlistId: 'local-1', collapsibleState: 0 }],
			['a field-for-field copy of a rendered item node', { ...rendered.coreItems[0] }],
			['a rendered watchlist node (wrong kind)', rendered.core],
			['undefined', undefined],
		]);
	});

	test('B1 rename: a forged watchlist node naming a real list is refused by name; no write, no server call, no prompt', async () => {
		ui.inputBoxAnswer = 'Renamed by caller';
		ui.modalAnswer = 'Rename';
		await assertRefusedWithoutEffect('quantlab.watchlist.rename', 'watchlist', [
			['a forged watchlist node naming list local-1', { nodeKind: 'watchlist', id: 'quantlab.watchlist.local-1', label: 'Core', watchlist: { id: 'local-1', name: 'Core', symbols: [] }, collapsibleState: 1 }],
			['a field-for-field copy of a rendered watchlist node', { ...rendered.core }],
			['a rendered item node (wrong kind)', rendered.coreItems[0]],
			['undefined', undefined],
		]);
	});

	test('B1 delete: a forged watchlist node naming a real list under another name is refused by name; no write, no server call, no modal', async () => {
		ui.modalAnswer = 'Delete';
		await assertRefusedWithoutEffect('quantlab.watchlist.delete', 'watchlist', [
			['a forged watchlist node naming list local-1 as "Harmless"', { nodeKind: 'watchlist', id: 'quantlab.watchlist.local-1', label: 'Harmless', watchlist: { id: 'local-1', name: 'Harmless', symbols: [] }, collapsibleState: 1 }],
			['a field-for-field copy of a rendered watchlist node', { ...rendered.core }],
			['a rendered item node (wrong kind)', rendered.coreItems[0]],
			['undefined', undefined],
		]);
	});

	for (const c of CONFIRM_CASES) {
		test(`B2 ${c.command}: its modal dismissed or cancelled on a rendered node -> no debounce, no globalState write, no server call; the modal named the snapshot target`, async () => {
			ui.inputBoxAnswer = c.inputBoxAnswer;
			for (const [label, answer] of DECLINES) {
				ui.inputBoxValues.splice(0);
				ui.modals.splice(0);
				ui.modalAnswer = answer;
				const timersBefore = clock.pendingCount();
				await invoke(c.command, c.node(rendered));
				const why = `although the user did not accept its modal (${label})`;
				assert.strictEqual(clock.pendingCount(), timersBefore, `${c.command} started a debounce ${why}`);
				await clock.advance(PERSIST_AND_PUSH_MS);
				assert.deepStrictEqual(server.calls, [], `${c.command} reached the server ${why}`);
				assert.strictEqual(mementoUpdates.length, 0, `${c.command} wrote globalState ${why}`);
				assert.deepStrictEqual(listsNow(), [CORE, GROWTH], `${c.command} changed the stored lists ${why}`);
				assertConfirmation(c, `modal ${label}`);
			}
		});

		test(`B3 ${c.command}: its rendered node retargeted in place at Growth still names and changes only Core; Growth byte-equal; one push`, async () => {
			c.retarget(rendered);
			await assertAcceptedActsOnSnapshot(c, 'B3: the rendered node was retargeted at Growth after render; the target must come from the render-time snapshot, not the argument');
		});

		test(`B4 ${c.command}: the genuine context-menu path with the modal accepted works; one push`, async () => {
			await assertAcceptedActsOnSnapshot(c, 'B4: genuine context-menu path');
		});
	}
});
