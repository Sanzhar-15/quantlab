/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import http = require('http');
import https = require('https');
import net = require('net');
import tls = require('tls');
import { ServerApiClient } from '../core/server/ServerApiClient';
import { createHostDataTransport, HOST_DATA_UNAVAILABLE, isHostDataError } from '../core/host/hostDataTransport';

// QL-DATA (DT-1-u, ERR-u): every ServerApiClient data method goes through the host transport
// (vscode.quantlabHost) as ONE named op, opens no socket of its own, and passes the host's coded
// rejection on unchanged. The data-method list is generated from ServerApiClient.prototype at run time
// (minus the named non-data members), so a new method without a fixture below fails the coverage test.
//
// Planted negative control: in ServerApiClient.getYieldCurve, replace `await this.call('yieldCurve', {})`
// with a direct `https.request(...)` (re-adding `import * as https from 'https'`). The https spy then
// records a call and the host records none for getYieldCurve, so 'every data method makes exactly one
// host call and opens no socket' fails.

type HostCall = { op: string; input: unknown; token: unknown };
type Method = (...args: unknown[]) => Promise<unknown>;

// Members of ServerApiClient.prototype that are not data calls (shared, identity, stream, private helpers).
const NON_DATA_MEMBERS = new Set([
	'constructor', 'dispose', 'setHostIdentity', 'isAuthenticated', 'getUser',
	'log', 'call', 'getCalendarPage', 'getCryptoBars', 'toCryptoTimeframe',
]);

// Methods that fail locally (route not provisioned on the server): no host call.
const LOCAL_THROW = new Set(['getCalendarCentralBank', 'validateStrategy', 'getStrategyTemplates']);

const calendarPage = { events: [], total: 0, limit: 0, offset: 0, has_more: false };

// method -> [args, op, expected input, host answer]
const FIXTURES: Record<string, [unknown[], string, unknown, unknown]> = {
	getCryptoSymbols: [[], 'cryptoSymbols', {}, { coins: [], count: 0 }],
	getEtfs: [[], 'etfs.list', {}, []],
	getGlobalIndices: [[], 'globalIndices.list', {}, []],
	getYieldCurve: [[], 'yieldCurve', {}, []],
	getCalendarEconomic: [[], 'calendar.listEconomic', {}, calendarPage],
	getCalendarEarnings: [[], 'calendar.listEarnings', {}, calendarPage],
	getCalendarDividends: [[], 'calendar.listDividends', {}, calendarPage],
	getCalendarIPOs: [[], 'calendar.listIpos', {}, calendarPage],
	getCalendarSplits: [[], 'calendar.listSplits', {}, calendarPage],
	getSentiment: [['AAPL'], 'sentiment.get', { symbol: 'AAPL' }, { symbol: 'AAPL' }],
	getNews: [[], 'news.list', {}, []],
	getNewsBySymbol: [['AAPL'], 'news.listBySymbol', { symbol: 'AAPL' }, []],
	getFundamentalsProfile: [['AAPL'], 'fundamentals.getProfile', { symbol: 'AAPL' }, { symbol: 'AAPL' }],
	getFundamentalsFinancials: [['AAPL'], 'fundamentals.getFinancials', { symbol: 'AAPL' }, { symbol: 'AAPL', statements: [] }],
	getFundamentalsRatios: [['AAPL'], 'fundamentals.getRatios', { symbol: 'AAPL' }, { symbol: 'AAPL' }],
	getInstitutionalHoldings: [['AAPL'], 'institutional.listHoldings', { symbol: 'AAPL' }, []],
	getInstitutionalInsiders: [['AAPL'], 'institutional.listInsiders', { symbol: 'AAPL' }, []],
	getSymbols: [[], 'symbolsPage', { page_size: 500, page: 1 }, { symbols: [] }],
	getSymbol: [['AAPL'], 'symbols.get', { symbol: 'AAPL' }, { symbol: 'AAPL' }],
	getBars: [[{ symbol: 'AAPL', timeframe: '1D', from: 1, to: 2, limit: 3 }], 'bars', { symbol: 'AAPL', timeframe: '1D', from: 1, to: 2, limit: 3 }, { bars: [], count: 0 }],
	getWatchlists: [[], 'watchlists.list', {}, { watchlists: [], count: 0 }],
	createWatchlist: [['Tech', ['AAPL']], 'watchlists.create', { body: { name: 'Tech', symbols: ['AAPL'] } }, { id: 'w1' }],
	getWatchlist: [['w1'], 'watchlists.get', { id: 'w1' }, { id: 'w1' }],
	updateWatchlist: [['w1', { name: 'T2' }], 'watchlists.update', { id: 'w1', body: { name: 'T2' } }, { id: 'w1' }],
	deleteWatchlist: [['w1'], 'watchlists.delete', { id: 'w1' }, null],
	getAlerts: [[], 'alerts.list', {}, { alerts: [], count: 0 }],
	createAlert: [[{ symbol: 'AAPL' }], 'alerts.create', { body: { symbol: 'AAPL' } }, { id: 'a1' }],
	getAlert: [['a1'], 'alerts.get', { id: 'a1' }, { id: 'a1' }],
	updateAlert: [['a1', { price: '1' }], 'alerts.update', { id: 'a1', body: { price: '1' } }, { id: 'a1' }],
	deleteAlert: [['a1'], 'alerts.delete', { id: 'a1' }, null],
	getResourcesCatalog: [['v9'], 'resources.getCatalog', { v: 'v9' }, null],
	getResourcesCatalogVersion: [[], 'resources.getCatalogVersion', {}, { version: '1', tool_count: 0 }],
	getResourceToolDetail: [['t1'], 'resources.getToolDetail', { toolId: 't1' }, { id: 't1' }],
	executeToolJob: [[{ tool_id: 't1' }], 'tools.execute', { body: { tool_id: 't1' } }, { job_id: 'j1' }],
	getToolJobStatus: [['j1'], 'tools.getStatus', { jobId: 'j1' }, { status: 'done' }],
	getToolJobResult: [['j1'], 'tools.getResult', { jobId: 'j1' }, { result: 1 }],
	cancelToolJob: [['j1'], 'tools.cancel', { jobId: 'j1' }, null],
};

function dataMethodNames(): string[] {
	return Object.getOwnPropertyNames(ServerApiClient.prototype)
		.filter(name => !NON_DATA_MEMBERS.has(name))
		.sort();
}

function setHost(host: unknown): void {
	(vscode as unknown as { quantlabHost?: unknown }).quantlabHost = host;
}

function clearHost(): void {
	delete (vscode as unknown as { quantlabHost?: unknown }).quantlabHost;
}

function method(client: ServerApiClient, name: string): Method {
	const fn = (client as unknown as Record<string, Method>)[name];
	return (...args: unknown[]) => fn.apply(client, args);
}

/** Counts every direct socket/HTTP attempt in this process; each spy throws so nothing leaves the box. */
function installEgressSpies(): { count: () => number; restore: () => void } {
	let attempts = 0;
	const blocked = (): never => { attempts++; throw new Error('test: direct egress attempted'); };
	const httpRequest = http.request;
	const httpsRequest = https.request;
	const socketConnect = net.Socket.prototype.connect;
	const tlsConnect = tls.connect;
	const g = globalThis as unknown as { fetch: unknown };
	const fetchFn = g.fetch;
	(http as unknown as { request: unknown }).request = blocked;
	(https as unknown as { request: unknown }).request = blocked;
	(net.Socket.prototype as unknown as { connect: unknown }).connect = blocked;
	(tls as unknown as { connect: unknown }).connect = blocked;
	g.fetch = blocked;
	return {
		count: () => attempts,
		restore: () => {
			(http as unknown as { request: unknown }).request = httpRequest;
			(https as unknown as { request: unknown }).request = httpsRequest;
			(net.Socket.prototype as unknown as { connect: unknown }).connect = socketConnect;
			(tls as unknown as { connect: unknown }).connect = tlsConnect;
			g.fetch = fetchFn;
		},
	};
}

function codedError(code: string): Error {
	const err = new Error(`quantlab-host-data:${code}: test rejection`);
	(err as Error & { code: string }).code = code;
	return err;
}

suite('ServerApiClient through the host transport (QL-DATA)', () => {
	let calls: HostCall[];
	let answers: Map<string, unknown>;
	let rejection: Error | undefined;
	let client: ServerApiClient;

	setup(() => {
		_resetShimState();
		calls = [];
		answers = new Map();
		rejection = undefined;
		setHost({
			request: async (op: string, input: unknown, token?: unknown): Promise<unknown> => {
				calls.push({ op, input, token });
				if (rejection) { throw rejection; }
				if (!answers.has(op)) { throw new Error(`test: no answer for op ${op}`); }
				return answers.get(op);
			},
		});
		ServerApiClient.resetInstance();
		client = ServerApiClient.getInstance();
	});

	teardown(() => {
		ServerApiClient.resetInstance();
		clearHost();
	});

	test('every data method has a fixture (the list is generated from the prototype)', () => {
		const expected = dataMethodNames().filter(name => !LOCAL_THROW.has(name));
		assert.deepStrictEqual(Object.keys(FIXTURES).sort(), expected);
	});

	test('every data method makes exactly one host call and opens no socket', async () => {
		const spies = installEgressSpies();
		try {
			for (const name of dataMethodNames()) {
				const before = calls.length;
				if (LOCAL_THROW.has(name)) {
					await assert.rejects(() => method(client, name)('x'), /not provisioned on the server/, name);
					assert.strictEqual(calls.length, before, `${name}: a local throw makes no host call`);
					continue;
				}
				const [args, op, input, answer] = FIXTURES[name];
				answers.set(op, answer);
				await method(client, name)(...args);
				assert.strictEqual(calls.length - before, 1, `${name}: one host call`);
				assert.strictEqual(calls[before].op, op, `${name}: op`);
				assert.deepStrictEqual(calls[before].input, input, `${name}: input`);
			}
			assert.strictEqual(spies.count(), 0, 'no direct http/https/net/tls/fetch egress');
		} finally {
			spies.restore();
		}
	});

	test('the cancellation token reaches the host unchanged', async () => {
		const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { /* none */ } }) };
		answers.set('bars', { bars: [], count: 0 });
		await client.getBars({ symbol: 'AAPL', timeframe: '1D' }, token as unknown as vscode.CancellationToken);
		assert.strictEqual(calls[0].token, token);
		assert.deepStrictEqual(calls[0].input, { symbol: 'AAPL', timeframe: '1D' });
	});

	for (const code of ['identity-changed', 'no-route', 'not-signed-in', 'not-available', 'upstream:503']) {
		test(`a host rejection '${code}' reaches the caller unchanged`, async () => {
			rejection = codedError(code);
			await assert.rejects(() => client.getWatchlists(), err => err === rejection && (err as { code?: string }).code === code);
			await assert.rejects(() => client.getBars({ symbol: 'AAPL', timeframe: '1D' }), err => err === rejection);
		});
	}

	test('a {success: false} envelope throws its message; with no message it throws a named error', async () => {
		answers.set('alerts.list', { success: false, data: null, error: { code: 'X', message: 'alerts are down' } });
		await assert.rejects(() => client.getAlerts(), /^Error: alerts are down$/);
		answers.set('alerts.list', { success: false, data: null });
		await assert.rejects(() => client.getAlerts(), /alerts\.list: the server reported a failure with no message/);
		answers.set('alerts.list', { success: true, data: { alerts: [], count: 0 } });
		assert.deepStrictEqual(await client.getAlerts(), []);
	});

	test('an empty answer to an object method is a shape error, never a cast', async () => {
		answers.set('sentiment.get', null);
		await assert.rejects(() => client.getSentiment('AAPL'), /Unexpected \/v1\/sentiment response shape: null/);
		answers.set('bars', { count: 0 });
		await assert.rejects(() => client.getBars({ symbol: 'AAPL', timeframe: '1D' }), /Unexpected \/v1\/bars response shape/);
	});

	test('crypto bars: volume-weighted aggregation; a bar without volume or a zero-volume timestamp throws', async () => {
		answers.set('cryptoBars', { bars: [
			{ t: 't1', o: 10, h: 12, l: 9, c: 11, v: 1 },
			{ t: 't1', o: 20, h: 22, l: 8, c: 21, v: 3 },
		] });
		const bars = await client.getBars({ symbol: 'BTC', timeframe: '1D', limit: 5, from: 1, assetClass: 'crypto' });
		assert.deepStrictEqual(calls[0], { op: 'cryptoBars', input: { symbol: 'BTC', tf: '1d', limit: 5 }, token: undefined });
		assert.deepStrictEqual(bars, [{ symbol: 'BTC', timestamp: 't1', open: 17.5, high: 22, low: 8, close: 18.5, volume: 4 }]);

		answers.set('cryptoBars', { bars: [{ t: 't2', o: 1, h: 1, l: 1, c: 1 }] });
		await assert.rejects(() => client.getBars({ symbol: 'BTC', timeframe: '1D', assetClass: 'crypto' }), /BTC at t2 has no volume/);
		answers.set('cryptoBars', { bars: [{ t: 't3', o: 1, h: 1, l: 1, c: 1, v: 0 }] });
		await assert.rejects(() => client.getBars({ symbol: 'BTC', timeframe: '1D', assetClass: 'crypto' }), /BTC at t3 have zero total volume/);
	});

	test('isHostDataError matches the host code only, never the message text', () => {
		assert.strictEqual(isHostDataError(codedError('not-signed-in'), 'not-signed-in'), true);
		for (const other of ['no-route', 'identity-changed', 'not-available', 'upstream:401']) {
			assert.strictEqual(isHostDataError(codedError(other), 'not-signed-in'), false, other);
		}
		assert.strictEqual(isHostDataError(new Error('Not signed in. Sign in in the terminal view.'), 'not-signed-in'), false);
		assert.strictEqual(isHostDataError(undefined, 'not-signed-in'), false);
		assert.strictEqual(isHostDataError('not-signed-in', 'not-signed-in'), false);
	});
});

suite('ServerApiClient without the host data API (Q-1)', () => {
	teardown(() => {
		ServerApiClient.resetInstance();
	});

	test('every data method rejects with the visible unavailable error; subscribe throws it', async () => {
		clearHost();
		ServerApiClient.resetInstance();
		const client = ServerApiClient.getInstance();
		for (const name of dataMethodNames()) {
			if (LOCAL_THROW.has(name)) { continue; }
			const [args] = FIXTURES[name];
			await assert.rejects(() => method(client, name)(...args), new RegExp(`^Error: ${HOST_DATA_UNAVAILABLE}$`), name);
		}
		assert.throws(() => createHostDataTransport().subscribe('quotes', {}), new RegExp(HOST_DATA_UNAVAILABLE));
	});
});
