/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type LaneName =
	| 'completion'
	| 'chat-ask'
	| 'chat-gather'
	| 'chat-plan'
	| 'chat-act'
	| 'repair'
	| 'fast-apply'
	| 'summarize';

export interface LaneConfiguration {
	name: LaneName;
	promptKey: string;
	maxTokens: number;
	inputTokenBudget: number;
	allowedTools: string[];
	temperature: number;
	description: string;
}

export const LANE_CONFIGURATIONS: Record<LaneName, LaneConfiguration> = {
	'completion': {
		name: 'completion',
		promptKey: 'completion',
		maxTokens: 4096,
		inputTokenBudget: 4096,
		allowedTools: [],
		temperature: 0.0,
		description: 'Inline code completion (FIM)',
	},
	'chat-ask': {
		name: 'chat-ask',
		promptKey: 'chat-ask',
		maxTokens: 8192,
		inputTokenBudget: 16_000,
		allowedTools: ['read_file', 'search_code', 'search_files', 'get_references', 'get_definition', 'list_directory', 'preview_dataframe', 'inspect_notebook', 'git_status', 'git_log'],
		temperature: 0.15, // BYOK Optimization: Lower temperature for more concise, factual responses
		description: 'Answer questions about code',
	},
	'chat-gather': {
		name: 'chat-gather',
		promptKey: 'chat-gather',
		maxTokens: 16_384,
		inputTokenBudget: 32_000,
		allowedTools: ['read_file', 'search_code', 'search_files', 'get_references', 'get_definition', 'list_directory', 'git_status', 'git_log', 'git_diff'],
		temperature: 0.2,
		description: 'Gather context for planning',
	},
	'chat-plan': {
		name: 'chat-plan',
		promptKey: 'chat-plan',
		maxTokens: 16_384,
		inputTokenBudget: 32_000,
		allowedTools: ['read_file', 'search_code', 'search_files', 'get_references', 'get_definition', 'list_directory', 'git_status', 'git_log', 'git_diff'],
		temperature: 0.25, // BYOK Optimization: Balanced temperature for structured planning
		description: 'Generate implementation plan',
	},
	'chat-act': {
		name: 'chat-act',
		promptKey: 'chat-act',
		maxTokens: 32_768,
		inputTokenBudget: 200_000,
		allowedTools: ['*'],
		temperature: 0.2,
		description: 'Execute plan with tools',
	},
	'repair': {
		name: 'repair',
		promptKey: 'repair',
		maxTokens: 8192,
		inputTokenBudget: 32_000,
		allowedTools: ['read_file', 'write_file', 'edit_file', 'search_code', 'run_command'],
		temperature: 0.1,
		description: 'Fix errors after tool execution',
	},
	'fast-apply': {
		name: 'fast-apply',
		promptKey: 'fast-apply',
		maxTokens: 8192,
		inputTokenBudget: 16_000,
		allowedTools: ['read_file', 'write_file', 'edit_file'],
		temperature: 0.0,
		description: 'Quick inline edit application',
	},
	'summarize': {
		name: 'summarize',
		promptKey: 'summarize',
		maxTokens: 4096,
		inputTokenBudget: 16_000,
		allowedTools: [],
		temperature: 0.1, // BYOK Optimization: Low temperature for consistent, factual summarization
		description: 'Compress conversation history when context window exceeded',
	},
};
