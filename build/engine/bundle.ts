/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Quantlab Python engine packaging (QL-ENGINE-PKG).
//
// `bundle-quantlab-engine` runs build/python/bundle.py (PyInstaller, --onedir) and records what it
// built. `quantlabEngineStream` hands that bundle to the packaging task at the layout the extension
// resolves in a packaged app: <extension root>/engine/quantlab-engine/<exe>
// (extensions/quantlab/src/core/engine/EngineHost.ts, resolveBundledPython).

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import gulp from 'gulp';
import es from 'event-stream';
import rename from 'gulp-rename';
import * as task from '../lib/task.ts';

const root = path.dirname(path.dirname(import.meta.dirname));
const bundleRoot = path.join(root, '.build', 'quantlab-engine');
const bundleDir = path.join(bundleRoot, 'quantlab-engine');
const recordPath = path.join(bundleRoot, 'bundle.json');
const packagedDir = 'extensions/quantlab/engine';

interface IEngineBundleRecord {
	readonly platform: string;
	readonly arch: string;
	readonly exe: string;
	readonly sha256: string;
}

// `platform.machine()` of the bundling interpreter -> the packaging target's arch name.
const machineToArch: Record<string, string> = {
	'arm64': 'arm64',
	'aarch64': 'arm64',
	'ARM64': 'arm64',
	'x86_64': 'x64',
	'AMD64': 'x64',
	'armv7l': 'armhf',
};

function exeName(platform: string): string {
	return platform === 'win32' ? 'quantlab-engine.exe' : 'quantlab-engine';
}

function sha256(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command: string, args: string[], stdio: cp.StdioOptions): cp.SpawnSyncReturns<string> {
	const result = cp.spawnSync(command, args, { cwd: root, stdio, encoding: 'utf8' });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`[quantlab-engine] ${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
	}
	return result;
}

export const bundleQuantlabEngineTask = task.define('bundle-quantlab-engine', async () => {
	const python = process.env['QUANTLAB_ENGINE_PYTHON'];
	if (!python) {
		throw new Error('[quantlab-engine] QUANTLAB_ENGINE_PYTHON is not set: name the interpreter of an environment that holds PyInstaller and the engine\'s dependencies');
	}

	const machine = run(python, ['-c', 'import platform; print(platform.machine())'], ['ignore', 'pipe', 'inherit']).stdout.trim();
	const arch = machineToArch[machine];
	if (!arch) {
		throw new Error(`[quantlab-engine] ${python} reports machine '${machine}', which maps to no packaging arch`);
	}

	// PyInstaller builds for the interpreter it runs under, never for another target.
	await fs.promises.rm(bundleRoot, { recursive: true, force: true });
	run(python, [path.join(root, 'build', 'python', 'bundle.py'), '--output', bundleRoot], 'inherit');

	const exe = path.join(bundleDir, exeName(process.platform));
	const record: IEngineBundleRecord = {
		platform: process.platform,
		arch,
		exe: path.relative(bundleRoot, exe),
		sha256: sha256(exe),
	};
	await fs.promises.writeFile(recordPath, JSON.stringify(record, undefined, '\t') + '\n');
	console.log(`[quantlab-engine] bundled ${record.platform}-${record.arch} ${record.exe} sha256 ${record.sha256}`);
});

/**
 * The bundled engine as packaging sources, placed under `extensions/quantlab/engine/`.
 * A missing, stale or wrong-target bundle fails the packaging. A TEST build (`QL_TEST_BUILD=1`)
 * may ask by name to be packaged without the engine (`QUANTLAB_ENGINE_BUNDLE=skip`); any other
 * packaging is a shipping configuration and refuses the skip.
 */
export function quantlabEngineStream(platform: string, arch: string): NodeJS.ReadWriteStream {
	if (process.env['QUANTLAB_ENGINE_BUNDLE'] === 'skip') {
		if (process.env['QL_TEST_BUILD'] !== '1') {
			throw new Error(`[quantlab-engine] QUANTLAB_ENGINE_BUNDLE=skip is refused for ${platform}-${arch}: only a test build (QL_TEST_BUILD=1) may be packaged without the Python engine`);
		}
		console.warn(`[quantlab-engine] QUANTLAB_ENGINE_BUNDLE=skip: packaging ${platform}-${arch} WITHOUT the Python engine (${packagedDir}/ will be absent)`);
		return es.readArray([]);
	}

	if (!fs.existsSync(recordPath)) {
		throw new Error(`[quantlab-engine] no bundle record at ${recordPath}: run the gulp task 'bundle-quantlab-engine' first, or, for a test build only (QL_TEST_BUILD=1), set QUANTLAB_ENGINE_BUNDLE=skip`);
	}
	const record: IEngineBundleRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
	if (record.platform !== platform || record.arch !== arch) {
		throw new Error(`[quantlab-engine] the bundle at ${bundleRoot} is ${record.platform}-${record.arch}, the packaging target is ${platform}-${arch}`);
	}
	const actual = sha256(path.join(bundleRoot, record.exe));
	if (actual !== record.sha256) {
		throw new Error(`[quantlab-engine] ${record.exe} has sha256 ${actual}, the bundle step recorded ${record.sha256}`);
	}

	return gulp.src('.build/quantlab-engine/quantlab-engine/**', { base: '.build/quantlab-engine', dot: true })
		.pipe(rename(file => { file.dirname = path.posix.join(packagedDir, file.dirname!.replace(/\\/g, '/')); }));
}
