/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Megaudit 2026-06-11 W7-D: install vscode-shim BEFORE importing 'vscode'.
// Plain mocha doesn't have access to the real VS Code runtime.
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';

// DataTreeProvider needs the tree-view surface the minimal shim doesn't carry.
// The shim's compiled CommonJS exports object is mutable, so augment it
// in-place (the shim file itself is owned by another workstream).
const shim = vscode as unknown as Record<string, unknown>;
if (shim.TreeItemCollapsibleState === undefined) {
	shim.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
}
if (shim.ThemeIcon === undefined) {
	shim.ThemeIcon = class {
		constructor(readonly id: string) { }
	};
}
if (shim.TreeItem === undefined) {
	shim.TreeItem = class {
		id?: string;
		description?: string | boolean;
		tooltip?: unknown;
		iconPath?: unknown;
		command?: unknown;
		contextValue?: string;
		constructor(readonly label: string, readonly collapsibleState?: number) { }
	};
}

import {
	DataTreeProvider,
	DataNode,
	CategoryNode,
	SubCategoryNode,
	InstrumentNode,
} from '../panels/data/DataTreeProvider';
import { GlobalState } from '../core/state/GlobalState';
import { WatchlistManager } from '../panels/data/WatchlistManager';
import { ServerApiClient, CryptoSymbol } from '../core/server/ServerApiClient';

// M123: category-level truth-in-labeling. Fully-unbacked top-level categories
// (every leaf routes to getComingSoonNodes) must announce 'coming soon' BEFORE
// expansion; partially-backed categories must suffix only their dead
// SUBcategories while live ones (yield curve, spot, news, ...) stay unmarked.
// L2: multi-segment crypto symbols must replace EVERY underscore.
suite('DataTreeProvider category truth-in-labeling (M123) and symbol display (L2)', () => {

	const originalGetInstance = ServerApiClient.getInstance;
	let provider: DataTreeProvider;

	function makeFakeApiClient(): ServerApiClient {
		const raw = {
			onAuthStateChange(_listener: (signedIn: boolean) => void): vscode.Disposable {
				return new vscode.Disposable(() => { });
			},
			async getSymbols(): Promise<never> {
				// The exact signed-out failure ServerApiClient throws today; the
				// tree classifies it via /not signed in/i (M15 kept the prefix).
				throw new Error('Not signed in. Sign in via the account menu to load live data.');
			},
		};
		return raw as unknown as ServerApiClient;
	}

	function makeFakeGlobalState(): GlobalState {
		const raw = {
			getDataSource(): undefined {
				return undefined;
			},
			onDidChangeDataSource(_listener: (d: unknown) => void): vscode.Disposable {
				return new vscode.Disposable(() => { });
			},
		};
		return raw as unknown as GlobalState;
	}

	function makeFakeWatchlistManager(): WatchlistManager {
		const raw = {
			onDidChange(_listener: () => void): vscode.Disposable {
				return new vscode.Disposable(() => { });
			},
			getWatchlists(): unknown[] {
				return [];
			},
		};
		return raw as unknown as WatchlistManager;
	}

	async function children(element?: DataNode): Promise<DataNode[]> {
		return Promise.resolve(provider.getChildren(element));
	}

	function categoryByLabel(roots: DataNode[], label: string): CategoryNode {
		const node = roots.find(n => n.nodeKind === 'category' && n.label === label);
		assert.ok(node, `category '${label}' missing from root nodes`);
		return node as CategoryNode;
	}

	function subCategories(nodes: DataNode[]): SubCategoryNode[] {
		return nodes.filter((n): n is SubCategoryNode => n.nodeKind === 'subCategory');
	}

	setup(() => {
		const fake = makeFakeApiClient();
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fake;
		provider = new DataTreeProvider(makeFakeGlobalState(), makeFakeWatchlistManager());
	});

	teardown(() => {
		provider.dispose();
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
	});

	test('fully-unbacked categories (Forex, Commodities, Macro) carry a coming-soon description and tooltip', async () => {
		const roots = await children();
		for (const label of ['Forex', 'Commodities', 'Macro']) {
			const node = categoryByLabel(roots, label);
			assert.strictEqual(node.description, 'coming soon', `${label} must be marked coming soon`);
			const item = provider.getTreeItem(node);
			assert.strictEqual(item.description, 'coming soon');
			assert.strictEqual(item.tooltip, `${label} data is planned but not yet available`);
		}
	});

	test('backed and partially-backed categories carry NO category-level coming-soon marker', async () => {
		const roots = await children();
		for (const label of ['Watchlists', 'Equities', 'Crypto', 'Fixed Income', 'Calendar', 'Sentiment']) {
			const node = categoryByLabel(roots, label);
			assert.strictEqual(node.description, undefined, `${label} must NOT be marked coming soon`);
			const item = provider.getTreeItem(node);
			assert.strictEqual(item.description, undefined);
		}
	});

	test('partially-backed categories suffix exactly their dead subcategories', async () => {
		const roots = await children();

		const crypto = subCategories(await children(categoryByLabel(roots, 'Crypto')));
		const cryptoSuffixed = crypto.filter(n => n.label.endsWith('(coming soon)')).map(n => n.subKey).sort();
		assert.deepStrictEqual(cryptoSuffixed, ['crypto.derivatives', 'crypto.institutional', 'crypto.onchain']);

		const fixedIncome = subCategories(await children(categoryByLabel(roots, 'Fixed Income')));
		const fiSuffixed = fixedIncome.filter(n => n.label.endsWith('(coming soon)')).map(n => n.subKey).sort();
		assert.deepStrictEqual(fiSuffixed, ['fi.corporate', 'fi.credit', 'fi.government', 'fi.structured']);
		const yieldCurve = fixedIncome.find(n => n.subKey === 'fi.yieldcurve');
		assert.ok(yieldCurve && !yieldCurve.label.includes('coming soon'), 'live yield curve must stay unmarked');

		const sentiment = subCategories(await children(categoryByLabel(roots, 'Sentiment')));
		const sentimentSuffixed = sentiment.filter(n => n.label.endsWith('(coming soon)')).map(n => n.subKey).sort();
		assert.deepStrictEqual(sentimentSuffixed, ['sentiment.feargreed', 'sentiment.optionsflow', 'sentiment.social']);
		for (const liveKey of ['sentiment.composite', 'sentiment.news']) {
			const live = sentiment.find(n => n.subKey === liveKey);
			assert.ok(live && !live.label.includes('coming soon'), `${liveKey} must stay unmarked`);
		}
	});

	test('fully-backed categories (Equities, Calendar) have no suffixed subcategories', async () => {
		const roots = await children();
		for (const label of ['Equities', 'Calendar']) {
			const subs = subCategories(await children(categoryByLabel(roots, label)));
			assert.ok(subs.length > 0, `${label} must have subcategories`);
			for (const sub of subs) {
				assert.ok(!sub.label.includes('coming soon'), `${label} subcategory '${sub.label}' must not be suffixed`);
			}
		}
	});

	test('coming-soon leaves stay reachable under a marked category', async () => {
		const forexMajor: SubCategoryNode = {
			nodeKind: 'subCategory',
			id: 'quantlab.subcat.forex.major',
			label: 'Major Pairs',
			subKey: 'forex.major',
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
		};
		const leaves = await children(forexMajor);
		assert.strictEqual(leaves.length, 1);
		assert.strictEqual(leaves[0].nodeKind, 'placeholder');
		assert.strictEqual(leaves[0].label, 'Forex major pairs planned');
	});

	test('L2: every underscore in a crypto symbol becomes a slash in the display label', () => {
		const accessor = provider as unknown as { cryptoInstrumentNode(s: CryptoSymbol): InstrumentNode };
		const node = accessor.cryptoInstrumentNode({
			symbol: 'BTC_USD_PERP',
			name: 'Bitcoin USD Perpetual',
			market_cap_rank: 1,
			current_price: 0,
			market_cap: 0,
			circulating_supply: 0,
			category: null,
			updated_at: '2026-06-11T00:00:00Z',
			exchange_count: 1,
		});
		assert.strictEqual(node.label, 'BTC/USD/PERP');
		// The raw symbol (used for routing) must stay untouched.
		assert.strictEqual(node.symbol, 'BTC_USD_PERP');
	});
});
