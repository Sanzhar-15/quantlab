/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { ProviderRequest, ProviderResponse } from '../canonical/types.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}

export type ReplayMode = 'off' | 'strict' | 'best-effort' | 'fallback';

interface RecordedEntry {
	key: string;
	request: Omit<ProviderRequest, 'signal'>;
	response: ProviderResponse;
}

/**
 * Replay mode support — reproduce recorded LLM sessions for debugging.
 *
 * 3 modes:
 * - strict: exact match required, fail if not found
 * - best-effort: fuzzy match, return closest
 * - fallback: try cache first, then live request
 */
export class ReplayModeSupport {

	private recordings = new Map<string, ProviderResponse>();
	private recordingsIndex: RecordedEntry[] = [];
	private mode: ReplayMode = 'off';

	/**
	 * Activate replay mode from a recording file (JSONL format).
	 */
	async activateReplayMode(recordingPath: string, mode: 'strict' | 'best-effort' | 'fallback'): Promise<void> {
		const fs = await fsPromises();
		const content = await fs.readFile(recordingPath, 'utf-8');
		const lines = content.trim().split('\n').filter(l => l.length > 0);

		this.recordings.clear();
		this.recordingsIndex = [];

		for (const line of lines) {
			const entry = JSON.parse(line);
			const key = this.computeKey(entry.request);
			this.recordings.set(key, entry.response);
			this.recordingsIndex.push({
				key,
				request: entry.request,
				response: entry.response,
			});
		}

		this.mode = mode;
	}

	/**
	 * Deactivate replay mode.
	 */
	deactivateReplayMode(): void {
		this.mode = 'off';
		this.recordings.clear();
		this.recordingsIndex = [];
	}

	/**
	 * Get a replay response for a request.
	 * Returns null if no match found (behavior depends on mode).
	 */
	getReplayResponse(request: ProviderRequest): ProviderResponse | null {
		if (this.mode === 'off') {
			return null;
		}

		const key = this.computeKey(request);

		// Try exact match first
		const exact = this.recordings.get(key);
		if (exact) {
			return exact;
		}

		if (this.mode === 'strict') {
			// Strict mode: no match → return null (caller should throw)
			return null;
		}

		if (this.mode === 'best-effort') {
			// Fuzzy match: find closest by model + last message content
			return this.findClosestMatch(request);
		}

		// Fallback mode: return null (caller should make live request)
		return null;
	}

	/**
	 * Get current replay mode.
	 */
	getMode(): ReplayMode {
		return this.mode;
	}

	/**
	 * Check if replay mode is active.
	 */
	isActive(): boolean {
		return this.mode !== 'off';
	}

	/**
	 * Get number of loaded recordings.
	 */
	recordingCount(): number {
		return this.recordings.size;
	}

	/**
	 * Compute cache key matching SessionCache's approach (I-8 compliant).
	 */
	private computeKey(request: Omit<ProviderRequest, 'signal'>): string {
		return sha256Hex(JSON.stringify({
				model: request.model,
				messages: request.messages,
				tools: request.tools,
				temperature: request.temperature,
			}));
	}

	/**
	 * Find the closest matching recording (best-effort mode).
	 * Matches on: same model + similar last message content.
	 */
	private findClosestMatch(request: ProviderRequest): ProviderResponse | null {
		if (this.recordingsIndex.length === 0) {
			return null;
		}

		const lastMessage = this.getLastUserMessage(request);
		if (!lastMessage) {
			return null;
		}

		let bestMatch: RecordedEntry | null = null;
		let bestScore = 0;

		for (const entry of this.recordingsIndex) {
			let score = 0;

			// Same model
			if (entry.request.model === request.model) {
				score += 1;
			}

			// Same last user message
			const recordedLastMessage = this.getLastUserMessage(entry.request as ProviderRequest);
			if (recordedLastMessage && recordedLastMessage === lastMessage) {
				score += 3;
			} else if (recordedLastMessage && lastMessage.includes(recordedLastMessage.slice(0, 50))) {
				score += 1;
			}

			// Same number of messages
			if (entry.request.messages?.length === request.messages?.length) {
				score += 1;
			}

			if (score > bestScore) {
				bestScore = score;
				bestMatch = entry;
			}
		}

		return bestMatch?.response ?? null;
	}

	/**
	 * Extract the last user message content as a string.
	 */
	private getLastUserMessage(request: Omit<ProviderRequest, 'signal'>): string | null {
		if (!request.messages || request.messages.length === 0) {
			return null;
		}

		for (let i = request.messages.length - 1; i >= 0; i--) {
			const msg = request.messages[i];
			if (msg.role === 'user') {
				if (typeof msg.content === 'string') {
					return msg.content;
				}
				if (Array.isArray(msg.content)) {
					const textBlock = msg.content.find(b => b.type === 'text');
					if (textBlock && 'text' in textBlock) {
						return textBlock.text;
					}
				}
			}
		}

		return null;
	}
}
