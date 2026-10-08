/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The NATIVE route of window.mjs pressModal. The packaged app enforces the policy window.dialogStyle "native" over the
// user setting the runner writes ("custom"), so its modals (the import confirmation, the publisher-trust prompt) are macOS
// sheets or alert windows, not DOM, and CDP never sees them. They are answered here as a user would, through macOS
// accessibility (System Events), by native-dialog.jxa.js: osascript -l JavaScript native-dialog.jxa.js <pid> <required
// button titles JSON> <message fragment> <title to click | @@none@@>, one `QLNATIVE <json>` line out.
//
// native-dialog.jxa.js is the LOGIN+DATA kit's file, VERBATIM below the fork's licence header (the header is the only
// addition: the hygiene check requires it); the sha256 below is the source file's, i.e. of the copy's bytes after the header:
//   source  QL-G-LOGIN+DATA/battery/session/native-dialog.jxa.js (hub folds/)
//   sha256  edd87c9bd3c1a6578a7bc439d2de6f7413ee5ae7f55110bf01ac15bdee67c8ee
// and the polling below follows that kit's answerNativeDialog (session.mjs). Nothing here retries or reads a failure as
// "no dialog": an osascript failure, a dialog that never appears, two that match, the wrong message, a refused click and a
// dialog that outlives its click each throw by name.
//
// Required buttons: the script matches a container (a sheet, or a non-standard window) only when its buttons include ALL the
// required titles. The list is the one button the caller presses, alone: it is the one title the caller knows (the DOM route
// needs no other), no Cancel title is assumed (a native Cancel label is the product's to name), and the dialog is identified
// by that button AND by its message, which is checked before anything is clicked. A second dialog holding the same button
// is not clicked either: exactly one container may match.

import * as cp from 'node:child_process';
import * as path from 'node:path';

export const OSASCRIPT = '/usr/bin/osascript';
export const JXA_FILE = path.join(import.meta.dirname, 'native-dialog.jxa.js');
// waitMs: the same 60 s as the DOM route. settleMs: between the reading scan and the click scan, which re-reads the tree and
// clicks only if exactly one dialog still matches. closeMs: how long the dialog may outlive its click.
export const NATIVE_LIMITS = { waitMs: 60_000, pollMs: 250, settleMs: 500, closeMs: 5_000 };
const NO_CLICK = '@@none@@';
const MARK = 'QLNATIVE ';
const SCAN_MS = 30_000;
// osascript texts that mean "this process may not drive System Events" (assistive access -25211/-1719, Apple events -1743).
const PERMISSION = /assistive|not allowed|not authori[sz]ed|-25211|-1719|-1743/i;

const fmt = value => value === undefined ? 'undefined' : JSON.stringify(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The process chain from this runner up to launchd, for a permission failure (TCC holds a process of this chain responsible). */
function ancestry() {
	const chain = [];
	let pid = process.pid;
	for (let depth = 0; depth < 12 && pid > 1; depth++) {
		const ps = cp.spawnSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
		const match = ps.status === 0 ? /^\s*(\d+)\s+(.+?)\s*$/.exec(ps.stdout) : null;
		if (match === null) {
			chain.push(`pid ${pid}: ps failed (exit ${fmt(ps.status)}, stderr ${fmt(ps.stderr)}, stdout ${fmt(ps.stdout)})`);
			break;
		}
		chain.push(`pid ${pid} ${match[2]}`);
		pid = Number(match[1]);
	}
	return chain.join(' <- ');
}

function permissionHint() {
	return `PERMISSION: macOS refuses this process the right to drive System Events. osascript is run by ${process.execPath} (pid ${process.pid}); grant THAT binary Accessibility (System Settings > Privacy & Security > Accessibility) and, for -1743, Automation > System Events; the runner scripts no TCC change. If the grant is already there the refusal belongs to the process macOS holds responsible for this chain: ${ancestry()}`;
}

function execFileAsync(file, args, timeoutMs) {
	return new Promise(resolve => {
		cp.execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
	});
}

const rawText = raw => `\`${raw.command}\` exit ${fmt(raw.exitCode)}, signal ${fmt(raw.signal)}, spawn error ${fmt(raw.spawnError)}, stdout ${fmt(raw.stdout)}, stderr ${fmt(raw.stderr)}`;

/**
 * One run of native-dialog.jxa.js. `click` = the button title to click, or undefined to only read. Resolves { raw, result }, result =
 * the script's JSON (pid, procCount, procName, windows, matches, clicked, refusal, absent). Throws [native_osascript_failed] on a
 * non-zero exit, a timeout or a spawn error (osascript's output verbatim) and [native_output_invalid] on output that is not exactly
 * one QLNATIVE JSON line. Nothing is retried.
 */
export async function nativeScan({ pid, required, message, click }) {
	const args = ['-l', 'JavaScript', JXA_FILE, String(pid), JSON.stringify(required), message, click === undefined ? NO_CLICK : click];
	const started = Date.now();
	const run = await execFileAsync(OSASCRIPT, args, SCAN_MS);
	const error = run.error;
	const raw = {
		command: `${OSASCRIPT} ${args.map(a => /^[\w@./+-]+$/.test(a) ? a : JSON.stringify(a)).join(' ')}`,
		exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
		signal: error === null ? null : error.signal === undefined ? null : error.signal,
		spawnError: error === null || typeof error.code === 'number' ? null : `${error.code === undefined ? '' : error.code} ${error.killed ? `killed after the ${SCAN_MS} ms time limit; ` : ''}${error.message}`,
		stdout: run.stdout,
		stderr: run.stderr,
		ms: Date.now() - started,
	};
	if (error !== null) {
		const hint = PERMISSION.test(`${run.stderr}\n${run.stdout}`) ? `; ${permissionHint()}` : '';
		throw new Error(`[native_osascript_failed] route native, pid ${pid}: osascript FAILED: ${rawText(raw)}${hint}`);
	}
	const lines = run.stdout.split('\n').filter(line => line.startsWith(MARK));
	if (lines.length !== 1) {
		throw new Error(`[native_output_invalid] route native, pid ${pid}: osascript produced ${lines.length} ${MARK.trim()} lines, exactly 1 expected: ${rawText(raw)}`);
	}
	let result;
	try {
		result = JSON.parse(lines[0].slice(MARK.length));
	} catch (err) {
		throw new Error(`[native_output_invalid] route native, pid ${pid}: osascript output is not JSON (${err.message}): ${rawText(raw)}`);
	}
	return { raw, result };
}

/** The process's windows as text: roles, names, direct children and the buttons/texts of every container (failure evidence). */
function windowsText(result) {
	if (result.windows.length === 0) {
		return `process pid ${result.pid} (${fmt(result.procName)}) has 0 windows`;
	}
	return result.windows.map(w => `window ${w.index} role=${fmt(w.role)} subrole=${fmt(w.subrole)} name=${fmt(w.name)} title=${fmt(w.title)} children [${w.children.map(c => `${c.path} ${fmt(c.role)}/${fmt(c.subrole)} ${fmt(c.name)}`).join(', ')}] containers [${w.containers.map(c => `${c.kind}${c.path} buttons ${fmt(c.buttons)} texts ${fmt(c.texts)}`).join(' ; ')}]`).join(' | ');
}

const matchesText = result => `${result.matches.length} matching: ${result.matches.map(m => `${m.kind}${m.path} of window ${m.window} buttons ${fmt(m.buttons)} texts ${fmt(m.texts)}`).join(' | ')}`;

/**
 * Answers the native dialog of the app process `pid` whose message contains `message` by pressing `button`.
 * `scan` (nativeScan, or a fake in the tests) and `limits` (NATIVE_LIMITS) are required. Polls limits.pollMs for up to limits.waitMs
 * for a container holding `button`; exactly one must match and its static texts must contain `message`, else nothing is clicked.
 * Clicks by title, then waits up to limits.closeMs for the dialog to be gone. Returns
 * { route: 'native', text, labels, clicked, texts, container }; throws by name otherwise (see the head of this file).
 */
export async function pressNativeDialog({ pid, message, button }, { scan, limits }) {
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`[native_pid_missing] route native needs the app's process id (got ${fmt(pid)})`);
	}
	if (typeof scan !== 'function' || limits === undefined) {
		throw new Error('[native_route_unwired] pressNativeDialog needs the scan function and the limits');
	}
	const required = [button];
	const scanApp = async click => {
		const scanned = await scan({ pid, required, message, click });
		if (scanned.result.procCount !== 1) {
			throw new Error(`[native_process] route native: System Events lists ${scanned.result.procCount} processes with unix id ${pid} (exactly 1 needed); ${rawText(scanned.raw)}`);
		}
		return scanned;
	};

	const started = Date.now();
	let scans = 0;
	let last;
	for (;;) {
		last = await scanApp(undefined);
		scans++;
		if (last.result.matches.length > 0) {
			break;
		}
		if (Date.now() - started > limits.waitMs) {
			throw new Error(`[modal_missing] no dialog "${message}" with a button "${button}", route native: no sheet or window of pid ${pid} holding the button ${fmt(required)} in ${limits.waitMs / 1000} s (${scans} osascript scans); last osascript: ${rawText(last.raw)}; the process's windows (${last.result.windows.length}): ${windowsText(last.result)}`);
		}
		await sleep(limits.pollMs);
	}
	if (last.result.matches.length !== 1) {
		throw new Error(`[modal_ambiguous] route native: more than one native dialog holds "${button}" (${matchesText(last.result)}); nothing was clicked; windows: ${windowsText(last.result)}`);
	}
	if (!last.result.matches[0].message.includes(message)) {
		throw new Error(`[modal_wrong_message] route native: the one dialog holding "${button}" has the static texts ${fmt(last.result.matches[0].texts)}, none containing ${fmt(message)}; nothing was clicked; windows: ${windowsText(last.result)}`);
	}

	// The click scan re-reads the tree and clicks only if exactly one dialog still matches.
	await sleep(limits.settleMs);
	const click = await scanApp(button);
	if (click.result.refusal !== null) {
		throw new Error(`[modal_click_refused] route native: the accessibility script refused to click "${button}": ${click.result.refusal}; ${matchesText(click.result)}; windows: ${windowsText(click.result)}`);
	}
	if (click.result.clicked === null || click.result.matches.length !== 1) {
		throw new Error(`[modal_click_unreported] route native: the accessibility script reported neither a click nor a refusal (clicked ${fmt(click.result.clicked)}, ${matchesText(click.result)}); ${rawText(click.raw)}`);
	}
	const dialog = click.result.matches[0];
	const closeBy = Date.now() + limits.closeMs;
	for (;;) {
		const after = await scanApp(undefined);
		if (after.result.matches.length === 0) {
			break;
		}
		if (Date.now() > closeBy) {
			throw new Error(`[modal_still_present] route native: the dialog did not close ${limits.closeMs / 1000} s after "${button}" was clicked (${matchesText(after.result)})`);
		}
		await sleep(limits.pollMs);
	}
	return { route: 'native', text: dialog.message, labels: dialog.buttons, clicked: click.result.clicked.title, texts: dialog.texts, container: `${dialog.kind}${dialog.path} of window ${dialog.window} (clicked at ${click.result.clicked.path})` };
}
