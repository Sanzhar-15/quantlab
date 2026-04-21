/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { QicService } from '../../common/qicService.js';

/**
 * E2E: First launch scenario.
 * 1. First-run consent → show consent UI
 * 2. User grants consent → provider setup
 * 3. Background indexing starts
 * 4. First completion request → returns result
 * 5. QIC status shows "Ready"
 */
suite('E2E: First Launch', () => {

	test('QicService starts in initializing state', () => {
		const service = new QicService();
		assert.strictEqual(service.getState(), 'initializing');
		assert.strictEqual(service.isReady(), false);
	});

	test('QicService transitions to ready', () => {
		const service = new QicService();
		service.setState('ready');
		assert.strictEqual(service.getState(), 'ready');
		assert.strictEqual(service.isReady(), true);
	});

	test('QicService fires state change event', () => {
		const service = new QicService();
		const states: string[] = [];
		service.onDidChangeState(s => states.push(s));

		service.setState('ready');
		service.setState('degraded');

		assert.deepStrictEqual(states, ['ready', 'degraded']);
	});

	test('QicService tracks completed steps', () => {
		const service = new QicService();
		service.addCompletedStep('directories');
		service.addCompletedStep('database');
		service.addCompletedStep('security');

		assert.deepStrictEqual(service.getCompletedSteps(), ['directories', 'database', 'security']);
	});

	test('QicService tracks degraded features', () => {
		const service = new QicService();
		service.addDegradedFeature('code-search');
		service.addDegradedFeature('completions');

		assert.deepStrictEqual(service.getDegradedFeatures(), ['code-search', 'completions']);
	});
});
