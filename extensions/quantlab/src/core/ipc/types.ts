/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IPC Types for daemon communication.
 *
 * Implements JSON-RPC 2.0 message types for the daemon protocol.
 */

/**
 * JSON-RPC 2.0 request message.
 */
export interface JsonRpcRequest {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
	id: string | number;
}

/**
 * JSON-RPC 2.0 notification (request without id).
 */
export interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
}

/**
 * JSON-RPC 2.0 success response.
 */
export interface JsonRpcSuccessResponse {
	jsonrpc: '2.0';
	result: unknown;
	id: string | number;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/**
 * JSON-RPC 2.0 error response.
 */
export interface JsonRpcErrorResponse {
	jsonrpc: '2.0';
	error: JsonRpcError;
	id: string | number | null;
}

/**
 * Any JSON-RPC 2.0 message.
 */
export type JsonRpcMessage =
	| JsonRpcRequest
	| JsonRpcNotification
	| JsonRpcSuccessResponse
	| JsonRpcErrorResponse;

/**
 * JSON-RPC 2.0 standard error codes.
 */
export const JsonRpcErrorCodes = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	// Server errors: -32000 to -32099
	SERVER_ERROR: -32000,
	AUTHENTICATION_FAILED: -32001,
	EXPOSURE_LIMIT_BREACH: -32002,
	SESSION_NOT_FOUND: -32003,
	BROKER_ERROR: -32004,
} as const;

/**
 * Message priority tiers for buffering.
 */
export type MessageTier = 'critical' | 'important' | 'telemetry';

/**
 * Buffered message wrapper.
 */
export interface BufferedMessage {
	id: string;
	tier: MessageTier;
	message: JsonRpcRequest | JsonRpcNotification;
	timestamp: number;
	retryCount: number;
	ackRequired: boolean;
}

/**
 * Transport events.
 */
export interface TransportEvents {
	connect: [];
	disconnect: [];
	error: [Error];
	message: [JsonRpcMessage];
}

/**
 * Retry configuration.
 */
export interface RetryConfig {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	jitterFactor: number;
}

/**
 * Default retry configuration.
 */
export const DefaultRetryConfig: RetryConfig = {
	maxRetries: 5,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	jitterFactor: 0.1,
};

/**
 * Message buffer configuration.
 */
export interface BufferConfig {
	criticalLimit: number; // Unlimited, but this is max before warning
	importantLimit: number;
	telemetryLimit: number;
}

/**
 * Default buffer configuration.
 */
export const DefaultBufferConfig: BufferConfig = {
	criticalLimit: 10000, // Warning threshold
	importantLimit: 1000,
	telemetryLimit: 100,
};

/**
 * Connection state.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/**
 * Session configuration for daemon.
 */
export interface SessionConfig {
	sessionId: string;
	strategyPath: string;
	symbol: string;
	timeframe: string;
	paper: boolean;
	riskLimits: {
		maxExposure?: number;
		maxPositionSize?: number;
		maxDailyLoss?: number;
	};
}

/**
 * Session start response.
 */
export interface SessionStartResponse {
	sessionId: string;
	status: 'started' | 'error';
	error?: string;
}

/**
 * Position data from daemon.
 */
export interface DaemonPosition {
	symbol: string;
	quantity: number;
	avgEntryPrice: number;
	currentPrice?: number;
	unrealizedPnl: number;
	realizedPnl: number;
	side: 'long' | 'short' | 'flat';
}

/**
 * Order data from daemon.
 */
export interface DaemonOrder {
	orderId: string;
	symbol: string;
	side: 'buy' | 'sell';
	orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
	quantity: number;
	limitPrice?: number;
	stopPrice?: number;
	status: 'pending' | 'submitted' | 'accepted' | 'partial' | 'filled' | 'cancelled' | 'rejected';
	filledQuantity: number;
	avgFillPrice?: number;
}

/**
 * Fill data from daemon.
 */
export interface DaemonFill {
	fillId: string;
	orderId: string;
	symbol: string;
	side: 'buy' | 'sell';
	quantity: number;
	price: number;
	commission: number;
	timestamp: string;
}

/**
 * Risk alert from daemon.
 */
export interface RiskAlert {
	type: 'exposure_limit' | 'position_limit' | 'daily_loss' | 'circuit_breaker';
	severity: 'warning' | 'critical';
	message: string;
	currentValue: number;
	limit: number;
}

/**
 * Daemon health status.
 */
export interface DaemonHealth {
	status: 'healthy' | 'degraded' | 'unhealthy';
	uptime: number;
	lastHeartbeat: number;
	brokerConnected: boolean;
	memoryUsage: number;
}

/**
 * Order request to daemon.
 */
export interface OrderRequest {
	symbol: string;
	side: 'buy' | 'sell';
	orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
	quantity: number;
	limitPrice?: number;
	stopPrice?: number;
	timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok';
}

/**
 * Type guard for JSON-RPC request.
 */
export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
	return 'method' in msg && 'id' in msg;
}

/**
 * Type guard for JSON-RPC notification.
 */
export function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
	return 'method' in msg && !('id' in msg);
}

/**
 * Type guard for JSON-RPC success response.
 */
export function isJsonRpcSuccessResponse(msg: JsonRpcMessage): msg is JsonRpcSuccessResponse {
	return 'result' in msg && 'id' in msg && !('error' in msg);
}

/**
 * Type guard for JSON-RPC error response.
 */
export function isJsonRpcErrorResponse(msg: JsonRpcMessage): msg is JsonRpcErrorResponse {
	return 'error' in msg;
}
