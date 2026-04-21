/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EgressBoundary } from './egressEnforcer.js';
import type { DataTier } from '../constants.js';

type EventListener<T> = (value: T) => void;

export interface ConsentRecord {
	boundary: EgressBoundary;
	granted: boolean;
	grantedAt: string;
	scope: 'session' | 'workspace' | 'global';
	version: string;
}

/**
 * Consent storage for QIC egress boundaries.
 * Bridges extension-level ConsentManager with workbench-level storage.
 *
 * Supports optional database persistence for cross-session consent retention.
 *
 * Audit XI-SV4: Emits onDidRevokeConsent when consent is revoked.
 * Listeners must cancel queued/cached requests immediately.
 */
export class ConsentStore {
	private readonly records = new Map<EgressBoundary, ConsentRecord>();
	private readonly revokeListeners: EventListener<EgressBoundary>[] = [];
	private firstRunComplete = false;
	private _db: { run: (sql: string, ...params: unknown[]) => void; all: <T>(sql: string, ...params: unknown[]) => T[] } | null = null;
	private _locked = false;
	private _waitQueue: (() => void)[] = [];

	private async _lock(): Promise<void> {
		if (!this._locked) { this._locked = true; return; }
		return new Promise(resolve => this._waitQueue.push(resolve));
	}
	private _unlock(): void {
		const next = this._waitQueue.shift();
		if (next) { next(); } else { this._locked = false; }
	}

	/**
	 * Wire to database for persistent consent storage.
	 * If not called, consents are in-memory only (lost on restart).
	 */
	setDatabase(db: { run: (sql: string, ...params: unknown[]) => void; all: <T>(sql: string, ...params: unknown[]) => T[] }): void {
		this._db = db;
		// Load existing consents from database
		try {
			const rows = db.all<{ boundary: string; granted: number; granted_at: string; scope: string; version: string }>(
				'SELECT * FROM qic_consents'
			);
			for (const row of rows) {
				if (row.granted) {
					this.records.set(row.boundary as EgressBoundary, {
						boundary: row.boundary as EgressBoundary,
						granted: true,
						grantedAt: row.granted_at,
						scope: row.scope as 'session' | 'workspace' | 'global',
						version: row.version,
					});
				}
			}
			if (rows.length > 0) {
				this.firstRunComplete = true;
			}
		} catch {
			// Table may not exist yet — will be created during activation
		}
	}

	onDidRevokeConsent(listener: EventListener<EgressBoundary>): { dispose(): void } {
		this.revokeListeners.push(listener);
		return {
			dispose: () => {
				const idx = this.revokeListeners.indexOf(listener);
				if (idx >= 0) { this.revokeListeners.splice(idx, 1); }
			},
		};
	}

	async hasConsent(boundary: EgressBoundary): Promise<boolean> {
		const record = this.records.get(boundary);
		return record?.granted ?? false;
	}

	async grantConsent(boundary: EgressBoundary, scope: 'session' | 'workspace' | 'global'): Promise<void> {
		try {
			await this._lock();
			const grantedAt = new Date().toISOString();
			if (this._db) {
				this._db.run(
					'INSERT OR REPLACE INTO qic_consents (boundary, granted, granted_at, scope, version) VALUES (?, 1, ?, ?, ?)',
					boundary, grantedAt, scope, '1.0'
				);
			}
			this.records.set(boundary, {
				boundary,
				granted: true,
				grantedAt,
				scope,
				version: '1.0',
			});
		} finally {
			this._unlock();
		}
	}

	async revokeConsent(boundary: EgressBoundary): Promise<void> {
		try {
			await this._lock();
			if (this._db) {
				this._db.run('DELETE FROM qic_consents WHERE boundary = ?', boundary);
			}
			this.records.delete(boundary);
			for (const listener of this.revokeListeners) {
				listener(boundary);
			}
		} finally {
			this._unlock();
		}
	}

	async getAllConsents(): Promise<ConsentRecord[]> {
		return [...this.records.values()];
	}

	async isFirstRun(): Promise<boolean> {
		return !this.firstRunComplete && this.records.size === 0;
	}

	async markFirstRunComplete(): Promise<void> {
		this.firstRunComplete = true;
	}

	/**
	 * Synchronize egress consent with DataTier setting.
	 * When DataTier changes, auto-grant or revoke 'telemetry' egress consent.
	 */
	async syncDataTier(dataTier: DataTier): Promise<void> {
		if (dataTier === 'private') {
			// Revoke telemetry consent
			if (this.records.has('telemetry')) {
				await this.revokeConsent('telemetry');
			}
		} else {
			// 'anonymous-metrics' or 'data-contributor' — auto-grant telemetry
			if (!this.records.has('telemetry') || !this.records.get('telemetry')?.granted) {
				await this.grantConsent('telemetry', 'global');
			}
		}
	}
}
