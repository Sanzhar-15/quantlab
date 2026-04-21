/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GatewayRequest } from '../canonical/interfaces.js';
import type { Gateway } from '../gateway/gateway.js';
import type { ContextAssembler } from '../context/contextAssembler.js';
import type { ModelRegistry } from '../gateway/modelRegistry.js';
import { DegradationLevel } from '../resilience/degradationManager.js';
import type { DegradationManager } from '../resilience/degradationManager.js';
import type { ConsentStore } from '../security/consentStore.js';
import { FIMAdapter } from './fimAdapter.js';
import type { SessionCache } from '../telemetry/sessionCache.js';

export interface CompletionContext {
	prefix: string;
	suffix: string;
	language: string;
	filePath: string;
}

export interface CompletionResult {
	text: string;
	range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
	/** Model used for this completion (for quality signal tracking) */
	model?: string;
}

const DEBOUNCE_MS = 150;
const COMPLETION_MAX_TOKENS = 256;

/**
 * Inline completion engine — bypasses the orchestrator entirely (Audit I-2, I-SG7).
 *
 * Flow: keystroke → 150ms debounce → context assembly → tier selection → LLM → ghost text.
 * No tool routing, no step execution, no permission checks (beyond consent).
 *
 * 6-tier waterfall (Audit VII-DS5):
 *   Tier 1: Local GPU (200ms)
 *   Tier 2: Local CPU (400ms)
 *   Tier 3: Session cache (10ms)
 *   Tier 4: Cloud provider (2000ms, parallel with Tier 5 after 500ms)
 *   Tier 5: Static analysis (50ms)
 *   Tier 6: Empty response
 */
export class CompletionEngine {

	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastRequest: AbortController | null = null;
	private readonly fimAdapter = new FIMAdapter();

	constructor(
		private readonly gateway: Gateway,
		_contextAssembler: ContextAssembler,
		private readonly modelRegistry: ModelRegistry,
		private readonly degradationManager: DegradationManager,
		private readonly consentStore: ConsentStore,
		private readonly sessionCache: SessionCache | null,
	) {}

	/**
	 * Main entry point for inline completions (Audit I-2).
	 */
	async provideCompletions(
		context: CompletionContext,
		signal: AbortSignal,
	): Promise<CompletionResult | null> {
		// XI-SV4: Re-check consent on EVERY request, never cache
		if (!await this.consentStore.hasConsent('llm')) {
			return null;
		}

		// Cancel previous in-flight request
		if (this.lastRequest) {
			this.lastRequest.abort('New completion request');
			this.lastRequest = null;
		}

		// Check degradation level — no completions at level 2+
		const level = this.degradationManager.getLevel();
		if (level >= DegradationLevel.NoCompletions) {
			return null;
		}

		// Create new abort controller that also listens to external signal
		const controller = new AbortController();
		this.lastRequest = controller;

		const abort = () => controller.abort('External cancellation');
		signal.addEventListener('abort', abort, { once: true });

		try {
			return await this.executeWaterfall(context, controller.signal, level);
		} finally {
			signal.removeEventListener('abort', abort);
			if (this.lastRequest === controller) {
				this.lastRequest = null;
			}
		}
	}

	/**
	 * Debounced completion trigger (150ms per Audit I-SG7).
	 */
	triggerCompletion(
		context: CompletionContext,
		signal: AbortSignal,
		callback: (result: CompletionResult | null) => void,
	): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.provideCompletions(context, signal)
				.then(callback)
				.catch(() => callback(null));
		}, DEBOUNCE_MS);
	}

	/**
	 * 6-tier completion waterfall (Audit VII-DS5).
	 */
	private async executeWaterfall(
		context: CompletionContext,
		signal: AbortSignal,
		level: DegradationLevel,
	): Promise<CompletionResult | null> {
		// Tier 1: Local GPU (if available and level <= ReducedQuality)
		if (level <= DegradationLevel.Normal) {
			const localGpu = await this.tryLocalProvider(context, signal, 'ollama', 200);
			if (localGpu) { return localGpu; }
		}

		// Tier 2: Local CPU (quantized model)
		if (level <= DegradationLevel.ReducedQuality) {
			const localCpu = await this.tryLocalProvider(context, signal, 'ollama-cpu', 400);
			if (localCpu) { return localCpu; }
		}

		// Tier 3: Session cache (exact prefix match)
		if (this.sessionCache) {
			const cacheRequest = {
				model: 'completion-cache',
				messages: [{ role: 'user' as const, content: context.prefix }],
				temperature: 0.0,
			};
			const cached = this.sessionCache.get(cacheRequest);
			if (cached) {
				const text = cached.content
					.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
					.map(b => b.text)
					.join('');
				if (text) { return { text, model: 'cache' }; }
			}
		}

		// Tier 4 + Tier 5: Cloud with static analysis fallback
		if (level <= DegradationLevel.ReducedQuality) {
			return this.tryCloudWithFallback(context, signal);
		}

		// Tier 6: Empty
		return null;
	}

	/**
	 * Try a local provider with timeout.
	 */
	private async tryLocalProvider(
		context: CompletionContext,
		signal: AbortSignal,
		providerId: string,
		timeoutMs: number,
	): Promise<CompletionResult | null> {
		try {
			const available = this.modelRegistry.isProviderAvailable(providerId);
			if (!available) { return null; }

			const fim = this.fimAdapter.formatFIMRequest(context.prefix, context.suffix, providerId);

			const request: GatewayRequest = {
				model: 'local-fast',
				messages: [{ role: 'user', content: fim.prompt }],
				temperature: 0.0,
				maxTokens: COMPLETION_MAX_TOKENS,
				stream: false,
				signal,
				lane: 'completion',
				priority: 'high',
				providerId,
			};

			const result = await Promise.race([
				this.gateway.sendRequest(request),
				this.timeout(timeoutMs, signal),
			]);

			if (!result) { return null; }

			const text = result.content
				.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
				.map(b => b.text)
				.join('');

			return text ? { text, model: providerId } : null;
		} catch {
			return null;
		}
	}

	/**
	 * Tier 4: Cloud provider with parallel Tier 5 (static analysis) after 500ms.
	 */
	private async tryCloudWithFallback(
		context: CompletionContext,
		signal: AbortSignal,
	): Promise<CompletionResult | null> {
		const model = this.modelRegistry.resolveAlias('claude-haiku');

		const fim = this.fimAdapter.formatInstructionRequest(
			context.prefix,
			context.suffix,
			context.language,
		);

		const request: GatewayRequest = {
			model,
			messages: [{ role: 'user', content: fim.prompt }],
			temperature: 0.0,
			maxTokens: COMPLETION_MAX_TOKENS,
			stream: false,
			signal,
			lane: 'completion',
			priority: 'high',
		};

		// Cloud request with 2000ms total timeout
		const cloudPromise = this.gateway.sendRequest(request)
			.then(response => {
				const text = response.content
					.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
					.map(b => b.text)
					.join('');
				return text ? { text, model } as CompletionResult : null;
			})
			.catch(() => null);

		// After 500ms, start static analysis in parallel
		const fallbackPromise = new Promise<CompletionResult | null>(resolve => {
			const timer = setTimeout(() => {
				resolve(this.tryStaticAnalysis(context));
			}, 500);
			signal.addEventListener('abort', () => {
				clearTimeout(timer);
				resolve(null);
			}, { once: true });
		});

		// Race: cloud (2000ms total) vs fallback (starts at 500ms)
		const result = await Promise.race([
			cloudPromise,
			this.timeout(2000, signal).then(() => null),
			fallbackPromise.then(fallback => {
				// Only use fallback if cloud hasn't responded yet
				return fallback;
			}),
		]);

		// If cloud hasn't finished but fallback has something, use fallback
		// Otherwise wait for cloud up to the 2000ms timeout
		if (result) { return result; }

		// Last chance: wait for cloud
		const cloudResult = await Promise.race([
			cloudPromise,
			this.timeout(2000, signal).then(() => null),
		]);

		return cloudResult;
	}

	/**
	 * Tier 5: Static analysis — type-based heuristics.
	 */
	private tryStaticAnalysis(context: CompletionContext): CompletionResult | null {
		// Basic heuristic: if the last line looks like a property/method access, suggest nothing
		// More sophisticated analysis would use AST/type information
		const lastLine = context.prefix.split('\n').pop() ?? '';
		const trimmed = lastLine.trimStart();

		// Simple bracket/paren completion
		if (trimmed.endsWith('(')) {
			return { text: ')', model: 'static-analysis' };
		}
		if (trimmed.endsWith('[')) {
			return { text: ']', model: 'static-analysis' };
		}
		if (trimmed.endsWith('{')) {
			return { text: '\n}', model: 'static-analysis' };
		}

		return null;
	}

	private timeout(ms: number, signal: AbortSignal): Promise<null> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => resolve(null), ms);
			signal.addEventListener('abort', () => {
				clearTimeout(timer);
				reject(new Error('Aborted'));
			}, { once: true });
		});
	}
}
