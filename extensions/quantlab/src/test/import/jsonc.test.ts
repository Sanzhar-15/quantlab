/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import { parseJsonc } from '../../import/jsonc';

suite('import – jsonc', () => {

	test('line and block comments are removed', () => {
		assert.deepStrictEqual(parseJsonc('// head\n{ "a": 1, /* mid */ "b": [2] } // tail', 'f'), { a: 1, b: [2] });
	});

	test('trailing commas are removed', () => {
		assert.deepStrictEqual(parseJsonc('{ "a": [1, 2, ], "b": { "c": 3, }, }', 'f'), { a: [1, 2], b: { c: 3 } });
	});

	test('comment markers and commas inside strings are kept', () => {
		assert.deepStrictEqual(
			parseJsonc('{ "url": "http://x/y", "c": "/* no */", "t": "a,]", "q": "say \\"hi\\" // still" }', 'f'),
			{ url: 'http://x/y', c: '/* no */', t: 'a,]', q: 'say "hi" // still' }
		);
	});

	test('a UTF-8 BOM is ignored', () => {
		assert.deepStrictEqual(parseJsonc('\uFEFF[1]', 'f'), [1]);
	});

	test('malformed text throws, naming the file', () => {
		assert.throws(() => parseJsonc('{ "a": }', 'settings.json'), /^Error: settings\.json: invalid JSON/);
		assert.throws(() => parseJsonc('{ /* open', 'settings.json'), /settings\.json: unterminated block comment/);
	});

	test('empty text throws, naming the file', () => {
		assert.throws(() => parseJsonc('', 'keys.json'), /keys\.json: no JSON content/);
		assert.throws(() => parseJsonc(' // only a comment\n', 'keys.json'), /keys\.json: no JSON content/);
	});
});
