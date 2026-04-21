/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { MemoryManager } from '../../../common/resilience/memoryManager.js';
import { DegradationLevel } from '../../../common/resilience/degradationManager.js';
import { FIMAdapter } from '../../../common/completion/fimAdapter.js';

suite('MemoryManager', () => {

	let manager: MemoryManager;

	setup(() => {
		manager = new MemoryManager();
	});

	test('requestAllocation succeeds within budget', () => {
		assert.strictEqual(manager.requestAllocation('completionCache', 10 * 1024 * 1024), true);
	});

	test('requestAllocation fails when exceeding component budget', () => {
		// completionCache budget is 50MB
		assert.strictEqual(manager.requestAllocation('completionCache', 51 * 1024 * 1024), false);
	});

	test('requestAllocation fails for unknown component', () => {
		assert.strictEqual(manager.requestAllocation('unknown', 1024), false);
	});

	test('release frees allocation', () => {
		manager.requestAllocation('completionCache', 40 * 1024 * 1024);
		manager.release('completionCache');
		assert.strictEqual(manager.getComponentAllocation('completionCache'), 0);
	});

	test('getPressure returns normal when empty', () => {
		assert.strictEqual(manager.getPressure(), 'normal');
	});

	test('getPressure escalates with usage', () => {
		// Allocate 400MB worth across components
		manager.requestAllocation('embeddingCache', 140 * 1024 * 1024);
		manager.requestAllocation('bm25Index', 90 * 1024 * 1024);
		manager.requestAllocation('completionCache', 45 * 1024 * 1024);
		manager.requestAllocation('conversationState', 45 * 1024 * 1024);
		manager.requestAllocation('vectorIndex', 90 * 1024 * 1024);
		// Total: ~410MB out of 500MB = 82% → high
		assert.strictEqual(manager.getPressure(), 'high');
	});
});

suite('DegradationLevel', () => {

	test('levels are ordered correctly', () => {
		assert.ok(DegradationLevel.Normal < DegradationLevel.ReducedQuality);
		assert.ok(DegradationLevel.ReducedQuality < DegradationLevel.NoCompletions);
		assert.ok(DegradationLevel.NoCompletions < DegradationLevel.LocalOnly);
		assert.ok(DegradationLevel.LocalOnly < DegradationLevel.Emergency);
	});
});

suite('FIMAdapter', () => {

	let adapter: FIMAdapter;

	setup(() => {
		adapter = new FIMAdapter();
	});

	test('formats Anthropic FIM request', () => {
		const result = adapter.formatFIMRequest('function foo(', ') {}', 'anthropic');
		assert.ok(result.prompt.includes('<|fim_prefix|>function foo('));
		assert.ok(result.prompt.includes('<|fim_suffix|>) {}'));
		assert.ok(result.prompt.includes('<|fim_middle|>'));
	});

	test('formats Ollama FIM request', () => {
		const result = adapter.formatFIMRequest('def hello(', '):', 'ollama');
		assert.ok(result.prompt.includes('<PRE>'));
		assert.ok(result.prompt.includes('<SUF>'));
		assert.ok(result.prompt.includes('<MID>'));
	});

	test('formats instruction-based request', () => {
		const result = adapter.formatInstructionRequest('const x = ', ';', 'typescript');
		assert.ok(result.prompt.includes('typescript'));
		assert.ok(result.prompt.includes('Code before cursor'));
		assert.ok(result.prompt.includes('Code after cursor'));
	});

	test('uses default format for unknown provider', () => {
		const result = adapter.formatFIMRequest('prefix', 'suffix', 'unknown-provider');
		assert.ok(result.prompt.includes('<|fim_prefix|>'));
	});
});
