/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundledEngineCandidates, bundledEngineLaunch, ENGINE_SOURCES, isPackagedApp, resolveBundledEngine, selectEngine } from '../../../core/engine/bundledEngine';

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
		assert.deepStrictEqual(bundledEngineLaunch(exe, ENGINE_SOURCES.packaged), {
			executable: exe,
			source: 'packaged bundled engine',
			cwd: path.dirname(exe),
			engineRoot: null,
		});
	});

	test('each step of selectEngine has its own name', () => {
		const names = Object.values(ENGINE_SOURCES);
		assert.deepStrictEqual(names, ['packaged bundled engine', 'setting quantlab.pythonPath', 'development bundled engine']);
		assert.strictEqual(new Set(names).size, names.length);
	});
});

suite('bundledEngine – selectEngine', () => {

	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-select-engine-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true });
	});

	function place(file: string): string {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '');
		return file;
	}

	// product.json as the packaging task writes it (with a commit) or as a source run reads it (without).
	function writeProduct(appRoot: string, commit?: unknown): void {
		fs.mkdirSync(appRoot, { recursive: true });
		fs.writeFileSync(path.join(appRoot, 'product.json'), JSON.stringify(commit === undefined ? { nameShort: 'Delta Plus' } : { nameShort: 'Delta Plus', commit }));
	}

	// The packaged app: <appRoot>/extensions/quantlab, the engine inside the extension.
	function packaged(): { appRoot: string; extensionPath: string; exe: string } {
		const appRoot = path.join(root, 'Delta Plus.app', 'Contents', 'Resources', 'app');
		const extensionPath = path.join(appRoot, 'extensions', 'quantlab');
		fs.mkdirSync(extensionPath, { recursive: true });
		writeProduct(appRoot, '0123456789abcdef0123456789abcdef01234567');
		return { appRoot, extensionPath, exe: path.join(extensionPath, 'engine', 'quantlab-engine', 'quantlab-engine') };
	}

	test('packaged: the bundled engine, even when quantlab.pythonPath is set', () => {
		const app = packaged();
		place(app.exe);
		const python = place(path.join(root, 'bin', 'python3'));
		for (const explicitPython of ['', python]) {
			const engine = selectEngine({ extensionPath: app.extensionPath, appRoot: app.appRoot, platform: 'darwin', explicitPython });
			assert.deepStrictEqual(engine, { executable: app.exe, source: 'packaged bundled engine', cwd: path.dirname(app.exe), engineRoot: null });
		}
	});

	test('packaged, bundled engine deleted: fails by name, never another interpreter', () => {
		const app = packaged();
		place(app.exe);
		fs.rmSync(app.exe);
		// A usable interpreter set and an engine source tree beside the app change nothing.
		const python = place(path.join(root, 'bin', 'python3'));
		fs.mkdirSync(path.join(app.appRoot, 'engine'));
		for (const explicitPython of ['', python]) {
			assert.throws(
				() => selectEngine({ extensionPath: app.extensionPath, appRoot: app.appRoot, platform: 'darwin', explicitPython }),
				(err: Error) => err.message === `[engine_missing] Quantlab: this app's bundled backtest engine is missing (${app.exe}); reinstall the app.`,
			);
		}
	});

	// A source run (scripts/code.sh): the extension is at <appRoot>/extensions/quantlab, appRoot is the
	// repository root, and its product.json carries no commit.
	function sourceRun(): { appRoot: string; extensionPath: string } {
		const appRoot = root;
		const extensionPath = path.join(appRoot, 'extensions', 'quantlab');
		fs.mkdirSync(extensionPath, { recursive: true });
		writeProduct(appRoot);
		return { appRoot, extensionPath };
	}

	test('source run (extension under appRoot): a declared quantlab.pythonPath selects the setting', () => {
		const { appRoot, extensionPath } = sourceRun();
		fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
		const python = place(path.join(root, 'venv', 'bin', 'python'));
		place(path.join(root, '.build', 'quantlab-engine', 'quantlab-engine', 'quantlab-engine'));
		assert.deepStrictEqual(selectEngine({ extensionPath, appRoot, platform: 'darwin', explicitPython: python }), {
			executable: python, source: 'setting quantlab.pythonPath', cwd: path.join(root, 'engine'), engineRoot: path.join(root, 'engine'),
		});
	});

	test('source run, no setting, only the bundle task output present: that bundle is selected', () => {
		const { appRoot, extensionPath } = sourceRun();
		const exe = place(path.join(root, '.build', 'quantlab-engine', 'quantlab-engine', 'quantlab-engine'));
		assert.deepStrictEqual(selectEngine({ extensionPath, appRoot, platform: 'darwin', explicitPython: '' }), {
			executable: exe, source: 'development bundled engine', cwd: path.dirname(exe), engineRoot: null,
		});
	});

	test('source run: a set quantlab.pythonPath that is not a file, or no source tree, fails by name', () => {
		const { appRoot, extensionPath } = sourceRun();
		assert.throws(() => selectEngine({ extensionPath, appRoot, platform: 'darwin', explicitPython: path.join(root, 'nope') }), /^Error: \[engine_python_missing\]/);
		const python = place(path.join(root, 'venv', 'bin', 'python'));
		assert.throws(() => selectEngine({ extensionPath, appRoot, platform: 'darwin', explicitPython: python }), /^Error: \[engine_source_missing\]/);
	});

	test('source run, nothing set: a bundled engine at a development location, else fails by name', () => {
		const { appRoot, extensionPath } = sourceRun();
		fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
		assert.throws(() => selectEngine({ extensionPath, appRoot, platform: 'darwin', explicitPython: '' }), /^Error: \[engine_missing\] Quantlab: no bundled backtest engine at .*, and quantlab\.pythonPath is not set\.$/);
		const exe = place(path.join(root, 'engine-dist', 'quantlab-engine', 'quantlab-engine'));
		assert.deepStrictEqual(selectEngine({ extensionPath, appRoot, platform: 'darwin', explicitPython: '' }), {
			executable: exe, source: 'development bundled engine', cwd: path.dirname(exe), engineRoot: null,
		});
	});

	test('the build stamp decides: no commit is a source run, a commit string is packaged, anything else or no product.json throws by name', () => {
		const appRoot = path.join(root, 'app');
		writeProduct(appRoot);
		assert.strictEqual(isPackagedApp(appRoot), false);
		writeProduct(appRoot, 'abc123');
		assert.strictEqual(isPackagedApp(appRoot), true);
		for (const bad of ['', 7, null]) {
			writeProduct(appRoot, bad);
			assert.throws(() => isPackagedApp(appRoot), /^Error: \[product_unreadable\] Quantlab: .*commit that is not a non-empty string/);
		}
		fs.rmSync(path.join(appRoot, 'product.json'));
		assert.throws(() => isPackagedApp(appRoot), /^Error: \[product_unreadable\] Quantlab: cannot tell a packaged app from a source run/);
	});
});
