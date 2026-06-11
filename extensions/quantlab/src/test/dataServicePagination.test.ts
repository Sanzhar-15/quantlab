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
