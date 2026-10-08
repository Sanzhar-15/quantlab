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

	// Later entries win in VS Code: the winner of a key is the LAST entry bound to it.
	const A = { key: 'cmd+k', command: 'one' };
	const B = { key: 'cmd+k', command: 'two' };
	const winner = (entries: unknown[], key: string) => [...entries].reverse().find(e => (e as { key: string }).key === key);

	test('keybindings: mergeKeybindings([A,B],[A]) resolves to A, which is after B', () => {
		const result = mergeKeybindings([A, B], [{ command: 'one', key: 'cmd+k' }]);
		assert.deepStrictEqual(result.merged, [B, A]);
		assert.deepStrictEqual(winner(result.merged, 'cmd+k'), A);
		assert.strictEqual(result.added, 0);
		assert.strictEqual(result.duplicates, 1);
	});

	test('keybindings: importing [A,B,A] resolves to A, as the source itself does', () => {
		const result = mergeKeybindings([], [A, B, A]);
		assert.deepStrictEqual(result.merged, [B, A]);
		assert.deepStrictEqual(winner(result.merged, 'cmd+k'), A);
		assert.strictEqual(result.added, 2);
		assert.strictEqual(result.duplicates, 1);
	});

	// QL-G-FEAT c2 M4: a conflict is decided as the editor resolves keys, not by comparing the `key` strings.
	test('keybindings: another spelling of the same key between two occurrences of A is a conflict, so A is kept last', () => {
		for (const spelling of ['Cmd+K', 'cmd-k', ' cmd+k ', 'meta+k', 'win+k', 'CMD-K']) {
			const other = { key: spelling, command: 'two' };
			assert.deepStrictEqual(mergeKeybindings([A, other], [A]).merged, [other, A], `existing [A, ${JSON.stringify(spelling)}], imported [A]`);
			assert.deepStrictEqual(mergeKeybindings([], [A, other, A]).merged, [other, A], `imported [A, ${JSON.stringify(spelling)}, A]`);
		}
	});

	test('keybindings: modifiers in another order are the same key', () => {
		const first = { key: 'shift+cmd+k', command: 'one' };
		const other = { key: 'cmd+shift+k', command: 'two' };
		assert.deepStrictEqual(mergeKeybindings([first, other], [first]).merged, [other, first]);
	});

	test('keybindings: a chord sequence that begins with the key, or that the key begins, is a conflict', () => {
		const longer = { key: 'cmd+k cmd+x', command: 'two' };
		assert.deepStrictEqual(mergeKeybindings([A, longer], [A]).merged, [longer, A]);
		assert.deepStrictEqual(mergeKeybindings([], [A, longer, A]).merged, [longer, A]);
		const chord = { key: 'Cmd+K  Cmd+X', command: 'one' };
		const prefix = { key: 'cmd-k', command: 'two' };
		assert.deepStrictEqual(mergeKeybindings([chord, prefix], [chord]).merged, [prefix, chord]);
	});

	test('keybindings: a different key, or a chord sequence that differs in its first chord, is no conflict', () => {
		for (const key of ['cmd+j', 'cmd+j cmd+k', 'ctrl+k', 'cmd+shift+k', 'k']) {
			const other = { key, command: 'two' };
			assert.deepStrictEqual(mergeKeybindings([A, other], [A]).merged, [A, other], `key ${JSON.stringify(key)}`);
		}
	});

	test('keybindings: an identical re-import with no conflicting binding in between adds nothing and moves nothing', () => {
		const C = { key: 'cmd+j', command: 'three' };
		for (const existing of [[A], [A, C], [C, A], [B, A], [A, B]]) {
			const result = mergeKeybindings(existing, [A]);
			assert.strictEqual(result.added, 0);
			// Only the case where B sits after the existing A may reorder (A must beat B again); every other case is untouched.
			if (existing[0] === A && existing.includes(B)) {
				assert.deepStrictEqual(result.merged, [B, A]);
			} else {
				assert.deepStrictEqual(result.merged, existing);
			}
		}
		const twice = mergeKeybindings(mergeKeybindings([], [A, B, A]).merged, [A, B, A]);
		assert.deepStrictEqual(twice.merged, [B, A]);
		assert.strictEqual(twice.added, 0);
	});
});

