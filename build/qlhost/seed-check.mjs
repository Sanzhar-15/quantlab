/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, U5-LAUNCH-2): the compiled chrome seed over an EMPTY user-data dir, given the default profile's
// settings resource in the vscode-userdata: scheme, as app.ts passes it. Expected: first call `wrote` and the file holds the
// 4 chrome keys; second call `present`; a foreign scheme throws by name. Run from the fork root after compile:
// `node build/qlhost/seed-check.mjs out-build`; rc 0 = GREEN.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = process.argv[2];
if (!out) {
	console.error('usage: seed-check.mjs <out dir>');
	process.exit(64);
}
const seedMod = await import(pathToFileURL(join(process.cwd(), out, 'vs/code/electron-main/qlHost/chromeSeed.js')).href);
const uriMod = await import(pathToFileURL(join(process.cwd(), out, 'vs/base/common/uri.js')).href);
// A -min build's mangler renames exports (chromeSeed.js exports `$VB`, not `seedQlChromeSettings`: package 5c, RELEASE 6b), so
// the function is taken by name when present, else as the module's ONE function export; anything else is a named error.
function resolveSeed(mod) {
	if (typeof mod.seedQlChromeSettings === 'function') {
		return mod.seedQlChromeSettings;
	}
	const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function');
	if (fns.length !== 1) {
		throw new Error(`chromeSeed.js exports ${fns.length} function(s) [${fns.map(([k]) => k).join(', ')}], expected seedQlChromeSettings or exactly one (mangled) function export`);
	}
	console.log('seed function resolved from the mangled export', fns[0][0]);
	return fns[0][1];
}
const seedQlChromeSettings = resolveSeed(seedMod);
const { URI } = uriMod;
const log = {
	error: (...a) => console.log('[log.error]', ...a),
	warn: (...a) => console.log('[log.warn]', ...a),
	info: (...a) => console.log('[log.info]', ...a),
	trace() { },
	debug() { },
};
const CHROME_KEYS = ['window.titleBarStyle', 'window.customTitleBarVisibility', 'workbench.activityBar.location', 'workbench.sideBar.location'];

const dir = mkdtempSync(join(tmpdir(), 'ql-seed-'));
const settingsFile = join(dir, 'User', 'settings.json');
const userdata = URI.file(settingsFile).with({ scheme: 'vscode-userdata' });
let rc = 0;
try {
	console.log('empty user-data dir:', dir, 'User/ exists:', existsSync(join(dir, 'User')));
	const first = await seedQlChromeSettings(userdata, log);
	const text = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '(absent)';
	const keys = CHROME_KEYS.filter(k => text.includes(`"${k}"`));
	console.log('first call ->', first, '| file keys present:', keys.length, '/', CHROME_KEYS.length);
	const second = await seedQlChromeSettings(userdata, log);
	console.log('second call ->', second);
	if (first !== 'wrote' || keys.length !== CHROME_KEYS.length || second !== 'present') {
		rc = 1;
	}
	try {
		await seedQlChromeSettings(URI.parse('foo:/x/settings.json'), log);
		console.log('foreign scheme: NO throw');
		rc = 1;
	} catch (e) {
		console.log('foreign scheme throws:', String(e.message).slice(0, 140));
	}
} catch (e) {
	console.log('THROWN:', String(e.message).slice(0, 200));
	rc = 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log(rc ? 'RED: the seed does not handle an empty user-data dir with a vscode-userdata settings resource' : 'GREEN: seed wrote 4 keys on an empty user-data dir (vscode-userdata scheme), present on the second call, foreign scheme refused');
process.exit(rc);
