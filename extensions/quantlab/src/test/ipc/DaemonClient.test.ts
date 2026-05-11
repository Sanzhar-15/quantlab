/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import { isTestFlagEnabled } from '../helpers/envFlag';
import * as assert from 'assert';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import {
	DaemonClient,
	createDaemonClient,
} from '../../core/trading/DaemonClient';
import { JsonRpcParser } from '../../core/ipc/JsonRpcParser';
import { getSocketPath } from '../../core/ipc/SocketTransport';
import { writeTokenFile, deleteTokenFile } from '../../core/ipc/TokenAuth';

suite('DaemonClient', () => {
	const testSessionId = 'daemon-test-' + Date.now();
	const testDir = path.join(os.homedir(), '.quantlab', 'sessions');
	const testToken = 'test-daemon-token';
	let mockServer: net.Server | null = null;
	let client: DaemonClient | null = null;
	let serverSocket: net.Socket | null = null;
	const parser = new JsonRpcParser();

	suiteSetup(async function () {
		// Megaudit Final.2: gated behind RUN_TRADING_INTEGRATION (see
		// daemon.integration.test.ts for rationale).
		if (!isTestFlagEnabled(process.env.RUN_TRADING_INTEGRATION)) {  // Megaudit-2 A6-MAJOR-3
			this.skip();
			return;
		}
		// Setup test directory and token
		await fs.mkdir(testDir, { recursive: true });
		await writeTokenFile(testSessionId, testToken);
	});

	suiteTeardown(async () => {
		await deleteTokenFile(testSessionId);
	});

	teardown(async () => {
		// Cleanup client
		if (client) {
			client.disconnect();
			client = null;
		}

		// Cleanup server
		if (mockServer) {
			mockServer.close();
			mockServer = null;
		}
		serverSocket = null;

		// Cleanup socket file
		const socketPath = getSocketPath(testSessionId);
		try {
			await fs.unlink(socketPath);
		} catch {
			// Ignore
		}
	});

	async function startMockServer(): Promise<void> {
		if (process.platform === 'win32') {
			return;
		}

		const socketPath = getSocketPath(testSessionId);
		mockServer = net.createServer((socket) => {
			serverSocket = socket;
		});
		await new Promise<void>((resolve) => {
			mockServer!.listen(socketPath, () => resolve());
		});
	}

	suite('constructor', () => {
		test('initializes with session ID', () => {
			client = new DaemonClient(testSessionId);

			assert.strictEqual(client.getSessionId(), testSessionId);
			assert.strictEqual(client.isConnected(), false);
		});

		test('accepts custom configuration', () => {
			client = new DaemonClient(testSessionId, {
				requestTimeoutMs: 5000,
				heartbeatIntervalMs: 1000,
			});

			assert.strictEqual(client.getSessionId(), testSessionId);
		});
	});

	suite('connect/disconnect', function () {
		test('connects to mock daemon', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			let connected = false;
			client.on('connect', () => {
				connected = true;
			});

			await client.connect();

			assert.strictEqual(client.isConnected(), true);
			assert.strictEqual(connected, true);
		});

		test('disconnects properly', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			await client.connect();

			let disconnected = false;
			client.on('disconnect', () => {
				disconnected = true;
			});

			client.disconnect();

			assert.strictEqual(client.isConnected(), false);
			assert.strictEqual(disconnected, true);
		});

		test('rejects pending requests on disconnect', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId, { requestTimeoutMs: 10000 });

			await client.connect();

			// Start a request that won't be answered
			const requestPromise = client.getPositions().catch(e => e);

			// Immediately disconnect
			client.disconnect();

			const result = await requestPromise;
			assert.ok(result instanceof Error);
			// Accept either 'Disconnected' or 'Not connected' due to timing
			assert.ok(result.message.includes('Disconnect') || result.message.includes('Not connected'));
		});
	});

	suite('request/response', function () {
		test('sends request and receives response', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			await client.connect();

			// Wait for server to have socket
			await new Promise(resolve => setTimeout(resolve, 100));

			// Handle requests on server side
			let receiveBuffer: Buffer = Buffer.alloc(0) as Buffer;
			serverSocket!.on('data', (data) => {
				receiveBuffer = Buffer.concat([receiveBuffer, data as Buffer]) as Buffer;

				const { messages, remainder } = parser.unframeMessages(receiveBuffer);
				receiveBuffer = remainder as Buffer;

				for (const msg of messages) {
					if ('method' in msg && msg.method === 'positions.get') {
						// Send response
						const response = parser.createSuccessResponse(
							(msg as any).id,
							[{ symbol: 'AAPL', quantity: 100, avgEntryPrice: 150, unrealizedPnl: 500, realizedPnl: 0, side: 'long' }]
						);
						serverSocket!.write(parser.frameMessage(response));
					}
				}
			});

			const positions = await client.getPositions();

			assert.strictEqual(positions.length, 1);
			assert.strictEqual(positions[0].symbol, 'AAPL');
			assert.strictEqual(positions[0].quantity, 100);
		});

		test('handles error response', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			let receiveBuffer: Buffer = Buffer.alloc(0) as Buffer;
			serverSocket!.on('data', (data) => {
				receiveBuffer = Buffer.concat([receiveBuffer, data as Buffer]) as Buffer;

				const { messages, remainder } = parser.unframeMessages(receiveBuffer);
				receiveBuffer = remainder as Buffer;

				for (const msg of messages) {
					if ('method' in msg && msg.method === 'positions.get') {
						// Send error response
						const response = parser.createErrorResponse(
							(msg as any).id,
							{ code: -32000, message: 'Session not found' }
						);
						serverSocket!.write(parser.frameMessage(response));
					}
				}
			});

			try {
				await client.getPositions();
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('Session not found'));
			}
		});

		test('times out on no response', async function () {
			this.timeout(5000);

			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId, { requestTimeoutMs: 500 });

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			// Server doesn't respond
			try {
				await client.getPositions();
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('timeout'));
			}
		});

		test('throws when not connected', async () => {
			client = new DaemonClient(testSessionId);

			try {
				await client.getPositions();
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('Not connected'));
			}
		});
	});

	suite('notifications', function () {
		test('emits positions.update on notification', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			const updates: any[] = [];
			client.on('positions.update', (positions) => {
				updates.push(positions);
			});

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			// Server sends notification
			const notification = parser.createNotification('positions.update', {
				positions: [{ symbol: 'MSFT', quantity: 50, avgEntryPrice: 300, unrealizedPnl: 100, realizedPnl: 0, side: 'long' }],
			});
			serverSocket!.write(parser.frameMessage(notification));

			await new Promise(resolve => setTimeout(resolve, 100));

			assert.strictEqual(updates.length, 1);
			assert.strictEqual(updates[0][0].symbol, 'MSFT');
		});

		test('emits orders.update on notification', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			const updates: any[] = [];
			client.on('orders.update', (orders) => {
				updates.push(orders);
			});

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			const notification = parser.createNotification('orders.update', {
				orders: [{ orderId: 'order-1', symbol: 'AAPL', side: 'buy', orderType: 'market', quantity: 10, status: 'submitted', filledQuantity: 0 }],
			});
			serverSocket!.write(parser.frameMessage(notification));

			await new Promise(resolve => setTimeout(resolve, 100));

			assert.strictEqual(updates.length, 1);
			assert.strictEqual(updates[0][0].orderId, 'order-1');
		});

		test('emits fills.update on notification', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			const updates: any[] = [];
			client.on('fills.update', (fills) => {
				updates.push(fills);
			});

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			const notification = parser.createNotification('fills.update', {
				fills: [{ fillId: 'fill-1', orderId: 'order-1', symbol: 'AAPL', side: 'buy', quantity: 10, price: 150.5, commission: 0, timestamp: '2026-01-26T10:00:00Z' }],
			});
			serverSocket!.write(parser.frameMessage(notification));

			await new Promise(resolve => setTimeout(resolve, 100));

			assert.strictEqual(updates.length, 1);
			assert.strictEqual(updates[0][0].fillId, 'fill-1');
		});

		test('emits risk.alert on notification', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			const alerts: any[] = [];
			client.on('risk.alert', (alert) => {
				alerts.push(alert);
			});

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			const notification = parser.createNotification('risk.alert', {
				type: 'exposure_limit',
				severity: 'warning',
				message: 'Approaching exposure limit',
				currentValue: 45000,
				limit: 50000,
			});
			serverSocket!.write(parser.frameMessage(notification));

			await new Promise(resolve => setTimeout(resolve, 100));

			assert.strictEqual(alerts.length, 1);
			assert.strictEqual(alerts[0].type, 'exposure_limit');
		});
	});

	suite('order operations', function () {
		test('submitOrder sends request and returns orderId', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			let receiveBuffer: Buffer = Buffer.alloc(0) as Buffer;
			serverSocket!.on('data', (data) => {
				receiveBuffer = Buffer.concat([receiveBuffer, data as Buffer]) as Buffer;

				const { messages, remainder } = parser.unframeMessages(receiveBuffer);
				receiveBuffer = remainder as Buffer;

				for (const msg of messages) {
					if ('method' in msg && msg.method === 'order.submit') {
						const response = parser.createSuccessResponse(
							(msg as any).id,
							{ orderId: 'order-123', status: 'submitted' }
						);
						serverSocket!.write(parser.frameMessage(response));
					}
				}
			});

			const orderId = await client.submitOrder({
				symbol: 'AAPL',
				side: 'buy',
				orderType: 'market',
				quantity: 100,
			});

			assert.strictEqual(orderId, 'order-123');
		});

		test('submitOrder throws on error result', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			let receiveBuffer: Buffer = Buffer.alloc(0) as Buffer;
			serverSocket!.on('data', (data) => {
				receiveBuffer = Buffer.concat([receiveBuffer, data as Buffer]) as Buffer;

				const { messages, remainder } = parser.unframeMessages(receiveBuffer);
				receiveBuffer = remainder as Buffer;

				for (const msg of messages) {
					if ('method' in msg && msg.method === 'order.submit') {
						const response = parser.createSuccessResponse(
							(msg as any).id,
							{ orderId: '', status: 'rejected', error: 'Insufficient buying power' }
						);
						serverSocket!.write(parser.frameMessage(response));
					}
				}
			});

			try {
				await client.submitOrder({
					symbol: 'AAPL',
					side: 'buy',
					orderType: 'market',
					quantity: 100000,
				});
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('Insufficient buying power'));
			}
		});

		test('cancelOrder sends cancel request', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			let receiveBuffer: Buffer = Buffer.alloc(0) as Buffer;
			serverSocket!.on('data', (data) => {
				receiveBuffer = Buffer.concat([receiveBuffer, data as Buffer]) as Buffer;

				const { messages, remainder } = parser.unframeMessages(receiveBuffer);
				receiveBuffer = remainder as Buffer;

				for (const msg of messages) {
					if ('method' in msg && msg.method === 'order.cancel') {
						const response = parser.createSuccessResponse((msg as any).id, { success: true });
						serverSocket!.write(parser.frameMessage(response));
					}
				}
			});

			await client.cancelOrder('order-456');

			// The orderId is embedded in params which includes _auth
			assert.ok(true); // If we get here without timeout, cancel was sent
		});
	});

	suite('session operations', function () {
		test('flattenPositions sends flatten.all request', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			await startMockServer();
			client = new DaemonClient(testSessionId);

			await client.connect();
			await new Promise(resolve => setTimeout(resolve, 100));

			let flattenCalled = false;
			let receiveBuffer: Buffer = Buffer.alloc(0) as Buffer;
			serverSocket!.on('data', (data) => {
				receiveBuffer = Buffer.concat([receiveBuffer, data as Buffer]) as Buffer;

				const { messages, remainder } = parser.unframeMessages(receiveBuffer);
				receiveBuffer = remainder as Buffer;

				for (const msg of messages) {
					if ('method' in msg && msg.method === 'flatten.all') {
						flattenCalled = true;
						const response = parser.createSuccessResponse((msg as any).id, { success: true });
						serverSocket!.write(parser.frameMessage(response));
					}
				}
			});

			await client.flattenPositions();

			assert.strictEqual(flattenCalled, true);
		});
	});
});

suite('createDaemonClient', () => {
	test('creates client instance', () => {
		const client = createDaemonClient('test-session');
		assert.ok(client instanceof DaemonClient);
		assert.strictEqual(client.getSessionId(), 'test-session');
	});

	test('passes config to client', () => {
		const client = createDaemonClient('test-session', { requestTimeoutMs: 5000 });
		assert.ok(client instanceof DaemonClient);
	});
});
