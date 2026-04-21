/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolCall, ToolContext } from '../canonical/types.js';

// === Data Flow Analysis Types (Audit VII-DS13) ===

export interface DataAccessDescriptor {
	type: 'file' | 'env' | 'secret' | 'network-response';
	path?: string;
	sensitivityLevel: 'public' | 'internal' | 'sensitive' | 'secret';
}

export interface DataEgressDescriptor {
	type: 'terminal' | 'network' | 'file-write';
	destination: string;
}

export interface DataFlowEntry {
	toolName: string;
	toolCallId: string;
	timestamp: string;
	dataAccessed: DataAccessDescriptor[];
	dataEgressed: DataEgressDescriptor[];
}

export interface ChainAnalysis {
	dangerous: boolean;
	reason?: string;
	chainLength: number;
}

// === Dangerous Sequences ===

interface SequencePattern {
	name: string;
	steps: string[];
	description: string;
}

const DANGEROUS_SEQUENCES: SequencePattern[] = [
	{
		name: 'read-then-exfiltrate',
		steps: ['read_file', 'run_terminal'],
		description: 'Reading file contents then executing a terminal command (possible exfiltration)',
	},
	{
		name: 'inject-then-execute',
		steps: ['search_code', 'write_file', 'run_terminal'],
		description: 'Searching code, writing a file, then executing (possible code injection)',
	},
	{
		name: 'download-then-execute',
		steps: ['web_fetch', 'write_file', 'run_terminal'],
		description: 'Fetching from web, writing to file, then executing (download and execute)',
	},
	{
		name: 'download-direct-execute',
		steps: ['web_fetch', 'run_terminal'],
		description: 'Fetching from web then executing a terminal command',
	},
];

const EGRESS_TOOLS = new Set(['run_terminal', 'run_command', 'web_fetch', 'web_search']);

/**
 * Data flow analysis — tracks data access and flags sensitive egress (Audit VII-DS13).
 */
export class DataFlowAnalysis {

	private readonly flowLog: DataFlowEntry[] = [];

	recordAccess(toolName: string, toolCallId: string, access: DataAccessDescriptor): void {
		let entry = this.flowLog.find(e => e.toolCallId === toolCallId);
		if (!entry) {
			entry = { toolName, toolCallId, timestamp: new Date().toISOString(), dataAccessed: [], dataEgressed: [] };
			this.flowLog.push(entry);
		}
		entry.dataAccessed.push(access);
	}

	recordEgress(toolName: string, toolCallId: string, egress: DataEgressDescriptor): void {
		let entry = this.flowLog.find(e => e.toolCallId === toolCallId);
		if (!entry) {
			entry = { toolName, toolCallId, timestamp: new Date().toISOString(), dataAccessed: [], dataEgressed: [] };
			this.flowLog.push(entry);
		}
		entry.dataEgressed.push(egress);
	}

	checkForSensitiveEgress(_sessionId: string): { flagged: boolean; reason?: string; accessEntry?: DataFlowEntry; egressEntry?: DataFlowEntry } {
		// Check if any sensitive data was accessed and then egressed
		const sensitiveAccesses = this.flowLog.filter(e =>
			e.dataAccessed.some(a => a.sensitivityLevel === 'sensitive' || a.sensitivityLevel === 'secret')
		);

		if (sensitiveAccesses.length === 0) {
			return { flagged: false };
		}

		const egressEntries = this.flowLog.filter(e => e.dataEgressed.length > 0);

		for (const access of sensitiveAccesses) {
			for (const egress of egressEntries) {
				// If egress happened after access
				if (egress.timestamp >= access.timestamp) {
					return {
						flagged: true,
						reason: `Sensitive data (${access.dataAccessed[0].type}: ${access.dataAccessed[0].path ?? 'unknown'}) was accessed, followed by egress via ${egress.toolName}`,
						accessEntry: access,
						egressEntry: egress,
					};
				}
			}
		}

		return { flagged: false };
	}

	clear(): void {
		this.flowLog.length = 0;
	}
}

/**
 * Tool chain monitor — detects dangerous tool call sequences (Audit VII-DS13).
 */
export class ToolChainMonitor {

	private readonly recentCalls = new Map<string, Array<{ toolName: string; timestamp: number }>>();
	private readonly dataFlowAnalysis = new DataFlowAnalysis();
	private readonly MAX_HISTORY = 20;

	get dataFlow(): DataFlowAnalysis {
		return this.dataFlowAnalysis;
	}

	recordToolCall(toolCall: ToolCall, context: ToolContext): void {
		const sessionId = context.sessionId;
		if (!this.recentCalls.has(sessionId)) {
			this.recentCalls.set(sessionId, []);
		}

		const calls = this.recentCalls.get(sessionId)!;
		calls.push({ toolName: toolCall.name, timestamp: Date.now() });

		// Trim to max history
		if (calls.length > this.MAX_HISTORY) {
			calls.splice(0, calls.length - this.MAX_HISTORY);
		}
	}

	analyzeCurrentChain(sessionId: string): ChainAnalysis {
		const calls = this.recentCalls.get(sessionId);
		if (!calls || calls.length < 2) {
			return { dangerous: false, chainLength: calls?.length ?? 0 };
		}

		const toolNames = calls.map(c => c.toolName);

		// Check each dangerous sequence
		for (const pattern of DANGEROUS_SEQUENCES) {
			if (this.matchesSequence(toolNames, pattern.steps)) {
				return {
					dangerous: true,
					reason: pattern.description,
					chainLength: calls.length,
				};
			}
		}

		// Check rapid file deletion
		const recentDeletes = calls.slice(-15).filter(c => c.toolName === 'delete_file');
		if (recentDeletes.length > 10) {
			return {
				dangerous: true,
				reason: 'Rapid file deletion detected (>10 files in sequence)',
				chainLength: calls.length,
			};
		}

		// Check rapid system path writes
		const recentWrites = calls.slice(-10).filter(c => c.toolName === 'write_file');
		if (recentWrites.length > 5) {
			return {
				dangerous: true,
				reason: 'Rapid file writes detected — may be overwriting system files',
				chainLength: calls.length,
			};
		}

		return { dangerous: false, chainLength: calls.length };
	}

	wouldCreateDangerousSequence(proposedCall: ToolCall, sessionId: string): { dangerous: boolean; reason?: string } {
		const calls = this.recentCalls.get(sessionId) ?? [];
		const toolNames = [...calls.map(c => c.toolName), proposedCall.name];

		for (const pattern of DANGEROUS_SEQUENCES) {
			if (this.matchesSequence(toolNames, pattern.steps)) {
				return { dangerous: true, reason: pattern.description };
			}
		}

		// VII-DS13: Check sensitive egress before allowing egress-capable tools
		if (EGRESS_TOOLS.has(proposedCall.name)) {
			const egressCheck = this.dataFlowAnalysis.checkForSensitiveEgress(sessionId);
			if (egressCheck.flagged) {
				return { dangerous: true, reason: egressCheck.reason };
			}
		}

		return { dangerous: false };
	}

	/**
	 * Check if the tool name sequence contains the pattern as a subsequence.
	 */
	private matchesSequence(toolNames: string[], pattern: string[]): boolean {
		let patternIdx = 0;
		for (const name of toolNames) {
			if (name === pattern[patternIdx]) {
				patternIdx++;
				if (patternIdx === pattern.length) {
					return true;
				}
			}
		}
		return false;
	}

	clearSession(sessionId: string): void {
		this.recentCalls.delete(sessionId);
		this.dataFlowAnalysis.clear();
	}
}
