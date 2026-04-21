/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Three-tier message buffer for daemon communication.
 *
 * Implements tiered buffering per spec:
 * - Critical: Unlimited, requires ACK (orders, risk alerts)
 * - Important: Max 1000 (positions, fills)
 * - Telemetry: Max 100 (heartbeats, metrics)
 */

import {
	BufferedMessage,
	MessageTier,
	BufferConfig,
	DefaultBufferConfig,
	JsonRpcRequest,
	JsonRpcNotification,
} from './types';

/**
 * Buffer statistics.
 */
export interface BufferStats {
	criticalCount: number;
	importantCount: number;
	telemetryCount: number;
	totalCount: number;
	criticalDropped: number;
	importantDropped: number;
	telemetryDropped: number;
	oldestMessageAge: number | null;
}

/**
 * Message buffer event handlers.
 */
export interface BufferEventHandlers {
	onOverflow?: (tier: MessageTier, dropped: number) => void;
	onCriticalWarning?: (count: number) => void;
}

/**
 * Three-tier message buffer.
 */
export class MessageBuffer {
	private readonly config: BufferConfig;
	private readonly handlers: BufferEventHandlers;

	// Tiered queues
	private critical: BufferedMessage[] = [];
	private important: BufferedMessage[] = [];
	private telemetry: BufferedMessage[] = [];

	// Counters
	private idCounter = 0;
	private droppedCritical = 0;
	private droppedImportant = 0;
	private droppedTelemetry = 0;

	constructor(
		config: Partial<BufferConfig> = {},
		handlers: BufferEventHandlers = {}
	) {
		this.config = { ...DefaultBufferConfig, ...config };
		this.handlers = handlers;
	}

	/**
	 * Enqueue a message with the specified tier.
	 */
	enqueue(
		message: JsonRpcRequest | JsonRpcNotification,
		tier: MessageTier,
		ackRequired: boolean = false
	): string {
		const id = this.generateId();
		const buffered: BufferedMessage = {
			id,
			tier,
			message,
			timestamp: Date.now(),
			retryCount: 0,
			ackRequired: tier === 'critical' ? true : ackRequired,
		};

		switch (tier) {
			case 'critical':
				this.enqueueCritical(buffered);
				break;
			case 'important':
				this.enqueueImportant(buffered);
				break;
			case 'telemetry':
				this.enqueueTelemetry(buffered);
				break;
		}

		return id;
	}

	/**
	 * Dequeue the next message from a tier.
	 */
	dequeue(tier: MessageTier): BufferedMessage | undefined {
		switch (tier) {
			case 'critical':
				return this.critical.shift();
			case 'important':
				return this.important.shift();
			case 'telemetry':
				return this.telemetry.shift();
		}
	}

	/**
	 * Dequeue the next message from any tier (priority order).
	 */
	dequeueAny(): BufferedMessage | undefined {
		// Priority: critical > important > telemetry
		return this.dequeue('critical') ??
			this.dequeue('important') ??
			this.dequeue('telemetry');
	}

	/**
	 * Peek at the next message without removing it.
	 */
	peek(tier: MessageTier): BufferedMessage | undefined {
		switch (tier) {
			case 'critical':
				return this.critical[0];
			case 'important':
				return this.important[0];
			case 'telemetry':
				return this.telemetry[0];
		}
	}

	/**
	 * Flush all messages from a tier.
	 */
	flush(tier: MessageTier): BufferedMessage[] {
		let messages: BufferedMessage[];

		switch (tier) {
			case 'critical':
				messages = this.critical;
				this.critical = [];
				break;
			case 'important':
				messages = this.important;
				this.important = [];
				break;
			case 'telemetry':
				messages = this.telemetry;
				this.telemetry = [];
				break;
		}

		return messages;
	}

	/**
	 * Flush all messages from all tiers.
	 */
	flushAll(): BufferedMessage[] {
		const all = [
			...this.critical,
			...this.important,
			...this.telemetry,
		];

		this.critical = [];
		this.important = [];
		this.telemetry = [];

		return all;
	}

	/**
	 * Get message by ID.
	 */
	getById(id: string): BufferedMessage | undefined {
		return this.critical.find(m => m.id === id) ??
			this.important.find(m => m.id === id) ??
			this.telemetry.find(m => m.id === id);
	}

	/**
	 * Remove a message by ID.
	 */
	removeById(id: string): boolean {
		let index = this.critical.findIndex(m => m.id === id);
		if (index !== -1) {
			this.critical.splice(index, 1);
			return true;
		}

		index = this.important.findIndex(m => m.id === id);
		if (index !== -1) {
			this.important.splice(index, 1);
			return true;
		}

		index = this.telemetry.findIndex(m => m.id === id);
		if (index !== -1) {
			this.telemetry.splice(index, 1);
			return true;
		}

		return false;
	}

	/**
	 * Increment retry count for a message.
	 */
	incrementRetry(id: string): number {
		const message = this.getById(id);
		if (message) {
			message.retryCount++;
			return message.retryCount;
		}
		return -1;
	}

	/**
	 * Get the count for a tier.
	 */
	count(tier: MessageTier): number {
		switch (tier) {
			case 'critical':
				return this.critical.length;
			case 'important':
				return this.important.length;
			case 'telemetry':
				return this.telemetry.length;
		}
	}

	/**
	 * Get total message count.
	 */
	totalCount(): number {
		return this.critical.length + this.important.length + this.telemetry.length;
	}

	/**
	 * Check if buffer is empty.
	 */
	isEmpty(): boolean {
		return this.totalCount() === 0;
	}

	/**
	 * Check if a tier is empty.
	 */
	isTierEmpty(tier: MessageTier): boolean {
		return this.count(tier) === 0;
	}

	/**
	 * Get buffer statistics.
	 */
	getStats(): BufferStats {
		const all = [...this.critical, ...this.important, ...this.telemetry];
		const oldestTimestamp = all.length > 0
			? Math.min(...all.map(m => m.timestamp))
			: null;

		return {
			criticalCount: this.critical.length,
			importantCount: this.important.length,
			telemetryCount: this.telemetry.length,
			totalCount: all.length,
			criticalDropped: this.droppedCritical,
			importantDropped: this.droppedImportant,
			telemetryDropped: this.droppedTelemetry,
			oldestMessageAge: oldestTimestamp !== null ? Date.now() - oldestTimestamp : null,
		};
	}

	/**
	 * Clear all messages and reset counters.
	 */
	clear(): void {
		this.critical = [];
		this.important = [];
		this.telemetry = [];
		this.droppedCritical = 0;
		this.droppedImportant = 0;
		this.droppedTelemetry = 0;
	}

	/**
	 * Enqueue to critical tier (unlimited, with warning).
	 */
	private enqueueCritical(message: BufferedMessage): void {
		this.critical.push(message);

		// Warn if exceeding threshold
		if (this.critical.length >= this.config.criticalLimit) {
			this.handlers.onCriticalWarning?.(this.critical.length);
		}
	}

	/**
	 * Enqueue to important tier (max 1000).
	 */
	private enqueueImportant(message: BufferedMessage): void {
		if (this.important.length >= this.config.importantLimit) {
			// Drop oldest
			this.important.shift();
			this.droppedImportant++;
			this.handlers.onOverflow?.('important', 1);
		}

		this.important.push(message);
	}

	/**
	 * Enqueue to telemetry tier (max 100).
	 */
	private enqueueTelemetry(message: BufferedMessage): void {
		if (this.telemetry.length >= this.config.telemetryLimit) {
			// Drop oldest
			this.telemetry.shift();
			this.droppedTelemetry++;
			this.handlers.onOverflow?.('telemetry', 1);
		}

		this.telemetry.push(message);
	}

	/**
	 * Generate a unique message ID.
	 */
	private generateId(): string {
		return `buf-${Date.now()}-${++this.idCounter}`;
	}
}

/**
 * Determine the appropriate tier for a message method.
 */
export function getTierForMethod(method: string): MessageTier {
	// Critical: orders, risk, session control
	const criticalMethods = [
		'order.submit',
		'order.cancel',
		'session.stop',
		'session.pause',
		'risk.alert',
		'flatten.all',
	];

	if (criticalMethods.some(m => method.startsWith(m) || method === m)) {
		return 'critical';
	}

	// Telemetry: heartbeats, metrics
	const telemetryMethods = [
		'heartbeat',
		'metrics',
		'telemetry',
		'ping',
	];

	if (telemetryMethods.some(m => method.startsWith(m) || method === m)) {
		return 'telemetry';
	}

	// Everything else is important
	return 'important';
}

/**
 * Create a message buffer with default configuration.
 */
export function createMessageBuffer(
	config?: Partial<BufferConfig>,
	handlers?: BufferEventHandlers
): MessageBuffer {
	return new MessageBuffer(config, handlers);
}
