/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 S2, fork half): the test-build view-records dump is published by the client's registry
// (TerminalHost.onViewRecordsChanged, whose behaviour the client's overlay/start tests prove), not by wrapping exported host
// methods, which missed the overlay's internal closes. Reads app.ts: inside the `if (globalThis.QL_TEST_BUILD)` block there is
// exactly one `terminalHost.onViewRecordsChanged(publishViewRecords);` and no reassignment of a terminalHost method.
// Run from the fork root: `node build/qlhost/check-s2-dump.mjs src/vs/code/electron-main/app.ts`; rc 0 = GREEN.
// Negative: the same command on 7e55be1b9cb's app.ts (the method wrappers) -> rc 1 naming both rows.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
	console.error('usage: check-s2-dump.mjs <path to src/vs/code/electron-main/app.ts>');
	process.exit(64);
}
const source = readFileSync(file, 'utf8');
const start = source.indexOf('\t\tif (globalThis.QL_TEST_BUILD) {\n\t\t\tconst { dump } = await import(\'./qlHost/viewRecordsDump.js\');');
if (start < 0) {
	console.error('check-s2-dump: RED: the test-build dump block was not found (app.ts changed: re-read it)');
	process.exit(1);
}
const block = source.slice(start, source.indexOf('\n\t\t}\n', start));
const problems = [];
const subscriptions = block.split('\n').filter(line => line.trim() === 'terminalHost.onViewRecordsChanged(publishViewRecords);').length;
if (subscriptions !== 1) {
	problems.push(`row 1 expected exactly 1 \`terminalHost.onViewRecordsChanged(publishViewRecords);\` in the test-build block, found ${subscriptions}`);
}
const reassigned = [...source.matchAll(/terminalHost\.(\w+) = /g)].map(match => match[1]);
if (reassigned.length > 0) {
	problems.push(`row 2 a terminalHost method is reassigned (a wrapper): ${reassigned.join(', ')}`);
}
if (problems.length > 0) {
	console.error(`check-s2-dump: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-s2-dump: GREEN: the dump subscribes to the registry once; no terminalHost method is wrapped');
