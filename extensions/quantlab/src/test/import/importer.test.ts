/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import { GalleryPort } from '../../import/extensions';
import { formatReport, ImportPorts, runImport } from '../../import/importer';
import { EditorSnapshot } from '../../import/sources';

// Mirrors acceptance row IM-1 with in-memory fakes: a fixture user dir (settings, keybindings,
// 3 extensions of which one is absent from the gallery) and a spied gallery client.

const target = { settingsPath: '/app/User/settings.json', keybindingsPath: '/app/User/keybindings.json' };

function snapshot(): EditorSnapshot {
	return {
		kind: 'vscode',
		userDir: '/src/User',
		settings: { 'editor.fontSize': 13, 'quantlab.quantbook.enabled': true },
		keybindings: [{ key: 'cmd+k', command: 'x' }],
		extensionIds: ['pub.present-one', 'pub.present-two', 'pub.absent'],
		missing: [],
	};
}

function harness(files: Record<string, string>, gallery: GalleryPort, readError?: { file: string; code: string }) {
	const calls: string[] = [];
	const ports: ImportPorts = {
		fs: {
			async readFile(file) {
				if (readError && readError.file === file) {
					throw Object.assign(new Error(`${readError.code}: ${file}`), { code: readError.code });
				}
				if (!Object.hasOwn(files, file)) {
					throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
				}
				return files[file];
			},
			async writeFile(file, text) { calls.push(`write ${file}`); files[file] = text; },
			async copyFile(from, to) { calls.push(`copy ${from} -> ${to}`); files[to] = files[from]; },
		},
		gallery,
		now: () => new Date('2026-10-05T14:16:53.000Z'),
	};
	return { ports, calls, files };
}

function spyGallery(installed: string[], known: string[]) {
	const installs: string[] = [];
	const gallery: GalleryPort = {
		isInstalled: id => installed.includes(id),
		async install(id) {
			installs.push(id);
			if (!known.includes(id)) {
				throw new Error(`Extension '${id}' not found.`);
			}
		},
	};
	return { gallery, installs };
}

suite('import – importer (IM-1)', () => {

	test('settings and keybindings applied, 2 gallery installs, the absent extension listed by name', async () => {
		const spy = spyGallery([], ['pub.present-one', 'pub.present-two']);
		const h = harness({ [target.settingsPath]: '{ "editor.fontSize": 11, "mine": 1 }' }, spy.gallery);

		const report = await runImport(snapshot(), target, h.ports);

		assert.deepStrictEqual(JSON.parse(h.files[target.settingsPath]), { 'editor.fontSize': 13, 'mine': 1, 'quantlab.quantbook.enabled': true });
		assert.deepStrictEqual(JSON.parse(h.files[target.keybindingsPath]), [{ key: 'cmd+k', command: 'x' }]);
		assert.deepStrictEqual(report.settings, {
			added: ['quantlab.quantbook.enabled'], overwritten: ['editor.fontSize'], unchanged: [],
			backup: '/app/User/settings.json.pre-import-20261005T141653Z',
		});
		// the backup holds the previous text and is taken BEFORE the write; no backup where no target existed
		assert.strictEqual(h.files['/app/User/settings.json.pre-import-20261005T141653Z'], '{ "editor.fontSize": 11, "mine": 1 }');
		assert.deepStrictEqual(h.calls, [
			'copy /app/User/settings.json -> /app/User/settings.json.pre-import-20261005T141653Z',
			'write /app/User/settings.json',
			'write /app/User/keybindings.json',
		]);
		assert.strictEqual(report.keybindings?.backup, undefined);

		assert.deepStrictEqual(spy.installs, ['pub.present-one', 'pub.present-two', 'pub.absent']);
		assert.deepStrictEqual(report.extensions.installed, ['pub.present-one', 'pub.present-two']);
		assert.deepStrictEqual(report.extensions.unresolved, [{ id: 'pub.absent', reason: `Extension 'pub.absent' not found.` }]);

		const text = formatReport(report);
		assert.match(text, /Not imported \(not available from the extension gallery or failed to install\):\n  pub\.absent: Extension 'pub\.absent' not found\./);
		assert.match(text, /  installed: pub\.present-one\n  installed: pub\.present-two\n/);
		assert.match(text, /  overwritten: editor\.fontSize\n/);
	});

	test('negative control: a resolver reporting every id as installed installs nothing and does NOT list the absent one', async () => {
		const spy = spyGallery(['pub.present-one', 'pub.present-two', 'pub.absent'], []);
		const h = harness({}, spy.gallery);

		const report = await runImport(snapshot(), target, h.ports);

		assert.deepStrictEqual(spy.installs, []);
		assert.deepStrictEqual(report.extensions.unresolved, []);
		assert.doesNotMatch(formatReport(report), /Not imported/);
	});

	test('an already installed extension is not installed again', async () => {
		const spy = spyGallery(['pub.present-one'], ['pub.present-two']);
		const report = await runImport(snapshot(), target, harness({}, spy.gallery).ports);
		assert.deepStrictEqual(spy.installs, ['pub.present-two', 'pub.absent']);
		assert.deepStrictEqual(report.extensions.alreadyInstalled, ['pub.present-one']);
	});

	test('a target read error other than ENOENT propagates and nothing is written', async () => {
		const spy = spyGallery([], []);
		const h = harness({}, spy.gallery, { file: target.settingsPath, code: 'EACCES' });
		await assert.rejects(runImport(snapshot(), target, h.ports), /EACCES/);
		assert.deepStrictEqual(h.calls, []);
		assert.deepStrictEqual(spy.installs, []);
	});

	test('a snapshot without settings leaves the target settings alone and reports the missing file', async () => {
		const spy = spyGallery([], []);
		const h = harness({ [target.settingsPath]: '{}' }, spy.gallery);
		const report = await runImport({ ...snapshot(), settings: undefined, extensionIds: [], missing: ['/src/User/settings.json'] }, target, h.ports);
		assert.strictEqual(report.settings, undefined);
		assert.deepStrictEqual(h.calls, ['write /app/User/keybindings.json']);
		assert.match(formatReport(report), /Source files not found \(nothing imported from them\):\n  \/src\/User\/settings\.json\n/);
	});
});
