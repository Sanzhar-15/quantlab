/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrokerAdapter, BrokerUpdateCallbacks, OrderRequest } from './BrokerAdapter';
import { Fill, Order, OrderSide, Position } from '../../types/trading';

interface MockFillPlan {
	orderId: string;
	delayMs: number;
}

export class MockBrokerAdapter extends BrokerAdapter {
	private connected = false;
	private callbacks: BrokerUpdateCallbacks | null = null;
	private positions: Position[] = [];
	private orders: Order[] = [];
	private fillPlan: MockFillPlan[] = [];
	private pollTimer?: NodeJS.Timeout;
	private lastPrice = new Map<string, number>();

	constructor(private readonly accountId: string, private readonly accountName = 'Mock Account') {
		super();
	}

	async connect(): Promise<void> {
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.stopPolling();
		this.fillPlan = [];
	}

	isConnected(): boolean {
		return this.connected;
	}

	getAccountName(): string {
		return `${this.accountName} (${this.accountId})`;
	}

	async getAccountBalance(): Promise<number> {
		return 100000;
	}

	async getBuyingPower(): Promise<number> {
		return 100000;
	}

	async getPositions(): Promise<Position[]> {
		return this.positions.map(position => ({ ...position }));
	}

	async getOpenOrders(): Promise<Order[]> {
		return this.orders.filter(order => order.status === 'open' || order.status === 'partial').map(order => ({ ...order }));
	}

	async getOrderHistory(): Promise<Order[]> {
		return this.orders.map(order => ({ ...order }));
	}

	async placeOrder(request: OrderRequest): Promise<Order> {
		const now = Date.now();
		const order: Order = {
			id: `mock-${now}-${Math.random().toString(16).slice(2, 6)}`,
			symbol: request.symbol,
			side: request.side,
			type: request.type,
			quantity: request.quantity,
			filledQuantity: 0,
			price: request.price,
			stopPrice: request.stopPrice,
			status: 'open',
			createdAt: now,
			updatedAt: now
		};

		this.orders = [order, ...this.orders];
		this.emitOrders();

		this.scheduleFill(order.id);
		return { ...order };
	}

	async cancelOrder(orderId: string): Promise<void> {
		const order = this.orders.find(candidate => candidate.id === orderId);
		if (!order || order.status === 'filled') {
			return;
		}

		order.status = 'cancelled';
		order.updatedAt = Date.now();
		this.emitOrders();
	}

	async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<Order> {
		const order = this.orders.find(candidate => candidate.id === orderId);
		if (!order) {
			throw new Error('Order not found');
		}

		if (typeof changes.quantity === 'number') {
			order.quantity = changes.quantity;
		}
		if (typeof changes.price === 'number') {
			order.price = changes.price;
		}
		if (typeof changes.stopPrice === 'number') {
			order.stopPrice = changes.stopPrice;
		}
		order.updatedAt = Date.now();
		this.emitOrders();
		return { ...order };
	}

	subscribeToUpdates(callbacks: BrokerUpdateCallbacks): void {
		this.callbacks = callbacks;
		this.startPolling();
	}

	unsubscribeFromUpdates(): void {
		this.callbacks = null;
		this.stopPolling();
	}

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			this.emitPositions();
			this.emitOrders();
			this.flushFillPlan();
		}, 2000);
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	private emitPositions(): void {
		this.callbacks?.onPositionUpdate(this.positions.map(position => ({ ...position })));
	}

	private emitOrders(): void {
		this.callbacks?.onOrderUpdate(this.orders.map(order => ({ ...order })));
	}

	private scheduleFill(orderId: string): void {
		this.fillPlan.push({ orderId, delayMs: 600 + Math.round(Math.random() * 900) });
	}

	private flushFillPlan(): void {
		if (!this.fillPlan.length) {
			return;
		}

		const now = Date.now();
		const ready: MockFillPlan[] = [];
		for (const plan of this.fillPlan) {
			plan.delayMs -= 2000;
			if (plan.delayMs <= 0) {
				ready.push(plan);
			}
		}

		if (!ready.length) {
			return;
		}

		this.fillPlan = this.fillPlan.filter(plan => !ready.includes(plan));
		for (const plan of ready) {
			const order = this.orders.find(candidate => candidate.id === plan.orderId);
			if (!order || order.status !== 'open') {
				continue;
			}

			order.status = 'filled';
			order.filledQuantity = order.quantity;
			order.updatedAt = now;
			this.applyFill(order, now);
		}
	}

	private applyFill(order: Order, timestamp: number): void {
		const price = this.resolvePrice(order);
		const fill: Fill = {
			id: `fill-${order.id}-${timestamp}`,
			orderId: order.id,
			symbol: order.symbol,
			side: order.side,
			quantity: order.quantity,
			price,
			timestamp,
			commission: 0
		};

		this.updatePositionsFromFill(order.symbol, order.side, order.quantity, price, timestamp);
		this.emitOrders();
		this.emitPositions();
		this.callbacks?.onFill(fill);
	}

	private resolvePrice(order: Order): number {
		if (typeof order.price === 'number') {
			this.lastPrice.set(order.symbol, order.price);
			return order.price;
		}

		const base = this.lastPrice.get(order.symbol) ?? 100;
		const next = Math.max(1, base + (Math.random() - 0.5) * 2);
		this.lastPrice.set(order.symbol, next);
		return next;
	}

	private updatePositionsFromFill(symbol: string, side: OrderSide, quantity: number, price: number, timestamp: number): void {
		const existing = this.positions.find(position => position.symbol === symbol);
		const signedQty = side === 'buy' ? quantity : -quantity;

		if (!existing) {
			const qty = signedQty;
			const currentPrice = price;
			this.positions.push({
				symbol,
				quantity: qty,
				avgPrice: price,
				currentPrice,
				unrealizedPnL: 0,
				realizedPnL: 0,
				marketValue: qty * currentPrice,
				updatedAt: timestamp
			});
			return;
		}

		const nextQty = existing.quantity + signedQty;
		if (nextQty === 0) {
			this.positions = this.positions.filter(position => position.symbol !== symbol);
			return;
		}

		const avgPrice = side === 'buy'
			? (existing.avgPrice * existing.quantity + price * quantity) / nextQty
			: existing.avgPrice;

		const currentPrice = price;
		existing.quantity = nextQty;
		existing.avgPrice = avgPrice;
		existing.currentPrice = currentPrice;
		existing.marketValue = nextQty * currentPrice;
		existing.unrealizedPnL = (currentPrice - avgPrice) * nextQty;
		existing.updatedAt = timestamp;
	}
}
