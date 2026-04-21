/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Message, ContentBlock, ToolResultPayload } from '../canonical/types.js';
import type { LaneName } from '../canonical/lanes.js';
import { tokenCounter } from '../canonical/tokenCounter.js';
import { StatePersistenceManager } from '../storage/statePersistence.js';

export class ConversationState {
	private messages: Message[] = [];
	private lane: LaneName | null = null;
	private readonly _sessionId: string;

	constructor(sessionId: string) {
		this._sessionId = sessionId;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	addUserMessage(text: string): void {
		this.messages.push({ role: 'user', content: text });
	}

	addAssistantMessage(content: ContentBlock[]): void {
		this.messages.push({ role: 'assistant', content });
	}

	addSystemMessage(text: string): void {
		this.messages.push({ role: 'system', content: text });
	}

	addToolResult(toolCallId: string, result: ToolResultPayload): void {
		this.messages.push({
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: toolCallId, content: result.content, is_error: result.isError }],
		});
	}

	/**
	 * Replace all messages with a summary message and optional recent messages.
	 * Used by the summarize lane to prevent unbounded conversation growth (I-SG5).
	 */
	replaceMessages(summaryText: string, recentMessages?: Message[]): void {
		this.messages = [
			{ role: 'system', content: `[Conversation Summary]: ${summaryText}` },
			...(recentMessages ?? []),
		];
	}

	clear(): void {
		this.messages = [];
		this.lane = null;
	}

	getMessages(): Message[] {
		return [...this.messages];
	}

	getLane(): LaneName | null {
		return this.lane;
	}

	setLane(lane: LaneName): void {
		this.lane = lane;
	}

	getTokenCount(): number {
		return tokenCounter.countMessages(this.messages);
	}

	async persist(db: StatePersistenceManager, conversationId: string): Promise<void> {
		db.saveConversationState({
			conversationId,
			sessionId: this._sessionId,
			messagesJson: JSON.stringify(this.messages),
			lane: this.lane ?? 'chat-ask',
			tokenCount: this.getTokenCount(),
		});
	}

	static async restore(
		db: StatePersistenceManager,
		conversationId: string,
	): Promise<ConversationState | null> {
		const snapshot = db.loadConversationState(conversationId);
		if (!snapshot) {
			return null;
		}

		const state = new ConversationState(snapshot.sessionId);
		state.messages = JSON.parse(snapshot.messagesJson);
		state.lane = snapshot.lane as LaneName;
		return state;
	}
}
