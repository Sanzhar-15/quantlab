/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lane & Feedback Types
 * Phase 6 - Prompt 06-11: Lane Indicator & Feedback Buttons
 * GAP-12 and GAP-14 FIX
 */

export type Lane = 'chat-ask' | 'chat-gather' | 'chat-plan' | 'chat-act';

export interface LaneConfig {
	name: string;
	displayName: string;
	icon: string;
	maxContext: number;
	maxResponse: number;
	description: string;
}

export const LANE_CONFIGS: Record<Lane, LaneConfig> = {
	'chat-ask': {
		name: 'chat-ask',
		displayName: 'Ask',
		icon: 'comment-discussion',
		maxContext: 16000,
		maxResponse: 8000,
		description: 'Answer questions about code',
	},
	'chat-gather': {
		name: 'chat-gather',
		displayName: 'Gather',
		icon: 'search',
		maxContext: 32000,
		maxResponse: 16000,
		description: 'Gather context for complex tasks',
	},
	'chat-plan': {
		name: 'chat-plan',
		displayName: 'Plan',
		icon: 'checklist',
		maxContext: 64000,
		maxResponse: 16000,
		description: 'Plan implementation strategy',
	},
	'chat-act': {
		name: 'chat-act',
		displayName: 'Code',
		icon: 'code',
		maxContext: 200000,
		maxResponse: 32000,
		description: 'Execute code changes',
	},
};

// Feedback types
export type FeedbackRating = 'positive' | 'negative';

export interface FeedbackPayload {
	messageId: string;
	rating: FeedbackRating;
	comment?: string;
	tags?: string[];
}

export type FeedbackTag = 'incorrect' | 'incomplete' | 'confusing' | 'slow';
