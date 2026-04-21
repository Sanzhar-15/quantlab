/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolResultPayload } from '../canonical/types.js';

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

const GIT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_LENGTH = 50_000;

/**
 * Git tools (3 tools): git_status, git_diff, git_log.
 * Read-only git operations for workspace awareness.
 */
export class GitTools {

	constructor(
		private readonly workspacePath: string,
	) {}

	async gitStatus(_args: Record<string, unknown>): Promise<ToolResultPayload> {
		return this.runGit(['status', '--porcelain=v2', '--branch']);
	}

	async gitDiff(args: Record<string, unknown>): Promise<ToolResultPayload> {
		const staged = args.staged === true || args.staged === 'true';
		const filePath = args.path ? String(args.path) : undefined;

		const gitArgs = ['diff'];
		if (staged) { gitArgs.push('--cached'); }
		gitArgs.push('--stat');
		gitArgs.push('--patch');
		if (filePath) { gitArgs.push('--', filePath); }

		return this.runGit(gitArgs);
	}

	async gitLog(args: Record<string, unknown>): Promise<ToolResultPayload> {
		const count = Math.min(Math.max(Number(args.count) || 10, 1), 50);
		const filePath = args.path ? String(args.path) : undefined;

		const gitArgs = [
			'log',
			`-${count}`,
			'--format=%h %ad %an | %s',
			'--date=short',
		];
		if (filePath) { gitArgs.push('--', filePath); }

		return this.runGit(gitArgs);
	}

	private async runGit(gitArgs: string[]): Promise<ToolResultPayload> {
		try {
			const cp = await getChildProcess();
			const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
				cp.execFile('git', gitArgs, {
					cwd: this.workspacePath,
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: 1024 * 1024,
					encoding: 'utf-8',
				}, (err: any, stdout: string, stderr: string) => {
					if (err && err.killed) {
						reject(new Error(`git timed out after ${GIT_TIMEOUT_MS}ms`));
					} else if (err && err.code === 'ENOENT') {
						reject(new Error('git is not installed or not in PATH'));
					} else {
						// Non-zero exit is common for git (e.g., empty diff) — return output
						resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
					}
				});
			});

			const output = result.stdout || result.stderr || '(no output)';
			const truncated = output.length > MAX_OUTPUT_LENGTH
				? output.slice(0, MAX_OUTPUT_LENGTH) + `\n... (truncated, ${output.length - MAX_OUTPUT_LENGTH} chars omitted)`
				: output;

			return { content: truncated, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}
}
