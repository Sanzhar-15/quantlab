/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 S5, fork half): no substituted value hides an absent one.
// - windowErrorDetails.ts (no imports) is transpiled with the fork's typescript and run: exit code 0 logs as 0, an absent
//   code or reason logs as `absent`, an empty reason as "". windowImpl.ts uses it for both lines and keeps no `|| '<unknown>'`.
// - gate.ts: the unadopted push carries the refusal itself (no `?? 'unknown'`), after a raised invariant for a missing one.
// Run from the fork root: `node build/qlhost/check-s5-fork.mjs src`; rc 0 = GREEN.
// Negative: the same command on a copy of the tree whose windowErrorDetails.ts reads `details?.exitCode || 'absent'`
// -> rc 1 naming the zero row; on a copy whose gate.ts push reads `reason: refusal ?? 'unknown'` -> rc 1 naming the gate row.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const src = process.argv[2];
if (!src) {
	console.error('usage: check-s5-fork.mjs <path to the fork src directory>');
	process.exit(64);
}
const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
const rows = [];
const problems = [];
const row = (name, ok, observed) => {
	rows.push(`${ok ? 'GREEN' : 'RED'} ${name}: ${observed}`);
	if (!ok) {
		problems.push(`${name}: ${observed}`);
	}
};

// windowErrorDetails: behaviour
const detailsSource = readFileSync(join(src, 'vs/platform/windows/electron-main/windowErrorDetails.ts'), 'utf8');
const { outputText } = ts.transpileModule(detailsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exported = {};
new Function('exports', outputText)(exported);
const format = exported.formatWindowErrorDetails;
if (typeof format !== 'function') {
	console.error('check-s5-fork: RED: windowErrorDetails.ts exports no formatWindowErrorDetails function');
	process.exit(1);
}
const zero = format({ reason: 'clean-exit', exitCode: 0 });
row('row 1 exit code 0 is logged as 0', zero === 'reason: "clean-exit", code: 0', zero);
const absent = format({ reason: 'crashed' });
row('row 2 an absent exit code is logged as absent', absent === 'reason: "crashed", code: absent', absent);
const none = format(undefined);
row('row 3 absent details log both as absent', none === 'reason: absent, code: absent', none);
const empty = format({ reason: '', exitCode: 7 });
row('row 4 an empty reason is logged as "" (not replaced)', empty === 'reason: "", code: 7', empty);

// windowImpl: wiring
const windowImpl = readFileSync(join(src, 'vs/platform/windows/electron-main/windowImpl.ts'), 'utf8');
const substitutions = (windowImpl.match(/(?:reason|exitCode) \|\| '<unknown>'/g) ?? []).length;
const uses = (windowImpl.match(/\(\$\{formatWindowErrorDetails\(details\)\}\)/g) ?? []).length;
row('row 5 windowImpl logs both lines through the formatter, no `|| \'<unknown>\'` left', substitutions === 0 && uses === 2, `substitutions=${substitutions} formatter uses=${uses}`);

// gate: the refusal reason
const gate = readFileSync(join(src, 'vs/code/electron-main/qlHost/gate.ts'), 'utf8');
const defaulted = /reason: refusal \?\?/.test(gate);
const pushesRefusal = gate.includes('this.unadopted.push({ window: codeWindow, reason: refusal });');
const invariant = /if \(refusal === undefined\) \{\n\t\t\tthrow new Error\(/.test(gate);
row('row 6 gate pushes the refusal itself after a raised invariant', !defaulted && pushesRefusal && invariant, `defaulted=${defaulted} pushesRefusal=${pushesRefusal} invariant=${invariant}`);

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-s5-fork: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-s5-fork: GREEN: exit code 0 stays 0, absent says absent, every unadopted window carries its own refusal');
