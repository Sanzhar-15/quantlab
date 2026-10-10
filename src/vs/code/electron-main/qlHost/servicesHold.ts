/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (F-PERF-LZ1-1 review c1 M2, arbiter ruling P2, folds/F-PERF-LZ1-1/ARBITER-M2.md "The hold"): TEST BUILDS ONLY,
// imported only inside `app.ts`'s `if (globalThis.QL_TEST_BUILD)` block in startup(), right after the machine ids resolve.
//
// One launch holds its services section so a package row can act (quit, TERM) while the services are provably pending:
//   - activation is per launch only: the environment variable QL_TEST_HOLD_SERVICES=<dir>; unset = no hold;
//   - the acknowledgement is <dir>/held, written atomically (a temporary file renamed), then the log line
//     'QuantLab host: test build: services held'; a runner acts only after <dir>/held exists;
//   - the release is the runner creating <dir>/release;
//   - set but empty, or a directory that cannot be written, throws by name (the services failure path names it); never a no-op.

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';

export const QL_SERVICES_HOLD_ENV = 'QL_TEST_HOLD_SERVICES';
const RELEASE_POLL_MS = 50;

export async function qlServicesHold(env: NodeJS.ProcessEnv, log: (message: string) => void): Promise<void> {
	const dir = env[QL_SERVICES_HOLD_ENV];
	if (dir === undefined) {
		return;
	}
	if (dir === '') {
		throw new Error(`QuantLab host: test build: ${QL_SERVICES_HOLD_ENV} is set but empty (no hold directory)`);
	}
	const held = join(dir, 'held');
	const temporary = join(dir, `held.${process.pid}.tmp`);
	try {
		await fs.writeFile(temporary, `pid=${process.pid}\n`, { flag: 'wx' });
		await fs.rename(temporary, held);
	} catch (error) {
		throw new Error(`QuantLab host: test build: the services hold could not write ${held} (${QL_SERVICES_HOLD_ENV}=${dir})`, { cause: error });
	}
	log('QuantLab host: test build: services held');
	const release = join(dir, 'release');
	while (!(await exists(release))) {
		await new Promise(resolve => setTimeout(resolve, RELEASE_POLL_MS));
	}
}

/** true when the path exists, false only on ENOENT; any other error is thrown. */
async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}
