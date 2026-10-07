/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M7, fork side). The workbench host attaches (key watch, window close handler, lifecycle
// placeholder) from the terminal host's `onBeforeShow` port, i.e. while the window is hidden and before the first load
// (the client's start.dtest proves the port's order), and nowhere else.
// Run from the fork root: `node build/qlhost/check-attach-before-show.mjs src/vs`; rc 0 = GREEN.
// Negative: cfd0c72398f's app.ts (attach after startTerminalHost resolved) -> row 1 RED (row 2 stays GREEN: one attach there too).
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
const hook = /onBeforeShow: started => qlWorkbenchHost\.attach\(started\)/.test(ports);
const started = app.indexOf('await startTerminalHost(ports)');
row('1 the ports handed to startTerminalHost attach the workbench host in onBeforeShow', hook && started > portsEnd,
	`ports literal ${ports ? 'found' : 'MISSING'}, onBeforeShow -> attach ${hook}, startTerminalHost(ports) after it ${started > portsEnd}`);

const attaches = app.match(/qlWorkbenchHost\.attach\(/g)?.length ?? 0;
row('2 no other attach (none after the start resolved)', attaches === 1, `${attaches} call(s) of qlWorkbenchHost.attach`);

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
