/*---------------------------------------------------------------------------------------------
 *  AI Provider
 *  Claude API integration for Quantlab AI assistant
 *  Decision G37: V1 ships with Claude support only
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	AIProviderConfig,
	AIProviderStatus,
	ChatMessage,
	RateLimitInfo,
} from './types';
import { sanitizeInput } from './sanitize';
import { logAIRequest } from './audit';

/**
 * Rate limiting configuration.
 */
const RATE_LIMIT = {
	maxRequestsPerHour: 100,
	windowMs: 60 * 60 * 1000, // 1 hour
};

/**
 * Claude API provider.
 * Handles communication with Anthropic's Claude API.
 */
export class ClaudeProvider {
	private static instance: ClaudeProvider | undefined;

	private readonly baseUrl = 'https://api.anthropic.com/v1/messages';
	private readonly defaultModel = 'claude-3-5-sonnet-20241022';
	private readonly maxTokens = 4096;

	private apiKey: string | undefined;
	private requestTimestamps: number[] = [];
	private status: AIProviderStatus = 'unconfigured';

	private constructor() {}

	static getInstance(): ClaudeProvider {
		if (!ClaudeProvider.instance) {
			ClaudeProvider.instance = new ClaudeProvider();
		}
		return ClaudeProvider.instance;
	}

	/**
	 * Configure the provider with API key.
	 */
	configure(config: AIProviderConfig): void {
		this.apiKey = config.apiKey;
		this.status = config.apiKey ? 'ready' : 'unconfigured';
	}

	/**
	 * Check if provider is configured and ready.
	 */
	isReady(): boolean {
		return this.status === 'ready' && !!this.apiKey;
	}

	/**
	 * Get current provider status.
	 */
	getStatus(): AIProviderStatus {
		if (!this.apiKey) {
			return 'unconfigured';
		}
		if (this.isRateLimited()) {
			return 'rate_limited';
		}
		return this.status;
	}

	/**
	 * Get rate limit information.
	 */
	getRateLimitInfo(): RateLimitInfo {
		this.cleanupOldTimestamps();
		const remaining = Math.max(0, RATE_LIMIT.maxRequestsPerHour - this.requestTimestamps.length);
		const oldestTimestamp = this.requestTimestamps[0] || Date.now();
		const resetTime = new Date(oldestTimestamp + RATE_LIMIT.windowMs);

		return {
			requestsRemaining: remaining,
			resetTime,
			maxRequestsPerHour: RATE_LIMIT.maxRequestsPerHour,
		};
	}

	/**
	 * Send a message to Claude and get a response.
	 */
	async sendMessage(
		sessionId: string,
		messages: ChatMessage[],
		systemPrompt?: string
	): Promise<ChatMessage> {
		if (!this.apiKey) {
			throw new Error('API key not configured. Set quantlab.ai.apiKey in settings.');
		}

		if (this.isRateLimited()) {
			const info = this.getRateLimitInfo();
			throw new Error(
				`Rate limited. ${info.requestsRemaining} requests remaining. ` +
				`Resets at ${info.resetTime.toLocaleTimeString()}`
			);
		}

		const startTime = Date.now();
		let hadRedactions = false;

		// Sanitize all user messages
		const sanitizedMessages = messages.map(msg => {
			if (msg.role === 'user') {
				const result = sanitizeInput(msg.content);
				if (result.hadSensitiveData) {
					hadRedactions = true;
				}
				return { ...msg, content: result.sanitized };
			}
			return msg;
		});

		// Build request body
		const body = {
			model: this.defaultModel,
			max_tokens: this.maxTokens,
			system: systemPrompt || this.getDefaultSystemPrompt(),
			messages: sanitizedMessages.map(msg => ({
				role: msg.role === 'user' ? 'user' : 'assistant',
				content: msg.content,
			})),
		};

		const inputLength = JSON.stringify(body).length;

		try {
			const response = await this.makeRequest(body);
			const outputLength = response.content.length;
			const durationMs = Date.now() - startTime;

			// Track rate limit
			this.requestTimestamps.push(Date.now());

			// Audit log
			logAIRequest(
				sessionId,
				response.id,
				inputLength,
				outputLength,
				hadRedactions,
				[],
				durationMs
			);

			return {
				role: 'assistant',
				content: response.content,
				timestamp: new Date(),
				id: response.id,
			};
		} catch (error) {
			const durationMs = Date.now() - startTime;

			// Still log failed requests
			logAIRequest(
				sessionId,
				`error-${Date.now()}`,
				inputLength,
				0,
				hadRedactions,
				[],
				durationMs
			);

			throw error;
		}
	}

	/**
	 * Stream a message response.
	 */
	async *streamMessage(
		sessionId: string,
		messages: ChatMessage[],
		systemPrompt?: string
	): AsyncGenerator<string, void, unknown> {
		if (!this.apiKey) {
			throw new Error('API key not configured.');
		}

		if (this.isRateLimited()) {
			throw new Error('Rate limited.');
		}

		const startTime = Date.now();
		let hadRedactions = false;

		// Sanitize messages
		const sanitizedMessages = messages.map(msg => {
			if (msg.role === 'user') {
				const result = sanitizeInput(msg.content);
				if (result.hadSensitiveData) {
					hadRedactions = true;
				}
				return { ...msg, content: result.sanitized };
			}
			return msg;
		});

		const body = {
			model: this.defaultModel,
			max_tokens: this.maxTokens,
			stream: true,
			system: systemPrompt || this.getDefaultSystemPrompt(),
			messages: sanitizedMessages.map(msg => ({
				role: msg.role === 'user' ? 'user' : 'assistant',
				content: msg.content,
			})),
		};

		const inputLength = JSON.stringify(body).length;
		let outputLength = 0;

		try {
			const response = await fetch(this.baseUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': this.apiKey,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				throw new Error(`API error: ${response.status} ${response.statusText}`);
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('No response body');
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6);
						if (data === '[DONE]') continue;

						try {
							const parsed = JSON.parse(data);
							if (parsed.type === 'content_block_delta') {
								const text = parsed.delta?.text || '';
								outputLength += text.length;
								yield text;
							}
						} catch {
							// Skip malformed JSON
						}
					}
				}
			}

			// Track rate limit
			this.requestTimestamps.push(Date.now());

			// Audit log
			const durationMs = Date.now() - startTime;
			logAIRequest(
				sessionId,
				`stream-${Date.now()}`,
				inputLength,
				outputLength,
				hadRedactions,
				[],
				durationMs
			);
		} catch (error) {
			const durationMs = Date.now() - startTime;
			logAIRequest(
				sessionId,
				`error-${Date.now()}`,
				inputLength,
				outputLength,
				hadRedactions,
				[],
				durationMs
			);
			throw error;
		}
	}

	/**
	 * Disable the provider (kill switch).
	 */
	disable(): void {
		this.status = 'disabled';
	}

	/**
	 * Enable the provider.
	 */
	enable(): void {
		if (this.apiKey) {
			this.status = 'ready';
		}
	}

	private async makeRequest(body: object): Promise<{ id: string; content: string }> {
		const response = await fetch(this.baseUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey!,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			if (response.status === 429) {
				this.status = 'rate_limited';
				throw new Error('Rate limited by Anthropic API. Please wait and try again.');
			}
			throw new Error(`API error: ${response.status} - ${errorBody}`);
		}

		const data = await response.json() as { id: string; content: Array<{ text?: string }> };
		return {
			id: data.id,
			content: data.content[0]?.text || '',
		};
	}

	private isRateLimited(): boolean {
		this.cleanupOldTimestamps();
		return this.requestTimestamps.length >= RATE_LIMIT.maxRequestsPerHour;
	}

	private cleanupOldTimestamps(): void {
		const cutoff = Date.now() - RATE_LIMIT.windowMs;
		this.requestTimestamps = this.requestTimestamps.filter(ts => ts > cutoff);
	}

	private getDefaultSystemPrompt(): string {
		return `You are a helpful assistant for Quantlab, a quantitative trading strategy development platform.

Your expertise includes:
- Python programming for algorithmic trading
- Technical analysis and indicators (SMA, EMA, RSI, MACD, etc.)
- Backtesting strategies and interpreting results
- Risk management and position sizing
- Quantlab-specific APIs and patterns

Guidelines:
- Provide clear, actionable advice
- Use Python code examples when helpful
- Explain trading concepts when needed
- Never provide specific investment advice
- Remind users to thoroughly backtest before live trading

When reviewing strategy code:
- Look for common bugs and edge cases
- Suggest improvements for robustness
- Check for proper risk management
- Verify correct use of Quantlab APIs`;
	}
}

/**
 * Get the configured AI provider.
 */
export function getAIProvider(): ClaudeProvider {
	return ClaudeProvider.getInstance();
}

/**
 * Configure AI provider from VS Code settings.
 */
export function configureFromSettings(): void {
	const config = vscode.workspace.getConfiguration('quantlab.ai');
	const apiKey = config.get<string>('apiKey');

	if (apiKey) {
		ClaudeProvider.getInstance().configure({ apiKey });
	}
}
