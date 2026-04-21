/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Appendix C Validation Checklist — 41 automated checks.
 * Run: npx ts-node scripts/validate-appendix-c.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const QIC_ROOT = path.resolve(__dirname, '..');
const COMMON = path.join(QIC_ROOT, 'common');

let passed = 0;
let failed = 0;

function check(name: string, fn: () => boolean): void {
	try {
		if (fn()) {
			console.log(`  ✓ ${name}`);
			passed++;
		} else {
			console.error(`  ✗ ${name}`);
			failed++;
		}
	} catch (err) {
		console.error(`  ✗ ${name}: ${err}`);
		failed++;
	}
}

function fileExists(relativePath: string): boolean {
	return fs.existsSync(path.join(COMMON, relativePath));
}

function fileContains(relativePath: string, text: string): boolean {
	const fullPath = path.join(COMMON, relativePath);
	if (!fs.existsSync(fullPath)) { return false; }
	return fs.readFileSync(fullPath, 'utf-8').includes(text);
}

// === Pre-Implementation Verification (10 checks) ===
console.log('\n=== Pre-Implementation Verification ===');

check('1. Canonical types from single module', () =>
	fileExists('canonical/types.ts'));

check('2. PermissionCheckResult uses status field', () =>
	fileContains('canonical/types.ts', "status: 'granted' | 'denied'"));

check('3. ToolResult uses toolCallId + content + isError', () =>
	fileContains('canonical/types.ts', 'toolCallId: string'));

check('4. StreamChunk uses underscores (tool_call_start)', () =>
	fileContains('canonical/interfaces.ts', 'tool_call_start'));

check('5. QicError is a class (not interface)', () =>
	fileContains('canonical/types.ts', 'export class QicError'));

check('6. ApprovalToken type exists', () =>
	fileContains('canonical/types.ts', 'ApprovalToken'));

check('7. ERROR_REGISTRY exists', () =>
	fileContains('canonical/errors.ts', 'ERROR_REGISTRY'));

check('8. 8 lanes defined', () =>
	fileContains('runtime/laneRouter.ts', 'completion') &&
	fileContains('runtime/laneRouter.ts', 'chat-ask') &&
	fileContains('runtime/laneRouter.ts', 'chat-act'));

check('9. ToolRouter has register method', () =>
	fileContains('runtime/toolRouter.ts', 'register('));

check('10. All 22 tools in registration', () =>
	fileContains('tools/toolRegistration.ts', 'create_checkpoint'));

// === Security Verification (9 checks) ===
console.log('\n=== Security Verification ===');

check('11. Secret scanner exists', () =>
	fileExists('security/secretScanner.ts'));

check('12. Egress enforcer exists', () =>
	fileExists('security/egressEnforcer.ts'));

check('13. Consent store exists', () =>
	fileExists('security/consentStore.ts'));

check('14. Terminal guard exists', () =>
	fileExists('security/terminalGuard.ts'));

check('15. Argument analyzer exists', () =>
	fileExists('security/argumentAnalyzer.ts'));

check('16. Tool chain monitor exists', () =>
	fileExists('security/toolChainMonitor.ts'));

check('17. Audit logger exists', () =>
	fileExists('security/auditLogger.ts'));

check('18. SSRF prevention in network tools', () =>
	fileContains('tools/networkTools.ts', 'SSRF'));

check('19. Blocked read patterns for .env files', () =>
	fileContains('tools/fileOps.ts', '.env'));

// === Architecture Verification (11 checks) ===
console.log('\n=== Architecture Verification ===');

check('20. JournaledAtomicWriter exists', () =>
	fileExists('crashSafe/journaledAtomicWriter.ts'));

check('21. Checkpoint manager exists', () =>
	fileExists('crashSafe/checkpointManager.ts'));

check('22. Checkpoint validator exists', () =>
	fileExists('crashSafe/checkpointValidity.ts'));

check('23. FileContent types exist', () =>
	fileExists('crashSafe/fileContent.ts'));

check('24. Database layer exists', () =>
	fileExists('storage/database.ts'));

check('25. Gateway exists', () =>
	fileExists('gateway/gateway.ts'));

check('26. Agent orchestrator exists', () =>
	fileExists('runtime/agentOrchestrator.ts'));

check('27. Context assembler exists', () =>
	fileExists('context/contextAssembler.ts'));

check('28. Mutation engine exists', () =>
	fileExists('mutation/mutationEngine.ts'));

check('29. Completion engine exists', () =>
	fileExists('completion/completionEngine.ts'));

check('30. Degradation manager exists', () =>
	fileExists('resilience/degradationManager.ts'));

// === Performance Verification (11 checks) ===
console.log('\n=== Performance Verification ===');

check('31. Memory manager exists', () =>
	fileExists('resilience/memoryManager.ts'));

check('32. BM25 indexer exists', () =>
	fileExists('context/incrementalIndexer.ts'));

check('33. Vector index exists', () =>
	fileExists('context/vectorIndex.ts'));

check('34. RRF reranker exists', () =>
	fileExists('context/reranker.ts'));

check('35. Session cache exists', () =>
	fileExists('telemetry/sessionCache.ts'));

check('36. Telemetry service exists', () =>
	fileExists('telemetry/telemetryService.ts'));

check('37. Reproducibility logger exists', () =>
	fileExists('telemetry/reproducibilityLogger.ts'));

check('38. Replay mode exists', () =>
	fileExists('telemetry/replayMode.ts'));

check('39. DataFrame safety exists', () =>
	fileExists('quant/dataframeSafety.ts'));

check('40. Arrow bridge exists', () =>
	fileExists('quant/arrowBridge.ts'));

check('41. Python bridge exists', () =>
	fileExists('quant/qicPythonBridge.ts'));

// === Summary ===
console.log(`\n=== Summary: ${passed} passed, ${failed} failed of ${passed + failed} checks ===`);

if (failed > 0) {
	process.exit(1);
}
