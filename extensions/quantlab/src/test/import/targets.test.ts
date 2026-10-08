/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Install the vscode shim BEFORE importing anything that imports 'vscode'.
import { installVscodeShim } from '../../../test/helpers/vscode-shim';
installVscodeShim();
import { ImportPorts, runImport } from '../../import/importer';
import { EditorSnapshot } from '../../import/sources';
import { importTarget } from '../../import/targets';

// Import target resolution (QL-G-FEAT c1 M3): the files written are exactly the resources the workbench command
// `_quantlab.activeProfileImportTargets` names for the ACTIVE profile, on a real directory tree laid out like
// <userData>/User with a default profile and a named profile `p1` (location User/profiles/p1).

interface Flags { settings?: boolean; keybindings?: boolean; globalState?: boolean }

const USER_DATA = 'vscode-userdata';

/** The same rule as `toUserDataProfile` (src/vs/platform/userDataProfile/common/userDataProfile.ts:158-160). */
function profileResources(userDir: string, name: 'default' | 'p1', flags: Flags): { settingsResource: unknown; keybindingsResource: unknown; profileName: string; isDefault: boolean } {
	const resource = (file: string) => ({ scheme: USER_DATA, authority: '', path: file });
	const location = name === 'default' ? userDir : path.posix.join(userDir, 'profiles', name);
	return {
		profileName: name,
		isDefault: name === 'default',
		settingsResource: resource(flags.settings ? path.posix.join(userDir, 'settings.json') : path.posix.join(location, 'settings.json')),
		keybindingsResource: resource(flags.keybindings ? path.posix.join(userDir, 'keybindings.json') : path.posix.join(location, 'keybindings.json')),
	};
}

function snapshot(): EditorSnapshot {
	return {
		kind: 'vscode',
		userDir: '/src/User',
		settings: { 'editor.fontSize': 13 },
		keybindings: [{ key: 'cmd+k', command: 'x' }],
		extensionIds: [],
		missing: [],
	};
}

const ports: ImportPorts = {
	fs: {
		readFile: file => fs.promises.readFile(file, 'utf8'),
		writeFile: (file, text) => fs.promises.writeFile(file, text, 'utf8'),
		copyFile: (from, to) => fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL),
	},
	gallery: {
		isInstalled: () => { throw new Error('no extension is part of this snapshot'); },
		install: () => { throw new Error('no extension is part of this snapshot'); },
	},
	now: () => new Date('2026-10-08T10:00:00.000Z'),
};

async function readTree(root: string): Promise<Map<string, string>> {
	const tree = new Map<string, string>();
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(file);
			} else {
				tree.set(path.relative(root, file), await fs.promises.readFile(file, 'utf8'));
			}
		}
	};
	await walk(root);
	return tree;
}

suite('import – target resolution (QL-G-FEAT c1 M3)', () => {
	let root: string;
	let userDir: string;

	const original = {
		'settings.json': '{ "editor.fontSize": 11, "default-profile-key": true }\n',
		'keybindings.json': '[ { "key": "ctrl+d", "command": "default.cmd" } ]\n',
		[path.join('profiles', 'p1', 'settings.json')]: '{ "editor.fontSize": 12, "p1-key": true }\n',
		[path.join('profiles', 'p1', 'keybindings.json')]: '[ { "key": "ctrl+p", "command": "p1.cmd" } ]\n',
		[path.join('globalStorage', 'quantlab.quantlab', 'state.json')]: '{}\n',
	};

	setup(async () => {
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ql-import-targets-'));
		userDir = path.join(root, 'User');
		for (const [rel, text] of Object.entries(original)) {
			await fs.promises.mkdir(path.dirname(path.join(userDir, rel)), { recursive: true });
			await fs.promises.writeFile(path.join(userDir, rel), text, 'utf8');
		}
	});

	teardown(async () => {
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	/** The extension's flow: resolve the targets from the command result, then import. The command is the stub. */
	async function runFlow(result: unknown): Promise<void> {
		// `globalStorage` is what the extension is handed: ALWAYS the default profile's, whatever profile is active.
		const stub = Object.assign(async (command: string) => {
			assert.strictEqual(command, '_quantlab.activeProfileImportTargets');
			return result;
		}, { globalStorage: path.join(userDir, 'globalStorage', 'quantlab.quantlab') });
		const target = await importTarget(stub);
		await runImport(snapshot(), target, ports);
	}

	/** Asserts the two named files took the import and nothing else changed except new backups of exactly those two. */
	async function assertLanded(before: Map<string, string>, settingsRel: string, keybindingsRel: string): Promise<void> {
		const after = await readTree(userDir);
		const backups = [...after.keys()].filter(k => !before.has(k));
		assert.deepStrictEqual(backups.sort(), [`${settingsRel}.pre-import-20261008T100000Z`, `${keybindingsRel}.pre-import-20261008T100000Z`].sort());
		assert.strictEqual(after.get(`${settingsRel}.pre-import-20261008T100000Z`), before.get(settingsRel));
		assert.strictEqual(after.get(`${keybindingsRel}.pre-import-20261008T100000Z`), before.get(keybindingsRel));
		const settings = JSON.parse(after.get(settingsRel)!);
		assert.strictEqual(settings['editor.fontSize'], 13, `${settingsRel} took the imported fontSize`);
		assert.ok(after.get(keybindingsRel)!.includes('"cmd+k"'), `${keybindingsRel} took the imported binding`);
		for (const [rel, text] of before) {
			if (rel !== settingsRel && rel !== keybindingsRel) {
				assert.strictEqual(after.get(rel), text, `${rel} is byte-identical`);
			}
		}
	}

	test('a named profile: settings and keybindings land in profiles/p1, the default profile files stay byte-identical', async () => {
		const before = await readTree(userDir);
		await runFlow(profileResources(userDir, 'p1', {}));
		const p1s = path.join('profiles', 'p1', 'settings.json');
		const p1k = path.join('profiles', 'p1', 'keybindings.json');
		await assertLanded(before, p1s, p1k);
		const after = await readTree(userDir);
		assert.strictEqual(after.get('settings.json'), original['settings.json']);
		assert.strictEqual(after.get('keybindings.json'), original['keybindings.json']);
		assert.deepStrictEqual(JSON.parse(after.get(p1s)!), { 'editor.fontSize': 13, 'p1-key': true });
	});

	test('the default profile: settings and keybindings land in User/', async () => {
		const before = await readTree(userDir);
		await runFlow(profileResources(userDir, 'default', {}));
		await assertLanded(before, 'settings.json', 'keybindings.json');
	});

	test('useDefaultFlags.globalState only: both files land in profiles/p1 (global storage is the default profile\'s)', async () => {
		const before = await readTree(userDir);
		await runFlow(profileResources(userDir, 'p1', { globalState: true }));
		await assertLanded(before, path.join('profiles', 'p1', 'settings.json'), path.join('profiles', 'p1', 'keybindings.json'));
	});

	test('useDefaultFlags.settings: settings land in User/, keybindings in profiles/p1', async () => {
		const before = await readTree(userDir);
		await runFlow(profileResources(userDir, 'p1', { settings: true }));
		await assertLanded(before, 'settings.json', path.join('profiles', 'p1', 'keybindings.json'));
	});

	test('useDefaultFlags.keybindings: keybindings land in User/, settings in profiles/p1', async () => {
		const before = await readTree(userDir);
		await runFlow(profileResources(userDir, 'p1', { keybindings: true }));
		await assertLanded(before, path.join('profiles', 'p1', 'settings.json'), 'keybindings.json');
	});

	test('useDefaultFlags.settings and keybindings: both land in User/', async () => {
		const before = await readTree(userDir);
		await runFlow(profileResources(userDir, 'p1', { settings: true, keybindings: true }));
		await assertLanded(before, 'settings.json', 'keybindings.json');
	});

	const ok = (file: string) => ({ scheme: USER_DATA, authority: '', path: file });

	const malformed: Array<[string, () => unknown]> = [
		['an undefined result (command registered by nothing)', () => undefined],
		['a null result', () => null],
		['a string result', () => 'settings.json'],
		['an array result', () => []],
		['no keybindingsResource', () => ({ settingsResource: ok('/x/settings.json') })],
		['no settingsResource', () => ({ keybindingsResource: ok('/x/keybindings.json') })],
		['a settingsResource that is a path string', () => ({ settingsResource: '/x/settings.json', keybindingsResource: ok('/x/keybindings.json') })],
		['a keybindingsResource with no scheme', () => ({ settingsResource: ok('/x/settings.json'), keybindingsResource: { path: '/x/keybindings.json' } })],
		['a keybindingsResource with an empty path', () => ({ settingsResource: ok('/x/settings.json'), keybindingsResource: { scheme: USER_DATA, path: '' } })],
		['a resource whose authority is not a string', () => ({ settingsResource: { scheme: USER_DATA, authority: 5, path: '/x/settings.json' }, keybindingsResource: ok('/x/keybindings.json') })],
	];
	for (const [label, build] of malformed) {
		test(`[import_targets_unreadable] ${label}: nothing is written`, async () => {
			const before = await readTree(userDir);
			await assert.rejects(runFlow(build()), /\[import_targets_unreadable\]/);
			assert.deepStrictEqual(await readTree(userDir), before);
		});
	}

	test('a command that throws surfaces its own error unchanged, nothing is written', async () => {
		const before = await readTree(userDir);
		const failing = async () => { throw new Error('command \'_quantlab.activeProfileImportTargets\' not found'); };
		await assert.rejects(importTarget(failing), /not found/);
		assert.deepStrictEqual(await readTree(userDir), before);
	});

	const notLocal: Array<[string, () => unknown]> = [
		['file scheme for settings', () => ({ settingsResource: { scheme: 'file', path: path.join(userDir, 'settings.json') }, keybindingsResource: ok(path.join(userDir, 'keybindings.json')) })],
		['vscode-remote scheme for keybindings (settings local)', () => ({ settingsResource: ok(path.join(userDir, 'settings.json')), keybindingsResource: { scheme: 'vscode-remote', authority: 'host', path: '/u/keybindings.json' } })],
		['untitled scheme for both', () => ({ settingsResource: { scheme: 'untitled', path: 'a' }, keybindingsResource: { scheme: 'untitled', path: 'b' } })],
		['vscode-userdata with an authority', () => ({ settingsResource: { scheme: USER_DATA, authority: 'host', path: '/x/settings.json' }, keybindingsResource: ok('/x/keybindings.json') })],
	];
	for (const [label, build] of notLocal) {
		test(`[import_targets_not_local] ${label}: nothing is written`, async () => {
			const before = await readTree(userDir);
			await assert.rejects(runFlow(build()), /\[import_targets_not_local\]/);
			assert.deepStrictEqual(await readTree(userDir), before);
		});
	}
});
