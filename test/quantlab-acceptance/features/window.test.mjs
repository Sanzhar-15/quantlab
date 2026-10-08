/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test test/quantlab-acceptance/features/window.test.mjs
// The modal step's two routes (window.mjs pressModal): the routing on the effective window.dialogStyle, and the native route
// (native-dialog.mjs) against a fake accessibility scanner.

import assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { pressNativeDialog } from './native-dialog.mjs';
import { modalRoutes, pressModal, routeModal } from './window.mjs';

const MESSAGE = 'Import settings, keybindings and extensions from VS Code?';
const BUTTON = 'Import';
// Short limits: the product's are 60 s / 250 ms / 500 ms / 5 s (NATIVE_LIMITS).
const LIMITS = { waitMs: 300, pollMs: 20, settleMs: 0, closeMs: 200 };

function routes() {
	const called = [];
	return { called, routes: { custom: async () => { called.push('custom'); return { route: 'custom' }; }, native: async () => { called.push('native'); return { route: 'native' }; } } };
}

test('routeModal: custom -> the DOM route, native -> the native route; any other value throws [dialog_style_unknown] and runs neither', async () => {
	const custom = routes();
	assert.deepStrictEqual(await routeModal('custom', custom.routes), { route: 'custom' });
	assert.deepStrictEqual(custom.called, ['custom']);
	const native = routes();
	assert.deepStrictEqual(await routeModal('native', native.routes), { route: 'native' });
	assert.deepStrictEqual(native.called, ['native']);
	for (const style of ['default', 'Native', '', undefined, null, 1]) {
		const other = routes();
		await assert.rejects(routeModal(style, other.routes), /\[dialog_style_unknown\] window\.dialogStyle is /, String(style));
		assert.deepStrictEqual(other.called, [], String(style));
	}
});

test('pressModal: an unknown or missing dialogStyle throws before the CDP connection or a pid is used', async () => {
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

test('pressModal wiring: style native runs the native route with the app pid and never touches the CDP connection', async () => {
	const cdp = new Proxy({}, { get: (_target, key) => { throw new Error(`the CDP connection was used (${String(key)}) on the native route`); } });
	const app = fakeApp({ present: [IMPORT_SHEET] });
	const args = { message: MESSAGE, button: BUTTON, dialogStyle: 'native' };
	const modal = await routeModal(args.dialogStyle, modalRoutes(cdp, args, 4242, { scan: app.scan, limits: LIMITS }));
	assert.strictEqual(modal.route, 'native');
	assert.deepStrictEqual(clicks(app).map(c => c.click), [BUTTON]);
	assert.ok(app.calls.every(c => c.pid === 4242));
});

test('pressModal wiring: style custom runs the DOM route (it asks the CDP connection) and never scans natively', async () => {
	const cdp = new Proxy({}, { get: (_target, key) => { throw new Error(`DOM route asked the CDP connection for ${String(key)}`); } });
	const app = fakeApp({ present: [IMPORT_SHEET] });
	const args = { message: MESSAGE, button: BUTTON, dialogStyle: 'custom' };
	await assert.rejects(routeModal(args.dialogStyle, modalRoutes(cdp, args, 4242, { scan: app.scan, limits: LIMITS })), /DOM route asked the CDP connection/);
	assert.strictEqual(app.calls.length, 0);
});
