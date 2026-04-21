#!/usr/bin/env node
/**
 * Live Server Integration Test Suite
 * Tests the complete QuantLab ↔ Delta Plus Server integration
 *
 * Run with: node test/live-server-integration.test.js
 */

const http = require('http');

const SERVER_URL = 'http://localhost:8080';

// Test state
let accessToken = null;
let testResults = { passed: 0, failed: 0, skipped: 0 };
let allSymbols = [];
let allWatchlists = [];

// Utilities
function request(method, path, body = null, token = accessToken) {
	return new Promise((resolve, reject) => {
		const url = new URL(path, SERVER_URL);
		const options = {
			hostname: url.hostname,
			port: url.port,
			path: url.pathname + url.search,
			method,
			headers: {
				'Content-Type': 'application/json',
			},
			timeout: 10000
		};

		if (token) {
			options.headers['Authorization'] = `Bearer ${token}`;
		}

		const req = http.request(options, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				try {
					const json = data ? JSON.parse(data) : {};
					resolve({ status: res.statusCode, data: json });
				} catch (e) {
					resolve({ status: res.statusCode, data: data, parseError: e.message });
				}
			});
		});

		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy();
			reject(new Error('Request timeout'));
		});

		if (body) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

async function test(name, fn) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
		testResults.passed++;
	} catch (e) {
		console.log(`  ✗ ${name}`);
		console.log(`    Error: ${e.message}`);
		testResults.failed++;
	}
}

function skip(name, reason) {
	console.log(`  ⊘ ${name} (skipped: ${reason})`);
	testResults.skipped++;
}

function assert(condition, message) {
	if (!condition) throw new Error(message || 'Assertion failed');
}

function section(name) {
	console.log(`\n${name}`);
	console.log('-'.repeat(name.length));
}

// ============================================================
// TEST SUITES
// ============================================================

async function testServerConnectivity() {
	section('1. Server Connectivity');

	await test('Server is reachable', async () => {
		const res = await request('GET', '/');
		// Any response means server is up
		assert(res.status !== undefined, 'Should get a response');
	});
}

async function testAuthentication() {
	section('2. Authentication');

	await test('Login with demo credentials', async () => {
		const res = await request('POST', '/v1/auth/login', {
			email: 'demo@deltaplus.io',
			password: 'demo123'
		}, null);

		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.success === true, 'Login should succeed');
		assert(res.data.data?.access_token, 'Should receive access token');
		assert(res.data.data?.refresh_token, 'Should receive refresh token');

		accessToken = res.data.data.access_token;
	});

	await test('Login fails with wrong password', async () => {
		const res = await request('POST', '/v1/auth/login', {
			email: 'demo@deltaplus.io',
			password: 'wrongpassword'
		}, null);

		assert(res.status === 401 || res.data.success === false, 'Should reject wrong password');
	});

	await test('Protected endpoint rejects without token', async () => {
		const res = await request('GET', '/v1/symbols', null, null);
		assert(res.status === 401 || res.data.success === false, 'Should reject unauthenticated request');
	});
}

async function testSymbolsAPI() {
	section('3. Symbols API');

	await test('GET /v1/symbols returns symbol list', async () => {
		const res = await request('GET', '/v1/symbols');

		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.success === true, 'Request should succeed');
		assert(Array.isArray(res.data.data), 'Should return array of symbols');
		assert(res.data.data.length > 0, 'Should have at least one symbol');

		allSymbols = res.data.data;
	});

	await test('Symbols have required fields', async () => {
		assert(allSymbols.length > 0, 'Need symbols from previous test');

		for (const symbol of allSymbols.slice(0, 5)) {
			assert(symbol.symbol, `Symbol ${JSON.stringify(symbol)} missing 'symbol' field`);
			assert(symbol.name, `Symbol ${symbol.symbol} missing 'name' field`);
			assert(symbol.sector, `Symbol ${symbol.symbol} missing 'sector' field`);
		}
	});

	await test('Symbols include expected sectors', async () => {
		const sectors = new Set(allSymbols.map(s => s.sector));
		const expectedSectors = ['Tech', 'Finance', 'Crypto'];

		for (const expected of expectedSectors) {
			assert(sectors.has(expected), `Missing expected sector: ${expected}`);
		}
	});

	await test('GET /v1/symbols/:symbol returns single symbol', async () => {
		if (!allSymbols.length) {
			skip('Single symbol lookup', 'No symbols available');
			return;
		}

		const testSymbol = allSymbols[0].symbol;
		const res = await request('GET', `/v1/symbols/${testSymbol}`);

		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.success === true, 'Request should succeed');
		assert(res.data.data?.symbol === testSymbol, 'Should return requested symbol');
	});
}

async function testBarsAPI() {
	section('4. Bars/OHLCV API');

	const testSymbol = allSymbols[0]?.symbol || 'AAPL';

	await test('GET /v1/bars/:symbol returns OHLCV data', async () => {
		const res = await request('GET', `/v1/bars/${testSymbol}?timeframe=1D&limit=10`);

		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.success === true, 'Request should succeed');
		assert(Array.isArray(res.data.data), 'Should return array of bars');
	});

	await test('Bars have OHLCV fields', async () => {
		const res = await request('GET', `/v1/bars/${testSymbol}?timeframe=1D&limit=5`);

		assert(res.data.data?.length > 0, 'Should have bar data');

		const bar = res.data.data[0];
		assert('timestamp' in bar || 't' in bar, 'Bar should have timestamp');
		assert('open' in bar || 'o' in bar, 'Bar should have open');
		assert('high' in bar || 'h' in bar, 'Bar should have high');
		assert('low' in bar || 'l' in bar, 'Bar should have low');
		assert('close' in bar || 'c' in bar, 'Bar should have close');
		assert('volume' in bar || 'v' in bar, 'Bar should have volume');
	});

	await test('Different timeframes work (1h)', async () => {
		const res = await request('GET', `/v1/bars/${testSymbol}?timeframe=1h&limit=5`);
		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.data?.length > 0, 'Should have bar data for 1h');
	});

	await test('Different timeframes work (4h)', async () => {
		const res = await request('GET', `/v1/bars/${testSymbol}?timeframe=4h&limit=5`);
		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.data?.length > 0, 'Should have bar data for 4h');
	});

	await test('Limit parameter works', async () => {
		const res5 = await request('GET', `/v1/bars/${testSymbol}?timeframe=1D&limit=5`);
		const res20 = await request('GET', `/v1/bars/${testSymbol}?timeframe=1D&limit=20`);

		assert(res5.data.data?.length <= 5, 'Should respect limit=5');
		assert(res20.data.data?.length <= 20, 'Should respect limit=20');
		assert(res20.data.data?.length > res5.data.data?.length, 'limit=20 should have more bars than limit=5');
	});
}

async function testWatchlistsAPI() {
	section('5. Watchlists API');

	await test('GET /v1/watchlists returns watchlist array', async () => {
		const res = await request('GET', '/v1/watchlists');

		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.success === true, 'Request should succeed');
		assert(Array.isArray(res.data.data), 'Should return array of watchlists');

		allWatchlists = res.data.data;
	});

	await test('Watchlists have required fields', async () => {
		if (!allWatchlists.length) {
			skip('Watchlist fields', 'No watchlists exist');
			return;
		}

		const wl = allWatchlists[0];
		assert(wl.id, 'Watchlist should have id');
		assert(wl.name, 'Watchlist should have name');
		assert(Array.isArray(wl.symbols), 'Watchlist should have symbols array');
	});

	let createdWatchlistId = null;

	await test('POST /v1/watchlists creates new watchlist', async () => {
		const res = await request('POST', '/v1/watchlists', {
			name: 'Test Watchlist',
			symbols: ['AAPL', 'GOOGL']
		});

		assert(res.status === 200 || res.status === 201, `Expected 200/201, got ${res.status}`);
		assert(res.data.success === true, 'Should succeed');
		assert(res.data.data?.id, 'Should return created watchlist with ID');

		createdWatchlistId = res.data.data.id;
	});

	await test('PUT /v1/watchlists/:id updates watchlist', async () => {
		if (!createdWatchlistId) {
			skip('Update watchlist', 'No watchlist created');
			return;
		}

		const res = await request('PUT', `/v1/watchlists/${createdWatchlistId}`, {
			name: 'Updated Test Watchlist',
			symbols: ['AAPL', 'GOOGL', 'MSFT']
		});

		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.success === true, 'Should succeed');
	});

	await test('DELETE /v1/watchlists/:id removes watchlist', async () => {
		if (!createdWatchlistId) {
			skip('Delete watchlist', 'No watchlist created');
			return;
		}

		const res = await request('DELETE', `/v1/watchlists/${createdWatchlistId}`);
		assert(res.status === 200 || res.status === 204, `Expected 200/204, got ${res.status}`);
	});
}

async function testDemoAPI() {
	section('6. Demo Control API');

	await test('GET /v1/demo/status returns demo state', async () => {
		const res = await request('GET', '/v1/demo/status');

		assert(res.status === 200, `Expected 200, got ${res.status}`);
		assert(res.data.success === true, 'Request should succeed');
		assert(res.data.data !== undefined, 'Should return demo status');
	});
}

async function testWebSocket() {
	section('7. WebSocket Connection');

	await test('WebSocket endpoint accepts connection', async () => {
		return new Promise((resolve, reject) => {
			let WebSocket;
			try {
				WebSocket = require('ws');
			} catch {
				console.log('  ⊘ WebSocket test (skipped: ws module not installed)');
				testResults.skipped++;
				resolve();
				return;
			}

			const ws = new WebSocket(`ws://localhost:8080/ws?token=${accessToken}`);
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error('WebSocket connection timeout'));
			}, 5000);

			ws.on('open', () => {
				clearTimeout(timeout);
				ws.close();
				resolve();
			});

			ws.on('error', (err) => {
				clearTimeout(timeout);
				reject(new Error(`WebSocket error: ${err.message}`));
			});
		});
	});

	await test('WebSocket receives quote data', async () => {
		return new Promise((resolve, reject) => {
			let WebSocket;
			try {
				WebSocket = require('ws');
			} catch {
				console.log('  ⊘ WebSocket quote test (skipped: ws module not installed)');
				testResults.skipped++;
				resolve();
				return;
			}

			const ws = new WebSocket(`ws://localhost:8080/ws?token=${accessToken}`);
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error('No quote received within 5 seconds'));
			}, 5000);

			ws.on('message', (data) => {
				try {
					const msg = JSON.parse(data.toString());
					if (msg.type === 'quote' || msg.symbol) {
						clearTimeout(timeout);
						ws.close();
						resolve();
					}
				} catch (e) {
					// Continue waiting
				}
			});

			ws.on('error', (err) => {
				clearTimeout(timeout);
				reject(new Error(`WebSocket error: ${err.message}`));
			});
		});
	});
}

async function testDataIntegrity() {
	section('8. Data Integrity');

	await test('Bar timestamps are in chronological order', async () => {
		const symbol = allSymbols[0]?.symbol || 'AAPL';
		const res = await request('GET', `/v1/bars/${symbol}?timeframe=1D&limit=50`);

		assert(res.data.data?.length > 1, 'Need multiple bars');

		const bars = res.data.data;
		for (let i = 1; i < bars.length; i++) {
			const prevTime = new Date(bars[i - 1].timestamp || bars[i - 1].t).getTime();
			const currTime = new Date(bars[i].timestamp || bars[i].t).getTime();
			assert(currTime >= prevTime, `Bar ${i} timestamp should be >= bar ${i - 1}`);
		}
	});

	await test('OHLCV values are valid numbers', async () => {
		const symbol = allSymbols[0]?.symbol || 'AAPL';
		const res = await request('GET', `/v1/bars/${symbol}?timeframe=1D&limit=10`);

		for (const bar of res.data.data || []) {
			const o = bar.open ?? bar.o;
			const h = bar.high ?? bar.h;
			const l = bar.low ?? bar.l;
			const c = bar.close ?? bar.c;
			const v = bar.volume ?? bar.v;

			assert(typeof o === 'number' && !isNaN(o), 'Open should be valid number');
			assert(typeof h === 'number' && !isNaN(h), 'High should be valid number');
			assert(typeof l === 'number' && !isNaN(l), 'Low should be valid number');
			assert(typeof c === 'number' && !isNaN(c), 'Close should be valid number');
			assert(typeof v === 'number' && !isNaN(v), 'Volume should be valid number');
		}
	});

	await test('High >= Low for all bars', async () => {
		const symbol = allSymbols[0]?.symbol || 'AAPL';
		const res = await request('GET', `/v1/bars/${symbol}?timeframe=1D&limit=50`);

		for (const bar of res.data.data || []) {
			const h = bar.high ?? bar.h;
			const l = bar.low ?? bar.l;
			assert(h >= l, `High (${h}) should be >= Low (${l})`);
		}
	});

	await test('High >= Open and High >= Close for all bars', async () => {
		const symbol = allSymbols[0]?.symbol || 'AAPL';
		const res = await request('GET', `/v1/bars/${symbol}?timeframe=1D&limit=50`);

		for (const bar of res.data.data || []) {
			const o = bar.open ?? bar.o;
			const h = bar.high ?? bar.h;
			const c = bar.close ?? bar.c;
			assert(h >= o, `High (${h}) should be >= Open (${o})`);
			assert(h >= c, `High (${h}) should be >= Close (${c})`);
		}
	});
}

async function testErrorHandling() {
	section('9. Error Handling');

	await test('Invalid symbol returns 404', async () => {
		const res = await request('GET', '/v1/symbols/INVALID_SYMBOL_XYZ123');
		assert(res.status === 404 || res.data.success === false, 'Should return error for invalid symbol');
	});

	await test('Invalid timeframe handled gracefully', async () => {
		const symbol = allSymbols[0]?.symbol || 'AAPL';
		const res = await request('GET', `/v1/bars/${symbol}?timeframe=invalid`);
		// Should either return error or default to a valid timeframe
		assert(res.status === 200 || res.status === 400, 'Should handle invalid timeframe');
	});

	await test('Expired token rejected', async () => {
		const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjEwMDAwMDAwMDB9.invalid';
		const res = await request('GET', '/v1/symbols', null, fakeToken);
		assert(res.status === 401 || res.data.success === false, 'Should reject invalid token');
	});
}

async function testPerformance() {
	section('10. Performance');

	await test('Symbols endpoint responds within 1 second', async () => {
		const start = Date.now();
		await request('GET', '/v1/symbols');
		const duration = Date.now() - start;
		assert(duration < 1000, `Response took ${duration}ms, expected < 1000ms`);
	});

	await test('Bars endpoint responds within 2 seconds', async () => {
		const symbol = allSymbols[0]?.symbol || 'AAPL';
		const start = Date.now();
		await request('GET', `/v1/bars/${symbol}?timeframe=1D&limit=100`);
		const duration = Date.now() - start;
		assert(duration < 2000, `Response took ${duration}ms, expected < 2000ms`);
	});

	await test('Multiple concurrent requests succeed', async () => {
		const symbol = allSymbols[0]?.symbol || 'AAPL';
		const promises = [
			request('GET', '/v1/symbols'),
			request('GET', `/v1/bars/${symbol}?timeframe=1D&limit=10`),
			request('GET', '/v1/watchlists'),
			request('GET', '/v1/demo/status'),
		];

		const results = await Promise.all(promises);
		for (const res of results) {
			assert(res.status === 200, 'All concurrent requests should succeed');
		}
	});
}

// ============================================================
// MAIN
// ============================================================

async function main() {
	console.log('='.repeat(60));
	console.log('Live Server Integration Test Suite');
	console.log('Server: ' + SERVER_URL);
	console.log('='.repeat(60));

	try {
		await testServerConnectivity();
		await testAuthentication();

		if (!accessToken) {
			console.log('\n⚠ Cannot continue without authentication token');
			process.exit(1);
		}

		await testSymbolsAPI();
		await testBarsAPI();
		await testWatchlistsAPI();
		await testDemoAPI();
		await testWebSocket();
		await testDataIntegrity();
		await testErrorHandling();
		await testPerformance();

	} catch (e) {
		console.log(`\n⚠ Test suite error: ${e.message}`);
	}

	// Summary
	console.log('\n' + '='.repeat(60));
	console.log('RESULTS');
	console.log('='.repeat(60));
	console.log(`  Passed:  ${testResults.passed}`);
	console.log(`  Failed:  ${testResults.failed}`);
	console.log(`  Skipped: ${testResults.skipped}`);
	console.log('='.repeat(60));

	process.exit(testResults.failed > 0 ? 1 : 0);
}

main().catch(e => {
	console.error('Fatal error:', e);
	process.exit(1);
});
