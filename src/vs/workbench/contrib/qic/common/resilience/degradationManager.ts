/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MemoryManager, MemoryPressure } from './memoryManager.js';
import type { Gateway } from '../gateway/gateway.js';

/**
 * 5-level graceful degradation (Audit XII-AR7).
 */
export const enum DegradationLevel {
	Normal = 0,
	ReducedQuality = 1,
	NoCompletions = 2,
	LocalOnly = 3,
	Emergency = 4,
}

interface DegradationMetrics {
	errorRate: number;         // 0..1
	avgLatencyMs: number;
	normalLatencyMs: number;   // baseline
	providersAvailable: number;
	totalProviders: number;
	memoryPressure: MemoryPressure;
	dbAvailable: boolean;
}

// Recovery tracking
interface RecoveryState {
	stableForMs: number;
	lastCheck: number;
}

const RECOVERY_WINDOW_MS = 60_000;

/**
 * Degradation manager with escalation triggers and recovery conditions (Audit XII-AR7).
 *
 * | Transition | Trigger                              | Recovery                                   |
 * |------------|--------------------------------------|--------------------------------------------|
 * | 0 -> 1     | Latency > 2x OR error rate > 10%    | Latency < 1.5x AND error < 5% for 60s     |
 * | 1 -> 2     | Memory high OR error rate > 30%      | Memory normal AND error < 15% for 60s      |
 * | 2 -> 3     | All providers down OR memory critical | At least 1 provider AND memory < high       |
 * | 3 -> 4     | OOM imminent OR disk full             | Memory freed AND disk available             |
 *
 * XII-AR1 partial: DB unavailable → LocalOnly.
 */
export class DegradationManager {

	private _level = DegradationLevel.Normal;
	private readonly recovery: RecoveryState = { stableForMs: 0, lastCheck: Date.now() };
	private _errorRate = 0;
	private _avgLatencyMs = 0;
	private _dbAvailable = true;
	private readonly _changeListeners: Array<(level: DegradationLevel) => void> = [];

	constructor(
		private readonly memoryManager: MemoryManager,
		private readonly gateway: Gateway,
	) {}

	getLevel(): DegradationLevel {
		return this._level;
	}

	setLevel(level: DegradationLevel): void {
		if (level !== this._level) {
			this._level = level;
			for (const listener of this._changeListeners) {
				listener(level);
			}
		}
	}

	onDegradationChange(listener: (level: DegradationLevel) => void): { dispose(): void } {
		this._changeListeners.push(listener);
		return {
			dispose: () => {
				const idx = this._changeListeners.indexOf(listener);
				if (idx >= 0) { this._changeListeners.splice(idx, 1); }
			},
		};
	}

	async evaluate(): Promise<DegradationLevel> {
		const metrics = await this.collectMetrics();

		// XII-AR1: DB unavailable → LocalOnly
		if (!metrics.dbAvailable && this._level < DegradationLevel.LocalOnly) {
			this._level = DegradationLevel.LocalOnly;
			return this._level;
		}

		// Check escalation
		const escalated = this.checkEscalation(metrics);
		if (escalated !== null) {
			this._level = escalated;
			this.recovery.stableForMs = 0;
			this.recovery.lastCheck = Date.now();
			return this._level;
		}

		// Check recovery
		const recovered = this.checkRecovery(metrics);
		if (recovered !== null) {
			this._level = recovered;
		}

		return this._level;
	}

	/**
	 * Update metrics from external pipeline (Audit XII-AR7).
	 */
	reportError(errorRate: number, avgLatencyMs: number): void {
		this._errorRate = errorRate;
		this._avgLatencyMs = avgLatencyMs;
	}

	reportDbStatus(available: boolean): void {
		this._dbAvailable = available;
	}

	async attemptRecovery(): Promise<void> {
		// Re-check provider health
		try {
			await this.gateway.getProviderHealth();
		} catch {
			// Best effort
		}

		// Re-evaluate
		await this.evaluate();
	}

	private checkEscalation(metrics: DegradationMetrics): DegradationLevel | null {
		// 0 -> 1: Latency > 2x normal OR error rate > 10%
		if (this._level === DegradationLevel.Normal) {
			if (metrics.avgLatencyMs > metrics.normalLatencyMs * 2 || metrics.errorRate > 0.1) {
				return DegradationLevel.ReducedQuality;
			}
		}

		// 1 -> 2: Memory high OR error rate > 30%
		// Only from Level 1 (not Level 0) to prevent skipping levels
		if (this._level === DegradationLevel.ReducedQuality) {
			if (metrics.memoryPressure === 'high' || metrics.errorRate > 0.3) {
				return DegradationLevel.NoCompletions;
			}
		}

		// 2 -> 3: All providers down OR memory critical
		if (this._level === DegradationLevel.NoCompletions) {
			if (metrics.providersAvailable === 0 || metrics.memoryPressure === 'critical') {
				return DegradationLevel.LocalOnly;
			}
		}

		// 3 -> 4: OOM imminent (already critical + no improvement)
		if (this._level === DegradationLevel.LocalOnly) {
			if (metrics.memoryPressure === 'critical' && metrics.providersAvailable === 0) {
				return DegradationLevel.Emergency;
			}
		}

		return null;
	}

	private checkRecovery(metrics: DegradationMetrics): DegradationLevel | null {
		const now = Date.now();
		const elapsed = now - this.recovery.lastCheck;
		this.recovery.lastCheck = now;

		// Check if conditions for de-escalation are met
		const canRecover = this.canRecoverFromCurrent(metrics);
		if (canRecover) {
			this.recovery.stableForMs += elapsed;
		} else {
			this.recovery.stableForMs = 0;
		}

		// Must be stable for RECOVERY_WINDOW_MS to de-escalate
		if (this.recovery.stableForMs < RECOVERY_WINDOW_MS) {
			return null;
		}

		this.recovery.stableForMs = 0;

		// 4 -> 3: Memory freed
		if (this._level === DegradationLevel.Emergency) {
			if (metrics.memoryPressure !== 'critical') {
				return DegradationLevel.LocalOnly;
			}
		}

		// 3 -> 2: At least 1 provider AND memory < high
		if (this._level === DegradationLevel.LocalOnly) {
			if (metrics.providersAvailable > 0 && metrics.memoryPressure !== 'high' && metrics.memoryPressure !== 'critical') {
				return DegradationLevel.NoCompletions;
			}
		}

		// 2 -> 1: Memory normal AND error < 15%
		if (this._level === DegradationLevel.NoCompletions) {
			if (metrics.memoryPressure === 'normal' && metrics.errorRate < 0.15) {
				return DegradationLevel.ReducedQuality;
			}
		}

		// 1 -> 0: Latency < 1.5x AND error < 5%
		if (this._level === DegradationLevel.ReducedQuality) {
			if (metrics.avgLatencyMs < metrics.normalLatencyMs * 1.5 && metrics.errorRate < 0.05) {
				return DegradationLevel.Normal;
			}
		}

		return null;
	}

	private canRecoverFromCurrent(metrics: DegradationMetrics): boolean {
		switch (this._level) {
			case DegradationLevel.Emergency:
				return metrics.memoryPressure !== 'critical';
			case DegradationLevel.LocalOnly:
				return metrics.providersAvailable > 0 && metrics.memoryPressure !== 'high' && metrics.memoryPressure !== 'critical';
			case DegradationLevel.NoCompletions:
				return metrics.memoryPressure === 'normal' && metrics.errorRate < 0.15;
			case DegradationLevel.ReducedQuality:
				return metrics.avgLatencyMs < metrics.normalLatencyMs * 1.5 && metrics.errorRate < 0.05;
			default:
				return false;
		}
	}

	private async collectMetrics(): Promise<DegradationMetrics> {
		let providersAvailable = 0;
		let totalProviders = 0;

		try {
			const healthPromise = this.gateway.getProviderHealth();
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('Health check timed out')), 10_000)
			);
			const health = await Promise.race([healthPromise, timeoutPromise]);
			totalProviders = health.size;
			for (const h of health.values()) {
				if (h.status !== 'unavailable') {
					providersAvailable++;
				}
			}
		} catch {
			// Gateway unavailable or timed out
		}

		return {
			errorRate: this._errorRate,
			avgLatencyMs: this._avgLatencyMs,
			normalLatencyMs: 500,
			providersAvailable,
			totalProviders,
			memoryPressure: this.memoryManager.getPressure(),
			dbAvailable: this._dbAvailable,
		};
	}
}
