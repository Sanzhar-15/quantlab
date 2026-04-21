/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ActivityEntry,
	BrokerAccount,
	Fill,
	Order,
	OrderModification,
	PerformanceMetrics,
	Position,
	RequirementsCheck,
	RiskAlert,
	SessionInfo,
	TradeErrorState,
	KillSwitchPolicy
} from './trading';

export interface TradeMessageEnvelope {
	sessionId?: string;
	strategyPath?: string;
	timestamp?: number;
	seq?: number;
}

export type TradeOutboundMessage =
	| ({ type: 'init'; session: SessionInfo | null; requirements: RequirementsCheck; scrollPosition?: number; accounts?: BrokerAccount[]; killSwitchPolicy?: KillSwitchPolicy; requirementsPolicy?: { requireBacktest: boolean; requirePaperTrading: boolean; requireRiskReview: boolean } } & TradeMessageEnvelope)
	| ({ type: 'requirementsUpdate'; requirements: RequirementsCheck; requirementsPolicy?: { requireBacktest: boolean; requirePaperTrading: boolean; requireRiskReview: boolean } } & TradeMessageEnvelope)
	| ({ type: 'sessionStarted'; session: SessionInfo } & TradeMessageEnvelope)
	| ({ type: 'sessionUpdated'; session: SessionInfo } & TradeMessageEnvelope)
	| ({ type: 'sessionStopped'; sessionId: string; reason?: string } & TradeMessageEnvelope)
	| ({ type: 'positionsUpdate'; sessionId: string; positions: Position[] } & TradeMessageEnvelope)
	| ({ type: 'ordersUpdate'; sessionId: string; orders: Order[] } & TradeMessageEnvelope)
	| ({ type: 'fill'; sessionId: string; fill: Fill } & TradeMessageEnvelope)
	| ({ type: 'performanceUpdate'; sessionId: string; performance: PerformanceMetrics } & TradeMessageEnvelope)
	| ({ type: 'activity'; sessionId: string; entry: ActivityEntry } & TradeMessageEnvelope)
	| ({ type: 'heartbeat'; sessionId: string; status: 'ok' | 'stale' | 'lost'; lastSeen: number } & TradeMessageEnvelope)
	| ({ type: 'riskAlert'; sessionId: string; alert: RiskAlert } & TradeMessageEnvelope)
	| ({ type: 'errorState'; sessionId: string; error: TradeErrorState } & TradeMessageEnvelope);

export type TradeInboundMessage =
	| { type: 'ready' }
	| { type: 'openTradePanel' }
	| { type: 'openBrokerSettings' }
	| { type: 'openTradeLogs'; sessionId: string }
	| { type: 'retryBroker'; sessionId: string }
	| { type: 'restartSession'; sessionId: string }
	| { type: 'pauseSession'; sessionId: string }
	| { type: 'resumeSession'; sessionId: string }
	| { type: 'stopSession'; sessionId: string }
	| { type: 'killSwitch'; sessionId: string; confirmed?: boolean }
	| { type: 'viewInChart'; sessionId: string }
	| { type: 'modifyOrder'; sessionId: string; orderId: string; changes: OrderModification }
	| { type: 'cancelOrder'; sessionId: string; orderId: string }
	| { type: 'closePosition'; sessionId: string; symbol: string }
	| { type: 'openSessionSettings'; sessionId: string }
	| { type: 'scrollPosition'; value: number };
