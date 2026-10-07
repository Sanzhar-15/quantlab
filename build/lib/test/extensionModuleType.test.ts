/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findEsmMainsWithoutModuleType, isEsmSyntax } from '../extensionModuleType.ts';

suite('extensionModuleType', () => {

	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-module-type-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true });
	});

	function extension(name: string, manifest: object, files: Record<string, string>): void {
		const dir = path.join(root, name);
		fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
		for (const [file, content] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, file), content);
		}
	}

	const esmMain = 'import*as d from"vscode";const w=()=>d;export{w as activate};';
	const cjsMain = '"use strict";const v=require("vscode");exports.activate=()=>v;return;';

	test('ES module syntax is told from CommonJS; another syntax error is thrown', () => {
		assert.strictEqual(isEsmSyntax(esmMain, 'a.js'), true);
		assert.strictEqual(isEsmSyntax('export const x = 1;', 'b.js'), true);
		assert.strictEqual(isEsmSyntax('const u = import.meta.url;', 'c.js'), true);
		assert.strictEqual(isEsmSyntax(cjsMain, 'd.js'), false);
		assert.strictEqual(isEsmSyntax('const m = import("./x.js");', 'e.js'), false);
		assert.throws(() => isEsmSyntax('const = 1;', 'f.js'), SyntaxError);
	});

	test('an ES module main without "type": "module" is refused, naming the extension', () => {
		extension('github', { main: './dist/extension.js' }, { 'dist/extension.js': esmMain });
		assert.deepStrictEqual(findEsmMainsWithoutModuleType(root), [
			`github: main './dist/extension.js' is ES module syntax but package.json has no "type": "module" (the extension host would load it with require() and hang)`
		]);
	});

	test('the same main with "type": "module", a CommonJS main, .mjs, .cjs and no main pass', () => {
		extension('github', { main: './dist/extension.js', type: 'module' }, { 'dist/extension.js': esmMain });
		extension('git', { main: './dist/main' }, { 'dist/main.js': cjsMain });
		extension('esm-by-name', { main: './dist/extension.mjs' }, { 'dist/extension.mjs': esmMain });
		extension('cjs-by-name', { main: './dist/extension.cjs', type: 'module' }, { 'dist/extension.cjs': cjsMain });
		extension('theme-only', { contributes: {} }, {});
		fs.mkdirSync(path.join(root, 'node_modules'));
		assert.deepStrictEqual(findEsmMainsWithoutModuleType(root), []);
	});

	test('a main that does not exist is refused', () => {
		extension('broken', { main: './dist/extension.js' }, {});
		assert.deepStrictEqual(findEsmMainsWithoutModuleType(root), [`broken: main './dist/extension.js' does not exist`]);
	});
});
