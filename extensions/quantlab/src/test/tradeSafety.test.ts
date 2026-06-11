/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import { EventEmitter as NodeEventEmitter } from 'events';
import * as vscode from 'vscode';
import { GlobalState } from '../core/state/GlobalState';
import { HistoryState } from '../core/state/HistoryState';
import { RoundTripBook } from '../core/trading/RoundTripAccounting';
import { SessionManager } from '../core/trading/SessionManager';
import { Fill, PerformanceMetrics } from '../types/trading';

// The shim lacks workspace.onDidChangeConfiguration (SessionManager's
// constructor subscribes to it). Patch it in before any manager is built.
const workspaceMutable = vscode.workspace as unknown as {
	onDidChangeConfiguration?: (listener: (e: unknown) => void) => vscode.Disposable;
};
if (typeof workspaceMutable.onDidChangeConfiguration !== 'function') {
	workspaceMutable.onDidChangeConfiguration = (_listener: (e: unknown) => void) =>
		new vscode.Disposable(() => { /* no-op */ });
}

// storeSessionSummary -> emitRequirementsForStrategy -> getRequirementsCheck
// re-opens the strategy document. Provide a minimal python TextDocument so
// the requirements chain completes instead of logging a rejection per stop.
const workspaceWithDocs = vscode.workspace as unknown as {
	openTextDocument?: (path: string) => Promise<unknown>;
	textDocuments?: unknown[];
};
if (typeof workspaceWithDocs.openTextDocument !== 'function') {
	workspaceWithDocs.openTextDocument = async (path: string) => ({
		uri: vscode.Uri.file(path),
		fileName: path,
		languageId: 'python',
		version: 1,
		getText: () => ''
	});
}
if (!Array.isArray(workspaceWithDocs.textDocuments)) {
	workspaceWithDocs.textDocuments = [];
}

class MockMemento implements vscode.Memento {
	private readonly store = new Map<string, unknown>();

	get<T>(key: string, defaultValue?: T): T {
		if (!this.store.has(key)) {
			return defaultValue as T;
		}
		return this.store.get(key) as T;
	}

	update(key: string, value: unknown): Thenable<void> {
		this.store.set(key, value);
		return Promise.resolve();
	}

	keys(): readonly string[] {
		return Array.from(this.store.keys());
	}
}

function makeContext(): vscode.ExtensionContext {
	return {
		workspaceState: new MockMemento(),
		globalState: new MockMemento(),
		subscriptions: []
	} as unknown as vscode.ExtensionContext;
}

// ---------------------------------------------------------------------------
// Private-member access seams (test-only). SessionRecord is not exported;
// the tested stop/restart/fill paths are exercised through these casts.
// ---------------------------------------------------------------------------

interface SessionManagerInternals {
	sessions: Map<string, Record<string, unknown>>;
	daemonClients: Map<string, unknown>;
	daemonManager: unknown;
	handleFill(sessionId: string, fill: Fill): void;
	checkHeartbeat(sessionId: string): void;
	setupDaemonEventHandlers(sessionId: string, client: unknown): void;
}

interface StartOverrides {
	startDaemonSession(strategyPath: string, type: string, accountId?: string): Promise<undefined>;
	startSession(strategyPath: string, type: string, accountId?: string): Promise<undefined>;
}

function defaultPerformance(): PerformanceMetrics {
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

const passthroughReconciler = {
	processFill: () => ({ processed: true, isDuplicate: false, isOutOfOrder: false, buffered: false }),
	processBufferedFills: (): Fill[] => []
};

interface FakeDaemonSeams {
	stopDaemonCalls: string[];
	clientCalls: string[];
	brokerCalls: string[];
	record: Record<string, unknown>;
}

/**
 * Inject a synthetic session record directly into the manager (the real
 * start paths need vscode.workspace.openTextDocument, which the shim does
 * not provide). The fakes record every teardown interaction so tests can
 * assert WHICH stop path ran.
 */
function injectSession(manager: SessionManager, sessionId: string, useDaemon: boolean, options?: {
	failDaemonIpcStop?: boolean;
}): FakeDaemonSeams {
	const internals = manager as unknown as SessionManagerInternals;

	const stopDaemonCalls: string[] = [];
	internals.daemonManager = {
		stopDaemon: async (id: string) => { stopDaemonCalls.push(id); }
	};

	const clientCalls: string[] = [];
	const fakeClient = {
		stopSession: async () => {
			clientCalls.push('stopSession');
			if (options?.failDaemonIpcStop) {
				throw new Error('synthetic IPC stop failure');
			}
		},
		disconnect: (_intentional?: boolean) => { clientCalls.push('disconnect'); },
		removeAllListeners: () => { clientCalls.push('removeAllListeners'); }
	};

	const brokerCalls: string[] = [];
	const fakeBroker = {
		unsubscribeFromUpdates: () => { brokerCalls.push('unsubscribeFromUpdates'); },
		disconnect: async () => { brokerCalls.push('disconnect'); }
	};

	const record: Record<string, unknown> = {
		info: {
			id: sessionId,
			type: 'live',
			status: 'running',
			strategyPath: '/tmp/strategy.py',
			strategyHash: 'hash',
			accountId: 'acct-1',
			accountName: 'Test Account',
			startedAt: Date.now(),
			lastHeartbeat: Date.now(),
			symbol: 'AAPL',
			timeframe: '1D'
		},
		broker: fakeBroker,
		positions: [],
		orders: [],
		performance: defaultPerformance(),
		activity: [],
		lastBrokerUpdate: Date.now(),
		heartbeatStatus: 'ok',
		seq: 0,
		activeRiskAlerts: new Set<string>(),
		fillReconciler: passthroughReconciler,
		roundTrips: new RoundTripBook(),
		useDaemon
	};

	if (useDaemon) {
		record.daemonClient = fakeClient;
		internals.daemonClients.set(sessionId, fakeClient);
	}

	internals.sessions.set(sessionId, record);
	return { stopDaemonCalls, clientCalls, brokerCalls, record };
}

function makeFill(overrides: Partial<Fill>): Fill {
	return {
		id: `fill-${Math.random().toString(36).slice(2, 8)}`,
		orderId: 'order-1',
		symbol: 'AAPL',
		side: 'buy',
		quantity: 100,
		price: 10,
		timestamp: Date.now(),
		commission: 0,
		...overrides
	};
}

suite('Trade safety (megaudit W5): round-trip accounting', () => {
	test('winning round trip: buy 100 @ 10, sell 100 @ 12 -> 1 trade, +200, 100% win rate', () => {
		const book = new RoundTripBook();
		book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 100, price: 10, commission: 0 });
		const stats = book.applyFill({ symbol: 'AAPL', side: 'sell', quantity: 100, price: 12, commission: 0 });

		assert.strictEqual(stats.totalTrades, 1);
		assert.strictEqual(stats.realizedPnL, 200);
		assert.strictEqual(stats.winRate, 100);
		assert.strictEqual(stats.avgWin, 200);
		assert.strictEqual(stats.avgLoss, 0);
		assert.strictEqual(book.openQuantity('AAPL'), 0);
	});

	test('losing round trip updates avgLoss and winRate', () => {
		const book = new RoundTripBook();
		book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 100, price: 10, commission: 0 });
		book.applyFill({ symbol: 'AAPL', side: 'sell', quantity: 100, price: 12, commission: 0 });
		book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 50, price: 20, commission: 0 });
		const stats = book.applyFill({ symbol: 'AAPL', side: 'sell', quantity: 50, price: 18, commission: 0 });

		assert.strictEqual(stats.totalTrades, 2);
		assert.strictEqual(stats.realizedPnL, 100); // +200 - 100
		assert.strictEqual(stats.winRate, 50);
		assert.strictEqual(stats.avgWin, 200);
		assert.strictEqual(stats.avgLoss, -100);
	});

	test('partial exits (buy 100, sell 60, sell 40) close exactly ONE round trip', () => {
		const book = new RoundTripBook();
		book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 100, price: 10, commission: 0 });

		const afterPartial = book.applyFill({ symbol: 'AAPL', side: 'sell', quantity: 60, price: 12, commission: 0 });
		// Partial exit realizes P&L immediately but the round trip is still open.
		assert.strictEqual(afterPartial.totalTrades, 0);
		assert.strictEqual(afterPartial.realizedPnL, 120);
		assert.strictEqual(book.openQuantity('AAPL'), 40);

		const afterFlat = book.applyFill({ symbol: 'AAPL', side: 'sell', quantity: 40, price: 9, commission: 0 });
		assert.strictEqual(afterFlat.totalTrades, 1);
		assert.strictEqual(afterFlat.realizedPnL, 80); // 120 - 40
		assert.strictEqual(afterFlat.winRate, 100); // cycle P&L +80 -> win
		assert.strictEqual(book.openQuantity('AAPL'), 0);
	});

	test('fractional quantities (crypto) close round trips despite float residue', () => {
		const book = new RoundTripBook();
		// 0.1 + 0.2 - 0.3 leaves ~3e-17 of float residue in the second lot;
		// without epsilon snapping the cycle never closes and totalTrades
		// freezes at 0 while realizedPnL keeps moving.
		book.applyFill({ symbol: 'BTC', side: 'buy', quantity: 0.1, price: 80000, commission: 0 });
		book.applyFill({ symbol: 'BTC', side: 'buy', quantity: 0.2, price: 80000, commission: 0 });
		const stats = book.applyFill({ symbol: 'BTC', side: 'sell', quantity: 0.3, price: 81000, commission: 0 });

		assert.strictEqual(stats.totalTrades, 1, 'round trip must close despite float residue');
		assert.strictEqual(book.openQuantity('BTC'), 0, 'position must read flat');
		assert.ok(Math.abs(stats.realizedPnL - 300) < 1e-6, `realizedPnL ~ +300, got ${stats.realizedPnL}`);
		assert.strictEqual(stats.winRate, 100);
	});

	test('position flip closes the long cycle and opens a short cycle', () => {
		const book = new RoundTripBook();
		book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 100, price: 10, commission: 0 });
		const afterFlip = book.applyFill({ symbol: 'AAPL', side: 'sell', quantity: 150, price: 12, commission: 0 });

		assert.strictEqual(afterFlip.totalTrades, 1);
		assert.strictEqual(afterFlip.realizedPnL, 200);
		assert.strictEqual(book.openQuantity('AAPL'), -50);

		const afterCover = book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 50, price: 11, commission: 0 });
		assert.strictEqual(afterCover.totalTrades, 2);
		assert.strictEqual(afterCover.realizedPnL, 250); // 200 + 50 short profit
		assert.strictEqual(book.openQuantity('AAPL'), 0);
	});

	test('commissions reduce realized P&L and the cycle classification', () => {
		const book = new RoundTripBook();
		book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 100, price: 10, commission: 1 });
		const stats = book.applyFill({ symbol: 'AAPL', side: 'sell', quantity: 100, price: 12, commission: 1 });

		assert.strictEqual(stats.realizedPnL, 198);
		assert.strictEqual(stats.totalTrades, 1);
		assert.strictEqual(stats.avgWin, 198);
	});

	test('symbols are tracked independently', () => {
		const book = new RoundTripBook();
		book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 10, price: 100, commission: 0 });
		book.applyFill({ symbol: 'MSFT', side: 'buy', quantity: 5, price: 50, commission: 0 });
		const stats = book.applyFill({ symbol: 'MSFT', side: 'sell', quantity: 5, price: 60, commission: 0 });

		assert.strictEqual(stats.totalTrades, 1); // only MSFT closed
		assert.strictEqual(stats.realizedPnL, 50);
		assert.strictEqual(book.openQuantity('AAPL'), 10);
	});

	test('malformed fills fail loudly instead of corrupting the metrics', () => {
		const book = new RoundTripBook();
		assert.throws(() => book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 0, price: 10, commission: 0 }));
		assert.throws(() => book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 10, price: Number.NaN, commission: 0 }));
		assert.throws(() => book.applyFill({ symbol: 'AAPL', side: 'buy', quantity: 10, price: 10, commission: Number.NaN }));
	});
});

suite('Trade safety (megaudit W5): SessionManager stop/restart paths', () => {
	let manager: SessionManager;

	setup(() => {
		SessionManager.resetInstance();
		HistoryState.resetInstance();
		const context = makeContext();
		const globalState = GlobalState.initialize(context);
		const historyState = HistoryState.initialize(context);
		manager = SessionManager.initialize(context, globalState, historyState);
	});

	suiteTeardown(() => {
		SessionManager.resetInstance();
		HistoryState.resetInstance();
		GlobalState.resetInstance();
	});

	test('H27: kill-switch stop on a daemon session tears down the daemon, not just the adapter', async () => {
		const seams = injectSession(manager, 'live-daemon-1', true);
		let stoppedReason: string | undefined;
		manager.onSessionStopped(event => { stoppedReason = event.reason; });

		await manager.stopSession('live-daemon-1', 'killSwitch');

		// The daemon process AND the IPC client were torn down...
		assert.deepStrictEqual(seams.stopDaemonCalls, ['live-daemon-1']);
		assert.deepStrictEqual(seams.clientCalls, ['stopSession', 'removeAllListeners', 'disconnect']);
		// ...the session is gone, and the stop reason is preserved.
		assert.strictEqual(manager.getSession('live-daemon-1'), undefined);
		assert.strictEqual(stoppedReason, 'killSwitch');
		const internals = manager as unknown as SessionManagerInternals;
		assert.strictEqual(internals.daemonClients.has('live-daemon-1'), false);
	});

	test('H27 control: a non-daemon session stops on the adapter path and never touches the daemon manager', async () => {
		const seams = injectSession(manager, 'paper-plain-1', false);

		await manager.stopSession('paper-plain-1', 'userStop');

		assert.deepStrictEqual(seams.stopDaemonCalls, []);
		assert.deepStrictEqual(seams.clientCalls, []);
		assert.deepStrictEqual(seams.brokerCalls, ['unsubscribeFromUpdates']);
		assert.strictEqual(manager.getSession('paper-plain-1'), undefined);
	});

	test('H27 hardening: a failed daemon IPC stop still kills the daemon process', async () => {
		const seams = injectSession(manager, 'live-daemon-2', true, { failDaemonIpcStop: true });

		await manager.stopSession('live-daemon-2', 'killSwitch');

		assert.deepStrictEqual(seams.stopDaemonCalls, ['live-daemon-2']);
		assert.deepStrictEqual(seams.clientCalls, ['stopSession', 'removeAllListeners', 'disconnect']);
		assert.strictEqual(manager.getSession('live-daemon-2'), undefined);
	});

	test('H28: restartSession on a daemon session re-enters the daemon start path', async () => {
		const seams = injectSession(manager, 'live-daemon-3', true);

		const started: Array<{ path: string; strategyPath: string; type: string; accountId?: string }> = [];
		const overrides = manager as unknown as StartOverrides;
		overrides.startDaemonSession = async (strategyPath, type, accountId) => {
			started.push({ path: 'daemon', strategyPath, type, accountId });
			return undefined;
		};
		overrides.startSession = async (strategyPath, type, accountId) => {
			started.push({ path: 'plain', strategyPath, type, accountId });
			return undefined;
		};

		await manager.restartSession('live-daemon-3');

		// Stop ran the daemon teardown, and the restart went to the daemon path
		// with the original session parameters.
		assert.deepStrictEqual(seams.stopDaemonCalls, ['live-daemon-3']);
		assert.deepStrictEqual(started, [
			{ path: 'daemon', strategyPath: '/tmp/strategy.py', type: 'live', accountId: 'acct-1' }
		]);
	});

	test('H28 control: restartSession on a non-daemon session re-enters the plain start path', async () => {
		const seams = injectSession(manager, 'paper-plain-2', false);

		const started: string[] = [];
		const overrides = manager as unknown as StartOverrides;
		overrides.startDaemonSession = async () => { started.push('daemon'); return undefined; };
		overrides.startSession = async () => { started.push('plain'); return undefined; };

		await manager.restartSession('paper-plain-2');

		assert.deepStrictEqual(seams.stopDaemonCalls, []);
		assert.deepStrictEqual(started, ['plain']);
	});

	test('H31: fills drive the Performance card through handleFill', () => {
		injectSession(manager, 'paper-fills-1', false);
		const internals = manager as unknown as SessionManagerInternals;
		const record = internals.sessions.get('paper-fills-1') as { performance: PerformanceMetrics };

		internals.handleFill('paper-fills-1', makeFill({ side: 'buy', quantity: 100, price: 10 }));
		internals.handleFill('paper-fills-1', makeFill({ side: 'sell', quantity: 100, price: 12 }));

		assert.strictEqual(record.performance.totalTrades, 1);
		assert.strictEqual(record.performance.realizedPnL, 200);
		assert.strictEqual(record.performance.winRate, 100);
		assert.strictEqual(record.performance.avgWin, 200);
		// updatePerformance must keep folding realized P&L into session/today P&L.
		assert.strictEqual(record.performance.sessionPnL, 200);
		assert.strictEqual(record.performance.todayPnL, 200);
		assert.strictEqual(record.performance.openPnL, 0);
	});

	test('M51: daemon health maps degraded -> stale and unhealthy -> lost', () => {
		injectSession(manager, 'live-daemon-4', true);
		const internals = manager as unknown as SessionManagerInternals;
		const record = internals.sessions.get('live-daemon-4') as { heartbeatStatus: string; daemonHealth?: string };

		const fakeClient = new NodeEventEmitter();
		internals.setupDaemonEventHandlers('live-daemon-4', fakeClient);

		fakeClient.emit('heartbeat', { status: 'degraded' });
		assert.strictEqual(record.heartbeatStatus, 'stale');

		fakeClient.emit('heartbeat', { status: 'unhealthy' });
		assert.strictEqual(record.heartbeatStatus, 'lost');

		fakeClient.emit('heartbeat', { status: 'healthy' });
		assert.strictEqual(record.heartbeatStatus, 'ok');
	});

	test('M51: checkHeartbeat never shows a better status than the daemon self-report', () => {
		injectSession(manager, 'live-daemon-5', true);
		const internals = manager as unknown as SessionManagerInternals;
		const record = internals.sessions.get('live-daemon-5') as {
			heartbeatStatus: string;
			daemonHealth?: string;
			lastBrokerUpdate: number;
		};

		// Fresh IPC traffic, but the daemon last reported itself unhealthy.
		record.lastBrokerUpdate = Date.now();
		record.daemonHealth = 'lost';
		internals.checkHeartbeat('live-daemon-5');
		assert.strictEqual(record.heartbeatStatus, 'lost');

		// Silence escalates by time even when the last self-report was healthy.
		record.daemonHealth = 'ok';
		record.lastBrokerUpdate = Date.now() - 30000;
		internals.checkHeartbeat('live-daemon-5');
		assert.strictEqual(record.heartbeatStatus, 'lost');
	});
});
