/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Audit Log Types
 * Phase 6 - Prompt 06-09: Audit Log Viewer
 */

export type AuditEntryType =
	| 'change'
	| 'permission'
	| 'tool'
	| 'checkpoint'
	| 'error'
	| 'conversation'
	| 'context';

export type AuditEntrySeverity = 'info' | 'warning' | 'error';

export interface AuditLogEntry {
	id: string;
	type: AuditEntryType;
	severity: AuditEntrySeverity;
	timestamp: number;
	title: string;
	description: string;
	details?: Record<string, unknown>;

	// Context
	conversationId?: string;
	messageId?: string;
	filePath?: string;

	// Status
	status?: 'success' | 'failed' | 'pending';
	errorCode?: string;
}

export interface AuditLogFilter {
	types: AuditEntryType[];
	severity?: AuditEntrySeverity[];
	dateFrom?: number;
	dateTo?: number;
	searchQuery?: string;
}

export interface AuditLogPage {
	entries: AuditLogEntry[];
	total: number;
	page: number;
	pageSize: number;
}
