/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, P12 cure P2). A first use that succeeds but whose request also opened windows the host cannot show (a
// restored session of several windows) is told apart by TYPE (`QlExtraWindowsRefusedError`, gate.ts): the host logs the refusal at
// error level and shows NO dialog. Every other first-use failure still reaches the dialog, and a failure while the app is quitting
// still shows none (review c1 M7). Review c1 repairs: the type is raised only when EVERY refused window was refused because a
// workbench already existed (M2: an adoption failure or a defect in the captured options, mixed results included, is an ordinary
// failure), and the refusal does not end the originating request: the kept workbench's readiness and display checks still run (M3).
// gate.ts and workbenchHost.ts are the real sources (p12-host-fixture.mjs transpiles them),
// driven through `requestWorkbench` (the launch request) with fakes.
// Run from the fork root: `node build/qlhost/check-p12-extra-windows.mjs src/vs/code/electron-main/qlHost`; rc 0 = GREEN.
// Negative: 3974929ed9e's gate.ts + workbenchHost.ts -> rows 1, 2, 3 RED; only the `error instanceof QlExtraWindowsRefusedError`
// handling of `ensureWorkbench` removed -> rows 1, 2, 11-13 RED (rows 4-7, the controls, stay GREEN). Review c1 repairs: 239f1cdc7f9's
// gate.ts + workbenchHost.ts -> rows 8, 9, 10, 12, 13 RED (row 11 is the control that stays GREEN there); only the gate's
// `capacityOnly` test put back to "always the type" -> rows 8, 9, 10 RED.
import { loadHostModules, flush } from './p12-host-fixture.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: check-p12-extra-windows.mjs <path to src/vs/code/electron-main/qlHost>');
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

const { OpenContext, gateModule, makeRig } = loadHostModules(dir);
const REFUSAL = 'cannot be shown (the host holds ONE workbench window)';
const HEADLINE = 'QuantLab could not show the workbench.';
const refusalLines = rig => rig.logs.filter(entry => entry.message.includes(REFUSAL));

// two restored windows: the stock open creates two CodeWindows, the gate adopts the first and closes the second
{
	const rig = makeRig({ windowsPerOpen: () => 2 });
	rig.host.requestWorkbench('launch arguments');
	await flush();
	const lines = refusalLines(rig);
	row('1 extras-only result: the workbench is open and kept, the extra window was closed, and NO dialog is shown',
		rig.gate.workbench !== undefined && rig.gate.workbenchState === 'open' && rig.closedWindows.length === 1 && rig.dialogs.length === 0,
		`state ${rig.gate.workbenchState}, closed windows ${rig.closedWindows.length}, dialogs ${JSON.stringify(rig.dialogs.map(options => options.message))}`);
	row('2 the refusal is logged once, at error level, with the existing message text (`cannot be shown (the host holds ONE workbench window)`)',
		lines.length === 1 && lines[0].level === 'error' && rig.logs.filter(entry => entry.level === 'error' && entry.message.includes(REFUSAL)).length === 1,
		`lines with the text ${lines.length}, levels ${JSON.stringify(lines.map(line => line.level))}`);
}

{
	const rig = makeRig({ windowsPerOpen: () => 2 });
	const refused = await rig.gate.open({ context: OpenContext.DESKTOP, cli: { _: [] }, initialStartup: true }).then(() => undefined, error => error);
	const ctor = gateModule.QlExtraWindowsRefusedError;
	row('3 the gate marks the refusal with a type, not only a message: the rejection of a successful first use with extras is a QlExtraWindowsRefusedError',
		typeof ctor === 'function' && refused instanceof ctor && refused.message.includes(REFUSAL),
		`QlExtraWindowsRefusedError ${typeof ctor}, rejection ${refused === undefined ? 'none' : `${refused.name}: ${refused.message.slice(0, 60)}`}`);
}

{
	// control: a first use that did not open a workbench at all is a failure, and it is told
	const rig = makeRig({ windowsPerOpen: () => 0 });
	rig.host.requestWorkbench('launch arguments');
	await flush();
	row('4 control: a first use that ends without a workbench window still reaches the dialog (once, headline and detail naming the cause)',
		rig.dialogs.length === 1 && rig.dialogs[0].message === HEADLINE && /returned without opening a workbench window/.test(rig.dialogs[0].detail) && rig.gate.workbenchState === 'idle',
		`dialogs ${JSON.stringify(rig.dialogs.map(options => `${options.message} | ${options.detail}`))}, state ${rig.gate.workbenchState}`);
}

{
	// control: a thrown failure of the stock open
	const rig = makeRig({ openFails: new Error('stock open exploded') });
	rig.host.requestWorkbench('launch arguments');
	await flush();
	row('5 control: a thrown first-use failure reaches the dialog (once) and the error log',
		rig.dialogs.length === 1 && rig.dialogs[0].message === HEADLINE && rig.dialogs[0].detail.includes('stock open exploded') && rig.logs.some(entry => entry.level === 'error' && entry.message.includes('launch arguments failed')),
		`dialogs ${JSON.stringify(rig.dialogs.map(options => `${options.message} | ${options.detail}`))}`);
}

{
	// control: told by type, never by message: a plain Error that carries the same words is an ordinary failure
	const rig = makeRig({ openFails: new Error(`the request opened 1 window(s) that ${REFUSAL}, so they were closed: lookalike`) });
	rig.host.requestWorkbench('launch arguments');
	await flush();
	row('6 control: a plain Error that merely carries the refusal\'s words still reaches the dialog (the marker is the type)',
		rig.dialogs.length === 1 && rig.dialogs[0].message === HEADLINE,
		`dialogs ${rig.dialogs.length}`);
}

{
	// control (review c1 M7): the app is quitting: no dialog for either kind of failure, each logged at error. An extras-only refusal
	// is now logged by `ensureWorkbench` (the request goes on after it), so its error line is the refusal's own, not the quit guard's.
	const failing = makeRig({ windowsPerOpen: () => 0 });
	failing.lifecycle.quitRequested = true;
	failing.host.requestWorkbench('launch arguments');
	const extras = makeRig({ windowsPerOpen: () => 2 });
	extras.lifecycle.quitRequested = true;
	extras.host.requestWorkbench('launch arguments');
	await flush();
	row('7 control: while the app is quitting a failure shows no dialog and is logged at error (c1 M7 kept), refusal or not',
		failing.dialogs.length === 0 && extras.dialogs.length === 0
		&& failing.logs.some(entry => entry.level === 'error' && entry.message.includes('failed while the app is quitting; no dialog is shown'))
		&& extras.logs.some(entry => entry.level === 'error' && (entry.message.includes('while the app is quitting') || entry.message.includes(REFUSAL))),
		`dialogs ${failing.dialogs.length}/${extras.dialogs.length}, quitting lines ${failing.logs.filter(entry => entry.message.includes('while the app is quitting')).length}, refusal lines ${refusalLines(extras).length}`);
}

// review c1 M2: only a capacity refusal is the expected one. The first window's adoption (or its option capture) fails, the second is
// adopted: the workbench is kept, and the failure is told in a dialog
async function twoWindows(prepare) {
	const rig = makeRig({ windowsPerOpen: () => 2 });
	prepare(rig);
	rig.host.requestWorkbench('launch arguments');
	await flush();

	return rig;
}

{
	let attempts = 0;
	const rig = await twoWindows(setup => {
		const adopt = setup.adopt;
		setup.adopt = (...args) => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error('injected adoption failure');
			}

			return adopt(...args);
		};
	});
	row('8 M2: two windows, the first adoption throws and the second succeeds: the workbench is kept and the failure reaches the dialog (naming the adoption failure)',
		rig.gate.workbenchState === 'open' && rig.dialogs.length === 1 && rig.dialogs[0].message === HEADLINE && rig.dialogs[0].detail.includes('injected adoption failure'),
		`state ${rig.gate.workbenchState}, dialogs ${JSON.stringify(rig.dialogs.map(options => `${options.message} | ${options.detail}`))}`);
}

{
	// the first window sees two recorded option sets (one extra recorded before the stock open) and is refused for that; the second is adopted
	const rig = makeRig({ windowsPerOpen: () => 2 });
	const stock = rig.gate.inner.open.bind(rig.gate.inner);
	rig.gate.inner.open = config => {
		rig.seam.onCodeWindowOptions({ webPreferences: { sandbox: true } }, { mode: 1 });

		return stock(config);
	};
	rig.host.requestWorkbench('launch arguments');
	await flush();
	row('9 M2: two windows, the first has invalid captured options (2 sets) and the second is adopted: the failure reaches the dialog (naming the option sets)',
		rig.gate.workbenchState === 'open' && rig.dialogs.length === 1 && rig.dialogs[0].message === HEADLINE && /option sets were recorded for it/.test(rig.dialogs[0].detail),
		`state ${rig.gate.workbenchState}, dialogs ${JSON.stringify(rig.dialogs.map(options => `${options.message} | ${options.detail}`))}`);
}

{
	// mixed: one adoption failure AND one capacity refusal in the same result is still an ordinary failure
	let attempts = 0;
	const rig = makeRig({ windowsPerOpen: () => 3 });
	const adopt = rig.adopt;
	rig.adopt = (...args) => {
		attempts += 1;
		if (attempts === 1) {
			throw new Error('injected adoption failure');
		}

		return adopt(...args);
	};
	rig.host.requestWorkbench('launch arguments');
	await flush();
	row('10 M2: three windows, a failed adoption AND a capacity refusal in one result (mixed): an ordinary failure, a dialog',
		rig.gate.workbenchState === 'open' && rig.closedWindows.length === 2 && rig.dialogs.length === 1 && rig.dialogs[0].detail.includes('injected adoption failure'),
		`state ${rig.gate.workbenchState}, closed windows ${rig.closedWindows.length}, dialogs ${JSON.stringify(rig.dialogs.map(options => options.detail))}`);
}

// review c1 M3: the refusal does not end the originating request: the kept workbench's readiness and display checks still run
const READINESS = 'workbench document failed to load';
const readinessRejects = rig => {
	const adopt = rig.adopt;
	rig.adopt = (...args) => ({ ...adopt(...args), whenReady: async () => { throw new Error(READINESS); } });
};

{
	const rig = await twoWindows(() => { });
	row('11 M3 control: extras and a ready workbench: one workbench open and on screen, the extra closed, no dialog, the refusal logged once at error',
		rig.gate.workbenchState === 'open' && rig.closedWindows.length === 1 && rig.shown.length > 0 && rig.shown.every(name => name === 'workbench') && rig.dialogs.length === 0 && refusalLines(rig).length === 1,
		`state ${rig.gate.workbenchState}, closed ${rig.closedWindows.length}, shown ${JSON.stringify(rig.shown)}, dialogs ${rig.dialogs.length}, refusal lines ${refusalLines(rig).length}`);
}

{
	const rig = await twoWindows(readinessRejects);
	row('12 M3: extras and the kept workbench\'s readiness REJECTS: a failure dialog naming the readiness failure, the workbench is not shown, the refusal is still logged at error',
		rig.dialogs.length === 1 && rig.dialogs[0].message === HEADLINE && rig.dialogs[0].detail.includes(READINESS) && !rig.shown.includes('workbench') && refusalLines(rig).length === 1 && refusalLines(rig)[0].level === 'error',
		`dialogs ${JSON.stringify(rig.dialogs.map(options => `${options.message} | ${options.detail}`))}, shown ${JSON.stringify(rig.shown)}, refusal lines ${refusalLines(rig).length}`);
}

{
	const rig = makeRig({ windowsPerOpen: () => 2 });
	readinessRejects(rig);
	rig.lifecycle.quitRequested = true;
	rig.host.requestWorkbench('launch arguments');
	await flush();
	const quitLines = rig.logs.filter(entry => entry.level === 'error' && entry.message.includes('failed while the app is quitting; no dialog is shown'));
	row('13 M3: extras and the readiness failure while the app is quitting: no dialog; the readiness failure itself (not the refusal) is the error logged under the quit guard',
		rig.dialogs.length === 0 && quitLines.length === 1 && quitLines[0].args[0] instanceof Error && quitLines[0].args[0].message === READINESS,
		`dialogs ${rig.dialogs.length}, quit lines ${quitLines.length}, logged error ${quitLines[0]?.args[0]?.message ?? 'none'}`);
}

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
