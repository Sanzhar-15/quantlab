/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cancel & Timeout Types
 * Phase 6 - Prompt 06-10: Cancel Semantics & Timeout Handling
 * GAP-02 and GAP-10 FIX
 */

export type CancelReason =
	| 'user_requested'
	| 'timeout'
	| 'error'
	| 'navigation'
	| 'panel_closed';

export interface CancelResult {
	reason: CancelReason;
	preservePartial: boolean;
	messageId?: string;
	partialContent?: string;
}

export interface TimeoutWarning {
	stage: 'processing' | 'waiting_approval' | 'tool_execution';
	elapsed: number;
	threshold: number;
	message: string;
}

export interface TimeoutConfig {
	warningThreshold: number;  // Show warning after this (ms)
	hardTimeout: number;       // Auto-cancel after this (ms)
	showRetry: boolean;
}

export type CancelScenario =
	| 'pre-stream'
	| 'mid-stream'
	| 'tool-pending'
	| 'permission-pending'
	| 'approval-pending';

export interface CancelScenarioConfig {
	effect: 'clear_pending' | 'finalize_partial' | 'abort_tool' | 'deny_permission' | 'dismiss_changes';
	preservePartial: boolean;
	confirmRequired: boolean;
	confirmMessage?: string;
}
