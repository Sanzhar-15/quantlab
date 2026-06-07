/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5-1d-2 -- standalone non-vacuity check for the reactive-kernel dependency PRE-FLIGHT PROBE
// and the hardened spawn-env builder (`out/src/qviz/pythonPath.js`).
//
// The 1d-0 harness already proves the kernel SPAWNS + the reactive chain works under the scrubbed
// env. THIS proves the probe itself is load-bearing: that `verifyPythonModules` actually DETECTS a
// missing module (not always-green) and that `buildReactiveKernelEnv` scrubs the dangerous vars.
// Without this, a probe that returned ok:true unconditionally would pass the harness silently.
//
// Mac-run, env-gated (like the harness):
//   QL_KERNEL_PYTHON=$HOME/.fe15-spike-venv/bin/python3.12 \
//   node test/reactive_kernel_deps.cjs
//
// Exit 0 = every assertion held; exit 1 = a probe assertion failed loud (No-Fallbacks).

'use strict';
const path = require('node:path');
const assert = require('node:assert');

const HERE = __dirname;
const EXT_ROOT = path.resolve(HERE, '..');
const PYTHONPATH_MOD = path.join(EXT_ROOT, 'out', 'src', 'qviz', 'pythonPath.js');
const { buildReactiveKernelEnv, verifyPythonModules } = require(PYTHONPATH_MOD);

// The exact import targets the runtime uses (must mirror REACTIVE_KERNEL_IMPORTS in the factory).
const REQUIRED = [
	'ipykernel_launcher',
	'jupyter_client.kernelspec:KernelSpec',
	'jupyter_client.manager:KernelManager',
	'zmq',
	'comm:create_comm',
];

function goodPython() {
	if (process.env.QL_KERNEL_PYTHON) {
		return process.env.QL_KERNEL_PYTHON;
	}
	throw new Error('set QL_KERNEL_PYTHON to a Python with ipykernel/jupyter_client/pyzmq/comm');
}

function main() {
	// 1) The spawn-env builder scrubs the dangerous vars + disables user site-packages.
	const base = { PATH: '/usr/bin', PYTHONPATH: '/evil/lib', PYTHONHOME: '/evil', PYTHONSTARTUP: '/evil/start.py', KEEP: 'yes' };
	const env = buildReactiveKernelEnv(base);
	assert.strictEqual(env.PYTHONPATH, undefined, 'PYTHONPATH must be scrubbed');
	assert.strictEqual(env.PYTHONHOME, undefined, 'PYTHONHOME must be scrubbed');
	assert.strictEqual(env.PYTHONSTARTUP, undefined, 'PYTHONSTARTUP must be scrubbed');
	assert.strictEqual(env.PYTHONNOUSERSITE, '1', 'PYTHONNOUSERSITE must be set to 1');
	assert.strictEqual(env.KEEP, 'yes', 'unrelated vars must be preserved');
	assert.strictEqual(base.PYTHONPATH, '/evil/lib', 'builder must NOT mutate the caller base env');

	const py = goodPython();
	const spawnEnv = buildReactiveKernelEnv();

	// 2) The good interpreter PASSES with all required modules (under the scrubbed env).
	const ok = verifyPythonModules(py, REQUIRED, spawnEnv);
	assert.strictEqual(ok.ok, true, `good interpreter must pass the probe, got ${JSON.stringify(ok)}`);

	// 3) Non-vacuity: a top-level module that does NOT exist is reported missing (probe is load-bearing).
	const fake = verifyPythonModules(py, ['zmq', 'definitely_not_a_real_module_xyz'], spawnEnv);
	assert.strictEqual(fake.ok, false, 'a missing module must fail the probe');
	assert.ok(
		fake.missing.includes('definitely_not_a_real_module_xyz'),
		`the missing module must be named, got ${JSON.stringify(fake.missing)}`,
	);
	assert.ok(!fake.missing.includes('zmq'), 'a present module must NOT be reported missing');

	// 4) Codex MED-2: a missing SUBMODULE of a present package is caught -- find_spec on the parent
	//    alone would have green-lit a partial/broken install; a real import does not.
	const subMissing = verifyPythonModules(py, ['jupyter_client.__no_such_submodule__'], spawnEnv);
	assert.strictEqual(subMissing.ok, false, 'a missing submodule of a present package must fail');
	assert.ok(
		subMissing.missing.includes('jupyter_client.__no_such_submodule__'),
		`the missing submodule must be named, got ${JSON.stringify(subMissing.missing)}`,
	);

	// 5) Codex MED-2: a missing ATTRIBUTE on a present module is caught (the "module:attr" form). `os`
	//    imports fine but lacks `__no_such_attr__`, so only the attr entry is reported missing.
	const attrMissing = verifyPythonModules(py, ['os', 'os:__no_such_attr__'], spawnEnv);
	assert.strictEqual(attrMissing.ok, false, 'a missing attribute must fail the probe');
	assert.deepStrictEqual(
		attrMissing.missing, ['os:__no_such_attr__'],
		`only the missing attr entry must be reported, got ${JSON.stringify(attrMissing.missing)}`,
	);

	// 6) A non-existent interpreter fails loud with an error (not a silent pass).
	const broken = verifyPythonModules('/no/such/python-xyz', REQUIRED, spawnEnv);
	assert.strictEqual(broken.ok, false, 'a non-runnable interpreter must fail the probe');
	assert.ok(broken.error !== undefined, 'a non-runnable interpreter must carry an error message');

	console.log('[reactive-kernel-deps 1d-2] PASS -- dep probe + spawn-env builder verified');
	console.log('  env    scrub PYTHONPATH/PYTHONHOME/PYTHONSTARTUP + PYTHONNOUSERSITE=1, base unmutated');
	console.log('  ok     good interpreter passes (real imports + attrs: ipykernel_launcher/jupyter_client.*/zmq/comm.create_comm) under the scrub');
	console.log('  miss   a fake top-level module is reported missing (load-bearing, not always-green)');
	console.log('  sub    a missing SUBMODULE of a present package is caught (real import, not find_spec)');
	console.log('  attr   a missing ATTRIBUTE on a present module is caught (the module:attr form)');
	console.log('  broken a non-runnable interpreter fails with an error (no silent pass)');
	process.exit(0);
}

main();
