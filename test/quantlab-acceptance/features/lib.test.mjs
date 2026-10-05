/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test test/quantlab-acceptance/features/lib.test.mjs

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { assemble, CHECK_IDS, checkIdsFor, findBuiltInExtensionDir, galleryHosts, judgePackQuiet, judgePackRow, judgePinnedDependency, packMembers, processesInside, readForkSha, readPins, requestUrls, treeDigest } from './lib.mjs';

const { ask, serve } = createRequire(import.meta.url)('./cues.cjs');

const pins = [
	{ name: 'ms-python.python', version: '2026.4.0' },
	{ name: 'detachhead.basedpyright', version: '1.40.2' },
	{ name: 'ms-toolsai.jupyter', version: '2025.9.1' },
];

test('readPins: the three versions; a missing, doubled or versionless pin throws by name', () => {
	assert.deepStrictEqual(readPins({ builtInExtensions: pins }), { 'ms-python.python': '2026.4.0', 'detachhead.basedpyright': '1.40.2', 'ms-toolsai.jupyter': '2025.9.1' });
	assert.throws(() => readPins({}), /pins_unreadable/);
	assert.throws(() => readPins({ builtInExtensions: pins.slice(1) }), /names ms-python.python 0 times/);
	assert.throws(() => readPins({ builtInExtensions: [...pins, pins[0]] }), /names ms-python.python 2 times/);
	assert.throws(() => readPins({ builtInExtensions: [{ name: 'ms-python.python' }, pins[1], pins[2]] }), /no version for ms-python.python/);
});

test('readForkSha: a 40-hex commit, anything else throws', () => {
	assert.strictEqual(readForkSha({ commit: 'a'.repeat(40) }), 'a'.repeat(40));
	assert.throws(() => readForkSha({}), /fork_sha_unreadable/);
	assert.throws(() => readForkSha({ commit: 'abc' }), /fork_sha_unreadable/);
});

test('assemble: rc 0 only when all five are PASS; NOT RUN, an unreported check and an unknown status are non-zero', () => {
	const all = Object.fromEntries(CHECK_IDS.map(id => [id, { status: 'PASS', detail: 'ok' }]));
	assert.strictEqual(assemble(all, CHECK_IDS).rc, 0);
	assert.strictEqual(assemble({ ...all, import: { status: 'NOT RUN', detail: 'x' } }, CHECK_IDS).rc, 1);
	const missing = assemble({ ...all, import: undefined }, CHECK_IDS);
	assert.deepStrictEqual([missing.rc, missing.checks[4].status, /check_unreported/.test(missing.checks[4].detail)], [1, 'FAIL', true]);
	const odd = assemble({ ...all, import: { status: 'GREEN', detail: 'x' } }, CHECK_IDS);
	assert.deepStrictEqual([odd.rc, odd.checks[4].status], [1, 'FAIL']);
	assert.deepStrictEqual(assemble({}, CHECK_IDS).checks.map(check => check.id), CHECK_IDS);
});

test('judgePinnedDependency: PASS needs a clean app AND a control that names exactly the removed pin', () => {
	const ok = { ok: true, missing: [], lines: [] };
	const named = { ok: false, missing: ['detachhead.basedpyright'], lines: ['[pinned_dependency_missing] detachhead.basedpyright 1.40.2'] };
	assert.strictEqual(judgePinnedDependency(ok, named, 'detachhead.basedpyright').status, 'PASS');
	assert.strictEqual(judgePinnedDependency(ok, ok, 'detachhead.basedpyright').status, 'FAIL');
	assert.strictEqual(judgePinnedDependency(named, named, 'detachhead.basedpyright').status, 'FAIL');
	assert.strictEqual(judgePinnedDependency(ok, { ok: false, missing: ['ms-toolsai.jupyter'], lines: ['x'] }, 'detachhead.basedpyright').status, 'FAIL');
	assert.strictEqual(judgePinnedDependency(ok, undefined, 'detachhead.basedpyright').status, 'NOT RUN');
});

test('treeDigest and findBuiltInExtensionDir on a small tree', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-features-lib-'));
	try {
		fs.mkdirSync(path.join(root, 'ext', 'ms-python.python'), { recursive: true });
		fs.mkdirSync(path.join(root, 'ext', 'other'));
		fs.writeFileSync(path.join(root, 'ext', 'ms-python.python', 'package.json'), JSON.stringify({ publisher: 'ms-python', name: 'python' }));
		fs.writeFileSync(path.join(root, 'ext', 'other', 'package.json'), JSON.stringify({ publisher: 'x', name: 'y' }));
		assert.strictEqual(findBuiltInExtensionDir(path.join(root, 'ext'), 'ms-python.python'), path.join(root, 'ext', 'ms-python.python'));
		assert.throws(() => findBuiltInExtensionDir(path.join(root, 'ext'), 'ms-toolsai.jupyter'), /builtin_not_found/);
		const before = treeDigest(root);
		assert.strictEqual(before.files, 2);
		assert.deepStrictEqual(treeDigest(root), before);
		fs.writeFileSync(path.join(root, 'ext', 'other', 'package.json'), JSON.stringify({ publisher: 'x', name: 'z' }));
		assert.notStrictEqual(treeDigest(root).sha256, before.sha256);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('processesInside: only commands run from inside a launched bundle, never the launcher itself', () => {
	const ps = [
		'  101 /evidence/Delta Plus.app/Contents/MacOS/Delta Plus /evidence/main/workspace --user-data-dir=/x',
		'  102 /evidence/Delta Plus.app/Contents/Resources/app/extensions/quantlab/engine/quantlab-engine/quantlab-engine -m quantlab.cli.run_backtest',
		'  103 /evidence/control/Delta Plus.app/Contents/Frameworks/Delta Plus Helper.app/Contents/MacOS/Delta Plus Helper',
		'  104 /Applications/Delta Plus.app/Contents/MacOS/Delta Plus',
		'  105 /evidence/Delta Plus.app2/Contents/MacOS/x',
		'  200 /evidence/Delta Plus.app/Contents/MacOS/Delta Plus /runner/launcher.mjs',
		'garbage',
	].join('\n');
	assert.deepStrictEqual(processesInside(ps, ['/evidence/Delta Plus.app', '/evidence/control/Delta Plus.app'], 200).map(p => p.pid), [101, 102, 103]);
	assert.deepStrictEqual(processesInside(ps, ['/nowhere.app'], 200), []);
});

test('cues: a request is answered once by name; an unknown step and a throwing step come back as named errors', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-cues-'));
	let stop = false;
	const served = serve(dir, {
		double: async args => args.n * 2,
		broken: async () => { throw new Error('[broken_step] it broke'); },
	}, () => stop);
	try {
		assert.strictEqual(await ask(dir, 'double', { n: 21 }, 5000), 42);
		await assert.rejects(ask(dir, 'broken', {}, 5000), /\[broken_step\] it broke/);
		await assert.rejects(ask(dir, 'nosuch', {}, 5000), /\[cue_unknown\] the window driver has no step named nosuch/);
		await assert.rejects(ask(dir, 'double', { n: 1 }, 5000), /\[cue_reused\]/);
	} finally {
		stop = true;
		assert.deepStrictEqual(await served, ['double', 'broken', 'nosuch']);
		fs.rmSync(dir, { recursive: true });
	}
	const silent = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-cues-'));
	try {
		await assert.rejects(ask(silent, 'nobody', {}, 1200), /\[cue_unanswered\] the window driver did not answer nobody in 1.2 s/);
	} finally {
		fs.rmSync(silent, { recursive: true });
	}
});

test('checkIdsFor: off judges every row, on only the extension-pack row; anything else throws', () => {
	assert.deepStrictEqual(checkIdsFor('off'), CHECK_IDS);
	assert.deepStrictEqual(checkIdsFor('on'), ['extension-pack-quiet']);
	assert.throws(() => checkIdsFor(undefined), /network_mode_invalid/);
	assert.strictEqual(assemble({ 'extension-pack-quiet': { status: 'PASS', detail: 'ok' } }, checkIdsFor('on')).rc, 0);
	assert.strictEqual(assemble({ 'extension-pack-quiet': { status: 'PASS', detail: 'ok' } }, checkIdsFor('off')).rc, 1);
});

test('packMembers: the union of both owners\' extensionPack, lowercased; none at all throws', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-pack-'));
	try {
		const put = (folder, pkg) => {
			fs.mkdirSync(path.join(dir, folder));
			fs.writeFileSync(path.join(dir, folder, 'package.json'), JSON.stringify(pkg));
		};
		put('python', { publisher: 'ms-python', name: 'python', extensionPack: ['ms-python.vscode-pylance', 'ms-python.debugpy'] });
		put('jupyter', { publisher: 'ms-toolsai', name: 'jupyter', extensionPack: ['ms-toolsai.Jupyter-Keymap'] });
		assert.deepStrictEqual(packMembers(dir), ['ms-python.debugpy', 'ms-python.vscode-pylance', 'ms-toolsai.jupyter-keymap']);
		fs.writeFileSync(path.join(dir, 'python', 'package.json'), JSON.stringify({ publisher: 'ms-python', name: 'python' }));
		fs.writeFileSync(path.join(dir, 'jupyter', 'package.json'), JSON.stringify({ publisher: 'ms-toolsai', name: 'jupyter' }));
		assert.throws(() => packMembers(dir), /pack_unread/);
	} finally {
		fs.rmSync(dir, { recursive: true });
	}
});

test('galleryHosts and requestUrls: the product gallery, its download host and the marketplace; begin lines only', () => {
	const hosts = galleryHosts({ extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery', resourceUrlTemplate: 'https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/{path}' } });
	assert.deepStrictEqual(hosts, ['marketplace.visualstudio.com', 'open-vsx.org', 'openvsx.eclipsecontent.org', 'vsassets.io', 'vscode-unpkg.net']);
	assert.throws(() => galleryHosts({}), /gallery_unreadable/);
	const log = '[trace] #1: https://open-vsx.org/vscode/gallery/extensionquery - begin GET {}\n[trace] #1: https://open-vsx.org/vscode/gallery/extensionquery - end GET 200\n[error] #2: https://example.org/x - error GET boom';
	assert.deepStrictEqual(requestUrls(log), ['https://open-vsx.org/vscode/gallery/extensionquery']);
});

test('judgePackQuiet: quiet passes; an install, a gallery request or a pack toast fails by name; a silent log fails', () => {
	const base = { members: ['ms-python.debugpy', 'ms-python.vscode-pylance'], hosts: ['open-vsx.org', 'vsassets.io'], installed: [], requests: ['https://update.example.org/latest'], traceLines: 40, toasts: ['Welcome'] };
	assert.strictEqual(judgePackQuiet(base).status, 'PASS');
	assert.deepStrictEqual(judgePackQuiet({ ...base, installed: ['ms-python.debugpy'] }).reasons, ['pack_installed']);
	assert.deepStrictEqual(judgePackQuiet({ ...base, requests: ['https://gallerycdn.vsassets.io/x'] }).reasons, ['gallery_request']);
	assert.deepStrictEqual(judgePackQuiet({ ...base, toasts: ['Pylance is recommended for Python files'] }).reasons, ['pack_toast']);
	assert.deepStrictEqual(judgePackQuiet({ ...base, toasts: ['Do you want to install debugpy?'] }).reasons, ['pack_toast']);
	assert.deepStrictEqual(judgePackQuiet({ ...base, traceLines: 0 }).reasons, ['trace_log_silent']);
	assert.throws(() => judgePackQuiet({ ...base, requests: ['not a url'] }), /request_url_unparseable/);
});

test('judgePackRow: PASS needs a quiet app AND a control that trips every detector the network allows', () => {
	const quiet = { status: 'PASS', reasons: [], detail: 'quiet' };
	const offControl = { status: 'FAIL', reasons: ['gallery_request', 'pack_toast'], detail: 'red' };
	const onControl = { status: 'FAIL', reasons: ['pack_installed', 'gallery_request', 'pack_toast'], detail: 'red' };
	assert.strictEqual(judgePackRow('off', quiet, offControl).status, 'PASS');
	assert.strictEqual(judgePackRow('on', quiet, onControl).status, 'PASS');
	assert.match(judgePackRow('on', quiet, offControl).detail, /control_detector_blind\] the control did not trip pack_installed/);
	assert.match(judgePackRow('off', quiet, quiet).detail, /control_not_red/);
	assert.match(judgePackRow('off', { status: 'FAIL', reasons: ['pack_toast'], detail: 'toast' }, offControl).detail, /^app: toast/);
});
