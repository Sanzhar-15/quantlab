/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import { CalendarPage, CryptoSymbol, ServerAlert, ServerApiClient } from '../core/server/ServerApiClient';

// Regression tests for the 2026-06-11 live-shape audit (megaudit H57/H58/H63):
// the list endpoints wrap their arrays in envelopes the old code did not
// unwrap ({alerts,count}, {coins,count}, {events,total,...}). Each getter must
// unwrap the LIVE envelope and throw loudly on an unexpected shape -- never
// silently return [].

interface ClientInternals {
	ensureAuthenticated(): Promise<void>;
	request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

suite('ServerApiClient live-envelope unwrapping', () => {
	let client: ServerApiClient;
	let internals: ClientInternals;
	let responses: Map<string, unknown>;

	setup(() => {
		ServerApiClient.resetInstance();
		client = ServerApiClient.getInstance();
		internals = client as unknown as ClientInternals;
		responses = new Map();
		internals.ensureAuthenticated = async () => { /* signed-in stub */ };
		internals.request = async <T>(_method: string, path: string): Promise<T> => {
			if (!responses.has(path)) {
				throw new Error(`Unexpected request in test: ${path}`);
			}
			return responses.get(path) as T;
		};
	});

	teardown(() => {
		ServerApiClient.resetInstance();
	});

	const liveAlert: ServerAlert = {
		id: 'a1',
		symbol: 'DETH',
		condition: 'crosses_above',
		price: '3500',
		message: 'Ethereum crossed $3,500!',
		status: 'triggered',
		notify_email: false,
		notify_push: true,
		triggered_at: '2026-03-20T00:54:05Z',
		created_at: '2026-03-20T00:29:05Z',
		updated_at: '2026-03-20T00:54:05Z',
	};

	test('getAlerts unwraps the live {alerts, count} envelope', async () => {
		responses.set('/v1/alerts', { alerts: [liveAlert], count: 1 });
		const alerts = await client.getAlerts();
		assert.strictEqual(alerts.length, 1);
		assert.strictEqual(alerts[0].symbol, 'DETH');
		assert.strictEqual(alerts[0].status, 'triggered');
	});

	test('getAlerts throws loudly on an unexpected shape (no silent [])', async () => {
		responses.set('/v1/alerts', [liveAlert]); // bare array, not the live envelope
		await assert.rejects(
			() => client.getAlerts(),
			/Unexpected \/v1\/alerts response shape/
		);
	});

	const liveCoin: CryptoSymbol = {
		symbol: 'BTC',
		name: 'Bitcoin',
		market_cap_rank: 1,
		current_price: 70087,
		market_cap: 1401897037367,
		circulating_supply: 20000546,
		image_url: 'https://example.test/btc.png',
		category: null,
		updated_at: '2026-03-11T00:31:26Z',
		exchange_count: 7,
	};

	test('getCryptoSymbols unwraps the live {coins, count} envelope', async () => {
		responses.set('/v1/crypto/symbols', { coins: [liveCoin], count: 1 });
		const coins = await client.getCryptoSymbols();
		assert.strictEqual(coins.length, 1);
		assert.strictEqual(coins[0].symbol, 'BTC');
		assert.strictEqual(coins[0].market_cap_rank, 1);
		assert.strictEqual(coins[0].current_price, 70087);
	});

	test('getCryptoSymbols throws loudly when the coins key is absent', async () => {
		responses.set('/v1/crypto/symbols', { symbols: [liveCoin] }); // the OLD assumed key
		await assert.rejects(
			() => client.getCryptoSymbols(),
			/Unexpected \/v1\/crypto\/symbols response shape/
		);
	});

	const livePage: CalendarPage = {
		events: [{
			id: 'e1',
			event_type: 'earnings',
			event_name: 'BTCS Earnings Q4 2025',
			datetime_utc: '2026-03-20T00:00:00Z',
			importance: 'medium',
			is_tentative: false,
			primary_source: 'finnhub',
		}],
		total: 4039,
		limit: 100,
		offset: 0,
		has_more: true,
	};

	test('calendar getters return the unified page with pagination fields', async () => {
		responses.set('/v1/calendar/earnings', livePage);
		const page = await client.getCalendarEarnings();
		assert.strictEqual(page.events.length, 1);
		assert.strictEqual(page.events[0].event_name, 'BTCS Earnings Q4 2025');
		assert.strictEqual(page.total, 4039);
		assert.strictEqual(page.has_more, true);
	});

	test('calendar getters throw loudly on an unexpected shape', async () => {
		responses.set('/v1/calendar/economic', [{ id: 'e2' }]); // bare array, not the envelope
		await assert.rejects(
			() => client.getCalendarEconomic(),
			/Unexpected \/v1\/calendar\/economic response shape/
		);
	});

	test('getCalendarCentralBank throws the descriptive not-provisioned error', async () => {
		await assert.rejects(
			() => client.getCalendarCentralBank(),
			/central-bank.*not provisioned on the server \(404\)/i
		);
	});
});
