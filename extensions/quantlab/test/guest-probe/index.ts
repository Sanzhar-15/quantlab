/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The guest probe's in-host mocha bootstrap (desktop PLAN-FINAL §3.8). Pointed at by
// `--extensionTestsPath=<fork>/extensions/quantlab/out/test/guest-probe` when the BUILT desktop app is
// launched by the guest driver. Its own directory and its own `.guestprobe.js` suffix: the probe waits for
// a driver, so neither the `.hosttest.js` run (test/integration-host) nor the vscode-shimmed mocha scripts
// may pick it up. Never part of a release build (the EXT-ISO absence check proves that on the package).

'use strict';

import * as path from 'path';
import * as fs from 'fs';
import Mocha = require('mocha');

export function run(testsRoot: string, clb: (error: Error | null, failures?: number) => void): void {
	require('source-map-support').install();
	const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 180000 });
	let files: string[];
	try {
		files = fs.readdirSync(testsRoot).filter((f) => f.endsWith('.guestprobe.js')).sort();
	} catch (error) {
		clb(error as Error);
		return;
	}
	if (files.length === 0) {
		clb(new Error(`guest probe: no .guestprobe.js file in ${testsRoot}`));
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
