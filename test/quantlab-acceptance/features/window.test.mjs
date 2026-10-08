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
import { awaitModal, backtestForm, checkDialogStyle, modalSurfaces, pressModal, readToasts, waitForWorkbench } from './window.mjs';

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

/** The fake `document` of a workbench frame holding the dialog `wb.box` ({ text, buttons: [labels] } or null); a press is recorded in `wb.clicked`. */
function dialogDocument(wb) {
	return {
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
}

/**
 * A fake CDP connection onto a fake workbench: `box` is the open .monaco-dialog-box ({ text, buttons: [labels] }) or null, `clicked`
 * the labels pressed. Runtime.evaluate runs the expression window.mjs sends (the real in-page function) against a fake `document`.
 */
function fakeWorkbench(box = null) {
	const wb = { box, clicked: [], evaluations: 0 };
	const document = dialogDocument(wb);
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
	const wb = fakeWorkbench({ text: MESSAGE, buttons: [BUTTON, 'Cancel'] });
	const dom = modalSurfaces(wb.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	const observation = await dom.read();
	assert.strictEqual(observation.found, true);
	wb.box = null;
	await assert.rejects(dom.press(observation), /\[modal_dom_changed\] .*nothing was clicked/);
	assert.deepStrictEqual(wb.clicked, []);
});

// --- a failed observation in any frame fails the observation (review RULING c1, item 7) ---
const WB_A = 'vscode-file://a/workbench.html';
const WB_B = 'vscode-file://b/workbench.html';

/** The fake `document` of a workbench frame that shows the notification toasts `texts`. */
const toastDocument = texts => ({
	querySelector: selector => selector === '.monaco-workbench' ? {} : null,
	querySelectorAll: selector => selector === '.notifications-toasts .notification-list-item-message' ? texts.map(text => ({ textContent: ` ${text} ` })) : [],
});

/**
 * A fake CDP connection onto several frames, each its own page target: `specs` = [{ url, document, exception?, reject?, attachFails? }].
 * A frame with `exception` answers Runtime.evaluate with exceptionDetails, one with `reject` rejects the request, one with
 * `attachFails` rejects Target.attachToTarget. `fx.frames` may change between calls (fx.add); `fx.asked` lists the frame URLs evaluated; `fx.beforeEvaluate(n)` / `fx.afterEvaluate(n)` run before / after the n-th evaluation (1-based), to change the frames in the middle of a step.
 */
function fakeFrames(specs) {
	let seq = 0;
	const fx = { frames: [], asked: [], evaluations: 0, beforeEvaluate: () => { }, afterEvaluate: () => { } };
	fx.add = spec => {
		const frame = { ...spec, targetId: `T${++seq}`, frameId: `F${seq}` };
		fx.frames.push(frame);
		return frame;
	};
	specs.forEach(fx.add);
	fx.cdp = {
		send: async (method, params, sessionId) => {
			switch (method) {
				case 'Target.getTargets': return { targetInfos: fx.frames.map(f => ({ type: 'page', url: f.url, targetId: f.targetId })) };
				case 'Target.attachToTarget': {
					if (fx.frames.find(f => f.targetId === params.targetId).attachFails) {
						throw new Error('fake CDP: attach refused');
					}
					return { sessionId: `S-${params.targetId}` };
				}
				case 'Page.getFrameTree': {
					const frame = fx.frames.find(f => `S-${f.targetId}` === sessionId);
					return { frameTree: { frame: { id: frame.frameId, url: frame.url } } };
				}
				case 'Page.createIsolatedWorld': return { executionContextId: params.frameId };
				case 'Runtime.evaluate': {
					const frame = fx.frames.find(f => f.frameId === params.contextId);
					fx.asked.push(frame.url);
					fx.beforeEvaluate(++fx.evaluations);
					if (frame.reject !== undefined) {
						throw new Error(frame.reject);
					}
					if (frame.exception !== undefined) {
						return { exceptionDetails: { text: 'Uncaught', exception: { description: frame.exception } } };
					}
					const value = new Function('document', `return ${params.expression}`)(frame.document);
					fx.afterEvaluate(fx.evaluations);
					return { result: { value } };
				}
				case 'Target.detachFromTarget': return {};
				default: throw new Error(`fake CDP: unexpected ${method}`);
			}
		},
	};
	return fx;
}

test('readToasts: one workbench frame answers [] and another reports exceptionDetails -> [workbench_observation_failed] naming the frame and the error, not []', async () => {
	for (const order of [[0, 1], [1, 0]]) {
		const specs = [{ url: WB_A, document: toastDocument([]) }, { url: WB_B, document: toastDocument([]), exception: 'ReferenceError: oops is not defined' }];
		const fx = fakeFrames(order.map(i => specs[i]));
		await assert.rejects(readToasts(fx.cdp), /^Error: \[workbench_observation_failed\] 1 frame\(s\) could not be observed \(1 answered\): vscode-file:\/\/b\/workbench\.html: ReferenceError: oops is not defined$/);
		assert.strictEqual(fx.asked.length, 2, 'both frames were evaluated');
	}
	// Control: both answer -> the one frame's toasts.
	assert.deepStrictEqual(await readToasts(fakeFrames([{ url: WB_A, document: toastDocument(['hello']) }, { url: WB_B, document: { querySelector: () => null } }]).cdp), ['hello']);
});

test('readToasts: a rejected CDP request in one frame fails the observation by name although another frame answered', async () => {
	const fx = fakeFrames([{ url: WB_A, document: toastDocument([]) }, { url: WB_B, document: toastDocument([]), reject: 'Runtime.evaluate: Cannot find context with specified id' }]);
	await assert.rejects(readToasts(fx.cdp), /^Error: \[workbench_observation_failed\] 1 frame\(s\) could not be observed \(1 answered\): vscode-file:\/\/b\/workbench\.html: Runtime\.evaluate: Cannot find context with specified id$/);
});

test('waitForWorkbench: a failed frame observation is thrown by name, not read as "the workbench is there"', async () => {
	const fx = fakeFrames([{ url: WB_A, document: toastDocument([]) }, { url: WB_B, document: toastDocument([]), exception: 'TypeError: boom' }]);
	await assert.rejects(waitForWorkbench(fx.cdp, 5000), /\[workbench_observation_failed\] .*vscode-file:\/\/b\/workbench\.html: TypeError: boom/);
});

test('observation: a target that is neither vscode-file:// nor vscode-webview:// stays excluded before evaluation (never attached, never an error)', async () => {
	const fx = fakeFrames([{ url: WB_A, document: toastDocument(['x']) }, { url: '', document: null, attachFails: true, reject: 'must not be evaluated' }]);
	assert.deepStrictEqual(await readToasts(fx.cdp), ['x']);
	assert.deepStrictEqual(fx.asked, [WB_A]);
});

test('DOM surface: a failed frame observation fails read() and the modal wait by name even when another workbench frame shows the dialog; nothing is clicked', async () => {
	const shown = { box: { text: MESSAGE, buttons: [BUTTON, 'Cancel'] }, clicked: [] };
	for (const failure of [{ exception: 'Error: frame detached' }, { reject: 'Runtime.evaluate: Execution context was destroyed' }]) {
		const fx = fakeFrames([{ url: WB_A, document: dialogDocument(shown) }, { url: WB_B, document: dialogDocument({ box: null, clicked: [] }), ...failure }]);
		const surfaces = modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST });
		await assert.rejects(surfaces.dom.read(), /\[modal_observation_failed\] 1 frame\(s\) could not be observed \(1 answered\): vscode-file:\/\/b\/workbench\.html: /);
		await assert.rejects(awaitModal(importArgs, surfaces, FAST), /\[modal_observation_failed\] .*vscode-file:\/\/b\/workbench\.html/);
		assert.deepStrictEqual(shown.clicked, []);
	}
});

/** The error a promise rejects with (the test fails if it resolves), so that the effects can be asserted before the message. */
const failure = promise => promise.then(() => assert.fail('expected a rejection'), error => error);

// --- a mutation runs in exactly one frame that was found, revalidated and unique (review RULING c1, item 8) ---
const WEBVIEW_A = 'vscode-webview://a/index.html';
const WEBVIEW_B = 'vscode-webview://b/index.html';

/** A frame state for a dialog document: { box, clicked }. */
const dialogFrame = (url, box) => ({ url, shown: { box, clicked: [] }, get document() { return dialogDocument(this.shown); } });
const dialogBox = (buttons = [BUTTON, 'Cancel']) => ({ text: MESSAGE, buttons });
const totalClicks = frames => frames.flatMap(f => f.shown.clicked);

test('DOM press: two workbench frames hold the dialog -> [modal_ambiguous] and no click in either, at the reading and at the press', async () => {
	const a = dialogFrame(WB_A, dialogBox());
	const b = dialogFrame(WB_B, dialogBox());
	const fx = fakeFrames([a, b]);
	const dom = modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	await assert.rejects(dom.read(), /^Error: \[modal_ambiguous\] 2 frames answer: vscode-file:\/\/a\/workbench\.html, vscode-file:\/\/b\/workbench\.html; nothing was changed$/);
	await assert.rejects(awaitModal(importArgs, modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }), FAST), /\[modal_ambiguous\]/);
	assert.deepStrictEqual(totalClicks([a, b]), []);
});

test('DOM press: a second matching frame appears between the reading and the press -> [modal_ambiguous], zero clicks in both frames', async () => {
	const a = dialogFrame(WB_A, dialogBox());
	const fx = fakeFrames([a]);
	const dom = modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	const observation = await dom.read();
	assert.strictEqual(observation.found, true);
	const b = dialogFrame(WB_B, dialogBox());
	fx.add(b);
	const error = await failure(dom.press(observation));
	assert.deepStrictEqual(totalClicks([a, b]), []);
	assert.match(error.message, /^\[modal_ambiguous\] 2 frames answer: .*; nothing was changed$/);
});

test('DOM press: the dialog moved to another frame between the reading and the press -> [modal_dom_changed] naming both, zero clicks', async () => {
	const a = dialogFrame(WB_A, dialogBox());
	const fx = fakeFrames([a]);
	const dom = modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	const observation = await dom.read();
	a.shown.box = null;
	const b = dialogFrame(WB_B, dialogBox());
	fx.add(b);
	const error = await failure(dom.press(observation));
	assert.deepStrictEqual(totalClicks([a, b]), []);
	assert.match(error.message, /^\[modal_dom_changed\] .* was seen in vscode-file:\/\/a\/workbench\.html, but at the click: the match is now in vscode-file:\/\/b\/workbench\.html .*; nothing was clicked$/);
});

test('DOM press: a second matching button in the frame is [modal_ambiguous] at the reading, at the revalidation and inside the page at the click; zero clicks', async () => {
	const twice = [BUTTON, BUTTON, 'Cancel'];
	const a = dialogFrame(WB_A, dialogBox(twice));
	await assert.rejects(modalSurfaces(fakeFrames([a]).cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom.read(), /^Error: \[modal_ambiguous\] 2 matching buttons in vscode-file:\/\/a\/workbench\.html: .*; nothing was changed$/);
	// Appearing after the reading: caught by the revalidation.
	const b = dialogFrame(WB_A, dialogBox());
	const dom = modalSurfaces(fakeFrames([b]).cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	const observation = await dom.read();
	b.shown.box = dialogBox(twice);
	await assert.rejects(dom.press(observation), /\[modal_ambiguous\] 2 matching buttons/);
	// Appearing between the revalidation and the click: caught by the page function itself (evaluation 1 = reading, 2 = revalidation, 3 = click).
	const c = dialogFrame(WB_A, dialogBox());
	const fx = fakeFrames([c]);
	const late = modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	const seen = await late.read();
	fx.beforeEvaluate = n => { if (n === 3) { c.shown.box = dialogBox(twice); } };
	await assert.rejects(late.press(seen), /\[modal_ambiguous\] 2 matching buttons/);
	assert.deepStrictEqual(totalClicks([a, b, c]), []);
});

test('DOM press: a second frame appearing after the revalidation is never pressed: the click runs in the observed frame alone', async () => {
	const a = dialogFrame(WB_A, dialogBox());
	const b = dialogFrame(WB_B, dialogBox());
	const fx = fakeFrames([a]);
	const dom = modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	const observation = await dom.read();
	fx.beforeEvaluate = n => { if (n === 2) { fx.add(b); } };
	const modal = await dom.press(observation);
	assert.strictEqual(modal.clicked, BUTTON);
	assert.deepStrictEqual(a.shown.clicked, [BUTTON]);
	assert.deepStrictEqual(b.shown.clicked, []);
});

test('DOM press: one matching frame (another workbench frame without a dialog) is pressed exactly once, in that frame', async () => {
	const a = dialogFrame(WB_A, dialogBox());
	const b = dialogFrame(WB_B, null);
	const fx = fakeFrames([b, a]);
	const run1 = await awaitModal(importArgs, modalSurfaces(fx.cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }), FAST);
	assert.strictEqual(run1.surface, 'dom');
	assert.deepStrictEqual(a.shown.clicked, [BUTTON]);
	assert.deepStrictEqual(b.shown.clicked, []);
	assert.deepStrictEqual(fx.asked, [WB_B, WB_A, WB_B, WB_A, WB_A], 'read (both frames), revalidation (both frames), click (the observed frame only)');
});

test('DOM press: press() without the frame its read() found throws [modal_press_unobserved], nothing clicked', async () => {
	const a = dialogFrame(WB_A, dialogBox());
	const dom = modalSurfaces(fakeFrames([a]).cdp, importArgs, 4242, { scan: fakeApp({ present: [] }).scan, limits: FAST }).dom;
	await assert.rejects(dom.press(), /\[modal_press_unobserved\]/);
	assert.deepStrictEqual(a.shown.clicked, []);
});

/** The fake `document` of an Action view webview: `form` = { open, fields: { id: { value, required } }, submits: [{ label, disabled, clicks }], changes, status }. */
function formDocument(form) {
	const element = {
		querySelector: selector => {
			const field = form.fields[selector.slice(1)];
			return field === undefined ? null : field;
		},
		dispatchEvent: () => { form.changes++; },
	};
	return {
		querySelector: selector => {
			switch (selector) {
				case '#action-config-form': return form.open ? element : null;
				case '.status-card': return form.status === undefined ? null : { classList: ['status-card', `status-${form.status}`] };
				case '.status-meta': case '.callout.error': return null;
				default: throw new Error(`fake document: unexpected querySelector ${selector}`);
			}
		},
		querySelectorAll: selector => {
			switch (selector) {
				case '#action-config-form button[type=submit]': return form.open ? form.submits.map(b => ({ disabled: b.disabled, textContent: ` ${b.label} `, click: () => { b.clicks++; form.status = 'completed'; } })) : [];
				case '#action-config-form [required]': return Object.entries(form.fields).filter(([, f]) => f.required).map(([id, f]) => ({ id, value: f.value }));
				default: throw new Error(`fake document: unexpected querySelectorAll ${selector}`);
			}
		},
	};
}
const formFrame = (url, { open = true, submits = [{ label: 'Run Backtest', disabled: false, clicks: 0 }] } = {}) => {
	const form = { open, fields: { symbol: { value: '', required: true } }, submits, changes: 0, status: undefined };
	return { url, form, get document() { return formDocument(form); } };
};
const mutations = frames => frames.map(f => ({ changes: f.form.changes, symbol: f.form.fields.symbol.value, clicks: f.form.submits.map(b => b.clicks) }));
const FORM_ARGS = { values: { symbol: 'AAPL', nosuch: 'x' }, runTimeoutMs: 5000 };

test('backtestForm: one matching webview frame is filled once and pressed once (another webview frame without the form is untouched)', async () => {
	const a = formFrame(WEBVIEW_A);
	const b = formFrame(WEBVIEW_B, { open: false });
	const result = await backtestForm(fakeFrames([b, a]).cdp, FORM_ARGS);
	assert.deepStrictEqual(result, { missingFields: ['nosuch'], submitted: 'Run Backtest', state: 'card', status: 'completed', meta: '', error: '' });
	assert.deepStrictEqual(mutations([a, b]), [{ changes: 1, symbol: 'AAPL', clicks: [1] }, { changes: 0, symbol: '', clicks: [0] }]);
});

test('backtestForm: a second form frame appears between the observation and the fill -> [backtest_form_ambiguous], neither frame is filled or pressed', async () => {
	const a = formFrame(WEBVIEW_A);
	const b = formFrame(WEBVIEW_B);
	const fx = fakeFrames([a]);
	fx.beforeEvaluate = n => { if (n === 1) { fx.add(b); } };
	const error = await failure(backtestForm(fx.cdp, FORM_ARGS));
	assert.deepStrictEqual(mutations([a, b]), [{ changes: 0, symbol: '', clicks: [0] }, { changes: 0, symbol: '', clicks: [0] }]);
	assert.match(error.message, /^\[backtest_form_ambiguous\] 2 frames answer: vscode-webview:\/\/a\/index\.html, vscode-webview:\/\/b\/index\.html; nothing was changed$/);
});

test('backtestForm: the form moved to another frame between the observation and the fill -> [backtest_form_lost], nothing filled or pressed', async () => {
	const a = formFrame(WEBVIEW_A);
	const b = formFrame(WEBVIEW_B);
	const fx = fakeFrames([a]);
	fx.afterEvaluate = n => { if (n === 1) { a.form.open = false; fx.add(b); } };
	const error = await failure(backtestForm(fx.cdp, FORM_ARGS));
	assert.deepStrictEqual(mutations([a, b]), [{ changes: 0, symbol: '', clicks: [0] }, { changes: 0, symbol: '', clicks: [0] }]);
	assert.match(error.message, /^\[backtest_form_lost\] the form disappeared before it was filled: the match is now in vscode-webview:\/\/b\/index\.html .*; nothing was changed$/);
});

test('backtestForm: a second form frame appears between the observation and the submit press -> [backtest_form_ambiguous], zero clicks in both frames', async () => {
	const a = formFrame(WEBVIEW_A);
	const b = formFrame(WEBVIEW_B);
	const fx = fakeFrames([a]);
	// Evaluations: 1 form observation, 2 revalidation, 3 fill, 4 submit observation (b is added during it), 5 revalidation, 6 press.
	fx.beforeEvaluate = n => { if (n === 4) { fx.add(b); } };
	const error = await failure(backtestForm(fx.cdp, FORM_ARGS));
	assert.deepStrictEqual(mutations([a, b]), [{ changes: 1, symbol: 'AAPL', clicks: [0] }, { changes: 0, symbol: '', clicks: [0] }]);
	assert.match(error.message, /^\[backtest_form_ambiguous\] 2 frames answer: .*; nothing was changed$/);
});

test('backtestForm: a second form frame appearing after the submit revalidation is not pressed: the press runs in the observed frame alone', async () => {
	const a = formFrame(WEBVIEW_A);
	const b = formFrame(WEBVIEW_B);
	const fx = fakeFrames([a]);
	fx.beforeEvaluate = n => { if (n === 5) { fx.add(b); } };
	const result = await backtestForm(fx.cdp, FORM_ARGS);
	assert.strictEqual(result.submitted, 'Run Backtest');
	assert.deepStrictEqual(mutations([a, b]), [{ changes: 1, symbol: 'AAPL', clicks: [1] }, { changes: 0, symbol: '', clicks: [0] }]);
});

test('backtestForm: two submit buttons in the form frame -> [backtest_form_ambiguous] naming the count, neither pressed', async () => {
	const a = formFrame(WEBVIEW_A, { submits: [{ label: 'Run Backtest', disabled: false, clicks: 0 }, { label: 'Run Backtest', disabled: false, clicks: 0 }] });
	await assert.rejects(backtestForm(fakeFrames([a]).cdp, FORM_ARGS), /^Error: \[backtest_form_ambiguous\] 2 matching buttons in vscode-webview:\/\/a\/index\.html: .*; nothing was changed$/);
	assert.deepStrictEqual(mutations([a]), [{ changes: 1, symbol: 'AAPL', clicks: [0, 0] }]);
});

test('backtestForm: a failed observation in a second webview frame fails the step by name (item 7 reaches every caller)', async () => {
	const a = formFrame(WEBVIEW_A);
	const b = formFrame(WEBVIEW_B, { open: false });
	await assert.rejects(backtestForm(fakeFrames([a, { ...b, exception: 'Error: webview crashed' }]).cdp, FORM_ARGS), /^Error: \[backtest_form_observation_failed\] 1 frame\(s\) could not be observed \(1 answered\): vscode-webview:\/\/b\/index\.html: Error: webview crashed$/);
	assert.deepStrictEqual(mutations([a]), [{ changes: 0, symbol: '', clicks: [0] }]);
});
