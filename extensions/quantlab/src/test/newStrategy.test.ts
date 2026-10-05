/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { StrategyValidator } from '../core/strategy/StrategyValidator';
import { NEW_STRATEGY_COMMAND, NEW_STRATEGY_TEMPLATE, createNewStrategy } from '../commands/newStrategy';

// Compiled location is out/src/test/, so the extension root is three levels up.
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

suite('quantlab.newStrategy', () => {
	const workspaceShim = vscode.workspace as unknown as Record<string, unknown>;
	const windowShim = vscode.window as unknown as Record<string, unknown>;

	teardown(() => {
		delete workspaceShim.openTextDocument;
		delete windowShim.showTextDocument;
	});

	test('the command id is the one the desktop host runs', () => {
		assert.strictEqual(NEW_STRATEGY_COMMAND, 'quantlab.newStrategy');
	});

	test('the template is a valid vectorized strategy', () => {
		const doc = {
			languageId: 'python',
			fileName: 'Untitled-1',
			uri: vscode.Uri.parse('untitled:Untitled-1'),
			getText: () => NEW_STRATEGY_TEMPLATE,
			isUntitled: true,
			version: 1
		} as vscode.TextDocument;

		const result = StrategyValidator.getInstance().validateDocument(doc);

		assert.strictEqual(result.isValid, true);
		assert.deepStrictEqual(result.entrypoint, { type: 'vectorized', functionName: 'strategy' });
		assert.deepStrictEqual(result.errors, []);
	});

	test('opens one unsaved Python document holding the template, not in preview', async () => {
		const opened: unknown[] = [];
		const shown: { doc: unknown; options: unknown }[] = [];
		const doc = { marker: 'new-strategy-doc' };
		const editor = { document: doc };
		workspaceShim.openTextDocument = async (options: unknown) => {
			opened.push(options);
			return doc;
		};
		windowShim.showTextDocument = async (shownDoc: unknown, options: unknown) => {
			shown.push({ doc: shownDoc, options });
			return editor;
		};

		const result = await createNewStrategy();

		assert.deepStrictEqual(opened, [{ language: 'python', content: NEW_STRATEGY_TEMPLATE }]);
		assert.deepStrictEqual(shown, [{ doc, options: { preview: false } }]);
		assert.strictEqual(result as unknown, editor);
	});

	test('a failure to open the document is not swallowed', async () => {
		workspaceShim.openTextDocument = async () => {
			throw new Error('open refused');
		};

		await assert.rejects(createNewStrategy(), /open refused/);
	});

	test('package.json declares the command with a localized title', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'package.json'), 'utf8')) as {
			contributes: { commands: { command: string; title: string }[] };
		};
		const nls = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;

		const declared = pkg.contributes.commands.filter(c => c.command === NEW_STRATEGY_COMMAND);

		assert.strictEqual(declared.length, 1);
		assert.strictEqual(declared[0].title, '%command.newStrategy.title%');
		assert.strictEqual(nls['command.newStrategy.title'], 'New Strategy');
	});
});
