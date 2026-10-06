/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, U5-LAUNCH-3): the packaged build compiles with the mangler (build/lib/mangle/index.ts), which renames
// EVERY private and protected class member and has no opt-out for one. Host code that reaches a CodeWindow member by its source
// name through a cast (`codeWindow as unknown as { _win }`) is not renamed with it, so the member is absent at run time in the
// packaged app only ("CodeWindow._win is absent or is not a BrowserWindow"). This check takes the MANGLED compile's windowImpl.js
// and the host sources, collects every CodeWindow member the sources reach (members of an inline-type cast, and members read on
// a variable or property typed ICodeWindow / CodeWindow), and requires each to be defined in the compiled BaseWindow / CodeWindow.
// Run from the fork root after `gulp compile-build-with-mangling`:
//   node build/qlhost/check-mangled-members.mjs src/vs/platform/windows/electron-main/windowImpl.ts \
//     out-build/vs/platform/windows/electron-main/windowImpl.js src/vs/code/electron-main/app.ts src/vs/code/electron-main/qlHost
// rc 0 = GREEN; rc 1 = RED with file:line per member; rc 2 = the inputs cannot answer (not a mangled compile, a class not found).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [windowImplSource, windowImplCompiled, ...args] = process.argv.slice(2);
if (!windowImplSource || !windowImplCompiled || args.length === 0) {
	console.error('usage: check-mangled-members.mjs <windowImpl.ts> <compiled windowImpl.js> <file-or-dir>...');
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

// comments are blanked (same length, so offsets and line numbers hold): a member named in a comment is not a reach
const blankComments = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, c => c.replace(/[^\n]/g, ' '));
const escapeRe = name => name.replace(/[$]/g, '\\$&');

// the compiled classes: a top-level class runs from its line to the next top-level class. The mangled compile renames exported
// classes too (`export class $nw extends $Ed`), so BaseWindow and CodeWindow are found by structure, never by name: the exported
// classes of windowImpl.ts, in source order, are the exported top-level classes of the compiled file, in the same order, and
// the compiled CodeWindow must extend the compiled BaseWindow.
const windowImplText = blankComments(readFileSync(windowImplSource, 'utf8'));
const sourceExported = [...windowImplText.matchAll(/^export\s+(?:abstract\s+)?class\s+([\w$]+)/gm)].map(m => m[1]);
const compiledText = readFileSync(windowImplCompiled, 'utf8');
const compiledLines = compiledText.split('\n');
const classStartRe = /^(export\s+)?(?:(?:abstract\s+)?class\s+([\w$]+)|let\s+([\w$]+)\s*=\s*class\b)/;
const starts = [];
compiledLines.forEach((line, index) => {
	const m = classStartRe.exec(line);
	if (m) {
		const name = m[2] ?? m[3];
		const exported = Boolean(m[1]) || new RegExp(`^export\\s*\\{[^}]*(?<![\\w$])${escapeRe(name)}(?![\\w$])[^}]*\\}`, 'm').test(compiledText);
		starts.push({ name, index, exported, line });
	}
});
const compiledExported = starts.filter(s => s.exported);
if (sourceExported.length === 0 || sourceExported.length !== compiledExported.length) {
	console.error(`RED: ${windowImplSource} exports ${sourceExported.length} class(es) [${sourceExported.join(', ')}], ${windowImplCompiled} exports ${compiledExported.length} [${compiledExported.map(s => s.name).join(', ')}]: the classes cannot be paired`);
	process.exit(2);
}
const compiledClass = {};
for (const wanted of ['BaseWindow', 'CodeWindow']) {
	const at = sourceExported.indexOf(wanted);
	if (at < 0) {
		console.error(`RED: class ${wanted} is not an exported class of ${windowImplSource}`);
		process.exit(2);
	}
	compiledClass[wanted] = compiledExported[at];
}
if (!new RegExp(`\\bextends\\s+${escapeRe(compiledClass.BaseWindow.name)}(?![\\w$])`).test(compiledClass.CodeWindow.line)) {
	console.error(`RED: the compiled CodeWindow (${compiledClass.CodeWindow.name}, line ${compiledClass.CodeWindow.index + 1}) does not extend the compiled BaseWindow (${compiledClass.BaseWindow.name}): the classes cannot be paired`);
	process.exit(2);
}
console.log(`${windowImplCompiled}: BaseWindow = ${compiledClass.BaseWindow.name} (line ${compiledClass.BaseWindow.index + 1}), CodeWindow = ${compiledClass.CodeWindow.name} (line ${compiledClass.CodeWindow.index + 1})`);
let compiled = '';
for (const wanted of ['BaseWindow', 'CodeWindow']) {
	const at = starts.indexOf(compiledClass[wanted]);
	compiled += compiledLines.slice(starts[at].index, at + 1 < starts.length ? starts[at + 1].index : compiledLines.length).join('\n') + '\n';
}
function isDefined(name) {
	const n = escapeRe(name);

	return new RegExp(`(?:^|\\n)\\s*(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?\\*?${n}\\s*\\(`).test(compiled) // method, accessor
		|| new RegExp(`(?:^|\\n)\\s*(?:static\\s+)?${n}\\s*[=;]`).test(compiled) // class field
		|| new RegExp(`\\bthis\\.${n}\\s*=[^=]`).test(compiled); // field assigned in the constructor or a method
}

// the compile must be the mangled one: of windowImpl.ts's private and protected members, (nearly) none keeps its source name
const privateNames = new Set();
for (const m of windowImplText.matchAll(/\b(?:private|protected)\s+(?:(?:override|static|readonly|async|get|set|abstract)\s+)*([\w$]+)/g)) {
	privateNames.add(m[1]);
}
if (privateNames.size === 0) {
	console.error(`RED: no private or protected member found in ${windowImplSource}`);
	process.exit(2);
}
const kept = [...privateNames].filter(isDefined);
console.log(`${windowImplSource}: ${privateNames.size} private/protected member name(s), ${kept.length} defined under the source name in the compiled classes`);
if (kept.length * 10 > privateNames.size) {
	console.error(`RED: ${windowImplCompiled} is not a mangled compile (${kept.length} of ${privateNames.size} private/protected names survive); run gulp compile-build-with-mangling first`);
	process.exit(2);
}

let reaches = 0;
let red = 0;
function reach(file, src, offset, name, how) {
	reaches++;
	if (!isDefined(name)) {
		const line = src.slice(0, offset).split('\n').length;
		console.log(`RED ${file}:${line} CodeWindow.${name} (${how}) is not defined in the mangled BaseWindow/CodeWindow`);
		red++;
	}
}
for (const f of files) {
	const src = readFileSync(f, 'utf8');
	const code = blankComments(src);

	// `<expr> as unknown as { a?: ...; b(): ... }`: every member of the inline type is reached by its source name
	for (const cast of code.matchAll(/\bas\s+unknown\s+as\s+\{([^{}]*)\}/g)) {
		for (const member of cast[1].matchAll(/(?:^|[;,\n])\s*(?:readonly\s+)?([\w$]+)\s*\??\s*[:(]/g)) {
			reach(f, src, cast.index, member[1], 'reached through a cast');
		}
	}

	// members read on anything declared `: ICodeWindow` / `: CodeWindow` in this file (a path segment or string of that name is not a read)
	const typed = new Set();
	for (const m of code.matchAll(/\b([\w$]+)\s*\??\s*:\s*I?CodeWindow\b(?!\s*\[)/g)) {
		typed.add(m[1]);
	}
	for (const variable of typed) {
		for (const m of code.matchAll(new RegExp(`(?<![\\w$./'"])(?:this\\s*\\.\\s*)?${escapeRe(variable)}\\s*\\??\\.\\s*([\\w$]+)`, 'g'))) {
			reach(f, src, m.index, m[1], `read on ${variable}`);
		}
	}
}
console.log(`${files.length} file(s), ${reaches} CodeWindow member reach(es)`);
console.log(red ? `RED: ${red} member reach(es) the mangled build does not define` : 'GREEN: every CodeWindow member the host reaches is defined in the mangled build');
process.exit(red ? 1 : 0);
