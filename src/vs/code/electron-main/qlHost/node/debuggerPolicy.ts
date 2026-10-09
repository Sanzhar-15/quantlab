/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (F-HOST-NODEBUG-1): a PRODUCT build accepts no debugger. Called ONCE by the bootstrap (src/main.ts), at module top
// level, after the argv.json switches are appended and before `ready` and before vs/code/electron-main/main.js parses
// process.argv. Each refusal is a named stderr line (which switch, which source); the app continues (R-212 (2)).
//   - Chromium's remote debugger: `--remote-debugging-port` (command line, or the argv.json key main.ts appends) and
//     `--remote-debugging-pipe` (command line) are removed from the app's command line, so no DevTools endpoint is served.
//   - The Node inspector options of node/argv.ts (every process the app starts with --inspect from its own arguments: the
//     extension host, the pty host, the search and shared processes, the main process) and their deprecated aliases are cut
//     from process.argv, so electron-main never parses them. A relaunch that adds one passes through here again.
// The runtime route (enableInspectPort) is refused in a built product by extensionHostStarter.ts (F-PACK-12), not here.
// A TEST build (QL_TEST_BUILD=1) keeps every route: the test instruments attach through them.

/** Chromium switches that start a remote debugger. */
export const REFUSED_DEBUGGER_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'] as const;

/** The argv.json keys main.ts appends as one of the switches above (its SUPPORTED_ELECTRON_SWITCHES). */
export const REFUSED_ARGV_JSON_KEYS = ['remote-debugging-port'] as const;

/** node/argv.ts's inspect options and the deprecated names its parser maps onto them. */
export const REFUSED_INSPECT_OPTIONS = [
	'inspect', 'inspect-brk',
	'inspect-extensions', 'inspect-brk-extensions', 'debugPluginHost', 'debugBrkPluginHost',
	'inspect-ptyhost', 'inspect-brk-ptyhost',
	'inspect-search', 'inspect-brk-search', 'debugSearch', 'debugBrkSearch',
	'inspect-sharedprocess', 'inspect-brk-sharedprocess'
] as const;

export type RefusalSource = 'command line' | 'argv.json';

export interface DebuggerRefusal {
	readonly name: string;
	readonly source: RefusalSource;
}

/** The line a refusal writes to stderr. */
export function refusalLine(refusal: DebuggerRefusal): string {
	return `QuantLab: refused --${refusal.name} (source: ${refusal.source}): a product build accepts no debugger (F-HOST-NODEBUG-1)`;
}

/** The option name of an argv entry written `--name` or `--name=value`, or undefined for any other entry. */
function longOptionName(entry: string): string | undefined {
	if (!entry.startsWith('--') || entry === '--') {
		return undefined;
	}
	const equals = entry.indexOf('=');
	return equals < 0 ? entry.slice(2) : entry.slice(2, equals);
}

/**
 * Cuts the inspect options from an argv, as the parser (minimist, node/argv.ts parseArgs) would read them: `--name=value`, and
 * `--name value` where the next entry is the value unless it is `--` or an option (`/^(-|--)[^-]/`). Entries after a bare `--`
 * are positional and kept.
 */
export function cutInspectOptions(argv: readonly string[]): { readonly kept: string[]; readonly refused: string[] } {
	const refusedNames: readonly string[] = REFUSED_INSPECT_OPTIONS;
	const kept: string[] = [];
	const refused: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const entry = argv[i];
		if (entry === '--') {
			kept.push(...argv.slice(i));
			break;
		}
		const name = longOptionName(entry);
		if (name === undefined || !refusedNames.includes(name)) {
			kept.push(entry);
			continue;
		}
		refused.push(name);
		const next = argv[i + 1];
		if (!entry.includes('=') && next !== undefined && next !== '--' && !/^(-|--)[^-]/.test(next)) {
			i++; // the option's value, by minimist's rule for a string option
		}
	}
	return { kept, refused };
}

/** The Chromium debugger switch an argv entry names (Chromium reads `-name` and `--name`, with or without `=value`), or undefined. */
function debuggerSwitchName(entry: string): string | undefined {
	const body = entry.startsWith('--') ? entry.slice(2) : entry.startsWith('-') ? entry.slice(1) : undefined;
	if (body === undefined) {
		return undefined;
	}
	const equals = body.indexOf('=');
	const name = equals < 0 ? body : body.slice(0, equals);
	return (REFUSED_DEBUGGER_SWITCHES as readonly string[]).includes(name) ? name : undefined;
}

/** The Chromium debugger switches written on the command line, before a bare `--` (where Chromium stops reading switches). */
export function commandLineDebuggerSwitches(argv: readonly string[]): string[] {
	const found: string[] = [];
	for (const entry of argv) {
		if (entry === '--') {
			break;
		}
		const name = debuggerSwitchName(entry);
		if (name !== undefined && !found.includes(name)) {
			found.push(name);
		}
	}
	return found;
}

/** The argv without its Chromium debugger switch entries (before a bare `--`), so electron-main and a relaunch never carry them. */
export function cutDebuggerSwitches(argv: readonly string[]): string[] {
	const end = argv.indexOf('--');
	const head = end < 0 ? argv : argv.slice(0, end);
	const tail = end < 0 ? [] : argv.slice(end);
	return [...head.filter(entry => debuggerSwitchName(entry) === undefined), ...tail];
}

/** The argv.json keys main.ts appended as a debugger switch: the value `true`, `'true'` or a non-empty string (main.ts's rule). */
export function argvJsonDebuggerSwitches(argvConfig: Readonly<Record<string, unknown>>): string[] {
	return REFUSED_ARGV_JSON_KEYS.filter(key => {
		const value = argvConfig[key];
		return value === true || (typeof value === 'string' && value.length > 0);
	});
}

/** The part of Electron's `app.commandLine` this policy uses. */
export interface DebuggerCommandLine {
	hasSwitch(name: string): boolean;
	removeSwitch(name: string): void;
}

/**
 * A PRODUCT bundle: the esbuild define (build/lib/optimize.ts) makes `globalThis.QL_TEST_BUILD` the constant `false`. It is
 * `true` in a TEST bundle and undefined in an un-bundled source run; neither is a product. build/qlhost/check-nodebug.mjs
 * proves a product main.js carries the constant.
 */
export function isProductBundle(): boolean {
	return globalThis.QL_TEST_BUILD === false;
}

/**
 * Applies the policy in a PRODUCT bundle; does nothing otherwise. Writes one stderr line per refusal, removes the debugger
 * switches from `commandLine`, and replaces `processArgv`'s entries with the kept ones (no inspect option, no debugger switch). Throws when a switch is still present
 * after its removal (the policy did not take effect: never a silent pass).
 */
export function refuseDebuggers(commandLine: DebuggerCommandLine, processArgv: string[], argvConfig: Readonly<Record<string, unknown>>, write: (line: string) => void): DebuggerRefusal[] {
	if (!isProductBundle()) {
		return [];
	}
	const refusals: DebuggerRefusal[] = [];
	for (const name of commandLineDebuggerSwitches(processArgv)) {
		refusals.push({ name, source: 'command line' });
	}
	for (const name of argvJsonDebuggerSwitches(argvConfig)) {
		refusals.push({ name, source: 'argv.json' });
	}
	const { kept, refused } = cutInspectOptions(processArgv);
	for (const name of refused) {
		refusals.push({ name, source: 'command line' });
	}
	for (const refusal of refusals) {
		write(refusalLine(refusal));
	}
	for (const name of REFUSED_DEBUGGER_SWITCHES) {
		if (commandLine.hasSwitch(name)) {
			commandLine.removeSwitch(name);
			if (commandLine.hasSwitch(name)) {
				throw new Error(`QuantLab: --${name} is still on the command line after its removal (F-HOST-NODEBUG-1)`);
			}
		}
	}
	processArgv.splice(0, processArgv.length, ...cutDebuggerSwitches(kept));
	return refusals;
}
