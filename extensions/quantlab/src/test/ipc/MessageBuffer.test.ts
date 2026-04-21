/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import {
	MessageBuffer,
	getTierForMethod,
	createMessageBuffer,
} from '../../core/ipc/MessageBuffer';
import { JsonRpcRequest, JsonRpcNotification } from '../../core/ipc/types';

function createMockRequest(method: string, id: string): JsonRpcRequest {
	return { jsonrpc: '2.0', method, id };
}

function createMockNotification(method: string): JsonRpcNotification {
	return { jsonrpc: '2.0', method };
}

suite('MessageBuffer', () => {
	let buffer: MessageBuffer;

	setup(() => {
		buffer = new MessageBuffer();
	});

	suite('enqueue/dequeue', () => {
		test('enqueues and dequeues critical message', () => {
			const msg = createMockRequest('order.submit', 'req-1');
			const id = buffer.enqueue(msg, 'critical');

			assert.ok(id.startsWith('buf-'));

			const dequeued = buffer.dequeue('critical');

			assert.ok(dequeued);
			assert.deepStrictEqual(dequeued.message, msg);
			assert.strictEqual(dequeued.tier, 'critical');
			assert.strictEqual(dequeued.ackRequired, true);
		});

		test('enqueues and dequeues important message', () => {
			const msg = createMockRequest('positions.get', 'req-1');
			buffer.enqueue(msg, 'important');

			const dequeued = buffer.dequeue('important');

			assert.ok(dequeued);
			assert.strictEqual(dequeued.tier, 'important');
			assert.strictEqual(dequeued.ackRequired, false);
		});

		test('enqueues and dequeues telemetry message', () => {
			const msg = createMockNotification('heartbeat');
			buffer.enqueue(msg, 'telemetry');

			const dequeued = buffer.dequeue('telemetry');

			assert.ok(dequeued);
			assert.strictEqual(dequeued.tier, 'telemetry');
		});

		test('dequeueAny respects priority order', () => {
			buffer.enqueue(createMockNotification('heartbeat'), 'telemetry');
			buffer.enqueue(createMockRequest('position.get', 'req-1'), 'important');
			buffer.enqueue(createMockRequest('order.submit', 'req-2'), 'critical');

			// Should dequeue critical first
			const first = buffer.dequeueAny();
			assert.strictEqual(first?.tier, 'critical');

			// Then important
			const second = buffer.dequeueAny();
			assert.strictEqual(second?.tier, 'important');

			// Then telemetry
			const third = buffer.dequeueAny();
			assert.strictEqual(third?.tier, 'telemetry');

			// Then undefined
			const fourth = buffer.dequeueAny();
			assert.strictEqual(fourth, undefined);
		});

		test('returns undefined when tier is empty', () => {
			const result = buffer.dequeue('critical');
			assert.strictEqual(result, undefined);
		});
	});

	suite('limits and overflow', () => {
		test('important tier drops oldest when full', () => {
			const smallBuffer = new MessageBuffer({ importantLimit: 3 });

			smallBuffer.enqueue(createMockRequest('msg1', '1'), 'important');
			smallBuffer.enqueue(createMockRequest('msg2', '2'), 'important');
			smallBuffer.enqueue(createMockRequest('msg3', '3'), 'important');
			smallBuffer.enqueue(createMockRequest('msg4', '4'), 'important');

			// Should still have only 3
			assert.strictEqual(smallBuffer.count('important'), 3);

			// First message should be msg2 (msg1 was dropped)
			const first = smallBuffer.dequeue('important');
			assert.strictEqual((first?.message as JsonRpcRequest).id, '2');
		});

		test('telemetry tier drops oldest when full', () => {
			const smallBuffer = new MessageBuffer({ telemetryLimit: 2 });

			smallBuffer.enqueue(createMockNotification('ping1'), 'telemetry');
			smallBuffer.enqueue(createMockNotification('ping2'), 'telemetry');
			smallBuffer.enqueue(createMockNotification('ping3'), 'telemetry');

			assert.strictEqual(smallBuffer.count('telemetry'), 2);
		});

		test('critical tier is unlimited', () => {
			// Critical tier should not drop
			for (let i = 0; i < 100; i++) {
				buffer.enqueue(createMockRequest('order.submit', `req-${i}`), 'critical');
			}

			assert.strictEqual(buffer.count('critical'), 100);
		});

		test('calls onOverflow handler', () => {
			const overflows: Array<{ tier: string; dropped: number }> = [];
			const smallBuffer = new MessageBuffer(
				{ importantLimit: 2 },
				{ onOverflow: (tier, dropped) => overflows.push({ tier, dropped }) }
			);

			smallBuffer.enqueue(createMockRequest('msg1', '1'), 'important');
			smallBuffer.enqueue(createMockRequest('msg2', '2'), 'important');
			smallBuffer.enqueue(createMockRequest('msg3', '3'), 'important');

			assert.strictEqual(overflows.length, 1);
			assert.strictEqual(overflows[0].tier, 'important');
			assert.strictEqual(overflows[0].dropped, 1);
		});

		test('calls onCriticalWarning when threshold exceeded', () => {
			const warnings: number[] = [];
			const smallBuffer = new MessageBuffer(
				{ criticalLimit: 2 },
				{ onCriticalWarning: (count) => warnings.push(count) }
			);

			smallBuffer.enqueue(createMockRequest('msg1', '1'), 'critical');
			smallBuffer.enqueue(createMockRequest('msg2', '2'), 'critical');

			assert.strictEqual(warnings.length, 1);
			assert.strictEqual(warnings[0], 2);
		});
	});

	suite('peek', () => {
		test('returns first message without removing', () => {
			buffer.enqueue(createMockRequest('first', '1'), 'critical');
			buffer.enqueue(createMockRequest('second', '2'), 'critical');

			const peeked = buffer.peek('critical');
			assert.strictEqual((peeked?.message as JsonRpcRequest).id, '1');

			// Still there
			const peekedAgain = buffer.peek('critical');
			assert.strictEqual((peekedAgain?.message as JsonRpcRequest).id, '1');

			assert.strictEqual(buffer.count('critical'), 2);
		});

		test('returns undefined for empty tier', () => {
			const result = buffer.peek('important');
			assert.strictEqual(result, undefined);
		});
	});

	suite('flush', () => {
		test('flushes all messages from tier', () => {
			buffer.enqueue(createMockRequest('msg1', '1'), 'critical');
			buffer.enqueue(createMockRequest('msg2', '2'), 'critical');
			buffer.enqueue(createMockRequest('msg3', '3'), 'important');

			const flushed = buffer.flush('critical');

			assert.strictEqual(flushed.length, 2);
			assert.strictEqual(buffer.count('critical'), 0);
			assert.strictEqual(buffer.count('important'), 1);
		});

		test('flushAll clears all tiers', () => {
			buffer.enqueue(createMockRequest('msg1', '1'), 'critical');
			buffer.enqueue(createMockRequest('msg2', '2'), 'important');
			buffer.enqueue(createMockNotification('ping'), 'telemetry');

			const all = buffer.flushAll();

			assert.strictEqual(all.length, 3);
			assert.strictEqual(buffer.totalCount(), 0);
		});
	});

	suite('getById/removeById', () => {
		test('finds message by ID', () => {
			const id = buffer.enqueue(createMockRequest('test', 'req-1'), 'important');
			const found = buffer.getById(id);

			assert.ok(found);
			assert.strictEqual(found.id, id);
		});

		test('returns undefined for unknown ID', () => {
			const found = buffer.getById('unknown');
			assert.strictEqual(found, undefined);
		});

		test('removes message by ID', () => {
			const id = buffer.enqueue(createMockRequest('test', 'req-1'), 'important');

			const removed = buffer.removeById(id);
			assert.strictEqual(removed, true);
			assert.strictEqual(buffer.count('important'), 0);
		});

		test('returns false when removing unknown ID', () => {
			const removed = buffer.removeById('unknown');
			assert.strictEqual(removed, false);
		});
	});

	suite('incrementRetry', () => {
		test('increments retry count', () => {
			const id = buffer.enqueue(createMockRequest('test', 'req-1'), 'critical');

			const count1 = buffer.incrementRetry(id);
			assert.strictEqual(count1, 1);

			const count2 = buffer.incrementRetry(id);
			assert.strictEqual(count2, 2);

			const msg = buffer.getById(id);
			assert.strictEqual(msg?.retryCount, 2);
		});

		test('returns -1 for unknown ID', () => {
			const count = buffer.incrementRetry('unknown');
			assert.strictEqual(count, -1);
		});
	});

	suite('count/isEmpty', () => {
		test('count returns correct counts', () => {
			buffer.enqueue(createMockRequest('msg1', '1'), 'critical');
			buffer.enqueue(createMockRequest('msg2', '2'), 'critical');
			buffer.enqueue(createMockRequest('msg3', '3'), 'important');

			assert.strictEqual(buffer.count('critical'), 2);
			assert.strictEqual(buffer.count('important'), 1);
			assert.strictEqual(buffer.count('telemetry'), 0);
		});

		test('totalCount returns sum of all tiers', () => {
			buffer.enqueue(createMockRequest('msg1', '1'), 'critical');
			buffer.enqueue(createMockRequest('msg2', '2'), 'important');
			buffer.enqueue(createMockNotification('ping'), 'telemetry');

			assert.strictEqual(buffer.totalCount(), 3);
		});

		test('isEmpty returns true when empty', () => {
			assert.strictEqual(buffer.isEmpty(), true);

			buffer.enqueue(createMockNotification('ping'), 'telemetry');
			assert.strictEqual(buffer.isEmpty(), false);
		});

		test('isTierEmpty returns correct value', () => {
			assert.strictEqual(buffer.isTierEmpty('critical'), true);

			buffer.enqueue(createMockRequest('msg', '1'), 'critical');
			assert.strictEqual(buffer.isTierEmpty('critical'), false);
		});
	});

	suite('getStats', () => {
		test('returns correct statistics', () => {
			buffer.enqueue(createMockRequest('msg1', '1'), 'critical');
			buffer.enqueue(createMockRequest('msg2', '2'), 'important');
			buffer.enqueue(createMockNotification('ping'), 'telemetry');

			const stats = buffer.getStats();

			assert.strictEqual(stats.criticalCount, 1);
			assert.strictEqual(stats.importantCount, 1);
			assert.strictEqual(stats.telemetryCount, 1);
			assert.strictEqual(stats.totalCount, 3);
			assert.ok(stats.oldestMessageAge !== null && stats.oldestMessageAge >= 0);
		});

		test('tracks dropped message counts', () => {
			const smallBuffer = new MessageBuffer({ importantLimit: 1, telemetryLimit: 1 });

			smallBuffer.enqueue(createMockRequest('msg1', '1'), 'important');
			smallBuffer.enqueue(createMockRequest('msg2', '2'), 'important');
			smallBuffer.enqueue(createMockNotification('ping1'), 'telemetry');
			smallBuffer.enqueue(createMockNotification('ping2'), 'telemetry');

			const stats = smallBuffer.getStats();

			assert.strictEqual(stats.importantDropped, 1);
			assert.strictEqual(stats.telemetryDropped, 1);
		});
	});

	suite('clear', () => {
		test('clears all messages and counters', () => {
			const smallBuffer = new MessageBuffer({ importantLimit: 1 });

			smallBuffer.enqueue(createMockRequest('msg1', '1'), 'critical');
			smallBuffer.enqueue(createMockRequest('msg2', '2'), 'important');
			smallBuffer.enqueue(createMockRequest('msg3', '3'), 'important'); // Causes drop

			smallBuffer.clear();

			assert.strictEqual(smallBuffer.totalCount(), 0);
			const stats = smallBuffer.getStats();
			assert.strictEqual(stats.importantDropped, 0);
		});
	});
});

suite('getTierForMethod', () => {
	test('classifies critical methods', () => {
		assert.strictEqual(getTierForMethod('order.submit'), 'critical');
		assert.strictEqual(getTierForMethod('order.cancel'), 'critical');
		assert.strictEqual(getTierForMethod('session.stop'), 'critical');
		assert.strictEqual(getTierForMethod('session.pause'), 'critical');
		assert.strictEqual(getTierForMethod('risk.alert'), 'critical');
		assert.strictEqual(getTierForMethod('flatten.all'), 'critical');
	});

	test('classifies telemetry methods', () => {
		assert.strictEqual(getTierForMethod('heartbeat'), 'telemetry');
		assert.strictEqual(getTierForMethod('metrics'), 'telemetry');
		assert.strictEqual(getTierForMethod('telemetry.update'), 'telemetry');
		assert.strictEqual(getTierForMethod('ping'), 'telemetry');
	});

	test('defaults to important for other methods', () => {
		assert.strictEqual(getTierForMethod('positions.update'), 'important');
		assert.strictEqual(getTierForMethod('fills.update'), 'important');
		assert.strictEqual(getTierForMethod('unknown.method'), 'important');
	});
});

suite('createMessageBuffer', () => {
	test('creates buffer with defaults', () => {
		const buffer = createMessageBuffer();
		assert.ok(buffer instanceof MessageBuffer);
	});

	test('creates buffer with custom config', () => {
		const buffer = createMessageBuffer({ importantLimit: 500 });
		// Fill beyond default but within custom
		for (let i = 0; i < 500; i++) {
			buffer.enqueue(createMockRequest(`msg${i}`, `${i}`), 'important');
		}
		assert.strictEqual(buffer.count('important'), 500);
	});
});
