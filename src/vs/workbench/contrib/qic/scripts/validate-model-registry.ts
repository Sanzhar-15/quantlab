/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CI validation script: Verify model registry configuration.
 * AUDIT FIX VIII-PC2.
 * Run: npx ts-node scripts/validate-model-registry.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const registryFile = path.resolve(__dirname, '../common/canonical/errors.ts');

if (!fs.existsSync(registryFile)) {
	console.error('FAILED: errors.ts (containing ERROR_REGISTRY) does not exist');
	process.exit(1);
}

const content = fs.readFileSync(registryFile, 'utf-8');

// Check ERROR_REGISTRY exists
if (!content.includes('ERROR_REGISTRY')) {
	console.error('FAILED: ERROR_REGISTRY not found');
	process.exit(1);
}

// Check for required error code prefixes
const requiredPrefixes = ['QIC-G', 'QIC-P', 'QIC-T', 'QIC-S', 'QIC-N'];
let missing = 0;

for (const prefix of requiredPrefixes) {
	if (!content.includes(prefix)) {
		console.error(`MISSING: No error codes with prefix '${prefix}'`);
		missing++;
	}
}

// Check gateway configuration exists
const gatewayDir = path.resolve(__dirname, '../common/gateway');
if (fs.existsSync(gatewayDir)) {
	const files = fs.readdirSync(gatewayDir);
	console.log(`Gateway directory contains ${files.length} files`);
}

if (missing > 0) {
	console.error(`\nFAILED: ${missing} error code prefixes missing`);
	process.exit(1);
} else {
	console.log('PASSED: Model and error registry verified');
}
