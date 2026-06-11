/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ContextAssembler } from '../../../common/context/contextAssembler.js';
import type { IncrementalIndexer } from '../../../common/context/incrementalIndexer.js';
import { PROMPT_TEMPLATES } from '../../../common/canonical/prompts.js';
import { LaneRouter } from '../../../common/runtime/laneRouter.js';
import { ConversationState } from '../../../common/state/conversationState.js';

/**
 * Megaudit 2026-06-11 (H42/H43): the strategy-generation prompt overlay.
 *
 * The assembler is constructed without fileService/workspaceRoot and every
 * assemble() call passes `lightweight: true`, so the indexer is never
 * consulted -- the stub exists only to satisfy the constructor signature.
 */
suite('ContextAssembler - strategy-generation prompt overlay', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let assembler: ContextAssembler;

	setup(() => {
		const stubIndexer = {
			search: async () => [],
		} as unknown as IncrementalIndexer;
		assembler = new ContextAssembler(stubIndexer);
	});

	const strategyPrompt = PROMPT_TEMPLATES['strategy-generation'];

	test('strategy-generation template exists', () => {
		assert.ok(strategyPrompt, 'PROMPT_TEMPLATES must contain strategy-generation');
	});

	test('canonical example teaches the mandated import form (H42)', () => {
		assert.ok(
			strategyPrompt.includes('import quantlab as ql'),
			'canonical example must use the mandated `import quantlab as ql` form',
		);
		// NOTE: the prompt legitimately CONTAINS `from quantlab import Strategy`
		// as a labelled forbidden example in the IMPORTS section; only the
		// H42 bug form must be absent.
		assert.ok(
			!strategyPrompt.includes('from quantlab import ql'),
			'canonical example must not use the forbidden `from quantlab import ql` form (H42)',
		);
	});

	test('chat-plan strategy request receives the strategy-generation prompt (H43)', async () => {
		const ctx = await assembler.assemble(
			'chat-plan', 'Design a Bollinger Band strategy', { lightweight: true },
		);
		assert.strictEqual(ctx.systemPrompt, strategyPrompt);
	});

	test('chat-gather strategy request receives the strategy-generation prompt (H43)', async () => {
		const ctx = await assembler.assemble(
			'chat-gather', 'find the data loader and create a momentum strategy from it', { lightweight: true },
		);
		assert.strictEqual(ctx.systemPrompt, strategyPrompt);
	});

	test('chat-act strategy request still receives the strategy-generation prompt', async () => {
		const ctx = await assembler.assemble(
			'chat-act', 'create a strategy using RSI for AAPL', { lightweight: true },
		);
		assert.strictEqual(ctx.systemPrompt, strategyPrompt);
	});

	test('non-strategy chat-plan request keeps the chat-plan prompt', async () => {
		const ctx = await assembler.assemble(
			'chat-plan', 'plan a refactor of the settings page', { lightweight: true },
		);
		assert.strictEqual(ctx.systemPrompt, PROMPT_TEMPLATES['chat-plan']);
	});

	test('strategy phrasing on the repair lane is NOT overridden (lane gate)', async () => {
		const ctx = await assembler.assemble(
			'repair', 'create a strategy for AAPL', { lightweight: true },
		);
		assert.strictEqual(ctx.systemPrompt, PROMPT_TEMPLATES['repair']);
	});

	test('LaneRouter routes the H43 demo phrase to chat-plan (pairing proof)', () => {
		const router = new LaneRouter();
		const conversationState = new ConversationState('test-session');
		assert.strictEqual(
			router.classify('Design a Bollinger Band strategy', conversationState),
			'chat-plan',
		);
	});
});
