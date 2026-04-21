/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ToolCall,
	ToolResult,
	ToolContext,
	ToolImplementation,
	ToolHandler,
} from '../canonical/types.js';
import type { PermissionManager } from './permissionManager.js';
import type { SecurityAuditLogger } from '../security/auditLogger.js';

/**
 * Tool router — dispatches tool calls to registered implementations.
 * register() method per Audit X-PS2.
 * Permission dialog cancellation handling per Audit XII-AR3.
 * All tool calls logged via SecurityAuditLogger per INV-T2.
 */
export class ToolRouter {

	private readonly implementations = new Map<string, ToolImplementation>();

	constructor(
		private readonly permissionManager: PermissionManager,
		private readonly securityLogger: SecurityAuditLogger,
	) {}

	/**
	 * Register a tool implementation (Audit X-PS2).
	 * Throws if a tool with the same name is already registered.
	 */
	register(toolName: string, handler: ToolHandler): void {
		if (this.implementations.has(toolName)) {
			throw new Error(`Tool already registered: ${toolName}`);
		}
		this.implementations.set(toolName, {
			execute: handler,
		});
	}

	/**
	 * Execute a tool call with permission checking and audit logging.
	 */
	async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
		const { id, name, arguments: args } = toolCall;
		const now = new Date().toISOString();

		// Check if tool is registered
		const impl = this.implementations.get(name);
		if (!impl) {
			this.securityLogger.logToolCall({
				toolName: name,
				action: 'execute',
				args,
				sessionId: context.sessionId,
				timestamp: now,
				outcome: 'error',
				reason: 'Tool not registered',
			});
			return { toolCallId: id, content: `Error: Unknown tool '${name}'`, isError: true };
		}

		// Permission check (XII-AR3: handle cancellation)
		try {
			const permission = await this.permissionManager.check(name, context);
			if (permission.status === 'denied') {
				this.securityLogger.logToolCall({
					toolName: name,
					action: 'execute',
					args,
					sessionId: context.sessionId,
					timestamp: now,
					outcome: 'denied',
					reason: permission.reason ?? 'Permission denied',
				});
				return {
					toolCallId: id,
					content: `Permission denied for tool '${name}': ${permission.reason ?? 'User denied'}`,
					isError: true,
				};
			}

			this.securityLogger.logPermissionGrant({
				toolName: name,
				action: 'permission_granted',
				args,
				sessionId: context.sessionId,
				timestamp: now,
				outcome: 'success',
			});
		} catch (err) {
			// XII-AR3: If permission dialog was cancelled (e.g., CancellationError),
			// return a denied result instead of throwing/hanging
			const reason = err instanceof Error ? err.message : 'Permission check cancelled';
			this.securityLogger.logToolCall({
				toolName: name,
				action: 'execute',
				args,
				sessionId: context.sessionId,
				timestamp: now,
				outcome: 'denied',
				reason,
			});
			return {
				toolCallId: id,
				content: `Tool '${name}' cancelled: ${reason}`,
				isError: true,
			};
		}

		// Execute tool
		try {
			const payload = await impl.execute(args, context);

			this.securityLogger.logToolCall({
				toolName: name,
				action: 'execute',
				args,
				sessionId: context.sessionId,
				timestamp: now,
				outcome: 'success',
			});

			return {
				toolCallId: id,
				content: payload.content,
				isError: payload.isError,
			};
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);

			this.securityLogger.logToolCall({
				toolName: name,
				action: 'execute',
				args,
				sessionId: context.sessionId,
				timestamp: now,
				outcome: 'error',
				reason: errorMsg,
			});

			return {
				toolCallId: id,
				content: `Tool '${name}' failed: ${errorMsg}`,
				isError: true,
			};
		}
	}
}
