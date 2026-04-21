/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import {
	JsonRpcParser,
	createParseErrorResponse,
	createInvalidRequestResponse,
	createMethodNotFoundResponse,
} from '../../core/ipc/JsonRpcParser';
import { JsonRpcErrorCodes } from '../../core/ipc/types';

suite('JsonRpcParser', () => {
	let parser: JsonRpcParser;

	setup(() => {
		parser = new JsonRpcParser();
	});

	suite('createRequest', () => {
		test('creates valid JSON-RPC 2.0 request', () => {
			const request = parser.createRequest('test.method', { foo: 'bar' });

			assert.strictEqual(request.jsonrpc, '2.0');
			assert.strictEqual(request.method, 'test.method');
			assert.deepStrictEqual(request.params, { foo: 'bar' });
			assert.ok(request.id);
		});

		test('uses provided ID', () => {
			const request = parser.createRequest('test.method', undefined, 'custom-id');

			assert.strictEqual(request.id, 'custom-id');
		});

		test('generates unique IDs', () => {
			const request1 = parser.createRequest('method1');
			const request2 = parser.createRequest('method2');

			assert.notStrictEqual(request1.id, request2.id);
		});
	});

	suite('createNotification', () => {
		test('creates valid JSON-RPC 2.0 notification', () => {
			const notification = parser.createNotification('test.notification', { data: 123 });

			assert.strictEqual(notification.jsonrpc, '2.0');
			assert.strictEqual(notification.method, 'test.notification');
			assert.deepStrictEqual(notification.params, { data: 123 });
			assert.ok(!('id' in notification));
		});
	});

	suite('createSuccessResponse', () => {
		test('creates valid success response', () => {
			const response = parser.createSuccessResponse('req-123', { result: 'ok' });

			assert.strictEqual(response.jsonrpc, '2.0');
			assert.deepStrictEqual(response.result, { result: 'ok' });
			assert.strictEqual(response.id, 'req-123');
		});

		test('works with numeric ID', () => {
			const response = parser.createSuccessResponse(42, 'result');

			assert.strictEqual(response.id, 42);
		});
	});

	suite('createErrorResponse', () => {
		test('creates valid error response', () => {
			const error = parser.createError(-32600, 'Invalid Request');
			const response = parser.createErrorResponse('req-123', error);

			assert.strictEqual(response.jsonrpc, '2.0');
			assert.strictEqual(response.error.code, -32600);
			assert.strictEqual(response.error.message, 'Invalid Request');
			assert.strictEqual(response.id, 'req-123');
		});

		test('supports null ID', () => {
			const error = parser.createError(-32700, 'Parse error');
			const response = parser.createErrorResponse(null, error);

			assert.strictEqual(response.id, null);
		});

		test('includes error data when provided', () => {
			const error = parser.createError(-32000, 'Server error', { details: 'extra info' });

			assert.deepStrictEqual(error.data, { details: 'extra info' });
		});
	});

	suite('serialize/parse', () => {
		test('round-trips request', () => {
			const original = parser.createRequest('test.method', { foo: 'bar' }, 'id-1');
			const serialized = parser.serialize(original);
			const parsed = parser.parse(serialized);

			assert.deepStrictEqual(parsed, original);
		});

		test('round-trips notification', () => {
			const original = parser.createNotification('notify', [1, 2, 3]);
			const serialized = parser.serialize(original);
			const parsed = parser.parse(serialized);

			assert.deepStrictEqual(parsed, original);
		});

		test('round-trips success response', () => {
			const original = parser.createSuccessResponse('id-1', { data: 'result' });
			const serialized = parser.serialize(original);
			const parsed = parser.parse(serialized);

			assert.deepStrictEqual(parsed, original);
		});

		test('throws on invalid JSON', () => {
			const invalidBuffer = Buffer.from('not json');

			assert.throws(() => parser.parse(invalidBuffer), /Failed to parse JSON/);
		});

		test('throws on non-object', () => {
			const nonObject = Buffer.from('"string"');

			assert.throws(() => parser.parse(nonObject), /Invalid JSON-RPC message/);
		});

		test('throws on missing jsonrpc field', () => {
			const missing = Buffer.from(JSON.stringify({ method: 'test', id: 1 }));

			assert.throws(() => parser.parse(missing), /Invalid JSON-RPC message/);
		});
	});

	suite('parseMany', () => {
		test('parses single message', () => {
			const request = parser.createRequest('method', null, 'id-1');
			const buffer = parser.serialize(request);
			const messages = parser.parseMany(buffer);

			assert.strictEqual(messages.length, 1);
			assert.deepStrictEqual(messages[0], request);
		});

		test('parses batch of messages', () => {
			const batch = [
				parser.createRequest('method1', null, 'id-1'),
				parser.createRequest('method2', null, 'id-2'),
			];
			const buffer = Buffer.from(JSON.stringify(batch));
			const messages = parser.parseMany(buffer);

			assert.strictEqual(messages.length, 2);
			assert.strictEqual((messages[0] as any).method, 'method1');
			assert.strictEqual((messages[1] as any).method, 'method2');
		});

		test('throws on invalid batch item', () => {
			const batch = [
				{ jsonrpc: '2.0', method: 'valid', id: 1 },
				{ invalid: 'message' },
			];
			const buffer = Buffer.from(JSON.stringify(batch));

			assert.throws(() => parser.parseMany(buffer), /Invalid JSON-RPC message at index 1/);
		});
	});

	suite('frame/unframe', () => {
		test('frames message with 4-byte length prefix', () => {
			const message = Buffer.from('test');
			const framed = parser.frame(message);

			assert.strictEqual(framed.length, 4 + message.length);
			assert.strictEqual(framed.readUInt32BE(0), message.length);
			assert.ok(framed.subarray(4).equals(message));
		});

		test('unframes single message', () => {
			const message = Buffer.from('hello');
			const framed = parser.frame(message);
			const { messages, remainder } = parser.unframe(framed);

			assert.strictEqual(messages.length, 1);
			assert.ok(messages[0].equals(message));
			assert.strictEqual(remainder.length, 0);
		});

		test('unframes multiple messages', () => {
			const msg1 = Buffer.from('first');
			const msg2 = Buffer.from('second');
			const combined = Buffer.concat([parser.frame(msg1), parser.frame(msg2)]);
			const { messages, remainder } = parser.unframe(combined);

			assert.strictEqual(messages.length, 2);
			assert.ok(messages[0].equals(msg1));
			assert.ok(messages[1].equals(msg2));
			assert.strictEqual(remainder.length, 0);
		});

		test('returns remainder for incomplete message', () => {
			const message = Buffer.from('complete message');
			const framed = parser.frame(message);
			const partial = framed.subarray(0, 8); // Only header + 4 bytes
			const { messages, remainder } = parser.unframe(partial);

			assert.strictEqual(messages.length, 0);
			assert.strictEqual(remainder.length, 8);
		});

		test('handles partial header', () => {
			const message = Buffer.from('test');
			const framed = parser.frame(message);
			const partialHeader = framed.subarray(0, 2); // Only 2 bytes of header
			const { messages, remainder } = parser.unframe(partialHeader);

			assert.strictEqual(messages.length, 0);
			// Partial header is preserved for combining with future data
			assert.strictEqual(remainder.length, 2);
		});

		test('throws on oversized message', () => {
			const smallParser = new JsonRpcParser({ maxMessageSize: 10 });
			const largeMessage = Buffer.alloc(20);

			assert.throws(
				() => smallParser.frame(largeMessage),
				/Message size 20 exceeds maximum 10/
			);
		});

		test('throws on oversized incoming message', () => {
			const smallParser = new JsonRpcParser({ maxMessageSize: 10 });
			const header = Buffer.alloc(4);
			header.writeUInt32BE(100, 0); // Claim message is 100 bytes

			assert.throws(
				() => smallParser.unframe(header),
				/Message size 100 exceeds maximum 10/
			);
		});
	});

	suite('frameMessage/unframeMessages', () => {
		test('round-trips JSON-RPC message', () => {
			const original = parser.createRequest('test.method', { data: 'value' }, 'req-1');
			const framed = parser.frameMessage(original);
			const { messages, remainder } = parser.unframeMessages(framed);

			assert.strictEqual(messages.length, 1);
			assert.deepStrictEqual(messages[0], original);
			assert.strictEqual(remainder.length, 0);
		});

		test('round-trips multiple messages', () => {
			const req1 = parser.createRequest('method1', null, 'id-1');
			const req2 = parser.createRequest('method2', null, 'id-2');
			const combined = Buffer.concat([
				parser.frameMessage(req1),
				parser.frameMessage(req2),
			]);

			const { messages, remainder: _remainder } = parser.unframeMessages(combined);

			assert.strictEqual(messages.length, 2);
			assert.deepStrictEqual(messages[0], req1);
			assert.deepStrictEqual(messages[1], req2);
		});
	});

	suite('helper functions', () => {
		test('createParseErrorResponse', () => {
			const response = createParseErrorResponse();

			assert.strictEqual(response.jsonrpc, '2.0');
			assert.strictEqual(response.error.code, JsonRpcErrorCodes.PARSE_ERROR);
			assert.strictEqual(response.error.message, 'Parse error');
			assert.strictEqual(response.id, null);
		});

		test('createInvalidRequestResponse', () => {
			const response = createInvalidRequestResponse('req-123');

			assert.strictEqual(response.error.code, JsonRpcErrorCodes.INVALID_REQUEST);
			assert.strictEqual(response.id, 'req-123');
		});

		test('createMethodNotFoundResponse', () => {
			const response = createMethodNotFoundResponse('req-456', 'unknown.method');

			assert.strictEqual(response.error.code, JsonRpcErrorCodes.METHOD_NOT_FOUND);
			assert.ok(response.error.message.includes('unknown.method'));
			assert.strictEqual(response.id, 'req-456');
		});
	});
});
