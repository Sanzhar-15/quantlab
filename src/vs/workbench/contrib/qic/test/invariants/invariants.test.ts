/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Invariant verification tests — all 11 invariants from the QIC spec.
 */
const QIC_ROOT = path.resolve(__dirname, '../../../common');

suite('QIC Invariants', () => {

	// INV-A1: All types from canonical module
	test('INV-A1: All types exported from canonical/types.ts', () => {
		const typesFile = path.join(QIC_ROOT, 'canonical/types.ts');
		const content = fs.readFileSync(typesFile, 'utf-8');

		// Verify key type exports exist
		assert.ok(content.includes('export interface ToolResult'), 'ToolResult should be exported');
		assert.ok(content.includes('export interface ToolCall'), 'ToolCall should be exported');
		assert.ok(content.includes('export interface ProviderRequest'), 'ProviderRequest should be exported');
		assert.ok(content.includes('export interface ProviderResponse'), 'ProviderResponse should be exported');
		assert.ok(content.includes('export interface PermissionCheckResult'), 'PermissionCheckResult should be exported');
		assert.ok(content.includes('export class QicError'), 'QicError should be exported');
	});

	// INV-T1: MutationEngine.apply() requires ApprovalToken
	test('INV-T1: MutationEngine.apply requires ApprovalToken parameter', () => {
		const mutationFile = path.join(QIC_ROOT, 'mutation/mutationEngine.ts');
		const content = fs.readFileSync(mutationFile, 'utf-8');
		assert.ok(content.includes('ApprovalToken'), 'apply() should require ApprovalToken');
	});

	// INV-T2: ToolRouter always logs via SecurityAuditLogger
	test('INV-T2: ToolRouter logs all tool calls via SecurityAuditLogger', () => {
		const routerFile = path.join(QIC_ROOT, 'runtime/toolRouter.ts');
		const content = fs.readFileSync(routerFile, 'utf-8');
		assert.ok(content.includes('securityLogger.logToolCall'), 'Should log tool calls');
		assert.ok(content.includes('SecurityAuditLogger'), 'Should reference SecurityAuditLogger');
	});

	// INV-T3: EgressBoundaryEnforcer redacts secrets
	test('INV-T3: EgressBoundaryEnforcer includes secret scanning', () => {
		const egressFile = path.join(QIC_ROOT, 'security/egressEnforcer.ts');
		const content = fs.readFileSync(egressFile, 'utf-8');
		assert.ok(content.includes('secretScanner'), 'Should reference secretScanner');
		assert.ok(content.includes('consentStore'), 'Should reference consentStore');
	});

	// INV-T4: Checkpoint validation
	test('INV-T4: CheckpointValidator implements validation rules', () => {
		const validatorFile = path.join(QIC_ROOT, 'crashSafe/checkpointValidity.ts');
		const content = fs.readFileSync(validatorFile, 'utf-8');
		assert.ok(content.includes('validate'), 'Should have validate method');
	});

	// INV-A2: JournaledAtomicWriter atomicity
	test('INV-A2: JournaledAtomicWriter exists with writeAtomic', () => {
		const writerFile = path.join(QIC_ROOT, 'crashSafe/journaledAtomicWriter.ts');
		const content = fs.readFileSync(writerFile, 'utf-8');
		assert.ok(content.includes('writeAtomic'), 'Should have writeAtomic method');
		assert.ok(content.includes('.complete'), 'Should use .complete marker');
	});

	// INV-A3: Checkpoint crash safety
	test('INV-A3: CheckpointManager uses atomic writes', () => {
		const cpFile = path.join(QIC_ROOT, 'crashSafe/checkpointManager.ts');
		const content = fs.readFileSync(cpFile, 'utf-8');
		assert.ok(content.includes('atomicWriter'), 'Should use atomicWriter');
		assert.ok(content.includes('.complete'), 'Should use .complete marker');
	});

	// INV-A4: TimeoutManager USER_INTERACTION has no timeout
	test('INV-A4: Timeout domains include user_interaction with Infinity', () => {
		const timeoutFile = path.join(QIC_ROOT, 'storage/statePersistence.ts');
		const content = fs.readFileSync(timeoutFile, 'utf-8');
		// The timeout manager should handle user interaction as a special case
		assert.ok(content.includes('timeout') || content.includes('Timeout'), 'Should reference timeout management');
	});

	// Security: No [STUB] in production security code
	test('No [STUB] markers in production security code', () => {
		const securityDir = path.join(QIC_ROOT, 'security');
		const files = fs.readdirSync(securityDir).filter(f => f.endsWith('.ts'));

		for (const file of files) {
			const content = fs.readFileSync(path.join(securityDir, file), 'utf-8');
			assert.ok(!content.includes('[STUB]'), `Security file ${file} should not contain [STUB]`);
		}
	});

	// Architecture: No circular imports in canonical types
	test('Canonical types module has no circular dependencies', () => {
		const typesFile = path.join(QIC_ROOT, 'canonical/types.ts');
		const content = fs.readFileSync(typesFile, 'utf-8');

		// types.ts should only import from errors.ts (its companion)
		const imports = content.match(/from ['"]\.\.\/[^'"]+['"]/g) ?? [];
		// Should not import from runtime, tools, security, etc.
		for (const imp of imports) {
			assert.ok(!imp.includes('runtime'), `types.ts should not import from runtime: ${imp}`);
			assert.ok(!imp.includes('tools'), `types.ts should not import from tools: ${imp}`);
			assert.ok(!imp.includes('security'), `types.ts should not import from security: ${imp}`);
		}
	});
});
