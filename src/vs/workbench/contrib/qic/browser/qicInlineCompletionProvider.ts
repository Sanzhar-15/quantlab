/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CompletionEngine } from '../common/completion/completionEngine.js';
import type { QualitySignalService } from '../common/telemetry/qualitySignalService.js';

/**
 * Completion result with tracking metadata for quality signal instrumentation.
 */
export interface TrackedCompletion {
	insertText: string;
	/** Tracking ID for pairing with accept/reject signals */
	trackingId: string;
	/** Model used for this completion */
	model: string;
	/** Lane used for this completion */
	lane: string;
	/** File path where completion was generated */
	filePath: string;
	/** Cursor offset at time of generation */
	offset: number;
	/** Timestamp of generation */
	timestamp: number;
}

/**
 * Quantlab inline completion provider registration info (Audit IX-CC2).
 *
 * Registers QIC as a standard InlineCompletionProvider via
 * languageFeaturesService.inlineCompletionsProvider.register().
 *
 * Does NOT create a second InlineCompletionsController -- Quantlab already has one.
 * QIC plugs into the existing controller as a registered provider.
 *
 * groupId: 'qic-ai'
 * yieldsToGroupIds: []  (Quantlab ships no other inline-completion provider group to yield to)
 *
 * Quality signal integration: tracks completion shown/accepted/rejected
 * for Phase 5 data pipeline prerequisites.
 */
export class QicInlineCompletionProvider {

	static readonly groupId = 'qic-ai';
	static readonly yieldsToGroupIds: string[] = [];

	/** Most recent completion for tracking acceptance */
	private _lastCompletion: TrackedCompletion | null = null;

	constructor(
		private readonly completionEngine: CompletionEngine,
		private readonly qualitySignalService?: QualitySignalService,
	) { }

	/**
	 * Get the last completion for acceptance tracking.
	 * Called by the adapter when VS Code accepts a completion.
	 */
	getLastCompletion(): TrackedCompletion | null {
		return this._lastCompletion;
	}

	/**
	 * Track that a completion was accepted by the user.
	 * Called by the adapter when VS Code accepts a completion.
	 */
	trackAccepted(completion: TrackedCompletion): void {
		if (!this.qualitySignalService) { return; }
		this.qualitySignalService.trackCompletionAccepted({
			text: completion.insertText,
			filePath: completion.filePath,
			offset: completion.offset,
			timestamp: completion.timestamp,
			model: completion.model,
			lane: completion.lane,
		});
		this._lastCompletion = null;
	}

	/**
	 * Track that a completion was rejected/dismissed by the user.
	 * Called by the adapter when VS Code dismisses a completion.
	 */
	trackRejected(completion: TrackedCompletion): void {
		if (!this.qualitySignalService) { return; }
		this.qualitySignalService.trackCompletionRejected(
			completion.lane,
			completion.model,
			completion.filePath,
		);
		this._lastCompletion = null;
	}

	/**
	 * Provide inline completions for the given model and position.
	 *
	 * In the real integration (Prompt 18), this implements IInlineCompletionsProvider
	 * and is registered via:
	 *   languageFeaturesService.inlineCompletionsProvider.register('*', provider)
	 */
	async provideInlineCompletions(
		documentText: string,
		cursorOffset: number,
		languageId: string,
		filePath: string,
		signal: AbortSignal,
	): Promise<Array<TrackedCompletion>> {
		const prefix = documentText.slice(0, cursorOffset);
		const suffix = documentText.slice(cursorOffset);

		const result = await this.completionEngine.provideCompletions(
			{ prefix, suffix, language: languageId, filePath },
			signal,
		);

		if (!result) {
			return [];
		}

		const timestamp = Date.now();
		const completion: TrackedCompletion = {
			insertText: result.text,
			trackingId: `${filePath}:${cursorOffset}:${timestamp}`,
			model: result.model ?? 'unknown',
			lane: 'completion',
			filePath,
			offset: cursorOffset,
			timestamp,
		};

		// Track completion shown
		if (this.qualitySignalService) {
			this.qualitySignalService.trackCompletionShown({
				text: result.text,
				filePath,
				offset: cursorOffset,
				timestamp,
				model: result.model ?? 'unknown',
				lane: 'completion',
			});
		}

		// Store for acceptance tracking
		this._lastCompletion = completion;

		return [completion];
	}

	freeInlineCompletions(_completions: Array<TrackedCompletion>): void {
		// Note: VS Code calls freeInlineCompletions for BOTH acceptance and rejection.
		// We cannot distinguish the two cases at the provider level.
		// Accept/reject tracking requires document change correlation (Phase 5b).
		// For now, we only track "shown" events; accept/reject are deferred.
		this._lastCompletion = null;
	}

	/**
	 * Called when we can confirm a completion was accepted (via document change correlation).
	 * This is invoked by external integration code, not by VS Code's provider lifecycle.
	 */
	confirmAcceptance(completion: TrackedCompletion): void {
		this.trackAccepted(completion);
	}

	/**
	 * Called when we can confirm a completion was rejected (via timeout or new completion request).
	 * This is invoked by external integration code, not by VS Code's provider lifecycle.
	 */
	confirmRejection(completion: TrackedCompletion): void {
		this.trackRejected(completion);
	}
}
