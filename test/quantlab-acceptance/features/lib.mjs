/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure parts of the FEATURES closing-check runner (PLAN-FINAL 3.9). No app is launched from here.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The five closing checks, in the plan's order, the import-in-a-named-profile row (QL-G-FEAT c1 M3), the extension-pack
 * row, then the Quantbook MCP row (W-ORCH, 2026-10-05).
 */
export const CHECK_IDS = ['backtest-bundled-engine', 'python-intelligence', 'notebook-cell', 'pinned-dependency-removed', 'import', 'import-named-profile', 'extension-pack-quiet', 'quantbook-mcp-absent'];

/** The rows a run judges: every one with the network off; with it on, only the extension-pack row. */
export function checkIdsFor(network) {
	if (network === 'off') {
		return CHECK_IDS;
	}
	if (network === 'on') {
		return ['extension-pack-quiet'];
	}
	throw new Error(`[network_mode_invalid] the network mode is ${JSON.stringify(network)} (expected off or on)`);
}

/**
 * Every app launch runs on a scratch HOME (the import row seeds another editor's files there), where the
 * Security framework finds no keychain: without this flag it raises "Keychain Not Found" and can hang the
 * main process (R-24). So every launch carries it.
 */
export const MOCK_KEYCHAIN = '--use-mock-keychain';

/** The built-in extensions whose extensionPack members the app must never install. */
export const PACK_OWNERS = ['ms-python.python', 'ms-toolsai.jupyter'];

/** Microsoft's marketplace hosts: never a request to any of them (PLAN-FINAL 3.9: Open VSX only). */
export const MARKETPLACE_HOSTS = ['marketplace.visualstudio.com', 'vsassets.io', 'vscode-unpkg.net'];

/** The Python tooling pins the packaged app must carry (product.json builtInExtensions). */
export const PINNED_IDS = ['ms-python.python', 'detachhead.basedpyright', 'ms-toolsai.jupyter'];

export const STATUSES = ['PASS', 'FAIL', 'NOT RUN'];

/**
 * The driver's modes whose steps need a MODAL dialog (the import confirmation, in the default and in a named profile, the publisher-trust prompt of an
 * install). The workbench refuses every dialog in a launch with --extensionTestsPath (dialogService.ts skipDialogs:
 * "refused to show dialog in tests"), so these modes run the driver as an extension under development, started by its
 * own activation; the other modes run it as the extension tests.
 */
export const DIALOG_MODES = ['import', 'import-profile', 'pack-trigger'];

/**
 * Asks the app to close (`send('Browser.close')`) and waits up to `limitMs` for `exit`. The app closes its debugging
 * socket while it shuts down, often before it answers, so a lost answer ([cdp_closed]) is no failure: only an app still
 * running after the limit is. Returns undefined when the app exited, else the reason, naming what Browser.close got.
 */
export async function closeApp(send, exit, limitMs) {
	const closing = send('Browser.close').then(() => 'answered', err => err instanceof Error ? err.message : String(err));
	let timer;
	const how = await Promise.race([exit.then(() => 'exited'), new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), limitMs); })]);
	clearTimeout(timer);
	if (how === 'exited') {
		return undefined;
	}
	let answerTimer;
	const answer = await Promise.race([closing, new Promise(resolve => { answerTimer = setTimeout(() => resolve('no answer'), 1000); })]);
	clearTimeout(answerTimer);
	return `the app did not exit ${limitMs / 1000} s after Browser.close (${answer})`;
}

/** The driver's launch arguments for `mode`: --extensionTestsPath only for the modes that need no dialog. */
export function driverArgs(mode, driverDir) {
	const modes = ['all', 'pins', ...DIALOG_MODES];
	if (!modes.includes(mode)) {
		throw new Error(`[driver_mode_invalid] ${JSON.stringify(mode)} is not one of ${modes.join(', ')}`);
	}
	const args = [`--extensionDevelopmentPath=${driverDir}`];
	return DIALOG_MODES.includes(mode) ? args : [...args, `--extensionTestsPath=${path.join(driverDir, 'checks.cjs')}`];
}

/**
 * The launcher disables Electron's asar fs patch for itself only (launcher.mjs, process.noAsar). ELECTRON_NO_ASAR in
 * its environment would reach every app launch through the spread of process.env and run the packaged app without
 * asar, so the launcher refuses to run with it set; it never deletes it quietly.
 */
export function assertNoAsarEnvAbsent(env) {
	if (env.ELECTRON_NO_ASAR !== undefined) {
		throw new Error(`[asar_env_set] ELECTRON_NO_ASAR is set (${JSON.stringify(env.ELECTRON_NO_ASAR)}) in the launcher's environment; the packaged app would inherit it and run without asar. Unset it and run again`);
	}
}

export function sha256File(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Digest of a directory tree: sha256 over one line per entry, sorted by relative path --
 * `F <path> <sha256 of contents>` for a file, `L <path> <link target>` for a symlink.
 */
export function treeDigest(root) {
	const lines = [];
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full).split(path.sep).join('/');
			if (entry.isSymbolicLink()) {
				lines.push(`L ${rel} ${fs.readlinkSync(full)}`);
			} else if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				lines.push(`F ${rel} ${sha256File(full)}`);
			} else {
				throw new Error(`[tree_digest] ${full} is neither a file, a directory nor a symlink`);
			}
		}
	};
	walk(root);
	lines.sort();
	return { files: lines.length, sha256: crypto.createHash('sha256').update(lines.join('\n') + '\n').digest('hex') };
}

/** The pinned versions, read strictly from a parsed product.json: every pin must be there, once, with a version. */
export function readPins(product) {
	if (!Array.isArray(product.builtInExtensions)) {
		throw new Error('[pins_unreadable] product.json has no builtInExtensions array');
	}
	const pins = {};
	for (const id of PINNED_IDS) {
		const entries = product.builtInExtensions.filter(entry => typeof entry.name === 'string' && entry.name.toLowerCase() === id);
		if (entries.length !== 1) {
			throw new Error(`[pins_unreadable] product.json builtInExtensions names ${id} ${entries.length} times (expected 1)`);
		}
		if (typeof entries[0].version !== 'string' || entries[0].version === '') {
			throw new Error(`[pins_unreadable] product.json builtInExtensions gives no version for ${id}`);
		}
		pins[id] = entries[0].version;
	}
	return pins;
}

/** The fork sha the app was built from: product.json `commit`. */
export function readForkSha(product) {
	if (typeof product.commit !== 'string' || !/^[0-9a-f]{40}$/.test(product.commit)) {
		throw new Error(`[fork_sha_unreadable] product.json commit is not a 40-hex sha (got ${JSON.stringify(product.commit)})`);
	}
	return product.commit;
}

/** The directory under `<app>/extensions` that holds the built-in extension `id`; exactly one must. */
export function findBuiltInExtensionDir(extensionsDir, id) {
	const found = [];
	for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const manifest = path.join(extensionsDir, entry.name, 'package.json');
		if (!fs.existsSync(manifest)) {
			continue;
		}
		const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
		if (`${pkg.publisher}.${pkg.name}`.toLowerCase() === id) {
			found.push(path.join(extensionsDir, entry.name));
		}
	}
	if (found.length !== 1) {
		throw new Error(`[builtin_not_found] ${found.length} directories under ${extensionsDir} hold ${id} (expected 1)`);
	}
	return found[0];
}

/**
 * Release 1 ships no Quantbook MCP server (W-ORCH, 2026-10-05). The packaged quantlab extension under
 * `extensionsDir` must carry neither the server's compiled module nor the MCP SDK, and its manifest no MCP
 * command or setting. The extension and its compiled Quantbook tree must exist, so absence is never
 * judged on a missing tree.
 */
export function judgeQuantbookMcpAbsent(extensionsDir) {
	let ext;
	try {
		ext = findBuiltInExtensionDir(extensionsDir, 'quantlab.quantlab');
	} catch (err) {
		return { status: 'FAIL', detail: `[quantlab_extension_not_found] ${err.message}` };
	}
	const compiled = path.join(ext, 'out', 'src', 'quantbook');
	if (!fs.existsSync(path.join(compiled, 'mcp', 'mcpToolLogic.js'))) {
		return { status: 'FAIL', detail: `[quantbook_tree_not_found] ${path.join(compiled, 'mcp', 'mcpToolLogic.js')} is absent: the packaged layout is not the one this row judges` };
	}
	const found = [path.join(compiled, 'mcp', 'mcpServer.js'), path.join(ext, 'node_modules', '@modelcontextprotocol')].filter(p => fs.existsSync(p));
	const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
	const ids = [...pkg.contributes.commands.map(c => c.command), ...Object.keys(pkg.contributes.configuration.properties)].filter(id => /Mcp/.test(id));
	if (found.length > 0 || ids.length > 0) {
		return { status: 'FAIL', detail: `[quantbook_mcp_shipped] files: ${JSON.stringify(found)}; manifest ids: ${JSON.stringify(ids)}` };
	}
	return { status: 'PASS', detail: `${ext}: no mcpServer.js, no @modelcontextprotocol, no MCP command or setting` };
}

/**
 * The pinned-dependency check's verdict. `main` and `control` are the driver's pin reports
 * (`{ ok, missing: [ids], lines: [named failures] }`) from the app and from the copy with `removed`
 * taken out. PASS only if the app has every pin AND the control fails naming exactly `removed`.
 */
export function judgePinnedDependency(main, control, removed) {
	if (main === undefined || control === undefined) {
		return { status: 'NOT RUN', detail: 'the pin report of the app or of the control copy is absent' };
	}
	if (!main.ok) {
		return { status: 'FAIL', detail: `the app itself lacks a pinned dependency: ${main.lines.join('; ')}` };
	}
	if (control.ok) {
		return { status: 'FAIL', detail: `the control copy without ${removed} reported no failure` };
	}
	if (control.missing.length !== 1 || control.missing[0] !== removed) {
		return { status: 'FAIL', detail: `the control copy without ${removed} named [${control.missing.join(', ')}] instead` };
	}
	return { status: 'PASS', detail: `app: all pins present; control without ${removed}: ${control.lines.join('; ')}` };
}

/**
 * The import row's planted source (driver/checks.cjs declares the same literals; lib.test.mjs compares them): what the
 * import must leave in the target settings.json and keybindings.json, in the default and in the named profile alike.
 */
export const IMPORT_SETTINGS = { 'editor.fontSize': 17, 'files.trimTrailingWhitespace': true };
export const IMPORT_KEYBINDING = { key: 'ctrl+alt+q', command: 'workbench.action.files.saveAll' };

/**
 * The import-named-profile row (QL-G-FEAT c1 M3) launches in a profile of this name: `--profile <name>`. Read in this fork:
 * src/vs/platform/environment/node/argv.ts:71,114 define `profile` (string; "If the profile does not exist, a new empty one is
 * created"); src/vs/code/electron-main/app.ts:1315 reads it, :1322-1332 (no path argument) and :1359-1368 (path arguments, as here)
 * pass it as `forceProfile`; an --extensionDevelopmentPath launch re-opens through open() with the same forceProfile
 * (windowsMainService.ts:1425); resolveProfileForBrowserWindow (:1656-1658) finds the profile by name or calls
 * createNamedProfile(name) with NO options, so no useDefaultFlags: toUserDataProfile (userDataProfile.ts:159-160) gives it its
 * own `<userRoamingDataHome>/profiles/<id>/settings.json` and `keybindings.json` (profilesHome = User/profiles, :229), and
 * createProfile makes the `<id>` folder (:332) -- empty until something writes. A fresh user-data dir therefore ends with
 * exactly one directory under User/profiles. Not run against the packaged app from here.
 */
export const NAMED_PROFILE = 'ql-features-named-profile';

/** The extra launch arguments of `mode`: `--profile <name>` for import-profile only. */
export function profileArgs(mode) {
	return mode === 'import-profile' ? ['--profile', NAMED_PROFILE] : [];
}

function sha256OrAbsent(file) {
	return fs.existsSync(file) ? sha256File(file) : null;
}

/**
 * What the named-profile import left on disk under `<userData>/User` (read after the app exited): every directory under
 * profiles/ with its files, its settings.json and keybindings.json text and its pre-import backups; and the sha256 (null: absent)
 * of the DEFAULT profile's User/settings.json and User/keybindings.json. Throws on an unreadable path; nothing is defaulted.
 */
export function readNamedProfileState(userData) {
	const user = path.join(userData, 'User');
	const root = path.join(user, 'profiles');
	const names = fs.existsSync(root)
		? fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
		: [];
	const dirs = names.map(name => {
		const dir = path.join(root, name);
		const files = fs.readdirSync(dir).sort();
		const text = file => files.includes(file) ? fs.readFileSync(path.join(dir, file), 'utf8') : undefined;
		return {
			name,
			path: dir,
			files,
			settings: text('settings.json'),
			keybindings: text('keybindings.json'),
			backups: files.filter(file => /^(settings|keybindings)\.json\.pre-import-/.test(file)).map(file => ({ name: file, text: fs.readFileSync(path.join(dir, file), 'utf8') })),
		};
	});
	return { dirs, defaultAfter: { settings: sha256OrAbsent(path.join(user, 'settings.json')), keybindings: sha256OrAbsent(path.join(user, 'keybindings.json')) } };
}

function parsedOrUndefined(text) {
	if (text === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * The import-named-profile row's verdict. `obs` = { planted, plantedDirs, defaultBefore, state }: `planted` is what the driver wrote into
 * the named profile before the import ({ dir, settings, keybindings }; undefined if it saw other than one profile directory, then
 * `plantedDirs` names what it saw), `defaultBefore` the sha256 (null: absent) of the default profile's User/settings.json and
 * keybindings.json taken before the import, `state` readNamedProfileState after the app exited. PASS only if
 * (1) exactly one directory under User/profiles (the one planted into), (2) its settings.json holds the planted settings with the
 * imported values over them and its keybindings.json the planted and the imported keybinding, (3) the default profile's two files
 * are byte-identical to before (or still absent), (4) one settings.json.pre-import-* and one keybindings.json.pre-import-* sit beside
 * them, each equal to what was planted. Every failure is a named tag; all are reported.
 */
export function judgeImportNamedProfile(obs) {
	if (obs === undefined || obs.state === undefined || obs.defaultBefore === undefined) {
		return { status: 'FAIL', detail: '[profile_import_unreported] the driver reported no planted/before observation or the profile state was not read' };
	}
	const { planted, plantedDirs, defaultBefore, state } = obs;
	const failures = [];
	const fail = (tag, message) => failures.push(`[${tag}] ${message}`);
	const names = state.dirs.map(d => d.name);

	const oneDir = state.dirs.length === 1 && planted !== undefined && planted.dir === state.dirs[0].name;
	if (!oneDir) {
		fail('profile_dir_count', `expected exactly one directory under User/profiles, the one planted into: found [${names.join(', ')}] after the import (${state.dirs.length}); the driver saw [${(plantedDirs ?? []).join(', ')}] before it${planted === undefined ? ' and planted nothing' : ` and planted into ${planted.dir}`}`);
	}

	for (const file of ['settings', 'keybindings']) {
		if (defaultBefore[file] !== state.defaultAfter[file]) {
			fail('default_profile_written', `the default profile's User/${file}.json changed: sha256 ${defaultBefore[file] ?? 'absent'} before, ${state.defaultAfter[file] ?? 'absent'} after`);
		}
	}

	let where = `profile directories [${names.join(', ')}]`;
	if (oneDir) {
		const dir = state.dirs[0];
		where = `profile directory ${dir.path}`;
		const settings = parsedOrUndefined(dir.settings);
		if (settings === undefined || settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
			fail('profile_settings_missing', `${path.join(dir.path, 'settings.json')} is ${settings === undefined ? 'absent' : 'not a JSON object'} (files: [${dir.files.join(', ')}])`);
		} else {
			for (const [key, value] of Object.entries({ ...planted.settings, ...IMPORT_SETTINGS })) {
				if (JSON.stringify(settings[key]) !== JSON.stringify(value)) {
					fail('profile_settings_missing', `${key} is ${JSON.stringify(settings[key])} in ${path.join(dir.path, 'settings.json')}, expected ${JSON.stringify(value)}`);
				}
			}
		}
		const keybindings = parsedOrUndefined(dir.keybindings);
		if (!Array.isArray(keybindings)) {
			fail('profile_settings_missing', `${path.join(dir.path, 'keybindings.json')} is ${keybindings === undefined ? 'absent' : 'not a JSON array'} (files: [${dir.files.join(', ')}])`);
		} else {
			for (const wanted of [...planted.keybindings, IMPORT_KEYBINDING]) {
				if (!keybindings.some(k => k !== null && typeof k === 'object' && k.key === wanted.key && k.command === wanted.command)) {
					fail('profile_settings_missing', `${wanted.key} -> ${wanted.command} is not in ${path.join(dir.path, 'keybindings.json')}`);
				}
			}
		}
		for (const [file, before] of [['settings.json', planted.settings], ['keybindings.json', planted.keybindings]]) {
			const found = dir.backups.filter(b => b.name.startsWith(`${file}.pre-import-`));
			if (found.length !== 1 || JSON.stringify(parsedOrUndefined(found[0].text)) !== JSON.stringify(before)) {
				fail('profile_backup_missing', `expected exactly one ${file}.pre-import-* in ${dir.path} holding the planted ${file}, found [${found.map(b => b.name).join(', ')}]${found.length === 1 ? ' with other content' : ''}`);
			}
		}
	}

	if (failures.length > 0) {
		return { status: 'FAIL', detail: `${failures.join('; ')} (${where}; default profile settings.json ${state.defaultAfter.settings ?? 'absent'}, keybindings.json ${state.defaultAfter.keybindings ?? 'absent'})` };
	}
	const dir = state.dirs[0];
	return {
		status: 'PASS',
		detail: `${where}: settings.json (${Object.keys({ ...planted.settings, ...IMPORT_SETTINGS }).join(', ')}) and keybindings.json (${IMPORT_KEYBINDING.key}) hold the import; backups ${dir.backups.map(b => b.name).join(', ')}; the default profile's settings.json (${defaultBefore.settings ?? 'absent'}) and keybindings.json (${defaultBefore.keybindings ?? 'absent'}) are byte-identical`,
	};
}

/**
 * The run's result: one entry per id of `ids` (checkIdsFor), in order. A check the driver did not report,
 * or reported with an unknown status, is a FAIL by name. `rc` is 0 only when every check is PASS.
 */
export function assemble(checks, ids) {
	const out = [];
	for (const id of ids) {
		const check = checks[id];
		if (check === undefined) {
			out.push({ id, status: 'FAIL', detail: '[check_unreported] no result was produced for this check' });
		} else if (!STATUSES.includes(check.status)) {
			out.push({ id, status: 'FAIL', detail: `[check_status_invalid] status ${JSON.stringify(check.status)}; detail: ${check.detail}` });
		} else {
			out.push({ id, status: check.status, detail: String(check.detail) });
		}
	}
	return { checks: out, rc: out.every(check => check.status === 'PASS') ? 0 : 1 };
}

/**
 * The processes in `psText` (`ps -axo pid=,command=`) whose command runs from inside one of `bundles`
 * (absolute .app paths), except `selfPid` (the launcher runs on the app's own Node).
 */
export function processesInside(psText, bundles, selfPid) {
	const out = [];
	for (const line of psText.split('\n')) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (match === null) {
			continue;
		}
		const pid = Number(match[1]);
		const command = match[2];
		if (pid !== selfPid && bundles.some(bundle => command.startsWith(`${bundle}/`))) {
			out.push({ pid, command });
		}
	}
	return out;
}

/** The extensionPack members of PACK_OWNERS as this app ships them, lowercased; none at all means nothing to watch. */
export function packMembers(extensionsDir) {
	const members = new Set();
	for (const id of PACK_OWNERS) {
		const pkg = JSON.parse(fs.readFileSync(path.join(findBuiltInExtensionDir(extensionsDir, id), 'package.json'), 'utf8'));
		if (pkg.extensionPack !== undefined) {
			for (const member of pkg.extensionPack) {
				members.add(member.toLowerCase());
			}
		}
	}
	if (members.size === 0) {
		throw new Error(`[pack_unread] ${PACK_OWNERS.join(' and ')} declare no extensionPack members; the row would watch nothing`);
	}
	return [...members].sort();
}

/** The hosts a gallery request goes to: those of product.json `extensionsGallery`, Open VSX's download host, Microsoft's marketplace. */
export function galleryHosts(product) {
	const gallery = product.extensionsGallery;
	if (gallery === undefined || typeof gallery.serviceUrl !== 'string') {
		throw new Error('[gallery_unreadable] product.json has no extensionsGallery.serviceUrl');
	}
	const hosts = new Set([...MARKETPLACE_HOSTS, 'openvsx.eclipsecontent.org']);
	for (const key of ['serviceUrl', 'itemUrl', 'resourceUrlTemplate']) {
		if (typeof gallery[key] === 'string') {
			hosts.add(new URL(gallery[key].replace(/\{[^}]+\}/g, 'x')).hostname);
		}
	}
	return [...hosts].sort();
}

/** Every URL the request service started, from its trace lines (`#<n>: <url> - begin`, src/vs/platform/request/common/request.ts). */
export function requestUrls(logText) {
	return [...logText.matchAll(/#\d+: (\S+) - begin/g)].map(match => match[1]);
}

function isGalleryUrl(url, hosts) {
	if (!URL.canParse(url)) {
		throw new Error(`[request_url_unparseable] the request log names ${JSON.stringify(url)}`);
	}
	const host = new URL(url).hostname;
	return hosts.some(h => host === h || host.endsWith(`.${h}`));
}

/** A toast about a pack member, Pylance, an install or a recommendation. */
function isPackToast(text, members) {
	const lower = text.toLowerCase();
	return /pylance|install|recommend/.test(lower) || members.some(id => lower.includes(id) || lower.includes(id.split('.')[1]));
}

/**
 * One launch's verdict on the extension pack, from what was observed outside the app: `installed` (ids found in
 * the run's --extensions-dir), `requests` (request-service URLs from the trace logs), `traceLines` (count of
 * [trace] lines, so a silent log cannot pass), `toasts` (notification texts seen). FAIL names every reason.
 */
export function judgePackQuiet({ members, hosts, installed, requests, traceLines, toasts }) {
	if (traceLines === 0) {
		return { status: 'FAIL', reasons: ['trace_log_silent'], detail: '[trace_log_silent] no [trace] line in the launch logs; requests would be invisible' };
	}
	const reasons = [];
	const lines = [];
	if (installed.length > 0) {
		reasons.push('pack_installed');
		lines.push(`[pack_installed] installed into the profile: ${installed.map(id => members.includes(id) ? `${id} (pack member)` : id).join(', ')}`);
	}
	const gallery = requests.filter(url => isGalleryUrl(url, hosts));
	if (gallery.length > 0) {
		reasons.push('gallery_request');
		lines.push(`[gallery_request] ${gallery.length} request(s) to a gallery host: ${gallery.slice(0, 5).join(' ')}`);
	}
	const packToasts = toasts.filter(text => isPackToast(text, members));
	if (packToasts.length > 0) {
		reasons.push('pack_toast');
		lines.push(`[pack_toast] ${packToasts.map(text => JSON.stringify(text)).join(' | ')}`);
	}
	const seen = `${members.length} pack members watched; ${requests.length} request(s), ${gallery.length} to a gallery host; ${traceLines} trace lines; toasts seen: [${toasts.map(text => JSON.stringify(text)).join(', ')}]`;
	return reasons.length === 0
		? { status: 'PASS', reasons, detail: `nothing installed; ${seen}` }
		: { status: 'FAIL', reasons, detail: `${lines.join('; ')}; ${seen}` };
}

/**
 * The extension-pack row: the app's first start is quiet AND the control (a pack member installed and a Pylance
 * toast shown on purpose) trips the detectors -- the install one too when the network is on, where it can succeed.
 */
export function judgePackRow(network, app, control) {
	if (app.status !== 'PASS') {
		return { status: 'FAIL', detail: `app: ${app.detail}` };
	}
	const needed = network === 'on' ? ['pack_installed', 'gallery_request', 'pack_toast'] : ['gallery_request', 'pack_toast'];
	if (control.status !== 'FAIL') {
		return { status: 'FAIL', detail: `[control_not_red] the control launch was judged ${control.status}: ${control.detail}` };
	}
	const blind = needed.filter(reason => !control.reasons.includes(reason));
	if (blind.length > 0) {
		return { status: 'FAIL', detail: `[control_detector_blind] the control did not trip ${blind.join(', ')}: ${control.detail}` };
	}
	return { status: 'PASS', detail: `app (network ${network}): ${app.detail} | control: ${control.detail}` };
}
