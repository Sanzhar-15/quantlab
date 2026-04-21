/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * QIC Error Factory
 * Phase 6 - Prompt 06-03: Error Display
 *
 * Factory for creating standardized QIC errors with appropriate
 * severity, messages, and recovery options.
 */

import type { QicError, ErrorCategory } from '../types/errors.js';

let errorCounter = 0;

function generateErrorId(): string {
	return `err_${Date.now()}_${++errorCounter}`;
}

export class QicErrorFactory {

	/**
	 * Create a connection error
	 */
	static connectionError(details?: string): QicError {
		return {
			id: generateErrorId(),
			code: 'QIC-N001',
			category: 'connection',
			severity: 'error',
			title: 'Connection Error',
			message: 'Unable to connect to the AI service. Please check your internet connection.',
			details,
			timestamp: Date.now(),
			recoverable: true,
			retryAction: 'Reconnect',
			retryCommand: 'qic.testConnection',
		};
	}

	/**
	 * Create a rate limit error
	 */
	static rateLimitError(resetTime?: Date): QicError {
		const resetMsg = resetTime
			? ` Try again after ${resetTime.toLocaleTimeString()}.`
			: ' Please wait a moment before trying again.';

		return {
			id: generateErrorId(),
			code: 'QIC-P005',
			category: 'rate_limit',
			severity: 'warning',
			title: 'Rate Limit Exceeded',
			message: `You've made too many requests.${resetMsg}`,
			timestamp: Date.now(),
			recoverable: true,
			retryAction: 'Retry',
		};
	}

	/**
	 * Create an authentication error
	 */
	static authError(details?: string): QicError {
		return {
			id: generateErrorId(),
			code: 'QIC-P006',
			category: 'authentication',
			severity: 'critical',
			title: 'Authentication Failed',
			message: 'Your API key is invalid or expired. Please update your credentials.',
			details,
			timestamp: Date.now(),
			recoverable: false,
			helpLink: 'command:qic.openSettings',
		};
	}

	/**
	 * Create a validation error
	 */
	static validationError(field: string, message: string): QicError {
		return {
			id: generateErrorId(),
			code: 'QIC-C002',
			category: 'validation',
			severity: 'warning',
			title: 'Invalid Input',
			message: message,
			timestamp: Date.now(),
			recoverable: true,
			component: field,
		};
	}

	/**
	 * Create an operation error
	 */
	static operationError(operation: string, details?: string): QicError {
		return {
			id: generateErrorId(),
			code: 'QIC-T002',
			category: 'operation',
			severity: 'error',
			title: `${operation} Failed`,
			message: details || 'The operation could not be completed.',
			details,
			timestamp: Date.now(),
			recoverable: true,
			retryAction: 'Retry',
		};
	}

	/**
	 * Create a file error
	 */
	static fileError(filePath: string, operation: 'read' | 'write' | 'not_found' | 'conflict'): QicError {
		const codes: Record<string, string> = {
			read: 'QIC-F002',
			write: 'QIC-F003',
			not_found: 'QIC-F001',
			conflict: 'QIC-F004',
		};

		const messages: Record<string, string> = {
			read: `Unable to read file: ${filePath}`,
			write: `Unable to write to file: ${filePath}`,
			not_found: `File not found: ${filePath}`,
			conflict: `File has been modified: ${filePath}`,
		};

		return {
			id: generateErrorId(),
			code: codes[operation],
			category: 'file',
			severity: operation === 'conflict' ? 'warning' : 'error',
			title: operation === 'conflict' ? 'File Conflict' : 'File Error',
			message: messages[operation],
			timestamp: Date.now(),
			recoverable: operation !== 'not_found',
			retryAction: operation === 'conflict' ? 'Regenerate' : 'Retry',
			component: filePath,
		};
	}

	/**
	 * Create a tool error
	 */
	static toolError(toolName: string, error: 'not_found' | 'failed' | 'timeout' | 'denied' | 'invalid_args', details?: string): QicError {
		const codes: Record<string, string> = {
			not_found: 'QIC-T001',
			failed: 'QIC-T002',
			timeout: 'QIC-T003',
			denied: 'QIC-T004',
			invalid_args: 'QIC-T005',
		};

		const titles: Record<string, string> = {
			not_found: 'Tool Not Found',
			failed: 'Tool Execution Failed',
			timeout: 'Tool Timeout',
			denied: 'Tool Permission Denied',
			invalid_args: 'Invalid Tool Arguments',
		};

		const messages: Record<string, string> = {
			not_found: `The tool "${toolName}" is not available.`,
			failed: `The tool "${toolName}" encountered an error.`,
			timeout: `The tool "${toolName}" took too long to complete.`,
			denied: `Permission denied for tool "${toolName}".`,
			invalid_args: `Invalid arguments for tool "${toolName}".`,
		};

		return {
			id: generateErrorId(),
			code: codes[error],
			category: 'tool',
			severity: error === 'denied' ? 'info' : 'error',
			title: titles[error],
			message: messages[error],
			details,
			timestamp: Date.now(),
			recoverable: error !== 'not_found' && error !== 'invalid_args',
			retryAction: error === 'failed' || error === 'timeout' ? 'Retry' : undefined,
			component: toolName,
		};
	}

	/**
	 * Create a provider error
	 */
	static providerError(provider: string, error: 'unavailable' | 'degraded' | 'model_unavailable'): QicError {
		const codes: Record<string, string> = {
			unavailable: 'QIC-P001',
			degraded: 'QIC-P002',
			model_unavailable: 'QIC-P003',
		};

		const messages: Record<string, string> = {
			unavailable: `The provider "${provider}" is currently unavailable.`,
			degraded: `The provider "${provider}" is experiencing issues.`,
			model_unavailable: `The requested model is not available on "${provider}".`,
		};

		return {
			id: generateErrorId(),
			code: codes[error],
			category: 'provider',
			severity: error === 'degraded' ? 'warning' : 'error',
			title: error === 'degraded' ? 'Provider Degraded' : 'Provider Error',
			message: messages[error],
			timestamp: Date.now(),
			recoverable: true,
			retryAction: 'Switch Provider',
			retryCommand: 'qic.showProviderQuickPick',
			component: provider,
		};
	}

	/**
	 * Create a cancellation notice
	 */
	static cancellation(type: 'request' | 'operation'): QicError {
		return {
			id: generateErrorId(),
			code: type === 'request' ? 'QIC-Y001' : 'QIC-Y002',
			category: 'cancellation',
			severity: 'info',
			title: type === 'request' ? 'Request Cancelled' : 'Operation Cancelled',
			message: type === 'request' ? 'The request was cancelled.' : 'The operation was cancelled by user.',
			timestamp: Date.now(),
			recoverable: false,
		};
	}

	/**
	 * Create an internal error
	 */
	static internalError(details?: string): QicError {
		return {
			id: generateErrorId(),
			code: 'QIC-X001',
			category: 'internal',
			severity: 'error',
			title: 'Internal Error',
			message: 'An unexpected error occurred. Please try again.',
			details,
			timestamp: Date.now(),
			recoverable: true,
			retryAction: 'Report Issue',
			retryCommand: 'qic.reportIssue',
		};
	}

	/**
	 * Create a network error
	 */
	static networkError(type: 'timeout' | 'offline' | 'server_error', details?: string): QicError {
		const codes: Record<string, string> = {
			timeout: 'QIC-N002',
			offline: 'QIC-N003',
			server_error: 'QIC-N004',
		};

		const messages: Record<string, string> = {
			timeout: 'The request timed out. Please try again.',
			offline: 'You appear to be offline. Please check your connection.',
			server_error: 'The server encountered an error. Please try again later.',
		};

		return {
			id: generateErrorId(),
			code: codes[type],
			category: 'network',
			severity: type === 'offline' ? 'warning' : 'error',
			title: type === 'timeout' ? 'Request Timeout' : type === 'offline' ? 'Offline' : 'Server Error',
			message: messages[type],
			details,
			timestamp: Date.now(),
			recoverable: type !== 'offline',
			retryAction: type !== 'offline' ? 'Retry' : undefined,
		};
	}

	/**
	 * Create a context error (context too large)
	 */
	static contextTooLargeError(currentSize: number, maxSize: number): QicError {
		return {
			id: generateErrorId(),
			code: 'QIC-P004',
			category: 'provider',
			severity: 'error',
			title: 'Context Too Large',
			message: `The context (${formatSize(currentSize)}) exceeds the model's limit (${formatSize(maxSize)}).`,
			timestamp: Date.now(),
			recoverable: true,
			retryAction: 'Reduce context',
			retryCommand: 'qic.showContextDrawer',
		};
	}

	/**
	 * Create a generic error from any Error object
	 */
	static fromError(error: Error, category: ErrorCategory = 'internal'): QicError {
		return {
			id: generateErrorId(),
			code: 'QIC-X001',
			category,
			severity: 'error',
			title: 'Error',
			message: error.message || 'An unexpected error occurred.',
			details: error.stack,
			timestamp: Date.now(),
			recoverable: true,
		};
	}
}

function formatSize(tokens: number): string {
	if (tokens >= 1000000) {
		return `${(tokens / 1000000).toFixed(1)}M tokens`;
	}
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}K tokens`;
	}
	return `${tokens} tokens`;
}
