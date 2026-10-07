/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, F-DESK-UNINSTALL-1): the bootstrap's FIRST act on the profile is the client's
// `claimLaunchOrUninstall(...)`: one top-level statement that comes before every statement of the bootstrap that writes the
// profile or tells Electron where it is. Rule: between the end of the imports and the call, the only top-level statements are
// the ones listed in ALLOWED_BEFORE (none of them writes: marks, the egress switch, portable configuration, argument parsing,
// the profile path's resolution); and each statement of WRITERS_AFTER exists and comes after the call.
// Run from the fork root: `node build/qlhost/check-uninstall-first.mjs src/main.ts`; rc 0 = in place.
// Negatives (each on a copy of src/main.ts): the call block moved below `configureCommandlineSwitchesSync(args)` -> rc 1
// naming that writer; the call deleted -> rc 1; an `fs.mkdirSync(...)` statement inserted above the call -> rc 1 naming it.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
	console.error('usage: check-uninstall-first.mjs <path to src/main.ts>');
	process.exit(64);
}
const source = readFileSync(file, 'utf8');
const lines = source.split('\n');
const problems = [];

const CALL_OPEN = 'claimLaunchOrUninstall({';
const ALLOWED_BEFORE = [
	/^perf\.mark\('code\/(didStartMain|willLoadMainBundle|didLoadMainBundle)'/,
	/^disableBackgroundNetwork\(app\);$/,
	/^const portable = configurePortable\(product\);$/,
	/^const args = parseCLIArgs\(\);$/,
	/^const userDataPath = getUserDataPath\(args, product\.nameShort \?\? 'code-oss-dev'\);$/,
];
const WRITERS_AFTER = [
	'const argvConfig = configureCommandlineSwitchesSync(args);',
	`app.setPath('userData', userDataPath);`,
	'const codeCachePath = getCodeCachePath();',
	`app.once('ready', function () {`,
];

if (!/^import \{[^}]*\bclaimLaunchOrUninstall\b[^}]*\} from '\.\/vs\/code\/electron-main\/ql-client\/index\.js';/m.test(source)) {
	problems.push('no top-level import of `claimLaunchOrUninstall` from ./vs/code/electron-main/ql-client/index.js');
}
const callLines = lines.map((line, index) => (line === CALL_OPEN ? index : -1)).filter(index => index >= 0);
if (callLines.length !== 1) {
	problems.push(`expected exactly 1 top-level \`${CALL_OPEN}\` statement, found ${callLines.length}`);
}
if (source.split('claimLaunchOrUninstall(').length - 1 !== callLines.length) {
	problems.push('`claimLaunchOrUninstall(` occurs somewhere other than its one top-level statement');
}
const call = callLines.length === 1 ? callLines[0] : -1;

if (call >= 0) {
	// the call's own block: `userData: userDataPath` and the four product fields, closed by `});`
	const close = lines.indexOf('});', call);
	const block = close < 0 ? '' : lines.slice(call, close + 1).join('\n');
	for (const wanted of ['argv: process.argv,', 'userData: userDataPath,', 'nameShort: product.nameShort,', 'applicationName: product.applicationName,', 'dataFolderName: product.dataFolderName,', 'darwinBundleIdentifier: product.darwinBundleIdentifier']) {
		if (!block.includes(`\t${wanted}`)) {
			problems.push(`the call does not pass \`${wanted}\``);
		}
	}

	// every top-level statement between the imports and the call
	let lastImport = -1;
	for (let index = 0; index < call; index++) {
		if (/^import\b/.test(lines[index])) {
			lastImport = index;
		}
	}
	if (lastImport < 0) {
		problems.push('no import statement precedes the call (the bootstrap changed: re-read it)');
	}
	let depth = 0;
	for (let index = lastImport + 1; index < call; index++) {
		const line = lines[index];
		const topLevel = depth === 0 && line !== '' && !/^\s/.test(line) && !/^(\/\/|\/\*|\*)/.test(line) && !/^[})\]]/.test(line);
		if (topLevel && !ALLOWED_BEFORE.some(allowed => allowed.test(line))) {
			problems.push(`line ${index + 1} runs before the call and is not in the allowed list: \`${line}\``);
		}
		for (const char of line.replace(/\/\/.*$/, '')) {
			if (char === '{' || char === '(' || char === '[') {
				depth++;
			} else if (char === '}' || char === ')' || char === ']') {
				depth--;
			}
		}
	}
	if (depth !== 0) {
		problems.push(`the statements before the call do not balance (depth ${depth}): re-read the bootstrap`);
	}
}

for (const writer of WRITERS_AFTER) {
	const at = lines.indexOf(writer);
	if (at < 0) {
		problems.push(`no top-level \`${writer}\` found (the bootstrap changed: re-read it)`);
	} else if (call >= 0 && at < call) {
		problems.push(`\`${writer}\` (line ${at + 1}) comes BEFORE the call (line ${call + 1}): a refused launch would write the profile`);
	}
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(`check-uninstall-first: RED ${file}: ${problem}`);
	}
	process.exit(1);
}
console.log(`check-uninstall-first: GREEN ${file}: claimLaunchOrUninstall is the bootstrap's first act on the profile (line ${call + 1})`);
