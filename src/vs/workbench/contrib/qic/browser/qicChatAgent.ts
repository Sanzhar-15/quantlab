/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IChatAgentData,
	IChatAgentHistoryEntry,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentService,
} from '../../chat/common/participants/chatAgents.js';
import { IChatFollowup, IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IQicChatService } from './qicChatService.js';

const QIC_AGENT_ID = 'qic';

/**
 * QIC Chat Agent -- registers QIC as a native VS Code chat participant.
 *
 * This replaces the webview-based chat UI with the native ChatWidget.
 * The agent delegates to QicChatService for actual LLM communication,
 * which in turn uses the existing AgentOrchestrator infrastructure.
 */
export class QicChatAgent extends Disposable implements IChatAgentImplementation {

	static readonly ID = 'workbench.contrib.qic.chatAgent';

	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IQicChatService private readonly qicChatService: IQicChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._registerAgent();
	}

	private _registerAgent(): void {
		const agentData: IChatAgentData = {
			id: QIC_AGENT_ID,
			name: 'orion',
			fullName: 'Orion Assistant',
			description: 'Orion AI Assistant for quantitative trading',
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionPublisherId: nullExtensionDescription.publisher,
			extensionDisplayName: 'Orion',
			isDefault: true,
			isCore: true,
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Ask, ChatModeKind.Agent, ChatModeKind.Edit],
			slashCommands: [
				{ name: 'explain', description: 'Explain code in detail' },
				{ name: 'fix', description: 'Find and fix bugs' },
				{ name: 'test', description: 'Write tests for code' },
				{ name: 'refactor', description: 'Refactor and improve code' },
				{ name: 'checkpoint', description: 'Create a checkpoint of current state' },
			],
			disambiguation: [],
			metadata: {
				sampleRequest: 'Explain this function',
			},
		};

		// Register agent metadata
		this._disposables.add(
			this.chatAgentService.registerAgent(QIC_AGENT_ID, agentData)
		);

		// Register agent implementation
		this._disposables.add(
			this.chatAgentService.registerAgentImplementation(QIC_AGENT_ID, this)
		);

		this.logService.info('[QicChatAgent] Registered as native chat participant');
	}

	/**
	 * Main handler -- called when user sends a message targeting the QIC agent.
	 * Streams response via the `progress` callback.
	 */
	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		this.logService.trace(`[QicChatAgent] invoke: "${request.message}" command=${request.command}`);

		const result = await this.qicChatService.sendMessage(
			request.message,
			request.command,
			progress,
			token,
		);

		if (result.errorDetails) {
			return {
				errorDetails: {
					message: result.errorDetails.message,
				},
				timings: result.timings ? {
					firstProgress: result.timings.firstProgress,
					totalElapsed: result.timings.totalElapsed,
				} : undefined,
			};
		}

		return {
			timings: result.timings ? {
				firstProgress: result.timings.firstProgress,
				totalElapsed: result.timings.totalElapsed,
			} : undefined,
		};
	}

	/**
	 * Provide follow-up suggestions after a response.
	 */
	async provideFollowups(
		request: IChatAgentRequest,
		_result: IChatAgentResult,
		_history: IChatAgentHistoryEntry[],
		_token: CancellationToken,
	): Promise<IChatFollowup[]> {
		// Provide contextual follow-ups based on the last command
		const followups: IChatFollowup[] = [];

		if (request.command === 'explain') {
			followups.push({
				kind: 'reply',
				message: 'Can you simplify this code?',
				agentId: QIC_AGENT_ID,
				title: 'Simplify',
			});
		} else if (request.command === 'fix') {
			followups.push({
				kind: 'reply',
				message: 'Write tests for this fix',
				agentId: QIC_AGENT_ID,
				subCommand: 'test',
				title: 'Write Tests',
			});
		}

		return followups;
	}

	/**
	 * Generate a title for the chat session.
	 */
	async provideChatTitle(
		history: IChatAgentHistoryEntry[],
		_token: CancellationToken,
	): Promise<string | undefined> {
		if (history.length === 0) {
			return undefined;
		}

		// Use the first user message as the title (truncated)
		const firstMessage = history[0]?.request.message;
		if (firstMessage) {
			const title = firstMessage.length > 50
				? firstMessage.substring(0, 47) + '...'
				: firstMessage;
			return title;
		}

		return 'Orion Chat';
	}
}
