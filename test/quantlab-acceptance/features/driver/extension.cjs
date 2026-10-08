/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The driver contributes nothing. In the modes whose steps need a modal dialog (lib.mjs DIALOG_MODES) the app is
// launched without --extensionTestsPath, where the workbench refuses dialogs, so checks.cjs runs from this
// activation instead; the launcher closes the app once the result is written. In the other modes the extension
// tests run checks.cjs and this activation does nothing.
const DIALOG_MODES = ['import', 'import-profile', 'pack-trigger'];

exports.activate = function () {
	const mode = process.env.QL_FEATURES_MODE;
	if (DIALOG_MODES.includes(mode)) {
		// No test runner reports a failure here: an error is written as the result, and the launcher fails the launch by name.
		require('./checks.cjs').run().catch(err => {
			require('fs').writeFileSync(process.env.QL_FEATURES_RESULT, JSON.stringify({ mode, driverError: err instanceof Error ? err.message : String(err) }) + '\n');
		});
	}
};
