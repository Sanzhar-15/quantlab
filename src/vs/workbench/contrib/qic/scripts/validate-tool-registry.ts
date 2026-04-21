/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CI validation script: Verify all 26 tools are registered.
 * Run: npx ts-node scripts/validate-tool-registry.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const EXPECTED_TOOLS = [
	'read_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'create_directory', 'list_directory',
	'search_code', 'search_files',
	'get_references', 'get_definition',
	'run_terminal', 'run_command',
	'web_fetch', 'web_search',
	'install_package',
	'rename_symbol', 'apply_code_action', 'organize_imports',
	'inspect_notebook', 'preview_dataframe', 'analyze_backtest',
	'git_status', 'git_diff', 'git_log',
	'create_checkpoint',
];

const registrationFile = path.resolve(__dirname, '../common/tools/toolRegistration.ts');
const content = fs.readFileSync(registrationFile, 'utf-8');

let missing = 0;
for (const tool of EXPECTED_TOOLS) {
	if (!content.includes(`'${tool}'`)) {
		console.error(`MISSING: Tool '${tool}' not found in toolRegistration.ts`);
		missing++;
	}
}

if (missing > 0) {
	console.error(`\nFAILED: ${missing} of ${EXPECTED_TOOLS.length} tools missing from registry`);
	process.exit(1);
} else {
	console.log(`PASSED: All ${EXPECTED_TOOLS.length} tools registered`);
}
