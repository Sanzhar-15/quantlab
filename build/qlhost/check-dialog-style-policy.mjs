/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, c1 M5): `window.dialogStyle` is held at 'native' by the bundled chrome policy, so a save confirmation
// raised by a quit while the workbench view is hidden is a native dialog (shown by the OS), never a DOM dialog inside the hidden
// view. qlChromePolicy.ts is transpiled with the fork's typescript (its two imports stubbed) and its lists read; the policy file,
// the setting's registration, the validator and the dialog handler are read from source.
// Run from the fork root: `node build/qlhost/check-dialog-style-policy.mjs src/vs`; rc 0 = GREEN.
// Negative: the pin removed (1f435a97aae's ql-chrome-policy.json and desktop.contribution.ts) -> rc 1 naming rows 2 and 3.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-dialog-style-policy.mjs <path to src/vs>');
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
const read = rel => readFileSync(join(vs, rel), 'utf8');

const { outputText } = ts.transpileModule(read('platform/policy/common/qlChromePolicy.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const stubs = {
	'../../../base/common/policy.js': { PolicyCategory: { Update: 'Update' } },
	'../../../nls.js': { localize: (_key, value) => value },
};
const policyMod = {};
new Function('exports', 'require', outputText)(policyMod, id => {
	if (!(id in stubs)) {
		throw new Error(`qlChromePolicy.ts imports ${id}, which this check does not stub`);
	}
	return stubs[id];
});
const policyOnly = policyMod.QL_POLICY_ONLY_SETTINGS ?? [];
const dialogEntry = policyOnly.find(entry => entry.settingKey === 'window.dialogStyle');
row('row 1 qlChromePolicy.ts: window.dialogStyle is a policy-only key held at native under QlDialogStyle',
	dialogEntry !== undefined && dialogEntry.value === 'native' && dialogEntry.policyName === 'QlDialogStyle' && policyMod.QL_POLICY_DIALOG_STYLE?.name === 'QlDialogStyle',
	JSON.stringify(dialogEntry ?? null));

const file = JSON.parse(read('code/electron-main/qlHost/ql-chrome-policy.json'));
const expected = [...(policyMod.QL_CHROME_POLICIES ?? []), ...policyOnly].map(entry => entry.policyName).sort();
row('row 2 ql-chrome-policy.json: QlDialogStyle is native, and the file names exactly the seed and policy-only policies',
	file.QlDialogStyle === 'native' && JSON.stringify(Object.keys(file).sort()) === JSON.stringify(expected),
	`QlDialogStyle=${JSON.stringify(file.QlDialogStyle)} keys=${Object.keys(file).sort().join(',')} expected=${expected.join(',')}`);

const contribution = read('workbench/electron-browser/desktop.contribution.ts');
const block = contribution.match(/'window\.dialogStyle': \{[^}]*\}/)?.[0] ?? '';
row('row 3 desktop.contribution.ts: the window.dialogStyle registration carries the QlDialogStyle policy',
	/'policy': QL_POLICY_DIALOG_STYLE\b/.test(block), block === '' ? 'registration not found' : (/'policy':/.test(block) ? 'policy present' : 'no policy'));

const validator = read('code/electron-main/qlHost/chromePolicy.ts');
row('row 4 chromePolicy.ts: the validator expects and checks the policy-only keys',
	/new Set\(\[\.\.\.QL_CHROME_POLICIES, \.\.\.QL_POLICY_ONLY_SETTINGS\]/.test(validator) && /for \(const \{ settingKey, policyName, value \} of QL_POLICY_ONLY_SETTINGS\)/.test(validator),
	'expected-names set and the policy-only loop');

const handler = read('workbench/electron-browser/parts/dialogs/dialog.contribution.ts');
row('row 5 dialog.contribution.ts: the dialog handler chooses custom dialogs from window.dialogStyle (the key held)',
	/this\.configurationService\.getValue\('window\.dialogStyle'\) === 'custom'/.test(handler), 'useCustomDialog reads window.dialogStyle');

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-dialog-style-policy: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-dialog-style-policy: GREEN: window.dialogStyle is held at native by the bundled chrome policy');
