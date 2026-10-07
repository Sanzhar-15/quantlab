/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FEATURES closing checks (PLAN-FINAL 3.9): launches the packaged app twice on fresh profiles -- the
// app itself, then a copy with one pinned extension removed (the negative control) -- with the driver
// extension in ./driver running the checks inside the extension host. The steps the extension host
// cannot take (the Action view's form, a modal's button) the driver hands to the window driver here
// (cues.cjs, window.mjs over CDP). The extension-pack row adds a plain first start, observed from outside
// (logs, the profile, the toasts), and its control. Afterwards no process of a launched bundle may be left. Started by run.sh.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { connect, waitForEndpoint } from './cdp.mjs';
import * as net from 'node:net';
import { assemble, assertNoAsarEnvAbsent, checkIdsFor, DIALOG_MODES, driverArgs, findBuiltInExtensionDir, galleryHosts, judgePackQuiet, judgePackRow, judgePinnedDependency, judgeQuantbookMcpAbsent, MOCK_KEYCHAIN, PACK_OWNERS, packMembers, PINNED_IDS, processesInside, readForkSha, readPins, requestUrls, sha256File, treeDigest } from './lib.mjs';
import { backtestForm, pressModal, readToasts, waitForWorkbench } from './window.mjs';

// This process only: Electron's asar-patched fs refuses to read a FILE named *.asar as bytes (ENOENT ", not found in
// .../node_modules.asar"), and the app-tree digest (treeDigest, lib.mjs) hashes every file of the bundle. The digest
// wants the bytes on disk: an .asar under the bundle is a file to hash here, not an archive to open. Set before any
// fs call (the imports above only define functions; none touches fs while loading). It is never passed on: the app
// launches get no ELECTRON_NO_ASAR, and the launcher refuses to run if its own environment has one (below).
// Under plain node (lib.test.mjs) the property is unused.
process.noAsar = true;

const { serve } = createRequire(import.meta.url)('./cues.cjs');

const here = import.meta.dirname;
const [app, evidence, network] = process.argv.slice(2);
const REMOVED_IN_CONTROL = 'detachhead.basedpyright';
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const PACK_ACTIVATION_MS = 3 * 60 * 1000;
const PACK_SETTLE_MS = 60 * 1000;
// One CDP request's answer, and the connection's opening (cdp.mjs): every function the window driver evaluates is synchronous.
const CDP_ANSWER_MS = 30 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now();

function fail(message) {
	console.error(message);
	process.exit(1);
}

function appPaths(bundle) {
	const name = cp.execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
	const resources = path.join(bundle, 'Contents', 'Resources', 'app');
	return { exe: path.join(bundle, 'Contents', 'MacOS', name), product: path.join(resources, 'product.json'), extensions: path.join(resources, 'extensions') };
}

/**
 * One launch on a fresh profile under `dir`, with the window driver answering the driver's cues over
 * CDP while the app runs. Resolves to the driver's result object. A DIALOG_MODES launch has no extension
 * tests to end it: once the driver has written its result the window driver closes the browser.
 */
async function launch(bundle, dir, mode, python, network) {
	const userData = path.join(dir, 'user-data');
	const workspace = path.join(dir, 'workspace');
	fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'extensions'));
	fs.mkdirSync(path.join(dir, 'home'));
	fs.cpSync(path.join(here, 'fixtures', 'workspace'), workspace, { recursive: true });
	fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
		'python.defaultInterpreterPath': python,
		'window.dialogStyle': 'custom',
		'telemetry.telemetryLevel': 'off',
		'extensions.autoUpdate': false,
		'extensions.autoCheckUpdates': false,
		'update.mode': 'none',
	}, undefined, '\t'));
	const resultPath = path.join(dir, 'driver-result.json');
	const cues = path.join(dir, 'cues');
	fs.mkdirSync(cues);
	const logPath = path.join(dir, 'app-output.log');
	const log = fs.openSync(logPath, 'w');
	const env = { ...process.env, HOME: path.join(dir, 'home'), QL_FEATURES_RESULT: resultPath, QL_FEATURES_MODE: mode, QL_FEATURES_PYTHON: python, QL_FEATURES_CUES: cues, QL_FEATURES_USER_DATA: userData, QL_FEATURES_NETWORK: network };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = cp.spawn(appPaths(bundle).exe, [
		workspace,
		MOCK_KEYCHAIN,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${path.join(dir, 'extensions')}`,
		...driverArgs(mode, path.join(here, 'driver')),
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		// Request-service trace lines: the extension-pack row reads them (lib.mjs requestUrls).
		'--log', 'trace',
		// The window driver's endpoint; the app prints it as "DevTools listening on ws://..." (cdp.mjs).
		'--remote-debugging-port=0',
	], { env, stdio: ['ignore', log, log] });
	let exited = false;
	let timedOut = false;
	const exit = new Promise(resolve => {
		child.on('error', error => { exited = true; resolve({ error }); });
		child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
	});
	const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
	let cdp;
	const window = async () => cdp ??= await connect(await waitForEndpoint(logPath, 60_000), CDP_ANSWER_MS);
	const served = serve(cues, {
		'backtest-form': async args => backtestForm(await window(), args),
		'import-modal': async args => pressModal(await window(), args),
		'trust-modal': async args => pressModal(await window(), args),
		'toasts': async () => ({ texts: await readToasts(await window()) }),
	}, () => exited).then(names => ({ names }), err => ({ error: err instanceof Error ? err.message : String(err) }));
	let closeError;
	const closed = !DIALOG_MODES.includes(mode) ? Promise.resolve() : (async () => {
		while (!exited && !fs.existsSync(resultPath)) {
			await sleep(1000);
		}
		if (exited) {
			return;
		}
		await (await window()).send('Browser.close').catch(err => { closeError = err.message; });
		const how = await Promise.race([exit.then(() => 'exited'), sleep(30_000).then(() => 'timeout')]);
		if (how === 'timeout') {
			closeError = `the app did not exit 30 s after Browser.close${closeError === undefined ? '' : ` (${closeError})`}`;
			child.kill('SIGKILL');
		}
	})().catch(err => { closeError = err instanceof Error ? err.message : String(err); child.kill('SIGKILL'); });
	const result = await exit;
	clearTimeout(timer);
	await closed;
	const cueService = await served;
	cdp?.close();
	fs.closeSync(log);
	if (result.error) {
		return { launchError: `[app_launch_failed] ${mode}: ${result.error.message}` };
	}
	if (timedOut) {
		return { launchError: `[app_timeout] ${mode}: killed after ${RUN_TIMEOUT_MS / 1000} s (see ${logPath})` };
	}
	if (cueService.error) {
		return { launchError: `[window_driver_failed] ${mode}: ${cueService.error}` };
	}
	if (closeError !== undefined) {
		return { launchError: `[app_no_exit] ${mode}: ${closeError} (see ${logPath})` };
	}
	if (!fs.existsSync(resultPath)) {
		return { launchError: `[driver_no_result] ${mode}: the app exited with ${result.code ?? result.signal} and the driver wrote no result (see ${logPath})` };
	}
	const written = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
	if (written.driverError !== undefined) {
		return { launchError: `[driver_failed] ${mode}: ${written.driverError}` };
	}
	return { ...written, exit: result.code ?? result.signal, cuesAnswered: cueService.names };
}

/** Every *.log file under `dir`; a logs directory the app has not created yet holds none. */
function logFiles(dir) {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter(entry => entry.isFile() && entry.name.endsWith('.log'))
		.map(entry => path.join(entry.parentPath, entry.name));
}

/** The extensions the extension host log says it activated (extHostExtensionService.ts), lowercased. */
function activatedIn(userData) {
	const ids = new Set();
	for (const file of logFiles(path.join(userData, 'logs')).filter(f => path.basename(f) === 'exthost.log')) {
		for (const match of fs.readFileSync(file, 'utf8').matchAll(/ExtensionService#_doActivateExtension ([^,\s]+),/g)) {
			ids.add(match[1].toLowerCase());
		}
	}
	return [...ids];
}

/** What a launch left in its profile and logs: extensions installed into its --extensions-dir, request URLs, trace lines. */
function observeProfile(dir) {
	const installed = fs.readdirSync(path.join(dir, 'extensions'), { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => (/^(.+?)-\d+\.\d+\.\d+/.exec(entry.name)?.[1] ?? entry.name).toLowerCase());
	let text = '';
	for (const file of logFiles(path.join(dir, 'user-data', 'logs'))) {
		text += fs.readFileSync(file, 'utf8');
	}
	return { installed, requests: requestUrls(text), traceLines: text.split('\n').filter(line => line.includes('[trace]')).length };
}

/**
 * The app's first start as a user gets it: a fresh profile with no settings, no driver extension (extension
 * development mode turns recommendations off, extensionRecommendationsService.ts), the fixture's .py and .ipynb
 * open. Toasts are read over CDP until both PACK_OWNERS are activated and PACK_SETTLE_MS more; then the browser closes.
 */
async function plainLaunch(bundle, dir) {
	const userData = path.join(dir, 'user-data');
	const workspace = path.join(dir, 'workspace');
	fs.mkdirSync(userData, { recursive: true });
	fs.mkdirSync(path.join(dir, 'extensions'));
	fs.mkdirSync(path.join(dir, 'home'));
	fs.cpSync(path.join(here, 'fixtures', 'workspace'), workspace, { recursive: true });
	const logPath = path.join(dir, 'app-output.log');
	const log = fs.openSync(logPath, 'w');
	const env = { ...process.env, HOME: path.join(dir, 'home') };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = cp.spawn(appPaths(bundle).exe, [
		workspace,
		path.join(workspace, 'sample.py'),
		path.join(workspace, 'fixture.ipynb'),
		MOCK_KEYCHAIN,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${path.join(dir, 'extensions')}`,
		'--log', 'trace',
		// The trust modal would hold activation; a user answers it, this launch has no driver to.
		'--disable-workspace-trust',
		'--remote-debugging-port=0',
	], { env, stdio: ['ignore', log, log] });
	let exited = false;
	const exit = new Promise(resolve => {
		child.on('error', error => { exited = true; resolve({ error }); });
		child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
	});
	// As in launch(): no launch outlives RUN_TIMEOUT_MS, whatever the steps below are waiting for.
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
	const toasts = new Set();
	let launchError;
	let cdp;
	try {
		cdp = await connect(await waitForEndpoint(logPath, 60_000), CDP_ANSWER_MS);
		await waitForWorkbench(cdp, 120_000);
		const poll = async () => {
			for (const text of await readToasts(cdp)) {
				toasts.add(text);
			}
		};
		const activationDeadline = Date.now() + PACK_ACTIVATION_MS;
		let activated = activatedIn(userData);
		while (PACK_OWNERS.some(id => !activated.includes(id))) {
			if (exited) {
				throw new Error(`[app_exited_early] the app exited before ${PACK_OWNERS.join(' and ')} activated (see ${logPath})`);
			}
			if (Date.now() > activationDeadline) {
				throw new Error(`[pack_owner_inactive] after ${PACK_ACTIVATION_MS / 1000} s the extension host log shows [${activated.join(', ')}] activated, not all of ${PACK_OWNERS.join(', ')}`);
			}
			await poll();
			await sleep(2000);
			activated = activatedIn(userData);
		}
		const settled = Date.now() + PACK_SETTLE_MS;
		while (Date.now() < settled) {
			await poll();
			await sleep(2000);
		}
		const closing = cdp.send('Browser.close').then(() => 'answered', err => err.message);
		const how = await Promise.race([exit.then(() => 'exited'), sleep(30_000).then(() => 'timeout')]);
		if (how === 'timeout') {
			throw new Error(`[app_no_exit] the app did not exit 30 s after Browser.close (${await Promise.race([closing, sleep(1000).then(() => 'no answer')])})`);
		}
	} catch (err) {
		launchError = `[pack_launch_failed] ${err instanceof Error ? err.message : String(err)}`;
		child.kill('SIGKILL');
	}
	const result = await exit;
	clearTimeout(timer);
	cdp?.close();
	fs.closeSync(log);
	if (result.error) {
		return { launchError: `[app_launch_failed] pack: ${result.error.message}` };
	}
	if (timedOut) {
		return { launchError: `[app_timeout] pack: killed after ${RUN_TIMEOUT_MS / 1000} s (see ${logPath})` };
	}
	if (launchError !== undefined) {
		return { launchError };
	}
	return { toasts: [...toasts], ...observeProfile(dir) };
}

/** The network-on run's precondition: the gallery host answers a TCP connection. */
function networkOn() {
	return new Promise(resolve => {
		const socket = net.connect({ host: 'open-vsx.org', port: 443 });
		const done = (status, detail) => { socket.destroy(); resolve({ id: 'network-on', status, detail }); };
		socket.setTimeout(8000);
		socket.on('connect', () => done('PASS', 'a TCP connection to open-vsx.org:443 succeeded'));
		socket.on('timeout', () => done('FAIL', '[network_off] open-vsx.org:443 did not answer in 8 s; the network-on run is void'));
		socket.on('error', err => done('FAIL', `[network_off] open-vsx.org:443 unreachable (${err.code}); the network-on run is void`));
	});
}

/** After the launches: no process of either bundle may be left running (INTEG's guest rule). */
async function noProcessLeft(bundles) {
	const deadline = Date.now() + 15_000;
	let left = [];
	while (Date.now() < deadline) {
		left = processesInside(cp.execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }), bundles, process.pid);
		if (left.length === 0) {
			return { id: 'no-process-left', status: 'PASS', detail: `no process of ${bundles.length} launched bundle(s) running 0-15 s after exit` };
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	for (const { pid } of left) {
		process.kill(pid, 'SIGKILL');
	}
	return { id: 'no-process-left', status: 'FAIL', detail: `[process_left] still running 15 s after the app exited (killed now): ${left.map(p => `${p.pid} ${p.command}`).join(' | ')}` };
}

try {
	assertNoAsarEnvAbsent(process.env);
} catch (err) {
	fail(err.message);
}
if (app === undefined || evidence === undefined || (network !== 'off' && network !== 'on')) {
	fail('usage: run.sh <path to the .app bundle> <evidence dir that does not exist yet> <off|on: the guest network>');
}
const ids = checkIdsFor(network);
fs.mkdirSync(evidence, { recursive: false });
const out = { runner: 'features-closing', startedAt: new Date(started).toISOString(), inputs: {}, preconditions: [], checks: [], postconditions: [], rc: 1 };
const launched = [];
const write = () => fs.writeFileSync(path.join(evidence, 'features-closing.json'), JSON.stringify(out, undefined, '\t') + '\n');

try {
	const paths = appPaths(app);
	const product = JSON.parse(fs.readFileSync(paths.product, 'utf8'));
	out.inputs.app = path.resolve(app);
	out.inputs.network = network;
	out.inputs.forkSha = readForkSha(product);
	out.inputs.pins = readPins(product);
	out.inputs.scriptSha = cp.execFileSync('git', ['-C', here, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	out.inputs.appTree = treeDigest(app);
	out.inputs.fixtures = Object.fromEntries(fs.readdirSync(path.join(here, 'fixtures', 'workspace')).sort().map(name => [name, sha256File(path.join(here, 'fixtures', 'workspace', name))]));

	// The declared interpreter is a requirement, never searched for.
	const python = process.env.QL_FEATURES_PYTHON;
	if (!python || !path.isAbsolute(python) || !fs.existsSync(python)) {
		throw new Error(`[interpreter_not_declared] QL_FEATURES_PYTHON must name an existing interpreter by absolute path (got ${JSON.stringify(python)})`);
	}
	const probe = cp.spawnSync(python, ['-c', 'import sys, ipykernel; print(sys.version.split()[0], ipykernel.__version__)'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		throw new Error(`[interpreter_without_ipykernel] ${python} cannot import ipykernel: ${String(probe.stderr).trim()}`);
	}
	out.inputs.python = { path: python, versions: probe.stdout.trim() };
	out.preconditions.push({ id: 'declared-interpreter', status: 'PASS', detail: `${python} (${probe.stdout.trim()})` });
	write();

	launched.push(path.resolve(app));
	const checks = {};
	if (network === 'off') {
		// 1. The app itself: every check.
		const main = await launch(app, path.join(evidence, 'main'), 'all', python, network);
		// The import needs its modal: its own launch, without the extension tests (DIALOG_MODES).
		const imported = await launch(app, path.join(evidence, 'import'), 'import', python, network);
		// 2. The negative control: a copy of the app without one pinned extension; only the pin report is read.
		const copy = path.join(evidence, 'control', path.basename(app));
		fs.mkdirSync(path.join(evidence, 'control'));
		cp.execFileSync('/bin/cp', ['-R', app, copy]);
		fs.rmSync(findBuiltInExtensionDir(appPaths(copy).extensions, REMOVED_IN_CONTROL), { recursive: true });
		launched.push(path.resolve(copy));
		const control = await launch(copy, path.join(evidence, 'control', 'run'), 'pins', python, network);

		out.preconditions.push(main.launchError
			? { id: 'network-off', status: 'FAIL', detail: main.launchError }
			: main.network);
		Object.assign(checks, main.launchError ? {} : main.checks);
		if (main.launchError) {
			for (const id of ['backtest-bundled-engine', 'python-intelligence', 'notebook-cell']) {
				checks[id] = { status: 'FAIL', detail: main.launchError };
			}
		}
		checks.import = imported.launchError ? { status: 'FAIL', detail: imported.launchError } : imported.checks.import;
		checks['pinned-dependency-removed'] = control.launchError
			? { status: 'FAIL', detail: control.launchError }
			: judgePinnedDependency(main.pins, control.pins, REMOVED_IN_CONTROL);
		// 3. The packaged app's files: no Quantbook MCP server ships.
		checks['quantbook-mcp-absent'] = judgeQuantbookMcpAbsent(paths.extensions);
	} else {
		out.preconditions.push(await networkOn());
	}

	// 4. The extension-pack row, with the network as declared: the plain first start, then its control.
	const members = packMembers(paths.extensions);
	const hosts = galleryHosts(product);
	out.inputs.packMembers = members;
	out.inputs.galleryHosts = hosts;
	const quiet = await plainLaunch(app, path.join(evidence, 'pack'));
	const triggerDir = path.join(evidence, 'pack-control');
	const trigger = await launch(app, triggerDir, 'pack-trigger', python, network);
	if (quiet.launchError) {
		checks['extension-pack-quiet'] = { status: 'FAIL', detail: quiet.launchError };
	} else if (trigger.launchError) {
		checks['extension-pack-quiet'] = { status: 'FAIL', detail: `[control_failed] ${trigger.launchError}` };
	} else {
		checks['extension-pack-quiet'] = judgePackRow(network,
			judgePackQuiet({ members, hosts, ...quiet }),
			judgePackQuiet({ members, hosts, toasts: trigger.packTrigger.toasts, ...observeProfile(triggerDir) }));
		checks['extension-pack-quiet'].detail += ` (control install: ${trigger.packTrigger.install})`;
	}
	const assembled = assemble(checks, ids);
	out.checks = assembled.checks;
	// A precondition that is not PASS (the network is on, no interpreter) voids the run whatever the checks say.
	out.rc = assembled.rc === 0 && out.preconditions.every(p => p !== undefined && p.status === 'PASS') ? 0 : 1;
} catch (err) {
	out.preconditions.push({ id: 'runner', status: 'FAIL', detail: err instanceof Error ? err.message : String(err) });
	out.checks = assemble({}, ids).checks.map(check => ({ ...check, status: 'NOT RUN', detail: 'the runner stopped before this check' }));
	out.rc = 1;
}
// Whatever happened above, every bundle launched must have left no process behind.
if (launched.length > 0) {
	out.postconditions.push(await noProcessLeft(launched));
	if (out.postconditions[0].status !== 'PASS') {
		out.rc = 1;
	}
}
out.wallSeconds = Math.round((Date.now() - started) / 1000);
out.pinnedIds = PINNED_IDS;
write();
for (const line of [...out.preconditions, ...out.checks, ...out.postconditions]) {
	console.log(`${line.status.padEnd(7)} ${line.id}: ${line.detail}`);
}
process.exit(out.rc);
