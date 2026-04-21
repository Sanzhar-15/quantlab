/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Summarization Types
 * Phase 6 - Prompt 06-12: Summarization Notification
 * GAP-09 FIX
 */

export interface SummarizationEvent {
	type: 'started' | 'completed' | 'failed';
	conversationId: string;
	messageCount?: number;      // Messages summarized
	tokensBefore?: number;      // Tokens before summarization
	tokensAfter?: number;       // Tokens after summarization
	tokensSaved?: number;       // Tokens freed up
	summary?: string;           // The summary text
	error?: string;
}

export interface SummarizationState {
	inProgress: boolean;
	lastSummarizedAt: number | null;
	totalSummarizations: number;
	totalTokensSaved: number;
}

export interface SummarizationResult {
	summarizedCount: number;
	tokensBefore: number;
	tokensAfter: number;
	summaryText: string;
}
