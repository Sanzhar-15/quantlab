/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LaneName } from '../canonical/lanes.js';
import { LANE_CONFIGURATIONS } from '../canonical/lanes.js';
import { TOOL_REGISTRY } from '../canonical/tools.js';
import type { ToolDefinition } from '../canonical/types.js';
import { tokenCounter } from '../canonical/tokenCounter.js';

const ESSENTIAL_TOOLS = ['read_file', 'write_file', 'edit_file', 'search_code', 'create_directory', 'list_directory', 'run_command'];
const DEFAULT_MAX_TOKEN_BUDGET = 4000;

/**
 * Dynamic tool selector that picks tools within token budget
 * based on lane configuration and semantic relevance.
 */
export class DynamicToolSelector {

	selectTools(
		lane: LaneName,
		userMessage: string,
		maxTokenBudget = DEFAULT_MAX_TOKEN_BUDGET,
	): ToolDefinition[] {
		const laneConfig = LANE_CONFIGURATIONS[lane];
		const allowedToolNames = laneConfig.allowedTools;

		// No tools for lanes with empty tool list
		if (allowedToolNames.length === 0) {
			return [];
		}

		// Get all candidate tools
		let candidates: ToolDefinition[];
		if (allowedToolNames.includes('*')) {
			candidates = Object.values(TOOL_REGISTRY).filter(t => t.status !== 'not-yet-implemented');
		} else {
			candidates = allowedToolNames
				.map(name => TOOL_REGISTRY[name])
				.filter((t): t is ToolDefinition => t !== undefined && t.status !== 'not-yet-implemented');
		}

		// Essential tools always included
		const essential = candidates.filter(t => ESSENTIAL_TOOLS.includes(t.name));
		const optional = candidates.filter(t => !ESSENTIAL_TOOLS.includes(t.name));

		// Score optional tools by relevance to user message
		const scored = optional.map(tool => ({
			tool,
			relevance: this.scoreRelevance(tool, userMessage),
		})).sort((a, b) => b.relevance - a.relevance);

		// Fill within token budget
		const selected: ToolDefinition[] = [...essential];
		let usedTokens = this.estimateToolTokens(selected);

		for (const { tool } of scored) {
			const toolTokens = this.estimateToolTokens([tool]);
			if (usedTokens + toolTokens > maxTokenBudget) { break; }
			selected.push(tool);
			usedTokens += toolTokens;
		}

		return selected;
	}

	private scoreRelevance(tool: ToolDefinition, userMessage: string): number {
		const message = userMessage.toLowerCase();
		let score = 0;

		// Name matching
		const nameWords = tool.name.split('_');
		for (const word of nameWords) {
			if (message.includes(word)) { score += 2; }
		}

		// Description matching
		const descWords = tool.description.toLowerCase().split(/\s+/);
		for (const word of descWords) {
			if (word.length > 3 && message.includes(word)) { score += 1; }
		}

		// Keyword heuristics
		if (message.includes('file') && tool.name.includes('file')) { score += 3; }
		if (message.includes('search') && tool.name.includes('search')) { score += 3; }
		if (message.includes('git') && tool.name.includes('git')) { score += 3; }
		if (message.includes('run') && tool.name === 'run_command') { score += 3; }
		if (message.includes('test') && tool.name === 'run_command') { score += 2; }
		if (message.includes('notebook') && tool.name === 'inspect_notebook') { score += 3; }
		if (message.includes('dataframe') && tool.name === 'preview_dataframe') { score += 3; }
		if (message.includes('backtest') && tool.name === 'analyze_backtest') { score += 3; }

		// edit_file vs write_file keyword scoring
		if (tool.name === 'edit_file') {
			for (const kw of ['edit', 'change', 'modify', 'replace', 'update', 'fix', 'refactor']) {
				if (message.includes(kw)) { score += 3; }
			}
		}
		if (tool.name === 'write_file') {
			for (const kw of ['create', 'new file', 'generate']) {
				if (message.includes(kw)) { score += 3; }
			}
		}

		return score;
	}

	private estimateToolTokens(tools: ToolDefinition[]): number {
		let total = 0;
		for (const tool of tools) {
			const schema = JSON.stringify(tool.parameters);
			total += tokenCounter.count(tool.name + tool.description + schema);
		}
		return total;
	}
}
