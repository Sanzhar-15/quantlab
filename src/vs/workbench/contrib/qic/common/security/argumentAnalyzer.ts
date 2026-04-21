/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structured command argument validation (Audit VII-DS12, XI-SV3).
 * Layer 3 of TerminalSecurityGuard.
 *
 * Uses structured parsing (no shell-quote dependency — uses a safe built-in parser)
 * to split commands and apply per-command argument rules.
 */

export interface ArgumentAnalysisResult {
	allowed: boolean;
	requiresApproval: boolean;
	reason?: string;
	command: string;
	args: string[];
}

interface CommandArgumentRule {
	blockedFlags: string[];
	blockedSubcommands: string[];
	requiresApproval: string[];    // subcommands that need user approval ('*' = all)
	requiredFlags?: string[];      // flags that must be present
}

// Shell metacharacters that indicate piping, redirection, or subshells
const SHELL_METACHARS = /[|;&`$><]/;

const COMMAND_RULES: Record<string, CommandArgumentRule> = {
	python: {
		blockedFlags: ['-c'],
		blockedSubcommands: [],
		requiresApproval: [],
	},
	python3: {
		blockedFlags: ['-c'],
		blockedSubcommands: [],
		requiresApproval: [],
	},
	git: {
		blockedFlags: ['-c'],
		blockedSubcommands: ['remote set-url'],
		requiresApproval: ['push', 'push --force'],
	},
	npx: {
		blockedFlags: [],
		blockedSubcommands: [],
		requiresApproval: ['*'],
		requiredFlags: ['--yes'],
	},
	npm: {
		blockedFlags: [],
		blockedSubcommands: ['exec'],
		requiresApproval: ['install', 'ci', 'run'],
	},
	node: {
		blockedFlags: ['-e', '--eval'],
		blockedSubcommands: [],
		requiresApproval: [],
	},
	curl: {
		blockedFlags: ['-o', '--output', '-O', '--remote-name', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form', '-T', '--upload-file'],
		blockedSubcommands: [],
		requiresApproval: [],
	},
	wget: {
		blockedFlags: [],
		blockedSubcommands: [],
		requiresApproval: ['*'],
	},
	env: {
		blockedFlags: [],
		blockedSubcommands: [],
		requiresApproval: ['*'],
	},
	awk: {
		blockedFlags: [],
		blockedSubcommands: [],
		requiresApproval: ['*'],
	},
	sed: {
		blockedFlags: ['-e'],
		blockedSubcommands: [],
		requiresApproval: ['*'],
	},
	xargs: {
		blockedFlags: [],
		blockedSubcommands: [],
		requiresApproval: ['*'],
	},
	find: {
		blockedFlags: ['-delete', '-exec', '-execdir', '-ok', '-okdir'],
		blockedSubcommands: [],
		requiresApproval: [],
	},
};

export class ArgumentAnalyzer {

	analyzeCommand(rawCommand: string): ArgumentAnalysisResult {
		const trimmed = rawCommand.trim();

		// Step 1: Check for shell metacharacters
		if (this.containsShellMetachars(trimmed)) {
			return {
				allowed: false,
				requiresApproval: false,
				reason: 'Command contains shell metacharacters (pipes, redirects, or subshells)',
				command: trimmed,
				args: [],
			};
		}

		// Step 2: Parse command into tokens (safe split)
		const tokens = this.parseTokens(trimmed);
		if (tokens.length === 0) {
			return { allowed: false, requiresApproval: false, reason: 'Empty command', command: '', args: [] };
		}

		// Step 3: Extract command name and arguments
		const command = tokens[0];
		const args = tokens.slice(1);

		// Step 4: Apply per-command rules
		const rule = COMMAND_RULES[command];
		if (!rule) {
			// No specific rule — allowed by default (Layer 2 allowlist handles unknown commands)
			return { allowed: true, requiresApproval: false, command, args };
		}

		// Check blocked flags
		for (const flag of rule.blockedFlags) {
			if (args.includes(flag)) {
				return {
					allowed: false,
					requiresApproval: false,
					reason: `Flag '${flag}' is blocked for '${command}'`,
					command,
					args,
				};
			}
		}

		// Check blocked subcommands
		const subcommand = args.slice(0, 2).join(' ');
		for (const blocked of rule.blockedSubcommands) {
			if (subcommand === blocked || args[0] === blocked) {
				return {
					allowed: false,
					requiresApproval: false,
					reason: `Subcommand '${blocked}' is blocked for '${command}'`,
					command,
					args,
				};
			}
		}

		// Check required flags
		if (rule.requiredFlags && rule.requiredFlags.length > 0) {
			for (const required of rule.requiredFlags) {
				if (!args.includes(required)) {
					return {
						allowed: false,
						requiresApproval: false,
						reason: `Required flag '${required}' missing for '${command}'`,
						command,
						args,
					};
				}
			}
		}

		// Check requires approval
		if (rule.requiresApproval.includes('*')) {
			return { allowed: true, requiresApproval: true, command, args };
		}
		for (const sub of rule.requiresApproval) {
			if (args[0] === sub || subcommand === sub) {
				return {
					allowed: true,
					requiresApproval: true,
					reason: `'${command} ${sub}' requires user approval`,
					command,
					args,
				};
			}
		}

		return { allowed: true, requiresApproval: false, command, args };
	}

	/**
	 * Detect shell metacharacters that indicate piping, redirection, or subshells (VII-DS12).
	 */
	containsShellMetachars(command: string): boolean {
		// Quote-aware scan: skip metacharacters and operators inside quoted strings
		let inSingle = false;
		let inDouble = false;
		for (let i = 0; i < command.length; i++) {
			const ch = command[i];
			if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
			if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
			if (inSingle || inDouble) { continue; }
			// Check multi-char operators at current position (outside quotes)
			const next = command[i + 1];
			if ((ch === '|' && next === '|') || (ch === '&' && next === '&') ||
				(ch === '$' && next === '(') || ch === '`') {
				return true;
			}
			// Check individual metacharacters
			if (SHELL_METACHARS.test(ch)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Safe token parser — splits on whitespace, respecting quoted strings.
	 */
	private parseTokens(command: string): string[] {
		const tokens: string[] = [];
		let current = '';
		let inSingle = false;
		let inDouble = false;

		for (let i = 0; i < command.length; i++) {
			const ch = command[i];

			// H10: Handle backslash escapes (outside single quotes)
			if (ch === '\\' && !inSingle && i + 1 < command.length) {
				current += command[++i]; // consume next char literally
				continue;
			}

			if (ch === "'" && !inDouble) {
				inSingle = !inSingle;
				continue;
			}
			if (ch === '"' && !inSingle) {
				inDouble = !inDouble;
				continue;
			}
			if (ch === ' ' && !inSingle && !inDouble) {
				if (current) {
					tokens.push(current);
					current = '';
				}
				continue;
			}
			current += ch;
		}

		if (current) {
			tokens.push(current);
		}

		return tokens;
	}
}
