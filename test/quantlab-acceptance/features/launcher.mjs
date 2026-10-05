/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FEATURES closing checks (PLAN-FINAL 3.9): launches the packaged app twice on fresh profiles -- the
// app itself, then a copy with one pinned extension removed (the negative control) -- with the driver
// extension in ./driver running the checks inside the extension host. Started by run.sh.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assemble, findBuiltInExtensionDir, judgePinnedDependency, PINNED_IDS, readForkSha, readPins, sha256File, treeDigest } from './lib.mjs';

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

/** One launch on a fresh profile under `dir`. Resolves to the driver's result object. */
function launch(bundle, dir, mode, python) {
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
	const log = fs.openSync(path.join(dir, 'app-output.log'), 'w');
	const env = { ...process.env, HOME: path.join(dir, 'home'), QL_FEATURES_RESULT: resultPath, QL_FEATURES_MODE: mode, QL_FEATURES_PYTHON: python };
	delete env.ELECTRON_RUN_AS_NODE;
	const result = cp.spawnSync(appPaths(bundle).exe, [
		workspace,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${path.join(dir, 'extensions')}`,
		`--extensionDevelopmentPath=${path.join(here, 'driver')}`,
		`--extensionTestsPath=${path.join(here, 'driver', 'checks.cjs')}`,
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
	], { env, stdio: ['ignore', log, log], timeout: RUN_TIMEOUT_MS });
	fs.closeSync(log);
	if (result.error) {
		return { launchError: `[app_launch_failed] ${mode}: ${result.error.message}` };
	}
	if (!fs.existsSync(resultPath)) {
		return { launchError: `[driver_no_result] ${mode}: the app exited with ${result.status ?? result.signal} and the driver wrote no result (see ${path.join(dir, 'app-output.log')})` };
	}
	return { ...JSON.parse(fs.readFileSync(resultPath, 'utf8')), exit: result.status ?? result.signal };
}

if (app === undefined || evidence === undefined) {
	fail('usage: run.sh <path to the .app bundle> <evidence dir that does not exist yet>');
}
fs.mkdirSync(evidence, { recursive: false });
const out = { runner: 'features-closing', startedAt: new Date(started).toISOString(), inputs: {}, preconditions: [], checks: [], rc: 1 };
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
	const main = launch(app, path.join(evidence, 'main'), 'all', python);
	// 2. The negative control: a copy of the app without one pinned extension; only the pin report is read.
	const copy = path.join(evidence, 'control', path.basename(app));
	fs.mkdirSync(path.join(evidence, 'control'));
	cp.execFileSync('/bin/cp', ['-R', app, copy]);
	fs.rmSync(findBuiltInExtensionDir(appPaths(copy).extensions, REMOVED_IN_CONTROL), { recursive: true });
	const control = launch(copy, path.join(evidence, 'control', 'run'), 'pins', python);

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
out.wallSeconds = Math.round((Date.now() - started) / 1000);
out.pinnedIds = PINNED_IDS;
write();
for (const line of [...out.preconditions, ...out.checks]) {
	console.log(`${line.status.padEnd(7)} ${line.id}: ${line.detail}`);
}
process.exit(out.rc);
