/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ToolRouter } from '../../../common/runtime/toolRouter.js';
import { LaneRouter } from '../../../common/runtime/laneRouter.js';
import { PermissionManager } from '../../../common/runtime/permissionManager.js';
import { TestSecurityAuditLogger } from '../../../common/runtime/securityAuditLoggerStub.js';
import { TestUIService } from '../../../common/runtime/uiServiceStub.js';
import type { ToolContext, ToolCall } from '../../../common/canonical/types.js';

suite('ToolRouter', () => {

	let toolRouter: ToolRouter;
	let permissionManager: PermissionManager;

	setup(() => {
		const uiService = new TestUIService();
		const store = {
			get: () => null,
			set: () => {},
		};
		permissionManager = new PermissionManager(store, uiService);
		const logger = new TestSecurityAuditLogger();
		toolRouter = new ToolRouter(permissionManager, logger);
	});

	test('register() adds a tool implementation', () => {
		toolRouter.register('test_tool', async () => ({
			content: 'hello',
			isError: false,
		}));
		// No error means registration succeeded
	});

	test('register() throws on duplicate registration (X-PS2)', () => {
		toolRouter.register('dup_tool', async () => ({ content: '', isError: false }));
		assert.throws(
			() => toolRouter.register('dup_tool', async () => ({ content: '', isError: false })),
			/already registered/
		);
	});

	test('execute() returns error for unregistered tool', async () => {
		const call: ToolCall = { id: 'tc1', name: 'nonexistent', arguments: {} };
		const context: ToolContext = {
			sessionId: 'test',
			workspacePath: '/test',
			permissions: new Map(),
		};

		const result = await toolRouter.execute(call, context);
		assert.strictEqual(result.isError, true);
		assert.ok(result.content.includes('Unknown tool'));
	});

	test('execute() runs registered tool and returns result', async () => {
		// Set env for auto-approval
		process.env.QIC_AUTO_APPROVE_FOR_TESTING = 'true';

		toolRouter.register('read_file', async (args) => ({
			content: `Read: ${args.path}`,
			isError: false,
		}));

		const call: ToolCall = { id: 'tc2', name: 'read_file', arguments: { path: '/test.ts' } };
		const context: ToolContext = {
			sessionId: 'test',
			workspacePath: '/test',
			permissions: new Map(),
		};

		const result = await toolRouter.execute(call, context);
		assert.strictEqual(result.toolCallId, 'tc2');
		assert.strictEqual(result.content, 'Read: /test.ts');
		assert.strictEqual(result.isError, false);

		delete process.env.QIC_AUTO_APPROVE_FOR_TESTING;
	});
});

suite('LaneRouter', () => {

	test('directives override all other classification', () => {
		const router = new LaneRouter();
		const { ConversationState } = require('../../../common/state/conversationState.js');
		const state = new ConversationState('test');
		assert.strictEqual(router.classify('/edit something', state), 'chat-act');
	});
});

suite('PermissionManager', () => {

	test('isStrategyFile detects strategy paths (III-QI4)', () => {
		const store = { get: () => null, set: () => {} };
		const pm = new PermissionManager(store, new TestUIService());

		assert.strictEqual(pm.isStrategyFile('/project/strategies/momentum.py'), true);
		assert.strictEqual(pm.isStrategyFile('/project/strategy/pairs.ts'), true);
		assert.strictEqual(pm.isStrategyFile('/project/src/main.strategy.ts'), true);
		assert.strictEqual(pm.isStrategyFile('/project/backtest/runner.py'), true);
		assert.strictEqual(pm.isStrategyFile('/project/src/utils.ts'), false);
		assert.strictEqual(pm.isStrategyFile(undefined), false);
	});
});

suite('TestSecurityAuditLogger', () => {

	test('logToolCall does not throw (X-PS3)', () => {
		const logger = new TestSecurityAuditLogger();
		logger.logToolCall({
			toolName: 'test',
			action: 'execute',
			sessionId: 'test',
			timestamp: new Date().toISOString(),
		});
	});

	test('flush resolves (X-PS3)', async () => {
		const logger = new TestSecurityAuditLogger();
		await logger.flush();
	});
});
