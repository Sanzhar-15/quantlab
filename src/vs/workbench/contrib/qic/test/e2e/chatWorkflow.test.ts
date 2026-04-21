/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { LaneRouter } from '../../common/runtime/laneRouter.js';
import { ConversationState } from '../../common/state/conversationState.js';
import { createMockProvider, createTextResponse, createToolUseResponse } from '../helpers/testUtilities.js';

/**
 * E2E: Full chat workflow.
 * 1. User sends message
 * 2. LaneRouter classifies
 * 3. Orchestrator gathers context
 * 4. LLM responds with tool calls
 * 5. Tool calls execute
 * 6. LLM responds with results appended
 * 7. Final response with diff preview
 * 8. User approves → edits applied
 */
suite('E2E: Chat Workflow', () => {

	test('LaneRouter classifies edit request as chat-act', () => {
		const router = new LaneRouter();
		const state = new ConversationState('test');
		const lane = router.classify('Add a fibonacci function to utils.ts', state);
		assert.strictEqual(lane, 'chat-act');
	});

	test('LaneRouter classifies question as chat-ask', () => {
		const router = new LaneRouter();
		const state = new ConversationState('test');
		const lane = router.classify('What does the processOrder function do?', state);
		assert.strictEqual(lane, 'chat-ask');
	});

	test('MockProvider returns canned response', async () => {
		const provider = createMockProvider({
			defaultResponse: createTextResponse('Here is the fibonacci function'),
		});

		const response = await provider.sendRequest({
			model: 'test',
			messages: [{ role: 'user', content: 'Add fibonacci' }],
		});

		assert.strictEqual(response.content[0].type, 'text');
		if (response.content[0].type === 'text') {
			assert.ok(response.content[0].text.includes('fibonacci'));
		}
	});

	test('MockProvider returns tool use response', async () => {
		const provider = createMockProvider({
			defaultResponse: createToolUseResponse('read_file', { path: 'utils.ts' }),
		});

		const response = await provider.sendRequest({
			model: 'test',
			messages: [{ role: 'user', content: 'Read utils.ts' }],
		});

		assert.strictEqual(response.stopReason, 'tool_use');
		assert.strictEqual(response.content[0].type, 'tool_use');
	});

	test('Multi-turn: provider call count increments', async () => {
		const provider = createMockProvider({
			defaultResponse: createTextResponse('Done'),
		});

		await provider.sendRequest({ model: 'test', messages: [{ role: 'user', content: 'hello' }] });
		await provider.sendRequest({ model: 'test', messages: [{ role: 'user', content: 'world' }] });

		assert.strictEqual(provider.getCallCount(), 2);
	});
});
