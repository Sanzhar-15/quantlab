/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { GatewayRequest, RequestPriority } from '../canonical/interfaces.js';
import type { ProviderResponse } from '../canonical/types.js';
import { QicError } from '../canonical/types.js';
import type { LaneName } from '../canonical/lanes.js';

interface QueuedRequest {
	request: GatewayRequest;
	priority: number;
	resolve: (response: ProviderResponse) => void;
	reject: (error: Error) => void;
	enqueuedAt: number;
}

const PRIORITY_MAP: Record<RequestPriority, number> = {
	'critical': 0,
	'high': 1,
	'normal': 2,
	'low': 3,
	'background': 4,
};

const QUOTA_GROUPS: Record<string, { percentage: number; lanes: string[] }> = {
	'completion': { percentage: 0.4, lanes: ['completion'] },
	'chat': { percentage: 0.5, lanes: ['chat-ask', 'chat-gather', 'chat-plan', 'chat-act'] },
	'background': { percentage: 0.1, lanes: ['repair', 'fast-apply', 'summarize'] },
};

/**
 * Priority queue with load shedding and request deduplication (Audit VII-DS4).
 */
export class RequestManager {
	private readonly queue: QueuedRequest[] = [];
	private readonly pendingRequests = new Map<string, Promise<ProviderResponse>>();
	private readonly quotaUsed = new Map<string, number>();
	private readonly maxQueueSize: number;

	constructor(
		private readonly executeRequest: (request: GatewayRequest) => Promise<ProviderResponse>,
		maxQueueSize = 100,
	) {
		this.maxQueueSize = maxQueueSize;
	}

	async enqueue(request: GatewayRequest): Promise<ProviderResponse> {
		// Deduplication for completion requests
		if (request.lane === 'completion') {
			const dedupeKey = this.computeDeduplicationKey(request);
			const existing = this.pendingRequests.get(dedupeKey);
			if (existing) { return existing; }

			const promise = this.processRequest(request);
			this.pendingRequests.set(dedupeKey, promise);
			try {
				return await promise;
			} finally {
				this.pendingRequests.delete(dedupeKey);
			}
		}

		// Load shedding check
		if (this.shouldShed(request)) {
			throw new QicError('QIC-N003', 'Request shed due to capacity');
		}

		return this.processRequest(request);
	}

	shedLoad(): number {
		const initialSize = this.queue.length;
		// Remove background-priority requests first
		for (let i = this.queue.length - 1; i >= 0; i--) {
			if (this.queue[i].priority >= PRIORITY_MAP['low']) {
				const removed = this.queue.splice(i, 1)[0];
				removed.reject(new QicError('QIC-N003', 'Request shed'));
			}
		}
		return initialSize - this.queue.length;
	}

	cancelQueuedByCategory(category: string): void {
		for (let i = this.queue.length - 1; i >= 0; i--) {
			const group = this.getQuotaGroup(this.queue[i].request.lane);
			if (group === category) {
				const removed = this.queue.splice(i, 1)[0];
				removed.reject(new QicError('QIC-Y002', 'Cancelled due to consent revocation'));
			}
		}
	}

	private async processRequest(request: GatewayRequest): Promise<ProviderResponse> {
		const group = this.getQuotaGroup(request.lane);
		this.incrementQuota(group);
		try {
			return await this.executeRequest(request);
		} finally {
			this.decrementQuota(group);
		}
	}

	private shouldShed(request: GatewayRequest): boolean {
		if (this.queue.length >= this.maxQueueSize) {
			return request.priority === 'low' || request.priority === 'background';
		}
		return false;
	}

	private computeDeduplicationKey(request: GatewayRequest): string {
		const data = JSON.stringify({
			model: request.model,
			messages: request.messages,
			maxTokens: request.maxTokens,
		});
		return sha256Hex(data);
	}

	private getQuotaGroup(lane: LaneName): string {
		for (const [group, config] of Object.entries(QUOTA_GROUPS)) {
			if (config.lanes.includes(lane)) { return group; }
		}
		return 'background';
	}

	private incrementQuota(group: string): void {
		this.quotaUsed.set(group, (this.quotaUsed.get(group) ?? 0) + 1);
	}

	private decrementQuota(group: string): void {
		const current = this.quotaUsed.get(group) ?? 0;
		this.quotaUsed.set(group, Math.max(0, current - 1));
	}
}
