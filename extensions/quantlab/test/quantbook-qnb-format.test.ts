/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-0) -- unit tests for the vscode-free `.qnb` parse/stringify core.

import * as assert from 'assert';

import { parseQnb, QnbDoc, QNB_VERSION, stringifyQnb } from '../src/quantbook/reactiveNotebook/qnbFormat';

suite('qnb format', () => {
	test('round-trips a document (parse o stringify is identity)', () => {
		const doc: QnbDoc = {
			qnbVersion: QNB_VERSION,
			workbookPath: '/tmp/book.qbook',
			cells: [
				{ kind: 'code', source: 'x = 7\nqb.publish("x", x, "S0!B1")' },
				{ kind: 'markdown', source: '# notes' },
				{ kind: 'code', source: '' },
			],
		};
		const back = parseQnb(stringifyQnb(doc));
		assert.deepStrictEqual(back, doc);
	});

	test('stringify is stable (stringify o parse o stringify is fixed)', () => {
		const text = stringifyQnb({ qnbVersion: QNB_VERSION, cells: [{ kind: 'code', source: 'a = 1' }] });
		assert.strictEqual(stringifyQnb(parseQnb(text)), text);
	});

	test('empty / whitespace text is a valid EMPTY notebook', () => {
		assert.deepStrictEqual(parseQnb(''), { qnbVersion: QNB_VERSION, cells: [] });
		assert.deepStrictEqual(parseQnb('   \n  '), { qnbVersion: QNB_VERSION, cells: [] });
	});

	test('workbookPath is omitted when absent', () => {
		const text = stringifyQnb({ qnbVersion: QNB_VERSION, cells: [] });
		assert.ok(!text.includes('workbookPath'), 'absent workbookPath must not be serialized');
		assert.strictEqual(parseQnb(text).workbookPath, undefined);
	});

	test('rejects invalid JSON', () => {
		assert.throws(() => parseQnb('{not json'), /\[qnb_parse\] not valid JSON/);
	});

	test('rejects a non-object top level', () => {
		assert.throws(() => parseQnb('[1,2,3]'), /\[qnb_parse\] top-level value must be a JSON object/);
	});

	test('rejects an unsupported version', () => {
		assert.throws(() => parseQnb('{"qnbVersion":2,"cells":[]}'), /unsupported qnbVersion 2/);
		assert.throws(() => parseQnb('{"cells":[]}'), /unsupported qnbVersion/);
	});

	test('rejects non-array cells', () => {
		assert.throws(() => parseQnb('{"qnbVersion":1,"cells":{}}'), /"cells" must be an array/);
	});

	test('rejects a bad cell kind', () => {
		assert.throws(
			() => parseQnb('{"qnbVersion":1,"cells":[{"kind":"raw","source":""}]}'),
			/cell 0 kind must be "code" or "markdown"/,
		);
	});

	test('rejects a non-string cell source', () => {
		assert.throws(
			() => parseQnb('{"qnbVersion":1,"cells":[{"kind":"code","source":5}]}'),
			/cell 0 source must be a string/,
		);
	});

	test('rejects a non-string workbookPath', () => {
		assert.throws(
			() => parseQnb('{"qnbVersion":1,"cells":[],"workbookPath":5}'),
			/workbookPath must be a string/,
		);
	});

	test('stringify refuses a non-v1 in-memory doc (no silent downgrade)', () => {
		assert.throws(
			() => stringifyQnb({ qnbVersion: 2, cells: [] } as unknown as QnbDoc),
			/cannot serialize qnbVersion 2/,
		);
	});
});
