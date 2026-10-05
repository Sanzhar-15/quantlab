/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bindingFileName, developmentEngineRoot, packagedEngineRoot, resolveEngineRoot } from '../../quantbook/engineRoot';

suite('quantbook engine root (QB-0)', () => {

	let base: string;
	let extensionDir: string;

	setup(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-engine-root-'));
		extensionDir = path.join(base, 'workspace', 'quantlab', 'extensions', 'quantlab');
		fs.mkdirSync(extensionDir, { recursive: true });
	});

	teardown(() => {
		fs.chmodSync(extensionDir, 0o755);
		fs.rmSync(base, { recursive: true, force: true });
	});

	test('no packaged directory: the development tree, the sibling engine worktree', () => {
		assert.deepStrictEqual(resolveEngineRoot(extensionDir), {
			kind: 'development',
			path: path.join(base, 'workspace', 'quantlab-quantbook', 'quantbook-engine'),
		});
		assert.strictEqual(developmentEngineRoot(extensionDir), path.join(base, 'workspace', 'quantlab-quantbook', 'quantbook-engine'));
	});

	test('a packaged directory wins', () => {
		fs.mkdirSync(packagedEngineRoot(extensionDir));
		assert.deepStrictEqual(resolveEngineRoot(extensionDir), { kind: 'packaged', path: path.join(extensionDir, 'quantbook-engine') });
	});

	test('a packaged path that is a file throws, it does not select the development tree', () => {
		fs.writeFileSync(packagedEngineRoot(extensionDir), '');
		assert.throws(() => resolveEngineRoot(extensionDir), /is not a directory/);
	});

	test('an unreadable extension directory throws, it does not select the development tree', function () {
		if (process.platform === 'win32' || process.getuid!() === 0) {
			this.skip();
		}
		fs.mkdirSync(packagedEngineRoot(extensionDir));
		fs.chmodSync(extensionDir, 0o000);
		assert.throws(() => resolveEngineRoot(extensionDir), /cannot inspect the packaged engine directory/);
	});

	test('binding file names per platform; an unknown platform throws', () => {
		assert.deepStrictEqual(
			(['darwin', 'linux', 'win32'] as const).map(bindingFileName),
			['libql_bindings_node.dylib', 'libql_bindings_node.so', 'ql_bindings_node.dll'],
		);
		assert.throws(() => bindingFileName('aix'), /Unsupported platform/);
	});
});
