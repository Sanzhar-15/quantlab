/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, P12 cure P1). A second launch that carries nothing to open is not a first use of the workbench: stock
// `launchMainService` finds no last active CodeWindow (the host window is not one) and calls `open({ forceEmpty })`; the gate then
// opens nothing, brings the host window forward and logs one info line. The same request WITH an openable, the first launch's
// own request (`initialStartup`) and the other contexts' empty opens (a protocol link, the API) are still first uses.
// gate.ts and workbenchHost.ts are the real sources (p12-host-fixture.mjs transpiles them) driven with fakes.
// Run from the fork root: `node build/qlhost/check-p12-bare-launch.mjs src/vs/code/electron-main/qlHost`; rc 0 = GREEN.
// Negative: 3974929ed9e's gate.ts, or only `return whenIdle ? whenIdle() : this.firstUse(cause, run);` put back to
// `return this.firstUse(cause, run);` -> rows 1, 2, 3 RED (rows 4-6, the controls, stay GREEN).
import { loadHostModules, flush } from './p12-host-fixture.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: check-p12-bare-launch.mjs <path to src/vs/code/electron-main/qlHost>');
	process.exit(64);
}
const rows = [];
const problems = [];
const row = (name, ok, observed) => {
	rows.push(`${ok ? 'GREEN' : 'RED'} ${name}: ${observed}`);
	if (!ok) {
		problems.push(`${name}: ${observed}`);
	}
};

const { OpenContext, makeRig } = loadHostModules(dir);

const firstUseLines = rig => rig.logs.filter(entry => entry.message.startsWith('QuantLab host: workbench first use (cause: '));
const broughtLines = rig => rig.logs.filter(entry => entry.level === 'info' && entry.message.includes('no workbench opened, the host window was brought forward'));

/** Sends `config` to a fresh gate (listener attached) and reports what it did. */
async function send(config, { before } = {}) {
	const rig = makeRig();
	if (before) {
		await before(rig);
	}
	const calls = rig.openCalls.length;
	const result = await rig.gate.open(config).then(value => ({ value }), error => ({ error }));
	await flush();

	return { rig, result, innerOpens: rig.openCalls.length - calls };
}

// The request stock launchMainService makes for a no-argument second launch (macOS default: no force flags; elsewhere: forceNewWindow)
const bare = { context: OpenContext.DESKTOP, cli: { _: [] }, forceEmpty: true };

{
	const { rig, result, innerOpens } = await send(bare);
	row('1 a DESKTOP open with no openables opens nothing: no stock open, no workbench, gate idle, host window shown once, [] returned',
		!result.error && Array.isArray(result.value) && result.value.length === 0 && innerOpens === 0 && rig.gate.workbench === undefined && rig.gate.workbenchState === 'idle' && rig.hostWindow.shows === 1 && rig.shown.length === 0,
		`error ${result.error?.message ?? 'none'}, returned ${JSON.stringify(result.value)}, stock opens ${innerOpens}, state ${rig.gate.workbenchState}, host window shows ${rig.hostWindow.shows}, views shown ${JSON.stringify(rig.shown)}`);
	row('2 exactly one info line names what the gate did and why, and no `workbench first use` line / first-use host log line exists',
		broughtLines(rig).length === 1 && /open \(desktop\) request carries nothing to open and no workbench exists/.test(broughtLines(rig)[0].message) && firstUseLines(rig).length === 0 && !rig.hostLog.some(line => line.includes('first-use workbench')),
		`brought-forward lines ${broughtLines(rig).length}, first-use lines ${firstUseLines(rig).length}, host log ${JSON.stringify(rig.hostLog)}`);
}

{
	const shapes = {
		'CLI context (a shell launch)': { context: OpenContext.CLI, cli: { _: [] }, forceEmpty: true },
		'forceNewWindow + forceEmpty (the non-macOS default of launchMainService)': { context: OpenContext.DESKTOP, cli: { _: [] }, forceNewWindow: true, forceEmpty: true },
		'an empty urisToOpen': { context: OpenContext.DESKTOP, cli: { _: [] }, urisToOpen: [], forceEmpty: true }
	};
	const observed = [];
	let ok = true;
	for (const [name, config] of Object.entries(shapes)) {
		const { rig, result, innerOpens } = await send(config);
		const good = !result.error && innerOpens === 0 && rig.gate.workbenchState === 'idle' && broughtLines(rig).length === 1 && firstUseLines(rig).length === 0;
		ok &&= good;
		observed.push(`${name}: ${good ? 'nothing opened' : `stock opens ${innerOpens}, first-use lines ${firstUseLines(rig).length}, error ${result.error?.message ?? 'none'}`}`);
	}
	row('3 the other shapes of the same no-openables launch (CLI context, forceNewWindow + forceEmpty, empty urisToOpen) open nothing either', ok, observed.join('; '));
}

{
	const folder = { context: OpenContext.DESKTOP, cli: { _: ['/work/folder'] } };
	const { rig, result, innerOpens } = await send(folder);
	row('4 control: the same DESKTOP request WITH a folder argument is a first use (stock open runs once, workbench exists, first-use line, no brought-forward line)',
		!result.error && innerOpens === 1 && rig.gate.workbench !== undefined && rig.gate.workbenchState === 'open' && firstUseLines(rig).length === 1 && firstUseLines(rig)[0].message.endsWith('(cause: open (desktop))') && broughtLines(rig).length === 0,
		`error ${result.error?.message ?? 'none'}, stock opens ${innerOpens}, state ${rig.gate.workbenchState}, first-use lines ${firstUseLines(rig).length}, brought-forward lines ${broughtLines(rig).length}`);
}

{
	const controls = {
		'urisToOpen with a folder (cli empty)': { context: OpenContext.DESKTOP, cli: { _: [] }, urisToOpen: [{ folderUri: { scheme: 'file', path: '/work/folder' } }] },
		'cli folder-uri': { context: OpenContext.DESKTOP, cli: { _: [], 'folder-uri': ['file:///work/folder'] } },
		'cli file-uri': { context: OpenContext.CLI, cli: { _: [], 'file-uri': ['file:///work/file.py'] } },
		'--new-window (an explicit ask for a window)': { context: OpenContext.DESKTOP, cli: { _: [], 'new-window': true }, forceNewWindow: true, forceEmpty: true },
		'--profile (an explicit ask)': { context: OpenContext.DESKTOP, cli: { _: [] }, forceProfile: 'work', forceEmpty: true },
		'a remote authority': { context: OpenContext.DESKTOP, cli: { _: [] }, remoteAuthority: 'ssh-remote+box', forceEmpty: true },
		'the first launch\'s own request / the toggle key (initialStartup, nothing else)': { context: OpenContext.DESKTOP, cli: { _: [] }, initialStartup: true },
		'a protocol link opening an empty window (LINK context)': { context: OpenContext.LINK, cli: { _: [] }, forceNewWindow: true, forceEmpty: true },
		'the API opening a new tab/window (API context)': { context: OpenContext.API, cli: { _: [] }, forceEmpty: true }
	};
	const observed = [];
	let ok = true;
	for (const [name, config] of Object.entries(controls)) {
		const { rig, result, innerOpens } = await send(config);
		const good = !result.error && innerOpens === 1 && rig.gate.workbenchState === 'open' && firstUseLines(rig).length === 1 && broughtLines(rig).length === 0;
		ok &&= good;
		observed.push(`${name}: ${good ? 'first use' : `stock opens ${innerOpens}, state ${rig.gate.workbenchState}, error ${result.error?.message ?? 'none'}`}`);
	}
	row('5 control: a request that asks for something (an openable, --new-window, a profile, a remote, initialStartup, LINK, API) stays a first use', ok, observed.join('; '));
}

{
	// With a workbench open the gate keeps today's behaviour: a bare request is the stock open (nothing is short-circuited).
	const { rig, result, innerOpens } = await send(bare, { before: async setup => { await setup.gate.open({ context: OpenContext.DESKTOP, cli: { _: ['/work/folder'] } }); } });
	row('6 control: with a workbench already open a bare request reaches the stock open as before (it asked for a second window: refused, not brought forward)',
		innerOpens === 1 && broughtLines(rig).length === 0 && result.error !== undefined && /cannot be shown \(the host holds ONE workbench window\)/.test(result.error.message),
		`stock opens ${innerOpens}, brought-forward lines ${broughtLines(rig).length}, error ${result.error?.message ?? 'none'}`);
}

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
