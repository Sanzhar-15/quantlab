/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FEATURES closing checks (PLAN-FINAL 3.9): launches the packaged app twice on fresh profiles -- the
// app itself, then a copy with one pinned extension removed (the negative control) -- with the driver
// extension in ./driver running the checks inside the extension host. The steps the extension host
// cannot take (the Action view's form, a modal's button) the driver hands to the window driver here
// (cues.cjs, window.mjs over CDP). Afterwards no process of a launched bundle may be left. Started by run.sh.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { connect, waitForEndpoint } from './cdp.mjs';
import { assemble, findBuiltInExtensionDir, judgePinnedDependency, PINNED_IDS, processesInside, readForkSha, readPins, sha256File, treeDigest } from './lib.mjs';
import { backtestForm, importModal } from './window.mjs';

const { serve } = createRequire(import.meta.url)('./cues.cjs');

const here = import.meta.dirname;
const [app, evidence] = process.argv.slice(2);
const REMOVED_IN_CONTROL = 'detachhead.basedpyright';
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
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
 * CDP while the app runs. Resolves to the driver's result object.
 */
async function launch(bundle, dir, mode, python) {
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
	const env = { ...process.env, HOME: path.join(dir, 'home'), QL_FEATURES_RESULT: resultPath, QL_FEATURES_MODE: mode, QL_FEATURES_PYTHON: python, QL_FEATURES_CUES: cues, QL_FEATURES_USER_DATA: userData };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = cp.spawn(appPaths(bundle).exe, [
		workspace,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${path.join(dir, 'extensions')}`,
		`--extensionDevelopmentPath=${path.join(here, 'driver')}`,
		`--extensionTestsPath=${path.join(here, 'driver', 'checks.cjs')}`,
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
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
	const window = async () => cdp ??= await connect(await waitForEndpoint(logPath, 60_000));
	const served = serve(cues, {
		'backtest-form': async args => backtestForm(await window(), args),
		'import-modal': async args => importModal(await window(), args),
	}, () => exited).then(names => ({ names }), err => ({ error: err instanceof Error ? err.message : String(err) }));
	const result = await exit;
	clearTimeout(timer);
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
	if (!fs.existsSync(resultPath)) {
		return { launchError: `[driver_no_result] ${mode}: the app exited with ${result.code ?? result.signal} and the driver wrote no result (see ${logPath})` };
	}
	return { ...JSON.parse(fs.readFileSync(resultPath, 'utf8')), exit: result.code ?? result.signal, cuesAnswered: cueService.names };
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

if (app === undefined || evidence === undefined) {
	fail('usage: run.sh <path to the .app bundle> <evidence dir that does not exist yet>');
}
fs.mkdirSync(evidence, { recursive: false });
const out = { runner: 'features-closing', startedAt: new Date(started).toISOString(), inputs: {}, preconditions: [], checks: [], postconditions: [], rc: 1 };
const launched = [];
const write = () => fs.writeFileSync(path.join(evidence, 'features-closing.json'), JSON.stringify(out, undefined, '\t') + '\n');

try {
	const paths = appPaths(app);
	const product = JSON.parse(fs.readFileSync(paths.product, 'utf8'));
	out.inputs.app = path.resolve(app);
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

	// 1. The app itself: every check.
	launched.push(path.resolve(app));
	const main = await launch(app, path.join(evidence, 'main'), 'all', python);
	// 2. The negative control: a copy of the app without one pinned extension; only the pin report is read.
	const copy = path.join(evidence, 'control', path.basename(app));
	fs.mkdirSync(path.join(evidence, 'control'));
	cp.execFileSync('/bin/cp', ['-R', app, copy]);
	fs.rmSync(findBuiltInExtensionDir(appPaths(copy).extensions, REMOVED_IN_CONTROL), { recursive: true });
	launched.push(path.resolve(copy));
	const control = await launch(copy, path.join(evidence, 'control', 'run'), 'pins', python);

	out.preconditions.push(main.launchError
		? { id: 'network-off', status: 'FAIL', detail: main.launchError }
		: main.network);
	const checks = main.launchError ? {} : { ...main.checks };
	if (main.launchError) {
		for (const id of ['backtest-bundled-engine', 'python-intelligence', 'notebook-cell', 'import']) {
			checks[id] = { status: 'FAIL', detail: main.launchError };
		}
	}
	checks['pinned-dependency-removed'] = control.launchError
		? { status: 'FAIL', detail: control.launchError }
		: judgePinnedDependency(main.pins, control.pins, REMOVED_IN_CONTROL);
	const assembled = assemble(checks);
	out.checks = assembled.checks;
	// A precondition that is not PASS (the network is on, no interpreter) voids the run whatever the checks say.
	out.rc = assembled.rc === 0 && out.preconditions.every(p => p !== undefined && p.status === 'PASS') ? 0 : 1;
} catch (err) {
	out.preconditions.push({ id: 'runner', status: 'FAIL', detail: err instanceof Error ? err.message : String(err) });
	out.checks = assemble({}).checks.map(check => ({ ...check, status: 'NOT RUN', detail: 'the runner stopped before this check' }));
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
