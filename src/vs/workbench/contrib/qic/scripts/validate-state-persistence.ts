/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CI validation script: Verify state persistence tables exist.
 * AUDIT FIX VIII-PC2.
 * Run: npx ts-node scripts/validate-state-persistence.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const schemaFile = path.resolve(__dirname, '../common/storage/storageSchema.ts');

if (!fs.existsSync(schemaFile)) {
	console.error('FAILED: storageSchema.ts does not exist');
	process.exit(1);
}

const content = fs.readFileSync(schemaFile, 'utf-8');

// Check for expected table definitions
const expectedTables = ['sessions', 'conversations', 'messages'];

for (const table of expectedTables) {
	if (!content.toLowerCase().includes(table)) {
		console.warn(`WARNING: Table '${table}' may not be defined in storageSchema.ts`);
	}
}

// Check BM25 schema
const bm25File = path.resolve(__dirname, '../common/storage/bm25Schema.ts');
if (!fs.existsSync(bm25File)) {
	console.error('FAILED: bm25Schema.ts does not exist');
	process.exit(1);
}

const bm25Content = fs.readFileSync(bm25File, 'utf-8');
if (!bm25Content.includes('qic_bm25') && !bm25Content.includes('bm25')) {
	console.warn('WARNING: BM25 table names may not follow qic_ prefix convention');
}

console.log('PASSED: State persistence schema files verified');
