/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M7, package K2). A workbench request that fails while the app is quitting (the quit closed
// the window it was waiting for) is logged and shows no dialog: the dialog was app-modal on a closing host window and kept the
// app alive after SIGTERM. A quit that could not be settled still gets its dialog (the window stays open).
// Run from the fork root: `node build/qlhost/check-quit-failure-dialog.mjs src/vs/code/electron-main/qlHost`; rc 0 = GREEN.
// Negative: 251b2f8048d's workbenchHost.ts -> rows 1, 2, 3 RED. The run-time proof is package row K2 (PKG-M7-ROWS.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: check-quit-failure-dialog.mjs <path to src/vs/code/electron-main/qlHost>');
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
const host = readFileSync(join(dir, 'workbenchHost.ts'), 'utf8');

const start = host.indexOf('\tprivate reportFailure(what: string, error: unknown): void {');
const end = start < 0 ? -1 : host.indexOf('\n\t}\n', start);
const body = start < 0 || end < 0 ? '' : host.slice(start, end);
const guardAt = body.indexOf('if (this.closing || this.deps.lifecycleMainService.quitRequested) {');
const dialogAt = body.indexOf('this.showFailure(');
const guard = guardAt < 0 || dialogAt < 0 ? '' : body.slice(guardAt, dialogAt);
const logged = /this\.deps\.logService\.error\(`QuantLab host: \$\{what\} failed while the app is quitting; no dialog is shown`, error\);\s*return;\s*\}/.test(guard);
row('1 reportFailure: while the app is quitting the failure is logged and the function returns before any dialog',
	guardAt >= 0 && dialogAt > guardAt && logged && !/showFailure|showMessageBox/.test(guard),
	`reportFailure ${body ? 'found' : 'MISSING'}, quitting guard before the dialog ${guardAt >= 0 && dialogAt > guardAt}, logged then returns ${logged}`);

const users = [...host.matchAll(/\.catch\(error => this\.reportFailure\(cause, error\)\)/g)].length;
const callers = host.match(/this\.reportFailure\(/g)?.length ?? 0;
row('2 the two requests with nobody to tell (toggle, workbench) are the only callers of reportFailure', users === 2 && callers === 2,
	`${users} request catch(es), ${callers} call(s) of reportFailure`);

const settleAt = host.indexOf('this.settleThenCloseHostWindow().catch(error => {');
const settleEnd = settleAt < 0 ? -1 : host.indexOf('\n\t\t});', settleAt);
const settle = settleAt < 0 || settleEnd < 0 ? '' : host.slice(settleAt, settleEnd);
row('3 a quit that could not be settled still shows its dialog (closing reset first)',
	/this\.closing = false;[\s\S]*this\.showFailure\('QuantLab could not show the workbench\.', 'closing the window', error\);/.test(settle),
	`settle catch ${settle ? 'found' : 'MISSING'}`);

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
