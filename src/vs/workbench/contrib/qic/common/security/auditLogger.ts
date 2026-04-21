/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { ToolContext } from '../canonical/types.js';
import type { OptimizedSecretScanner } from './secretScanner.js';
import type { QicDatabase } from '../storage/database.js';

export interface AuditEntry {
	timestamp: string;
	domain: 'qic';
	type: string;
	tool?: string;
	status?: string;
	reason?: string;
	details?: Record<string, unknown>;
	sessionId?: string;
	hash?: string;
	crossAuditRef?: string | null;
}

/**
 * SecurityAuditLogger interface — matches the stub from Prompt 10.
 */
export interface SecurityAuditLogger {
	logToolCall(entry: { toolName: string; action: string; args?: Record<string, unknown>; sessionId: string; timestamp: string; outcome?: string; reason?: string }): void;
	logPermissionGrant(entry: { toolName: string; action: string; args?: Record<string, unknown>; sessionId: string; timestamp: string; outcome?: string }): void;
	logEgressAttempt(entry: { toolName: string; action: string; args?: Record<string, unknown>; sessionId: string; timestamp: string; outcome?: string; reason?: string }): void;
	flush(): Promise<void>;
}

/**
 * Hash-chained tamper-detecting audit log (Audit III-QI6, XI-SV1).
 *
 * Algorithm shared with Quantlab engine audit ledger:
 *   hash(entry) = SHA-256(previousHash + JSON.stringify(entry))
 *
 * Audit domains (III-QI6):
 *   - Engine: trading decisions, order routing, risk checks
 *   - Extension: strategy analysis, backtest, research
 *   - QIC: tool executions, permissions, code modifications
 *
 * Cross-domain linking via crossAuditRef field.
 */
export class HashChainedAuditLogger implements SecurityAuditLogger {

	private lastHash = '0'.repeat(64); // Genesis hash
	private readonly entries: AuditEntry[] = [];
	private unflushedStart = 0;
	private db: QicDatabase | null = null;

	constructor(
		private readonly secretScanner: OptimizedSecretScanner,
		private readonly onEntry?: (entry: AuditEntry) => void,
	) {}

	/**
	 * Wire database for persistent audit storage.
	 * The database must already have the audit table created.
	 */
	setDatabase(database: QicDatabase): void {
		this.db = database;
		// Ensure audit table exists
		try {
			database.run(`
				CREATE TABLE IF NOT EXISTS qic_audit_log (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					timestamp TEXT NOT NULL,
					domain TEXT NOT NULL,
					type TEXT NOT NULL,
					tool TEXT,
					status TEXT,
					reason TEXT,
					details_json TEXT,
					session_id TEXT,
					hash TEXT NOT NULL,
					cross_audit_ref TEXT
				)
			`);
			database.run('CREATE INDEX IF NOT EXISTS idx_audit_session ON qic_audit_log(session_id)');
			database.run('CREATE INDEX IF NOT EXISTS idx_audit_type ON qic_audit_log(type)');
		} catch {
			// Table creation may fail in in-memory mode — that's acceptable
		}
	}

	logToolCall(entry: { toolName: string; action: string; args?: Record<string, unknown>; sessionId: string; timestamp: string; outcome?: string; reason?: string }): void {
		this.appendEntry({
			timestamp: entry.timestamp,
			domain: 'qic',
			type: 'tool_call',
			tool: entry.toolName,
			status: entry.outcome ?? 'unknown',
			reason: entry.reason,
			details: entry.args as Record<string, unknown>,
			sessionId: entry.sessionId,
			crossAuditRef: null,
		});
	}

	logPermissionGrant(entry: { toolName: string; action: string; args?: Record<string, unknown>; sessionId: string; timestamp: string; outcome?: string }): void {
		this.appendEntry({
			timestamp: entry.timestamp,
			domain: 'qic',
			type: 'permission_grant',
			tool: entry.toolName,
			status: entry.outcome ?? 'granted',
			details: entry.args as Record<string, unknown>,
			sessionId: entry.sessionId,
			crossAuditRef: null,
		});
	}

	logEgressAttempt(entry: { toolName: string; action: string; args?: Record<string, unknown>; sessionId: string; timestamp: string; outcome?: string; reason?: string }): void {
		this.appendEntry({
			timestamp: entry.timestamp,
			domain: 'qic',
			type: 'egress_attempt',
			tool: entry.toolName,
			status: entry.outcome ?? 'unknown',
			reason: entry.reason,
			details: entry.args as Record<string, unknown>,
			sessionId: entry.sessionId,
			crossAuditRef: null,
		});
	}

	logAuthzGranted(tool: string, context: ToolContext): void {
		this.appendEntry({
			timestamp: new Date().toISOString(),
			domain: 'qic',
			type: 'authz_granted',
			tool,
			status: 'granted',
			sessionId: context.sessionId,
			crossAuditRef: null,
		});
	}

	logAuthzDenied(tool: string, reason: string): void {
		this.appendEntry({
			timestamp: new Date().toISOString(),
			domain: 'qic',
			type: 'authz_denied',
			tool,
			status: 'denied',
			reason,
			crossAuditRef: null,
		});
	}

	logToolExecution(tool: string, status: string, context: ToolContext, meta?: Record<string, unknown>): void {
		this.appendEntry({
			timestamp: new Date().toISOString(),
			domain: 'qic',
			type: 'tool_execution',
			tool,
			status,
			sessionId: context.sessionId,
			details: meta,
			crossAuditRef: null,
		});
	}

	logViolation(type: string, details: Record<string, unknown>): void {
		this.appendEntry({
			timestamp: new Date().toISOString(),
			domain: 'qic',
			type: `violation_${type}`,
			status: 'violation',
			details,
			crossAuditRef: null,
		});
	}

	logEgressRequest(boundary: string, meta: Record<string, unknown>): void {
		this.appendEntry({
			timestamp: new Date().toISOString(),
			domain: 'qic',
			type: 'egress_request',
			status: 'requested',
			details: { boundary, ...meta },
			crossAuditRef: null,
		});
	}

	/**
	 * Verify the entire audit chain integrity (III-QI6).
	 * Returns false if any entry has been tampered with.
	 */
	verifyChainIntegrity(): boolean {
		let expectedHash = '0'.repeat(64);

		for (const entry of this.entries) {
			const entryWithoutHash = { ...entry };
			delete entryWithoutHash.hash;
			const serialized = JSON.stringify(entryWithoutHash);
			const computed = sha256Hex(expectedHash + serialized);

			if (entry.hash !== computed) {
				return false;
			}

			expectedHash = computed;
		}

		return true;
	}

	getEntries(): readonly AuditEntry[] {
		return this.entries;
	}

	async flush(): Promise<void> {
		if (!this.db || this.db.isInMemory) {
			return; // No persistent storage available
		}

		const toFlush = this.entries.slice(this.unflushedStart);
		if (toFlush.length === 0) {
			return;
		}

		try {
			this.db.transaction(() => {
				for (const entry of toFlush) {
					this.db!.run(
						`INSERT INTO qic_audit_log (timestamp, domain, type, tool, status, reason, details_json, session_id, hash, cross_audit_ref)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						entry.timestamp,
						entry.domain,
						entry.type,
						entry.tool ?? null,
						entry.status ?? null,
						entry.reason ?? null,
						entry.details ? JSON.stringify(entry.details) : null,
						entry.sessionId ?? null,
						entry.hash ?? null,
						entry.crossAuditRef ?? null,
					);
				}
			});
			this.unflushedStart = this.entries.length;
		} catch {
			// Flush failure is non-fatal — entries remain in memory for retry
		}
	}

	/**
	 * Append a single entry with secret redaction and hash chaining.
	 */
	private appendEntry(entry: AuditEntry): void {
		// XI-SV1: Redact secrets before writing
		if (entry.details) {
			const detailsJson = JSON.stringify(entry.details);
			const scanResult = this.secretScanner.scan(detailsJson);
			if (scanResult.hasSecrets) {
				entry.details = JSON.parse(scanResult.redactedText);
			}
		}

		// III-QI6: Hash chain
		const entryForHash = { ...entry };
		const serialized = JSON.stringify(entryForHash);
		const hash = sha256Hex(this.lastHash + serialized);
		entry.hash = hash;
		this.lastHash = hash;

		this.entries.push(entry);
		this.onEntry?.(entry);
	}
}
