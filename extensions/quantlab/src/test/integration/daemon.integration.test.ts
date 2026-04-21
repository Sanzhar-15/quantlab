/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Integration tests for daemon communication.
 *
 * These tests verify end-to-end communication between the TypeScript extension
 * and a mock daemon. They can be run against a real daemon when available.
 *
 * To run with a real daemon:
 *   1. Start the daemon: python -m quantlab.daemon start --paper
 *   2. Run tests: npm run test:integration
 */

import 'mocha';
import * as assert from 'assert';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import { DaemonClient } from '../../core/trading/DaemonClient';
import { JsonRpcParser } from '../../core/ipc/JsonRpcParser';
import { getSocketPath } from '../../core/ipc/SocketTransport';
import { writeTokenFile, deleteTokenFile, generateToken } from '../../core/ipc/TokenAuth';
import {
	DaemonPosition,
	DaemonOrder,
	DaemonFill,
	JsonRpcMessage,
	isJsonRpcRequest,
} from '../../core/ipc/types';

/**
 * Mock daemon for integration testing.
 *
 * Simulates the Python daemon's behavior for testing purposes.
 */
class MockDaemon {
	private server: net.Server | null = null;
	private socket: net.Socket | null = null;
	private parser = new JsonRpcParser();
	private receiveBuffer: Buffer = Buffer.alloc(0) as Buffer;

	private positions: DaemonPosition[] = [];
	private orders: DaemonOrder[] = [];
	private fills: DaemonFill[] = [];

	constructor(
		private readonly sessionId: string,
		private readonly socketPath: string
	) {}

	async start(): Promise<void> {
		// Ensure directory exists
		await fs.mkdir(path.dirname(this.socketPath), { recursive: true });

		return new Promise((resolve, reject) => {
			this.server = net.createServer((socket) => {
				this.socket = socket;
				this.setupSocketHandlers(socket);
			});

			this.server.on('error', reject);

			this.server.listen(this.socketPath, () => {
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}

		if (this.server) {
			return new Promise((resolve) => {
				this.server!.close(() => resolve());
			});
		}
	}

	private setupSocketHandlers(socket: net.Socket): void {
		socket.on('data', (data) => {
			this.handleData(data);
		});
	}

	private handleData(data: Buffer): void {
		this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]) as Buffer;

		try {
			const { messages, remainder } = this.parser.unframeMessages(this.receiveBuffer);
			this.receiveBuffer = remainder as Buffer;

			for (const message of messages) {
				this.handleMessage(message);
			}
		} catch (error) {
			console.error('Mock daemon parse error:', error);
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (!isJsonRpcRequest(message)) {
			return;
		}

		const { method, id, params } = message;

		// CODEX-014: Use real daemon contract (snake_case, correct method names)
		switch (method) {
			case 'authenticate':
				this.sendResponse(id, { status: 'authenticated' });
				break;

			case 'session.start':
				this.sendResponse(id, {
					session_id: this.sessionId,
					status: 'started',
				});
				break;

			case 'session.stop':
			case 'session.pause':
			case 'session.resume':
				this.sendResponse(id, { success: true });
				break;

			case 'health':
				this.sendResponse(id, {
					status: 'ok',
					uptime: 1000,
					last_heartbeat: Date.now(),
					broker_connected: true,
					memory_usage: 100,
				});
				break;

			case 'positions.get':
				this.sendResponse(id, { positions: this.positions });
				break;

			case 'orders.get':
				this.sendResponse(id, { orders: this.orders });
				break;

			case 'fills.get':
				this.sendResponse(id, { fills: this.fills });
				break;

			case 'order.submit': {
				const p = params as Record<string, unknown>;
				const orderId = `order-${Date.now()}`;
				const order: DaemonOrder = {
					orderId,
					symbol: p.symbol as string,
					side: p.side as 'buy' | 'sell',
					orderType: (p.order_type ?? p.orderType) as 'market' | 'limit',
					quantity: p.quantity as number,
					limitPrice: (p.limit_price ?? p.limitPrice) as number | undefined,
					status: 'submitted',
					filledQuantity: 0,
				};
				this.orders.push(order);
				this.sendResponse(id, { order_id: orderId, status: 'submitted' });

				// Simulate fill after short delay
				setTimeout(() => {
					this.simulateFill(order);
				}, 100);
				break;
			}

			case 'order.cancel': {
				const p = params as Record<string, unknown>;
				const cancelOrderId = (p.order_id ?? p.orderId) as string;
				const orderIndex = this.orders.findIndex(o => o.orderId === cancelOrderId);
				if (orderIndex >= 0) {
					this.orders[orderIndex].status = 'cancelled';
				}
				this.sendResponse(id, { success: true });
				break;
			}

			case 'flatten.request':
				// Close all positions (CODEX-014: correct method name)
				for (const pos of this.positions) {
					if (pos.quantity !== 0) {
						const orderId = `flatten-${Date.now()}`;
						const order: DaemonOrder = {
							orderId,
							symbol: pos.symbol,
							side: pos.side === 'long' ? 'sell' : 'buy',
							orderType: 'market',
							quantity: Math.abs(pos.quantity),
							status: 'submitted',
							filledQuantity: 0,
						};
						this.orders.push(order);
						setTimeout(() => this.simulateFill(order), 50);
					}
				}
				this.sendResponse(id, { success: true, positions_flattened: this.positions.length });
				break;

			case 'credentials.set':
				this.sendResponse(id, { success: true });
				break;

			case 'credentials.status':
				this.sendResponse(id, { has_broker_credentials: true });
				break;

			case 'exposure.metrics':
				this.sendResponse(id, {
					metrics: {
						total_exposure: 0,
						max_exposure: 100000,
						reservation_count: 0,
						oldest_reservation_age_seconds: 0,
					}
				});
				break;

			case 'circuit_breaker.status':
				this.sendResponse(id, {
					tripped: false,
					daily_pnl: 0,
					daily_loss_limit: 1000,
				});
				break;

			case 'status.get':
				this.sendResponse(id, {
					state: 'running',
					uptime: 1000,
					broker_connected: true,
				});
				break;

			default:
				this.sendError(id, -32601, `Method not found: ${method}`);
		}
	}

	private simulateFill(order: DaemonOrder): void {
		// Update order status
		order.status = 'filled';
		order.filledQuantity = order.quantity;
		order.avgFillPrice = 150.00; // Mock price

		// Create fill
		const fill: DaemonFill = {
			fillId: `fill-${Date.now()}`,
			orderId: order.orderId,
			symbol: order.symbol,
			side: order.side,
			quantity: order.quantity,
			price: 150.00,
			commission: 0,
			timestamp: new Date().toISOString(),
		};
		this.fills.push(fill);

		// Update position
		this.updatePosition(order);

		// Send notifications
		this.sendNotification('orders.update', { orders: [order] });
		this.sendNotification('fills.update', { fills: [fill] });
		this.sendNotification('positions.update', { positions: this.positions });
	}

	private updatePosition(order: DaemonOrder): void {
		let position = this.positions.find(p => p.symbol === order.symbol);

		if (!position) {
			position = {
				symbol: order.symbol,
				quantity: 0,
				avgEntryPrice: 0,
				unrealizedPnl: 0,
				realizedPnl: 0,
				side: 'flat',
			};
			this.positions.push(position);
		}

		const fillQty = order.side === 'buy' ? order.quantity : -order.quantity;
		position.quantity += fillQty;
		position.avgEntryPrice = 150.00;
		position.side = position.quantity > 0 ? 'long' : position.quantity < 0 ? 'short' : 'flat';
	}

	private sendResponse(id: string | number, result: unknown): void {
		const response = this.parser.createSuccessResponse(id, result);
		this.send(response);
	}

	private sendError(id: string | number, code: number, message: string): void {
		const error = this.parser.createError(code, message);
		const response = this.parser.createErrorResponse(id, error);
		this.send(response);
	}

	private sendNotification(method: string, params: unknown): void {
		const notification = this.parser.createNotification(method, params);
		this.send(notification);
	}

	private send(message: JsonRpcMessage): void {
		if (this.socket && !this.socket.destroyed) {
			const framed = this.parser.frameMessage(message);
			this.socket.write(framed);
		}
	}

	// Test helpers
	setPositions(positions: DaemonPosition[]): void {
		this.positions = positions;
	}

	setOrders(orders: DaemonOrder[]): void {
		this.orders = orders;
	}
}

suite('Daemon Integration Tests', function () {
	// Allow longer timeout for integration tests
	this.timeout(30000);

	const testSessionId = 'integration-test-' + Date.now();
	const socketPath = getSocketPath(testSessionId);
	const testToken = generateToken();
	let mockDaemon: MockDaemon;
	let client: DaemonClient;

	suiteSetup(async function () {
		// Skip on Windows for now
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		// Write token file
		await writeTokenFile(testSessionId, testToken);

		// Start mock daemon
		mockDaemon = new MockDaemon(testSessionId, socketPath);
		await mockDaemon.start();
	});

	suiteTeardown(async function () {
		if (process.platform === 'win32') {
			return;
		}

		if (client) {
			client.disconnect();
		}

		if (mockDaemon) {
			await mockDaemon.stop();
		}

		await deleteTokenFile(testSessionId);

		try {
			await fs.unlink(socketPath);
		} catch {
			// Ignore
		}
	});

	setup(function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		client = new DaemonClient(testSessionId, {
			requestTimeoutMs: 5000,
			heartbeatIntervalMs: 10000, // Slow heartbeat for tests
		});
	});

	teardown(function () {
		if (client) {
			client.disconnect();
		}
	});

	suite('Connection Lifecycle', function () {
		test('connects to daemon successfully', async function () {
			await client.connect();
			assert.strictEqual(client.isConnected(), true);
		});

		test('receives connect event', async function () {
			let connected = false;
			client.on('connect', () => {
				connected = true;
			});

			await client.connect();
			assert.strictEqual(connected, true);
		});

		test('disconnects cleanly', async function () {
			await client.connect();

			let disconnected = false;
			client.on('disconnect', () => {
				disconnected = true;
			});

			client.disconnect();
			assert.strictEqual(disconnected, true);
			assert.strictEqual(client.isConnected(), false);
		});
	});

	suite('Session Management', function () {
		setup(async function () {
			if (process.platform === 'win32') {
				return;
			}
			await client.connect();
		});

		test('starts session', async function () {
			const response = await client.startSession({
				sessionId: testSessionId,
				strategyPath: '/path/to/strategy.py',
				symbol: 'AAPL',
				timeframe: '1m',
				paper: true,
				riskLimits: {
					maxExposure: 50000,
				},
			});

			assert.strictEqual(response.sessionId, testSessionId);
			assert.strictEqual(response.status, 'started');
		});

		test('gets session status', async function () {
			const status = await client.getStatus();

			assert.strictEqual(status.state, 'running');
			assert.ok(status.brokerConnected);
		});

		test('gets health check', async function () {
			const health = await client.getHealth();

			assert.strictEqual(health.status, 'healthy');
			assert.ok(health.brokerConnected);
		});

		test('pauses and resumes session', async function () {
			await client.pauseSession();
			await client.resumeSession();
			// If no error, success
		});

		test('stops session', async function () {
			await client.stopSession();
			// If no error, success
		});
	});

	suite('Order Management', function () {
		setup(async function () {
			if (process.platform === 'win32') {
				return;
			}
			await client.connect();
		});

		test('submits market order', async function () {
			const orderId = await client.submitOrder({
				symbol: 'AAPL',
				side: 'buy',
				orderType: 'market',
				quantity: 100,
			});

			assert.ok(orderId);
			assert.ok(orderId.startsWith('order-'));
		});

		test('receives order update notification', async function () {
			const updates: DaemonOrder[][] = [];
			client.on('orders.update', (orders) => {
				updates.push(orders);
			});

			await client.submitOrder({
				symbol: 'AAPL',
				side: 'buy',
				orderType: 'market',
				quantity: 50,
			});

			// Wait for fill simulation
			await new Promise(resolve => setTimeout(resolve, 200));

			assert.ok(updates.length > 0);
			assert.strictEqual(updates[0][0].status, 'filled');
		});

		test('receives fill notification', async function () {
			const fills: DaemonFill[][] = [];
			client.on('fills.update', (f) => {
				fills.push(f);
			});

			await client.submitOrder({
				symbol: 'MSFT',
				side: 'buy',
				orderType: 'market',
				quantity: 25,
			});

			// Wait for fill simulation
			await new Promise(resolve => setTimeout(resolve, 200));

			assert.ok(fills.length > 0);
			assert.strictEqual(fills[0][0].symbol, 'MSFT');
			assert.strictEqual(fills[0][0].quantity, 25);
		});

		test('cancels order', async function () {
			const orderId = await client.submitOrder({
				symbol: 'GOOGL',
				side: 'buy',
				orderType: 'limit',
				quantity: 10,
				limitPrice: 100,
			});

			await client.cancelOrder(orderId);
			// If no error, success
		});

		test('gets open orders', async function () {
			const orders = await client.getOrders();
			assert.ok(Array.isArray(orders));
		});
	});

	suite('Position Management', function () {
		setup(async function () {
			if (process.platform === 'win32') {
				return;
			}
			await client.connect();
		});

		test('gets positions', async function () {
			const positions = await client.getPositions();
			assert.ok(Array.isArray(positions));
		});

		test('receives position update notification', async function () {
			const updates: DaemonPosition[][] = [];
			client.on('positions.update', (positions) => {
				updates.push(positions);
			});

			await client.submitOrder({
				symbol: 'NVDA',
				side: 'buy',
				orderType: 'market',
				quantity: 100,
			});

			// Wait for fill simulation
			await new Promise(resolve => setTimeout(resolve, 200));

			assert.ok(updates.length > 0);
		});

		test('flattens all positions', async function () {
			// First create a position
			await client.submitOrder({
				symbol: 'AMD',
				side: 'buy',
				orderType: 'market',
				quantity: 50,
			});
			await new Promise(resolve => setTimeout(resolve, 200));

			// Then flatten
			await client.flattenPositions();

			// Wait for flatten to complete
			await new Promise(resolve => setTimeout(resolve, 300));

			// If no error, success
		});
	});

	suite('Error Handling', function () {
		setup(async function () {
			if (process.platform === 'win32') {
				return;
			}
			await client.connect();
		});

		test('handles unknown method gracefully', async function () {
			// Use the internal request method via type assertion
			const clientAny = client as any;

			try {
				await clientAny.request('unknown.method', {});
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('Method not found'));
			}
		});

		test('handles disconnect during request', async function () {
			const requestPromise = client.getPositions();

			// Disconnect while request is pending
			client.disconnect();

			try {
				await requestPromise;
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				const msg = (error as Error).message;
				// Accept either 'Disconnected' or 'Not connected' due to timing
				assert.ok(msg.includes('Disconnect') || msg.includes('Not connected') || msg.includes('timeout'));
			}
		});
	});
});

suite('Concurrent Request Handling', function () {
	this.timeout(10000);

	const testSessionId = 'concurrent-test-' + Date.now();
	const socketPath = getSocketPath(testSessionId);
	const testToken = generateToken();
	let mockDaemon: MockDaemon;
	let client: DaemonClient;

	suiteSetup(async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		await writeTokenFile(testSessionId, testToken);
		mockDaemon = new MockDaemon(testSessionId, socketPath);
		await mockDaemon.start();
	});

	suiteTeardown(async function () {
		if (process.platform === 'win32') {
			return;
		}

		if (client) {
			client.disconnect();
		}
		if (mockDaemon) {
			await mockDaemon.stop();
		}
		await deleteTokenFile(testSessionId);
		try {
			await fs.unlink(socketPath);
		} catch {}
	});

	test('handles multiple concurrent requests', async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		client = new DaemonClient(testSessionId);
		await client.connect();

		// Send multiple requests concurrently
		const results = await Promise.all([
			client.getPositions(),
			client.getOrders(),
			client.getHealth(),
			client.getStatus(),
		]);

		assert.strictEqual(results.length, 4);
		assert.ok(Array.isArray(results[0])); // positions
		assert.ok(Array.isArray(results[1])); // orders
		assert.ok(results[2].status); // health
		assert.ok(results[3].state); // status
	});
});
