/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import { mergeKeybindings, mergeSettings } from '../../import/merge';

suite('import – merge', () => {

	test('settings: added, overwritten, unchanged; existing keys keep their order', () => {
		const result = mergeSettings(
			{ a: 1, b: { x: 1, y: 2 }, c: 'keep' },
			{ b: { y: 2, x: 1 }, a: 2, d: true }
		);
		assert.deepStrictEqual(result.added, ['d']);
		assert.deepStrictEqual(result.overwritten, ['a']);
		assert.deepStrictEqual(result.unchanged, ['b']);
		assert.deepStrictEqual(Object.keys(result.merged), ['a', 'b', 'c', 'd']);
		assert.deepStrictEqual(result.merged, { a: 2, b: { y: 2, x: 1 }, c: 'keep', d: true });
	});

	test('keybindings: imported entries go last, duplicates are dropped', () => {
		const existing = [{ key: 'cmd+a', command: 'one' }];
		const result = mergeKeybindings(existing, [{ command: 'one', key: 'cmd+a' }, { key: 'cmd+b', command: 'two' }, { key: 'cmd+b', command: 'two' }]);
		assert.strictEqual(result.added, 1);
		assert.strictEqual(result.duplicates, 2);
		assert.deepStrictEqual(result.merged, [{ key: 'cmd+a', command: 'one' }, { key: 'cmd+b', command: 'two' }]);
	});
});
