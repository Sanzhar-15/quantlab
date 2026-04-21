/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HistoryArtifacts, HistoryEntry, HistoryQuery, RunStatus, RunType } from '../../types/history';

const STORAGE_KEY = 'quantlab.historyEntries';
const COMPARE_KEY = 'quantlab.compareEntries';
const MAX_ENTRIES = 1000;
const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled'];
const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
	queued: ['running', 'completed', 'failed', 'cancelled'],
	running: ['completed', 'failed', 'cancelled'],
	completed: [],
	failed: [],
	cancelled: []
};

interface HistoryEntryStored {
	id: string;
	type: RunType;
	status: RunStatus;
	strategyPath: string;
	strategyHash: string;
	startedAt: string;
	completedAt?: string;
	progress?: number;
	progressMessage?: string;
	passed?: boolean;
	metrics?: Record<string, number>;
	warnings?: string[];
	errorMessage?: string;
	artifactPath: string;
	pinned: boolean;
	tags: string[];
	viewedAt?: string;
	viewed?: boolean;
}

interface HistoryEntrySeed {
	id?: string;
	type: RunType;
	status: RunStatus;
	strategyPath: string;
	strategyHash?: string;
	startedAt?: Date;
	completedAt?: Date;
	progress?: number;
	progressMessage?: string;
	passed?: boolean;
	metrics?: Record<string, number>;
	warnings?: string[];
	errorMessage?: string;
	artifactPath?: string;
	pinned?: boolean;
	tags?: string[];
	viewedAt?: Date;
}

export class HistoryState {
	private static instance: HistoryState | undefined;

	private readonly entries = new Map<string, HistoryEntry>();
	private readonly entryOrder: string[] = [];
	private readonly artifacts = new Map<string, HistoryArtifacts>();
	private compareOrder: string[] = [];
	private unviewedCount = 0;
	private pendingPersist: NodeJS.Timeout | undefined;

	private readonly _onDidAdd = new vscode.EventEmitter<HistoryEntry>();
	readonly onDidAdd = this._onDidAdd.event;

	private readonly _onDidUpdate = new vscode.EventEmitter<HistoryEntry>();
	readonly onDidUpdate = this._onDidUpdate.event;

	private readonly _onDidDelete = new vscode.EventEmitter<string>();
	readonly onDidDelete = this._onDidDelete.event;

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private constructor(private readonly context: vscode.ExtensionContext) {
		this.restore();
		this.restoreCompare();
	}

	static initialize(context: vscode.ExtensionContext): HistoryState {
		if (!HistoryState.instance) {
			HistoryState.instance = new HistoryState(context);
		}
		return HistoryState.instance;
	}

	static getInstance(): HistoryState {
		if (!HistoryState.instance) {
			throw new Error('HistoryState not initialized');
		}
		return HistoryState.instance;
	}

	dispose(): void {
		if (this.pendingPersist) {
			clearTimeout(this.pendingPersist);
			this.pendingPersist = undefined;
		}
		// Flush any pending state before disposing (fire-and-forget — best effort on synchronous dispose)
		void this.persistNow();
		this._onDidAdd.dispose();
		this._onDidUpdate.dispose();
		this._onDidDelete.dispose();
		this._onDidChange.dispose();
	}

	static resetInstance(): void {
		if (HistoryState.instance) {
			HistoryState.instance.dispose();
			HistoryState.instance = undefined;
		}
	}

	createEntry(seed: HistoryEntrySeed): HistoryEntry {
		const entry = this.normalizeEntry(seed);

		this.entries.set(entry.id, entry);
		this.entryOrder.push(entry.id);
		this.adjustUnviewedCount(undefined, entry);

		this.pruneEntries();
		this.schedulePersist();

		this._onDidAdd.fire({ ...entry });
		this._onDidChange.fire();

		return entry;
	}

	getEntry(id: string): HistoryEntry | undefined {
		const entry = this.entries.get(id);
		return entry ? { ...entry } : undefined;
	}

	updateEntry(id: string, update: Partial<HistoryEntrySeed>): HistoryEntry | undefined {
		const existing = this.entries.get(id);
		if (!existing) {
			return undefined;
		}

		const next = this.applyUpdate(existing, update);
		this.entries.set(id, next);
		this.adjustUnviewedCount(existing, next);

		if (this.isTerminal(next.status) && !this.isTerminal(existing.status)) {
			void this.persistNow();
		} else {
			this.schedulePersist();
		}

		this._onDidUpdate.fire({ ...next });
		this._onDidChange.fire();

		return { ...next };
	}

	deleteEntry(id: string): void {
		const existing = this.entries.get(id);
		if (!existing) {
			return;
		}

		this.entries.delete(id);
		const index = this.entryOrder.indexOf(id);
		if (index >= 0) {
			this.entryOrder.splice(index, 1);
		}

		this.adjustUnviewedCount(existing, undefined);
		this.removeFromCompare(id);
		this.schedulePersist();

		this._onDidDelete.fire(id);
		this._onDidChange.fire();
	}

	query(query: HistoryQuery = {}): HistoryEntry[] {
		const results: HistoryEntry[] = [];
		for (const entry of this.entries.values()) {
			if (query.type && entry.type !== query.type) {
				continue;
			}
			if (query.status && entry.status !== query.status) {
				continue;
			}
			if (query.strategyPath && entry.strategyPath !== query.strategyPath) {
				continue;
			}
			if (typeof query.pinned === 'boolean' && entry.pinned !== query.pinned) {
				continue;
			}
			results.push({ ...entry });
		}

		results.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

		if (query.limit && results.length > query.limit) {
			return results.slice(0, query.limit);
		}

		return results;
	}

	getRunningJobs(): HistoryEntry[] {
		const running = this.query({ status: 'running' });
		const queued = this.query({ status: 'queued' });
		return [...running, ...queued].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
	}

	getRecent(limit = 20): HistoryEntry[] {
		return this.query({ limit });
	}

	getByStrategy(strategyPath: string): HistoryEntry[] {
		return this.query({ strategyPath });
	}

	getUnviewedCount(): number {
		return this.unviewedCount;
	}

	getCompareCount(): number {
		return this.compareOrder.length;
	}

	getCompareEntries(): HistoryEntry[] {
		return this.compareOrder
			.map(id => this.entries.get(id))
			.filter((entry): entry is HistoryEntry => Boolean(entry))
			.map(entry => ({ ...entry }));
	}

	addToCompare(id: string): void {
		if (!this.entries.has(id)) {
			return;
		}

		if (this.compareOrder.includes(id)) {
			return;
		}

		this.compareOrder.push(id);
		this.persistCompare();
		this._onDidChange.fire();
	}

	removeFromCompare(id: string): void {
		const index = this.compareOrder.indexOf(id);
		if (index === -1) {
			return;
		}

		this.compareOrder.splice(index, 1);
		this.persistCompare();
		this._onDidChange.fire();
	}

	clearCompare(): void {
		if (!this.compareOrder.length) {
			return;
		}
		this.compareOrder = [];
		this.persistCompare();
		this._onDidChange.fire();
	}

	markAsViewed(id: string): void {
		const entry = this.entries.get(id);
		if (!entry || entry.viewedAt) {
			return;
		}

		const updated = { ...entry, viewedAt: new Date() };
		this.entries.set(id, updated);
		this.adjustUnviewedCount(entry, updated);
		this.schedulePersist();
		this._onDidUpdate.fire({ ...updated });
		this._onDidChange.fire();
	}

	togglePin(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) {
			return;
		}

		const updated = { ...entry, pinned: !entry.pinned };
		this.entries.set(id, updated);
		this.schedulePersist();
		this._onDidUpdate.fire({ ...updated });
		this._onDidChange.fire();
	}

	setRunArtifacts(id: string, artifacts: HistoryArtifacts): void {
		this.artifacts.set(id, artifacts);
	}

	getRunArtifacts(id: string): HistoryArtifacts | undefined {
		return this.artifacts.get(id);
	}

	private normalizeEntry(seed: HistoryEntrySeed): HistoryEntry {
		const id = seed.id ?? this.createId();
		const status = seed.status;
		const startedAt = seed.startedAt ?? new Date();
		const completedAt = seed.completedAt;
		const progress = this.normalizeProgress(seed.progress);

		return {
			id,
			type: seed.type,
			status,
			strategyPath: seed.strategyPath,
			strategyHash: seed.strategyHash ?? 'unknown',
			startedAt,
			completedAt,
			progress,
			progressMessage: seed.progressMessage,
			passed: seed.passed,
			metrics: seed.metrics,
			warnings: seed.warnings ?? [],
			errorMessage: seed.errorMessage,
			artifactPath: seed.artifactPath ?? '',
			pinned: seed.pinned ?? false,
			tags: seed.tags ?? [],
			viewedAt: seed.viewedAt
		};
	}

	private applyUpdate(existing: HistoryEntry, update: Partial<HistoryEntrySeed>): HistoryEntry {
		const nextStatus = this.normalizeStatus(existing.status, update.status);
		const nextProgress = update.progress !== undefined ? this.normalizeProgress(update.progress) : existing.progress;
		const completedAt = update.completedAt ?? existing.completedAt;

		return {
			...existing,
			...update,
			status: nextStatus,
			progress: nextProgress,
			completedAt
		};
	}

	private normalizeStatus(current: RunStatus, next?: RunStatus): RunStatus {
		if (!next || next === current) {
			return current;
		}

		const allowed = VALID_TRANSITIONS[current] ?? [];
		return allowed.includes(next) ? next : current;
	}

	private normalizeProgress(progress?: number): number | undefined {
		if (progress === undefined || Number.isNaN(progress)) {
			return undefined;
		}
		return Math.min(100, Math.max(0, progress));
	}

	private isTerminal(status: RunStatus): boolean {
		return TERMINAL_STATUSES.includes(status);
	}

	private adjustUnviewedCount(previous?: HistoryEntry, next?: HistoryEntry): void {
		const wasCounted = previous ? this.isCounted(previous) : false;
		const isCounted = next ? this.isCounted(next) : false;

		if (wasCounted && !isCounted) {
			this.unviewedCount = Math.max(0, this.unviewedCount - 1);
		} else if (!wasCounted && isCounted) {
			this.unviewedCount += 1;
		}
	}

	private isCounted(entry: HistoryEntry): boolean {
		return !entry.viewedAt && (entry.status === 'completed' || entry.status === 'failed');
	}

	private schedulePersist(): void {
		if (this.pendingPersist) {
			clearTimeout(this.pendingPersist);
		}

		this.pendingPersist = setTimeout(() => {
			this.pendingPersist = undefined;
			void this.persistNow();
		}, 250);
	}

	persistNow(): Promise<void> {
		if (this.pendingPersist) {
			clearTimeout(this.pendingPersist);
			this.pendingPersist = undefined;
		}

		const stored = this.entryOrder
			.map(id => this.entries.get(id))
			.filter((entry): entry is HistoryEntry => Boolean(entry))
			.map(entry => this.serialize(entry));

		return Promise.resolve(this.context.globalState.update(STORAGE_KEY, stored));
	}

	private persistCompare(): void {
		void this.context.globalState.update(COMPARE_KEY, this.compareOrder);
	}

	private pruneEntries(): void {
		while (this.entryOrder.length > MAX_ENTRIES) {
			const oldestId = this.entryOrder.find(id => !this.entries.get(id)?.pinned);
			if (!oldestId) {
				return;
			}
			this.deleteEntry(oldestId);
		}
	}

	private serialize(entry: HistoryEntry): HistoryEntryStored {
		return {
			id: entry.id,
			type: entry.type,
			status: entry.status,
			strategyPath: entry.strategyPath,
			strategyHash: entry.strategyHash,
			startedAt: entry.startedAt.toISOString(),
			completedAt: entry.completedAt?.toISOString(),
			progress: entry.progress,
			progressMessage: entry.progressMessage,
			passed: entry.passed,
			metrics: entry.metrics,
			warnings: entry.warnings,
			errorMessage: entry.errorMessage,
			artifactPath: entry.artifactPath,
			pinned: entry.pinned,
			tags: entry.tags,
			viewedAt: entry.viewedAt?.toISOString()
		};
	}

	private restore(): void {
		const stored = this.context.globalState.get<HistoryEntryStored[]>(STORAGE_KEY);
		if (!stored || !Array.isArray(stored)) {
			return;
		}

		for (const entry of stored) {
			const parsed = this.deserialize(entry);
			if (!parsed) {
				continue;
			}
			this.entries.set(parsed.id, parsed);
			this.entryOrder.push(parsed.id);
			if (this.isCounted(parsed)) {
				this.unviewedCount += 1;
			}
		}
	}

	private restoreCompare(): void {
		const stored = this.context.globalState.get<string[]>(COMPARE_KEY);
		if (!stored || !Array.isArray(stored)) {
			return;
		}

		this.compareOrder = stored.filter(id => typeof id === 'string');
	}

	private deserialize(raw: HistoryEntryStored): HistoryEntry | undefined {
		if (!raw?.id || !raw.type || !raw.status || !raw.strategyPath || !raw.strategyHash || !raw.startedAt) {
			return undefined;
		}

		const startedAt = new Date(raw.startedAt);
		if (Number.isNaN(startedAt.getTime())) {
			return undefined;
		}

		const completedAt = raw.completedAt ? new Date(raw.completedAt) : undefined;
		const safeCompletedAt = completedAt && !Number.isNaN(completedAt.getTime()) ? completedAt : undefined;
		const viewedAt = raw.viewedAt ? new Date(raw.viewedAt) : undefined;
		const safeViewedAt = viewedAt && !Number.isNaN(viewedAt.getTime())
			? viewedAt
			: (raw.viewed ? (safeCompletedAt ?? startedAt) : undefined);

		return {
			id: raw.id,
			type: raw.type,
			status: raw.status,
			strategyPath: raw.strategyPath,
			strategyHash: raw.strategyHash,
			startedAt,
			completedAt: safeCompletedAt,
			progress: this.normalizeProgress(raw.progress),
			progressMessage: raw.progressMessage,
			passed: raw.passed,
			metrics: raw.metrics,
			warnings: raw.warnings ?? [],
			errorMessage: raw.errorMessage,
			artifactPath: raw.artifactPath ?? '',
			pinned: raw.pinned ?? false,
			tags: raw.tags ?? [],
			viewedAt: safeViewedAt
		};
	}

	private createId(): string {
		return `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}
}
