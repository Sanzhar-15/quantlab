/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-T -- environment gate + ipykernel-leak helpers for the real-extension-host acid#1 test.
//
// The reactive kernel needs (a) the engine napi dylib and (b) a Python interpreter with the kernel
// deps. The in-host path resolves the engine via QUANTBOOK_ENGINE_PATH (loader.ts) and the
// interpreter via QUANTLAB_PYTHON (pythonPath.ts). When either is absent the test SKIPS (honest
// green-skip, not a silent pass) so CI without the spike env does not go red.

import * as fs from 'fs';
import { execFileSync } from 'child_process';

/** Why the reactive env is not ready (for a clear skip message), or undefined when it is ready. */
export function reactiveEnvBlocker(): string | undefined {
	const enginePath = process.env.QUANTBOOK_ENGINE_PATH;
	if (typeof enginePath !== 'string' || enginePath.length === 0) {
		return 'QUANTBOOK_ENGINE_PATH is not set';
	}
	if (!fs.existsSync(enginePath)) {
		return `QUANTBOOK_ENGINE_PATH does not exist: ${enginePath}`;
	}
	const py = process.env.QUANTLAB_PYTHON;
	if (typeof py !== 'string' || py.length === 0) {
		return 'QUANTLAB_PYTHON is not set';
	}
	if (!fs.existsSync(py)) {
		return `QUANTLAB_PYTHON does not exist: ${py}`;
	}
	return undefined;
}

/** Set of PIDs currently running an ipykernel_launcher (empty when none -- pgrep exit 1). */
export function ipykernelPids(): Set<number> {
	let out: string;
	try {
		out = execFileSync('pgrep', ['-f', 'ipykernel_launcher'], { encoding: 'utf-8' });
	} catch (e) {
		// pgrep exits 1 when there are NO matches -- that is the legitimate empty case, not an error.
		// Any other exit status is a real failure and must surface (No-Fallbacks).
		const status = (e as { status?: number }).status;
		if (status === 1) {
			return new Set<number>();
		}
		throw e;
	}
	const pids = new Set<number>();
	for (const line of out.split('\n')) {
		const n = parseInt(line.trim(), 10);
		if (Number.isFinite(n)) {
			pids.add(n);
		}
	}
	return pids;
}

/** ipykernel PIDs present now that were NOT present in `before` -- i.e. leaked by this test. */
export function newIpykernelPids(before: Set<number>): number[] {
	const now = ipykernelPids();
	const leaked: number[] = [];
	for (const pid of now) {
		if (!before.has(pid)) {
			leaked.push(pid);
		}
	}
	return leaked;
}
