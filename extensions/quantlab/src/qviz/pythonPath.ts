/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Python interpreter resolver shared by qviz extension-host code.
 *
 * Mirrors `EngineHost.resolvePythonPath()` but is exported as a stand-
 * alone function so the daemon-lifecycle owner (extension activation)
 * doesn't have to instantiate `EngineHost`.
 *
 * Lookup order (matches the implementation):
 *
 *   1. `process.env.QUANTLAB_PYTHON` — highest priority. Test / CI
 *      override; explicit user intent. If this points at a path that
 *      doesn't exist or isn't executable, the resolver FAILS LOUDLY
 *      (returns null without falling through) — an explicit override
 *      should not be silently demoted (Step C megaudit PP1 fix).
 *   2. `quantlab.pythonPath` setting (Quantlab-specific override).
 *   3. `python.defaultInterpreterPath` setting (VS Code Python extension).
 *   4. Managed venv:
 *        - POSIX: `~/.quantlab/venv/bin/python`
 *        - Windows: `~/.quantlab/venv/Scripts/python.exe`
 *
 * Returns `null` when no Python is available -- callers MUST handle
 * the null case explicitly (CLAUDE.md "no fallbacks": don't substitute
 * a generic `python3` without knowing the daemon will work).
 *
 * No vscode imports here so the function is testable from plain mocha.
 *
 * Step C megaudit PP3: the executable check now requires `isFile()`
 * AND `X_OK`. Bare `accessSync(X_OK)` accepts directories (an
 * executable directory satisfies X_OK on POSIX), which would later
 * cause `child_process.spawn(directoryPath)` to fail confusingly.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface ResolvedPython {
	readonly pythonPath: string;
	readonly source: 'override-env' | 'config-quantlab' | 'config-python-ext' | 'managed-venv';
}

export interface PythonPathResolverOptions {
	readonly quantlabConfigPath?: string;
	readonly pythonExtConfigPath?: string;
	readonly homeDir?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Override the platform string. Tests may set this to exercise
	 *  Windows venv layout from a POSIX host. Defaults to
	 *  `process.platform`. */
	readonly platform?: NodeJS.Platform;
}

/**
 * Resolve a Python interpreter path. Returns `null` when nothing was
 * found.
 *
 * If `QUANTLAB_PYTHON` is set in the env, it is treated as an explicit
 * user override: if the value doesn't resolve to an executable file,
 * the resolver returns null (does NOT fall through to subsequent
 * candidates). An explicit override pointing at a non-existent path
 * should fail visibly, not silently demote.
 */
export function resolveQuantlabPython(
	opts: PythonPathResolverOptions = {},
): ResolvedPython | null {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;

	// 1. QUANTLAB_PYTHON env override. If the user explicitly set this,
	//    fall-through is wrong — return null on misconfiguration.
	const envPath = env.QUANTLAB_PYTHON;
	if (envPath && envPath.length > 0) {
		if (existsAndExecutableFile(envPath)) {
			return { pythonPath: envPath, source: 'override-env' };
		}
		// Explicit override that doesn't resolve: fail visibly.
		return null;
	}

	// 2. quantlab.pythonPath. Same explicit-fail-loud policy: if the
	//    user configured a path and it's bad, that's a configuration
	//    bug — don't paper over.
	if (opts.quantlabConfigPath && opts.quantlabConfigPath.length > 0) {
		if (existsAndExecutableFile(opts.quantlabConfigPath)) {
			return { pythonPath: opts.quantlabConfigPath, source: 'config-quantlab' };
		}
		return null;
	}

	// 3. python.defaultInterpreterPath. Treated similarly: explicit
	//    user setting must resolve, or fail.
	if (opts.pythonExtConfigPath && opts.pythonExtConfigPath.length > 0) {
		if (existsAndExecutableFile(opts.pythonExtConfigPath)) {
			return { pythonPath: opts.pythonExtConfigPath, source: 'config-python-ext' };
		}
		return null;
	}

	// 4. Managed venv. Last resort; null if not present.
	const home = opts.homeDir ?? os.homedir();
	const managed = managedVenvPath(home, platform);
	if (existsAndExecutableFile(managed)) {
		return { pythonPath: managed, source: 'managed-venv' };
	}
	return null;
}

function managedVenvPath(home: string, platform: NodeJS.Platform): string {
	if (platform === 'win32') {
		return path.join(home, '.quantlab', 'venv', 'Scripts', 'python.exe');
	}
	return path.join(home, '.quantlab', 'venv', 'bin', 'python');
}

function existsAndExecutableFile(p: string): boolean {
	// Megaudit MAJOR-14: this helper intentionally returns boolean
	// because the resolver wants a fast yes/no and falls through to
	// the next candidate on no. The previous silent catches were the
	// right shape — but we now log the underlying error code so a
	// misconfigured path (typo'd, permission-denied) is diagnosable
	// in the developer console instead of looking identical to
	// "not found".
	let stat: fs.Stats;
	try {
		stat = fs.statSync(p);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT') {
			console.warn(`qviz pythonPath: stat(${p}) failed (${code})`);
		}
		return false;
	}
	if (!stat.isFile()) { return false; }
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch (e) {
		console.warn(
			`qviz pythonPath: ${p} exists but is not executable (${(e as NodeJS.ErrnoException).code})`,
		);
		return false;
	}
}

// ---------------------------------------------------------------------------
// version verification
// ---------------------------------------------------------------------------

export type PythonVersionResult =
	| { readonly ok: true; readonly version: string; readonly major: number; readonly minor: number }
	| { readonly ok: false; readonly error: string };

/**
 * Verify a Python interpreter is at least the given minimum version.
 * Used by the lifecycle creator to fail loudly if the configured
 * Python is e.g. Python 2.7 — that path resolves successfully but the
 * daemon would crash at first import (Step C megaudit PP3).
 *
 * Calls `python -c "import sys; print(sys.version_info[:2])"` (~50ms
 * cold). Caller should cache the result per-path to avoid repeating.
 */
export function verifyPythonVersion(
	pythonPath: string,
	minMajor: number, minMinor: number,
): PythonVersionResult {
	let raw: string;
	try {
		const out = execFileSync(
			pythonPath,
			['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
			{ timeout: 5_000, encoding: 'utf-8' },
		);
		raw = out.trim();
	} catch (e) {
		return {
			ok: false,
			error: `failed to execute ${pythonPath} for version check: ${(e as Error).message}`,
		};
	}
	const m = /^(\d+)\.(\d+)$/.exec(raw);
	if (!m) {
		return {
			ok: false,
			error: `python version output not in expected MAJOR.MINOR form: ${JSON.stringify(raw)}`,
		};
	}
	const major = parseInt(m[1], 10);
	const minor = parseInt(m[2], 10);
	if (major < minMajor || (major === minMajor && minor < minMinor)) {
		return {
			ok: false,
			error: `python ${major}.${minor} is below minimum ${minMajor}.${minMinor}`,
		};
	}
	return { ok: true, version: raw, major, minor };
}
