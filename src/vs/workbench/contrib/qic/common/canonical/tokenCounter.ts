/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Message } from './types.js';

// Token counting constants
const MESSAGE_OVERHEAD_TOKENS = 4;
const ROLE_TOKEN = 1;
const PRIMING_TOKENS = 2;
const AVG_CHARS_PER_TOKEN = 4;

/**
 * Token counting utility for QIC.
 *
 * Uses a character-based heuristic (~4 chars/token for cl100k_base).
 * When tiktoken is available, the encoder-based methods should be preferred.
 *
 * NOTE (Audit VIII-PC3): For production accuracy, add `tiktoken` to package.json
 * and replace the heuristic with `encoding_for_model('cl100k_base')`.
 */
export class TokenCounter {

	count(text: string): number {
		return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
	}

	countMessages(messages: Message[]): number {
		let total = 0;
		for (const msg of messages) {
			total += MESSAGE_OVERHEAD_TOKENS;
			if (typeof msg.content === 'string') {
				total += this.count(msg.content);
			} else {
				for (const block of msg.content) {
					if (block.type === 'text') {
						total += this.count(block.text);
					} else if (block.type === 'tool_use') {
						total += this.count(JSON.stringify(block.input));
						total += this.count(block.name);
					}
				}
			}
			total += ROLE_TOKEN;
		}
		total += PRIMING_TOKENS;
		return total;
	}

	truncateToFit(text: string, maxTokens: number): string {
		const maxChars = maxTokens * AVG_CHARS_PER_TOKEN;
		if (text.length <= maxChars) {
			return text;
		}
		return text.slice(0, maxChars);
	}
}

export const tokenCounter = new TokenCounter();
