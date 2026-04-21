/*---------------------------------------------------------------------------------------------
 *  Input Sanitization
 *  Protects sensitive data from being sent to AI providers
 *---------------------------------------------------------------------------------------------*/

import { SanitizeResult } from './types';

/**
 * Patterns for detecting sensitive data.
 * These patterns identify data that should never be sent to AI providers.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
	// Account identifiers
	{ pattern: /\b[A-Z0-9]{8,12}\b/g, name: 'account_number' },
	{ pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, name: 'card_number' },

	// API keys (Alpaca, generic patterns)
	{ pattern: /\b(APCA|pk_live|sk_live)[A-Za-z0-9_-]{10,}\b/gi, name: 'api_key' },
	{ pattern: /\bapi[_-]?key[=:]\s*['"]?[A-Za-z0-9_-]{20,}['"]?/gi, name: 'api_key' },
	{ pattern: /\bsecret[_-]?key[=:]\s*['"]?[A-Za-z0-9_-]{20,}['"]?/gi, name: 'secret_key' },

	// Financial data
	{ pattern: /\$[\d,]+\.\d{2}\s*(profit|loss|p&l|balance)/gi, name: 'financial_data' },
	{ pattern: /\b(balance|equity|pnl|p&l)[=:]\s*\$?[\d,]+(\.\d{2})?\b/gi, name: 'financial_data' },

	// Email addresses
	{ pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, name: 'email' },

	// Phone numbers
	{ pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, name: 'phone' },

	// SSN
	{ pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, name: 'ssn' },

	// AWS keys
	{ pattern: /\bAKIA[A-Z0-9]{16}\b/g, name: 'aws_key' },

	// GitHub tokens
	{ pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, name: 'github_token' },
];

/**
 * Patterns for broker-specific sensitive data.
 */
const BROKER_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
	// Alpaca
	{ pattern: /APCA-API-KEY-ID[=:]\s*['"]?[A-Za-z0-9_-]+['"]?/gi, name: 'alpaca_key' },
	{ pattern: /APCA-API-SECRET-KEY[=:]\s*['"]?[A-Za-z0-9_-]+['"]?/gi, name: 'alpaca_secret' },
];

/**
 * Context that should be allowed through (code patterns that look like sensitive data).
 */
const ALLOWED_PATTERNS: RegExp[] = [
	// Hex color codes
	/^#[A-Fa-f0-9]{6}$/,
	// Common variable names
	/^[a-z_]+$/i,
	// Python imports
	/^from\s+\w+/,
	/^import\s+\w+/,
];

/**
 * Sanitize input text by redacting sensitive data.
 */
export function sanitizeInput(text: string): SanitizeResult {
	let sanitized = text;
	const warnings: string[] = [];
	const redactedPatterns: string[] = [];

	// Check broker patterns first (highest priority)
	for (const { pattern, name } of BROKER_PATTERNS) {
		if (pattern.test(sanitized)) {
			sanitized = sanitized.replace(pattern, '[REDACTED_BROKER_CREDENTIAL]');
			redactedPatterns.push(name);
			warnings.push(`Broker credential (${name}) detected and redacted`);
		}
		// Reset lastIndex for global patterns
		pattern.lastIndex = 0;
	}

	// Check general sensitive patterns
	for (const { pattern, name } of SENSITIVE_PATTERNS) {
		const matches = sanitized.match(pattern);
		if (matches) {
			// Filter out allowed patterns (false positives)
			const realMatches = matches.filter(match =>
				!ALLOWED_PATTERNS.some(allowed => allowed.test(match))
			);

			if (realMatches.length > 0) {
				sanitized = sanitized.replace(pattern, '[REDACTED]');
				redactedPatterns.push(name);
				warnings.push(`Potentially sensitive data (${name}) detected and redacted`);
			}
		}
		// Reset lastIndex for global patterns
		pattern.lastIndex = 0;
	}

	return {
		sanitized,
		warnings,
		hadSensitiveData: redactedPatterns.length > 0,
		redactedPatterns,
	};
}

/**
 * Check if text contains any sensitive patterns without redacting.
 */
export function containsSensitiveData(text: string): boolean {
	for (const { pattern } of [...BROKER_PATTERNS, ...SENSITIVE_PATTERNS]) {
		if (pattern.test(text)) {
			pattern.lastIndex = 0;
			return true;
		}
		pattern.lastIndex = 0;
	}
	return false;
}

/**
 * Get list of sensitive patterns found in text.
 */
export function detectSensitivePatterns(text: string): string[] {
	const found: string[] = [];

	for (const { pattern, name } of [...BROKER_PATTERNS, ...SENSITIVE_PATTERNS]) {
		if (pattern.test(text)) {
			found.push(name);
		}
		pattern.lastIndex = 0;
	}

	return found;
}

/**
 * Sanitize strategy code for AI context.
 * More permissive than general sanitization - allows variable names
 * that might look like sensitive data.
 */
export function sanitizeStrategyCode(code: string): SanitizeResult {
	// For strategy code, only redact obvious credentials
	let sanitized = code;
	const warnings: string[] = [];
	const redactedPatterns: string[] = [];

	for (const { pattern, name } of BROKER_PATTERNS) {
		if (pattern.test(sanitized)) {
			sanitized = sanitized.replace(pattern, '# [REDACTED_CREDENTIAL]');
			redactedPatterns.push(name);
			warnings.push(`Credential found in code (${name})`);
		}
		pattern.lastIndex = 0;
	}

	// Only redact API keys in code, not general patterns
	const apiKeyPattern = /\bapi[_-]?key[=:]\s*['"]?[A-Za-z0-9_-]{20,}['"]?/gi;
	if (apiKeyPattern.test(sanitized)) {
		sanitized = sanitized.replace(apiKeyPattern, 'api_key = "[REDACTED]"');
		redactedPatterns.push('api_key_in_code');
		warnings.push('API key found in code');
	}

	return {
		sanitized,
		warnings,
		hadSensitiveData: redactedPatterns.length > 0,
		redactedPatterns,
	};
}

/**
 * Validate that a message is safe to send to AI.
 * Returns error message if not safe, undefined if safe.
 */
export function validateMessageSafety(message: string): string | undefined {
	// Check for explicit credential patterns
	if (/password\s*[=:]\s*['"]?.+['"]?/i.test(message)) {
		return 'Message appears to contain a password';
	}

	if (/secret\s*[=:]\s*['"]?[A-Za-z0-9]{10,}['"]?/i.test(message)) {
		return 'Message appears to contain a secret key';
	}

	// Check length (prevent accidentally pasting large data dumps)
	if (message.length > 50000) {
		return 'Message is too long. Consider sending smaller portions.';
	}

	return undefined;
}
