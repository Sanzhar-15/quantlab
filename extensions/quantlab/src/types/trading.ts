/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Timeframe } from './market';
import { ComplexityLevel } from './strategy';

export type SessionType = 'paper' | 'live';
export type SessionStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderStatus = 'pending' | 'open' | 'partial' | 'filled' | 'cancelled' | 'rejected';
export type Timestamp = number;

export interface SessionInfo {
	id: string;
	type: SessionType;
	status: SessionStatus;
	strategyPath: string;
	strategyHash: string;
	accountId: string;
	accountName: string;
	startedAt: Timestamp;
	lastHeartbeat: Timestamp;
	symbol: string;
	timeframe: Timeframe;
	endedAt?: Timestamp;
}

export interface Position {
	symbol: string;
	quantity: number;
	avgPrice: number;
	currentPrice: number;
	unrealizedPnL: number;
	realizedPnL: number;
	marketValue: number;
	updatedAt?: Timestamp;
}

export interface Order {
	id: string;
	symbol: string;
	side: OrderSide;
	type: OrderType;
	quantity: number;
	filledQuantity: number;
	price?: number;
	stopPrice?: number;
	status: OrderStatus;
	createdAt: Timestamp;
	updatedAt: Timestamp;
	rejectionReason?: string;
}

export interface Fill {
	id: string;
	orderId: string;
	symbol: string;
	side: OrderSide;
	quantity: number;
	price: number;
	timestamp: Timestamp;
	commission: number;
}

export interface PerformanceMetrics {
	sessionPnL: number;
	todayPnL: number;
	openPnL: number;
	realizedPnL: number;
	totalTrades: number;
	winRate: number;
	avgWin: number;
	avgLoss: number;
}

export interface RiskAlert {
	id: string;
	level: 'warning' | 'critical';
	type: 'dailyLoss' | 'positionSize' | 'drawdown' | 'custom';
	message: string;
	value: number;
	limit: number;
	timestamp: Timestamp;
}

export interface ActivityEntry {
	id: string;
	timestamp: Timestamp;
	type: 'order' | 'fill' | 'signal' | 'alert' | 'system';
	message: string;
	details?: Record<string, unknown>;
}

export interface RequirementsCheck {
	validStrategy: boolean;
	complexity: ComplexityLevel;
	brokerConfigured: boolean;
	hasBacktest: boolean;
	hasPaperTrading: boolean;
	riskReviewed: boolean;
}

export type KillSwitchPolicy = 'flatten' | 'cancelOnly' | 'custom';

export interface KillSwitchConfig {
	policy: KillSwitchPolicy;
	customActions?: KillSwitchAction[];
}

export interface KillSwitchAction {
	type: 'cancelOrders' | 'flattenPositions' | 'pauseStrategy' | 'custom';
	params?: Record<string, unknown>;
}

export interface TradeErrorState {
	code: string;
	message: string;
	recoverable?: boolean;
	detail?: string;
}

export interface BrokerAccount {
	id: string;
	name: string;
	type: SessionType;
	broker: string;
	connected: boolean;
	lastConnected?: Timestamp;
	balance?: number;
	buyingPower?: number;
}

export interface OrderModification {
	quantity?: number;
	price?: number;
	stopPrice?: number;
}

export interface TradeSessionSummary {
	id: string;
	type: SessionType;
	strategyPath: string;
	startedAt: Timestamp;
	endedAt?: Timestamp;
}
