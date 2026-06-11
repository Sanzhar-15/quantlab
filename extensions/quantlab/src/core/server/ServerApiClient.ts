/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { ResourcesCatalogResponse, ResourceToolDetail } from '../../types/resources';
import { ServerToolExecutePayload, ServerToolExecuteResponse, ToolJobStatusResponse } from '../../types/toolExecution';

// WebSocket interface - simplified for our needs
interface WebSocketLike {
	readyState: number;
	on(event: 'open', listener: () => void): void;
	on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): void;
	on(event: 'close', listener: () => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	send(data: string): void;
	close(): void;
}

interface WebSocketConstructor {
	new(url: string, options?: { headers?: Record<string, string> }): WebSocketLike;
}

// WebSocket types - we'll use dynamic import to handle the ws module
type WebSocketType = WebSocketLike;
let WebSocket: WebSocketConstructor | undefined;

// Try to load ws module dynamically
try {
	WebSocket = require('ws') as WebSocketConstructor;
} catch {
	// ws module not available - WebSocket features will be disabled
}

// Server configuration - can be overridden via configure()
/**
 * Default server configuration.
 * SECURITY: For production, configure via QUANTLAB_SERVER_URL environment variable.
 * This default points to the demo server and should only be used in development.
 */
const DEFAULT_CONFIG = {
	host: process.env.QUANTLAB_SERVER_HOST ?? 'api.deltaplus.io',
	port: parseInt(process.env.QUANTLAB_SERVER_PORT ?? '443', 10),
	baseUrl: process.env.QUANTLAB_SERVER_URL ?? 'https://api.deltaplus.io',
	wsUrl: process.env.QUANTLAB_WS_URL ?? 'wss://api.deltaplus.io/v1/ws'
};

/**
 * Get demo credentials from environment variables.
 * SECURITY: Credentials must be provided via environment variables - no defaults.
 * Set QUANTLAB_DEMO_EMAIL and QUANTLAB_DEMO_PASSWORD before using demo mode.
 */
function getDemoCredentials(): { email: string; password: string } {
	// Use environment variables with fallback to default demo credentials
	const email = process.env.QUANTLAB_DEMO_EMAIL ?? 'demo@deltaplus.io';
	const password = process.env.QUANTLAB_DEMO_PASSWORD ?? 'DeltaPlus-Demo-2026!';

	// Basic validation
	if (!email.includes('@') || email.length < 5) {
		throw new Error('Invalid demo email format');
	}

	if (password.length < 6) {
		throw new Error('Demo password must be at least 6 characters');
	}

	return { email, password };
}

// Types matching server API
export interface ServerUser {
	id: string;
	email: string;
	name: string;
	tier: string;
}

export interface AuthResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	user: ServerUser;
}

export interface ServerSymbol {
	symbol: string;
	name: string;
	sector: string;
	base_price: number;
	trend?: string;
	tradeable?: boolean;
}

interface RawServerSymbol {
	symbol: string;
	name?: string;
	sector?: string;
	base_price?: number;
	trend?: string;
	tradeable?: boolean;
	price?: number;
	metadata?: {
		sector?: string;
		tradeable?: boolean;
		base_price?: number;
		trend?: string;
	};
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

export interface ServerQuote {
	type: 'quote';
	symbol: string;
	bid: number;
	ask: number;
	bid_size: number;
	ask_size: number;
	last: number;
	last_size: number;
	volume: number;
	timestamp: string;
	vwap?: number;
	open?: number;
	high?: number;
	low?: number;
	close?: number;
	change?: number;
	change_pct?: number;
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
}

export interface DemoStatus {
	running: boolean;
	paused: boolean;
	speed: number;
	elapsed_minutes: number;
	symbols: string[];
}

export type ServerTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W' | '1M';

export interface CryptoSymbol {
	symbol: string;
	name?: string;
	base?: string;
	quote?: string;
	exchange?: string;
	category?: string;
}

export interface CryptoQuote {
	symbol: string;
	price: number;
	change?: number;
	change_pct?: number;
	volume?: number;
	timestamp?: string;
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

export interface YieldCurveData {
	date?: string;
	tenors?: Record<string, number>;
	data?: Array<{ tenor: string; yield: number }>;
}

// ---- Calendar interfaces ----

export interface CalendarEvent {
	date?: string;
	time?: string;
	country?: string;
	event?: string;
	actual?: string | number;
	forecast?: string | number;
	previous?: string | number;
	impact?: string;
	[key: string]: unknown;
}

export interface EarningsEvent {
	date?: string;
	symbol?: string;
	company?: string;
	eps_estimate?: number;
	eps_actual?: number;
	revenue_estimate?: number;
	revenue_actual?: number;
	[key: string]: unknown;
}

export interface DividendEvent {
	date?: string;
	symbol?: string;
	company?: string;
	dividend?: number;
	ex_date?: string;
	pay_date?: string;
	record_date?: string;
	[key: string]: unknown;
}

export interface IPOEvent {
	date?: string;
	company?: string;
	symbol?: string;
	exchange?: string;
	price_range?: string;
	shares?: number;
	[key: string]: unknown;
}

export interface SplitEvent {
	date?: string;
	symbol?: string;
	company?: string;
	ratio?: string;
	[key: string]: unknown;
}

export interface CentralBankEvent {
	date?: string;
	central_bank?: string;
	event?: string;
	rate?: number;
	previous_rate?: number;
	decision?: string;
	[key: string]: unknown;
}

// ---- Sentiment & News interfaces ----

export interface SentimentData {
	symbol?: string;
	score?: number;
	label?: string;
	bullish?: number;
	bearish?: number;
	neutral?: number;
	[key: string]: unknown;
}

export interface NewsItem {
	id?: string;
	title?: string;
	summary?: string;
	url?: string;
	source?: string;
	published_at?: string;
	symbols?: string[];
	sentiment?: string;
	[key: string]: unknown;
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
	[key: string]: unknown;
}

export interface FundamentalsFinancials {
	symbol?: string;
	revenue?: number;
	net_income?: number;
	eps?: number;
	pe_ratio?: number;
	[key: string]: unknown;
}

export interface FundamentalsRatios {
	symbol?: string;
	pe?: number;
	pb?: number;
	ps?: number;
	dividend_yield?: number;
	roe?: number;
	roa?: number;
	debt_to_equity?: number;
	current_ratio?: number;
	[key: string]: unknown;
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

type QuoteHandler = (quote: ServerQuote) => void;
type ConnectionHandler = () => void;
type ErrorHandler = (error: Error) => void;

export class ServerApiClient {
	private static instance: ServerApiClient | undefined;

	private accessToken: string | undefined;
	private refreshToken: string | undefined;
	private tokenExpiresAt: number = 0;
	private user: ServerUser | undefined;

	private ws: WebSocketType | null = null;
	private wsReconnectTimer: NodeJS.Timeout | null = null;
	private wsReconnectAttempts: number = 0;
	private wsMaxReconnectAttempts: number = 10;
	private wsReconnectDelay: number = 1000;
	private wsConnecting: boolean = false;
	private wsConnectionPromise: Promise<void> | null = null;
	private subscribedSymbols: Set<string> = new Set();
	private refreshPromise: Promise<void> | null = null;

	// Auth-ready gate: resolves when tokens are first loaded (either from SecretStorage or fresh login).
	// ensureAuthenticated() awaits this during the startup window to avoid throwing before tokens load.
	private authReadyResolve: (() => void) | null = null;
	// Not readonly so clearTokens() can reset it after sign-out without Object.assign hacks.
	private authReadyPromise: Promise<void> = new Promise<void>(resolve => {
		this.authReadyResolve = resolve;
	});
	// Subscription to external token changes (e.g. DeltaPlusAdapter writes after its own refresh).
	private _secretStorageDisposable: vscode.Disposable | undefined;
	// Set to true once initializeServerConnection() has finished (success or failure).
	// After this point, a missing token means the user is genuinely not signed in.
	private authFlowComplete: boolean = false;

	private readonly quoteHandlers: Set<QuoteHandler> = new Set();
	private readonly connectionHandlers: Set<ConnectionHandler> = new Set();
	private readonly disconnectionHandlers: Set<ConnectionHandler> = new Set();
	private readonly errorHandlers: Set<ErrorHandler> = new Set();

	private readonly _onDidConnect = new vscode.EventEmitter<void>();
	readonly onDidConnect = this._onDidConnect.event;

	private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
	readonly onDidDisconnect = this._onDidDisconnect.event;

	private readonly _onQuote = new vscode.EventEmitter<ServerQuote>();
	readonly onQuote = this._onQuote.event;

	private readonly _onAuthStateChange = new vscode.EventEmitter<boolean>();
	readonly onAuthStateChange = this._onAuthStateChange.event;

	private readonly _onJobProgress = new vscode.EventEmitter<{ jobId: string; progress: number; message: string }>();
	readonly onJobProgress = this._onJobProgress.event;

	private readonly _onJobComplete = new vscode.EventEmitter<{ jobId: string }>();
	readonly onJobComplete = this._onJobComplete.event;

	private secretStorage: vscode.SecretStorage | undefined;

	private config = { ...DEFAULT_CONFIG };
	private disposed: boolean = false;
	private readonly outputChannel: vscode.OutputChannel;

	// Logging helper
	private log(message: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	}

	private constructor() {
		this.outputChannel = vscode.window.createOutputChannel('Delta Plus Server');
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

		// Disconnect WebSocket and clear timers
		this.disconnectWebSocket();

		// Dispose all EventEmitters
		this._onDidConnect.dispose();
		this._onDidDisconnect.dispose();
		this._onQuote.dispose();
		this._onAuthStateChange.dispose();
		this._onJobProgress.dispose();
		this._onJobComplete.dispose();

		// Dispose output channel
		this.outputChannel.dispose();

		// Clear all handlers
		this.quoteHandlers.clear();
		this.connectionHandlers.clear();
		this.disconnectionHandlers.clear();
		this.errorHandlers.clear();

		// Clear connection state
		this.refreshPromise = null;
		this.wsConnectionPromise = null;
		this.wsConnecting = false;

		// Clear authentication state
		this.accessToken = undefined;
		this.refreshToken = undefined;
		this.tokenExpiresAt = 0;
		this.user = undefined;

		// Clean up SecretStorage subscription
		this._secretStorageDisposable?.dispose();
		this._secretStorageDisposable = undefined;
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

	// Configuration
	configure(options: Partial<typeof DEFAULT_CONFIG>): void {
		this.config = { ...this.config, ...options };
	}

	getConfig(): typeof DEFAULT_CONFIG {
		return { ...this.config };
	}

	/**
	 * Set SecretStorage for persisting tokens to workbench SecretStorage.
	 * This bridges the extension's auth tokens to QIC's DeltaPlusAdapter.
	 */
	setSecretStorage(storage: vscode.SecretStorage): void {
		this.secretStorage = storage;

		// FIX: Dual-refresh race guard.
		// DeltaPlusAdapter (in the workbench) refreshes tokens at T-5min using a proactive
		// threshold. With rotating refresh tokens, it invalidates the old refresh token before
		// ServerApiClient's T-60s refresh fires. Subscribing here means we pick up any token
		// written by the adapter and stay in sync, preventing the stale-refresh 401.
		this._secretStorageDisposable?.dispose();
		this._secretStorageDisposable = storage.onDidChange(async e => {
			if (e.key !== 'qic.deltaplusAccessToken') { return; }
			if (!this.refreshToken) { return; } // not initialized yet -- ignore
			const newAccess = await storage.get('qic.deltaplusAccessToken');
			if (!newAccess || newAccess === this.accessToken) { return; } // no change
			const newRefresh = await storage.get('qic.deltaplusRefreshToken');
			const expiryStr = await storage.get('qic.deltaplusTokenExpiresAt');
			this.accessToken = newAccess;
			if (newRefresh) { this.refreshToken = newRefresh; }
			if (expiryStr) { this.tokenExpiresAt = parseInt(expiryStr, 10); }
			this.log('Tokens updated from external refresh (DeltaPlusAdapter)');
		});
	}

	/**
	 * Persist current tokens to SecretStorage so the DeltaPlusAdapter can read them.
	 */
	private async persistTokens(): Promise<void> {
		if (!this.secretStorage || !this.accessToken) { return; }
		try {
			await this.secretStorage.store('qic.deltaplusAccessToken', this.accessToken);
			if (this.refreshToken) {
				await this.secretStorage.store('qic.deltaplusRefreshToken', this.refreshToken);
			}
			await this.secretStorage.store('qic.deltaplusTokenExpiresAt', String(this.tokenExpiresAt));
		} catch (err) {
			// System boundary (OS keychain). Do not swallow: a failed persist means the
			// session will NOT survive a restart -- say so where the operator can see it.
			this.log(`Token persistence to SecretStorage FAILED -- sign-in will not survive a restart: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Authentication

	/** Sign in with explicit credentials. Both params are required -- no demo fallback. */
	async login(email: string, password: string): Promise<AuthResponse> {
		const response = await this.request<AuthResponse>('POST', '/v1/auth/login', { email, password });
		this.accessToken = response.access_token;
		this.refreshToken = response.refresh_token;
		this.tokenExpiresAt = Date.now() + (response.expires_in * 1000);
		this.user = response.user;
		this._onAuthStateChange.fire(true);
		void this.persistTokens();
		return response;
	}

	async loginWithDemo(): Promise<AuthResponse> {
		const creds = getDemoCredentials();
		return this.login(creds.email, creds.password);
	}

	/**
	 * Register a new user account. Does not set any auth state -- the caller
	 * must subsequently call login() to obtain tokens.
	 */
	async register(email: string, password: string, name: string): Promise<{ message: string }> {
		return this.requestOnce<{ message: string }>('POST', '/v1/auth/register', { email, password, name });
	}

	/**
	 * Performs a health check on the server connection.
	 * Returns true if the server is reachable and we're authenticated.
	 */
	async healthCheck(): Promise<{ healthy: boolean; authenticated: boolean; wsConnected: boolean; error?: string }> {
		const result = {
			healthy: false,
			authenticated: this.isAuthenticated(),
			wsConnected: this.isWebSocketConnected(),
			error: undefined as string | undefined
		};

		try {
			// Quick ping via symbols endpoint
			await this.getSymbols();
			result.healthy = true;
		} catch (error) {
			result.error = error instanceof Error ? error.message : 'Unknown error';
		}

		return result;
	}

	/**
	 * Gets the current connection state summary.
	 */
	getConnectionState(): { authenticated: boolean; wsConnected: boolean; wsReconnecting: boolean; user?: ServerUser } {
		return {
			authenticated: this.isAuthenticated(),
			wsConnected: this.isWebSocketConnected(),
			wsReconnecting: this.wsReconnectAttempts > 0 && this.wsReconnectAttempts < this.wsMaxReconnectAttempts,
			user: this.user
		};
	}

	async refreshAccessToken(): Promise<void> {
		if (!this.refreshToken) {
			throw new Error('No refresh token available');
		}

		try {
			const response = await this.requestOnce<AuthResponse>('POST', '/v1/auth/refresh', {
				refresh_token: this.refreshToken
			});
			this.accessToken = response.access_token;
			this.refreshToken = response.refresh_token;
			this.tokenExpiresAt = Date.now() + (response.expires_in * 1000);
			this.user = response.user ?? this.user;
			this._onAuthStateChange.fire(true); // signal refreshed tokens to provider
			void this.persistTokens();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid token') || msg.includes('token has expired')) {
				// Refresh token is expired -- session is dead. Clear state and notify.
				this.log('Refresh token expired -- clearing session');
				this.accessToken = undefined;
				this.refreshToken = undefined;
				this.tokenExpiresAt = 0;
				this.user = undefined;
				this._onAuthStateChange.fire(false);
				this.disconnectWebSocket();
			}
			throw err;
		}
	}

	logout(): void {
		this.accessToken = undefined;
		this.refreshToken = undefined;
		this.tokenExpiresAt = 0;
		this.user = undefined;
		this.disconnectWebSocket();
		this._onAuthStateChange.fire(false);
	}

	/**
	 * Revoke a specific refresh token on the server (best-effort; ignores errors).
	 * Called by DeltaPlusAuthProvider.removeSession() before clearing local state.
	 */
	async logoutSession(refreshToken: string): Promise<void> {
		try {
			await this.requestOnce<void>('POST', '/v1/auth/logout', { refresh_token: refreshToken });
		} catch {
			// Best-effort -- local session is cleared regardless.
		}
	}

	/**
	 * Fetch the user profile for a specific access token.
	 * Used during session migration to validate a legacy token.
	 */
	async fetchCurrentUser(accessToken: string): Promise<ServerUser> {
		// Temporarily override accessToken so requestOnce() sends the correct Bearer header.
		// Node.js is single-threaded: requestOnce() captures the header synchronously before
		// any await, so this swap is safe.
		const prev = this.accessToken;
		this.accessToken = accessToken;
		try {
			return await this.requestOnce<ServerUser>('GET', '/v1/auth/me');
		} finally {
			this.accessToken = prev;
		}
	}

	/**
	 * Refresh tokens using a specific refresh token (not the cached one).
	 * Used during session migration. Does NOT update in-memory auth state.
	 */
	async refreshWithToken(refreshToken: string): Promise<AuthResponse> {
		return this.requestOnce<AuthResponse>('POST', '/v1/auth/refresh', { refresh_token: refreshToken });
	}

	isAuthenticated(): boolean {
		return !!this.accessToken && Date.now() < this.tokenExpiresAt;
	}

	getUser(): ServerUser | undefined {
		return this.user;
	}

	// Token accessors -- used by DeltaPlusAuthProvider to sync refreshed tokens back to SecretStorage.
	getAccessToken(): string | undefined { return this.accessToken; }
	getRefreshToken(): string | undefined { return this.refreshToken; }
	getTokenExpiresAt(): number { return this.tokenExpiresAt; }

	/**
	 * Called by DeltaPlusAuthProvider when a session is loaded or created.
	 * Resolves the auth-ready gate so all pending ensureAuthenticated() calls proceed.
	 */
	setSessionTokens(access: string, refresh: string, expiresAt: number, user: ServerUser): void {
		this.accessToken = access;
		this.refreshToken = refresh;
		this.tokenExpiresAt = expiresAt;
		this.user = user;
		this._onAuthStateChange.fire(true);
		void this.persistTokens();
		// Resolve the startup gate so all pending API calls can proceed.
		if (this.authReadyResolve) {
			this.authReadyResolve();
			this.authReadyResolve = null;
		}
	}

	/**
	 * Called by DeltaPlusAuthProvider on sign-out. Clears all in-memory tokens
	 * and fires onAuthStateChange so listeners can react (e.g. disconnect WebSocket).
	 */
	clearTokens(): void {
		this.accessToken = undefined;
		this.refreshToken = undefined;
		this.tokenExpiresAt = 0;
		this.user = undefined;
		// Reset the gate for next sign-in.
		if (!this.authReadyResolve) {
			this.authReadyPromise = new Promise<void>(resolve => { this.authReadyResolve = resolve; });
		}
		this.disconnectWebSocket();
		this._onAuthStateChange.fire(false);
	}

	/** Called by extension.ts after initializeServerConnection() completes. */
	markAuthFlowComplete(): void {
		this.authFlowComplete = true;
		// If no tokens arrived, reject waiters immediately by resolving with a flag check.
		// They will then throw "Not signed in" from ensureAuthenticated().
		if (this.authReadyResolve) {
			this.authReadyResolve();
			this.authReadyResolve = null;
		}
	}

	private async ensureAuthenticated(): Promise<void> {
		if (!this.accessToken) {
			if (!this.authFlowComplete) {
				// Startup still in progress -- wait up to 5 s for setSessionTokens() to be called.
				await Promise.race([
					this.authReadyPromise,
					new Promise<void>(r => setTimeout(r, 5000))
				]);
			}
			if (!this.accessToken) {
				throw new Error('Not signed in to Delta Plus. Sign in via the account menu.');
			}
		}

		// Refresh token if it expires within 60 seconds
		if (Date.now() > this.tokenExpiresAt - 60000) {
			// Mutex: reuse in-flight refresh to prevent parallel token refreshes
			if (!this.refreshPromise) {
				this.refreshPromise = this.refreshAccessToken().finally(() => {
					this.refreshPromise = null;
				});
			}
			await this.refreshPromise;
		}
	}

	// REST API - Crypto
	async getCryptoSymbols(): Promise<CryptoSymbol[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ symbols?: CryptoSymbol[] } | CryptoSymbol[]>('GET', '/v1/crypto/symbols');
		if (Array.isArray(response)) { return response; }
		return (response as { symbols?: CryptoSymbol[] }).symbols ?? [];
	}

	async getCryptoQuote(symbol: string): Promise<CryptoQuote> {
		await this.ensureAuthenticated();
		return this.request<CryptoQuote>('GET', `/v1/crypto/quote/${encodeURIComponent(symbol)}`);
	}

	// REST API - ETFs
	async getEtfs(): Promise<EtfItem[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ etfs?: EtfItem[] } | EtfItem[]>('GET', '/v1/etfs/');
		if (Array.isArray(response)) { return response; }
		return (response as { etfs?: EtfItem[] }).etfs ?? [];
	}

	// REST API - Indices
	async getGlobalIndices(): Promise<IndexItem[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ indices?: IndexItem[] } | IndexItem[]>('GET', '/v1/global-indices/');
		if (Array.isArray(response)) { return response; }
		return (response as { indices?: IndexItem[] }).indices ?? [];
	}

	// REST API - Fixed Income
	async getYieldCurve(): Promise<YieldCurveData> {
		await this.ensureAuthenticated();
		return this.request<YieldCurveData>('GET', '/v1/fixed-income/yield-curve');
	}

	// REST API - Calendar
	async getCalendarEconomic(): Promise<CalendarEvent[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ events?: CalendarEvent[] } | CalendarEvent[]>('GET', '/v1/calendar/economic');
		if (Array.isArray(response)) { return response; }
		return (response as { events?: CalendarEvent[] }).events ?? [];
	}

	async getCalendarEarnings(): Promise<EarningsEvent[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ events?: EarningsEvent[] } | EarningsEvent[]>('GET', '/v1/calendar/earnings');
		if (Array.isArray(response)) { return response; }
		return (response as { events?: EarningsEvent[] }).events ?? [];
	}

	async getCalendarDividends(): Promise<DividendEvent[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ events?: DividendEvent[] } | DividendEvent[]>('GET', '/v1/calendar/dividends');
		if (Array.isArray(response)) { return response; }
		return (response as { events?: DividendEvent[] }).events ?? [];
	}

	async getCalendarIPOs(): Promise<IPOEvent[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ events?: IPOEvent[] } | IPOEvent[]>('GET', '/v1/calendar/ipos');
		if (Array.isArray(response)) { return response; }
		return (response as { events?: IPOEvent[] }).events ?? [];
	}

	async getCalendarSplits(): Promise<SplitEvent[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ events?: SplitEvent[] } | SplitEvent[]>('GET', '/v1/calendar/splits');
		if (Array.isArray(response)) { return response; }
		return (response as { events?: SplitEvent[] }).events ?? [];
	}

	async getCalendarCentralBank(): Promise<CentralBankEvent[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ events?: CentralBankEvent[] } | CentralBankEvent[]>('GET', '/v1/calendar/central-bank');
		if (Array.isArray(response)) { return response; }
		return (response as { events?: CentralBankEvent[] }).events ?? [];
	}

	// REST API - Sentiment
	async getSentiment(symbol: string): Promise<SentimentData> {
		await this.ensureAuthenticated();
		return this.request<SentimentData>('GET', `/v1/sentiment/${encodeURIComponent(symbol)}`);
	}

	// REST API - News
	async getNews(): Promise<NewsItem[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ articles?: NewsItem[] } | NewsItem[]>('GET', '/v1/news/');
		if (Array.isArray(response)) { return response; }
		return (response as { articles?: NewsItem[] }).articles ?? [];
	}

	async getNewsBySymbol(symbol: string): Promise<NewsItem[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ articles?: NewsItem[] } | NewsItem[]>('GET', `/v1/news/symbol/${encodeURIComponent(symbol)}`);
		if (Array.isArray(response)) { return response; }
		return (response as { articles?: NewsItem[] }).articles ?? [];
	}

	// REST API - Fundamentals
	async getFundamentalsProfile(symbol: string): Promise<FundamentalsProfile> {
		await this.ensureAuthenticated();
		return this.request<FundamentalsProfile>('GET', `/v1/fundamentals/profile/${encodeURIComponent(symbol)}`);
	}

	async getFundamentalsFinancials(symbol: string): Promise<FundamentalsFinancials> {
		await this.ensureAuthenticated();
		return this.request<FundamentalsFinancials>('GET', `/v1/fundamentals/financials/${encodeURIComponent(symbol)}`);
	}

	async getFundamentalsRatios(symbol: string): Promise<FundamentalsRatios> {
		await this.ensureAuthenticated();
		return this.request<FundamentalsRatios>('GET', `/v1/fundamentals/ratios/${encodeURIComponent(symbol)}`);
	}

	// REST API - Institutional
	async getInstitutionalHoldings(symbol: string): Promise<InstitutionalHolding[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ holdings?: InstitutionalHolding[] } | InstitutionalHolding[]>('GET', `/v1/institutional/holdings/${encodeURIComponent(symbol)}`);
		if (Array.isArray(response)) { return response; }
		return (response as { holdings?: InstitutionalHolding[] }).holdings ?? [];
	}

	async getInstitutionalInsiders(symbol: string): Promise<InsiderTransaction[]> {
		await this.ensureAuthenticated();
		const response = await this.request<{ transactions?: InsiderTransaction[] } | InsiderTransaction[]>('GET', `/v1/institutional/insiders/${encodeURIComponent(symbol)}`);
		if (Array.isArray(response)) { return response; }
		return (response as { transactions?: InsiderTransaction[] }).transactions ?? [];
	}

	// REST API - Symbols
	async getSymbols(): Promise<ServerSymbol[]> {
		await this.ensureAuthenticated();
		const PAGE_SIZE = 500;
		let page = 1;
		const allRaw: RawServerSymbol[] = [];
		while (true) {
			const response = await this.request<{ symbols: RawServerSymbol[] }>(
				'GET', `/v1/symbols?page_size=${PAGE_SIZE}&page=${page}`
			);
			const batch = response.symbols ?? [];
			allRaw.push(...batch);
			if (batch.length < PAGE_SIZE) { break; }
			page++;
		}
		return allRaw.map(symbol => this.normalizeServerSymbol(symbol));
	}

	async getSymbol(symbol: string): Promise<ServerSymbol> {
		await this.ensureAuthenticated();
		// Get all symbols and find the specific one
		const symbols = await this.getSymbols();
		const found = symbols.find(s => s.symbol === symbol);
		if (!found) {
			throw new Error(`Symbol not found: ${symbol}`);
		}
		return found;
	}

	private normalizeServerSymbol(symbol: RawServerSymbol): ServerSymbol {
		return {
			symbol: symbol.symbol,
			name: symbol.name ?? symbol.symbol,
			sector: symbol.sector ?? symbol.metadata?.sector ?? 'Other',
			base_price: symbol.base_price ?? symbol.metadata?.base_price ?? symbol.price ?? 0,
			trend: symbol.trend ?? symbol.metadata?.trend,
			tradeable: symbol.tradeable ?? symbol.metadata?.tradeable,
		};
	}

	// REST API - Bars (Historical Data)
	async getBars(params: BarsRequest, token?: vscode.CancellationToken): Promise<ServerBar[]> {
		await this.ensureAuthenticated();

		if (params.assetClass?.toLowerCase() === 'crypto') {
			return this.getCryptoBars(params, token);
		}

		const query = new URLSearchParams();
		query.set('timeframe', params.timeframe);
		if (params.from !== undefined) {
			query.set('from', params.from.toString());
		}
		if (params.to !== undefined) {
			query.set('to', params.to.toString());
		}
		if (params.limit !== undefined) {
			query.set('limit', params.limit.toString());
		}

		// Server returns { symbol, timeframe, bars: [...], count }
		const response = await this.request<{ bars: ServerBar[]; count: number }>('GET', `/v1/bars/${params.symbol}?${query.toString()}`, undefined, token);
		return response.bars ?? [];
	}

	// Crypto endpoint uses ?tf= (not ?timeframe=) and only supports 1d/1h/1m.
	// Returns per-exchange bars that must be aggregated into one bar per timestamp.
	private async getCryptoBars(params: BarsRequest, token?: vscode.CancellationToken): Promise<ServerBar[]> {
		const tf = this.toCryptoTimeframe(params.timeframe);
		const query = new URLSearchParams();
		query.set('tf', tf);
		if (params.limit !== undefined) {
			query.set('limit', params.limit.toString());
		}
		// Note: crypto endpoint ignores from/to params -- date-range filtering not supported

		interface CryptoRawBar { t: string; o: number; h: number; l: number; c: number; v: number }
		const response = await this.request<{ bars: CryptoRawBar[] }>('GET', `/v1/crypto/bars/${params.symbol}?${query.toString()}`, undefined, token);
		const raw = response.bars ?? [];

		// Aggregate per-exchange bars into one bar per timestamp
		const byTimestamp = new Map<string, { open: number; high: number; low: number; close: number; volume: number; volOpen: number; volClose: number }>();
		for (const bar of raw) {
			const v = bar.v ?? 0;
			const existing = byTimestamp.get(bar.t);
			if (!existing) {
				byTimestamp.set(bar.t, { open: bar.o * v, high: bar.h, low: bar.l, close: bar.c * v, volume: v, volOpen: v, volClose: v });
			} else {
				existing.high = Math.max(existing.high, bar.h);
				existing.low = Math.min(existing.low, bar.l);
				existing.open += bar.o * v;
				existing.close += bar.c * v;
				existing.volume += v;
				existing.volOpen += v;
				existing.volClose += v;
			}
		}

		return Array.from(byTimestamp.entries()).map(([timestamp, agg]) => ({
			symbol: params.symbol,
			timestamp,
			open: agg.volOpen > 0 ? agg.open / agg.volOpen : 0,
			high: agg.high,
			low: agg.low,
			close: agg.volClose > 0 ? agg.close / agg.volClose : 0,
			volume: agg.volume,
		}));
	}

	// Map server timeframe → crypto endpoint tf param (only 1d/1h/1m supported)
	private toCryptoTimeframe(tf: ServerTimeframe): string {
		if (tf === '1D' || tf === '1W' || tf === '1M') { return '1d'; }
		if (tf === '1h' || tf === '4h' || tf === '30m' || tf === '15m') { return '1h'; }
		return '1m'; // 1m, 5m
	}

	// REST API - Watchlists
	async getWatchlists(): Promise<ServerWatchlist[]> {
		await this.ensureAuthenticated();
		return this.request<ServerWatchlist[]>('GET', '/v1/watchlists');
	}

	async createWatchlist(name: string, symbols: string[] = []): Promise<ServerWatchlist> {
		await this.ensureAuthenticated();
		return this.request<ServerWatchlist>('POST', '/v1/watchlists', { name, symbols });
	}

	async getWatchlist(id: string): Promise<ServerWatchlist> {
		await this.ensureAuthenticated();
		return this.request<ServerWatchlist>('GET', `/v1/watchlists/${id}`);
	}

	async updateWatchlist(id: string, updates: Partial<Omit<ServerWatchlist, 'id'>>): Promise<ServerWatchlist> {
		await this.ensureAuthenticated();
		return this.request<ServerWatchlist>('PUT', `/v1/watchlists/${id}`, updates);
	}

	async deleteWatchlist(id: string): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('DELETE', `/v1/watchlists/${id}`);
	}

	// REST API - Alerts
	async getAlerts(): Promise<ServerAlert[]> {
		await this.ensureAuthenticated();
		return this.request<ServerAlert[]>('GET', '/v1/alerts');
	}

	async createAlert(alert: Omit<ServerAlert, 'id' | 'status' | 'triggered_at'>): Promise<ServerAlert> {
		await this.ensureAuthenticated();
		return this.request<ServerAlert>('POST', '/v1/alerts', alert);
	}

	async getAlert(id: string): Promise<ServerAlert> {
		await this.ensureAuthenticated();
		return this.request<ServerAlert>('GET', `/v1/alerts/${id}`);
	}

	async updateAlert(id: string, updates: Partial<Omit<ServerAlert, 'id'>>): Promise<ServerAlert> {
		await this.ensureAuthenticated();
		return this.request<ServerAlert>('PUT', `/v1/alerts/${id}`, updates);
	}

	async deleteAlert(id: string): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('DELETE', `/v1/alerts/${id}`);
	}

	// REST API - Demo Control
	async getDemoStatus(): Promise<DemoStatus> {
		await this.ensureAuthenticated();
		return this.request<DemoStatus>('GET', '/v1/demo/status');
	}

	async startDemo(): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/start');
	}

	async stopDemo(): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/stop');
	}

	async resetDemo(): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/reset');
	}

	async pauseDemo(): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/pause');
	}

	async resumeDemo(): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/resume');
	}

	async setDemoSpeed(speed: number): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/set-speed', { speed });
	}

	async jumpDemo(minutes: number): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/jump', { minutes });
	}

	async getDemoSymbols(): Promise<ServerSymbol[]> {
		await this.ensureAuthenticated();
		return this.request<ServerSymbol[]>('GET', '/v1/demo/symbols');
	}

	async triggerDemoEvent(event: string): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/trigger-event', { event });
	}

	async injectDemoPrice(symbol: string, price: number): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('POST', '/v1/demo/inject-price', { symbol, price });
	}

	// REST API - Resources Catalog
	async getResourcesCatalog(cachedVersion?: string): Promise<ResourcesCatalogResponse | null> {
		await this.ensureAuthenticated();
		const query = cachedVersion ? `?v=${encodeURIComponent(cachedVersion)}` : '';
		return this.request<ResourcesCatalogResponse | null>('GET', `/v1/resources/catalog${query}`);
	}

	async getResourcesCatalogVersion(): Promise<{ version: string; tool_count: number }> {
		await this.ensureAuthenticated();
		return this.request<{ version: string; tool_count: number }>('GET', '/v1/resources/catalog/version');
	}

	async getResourceToolDetail(toolId: string): Promise<ResourceToolDetail> {
		await this.ensureAuthenticated();
		return this.request<ResourceToolDetail>('GET', `/v1/resources/tools/${encodeURIComponent(toolId)}`);
	}

	// REST API - Tool Execution
	async executeToolJob(payload: ServerToolExecutePayload): Promise<ServerToolExecuteResponse> {
		await this.ensureAuthenticated();
		return this.request<ServerToolExecuteResponse>('POST', '/v1/tools/execute', payload);
	}

	async getToolJobStatus(jobId: string): Promise<ToolJobStatusResponse> {
		await this.ensureAuthenticated();
		return this.request<ToolJobStatusResponse>('GET', `/v1/tools/${encodeURIComponent(jobId)}/status`);
	}

	async getToolJobResult(jobId: string): Promise<unknown> {
		await this.ensureAuthenticated();
		return this.request<unknown>('GET', `/v1/tools/${encodeURIComponent(jobId)}/result`);
	}

	async cancelToolJob(jobId: string): Promise<void> {
		await this.ensureAuthenticated();
		await this.request<void>('DELETE', `/v1/tools/${encodeURIComponent(jobId)}`);
	}

	// Strategy Validation
	async validateStrategy(code: string, filename?: string): Promise<import('../../types/strategy').StrategyValidationResponse> {
		await this.ensureAuthenticated();
		const payload: import('../../types/strategy').StrategyValidationRequest = {
			code,
			filename: filename ?? 'strategy.py'
		};
		return this.request<import('../../types/strategy').StrategyValidationResponse>('POST', '/v1/strategies/validate', payload);
	}

	// Strategy Templates
	async getStrategyTemplates(): Promise<import('../../types/strategy').StrategyTemplatesResponse> {
		await this.ensureAuthenticated();
		return this.request<import('../../types/strategy').StrategyTemplatesResponse>('GET', '/v1/strategies/templates');
	}

	// WebSocket Connection
	async connectWebSocket(): Promise<void> {
		if (!WebSocket) {
			throw new Error('WebSocket support not available. Install the "ws" package.');
		}

		// Already connected
		if (this.ws?.readyState === 1) { // WebSocket.OPEN = 1
			return;
		}

		// If connection is in progress, wait for it
		if (this.wsConnecting && this.wsConnectionPromise) {
			return this.wsConnectionPromise;
		}

		// Set connecting flag BEFORE the async ensureAuthenticated call to prevent TOCTOU race
		this.wsConnecting = true;
		this.wsConnectionPromise = (async () => {
			try {
				await this.ensureAuthenticated();

				// Double-check after async call (another caller may have connected)
				if (this.ws?.readyState === 1) {
					return;
				}

				await this.doConnectWebSocket();
			} finally {
				this.wsConnecting = false;
				this.wsConnectionPromise = null;
			}
		})();

		return this.wsConnectionPromise;
	}

	private doConnectWebSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			// Server's checkOrigin() rejects connections with empty Origin.
			// Token is sent via message-based auth (not query param).
			this.ws = new WebSocket!(this.config.wsUrl, {
				headers: {
					'Origin': 'https://api.deltaplus.io',
				}
			}) as WebSocketType;

			const timeout = setTimeout(() => {
				this.ws?.close();
				reject(new Error('WebSocket connection timeout'));
			}, 10000);

			this.ws.on('open', () => {
				// Send auth message -- server validates token and replies with
				// {"type":"connected","data":{"authenticated":true,...}}
				this.ws!.send(JSON.stringify({ type: 'auth', token: this.accessToken }));
			});

			let authConfirmed = false;

			this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
				if (!authConfirmed) {
					try {
						const msg = JSON.parse(data.toString()) as Record<string, unknown>;
						const msgData = msg.data as Record<string, unknown> | undefined;
						// Server sends {"type":"connected","data":{"authenticated":true,...}} on successful auth
						if (msg.type === 'connected' && msgData?.authenticated === true) {
							authConfirmed = true;
							clearTimeout(timeout);
							this.wsReconnectAttempts = 0;
							this._onDidConnect.fire();
							for (const handler of this.connectionHandlers) {
								handler();
							}
							// Re-subscribe to previously subscribed symbols
							if (this.subscribedSymbols.size > 0) {
								this.subscribe(Array.from(this.subscribedSymbols));
							}
							resolve();
							return;
						}
						// Server sends {"type":"connected","data":{"authenticated":false,...}} on auth failure
						if (msg.type === 'connected' && msgData?.authenticated === false) {
							authConfirmed = true;
							clearTimeout(timeout);
							this.ws?.close();
							reject(new Error('WebSocket authentication rejected by server'));
							return;
						}
					} catch { /* not the auth handshake, fall through */ }
				}
				this.handleWebSocketMessage(data);
			});

			this.ws.on('close', () => {
				clearTimeout(timeout);
				if (this.disposed) {
					return;
				}
				this._onDidDisconnect.fire();
				for (const handler of this.disconnectionHandlers) {
					handler();
				}
				this.scheduleReconnect();
			});

			this.ws.on('error', (err: Error) => {
				clearTimeout(timeout);
				for (const handler of this.errorHandlers) {
					handler(err);
				}
				reject(err);
			});
		});
	}

	private handleWebSocketMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
		try {
			const message = JSON.parse(data.toString());

			// Handle job progress events
			if (message && typeof message === 'object' && message.type === 'job-progress') {
				this._onJobProgress.fire({
					jobId: message.job_id,
					progress: message.progress ?? 0,
					message: message.message ?? '',
				});
				return;
			}

			// Handle job completion events
			if (message && typeof message === 'object' && message.type === 'job-complete') {
				this._onJobComplete.fire({ jobId: message.job_id });
				return;
			}

			if (!this.isValidQuote(message)) {
				return;
			}
			const quote = message as ServerQuote;
			this._onQuote.fire(quote);
			for (const handler of this.quoteHandlers) {
				handler(quote);
			}
		} catch (err: unknown) {
			// Log parse errors for debugging but don't crash
			const errMessage = err instanceof Error ? err.message : String(err);
			this.log(`WebSocket message parse error: ${errMessage}`);
		}
	}

	private isValidQuote(message: unknown): message is ServerQuote {
		if (!message || typeof message !== 'object') {
			return false;
		}
		const msg = message as Record<string, unknown>;
		return (
			msg.type === 'quote' &&
			typeof msg.symbol === 'string' &&
			typeof msg.bid === 'number' &&
			typeof msg.ask === 'number' &&
			typeof msg.last === 'number'
		);
	}

	disconnectWebSocket(): void {
		if (this.wsReconnectTimer) {
			clearTimeout(this.wsReconnectTimer);
			this.wsReconnectTimer = null;
		}
		this.wsReconnectAttempts = this.wsMaxReconnectAttempts; // Prevent reconnection

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.subscribedSymbols.clear();
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.wsReconnectAttempts >= this.wsMaxReconnectAttempts) {
			return;
		}

		const delay = this.wsReconnectDelay * Math.pow(2, this.wsReconnectAttempts);
		this.wsReconnectTimer = setTimeout(async () => {
			if (this.disposed) {
				return;
			}
			this.wsReconnectAttempts++;
			try {
				await this.connectWebSocket();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// If reconnect failed due to auth (session expired), stop retrying.
				// onAuthStateChange(false) was already fired by refreshAccessToken().
				if (msg.includes('Not signed in') || msg.includes('session expired') || msg.includes('Refresh token expired')) {
					this.log('WebSocket reconnect aborted -- session expired, user must re-authenticate');
					this.wsReconnectAttempts = this.wsMaxReconnectAttempts; // stop loop
					return;
				}
				// Transient error -- close handler will schedule the next reconnect
			}
		}, delay);
	}

	isWebSocketConnected(): boolean {
		return this.ws?.readyState === 1; // WebSocket.OPEN = 1
	}

	// WebSocket Subscriptions
	subscribe(symbols: string[]): void {
		for (const symbol of symbols) {
			this.subscribedSymbols.add(symbol);
		}

		if (this.ws?.readyState === 1) { // WebSocket.OPEN = 1
			this.ws.send(JSON.stringify({
				type: 'subscribe',
				symbols
			}));
		} else if (this.wsConnecting) {
			// WS is connecting -- symbols are tracked in subscribedSymbols
			// and will be sent automatically when the connection opens
			this.log(`Queued ${symbols.length} subscription(s) for pending connection`);
		}
	}

	unsubscribe(symbols: string[]): void {
		for (const symbol of symbols) {
			this.subscribedSymbols.delete(symbol);
		}

		if (this.ws?.readyState === 1) { // WebSocket.OPEN = 1
			this.ws.send(JSON.stringify({
				type: 'unsubscribe',
				symbols
			}));
		}
	}

	getSubscribedSymbols(): string[] {
		return Array.from(this.subscribedSymbols);
	}

	// Event handlers
	onQuoteReceived(handler: QuoteHandler): vscode.Disposable {
		this.quoteHandlers.add(handler);
		return { dispose: () => this.quoteHandlers.delete(handler) };
	}

	onConnected(handler: ConnectionHandler): vscode.Disposable {
		this.connectionHandlers.add(handler);
		return { dispose: () => this.connectionHandlers.delete(handler) };
	}

	onDisconnected(handler: ConnectionHandler): vscode.Disposable {
		this.disconnectionHandlers.add(handler);
		return { dispose: () => this.disconnectionHandlers.delete(handler) };
	}

	onError(handler: ErrorHandler): vscode.Disposable {
		this.errorHandlers.add(handler);
		return { dispose: () => this.errorHandlers.delete(handler) };
	}

	// HTTP request helper with optional cancellation token
	private async request<T>(method: string, path: string, body?: unknown, token?: vscode.CancellationToken): Promise<T> {
		const maxRetries = 3;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await this.requestOnce<T>(method, path, body, token);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg === 'RATE_LIMITED_429' && attempt < maxRetries) {
					const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
					this.log(`Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
					await new Promise(r => setTimeout(r, delay));
					continue;
				}
				throw err;
			}
		}
		throw new Error('Max retries exceeded');
	}

	private async requestOnce<T>(method: string, path: string, body?: unknown, token?: vscode.CancellationToken): Promise<T> {
		if (token?.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		const url = new URL(path, this.config.baseUrl);
		const isHttps = url.protocol === 'https:';
		const transport = isHttps ? https : http;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

		if (this.accessToken) {
			headers['Authorization'] = `Bearer ${this.accessToken}`;
		}

		return new Promise((resolve, reject) => {
			const options = {
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
				method,
				headers
			};

			const req = transport.request(options, (res) => {
				let data = '';
				res.on('data', chunk => data += chunk);
				res.on('end', () => {
					cleanup();
					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						try {
							if (data) {
								const parsed = JSON.parse(data);
								// Server wraps responses in { success: true, data: ... }
								if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'success') && Object.prototype.hasOwnProperty.call(parsed, 'data')) {
									if (parsed.success) {
										resolve(parsed.data as T);
									} else {
										reject(new Error(parsed.error?.message ?? 'Request failed'));
									}
								} else {
									resolve(parsed as T);
								}
							} else {
								resolve(undefined as T);
							}
						} catch {
							resolve(data as T);
						}
					} else if (res.statusCode === 429) {
						cleanup();
						reject(new Error('RATE_LIMITED_429'));
					} else {
						// Sanitize error messages - don't expose internal details
						let errorMessage = `Server error (${res.statusCode})`;
						try {
							const errorBody = JSON.parse(data);
							if (errorBody.message && typeof errorBody.message === 'string') {
								// Use message if it looks safe (limit length, no stack traces)
								const safeMessage = errorBody.message.substring(0, 200);
								if (!safeMessage.includes('at ') && !safeMessage.includes('Error:')) {
									errorMessage = safeMessage;
								}
							} else if (errorBody.error && typeof errorBody.error === 'string') {
								errorMessage = errorBody.error.substring(0, 200);
							}
						} catch {
							// Use generic error message
						}
						this.log(`Request failed: ${method} ${path} - ${errorMessage}`);
						reject(new Error(errorMessage));
					}
				});
			});

			// Handle cancellation with proper cleanup
			let cancelDisposable: vscode.Disposable | undefined;
			if (token) {
				cancelDisposable = token.onCancellationRequested(() => {
					req.destroy();
					cancelDisposable?.dispose();
					reject(new Error('Cancelled'));
				});
			}

			// Cleanup cancellation listener on completion
			const cleanup = () => {
				cancelDisposable?.dispose();
			};

			req.on('error', (err) => {
				cleanup();
				this.log(`Request error: ${method} ${path} - ${err.message}`);
				reject(new Error('Network error'));
			});
			req.setTimeout(30000, () => {
				cleanup();
				req.destroy();
				this.log(`Request timeout: ${method} ${path}`);
				reject(new Error('Request timeout'));
			});

			if (body) {
				req.write(JSON.stringify(body));
			}

			req.end();
		});
	}
}
