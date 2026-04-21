/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A single atomic file operation within a journal transaction.
 */
export interface FileOperation {
	type: 'write' | 'rename' | 'delete';
	path: string;
	content?: Uint8Array;
}

/**
 * Result of a crash recovery attempt.
 */
export interface RecoveryResult {
	recovered: boolean;
	journalsProcessed: number;
	operationsRolledForward: number;
	operationsRolledBack: number;
	errors: string[];
}

/**
 * Internal journal entry persisted to disk.
 */
export interface JournalEntry {
	version: 1;
	transactionId: string;
	timestamp: string;
	operations: JournalOperation[];
	checksum: string;
}

/**
 * Single operation record within a journal file.
 */
export interface JournalOperation {
	type: 'write' | 'rename' | 'delete';
	targetPath: string;
	backupPath?: string;
	content?: string;           // Base64-encoded for binary safety
	contentChecksum?: string;   // SHA-256 of original content bytes
}
