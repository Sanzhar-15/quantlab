/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolContext } from '../canonical/types.js';
import type { ArgumentAnalyzer } from './argumentAnalyzer.js';

export interface CommandValidationResult {
	allowed: boolean;
	requiresApproval?: boolean;
	reason?: string;
	layer?: number;
}

// Layer 1: Blocked command patterns
const BLOCKED_PATTERNS: RegExp[] = [
	/rm\s+(-rf?|--recursive)\s+\//,           // rm -rf /
	/:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;?\s*:/, // Fork bomb
	/mkfs\./,                                    // Format filesystem
	/dd\s+if=.*of=\/dev\//,                     // Raw disk write
	/chmod\s+777\s+\//,                          // Open all permissions on /
	/curl\s+.*\|\s*bash/,                        // curl pipe to bash
	/curl\s+.*\|\s*sh/,                          // curl pipe to sh
	/wget\s+.*\|\s*bash/,                        // wget pipe to bash
	/wget\s+.*\|\s*sh/,                          // wget pipe to sh
	/>\s*\/etc\//,                               // Write to /etc
	/sudo\s+rm/,                                 // sudo rm
	/sudo\s+chmod/,                              // sudo chmod
	/sudo\s+chown/,                              // sudo chown
	/shutdown/,                                   // System shutdown
	/reboot/,                                     // System reboot
	/init\s+0/,                                   // System halt
	/systemctl\s+(stop|disable|mask)/,           // System service disruption
	/iptables/,                                   // Firewall modification
	/passwd/,                                     // Password change
	/useradd/,                                    // User creation
	/userdel/,                                    // User deletion
	/chroot/,                                     // Change root
	/mount\s/,                                    // Mount filesystem
	/umount\s/,                                   // Unmount filesystem
];

// Layer 2: Allowed command prefixes
const ALLOWED_PREFIXES: string[] = [
	'git', 'npm', 'npx', 'pip', 'pip3', 'python', 'python3', 'node',
	'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo', 'pwd',
	'date', 'which', 'env', 'tsc', 'eslint', 'prettier', 'jest',
	'pytest', 'cargo', 'go', 'rustc', 'make', 'cmake',
	'mkdir', 'cp', 'mv', 'touch', 'diff', 'sort', 'uniq',
	'sed', 'awk', 'tr', 'cut', 'xargs', 'basename', 'dirname',
];

/**
 * 4-layer terminal command validation (Audit XI-SV3, VII-DS12).
 *
 * Layer 1: Blocklist — reject dangerous patterns
 * Layer 2: Allowlist — only permit known-safe command prefixes
 * Layer 3: Argument analysis — structured per-command validation
 * Layer 4: Context analysis — escalation pattern detection
 */
export class TerminalSecurityGuard {

	private readonly commandHistory: string[] = [];

	constructor(
		private readonly argumentAnalyzer: ArgumentAnalyzer,
	) {}

	async validateCommand(command: string, _context: ToolContext): Promise<CommandValidationResult> {
		const trimmed = command.trim();

		// Layer 1: Blocklist
		for (const pattern of BLOCKED_PATTERNS) {
			if (pattern.test(trimmed)) {
				return { allowed: false, reason: `Blocked by security policy: matches dangerous pattern`, layer: 1 };
			}
		}

		// Layer 2: Allowlist
		const commandName = trimmed.split(/\s+/)[0];
		if (!ALLOWED_PREFIXES.includes(commandName)) {
			return { allowed: false, reason: `Command '${commandName}' is not in the allowed list`, layer: 2 };
		}

		// Layer 3: Structured argument analysis
		const analysis = this.argumentAnalyzer.analyzeCommand(trimmed);
		if (!analysis.allowed) {
			return { allowed: false, reason: analysis.reason, layer: 3 };
		}

		// Layer 4: Context analysis — check for escalation patterns
		const contextResult = this.checkContextEscalation(trimmed);
		if (!contextResult.allowed) {
			return { ...contextResult, layer: 4 };
		}

		// Track command in history
		this.commandHistory.push(trimmed);
		if (this.commandHistory.length > 50) {
			this.commandHistory.shift();
		}

		return {
			allowed: true,
			requiresApproval: analysis.requiresApproval,
			layer: analysis.requiresApproval ? 3 : undefined,
		};
	}

	/**
	 * Layer 4: Check recent command history for escalation patterns.
	 */
	private checkContextEscalation(command: string): CommandValidationResult {
		// Pattern: rapid successive rm/delete commands
		const recentDeletes = this.commandHistory.slice(-10).filter(c =>
			/\brm\b/.test(c) || /\bdelete\b/.test(c)
		);
		if (recentDeletes.length > 5 && /\brm\b/.test(command)) {
			return { allowed: false, reason: 'Too many delete commands in recent history' };
		}

		// Pattern: chmod/chown escalation
		const recentPerms = this.commandHistory.slice(-5).filter(c =>
			/\bchmod\b/.test(c) || /\bchown\b/.test(c)
		);
		if (recentPerms.length > 2) {
			return { allowed: false, reason: 'Suspicious permission change pattern detected' };
		}

		return { allowed: true };
	}
}
