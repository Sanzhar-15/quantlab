/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, F-PERF-LZ1-1 review c1 M2): the terminal host starts before phase `Ready`, and the lifecycle's quit
// listeners exist only from `Ready`. With the services section held pending, the client at its hidden window (its hook awaiting
// the services), a quit (Electron `app.quit()`: a TERM, Cmd+Q) must: exit 0, once, only after the host's start unwound, within
// 10 s; settle the fork's hook promptly (not at the client's 30 s bound); attach, report or show nothing; run no services step
// after the cancellation. Repeated marked (no waiting window) and unmarked (the start's waiting window opened and closed first:
// with no listener, Electron's default would quit when it closed), with the services never resuming and resuming AFTER the
// cancellation, and with the quit arriving before the client reached its window. A quit after `Ready` (the started host) still
// goes through the lifecycle (exit 0, after the attach). Runs the real startup(), startQlTerminalHost() and LifecycleMainService
// (lz1-startup-fixture.mjs; the client fake awaits the hook with its bound only, so the prompt settle is the fork's own).
// Run from the fork root: `node build/qlhost/check-lz1-quit-before-ready.mjs src/vs`; rc 0 = GREEN.
// Negative: d028d28b5d3's app.ts (M1 only: no early guard, no cancellation) -> every quit row RED (the exit at the quit, before
// the unwind; the hook still pending at the deadline), and the unmarked rows exit when the waiting window closes.
import { find, loadStartup, trace } from './lz1-startup-fixture.mjs';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-lz1-quit-before-ready.mjs <path to src/vs>');
	process.exit(64);
}
const lib = loadStartup(vs);
const rows = [];
const problems = [];
const row = (name, ok, observed, result) => {
	rows.push(`${ok ? 'GREEN' : 'RED'} ${name}: ${observed}`);
	if (!ok) {
		problems.push(`${name}: ${observed}\n${trace(result)}`);
	}
};

const BOUND = 30_000;
const fast = { at: 5 };
const QUIT = 120;
const quitRows = [
	{ id: 'Q1', name: 'marked, the services never resume', scenario: { machineIds: fast, initServices: { hold: true }, protocolUrls: fast, client: { hookAt: 20, boundMs: BOUND } }, resumes: false },
	{ id: 'Q2', name: 'unmarked (the waiting window opened and closed first), the services never resume', scenario: { machineIds: fast, initServices: { hold: true }, protocolUrls: fast, client: { waitingWindowMs: 15, hookAt: 20, boundMs: BOUND } }, resumes: false },
	{ id: 'Q3', name: 'marked, the machine ids resolve AFTER the cancellation', scenario: { machineIds: { hold: true }, initServices: fast, protocolUrls: fast, client: { hookAt: 20, boundMs: BOUND }, releases: [{ at: QUIT + 40, name: 'machineIds' }] }, resumes: true },
	{ id: 'Q4', name: 'unmarked, initServices resolves AFTER the cancellation', scenario: { machineIds: fast, initServices: { hold: true }, protocolUrls: fast, client: { waitingWindowMs: 15, hookAt: 20, boundMs: BOUND }, releases: [{ at: QUIT + 40, name: 'initServices' }] }, resumes: true },
	{ id: 'Q5', name: 'marked, the quit before the client reached its window (it builds it after the quit)', scenario: { machineIds: fast, initServices: { hold: true }, protocolUrls: fast, client: { hookAt: 200, boundMs: BOUND } }, resumes: false, beforeWindow: true }
];

for (const { id, name, scenario, resumes, beforeWindow } of quitRows) {
	const result = await lib.world({ ...scenario, quitAt: QUIT, settleMs: 250 }).run(3000);
	const hookCalled = find(result, /^client hook called$/);
	const unwound = find(result, /^client unwound /);
	const exit = result.exits[0];
	const hook = result.hookOutcomes[0];
	const late = ['fork ATTACH', 'fork REPORT keychain phase settled', 'client REVEAL'].filter(text => find(result, new RegExp(`^${text}$`)));
	const afterQuit = result.events.filter(event => event.at >= QUIT).map(event => event.text);
	const lateInit = afterQuit.filter(text => /^stage (initServices|protocolUrls) started$|^createQlStartServices$|^lifecycle phase/.test(text));
	const released = find(result, /^stage \w+ released$/);
	const setup = (beforeWindow ? (hookCalled === undefined || hookCalled.at > QUIT) : (hookCalled !== undefined && hookCalled.at < QUIT)) && (!resumes || released !== undefined);
	const startupState = result.startup ? (result.startup.ok ? 'returned' : `rejected "${result.startup.error}"`) : 'pending (a services stage held)';
	const ok = setup && result.unhandled.length === 0 && result.exits.length === 1 && exit.code === 0 && exit.how === 'quit'
		&& unwound !== undefined && unwound.at <= exit.at && exit.at - QUIT < 10_000
		&& hook !== undefined && !hook.ok && hook.at - QUIT < 1000 && late.length === 0 && lateInit.length === 0
		&& result.logs.error.length === 0 && result.startup?.ok !== false && (!resumes || result.startup?.ok === true);
	row(`${id} ${name}: a quit at ${QUIT} ms exits 0 once, after the unwind, the hook settled at once, nothing attached, shown or initialised late`,
		ok,
		`scenario ${setup ? 'as named' : 'NOT as named'} (hook called ${hookCalled ? `at ${hookCalled.at} ms` : 'never'}${resumes ? `, stage released ${released ? `at ${released.at} ms` : 'NEVER'}` : ''}); exits ${JSON.stringify(result.exits)}; host unwound ${unwound ? `at ${unwound.at} ms` : 'NEVER'}; fork hook ${hook ? `${hook.ok ? 'resolved' : 'rejected'} at ${hook.at} ms (${hook.at - QUIT} ms after the quit)` : 'still pending at the deadline'}; after the quit: ${late.length ? late.join(', ') : 'nothing attached/reported/shown'}, late services steps ${lateInit.length ? lateInit.join(', ') : 'none'}; error logs ${result.logs.error.length}; unhandledRejection ${JSON.stringify(result.unhandled)}; startup ${startupState}`,
		result);
}

{
	const result = await lib.world({ machineIds: fast, initServices: fast, protocolUrls: fast, client: { hookAt: 40, boundMs: BOUND }, quitAt: 250, settleMs: 250 }).run(3000);
	const attach = find(result, /^fork ATTACH$/);
	const reveal = find(result, /^client REVEAL$/);
	const ready = find(result, /^lifecycle phase 2$/);
	const exit = result.exits[0];
	const ok = result.unhandled.length === 0 && result.startup?.ok === true && attach !== undefined && reveal !== undefined && ready !== undefined && ready.at < 250
		&& result.exits.length === 1 && exit.code === 0 && exit.how === 'quit' && find(result, /^state service closed$/) !== undefined && result.logs.error.length === 0;
	row('R1 a quit after Ready (the started host) goes through the lifecycle: attached and shown once, exit 0 after its shutdown',
		ok,
		`Ready ${ready ? `at ${ready.at} ms` : 'never'}; attach ${attach ? `at ${attach.at} ms` : 'never'}; reveal ${reveal ? `at ${reveal.at} ms` : 'never'}; exits ${JSON.stringify(result.exits)}; lifecycle shutdown (state closed) ${!!find(result, /^state service closed$/)}; error logs ${result.logs.error.length}; startup ${result.startup ? (result.startup.ok ? 'returned' : `rejected ${result.startup.error}`) : 'never settled'}`,
		result);
}

console.log(rows.join('\n'));
if (problems.length) {
	console.log(problems.map(problem => `--- ${problem}`).join('\n'));
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
