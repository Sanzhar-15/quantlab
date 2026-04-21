/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolCall, ToolResult, ToolContext } from '../canonical/types.js';
import type { ToolRouter } from './toolRouter.js';
import type { CancellationScope } from '../cancellation/cancellationManager.js';
import { TOOL_REGISTRY } from '../canonical/tools.js';

export interface PlanStep {
	id: string;
	description: string;
	toolCalls: ToolCall[];
	dependsOn?: string[];
}

export interface StepContext {
	toolContext: ToolContext;
	cancellationScope: CancellationScope;
}

export interface StepResult {
	stepId: string;
	success: boolean;
	toolResults: ToolResult[];
	error?: string;
}

/**
 * Executes individual plan steps.
 * Read-only tool calls within a step execute in parallel; mixed batches run sequentially.
 */
export class StepExecutor {

	constructor(
		private readonly toolRouter: ToolRouter,
	) {}

	async execute(step: PlanStep, context: StepContext): Promise<StepResult> {
		const toolResults: ToolResult[] = [];

		// Check if all tools in this step are read-only
		const allReadOnly = step.toolCalls.every(tc => {
			const def = TOOL_REGISTRY[tc.name];
			return def && !def.hasSideEffects;
		});

		if (allReadOnly && step.toolCalls.length > 1) {
			// Parallel execution for all-read-only steps
			if (context.cancellationScope.isCancelled) {
				return { stepId: step.id, success: false, toolResults, error: 'Step cancelled' };
			}

			const settled = await Promise.allSettled(
				step.toolCalls.map(tc => this.toolRouter.execute(tc, context.toolContext))
			);

			for (let i = 0; i < step.toolCalls.length; i++) {
				const outcome = settled[i];
				if (outcome.status === 'fulfilled') {
					toolResults.push(outcome.value);
					if (outcome.value.isError) {
						return {
							stepId: step.id,
							success: false,
							toolResults,
							error: `Tool '${step.toolCalls[i].name}' failed: ${outcome.value.content}`,
						};
					}
				} else {
					const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
					toolResults.push({ toolCallId: step.toolCalls[i].id, content: errMsg, isError: true });
					return {
						stepId: step.id,
						success: false,
						toolResults,
						error: `Tool '${step.toolCalls[i].name}' failed: ${errMsg}`,
					};
				}
			}
		} else {
			// Sequential execution (original behavior)
			for (const toolCall of step.toolCalls) {
				if (context.cancellationScope.isCancelled) {
					return { stepId: step.id, success: false, toolResults, error: 'Step cancelled' };
				}

				const result = await this.toolRouter.execute(toolCall, context.toolContext);
				toolResults.push(result);

				if (result.isError) {
					return {
						stepId: step.id,
						success: false,
						toolResults,
						error: `Tool '${toolCall.name}' failed: ${result.content}`,
					};
				}
			}
		}

		return { stepId: step.id, success: true, toolResults };
	}
}
