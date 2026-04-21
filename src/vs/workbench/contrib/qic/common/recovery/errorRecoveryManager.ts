/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { QicError } from '../canonical/types.js';

export type ErrorTier = 'transient' | 'retriable' | 'degradable' | 'fatal';

export interface ErrorClassification {
	tier: ErrorTier;
	retryable: boolean;
	maxRetries: number;
	backoffMs: number;
	degradedMode?: string;
}

export interface RecoveryContext {
	operation: string;
	sessionId: string;
	attemptNumber: number;
	maxAttempts: number;
}

export interface RecoveryResult {
	recovered: boolean;
	action: 'retry' | 'degrade' | 'abort' | 'emergency-save';
	message: string;
}

/**
 * 4-tier error classification and recovery system.
 */
export class ErrorRecoveryManager {
	private readonly emergencySaveCallbacks: Array<() => Promise<void>> = [];

	registerEmergencySaveCallback(cb: () => Promise<void>): void {
		this.emergencySaveCallbacks.push(cb);
	}

	classify(error: Error): ErrorClassification {
		// Transient: network timeouts, temporary failures
		if (this.isTransient(error)) {
			return { tier: 'transient', retryable: true, maxRetries: 3, backoffMs: 1000 };
		}

		// Retriable: rate limits, temporary service issues
		if (this.isRetriable(error)) {
			return { tier: 'retriable', retryable: true, maxRetries: 5, backoffMs: 5000 };
		}

		// Degradable: partial failures where system can continue with reduced functionality
		if (this.isDegradable(error)) {
			return {
				tier: 'degradable',
				retryable: false,
				maxRetries: 0,
				backoffMs: 0,
				degradedMode: this.getDegradedMode(error),
			};
		}

		// Fatal: unrecoverable
		return { tier: 'fatal', retryable: false, maxRetries: 0, backoffMs: 0 };
	}

	async executeRecovery(error: Error, context: RecoveryContext): Promise<RecoveryResult> {
		const classification = this.classify(error);

		if (classification.retryable && context.attemptNumber < classification.maxRetries) {
			await this.delay(classification.backoffMs * Math.pow(2, context.attemptNumber));
			return {
				recovered: true,
				action: 'retry',
				message: `Retrying ${context.operation} (attempt ${context.attemptNumber + 1}/${classification.maxRetries})`,
			};
		}

		if (classification.degradedMode) {
			return {
				recovered: true,
				action: 'degrade',
				message: `Entering degraded mode: ${classification.degradedMode}`,
			};
		}

		if (classification.tier === 'fatal') {
			await this.emergencySave();
			return {
				recovered: false,
				action: 'emergency-save',
				message: `Fatal error in ${context.operation}. Emergency save completed.`,
			};
		}

		return {
			recovered: false,
			action: 'abort',
			message: `Unrecoverable error in ${context.operation}: ${error.message}`,
		};
	}

	async escalate(error: Error, failedTier: ErrorTier): Promise<RecoveryResult> {
		const tierOrder: ErrorTier[] = ['transient', 'retriable', 'degradable', 'fatal'];
		const currentIdx = tierOrder.indexOf(failedTier);
		const nextTier = tierOrder[currentIdx + 1] ?? 'fatal';

		if (nextTier === 'fatal') {
			await this.emergencySave();
			return {
				recovered: false,
				action: 'emergency-save',
				message: `Escalated to fatal. Emergency save completed.`,
			};
		}

		return {
			recovered: nextTier === 'degradable',
			action: nextTier === 'degradable' ? 'degrade' : 'abort',
			message: `Escalated from ${failedTier} to ${nextTier}: ${error.message}`,
		};
	}

	async emergencySave(): Promise<void> {
		const results = await Promise.allSettled(
			this.emergencySaveCallbacks.map(cb => cb()),
		);
		const failures = results.filter(r => r.status === 'rejected');
		if (failures.length > 0) {
			console.error(`Emergency save: ${failures.length} callbacks failed`);
		}
	}

	private isTransient(error: Error): boolean {
		const transientCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'];
		if ('code' in error && transientCodes.includes(String((error as any).code))) {
			return true;
		}
		if (error instanceof QicError) {
			return ['QIC-N001', 'QIC-N002', 'QIC-T003'].includes(error.code);
		}
		return false;
	}

	private isRetriable(error: Error): boolean {
		if (error instanceof QicError) {
			return ['QIC-P005', 'QIC-N003', 'QIC-G001'].includes(error.code);
		}
		if (error.message.includes('rate limit') || error.message.includes('429')) {
			return true;
		}
		return false;
	}

	private isDegradable(error: Error): boolean {
		if (error instanceof QicError) {
			return ['QIC-C001', 'QIC-C002', 'QIC-C003', 'QIC-P004'].includes(error.code);
		}
		return false;
	}

	private getDegradedMode(error: Error): string {
		if (error instanceof QicError) {
			switch (error.code) {
				case 'QIC-C001':
				case 'QIC-C002':
				case 'QIC-C003':
					return 'no-indexing';
				case 'QIC-P004':
					return 'local-only';
				default:
					return 'reduced';
			}
		}
		return 'reduced';
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
