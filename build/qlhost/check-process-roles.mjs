/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, DRIVER step `ql-test:process-roles`, TEST builds only). qlHost/processRoles.ts is transpiled with the
// fork's typescript and run on fixtures; app.ts and the qlHost directory are read for the wiring: the step and its module
// are reachable only inside the `if (globalThis.QL_TEST_BUILD)` block, which a product bundle drops.
// Run from the fork root: `node build/qlhost/check-process-roles.mjs src/vs`; rc 0 = GREEN.
// Negatives: (a) processRoles.ts without the `if (named.has(pid)) { continue; }` block -> rows 1, 2 RED; (b) app.ts with a
// static `import { qlProcessRoleLines } from './qlHost/processRoles.js';` added -> row 4 RED; (c) processRoles.ts whose
// requirePid returns the pid untested (its `if` block removed) -> row 3 RED. R-293/R-296: app.ts with an unguarded servicesHold
// import added, (i) a static import at a line start or (ii) a dynamic one indented inside another block -> row 5 RED; (iii) the
// guarded hold block duplicated -> rows 4, 5 RED.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-process-roles.mjs <path to src/vs>');
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
const count = (text, pattern) => [...text.matchAll(pattern)].length;
const moduleText = read('code/electron-main/qlHost/processRoles.ts');
const moduleExports = {};
new Function('exports', 'require', ts.transpileModule(moduleText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(moduleExports, id => {
	throw new Error(`processRoles.ts requires ${id} at run time`);
});
const lines = input => moduleExports.qlProcessRoleLines(input);
const same = (got, want) => got.length === want.length && got.every((line, index) => line === want[index]);

{
	const got = lines({
		mainPid: 100,
		views: [{ name: 'terminal', pid: 201 }, { name: 'workbench', pid: 202 }, { name: 'overlay', pid: 203 }],
		utilities: [{ pid: 301, name: 'shared-process' }, { pid: 302, name: 'extension-host [1]' }, { pid: 303, name: 'pty-host' }],
		metrics: [
			{ pid: 100, type: 'Browser' }, { pid: 201, type: 'Tab' }, { pid: 202, type: 'Tab' }, { pid: 203, type: 'Tab' },
			{ pid: 301, type: 'Utility', serviceName: 'node.mojom.NodeService', name: 'shared-process-1' },
			{ pid: 302, type: 'Utility', serviceName: 'node.mojom.NodeService', name: 'extensionHost-2' },
			{ pid: 303, type: 'Utility', serviceName: 'node.mojom.NodeService', name: 'ptyHost-3' },
			{ pid: 401, type: 'GPU' },
			{ pid: 402, type: 'Utility', serviceName: 'network.mojom.NetworkService', name: 'Network Service' },
			{ pid: 403, type: 'Utility', name: 'Audio Service' }
		]
	});
	const want = [
		'process roles begin',
		'process pid=100 role=main',
		'process pid=201 role=renderer:terminal',
		'process pid=202 role=renderer:workbench',
		'process pid=203 role=renderer:overlay',
		'process pid=301 role=utility:shared-process',
		'process pid=302 role=utility:extension-host [1]',
		'process pid=303 role=utility:pty-host',
		'process pid=401 role=chromium:GPU',
		'process pid=402 role=chromium:Utility:network.mojom.NetworkService',
		'process pid=403 role=chromium:Utility:Audio Service',
		'process roles end count=10'
	];
	row('1 every process once, by the role the main process knows; the rest of the app metrics as chromium:<type>', same(got, want), same(got, want) ? `${got.length} lines as expected` : got.join(' | '));
}
{
	const got = lines({
		mainPid: 100,
		views: [{ name: 'terminal', pid: 201 }, { name: 'overlay', pid: 201 }, { name: 'workbench', pid: 0 }],
		utilities: [],
		metrics: [{ pid: 100, type: 'Browser' }, { pid: 201, type: 'Tab' }]
	});
	const want = ['process roles begin', 'process pid=100 role=main', 'process pid=201 role=renderer:terminal', 'process pid=201 role=renderer:overlay', 'process gone role=renderer:workbench', 'process roles end count=4'];
	row('2 two views in one renderer are two lines with one pid; a view without a process is named as gone', same(got, want), same(got, want) ? `${got.length} lines as expected` : got.join(' | '));
}
{
	const base = { mainPid: 100, views: [], utilities: [], metrics: [] };
	const bad = [
		['main pid 0', { ...base, mainPid: 0 }],
		['main pid not an integer', { ...base, mainPid: 1.5 }],
		['view pid negative', { ...base, views: [{ name: 'terminal', pid: -1 }] }],
		['view without a name', { ...base, views: [{ name: '', pid: 5 }] }],
		['utility pid undefined', { ...base, utilities: [{ pid: undefined, name: 'pty-host' }] }],
		['utility name with a line break', { ...base, utilities: [{ pid: 5, name: 'a\nprocess pid=1 role=main' }] }],
		['metric pid 0', { ...base, metrics: [{ pid: 0, type: 'GPU' }] }],
		['metric without a type', { ...base, metrics: [{ pid: 5, type: '' }] }]
	];
	const accepted = bad.filter(([, input]) => {
		try {
			lines(input);
			return true;
		} catch (error) {
			return !error.message.startsWith('QuantLab host (DRIVER): process roles:');
		}
	}).map(([label]) => label);
	row('3 a pid that is not a positive integer or a name that is empty or holds a line break is an error, never a line', accepted.length === 0, accepted.length === 0 ? `${bad.length} inputs refused by name` : `accepted: ${accepted.join('; ')}`);
}
{
	const app = read('code/electron-main/app.ts');
	// anchored at a line start: the services hold's deeper-indented block (startup()) also contains this text
	const anchor = app.indexOf('\n\t\tif (globalThis.QL_TEST_BUILD) {\n');
	const start = anchor < 0 ? -1 : anchor + 1;
	const end = app.indexOf('\n\t\t}\n', start);
	const block = start < 0 ? '' : app.slice(start, end);
	const outside = start < 0 ? app : app.slice(0, start) + app.slice(end);
	// the comment above the block and the block's condition, plus (review c3 M2/M3) the two permission-frame guards in
	// configureSession, which name no qlHost module but securityPolicy's line helper
	const permissionGuards = count(app, /\t\t\tif \(globalThis\.QL_TEST_BUILD && !details\.isMainFrame\) \{\n\t+\/\/[^\n]*\n\t+this\.logService\.info\(`QuantLab host: test build: permission (request|check) /g);
	// and (F-PERF-LZ1-1 c1 M2, arbiter P2) the services hold in startup(), which imports qlHost/servicesHold only
	const servicesHold = count(app, /\t\t\tif \(globalThis\.QL_TEST_BUILD\) \{\n\t\t\t\tconst \{ qlServicesHold \} = await import\('\.\/qlHost\/servicesHold\.js'\);\n\t\t\t\tawait qlServicesHold\(process\.env, message => this\.logService\.info\(message\)\);\n\t\t\t\}\n/g);
	const oneBlock = count(app, /globalThis\.QL_TEST_BUILD/g) === 2 + permissionGuards + servicesHold && permissionGuards === 2 && servicesHold === 1;
	const dynamicInside = count(block, /const \{ qlProcessRoleLines \} = await import\('\.\/qlHost\/processRoles\.js'\);/g) === 1;
	const routeInside = count(block, /event\.message === 'ql-test:process-roles'/g) === 1 && block.includes('utilities: UtilityProcess.getAll(),') && block.includes('metrics: app.getAppMetrics()') && block.includes('view.webContents.getOSProcessId()') && block.includes('this.logService.info(`QuantLab host: test build: ${line}`);');
	const nothingOutside = !/processRoles|process-roles|qlProcessRoleLines/.test(outside);
	const directory = join(vs, 'code/electron-main/qlHost');
	const others = readdirSync(directory).filter(name => name !== 'processRoles.ts' && /\.(ts|json)$/.test(name) && /processRoles|qlProcessRoleLines/.test(readFileSync(join(directory, name), 'utf8')));
	const noImports = !/^import /m.test(moduleText) && !/\brequire\(/.test(moduleText);
	row('4 the step and its module are reachable only inside the QL_TEST_BUILD block (a dynamic import); no other qlHost file names the module; the module imports nothing',
		start >= 0 && oneBlock && dynamicInside && routeInside && nothingOutside && others.length === 0 && noImports,
		`block found ${start >= 0}; one QL_TEST_BUILD block ${oneBlock}; dynamic import inside ${dynamicInside}; route inside with its three sources ${routeInside}; nothing outside the block ${nothingOutside}; other qlHost files naming it [${others.join(', ')}]; module imports nothing ${noImports}`);
}

{
	// R-293 / R-296: the services hold (F-PERF-LZ1-1 c1 M2, arbiter P2) is reachable only inside its ONE guarded block in startup():
	// the block's exact text occurs once, and with it cut out app.ts names neither the module nor its function anywhere (a static
	// import at a line start, a dynamic one indented in another block, a re-export: all are outside the block).
	const app = read('code/electron-main/app.ts');
	const hold = '\t\tif (globalThis.QL_TEST_BUILD) {\n\t\t\t\tconst { qlServicesHold } = await import(\'./qlHost/servicesHold.js\');\n\t\t\t\tawait qlServicesHold(process.env, message => this.logService.info(message));\n\t\t\t}\n';
	// every start of the block at a line start (two blocks back to back share one line break, so no split on it)
	const starts = [];
	for (let at = app.indexOf(`\t${hold}`); at >= 0; at = app.indexOf(`\t${hold}`, at + 1)) {
		if (at > 0 && app[at - 1] === '\n') {
			starts.push(at);
		}
	}
	const blocks = starts.length;
	const outside = blocks === 1 ? app.slice(0, starts[0]) + app.slice(starts[0] + hold.length + 1) : app;
	const namesOutside = [...outside.matchAll(/^.*(?:servicesHold|qlServicesHold).*$/gm)].map(match => match[0].trim());
	const directory = join(vs, 'code/electron-main/qlHost');
	const others = readdirSync(directory).filter(name => name !== 'servicesHold.ts' && /\.(ts|json)$/.test(name) && /servicesHold|qlServicesHold/.test(readFileSync(join(directory, name), 'utf8')));
	row('5 the services hold is reachable only inside its one QL_TEST_BUILD block (a dynamic import); nothing else in app.ts or another qlHost file names it',
		blocks === 1 && namesOutside.length === 0 && others.length === 0,
		`guarded hold blocks ${blocks} (want 1); lines naming it outside the block [${namesOutside.join(' | ')}]; other qlHost files naming it [${others.join(', ')}]`);
}

console.log(rows.join('\n'));
if (problems.length) {
	console.log(`RED: ${problems.length} row(s)`);
	process.exit(1);
}
console.log(`GREEN: ${rows.length} rows`);
