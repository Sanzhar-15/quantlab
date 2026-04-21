/*---------------------------------------------------------------------------------------------
 *  AI Module Types
 *  Type definitions for AI panel functionality
 *---------------------------------------------------------------------------------------------*/

/**
 * AI provider configuration.
 */
export interface AIProviderConfig {
	apiKey: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
}

/**
 * AI chat message.
 */
export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: Date;
	id: string;
}

/**
 * Chat conversation.
 */
export interface Conversation {
	id: string;
	messages: ChatMessage[];
	createdAt: Date;
	updatedAt: Date;
	title?: string;
}

/**
 * Data consent categories.
 */
export type ConsentCategory =
	| 'strategy_code'
	| 'error_messages'
	| 'data_samples'
	| 'performance_metrics';

/**
 * Consent record.
 */
export interface ConsentRecord {
	category: ConsentCategory;
	granted: boolean;
	timestamp: Date;
	sessionId: string;
}

/**
 * Sensitive data categories that should never be sent.
 */
export type BlockedCategory =
	| 'broker_credentials'
	| 'trading_history'
	| 'personal_data'
	| 'api_keys';

/**
 * Sanitization result.
 */
export interface SanitizeResult {
	sanitized: string;
	warnings: string[];
	hadSensitiveData: boolean;
	redactedPatterns: string[];
}

/**
 * AI request audit entry.
 */
export interface AIAuditEntry {
	id: string;
	timestamp: Date;
	sessionId: string;
	messageId: string;
	inputLength: number;
	outputLength: number;
	hadRedactions: boolean;
	consentCategories: ConsentCategory[];
	durationMs: number;
}

/**
 * Context item for AI requests.
 */
export interface ContextItem {
	type: 'strategy' | 'error' | 'data' | 'documentation';
	content: string;
	source: string;
	lineStart?: number;
	lineEnd?: number;
}

/**
 * AI request context.
 */
export interface AIRequestContext {
	strategyFile?: string;
	strategyCode?: string;
	errorMessages?: string[];
	dataSample?: string;
	additionalItems: ContextItem[];
}

/**
 * AI provider status.
 */
export type AIProviderStatus =
	| 'unconfigured'
	| 'ready'
	| 'rate_limited'
	| 'error'
	| 'disabled';

/**
 * Rate limit info.
 */
export interface RateLimitInfo {
	requestsRemaining: number;
	resetTime: Date;
	maxRequestsPerHour: number;
}
