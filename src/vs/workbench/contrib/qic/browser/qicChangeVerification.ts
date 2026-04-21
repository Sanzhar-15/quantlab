/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5: Changes Verification
 * Prompt 05-06
 *
 * Verifies that proposed changes can be applied safely before committing them.
 * Checks for file modifications, conflicts, and other safety issues.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { FileChange, ChangeSet } from '../common/changes.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IQicChangeVerificationService = createDecorator<IQicChangeVerificationService>('qicChangeVerificationService');

/**
 * Verification result for a single change.
 */
export interface ChangeVerificationResult {
	changeId: string;
	canApply: boolean;
	issues: VerificationIssue[];
}

/**
 * Types of verification issues.
 */
export type VerificationIssueType =
	| 'file_modified'         // File was modified since change was generated
	| 'file_deleted'          // Target file no longer exists
	| 'file_exists'           // File already exists (for create operations)
	| 'content_mismatch'      // Expected content doesn't match actual content
	| 'parent_missing'        // Parent directory doesn't exist
	| 'permission_denied'     // No write permission
	| 'binary_file'           // Attempting to edit a binary file
	| 'syntax_error'          // Change would create syntax errors
	| 'dependency_conflict';  // Another change depends on this one

/**
 * A specific verification issue.
 */
export interface VerificationIssue {
	type: VerificationIssueType;
	message: string;
	severity: 'error' | 'warning';
	resolution?: string;  // Suggested resolution
}

/**
 * Verification result for an entire change set.
 */
export interface ChangeSetVerificationResult {
	changeSetId: string;
	canApplyAll: boolean;
	canApplyPartial: boolean;
	changes: ChangeVerificationResult[];
	summary: {
		total: number;
		safe: number;
		warnings: number;
		errors: number;
	};
}

export interface IQicChangeVerificationService {
	readonly _serviceBrand: undefined;

	/**
	 * Verify a single change can be applied safely.
	 */
	verifyChange(change: FileChange): Promise<ChangeVerificationResult>;

	/**
	 * Verify all changes in a change set.
	 */
	verifyChangeSet(changeSet: ChangeSet): Promise<ChangeSetVerificationResult>;

	/**
	 * Re-verify changes after user makes modifications.
	 */
	revalidate(changeSetId: string): Promise<ChangeSetVerificationResult>;
}

/**
 * QIC Change Verification Service implementation.
 */
export class QicChangeVerificationService extends Disposable implements IQicChangeVerificationService {
	readonly _serviceBrand: undefined;

	// Cache of file content hashes at time of change generation
	private readonly contentHashes = new Map<string, string>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	/**
	 * Verify a single change can be applied safely.
	 */
	async verifyChange(change: FileChange): Promise<ChangeVerificationResult> {
		const issues: VerificationIssue[] = [];

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		const workspaceRoot = workspaceFolders.length > 0 ? workspaceFolders[0].uri : undefined;

		if (!workspaceRoot) {
			issues.push({
				type: 'permission_denied',
				message: 'No workspace folder open',
				severity: 'error',
				resolution: 'Open a workspace folder to apply changes',
			});
			return { changeId: change.id, canApply: false, issues };
		}

		const fileUri = URI.joinPath(workspaceRoot, change.path);

		switch (change.type) {
			case 'create':
				await this.verifyCreate(fileUri, change, issues);
				break;

			case 'modify':
				await this.verifyModify(fileUri, change, issues);
				break;

			case 'delete':
				await this.verifyDelete(fileUri, change, issues);
				break;

			case 'rename':
				await this.verifyRename(fileUri, change, issues);
				break;
		}

		// Determine if change can be applied
		const hasErrors = issues.some(i => i.severity === 'error');
		return {
			changeId: change.id,
			canApply: !hasErrors,
			issues,
		};
	}

	/**
	 * Verify all changes in a change set.
	 */
	async verifyChangeSet(changeSet: ChangeSet): Promise<ChangeSetVerificationResult> {
		const changes: ChangeVerificationResult[] = [];

		// Verify each change
		for (const change of changeSet.changes) {
			const result = await this.verifyChange(change);
			changes.push(result);
		}

		// Build summary
		const safe = changes.filter(c => c.canApply && c.issues.length === 0).length;
		const warnings = changes.filter(c => c.canApply && c.issues.some(i => i.severity === 'warning')).length;
		const errors = changes.filter(c => !c.canApply).length;

		return {
			changeSetId: changeSet.id,
			canApplyAll: errors === 0,
			canApplyPartial: safe + warnings > 0,
			changes,
			summary: {
				total: changes.length,
				safe,
				warnings,
				errors,
			},
		};
	}

	/**
	 * Re-verify changes after modifications.
	 */
	async revalidate(changeSetId: string): Promise<ChangeSetVerificationResult> {
		// Would need to get the change set from state
		// For now, return empty result
		return {
			changeSetId,
			canApplyAll: false,
			canApplyPartial: false,
			changes: [],
			summary: { total: 0, safe: 0, warnings: 0, errors: 0 },
		};
	}

	/**
	 * Verify a file creation.
	 */
	private async verifyCreate(fileUri: URI, change: FileChange, issues: VerificationIssue[]): Promise<void> {
		try {
			// Check if file already exists
			const stat = await this.fileService.stat(fileUri);
			if (stat.isFile) {
				issues.push({
					type: 'file_exists',
					message: `File already exists: ${change.path}`,
					severity: 'error',
					resolution: 'Delete the existing file or use modify instead',
				});
			}
		} catch {
			// File doesn't exist - good for create
		}

		// Check if parent directory exists
		const parentUri = URI.joinPath(fileUri, '..');
		try {
			await this.fileService.stat(parentUri);
		} catch {
			issues.push({
				type: 'parent_missing',
				message: `Parent directory does not exist: ${parentUri.path}`,
				severity: 'warning',
				resolution: 'Directory will be created automatically',
			});
		}

		// Verify content is provided
		if (change.newContent === undefined || change.newContent === null) {
			issues.push({
				type: 'content_mismatch',
				message: 'No content provided for new file',
				severity: 'error',
			});
		}
	}

	/**
	 * Verify a file modification.
	 */
	private async verifyModify(fileUri: URI, change: FileChange, issues: VerificationIssue[]): Promise<void> {
		try {
			// Check if file exists
			const stat = await this.fileService.stat(fileUri);
			if (!stat.isFile) {
				issues.push({
					type: 'file_deleted',
					message: `Not a file: ${change.path}`,
					severity: 'error',
				});
				return;
			}

			// Read current content to check for modifications
			const content = await this.fileService.readFile(fileUri);
			const currentContent = content.value.toString();

			// If we have original content, verify it matches
			if (change.originalContent !== undefined) {
				if (currentContent !== change.originalContent) {
					// Calculate how different
					const similarity = this.calculateSimilarity(currentContent, change.originalContent);

					if (similarity < 0.5) {
						issues.push({
							type: 'file_modified',
							message: `File has been significantly modified since change was generated`,
							severity: 'error',
							resolution: 'Regenerate the change or manually review',
						});
					} else if (similarity < 0.9) {
						issues.push({
							type: 'file_modified',
							message: `File has been modified since change was generated`,
							severity: 'warning',
							resolution: 'Review the diff carefully before applying',
						});
					}
				}
			}

			// Check if it's a binary file
			if (this.isBinaryContent(content.value.buffer as Uint8Array)) {
				issues.push({
					type: 'binary_file',
					message: `Cannot modify binary file: ${change.path}`,
					severity: 'error',
				});
			}

		} catch {
			issues.push({
				type: 'file_deleted',
				message: `File does not exist: ${change.path}`,
				severity: 'error',
				resolution: 'File may have been deleted or moved',
			});
		}

		// Verify new content is provided
		if (change.newContent === undefined || change.newContent === null) {
			issues.push({
				type: 'content_mismatch',
				message: 'No replacement content provided',
				severity: 'error',
			});
		}
	}

	/**
	 * Verify a file deletion.
	 */
	private async verifyDelete(fileUri: URI, change: FileChange, issues: VerificationIssue[]): Promise<void> {
		try {
			const stat = await this.fileService.stat(fileUri);
			if (!stat.isFile) {
				issues.push({
					type: 'file_deleted',
					message: `Not a file: ${change.path}`,
					severity: 'warning',
				});
			}
		} catch {
			issues.push({
				type: 'file_deleted',
				message: `File does not exist: ${change.path}`,
				severity: 'warning',
				resolution: 'File may have already been deleted',
			});
		}
	}

	/**
	 * Verify a file rename.
	 */
	private async verifyRename(fileUri: URI, change: FileChange, issues: VerificationIssue[]): Promise<void> {
		// Verify source exists
		try {
			await this.fileService.stat(fileUri);
		} catch {
			issues.push({
				type: 'file_deleted',
				message: `Source file does not exist: ${change.path}`,
				severity: 'error',
			});
		}

		// Verify destination doesn't exist
		if (change.newPath) {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			const workspaceRoot = workspaceFolders.length > 0 ? workspaceFolders[0].uri : undefined;
			if (workspaceRoot) {
				const destUri = URI.joinPath(workspaceRoot, change.newPath);
				try {
					await this.fileService.stat(destUri);
					issues.push({
						type: 'file_exists',
						message: `Destination file already exists: ${change.newPath}`,
						severity: 'error',
						resolution: 'Delete the destination file first',
					});
				} catch {
					// Destination doesn't exist - good for rename
				}
			}
		} else {
			issues.push({
				type: 'content_mismatch',
				message: 'No destination path provided for rename',
				severity: 'error',
			});
		}
	}

	/**
	 * Calculate similarity between two strings (0-1).
	 */
	private calculateSimilarity(a: string, b: string): number {
		if (a === b) return 1;
		if (a.length === 0 || b.length === 0) return 0;

		// Simple line-based similarity
		const linesA = a.split('\n');
		const linesB = b.split('\n');

		const setA = new Set(linesA);
		const setB = new Set(linesB);

		let matching = 0;
		for (const line of setA) {
			if (setB.has(line)) matching++;
		}

		return (2 * matching) / (setA.size + setB.size);
	}

	/**
	 * Check if content appears to be binary.
	 */
	private isBinaryContent(buffer: Uint8Array): boolean {
		// Check first 8KB for null bytes
		const checkLength = Math.min(8192, buffer.length);
		for (let i = 0; i < checkLength; i++) {
			if (buffer[i] === 0) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Store content hash for later verification.
	 */
	storeContentHash(filePath: string, content: string): void {
		this.contentHashes.set(filePath, this.hashContent(content));
	}

	/**
	 * Simple hash function for content.
	 */
	private hashContent(content: string): string {
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const chr = content.charCodeAt(i);
			hash = ((hash << 5) - hash) + chr;
			hash |= 0;
		}
		return hash.toString(16);
	}
}
