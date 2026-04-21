/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CI validation script: Verify FileContent tier types are used.
 * AUDIT FIX VIII-PC2.
 * Run: npx ts-node scripts/validate-file-content-types.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const fileContentFile = path.resolve(__dirname, '../common/crashSafe/fileContent.ts');

if (!fs.existsSync(fileContentFile)) {
	console.error('FAILED: fileContent.ts does not exist');
	process.exit(1);
}

const content = fs.readFileSync(fileContentFile, 'utf-8');

// Check for tiered content types (discriminated union variants)
const expectedTypes = ['inline', 'stream', 'reference', 'rejected'];
let missing = 0;

for (const typeName of expectedTypes) {
	if (!content.includes(`type: '${typeName}'`)) {
		console.error(`MISSING: variant '${typeName}' not found in fileContent.ts`);
		missing++;
	}
}

if (missing > 0) {
	console.error(`\nFAILED: ${missing} FileContent variants missing`);
	process.exit(1);
} else {
	console.log(`PASSED: All ${expectedTypes.length} FileContent tier variants defined`);
}
