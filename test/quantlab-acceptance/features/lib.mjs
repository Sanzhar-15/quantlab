/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pure parts of the FEATURES closing-check runner (PLAN-FINAL 3.9). No app is launched from here.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The five closing checks, in the plan's order. */
export const CHECK_IDS = ['backtest-bundled-engine', 'python-intelligence', 'notebook-cell', 'pinned-dependency-removed', 'import'];

/** The Python tooling pins the packaged app must carry (product.json builtInExtensions). */
export const PINNED_IDS = ['ms-python.python', 'detachhead.basedpyright', 'ms-toolsai.jupyter'];

export const STATUSES = ['PASS', 'FAIL', 'NOT RUN'];

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
 * The run's result: one entry per check id, in order. A check the driver did not report, or reported
 * with an unknown status, is a FAIL by name. `rc` is 0 only when every check is PASS.
 */
export function assemble(checks) {
	const out = [];
	for (const id of CHECK_IDS) {
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
