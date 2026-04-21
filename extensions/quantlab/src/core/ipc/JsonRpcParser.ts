/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * JSON-RPC 2.0 Parser with length-prefix framing.
 *
 * Handles serialization and deserialization of JSON-RPC messages
 * using 4-byte big-endian length prefixes for framing.
 */

import {
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcNotification,
	JsonRpcSuccessResponse,
	JsonRpcErrorResponse,
	JsonRpcError,
	JsonRpcErrorCodes,
} from './types';

/**
 * Parser options.
 */
export interface JsonRpcParserOptions {
	maxMessageSize?: number;
}

/**
 * Default parser options.
 */
const DEFAULT_OPTIONS: Required<JsonRpcParserOptions> = {
	maxMessageSize: 10 * 1024 * 1024, // 10MB
};

/**
 * JSON-RPC 2.0 parser with length-prefix framing.
 */
export class JsonRpcParser {
	private readonly options: Required<JsonRpcParserOptions>;
	private idCounter = 0;

	constructor(options: JsonRpcParserOptions = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Generate a unique request ID.
	 */
	generateId(): string {
		return `req-${Date.now()}-${++this.idCounter}`;
	}

	/**
	 * Create a JSON-RPC request.
	 */
	createRequest(method: string, params?: unknown, id?: string): JsonRpcRequest {
		return {
			jsonrpc: '2.0',
			method,
			params,
			id: id ?? this.generateId(),
		};
	}

	/**
	 * Create a JSON-RPC notification.
	 */
	createNotification(method: string, params?: unknown): JsonRpcNotification {
		return {
			jsonrpc: '2.0',
			method,
			params,
		};
	}

	/**
	 * Create a JSON-RPC success response.
	 */
	createSuccessResponse(id: string | number, result: unknown): JsonRpcSuccessResponse {
		return {
			jsonrpc: '2.0',
			result,
			id,
		};
	}

	/**
	 * Create a JSON-RPC error response.
	 */
	createErrorResponse(id: string | number | null, error: JsonRpcError): JsonRpcErrorResponse {
		return {
			jsonrpc: '2.0',
			error,
			id,
		};
	}

	/**
	 * Create a standard error object.
	 */
	createError(code: number, message: string, data?: unknown): JsonRpcError {
		return { code, message, data };
	}

	/**
	 * Serialize a JSON-RPC message to a buffer.
	 */
	serialize(message: JsonRpcMessage): Buffer {
		const json = JSON.stringify(message);
		return Buffer.from(json, 'utf-8');
	}

	/**
	 * Serialize a request for sending.
	 */
	serializeRequest(method: string, params?: unknown, id?: string): Buffer {
		const request = this.createRequest(method, params, id);
		return this.serialize(request);
	}

	/**
	 * Serialize a notification for sending.
	 */
	serializeNotification(method: string, params?: unknown): Buffer {
		const notification = this.createNotification(method, params);
		return this.serialize(notification);
	}

	/**
	 * Parse a JSON-RPC message from a buffer.
	 *
	 * @throws Error if parsing fails
	 */
	parse(data: Buffer): JsonRpcMessage {
		const json = data.toString('utf-8');
		return this.parseJson(json);
	}

	/**
	 * Parse a JSON-RPC message from a string.
	 *
	 * @throws Error if parsing fails
	 */
	parseJson(json: string): JsonRpcMessage {
		let parsed: unknown;

		try {
			parsed = JSON.parse(json);
		} catch (e) {
			throw new Error(`Failed to parse JSON: ${e}`);
		}

		if (!this.isValidMessage(parsed)) {
			throw new Error('Invalid JSON-RPC message');
		}

		return parsed as JsonRpcMessage;
	}

	/**
	 * Parse multiple messages from a buffer (batch).
	 */
	parseMany(data: Buffer): JsonRpcMessage[] {
		const json = data.toString('utf-8');
		let parsed: unknown;

		try {
			parsed = JSON.parse(json);
		} catch (e) {
			throw new Error(`Failed to parse JSON: ${e}`);
		}

		if (Array.isArray(parsed)) {
			return parsed.map((item, index) => {
				if (!this.isValidMessage(item)) {
					throw new Error(`Invalid JSON-RPC message at index ${index}`);
				}
				return item as JsonRpcMessage;
			});
		}

		if (!this.isValidMessage(parsed)) {
			throw new Error('Invalid JSON-RPC message');
		}

		return [parsed as JsonRpcMessage];
	}

	/**
	 * Add length-prefix framing to a message.
	 *
	 * Uses 4-byte big-endian length prefix.
	 */
	frame(message: Buffer): Buffer {
		if (message.length > this.options.maxMessageSize) {
			throw new Error(`Message size ${message.length} exceeds maximum ${this.options.maxMessageSize}`);
		}

		const header = Buffer.alloc(4);
		header.writeUInt32BE(message.length, 0);
		return Buffer.concat([header, message]);
	}

	/**
	 * Remove length-prefix framing and extract messages.
	 *
	 * Returns extracted messages and any remaining data.
	 */
	unframe(data: Buffer): { messages: Buffer[]; remainder: Buffer } {
		const messages: Buffer[] = [];
		let offset = 0;

		while (offset + 4 <= data.length) {
			const messageLength = data.readUInt32BE(offset);

			if (messageLength === 0) {
				throw new Error('Invalid zero-length message frame');
			}

			if (messageLength > this.options.maxMessageSize) {
				throw new Error(`Message size ${messageLength} exceeds maximum ${this.options.maxMessageSize}`);
			}

			// Check if we have the complete message
			if (offset + 4 + messageLength > data.length) {
				break; // Incomplete message, wait for more data
			}

			// Extract the message
			const message = data.subarray(offset + 4, offset + 4 + messageLength);
			messages.push(Buffer.from(message)); // Copy the buffer

			offset += 4 + messageLength;
		}

		// Return remaining data (incomplete message)
		const remainder = offset < data.length ? Buffer.from(data.subarray(offset)) : Buffer.alloc(0);

		return { messages, remainder };
	}

	/**
	 * Frame and serialize a message in one step.
	 */
	frameMessage(message: JsonRpcMessage): Buffer {
		return this.frame(this.serialize(message));
	}

	/**
	 * Unframe and parse messages in one step.
	 */
	unframeMessages(data: Buffer): { messages: JsonRpcMessage[]; remainder: Buffer } {
		const { messages: rawMessages, remainder } = this.unframe(data);
		const messages: JsonRpcMessage[] = [];
		for (const raw of rawMessages) {
			try {
				messages.push(this.parse(raw));
			} catch {
				// Skip malformed messages rather than aborting the entire batch
			}
		}
		return { messages, remainder };
	}

	/**
	 * Validate that an object is a valid JSON-RPC 2.0 message.
	 */
	private isValidMessage(obj: unknown): boolean {
		if (typeof obj !== 'object' || obj === null) {
			return false;
		}

		const msg = obj as Record<string, unknown>;

		// Must have jsonrpc: "2.0"
		if (msg.jsonrpc !== '2.0') {
			return false;
		}

		// Check for valid message types
		const hasMethod = typeof msg.method === 'string';
		const hasResult = 'result' in msg;
		const hasError = 'error' in msg && typeof msg.error === 'object' && msg.error !== null;
		const hasId = 'id' in msg;

		// Request: has method and id
		if (hasMethod && hasId) {
			return true;
		}

		// Notification: has method, no id
		if (hasMethod && !hasId) {
			return true;
		}

		// Success response: has result and id
		if (hasResult && hasId) {
			return true;
		}

		// Error response: has error (id can be null)
		if (hasError) {
			const error = msg.error as Record<string, unknown>;
			return typeof error.code === 'number' && typeof error.message === 'string';
		}

		return false;
	}
}

/**
 * Create a parse error response.
 */
export function createParseErrorResponse(): JsonRpcErrorResponse {
	return {
		jsonrpc: '2.0',
		error: {
			code: JsonRpcErrorCodes.PARSE_ERROR,
			message: 'Parse error',
		},
		id: null,
	};
}

/**
 * Create an invalid request error response.
 */
export function createInvalidRequestResponse(id: string | number | null): JsonRpcErrorResponse {
	return {
		jsonrpc: '2.0',
		error: {
			code: JsonRpcErrorCodes.INVALID_REQUEST,
			message: 'Invalid Request',
		},
		id,
	};
}

/**
 * Create a method not found error response.
 */
export function createMethodNotFoundResponse(id: string | number, method: string): JsonRpcErrorResponse {
	return {
		jsonrpc: '2.0',
		error: {
			code: JsonRpcErrorCodes.METHOD_NOT_FOUND,
			message: `Method not found: ${method}`,
		},
		id,
	};
}
