/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (F-HOST-NODEBUG-1): a PRODUCT build accepts no debugger. Called ONCE by the bootstrap (src/main.ts), at module top
// level, after the argv.json switches are appended and before `ready` and before vs/code/electron-main/main.js parses
// process.argv. Each refusal is a named stderr line (which switch, which source); the app continues (R-212 (2)).
//   - Chromium's remote debugger: `--remote-debugging-port` (command line, or the argv.json key main.ts appends) and
//     `--remote-debugging-pipe` (command line) are removed from the app's command line, so no DevTools endpoint is served,
//     and renamed in process.argv, so a relaunch never carries them.
//   - The Node inspector options of node/argv.ts (every process the app starts with --inspect from its own arguments: the
//     extension host, the pty host, the search and shared processes, the main process) and their deprecated aliases are renamed
//     in process.argv (`--ql-refused-<name>`), so electron-main never parses them and every other argument keeps its meaning.
//     A relaunch that adds one passes through here again.
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

/** The prefix a refused entry is renamed with: `--inspect=1` becomes `--ql-refused-inspect=1`, `-remote-debugging-port=1` `--ql-refused-remote-debugging-port=1`. */
export const NEUTRALISED_PREFIX = '--ql-refused-';

/**
 * Renames, in place, each argv entry before a bare `--` that is an inspect option (`--name`, `--name=value`) or a Chromium debugger
 * switch (`-name`, `--name`, with or without `=value`). A renamed entry is still an option in the same position, so a parser binds to
 * it exactly the value it bound to the refused name (`--inspect-ptyhost 9229`, `--remote-debugging-port 9222`), and binds nothing new
 * to the option before it; node/argv.ts parseArgs drops it as an unknown option and Chromium ignores the unknown switch. Cutting the
 * entry instead hands its value or the next path to a neighbour (`--log --inspect-ptyhost=1 /ws` would read /ws as a log level), and
 * would make electron-main parse differently from the bootstrap. Entries after a bare `--` are positional and kept.
 */
export function neutraliseDebuggerArgs(argv: readonly string[]): { readonly argv: string[]; readonly inspect: string[] } {
	const inspectNames: readonly string[] = REFUSED_INSPECT_OPTIONS;
	const end = argv.indexOf('--');
	const neutralised = [...argv];
	const inspect: string[] = [];
	for (let i = 0; i < (end < 0 ? argv.length : end); i++) {
		const entry = argv[i];
		const name = longOptionName(entry);
		const isInspect = name !== undefined && inspectNames.includes(name);
		if (isInspect) {
			inspect.push(name);
		}
		if (isInspect || debuggerSwitchName(entry) !== undefined) {
			neutralised[i] = NEUTRALISED_PREFIX + entry.replace(/^--?/, '');
		}
	}
	return { argv: neutralised, inspect };
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
 * switches from `commandLine`, and renames `processArgv`'s inspect options and debugger switches (neutraliseDebuggerArgs). Throws when a switch is still present
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
	const neutralised = neutraliseDebuggerArgs(processArgv);
	for (const name of neutralised.inspect) {
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
	processArgv.splice(0, processArgv.length, ...neutralised.argv);
	return refusals;
}
