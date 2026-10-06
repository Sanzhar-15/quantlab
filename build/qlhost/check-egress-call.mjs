/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, EGRESS-MAIN): the bootstrap calls the client's `disableBackgroundNetwork(app)` at module top level,
// BEFORE it registers its `ready` listener and before it imports vs/code/electron-main/main.js (which runs after `ready`,
// where the function throws). The fork twin of the client's BGNET-1 (main-calls-before-ready).
// Run from the fork root: `node build/qlhost/check-egress-call.mjs src/main.ts`; rc 0 = the call is in place.
// Negative: the same command on a copy of src/main.ts with the call line deleted -> rc 1 naming the missing statement.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
	console.error('usage: check-egress-call.mjs <path to src/main.ts>');
	process.exit(64);
}
const source = readFileSync(file, 'utf8');
const problems = [];
const importLine = `import { disableBackgroundNetwork } from './vs/code/electron-main/ql-client/index.js';`;
if (!source.includes(`\n${importLine}`)) {
	problems.push(`no top-level \`${importLine}\``);
}
const calls = source.split('\n').filter(line => line === 'disableBackgroundNetwork(app);').length;
if (calls !== 1) {
	problems.push(`expected exactly 1 top-level \`disableBackgroundNetwork(app);\` statement, found ${calls}`);
}
const call = source.indexOf('\ndisableBackgroundNetwork(app);\n');
const ready = source.indexOf(`\napp.once('ready'`);
const mainImport = source.indexOf(`import('./vs/code/electron-main/main.js')`);
if (ready < 0) {
	problems.push(`no top-level \`app.once('ready'\` registration found (the bootstrap changed: re-read it)`);
}
if (mainImport < 0) {
	problems.push(`no \`import('./vs/code/electron-main/main.js')\` found (the bootstrap changed: re-read it)`);
}
if (call >= 0 && ready >= 0 && call > ready) {
	problems.push(`the call comes after the \`app.once('ready'\` registration`);
}
if (call >= 0 && mainImport >= 0 && call > mainImport) {
	problems.push(`the call comes after the import of vs/code/electron-main/main.js`);
}
if (problems.length > 0) {
	for (const problem of problems) {
		console.error(`check-egress-call: RED ${file}: ${problem}`);
	}
	process.exit(1);
}
console.log(`check-egress-call: GREEN ${file}: disableBackgroundNetwork(app) is called at top level before the ready listener and before the main import`);
