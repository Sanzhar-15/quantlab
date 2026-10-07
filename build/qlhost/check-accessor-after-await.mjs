/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, U5-LAUNCH-3): a ServicesAccessor is valid only during the synchronous invocation of its function; an
// `accessor.get(...)` after the first `await` of an async function that takes one throws "Illegal state: service accessor is
// only valid during the invocation of its target method" at startup. This scans the given TypeScript sources for every function
// whose parameter list names a ServicesAccessor, and flags any `<accessor>.get(` on a line after that function's first `await`.
// Run from the fork root: `node build/qlhost/check-accessor-after-await.mjs src/vs/code/electron-main/app.ts src/vs/code/electron-main/qlHost`
// rc 0 = GREEN (no use after an await); rc 1 = RED with file:line per use.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
	console.error('usage: check-accessor-after-await.mjs <file-or-dir>...');
	process.exit(64);
}
const files = [];
function collect(p) {
	if (statSync(p).isDirectory()) {
		for (const e of readdirSync(p)) {
			collect(join(p, e));
		}
	} else if (p.endsWith('.ts')) {
		files.push(p);
	}
}
for (const a of args) {
	collect(a);
}
if (files.length === 0) {
	console.error('RED: no .ts files named');
	process.exit(2);
}

const sigRe = /\b(?:async\s+)?(?:function\s+)?([\w$]+)\s*\(([^)]*\b([\w$]+)\s*:\s*ServicesAccessor\b[^)]*)\)\s*(?::\s*[^{]+)?\{/g;
let functions = 0;
let red = 0;
for (const f of files) {
	const src = readFileSync(f, 'utf8');
	for (const m of src.matchAll(sigRe)) {
		const name = m[1];
		const accessorName = m[3];
		const bodyStart = m.index + m[0].length;
		// the body ends at the brace that balances the opening one (strings are not parsed: good enough for these files)
		let depth = 1;
		let i = bodyStart;
		for (; i < src.length && depth > 0; i++) {
			if (src[i] === '{') {
				depth++;
			} else if (src[i] === '}') {
				depth--;
			}
		}
		const body = src.slice(bodyStart, i);
		functions++;
		// comments are blanked (same length, so offsets and line numbers hold) before the search: the word `await` in a comment is not one
		const code = body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, c => ' '.repeat(c.length));
		const firstAwait = code.search(/\bawait\b/);
		if (firstAwait < 0) {
			continue;
		}
		const useRe = new RegExp(`\\b${accessorName}\\s*\\.\\s*get\\s*\\(`, 'g');
		for (const u of code.matchAll(useRe)) {
			if (u.index > firstAwait) {
				const line = src.slice(0, bodyStart + u.index).split('\n').length;
				console.log(`RED ${f}:${line} ${name}(): ${accessorName}.get(...) after the function's first await`);
				red++;
			}
		}
	}
}
console.log(`${files.length} file(s), ${functions} function(s) taking a ServicesAccessor`);
console.log(red ? `RED: ${red} accessor use(s) after an await` : 'GREEN: no ServicesAccessor use after an await');
process.exit(red ? 1 : 0);
