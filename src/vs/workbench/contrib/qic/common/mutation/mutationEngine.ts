/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { EditScript, ApprovalToken, EditOperation } from '../canonical/types.js';
import type { JournaledAtomicWriter } from '../crashSafe/journaledAtomicWriter.js';
import type { TransactionSafeCheckpointManager } from '../crashSafe/checkpointManager.js';
import { ConflictDetector } from './conflictDetector.js';
import { FlexibleMatcher, MatchResult } from './flexibleMatcher.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}

export interface DiffPreview {
	files: FileDiffPreview[];
	totalChanges: number;
}

export interface FileDiffPreview {
	path: string;
	originalContent: string;
	proposedContent: string;
	operations: EditOperation[];
}

export interface ApplyResult {
	success: boolean;
	filesModified: string[];
	errors: Array<{ path: string; error: string }>;
	checkpointId?: string;
}

/**
 * Edit application engine. Applies EditScripts to files with preview-before-apply.
 * INV-T1: apply() requires ApprovalToken — enforced at the type-system level.
 */
export class MutationEngine {
	private checkpointManager: TransactionSafeCheckpointManager | null = null;

	constructor(
		private readonly atomicWriter: JournaledAtomicWriter,
		private readonly conflictDetector: ConflictDetector,
		private readonly flexibleMatcher: FlexibleMatcher,
	) {}

	/**
	 * Wire the checkpoint manager for revert support.
	 * Called after both MutationEngine and CheckpointManager are created.
	 */
	setCheckpointManager(manager: TransactionSafeCheckpointManager): void {
		this.checkpointManager = manager;
	}

	async preview(editScript: EditScript): Promise<DiffPreview> {
		const fs = await fsPromises();
		const files: FileDiffPreview[] = [];

		for (const fileEdit of editScript.edits) {
			let originalContent: string;
			try {
				originalContent = await fs.readFile(fileEdit.path, 'utf8');
			} catch {
				originalContent = '';
			}

			const proposedContent = this.applyOperationsToContent(
				originalContent,
				fileEdit.operations,
				originalContent,
			);

			files.push({
				path: fileEdit.path,
				originalContent,
				proposedContent,
				operations: fileEdit.operations,
			});
		}

		return {
			files,
			totalChanges: editScript.edits.reduce((sum, e) => sum + e.operations.length, 0),
		};
	}

	/**
	 * Apply edits atomically. Requires ApprovalToken (INV-T1).
	 */
	async apply(editScript: EditScript, approval: ApprovalToken): Promise<ApplyResult> {
		const fs = await fsPromises();
		// INV-T1: Runtime validation of ApprovalToken
		if (!approval || !approval.id || !approval.editScriptHash || !approval.grantedAt || !approval.expiresAt) {
			throw new Error('INV-T1 violation: Invalid or missing ApprovalToken');
		}

		// Verify token has not expired
		if (new Date(approval.expiresAt) < new Date()) {
			throw new Error('INV-T1 violation: ApprovalToken has expired');
		}

		// Verify editScriptHash matches the actual edit script
		const scriptHash = sha256Hex(JSON.stringify(editScript));
		if (approval.editScriptHash !== scriptHash) {
			throw new Error('INV-T1 violation: ApprovalToken editScriptHash does not match the provided EditScript');
		}

		const filesModified: string[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		// Hash files before applying for conflict detection
		const originalHashes = await this.conflictDetector.hashFiles(
			editScript.edits.map(e => e.path),
		);

		// Check for conflicts
		const conflictResult = await this.conflictDetector.detectConflicts(editScript, originalHashes);

		const operations: Array<{ type: 'write'; path: string; content: string; backup?: string }> = [];

		for (const fileEdit of editScript.edits) {
			try {
				let originalContent: string;
				try {
					originalContent = await fs.readFile(fileEdit.path, 'utf8');
				} catch {
					originalContent = '';
				}

				let currentContent = originalContent;
				const hasConflict = conflictResult.conflicts.some(c => c.path === fileEdit.path);

				if (hasConflict) {
					// Try flexible matching for conflicted files
					currentContent = await this.resolveConflictedEdits(
						fileEdit.operations,
						originalContent,
						currentContent,
					);
				} else {
					currentContent = this.applyOperationsToContent(
						originalContent,
						fileEdit.operations,
						currentContent,
					);
				}

				operations.push({
					type: 'write',
					path: fileEdit.path,
					content: currentContent,
					backup: originalContent,
				});
				filesModified.push(fileEdit.path);
			} catch (e) {
				errors.push({
					path: fileEdit.path,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// Apply atomically via JournaledAtomicWriter
		if (operations.length > 0 && errors.length === 0) {
			await this.atomicWriter.writeAtomic(
				operations.map(op => ({
					type: 'write' as const,
					path: op.path,
					content: Buffer.from(op.content, 'utf-8'),
				})),
			);
		}

		return {
			success: errors.length === 0,
			filesModified,
			errors,
		};
	}

	async revert(checkpointId: string): Promise<void> {
		if (!this.checkpointManager) {
			throw new Error('MutationEngine.revert(): CheckpointManager not wired. Call setCheckpointManager() first.');
		}
		await this.checkpointManager.restoreCheckpoint(checkpointId);
	}

	private async resolveConflictedEdits(
		operations: EditOperation[],
		originalContent: string,
		currentContent: string,
	): Promise<string> {
		let result = currentContent;

		for (const op of operations) {
			const match = this.flexibleMatcher.findMatch(op, originalContent, result);
			if (match) {
				result = this.applyOperationAtMatch(result, op, match);
			} else {
				throw new Error(`Could not find match for edit operation in modified file`);
			}
		}

		return result;
	}

	private applyOperationsToContent(
		_originalContent: string,
		operations: EditOperation[],
		currentContent: string,
	): string {
		const lines = currentContent.split('\n');

		// Apply operations in reverse order to preserve line numbers
		const sorted = [...operations].sort((a, b) => {
			const aLine = a.type === 'insert' ? a.position.line : a.range.startLine;
			const bLine = b.type === 'insert' ? b.position.line : b.range.startLine;
			if (bLine !== aLine) { return bLine - aLine; }
			// Deterministic secondary sort: deletes before replaces before inserts at same line
			const typePriority: Record<string, number> = { delete: 0, replace: 1, insert: 2 };
			return (typePriority[a.type] ?? 1) - (typePriority[b.type] ?? 1);
		});

		for (const op of sorted) {
			if (op.type === 'replace') {
				const startIdx = op.range.startLine - 1;
				const endIdx = op.range.endLine;
				const newLines = op.newText.split('\n');
				lines.splice(startIdx, endIdx - startIdx, ...newLines);
			} else if (op.type === 'insert') {
				const idx = op.position.line - 1;
				const newLines = op.text.split('\n');
				lines.splice(idx, 0, ...newLines);
			} else if (op.type === 'delete') {
				const startIdx = op.range.startLine - 1;
				const endIdx = op.range.endLine;
				lines.splice(startIdx, endIdx - startIdx);
			}
		}

		return lines.join('\n');
	}

	private applyOperationAtMatch(
		content: string,
		op: EditOperation,
		match: MatchResult,
	): string {
		const lines = content.split('\n');
		const startIdx = match.matchedRange.startLine - 1;
		const endIdx = match.matchedRange.endLine;

		if (op.type === 'replace') {
			const newLines = op.newText.split('\n');
			lines.splice(startIdx, endIdx - startIdx, ...newLines);
		} else if (op.type === 'insert') {
			const newLines = ('text' in op ? op.text : '').split('\n');
			lines.splice(startIdx, 0, ...newLines);
		} else if (op.type === 'delete') {
			lines.splice(startIdx, endIdx - startIdx);
		}

		return lines.join('\n');
	}
}
