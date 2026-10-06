/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (DRIVER): the TEST-BUILD view-records dump. The built-app driver (client `test/built-app-driver`) reads the
// webPreferences the host RECORDED for each view (RUN-SHEET-U5 B1: the workbench record is `sandbox: true`, the fork's own
// preload, no session) from a file, because they cannot be read from outside the main process. `app.ts` imports this module
// only inside `if (globalThis.QL_TEST_BUILD)` and dynamically, so a product bundle (where the define makes the guard `false`)
// carries neither this module nor its file name (closing check 4 of folds/HOST/DRIVER.md greps the bundle for both).
//
// A write that fails is not caught: it throws `QlViewRecordsDumpError`, naming the path and the step, into the caller (a test
// build that cannot publish its records must stop, not run on with a stale file).

import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { join } from '../../../base/common/path.js';
import type { ViewRecord } from '../ql-client/index.js';

const DUMP_DIR_NAME = 'ql-test';
const DUMP_FILE_NAME = 'view-records.json';

export class QlViewRecordsDumpError extends Error {

	constructor(readonly step: 'mkdir' | 'serialise' | 'write' | 'rename', readonly path: string, cause: unknown) {
		super(`QuantLab host (DRIVER): view-records dump failed at step ${step} (${path}): ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = 'QlViewRecordsDumpError';
		this.cause = cause;
	}
}

/**
 * Writes `<userDataPath>/ql-test/view-records.json` (the directory is created when absent). The content is
 * `{ "records": [{ name, role, webPreferences }...] }` in registration order (the driver's `viewRecords()` keys it by name). The file is written whole to a sibling and renamed over the target, so a reader never sees half a file.
 * Returns the path written.
 */
export function dump(records: readonly ViewRecord[], userDataPath: string): string {
	if (typeof userDataPath !== 'string' || userDataPath === '') {
		throw new QlViewRecordsDumpError('mkdir', String(userDataPath), new Error('the user-data path is not a non-empty string'));
	}

	const dir = join(userDataPath, DUMP_DIR_NAME);
	const file = join(dir, DUMP_FILE_NAME);
	const temporary = `${file}.${process.pid}.tmp`;

	try {
		mkdirSync(dir, { recursive: true });
	} catch (error) {
		throw new QlViewRecordsDumpError('mkdir', dir, error);
	}

	let text: string;
	try {
		text = JSON.stringify({ records }, undefined, '\t');
	} catch (error) {
		throw new QlViewRecordsDumpError('serialise', file, error);
	}

	try {
		writeFileSync(temporary, text, { mode: 0o600 });
	} catch (error) {
		throw new QlViewRecordsDumpError('write', temporary, error);
	}

	try {
		renameSync(temporary, file);
	} catch (error) {
		throw new QlViewRecordsDumpError('rename', file, error);
	}

	return file;
}
