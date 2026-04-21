/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionCheckResult, ToolContext } from '../canonical/types.js';
import { TOOL_REGISTRY } from '../canonical/tools.js';
import type { UIService } from '../canonical/interfaces.js';

export interface PermissionStore {
	get(toolName: string, sessionId: string): PermissionCheckResult | null;
	set(toolName: string, sessionId: string, result: PermissionCheckResult): void;
}

// Audit III-QI4: Strategy file detection patterns
const STRATEGY_FILE_PATTERNS = [
	/strategies?\//i,
	/\.strategy\.(ts|py|json)$/i,
	/backtest/i,
];

/**
 * Permission manager with trust-aware escalation for strategy files (Audit III-QI4).
 * Returns PermissionCheckResult, NEVER boolean (Audit X-PS2).
 */
export class PermissionManager {

	constructor(
		private readonly permissionStore: PermissionStore,
		private readonly uiService: UIService,
	) {}

	async check(toolName: string, context: ToolContext): Promise<PermissionCheckResult> {
		const toolDef = TOOL_REGISTRY[toolName];

		// III-QI4: Strategy file escalation — always require explicit 'once' approval
		if (this.isStrategyFile(context.targetPath)) {
			return this.requestPermission(toolName, context, 'once');
		}

		// Auto-grant only if tool has no side effects AND does not require permission
		if (toolDef && !toolDef.hasSideEffects && !toolDef.permission.required) {
			return { status: 'granted', scope: 'always' };
		}

		// Tools that don't require explicit permission (but may have side effects)
		if (toolDef && !toolDef.permission.required) {
			return { status: 'granted', scope: 'always' };
		}

		// Check stored permission
		const stored = this.permissionStore.get(toolName, context.sessionId);
		if (stored && stored.status === 'granted') {
			// Check expiration
			if (stored.expiresAt) {
				const expires = new Date(stored.expiresAt).getTime();
				if (Date.now() < expires) {
					return stored;
				}
				// Expired — fall through to re-request
			} else if (stored.scope === 'session' || stored.scope === 'always') {
				return stored;
			}
		}

		// Request from user
		return this.requestPermission(toolName, context);
	}

	private async requestPermission(
		toolName: string,
		context: ToolContext,
		forceScope?: 'once',
	): Promise<PermissionCheckResult> {
		const result = await this.uiService.showPermissionDialog(toolName, context);

		// Override scope for strategy files
		if (forceScope) {
			result.scope = forceScope;
		}

		// Store the result for future checks (unless 'once' scope)
		if (result.status === 'granted' && result.scope !== 'once') {
			this.permissionStore.set(toolName, context.sessionId, result);
		}

		return result;
	}

	isStrategyFile(targetPath?: string): boolean {
		if (!targetPath) { return false; }
		return STRATEGY_FILE_PATTERNS.some(pattern => pattern.test(targetPath));
	}
}
