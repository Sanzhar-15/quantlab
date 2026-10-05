/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { describeSecretPresence } from '../../../common/security/secretPresence.js';

// Made-up sentinels, not keys. They share no 4-character window with the fixed log text.
const ANTHROPIC_SENTINEL = 'SENTINEL-A-7Q2X9K4M';
const OPENAI_SENTINEL = 'SENTINEL-O-3V8W1Z6P';

function assertNoFragment(text: string, secret: string): void {
	for (let i = 0; i + 4 <= secret.length; i++) {
		const fragment = secret.substring(i, i + 4);
		assert.ok(!text.includes(fragment), `log text '${text}' contains the key fragment '${fragment}'`);
	}
}

suite('describeSecretPresence', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no 4-character window of either key reaches the log text', () => {
		const text = describeSecretPresence(ANTHROPIC_SENTINEL, OPENAI_SENTINEL);
		assertNoFragment(text, ANTHROPIC_SENTINEL);
		assertNoFragment(text, OPENAI_SENTINEL);
	});

	test('says found / not found for each key', () => {
		assert.strictEqual(describeSecretPresence(ANTHROPIC_SENTINEL, OPENAI_SENTINEL), 'Secret storage lookup: anthropic=found, openai=found');
		assert.strictEqual(describeSecretPresence(ANTHROPIC_SENTINEL, undefined), 'Secret storage lookup: anthropic=found, openai=not found');
		assert.strictEqual(describeSecretPresence(undefined, OPENAI_SENTINEL), 'Secret storage lookup: anthropic=not found, openai=found');
		assert.strictEqual(describeSecretPresence(undefined, undefined), 'Secret storage lookup: anthropic=not found, openai=not found');
		assert.strictEqual(describeSecretPresence('', ''), 'Secret storage lookup: anthropic=not found, openai=not found');
	});

	test('the fragment check is not vacuous: the sentinels share no window with the fixed text', () => {
		assertNoFragment(describeSecretPresence(undefined, undefined), ANTHROPIC_SENTINEL);
		assertNoFragment(describeSecretPresence(undefined, undefined), OPENAI_SENTINEL);
		assert.throws(() => assertNoFragment(`found (${ANTHROPIC_SENTINEL.substring(0, 10)}...)`, ANTHROPIC_SENTINEL));
	});
});
