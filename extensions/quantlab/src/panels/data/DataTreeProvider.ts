/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GlobalState } from '../../core/state/GlobalState';
import { ServerApiClient, ServerSymbol, CryptoSymbol, EtfItem, IndexItem } from '../../core/server/ServerApiClient';
import { WatchlistManager, Watchlist } from './WatchlistManager';
import { isServerSource } from '../../types/market';

// ---- Node type union ----

export type DataNode =
	| CategoryNode
	| SubCategoryNode
	| SectorNode
	| InstrumentNode
	| WatchlistFolderNode
	| WatchlistNode
	| WatchlistItemNode
	| PlaceholderNode;

export type AssetCategory =
	| 'watchlists'
	| 'equities'
	| 'crypto'
	| 'forex'
	| 'commodities'
	| 'fixedIncome'
	| 'macro'
	| 'calendar'
	| 'sentiment';

export interface CategoryNode {
	nodeKind: 'category';
	id: string;
	label: string;
	categoryId: AssetCategory;
	icon: string;
	collapsibleState: vscode.TreeItemCollapsibleState;
}

export interface SubCategoryNode {
	nodeKind: 'subCategory';
	id: string;
	label: string;
	description?: string;
	icon?: string;
	subKey: string;          // e.g. 'equities.exchanges', 'equities.etfs', 'crypto.spot'
	command?: vscode.Command;
	collapsibleState: vscode.TreeItemCollapsibleState;
	badge?: string;          // e.g. symbol count
}

/**
 * Generic instrument-grouping node. `sector` is the group key: the exchange
 * for equities (the live /v1/symbols payload has no sector field) and the
 * BTC/ETH/Other buckets for crypto.
 */
export interface SectorNode {
	nodeKind: 'sector';
	id: string;
	label: string;
	description?: string;
	sector: string;
	assetClass: AssetCategory;
	collapsibleState: vscode.TreeItemCollapsibleState;
}

export interface InstrumentNode {
	nodeKind: 'instrument';
	id: string;
	label: string;
	description?: string;
	symbol: string;
	assetClass: AssetCategory;
	collapsibleState: vscode.TreeItemCollapsibleState;
	command?: vscode.Command;
}

export interface WatchlistFolderNode {
	nodeKind: 'watchlistFolder';
	id: string;
	label: string;
	collapsibleState: vscode.TreeItemCollapsibleState;
}

export interface WatchlistNode {
	nodeKind: 'watchlist';
	id: string;
	label: string;
	description?: string;
	watchlist: Watchlist;
	collapsibleState: vscode.TreeItemCollapsibleState;
}

export interface WatchlistItemNode {
	nodeKind: 'watchlistItem';
	id: string;
	label: string;
	symbol: string;
	watchlistId: string;
	collapsibleState: vscode.TreeItemCollapsibleState;
	command?: vscode.Command;
}

export interface PlaceholderNode {
	nodeKind: 'placeholder';
	id: string;
	label: string;
	description?: string;
	command?: vscode.Command;
	collapsibleState: vscode.TreeItemCollapsibleState;
}

// ---- Category definitions ----

const CATEGORIES: Array<{ id: AssetCategory; label: string; icon: string }> = [
	{ id: 'watchlists', label: 'Watchlists', icon: 'star' },
	{ id: 'equities', label: 'Equities', icon: 'graph' },
	{ id: 'crypto', label: 'Crypto', icon: 'symbol-misc' },
	{ id: 'forex', label: 'Forex', icon: 'arrow-swap' },
	{ id: 'commodities', label: 'Commodities', icon: 'package' },
	{ id: 'fixedIncome', label: 'Fixed Income', icon: 'briefcase' },
	{ id: 'macro', label: 'Macro', icon: 'globe' },
	{ id: 'calendar', label: 'Calendar', icon: 'calendar' },
	{ id: 'sentiment', label: 'Sentiment', icon: 'pulse' },
];

// ---- Provider ----

export class DataTreeProvider implements vscode.TreeDataProvider<DataNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<DataNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	// Per-section data caches
	private equitySymbols: ServerSymbol[] | undefined;
	private equityLoading = false;
	private equityError: string | undefined;

	private cryptoSymbols: CryptoSymbol[] | undefined;
	private cryptoSymbolSet = new Set<string>();
	private cryptoLoading = false;
	private cryptoLoadPromise: Promise<void> | undefined;
	private cryptoRetryCount = 0;
	private cryptoError: string | undefined;
	private cryptoRetryTimer: NodeJS.Timeout | undefined;

	private etfs: EtfItem[] | undefined;
	private etfsLoading = false;
	private etfRetryCount = 0;
	private etfError: string | undefined;
	private etfRetryTimer: NodeJS.Timeout | undefined;

	private indices: IndexItem[] | undefined;
	private indicesLoading = false;
	private indexRetryCount = 0;
	private indexError: string | undefined;
	private indexRetryTimer: NodeJS.Timeout | undefined;

	private retryCount = 0;
	private readonly maxRetries = 3;
	private retryTimer: NodeJS.Timeout | undefined;

	private lastAuthSignedIn: boolean | undefined;

	constructor(
		private readonly globalState: GlobalState,
		private readonly watchlistManager: WatchlistManager
	) {
		this.disposables.push(
			this.watchlistManager.onDidChange(() => this.refresh()),
			this.globalState.onDidChangeDataSource(() => this.refresh()),
			// Sign-in/out must re-drive the tree: before this, a tree loaded while
			// signed out kept its "Not signed in" failures forever after sign-in.
			// onAuthStateChange also fires on every ~15-min token refresh (M119);
			// only an actual signed-in/out transition wipes the caches, otherwise
			// the tree visibly flashes to "Loading..." mid-session.
			ServerApiClient.getInstance().onAuthStateChange(signedIn => {
				if (signedIn === this.lastAuthSignedIn) {
					return;
				}
				this.lastAuthSignedIn = signedIn;
				this.resetServerCaches();
				this.refresh();
			}),
		);
		// Pre-load equity symbols (most common access pattern)
		void this.loadEquitySymbols();
	}

	/** Drops all server-derived caches/errors so lazy loaders re-fetch with the new auth state. */
	private resetServerCaches(): void {
		this.clearRetryTimers();
		this.equitySymbols = undefined;
		this.equityError = undefined;
		this.retryCount = 0;
		this.cryptoSymbols = undefined;
		this.cryptoSymbolSet = new Set();
		this.cryptoError = undefined;
		this.cryptoRetryCount = 0;
		this.etfs = undefined;
		this.etfError = undefined;
		this.etfRetryCount = 0;
		this.indices = undefined;
		this.indexError = undefined;
		this.indexRetryCount = 0;
		void this.loadEquitySymbols();
	}

	/** Cancels every pending retry so a stale retry cannot fire after a cache reset or dispose (M2). */
	private clearRetryTimers(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.cryptoRetryTimer) {
			clearTimeout(this.cryptoRetryTimer);
			this.cryptoRetryTimer = undefined;
		}
		if (this.etfRetryTimer) {
			clearTimeout(this.etfRetryTimer);
			this.etfRetryTimer = undefined;
		}
		if (this.indexRetryTimer) {
			clearTimeout(this.indexRetryTimer);
			this.indexRetryTimer = undefined;
		}
	}

	// ---- TreeDataProvider interface ----

	getTreeItem(element: DataNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, element.collapsibleState);
		item.id = element.id;

		switch (element.nodeKind) {
			case 'category':
				item.iconPath = new vscode.ThemeIcon(element.icon);
				item.contextValue = `quantlab.category.${element.categoryId}`;
				break;

			case 'subCategory':
				if (element.icon) { item.iconPath = new vscode.ThemeIcon(element.icon); }
				item.description = element.badge ?? element.description;
				item.command = element.command;
				item.contextValue = 'quantlab.subCategory';
				break;

			case 'sector':
				item.iconPath = new vscode.ThemeIcon('folder');
				item.description = element.description;
				item.contextValue = 'quantlab.sector';
				break;

			case 'instrument': {
				const currentSource = this.globalState.getDataSource();
				const isCurrent = isServerSource(currentSource) && currentSource.symbol === element.symbol;
				item.iconPath = isCurrent ? new vscode.ThemeIcon('check') : new vscode.ThemeIcon('symbol-variable');
				item.description = element.description;
				item.command = element.command;
				item.contextValue = 'quantlab.data.serverSymbol';
				break;
			}

			case 'watchlistFolder':
				item.iconPath = new vscode.ThemeIcon('star');
				item.contextValue = 'quantlab.watchlistFolder';
				break;

			case 'watchlist':
				item.iconPath = new vscode.ThemeIcon('list-unordered');
				item.description = element.description;
				item.contextValue = 'quantlab.data.watchlist';
				break;

			case 'watchlistItem': {
				const currentSource = this.globalState.getDataSource();
				const isCurrent = isServerSource(currentSource) && currentSource.symbol === element.symbol;
				item.iconPath = isCurrent ? new vscode.ThemeIcon('check') : new vscode.ThemeIcon('symbol-variable');
				item.command = element.command;
				item.contextValue = 'quantlab.data.symbol';
				break;
			}

			case 'placeholder':
				item.iconPath = element.command ? new vscode.ThemeIcon('refresh') : new vscode.ThemeIcon('info');
				item.description = element.description;
				item.command = element.command;
				item.contextValue = 'quantlab.data.placeholder';
				break;
		}

		return item;
	}

	getChildren(element?: DataNode): DataNode[] | Thenable<DataNode[]> {
		if (!element) {
			return this.getRootNodes();
		}

		switch (element.nodeKind) {
			case 'category':
				return this.getCategoryChildren(element.categoryId);
			case 'subCategory':
				return this.getSubCategoryChildren(element.subKey);
			case 'sector':
				return this.getSectorChildren(element.sector, element.assetClass);
			case 'watchlist':
				return this.getWatchlistChildren(element.watchlist);
			default:
				return [];
		}
	}

	// ---- Root nodes ----

	private getRootNodes(): CategoryNode[] {
		return CATEGORIES.map(c => ({
			nodeKind: 'category' as const,
			id: `quantlab.category.${c.id}`,
			label: c.label,
			categoryId: c.id,
			icon: c.icon,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
		}));
	}

	// ---- Category children ----

	private getCategoryChildren(category: AssetCategory): DataNode[] {
		switch (category) {
			case 'watchlists': return this.getWatchlistFolderChildren();
			case 'equities': return this.getEquitiesChildren();
			case 'crypto': return this.getCryptoChildren();
			case 'forex': return this.getForexChildren();
			case 'commodities': return this.getCommoditiesChildren();
			case 'fixedIncome': return this.getFixedIncomeChildren();
			case 'macro': return this.getMacroChildren();
			case 'calendar': return this.getCalendarChildren();
			case 'sentiment': return this.getSentimentChildren();
			default: return [];
		}
	}

	// ---- Watchlists ----

	private getWatchlistFolderChildren(): DataNode[] {
		const watchlists = this.watchlistManager.getWatchlists();
		if (!watchlists.length) {
			return [this.placeholder('quantlab.watchlists.empty', 'No watchlists yet',
				{ command: 'quantlab.watchlist.create', title: 'New Watchlist' },
				'Click to create one')];
		}
		return watchlists.map(wl => ({
			nodeKind: 'watchlist' as const,
			id: `quantlab.watchlist.${wl.id}`,
			label: wl.name,
			description: `${wl.symbols.length} symbols`,
			watchlist: wl,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
		} satisfies WatchlistNode));
	}

	private async getWatchlistChildren(wl: Watchlist): Promise<DataNode[]> {
		if (!wl.symbols.length) {
			return [this.placeholder(`quantlab.watchlist.${wl.id}.empty`, 'Empty watchlist')];
		}
		// Bare crypto symbols (BTC) are indistinguishable from equity tickers
		// without the server coins list -- resolve it before routing, or a
		// cold tree would chart crypto against the equities bars endpoint.
		const hasServerSymbols = wl.symbols.some(sym => !sym.includes('/') && !sym.includes('\\') && !sym.endsWith('.csv'));
		if (hasServerSymbols && this.cryptoSymbolSet.size === 0) {
			await this.loadCryptoSymbols();
		}
		return wl.symbols.map(sym => {
			const isServerSymbol = !sym.includes('/') && !sym.includes('\\') && !sym.endsWith('.csv');
			return {
				nodeKind: 'watchlistItem' as const,
				id: `quantlab.watchlist.${wl.id}.${sym}`,
				label: sym,
				symbol: sym,
				watchlistId: wl.id,
				collapsibleState: vscode.TreeItemCollapsibleState.None,
				command: isServerSymbol ? {
					command: 'quantlab.openServerSymbol',
					title: 'Open',
					arguments: [sym, sym, this.isCryptoSymbol(sym) ? 'Crypto' : undefined]
				} : {
					command: 'quantlab.setGlobalDataSource',
					title: 'Open',
					arguments: [sym]
				},
			} satisfies WatchlistItemNode;
		});
	}

	// ---- Equities ----

	private getEquitiesChildren(): DataNode[] {
		return [
			this.subCategory('equities.overview', 'Market Overview', 'graph-line', undefined,
				{ command: 'quantlab.openMarketOverview', title: 'Market Overview' }),
			// Grouped by exchange: the live /v1/symbols payload has no sector
			// field (the old 'By Sector' grouping ran off a synthetic 'Other'
			// fallback that ServerApiClient no longer fabricates).
			this.subCategory('equities.exchanges', 'By Exchange', 'folder', undefined, undefined,
				this.equityLoading ? 'loading...' : this.equityError ? 'error' :
					this.equitySymbols ? `${this.equitySymbols.length} symbols` : undefined),
			this.subCategory('equities.etfs', 'ETFs', 'file', undefined, undefined,
				this.etfs ? `${this.etfs.length}` : undefined),
			this.subCategory('equities.indices', 'Indices', 'list-tree'),
			this.subCategory('equities.institutional', 'Institutional', 'organization',
				'Holdings · Insiders', { command: 'quantlab.openInstitutional', title: 'Institutional' }),
			this.subCategory('equities.fundamentals', 'Fundamentals', 'symbol-file',
				'Profile · Financials · Ratios', { command: 'quantlab.openFundamentals', title: 'Fundamentals' }),
		];
	}

	// ---- Crypto ----

	private getCryptoChildren(): DataNode[] {
		return [
			this.subCategory('crypto.overview', 'Market Overview', 'graph-line', undefined,
				{ command: 'quantlab.openCryptoOverview', title: 'Crypto Overview' }),
			this.subCategory('crypto.spot', 'Spot Markets', 'symbol-misc', undefined, undefined,
				this.cryptoSymbols ? `${this.cryptoSymbols.length} pairs` : undefined),
			this.subCategory('crypto.derivatives', 'Derivatives', 'graph-scatter',
				'Futures · Funding · OI', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('crypto.onchain', 'On-Chain', 'link',
				'Flows · Whales · Network', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('crypto.institutional', 'Institutional', 'organization',
				'ETF Flows · Treasury Holdings', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
		];
	}

	// ---- Forex ----

	private getForexChildren(): DataNode[] {
		return [
			this.subCategory('forex.major', 'Major Pairs', 'arrow-swap',
				'EUR/USD · GBP/USD · USD/JPY'),
			this.subCategory('forex.minor', 'Minor Pairs', 'arrow-swap'),
			this.subCategory('forex.exotic', 'Exotic Pairs', 'arrow-swap'),
			this.subCategory('forex.derivatives', 'Derivatives', 'graph-scatter',
				'FX Options · Forward Curves', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('forex.positioning', 'Positioning (COT)', 'graph-line',
				undefined, undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('forex.centralbanks', 'Central Banks', 'bank',
				'Fed · ECB · BoJ · BoE', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
		];
	}

	// ---- Commodities ----

	private getCommoditiesChildren(): DataNode[] {
		return [
			this.subCategory('commodities.energy', 'Energy', 'flame',
				'Crude Oil · Natural Gas · Gasoline'),
			this.subCategory('commodities.metals', 'Metals', 'circle-outline',
				'Gold · Silver · Copper · Platinum'),
			this.subCategory('commodities.agriculture', 'Agriculture', 'layers',
				'Wheat · Corn · Soybeans · Sugar'),
			this.subCategory('commodities.futures', 'Futures Curves', 'graph-line',
				'Term Structure · Contango / Backwardation', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('commodities.positioning', 'Positioning (COT)', 'graph-scatter',
				undefined, undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
		];
	}

	// ---- Fixed Income ----

	private getFixedIncomeChildren(): DataNode[] {
		return [
			this.subCategory('fi.yieldcurve', 'Yield Curves', 'graph-line',
				'US · UK · EU · JP', { command: 'quantlab.openYieldCurve', title: 'Yield Curves' }),
			this.subCategory('fi.government', 'Government Bonds', 'globe',
				'Treasuries · Gilts · Bunds'),
			this.subCategory('fi.corporate', 'Corporate', 'briefcase',
				'Investment Grade · High Yield'),
			this.subCategory('fi.structured', 'Structured', 'symbol-file',
				'MBS · ABS · CLOs', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('fi.credit', 'Credit', 'graph-scatter',
				'CDS Spreads · Credit Indices', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
		];
	}

	// ---- Macro ----

	private getMacroChildren(): DataNode[] {
		return [
			this.subCategory('macro.growth', 'Growth', 'trending-up',
				'GDP · PMI · Industrial Production'),
			this.subCategory('macro.inflation', 'Inflation', 'symbol-numeric',
				'CPI · PPI · PCE · Breakevens'),
			this.subCategory('macro.employment', 'Employment', 'person',
				'NFP · Unemployment · Wages'),
			this.subCategory('macro.trade', 'Trade & External', 'globe',
				'Trade Balance · Current Account'),
			this.subCategory('macro.money', 'Money & Credit', 'credit-card',
				'M2 · Bank Credit · Credit Impulse'),
			this.subCategory('macro.housing', 'Housing', 'home',
				'Starts · Permits · Home Prices', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('macro.leading', 'Leading Indicators', 'graph-line',
				'Conference Board · OECD CLI', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
		];
	}

	// ---- Calendar ----

	private getCalendarChildren(): DataNode[] {
		return [
			this.subCategory('calendar.economic', 'Economic Events', 'calendar',
				'GDP · CPI · PMI · Jobs', { command: 'quantlab.openEconomicCalendar', title: 'Economic Calendar' }),
			this.subCategory('calendar.earnings', 'Earnings', 'graph',
				undefined, { command: 'quantlab.openEarningsCalendar', title: 'Earnings Calendar' }),
			this.subCategory('calendar.dividends', 'Dividends', 'symbol-numeric',
				undefined, { command: 'quantlab.openDividendsCalendar', title: 'Dividends' }),
			this.subCategory('calendar.ipos', 'IPOs', 'rocket',
				undefined, { command: 'quantlab.openIPOCalendar', title: 'IPOs' }),
			this.subCategory('calendar.splits', 'Stock Splits', 'split-horizontal',
				undefined, { command: 'quantlab.openSplitsCalendar', title: 'Stock Splits' }),
			this.subCategory('calendar.centralbank', 'Central Bank', 'bank',
				'FOMC · ECB · BoJ', { command: 'quantlab.openCentralBankCalendar', title: 'Central Bank' }),
		];
	}

	// ---- Sentiment ----

	private getSentimentChildren(): DataNode[] {
		return [
			this.subCategory('sentiment.composite', 'Market Sentiment', 'pulse',
				undefined, { command: 'quantlab.openSentimentDashboard', title: 'Sentiment' }),
			this.subCategory('sentiment.news', 'News Flow', 'comment',
				'Breaking · Trending · By Symbol', { command: 'quantlab.openNewsFlow', title: 'News Flow' }),
			this.subCategory('sentiment.social', 'Social Buzz', 'megaphone',
				undefined, undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('sentiment.optionsflow', 'Options Flow', 'graph-scatter',
				'Unusual Activity · Dark Pool', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
			this.subCategory('sentiment.feargreed', 'Fear & Greed', 'symbol-key',
				undefined, undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
		];
	}

	// ---- SubCategory children (lazy data loads) ----

	private getSubCategoryChildren(subKey: string): DataNode[] | Thenable<DataNode[]> {
		switch (subKey) {
			// Equities
			case 'equities.exchanges':
				return this.getEquityExchangeNodes();
			case 'equities.etfs':
				return this.getEtfNodes();
			case 'equities.indices':
				return this.getIndexNodes();
			// equities.institutional and equities.fundamentals are now leaf-node commands (no children)

			// Crypto
			case 'crypto.spot':
				return this.getCryptoSpotNodes();
			case 'crypto.derivatives':
			case 'crypto.onchain':
			case 'crypto.institutional':
				return this.getComingSoonNodes(subKey);

			// Stubs for future data
			case 'forex.major':
			case 'forex.minor':
			case 'forex.exotic':
			case 'forex.derivatives':
			case 'forex.positioning':
			case 'forex.centralbanks':
			case 'commodities.energy':
			case 'commodities.metals':
			case 'commodities.agriculture':
			case 'commodities.futures':
			case 'commodities.positioning':
			case 'fi.government':
			case 'fi.corporate':
			case 'fi.structured':
			case 'fi.credit':
			case 'macro.growth':
			case 'macro.inflation':
			case 'macro.employment':
			case 'macro.trade':
			case 'macro.money':
			case 'macro.housing':
			case 'macro.leading':
			case 'sentiment.social':
			case 'sentiment.optionsflow':
			case 'sentiment.feargreed':
				return this.getComingSoonNodes(subKey);

			default:
				return [];
		}
	}

	// ---- Equity exchange nodes (lazy) ----

	private async getEquityExchangeNodes(): Promise<DataNode[]> {
		if (!this.equitySymbols) {
			if (!this.equityLoading) {
				void this.loadEquitySymbols();
			}
			return [this.placeholder('equities.exchanges.loading', 'Loading symbols...')];
		}
		if (this.equityError) {
			return [this.errorPlaceholder('equities.exchanges.error', this.equityError,
				{ command: 'quantlab.reloadServerSymbols', title: 'Retry' })];
		}
		if (!this.equitySymbols.length) {
			return [this.placeholder('equities.exchanges.empty', 'No symbols available')];
		}

		// Group by the real exchange field from /v1/symbols
		const exchangeMap = new Map<string, number>();
		for (const s of this.equitySymbols) {
			exchangeMap.set(s.exchange, (exchangeMap.get(s.exchange) ?? 0) + 1);
		}

		const exchanges = Array.from(exchangeMap.keys()).sort((a, b) => a.localeCompare(b));

		return exchanges.map(exchange => ({
			nodeKind: 'sector' as const,
			id: `quantlab.exchange.${exchange}`,
			label: exchange,
			description: `${exchangeMap.get(exchange)} symbols`,
			sector: exchange,
			assetClass: 'equities' as AssetCategory,
			collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
		} satisfies SectorNode));
	}

	private getSectorChildren(sector: string, assetClass: AssetCategory): DataNode[] {
		if (assetClass === 'equities' && this.equitySymbols) {
			return this.equitySymbols
				.filter(s => s.exchange === sector)
				.map(s => this.equityInstrumentNode(s));
		}
		if (assetClass === 'crypto' && this.cryptoSymbols) {
			// Mirror the rank-based grouping rule in getCryptoSpotNodes.
			const inTop25 = (s: CryptoSymbol) => s.market_cap_rank >= 1 && s.market_cap_rank <= 25;
			const inTop100 = (s: CryptoSymbol) => s.market_cap_rank > 25 && s.market_cap_rank <= 100;
			return this.cryptoSymbols
				.filter(s => {
					if (sector === 'crypto-top25') { return inTop25(s); }
					if (sector === 'crypto-top100') { return inTop100(s); }
					return !inTop25(s) && !inTop100(s);
				})
				.sort((a, b) => a.market_cap_rank - b.market_cap_rank)
				.map(s => this.cryptoInstrumentNode(s));
		}
		return [this.placeholder(`sector.${sector}.empty`, 'No data')];
	}

	private equityInstrumentNode(s: ServerSymbol): InstrumentNode {
		return {
			nodeKind: 'instrument',
			id: `quantlab.instrument.equity.${s.symbol}`,
			label: s.symbol,
			description: s.name,
			symbol: s.symbol,
			assetClass: 'equities',
			collapsibleState: vscode.TreeItemCollapsibleState.None,
			command: {
				command: 'quantlab.openServerSymbol',
				title: 'Open',
				arguments: [s.symbol, s.name, 'equities']
			},
		};
	}

	// ---- ETF nodes (lazy) ----

	private async getEtfNodes(): Promise<DataNode[]> {
		if (!this.etfs) {
			if (!this.etfsLoading) {
				void this.loadEtfs();
			}
			return [this.placeholder('equities.etfs.loading', 'Loading ETFs...')];
		}
		if (!this.etfs.length) {
			if (this.etfError) {
				return [this.errorPlaceholder('equities.etfs.error', this.etfError,
					{ command: 'quantlab.reloadDataSection', title: 'Retry', arguments: ['etfs'] })];
			}
			return [this.placeholder('equities.etfs.empty', 'No ETFs available')];
		}
		return this.etfs.map(etf => ({
			nodeKind: 'instrument' as const,
			id: `quantlab.instrument.etf.${etf.ticker}`,
			label: etf.ticker,
			description: etf.name,
			symbol: etf.ticker,
			assetClass: 'equities' as AssetCategory,
			collapsibleState: vscode.TreeItemCollapsibleState.None,
			command: {
				command: 'quantlab.openServerSymbol',
				title: 'Open',
				arguments: [etf.ticker, etf.name, 'ETF']
			},
		} satisfies InstrumentNode));
	}

	// ---- Index nodes (lazy) ----

	private async getIndexNodes(): Promise<DataNode[]> {
		if (!this.indices) {
			if (!this.indicesLoading) {
				void this.loadIndices();
			}
			return [this.placeholder('equities.indices.loading', 'Loading indices...')];
		}
		if (!this.indices.length) {
			if (this.indexError) {
				return [this.errorPlaceholder('equities.indices.error', this.indexError,
					{ command: 'quantlab.reloadDataSection', title: 'Retry', arguments: ['indices'] })];
			}
			return [this.placeholder('equities.indices.empty', 'No indices available')];
		}
		return this.indices.map(idx => {
			const sym = idx.symbol ?? idx.id ?? 'INDEX';
			return {
				nodeKind: 'instrument' as const,
				id: `quantlab.instrument.index.${sym}`,
				label: sym,
				description: idx.name,
				symbol: sym,
				assetClass: 'equities' as AssetCategory,
				collapsibleState: vscode.TreeItemCollapsibleState.None,
				command: {
					command: 'quantlab.openServerSymbol',
					title: 'Open',
					arguments: [sym, idx.name, 'Index']
				},
			} satisfies InstrumentNode;
		});
	}

	// ---- Crypto spot nodes (lazy) ----

	private async getCryptoSpotNodes(): Promise<DataNode[]> {
		if (!this.cryptoSymbols) {
			if (!this.cryptoLoading) {
				void this.loadCryptoSymbols();
			}
			return [this.placeholder('crypto.spot.loading', 'Loading crypto pairs...')];
		}
		if (!this.cryptoSymbols.length) {
			if (this.cryptoError) {
				return [this.errorPlaceholder('crypto.spot.error', this.cryptoError,
					{ command: 'quantlab.reloadDataSection', title: 'Retry', arguments: ['crypto'] })];
			}
			return [this.placeholder('crypto.spot.empty', 'No crypto symbols available')];
		}

		// Group by market-cap rank -- the only ordering field the live coins
		// carry. (The old BTC/ETH symbol-prefix groups mis-bucketed coins
		// like ETHFI/BTCS and held a single coin each.)
		const top25 = this.cryptoSymbols.filter(s => s.market_cap_rank >= 1 && s.market_cap_rank <= 25);
		const top100 = this.cryptoSymbols.filter(s => s.market_cap_rank > 25 && s.market_cap_rank <= 100);
		const rest = this.cryptoSymbols.filter(s => !(s.market_cap_rank >= 1 && s.market_cap_rank <= 100));

		const nodes: DataNode[] = [];

		if (top25.length) {
			nodes.push({
				nodeKind: 'sector',
				id: 'quantlab.crypto.top25',
				label: 'Top 25',
				description: `${top25.length} coins`,
				sector: 'crypto-top25',
				assetClass: 'crypto',
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			} satisfies SectorNode);
		}
		if (top100.length) {
			nodes.push({
				nodeKind: 'sector',
				id: 'quantlab.crypto.top100',
				label: 'Top 26-100',
				description: `${top100.length} coins`,
				sector: 'crypto-top100',
				assetClass: 'crypto',
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			} satisfies SectorNode);
		}
		if (rest.length) {
			nodes.push({
				nodeKind: 'sector',
				id: 'quantlab.crypto.rest',
				label: 'Beyond Top 100',
				description: `${rest.length} coins`,
				sector: 'crypto-rest',
				assetClass: 'crypto',
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
			} satisfies SectorNode);
		}

		return nodes;
	}

	private cryptoInstrumentNode(s: CryptoSymbol): InstrumentNode {
		return {
			nodeKind: 'instrument',
			id: `quantlab.instrument.crypto.${s.symbol}`,
			label: s.symbol.replace('_', '/'),
			description: s.name,
			symbol: s.symbol,
			assetClass: 'crypto',
			collapsibleState: vscode.TreeItemCollapsibleState.None,
			command: {
				command: 'quantlab.openServerSymbol',
				title: 'Open',
				arguments: [s.symbol, s.name ?? s.symbol, 'Crypto']
			},
		};
	}

	// ---- Crypto symbol detection ----

	private isCryptoSymbol(symbol: string): boolean {
		// Live coins are bare symbols (BTC, ETH) -- indistinguishable from
		// equity tickers without the server coins list, so membership is the
		// only test. Callers that must route correctly (watchlists) await
		// loadCryptoSymbols() first.
		if (this.cryptoSymbolSet.size === 0 && !this.cryptoLoading) {
			void this.loadCryptoSymbols();
		}
		return this.cryptoSymbolSet.has(symbol);
	}

	// ---- Coming soon / stub nodes ----

	private getComingSoonNodes(key: string): DataNode[] {
		const messages: Record<string, string> = {
			'crypto.derivatives': 'Crypto derivatives data planned',
			'crypto.onchain': 'On-chain analytics planned',
			'crypto.institutional': 'Crypto institutional data planned',
			'forex.major': 'Forex major pairs planned',
			'forex.minor': 'Forex minor pairs planned',
			'forex.exotic': 'Forex exotic pairs planned',
			'forex.derivatives': 'FX derivatives planned',
			'forex.positioning': 'COT positioning data planned',
			'forex.centralbanks': 'Central bank data planned',
			'commodities.energy': 'Energy commodities planned',
			'commodities.metals': 'Metals data planned',
			'commodities.agriculture': 'Agriculture data planned',
			'commodities.futures': 'Futures curves planned',
			'commodities.positioning': 'COT positioning planned',
			'fi.government': 'Government bonds planned',
			'fi.corporate': 'Corporate bonds planned',
			'fi.structured': 'Structured products planned',
			'fi.credit': 'Credit spreads planned',
			'macro.growth': 'GDP & growth indicators planned',
			'macro.inflation': 'Inflation indicators planned',
			'macro.employment': 'Employment data planned',
			'macro.trade': 'Trade balance data planned',
			'macro.money': 'Money & credit data planned',
			'macro.housing': 'Housing data planned',
			'macro.leading': 'Leading indicators planned',
			'sentiment.social': 'Social sentiment planned',
			'sentiment.optionsflow': 'Options flow data planned',
			'sentiment.feargreed': 'Fear & greed index planned',
		};
		const msg = messages[key] ?? 'Data coming soon';
		return [this.placeholder(`${key}.soon`, msg, undefined, 'Expanding data coverage')];
	}

	// ---- Data loaders ----

	private async loadEquitySymbols(): Promise<void> {
		if (this.disposed || this.equityLoading) { return; }
		this.equityLoading = true;
		this.equityError = undefined;
		this.refresh();

		try {
			const client = ServerApiClient.getInstance();
			this.equitySymbols = await client.getSymbols();
			this.retryCount = 0;
		} catch (err) {
			this.equityError = err instanceof Error ? err.message : 'Unknown error';
			this.equitySymbols = [];
			if (this.retryCount < this.maxRetries) {
				this.retryCount++;
				const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
				this.retryTimer = setTimeout(() => {
					this.retryTimer = undefined;
					this.equityLoading = false;
					void this.loadEquitySymbols();
				}, delay);
			}
		} finally {
			this.equityLoading = false;
			this.refresh();
		}
	}

	private loadCryptoSymbols(): Promise<void> {
		// Hand awaiting callers the in-flight load instead of the
		// re-entrancy guard's early return.
		if (this.cryptoLoadPromise) { return this.cryptoLoadPromise; }
		this.cryptoLoadPromise = this.doLoadCryptoSymbols().finally(() => {
			this.cryptoLoadPromise = undefined;
		});
		return this.cryptoLoadPromise;
	}

	private async doLoadCryptoSymbols(): Promise<void> {
		if (this.disposed || this.cryptoLoading) { return; }
		this.cryptoLoading = true;
		try {
			const client = ServerApiClient.getInstance();
			this.cryptoSymbols = await client.getCryptoSymbols();
			this.cryptoSymbolSet = new Set(this.cryptoSymbols.map(s => s.symbol));
			this.cryptoRetryCount = 0;
			this.cryptoError = undefined;
		} catch (err) {
			this.cryptoError = err instanceof Error ? err.message : String(err);
			this.cryptoSymbols = [];
			if (this.cryptoRetryCount < this.maxRetries) {
				this.cryptoRetryCount++;
				const delay = Math.min(1000 * Math.pow(2, this.cryptoRetryCount), 30000);
				this.cryptoRetryTimer = setTimeout(() => {
					this.cryptoRetryTimer = undefined;
					this.cryptoLoading = false;
					void this.loadCryptoSymbols();
				}, delay);
			}
		} finally {
			this.cryptoLoading = false;
			this.refresh();
		}
	}

	private async loadEtfs(): Promise<void> {
		if (this.disposed || this.etfsLoading) { return; }
		this.etfsLoading = true;
		try {
			const client = ServerApiClient.getInstance();
			this.etfs = await client.getEtfs();
			this.etfRetryCount = 0;
			this.etfError = undefined;
		} catch (err) {
			this.etfError = err instanceof Error ? err.message : String(err);
			this.etfs = [];
			if (this.etfRetryCount < this.maxRetries) {
				this.etfRetryCount++;
				const delay = Math.min(1000 * Math.pow(2, this.etfRetryCount), 30000);
				this.etfRetryTimer = setTimeout(() => {
					this.etfRetryTimer = undefined;
					this.etfsLoading = false;
					void this.loadEtfs();
				}, delay);
			}
		} finally {
			this.etfsLoading = false;
			this.refresh();
		}
	}

	private async loadIndices(): Promise<void> {
		if (this.disposed || this.indicesLoading) { return; }
		this.indicesLoading = true;
		try {
			const client = ServerApiClient.getInstance();
			this.indices = await client.getGlobalIndices();
			this.indexRetryCount = 0;
			this.indexError = undefined;
		} catch (err) {
			this.indexError = err instanceof Error ? err.message : String(err);
			this.indices = [];
			if (this.indexRetryCount < this.maxRetries) {
				this.indexRetryCount++;
				const delay = Math.min(1000 * Math.pow(2, this.indexRetryCount), 30000);
				this.indexRetryTimer = setTimeout(() => {
					this.indexRetryTimer = undefined;
					this.indicesLoading = false;
					void this.loadIndices();
				}, delay);
			}
		} finally {
			this.indicesLoading = false;
			this.refresh();
		}
	}

	// ---- Helpers ----

	private subCategory(
		subKey: string,
		label: string,
		icon?: string,
		description?: string,
		command?: vscode.Command,
		badge?: string,
		collapsibleState = vscode.TreeItemCollapsibleState.Collapsed,
	): SubCategoryNode {
		return {
			nodeKind: 'subCategory',
			id: `quantlab.subcat.${subKey}`,
			label,
			description,
			icon,
			subKey,
			command,
			badge,
			collapsibleState: command ? vscode.TreeItemCollapsibleState.None : collapsibleState,
		};
	}

	/**
	 * Error placeholder for server-backed nodes. A signed-out failure becomes an
	 * actionable "Sign in" entry instead of a cryptic error string; any other
	 * failure carries the optional retry command (M7).
	 */
	private errorPlaceholder(id: string, error: string, retry?: vscode.Command): PlaceholderNode {
		if (/not signed in/i.test(error)) {
			return this.placeholder(id, 'Sign in to load live data',
				{ command: 'quantlab.signIn', title: 'Sign In' });
		}
		return this.placeholder(id, `Failed to load: ${error}`, retry);
	}

	private placeholder(id: string, label: string, command?: vscode.Command, description?: string): PlaceholderNode {
		return {
			nodeKind: 'placeholder',
			id: `quantlab.placeholder.${id}`,
			label,
			description,
			command,
			collapsibleState: vscode.TreeItemCollapsibleState.None,
		};
	}

	// ---- Public methods ----

	refresh(): void {
		if (!this.disposed) {
			this._onDidChangeTreeData.fire();
		}
	}

	reloadServerSymbols(): void {
		this.reloadSection('equities');
	}

	/** Drops one section's cache/error/backoff state and re-fetches it (M7 retry affordance). */
	reloadSection(section: 'equities' | 'crypto' | 'etfs' | 'indices'): void {
		if (this.disposed) { return; }
		switch (section) {
			case 'equities':
				if (this.retryTimer) {
					clearTimeout(this.retryTimer);
					this.retryTimer = undefined;
				}
				this.equitySymbols = undefined;
				this.equityError = undefined;
				this.retryCount = 0;
				void this.loadEquitySymbols();
				break;
			case 'crypto':
				if (this.cryptoRetryTimer) {
					clearTimeout(this.cryptoRetryTimer);
					this.cryptoRetryTimer = undefined;
				}
				this.cryptoSymbols = undefined;
				this.cryptoSymbolSet = new Set();
				this.cryptoError = undefined;
				this.cryptoRetryCount = 0;
				void this.loadCryptoSymbols();
				break;
			case 'etfs':
				if (this.etfRetryTimer) {
					clearTimeout(this.etfRetryTimer);
					this.etfRetryTimer = undefined;
				}
				this.etfs = undefined;
				this.etfError = undefined;
				this.etfRetryCount = 0;
				void this.loadEtfs();
				break;
			case 'indices':
				if (this.indexRetryTimer) {
					clearTimeout(this.indexRetryTimer);
					this.indexRetryTimer = undefined;
				}
				this.indices = undefined;
				this.indexError = undefined;
				this.indexRetryCount = 0;
				void this.loadIndices();
				break;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.clearRetryTimers();
		for (const d of this.disposables) { d.dispose(); }
		this.disposables.length = 0;
		this._onDidChangeTreeData.dispose();
	}
}
