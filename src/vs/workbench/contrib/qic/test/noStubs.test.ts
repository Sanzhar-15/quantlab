/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CI test: Verify no [STUB] markers remain in production security code.
 *
 * After Prompt 14, the three security stubs must be replaced:
 * - TerminalSecurityGuard
 * - ToolChainMonitor
 * - SecurityAuditLogger
 *
 * Full [STUB] elimination across ALL components is verified in Prompt 19.
 */
suite('[STUB] Elimination Test', () => {

	function getSourceFiles(dir: string, files: string[] = []): string[] {
		if (!fs.existsSync(dir)) { return files; }

		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				// Skip test directories
				if (entry.name === 'test') { continue; }
				getSourceFiles(fullPath, files);
			} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
				files.push(fullPath);
			}
		}
		return files;
	}

	test('no [STUB] in security/ directory', () => {
		const securityDir = path.resolve(__dirname, '../common/security');
		const files = getSourceFiles(securityDir);
		const stubFiles: string[] = [];

		for (const file of files) {
			const content = fs.readFileSync(file, 'utf-8');
			if (content.includes('[STUB]')) {
				stubFiles.push(path.relative(securityDir, file));
			}
		}

		assert.strictEqual(
			stubFiles.length, 0,
			`Found [STUB] markers in security files: ${stubFiles.join(', ')}`
		);
	});

	test('no [STUB] in runtime/ production code (excluding *Stub.ts files)', () => {
		const runtimeDir = path.resolve(__dirname, '../common/runtime');
		const files = getSourceFiles(runtimeDir).filter(f => !f.endsWith('Stub.ts'));
		const stubFiles: string[] = [];

		for (const file of files) {
			const content = fs.readFileSync(file, 'utf-8');
			if (content.includes('[STUB]')) {
				stubFiles.push(path.relative(runtimeDir, file));
			}
		}

		assert.strictEqual(
			stubFiles.length, 0,
			`Found [STUB] markers in runtime files: ${stubFiles.join(', ')}`
		);
	});
});
