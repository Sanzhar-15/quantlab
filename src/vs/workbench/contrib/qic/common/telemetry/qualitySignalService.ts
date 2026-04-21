/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { QicDatabase } from '../storage/database.js';

/**
 * Quality signal types collected locally for Phase 5 data pipeline.
 * Never sent without explicit DataTier consent.
 */
export type QualitySignalType =
	| 'completion_accept'
	| 'completion_reject'
	| 'edit_distance'
	| 're_request'
	| 'follow_up';

export interface QualitySignalEntry {
	type: QualitySignalType;
	lane: string;
	model: string;
	value: number;
	metadata?: Record<string, string | number | boolean>;
	timestamp: string;
}

interface CompletionSnapshot {
	text: string;
	filePath: string;
	offset: number;
	timestamp: number;
	model: string;
	lane: string;
}

const EDIT_DISTANCE_DEBOUNCE_MS = 10_000;
const RE_REQUEST_WINDOW_MS = 30_000;
const MAX_BUFFER_SIZE = 500;

/**
 * Local quality signal instrumentation (Phase 5 prerequisite).
 *
 * Tracks:
 * - Completion acceptance/rejection via VS Code API hooks
 * - Edit distance (debounced 10s comparison after acceptance)
 * - Re-request detection (same context within 30s window)
 * - Follow-up pattern tracking in orchestrator
 *
 * All data stored locally in SQLite. Never sent without consent.
 */
export class QualitySignalService {
	private _db: QicDatabase | null = null;
	private readonly buffer: QualitySignalEntry[] = [];
	private readonly pendingEditChecks = new Map<string, {
		snapshot: CompletionSnapshot;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly recentRequests: Array<{ contextHash: string; timestamp: number }> = [];

	constructor() {
		// Database wired later via setDatabase()
	}

	setDatabase(db: QicDatabase): void {
		this._db = db;
		this.ensureTable();
		this.flushBuffer();
	}

	// --- Completion acceptance tracking ---

	/**
	 * Called when a completion is shown to the user.
	 * Returns a tracking ID for pairing with accept/reject.
	 */
	trackCompletionShown(snapshot: CompletionSnapshot): string {
		const id = `${snapshot.filePath}:${snapshot.offset}:${snapshot.timestamp}`;
		return id;
	}

	/**
	 * Called when the user accepts an inline completion.
	 */
	trackCompletionAccepted(snapshot: CompletionSnapshot): void {
		this.record({
			type: 'completion_accept',
			lane: snapshot.lane,
			model: snapshot.model,
			value: 1,
			metadata: {
				fileExt: this.getExtension(snapshot.filePath),
				textLength: snapshot.text.length,
			},
			timestamp: new Date().toISOString(),
		});

		// Schedule edit distance check (debounced 10s)
		this.scheduleEditDistanceCheck(snapshot);
	}

	/**
	 * Called when the user dismisses/rejects a completion.
	 */
	trackCompletionRejected(lane: string, model: string, filePath: string): void {
		this.record({
			type: 'completion_reject',
			lane,
			model,
			value: 1,
			metadata: { fileExt: this.getExtension(filePath) },
			timestamp: new Date().toISOString(),
		});
	}

	// --- Edit distance tracking ---

	/**
	 * Called after the debounce window to compare accepted text with current file content.
	 * `getCurrentText` is a callback that reads the current text at the original insertion point.
	 */
	checkEditDistance(snapshotId: string, getCurrentText: () => string | null): void {
		const pending = this.pendingEditChecks.get(snapshotId);
		if (!pending) { return; }

		clearTimeout(pending.timer);
		this.pendingEditChecks.delete(snapshotId);

		const currentText = getCurrentText();
		if (currentText === null) { return; } // File closed or unavailable

		const distance = this.levenshteinDistance(
			pending.snapshot.text,
			currentText.slice(0, pending.snapshot.text.length + 50), // compare region
		);
		const normalizedDistance = pending.snapshot.text.length > 0
			? distance / pending.snapshot.text.length
			: 0;

		this.record({
			type: 'edit_distance',
			lane: pending.snapshot.lane,
			model: pending.snapshot.model,
			value: normalizedDistance,
			metadata: {
				rawDistance: distance,
				originalLength: pending.snapshot.text.length,
			},
			timestamp: new Date().toISOString(),
		});
	}

	private scheduleEditDistanceCheck(snapshot: CompletionSnapshot): void {
		const id = `${snapshot.filePath}:${snapshot.offset}:${snapshot.timestamp}`;

		// Clear any existing check for this location
		const existing = this.pendingEditChecks.get(id);
		if (existing) { clearTimeout(existing.timer); }

		const timer = setTimeout(() => {
			// The actual check requires file content — caller must invoke checkEditDistance()
			// with a content-reading callback when the timer fires.
			// For now, we just clean up the entry if nobody checks it.
			this.pendingEditChecks.delete(id);
		}, EDIT_DISTANCE_DEBOUNCE_MS);

		this.pendingEditChecks.set(id, { snapshot, timer });
	}

	// --- Re-request detection ---

	/**
	 * Track a request and detect if it's a re-request (same context within 30s).
	 * `contextHash` should be a hash of the relevant request context.
	 */
	trackRequest(contextHash: string, lane: string, model: string): boolean {
		const now = Date.now();

		// Prune old entries
		while (this.recentRequests.length > 0 && now - this.recentRequests[0].timestamp > RE_REQUEST_WINDOW_MS) {
			this.recentRequests.shift();
		}

		const isReRequest = this.recentRequests.some(r => r.contextHash === contextHash);

		if (isReRequest) {
			this.record({
				type: 're_request',
				lane,
				model,
				value: 1,
				metadata: { windowMs: RE_REQUEST_WINDOW_MS },
				timestamp: new Date().toISOString(),
			});
		}

		this.recentRequests.push({ contextHash, timestamp: now });
		return isReRequest;
	}

	// --- Follow-up pattern tracking ---

	/**
	 * Track when a user sends a follow-up message in the same conversation turn,
	 * indicating the previous response was insufficient.
	 */
	trackFollowUp(lane: string, model: string, turnIndex: number): void {
		this.record({
			type: 'follow_up',
			lane,
			model,
			value: turnIndex,
			timestamp: new Date().toISOString(),
		});
	}

	// --- Aggregation queries ---

	/**
	 * Get acceptance rate for a model/lane combination within a time window.
	 */
	getAcceptanceRate(model: string, lane: string, windowMs: number = 3_600_000): number {
		if (!this._db) { return 0; }
		const cutoff = new Date(Date.now() - windowMs).toISOString();
		const accepts = this._db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM qic_quality_signals WHERE type = 'completion_accept' AND model = ? AND lane = ? AND timestamp > ?`,
			model, lane, cutoff,
		)?.count ?? 0;
		const rejects = this._db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM qic_quality_signals WHERE type = 'completion_reject' AND model = ? AND lane = ? AND timestamp > ?`,
			model, lane, cutoff,
		)?.count ?? 0;
		const total = accepts + rejects;
		return total > 0 ? accepts / total : 0;
	}

	/**
	 * Get average edit distance for a model/lane within a time window.
	 */
	getAverageEditDistance(model: string, lane: string, windowMs: number = 3_600_000): number {
		if (!this._db) { return 0; }
		const cutoff = new Date(Date.now() - windowMs).toISOString();
		const result = this._db.get<{ avg: number }>(
			`SELECT AVG(value) as avg FROM qic_quality_signals WHERE type = 'edit_distance' AND model = ? AND lane = ? AND timestamp > ?`,
			model, lane, cutoff,
		);
		return result?.avg ?? 0;
	}

	/**
	 * Get re-request rate within a time window.
	 */
	getReRequestRate(windowMs: number = 3_600_000): number {
		if (!this._db) { return 0; }
		const cutoff = new Date(Date.now() - windowMs).toISOString();
		const reRequests = this._db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM qic_quality_signals WHERE type = 're_request' AND timestamp > ?`,
			cutoff,
		)?.count ?? 0;
		// Approximate total requests from accept + reject
		const total = this._db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM qic_quality_signals WHERE type IN ('completion_accept', 'completion_reject') AND timestamp > ?`,
			cutoff,
		)?.count ?? 0;
		return total > 0 ? reRequests / total : 0;
	}

	// --- Lifecycle ---

	dispose(): void {
		for (const { timer } of this.pendingEditChecks.values()) {
			clearTimeout(timer);
		}
		this.pendingEditChecks.clear();
		this.flushBuffer();
	}

	// --- Internal ---

	private record(entry: QualitySignalEntry): void {
		if (this._db) {
			this.writeToDb(entry);
		} else {
			this.buffer.push(entry);
			if (this.buffer.length > MAX_BUFFER_SIZE) {
				this.buffer.shift(); // Drop oldest if no DB
			}
		}
	}

	private writeToDb(entry: QualitySignalEntry): void {
		this._db!.run(
			`INSERT INTO qic_quality_signals (type, lane, model, value, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
			entry.type, entry.lane, entry.model, entry.value,
			entry.metadata ? JSON.stringify(entry.metadata) : null,
			entry.timestamp,
		);
	}

	private flushBuffer(): void {
		if (!this._db || this.buffer.length === 0) { return; }
		for (const entry of this.buffer) {
			this.writeToDb(entry);
		}
		this.buffer.length = 0;
	}

	private ensureTable(): void {
		if (!this._db) { return; }
		this._db.run(`
			CREATE TABLE IF NOT EXISTS qic_quality_signals (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT NOT NULL,
				lane TEXT NOT NULL,
				model TEXT NOT NULL,
				value REAL NOT NULL,
				metadata TEXT,
				timestamp TEXT NOT NULL
			)
		`);
		this._db.run(`
			CREATE INDEX IF NOT EXISTS idx_quality_signals_type_ts
			ON qic_quality_signals (type, timestamp)
		`);
		this._db.run(`
			CREATE INDEX IF NOT EXISTS idx_quality_signals_model_lane
			ON qic_quality_signals (model, lane, timestamp)
		`);
	}

	private getExtension(filePath: string): string {
		const dot = filePath.lastIndexOf('.');
		return dot >= 0 ? filePath.slice(dot) : '';
	}

	/**
	 * Simple Levenshtein distance for edit distance tracking.
	 * Bounded to prevent excessive computation on large strings.
	 */
	private levenshteinDistance(a: string, b: string): number {
		const MAX_LEN = 500;
		const sa = a.length > MAX_LEN ? a.slice(0, MAX_LEN) : a;
		const sb = b.length > MAX_LEN ? b.slice(0, MAX_LEN) : b;

		if (sa === sb) { return 0; }
		if (sa.length === 0) { return sb.length; }
		if (sb.length === 0) { return sa.length; }

		// Use two-row optimization
		let prev = new Array(sb.length + 1);
		let curr = new Array(sb.length + 1);

		for (let j = 0; j <= sb.length; j++) { prev[j] = j; }

		for (let i = 1; i <= sa.length; i++) {
			curr[0] = i;
			for (let j = 1; j <= sb.length; j++) {
				const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
				curr[j] = Math.min(
					prev[j] + 1,      // deletion
					curr[j - 1] + 1,  // insertion
					prev[j - 1] + cost, // substitution
				);
			}
			[prev, curr] = [curr, prev];
		}

		return prev[sb.length];
	}
}
