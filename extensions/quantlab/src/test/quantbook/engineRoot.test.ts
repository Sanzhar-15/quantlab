/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bindingFileName, developmentEngineRoot, findExtensionDir, packagedEngineRoot, resolveEngineRoot } from '../../quantbook/engineRoot';

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

	test('findExtensionDir: walks up to the quantlab extension, past directories without a package.json and a package of another name', () => {
		const deep = path.join(extensionDir, 'out', 'src', 'quantbook');
		fs.mkdirSync(deep, { recursive: true });
		fs.writeFileSync(path.join(extensionDir, 'package.json'), JSON.stringify({ name: 'quantlab' }));
		fs.writeFileSync(path.join(extensionDir, 'out', 'package.json'), JSON.stringify({ name: 'something-else' }));
		assert.strictEqual(findExtensionDir(deep), extensionDir);
	});

	test('findExtensionDir: a quantlab package outside extensions/quantlab is not the anchor', () => {
		const other = path.join(base, 'workspace', 'elsewhere');
		fs.mkdirSync(other, { recursive: true });
		fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'quantlab' }));
		assert.strictEqual(findExtensionDir(other), undefined);
	});

	test('findExtensionDir: an ancestor package.json that is not valid JSON throws, naming the file', () => {
		const deep = path.join(extensionDir, 'out');
		fs.mkdirSync(deep);
		fs.writeFileSync(path.join(extensionDir, 'package.json'), JSON.stringify({ name: 'quantlab' }));
		fs.writeFileSync(path.join(deep, 'package.json'), '{ not json');
		assert.throws(() => findExtensionDir(deep), (err: Error) => err.message.includes(path.join(deep, 'package.json')) && /is not valid JSON/.test(err.message));
	});

	test('findExtensionDir: an ancestor package.json that cannot be read throws, it is not skipped', function () {
		if (process.platform === 'win32' || process.getuid!() === 0) {
			this.skip();
		}
		const deep = path.join(extensionDir, 'out');
		fs.mkdirSync(deep);
		fs.writeFileSync(path.join(extensionDir, 'package.json'), JSON.stringify({ name: 'quantlab' }));
		fs.writeFileSync(path.join(deep, 'package.json'), JSON.stringify({ name: 'something-else' }));
		fs.chmodSync(path.join(deep, 'package.json'), 0o000);
		assert.throws(() => findExtensionDir(deep), /cannot read .*package\.json while locating the extension/);
	});
});
