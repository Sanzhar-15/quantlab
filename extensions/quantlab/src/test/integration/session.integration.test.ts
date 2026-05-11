/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Integration tests for session lifecycle management.
 *
 * Tests the SessionManager's interaction with the daemon system,
 * including session creation, daemon communication, and cleanup.
 */

import 'mocha';

import { isTestFlagEnabled } from '../helpers/envFlag';
import * as assert from 'assert';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import { JsonRpcParser } from '../../core/ipc/JsonRpcParser';
import { getSocketPath } from '../../core/ipc/SocketTransport';
import { writeTokenFile, deleteTokenFile, generateToken } from '../../core/ipc/TokenAuth';
import { JsonRpcMessage, isJsonRpcRequest } from '../../core/ipc/types';

/**
 * Simplified mock daemon for session testing.
 */
class SessionMockDaemon {
	private server: net.Server | null = null;
	private sockets: Set<net.Socket> = new Set();
	private parser = new JsonRpcParser();
	private sessionState = 'stopped';

	constructor(
		private readonly sessionId: string,
		private readonly socketPath: string
	) {}

	async start(): Promise<void> {
		await fs.mkdir(path.dirname(this.socketPath), { recursive: true });

		return new Promise((resolve, reject) => {
			this.server = net.createServer((socket) => {
				this.sockets.add(socket);
				this.setupSocket(socket);
				socket.on('close', () => this.sockets.delete(socket));
			});

			this.server.on('error', reject);
			this.server.listen(this.socketPath, () => resolve());
		});
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.sockets.clear();

		if (this.server) {
			return new Promise((resolve) => {
				this.server!.close(() => resolve());
			});
		}
	}

	private setupSocket(socket: net.Socket): void {
		let buffer: Buffer = Buffer.alloc(0) as Buffer;

		socket.on('data', (data) => {
			buffer = Buffer.concat([buffer, data as Buffer]) as Buffer;

			try {
				const { messages, remainder } = this.parser.unframeMessages(buffer);
				buffer = remainder as Buffer;

				for (const message of messages) {
					this.handleMessage(message, socket);
				}
			} catch (error) {
				console.error('Parse error:', error);
			}
		});
	}

	private handleMessage(message: JsonRpcMessage, socket: net.Socket): void {
		if (!isJsonRpcRequest(message)) {
			return;
		}

		const { method, id } = message;

		switch (method) {
			case 'session.start':
				this.sessionState = 'running';
				this.respond(socket, id, {
					sessionId: this.sessionId,
					status: 'started',
				});
				break;

			case 'session.stop':
				this.sessionState = 'stopped';
				this.respond(socket, id, { success: true });
				break;

			case 'session.pause':
				this.sessionState = 'paused';
				this.respond(socket, id, { success: true });
				break;

			case 'session.resume':
				this.sessionState = 'running';
				this.respond(socket, id, { success: true });
				break;

			case 'health.check':
				this.respond(socket, id, {
					status: 'healthy',
					uptime: Date.now(),
					lastHeartbeat: Date.now(),
					brokerConnected: true,
					memoryUsage: 50,
				});
				break;

			case 'status.get':
				this.respond(socket, id, {
					state: this.sessionState,
					uptime: 1000,
					brokerConnected: true,
				});
				break;

			case 'positions.get':
				this.respond(socket, id, []);
				break;

			case 'orders.get':
				this.respond(socket, id, []);
				break;

			case 'flatten.all':
				this.respond(socket, id, { success: true });
				break;

			default:
				this.respondError(socket, id, -32601, `Unknown method: ${method}`);
		}
	}

	private respond(socket: net.Socket, id: string | number, result: unknown): void {
		const response = this.parser.createSuccessResponse(id, result);
		socket.write(this.parser.frameMessage(response));
	}

	private respondError(socket: net.Socket, id: string | number, code: number, message: string): void {
		const response = this.parser.createErrorResponse(id, { code, message });
		socket.write(this.parser.frameMessage(response));
	}

	getSessionState(): string {
		return this.sessionState;
	}
}

suite('Session Lifecycle Integration', function () {
	this.timeout(15000);

	const testSessionId = 'session-lifecycle-' + Date.now();
	const socketPath = getSocketPath(testSessionId);
	const testToken = generateToken();
	let mockDaemon: SessionMockDaemon;

	suiteSetup(async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}
		// Megaudit Final.2: gated behind RUN_TRADING_INTEGRATION (see
		// daemon.integration.test.ts for rationale).
		if (!isTestFlagEnabled(process.env.RUN_TRADING_INTEGRATION)) {  // Megaudit-2 A6-MAJOR-3
			this.skip();
			return;
		}

		await writeTokenFile(testSessionId, testToken);
		mockDaemon = new SessionMockDaemon(testSessionId, socketPath);
		await mockDaemon.start();
	});

	suiteTeardown(async function () {
		if (process.platform === 'win32') {
			return;
		}

		if (mockDaemon) {
			await mockDaemon.stop();
		}
		await deleteTokenFile(testSessionId);
		try {
			await fs.unlink(socketPath);
		} catch {}
	});

	suite('Session State Transitions', function () {
		const { DaemonClient } = require('../../core/trading/DaemonClient');

		test('session starts in stopped state', function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			assert.strictEqual(mockDaemon.getSessionState(), 'stopped');
		});

		test('session transitions to running after start', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const client = new DaemonClient(testSessionId);
			await client.connect();

			await client.startSession({
				sessionId: testSessionId,
				strategyPath: '/test/strategy.py',
				symbol: 'AAPL',
				timeframe: '1m',
				paper: true,
				riskLimits: {},
			});

			assert.strictEqual(mockDaemon.getSessionState(), 'running');
			client.disconnect();
		});

		test('session transitions to paused after pause', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const client = new DaemonClient(testSessionId);
			await client.connect();

			await client.pauseSession();

			assert.strictEqual(mockDaemon.getSessionState(), 'paused');
			client.disconnect();
		});

		test('session transitions back to running after resume', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const client = new DaemonClient(testSessionId);
			await client.connect();

			await client.resumeSession();

			assert.strictEqual(mockDaemon.getSessionState(), 'running');
			client.disconnect();
		});

		test('session transitions to stopped after stop', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const client = new DaemonClient(testSessionId);
			await client.connect();

			await client.stopSession();

			assert.strictEqual(mockDaemon.getSessionState(), 'stopped');
			client.disconnect();
		});
	});

	suite('Multiple Client Connections', function () {
		const { DaemonClient } = require('../../core/trading/DaemonClient');

		test('daemon handles multiple client connections', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const client1 = new DaemonClient(testSessionId);
			const client2 = new DaemonClient(testSessionId);

			await client1.connect();
			await client2.connect();

			// Both clients should be able to query
			const [health1, health2] = await Promise.all([
				client1.getHealth(),
				client2.getHealth(),
			]);

			assert.strictEqual(health1.status, 'healthy');
			assert.strictEqual(health2.status, 'healthy');

			client1.disconnect();
			client2.disconnect();
		});

		test('one client disconnect does not affect others', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const client1 = new DaemonClient(testSessionId);
			const client2 = new DaemonClient(testSessionId);

			await client1.connect();
			await client2.connect();

			// Disconnect client1
			client1.disconnect();

			// Client2 should still work
			const health = await client2.getHealth();
			assert.strictEqual(health.status, 'healthy');

			client2.disconnect();
		});
	});

	suite('Connection Recovery', function () {
		const { DaemonClient } = require('../../core/trading/DaemonClient');

		test('client can reconnect after disconnect', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const client = new DaemonClient(testSessionId);

			// First connection
			await client.connect();
			assert.strictEqual(client.isConnected(), true);

			// Disconnect
			client.disconnect();
			assert.strictEqual(client.isConnected(), false);

			// Reconnect
			await client.connect();
			assert.strictEqual(client.isConnected(), true);

			// Verify working
			const health = await client.getHealth();
			assert.strictEqual(health.status, 'healthy');

			client.disconnect();
		});
	});
});

suite('IPC Protocol Compliance', function () {
	this.timeout(10000);

	const testSessionId = 'protocol-test-' + Date.now();
	const socketPath = getSocketPath(testSessionId);
	const testToken = generateToken();
	let server: net.Server;
	let receivedMessages: JsonRpcMessage[] = [];
	const parser = new JsonRpcParser();

	suiteSetup(async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}
		if (!isTestFlagEnabled(process.env.RUN_TRADING_INTEGRATION)) {  // Megaudit-2 A6-MAJOR-3
			this.skip();
			return;
		}

		await fs.mkdir(path.dirname(socketPath), { recursive: true });
		await writeTokenFile(testSessionId, testToken);

		server = net.createServer((socket) => {
			let buffer: Buffer = Buffer.alloc(0);

			socket.on('data', (data) => {
				buffer = Buffer.concat([buffer, data as Buffer]) as Buffer;

				const { messages, remainder } = parser.unframeMessages(buffer);
				buffer = remainder as Buffer;

				for (const msg of messages) {
					receivedMessages.push(msg);

					// Send a response
					if (isJsonRpcRequest(msg)) {
						const response = parser.createSuccessResponse(msg.id, { ok: true });
						socket.write(parser.frameMessage(response));
					}
				}
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(socketPath, () => resolve());
		});
	});

	suiteTeardown(async function () {
		if (process.platform === 'win32') {
			return;
		}

		server?.close();
		await deleteTokenFile(testSessionId);
		try {
			await fs.unlink(socketPath);
		} catch {}
	});

	setup(function () {
		receivedMessages = [];
	});

	test('messages include jsonrpc version 2.0', async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		const { DaemonClient } = require('../../core/trading/DaemonClient');
		const client = new DaemonClient(testSessionId);

		await client.connect();
		await client.getHealth().catch(() => {}); // Ignore response mismatch

		assert.ok(receivedMessages.length > 0);
		for (const msg of receivedMessages) {
			assert.strictEqual(msg.jsonrpc, '2.0');
		}

		client.disconnect();
	});

	test('requests include method and id', async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		const { DaemonClient } = require('../../core/trading/DaemonClient');
		const client = new DaemonClient(testSessionId);

		await client.connect();
		await client.getPositions().catch(() => {});

		const requests = receivedMessages.filter(isJsonRpcRequest);
		assert.ok(requests.length > 0);

		for (const req of requests) {
			assert.ok(typeof req.method === 'string');
			assert.ok(req.id !== undefined);
		}

		client.disconnect();
	});

	test('requests include authentication', async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		const { DaemonClient } = require('../../core/trading/DaemonClient');
		const client = new DaemonClient(testSessionId);

		await client.connect();
		await client.getOrders().catch(() => {});

		const requests = receivedMessages.filter(isJsonRpcRequest);
		assert.ok(requests.length > 0);

		for (const req of requests) {
			const params = req.params as Record<string, unknown>;
			assert.ok(params?._auth, 'Request should include _auth');
			assert.ok((params._auth as any).token, 'Auth should include token');
			assert.ok((params._auth as any).sessionId, 'Auth should include sessionId');
		}

		client.disconnect();
	});
});
