/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test test/quantlab-acceptance/features/lib.test.mjs

import assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { connect, evaluateInFrames } from './cdp.mjs';
import { isAppSurface } from './window.mjs';
import { assemble, assertNoAsarEnvAbsent, CHECK_IDS, checkIdsFor, closeApp, DIALOG_MODES, driverArgs, findBuiltInExtensionDir, galleryHosts, IMPORT_KEYBINDING, IMPORT_SETTINGS, judgeImportNamedProfile, judgePackQuiet, judgePackRow, judgePinnedDependency, judgeQuantbookMcpAbsent, MOCK_KEYCHAIN, NAMED_PROFILE, packMembers, processesInside, profileArgs, readForkSha, readNamedProfileState, readPins, requestUrls, treeDigest } from './lib.mjs';

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

test('treeDigest hashes a file named node_modules.asar as bytes: one changed byte changes the digest', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-features-asar-'));
	try {
		fs.mkdirSync(path.join(root, 'app', 'node_modules'), { recursive: true });
		fs.writeFileSync(path.join(root, 'app', 'node_modules', 'x.js'), '1');
		const asar = path.join(root, 'app', 'node_modules.asar');
		fs.writeFileSync(asar, Buffer.concat([Buffer.from('{"files":{}}'), Buffer.alloc(16)]));
		assert.strictEqual(fs.statSync(asar).size, 28);
		const before = treeDigest(root);
		assert.strictEqual(before.files, 2);
		assert.deepStrictEqual(treeDigest(root), before);
		const bytes = fs.readFileSync(asar);
		bytes[27] = 1;
		fs.writeFileSync(asar, bytes);
		assert.notStrictEqual(treeDigest(root).sha256, before.sha256);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('assertNoAsarEnvAbsent: ELECTRON_NO_ASAR in the environment throws by name, any value; absent passes', () => {
	assert.doesNotThrow(() => assertNoAsarEnvAbsent({ PATH: '/bin' }));
	assert.throws(() => assertNoAsarEnvAbsent({ ELECTRON_NO_ASAR: '1' }), /asar_env_set/);
	assert.throws(() => assertNoAsarEnvAbsent({ ELECTRON_NO_ASAR: '' }), /asar_env_set/);
});

test('launcher.mjs sets process.noAsar before any fs call and never puts ELECTRON_NO_ASAR in an env it builds', () => {
	const source = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
	const set = source.indexOf('process.noAsar = true;');
	assert.ok(set > 0, 'launcher.mjs does not set process.noAsar = true');
	assert.ok(set < source.indexOf('fs.'), 'process.noAsar = true comes after the first fs use');
	assert.ok(!/ELECTRON_NO_ASAR\s*[:=]/.test(source), 'launcher.mjs assigns ELECTRON_NO_ASAR');
});

/** A WebSocket server on 127.0.0.1: `onData(socket)` runs for each chunk a client sends after the handshake. */
async function webSocketServer(onData) {
	const sockets = [];
	const server = http.createServer();
	server.on('upgrade', (request, socket) => {
		sockets.push(socket);
		const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		let pending = Buffer.alloc(0);
		socket.on('data', chunk => {
			if (result.handle) {
				const { messages, rest } = clientMessages(Buffer.concat([pending, chunk]));
				pending = rest;
				messages.forEach(message => result.handle(socket, message));
			} else {
				onData(socket);
			}
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const result = {
		endpoint: `ws://127.0.0.1:${server.address().port}/devtools/browser/test`,
		close: () => { sockets.forEach(socket => socket.destroy()); server.close(); },
	};
	return result;
}

/** One unmasked text frame (payload under 126 bytes). */
function textFrame(text) {
	const payload = Buffer.from(text);
	assert.ok(payload.length < 126);
	return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

test('cdp connect: a request the endpoint never answers rejects by name at the limit; an answered one resolves', async () => {
	const silent = await webSocketServer(() => { });
	const answering = await webSocketServer(socket => socket.write(textFrame('{"id":1,"result":{"ok":true}}')));
	try {
		const cdp = await connect(silent.endpoint, 300);
		const begun = Date.now();
		await assert.rejects(cdp.send('Target.getTargets'), /^Error: \[cdp_no_answer\] Target\.getTargets: no answer after 0\.3 s$/);
		assert.ok(Date.now() - begun >= 290, 'rejected before the limit');
		await assert.rejects(cdp.send('Page.getFrameTree', {}, 'S1'), /\[cdp_no_answer\] Page\.getFrameTree \(session S1\)/);
		cdp.close();
		const live = await connect(answering.endpoint, 5000);
		assert.deepStrictEqual(await live.send('Target.getTargets'), { ok: true });
		live.close();
	} finally {
		silent.close();
		answering.close();
	}
});

test('cdp connect: an endpoint that accepts and never completes the handshake rejects by name; the limit is required', async () => {
	const sockets = [];
	const server = http.createServer();
	server.on('upgrade', (_request, socket) => sockets.push(socket));
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const endpoint = `ws://127.0.0.1:${server.address().port}/x`;
		await assert.rejects(connect(endpoint, 300), /\[cdp_connect_timeout\] .* not open after 0\.3 s/);
		await assert.rejects(connect(endpoint), /cdp_answer_limit_missing/);
		await assert.rejects(connect(endpoint, 0), /cdp_answer_limit_missing/);
	} finally {
		sockets.forEach(socket => socket.destroy());
		server.close();
	}
});

/** The client's complete masked text frames at the start of `pending` (payloads under 64 KiB), decoded, and the bytes left over. */
function clientMessages(pending) {
	const messages = [];
	let at = 0;
	while (pending.length - at >= 2) {
		let length = pending[at + 1] & 0x7f;
		let head = at + 2;
		if (length === 126) {
			if (pending.length - head < 2) {
				break;
			}
			length = pending.readUInt16BE(head);
			head += 2;
		}
		assert.ok(length < 65536 && (pending[at + 1] & 0x80) !== 0);
		if (pending.length < head + 4 + length) {
			break;
		}
		const mask = pending.subarray(head, head + 4);
		const payload = Buffer.from(pending.subarray(head + 4, head + 4 + length).map((byte, i) => byte ^ mask[i % 4]));
		if ((pending[at] & 0x0f) === 0x1) {
			messages.push(JSON.parse(payload.toString('utf8')));
		}
		at = head + 4 + length;
	}
	return { messages, rest: pending.subarray(at) };
}

/** One unmasked text frame of any length under 64 KiB. */
function serverFrame(text) {
	const payload = Buffer.from(text);
	return Buffer.concat([payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]), payload]);
}

/** A browser endpoint with a workbench page and a page whose URL is empty and whose frame tree is never answered (the guest's). */
async function guestLikeBrowser() {
	const asked = [];
	const server = await webSocketServer(() => { });
	server.handle = (socket, message) => {
		asked.push(`${message.method}${message.sessionId ? ` ${message.sessionId}` : ''}`);
		const answer = result => socket.write(serverFrame(JSON.stringify({ id: message.id, result })));
		switch (message.method) {
			case 'Target.getTargets': return answer({ targetInfos: [
				{ targetId: 'BLANK', type: 'page', url: '' },
				{ targetId: 'WB', type: 'page', url: 'vscode-file://vscode-app/x/workbench.html' },
				{ targetId: 'SW', type: 'service_worker', url: 'vscode-webview://sw.js' },
			] });
			case 'Target.attachToTarget': return answer({ sessionId: `S-${message.params.targetId}` });
			case 'Page.getFrameTree': return message.sessionId === 'S-BLANK' ? undefined : answer({ frameTree: { frame: { id: 'F1', url: 'vscode-file://vscode-app/x/workbench.html' } } });
			case 'Page.createIsolatedWorld': return answer({ executionContextId: 7 });
			case 'Runtime.evaluate': return answer({ result: { value: { state: 'present' } } });
			case 'Target.detachFromTarget': return answer({});
		}
	};
	return { server, asked };
}

test('evaluateInFrames attaches only to app-surface targets: the guest\'s silent blank page is listed as not attached, the workbench answers', async () => {
	const { server, asked } = await guestLikeBrowser();
	try {
		const cdp = await connect(server.endpoint, 500);
		const result = await evaluateInFrames(cdp, isAppSurface, url => url.startsWith('vscode-file://'), () => ({ state: 'present' }), null);
		assert.deepStrictEqual(result, {
			values: [{ url: 'vscode-file://vscode-app/x/workbench.html', targetId: 'WB', frameId: 'F1', value: { state: 'present' } }],
			errors: [],
			skipped: ['page ""'],
		});
		assert.ok(!asked.some(line => line.includes('BLANK')), `the blank page was asked: ${asked.join(', ')}`);
		await assert.rejects(evaluateInFrames(cdp, undefined, url => url.startsWith('vscode-file://'), () => ({}), null), /cdp_target_filter_missing/);
		cdp.close();
		// Control: every target accepted, as before this change -> the blank page's frame tree is the named failure.
		const all = await connect(server.endpoint, 500);
		await assert.rejects(evaluateInFrames(all, () => true, url => url.startsWith('vscode-file://'), () => ({}), null),
			/^Error: \[cdp_no_answer\] Page\.getFrameTree \(session S-BLANK\): no answer after 0\.5 s \(target page \)$/);
		all.close();
	} finally {
		server.close();
	}
});

test('driverArgs: the dialog modes run the driver without --extensionTestsPath (dialogs are refused there); the others with it', () => {
	assert.deepStrictEqual(DIALOG_MODES, ['import', 'import-profile', 'pack-trigger']);
	for (const mode of DIALOG_MODES) {
		assert.deepStrictEqual(driverArgs(mode, '/d'), ['--extensionDevelopmentPath=/d'], mode);
	}
	for (const mode of ['all', 'pins']) {
		assert.deepStrictEqual(driverArgs(mode, '/d'), ['--extensionDevelopmentPath=/d', '--extensionTestsPath=/d/checks.cjs'], mode);
	}
	assert.throws(() => driverArgs('pack', '/d'), /driver_mode_invalid/);
	assert.throws(() => driverArgs(undefined, '/d'), /driver_mode_invalid/);
});

test('the driver starts itself in the dialog modes: a loadable manifest, onStartupFinished, the same mode list, errors written as the result', () => {
	const driver = new URL('./driver/', import.meta.url);
	const manifest = JSON.parse(fs.readFileSync(new URL('package.json', driver), 'utf8'));
	assert.match(manifest.engines.vscode, /^\^1\.\d+\.\d+$/, 'engines.vscode must name a major and minor (the app rejects * for an extension under development)');
	assert.deepStrictEqual(manifest.activationEvents, ['onStartupFinished']);
	const extension = fs.readFileSync(new URL('extension.cjs', driver), 'utf8');
	assert.ok(extension.includes(`const DIALOG_MODES = ${DIALOG_MODES.map(mode => `'${mode}'`).join(', ').replace(/^/, '[').replace(/$/, ']')};`), 'extension.cjs DIALOG_MODES differs from lib.mjs');
	assert.ok(extension.includes('driverError'), 'extension.cjs does not record a driver error');
	const checks = fs.readFileSync(new URL('checks.cjs', driver), 'utf8');
	const all = checks.slice(checks.indexOf(`if (mode === 'all')`), checks.indexOf(`} else if (mode === 'import')`));
	assert.ok(all.length > 0 && !all.includes('importFromVsCode'), 'the import (a modal) is still in the extension-tests mode');
	const launcher = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
	assert.ok(!launcher.includes('--extensionTestsPath'), 'launcher.mjs passes --extensionTestsPath itself instead of driverArgs');
	assert.strictEqual(launcher.match(/await launch\(/g).length, 5);
	assert.strictEqual(launcher.match(/await launch\([^\n]*, python, network\);/g).length, 5);
	assert.ok(launcher.includes(`'import', python, network)`), 'no import launch');
	assert.ok(launcher.includes(`'import-profile', python, network)`), 'no named-profile import launch');
	assert.ok(launcher.includes('...profileArgs(mode),'), 'launch() does not pass profileArgs(mode)');
});

test('isAppSurface: workbench and webview URLs only', () => {
	assert.strictEqual(isAppSurface('vscode-file://vscode-app/a/workbench.html'), true);
	assert.strictEqual(isAppSurface('vscode-webview://abc/index.html'), true);
	for (const url of ['', 'about:blank', 'http://127.0.0.1:47311/', 'devtools://devtools/x']) {
		assert.strictEqual(isAppSurface(url), false, url);
	}
});

test('launcher.mjs: every connect() passes CDP_ANSWER_MS and both launch functions carry the RUN_TIMEOUT_MS kill', () => {
	const source = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
	const connects = source.match(/[^.\w]connect\([^\n]*/g).filter(line => !line.includes('import'));
	assert.strictEqual(connects.length, 2);
	for (const line of connects) {
		assert.ok(/, CDP_ANSWER_MS\);$/.test(line), `connect without the answer limit: ${line}`);
	}
	assert.strictEqual(source.split(`setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);`).length - 1, 2);
	assert.ok(source.includes('[app_timeout] pack: killed after'), 'plainLaunch does not report its timeout');
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

test('judgeQuantbookMcpAbsent: PASS on a clean extension; the server module, the SDK, an MCP id or a missing tree FAIL by name', () => {
	const make = () => {
		const extensions = fs.mkdtempSync(path.join(os.tmpdir(), 'qbmcp-'));
		const ext = path.join(extensions, 'quantlab');
		fs.mkdirSync(path.join(ext, 'out', 'src', 'quantbook', 'mcp'), { recursive: true });
		fs.writeFileSync(path.join(ext, 'out', 'src', 'quantbook', 'mcp', 'mcpToolLogic.js'), '');
		fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify({ publisher: 'quantlab', name: 'quantlab', contributes: { commands: [{ command: 'quantlab.runBacktest' }], configuration: { properties: { 'quantlab.pythonPath': {} } } } }));
		return { extensions, ext };
	};
	const clean = make();
	assert.strictEqual(judgeQuantbookMcpAbsent(clean.extensions).status, 'PASS');

	const server = make();
	fs.writeFileSync(path.join(server.ext, 'out', 'src', 'quantbook', 'mcp', 'mcpServer.js'), '');
	assert.match(judgeQuantbookMcpAbsent(server.extensions).detail, /\[quantbook_mcp_shipped\].*mcpServer\.js/);

	const sdk = make();
	fs.mkdirSync(path.join(sdk.ext, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
	assert.match(judgeQuantbookMcpAbsent(sdk.extensions).detail, /\[quantbook_mcp_shipped\].*@modelcontextprotocol/);

	const manifest = make();
	fs.writeFileSync(path.join(manifest.ext, 'package.json'), JSON.stringify({ publisher: 'quantlab', name: 'quantlab', contributes: { commands: [{ command: 'quantlab.quantbookStartMcpServer' }], configuration: { properties: {} } } }));
	assert.match(judgeQuantbookMcpAbsent(manifest.extensions).detail, /\[quantbook_mcp_shipped\].*quantbookStartMcpServer/);

	const tree = make();
	fs.rmSync(path.join(tree.ext, 'out'), { recursive: true });
	assert.match(judgeQuantbookMcpAbsent(tree.extensions).detail, /\[quantbook_tree_not_found\]/);

	const none = make();
	fs.rmSync(none.ext, { recursive: true });
	assert.match(judgeQuantbookMcpAbsent(none.extensions).detail, /\[quantlab_extension_not_found\]/);

	for (const t of [clean, server, sdk, manifest, tree, none]) {
		fs.rmSync(t.extensions, { recursive: true });
	}
});

test('closeApp: an app that exits passes even when its socket closes unanswered; one still running fails, naming the answer', async () => {
	const never = new Promise(() => { });
	const exited = Promise.resolve({ code: 0 });
	const closed = () => Promise.reject(new Error('[cdp_closed] Browser.close: the connection closed'));
	// the guest's P1e import and pack-trigger launches: a normal exit, the socket closed before the answer
	assert.strictEqual(await closeApp(closed, exited, 200), undefined);
	assert.strictEqual(await closeApp(() => Promise.resolve({}), exited, 200), undefined);
	// controls: an app that does not exit fails whatever Browser.close got
	assert.strictEqual(await closeApp(() => Promise.resolve({}), never, 50), 'the app did not exit 0.05 s after Browser.close (answered)');
	assert.strictEqual(await closeApp(closed, never, 50), 'the app did not exit 0.05 s after Browser.close ([cdp_closed] Browser.close: the connection closed)');
	assert.strictEqual(await closeApp(() => never, never, 50), 'the app did not exit 0.05 s after Browser.close (no answer)');
	let asked;
	await closeApp(method => { asked = method; return Promise.resolve({}); }, exited, 50);
	assert.strictEqual(asked, 'Browser.close');
});

test('every Browser.close in launcher.mjs goes through closeApp', () => {
	const source = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
	assert.strictEqual(source.split('\'Browser.close\'').length - 1, 0, 'launcher.mjs sends Browser.close itself');
	assert.strictEqual(source.split('await closeApp(').length - 1, 2, 'the dialog-mode launch and the plain launch');
});

test('every app launch in launcher.mjs carries the mock keychain flag (R-24)', () => {
	const source = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
	const launches = source.split('cp.spawn(appPaths(').slice(1).map(rest => rest.slice(0, rest.indexOf('], {')));
	assert.ok(launches.length >= 2, `found ${launches.length} app launches in launcher.mjs`);
	assert.deepStrictEqual(launches.map(args => args.includes('MOCK_KEYCHAIN')), launches.map(() => true));
	assert.strictEqual(MOCK_KEYCHAIN, '--use-mock-keychain');
});

// ---- the import-named-profile row (QL-G-FEAT c1 M3) ----

const PLANT = { dir: 'abc123', settings: { 'editor.tabSize': 3, 'editor.fontSize': 11 }, keybindings: [{ key: 'ctrl+alt+w', command: 'workbench.action.files.save' }] };
const SHA_S = 'a'.repeat(64);
const SHA_K = 'b'.repeat(64);

/** A passing observation: one profile directory with the merged files and both backups; the default profile's two files unchanged. */
function namedProfileObs(change = {}) {
	const dir = {
		name: 'abc123',
		path: '/e/import-profile/user-data/User/profiles/abc123',
		files: ['keybindings.json', 'keybindings.json.pre-import-20261008T080000Z', 'settings.json', 'settings.json.pre-import-20261008T080000Z'],
		settings: JSON.stringify({ ...PLANT.settings, ...IMPORT_SETTINGS }),
		keybindings: JSON.stringify([...PLANT.keybindings, IMPORT_KEYBINDING]),
		backups: [
			{ name: 'keybindings.json.pre-import-20261008T080000Z', text: JSON.stringify(PLANT.keybindings) },
			{ name: 'settings.json.pre-import-20261008T080000Z', text: JSON.stringify(PLANT.settings) },
		],
	};
	return { planted: PLANT, plantedDirs: ['abc123'], defaultBefore: { settings: SHA_S, keybindings: null }, state: { dirs: [dir], defaultAfter: { settings: SHA_S, keybindings: null } }, ...change };
}

test('judgeImportNamedProfile: PASS names the profile directory and the files; the default profile unchanged (settings sha, keybindings absent)', () => {
	const verdict = judgeImportNamedProfile(namedProfileObs());
	assert.strictEqual(verdict.status, 'PASS', verdict.detail);
	assert.ok(verdict.detail.includes('/e/import-profile/user-data/User/profiles/abc123'));
	assert.ok(verdict.detail.includes('settings.json') && verdict.detail.includes('keybindings.json'));
	assert.ok(verdict.detail.includes('settings.json.pre-import-20261008T080000Z') && verdict.detail.includes('keybindings.json.pre-import-20261008T080000Z'));
	assert.ok(verdict.detail.includes(SHA_S) && verdict.detail.includes('keybindings.json (absent)'));
});

test('judgeImportNamedProfile: the default profile written -> [default_profile_written] naming the file and both digests', () => {
	const settingsChanged = judgeImportNamedProfile(namedProfileObs({ state: { ...namedProfileObs().state, defaultAfter: { settings: 'c'.repeat(64), keybindings: null } } }));
	assert.strictEqual(settingsChanged.status, 'FAIL');
	assert.ok(settingsChanged.detail.includes(`[default_profile_written] the default profile's User/settings.json changed: sha256 ${SHA_S} before, ${'c'.repeat(64)} after`), settingsChanged.detail);
	// A default keybindings.json that appeared where there was none is a write as well.
	const created = judgeImportNamedProfile(namedProfileObs({ state: { ...namedProfileObs().state, defaultAfter: { settings: SHA_S, keybindings: SHA_K } } }));
	assert.strictEqual(created.status, 'FAIL');
	assert.ok(created.detail.includes(`[default_profile_written] the default profile's User/keybindings.json changed: sha256 absent before, ${SHA_K} after`), created.detail);
	// The pre-fix behaviour: the default profile's files written and the named profile's left as planted.
	const old = namedProfileObs();
	old.state.dirs[0] = { ...old.state.dirs[0], settings: JSON.stringify(PLANT.settings), keybindings: JSON.stringify(PLANT.keybindings), backups: [] };
	old.state.defaultAfter = { settings: 'd'.repeat(64), keybindings: SHA_K };
	const tags = ['default_profile_written', 'profile_settings_missing', 'profile_backup_missing'].filter(tag => judgeImportNamedProfile(old).detail.includes(`[${tag}]`));
	assert.deepStrictEqual(tags, ['default_profile_written', 'profile_settings_missing', 'profile_backup_missing']);
});

test('judgeImportNamedProfile: zero or two profile directories -> [profile_dir_count]; the files and backups are not judged then', () => {
	const none = judgeImportNamedProfile(namedProfileObs({ planted: undefined, plantedDirs: [], state: { dirs: [], defaultAfter: { settings: SHA_S, keybindings: null } } }));
	assert.strictEqual(none.status, 'FAIL');
	assert.ok(none.detail.includes('[profile_dir_count] expected exactly one directory under User/profiles, the one planted into: found [] after the import (0)'), none.detail);
	assert.ok(!none.detail.includes('[profile_settings_missing]') && !none.detail.includes('[profile_backup_missing]'));
	const two = namedProfileObs();
	two.state.dirs.push({ ...two.state.dirs[0], name: 'def456', path: '/e/import-profile/user-data/User/profiles/def456' });
	const verdict = judgeImportNamedProfile(two);
	assert.strictEqual(verdict.status, 'FAIL');
	assert.ok(verdict.detail.includes('[profile_dir_count]') && verdict.detail.includes('found [abc123, def456] after the import (2)'), verdict.detail);
	// One directory now, but the driver planted into a different one (or saw two before): not the profile it prepared.
	const other = judgeImportNamedProfile(namedProfileObs({ plantedDirs: ['abc123', 'zzz'], planted: { ...PLANT, dir: 'zzz' } }));
	assert.ok(other.detail.includes('[profile_dir_count]') && other.detail.includes('planted into zzz'), other.detail);
});

test('judgeImportNamedProfile: the imported values or the keybinding missing in the profile, or an absent or unparseable file -> [profile_settings_missing]', () => {
	const mutate = change => {
		const obs = namedProfileObs();
		obs.state.dirs[0] = { ...obs.state.dirs[0], ...change };
		return judgeImportNamedProfile(obs);
	};
	const old = mutate({ settings: JSON.stringify(PLANT.settings) });
	assert.strictEqual(old.status, 'FAIL');
	assert.ok(old.detail.includes('[profile_settings_missing] editor.fontSize is 11 in /e/import-profile/user-data/User/profiles/abc123/settings.json, expected 17'), old.detail);
	assert.ok(old.detail.includes('files.trimTrailingWhitespace is undefined'), old.detail);
	const lost = mutate({ settings: JSON.stringify(IMPORT_SETTINGS) });
	assert.ok(lost.detail.includes('[profile_settings_missing] editor.tabSize is undefined'), lost.detail);
	const noSettings = mutate({ settings: undefined });
	assert.ok(noSettings.detail.includes('[profile_settings_missing]') && noSettings.detail.includes('settings.json is absent'), noSettings.detail);
	const noKeybinding = mutate({ keybindings: JSON.stringify(PLANT.keybindings) });
	assert.ok(noKeybinding.detail.includes(`[profile_settings_missing] ${IMPORT_KEYBINDING.key} -> ${IMPORT_KEYBINDING.command} is not in`), noKeybinding.detail);
	const noKeybindings = mutate({ keybindings: undefined });
	assert.ok(noKeybindings.detail.includes('keybindings.json is absent'), noKeybindings.detail);
	const garbled = mutate({ settings: '{ not json' });
	assert.ok(garbled.detail.includes('settings.json is not a JSON object'), garbled.detail);
	assert.ok(![old, lost, noSettings, noKeybinding, noKeybindings, garbled].some(v => v.detail.includes('[default_profile_written]')));
});

test('judgeImportNamedProfile: a missing, doubled or wrong pre-import backup beside the profile\'s files -> [profile_backup_missing]', () => {
	const mutate = backups => {
		const obs = namedProfileObs();
		obs.state.dirs[0] = { ...obs.state.dirs[0], backups };
		return judgeImportNamedProfile(obs);
	};
	const [keybindingsBackup, settingsBackup] = namedProfileObs().state.dirs[0].backups;
	const noSettings = mutate([keybindingsBackup]);
	assert.strictEqual(noSettings.status, 'FAIL');
	assert.ok(noSettings.detail.includes('[profile_backup_missing] expected exactly one settings.json.pre-import-* in /e/import-profile/user-data/User/profiles/abc123 holding the planted settings.json, found []'), noSettings.detail);
	const noKeybindings = mutate([settingsBackup]);
	assert.ok(noKeybindings.detail.includes('[profile_backup_missing] expected exactly one keybindings.json.pre-import-*'), noKeybindings.detail);
	const none = mutate([]);
	assert.strictEqual((none.detail.match(/\[profile_backup_missing\]/g) ?? []).length, 2);
	const twice = mutate([keybindingsBackup, settingsBackup, { ...settingsBackup, name: 'settings.json.pre-import-20261008T080000Z-1' }]);
	assert.ok(twice.detail.includes('found [settings.json.pre-import-20261008T080000Z, settings.json.pre-import-20261008T080000Z-1]'), twice.detail);
	const wrong = mutate([keybindingsBackup, { ...settingsBackup, text: JSON.stringify({ 'editor.tabSize': 9 }) }]);
	assert.ok(wrong.detail.includes('found [settings.json.pre-import-20261008T080000Z] with other content'), wrong.detail);
});

test('judgeImportNamedProfile: no observation, or no profile state, is a FAIL by name, never a pass', () => {
	for (const obs of [undefined, {}, { planted: PLANT, defaultBefore: { settings: null, keybindings: null } }, { planted: PLANT, state: namedProfileObs().state }]) {
		const verdict = judgeImportNamedProfile(obs);
		assert.strictEqual(verdict.status, 'FAIL');
		assert.ok(verdict.detail.startsWith('[profile_import_unreported]'), verdict.detail);
	}
});

test('readNamedProfileState: reads the profile directories, their files and backups and the default profile\'s digests from a real tree', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-features-profile-'));
	try {
		const user = path.join(root, 'User');
		fs.mkdirSync(path.join(user, 'profiles', 'p1'), { recursive: true });
		fs.mkdirSync(path.join(user, 'profiles', 'p2'));
		fs.writeFileSync(path.join(user, 'profiles', 'stray-file'), 'x');
		fs.writeFileSync(path.join(user, 'settings.json'), '{"a":1}');
		fs.writeFileSync(path.join(user, 'profiles', 'p1', 'settings.json'), '{"b":2}');
		fs.writeFileSync(path.join(user, 'profiles', 'p1', 'settings.json.pre-import-20261008T080000Z'), '{}');
		fs.writeFileSync(path.join(user, 'profiles', 'p1', 'keybindings.json.pre-import-20261008T080000Z-1'), '[]');
		const state = readNamedProfileState(root);
		assert.deepStrictEqual(state.dirs.map(d => d.name), ['p1', 'p2']);
		assert.strictEqual(state.dirs[0].settings, '{"b":2}');
		assert.strictEqual(state.dirs[0].keybindings, undefined);
		assert.deepStrictEqual(state.dirs[0].backups.map(b => b.name), ['keybindings.json.pre-import-20261008T080000Z-1', 'settings.json.pre-import-20261008T080000Z']);
		assert.deepStrictEqual(state.dirs[1].files, []);
		assert.deepStrictEqual(state.defaultAfter, { settings: crypto.createHash('sha256').update('{"a":1}').digest('hex'), keybindings: null });
		assert.deepStrictEqual(readNamedProfileState(path.join(root, 'nowhere')), { dirs: [], defaultAfter: { settings: null, keybindings: null } });
	} finally {
		fs.rmSync(root, { recursive: true });
	}
});

test('import-named-profile wiring: --profile only in the import-profile launch; the row sits after import in the network-off run only; the driver plants the literals lib.mjs judges', () => {
	assert.deepStrictEqual(profileArgs('import-profile'), ['--profile', NAMED_PROFILE]);
	for (const mode of ['all', 'pins', 'import', 'pack-trigger']) {
		assert.deepStrictEqual(profileArgs(mode), [], mode);
	}
	assert.strictEqual(CHECK_IDS.indexOf('import-named-profile'), CHECK_IDS.indexOf('import') + 1);
	assert.ok(checkIdsFor('off').includes('import-named-profile') && !checkIdsFor('on').includes('import-named-profile'));
	const driver = fs.readFileSync(new URL('./driver/checks.cjs', import.meta.url), 'utf8');
	assert.ok(driver.includes(`const IMPORT_SETTINGS = { 'editor.fontSize': 17, 'files.trimTrailingWhitespace': true };`));
	assert.deepStrictEqual(IMPORT_SETTINGS, { 'editor.fontSize': 17, 'files.trimTrailingWhitespace': true });
	assert.ok(driver.includes(`const IMPORT_KEYBINDING = { key: 'ctrl+alt+q', command: 'workbench.action.files.saveAll' };`));
	assert.deepStrictEqual(IMPORT_KEYBINDING, { key: 'ctrl+alt+q', command: 'workbench.action.files.saveAll' });
	assert.ok(driver.includes(`const PROFILE_PLANT_SETTINGS = { 'editor.tabSize': 3, 'editor.fontSize': 11 };`));
	assert.ok(driver.includes(`const PROFILE_PLANT_KEYBINDINGS = [{ key: 'ctrl+alt+w', command: 'workbench.action.files.save' }];`));
	assert.deepStrictEqual(PLANT.settings, { 'editor.tabSize': 3, 'editor.fontSize': 11 });
	assert.deepStrictEqual(PLANT.keybindings, [{ key: 'ctrl+alt+w', command: 'workbench.action.files.save' }]);
	const launcher = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
	assert.ok(launcher.includes(`checks['import-named-profile'] = judgeNamedProfileLaunch(namedProfile, namedDir);`));
});
