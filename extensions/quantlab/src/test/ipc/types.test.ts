/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import {
	JsonRpcRequest,
	JsonRpcNotification,
	JsonRpcSuccessResponse,
	JsonRpcErrorResponse,
	JsonRpcErrorCodes,
	isJsonRpcRequest,
	isJsonRpcNotification,
	isJsonRpcSuccessResponse,
	isJsonRpcErrorResponse,
} from '../../core/ipc/types';

suite('JSON-RPC Type Guards', () => {
	suite('isJsonRpcRequest', () => {
		test('returns true for valid request', () => {
			const request: JsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'test.method',
				params: { foo: 'bar' },
				id: 'req-1',
			};

			assert.strictEqual(isJsonRpcRequest(request), true);
		});

		test('returns true for request with numeric ID', () => {
			const request: JsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'test',
				id: 42,
			};

			assert.strictEqual(isJsonRpcRequest(request), true);
		});

		test('returns false for notification', () => {
			const notification: JsonRpcNotification = {
				jsonrpc: '2.0',
				method: 'notify',
			};

			assert.strictEqual(isJsonRpcRequest(notification), false);
		});

		test('returns false for response', () => {
			const response: JsonRpcSuccessResponse = {
				jsonrpc: '2.0',
				result: 'ok',
				id: 'req-1',
			};

			assert.strictEqual(isJsonRpcRequest(response), false);
		});
	});

	suite('isJsonRpcNotification', () => {
		test('returns true for valid notification', () => {
			const notification: JsonRpcNotification = {
				jsonrpc: '2.0',
				method: 'positions.update',
				params: { positions: [] },
			};

			assert.strictEqual(isJsonRpcNotification(notification), true);
		});

		test('returns true for notification without params', () => {
			const notification: JsonRpcNotification = {
				jsonrpc: '2.0',
				method: 'heartbeat',
			};

			assert.strictEqual(isJsonRpcNotification(notification), true);
		});

		test('returns false for request', () => {
			const request: JsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'test',
				id: 1,
			};

			assert.strictEqual(isJsonRpcNotification(request), false);
		});
	});

	suite('isJsonRpcSuccessResponse', () => {
		test('returns true for valid success response', () => {
			const response: JsonRpcSuccessResponse = {
				jsonrpc: '2.0',
				result: { data: 'value' },
				id: 'req-1',
			};

			assert.strictEqual(isJsonRpcSuccessResponse(response), true);
		});

		test('returns true for response with null result', () => {
			const response: JsonRpcSuccessResponse = {
				jsonrpc: '2.0',
				result: null,
				id: 1,
			};

			assert.strictEqual(isJsonRpcSuccessResponse(response), true);
		});

		test('returns false for error response', () => {
			const response: JsonRpcErrorResponse = {
				jsonrpc: '2.0',
				error: { code: -32600, message: 'Invalid Request' },
				id: 1,
			};

			assert.strictEqual(isJsonRpcSuccessResponse(response), false);
		});

		test('returns false for request', () => {
			const request: JsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'test',
				id: 1,
			};

			assert.strictEqual(isJsonRpcSuccessResponse(request), false);
		});
	});

	suite('isJsonRpcErrorResponse', () => {
		test('returns true for valid error response', () => {
			const response: JsonRpcErrorResponse = {
				jsonrpc: '2.0',
				error: {
					code: JsonRpcErrorCodes.INVALID_REQUEST,
					message: 'Invalid Request',
				},
				id: 'req-1',
			};

			assert.strictEqual(isJsonRpcErrorResponse(response), true);
		});

		test('returns true for error response with null ID', () => {
			const response: JsonRpcErrorResponse = {
				jsonrpc: '2.0',
				error: {
					code: JsonRpcErrorCodes.PARSE_ERROR,
					message: 'Parse error',
				},
				id: null,
			};

			assert.strictEqual(isJsonRpcErrorResponse(response), true);
		});

		test('returns true for error response with data', () => {
			const response: JsonRpcErrorResponse = {
				jsonrpc: '2.0',
				error: {
					code: JsonRpcErrorCodes.SERVER_ERROR,
					message: 'Server error',
					data: { details: 'Additional info' },
				},
				id: 1,
			};

			assert.strictEqual(isJsonRpcErrorResponse(response), true);
		});

		test('returns false for success response', () => {
			const response: JsonRpcSuccessResponse = {
				jsonrpc: '2.0',
				result: 'ok',
				id: 1,
			};

			assert.strictEqual(isJsonRpcErrorResponse(response), false);
		});
	});
});

suite('JSON-RPC Error Codes', () => {
	test('standard error codes are correct', () => {
		assert.strictEqual(JsonRpcErrorCodes.PARSE_ERROR, -32700);
		assert.strictEqual(JsonRpcErrorCodes.INVALID_REQUEST, -32600);
		assert.strictEqual(JsonRpcErrorCodes.METHOD_NOT_FOUND, -32601);
		assert.strictEqual(JsonRpcErrorCodes.INVALID_PARAMS, -32602);
		assert.strictEqual(JsonRpcErrorCodes.INTERNAL_ERROR, -32603);
	});

	test('custom error codes are in server range', () => {
		// Server errors should be -32000 to -32099
		assert.ok(
			JsonRpcErrorCodes.SERVER_ERROR >= -32099 &&
			JsonRpcErrorCodes.SERVER_ERROR <= -32000
		);
		assert.ok(
			JsonRpcErrorCodes.AUTHENTICATION_FAILED >= -32099 &&
			JsonRpcErrorCodes.AUTHENTICATION_FAILED <= -32000
		);
		assert.ok(
			JsonRpcErrorCodes.EXPOSURE_LIMIT_BREACH >= -32099 &&
			JsonRpcErrorCodes.EXPOSURE_LIMIT_BREACH <= -32000
		);
		assert.ok(
			JsonRpcErrorCodes.SESSION_NOT_FOUND >= -32099 &&
			JsonRpcErrorCodes.SESSION_NOT_FOUND <= -32000
		);
		assert.ok(
			JsonRpcErrorCodes.BROKER_ERROR >= -32099 &&
			JsonRpcErrorCodes.BROKER_ERROR <= -32000
		);
	});
});
