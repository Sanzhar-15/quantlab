/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolResultPayload, ToolContext } from '../canonical/types.js';

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
import type { TerminalSecurityGuard } from '../security/terminalGuard.js';

const INSTALL_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_OUTPUT_LENGTH = 50_000;

// Allowed package managers
const ALLOWED_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'pip', 'pip3', 'conda']);

// Valid package name pattern: npm scoped packages (@scope/name), pip packages, conda packages
// Blocks shell metacharacters, pipes, semicolons, backticks, $() substitution
const VALID_PACKAGE_NAME = /^[@a-zA-Z0-9][@a-zA-Z0-9._\/-]*$/;

/**
 * Package tools (1 tool): install_package.
 * Validates package manager and delegates through TerminalSecurityGuard.
 */
export class PackageTools {

	constructor(
		private readonly terminalGuard: TerminalSecurityGuard,
		private readonly workspaceRoot: string,
	) {}

	// 15. install_package
	async installPackage(args: Record<string, unknown>, context: ToolContext): Promise<ToolResultPayload> {
		try {
			const packageName = String(args.package ?? '');
			if (!packageName) {
				return { content: 'Error: package is required', isError: true };
			}

			if (!VALID_PACKAGE_NAME.test(packageName)) {
				return { content: 'Error: invalid package name — must match [@a-zA-Z0-9._/-] and cannot contain shell metacharacters', isError: true };
			}

			const manager = String(args.manager ?? 'npm');
			if (!ALLOWED_MANAGERS.has(manager)) {
				return {
					content: `Error: unsupported package manager '${manager}'. Allowed: ${[...ALLOWED_MANAGERS].join(', ')}`,
					isError: true,
				};
			}

			// Build install args (decomposed for execFile — no shell injection)
			const installArgs = this.buildInstallArgs(manager, packageName, args);
			const command = `${installArgs.binary} ${installArgs.args.join(' ')}`;

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
					content: `Package install requires user approval: ${command}`,
					isError: true,
				};
			}

			// Execute via execFile — no shell, prevents injection
			const result = await this.execFile(installArgs.binary, installArgs.args, this.workspaceRoot, INSTALL_TIMEOUT_MS);
			const output = (result.stdout + (result.stderr ? `\nstderr: ${result.stderr}` : '')).slice(0, MAX_OUTPUT_LENGTH);

			return {
				content: output || `Installed ${packageName} via ${manager}`,
				isError: result.exitCode !== 0,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	private buildInstallArgs(manager: string, packageName: string, args: Record<string, unknown>): { binary: string; args: string[] } {
		const isDev = Boolean(args.dev);

		switch (manager) {
			case 'npm':
				return { binary: 'npm', args: ['install', ...(isDev ? ['--save-dev'] : []), packageName] };
			case 'yarn':
				return { binary: 'yarn', args: ['add', ...(isDev ? ['--dev'] : []), packageName] };
			case 'pnpm':
				return { binary: 'pnpm', args: ['add', ...(isDev ? ['--save-dev'] : []), packageName] };
			case 'pip':
			case 'pip3':
				return { binary: manager, args: ['install', packageName] };
			case 'conda':
				return { binary: 'conda', args: ['install', '-y', packageName] };
			default:
				return { binary: manager, args: ['install', packageName] };
		}
	}

	private async execFile(binary: string, args: string[], cwd: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const cp = await getChildProcess();
		return new Promise((resolve) => {
			cp.execFile(binary, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
				resolve({
					stdout: stdout ?? '',
					stderr: stderr ?? '',
					exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
				});
			});
		});
	}
}
