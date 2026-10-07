/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab): every ESM bundle under out-vscode (the fork's main process, shared/utility processes) that imports a
// bare, non-builtin, non-electron package by NAMED import must find those names in the real module. Node's ESM loader exposes
// only the named exports it can detect in a CommonJS module; a getter-defined export is NOT found, and the main process
// throws SyntaxError before `ready` (package 5, folds/HOST/U5-LAUNCH-1.md).
// Run from the fork root: `node build/qlhost/check-esm-imports.mjs out-vscode`; rc 0 = every named import resolves.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) {
	console.error('usage: check-esm-imports.mjs <out dir>');
	process.exit(64);
}
const builtin = new Set(builtinModules.flatMap(m => [m, 'node:' + m]));
const skip = /\/ql-client\//; // the client's own bundles (vite/esbuild output, not loaded by the fork's main as ESM entries)
const files = [];
function walk(d) {
	for (const e of readdirSync(d)) {
		const p = join(d, e);
		if (statSync(p).isDirectory()) {
			walk(p);
		} else if (p.endsWith('.js') && !skip.test(p)) {
			files.push(p);
		}
	}
}
walk(root);
if (files.length === 0) {
	console.error(`RED: no .js files under ${root}`);
	process.exit(2);
}

// import { a, b as c } from "pkg" | import x, { a } from "pkg" | import * as ns from "pkg" | import d from "pkg"
const re = /\bimport\s*(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|(\*\s*as\s*[\w$]+)|([\w$]+))?\s*from\s*["']([^"']+)["']/g;
const want = new Map(); // spec -> { names, files, star, dflt }
let scanned = 0;
for (const f of files) {
	const src = readFileSync(f, 'utf8');
	scanned++;
	for (const m of src.matchAll(re)) {
		const spec = m[5];
		if (spec.startsWith('.') || spec.startsWith('/') || builtin.has(spec) || spec === 'electron' || spec === 'original-fs') {
			continue;
		}
		const rec = want.get(spec) ?? { names: new Set(), files: new Set(), star: false, dflt: false };
		if (m[2]) {
			for (const part of m[2].split(',')) {
				const n = part.trim().split(/\s+as\s+/)[0].trim();
				if (n) {
					rec.names.add(n);
				}
			}
		}
		if (m[3]) {
			rec.star = true;
		}
		if (m[1] || m[4]) {
			rec.dflt = true;
		}
		rec.files.add(relative(root, f));
		want.set(spec, rec);
	}
}
const require = createRequire(pathToFileURL(join(process.cwd(), 'package.json')));
let red = 0;
console.log(`scanned ${scanned} bundles under ${root}; bare non-builtin packages: ${want.size}`);
for (const [spec, rec] of [...want].sort()) {
	const names = [...rec.names].join(',');
	const where = [...rec.files].join(' ');
	let ns;
	try {
		ns = await import(require.resolve(spec));
	} catch (e) {
		// A module that cannot load here at all (a native prebuild absent from this tree) is a different failure from the
		// named-export class: RED only when a named import depends on it, else reported as unverified by name.
		const line = String(e.message).split('\n')[0];
		if (rec.names.size) {
			console.log(`RED ${spec}: cannot load as ESM and has named import(s) ${names}: ${line} [${where}]`);
			red++;
		} else {
			console.log(`UNVERIFIED ${spec}: cannot load in this tree (no named imports; default=${rec.dflt} star=${rec.star}): ${line} [${where}]`);
		}
		continue;
	}
	const missing = [...rec.names].filter(n => !(n in ns));
	if (missing.length) {
		console.log(`RED ${spec}: named import(s) not exported for ESM: ${missing.join(', ')} [${where}]`);
		red++;
	} else {
		console.log(`ok  ${spec}: names=${names || '-'} default=${rec.dflt} star=${rec.star} [${where}]`);
	}
}
console.log(red ? `RED: ${red} package(s) with unresolvable ESM named imports` : 'GREEN: every bare named import resolves under node ESM');
process.exit(red ? 1 : 0);
