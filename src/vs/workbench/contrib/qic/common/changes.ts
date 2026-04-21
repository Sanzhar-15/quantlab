/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5: Changes & Diff System - Type Definitions
 * Prompt 05-01: Change Cards UI
 */

export type ChangeType = 'create' | 'modify' | 'delete' | 'rename';

export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'conflict';

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	content: string;
}

export interface FileChange {
	id: string;
	type: ChangeType;
	path: string;
	newPath?: string;  // For renames

	// Content
	originalContent?: string;
	newContent?: string;

	// Diff info
	additions: number;
	deletions: number;
	hunks?: DiffHunk[];

	// Status
	status: ChangeStatus;
	statusMessage?: string;

	// Metadata
	description?: string;
	timestamp: number;
}

export interface ChangeSet {
	id: string;
	messageId: string;
	changes: FileChange[];
	status: 'pending' | 'partial' | 'applied' | 'rejected';
	timestamp: number;
	description?: string;
}

/**
 * Change card action payloads
 */
export interface ChangeAction {
	type: 'apply' | 'reject' | 'view-diff';
	changeId: string;
	setId?: string;
}

export interface ChangeStatusUpdate {
	changeId: string;
	status: ChangeStatus;
	message?: string;
}
