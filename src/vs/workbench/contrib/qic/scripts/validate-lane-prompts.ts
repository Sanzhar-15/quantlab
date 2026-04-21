/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CI validation script: Verify all 8 lanes have configuration.
 * AUDIT FIX VIII-PC2.
 * Run: npx ts-node scripts/validate-lane-prompts.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const EXPECTED_LANES = [
	'completion', 'chat-ask', 'chat-gather', 'chat-plan', 'chat-act',
	'repair', 'fast-apply', 'summarize',
];

// Check lane router
const laneRouterFile = path.resolve(__dirname, '../common/runtime/laneRouter.ts');
const laneRouterContent = fs.readFileSync(laneRouterFile, 'utf-8');

let missing = 0;
for (const lane of EXPECTED_LANES) {
	if (!laneRouterContent.includes(`'${lane}'`)) {
		console.error(`MISSING: Lane '${lane}' not found in laneRouter.ts`);
		missing++;
	}
}

// Check context assembler for lane budgets
const assemblerFile = path.resolve(__dirname, '../common/context/contextAssembler.ts');
if (fs.existsSync(assemblerFile)) {
	const assemblerContent = fs.readFileSync(assemblerFile, 'utf-8');
	for (const lane of EXPECTED_LANES) {
		if (!assemblerContent.includes(`'${lane}'`)) {
			console.warn(`WARNING: Lane '${lane}' may not have a budget profile in contextAssembler.ts`);
		}
	}
}

if (missing > 0) {
	console.error(`\nFAILED: ${missing} lanes missing from lane router`);
	process.exit(1);
} else {
	console.log(`PASSED: All ${EXPECTED_LANES.length} lanes configured`);
}
