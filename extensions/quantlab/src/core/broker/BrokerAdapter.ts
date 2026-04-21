/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fill, Order, OrderSide, OrderType, Position } from '../../types/trading';

export interface OrderRequest {
	symbol: string;
	side: OrderSide;
	type: OrderType;
	quantity: number;
	price?: number;
	stopPrice?: number;
	timeInForce: 'day' | 'gtc' | 'ioc' | 'fok';
}

export interface BrokerUpdateCallbacks {
	onPositionUpdate: (positions: Position[]) => void;
	onOrderUpdate: (orders: Order[]) => void;
	onFill: (fill: Fill) => void;
}

export abstract class BrokerAdapter {
	abstract connect(): Promise<void>;
	abstract disconnect(): Promise<void>;
	abstract isConnected(): boolean;

	abstract getAccountName(): string;
	abstract getAccountBalance(): Promise<number>;
	abstract getBuyingPower(): Promise<number>;

	abstract getPositions(): Promise<Position[]>;
	abstract getOpenOrders(): Promise<Order[]>;
	abstract getOrderHistory(limit?: number): Promise<Order[]>;

	abstract placeOrder(request: OrderRequest): Promise<Order>;
	abstract cancelOrder(orderId: string): Promise<void>;
	abstract modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<Order>;

	abstract subscribeToUpdates(callbacks: BrokerUpdateCallbacks): void;
	abstract unsubscribeFromUpdates(): void;
}
