/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import { DataService } from '../core/engine/DataService';
import { ServerApiClient, ServerBar } from '../core/server/ServerApiClient';

// Regression test for the 2026-06-11 charting hang: the live /v1/bars handler
// returns the MOST RECENT `limit` bars inside the requested window, sorted
// ASCENDING. The pagination code used to treat the LAST array element as the
// oldest bar of the batch, which only shrank the window by ~1 bar per request
// (~700 sequential round-trips for a 5y daily history -- the chart looked
// hung). Correct behavior: page backwards from the MINIMUM timestamp.
suite('DataService server-bars pagination', () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const TOTAL_BARS = 1210; // matches the live AAPL daily history extent

	// Synthetic daily history, oldest first. Anchored to the test run's clock
	// (not a fixed date) so the production trailing-5y default window always
	// covers it -- a fixed start date would age out of the window over time.
	const history: ServerBar[] = [];
	const start = Date.now() - (TOTAL_BARS - 1) * DAY_MS;
	for (let i = 0; i < TOTAL_BARS; i++) {
		const t = start + i * DAY_MS;
		history.push({
			symbol: 'TEST',
			timestamp: new Date(t).toISOString(),
			open: 100 + i,
			high: 101 + i,
			low: 99 + i,
			close: 100.5 + i,
			volume: 1000 + i
		});
	}

	let requestCount = 0;
	const originalGetInstance = ServerApiClient.getInstance;

	// Mimics the live server: most recent `limit` bars within [from, to],
	// sorted ascending.
	const fakeClient = {
		getBars: async (params: { symbol: string; from?: number; to?: number; limit?: number }): Promise<ServerBar[]> => {
			requestCount++;
			if (requestCount > 50) {
				throw new Error('Pagination runaway: more than 50 requests for one history');
			}
			// Strict-server emulation: an inverted window is a client bug.
			if (params.from !== undefined && params.to !== undefined && params.from > params.to) {
				throw new Error('Invalid window: from > to');
			}
			const from = params.from ?? Number.NEGATIVE_INFINITY;
			const to = params.to ?? Number.POSITIVE_INFINITY;
			const inWindow = history.filter(b => {
				const t = Date.parse(b.timestamp);
				return t >= from && t <= to;
			});
			const limit = params.limit ?? 500;
			return inWindow.slice(Math.max(0, inWindow.length - limit));
		}
	} as unknown as ServerApiClient;

	suiteSetup(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fakeClient;
		DataService.resetInstance();
	});

	suiteTeardown(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
		DataService.resetInstance();
	});

	test('fetches a multi-batch history completely in few requests', async () => {
		requestCount = 0;
		const result = await DataService.getInstance().getOHLCVFromServer(
			'TEST', '1D',
			{ start: history[0].timestamp, end: history[TOTAL_BARS - 1].timestamp }
		);

		assert.strictEqual(result.data.length, TOTAL_BARS, 'must fetch the FULL history');
		// 1210 bars at batch size 500 = 3 windows (the 3rd is a short batch
		// that terminates the loop). Anything near ~700 means the old
		// 1-bar-per-request regression is back.
		assert.ok(requestCount <= 4, `expected <= 4 requests, made ${requestCount}`);

		// No duplicates, sorted ascending.
		const stamps = result.data.map(b => b.t);
		assert.strictEqual(new Set(stamps).size, TOTAL_BARS, 'no duplicate timestamps');
		for (let i = 1; i < stamps.length; i++) {
			assert.ok(stamps[i] > stamps[i - 1], 'bars sorted ascending');
		}
	});

	test('no-range request defaults to a trailing-5y window without runaway pagination', async () => {
		requestCount = 0;
		const result = await DataService.getInstance().getOHLCVFromServer('TEST', '1D');

		// The default window is now-5y (365-day years), which may trim a
		// couple of the oldest synthetic bars -- completeness within the
		// window is what matters, plus bounded request count.
		assert.ok(result.data.length >= TOTAL_BARS - 5, `expected nearly full history, got ${result.data.length}`);
		assert.ok(requestCount <= 4, `expected <= 4 requests, made ${requestCount}`);
	});

	test('exact full batch on the window edge terminates without an inverted request', async () => {
		requestCount = 0;
		// A window holding EXACTLY the batch size (500 bars): the oldest
		// returned bar sits on the window's left edge, so naive pagination
		// would follow up with from > to -- which the strict fake rejects.
		const lo = TOTAL_BARS - 500;
		const result = await DataService.getInstance().getOHLCVFromServer(
			'TEST', '1D',
			{ start: history[lo].timestamp, end: history[TOTAL_BARS - 1].timestamp }
		);

		assert.strictEqual(result.data.length, 500);
		assert.ok(requestCount <= 2, `expected <= 2 requests, made ${requestCount}`);
	});

	test('single-batch history needs exactly one request', async () => {
		requestCount = 0;
		// A 200-day explicit range fits one batch.
		const from = new Date(start + 900 * DAY_MS).toISOString();
		const to = new Date(start + 1100 * DAY_MS).toISOString();
		const result = await DataService.getInstance().getOHLCVFromServer(
			'TEST', '1D', { start: from, end: to }
		);

		assert.strictEqual(requestCount, 1, `expected 1 request, made ${requestCount}`);
		assert.strictEqual(result.data.length, 201);
	});
});

// M30 (timeframe switcher): hourly bars are far denser than daily -- a 5y 1h
// equity history is ~8700 bars, which naive pagination would turn into ~18+
// requests. The maxBars=5000 cap must bound BOTH the request count (10 batches
// of 500) and the returned bar count, keeping the MOST RECENT bars.
suite('DataService server-bars pagination (1h timeframe)', () => {
	const HOUR_MS = 60 * 60 * 1000;
	const TOTAL_BARS = 8760; // ~1y of wall-clock hours; > the 5000-bar cap

	const history: ServerBar[] = [];
	const start = Date.now() - (TOTAL_BARS - 1) * HOUR_MS;
	for (let i = 0; i < TOTAL_BARS; i++) {
		const t = start + i * HOUR_MS;
		history.push({
			symbol: 'TESTH',
			timestamp: new Date(t).toISOString(),
			open: 100 + i * 0.01,
			high: 101 + i * 0.01,
			low: 99 + i * 0.01,
			close: 100.5 + i * 0.01,
			volume: 1000 + i
		});
	}

	let requestCount = 0;
	let requestedTimeframes: string[] = [];
	const originalGetInstance = ServerApiClient.getInstance;

	// Same live-server emulation as the daily suite: most recent `limit` bars
	// within [from, to], sorted ascending; inverted windows are a client bug.
	const fakeClient = {
		getBars: async (params: { symbol: string; timeframe: string; from?: number; to?: number; limit?: number }): Promise<ServerBar[]> => {
			requestCount++;
			requestedTimeframes.push(params.timeframe);
			if (requestCount > 50) {
				throw new Error('Pagination runaway: more than 50 requests for one history');
			}
			if (params.from !== undefined && params.to !== undefined && params.from > params.to) {
				throw new Error('Invalid window: from > to');
			}
			const from = params.from ?? Number.NEGATIVE_INFINITY;
			const to = params.to ?? Number.POSITIVE_INFINITY;
			const inWindow = history.filter(b => {
				const t = Date.parse(b.timestamp);
				return t >= from && t <= to;
			});
			const limit = params.limit ?? 500;
			return inWindow.slice(Math.max(0, inWindow.length - limit));
		}
	} as unknown as ServerApiClient;

	suiteSetup(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fakeClient;
		DataService.resetInstance();
	});

	suiteTeardown(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
		DataService.resetInstance();
	});

	test('an over-cap 1h history is bounded to 5000 bars in at most 10 requests, keeping the newest bars', async () => {
		requestCount = 0;
		requestedTimeframes = [];
		const result = await DataService.getInstance().getOHLCVFromServer(
			'TESTH', '1H',
			{ start: history[0].timestamp, end: history[TOTAL_BARS - 1].timestamp }
		);

		// Client '1H' must reach the server as '1h' (the live /v1/bars format).
		assert.ok(requestedTimeframes.every(tf => tf === '1h'), `server saw: ${requestedTimeframes.join(',')}`);

		assert.strictEqual(result.data.length, 5000, 'maxBars cap holds');
		assert.ok(requestCount <= 10, `expected <= 10 requests (5000/500), made ${requestCount}`);

		// The cap keeps the MOST RECENT window: last bar = history end, first
		// bar = exactly 4999 hours earlier.
		const lastT = result.data[result.data.length - 1].t;
		assert.strictEqual(lastT, Date.parse(history[TOTAL_BARS - 1].timestamp), 'newest bar retained');
		assert.strictEqual(result.data[0].t, lastT - 4999 * HOUR_MS, 'oldest retained bar is 4999h before the newest');

		// No duplicates, sorted ascending.
		const stamps = result.data.map(b => b.t);
		assert.strictEqual(new Set(stamps).size, stamps.length, 'no duplicate timestamps');
		for (let i = 1; i < stamps.length; i++) {
			assert.ok(stamps[i] > stamps[i - 1], 'bars sorted ascending');
		}
	});

	test('a preset-sized 1h window (1M back) stays within a handful of requests', async () => {
		requestCount = 0;
		// What the 1M range preset produces while on the 1h interval: a
		// 30-day window anchored to the last bar = ~720 hourly bars.
		const end = Date.parse(history[TOTAL_BARS - 1].timestamp);
		const result = await DataService.getInstance().getOHLCVFromServer(
			'TESTH', '1H',
			{ start: new Date(end - 30 * 24 * HOUR_MS).toISOString(), end: new Date(end + 24 * HOUR_MS).toISOString() }
		);

		assert.strictEqual(result.data.length, 721, '30 days of hourly bars + the anchor bar');
		assert.ok(requestCount <= 3, `expected <= 3 requests (721/500), made ${requestCount}`);
	});
});
