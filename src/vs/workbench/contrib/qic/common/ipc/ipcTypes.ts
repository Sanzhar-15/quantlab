/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared IPC types mirroring extensions/quantlab/src/core/ipc/types.ts.
 * REMEDIATION FIX 4b: Workbench code cannot import from extensions/ directory.
 * AUDIT FIX III-QI3: Reuse existing IPC protocol types.
 *
 * These types are a minimal mirror — only the JSON-RPC types needed by QicPythonBridge.
 */

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number | string;
	method: string;
	params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcSuccessResponse {
	jsonrpc: '2.0';
	id: number | string;
	result: unknown;
}

export interface JsonRpcErrorResponse {
	jsonrpc: '2.0';
	id: number | string;
	error: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: Record<string, unknown> | unknown[];
}

export type JsonRpcMessage =
	| JsonRpcRequest
	| JsonRpcSuccessResponse
	| JsonRpcErrorResponse
	| JsonRpcNotification;

/**
 * Type guards matching extensions/quantlab/src/core/ipc/types.ts
 */
export function isJsonRpcSuccessResponse(msg: JsonRpcMessage): msg is JsonRpcSuccessResponse {
	return 'id' in msg && 'result' in msg;
}

export function isJsonRpcErrorResponse(msg: JsonRpcMessage): msg is JsonRpcErrorResponse {
	return 'id' in msg && 'error' in msg;
}

/**
 * IPC client interface for communicating with the engine daemon.
 * Implementations are provided by the activation layer (Prompt 18).
 */
export interface IpcClient {
	request<T>(method: string, params: Record<string, unknown>): Promise<T>;
	notify(method: string, params: Record<string, unknown>): Promise<void>;
	onNotification(handler: (method: string, params: unknown) => void): void;
	isConnected(): boolean;
}
