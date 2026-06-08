/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-T -- in-host mocha bootstrap for the real-extension-host integration tests.
//
// Pointed at by `scripts/code.sh --extensionTestsPath=extensions/quantlab/out/test/integration-host`
// (the fork's built-in-extension test pattern; see scripts/test-integration.sh). The extension-host
// loader calls `run(testsRoot, clb)`. Mirrors test/integration/electron/testrunner.js but globs the
// `.hosttest.js` suffix (NOT `.test.js`) so these REAL-host tests are never picked up by the
// extension's vscode-shimmed mocha scripts (`npm test` / `npm run test:all`).

'use strict';

import * as path from 'path';
import * as fs from 'fs';
import Mocha = require('mocha');

export function run(testsRoot: string, clb: (error: Error | null, failures?: number) => void): void {
	require('source-map-support').install();
	const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120000 });
	let files: string[];
	try {
		// Sort for a DETERMINISTIC run order: these suites share one extension host, and some leave a grid
		// open (reactiveAcid1 asserts exactly one grid on a clean host, so it must run first). readdir order
		// is filesystem-dependent, so an explicit sort -- not the OS -- guarantees the alphabetical order the
		// suites assume (Codex N-2 MED).
		files = fs.readdirSync(testsRoot).filter((f) => f.endsWith('.hosttest.js')).sort();
	} catch (error) {
		clb(error as Error);
		return;
	}
	for (const f of files) {
		mocha.addFile(path.join(testsRoot, f));
	}
	try {
		mocha.run((failures) => clb(null, failures));
	} catch (error) {
		clb(error as Error);
	}
}
