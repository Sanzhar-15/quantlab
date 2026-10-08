/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test test/quantlab-acceptance/features/window.test.mjs
// The modal step (window.mjs pressModal): it looks for the dialog on both surfaces, the DOM and the native one, because the
// workbench decides per dialog; the native surface (native-dialog.mjs) is run against a fake accessibility scanner and the DOM
// surface against a fake CDP connection that evaluates the real in-page function on a fake workbench document.

import assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { pressNativeDialog } from './native-dialog.mjs';
import { awaitModal, checkDialogStyle, modalSurfaces, pressModal } from './window.mjs';

const MESSAGE = 'Import settings, keybindings and extensions from VS Code?';
const BUTTON = 'Import';
// Short limits: the product's are 60 s / 250 ms / 500 ms / 5 s (NATIVE_LIMITS).
const LIMITS = { waitMs: 300, pollMs: 20, settleMs: 0, closeMs: 200 };

test('checkDialogStyle: custom and native pass; any other value throws [dialog_style_unknown]', () => {
	checkDialogStyle('custom');
	checkDialogStyle('native');
	for (const style of ['default', 'Native', '', undefined, null, 1]) {
		assert.throws(() => checkDialogStyle(style), /\[dialog_style_unknown\] window\.dialogStyle is /, String(style));
	}
});

test('pressModal: an unknown or missing dialogStyle throws before the CDP connection or a pid is used (no poll)', async () => {
	await assert.rejects(pressModal(null, { message: MESSAGE, button: BUTTON, dialogStyle: 'auto' }, 123), /\[dialog_style_unknown\] window\.dialogStyle is "auto"/);
	await assert.rejects(pressModal(null, { message: MESSAGE, button: BUTTON }, 123), /\[dialog_style_unknown\] window\.dialogStyle is undefined/);
});

test('driver and launcher: both modal cues carry the dialogStyle reading, and the launcher hands the app pid to pressModal', () => {
	const driver = fs.readFileSync(new URL('./driver/checks.cjs', import.meta.url), 'utf8');
	assert.strictEqual(driver.split('dialogStyle: dialogStyle() }').length - 1, 2);
	assert.ok(driver.includes(`getConfiguration('window').get('dialogStyle')`));
	const launcher = fs.readFileSync(new URL('./launcher.mjs', import.meta.url), 'utf8');
	assert.strictEqual(launcher.split('pressModal(await window(), args, child.pid)').length - 1, 2);
});

test('native-dialog.jxa.js is the LOGIN+DATA kit\'s file byte for byte below the licence header: its sha256 is the one native-dialog.mjs records', () => {
	const sha = 'edd87c9bd3c1a6578a7bc439d2de6f7413ee5ae7f55110bf01ac15bdee67c8ee';
	const file = fs.readFileSync(new URL('./native-dialog.jxa.js', import.meta.url), 'utf8');
	const header = '*--------------------------------------------------------------------------------------------*/\n\n';
	const end = file.indexOf(header);
	assert.ok(file.startsWith('/*---') && end > 0, 'the licence header leads the file');
	assert.strictEqual(crypto.createHash('sha256').update(file.slice(end + header.length)).digest('hex'), sha);
	assert.ok(fs.readFileSync(new URL('./native-dialog.mjs', import.meta.url), 'utf8').includes(sha));
});

const sheet = (texts, buttons) => ({ kind: 'sheet', window: 1, path: '/1', buttons, texts, message: texts.join(' | ') });
const IMPORT_SHEET = sheet([MESSAGE, 'Your settings are backed up first.'], [BUTTON, 'Cancel']);

/**
 * A fake System Events: `present` is the list of dialogs on screen (it may change between scans); the scan answers as
 * native-dialog.jxa.js does (matches = containers holding all required buttons; a click only for exactly one match whose texts
 * contain the message). `onScan(n)` runs before scan n (1-based); `closesOnClick` false = the dialog survives its click.
 */
function fakeApp({ present, procCount = 1, closesOnClick = true, onScan = () => { }, failAt }) {
	const calls = [];
	const scan = async ({ pid, required, message, click }) => {
		calls.push({ pid, required, message, click });
		onScan(calls.length);
		if (calls.length === failAt) {
			throw new Error('[native_osascript_failed] route native: osascript FAILED: exit 1, stderr "assistive access"');
		}
		const matches = present.filter(d => required.every(t => d.buttons.includes(t)));
		const result = { pid, procCount, procName: 'Delta Plus', windows: [{ index: 1, role: 'AXWindow', subrole: 'AXStandardWindow', name: 'Delta Plus', title: 'Delta Plus', children: [], containers: [] }], matches, clicked: null, refusal: null, absent: [] };
		if (click !== undefined) {
			if (matches.length !== 1) {
				result.refusal = `click refused: ${matches.length} dialogs match (exactly 1 needed); nothing clicked`;
			} else if (!matches[0].message.includes(message)) {
				result.refusal = 'click refused: the one matching dialog has other texts; nothing clicked';
			} else {
				result.clicked = { title: click, container: 'sheet', window: 1, path: '/1/2' };
				if (closesOnClick) {
					present.splice(present.indexOf(matches[0]), 1);
				}
			}
		}
		return { raw: { command: 'fake osascript', exitCode: 0, signal: null, spawnError: null, stdout: 'QLNATIVE {}', stderr: '' }, result };
	};
	return { scan, calls };
}

const press = (app, args = { pid: 4242, message: MESSAGE, button: BUTTON }) => pressNativeDialog(args, { scan: app.scan, limits: LIMITS });
const clicks = app => app.calls.filter(c => c.click !== undefined);

test('native route: one dialog holding the button appears late, its message matches -> "Import" is clicked by title; the record names the route', async () => {
	const present = [];
	const app = fakeApp({ present, onScan: n => { if (n === 3) { present.push(IMPORT_SHEET); } } });
	const modal = await press(app);
	assert.strictEqual(modal.route, 'native');
	assert.strictEqual(modal.clicked, BUTTON);
	assert.deepStrictEqual(modal.labels, [BUTTON, 'Cancel']);
	assert.deepStrictEqual(modal.texts, [MESSAGE, 'Your settings are backed up first.']);
	assert.ok(modal.text.includes(MESSAGE));
	assert.deepStrictEqual(clicks(app).map(c => c.click), [BUTTON]);
	// Only the pressed button is required, of the app's pid; every scan carries the message the script checks before it clicks.
	assert.ok(app.calls.every(c => c.pid === 4242 && JSON.stringify(c.required) === JSON.stringify([BUTTON]) && c.message === MESSAGE));
	assert.deepStrictEqual(present, []);
});

test('native route: a dialog holding the button with another message is not clicked', async () => {
	const app = fakeApp({ present: [sheet(['Delete everything?', 'Really'], [BUTTON, 'Cancel'])] });
	await assert.rejects(press(app), /\[modal_wrong_message\] route native: .*"Delete everything\?".*nothing was clicked/);
	assert.deepStrictEqual(clicks(app), []);
});

test('native route: two dialogs holding the button -> throws, nothing clicked', async () => {
	const app = fakeApp({ present: [IMPORT_SHEET, { ...IMPORT_SHEET, path: '/2' }] });
	await assert.rejects(press(app), /\[modal_ambiguous\] route native: more than one native dialog holds "Import" \(2 matching/);
	assert.deepStrictEqual(clicks(app), []);
});

test('native route: no dialog in time -> [modal_missing] naming route native, the pid and the last scan\'s windows', async () => {
	const app = fakeApp({ present: [sheet(['Something else'], ['OK'])] });
	await assert.rejects(press(app), error => {
		assert.match(error.message, /^\[modal_missing\] no dialog "Import settings, keybindings and extensions from VS Code\?" with a button "Import", route native: /);
		assert.match(error.message, /pid 4242/);
		assert.match(error.message, /window 1 role="AXWindow" subrole="AXStandardWindow"/);
		return true;
	});
	assert.ok(app.calls.length > 2);
	assert.deepStrictEqual(clicks(app), []);
});

test('native route: the dialog still present after the click -> throws [modal_still_present]', async () => {
	const app = fakeApp({ present: [IMPORT_SHEET], closesOnClick: false });
	await assert.rejects(press(app), /\[modal_still_present\] route native: the dialog did not close 0\.2 s after "Import" was clicked/);
	assert.deepStrictEqual(clicks(app).map(c => c.click), [BUTTON]);
});

test('native route: an osascript failure is thrown as it came, never read as "no dialog"; a pid that is not one process, or no pid, throws', async () => {
	await assert.rejects(press(fakeApp({ present: [], failAt: 1 })), /\[native_osascript_failed\] route native: osascript FAILED: exit 1, stderr "assistive access"/);
	await assert.rejects(press(fakeApp({ present: [IMPORT_SHEET], failAt: 2 })), /\[native_osascript_failed\]/);
	await assert.rejects(press(fakeApp({ present: [], procCount: 0 })), /\[native_process\] route native: System Events lists 0 processes with unix id 4242/);
	await assert.rejects(press(fakeApp({ present: [IMPORT_SHEET] }), { pid: undefined, message: MESSAGE, button: BUTTON }), /\[native_pid_missing\]/);
});

test('native route: a click the script refuses (the dialog changed between the scans) throws with its reason', async () => {
	const present = [IMPORT_SHEET];
	// Between the reading scan (1) and the click scan (2) a second dialog appears: the script refuses and clicks nothing.
	const app = fakeApp({ present, onScan: n => { if (n === 2) { present.push({ ...IMPORT_SHEET, path: '/2' }); } } });
	await assert.rejects(press(app), /\[modal_click_refused\] route native: .*click refused: 2 dialogs match/);
	assert.strictEqual(present.length, 2);
});

// --- both surfaces ---
const TRUST_MESSAGE = 'Do you trust the publisher "ms-python"?';
const TRUST_BUTTON = 'Trust Publisher & Install';
const FAST = { ...LIMITS, waitMs: 200 };

/**
 * A fake CDP connection onto a fake workbench: `box` is the open .monaco-dialog-box ({ text, buttons: [labels] }) or null, `clicked`
 * the labels pressed. Runtime.evaluate runs the expression window.mjs sends (the real in-page function) against a fake `document`.
 */
function fakeWorkbench(box = null) {
	const wb = { box, clicked: [], evaluations: 0 };
	const document = {
		querySelector: selector => {
			if (selector !== '.monaco-dialog-box' || wb.box === null) {
				return null;
			}
			return {
				querySelector: inner => inner === '.dialog-message-text' ? { textContent: ` ${wb.box.text} ` } : null,
				querySelectorAll: inner => inner === '.monaco-button' ? wb.box.buttons.map(label => ({ textContent: ` ${label} `, click: () => wb.clicked.push(label) })) : [],
			};
		},
	};
	const url = 'vscode-file://vscode-app/workbench.html';
	wb.cdp = {
		send: async method => {
			switch (method) {
				case 'Target.getTargets': return { targetInfos: [{ type: 'page', url, targetId: 'T1' }] };
				case 'Target.attachToTarget': return { sessionId: 'S1' };
				case 'Page.getFrameTree': return { frameTree: { frame: { id: 'F1', url } } };
				case 'Page.createIsolatedWorld': return { executionContextId: 7 };
				case 'Target.detachFromTarget': return {};
				default: throw new Error(`fake CDP: unexpected ${method}`);
			}
		},
	};
	const send = wb.cdp.send;
	wb.cdp.send = async (method, params) => {
		if (method !== 'Runtime.evaluate') {
			return await send(method, params);
		}
		wb.evaluations++;
		return { result: { value: new Function('document', `return ${params.expression}`)(document) } };
	};
	return wb;
}

const importArgs = { message: MESSAGE, button: BUTTON, dialogStyle: 'native' };
const run = (wb, app, args = importArgs, pid = 4242) => awaitModal(args, modalSurfaces(wb.cdp, args, pid, { scan: app.scan, limits: FAST }), FAST);

test('both surfaces: a DOM dialog only (the publisher-trust prompt carries custom options) -> pressed on the DOM, native never clicked; the record names surface, route and the driver\'s dialogStyle', async () => {
	const wb = fakeWorkbench({ text: TRUST_MESSAGE, buttons: [TRUST_BUTTON, 'Cancel'] });
	const app = fakeApp({ present: [] });
	const args = { message: TRUST_MESSAGE, button: TRUST_BUTTON, dialogStyle: 'native' };
	const modal = await run(wb, app, args);
	assert.strictEqual(modal.surface, 'dom');
	assert.strictEqual(modal.route, 'dom');
	assert.strictEqual(modal.dialogStyle, 'native');
	assert.strictEqual(modal.clicked, TRUST_BUTTON);
	assert.strictEqual(modal.text, TRUST_MESSAGE);
	assert.deepStrictEqual(modal.labels, [TRUST_BUTTON, 'Cancel']);
	assert.deepStrictEqual(wb.clicked, [TRUST_BUTTON]);
	assert.deepStrictEqual(clicks(app), []);
	assert.ok(app.calls.length > 0, 'the native surface was read in the same poll');
});

test('both surfaces: a native dialog only (the import confirmation) -> pressed natively, DOM never clicked', async () => {
	const wb = fakeWorkbench(null);
	const present = [IMPORT_SHEET];
	const app = fakeApp({ present });
	const modal = await run(wb, app);
	assert.strictEqual(modal.surface, 'native');
	assert.strictEqual(modal.route, 'native');
	assert.strictEqual(modal.dialogStyle, 'native');
	assert.strictEqual(modal.clicked, BUTTON);
	assert.deepStrictEqual(clicks(app).map(c => c.click), [BUTTON]);
	assert.deepStrictEqual(wb.clicked, []);
	assert.ok(wb.evaluations > 0, 'the DOM surface was read in the same poll');
	assert.deepStrictEqual(present, []);
});

test('both surfaces: the dialog appears late on either surface -> found by a later poll and pressed there', async () => {
	const lateDom = fakeWorkbench(null);
	const domApp = fakeApp({ present: [], onScan: n => { if (n === 3) { lateDom.box = { text: MESSAGE, buttons: [BUTTON, 'Cancel'] }; } } });
	assert.strictEqual((await run(lateDom, domApp)).surface, 'dom');
	assert.deepStrictEqual(lateDom.clicked, [BUTTON]);
	assert.deepStrictEqual(clicks(domApp), []);
	const quiet = fakeWorkbench(null);
	const present = [];
	const lateNative = fakeApp({ present, onScan: n => { if (n === 3) { present.push(IMPORT_SHEET); } } });
	assert.strictEqual((await run(quiet, lateNative)).surface, 'native');
	assert.deepStrictEqual(quiet.clicked, []);
	assert.deepStrictEqual(clicks(lateNative).map(c => c.click), [BUTTON]);
});

test('both surfaces: the dialog on both -> [modal_ambiguous] ... on both surfaces, nothing clicked', async () => {
	const wb = fakeWorkbench({ text: MESSAGE, buttons: [BUTTON, 'Cancel'] });
	const app = fakeApp({ present: [IMPORT_SHEET] });
	await assert.rejects(run(wb, app), /\[modal_ambiguous\] dialog "Import settings.*" with a button "Import" is on both surfaces \(DOM: .*; native: .*\); nothing was clicked/);
	assert.deepStrictEqual(wb.clicked, []);
	assert.deepStrictEqual(clicks(app), []);
});

test('both surfaces: neither in time -> [modal_missing] naming both surfaces\' last observations', async () => {
	const wb = fakeWorkbench(null);
	const app = fakeApp({ present: [] });
	await assert.rejects(run(wb, app), error => {
		assert.match(error.message, /^\[modal_missing\] no dialog "Import settings, keybindings and extensions from VS Code\?" with a button "Import" on either surface \(DOM: no dialog in the workbench frame \(no frame/);
		assert.match(error.message, /; native: process pid 4242 \(.*\) has 0 windows|; native: window 1 role="AXWindow"/);
		return true;
	});
	assert.deepStrictEqual(wb.clicked, []);
	assert.deepStrictEqual(clicks(app), []);
	assert.ok(wb.evaluations > 2 && app.calls.length > 2, 'both surfaces were read in every poll');
});

test('both surfaces: only dialogs with other messages (or the message without the button) -> [modal_missing] says so for each surface, nothing clicked', async () => {
	const wb = fakeWorkbench({ text: 'Delete everything?', buttons: [BUTTON, 'Cancel'] });
	const app = fakeApp({ present: [sheet(['Replace the file?'], [BUTTON, 'Cancel'])] });
	await assert.rejects(run(wb, app), error => {
		assert.match(error.message, /^\[modal_missing\] .* on either surface \(DOM: a dialog with another message is open \(not a match\): .*"Delete everything\?"/);
		assert.match(error.message, /; native: 1 dialog\(s\) hold the button "Import" with another message \(texts: \["Replace the file\?"\]\); /);
		return true;
	});
	assert.deepStrictEqual(wb.clicked, []);
	assert.deepStrictEqual(clicks(app), []);
	const noButton = fakeWorkbench({ text: MESSAGE, buttons: ['Cancel'] });
	await assert.rejects(run(noButton, fakeApp({ present: [] })), /\[modal_missing\] .*\(DOM: the dialog has the message but no button "Import": /);
	assert.deepStrictEqual(noButton.clicked, []);
});

test('both surfaces: the DOM holds a dialog with another message and the native surface holds the right one -> the native one is pressed', async () => {
	const wb = fakeWorkbench({ text: 'Delete everything?', buttons: [BUTTON, 'Cancel'] });
	const app = fakeApp({ present: [IMPORT_SHEET] });
	const modal = await run(wb, app);
	assert.strictEqual(modal.surface, 'native');
	assert.deepStrictEqual(wb.clicked, []);
	assert.deepStrictEqual(clicks(app).map(c => c.click), [BUTTON]);
});

test('both surfaces: the native surface holds a dialog with another message and the DOM holds the right one -> the DOM one is pressed', async () => {
	const wb = fakeWorkbench({ text: MESSAGE, buttons: [BUTTON, 'Cancel'] });
	const app = fakeApp({ present: [sheet(['Delete everything?'], [BUTTON, 'Cancel'])] });
	const modal = await run(wb, app);
	assert.strictEqual(modal.surface, 'dom');
	assert.deepStrictEqual(wb.clicked, [BUTTON]);
	assert.deepStrictEqual(clicks(app), []);
});

test('both surfaces: errors of a surface are thrown as they came (an osascript failure, a CDP failure), never read as "no dialog"', async () => {
	await assert.rejects(run(fakeWorkbench(null), fakeApp({ present: [], failAt: 2 })), /\[native_osascript_failed\]/);
	const broken = fakeWorkbench(null);
	broken.cdp.send = async () => { throw new Error('[cdp_closed] Target.getTargets: the connection closed'); };
	await assert.rejects(run(broken, fakeApp({ present: [IMPORT_SHEET] })), /\[cdp_closed\]/);
	await assert.rejects(run(fakeWorkbench(null), fakeApp({ present: [], procCount: 0 })), /\[native_process\] route native: System Events lists 0 processes/);
});

test('both surfaces: no app pid throws [native_pid_missing] when the surfaces are built, before the CDP connection is used', () => {
	const cdp = new Proxy({}, { get: (_target, key) => { throw new Error(`the CDP connection was used (${String(key)})`); } });
	assert.throws(() => modalSurfaces(cdp, importArgs, undefined, { scan: fakeApp({ present: [] }).scan, limits: FAST }), /\[native_pid_missing\]/);
});

test('DOM surface: a dialog gone between the reading and the click throws [modal_dom_changed], nothing clicked', async () => {
	const wb = fakeWorkbench(null);
	await assert.rejects(modalSurfaces(wb.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom.press(), /\[modal_dom_changed\] .*nothing was clicked/);
	assert.deepStrictEqual(wb.clicked, []);
});
