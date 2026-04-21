/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { StrategyValidator } from '../core/strategy/StrategyValidator';

suite('StrategyValidator', () => {
	const validator = StrategyValidator.getInstance();

	function createDocument(text: string, languageId = 'python', fileName = 'strategy.py', version = 1): vscode.TextDocument {
		return {
			languageId,
			fileName,
			uri: vscode.Uri.parse(`file:///${fileName}`),
			getText: () => text,
			isUntitled: false,
			version
		} as vscode.TextDocument;
	}

	test('detects vectorized strategy entrypoint', () => {
		const entrypoint = validator.detectEntrypointFromText('def strategy(data):\n    pass');

		assert.deepStrictEqual(entrypoint, { type: 'vectorized', functionName: 'strategy' });
	});

	test('detects event-driven strategy entrypoint', () => {
		const entrypoint = validator.detectEntrypointFromText('def on_bar(ctx):\n    pass');

		assert.deepStrictEqual(entrypoint, { type: 'eventDriven', functionName: 'on_bar' });
	});

	test('detects class-based strategy entrypoint', () => {
		const entrypoint = validator.detectEntrypointFromText('class MyStrategy(ql.Strategy):\n    pass');

		assert.deepStrictEqual(entrypoint, { type: 'classBased', className: 'MyStrategy' });
	});

	test('marks non-python documents as invalid', () => {
		const doc = createDocument('print("hi")', 'plaintext', 'notes.txt');
		const result = validator.validateDocument(doc);

		assert.strictEqual(result.isValid, false);
		assert.strictEqual(result.errors[0]?.code, 'NOT_PYTHON');
	});

	test('marks python utility modules as invalid', () => {
		const doc = createDocument('print("hi")', 'python', 'utils.py');
		const result = validator.validateDocument(doc);

		assert.strictEqual(result.isValid, false);
		assert.strictEqual(result.errors[0]?.code, 'UTILITY_MODULE');
	});

	test('marks strategy files as valid', () => {
		const doc = createDocument('def strategy(data):\n    return data');
		const result = validator.validateDocument(doc);

		assert.strictEqual(result.isValid, true);
		assert.strictEqual(result.entrypoint?.type, 'vectorized');
	});

	test('invalidates cached results when requested', () => {
		const doc = createDocument('def strategy(data):\n    pass', 'python', 'cache_test.py');
		validator.validateDocument(doc);

		assert.ok(validator.getValidationResult(doc));
		validator.invalidate(doc.uri);

		assert.strictEqual(validator.getValidationResult(doc), undefined);
	});

	test('drops cached results when document version changes', () => {
		const docV1 = createDocument('def strategy(data):\n    pass', 'python', 'version_test.py', 1);
		validator.validateDocument(docV1);

		const docV2 = createDocument('def strategy(data):\n    pass', 'python', 'version_test.py', 2);
		assert.strictEqual(validator.getValidationResult(docV2), undefined);
	});
});
