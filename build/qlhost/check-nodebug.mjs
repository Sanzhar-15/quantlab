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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// ---- DevTools (MF1 of review c1; owner R-228 / R-225 (A)): platform/windows/electron-main/qlDevToolsPolicy.ts, run on fixtures
// under the three values of QL_TEST_BUILD, and the main-process sources read syntax-aware (the fork's typescript parser).
const DEVTOOLS = join(src, 'vs/platform/windows/electron-main/qlDevToolsPolicy.ts');
const devPresent = existsSync(DEVTOOLS);
row('V0 platform/windows/electron-main/qlDevToolsPolicy.ts present', devPresent, devPresent ? DEVTOOLS : `${DEVTOOLS} does not exist`);
if (devPresent) {
	const dev = {};
	new Function('exports', 'require', ts.transpileModule(readFileSync(DEVTOOLS, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(dev, id => {
		throw new Error(`qlDevToolsPolicy.ts requires ${id} at run time`);
	});
	const ROUTE = 'toggleDevTools (native host: the Toggle Developer Tools action)';
	const outcome = testBuild => {
		globalThis.QL_TEST_BUILD = testBuild;
		const lines = [];
		const allowed = dev.allowDevToolsRoute(ROUTE, line => lines.push(line));
		return { devTools: dev.devToolsAllowed(), allowed, lines };
	};
	let o = outcome(false);
	row('V1 product: webPreferences.devTools is false and a route is refused by a named line', o.devTools === false && o.allowed === false
		&& same(o.lines, [`QuantLab: refused DevTools via ${ROUTE}: a product build opens no DevTools (F-HOST-NODEBUG-1)`]), JSON.stringify(o));
	for (const [id, value] of [['V2 test bundle', true], ['V3 source run', undefined]]) {
		o = outcome(value);
		row(`${id}: DevTools allowed, nothing refused`, o.devTools === true && o.allowed === true && o.lines.length === 0, JSON.stringify(o));
	}
	delete globalThis.QL_TEST_BUILD;
}

// The main-process sources: electron-main and electron-utility folders under vs/code and vs/platform, tests excluded.
const mainSources = [];
const walk = dir => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'test') {
				walk(path);
			}
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') && /\/electron-(main|utility)\//.test(path)) {
			mainSources.push(path);
		}
	}
};
walk(join(src, 'vs/code'));
walk(join(src, 'vs/platform'));
const parsed = new Map(mainSources.map(path => [path, ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)]));
const rel = path => path.slice(src.length + 1);
const where = node => `${rel(node.getSourceFile().fileName)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
const visit = (node, fn) => {
	fn(node);
	ts.forEachChild(node, child => visit(child, fn));
};
const isRouteCall = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'allowDevToolsRoute';
const containsRouteCall = node => {
	let found = false;
	visit(node, child => found ||= isRouteCall(child));
	return found;
};
// A call is guarded when (a) it sits in the then-branch of an `if` whose condition calls allowDevToolsRoute without negating it, or
// (b) an earlier statement of an enclosing block is `if (!allowDevToolsRoute(...)) { return; }`. The one named exception: the stock
// opener that runs only from sources (`!this.environmentMainService.isBuilt`), never in a built app, TEST or PRODUCT.
const guarded = call => {
	for (let node = call, parent = call.parent; parent; node = parent, parent = parent.parent) {
		if (ts.isIfStatement(parent) && parent.thenStatement === node) {
			const condition = parent.expression.getText();
			if (containsRouteCall(parent.expression) && !condition.trimStart().startsWith('!')) {
				return 'route';
			}
			if (condition.startsWith('!this.environmentMainService.isBuilt')) {
				return 'sources only';
			}
		}
		if (ts.isBlock(parent)) {
			const before = parent.statements.slice(0, parent.statements.indexOf(node));
			if (before.some(statement => ts.isIfStatement(statement) && statement.expression.getText().startsWith('!allowDevToolsRoute(')
				&& /^\{?\s*return;?\s*\}?$/.test(statement.thenStatement.getText()))) {
				return 'route';
			}
		}
	}
	return undefined;
};
const openers = [];
const constructions = [];
for (const file of parsed.values()) {
	visit(file, node => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['openDevTools', 'toggleDevTools'].includes(node.expression.name.text)
			&& !/^this\.nativeHostMainService\b/.test(node.expression.expression.getText())) {
			openers.push({ at: where(node), guard: guarded(node) });
		}
		if (ts.isNewExpression(node) && /(^|\.)(BrowserWindow|WebContentsView|BrowserView|BaseWindow)$/.test(node.expression.getText())) {
			constructions.push(where(node).replace(/:\d+$/, ''));
		}
	});
}
const unguarded = openers.filter(({ guard }) => guard === undefined);
let sourceRouteCalls = 0;
for (const file of parsed.values()) {
	visit(file, node => {
		if (isRouteCall(node)) {
			sourceRouteCalls++;
		}
	});
}
row('W1 every DevTools-opening call in the main process is refused by name in PRODUCT (allowDevToolsRoute) or runs from sources only',
	openers.length > 0 && unguarded.length === 0,
	`${openers.length} call(s): ${openers.map(({ at, guard }) => `${at} ${guard ?? 'UNGUARDED'}`).join('; ')}`);
// Each place the main process constructs a window or view, and where its webPreferences.devTools comes from. A new place is RED
// until it is named here with its source.
const KNOWN_CONSTRUCTIONS = {
	'vs/platform/windows/electron-main/windowImpl.ts': 'defaultBrowserWindowOptions (W2)',
	'vs/platform/native/electron-main/nativeHostMainService.ts': 'openChildWindow sets devTools after any override (W3)',
	'vs/code/electron-main/qlHost/adopt.ts': 'the webPreferences the windows.ts seam recorded from defaultBrowserWindowOptions (W2)',
	'vs/platform/webContentExtractor/electron-main/webContentExtractorService.ts': 'webPageLoader.ts options (W4)'
};
const unknown = [...new Set(constructions)].filter(path => !(path in KNOWN_CONSTRUCTIONS));
row('W5 every window/view the main process constructs is a named one', constructions.length > 0 && unknown.length === 0,
	`${constructions.length} construction(s) in [${[...new Set(constructions)].join(', ')}]; not named [${unknown.join(', ')}]`);
// The DevTools property of an object literal, and whether it is the last write of that key (after every spread).
const devToolsLast = (literal, label) => {
	if (!literal) {
		return `${label}: not found`;
	}
	const props = literal.properties;
	const index = props.findIndex(prop => ts.isPropertyAssignment(prop) && prop.name.getText() === 'devTools');
	if (index < 0) {
		return `${label}: no devTools property`;
	}
	if (props[index].initializer.getText() !== 'devToolsAllowed()') {
		return `${label}: devTools is \`${props[index].initializer.getText()}\``;
	}
	const later = props.slice(index + 1).filter(prop => ts.isSpreadAssignment(prop) || (ts.isPropertyAssignment(prop) && prop.name.getText() === 'devTools'));
	return later.length === 0 ? 'ok' : `${label}: ${later.length} later spread/devTools write(s)`;
};
const findLiteral = (file, owner, key) => {
	let result;
	visit(parsed.get(join(src, file)) ?? ts.createSourceFile('missing', '', ts.ScriptTarget.Latest), node => {
		if (result === undefined && ts.isPropertyAssignment(node) && node.name.getText() === key && ts.isObjectLiteralExpression(node.initializer)) {
			for (let up = node.parent; up; up = up.parent) {
				if ((ts.isFunctionDeclaration(up) || ts.isMethodDeclaration(up) || ts.isConstructorDeclaration(up)) && up.name?.getText() === owner) {
					result = node.initializer;
					return;
				}
				if (ts.isClassDeclaration(up) && up.name?.getText() === owner) {
					result = node.initializer;
					return;
				}
			}
		}
	});
	return result;
};
let verdict = devToolsLast(findLiteral('vs/platform/windows/electron-main/windows.ts', 'defaultBrowserWindowOptions', 'webPreferences'), 'windows.ts defaultBrowserWindowOptions');
row('W2 defaultBrowserWindowOptions (CodeWindows, child and auxiliary windows, adopted views) writes devTools: devToolsAllowed() after its spread', verdict === 'ok', verdict);
verdict = devToolsLast(findLiteral('vs/platform/native/electron-main/nativeHostMainService.ts', 'openChildWindow', 'webPreferences'), 'nativeHostMainService.ts openChildWindow');
row('W3 openChildWindow writes devTools: devToolsAllowed() after any override\'s webPreferences', verdict === 'ok', verdict);
verdict = devToolsLast(findLiteral('vs/platform/webContentExtractor/electron-main/webPageLoader.ts', 'WebPageLoader', 'webPreferences'), 'webPageLoader.ts');
row('W4 the web content extractor\'s window writes devTools: devToolsAllowed()', verdict === 'ok', verdict);

// The client's terminal host and overlay windows take their DevTools value from the fork's ports (app.ts): false in any built app.
let portsLiteral;
visit(parsed.get(join(src, 'vs/code/electron-main/app.ts')), node => {
	if (portsLiteral === undefined && ts.isVariableDeclaration(node) && node.name.getText() === 'ports' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
		portsLiteral = node.initializer;
	}
});
const portsValue = portsLiteral?.properties.find(prop => ts.isPropertyAssignment(prop) && prop.name.getText() === 'devTools')?.initializer.getText();
row('W6 the terminal host\'s ports give the client devTools false in a built app', portsValue === '!this.environmentMainService.isBuilt', `ports.devTools = ${portsValue === undefined ? '(not found)' : `\`${portsValue}\``}`);

// ---- a PRODUCT bundle
if (bundle) {
	const code = readFileSync(bundle, 'utf8');
	const leftover = (code.match(/QL_TEST_BUILD/g) ?? []).length;
	const body = code.match(/function isProductBundle\(\) \{\s*return ([^;]+);/)?.[1];
	row('B1 the bundle is a PRODUCT bundle: the define reached isProductBundle as false', leftover === 0 && (body === 'false === false' || body === 'true'),
		`${leftover} QL_TEST_BUILD reference(s); isProductBundle returns ${body === undefined ? '(function not found: give the un-minified out-vscode/main.js)' : `\`${body}\``}`);
	const marker = (code.match(/a product build accepts no debugger \(F-HOST-NODEBUG-1\)/g) ?? []).length;
	row('B2 the bundle carries the policy', marker === 1, `${marker} occurrence(s) of the refusal text`);
	// SF3 of review c1: the bundled CALL, not only the function. Exactly one top-level statement calling refuseDebuggers with the
	// app's command line and process.argv, after the argv.json switches are configured and before ready and electron-main's load.
	const bundleLines = code.split('\n');
	const callAt = bundleLines.flatMap((text, i) => /^refuseDebuggers\d*\([\w$]+\.commandLine, process\.argv, [\w$]+, /.test(text) ? [i] : []);
	const configureAt = bundleLines.findIndex(text => /^var [\w$]+ = configureCommandlineSwitchesSync\d*\([\w$]+\);$/.test(text));
	const readyAt = bundleLines.findIndex(text => /^[\w$]+\.once\("ready", /.test(text));
	const loadAt = bundleLines.findIndex(text => /\(init_main\d*\(\), main_exports\d*\)/.test(text));
	row('B3 the bundle CALLS the policy once at top level, after the argv.json switches and before ready and electron-main',
		callAt.length === 1 && configureAt >= 0 && readyAt >= 0 && loadAt >= 0 && configureAt < callAt[0] && callAt[0] < readyAt && callAt[0] < loadAt,
		`${callAt.length} call line(s) [${callAt.map(i => i + 1).join(', ')}]; configure ${configureAt + 1}, ready ${readyAt + 1}, electron-main load ${loadAt + 1} (1-based lines; 0 = not found)`);
	const devBody = code.match(/function devToolsAllowed\d*\(\) \{\s*return ([^;]+);/)?.[1];
	row('B4 the define reached devToolsAllowed as false (PRODUCT windows are created with devTools false)', devBody === 'false' || devBody === 'false !== false',
		`devToolsAllowed returns ${devBody === undefined ? '(function not found)' : `\`${devBody}\``}`);
	const routeCalls = (code.match(/\ballowDevToolsRoute\d*\("/g) ?? []).length;
	const refusalText = (code.match(/a product build opens no DevTools \(F-HOST-NODEBUG-1\)/g) ?? []).length;
	row('B5 the bundle carries every DevTools refusal of the sources (W1) and the refusal text once', routeCalls === sourceRouteCalls && sourceRouteCalls > 0 && refusalText === 1,
		`${routeCalls} allowDevToolsRoute("…") call(s) in the bundle, ${sourceRouteCalls} in the sources; ${refusalText} occurrence(s) of the refusal text`);
}

for (const { line } of rows) {
	console.log(line);
}
const green = rows.filter(({ ok }) => ok).length;
console.log(`SUITE nodebug: ${green === rows.length ? 'PASS' : 'FAIL'} ${green}/${rows.length}`);
process.exit(green === rows.length ? 0 : 1);
