/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import {
	SocketTransport,
	getSocketPath,
	socketExists,
} from '../../core/ipc/SocketTransport';
import { JsonRpcParser } from '../../core/ipc/JsonRpcParser';

suite('SocketTransport', () => {
	const testSessionId = 'socket-test-' + Date.now();
	const testDir = path.join(os.homedir(), '.quantlab', 'sessions');
	let mockServer: net.Server | null = null;
	let transport: SocketTransport | null = null;

	suiteSetup(async () => {
		// Ensure test directory exists
		await fs.mkdir(testDir, { recursive: true });
	});

	teardown(async () => {
		// Clean up transport
		if (transport) {
			transport.disconnect();
			transport = null;
		}

		// Clean up mock server
		if (mockServer) {
			mockServer.close();
			mockServer = null;
		}

		// Clean up socket file
		const socketPath = getSocketPath(testSessionId);
		try {
			await fs.unlink(socketPath);
		} catch {
			// Ignore
		}
	});

	suite('constructor and state', () => {
		test('initializes in disconnected state', () => {
			transport = new SocketTransport(testSessionId);

			assert.strictEqual(transport.getState(), 'disconnected');
			assert.strictEqual(transport.isConnected(), false);
		});
	});

	suite('connect', () => {
		test('connects to mock server', async function () {
			// Skip on Windows for now (named pipes are tricky in tests)
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);

			// Start mock server
			mockServer = net.createServer();
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			// Connect transport
			transport = new SocketTransport(testSessionId, {
				reconnectOnClose: false,
				connectTimeoutMs: 5000,
			});

			let connectedEmitted = false;
			transport.on('connect', () => {
				connectedEmitted = true;
			});

			await transport.connect();

			assert.strictEqual(transport.getState(), 'connected');
			assert.strictEqual(transport.isConnected(), true);
			assert.strictEqual(connectedEmitted, true);
		});

		test('emits stateChange events', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);

			mockServer = net.createServer();
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });

			const states: string[] = [];
			transport.on('stateChange', (state) => {
				states.push(state);
			});

			await transport.connect();

			assert.ok(states.includes('connecting'));
			assert.ok(states.includes('connected'));
		});

		test('times out on connection failure', async function () {
			this.timeout(3000);

			const tempSessionId = 'nonexistent-' + Date.now();
			transport = new SocketTransport(tempSessionId, {
				reconnectOnClose: false,
				connectTimeoutMs: 500,
			});

			// Add error handler to prevent uncaught exceptions
			transport.on('error', () => {
				// Expected error, ignore
			});

			try {
				await transport.connect();
				assert.fail('Should have thrown');
			} catch (error) {
				// Either timeout or connection refused is acceptable
				assert.ok(error instanceof Error);
			}
		});

		test('does not reconnect if already connected', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);

			mockServer = net.createServer();
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });

			await transport.connect();

			// Second connect should be a no-op
			await transport.connect();

			assert.strictEqual(transport.isConnected(), true);
		});
	});

	suite('disconnect', () => {
		test('disconnects from server', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);

			mockServer = net.createServer();
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });
			await transport.connect();

			let disconnectEmitted = false;
			transport.on('disconnect', () => {
				disconnectEmitted = true;
			});

			transport.disconnect();

			assert.strictEqual(transport.getState(), 'disconnected');
			assert.strictEqual(transport.isConnected(), false);
			assert.strictEqual(disconnectEmitted, true);
		});
	});

	suite('send', () => {
		test('throws when not connected', async () => {
			transport = new SocketTransport(testSessionId);

			try {
				await transport.send(Buffer.from('test'));
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok((error as Error).message.includes('Not connected'));
			}
		});

		test('sends data to server', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);
			const receivedData: Buffer[] = [];

			mockServer = net.createServer((socket) => {
				socket.on('data', (data) => {
					receivedData.push(data);
				});
			});
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });
			await transport.connect();

			const testData = Buffer.from('hello world');
			await transport.send(testData);

			// Wait for data to be received
			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.strictEqual(receivedData.length, 1);
			assert.ok(receivedData[0].equals(testData));
		});
	});

	suite('sendMessage', () => {
		test('sends framed JSON-RPC message', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);
			const receivedData: Buffer[] = [];
			const parser = new JsonRpcParser();

			mockServer = net.createServer((socket) => {
				socket.on('data', (data) => {
					receivedData.push(data);
				});
			});
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });
			await transport.connect();

			const message = {
				jsonrpc: '2.0' as const,
				method: 'test.method',
				params: { foo: 'bar' },
				id: 'req-1',
			};
			await transport.sendMessage(message);

			// Wait for data to be received
			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.strictEqual(receivedData.length, 1);

			// Parse the received framed message
			const { messages } = parser.unframeMessages(receivedData[0]);
			assert.strictEqual(messages.length, 1);
			assert.deepStrictEqual(messages[0], message);
		});
	});

	suite('message handling', () => {
		test('emits message event for incoming data', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);
			const parser = new JsonRpcParser();
			let serverSocket: net.Socket | null = null;

			mockServer = net.createServer((socket) => {
				serverSocket = socket;
			});
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });

			const receivedMessages: any[] = [];
			transport.on('message', (message) => {
				receivedMessages.push(message);
			});

			await transport.connect();

			// Wait for server to accept connection
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Server sends a message
			const message = {
				jsonrpc: '2.0' as const,
				method: 'positions.update',
				params: { positions: [] },
			};
			const framed = parser.frameMessage(message);
			serverSocket!.write(framed);

			// Wait for message to be received
			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.strictEqual(receivedMessages.length, 1);
			assert.deepStrictEqual(receivedMessages[0], message);
		});

		test('handles multiple messages in single data event', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);
			const parser = new JsonRpcParser();
			let serverSocket: net.Socket | null = null;

			mockServer = net.createServer((socket) => {
				serverSocket = socket;
			});
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });

			const receivedMessages: any[] = [];
			transport.on('message', (message) => {
				receivedMessages.push(message);
			});

			await transport.connect();
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Server sends multiple messages at once
			const msg1 = { jsonrpc: '2.0' as const, method: 'msg1' };
			const msg2 = { jsonrpc: '2.0' as const, method: 'msg2' };
			const combined = Buffer.concat([
				parser.frameMessage(msg1),
				parser.frameMessage(msg2),
			]);
			serverSocket!.write(combined);

			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.strictEqual(receivedMessages.length, 2);
			assert.strictEqual(receivedMessages[0].method, 'msg1');
			assert.strictEqual(receivedMessages[1].method, 'msg2');
		});

		test('handles partial messages across data events', async function () {
			if (process.platform === 'win32') {
				this.skip();
				return;
			}

			const socketPath = getSocketPath(testSessionId);
			const parser = new JsonRpcParser();
			let serverSocket: net.Socket | null = null;

			mockServer = net.createServer((socket) => {
				serverSocket = socket;
			});
			await new Promise<void>((resolve) => {
				mockServer!.listen(socketPath, () => resolve());
			});

			transport = new SocketTransport(testSessionId, { reconnectOnClose: false });

			const receivedMessages: any[] = [];
			transport.on('message', (message) => {
				receivedMessages.push(message);
			});

			await transport.connect();
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Server sends a message in two parts
			const message = { jsonrpc: '2.0' as const, method: 'split.message', id: 1 };
			const framed = parser.frameMessage(message);
			const half = Math.floor(framed.length / 2);

			serverSocket!.write(framed.subarray(0, half));
			await new Promise((resolve) => setTimeout(resolve, 50));
			serverSocket!.write(framed.subarray(half));
			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.strictEqual(receivedMessages.length, 1);
			assert.deepStrictEqual(receivedMessages[0], message);
		});
	});
});

suite('getSocketPath', () => {
	test('returns Unix socket path on non-Windows', function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		const socketPath = getSocketPath('test-session');
		const expected = path.join(os.homedir(), '.quantlab', 'sessions', 'test-session.sock');

		assert.strictEqual(socketPath, expected);
	});

	test('returns named pipe path on Windows', function () {
		if (process.platform !== 'win32') {
			this.skip();
			return;
		}

		const socketPath = getSocketPath('test-session');
		assert.strictEqual(socketPath, '\\\\.\\pipe\\quantlab-test-session');
	});
});

suite('socketExists', () => {
	const testSessionId = 'exists-test-' + Date.now();

	test('returns false for nonexistent socket', async () => {
		const exists = await socketExists('nonexistent-' + Date.now());
		assert.strictEqual(exists, false);
	});

	test('returns true for existing socket', async function () {
		if (process.platform === 'win32') {
			this.skip();
			return;
		}

		const socketPath = getSocketPath(testSessionId);
		const testDir = path.dirname(socketPath);

		// Ensure directory exists
		await fs.mkdir(testDir, { recursive: true });

		// Create a mock server
		const server = net.createServer();
		await new Promise<void>((resolve) => {
			server.listen(socketPath, () => resolve());
		});

		try {
			const exists = await socketExists(testSessionId);
			assert.strictEqual(exists, true);
		} finally {
			server.close();
			try {
				await fs.unlink(socketPath);
			} catch {
				// Ignore
			}
		}
	});
});
