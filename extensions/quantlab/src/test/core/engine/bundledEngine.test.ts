/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundledEngineCandidates, bundledEngineLaunch, resolveBundledEngine } from '../../../core/engine/bundledEngine';

suite('bundledEngine – resolver', () => {

	let root: string;
	let extensionPath: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-bundled-engine-'));
		extensionPath = path.join(root, 'extensions', 'quantlab');
		fs.mkdirSync(extensionPath, { recursive: true });
	});

	teardown(() => {
		fs.chmodSync(root, 0o755);
		fs.rmSync(root, { recursive: true });
	});

	function place(file: string): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '');
	}

	test('no candidate exists → null', () => {
		assert.strictEqual(resolveBundledEngine(extensionPath, 'darwin'), null);
	});

	test('the packaged layout is <extension root>/engine/quantlab-engine/<exe>', () => {
		const packaged = path.join(extensionPath, 'engine', 'quantlab-engine', 'quantlab-engine');
		place(packaged);
		assert.strictEqual(resolveBundledEngine(extensionPath, 'darwin'), packaged);
		assert.strictEqual(bundledEngineCandidates(extensionPath, 'win32')[1], path.join(extensionPath, 'engine', 'quantlab-engine', 'quantlab-engine.exe'));
	});

	test('a bundle placed one directory up is not found', () => {
		place(path.join(extensionPath, 'quantlab-engine', 'quantlab-engine'));
		assert.strictEqual(resolveBundledEngine(extensionPath, 'darwin'), null);
	});

	test('a candidate path through a file (ENOTDIR) is an absence', () => {
		place(path.join(extensionPath, 'engine'));
		assert.strictEqual(resolveBundledEngine(extensionPath, 'darwin'), null);
	});

	test('an unreadable candidate directory throws, naming the candidate', function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) {
			this.skip();
		}
		const dir = path.join(extensionPath, 'engine', 'quantlab-engine');
		place(path.join(dir, 'quantlab-engine'));
		fs.chmodSync(dir, 0o000);
		try {
			assert.throws(() => resolveBundledEngine(extensionPath, 'darwin'), /cannot inspect the bundled engine candidate .*EACCES/);
		} finally {
			fs.chmodSync(dir, 0o755);
		}
	});
});

suite('bundledEngine – launch', () => {
	test('the bundled engine runs in its own directory, with no engine source tree', () => {
		const exe = path.join('/Applications', 'Delta Plus.app', 'Contents', 'Resources', 'app', 'extensions', 'quantlab', 'engine', 'quantlab-engine', 'quantlab-engine');
		assert.deepStrictEqual(bundledEngineLaunch(exe), {
			executable: exe,
			source: 'bundled engine',
			cwd: path.dirname(exe),
			engineRoot: null,
		});
	});
});
