/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, C1-X1, the customTitleBarVisibility toast): the layout never writes a policy-pinned
// `window.customTitleBarVisibility`. layoutPolicyGuard.ts (no imports) is transpiled with the fork's typescript and run; the
// wiring is read from layout.ts: the stock unconditional NEVER -> AUTO write is gone and the one remaining write of that key
// is under `autoShow === 'write-auto'`. The package proof is INTEG's re-grep for the toast on a built workbench.
// Run from the fork root: `node build/qlhost/check-layout-policy.mjs src/vs/workbench/browser`; rc 0 = GREEN.
// Negative: the same command with 7e55be1b9cb's layout.ts in a copy of that directory -> rc 1 naming the wiring row.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: check-layout-policy.mjs <path to src/vs/workbench/browser>');
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

const { outputText } = ts.transpileModule(readFileSync(join(dir, 'layoutPolicyGuard.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const exported = {};
new Function('exports', outputText)(exported);
const decide = exported.decideCustomTitleBarAutoShow;
if (typeof decide !== 'function') {
	console.error('check-layout-policy: RED: layoutPolicyGuard.ts exports no decideCustomTitleBarAutoShow function');
	process.exit(1);
}
row('row 1 never + pinned by policy (the QuantLab chrome policy) -> no write', decide('never', 'never') === 'policy-pinned', decide('never', 'never'));
row('row 2 never + no policy (stock) -> the stock write to auto', decide('never', undefined) === 'write-auto', decide('never', undefined));
row('row 3 auto -> nothing to do', decide('auto', undefined) === 'nothing' && decide('auto', 'auto') === 'nothing', `${decide('auto', undefined)}, ${decide('auto', 'auto')}`);

const layout = readFileSync(join(dir, 'layout.ts'), 'utf8');
const stockWrite = /=== CustomTitleBarVisibility\.NEVER\) \{\n\t+this\.configurationService\.updateValue\(TitleBarSetting\.CUSTOM_TITLE_BAR_VISIBILITY/.test(layout);
const writes = (layout.match(/updateValue\(TitleBarSetting\.CUSTOM_TITLE_BAR_VISIBILITY,/g) ?? []).length;
const guarded = /if \(autoShow === 'write-auto'\) \{\n\t+this\.configurationService\.updateValue\(TitleBarSetting\.CUSTOM_TITLE_BAR_VISIBILITY, CustomTitleBarVisibility\.AUTO\);/.test(layout);
const inspected = layout.includes('this.configurationService.inspect(TitleBarSetting.CUSTOM_TITLE_BAR_VISIBILITY).policyValue');
row('row 4 layout.ts: the one write of the key is guarded by the policy decision', !stockWrite && writes === 1 && guarded && inspected, `stockWrite=${stockWrite} writes=${writes} guarded=${guarded} inspected=${inspected}`);

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-layout-policy: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-layout-policy: GREEN: a policy-pinned customTitleBarVisibility is never written; stock behaviour kept otherwise');
