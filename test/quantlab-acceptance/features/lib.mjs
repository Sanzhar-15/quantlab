/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure parts of the FEATURES closing-check runner (PLAN-FINAL 3.9). No app is launched from here.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The five closing checks, in the plan's order, the extension-pack row, then the Quantbook MCP row (W-ORCH, 2026-10-05). */
export const CHECK_IDS = ['backtest-bundled-engine', 'python-intelligence', 'notebook-cell', 'pinned-dependency-removed', 'import', 'extension-pack-quiet', 'quantbook-mcp-absent'];

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
