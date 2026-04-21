/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IPC Module for daemon communication.
 *
 * Provides JSON-RPC 2.0 based communication with the Python trading daemon.
 */

// Types
export {
	JsonRpcRequest,
	JsonRpcNotification,
	JsonRpcSuccessResponse,
	JsonRpcErrorResponse,
	JsonRpcMessage,
	JsonRpcError,
	JsonRpcErrorCodes,
	MessageTier,
	BufferedMessage,
	TransportEvents,
	RetryConfig,
	DefaultRetryConfig,
	BufferConfig,
	DefaultBufferConfig,
	ConnectionState,
	SessionConfig,
	SessionStartResponse,
	DaemonPosition,
	DaemonOrder,
	DaemonFill,
	RiskAlert,
	DaemonHealth,
	OrderRequest,
	isJsonRpcRequest,
	isJsonRpcNotification,
	isJsonRpcSuccessResponse,
	isJsonRpcErrorResponse,
} from './types';

// JSON-RPC Parser
export {
	JsonRpcParser,
	JsonRpcParserOptions,
	createParseErrorResponse,
	createInvalidRequestResponse,
	createMethodNotFoundResponse,
} from './JsonRpcParser';

// Socket Transport
export {
	SocketTransport,
	SocketTransportOptions,
	getSocketPath,
	socketExists,
} from './SocketTransport';

// Token Authentication
export {
	TokenAuth,
	TokenInfo,
	generateToken,
	writeTokenFile,
	deleteTokenFile,
	readTokenInfo,
	validateToken,
	extractAuth,
} from './TokenAuth';

// Retry Handler
export {
	RetryHandler,
	RetryOptions,
	RetryResult,
	RetryableChecker,
	createRetryHandler,
	withRetry,
	retryable,
	exponentialBackoff,
} from './RetryHandler';

// Message Buffer
export {
	MessageBuffer,
	BufferStats,
	BufferEventHandlers,
	getTierForMethod,
	createMessageBuffer,
} from './MessageBuffer';

// Schema Adapter (FIX-CGP-003)
export {
	SchemaAdapter,
	fromDaemon,
	toDaemon,
	snakeToCamel,
	camelToSnake,
} from './SchemaAdapter';
