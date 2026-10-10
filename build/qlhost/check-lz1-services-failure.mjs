/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, F-PERF-LZ1-1 review c1 M1): a failure of the services section of `startup()` (each stage: the machine ids,
// initServices, the protocol URL handlers, createQlStartServices), BEFORE and AFTER the early-started terminal host reached its
// `onBeforeShow`, is never an unhandled rejection; it is ONE named failure (startup() rejects with it; no failure log and no
// `app.exit(1)` besides), and startup() rejects only after the host's start unwound. A host that fails before its hook (services
// still pending, then ready) is one failure too (its log line and `app.exit(1)`), and startup() returns. Runs the real startup()
// and startQlTerminalHost() (lz1-startup-fixture.mjs).
// Run from the fork root: `node build/qlhost/check-lz1-services-failure.mjs src/vs`; rc 0 = GREEN.
// Negative: 295dc583a06's app.ts (the services held in a DeferredPromise nobody observes until the hook; the catch rethrows at
// once) -> rows 1a (`unhandledRejection: machine-id failed`) and every services row RED (startup rejects before the host
// unwound; three reports).
import { find, loadStartup, trace } from './lz1-startup-fixture.mjs';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-lz1-services-failure.mjs <path to src/vs>');
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
const servicesRows = [
	{ id: '1a', stage: 'machine ids', hookFirst: false, scenario: { machineIds: { at: 10, reject: 'machine-id failed' }, initServices: fast, protocolUrls: fast, client: { hookAt: 60, boundMs: BOUND } } },
	{ id: '1b', stage: 'machine ids', hookFirst: true, scenario: { machineIds: { at: 40, reject: 'machine-id failed' }, initServices: fast, protocolUrls: fast, client: { hookAt: 5, boundMs: BOUND } } },
	{ id: '2a', stage: 'initServices', hookFirst: false, scenario: { machineIds: fast, initServices: { at: 10, reject: 'initServices failed' }, protocolUrls: fast, client: { hookAt: 80, boundMs: BOUND } } },
	{ id: '2b', stage: 'initServices', hookFirst: true, scenario: { machineIds: fast, initServices: { at: 40, reject: 'initServices failed' }, protocolUrls: fast, client: { hookAt: 5, boundMs: BOUND } } },
	{ id: '3a', stage: 'protocol URL handlers', hookFirst: false, scenario: { machineIds: fast, initServices: fast, protocolUrls: { at: 10, reject: 'protocol url handlers failed' }, client: { hookAt: 80, boundMs: BOUND } } },
	{ id: '3b', stage: 'protocol URL handlers', hookFirst: true, scenario: { machineIds: fast, initServices: fast, protocolUrls: { at: 40, reject: 'protocol url handlers failed' }, client: { hookAt: 5, boundMs: BOUND } } },
	{ id: '4a', stage: 'createQlStartServices', hookFirst: false, scenario: { machineIds: fast, initServices: fast, protocolUrls: fast, createServices: { throws: 'createQlStartServices failed' }, client: { hookAt: 80, boundMs: BOUND } } },
	{ id: '4b', stage: 'createQlStartServices', hookFirst: true, scenario: { machineIds: { at: 30 }, initServices: fast, protocolUrls: fast, createServices: { throws: 'createQlStartServices failed' }, client: { hookAt: 5, boundMs: BOUND } } }
];

for (const { id, stage, hookFirst, scenario } of servicesRows) {
	const message = scenario.machineIds.reject ?? scenario.initServices.reject ?? scenario.protocolUrls.reject ?? scenario.createServices.throws;
	const result = await lib.world({ ...scenario, settleMs: 200 }).run(3000);
	const hookCalled = find(result, /^client hook called$/);
	const failedAt = find(result, /^stage \w+ rejects$|^createQlStartServices$/);
	const order = hookFirst ? hookCalled && failedAt && hookCalled.at <= failedAt.at : failedAt && (!hookCalled || failedAt.at < hookCalled.at);
	const unwound = find(result, /^client unwound /);
	const exit1 = result.exits.filter(entry => entry.how === 'app.exit').length;
	const reports = (result.startup && !result.startup.ok ? 1 : 0) + result.logs.error.length + exit1;
	const late = ['fork ATTACH', 'fork REPORT keychain phase settled', 'client REVEAL'].filter(name => find(result, new RegExp(`^${name}$`)));
	const ok = order && result.unhandled.length === 0 && result.startup?.ok === false && result.startup.error === message && reports === 1
		&& unwound !== undefined && unwound.at <= result.startup.at && late.length === 0;
	row(`${id} the ${stage} fail ${hookFirst ? 'AFTER' : 'BEFORE'} the host reached its hook: no unhandled rejection, one named failure, startup() rejects after the host unwound`,
		ok,
		`scenario order ${order ? 'as named' : 'NOT as named'}; unhandledRejection: ${JSON.stringify(result.unhandled)}; startup ${result.startup ? (result.startup.ok ? 'returned' : `rejected "${result.startup.error}"`) : 'never settled'}; reports ${reports} (error logs ${result.logs.error.length}, app.exit ${exit1}); host unwound ${unwound ? `at ${unwound.at} ms` : 'NEVER'}, startup settled ${result.startup ? `at ${result.startup.at} ms` : 'never'}; after the failure: ${late.length ? late.join(', ') : 'nothing attached, reported or shown'}`,
		result);
}

{
	const result = await lib.world({ machineIds: { at: 40 }, initServices: { at: 10 }, protocolUrls: { at: 10 }, client: { failAt: 10, hookAt: 5, boundMs: BOUND }, settleMs: 200 }).run(3000);
	const failed = find(result, /^client unwound \(failed at step loopback/);
	const ready = find(result, /^createQlStartServices$/);
	const exit1 = result.exits.filter(entry => entry.how === 'app.exit' && entry.code === 1).length;
	const reports = (result.startup && !result.startup.ok ? 1 : 0) + result.logs.error.length + exit1;
	const ok = result.unhandled.length === 0 && result.startup?.ok === true && result.logs.error.length === 1 && exit1 === 1 && reports === 2
		&& failed !== undefined && !find(result, /^fork ATTACH$/) && !find(result, /^finishQlTerminalHost$/);
	row('5 the host fails before its hook while the services are pending: no unhandled rejection, one failure (its error log and app.exit(1)), startup() returns',
		ok,
		`unhandledRejection: ${JSON.stringify(result.unhandled)}; host failed and unwound ${failed ? `at ${failed.at} ms` : 'NEVER'}; services ready ${ready ? `at ${ready.at} ms` : 'never (stopped)'}; startup ${result.startup ? (result.startup.ok ? 'returned' : `rejected "${result.startup.error}"`) : 'never settled'}; error logs ${result.logs.error.length}, app.exit(1) ${exit1}; attached ${!!find(result, /^fork ATTACH$/)}, finished ${!!find(result, /^finishQlTerminalHost$/)}`,
		result);
}

console.log(rows.join('\n'));
if (problems.length) {
	console.log(problems.map(problem => `--- ${problem}`).join('\n'));
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
