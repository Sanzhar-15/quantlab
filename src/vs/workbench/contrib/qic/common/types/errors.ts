/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * QIC Error Types
 * Phase 6 - Prompt 06-03: Error Display
 */

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export type ErrorCategory =
	| 'connection'
	| 'authentication'
	| 'rate_limit'
	| 'validation'
	| 'operation'
	| 'tool'
	| 'provider'
	| 'network'
	| 'conversation'
	| 'file'
	| 'cancellation'
	| 'internal';

export interface QicError {
	id: string;
	code?: string;
	category: ErrorCategory;
	severity: ErrorSeverity;
	title: string;
	message: string;
	details?: string;
	timestamp: number;

	// Recovery
	recoverable: boolean;
	retryAction?: string;
	retryCommand?: string;
	helpLink?: string;

	// Context
	component?: string;
	operationId?: string;
}

export interface ErrorDisplayOptions {
	showInline?: boolean;       // Show in conversation
	showNotification?: boolean; // Show VS Code notification
	showStatusBar?: boolean;    // Show in status bar
	showToast?: boolean;        // Show toast notification
	showBanner?: boolean;       // Show banner at top
	autoDismiss?: number;       // Auto-dismiss after ms (0 = never)
}

export type ErrorDisplayMethod = 'toast' | 'inline' | 'banner' | 'modal';

export interface ErrorDisplayConfig {
	title: string;
	message: string;
	severity: ErrorSeverity;
	displayMethod: ErrorDisplayMethod;
	recoveryAction?: string;
	recoveryCommand?: string;
	autoDismiss?: number; // ms, 0 = never
}
