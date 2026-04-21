/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';

let _childProcess: any = null;
async function getChildProcess(): Promise<any> {
	if (!_childProcess) {
		try {
			// @ts-ignore
			_childProcess = await import('child_process');
		} catch {
			throw new Error('child_process not available in browser context');
		}
	}
	return _childProcess;
}
import type { ToolResultPayload, ToolContext } from '../canonical/types.js';
import type { TerminalSecurityGuard } from '../security/terminalGuard.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 50_000;

/**
 * Terminal tools (2 tools): run_terminal, run_command.
 * Both MUST validate through TerminalSecurityGuard before execution.
 */
export class TerminalTools {

	constructor(
		private readonly terminalGuard: TerminalSecurityGuard,
		private readonly workspaceRoot: string,
	) {}

	// 11. run_terminal
	async runTerminal(args: Record<string, unknown>, context: ToolContext): Promise<ToolResultPayload> {
		return this.executeCommand(args, context, false);
	}

	// 12. run_command
	async runCommand(args: Record<string, unknown>, context: ToolContext): Promise<ToolResultPayload> {
		return this.executeCommand(args, context, true);
	}

	private async executeCommand(
		args: Record<string, unknown>,
		context: ToolContext,
		captureOutput: boolean,
	): Promise<ToolResultPayload> {
		try {
			const command = String(args.command ?? '');
			if (!command) {
				return { content: 'Error: command is required', isError: true };
			}

			const cwd = args.cwd ? String(args.cwd) : this.workspaceRoot;

			// Validate cwd is within workspace root
			const resolvedCwd = path.resolve(this.workspaceRoot, cwd);
			if (resolvedCwd !== this.workspaceRoot && !resolvedCwd.startsWith(this.workspaceRoot + path.sep)) {
				return {
					content: 'Error: working directory must be within workspace',
					isError: true,
				};
			}

			const timeout = Number(args.timeout) || DEFAULT_TIMEOUT_MS;

			// Validate through TerminalSecurityGuard
			const validation = await this.terminalGuard.validateCommand(command, context);
			if (!validation.allowed) {
				return {
					content: `Command blocked: ${validation.reason ?? 'Security policy violation'}`,
					isError: true,
				};
			}

			if (validation.requiresApproval) {
				return {
					content: `Command requires user approval: ${command}`,
					isError: true,
				};
			}

			// Execute
			const result = await this.exec(command, cwd, timeout);

			if (captureOutput) {
				const output = (result.stdout + (result.stderr ? `\nstderr: ${result.stderr}` : '')).slice(0, MAX_OUTPUT_LENGTH);
				return {
					content: output || '(no output)',
					isError: result.exitCode !== 0,
				};
			}

			return {
				content: `Command executed: ${command} (exit code: ${result.exitCode})`,
				isError: result.exitCode !== 0,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	private async exec(command: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const cp = await getChildProcess();
		return new Promise((resolve) => {
			cp.exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
				resolve({
					stdout: stdout ?? '',
					stderr: stderr ?? '',
					exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
				});
			});
		});
	}
}
