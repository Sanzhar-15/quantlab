/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import * as path from 'path';
import { editorExtensionsDir, editorUserDir, readEditorSnapshot, ReadPort } from '../../import/sources';

function fakeFs(files: Record<string, string>, failing: Record<string, string> = {}): ReadPort {
	return {
		async readFile(file: string): Promise<string> {
			if (Object.hasOwn(failing, file)) {
				throw Object.assign(new Error(`${failing[file]}: ${file}`), { code: failing[file] });
			}
			if (!Object.hasOwn(files, file)) {
				throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
			}
			return files[file];
		}
	};
}

suite('import – sources', () => {

	const user = path.join('/src', 'User');
	const ext = path.join('/src', 'extensions');
	const settingsFile = path.join(user, 'settings.json');
	const keybindingsFile = path.join(user, 'keybindings.json');
	const extensionsFile = path.join(ext, 'extensions.json');

	test('user directories per platform', () => {
		assert.strictEqual(editorUserDir('vscode', 'darwin', { HOME: '/Users/a' }), '/Users/a/Library/Application Support/Code/User');
		assert.strictEqual(editorUserDir('cursor', 'darwin', { HOME: '/Users/a' }), '/Users/a/Library/Application Support/Cursor/User');
		assert.strictEqual(editorUserDir('vscode', 'linux', { HOME: '/home/a' }), '/home/a/.config/Code/User');
		assert.strictEqual(editorUserDir('cursor', 'win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }), 'C:\\Users\\a\\AppData\\Roaming\\Cursor\\User');
		assert.strictEqual(editorExtensionsDir('vscode', 'darwin', { HOME: '/Users/a' }), '/Users/a/.vscode/extensions');
		assert.strictEqual(editorExtensionsDir('cursor', 'win32', { USERPROFILE: 'C:\\Users\\a' }), 'C:\\Users\\a\\.cursor\\extensions');
	});

	test('a missing environment value throws by name', () => {
		assert.throws(() => editorUserDir('vscode', 'darwin', {}), /environment variable HOME is not set/);
		assert.throws(() => editorUserDir('vscode', 'win32', { HOME: '/x' }), /environment variable APPDATA is not set/);
		assert.throws(() => editorExtensionsDir('cursor', 'win32', { HOME: '/x' }), /environment variable USERPROFILE is not set/);
		assert.throws(() => editorUserDir('vscode', 'freebsd', { HOME: '/x' }), /unsupported platform freebsd/);
	});

	test('a full snapshot: ids lower-cased and de-duplicated in order', async () => {
		const snapshot = await readEditorSnapshot('vscode', user, ext, fakeFs({
			[settingsFile]: '{ "editor.fontSize": 13, } // c',
			[keybindingsFile]: '[ { "key": "cmd+k", "command": "x" } ]',
			[extensionsFile]: '[{"identifier":{"id":"Pub.One"}},{"identifier":{"id":"pub.two"}},{"identifier":{"id":"pub.one"}}]',
		}));
		assert.deepStrictEqual(snapshot.settings, { 'editor.fontSize': 13 });
		assert.deepStrictEqual(snapshot.keybindings, [{ key: 'cmd+k', command: 'x' }]);
		assert.deepStrictEqual(snapshot.extensionIds, ['pub.one', 'pub.two']);
		assert.deepStrictEqual(snapshot.missing, []);
	});

	test('each absent file is reported in missing', async () => {
		const snapshot = await readEditorSnapshot('cursor', user, ext, fakeFs({}));
		assert.strictEqual(snapshot.settings, undefined);
		assert.strictEqual(snapshot.keybindings, undefined);
		assert.deepStrictEqual(snapshot.extensionIds, []);
		assert.deepStrictEqual(snapshot.missing, [settingsFile, keybindingsFile, extensionsFile]);
	});

	test('a read error other than ENOENT propagates', async () => {
		await assert.rejects(readEditorSnapshot('vscode', user, ext, fakeFs({}, { [settingsFile]: 'EACCES' })), /EACCES/);
	});

	test('wrong shapes throw, naming the file', async () => {
		await assert.rejects(readEditorSnapshot('vscode', user, ext, fakeFs({ [settingsFile]: '[]' })), /settings\.json: expected a JSON object/);
		await assert.rejects(readEditorSnapshot('vscode', user, ext, fakeFs({ [keybindingsFile]: '{}' })), /keybindings\.json: expected a JSON array/);
		await assert.rejects(readEditorSnapshot('vscode', user, ext, fakeFs({ [extensionsFile]: '[{"identifier":{}}]' })), /extensions\.json: entry 0 has no identifier\.id/);
	});
});
