/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { UIService } from '../canonical/interfaces.js';
import type { EditScript, ApprovalToken, PermissionCheckResult, ToolContext } from '../canonical/types.js';
import { randomUUID, sha256Hex } from '../qicCrypto.js';

/**
 * Test-only UIService (Audit II-PG3, I-6).
 * Auto-approval is ONLY allowed when QIC_AUTO_APPROVE_FOR_TESTING=true.
 * Replaced by real UI in Prompts 12-13.
 */
export class TestUIService implements UIService {

	async showDiffPreview(editScript: EditScript): Promise<ApprovalToken | null> {
		if (process.env.QIC_AUTO_APPROVE_FOR_TESTING !== 'true') {
			throw new Error('TestUIService: Cannot show diff preview without UI. Set QIC_AUTO_APPROVE_FOR_TESTING=true for testing.');
		}
		return {
			id: randomUUID(),
			editScriptHash: sha256Hex(JSON.stringify(editScript)),
			grantedAt: new Date().toISOString(),
			grantedBy: 'auto-test',
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
		};
	}

	async showPermissionDialog(_tool: string, _context: ToolContext): Promise<PermissionCheckResult> {
		if (process.env.QIC_AUTO_APPROVE_FOR_TESTING !== 'true') {
			throw new Error('TestUIService: Cannot show permission dialog without UI. Set QIC_AUTO_APPROVE_FOR_TESTING=true for testing.');
		}
		return { status: 'granted', scope: 'session' };
	}

	showToolCall(_toolCallId: string, _toolName: string, _args: Record<string, unknown>): void {}

	showToolResult(_toolCallId: string, _content: string, _isError: boolean): void {}

	streamChatToken(_token: string): void {}

	completeStreaming(): void {}

	showInfo(_message: string): void {}

	showWarning(_message: string): void {}

	showError(_message: string): void {}
}

/** @deprecated Use TestUIService instead */
export const UIServiceStub = TestUIService;
