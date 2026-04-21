/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolCall, ToolResult, ToolContext, ContentBlock, Message } from '../canonical/types.js';
import type { StreamChunk, UIService, GatewayRequest } from '../canonical/interfaces.js';
import type { LaneName } from '../canonical/lanes.js';
import { LANE_CONFIGURATIONS } from '../canonical/lanes.js';
import { tokenCounter } from '../canonical/tokenCounter.js';
import { PROMPT_TEMPLATES } from '../canonical/prompts.js';
import type { PersistentAgentStateMachine } from '../state/agentStateMachine.js';
import type { ConversationState } from '../state/conversationState.js';
import type { LaneRouter } from './laneRouter.js';
import type { ContextAssembler, ContextOptions } from '../context/contextAssembler.js';
import type { Gateway } from '../gateway/gateway.js';
import type { ToolRouter } from './toolRouter.js';
import type { StepExecutor } from './stepExecutor.js';
import type { MutationEngine } from '../mutation/mutationEngine.js';
import type { CancellationManager, CancellationScope } from '../cancellation/cancellationManager.js';
import { type TimeoutManager, TimeoutError } from '../timeout/timeoutManager.js';
import type { OptimizedSecretScanner } from '../security/secretScanner.js';
import type { ModelRegistry } from '../gateway/modelRegistry.js';
import type { QualitySignalService } from '../telemetry/qualitySignalService.js';
import type { DynamicToolSelector } from '../context/dynamicToolSelector.js';
import { TOOL_REGISTRY } from '../canonical/tools.js';
import { sha256Hex, randomUUID } from '../qicCrypto.js';
import { QIC_SETTINGS, type ResponseStyle } from '../constants.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

const MAX_TOOL_ROUNDS = 25;
const MAX_TOOL_RESULT_TOKENS = 10_000;     // XII-AR2: Per-result token limit
const MAX_CONVERSATION_TOKENS = 200_000;    // XII-AR2: Absolute conversation cap
const SUMMARIZE_THRESHOLD_RATIO = 0.8;      // I-SG5: Trigger summarize at 80% of budget
const BUDGET_OVERFLOW_RATIO = 1.5;          // XII-AR5: Truncate at 150% of lane budget
const SUMMARIZE_KEEP_EXCHANGES = 3;         // I-SG5: Keep last 3 user/assistant exchanges

interface QueuedMessage {
	text: string;
	timestamp: number;
	preferredProvider?: string;
}

/**
 * Core agentic loop orchestrator (Audit S-1, I-1).
 *
 * Implements the critical while-loop pattern that re-sends tool results
 * to the LLM, avoiding the broken for-await pattern from the original spec.
 *
 * Pipeline per message:
 *  1. Classify → lane
 *  2. Assemble context
 *  3. While-loop: send → stream → tool calls → execute → re-send
 *
 * Audit fixes applied: S-1, S-2, I-1, I-5, I-6, I-SG5, I-SG7,
 *   IV-AO5, X-PS2, X-PS3, XI-SV1, XII-AR2, XII-AR3, XII-AR5, III-QI4, II-PG3.
 */
export class AgentOrchestrator {

	private isProcessing = false;
	private readonly messageQueue: QueuedMessage[] = [];
	private currentScopeId: string | null = null;

	/** Turn counter for follow-up pattern detection */
	private turnIndex = 0;

	constructor(
		private readonly agentState: PersistentAgentStateMachine,
		private readonly conversationState: ConversationState,
		private readonly laneRouter: LaneRouter,
		private readonly contextAssembler: ContextAssembler,
		private readonly gateway: Gateway,
		private readonly toolRouter: ToolRouter,
		_stepExecutor: StepExecutor,
		_mutationEngine: MutationEngine,
		private readonly uiService: UIService,
		private readonly cancellationManager: CancellationManager,
		private readonly timeoutManager: TimeoutManager,
		private readonly secretScanner: OptimizedSecretScanner,
		private readonly workspacePath: string,
		private readonly modelRegistry?: ModelRegistry,
		private readonly qualitySignalService?: QualitySignalService,
		private readonly configurationService?: IConfigurationService,
		private readonly dynamicToolSelector?: DynamicToolSelector,
	) {}

	/** User-preferred provider for the current conversation (set via UI model selector) */
	private preferredProvider: string | undefined;

	/** Context options for the current message (active file, selected text, etc.) */
	private currentContextOptions: ContextOptions | undefined;

	/**
	 * Set the preferred provider for subsequent messages (called from UI model selector).
	 */
	setPreferredProvider(providerId: string | undefined): void {
		this.preferredProvider = providerId;
	}

	/**
	 * Main entry point — handles message queuing (I-5, IV-AO5),
	 * bypass routing (I-SG7), and summarize trigger (I-SG5).
	 */
	async handleUserMessage(text: string, preferredProvider?: string, contextOptions?: ContextOptions): Promise<void> {
		// Update preferred provider if specified
		if (preferredProvider) {
			this.preferredProvider = preferredProvider;
		}

		// Store context options for this message
		this.currentContextOptions = contextOptions;

		// IV-AO5: Queue if already processing
		if (this.isProcessing) {
			this.messageQueue.push({ text, timestamp: Date.now(), preferredProvider: this.preferredProvider });
			this.uiService.showInfo(
				`Message queued (${this.messageQueue.length} pending). You can cancel the current request.`
			);
			return;
		}

		this.isProcessing = true;
		const scopeId = `message-${Date.now()}`;
		this.currentScopeId = scopeId;

		try {
			await this.cancellationManager.executeWithScope(scopeId, async (scope) => {
				// I-SG7: Bypass routing for completion and fast-apply
				const lane = this.laneRouter.classify(text, this.conversationState);

				// I-SG5: Check if summarize is needed before processing (using current lane)
				await this.checkSummarizeTrigger(lane);

				if (lane === 'completion') {
					throw new Error('Completion lane must be handled by CompletionEngine, not the orchestrator');
				}

				if (lane === 'fast-apply') {
					await this.handleFastApply(text, scope);
					return;
				}

				await this.processMessage(text, lane, scope);
			});
		} catch (err) {
			// H1: Recover agent state to idle on any error
			if (this.agentState.getState() !== 'idle') {
				await this.agentState.transition('idle').catch(() => { /* best effort */ });
			}
			if (err instanceof Error && err.message.includes('cancelled')) {
				this.uiService.showInfo('Request cancelled.');
			} else {
				this.showError(err instanceof Error ? err : new Error(String(err)));
			}
		} finally {
			this.isProcessing = false;
			this.currentScopeId = null;

			// H9: Expire stale queued messages (>60s old)
			const now = Date.now();
			while (this.messageQueue.length > 0 && now - this.messageQueue[0].timestamp > 60_000) {
				this.messageQueue.shift();
			}

			// Process next queued message (non-recursive via setTimeout)
			if (this.messageQueue.length > 0) {
				const next = this.messageQueue.shift()!;
				setTimeout(() => {
					this.handleUserMessage(next.text, next.preferredProvider).catch(err => {
						this.showError(err instanceof Error ? err : new Error(String(err)));
					});
				}, 0);
			}
		}
	}

	/**
	 * Cancel the current request and let the finally block pick up the next (IV-AO5).
	 */
	async cancelCurrentAndProcessNext(): Promise<void> {
		if (this.currentScopeId) {
			await this.cancellationManager.cancel(this.currentScopeId, 'User cancelled');
		}
	}

	/**
	 * Start a new conversation — clear history, cancel in-flight, drain queue.
	 */
	async startNewConversation(): Promise<void> {
		await this.cancelCurrentAndProcessNext();
		this.messageQueue.length = 0;
		this.conversationState.clear();
		this.turnIndex = 0; // Reset turn counter for follow-up tracking
	}

	// Phase 3: Conversation persistence (optional, implemented by subclasses)
	save?(): Promise<void>;
	loadConversation?(id: string): Promise<void>;
	deleteConversation?(id: string): Promise<void>;

	/**
	 * THE CORE AGENTIC LOOP (Audit I-1 fix).
	 *
	 * Explicit while-loop: outer loop sends to gateway, inner loop reads stream.
	 * On tool_call → execute → append result → break inner to re-send.
	 * On done with no tool calls → return.
	 */
	private async processMessage(
		text: string,
		lane: LaneName,
		scope: CancellationScope,
	): Promise<void> {
		// 1. Set lane and add user message
		this.conversationState.setLane(lane);
		this.conversationState.addUserMessage(text);

		// Quality signal: track re-requests and follow-ups
		if (this.qualitySignalService) {
			const model = this.resolveModelForLane(lane);
			// Create context hash from lane + first N chars of text for re-request detection
			const contextHash = sha256Hex(`${lane}:${text.slice(0, 500)}`);
			this.qualitySignalService.trackRequest(contextHash, lane, model);

			// Track follow-ups: if this is not the first turn in the conversation
			this.turnIndex++;
			if (this.turnIndex > 1) {
				this.qualitySignalService.trackFollowUp(lane, model, this.turnIndex);
			}
		}

		// 2. Transition to processing
		await this.agentState.transition('processing');

		// 3. Assemble context with workspace awareness
		const responseStyle = this.configurationService?.getValue<ResponseStyle>(QIC_SETTINGS.RESPONSE_STYLE) ?? 'balanced';
		const contextOpts: ContextOptions = {
			...this.currentContextOptions,
			responseStyle,
		};
		let context = await this.contextAssembler.assemble(lane, text, contextOpts);
		const laneConfig = LANE_CONFIGURATIONS[lane];
		const model = this.resolveModelForLane(lane);

		let round = 0;
		const argsParseErrors = new Set<string>();

		// 4. THE WHILE-LOOP (I-1 critical fix)
		while (round < MAX_TOOL_ROUNDS) {
			round++;
			argsParseErrors.clear();

			// Check cancellation at top of each round
			if (scope.isCancelled) {
				throw new Error('Request cancelled');
			}

			// Build messages from current conversation state
			const messages: Message[] = [
				{ role: 'system', content: context.systemPrompt },
				...context.contextMessages,
				...this.conversationState.getMessages(),
			];

			// Build gateway request
			const request: GatewayRequest = {
				model,
				messages,
				tools: this.resolveToolDefinitions(laneConfig.allowedTools, lane, text),
				temperature: laneConfig.temperature,
				maxTokens: laneConfig.maxTokens,
				stream: true,
				signal: scope.signal,
				lane,
				priority: 'normal',
				sessionId: this.conversationState.sessionId,
			};

			// Stream from LLM
			const accumulatedText: string[] = [];
			const toolCalls: ToolCall[] = [];
			const activeToolCalls = new Map<string, { name: string; argChunks: string[] }>();

			const streamAbort = new AbortController();
			// Link cancellation scope to streaming abort so both timeout and user cancel abort the fetch
			const onScopeAbort = () => streamAbort.abort(new Error('Request cancelled'));
			if (scope.signal) { scope.signal.addEventListener('abort', onScopeAbort); }
			const streamTimer = setTimeout(() => streamAbort.abort(new Error('LLM streaming timeout')),
				this.timeoutManager.getDefaultTimeout('llm_request'));
			try {
				request.signal = streamAbort.signal;
				for await (const chunk of this.gateway.sendStreaming(request)) {
					if (scope.isCancelled) {
						throw new Error('Request cancelled');
					}

					this.processStreamChunk(chunk, accumulatedText, toolCalls, activeToolCalls, argsParseErrors);
				}
			} finally {
				clearTimeout(streamTimer);
				if (scope.signal) { scope.signal.removeEventListener('abort', onScopeAbort); }
			}

			// Finalize any remaining tool calls from activeToolCalls
			for (const [id, tc] of activeToolCalls) {
				if (!toolCalls.find(t => t.id === id)) {
					try {
						toolCalls.push({
							id,
							name: tc.name,
							arguments: JSON.parse(tc.argChunks.join('')),
						});
					} catch {
						argsParseErrors.add(id);
						toolCalls.push({
							id,
							name: tc.name,
							arguments: {},
						});
					}
				}
			}

			let fullText = accumulatedText.join('');

			// Fallback: parse XML-style tool calls from text when provider
			// doesn't support native tool_use (e.g. Delta Plus server proxy).
			// The model outputs <tool_name><param>value</param></tool_name>
			// in the text stream instead of structured tool_use blocks.
			if (toolCalls.length === 0) {
				const xmlParsed = this.parseXmlToolCalls(fullText);
				if (xmlParsed.toolCalls.length > 0) {
					for (const tc of xmlParsed.toolCalls) {
						toolCalls.push(tc);
					}
					fullText = xmlParsed.cleanedText;
				}
			}

			// If NO tool calls: add assistant message, transition to idle, done
			if (toolCalls.length === 0) {
				if (fullText) {
					this.conversationState.addAssistantMessage([{ type: 'text', text: fullText }]);
				}
				// Signal UI that streaming is complete
				this.uiService.completeStreaming();
				await this.agentState.transition('idle');
				return;
			}

			// Tool calls present: build assistant message with both text and tool_use blocks
			const contentBlocks: ContentBlock[] = [];
			if (fullText) {
				contentBlocks.push({ type: 'text', text: fullText });
			}
			for (const tc of toolCalls) {
				contentBlocks.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.name,
					input: tc.arguments,
				});
			}
			this.conversationState.addAssistantMessage(contentBlocks);

			// Execute tool calls — parallel for all-read-only batches, sequential otherwise
			const allReadOnly = toolCalls.every(tc => {
				const def = TOOL_REGISTRY[tc.name];
				return def && !def.hasSideEffects;
			});

			const toolContext: ToolContext = {
				sessionId: this.conversationState.sessionId,
				workspacePath: this.workspacePath,
				activeFilePath: this.currentContextOptions?.activeFile,
				permissions: new Map(),
			};

			if (allReadOnly && toolCalls.length > 1) {
				// Parallel execution for read-only batches
				for (const tc of toolCalls) {
					this.uiService.showToolCall(tc.id, tc.name, tc.arguments);
				}
				const settled = await Promise.allSettled(
					toolCalls.map(async (tc) => {
						if (argsParseErrors.has(tc.id)) {
							return {
								toolCallId: tc.id,
								content: `Error: Malformed JSON arguments for tool "${tc.name}". Please retry with valid JSON arguments.`,
								isError: true,
							} as ToolResult;
						}
						return this.timeoutManager.withTimeout('tool_execution', () =>
							this.toolRouter.execute(tc, toolContext)
						);
					})
				);

				for (let i = 0; i < toolCalls.length; i++) {
					const outcome = settled[i];
					if (outcome.status === 'fulfilled') {
						const truncated = this.truncateToolResult(outcome.value);
						this.uiService.showToolResult(toolCalls[i].id, truncated.content, truncated.isError);
						this.conversationState.addToolResult(toolCalls[i].id, truncated);
					} else {
						const err = outcome.reason;
						const errMsg = err instanceof TimeoutError
							? `Error: Tool "${toolCalls[i].name}" timed out after ${err.timeoutMs}ms.`
							: `Error: Tool "${toolCalls[i].name}" failed: ${err instanceof Error ? err.message : String(err)}`;
						this.uiService.showToolResult(toolCalls[i].id, errMsg, true);
						this.conversationState.addToolResult(toolCalls[i].id, { content: errMsg, isError: true });
					}
				}

				// XII-AR5: Budget check after all parallel results
				if (this.conversationState.getTokenCount() > MAX_CONVERSATION_TOKENS) {
					await this.truncateConversation(laneConfig.inputTokenBudget);
				}
			} else {
				// Sequential execution (original behavior)
				for (const toolCall of toolCalls) {
					if (scope.isCancelled) {
						throw new Error('Request cancelled');
					}

					this.uiService.showToolCall(toolCall.id, toolCall.name, toolCall.arguments);

					// Return error for malformed tool args instead of executing with empty {}
					if (argsParseErrors.has(toolCall.id)) {
						const errMsg = `Error: Malformed JSON arguments for tool "${toolCall.name}". Please retry with valid JSON arguments.`;
						this.uiService.showToolResult(toolCall.id, errMsg, true);
						this.conversationState.addToolResult(toolCall.id, { content: errMsg, isError: true });
						continue;
					}

					let result: ToolResult;
					try {
						result = await this.timeoutManager.withTimeout('tool_execution', async () => {
							return this.toolRouter.execute(toolCall, toolContext);
						});
					} catch (err) {
						if (err instanceof TimeoutError) {
							const errMsg = `Error: Tool "${toolCall.name}" timed out after ${err.timeoutMs}ms.`;
							this.uiService.showToolResult(toolCall.id, errMsg, true);
							this.conversationState.addToolResult(toolCall.id, { content: errMsg, isError: true });
							continue;
						}
						throw err;
					}

					// XII-AR2: Truncate tool result to MAX_TOOL_RESULT_TOKENS
					const truncatedResult = this.truncateToolResult(result);
					this.uiService.showToolResult(toolCall.id, truncatedResult.content, truncatedResult.isError);

					// Add tool result to conversation
					this.conversationState.addToolResult(toolCall.id, truncatedResult);

					// XII-AR5: Early per-result budget check — prevent intra-round overflow
					if (this.conversationState.getTokenCount() > MAX_CONVERSATION_TOKENS) {
						await this.truncateConversation(laneConfig.inputTokenBudget);
					}
				}
			}

			// XII-AR5: Token budget check after tool results
			const totalTokens = this.conversationState.getTokenCount();
			const budgetLimit = laneConfig.inputTokenBudget * BUDGET_OVERFLOW_RATIO;
			if (totalTokens > budgetLimit || totalTokens > MAX_CONVERSATION_TOKENS) {
				// truncateConversation already invokes summarize — no double-call needed
				await this.truncateConversation(laneConfig.inputTokenBudget);
			}

			// Refresh context for next round (lightweight: skip tree and search, keep system prompt fresh)
			this.contextAssembler.invalidateTreeCache();
			context = await this.contextAssembler.assemble(lane, text, { ...contextOpts, lightweight: true });

			// Loop continues — messages will be rebuilt from conversationState
		}

		// Safety: max rounds exceeded
		this.uiService.showWarning(`Reached maximum tool rounds (${MAX_TOOL_ROUNDS}). Stopping.`);
		await this.agentState.transition('idle');
	}

	/**
	 * Process a single stream chunk into accumulated text and tool calls.
	 */
	private processStreamChunk(
		chunk: StreamChunk,
		accumulatedText: string[],
		toolCalls: ToolCall[],
		activeToolCalls: Map<string, { name: string; argChunks: string[] }>,
		argsParseErrors: Set<string>,
	): void {
		switch (chunk.type) {
			case 'text':
				accumulatedText.push(chunk.text);
				this.uiService.streamChatToken(chunk.text);
				break;

			case 'tool_call_start':
				activeToolCalls.set(chunk.id, { name: chunk.name, argChunks: [] });
				break;

			case 'tool_call_delta':
				activeToolCalls.get(chunk.id)?.argChunks.push(chunk.argumentsDelta);
				break;

			case 'tool_call_end': {
				const tc = activeToolCalls.get(chunk.id);
				if (tc) {
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(tc.argChunks.join(''));
					} catch {
						argsParseErrors.add(chunk.id);
					}
					toolCalls.push({ id: chunk.id, name: tc.name, arguments: args });
					activeToolCalls.delete(chunk.id);
				}
				break;
			}

			case 'error':
				throw chunk.error;

			case 'done':
				// Stream finished — outer loop handles the results
				break;
		}
	}

	/**
	 * Fast-apply bypass — skips planning, goes directly to edit (I-SG7).
	 */
	private async handleFastApply(text: string, scope: CancellationScope): Promise<void> {
		this.conversationState.setLane('fast-apply');
		this.conversationState.addUserMessage(text);
		await this.agentState.transition('processing');

		// Check token budget before processing
		await this.checkSummarizeTrigger('fast-apply');

		const context = await this.contextAssembler.assemble('fast-apply', text, this.currentContextOptions);
		const laneConfig = LANE_CONFIGURATIONS['fast-apply'];
		const model = this.resolveModelForLane('fast-apply');

		const request: GatewayRequest = {
			model,
			messages: [
				{ role: 'system', content: context.systemPrompt },
				...context.contextMessages,
				...this.conversationState.getMessages(),
			],
			tools: this.resolveToolDefinitions(laneConfig.allowedTools, 'fast-apply', text),
			temperature: 0.0,
			maxTokens: laneConfig.maxTokens,
			stream: false,
			signal: scope.signal,
			lane: 'fast-apply',
			priority: 'high',
			sessionId: this.conversationState.sessionId,
		};

		const response = await this.gateway.sendRequest(request);

		// Build assistant message from all content blocks
		const contentBlocks: ContentBlock[] = [];
		const textParts: string[] = [];
		const toolCalls: ToolCall[] = [];

		for (const block of response.content) {
			if (block.type === 'text') {
				contentBlocks.push(block);
				textParts.push(block.text);
			} else if (block.type === 'tool_use') {
				contentBlocks.push(block);
				toolCalls.push({
					id: block.id,
					name: block.name,
					arguments: block.input,
				});
			}
		}

		let fullText = textParts.join('');

		// XML fallback: parse XML-style tool calls when provider doesn't support native tool_use
		if (toolCalls.length === 0 && fullText) {
			const xmlParsed = this.parseXmlToolCalls(fullText);
			if (xmlParsed.toolCalls.length > 0) {
				for (const tc of xmlParsed.toolCalls) {
					toolCalls.push(tc);
					contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
				}
				fullText = xmlParsed.cleanedText;
			}
		}

		if (fullText) {
			this.uiService.streamChatToken(fullText);
		}

		// If no tool calls, just record text and finish
		if (toolCalls.length === 0) {
			if (contentBlocks.length > 0) {
				this.conversationState.addAssistantMessage(contentBlocks);
			}
			this.uiService.completeStreaming();
			await this.agentState.transition('idle');
			return;
		}

		// Tool calls present — record assistant message with tool_use blocks
		this.conversationState.addAssistantMessage(contentBlocks);

		// Execute tool calls (fast-apply is single-shot: execute, record results, done)
		const toolContext: ToolContext = {
			sessionId: this.conversationState.sessionId,
			workspacePath: this.workspacePath,
			activeFilePath: this.currentContextOptions?.activeFile,
			permissions: new Map(),
		};

		for (const toolCall of toolCalls) {
			if (scope.isCancelled) {
				throw new Error('Request cancelled');
			}

			let result: ToolResult;
			try {
				result = await this.timeoutManager.withTimeout('tool_execution', () =>
					this.toolRouter.execute(toolCall, toolContext)
				);
			} catch (err) {
				if (err instanceof TimeoutError) {
					this.conversationState.addToolResult(toolCall.id, {
						content: `Error: Tool "${toolCall.name}" timed out.`,
						isError: true,
					});
					continue;
				}
				throw err;
			}

			this.conversationState.addToolResult(toolCall.id, this.truncateToolResult(result));
		}

		// Signal UI that response is complete
		this.uiService.completeStreaming();
		await this.agentState.transition('idle');
	}

	/**
	 * I-SG5: Check if summarize is needed (80% of conversation budget).
	 */
	private async checkSummarizeTrigger(currentLane?: LaneName): Promise<void> {
		const currentTokens = this.conversationState.getTokenCount();
		const lane = currentLane ?? this.conversationState.getLane() ?? 'chat-ask';
		const budget = LANE_CONFIGURATIONS[lane].inputTokenBudget;
		const threshold = budget * SUMMARIZE_THRESHOLD_RATIO;

		if (currentTokens > threshold) {
			await this.invokeSummarizeLane();
		}
	}

	/**
	 * I-SG5: Compress conversation history via the summarize lane.
	 * Never summarizes the last 3 user/assistant exchanges.
	 */
	private async invokeSummarizeLane(): Promise<void> {
		const messages = this.conversationState.getMessages();

		// Keep last N exchanges (user + assistant = 2 messages per exchange)
		const keepCount = SUMMARIZE_KEEP_EXCHANGES * 2;
		if (messages.length <= keepCount) {
			return; // Nothing to summarize
		}

		const toSummarize = messages.slice(0, messages.length - keepCount);
		const toKeep = messages.slice(messages.length - keepCount);

		const summaryPrompt = PROMPT_TEMPLATES['summarize']
			+ '\n\nSummarize the following conversation:\n\n'
			+ toSummarize.map(m => {
				const content = typeof m.content === 'string'
					? m.content
					: m.content.map(b => b.type === 'text' ? b.text : `[tool_use: ${(b as any).name}]`).join('');
				return `${m.role}: ${content}`;
			}).join('\n');

		try {
			const response = await this.gateway.sendRequest({
				model: this.resolveModelForLane('summarize'),
				messages: [{ role: 'user', content: summaryPrompt }],
				temperature: 0.3,
				maxTokens: LANE_CONFIGURATIONS['summarize'].maxTokens,
				lane: 'summarize',
				priority: 'low',
				sessionId: this.conversationState.sessionId,
			});

			const summaryText = response.content
				.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
				.map(b => b.text)
				.join('');

			if (summaryText) {
				this.replaceMessagesWithSummary(summaryText, toKeep);
			}
		} catch {
			// Summarization failed — continue without it
		}
	}

	/**
	 * Replace old messages with a summary + kept recent messages.
	 */
	private replaceMessagesWithSummary(summary: string, toKeep: Message[]): void {
		this.conversationState.replaceMessages(summary, toKeep);
	}

	/**
	 * XII-AR5: Truncate conversation when over budget.
	 */
	private async truncateConversation(targetBudget: number): Promise<void> {
		// Trigger summarize to compress older messages
		await this.invokeSummarizeLane();

		// If still over budget after summarize, warn user
		const currentTokens = this.conversationState.getTokenCount();
		if (currentTokens > targetBudget * BUDGET_OVERFLOW_RATIO) {
			this.uiService.showWarning(
				`Conversation is very large (${currentTokens} tokens). Consider starting a new conversation.`
			);
		}
	}

	/**
	 * XII-AR2: Truncate a tool result to fit within MAX_TOOL_RESULT_TOKENS.
	 */
	private truncateToolResult(result: ToolResult): ToolResult {
		const resultTokens = tokenCounter.count(result.content);
		if (resultTokens <= MAX_TOOL_RESULT_TOKENS) {
			return result;
		}

		const truncated = tokenCounter.truncateToFit(result.content, MAX_TOOL_RESULT_TOKENS);
		return {
			...result,
			content: truncated + '\n\n[Output truncated — exceeded token limit]',
		};
	}

	/**
	 * XI-SV1: All error display paths pass through secret scanner.
	 */
	private showError(error: Error): void {
		const redacted = this.secretScanner.redact(error.message);
		this.uiService.showError(redacted);
	}

	/**
	 * Resolve tool definitions for the lane's allowed tools.
	 * '*' means all tools; empty array means no tools.
	 */
	private resolveToolDefinitions(
		allowedTools: string[],
		lane?: LaneName,
		userMessage?: string,
	): import('../canonical/types.js').ToolDefinition[] | undefined {
		if (allowedTools.length === 0) { return undefined; }

		// Use DynamicToolSelector if available (filters by relevance and token budget)
		if (this.dynamicToolSelector && lane && userMessage) {
			const selected = this.dynamicToolSelector.selectTools(lane, userMessage);
			if (selected.length > 0) {
				console.log(`[AgentOrchestrator] resolveToolDefinitions: lane=${lane}, allowedTools=${JSON.stringify(allowedTools).slice(0, 80)}, selected=${selected.map(t => t.name).join(',')}`);
				return selected;
			}
		}

		// Fallback: static resolution
		const isActive = (t: import('../canonical/types.js').ToolDefinition) => !t.status || t.status === 'active';

		let result: import('../canonical/types.js').ToolDefinition[];
		if (allowedTools.includes('*')) {
			result = Object.values(TOOL_REGISTRY).filter(isActive);
		} else {
			result = allowedTools
				.map(name => TOOL_REGISTRY[name])
				.filter((t): t is import('../canonical/types.js').ToolDefinition => t !== undefined && isActive(t));
		}
		console.log(`[AgentOrchestrator] resolveToolDefinitions (static fallback): lane=${lane}, tools=${result.map(t => t.name).join(',')}`);
		return result;
	}

	/**
	 * Resolve the model to use for a given lane.
	 * Uses preferred provider if set, otherwise falls back to lane-based selection.
	 */
	/**
	 * Parse XML-style tool calls from LLM text output.
	 * Fallback for providers that don't support native tool_use.
	 * Matches patterns like: <write_file><path>foo.txt</path><content>hello</content></write_file>
	 * Only parses known tool names from TOOL_REGISTRY.
	 */
	private parseXmlToolCalls(text: string): { toolCalls: ToolCall[]; cleanedText: string } {
		const toolCalls: ToolCall[] = [];
		let cleanedText = text;
		const toolNames = Object.keys(TOOL_REGISTRY);

		for (const toolName of toolNames) {
			// Match <tool_name>...</tool_name> (with possible whitespace)
			const regex = new RegExp(
				`<${toolName}\\s*>([\\s\\S]*?)</${toolName}\\s*>`,
				'gi',
			);

			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const innerXml = match[1];
				const args: Record<string, unknown> = {};

				// Extract <param>value</param> pairs from inner content
				const paramRegex = /<(\w+)\s*>([\s\S]*?)<\/\1\s*>/g;
				let paramMatch: RegExpExecArray | null;
				while ((paramMatch = paramRegex.exec(innerXml)) !== null) {
					const key = paramMatch[1];
					const value = paramMatch[2].trim();
					// Try to parse as JSON for non-string values
					if (value === 'true') { args[key] = true; }
					else if (value === 'false') { args[key] = false; }
					else if (/^\d+$/.test(value)) { args[key] = parseInt(value, 10); }
					else { args[key] = value; }
				}

				toolCalls.push({
					id: `xml-${randomUUID()}`,
					name: toolName,
					arguments: args,
				});

				// Remove the matched XML from the display text
				cleanedText = cleanedText.replace(match[0], '');
			}
		}

		// Clean up leftover whitespace from removals
		cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

		return { toolCalls, cleanedText };
	}

	private resolveModelForLane(lane: LaneName): string {
		// If user selected a preferred provider, map it to a model
		if (this.preferredProvider) {
			const providerModelMap: Record<string, string> = {
				'anthropic': 'claude-latest',
				'openai': 'gpt-latest',
				'ollama': 'local-fast',
				'quantlab-cloud': 'cloud-default',
			};
			const preferredModel = providerModelMap[this.preferredProvider];
			if (preferredModel && this.modelRegistry) {
				// Verify the provider is actually available
				if (this.modelRegistry.isProviderAvailable(this.preferredProvider)) {
					return this.modelRegistry.resolveAlias(preferredModel);
				}
			}
		}

		if (this.modelRegistry) {
			return this.modelRegistry.getAvailableModelForLane(lane);
		}
		// Fallback if no model registry (shouldn't happen in practice)
		switch (lane) {
			case 'completion':
			case 'fast-apply':
			case 'summarize':
				return 'claude-haiku';
			default:
				return 'claude-latest';
		}
	}
}
