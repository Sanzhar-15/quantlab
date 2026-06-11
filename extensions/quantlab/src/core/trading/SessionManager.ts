/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AlpacaAdapter } from '../broker/AlpacaAdapter';
import { BrokerAdapter } from '../broker/BrokerAdapter';
import { MockBrokerAdapter } from '../broker/MockBrokerAdapter';
import { GlobalState } from '../state/GlobalState';
import { HistoryState } from '../state/HistoryState';
import { ComplexityAnalyzer } from '../strategy/ComplexityAnalyzer';
import { ParameterExtractor } from '../strategy/ParameterExtractor';
import { StrategyValidator } from '../strategy/StrategyValidator';
import {
	ActivityEntry,
	BrokerAccount,
	Fill,
	Order,
	OrderSide,
	PerformanceMetrics,
	Position,
	RequirementsCheck,
	RiskAlert,
	SessionInfo,
	SessionType,
	TradeErrorState,
	TradeSessionSummary
} from '../../types/trading';
import { DaemonClient, createDaemonClient } from './DaemonClient';
import { RoundTripBook } from './RoundTripAccounting';
import { DaemonSecretsSync } from './DaemonSecretsSync';
import { LiveDaemonManager, DaemonConfig } from './LiveDaemonManager';
import { TrustManager } from '../trust/TrustManager';
import { DaemonPosition, DaemonOrder, DaemonFill, RiskAlert as DaemonRiskAlert, OrderRequest } from '../ipc';

const SUMMARY_KEY = 'quantlab.trade.sessionSummaries';
const RISK_REVIEW_KEY = 'quantlab.trade.riskReviewed';
const SELECTED_ACCOUNT_KEY = 'quantlab.trade.selectedAccount';

const HEARTBEAT_OK_MS = 10000;
const HEARTBEAT_STALE_MS = 20000;
const UPDATE_COALESCE_MS = 200;

// Severity order for heartbeat states (M51): used to combine the
// time-derived status with the daemon's self-reported health.
const HEARTBEAT_SEVERITY: Record<'ok' | 'stale' | 'lost', number> = { ok: 0, stale: 1, lost: 2 };

/**
 * Fill reconciler for idempotent fill processing.
 *
 * Spec Reference: Technical Spec section 10.6 - Fill Reconciliation
 *
 * Handles:
 * - Duplicate fill detection via fill ID tracking
 * - Sequence number tracking for ordering guarantees
 * - Out-of-order fill detection and reordering
 */
class FillReconciler {
	/** Set of processed fill IDs for duplicate detection */
	private readonly processedFills: Set<string> = new Set();

	/** Last processed sequence number */
	private lastSequence: number = 0;

	/** Buffer for out-of-order fills awaiting processing */
	private readonly outOfOrderBuffer: Map<number, Fill> = new Map();

	/** Maximum fills to track (prevents unbounded memory growth) */
	private readonly maxTrackedFills: number;

	/** Maximum sequence gap before forcing processing */
	private readonly maxSequenceGap: number;

	constructor(maxTrackedFills: number = 10000, maxSequenceGap: number = 100) {
		this.maxTrackedFills = maxTrackedFills;
		this.maxSequenceGap = maxSequenceGap;
	}

	/**
	 * Process a fill with idempotency guarantees.
	 *
	 * @param fill - The fill to process
	 * @param sequence - Optional sequence number for ordering
	 * @returns Object indicating if fill was processed and if it was a duplicate
	 */
	processFill(fill: Fill, sequence?: number): {
		processed: boolean;
		isDuplicate: boolean;
		isOutOfOrder: boolean;
		buffered: boolean;
	} {
		// Check for duplicate
		if (this.processedFills.has(fill.id)) {
			return { processed: false, isDuplicate: true, isOutOfOrder: false, buffered: false };
		}

		// If no sequence provided, process immediately
		if (sequence === undefined) {
			this.markProcessed(fill);
			return { processed: true, isDuplicate: false, isOutOfOrder: false, buffered: false };
		}

		// Check sequence ordering
		const expectedSequence = this.lastSequence + 1;

		if (sequence === expectedSequence) {
			// In order - process this fill and any buffered fills
			this.markProcessed(fill);
			this.lastSequence = sequence;
			return { processed: true, isDuplicate: false, isOutOfOrder: false, buffered: false };
		}

		if (sequence <= this.lastSequence) {
			// Already processed (duplicate or late arrival)
			if (this.processedFills.has(fill.id)) {
				return { processed: false, isDuplicate: true, isOutOfOrder: true, buffered: false };
			}
			// Late arrival but not duplicate - process it anyway
			this.markProcessed(fill);
			return { processed: true, isDuplicate: false, isOutOfOrder: true, buffered: false };
		}

		// Out of order (sequence > expected) - buffer for later processing
		if (sequence - this.lastSequence > this.maxSequenceGap) {
			// Gap too large - process anyway to prevent stalls
			this.markProcessed(fill);
			this.lastSequence = sequence;
			return { processed: true, isDuplicate: false, isOutOfOrder: true, buffered: false };
		}

		// Buffer the fill
		this.outOfOrderBuffer.set(sequence, fill);
		return { processed: false, isDuplicate: false, isOutOfOrder: true, buffered: true };
	}

	/**
	 * Process any buffered fills that are now in sequence.
	 *
	 * @returns List of fills that were processed from buffer
	 */
	processBufferedFills(): Fill[] {
		const processed: Fill[] = [];
		let nextSequence = this.lastSequence + 1;

		while (this.outOfOrderBuffer.has(nextSequence)) {
			const fill = this.outOfOrderBuffer.get(nextSequence)!;
			this.outOfOrderBuffer.delete(nextSequence);
			this.markProcessed(fill);
			processed.push(fill);
			this.lastSequence = nextSequence;
			nextSequence++;
		}

		return processed;
	}

	/**
	 * Mark a fill as processed.
	 */
	private markProcessed(fill: Fill): void {
		this.processedFills.add(fill.id);

		// Prevent unbounded growth by removing oldest fills when at capacity
		if (this.processedFills.size > this.maxTrackedFills) {
			// Convert to array, remove first 10% of entries
			const fills = Array.from(this.processedFills);
			const toRemove = Math.floor(this.maxTrackedFills * 0.1);
			for (let i = 0; i < toRemove; i++) {
				this.processedFills.delete(fills[i]);
			}
		}
	}

	/**
	 * Check if a fill has been processed.
	 */
	isProcessed(fillId: string): boolean {
		return this.processedFills.has(fillId);
	}

	/**
	 * Get current sequence number.
	 */
	getLastSequence(): number {
		return this.lastSequence;
	}

	/**
	 * Get count of buffered out-of-order fills.
	 */
	getBufferedCount(): number {
		return this.outOfOrderBuffer.size;
	}

	/**
	 * Reset the reconciler state.
	 */
	reset(): void {
		this.processedFills.clear();
		this.outOfOrderBuffer.clear();
		this.lastSequence = 0;
	}
}

interface AccountConfig {
	id: string;
	name: string;
	broker: 'alpaca' | 'mock';
	type: SessionType;
}

interface BrokerConnection {
	adapter: BrokerAdapter;
	refCount: number;
	account: BrokerAccount;
}

interface SessionRecord {
	info: SessionInfo;
	broker: BrokerAdapter;
	positions: Position[];
	orders: Order[];
	performance: PerformanceMetrics;
	activity: ActivityEntry[];
	lastBrokerUpdate: number;
	heartbeatStatus: 'ok' | 'stale' | 'lost';
	seq: number;
	pendingPositions?: Position[];
	pendingOrders?: Order[];
	positionsTimer?: NodeJS.Timeout;
	ordersTimer?: NodeJS.Timeout;
	heartbeatTimer?: NodeJS.Timeout;
	activeRiskAlerts: Set<string>;
	// Fill reconciliation for idempotency
	fillReconciler: FillReconciler;
	// Fill-driven round-trip P&L accounting (H31): feeds totalTrades,
	// winRate, avgWin, avgLoss and realizedPnL in `performance`.
	roundTrips: RoundTripBook;
	// Daemon IPC integration
	daemonClient?: DaemonClient;
	useDaemon: boolean;
	// Last health status self-reported by the daemon (M51). checkHeartbeat
	// never shows a BETTER status than this, so a degraded/unhealthy daemon
	// cannot be concealed by recent IPC traffic.
	daemonHealth?: 'ok' | 'stale' | 'lost';
}

export class SessionManager {
	private static instance: SessionManager | undefined;

	private readonly sessions = new Map<string, SessionRecord>();
	private readonly brokers = new Map<string, BrokerConnection>();
	private readonly startingSessionKeys = new Set<string>(); // Prevent concurrent startSession() for same params
	private accounts: BrokerAccount[] = [];
	private sessionSummaries: TradeSessionSummary[] = [];
	private riskReviewed = new Map<string, boolean>();
	private selectedAccountId: string | undefined;

	private readonly validator = StrategyValidator.getInstance();
	private readonly complexityAnalyzer = ComplexityAnalyzer.getInstance();
	private readonly parameterExtractor = ParameterExtractor.getInstance();
	private readonly outputChannel = vscode.window.createOutputChannel('Quantlab Trading');
	private readonly daemonManager = LiveDaemonManager.getInstance();
	private readonly daemonClients = new Map<string, DaemonClient>();

	private readonly _onSessionsChanged = new vscode.EventEmitter<void>();
	readonly onSessionsChanged = this._onSessionsChanged.event;

	private readonly _onAccountsChanged = new vscode.EventEmitter<void>();
	readonly onAccountsChanged = this._onAccountsChanged.event;

	private readonly _onSessionStarted = new vscode.EventEmitter<SessionInfo>();
	readonly onSessionStarted = this._onSessionStarted.event;

	private readonly _onSessionUpdated = new vscode.EventEmitter<SessionInfo>();
	readonly onSessionUpdated = this._onSessionUpdated.event;

	private readonly _onSessionStopped = new vscode.EventEmitter<{ sessionId: string; reason?: string }>();
	readonly onSessionStopped = this._onSessionStopped.event;

	private readonly _onPositionsUpdate = new vscode.EventEmitter<{ sessionId: string; positions: Position[]; seq: number }>();
	readonly onPositionsUpdate = this._onPositionsUpdate.event;

	private readonly _onOrdersUpdate = new vscode.EventEmitter<{ sessionId: string; orders: Order[]; seq: number }>();
	readonly onOrdersUpdate = this._onOrdersUpdate.event;

	private readonly _onFill = new vscode.EventEmitter<{ sessionId: string; fill: Fill; seq: number }>();
	readonly onFill = this._onFill.event;

	private readonly _onPerformanceUpdate = new vscode.EventEmitter<{ sessionId: string; performance: PerformanceMetrics; seq: number }>();
	readonly onPerformanceUpdate = this._onPerformanceUpdate.event;

	private readonly _onActivity = new vscode.EventEmitter<{ sessionId: string; entry: ActivityEntry; seq: number }>();
	readonly onActivity = this._onActivity.event;

	private readonly _onRiskAlert = new vscode.EventEmitter<{ sessionId: string; alert: RiskAlert }>();
	readonly onRiskAlert = this._onRiskAlert.event;

	private readonly _onHeartbeat = new vscode.EventEmitter<{ sessionId: string; status: 'ok' | 'stale' | 'lost'; lastSeen: number }>();
	readonly onHeartbeat = this._onHeartbeat.event;

	private readonly _onError = new vscode.EventEmitter<{ sessionId: string; error: TradeErrorState }>();
	readonly onError = this._onError.event;

	private readonly _onRequirementsChanged = new vscode.EventEmitter<{ strategyPath: string; requirements: RequirementsCheck }>();
	readonly onRequirementsChanged = this._onRequirementsChanged.event;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly globalState: GlobalState,
		private readonly historyState: HistoryState
	) {
		this.restoreSessionSummaries();
		this.restoreRiskReviewed();
		this.selectedAccountId = context.workspaceState.get<string>(SELECTED_ACCOUNT_KEY);
		this.reloadAccounts();

		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('quantlab.trading.accounts')) {
					this.reloadAccounts();
				}
				if (event.affectsConfiguration('quantlab.trading')) {
					this.emitRequirementsForOpenStrategies();
				}
			}),
			this.historyState.onDidChange(() => this.emitRequirementsForOpenStrategies()),
			this.validator.onDidValidate(({ uri }) => {
				// Only real on-disk strategies have requirements. Virtual docs
				// (e.g. quantlab-server:// symbol tabs) must not be re-opened via
				// fsPath -- that strips the scheme and points at a nonexistent
				// file:// path (one unhandled rejection per Data-tree click).
				if (uri.scheme === 'file') {
					this.emitRequirementsForStrategy(uri.fsPath);
				}
			})
		);
	}

	static initialize(context: vscode.ExtensionContext, globalState: GlobalState, historyState: HistoryState): SessionManager {
		if (!SessionManager.instance) {
			SessionManager.instance = new SessionManager(context, globalState, historyState);
		}
		return SessionManager.instance;
	}

	static getInstance(): SessionManager {
		if (!SessionManager.instance) {
			throw new Error('SessionManager not initialized');
		}
		return SessionManager.instance;
	}

	dispose(): void {
		// Clear all active session timers before clearing the sessions map
		for (const session of this.sessions.values()) {
			if (session.positionsTimer) { clearTimeout(session.positionsTimer); session.positionsTimer = undefined; }
			if (session.ordersTimer) { clearTimeout(session.ordersTimer); session.ordersTimer = undefined; }
			if (session.heartbeatTimer) { clearInterval(session.heartbeatTimer); session.heartbeatTimer = undefined; }
		}

		// Disconnect all active daemon clients
		for (const client of this.daemonClients.values()) {
			try { client.disconnect(true); } catch { /* best effort */ }
		}
		this.daemonClients.clear();
		this.sessions.clear();

		// Disconnect all broker adapters
		for (const connection of this.brokers.values()) {
			try { void connection.adapter.disconnect(); } catch { /* best effort */ }
		}
		this.brokers.clear();

		this._onSessionsChanged.dispose();
		this._onAccountsChanged.dispose();
		this._onSessionStarted.dispose();
		this._onSessionUpdated.dispose();
		this._onSessionStopped.dispose();
		this._onPositionsUpdate.dispose();
		this._onOrdersUpdate.dispose();
		this._onFill.dispose();
		this._onPerformanceUpdate.dispose();
		this._onActivity.dispose();
		this._onRiskAlert.dispose();
		this._onHeartbeat.dispose();
		this._onError.dispose();
		this._onRequirementsChanged.dispose();
		this.outputChannel.dispose();
	}

	static resetInstance(): void {
		if (SessionManager.instance) {
			SessionManager.instance.dispose();
			SessionManager.instance = undefined;
		}
	}

	getAccounts(): BrokerAccount[] {
		return this.accounts.map(account => ({ ...account }));
	}

	getOutputChannel(): vscode.OutputChannel {
		return this.outputChannel;
	}

	getSelectedAccountId(): string | undefined {
		return this.selectedAccountId;
	}

	setSelectedAccountId(accountId: string | undefined): void {
		this.selectedAccountId = accountId;
		void this.context.workspaceState.update(SELECTED_ACCOUNT_KEY, accountId);
		this._onAccountsChanged.fire();
	}

	getActiveSessions(): SessionInfo[] {
		return Array.from(this.sessions.values())
			.map(session => session.info)
			.filter(session => session.status === 'running' || session.status === 'paused');
	}

	getAllSessions(): SessionInfo[] {
		return Array.from(this.sessions.values()).map(session => ({ ...session.info }));
	}

	getSession(sessionId: string): SessionInfo | undefined {
		const session = this.sessions.get(sessionId);
		return session ? { ...session.info } : undefined;
	}

	getSessionRecord(sessionId: string): SessionRecord | undefined {
		return this.sessions.get(sessionId);
	}

	getSessionForStrategy(strategyPath: string): SessionInfo | undefined {
		for (const session of this.sessions.values()) {
			if (session.info.strategyPath === strategyPath && session.info.status !== 'stopped') {
				return { ...session.info };
			}
		}
		return undefined;
	}

	getAllPositions(): Position[] {
		const positions: Position[] = [];
		for (const session of this.sessions.values()) {
			positions.push(...session.positions);
		}
		return positions;
	}

	getAllOpenOrders(): Order[] {
		const orders: Order[] = [];
		for (const session of this.sessions.values()) {
			orders.push(...session.orders.filter(order => order.status === 'open' || order.status === 'partial'));
		}
		return orders;
	}

	getSessionPnL(sessionId: string): number {
		const session = this.sessions.get(sessionId);
		return session?.performance.sessionPnL ?? 0;
	}

	getRiskStatus(): { dailyLossPercent: number } {
		let totalDailyLoss = 0;
		let totalDailyLimit = 0;
		const limit = this.getDailyLossLimit();

		for (const session of this.sessions.values()) {
			totalDailyLoss += Math.min(0, session.performance.todayPnL);
			if (limit > 0) {
				totalDailyLimit += limit;
			}
		}

		return {
			dailyLossPercent: totalDailyLimit > 0 ? (Math.abs(totalDailyLoss) / totalDailyLimit) * 100 : 0
		};
	}

	async startSession(strategyPath: string, type: SessionType, accountId?: string): Promise<SessionInfo | undefined> {
		const doc = await vscode.workspace.openTextDocument(strategyPath);
		const validation = this.validator.validateDocument(doc);
		if (!validation.isValid) {
			void vscode.window.showWarningMessage('Trade session requires a valid strategy entrypoint.');
			return undefined;
		}

		// FIX-CGP-010: Gate live trading with TrustManager verification
		if (type === 'live') {
			const trustManager = TrustManager.getInstance();
			const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
			const trustResult = await trustManager.verifyForLiveTradingWithPrompts(strategyPath, workspaceUri);
			if (!trustResult.isValid) {
				void vscode.window.showWarningMessage(
					`Live trading blocked: ${trustResult.reason ?? 'Trust verification failed'}. ` +
					'Workspace and strategy must be trusted for live trading.'
				);
				return undefined;
			}
		}

		// FIX-CGP-014: Run pre-trade checklist before session start
		if (type === 'live' || type === 'paper') {
			const { PreTradeChecklist } = await import('../../ui/dialogs/PreTradeChecklist');
			const checklist = PreTradeChecklist.getInstance();
			const checkResult = await checklist.show({
				strategyPath,
				symbol: '',
				timeframe: '',
				type,
			});

			if (checkResult && !checkResult.approved) {
				const failedItems = checkResult.items
					?.filter((item: { status: string }) => item.status === 'fail')
					.map((item: { label: string }) => item.label)
					.join(', ');
				void vscode.window.showWarningMessage(`Pre-trade checklist failed: ${failedItems ?? 'unknown'}`);
				return undefined;
			}
		}

		const requirements = await this.getRequirementsCheck(strategyPath);
		const eligibility = await this.checkEligibility(requirements, type);
		if (!eligibility.ok) {
			void vscode.window.showWarningMessage(eligibility.reason ?? 'Trade session blocked.');
			return undefined;
		}

		const account = this.resolveAccount(type, accountId);
		if (!account) {
			void vscode.window.showWarningMessage('No broker account configured for this session.');
			return undefined;
		}

		const existing = Array.from(this.sessions.values()).find(session =>
			session.info.strategyPath === strategyPath &&
			session.info.accountId === account.id &&
			session.info.type === type &&
			session.info.status !== 'stopped');

		if (existing) {
			return { ...existing.info };
		}

		// Prevent two concurrent startSession() calls for the same params from both succeeding
		const startKey = `${strategyPath}::${account.id}::${type}`;
		if (this.startingSessionKeys.has(startKey)) {
			return undefined;
		}
		this.startingSessionKeys.add(startKey);

		let broker: BrokerAdapter;
		try {
			broker = await this.acquireBroker(account);
		} catch (error) {
			this.startingSessionKeys.delete(startKey);
			void vscode.window.showErrorMessage(`Failed to connect broker: ${(error as Error).message}`);
			return undefined;
		}

		const now = Date.now();
		const hash = await this.computeStrategyHash(doc);
		const sessionId = this.generateSessionId(type);
		const info: SessionInfo = {
			id: sessionId,
			type,
			status: 'starting',
			strategyPath,
			strategyHash: hash,
			accountId: account.id,
			accountName: account.name,
			startedAt: now,
			lastHeartbeat: now,
			symbol: this.globalState.getDataSource()?.displayName ?? '',
			timeframe: this.globalState.getTimeframe() ?? '1D'
		};

		const record: SessionRecord = {
			info,
			broker,
			positions: [],
			orders: [],
			performance: this.defaultPerformance(),
			activity: [],
			lastBrokerUpdate: now,
			heartbeatStatus: 'ok',
			seq: 0,
			activeRiskAlerts: new Set(),
			fillReconciler: new FillReconciler(),
			roundTrips: new RoundTripBook(),
			useDaemon: false,
		};

		this.sessions.set(sessionId, record);
		this.startingSessionKeys.delete(startKey); // Session is now tracked; release the in-progress lock

		broker.subscribeToUpdates({
			onPositionUpdate: positions => this.handlePositionsUpdate(sessionId, positions),
			onOrderUpdate: orders => this.handleOrdersUpdate(sessionId, orders),
			onFill: fill => this.handleFill(sessionId, fill)
		});

		try {
			const [positions, orders] = await Promise.all([
				broker.getPositions(),
				broker.getOpenOrders()
			]);
			this.handlePositionsUpdate(sessionId, positions);
			this.handleOrdersUpdate(sessionId, orders);
		} catch (error) {
			this.handleError(sessionId, 'broker_state', (error as Error).message, true);
		}

		record.info.status = 'running';
		this.addActivity(sessionId, 'system', `${type === 'paper' ? 'Paper' : 'Live'} session started`);
		this.startHeartbeat(sessionId);

		this._onSessionStarted.fire({ ...record.info });
		this._onSessionsChanged.fire();
		return { ...record.info };
	}

	async pauseSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session || session.info.status !== 'running') {
			return;
		}

		// Call daemon client if available
		if (session.useDaemon && session.daemonClient) {
			try {
				await session.daemonClient.pauseSession();
			} catch (error) {
				this.handleError(sessionId, 'daemon_ipc', `Failed to pause daemon: ${(error as Error).message}`, false);
			}
		}

		session.info.status = 'paused';
		this.addActivity(sessionId, 'system', 'Session paused');
		this._onSessionUpdated.fire({ ...session.info });
		this._onSessionsChanged.fire();
	}

	async resumeSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session || session.info.status !== 'paused') {
			return;
		}

		// Call daemon client if available
		if (session.useDaemon && session.daemonClient) {
			try {
				await session.daemonClient.resumeSession();
			} catch (error) {
				this.handleError(sessionId, 'daemon_ipc', `Failed to resume daemon: ${(error as Error).message}`, false);
			}
		}

		session.info.status = 'running';
		this.addActivity(sessionId, 'system', 'Session resumed');
		this._onSessionUpdated.fire({ ...session.info });
		this._onSessionsChanged.fire();
	}

	async refreshSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		try {
			const [positions, orders] = await Promise.all([
				session.broker.getPositions(),
				session.broker.getOpenOrders()
			]);
			this.handlePositionsUpdate(sessionId, positions);
			this.handleOrdersUpdate(sessionId, orders);
		} catch (error) {
			this.handleError(sessionId, 'broker_state', (error as Error).message, true);
		}
	}

	async restartSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		// H28: capture the daemon flag BEFORE stopping -- stopSession deletes
		// the session record. Daemon-backed sessions must restart on the
		// daemon path (daemon process + IPC + secrets sync), not on the
		// in-process broker-adapter path.
		const { strategyPath, type, accountId } = session.info;
		const useDaemon = session.useDaemon;
		await this.stopSession(sessionId, 'restart');
		if (useDaemon) {
			await this.startDaemonSession(strategyPath, type, accountId);
		} else {
			await this.startSession(strategyPath, type, accountId);
		}
	}

	async stopSession(sessionId: string, reason?: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		// Reentrancy gate: kill switch + webview Stop (or any two stop entry
		// points) can race -- a second teardown would double the stopSession
		// RPC / stopDaemon / releaseBroker (disconnecting a shared-account
		// broker out from under another session) and double-fire
		// sessionStopped. First caller wins; the loser logs and returns.
		if (session.info.status === 'stopping') {
			this.outputChannel.appendLine(`[${sessionId}] stopSession re-entered while already stopping (reason=${reason ?? 'none'}) -- ignored.`);
			return;
		}

		// H27 root fix: a daemon-backed session must tear down the Python
		// daemon process, not just release the broker adapter -- otherwise
		// the daemon keeps running and can keep placing orders after the
		// operator believes the session (or the kill switch) stopped it.
		// Delegating here guarantees EVERY stop path (kill switch, webview
		// stop, restart, trust revocation, orphan cleanup commands) kills
		// the daemon, regardless of which entry point the caller used.
		if (session.useDaemon) {
			return this.stopDaemonSession(sessionId, reason);
		}

		session.info.status = 'stopping';
		session.broker.unsubscribeFromUpdates();
		this.stopHeartbeat(sessionId);

		// Clear polling timers before releasing broker
		if (session.positionsTimer) { clearTimeout(session.positionsTimer); session.positionsTimer = undefined; }
		if (session.ordersTimer) { clearTimeout(session.ordersTimer); session.ordersTimer = undefined; }

		try {
			await this.releaseBroker(session.info.accountId);
		} catch (error) {
			// A failed broker release must not leave the session stuck in
			// 'stopping' (the reentrancy gate would then ignore every retry).
			session.info.status = 'error';
			this.outputChannel.appendLine(`[${sessionId}] Broker release failed during stop: ${(error as Error).message}`);
			throw error;
		}

		session.info.status = 'stopped';
		session.info.endedAt = Date.now();

		this.addActivity(sessionId, 'system', 'Session stopped');
		this.storeSessionSummary(session.info);

		this.sessions.delete(sessionId);
		this._onSessionStopped.fire({ sessionId, reason });
		this._onSessionsChanged.fire();
	}

	getSessionSnapshot(sessionId: string): {
		session: SessionInfo;
		positions: Position[];
		orders: Order[];
		performance: PerformanceMetrics;
		activity: ActivityEntry[];
		heartbeat: { status: 'ok' | 'stale' | 'lost'; lastSeen: number };
	} | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return undefined;
		}

		return {
			session: { ...session.info },
			positions: session.positions.map(position => ({ ...position })),
			orders: session.orders.map(order => ({ ...order })),
			performance: { ...session.performance },
			activity: session.activity.map(entry => ({ ...entry })),
			heartbeat: { status: session.heartbeatStatus, lastSeen: session.lastBrokerUpdate }
		};
	}

	async getRequirementsCheck(strategyPath: string): Promise<RequirementsCheck> {
		const doc = await vscode.workspace.openTextDocument(strategyPath);
		const validation = this.validator.getValidationResult(doc) ?? this.validator.validateDocument(doc);
		const params = this.parameterExtractor.extract(doc);
		const complexity = this.complexityAnalyzer.analyze(doc, params).level;
		const brokerConfigured = this.accounts.length > 0;
		const hasBacktest = this.historyState.getByStrategy(strategyPath)
			.some(entry => entry.type === 'backtest' && entry.status === 'completed');
		const hasPaperTrading = this.sessionSummaries.some(summary =>
			summary.strategyPath === strategyPath && summary.type === 'paper');
		const riskReviewed = this.riskReviewed.get(strategyPath) ?? false;

		return {
			validStrategy: validation.isValid,
			complexity,
			brokerConfigured,
			hasBacktest,
			hasPaperTrading,
			riskReviewed
		};
	}

	getRequirementsPolicy(): { requireBacktest: boolean; requirePaperTrading: boolean; requireRiskReview: boolean } {
		const config = vscode.workspace.getConfiguration('quantlab.trading');
		return {
			requireBacktest: Boolean(config.get('requireBacktest')),
			requirePaperTrading: Boolean(config.get('requirePaperTrading')),
			requireRiskReview: Boolean(config.get('requireRiskReview'))
		};
	}

	markRiskReviewed(strategyPath: string): void {
		this.riskReviewed.set(strategyPath, true);
		void this.context.workspaceState.update(RISK_REVIEW_KEY, Array.from(this.riskReviewed.entries()));
		this.emitRequirementsForStrategy(strategyPath);
	}

	hasBrokerConfigured(): boolean {
		return this.accounts.length > 0;
	}

	private async checkEligibility(requirements: RequirementsCheck, type: SessionType): Promise<{ ok: boolean; reason?: string }> {
		if (!requirements.validStrategy) {
			return { ok: false, reason: 'Strategy validation failed.' };
		}

		if (!requirements.brokerConfigured) {
			return { ok: false, reason: 'No broker accounts configured.' };
		}

		if (type === 'live' && requirements.complexity === 'viewOnly') {
			return { ok: false, reason: 'View-only strategies cannot run live trading.' };
		}

		if (type === 'live' && requirements.complexity === 'partial') {
			const proceed = await vscode.window.showWarningMessage(
				'This strategy has partial complexity validation. Continue with live trading?',
				{ modal: true },
				'Continue'
			);
			if (proceed !== 'Continue') {
				return { ok: false, reason: 'Live trading cancelled.' };
			}
		}

		if (type === 'live') {
			const policy = this.getRequirementsPolicy();
			if (policy.requireBacktest && !requirements.hasBacktest) {
				return { ok: false, reason: 'A completed backtest is required before live trading.' };
			}
			if (policy.requirePaperTrading && !requirements.hasPaperTrading) {
				return { ok: false, reason: 'A completed paper trading session is required before live trading.' };
			}
			if (policy.requireRiskReview && !requirements.riskReviewed) {
				return { ok: false, reason: 'Risk review is required before live trading.' };
			}
		}

		return { ok: true };
	}

	private handlePositionsUpdate(sessionId: string, positions: Position[]): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		session.lastBrokerUpdate = Date.now();
		session.pendingPositions = positions;

		if (session.positionsTimer) {
			return;
		}

		session.positionsTimer = setTimeout(() => {
			session.positionsTimer = undefined;
			if (!session.pendingPositions) {
				return;
			}

			session.positions = session.pendingPositions;
			session.pendingPositions = undefined;

			this.updatePerformance(session);
			this.evaluateRisk(session);
			const seq = this.nextSeq(session);
			this._onPositionsUpdate.fire({ sessionId, positions: session.positions.map(position => ({ ...position })), seq });
			this._onPerformanceUpdate.fire({ sessionId, performance: { ...session.performance }, seq });
		}, UPDATE_COALESCE_MS);
	}

	private handleOrdersUpdate(sessionId: string, orders: Order[]): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		session.lastBrokerUpdate = Date.now();
		session.pendingOrders = orders;

		if (session.ordersTimer) {
			return;
		}

		session.ordersTimer = setTimeout(() => {
			session.ordersTimer = undefined;
			if (!session.pendingOrders) {
				return;
			}

			session.orders = session.pendingOrders;
			session.pendingOrders = undefined;

			const seq = this.nextSeq(session);
			this._onOrdersUpdate.fire({ sessionId, orders: session.orders.map(order => ({ ...order })), seq });
			this.evaluateRisk(session);
		}, UPDATE_COALESCE_MS);
	}

	private handleFill(sessionId: string, fill: Fill, sequence?: number): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		// Use FillReconciler for idempotency
		const result = session.fillReconciler.processFill(fill, sequence);

		if (result.isDuplicate) {
			// Duplicate fill detected - skip processing
			this.outputChannel.appendLine(`[${sessionId}] Duplicate fill detected: ${fill.id}`);
			return;
		}

		if (result.buffered) {
			// Fill is out of order and buffered - don't process yet
			this.outputChannel.appendLine(`[${sessionId}] Fill ${fill.id} buffered (out-of-order, seq=${sequence})`);
			return;
		}

		if (result.isOutOfOrder && result.processed) {
			// Fill was out of order but processed anyway (late arrival or gap too large)
			this.outputChannel.appendLine(`[${sessionId}] Out-of-order fill processed: ${fill.id} (seq=${sequence})`);
		}

		session.lastBrokerUpdate = Date.now();
		this.applyFillToRoundTrips(session, fill);
		const seq = this.nextSeq(session);
		this._onFill.fire({ sessionId, fill: { ...fill }, seq });
		this.addActivity(sessionId, 'fill', `Fill: ${fill.side.toUpperCase()} ${fill.quantity} ${fill.symbol} @ $${fill.price.toFixed(2)}`);
		this.updatePerformance(session);
		this._onPerformanceUpdate.fire({ sessionId, performance: { ...session.performance }, seq });

		// Process any buffered fills that are now in sequence
		const bufferedFills = session.fillReconciler.processBufferedFills();
		for (const bufferedFill of bufferedFills) {
			this.applyFillToRoundTrips(session, bufferedFill);
			const bufferedSeq = this.nextSeq(session);
			this._onFill.fire({ sessionId, fill: { ...bufferedFill }, seq: bufferedSeq });
			this.addActivity(sessionId, 'fill', `Fill: ${bufferedFill.side.toUpperCase()} ${bufferedFill.quantity} ${bufferedFill.symbol} @ $${bufferedFill.price.toFixed(2)}`);
		}

		if (bufferedFills.length > 0) {
			this.updatePerformance(session);
			this._onPerformanceUpdate.fire({ sessionId, performance: { ...session.performance }, seq: this.nextSeq(session) });
		}
	}

	private handleError(sessionId: string, code: string, message: string, recoverable?: boolean): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		const error: TradeErrorState = { code, message, recoverable };
		this._onError.fire({ sessionId, error });
		this.outputChannel.appendLine(`[${sessionId}] ${code}: ${message}`);
	}

	private addActivity(sessionId: string, type: ActivityEntry['type'], message: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		const entry: ActivityEntry = {
			id: `act-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
			timestamp: Date.now(),
			type,
			message
		};
		session.activity.unshift(entry);
		if (session.activity.length > 120) {
			session.activity.pop();
		}
		const seq = this.nextSeq(session);
		this._onActivity.fire({ sessionId, entry, seq });
	}

	/**
	 * Feed a processed fill into the session's round-trip book and copy the
	 * resulting trade statistics into `session.performance` (H31). Realized
	 * P&L flows from here into updatePerformance's sessionPnL/todayPnL.
	 */
	private applyFillToRoundTrips(session: SessionRecord, fill: Fill): void {
		const stats = session.roundTrips.applyFill({
			symbol: fill.symbol,
			side: fill.side,
			quantity: fill.quantity,
			price: fill.price,
			commission: fill.commission,
		});
		session.performance.realizedPnL = stats.realizedPnL;
		session.performance.totalTrades = stats.totalTrades;
		session.performance.winRate = stats.winRate;
		session.performance.avgWin = stats.avgWin;
		session.performance.avgLoss = stats.avgLoss;
	}

	private updatePerformance(session: SessionRecord): void {
		const openPnL = session.positions.reduce((sum, position) => sum + position.unrealizedPnL, 0);
		session.performance.openPnL = openPnL;
		session.performance.sessionPnL = session.performance.realizedPnL + openPnL;
		session.performance.todayPnL = session.performance.sessionPnL;
	}

	private evaluateRisk(session: SessionRecord): void {
		const dailyLossLimit = this.getDailyLossLimit();
		if (dailyLossLimit > 0 && session.performance.todayPnL < -dailyLossLimit) {
			this.raiseRiskAlert(session, 'dailyLoss', 'Daily loss limit exceeded.', Math.abs(session.performance.todayPnL), dailyLossLimit);
		} else {
			session.activeRiskAlerts.delete('dailyLoss');
		}

		const maxPositionSize = this.getMaxPositionSize();
		if (maxPositionSize > 0) {
			const oversize = session.positions.find(position => Math.abs(position.quantity) > maxPositionSize);
			if (oversize) {
				this.raiseRiskAlert(session, 'positionSize', `Position size exceeds ${maxPositionSize}.`, Math.abs(oversize.quantity), maxPositionSize);
			} else {
				session.activeRiskAlerts.delete('positionSize');
			}
		}

		const maxOpenOrders = this.getMaxOpenOrders();
		const openOrders = session.orders.filter(order => order.status === 'open' || order.status === 'partial').length;
		if (maxOpenOrders > 0 && openOrders > maxOpenOrders) {
			this.raiseRiskAlert(session, 'drawdown', 'Open order limit exceeded.', openOrders, maxOpenOrders);
		} else {
			session.activeRiskAlerts.delete('drawdown');
		}
	}

	private raiseRiskAlert(session: SessionRecord, type: RiskAlert['type'], message: string, value: number, limit: number): void {
		if (session.activeRiskAlerts.has(type)) {
			return;
		}

		session.activeRiskAlerts.add(type);
		const alert: RiskAlert = {
			id: `risk-${type}-${Date.now()}`,
			level: 'critical',
			type,
			message,
			value,
			limit,
			timestamp: Date.now()
		};
		this._onRiskAlert.fire({ sessionId: session.info.id, alert });
		this.addActivity(session.info.id, 'alert', message);
	}

	private startHeartbeat(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		this.stopHeartbeat(sessionId);
		session.heartbeatTimer = setInterval(() => {
			this.checkHeartbeat(sessionId);
		}, 5000);
	}

	private stopHeartbeat(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || !session.heartbeatTimer) {
			return;
		}

		clearInterval(session.heartbeatTimer);
		session.heartbeatTimer = undefined;
	}

	private checkHeartbeat(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		const delta = Date.now() - session.lastBrokerUpdate;
		let status: 'ok' | 'stale' | 'lost' = 'ok';
		if (delta > HEARTBEAT_STALE_MS) {
			status = 'lost';
		} else if (delta > HEARTBEAT_OK_MS) {
			status = 'stale';
		}

		// M51: a daemon session also self-reports health. Never display a
		// BETTER status than the daemon's own last report -- recent IPC
		// traffic must not conceal a degraded/unhealthy daemon.
		if (session.daemonHealth !== undefined && HEARTBEAT_SEVERITY[session.daemonHealth] > HEARTBEAT_SEVERITY[status]) {
			status = session.daemonHealth;
		}

		if (status !== session.heartbeatStatus) {
			session.heartbeatStatus = status;
			this._onHeartbeat.fire({ sessionId, status, lastSeen: session.lastBrokerUpdate });
		}
	}

	private nextSeq(session: SessionRecord): number {
		session.seq += 1;
		return session.seq;
	}

	private resolveAccount(type: SessionType, accountId?: string): BrokerAccount | undefined {
		if (accountId) {
			return this.accounts.find(account => account.id === accountId);
		}

		if (this.selectedAccountId) {
			const selected = this.accounts.find(account => account.id === this.selectedAccountId && account.type === type);
			if (selected) {
				return selected;
			}
		}

		return this.accounts.find(account => account.type === type);
	}

	private async acquireBroker(account: BrokerAccount): Promise<BrokerAdapter> {
		const existing = this.brokers.get(account.id);
		if (existing) {
			existing.refCount += 1;
			return existing.adapter;
		}

		let adapter: BrokerAdapter;
		if (account.broker === 'alpaca') {
			adapter = new AlpacaAdapter(account.id, account.type === 'paper');
		} else {
			adapter = new MockBrokerAdapter(account.id, account.name);
		}

		await adapter.connect();
		const connection: BrokerConnection = { adapter, refCount: 1, account: { ...account, connected: true, lastConnected: Date.now() } };
		this.brokers.set(account.id, connection);
		this.updateAccountStatus(account.id, true);
		return adapter;
	}

	private async releaseBroker(accountId: string): Promise<void> {
		const existing = this.brokers.get(accountId);
		if (!existing) {
			return;
		}

		existing.refCount = Math.max(0, existing.refCount - 1);
		if (existing.refCount > 0) {
			return;
		}

		await existing.adapter.disconnect();
		this.brokers.delete(accountId);
		this.updateAccountStatus(accountId, false);
	}

	private updateAccountStatus(accountId: string, connected: boolean): void {
		this.accounts = this.accounts.map(account => account.id === accountId
			? { ...account, connected, lastConnected: connected ? Date.now() : account.lastConnected }
			: account);
		this._onAccountsChanged.fire();
	}

	private defaultPerformance(): PerformanceMetrics {
		return {
			sessionPnL: 0,
			todayPnL: 0,
			openPnL: 0,
			realizedPnL: 0,
			totalTrades: 0,
			winRate: 0,
			avgWin: 0,
			avgLoss: 0
		};
	}

	private getDailyLossLimit(): number {
		const limit = vscode.workspace.getConfiguration('quantlab.trading').get<number>('dailyLossLimit');
		return typeof limit === 'number' ? limit : 0;
	}

	private getMaxPositionSize(): number {
		const limit = vscode.workspace.getConfiguration('quantlab.trading').get<number>('maxPositionSize');
		return typeof limit === 'number' ? limit : 0;
	}

	private getMaxExposure(): number {
		const limit = vscode.workspace.getConfiguration('quantlab.trading').get<number>('maxExposure');
		return typeof limit === 'number' ? limit : 0;
	}

	private getMaxDrawdownPercent(): number {
		const limit = vscode.workspace.getConfiguration('quantlab.trading').get<number>('maxDrawdownPercent');
		return typeof limit === 'number' ? limit : 0.05;
	}

	private getConsecutiveLossLimit(): number {
		const limit = vscode.workspace.getConfiguration('quantlab.trading').get<number>('consecutiveLossLimit');
		return typeof limit === 'number' ? limit : 3;
	}

	private getMaxOpenOrders(): number {
		const limit = vscode.workspace.getConfiguration('quantlab.trading').get<number>('maxOpenOrders');
		return typeof limit === 'number' ? limit : 0;
	}

	private async computeStrategyHash(doc: vscode.TextDocument): Promise<string> {
		const text = doc.getText();
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			hash = ((hash << 5) - hash) + text.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash).toString(16);
	}

	private generateSessionId(type: SessionType): string {
		const prefix = type === 'paper' ? 'paper' : 'live';
		return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	}

	/**
	 * Prompt user to enter broker API credentials (FIX-CGP-009).
	 *
	 * On first setup, also prompts for a master password.
	 * Credentials are stored in VS Code SecretStorage (OS keychain).
	 */
	private async promptBrokerCredentials(broker: string): Promise<boolean> {
		// Check if master key exists
		const hasMasterKey = await this.context.secrets.get('quantlab.masterKey');

		if (!hasMasterKey) {
			const masterKey = await vscode.window.showInputBox({
				prompt: 'Enter a master password to encrypt your broker credentials',
				password: true,
				placeHolder: 'Master password (min 8 characters)',
				validateInput: (value) => {
					if (!value || value.length < 8) {
						return 'Master password must be at least 8 characters';
					}
					return null;
				},
			});

			if (!masterKey) {
				return false;
			}

			const confirm = await vscode.window.showInputBox({
				prompt: 'Confirm master password',
				password: true,
			});

			if (masterKey !== confirm) {
				void vscode.window.showErrorMessage('Passwords do not match');
				return false;
			}

			await this.context.secrets.store('quantlab.masterKey', masterKey);
		}

		// Prompt for broker API credentials
		const apiKey = await vscode.window.showInputBox({
			prompt: `Enter ${broker} API key`,
			placeHolder: 'API Key',
		});
		if (!apiKey) {
			return false;
		}

		const apiSecret = await vscode.window.showInputBox({
			prompt: `Enter ${broker} API secret`,
			password: true,
			placeHolder: 'API Secret',
		});
		if (!apiSecret) {
			return false;
		}

		await this.context.secrets.store(`quantlab.broker.${broker}.apiKey`, apiKey);
		await this.context.secrets.store(`quantlab.broker.${broker}.apiSecret`, apiSecret);

		return true;
	}

	private reloadAccounts(): void {
		const config = vscode.workspace.getConfiguration('quantlab.trading');
		const rawAccounts = config.get<AccountConfig[]>('accounts') ?? [];
		this.accounts = rawAccounts.map(account => ({
			id: account.id,
			name: account.name,
			type: account.type,
			broker: account.broker,
			connected: Boolean(this.brokers.get(account.id)?.adapter.isConnected()),
			lastConnected: this.brokers.get(account.id)?.account.lastConnected
		}));
		this._onAccountsChanged.fire();
	}

	private storeSessionSummary(session: SessionInfo): void {
		const summary: TradeSessionSummary = {
			id: session.id,
			type: session.type,
			strategyPath: session.strategyPath,
			startedAt: session.startedAt,
			endedAt: session.endedAt
		};
		this.sessionSummaries = [summary, ...this.sessionSummaries].slice(0, 200);
		void this.context.workspaceState.update(SUMMARY_KEY, this.sessionSummaries);
		this.emitRequirementsForStrategy(session.strategyPath);
	}

	private restoreSessionSummaries(): void {
		const stored = this.context.workspaceState.get<TradeSessionSummary[]>(SUMMARY_KEY);
		if (stored) {
			this.sessionSummaries = stored;
		}
	}

	private restoreRiskReviewed(): void {
		const stored = this.context.workspaceState.get<Array<[string, boolean]>>(RISK_REVIEW_KEY);
		if (!stored) {
			return;
		}
		for (const [path, reviewed] of stored) {
			this.riskReviewed.set(path, reviewed);
		}
	}

	private emitRequirementsForStrategy(strategyPath: string): void {
		this.getRequirementsCheck(strategyPath).then(requirements => {
			this._onRequirementsChanged.fire({ strategyPath, requirements });
		}, err => {
			console.error(`SessionManager: requirements check failed for ${strategyPath}:`, err);
		});
	}

	private emitRequirementsForOpenStrategies(): void {
		const openStrategies = vscode.workspace.textDocuments
			.filter(doc => doc.languageId === 'python' && doc.uri.scheme === 'file')
			.map(doc => doc.uri.fsPath);

		for (const path of openStrategies) {
			this.emitRequirementsForStrategy(path);
		}
	}

	// ========================================
	// Daemon-based session management (IPC)
	// ========================================

	/**
	 * Start a daemon-based trading session.
	 *
	 * Uses the Python trading daemon for live trading with IPC communication.
	 */
	async startDaemonSession(
		strategyPath: string,
		type: SessionType,
		accountId?: string
	): Promise<SessionInfo | undefined> {
		const doc = await vscode.workspace.openTextDocument(strategyPath);
		const validation = this.validator.validateDocument(doc);
		if (!validation.isValid) {
			void vscode.window.showWarningMessage('Trade session requires a valid strategy entrypoint.');
			return undefined;
		}

		// FIX-CGP-010: Gate live trading with TrustManager verification
		if (type === 'live') {
			const trustManager = TrustManager.getInstance();
			const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
			const trustResult = await trustManager.verifyForLiveTradingWithPrompts(strategyPath, workspaceUri);
			if (!trustResult.isValid) {
				void vscode.window.showWarningMessage(
					`Live trading blocked: ${trustResult.reason ?? 'Trust verification failed'}. ` +
					'Workspace and strategy must be trusted for live trading.'
				);
				return undefined;
			}
		}

		// FIX-CGP-014 / H29: run the SAME pre-trade checklist gate as
		// startSession -- both start paths must run the identical safety
		// suite (same condition, same failure behavior).
		if (type === 'live' || type === 'paper') {
			const { PreTradeChecklist } = await import('../../ui/dialogs/PreTradeChecklist');
			const checklist = PreTradeChecklist.getInstance();
			const checkResult = await checklist.show({
				strategyPath,
				symbol: '',
				timeframe: '',
				type,
			});

			if (checkResult && !checkResult.approved) {
				const failedItems = checkResult.items
					?.filter((item: { status: string }) => item.status === 'fail')
					.map((item: { label: string }) => item.label)
					.join(', ');
				void vscode.window.showWarningMessage(`Pre-trade checklist failed: ${failedItems ?? 'unknown'}`);
				return undefined;
			}
		}

		const requirements = await this.getRequirementsCheck(strategyPath);
		const eligibility = await this.checkEligibility(requirements, type);
		if (!eligibility.ok) {
			void vscode.window.showWarningMessage(eligibility.reason ?? 'Trade session blocked.');
			return undefined;
		}

		const account = this.resolveAccount(type, accountId);
		if (!account) {
			void vscode.window.showWarningMessage('No broker account configured for this session.');
			return undefined;
		}

		// Check for existing session
		const existing = Array.from(this.sessions.values()).find(session =>
			session.info.strategyPath === strategyPath &&
			session.info.accountId === account.id &&
			session.info.type === type &&
			session.info.status !== 'stopped');

		if (existing) {
			return { ...existing.info };
		}

		// Prevent two concurrent startDaemonSession() calls for the same params
		const startKey = `daemon::${strategyPath}::${account.id}::${type}`;
		if (this.startingSessionKeys.has(startKey)) {
			return undefined;
		}
		this.startingSessionKeys.add(startKey);

		const now = Date.now();
		const hash = await this.computeStrategyHash(doc);
		const sessionId = this.generateSessionId(type);

		// Build daemon configuration (CODEX-004: pass broker and symbols)
		const symbolName = this.globalState.getDataSource()?.displayName ?? '';
		const daemonConfig: DaemonConfig = {
			sessionId,
			strategyPath,
			broker: account.broker ?? 'alpaca',
			symbols: symbolName ? [symbolName] : [],
			timeframe: this.globalState.getTimeframe() ?? '1D',
			paper: type === 'paper',
			riskLimits: {
				maxExposure: this.getMaxExposure() || undefined,
				maxPositionSize: this.getMaxPositionSize() || undefined,
				dailyLossLimit: this.getDailyLossLimit() || undefined,
				maxDrawdownPercent: this.getMaxDrawdownPercent() || undefined,
				consecutiveLossLimit: this.getConsecutiveLossLimit() || undefined,
			},
		};

		try {
			// Start the daemon process
			await this.daemonManager.startDaemon(daemonConfig);

			// Create and connect daemon client
			const client = createDaemonClient(sessionId);
			await client.connect();
			this.daemonClients.set(sessionId, client);

			// FIX-CGP-008: Sync broker credentials to daemon via IPC
			const secretsSync = new DaemonSecretsSync(this.context.secrets);
			const brokerName = daemonConfig.broker;
			let credSynced = await secretsSync.syncCredentials(client, brokerName);
			if (!credSynced.success) {
				// Prompt user to enter credentials
				const entered = await this.promptBrokerCredentials(brokerName);
				if (!entered) {
					client.disconnect();
					throw new Error('Broker credentials required for live trading');
				}
				credSynced = await secretsSync.syncCredentials(client, brokerName);
				if (!credSynced.success) {
					client.disconnect();
					throw new Error(`Failed to sync credentials: ${credSynced.error}`);
				}
			}

			// Start the session on daemon
			await client.startSession({
				sessionId,
				strategyPath,
				symbol: symbolName,
				timeframe: daemonConfig.timeframe,
				paper: daemonConfig.paper,
				riskLimits: daemonConfig.riskLimits ?? {},
			});

			// Create session info
			const info: SessionInfo = {
				id: sessionId,
				type,
				status: 'starting',
				strategyPath,
				strategyHash: hash,
				accountId: account.id,
				accountName: account.name,
				startedAt: now,
				lastHeartbeat: now,
				symbol: this.globalState.getDataSource()?.displayName ?? '',
				timeframe: this.globalState.getTimeframe() ?? '1D'
			};

			// Also get broker adapter for direct market data if needed
			const broker = await this.acquireBroker(account);

			const record: SessionRecord = {
				info,
				broker,
				positions: [],
				orders: [],
				performance: this.defaultPerformance(),
				activity: [],
				lastBrokerUpdate: now,
				heartbeatStatus: 'ok',
				seq: 0,
				activeRiskAlerts: new Set(),
				fillReconciler: new FillReconciler(),
				roundTrips: new RoundTripBook(),
				daemonClient: client,
				useDaemon: true,
			};

			this.sessions.set(sessionId, record);
			this.startingSessionKeys.delete(startKey); // session is tracked; release lock

			// Wire daemon events to session manager events
			this.setupDaemonEventHandlers(sessionId, client);

			// Get initial state from daemon
			try {
				const positions = await client.getPositions();
				const orders = await client.getOrders();
				this.handleDaemonPositionsUpdate(sessionId, positions);
				this.handleDaemonOrdersUpdate(sessionId, orders);
			} catch (error) {
				this.handleError(sessionId, 'daemon_state', (error as Error).message, true);
			}

			record.info.status = 'running';
			this.addActivity(sessionId, 'system', `${type === 'paper' ? 'Paper' : 'Live'} daemon session started`);
			// M51: run the interval heartbeat probe for daemon sessions too,
			// so a SILENT daemon (no heartbeat events at all) degrades to
			// 'stale' and then 'lost' instead of staying 'ok' forever.
			this.startHeartbeat(sessionId);

			this._onSessionStarted.fire({ ...record.info });
			this._onSessionsChanged.fire();
			return { ...record.info };

		} catch (error) {
			// Cleanup on failure
			this.startingSessionKeys.delete(startKey);
			this.daemonClients.delete(sessionId);
			await this.daemonManager.stopDaemon(sessionId).catch(() => { });
			await this.releaseBroker(account.id).catch(() => { }); // release broker if acquireBroker() succeeded before the throw
			void vscode.window.showErrorMessage(`Failed to start daemon session: ${(error as Error).message}`);
			return undefined;
		}
	}

	/**
	 * Stop a daemon-based session.
	 */
	async stopDaemonSession(sessionId: string, reason?: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session || !session.useDaemon) {
			// Fall back to regular stop
			return this.stopSession(sessionId, reason);
		}
		// Reentrancy gate -- see stopSession. Note stopSession delegates HERE
		// for daemon sessions BEFORE setting 'stopping', so this single gate
		// covers both entry points without blocking the delegation.
		if (session.info.status === 'stopping') {
			this.outputChannel.appendLine(`[${sessionId}] stopDaemonSession re-entered while already stopping (reason=${reason ?? 'none'}) -- ignored.`);
			return;
		}

		session.info.status = 'stopping';

		// Stop daemon client
		const client = this.daemonClients.get(sessionId);
		if (client) {
			try {
				await client.stopSession();
			} catch (error) {
				// Surface the failure, then CONTINUE the teardown: the daemon
				// process kill below must still happen even when the IPC stop
				// failed -- this is the kill-switch path; never leave the
				// daemon alive, and never fail silently.
				this.outputChannel.appendLine(`[${sessionId}] Daemon stopSession IPC failed during teardown: ${(error as Error).message}`);
			}
			// Remove daemon event handlers BEFORE disconnecting: disconnect()
			// emits a 'disconnect' event, which would otherwise surface a
			// spurious 'Daemon connection lost' error on an intentional stop.
			client.removeAllListeners();
			client.disconnect();
			this.daemonClients.delete(sessionId);
		}

		try {
			// Stop daemon process
			await this.daemonManager.stopDaemon(sessionId);

			// Release broker
			await this.releaseBroker(session.info.accountId);
		} catch (error) {
			// Must not strand the session in 'stopping' (the reentrancy gate
			// would then ignore every retry). The daemon may still be alive
			// here -- surface that loudly; this is the kill-switch path.
			session.info.status = 'error';
			this.outputChannel.appendLine(`[${sessionId}] Daemon teardown failed: ${(error as Error).message}`);
			throw error;
		}

		session.info.status = 'stopped';
		session.info.endedAt = Date.now();

		// Clear polling timers before removing the session
		if (session.positionsTimer) { clearTimeout(session.positionsTimer); session.positionsTimer = undefined; }
		if (session.ordersTimer) { clearTimeout(session.ordersTimer); session.ordersTimer = undefined; }
		if (session.heartbeatTimer) { clearInterval(session.heartbeatTimer); session.heartbeatTimer = undefined; }

		this.addActivity(sessionId, 'system', 'Daemon session stopped');
		this.storeSessionSummary(session.info);

		this.sessions.delete(sessionId);
		this._onSessionStopped.fire({ sessionId, reason });
		this._onSessionsChanged.fire();
	}

	/**
	 * Submit an order through the daemon.
	 */
	async submitOrder(sessionId: string, order: OrderRequest): Promise<string | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error('Session not found');
		}

		if (session.info.status !== 'running') {
			throw new Error(`Cannot submit order: session is ${session.info.status}`);
		}

		if (session.useDaemon && session.daemonClient) {
			const orderId = await session.daemonClient.submitOrder(order);
			this.addActivity(sessionId, 'order', `Order submitted: ${order.side.toUpperCase()} ${order.quantity} ${order.symbol}`);
			return orderId;
		}

		// Fallback to broker adapter
		const brokerOrder = await session.broker.placeOrder({
			symbol: order.symbol,
			side: order.side,
			type: order.orderType,
			quantity: order.quantity,
			price: order.limitPrice,
			stopPrice: order.stopPrice,
			timeInForce: order.timeInForce ?? 'day',
		});

		this.addActivity(sessionId, 'order', `Order submitted: ${order.side.toUpperCase()} ${order.quantity} ${order.symbol}`);
		return brokerOrder.id;
	}

	/**
	 * Cancel an order through the daemon.
	 */
	async cancelOrder(sessionId: string, orderId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error('Session not found');
		}

		if (session.useDaemon && session.daemonClient) {
			await session.daemonClient.cancelOrder(orderId);
			this.addActivity(sessionId, 'order', `Order cancelled: ${orderId}`);
			return;
		}

		// Fallback to broker adapter
		await session.broker.cancelOrder(orderId);
		this.addActivity(sessionId, 'order', `Order cancelled: ${orderId}`);
	}

	/**
	 * Emergency flatten all positions using two-stage protocol.
	 *
	 * Spec Reference: Technical Spec section 2.6 - Emergency Flatten Protocol
	 *
	 * Stage 1: Marketable Limit IOC
	 *   - For sells: limit price = bid - slippage allowance
	 *   - For buys (covering shorts): limit price = ask + slippage allowance
	 *   - Uses IOC to ensure immediate execution or cancel
	 *
	 * Stage 2: Market fallback
	 *   - If Stage 1 doesn't fully execute within timeout, submit market orders
	 *   - For remaining unfilled quantity
	 *
	 * @param sessionId - Session to flatten
	 * @param slippageBps - Slippage allowance in basis points (default 50 = 0.5%)
	 * @param stage1TimeoutMs - Time to wait for Stage 1 fills before Stage 2 (default 2000ms)
	 */
	async flattenAllPositions(
		sessionId: string,
		slippageBps: number = 50,
		stage1TimeoutMs: number = 2000
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error('Session not found');
		}

		if (session.useDaemon && session.daemonClient) {
			await session.daemonClient.flattenPositions();
			this.addActivity(sessionId, 'alert', 'FLATTEN ALL - All positions closed via daemon');
			return;
		}

		const positionsToFlatten = session.positions.filter(p => p.quantity !== 0);
		if (positionsToFlatten.length === 0) {
			this.addActivity(sessionId, 'alert', 'FLATTEN ALL - No positions to close');
			return;
		}

		this.addActivity(sessionId, 'alert', `FLATTEN ALL - Stage 1: Submitting marketable limit IOC orders for ${positionsToFlatten.length} positions`);

		// Track Stage 1 orders
		const stage1Orders: Array<{ symbol: string; orderId: string; targetQty: number; side: OrderSide }> = [];
		const slippageFactor = slippageBps / 10000;  // Convert bps to decimal

		// Stage 1: Submit marketable limit IOC orders
		for (const position of positionsToFlatten) {
			const side: OrderSide = position.quantity > 0 ? 'sell' : 'buy';
			const quantity = Math.abs(position.quantity);

			// Calculate marketable limit price with slippage allowance
			// For sells: slightly below current (to ensure fill)
			// For buys (covering shorts): slightly above current
			let limitPrice: number;
			if (side === 'sell') {
				limitPrice = position.currentPrice * (1 - slippageFactor);
			} else {
				limitPrice = position.currentPrice * (1 + slippageFactor);
			}

			try {
				const order = await session.broker.placeOrder({
					symbol: position.symbol,
					side,
					type: 'limit',
					quantity,
					price: limitPrice,
					timeInForce: 'ioc',  // Immediate-or-cancel
				});

				stage1Orders.push({
					symbol: position.symbol,
					orderId: order.id,
					targetQty: quantity,
					side,
				});
			} catch (error) {
				this.handleError(sessionId, 'flatten_stage1', `Failed to submit Stage 1 order for ${position.symbol}: ${(error as Error).message}`, true);
			}
		}

		// Wait for Stage 1 to complete or timeout
		await new Promise(resolve => setTimeout(resolve, stage1TimeoutMs));

		// Check for unfilled quantities and submit Stage 2 market orders
		const currentOrders = await session.broker.getOpenOrders();
		const currentPositions = await session.broker.getPositions();

		// Cancel any remaining Stage 1 IOC orders that haven't completed
		for (const stage1Order of stage1Orders) {
			const orderStatus = currentOrders.find(o => o.id === stage1Order.orderId);
			if (orderStatus && (orderStatus.status === 'open' || orderStatus.status === 'partial')) {
				try {
					await session.broker.cancelOrder(stage1Order.orderId);
				} catch {
					// Ignore cancel errors - order may have already filled
				}
			}
		}

		// Stage 2: Submit market orders for remaining unfilled positions
		const remainingPositions = currentPositions.filter(p => p.quantity !== 0);

		if (remainingPositions.length > 0) {
			this.addActivity(sessionId, 'alert', `FLATTEN ALL - Stage 2: Submitting market orders for ${remainingPositions.length} remaining positions`);

			for (const position of remainingPositions) {
				const side: OrderSide = position.quantity > 0 ? 'sell' : 'buy';
				const quantity = Math.abs(position.quantity);

				try {
					await session.broker.placeOrder({
						symbol: position.symbol,
						side,
						type: 'market',
						quantity,
						timeInForce: 'day',
					});
				} catch (error) {
					this.handleError(sessionId, 'flatten_stage2', `Failed to submit Stage 2 market order for ${position.symbol}: ${(error as Error).message}`, true);
				}
			}
		}

		this.addActivity(sessionId, 'alert', 'FLATTEN ALL - Emergency flatten protocol completed');
	}

	/**
	 * Get daemon client for a session.
	 */
	getDaemonClient(sessionId: string): DaemonClient | undefined {
		return this.daemonClients.get(sessionId);
	}

	/**
	 * Check if session is using daemon.
	 */
	isUsingDaemon(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return session?.useDaemon ?? false;
	}

	/**
	 * Setup daemon event handlers.
	 */
	private setupDaemonEventHandlers(sessionId: string, client: DaemonClient): void {
		client.on('positions.update', (positions) => {
			this.handleDaemonPositionsUpdate(sessionId, positions);
		});

		client.on('orders.update', (orders) => {
			this.handleDaemonOrdersUpdate(sessionId, orders);
		});

		client.on('fills.update', (fills) => {
			for (const fill of fills) {
				this.handleDaemonFill(sessionId, fill);
			}
		});

		client.on('heartbeat', (health) => {
			const session = this.sessions.get(sessionId);
			if (session) {
				session.lastBrokerUpdate = Date.now();
				// M51: map the full daemon health range -- 'unhealthy' (or any
				// unknown future status) must surface as 'lost', not 'stale'.
				session.daemonHealth = health.status === 'healthy' ? 'ok'
					: health.status === 'degraded' ? 'stale'
						: 'lost';
				session.heartbeatStatus = session.daemonHealth;
				this._onHeartbeat.fire({
					sessionId,
					status: session.heartbeatStatus,
					lastSeen: session.lastBrokerUpdate
				});
			}
		});

		client.on('risk.alert', (alert) => {
			this.handleDaemonRiskAlert(sessionId, alert);
		});

		client.on('error', (error) => {
			this.handleError(sessionId, 'daemon_error', error.message, true);
		});

		client.on('disconnect', () => {
			this.handleError(sessionId, 'daemon_disconnect', 'Daemon connection lost', true);
		});
	}

	/**
	 * Handle positions update from daemon.
	 */
	private handleDaemonPositionsUpdate(sessionId: string, daemonPositions: DaemonPosition[]): void {
		// Convert daemon positions to session positions
		const positions: Position[] = daemonPositions.map(dp => {
			const currentPrice = dp.currentPrice ?? dp.avgEntryPrice;
			return {
				symbol: dp.symbol,
				quantity: dp.quantity,
				avgPrice: dp.avgEntryPrice,
				currentPrice,
				unrealizedPnL: dp.unrealizedPnl,
				realizedPnL: dp.realizedPnl,
				marketValue: dp.quantity * currentPrice,
			};
		});

		this.handlePositionsUpdate(sessionId, positions);
	}

	/**
	 * Handle orders update from daemon.
	 */
	private handleDaemonOrdersUpdate(sessionId: string, daemonOrders: DaemonOrder[]): void {
		// Convert daemon orders to session orders
		const now = Date.now();
		const orders: Order[] = daemonOrders.map(do_ => ({
			id: do_.orderId,
			symbol: do_.symbol,
			side: do_.side,
			type: do_.orderType,
			quantity: do_.quantity,
			price: do_.limitPrice,
			stopPrice: do_.stopPrice,
			status: do_.status === 'filled' ? 'filled' :
				do_.status === 'partial' ? 'partial' :
					do_.status === 'cancelled' ? 'cancelled' :
						do_.status === 'rejected' ? 'rejected' : 'open',
			filledQuantity: do_.filledQuantity,
			createdAt: now,
			updatedAt: now,
		}));

		this.handleOrdersUpdate(sessionId, orders);
	}

	/**
	 * Handle fill from daemon.
	 */
	private handleDaemonFill(sessionId: string, daemonFill: DaemonFill): void {
		// Wire-shape gate: RoundTripAccounting throws on malformed fills
		// (No-Fallbacks), and this is called synchronously from the IPC
		// 'fills.update' listener -- an uncaught throw there would abort the
		// REST of the fill batch and escape into the transport. Validate at
		// the boundary, surface violations loudly, keep the batch going.
		const violations: string[] = [];
		if (daemonFill.side !== 'buy' && daemonFill.side !== 'sell') {
			violations.push(`side=${String(daemonFill.side)}`);
		}
		if (typeof daemonFill.quantity !== 'number' || !Number.isFinite(daemonFill.quantity) || daemonFill.quantity <= 0) {
			violations.push(`quantity=${String(daemonFill.quantity)}`);
		}
		if (typeof daemonFill.price !== 'number' || !Number.isFinite(daemonFill.price)) {
			violations.push(`price=${String(daemonFill.price)}`);
		}
		if (daemonFill.commission !== undefined && (typeof daemonFill.commission !== 'number' || !Number.isFinite(daemonFill.commission))) {
			violations.push(`commission=${String(daemonFill.commission)}`);
		}
		if (violations.length) {
			this.handleError(sessionId, 'daemon_fill_invalid', `Daemon sent a malformed fill (${daemonFill.fillId ?? 'no id'}: ${violations.join(', ')}) -- fill skipped, performance metrics may undercount.`, false);
			return;
		}

		const fill: Fill = {
			id: daemonFill.fillId,
			orderId: daemonFill.orderId,
			symbol: daemonFill.symbol,
			side: daemonFill.side,
			quantity: daemonFill.quantity,
			price: daemonFill.price,
			// An absent wire commission means the venue reported none -- zero
			// commission is the semantic reading, not a masked error (present
			// but non-finite values are rejected loudly above).
			commission: daemonFill.commission ?? 0,
			timestamp: new Date(daemonFill.timestamp).getTime(),
		};

		this.handleFill(sessionId, fill);
	}

	/**
	 * Handle risk alert from daemon.
	 */
	private handleDaemonRiskAlert(sessionId: string, daemonAlert: DaemonRiskAlert): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		const alertType = daemonAlert.type === 'exposure_limit' ? 'dailyLoss' :
			daemonAlert.type === 'position_limit' ? 'positionSize' : 'drawdown';

		const alert: RiskAlert = {
			id: `risk-${alertType}-${Date.now()}`,
			level: daemonAlert.severity === 'critical' ? 'critical' : 'warning',
			type: alertType,
			message: daemonAlert.message,
			value: daemonAlert.currentValue,
			limit: daemonAlert.limit,
			timestamp: Date.now()
		};

		this._onRiskAlert.fire({ sessionId, alert });
		this.addActivity(sessionId, 'alert', daemonAlert.message);
	}
}
