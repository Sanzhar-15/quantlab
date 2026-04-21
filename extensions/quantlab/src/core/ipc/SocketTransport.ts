/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Socket Transport for daemon communication.
 *
 * Provides platform-aware socket connections:
 * - Linux/Mac: Unix sockets at ~/.quantlab/sessions/{id}.sock
 * - Windows: Named pipes at \\.\pipe\quantlab-{id}
 */

import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import type TypedEmitter from 'typed-emitter';
import { JsonRpcMessage, ConnectionState } from './types';
import { JsonRpcParser } from './JsonRpcParser';

/**
 * Transport options.
 */
export interface SocketTransportOptions {
	reconnectOnClose?: boolean;
	reconnectDelayMs?: number;
	maxReconnectAttempts?: number;
	connectTimeoutMs?: number;
}

/**
 * Default transport options.
 */
const DEFAULT_OPTIONS: Required<SocketTransportOptions> = {
	reconnectOnClose: true,
	reconnectDelayMs: 1000,
	maxReconnectAttempts: 5,
	connectTimeoutMs: 10000,
};

/**
 * Transport events interface for TypedEmitter.
 */
interface SocketTransportEvents {
	connect: () => void;
	disconnect: () => void;
	error: (error: Error) => void;
	message: (message: JsonRpcMessage) => void;
	stateChange: (state: ConnectionState) => void;
	[key: string]: (...args: any[]) => void;
}

/**
 * Socket transport for IPC communication.
 */
export class SocketTransport extends (EventEmitter as new () => TypedEmitter<SocketTransportEvents>) {
	private readonly socketPath: string;
	private readonly options: Required<SocketTransportOptions>;
	private readonly parser: JsonRpcParser;

	private socket: net.Socket | null = null;
	private receiveBuffer: Buffer = Buffer.alloc(0);
	private state: ConnectionState = 'disconnected';
	private reconnectAttempts = 0;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private connectTimeout: NodeJS.Timeout | null = null;

	constructor(sessionId: string, options: SocketTransportOptions = {}) {
		super();
		this.options = { ...DEFAULT_OPTIONS, ...options };
		this.parser = new JsonRpcParser();
		this.socketPath = this.getSocketPath(sessionId);
	}

	/**
	 * Get the platform-appropriate socket path.
	 */
	private getSocketPath(sessionId: string): string {
		if (process.platform === 'win32') {
			// Windows: Named pipe
			return `\\\\.\\pipe\\quantlab-${sessionId}`;
		} else {
			// Linux/Mac: Unix socket
			return path.join(os.homedir(), '.quantlab', 'sessions', `${sessionId}.sock`);
		}
	}

	/**
	 * Get current connection state.
	 */
	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return this.state === 'connected';
	}

	/**
	 * Connect to the daemon socket.
	 */
	async connect(): Promise<void> {
		if (this.state === 'connected' || this.state === 'connecting') {
			return;
		}

		this.setState('connecting');

		return new Promise((resolve, reject) => {
			let settled = false;
			const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

			this.socket = new net.Socket();

			// Set up timeout
			this.connectTimeout = setTimeout(() => {
				if (this.state === 'connecting') {
					const error = new Error(`Connection timeout after ${this.options.connectTimeoutMs}ms`);
					this.socket?.destroy();
					settle(() => reject(error));
				}
			}, this.options.connectTimeoutMs);

			// Handle connection
			this.socket.on('connect', () => {
				this.clearConnectTimeout();
				this.setState('connected');
				this.reconnectAttempts = 0;
				this.emit('connect');
				settle(() => resolve());
			});

			// Handle data
			this.socket.on('data', (data: Buffer) => {
				this.handleData(data);
			});

			// Handle errors
			this.socket.on('error', (error: Error) => {
				this.clearConnectTimeout();
				this.emit('error', error);
				settle(() => reject(error));
			});

			// Handle close
			this.socket.on('close', (hadError: boolean) => {
				this.handleClose(hadError);
			});

			// Connect
			this.socket.connect(this.socketPath);
		});
	}

	/**
	 * Disconnect from the daemon.
	 */
	disconnect(): void {
		this.cancelReconnect();
		this.clearConnectTimeout();
		this.receiveBuffer = Buffer.alloc(0);

		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}

		this.setState('disconnected');
		this.emit('disconnect');
	}

	/**
	 * Send data to the daemon.
	 */
	async send(data: Buffer): Promise<void> {
		if (!this.socket || this.state !== 'connected') {
			throw new Error('Not connected');
		}

		return new Promise((resolve, reject) => {
			this.socket!.write(data, (error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Send a JSON-RPC message.
	 */
	async sendMessage(message: JsonRpcMessage): Promise<void> {
		const framed = this.parser.frameMessage(message);
		await this.send(framed);
	}

	/**
	 * Handle incoming data.
	 */
	private handleData(data: Buffer): void {
		// Append to receive buffer
		this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

		// Try to parse complete messages
		try {
			const { messages, remainder } = this.parser.unframeMessages(this.receiveBuffer);
			this.receiveBuffer = remainder;

			for (const message of messages) {
				this.emit('message', message);
			}
		} catch (error) {
			// Clear corrupted buffer to prevent repeated parse failures
			this.receiveBuffer = Buffer.alloc(0);
			this.emit('error', error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * Handle socket close.
	 */
	private handleClose(_hadError: boolean): void {
		this.socket = null;
		this.receiveBuffer = Buffer.alloc(0);

		if (this.state === 'disconnected') {
			return; // Intentional disconnect
		}

		this.setState('disconnected');
		this.emit('disconnect');

		// Attempt reconnection if enabled
		if (this.options.reconnectOnClose && this.reconnectAttempts < this.options.maxReconnectAttempts) {
			this.scheduleReconnect();
		}
	}

	/**
	 * Schedule a reconnection attempt.
	 */
	private scheduleReconnect(): void {
		this.cancelReconnect(); // prevent leaked timer if called while one is pending
		this.reconnectAttempts++;
		this.setState('reconnecting');

		const delay = this.options.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

		this.reconnectTimer = setTimeout(async () => {
			try {
				await this.connect();
			} catch (error) {
				// Connection failed, handleClose will schedule another attempt
			}
		}, delay);
	}

	/**
	 * Cancel any pending reconnection.
	 */
	private cancelReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/**
	 * Clear the connect timeout.
	 */
	private clearConnectTimeout(): void {
		if (this.connectTimeout) {
			clearTimeout(this.connectTimeout);
			this.connectTimeout = null;
		}
	}

	/**
	 * Update connection state.
	 */
	private setState(newState: ConnectionState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.emit('stateChange', newState);
		}
	}
}

/**
 * Get the socket path for a session.
 */
export function getSocketPath(sessionId: string): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\quantlab-${sessionId}`;
	}
	return path.join(os.homedir(), '.quantlab', 'sessions', `${sessionId}.sock`);
}

/**
 * Check if a socket exists.
 */
export async function socketExists(sessionId: string): Promise<boolean> {
	const socketPath = getSocketPath(sessionId);

	if (process.platform === 'win32') {
		// On Windows, try to connect briefly
		return new Promise((resolve) => {
			const socket = new net.Socket();
			socket.on('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('error', () => {
				resolve(false);
			});
			socket.connect(socketPath);
			setTimeout(() => {
				socket.destroy();
				resolve(false);
			}, 100);
		});
	} else {
		// On Unix, check if file exists
		const fs = await import('fs/promises');
		try {
			await fs.access(socketPath);
			return true;
		} catch {
			return false;
		}
	}
}
