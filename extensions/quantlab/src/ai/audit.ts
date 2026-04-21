/*---------------------------------------------------------------------------------------------
 *  AI Audit Logging
 *  Local audit log for all AI requests
 *---------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { AIAuditEntry, ConsentCategory } from './types';

/**
 * Audit logger for AI requests.
 * All requests are logged locally for transparency and debugging.
 */
export class AIAuditLogger {
	private static instance: AIAuditLogger | undefined;

	private readonly logDir: string;
	private readonly maxLogSize = 10 * 1024 * 1024; // 10MB
	private readonly maxLogFiles = 5;

	private constructor(storagePath: string) {
		this.logDir = path.join(storagePath, 'ai-audit');
		this.ensureLogDir();
	}

	static initialize(storagePath: string): void {
		if (!AIAuditLogger.instance) {
			AIAuditLogger.instance = new AIAuditLogger(storagePath);
		}
	}

	static getInstance(): AIAuditLogger {
		if (!AIAuditLogger.instance) {
			throw new Error('AIAuditLogger not initialized. Call initialize() first.');
		}
		return AIAuditLogger.instance;
	}

	/**
	 * Log an AI request.
	 */
	log(entry: AIAuditEntry): void {
		const logEntry = {
			...entry,
			timestamp: entry.timestamp.toISOString(),
		};

		const logLine = JSON.stringify(logEntry) + '\n';
		const logFile = this.getCurrentLogFile();

		try {
			fs.appendFileSync(logFile, logLine);
			this.rotateLogsIfNeeded();
		} catch (error) {
			console.error('Failed to write AI audit log:', error);
		}
	}

	/**
	 * Create an audit entry for a request.
	 */
	createEntry(
		sessionId: string,
		messageId: string,
		inputLength: number,
		outputLength: number,
		hadRedactions: boolean,
		consentCategories: ConsentCategory[],
		durationMs: number
	): AIAuditEntry {
		return {
			id: this.generateId(),
			timestamp: new Date(),
			sessionId,
			messageId,
			inputLength,
			outputLength,
			hadRedactions,
			consentCategories,
			durationMs,
		};
	}

	/**
	 * Read recent audit entries.
	 */
	readRecentEntries(limit: number = 100): AIAuditEntry[] {
		const entries: AIAuditEntry[] = [];
		const logFile = this.getCurrentLogFile();

		if (!fs.existsSync(logFile)) {
			return entries;
		}

		try {
			const content = fs.readFileSync(logFile, 'utf-8');
			const lines = content.trim().split('\n');

			// Read from end to get most recent
			const startIdx = Math.max(0, lines.length - limit);
			for (let i = lines.length - 1; i >= startIdx; i--) {
				try {
					const parsed = JSON.parse(lines[i]);
					entries.push({
						...parsed,
						timestamp: new Date(parsed.timestamp),
					});
				} catch {
					// Skip malformed lines
				}
			}
		} catch (error) {
			console.error('Failed to read AI audit log:', error);
		}

		return entries;
	}

	/**
	 * Get statistics for a session.
	 */
	getSessionStats(sessionId: string): {
		totalRequests: number;
		totalInputChars: number;
		totalOutputChars: number;
		redactedRequests: number;
	} {
		const entries = this.readRecentEntries(1000);
		const sessionEntries = entries.filter(e => e.sessionId === sessionId);

		return {
			totalRequests: sessionEntries.length,
			totalInputChars: sessionEntries.reduce((sum, e) => sum + e.inputLength, 0),
			totalOutputChars: sessionEntries.reduce((sum, e) => sum + e.outputLength, 0),
			redactedRequests: sessionEntries.filter(e => e.hadRedactions).length,
		};
	}

	/**
	 * Clear old audit logs.
	 */
	clearOldLogs(daysToKeep: number = 30): void {
		const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

		try {
			const files = fs.readdirSync(this.logDir);
			for (const file of files) {
				const filePath = path.join(this.logDir, file);
				const stats = fs.statSync(filePath);
				if (stats.mtimeMs < cutoff) {
					fs.unlinkSync(filePath);
				}
			}
		} catch (error) {
			console.error('Failed to clear old AI audit logs:', error);
		}
	}

	private ensureLogDir(): void {
		if (!fs.existsSync(this.logDir)) {
			fs.mkdirSync(this.logDir, { recursive: true });
		}
	}

	private getCurrentLogFile(): string {
		const date = new Date().toISOString().split('T')[0];
		return path.join(this.logDir, `ai-audit-${date}.jsonl`);
	}

	private rotateLogsIfNeeded(): void {
		const logFile = this.getCurrentLogFile();

		try {
			const stats = fs.statSync(logFile);
			if (stats.size > this.maxLogSize) {
				// Rename current log with timestamp
				const timestamp = Date.now();
				const rotatedName = logFile.replace('.jsonl', `-${timestamp}.jsonl`);
				fs.renameSync(logFile, rotatedName);

				// Clean up old rotated logs
				this.cleanupRotatedLogs();
			}
		} catch {
			// File doesn't exist yet
		}
	}

	private cleanupRotatedLogs(): void {
		try {
			const files = fs.readdirSync(this.logDir)
				.filter(f => f.startsWith('ai-audit-'))
				.sort()
				.reverse();

			// Keep only maxLogFiles
			for (let i = this.maxLogFiles; i < files.length; i++) {
				fs.unlinkSync(path.join(this.logDir, files[i]));
			}
		} catch (error) {
			console.error('Failed to cleanup rotated logs:', error);
		}
	}

	private generateId(): string {
		return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}
}

/**
 * Log an AI request with automatic entry creation.
 */
export function logAIRequest(
	sessionId: string,
	messageId: string,
	inputLength: number,
	outputLength: number,
	hadRedactions: boolean,
	consentCategories: ConsentCategory[],
	durationMs: number
): void {
	try {
		const logger = AIAuditLogger.getInstance();
		const entry = logger.createEntry(
			sessionId,
			messageId,
			inputLength,
			outputLength,
			hadRedactions,
			consentCategories,
			durationMs
		);
		logger.log(entry);
	} catch {
		// Logger not initialized, skip
	}
}
