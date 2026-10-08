/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M7, fork side). The workbench host attaches (key watch, window close handler, lifecycle
// placeholder) from the terminal host's `onBeforeShow` port, i.e. while the window is hidden and before the first load
// (the client's start.dtest proves the port's order), and nowhere else.
// Run from the fork root: `node build/qlhost/check-attach-before-show.mjs src/vs`; rc 0 = GREEN.
// Row 3: a start rejected because the window was closed (`isQuitDuringStart`) is a quit: no `app.exit` in that branch, and
// `lifecycleMainService.quit()` only when no quit is already under way; any other rejection still exits 1.
// Row 4 (package K1-1): the start is a shutdown joiner (`onWillShutdown` -> `join('qlTerminalHostStart', …)`) registered before
// it is awaited, so the lifecycle's final quit cannot end the process under the start's unwind. 34d1cd4f968's app.ts -> rows 1, 4 RED.
// M8 (check-keychain-gate.mjs): onBeforeShow is a block whose FIRST statement is the attach (row 1 reads that form).
// F-PERF-LZ1-1: the host starts before the services exist; the hook awaits them (`await services`), then attaches FIRST. Nothing
// shows before the attach only because the client awaits the hook: row 1 also pins the fork's pairing check (startQlTerminalHost
// throws by name, before the ports, when the client lacks `onBeforeShowAwaited`).
// Negatives: cfd0c72398f's app.ts (attach after startTerminalHost resolved) -> row 1 RED (row 2 stays GREEN: one attach there
// too); c7401d0b279's app.ts (every rejection exits 1) -> row 3 RED. F-PERF-LZ1-1 negatives: (a) the pairing check removed from
// startQlTerminalHost -> row 1 RED; (b) adb6f9a0044's app.ts (the synchronous hook, no await of the services) -> row 1 RED.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-attach-before-show.mjs <path to src/vs>');
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
const app = readFileSync(join(vs, 'code/electron-main/app.ts'), 'utf8');

const portsStart = app.indexOf('const ports: Ports = {');
const portsEnd = portsStart < 0 ? -1 : app.indexOf('\n\t\t};', portsStart);
const ports = portsStart < 0 || portsEnd < 0 ? '' : app.slice(portsStart, portsEnd);
const hook = /onBeforeShow: async started => \{\n\t\t\t\tconst \{ qlWorkbenchHost, encryptionMainService \} = await services;\n\t\t\t\tqlWorkbenchHost\.attach\(started\);/.test(ports);
const startFn = app.indexOf('private async startQlTerminalHost(services: Promise<QlStartServices>)');
const pairing = startFn < 0 ? -1 : app.indexOf('if (onBeforeShowAwaited() !== true) {\n\t\t\tthrow new Error(\'QuantLab host (F-PERF-LZ1-1): the client does not await onBeforeShow', startFn);
const paired = pairing > startFn && pairing < portsStart && /import \{[^}]*\bonBeforeShowAwaited\b[^}]*\} from '\.\/ql-client\/index\.js';/.test(app);
const started = app.indexOf('const starting = startTerminalHost(ports);');
row('1 the ports handed to startTerminalHost attach the workbench host in onBeforeShow (after awaiting the services; the client paired)', hook && paired && started > portsEnd,
	`ports literal ${ports ? 'found' : 'MISSING'}, onBeforeShow -> await services -> attach ${hook}, pairing check before the ports ${paired}, startTerminalHost(ports) after it ${started > portsEnd}`);

const attaches = app.match(/qlWorkbenchHost\.attach\(/g)?.length ?? 0;
row('2 no other attach (none after the start resolved)', attaches === 1, `${attaches} call(s) of qlWorkbenchHost.attach`);

const catchStart = app.indexOf('catch (error)', started);
const catchEnd = catchStart < 0 ? -1 : app.indexOf('this.qlTerminalHost = terminalHost;', catchStart);
const handler = catchStart < 0 || catchEnd < 0 ? '' : app.slice(catchStart, catchEnd);
const quitAt = handler.indexOf('if (isQuitDuringStart(error)) {');
const exit1At = handler.indexOf('app.exit(1);');
const quitBranch = quitAt < 0 || exit1At < 0 ? '' : handler.slice(quitAt, exit1At);
const guarded = /if \(!this\.lifecycleMainService\.quitRequested\) \{\s*this\.lifecycleMainService\.quit\(\)/.test(quitBranch);
const exitInQuit = /app\.(exit|quit)\(/.test(quitBranch);
const returns = /return false;\s*\}\s*$/.test(quitBranch.trimEnd().replace(/this\.logService\.error\(error\);$/, '').trimEnd());
row('3 a quit during the start is not an exit 1: lifecycle quit only when none is under way, no app.exit/app.quit in it, then return',
	quitAt >= 0 && exit1At > quitAt && guarded && !exitInQuit && returns,
	`quit branch ${quitAt >= 0 ? 'found' : 'MISSING'} before app.exit(1) ${exit1At > quitAt}, guarded lifecycle quit ${guarded}, app.exit/quit inside ${exitInQuit}, returns ${returns}`);

const joinAt = app.indexOf(`this.lifecycleMainService.onWillShutdown)(e => e.join('qlTerminalHostStart', starting.then(`);
const awaitAt = app.indexOf('terminalHost = await starting;');
row('4 the start is a shutdown joiner before it is awaited (a quit waits for the unwind)', started >= 0 && joinAt > started && awaitAt > joinAt,
	`start taken as a promise ${started >= 0}, joined on will-shutdown ${joinAt > started}, awaited after the join ${awaitAt > joinAt}`);

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
