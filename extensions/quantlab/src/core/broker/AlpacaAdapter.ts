/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrokerAdapter, BrokerUpdateCallbacks, OrderRequest } from './BrokerAdapter';
import { Fill, Order, OrderStatus, Position } from '../../types/trading';
import { SecureStorage } from '../../utils/secureStorage';

interface AlpacaCredentials {
	apiKey: string;
	apiSecret: string;
}

export class AlpacaAdapter extends BrokerAdapter {
	private apiKey = '';
	private apiSecret = '';
	private connected = false;
	private callbacks: BrokerUpdateCallbacks | null = null;
	private pollTimer?: NodeJS.Timeout;
	private accountInfo: { account_number?: string } | null = null;
	private lastFillCheck = 0;
	private seenFills = new Set<string>();

	private readonly baseUrl: string;

	constructor(private readonly accountId: string, isPaper: boolean) {
		super();
		this.baseUrl = isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
	}

	async connect(): Promise<void> {
		const storage = SecureStorage.getInstance();
		const raw = await storage.get(`alpaca.${this.accountId}`);
		if (!raw) {
			throw new Error('Alpaca credentials not configured');
		}

		let creds: AlpacaCredentials;
		try {
			creds = JSON.parse(raw) as AlpacaCredentials;
		} catch {
			throw new Error('Invalid Alpaca credentials format');
		}

		if (!creds.apiKey || !creds.apiSecret) {
			throw new Error('Alpaca credentials missing apiKey or apiSecret');
		}

		this.apiKey = creds.apiKey;
		this.apiSecret = creds.apiSecret;

		this.accountInfo = await this.request('GET', '/v2/account');
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.stopPolling();
	}

	isConnected(): boolean {
		return this.connected;
	}

	getAccountName(): string {
		return this.accountInfo?.account_number ?? this.accountId;
	}

	async getAccountBalance(): Promise<number> {
		const account = await this.request('GET', '/v2/account');
		return parseFloat(account.equity);
	}

	async getBuyingPower(): Promise<number> {
		const account = await this.request('GET', '/v2/account');
		return parseFloat(account.buying_power);
	}

	async getPositions(): Promise<Position[]> {
		const positions = await this.request('GET', '/v2/positions');
		return Array.isArray(positions) ? positions.map(this.mapPosition) : [];
	}

	async getOpenOrders(): Promise<Order[]> {
		const orders = await this.request('GET', '/v2/orders?status=open');
		return Array.isArray(orders) ? orders.map(this.mapOrder) : [];
	}

	async getOrderHistory(limit = 50): Promise<Order[]> {
		const orders = await this.request('GET', `/v2/orders?status=all&limit=${limit}`);
		return Array.isArray(orders) ? orders.map(this.mapOrder) : [];
	}

	async placeOrder(request: OrderRequest): Promise<Order> {
		const payload: Record<string, unknown> = {
			symbol: request.symbol,
			qty: request.quantity,
			side: request.side,
			type: request.type,
			time_in_force: request.timeInForce
		};
		if (request.price !== undefined) {
			payload.limit_price = request.price;
		}
		if (request.stopPrice !== undefined) {
			payload.stop_price = request.stopPrice;
		}

		const response = await this.request('POST', '/v2/orders', payload);
		return this.mapOrder(response);
	}

	async cancelOrder(orderId: string): Promise<void> {
		await this.request('DELETE', `/v2/orders/${orderId}`);
	}

	async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<Order> {
		const payload: Record<string, unknown> = {};
		if (changes.quantity !== undefined) {
			payload.qty = changes.quantity;
		}
		if (changes.price !== undefined) {
			payload.limit_price = changes.price;
		}
		if (changes.stopPrice !== undefined) {
			payload.stop_price = changes.stopPrice;
		}

		const response = await this.request('PATCH', `/v2/orders/${orderId}`, payload);
		return this.mapOrder(response);
	}

	subscribeToUpdates(callbacks: BrokerUpdateCallbacks): void {
		this.callbacks = callbacks;
		this.startPolling();
		void this.refreshState();
	}

	unsubscribeFromUpdates(): void {
		this.callbacks = null;
		this.stopPolling();
	}

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			void this.refreshState();
		}, 2000);
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	private async refreshState(): Promise<void> {
		if (!this.callbacks) {
			return;
		}

		try {
			const [positions, orders] = await Promise.all([
				this.getPositions(),
				this.getOpenOrders()
			]);

			this.callbacks.onPositionUpdate(positions);
			this.callbacks.onOrderUpdate(orders);
			await this.emitRecentFills();
		} catch {
			// Swallow polling errors to avoid crashing the session.
		}
	}

	private async emitRecentFills(): Promise<void> {
		if (!this.callbacks) {
			return;
		}

		const history = await this.getOrderHistory(50);
		const latest = history.filter(order => order.status === 'filled' || order.status === 'partial');

		for (const order of latest) {
			const filledAt = order.updatedAt;
			if (filledAt <= this.lastFillCheck) {
				continue;
			}
			const fillId = `alpaca-${order.id}-${filledAt}`;
			if (this.seenFills.has(fillId)) {
				continue;
			}

			this.seenFills.add(fillId);
			const fill: Fill = {
				id: fillId,
				orderId: order.id,
				symbol: order.symbol,
				side: order.side,
				quantity: order.filledQuantity,
				price: order.price ?? 0,
				timestamp: filledAt,
				commission: 0
			};
			this.callbacks.onFill(fill);
		}

		if (latest.length) {
			this.lastFillCheck = Math.max(this.lastFillCheck, ...latest.map(order => order.updatedAt));
		}
	}

	private async request(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				'APCA-API-KEY-ID': this.apiKey,
				'APCA-API-SECRET-KEY': this.apiSecret,
				'Content-Type': 'application/json'
			},
			body: body ? JSON.stringify(body) : undefined
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Alpaca API error: ${response.status} ${text}`);
		}

		if (response.status === 204) {
			return null;
		}
		return response.json();
	}

	private mapPosition(raw: any): Position {
		return {
			symbol: raw.symbol,
			quantity: parseFloat(raw.qty),
			avgPrice: parseFloat(raw.avg_entry_price),
			currentPrice: parseFloat(raw.current_price),
			unrealizedPnL: parseFloat(raw.unrealized_pl),
			realizedPnL: 0,
			marketValue: parseFloat(raw.market_value),
			updatedAt: Date.now()
		};
	}

	private mapOrder(raw: any): Order {
		const statusMap: Record<string, OrderStatus> = {
			new: 'open',
			partially_filled: 'partial',
			filled: 'filled',
			done_for_day: 'filled',
			canceled: 'cancelled',
			expired: 'cancelled',
			replaced: 'cancelled',
			pending_cancel: 'open',
			pending_replace: 'open',
			accepted: 'open',
			pending_new: 'pending',
			accepted_for_bidding: 'pending',
			stopped: 'open',
			rejected: 'rejected',
			suspended: 'open',
			calculated: 'open'
		};

		const filledAvg = raw.filled_avg_price ? parseFloat(raw.filled_avg_price) : undefined;
		return {
			id: raw.id,
			symbol: raw.symbol,
			side: raw.side,
			type: raw.type,
			quantity: parseFloat(raw.qty),
			filledQuantity: parseFloat(raw.filled_qty) || 0,
			price: raw.limit_price ? parseFloat(raw.limit_price) : filledAvg,
			stopPrice: raw.stop_price ? parseFloat(raw.stop_price) : undefined,
			status: statusMap[raw.status] ?? 'open',
			createdAt: Date.parse(raw.created_at),
			updatedAt: Date.parse(raw.updated_at),
			rejectionReason: raw.status === 'rejected' ? raw.reject_reason || 'Order rejected' : undefined
		};
	}
}
