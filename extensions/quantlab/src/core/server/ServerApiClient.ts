/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ResourcesCatalogResponse, ResourceToolDetail } from '../../types/resources';
import { ServerToolExecutePayload, ServerToolExecuteResponse, ToolJobStatusResponse } from '../../types/toolExecution';
import { createHostDataTransport, HOST_DATA_UNAVAILABLE, HostDataTransport } from '../host/hostDataTransport';

// QL-DATA: every data call goes through the host. The transport in ../host/hostDataTransport.ts is the one
// door; this file holds no backend origin, no http(s) or WebSocket client and no token. The host answers
// the parsed 2xx JSON (the backend's {success, data} envelope is unwrapped here) or rejects with a coded
// error, which every method passes on unchanged.

/** A short, printable preview of a response for shape errors (JSON.stringify(undefined) is undefined). */
function preview(value: unknown): string {
	const json = JSON.stringify(value);
	return json === undefined ? String(value) : json.slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The object a method promises, or a named shape error (an empty or non-object answer is never cast). */
function expectRecord<T>(label: string, value: unknown): T {
	if (!isRecord(value)) {
		throw new Error(`Unexpected ${label} response shape: ${preview(value)}`);
	}
	return value as unknown as T;
}

// Types matching server API
export interface ServerUser {
	id: string;
	email: string;
	// The host identity's name is optional (contract: string | undefined).
	name?: string;
	// AUTH-TIER: the tier is real on the backend but the host identity does not carry it yet; the
	// carry AUTH-TIER supplies the value. Until then it is absent and every display renders no tier.
	tier?: string;
}

// Live /v1/symbols shape (verified 2026-06-11). The server has NO sector and
// NO base_price field -- do not re-introduce synthetic defaults for them.
export interface ServerSymbol {
	symbol: string;
	name: string;
	asset_type: string;
	exchange: string;
	currency: string;
	price_precision: number;
	size_precision: number;
	min_tick: number;
	lot_size: number;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface ServerBar {
	symbol: string;
	timestamp: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	vwap?: number;
	trade_count?: number;
}

export interface ServerWatchlist {
	id: string;
	name: string;
	symbols: string[];
	is_default: boolean;
	sort_order: number;
}

export interface ServerAlert {
	id: string;
	symbol: string;
	condition: 'crosses_above' | 'crosses_below' | 'rises_by' | 'falls_by';
	price: string;
	message: string;
	status: 'active' | 'triggered' | 'cancelled';
	notify_email: boolean;
	notify_push: boolean;
	triggered_at?: string;
	created_at?: string;
	updated_at?: string;
}

export type ServerTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W' | '1M';

// Live /v1/crypto/symbols coin shape (verified 2026-06-11).
export interface CryptoSymbol {
	symbol: string;
	name: string;
	market_cap_rank: number;
	current_price: number;
	market_cap: number;
	circulating_supply: number;
	image_url?: string;
	category: string | null;
	updated_at: string;
	exchange_count: number;
}

export interface EtfItem {
	ticker: string;
	name?: string;
	category?: string;
	aum?: number;
	expense_ratio?: number;
}

export interface IndexItem {
	id?: string;
	symbol?: string;
	name?: string;
	region?: string;
	country?: string;
	value?: number;
	change_pct?: number;
}

// Live /v1/fixed-income/yield-curve shape (verified 2026-06-11): a bare array
// of {metric, value} records -- no date grouping, no tenor map.
export interface YieldCurvePoint {
	metric: string;
	value: number;
}

// ---- Calendar interfaces ----

// All /v1/calendar/* endpoints share one unified event schema (verified live
// 2026-06-11). Symbol/company/eps data is embedded in event_name, not split out.
export interface CalendarEvent {
	id: string;
	event_type: string;
	event_name: string;
	datetime_utc: string;
	importance: string;
	is_tentative: boolean;
	country_code?: string;
	primary_source?: string;
}

// The calendar envelope after {success,data} unwrap: {events, total, limit,
// offset, has_more}. Pagination fields are exposed so callers can page.
export interface CalendarPage {
	events: CalendarEvent[];
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
}

// ---- Sentiment & News interfaces ----

// Live /v1/sentiment/:symbol shape (verified 2026-06-11). There is no 'score'
// field; percentages are 0-100 server-side units.
export interface SentimentData {
	symbol: string;
	overall_sentiment: string;
	bullish_percent: number;
	bearish_percent: number;
	neutral_percent: number;
	news_count: number;
	updated_at: string;
}

// Live /v1/news/ item shape (verified 2026-06-11): has categories, no
// symbols/sentiment fields.
export interface NewsItem {
	id: string;
	source: string;
	title: string;
	summary?: string;
	url?: string;
	categories?: string[];
	published_at: string;
}

// ---- Fundamentals interfaces ----

export interface FundamentalsProfile {
	symbol?: string;
	name?: string;
	sector?: string;
	industry?: string;
	market_cap?: number;
	description?: string;
	ceo?: string;
	employees?: number;
	headquarters?: string;
	website?: string;
	exchange?: string;
	currency?: string;
	country?: string;
	founded?: string;
	ipo_date?: string;
	asset_type?: string;
	shares_outstanding?: number;
	float?: number;
	avg_volume_30d?: number;
	high_52w?: number;
	low_52w?: number;
	dividend_yield?: number;
	dividend_per_share?: number;
	ex_dividend_date?: string;
	payment_frequency?: string;
	pe?: number;
	price_to_book?: number;
	eps?: number;
	revenue?: number;
	profit_margin?: number;
	operating_margin?: number;
	roe?: number;
	roa?: number;
	debt_to_equity?: number;
	current_ratio?: number;
	ev_to_ebitda?: number;
	[key: string]: unknown;
}

// Live /v1/fundamentals/financials/:symbol statement entry (verified 2026-06-11).
export interface FinancialStatement {
	period: string;
	period_end: string;
	filed_at?: string;
	revenue?: number;
	cost_of_revenue?: number;
	gross_profit?: number;
	gross_margin?: number;
	research_dev?: number;
	selling_gen_admin?: number;
	operating_expenses?: number;
	operating_income?: number;
	operating_margin?: number;
	interest_expense?: number;
	other_income?: number;
	pretax_income?: number;
	income_tax?: number;
	net_income?: number;
	net_margin?: number;
	eps?: number;
	eps_diluted?: number;
	shares_outstanding?: number;
	shares_diluted?: number;
	ebitda?: number;
}

// Live shape: financial line items are nested inside statements[], newest first.
export interface FundamentalsFinancials {
	symbol: string;
	type: string;
	period: string;
	statements: FinancialStatement[];
	count: number;
}

// Live /v1/fundamentals/ratios/:symbol shape (verified 2026-06-11): names are
// *_ratio suffixed; margins/returns are fractions (0..1).
export interface FundamentalsRatios {
	symbol: string;
	timestamp?: number;
	pe_ratio?: number;
	peg_ratio?: number;
	pb_ratio?: number;
	ps_ratio?: number;
	ev_to_ebitda?: number;
	ev_to_revenue?: number;
	price_to_fcf?: number;
	roe?: number;
	roa?: number;
	roic?: number;
	gross_margin?: number;
	operating_margin?: number;
	net_margin?: number;
	debt_to_equity?: number;
	debt_to_ebitda?: number;
	current_ratio?: number;
	quick_ratio?: number;
	interest_coverage?: number;
	revenue_growth?: number;
	earnings_growth?: number;
	fcf_growth?: number;
	eps?: number;
	book_value_per_share?: number;
	revenue_per_share?: number;
	fcf_per_share?: number;
	dividend_yield?: number;
	payout_ratio?: number;
	beta?: number;
	short_float?: number;
	institutional_ownership?: number;
}

// ---- Institutional interfaces ----

export interface InstitutionalHolding {
	holder?: string;
	shares?: number;
	value?: number;
	change?: number;
	date_reported?: string;
	[key: string]: unknown;
}

export interface InsiderTransaction {
	name?: string;
	title?: string;
	transaction_type?: string;
	shares?: number;
	price?: number;
	value?: number;
	date?: string;
	[key: string]: unknown;
}

export interface BarsRequest {
	symbol: string;
	timeframe: ServerTimeframe;
	from?: number;
	to?: number;
	limit?: number;
	assetClass?: string;
}

export class ServerApiClient {
	private static instance: ServerApiClient | undefined;

	private user: ServerUser | undefined;

	// The one data door, resolved once from vscode.quantlabHost. Absent host API: every call rejects
	// with HOST_DATA_UNAVAILABLE (window decision Q-1 (a)).
	private readonly transport: HostDataTransport;

	private readonly _onAuthStateChange = new vscode.EventEmitter<boolean>();
	readonly onAuthStateChange = this._onAuthStateChange.event;

	// No token store lives here: the signed-in user is pushed in by setHostIdentity().

	private disposed: boolean = false;
	private readonly outputChannel: vscode.OutputChannel;

	// Logging helper
	private log(message: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}

	private constructor() {
		this.outputChannel = vscode.window.createOutputChannel('Quantlab Server');
		this.transport = createHostDataTransport();
		if (!this.transport.available) {
			this.log(`${HOST_DATA_UNAVAILABLE}: every data call rejects with this error`);
		}
	}

	static getInstance(): ServerApiClient {
		if (!ServerApiClient.instance) {
			ServerApiClient.instance = new ServerApiClient();
		}
		return ServerApiClient.instance;
	}

	/**
	 * Disposes all resources held by this client.
	 * Call this when the extension is deactivated.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;

		// Dispose all EventEmitters
		this._onAuthStateChange.dispose();

		// Dispose output channel
		this.outputChannel.dispose();

		// Clear authentication state
		this.user = undefined;
	}

	/**
	 * Resets the singleton instance. Primarily for testing.
	 */
	static resetInstance(): void {
		if (ServerApiClient.instance) {
			ServerApiClient.instance.dispose();
			ServerApiClient.instance = undefined;
		}
	}

	/**
	 * Apply the host identity (QL-LOGIN): called by DeltaPlusAuthProvider after it pulls the sign-in
	 * state from the host. The client holds the user's display fields only -- no token, no refresh
	 * token, no expiry. Fires onAuthStateChange only when the signed-in state or the user's fields
	 * changed, so consumers that re-fetch on every fire do not re-fetch on every identity pull.
	 */
	setHostIdentity(user: ServerUser | undefined): void {
		const previous = this.user;
		this.user = user;

		const changed = previous?.id !== user?.id
			|| previous?.email !== user?.email
			|| previous?.name !== user?.name
			|| previous?.tier !== user?.tier;
		if (!changed) { return; }

		if (user && !previous) {
			this.log('Signed in via the host identity');
		}
		this._onAuthStateChange.fire(!!user);
	}

	isAuthenticated(): boolean {
		return this.user !== undefined;
	}

	getUser(): ServerUser | undefined {
		return this.user;
	}

	/**
	 * One data call through the host. The host's rejection (with its code) propagates unchanged; a
	 * {success, data} envelope is unwrapped, and a {success: false} envelope throws its message.
	 */
	private async call(op: string, input: Record<string, unknown>, token?: vscode.CancellationToken): Promise<unknown> {
		const body = await this.transport.request(op, input, token);
		if (isRecord(body) && Object.prototype.hasOwnProperty.call(body, 'success') && Object.prototype.hasOwnProperty.call(body, 'data')) {
			if (body.success === true) {
				return body.data;
			}
			const error = body.error;
			if (isRecord(error) && typeof error.message === 'string') {
				throw new Error(error.message);
			}
			throw new Error(`${op}: the server reported a failure with no message: ${preview(body)}`);
		}
		return body;
	}

	// ---- Data calls (QL-DATA): each method names ONE host op; the input carries the backend's path and
	// query parameter names, and a request body travels as `body`. The host maps the op to its route. ----

	// REST API - Crypto
	async getCryptoSymbols(): Promise<CryptoSymbol[]> {
		// Live envelope is { coins: [...], count } -- a bare object with NO
		// {success,data} wrapper (verified 2026-06-11). The key is 'coins',
		// not 'symbols'.
		const res = await this.call('cryptoSymbols', {});
		if (!isRecord(res) || !Array.isArray(res.coins)) {
			throw new Error(`Unexpected /v1/crypto/symbols response shape: ${preview(res)}`);
		}
		return res.coins as CryptoSymbol[];
	}

	// REST API - ETFs
	async getEtfs(): Promise<EtfItem[]> {
		// NOTE: /v1/etfs/ currently returns 503 SERVICE_UNAVAILABLE ('asset
		// classes data not available', verified 2026-06-11) -- the host rejects
		// with the server's message. Callers must surface that error.
		const response = await this.call('etfs.list', {});
		if (Array.isArray(response)) { return response as EtfItem[]; }
		if (!isRecord(response) || !Array.isArray(response.etfs)) {
			throw new Error(`Unexpected /v1/etfs/ response shape: ${preview(response)}`);
		}
		return response.etfs as EtfItem[];
	}

	// REST API - Indices
	async getGlobalIndices(): Promise<IndexItem[]> {
		// NOTE: /v1/global-indices/ currently returns 503 SERVICE_UNAVAILABLE
		// ('global indices data not available', verified 2026-06-11).
		const response = await this.call('globalIndices.list', {});
		if (Array.isArray(response)) { return response as IndexItem[]; }
		if (!isRecord(response) || !Array.isArray(response.indices)) {
			throw new Error(`Unexpected /v1/global-indices/ response shape: ${preview(response)}`);
		}
		return response.indices as IndexItem[];
	}

	// REST API - Fixed Income
	async getYieldCurve(): Promise<YieldCurvePoint[]> {
		const res = await this.call('yieldCurve', {});
		if (!Array.isArray(res)) {
			throw new Error(`Unexpected /v1/fixed-income/yield-curve response shape: ${preview(res)}`);
		}
		return res as YieldCurvePoint[];
	}

	// REST API - Calendar
	// All calendar endpoints share the unified {events, total, limit, offset,
	// has_more} envelope and the unified CalendarEvent schema.
	private async getCalendarPage(op: string, path: string): Promise<CalendarPage> {
		const res = await this.call(op, {});
		if (!isRecord(res) || !Array.isArray(res.events)) {
			throw new Error(`Unexpected ${path} response shape: ${preview(res)}`);
		}
		return res as unknown as CalendarPage;
	}

	async getCalendarEconomic(): Promise<CalendarPage> {
		return this.getCalendarPage('calendar.listEconomic', '/v1/calendar/economic');
	}

	async getCalendarEarnings(): Promise<CalendarPage> {
		return this.getCalendarPage('calendar.listEarnings', '/v1/calendar/earnings');
	}

	async getCalendarDividends(): Promise<CalendarPage> {
		return this.getCalendarPage('calendar.listDividends', '/v1/calendar/dividends');
	}

	async getCalendarIPOs(): Promise<CalendarPage> {
		return this.getCalendarPage('calendar.listIpos', '/v1/calendar/ipos');
	}

	async getCalendarSplits(): Promise<CalendarPage> {
		return this.getCalendarPage('calendar.listSplits', '/v1/calendar/splits');
	}

	async getCalendarCentralBank(): Promise<CalendarPage> {
		// Verified 2026-06-11: GET /v1/calendar/central-bank returns HTTP 404
		// plain text ('404 page not found'). Fail loudly and descriptively
		// instead of letting the generic 404 path mislead callers.
		throw new Error('Central-bank calendar endpoint /v1/calendar/central-bank is not provisioned on the server (404)');
	}

	// REST API - Sentiment
	async getSentiment(symbol: string): Promise<SentimentData> {
		return expectRecord<SentimentData>('/v1/sentiment', await this.call('sentiment.get', { symbol }));
	}

	// REST API - News
	// Live response (verified 2026-06-11) is a direct array after the
	// {success,data} unwrap -- there is no {articles} wrapper.
	async getNews(): Promise<NewsItem[]> {
		const res = await this.call('news.list', {});
		if (!Array.isArray(res)) {
			throw new Error(`Unexpected /v1/news/ response shape: ${preview(res)}`);
		}
		return res as NewsItem[];
	}

	async getNewsBySymbol(symbol: string): Promise<NewsItem[]> {
		const res = await this.call('news.listBySymbol', { symbol });
		if (!Array.isArray(res)) {
			throw new Error(`Unexpected /v1/news/symbol response shape: ${preview(res)}`);
		}
		return res as NewsItem[];
	}

	// REST API - Fundamentals
	async getFundamentalsProfile(symbol: string): Promise<FundamentalsProfile> {
		return expectRecord<FundamentalsProfile>('/v1/fundamentals/profile', await this.call('fundamentals.getProfile', { symbol }));
	}

	async getFundamentalsFinancials(symbol: string): Promise<FundamentalsFinancials> {
		return expectRecord<FundamentalsFinancials>('/v1/fundamentals/financials', await this.call('fundamentals.getFinancials', { symbol }));
	}

	async getFundamentalsRatios(symbol: string): Promise<FundamentalsRatios> {
		return expectRecord<FundamentalsRatios>('/v1/fundamentals/ratios', await this.call('fundamentals.getRatios', { symbol }));
	}

	// REST API - Institutional
	// NOTE: both institutional endpoints currently return 503 SERVICE_UNAVAILABLE
	// ('institutional data not available', verified 2026-06-11) -- the host
	// rejects with the server's message. Callers must surface that error.
	async getInstitutionalHoldings(symbol: string): Promise<InstitutionalHolding[]> {
		const response = await this.call('institutional.listHoldings', { symbol });
		if (Array.isArray(response)) { return response as InstitutionalHolding[]; }
		if (!isRecord(response) || !Array.isArray(response.holdings)) {
			throw new Error(`Unexpected /v1/institutional/holdings response shape: ${preview(response)}`);
		}
		return response.holdings as InstitutionalHolding[];
	}

	async getInstitutionalInsiders(symbol: string): Promise<InsiderTransaction[]> {
		const response = await this.call('institutional.listInsiders', { symbol });
		if (Array.isArray(response)) { return response as InsiderTransaction[]; }
		if (!isRecord(response) || !Array.isArray(response.transactions)) {
			throw new Error(`Unexpected /v1/institutional/insiders response shape: ${preview(response)}`);
		}
		return response.transactions as InsiderTransaction[];
	}

	// REST API - Symbols
	async getSymbols(): Promise<ServerSymbol[]> {
		const PAGE_SIZE = 500;
		let page = 1;
		const all: ServerSymbol[] = [];
		while (true) {
			const response = await this.call('symbolsPage', { page_size: PAGE_SIZE, page });
			if (!isRecord(response) || !Array.isArray(response.symbols)) {
				throw new Error(`Unexpected /v1/symbols response shape: ${preview(response)}`);
			}
			const symbols = response.symbols as ServerSymbol[];
			all.push(...symbols);
			if (symbols.length < PAGE_SIZE) { break; }
			page++;
		}
		return all;
	}

	async getSymbol(symbol: string): Promise<ServerSymbol> {
		// Single-symbol endpoint verified live 2026-06-11 -- no need to page
		// through the full universe.
		return expectRecord<ServerSymbol>('/v1/symbols/{symbol}', await this.call('symbols.get', { symbol }));
	}

	// REST API - Bars (Historical Data)
	async getBars(params: BarsRequest, token?: vscode.CancellationToken): Promise<ServerBar[]> {
		if (params.assetClass?.toLowerCase() === 'crypto') {
			return this.getCryptoBars(params, token);
		}

		const input: Record<string, unknown> = { symbol: params.symbol, timeframe: params.timeframe };
		if (params.from !== undefined) {
			input.from = params.from;
		}
		if (params.to !== undefined) {
			input.to = params.to;
		}
		if (params.limit !== undefined) {
			input.limit = params.limit;
		}

		// Server returns { symbol, timeframe, bars: [...], count }
		const response = await this.call('bars', input, token);
		if (!isRecord(response) || !Array.isArray(response.bars)) {
			throw new Error(`Unexpected /v1/bars response shape: ${preview(response)}`);
		}
		return response.bars as ServerBar[];
	}

	// Crypto endpoint uses ?tf= (not ?timeframe=) and only supports 1d/1h/1m.
	// Returns per-exchange bars that must be aggregated into one bar per timestamp.
	private async getCryptoBars(params: BarsRequest, token?: vscode.CancellationToken): Promise<ServerBar[]> {
		const input: Record<string, unknown> = { symbol: params.symbol, tf: this.toCryptoTimeframe(params.timeframe) };
		if (params.limit !== undefined) {
			input.limit = params.limit;
		}
		// Note: crypto endpoint ignores from/to params -- date-range filtering not supported

		interface CryptoRawBar { t: string; o: number; h: number; l: number; c: number; v: number }
		const response = await this.call('cryptoBars', input, token);
		if (!isRecord(response) || !Array.isArray(response.bars)) {
			throw new Error(`Unexpected /v1/crypto/bars response shape: ${preview(response)}`);
		}
		const raw = response.bars as CryptoRawBar[];

		// Aggregate per-exchange bars into one bar per timestamp: open/close are volume-weighted, so a
		// bar without a volume, or a timestamp whose total volume is 0, has no defined open/close and
		// throws (it is never priced at 0).
		const byTimestamp = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
		for (const bar of raw) {
			if (typeof bar.v !== 'number') {
				throw new Error(`Crypto bar for ${params.symbol} at ${bar.t} has no volume: ${preview(bar)}`);
			}
			const v = bar.v;
			const existing = byTimestamp.get(bar.t);
			if (!existing) {
				byTimestamp.set(bar.t, { open: bar.o * v, high: bar.h, low: bar.l, close: bar.c * v, volume: v });
			} else {
				existing.high = Math.max(existing.high, bar.h);
				existing.low = Math.min(existing.low, bar.l);
				existing.open += bar.o * v;
				existing.close += bar.c * v;
				existing.volume += v;
			}
		}

		return Array.from(byTimestamp.entries()).map(([timestamp, agg]) => {
			if (agg.volume <= 0) {
				throw new Error(`Crypto bars for ${params.symbol} at ${timestamp} have zero total volume: the volume-weighted open/close is undefined`);
			}
			return {
				symbol: params.symbol,
				timestamp,
				open: agg.open / agg.volume,
				high: agg.high,
				low: agg.low,
				close: agg.close / agg.volume,
				volume: agg.volume,
			};
		});
	}

	// Map server timeframe → crypto endpoint tf param (only 1d/1h/1m supported)
	private toCryptoTimeframe(tf: ServerTimeframe): string {
		if (tf === '1D' || tf === '1W' || tf === '1M') { return '1d'; }
		if (tf === '1h' || tf === '4h' || tf === '30m' || tf === '15m') { return '1h'; }
		return '1m'; // 1m, 5m
	}

	// REST API - Watchlists
	async getWatchlists(): Promise<ServerWatchlist[]> {
		// The list endpoint wraps the array: { count, watchlists: [...] }
		// (live shape verified 2026-06-11; single-watchlist CRUD endpoints
		// return the bare watchlist object in `data`).
		const res = await this.call('watchlists.list', {});
		if (!isRecord(res) || !Array.isArray(res.watchlists)) {
			throw new Error(`Unexpected /v1/watchlists response shape: ${preview(res)}`);
		}
		return res.watchlists as ServerWatchlist[];
	}

	async createWatchlist(name: string, symbols: string[] = []): Promise<ServerWatchlist> {
		return expectRecord<ServerWatchlist>('POST /v1/watchlists', await this.call('watchlists.create', { body: { name, symbols } }));
	}

	async getWatchlist(id: string): Promise<ServerWatchlist> {
		return expectRecord<ServerWatchlist>('/v1/watchlists/{id}', await this.call('watchlists.get', { id }));
	}

	async updateWatchlist(id: string, updates: Partial<Omit<ServerWatchlist, 'id'>>): Promise<ServerWatchlist> {
		// The live server only accepts PATCH here -- PUT returns 405
		// (Allow: GET, PATCH, DELETE; verified live 2026-06-11).
		return expectRecord<ServerWatchlist>('PATCH /v1/watchlists/{id}', await this.call('watchlists.update', { id, body: updates }));
	}

	async deleteWatchlist(id: string): Promise<void> {
		await this.call('watchlists.delete', { id });
	}

	// REST API - Alerts
	async getAlerts(): Promise<ServerAlert[]> {
		// The list endpoint wraps the array: { alerts: [...], count }
		// (live shape verified 2026-06-11, same envelope style as watchlists).
		const res = await this.call('alerts.list', {});
		if (!isRecord(res) || !Array.isArray(res.alerts)) {
			throw new Error(`Unexpected /v1/alerts response shape: ${preview(res)}`);
		}
		return res.alerts as ServerAlert[];
	}

	async createAlert(alert: Omit<ServerAlert, 'id' | 'status' | 'triggered_at'>): Promise<ServerAlert> {
		return expectRecord<ServerAlert>('POST /v1/alerts', await this.call('alerts.create', { body: alert }));
	}

	async getAlert(id: string): Promise<ServerAlert> {
		return expectRecord<ServerAlert>('/v1/alerts/{id}', await this.call('alerts.get', { id }));
	}

	async updateAlert(id: string, updates: Partial<Omit<ServerAlert, 'id'>>): Promise<ServerAlert> {
		return expectRecord<ServerAlert>('PUT /v1/alerts/{id}', await this.call('alerts.update', { id, body: updates }));
	}

	async deleteAlert(id: string): Promise<void> {
		await this.call('alerts.delete', { id });
	}

	// REST API - Demo Control: REMOVED 2026-06-11. All eleven /v1/demo/*
	// methods (status/start/stop/reset/pause/resume/set-speed/jump/symbols/
	// trigger-event/inject-price) targeted routes that return HTTP 404 on the
	// live server and had zero call sites in the extension.

	// REST API - Resources Catalog
	async getResourcesCatalog(cachedVersion?: string): Promise<ResourcesCatalogResponse | null> {
		// `null` is the host's answer for an empty 2xx body (catalog unchanged since cachedVersion).
		const res = await this.call('resources.getCatalog', cachedVersion ? { v: cachedVersion } : {});
		if (res === null) { return null; }
		return expectRecord<ResourcesCatalogResponse>('/v1/resources/catalog', res);
	}

	async getResourcesCatalogVersion(): Promise<{ version: string; tool_count: number }> {
		return expectRecord<{ version: string; tool_count: number }>('/v1/resources/catalog/version', await this.call('resources.getCatalogVersion', {}));
	}

	async getResourceToolDetail(toolId: string): Promise<ResourceToolDetail> {
		return expectRecord<ResourceToolDetail>('/v1/resources/tools/{toolId}', await this.call('resources.getToolDetail', { toolId }));
	}

	// REST API - Tool Execution
	async executeToolJob(payload: ServerToolExecutePayload): Promise<ServerToolExecuteResponse> {
		return expectRecord<ServerToolExecuteResponse>('POST /v1/tools/execute', await this.call('tools.execute', { body: payload }));
	}

	async getToolJobStatus(jobId: string): Promise<ToolJobStatusResponse> {
		return expectRecord<ToolJobStatusResponse>('/v1/tools/{jobId}/status', await this.call('tools.getStatus', { jobId }));
	}

	async getToolJobResult(jobId: string): Promise<unknown> {
		return this.call('tools.getResult', { jobId });
	}

	async cancelToolJob(jobId: string): Promise<void> {
		await this.call('tools.cancel', { jobId });
	}

	// Strategy Validation
	async validateStrategy(_code: string, _filename?: string): Promise<import('../../types/strategy').StrategyValidationResponse> {
		// Verified 2026-06-11: POST /v1/strategies/validate returns HTTP 404
		// plain text. Fail loudly until the server provisions the route.
		throw new Error('Strategy validation endpoint /v1/strategies/validate is not provisioned on the server (404)');
	}

	// Strategy Templates
	async getStrategyTemplates(): Promise<import('../../types/strategy').StrategyTemplatesResponse> {
		// Verified 2026-06-11: GET /v1/strategies/templates returns HTTP 404
		// plain text. Fail loudly until the server provisions the route.
		throw new Error('Strategy templates endpoint /v1/strategies/templates is not provisioned on the server (404)');
	}

	// No stream is opened here: the WebSocket's job/quote events had no consumer (K-7), so QL-DATA
	// removed them. A later consumer uses the transport's subscribe().
}
