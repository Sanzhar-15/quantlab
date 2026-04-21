/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Daemon Client for trading session communication.
 *
 * Provides a high-level API for communicating with the Python trading daemon
 * over the IPC layer.
 */

import { EventEmitter } from 'events';
import type TypedEmitter from 'typed-emitter';
import {
	SocketTransport,
	JsonRpcParser,
	TokenAuth,
	RetryHandler,
	MessageBuffer,
	getTierForMethod,
	JsonRpcMessage,
	JsonRpcSuccessResponse,
	JsonRpcErrorResponse,
	isJsonRpcSuccessResponse,
	isJsonRpcErrorResponse,
	isJsonRpcNotification,
	SessionConfig,
	SessionStartResponse,
	DaemonPosition,
	DaemonOrder,
	DaemonFill,
	RiskAlert,
	DaemonHealth,
	OrderRequest,
	ConnectionState,
	SchemaAdapter,
} from '../ipc';

/**
 * Pending request tracking.
 */
interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	method: string;
	bufferId?: string; // undefined for internal handshake requests (authenticate, negotiate)
}

/**
 * Daemon client events.
 */
interface DaemonClientEvents {
	'connect': () => void;
	'disconnect': () => void;
	'error': (error: Error) => void;
	'positions.update': (positions: DaemonPosition[]) => void;
	'orders.update': (orders: DaemonOrder[]) => void;
	'fills.update': (fills: DaemonFill[]) => void;
	'heartbeat': (health: DaemonHealth) => void;
	'risk.alert': (alert: RiskAlert) => void;
	'state.change': (state: ConnectionState) => void;
	[key: string]: (...args: any[]) => void;
}

/**
 * Daemon client configuration.
 */
export interface DaemonClientConfig {
	requestTimeoutMs?: number;
	heartbeatIntervalMs?: number;
	maxPendingRequests?: number;
	/** Enable automatic reconnection on disconnect */
	autoReconnect?: boolean;
	/** Maximum number of reconnection attempts (0 = unlimited) */
	maxReconnectAttempts?: number;
	/** Exponential backoff delays in milliseconds */
	reconnectDelays?: number[];
}

/**
 * Default client configuration.
 */
const DEFAULT_CONFIG: Required<DaemonClientConfig> = {
	requestTimeoutMs: 30000,
	heartbeatIntervalMs: 5000,
	maxPendingRequests: 100,
	autoReconnect: true,
	maxReconnectAttempts: 0,  // Unlimited
	reconnectDelays: [1000, 2000, 4000, 8000, 16000, 30000],  // Exponential backoff
};

/**
 * Client for communicating with the Python trading daemon.
 */
export class DaemonClient extends (EventEmitter as new () => TypedEmitter<DaemonClientEvents>) {
	private readonly sessionId: string;
	private readonly config: Required<DaemonClientConfig>;
	private readonly transport: SocketTransport;
	private readonly parser: JsonRpcParser;
	private readonly auth: TokenAuth;
	private readonly retry: RetryHandler;
	private readonly buffer: MessageBuffer;

	private readonly pendingRequests: Map<string | number, PendingRequest> = new Map();
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private connected: boolean = false;
	private protocolVersion: string = '1.0';  // Negotiated protocol version

	// Auto-reconnection state
	private reconnectAttempts: number = 0;
	private reconnecting: boolean = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private intentionalDisconnect: boolean = false;

	// NEW-IPC-001: Sequence tracking for gap detection
	private lastSequence: number = 0;

	/** Supported protocol versions (client-side) */
	private static readonly SUPPORTED_VERSIONS = ['1.0'];

	constructor(sessionId: string, config: DaemonClientConfig = {}) {
		super();
		this.sessionId = sessionId;
		this.config = { ...DEFAULT_CONFIG, ...config };

		this.transport = new SocketTransport(sessionId);
		this.parser = new JsonRpcParser();
		this.auth = new TokenAuth(sessionId);
		this.retry = new RetryHandler();
		this.buffer = new MessageBuffer();

		this.setupTransportEvents();
	}

	/**
	 * Get the session ID.
	 */
	getSessionId(): string {
		return this.sessionId;
	}

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Connect to the daemon.
	 *
	 * Connection flow (FIX-CGP-001):
	 * 1. Establish socket connection
	 * 2. Send protocol version negotiation
	 * 3. Send explicit authenticate message with token
	 * 4. Process state snapshot from auth response
	 */
	async connect(): Promise<void> {
		// Reset reconnection state
		this.intentionalDisconnect = false;
		this.reconnectAttempts = 0;
		this.reconnecting = false;

		await this.retry.retry(async () => {
			await this.transport.connect();
		});

		// Protocol version negotiation (per IPC Protocol spec)
		try {
			const negotiateResult = await this.negotiate();
			this.protocolVersion = negotiateResult.protocolVersion || '1.0';
			console.log(`Protocol negotiated: v${this.protocolVersion}`);
		} catch (error) {
			// Fallback if server doesn't support negotiate (backward compatibility)
			console.warn('Protocol negotiation failed, using default version 1.0:', error);
			this.protocolVersion = '1.0';
		}

		// FIX-CGP-001: Send explicit authenticate message after negotiate.
		// The daemon expects an "authenticate" or "auth" message with {token} in params
		// before accepting any other requests.
		const token = await this.auth.getToken();
		let authResult: { status: string; protocolVersion?: string; sessionId?: string };
		try {
			authResult = await this.authenticateHandshake(token);
		} catch (error) {
			this.transport.disconnect(); // clean up the socket so no ghost reconnect loop
			throw error;
		}
		if (authResult.status !== 'authenticated') {
			this.transport.disconnect();
			throw new Error(`Authentication failed: ${JSON.stringify(authResult)}`);
		}

		this.connected = true;
		this.startHeartbeat();
		this.emit('connect');
	}

	/**
	 * Send explicit authenticate handshake to daemon (FIX-CGP-001).
	 *
	 * This is separate from per-request TokenAuth — it's the initial handshake
	 * required by the daemon before any other messages are accepted.
	 */
	private async authenticateHandshake(token: string): Promise<{ status: string; protocolVersion?: string; sessionId?: string }> {
		const id = this.parser.generateId();
		const request = this.parser.createRequest('authenticate', { token }, id);

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error('Authentication handshake timeout'));
			}, 10000);

			this.pendingRequests.set(id, {
				resolve: resolve as (result: unknown) => void,
				reject,
				timeout,
				method: 'authenticate',
			});

			this.transport.sendMessage(request).catch(error => {
				clearTimeout(timeout);
				this.pendingRequests.delete(id);
				reject(error);
			});
		});
	}

	/**
	 * Negotiate protocol version with daemon.
	 *
	 * @returns Negotiation result with selected protocol version
	 */
	private async negotiate(): Promise<{ protocolVersion: string; serverVersions: string[] }> {
		const id = this.parser.generateId();
		const request = this.parser.createRequest('negotiate', {
			supportedVersions: DaemonClient.SUPPORTED_VERSIONS,
			clientVersion: '1.0.0',
		}, id);

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error('Negotiate timeout'));
			}, 5000);  // 5 second timeout for negotiation

			this.pendingRequests.set(id, {
				resolve: resolve as (result: unknown) => void,
				reject,
				timeout,
				method: 'negotiate',
			});

			this.transport.sendMessage(request).catch(error => {
				clearTimeout(timeout);
				this.pendingRequests.delete(id);
				reject(error);
			});
		});
	}

	/**
	 * Get the negotiated protocol version.
	 */
	getProtocolVersion(): string {
		return this.protocolVersion;
	}

	/**
	 * Disconnect from the daemon.
	 *
	 * @param intentional If true, disables auto-reconnection
	 */
	disconnect(intentional: boolean = true): void {
		this.intentionalDisconnect = intentional;
		this.stopHeartbeat();
		this.stopReconnect();
		this.transport.disconnect();
		this.connected = false;

		// Reject all pending requests
		for (const [_id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Disconnected'));
		}
		this.pendingRequests.clear();

		this.emit('disconnect');
	}

	/**
	 * Stop any pending reconnection attempt.
	 */
	private stopReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnecting = false;
		this.reconnectAttempts = 0;
	}

	/**
	 * Attempt to reconnect with exponential backoff.
	 */
	private async attemptReconnect(): Promise<void> {
		if (!this.config.autoReconnect || this.intentionalDisconnect) {
			return;
		}

		if (this.reconnecting) {
			return;  // Already reconnecting
		}

		if (this.config.maxReconnectAttempts > 0 &&
			this.reconnectAttempts >= this.config.maxReconnectAttempts) {
			console.error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
			this.emit('error', new Error('Max reconnect attempts reached'));
			return;
		}

		this.reconnecting = true;

		// Calculate delay using exponential backoff
		const delays = this.config.reconnectDelays;
		const delayIndex = Math.min(this.reconnectAttempts, delays.length - 1);
		const delay = delays[delayIndex];

		console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})...`);

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectAttempts++;

			try {
				await this.transport.connect();

				// Re-negotiate protocol
				try {
					const negotiateResult = await this.negotiate();
					this.protocolVersion = negotiateResult.protocolVersion || '1.0';
				} catch {
					// Fallback if negotiation fails
					this.protocolVersion = '1.0';
				}

				// Re-authenticate — daemon requires auth handshake before accepting any requests
				const token = await this.auth.getToken();
				let authResult: { status: string };
				try {
					authResult = await this.authenticateHandshake(token);
				} catch (error) {
					this.transport.disconnect();
					throw error;
				}
				if (authResult.status !== 'authenticated') {
					this.transport.disconnect();
					throw new Error(`Re-authentication failed: ${JSON.stringify(authResult)}`);
				}

				// Success!
				this.connected = true;
				this.reconnecting = false;
				this.reconnectAttempts = 0;
				this.startHeartbeat();
				this.emit('connect');
				console.log('Reconnected to daemon');

			} catch (error) {
				console.error('Reconnect attempt failed:', error);
				this.reconnecting = false;

				// Schedule next attempt via a new timer (do not recurse — would defeat reconnecting guard)
				if (!this.intentionalDisconnect) {
					this.reconnectTimer = setTimeout(() => this.attemptReconnect(), 0);
				}
			}
		}, delay);
	}

	/**
	 * Start a trading session.
	 */
	async startSession(config: SessionConfig): Promise<SessionStartResponse> {
		return this.request<SessionStartResponse>('session.start', config);
	}

	/**
	 * Stop the trading session.
	 */
	async stopSession(): Promise<void> {
		await this.request('session.stop', { sessionId: this.sessionId });
	}

	/**
	 * Pause the trading session.
	 */
	async pauseSession(): Promise<void> {
		await this.request('session.pause', { sessionId: this.sessionId });
	}

	/**
	 * Resume the trading session.
	 */
	async resumeSession(): Promise<void> {
		await this.request('session.resume', { sessionId: this.sessionId });
	}

	/**
	 * Submit an order.
	 */
	async submitOrder(order: OrderRequest): Promise<string> {
		const result = await this.request<{ orderId: string; status: string; error?: string }>('order.submit', order);
		if (result.error) {
			throw new Error(result.error);
		}
		return result.orderId;
	}

	/**
	 * Cancel an order.
	 */
	async cancelOrder(orderId: string): Promise<void> {
		await this.request('order.cancel', { orderId });
	}

	/**
	 * Flatten all positions.
	 */
	async flattenPositions(): Promise<void> {
		await this.request('flatten.all', { sessionId: this.sessionId });
	}

	/**
	 * Get current positions.
	 */
	async getPositions(): Promise<DaemonPosition[]> {
		return this.request<DaemonPosition[]>('positions.get', { sessionId: this.sessionId });
	}

	/**
	 * Get open orders.
	 */
	async getOrders(): Promise<DaemonOrder[]> {
		return this.request<DaemonOrder[]>('orders.get', { sessionId: this.sessionId });
	}

	/**
	 * Get session health status.
	 */
	async getHealth(): Promise<DaemonHealth> {
		return this.request<DaemonHealth>('health.check', { sessionId: this.sessionId });
	}

	/**
	 * Get session status.
	 */
	async getStatus(): Promise<{ state: string; uptime: number; brokerConnected: boolean }> {
		return this.request('status.get', { sessionId: this.sessionId });
	}

	/**
	 * Get broker credentials from daemon's SecretsManager.
	 *
	 * This retrieves credential availability from the daemon, which handles
	 * the fallback chain (env vars → encrypted file).
	 *
	 * @param broker - Broker identifier (e.g., 'alpaca')
	 * @returns Credential info (keys available, not actual values)
	 */
	async getCredentials(broker: string): Promise<{
		broker: string;
		available_keys?: string[];
		has_credentials?: boolean;
		error?: string;
		hint?: string;
	}> {
		return this.request('credentials.get', { broker });
	}

	/**
	 * Get credentials status for all known brokers.
	 *
	 * Returns information about which credential sources are available
	 * without revealing actual credential values.
	 */
	async getCredentialsStatus(): Promise<{
		env_secret_count: number;
		legacy_env_count: number;
		brokers: Record<string, { configured: boolean; keys: string[] }>;
	}> {
		return this.request('credentials.status', {});
	}

	/**
	 * Trigger position reconciliation between local tracking and broker.
	 *
	 * Compares positions tracked locally with actual positions at the broker
	 * and identifies discrepancies.
	 *
	 * @param autoCorrect - If true, automatically apply corrections
	 * @returns Reconciliation result with discrepancies
	 */
	async triggerReconciliation(autoCorrect: boolean = false): Promise<{
		sessionId: string;
		timestamp: string;
		isReconciled: boolean;
		discrepancyCount: number;
		discrepancies: Array<{
			symbol: string;
			discrepancyType: string;
			localQuantity: string | null;
			brokerQuantity: string | null;
			localAvgCost: string | null;
			brokerAvgCost: string | null;
			recommendedAction: string;
			details: string;
		}>;
		warnings: string[];
		correctionsApplied: string[];
		error?: string;
	}> {
		return this.request('reconciliation.trigger', { auto_correct: autoCorrect });
	}

	/**
	 * Get the status of the last reconciliation.
	 *
	 * @returns Last reconciliation result or status indicating no reconciliation run
	 */
	async getReconciliationStatus(): Promise<{
		sessionId?: string;
		timestamp?: string;
		isReconciled?: boolean;
		discrepancyCount?: number;
		discrepancies?: Array<{
			symbol: string;
			discrepancyType: string;
			localQuantity: string | null;
			brokerQuantity: string | null;
			recommendedAction: string;
		}>;
		status?: string;
		message?: string;
	}> {
		return this.request('reconciliation.status', {});
	}

	/**
	 * Apply corrections from the last reconciliation result.
	 *
	 * Syncs local position tracking to match broker state.
	 *
	 * @returns Status of correction application
	 */
	async applyReconciliation(): Promise<{
		status: string;
		corrections_applied?: number;
		message?: string;
		error?: string;
		hint?: string;
	}> {
		return this.request('reconciliation.apply', {});
	}

	/**
	 * Check if software updates are allowed.
	 *
	 * Updates are blocked during active trading to prevent surprise behavior.
	 */
	async checkUpdateAllowed(): Promise<{
		allowed: boolean;
		reason: string;
		state?: string;
		positions?: number;
		pending_orders?: number;
	}> {
		return this.request('update.check_allowed', {});
	}

	/**
	 * Set credentials for a broker via IPC.
	 */
	async setCredentials(broker: string, credentials: Record<string, string>): Promise<{ success: boolean }> {
		return this.request('credentials.set', { broker, credentials });
	}

	/**
	 * Send a JSON-RPC request and wait for response.
	 */
	private async request<T>(method: string, params?: unknown): Promise<T> {
		if (!this.connected) {
			throw new Error('Not connected');
		}

		if (this.pendingRequests.size >= this.config.maxPendingRequests) {
			throw new Error('Too many pending requests');
		}

		const id = this.parser.generateId();
		let request = this.parser.createRequest(method, params, id);

		// Authenticate the request
		request = await this.auth.authenticate(request);

		// Buffer for retry if needed — store buffer ID for ACK removal
		const tier = getTierForMethod(method);
		const bufferId = this.buffer.enqueue(request, tier, tier === 'critical');

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				this.buffer.removeById(bufferId);
				reject(new Error(`Request timeout: ${method}`));
			}, this.config.requestTimeoutMs);

			this.pendingRequests.set(id, {
				resolve: resolve as (result: unknown) => void,
				reject,
				timeout,
				method,
				bufferId,
			});

			// Send via transport
			this.transport.sendMessage(request).catch(error => {
				clearTimeout(timeout);
				this.pendingRequests.delete(id);
				this.buffer.removeById(bufferId);
				reject(error);
			});
		});
	}

	/**
	 * Send a notification (no response expected).
	 */
	async notify(method: string, params?: unknown): Promise<void> {
		if (!this.connected) {
			throw new Error('Not connected');
		}

		const notification = this.parser.createNotification(method, params);
		await this.transport.sendMessage(notification);
	}

	/**
	 * Setup transport event handlers.
	 */
	private setupTransportEvents(): void {
		this.transport.on('message', (message) => this.handleMessage(message));

		this.transport.on('error', (error) => {
			this.emit('error', error);
		});

		this.transport.on('disconnect', () => {
			const wasConnected = this.connected;
			this.connected = false;
			this.stopHeartbeat();

			// Reject all pending requests immediately so callers get fast feedback
			// and request slots are freed before reconnect
			for (const [_id, pending] of this.pendingRequests) {
				clearTimeout(pending.timeout);
				pending.reject(new Error('Connection lost'));
			}
			this.pendingRequests.clear();

			this.emit('disconnect');

			// Auto-reconnect if enabled and this wasn't an intentional disconnect
			if (wasConnected && !this.intentionalDisconnect && this.config.autoReconnect) {
				this.attemptReconnect();
			}
		});

		this.transport.on('stateChange', (state) => {
			this.emit('state.change', state);
		});
	}

	/**
	 * Handle incoming message from daemon.
	 */
	private handleMessage(message: JsonRpcMessage): void {
		// Handle responses
		if (isJsonRpcSuccessResponse(message)) {
			this.handleResponse(message);
			return;
		}

		if (isJsonRpcErrorResponse(message)) {
			this.handleErrorResponse(message);
			return;
		}

		// Handle notifications from daemon
		if (isJsonRpcNotification(message)) {
			this.handleNotification(message);
			return;
		}
	}

	/**
	 * Handle success response.
	 */
	private handleResponse(response: JsonRpcSuccessResponse): void {
		// CODEX-008: Handle state snapshot with id=null.
		// After auth, the daemon sends a state_snapshot as a response with id=null.
		// Route it as a notification-style event rather than matching to a pending request.
		if (response.id === null || response.id === undefined) {
			const result = response.result as Record<string, unknown> | undefined;
			if (result?.type === 'state_snapshot') {
				this.handleStateSnapshot(result);
			}
			return;
		}

		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			return; // Unknown request
		}

		clearTimeout(pending.timeout);
		this.pendingRequests.delete(response.id);

		// Remove from buffer (ACK received) using the buffer's own ID (undefined for handshake requests)
		if (pending.bufferId) {
			this.buffer.removeById(pending.bufferId);
		}

		pending.resolve(response.result);
	}

	/**
	 * Handle state snapshot from daemon (CODEX-008).
	 *
	 * Sent after auth with id=null. Contains current positions, orders,
	 * performance, and connection status for initial sync.
	 */
	private handleStateSnapshot(snapshot: Record<string, unknown>): void {
		const positions = snapshot.positions as DaemonPosition[] | undefined;
		const orders = snapshot.orders as DaemonOrder[] | undefined;

		if (positions && Array.isArray(positions)) {
			this.emit('positions.update', positions);
		}
		if (orders && Array.isArray(orders)) {
			this.emit('orders.update', orders);
		}
	}

	/**
	 * Handle error response.
	 */
	private handleErrorResponse(response: JsonRpcErrorResponse): void {
		const id = response.id;
		if (id === null) {
			// Parse error, no specific request
			this.emit('error', new Error(response.error.message));
			return;
		}

		const pending = this.pendingRequests.get(id);
		if (!pending) {
			return;
		}

		clearTimeout(pending.timeout);
		this.pendingRequests.delete(id);

		const error = new Error(`${response.error.message} (code: ${response.error.code})`);
		pending.reject(error);
	}

	/**
	 * Handle notification from daemon.
	 *
	 * FIX-CGP-003: Convert snake_case params from daemon to camelCase via SchemaAdapter.
	 * NEW-IPC-001: Track _meta.sequence for gap detection.
	 */
	private handleNotification(notification: { method: string; params?: unknown; _meta?: { sequence?: number } }): void {
		// NEW-IPC-001: Track sequence numbers for gap detection
		const meta = (notification as Record<string, unknown>)._meta as { sequence?: number } | undefined;
		if (meta?.sequence !== undefined) {
			const expected = this.lastSequence + 1;
			if (this.lastSequence > 0 && meta.sequence > expected) {
				console.warn(`IPC sequence gap: expected ${expected}, got ${meta.sequence} (${meta.sequence - expected} messages missed)`);
			}
			this.lastSequence = meta.sequence;
		}

		// Convert daemon snake_case params to camelCase
		const rawParams = notification.params as Record<string, unknown> | undefined;
		const params = rawParams ? SchemaAdapter.fromDaemon<Record<string, unknown>>(rawParams) : undefined;

		switch (notification.method) {
			case 'positions.update':
				this.emit('positions.update', params?.positions as DaemonPosition[] ?? []);
				break;

			case 'orders.update':
				this.emit('orders.update', params?.orders as DaemonOrder[] ?? []);
				break;

			case 'fills.update':
				this.emit('fills.update', params?.fills as DaemonFill[] ?? []);
				break;

			case 'heartbeat':
				this.emit('heartbeat', params as unknown as DaemonHealth);
				break;

			case 'risk.alert':
				this.emit('risk.alert', params as unknown as RiskAlert);
				break;

			default:
				// Unknown notification type
				break;
		}
	}

	/**
	 * Start heartbeat polling.
	 */
	private startHeartbeat(): void {
		this.stopHeartbeat();

		this.heartbeatTimer = setInterval(async () => {
			try {
				const health = await this.getHealth();
				this.emit('heartbeat', health);
			} catch (error) {
				// Heartbeat failed, might be disconnected
				this.emit('error', error instanceof Error ? error : new Error(String(error)));
			}
		}, this.config.heartbeatIntervalMs);
	}

	/**
	 * Stop heartbeat polling.
	 */
	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}
}

/**
 * Create a daemon client for a session.
 */
export function createDaemonClient(sessionId: string, config?: DaemonClientConfig): DaemonClient {
	return new DaemonClient(sessionId, config);
}
