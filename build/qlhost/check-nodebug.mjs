/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, F-HOST-NODEBUG-1): a PRODUCT build accepts no debugger. qlHost/node/debuggerPolicy.ts is transpiled with the
// fork's typescript and run on fixtures under the three values of `globalThis.QL_TEST_BUILD` (false = product bundle, true =
// test bundle, undefined = source run); src/main.ts is read for the wiring; node/argv.ts and main.ts's
// SUPPORTED_ELECTRON_SWITCHES are read so that a debugger option added there later is RED until the policy names it.
// With a bundled main.js as the second argument (the UN-MINIFIED out-vscode/main.js of a PRODUCT build: the minified one has no
// function names), it also proves the define reached the policy as `false`.
// Run from the fork root: `node build/qlhost/check-nodebug.mjs src [out-vscode/main.js]`; last line `SUITE nodebug: PASS n/n`, rc 0.
// Negatives: (a) src/main.ts without the `refuseDebuggers(...)` statement -> row S2 RED; (b) the base (no debuggerPolicy.ts)
// -> row U0 RED; (c) an inspect option missing from REFUSED_INSPECT_OPTIONS -> row L1 RED; (d) a TEST bundle as the second
// argument -> row B1 RED; (e) the r3 policy (15814dca0af: debugger tokens cut, not renamed) -> rows D1 D2 RED, among them
// `--log --inspect-ptyhost=1 /workspace/project`, `--user-data-dir --inspect-extensions=1 /workspace/project` and
// `--remote-debugging-port 9222 /workspace/project` (review c1 MF2).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const src = process.argv[2];
const bundle = process.argv[3];
if (!src || process.argv.length > 4) {
	console.error('usage: check-nodebug.mjs <path to src> [<bundled main.js>]');
	process.exit(64);
}
const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
const rows = [];
const row = (name, ok, observed) => rows.push({ name, ok, line: `${ok ? 'GREEN' : 'RED'} ${name}: ${observed}` });
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);

// ---- wiring: src/main.ts
const MAIN = join(src, 'main.ts');
const main = readFileSync(MAIN, 'utf8');
const importLine = `import { refuseDebuggers } from './vs/code/electron-main/qlHost/node/debuggerPolicy.js'; // QuantLab host (F-HOST-NODEBUG-1)`;
const callLine = 'refuseDebuggers(app.commandLine, process.argv, argvConfig, line => console.error(line));';
const mainLines = main.split('\n');
row('S1 one top-level import of refuseDebuggers', mainLines.filter(line => line === importLine).length === 1, `${mainLines.filter(line => line === importLine).length} import line(s)`);
const calls = mainLines.filter(line => line === callLine).length;
row('S2 one top-level refuseDebuggers statement', calls === 1, `${calls} statement(s) \`${callLine}\``);
const at = text => main.indexOf(text);
const call = at(`\n${callLine}\n`);
const configure = at('\nconst argvConfig = configureCommandlineSwitchesSync(args);\n');
const ready = at(`\napp.once('ready'`);
const mainImport = at(`import('./vs/code/electron-main/main.js')`);
row('S3 the call follows the argv.json switches and precedes ready and electron-main', call >= 0 && configure >= 0 && ready >= 0 && mainImport >= 0 && configure < call && call < ready && call < mainImport,
	`configure ${configure}, call ${call}, ready ${ready}, electron-main import ${mainImport} (character offsets; -1 = not found)`);

// ---- the module, run on fixtures
const MODULE = join(src, 'vs/code/electron-main/qlHost/node/debuggerPolicy.ts');
const present = existsSync(MODULE);
row('U0 qlHost/node/debuggerPolicy.ts present', present, present ? MODULE : `${MODULE} does not exist`);
if (present) {
	const policy = {};
	new Function('exports', 'require', ts.transpileModule(readFileSync(MODULE, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(policy, id => {
		throw new Error(`debuggerPolicy.ts requires ${id} at run time`);
	});
	const fakeCommandLine = (switches, removes = true) => {
		const removed = [];
		return {
			removed,
			hasSwitch: name => switches.includes(name),
			removeSwitch: name => {
				removed.push(name);
				if (removes) {
					switches.splice(switches.indexOf(name), 1);
				}
			}
		};
	};
	const run = (testBuild, argv, argvConfig, switches) => {
		globalThis.QL_TEST_BUILD = testBuild;
		const commandLine = fakeCommandLine(switches);
		const processArgv = [...argv];
		const lines = [];
		const refusals = policy.refuseDebuggers(commandLine, processArgv, argvConfig, line => lines.push(line));
		return { refusals, lines, processArgv, removed: commandLine.removed };
	};
	const line = (name, source) => `QuantLab: refused --${name} (source: ${source}): a product build accepts no debugger (F-HOST-NODEBUG-1)`;
	const EXE = '/Applications/Delta Plus.app/Contents/MacOS/Delta Plus';

	let r = run(false, [EXE, '--remote-debugging-port=9222'], {}, ['remote-debugging-port']);
	row('U1 product: --remote-debugging-port on the command line is refused by name, removed, and renamed in argv',
		same(r.lines, [line('remote-debugging-port', 'command line')]) && same(r.removed, ['remote-debugging-port']) && same(r.processArgv, [EXE, '--ql-refused-remote-debugging-port=9222']),
		JSON.stringify(r));

	r = run(false, [EXE], { 'remote-debugging-port': '9222' }, ['remote-debugging-port']);
	row('U2 product: the argv.json key is refused by name (source argv.json) and removed',
		same(r.lines, [line('remote-debugging-port', 'argv.json')]) && same(r.removed, ['remote-debugging-port']), JSON.stringify(r));

	r = run(false, [EXE, '--remote-debugging-pipe', '-remote-debugging-port=1'], { 'remote-debugging-port': false }, ['remote-debugging-pipe', 'remote-debugging-port']);
	row('U3 product: --remote-debugging-pipe and the single-dash form are refused; a false argv.json value is not a source',
		same(r.lines, [line('remote-debugging-pipe', 'command line'), line('remote-debugging-port', 'command line')]) && same(r.removed, ['remote-debugging-port', 'remote-debugging-pipe'])
			&& same(r.processArgv, [EXE, '--ql-refused-remote-debugging-pipe', '--ql-refused-remote-debugging-port=1']),
		JSON.stringify(r));

	const inspectArgv = [EXE, '--inspect-extensions=1', '--inspect-brk-extensions', '2', '--debugPluginHost=3', '--inspect-ptyhost', '--inspect-search', '--verbose',
		'--inspect-sharedprocess', '-', '/tmp/a.txt', '--', '--inspect=4'];
	r = run(false, inspectArgv, {}, []);
	row('U4 product: the inspect options are renamed in place, their values left where they were; entries after -- are kept',
		same(r.processArgv, [EXE, '--ql-refused-inspect-extensions=1', '--ql-refused-inspect-brk-extensions', '2', '--ql-refused-debugPluginHost=3', '--ql-refused-inspect-ptyhost',
			'--ql-refused-inspect-search', '--verbose', '--ql-refused-inspect-sharedprocess', '-', '/tmp/a.txt', '--', '--inspect=4'])
			&& same(r.lines, ['inspect-extensions', 'inspect-brk-extensions', 'debugPluginHost', 'inspect-ptyhost', 'inspect-search', 'inspect-sharedprocess'].map(name => line(name, 'command line'))),
		JSON.stringify(r));

	for (const [id, value] of [['U5 test bundle', true], ['U6 source run', undefined]]) {
		r = run(value, [...inspectArgv, '--remote-debugging-port=9222'], { 'remote-debugging-port': '9222' }, ['remote-debugging-port']);
		row(`${id}: nothing is refused, nothing removed, argv untouched`,
			same(r.refusals, []) && same(r.lines, []) && same(r.removed, []) && same(r.processArgv, [...inspectArgv, '--remote-debugging-port=9222']), JSON.stringify(r));
	}

	globalThis.QL_TEST_BUILD = false;
	let thrown = '';
	try {
		policy.refuseDebuggers(fakeCommandLine(['remote-debugging-port'], false), [EXE, '--remote-debugging-port=1'], {}, () => undefined);
	} catch (error) {
		thrown = String(error);
	}
	row('U7 product: a removal that does not take effect throws by name', thrown.includes('--remote-debugging-port is still on the command line'), thrown || 'no error');

	const names = [...policy.REFUSED_INSPECT_OPTIONS];
	r = run(false, [EXE, ...names.map(name => `--${name}=1`)], {}, []);
	row('U8 product: each of the inspect names is refused in the =value form', same(r.processArgv, [EXE, ...names.map(name => `--ql-refused-${name}=1`)]) && r.lines.length === names.length, `${r.lines.length} of ${names.length} refused`);

	// ---- differential (MF2 of review c1): the real node/argv.ts parseArgs(OPTIONS) and minimist, before and after the policy.
	// Every option and positional that is not a debugger's must parse the same; only the refused names (and the renamed keys,
	// which parseArgs drops as unknown) may differ.
	const argvModule = {};
	const forkRequire = createRequire(join(process.cwd(), 'package.json'));
	new Function('exports', 'require', ts.transpileModule(readFileSync(join(src, 'vs/platform/environment/node/argv.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)(argvModule, id => {
		if (id === 'minimist') {
			return forkRequire('minimist');
		}
		if (id.endsWith('/nls.js')) {
			return { localize: (_key, message) => message, localize2: (_key, message) => ({ value: message, original: message }) };
		}
		if (id.endsWith('/platform.js')) {
			return { isWindows: false };
		}
		throw new Error(`node/argv.ts requires ${id} in this check`);
	});
	const minimist = forkRequire('minimist');
	const debuggerKey = key => names.includes(key) || policy.REFUSED_DEBUGGER_SWITCHES.includes(key) || key.startsWith('ql-refused-');
	const withoutDebuggers = parsed => Object.fromEntries(Object.entries(parsed).filter(([key]) => !debuggerKey(key)).sort(([a], [b]) => a.localeCompare(b)));
	const sanitised = args => run(false, [EXE, ...args], {}, []).processArgv.slice(1);
	// The reference argv: a single-dash Chromium switch (`-remote-debugging-port`) spelled `--name`, as Chromium reads it. Spelled with
	// one dash, minimist reads the debugger's own token as short letters (`-r…` = reuse-window); that is the debugger's meaning, not a
	// neighbour's.
	const singleDash = arg => /^-[^-]/.test(arg) && policy.REFUSED_DEBUGGER_SWITCHES.some(name => arg === `-${name}` || arg.startsWith(`-${name}=`));
	const reference = args => {
		const end = args.indexOf('--');
		return args.map((arg, i) => (end < 0 || i < end) && singleDash(arg) ? `-${arg}` : arg);
	};
	const DIFF = [
		['--log', '--inspect-ptyhost=1', '/workspace/project'],
		['--user-data-dir', '--inspect-extensions=1', '/workspace/project'],
		['--remote-debugging-port', '9222', '/workspace/project'],
		['--user-data-dir', '--remote-debugging-pipe', '/workspace/project'],
		['--log', 'trace', '--inspect', '--log', 'debug', '/w'],
		['--inspect=1', '--inspect=2', '--inspect-extensions', '3', '/w'],
		['--debugPluginHost', '5', '/w', '--extensions-dir', '--debugSearch', '/w2'],
		['--extensionHomePath', '--debugBrkPluginHost=9', '/w'],
		['--log', '--inspect', '--', '/w', '--inspect=4'],
		['--inspect-brk', 'true', '/w'],
		['--inspect-search', '', '/w'],
		['--user-data-dir', '-remote-debugging-port=9222', '/w'],
		['--file-uri', '-remote-debugging-port', '9222', '/w'],
		['-n', '--inspect-sharedprocess', '/w', '--goto', 'a.ts:1']
	];
	const parseRows = DIFF.map(args => {
		const before = withoutDebuggers(argvModule.parseArgs(reference(args), argvModule.OPTIONS));
		const after = withoutDebuggers(argvModule.parseArgs(sanitised(args), argvModule.OPTIONS));
		return { args, ok: same(after, before), before, after };
	});
	const parseBad = parseRows.filter(({ ok }) => !ok);
	row(`D1 parseArgs(OPTIONS): the sanitised argv parses as the original (single-dash Chromium switches spelled --name) minus the debugger keys (${DIFF.length} fixtures)`, parseBad.length === 0,
		parseBad.length === 0 ? `${DIFF.length}/${DIFF.length} equal` : parseBad.map(({ args, before, after }) => `${JSON.stringify(args)}: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`).join(' ; '));
	const plainBad = DIFF.filter(args => !same(withoutDebuggers(minimist(sanitised(args))), withoutDebuggers(minimist(reference(args)))));
	row('D2 plain minimist (no option table: the bootstrap and any other reader of process.argv): the same fixtures, the same reference, parse the same',
		plainBad.length === 0, plainBad.length === 0 ? `${DIFF.length}/${DIFF.length} equal` : plainBad.map(args => JSON.stringify(args)).join(' ; '));
	const twice = DIFF.filter(args => !same(sanitised(sanitised(args)), sanitised(args)));
	row('D3 a relaunch: the sanitised argv passes the policy again unchanged', twice.length === 0, twice.length === 0 ? `${DIFF.length}/${DIFF.length} unchanged` : twice.map(args => JSON.stringify(args)).join(' ; '));

	// ---- the lists against their sources
	const argvTs = readFileSync(join(src, 'vs/platform/environment/node/argv.ts'), 'utf8');
	const declared = new Set();
	for (const match of argvTs.matchAll(/^\t'(inspect[a-z-]*)': \{([^\n]*)$/gm)) {
		declared.add(match[1]);
		for (const deprecated of (match[2].match(/deprecates: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)) {
			declared.add(deprecated[1]);
		}
	}
	const refused = new Set(names);
	const missing = [...declared].filter(name => !refused.has(name));
	const extra = [...refused].filter(name => !declared.has(name));
	row('L1 REFUSED_INSPECT_OPTIONS = node/argv.ts inspect options + their deprecated names', declared.size > 0 && missing.length === 0 && extra.length === 0,
		`argv.ts ${declared.size} name(s); missing [${missing.join(', ')}]; not in argv.ts [${extra.join(', ')}]`);
	const supported = main.match(/const SUPPORTED_ELECTRON_SWITCHES = \[([\s\S]*?)\];/)?.[1];
	const debuggerKeys = supported === undefined ? [] : [...supported.matchAll(/'([^']+)'/g)].map(match => match[1]).filter(name => name.startsWith('remote-debugging'));
	row('L2 every debugger switch main.ts appends from argv.json is in REFUSED_ARGV_JSON_KEYS', supported !== undefined && debuggerKeys.every(name => policy.REFUSED_ARGV_JSON_KEYS.includes(name)),
		supported === undefined ? 'SUPPORTED_ELECTRON_SWITCHES not found in main.ts' : `argv.json debugger switches [${debuggerKeys.join(', ')}]; refused [${policy.REFUSED_ARGV_JSON_KEYS.join(', ')}]`);
	delete globalThis.QL_TEST_BUILD;
}

// ---- a PRODUCT bundle
if (bundle) {
	const code = readFileSync(bundle, 'utf8');
	const leftover = (code.match(/QL_TEST_BUILD/g) ?? []).length;
	const body = code.match(/function isProductBundle\(\) \{\s*return ([^;]+);/)?.[1];
	row('B1 the bundle is a PRODUCT bundle: the define reached isProductBundle as false', leftover === 0 && (body === 'false === false' || body === 'true'),
		`${leftover} QL_TEST_BUILD reference(s); isProductBundle returns ${body === undefined ? '(function not found: give the un-minified out-vscode/main.js)' : `\`${body}\``}`);
	const marker = (code.match(/a product build accepts no debugger \(F-HOST-NODEBUG-1\)/g) ?? []).length;
	row('B2 the bundle carries the policy', marker === 1, `${marker} occurrence(s) of the refusal text`);
}

for (const { line } of rows) {
	console.log(line);
}
const green = rows.filter(({ ok }) => ok).length;
console.log(`SUITE nodebug: ${green === rows.length ? 'PASS' : 'FAIL'} ${green}/${rows.length}`);
process.exit(green === rows.length ? 0 : 1);
