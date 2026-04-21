/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SECRET_PATTERNS, SecretPatternDefinition } from './secretPatterns.js';
import { StreamingSecretScanner } from './streamingScanner.js';

export interface ScanResult {
	hasSecrets: boolean;
	redactedText: string;
	findings: SecretFinding[];
}

export interface SecretFinding {
	pattern: string;
	startIndex: number;
	endIndex: number;
	severity: 'high' | 'medium' | 'low';
}

/**
 * Aho-Corasick-style prefix-based pre-filter + full regex validation (Audit IV-AO6).
 * O(n) prefix scan phase, then targeted regex on matches only.
 */
export class OptimizedSecretScanner {
	private readonly prefixMap = new Map<string, SecretPatternDefinition[]>();
	private readonly contextOnlyPatterns: SecretPatternDefinition[] = [];
	private readonly CONTEXT_WINDOW = 200;

	constructor(additionalPatterns?: SecretPatternDefinition[]) {
		const allPatterns = [...SECRET_PATTERNS, ...(additionalPatterns ?? [])];
		for (const p of allPatterns) {
			if (p.prefix.length > 0) {
				const existing = this.prefixMap.get(p.prefix) ?? [];
				existing.push(p);
				this.prefixMap.set(p.prefix, existing);
			} else {
				// Patterns with empty prefix: use global regex scan (context-only or unconditional)
				this.contextOnlyPatterns.push(p);
			}
		}
	}

	scan(text: string): ScanResult {
		const findings: SecretFinding[] = [];
		const redactions: Array<{ start: number; end: number }> = [];

		// Phase 1: Prefix-based scan — O(n) scan for known prefixes
		for (const [prefix, patterns] of this.prefixMap) {
			let searchFrom = 0;
			while (true) {
				const idx = text.indexOf(prefix, searchFrom);
				if (idx === -1) { break; }
				searchFrom = idx + 1;

				for (const patternDef of patterns) {
					// Extract a window around the match for regex validation
					const windowStart = Math.max(0, idx - 10);
					const windowEnd = Math.min(text.length, idx + prefix.length + 200);
					const window = text.slice(windowStart, windowEnd);
					const match = patternDef.pattern.exec(window);

					if (match) {
						const absoluteStart = windowStart + match.index;
						const absoluteEnd = absoluteStart + match[0].length;

						// Check context if required (Audit VII-DS11)
						if (patternDef.contextRequired) {
							const ctxStart = Math.max(0, absoluteStart - this.CONTEXT_WINDOW);
							const ctxEnd = Math.min(text.length, absoluteEnd + this.CONTEXT_WINDOW);
							const context = text.slice(ctxStart, ctxEnd);
							if (!patternDef.contextRequired.test(context)) {
								continue;
							}
						}

						findings.push({
							pattern: patternDef.name,
							startIndex: absoluteStart,
							endIndex: absoluteEnd,
							severity: patternDef.severity,
						});
						redactions.push({ start: absoluteStart, end: absoluteEnd });
					}
				}
			}
		}

		// Phase 2: Context-only patterns (no prefix, require contextRequired)
		for (const patternDef of this.contextOnlyPatterns) {
			let match: RegExpExecArray | null;
			const regex = new RegExp(patternDef.pattern.source, patternDef.pattern.flags + (patternDef.pattern.flags.includes('g') ? '' : 'g'));
			while ((match = regex.exec(text)) !== null) {
				const absoluteStart = match.index;
				const absoluteEnd = absoluteStart + match[0].length;

				const ctxStart = Math.max(0, absoluteStart - this.CONTEXT_WINDOW);
				const ctxEnd = Math.min(text.length, absoluteEnd + this.CONTEXT_WINDOW);
				const context = text.slice(ctxStart, ctxEnd);

				if (!patternDef.contextRequired || patternDef.contextRequired.test(context)) {
					findings.push({
						pattern: patternDef.name,
						startIndex: absoluteStart,
						endIndex: absoluteEnd,
						severity: patternDef.severity,
					});
					redactions.push({ start: absoluteStart, end: absoluteEnd });
				}
			}
		}

		// Build redacted text
		const redactedText = this.applyRedactions(text, redactions);

		return {
			hasSecrets: findings.length > 0,
			redactedText,
			findings,
		};
	}

	createStreamingScanner(): StreamingSecretScanner {
		return new StreamingSecretScanner(this);
	}

	/**
	 * Convenience method to redact secrets from text.
	 * Returns the redacted string (equivalent to scan().redactedText).
	 */
	redact(text: string): string {
		return this.scan(text).redactedText;
	}

	/**
	 * Apply redactions preserving string length to avoid breaking JSON structure
	 * or invalidating line/column positions. Uses '*' padding to maintain length.
	 */
	private applyRedactions(text: string, redactions: Array<{ start: number; end: number }>): string {
		if (redactions.length === 0) {
			return text;
		}

		// Sort by start position, merge overlapping
		const sorted = [...redactions].sort((a, b) => a.start - b.start);
		const merged: Array<{ start: number; end: number }> = [sorted[0]];

		for (let i = 1; i < sorted.length; i++) {
			const last = merged[merged.length - 1];
			if (sorted[i].start <= last.end) {
				last.end = Math.max(last.end, sorted[i].end);
			} else {
				merged.push(sorted[i]);
			}
		}

		let result = '';
		let cursor = 0;
		for (const r of merged) {
			result += text.slice(cursor, r.start);
			const secretLen = r.end - r.start;
			// Fixed-length redaction: [REDACTED] label + '*' padding to preserve string length
			const label = '[REDACTED]';
			if (secretLen >= label.length) {
				result += label + '*'.repeat(secretLen - label.length);
			} else {
				// Secret shorter than label — use truncated marker
				result += '*'.repeat(secretLen);
			}
			cursor = r.end;
		}
		result += text.slice(cursor);
		return result;
	}
}
