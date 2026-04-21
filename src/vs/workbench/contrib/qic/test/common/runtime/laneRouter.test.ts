/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { LaneRouter } from '../../../common/runtime/laneRouter.js';
import { ConversationState } from '../../../common/state/conversationState.js';

suite('LaneRouter', () => {

	let router: LaneRouter;
	let conversationState: ConversationState;

	setup(() => {
		router = new LaneRouter();
		conversationState = new ConversationState('test-session');
	});

	test('explicit /ask directive routes to chat-ask', () => {
		assert.strictEqual(router.classify('/ask how does this work?', conversationState), 'chat-ask');
	});

	test('explicit /edit directive routes to chat-act', () => {
		assert.strictEqual(router.classify('/edit fix the login function', conversationState), 'chat-act');
	});

	test('explicit /plan directive routes to chat-plan', () => {
		assert.strictEqual(router.classify('/plan implement auth system', conversationState), 'chat-plan');
	});

	test('explicit /apply directive routes to fast-apply', () => {
		assert.strictEqual(router.classify('/apply this change', conversationState), 'fast-apply');
	});

	test('explicit /fix directive routes to repair', () => {
		assert.strictEqual(router.classify('/fix compile errors', conversationState), 'repair');
	});

	test('tool-use pattern routes to chat-act', () => {
		assert.strictEqual(router.classify('create file src/utils.ts', conversationState), 'chat-act');
	});

	test('refactor pattern routes to chat-act', () => {
		assert.strictEqual(router.classify('refactor the database module', conversationState), 'chat-act');
	});

	test('question starting with "what" routes to chat-ask', () => {
		assert.strictEqual(router.classify('what is this function doing?', conversationState), 'chat-ask');
	});

	test('message ending with ? routes to chat-ask', () => {
		assert.strictEqual(router.classify('is this the right approach?', conversationState), 'chat-ask');
	});

	test('plan pattern routes to chat-plan', () => {
		assert.strictEqual(router.classify('plan the architecture for the new module', conversationState), 'chat-plan');
	});

	test('gather pattern routes to chat-gather', () => {
		assert.strictEqual(router.classify('find all files that import auth', conversationState), 'chat-gather');
	});

	test('context-based: stays in current lane when no clear signal', () => {
		conversationState.setLane('chat-act');
		assert.strictEqual(router.classify('ok do it', conversationState), 'chat-act');
	});

	test('defaults to chat-ask for ambiguous messages', () => {
		assert.strictEqual(router.classify('hello', conversationState), 'chat-ask');
	});
});
