/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * QIC Error Code Map
 * Phase 6 - Prompt 06-03: Error Display
 * GAP-07 Amendment: Complete Error Code Mapping
 */

import type { ErrorDisplayConfig } from '../types/errors.js';

export const ERROR_CODE_MAP: Record<string, ErrorDisplayConfig> = {
	// ═══════════════════════════════════════════════════════════════════
	// Tool Errors (QIC-T0XX)
	// ═══════════════════════════════════════════════════════════════════
	'QIC-T001': {
		title: 'Tool Not Found',
		message: 'The requested tool is not available.',
		severity: 'error',
		displayMethod: 'inline',
		recoveryAction: 'Try a different approach',
	},
	'QIC-T002': {
		title: 'Tool Execution Failed',
		message: 'The tool encountered an error during execution.',
		severity: 'error',
		displayMethod: 'inline',
		recoveryAction: 'Retry',
		recoveryCommand: 'qic.retryLastTool',
	},
	'QIC-T003': {
		title: 'Tool Timeout',
		message: 'The tool took too long to complete.',
		severity: 'warning',
		displayMethod: 'inline',
		recoveryAction: 'Retry',
		recoveryCommand: 'qic.retryLastTool',
	},
	'QIC-T004': {
		title: 'Tool Permission Denied',
		message: 'You denied permission for this tool.',
		severity: 'info',
		displayMethod: 'inline',
		autoDismiss: 5000,
	},
	'QIC-T005': {
		title: 'Tool Arguments Invalid',
		message: 'The tool received invalid arguments.',
		severity: 'error',
		displayMethod: 'inline',
	},

	// ═══════════════════════════════════════════════════════════════════
	// Provider Errors (QIC-P0XX)
	// ═══════════════════════════════════════════════════════════════════
	'QIC-P001': {
		title: 'Provider Unavailable',
		message: 'The LLM provider is currently unavailable.',
		severity: 'error',
		displayMethod: 'banner',
		recoveryAction: 'Switch Provider',
		recoveryCommand: 'qic.showProviderQuickPick',
	},
	'QIC-P002': {
		title: 'Provider Degraded',
		message: 'Some features may be limited due to provider issues.',
		severity: 'warning',
		displayMethod: 'toast',
		autoDismiss: 10000,
	},
	'QIC-P003': {
		title: 'Model Not Available',
		message: 'The requested model is not available.',
		severity: 'error',
		displayMethod: 'inline',
		recoveryAction: 'Use default model',
	},
	'QIC-P004': {
		title: 'Context Too Large',
		message: 'The context exceeds the model\'s limit.',
		severity: 'error',
		displayMethod: 'inline',
		recoveryAction: 'Reduce context',
		recoveryCommand: 'qic.showContextDrawer',
	},
	'QIC-P005': {
		title: 'Rate Limited',
		message: 'Too many requests. Please wait before trying again.',
		severity: 'warning',
		displayMethod: 'banner',
		recoveryAction: 'Retry in {countdown}',
		autoDismiss: 0, // Show countdown
	},
	'QIC-P006': {
		title: 'Authentication Failed',
		message: 'Your API key is invalid or expired.',
		severity: 'critical',
		displayMethod: 'modal',
		recoveryAction: 'Re-authenticate',
		recoveryCommand: 'qic.configureAuth',
	},

	// ═══════════════════════════════════════════════════════════════════
	// Network Errors (QIC-N0XX)
	// ═══════════════════════════════════════════════════════════════════
	'QIC-N001': {
		title: 'Connection Failed',
		message: 'Unable to connect to the QIC service.',
		severity: 'error',
		displayMethod: 'banner',
		recoveryAction: 'Retry',
		recoveryCommand: 'qic.testConnection',
	},
	'QIC-N002': {
		title: 'Request Timeout',
		message: 'The request timed out. Please try again.',
		severity: 'warning',
		displayMethod: 'inline',
		recoveryAction: 'Retry',
	},
	'QIC-N003': {
		title: 'Offline',
		message: 'You appear to be offline.',
		severity: 'warning',
		displayMethod: 'banner',
		autoDismiss: 0, // Persists until online
	},
	'QIC-N004': {
		title: 'Server Error',
		message: 'The QIC server encountered an error.',
		severity: 'error',
		displayMethod: 'inline',
		recoveryAction: 'Report Issue',
		recoveryCommand: 'qic.reportIssue',
	},

	// ═══════════════════════════════════════════════════════════════════
	// Conversation Errors (QIC-C0XX)
	// ═══════════════════════════════════════════════════════════════════
	'QIC-C001': {
		title: 'Conversation Not Found',
		message: 'The conversation could not be loaded.',
		severity: 'error',
		displayMethod: 'toast',
		recoveryAction: 'Start New',
		recoveryCommand: 'qic.newConversation',
	},
	'QIC-C002': {
		title: 'Message Too Long',
		message: 'Your message exceeds the maximum length.',
		severity: 'warning',
		displayMethod: 'inline',
		autoDismiss: 5000,
	},
	'QIC-C003': {
		title: 'Empty Message',
		message: 'Please enter a message.',
		severity: 'info',
		displayMethod: 'inline',
		autoDismiss: 3000,
	},

	// ═══════════════════════════════════════════════════════════════════
	// File/Change Errors (QIC-F0XX)
	// ═══════════════════════════════════════════════════════════════════
	'QIC-F001': {
		title: 'File Not Found',
		message: 'The file could not be found.',
		severity: 'error',
		displayMethod: 'inline',
	},
	'QIC-F002': {
		title: 'File Read Error',
		message: 'Unable to read the file.',
		severity: 'error',
		displayMethod: 'inline',
	},
	'QIC-F003': {
		title: 'File Write Error',
		message: 'Unable to write changes to the file.',
		severity: 'error',
		displayMethod: 'inline',
		recoveryAction: 'Retry',
	},
	'QIC-F004': {
		title: 'File Conflict',
		message: 'The file has been modified since the changes were generated.',
		severity: 'warning',
		displayMethod: 'inline',
		recoveryAction: 'Regenerate',
		recoveryCommand: 'qic.regenerateChanges',
	},

	// ═══════════════════════════════════════════════════════════════════
	// Cancellation (QIC-Y0XX)
	// ═══════════════════════════════════════════════════════════════════
	'QIC-Y001': {
		title: 'Request Cancelled',
		message: 'The request was cancelled.',
		severity: 'info',
		displayMethod: 'inline',
		autoDismiss: 3000,
	},
	'QIC-Y002': {
		title: 'Operation Cancelled',
		message: 'The operation was cancelled by user.',
		severity: 'info',
		displayMethod: 'toast',
		autoDismiss: 3000,
	},

	// ═══════════════════════════════════════════════════════════════════
	// Internal Errors (QIC-X0XX)
	// ═══════════════════════════════════════════════════════════════════
	'QIC-X001': {
		title: 'Internal Error',
		message: 'An unexpected error occurred.',
		severity: 'error',
		displayMethod: 'inline',
		recoveryAction: 'Report Issue',
		recoveryCommand: 'qic.reportIssue',
	},
	'QIC-X002': {
		title: 'State Sync Error',
		message: 'State synchronization failed. Refreshing...',
		severity: 'warning',
		displayMethod: 'toast',
		recoveryCommand: 'qic.refreshState',
	},
};

/**
 * Get error display config by code
 */
export function getErrorConfig(code: string): ErrorDisplayConfig {
	return ERROR_CODE_MAP[code] || ERROR_CODE_MAP['QIC-X001'];
}

/**
 * Check if an error code exists
 */
export function isKnownErrorCode(code: string): boolean {
	return code in ERROR_CODE_MAP;
}
